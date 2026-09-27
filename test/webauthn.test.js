// lib/webauthn.mjs 回归测试。
//
// 这里自己搭一个「软件认证器」：用 node:crypto 生成 P-256 密钥、按 WebAuthn 规格拼
// authData、再用测试内自带的最小 CBOR 编码器构造 attestationObject。
// 为什么值得这么麻烦：真正的通行密钥只能由真手机/真平台认证器产生，CI 里拿不到；
// 而这段代码的全部价值就是「校验到底有没有生效」，所以正例（DER 与 P1363 两种签名）
// 和负例（错挑战 / 错来源 / 错 rpId / UP=0 / 类型错 / 签名被改 / 计数器回退 / 算法不支持）
// 必须一样硬。
//
// 未验证（本环境做不到）：真设备（iPhone/Android/Windows Hello）产生的 attestation
// 与断言、真实证书链（x5c）、以及浏览器对 secure context / rpId 的约束。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ALG_ES256,
  coseToJwk,
  decodeCbor,
  decodeFirst,
  makeAuthenticationOptions,
  makeRegistrationOptions,
  verifyAuthentication,
  verifyRegistration,
} from '../lib/webauthn.mjs';
import { createPasskeyStore } from '../lib/passkey-store.mjs';

const RP_ID = 'pocket.example.com';
const ORIGIN = 'https://pocket.example.com';

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (buf) => createHash('sha256').update(buf).digest();
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };

/** 断言抛出带指定 code 的错误（错误码是给 HTTP 层映射状态码用的契约）。 */
function throwsCode(fn, code, hint = '') {
  assert.throws(fn, (err) => {
    assert.equal(err.code, code, `${hint} 期望 ${code}，实际 ${err.code}：${err.message}`);
    return true;
  });
}

// ---------- 最小 CBOR 编码器 ----------

function cborHead(major, len) {
  if (len < 24) return Buffer.from([(major << 5) | len]);
  if (len < 0x100) return Buffer.from([(major << 5) | 24, len]);
  if (len < 0x10000) return Buffer.concat([Buffer.from([(major << 5) | 25]), u16(len)]);
  return Buffer.concat([Buffer.from([(major << 5) | 26]), u32(len)]);
}

/** 只支持测试用得到的类型；Map 用来保留 COSE 的整数键。 */
function cbor(value) {
  if (Buffer.isBuffer(value)) return Buffer.concat([cborHead(2, value.length), value]);
  if (value instanceof Uint8Array) return cbor(Buffer.from(value));
  if (value instanceof Map) {
    const parts = [cborHead(5, value.size)];
    for (const [k, v] of value) parts.push(cbor(k), cbor(v));
    return Buffer.concat(parts);
  }
  if (Array.isArray(value)) return Buffer.concat([cborHead(4, value.length), ...value.map((v) => cbor(v))]);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`测试 CBOR 编码器只支持整数：${value}`);
    return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  }
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (value === true) return Buffer.from([0xf5]);
  if (value === false) return Buffer.from([0xf4]);
  if (value === null) return Buffer.from([0xf6]);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    return Buffer.concat([cborHead(5, entries.length), ...entries.flatMap(([k, v]) => [cbor(k), cbor(v)])]);
  }
  throw new Error(`测试 CBOR 编码器无法编码：${String(value)}`);
}

// ---------- 软件认证器 ----------

function coseKeyFromJwk(jwk, changes = {}) {
  const key = new Map([
    [1, 2], // kty: EC2
    [3, ALG_ES256], // alg: ES256
    [-1, 1], // crv: P-256
    [-2, Buffer.from(jwk.x, 'base64url')],
    [-3, Buffer.from(jwk.y, 'base64url')],
  ]);
  for (const [k, v] of Object.entries(changes)) key.set(Number(k), v);
  return key;
}

function buildAuthData({ rpId = RP_ID, flags = FLAG_UP | FLAG_AT, signCount = 0, credentialId = null, coseKey = null, aaguid = Buffer.alloc(16), extensions }) {
  const parts = [sha256(Buffer.from(rpId, 'utf8')), Buffer.from([flags]), u32(signCount)];
  if (flags & FLAG_AT) {
    if (!credentialId || !coseKey) throw new Error('测试构造错误：AT=1 时必须给 credentialId 与 COSE 公钥');
    parts.push(aaguid, u16(credentialId.length), credentialId, cbor(coseKey));
  }
  // ED=1 时追加扩展数据；不给 extensions 就一个字节都不加（用于构造「ED 标志位撒谎」的负例）
  if (flags & 0x80 && extensions !== undefined) parts.push(cbor(extensions));
  return Buffer.concat(parts);
}

function clientDataJSON({ type, challenge, origin = ORIGIN, crossOrigin = false }) {
  // 故意用非规范的键序 + 空格：签名覆盖的必须是 clientDataJSON 的**原始字节**。
  // 如果实现改成「解析后重新 JSON.stringify 再算哈希」，这里的字节就变了 → 正例会全红。
  return Buffer.from(`{ "origin": "${origin}", "challenge": "${challenge}", "type": "${type}", "crossOrigin": ${crossOrigin} }`, 'utf8');
}

function attestationObject({ fmt = 'none', authData, attStmt = new Map() }) {
  return cbor(new Map([['fmt', fmt], ['authData', authData], ['attStmt', attStmt]]));
}

function newKeyPair() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { ...pair, jwk: pair.publicKey.export({ format: 'jwk' }) };
}

/** 构造一次完整的注册 ceremony（可逐项覆盖以做负例）。 */
function registrationFixture(options = {}) {
  const {
    challenge = b64u(randomBytes(32)),
    origin = ORIGIN,
    rpId = RP_ID,
    type = 'webauthn.create',
    flags = FLAG_UP | FLAG_AT,
    signCount = 0,
    fmt = 'none',
    credentialId = randomBytes(16),
    aaguid = Buffer.alloc(16),
    keyPair = newKeyPair(),
  } = options;
  const authData = buildAuthData({
    rpId,
    flags,
    signCount,
    credentialId,
    coseKey: coseKeyFromJwk(keyPair.jwk, options.coseChanges),
    aaguid,
    extensions: options.extensions,
  });
  const clientData = clientDataJSON({ type, challenge, origin });
  const clientDataHash = sha256(clientData);
  let attStmt = options.attStmt;
  if (attStmt === undefined && fmt === 'packed') {
    // packed 自签名：用凭据私钥对 authData || clientDataHash 签名
    attStmt = new Map([
      ['alg', ALG_ES256],
      ['sig', cryptoSign('sha256', Buffer.concat([authData, clientDataHash]), { key: keyPair.privateKey, dsaEncoding: 'der' })],
    ]);
  }
  const attestation = attestationObject({ fmt, authData, attStmt: attStmt ?? new Map() });
  return { ...options, challenge, origin, rpId, type, flags, signCount, fmt, credentialId, aaguid, keyPair, authData, clientData, clientDataHash, attestation };
}

/** 用 fixture 调 verifyRegistration，可覆盖任意入参。 */
function verifyRegistrationFixture(fixture, overrides = {}) {
  return verifyRegistration({
    clientDataJSON: fixture.clientData,
    attestationObject: fixture.attestation,
    expectedChallenge: fixture.challenge,
    expectedOrigin: fixture.origin,
    rpId: fixture.rpId,
    ...overrides,
  });
}

/** 构造一次完整的断言 ceremony。 */
function assertionFixture(options = {}) {
  const {
    challenge = b64u(randomBytes(32)),
    origin = ORIGIN,
    rpId = RP_ID,
    type = 'webauthn.get',
    flags = FLAG_UP,
    signCount = 1,
    encoding = 'der',
    keyPair = newKeyPair(),
    signOver,
  } = options;
  const authData = buildAuthData({ rpId, flags, signCount });
  const clientData = clientDataJSON({ type, challenge, origin });
  const signedData = signOver ?? Buffer.concat([authData, sha256(clientData)]);
  const signature = cryptoSign('sha256', signedData, { key: keyPair.privateKey, dsaEncoding: encoding });
  return { ...options, challenge, origin, rpId, type, flags, signCount, keyPair, authData, clientData, signature };
}

function verifyAssertionFixture(fixture, overrides = {}) {
  return verifyAuthentication({
    authenticatorData: fixture.authData,
    clientDataJSON: fixture.clientData,
    signature: fixture.signature,
    expectedChallenge: fixture.challenge,
    expectedOrigin: fixture.origin,
    rpId: fixture.rpId,
    publicKeyJwk: fixture.keyPair.jwk,
    ...overrides,
  });
}

// ---------- CBOR ----------

test('CBOR：uint / negint / text / bytes / true / false / null', () => {
  assert.equal(decodeCbor(Buffer.from([0x00])), 0);
  assert.equal(decodeCbor(Buffer.from([0x17])), 23);
  assert.equal(decodeCbor(Buffer.from([0x18, 0x64])), 100);
  assert.equal(decodeCbor(Buffer.from([0x19, 0x01, 0x00])), 256);
  assert.equal(decodeCbor(Buffer.from([0x1a, 0x00, 0x01, 0x00, 0x00])), 65536);
  assert.equal(decodeCbor(Buffer.from([0x1b, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00])), 4294967296);
  assert.equal(decodeCbor(Buffer.from([0x20])), -1);
  assert.equal(decodeCbor(Buffer.from([0x37])), -24);
  assert.equal(decodeCbor(Buffer.from([0x38, 0x63])), -100);
  assert.equal(decodeCbor(Buffer.from('6449455446', 'hex')), 'IETF');
  assert.deepEqual(decodeCbor(Buffer.from('43010203', 'hex')), Buffer.from([1, 2, 3]));
  assert.equal(decodeCbor(Buffer.from([0xf5])), true);
  assert.equal(decodeCbor(Buffer.from([0xf4])), false);
  assert.equal(decodeCbor(Buffer.from([0xf6])), null);
  assert.equal(decodeCbor(Buffer.from([0xf7])), undefined);
  assert.equal(decodeCbor(cbor(new Map([['fmt', 'none']]))).fmt, 'none');
});

test('CBOR：嵌套 map / array / 字节串，整数键变字符串键', () => {
  const encoded = cbor(new Map([
    ['authData', Buffer.from('00010203', 'hex')],
    ['attStmt', new Map([['alg', ALG_ES256], ['x5c', [Buffer.from([0x30]), Buffer.from([0x31])]]])],
    ['list', [1, -2, 'three', null]],
  ]));
  const out = decodeCbor(encoded);
  assert.deepEqual(out.authData, Buffer.from('00010203', 'hex'));
  assert.equal(out.attStmt.alg, ALG_ES256);
  assert.equal(out.attStmt.x5c.length, 2);
  assert.ok(out.attStmt.x5c[0].equals(Buffer.from([0x30])));
  assert.deepEqual(out.list, [1, -2, 'three', null]);
  // COSE 公钥是整数键：解码后统一成字符串键（coseToJwk 两种都能读）
  const cose = decodeCbor(cbor(coseKeyFromJwk(newKeyPair().jwk)));
  assert.equal(cose['1'], 2);
  assert.equal(cose['3'], ALG_ES256);
  assert.equal(cose['-1'], 1);
  assert.equal(Buffer.isBuffer(cose['-2']), true);
});

test('CBOR：不定长 array / map / 字节串', () => {
  assert.deepEqual(decodeCbor(Buffer.from('9f0102ff', 'hex')), [1, 2]);
  const map = decodeCbor(Buffer.from('bf616101616202ff', 'hex'));
  assert.deepEqual(map, { a: 1, b: 2 });
  assert.deepEqual(decodeCbor(Buffer.from('5f4201024103ff', 'hex')), Buffer.from([1, 2, 3]));
  assert.deepEqual(decodeCbor(Buffer.from('7f6261626163ff', 'hex')), 'abc');
  assert.deepEqual(decodeCbor(Buffer.from('9f9f01ff02ff', 'hex')), [[1], 2]);
});

test('CBOR：decodeCbor 拒绝尾部多余字节，decodeFirst 容忍（attestationObject 可能带填充）', () => {
  const withTrailing = Buffer.from([0x01, 0x02, 0x03]);
  throwsCode(() => decodeCbor(withTrailing), 'ERR_CBOR', '严格模式');
  assert.equal(decodeFirst(withTrailing), 1, '宽松模式只解第一项');
});

test('CBOR：坏输入一律 ERR_CBOR（截断 / 标签 / 浮点 / break / 空输入 / 超范围整数 / 嵌套过深 / 非法键）', () => {
  throwsCode(() => decodeCbor(Buffer.alloc(0)), 'ERR_CBOR', '空输入');
  throwsCode(() => decodeCbor(Buffer.from('580501', 'hex')), 'ERR_CBOR', '字节串长度超出剩余数据');
  throwsCode(() => decodeCbor(Buffer.from('18', 'hex')), 'ERR_CBOR', '长度字段被截断');
  throwsCode(() => decodeCbor(Buffer.from([0xc0, 0x01])), 'ERR_CBOR', 'CBOR 标签');
  throwsCode(() => decodeCbor(Buffer.from('fb3ff0000000000000', 'hex')), 'ERR_CBOR', '浮点数');
  throwsCode(() => decodeCbor(Buffer.from([0xff])), 'ERR_CBOR', '裸 break');
  throwsCode(() => decodeCbor(Buffer.from('9f01', 'hex')), 'ERR_CBOR', '不定长数组没 break');
  throwsCode(() => decodeCbor(Buffer.from('1bffffffffffffffff', 'hex')), 'ERR_CBOR', '超出安全整数');
  throwsCode(() => decodeCbor(Buffer.concat(Array.from({ length: 40 }, () => Buffer.from([0x81])))), 'ERR_CBOR', '嵌套过深');
  throwsCode(() => decodeCbor(Buffer.from('a1810102', 'hex')), 'ERR_CBOR', 'map 键是数组');
});

test('CBOR：__proto__ 键不会污染原型（解码结果只新增自有属性）', () => {
  const out = decodeCbor(cbor(new Map([['__proto__', new Map([['polluted', true]])], ['ok', 1]])));
  assert.equal(Object.getPrototypeOf(out), Object.prototype, '原型没被替换');
  assert.equal({}.polluted, undefined, 'Object.prototype 没被污染');
  assert.equal(out.ok, 1);
  const desc = Object.getOwnPropertyDescriptor(out, '__proto__');
  assert.ok(desc && desc.value && desc.value.polluted === true, '__proto__ 只作为普通自有属性存在');
});

// ---------- COSE 公钥 ----------

test('coseToJwk：EC2 / P-256 / ES256 → JWK', () => {
  const { jwk } = newKeyPair();
  const cose = decodeCbor(cbor(coseKeyFromJwk(jwk)));
  assert.deepEqual(coseToJwk(cose), { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y });
  // Map 形态（真 CBOR 库常见）也要支持
  assert.deepEqual(coseToJwk(coseKeyFromJwk(jwk)), { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y });
});

test('coseToJwk：算法 / 曲线 / kty / 坐标不合法一律 ERR_ALG', () => {
  const { jwk } = newKeyPair();
  const rsaAlg = decodeCbor(cbor(coseKeyFromJwk(jwk, { 3: -257 })));
  throwsCode(() => coseToJwk(rsaAlg), 'ERR_ALG', 'RS256 不支持');
  const rsaKty = decodeCbor(cbor(coseKeyFromJwk(jwk, { 1: 3 })));
  throwsCode(() => coseToJwk(rsaKty), 'ERR_ALG', 'kty 不对');
  const p384 = decodeCbor(cbor(coseKeyFromJwk(jwk, { '-1': 2 })));
  throwsCode(() => coseToJwk(p384), 'ERR_ALG', '曲线不对');
  const noAlg = decodeCbor(cbor(new Map([[1, 2], [-1, 1], [-2, Buffer.alloc(32)], [-3, Buffer.alloc(32)]])));
  throwsCode(() => coseToJwk(noAlg), 'ERR_ALG', '缺 alg');
  const shortCoords = decodeCbor(cbor(coseKeyFromJwk(jwk, { '-2': Buffer.alloc(16) })));
  throwsCode(() => coseToJwk(shortCoords), 'ERR_ALG', '坐标长度不对');
  throwsCode(() => coseToJwk(null), 'ERR_ALG', '不是对象');
});

// ---------- 注册 ----------

test('注册正例：校验通过并返回 credentialId / 公钥 / 计数器 / aaguid / fmt', () => {
  const aaguid = Buffer.from('0102030405060708090a0b0c0d0e0f10', 'hex');
  const f = registrationFixture({ signCount: 0, aaguid, fmt: 'none' });
  const res = verifyRegistrationFixture(f);
  assert.equal(res.credentialId, b64u(f.credentialId), 'credentialId 以 base64url 返回');
  assert.deepEqual(res.publicKeyJwk, { kty: 'EC', crv: 'P-256', x: f.keyPair.jwk.x, y: f.keyPair.jwk.y });
  assert.equal(res.signCount, 0, '初始计数器');
  assert.equal(res.fmt, 'none');
  assert.equal(res.aaguid, '01020304-0506-0708-090a-0b0c0d0e0f10');
  assert.equal(res.userVerified, false, 'flags 没带 UV');
  assert.deepEqual(res.transports, [], '未提供 transports 时为空数组');
});

test('注册正例：UV=1 时 userVerified=true；要求 UV 而 UV=0 则拒绝', () => {
  const withUv = registrationFixture({ flags: FLAG_UP | FLAG_UV | FLAG_AT });
  const res = verifyRegistrationFixture(withUv, { requireUserVerification: true });
  assert.equal(res.userVerified, true);

  const noUv = registrationFixture({ flags: FLAG_UP | FLAG_AT });
  assert.equal(verifyRegistrationFixture(noUv).userVerified, false, '默认不强制 UV');
  throwsCode(() => verifyRegistrationFixture(noUv, { requireUserVerification: true }), 'ERR_FLAGS', '要求用户验证');
});

test('注册负例：挑战值 / 来源 / rpId / UP / type 各自对应稳定错误码', () => {
  const f = registrationFixture();
  throwsCode(() => verifyRegistrationFixture(f, { expectedChallenge: b64u(randomBytes(32)) }), 'ERR_CHALLENGE', '挑战值不符');
  throwsCode(() => verifyRegistrationFixture(f, { expectedOrigin: 'https://evil.example.com' }), 'ERR_ORIGIN', '来源不符');
  throwsCode(() => verifyRegistrationFixture(f, { rpId: 'evil.example.com' }), 'ERR_RPID', 'rpId 不符');
  throwsCode(() => verifyRegistrationFixture(f, { rpId: 'pocket.example.com:3081' }), 'ERR_RPID', 'rpId 带端口');
  assert.equal(verifyRegistrationFixture(f, { expectedOrigin: ['https://a.example.com', ORIGIN] }).fmt, 'none', '来源允许数组（多入口）');
  assert.equal(verifyRegistrationFixture(f, { expectedChallenge: `${f.challenge}==` }).fmt, 'none', '挑战值忽略 base64 补齐');
  assert.equal(verifyRegistrationFixture(f, { expectedChallenge: Buffer.from(f.challenge, 'base64url') }).fmt, 'none', '挑战值可给字节');

  const up0 = registrationFixture({ flags: FLAG_AT });
  throwsCode(() => verifyRegistrationFixture(up0), 'ERR_FLAGS', 'UP=0');
  const wrongType = registrationFixture({ type: 'webauthn.get' });
  throwsCode(() => verifyRegistrationFixture(wrongType), 'ERR_TYPE', 'type 不符');
  // 失败即拒绝：不传期望值不能等于跳过校验
  throwsCode(() => verifyRegistrationFixture(f, { expectedChallenge: undefined }), 'ERR_CHALLENGE', '缺 expectedChallenge');
  throwsCode(() => verifyRegistrationFixture(f, { expectedOrigin: undefined }), 'ERR_ORIGIN', '缺 expectedOrigin');
  throwsCode(() => verifyRegistrationFixture(f, { rpId: undefined }), 'ERR_RPID', '缺 rpId');
});

test('注册负例：结构问题（AT=0 / authData 截断 / CBOR 坏 / clientDataJSON 坏 / 算法不支持）', () => {
  const noAt = registrationFixture({ flags: FLAG_UP });
  throwsCode(() => verifyRegistrationFixture(noAt), 'ERR_ATTESTATION', '缺少 attestedCredentialData');

  const truncated = registrationFixture();
  const badAuth = truncated.attestation.subarray(0, 40); // 尾部被砍掉
  throwsCode(() => verifyRegistrationFixture(truncated, { attestationObject: badAuth }), 'ERR_CBOR', 'authData 里的 COSE 解不开');

  throwsCode(() => verifyRegistrationFixture(truncated, { attestationObject: Buffer.from([0xff]) }), 'ERR_CBOR', 'attestationObject 不是 CBOR');
  throwsCode(() => verifyRegistrationFixture(truncated, { clientDataJSON: Buffer.from('not json') }), 'ERR_CLIENT_DATA', 'clientDataJSON 不是 JSON');
  throwsCode(() => verifyRegistrationFixture(truncated, { clientDataJSON: Buffer.from('[]') }), 'ERR_CLIENT_DATA', 'clientDataJSON 不是对象');

  const rsa = registrationFixture({ coseChanges: { 3: -257 } });
  throwsCode(() => verifyRegistrationFixture(rsa), 'ERR_ALG', 'COSE 算法不支持');

  const shortAuthData = registrationFixture();
  throwsCode(
    () => verifyRegistrationFixture(shortAuthData, { attestationObject: attestationObject({ fmt: 'none', authData: Buffer.alloc(20) }) }),
    'ERR_CREDENTIAL',
    'authenticatorData 太短',
  );
});

test('注册：packed 自签 attestation 验签通过；签名被改则拒绝', () => {
  const ok = registrationFixture({ fmt: 'packed' });
  assert.equal(verifyRegistrationFixture(ok).fmt, 'packed');

  const tampered = registrationFixture({ fmt: 'packed' });
  tampered.attestation = attestationObject({
    fmt: 'packed',
    authData: tampered.authData,
    attStmt: new Map([
      ['alg', ALG_ES256],
      // 用同一把私钥签「别的数据」：验签必须失败
      ['sig', cryptoSign('sha256', Buffer.concat([tampered.authData, sha256(Buffer.from('别的数据'))]), { key: tampered.keyPair.privateKey, dsaEncoding: 'der' })],
    ]),
  });
  throwsCode(() => verifyRegistrationFixture(tampered), 'ERR_ATTESTATION', '自签 att 验签失败');

  const wrongAlg = registrationFixture({
    fmt: 'packed',
    attStmt: new Map([['alg', -257], ['sig', Buffer.from([1, 2, 3])]]),
  });
  throwsCode(() => verifyRegistrationFixture(wrongAlg), 'ERR_ALG', 'packed alg 非 ES256');
});

test('注册：packed 带 x5c 不校验证书链（只记 fmt），apple 需要 x5c，未知 fmt 拒绝', () => {
  const withX5c = registrationFixture({
    fmt: 'packed',
    attStmt: new Map([['alg', ALG_ES256], ['sig', Buffer.from([1, 2, 3])], ['x5c', [Buffer.from([0x30, 0x82])]]]),
  });
  assert.equal(verifyRegistrationFixture(withX5c).fmt, 'packed', '有 x5c 时按规格跳过链与自签校验');

  const apple = registrationFixture({ fmt: 'apple', attStmt: new Map([['x5c', [Buffer.from([0x30, 0x82])]]]) });
  assert.equal(verifyRegistrationFixture(apple).fmt, 'apple');
  const appleNoX5c = registrationFixture({ fmt: 'apple', attStmt: new Map() });
  throwsCode(() => verifyRegistrationFixture(appleNoX5c), 'ERR_ATTESTATION', 'apple 缺 x5c');

  const tpm = registrationFixture({ fmt: 'tpm' });
  throwsCode(() => verifyRegistrationFixture(tpm), 'ERR_ATTESTATION', 'fmt 不支持');

  const noneWithStmt = registrationFixture({ fmt: 'none', attStmt: new Map([['alg', ALG_ES256]]) });
  throwsCode(() => verifyRegistrationFixture(noneWithStmt), 'ERR_ATTESTATION', 'fmt=none 时 attStmt 必须为空');
});

test('注册：ED（扩展数据）标志位 —— 有数据要能解、撒谎说有的要报错', () => {
  // AT + ED 同时置位时，扩展数据必须从 COSE 公钥**之后**开始解（偏移算错就会误判）
  const withExt = registrationFixture({
    flags: FLAG_UP | FLAG_AT | 0x80,
    extensions: new Map([['credProtect', 2]]),
  });
  assert.equal(verifyRegistrationFixture(withExt).credentialId, b64u(withExt.credentialId));

  const lying = registrationFixture({ flags: FLAG_UP | FLAG_AT | 0x80 });
  throwsCode(() => verifyRegistrationFixture(lying), 'ERR_CBOR', 'ED=1 却没有扩展数据');
});

test('注册：transports 原样记录并去重；clientDataJSON 可以直接给 base64url', () => {
  const f = registrationFixture();
  const res = verifyRegistrationFixture(f, { transports: ['internal', 'hybrid', 'internal', ''] });
  assert.deepEqual(res.transports, ['internal', 'hybrid']);
  const viaB64 = verifyRegistrationFixture(f, { clientDataJSON: b64u(f.clientData) });
  assert.equal(viaB64.credentialId, res.credentialId, 'base64url 形态的 clientDataJSON 等价');
  const viaText = verifyRegistrationFixture(f, { clientDataJSON: f.clientData.toString('utf8') });
  assert.equal(viaText.credentialId, res.credentialId, '原始 JSON 文本形态也等价');
});

// ---------- 下发选项 ----------

test('makeRegistrationOptions：形状固定（只声明 ES256、可发现凭据、attestation=none）', () => {
  const challenge = b64u(randomBytes(32));
  const userId = randomBytes(16);
  const opts = makeRegistrationOptions({
    rpId: RP_ID,
    rpName: 'DSH Pocket',
    userId,
    userName: 'yuan',
    challenge,
  });
  assert.deepEqual(opts, {
    challenge,
    rp: { id: RP_ID, name: 'DSH Pocket' },
    user: { id: b64u(userId), name: 'yuan', displayName: 'yuan' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    timeout: 60000,
    attestation: 'none',
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    excludeCredentials: [],
  });
  assert.equal(ALG_ES256, -7, '导出的常量就是 COSE 的 ES256');
  assert.equal(makeRegistrationOptions({ rpId: RP_ID, rpName: undefined, userId: 'phone', challenge: Buffer.alloc(32, 7) }).challenge, b64u(Buffer.alloc(32, 7)));
  const excluded = makeRegistrationOptions({
    rpId: RP_ID,
    userId: 'phone',
    challenge,
    excludeCredentials: [{ id: 'cred-1', transports: ['internal'] }, 'cred-2'],
    timeoutMs: 120000,
  });
  assert.equal(excluded.timeout, 120000);
  assert.deepEqual(excluded.excludeCredentials, [
    { type: 'public-key', id: 'cred-1', transports: ['internal'] },
    { type: 'public-key', id: 'cred-2' },
  ]);
  assert.equal(excluded.rp.name, RP_ID, '没给 rpName 时回落到 rpId');
});

test('makeRegistrationOptions：缺 challenge / userId 或 rpId 非法时拒绝', () => {
  const base = { rpId: RP_ID, userId: 'phone', challenge: b64u(randomBytes(32)) };
  throwsCode(() => makeRegistrationOptions({ ...base, challenge: '' }), 'ERR_CHALLENGE', '缺 challenge');
  throwsCode(() => makeRegistrationOptions({ ...base, userId: '' }), 'ERR_CREDENTIAL', '缺 userId');
  assert.throws(() => makeRegistrationOptions({ ...base, rpId: 'example.com:443' }), (err) => err.code === 'ERR_RPID');
});

test('makeAuthenticationOptions：形状固定（rpId / allowCredentials / userVerification）', () => {
  const challenge = b64u(randomBytes(32));
  assert.deepEqual(makeAuthenticationOptions({ rpId: RP_ID, challenge }), {
    challenge,
    rpId: RP_ID,
    timeout: 60000,
    userVerification: 'preferred',
    allowCredentials: [],
  });
  const withCreds = makeAuthenticationOptions({
    rpId: RP_ID,
    challenge,
    allowCredentials: [{ id: 'cred-1', transports: ['hybrid'] }],
    timeoutMs: 30000,
    userVerification: 'required',
  });
  assert.equal(withCreds.timeout, 30000);
  assert.equal(withCreds.userVerification, 'required');
  assert.deepEqual(withCreds.allowCredentials, [{ type: 'public-key', id: 'cred-1', transports: ['hybrid'] }]);
  throwsCode(() => makeAuthenticationOptions({ rpId: RP_ID, challenge, userVerification: 'sure' }), 'ERR_FLAGS', 'userVerification 非法');
});

// ---------- 断言 ----------

test('断言正例：DER 签名通过、计数器前进、userVerified 反映 UV', () => {
  const f = assertionFixture({ signCount: 5, flags: FLAG_UP | FLAG_UV });
  const res = verifyAssertionFixture(f, { previousSignCount: 4 });
  assert.deepEqual(res, { newSignCount: 5, userVerified: true, counterAdvanced: true });
  assert.equal(Object.hasOwn(res, 'counterWarning'), false, '正常断言不该带告警字段');

  const first = verifyAssertionFixture(assertionFixture({ signCount: 0 }), { previousSignCount: 0 });
  assert.deepEqual(first, { newSignCount: 0, userVerified: false, counterAdvanced: false }, '首次断言、计数为 0 不算回退');

  const reg = registrationFixture();
  assert.equal(verifyRegistrationFixture(reg).publicKeyJwk.x, reg.keyPair.jwk.x, '注册得到的公钥可用于断言（同一把密钥）');
});

test('断言正例：P1363（64 字节）与 DER 两种签名编码都能验', () => {
  const der = assertionFixture({ encoding: 'der', signCount: 3 });
  const p1363 = assertionFixture({ encoding: 'ieee-p1363', signCount: 3, keyPair: der.keyPair });
  assert.equal(p1363.signature.length, 64, 'P1363 是 r||s 共 64 字节');
  assert.equal(verifyAssertionFixture(der, { previousSignCount: 2 }).newSignCount, 3);
  assert.equal(verifyAssertionFixture(p1363, { previousSignCount: 2 }).newSignCount, 3);
  // 同一份 authData/clientData 上，两种编码都必须成立（换编码不换数据）
  const samePayload = {
    ...der,
    signature: cryptoSign('sha256', Buffer.concat([der.authData, sha256(der.clientData)]), { key: der.keyPair.privateKey, dsaEncoding: 'ieee-p1363' }),
  };
  assert.equal(verifyAssertionFixture(samePayload, { previousSignCount: 2 }).newSignCount, 3);
});

test('断言负例：挑战值 / 来源 / rpId / UP / type 各自对应稳定错误码', () => {
  const f = assertionFixture({ signCount: 2 });
  throwsCode(() => verifyAssertionFixture(f, { expectedChallenge: b64u(randomBytes(32)) }), 'ERR_CHALLENGE', '挑战值不符');
  throwsCode(() => verifyAssertionFixture(f, { expectedOrigin: 'http://192.168.1.5:3081' }), 'ERR_ORIGIN', '来源不符');
  throwsCode(() => verifyAssertionFixture(f, { rpId: 'evil.example.com' }), 'ERR_RPID', 'rpId 不符');
  assert.equal(verifyAssertionFixture(f, { expectedOrigin: ['https://a.example.com', ORIGIN] }).newSignCount, 2);
  throwsCode(() => verifyAssertionFixture(f, { expectedChallenge: undefined }), 'ERR_CHALLENGE', '缺 expectedChallenge');

  const up0 = assertionFixture({ flags: 0, signCount: 2 });
  throwsCode(() => verifyAssertionFixture(up0), 'ERR_FLAGS', 'UP=0');
  const typeWrong = assertionFixture({ type: 'webauthn.create', signCount: 2 });
  throwsCode(() => verifyAssertionFixture(typeWrong), 'ERR_TYPE', 'type 不符');
  const uvRequired = assertionFixture({ flags: FLAG_UP, signCount: 2 });
  throwsCode(() => verifyAssertionFixture(uvRequired, { requireUserVerification: true }), 'ERR_FLAGS', '要求 UV 但未验证');
  throwsCode(() => verifyAssertionFixture(f, { publicKeyJwk: undefined }), 'ERR_ALG', '缺公钥');
  throwsCode(() => verifyAssertionFixture(f, { authenticatorData: Buffer.alloc(10) }), 'ERR_CREDENTIAL', 'authData 太短');
});

test('断言负例：公钥不是 P-256（P-384 / 乱码）→ ERR_ALG，不能靠换曲线把签名验过', () => {
  const f = assertionFixture({ signCount: 2 });
  const p384 = generateKeyPairSync('ec', { namedCurve: 'P-384' }).publicKey.export({ format: 'jwk' });
  throwsCode(() => verifyAssertionFixture(f, { publicKeyJwk: p384 }), 'ERR_ALG', 'P-384 公钥');
  throwsCode(() => verifyAssertionFixture(f, { publicKeyJwk: { kty: 'EC', crv: 'P-256', x: '!!', y: '!!' } }), 'ERR_ALG', '乱码公钥');
});

test('断言负例：签名被篡改 / 换私钥 / 签错数据一律 ERR_SIGNATURE', () => {
  const f = assertionFixture({ signCount: 2 });
  const tampered = { ...f, signature: Buffer.from(f.signature) };
  tampered.signature[tampered.signature.length - 1] ^= 0xff;
  throwsCode(() => verifyAssertionFixture(tampered), 'ERR_SIGNATURE', '签名被改');

  const otherKey = assertionFixture({ signCount: 2 });
  throwsCode(() => verifyAssertionFixture({ ...f, keyPair: otherKey.keyPair }), 'ERR_SIGNATURE', '公钥不匹配');

  const wrongData = assertionFixture({ signCount: 2, signOver: Buffer.from('随便什么数据') });
  throwsCode(() => verifyAssertionFixture(wrongData), 'ERR_SIGNATURE', '对别的数据签名');

  const noSig = assertionFixture({ signCount: 2 });
  throwsCode(() => verifyAssertionFixture({ ...noSig, signature: Buffer.alloc(0) }), 'ERR_SIGNATURE', '空签名');
  // authData 被改（rpIdHash 之外的部分）也必须失败
  const mutated = assertionFixture({ signCount: 2 });
  const mutatedAuth = Buffer.from(mutated.authData);
  mutatedAuth[32] ^= FLAG_UV;
  throwsCode(() => verifyAssertionFixture({ ...mutated, authData: mutatedAuth }), 'ERR_SIGNATURE', 'authData 被改');
});

test('断言负例：计数器回退拒绝；requireCounter:false 时降级为 counterWarning', () => {
  const same = assertionFixture({ signCount: 5 });
  throwsCode(() => verifyAssertionFixture(same, { previousSignCount: 5 }), 'ERR_COUNTER', '计数不变');
  const lower = assertionFixture({ signCount: 3 });
  throwsCode(() => verifyAssertionFixture(lower, { previousSignCount: 5 }), 'ERR_COUNTER', '计数后退');
  const tolerated = verifyAssertionFixture(lower, { previousSignCount: 5, requireCounter: false });
  assert.deepEqual(tolerated, { newSignCount: 3, userVerified: false, counterAdvanced: false, counterWarning: true });
});

test('断言：同步型通行密钥（计数器恒为 0）不被判成回退', () => {
  // iCloud 钥匙串 / Google 密码管理器的通行密钥永远上报 0：把它当回退会误伤合法用户
  const synced = assertionFixture({ signCount: 0 });
  const res = verifyAssertionFixture(synced, { previousSignCount: 7 });
  assert.deepEqual(res, { newSignCount: 0, userVerified: false, counterAdvanced: false }, 'newSignCount=0 时不做回退判定');
});

// ---------- 核心层端到端（两个模块的接口契约） ----------

test('端到端（核心层）：注册 → 存库 → 断言 → 发令牌 → 令牌鉴权 → 撤销', () => {
  const home = mkdtempSync(join(tmpdir(), 'dshp-passkey-e2e-'));
  try {
    const store = createPasskeyStore({ home });

    // 1) register/begin：服务端生成挑战值并下发选项
    const regOptions = makeRegistrationOptions({
      rpId: RP_ID,
      rpName: 'DSH Pocket',
      userId: randomBytes(16),
      userName: 'phone',
      challenge: randomBytes(32),
    });
    assert.equal(regOptions.rp.id, RP_ID);
    assert.equal(regOptions.attestation, 'none');

    // 2) register/finish：软件认证器按选项产出 attestation，服务端校验
    const ceremony = registrationFixture({ challenge: regOptions.challenge });
    const reg = verifyRegistration({
      clientDataJSON: ceremony.clientData,
      attestationObject: ceremony.attestation,
      expectedChallenge: regOptions.challenge,
      expectedOrigin: ORIGIN,
      rpId: regOptions.rp.id,
      transports: ['internal'],
    });

    // 3) 存库：verifyRegistration 的输出直接喂给 addCredential（字段一一对应）
    const entry = store.addCredential({
      credentialId: reg.credentialId,
      publicKeyJwk: reg.publicKeyJwk,
      name: 'iPhone',
      aaguid: reg.aaguid,
      transports: reg.transports,
      signCount: reg.signCount,
    });
    assert.equal(entry.id, reg.credentialId);

    // 4) login/begin：allowCredentials 只带 id
    const loginOptions = makeAuthenticationOptions({
      rpId: RP_ID,
      challenge: randomBytes(32),
      allowCredentials: store.list().map(({ id }) => ({ id })),
    });
    assert.deepEqual(loginOptions.allowCredentials, [{ type: 'public-key', id: reg.credentialId }]);

    // 5) login/finish：取库里的公钥验签，成功后推进计数器
    const assertion = assertionFixture({ challenge: loginOptions.challenge, signCount: 1, keyPair: ceremony.keyPair });
    const found = store.findCredential(reg.credentialId);
    const verified = verifyAuthentication({
      authenticatorData: assertion.authData,
      clientDataJSON: assertion.clientData,
      signature: assertion.signature,
      expectedChallenge: loginOptions.challenge,
      expectedOrigin: ORIGIN,
      rpId: loginOptions.rpId,
      publicKeyJwk: found.publicKeyJwk,
      previousSignCount: found.signCount,
    });
    assert.deepEqual(verified, { newSignCount: 1, userVerified: false, counterAdvanced: true });
    store.touchCredential(reg.credentialId, { signCount: verified.newSignCount });

    // 6) 记住设备：令牌写进 cookie，之后不再需要 PIN
    const { token } = store.issueDeviceToken({ deviceId: reg.credentialId, name: entry.name });
    assert.deepEqual(store.verifyDeviceToken(token), { deviceId: reg.credentialId, name: 'iPhone' });

    // 7) 电脑侧撤销：令牌与凭据一起失效（凭据还在就能重新断言换新令牌）
    store.revokeDevice(reg.credentialId);
    assert.equal(store.verifyDeviceToken(token), null, '撤销后设备令牌立刻失效');
    assert.equal(store.findCredential(reg.credentialId), null, '撤销后不能再断言');
    assert.deepEqual(store.list(), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
