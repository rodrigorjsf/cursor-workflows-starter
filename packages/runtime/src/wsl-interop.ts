// What the WSL interop switch says about the host. On WSL2 the kernel exposes `/proc/sys/fs/binfmt_misc/WSLInterop` while the
// distribution can start Windows programs (`[interop] enabled=true` in its `/etc/wsl.conf`, the default), and the file reads `enabled`.
// With interop off the file is absent, and on a host that is not WSL it never exists. `wf doctor` reads it to report the WSL trust
// boundary (the WSL paragraph of SECURITY.md): a Windows process reaches the Linux home through `\\wsl$` as the distribution's default
// user, so the 0600 mode of `~/.cursor/sdk/auth.json` does not keep it out, and a step that runs without the SDK sandbox can start Windows
// programs while interop is on.
//
// This module only reads the file it is given. It never writes `wsl.conf`, never runs `wsl.exe` and never restarts anything: changing the
// boundary is the user's call.
import { readFileSync } from "node:fs";
import { errorText } from "./runtime/error-text.js";

/** The file the WSL kernel exposes while interop is on. */
export const WSL_INTEROP_FILE = "/proc/sys/fs/binfmt_misc/WSLInterop";

/** Tests only: the path of the interop file to read, in place of `WSL_INTEROP_FILE`. The doctor tests point every run at a file of their own. */
export const WSL_INTEROP_FILE_ENV = "WF_DOCTOR_WSL_INTEROP_FILE";

/**
 * What reading the interop file found: `enabled` (the first line says so: Windows programs can be started and the boundary is open),
 * `disabled` (the file is there and says anything else), `absent` (no file: not WSL, or interop off) or `unreadable` (`said` is why).
 */
export type WslInterop = { kind: "enabled" } | { kind: "disabled"; reads: string } | { kind: "absent" } | { kind: "unreadable"; said: string };

/** The interop switch as `file` (the first line of the kernel's file) shows it. */
export function readWslInterop(file: string): WslInterop {
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch (err) {
    return (err as { code?: unknown }).code === "ENOENT" ? { kind: "absent" } : { kind: "unreadable", said: errorText(err) };
  }
  const reads = content.split("\n")[0]!.trim();
  return reads === "enabled" ? { kind: "enabled" } : { kind: "disabled", reads };
}
