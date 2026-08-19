#!/usr/bin/env node
import { loadConfig } from "../lib/config.js";
import { startServer } from "../lib/server.js";
import { hashPassword } from "../lib/auth.js";

const HELP = `dsh-remote — 远程控制 DeepSeek Harness 的安全网关

用法:
  dsh-remote start [--config <path>]    启动网关(默认端口 3443)
  dsh-remote hash-password [--password x]  生成口令的 scrypt 哈希(脚本化可用 --password)
  dsh-remote --help                     显示本帮助

环境变量(优先级高于配置文件):
  DSH_REMOTE_PORT         监听端口(0=自动)
  DSH_REMOTE_HOST         绑定地址(默认 0.0.0.0)
  DSH_REMOTE_UPSTREAM     dsh web 地址(默认 http://127.0.0.1:3080)
  DSH_REMOTE_PASSWORD     访问口令(明文,生产建议用 hash-password)
  DSH_REMOTE_TLS_CERT     TLS 证书路径(可选)
  DSH_REMOTE_TLS_KEY      TLS 私钥路径(可选)
  DSH_REMOTE_ALLOW_IPS    IP 白名单(逗号分隔,空=不限)
  DSH_REMOTE_SESSION_TTL_HOURS  会话有效期小时数(默认 12)
  DSH_REMOTE_RATE_LIMIT   登录限流 "max:windowMs"(默认 5:900000)
  DSH_REMOTE_DIST_DIR     登录页静态资源目录(可选)
  DSH_REMOTE_LOG=1        打印请求日志

示例:
  dsh-remote hash-password
  DSH_REMOTE_PASSWORD=xxxx dsh-remote start
  dsh-remote start --config ./config.json
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === "--help" || cmd === "-h" || cmd === undefined) {
    console.log(HELP);
    return;
  }

  if (cmd === "hash-password") {
    // 支持从参数直接传入(便于脚本化): dsh-remote hash-password --password xxxx
    const idx = rest.indexOf("--password");
    let pwd = idx !== -1 ? rest[idx + 1] : undefined;
    if (pwd === undefined) {
      const { createInterface } = await import("node:readline/promises");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      pwd = await rl.question("口令(不显示): ");
      rl.close();
    }
    if (typeof pwd !== "string" || pwd.length < 8) {
      console.error("口令至少 8 位");
      process.exit(1);
    }
    console.log(`passwordHash: ${hashPassword(pwd)}`);
    return;
  }

  if (cmd === "start") {
    const configFile = rest.includes("--config")
      ? rest[rest.indexOf("--config") + 1]
      : undefined;
    const config = loadConfig({ configFile });
    const { port, host, upstream, server } = await startServer(config);
    const scheme = config.tls ? "https" : "http";
    const displayHost = host === "0.0.0.0" ? "<本机IP>" : host;
    console.log(`[dsh-remote] 监听 ${scheme}://${displayHost}:${port}`);
    console.log(`[dsh-remote] 上游 ${upstream} (${config.tls ? "TLS 开启" : "未启用 TLS"})`);
    console.log(`[dsh-remote] 登录页 ${scheme}://${displayHost}:${port}/login`);
    const stop = () => {
      server.close();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return;
  }

  console.error(`未知命令: ${cmd}\n`);
  console.log(HELP);
  process.exit(1);
}

main().catch((err) => {
  console.error(`[dsh-remote] 启动失败: ${err.message}`);
  process.exit(1);
});
