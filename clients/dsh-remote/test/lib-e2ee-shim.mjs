#!/usr/bin/env node
/**
 * lib-e2ee-shim.mjs — 测试共享:从 clients/dsh-remote/e2ee-shim-script.js 抽取
 * 「DSH-E2EE-SHIM-CORE」纯区间(浏览器 WebCrypto + 信封 + fetch/WS 包装逻辑),
 * 包装为 ESM 后 import(node ≥22 自带 crypto.subtle / atob / btoa / fetch / WS 所需全局)。
 *
 * 用途:镜像页 shim(Phase-4,注入到经隧道回传的官方 dsh web 文档)与桥端 e2ee-client.mjs、
 * native.html WC-CORE 的字节级一致性对拍 / KAT / mock 与真实 router+bridge 互通,全部用
 * 注入脚本里的真实代码,而不是在测试里再抄一份。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SHIM_SCRIPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "e2ee-shim-script.js"
);

export const SHIM_CORE_START = "/* ===DSH-E2EE-SHIM-CORE-START===";
export const SHIM_CORE_END = "/* ===DSH-E2EE-SHIM-CORE-END===";

export function readShimScript() {
  return readFileSync(SHIM_SCRIPT_PATH, "utf8");
}

/** 从 e2ee-shim-script.js 抽出纯核心区间(文本)。 */
export function extractShimCore(script = readShimScript()) {
  const s = script.indexOf(SHIM_CORE_START);
  const e = script.indexOf(SHIM_CORE_END);
  if (s === -1 || e === -1 || e <= s) throw new Error("e2ee-shim-script.js 缺少 DSH-E2EE-SHIM-CORE 区间");
  const bodyStart = script.indexOf("\n", s) + 1;
  return script.slice(bodyStart, e).replace(/\n\s*$/, "");
}

/** 需要暴露给测试的核心名字(与 e2ee-shim-script.js 内声明一致)。 */
export const SHIM_EXPORTS = [
  "SE_CT", "SE_HDR", "SE_DIR_P2B", "SE_DIR_B2P", "SE_NONCE_BYTES", "SE_TAG_BYTES", "SE_KEY_BYTES", "SE_VERSION",
  "DSH_E2EE_HANDOVER_KEY",
  "seErr", "seUtf8", "seUtf8Decode", "seB64ToBytes", "seBytesToB64",
  "seRandomBytes", "seRandomHex", "seHkdf", "SeSession", "seFailureHook", "seNotifyFail",
  "seEncodeHttpReqPlain", "seDecodeHttpRespPlain", "seEnvelopeHeaders", "seIsEnvelopeResponse", "seGunzip",
  "seUpstreamPathOf", "seShouldEncryptHttp", "seShouldEncryptWs", "seWsLabelParts", "seBuildWsTarget",
  "seHandoverDecode", "seSessionOfHandover",
  "seFetchWrapper", "SeE2eeWs", "seMakeWsCtor", "seBuildResponse", "seErrorResponse"
];

let cached = null;

/** 抽取 + import(幂等缓存)。 */
export async function loadShimCore() {
  if (cached) return cached;
  const core = extractShimCore();
  const src = core + "\nexport { " + SHIM_EXPORTS.join(", ") + " };\n";
  const b64 = Buffer.from(src, "utf8").toString("base64");
  const mod = await import("data:text/javascript;base64," + b64);
  cached = mod;
  return mod;
}
