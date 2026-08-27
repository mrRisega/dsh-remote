/**
 * relay-router — JWT 校验(与 relay-enterprise auth.js / dsh-gateway.mjs 同构,HS256,零依赖)
 *
 * 只做校验,不做签发。密钥从环境变量 DSH_ENTERPRISE_JWT_SECRET 读取(NAS .env),
 * 由 start.sh / --env-file 注入,绝不写死、不进 git。
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * 校验 HS256 JWT:签名(HMAC-SHA256,恒定时间比较)+ header alg + exp 过期检查。
 * @param {string} token
 * @param {string} secret
 * @returns {object|null} payload(sub/phone/email/plan/iat/exp/jti);无效或过期返回 null
 */
export function verifyJwt(token, secret) {
  if (typeof token !== "string" || token === "" || typeof secret !== "string" || secret === "") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const h = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
    if (h?.alg !== "HS256") return null;
  } catch {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload?.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}
