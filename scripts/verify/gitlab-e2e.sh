#!/usr/bin/env bash
# WHAT: Starts a real GitLab CE in Docker with memory-constrained settings, waits until it answers, creates a root
#   personal access token inside the container, then runs two scripts against it. scripts/verify/record-glab-fixtures.ts: the real
#   `glab` runs the commands and API routes the runtime uses, and their scrubbed outputs become the fixtures of the
#   fake `glab` (packages/runtime/test/fixtures/glab/recordings.json). scripts/verify/prove-gitlab.ts: which phrases close an issue
#   on merge (`Implement(s|ed|ing) #N` among them), whether a `/close` in model text runs after the sanitizer, and a real
#   `implement-issue` run with local steps whose merge request closes its issue; its evidence, as Markdown, is all the script prints
#   on stdout (everything else goes to stderr). Removes its container and volumes at the end, also when a step fails or the script is
#   interrupted, and then exits with the status of the failure or the signal.
# WHY: The GitLab code paths are tested offline against a fake `glab`; recording that fake's outputs from a real GitLab
#   keeps the offline tests resting on what glab really prints (ADR-0009), and the proofs show on a real GitLab what the
#   sanitizer for model text was written to prevent. It is outside `npm run check` and CI: GitLab CE needs about 2.5 GB of memory
#   and minutes to start, and the last proof spends tokens of the Cursor API.
# WHEN: After bumping the pinned glab in mise.toml, after changing a glab command or API route in the forge module
#   (packages/runtime/workflows/implement-issue/forge.ts) or the sanitizer for model text (packages/runtime/workflows/implement-issue/pr-body.ts),
#   or to try a newer GitLab image. Never on a machine whose Docker has less than 4 GiB of memory, and not without `wf login` done.
# HOW: `mise exec -- scripts/verify/gitlab-e2e.sh` (mise puts the pinned glab on the PATH). `GITLAB_E2E_IMAGE=gitlab/gitlab-ce:<tag>`
#   tries another image (default gitlab/gitlab-ce:19.5.5-ce.0); `GITLAB_E2E_PORT` (default 8929) is the local port;
#   `GITLAB_E2E_NAME` (default wf-gitlab-e2e) names the container and its volumes; `GITLAB_E2E_TIMEOUT_SECONDS` (default
#   1800) is how long it waits for GitLab, polling every `GITLAB_E2E_POLL_SECONDS` (default 10); `GITLAB_E2E_MIN_MEMORY_MB`
#   (default 4096) is the least memory it accepts from Docker. The `implement-issue` run is capped by `GITLAB_E2E_MAX_TOKENS`
#   (default 600000) and `GITLAB_E2E_MAX_CENTS` (default 100), passed to `wf run` as `--max-tokens` and `--max-cents`, and cancelled
#   after `GITLAB_E2E_WORKFLOW_TIMEOUT_SECONDS` (default 2700); `GITLAB_E2E_STAGES=closing,quick-actions,references` runs only the
#   proofs that cost no tokens (the fourth stage is `workflow`).
#   It refuses to run while a container or a volume of those names exists, never restarts Docker or changes its settings, and
#   removes only what it started.

set -euo pipefail

DEFAULT_IMAGE="gitlab/gitlab-ce:19.5.5-ce.0"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"

image="${GITLAB_E2E_IMAGE:-$DEFAULT_IMAGE}"
port="${GITLAB_E2E_PORT:-8929}"
name="${GITLAB_E2E_NAME:-wf-gitlab-e2e}"
ready_timeout="${GITLAB_E2E_TIMEOUT_SECONDS:-1800}"
poll_seconds="${GITLAB_E2E_POLL_SECONDS:-10}"
min_memory_mb="${GITLAB_E2E_MIN_MEMORY_MB:-4096}"
volumes=("$name-config" "$name-logs" "$name-data")

# What this run has started, so the trap removes that and nothing else.
container_started=""
volumes_started=""
scratch=""
# What the scripts run against the GitLab need: the root password and the token of the personal access token made in the container.
password=""
token=""

die() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  echo "usage: gitlab-e2e.sh   (environment: GITLAB_E2E_IMAGE, GITLAB_E2E_PORT, GITLAB_E2E_NAME, GITLAB_E2E_TIMEOUT_SECONDS, GITLAB_E2E_POLL_SECONDS, GITLAB_E2E_MIN_MEMORY_MB, GITLAB_E2E_MAX_TOKENS, GITLAB_E2E_MAX_CENTS, GITLAB_E2E_WORKFLOW_TIMEOUT_SECONDS, GITLAB_E2E_STAGES)"
}

# The container and its volumes go, on success, on failure and on a signal. A container this run did not start stays. The script
# ends with the status it had (a failure's), or with 128 plus the number of the signal that interrupted it (`cleanup 143`): the
# status of the last command that ran would be 0, and an interrupted run must not read as a pass.
cleanup() {
  local status=${1:-$?}
  trap - EXIT INT TERM HUP
  if [ -n "$container_started" ]; then
    echo "removing container $name and its volumes" >&2
    docker rm -f -v "$name" >/dev/null 2>&1 || echo "warning: could not remove container $name" >&2
  fi
  if [ -n "$volumes_started" ]; then
    docker volume rm -f "${volumes[@]}" >/dev/null 2>&1 || echo "warning: could not remove volumes ${volumes[*]}" >&2
  fi
  [ -z "$scratch" ] || rm -rf "$scratch"
  exit "$status"
}

# The glab version mise.toml pins: the one the fixtures are recorded with.
pinned_glab() {
  sed -n 's/^glab *= *"\([^"]*\)".*$/\1/p' "$root/mise.toml"
}

preflight() {
  local tool pinned glab_version memory_bytes volume
  for tool in docker curl glab node npx; do
    command -v "$tool" >/dev/null 2>&1 || die "\`$tool\` is not on the PATH (run through \`mise exec -- scripts/verify/gitlab-e2e.sh\`)"
  done
  pinned="$(pinned_glab)"
  [ -n "$pinned" ] || die "mise.toml pins no glab version"
  glab_version="$(glab --version | head -n 1)"
  case "$glab_version" in
    "glab $pinned "* | "glab $pinned") ;;
    *) die "glab on the PATH is \"$glab_version\", mise.toml pins $pinned (run through \`mise exec --\`)" ;;
  esac
  docker info >/dev/null 2>&1 || die "the Docker daemon does not answer: start Docker yourself, this script never does"
  memory_bytes="$(docker info --format '{{.MemTotal}}')"
  [ "$((memory_bytes / 1024 / 1024))" -ge "$min_memory_mb" ] || die "Docker has $((memory_bytes / 1024 / 1024)) MiB, GitLab CE needs at least $min_memory_mb (GITLAB_E2E_MIN_MEMORY_MB)"
  [ -z "$(docker ps -a --filter "name=^${name}\$" --format '{{.ID}}')" ] || die "a container named $name exists: remove it, or set GITLAB_E2E_NAME"
  # The cleanup removes these volumes, so none that this run did not make may carry the names.
  for volume in "${volumes[@]}"; do
    ! docker volume inspect "$volume" >/dev/null 2>&1 || die "a volume named $volume exists: remove it, or set GITLAB_E2E_NAME"
  done
}

# Settings for a small machine: one Puma process, a lean Sidekiq, no Prometheus or exporters, malloc that gives memory back.
omnibus_config() {
  cat <<CONFIG
external_url 'http://localhost:${port}'
puma['worker_processes'] = 0
sidekiq['concurrency'] = 5
prometheus_monitoring['enable'] = false
gitlab_kas['enable'] = false
gitlab_rails['usage_ping_enabled'] = false
gitlab_rails['env'] = { 'MALLOC_CONF' => 'dirty_decay_ms:1000,muzzy_decay_ms:1000' }
gitaly['env'] = { 'LD_PRELOAD' => '/opt/gitlab/embedded/lib/libjemalloc.so', 'MALLOC_CONF' => 'dirty_decay_ms:1000,muzzy_decay_ms:1000', 'GITALY_COMMAND_SPAWN_MAX_PARALLEL' => '2' }
CONFIG
}

start_gitlab() {
  echo "starting $image as $name on http://localhost:$port (the first start takes minutes)" >&2
  volumes_started=1
  container_started=1
  docker run --detach --name "$name" \
    --shm-size 256m \
    --publish "127.0.0.1:${port}:${port}" \
    --volume "${volumes[0]}:/etc/gitlab" \
    --volume "${volumes[1]}:/var/log/gitlab" \
    --volume "${volumes[2]}:/var/opt/gitlab" \
    --env GITLAB_OMNIBUS_CONFIG="$(omnibus_config)" \
    "$image" >/dev/null
}

# Ready: the container's own health check passes and the sign-in page answers on the published port.
wait_until_ready() {
  local waited=0 health
  while true; do
    health="$(docker inspect --format '{{.State.Health.Status}}' "$name" 2>/dev/null || true)"
    if [ "$health" = "healthy" ] && curl -fsS -o /dev/null --max-time 10 "http://127.0.0.1:${port}/users/sign_in" 2>/dev/null; then
      return 0
    fi
    [ "$waited" -lt "$ready_timeout" ] || die "GitLab was not ready after ${ready_timeout}s (health: ${health:-unknown}); see \`docker logs $name\` while the container exists"
    echo "waiting for GitLab (${waited}s, health: ${health:-unknown})" >&2
    sleep "$poll_seconds"
    waited=$((waited + poll_seconds))
  done
}

root_password() {
  docker exec "$name" awk '/^Password:/ { print $2 }' /etc/gitlab/initial_root_password
}

# A personal access token for root, made inside the container. The token comes back on stdout; nothing else does.
create_token() {
  docker exec "$name" gitlab-rails runner '
    user = User.find_by_username("root")
    token = user.personal_access_tokens.create!(name: "wf-gitlab-e2e", scopes: [:api, :write_repository], expires_at: 1.day.from_now)
    puts "WF_E2E_TOKEN=#{token.token}"
  ' | sed -n 's/^WF_E2E_TOKEN=//p'
}

# A TypeScript script of this repo, run against the GitLab: the same URL, token, password, image and scratch directory for each.
run_script() {
  (
    cd "$root"
    GITLAB_E2E_URL="http://localhost:${port}" \
      GITLAB_E2E_TOKEN="$token" \
      GITLAB_E2E_PASSWORD="$password" \
      GITLAB_E2E_IMAGE="$image" \
      GITLAB_E2E_SCRATCH="$scratch" \
      npx tsx "$1"
  )
}

main() {
  case "${1:-}" in
    "") ;;
    -h | --help)
      usage
      return 0
      ;;
    *)
      usage >&2
      return 2
      ;;
  esac
  trap cleanup EXIT
  trap 'cleanup 130' INT
  trap 'cleanup 143' TERM
  trap 'cleanup 129' HUP
  preflight
  scratch="$(mktemp -d "${TMPDIR:-/tmp}/wf-gitlab-e2e-XXXXXX")"
  start_gitlab
  wait_until_ready
  password="$(root_password)"
  [ -n "$password" ] || die "GitLab left no initial root password in the container"
  token="$(create_token)"
  [ -n "$token" ] || die "could not create a personal access token inside the container"
  echo "GitLab is ready: recording the fixtures" >&2
  run_script scripts/verify/record-glab-fixtures.ts >&2
  echo "fixtures recorded: proving the GitLab behaviours (the last stage runs implement-issue and spends tokens)" >&2
  run_script scripts/verify/prove-gitlab.ts
}

main "$@"
