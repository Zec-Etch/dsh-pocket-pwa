// 回归测试（宿主退出防护）：远控入口收到畸形请求时不得打死 dsh 宿主
//
// 缺陷链（已在真实 dsh web 上复现）：
//   1) Node 的 HTTP 解析器接受 absolute-form 请求行（`GET http://[ HTTP/1.1`），
//      且**不校验**其中的 URL 是否合法 → `req.url` 原样是 `http://[`；
//   2) 代理的 authCheck 用 `new URL(req.url, 'http://x')` 解析 → TypeError(ERR_INVALID_URL)；
//   3) 抛在 http 事件回调里 = uncaughtException，dsh 宿主的 fail-loud 处理器
//      （@deepseek-ai/dsh-app-boot 的 installFailLoud）直接 process.exit(1)；
//   4) 结果：**一个未认证请求打死整个 DSH**（局域网任意设备 / 公网隧道的任意访客）。
//
// 修复：请求目标解析统一走 parseRequestTarget()，解析失败一律 400 收口；
// 两个 http 回调（request / upgrade）各加一层崩溃屏障。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';

import { createPocketProxy, parseRequestTarget } from '../lib/proxy.mjs';

/** 假上游：回显请求路径（正常请求仍要能透传）。 */
async function fakeUpstream() {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`path=${req.url}`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, server };
}

/** 用原始 socket 发一行请求：`http.request` 无法构造畸形请求目标。 */
function rawRequest(port, requestLine, headers = []) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write([requestLine, ...headers, '', ''].join('\r\n'));
    });
    let buf = '';
    socket.on('data', (c) => { buf += c; });
    socket.on('close', () => resolve(buf));
    socket.on('error', reject);
    const timer = setTimeout(() => { try { socket.destroy(); } catch { /* 已断 */ } resolve(buf); }, 3000);
    timer.unref?.();
  });
}

/**
 * 捕获测试期间的未捕获异常（宿主 fail-loud 的前一步）。
 * 装了监听器后 Node 不会再因 uncaughtException 退出，所以这里能把「打死宿主」
 * 的异常变成可断言的失败，而不是让测试进程直接消失。
 */
async function withCrashWatch(fn) {
  const crashes = [];
  const onCrash = (err) => crashes.push(err);
  process.on('uncaughtException', onCrash);
  try {
    return { result: await fn(), crashes };
  } finally {
    process.off('uncaughtException', onCrash);
  }
}

/** 受 PIN 保护的代理（authCheck 会真正被走到）。 */
async function authProxy() {
  const up = await fakeUpstream();
  const proxy = await createPocketProxy({
    port: 0,
    host: '127.0.0.1',
    upstream: { host: '127.0.0.1', port: up.port },
    auth: { sessionKey: 'test-session-key', getToken: () => '12345678', isProtected: () => true },
  });
  return { proxy, up };
}

test('parseRequestTarget：畸形 absolute-form 返回 null，正常目标照常解析', () => {
  assert.equal(parseRequestTarget('http://['), null, '`http://[` 解析失败 → null');
  assert.equal(parseRequestTarget('http://'), null, '`http://` 解析失败 → null');
  assert.equal(parseRequestTarget('http://[::1'), null, '`http://[::1` 解析失败 → null');
  assert.equal(parseRequestTarget('/?token=abc').searchParams.get('token'), 'abc', '正常目标照常解析');
  assert.equal(parseRequestTarget(undefined).pathname, '/', '缺省按根路径');
});

test('HTTP：畸形请求目标 → 400 收口，不抛异常（修复前：authCheck 抛 Invalid URL 打死宿主）', async () => {
  const { proxy, up } = await authProxy();
  try {
    const { result: raw, crashes } = await withCrashWatch(() =>
      rawRequest(proxy.port, 'GET http://[ HTTP/1.1', ['Host: 127.0.0.1:' + proxy.port, 'Accept: text/html', 'Connection: close']));
    assert.deepEqual(crashes, [], '整个用例期间不得有未捕获异常');
    assert.match(raw, /^HTTP\/1\.1 400 /, `畸形请求目标应 400 收口；实际：${JSON.stringify(raw.slice(0, 60))}`);
    // 代理仍然活着：正常请求照常走到 PIN 闸门（未带 PIN → 登录页/401，不是 5xx/断连）
    const ok = await rawRequest(proxy.port, 'GET / HTTP/1.1', ['Host: 127.0.0.1:' + proxy.port, 'Accept: text/html', 'Connection: close']);
    assert.match(ok, /^HTTP\/1\.1 (200|401|403) /, `代理应仍可服务；实际：${JSON.stringify(ok.slice(0, 60))}`);
  } finally {
    await proxy.close();
    await new Promise((r) => up.server.close(r));
  }
});

test('WebSocket upgrade：畸形请求目标 → 400 拒绝握手，不抛异常', async () => {
  const { proxy, up } = await authProxy();
  try {
    const { result: raw, crashes } = await withCrashWatch(() =>
      rawRequest(proxy.port, 'GET http://[ HTTP/1.1', [
        'Host: 127.0.0.1:' + proxy.port,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
      ]));
    assert.deepEqual(crashes, [], '整个用例期间不得有未捕获异常');
    assert.match(raw, /^HTTP\/1\.1 400 /, `畸形升级请求应 400；实际：${JSON.stringify(raw.slice(0, 60))}`);
  } finally {
    await proxy.close();
    await new Promise((r) => up.server.close(r));
  }
});

test('正常请求不受影响：合法 ?token= 仍能通过 PIN 闸门并透传上游', async () => {
  const { proxy, up } = await authProxy();
  try {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/?token=12345678`, { headers: { Accept: 'application/json' } });
    assert.equal(res.status, 200, '合法 PIN 放行');
    assert.equal(await res.text(), 'path=/?token=12345678', '透传到假上游（未配置 launch token 时不改写路径）');
  } finally {
    await proxy.close();
    await new Promise((r) => up.server.close(r));
  }
});
