/**
 * relay-router — 日志输出(控制台 + 可选文件)
 *
 * 容器和进程重启都会丢掉控制台日志,所以除了 stdout,还可以把日志写到文件里,
 * 并按大小轮转,避免单个文件无限增长。
 *
 * 特性:
 *   - 零依赖(只用 node:fs / node:path)
 *   - 同步追加:进程被 kill 时不丢最后几行
 *   - 写文件失败(磁盘满 / 目录不可写)时降级为只写 stdout,并只提示一次,不影响服务本身
 *   - 轮转:`x.log` → `x.log.1` → `x.log.2` … 超出 keep 的最老文件删除
 *   - 未设置 DSH_LOG_DIR 时只写 stdout
 *   - stdout 保持原始文案;写进文件的那份才带时间戳与级别
 *
 * 环境变量:
 *   DSH_LOG_DIR       日志目录;未设置 = 只写 stdout
 *   DSH_LOG_MAX_MB    单文件上限(MB,默认 10)
 *   DSH_LOG_KEEP      保留的历史文件数(默认 5)
 *   DSH_LOG_LEVEL     debug | info | warn | error(默认 info)
 *   DSH_LOG_STDOUT    设为 0 时不写 stdout(默认写)
 */

import fs from "node:fs";
import path from "node:path";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/** 解析日志目录(空字符串/未设置 → null,表示不落盘)。 */
export function resolveLogDir(dir) {
  const raw = dir ?? process.env.DSH_LOG_DIR ?? "";
  const trimmed = String(raw).trim();
  return trimmed ? path.resolve(trimmed) : null;
}

/** 本地时间戳(含时区偏移),便于对照服务器本地时间排查。 */
export function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const oh = p(Math.floor(Math.abs(off) / 60));
  const om = p(Math.abs(off) % 60);
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)} ` +
    `${sign}${oh}:${om}`
  );
}

function safeText(v) {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.stack || v.message;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * 创建一个带落盘与轮转的 logger。
 *
 * @param {object} [opts]
 * @param {string} [opts.name="app"]  文件名前缀(生成 <dir>/<name>.log)
 * @param {string} [opts.dir]         日志目录;缺省读 DSH_LOG_DIR
 * @param {string} [opts.level]       最低级别;缺省读 DSH_LOG_LEVEL
 * @param {number} [opts.maxBytes]    单文件上限;缺省读 DSH_LOG_MAX_MB(默认 10MB)
 * @param {number} [opts.keep]        保留历史文件数;缺省读 DSH_LOG_KEEP(默认 5)
 * @param {boolean} [opts.stdout]     是否同时写 stdout;缺省读 DSH_LOG_STDOUT(默认写)
 */
export function createLogger({ name = "app", dir, level, maxBytes, keep, stdout } = {}) {
  const logDir = resolveLogDir(dir);
  const minLevel = LEVELS[String(level ?? process.env.DSH_LOG_LEVEL ?? "info").toLowerCase()] ?? LEVELS.info;
  const limitBytes =
    Number(maxBytes) > 0
      ? Number(maxBytes)
      : Math.max(1, Number(process.env.DSH_LOG_MAX_MB || 10)) * 1024 * 1024;
  const keepCount = Number(keep) >= 0 ? Number(keep) : Math.max(0, Number(process.env.DSH_LOG_KEEP ?? 5));
  const toStdout = stdout ?? process.env.DSH_LOG_STDOUT !== "0";

  const filePath = logDir ? path.join(logDir, `${name}.log`) : null;
  /** 当前文件已写字节数(惰性初始化,避免每次 stat)。 */
  let written = null;
  /** 落盘失败后置位,避免每行都刷错误。 */
  let broken = false;
  let brokenReported = false;

  function ensureDir() {
    if (!logDir) return false;
    try {
      fs.mkdirSync(logDir, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  /** 首次写入时确定当前文件大小(追加到已有文件也能正确轮转)。 */
  function currentSize() {
    if (written !== null) return written;
    try {
      written = fs.statSync(filePath).size;
    } catch {
      written = 0;
    }
    return written;
  }

  /** x.log → x.log.1 → x.log.2 …;超出 keep 的删除。 */
  function rotate() {
    if (!filePath) return;
    try {
      if (keepCount <= 0) {
        fs.rmSync(filePath, { force: true });
      } else {
        fs.rmSync(`${filePath}.${keepCount}`, { force: true });
        for (let i = keepCount - 1; i >= 1; i--) {
          const from = `${filePath}.${i}`;
          if (fs.existsSync(from)) fs.renameSync(from, `${filePath}.${i + 1}`);
        }
        if (fs.existsSync(filePath)) fs.renameSync(filePath, `${filePath}.1`);
      }
      written = 0;
    } catch {
      /* 轮转失败不致命:继续往原文件追加 */
    }
  }

  /** 仅写文件(带时间戳/级别)。 */
  function toFile(levelName, text) {
    if (!filePath || broken) return;
    try {
      if (!ensureDir()) throw new Error("log dir unavailable");
      const line = `${stamp()} [${levelName.toUpperCase()}] ${text}\n`;
      if (currentSize() + Buffer.byteLength(line) > limitBytes) rotate();
      fs.appendFileSync(filePath, line);
      written = (written ?? 0) + Buffer.byteLength(line);
    } catch (e) {
      broken = true;
      if (!brokenReported) {
        brokenReported = true;
        process.stderr.write(`[logger] 落盘失败,已降级为仅 stdout(${filePath}): ${e.message}\n`);
      }
    }
  }

  function emit(levelName, args) {
    if (LEVELS[levelName] < minLevel) return;
    const text = args.map(safeText).join(" ");
    if (toStdout) process.stdout.write(text + "\n"); // 保持原文格式
    toFile(levelName, text); // 落盘那份带时间戳
  }

  return {
    debug: (...a) => emit("debug", a),
    info: (...a) => emit("info", a),
    warn: (...a) => emit("warn", a),
    error: (...a) => emit("error", a),
    /** 实际写入的文件路径;未启用文件日志时为 null。 */
    filePath
  };
}

export default createLogger;
