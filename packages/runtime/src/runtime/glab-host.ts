// How `glab api` is pointed at a GitLab host that is not the cwd's. glab 1.130.0's `--hostname` takes a bare host name and refuses one
// with a port before asking anyone ("error parsing --hostname: invalid hostname", tried on the real glab against a real GitLab), while
// the `GITLAB_HOST` variable takes `host:port` and keeps the host's own settings in glab's config (its token, `api_protocol`). A leaf
// with no imports, so the forge seam of `implement-issue` (`workflows/implement-issue/forge.ts`) and the by-URL reader that `observe`
// offers the dashboard (`pr-by-url.ts`) address a host the same way without either depending on the other (ADR-0009).

/** The variables glab takes a token from. glab sends such a token to the host `GITLAB_HOST` names, so one set for another host stays behind. */
const ENV_TOKENS = ["GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN"] as const;

/** What a `glab api` call gets to reach a host: arguments before its own, and variables for its environment (`undefined` removes one). */
export interface GlabHost {
  args: string[];
  env: Record<string, string | undefined>;
}

/**
 * How `glab api` reaches `host` (`git.example.com`, `git.example.com:8443`): `--hostname <host>` for a bare host; for one with a port,
 * `GITLAB_HOST=<host>`, and the token variables removed unless `env`'s own `GITLAB_HOST` already names that host, so that a token
 * meant for another host is never sent to this one.
 */
export function glabApiHost(host: string, env: Readonly<Record<string, string | undefined>> = process.env): GlabHost {
  if (!host.includes(":")) return { args: ["--hostname", host], env: {} };
  const tokens = env.GITLAB_HOST === host ? {} : Object.fromEntries(ENV_TOKENS.map((key) => [key, undefined]));
  return { args: [], env: { GITLAB_HOST: host, ...tokens } };
}
