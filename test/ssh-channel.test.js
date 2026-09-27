// dsh-pocket：SSH 反向隧道通道（lib/ssh-channel.mjs）单元测试
//
// 全部注入假 spawn（沙箱下 child_process 用管道 stdio 会 EPERM），不需要真 sshd。
// 覆盖：argv 形状（-v 就绪证据 / -R 目标 / keyPath 有无）、状态流转与证据来源、
// 致命错误（远端端口被占）立即 failed、配置变更后重建、停止幂等、访问地址拼接。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  createSshChannel,
  normalizeSshChannelConfig,
  buildAccessUrl,
  toTunnelConfig,
  DEFAULT_SSH_PORT,
  DEFAULT_REMOTE_BIND_PORT,
} from '../lib/ssh-channel.mjs';

/** 假子进程：EventEmitter + stdout/stderr 流 + kill。 */
function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stdout.resume = () => {};
  child.stderr = new EventEmitter();
  child.stderr.resume = () => {};
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    setImmediate(() => child.emit('exit', 0, null));
    return true;
  };
  return child;
}

/** 假 spawn：记录 argv，返回可手动喂 stderr 的子进程。 */
function fakeSpawn() {
  const calls = [];
  const children = [];
  const spawnImpl = (cmd, args, opts) => {
    const child = fakeChild();
    calls.push({ cmd, args, opts, child });
    children.push(child);
    return child;
  };
  return { spawnImpl, calls, children };
}

/** 一次就绪行（OpenSSH -v 的真实输出形态，dev-env 在真机上实测过）。 */
const FORWARD_OK_LINE = 'debug1: remote forward success for: listen 127.0.0.1:7788, connect 127.0.0.1:3081';
const FORWARD_FAIL_LINE = 'Warning: remote port forwarding failed for listen port 7788';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('buildAccessUrl：https 默认端口省略、http/自定义端口保留、accessHost 回退 host', () => {
  assert.equal(buildAccessUrl({ host: 'vps.example.com' }), 'https://vps.example.com');
  assert.equal(buildAccessUrl({ host: 'vps.example.com', accessProtocol: 'https', accessPort: 443 }), 'https://vps.example.com');
  assert.equal(buildAccessUrl({ host: 'vps.example.com', accessPort: 8443 }), 'https://vps.example.com:8443');
  assert.equal(buildAccessUrl({ host: 'vps.example.com', accessProtocol: 'http', accessPort: 80 }), 'http://vps.example.com');
  // accessHost 优先（Caddy 对外域名可以和 SSH 主机不同）
  assert.equal(buildAccessUrl({ host: '10.0.0.9', accessHost: 'dsh.example.com' }), 'https://dsh.example.com');
  // 主机串里已经带端口 → 不再追加
  assert.equal(buildAccessUrl({ accessHost: 'dsh.example.com:9443', accessPort: 8443 }), 'https://dsh.example.com:9443');
  assert.equal(buildAccessUrl({}), null, '没有主机名时返回 null');
});

test('normalizeSshChannelConfig：缺省值（22 / 127.0.0.1 / 7788 / https / autoRestore）', () => {
  const c = normalizeSshChannelConfig({ host: 'vps.example.com' });
  assert.equal(c.port, DEFAULT_SSH_PORT);
  assert.equal(c.remoteBindHost, '127.0.0.1');
  assert.equal(c.remoteBindPort, DEFAULT_REMOTE_BIND_PORT);
  assert.equal(c.accessProtocol, 'https');
  assert.equal(c.accessPort, 0);
  assert.equal(c.autoRestore, true);
  assert.equal(c.keyPath, '', '默认不指定 -i');
  // 非法端口回退默认值（设置层已校验，这里只做兜底）
  assert.equal(normalizeSshChannelConfig({ port: 99999 }).port, 22);
  assert.equal(normalizeSshChannelConfig({ autoRestore: false }).autoRestore, false);
});

test('toTunnelConfig：user 留空回退系统用户名；主机缺失/代理端口未知抛可读错误', () => {
  const cfg = toTunnelConfig({ host: 'vps.example.com', user: 'dsh' }, 3081);
  assert.equal(cfg.user, 'dsh');
  assert.equal(cfg.localPort, 3081);
  assert.equal(cfg.localHost, '127.0.0.1');
  const fallback = toTunnelConfig({ host: 'vps.example.com' }, 3081, { getDefaultUser: () => 'alice' });
  assert.equal(fallback.user, 'alice', 'sshUser 留空 = ssh 默认行为（当前系统用户）');
  assert.throws(() => toTunnelConfig({ host: 'vps.example.com' }, 0), /代理端口/);
});

test('createSshChannel：start 用 -v 拿就绪行证据（connected + evidence=forward-ok），argv 形状正确', async () => {
  const { spawnImpl, calls, children } = fakeSpawn();
  const ch = createSshChannel({
    getConfig: () => ({ host: 'vps.example.com', user: 'dsh', keyPath: '', remoteBindPort: 7788 }),
    getLocalPort: () => 3081,
    spawnImpl,
    log: () => {},
  });
  const st = ch.start();
  assert.equal(st.state, 'starting', 'start 是异步连上，先 starting');
  assert.equal(calls.length, 1, '只 spawn 一个 ssh');
  assert.equal(calls[0].cmd, 'ssh');
  const argv = calls[0].args;
  assert.ok(argv.includes('-v'), '-v：没有就绪行就只能靠 grace 猜，生产必须带');
  assert.ok(argv.includes('-N') && argv.includes('-T'), '只要转发不要 shell');
  assert.ok(argv.includes('ExitOnForwardFailure=yes'), '远端端口被占时立刻退出');
  assert.equal(argv[argv.length - 1], 'dsh@vps.example.com');
  const rIdx = argv.indexOf('-R');
  assert.equal(argv[rIdx + 1], '127.0.0.1:7788:127.0.0.1:3081', '-R 远端绑定:本地代理');
  assert.ok(!argv.includes('-i'), 'keyPath 为空 → 不加 -i（用 ssh 默认逻辑）');

  children[0].stderr.emit('data', 'debug1: Reading configuration data /etc/ssh/ssh_config\n');
  assert.equal(ch.status().state, 'starting', '调试噪音不算连上');
  children[0].stderr.emit('data', `${FORWARD_OK_LINE}\n`);
  const st2 = ch.status();
  assert.equal(st2.state, 'connected');
  assert.equal(st2.evidence, 'forward-ok', '连上的证据是就绪行');
  assert.equal(st2.running, true);
  assert.equal(st2.lastError, null);
  assert.equal(st2.url, 'https://vps.example.com', 'status 顺带给出访问地址');
  // 状态快照不得泄露私钥路径（keyPath 为空这里只验证字段不存在）
  assert.ok(!JSON.stringify(st2).includes('keyPath'));

  ch.stop();
  assert.equal(ch.status().state, 'stopped');
  assert.equal(ch.status().running, false);
  assert.equal(children[0].killed, true, 'stop 杀掉 ssh 进程');
});

test('createSshChannel：指定 keyPath 时加 -i + IdentitiesOnly；远端端口占用立即 failed', async () => {
  const { spawnImpl, calls, children } = fakeSpawn();
  const ch = createSshChannel({
    getConfig: () => ({ host: 'vps.example.com', user: 'dsh', keyPath: '~/.ssh/id_ed25519' }),
    getLocalPort: () => 3081,
    spawnImpl,
    reconnect: false, // 致命错误本来就不重连，这里明确关掉以免测试等待
  });
  ch.start();
  const argv = calls[0].args;
  const iIdx = argv.indexOf('-i');
  assert.equal(argv[iIdx + 1], '~/.ssh/id_ed25519');
  assert.ok(argv.includes('IdentitiesOnly=yes'));

  children[0].stderr.emit('data', `${FORWARD_FAIL_LINE}\n`);
  await sleep(10);
  const st = ch.status();
  assert.equal(st.state, 'failed', '远端端口被占 → 立即 failed，不能让 UI 显示已连接');
  assert.match(st.lastError ?? '', /forwarding failed|7788/);
  assert.equal(st.running, false);
});

test('createSshChannel：拿不到 stderr 时按 grace 兜底连上，证据标记为 grace', async () => {
  const { spawnImpl } = fakeSpawn();
  const ch = createSshChannel({
    getConfig: () => ({ host: 'vps.example.com', user: 'dsh' }),
    getLocalPort: () => 3081,
    spawnImpl,
    graceMs: 15,
    log: () => {},
  });
  ch.start();
  await sleep(60);
  const st = ch.status();
  assert.equal(st.state, 'connected');
  assert.equal(st.evidence, 'grace', '没有就绪行 → 证据是 grace 兜底（不能被当成同等可信）');
  ch.stop();
});

test('createSshChannel：配置变更（主机 / 代理端口）后重建进程，旧进程先被杀', async () => {
  const { spawnImpl, calls, children } = fakeSpawn();
  let config = { host: 'vps-a.example.com', user: 'dsh' };
  let localPort = 3081;
  const ch = createSshChannel({ getConfig: () => config, getLocalPort: () => localPort, spawnImpl, log: () => {} });
  ch.start();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[calls[0].args.length - 1], 'dsh@vps-a.example.com');

  config = { host: 'vps-b.example.com', user: 'dsh' };
  ch.start();
  assert.equal(calls.length, 2, '配置变了要重新 spawn');
  assert.equal(calls[1].args[calls[1].args.length - 1], 'dsh@vps-b.example.com');
  assert.equal(children[0].killed, true, '旧进程先停，避免两个 ssh 抢同一个远端端口');

  localPort = 3099;
  ch.start();
  assert.equal(calls.length, 3, '代理端口变了也要重建（-R 目标变了）');
  assert.equal(calls[2].args[calls[2].args.indexOf('-R') + 1], '127.0.0.1:7788:127.0.0.1:3099');
  ch.stop();
});

test('createSshChannel：幂等 start（同配置不重复 spawn）；未配置主机/端口未知抛可读错误', () => {
  const { spawnImpl, calls } = fakeSpawn();
  const ch = createSshChannel({
    getConfig: () => ({ host: 'vps.example.com', user: 'dsh' }),
    getLocalPort: () => 3081,
    spawnImpl,
  });
  ch.start();
  ch.start();
  ch.start();
  assert.equal(calls.length, 1, 'start 幂等：连点开关不会拉起多个 ssh');
  ch.stop();

  const noHost = createSshChannel({ getConfig: () => ({}), getLocalPort: () => 3081 });
  assert.throws(() => noHost.start(), /SSH 主机未配置/);
  const noPort = createSshChannel({ getConfig: () => ({ host: 'v.example.com', user: 'u' }), getLocalPort: () => 0 });
  assert.throws(() => noPort.start(), /代理端口/);
});

test('createSshChannel：非法用户名（空白/含 @）由 ssh 核心拒绝并落到 failed 状态', () => {
  const { spawnImpl } = fakeSpawn();
  const ch = createSshChannel({
    getConfig: () => ({ host: 'vps.example.com', user: 'bad user' }),
    getLocalPort: () => 3081,
    spawnImpl,
  });
  assert.throws(() => ch.start(), /空白|user/);
  assert.equal(ch.status().state, 'failed', '配置错误必须同时可见（抛错 + 状态）');
});
