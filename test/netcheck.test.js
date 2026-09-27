// 宿主进程网络自检：DNS / TCP / HTTPS 探针 + 进程网络环境。
// 用途：定位「推送网络错误: fetch failed」的真实原因（超时/DNS/代理/端口）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { probeHost, diagnoseNotify, shortError, processNetEnv, PUSH_SERVICE_HOSTS } from '../lib/netcheck.mjs';

test('probeHost：回环地址 DNS 解析成功、TCP 可连；对 http 端口做 https 探针如实失败', async () => {
  const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const r = await probeHost('127.0.0.1', { port, timeoutMs: 2000 });
    assert.ok(r.dns.includes('127.0.0.1'), `DNS 应解析出回环地址，实际：${r.dns}`);
    assert.equal(r.tcp.find((x) => x.family === 4)?.ok, true, 'IPv4 TCP 应可连接');
    assert.ok(r.http, 'HTTPS 探针结果应存在');
    assert.equal(r.http.ok, false, '明文 http 端口上做 https 探针应失败（不谎报成功）');
    assert.ok(String(r.http.error).length > 0, '失败必须带原因');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('probeHost：无法解析的主机名给出可读的 DNS 失败', async () => {
  const r = await probeHost('no-such-host.invalid', { timeoutMs: 1000 });
  assert.match(r.dns, /DNS 失败/);
  assert.equal(r.tcp.length, 0, 'DNS 失败时不做 TCP 探测');
});

test('diagnoseNotify：始终包含三大推送服务，并纳入订阅端点与 Webhook 主机', async () => {
  const r = await diagnoseNotify({
    endpoints: ['https://updates.push.services.mozilla.com/wpush/v2/fake-token'],
    webhookUrl: 'http://127.0.0.1:9/hook',
    timeoutMs: 300, // 只关心"探测了哪些目标、结果结构如何"，不依赖外网可达
  });
  const hosts = r.results.map((x) => x.host);
  for (const h of PUSH_SERVICE_HOSTS) assert.ok(hosts.includes(h), `应包含推送服务 ${h}`);
  assert.ok(hosts.includes('updates.push.services.mozilla.com'), '订阅端点主机应在列表里');
  assert.ok(hosts.includes('127.0.0.1'), 'Webhook 主机应在列表里');
  for (const item of r.results) {
    assert.equal(typeof item.host, 'string');
    assert.ok(Array.isArray(item.tcp), '每个目标都要有 TCP 结果数组');
  }
  assert.equal(typeof r.env.node, 'string');
  assert.equal(processNetEnv().node, r.env.node);
});

test('shortError：把 undici 的真实原因（cause.code）带出来，而不是只显示 fetch failed', () => {
  const err = new TypeError('fetch failed');
  err.cause = Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
  assert.match(shortError(err), /UND_ERR_CONNECT_TIMEOUT/);
  assert.match(shortError(new Error('plain')), /plain/);
});
