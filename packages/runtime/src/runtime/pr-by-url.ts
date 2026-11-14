// The state of a pull request or merge request named by its URL: what a tool beside the runtime (the dashboard's Board, through
// `observe`) asks of the forge CLIs, which hold the user's logins (ADR-0009). There is no run and no checkout here, so it does not use
// the forge seam of `implement-issue`: `gh pr view <url>` takes the URL, and GitLab goes through `glab api --hostname <host>`
// (`GITLAB_HOST=<host>` for a host with a port, which `--hostname` refuses: `glab-host.ts`), never `glab mr view <url>`, which needs a
// GitLab checkout as the cwd.
//
// - A URL comes from a workflow's log, so it is never trusted: only the exact address of a PR on github.com or of an MR on an
//   allowed host (`parsePrUrl`) reaches a CLI, as arguments of a fixed command line with no shell. An address with an extra path, a
//   query, a fragment, `http`, a number that is not digits, or an issue is none.
// - Which hosts may be asked is decided here, not by the URL: github.com (`gh`), gitlab.com and the hosts of glab's own config
//   (`glab`), so a crafted link cannot make the dashboard query another host with the user's token.
// - Every failure is an answer, not an error: no CLI, no login, no network, no such PR, a host not allowed, a state this version does
//   not know. `prStateOfUrl` never rejects, and never logs.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { knownForgeOf } from "../config/file.js";
import { type PrState, prStateOfMr } from "./forge-pr-state.js";
import { glabApiHost } from "./glab-host.js";

export type { PrState };

/** The address of a PR or an MR, as its shape says. A GitLab one carries the host and the project it names, to be checked against the allowed hosts. */
export type PrUrl = { forge: "github"; url: string } | { forge: "gitlab"; host: string; project: string; number: string };

/** A pull request of github.com, exactly: no query, no fragment, no path after the number. */
const GITHUB_PR = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d{1,9}$/;
/** A host name as an MR URL and glab's config spell it: lower case, a letter or a digit first (so it can never be taken for an option), a port when the instance has one. */
const HOST = "[a-z0-9][a-z0-9.-]*(?::\\d{1,5})?";
/**
 * A merge request, exactly: `https://<host>[:port]/<namespace path>/-/merge_requests/<n>`, the namespace path being a group (and
 * subgroups) and a project, each name starting with a letter, a digit or an underscore (as GitLab's own rule says). The host is
 * written in lower case, as it is on a GitHub URL.
 */
const GITLAB_MR = new RegExp(`^https://(${HOST})/(\\w[\\w.-]*(?:/\\w[\\w.-]*)+)/-/merge_requests/(\\d{1,9})$`);

/** What `url` is, when it has exactly the shape of a PR or MR address; undefined for anything else. The host of an MR is not judged here. */
export function parsePrUrl(url: string): PrUrl | undefined {
  if (GITHUB_PR.test(url)) return { forge: "github", url };
  const mr = GITLAB_MR.exec(url);
  return mr ? { forge: "gitlab", host: mr[1]!, project: mr[2]!, number: mr[3]! } : undefined;
}

/** Whether `url` has the shape of a PR or MR address (`parsePrUrl`): cheap, and no host is looked up. */
export const isPrUrl = (url: string): boolean => parsePrUrl(url) !== undefined;

/** How long a CLI may take before it is given up on. */
const ASK_TIMEOUT_MS = 10_000;
/** The most a CLI's answer may be: `glab api` prints the whole merge request, whose description GitLab caps at 1 MB. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
/** The states `gh pr view --json state` prints. */
const GITHUB_STATES: ReadonlySet<string> = new Set<PrState>(["OPEN", "MERGED", "CLOSED"]);

// Why the hosts come from glab's config file and not from a glab command: the only command that lists them, `glab auth status --all`
// (`--output json` in 1.130), also asks every host's API for the user with a 30 s timeout, host after host, so one host that is down
// would hold back the badges of all the others, and it contacts every instance on each refresh. Reading the file asks no one.

/**
 * Where glab keeps its config, in the order it looks (glab 1.130, `internal/config/config_file.go`): `GLAB_CONFIG_DIR` alone when
 * set, else `~/.config`, else `XDG_CONFIG_HOME`. The platform default of macOS (`~/Library/Application Support/glab-cli`) and of
 * Windows is not read: the kit is tested on Linux only (`docs/usage/01-instalacao.md`); `GLAB_CONFIG_DIR` set for both glab and the dashboard covers them.
 */
function glabConfigFiles(): string[] {
  const dir = process.env.GLAB_CONFIG_DIR;
  if (dir) return [join(dir, "config.yml")];
  const xdg = process.env.XDG_CONFIG_HOME;
  return [join(homedir(), ".config", "glab-cli", "config.yml"), ...(xdg ? [join(xdg, "glab-cli", "config.yml")] : [])];
}

/** A host name as glab's config spells one: the pattern the host of an MR URL has. */
const HOST_NAME = new RegExp(`^${HOST}$`);
/** A line of the config that is a bare key (`name:`, `"name":`, `'name':`), with a comment allowed after it: the key without its quotes. A line with a value is not one. */
const BARE_KEY = /^(?:"([^"]+)"|'([^']+)'|([^\s:"'#][^\s]*?)):(?:\s+#.*|\s*)$/;

/**
 * The host names in the text of glab's `config.yml`: the keys one level below the top-level `hosts:` key, in lower case. There is
 * no YAML parser here (the kit has none to spare), and nothing else of the file is read: a host's settings, its token among them,
 * sit one level deeper, so they never match, and only a key that looks like a host name is kept.
 */
function glabHostsOf(config: string): string[] {
  const hosts: string[] = [];
  let inHosts = false;
  let indent: number | undefined; // the indent of the keys one level below `hosts:`, set by the first one
  for (const line of config.split(/\r?\n/)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const lead = line.length - line.trimStart().length;
    if (lead === 0) {
      inHosts = /^hosts:\s*(#.*)?$/.test(line);
      indent = undefined;
      continue;
    }
    if (!inHosts || (indent ??= lead) !== lead) continue;
    const key = BARE_KEY.exec(line.slice(lead));
    const host = (key?.[1] ?? key?.[2] ?? key?.[3])?.toLowerCase();
    if (host !== undefined && HOST_NAME.test(host)) hosts.push(host);
  }
  return hosts;
}

/** The hosts of an MR that `glab` may be asked about: gitlab.com, and the hosts glab's own config names (read afresh: the user may log in to another while the dashboard runs). */
async function allowedGitlabHosts(): Promise<ReadonlySet<string>> {
  const hosts = new Set(["gitlab.com"]);
  for (const file of glabConfigFiles()) {
    let config: string;
    try {
      config = await readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // no config file here: glab looks in the next place
      break; // there but unreadable (a directory, no permission): glab fails on it too, so it knows no host but gitlab.com
    }
    for (const host of glabHostsOf(config)) if (knownForgeOf(host) !== "github") hosts.add(host);
    break; // glab uses the first config file that is there
  }
  return hosts;
}

/** `cli args`, with prompts, colour and update checks off; its standard output, or undefined when it could not answer. */
function ask(cli: string, args: string[], env: Record<string, string | undefined>, signal: AbortSignal | undefined): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(cli, args, { timeout: ASK_TIMEOUT_MS, signal, maxBuffer: MAX_OUTPUT_BYTES, env: { ...process.env, ...env, NO_COLOR: "1" } }, (err, stdout) =>
      resolve(err ? undefined : stdout),
    );
  });
}

/** `gh pr view <url> --json state --jq .state`. */
async function githubState(url: string, signal: AbortSignal | undefined): Promise<PrState | undefined> {
  const out = (await ask("gh", ["pr", "view", url, "--json", "state", "--jq", ".state"], { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" }, signal))?.trim();
  return out !== undefined && GITHUB_STATES.has(out) ? (out as PrState) : undefined;
}

/** `glab api --hostname <host> projects/<project>/merge_requests/<n>` (`glabApiHost`): the merge request as GitLab's REST API gives it, of which only the state is read. */
async function gitlabState(mr: Extract<PrUrl, { forge: "gitlab" }>, signal: AbortSignal | undefined): Promise<PrState | undefined> {
  if (!(await allowedGitlabHosts()).has(mr.host)) return undefined;
  const host = glabApiHost(mr.host);
  const out = await ask("glab", ["api", ...host.args, `projects/${encodeURIComponent(mr.project)}/merge_requests/${mr.number}`], { ...host.env, GLAB_NO_PROMPT: "1", GLAB_CHECK_UPDATE: "false" }, signal);
  if (out === undefined) return undefined;
  try {
    const { state } = JSON.parse(out) as { state?: unknown };
    return typeof state === "string" ? prStateOfMr(state) : undefined;
  } catch {
    return undefined; // not JSON: glab printed something other than the merge request
  }
}

/**
 * The state of the PR or MR at `url`, or undefined when its forge could not say: the URL is not exactly the address of one, its host
 * is not allowed, the CLI is missing or not logged in, the request failed or timed out, or `signal` ended it. Never rejects.
 */
export async function prStateOfUrl(url: string, signal?: AbortSignal): Promise<PrState | undefined> {
  const pr = parsePrUrl(url);
  if (pr === undefined) return undefined;
  return pr.forge === "github" ? githubState(pr.url, signal) : gitlabState(pr, signal);
}
