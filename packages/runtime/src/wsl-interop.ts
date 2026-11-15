// What the WSL interop switch says about the host. On WSL2 the kernel exposes a binfmt entry while the distribution can start Windows
// programs (`[interop] enabled=true` in its `/etc/wsl.conf`, the default), and its file reads `enabled`: `WSLInterop`, or `WSLInterop-late`,
// the name a systemd distribution registers it under again once its binfmt service has cleared the first (microsoft/WSL#8843). With interop off
// no file is there, and on a host that is not WSL none ever is. `wf doctor` reads them to report the WSL trust boundary (the WSL paragraph
// of SECURITY.md): a Windows process reaches the Linux home through `\\wsl$` as the distribution's default user, so the 0600 mode of
// `~/.cursor/sdk/auth.json` does not keep it out, and a step that runs without the SDK sandbox can start Windows programs while interop is on.
//
// This module only reads the files it is given. It never writes `wsl.conf`, never runs `wsl.exe` and never restarts anything: changing the
// boundary is the user's call.
import { readFileSync } from "node:fs";
import { errorText } from "./runtime/error-text.js";

/** The files the WSL kernel exposes while interop is on, in the order they are read. */
export const WSL_INTEROP_FILES: readonly string[] = ["/proc/sys/fs/binfmt_misc/WSLInterop", "/proc/sys/fs/binfmt_misc/WSLInterop-late"];

/** Tests only: the interop files to read, as a PATH lists directories, in place of `WSL_INTEROP_FILES`. The doctor tests point every run at files of their own. */
export const WSL_INTEROP_FILES_ENV = "WF_DOCTOR_WSL_INTEROP_FILES";

/**
 * What reading the interop files found: `enabled` (the first line of `file` says so: Windows programs can be started and the boundary is
 * open), `disabled` (a file is there and says anything else), `absent` (no file: not WSL, or interop off) or `unreadable` (a file could not
 * be read; `said` is why). A file that says `enabled` wins over the rest, and one that cannot be read over one that says `disabled`: the
 * answer is the most open reading the files give.
 */
export type WslInterop = { kind: "enabled"; file: string } | { kind: "disabled"; file: string; reads: string } | { kind: "absent" } | { kind: "unreadable"; file: string; said: string };

/** The interop switch as one file (the first line of the kernel's file) shows it. */
function readInteropFile(file: string): WslInterop {
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch (err) {
    return (err as { code?: unknown }).code === "ENOENT" ? { kind: "absent" } : { kind: "unreadable", file, said: errorText(err) };
  }
  const reads = content.split("\n")[0]!.trim();
  return reads === "enabled" ? { kind: "enabled", file } : { kind: "disabled", file, reads };
}

/** The interop switch as `files` show it: the most open reading of them. */
export function readWslInterop(files: readonly string[]): WslInterop {
  const readings = files.map(readInteropFile);
  for (const kind of ["enabled", "unreadable", "disabled"] as const) {
    const found = readings.find((reading) => reading.kind === kind);
    if (found) return found;
  }
  return { kind: "absent" };
}
