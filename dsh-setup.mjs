#!/usr/bin/env node
/**
 * dsh-relay — 一键安装 + 配置 + 自启动（电脑端）
 *
 * 用法:
 *   dsh-relay [setup] [选项]                 一键安装（默认命令，无需任何参数）
 *   dsh-relay settings                        打开本地设置页（登录账号 / 自建配置）
 *   dsh-relay run                             前台运行 bridge（调试/守护）
 *   dsh-relay status                          查看配置与服务状态
 *   dsh-relay plugin [--uninstall]            手动安装/卸载 dsh web 远程控制插件
 *
 * setup 选项（全部可选）:
 *   --server <wss://host:port> --key <访问密钥>   自建模式（不填则连默认云端服务）
 *   --api <URL>                                 覆盖云端服务地址（高级）
 *   --no-autostart                              不安装开机自启服务
 *   --no-plugin                                 不安装 dsh web 插件
 *
 * 行为:
 *   1. 写入配置 <CONFIG_DIR>/.dsh-config.json（0600；npm 安装时为 ~/.dsh-remote/）
 *   2. 生成自启动服务（macOS launchd / Linux systemd），随 dsh web(3080) 存活自动保活
 *   3. 自动把远程控制插件装进 dsh web 设置页（若检测到 profile）
 *   4. 登录在设置页完成: dsh-relay settings（手机号+密码，或自建密钥）
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { childStopped } from "./clients/dsh-remote/src/lifecycle.mjs";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url)); // 本包目录（仓库或 node_modules）
const IS_NPM_INSTALL = THIS_DIR.includes(`${path.sep}node_modules${path.sep}`);
// 配置目录：npm 安装时放在用户目录（node_modules 内不可写）；仓库开发时放在仓库根。
const CONFIG_DIR = process.env.DSH_RELAY_DIR || (IS_NPM_INSTALL ? path.join(os.homedir(), ".dsh-remote") : THIS_DIR);
const CONFIG_PATH = path.join(CONFIG_DIR, ".dsh-config.json");
const SETTINGS_PORT = 3499;
// 默认云端服务地址（服务商 SaaS 入口；自建用户用 --server/--key 指向自己的 router）
const DEFAULT_API = "https://n.risegao.cn:13443/relay-api";
const DEFAULT_APP_URL = "https://n.risegao.cn:13443/app/";
const REPO_URL = "https://github.com/mrRisega/dsh-relay";

// ---------- 工具 ----------

function sh(cmd, timeoutMs = 15000, cwd = undefined) {
  try {
    const stdout = execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs, ...(cwd ? { cwd } : {}) });
    return { ok: true, stdout: String(stdout ?? ""), stderr: "", code: 0 };
  } catch (e) {
    return { ok: false, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? ""), code: e.status ?? -1 };
  }
}

/** 解析真实可执行路径（launchd/systemd 需要真实文件 + 可执行位）。 */
function resolveExecutable(p) {
  try {
    const real = fs.realpathSync(p);
    fs.accessSync(real, fs.constants.X_OK);
    return real;
  } catch { return null; }
}

function preferredNode() {
  const candidates = [
    process.env.DSH_SETUP_NODE20 || "",
    process.env.DSH_SETUP_NODE || "",
    process.execPath
  ].filter(Boolean);
  for (const p of candidates) {
    const real = resolveExecutable(p);
    if (real) return real;
  }
  return process.execPath;
}
const NODE_BIN = preferredNode();

// ---------- 配置读写 ----------
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
  catch { return {}; }
}
function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

// ---------- 公共配置（从服务端取域名，服务商可随时更换） ----------
async function fetchPublicConfig(apiBase) {
  try {
    const r = await fetch(apiBase + "/api/public-config", { signal: AbortSignal.timeout(6000) });
    if (r.ok) return await r.json();
  } catch {}
  return {};
}

/** 从账号 API 地址推导隧道 WebSocket 地址：https://host/relay-api → wss://host */
function deriveTunnelUrl(apiUrl) {
  return apiUrl.replace(/\/relay-api\/?$/, "").replace(/^https/, "wss");
}

/** 归一化自建服务器地址：缺省补 wss://，去掉末尾 / */
function normalizeTunnelUrl(raw) {
  let u = String(raw || "").trim().replace(/\/+$/, "");
  if (!/^wss?:/i.test(u)) u = "wss://" + u;
  return u;
}

function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : null;
}
function hasFlag(argv, name) {
  return argv.includes(name);
}

// ---------- 自启动服务生成与热启动 ----------
function autostartFilePath() {
  if (process.platform === "darwin")
    return path.join(os.homedir(), "Library/LaunchAgents/com.dshremote.bridge.plist");
  if (process.platform === "linux")
    return path.join(os.homedir(), ".config/systemd/user/dsh-bridge.service");
  return null;
}

function writeAutostartFile() {
  const runCmd = `"${NODE_BIN}" "${fileURLToPath(import.meta.url)}" run`;
  if (process.platform === "darwin") {
    const plistPath = autostartFilePath();
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.dshremote.bridge</string>
  <key>ProgramArguments</key>
  <array><string>${NODE_BIN}</string><string>${fileURLToPath(import.meta.url)}</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(CONFIG_DIR, ".dsh-bridge.log")}</string>
  <key>StandardErrorPath</key><string>${path.join(CONFIG_DIR, ".dsh-bridge.log")}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string></dict>
</dict></plist>`;
    fs.writeFileSync(plistPath, plist);
    console.log(`✅ 已创建自启动服务: ${plistPath}`);
    return plistPath;
  }
  if (process.platform === "linux") {
    const dir = path.join(os.homedir(), ".config/systemd/user");
    fs.mkdirSync(dir, { recursive: true });
    const unit = `[Unit]\nDescription=dsh-relay bridge (auto-starts with dsh web)\n\n[Service]\nExecStart=${runCmd}\nRestart=on-failure\nRestartSec=5\nEnvironment=PATH=/usr/local/bin:/usr/bin:/bin\n\n[Install]\nWantedBy=default.target\n`;
    const unitPath = autostartFilePath();
    fs.writeFileSync(unitPath, unit);
    console.log(`✅ 已创建自启动服务: ${unitPath}`);
    return unitPath;
  }
  console.log("⚠️ 当前平台暂不支持自启动，请手动运行 `dsh-relay run`");
  return null;
}

function restartBridgeService() {
  const svcFile = autostartFilePath();
  if (svcFile && !fs.existsSync(svcFile)) {
    console.log("[dsh-relay] 未检测到自启动服务，自动生成...");
    writeAutostartFile();
  }
  if (process.platform === "darwin") {
    const plistPath = autostartFilePath();
    if (!fs.existsSync(plistPath)) return { ok: false, status: "not-installed", detail: "plist 不存在" };
    const uid = process.getuid();
    const domain = `gui/${uid}`;
    const target = `${domain}/com.dshremote.bridge`;
    const q = (s) => "'" + String(s).replace(/'/g, `'\\''`) + "'";
    sh(`launchctl bootout ${target}`);
    let boot = sh(`launchctl bootstrap ${domain} ${q(plistPath)}`);
    if (!boot.ok) {
      sh(`launchctl unload ${q(plistPath)}`);
      boot = sh(`launchctl load -w ${q(plistPath)}`);
    }
    if (!boot.ok) return { ok: false, status: "failed", detail: (boot.stderr || boot.stdout).trim() || "launchctl 启动失败" };
    const pr = sh(`launchctl print ${target}`);
    if (pr.ok && /state\s*=\s*running/.test(pr.stdout)) {
      const m = pr.stdout.match(/pid\s*=\s*(\d+)/);
      return { ok: true, status: "running", pid: m ? Number(m[1]) : null };
    }
    const ls = sh(`launchctl list | grep com.dshremote.bridge`);
    if (ls.ok) {
      const pidStr = ls.stdout.trim().split(/\s+/)[0];
      if (pidStr && pidStr !== "-" && /^\d+$/.test(pidStr))
        return { ok: true, status: "running", pid: Number(pidStr) };
    }
    return { ok: false, status: "failed", detail: (pr.stderr || ls.stderr || "服务未在运行").trim() };
  }
  if (process.platform === "linux") {
    const r = sh(`systemctl --user restart dsh-bridge`);
    if (!r.ok) return { ok: false, status: "failed", detail: (r.stderr || r.stdout).trim() || "systemctl restart 失败" };
    const a = sh(`systemctl --user is-active dsh-bridge`);
    return a.ok && a.stdout.trim() === "active"
      ? { ok: true, status: "running", pid: null }
      : { ok: false, status: "failed", detail: (a.stdout || a.stderr).trim() };
  }
  return { ok: false, status: "unsupported", detail: `平台 ${process.platform} 不支持自启动` };
}

function installAutostart() {
  const svcPath = writeAutostartFile();
  const r = restartBridgeService();
  if (r.ok) {
    console.log(`✅ 自启动服务已加载并运行${r.pid ? ` (pid=${r.pid})` : ""}`);
  } else {
    console.log(`⚠️ 自启动服务启动失败: ${r.detail || r.status}`);
  }
  return { path: svcPath, status: r };
}

// ---------- 设置页（本地 HTTP：远程地址 + 账号/自建配置） ----------
function serveSettings() {
  const cfg = loadConfig();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${SETTINGS_PORT}`);
    const send = (code, body, type = "text/html") => {
      res.writeHead(code, { "Content-Type": type + "; charset=utf-8" });
      res.end(body);
    };

    if (req.method === "POST" && url.pathname === "/api/config") {
      let raw = "";
      for await (const c of req) raw += c;
      try {
        const body = JSON.parse(raw);
        const local = Boolean(body.local_key || body.server);
        if (local) {
          if (!body.server || !body.local_key) {
            return send(400, JSON.stringify({ ok: false, message: "自建模式需要服务器地址与访问密钥" }), "application/json");
          }
          cfg.tunnel_url = normalizeTunnelUrl(body.server);
          cfg.local_key = String(body.local_key).trim();
          delete cfg.phone; delete cfg.password;
        } else {
          if (!body.phone || !body.password) {
            return send(400, JSON.stringify({ ok: false, message: "SaaS 模式需要手机号与密码" }), "application/json");
          }
          cfg.phone = body.phone; cfg.password = body.password;
          delete cfg.local_key;
          cfg.api_url = body.api_url || cfg.api_url || DEFAULT_API;
          if (!cfg.tunnel_url) cfg.tunnel_url = deriveTunnelUrl(cfg.api_url);
        }
        saveConfig(cfg);
        const r = restartBridgeService();
        return send(200, JSON.stringify({ ok: true, service: r.ok ? "running" : (r.status || "failed") }), "application/json");
      } catch { return send(400, JSON.stringify({ ok: false, message: "JSON 解析失败" }), "application/json"); }
    }

    const mode = cfg.local_key ? "自建服务" : "SaaS 云端服务";
    const pub = await fetchPublicConfig(cfg.api_url || DEFAULT_API);
    const remoteUrl = pub.app_url || (cfg.local_key ? (cfg.tunnel_url || "") : DEFAULT_APP_URL);

    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>dsh-relay 设置</title>
<style>
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#0d1117;color:#e6edf3;max-width:520px;margin:0 auto;padding:24px}
h1{font-size:18px}label{display:block;font-size:13px;color:#8b949e;margin:14px 0 6px}
input{width:100%;padding:11px 13px;border-radius:8px;border:1px solid #30363d;background:#161b22;color:#e6edf3;font-size:15px;box-sizing:border-box}
button{width:100%;padding:13px;border-radius:8px;border:none;background:#2f81f7;color:#fff;font-size:15px;font-weight:600;cursor:pointer;margin-top:16px}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px;margin-bottom:16px}
.url{background:#010409;border:1px solid #30363d;border-radius:8px;padding:12px;font-family:monospace;font-size:14px;word-break:break-all}
.msg{font-size:13px;margin-top:10px;min-height:18px}.ok{color:#3fb950}.err{color:#f85149}
</style></head><body>
<h1>dsh-relay 设置</h1>
<div class="card"><h3 style="margin:0 0 8px">📱 远程控制地址（当前模式：${mode}）</h3>
<div class="url">${remoteUrl || "（未配置）"}</div>
<div style="font-size:12px;color:#8b949e;margin-top:8px">手机浏览器打开此地址，即可远程控制本机 dsh web。</div></div>
<div class="card"><h3 style="margin:0 0 4px">🔑 连接配置</h3>
<div style="font-size:12px;color:#8b949e;margin-bottom:8px">二选一：填手机号密码（SaaS），或填服务器地址+访问密钥（自建）。</div>
<label>SaaS 手机号</label><input id="phone" value="${cfg.phone || ""}" autocomplete="tel"/>
<label>SaaS 密码</label><input id="pass" type="password" placeholder="••••••••" autocomplete="current-password"/>
<div style="height:1px;background:#30363d;margin:16px 0"></div>
<label>自建服务器地址（wss://host:port）</label><input id="server" value="${cfg.tunnel_url || ""}" placeholder="wss://relay.example.com"/>
<label>自建访问密钥</label><input id="lkey" type="password" value="${cfg.local_key || ""}" placeholder="访问密钥"/>
<button onclick="save()">保存并生效</button>
<div class="msg" id="msg"></div></div>
<script>
async function save(){
  const m=document.getElementById("msg");m.className="msg";m.textContent="保存中...";
  const local = document.getElementById("lkey").value.trim() !== "" || document.getElementById("server").value.trim() !== "";
  try{
    const r=await fetch("/api/config",{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify(local
        ? {server:document.getElementById("server").value.trim(),local_key:document.getElementById("lkey").value.trim()}
        : {phone:document.getElementById("phone").value.trim(),password:document.getElementById("pass").value})});
    const d=await r.json();
    if(d.ok){m.className="msg ok";m.textContent = d.service==="running" ? "✅ 已保存并生效，无需手动重启" : "✅ 已保存（服务状态: "+(d.service||"未知")+"，可运行 dsh-relay setup 修复）";}
    else{m.className="msg err";m.textContent=d.message||"保存失败";}
  }catch(e){m.className="msg err";m.textContent="保存失败: "+e.message;}
}
</script></body></html>`;
    return send(200, html);
  });
  server.listen(SETTINGS_PORT, "127.0.0.1", () => {
    console.log(`\n✅ 设置页已打开: http://127.0.0.1:${SETTINGS_PORT}`);
    console.log("   在浏览器中配置账号或自建连接，查看远程控制地址。Ctrl-C 关闭。\n");
  });
}

// ---------- run：前台跑 bridge（带配置 + 自启动 watcher） ----------
async function runBridge() {
  let cfg = loadConfig();
  let warnedNoLogin = false;

  // watcher：检测 dsh web（127.0.0.1:3080）存活，存活才启动 bridge
  const checkUpstream = () => new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 2000);
    fetch("http://127.0.0.1:3080/")
      .then(() => { clearTimeout(t); resolve(true); })
      .catch(() => { clearTimeout(t); resolve(false); });
  });

  console.log("[dsh-relay] 等待 dsh web（127.0.0.1:3080）启动...");
  let bridgeProc = null;
  let starting = false;

  const ensureBridge = async () => {
    if (starting) return;
    // 每次循环重读配置：设置页登录/切换模式后无需重启守护即可生效
    cfg = loadConfig();
    const saas = Boolean((cfg.phone || cfg.email) && cfg.password);
    const local = Boolean(cfg.local_key);
    if (!saas && !local) {
      if (!warnedNoLogin) {
        warnedNoLogin = true;
        console.log("⚠️ 尚未登录：打开设置页 `dsh-relay settings` 登录账号（或配置自建密钥）后自动启动。");
      }
      return;
    }
    warnedNoLogin = false;
    if (local && !cfg.tunnel_url) {
      console.log("⚠️ 自建模式缺少服务器地址：请用 `dsh-relay setup --server wss://host:port --key <密钥>` 重新配置。");
      return;
    }
    if (saas && !cfg.tunnel_url) {
      cfg.tunnel_url = deriveTunnelUrl(cfg.api_url || DEFAULT_API);
      saveConfig(cfg);
    }
    const apiUrl = saas ? (cfg.api_url || DEFAULT_API) : "";

    const alive = await checkUpstream();
    if (alive && childStopped(bridgeProc)) {
      starting = true;
      console.log("[dsh-relay] dsh web 在线，启动 bridge...");
      // 清除代理环境变量（bridge 需直连 relay，不受本机代理影响）
      const childEnv = {
        ...process.env,
        DSH_BRIDGE_CONFIG: CONFIG_PATH,
        DSH_BRIDGE_TUNNEL_URL: cfg.tunnel_url,
        ...(saas ? { DSH_BRIDGE_PHONE: (cfg.phone || cfg.email || ""), DSH_BRIDGE_PASSWORD: cfg.password, DSH_BRIDGE_API: apiUrl, DSH_BRIDGE_SECRET: cfg.bridge_secret || "" } : {}),
        ...(local ? { DSH_BRIDGE_LOCAL_KEY: cfg.local_key } : {})
      };
      for (const k of ["http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "no_proxy", "NO_PROXY"]) {
        delete childEnv[k];
      }
      bridgeProc = spawn(NODE_BIN,
        [path.join(THIS_DIR, "clients/dsh-remote/dsh-bridge.mjs")],
        { env: childEnv, stdio: "inherit" });
      bridgeProc.on("exit", () => { console.log("[dsh-relay] bridge 退出，等待重启..."); });
      setTimeout(() => { starting = false; }, 5000);
    } else if (!alive && bridgeProc && bridgeProc.exitCode === null) {
      console.log("[dsh-relay] dsh web 离线，停止 bridge...");
      bridgeProc.kill();
    }
  };

  await ensureBridge();
  setInterval(ensureBridge, 10000); // 每 10s 检查
  console.log("[dsh-relay] 守护运行中（Ctrl-C 退出）");
}

// ---------- setup：一键安装（默认云端服务；--server/--key 走自建） ----------
async function setup(argv) {
  const api = argValue(argv, "--api");
  const server = argValue(argv, "--server");
  const key = argValue(argv, "--key");
  const noAutostart = hasFlag(argv, "--no-autostart");
  const noPlugin = hasFlag(argv, "--no-plugin");
  const selfHosted = Boolean(server || key);

  let cfg = loadConfig();

  if (selfHosted) {
    if (!server || !key) {
      console.error("❌ 自建模式需要 --server（wss://host:port）与 --key（访问密钥）两个参数。");
      process.exit(1);
    }
    cfg.tunnel_url = normalizeTunnelUrl(server);
    cfg.local_key = String(key).trim();
    delete cfg.phone; delete cfg.password;
    saveConfig(cfg);

    // 校验：用访问密钥向 router 换本地 JWT（连不通立即报错）
    const u = new URL(cfg.tunnel_url);
    u.protocol = u.protocol === "wss:" ? "https:" : "http:";
    u.pathname = "/_login";
    try {
      const r = await fetch(u.toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: cfg.local_key }),
        signal: AbortSignal.timeout(8000)
      });
      const d = await r.json().catch(() => ({}));
      if (r.status !== 200 || !d.token) {
        console.error(`❌ 访问密钥校验失败（${r.status}）: ${d.error?.message || "未知错误"}`);
        process.exit(1);
      }
      console.log("✅ 已连接你的 relay-router，访问密钥有效。");
    } catch (e) {
      console.error(`❌ 无法连接 ${u.toString()}: ${e.message}`);
      console.error("   请确认服务器地址、端口与 TLS 配置（自建需 https/wss 入口）。");
      process.exit(1);
    }
  } else {
    // 默认云端服务：无需任何参数；登录在设置页完成
    cfg.api_url = (api || cfg.api_url || DEFAULT_API).replace(/\/+$/, "");
    if (!cfg.tunnel_url) cfg.tunnel_url = deriveTunnelUrl(cfg.api_url);
    saveConfig(cfg);
  }

  let svc = { path: null, status: { ok: true, status: "skipped", detail: "--no-autostart" } };
  if (!noAutostart) {
    svc = installAutostart();
  } else {
    console.log("ℹ --no-autostart：跳过自启动服务安装（可用 `dsh-relay run` 手动运行 bridge）。");
  }
  const st = svc.status;

  // 自动安装 dsh web 插件（非致命：失败只提示，不阻断安装）
  if (!noPlugin) {
    try {
      await pluginCmd([]);
    } catch (e) {
      console.warn(`⚠️ 插件安装未完成：${e.message}`);
    }
  }

  const pub = await fetchPublicConfig(cfg.api_url || DEFAULT_API);
  console.log("\n══════════════════════════════════════");
  console.log("✅ 安装完成！");
  if (selfHosted) {
    console.log(`   服务器地址: ${cfg.tunnel_url}`);
    console.log(`   手机端: 打开 ${cfg.tunnel_url.replace(/^ws/, "https")}/app/ ，用访问密钥登录即可。`);
  } else {
    console.log(`   远程控制地址: ${pub.app_url || DEFAULT_APP_URL}`);
    console.log(`   下一步: 运行 \`dsh-relay settings\` 打开设置页，用手机号+密码登录（或注册）。`);
    console.log(`   登录后 bridge 会自动启动，手机端即可看到本机。`);
  }
  if (svc.path) console.log(`   自启动服务: ${svc.path}`);
  console.log(`   服务状态: ${st.ok ? "✅ 运行中" + (st.pid ? ` (pid=${st.pid})` : "") : "❌ 未运行(" + (st.detail || st.status) + ")"}`);
  console.log("══════════════════════════════════════");
}

// ---------- plugin：安装/卸载 dsh web 远程控制插件 ----------
const PLUGIN_MARKER_START = "# >>> dsh-remote-ui (managed by dsh-relay plugin; do not edit)";
const PLUGIN_MARKER_END = "# <<< dsh-remote-ui";

function pluginBlock(relayDir) {
  return `${PLUGIN_MARKER_START}
- insert:
    - id: dsh-remote-ui
      name: 'dsh-remote-ui'
      config:
        relayDir: '${relayDir}'
${PLUGIN_MARKER_END}`;
}

/** 移除 patch 中所有引用 dsh-remote-ui 的条目块（含其前置注释），返回剩余内容。 */
function stripPluginEntries(patch) {
  const lines = patch.split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^- insert:\s*$/.test(line)) {
      // insert 块 = 该行 + 后续「缩进」行；空行/注释行属于下一个条目，不并入
      const block = [line];
      let j = i + 1;
      while (j < lines.length && (lines[j].startsWith(" ") || lines[j].startsWith("\t"))) {
        block.push(lines[j]);
        j++;
      }
      if (block.join("\n").includes("dsh-remote-ui")) {
        // 连带删除块前的连续注释（旧版条目说明 / 管理标记），以及块后的收尾标记行
        while (out.length && /^\s*#/.test(out[out.length - 1])) out.pop();
        if (j < lines.length && /^\s*#/.test(lines[j]) && lines[j].includes("dsh-remote-ui")) j++;
        i = j;
        continue;
      }
      out.push(...block);
      i = j;
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** 在 profile 目录执行依赖安装（pnpm 优先）。 */
function installProfileDeps(profileDir) {
  const pm = sh("command -v pnpm >/dev/null 2>&1 && echo pnpm || echo npm").stdout.trim() || "npm";
  const cmd = pm === "pnpm" ? "pnpm install" : "npm install";
  return sh(cmd, 120000, profileDir);
}

async function pluginCmd(argv) {
  const uninstall = hasFlag(argv, "--uninstall");
  const profileIdx = argv.indexOf("--profile");
  const profileDir = profileIdx > -1 && argv[profileIdx + 1]
    ? argv[profileIdx + 1]
    : process.env.DSH_PROFILE_DIR || path.join(os.homedir(), ".dsh", "profiles", "web");
  const pkgFile = path.join(profileDir, "package.json");
  const patchFile = path.join(profileDir, "cordis.patch.yml");
  const pluginDir = path.join(THIS_DIR, "packages/dsh-remote-ui");

  if (!fs.existsSync(pkgFile) || !fs.existsSync(patchFile)) {
    console.error(`❌ 未找到 dsh web profile（${profileDir}）。`);
    console.error("   请先安装 DeepSeek Harness（npx @deepseek-ai/dsh web）并初始化默认 profile。");
    process.exit(1);
  }
  if (!fs.existsSync(pluginDir)) {
    console.error(`❌ 本包缺少 packages/dsh-remote-ui（${pluginDir}）。`);
    process.exit(1);
  }

  const patch = fs.readFileSync(patchFile, "utf8");
  const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));

  if (uninstall) {
    // 移除 patch 中的插件条目（兼容旧版无标记条目）
    const newPatch = stripPluginEntries(patch);
    if (newPatch !== patch) {
      fs.writeFileSync(patchFile, newPatch);
      console.log(`✅ 已从 ${patchFile} 移除插件条目`);
    } else {
      console.log("ℹ patch 中未发现 dsh-remote-ui 条目。");
    }
    if (pkg.dependencies && pkg.dependencies["dsh-remote-ui"]) {
      delete pkg.dependencies["dsh-remote-ui"];
      fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n");
      console.log(`✅ 已从 ${pkgFile} 移除 dsh-remote-ui 依赖`);
    }
    console.log("   执行依赖更新...");
    const r = installProfileDeps(profileDir);
    if (!r.ok) console.warn(`⚠️ 依赖更新失败：${r.stderr.trim() || r.stdout.trim()}（请手动在 ${profileDir} 执行 pnpm install）`);
    console.log("✅ 卸载完成。重启 dsh web 生效。");
    return;
  }

  // 安装：写依赖 + patch 块
  pkg.dependencies = pkg.dependencies || {};
  pkg.dependencies["dsh-remote-ui"] = `link:${pluginDir}`;
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n");

  // 先清掉旧条目（含旧版无标记条目），再写入带标记的新块，保证不重复
  const stripped = stripPluginEntries(patch);
  const block = pluginBlock(CONFIG_DIR);
  fs.writeFileSync(patchFile, stripped + block + "\n");
  console.log(`✅ 已写入 ${patchFile}`);
  console.log("   执行依赖更新（pnpm install）...");
  const r = installProfileDeps(profileDir);
  if (!r.ok) console.warn(`⚠️ 依赖更新失败：${r.stderr.trim() || r.stdout.trim()}（请手动在 ${profileDir} 执行 pnpm install）`);
  console.log(`✅ 插件安装完成。配置目录: ${CONFIG_DIR}`);
  console.log("   重启 dsh web（或重开 profile）后，在「设置 → 远程控制」查看面板。");
}

// ---------- main ----------
// 无命令名（或首个参数以 - 开头）时默认执行 setup
const raw = process.argv[2];
const cmd = raw && !raw.startsWith("-") ? raw : "setup";
const args = raw && !raw.startsWith("-") ? process.argv.slice(3) : process.argv.slice(2);
if (cmd === "setup" || cmd === "install") await setup(args);
else if (cmd === "settings") serveSettings();
else if (cmd === "run") await runBridge();
else if (cmd === "plugin") await pluginCmd(process.argv.slice(3));
else if (cmd === "status") {
  const cfg = loadConfig();
  const local = Boolean(cfg.local_key);
  console.log("配置文件:", CONFIG_PATH);
  console.log("连接模式:", local ? `自建服务（${cfg.tunnel_url || "未设置服务器地址"}）` : `SaaS 云端服务（${cfg.phone || "未配置账号"}）`);
  console.log("API:", cfg.api_url || (local ? "（自建模式无需账号 API）" : DEFAULT_API));
  console.log("远程地址: 运行 settings 查看最新");
} else {
  console.log(`dsh-relay — 手机远程控制 dsh web（隧道模式）

用法:
  dsh-relay              一键安装（默认命令，无需任何参数；含插件与自启动）
  dsh-relay settings     打开本地设置页（登录账号 / 自建配置）
  dsh-relay run          前台运行 bridge（调试）
  dsh-relay status       查看配置与服务状态
  dsh-relay plugin       手动安装 dsh web 远程控制插件（--uninstall 卸载）

自建模式（可选）:
  dsh-relay setup --server wss://你的域名:端口 --key 访问密钥

登录: 安装后运行 \`dsh-relay settings\`，用手机号+密码登录（或配置自建密钥）。
文档: ${REPO_URL}
`);
  process.exit(cmd === "help" ? 0 : 1);
}
