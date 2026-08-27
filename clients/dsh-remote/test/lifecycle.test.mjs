import assert from "node:assert/strict";
import test from "node:test";
import { childStopped } from "../src/lifecycle.mjs";

test("被信号终止的 bridge 子进程可以重新拉起", () => {
  assert.equal(childStopped({ exitCode: null, signalCode: "SIGTERM" }), true);
});
