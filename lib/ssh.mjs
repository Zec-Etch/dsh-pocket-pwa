// dsh-pocket：SSH 反向端口转发（第三种公网通道：用户自有 VPS）
//
// 链路：手机 → https://<VPS 域名>（VPS 上的 Caddy，443） → 127.0.0.1:7788
//       （VPS 上 sshd 的反向转发监听口） → SSH 隧道 → 本机 127.0.0.1:3081
//       （dsh-pocket 代理）→ DSH。
//
// 为什么远端只绑 127.0.0.1：公网入口只应该有 Caddy 的 443。把转发口绑到
// 0.0.0.0 等于再开一个无 TLS 的明文洞口（dsh web 能执行代码），所以默认只绑
// 回环，TLS + 访问密码交给 Caddy。
//
// 认证：完全交给系统 ssh —— keyPath 为空就不加 -i，用 ssh 自己的默认逻辑
// （~/.ssh/config、ssh-agent、默认身份文件）。本模块从不读取 / 解析 / 记录任何
// 私钥内容，也不去碰 ~/.ssh。
//
// 沙箱兼容（本仓库实测约束）：DSH 沙箱下 child_process 用管道 stdio 会 EPERM
// （errno -4048，"spawn EPERM"）。所以 spawn 的 stdio 交给可注入的 stdioFactory：
// 生产默认 ['ignore','pipe','pipe']（必须读 stderr 才能解析 -v 的就绪行），受限
// 环境可传文件 fd 或 'ignore'（拿不到 stderr 就靠 graceMs 兜底判定成功）。
//
// 本模块无 import 期副作用，也不依赖 cloudflared（lib/tunnel.mjs）；测试全部注入
// 假 spawn，不需要真实 sshd。

import { spawn as nodeSpawn } from 'node:child_process';

/** 重连退避（毫秒）：末位是上限，之后一直用末位，避免指数放大到几小时。 */
const DEFAULT_RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 15000, 30000];
/** 没有 -v 就绪行时，进程活过这段时间即认为连通（-v 才有 "remote forward success"）。 */
const DEFAULT_GRACE_MS = 2500;
/** stderr 只保留最近这么多行（状态展示够用，且不随进程寿命无限增长）。 */
const DEFAULT_TAIL_LINES = 50;
/** 生产默认：stdin 用不到（-N -T），stdout 无输出，stderr 要解析就绪/错误行。 */
const DEFAULT_STDIO = ['ignore', 'pipe', 'pipe'];
/** 单行缓冲上限：病态的超长无换行输出不能把内存吃掉。 */
const MAX_LINE_CHARS = 4096;
/** 展示用错误信息上限（与 lib/tunnel.mjs 的 500 字符保持一致）。 */
const MESSAGE_MAX = 500;
/** kill 之后等 exit 的安全上限：进程赖着不退也不能让下一次 start 永远起不来。 */
const KILL_EXIT_TIMEOUT_MS = 1500;
/** 重连没有意义的 spawn 错误：ssh 不存在 / 被沙箱拒绝 / 参数非法。 */
const FATAL_SPAWN_CODES = new Set(['ENOENT', 'EPERM', 'EACCES', 'EINVAL', 'ENOTDIR']);

const SPACE_OR_CONTROL = /[\s\u0000-\u001f\u007f]/;
const CONTROL = /[\u0000-\u001f\u007f]/;

// ---------------------------------------------------------------------------
// argv 构造
// ---------------------------------------------------------------------------

/**
 * argv 注入防护：值会作为 ssh 的位置参数（host/user）或选项参数出现，一旦以 "-"
 * 开头就可能被 ssh 当成新选项（例如 host="‑oProxyCommand=…"），"@" 会破坏
 * user@host 的切分，空白/控制字符会让 argv 与实际意图不一致。
 */
function requireToken(value, label) {
  if (value === undefined || value === null || value === '') {
    throw new Error(`${label} 不能为空 | ${label} is required`);
  }
  if (typeof value !== 'string') {
    throw new Error(`${label} 必须是字符串 | ${label} must be a string`);
  }
  if (value.startsWith('-')) {
    throw new Error(`${label} 不能以 "-" 开头（argv 注入防护）| ${label} must not start with "-"`);
  }
  if (SPACE_OR_CONTROL.test(value)) {
    throw new Error(`${label} 不能含空白或控制字符 | ${label} must not contain whitespace or control characters`);
  }
  return value;
}

/** host / user：在 requireToken 之上再禁 "@"（user@host 只能有一个分隔符）。 */
function requireHostLike(value, label) {
  const s = requireToken(value, label);
  if (s.includes('@')) {
    throw new Error(`${label} 不能含 "@"（会破坏 user@host 解析）| ${label} must not contain "@"`);
  }
  return s;
}

/** 绑定地址（只出现在 -R 的值里，不会变成独立 argv）。 */
function requireBindHost(value, label) {
  const s = requireToken(value, label);
  return s;
}

/** 端口：接受 number，也接受设置页写进来的数字串（"7788"）。 */
function requirePort(value, label, fallback) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`${label} 不能为空 | ${label} is required`);
  }
  let n = value;
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value.trim())) {
      throw new Error(`${label} 必须是 1..65535 的整数 | ${label} must be an integer in 1..65535`);
    }
    n = Number(value.trim());
  }
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`${label} 必须是 1..65535 的整数 | ${label} must be an integer in 1..65535`);
  }
  return n;
}

/** -R 里的 IPv6 字面量必须加方括号，否则 ssh 会按 ":" 切错（[::1]:7788:host:port）。 */
function bracketIfIpv6(host) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function normalizeExtraOptions(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error('extraOptions 必须是字符串数组 | extraOptions must be an array of strings');
  }
  return value.map((opt, i) => {
    if (typeof opt !== 'string' || opt.trim() === '') {
      throw new Error(`extraOptions[${i}] 必须是非空字符串 | extraOptions[${i}] must be a non-empty string`);
    }
    // 每个选项都是独立的 argv 元素，空格安全（ProxyCommand 这类值本身含空格）；
    // 只拒绝控制字符——它只可能来自配置错误。
    if (CONTROL.test(opt)) {
      throw new Error(`extraOptions[${i}] 不能含控制字符 | extraOptions[${i}] must not contain control characters`);
    }
    return opt;
  });
}

/**
 * 构造 ssh 反向隧道的 argv（不含程序名）。
 *
 * 约定（冻结接口，集成方与测试依赖精确顺序）：
 *   -N -T
 *   -o ExitOnForwardFailure=yes / ServerAliveInterval=30 / ServerAliveCountMax=3
 *      / StrictHostKeyChecking=accept-new / BatchMode=yes
 *   [keyPath 非空] -i <keyPath> -o IdentitiesOnly=yes
 *   [port != 22] -p <port>
 *   [verbose] -v
 *   [extraOptions] 每个一个 -o
 *   -R <remoteBindHost>:<remoteBindPort>:<localHost>:<localPort>
 *   <user>@<host>
 *
 * 为什么不加 "--" 结束选项解析：host/user 已被 requireHostLike 强制拒绝 "-" 开头与
 * 空白/控制字符，argv 注入面已经封死；再加 "--" 只会让集成方眼里的 argv 与约定不符。
 *
 * 选项的 WHY：
 *   -N -T              只要转发，不要 shell/pty；
 *   ExitOnForwardFailure 远端端口被占时立刻退出，否则会"连上了但不可用"（最难排查）；
 *   ServerAliveInterval/CountMax  半死连接（NAT/VPS 重启）能在 ~90s 内被发现并触发重连；
 *   StrictHostKeyChecking=accept-new  首次连接自动写 known_hosts（免交互），但主机密钥
 *                      变化时依旧拒绝——这正是我们要的安全语义；
 *   BatchMode=yes      禁止一切交互式提问（密码/口令），否则无终端场景会挂死；
 *   IdentitiesOnly=yes 指定了 -i 就只用它，避免 ssh-agent 里别的身份先试导致
 *                      "Too many authentication failures"。
 *
 * @param {object} cfg 见文件头与 createSshTunnel 的 cfg 说明
 * @returns {string[]} argv
 */
export function buildSshArgs(cfg = {}) {
  if (!cfg || typeof cfg !== 'object') {
    throw new Error('cfg 必须是对象 | cfg must be an object');
  }
  const host = requireHostLike(cfg.host, 'host');
  const user = requireHostLike(cfg.user, 'user');
  const port = requirePort(cfg.port, 'port', 22);
  const remoteBindHost = requireBindHost(cfg.remoteBindHost ?? '127.0.0.1', 'remoteBindHost');
  const remoteBindPort = requirePort(cfg.remoteBindPort, 'remoteBindPort');
  const localHost = requireBindHost(cfg.localHost ?? '127.0.0.1', 'localHost');
  const localPort = requirePort(cfg.localPort, 'localPort');
  const verbose = cfg.verbose === true;
  // keyPath：只做路径校验，绝不读取文件内容
  const keyPath = cfg.keyPath === undefined || cfg.keyPath === null || cfg.keyPath === ''
    ? ''
    : requireToken(cfg.keyPath, 'keyPath');
  const extraOptions = normalizeExtraOptions(cfg.extraOptions);

  const args = [
    '-N', '-T',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'BatchMode=yes',
  ];
  if (keyPath) args.push('-i', keyPath, '-o', 'IdentitiesOnly=yes');
  if (port !== 22) args.push('-p', String(port));
  if (verbose) args.push('-v');
  for (const opt of extraOptions) args.push('-o', opt);
  args.push('-R', `${bracketIfIpv6(remoteBindHost)}:${remoteBindPort}:${bracketIfIpv6(localHost)}:${localPort}`);
  args.push(`${user}@${host}`);
  return args;
}

// ---------------------------------------------------------------------------
// 输出行分类
// ---------------------------------------------------------------------------

// 顺序即优先级：越具体的模式越靠前，避免被后面的宽泛模式抢走。
// 样本取自真实 OpenSSH（Windows 9.5 / Linux 9.x）输出。
const KNOWN_HOSTS_ADDED_RE = /permanently added .* to the list of known hosts/i;
const FORWARD_OK_RE = /remote forward success for/i;
const FORWARD_FAIL_RE = /remote (?:port )?forward(?:ing)? (?:failure|failed)|administratively prohibited/i;
const HOST_KEY_RE = /host key verification failed|remote host identification has changed|no .{0,60}host key is known|offending .{0,30}key|man-in-the-middle/i;
/** 主机密钥变化的 @@@@ 横幅（单独一行，兜住中间那句被本地化/截断的情况）。 */
const HOST_KEY_BANNER_RE = /^@{10,}/;
const AUTH_FAIL_RE = /permission denied|too many authentication failures|authentication failed|no more authentication methods|invalid user/i;
const CONFIG_FATAL_RE = /bad configuration option|unknown option|command-line: line 0|address already in use|cannot bind/i;
const DNS_FAIL_RE = /could not resolve hostname|name or service not known|temporary failure in name resolution|nodename nor servname provided|no address associated with hostname|hostname nor servname provided/i;
const REFUSED_RE = /connection refused/i;
const NETWORK_RE = /connection timed out|operation timed out|timed out|network is unreachable|no route to host|connection reset|connection closed|closed by remote host|broken pipe|received disconnect|disconnected from|software caused connection abort|socket is not connected|host is down|connection attempt failed|kex_exchange_identification|client_loop|mux_client|not responding/i;
const SOFT_ERROR_RE = /(?:no such identity|identity file .*not accessible|permissions .* are too open|private key will be ignored)|^(?:ssh|error|fatal|warn(?:ing)?)\s*:/i;

/**
 * 把 ssh 的一行输出分类。
 *
 * fatal=true 表示"重连没有意义"：鉴权失败、主机密钥不匹配、远端端口占用、
 * 命令行/配置错误——再连一百次也是同样的结果，必须停下来让用户去修。
 * 网络/拒绝/DNS 这类是暂时性的，交给退避重连。
 *
 * @param {string} line
 * @returns {{kind:string, fatal:boolean, message:string}|null} 无诊断价值的行（调试噪音）返回 null
 */
export function classifySshLine(line) {
  if (typeof line !== 'string') return null;
  const text = line.trim();
  if (!text) return null;
  const message = text.slice(0, MESSAGE_MAX);

  // StrictHostKeyChecking=accept-new 的正常副作用，不是错误：不能污染 lastError
  if (KNOWN_HOSTS_ADDED_RE.test(text)) return null;

  if (FORWARD_OK_RE.test(text)) return { kind: 'forward-ok', fatal: false, message };
  if (FORWARD_FAIL_RE.test(text)) return { kind: 'forward-fail', fatal: true, message };
  if (HOST_KEY_RE.test(text) || HOST_KEY_BANNER_RE.test(text)) return { kind: 'host-key', fatal: true, message };
  if (AUTH_FAIL_RE.test(text)) return { kind: 'auth-fail', fatal: true, message };
  if (CONFIG_FATAL_RE.test(text)) return { kind: 'error', fatal: true, message };
  if (DNS_FAIL_RE.test(text)) return { kind: 'dns-fail', fatal: false, message };
  if (REFUSED_RE.test(text)) return { kind: 'refused', fatal: false, message };
  if (NETWORK_RE.test(text)) return { kind: 'network', fatal: false, message };
  if (SOFT_ERROR_RE.test(text)) return { kind: 'error', fatal: false, message };
  // 其余都是 debug 噪音（Reading configuration data / Authenticating to / Next
  // authentication method / Entering interactive session …），不参与状态判定
  return null;
}

// ---------------------------------------------------------------------------
// 隧道状态机
// ---------------------------------------------------------------------------

function normalizeDelays(input) {
  if (!Array.isArray(input)) return DEFAULT_RECONNECT_DELAYS.slice();
  const clean = input
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n >= 0);
  return clean.length ? clean : DEFAULT_RECONNECT_DELAYS.slice();
}

/**
 * 创建 SSH 反向隧道控制器（纯状态机，不做 IO 之外的副作用）。
 *
 * @param {object} opts
 * @param {object} opts.cfg   buildSshArgs 的配置（含 host/user/remoteBindPort/localPort …）
 * @param {Function} [opts.spawnImpl]  注入的 spawn（默认 node:child_process.spawn）；
 *        受限环境（如本机 DSH 沙箱）必须注入假实现或在正常机器上用默认实现
 * @param {Function} [opts.stdioFactory] ({cfg,args}) => stdio；默认 ['ignore','pipe','pipe']。
 *        传 'ignore' 或文件 fd 数组时拿不到 stderr，只能靠 graceMs 判成功
 * @param {Function} [opts.log]   诊断日志（默认丢弃）
 * @param {Function} [opts.onState] (newState, detail) => void；detail 至少含
 *        { message, code, stderrTail }，重连时另有 { retryInMs, attempt }
 * @param {number} [opts.graceMs=2500] 无就绪行时的判定窗口
 * @param {{enabled?:boolean, delays?:number[]}|false} [opts.reconnect]
 * @param {number} [opts.tailLines=50] stderrTail 保留行数
 *
 * 状态机：'idle' → 'starting' → 'connected' → (掉线) 'reconnecting' → 'starting' …
 * 终态：'failed'（致命错误 / 关掉重连后掉线）、'stopped'（用户 stop）。
 * 每次真正 spawn 之前都会进入 'starting'（含重连尝试），所以一次掉线重连的
 * onState 序列是：connected → reconnecting → starting → connected。
 *
 * @returns {{start:Function, stop:Function, state:Function, lastError:Function, snapshot:Function}}
 */
export function createSshTunnel(opts = {}) {
  const cfg = { ...(opts.cfg ?? {}) };
  const spawnImpl = typeof opts.spawnImpl === 'function' ? opts.spawnImpl : nodeSpawn;
  const stdioFactory = typeof opts.stdioFactory === 'function' ? opts.stdioFactory : () => DEFAULT_STDIO;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const onState = typeof opts.onState === 'function' ? opts.onState : () => {};
  const graceMs = Number.isFinite(opts.graceMs) && opts.graceMs >= 0 ? Number(opts.graceMs) : DEFAULT_GRACE_MS;
  const tailLimit = Number.isInteger(opts.tailLines) && opts.tailLines > 0 ? opts.tailLines : DEFAULT_TAIL_LINES;
  // reconnect: false 与 reconnect: { enabled: false } 等价（调用方写哪种都行）
  const rc = opts.reconnect === false
    ? { enabled: false }
    : (opts.reconnect && typeof opts.reconnect === 'object' ? opts.reconnect : {});
  const reconnectEnabled = rc.enabled !== false;
  const delays = normalizeDelays(rc.delays);

  let state = 'idle';
  let lastMsg = null;          // lastError() 的字符串形式
  let attempt = 0;             // 连续重试次数（连上 / 致命失败 / stop 时归零）
  let connectedSince = null;
  let retryTimer = null;
  let retryInMs = null;        // 快照用：还有多久重连
  let session = null;          // 尚未结算的当前会话
  let tailRef = [];            // 最近一个会话的 stderr 尾部（快照/回调共用）
  let dying = null;            // 已 kill 但还没发 exit 的子进程
  let killExitTimer = null;
  let pendingStart = false;    // start() 撞上"上一个进程还没退干净" → 等它退出再 spawn
  let userStopped = false;     // 用户 stop 之后禁止任何重连

  function tailSnapshot() {
    return tailRef.slice();
  }

  function setState(next, detail = {}) {
    state = next;
    const { message = null, code = null, stderrTail, ...rest } = detail;
    const payload = {
      message,
      code,
      stderrTail: Array.isArray(stderrTail) ? stderrTail.slice() : tailSnapshot(),
      ...rest,
    };
    // 回调属于 UI 层：它抛错不能把状态机带崩（否则隧道"活着但没人知道"）
    try {
      onState(next, payload);
    } catch (err) {
      log(`onState 回调抛错（已忽略）：${err?.message ?? err}`);
    }
  }

  function clearRetryTimer() {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function clearRetry() {
    clearRetryTimer();
    retryInMs = null;
  }

  function pushTail(s, line) {
    s.tail.push(line);
    // 只留最近 N 行：长跑隧道里 stderr 会一直来，不设上限就是内存泄漏
    if (s.tail.length > tailLimit) s.tail.splice(0, s.tail.length - tailLimit);
  }

  function pickMessage(s) {
    // 从尾部往前找最有诊断价值的一行；就绪行不是错误原因，跳过
    for (let i = s.tail.length - 1; i >= 0; i--) {
      const line = s.tail[i];
      const info = classifySshLine(line);
      if (info?.kind === 'forward-ok') continue;
      return info ? info.message : line;
    }
    return null;
  }

  function markConnected(s, message) {
    if (s.settled || session !== s || s.fatal) return;
    if (state === 'connected') return;
    if (s.graceTimer) {
      clearTimeout(s.graceTimer);
      s.graceTimer = null;
    }
    clearRetry();
    attempt = 0;
    connectedSince = Date.now();
    lastMsg = null; // 连上即视为"当前无错误"
    setState('connected', { message, pid: s.child?.pid ?? null });
  }

  /** 终结为 failed（不重连），并把 lastError 写清楚。 */
  function failNow(message, code) {
    clearRetry();
    attempt = 0;
    lastMsg = message;
    setState('failed', { message, code: code ?? null, reconnect: false });
  }

  /**
   * kill 一个子进程，并记录"它在退出中"。
   *
   * 为什么要记录：stop() 之后立刻 start()（用户连点开关）时，旧 ssh 可能还没退
   * 干净；此时若马上 spawn 第二个 ssh，两者会抢同一个远端端口，新连接直接
   * "remote port forwarding failed" → 被误判成致命错误。所以等旧进程 exit 再起新的。
   */
  function beginKill(child) {
    if (!child) return;
    dying = child;
    const done = () => {
      if (dying === child) {
        dying = null;
        if (killExitTimer) {
          clearTimeout(killExitTimer);
          killExitTimer = null;
        }
      }
      if (pendingStart) {
        pendingStart = false;
        spawnSession();
      }
    };
    // 'exit' 一定先于 'close'；两个都挂是为了兼容只发其中一个的实现
    child.once?.('exit', done);
    child.once?.('close', done);
    if (killExitTimer) clearTimeout(killExitTimer);
    killExitTimer = setTimeout(() => {
      killExitTimer = null;
      if (dying === child) {
        log('等待 ssh 退出超时，按已退出继续 | wait for ssh exit timed out');
        dying = null;
      }
      if (pendingStart) {
        pendingStart = false;
        spawnSession();
      }
    }, KILL_EXIT_TIMEOUT_MS);
    try {
      child.kill?.();
    } catch (err) {
      log(`kill ssh 失败：${err?.message ?? err}`);
    }
  }

  function settleFatal(s, info) {
    if (s.settled) return;
    s.settled = true;
    if (s.graceTimer) {
      clearTimeout(s.graceTimer);
      s.graceTimer = null;
    }
    clearRetry();
    attempt = 0;
    if (session === s) session = null;
    lastMsg = info.message;
    // 先置状态再收尸：UI 立刻看到 failed，不等 ssh 自己慢慢退（ExitOnForwardFailure
    // 下它确实会退，但"用户机器上 ssh 卡住"是真实存在的，不依赖它）
    setState('failed', { message: info.message, code: info.kind, reconnect: false });
    if (s.child) beginKill(s.child);
  }

  function handleLine(s, raw) {
    const line = String(raw ?? '').trim();
    if (!line) return;
    pushTail(s, line);
    const info = classifySshLine(line);
    if (!info) return;
    if (info.kind === 'forward-ok') {
      log(`ssh 就绪：${line}`);
      markConnected(s, info.message);
      return;
    }
    if (!info.fatal) return; // 非致命：等进程退出后按退避重连（这里只留输出）
    log(`ssh 致命错误（不再重连）：${line}`);
    s.fatal = info;
    settleFatal(s, info);
  }

  function onStderr(s, chunk) {
    if (s.settled) return;
    s.lineBuf += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (s.lineBuf.length > MAX_LINE_CHARS) s.lineBuf = s.lineBuf.slice(-MAX_LINE_CHARS);
    let idx;
    while ((idx = s.lineBuf.indexOf('\n')) >= 0) {
      const raw = s.lineBuf.slice(0, idx);
      s.lineBuf = s.lineBuf.slice(idx + 1);
      handleLine(s, raw.endsWith('\r') ? raw.slice(0, -1) : raw);
      if (s.settled) return;
    }
  }

  function onEnd(s, { code = null, signal = null, err = null } = {}) {
    if (s.settled) return;
    s.settled = true;
    if (s.graceTimer) {
      clearTimeout(s.graceTimer);
      s.graceTimer = null;
    }
    if (session === s) session = null;
    // stop() 后立刻 start() 的等待路径：旧进程退出了，补上那次 start
    if (pendingStart) {
      pendingStart = false;
      spawnSession();
      return;
    }
    if (userStopped) return; // 状态已是 'stopped'，不再改动
    const tailMsg = pickMessage(s);
    const base = err
      ? `ssh 启动失败：${err?.message ?? err} | failed to spawn ssh`
      : (tailMsg ?? `ssh 已退出（code=${code ?? 'null'}）| ssh exited`);
    const outCode = err ? (err.code ?? null) : code;
    log(`ssh 退出（code=${code ?? 'null'}${signal ? `, signal=${signal}` : ''}）：${base}`);
    if (err && FATAL_SPAWN_CODES.has(err.code)) {
      failNow(base, err.code); // ssh 不存在 / 被沙箱拒绝：重试同样失败
      return;
    }
    if (!reconnectEnabled) {
      lastMsg = base;
      setState('failed', { message: base, code: outCode, reconnect: false });
      return;
    }
    scheduleReconnect(base, outCode);
  }

  function scheduleReconnect(message, code) {
    if (userStopped) return;
    const delay = delays[Math.min(attempt, delays.length - 1)]; // 末位即上限
    attempt += 1;
    retryInMs = delay;
    lastMsg = message;
    setState('reconnecting', { message, code: code ?? null, retryInMs: delay, attempt });
    clearRetryTimer();
    retryTimer = setTimeout(() => {
      retryTimer = null;
      retryInMs = null;
      if (userStopped) return;
      if (dying) {
        // 旧进程还在退（正常流程下不会遇到）：等它的 done 回调来补下一次 spawn
        pendingStart = true;
        return;
      }
      spawnSession();
    }, delay);
  }

  function attach(s, args) {
    const child = s.child;
    const stderr = child.stderr ?? null;
    if (stderr && typeof stderr.on === 'function') {
      stderr.on('data', (chunk) => onStderr(s, chunk));
      stderr.on('error', () => {}); // kill 后的 EPIPE 不能变成 uncaught
    }
    const stdout = child.stdout ?? null;
    if (stdout && typeof stdout.on === 'function') {
      stdout.on('error', () => {});
      // -N -T 下 stdout 不该有输出，但管道必须排空：填满 64KB 会把 ssh 卡死
      stdout.resume?.();
    }
    child.once?.('exit', (code, signal) => onEnd(s, { code, signal }));
    child.once?.('close', (code, signal) => onEnd(s, { code, signal }));
    child.once?.('error', (err) => onEnd(s, { err }));
    s.graceTimer = setTimeout(() => {
      s.graceTimer = null;
      if (s.settled || session !== s || s.fatal || state !== 'starting') return;
      // 没开 -v 就没有 "remote forward success" 行，只能按"活过窗口且没报致命错"判定。
      // 真实 ssh 在连接失败时会立刻退出（走到 onEnd 而不是这里），所以不会误报。
      markConnected(s, `ssh 存活超过 ${graceMs}ms（未启用 -v 就绪行）| alive past graceMs`);
    }, graceMs);
    log(`ssh 已启动（pid=${child.pid ?? 'null'}）：ssh ${args.join(' ')}`);
  }

  function spawnSession() {
    userStopped = false;
    let args;
    try {
      args = buildSshArgs(cfg);
    } catch (err) {
      // 配置错误必须同时"可见"（抛给调用方）和"有状态"（UI 能显示）
      failNow(err.message, 'config');
      throw err;
    }
    let stdio;
    try {
      stdio = stdioFactory({ cfg, args });
    } catch (err) {
      // 包装后再抛：调用方看到的必须是"哪个环节坏了"，而不是裸的原始错误
      const msg = `stdioFactory 失败：${err?.message ?? err} | stdioFactory failed`;
      failNow(msg, 'stdio');
      const wrapped = new Error(msg);
      wrapped.code = 'stdio';
      wrapped.cause = err;
      throw wrapped;
    }
    setState('starting', {
      message: attempt > 0
        ? `正在重连（第 ${attempt} 次）| reconnecting (attempt ${attempt})`
        : '正在启动 ssh 反向隧道 | starting ssh reverse tunnel',
    });
    const s = { child: null, tail: [], fatal: null, settled: false, graceTimer: null, lineBuf: '' };
    tailRef = s.tail;
    let child;
    try {
      child = spawnImpl('ssh', args, { stdio, windowsHide: true });
    } catch (err) {
      // spawn 自己抛（注入实现坏了 / 参数非法）：重试没意义
      s.settled = true;
      failNow(`ssh 启动失败：${err?.message ?? err} | failed to spawn ssh`, err?.code ?? 'spawn-fail');
      return;
    }
    s.child = child;
    session = s;
    attach(s, args);
  }

  /** 幂等启动：已在跑（starting/connected/reconnecting）时不产生第二个 ssh 进程。 */
  function start() {
    if (state === 'starting' || state === 'connected' || state === 'reconnecting') return state;
    if (session) return state;
    if (dying) {
      // 旧进程还没退干净：等它的 done 回调再 spawn（避免两个 ssh 抢同一个远端端口）
      pendingStart = true;
      userStopped = false;
      setState('starting', { message: '等待上一个 ssh 退出 | waiting for previous ssh to exit' });
      return state;
    }
    spawnSession();
    return state;
  }

  /** 幂等停止：杀进程、清定时器、状态置 stopped；停止后永不重连。 */
  function stop() {
    userStopped = true;
    pendingStart = false;
    clearRetry();
    const cur = session;
    session = null;
    if (cur) {
      cur.settled = true;
      if (cur.graceTimer) {
        clearTimeout(cur.graceTimer);
        cur.graceTimer = null;
      }
    }
    if (cur?.child) beginKill(cur.child);
    attempt = 0;
    connectedSince = null;
    // 重复 stop() 不重复回调（幂等），但资源清理照做
    if (state !== 'stopped') setState('stopped', { message: '已停止 | stopped' });
  }

  function stateFn() {
    return state;
  }

  function lastError() {
    return lastMsg;
  }

  /** 状态展示用的小快照：保证 JSON.stringify 安全，且不携带本机私钥路径等敏感信息。 */
  function snapshot() {
    const remoteBindHost = cfg.remoteBindHost ?? '127.0.0.1';
    const localHost = cfg.localHost ?? '127.0.0.1';
    const remoteBindPort = cfg.remoteBindPort;
    const localPort = cfg.localPort;
    return {
      state,
      lastError: lastMsg,
      target: {
        host: cfg.host ?? null,
        user: cfg.user ?? null,
        port: cfg.port ?? 22,
        remote: remoteBindPort === undefined || remoteBindPort === null
          ? null
          : `${bracketIfIpv6(String(remoteBindHost))}:${remoteBindPort}`,
        local: localPort === undefined || localPort === null
          ? null
          : `${bracketIfIpv6(String(localHost))}:${localPort}`,
      },
      pid: session?.child?.pid ?? null,
      connectedSince,
      attempts: attempt,
      nextRetryInMs: retryInMs,
      reconnectEnabled,
      stderrTail: tailSnapshot(),
    };
  }

  return { start, stop, state: stateFn, lastError, snapshot };
}
