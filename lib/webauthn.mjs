// WebAuthn（通行密钥 / passkey）校验核心 —— 纯函数、零依赖、只用 node:crypto。
//
// 为什么不用 @simplewebauthn/server：
//   1) 本插件承诺零新增运行期依赖（离线安装、供应链面越小越好）；
//   2) 手机通行密钥这条路只需要 ES256（COSE alg -7）一条算法，
//      多一条算法路径就多一片攻击面，还要多写一份验签实现；
//   3) 真正要校验的只有五件事：挑战值、来源、rpIdHash、标志位、签名。
//      自己写反而更容易逐行审清楚「校验到底有没有生效」。
//
// 边界：本模块不做 IO、不管 cookie、不发 HTTP —— HTTP 路由与 cookie 集成在 lib/proxy.mjs。
// 失败一律抛 Error，并带稳定 `err.code`，HTTP 层一一映射到状态码：
//   ERR_CBOR        attestationObject / COSE 的 CBOR 解不开
//   ERR_CLIENT_DATA clientDataJSON 不是合法 JSON / 不是对象
//   ERR_TYPE        type 不是 webauthn.create（注册）或 webauthn.get（断言）
//   ERR_CHALLENGE   挑战值不匹配，或调用方没给 expectedChallenge（失败即拒绝）
//   ERR_ORIGIN      origin 不在允许列表，或调用方没给 expectedOrigin（失败即拒绝）
//   ERR_RPID        rpId 缺失/带端口，或 authData 里的 rpIdHash 与 rpId 不符
//   ERR_FLAGS       UP=0；或者 requireUserVerification 时 UV=0
//   ERR_ALG         不支持的 COSE 算法/曲线/kty，或公钥不可解析
//   ERR_ATTESTATION attestationObject 结构不合法、fmt 不支持、自签 attestation 验签失败
//   ERR_CREDENTIAL  authData 太短、缺 attestedCredentialData、credentialId 为空
//   ERR_SIGNATURE   断言签名验证失败
//   ERR_COUNTER     签名计数器回退（默认严格；requireCounter:false 时降级为 counterWarning）
//
// 二进制入参统一接受 Buffer / Uint8Array / ArrayBuffer，也接受 base64url 字符串
// —— 浏览器 `PublicKeyCredential.toJSON()` 给的就是 base64url，HTTP 层可以原样透传。
// clientDataJSON 例外地还接受「原始 JSON 文本」，方便测试与本地调试；但注意：
// 签名覆盖的是 clientDataJSON 的**原始字节**，调用方必须传浏览器给的字节（base64url 解码后），
// 自己重新 JSON.stringify 一遍（空格/键序不同）会让签名验证失败。

import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';

/** ES256（ECDSA P-256 + SHA-256）在 COSE 里的 alg 值。 */
export const ALG_ES256 = -7;

const COSE_KTY_EC2 = 2;
const COSE_CRV_P256 = 1;

// authData 标志位（WebAuthn §6.1）
const FLAG_UP = 0x01; // user present
const FLAG_UV = 0x04; // user verified
const FLAG_AT = 0x40; // attested credential data 存在
const FLAG_ED = 0x80; // extension data 存在

const AUTH_DATA_MIN = 37; // rpIdHash(32) + flags(1) + signCount(4)
const MAX_CBOR_DEPTH = 24; // 防住恶意深层嵌套把递归栈打爆

/** 构造带稳定错误码的 Error（消息保持「中文 | English」，与仓库其它模块一致）。 */
function fail(code, zh, en) {
  const err = new Error(en ? `${zh} | ${en}` : zh);
  err.code = code;
  return err;
}

// ---------- 入参归一化 ----------

/** 二进制入参 → Buffer。字符串按 base64url 处理（浏览器 toJSON() 的形态）。 */
function toBytes(value, fieldName) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (typeof value === 'string') {
    // 标准 base64 的 +/ 顺手兼容；'base64url' 解码本身是宽容的，解出垃圾后续会以更明确的错误码拒绝
    const s = value.trim().replace(/\+/g, '-').replace(/\//g, '_');
    return Buffer.from(s, 'base64url');
  }
  throw fail('ERR_CREDENTIAL', `${fieldName} 必须是 Buffer/Uint8Array/base64url 字符串`, `${fieldName} must be bytes or a base64url string`);
}

/** rpId 归一化：小写、去尾部点；带端口/斜杠说明调用方把 Host 当 rpId 用了，直接拒绝。 */
function normalizeRpId(rpId) {
  const id = String(rpId ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!id) throw fail('ERR_RPID', '缺少 rpId', 'missing rpId');
  if (id.includes(':')) throw fail('ERR_RPID', `rpId 必须是裸主机名（不带端口）：${id}`, `rpId must be a bare hostname: ${id}`);
  if (id.includes('/')) throw fail('ERR_RPID', `rpId 不能包含路径：${id}`, `rpId must not contain a path: ${id}`);
  return id;
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest();
}

/** base64url 归一化：去掉补齐的 '='，并把标准 base64 的 +/ 折算成 -_，用于挑战值比较。 */
function normalizeB64u(value) {
  return String(value ?? '').trim().replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 挑战值出参：字符串视为已经是 base64url（只做字符归一化），字节则编码成 base64url。 */
function challengeOut(challenge) {
  if (challenge instanceof Uint8Array || challenge instanceof ArrayBuffer) {
    return Buffer.from(challenge).toString('base64url');
  }
  const s = String(challenge ?? '').trim();
  if (!s) throw fail('ERR_CHALLENGE', '缺少 challenge', 'missing challenge');
  return normalizeB64u(s);
}

/** 期望挑战值入参：接受 base64url 字符串或原始字节；缺失即拒绝（绝不「跳过校验」）。 */
function expectedChallengeValue(expected) {
  const missing = fail('ERR_CHALLENGE', '缺少 expectedChallenge，拒绝校验', 'missing expectedChallenge — refusing to verify');
  if (expected == null || expected === '') throw missing;
  const b = expected instanceof Uint8Array || expected instanceof ArrayBuffer
    ? Buffer.from(expected).toString('base64url')
    : String(expected);
  const norm = normalizeB64u(b);
  if (!norm) throw missing;
  return norm;
}

function parseClientData(clientDataJSON) {
  let raw;
  if (typeof clientDataJSON === 'string' && clientDataJSON.trim().startsWith('{')) {
    raw = Buffer.from(clientDataJSON.trim(), 'utf8'); // 原始 JSON 文本（测试/调试便利通道）
  } else {
    raw = toBytes(clientDataJSON, 'clientDataJSON');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw fail('ERR_CLIENT_DATA', 'clientDataJSON 不是合法 JSON', 'clientDataJSON is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw fail('ERR_CLIENT_DATA', 'clientDataJSON 不是 JSON 对象', 'clientDataJSON is not a JSON object');
  }
  return { parsed, raw };
}

/** type 校验：注册与断言各用各的，防止拿一个 ceremony 的响应走另一条路径。 */
function checkClientDataType(parsed, expectedType) {
  if (parsed.type !== expectedType) {
    throw fail('ERR_TYPE', `clientDataJSON.type 必须是 ${expectedType}，实际 ${String(parsed.type)}`, `clientDataJSON.type must be ${expectedType}`);
  }
}

function checkChallenge(parsed, expectedChallenge) {
  const expected = expectedChallengeValue(expectedChallenge);
  if (typeof parsed.challenge !== 'string' || normalizeB64u(parsed.challenge) !== expected) {
    throw fail('ERR_CHALLENGE', '挑战值不匹配（可能已过期或被重放）', 'challenge mismatch');
  }
}

/** origin 精确匹配；expectedOrigin 允许数组（同一台机器可能同时有隧道域名与固定域名两个入口）。 */
function checkOrigin(parsed, expectedOrigin) {
  const list = Array.isArray(expectedOrigin) ? expectedOrigin : [expectedOrigin];
  const allowed = list.map((o) => String(o ?? '').trim().replace(/\/+$/, '').toLowerCase()).filter(Boolean);
  if (!allowed.length) {
    throw fail('ERR_ORIGIN', '缺少 expectedOrigin，拒绝校验', 'missing expectedOrigin — refusing to verify');
  }
  const actual = String(parsed.origin ?? '').trim().replace(/\/+$/, '').toLowerCase();
  if (!allowed.includes(actual)) {
    throw fail('ERR_ORIGIN', `origin 不匹配：${String(parsed.origin)} 不在允许列表`, 'origin mismatch');
  }
}

// ---------- 极简 CBOR 解码 ----------
// attestationObject 与 COSE 公钥都是 CBOR（RFC 8949）。只实现实际会遇到的部分：
// uint / negint / bytes / text / array / map / false / true / null / undefined，
// array、map、bytes、text 另外支持不定长；遇到标签（major 6）与浮点（major 7 的 25/26/27）
// 直接报错，因为 WebAuthn 这一路用不到它们 —— 宁可拒绝也不要「猜」。
// map 一律解成普通对象，键统一为字符串（COSE 的整数键 -1/-2/-3 变成 '-1'/'-2'/'-3'）。

/** 解第一个数据项，忽略尾部多余字节（attestationObject 允许尾部有填充）。 */
export function decodeFirst(buf) {
  return decodeItem(toBytes(buf, 'CBOR'), 0, 0).value;
}

/** 解且只解一个数据项；尾部还有字节视为错误（严格模式）。 */
export function decodeCbor(buf) {
  const bytes = toBytes(buf, 'CBOR');
  const { value, offset } = decodeItem(bytes, 0, 0);
  if (offset !== bytes.length) {
    throw fail('ERR_CBOR', `CBOR 尾部有 ${bytes.length - offset} 字节多余数据`, 'trailing bytes after CBOR item');
  }
  return value;
}

function readHead(buf, offset) {
  const ib = buf[offset];
  const major = ib >> 5;
  const info = ib & 0x1f;
  let p = offset + 1;
  let len;
  const shortOf = (n) => {
    if (p + n > buf.length) throw fail('ERR_CBOR', 'CBOR 数据意外结束（长度字段被截断）', 'unexpected end of CBOR data');
  };
  if (info < 24) {
    len = info;
  } else if (info === 24) {
    shortOf(1);
    len = buf[p];
    p += 1;
  } else if (info === 25) {
    shortOf(2);
    len = buf.readUInt16BE(p);
    p += 2;
  } else if (info === 26) {
    shortOf(4);
    len = buf.readUInt32BE(p);
    p += 4;
  } else if (info === 27) {
    shortOf(8);
    const big = buf.readBigUInt64BE(p);
    p += 8;
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw fail('ERR_CBOR', 'CBOR 整数超出 JS 安全整数范围', 'CBOR integer exceeds MAX_SAFE_INTEGER');
    }
    len = Number(big);
  } else if (info === 31) {
    len = -1; // 不定长
  } else {
    throw fail('ERR_CBOR', `不支持的 CBOR 附加信息 ${info}`, `unsupported CBOR additional info ${info}`);
  }
  return { major, info, len, offset: p };
}

function decodeDefiniteBytes(buf, from, len, what) {
  if (from + len > buf.length) {
    throw fail('ERR_CBOR', `CBOR ${what}声明 ${len} 字节，但只剩 ${buf.length - from}`, `CBOR ${what} truncated`);
  }
  return { value: Buffer.from(buf.subarray(from, from + len)), offset: from + len };
}

/** 不定长字节串/文本串：由若干定长块拼到 break(0xff) 为止。 */
function decodeIndefiniteString(buf, from, isText) {
  const parts = [];
  let p = from;
  for (;;) {
    if (p >= buf.length) throw fail('ERR_CBOR', 'CBOR 不定长字串没有 break 收尾', 'unterminated indefinite CBOR string');
    if (buf[p] === 0xff) {
      const joined = Buffer.concat(parts);
      return { value: isText ? joined.toString('utf8') : joined, offset: p + 1 };
    }
    const head = readHead(buf, p);
    if (head.major !== (isText ? 3 : 2) || head.len < 0) {
      throw fail('ERR_CBOR', 'CBOR 不定长字串里出现非法分块', 'invalid chunk in indefinite CBOR string');
    }
    const chunk = decodeDefiniteBytes(buf, head.offset, head.len, '分块');
    parts.push(chunk.value);
    p = chunk.offset;
  }
}

function decodeArray(buf, from, depth, indefinite, count) {
  const out = [];
  let p = from;
  if (indefinite) {
    for (;;) {
      if (p >= buf.length) throw fail('ERR_CBOR', 'CBOR 不定长数组没有 break 收尾', 'unterminated indefinite array');
      if (buf[p] === 0xff) return { value: out, offset: p + 1 };
      const item = decodeItem(buf, p, depth + 1);
      out.push(item.value);
      p = item.offset;
    }
  }
  for (let i = 0; i < count; i += 1) {
    const item = decodeItem(buf, p, depth + 1);
    out.push(item.value);
    p = item.offset;
  }
  return { value: out, offset: p };
}

function decodeMap(buf, from, depth, indefinite, count) {
  const out = {};
  let p = from;
  const readPair = () => {
    const k = decodeItem(buf, p, depth + 1);
    const v = decodeItem(buf, k.offset, depth + 1);
    mapSet(out, mapKeyToString(k.value), v.value);
    p = v.offset;
  };
  if (indefinite) {
    for (;;) {
      if (p >= buf.length) throw fail('ERR_CBOR', 'CBOR 不定长 map 没有 break 收尾', 'unterminated indefinite map');
      if (buf[p] === 0xff) return { value: out, offset: p + 1 };
      readPair();
    }
  }
  for (let i = 0; i < count; i += 1) readPair();
  return { value: out, offset: p };
}

/** map 的键只接受 text/uint/negint（COSE 用整数键，attestationObject 用文本键），一律转成字符串键。 */
function mapKeyToString(key) {
  if (typeof key === 'string') return key;
  if (typeof key === 'number' && Number.isSafeInteger(key)) return String(key);
  throw fail('ERR_CBOR', 'CBOR map 的键只支持文本或整数', 'unsupported CBOR map key type');
}

function mapSet(target, key, value) {
  // 用 defineProperty 而不是 target[key] = value：CBOR 可以带 "__proto__" 键，
  // 直接赋值会改掉原型（原型污染），defineProperty 只会新增一个自有属性。
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function decodeItem(buf, offset, depth) {
  if (depth > MAX_CBOR_DEPTH) throw fail('ERR_CBOR', 'CBOR 嵌套过深', 'CBOR nesting too deep');
  if (offset >= buf.length) throw fail('ERR_CBOR', 'CBOR 数据意外结束', 'unexpected end of CBOR data');
  if (buf[offset] === 0xff) throw fail('ERR_CBOR', 'CBOR 出现意外的 break 字节', 'unexpected CBOR break byte');
  const head = readHead(buf, offset);
  switch (head.major) {
    case 0:
      if (head.len < 0) throw fail('ERR_CBOR', 'CBOR 无符号整数不能是不定长', 'indefinite unsigned integer');
      return { value: head.len, offset: head.offset };
    case 1:
      if (head.len < 0) throw fail('ERR_CBOR', 'CBOR 负整数不能是不定长', 'indefinite negative integer');
      return { value: -1 - head.len, offset: head.offset };
    case 2:
      if (head.len < 0) return decodeIndefiniteString(buf, head.offset, false);
      return decodeDefiniteBytes(buf, head.offset, head.len, '字节串');
    case 3: {
      if (head.len < 0) return decodeIndefiniteString(buf, head.offset, true);
      const bytes = decodeDefiniteBytes(buf, head.offset, head.len, '文本串');
      return { value: bytes.value.toString('utf8'), offset: bytes.offset };
    }
    case 4:
      return decodeArray(buf, head.offset, depth, head.len < 0, head.len < 0 ? 0 : head.len);
    case 5:
      return decodeMap(buf, head.offset, depth, head.len < 0, head.len < 0 ? 0 : head.len);
    case 6:
      throw fail('ERR_CBOR', '不支持 CBOR 标签（major type 6）', 'unsupported CBOR tag');
    case 7:
      if (head.info === 20) return { value: false, offset: head.offset };
      if (head.info === 21) return { value: true, offset: head.offset };
      if (head.info === 22) return { value: null, offset: head.offset };
      if (head.info === 23) return { value: undefined, offset: head.offset };
      throw fail('ERR_CBOR', `不支持 CBOR 简单值/浮点（info ${head.info}）`, `unsupported CBOR simple value (info ${head.info})`);
    default:
      throw fail('ERR_CBOR', `不支持的 CBOR major type ${head.major}`, `unsupported CBOR major type ${head.major}`);
  }
}

// ---------- COSE 公钥 ----------

/** COSE key map 取值：解码结果是普通对象（整数键变字符串键），也兼容真 Map。 */
function coseGet(coseMap, key) {
  if (coseMap instanceof Map) return coseMap.get(key);
  if (coseMap && typeof coseMap === 'object') {
    const s = String(key);
    if (Object.prototype.hasOwnProperty.call(coseMap, s)) return coseMap[s];
    if (key in coseMap) return coseMap[key];
  }
  return undefined;
}

function coseBytes(coseMap, key) {
  const v = coseGet(coseMap, key);
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.from(v);
  if (typeof v === 'string') return Buffer.from(v, 'base64url');
  return null;
}

/**
 * COSE 公钥 map → JWK。只支持 EC2 / P-256 / ES256（-7）：
 * 浏览器给通行密钥用的就是它，其他算法一律拒绝而不是「先放行再说」。
 */
export function coseToJwk(coseMap) {
  if (!coseMap || typeof coseMap !== 'object') {
    throw fail('ERR_ALG', 'COSE 公钥不是对象', 'COSE key is not an object');
  }
  const kty = coseGet(coseMap, 1);
  const alg = coseGet(coseMap, 3);
  const crv = coseGet(coseMap, -1);
  if (alg !== ALG_ES256) {
    throw fail('ERR_ALG', `不支持的 COSE 算法 alg=${String(alg)}（只支持 ES256/-7）`, `unsupported COSE alg ${String(alg)}`);
  }
  if (kty !== COSE_KTY_EC2) {
    throw fail('ERR_ALG', `不支持的 COSE kty=${String(kty)}（只支持 EC2/2）`, `unsupported COSE kty ${String(kty)}`);
  }
  if (crv !== COSE_CRV_P256) {
    throw fail('ERR_ALG', `不支持的 COSE 曲线 crv=${String(crv)}（只支持 P-256/1）`, `unsupported COSE crv ${String(crv)}`);
  }
  const x = coseBytes(coseMap, -2);
  const y = coseBytes(coseMap, -3);
  if (!x || !y || x.length !== 32 || y.length !== 32) {
    throw fail('ERR_ALG', 'P-256 公钥坐标缺失或长度不对（应为 32 字节）', 'P-256 public key coordinates missing or of wrong length');
  }
  return { kty: 'EC', crv: 'P-256', x: x.toString('base64url'), y: y.toString('base64url') };
}

// ---------- authData 解析 ----------

function parseAuthenticatorData(authData, rpId) {
  if (authData.length < AUTH_DATA_MIN) {
    throw fail('ERR_CREDENTIAL', `authenticatorData 太短（${authData.length} < ${AUTH_DATA_MIN}）`, 'authenticatorData too short');
  }
  if (!authData.subarray(0, 32).equals(sha256(Buffer.from(rpId, 'utf8')))) {
    throw fail('ERR_RPID', `rpIdHash 与 rpId(${rpId}) 不符`, 'rpIdHash does not match rpId');
  }
  const flags = authData[32];
  const out = {
    flags,
    up: (flags & FLAG_UP) !== 0,
    uv: (flags & FLAG_UV) !== 0,
    at: (flags & FLAG_AT) !== 0,
    ed: (flags & FLAG_ED) !== 0,
    signCount: authData.readUInt32BE(33),
    aaguid: null,
    credentialId: null,
    coseKey: null,
  };
  let p = AUTH_DATA_MIN;
  if (out.at) {
    if (p + 18 > authData.length) {
      throw fail('ERR_CREDENTIAL', 'attestedCredentialData 被截断（缺 AAGUID/credentialId 长度）', 'attestedCredentialData truncated');
    }
    out.aaguid = Buffer.from(authData.subarray(p, p + 16));
    p += 16;
    const credIdLen = authData.readUInt16BE(p);
    p += 2;
    if (credIdLen === 0) throw fail('ERR_CREDENTIAL', 'credentialId 为空', 'empty credentialId');
    if (p + credIdLen > authData.length) {
      throw fail('ERR_CREDENTIAL', 'credentialId 被截断', 'credentialId truncated');
    }
    out.credentialId = Buffer.from(authData.subarray(p, p + credIdLen));
    p += credIdLen;
    // COSE 公钥就是 authData 尾部剩下的 CBOR map；要拿到它占用的字节数，
    // 后面的扩展数据（ED=1）才能从正确的偏移继续解。
    let keyItem;
    try {
      keyItem = decodeItem(authData, p, 0);
    } catch (err) {
      throw fail('ERR_CBOR', `authData 尾部 COSE 公钥解析失败：${err.message}`, 'COSE public key in authData failed to decode');
    }
    const key = keyItem.value;
    if (!key || typeof key !== 'object' || Array.isArray(key)) {
      throw fail('ERR_CREDENTIAL', 'authData 尾部没有 COSE 公钥', 'missing COSE public key in authData');
    }
    out.coseKey = key;
    p = keyItem.offset;
  }
  if (out.ed) {
    // 扩展数据我们不消费，但必须能解出来：解不开说明 authData 结构有问题，不能装作没看见。
    decodeFirst(authData.subarray(p));
  }
  return out;
}

function formatAaguid(buf) {
  const hex = (buf ?? Buffer.alloc(16)).toString('hex').padEnd(32, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function normalizeTransports(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()))];
}

function normalizeCredentialDescriptors(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw fail('ERR_CREDENTIAL', '凭据列表必须是数组', 'credential list must be an array');
  return list.map((c) => {
    const rawId = typeof c === 'string' ? c : c?.id;
    if (rawId == null || rawId === '') throw fail('ERR_CREDENTIAL', '凭据描述符缺少 id', 'credential descriptor missing id');
    const id = rawId instanceof Uint8Array || rawId instanceof ArrayBuffer
      ? Buffer.from(rawId).toString('base64url')
      : String(rawId).trim();
    const out = { type: 'public-key', id };
    const transports = normalizeTransports(c?.transports);
    if (transports.length) out.transports = transports;
    return out;
  });
}

// ---------- 签名验证 ----------

/** 只接受 P-256 公钥：这是唯一的算法入口，其它一律 ERR_ALG（宁可拒绝也不要「碰巧验过」）。 */
function publicKeyOf(publicKeyJwk) {
  if (!publicKeyJwk || typeof publicKeyJwk !== 'object') {
    throw fail('ERR_ALG', '缺少公钥（publicKeyJwk）', 'missing publicKeyJwk');
  }
  let key;
  try {
    key = createPublicKey({ key: publicKeyJwk, format: 'jwk' });
  } catch {
    throw fail('ERR_ALG', 'publicKeyJwk 无法解析为公钥', 'publicKeyJwk is not a usable public key');
  }
  // createPublicKey 也接受 RSA/P-384：这里显式挡住，避免 node 用另一种算法把签名验过
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw fail('ERR_ALG', `只支持 ES256（P-256）公钥，实际 ${key.asymmetricKeyType}/${key.asymmetricKeyDetails?.namedCurve ?? '?'}`, 'only ES256 (P-256) keys are supported');
  }
  return key;
}

function verifyEs256(data, signature, publicKeyJwk) {
  const key = publicKeyOf(publicKeyJwk);
  // WebAuthn 规定 ES256 签名是 DER，但实现里也会碰到 64 字节的 P1363（r||s）。
  // 两种都试：先试概率大的那种，避免把合法签名误判成伪造。
  const attempts = signature.length === 64 ? ['ieee-p1363', 'der'] : ['der', 'ieee-p1363'];
  for (const dsaEncoding of attempts) {
    try {
      if (cryptoVerify('sha256', data, { key, dsaEncoding }, signature)) return true;
    } catch { /* 长度/编码不符时 node 会抛错，等价于「这次尝试不成立」 */ }
  }
  return false;
}

// ---------- 注册（attestation） ----------

function readAttestationObject(attestationObject) {
  const bytes = toBytes(attestationObject, 'attestationObject');
  let decoded;
  try {
    decoded = decodeFirst(bytes);
  } catch (err) {
    throw fail('ERR_CBOR', `attestationObject CBOR 解析失败：${err.message}`, 'attestationObject CBOR decode failed');
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw fail('ERR_ATTESTATION', 'attestationObject 不是 CBOR map', 'attestationObject is not a CBOR map');
  }
  if (decoded.authData === undefined) {
    throw fail('ERR_ATTESTATION', 'attestationObject 缺少 authData', 'attestationObject has no authData');
  }
  const attStmt = decoded.attStmt && typeof decoded.attStmt === 'object' && !Array.isArray(decoded.attStmt) ? decoded.attStmt : {};
  return { fmt: String(decoded.fmt ?? ''), attStmt, authData: decoded.authData };
}

function verifyPackedAttestation(attStmt, publicKeyJwk, authDataBytes, clientDataHash) {
  if (attStmt.alg !== undefined && attStmt.alg !== ALG_ES256) {
    throw fail('ERR_ALG', `packed attestation 的 alg=${String(attStmt.alg)} 不受支持`, `unsupported packed attestation alg ${String(attStmt.alg)}`);
  }
  if (Array.isArray(attStmt.x5c) && attStmt.x5c.length > 0) {
    // 有 x5c = 厂商 attestation：校验证书链需要一份可信根列表（FIDO MDS），本插件不内置，
    // 因此只记录 fmt、不做链校验。安全性上不吃亏：真正把凭据绑到本次注册的是「挑战值 + 凭据公钥」，
    // attestation 只回答「是哪款认证器」，对自用插件没有实际价值。
    return;
  }
  if (attStmt.sig === undefined || attStmt.sig === null) {
    // 自签 attestation 但没给 sig：签名校验无处可做，等价于 fmt:'none'。
    // 这里没有可利用的空档 —— 凭据公钥仍然是在本次挑战值下由浏览器产生的。
    return;
  }
  const signature = toBytes(attStmt.sig, 'attStmt.sig');
  const signed = Buffer.concat([authDataBytes, clientDataHash]);
  if (!verifyEs256(signed, signature, publicKeyJwk)) {
    throw fail('ERR_ATTESTATION', 'packed 自签 attestation 验签失败', 'packed self-attestation signature invalid');
  }
}

/**
 * 校验注册响应（`navigator.credentials.create()` 的结果）。
 *
 * @param {object} input
 * @param {Buffer|Uint8Array|string} input.clientDataJSON base64url，或原始 JSON 文本
 * @param {Buffer|Uint8Array|string} input.attestationObject base64url，或字节
 * @param {string} input.expectedChallenge begin 阶段下发并保存在服务端的挑战值（base64url）
 * @param {string|string[]} input.expectedOrigin 允许的 origin（多入口就放数组）
 * @param {string} input.rpId 与 begin 阶段一致（= 访问域名，不带端口）
 * @param {boolean} [input.requireUserVerification=false]
 * @param {string[]} [input.transports] 浏览器 `response.getTransports()` 的结果，原样记录
 * @returns {{credentialId:string, publicKeyJwk:{kty:string,crv:string,x:string,y:string}, signCount:number, fmt:string, aaguid:string, userVerified:boolean, transports:string[]}}
 */
export function verifyRegistration({
  clientDataJSON,
  attestationObject,
  expectedChallenge,
  expectedOrigin,
  rpId,
  requireUserVerification = false,
  transports = [],
} = {}) {
  const rp = normalizeRpId(rpId);
  const { parsed: clientData, raw: clientDataRaw } = parseClientData(clientDataJSON);
  checkClientDataType(clientData, 'webauthn.create');
  checkChallenge(clientData, expectedChallenge);
  checkOrigin(clientData, expectedOrigin);

  const { fmt, attStmt, authData: rawAuthData } = readAttestationObject(attestationObject);
  const authDataBytes = toBytes(rawAuthData, 'attestationObject.authData');
  const authData = parseAuthenticatorData(authDataBytes, rp);
  if (!authData.up) throw fail('ERR_FLAGS', 'UP（用户在场）标志位为 0', 'user-present flag is not set');
  if (requireUserVerification && !authData.uv) {
    throw fail('ERR_FLAGS', 'UV（用户已验证）标志位为 0，但要求用户验证', 'user-verification required but flag is not set');
  }
  if (!authData.at) {
    throw fail('ERR_ATTESTATION', '缺少 attestedCredentialData（AT=0），注册响应不完整', 'missing attestedCredentialData (AT=0)');
  }
  const publicKeyJwk = coseToJwk(authData.coseKey);

  if (fmt === 'none') {
    if (Object.keys(attStmt).length > 0) {
      throw fail('ERR_ATTESTATION', 'fmt=none 时 attStmt 必须为空 map', 'attStmt must be empty when fmt is none');
    }
  } else if (fmt === 'packed') {
    verifyPackedAttestation(attStmt, publicKeyJwk, authDataBytes, sha256(clientDataRaw));
  } else if (fmt === 'apple') {
    // Apple 的 anonymous attestation：只有 x5c（证书链），sig 在证书里。
    // 同上，不校验证书链，但要求结构像样。
    if (!Array.isArray(attStmt.x5c) || attStmt.x5c.length === 0) {
      throw fail('ERR_ATTESTATION', 'fmt=apple 时 attStmt 必须带 x5c', 'fmt=apple requires x5c');
    }
  } else {
    throw fail('ERR_ATTESTATION', `不支持的 attestation 格式 fmt=${fmt}`, `unsupported attestation format ${fmt}`);
  }

  return {
    credentialId: authData.credentialId.toString('base64url'),
    publicKeyJwk,
    signCount: authData.signCount,
    fmt,
    aaguid: formatAaguid(authData.aaguid),
    userVerified: authData.uv,
    transports: normalizeTransports(transports),
  };
}

// ---------- 断言（登录） ----------

/**
 * 校验断言响应（`navigator.credentials.get()` 的结果）。
 *
 * @param {object} input
 * @param {Buffer|Uint8Array|string} input.authenticatorData base64url 或字节
 * @param {Buffer|Uint8Array|string} input.clientDataJSON base64url 或原始 JSON 文本
 * @param {Buffer|Uint8Array|string} input.signature base64url 或字节（DER / P1363 都接受）
 * @param {string} input.expectedChallenge
 * @param {string|string[]} input.expectedOrigin
 * @param {string} input.rpId
 * @param {{kty:string,crv:string,x:string,y:string}} input.publicKeyJwk 注册时记下的公钥
 * @param {number} [input.previousSignCount=0] 上次成功登录时的计数器
 * @param {boolean} [input.requireUserVerification=false]
 * @param {boolean} [input.requireCounter=true] 计数器回退是否直接拒绝
 * @returns {{newSignCount:number, userVerified:boolean, counterAdvanced:boolean, counterWarning?:boolean}}
 */
export function verifyAuthentication({
  authenticatorData,
  clientDataJSON,
  signature,
  expectedChallenge,
  expectedOrigin,
  rpId,
  publicKeyJwk,
  previousSignCount = 0,
  requireUserVerification = false,
  requireCounter = true,
} = {}) {
  const rp = normalizeRpId(rpId);
  const { parsed: clientData, raw: clientDataRaw } = parseClientData(clientDataJSON);
  checkClientDataType(clientData, 'webauthn.get');
  checkChallenge(clientData, expectedChallenge);
  checkOrigin(clientData, expectedOrigin);

  const authDataBytes = toBytes(authenticatorData, 'authenticatorData');
  const authData = parseAuthenticatorData(authDataBytes, rp);
  if (!authData.up) throw fail('ERR_FLAGS', 'UP（用户在场）标志位为 0', 'user-present flag is not set');
  if (requireUserVerification && !authData.uv) {
    throw fail('ERR_FLAGS', 'UV（用户已验证）标志位为 0，但要求用户验证', 'user-verification required but flag is not set');
  }
  const sig = toBytes(signature, 'signature');
  if (sig.length === 0) throw fail('ERR_SIGNATURE', '缺少签名', 'missing signature');

  // 签名覆盖：authenticatorData || SHA-256(clientDataJSON 原始字节)
  const signed = Buffer.concat([authDataBytes, sha256(clientDataRaw)]);
  if (!verifyEs256(signed, sig, publicKeyJwk)) {
    throw fail('ERR_SIGNATURE', 'ES256 验签失败（签名不匹配或数据被篡改）', 'ES256 signature verification failed');
  }

  const newSignCount = authData.signCount;
  const prev = Number.isFinite(previousSignCount) ? Math.max(0, Math.floor(previousSignCount)) : 0;
  const counterAdvanced = newSignCount > prev;
  // 计数器回退判定必须「两边都非 0」才成立：同步型通行密钥（iCloud 钥匙串/Google 密码管理器）
  // 永远上报 0，把它当回退会导致合法登录被拒。
  const suspect = prev !== 0 && newSignCount !== 0 && newSignCount <= prev;
  if (suspect && requireCounter !== false) {
    throw fail('ERR_COUNTER', `签名计数器回退（${prev} → ${newSignCount}），可能被克隆`, `signature counter regression (${prev} -> ${newSignCount})`);
  }
  const out = { newSignCount, userVerified: authData.uv, counterAdvanced };
  if (suspect) out.counterWarning = true;
  return out;
}

// ---------- 下发选项（begin） ----------

/** userId 一律当作原始字节处理成 base64url；字符串按 UTF-8 编码（服务端只把它当中不透明的句柄）。 */
function userIdOut(userId) {
  if (userId == null || userId === '') throw fail('ERR_CREDENTIAL', '缺少 userId', 'missing userId');
  if (userId instanceof Uint8Array || userId instanceof ArrayBuffer) return Buffer.from(userId).toString('base64url');
  const s = String(userId);
  if (!s) throw fail('ERR_CREDENTIAL', '缺少 userId', 'missing userId');
  return Buffer.from(s, 'utf8').toString('base64url');
}

function timeoutOut(timeoutMs) {
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : 60000;
}

/**
 * 生成注册选项（给前端 `navigator.credentials.create({ publicKey })`）。
 *
 * @param {object} input
 * @param {string} input.rpId 访问域名（不带端口）
 * @param {string} [input.rpName=rpId]
 * @param {string|Buffer|Uint8Array} input.userId 服务端生成的用户句柄（同一用户应稳定）
 * @param {string} [input.userName]
 * @param {string|Buffer|Uint8Array} input.challenge 随机挑战值（base64url 或字节）
 * @param {Array} [input.excludeCredentials=[]]
 * @param {number} [input.timeoutMs=60000]
 * @returns {object} PublicKeyCredentialCreationOptions（challenge/user.id/凭据 id 都是 base64url）
 */
export function makeRegistrationOptions({
  rpId,
  rpName,
  userId,
  userName,
  challenge,
  excludeCredentials = [],
  timeoutMs = 60000,
} = {}) {
  const rp = normalizeRpId(rpId);
  const name = String(userName ?? 'dsh-pocket');
  return {
    challenge: challengeOut(challenge),
    rp: { id: rp, name: String(rpName ?? rp) },
    user: { id: userIdOut(userId), name, displayName: name },
    // 只声明 ES256：声明了 -257 之类的算法就意味着还要实现对应验签，多一条路径多一份风险
    pubKeyCredParams: [{ type: 'public-key', alg: ALG_ES256 }],
    timeout: timeoutOut(timeoutMs),
    attestation: 'none',
    // residentKey: preferred → 手机把它存成「可发现的通行密钥」，下次不用先输用户名
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    excludeCredentials: normalizeCredentialDescriptors(excludeCredentials),
  };
}

/**
 * 生成断言选项（给前端 `navigator.credentials.get({ publicKey })`）。
 *
 * @param {object} input
 * @param {string} input.rpId
 * @param {string|Buffer|Uint8Array} input.challenge
 * @param {Array} [input.allowCredentials=[]] 通常来自 store.list()，只带 id
 * @param {number} [input.timeoutMs=60000]
 * @param {'required'|'preferred'|'discouraged'} [input.userVerification='preferred']
 * @returns {object} PublicKeyCredentialRequestOptions（challenge 为 base64url）
 */
export function makeAuthenticationOptions({
  rpId,
  challenge,
  allowCredentials = [],
  timeoutMs = 60000,
  userVerification = 'preferred',
} = {}) {
  const rp = normalizeRpId(rpId);
  if (!['required', 'preferred', 'discouraged'].includes(userVerification)) {
    throw fail('ERR_FLAGS', `userVerification 只能是 required/preferred/discouraged，实际 ${String(userVerification)}`, 'invalid userVerification');
  }
  return {
    challenge: challengeOut(challenge),
    rpId: rp,
    timeout: timeoutOut(timeoutMs),
    userVerification,
    allowCredentials: normalizeCredentialDescriptors(allowCredentials),
  };
}
