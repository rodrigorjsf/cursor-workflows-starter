// The transports a `git` command that talks to a remote may use. One constant, so the workflow's commands (`implement-issue/commands.ts`)
// and the cloud snapshot (`cloud-snapshot.ts`) allow the same ones.

/**
 * `https` and `ssh`, and `file` (a local path or a bare repository, which sends no credential anywhere). A plain-text transport (`http`, `git`)
 * sends the credentials, or the branch, in the clear, and a remote helper (`ext::<command>`) runs a command. Set as GIT_ALLOW_PROTOCOL, which
 * git applies to the URL a command actually uses (the push URL for a push, the fetch URL for a fetch or an `ls-remote`, after `insteadOf` and
 * `pushInsteadOf`) and which overrides a user's `protocol.<name>.allow`: a user with `protocol.ext.allow=always` would otherwise let a remote
 * helper run.
 */
export const NETWORK_GIT_ENV = { GIT_ALLOW_PROTOCOL: "file:https:ssh" } as const;
