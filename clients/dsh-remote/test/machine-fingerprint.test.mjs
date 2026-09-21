/**
 * Windows 机器指纹回归。
 *
 * 背景：machineUniqueId() 原本只有 darwin(ioreg) 与 linux(machine-id) 两条分支，
 * Windows 上恒返回 ""，于是 machineFingerprint() 退化成 `${hostname}|${platform}` 的哈希 ——
 * 用户**改一次主机名就被服务端当成一台新设备**：旧设备记录不会被顶替，
 * 设备列表里堆出幽灵条目，面板上"这台机器"也会对不上。
 *
 * 这些分支在 macOS 开发机上跑不到，所以这里把函数从源码里抠出来，
 * 注入假 process / 假 execSync / 假 spawnSync / 假 fs，把 win32 分支**真正执行一遍**，
 * 而不是只看源码长得像不像。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_SRC = readFileSync(path.join(HERE, "..", "dsh-bridge.mjs"), "utf8");

/** 真实 `reg query ... /v MachineGuid` 的输出形态：CRLF 行尾、键名与值之间是空格。 */
const REG_OUT = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n"
  + "    MachineGuid    REG_SZ    9f8a1c2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b\r\n\r\n";
const GUID = "9f8a1c2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";

/**
 * 把 machineUniqueId 抠出来执行。切片锚点一旦漂移会立刻在下面第一条断言里暴露。
 */
function loadMachineUniqueId({
  platform,
  env = {},
  reg = { status: 0, stdout: REG_OUT },
  regThrows = false,
  ioreg = "",
  machineIdFiles = {},
} = {}) {
  const from = BRIDGE_SRC.indexOf("function machineUniqueId()");
  const to = BRIDGE_SRC.indexOf("/** 稳定指纹:");
  assert.ok(from > -1 && to > from, "未能从 dsh-bridge.mjs 切出 machineUniqueId（锚点已漂移）");
  const src = BRIDGE_SRC.slice(from, to);
  assert.ok(!/稳定指纹/.test(src), "切片不应越过 machineUniqueId 的边界");

  const calls = [];
  const fakeSpawnSync = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (regThrows) throw new Error("spawn EPERM");
    return reg;
  };
  const fakeFs = {
    readFileSync: (f) => {
      if (f in machineIdFiles) return machineIdFiles[f];
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  };
  const make = new Function("process", "execSync", "spawnSync", "fs", "os",
    `${src}\nreturn machineUniqueId;`);
  const fn = make({ platform, env }, () => ioreg, fakeSpawnSync, fakeFs, {});
  return { fn, calls };
}

test("win32：机器指纹取注册表 MachineGuid（改主机名不再被当成新设备）", () => {
  const { fn } = loadMachineUniqueId({ platform: "win32" });
  assert.equal(fn(), GUID, "应从 reg query 输出里解析出 MachineGuid");
});

test("win32：读注册表走 spawnSync 数组传参 + windowsHide（不经 cmd.exe、不弹窗）", () => {
  const { fn, calls } = loadMachineUniqueId({ platform: "win32" });
  fn();
  assert.equal(calls.length, 1, "只应调用一次 reg");
  const [c] = calls;
  assert.equal(c.cmd, "reg", "应使用 reg.exe（恒定存在、约 20ms），而不是 PowerShell/WMI");
  assert.deepEqual(c.args, ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"],
    "参数必须走数组（不经 cmd.exe，故没有引号/空格/中文路径的转义坑）");
  assert.equal(c.opts.windowsHide, true, "必须 windowsHide：否则 Windows 上会闪一个黑色命令行窗口");
  assert.ok(!c.opts.shell, "不得启用 shell");
  assert.ok(Number.isFinite(c.opts.timeout), "必须有超时，不能把启动卡死");
});

test("win32：注册表读不到时返回空串，让上层退回宿主名指纹（不抛异常）", () => {
  // 这三种都是真实可能的：非 Windows 上不该走到这条分支、受限账户、以及被安全软件拦截。
  const failed = loadMachineUniqueId({ platform: "win32", reg: { status: 1, stdout: "", stderr: "拒绝访问" } });
  assert.equal(failed.fn(), "", "reg 退出码非 0 → 空串");
  const garbled = loadMachineUniqueId({ platform: "win32", reg: { status: 0, stdout: "乱七八糟" } });
  assert.equal(garbled.fn(), "", "输出不可解析 → 空串");
  const thrown = loadMachineUniqueId({ platform: "win32", regThrows: true });
  assert.equal(thrown.fn(), "", "spawn 抛错必须被吞掉（机器指纹不是关键路径，不能拖垮启动）");
});

test("机器指纹：显式环境变量覆盖在所有平台优先", () => {
  for (const platform of ["win32", "darwin", "linux"]) {
    const { fn } = loadMachineUniqueId({ platform, env: { DSH_BRIDGE_MACHINE_FP: "override-me" } });
    assert.equal(fn(), "override-me", `${platform} 上 DSH_BRIDGE_MACHINE_FP 应优先`);
  }
});

test("机器指纹：darwin/linux 两条老分支没有被改坏", () => {
  const darwin = loadMachineUniqueId({
    platform: "darwin",
    ioreg: '    "IOPlatformUUID" = "AAAA-BBBB-CCCC"\n',
  });
  assert.equal(darwin.fn(), "AAAA-BBBB-CCCC", "darwin 仍读 ioreg 的 IOPlatformUUID");

  const linux = loadMachineUniqueId({
    platform: "linux",
    machineIdFiles: { "/etc/machine-id": "0123456789abcdef\n" },
  });
  assert.equal(linux.fn(), "0123456789abcdef", "linux 仍读 /etc/machine-id（并去掉换行）");
});

test("机器指纹：拿不到机器唯一值时才退回宿主名哈希（这正是要修的退化路径）", () => {
  // 断言 machineFingerprint 的兜底表达式仍然存在 —— 它是"改主机名 = 新设备"的直接来源，
  // 修好 win32 分支后这条兜底只应在容器等极端环境生效。
  const i = BRIDGE_SRC.indexOf("function machineFingerprint()");
  assert.ok(i > -1, "应能找到 machineFingerprint");
  const body = BRIDGE_SRC.slice(i, i + 400);
  assert.match(body, /machineUniqueId\(\) \|\| `\$\{os\.hostname\(\)\}\|\$\{os\.platform\(\)\}`/,
    "兜底应保持 hostname|platform 的形态（改了这里等于改了设备识别语义）");
  assert.match(body, /sha256/, "指纹必须哈希后再用（机器唯一值原文不得外发）");
});
