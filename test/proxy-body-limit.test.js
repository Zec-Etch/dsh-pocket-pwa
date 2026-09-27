// 413 路径回归测试（task-17）：未认证的 chunked 超限请求不得打死宿主进程。
//
// 缺陷链（verify-notify 的 repro-413-crash.mjs 复现过）：
//   req.on('data') 累计 > 64KB → reject413() 写 413 → 客户端继续发完 → req.on('end') 仍执行
//   → 半截 body 进 JSON.parse 失败分支 → sendJson 二次 writeHead → ERR_HTTP_HEADERS_SENT
//   抛在 http 回调里 = uncaughtException → 进程退出。
// 同一形状的第二条路径：超限之后每一个后续分块都会再调一次 reject413()（同样二次 writeHead）。
//
// 覆盖：
//   1) chunked 超限（多分块）→ 413、进程存活、后续请求仍正常服务；
//   2) 未认证打 /pocket-passkey/login/begin（PIN 闸门之前）→ 同样不再崩；
//   3) 子进程端到端复现：进程要么活着退出 0，要么被异常打死（非 0）；
//   4) 声明 Content-Length 超限 → 413（既有语义不变）；
//   5) 登录表单超长 body → 不再进入响应路径；
//   6) 登录页补 PWA 头部标签（manifest / apple-touch-icon / theme-color），且不改变登录流程。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPocketProxy, PASSKEY_PATHS } from '../lib/proxy.mjs';
import { createPasskeyStore } from '../lib/passkey-store.mjs';
import { createPushStore } from '../lib/push-store.mjs';

const DOMAIN = 'pocket.example.com';
const PIN = '13572468';
const OVER = 64 * 1024 + 4096; // 与 verify-notify 的 repro 同量级：64KB 上限 + 4KB
const CHANNELS = { mode: 'named', named: DOMAIN, ssh: '', quick: '' };
const PROXY_URL = new URL('../lib/proxy.mjs', import.meta.url).href;
const STORE_URL = new URL('../lib/passkey-store.mjs', import.meta.url).href;

// ---------- HTTP 助手 ----------

function httpCall(port, { method = 'GET', path = '/', host = DOMAIN, headers = {}, body = null, chunkSize = 0 } = {}) {
  return new Promise((resolve) => {
    const payload = body === null ? null : Buffer.from(body);
    const base = { host, connection: 'close', ...headers };
    if (payload && chunkSize === 0) base['content-length'] = String(payload.length);
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: base }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, body: text, json, error: null });
      });
    });
    // 客户端侧错误（服务端崩溃/断连）也要变成可断言的结果，而不是未处理的 error 事件
    req.on('error', (err) => resolve({ status: -1, headers: {}, body: '', json: null, error: err.code ?? err.message }));
    if (payload) {
      if (chunkSize > 0) {
        for (let i = 0; i < payload.length; i += chunkSize) req.write(payload.subarray(i, i + chunkSize));
      } else {
        req.write(payload);
      }
    }
    req.end();
  });
}

const postChunked = (port, path, body, opts = {}) => httpCall(port, { method: 'POST', path, body, chunkSize: opts.chunkSize ?? 8192, headers: opts.headers ?? {} });
const getPath = (port, path, headers = {}) => httpCall(port, { path, headers });

/** PIN 登录（表单），返回会话 cookie 的 name=value 段。 */
function loginWithPin(port, host = DOMAIN, pin = PIN) {
  return new Promise((resolve) => {
    const body = `token=${encodeURIComponent(pin)}`;
    const req = httpRequest({
      host: '127.0.0.1', port, method: 'POST', path: '/pocket-login',
      headers: { host, 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body), connection: 'close' },
    }, (res) => {
      res.resume();
      res.on('end', () => {
        const cookie = (res.headers['set-cookie'] ?? []).find((c) => c.startsWith('dsh_pocket_token='));
        resolve({ status: res.statusCode, session: cookie ? cookie.split(';')[0] : null });
      });
    });
    req.on('error', () => resolve({ status: -1, session: null }));
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
async function fixture() {
  const upstream = await fakeUpstream();
  const home = mkdtempSync(join(tmpdir(), 'dshp-bodylimit-'));
  const logs = [];
  const proxy = await createPocketProxy({
    port: 0,
    host: '127.0.0.1',
    upstream: { host: '127.0.0.1', port: upstream.port },
    heartbeat: false,
    auth: { sessionKey: 'sk-test', getToken: () => PIN, isProtected: () => true },
    passkeyStore: createPasskeyStore({ home }),
    pushStore: createPushStore({ home }),
    getPasskeyEnabled: () => true,
    getPublicChannels: () => CHANNELS,
    injectHtml: '',
    log: (line) => logs.push(String(line)),
  });
  return {
    proxy,
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

/** 在一个用例期间监听 uncaughtException：记录到的每一条都意味着「本该打死进程」的缺陷。 */
async function withCrashWatch(fn) {
  const crashes = [];
  const onCrash = (err) => crashes.push(err);
  process.on('uncaughtException', onCrash);
  try {
    const result = await fn(crashes);
    return { result, crashes };
  } finally {
    process.removeListener('uncaughtException', onCrash);
  }
}

// ---------- 1) chunked 超限（未认证 passkey 端点） ----------

test('413：未认证 chunked 超限打 /pocket-passkey/login/begin → 413、无 uncaughtException、进程继续服务', async () => {
  const f = await fixture();
  try {
    const { crashes } = await withCrashWatch(async (caught) => {
      const body = `{"flowId":"${'z'.repeat(OVER)}"}`;
      const res = await postChunked(f.proxy.port, PASSKEY_PATHS.loginBegin, body, {
        headers: { host: DOMAIN, 'x-forwarded-proto': 'https', 'content-type': 'application/json' },
      });
      assert.equal(res.status, 413, `超限必须 413，实际 ${res.status}${res.error ? `（${res.error}）` : ''}`);
      assert.match(res.body, /请求体过大|too large/, '可读的 413 文案');
      assert.equal(res.headers.connection, 'close', '413 后关闭连接');

      // 崩溃点是 req.on('end')：等它跑完再看有没有逃逸异常
      await new Promise((r) => setTimeout(r, 300));
      assert.deepEqual(caught.map((e) => e?.code ?? e?.message), [], '不得有 ERR_HTTP_HEADERS_SENT 逃逸');

      // 进程仍在服务：带 PIN 的后续请求照常代理到上游
      const after = await getPath(f.proxy.port, `/?token=${PIN}`, { accept: 'application/json' });
      assert.equal(after.status, 200, '后续请求仍应正常服务');
      assert.match(after.body, /path=\//, '真的到了上游');
    });
    assert.deepEqual(crashes, [], '整个用例期间不得有未捕获异常');
  } finally {
    await f.close();
  }
});

test('413：超限后仍有多个后续分块（reject413 幂等）→ 只写一次 413，不二次 writeHead', async () => {
  const f = await fixture();
  try {
    const { crashes } = await withCrashWatch(async (caught) => {
      // 三段式：第 1 段就超限，后面两段继续发 → 修复前第二个超限分块会再调一次 reject413()
      const res = await postChunked(f.proxy.port, PASSKEY_PATHS.loginBegin, `{"a":"${'y'.repeat(OVER)}"}`, {
        chunkSize: OVER, // 每段都超限：第一段 413，第二段是崩溃点
        headers: { host: DOMAIN, 'x-forwarded-proto': 'https', 'content-type': 'application/json' },
      });
      assert.equal(res.status, 413);
      await new Promise((r) => setTimeout(r, 300));
      assert.deepEqual(caught.map((e) => e?.code ?? e?.message), []);
      const after = await getPath(f.proxy.port, `/?token=${PIN}`);
      assert.equal(after.status, 200, '进程继续服务');
    });
    assert.deepEqual(crashes, []);
  } finally {
    await f.close();
  }
});

// ---------- 2) 已认证 push 端点（verify-notify 的另一条复现路径） ----------

test('413：已认证 push 端点 chunked 超限 → 413，进程继续服务', async () => {
  const f = await fixture();
  try {
    const { session } = await loginWithPin(f.proxy.port);
    assert.ok(session, '拿到 PIN 会话');
    const { crashes } = await withCrashWatch(async (caught) => {
      const res = await postChunked(f.proxy.port, '/pocket-push-subscribe', `{"subscription":${'x'.repeat(OVER)}}`, {
        headers: { cookie: session, 'content-type': 'application/json' },
      });
      assert.equal(res.status, 413, `实际 ${res.status}`);
      await new Promise((r) => setTimeout(r, 300));
      assert.deepEqual(caught.map((e) => e?.code ?? e?.message), []);
    });
    assert.deepEqual(crashes, []);
    const after = await getPath(f.proxy.port, `/?token=${PIN}`);
    assert.equal(after.status, 200);
  } finally {
    await f.close();
  }
});

// ---------- 3) 声明 Content-Length 超限（既有语义不变） ----------

test('413：声明 Content-Length 超限 → 413（既有语义不变，且不崩）', async () => {
  const f = await fixture();
  try {
    const { crashes } = await withCrashWatch(async (caught) => {
      const res = await httpCall(f.proxy.port, {
        method: 'POST',
        path: PASSKEY_PATHS.loginBegin,
        body: `{"flowId":"${'q'.repeat(OVER)}"}`,
        headers: { host: DOMAIN, 'x-forwarded-proto': 'https', 'content-type': 'application/json' },
      });
      assert.equal(res.status, 413, `实际 ${res.status}`);
      await new Promise((r) => setTimeout(r, 200));
      assert.deepEqual(caught.map((e) => e?.code ?? e?.message), []);
    });
    assert.deepEqual(crashes, []);
  } finally {
    await f.close();
  }
});

// ---------- 4) 登录表单超长 body（同构加固） ----------

test('登录：超过 1KB 的 /pocket-login body → 不进入响应路径、不崩，代理仍可用', async () => {
  const f = await fixture();
  try {
    const { crashes } = await withCrashWatch(async (caught) => {
      const res = await postChunked(f.proxy.port, '/pocket-login', `token=${'1'.repeat(4096)}`, {
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      // 超长登录体走 req.destroy()：客户端可能拿到响应，也可能拿到连接被重置 —— 两种都算正常，
      // 关键是不能有未捕获异常、后续请求还能用。
      assert.ok(res.status === -1 || res.status === 400 || res.status === 200 || res.status === 302, `意外状态 ${res.status}`);
      await new Promise((r) => setTimeout(r, 200));
      assert.deepEqual(caught.map((e) => e?.code ?? e?.message), []);
    });
    assert.deepEqual(crashes, []);
    const after = await getPath(f.proxy.port, `/?token=${PIN}`);
    assert.equal(after.status, 200, '代理仍可用');
  } finally {
    await f.close();
  }
});

// ---------- 5) 子进程端到端：进程要么活着，要么被异常打死 ----------

test('413 端到端（子进程）：chunked 超限后进程自行退出码为 0，且后续请求仍 200', async () => {
  const probe = `
const { createServer, request } = require('node:http');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
(async () => {
  const P = await import(${JSON.stringify(PROXY_URL)});
  const S = await import(${JSON.stringify(STORE_URL)});
  const up = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('up'); });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const proxy = await P.createPocketProxy({
    port: 0, host: '127.0.0.1', upstream: { host: '127.0.0.1', port: up.address().port }, heartbeat: false,
    auth: { sessionKey: 'sk', getToken: () => '${PIN}', isProtected: () => true },
    passkeyStore: S.createPasskeyStore({ home: mkdtempSync(join(tmpdir(), 'dshp-bodylimit-child-')) }),
    getPasskeyEnabled: () => true,
    getPublicChannels: () => ({ mode: 'named', named: '${DOMAIN}', ssh: '', quick: '' }),
    injectHtml: '', log: () => {},
  });
  const call = (opts, body) => new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port: proxy.port, ...opts }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(-1));
    if (body) { for (let i = 0; i < body.length; i += 8192) req.write(body.subarray(i, i + 8192)); }
    req.end();
  });
  const over = Buffer.from('{"flowId":"' + 'z'.repeat(${OVER}) + '"}');
  const status = await call({ method: 'POST', path: '/pocket-passkey/login/begin', headers: { host: '${DOMAIN}', 'x-forwarded-proto': 'https', 'content-type': 'application/json', connection: 'close' } }, over);
  await new Promise((r) => setTimeout(r, 700)); // 崩溃点（req.on('end')）在这段窗口里
  const after = await call({ method: 'GET', path: '/?token=${PIN}', headers: { host: '${DOMAIN}', accept: 'application/json', connection: 'close' } });
  try { await proxy.close(); } catch {}
  try { await new Promise((r) => up.close(r)); } catch {}
  process.exit(status === 413 && after === 200 ? 0 : 3);
})().catch(() => process.exit(4));
`;
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', probe], { stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); resolve(null); }, 20000);
    child.on('error', () => { clearTimeout(timer); resolve('spawn-error'); });
    child.on('exit', (exitCode) => { clearTimeout(timer); resolve(exitCode); });
  });
  assert.equal(code, 0, `子进程应正常退出 0（413 + 后续 200）；实际 ${code}（1 = 被 ERR_HTTP_HEADERS_SENT 打死，3 = 状态不符，4 = 启动失败）`);
});

// ---------- 6) 登录页 PWA 头部标签 ----------

test('登录页：补上 manifest / apple-touch-icon / theme-color，且不改变登录流程', async () => {
  const f = await fixture();
  try {
    // 未认证 GET / → 登录页
    const page = await getPath(f.proxy.port, '/', { accept: 'text/html' });
    assert.equal(page.status, 200);
    assert.match(page.body, /访问验证|access PIN/i, '仍是登录页');
    assert.match(page.body, /<link rel="manifest" href="\/pocket\.webmanifest">/, 'manifest 标签');
    assert.match(page.body, /<link rel="apple-touch-icon" href="\/pocket-icon-192\.png">/, 'apple-touch-icon 标签');
    assert.match(page.body, /<meta name="theme-color" content="#101a2e">/, 'theme-color');
    // 登录页不注册 SW、不带配置脚本：不改变登录流程，也不多暴露东西
    assert.doesNotMatch(page.body, /pocket-pwa\.js/, '登录页不引入注入脚本');
    assert.doesNotMatch(page.body, /__DSH_POCKET_CFG__/, '登录页不带配置对象');

    // 标签指向的三个资源在未认证时可取（PWA 静态资源先于 PIN 闸门）
    const manifest = await getPath(f.proxy.port, '/pocket.webmanifest');
    assert.equal(manifest.status, 200, 'manifest 未登录可访问');
    assert.match(String(manifest.headers['content-type']), /application\/manifest\+json/);
    const icon = await getPath(f.proxy.port, '/pocket-icon-192.png');
    assert.equal(icon.status, 200, '图标未登录可访问');
    assert.equal(String(icon.headers['content-type']), 'image/png');

    // 登录流程不变：正确 PIN 仍 302 + 会话 cookie
    const login = await loginWithPin(f.proxy.port);
    assert.equal(login.status, 302);
    assert.ok(login.session, '仍然种会话 cookie');
    const after = await getPath(f.proxy.port, '/', { accept: 'text/html', cookie: login.session });
    assert.equal(after.status, 200);
    assert.doesNotMatch(after.body, /访问验证/, '登录后不再是登录页');
  } finally {
    await f.close();
  }
});
