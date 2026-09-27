// dsh-pocket 设置页签 RPC 契约（client 与 host 共享）
export const POCKET_RPC_CHANNEL = '/dsh-pocket';
export const MOBILE_RIGHTBAR_ATTRIBUTE = 'data-dsh-pocket-mobile-rightbar';
export const MOBILE_RIGHTBAR_EVENT = 'dsh-pocket:mobile-rightbar';

export const POCKET_ENDPOINTS = Object.freeze({
  status: 'pocket.status',
  tunnelStart: 'tunnel.start',
  tunnelStop: 'tunnel.stop',
  tunnelSetConfig: 'tunnel.setConfig',
  version: 'pocket.version',
  update: 'pocket.update',
  restart: 'pocket.restart',
  lanTokenRefresh: 'token.lanRefresh',
  lanAuthSetEnabled: 'lanAuth.setEnabled',
  lanSetOverride: 'lan.setOverride',
  lanSetEnabled: 'lan.setEnabled',
  mobileRightbarSetEnabled: 'mobile.rightbar.setEnabled',
  pinSetCustom: 'pin.setCustom',
  pocketReset: 'pocket.reset',
  // 移动端「复制文件内容」（issue #17）：手机经此 RPC 让主机读取文件正文，
  // 再写入剪贴板——因为手机无法直接打开电脑上的文件。
  fileRead: 'pocket.fileRead',
  // 第三通道「自有服务器 + SSH 反向端口映射」：配置、状态/测试连接。
  // 三个公网入口（Quick / Named / SSH）互斥，由宿主的 tunnelMode 决定。
  sshSetConfig: 'ssh.setConfig',
  sshStatus: 'ssh.status',
  // 通行密钥（WebAuthn）设备管理（仅本机可调）。
  passkeySetEnabled: 'passkey.setEnabled',
  passkeyList: 'passkey.list',
  passkeyRevoke: 'passkey.revoke',
  passkeyRename: 'passkey.rename',
  // 通知：Web Push 订阅 + Webhook 配置与测试。
  notifySetConfig: 'notify.setConfig',
  notifyStatus: 'notify.status',
  notifyRemoveSubscription: 'notify.removeSubscription',
  notifyClearSubscriptions: 'notify.clearSubscriptions',
  notifyTest: 'notify.test',
  // 网络自检：在宿主进程里探测订阅/Webhook 主机的 DNS、TCP、HTTP 与进程网络环境。
  notifyDiagnose: 'notify.diagnose',
});

/** 语义化版本比较：a > b 返回正数，相等 0，a < b 负数（数字段 + 预发布后缀）。 */
export function compareVersions(a, b) {
  const pa = String(a).replace(/^[vV]/, '').split('.');
  const pb = String(b).replace(/^[vV]/, '').split('.');
  for (let i = 0; i < 3; i++) {
    const x = parseInt(pa[i], 10) || 0;
    const y = parseInt(pb[i], 10) || 0;
    if (x !== y) return x - y;
  }
  // 数字段相等：无预发布后缀的更新；都有后缀时按段比较（alpha < beta < rc…，
  // 数字段按数值：rc.9 < rc.10）
  const aPre = String(a).replace(/^[vV]/, '').match(/-.*$/)?.[0] ?? '';
  const bPre = String(b).replace(/^[vV]/, '').match(/-.*$/)?.[0] ?? '';
  if (!aPre && !bPre) return 0;
  if (!aPre) return 1;
  if (!bPre) return -1;
  // 逐段比较：数字段按数值、文本段按字典序
  const aParts = aPre.slice(1).split('.');
  const bParts = bPre.slice(1).split('.');
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const ax = aParts[i] ?? '';
    const bx = bParts[i] ?? '';
    if (ax === bx) continue;
    const aNum = /^\d+$/.test(ax);
    const bNum = /^\d+$/.test(bx);
    if (aNum && bNum) return Number(ax) - Number(bx); // 数值比较
    if (aNum) return 1; // 数字段 > 文本段
    if (bNum) return -1;
    return ax < bx ? -1 : 1; // 字典序
  }
  return 0;
}

/** 整数兜底：非数字/空字符串回退（宿主字段缺失或旧版本响应时不产生 NaN）。 */
function intOr(value, fallback) {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 由 accessProtocol + accessHost(+accessPort) 拼公网访问地址（SSH 通道）。
 * accessHost 为空时回退 SSH 主机名；端口为 0 或协议默认端口时省略。
 * 主机串里已经带了端口（example.com:8443）时不再追加。
 * @param {{ accessProtocol?: string, accessHost?: string, host?: string, accessPort?: number|string }} cfg
 * @returns {string|null} 地址，缺主机名时 null
 */
export function buildAccessUrl(cfg) {
  const host = String(cfg?.accessHost || cfg?.host || '').trim();
  if (!host) return null;
  const proto = cfg?.accessProtocol === 'http' ? 'http' : 'https';
  const port = intOr(cfg?.accessPort, 0);
  const defaultPort = proto === 'http' ? 80 : 443;
  const needPort = port !== 0 && port !== defaultPort && !/:\d+$/.test(host);
  return `${proto}://${host}${needPort ? `:${port}` : ''}`;
}

const NOTIFY_PRESETS = ['generic', 'wecom', 'dingtalk', 'feishu', 'ntfy', 'bark'];

/** stderr 尾巴的展示上限（与 lib/ssh-channel.mjs 的 STDERR_TAIL_LINES/LINE_MAX 保持一致）。 */
const SSH_TAIL_LINES = 5;
const SSH_TAIL_LINE_MAX = 500;
/** 诊断文本里的私钥相关材料：PEM 块 / .ssh 下的密钥路径 / 裸 id_xxx 文件名。 */
const PEM_BLOCK_RE = /-----BEGIN[\s\S]*?-----END[^-]*-----/g;
const KEY_PATH_RE = /(?:~|[/\\])?[^\s"'=:]*\.ssh[/\\][^\s"'=]*|(?:^|[\s"'=(])(?:id_(?:rsa|dsa|ecdsa|ed25519))(?:\.pub)?/gi;
/**
 * 只用于诊断文本（stderrTail / lastError）：把私钥路径与 PEM 块替换成占位符。
 * ssh -v 会打印 `identity file ~/.ssh/id_ed25519 type 3`，路径本身不是密钥，
 * 但「status 里不出现私钥路径」是白名单的底线；替换后 `identity file [redacted key path] type 3`
 * 仍保留了排障信息。普通行（vps.example.com / 127.0.0.1:7788 等）不会被误伤。
 */
function scrubKeyMaterial(text) {
  return String(text ?? '')
    .replace(PEM_BLOCK_RE, '[redacted private key]')
    .replace(KEY_PATH_RE, '[redacted key path]');
}

/** 诊断字段用的严格整数：只认 number（字符串/NaN/负数一律降级），避免把脏数据透给 UI。 */
function intOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

/**
 * SSH 通道状态（白名单：私钥路径只回 keyPathSet，绝不回原文）。
 *
 * 诊断字段（evidence / attempts / nextRetryInMs / stderrTail / target）与 ssh.status RPC
 * 保持对等——否则 3 秒轮询的 pocket.status 里看不到重连倒计时与 stderr 尾巴。
 * 输入缺失或类型不对时一律降级为默认值（null / 0 / []），绝不抛错：旧宿主（status 里
 * 没有这些字段）必须照旧显示。
 */
function redactSsh(ssh) {
  const c = ssh?.config ?? {};
  const config = {
    host: c.host ?? '',
    port: intOr(c.port, 22),
    user: c.user ?? '',
    keyPathSet: c.keyPathSet === true,
    remoteBindPort: intOr(c.remoteBindPort, 7788),
    accessProtocol: c.accessProtocol === 'http' ? 'http' : 'https',
    accessHost: c.accessHost ?? '',
    accessPort: intOr(c.accessPort, 0),
    autoRestore: c.autoRestore !== false,
  };
  // 宿主未给 url 时按同一规则本地拼（旧版本/运行前也能显示要用的地址）
  const url = ssh?.url ?? buildAccessUrl({ ...config, host: config.accessHost || config.host });
  // connected 的证据：只认这两个结构化取值，其它（含旧宿主的缺失值）一律 null
  const evidence = ssh?.evidence === 'forward-ok' || ssh?.evidence === 'grace' ? ssh.evidence : null;
  const attempts = intOrNull(ssh?.attempts) ?? 0;
  const nextRetryInMs = intOrNull(ssh?.nextRetryInMs);
  // stderr 尾巴：最多 5 行、每行 500 字符（宿主已限长，这里再兜一次，防旧宿主/手改 JSON），
  // 并把私钥路径/PEM 换成占位符（见 scrubKeyMaterial）
  const stderrTail = Array.isArray(ssh?.stderrTail)
    ? ssh.stderrTail.slice(-SSH_TAIL_LINES).map((line) => scrubKeyMaterial(line).slice(0, SSH_TAIL_LINE_MAX))
    : [];
  // 目标视图：逐字段白名单（**结构上不可能带出 keyPath 等私钥材料**）
  const rawTarget = ssh?.target;
  const target = rawTarget && typeof rawTarget === 'object' && !Array.isArray(rawTarget)
    ? {
      host: typeof rawTarget.host === 'string' ? rawTarget.host : '',
      user: typeof rawTarget.user === 'string' ? rawTarget.user : '',
      port: intOr(rawTarget.port, 22),
      remote: typeof rawTarget.remote === 'string' ? rawTarget.remote : null,
      local: typeof rawTarget.local === 'string' ? rawTarget.local : null,
    }
    : null;
  return {
    running: ssh?.running === true,
    state: typeof ssh?.state === 'string' ? ssh.state : 'idle',
    url,
    qr: ssh?.qr ?? null,
    // lastError 是 ssh 的原文诊断：同样过一遍私钥材料清洗（路径→占位符，其余原样）
    lastError: ssh?.lastError == null ? null : scrubKeyMaterial(ssh.lastError),
    evidence,
    attempts,
    nextRetryInMs,
    stderrTail,
    target,
    config,
  };
}

/** 通知状态（白名单：webhook 密钥只回 webhookConfigured，绝不回原文）。 */
function redactNotify(n) {
  return {
    pushEnabled: n?.pushEnabled === true,
    onTaskDone: n?.onTaskDone !== false,
    webhookEnabled: n?.webhookEnabled === true,
    webhookPreset: NOTIFY_PRESETS.includes(n?.webhookPreset) ? n.webhookPreset : 'generic',
    webhookUrl: n?.webhookUrl ?? '',
    webhookConfigured: n?.webhookConfigured === true,
    subscriptionCount: intOr(n?.subscriptionCount, 0),
    // 冻结合同之外的可选字段：宿主返回时透传（设置页回显最小间隔），缺失为 null
    minIntervalSec: n?.minIntervalSec == null ? null : intOr(n.minIntervalSec, null),
  };
}

/** 通行密钥状态。 */
function redactPasskey(p) {
  return {
    enabled: p?.enabled === true,
    rpId: p?.rpId ?? '',
    deviceCount: intOr(p?.deviceCount, 0),
  };
}

/** 浏览器可见的状态字段（无敏感信息；含二维码 data URL）。 */
export function redactStatus(s) {
  return {
    proxyRunning: s?.proxyRunning === true,
    proxyPort: s?.proxyPort ?? null,
    lanUrl: s?.lanUrl ?? null,
    lanQr: s?.lanQr ?? null,
    lanCandidates: Array.isArray(s?.lanCandidates) ? s.lanCandidates : [],
    lanIpOverride: s?.lanIpOverride ?? '',
    tunnelRunning: s?.tunnelRunning === true,
    tunnelUrl: s?.tunnelUrl ?? null,
    tunnelQr: s?.tunnelQr ?? null,
    tunnelState: s?.tunnelState ?? { phase: 'idle' },
    tunnelConfig: s?.tunnelConfig ?? { mode: 'quick', hostname: '', tokenSet: false },
    dshPort: s?.dshPort ?? null,
    // 以下三块由后续 host 提供；旧 host 不返回时用默认值兜底（不返回 undefined 给 UI）
    ssh: redactSsh(s?.ssh),
    notify: redactNotify(s?.notify),
    passkey: redactPasskey(s?.passkey),
  };
}
