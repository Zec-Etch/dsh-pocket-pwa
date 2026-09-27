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

/** SSH 通道状态（白名单：私钥路径只回 keyPathSet，绝不回原文）。 */
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
  return {
    running: ssh?.running === true,
    state: typeof ssh?.state === 'string' ? ssh.state : 'idle',
    url,
    qr: ssh?.qr ?? null,
    lastError: ssh?.lastError ?? null,
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
