// 回归（用户实测）：真实浏览器都会带 `accept-encoding: gzip/br`，上游 dsh web 会压缩 HTML；
// 而注入分支要求未压缩正文（`!isCompressed(proxyRes.headers)` 守卫），于是浏览器拿到的页面
// 里根本没有注入内容 —— 既没有 window.dshPocketPush（点「注册本机订阅」提示不支持、收不到
// 任务完成通知），也没有 window.dshPocketPasskey（设置页注册按钮报「宿主未注入接口」）。
//
// 修复：HTML 导航请求一律向上游要 identity（转发前删掉 accept-encoding），
// 静态资源与大 JSON 仍保持压缩。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { gzipSync } from 'node:zlib';

import { createPocketProxy } from '../lib/proxy.mjs';

const SHELL = '<!doctype html><html><head><title>shell</title></head><body>app</body></html>';

/** 假上游：客户端声明 gzip 就压缩返回（模拟真实 dsh web），并记录收到的 accept-encoding。 */
async function gzipUpstream() {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ path: req.url, acceptEncoding: req.headers['accept-encoding'] ?? null });
    const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
    if (acceptsGzip) {
      const body = gzipSync(Buffer.from(SHELL));
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-encoding': 'gzip',
        'content-length': String(body.length),
      });
      res.end(body);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': String(Buffer.byteLength(SHELL)) });
    res.end(SHELL);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, seen, close: () => new Promise((r) => server.close(r)) };
}

function getPath(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}`, accept: 'text/html', ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('回归：浏览器声明 gzip 时 HTML 注入仍生效（上游收到 identity），静态资源仍允许压缩', async () => {
  const up = await gzipUpstream();
  const proxy = await createPocketProxy({ port: 0, host: '127.0.0.1', upstream: { host: '127.0.0.1', port: up.port } });
  try {
    // 浏览器形态的导航请求：带 gzip/br
    const res = await getPath(proxy.port, '/', { 'accept-encoding': 'gzip, deflate, br' });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-encoding'], undefined, '代理应回未压缩的注入后 HTML');
    assert.ok(res.body.includes('data-dsh-pocket-polyfill'), '浏览器声明 gzip 时也必须注入 polyfill');
    assert.ok(res.body.includes('/pocket-pwa.js'), '必须注入 PWA 脚本（window.dshPocketPush / dshPocketPasskey 的来源）');
    assert.ok(res.body.includes('__DSH_POCKET_CFG__'), '必须注入通行密钥/推送配置');
    assert.ok(up.seen.at(-1)?.acceptEncoding == null, 'HTML 导航转发给上游时必须去掉 accept-encoding');

    // 非 HTML 资源不受影响：仍应把浏览器的 gzip 透传给上游
    // （注意 accept 不能带 text/html —— isHtmlRequest 会据此判定为导航）
    const js = await getPath(proxy.port, '/app.js', { accept: 'application/javascript', 'accept-encoding': 'gzip' });
    assert.equal(js.status, 200);
    assert.match(String(up.seen.at(-1)?.acceptEncoding ?? ''), /gzip/, '非 HTML 资源仍应允许上游压缩');

    // identity 声明时同样注入（原有行为不回退）
    const identity = await getPath(proxy.port, '/', { 'accept-encoding': 'identity' });
    assert.ok(identity.body.includes('/pocket-pwa.js'), 'identity 时也必须注入');
  } finally {
    await proxy.close();
    await up.close();
  }
});
