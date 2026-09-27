// Web Push 推送核心：Agent 任务跑完后给手机发一条系统通知
//
// 协议栈（都在这里落地，供 proxy / service 直接复用）：
//   - RFC 8291 aes128gcm 消息加密：由 @block65/webcrypto-web-push 2.0.0（MIT，ESM，node>=22）
//     实现。它把明文补齐到固定 4096 字节（不泄露正文长度），body 就是可直接 POST 的密文。
//   - RFC 8292 VAPID：库的 `vapidHeaders` 用 ES256 签一个
//     { aud: endpoint origin, exp: now+12h, sub } 的 JWT，Authorization 头形如
//     `vapid t=<JWT>, k=<65 字节未压缩 P-256 公钥 base64url>`。
//
// 设计约定：
//   - 本模块只有纯逻辑 + 可注入的 fetch，import 时零副作用、不联网；
//   - 密钥/订阅的校验失败属于**配置问题**，不抛异常而是返回 { ok:false, reason:'config' }，
//     因为调用点在「任务完成」回调里，抛出去会打断正常流程；
//   - 订阅失效（404/410）用 shouldDelete=true 标记，调用方据此删掉本地订阅记录。
//
// 术语：endpoint 是推送服务（FCM/APNs/Mozilla）的地址；p256dh/auth 是浏览器
// `PushSubscription.toJSON()` 给的客户端公钥与认证密钥。

import { createECDH, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { buildPushPayload } from '@block65/webcrypto-web-push';
import { shortError } from './netcheck.mjs';

/** 默认 VAPID subject（RFC 8292 要求 mailto: 或 https: URL，推送服务用它联系站长）。 */
export const DEFAULT_PUSH_SUBJECT = 'mailto:admin@example.com';
/** 默认 TTL（秒）：手机离线时推送服务最多帮我们保留多久。 */
export const DEFAULT_TTL_SEC = 600;
/** 默认请求超时（毫秒）：推送服务卡住时不能把任务完成回调挂死。 */
export const DEFAULT_TIMEOUT_MS = 10000;
/** 库把明文补到 4096 字节，减去 21+65 字节头与 17 字节（0x02 分隔符 + GCM tag）。 */
export const MAX_PAYLOAD_BYTES = 3993;

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

function toBase64Url(buf) {
  return Buffer.from(buf).toString('base64url');
}

/** PEM 文本判定（VAPID 密钥可能来自 openssl 生成的 PEM 文件）。 */
function isPem(value) {
  return typeof value === 'string' && /-----BEGIN [A-Z ]+-----/.test(value);
}

/** 私钥标量 d（base64url，32 字节）→ 65 字节未压缩公钥点。 */
function publicPointFromScalar(privateKeyB64) {
  const raw = Buffer.from(privateKeyB64, 'base64url');
  if (raw.length !== 32) throw new Error('VAPID 私钥必须是 32 字节 base64url 标量 | VAPID private key must be a 32-byte base64url scalar');
  const ecdh = createECDH('prime256v1');
  try {
    ecdh.setPrivateKey(raw);
  } catch {
    throw new Error('VAPID 私钥不是合法的 P-256 标量 | invalid P-256 private scalar');
  }
  return ecdh.getPublicKey(); // 未压缩点 0x04 || X || Y
}

/** JWK (x,y) → 65 字节未压缩公钥点（base64url）。 */
function pointFromXy(x, y) {
  const xb = Buffer.from(String(x ?? ''), 'base64url');
  const yb = Buffer.from(String(y ?? ''), 'base64url');
  if (xb.length !== 32 || yb.length !== 32) {
    throw new Error('VAPID 公钥不是合法的 P-256 坐标 | invalid P-256 public key coordinates');
  }
  return Buffer.concat([Buffer.from([0x04]), xb, yb]);
}

/** 从 PEM（PKCS#8 / SEC1 私钥，或 SPKI 公钥）里取 { publicKey, privateKey }。 */
function pairFromPem(publicPem, privatePem) {
  let privateKeyB64;
  let publicPoint;
  if (privatePem) {
    const jwk = createPrivateKey(privatePem).export({ format: 'jwk' });
    if (!jwk?.d) throw new Error('PEM 里没有 EC 私钥 | PEM has no EC private key');
    privateKeyB64 = jwk.d;
    publicPoint = publicPointFromScalar(jwk.d); // 以私钥为准推导公钥，避免公/私不一致
  }
  if (publicPem) {
    const jwk = createPublicKey(publicPem).export({ format: 'jwk' });
    if (!jwk?.x || !jwk?.y) throw new Error('PEM 里没有 EC 公钥 | PEM has no EC public key');
    publicPoint = pointFromXy(jwk.x, jwk.y);
  }
  if (!privateKeyB64) throw new Error('VAPID 缺私钥（只给公钥 PEM 无法签名） | VAPID private key is required');
  return { publicKey: toBase64Url(publicPoint), privateKey: privateKeyB64 };
}

/**
 * 生成一对 VAPID 密钥（base64url）。
 *
 * @returns {{ publicKey: string, privateKey: string }} publicKey 为 65 字节未压缩 P-256 点，
 *   privateKey 为 32 字节标量 d；两者都是库直接接受的格式（它按 JWK 导入签名密钥）。
 */
export function generateVapidKeys() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' });
  return { publicKey: toBase64Url(publicPointFromScalar(jwk.d)), privateKey: jwk.d };
}

/**
 * 归一化 VAPID 密钥对，供 settings 持久化 / 从 settings 还原。
 *
 * 接受：`{ publicKey, privateKey }`（base64url 或 PEM）、库原生 VapidKeys（多一个 subject，忽略）、
 * 上面两种的 JSON 字符串、单个 PEM 私钥串、单个 base64url 私钥串。
 * 无参数（或空值）时等价于 `generateVapidKeys()`，方便设置页「一键生成」。
 *
 * 公钥一律由私钥重新推导：这样返回的公钥和私钥**保证匹配**（不匹配的输入直接抛错，
 * 而不是等到推送服务回 401 才发现）。
 *
 * @returns {{ publicKey: string, privateKey: string }} 均为无填充 base64url。
 */
export function buildVapidKeyPair(input) {
  if (input === undefined || input === null || input === '') return generateVapidKeys();
  let raw = input;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (isPem(text)) {
      raw = { privateKey: text };
    } else if (text.startsWith('{')) {
      try {
        raw = JSON.parse(text);
      } catch {
        throw new Error('VAPID 密钥 JSON 解析失败 | invalid VAPID key JSON');
      }
    } else {
      // 裸 base64url 私钥
      raw = { privateKey: text };
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('VAPID 密钥格式不对（需要 { publicKey, privateKey } / PEM / base64url） | invalid VAPID keys');
  }
  const publicField = raw.publicKey ?? raw.public_key ?? raw.vapidPublicKey;
  const privateField = raw.privateKey ?? raw.private_key ?? raw.vapidPrivateKey;
  if (isPem(publicField) || isPem(privateField)) {
    return pairFromPem(isPem(publicField) ? publicField : '', isPem(privateField) ? privateField : '');
  }
  const privateKey = typeof privateField === 'string' ? privateField.trim() : '';
  if (!privateKey) throw new Error('VAPID 缺私钥 | VAPID private key is required');
  if (!BASE64URL_RE.test(privateKey)) {
    throw new Error('VAPID 私钥必须是 base64url | VAPID private key must be base64url');
  }
  const canonicalPublic = toBase64Url(publicPointFromScalar(privateKey));
  const publicKey = typeof publicField === 'string' ? publicField.trim() : '';
  if (publicKey) {
    if (!BASE64URL_RE.test(publicKey)) {
      throw new Error('VAPID 公钥必须是 base64url | VAPID public key must be base64url');
    }
    if (Buffer.from(publicKey, 'base64url').length !== 65) {
      throw new Error('VAPID 公钥必须是 65 字节未压缩 P-256 点 | VAPID public key must be a 65-byte uncompressed P-256 point');
    }
    if (toBase64Url(Buffer.from(publicKey, 'base64url')) !== canonicalPublic) {
      throw new Error('VAPID 公钥与私钥不匹配 | VAPID public key does not match the private key');
    }
  }
  return { publicKey: canonicalPublic, privateKey };
}

/** createdAt 归一化为 ISO 字符串（数字按毫秒时间戳理解）。 */
function normalizeCreatedAt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  const text = String(value).trim();
  if (!text) return '';
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) throw new Error('订阅 createdAt 不是合法时间 | invalid subscription createdAt');
  return parsed.toISOString();
}

/** 解一个 base64url 字段并做长度校验。 */
function decodeBase64UrlField(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`订阅缺少 ${label} | missing ${label}`);
  if (!BASE64URL_RE.test(text)) throw new Error(`${label} 必须是 base64url（无 = 填充） | ${label} must be base64url`);
  return Buffer.from(text, 'base64url');
}

/**
 * 校验并归一化一条推送订阅（浏览器 `PushSubscription.toJSON()` 的形状）。
 *
 * @param {object|string} input `{ endpoint, keys:{ p256dh, auth }, ua?, createdAt? }` 或其 JSON 串。
 * @returns {{ endpoint: string, keys: { p256dh: string, auth: string }, ua?: string, createdAt?: string }}
 * @throws {Error} endpoint 非 https/非法 URL、p256dh 非 65 字节 0x04 开头点、auth 非 16 字节等，
 *   错误信息是给用户看的中英双语短句。
 */
export function normalizeSubscription(input) {
  let raw = input;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new Error('订阅不是合法 JSON | subscription is not valid JSON');
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('订阅必须是对象 | subscription must be an object');
  }
  const endpoint = String(raw.endpoint ?? '').trim();
  // 常见成因：浏览器没实现 PushSubscription.toJSON()（Safari 版本差异）导致客户端 POST 了 {}，
  // 或用户没允许通知。客户端已改为手工构造 endpoint+getKey，这里把话说清楚便于排查。
  if (!endpoint) throw new Error('订阅缺少 endpoint（浏览器没有返回推送端点：可能未允许通知，或浏览器不支持 Web Push） | subscription endpoint is required (browser returned none)');
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('订阅 endpoint 不是合法 URL | subscription endpoint is not a valid URL');
  }
  if (url.protocol !== 'https:') {
    throw new Error('订阅 endpoint 必须是 https | subscription endpoint must be https');
  }
  const keys = raw.keys && typeof raw.keys === 'object' ? raw.keys : {};
  const p256dh = decodeBase64UrlField(keys.p256dh, 'keys.p256dh');
  if (p256dh.length !== 65 || p256dh[0] !== 0x04) {
    throw new Error('keys.p256dh 必须是 65 字节未压缩 P-256 公钥 | keys.p256dh must be a 65-byte uncompressed P-256 point');
  }
  const auth = decodeBase64UrlField(keys.auth, 'keys.auth');
  if (auth.length !== 16) {
    throw new Error('keys.auth 必须是 16 字节 | keys.auth must be 16 bytes');
  }
  const out = { endpoint, keys: { p256dh: toBase64Url(p256dh), auth: toBase64Url(auth) } };
  const ua = raw.ua ?? raw.userAgent;
  if (typeof ua === 'string' && ua.trim()) out.ua = ua.trim().slice(0, 300);
  if (raw.createdAt !== undefined && raw.createdAt !== null) {
    const createdAt = normalizeCreatedAt(raw.createdAt);
    if (createdAt) out.createdAt = createdAt;
  }
  return out;
}

/**
 * 构造要发送的通知 JSON（加密前的明文），字段与 service worker 的解析约定一一对应：
 * SW 侧读 `title` / `body` / `url` / `tag`，点击时按 `url` 聚焦或打开窗口。
 *
 * @param {{ title?: string, body?: string, url?: string, tag?: string, sessionId?: string }} [input]
 * @returns {{ title: string, body: string, url: string, tag: string, sessionId?: string }}
 */
export function pushPayload({ title, body, url, tag, sessionId } = {}) {
  const finalTitle = String(title ?? '').trim() || 'DSH Pocket';
  const finalUrl = String(url ?? '').trim() || '/';
  const finalSession = String(sessionId ?? '').trim();
  const finalTag = String(tag ?? '').trim() || (finalSession ? `dsh-pocket:${finalSession}` : 'dsh-pocket');
  const payload = { title: finalTitle, body: String(body ?? ''), url: finalUrl, tag: finalTag };
  if (finalSession) payload.sessionId = finalSession;
  return payload;
}

function pushResult(ok, status, shouldDelete, error, reason) {
  return { ok, status, shouldDelete, error, reason };
}

/**
 * 给一条订阅发送推送。
 *
 * 返回形状固定为 `{ ok, status, shouldDelete, error, reason }`：
 *   - ok        2xx 视为送达；
 *   - status    HTTP 状态码（网络/超时失败为 0）；
 *   - shouldDelete 404/410（订阅已失效，调用方应删掉本地记录）；
 *   - error     可读错误（成功为 null）；
 *   - reason    null | 'gone' | 'payload-too-large' | 'rate-limited' | 'unauthorized'
 *               | 'http-error' | 'network' | 'timeout' | 'config'（413/429 靠它单独标注）。
 * 任何情况下都不抛异常：配置错误也返回 reason:'config'。
 *
 * @param {object|string} subscription 浏览器订阅对象或 normalizeSubscription 的结果。
 * @param {object|string} payloadObj 要发送的 JSON（一般来自 pushPayload）。
 * @param {object} [options] `{ fetchImpl, vapid, ttlSec, timeoutMs, subject, topic, urgency }`
 *   - fetchImpl 默认全局 fetch（可注入假实现做测试）；
 *   - vapid **必填**：`{ publicKey, privateKey }` 或它的 JSON 串（base64url/PEM 都行），
 *     一般直接来自 settings 里存的那份；缺了返回 reason:'config'；
 *   - subject VAPID 的联系方式（默认 mailto:admin@example.com），不是密钥对象里的字段。
 * @returns {Promise<{ ok: boolean, status: number, shouldDelete: boolean, error: string|null, reason: string|null }>}
 */
export async function sendPush(subscription, payloadObj, options = {}) {
  const {
    fetchImpl = fetch,
    vapid,
    ttlSec = DEFAULT_TTL_SEC,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    subject = DEFAULT_PUSH_SUBJECT,
    topic,
    urgency,
  } = options ?? {};

  if (typeof fetchImpl !== 'function') {
    return pushResult(false, 0, false, '没有可用的 fetch | fetch implementation is missing', 'config');
  }
  // 必须显式给 VAPID 密钥：缺了就直接报配置错，绝不偷偷现生成一对——
  // 那样签名用的公钥推送服务根本不认识，只会回 401/403，问题还特别难查。
  if (vapid === undefined || vapid === null || vapid === '') {
    return pushResult(false, 0, false, '缺少 VAPID 密钥（请先在设置里生成/保存） | VAPID keys are required', 'config');
  }
  let sub;
  let keys;
  try {
    sub = normalizeSubscription(subscription);
    keys = buildVapidKeyPair(vapid);
  } catch (err) {
    return pushResult(false, 0, false, err?.message ?? String(err), 'config');
  }

  let plaintext;
  try {
    plaintext = typeof payloadObj === 'string' ? payloadObj : JSON.stringify(payloadObj ?? {});
  } catch {
    return pushResult(false, 0, false, '推送内容无法序列化 | push payload is not serializable', 'config');
  }
  if (Buffer.byteLength(plaintext, 'utf8') > MAX_PAYLOAD_BYTES) {
    return pushResult(false, 0, false, `推送内容超过 ${MAX_PAYLOAD_BYTES} 字节上限 | push payload exceeds the ${MAX_PAYLOAD_BYTES}-byte limit`, 'payload-too-large');
  }

  // 加密 + VAPID 头（库内部生成随机 salt 与临时 ECDH 密钥，每次调用都不同）
  let request;
  try {
    request = await buildPushPayload(
      {
        data: payloadObj,
        options: { ttl: Number(ttlSec) > 0 ? Number(ttlSec) : DEFAULT_TTL_SEC, ...(topic ? { topic } : {}), ...(urgency ? { urgency } : {}) },
      },
      { endpoint: sub.endpoint, expirationTime: null, keys: sub.keys },
      { subject: String(subject ?? '').trim() || DEFAULT_PUSH_SUBJECT, publicKey: keys.publicKey, privateKey: keys.privateKey },
    );
  } catch (err) {
    return pushResult(false, 0, false, `推送加密/签名失败: ${err?.message ?? err} | encryption failed`, 'config');
  }

  const controller = new AbortController();
  const budget = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, budget);
  try {
    const response = await fetchImpl(sub.endpoint, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    });
    const status = Number(response?.status) || 0;
    if (status >= 200 && status < 300) return pushResult(true, status, false, null, null);
    if (status === 404 || status === 410) {
      return pushResult(false, status, true, `订阅已失效（HTTP ${status}），应从本地删除 | subscription is gone`, 'gone');
    }
    if (status === 413) {
      return pushResult(false, status, false, `推送内容被推送服务拒绝（HTTP 413，超过服务端上限） | payload too large`, 'payload-too-large');
    }
    if (status === 429) {
      return pushResult(false, status, false, `推送服务限流（HTTP 429），稍后重试 | rate limited`, 'rate-limited');
    }
    if (status === 401 || status === 403) {
      return pushResult(false, status, false, `推送被拒（HTTP ${status}），VAPID 密钥/订阅可能不匹配 | unauthorized`, 'unauthorized');
    }
    return pushResult(false, status, false, `推送服务返回 HTTP ${status} | push service error`, 'http-error');
  } catch (err) {
    if (timedOut || err?.name === 'AbortError' || err?.name === 'TimeoutError') {
      return pushResult(false, 0, false, `推送超时（${budget}ms 内未返回） | push request timed out`, 'timeout');
    }
    return pushResult(false, 0, false, `推送网络错误: ${shortError(err)} | network error`, 'network');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 给多条订阅群发同一条通知（顺序发送，避免同时打满推送服务）。
 *
 * `sent + removed + failed === results.length` 恒成立：
 *   sent 成功；removed 订阅失效需删除；failed 其它失败（含配置错误）。
 *
 * @param {Array} subscriptions 订阅数组（元素可以是原始对象或已归一化对象）。
 * @param {object} payloadObj 通知 JSON。
 * @param {object} [options] sendPush 的选项，外加 `onResult(entry)` 回调（逐条通知，回调抛错不影响统计）。
 * @returns {Promise<{ sent: number, removed: number, failed: number, results: Array }>}
 */
export async function pushToAll(subscriptions, payloadObj, options = {}) {
  const list = Array.isArray(subscriptions) ? subscriptions : [];
  const { onResult } = options ?? {};
  const results = [];
  let sent = 0;
  let removed = 0;
  let failed = 0;
  for (const item of list) {
    let outcome;
    try {
      outcome = await sendPush(item, payloadObj, options);
    } catch (err) {
      outcome = pushResult(false, 0, false, err?.message ?? String(err), 'config');
    }
    const endpoint = typeof item?.endpoint === 'string' ? item.endpoint : '';
    const entry = { ...outcome, endpoint };
    results.push(entry);
    if (outcome.ok) sent += 1;
    else if (outcome.shouldDelete) removed += 1;
    else failed += 1;
    if (typeof onResult === 'function') {
      try {
        await onResult(entry);
      } catch { /* 回调异常不影响统计 */ }
    }
  }
  return { sent, removed, failed, results };
}
