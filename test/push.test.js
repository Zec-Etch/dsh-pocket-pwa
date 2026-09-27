// Web Push（lib/push.mjs）+ Webhook（lib/webhook.mjs）测试
//
// 最要紧的一条是「RFC 8291 解密回环」：测试里自己实现 aes128gcm 解密（ECDH + HKDF +
// AES-128-GCM + 去掉尾部 0x00 填充与 0x02 分隔符），用假 fetch 抓库生成的请求体，
// 再用测试持有的订阅私钥解回明文，断言它等于 pushPayload(...) 的 JSON。
// 只断言「HTTP 201」是不够的——密文错一点点，真机上的手机只会静默收不到通知。
//
// 运行：node --test --test-isolation=none --test-timeout=30000 test/push.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  verify as cryptoVerify,
  webcrypto,
} from 'node:crypto';
import {
  DEFAULT_PUSH_SUBJECT,
  MAX_PAYLOAD_BYTES,
  buildVapidKeyPair,
  generateVapidKeys,
  normalizeSubscription,
  pushPayload,
  pushToAll,
  sendPush,
} from '../lib/push.mjs';
import { WEBHOOK_PRESETS, buildWebhookRequest, dingtalkSign, sendWebhook } from '../lib/webhook.mjs';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const ping = 'https://fcm.googleapis.com/fcm/send/abc123';

/**
 * 测试自己实现的 RFC 2047 encoded-word 解码（只处理 `=?UTF-8?B?…?=`，独立于 lib 的编码实现）。
 * §6.2：相邻 encoded-word 之间的空白在解码时必须丢弃，否则长标题会被解出多余空格。
 */
function decodeHeaderWords(raw) {
  const text = String(raw ?? '');
  return text
    .replace(/\?=\s+=\?UTF-8\?B\?/gi, '?==?UTF-8?B?')
    .replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_match, payload) => Buffer.from(payload, 'base64').toString('utf8'));
}

/** 头值必须是可打印 ASCII（HTTP 头 = ByteString；undici 对非 ASCII 直接抛错）。 */
function assertHeaderValuesAscii(headers) {
  for (const [name, value] of Object.entries(headers ?? {})) {
    assert.match(String(value), /^[\x20-\x7E]*$/, `头 ${name} 必须只含可打印 ASCII，实际 ${JSON.stringify(value)}`);
  }
}

/** 造一条「浏览器侧」订阅：返回测试自己保管的私钥 + 浏览器会发出去的 JSON 形状。 */
function makeSubscription(endpoint = ping) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const p256dhBytes = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  const authBytes = randomBytes(16);
  return {
    endpoint,
    privateKey,
    p256dhBytes,
    authBytes,
    json: { endpoint, expirationTime: null, keys: { p256dh: b64u(p256dhBytes), auth: b64u(authBytes) } },
  };
}

/** 65 字节未压缩点 → KeyObject（测试独立构造，不沾 lib 的实现）。 */
function pointToKey(pointBytes, { d } = {}) {
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: b64u(pointBytes.subarray(1, 33)),
    y: b64u(pointBytes.subarray(33, 65)),
    ...(d ? { d } : {}),
  };
  return d ? createPrivateKey({ key: jwk, format: 'jwk' }) : createPublicKey({ key: jwk, format: 'jwk' });
}

/**
 * RFC 8291 §3.4 + RFC 8188 §2.1 解密：
 *   body = salt(16) || rs(4) || idlen(1) || keyid(idlen) || 密文
 *   IKM  = HKDF(salt=auth_secret, ikm=ecdh, info="WebPush: info\0" || ua_pub || as_pub, 32)
 *   CEK  = HKDF(salt=salt, ikm=IKM, info="Content-Encoding: aes128gcm\0", 16)
 *   nonce= HKDF(salt=salt, ikm=IKM, info="Content-Encoding: nonce\0", 12)
 */
function decryptAes128Gcm(body, sub) {
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const keyIdLength = body[20];
  const serverPublicBytes = body.subarray(21, 21 + keyIdLength);
  const ciphertext = body.subarray(21 + keyIdLength);
  assert.equal(serverPublicBytes.length, 65, '临时公钥应为 65 字节未压缩点');
  assert.equal(serverPublicBytes[0], 0x04);
  const shared = diffieHellman({ privateKey: sub.privateKey, publicKey: pointToKey(serverPublicBytes) });
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), sub.p256dhBytes, serverPublicBytes]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, sub.authBytes, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12));
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(tag);
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  let end = padded.length;
  while (end > 0 && padded[end - 1] === 0) end -= 1;
  assert.equal(padded[end - 1], 0x02, '最后一条记录必须有 0x02 分隔符');
  return { recordSize, keyIdLength, salt, plaintext: padded.subarray(0, end - 1) };
}

/** 假 fetch：记录调用并返回固定状态码。 */
function captureFetch(status = 201) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return { status, ok: status >= 200 && status < 300 };
  };
  return { calls, impl };
}

// ---------------------------------------------------------------- 加密回环

test('sendPush：请求体是合法 aes128gcm，能被订阅私钥解回原 JSON（关键）', async () => {
  const vapid = generateVapidKeys();
  const sub = makeSubscription();
  const payload = pushPayload({ title: '任务完成', body: '会话 abc 已结束', url: '/?session=abc', sessionId: 'abc' });
  const { calls, impl } = captureFetch(201);

  const result = await sendPush(sub.json, payload, { fetchImpl: impl, vapid, ttlSec: 600, subject: 'mailto:me@example.com' });
  assert.deepEqual(result, { ok: true, status: 201, shouldDelete: false, error: null, reason: null });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ping);
  assert.equal(calls[0].init.method, 'POST');

  // 头：RFC 8188 的 aes128gcm + TTL + 长度
  assert.equal(calls[0].init.headers['content-encoding'], 'aes128gcm');
  assert.equal(calls[0].init.headers.ttl, '600');
  assert.equal(calls[0].init.headers['content-type'], 'application/octet-stream');

  const body = Buffer.from(calls[0].init.body);
  assert.equal(body.length, 4096, '库把明文补齐到固定 4096 字节');
  assert.equal(body.length, Number(calls[0].init.headers['content-length']));

  const decrypted = decryptAes128Gcm(body, sub);
  assert.equal(decrypted.recordSize, 4096);
  assert.equal(decrypted.keyIdLength, 65);
  // 明文必须逐字节等于我们要发的 JSON
  assert.equal(decrypted.plaintext.toString('utf8'), JSON.stringify(payload));
  assert.deepEqual(JSON.parse(decrypted.plaintext.toString('utf8')), payload);
});

test('sendPush：两条订阅/两次发送的 salt 与临时密钥都不同（不重用）', async () => {
  const vapid = generateVapidKeys();
  const a = makeSubscription();
  const b = makeSubscription();
  const payload = pushPayload({ title: 'x' });
  const first = captureFetch(201);
  const second = captureFetch(201);
  const third = captureFetch(201);
  await sendPush(a.json, payload, { fetchImpl: first.impl, vapid });
  await sendPush(a.json, payload, { fetchImpl: second.impl, vapid });
  await sendPush(b.json, payload, { fetchImpl: third.impl, vapid });

  const bodyOf = (c) => Buffer.from(c.calls[0].init.body);
  assert.notEqual(bodyOf(first).subarray(0, 16).toString('hex'), bodyOf(second).subarray(0, 16).toString('hex'), 'salt 应随机');
  assert.notEqual(bodyOf(first).subarray(21, 86).toString('hex'), bodyOf(second).subarray(21, 86).toString('hex'), '临时公钥应随机');
  // 三条都能各自解开
  assert.equal(decryptAes128Gcm(bodyOf(first), a).plaintext.toString('utf8'), JSON.stringify(payload));
  assert.equal(decryptAes128Gcm(bodyOf(second), a).plaintext.toString('utf8'), JSON.stringify(payload));
  assert.equal(decryptAes128Gcm(bodyOf(third), b).plaintext.toString('utf8'), JSON.stringify(payload));
});

// ---------------------------------------------------------------- VAPID

test('sendPush：Authorization 是 vapid 头，k= 为 65 字节公钥，JWT 用 ES256 签对', async () => {
  const vapid = generateVapidKeys();
  const sub = makeSubscription();
  const { calls, impl } = captureFetch(201);
  const before = Math.floor(Date.now() / 1000);
  await sendPush(sub.json, pushPayload({ title: 't' }), { fetchImpl: impl, vapid, subject: 'mailto:owner@example.com' });

  const authz = calls[0].init.headers.authorization;
  assert.equal(typeof authz, 'string');
  const matched = /^vapid t=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+), k=([A-Za-z0-9_-]+)$/.exec(authz);
  assert.ok(matched, `Authorization 形状应为 "vapid t=<jwt>, k=<pubkey>"，实际: ${authz}`);

  const publicKeyBytes = Buffer.from(matched[2], 'base64url');
  assert.equal(publicKeyBytes.length, 65, 'k= 必须是 65 字节未压缩 P-256 公钥');
  assert.equal(publicKeyBytes[0], 0x04);
  assert.equal(matched[2], vapid.publicKey, 'k= 就是配置里的公钥');

  const [header, claims, signature] = matched[1].split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString('utf8')), { typ: 'JWT', alg: 'ES256' });
  const parsed = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8'));
  assert.equal(parsed.aud, new URL(ping).origin, 'aud 必须是 endpoint 的 origin（RFC 8292）');
  assert.equal(parsed.sub, 'mailto:owner@example.com');
  assert.ok(parsed.exp > before, 'exp 必须还没过期');
  assert.ok(parsed.exp - before <= 24 * 3600 + 60, 'exp 不应超过一天');

  const verified = cryptoVerify(
    'sha256',
    Buffer.from(`${header}.${claims}`),
    { key: pointToKey(publicKeyBytes), dsaEncoding: 'ieee-p1363' },
    Buffer.from(signature, 'base64url'),
  );
  assert.equal(verified, true, 'JWT 签名必须能被公钥验过（否则推送服务回 401/403）');
});

test('sendPush：换 VAPID 密钥不匹配时直接报 config（不静默发错签名）', async () => {
  const a = generateVapidKeys();
  const b = generateVapidKeys();
  const sub = makeSubscription();
  const { calls, impl } = captureFetch(201);
  const result = await sendPush(sub.json, pushPayload({ title: 't' }), { fetchImpl: impl, vapid: { publicKey: b.publicKey, privateKey: a.privateKey } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'config');
  assert.match(result.error, /不匹配/);
  assert.equal(calls.length, 0, '配置错误时不应该发出请求');
});

// ---------------------------------------------------------------- 发送结果分类

test('sendPush：2xx 成功 / 404、410 标记 shouldDelete', async () => {
  const vapid = generateVapidKeys();
  const sub = makeSubscription();
  const payload = pushPayload({ title: 't' });
  for (const status of [200, 201, 202]) {
    const { impl } = captureFetch(status);
    const r = await sendPush(sub.json, payload, { fetchImpl: impl, vapid });
    assert.equal(r.ok, true, `HTTP ${status} 应视为成功`);
    assert.equal(r.status, status);
    assert.equal(r.shouldDelete, false);
    assert.equal(r.error, null);
  }
  for (const status of [404, 410]) {
    const { impl } = captureFetch(status);
    const r = await sendPush(sub.json, payload, { fetchImpl: impl, vapid });
    assert.equal(r.ok, false);
    assert.equal(r.status, status);
    assert.equal(r.shouldDelete, true, `HTTP ${status} 表示订阅已失效`);
    assert.equal(r.reason, 'gone');
  }
});

test('sendPush：413 / 429 / 5xx / 401 分开标注', async () => {
  const vapid = generateVapidKeys();
  const sub = makeSubscription();
  const payload = pushPayload({ title: 't' });
  const cases = [
    [413, 'payload-too-large', false],
    [429, 'rate-limited', false],
    [500, 'http-error', false],
    [401, 'unauthorized', false],
    [403, 'unauthorized', false],
  ];
  for (const [status, reason, shouldDelete] of cases) {
    const { impl } = captureFetch(status);
    const r = await sendPush(sub.json, payload, { fetchImpl: impl, vapid });
    assert.equal(r.ok, false, `HTTP ${status} 不应算成功`);
    assert.equal(r.status, status);
    assert.equal(r.reason, reason);
    assert.equal(r.shouldDelete, shouldDelete);
    assert.ok(r.error && r.error.length > 0);
  }
});

test('sendPush：网络异常不抛，返回 reason=network', async () => {
  const vapid = generateVapidKeys();
  const sub = makeSubscription();
  const boom = async () => {
    throw Object.assign(new Error('getaddrinfo ENOTFOUND fcm.googleapis.com'), { code: 'ENOTFOUND' });
  };
  const r = await sendPush(sub.json, pushPayload({ title: 't' }), { fetchImpl: boom, vapid });
  assert.equal(r.ok, false);
  assert.equal(r.status, 0);
  assert.equal(r.shouldDelete, false);
  assert.equal(r.reason, 'network');
  assert.match(r.error, /ENOTFOUND/);
});

test('sendPush：timeoutMs 到点用 AbortController 中断，不永久挂住', async () => {
  const vapid = generateVapidKeys();
  const sub = makeSubscription();
  let sawSignal = null;
  let aborted = false;
  const hang = (url, init) =>
    new Promise((resolve, reject) => {
      sawSignal = init.signal;
      init.signal.addEventListener('abort', () => {
        aborted = true;
        reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      });
    });
  const started = Date.now();
  const r = await sendPush(sub.json, pushPayload({ title: 't' }), { fetchImpl: hang, vapid, timeoutMs: 80 });
  const elapsed = Date.now() - started;
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'timeout');
  assert.equal(r.status, 0);
  assert.ok(sawSignal instanceof AbortSignal, '请求必须带上 AbortSignal');
  assert.equal(aborted, true, '超时后必须真的 abort');
  assert.ok(elapsed < 2000, `超时应在预算内结束，实际 ${elapsed}ms`);
});

test('sendPush：超过 3993 字节的内容在本地就拒绝，不发请求', async () => {
  const vapid = generateVapidKeys();
  const sub = makeSubscription();
  const { calls, impl } = captureFetch(201);
  const r = await sendPush(sub.json, { title: 'x'.repeat(MAX_PAYLOAD_BYTES + 100) }, { fetchImpl: impl, vapid });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'payload-too-large');
  assert.equal(calls.length, 0);
});

test('sendPush：非法订阅/缺 VAPID 密钥只返回 config，不抛异常', async () => {
  const vapid = generateVapidKeys();
  const sub = makeSubscription();
  const payload = pushPayload({ title: 't' });
  const badSub = await sendPush({ endpoint: 'http://fcm.googleapis.com/x', keys: {} }, payload, { fetchImpl: captureFetch(201).impl, vapid });
  assert.equal(badSub.ok, false);
  assert.equal(badSub.reason, 'config');
  const noKeys = await sendPush(sub.json, payload, { fetchImpl: captureFetch(201).impl });
  assert.equal(noKeys.ok, false);
  assert.equal(noKeys.reason, 'config');
  assert.match(noKeys.error, /VAPID/);
  const noFetch = await sendPush(sub.json, payload, { fetchImpl: null, vapid });
  assert.equal(noFetch.ok, false);
  assert.equal(noFetch.reason, 'config');
});

test('sendPush：ttl 与 payload 可以是字符串（SW 续订等场景）', async () => {
  const vapid = generateVapidKeys();
  const sub = makeSubscription();
  const { calls, impl } = captureFetch(201);
  const r = await sendPush(sub.json, JSON.stringify({ title: 'string-payload' }), { fetchImpl: impl, vapid, ttlSec: 30 });
  assert.equal(r.ok, true);
  assert.equal(calls[0].init.headers.ttl, '30');
  assert.equal(decryptAes128Gcm(Buffer.from(calls[0].init.body), sub).plaintext.toString('utf8'), '{"title":"string-payload"}');
});

// ---------------------------------------------------------------- pushToAll

test('pushToAll：sent/removed/failed 统计 + onResult + 逐条 endpoint', async () => {
  const vapid = generateVapidKeys();
  const ok = makeSubscription('https://fcm.googleapis.com/fcm/send/ok');
  const gone = makeSubscription('https://updates.push.services.mozilla.com/wpush/v2/gone');
  const broken = makeSubscription('https://fcm.googleapis.com/fcm/send/broken');
  const table = {
    [ok.endpoint]: 201,
    [gone.endpoint]: 410,
    [broken.endpoint]: 500,
  };
  const calls = [];
  const impl = async (url, init) => {
    calls.push(url);
    return { status: table[url], ok: table[url] >= 200 && table[url] < 300 };
  };
  const seen = [];
  const summary = await pushToAll([ok.json, gone.json, broken.json], pushPayload({ title: 'done' }), {
    fetchImpl: impl,
    vapid,
    onResult: (entry) => seen.push(entry),
  });
  assert.equal(summary.sent, 1);
  assert.equal(summary.removed, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.results.length, 3);
  assert.equal(summary.sent + summary.removed + summary.failed, summary.results.length);
  assert.deepEqual(calls, [ok.endpoint, gone.endpoint, broken.endpoint]);
  assert.deepEqual(seen.map((e) => e.endpoint), calls);
  assert.deepEqual(summary.results.map((r) => [r.endpoint, r.status, r.shouldDelete]), [
    [ok.endpoint, 201, false],
    [gone.endpoint, 410, true],
    [broken.endpoint, 500, false],
  ]);
});

test('pushToAll：脏数据算 failed，onResult 抛错不影响统计', async () => {
  const vapid = generateVapidKeys();
  const good = makeSubscription();
  const { impl } = captureFetch(201);
  const summary = await pushToAll([good.json, null, { endpoint: 'nope' }], pushPayload({ title: 't' }), {
    fetchImpl: impl,
    vapid,
    onResult: () => {
      throw new Error('callback boom');
    },
  });
  assert.equal(summary.sent, 1);
  assert.equal(summary.failed, 2);
  assert.equal(summary.removed, 0);
  assert.equal(summary.results[1].reason, 'config');
  assert.equal(summary.results[1].endpoint, '');
});

test('pushToAll：空/非数组输入返回全 0', async () => {
  const summary = await pushToAll(undefined, pushPayload({ title: 't' }), {});
  assert.deepEqual(summary, { sent: 0, removed: 0, failed: 0, results: [] });
});

// ---------------------------------------------------------------- 订阅校验

test('normalizeSubscription：正例（浏览器 toJSON 形状 / JSON 串 / ua+createdAt）', () => {
  const sub = makeSubscription();
  const normalized = normalizeSubscription(sub.json);
  assert.deepEqual(normalized, {
    endpoint: ping,
    keys: { p256dh: b64u(sub.p256dhBytes), auth: b64u(sub.authBytes) },
  });
  assert.deepEqual(normalizeSubscription(JSON.stringify(sub.json)), normalized);
  const withMeta = normalizeSubscription({ ...sub.json, ua: 'Mozilla/5.0 (iPhone)', createdAt: 1700000000000 });
  assert.equal(withMeta.ua, 'Mozilla/5.0 (iPhone)');
  assert.equal(withMeta.createdAt, new Date(1700000000000).toISOString());
  assert.deepEqual(normalizeSubscription({ ...sub.json, ua: '  ', createdAt: '2024-01-01T00:00:00Z' }).ua, undefined);
});

test('normalizeSubscription：负例都抛可读错误', () => {
  const sub = makeSubscription();
  const cases = [
    [null, /对象/],
    ['not json', /JSON/],
    [42, /对象/],
    [[], /对象/],
    [{ keys: sub.json.keys }, /endpoint/],
    [{ ...sub.json, endpoint: 'not a url' }, /URL/],
    [{ ...sub.json, endpoint: 'http://fcm.googleapis.com/x' }, /https/],
    [{ endpoint: ping }, /p256dh/],
    [{ endpoint: ping, keys: { auth: b64u(sub.authBytes) } }, /p256dh/],
    [{ endpoint: ping, keys: { p256dh: 'not-base64url!!', auth: b64u(sub.authBytes) } }, /base64url/],
    [{ endpoint: ping, keys: { p256dh: b64u(randomBytes(32)), auth: b64u(sub.authBytes) } }, /65 字节/],
    [{ endpoint: ping, keys: { p256dh: b64u(Buffer.concat([Buffer.from([2]), sub.p256dhBytes.subarray(1)])), auth: b64u(sub.authBytes) } }, /未压缩/],
    [{ endpoint: ping, keys: { p256dh: b64u(sub.p256dhBytes) } }, /auth/],
    [{ endpoint: ping, keys: { p256dh: b64u(sub.p256dhBytes), auth: b64u(randomBytes(8)) } }, /16 字节/],
    [{ endpoint: ping, keys: { p256dh: b64u(sub.p256dhBytes), auth: b64u(randomBytes(16)) }, createdAt: 'yesterday-ish' }, /createdAt/],
  ];
  for (const [input, pattern] of cases) {
    assert.throws(() => normalizeSubscription(input), pattern, `应拒绝: ${JSON.stringify(input)?.slice(0, 80)}`);
  }
});

// ---------------------------------------------------------------- VAPID 密钥

test('generateVapidKeys：65 字节公钥点 + 32 字节标量，且私钥能推出公钥', () => {
  const pair = generateVapidKeys();
  const pub = Buffer.from(pair.publicKey, 'base64url');
  assert.equal(pub.length, 65);
  assert.equal(pub[0], 0x04);
  assert.equal(Buffer.from(pair.privateKey, 'base64url').length, 32);
  assert.deepEqual(buildVapidKeyPair(pair), pair);
});

test('buildVapidKeyPair：JSON 往返 / PEM / 裸私钥 / 空参生成 / 公钥可缺省', () => {
  const pair = generateVapidKeys();
  assert.deepEqual(buildVapidKeyPair(JSON.stringify(pair)), pair);
  assert.deepEqual(buildVapidKeyPair({ ...pair, subject: 'mailto:ignored@example.com' }), pair, '库原生 VapidKeys 多出的 subject 应被忽略');
  assert.deepEqual(buildVapidKeyPair({ privateKey: pair.privateKey }), pair, '只给私钥时应推导出公钥');
  assert.deepEqual(buildVapidKeyPair(pair.privateKey), pair, '裸 base64url 私钥');
  const generated = buildVapidKeyPair();
  assert.equal(Buffer.from(generated.publicKey, 'base64url').length, 65);
  assert.notEqual(generated.privateKey, pair.privateKey);

  const pubBytes = Buffer.from(pair.publicKey, 'base64url');
  const pem = createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', x: b64u(pubBytes.subarray(1, 33)), y: b64u(pubBytes.subarray(33, 65)), d: pair.privateKey },
    format: 'jwk',
  }).export({ type: 'pkcs8', format: 'pem' });
  assert.deepEqual(buildVapidKeyPair(pem), pair, 'PKCS#8 PEM 私钥应能还原');
  assert.deepEqual(buildVapidKeyPair({ privateKey: pem }), pair);

  assert.throws(() => buildVapidKeyPair({ publicKey: pair.publicKey }), /私钥/);
  assert.throws(() => buildVapidKeyPair({ publicKey: pair.publicKey, privateKey: generateVapidKeys().privateKey }), /不匹配/);
  assert.throws(() => buildVapidKeyPair('{oops'), /JSON/);
});

test('buildVapidKeyPair：还原出来的密钥真能加密并签出可验证的 VAPID 头', async () => {
  const stored = JSON.stringify(generateVapidKeys()); // 模拟 settings.json 里存的字符串
  const restored = buildVapidKeyPair(stored);
  const sub = makeSubscription();
  const { calls, impl } = captureFetch(201);
  const r = await sendPush(sub.json, pushPayload({ title: 'restored' }), { fetchImpl: impl, vapid: restored });
  assert.equal(r.ok, true);
  const authz = calls[0].init.headers.authorization;
  assert.ok(authz.includes(`k=${restored.publicKey}`));
  const [header, claims, signature] = /^vapid t=([^,]+), k=/.exec(authz)[1].split('.');
  assert.equal(
    cryptoVerify('sha256', Buffer.from(`${header}.${claims}`), { key: pointToKey(Buffer.from(restored.publicKey, 'base64url')), dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')),
    true,
  );
  assert.equal(decryptAes128Gcm(Buffer.from(calls[0].init.body), sub).plaintext.toString('utf8'), JSON.stringify(pushPayload({ title: 'restored' })));
});

// ---------------------------------------------------------------- payload 约定

test('pushPayload：默认值与 SW 解析约定一致', () => {
  assert.deepEqual(pushPayload(), { title: 'DSH Pocket', body: '', url: '/', tag: 'dsh-pocket' });
  assert.deepEqual(pushPayload({ title: '任务完成', body: '会话结束' }), { title: '任务完成', body: '会话结束', url: '/', tag: 'dsh-pocket' });
  const withSession = pushPayload({ title: 't', sessionId: 's-1' });
  assert.equal(withSession.tag, 'dsh-pocket:s-1');
  assert.equal(withSession.sessionId, 's-1');
  assert.equal(pushPayload({ title: 't', url: '/#/session/1', tag: 'custom', sessionId: 's' }).tag, 'custom');
  assert.equal(pushPayload({ title: '   ' }).title, 'DSH Pocket');
});

// ---------------------------------------------------------------- Webhook

test('webhook：6 个 preset 的请求形状', () => {
  assert.deepEqual(WEBHOOK_PRESETS, ['generic', 'wecom', 'dingtalk', 'feishu', 'ntfy', 'bark']);
  const base = { url: 'https://example.com/hook?token=t', title: '任务完成', body: '会话结束', link: 'https://x/y', now: 1700000000000 };

  const generic = buildWebhookRequest({ ...base, preset: 'generic' });
  assert.equal(generic.method, 'POST');
  assert.equal(generic.url, base.url);
  assert.deepEqual(JSON.parse(generic.body), { title: '任务完成', message: '会话结束', url: 'https://x/y', at: '2023-11-14T22:13:20.000Z' });
  assert.match(generic.headers['content-type'], /application\/json/);

  const wecom = buildWebhookRequest({ ...base, preset: 'wecom' });
  assert.deepEqual(JSON.parse(wecom.body), { msgtype: 'text', text: { content: '任务完成\n会话结束' } });
  assert.equal(wecom.url, base.url, '无 secret 不该改 URL');

  const dingtalk = buildWebhookRequest({ ...base, preset: 'dingtalk' });
  assert.deepEqual(JSON.parse(dingtalk.body), { msgtype: 'text', text: { content: '任务完成\n会话结束' } });

  const feishu = buildWebhookRequest({ ...base, preset: 'feishu' });
  assert.deepEqual(JSON.parse(feishu.body), { msg_type: 'text', content: { text: '任务完成\n会话结束' } });

  const ntfy = buildWebhookRequest({ ...base, preset: 'ntfy' });
  assert.equal(ntfy.body, '任务完成\n会话结束');
  // 中文标题用 RFC 2047 encoded-word 承载（ntfy 官方文档支持的写法）：头是纯 ASCII，解码后仍是原文
  assert.match(ntfy.headers.Title, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
  assert.equal(decodeHeaderWords(ntfy.headers.Title), '任务完成');
  assert.equal(ntfy.headers.Priority, 'high');
  assert.equal(ntfy.headers.Click, 'https://x/y');
  assert.match(ntfy.headers['content-type'], /text\/plain/);
  assertHeaderValuesAscii(ntfy.headers);
  // 不给 tags 时不应多出 Tags 头
  assert.equal(Object.prototype.hasOwnProperty.call(ntfy.headers, 'Tags'), false);

  const bark = buildWebhookRequest({ ...base, preset: 'bark' });
  assert.deepEqual(JSON.parse(bark.body), { title: '任务完成', body: '会话结束', url: 'https://x/y', group: 'dsh-pocket' });
});

test('webhook：钉钉加签 = urlencode(base64(HMAC-SHA256(secret, `${ts}\\n${secret}`)))', async () => {
  const secret = 'dshpocketsecret';
  const ts = 1700000000000;
  // 黄金值：由 node:crypto 的 HMAC 与 WebCrypto 的 HMAC 两条独立实现交叉核对
  const expected = 'EHHnIkxZ6b4kzGeI9oTPFOnzKwKKxiz8fkaRHb/OqCc=';
  assert.equal(dingtalkSign(secret, ts), expected, 'HMAC 结果应符合钉钉官方算法');
  const subtleKey = await webcrypto.subtle.importKey('raw', Buffer.from(secret, 'utf8'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const webcryptoSign = Buffer.from(await webcrypto.subtle.sign('HMAC', subtleKey, Buffer.from(`${ts}\n${secret}`, 'utf8'))).toString('base64');
  assert.equal(webcryptoSign, expected, 'WebCrypto 独立实现应得到同一签值');

  const request = buildWebhookRequest({ preset: 'dingtalk', url: 'https://oapi.dingtalk.com/robot/send?access_token=tok', secret, title: 'a', body: 'b', now: ts });
  const parsed = new URL(request.url);
  assert.equal(parsed.searchParams.get('access_token'), 'tok', '原有 query 要保留');
  assert.equal(parsed.searchParams.get('timestamp'), String(ts));
  assert.equal(parsed.searchParams.get('sign'), expected, 'sign 应落在 query 且已 URL 解码');
  assert.ok(request.url.includes('%2B') || request.url.includes('%3D'), 'base64 里的 +/= 必须被 urlencode');
  // 空 secret 时不加签
  assert.equal(buildWebhookRequest({ preset: 'dingtalk', url: 'https://oapi.dingtalk.com/robot/send?access_token=tok', title: 'a', now: ts }).url.includes('sign='), false);
});

test('webhook：url 空/非法/非 http(s) 抛错，preset 不支持抛错', async () => {
  for (const url of ['', '   ', undefined, null]) {
    assert.throws(() => buildWebhookRequest({ url }), /不能为空|required/, `url=${String(url)}`);
    // sendWebhook 不抛：配置错误也走 { ok:false, status:0, error }，避免打断任务完成回调
    const sent = await sendWebhook({ url });
    assert.equal(sent.ok, false);
    assert.equal(sent.status, 0);
    assert.match(sent.error, /不能为空|required/);
  }
  assert.throws(() => buildWebhookRequest({ url: 'not-a-url' }), /合法|invalid/);
  assert.throws(() => buildWebhookRequest({ url: 'ftp://example.com/hook' }), /http/);
  assert.throws(() => buildWebhookRequest({ url: 'https://example.com/hook', preset: 'nope' }), /不支持|unsupported/);
  assert.throws(() => buildWebhookRequest(), /不能为空|required/);
  assert.equal((await sendWebhook({ url: 'https://example.com/hook', preset: 'nope' })).ok, false);
});

test('sendWebhook：2xx 成功、非 2xx 失败、平台 errcode 也算失败', async () => {
  const okImpl = async (url, init) => {
    assert.equal(init.method, 'POST');
    return { status: 200, text: async () => '{"errcode":0,"errmsg":"ok"}' };
  };
  assert.deepEqual(await sendWebhook({ preset: 'wecom', url: 'https://example.com/hook', title: 't' }, { fetchImpl: okImpl }), { ok: true, status: 200, error: null });

  const barkOk = async () => ({ status: 200, text: async () => '{"code":200,"message":"success"}' });
  assert.equal((await sendWebhook({ preset: 'bark', url: 'https://example.com/hook', title: 't' }, { fetchImpl: barkOk })).ok, true, 'bark 的 code=200 是成功');

  const badCode = async () => ({ status: 200, text: async () => '{"errcode":40013,"errmsg":"invalid appid"}' });
  const failed = await sendWebhook({ preset: 'wecom', url: 'https://example.com/hook', title: 't' }, { fetchImpl: badCode });
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 200);
  assert.match(failed.error, /40013/);

  const http500 = async () => ({ status: 500, text: async () => 'boom' });
  const serverError = await sendWebhook({ preset: 'generic', url: 'https://example.com/hook', title: 't' }, { fetchImpl: http500 });
  assert.equal(serverError.ok, false);
  assert.equal(serverError.status, 500);
  assert.match(serverError.error, /500/);

  const boom = async () => {
    throw new Error('ECONNREFUSED');
  };
  const network = await sendWebhook({ preset: 'generic', url: 'https://example.com/hook', title: 't' }, { fetchImpl: boom });
  assert.equal(network.ok, false);
  assert.equal(network.status, 0);
  assert.match(network.error, /ECONNREFUSED/);
});

test('sendWebhook：超时中断不挂死；额外 headers 会合并（ntfy token）', async () => {
  const hang = (url, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  const started = Date.now();
  const timedOut = await sendWebhook({ preset: 'ntfy', url: 'https://ntfy.sh/topic', title: 't' }, { fetchImpl: hang, timeoutMs: 60 });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.status, 0);
  assert.match(timedOut.error, /超时|timed out/);
  assert.ok(Date.now() - started < 2000);

  let seenHeaders = null;
  const echo = async (url, init) => {
    seenHeaders = init.headers;
    return { status: 200, text: async () => 'ok' };
  };
  await sendWebhook({ preset: 'ntfy', url: 'https://ntfy.sh/topic', title: 't', headers: { Authorization: 'Bearer tk' } }, { fetchImpl: echo });
  assert.equal(seenHeaders.Authorization, 'Bearer tk');
  assert.equal(seenHeaders.Title, 't');
});

test('webhook：tags 参与 bark group 与 ntfy Tags 头', () => {
  const bark = buildWebhookRequest({ preset: 'bark', url: 'https://api.day.app/key', title: 't', tags: ['dsh', 'done'] });
  assert.equal(JSON.parse(bark.body).group, 'dsh');
  const ntfy = buildWebhookRequest({ preset: 'ntfy', url: 'https://ntfy.sh/topic', title: 't', tags: 'dsh,done' });
  assert.equal(ntfy.headers.Tags, 'dsh,done');
});

test('默认常量：subject 是 mailto / TTL / 超时', () => {
  assert.equal(DEFAULT_PUSH_SUBJECT, 'mailto:admin@example.com');
  assert.equal(MAX_PAYLOAD_BYTES, 3993);
});

test('三个模块 import 时零副作用（不联网、不读盘）', async () => {
  const originalFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => {
    fetched += 1;
    throw new Error('import 期间不该 fetch');
  };
  try {
    // 带 query 的 import 会重新求值一份模块实例，用来观察 import 阶段的行为
    const pushFresh = await import(`../lib/push.mjs?fresh=${Date.now()}`);
    assert.equal(typeof pushFresh.sendPush, 'function');
    const webhookFresh = await import(`../lib/webhook.mjs?fresh=${Date.now()}`);
    assert.equal(typeof webhookFresh.sendWebhook, 'function');
    const pwaFresh = await import(`../lib/pwa-assets.mjs?fresh=${Date.now()}`);
    assert.ok(pwaFresh.SW_SOURCE.length > 0);
    assert.equal(fetched, 0, 'import 阶段不得发起网络请求');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------- 头安全（issue：ntfy + 中文标题）

/** 起一个真实 http 服务收 webhook：必须用真 undici fetch 发，才能证明不再抛 ByteString。 */
async function startWebhookSink() {
  const hits = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, headers: { ...req.headers }, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"errcode":0,"errmsg":"ok"}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    hits,
    url: (path = '/hook') => `http://127.0.0.1:${port}${path}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('webhook：ntfy + 中文标题（生产默认形态）必须真的发得出去（回归：ByteString）', async () => {
  const sink = await startWebhookSink();
  try {
    // 生产默认标题就是中文（lib/notify-hook.mjs 的 DEFAULT_TITLE）
    const result = await sendWebhook({
      preset: 'ntfy',
      url: sink.url('/topic'),
      title: 'DSH 任务完成',
      body: '一个任务跑完了 | a task finished',
      link: 'https://pocket.invalid/会话/1',
    });
    assert.equal(result.ok, true, `中文标题必须能发出请求，实际 ${JSON.stringify(result)}`);
    assert.equal(result.status, 200);
    assert.equal(result.reason, undefined, '成功时保持冻结的三字段形状');
    assert.equal(sink.hits.length, 1, 'mock 必须收到 1 次请求（缺陷时是 0 次）');

    const hit = sink.hits[0];
    assert.equal(hit.method, 'POST');
    assert.equal(hit.body, 'DSH 任务完成\n一个任务跑完了 | a task finished', '中文正文逐字节完好');
    assert.equal(hit.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(hit.headers.priority, 'high');
    // 非 ASCII 的 Click 会被百分号编码，仍然是合法头值
    assert.equal(hit.headers.click, 'https://pocket.invalid/%E4%BC%9A%E8%AF%9D/1');
    // Title 头必须是纯 ASCII（ByteString），且解码后能还原成中文标题
    assertHeaderValuesAscii(hit.headers);
    assert.equal(decodeHeaderWords(hit.headers.title), 'DSH 任务完成', 'Title 头解码后必须等于原标题（手机端能看到中文）');
  } finally {
    await sink.close();
  }
});

test('webhook：ntfy ASCII 标题仍带 Title 头（回归）', async () => {
  const sink = await startWebhookSink();
  try {
    const result = await sendWebhook({ preset: 'ntfy', url: sink.url('/topic'), title: 'DSH task done', body: 'a task finished' });
    assert.equal(result.ok, true);
    assert.equal(sink.hits.length, 1);
    assert.equal(sink.hits[0].headers.title, 'DSH task done');
    assert.equal(sink.hits[0].body, 'DSH task done\na task finished');
  } finally {
    await sink.close();
  }
});

test('webhook：6 个 preset + 中文标题都真的发得出去（真实 undici）', async () => {
  const sink = await startWebhookSink();
  const cases = [
    { preset: 'generic', path: '/hook' },
    { preset: 'wecom', path: '/hook?token=t' },
    { preset: 'dingtalk', path: '/hook?token=t', secret: 'vrfy-dingtalk-secret' },
    { preset: 'feishu', path: '/hook' },
    { preset: 'ntfy', path: '/topic' },
    { preset: 'bark', path: '/bark' },
  ];
  try {
    for (const c of cases) {
      const before = sink.hits.length;
      const result = await sendWebhook({
        preset: c.preset,
        url: sink.url(c.path),
        secret: c.secret,
        title: 'DSH 任务完成',
        body: '会话 abc 结束',
        link: 'https://pocket.invalid/',
      });
      assert.equal(result.ok, true, `${c.preset} 应发送成功，实际 ${JSON.stringify(result)}`);
      assert.equal(sink.hits.length - before, 1, `${c.preset} 应恰好发出 1 次请求`);
      const hit = sink.hits[before];
      assert.match(String(hit.headers['content-type']), /^(application\/json|text\/plain)/, `${c.preset} content-type`);
      assert.ok(hit.body.includes('DSH 任务完成'), `${c.preset} 报文里要带上中文标题`);
      assertHeaderValuesAscii(hit.headers);
      if (c.preset === 'ntfy') {
        assert.equal(decodeHeaderWords(hit.headers.title), 'DSH 任务完成', 'ntfy Title 头解码后等于中文标题');
      }
    }
  } finally {
    await sink.close();
  }
});

test('webhook：ntfy 头加固 —— Title/Priority/Tags/Click 不注入、不抛', () => {
  const request = buildWebhookRequest({
    preset: 'ntfy',
    url: 'https://ntfy.sh/topic',
    title: '中文标题',
    body: 'b',
    priority: 'high\r\nX-Evil: 1',
    tags: ['ok', '中文标签', 'bad\r\nhack'],
    link: 'https://x/中文',
  });
  assert.equal(decodeHeaderWords(request.headers.Title), '中文标题', '中文标题编码成 encoded-word 后可逐字还原');
  assert.equal(request.headers.Priority, 'high', 'CRLF 注入被白名单挡掉，回退默认优先级');
  assert.equal(request.headers.Tags, 'ok', '非 ASCII / 控制字符 tag 被剔除');
  assert.equal(request.headers.Click, 'https://x/%E4%B8%AD%E6%96%87', 'Click 非 ASCII 百分号编码');
  assert.equal(/[\r\n]/.test(JSON.stringify(request.headers)), false);
  assertHeaderValuesAscii(request.headers);
  // 白名单内的优先级原样保留（大小写归一）
  assert.equal(buildWebhookRequest({ preset: 'ntfy', url: 'https://ntfy.sh/t', priority: 'MAX' }).headers.Priority, 'max');
  assert.equal(buildWebhookRequest({ preset: 'ntfy', url: 'https://ntfy.sh/t', priority: '3' }).headers.Priority, '3');
  assert.equal(buildWebhookRequest({ preset: 'ntfy', url: 'https://ntfy.sh/t' }).headers.Priority, 'high');
  // 控制字符标题：剔掉控制字符后仍是纯 ASCII，可以安全发头；正文（body）里的换行不算头注入
  const injected = buildWebhookRequest({ preset: 'ntfy', url: 'https://ntfy.sh/t', title: 'ok\r\nX-Evil: 1', body: 'b' });
  assert.equal(injected.headers.Title, 'okX-Evil: 1');
  assert.equal(/\r|\n/.test(injected.headers.Title), false);
  assert.equal(injected.body, 'ok\r\nX-Evil: 1\nb', '正文原样保留');
  // 只有控制字符的标题 → 不发 Title 头，也不报错
  const blank = buildWebhookRequest({ preset: 'ntfy', url: 'https://ntfy.sh/t', title: '\r\n', body: 'b' });
  assert.equal(Object.prototype.hasOwnProperty.call(blank.headers, 'Title'), false);
  // bark 的 group 在 JSON body 里，不受头安全限制（UTF-8 合法）
  assert.equal(JSON.parse(buildWebhookRequest({ preset: 'bark', url: 'https://api.day.app/k', title: 't', tags: ['中文'] }).body).group, '中文');
  // 非 ASCII URL 会被百分号编码（ntfy 主题名常是中文）
  const chineseUrl = buildWebhookRequest({ preset: 'ntfy', url: 'https://ntfy.sh/我的主题', title: 't' });
  assert.equal(chineseUrl.url, 'https://ntfy.sh/%E6%88%91%E7%9A%84%E4%B8%BB%E9%A2%98');
});

test('webhook：ntfy 长中文标题切成多段 encoded-word（每段 ≤75 字符，整体可还原）', async () => {
  const longTitle = '这是一个很长的中文会话标题用来验证多段编码词能不能被正确解码还原成完整标题';
  const request = buildWebhookRequest({ preset: 'ntfy', url: 'https://ntfy.sh/topic', title: longTitle, body: 'b' });
  const words = request.headers.Title.split(' ');
  assert.ok(words.length > 1, `长标题必须切成多段 encoded-word，实际 ${words.length} 段`);
  for (const word of words) {
    assert.match(word, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    assert.ok(word.length <= 75, `单个 encoded-word 不得超过 75 字符，实际 ${word.length}`);
  }
  assert.equal(decodeHeaderWords(request.headers.Title), longTitle, '多段编码词整体解码必须逐字等于原标题');
  assertHeaderValuesAscii(request.headers);

  // 端到端：真实 undici 发出去，mock 收到的头仍是合法 ASCII 且可还原
  const sink = await startWebhookSink();
  try {
    const result = await sendWebhook({ preset: 'ntfy', url: sink.url('/topic'), title: longTitle, body: 'b' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(sink.hits.length, 1);
    assertHeaderValuesAscii(sink.hits[0].headers);
    assert.equal(decodeHeaderWords(sink.hits[0].headers.title), longTitle);
  } finally {
    await sink.close();
  }
});

test('webhook：非 ASCII 主题 URL 的请求真的发得出去', async () => {
  const sink = await startWebhookSink();
  try {
    const result = await sendWebhook({ preset: 'ntfy', url: sink.url('/我的主题'), title: 'DSH task done' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(sink.hits.length, 1);
    assert.equal(sink.hits[0].url, '/%E6%88%91%E7%9A%84%E4%B8%BB%E9%A2%98');
  } finally {
    await sink.close();
  }
});

test('webhook：请求构造错误不再被报成「网络错误」', async () => {
  // undici 在头值不是 ByteString 时抛的就是这个（无 cause 的 TypeError）
  const byteStringError = new TypeError(
    'Cannot convert argument to a ByteString because the character at index 4 has a value of 20219 which is greater than 255.',
  );
  const constructed = await sendWebhook(
    { preset: 'ntfy', url: 'https://ntfy.sh/topic', title: 'DSH 任务完成' },
    { fetchImpl: async () => { throw byteStringError; } },
  );
  assert.equal(constructed.ok, false);
  assert.equal(constructed.status, 0);
  assert.equal(constructed.reason, 'request', '构造/编码错误应单独分类');
  assert.match(constructed.error, /请求构造失败/);
  assert.equal(/网络错误/.test(constructed.error), false, '不能再说成网络错误');

  // 真正的网络失败：连一个已关闭的本地端口（undici 抛 TypeError: fetch failed，cause=ECONNREFUSED）
  const sink = await startWebhookSink();
  const deadUrl = sink.url('/hook');
  await sink.close();
  const offline = await sendWebhook({ preset: 'generic', url: deadUrl, title: 't', body: 'b' }, { timeoutMs: 5000 });
  assert.equal(offline.ok, false);
  assert.equal(offline.reason, 'network', `真实网络失败仍要归为 network，实际 ${JSON.stringify(offline)}`);
  assert.match(offline.error, /网络错误/);

  // 调用方自带的头非法 → request 报错，且不发请求（不静默丢弃鉴权头）
  let called = 0;
  const badHeader = await sendWebhook(
    { preset: 'generic', url: 'https://example.com/hook', title: 't', headers: { Authorization: 'Bearer 中文令牌' } },
    { fetchImpl: async () => { called += 1; return { status: 200 }; } },
  );
  assert.equal(badHeader.ok, false);
  assert.equal(badHeader.reason, 'request');
  assert.match(badHeader.error, /Authorization/);
  assert.equal(called, 0, '非法头必须在发请求前就被拦下');
});

test('webhook：失败结果的 reason 分类（http / api-error / timeout / config）', async () => {
  const http500 = await sendWebhook({ preset: 'generic', url: 'https://example.com/h', title: 't' }, { fetchImpl: async () => ({ status: 500, text: async () => 'boom' }) });
  assert.equal(http500.reason, 'http');
  const apiError = await sendWebhook({ preset: 'wecom', url: 'https://example.com/h', title: 't' }, { fetchImpl: async () => ({ status: 200, text: async () => '{"errcode":40013,"errmsg":"invalid appid"}' }) });
  assert.equal(apiError.reason, 'api-error');
  const config = await sendWebhook({ url: '' });
  assert.equal(config.reason, 'config');
  const hang = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const timedOut = await sendWebhook({ preset: 'generic', url: 'https://example.com/h', title: 't' }, { fetchImpl: hang, timeoutMs: 50 });
  assert.equal(timedOut.reason, 'timeout');
  assert.equal(timedOut.status, 0);
});
