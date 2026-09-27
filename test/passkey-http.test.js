// 通行密钥 HTTP 集成回归测试（task-13：D-1 / D-2 / D-3）。
//
// 只测「代理层」的行为：自建假上游 + 最小软件认证器，**不 import 其它测试文件**
// （import 一个 *.test.js 会把它的用例也跑一遍）。每个用例一个临时 DSH_HOME。
//
// 对应三处修复：
//   D-1 非 HTTPS 上下文（X-Forwarded-Proto: http）的注册必须被拒，且不得下发设备 cookie；
//   D-2 存储写失败的 fs 异常（含绝对路径）不得回给客户端，原文只进服务端日志；
//   D-3 受保护 Host 上宿主 getToken() 返回空值时必须 fail closed（401，不落上游）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPocketProxy, PASSKEY_PATHS, DEVICE_COOKIE } from '../lib/proxy.mjs';
import { createPasskeyStore } from '../lib/passkey-store.mjs';

const DOMAIN = 'pocket.example.com';
const PIN = '13572468';
const CHANNELS = { mode: 'named', named: DOMAIN, ssh: '', quick: '' };

// ---------- 极简 CBOR 编码器 + 软件认证器（自包含，够构造合法注册响应即可） ----------

const FLAG_UP = 0x01;
const FLAG_AT = 0x40;
const ALG_ES256 = -7;
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (buf) => createHash('sha256').update(buf).digest();
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };

function cborHead(major, len) {
  if (len < 24) return Buffer.from([(major << 5) | len]);
  if (len < 0x100) return Buffer.from([(major << 5) | 24, len]);
  if (len < 0x10000) return Buffer.concat([Buffer.from([(major << 5) | 25]), u16(len)]);
  return Buffer.concat([Buffer.from([(major << 5) | 26]), u32(len)]);
}

function cbor(value) {
  if (Buffer.isBuffer(value)) return Buffer.concat([cborHead(2, value.length), value]);
  if (value instanceof Map) {
    const parts = [cborHead(5, value.size)];
    for (const [k, v] of value) parts.push(cbor(k), cbor(v));
    return Buffer.concat(parts);
  }
  if (Array.isArray(value)) return Buffer.concat([cborHead(4, value.length), ...value.map((v) => cbor(v))]);
  if (typeof value === 'number') return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  throw new Error(`测试 CBOR 编码器无法编码 ${String(value)}`);
}

/** 生成 P-256 密钥 + 按 rpId/challenge/origin 造一份合法 attestationObject。 */
function softwareAuthenticator() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const coseKey = new Map([
    [1, 2], [3, ALG_ES256], [-1, 1],
    [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')],
  ]);
  return {
    register({ rpId, challenge, origin, credentialId = randomBytes(16), signCount = 0 }) {
      const authData = Buffer.concat([
        sha256(Buffer.from(rpId, 'utf8')), Buffer.from([FLAG_UP | FLAG_AT]), u32(signCount),
        Buffer.alloc(16), u16(credentialId.length), credentialId, cbor(coseKey),
      ]);
      const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false }), 'utf8');
      const attestation = cbor(new Map([['fmt', 'none'], ['authData', authData], ['attStmt', new Map()]]));
      return {
        id: b64u(credentialId),
        rawId: b64u(credentialId),
        type: 'public-key',
        response: { clientDataJSON: b64u(clientData), attestationObject: b64u(attestation) },
      };
    },
  };
}

// ---------- HTTP 助手 ----------

function postJson(port, hostHeader, path, body, extraHeaders = {}) {
  const payload = JSON.stringify(body ?? {});
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path,
      headers: {
        host: hostHeader,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        ...extraHeaders,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, body: text, json, setCookies: res.headers['set-cookie'] ?? [] });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function getPath(port, hostHeader, path, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers: { host: hostHeader, ...extraHeaders } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** PIN 登录（表单 POST），返回会话 cookie 的 name=value 段。 */
function loginWithPin(port, hostHeader, pin) {
  const body = `token=${encodeURIComponent(pin)}`;
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1', port, method: 'POST', path: '/pocket-login',
      headers: { host: hostHeader, 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      res.resume();
      res.on('end', () => {
        const cookie = (res.headers['set-cookie'] ?? []).find((c) => c.startsWith('dsh_pocket_token='));
        resolve({ status: res.statusCode, session: cookie ? cookie.split(';')[0] : null });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function fakeUpstream() {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ host: req.headers.host, path: req.url });
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`path=${req.url}`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, seen, server };
}

/** 起一套「固定域名通道 + 通行密钥」的代理（临时 HOME + 假上游 + 日志收集）。 */
async function fixture({ getToken = () => PIN, home = mkdtempSync(join(tmpdir(), 'dshp-pk-http-')), passkeyStore } = {}) {
  const upstream = await fakeUpstream();
  const store = passkeyStore ?? createPasskeyStore({ home });
  const logs = [];
  const proxy = await createPocketProxy({
    port: 0,
    host: '127.0.0.1',
    upstream: { host: '127.0.0.1', port: upstream.port },
    heartbeat: false,
    auth: { sessionKey: 'sk-test', getToken, isProtected: () => true },
    passkeyStore: store,
    getPasskeyEnabled: () => true,
    getPublicChannels: () => CHANNELS,
    injectHtml: '',
    log: (line) => logs.push(String(line)),
  });
  return {
    proxy,
    store,
    home,
    logs,
    upstream,
    async close() {
      await proxy.close();
      await new Promise((r) => upstream.server.close(r));
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const deviceCookieOf = (res) => res.setCookies.find((c) => c.startsWith(`${DEVICE_COOKIE}=`)) ?? null;

// ---------- D-1 正例对照 ----------

test('D-1 对照：HTTPS 固定域名注册仍然 200，设备 cookie 带 Secure（修复没有收紧正常路径）', async () => {
  const f = await fixture();
  try {
    const authr = softwareAuthenticator();
    const { session } = await loginWithPin(f.proxy.port, DOMAIN, PIN);
    assert.ok(session, 'PIN 会话');

    const begin = await postJson(f.proxy.port, DOMAIN, PASSKEY_PATHS.registerBegin, {}, { cookie: session });
    assert.equal(begin.status, 200, `register/begin：${begin.body}`);
    assert.equal(begin.json.rp.id, DOMAIN);

    const credentialId = randomBytes(16);
    const registration = authr.register({ rpId: DOMAIN, challenge: begin.json.challenge, origin: `https://${DOMAIN}`, credentialId });
    const finish = await postJson(f.proxy.port, DOMAIN, PASSKEY_PATHS.registerFinish, {
      flowId: begin.json.flowId, ...registration, name: '我的手机',
    }, { cookie: session });
    assert.equal(finish.status, 200, `register/finish：${finish.body}`);
    assert.equal(finish.json.ok, true);

    const cookie = deviceCookieOf(finish);
    assert.ok(cookie, '签发设备 cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Path=\//);
    assert.match(cookie, /Max-Age=15552000/, '180 天');
    assert.match(cookie, /; Secure/, 'HTTPS 下必须带 Secure');
    assert.equal(f.store.list().length, 1, '凭据入库');
    assert.equal(f.store.list()[0].id, b64u(credentialId));
  } finally {
    await f.close();
  }
});

// ---------- D-1 ----------

test('D-1：X-Forwarded-Proto: http + 公网固定域名 → register/begin 与 register/finish 都拒绝，且不下发设备 cookie', async () => {
  const f = await fixture();
  try {
    const authr = softwareAuthenticator();
    const { session } = await loginWithPin(f.proxy.port, DOMAIN, PIN);

    // 1) begin：明文 http → 400，且不吐 challenge/flowId
    const httpBegin = await postJson(f.proxy.port, DOMAIN, PASSKEY_PATHS.registerBegin, {}, { cookie: session, 'x-forwarded-proto': 'http' });
    assert.equal(httpBegin.status, 400, `http register/begin 必须被拒：${httpBegin.body}`);
    assert.match(httpBegin.body, /HTTPS/, '文案说明需要 HTTPS');
    assert.equal(httpBegin.json.flowId, undefined, '不给 flowId');
    assert.equal(httpBegin.json.challenge, undefined, '不下发挑战值');
    assert.equal(deviceCookieOf(httpBegin), null, '不下发设备 cookie');

    // 2) finish：先用 https 拿一个合法 flowId，再带 XFP:http 提交 —— 证明 finish 自己也被门槛挡住
    //    （而不是「因为 begin 被拒所以拿不到 flowId」这种假通过）
    const httpsBegin = await postJson(f.proxy.port, DOMAIN, PASSKEY_PATHS.registerBegin, {}, { cookie: session });
    assert.equal(httpsBegin.status, 200);
    const credentialId = randomBytes(16);
    const registration = authr.register({
      rpId: DOMAIN,
      challenge: httpsBegin.json.challenge,
      origin: `http://${DOMAIN}`, // 攻击者把 origin 也写成 http（对应 XFP: http）
      credentialId,
    });
    const httpFinish = await postJson(f.proxy.port, DOMAIN, PASSKEY_PATHS.registerFinish, {
      flowId: httpsBegin.json.flowId, ...registration,
    }, { cookie: session, 'x-forwarded-proto': 'http' });
    assert.equal(httpFinish.status, 400, `http register/finish 必须被拒：${httpFinish.body}`);
    assert.match(httpFinish.body, /HTTPS/);
    assert.equal(deviceCookieOf(httpFinish), null, '绝不下发不带 Secure 的设备 cookie');
    assert.equal(f.store.list().length, 0, '没有凭据入库');
    assert.equal(f.store.findCredential(b64u(credentialId)), null);

    // 3) 同一个 flowId 已经作废（finish 先校验再取 flow），https 重放也不该成功
    const replay = await postJson(f.proxy.port, DOMAIN, PASSKEY_PATHS.registerFinish, {
      flowId: httpsBegin.json.flowId, ...registration,
    }, { cookie: session });
    assert.equal(replay.status, 400, '一次性流程用完即焚');
  } finally {
    await f.close();
  }
});

test('D-1：X-Forwarded-Proto: http + localhost → 拒绝而不是 500（没有 localhost 例外）', async () => {
  const f = await fixture();
  try {
    const { session } = await loginWithPin(f.proxy.port, 'localhost', PIN);
    const res = await postJson(f.proxy.port, 'localhost', PASSKEY_PATHS.registerBegin, {}, { cookie: session, 'x-forwarded-proto': 'http' });
    // localhost 不是固定域名通道（passkeyChannel === null），在通道判定就被挡掉；
    // 这里断言的是「明确 400 + 可读文案」，不是 500，也不是 200。
    assert.equal(res.status, 400, `localhost + http 必须被拒：${res.body}`);
    assert.match(res.body, /固定域名通道|fixed-domain/);
    assert.equal(deviceCookieOf(res), null);
  } finally {
    await f.close();
  }
});

// ---------- D-2 ----------

test('D-2：passkeys.json 占成目录 → 400 泛化文案（不泄露路径/异常码），真实原因进服务端日志，进程不崩', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dshp-pk-storefail-'));
  // 复现 verify-passkey 的最小复现：把 passkeys.json 占成目录 → rename 覆盖失败
  mkdirSync(join(home, 'dsh-pocket', 'passkeys.json'), { recursive: true });
  const f = await fixture({ home });
  try {
    const authr = softwareAuthenticator();
    const { session } = await loginWithPin(f.proxy.port, DOMAIN, PIN);
    const begin = await postJson(f.proxy.port, DOMAIN, PASSKEY_PATHS.registerBegin, {}, { cookie: session });
    assert.equal(begin.status, 200, 'begin 仍可用（读路径自愈成空库）');

    const registration = authr.register({ rpId: DOMAIN, challenge: begin.json.challenge, origin: `https://${DOMAIN}` });
    const finish = await postJson(f.proxy.port, DOMAIN, PASSKEY_PATHS.registerFinish, {
      flowId: begin.json.flowId, ...registration,
    }, { cookie: session });

    assert.equal(finish.status, 400, `写失败仍是 400：${finish.body}`);
    assert.equal(finish.json.code, 'INTERNAL', '非校验类异常映射为 INTERNAL');
    assert.match(finish.body, /通行密钥操作失败|passkey operation failed/, '回泛化文案');
    // 关键：响应体里不能有任何盘符 / 路径 / 异常码 / 栈信息
    assert.doesNotMatch(finish.body, /[A-Za-z]:[\\/]/, '不含盘符路径');
    assert.doesNotMatch(finish.body, /passkeys\.json/, '不含存储文件路径');
    assert.doesNotMatch(finish.body, /\b(EPERM|EISDIR|ENOTEMPTY|EEXIST|rename|syscall)\b/, '不含 fs 异常原文');
    assert.doesNotMatch(finish.body, /\.mjs:\d+/, '不含源码行号');
    assert.equal(deviceCookieOf(finish), null, '写失败不得签发设备 cookie');

    // 真实原因必须还在服务端日志里（否则运维无法排查）
    assert.ok(f.logs.some((l) => /passkey registration failed/.test(l) && /passkeys\.json/.test(l)),
      `日志里应有真实原因，实际日志：${JSON.stringify(f.logs)}`);

    // 进程没崩：紧接着的普通请求照常代理到上游
    const after = await getPath(f.proxy.port, DOMAIN, '/', { cookie: session, accept: 'text/plain' });
    assert.equal(after.status, 200, '失败后代理仍可服务');
    assert.ok(f.upstream.seen.length >= 1, '请求真的到了上游');
  } finally {
    await f.close();
  }
});

// ---------- D-3 ----------

test('D-3：宿主 getToken() 返回空 + 受保护公网 Host → 401 fail closed，不落上游；register/* 同样被拒', async () => {
  const f = await fixture({ getToken: () => null });
  try {
    // 1) 普通请求（无 cookie）→ 401，且没有透传到上游
    const page = await getPath(f.proxy.port, DOMAIN, '/', { accept: 'text/html' });
    assert.equal(page.status, 401, '未配置 PIN 时必须 401');
    assert.equal(f.upstream.seen.length, 0, '认证闸门之前不得落到上游');

    // 2) register/begin（无 cookie）→ 401（对应 verify-passkey S9.1）
    const begin = await postJson(f.proxy.port, DOMAIN, PASSKEY_PATHS.registerBegin, {});
    assert.equal(begin.status, 401, `空 token 下 register/begin 必须 401：${begin.body}`);
    assert.equal(begin.json?.flowId, undefined, '不给 flowId');

    // 3) register/finish（无 cookie）→ 不是 200（对应 S9.2）
    const finish = await postJson(f.proxy.port, DOMAIN, PASSKEY_PATHS.registerFinish, { flowId: 'x' });
    assert.notEqual(finish.status, 200);
    assert.equal(finish.status, 401);

    // 4) 连设备 cookie 也不放行：受保护 Host 没配 PIN 就没有任何豁免通道
    const withDevice = await getPath(f.proxy.port, DOMAIN, '/', { accept: 'text/html', cookie: `${DEVICE_COOKIE}=whatever` });
    assert.equal(withDevice.status, 401);
    assert.equal(f.upstream.seen.length, 0, '始终不落上游');
    assert.ok(f.logs.some((l) => /no PIN configured/.test(l)), '日志记录 fail closed 原因');
  } finally {
    await f.close();
  }
});

test('D-3 对照：PIN 配置正常时，未认证请求仍然拿登录页 / register 401（既有语义不变）', async () => {
  const f = await fixture();
  try {
    const page = await getPath(f.proxy.port, DOMAIN, '/', { accept: 'text/html' });
    assert.equal(page.status, 200, '有 PIN → 登录页（不是 401）');
    assert.match(page.body, /访问验证|access PIN/i);

    const begin = await postJson(f.proxy.port, DOMAIN, PASSKEY_PATHS.registerBegin, {});
    assert.equal(begin.status, 401, '注册仍需要已登录会话');

    const { session } = await loginWithPin(f.proxy.port, DOMAIN, PIN);
    assert.equal(session !== null, true);
    const ok = await postJson(f.proxy.port, DOMAIN, PASSKEY_PATHS.registerBegin, {}, { cookie: session });
    assert.equal(ok.status, 200, '登录后正常注册');
  } finally {
    await f.close();
  }
});
