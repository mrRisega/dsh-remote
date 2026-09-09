#!/usr/bin/env node
/**
 * lib-native-e2ee.mjs — 测试共享:从 clients/dsh-web/native.html 抽取
 * 「DSH-E2EE-WC-CORE」纯 WebCrypto 区间,包装为 ESM 后 import(node ≥22 自带
 * globalThis.crypto.subtle / TextEncoder / atob / btoa / DecompressionStream)。
 *
 * 用途:手机端(浏览器 WebCrypto)与桥端(node:crypto e2ee-client.mjs)的
 * 字节级一致性对拍 / KAT / 端到端互通,全部用 native.html 里的真实代码,
 * 而不是在测试里再抄一份。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const NATIVE_HTML_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "dsh-web", "native.html"
);

export const CORE_START = "/* ===DSH-E2EE-WC-CORE-START===";
export const CORE_END = "/* ===DSH-E2EE-WC-CORE-END===";

/** 从 native.html 抽出纯原语区间(文本)。 */
export function extractNativeWcCore(html = readNativeHtml()) {
  const s = html.indexOf(CORE_START);
  const e = html.indexOf(CORE_END);
  if (s === -1 || e === -1 || e <= s) throw new Error("native.html 缺少 DSH-E2EE-WC-CORE 区间");
  const bodyStart = html.indexOf("\n", s) + 1;
  return html.slice(bodyStart, e).replace(/\n\s*$/, "");
}

// ---------- Phase-4 一次性交接单(DH-CORE)抽取 ----------
export const HANDOVER_START = "/* ===DSH-E2EE-HANDOVER-CORE-START===";
export const HANDOVER_END = "/* ===DSH-E2EE-HANDOVER-CORE-END===";

/** 从 native.html 抽出交接单纯函数区间(文本;依赖 wcBytesToB64,需与 WC-CORE 同模块)。 */
export function extractNativeHandoverCore(html = readNativeHtml()) {
  const s = html.indexOf(HANDOVER_START);
  const e = html.indexOf(HANDOVER_END);
  if (s === -1 || e === -1 || e <= s) throw new Error("native.html 缺少 DSH-E2EE-HANDOVER-CORE 区间");
  const bodyStart = html.indexOf("\n", s) + 1;
  return html.slice(bodyStart, e).replace(/\n\s*$/, "");
}

export function readNativeHtml() {
  return readFileSync(NATIVE_HTML_PATH, "utf8");
}

/** 需要暴露给测试/桥端互通的浏览器端名字(与 native.html 内声明一致)。 */
export const WC_EXPORTS = [
  "WC_ENVELOPE_CONTENT_TYPE", "WC_ENVELOPE_HEADER", "WC_E2EE_CAP", "WC_DIR_P2B", "WC_DIR_B2P",
  "WC_MK_BYTES", "WC_NONCE_BYTES", "WC_TAG_BYTES", "WC_E2EE_VERSION",
  "wcNormalizePassword", "wcB64ToBytes", "wcBytesToB64", "wcUtf8", "wcUtf8Decode",
  "wcDecodeSalt", "wcNormalizeKdf", "wcDeriveMasterKey", "wcHkdf", "wcDeriveShk",
  "wcNewSessId", "wcRandomB64", "wcRandomHex", "wcSha256Bytes",
  "WcE2eeSession", "wcErr",
  "wcDecodeHttpRequestPlain", "wcEncodeHttpRequestPlain",
  "wcDecodeHttpResponsePlain", "wcEncodeHttpResponsePlain", "wcGunzip",
  "wcParseWsE2eeParams", "wcEnvelopeHeaders", "wcParseEnvelopeMarker", "wcHasEnvelopeMarker", "wcHeaderValueOf"
];

let cached = null;

/** 抽取 + import(幂等缓存)。 */
export async function loadNativeWcCore(html) {
  if (cached) return cached;
  const core = extractNativeWcCore(html);
  const src = core + "\nexport { " + WC_EXPORTS.join(", ") + " };\n";
  const b64 = Buffer.from(src, "utf8").toString("base64");
  const mod = await import("data:text/javascript;base64," + b64);
  cached = mod;
  return mod;
}

export const HANDOVER_EXPORTS = [
  "DSH_E2EE_HANDOVER_KEY",
  "dshE2eeHandoverEncode",
  "dshE2eeHandoverWrite",
  "dshE2eeHandoverClear"
];

/** 抽取 native 交接单纯函数 + import(与 WC-CORE 同模块以复用 wcBytesToB64;幂等缓存)。 */
export async function loadNativeHandoverCore(html) {
  const core = extractNativeWcCore(html);
  const handover = extractNativeHandoverCore(html);
  const src =
    core + "\n" + handover +
    "\nexport { wcBytesToB64, " + HANDOVER_EXPORTS.join(", ") + " };\n";
  const b64 = Buffer.from(src, "utf8").toString("base64");
  const mod = await import("data:text/javascript;base64," + b64);
  return mod;
}
