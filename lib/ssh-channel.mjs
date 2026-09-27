// dsh-pocket：SSH 反向隧道通道（自有 VPS）
//
// 职责边界：
//   - lib/ssh.mjs 只管「ssh 进程 + 状态机」（buildSshArgs / classifySshLine / createSshTunnel）；
//   - 本文件把「设置里的 SSH 参数 + 本机代理端口」翻译成 ssh 的 cfg，负责幂等启动/停止、
//     配置变更后重建、对外状态快照（**不含私钥路径**）；
//   - 对外访问地址（accessProtocol/accessHost/accessPort → URL）与二维码由 lib/service.mjs
//     负责（那里才有 QR 缓存与 status 拼接）。
//
// 私钥：只把 keyPath 字符串交给 ssh（`-i <path>`），从不读取/解析内容；
// status() 只回 keyPathSet 布尔值。
//
// 沙箱兼容：DSH 沙箱下 child_process 用管道 stdio 会 EPERM，spawnImpl/stdioFactory
// 由调用方注入（生产走 lib/ssh.mjs 默认值；测试注入假 spawn 或文件 fd）。

import { userInfo } from 'node:os';
import { spawn as nodeSpawn } from 'node:child_process';
import { createSshTunnel, classifySshLine } from './ssh.mjs';

export const DEFAULT_SSH_PORT = 22;
export const DEFAULT_REMOTE_BIND_HOST = '127.0.0.1';
export const DEFAULT_REMOTE_BIND_PORT = 7788;
export const DEFAULT_ACCESS_PROTOCOL = 'https';
/** ssh -R 的另一端：本机 DSH 代理（永远走回环）。 */
export const DEFAULT_LOCAL_HOST = '127.0.0.1';
/** status().stderrTail 展示上限：行数 / 每行字符数（诊断够用，且不随进程寿命增长）。 */
export const STDERR_TAIL_LINES = 5;
export const STDERR_TAIL_LINE_MAX = 500;
/** 观测层自己的行缓冲上限（只用于 stderr 分帧，不进状态机）。 */
const OBSERVE_BUF_MAX = 8192;
/** debug 变体行的形状判定（`debug1: …`）——只用于展示层偏好，不做语义推断。 */
const DEBUG_LINE_RE = /^debug\d*:/i;

/** 当前操作系统用户名：sshUser 留空时的回退（等价于 `ssh host` 的默认行为）。 */
function defaultUserName() {
  try {
    return String(userInfo().username ?? '').trim();
  } catch {
    return '';
  }
}

/**
 * 归一化 SSH 通道配置（设置页/测试注入都可能只给一半字段）。
 *
 * @param {object} [raw] `{ host, port, user, keyPath, remoteBindHost, remoteBindPort,
 *   accessProtocol, accessHost, accessPort, autoRestore }`
 * @returns {{host:string, port:number, user:string, keyPath:string, remoteBindHost:string,
 *   remoteBindPort:number, accessProtocol:'https'|'http', accessHost:string, accessPort:number,
 *   autoRestore:boolean}}
 */
export function normalizeSshChannelConfig(raw = {}) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const port = Number(cfg.port);
  const remoteBindPort = Number(cfg.remoteBindPort);
  const accessPort = Number(cfg.accessPort);
  return {
    host: String(cfg.host ?? '').trim(),
    port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_SSH_PORT,
    user: String(cfg.user ?? '').trim(),
    keyPath: String(cfg.keyPath ?? '').trim(),
    remoteBindHost: String(cfg.remoteBindHost ?? '').trim() || DEFAULT_REMOTE_BIND_HOST,
    remoteBindPort: Number.isInteger(remoteBindPort) && remoteBindPort >= 1 && remoteBindPort <= 65535
      ? remoteBindPort
      : DEFAULT_REMOTE_BIND_PORT,
    accessProtocol: cfg.accessProtocol === 'http' ? 'http' : DEFAULT_ACCESS_PROTOCOL,
    accessHost: String(cfg.accessHost ?? '').trim(),
    accessPort: Number.isInteger(accessPort) && accessPort >= 0 && accessPort <= 65535 ? accessPort : 0,
    autoRestore: cfg.autoRestore !== false,
  };
}

/**
 * 由 accessProtocol + accessHost(+accessPort) 拼公网访问地址。
 * 与 client/api.js 的 buildAccessUrl 规则一致（accessHost 为空回退 sshHost；
 * 端口为 0 或协议默认端口时省略；主机串已带端口时不再追加）。
 *
 * @returns {string|null} 缺主机名时返回 null
 */
export function buildAccessUrl(cfg) {
  const c = normalizeSshChannelConfig(cfg);
  const host = c.accessHost || c.host;
  if (!host) return null;
  const proto = c.accessProtocol === 'http' ? 'http' : 'https';
  const defaultPort = proto === 'http' ? 80 : 443;
  const needPort = c.accessPort !== 0 && c.accessPort !== defaultPort && !/:\d+$/.test(host);
  return `${proto}://${host}${needPort ? `:${c.accessPort}` : ''}`;
}

/**
 * 翻译成 lib/ssh.mjs 的 cfg。
 *
 * `user` 留空时回退到当前系统用户名（`ssh host` 的默认语义）。ssh 需要
 * `user@host`，而 buildSshArgs 会拒绝空 user —— 这里补齐后再交给它校验，
 * 用户名含空白等非法字符时由 buildSshArgs 抛可读错误（提示去设置页填用户名）。
 */
export function toTunnelConfig(cfg, localPort, { localHost = DEFAULT_LOCAL_HOST, getDefaultUser = defaultUserName } = {}) {
  const c = normalizeSshChannelConfig(cfg);
  const local = Number(localPort);
  if (!Number.isInteger(local) || local < 1 || local > 65535) {
    throw new Error('本机代理端口未知（代理还没启动？） | local proxy port is unknown');
  }
  const out = {
    host: c.host,
    port: c.port,
    remoteBindHost: c.remoteBindHost,
    remoteBindPort: c.remoteBindPort,
    localHost,
    localPort: local,
    // -v：让「连上了」有证据（OpenSSH 会打印
    // `debug1: remote forward success for: listen 127.0.0.1:7788, connect 127.0.0.1:3081`）。
    // 不带 -v 时一次成功的 ssh 在 stdout/stderr 上写 0 字节，只能靠 graceMs 猜——
    // 有了就绪行，状态机才在「真的转发成功」时才置 connected（lib/ssh.mjs 的 classifySshLine）。
    verbose: true,
  };
  const user = c.user || String(getDefaultUser() ?? '').trim();
  if (user) out.user = user;
  if (c.keyPath) out.keyPath = c.keyPath;
  return out;
}

/**
 * 创建 SSH 通道控制器。
 *
 * @param {object} opts
 * @param {() => object} opts.getConfig 读设置（每次调用都重新读磁盘 → 设置页改完即时生效）
 * @param {() => number} opts.getLocalPort 本机代理端口（ssh -R 的目标端口）
 * @param {Function} [opts.createTunnelImpl] 注入 createSshTunnel（测试用）
 * @param {Function} [opts.spawnImpl] 注入 spawn（沙箱/测试；转交 createSshTunnel）
 * @param {Function} [opts.stdioFactory] 注入 stdio（受限环境用文件 fd 或 'ignore'）
 * @param {number} [opts.graceMs] 无就绪行时的判定窗口
 * @param {object|false} [opts.reconnect] 重连退避配置
 * @param {Function} [opts.getDefaultUser] 覆盖默认用户名来源（测试用）
 * @param {Function} [opts.onState] (state, detail) => void，状态变化回调（外部只读）
 * @param {Function} [opts.log] 日志
 * @returns {{start:Function, stop:Function, status:Function, snapshot:Function, config:Function, url:Function}}
 */
export function createSshChannel({
  getConfig,
  getLocalPort,
  createTunnelImpl,
  spawnImpl,
  stdioFactory,
  graceMs,
  reconnect,
  getDefaultUser,
  onState,
  log = () => {},
} = {}) {
  const makeTunnel = typeof createTunnelImpl === 'function' ? createTunnelImpl : createSshTunnel;
  let tunnel = null;      // 当前 createSshTunnel 实例
  let signature = '';     // 当前实例的配置签名（配置变了就重建）
  let started = false;    // 用户意图：start 过且没 stop
  let state = 'idle';
  let lastError = null;
  let target = null;      // 脱敏目标视图（host/user/port/remote/local）
  let evidence = null;    // 最近一次 connected 的**结构化**证据：'forward-ok' | 'grace' | null

  // ---------- stderr 观测层（结构化证据 + 展示层文案偏好） ----------
  // 为什么要在 spawn 外面套一层：lib/ssh.mjs 是冻结的（分类语义已由 dev-env 真机验证），
  // 但通道需要两件它不提供的信息：
  //   1) evidence 的结构化来源 —— 用 lib/ssh.mjs 自己的 classifySshLine 判定 stderr 行，
  //      而不是拿人话文案正则反推（O3）；
  //   2) -v 常开时优先展示干净的错误行（O2）。
  // 观测层只加一个 'data' 监听（核心自己也监听同一流，Node 支持多监听），
  // 全程 try/catch：诊断层出任何问题都不能影响隧道本身。
  let sawForwardOk = false;      // 本次尝试里看到过就绪行
  let stderrObservable = false;  // 本次尝试里 stderr 是否可观测（决定 evidence 能否判 'grace'）
  let forwardFailDebug = null;   // 最近一条 debug 变体的 forward-fail 原文
  let forwardFailClean = null;   // 最近一条干净变体的 forward-fail 原文（展示优先用它）
  let observeBuf = '';

  function observeLine(raw) {
    const info = classifySshLine(raw);
    if (!info) return;
    if (info.kind === 'forward-ok') {
      sawForwardOk = true;
      return;
    }
    if (info.kind === 'forward-fail') {
      if (DEBUG_LINE_RE.test(info.message)) forwardFailDebug = info.message;
      else forwardFailClean = info.message;
    }
  }

  function onStderrChunk(chunk) {
    try {
      observeBuf += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      if (observeBuf.length > OBSERVE_BUF_MAX) observeBuf = observeBuf.slice(-OBSERVE_BUF_MAX);
      let idx;
      while ((idx = observeBuf.indexOf('\n')) >= 0) {
        const line = observeBuf.slice(0, idx);
        observeBuf = observeBuf.slice(idx + 1);
        observeLine(line.endsWith('\r') ? line.slice(0, -1) : line);
      }
    } catch { /* 观测层绝不影响隧道 */ }
  }

  /** 每次真正 spawn 之前重置观测状态（重连后的证据必须反映最新一次尝试）。 */
  function beginAttempt(child) {
    sawForwardOk = false;
    stderrObservable = false;
    observeBuf = '';
    const stderr = child?.stderr;
    if (stderr && typeof stderr.on === 'function') {
      stderrObservable = true;
      try {
        stderr.on('data', onStderrChunk);
        stderr.on('error', () => {}); // kill 后的 EPIPE 不能变成未处理事件
      } catch { /* 自定义 stdio 的伪流：拿不到就算了（evidence 退化为 null） */ }
    }
  }

  /**
   * 证据判定（**结构化，禁止自己拿人话文案正则反推**）：
   *   1) 核心/替身显式给了 detail.evidence → 原样采用；
   *   2) 观测层看到过 forward-ok 行，或核心给的 connected 消息**经 lib/ssh.mjs 自己的
   *      分类器 classifySshLine 判定为 forward-ok**（fd 桥接 stderr 等观测层看不到流、
   *      但核心拿得到就绪行的情况）→ 'forward-ok'；
   *   3) 没有就绪行、但 stderr 可观测或核心给了消息（= graceMs 兜底判定，或未来新增的连接
   *      路径）→ 'grace'（含义是「非证据型 connected」，不做过度声明）；
   *   4) 什么都拿不到（stderr 不可观测 + 消息为空）→ null，绝不错报 forward-ok。
   */
  function structuredEvidence(detail) {
    const explicit = detail?.evidence;
    if (explicit === 'forward-ok' || explicit === 'grace') return explicit;
    const message = typeof detail?.message === 'string' ? detail.message.trim() : '';
    if (sawForwardOk) return 'forward-ok';
    if (message && classifySshLine(message)?.kind === 'forward-ok') return 'forward-ok';
    if (stderrObservable || message !== '') return 'grace';
    return null;
  }

  /**
   * 展示层文案偏好（O2）：核心拿到的是「先出现的那条 fatal 行」，-v 下往往是
   * `debug1: remote forward failure for: listen …`；同一类错误的干净变体更适合用户。
   *
   * 干净行的真实前缀（dev-env 真机实测）：
   *   - `Error: remote port forwarding failed for listen port N` —— 本插件**始终**带
   *     `ExitOnForwardFailure=yes`（buildSshArgs 固定加），所以线上就是这条；
   *   - `Warning: …` 只在**不带**该选项时才出现（那种情况下 ssh 会带着死转发继续活着），
   *     这里同样识别，作为次要形态。
   * 只做「等值替换」：当前消息必须恰好是我观测到的那条 debug 原文，才换成我观测到的
   * 干净原文——不合成、不拼接、拿不到就原样保留。分类语义不变。
   */
  function displayError(message) {
    if (typeof message !== 'string' || !message) return message ?? null;
    if (forwardFailClean && forwardFailDebug && message === forwardFailDebug) return forwardFailClean;
    return message;
  }

  function readConfig() {
    return normalizeSshChannelConfig(typeof getConfig === 'function' ? (getConfig() ?? {}) : {});
  }

  function readLocalPort() {
    const n = Number(typeof getLocalPort === 'function' ? getLocalPort() : 0);
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 0;
  }

  function handleState(next, detail = {}) {
    state = next;
    if (next === 'connected') {
      lastError = null;
      evidence = structuredEvidence(detail); // 结构化；拿不到就是 null（见 O3）
    } else if (next === 'starting' || next === 'reconnecting' || next === 'failed') {
      if (next !== 'starting') evidence = null; // 离开 connected 后不再保留旧证据
      if (detail?.message) lastError = displayError(String(detail.message));
    } else if (next === 'stopped' || next === 'idle') {
      evidence = null;
    }
    try {
      onState?.(next, detail);
    } catch (err) {
      log(`onState 回调抛错（已忽略）：${err?.message ?? err}`);
    }
  }

  /** 取（必要时新建）与当前配置匹配的状态机实例。 */
  function ensureTunnel() {
    const cfg = readConfig();
    if (!cfg.host) {
      throw new Error('SSH 主机未配置：请先在设置页填写自有服务器的域名或 IP | SSH host is not configured');
    }
    const localPort = readLocalPort();
    const tunnelCfg = toTunnelConfig(cfg, localPort, { getDefaultUser });
    const sig = JSON.stringify(tunnelCfg);
    if (tunnel && sig === signature) return tunnel;
    if (tunnel) {
      // 配置/端口变了：旧实例先停（同一远端端口不能有两个 ssh 抢）
      try { tunnel.stop(); } catch { /* 旧实例已停 */ }
      tunnel = null;
    }
    const instance = makeTunnel({
      cfg: tunnelCfg,
      // 永远套一层观测代理：即使调用方没注入 spawnImpl，也要能拿到 stderr 证据
      // （默认仍然走 node:child_process.spawn，异常/EPERM 语义不变——直接透传抛出）
      spawnImpl: (cmd, args, opts) => {
        const base = typeof spawnImpl === 'function' ? spawnImpl : nodeSpawn;
        const child = base(cmd, args, opts);
        beginAttempt(child);
        return child;
      },
      ...(stdioFactory ? { stdioFactory } : {}),
      ...(Number.isFinite(graceMs) ? { graceMs } : {}),
      ...(reconnect !== undefined ? { reconnect } : {}),
      log,
      onState: handleState,
    });
    if (!instance || typeof instance.start !== 'function') {
      throw new Error('createSshTunnel 返回了非法实例 | invalid ssh tunnel instance');
    }
    tunnel = instance;
    signature = sig;
    const snap = typeof instance.snapshot === 'function' ? instance.snapshot() : null;
    target = snap?.target ?? { host: cfg.host, user: tunnelCfg.user ?? null, port: cfg.port, remote: null, local: null };
    return instance;
  }

  /**
   * 幂等启动。未配置主机 / 代理端口未知时抛可读错误（由 RPC 转成错误响应）；
   * 配置错误（用户名非法等）由 buildSshArgs 抛出，同时状态已被置成 failed。
   */
  function start() {
    const instance = ensureTunnel();
    started = true;
    instance.start();
    return status();
  }

  /** 幂等停止：停 ssh 进程、状态置 stopped、清掉历史错误（手动停止不该显示旧错误）。 */
  function stop() {
    started = false;
    if (tunnel) {
      try { tunnel.stop(); } catch (err) { log(`停止 ssh 隧道失败：${err?.message ?? err}`); }
    }
    state = 'stopped';
    lastError = null;
    evidence = null;
    return status();
  }

  function isRunning() {
    return started && (state === 'starting' || state === 'connected' || state === 'reconnecting');
  }

  /**
   * 对外状态（JSON 安全、无密钥路径）。
   *
   * `evidence` 说明 connected 是怎么来的（结构化判定，见 structuredEvidence）：
   *   - 'forward-ok'：stderr 里看到了 ssh 的就绪行（生产默认，config 带 verbose: true）；
   *   - 'grace'：没看到就绪行、但 stderr 可观测且核心给了消息（= graceMs 兜底判定）；
   *   - null：当前不是 connected，或拿不到任何结构化证据。
   *
   * `stderrTail` 只保留最近 STDERR_TAIL_LINES 行、每行截到 STDERR_TAIL_LINE_MAX 字符
   * （排障最有用的一条，但绝不能无限增长）。
   * @returns {{running:boolean, state:string, lastError:string|null, url:string|null,
   *   target:object|null, attempts:number, nextRetryInMs:number|null, stderrTail:string[], evidence:string|null}}
   */
  function status() {
    const snap = tunnel && typeof tunnel.snapshot === 'function' ? tunnel.snapshot() : null;
    const tail = Array.isArray(snap?.stderrTail) ? snap.stderrTail : [];
    return {
      running: isRunning(),
      state,
      lastError: displayError(lastError),
      url: buildAccessUrl(readConfig()),
      target,
      attempts: Number.isFinite(snap?.attempts) ? snap.attempts : 0,
      nextRetryInMs: Number.isFinite(snap?.nextRetryInMs) ? snap.nextRetryInMs : null,
      stderrTail: tail.slice(-STDERR_TAIL_LINES).map((line) => String(line ?? '').slice(0, STDERR_TAIL_LINE_MAX)),
      evidence,
    };
  }

  return {
    start,
    stop,
    status,
    /** 完整状态机快照（诊断用；调用方负责脱敏）。 */
    snapshot: () => (tunnel && typeof tunnel.snapshot === 'function' ? tunnel.snapshot() : null),
    config: readConfig,
    url: () => buildAccessUrl(readConfig()),
    /** 当前是否已创建状态机实例（切换通道时用于判断要不要停）。 */
    attached: () => tunnel !== null,
  };
}
