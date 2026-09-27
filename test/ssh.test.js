// lib/ssh.mjs（SSH 反向隧道核心）单元测试。
//
// 全部注入假 spawn，不依赖真实 sshd、不读任何私钥：
// 本机 DSH 沙箱下 child_process 用管道 stdio 会 EPERM（errno -4048），所以这里
// 连"跑一次真 ssh"都不做，argv / 状态迁移 / 定时器清理全部用假进程驱动。
// 运行：node --test --test-isolation=none --test-timeout=30000 test/ssh.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { buildSshArgs, classifySshLine, createSshTunnel } from '../lib/ssh.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FORWARD_OK = 'debug1: remote forward success for: listen 127.0.0.1:7788, connect 127.0.0.1:3081';

/** 验收用的真实目标配置：VPS dsh.solitarymc.top + Caddy 反代 127.0.0.1:7788 → 本机代理 3081。 */
const BASE = {
  host: 'dsh.solitarymc.top',
  user: 'dsh-penetration',
  remoteBindPort: 7788,
  localPort: 3081,
};

// ---------------------------------------------------------------------------
// 假 ssh 进程：只需要 EventEmitter 的那部分能力（tunnel 只用 .on/.once/.kill/.pid）
// ---------------------------------------------------------------------------

class FakeStream extends EventEmitter {
  constructor() {
    super();
    this.resumeCalls = 0;
  }
  resume() {
    this.resumeCalls += 1;
    return this;
  }
}

class FakeChild extends EventEmitter {
  constructor(pid, { killDelay = 5, noStreams = false } = {}) {
    super();
    this.pid = pid;
    this.stdout = noStreams ? null : new FakeStream();
    this.stderr = noStreams ? null : new FakeStream();
    this.killed = false;
    this.exitCode = null;
    this.signalCode = null;
    this.exited = false;
    this.killDelay = killDelay;
  }
  /** 真实 kill 是异步生效的：这里延迟 emit 'exit'，方便测"停-启"竞态。 */
  kill(signal = 'SIGTERM') {
    if (this.killed) return false;
    this.killed = true;
    this.signalCode = signal;
    setTimeout(() => {
      if (!this.exited) {
        this.exited = true;
        this.emit('exit', null, signal);
      }
    }, this.killDelay);
    return true;
  }
  say(line) {
    if (!this.stderr) throw new Error('该假进程没有 stderr（noStreams）');
    this.stderr.emit('data', Buffer.from(`${line}\n`));
    return this;
  }
  exit(code = 255) {
    if (this.exited) return this;
    this.exited = true;
    this.exitCode = code;
    this.emit('exit', code, null);
    return this;
  }
  failWith(code, message = code) {
    this.emit('error', Object.assign(new Error(message), { code }));
    return this;
  }
}

function makeHarness({ throwError = null, killDelay = 5, noStreams = false } = {}) {
  const calls = [];
  const children = [];
  const spawnImpl = (file, args, spawnOpts) => {
    calls.push({ file, args, opts: spawnOpts });
    if (throwError) throw Object.assign(new Error(throwError), { code: throwError });
    const child = new FakeChild(1000 + children.length, { killDelay, noStreams });
    children.push(child);
    return child;
  };
  return { calls, children, spawnImpl };
}

function setup({ cfg = BASE, harness = {}, opts = {} } = {}) {
  const h = makeHarness(harness);
  const states = [];
  const details = [];
  const tunnel = createSshTunnel({
    cfg,
    spawnImpl: h.spawnImpl,
    graceMs: 1000,
    reconnect: { enabled: true, delays: [10, 20, 30] },
    onState: (s, d) => {
      states.push(s);
      details.push(d);
    },
    ...opts,
  });
  return { ...h, tunnel, states, details };
}

function assertDetailShape(d) {
  assert.ok(d && typeof d === 'object', 'detail 必须是对象');
  assert.ok('message' in d, 'detail 必须含 message');
  assert.ok('code' in d, 'detail 必须含 code');
  assert.ok(Array.isArray(d.stderrTail), 'detail.stderrTail 必须是数组');
  assert.ok(d.message === null || typeof d.message === 'string');
  JSON.stringify(d); // 回调给 UI 的东西必须可序列化
}

// ---------------------------------------------------------------------------
// buildSshArgs
// ---------------------------------------------------------------------------

test('buildSshArgs: 最小配置（默认 22 端口、无 key、无 -v）→ 精确 argv', () => {
  assert.deepEqual(buildSshArgs(BASE), [
    '-N', '-T',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'BatchMode=yes',
    '-R', '127.0.0.1:7788:127.0.0.1:3081',
    'dsh-penetration@dsh.solitarymc.top',
  ]);
});

test('buildSshArgs: 自定义端口 / key / verbose / extraOptions / 自定义绑定 → 精确 argv', () => {
  const keyPath = 'C:\\Users\\me\\.ssh\\id_ed25519';
  assert.deepEqual(buildSshArgs({
    host: 'vps.example.com',
    user: 'deploy',
    port: 2222,
    keyPath,
    remoteBindHost: '0.0.0.0',
    remoteBindPort: 8443,
    localHost: '127.0.0.1',
    localPort: 3081,
    verbose: true,
    extraOptions: ['ConnectTimeout=10', 'ProxyCommand=nc %h %p'],
  }), [
    '-N', '-T',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'BatchMode=yes',
    '-i', keyPath, '-o', 'IdentitiesOnly=yes',
    '-p', '2222',
    '-v',
    '-o', 'ConnectTimeout=10',
    '-o', 'ProxyCommand=nc %h %p',
    '-R', '0.0.0.0:8443:127.0.0.1:3081',
    'deploy@vps.example.com',
  ]);
});

test('buildSshArgs: port=22 不加 -p；keyPath 为空不加 -i；verbose 默认 false；端口接受数字串', () => {
  const args = buildSshArgs({ ...BASE, port: 22 });
  assert.equal(args.includes('-p'), false, '22 端口是默认值，不必显式指定');
  assert.equal(args.includes('-i'), false, 'keyPath 为空 → 不加 -i，交给 ssh 默认身份/agent');
  assert.equal(args.includes('-v'), false);
  assert.deepEqual(buildSshArgs({ ...BASE, port: '2222', remoteBindPort: '7788' }).slice(0, 6), ['-N', '-T', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30']);
  const custom = buildSshArgs({ ...BASE, port: '2222' });
  assert.equal(custom[custom.indexOf('-p') + 1], '2222', '设置页写进来的数字串也要能用');
});

test('buildSshArgs: IPv6 监听地址自动加方括号（-R 的语法要求）', () => {
  const args = buildSshArgs({ ...BASE, remoteBindHost: '::1' });
  assert.equal(args[args.indexOf('-R') + 1], '[::1]:7788:127.0.0.1:3081');
});

test('buildSshArgs: 非法配置一律抛错（argv 注入防护 + 必填项）', () => {
  const cases = [
    [{ host: '-oProxyCommand=calc.exe', user: 'u', remoteBindPort: 1, localPort: 2 }, /host/],
    [{ host: 'dsh.solitarymc.top --x', user: 'u', remoteBindPort: 1, localPort: 2 }, /host/],
    [{ host: 'a\nb', user: 'u', remoteBindPort: 1, localPort: 2 }, /host/],
    [{ host: 'evil@other', user: 'u', remoteBindPort: 1, localPort: 2 }, /host/],
    [{ user: 'u', remoteBindPort: 1, localPort: 2 }, /host/],
    [{ host: 'ok.example.com', remoteBindPort: 1, localPort: 2 }, /user/],
    [{ ...BASE, user: '-root' }, /user/],
    [{ ...BASE, user: 'a b' }, /user/],
    [{ ...BASE, port: 0 }, /port/],
    [{ ...BASE, port: 70000 }, /port/],
    [{ ...BASE, port: '22x' }, /port/],
    [{ host: 'h', user: 'u', localPort: 2 }, /remoteBindPort/],
    [{ host: 'h', user: 'u', remoteBindPort: 7788 }, /localPort/],
    [{ ...BASE, remoteBindPort: 0 }, /remoteBindPort/],
    [{ ...BASE, localPort: 65536 }, /localPort/],
    [{ ...BASE, remoteBindHost: '127.0.0.1 ' }, /remoteBindHost/],
    [{ ...BASE, localHost: '127.0.0.1\tx' }, /localHost/],
    [{ ...BASE, keyPath: '-i' }, /keyPath/],
    [{ ...BASE, keyPath: 'C:\\Users\\a b\\.ssh\\id_ed25519' }, /keyPath/],
    [{ ...BASE, extraOptions: 'ConnectTimeout=10' }, /extraOptions/],
    [{ ...BASE, extraOptions: [1] }, /extraOptions/],
    [{ ...BASE, extraOptions: [''] }, /extraOptions/],
  ];
  for (const [cfg, re] of cases) {
    assert.throws(() => buildSshArgs(cfg), re, `应拒绝：${JSON.stringify(cfg)}`);
  }
  assert.throws(() => buildSshArgs(), /host/, '缺 cfg 也要抛错');
});

// ---------------------------------------------------------------------------
// classifySshLine
// ---------------------------------------------------------------------------

const SAMPLES = [
  [FORWARD_OK, 'forward-ok', false],
  ['remote forward success for: listen 127.0.0.1:7788, connect 127.0.0.1:3081', 'forward-ok', false],
  ['Warning: remote port forwarding failed for listen port 7788', 'forward-fail', true],
  ['debug1: remote forward failure for: listen 127.0.0.1:7788, connect 127.0.0.1:3081', 'forward-fail', true],
  ['channel 0: open failed: administratively prohibited: open failed', 'forward-fail', true],
  ['Permission denied (publickey).', 'auth-fail', true],
  ['dsh-penetration@dsh.solitarymc.top: Permission denied (publickey,password).', 'auth-fail', true],
  ['Received disconnect from 1.2.3.4 port 22:2: Too many authentication failures', 'auth-fail', true],
  ['Host key verification failed.', 'host-key', true],
  ['WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!', 'host-key', true],
  ['@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@', 'host-key', true],
  ['command-line: line 0: Bad configuration option: FooBarBaz', 'error', true],
  ['/home/u/.ssh/config: line 3: Bad configuration option: UseKeychain', 'error', true],
  ['bind: Address already in use', 'error', true],
  ['ssh: Could not resolve hostname dsh.solitarymc.top: Name or service not known', 'dns-fail', false],
  ['ssh: connect to host dsh.solitarymc.top port 22: Connection refused', 'refused', false],
  ['ssh: connect to host dsh.solitarymc.top port 22: Connection timed out', 'network', false],
  ['kex_exchange_identification: Connection closed by remote host', 'network', false],
  ['client_loop: send disconnect: Connection reset by peer', 'network', false],
  ['Timeout, server dsh.solitarymc.top not responding.', 'network', false],
  ['Warning: Identity file /home/u/.ssh/nope not accessible: No such file or directory.', 'error', false],
  ['ssh: something unexpected happened', 'error', false],
];

for (const [line, kind, fatal] of SAMPLES) {
  test(`classifySshLine: ${kind}${fatal ? '（致命）' : ''} ← ${line.slice(0, 52)}`, () => {
    const r = classifySshLine(line);
    assert.deepEqual(r, { kind, fatal, message: line.slice(0, 500) });
  });
}

test('classifySshLine: 正常噪音 / 已知主机提示 / 空行 → null（不能污染 lastError）', () => {
  const noise = [
    '',
    '   ',
    'debug1: Reading configuration data /etc/ssh/ssh_config',
    "debug1: Authenticating to dsh.solitarymc.top:22 as 'dsh-penetration'",
    'debug1: Next authentication method: publickey',
    'debug1: Authentications that can continue: publickey,password,keyboard-interactive',
    "Warning: Permanently added 'dsh.solitarymc.top,203.0.113.7' (ED25519) to the list of known hosts.",
    'debug1: Entering interactive session.',
    'debug1: Remote connections from LOCALHOST:7788 forwarded to local address 127.0.0.1:3081',
    'debug1: pledge: fork',
  ];
  for (const line of noise) assert.equal(classifySshLine(line), null, `应为 null：${line}`);
  assert.equal(classifySshLine(null), null);
  assert.equal(classifySshLine(undefined), null);
});

test('classifySshLine: 去掉首尾空白，并截断到 500 字符', () => {
  assert.equal(classifySshLine('   Permission denied (publickey).\t').message, 'Permission denied (publickey).');
  const long = `Host key verification failed. ${'x'.repeat(900)}`;
  assert.equal(classifySshLine(long).message.length, 500);
});

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

test('状态机: -v 就绪行 → connected；start() 幂等只 spawn 一次', async (t) => {
  const h = setup();
  t.after(() => h.tunnel.stop());
  assert.equal(h.tunnel.state(), 'idle');
  assert.equal(h.tunnel.lastError(), null);
  assert.equal(h.tunnel.start(), 'starting');
  assert.equal(h.tunnel.start(), 'starting');
  assert.equal(h.tunnel.start(), 'starting');
  assert.equal(h.children.length, 1, '重复 start 不产生第二个 ssh 进程');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].file, 'ssh');
  assert.deepEqual(h.calls[0].args, buildSshArgs(BASE));
  assert.deepEqual(h.calls[0].opts.stdio, ['ignore', 'pipe', 'pipe'], '生产默认 stdio 要能读 stderr');
  h.children[0].say("Warning: Permanently added 'dsh.solitarymc.top' (ED25519) to the list of known hosts.");
  h.children[0].say(FORWARD_OK);
  assert.equal(h.tunnel.state(), 'connected');
  assert.deepEqual(h.states, ['starting', 'connected']);
  assert.equal(h.details[1].pid, h.children[0].pid);
  assert.equal(h.tunnel.lastError(), null, '连上后清空 lastError');
  for (const d of h.details) assertDetailShape(d);
  const snap = JSON.parse(JSON.stringify(h.tunnel.snapshot()));
  assert.equal(snap.state, 'connected');
  assert.equal(snap.target.remote, '127.0.0.1:7788');
  assert.equal(snap.target.local, '127.0.0.1:3081');
  assert.deepEqual(snap.stderrTail.slice(-1), [FORWARD_OK]);
});

test('状态机: 没有 -v 就绪行时靠 graceMs 判定 connected', async (t) => {
  const h = setup({ opts: { graceMs: 20 } });
  t.after(() => h.tunnel.stop());
  h.tunnel.start();
  assert.equal(h.tunnel.state(), 'starting');
  await sleep(60);
  assert.equal(h.tunnel.state(), 'connected');
  assert.deepEqual(h.states, ['starting', 'connected']);
  assert.equal(h.children.length, 1);
});

test('状态机: 鉴权失败 → failed，杀进程且不再重连', async (t) => {
  const h = setup();
  t.after(() => h.tunnel.stop());
  h.tunnel.start();
  const deny = 'dsh-penetration@dsh.solitarymc.top: Permission denied (publickey).';
  h.children[0].say(deny);
  assert.equal(h.tunnel.state(), 'failed');
  assert.deepEqual(h.states, ['starting', 'failed']);
  assert.equal(h.details[1].code, 'auth-fail');
  assert.equal(h.details[1].reconnect, false);
  assert.match(h.tunnel.lastError(), /Permission denied/);
  assert.equal(h.details[1].stderrTail.at(-1), deny);
  assertDetailShape(h.details[1]);
  assert.equal(h.children[0].killed, true, '致命错误要主动杀掉 ssh，不能留僵尸');
  h.children[0].exit(255); // ssh 自己也会退：不应再触发任何状态变化
  await sleep(80);
  assert.equal(h.children.length, 1, 'fatal 后不重连');
  assert.equal(h.tunnel.state(), 'failed');
  assert.deepEqual(h.states, ['starting', 'failed']);
  assert.equal(h.tunnel.snapshot().nextRetryInMs, null);
});

test('状态机: 远端端口被占用（forward-fail）→ failed，不重连', async (t) => {
  const h = setup();
  t.after(() => h.tunnel.stop());
  h.tunnel.start();
  h.children[0].say('Warning: remote port forwarding failed for listen port 7788');
  assert.equal(h.tunnel.state(), 'failed');
  assert.deepEqual(h.states, ['starting', 'failed']);
  assert.equal(h.details[1].code, 'forward-fail');
  assert.match(h.tunnel.lastError(), /remote port forwarding failed/);
  await sleep(80);
  assert.equal(h.children.length, 1);
});

test('状态机: 网络掉线 → reconnecting → 退避后重连成功', async (t) => {
  const h = setup({ opts: { graceMs: 1000, reconnect: { enabled: true, delays: [10, 20] } } });
  t.after(() => h.tunnel.stop());
  h.tunnel.start();
  h.children[0].say(FORWARD_OK);
  assert.equal(h.tunnel.state(), 'connected');
  h.children[0].say('ssh: connect to host dsh.solitarymc.top port 22: Connection timed out');
  h.children[0].exit(255);
  assert.equal(h.tunnel.state(), 'reconnecting');
  assert.equal(h.tunnel.snapshot().nextRetryInMs, 10, '第一次重连用 delays[0]');
  assert.match(h.tunnel.lastError(), /Connection timed out/);
  await sleep(50);
  assert.equal(h.children.length, 2, '退避到点后重新 spawn');
  assert.equal(h.tunnel.state(), 'starting');
  assert.deepEqual(h.calls[1].args, h.calls[0].args, '重连 argv 与首次完全一致');
  assert.equal(h.tunnel.snapshot().stderrTail.length, 0, '新会话的 stderrTail 重置');
  h.children[1].say(FORWARD_OK);
  assert.equal(h.tunnel.state(), 'connected');
  assert.equal(h.tunnel.lastError(), null);
  assert.deepEqual(h.states, ['starting', 'connected', 'reconnecting', 'starting', 'connected']);
  for (const d of h.details) assertDetailShape(d);
});

test('状态机: 退避用到末位后一直用末位（不会无限放大）', async (t) => {
  const h = setup({ opts: { graceMs: 1000, reconnect: { enabled: true, delays: [10, 20, 30] } } });
  t.after(() => h.tunnel.stop());
  h.tunnel.start();
  for (let i = 0; i < 5; i++) {
    const child = h.children[i];
    assert.ok(child, `第 ${i + 1} 个子进程应已 spawn`);
    child.say('ssh: connect to host dsh.solitarymc.top port 22: Connection timed out');
    child.exit(255);
    await sleep(60);
  }
  const retryDelays = h.details.filter((d) => d.retryInMs != null).map((d) => d.retryInMs);
  assert.deepEqual(retryDelays, [10, 20, 30, 30, 30]);
  assert.equal(h.children.length, 6, '第 6 次 spawn 已发生（末位 30ms 内）');
  assert.equal(h.tunnel.state(), 'starting');
  assert.equal(h.tunnel.snapshot().attempts, 5);
});

test('状态机: 连接成功后重试计数归零（下次掉线仍从最短退避开始）', async (t) => {
  const h = setup({ opts: { graceMs: 1000, reconnect: { enabled: true, delays: [10, 20, 30] } } });
  t.after(() => h.tunnel.stop());
  h.tunnel.start();
  h.children[0].say('ssh: connect to host dsh.solitarymc.top port 22: Connection timed out');
  h.children[0].exit(255);
  await sleep(40);
  h.children[1].say(FORWARD_OK);
  assert.equal(h.tunnel.snapshot().attempts, 0, '连上后计数归零');
  h.children[1].exit(255);
  assert.equal(h.tunnel.snapshot().nextRetryInMs, 10, '下次掉线仍用最短退避');
});

test('状态机: reconnect.enabled=false → 掉线直接 failed，不重连', async (t) => {
  const h = setup({ opts: { reconnect: { enabled: false, delays: [10] } } });
  t.after(() => h.tunnel.stop());
  h.tunnel.start();
  h.children[0].exit(255);
  assert.equal(h.tunnel.state(), 'failed');
  assert.deepEqual(h.states, ['starting', 'failed']);
  assert.equal(h.tunnel.snapshot().reconnectEnabled, false);
  await sleep(50);
  assert.equal(h.children.length, 1);
});

test('状态机: stop() 取消等待中的重连，之后永不 spawn', async (t) => {
  const h = setup({ opts: { graceMs: 1000, reconnect: { enabled: true, delays: [50, 100] } } });
  t.after(() => h.tunnel.stop());
  h.tunnel.start();
  h.children[0].exit(255);
  assert.equal(h.tunnel.state(), 'reconnecting');
  assert.equal(h.tunnel.snapshot().nextRetryInMs, 50);
  h.tunnel.stop();
  assert.equal(h.tunnel.state(), 'stopped');
  assert.equal(h.tunnel.snapshot().nextRetryInMs, null, 'stop 必须清掉重连定时器');
  await sleep(220);
  assert.equal(h.children.length, 1, 'stop 后不再重连');
  assert.equal(h.tunnel.state(), 'stopped');
  h.tunnel.stop(); // 幂等：不重复回调
  assert.deepEqual(h.states, ['starting', 'reconnecting', 'stopped']);
});

test('状态机: stop() 后 graceMs 不再把状态改成 connected（定时器已清）', async (t) => {
  const h = setup({ opts: { graceMs: 20 } });
  t.after(() => h.tunnel.stop());
  h.tunnel.start();
  h.tunnel.stop();
  await sleep(70);
  assert.equal(h.tunnel.state(), 'stopped');
  assert.deepEqual(h.states, ['starting', 'stopped']);
});

test('状态机: stop() 后再 start() 可重新工作（含"旧 ssh 还没退干净"的竞态）', async (t) => {
  const h = setup({ harness: { killDelay: 30 } });
  t.after(() => h.tunnel.stop());
  h.tunnel.start();
  h.children[0].say(FORWARD_OK);
  assert.equal(h.tunnel.state(), 'connected');
  h.tunnel.stop();
  assert.equal(h.children[0].killed, true, 'stop 必须杀掉存活进程');
  assert.equal(h.tunnel.state(), 'stopped');
  // 立刻 start：旧进程还在退出中 → 必须等它退出，否则两个 ssh 会抢同一个远端端口
  assert.equal(h.tunnel.start(), 'starting');
  assert.equal(h.children.length, 1, '旧进程退出前不 spawn 第二个 ssh');
  await sleep(90);
  assert.equal(h.children.length, 2, '旧进程退出后自动补上新的 spawn');
  assert.equal(h.tunnel.state(), 'starting');
  h.children[1].say(FORWARD_OK);
  assert.equal(h.tunnel.state(), 'connected');
  assert.deepEqual(h.calls[1].args, h.calls[0].args);
  assert.deepEqual(h.states, ['starting', 'connected', 'stopped', 'starting', 'starting', 'connected']);
});

test('状态机: idle 直接 stop() → stopped；重复 stop 只回调一次', () => {
  const h = setup();
  assert.equal(h.tunnel.state(), 'idle');
  h.tunnel.stop();
  h.tunnel.stop();
  assert.equal(h.tunnel.state(), 'stopped');
  assert.deepEqual(h.states, ['stopped']);
  assert.equal(h.children.length, 0);
});

test('状态机: failed 之后用户再 start() 可以重新尝试', async (t) => {
  const h = setup();
  t.after(() => h.tunnel.stop());
  h.tunnel.start();
  h.children[0].say('Host key verification failed.');
  assert.equal(h.tunnel.state(), 'failed');
  h.children[0].exit(255);
  assert.equal(h.tunnel.start(), 'starting');
  assert.equal(h.children.length, 2);
  h.children[1].say(FORWARD_OK);
  assert.equal(h.tunnel.state(), 'connected');
  assert.deepEqual(h.states, ['starting', 'failed', 'starting', 'connected']);
});

test('spawn 同步抛错（ENOENT / 沙箱 EPERM）→ failed，不重连', async (t) => {
  const h = setup({ harness: { throwError: 'ENOENT' } });
  t.after(() => h.tunnel.stop());
  assert.equal(h.tunnel.start(), 'failed');
  assert.deepEqual(h.states, ['starting', 'failed']);
  assert.match(h.tunnel.lastError(), /ENOENT/);
  await sleep(50);
  assert.equal(h.children.length, 0);
  assert.equal(h.tunnel.state(), 'failed');
  assert.equal(h.tunnel.snapshot().pid, null, 'spawn 没成功就不该有 pid');

  // 本机 DSH 沙箱下默认 spawnImpl + 管道 stdio 就是这条路径：Node 对 EPERM 是
  // 同步 throw（不是 error 事件），必须被接住并落到 failed，而不是崩宿主进程
  const sandboxed = setup({ harness: { throwError: 'EPERM' }, opts: { reconnect: { enabled: true, delays: [10] } } });
  t.after(() => sandboxed.tunnel.stop());
  assert.equal(sandboxed.tunnel.start(), 'failed');
  assert.deepEqual(sandboxed.states, ['starting', 'failed']);
  assert.equal(sandboxed.tunnel.lastError(), 'ssh 启动失败：EPERM | failed to spawn ssh');
  await sleep(50);
  assert.equal(sandboxed.children.length, 0, 'EPERM 重试也还是 EPERM');
});

test('spawn error 事件：ENOENT 致命 → failed；EMFILE 非致命 → reconnecting', async (t) => {
  const fatal = setup();
  t.after(() => fatal.tunnel.stop());
  fatal.tunnel.start();
  fatal.children[0].failWith('ENOENT', 'spawn ssh ENOENT');
  assert.equal(fatal.tunnel.state(), 'failed');
  assert.equal(fatal.details.at(-1).code, 'ENOENT');
  assert.match(fatal.tunnel.lastError(), /ENOENT/);
  await sleep(50);
  assert.equal(fatal.children.length, 1, 'ENOENT 重试也没用');

  const retry = setup();
  t.after(() => retry.tunnel.stop());
  retry.tunnel.start();
  retry.children[0].failWith('EMFILE', 'spawn ssh EMFILE');
  assert.equal(retry.tunnel.state(), 'reconnecting', '句柄耗尽这类可恢复错误要重试');
  await sleep(50);
  assert.equal(retry.children.length, 2);
});

test('配置非法：start() 抛错 + 状态 failed + lastError（错误不会被吞掉）', async (t) => {
  const h = setup({ cfg: { host: '-evil.example.com', user: 'u', remoteBindPort: 1, localPort: 2 } });
  t.after(() => h.tunnel.stop());
  assert.throws(() => h.tunnel.start(), /host/);
  assert.equal(h.tunnel.state(), 'failed');
  assert.match(h.tunnel.lastError(), /host/);
  assert.deepEqual(h.states, ['failed']);
  assert.equal(h.children.length, 0);
});

test('stdioFactory: 注入的 stdio 透传给 spawn（受限沙箱可传 fd / ignore）', async (t) => {
  const h = setup({ harness: { noStreams: true }, opts: { graceMs: 20, stdioFactory: ({ cfg, args }) => {
    assert.equal(cfg.host, BASE.host);
    assert.ok(args.includes('-R'));
    return ['ignore', 'ignore', 'ignore'];
  } } });
  t.after(() => h.tunnel.stop());
  h.tunnel.start();
  assert.deepEqual(h.calls[0].opts.stdio, ['ignore', 'ignore', 'ignore']);
  assert.equal(h.tunnel.state(), 'starting');
  await sleep(60);
  assert.equal(h.tunnel.state(), 'connected', '拿不到 stderr 管道时靠 graceMs 兜底，不能崩');
});

test('stdioFactory 抛错 → failed + 抛给调用方', async (t) => {
  const h = setup({ opts: { stdioFactory: () => { throw new Error('沙箱不允许管道 stdio'); } } });
  t.after(() => h.tunnel.stop());
  assert.throws(() => h.tunnel.start(), /stdioFactory/);
  assert.equal(h.tunnel.state(), 'failed');
  assert.match(h.tunnel.lastError(), /沙箱不允许管道 stdio/);
  assert.equal(h.children.length, 0);
});

test('stderrTail: 只保留最近 N 行（默认 50，不随进程寿命无限增长）', async (t) => {
  const h = setup({ opts: { tailLines: 3, graceMs: 1000 } });
  t.after(() => h.tunnel.stop());
  h.tunnel.start();
  for (let i = 0; i < 10; i++) h.children[0].say(`debug1: 噪音行 ${i}`);
  h.children[0].say(FORWARD_OK);
  const snap = h.tunnel.snapshot();
  assert.equal(snap.state, 'connected');
  assert.deepEqual(snap.stderrTail, ['debug1: 噪音行 8', 'debug1: 噪音行 9', FORWARD_OK]);

  const big = setup({ opts: { graceMs: 1000 } });
  t.after(() => big.tunnel.stop());
  big.tunnel.start();
  for (let i = 0; i < 60; i++) big.children[0].say(`debug1: 噪音行 ${i}`);
  assert.equal(big.tunnel.snapshot().stderrTail.length, 50, '默认上限 50 行');
  assert.equal(big.tunnel.snapshot().stderrTail.at(-1), 'debug1: 噪音行 59');
});

test('snapshot(): JSON 可序列化、字段稳定、不携带私钥路径', async (t) => {
  const keyPath = 'C:\\Users\\me\\.ssh\\id_ed25519';
  const h = setup({ cfg: { ...BASE, keyPath, verbose: true } });
  t.after(() => h.tunnel.stop());
  const idle = JSON.parse(JSON.stringify(h.tunnel.snapshot()));
  assert.equal(idle.state, 'idle');
  assert.equal(idle.pid, null);
  assert.equal(idle.nextRetryInMs, null);
  h.tunnel.start();
  const snap = JSON.parse(JSON.stringify(h.tunnel.snapshot()));
  assert.equal(snap.state, 'starting');
  assert.equal(snap.lastError, null);
  assert.equal(snap.target.host, 'dsh.solitarymc.top');
  assert.equal(snap.target.user, 'dsh-penetration');
  assert.equal(snap.target.port, 22);
  assert.equal(snap.target.remote, '127.0.0.1:7788');
  assert.equal(snap.target.local, '127.0.0.1:3081');
  assert.equal(snap.pid, h.children[0].pid);
  assert.equal(snap.reconnectEnabled, true);
  assert.deepEqual(snap.stderrTail, []);
  assert.equal(JSON.stringify(snap).includes('.ssh'), false, '快照不给 UI 带本机私钥路径');
  assert.equal(JSON.stringify(snap).includes('undefined'), false);
});

test('onState 回调抛错不影响状态机（UI 崩了隧道也要活着）', async (t) => {
  const h = setup({ opts: { graceMs: 20, onState: () => { throw new Error('UI 炸了'); } } });
  t.after(() => h.tunnel.stop());
  h.tunnel.start();
  await sleep(60);
  assert.equal(h.tunnel.state(), 'connected');
  h.tunnel.stop();
  assert.equal(h.tunnel.state(), 'stopped');
  assert.equal(h.children[0].killed, true);
});

test('资源泄漏：stop() 收掉所有定时器与子进程（测试进程可正常退出）', async (t) => {
  const h = setup({ opts: { graceMs: 1000, reconnect: { enabled: true, delays: [10, 20] } } });
  h.tunnel.start();
  h.children[0].say(FORWARD_OK);
  h.children[0].exit(255); // 进入重连等待
  assert.equal(h.tunnel.state(), 'reconnecting');
  h.tunnel.stop();
  await sleep(150);
  assert.equal(h.children.length, 1, '没有第 2 个 ssh');
  assert.equal(h.tunnel.state(), 'stopped');
  assert.equal(h.tunnel.snapshot().nextRetryInMs, null);
  assert.equal(h.tunnel.snapshot().pid, null);
});
