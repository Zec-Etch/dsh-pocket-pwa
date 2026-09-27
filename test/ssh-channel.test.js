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
  STDERR_TAIL_LINES,
  STDERR_TAIL_LINE_MAX,
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
/**
 * 转发失败的两条真实形态（dev-env 真机/真 ssh 实测）：
 *   - 本插件**始终**带 ExitOnForwardFailure=yes（buildSshArgs 固定加），
 *     所以干净行是 `Error: …`；`debug1: …` 是 -v 下先冒出来的那条。
 *   - `Warning: …` 只在**不带** ExitOnForwardFailure 时才出现，作为次要形态保留。
 * 主用例必须用生产真会出现的字符串，否则夹具会掩盖将来「干净行识别失效」的回归。
 */
const FORWARD_FAIL_LINE = 'Error: remote port forwarding failed for listen port 7788';
const FORWARD_FAIL_DEBUG_LINE = 'debug1: remote forward failure for: listen 127.0.0.1:7788, connect 127.0.0.1:3081';
const FORWARD_FAIL_WARNING_LINE = 'Warning: remote port forwarding failed for listen port 7788';

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
  assert.equal(st.lastError, FORWARD_FAIL_LINE, '主用例：生产真实形态（Error: …，因为始终带 ExitOnForwardFailure）');
  assert.equal(st.lastError, `Error: remote port forwarding failed for listen port ${DEFAULT_REMOTE_BIND_PORT}`);
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

// ---------- O1 / O2 / O3：dev-env 独立验证报告的三条观察项 ----------

/** 极简假核心（createTunnelImpl 注入）：用来构造「核心自己报 connected」的场景。 */
function fakeTunnelCore({ evidence = undefined, message = '' } = {}) {
  return (opts) => ({
    start() {
      opts.onState('starting', { message: 'starting' });
      opts.onState('connected', { ...(message === undefined ? {} : { message }), ...(evidence ? { evidence } : {}) });
    },
    stop() { opts.onState('stopped', { message: '已停止 | stopped' }); },
    snapshot: () => ({
      state: 'connected',
      lastError: null,
      target: { host: 'vps.example.com', user: 'u', port: 22, remote: '127.0.0.1:7788', local: '127.0.0.1:3081' },
      attempts: 0,
      nextRetryInMs: null,
      stderrTail: [],
    }),
  });
}

test('O3：connected 但没有结构化证据（消息为空 / 无 stderr）→ evidence=null，不再误报 forward-ok', () => {
  // 旧实现用 /graceMs|存活超过/.test(message) 反推：空消息会落进 else 分支 → 误报 forward-ok。
  const ch = createSshChannel({
    getConfig: () => ({ host: 'vps.example.com', user: 'u' }),
    getLocalPort: () => 3081,
    createTunnelImpl: fakeTunnelCore({ message: '' }),
  });
  ch.start();
  assert.equal(ch.status().state, 'connected');
  assert.equal(ch.status().evidence, null, '空消息 + 无 stderr → 如实回 null');
  ch.stop();

  // 连 message 都没有（undefined）时同样是 null
  const ch2 = createSshChannel({
    getConfig: () => ({ host: 'vps.example.com', user: 'u' }),
    getLocalPort: () => 3081,
    createTunnelImpl: fakeTunnelCore({ message: undefined }),
  });
  ch2.start();
  assert.equal(ch2.status().state, 'connected');
  assert.equal(ch2.status().evidence, null, '缺 message → null');
  ch2.stop();

  // 核心若显式给出结构化 evidence，则原样采用（未来核心版本可以这样接）
  const ch3 = createSshChannel({
    getConfig: () => ({ host: 'vps.example.com', user: 'u' }),
    getLocalPort: () => 3081,
    createTunnelImpl: fakeTunnelCore({ message: '', evidence: 'grace' }),
  });
  ch3.start();
  assert.equal(ch3.status().evidence, 'grace', '显式结构化字段优先');
  ch3.stop();

  // 观测层看不到 stderr（如 fd 桥接），但核心把就绪行原文交给了我们：
  // 用 lib/ssh.mjs 自己的分类器判定 → 仍然是 forward-ok（不是靠人话正则）
  const ch4 = createSshChannel({
    getConfig: () => ({ host: 'vps.example.com', user: 'u' }),
    getLocalPort: () => 3081,
    createTunnelImpl: fakeTunnelCore({ message: FORWARD_OK_LINE }),
  });
  ch4.start();
  assert.equal(ch4.status().evidence, 'forward-ok', '核心消息经分类器判定为就绪行');
  ch4.stop();

  // 有消息但不含就绪行 → 'grace'（非证据型 connected，不做过度声明）
  const ch5 = createSshChannel({
    getConfig: () => ({ host: 'vps.example.com', user: 'u' }),
    getLocalPort: () => 3081,
    createTunnelImpl: fakeTunnelCore({ message: 'ssh 存活超过 2500ms（未启用 -v 就绪行）' }),
  });
  ch5.start();
  assert.equal(ch5.status().evidence, 'grace', '无就绪行但有消息 → grace');
  ch5.stop();
});

test('O2：-v 下 lastError 展示观测到的干净原文（真实形态 Error: …）；干净行未到则原样显示 debug1，不臆造', async () => {
  const { spawnImpl, children } = fakeSpawn();
  const ch = createSshChannel({
    getConfig: () => ({ host: 'vps.example.com', user: 'dsh' }),
    getLocalPort: () => 3081,
    spawnImpl,
    reconnect: false,
    log: () => {},
  });
  ch.start();
  // 真机顺序：debug1 行先到（分类器据此 settleFatal），干净那行随后到
  children[0].stderr.emit('data', `${FORWARD_FAIL_DEBUG_LINE}\n`);
  await sleep(10);
  const beforeClean = ch.status();
  assert.equal(beforeClean.state, 'failed');
  assert.equal(beforeClean.lastError, FORWARD_FAIL_DEBUG_LINE, '只有 debug 行时**原样**显示它（不合成 Error: 文案）');
  assert.ok(!/^Error:/.test(String(beforeClean.lastError)), '干净行没到，就绝不臆造干净文案');

  children[0].stderr.emit('data', `${FORWARD_FAIL_LINE}\n`);
  const afterClean = ch.status();
  assert.equal(
    afterClean.lastError,
    FORWARD_FAIL_LINE,
    '干净行走的是观测原文（生产真实形态：Error: remote port forwarding failed for listen port 7788）',
  );
  assert.equal(afterClean.lastError, 'Error: remote port forwarding failed for listen port 7788');
  ch.stop();
});

test('O2（次要形态）：不带 ExitOnForwardFailure 时的 Warning: 前缀同样被识别并展示为观测原文', async () => {
  const { spawnImpl, children } = fakeSpawn();
  const ch = createSshChannel({
    getConfig: () => ({ host: 'vps.example.com', user: 'dsh' }),
    getLocalPort: () => 3081,
    spawnImpl,
    reconnect: false,
    log: () => {},
  });
  ch.start();
  children[0].stderr.emit('data', `${FORWARD_FAIL_DEBUG_LINE}\n`);
  await sleep(10);
  assert.match(String(ch.status().lastError), /^debug1:/, '先到的是 debug 行');
  children[0].stderr.emit('data', `${FORWARD_FAIL_WARNING_LINE}\n`);
  assert.equal(
    ch.status().lastError,
    FORWARD_FAIL_WARNING_LINE,
    'Warning 变体也走同一套「等值替换」，两种前缀都不会被漏掉',
  );
  assert.equal(ch.status().lastError, 'Warning: remote port forwarding failed for listen port 7788');
  ch.stop();
});

test('O1：status 暴露 attempts / nextRetryInMs / stderrTail（限长）/ target（无私钥路径）', async () => {
  const { spawnImpl, children } = fakeSpawn();
  const keyPath = '~/.ssh/id_ed25519';
  const ch = createSshChannel({
    getConfig: () => ({ host: 'vps.example.com', user: 'dsh', keyPath, remoteBindPort: 8899 }),
    getLocalPort: () => 3081,
    spawnImpl,
    log: () => {},
  });
  ch.start();
  const st = ch.status();
  assert.equal(st.attempts, 0, '首轮 attempts=0');
  assert.equal(st.nextRetryInMs, null, '未在退避中');
  assert.ok(Array.isArray(st.stderrTail), 'stderrTail 是数组');
  assert.equal(st.target.host, 'vps.example.com');
  assert.equal(st.target.user, 'dsh');
  assert.equal(st.target.remote, '127.0.0.1:8899');
  assert.equal(st.target.local, '127.0.0.1:3081');
  assert.ok(!JSON.stringify(st).includes('id_ed25519'), 'status 不含私钥路径');
  assert.ok(!JSON.stringify(st).includes('keyPath'), 'status 不含 keyPath 字段');

  // stderr 尾巴：限长（最多 STDERR_TAIL_LINES 行、每行 STDERR_TAIL_LINE_MAX 字符）
  for (let i = 0; i < 20; i++) children[0].stderr.emit('data', `noise-line-${i}-${'x'.repeat(900)}\n`);
  const st2 = ch.status();
  assert.equal(st2.stderrTail.length, STDERR_TAIL_LINES, `最多 ${STDERR_TAIL_LINES} 行`);
  assert.ok(st2.stderrTail.every((l) => l.length <= STDERR_TAIL_LINE_MAX), `每行最多 ${STDERR_TAIL_LINE_MAX} 字符`);
  assert.match(st2.stderrTail[st2.stderrTail.length - 1], /noise-line-19/, '保留最近的行');

  // 断线进入退避 → attempts / nextRetryInMs 有值，evidence 清空
  children[0].stderr.emit('data', 'ssh: connect to host vps.example.com port 22: Connection timed out\n');
  children[0].emit('exit', 255, null);
  await sleep(20);
  const st3 = ch.status();
  assert.equal(st3.state, 'reconnecting');
  assert.equal(st3.attempts, 1, '重连计数可见');
  assert.ok(st3.nextRetryInMs > 0, '重连倒计时可见');
  assert.equal(st3.evidence, null, '离开 connected 后不保留旧证据');
  ch.stop();
});
