// dsh-pocket 设置持久化（$DSH_HOME/dsh-pocket/settings.json）
//
// 当前项：
//   - lanEnabled        局域网访问总开关（默认开启）：关闭后局域网扫码/链接直接失效（代理拒绝局域网 Host）
//   - lanAuthEnabled    局域网访问密码开关（issue #24），默认开启
//   - mobileRightbarEnabled 手机端右边栏入口（默认开启）
//   - publicPinCustom   公网密码是否用户自定义（issue #33），自定义后不自动轮换
//   - lanPinCustom      局域网密码是否用户自定义（issue #33）
//   - tunnelMode        公网隧道模式（issue #66）：'quick'（默认，随机 trycloudflare.com）
//                       | 'named'（固定域名）| 'ssh'（自有 VPS + SSH 反向端口转发）——三选一互斥
//   - tunnelToken       Cloudflare 命名隧道 Token（issue #66，秘密；文件 0o600，RPC 不回显）
//   - tunnelHostname    命名隧道绑定的固定域名（issue #66，如 pocket.example.com）
//   - ssh*              SSH 反向隧道参数（host/port/user/keyPath/remoteBindHost/remoteBindPort/autoRestore）
//   - access*           SSH 通道对外访问地址（accessProtocol/accessHost/accessPort）
//   - notify*           任务完成通知（Web Push / Webhook；notifyWebhookSecret 只写不读）
//   - passkeyEnabled    通行密钥（WebAuthn）设备登录总开关（默认关闭）
// 默认**开启**（安全优先）：局域网扫码也要输 8 位密码；
// 用户可关闭——关闭后局域网扫码直连（仅同一网络内的设备能访问），公网不受影响（永远要密码）。

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { isValidIpv4 } from './ip.mjs';
import { WEBHOOK_PRESETS } from './webhook.mjs';

const settingsRel = join('dsh-pocket', 'settings.json');
export function settingsPath() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), settingsRel);
}

function readSettings() {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch { /* 无文件/损坏 → 默认 */ }
  return {};
}

function writeSettings(s) {
  try {
    mkdirSync(dirname(settingsPath()), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify(s, null, 2), { mode: 0o600 });
  } catch { /* 忽略 */ }
  return s;
}

/** 局域网访问总开关：默认开启（文件缺失/损坏都视为开启）。 */
export function lanEnabled() {
  return readSettings().lanEnabled !== false;
}

/** 设置局域网访问总开关，返回新状态（持久化）。 */
export function setLanEnabled(on) {
  const s = readSettings();
  s.lanEnabled = !!on;
  writeSettings(s);
  return s.lanEnabled;
}

/** 局域网访问密码开关：默认开启（文件缺失/损坏都视为开启）。 */
export function lanAuthEnabled() {
  return readSettings().lanAuthEnabled !== false;
}

/** 设置局域网访问密码开关，返回新状态（持久化）。 */
export function setLanAuthEnabled(on) {
  const s = readSettings();
  s.lanAuthEnabled = !!on;
  writeSettings(s);
  return s.lanAuthEnabled;
}

/** 手机端右边栏入口：默认开启，可按需关闭以保持更紧凑的标题栏。 */
export function mobileRightbarEnabled() {
  return readSettings().mobileRightbarEnabled !== false;
}

/** 设置手机端右边栏入口，返回新状态（持久化）。 */
export function setMobileRightbarEnabled(on) {
  const s = readSettings();
  s.mobileRightbarEnabled = !!on;
  writeSettings(s);
  return s.mobileRightbarEnabled;
}

/** 局域网地址手动覆盖：默认空字符串 = 自动选择。 */
export function lanIpOverride() {
  return readSettings().lanIpOverride ?? '';
}

/** 设置局域网地址覆盖；空字符串清除覆盖，恢复自动选择。非法 IPv4 抛错。 */
export function setLanIpOverride(value) {
  const ip = String(value ?? '').trim();
  if (ip && !isValidIpv4(ip)) {
    throw new Error('局域网地址必须是 IPv4 地址 | LAN address must be an IPv4 address');
  }
  const s = readSettings();
  if (ip) s.lanIpOverride = ip;
  else delete s.lanIpOverride;
  writeSettings(s);
  return ip;
}

// ---------- 访问密码「自定义」标记（issue #33） ----------
// 用户可把公网/局域网密码设成自己固定的 8–64 位密码（英文字母大小写或数字；自定义后不再自动轮换）。
// 标记存 settings.json：publicPinCustom / lanPinCustom。
const PIN_CUSTOM_KEYS = { public: 'publicPinCustom', lan: 'lanPinCustom' };

/** 该 PIN（public | lan）是否用户自定义过（自定义后不自动轮换）。 */
export function pinCustom(which) {
  const key = PIN_CUSTOM_KEYS[which];
  if (!key) return false;
  return readSettings()[key] === true;
}

/** 设置自定义标记，返回新状态。 */
export function setPinCustom(which, on) {
  const key = PIN_CUSTOM_KEYS[which];
  if (!key) return false;
  const s = readSettings();
  s[key] = !!on;
  writeSettings(s);
  return !!on;
}

// ---------- 第三通道：自有 VPS + SSH 反向端口转发（tunnelMode 'ssh'） ----------
// 链路：手机 → https://<VPS 域名>（VPS 上的 Caddy，443） → 127.0.0.1:7788（sshd 反向监听口）
//   → SSH 隧道 → 127.0.0.1:3081（本机代理）→ DSH。
// 三个公网入口（quick / named / ssh）互斥：由 tunnelMode 单键决定，写新值就顶掉旧通道
// （service 启动/切换时会先关掉另一条公网通道，见 lib/service.mjs 的 startTunnel）。
// sshKeyPath 只存路径、**从不读取或解析私钥内容**；对外只回 keyPathSet 布尔值。

const DOMAIN_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const IPV4_HOST_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_HOST_RE = /^[0-9a-f:.]+$/i;
const SSH_USER_RE = /^[A-Za-z0-9._-]{1,64}$/;
const ACCESS_PROTOCOLS = ['https', 'http'];

function isIpv4Host(v) {
  const m = IPV4_HOST_RE.exec(v);
  return !!m && m.slice(1).every((n) => Number(n) <= 255);
}

function isIpv6Host(v) {
  return v.includes(':') && IPV6_HOST_RE.test(v);
}

/**
 * 归一化主机名：去协议头、去路径/查询、去端口（keepPort 时保留）、小写、去尾点；
 * 空字符串表示清除。非法（含空白/控制字符/以 "-" 开头/含 "@" / 既不是域名也不是 IP）抛可读错误。
 *
 * - keepBrackets=true：IPv6 加回方括号——URL 拼接（https://[::1]:8443）与 ssh 的 -R 语法都需要；
 * - keepPort=true：保留显式端口（accessHost 允许 `dsh.example.com:8443`）；
 *   裸 IPv6 + 端口有歧义，必须写成 `[::1]:8443`。
 */
function normalizeHostValue(value, label, { keepBrackets = false, keepPort = false, allowWildcard = false } = {}) {
  let v = String(value ?? '').trim();
  if (allowWildcard && v === '*') return v;
  if (!v) return '';
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0];
  // 内部空白一律拒绝：静默截断（'bad host' → 'bad'）会生成一个用户没打算用的主机名
  if (/\s/.test(v) || /[\u0000-\u001f\u007f]/.test(v)) {
    throw new Error(`${label} 不能含空白或控制字符 | ${label} must not contain whitespace`);
  }
  let host = v;
  let port = '';
  let bracketed = false;
  if (v.startsWith('[')) {
    const end = v.indexOf(']');
    if (end <= 1) throw new Error(`${label} 格式不对（IPv6 缺少右方括号） | invalid ${label}`);
    host = v.slice(1, end);
    bracketed = true;
    const rest = v.slice(end + 1);
    if (rest) {
      if (!/^:\d{1,5}$/.test(rest)) throw new Error(`${label} 的方括号后面只能是端口 | invalid ${label}`);
      port = rest;
    }
  } else if (/^[^:]+:\d{1,5}$/.test(v)) {
    // 单冒号 + 数字结尾才算端口；裸 IPv6（::1）不拆
    const idx = v.lastIndexOf(':');
    host = v.slice(0, idx);
    port = v.slice(idx);
  }
  host = host.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('-') || host.includes('@')) {
    throw new Error(`${label} 不能以 "-" 开头或含 "@" | ${label} must not start with "-" or contain "@"`);
  }
  const ok = DOMAIN_RE.test(host) || isIpv4Host(host) || isIpv6Host(host) || host === 'localhost';
  if (!ok) throw new Error(`${label} 必须是主机名或 IP（不含协议/路径/端口） | ${label} must be a hostname or IP`);
  if (port && Number(port.slice(1)) > 65535) {
    throw new Error(`${label} 的端口必须是 1..65535 | invalid ${label} port`);
  }
  // 方括号只在调用方声明需要时保留：ssh 目标要裸 ::1，URL/-R 要 [::1]
  const outHost = keepBrackets && isIpv6Host(host) ? `[${host}]` : host;
  return `${outHost}${keepPort ? port : ''}`;
}

/** 端口校验：allowZero=true 时 0 表示「协议默认端口」。 */
function requirePortValue(value, label, { allowZero = false } = {}) {
  const n = Number(value);
  const min = allowZero ? 0 : 1;
  if (!Number.isInteger(n) || n < min || n > 65535) {
    throw new Error(`${label} 必须是 ${min}..65535 的整数 | ${label} must be an integer in ${min}..65535`);
  }
  return n;
}

/** 布尔设置（缺省回退）。 */
function readBool(s, key, fallback) {
  return typeof s[key] === 'boolean' ? s[key] : fallback;
}

function writeBool(key, on) {
  const s = readSettings();
  const v = !!on;
  if (v === true) s[key] = true;
  else delete s[key]; // 与项目既有风格一致：默认值不落盘，文件保持最小
  writeSettings(s);
  return v;
}

/** SSH 主机（VPS 域名或 IP；未配置返回空字符串）。 */
export function sshHost() {
  const v = readSettings().sshHost;
  return typeof v === 'string' ? v : '';
}

export function setSshHost(value) {
  const v = normalizeHostValue(value, 'SSH 主机');
  const s = readSettings();
  if (v) s.sshHost = v;
  else delete s.sshHost;
  writeSettings(s);
  return v;
}

/** SSH 端口（默认 22）。 */
export function sshPort() {
  const n = Number(readSettings().sshPort);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 22;
}

export function setSshPort(value) {
  const v = requirePortValue(value, 'SSH 端口');
  const s = readSettings();
  if (v === 22) delete s.sshPort;
  else s.sshPort = v;
  writeSettings(s);
  return v;
}

/** SSH 用户名（默认空 = 用 ssh 自己决定；后端要求非空，见 ssh-channel）。 */
export function sshUser() {
  const v = readSettings().sshUser;
  return typeof v === 'string' ? v : '';
}

export function setSshUser(value) {
  const v = String(value ?? '').trim();
  if (v && !SSH_USER_RE.test(v)) {
    throw new Error('SSH 用户名只能含字母、数字、点、下划线、连字符（1–64 位） | invalid SSH user');
  }
  const s = readSettings();
  if (v) s.sshUser = v;
  else delete s.sshUser;
  writeSettings(s);
  return v;
}

/**
 * 私钥路径（默认空 = 用 ssh 默认逻辑：~/.ssh/config、ssh-agent、默认身份文件）。
 * 只存路径字符串，**绝不读取内容**；含控制字符的路径直接拒绝（会污染 argv）。
 */
export function sshKeyPath() {
  const v = readSettings().sshKeyPath;
  return typeof v === 'string' ? v : '';
}

export function setSshKeyPath(value) {
  const raw = String(value ?? '').trim();
  if (/[\u0000-\u001f\u007f]/.test(raw) || raw.length > 4096) {
    throw new Error('私钥路径含非法字符或过长 | invalid SSH key path');
  }
  const s = readSettings();
  if (raw) s.sshKeyPath = raw;
  else delete s.sshKeyPath;
  writeSettings(s);
  return raw;
}

/** VPS 上反向转发的绑定地址（默认 127.0.0.1：公网只应有 Caddy 的 443）。 */
export function sshRemoteBindHost() {
  const v = readSettings().sshRemoteBindHost;
  return typeof v === 'string' && v ? v : '127.0.0.1';
}

export function setSshRemoteBindHost(value) {
  const v = normalizeHostValue(value, '远端绑定地址', { keepBrackets: true, allowWildcard: true });
  const s = readSettings();
  if (!v || v === '127.0.0.1') delete s.sshRemoteBindHost;
  else s.sshRemoteBindHost = v;
  writeSettings(s);
  return v || '127.0.0.1';
}

/** VPS 上反向转发的监听端口（默认 7788）。 */
export function sshRemoteBindPort() {
  const n = Number(readSettings().sshRemoteBindPort);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 7788;
}

export function setSshRemoteBindPort(value) {
  const v = requirePortValue(value, '远端绑定端口');
  const s = readSettings();
  if (v === 7788) delete s.sshRemoteBindPort;
  else s.sshRemoteBindPort = v;
  writeSettings(s);
  return v;
}

/** 对外访问协议（默认 https：公网入口应当由 VPS 上的 Caddy 终结 TLS）。 */
export function accessProtocol() {
  return readSettings().accessProtocol === 'http' ? 'http' : 'https';
}

export function setAccessProtocol(value) {
  const v = String(value ?? '').trim().toLowerCase() || 'https';
  if (!ACCESS_PROTOCOLS.includes(v)) {
    throw new Error('访问协议必须是 https 或 http | access protocol must be https or http');
  }
  const s = readSettings();
  if (v === 'https') delete s.accessProtocol;
  else s.accessProtocol = v;
  writeSettings(s);
  return v;
}

/** 对外访问主机名（默认空 = 回退 sshHost；可带端口，如 vps.example.com:8443）。 */
export function accessHost() {
  const v = readSettings().accessHost;
  return typeof v === 'string' ? v : '';
}

export function setAccessHost(value) {
  const v = normalizeHostValue(value, '访问域名', { keepBrackets: true, keepPort: true });
  const s = readSettings();
  if (v) s.accessHost = v;
  else delete s.accessHost;
  writeSettings(s);
  return v;
}

/** 对外访问端口（默认 0 = 协议默认端口；地址里已带端口时忽略）。 */
export function accessPort() {
  const n = Number(readSettings().accessPort);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : 0;
}

export function setAccessPort(value) {
  const v = requirePortValue(value ?? 0, '访问端口', { allowZero: true });
  const s = readSettings();
  if (v === 0) delete s.accessPort;
  else s.accessPort = v;
  writeSettings(s);
  return v;
}

/** SSH 通道是否随 DSH 重启自动拉起（默认 true；地址固定，与 named 同理）。 */
export function sshAutoRestore() {
  return readBool(readSettings(), 'sshAutoRestore', true);
}

export function setSshAutoRestore(on) {
  const v = !!on;
  const s = readSettings();
  if (v === true) delete s.sshAutoRestore;
  else s.sshAutoRestore = false;
  writeSettings(s);
  return v;
}

/** SSH 通道设置快照（含 access* 与 autoRestore），供 service 拼接地址/启动隧道。 */
export function sshChannelConfig() {
  return {
    host: sshHost(),
    port: sshPort(),
    user: sshUser(),
    keyPath: sshKeyPath(),
    remoteBindHost: sshRemoteBindHost(),
    remoteBindPort: sshRemoteBindPort(),
    accessProtocol: accessProtocol(),
    accessHost: accessHost(),
    accessPort: accessPort(),
    autoRestore: sshAutoRestore(),
  };
}

// ---------- 任务完成通知（Web Push / Webhook） ----------
/** 推送通知总开关（默认关闭）。 */
export function notifyPushEnabled() {
  return readBool(readSettings(), 'notifyPushEnabled', false);
}

export function setNotifyPushEnabled(on) {
  return writeBool('notifyPushEnabled', on);
}

/** 任务完成时是否通知（默认开启；总开关关闭时不生效）。 */
export function notifyOnTaskDone() {
  return readBool(readSettings(), 'notifyOnTaskDone', true);
}

export function setNotifyOnTaskDone(on) {
  const v = !!on;
  const s = readSettings();
  if (v === true) delete s.notifyOnTaskDone;
  else s.notifyOnTaskDone = false;
  writeSettings(s);
  return v;
}

/** Webhook 总开关（默认关闭）。 */
export function notifyWebhookEnabled() {
  return readBool(readSettings(), 'notifyWebhookEnabled', false);
}

export function setNotifyWebhookEnabled(on) {
  return writeBool('notifyWebhookEnabled', on);
}

/** Webhook 平台预设（默认 generic）。 */
export function notifyWebhookPreset() {
  const v = readSettings().notifyWebhookPreset;
  return typeof v === 'string' && WEBHOOK_PRESETS.includes(v) ? v : 'generic';
}

export function setNotifyWebhookPreset(value) {
  const v = String(value ?? '').trim().toLowerCase() || 'generic';
  if (!WEBHOOK_PRESETS.includes(v)) {
    throw new Error(`不支持的 webhook 类型：${value} | unsupported webhook preset`);
  }
  const s = readSettings();
  if (v === 'generic') delete s.notifyWebhookPreset;
  else s.notifyWebhookPreset = v;
  writeSettings(s);
  return v;
}

/** Webhook 地址（默认空 = 未配置）。 */
export function notifyWebhookUrl() {
  const v = readSettings().notifyWebhookUrl;
  return typeof v === 'string' ? v : '';
}

export function setNotifyWebhookUrl(value) {
  const v = String(value ?? '').trim();
  if (v) {
    let url;
    try {
      url = new URL(v);
    } catch {
      throw new Error('Webhook 地址不是合法 URL | webhook URL is not a valid URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Webhook 地址必须是 http/https | webhook URL must be http(s)');
    }
  }
  const s = readSettings();
  if (v) s.notifyWebhookUrl = v;
  else delete s.notifyWebhookUrl;
  writeSettings(s);
  return v;
}

/**
 * Webhook 密钥（钉钉加签用；默认空）。**只写不读**：RPC/status 只回是否已设置，
 * 所以这里返回的值只允许在宿主机内部（notify-hook）使用。
 */
export function notifyWebhookSecret() {
  const v = readSettings().notifyWebhookSecret;
  return typeof v === 'string' ? v : '';
}

export function setNotifyWebhookSecret(value) {
  const raw = String(value ?? '').trim();
  if (/[\u0000-\u001f\u007f]/.test(raw) || raw.length > 512) {
    throw new Error('Webhook 密钥含非法字符或过长 | invalid webhook secret');
  }
  const s = readSettings();
  if (raw) s.notifyWebhookSecret = raw;
  else delete s.notifyWebhookSecret;
  writeSettings(s);
  return raw.length > 0;
}

/** 同一会话两次通知之间的最小间隔（秒，默认 10；0 = 不去抖）。 */
export function notifyMinIntervalSec() {
  const n = Number(readSettings().notifyMinIntervalSec);
  return Number.isInteger(n) && n >= 0 && n <= 3600 ? n : 10;
}

export function setNotifyMinIntervalSec(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 3600) {
    throw new Error('通知最小间隔必须是 0..3600 的整数秒 | min interval must be 0..3600 seconds');
  }
  const s = readSettings();
  if (n === 10) delete s.notifyMinIntervalSec;
  else s.notifyMinIntervalSec = n;
  writeSettings(s);
  return n;
}

/**
 * 通知设置快照（**含 webhook 密钥明文**，只给宿主机内部使用）。
 * 对外一律走 notifyConfigView()：密钥只回 webhookConfigured 布尔值。
 */
export function notifySettings() {
  return {
    pushEnabled: notifyPushEnabled(),
    onTaskDone: notifyOnTaskDone(),
    webhookEnabled: notifyWebhookEnabled(),
    webhookPreset: notifyWebhookPreset(),
    webhookUrl: notifyWebhookUrl(),
    webhookSecret: notifyWebhookSecret(),
    minIntervalSec: notifyMinIntervalSec(),
  };
}

/** 通知设置脱敏视图（status/RPC 用；绝不回显 webhook 密钥）。 */
export function notifyConfigView() {
  const s = notifySettings();
  return {
    pushEnabled: s.pushEnabled,
    onTaskDone: s.onTaskDone,
    webhookEnabled: s.webhookEnabled,
    webhookPreset: s.webhookPreset,
    webhookUrl: s.webhookUrl,
    webhookConfigured: s.webhookSecret.length > 0,
    minIntervalSec: s.minIntervalSec,
  };
}

// ---------- 通行密钥（WebAuthn）总开关 ----------
/** 是否允许在固定域名通道（named / ssh）用通行密钥登录（默认关闭）。 */
export function passkeyEnabled() {
  return readBool(readSettings(), 'passkeyEnabled', false);
}

export function setPasskeyEnabled(on) {
  return writeBool('passkeyEnabled', on);
}

// ---------- 恢复出厂设置 ----------
// 设置出问题时的临时兜底：删掉 settings.json 即回到出厂默认（文件缺失 = 默认开启，
// 于是局域网访问开、访问密码开、手机端右边栏开、局域网地址自动、公网模式随机）。
// DSH 自身的会话、模型、插件配置都在 $DSH_HOME 的其他目录，不受影响。

/** 删除本机设置文件（不存在也算成功）；返回 true 表示已清空。 */
export function resetSettings() {
  try {
    rmSync(settingsPath(), { force: true });
    return true;
  } catch {
    return false;
  }
}

// ---------- 命名隧道配置（issue #66：固定公网域名） ----------
// 用户在 Cloudflare Zero Trust（Networks → Tunnels）创建命名隧道并复制 Tunnel Token，
// 把自己域名的 ingress Service 指向 http://127.0.0.1:<代理端口>；填到这里后，
// 开启公网改用 `cloudflared tunnel run`，公网地址固定为该域名（重启不再变化）。
// token 是长期凭据：只存本机 0o600 文件，RPC 只写不读（回显仅 tokenSet 布尔值）。

/** 隧道模式：'quick'（默认，随机地址）| 'named'（固定域名）| 'ssh'（自有 VPS + SSH 反向端口转发）。 */
export function tunnelMode() {
  const v = readSettings().tunnelMode;
  return v === 'named' || v === 'ssh' ? v : 'quick';
}

/**
 * 设置隧道模式（持久化，三选一互斥：单个 tunnelMode 键即天然互斥，写新值就顶掉旧通道）。
 * 只改模式，不动另一条通道的配置（token/hostname/sshHost 都留着，切回来不用重填）；
 * 运行中的旧通道由 lib/service.mjs 在启动新通道前关闭。
 */
export function setTunnelMode(mode) {
  if (mode !== 'quick' && mode !== 'named' && mode !== 'ssh') {
    throw new Error('隧道模式必须是 quick、named 或 ssh | tunnel mode must be quick, named or ssh');
  }
  const s = readSettings();
  if (mode === 'quick') delete s.tunnelMode;
  else s.tunnelMode = mode;
  writeSettings(s);
  return mode;
}

/** 命名隧道 Token（未配置返回空字符串）。 */
export function tunnelToken() {
  const v = readSettings().tunnelToken;
  return typeof v === 'string' ? v : '';
}

/**
 * 设置命名隧道 Token（持久化）。空字符串清除；非空要求至少 20 个
 * base64url 字符（Cloudflare Token 是长 base64 串，过短/含空白视为无效）。
 */
export function setTunnelToken(value) {
  const v = String(value ?? '').trim();
  if (v) {
    if (v.length < 20 || !/^[A-Za-z0-9+/_=-]+$/.test(v)) {
      throw new Error('Tunnel Token 格式不对（应为 Cloudflare 后台复制的完整 Token） | invalid tunnel token');
    }
  }
  const s = readSettings();
  if (v) s.tunnelToken = v;
  else delete s.tunnelToken;
  writeSettings(s);
  return v;
}

/** 命名隧道绑定的固定域名（未配置返回空字符串）。 */
export function tunnelHostname() {
  const v = readSettings().tunnelHostname;
  return typeof v === 'string' ? v : '';
}

/**
 * 设置固定域名（持久化）。接受 `https://host/path` 粘贴并归一化为裸域名；
 * 空字符串清除。要求是带点的合法公网域名（局域网主机名/裸 IP 不允许——
 * 那不该走公网密码边界之外的东西）。
 */
export function setTunnelHostname(value) {
  let v = String(value ?? '').trim().toLowerCase();
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#\s]/)[0].replace(/:\d+$/, '').replace(/\.$/, '');
  if (v) {
    const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
    const IS_IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
    if (IS_IPV4.test(v) || !v.includes('.') || !HOSTNAME_RE.test(v)) {
      throw new Error('固定域名格式不对（如 pocket.example.com） | invalid tunnel hostname');
    }
  }
  const s = readSettings();
  if (v) s.tunnelHostname = v;
  else delete s.tunnelHostname;
  writeSettings(s);
  return v;
}

// ---------- 代理端口（issue #70） ----------
// 局域网代理的监听端口（默认 3081）。插件模式下唯一改法就是写 settings.json 的
// proxyPort 字段（CLI 模式可用 dsh-pocket --port）。允许范围 1-65535；
// 端口已被占用时 dsh web 启动会直接抛 EADDRINUSE（保持原行为），不必在 setter 校验。
/** 当前代理端口（0 = 用默认 3081）。 */
export function proxyPort() {
  const v = Number(readSettings().proxyPort);
  return Number.isInteger(v) && v >= 1 && v <= 65535 ? v : 0;
}

/** 设置代理端口（持久化）。空/0/非法值清除，回退默认 3081。 */
export function setProxyPort(value) {
  const n = Number(value);
  const s = readSettings();
  if (Number.isInteger(n) && n >= 1 && n <= 65535) s.proxyPort = n;
  else delete s.proxyPort;
  writeSettings(s);
  return proxyPort();
}

// ---------- cloudflared 路径（issue #45：远程 Linux 服务器下载源不可达时手动指定） ----------
// Linux 服务器在国内/部分企业网下，所有 CDN 源（GitHub / ghproxy / gh.ddlc / gh-proxy）
// 都连不上时，下载 cloudflared 二进制始终失败。允许用户在 settings.json 里**写死
// 一个已经存在 / 自己上传的 cloudflared 路径**，跳过下载。`lib/tunnel.mjs` 的
// `resolveCloudflared` 启动时会优先读 `process.env.DSH_POCKET_CLOUDFLARED`，
// 找不到再回退到 PATH 探测和下载。`lib/index.js` 在插件 apply 时把 settings
// 的这个值写入 env，确保 service 走自定义路径。
// 空字符串 = 清除，回退到默认行为（PATH 探测 + 下载）。
/** 当前 cloudflared 自定义路径（空 = 用默认）。 */
export function cloudflaredPath() {
  return readSettings().cloudflaredPath ?? '';
}

/** 设置 cloudflared 自定义路径。空字符串清除（回退到 PATH 探测 + 下载）。 */
export function setCloudflaredPath(value) {
  const v = String(value ?? '').trim();
  const s = readSettings();
  if (v) s.cloudflaredPath = v;
  else delete s.cloudflaredPath;
  writeSettings(s);
  return v;
}
