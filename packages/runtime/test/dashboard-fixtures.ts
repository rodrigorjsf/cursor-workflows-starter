// Shared by the tests that start the dashboard as a process: a free loopback port, and how many dashboards a throwaway
// home has seen start.
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

/** A loopback port nothing listens on right now. */
export function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => ok(port));
    });
  });
}

/** The dashboard's log in the per-user directory `home`, or "" when it has none. */
export const dashboardLog = (home: string): string => (existsSync(join(home, "dashboard.log")) ? readFileSync(join(home, "dashboard.log"), "utf8") : "");

/** How many dashboard processes announced that they listen: the number that were started and kept the port. */
export const dashboardListens = (home: string): number => (dashboardLog(home).match(/dashboard listening/g) ?? []).length;
