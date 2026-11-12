// The liveness check the job projection and the run lock share.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { isAlive } from "../src/runtime/pid.js";

test("this process is alive, and an exited one is not", () => {
  assert.equal(isAlive(process.pid), true);
  const done = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(isAlive(done.pid!), false);
});

test("a process owned by another user (EPERM) counts as alive", { skip: process.getuid?.() === 0 && "root can signal any pid" }, () => {
  assert.equal(isAlive(1), true);
});
