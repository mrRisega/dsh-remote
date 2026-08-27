import assert from "node:assert/strict";
import http from "node:http";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { apply } from "../lib/index.js";

test("切换账号时轮换设备身份并重启 bridge", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dsh-account-switch-"));
  const fakeHome = path.join(tempDir, "home");
  const fakeBin = path.join(tempDir, "bin");
  const launchLog = path.join(tempDir, "launchctl.log");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(path.join(fakeBin, "launchctl"), `#!/bin/sh
printf '%s\n' "$*" >> "$DSH_TEST_LAUNCH_LOG"
if [ "$1" = print ]; then printf 'state = running\npid = 4242\n'; fi
exit 0
`);
  await chmod(path.join(fakeBin, "launchctl"), 0o755);

  const relay = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ app_url: "https://example.test/app/" }));
  });
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  await writeFile(path.join(tempDir, ".dsh-config.json"), JSON.stringify({
    phone: "new-account",
    email: "old-account",
    password: "old-password",
    device_id: "dev-old",
    device_private_key: "private-old",
    device_public_key: "public-old",
    api_url: `http://127.0.0.1:${relay.address().port}`,
  }));

  const oldEnv = { HOME: process.env.HOME, PATH: process.env.PATH, DSH_TEST_LAUNCH_LOG: process.env.DSH_TEST_LAUNCH_LOG };
  process.env.HOME = fakeHome;
  process.env.PATH = `${fakeBin}:${oldEnv.PATH}`;
  process.env.DSH_TEST_LAUNCH_LOG = launchLog;

  const routes = new Map();
  apply({
    webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
    effect(register) { return register(); },
    logger: { info() {}, warn() {} },
  }, { relayDir: tempDir });
  const host = http.createServer((req, res) => routes.get(new URL(req.url, "http://x").pathname)(req, res));
  await new Promise((resolve) => host.listen(0, "127.0.0.1", resolve));

  try {
    const statusResponse = await fetch(`http://127.0.0.1:${host.address().port}/dsh-remote/status`);
    const status = await statusResponse.json();
    assert.equal(status.config.deviceId, "dev-old");
    assert.equal("configPath" in status.config, false);
    assert.equal(JSON.stringify(status).includes("old-password"), false);

    const response = await fetch(`http://127.0.0.1:${host.address().port}/dsh-remote/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "new-account", password: "new-password" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.bridgeRestart?.ok, true);

    const config = JSON.parse(await readFile(path.join(tempDir, ".dsh-config.json"), "utf8"));
    assert.equal(config.phone, "new-account");
    assert.equal(config.device_id, undefined);
    assert.equal(config.device_private_key, undefined);
    assert.equal(config.device_public_key, undefined);
    assert.match(await readFile(launchLog, "utf8"), /bootstrap/);
  } finally {
    host.close();
    relay.close();
    Object.assign(process.env, oldEnv);
    for (const [key, value] of Object.entries(oldEnv)) if (value === undefined) delete process.env[key];
    await rm(tempDir, { recursive: true, force: true });
  }
});
