// downloadFile 多线程分块下载测试：本地起一个支持 Range 的服务器，
// 验证分块并发下载 + 合并后字节与源完全一致；以及不支持 Range 时回退单线程。
//
// 离线约束（为什么这个文件必须**完全离线**）：
//   resolveCloudflared 的缓存未命中路径会真的去 GitHub / 国内加速源下 20MB
//   cloudflared（downloadCloudflared 的兜底超时是 120s）。在受限网络（CI / 本沙箱）
//   里那次下载会挂到超时，曾经让整个测试套件从 ~4s 涨到 ~121s，而且结果不确定。
//   因此本文件里所有 resolveCloudflared 用例都必须：
//     1) 命中缓存目录里的文件（不进入下载分支），并且断言「从未触发 downloading 阶段」；
//     2) 额外传一个短的 AbortSignal——万一断言前提被打破（缓存命中逻辑被改坏），
//        下载会立刻被中止并抛出，而不是让整个套件白等 120s 再失败。
//   两个 downloadFile 用例用本机 127.0.0.1 的假 Range 服务器，本来就不碰公网。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { downloadFile, platformAssets, resolveCloudflared } from '../lib/tunnel.mjs';

/** 假二进制内容：4MB 可预测字节（> MIN_PARALLEL_SIZE，触发分块）。 */
function makePayload(size) {
  const buf = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) buf[i] = (i * 31 + 7) & 0xff;
  return buf;
}

/** 支持/不支持 Range 的服务器。 */
async function rangeServer(payload, { supportRange }) {
  const server = createServer((req, res) => {
    const range = req.headers.range;
    if (supportRange && range) {
      const m = /bytes=(\d+)-(\d+)/.exec(range);
      const start = Number(m[1]);
      const end = Number(m[2]);
      res.writeHead(206, {
        'content-type': 'application/octet-stream',
        'content-range': `bytes ${start}-${end}/${payload.length}`,
        'content-length': end - start + 1,
        'accept-ranges': 'bytes',
      });
      res.end(payload.subarray(start, end + 1));
    } else {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': payload.length,
        ...(supportRange ? { 'accept-ranges': 'bytes' } : {}),
      });
      res.end(payload);
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, server };
}

/** 缓存目录里 code 会去找的两个文件名（bin 名 / 发布资产名），与 lib/tunnel.mjs 一致。 */
function cacheFileNames(platform, arch) {
  const osName = platform === 'darwin' ? 'darwin' : platform === 'win32' ? 'windows' : 'linux';
  const archMap = { x64: 'amd64', arm64: 'arm64' };
  const a = archMap[arch] ?? arch;
  const ext = osName === 'windows' ? '.exe' : '';
  return { binName: `cloudflared${ext}`, assetName: `cloudflared-${osName}-${a}${ext}` };
}

/**
 * 在「模拟指定 platform」的窗口里执行 fn。
 *
 * resolveCloudflared 的 Homebrew 坏缓存识别是 `os === 'linux'` 分支，而本机/CI 可能是
 * Windows —— 不模拟就永远走不到那段逻辑（旧版测试因此在 win32 上既没验证到行为，
 * 又因为文件名少个 .exe 没命中缓存，真的去公网下了 20MB）。
 * 描述符原样保存/恢复（异常路径也恢复），窗口内不做别的 IO，避免影响同进程的其它测试。
 */
async function withPlatform(platform, fn) {
  const pd = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return await fn();
  } finally {
    if (pd) Object.defineProperty(process, 'platform', pd);
  }
}

/** 兜底信号：断言前提被打破时，下载会在 1.5s 内被中止，而不是挂 120s。 */
const NO_NETWORK = () => AbortSignal.timeout(1500);

test('downloadFile：支持 Range 时多线程分块，合并后字节与源一致', async () => {
  const payload = makePayload(4 * 1024 * 1024);
  const { port, server } = await rangeServer(payload, { supportRange: true });
  const dir = await mkdtemp(join(tmpdir(), 'dl-par-'));
  try {
    const dest = join(dir, 'out.bin');
    const len = await downloadFile(`http://127.0.0.1:${port}/cf`, dest, { segments: 8 });
    assert.equal(len, payload.length, '返回总字节数');
    const got = await readFile(dest);
    assert.equal(got.length, payload.length, '合并后长度一致');
    assert.ok(got.equals(payload), '合并后字节完全一致');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await new Promise((r) => server.close(r));
  }
});

test('downloadFile：不支持 Range 时回退单线程，字节一致', async () => {
  const payload = makePayload(3 * 1024 * 1024);
  const { port, server } = await rangeServer(payload, { supportRange: false });
  const dir = await mkdtemp(join(tmpdir(), 'dl-single-'));
  try {
    const dest = join(dir, 'out.bin');
    const len = await downloadFile(`http://127.0.0.1:${port}/cf`, dest, { segments: 8 });
    assert.equal(len, payload.length);
    const got = await readFile(dest);
    assert.ok(got.equals(payload), '单线程回退字节一致');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await new Promise((r) => server.close(r));
  }
});

test('resolveCloudflared：手动放置的资产名文件也能命中缓存（issue #15）', async () => {
  const { binName, assetName } = cacheFileNames(process.platform, process.arch);
  const home = await mkdtemp(join(tmpdir(), 'dshp-manual-'));
  const binDir = join(home, 'dsh-pocket', 'bin');
  try {
    // 只放资产名文件（不是 bin 名）→ 应命中，不触发下载
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, assetName), 'fake-binary');
    assert.equal(await readFile(join(binDir, binName)).catch(() => null), null, '前提：bin 名文件不存在（否则命中的是它）');
    const phases = [];
    const bin = await resolveCloudflared({ home, onPhase: (p) => phases.push(p), signal: NO_NETWORK() });
    assert.ok(!phases.includes('downloading'), '未触发下载阶段（离线可跑）');
    assert.equal(bin, join(binDir, assetName), '命中资产名文件: ' + bin);
    // 反方向：同目录放一个 bin 名文件后，bin 名优先级更高（issue #15 的兼容顺序）
    await writeFile(join(binDir, binName), 'fake-binary-2');
    const bin2 = await resolveCloudflared({ home, onPhase: () => {}, signal: NO_NETWORK() });
    assert.equal(bin2, join(binDir, binName), 'bin 名文件存在时优先命中它');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('resolveCloudflared：Linux 上丢弃 Homebrew bottle 坏缓存（issue #22）', async () => {
  const assetArch = { x64: 'amd64', arm64: 'arm64' }[process.arch] ?? process.arch;
  const assetName = `cloudflared-linux-${assetArch}`;
  const binName = 'cloudflared';
  const home = await mkdtemp(join(tmpdir(), 'dshp-homebrew-'));
  const binDir = join(home, 'dsh-pocket', 'bin');
  try {
    await mkdir(binDir, { recursive: true });
    // 候选 1：模拟 Linux Homebrew bottle 坏缓存（ELF 解释器是 @@HOMEBREW_PREFIX@@ 占位符）
    const badBin = join(binDir, binName);
    await writeFile(badBin, '@@HOMEBREW_PREFIX@@/lib/ld.so\x00fake-binary');
    // 候选 2：一个干净的资产名缓存 —— 坏缓存被丢弃后应当命中它。
    // 有它才能证明「丢弃坏缓存后继续走缓存查找」，而不是掉进真实下载（离线约束）。
    const cleanBin = join(binDir, assetName);
    await writeFile(cleanBin, 'fake-binary');

    const phases = [];
    const bin = await withPlatform('linux', () => resolveCloudflared({
      home,
      onPhase: (p) => phases.push(p),
      signal: NO_NETWORK(),
    }));

    assert.ok(!phases.includes('downloading'), '丢弃坏缓存后直接命中干净缓存，不该触发下载');
    assert.equal(bin, cleanBin, '没有把坏缓存当可用二进制返回: ' + bin);
    assert.equal(await readFile(badBin).catch(() => null), null, '坏缓存文件已被删除（不可再被 spawn）');

    // 反向守护：把候选 1 换成**干净**文件后应当命中它 —— 证明上面的丢弃是
    // 由 @@HOMEBREW_PREFIX@@ 触发，而不是「候选 1 永远被跳过」。
    await writeFile(badBin, 'clean-fake-binary');
    const bin2 = await withPlatform('linux', () => resolveCloudflared({
      home,
      onPhase: (p) => phases.push(p),
      signal: NO_NETWORK(),
    }));
    assert.equal(bin2, badBin, '干净缓存（候选 1）正常命中');
    assert.ok(!phases.includes('downloading'), '反向用例同样不触发下载');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('隧道 URL 解析（issue #32）：排除 api.trycloudflare.com 保留子域', async () => {
  const { QUICK_TUNNEL_URL_RE } = await import('../lib/tunnel.mjs');
  // 正常隧道 URL 匹配
  assert.match('https://abc123-def.trycloudflare.com', QUICK_TUNNEL_URL_RE);
  // 保留子域 api 不匹配（扫码打开 api 端点会返回 code 10005 Method Not Allowed）
  assert.doesNotMatch('https://api.trycloudflare.com', QUICK_TUNNEL_URL_RE);
  // cloudflared 输出里 api 地址先出现时，第一个匹配必须是隧道 URL
  const output = 'INF registering tunnel at https://api.trycloudflare.com/...\nYour quick tunnel: https://xyz789.trycloudflare.com\n';
  const m = output.match(QUICK_TUNNEL_URL_RE);
  assert.ok(m && m[0] === 'https://xyz789.trycloudflare.com', '不误匹配 api 地址: ' + (m && m[0]));
});

// ---------- 发布资产名（issue #45） ----------

test('platformAssets（issue #45）：linux 首选裸二进制，不再拼上游已下架的 .tgz', async () => {
  const onPlatform = (platform, arch) => {
    const pd = Object.getOwnPropertyDescriptor(process, 'platform');
    const ad = Object.getOwnPropertyDescriptor(process, 'arch');
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    Object.defineProperty(process, 'arch', { value: arch, configurable: true });
    try {
      return platformAssets();
    } finally {
      if (pd) Object.defineProperty(process, 'platform', pd);
      if (ad) Object.defineProperty(process, 'arch', ad);
    }
  };
  // 2026-08 起 cloudflared 不再发布 cloudflared-linux-<arch>.tgz（实测 404），
  // 只有裸二进制 cloudflared-linux-<arch>。以前我们在 linux 上拼的是 .tgz，
  // 五个镜像全指向同一个 404 → 必然「所有源都不通」。
  assert.deepEqual(onPlatform('linux', 'x64'), ['cloudflared-linux-amd64', 'cloudflared-linux-amd64.tgz']);
  assert.deepEqual(onPlatform('linux', 'arm64'), ['cloudflared-linux-arm64', 'cloudflared-linux-arm64.tgz']);
  assert.deepEqual(onPlatform('linux', 'ia32'), ['cloudflared-linux-386', 'cloudflared-linux-386.tgz']);
  // .tgz 只作为回退排在后面：首个候选必须是不需要解压的裸二进制
  assert.ok(!onPlatform('linux', 'x64')[0].endsWith('.tgz'), 'linux 首选资产不该是 .tgz');
  // 其他平台的布局没变
  assert.deepEqual(onPlatform('darwin', 'arm64'), ['cloudflared-darwin-arm64.tgz']);
  assert.deepEqual(onPlatform('darwin', 'x64'), ['cloudflared-darwin-amd64.tgz']);
  assert.deepEqual(onPlatform('win32', 'x64'), ['cloudflared-windows-amd64.exe']);
  // 真实环境（本机）至少有一个候选
  assert.ok(platformAssets().length >= 1);
});
