// The `repo` argument of implement-issue names a repository other than the cwd's, and the forge's CLI sends its token to the host that
// argument names: `gh` takes `[HOST/]OWNER/REPO` and a URL, and sends GH_ENTERPRISE_TOKEN (or the login it stored for that host) to a
// host other than github.com. The argument comes from whoever drives the chat, so it must not pick the host. It may name one only when
// the host is the forge's own default, the host of this repository's `origin` (a run there sends the token to that host anyway), a host
// the config declares under `forges` (the user told the kit it is a forge of theirs), or one the config lists in
// `workflows.implement-issue.settings.repoHosts` (a host to run against that is neither). A scheme that is neither https nor ssh is
// refused outright: http carries the token in the clear, and `ext::` or `file://` is not a repository name.
import { FORGE_TITLES, bareHost, knownForgeOf } from "../../src/config/file.js";
import { type ForgeName, parseRemote, trimmedPath, webHost } from "./forge.js";

/**
 * The JSON Schema `pattern` of the `repo` argument: the characters of `owner/name`, `group/sub/project`, a repository URL and an scp-like
 * remote, starting with a letter or a digit (an argument that starts with `-` would be read by a CLI as a flag). The schema cannot see
 * the config, so it checks the spelling only; `repoRefusal` checks the host.
 */
export const REPO_ARG_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_.:/@-]*$";

/**
 * The host a `repo` argument names, in lower case, with its port when it is an https URL that has one (`host`, or `host:port`); undefined
 * when it names none (`OWNER/REPO`, `GROUP/SUB/PROJECT`: the CLI then uses the host of the cwd's origin, or its default). A URL and an
 * scp-like remote name their host. Without one, `gh` takes the first of three segments as the host whatever it looks like, and `glab`
 * (where three segments are an ordinary `group/sub/project`) takes it only when it has a dot: both are refused unless allowed.
 */
export function repoHostOf(repo: string, forge: ForgeName): string | undefined {
  const text = repo.trim();
  const named = parseRemote(text);
  if (named) return webHost(named);
  const segments = trimmedPath(text).split("/");
  return segments.length >= 3 && (forge === "github" || segments[0]!.includes(".")) ? segments[0]!.toLowerCase() : undefined;
}

/** What decides which hosts a `repo` argument may name. */
export interface RepoPolicy {
  /** The forge the run uses: its CLI is the one that receives the token. */
  forge: ForgeName;
  /** The URL of the cwd's `origin` remote as configured, or undefined when there is none. */
  originUrl: string | undefined;
  /** `workflows.implement-issue.settings.repoHosts`: `host` (any port) or `host:port`. */
  repoHosts: readonly string[];
  /** The config's `forges`: the hosts the user declared as a forge of theirs, by `host` or `host:port`. */
  forges: Readonly<Record<string, ForgeName>>;
}

/** The scheme of `text` when it is a URL (`https`, `ssh`, `http`, `ext`...), in lower case. */
const schemeOf = (text: string): string | undefined => /^([a-z][a-z0-9+.-]*):\/\//i.exec(text.trim())?.[1]?.toLowerCase();

/** Why this `repo` argument must not reach the forge's CLI, or undefined when it may. One sentence that says what to change. */
export function repoRefusal(repo: string, { forge, originUrl, repoHosts, forges }: RepoPolicy): string | undefined {
  const scheme = schemeOf(repo);
  if (scheme !== undefined && scheme !== "https" && scheme !== "ssh") {
    return `the repo argument is a ${scheme}:// URL: the ${FORGE_TITLES[forge]} CLI would send its token over it in the clear, or run what it names. Name the repository as owner/name, as an https:// URL or as an ssh:// URL`;
  }
  const host = repoHostOf(repo, forge);
  if (host === undefined) return undefined;
  const bare = bareHost(host);
  const origin = originUrl === undefined ? undefined : parseRemote(originUrl)?.host;
  const listed = [...repoHosts, ...Object.keys(forges)].some((entry) => [host, bare].includes(entry.toLowerCase()));
  if (knownForgeOf(bare) === forge || bare === origin || listed) return undefined;
  return (
    `the repo argument names the host ${host}, and the ${FORGE_TITLES[forge]} CLI sends its token to the host it is given. ` +
    `Only ${forge === "github" ? "github.com" : "gitlab.com"}, the host of this repository's origin, the hosts under forges and the hosts in workflows.implement-issue.settings.repoHosts are accepted: ` +
    `add ${host} to repoHosts in the config (the global file or the repository's) if it is yours, or name the repository as owner/name`
  );
}
