window.__ModuleLoader__.load({
  id: "dsh-pocket",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// client/index.jsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name,
  redactStatus: () => redactStatus
});
module.exports = __toCommonJS(index_exports);

// lib/passkey-client.mjs
function pocketErrorText(error, fallback = "\u64CD\u4F5C\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5 | Operation failed \u2014 please retry") {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error === "object") {
    if (typeof error.message === "string" && error.message.trim()) return error.message.trim();
    if (error.error && error.error !== error) return pocketErrorText(error.error, fallback);
    if (typeof error.name === "string" && error.name.trim()) return error.name.trim();
    if (typeof error.code === "string" && error.code.trim()) return error.code.trim();
  }
  return fallback;
}
function pocketCredentialToJSON(credential, ceremony) {
  if (!credential) throw new Error("\u9A8C\u8BC1\u5DF2\u53D6\u6D88\uFF0C\u8BF7\u91CD\u8BD5 | Verification cancelled \u2014 please retry");
  let json = {};
  try {
    if (typeof credential.toJSON === "function") json = credential.toJSON() || {};
  } catch {
  }
  const response = credential.response || {};
  const encoded = json.response || {};
  const bytes = (value) => {
    if (typeof value === "string") return /^[A-Za-z0-9_-]+$/.test(value) ? value : "";
    let view;
    if (ArrayBuffer.isView(value)) view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    else if (Object.prototype.toString.call(value) === "[object ArrayBuffer]") view = new Uint8Array(value);
    else return "";
    let text = "";
    for (let i = 0; i < view.length; i++) text += String.fromCharCode(view[i]);
    return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const required = (field, value) => {
    if (!value) throw new Error("\u6D4F\u89C8\u5668\u8FD4\u56DE\u7684\u901A\u884C\u5BC6\u94A5\u7F3A\u5C11 " + field + "\uFF0C\u8BF7\u91CD\u8BD5\u6216\u66F4\u65B0\u6D4F\u89C8\u5668 | Passkey response is missing " + field + " \u2014 retry or update your browser");
    return value;
  };
  const rawId = required("rawId", bytes(credential.rawId) || bytes(json.rawId) || bytes(credential.id) || bytes(json.id));
  const result = { id: rawId, rawId, type: credential.type || json.type || "public-key", response: {} };
  if (result.type !== "public-key") throw new Error("\u901A\u884C\u5BC6\u94A5\u7C7B\u578B\u65E0\u6548 | Invalid passkey type");
  const fields = ceremony === "register" ? ["clientDataJSON", "attestationObject"] : ["clientDataJSON", "authenticatorData", "signature"];
  for (const field of fields) {
    result.response[field] = required(field, bytes(response[field]) || bytes(encoded[field]));
  }
  if (ceremony === "register") {
    let transports = encoded.transports;
    try {
      if (typeof response.getTransports === "function") transports = response.getTransports();
    } catch {
    }
    result.response.transports = Array.isArray(transports) ? [...new Set(transports.filter((v) => typeof v === "string"))] : [];
  } else {
    result.response.userHandle = bytes(response.userHandle) || bytes(encoded.userHandle) || null;
  }
  return result;
}
var PASSKEY_CLIENT_HELPERS_SRC = `${pocketErrorText.toString()}
${pocketCredentialToJSON.toString()}`;

// client/index.jsx
var import_react = require("react");

// client/api.js
var POCKET_RPC_CHANNEL = "/dsh-pocket";
var POCKET_ENDPOINTS = Object.freeze({
  status: "pocket.status",
  tunnelStart: "tunnel.start",
  tunnelStop: "tunnel.stop",
  tunnelSetConfig: "tunnel.setConfig",
  version: "pocket.version",
  update: "pocket.update",
  restart: "pocket.restart",
  lanTokenRefresh: "token.lanRefresh",
  lanAuthSetEnabled: "lanAuth.setEnabled",
  lanSetOverride: "lan.setOverride",
  lanSetEnabled: "lan.setEnabled",
  pinSetCustom: "pin.setCustom",
  pocketReset: "pocket.reset",
  // 移动端「复制文件内容」（issue #17）：手机经此 RPC 让主机读取文件正文，
  // 再写入剪贴板——因为手机无法直接打开电脑上的文件。
  fileRead: "pocket.fileRead",
  // 第三通道「自有服务器 + SSH 反向端口映射」：配置、状态/测试连接。
  // 三个公网入口（Quick / Named / SSH）互斥，由宿主的 tunnelMode 决定。
  sshSetConfig: "ssh.setConfig",
  sshStatus: "ssh.status",
  // 通行密钥（WebAuthn）设备管理（仅本机可调）。
  passkeySetEnabled: "passkey.setEnabled",
  passkeyList: "passkey.list",
  passkeyRevoke: "passkey.revoke",
  passkeyRename: "passkey.rename",
  // 通知：Web Push 订阅 + Webhook 配置与测试。
  notifySetConfig: "notify.setConfig",
  notifyStatus: "notify.status",
  notifyRemoveSubscription: "notify.removeSubscription",
  notifyClearSubscriptions: "notify.clearSubscriptions",
  notifyTest: "notify.test",
  // 网络自检：在宿主进程里探测订阅/Webhook 主机的 DNS、TCP、HTTP 与进程网络环境。
  notifyDiagnose: "notify.diagnose"
});
function compareVersions(a, b) {
  const pa = String(a).replace(/^[vV]/, "").split(".");
  const pb = String(b).replace(/^[vV]/, "").split(".");
  for (let i = 0; i < 3; i++) {
    const x = parseInt(pa[i], 10) || 0;
    const y = parseInt(pb[i], 10) || 0;
    if (x !== y) return x - y;
  }
  const aPre = String(a).replace(/^[vV]/, "").match(/-.*$/)?.[0] ?? "";
  const bPre = String(b).replace(/^[vV]/, "").match(/-.*$/)?.[0] ?? "";
  if (!aPre && !bPre) return 0;
  if (!aPre) return 1;
  if (!bPre) return -1;
  const aParts = aPre.slice(1).split(".");
  const bParts = bPre.slice(1).split(".");
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const ax = aParts[i] ?? "";
    const bx = bParts[i] ?? "";
    if (ax === bx) continue;
    const aNum = /^\d+$/.test(ax);
    const bNum = /^\d+$/.test(bx);
    if (aNum && bNum) return Number(ax) - Number(bx);
    if (aNum) return 1;
    if (bNum) return -1;
    return ax < bx ? -1 : 1;
  }
  return 0;
}
function intOr(value, fallback) {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}
function buildAccessUrl(cfg) {
  const host = String(cfg?.accessHost || cfg?.host || "").trim();
  if (!host) return null;
  const proto = cfg?.accessProtocol === "http" ? "http" : "https";
  const port = intOr(cfg?.accessPort, 0);
  const defaultPort = proto === "http" ? 80 : 443;
  const needPort = port !== 0 && port !== defaultPort && !/:\d+$/.test(host);
  return `${proto}://${host}${needPort ? `:${port}` : ""}`;
}
var NOTIFY_PRESETS = ["generic", "wecom", "dingtalk", "feishu", "ntfy", "bark"];
var SSH_TAIL_LINES = 5;
var SSH_TAIL_LINE_MAX = 500;
var PEM_BLOCK_RE = /-----BEGIN[\s\S]*?-----END[^-]*-----/g;
var KEY_PATH_RE = /(?:~|[/\\])?[^\s"'=:]*\.ssh[/\\][^\s"'=]*|(?:^|[\s"'=(])(?:id_(?:rsa|dsa|ecdsa|ed25519))(?:\.pub)?/gi;
function scrubKeyMaterial(text) {
  return String(text ?? "").replace(PEM_BLOCK_RE, "[redacted private key]").replace(KEY_PATH_RE, "[redacted key path]");
}
function intOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}
function redactSsh(ssh) {
  const c = ssh?.config ?? {};
  const config = {
    host: c.host ?? "",
    port: intOr(c.port, 22),
    user: c.user ?? "",
    keyPathSet: c.keyPathSet === true,
    remoteBindPort: intOr(c.remoteBindPort, 7788),
    accessProtocol: c.accessProtocol === "http" ? "http" : "https",
    accessHost: c.accessHost ?? "",
    accessPort: intOr(c.accessPort, 0),
    autoRestore: c.autoRestore !== false
  };
  const url = ssh?.url ?? buildAccessUrl({ ...config, host: config.accessHost || config.host });
  const evidence = ssh?.evidence === "forward-ok" || ssh?.evidence === "grace" ? ssh.evidence : null;
  const attempts = intOrNull(ssh?.attempts) ?? 0;
  const nextRetryInMs = intOrNull(ssh?.nextRetryInMs);
  const stderrTail = Array.isArray(ssh?.stderrTail) ? ssh.stderrTail.slice(-SSH_TAIL_LINES).map((line) => scrubKeyMaterial(line).slice(0, SSH_TAIL_LINE_MAX)) : [];
  const rawTarget = ssh?.target;
  const target = rawTarget && typeof rawTarget === "object" && !Array.isArray(rawTarget) ? {
    host: typeof rawTarget.host === "string" ? rawTarget.host : "",
    user: typeof rawTarget.user === "string" ? rawTarget.user : "",
    port: intOr(rawTarget.port, 22),
    remote: typeof rawTarget.remote === "string" ? rawTarget.remote : null,
    local: typeof rawTarget.local === "string" ? rawTarget.local : null
  } : null;
  return {
    running: ssh?.running === true,
    state: typeof ssh?.state === "string" ? ssh.state : "idle",
    url,
    qr: ssh?.qr ?? null,
    // lastError 是 ssh 的原文诊断：同样过一遍私钥材料清洗（路径→占位符，其余原样）
    lastError: ssh?.lastError == null ? null : scrubKeyMaterial(ssh.lastError),
    evidence,
    attempts,
    nextRetryInMs,
    stderrTail,
    target,
    config
  };
}
function redactNotify(n) {
  return {
    pushEnabled: n?.pushEnabled === true,
    onTaskDone: n?.onTaskDone !== false,
    webhookEnabled: n?.webhookEnabled === true,
    webhookPreset: NOTIFY_PRESETS.includes(n?.webhookPreset) ? n.webhookPreset : "generic",
    webhookUrl: n?.webhookUrl ?? "",
    webhookConfigured: n?.webhookConfigured === true,
    subscriptionCount: intOr(n?.subscriptionCount, 0),
    // 冻结合同之外的可选字段：宿主返回时透传（设置页回显最小间隔），缺失为 null
    minIntervalSec: n?.minIntervalSec == null ? null : intOr(n.minIntervalSec, null)
  };
}
function redactPasskey(p) {
  return {
    enabled: p?.enabled === true,
    rpId: p?.rpId ?? "",
    deviceCount: intOr(p?.deviceCount, 0)
  };
}
function redactStatus(s) {
  return {
    proxyRunning: s?.proxyRunning === true,
    proxyPort: s?.proxyPort ?? null,
    lanUrl: s?.lanUrl ?? null,
    lanQr: s?.lanQr ?? null,
    lanCandidates: Array.isArray(s?.lanCandidates) ? s.lanCandidates : [],
    lanIpOverride: s?.lanIpOverride ?? "",
    tunnelRunning: s?.tunnelRunning === true,
    tunnelUrl: s?.tunnelUrl ?? null,
    tunnelQr: s?.tunnelQr ?? null,
    tunnelState: s?.tunnelState ?? { phase: "idle" },
    tunnelConfig: s?.tunnelConfig ?? { mode: "quick", hostname: "", tokenSet: false },
    dshPort: s?.dshPort ?? null,
    // 以下三块由后续 host 提供；旧 host 不返回时用默认值兜底（不返回 undefined 给 UI）
    ssh: redactSsh(s?.ssh),
    notify: redactNotify(s?.notify),
    passkey: redactPasskey(s?.passkey)
  };
}

// client/pocket-locales.js
var NS = "pocket";
var zh = {
  "section": "\u624B\u673A\u8BBF\u95EE",
  "title": "\u{1F4F1} \u624B\u673A\u8BBF\u95EE",
  "subtitle": "\u624B\u673A\u626B\u7801\u6253\u5F00\u7684\u5C31\u662F\u7535\u8111\u4E0A\u7684\u8FD9\u4E2A\u754C\u9762\uFF0C\u5B9E\u65F6\u540C\u6B65",
  "developer": "\u5F00\u53D1\u8005\uFF1A\u7A0B\u5E8F\u5458\u5C11\u5317\u6668",
  "starAsk": "\u2B50 \u987A\u624B\u7559\u9897 Star\uFF0C\u4F5C\u8005\u80FD\u9AD8\u5174\u4E00\u6574\u5929",
  "starCta": "\u884C\uFF0C\u7ED9\u4F60\u4E00\u9897 Star",
  "restarted": "\u{1F504} \u5DF2\u91CD\u542F",
  "ok": "\u77E5\u9053\u4E86",
  "bgHint": "\u8FDB\u7A0B\u5728\u540E\u53F0\u8FD0\u884C\uFF08\u4E0D\u6302\u7EC8\u7AEF\uFF09\u3002\u5982\u9700\u505C\u6B62\uFF1A{cmd}",
  "updatedRestart": "\u2705 \u5DF2\u66F4\u65B0 v{ver}\uFF0C\u91CD\u542F\u751F\u6548",
  "updateAutoRestarting": "\u2705 \u5DF2\u66F4\u65B0 v{ver}\uFF0C\u6B63\u5728\u81EA\u52A8\u91CD\u542F\u2026",
  "updatedOk": "\u2705 \u5DF2\u66F4\u65B0 v{ver}",
  "updateAvailable": "\u{1F4E6} \u65B0\u7248\u672C v{ver}",
  "updating": "\u66F4\u65B0\u4E2D\u2026",
  "updateTo": "\u66F4\u65B0\u5230 v{ver}",
  "restartingNow": "\u6B63\u5728\u91CD\u542F\u751F\u6548\u2026",
  "restarting": "\u91CD\u542F\u4E2D\u2026",
  "restartNow": "\u{1F504} \u91CD\u542F dsh web \u751F\u6548",
  "updatingDetail": "\u23F3 \u66F4\u65B0\u4E2D\uFF08\u901A\u5E38 1-2 \u5206\u949F\uFF09\xB7 \u5DF2\u7B49\u5F85 {s} \u79D2",
  "restartingDetail": "\u23F3 \u6B63\u5728\u91CD\u542F\u751F\u6548\uFF08\u901A\u5E38 10-30 \u79D2\uFF09\xB7 \u5DF2\u7B49\u5F85 {s} \u79D2",
  "updatedAutoDetail": "\u2705 \u5DF2\u66F4\u65B0\uFF0C\u6B63\u5728\u81EA\u52A8\u91CD\u542F\u751F\u6548\uFF0C\u8BF7\u7A0D\u5019\u5237\u65B0",
  "updatedRestartDetail": "\u2705 \u5DF2\u66F4\u65B0\uFF0C\u91CD\u542F dsh web \u751F\u6548",
  "updateFailed": "\u274C \u5931\u8D25\uFF1A{err}\uFF08\u624B\u52A8\u66F4\u65B0\uFF1Adsh plugin --profile web update dsh-pocket --latest -w\uFF09",
  "versionRange": "\u5F53\u524D v{cur} \u2192 \u6700\u65B0 v{latest}",
  "wanAccess": "\u516C\u7F51\u8BBF\u95EE",
  "pinLabel": "\u8BBF\u95EE\u5BC6\u7801",
  "modeLabel": "\u5730\u5740\u6A21\u5F0F",
  "advAddress": "\u9AD8\u7EA7 \xB7 \u624B\u52A8\u9009\u5730\u5740",
  "wanOffHint": "\u5F00\u542F\u540E\u53EF\u4ECE\u4EFB\u4F55\u7F51\u7EDC\u8BBF\u95EE\uFF08\u6BCF\u6B21\u5F00\u542F\u9700\u786E\u8BA4\u514D\u8D23\u58F0\u660E\uFF09",
  "resetFactory": "\u{1F9F9} \u6062\u590D\u51FA\u5382\u8BBE\u7F6E",
  "resetGo": "\u6062\u590D",
  "resetIntro": "\u8BBE\u7F6E\u641E\u51FA\u95EE\u9898\u65F6\u7684\u4E34\u65F6\u515C\u5E95\uFF1A\u6E05\u7A7A\u672C\u673A\u914D\u7F6E\u5E76\u91CD\u8BBE\u968F\u673A\u5BC6\u7801\uFF08DSH \u7684\u4F1A\u8BDD\u3001\u6A21\u578B\u3001\u63D2\u4EF6\u914D\u7F6E\u4E0D\u53D7\u5F71\u54CD\uFF09",
  "resetTitle": "\u26A0\uFE0F \u786E\u8BA4\u6062\u590D\u51FA\u5382\u8BBE\u7F6E\uFF1F",
  "resetBody": "\u5C06\u6E05\u7A7A\u5E76\u6062\u590D\u9ED8\u8BA4\uFF1A\n\u2460 \u5F00\u5173\uFF1A\u5C40\u57DF\u7F51\u8BBF\u95EE=\u5F00\u3001\u8BBF\u95EE\u5BC6\u7801=\u5F00\u3001\u5C40\u57DF\u7F51\u5730\u5740=\u81EA\u52A8\n\u2461 \u516C\u7F51\uFF1A\u6A21\u5F0F\u56DE\u5230\u968F\u673A\u57DF\u540D\uFF0C\u6E05\u7A7A Tunnel Token \u4E0E\u56FA\u5B9A\u57DF\u540D\uFF0C\u5E76\u5173\u95ED\u6B63\u5728\u8FD0\u884C\u7684\u516C\u7F51\n\u2462 \u5BC6\u7801\uFF1A\u516C\u7F51\u548C\u5C40\u57DF\u7F51\u90FD\u6362\u6210\u65B0\u7684\u968F\u673A 8 \u4F4D\u5BC6\u7801\uFF08\u65E7\u5BC6\u7801\u7ACB\u5373\u4F5C\u5E9F\uFF0C\u624B\u673A\u9700\u91CD\u65B0\u8F93\u5165\uFF09\n\nDSH \u81EA\u8EAB\u7684\u4F1A\u8BDD\u3001\u6A21\u578B\u3001\u63D2\u4EF6\u914D\u7F6E\u4E0D\u53D7\u5F71\u54CD\uFF1B\u6B64\u64CD\u4F5C\u4E0D\u53EF\u64A4\u9500\u3002",
  "resetConfirm": "\u786E\u8BA4\u6062\u590D",
  "resetDone": "\u2705 \u5DF2\u6062\u590D\u51FA\u5382\u8BBE\u7F6E\uFF1A\u8BBE\u7F6E\u5DF2\u6E05\u7A7A\uFF0C\u5BC6\u7801\u5DF2\u6362\u65B0\uFF08\u624B\u673A\u9700\u91CD\u65B0\u8F93\u5165\uFF09",
  "resetFailed": "\u274C \u6062\u590D\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5",
  "lanTitle": "\u{1F4F6} \u5C40\u57DF\u7F51\uFF08\u540C\u4E00 WiFi\uFF09",
  "lanHint": "\u624B\u673A\u8FDE\u63A5\u540C\u4E00 WiFi \u540E\u626B\u7801\u5373\u53EF\u6253\u5F00",
  "lanAccess": "\u5C40\u57DF\u7F51\u8BBF\u95EE",
  "lanDisabledHint": "\u{1F512} \u5C40\u57DF\u7F51\u8BBF\u95EE\u5DF2\u5173\u95ED\uFF1A\u624B\u673A\u626B\u7801/\u94FE\u63A5\u5747\u4E0D\u53EF\u7528\uFF08\u516C\u7F51\u4E0D\u53D7\u5F71\u54CD\uFF09\u3002\u70B9\u300C\u5F00\u300D\u6062\u590D\u3002",
  "lanToggleTitleOff": "\u5173\u95ED\u5C40\u57DF\u7F51\u8BBF\u95EE",
  "lanToggleBodyOff": "\u5173\u95ED\u540E\uFF0C\u540C\u4E00 WiFi \u4E0B\u7684\u624B\u673A\u5C06\u65E0\u6CD5\u626B\u7801\u8BBF\u95EE\uFF08\u5C40\u57DF\u7F51\u4E8C\u7EF4\u7801/\u94FE\u63A5\u7ACB\u5373\u5931\u6548\uFF09\u3002\u516C\u7F51\u8BBF\u95EE\u4E0D\u53D7\u5F71\u54CD\u3002\u786E\u5B9A\u5173\u95ED\uFF1F",
  "lanToggleTitleOn": "\u5F00\u542F\u5C40\u57DF\u7F51\u8BBF\u95EE",
  "lanToggleBodyOn": "\u5F00\u542F\u540E\uFF0C\u540C\u4E00 WiFi \u7684\u624B\u673A\u626B\u7801\u5373\u53EF\u8BBF\u95EE\uFF08\u9ED8\u8BA4\u9700\u8F93\u5165\u5C40\u57DF\u7F51\u5BC6\u7801\uFF09\u3002\u786E\u5B9A\u5F00\u542F\uFF1F",
  "confirm": "\u786E\u5B9A",
  "lanAddress": "\u5C40\u57DF\u7F51\u5730\u5740",
  "lanAddressAuto": "\u81EA\u52A8\uFF08\u63A8\u8350\uFF09",
  "lanPin": "\u5C40\u57DF\u7F51\u8BBF\u95EE\u5BC6\u7801",
  "on": "\u5F00",
  "off": "\u5173",
  "lanPinValue": "\u{1F510} \u8BBF\u95EE\u5BC6\u7801\uFF1A{pin}\uFF08\u624B\u673A\u6253\u5F00\u9700\u8F93\u5165\uFF1B\u4E0E\u516C\u7F51\u5BC6\u7801\u5206\u5F00\uFF09",
  "lanPinCustomValue": "\u{1F510} \u8BBF\u95EE\u5BC6\u7801\uFF1A{pin}\uFF08\u81EA\u5B9A\u4E49\uFF1B\u624B\u673A\u6253\u5F00\u9700\u8F93\u5165\uFF09",
  "refresh": "\u5237\u65B0",
  "customize": "\u81EA\u5B9A\u4E49",
  "customizing": "\u65B0\u5BC6\u7801\uFF088\u201364 \u4F4D\uFF0C\u82F1\u6587\u5B57\u6BCD\u6216\u6570\u5B57\uFF09\uFF1A",
  "save": "\u4FDD\u5B58",
  "cancel": "\u53D6\u6D88",
  "pinInvalid": "\u5BC6\u7801\u5FC5\u987B\u662F 8\u201364 \u4F4D\u82F1\u6587\u5B57\u6BCD\u6216\u6570\u5B57",
  "pinCustomHint": "\u81EA\u5B9A\u4E49\u540E\u5F00\u542F\u516C\u7F51\u4E0D\u518D\u81EA\u52A8\u6362\u65B0",
  "lanPinOff": "\u{1F513} \u5BC6\u7801\u5DF2\u5173\u95ED\uFF1A\u626B\u7801\u76F4\u8FDE\uFF0C\u65E0\u9700\u5BC6\u7801\uFF08\u4EC5\u540C\u4E00\u5C40\u57DF\u7F51\u8BBE\u5907\u53EF\u8BBF\u95EE\uFF1B\u516C\u7F51\u4ECD\u8981\u5BC6\u7801\uFF09",
  "lanStarting": "\u4EE3\u7406\u672A\u5C31\u7EEA\u2026",
  "wanTitle": "\u{1F310} \u516C\u7F51\uFF08\u4EBA\u5728\u5916\u9762\uFF09",
  "wanHint": "\u4EFB\u4F55\u7F51\u7EDC\u626B\u7801\u5373\u7528\uFF08URL \u6BCF\u6B21\u91CD\u542F\u81EA\u52A8\u6362\u65B0\uFF09",
  "wanPin": "\u{1F510} \u8BBF\u95EE\u5BC6\u7801\uFF1A{pin}\uFF08\u6BCF\u6B21\u5F00\u542F\u516C\u7F51\u53D8\u65B0\uFF1B\u624B\u673A\u6253\u5F00\u94FE\u63A5\u9700\u8F93\u5165\u6B64\u5BC6\u7801\uFF09",
  "wanPinCustom": "\u{1F510} \u8BBF\u95EE\u5BC6\u7801\uFF1A{pin}\uFF08\u81EA\u5B9A\u4E49\uFF0C\u5F00\u542F\u516C\u7F51\u4E0D\u518D\u81EA\u52A8\u6362\u65B0\uFF09",
  "wanEphemeralWarn": "\u26A0\uFE0F \u516C\u7F51\u94FE\u63A5\u4EC5\u5728\u672C\u6B21\u5F00\u542F\u671F\u95F4\u6709\u6548\uFF1A\u5173\u95ED\u6216\u91CD\u542F\u540E\u5931\u6548\uFF0C\u5E76\u53EF\u80FD\u88AB\u4ED6\u4EBA\u590D\u7528\u4E3A\u964C\u751F\u7F51\u7AD9\u3002\u8BF7\u52FF\u6536\u85CF\uFF0C\u6BCF\u6B21\u4ECE\u672C\u9875\u626B\u300C\u5F53\u524D\u300D\u4E8C\u7EF4\u7801\u3002\u9700\u8981\u56FA\u5B9A\u4E0D\u53D8\u7684\u5730\u5740\u8BF7\u7528\u4E0B\u65B9\u300C\u56FA\u5B9A\u57DF\u540D\u300D\u3002",
  "stopTunnel": "\u5173\u95ED\u516C\u7F51",
  "enable": "\u5F00\u542F\u516C\u7F51\u8BBF\u95EE",
  "opening": "\u5F00\u542F\u4E2D\u2026",
  "startChannel": "\u5F00\u542F\u516C\u7F51\u8BBF\u95EE\uFF08{channel}\uFF09",
  "channelQuick": "Cloudflare \u5FEB\u901F\u96A7\u9053",
  "channelNamed": "Cloudflare \u56FA\u5B9A\u57DF\u540D",
  "channelSsh": "SSH \u53CD\u5411\u96A7\u9053",
  "modePendingHint": "\u300C{channel}\u300D\u5C1A\u672A\u4FDD\u5B58\uFF1A\u70B9\u51FB\u5F00\u59CB\u4F1A\u5148\u4FDD\u5B58\u5E76\u542F\u52A8\u5B83",
  "tunnelMode": "\u516C\u7F51\u6A21\u5F0F\uFF1A",
  "modeQuick": "\u968F\u673A\u57DF\u540D\uFF08\u9ED8\u8BA4\uFF09",
  "modeNamed": "\u56FA\u5B9A\u57DF\u540D",
  "namedSummary": "\u56FA\u5B9A\u57DF\u540D\uFF1A{host} \xB7 Token {token}",
  "namedTokenSet": "\u5DF2\u914D\u7F6E",
  "namedTokenMissing": "\u672A\u914D\u7F6E",
  "namedEdit": "\u4FEE\u6539",
  "namedHostnameLabel": "\u56FA\u5B9A\u57DF\u540D\uFF1A",
  "namedTokenLabel": "Tunnel Token\uFF08\u7559\u7A7A = \u4FDD\u6301\u4E0D\u53D8\uFF09\uFF1A",
  "namedHow": "\u5728 Cloudflare Zero Trust \u2192 Networks \u2192 Tunnels \u521B\u5EFA\u96A7\u9053\u5E76\u590D\u5236 Token\uFF1B\u628A\u57DF\u540D\u7684 Service \u6307\u5411 http://127.0.0.1:3081\uFF08\u4EE3\u7406\u7AEF\u53E3\uFF09\u3002\u5730\u5740\u56FA\u5B9A\uFF0C\u91CD\u542F\u4E0D\u518D\u53D8\u5316\u3002",
  "namedSecurity": "\u56FA\u5B9A\u57DF\u540D\u957F\u671F\u66B4\u9732\u5728\u516C\u7F51\u3001\u66F4\u6613\u88AB\u626B\u63CF\uFF0C\u5EFA\u8BAE\u540C\u65F6\u8BBE\u7F6E\u81EA\u5B9A\u4E49\u5F3A\u5BC6\u7801\uFF08\u672C\u6A21\u5F0F\u516C\u7F51\u5BC6\u7801\u9ED8\u8BA4\u4E0D\u968F\u91CD\u542F\u8F6E\u6362\uFF09\u3002",
  "namedNeedCfg": "\u8BF7\u5148\u586B\u5199\u56FA\u5B9A\u57DF\u540D\u4E0E Tunnel Token",
  "namedRunningHint": "\u56FA\u5B9A\u57DF\u540D\uFF08Cloudflare \u547D\u540D\u96A7\u9053\uFF09\u2014\u2014\u5730\u5740\u4E0D\u968F\u91CD\u542F\u53D8\u5316",
  "namedTakeEffect": "\u5DF2\u4FDD\u5B58\u56FA\u5B9A\u57DF\u540D\u914D\u7F6E\u2014\u2014\u9700\u5173\u95ED\u5E76\u91CD\u65B0\u5F00\u542F\u516C\u7F51\u8BBF\u95EE\u540E\u751F\u6548",
  "disclaimerTitle": "\u26A0\uFE0F \u5B89\u5168\u514D\u8D23\u58F0\u660E",
  "disclaimerBody": "\u5F00\u542F\u516C\u7F51 = \u628A\u672C\u673A DSH\uFF08\u80FD\u6267\u884C\u4EE3\u7801\uFF09\u66B4\u9732\u5230\u4E92\u8054\u7F51\u3002\u4EFB\u4F55\u4EBA\u62FF\u5230\u516C\u7F51\u94FE\u63A5\u548C\u5BC6\u7801\uFF0C\u90FD\u80FD\u8BBF\u95EE\u751A\u81F3\u64CD\u4F5C\u4F60\u7684\u7535\u8111\u3002\u8BF7\u786E\u8BA4\uFF1A\u2460 \u4F7F\u7528\u81EA\u5B9A\u4E49\u5F3A\u5BC6\u7801\u6216\u59A5\u5584\u4FDD\u7BA1\u81EA\u52A8\u5BC6\u7801\uFF1B\u2461 \u7528\u5B8C\u7ACB\u5373\u300C\u5173\u95ED\u516C\u7F51\u300D\uFF1B\u2462 \u516C\u53F8/\u6D89\u5BC6\u7F51\u7EDC\u8BF7\u5148\u786E\u8BA4\u5408\u89C4\u3002",
  "disclaimerAgree": "\u6211\u5DF2\u77E5\u60C5\uFF0C\u540C\u610F\u5F00\u542F",
  "disclaimerHint": "\u8BF7\u52FE\u9009\u300C\u6211\u5DF2\u77E5\u60C5\u300D\u540E\u518D\u5F00\u542F\u516C\u7F51",
  "downloading": "\u23F3 \u4E0B\u8F7D cloudflared\uFF08\u9996\u6B21\u7EA6 20-50MB\uFF0C\u901A\u5E38 1-2 \u5206\u949F\uFF1B\u4E4B\u540E\u79D2\u5F00\uFF09\xB7 \u5DF2\u7B49\u5F85 {s} \u79D2",
  "connecting": "\u23F3 \u8FDE\u63A5 Cloudflare \u8FB9\u7F18\uFF08\u901A\u5E38 5-30 \u79D2\uFF09\xB7 \u5DF2\u7B49\u5F85 {s} \u79D2{suffix}",
  "slowHint": " \u2014 \u6709\u70B9\u4E45\uFF1F\u68C0\u67E5\u662F\u5426\u5F00\u7740\u4EE3\u7406/VPN\uFF08Clash TUN \u7B49\uFF09",
  "error": "\u274C \u5F00\u542F\u5931\u8D25\uFF1A{detail}\uFF08\u53EF\u91CD\u8BD5\uFF1B\u82E5\u662F\u4EE3\u7406/VPN \u95EE\u9898\u89C1 README \u6392\u969C\uFF09",
  "unknownError": "\u672A\u77E5\u9519\u8BEF",
  // ── 第三通道 SSH（task-6）：自有服务器 + 反向端口映射 ──
  "modeSsh": "SSH",
  "sshTitle": "\u{1F517} SSH \u53CD\u5411\u96A7\u9053\uFF08\u81EA\u6709\u670D\u52A1\u5668\uFF09",
  "sshHint": "\u628A\u672C\u673A DSH \u7ECF\u4F60\u7684\u670D\u52A1\u5668\u8F6C\u53D1\u51FA\u6765\uFF1B\u670D\u52A1\u5668\u9700\u5141\u8BB8\u8FDC\u7AEF\u8F6C\u53D1\uFF08sshd AllowTcpForwarding yes\uFF09\u3002",
  "sshHost": "SSH \u4E3B\u673A",
  "sshPort": "SSH \u7AEF\u53E3",
  "sshUser": "\u7528\u6237\u540D",
  "sshKeyPath": "\u79C1\u94A5\u8DEF\u5F84\uFF08\u53EF\u7559\u7A7A\uFF09",
  "sshKeyPathHint": "\u7559\u7A7A = \u7528\u9ED8\u8BA4 ssh \u914D\u7F6E\uFF08~/.ssh/config \u6216 agent\uFF09\uFF1B\u53EA\u4F20\u8DEF\u5F84\uFF0C\u4E0D\u8BFB\u53D6\u5BC6\u94A5\u5185\u5BB9",
  "sshKeyPathSet": "\u5DF2\u8BBE\u7F6E\uFF08\u7559\u7A7A\u4FDD\u5B58 = \u6539\u56DE\u9ED8\u8BA4\uFF09",
  "sshRemoteBindPort": "\u8FDC\u7AEF\u8F6C\u53D1\u7AEF\u53E3",
  "sshRemoteBindPortHint": "\u670D\u52A1\u5668\u4E0A\u76D1\u542C\u7684\u7AEF\u53E3\uFF0C\u628A\u8BBF\u95EE\u57DF\u540D\u53CD\u4EE3\u5230\u5B83",
  "sshAccessProtocol": "\u8BBF\u95EE\u534F\u8BAE",
  "sshAccessHost": "\u8BBF\u95EE\u57DF\u540D\uFF08\u53EF\u7559\u7A7A\uFF09",
  "sshAccessHostHint": "\u7559\u7A7A = \u7528 SSH \u4E3B\u673A\u540D",
  "sshAccessPort": "\u8BBF\u95EE\u7AEF\u53E3\uFF080 = \u9ED8\u8BA4\uFF09",
  "sshAutoRestore": "DSH \u91CD\u542F\u540E\u81EA\u52A8\u6062\u590D",
  "sshAutoRestoreHint": "\u5730\u5740\u4E0D\u968F\u91CD\u542F\u53D8\u5316\uFF1B\u5173\u95ED\u540E\u6BCF\u6B21\u91CD\u542F\u90FD\u8981\u624B\u52A8\u5F00\u542F\u96A7\u9053",
  "sshNeedCfg": "\u8BF7\u5148\u586B\u5199 SSH \u4E3B\u673A\u4E0E\u7528\u6237\u540D",
  "sshStartHint": "\u542F\u52A8/\u505C\u6B62\u96A7\u9053\u8BF7\u7528\u4E0A\u65B9\u300C\u5F00\u542F\u516C\u7F51\u8BBF\u95EE\u300D\u6309\u94AE\uFF08\u4E0E\u53E6\u5916\u4E24\u6761\u901A\u9053\u4E92\u65A5\uFF09",
  "sshTest": "\u6D4B\u8BD5\u8FDE\u63A5",
  "sshTesting": "\u6D4B\u8BD5\u4E2D\u2026",
  "sshTestOk": "\u2705 \u8FDE\u63A5\u6B63\u5E38",
  "sshTestFail": "\u274C \u8FDE\u63A5\u5931\u8D25\uFF1A{err}",
  "sshTestUnavailable": "\u6D4B\u8BD5\u8FDE\u63A5\u4E0D\u53EF\u7528\uFF08\u9700\u8F83\u65B0\u7684 dsh-pocket\uFF09",
  "sshSaved": "\u2705 SSH \u914D\u7F6E\u5DF2\u4FDD\u5B58\uFF1B\u91CD\u65B0\u5F00\u542F\u96A7\u9053\u540E\u751F\u6548",
  "sshStateIdle": "\u23F8 \u672A\u8FD0\u884C",
  "sshStateStarting": "\u23F3 \u6B63\u5728\u8FDE\u63A5 SSH \u670D\u52A1\u5668\u2026",
  "sshStateConnected": "\u2705 \u96A7\u9053\u5DF2\u8FDE\u63A5",
  "sshStateReconnecting": "\u23F3 \u8FDE\u63A5\u65AD\u5F00\uFF0C\u6B63\u5728\u81EA\u52A8\u91CD\u8FDE\u2026",
  "sshStateFailed": "\u274C \u8FDE\u63A5\u5931\u8D25\uFF0C\u4E0D\u518D\u81EA\u52A8\u91CD\u8BD5",
  "sshStateStopped": "\u23F8 \u5DF2\u505C\u6B62",
  "sshLastError": "\u6700\u8FD1\u9519\u8BEF\uFF1A{err}",
  "sshUrlHint": "\u96A7\u9053\u8FDE\u4E0A\u540E\u6B64\u5730\u5740\u53EF\u8BBF\u95EE",
  "sshRunningHint": "SSH \u53CD\u5411\u96A7\u9053\u5DF2\u8FDE\u901A\uFF0C\u5730\u5740\u56FA\u5B9A",
  // ── 通知与 PWA（task-6）──
  "notifyTitle": "\u{1F514} \u901A\u77E5\u4E0E PWA",
  "notifyPush": "Web Push \u63A8\u9001",
  "notifyPushHint": "\u4EFB\u52A1\u5B8C\u6210\u65F6\u63A8\u9001\u5230\u5DF2\u8BA2\u9605\u7684\u8BBE\u5907\uFF1B\u9001\u8FBE\u4F9D\u8D56\u6D4F\u89C8\u5668\u5382\u5546\u7684\u63A8\u9001\u670D\u52A1\uFF0C\u53EF\u80FD\u5EF6\u8FDF\u6216\u88AB\u7701\u7535\u7B56\u7565\u62E6\u622A",
  "notifySubsCount": "\u5DF2\u8BA2\u9605\u8BBE\u5907\uFF1A{n} \u53F0",
  "notifySubscribe": "\u6CE8\u518C\u672C\u673A\u8BA2\u9605",
  "notifyUnsubscribe": "\u53D6\u6D88\u672C\u673A\u8BA2\u9605",
  "notifySubscribed": "\u2705 \u672C\u673A\u5DF2\u8BA2\u9605\uFF1B\u4EFB\u52A1\u5B8C\u6210\u540E\u4F1A\u6536\u5230\u63A8\u9001",
  "notifyUnsubscribed": "\u2705 \u5DF2\u53D6\u6D88\u672C\u673A\u8BA2\u9605",
  "notifySubscribeFailed": "\u274C \u8BA2\u9605\u5931\u8D25\uFF1A{err}",
  "notifyUnsubscribeFailed": "\u274C \u53D6\u6D88\u5931\u8D25\uFF1A{err}",
  "notifyPushUnsupported": "\u6B64\u6D4F\u89C8\u5668\u4E0D\u652F\u6301 Web Push\uFF1AiOS \u9700\u5148\u300C\u5B89\u88C5\u5230\u4E3B\u5C4F\u300D\u518D\u4ECE\u4E3B\u5C4F\u6253\u5F00\uFF1B\u684C\u9762\u7AEF\u7528 Chrome/Edge/Firefox",
  "notifyPushInsecure": "\u5F53\u524D\u4E0D\u662F\u5B89\u5168\u4E0A\u4E0B\u6587\uFF08http \u4E14\u975E localhost\uFF09\uFF1A\u6D4F\u89C8\u5668\u5728\u8FD9\u91CC\u4E0D\u63D0\u4F9B Service Worker \u4E0E\u63A8\u9001\u8BA2\u9605\u3002\u8BF7\u6539\u7528 HTTPS \u57DF\u540D\uFF08\u81EA\u6709 VPS/Caddy \u6216 Cloudflare \u56FA\u5B9A\u57DF\u540D\uFF09\uFF0C\u6216\u5728\u672C\u673A\u7528 http://127.0.0.1:\u7AEF\u53E3 \u6253\u5F00\u3002",
  "notifyTest": "\u53D1\u9001\u6D4B\u8BD5\u901A\u77E5",
  "notifyTesting": "\u53D1\u9001\u4E2D\u2026",
  "notifyTestSent": "\u2705 \u5DF2\u53D1\u51FA\u6D4B\u8BD5\u901A\u77E5\uFF08\u6CA1\u6536\u5230\u5C31\u770B\u4E0B\u65B9\u300C\u6700\u8FD1\u63A8\u9001\u300D\uFF09",
  "notifyTestFailed": "\u274C \u53D1\u9001\u5931\u8D25\uFF1A{err}",
  "notifyLastResult": "\u6700\u8FD1\u63A8\u9001\uFF1A{text}",
  "notifyRecentTitle": "\u6700\u8FD1\u63A8\u9001\uFF08\u6700\u591A 5 \u6761\uFF09\uFF1A",
  "notifyDiagnose": "\u7F51\u7EDC\u81EA\u68C0",
  "notifyDiagnoseBtn": "\u5F00\u59CB\u81EA\u68C0",
  "notifyDiagnosing": "\u81EA\u68C0\u4E2D\u2026",
  "notifyDiagnoseNoProxy": "\u672A\u8BBE\u7F6E",
  "notifyDiagnoseEnv": "\u5BBF\u4E3B\u8FDB\u7A0B\uFF1ANode {node} \xB7 \u4EE3\u7406 {proxy} \xB7 NODE_USE_ENV_PROXY {useEnvProxy}",
  "notifyHostFcm": "Google FCM\uFF08\u56FD\u5185\u901A\u5E38\u4E0D\u53EF\u8FBE\uFF09",
  "notifyHostMozilla": "Mozilla\uFF08Firefox\uFF09",
  "notifyHostApple": "Apple\uFF08Safari/iOS\uFF09",
  "notifyResultOk": "\u6210\u529F",
  "notifyResultFail": "\u5931\u8D25\uFF1A{err}",
  "notifyResultPush": "Web Push",
  "notifyResultWebhook": "Webhook",
  "notifyNoResult": "\u8FD8\u6CA1\u6709\u63A8\u9001\u8BB0\u5F55",
  "notifyClear": "\u6E05\u7A7A\u5168\u90E8\u8BA2\u9605",
  "notifyClearConfirm": "\u6E05\u7A7A\u540E\u6240\u6709\u8BBE\u5907\u90FD\u8981\u91CD\u65B0\u6CE8\u518C\u8BA2\u9605\uFF08\u5DF2\u5931\u6548\u7684\u8BA2\u9605\u4E5F\u4F1A\u4E00\u5E76\u5220\u9664\uFF09\u3002",
  "notifyCleared": "\u2705 \u5DF2\u6E05\u7A7A\u5168\u90E8\u8BA2\u9605",
  "notifyClearFailed": "\u274C \u6E05\u7A7A\u5931\u8D25\uFF1A{err}",
  "notifyWebhook": "Webhook \u63A8\u9001",
  "notifyWebhookHint": "\u4EFB\u52A1\u5B8C\u6210\u65F6 POST \u5230\u4F60\u81EA\u5DF1\u7684\u673A\u5668\u4EBA\u6216\u670D\u52A1\uFF1B\u5BC6\u94A5\u53EA\u5B58\u5728\u7535\u8111\u4E0A\uFF0C\u4E0D\u56DE\u663E",
  "notifyPreset": "\u9884\u8BBE",
  "notifyPresetGeneric": "\u901A\u7528 JSON",
  "notifyPresetWecom": "\u4F01\u4E1A\u5FAE\u4FE1\u673A\u5668\u4EBA",
  "notifyPresetDingtalk": "\u9489\u9489\u673A\u5668\u4EBA",
  "notifyPresetFeishu": "\u98DE\u4E66\u673A\u5668\u4EBA",
  "notifyPresetNtfy": "ntfy",
  "notifyPresetBark": "Bark",
  "notifyUrl": "Webhook URL",
  "notifySecret": "\u5BC6\u94A5\uFF08\u53EF\u9009\uFF09",
  "notifySecretHint": "\u53EA\u5199\u4E0D\u56DE\u663E\uFF1B\u7559\u7A7A\u4FDD\u5B58 = \u4FDD\u6301\u5DF2\u8BBE\u7F6E\u7684\u5BC6\u94A5",
  "notifySecretSet": "\u5DF2\u8BBE\u7F6E",
  "notifyOnTaskDone": "\u4EFB\u52A1\u5B8C\u6210\u65F6\u63A8\u9001",
  "notifyMinInterval": "\u6700\u5C0F\u63A8\u9001\u95F4\u9694\uFF08\u79D2\uFF09",
  "notifyMinIntervalHint": "\u540C\u4E00\u4F1A\u8BDD\u5728\u8FD9\u4E2A\u95F4\u9694\u5185\u53EA\u63A8\u4E00\u6B21\uFF0C\u907F\u514D\u8FDE\u7EED\u5237\u5C4F",
  "notifyMinIntervalPlaceholder": "10",
  "notifySaved": "\u2705 \u901A\u77E5\u8BBE\u7F6E\u5DF2\u4FDD\u5B58",
  "pwaRow": "\u5B89\u88C5\u5230\u4E3B\u5C4F\uFF08PWA\uFF09",
  "pwaInstall": "\u5B89\u88C5\u5230\u4E3B\u5C4F",
  "pwaInstallTriggered": "\u5DF2\u8BF7\u6C42\u5B89\u88C5\uFF0C\u6309\u6D4F\u89C8\u5668\u63D0\u793A\u786E\u8BA4",
  "pwaInstallDismissed": "\u5DF2\u53D6\u6D88\u5B89\u88C5",
  "pwaInstallUnavailable": "\u5F53\u524D\u4E0D\u53EF\u5B89\u88C5\uFF08\u9700 HTTPS \u4E0E\u652F\u6301 PWA \u7684\u6D4F\u89C8\u5668\uFF09",
  "pwaStandalone": "\u5DF2\u5728\u4E3B\u5C4F\u5E94\u7528\u4E2D\u6253\u5F00",
  "pwaNeedHttps": "\u975E HTTPS\uFF1A\u6D4F\u89C8\u5668\u4E0D\u5141\u8BB8\u5B89\u88C5\u5230\u4E3B\u5C4F\uFF08\u7528 https \u57DF\u540D\u6253\u5F00\u672C\u9875\uFF09",
  "pwaUnsupported": "\u6B64\u6D4F\u89C8\u5668\u4E0D\u652F\u6301\u5B89\u88C5\u5230\u4E3B\u5C4F\uFF08\u9700 Chrome/Edge/Safari\uFF09",
  "pwaNotReady": "\u6682\u4E0D\u53EF\u5B89\u88C5\uFF1A\u6D4F\u89C8\u5668\u8FD8\u6CA1\u63D0\u4F9B\u5B89\u88C5\u6761\u4EF6\uFF08\u9700 HTTPS + \u5DF2\u6CE8\u518C Service Worker\uFF0C\u6709\u65F6\u8981\u7B49\u4E00\u4F1A\u513F\uFF09",
  // ── 通行密钥设备（task-6）──
  "passkeyTitle": "\u{1F510} \u901A\u884C\u5BC6\u94A5\u8BBE\u5907",
  "passkeyHint": "\u5F00\u542F\u540E\u767B\u5F55\u9875\u53EF\u7528\u901A\u884C\u5BC6\u94A5\u8FDB\u5165\uFF0C\u5E76\u8BB0\u4F4F\u5DF2\u6CE8\u518C\u8BBE\u5907\uFF08\u4E0D\u7528\u6BCF\u6B21\u8F93\u5165\u516C\u7F51\u5BC6\u7801\uFF09",
  "passkeyRpId": "\u5F53\u524D\u57DF\u540D\uFF08rpId\uFF09",
  "passkeyDeviceCount": "\u5DF2\u6CE8\u518C\u8BBE\u5907\uFF1A{n} \u53F0",
  "passkeyUnsupported": "\u6B64\u6D4F\u89C8\u5668\u4E0D\u652F\u6301\u901A\u884C\u5BC6\u94A5\uFF08WebAuthn\uFF09\uFF0C\u4E0D\u80FD\u6CE8\u518C\uFF1B\u8BF7\u6539\u7528\u8F83\u65B0\u7684 Chrome/Edge/Safari",
  "passkeyInsecure": "\u5F53\u524D\u4E0D\u662F HTTPS \u5B89\u5168\u73AF\u5883\uFF1A\u6D4F\u89C8\u5668\u53EA\u5141\u8BB8\u5728 HTTPS \u9875\u9762\u6CE8\u518C/\u4F7F\u7528\u901A\u884C\u5BC6\u94A5\uFF08\u5C40\u57DF\u7F51 http \u4E0B\u4E0D\u53EF\u7528\uFF09",
  "passkeySecureHint": "\u6CE8\u518C\u65F6\u6D4F\u89C8\u5668\u4F1A\u8981\u6C42\u6307\u7EB9/\u9762\u5BB9/\u7CFB\u7EDF PIN \u9A8C\u8BC1\uFF1B\u5DF2\u6CE8\u518C\u8BBE\u5907\u53EF\u5728\u4EFB\u4F55\u5DF2\u767B\u5F55\u7684\u8BBE\u7F6E\u9875\u64A4\u9500",
  "passkeyDevices": "\u8BBE\u5907\u5217\u8868",
  "passkeyRegister": "\u672C\u8BBE\u5907\u6CE8\u518C\u901A\u884C\u5BC6\u94A5",
  "passkeyRegisterBtn": "\u5728\u6B64\u8BBE\u5907\u6CE8\u518C",
  "passkeyRegistering": "\u6CE8\u518C\u4E2D\u2026\uFF08\u8BF7\u5728\u6D4F\u89C8\u5668\u91CC\u5B8C\u6210\u9A8C\u8BC1\uFF09",
  "passkeyRegistered": "\u5DF2\u5728\u672C\u8BBE\u5907\u6CE8\u518C\u901A\u884C\u5BC6\u94A5\uFF0C\u4E0B\u6B21\u53EF\u76F4\u63A5\u7528\u5B83\u767B\u5F55",
  "passkeyRegisterUnavailable": "\u5BBF\u4E3B\u672A\u6CE8\u5165\u901A\u884C\u5BC6\u94A5\u63A5\u53E3\uFF08\u9700\u8981 HTTPS + \u56FA\u5B9A\u57DF\u540D\u8BBF\u95EE\uFF09",
  "passkeyThisDevice": "\u672C\u673A\u6D4F\u89C8\u5668",
  "passkeyNoDevices": "\u8FD8\u6CA1\u6709\u6CE8\u518C\u8BBE\u5907",
  "passkeyColCreated": "\u6CE8\u518C\u65F6\u95F4",
  "passkeyColLastLogin": "\u6700\u540E\u767B\u5F55",
  "passkeyRename": "\u91CD\u547D\u540D",
  "passkeyRevoke": "\u64A4\u9500",
  "passkeyRevokeConfirm": "\u64A4\u9500\u540E\u8BE5\u8BBE\u5907\u7ACB\u5373\u5931\u6548\uFF0C\u9700\u91CD\u65B0\u6CE8\u518C\u901A\u884C\u5BC6\u94A5\u3002",
  "passkeyRevokeDone": "\u2705 \u8BBE\u5907\u5DF2\u64A4\u9500\uFF0C\u8BE5\u8BBE\u5907\u9700\u91CD\u65B0\u6CE8\u518C",
  "passkeyRenamed": "\u2705 \u5DF2\u91CD\u547D\u540D",
  "passkeyLoadFailed": "\u274C \u8BBE\u5907\u5217\u8868\u8BFB\u53D6\u5931\u8D25\uFF1A{err}",
  "passkeyNever": "\u4ECE\u672A",
  "passkeyUnnamed": "\u672A\u547D\u540D\u8BBE\u5907",
  "passkeyEnabledDone": "\u2705 \u901A\u884C\u5BC6\u94A5\u5DF2\u542F\u7528",
  "passkeyDisabledDone": "\u2705 \u901A\u884C\u5BC6\u94A5\u5DF2\u5173\u95ED\uFF08\u5DF2\u6CE8\u518C\u8BBE\u5907\u4ECD\u4FDD\u7559\uFF0C\u53EF\u968F\u65F6\u91CD\u65B0\u5F00\u542F\uFF09",
  // ── 通用 ──
  "copy": "\u590D\u5236",
  "copied": "\u2705 \u5DF2\u590D\u5236",
  "copyFailed": "\u274C \u590D\u5236\u5931\u8D25\uFF0C\u8BF7\u624B\u52A8\u9009\u62E9\u5730\u5740",
  "hostUnsupported": "\u5F53\u524D dsh-pocket \u7248\u672C\u672A\u8FD4\u56DE\u8FD9\u9879\u72B6\u6001\uFF0C\u5347\u7EA7\u5E76\u91CD\u542F\u540E\u53EF\u7528",
  "feedback": "\u6709\u95EE\u9898\uFF1F\u6B22\u8FCE\u5230 GitHub Issues \u53CD\u9988 \u{1F64F}"
};
var en = {
  "section": "Phone access",
  "title": "\u{1F4F1} Phone access",
  "subtitle": "The phone shows this exact screen, live",
  "developer": "Developer: \u5C11\u5317\u6668 (shaobeichen)",
  "starAsk": "\u2B50 Drop a Star if it helped \u2014 it makes the author\u2019s day",
  "starCta": "\u2605 Give a Star",
  "restarted": "\u{1F504} Restarted",
  "ok": "Got it",
  "bgHint": "Running in the background (not attached to a terminal). To stop: {cmd}",
  "updatedRestart": "\u2705 Updated to v{ver} \u2014 restart to apply",
  "updateAutoRestarting": "\u2705 Updated to v{ver} \u2014 auto-restarting\u2026",
  "updatedOk": "\u2705 Updated to v{ver}",
  "updateAvailable": "\u{1F4E6} Update available: v{ver}",
  "updating": "Updating\u2026",
  "updateTo": "Update to v{ver}",
  "restartingNow": "Restarting to apply\u2026",
  "restarting": "Restarting\u2026",
  "restartNow": "\u{1F504} Restart dsh web now",
  "updatingDetail": "\u23F3 Updating (usually 1-2 min) \xB7 {s}s elapsed",
  "restartingDetail": "\u23F3 Restarting to apply (usually 10-30s) \xB7 {s}s elapsed",
  "updatedAutoDetail": "\u2705 Updated \u2014 auto-restarting in progress, refresh shortly",
  "updatedRestartDetail": "\u2705 Updated \u2014 restart dsh web to apply",
  "updateFailed": "\u274C Failed: {err} (manual update: dsh plugin --profile web update dsh-pocket --latest -w)",
  "versionRange": "Current v{cur} \u2192 latest v{latest}",
  "wanAccess": "Public access",
  "pinLabel": "Access PIN",
  "modeLabel": "Address mode",
  "advAddress": "Advanced \xB7 Pick address",
  "wanOffHint": "Reachable from any network once enabled (a disclaimer is confirmed on each enable)",
  "resetFactory": "\u{1F9F9} Factory reset",
  "resetGo": "Reset",
  "resetIntro": "Temporary fallback when settings break: clear local config and re-roll random PINs (DSH sessions, models and plugin config are untouched)",
  "resetTitle": "\u26A0\uFE0F Confirm factory reset?",
  "resetBody": "This clears and restores defaults:\n\u2460 Switches: LAN access on, access PIN on, LAN address auto\n\u2461 Public: mode back to random URL, Tunnel Token and fixed domain cleared, and any running tunnel is stopped\n\u2462 PINs: both public and LAN become new random 8-character PINs (old ones stop working; the phone must re-enter)\n\nYour DSH sessions, models and plugin config are untouched. This cannot be undone.",
  "resetConfirm": "Reset",
  "resetDone": "\u2705 Factory reset done: settings cleared and PINs re-rolled (re-enter the PIN on your phone)",
  "resetFailed": "\u274C Reset failed \u2014 please retry",
  "lanTitle": "\u{1F4F6} LAN (same Wi-Fi)",
  "lanHint": "Scan to open once your phone is on the same Wi-Fi",
  "lanAccess": "LAN access",
  "lanDisabledHint": '\u{1F512} LAN access is off \u2014 the QR code and link are unavailable (public access is unaffected). Tap "On" to restore.',
  "lanToggleTitleOff": "Turn off LAN access",
  "lanToggleBodyOff": "Once off, phones on the same Wi-Fi can no longer scan to connect (the LAN QR code and link stop working immediately). Public access is unaffected. Turn it off?",
  "lanToggleTitleOn": "Turn on LAN access",
  "lanToggleBodyOn": "Once on, phones on the same Wi-Fi can scan to connect (a LAN PIN is required by default). Turn it on?",
  "confirm": "Confirm",
  "lanAddress": "LAN address",
  "lanAddressAuto": "Auto (recommended)",
  "lanPin": "LAN access PIN",
  "on": "On",
  "off": "Off",
  "lanPinValue": "\u{1F510} PIN: {pin} (required on the phone; separate from the public PIN)",
  "lanPinCustomValue": "\u{1F510} PIN: {pin} (custom; required on the phone)",
  "refresh": "Refresh",
  "customize": "Customize",
  "customizing": "New PIN (8\u201364 chars, letters/digits): ",
  "save": "Save",
  "cancel": "Cancel",
  "pinInvalid": "PIN must be 8\u201364 characters (letters and digits only)",
  "pinCustomHint": "custom PINs are not rotated on tunnel start",
  "lanPinOff": "\u{1F513} PIN off \u2014 scan & go, no PIN (LAN devices only; public still requires PIN)",
  "lanStarting": "Proxy starting\u2026",
  "wanTitle": "\u{1F310} Anywhere (public)",
  "wanHint": "Scan from any network (the URL changes on every restart)",
  "wanPin": "\u{1F510} PIN: {pin} (changes each time the tunnel is enabled; required on the phone)",
  "wanPinCustom": "\u{1F510} PIN: {pin} (custom \u2014 not rotated on tunnel start)",
  "wanEphemeralWarn": '\u26A0\uFE0F The public link is valid only for this session: it stops working after you close or restart, and may be reused by someone else for an unrelated site. Do not bookmark it \u2014 scan the CURRENT QR code from this page each time. For a permanent address use "Fixed domain" below.',
  "stopTunnel": "Stop",
  "enable": "Enable anywhere",
  "opening": "Enabling\u2026",
  "startChannel": "Enable public access ({channel})",
  "channelQuick": "Cloudflare Quick Tunnel",
  "channelNamed": "Cloudflare Fixed Domain",
  "channelSsh": "SSH Reverse Tunnel",
  "modePendingHint": "\u201C{channel}\u201D is not saved yet \u2014 starting will save and launch it",
  "tunnelMode": "Mode:",
  "modeQuick": "Random URL (default)",
  "modeNamed": "Fixed domain",
  "namedSummary": "Fixed domain: {host} \xB7 Token {token}",
  "namedTokenSet": "configured",
  "namedTokenMissing": "not set",
  "namedEdit": "Edit",
  "namedHostnameLabel": "Fixed domain:",
  "namedTokenLabel": "Tunnel Token (blank = keep current):",
  "namedHow": "Create a tunnel in Cloudflare Zero Trust \u2192 Networks \u2192 Tunnels and copy the token; point the hostname's Service at http://127.0.0.1:3081 (the proxy port). The URL stays fixed across restarts.",
  "namedSecurity": "A fixed domain is long-lived and easier to scan \u2014 set a strong custom PIN too (the public PIN is not rotated on restart in this mode).",
  "namedNeedCfg": "Set the fixed domain and Tunnel Token first",
  "namedRunningHint": "Fixed domain (Cloudflare named tunnel) \u2014 the URL no longer changes on restart",
  "namedTakeEffect": "Fixed-domain config saved \u2014 turn public access off and on again to take effect",
  "disclaimerTitle": "\u26A0\uFE0F Security disclaimer",
  "disclaimerBody": "Enabling public access exposes this computer\u2019s DSH (which can execute code) to the internet. Anyone with the public link and PIN can reach \u2014 and operate \u2014 your computer. Please confirm: \u2460 use a strong custom PIN or keep the auto-generated one safe; \u2461 turn public access OFF as soon as you\u2019re done; \u2462 on a corporate/classified network, confirm compliance first.",
  "disclaimerAgree": "I understand and agree",
  "disclaimerHint": 'Check "I understand" before enabling public access',
  "downloading": "\u23F3 Downloading cloudflared (first run ~20-50MB, usually 1-2 min; instant afterward) \xB7 {s}s elapsed",
  "connecting": "\u23F3 Connecting to Cloudflare edge (usually 5-30s) \xB7 {s}s elapsed{suffix}",
  "slowHint": " \u2014 taking long? Check for a proxy/VPN (e.g., Clash TUN)",
  "error": "\u274C Failed to enable: {detail} (you can retry; for proxy/VPN issues see the README)",
  "unknownError": "unknown error",
  // ── Third channel: SSH (task-6) ──
  "modeSsh": "SSH",
  "sshTitle": "\u{1F517} SSH reverse tunnel (your own server)",
  "sshHint": "Forwards this computer\u2019s DSH through your own server; the server must allow remote forwarding (sshd AllowTcpForwarding yes).",
  "sshHost": "SSH host",
  "sshPort": "SSH port",
  "sshUser": "Username",
  "sshKeyPath": "Private key path (optional)",
  "sshKeyPathHint": "Blank = use the default ssh config (~/.ssh/config or the agent); only the path is passed, key contents are never read",
  "sshKeyPathSet": "set (blank on save = back to default)",
  "sshRemoteBindPort": "Remote forward port",
  "sshRemoteBindPortHint": "Port listened on the server; point the public hostname\u2019s reverse proxy at it",
  "sshAccessProtocol": "Access protocol",
  "sshAccessHost": "Public hostname (optional)",
  "sshAccessHostHint": "Blank = use the SSH hostname",
  "sshAccessPort": "Public port (0 = default)",
  "sshAutoRestore": "Auto-restore after a DSH restart",
  "sshAutoRestoreHint": "The address stays the same across restarts; when off you must start the tunnel manually each time",
  "sshNeedCfg": "Fill in the SSH host and username first",
  "sshStartHint": "Start/stop the tunnel with the \u201CEnable public access\u201D button above (the three channels are mutually exclusive)",
  "sshTest": "Test connection",
  "sshTesting": "Testing\u2026",
  "sshTestOk": "\u2705 Connection OK",
  "sshTestFail": "\u274C Connection failed: {err}",
  "sshTestUnavailable": "Connection test unavailable (needs a newer dsh-pocket)",
  "sshSaved": "\u2705 SSH config saved; restart the tunnel to apply",
  "sshStateIdle": "\u23F8 Not running",
  "sshStateStarting": "\u23F3 Connecting to the SSH server\u2026",
  "sshStateConnected": "\u2705 Tunnel connected",
  "sshStateReconnecting": "\u23F3 Disconnected \u2014 reconnecting automatically\u2026",
  "sshStateFailed": "\u274C Failed \u2014 no further automatic retry",
  "sshStateStopped": "\u23F8 Stopped",
  "sshLastError": "Last error: {err}",
  "sshUrlHint": "Reachable once the tunnel is up",
  "sshRunningHint": "SSH reverse tunnel is up; the address is fixed",
  // ── Notifications & PWA (task-6) ──
  "notifyTitle": "\u{1F514} Notifications & PWA",
  "notifyPush": "Web Push",
  "notifyPushHint": "Pushes to subscribed devices when a task finishes; delivery depends on the browser vendor\u2019s push service and may be delayed or blocked by battery savers",
  "notifySubsCount": "Subscribed devices: {n}",
  "notifySubscribe": "Subscribe this device",
  "notifyUnsubscribe": "Unsubscribe this device",
  "notifySubscribed": "\u2705 This device is subscribed; you will be notified when a task finishes",
  "notifyUnsubscribed": "\u2705 This device is unsubscribed",
  "notifySubscribeFailed": "\u274C Subscribe failed: {err}",
  "notifyUnsubscribeFailed": "\u274C Unsubscribe failed: {err}",
  "notifyPushUnsupported": "This browser has no Web Push: on iOS install to the home screen and open it from there; on desktop use Chrome/Edge/Firefox",
  "notifyPushInsecure": "Not a secure context (http on a non-localhost host): browsers expose no Service Worker or push subscription here. Use an HTTPS domain (your VPS/Caddy or a Cloudflare fixed domain), or open http://127.0.0.1:port on this machine.",
  "notifyTest": "Send a test notification",
  "notifyTesting": "Sending\u2026",
  "notifyTestSent": "\u2705 Test notification sent (if it did not arrive, see \u201CLast push\u201D below)",
  "notifyTestFailed": "\u274C Send failed: {err}",
  "notifyLastResult": "Last push: {text}",
  "notifyRecentTitle": "Recent pushes (up to 5):",
  "notifyDiagnose": "Network self-check",
  "notifyDiagnoseBtn": "Run self-check",
  "notifyDiagnosing": "Checking\u2026",
  "notifyDiagnoseNoProxy": "not set",
  "notifyDiagnoseEnv": "Host process: Node {node} \xB7 proxy {proxy} \xB7 NODE_USE_ENV_PROXY {useEnvProxy}",
  "notifyHostFcm": "Google FCM (usually unreachable in mainland China)",
  "notifyHostMozilla": "Mozilla (Firefox)",
  "notifyHostApple": "Apple (Safari/iOS)",
  "notifyResultOk": "ok",
  "notifyResultFail": "failed: {err}",
  "notifyResultPush": "Web Push",
  "notifyResultWebhook": "Webhook",
  "notifyNoResult": "No push yet",
  "notifyClear": "Clear all subscriptions",
  "notifyClearConfirm": "After clearing, every device must subscribe again (stale subscriptions are removed too).",
  "notifyCleared": "\u2705 All subscriptions cleared",
  "notifyClearFailed": "\u274C Clear failed: {err}",
  "notifyWebhook": "Webhook",
  "notifyWebhookHint": "POSTs to your own bot or service when a task finishes; the secret stays on this computer and is never echoed back",
  "notifyPreset": "Preset",
  "notifyPresetGeneric": "Generic JSON",
  "notifyPresetWecom": "WeCom bot",
  "notifyPresetDingtalk": "DingTalk bot",
  "notifyPresetFeishu": "Feishu bot",
  "notifyPresetNtfy": "ntfy",
  "notifyPresetBark": "Bark",
  "notifyUrl": "Webhook URL",
  "notifySecret": "Secret (optional)",
  "notifySecretHint": "Write-only; blank on save keeps the current secret",
  "notifySecretSet": "set",
  "notifyOnTaskDone": "Push when a task finishes",
  "notifyMinInterval": "Minimum push interval (s)",
  "notifyMinIntervalHint": "At most one push per session within this interval",
  "notifyMinIntervalPlaceholder": "10",
  "notifySaved": "\u2705 Notification settings saved",
  "pwaRow": "Install to home screen (PWA)",
  "pwaInstall": "Install to home screen",
  "pwaInstallTriggered": "Install requested \u2014 confirm in the browser prompt",
  "pwaInstallDismissed": "Install cancelled",
  "pwaInstallUnavailable": "Not installable now (needs HTTPS and a PWA-capable browser)",
  "pwaStandalone": "Already running from the home screen",
  "pwaNeedHttps": "Not HTTPS: browsers will not install to the home screen (open this page over https)",
  "pwaUnsupported": "This browser cannot install to the home screen (use Chrome/Edge/Safari)",
  "pwaNotReady": "Not installable yet: the browser has not offered the install prompt (needs HTTPS and a registered service worker; it can take a moment)",
  // ── Passkey devices (task-6) ──
  "passkeyTitle": "\u{1F510} Passkey devices",
  "passkeyHint": "When on, the login page accepts passkeys and remembered devices (no PIN needed on every visit)",
  "passkeyRpId": "Current domain (rpId)",
  "passkeyDeviceCount": "Registered devices: {n}",
  "passkeyUnsupported": "This browser has no WebAuthn support, so passkeys cannot be registered; use a recent Chrome/Edge/Safari",
  "passkeyInsecure": "This is not a secure context: browsers only allow passkey registration on HTTPS pages (unusable over plain-http LAN)",
  "passkeySecureHint": "Registration asks for fingerprint/face/system PIN; registered devices can be revoked from any signed-in settings page",
  "passkeyDevices": "Devices",
  "passkeyRegister": "Passkey on this device",
  "passkeyRegisterBtn": "Register on this device",
  "passkeyRegistering": "Registering\u2026 (complete the prompt in your browser)",
  "passkeyRegistered": "Passkey registered on this device \u2014 use it to sign in next time",
  "passkeyRegisterUnavailable": "The host did not inject the passkey API (needs HTTPS on a fixed domain)",
  "passkeyThisDevice": "This browser",
  "passkeyNoDevices": "No registered devices yet",
  "passkeyColCreated": "Registered",
  "passkeyColLastLogin": "Last sign-in",
  "passkeyRename": "Rename",
  "passkeyRevoke": "Revoke",
  "passkeyRevokeConfirm": "Revoking stops that device immediately; it must register a new passkey.",
  "passkeyRevokeDone": "\u2705 Device revoked \u2014 it must register again",
  "passkeyRenamed": "\u2705 Renamed",
  "passkeyLoadFailed": "\u274C Could not load devices: {err}",
  "passkeyNever": "never",
  "passkeyUnnamed": "Unnamed device",
  "passkeyEnabledDone": "\u2705 Passkeys enabled",
  "passkeyDisabledDone": "\u2705 Passkeys disabled (registered devices are kept; you can re-enable anytime)",
  // ── Shared ──
  "copy": "Copy",
  "copied": "\u2705 Copied",
  "copyFailed": "\u274C Copy failed \u2014 select the address manually",
  "hostUnsupported": "This dsh-pocket version does not report this status \u2014 update and restart to enable it",
  "feedback": "\u{1F64F} Questions? Open an issue on GitHub"
};

// client/index.jsx
var name = "dsh-pocket";
var inject = ["slots", "connection", "layout", "locale", "sessionLogDownload"];
function fmt(t, key, vars) {
  let s = t(key);
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = String(s).split(`{${k}}`).join(String(v));
    }
  }
  return s;
}
var styles = {
  card: { background: "var(--dsw-alias-bg-layer-1,#fff)", border: "1px solid var(--dsw-alias-border-l2,#e5e7eb)", borderRadius: 12, padding: "16px 20px", maxWidth: 480 },
  block: { borderTop: "1px solid var(--dsw-alias-border-l2,#e5e7eb)", marginTop: 16, paddingTop: 16 },
  muted: { color: "var(--dsw-alias-label-tertiary,#8b93a1)", fontSize: 12, lineHeight: 1.5 },
  code: { fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12, wordBreak: "break-all", margin: "6px 0 10px", color: "var(--dsw-alias-label-primary,inherit)" },
  // 主按钮：官方 md 胶囊形（36px）
  primary: { font: "inherit", cursor: "pointer", border: "none", background: "var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary,#4f6ef7))", color: "var(--dsw-alias-label-primary-foreground, #fff)", height: 36, padding: "0 16px", borderRadius: 999, fontSize: 13, fontWeight: 500, display: "inline-flex", alignItems: "center", justifyContent: "center" },
  // 次级按钮：官方 outline/ghost 胶囊形
  btn: { font: "inherit", cursor: "pointer", border: "1px solid var(--dsw-alias-button-ghost-active-border, var(--dsw-alias-border-l2,#d1d5db))", background: "var(--dsw-alias-bg-layer-1,#fff)", color: "var(--dsw-alias-label-primary,inherit)", height: 36, padding: "0 16px", borderRadius: 999, fontSize: 13, display: "inline-flex", alignItems: "center", justifyContent: "center" },
  qr: { width: 220, height: 220, borderRadius: 10, border: "1px solid var(--dsw-alias-border-l2,#e5e7eb)", margin: "8px 0" },
  warn: { color: "var(--dsw-alias-state-warn-primary,#b45309)", fontSize: 12, lineHeight: 1.5 },
  // 表单输入：窄屏单列，宽度收在卡片内不溢出（box-sizing 必须有，否则 padding 撑破 320px）
  input: {
    boxSizing: "border-box",
    width: "100%",
    maxWidth: 260,
    padding: "6px 8px",
    fontSize: 13,
    font: "inherit",
    border: "1px solid var(--dsw-alias-border-l2,#d1d5db)",
    borderRadius: 6,
    outline: "none",
    background: "var(--dsw-alias-bg-layer-1,#fff)",
    color: "var(--dsw-alias-label-primary,inherit)"
  },
  select: {
    boxSizing: "border-box",
    width: "100%",
    maxWidth: 260,
    height: 30,
    padding: "0 8px",
    fontSize: 13,
    font: "inherit",
    border: "1px solid var(--dsw-alias-border-l2,#d1d5db)",
    borderRadius: 6,
    background: "var(--dsw-alias-bg-layer-1,#fff)",
    color: "var(--dsw-alias-label-primary,inherit)"
  },
  // 小按钮（行内操作：复制/测试/重命名…）：与现有 26px 高度一致
  miniBtn: { font: "inherit", cursor: "pointer", border: "1px solid var(--dsw-alias-button-ghost-active-border, var(--dsw-alias-border-l2,#d1d5db))", background: "var(--dsw-alias-bg-layer-1,#fff)", color: "var(--dsw-alias-label-primary,inherit)", height: 26, padding: "0 10px", borderRadius: 999, fontSize: 12, display: "inline-flex", alignItems: "center", justifyContent: "center" },
  smallBtn: { font: "inherit", cursor: "pointer", border: "1px solid var(--dsw-alias-button-ghost-active-border, var(--dsw-alias-border-l2,#d1d5db))", background: "var(--dsw-alias-bg-layer-1,#fff)", color: "var(--dsw-alias-label-primary,inherit)", height: 28, padding: "0 12px", borderRadius: 999, fontSize: 12, display: "inline-flex", alignItems: "center", justifyContent: "center" },
  btnRow: { display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end", minWidth: 0 }
};
var SSH_STATE_TEXT = {
  idle: "sshStateIdle",
  starting: "sshStateStarting",
  connected: "sshStateConnected",
  reconnecting: "sshStateReconnecting",
  failed: "sshStateFailed",
  stopped: "sshStateStopped"
};
var NOTIFY_PRESETS2 = [
  ["generic", "notifyPresetGeneric"],
  ["wecom", "notifyPresetWecom"],
  ["dingtalk", "notifyPresetDingtalk"],
  ["feishu", "notifyPresetFeishu"],
  ["ntfy", "notifyPresetNtfy"],
  ["bark", "notifyPresetBark"]
];
function intField(value, fallback) {
  const n = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}
function fmtTime(ts, fallback) {
  const n = typeof ts === "number" ? ts : Number(ts);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  try {
    return new Date(n).toLocaleString();
  } catch {
    return fallback;
  }
}
function detectWebAuthn() {
  try {
    if (typeof window === "undefined") return { supported: false, secure: false };
    return {
      supported: typeof window.PublicKeyCredential === "function",
      secure: window.isSecureContext === true
    };
  } catch {
    return { supported: false, secure: false };
  }
}
function PocketSettingsTab({ rpcCall, t }) {
  const [status, setStatus] = (0, import_react.useState)(null);
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [error, setError] = (0, import_react.useState)(null);
  const [tunnelState, setTunnelState] = (0, import_react.useState)(null);
  const [restartNotice, setRestartNotice] = (0, import_react.useState)(false);
  const [updateInfo, setUpdateInfo] = (0, import_react.useState)(null);
  const [isDesktop, setIsDesktop] = (0, import_react.useState)(false);
  const [now, setNow] = (0, import_react.useState)(Date.now());
  (0, import_react.useEffect)(() => {
    const t2 = setInterval(() => setNow(Date.now()), 1e3);
    return () => clearInterval(t2);
  }, []);
  const elapsed = (startedAt) => startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1e3)) : 0;
  const call = async (endpoint, payload) => {
    const res = await rpcCall(endpoint, payload);
    if (!res?.ok) throw new Error(res?.error?.message ?? "RPC failed");
    return res.value;
  };
  const load = async () => {
    try {
      const s = await call(POCKET_ENDPOINTS.status, {});
      setStatus(s);
      setTunnelState(s.tunnelState ?? null);
      refreshBrowserCapabilities();
      if (s.desktop) setIsDesktop(true);
      if (s.restartNotice) {
        setRestartNotice(true);
        setUpdateInfo(null);
        if (!sessionStorage.getItem("dshp-auto-reloaded")) {
          sessionStorage.setItem("dshp-auto-reloaded", "1");
          setTimeout(() => {
            try {
              location.reload();
            } catch {
            }
          }, 2e3);
        }
      }
    } catch {
    }
  };
  (0, import_react.useEffect)(() => {
    load();
    const t2 = setInterval(load, 3e3);
    return () => clearInterval(t2);
  }, []);
  (0, import_react.useEffect)(() => {
    try {
      sessionStorage.removeItem("dshp-auto-reloaded");
    } catch {
    }
  }, []);
  (0, import_react.useEffect)(() => {
    if (isDesktop) return;
    let alive = true;
    const check = async () => {
      try {
        const v = await call(POCKET_ENDPOINTS.version, {});
        const meta = await (await fetch("https://registry.npmjs.org/dsh-pocket/latest", { cache: "no-store" })).json();
        if (!alive) return;
        const latest = typeof meta?.version === "string" ? meta.version : null;
        if (latest && v.current && compareVersions(latest, v.current) > 0) {
          setUpdateInfo({ current: v.current, latest, updating: false, result: null });
        } else if (v.current && v.loaded && compareVersions(v.current, v.loaded) > 0) {
          setUpdateInfo({ current: v.current, latest: v.current, updating: false, result: "ok", updated: true });
        }
      } catch {
      }
    };
    check();
    const t2 = setInterval(check, 5 * 60 * 1e3);
    return () => {
      alive = false;
      clearInterval(t2);
    };
  }, [isDesktop]);
  const restartPocket = async () => {
    setUpdateInfo((u) => ({ ...u, restarting: true, startedAt: Date.now() }));
    try {
      await Promise.race([
        call(POCKET_ENDPOINTS.restart, {}),
        new Promise((_, rej) => setTimeout(() => rej(new Error("restart requested (no reply within 3s)")), 3e3))
      ]);
      setUpdateInfo((u) => ({ ...u, restarting: true, result: "ok" }));
    } catch (err) {
      const msg = String(err?.message ?? "");
      if (/connection|socket|fetch|network|abort|cancelled|ECONN|disconnect|closed|timeout/i.test(msg)) {
        setUpdateInfo((u) => ({ ...u, restarting: true, result: "ok" }));
        return;
      }
      setUpdateInfo((u) => ({ ...u, restarting: false, result: "fail", output: err.message }));
    }
  };
  const runUpdate = async () => {
    setUpdateInfo((u) => ({ ...u, updating: true, result: null, startedAt: Date.now() }));
    try {
      const r = await call(POCKET_ENDPOINTS.update, {});
      setUpdateInfo((u) => ({
        ...u,
        updating: false,
        result: r.ok ? "ok" : "fail",
        autoRestart: r.autoRestart === true,
        output: r.output ?? r.error
      }));
    } catch (err) {
      setUpdateInfo((u) => ({ ...u, updating: false, result: "fail", output: err.message }));
    }
  };
  const [disclaimerOpen, setDisclaimerOpen] = (0, import_react.useState)(false);
  const [disclaimerChecked, setDisclaimerChecked] = (0, import_react.useState)(false);
  const doStartTunnel = async () => {
    const target = pendingMode ?? publicMode;
    if (target === "ssh") {
      const editing = pendingMode === "ssh" && sshCfg !== null;
      const src = editing ? sshForm : { host: sshConfigView.host ?? "", user: sshConfigView.user ?? "" };
      if (!String(src.host ?? "").trim() || !String(src.user ?? "").trim()) {
        setError(t("sshNeedCfg"));
        return;
      }
      if (editing && !await saveSshConfig()) return;
    } else if (target === "named") {
      const editing = pendingMode === "named" && tunnelCfg !== null;
      const hostname = editing ? String(tunnelCfg?.hostname ?? "").trim() : String(tunnelModeView.hostname ?? "").trim();
      const tokenReady = editing ? !!(tunnelCfg?.token || tunnelModeView.tokenSet) : !!tunnelModeView.tokenSet;
      if (!hostname || !tokenReady) {
        setError(t("namedNeedCfg"));
        return;
      }
      if (editing && !await saveNamedTunnel()) return;
    }
    setBusy(true);
    setError(null);
    setTunnelState({ phase: "starting", detail: "\u6B63\u5728\u5F00\u542F\u2026", startedAt: Date.now() });
    try {
      setStatus(await call(POCKET_ENDPOINTS.tunnelStart, { disclaimer: true }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const startTunnel = () => {
    setDisclaimerChecked(false);
    setDisclaimerOpen(true);
  };
  const confirmDisclaimer = () => {
    if (!disclaimerChecked) return;
    setDisclaimerOpen(false);
    doStartTunnel();
  };
  const stopTunnel = async () => {
    try {
      setStatus(await call(POCKET_ENDPOINTS.tunnelStop, {}));
    } catch {
    }
  };
  const [tunnelCfg, setTunnelCfg] = (0, import_react.useState)(null);
  const [pendingMode, setPendingMode] = (0, import_react.useState)(null);
  const switchToQuick = async () => {
    try {
      setStatus(await call(POCKET_ENDPOINTS.tunnelSetConfig, { mode: "quick" }));
    } catch (err) {
      setError(err.message);
    }
  };
  const saveNamedTunnel = async () => {
    try {
      setStatus(await call(POCKET_ENDPOINTS.tunnelSetConfig, {
        mode: "named",
        hostname: tunnelCfg?.hostname ?? "",
        token: tunnelCfg?.token || void 0
        // 留空不覆盖已存 Token
      }));
      setTunnelCfg(null);
      setPendingMode(null);
      return true;
    } catch (err) {
      setTunnelCfg((c) => ({ ...c, err: err.message }));
      return false;
    }
  };
  const [resetOpen, setResetOpen] = (0, import_react.useState)(false);
  const doFactoryReset = async () => {
    setResetOpen(false);
    setBusy(true);
    setError(null);
    try {
      const next = await call(POCKET_ENDPOINTS.pocketReset, { confirm: true });
      setStatus(next);
      setTunnelCfg(null);
      setCustomPin(null);
      setAdvOpen(false);
      showToast(t("resetDone"));
    } catch (err) {
      setError(err.message);
      showToast(t("resetFailed"));
    } finally {
      setBusy(false);
    }
  };
  const refreshLanPin = async () => {
    try {
      const r = await call(POCKET_ENDPOINTS.lanTokenRefresh, {});
      setStatus((s) => ({ ...s, lanToken: r.lanToken }));
    } catch {
    }
  };
  const setLanAuth = async (on) => {
    try {
      const r = await call(POCKET_ENDPOINTS.lanAuthSetEnabled, { on });
      setStatus((s) => ({ ...s, lanAuthEnabled: r.lanAuthEnabled }));
    } catch {
    }
  };
  const [lanToggleOpen, setLanToggleOpen] = (0, import_react.useState)(null);
  const requestLanToggle = (on) => setLanToggleOpen(on);
  const confirmLanToggle = async () => {
    const on = lanToggleOpen;
    setLanToggleOpen(null);
    if (on === null) return;
    try {
      const r = await call(POCKET_ENDPOINTS.lanSetEnabled, { on });
      setStatus((s) => ({ ...s, lanEnabled: r.lanEnabled }));
    } catch (err) {
      setError(err.message);
    }
  };
  const setLanAddress = async (ip) => {
    try {
      setStatus(await call(POCKET_ENDPOINTS.lanSetOverride, { ip }));
    } catch (err) {
      setError(err.message);
    }
  };
  const [customPin, setCustomPin] = (0, import_react.useState)(null);
  const saveCustomPin = async (which) => {
    try {
      const r = await call(POCKET_ENDPOINTS.pinSetCustom, { which, value: customPin?.value ?? "" });
      setStatus((s) => ({
        ...s,
        accessToken: which === "public" ? r.pin : s.accessToken,
        lanToken: which === "lan" ? r.pin : s.lanToken,
        publicPinCustom: which === "public" ? true : s.publicPinCustom,
        lanPinCustom: which === "lan" ? true : s.lanPinCustom
      }));
      setCustomPin(null);
    } catch (err) {
      setCustomPin((c) => ({ ...c, err: err.message }));
    }
  };
  const customPinRow = (which) => (0, import_react.createElement)(
    "div",
    { style: { marginTop: 6, fontSize: 12, color: "var(--dsw-alias-label-secondary,#6b7280)", lineHeight: 1.5 } },
    t("customizing"),
    (0, import_react.createElement)("input", {
      style: { width: 130, margin: "0 6px", padding: "4px 8px", fontSize: 14, letterSpacing: 1, textAlign: "center", border: "1px solid var(--dsw-alias-border-l2,#d1d5db)", borderRadius: 6, outline: "none" },
      type: "password",
      minLength: 8,
      maxLength: 64,
      value: customPin?.value ?? "",
      autoFocus: true,
      onChange: (e) => setCustomPin((c) => ({ ...c, value: e.target.value.replace(/[^a-zA-Z0-9]/g, ""), err: null })),
      onKeyDown: (e) => {
        if (e.key === "Enter") saveCustomPin(which);
        if (e.key === "Escape") setCustomPin(null);
      }
    }),
    (0, import_react.createElement)("button", { style: { ...styles.btn, height: 26, padding: "0 10px", fontSize: 12, marginLeft: 2 }, onClick: () => saveCustomPin(which) }, t("save")),
    (0, import_react.createElement)("button", { style: { ...styles.btn, height: 26, padding: "0 10px", fontSize: 12 }, onClick: () => setCustomPin(null) }, t("cancel")),
    customPin?.err ? (0, import_react.createElement)("div", { style: { color: "var(--dsw-alias-state-error-primary,#dc2626)", marginTop: 4 } }, errText(customPin.err)) : null
  );
  const customBtn = (which) => (0, import_react.createElement)("button", { style: { ...styles.btn, height: 26, padding: "0 10px", fontSize: 12, marginLeft: 8 }, onClick: () => setCustomPin({ which, value: "", err: null }) }, t("customize"));
  const lanUrl = status?.lanUrl;
  const tunnelUrl = status?.tunnelUrl;
  const tunnelPhase = tunnelState?.phase ?? "idle";
  const tunnelStarting = ["downloading", "starting", "registering"].includes(tunnelPhase);
  const tunnelStateDetail = tunnelState?.detail ?? "";
  const tunnelStateStarted = tunnelState?.startedAt ?? null;
  const tunnelModeView = status?.tunnelConfig ?? { mode: "quick", hostname: "", tokenSet: false };
  const namedMode = tunnelModeView.mode === "named";
  const namedActive = namedMode || tunnelCfg !== null;
  const errText = (msg) => {
    const s = msg == null ? "" : pocketErrorText(msg);
    const i = s.indexOf(" | ");
    if (i < 0) return s;
    return (t("ok") === zh.ok ? s.slice(0, i) : s.slice(i + 3)).trim();
  };
  const [toast, setToast] = (0, import_react.useState)(null);
  const toastTimer = (0, import_react.useRef)(null);
  const showToast = (text) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  };
  (0, import_react.useEffect)(() => () => clearTimeout(toastTimer.current), []);
  const modeBtnStyle = (active) => ({
    ...styles.btn,
    height: 28,
    padding: "0 12px",
    fontSize: 12,
    fontWeight: active ? 600 : 400,
    background: active ? "var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary,#4f6ef7))" : "var(--dsw-alias-bg-layer-1,#fff)",
    color: active ? "var(--dsw-alias-label-primary-foreground, #fff)" : "var(--dsw-alias-label-primary,inherit)"
  });
  const Switch = (on, onClick) => (0, import_react.createElement)("button", {
    role: "switch",
    "aria-checked": !!on,
    style: { flexShrink: 0, width: 40, height: 22, borderRadius: 11, border: "none", padding: 0, position: "relative", cursor: "pointer", font: "inherit", background: on ? "var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary,#4f6ef7))" : "var(--dsw-alias-border-l2,#d1d5db)" },
    onClick
  }, (0, import_react.createElement)("span", { style: { position: "absolute", top: 2, left: on ? 20 : 2, width: 18, height: 18, borderRadius: "50%", background: "#fff" } }));
  const qrArea = (src, url, hint) => (0, import_react.createElement)(
    "div",
    { style: { background: "var(--dsw-alias-bg-layer-2,#f3f4f6)", borderRadius: 10, padding: "10px 12px", textAlign: "center", margin: "10px 0" } },
    (0, import_react.createElement)("img", { src, alt: "QR", style: styles.qr }),
    (0, import_react.createElement)("div", { style: styles.code }, url),
    (0, import_react.createElement)("div", { style: styles.muted }, hint)
  );
  const row = (label, control, extra) => (0, import_react.createElement)(
    "div",
    { style: { borderTop: "1px solid var(--dsw-alias-border-l2,#e5e7eb)", paddingTop: 9, marginTop: 9 } },
    (0, import_react.createElement)(
      "div",
      { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 } },
      (0, import_react.createElement)("span", { style: { fontSize: 13 } }, label),
      control
    ),
    extra ?? null
  );
  const [advOpen, setAdvOpen] = (0, import_react.useState)(false);
  const [sshCfg, setSshCfg] = (0, import_react.useState)(null);
  const [sshTestResult, setSshTestResult] = (0, import_react.useState)(null);
  const [sshTesting, setSshTesting] = (0, import_react.useState)(false);
  const publicMode = tunnelModeView?.mode === "ssh" ? "ssh" : tunnelModeView?.mode === "named" ? "named" : "quick";
  const willStartMode = pendingMode ?? publicMode;
  const channelLabel = (m) => t(m === "ssh" ? "channelSsh" : m === "named" ? "channelNamed" : "channelQuick");
  const pendingModeHint = pendingMode && pendingMode !== publicMode ? fmt(t, "modePendingHint", { channel: channelLabel(pendingMode) }) : null;
  const sshView = status?.ssh ?? null;
  const sshRunning = sshView?.running === true;
  const sshMode = publicMode === "ssh";
  const sshState = typeof sshView?.state === "string" ? sshView.state : "idle";
  const sshStateKey = SSH_STATE_TEXT[sshState] ?? SSH_STATE_TEXT.idle;
  const sshEdit = sshCfg !== null;
  const sshActive = sshEdit || sshMode || sshRunning;
  const sshConfigView = sshView?.config ?? {};
  const sshAddress = sshView?.url ?? buildAccessUrl(sshConfigView);
  const sshForm = sshCfg ?? {
    host: sshConfigView.host ?? "",
    port: String(sshConfigView.port ?? 22),
    user: sshConfigView.user ?? "",
    keyPath: "",
    remoteBindPort: String(sshConfigView.remoteBindPort ?? 7788),
    accessProtocol: sshConfigView.accessProtocol === "http" ? "http" : "https",
    accessHost: sshConfigView.accessHost ?? "",
    accessPort: String(sshConfigView.accessPort ?? 0),
    autoRestore: sshConfigView.autoRestore !== false,
    err: null
  };
  const publicRunning = !!tunnelUrl || sshRunning;
  const patchSshForm = (patch) => setSshCfg((c) => ({ ...c ?? sshForm, ...patch, err: null }));
  const openSshEditor = () => {
    setTunnelCfg(null);
    setSshTestResult(null);
    setSshCfg({
      host: sshConfigView.host ?? "",
      port: String(sshConfigView.port ?? 22),
      user: sshConfigView.user ?? "",
      keyPath: "",
      remoteBindPort: String(sshConfigView.remoteBindPort ?? 7788),
      accessProtocol: sshConfigView.accessProtocol === "http" ? "http" : "https",
      accessHost: sshConfigView.accessHost ?? "",
      accessPort: String(sshConfigView.accessPort ?? 0),
      autoRestore: sshConfigView.autoRestore !== false,
      err: null
    });
  };
  const mergeStatus = (next) => {
    if (!next || typeof next !== "object" || Array.isArray(next)) return;
    setStatus((s) => ({ ...s ?? {}, ...next }));
  };
  const saveSshConfig = async () => {
    const f = sshForm;
    const host = String(f.host ?? "").trim();
    const user = String(f.user ?? "").trim();
    if (!host || !user) {
      setSshCfg((c) => ({ ...c ?? f, err: t("sshNeedCfg") }));
      return false;
    }
    try {
      const next = await call(POCKET_ENDPOINTS.sshSetConfig, {
        mode: "ssh",
        // 保存 SSH 配置即把公网入口切到 ssh（与 quick/named 互斥）
        host,
        user,
        port: intField(f.port, 22),
        keyPath: String(f.keyPath ?? "").trim(),
        // 空 = 用默认 ssh 配置
        remoteBindPort: intField(f.remoteBindPort, 7788),
        accessProtocol: f.accessProtocol === "http" ? "http" : "https",
        accessHost: String(f.accessHost ?? "").trim(),
        accessPort: intField(f.accessPort, 0),
        autoRestore: f.autoRestore !== false
      });
      mergeStatus(next);
      setSshCfg(null);
      setPendingMode(null);
      showToast(t("sshSaved"));
      return true;
    } catch (err) {
      setSshCfg((c) => ({ ...c ?? f, err: err.message }));
      return false;
    }
  };
  const testSshConnection = async () => {
    setSshTesting(true);
    setSshTestResult(null);
    try {
      const r = await call(POCKET_ENDPOINTS.sshStatus, { test: true });
      if (r && typeof r === "object") {
        if (r.ssh && typeof r.ssh === "object") mergeStatus({ ssh: r.ssh });
        else if ("running" in r || "state" in r) mergeStatus({ ssh: { ...status?.ssh ?? {}, ...r } });
      }
      const probe = r?.test && typeof r.test === "object" ? r.test : null;
      if (probe) setSshTestResult({ ok: probe.ok === true, message: probe.message ?? probe.error ?? null });
      else if (r?.running === true || r?.state === "connected") setSshTestResult({ ok: true, message: null });
      else if (typeof r?.state === "string") setSshTestResult({ ok: false, state: r.state, message: r.lastError ?? null });
      else setSshTestResult({ ok: false, unavailable: true, message: null });
    } catch (err) {
      setSshTestResult({ ok: false, message: err.message });
    } finally {
      setSshTesting(false);
    }
  };
  const selectQuick = () => {
    setTunnelCfg(null);
    setSshCfg(null);
    setPendingMode(null);
    if (publicMode !== "quick") switchToQuick();
  };
  const selectNamed = () => {
    setSshCfg(null);
    const open = tunnelCfg === null;
    setTunnelCfg(open ? { hostname: tunnelModeView.hostname ?? "", token: "", err: null } : null);
    setPendingMode(open ? "named" : null);
  };
  const selectSsh = () => {
    setTunnelCfg(null);
    const open = sshCfg === null;
    if (open) openSshEditor();
    setPendingMode(open && sshView !== null ? "ssh" : null);
  };
  const sshField = (label, node, hint) => (0, import_react.createElement)(
    "div",
    { style: { marginTop: 9, fontSize: 12, color: "var(--dsw-alias-label-secondary,#6b7280)", lineHeight: 1.5 } },
    (0, import_react.createElement)("div", { style: { marginBottom: 3 } }, label),
    node,
    hint ? (0, import_react.createElement)("div", { style: { ...styles.muted, marginTop: 2 } }, hint) : null
  );
  const sshInput = (value, onChange, extra) => (0, import_react.createElement)("input", {
    style: styles.input,
    value: value ?? "",
    autoComplete: "off",
    onChange: (e) => onChange(e.target.value),
    ...extra
  });
  const COLOR_OK = "var(--dsw-alias-state-success-primary,#15803d)";
  const COLOR_ERR = "var(--dsw-alias-state-error-primary,#dc2626)";
  const sshSection = !sshActive ? null : (0, import_react.createElement)(
    "div",
    { style: { marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--dsw-alias-border-l2,#e5e7eb)" } },
    (0, import_react.createElement)("span", { style: { fontWeight: 600, fontSize: 13 } }, t("sshTitle")),
    (0, import_react.createElement)("div", { style: { ...styles.muted, marginTop: 4 } }, t("sshHint")),
    // 运行状态与阶段
    (0, import_react.createElement)(
      "div",
      { style: { marginTop: 8, fontSize: 12, lineHeight: 1.5, wordBreak: "break-word", color: sshState === "connected" ? COLOR_OK : sshState === "failed" ? COLOR_ERR : "var(--dsw-alias-label-secondary,#6b7280)" } },
      t(sshStateKey)
    ),
    sshView?.lastError ? (0, import_react.createElement)("div", { style: { ...styles.warn, marginTop: 4, wordBreak: "break-word" } }, fmt(t, "sshLastError", { err: errText(sshView.lastError) })) : null,
    sshTestResult ? (0, import_react.createElement)(
      "div",
      { style: { marginTop: 4, fontSize: 12, lineHeight: 1.5, wordBreak: "break-word", color: sshTestResult.ok ? COLOR_OK : COLOR_ERR } },
      sshTestResult.ok ? t("sshTestOk") : sshTestResult.unavailable ? t("sshTestUnavailable") : sshTestResult.state ? t(SSH_STATE_TEXT[sshTestResult.state] ?? SSH_STATE_TEXT.idle) : fmt(t, "sshTestFail", { err: errText(sshTestResult.message) || t("unknownError") })
    ) : null,
    // 地址与二维码：运行且有二维码时优先展示，否则只显示地址 + 复制
    sshRunning && sshAddress && sshView?.qr ? qrArea(sshView.qr, sshAddress, t("sshRunningHint")) : sshAddress ? (0, import_react.createElement)(
      "div",
      { style: { marginTop: 8 } },
      (0, import_react.createElement)("div", { style: styles.code }, sshAddress),
      (0, import_react.createElement)("div", null, (0, import_react.createElement)("button", { style: styles.miniBtn, onClick: () => copyText(sshAddress) }, t("copy"))),
      (0, import_react.createElement)("div", { style: { ...styles.muted, marginTop: 4 } }, t("sshUrlHint"))
    ) : null,
    // 配置表单
    (0, import_react.createElement)(
      "div",
      null,
      !sshView ? (0, import_react.createElement)("div", { style: { ...styles.warn, marginTop: 8 } }, t("hostUnsupported")) : null,
      sshView || sshEdit ? (0, import_react.createElement)(
        "div",
        null,
        sshField(t("sshHost"), sshInput(sshForm.host, (v) => patchSshForm({ host: v.trim() }), { placeholder: "vps.example.com" })),
        sshField(t("sshPort"), sshInput(sshForm.port, (v) => patchSshForm({ port: v }), { inputMode: "numeric" })),
        sshField(t("sshUser"), sshInput(sshForm.user, (v) => patchSshForm({ user: v.trim() }), { placeholder: "dsh" })),
        sshField(
          t("sshKeyPath"),
          sshInput(sshForm.keyPath, (v) => patchSshForm({ keyPath: v.trim() }), { placeholder: "~/.ssh/id_ed25519" }),
          sshConfigView.keyPathSet ? t("sshKeyPathSet") : t("sshKeyPathHint")
        ),
        sshField(
          t("sshRemoteBindPort"),
          sshInput(sshForm.remoteBindPort, (v) => patchSshForm({ remoteBindPort: v }), { inputMode: "numeric" }),
          t("sshRemoteBindPortHint")
        ),
        sshField(
          t("sshAccessProtocol"),
          (0, import_react.createElement)(
            "select",
            { style: styles.select, value: sshForm.accessProtocol, onChange: (e) => patchSshForm({ accessProtocol: e.target.value }) },
            (0, import_react.createElement)("option", { value: "https" }, "https"),
            (0, import_react.createElement)("option", { value: "http" }, "http")
          )
        ),
        sshField(
          t("sshAccessHost"),
          sshInput(sshForm.accessHost, (v) => patchSshForm({ accessHost: v.trim() }), { placeholder: sshForm.host || "dsh.example.com" }),
          t("sshAccessHostHint")
        ),
        sshField(t("sshAccessPort"), sshInput(sshForm.accessPort, (v) => patchSshForm({ accessPort: v }), { inputMode: "numeric" })),
        sshField(
          t("sshAutoRestore"),
          Switch(sshForm.autoRestore !== false, () => patchSshForm({ autoRestore: sshForm.autoRestore === false })),
          t("sshAutoRestoreHint")
        )
      ) : null,
      sshForm.err ? (0, import_react.createElement)("div", { style: { color: COLOR_ERR, marginTop: 6, fontSize: 12, lineHeight: 1.5, wordBreak: "break-word" } }, errText(sshForm.err)) : null,
      // 操作：保存 / 测试连接。启动与停止统一走上方唯一的「开启公网访问（…）」按钮 ——
      // 同一动作不再出现两个文案不同、职责不清的入口（用户实测反馈）。
      (0, import_react.createElement)(
        "div",
        { style: { marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap" } },
        (0, import_react.createElement)("button", { style: styles.smallBtn, onClick: saveSshConfig }, t("save")),
        (0, import_react.createElement)("button", { style: styles.smallBtn, onClick: testSshConnection, disabled: sshTesting }, sshTesting ? t("sshTesting") : t("sshTest")),
        sshEdit ? (0, import_react.createElement)("button", { style: styles.smallBtn, onClick: () => {
          setSshCfg(null);
          if (!sshMode) setPendingMode(null);
        } }, t("cancel")) : null
      ),
      (0, import_react.createElement)("div", { style: { ...styles.muted, marginTop: 6 } }, t("sshStartHint"))
    )
  );
  const [notifyEdit, setNotifyEdit] = (0, import_react.useState)(null);
  const [notifyStatusData, setNotifyStatusData] = (0, import_react.useState)(null);
  const [notifyBusy, setNotifyBusy] = (0, import_react.useState)(false);
  const [pushApiReady, setPushApiReady] = (0, import_react.useState)(false);
  const [canInstall, setCanInstall] = (0, import_react.useState)(false);
  const [clearSubsAsk, setClearSubsAsk] = (0, import_react.useState)(false);
  const installEvRef = (0, import_react.useRef)(null);
  const notifyView = status?.notify ?? null;
  const notifyForm = notifyEdit ?? {
    preset: notifyView?.webhookPreset ?? "generic",
    url: notifyView?.webhookUrl ?? "",
    secret: "",
    minInterval: notifyView?.minIntervalSec == null ? "" : String(notifyView.minIntervalSec)
  };
  const patchNotifyForm = (patch) => setNotifyEdit((f) => ({ ...f ?? notifyForm, ...patch }));
  const pushApi = () => {
    try {
      return typeof window === "undefined" ? null : window.dshPocketPush ?? null;
    } catch {
      return null;
    }
  };
  const refreshBrowserCapabilities = () => {
    try {
      const api = pushApi();
      setPushApiReady(typeof api?.subscribe === "function");
      const ev = typeof api?.installPrompt === "function" ? api.installPrompt() : null;
      if (ev && !installEvRef.current) installEvRef.current = ev;
      setCanInstall(!!installEvRef.current);
    } catch {
    }
  };
  const loadNotifyStatus = async () => {
    if (!status?.notify) return;
    try {
      const r = await call(POCKET_ENDPOINTS.notifyStatus, {});
      if (!r || typeof r !== "object") return;
      setNotifyStatusData(r);
      const patch = r.notify && typeof r.notify === "object" ? r.notify : r;
      setStatus((s) => ({ ...s ?? {}, notify: { ...s?.notify ?? {}, ...patch } }));
    } catch {
    }
  };
  const setNotifyFlag = async (field, value) => {
    try {
      mergeStatus(await call(POCKET_ENDPOINTS.notifySetConfig, { [field]: value }));
    } catch (err) {
      setError(err.message);
    }
  };
  const saveNotifyConfig = async () => {
    if (!notifyView) {
      showToast(t("hostUnsupported"));
      return;
    }
    setNotifyBusy(true);
    try {
      const payload = {
        webhookPreset: notifyForm.preset,
        webhookUrl: String(notifyForm.url ?? "").trim()
      };
      const secret = String(notifyForm.secret ?? "").trim();
      if (secret) payload.webhookSecret = secret;
      const minRaw = String(notifyForm.minInterval ?? "").trim();
      if (minRaw !== "") payload.minIntervalSec = intField(minRaw, 10);
      mergeStatus(await call(POCKET_ENDPOINTS.notifySetConfig, payload));
      setNotifyEdit(null);
      showToast(t("notifySaved"));
      loadNotifyStatus();
    } catch (err) {
      setError(err.message);
    } finally {
      setNotifyBusy(false);
    }
  };
  const sendTestNotification = async () => {
    setNotifyBusy(true);
    try {
      const r = await call(POCKET_ENDPOINTS.notifyTest, {});
      const results = Array.isArray(r?.results) ? r.results : Array.isArray(r?.lastResults) ? r.lastResults : [];
      const failed = results.find((x) => x && x.ok === false);
      showToast(failed ? fmt(t, "notifyTestFailed", { err: errText(failed.error) || `${resultChannel(failed)} HTTP ${failed.status ?? "\u2014"}` }) : t("notifyTestSent"));
      loadNotifyStatus();
    } catch (err) {
      showToast(fmt(t, "notifyTestFailed", { err: errText(err) || t("unknownError") }));
    } finally {
      setNotifyBusy(false);
    }
  };
  const [diagnoseBusy, setDiagnoseBusy] = (0, import_react.useState)(false);
  const [diagnoseData, setDiagnoseData] = (0, import_react.useState)(null);
  const runDiagnose = async () => {
    setDiagnoseBusy(true);
    try {
      setDiagnoseData(await call(POCKET_ENDPOINTS.notifyDiagnose, {}));
    } catch (err) {
      setDiagnoseData({ error: err?.message ?? String(err) });
    } finally {
      setDiagnoseBusy(false);
    }
  };
  const safeNode = (render) => {
    try {
      return render();
    } catch (err) {
      return (0, import_react.createElement)("div", { style: { color: "var(--dsw-alias-state-error-primary,#dc2626)", fontSize: 12, wordBreak: "break-word" } }, `\u6E32\u67D3\u5931\u8D25\uFF1A${err?.message ?? err}`);
    }
  };
  const resultChannel = (r) => r?.channel === "webhook" ? t("notifyResultWebhook") : t("notifyResultPush");
  const resultHost = (r) => {
    const ep = typeof r?.endpoint === "string" ? r.endpoint : "";
    try {
      return ep ? new URL(ep).host : "";
    } catch {
      return "";
    }
  };
  const pushHostHint = (host) => {
    const h2 = String(host || "").toLowerCase();
    if (h2.includes("fcm.googleapis.com") || h2.includes("android.googleapis.com")) return t("notifyHostFcm");
    if (h2.includes("mozilla")) return t("notifyHostMozilla");
    if (h2.includes("apple")) return t("notifyHostApple");
    return host || "";
  };
  const resultText = (r) => [
    resultChannel(r),
    pushHostHint(resultHost(r)),
    r?.ok === true ? t("notifyResultOk") : fmt(t, "notifyResultFail", { err: errText(r?.error) || `HTTP ${r?.status ?? "\u2014"}` })
  ].filter(Boolean).join(" \xB7 ");
  const notifyResults = Array.isArray(notifyStatusData?.lastResults) ? notifyStatusData.lastResults : Array.isArray(notifyStatusData?.results) ? notifyStatusData.results : [];
  const notifyRecent = notifyResults.slice(-5).reverse();
  const pushUnavailableText = () => {
    if (typeof window !== "undefined" && window.isSecureContext === false) return t("notifyPushInsecure");
    return t("notifyPushUnsupported");
  };
  const subscribePush = async () => {
    const api = pushApi();
    if (typeof api?.subscribe !== "function") {
      showToast(pushUnavailableText());
      return;
    }
    setNotifyBusy(true);
    try {
      const r = await api.subscribe();
      if (r && r.ok === false) throw new Error(r.error?.message ?? r.error ?? "subscribe failed");
      showToast(t("notifySubscribed"));
      loadNotifyStatus();
    } catch (err) {
      showToast(fmt(t, "notifySubscribeFailed", { err: errText(err) || t("unknownError") }));
    } finally {
      setNotifyBusy(false);
    }
  };
  const unsubscribePush = async () => {
    const api = pushApi();
    if (typeof api?.unsubscribe !== "function") {
      showToast(pushUnavailableText());
      return;
    }
    setNotifyBusy(true);
    try {
      const r = await api.unsubscribe();
      if (r && r.ok === false) throw new Error(r.error?.message ?? r.error ?? "unsubscribe failed");
      showToast(t("notifyUnsubscribed"));
      loadNotifyStatus();
    } catch (err) {
      showToast(fmt(t, "notifyUnsubscribeFailed", { err: errText(err) || t("unknownError") }));
    } finally {
      setNotifyBusy(false);
    }
  };
  const clearSubscriptions = async () => {
    setClearSubsAsk(false);
    setNotifyBusy(true);
    try {
      mergeStatus(await call(POCKET_ENDPOINTS.notifyClearSubscriptions, {}));
      showToast(t("notifyCleared"));
      loadNotifyStatus();
    } catch (err) {
      showToast(fmt(t, "notifyClearFailed", { err: errText(err) || t("unknownError") }));
    } finally {
      setNotifyBusy(false);
    }
  };
  const promptInstall = async () => {
    try {
      const api = pushApi();
      const ev = installEvRef.current ?? (typeof api?.installPrompt === "function" ? api.installPrompt() : null);
      if (!ev) {
        showToast(t("pwaInstallUnavailable"));
        return;
      }
      if (typeof ev.prompt === "function") {
        await ev.prompt();
        const choice = await Promise.resolve(ev.userChoice ?? null).catch(() => null);
        showToast(choice?.outcome === "accepted" ? t("pwaInstallTriggered") : t("pwaInstallDismissed"));
        installEvRef.current = null;
        setCanInstall(false);
        return;
      }
      showToast(t("pwaInstallTriggered"));
    } catch (err) {
      showToast(fmt(t, "notifySubscribeFailed", { err: errText(err) || t("unknownError") }));
    }
  };
  const pwaReason = () => {
    try {
      if (typeof window === "undefined") return t("pwaUnsupported");
      if (window.isSecureContext !== true) return t("pwaNeedHttps");
      if (window.matchMedia?.("(display-mode: standalone)")?.matches === true || window.navigator?.standalone === true) return t("pwaStandalone");
      if (!("serviceWorker" in (window.navigator ?? {}))) return t("pwaUnsupported");
      return t("pwaNotReady");
    } catch {
      return t("pwaNotReady");
    }
  };
  const [devices, setDevices] = (0, import_react.useState)(null);
  const [devicesErr, setDevicesErr] = (0, import_react.useState)(null);
  const [renameId, setRenameId] = (0, import_react.useState)(null);
  const [renameVal, setRenameVal] = (0, import_react.useState)("");
  const [revokeId, setRevokeId] = (0, import_react.useState)(null);
  const [passkeyBusy, setPasskeyBusy] = (0, import_react.useState)(false);
  const [regBusy, setRegBusy] = (0, import_react.useState)(false);
  const [regMsg, setRegMsg] = (0, import_react.useState)(null);
  const passkeyView = status?.passkey ?? null;
  const webAuthn = detectWebAuthn();
  const registerThisDevice = async () => {
    const api = typeof window !== "undefined" ? window.dshPocketPasskey : null;
    if (typeof api?.register !== "function") {
      setRegMsg({ ok: false, text: t("passkeyRegisterUnavailable") });
      return;
    }
    setRegBusy(true);
    setRegMsg(null);
    try {
      const r = await api.register(t("passkeyThisDevice"));
      if (r?.ok) {
        setRegMsg({ ok: true, text: t("passkeyRegistered") });
        loadDevices();
      } else {
        setRegMsg({ ok: false, text: errText(r?.error?.message ?? r?.error) || t("unknownError") });
      }
    } catch (err) {
      setRegMsg({ ok: false, text: errText(err) || t("unknownError") });
    } finally {
      setRegBusy(false);
    }
  };
  const loadDevices = async () => {
    try {
      const r = await call(POCKET_ENDPOINTS.passkeyList, {});
      const list = Array.isArray(r) ? r : Array.isArray(r?.devices) ? r.devices : [];
      setDevices(list);
      setDevicesErr(null);
    } catch (err) {
      setDevices([]);
      setDevicesErr(err.message);
    }
  };
  const setPasskeyEnabled = async (on) => {
    setPasskeyBusy(true);
    try {
      mergeStatus(await call(POCKET_ENDPOINTS.passkeySetEnabled, { on }));
      showToast(on ? t("passkeyEnabledDone") : t("passkeyDisabledDone"));
      loadDevices();
    } catch (err) {
      setError(err.message);
    } finally {
      setPasskeyBusy(false);
    }
  };
  const doRenameDevice = async (id) => {
    const name2 = String(renameVal ?? "").trim();
    if (!name2) {
      setRenameId(null);
      return;
    }
    try {
      await call(POCKET_ENDPOINTS.passkeyRename, { id, name: name2 });
      setRenameId(null);
      setRenameVal("");
      showToast(t("passkeyRenamed"));
      loadDevices();
    } catch (err) {
      setError(err.message);
    }
  };
  const doRevokeDevice = async (id) => {
    try {
      await call(POCKET_ENDPOINTS.passkeyRevoke, { id });
      setRevokeId(null);
      showToast(t("passkeyRevokeDone"));
      loadDevices();
    } catch (err) {
      setError(err.message);
    }
  };
  const copyText = async (text) => {
    const value = String(text ?? "").trim();
    if (!value) return;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        showToast(t("copied"));
        return;
      }
    } catch {
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.setAttribute("readonly", "readonly");
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand?.("copy");
      document.body.removeChild(ta);
      showToast(ok ? t("copied") : t("copyFailed"));
    } catch {
      showToast(t("copyFailed"));
    }
  };
  const initialLoadRef = (0, import_react.useRef)(false);
  (0, import_react.useEffect)(() => {
    if (!status || initialLoadRef.current) return;
    initialLoadRef.current = true;
    if (status.passkey) loadDevices();
    if (status.notify) loadNotifyStatus();
  }, [status]);
  return (0, import_react.createElement)(
    "div",
    { style: styles.card },
    (0, import_react.createElement)(
      "div",
      { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 } },
      (0, import_react.createElement)(
        "div",
        null,
        (0, import_react.createElement)("strong", null, t("title")),
        (0, import_react.createElement)("div", { style: styles.muted }, t("subtitle"))
      ),
      (0, import_react.createElement)(
        "div",
        { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary,#8b93a1)", textAlign: "right" } },
        (0, import_react.createElement)("div", { style: { whiteSpace: "nowrap" } }, t("developer")),
        (0, import_react.createElement)("div", { style: { whiteSpace: "nowrap" } }, t("starAsk")),
        (0, import_react.createElement)(
          "a",
          { href: "https://github.com/shaobeichen/dsh-pocket", target: "_blank", rel: "noreferrer", style: { color: "var(--dsw-alias-brand-primary,#4f6ef7)", fontSize: 12, lineHeight: 1.6, textDecoration: "underline" } },
          t("starCta")
        )
      )
    ),
    // 桌面端不显示更新/重启横幅（更新由 DSH Desktop 管理），也不需要额外提示
    // 重启后提示（进程在后台运行，停止方法）——左侧蓝色色条（桌面端不会触发本插件的自重启）
    !isDesktop && restartNotice ? (0, import_react.createElement)(
      "div",
      { style: { ...styles.block, borderLeft: "4px solid var(--dsw-alias-brand-primary,#4f6ef7)", borderRadius: 8, background: "var(--dsw-alias-bg-layer-2,#f3f4f6)", padding: "10px 12px" } },
      (0, import_react.createElement)(
        "div",
        { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 } },
        (0, import_react.createElement)("div", { style: { fontWeight: 600, fontSize: 13 } }, t("restarted")),
        (0, import_react.createElement)("button", { style: styles.btn, onClick: () => setRestartNotice(false) }, t("ok"))
      ),
      (0, import_react.createElement)("div", { style: styles.muted, marginTop: 4, wordBreak: "break-all" }, fmt(t, "bgHint", { cmd: status?.killHint ?? `lsof -ti :${status?.dshPort ?? 3080} | xargs kill -9` }))
    ) : null,
    // 更新提示——左侧黄色色条（提示有新版本）；单状态：有更新/更新中/已更新自动重启，不并存
    // 桌面端不渲染（更新由 DSH Desktop 管理）
    !isDesktop && updateInfo ? (0, import_react.createElement)(
      "div",
      { style: { ...styles.block, borderLeft: "4px solid var(--dsw-alias-state-warn-primary,#b45309)", borderRadius: 8, background: "var(--dsw-alias-bg-layer-2,#f3f4f6)", padding: "10px 12px" } },
      (0, import_react.createElement)(
        "div",
        { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 } },
        (0, import_react.createElement)(
          "div",
          { style: { fontWeight: 600, fontSize: 13 } },
          updateInfo.updated ? fmt(t, "updatedRestart", { ver: updateInfo.current }) : updateInfo.result === "ok" ? updateInfo.autoRestart ? fmt(t, "updateAutoRestarting", { ver: updateInfo.latest }) : fmt(t, "updatedOk", { ver: updateInfo.latest }) : fmt(t, "updateAvailable", { ver: updateInfo.latest })
        ),
        updateInfo.result !== "ok" ? (0, import_react.createElement)("button", { style: styles.primary, onClick: runUpdate, disabled: updateInfo.updating }, updateInfo.updating ? t("updating") : fmt(t, "updateTo", { ver: updateInfo.latest })) : updateInfo.autoRestart ? (0, import_react.createElement)("button", { style: styles.btn, disabled: true }, t("restartingNow")) : (0, import_react.createElement)("button", { style: styles.primary, onClick: restartPocket, disabled: updateInfo.restarting }, updateInfo.restarting ? t("restarting") : t("restartNow"))
      ),
      (0, import_react.createElement)(
        "div",
        { style: styles.muted, marginTop: 4 },
        updateInfo.updating ? fmt(t, "updatingDetail", { s: elapsed(updateInfo.startedAt) }) : updateInfo.restarting ? fmt(t, "restartingDetail", { s: elapsed(updateInfo.startedAt) }) : updateInfo.result === "ok" ? updateInfo.autoRestart ? t("updatedAutoDetail") : t("updatedRestartDetail") : updateInfo.result === "fail" ? fmt(t, "updateFailed", { err: errText(updateInfo.output) || t("unknownError") }) : fmt(t, "versionRange", { cur: updateInfo.current, latest: updateInfo.latest })
      )
    ) : null,
    // 局域网：标题行自带总开关 → 二维码+地址 → 设置行（访问密码 / 高级·手动选地址）
    (0, import_react.createElement)(
      "div",
      { style: styles.block },
      (0, import_react.createElement)(
        "div",
        { style: { display: "flex", alignItems: "center", justifyContent: "space-between" } },
        (0, import_react.createElement)("span", { style: { fontWeight: 600, fontSize: 13 } }, t("lanAccess")),
        Switch(status?.lanEnabled !== false, () => requestLanToggle(status?.lanEnabled === false))
      ),
      status?.lanEnabled === false ? (0, import_react.createElement)("div", { style: { marginTop: 8, fontSize: 12, color: "var(--dsw-alias-state-warn-primary,#b45309)", lineHeight: 1.5 } }, t("lanDisabledHint")) : lanUrl ? (0, import_react.createElement)(
        "div",
        null,
        qrArea(status.lanQr, lanUrl, t("lanHint")),
        // 访问密码行：开关 + 值（关闭时提示直连）
        row(
          t("lanPin"),
          Switch(status?.lanAuthEnabled !== false, () => setLanAuth(status?.lanAuthEnabled === false)),
          status?.lanAuthEnabled === false ? (0, import_react.createElement)("div", { style: { ...styles.muted, marginTop: 6 } }, t("lanPinOff")) : customPin?.which === "lan" ? customPinRow("lan") : (0, import_react.createElement)(
            "div",
            { style: { marginTop: 6, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
            (0, import_react.createElement)("span", { style: { fontFamily: "ui-monospace,Menlo,monospace", fontSize: 13, letterSpacing: 1 } }, status.lanToken),
            (0, import_react.createElement)("button", { style: { ...styles.btn, height: 26, padding: "0 10px", fontSize: 12 }, onClick: refreshLanPin }, t("refresh")),
            customBtn("lan"),
            status?.lanPinCustom ? (0, import_react.createElement)("span", { style: { fontSize: 11, color: "var(--dsw-alias-state-warn-primary,#b45309)" } }, t("pinCustomHint")) : null
          )
        ),
        // 高级：手动选地址（默认收起）
        row(
          t("advAddress"),
          (0, import_react.createElement)(
            "button",
            { style: { border: "none", background: "none", font: "inherit", cursor: "pointer", fontSize: 12, color: "var(--dsw-alias-label-tertiary,#8b93a1)", padding: 0 }, onClick: () => setAdvOpen((v) => !v) },
            (status?.lanIpOverride || t("lanAddressAuto")) + " \u203A"
          ),
          advOpen ? (0, import_react.createElement)(
            "div",
            { style: { marginTop: 8 } },
            (0, import_react.createElement)(
              "label",
              { style: { display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--dsw-alias-label-secondary,#6b7280)" } },
              t("lanAddress"),
              (0, import_react.createElement)(
                "select",
                {
                  value: status?.lanIpOverride || "",
                  onChange: (e) => setLanAddress(e.target.value),
                  style: { font: "inherit", height: 30, padding: "0 8px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2,#d1d5db)", background: "var(--dsw-alias-bg-layer-1,#fff)", color: "var(--dsw-alias-label-primary,inherit)" }
                },
                (0, import_react.createElement)("option", { value: "" }, t("lanAddressAuto")),
                (status?.lanCandidates || []).map((ip) => (0, import_react.createElement)("option", { key: ip, value: ip }, ip))
              )
            )
          ) : null
        )
      ) : (0, import_react.createElement)("div", { style: styles.muted }, t("lanStarting"))
    ),
    // 公网：标题行自带 开启/关闭 → 开启后：二维码+地址、地址模式行、访问密码行
    (0, import_react.createElement)(
      "div",
      { style: styles.block },
      (0, import_react.createElement)(
        "div",
        { style: { display: "flex", alignItems: "center", justifyContent: "space-between" } },
        (0, import_react.createElement)("span", { style: { fontWeight: 600, fontSize: 13 } }, t("wanAccess")),
        publicRunning ? (0, import_react.createElement)("button", { style: { ...styles.btn, height: 28, padding: "0 12px", fontSize: 12, color: "var(--dsw-alias-state-error-primary,#dc2626)" }, onClick: stopTunnel }, t("stopTunnel")) : (0, import_react.createElement)("button", { style: { ...styles.primary, height: 28, padding: "0 14px", fontSize: 12 }, onClick: startTunnel, disabled: busy || tunnelStarting }, busy || tunnelStarting ? t("opening") : fmt(t, "startChannel", { channel: channelLabel(willStartMode) }))
      ),
      tunnelStarting ? (0, import_react.createElement)(
        "div",
        { style: { marginTop: 8, fontSize: 12, color: "var(--dsw-alias-label-secondary,#6b7280)" } },
        tunnelPhase === "downloading" ? fmt(t, "downloading", { s: elapsed(tunnelStateStarted) }) : fmt(t, "connecting", { s: elapsed(tunnelStateStarted), suffix: elapsed(tunnelStateStarted) > 30 ? t("slowHint") : "" })
      ) : tunnelPhase === "error" ? (0, import_react.createElement)(
        "div",
        { style: { marginTop: 8, fontSize: 12, color: "var(--dsw-alias-state-error-primary,#dc2626)" } },
        fmt(t, "error", { detail: errText(tunnelStateDetail) || t("unknownError") })
      ) : !publicRunning && !isDesktop ? (0, import_react.createElement)("div", { style: { ...styles.muted, marginTop: 8 } }, t("wanOffHint")) : null,
      // 公网入口三选一（Quick/Named/SSH 互斥）：不依赖隧道是否在运行，随时可切换/配置
      row(
        t("modeLabel"),
        (0, import_react.createElement)(
          "span",
          { style: { display: "inline-flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end", minWidth: 0 } },
          (0, import_react.createElement)("button", { style: modeBtnStyle(!namedActive && !sshActive), onClick: selectQuick }, t("modeQuick")),
          (0, import_react.createElement)("button", { style: modeBtnStyle(namedActive), onClick: selectNamed }, t("modeNamed")),
          (0, import_react.createElement)("button", { style: modeBtnStyle(sshActive), onClick: selectSsh }, t("modeSsh"))
        ),
        (0, import_react.createElement)(
          "div",
          { style: { marginTop: 6 } },
          // 选中了通道但还没保存：明确告知"点开始会先保存并启动哪条通道"，不再默默开成另一条
          pendingModeHint ? (0, import_react.createElement)("div", { style: { ...styles.warn } }, pendingModeHint) : null,
          // 刚保存固定域名但当前连接仍是随机域名：需关闭后重新开启才生效
          namedMode && /trycloudflare\.com/i.test(tunnelUrl ?? "") ? (0, import_react.createElement)("div", { style: { ...styles.warn } }, t("namedTakeEffect")) : null,
          // 固定域名：已保存摘要 + 修改入口（非编辑态）
          namedMode && !tunnelCfg ? (0, import_react.createElement)(
            "div",
            { style: { ...styles.muted } },
            fmt(t, "namedSummary", { host: tunnelModeView.hostname || "\u2014", token: tunnelModeView.tokenSet ? t("namedTokenSet") : t("namedTokenMissing") }),
            (0, import_react.createElement)("button", { style: { ...styles.btn, height: 26, padding: "0 10px", fontSize: 12, marginLeft: 8 }, onClick: () => setTunnelCfg({ hostname: tunnelModeView.hostname ?? "", token: "", err: null }) }, t("namedEdit")),
            (0, import_react.createElement)("div", { style: { ...styles.muted, marginTop: 4 } }, t("namedHow")),
            !tunnelModeView.tokenSet || !tunnelModeView.hostname ? (0, import_react.createElement)("div", { style: { marginTop: 2, color: "var(--dsw-alias-state-error-primary,#dc2626)" } }, t("namedNeedCfg")) : null
          ) : null,
          // 固定域名：编辑表单（域名 + Tunnel Token，Token 留空保持不变）
          tunnelCfg ? (0, import_react.createElement)(
            "div",
            { style: { marginTop: 6, fontSize: 12, color: "var(--dsw-alias-label-secondary,#6b7280)", lineHeight: 1.6 } },
            (0, import_react.createElement)(
              "div",
              null,
              t("namedHostnameLabel"),
              (0, import_react.createElement)("input", {
                style: { margin: "4px 0 0 6px", padding: "4px 8px", fontSize: 13, border: "1px solid var(--dsw-alias-border-l2,#d1d5db)", borderRadius: 6, outline: "none", width: 200 },
                placeholder: "pocket.example.com",
                value: tunnelCfg.hostname ?? "",
                autoFocus: true,
                onChange: (e) => setTunnelCfg((c) => ({ ...c, hostname: e.target.value.trim(), err: null })),
                onKeyDown: (e) => {
                  if (e.key === "Enter") saveNamedTunnel();
                  if (e.key === "Escape") setTunnelCfg(null);
                }
              })
            ),
            (0, import_react.createElement)(
              "div",
              { style: { marginTop: 6 } },
              t("namedTokenLabel"),
              (0, import_react.createElement)("input", {
                style: { margin: "4px 0 0 6px", padding: "4px 8px", fontSize: 13, border: "1px solid var(--dsw-alias-border-l2,#d1d5db)", borderRadius: 6, outline: "none", width: 240, fontFamily: "ui-monospace,Menlo,monospace" },
                type: "password",
                value: tunnelCfg.token ?? "",
                onChange: (e) => setTunnelCfg((c) => ({ ...c, token: e.target.value.trim(), err: null })),
                onKeyDown: (e) => {
                  if (e.key === "Enter") saveNamedTunnel();
                  if (e.key === "Escape") setTunnelCfg(null);
                }
              })
            ),
            (0, import_react.createElement)(
              "div",
              { style: { marginTop: 6, display: "flex", gap: 8 } },
              (0, import_react.createElement)("button", { style: { ...styles.btn, height: 26, padding: "0 10px", fontSize: 12 }, onClick: saveNamedTunnel }, t("save")),
              (0, import_react.createElement)("button", { style: { ...styles.btn, height: 26, padding: "0 10px", fontSize: 12 }, onClick: () => {
                setTunnelCfg(null);
                if (!namedMode) setPendingMode(null);
              } }, t("cancel"))
            ),
            (0, import_react.createElement)("div", { style: { ...styles.muted, marginTop: 6 } }, t("namedHow")),
            (0, import_react.createElement)("div", { style: { marginTop: 2, fontSize: 11, color: "var(--dsw-alias-state-warn-primary,#b45309)", lineHeight: 1.5 } }, t("namedSecurity")),
            tunnelCfg.err ? (0, import_react.createElement)("div", { style: { color: "var(--dsw-alias-state-error-primary,#dc2626)", marginTop: 4 } }, errText(tunnelCfg.err)) : null
          ) : null
        )
      ),
      // SSH 通道：状态 + 地址/二维码 + 配置表单（选中 SSH 或正在编辑时显示）
      sshSection,
      // Quick/Named 运行中：二维码 + 防钓鱼提示（SSH 的二维码在 SSH 区块内）
      tunnelUrl ? (0, import_react.createElement)(
        "div",
        null,
        qrArea(status.tunnelQr, tunnelUrl, namedMode ? t("namedRunningHint") : t("wanHint")),
        (0, import_react.createElement)("div", { style: { marginTop: 8, fontSize: 12, lineHeight: 1.5, borderLeft: "4px solid var(--dsw-alias-state-warn-primary,#b45309)", background: "var(--dsw-alias-bg-layer-2,#f3f4f6)", borderRadius: 8, padding: "8px 10px" } }, t("wanEphemeralWarn"))
      ) : null,
      // 访问密码行：值 + 自定义（公网共享 PIN，Quick/Named/SSH 三种通道共用；公网开启后显示）
      publicRunning && status?.accessToken ? row(
        t("pinLabel"),
        customPin?.which === "public" ? null : (0, import_react.createElement)(
          "span",
          { style: { display: "inline-flex", alignItems: "center", gap: 8 } },
          (0, import_react.createElement)("span", { style: { fontFamily: "ui-monospace,Menlo,monospace", fontSize: 13, letterSpacing: 1 } }, status.accessToken),
          customBtn("public")
        ),
        (0, import_react.createElement)(
          "div",
          { style: { marginTop: 6 } },
          customPin?.which === "public" ? customPinRow("public") : null,
          status?.publicPinCustom ? (0, import_react.createElement)("div", { style: { ...styles.warn } }, t("pinCustomHint")) : null,
          namedMode ? (0, import_react.createElement)("div", { style: { ...styles.warn } }, t("namedSecurity")) : null
        )
      ) : null
    ),
    // 通知与 PWA（task-6）：Web Push 订阅 + Webhook；旧宿主不返回 notify 字段时降级提示
    (0, import_react.createElement)(
      "div",
      { style: styles.block },
      (0, import_react.createElement)("span", { style: { fontWeight: 600, fontSize: 13 } }, t("notifyTitle")),
      !status ? (0, import_react.createElement)("div", { style: { ...styles.muted, marginTop: 6 } }, t("lanStarting")) : !notifyView ? (0, import_react.createElement)("div", { style: { ...styles.muted, marginTop: 6 } }, t("hostUnsupported")) : (0, import_react.createElement)(
        "div",
        null,
        // Web Push 总开关 + 说明（浏览器推送依赖厂商服务，可能延迟）
        row(
          t("notifyPush"),
          Switch(notifyView.pushEnabled === true, () => setNotifyFlag("pushEnabled", notifyView.pushEnabled !== true)),
          (0, import_react.createElement)("div", { style: { ...styles.muted, marginTop: 6 } }, t("notifyPushHint"))
        ),
        // 订阅数量 + 本机订阅/取消（浏览器要求：必须在用户手势里调用）
        row(
          fmt(t, "notifySubsCount", { n: notifyView.subscriptionCount ?? 0 }),
          (0, import_react.createElement)(
            "div",
            { style: styles.btnRow },
            (0, import_react.createElement)("button", { style: styles.smallBtn, onClick: subscribePush, disabled: notifyBusy || !pushApiReady }, t("notifySubscribe")),
            (0, import_react.createElement)("button", { style: styles.smallBtn, onClick: unsubscribePush, disabled: notifyBusy }, t("notifyUnsubscribe"))
          ),
          (0, import_react.createElement)(
            "div",
            null,
            !pushApiReady ? (0, import_react.createElement)("div", { style: { ...styles.muted, marginTop: 4 } }, pushUnavailableText()) : null,
            // 有订阅时才给「清空全部订阅」（手机换浏览器/清数据后的残留订阅）
            (notifyView.subscriptionCount ?? 0) > 0 ? (0, import_react.createElement)(
              "div",
              { style: { marginTop: 6 } },
              clearSubsAsk ? (0, import_react.createElement)(
                "div",
                { style: { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" } },
                (0, import_react.createElement)("span", { style: { ...styles.warn, flex: "1 1 100%" } }, t("notifyClearConfirm")),
                (0, import_react.createElement)("button", { style: styles.miniBtn, onClick: clearSubscriptions, disabled: notifyBusy }, t("confirm")),
                (0, import_react.createElement)("button", { style: styles.miniBtn, onClick: () => setClearSubsAsk(false) }, t("cancel"))
              ) : (0, import_react.createElement)("button", { style: styles.miniBtn, onClick: () => setClearSubsAsk(true) }, t("notifyClear"))
            ) : null
          )
        ),
        // 发送测试通知
        row(
          t("notifyTest"),
          (0, import_react.createElement)("button", { style: styles.smallBtn, onClick: sendTestNotification, disabled: notifyBusy }, notifyBusy ? t("notifyTesting") : t("notifyTest"))
        ),
        // 网络自检：宿主进程侧的真实连通性（DNS/TCP/HTTP + 代理环境）
        row(
          t("notifyDiagnose"),
          (0, import_react.createElement)("button", { style: styles.smallBtn, onClick: runDiagnose, disabled: diagnoseBusy }, diagnoseBusy ? t("notifyDiagnosing") : t("notifyDiagnoseBtn")),
          diagnoseData ? safeNode(() => (0, import_react.createElement)(
            "div",
            { style: { ...styles.muted, marginTop: 6, wordBreak: "break-word", fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12, lineHeight: 1.6 } },
            (0, import_react.createElement)("div", null, fmt(t, "notifyDiagnoseEnv", {
              node: diagnoseData.env?.node ?? "\u2014",
              proxy: diagnoseData.env?.httpsProxy || diagnoseData.env?.httpProxy || t("notifyDiagnoseNoProxy"),
              useEnvProxy: diagnoseData.env?.useEnvProxy || "0"
            })),
            ...(Array.isArray(diagnoseData.results) ? diagnoseData.results : []).map((r, i) => (0, import_react.createElement)(
              "div",
              { key: `diag-${i}`, style: { marginTop: 3 } },
              `${r?.host ?? "?"}: ${r?.dns || "\u2014"} | TCP ${(Array.isArray(r?.tcp) ? r.tcp : []).map((x) => `IPv${x.family} ${x.ok ? `OK ${x.ms}ms` : `\u5931\u8D25(${x.error})`}`).join(" / ") || "\u2014"} | HTTPS ${r?.http ? r.http.ok ? `HTTP ${r.http.status}` : `\u5931\u8D25(${r.http.error})` : "\u2014"}`
            )),
            diagnoseData.error ? (0, import_react.createElement)("div", { style: { color: COLOR_ERR } }, errText(diagnoseData.error)) : null
          )) : null
        ),
        // 最近推送结果：列出最近 5 条（含推送服务归属），避免只看到末条而误判
        (0, import_react.createElement)(
          "div",
          { style: { ...styles.muted, marginTop: 6, wordBreak: "break-word" } },
          notifyRecent.length ? (0, import_react.createElement)(
            "div",
            null,
            (0, import_react.createElement)("div", null, t("notifyRecentTitle")),
            ...notifyRecent.map((r, i) => (0, import_react.createElement)("div", { key: `push-result-${i}`, style: { marginTop: 2 } }, resultText(r)))
          ) : t("notifyNoResult")
        ),
        // 任务完成时推送（与 Webhook 无关的全局开关）
        row(t("notifyOnTaskDone"), Switch(notifyView.onTaskDone !== false, () => setNotifyFlag("onTaskDone", notifyView.onTaskDone === false))),
        // Webhook：开关 + 预设/URL/密钥/间隔（开启后才展开字段，保持页面紧凑）
        row(
          t("notifyWebhook"),
          Switch(notifyView.webhookEnabled === true, () => setNotifyFlag("webhookEnabled", notifyView.webhookEnabled !== true)),
          (0, import_react.createElement)(
            "div",
            { style: { marginTop: 6 } },
            (0, import_react.createElement)("div", { style: { ...styles.muted } }, t("notifyWebhookHint")),
            notifyView.webhookEnabled ? (0, import_react.createElement)(
              "div",
              null,
              sshField(
                t("notifyPreset"),
                (0, import_react.createElement)(
                  "select",
                  { style: styles.select, value: notifyForm.preset, onChange: (e) => patchNotifyForm({ preset: e.target.value }) },
                  NOTIFY_PRESETS2.map(([value, key]) => (0, import_react.createElement)("option", { key: value, value }, t(key)))
                )
              ),
              sshField(t("notifyUrl"), sshInput(notifyForm.url, (v) => patchNotifyForm({ url: v.trim() }), { placeholder: "https://\u2026" })),
              sshField(
                t("notifySecret"),
                sshInput(notifyForm.secret, (v) => patchNotifyForm({ secret: v }), { type: "password", placeholder: notifyView.webhookConfigured ? t("notifySecretSet") : "" }),
                notifyView.webhookConfigured ? t("notifySecretSet") : t("notifySecretHint")
              ),
              sshField(
                t("notifyMinInterval"),
                sshInput(notifyForm.minInterval, (v) => patchNotifyForm({ minInterval: v }), { inputMode: "numeric", placeholder: t("notifyMinIntervalPlaceholder") }),
                t("notifyMinIntervalHint")
              ),
              (0, import_react.createElement)(
                "div",
                { style: { marginTop: 10 } },
                (0, import_react.createElement)("button", { style: styles.smallBtn, onClick: saveNotifyConfig, disabled: notifyBusy }, t("save"))
              )
            ) : null
          )
        ),
        // PWA 安装提示：可安装时给按钮，否则给一句为什么不可安装
        row(
          t("pwaRow"),
          canInstall ? (0, import_react.createElement)("button", { style: styles.smallBtn, onClick: promptInstall }, t("pwaInstall")) : null,
          (0, import_react.createElement)("div", { style: { ...styles.muted, marginTop: 4 } }, canInstall ? null : pwaReason())
        )
      )
    ),
    // 通行密钥设备（task-6）：启用开关 + rpId + 设备列表（重命名/撤销）
    (0, import_react.createElement)(
      "div",
      { style: styles.block },
      (0, import_react.createElement)(
        "div",
        { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 } },
        (0, import_react.createElement)("span", { style: { fontWeight: 600, fontSize: 13 } }, t("passkeyTitle")),
        passkeyView ? Switch(passkeyView.enabled === true, () => setPasskeyEnabled(passkeyView.enabled !== true)) : null
      ),
      !status ? (0, import_react.createElement)("div", { style: { ...styles.muted, marginTop: 6 } }, t("lanStarting")) : !passkeyView ? (0, import_react.createElement)("div", { style: { ...styles.muted, marginTop: 6 } }, t("hostUnsupported")) : (0, import_react.createElement)(
        "div",
        null,
        (0, import_react.createElement)("div", { style: { ...styles.muted, marginTop: 6 } }, t("passkeyHint")),
        // 三态说明：非安全上下文 → 浏览器不支持 → 可用
        (0, import_react.createElement)(
          "div",
          { style: { marginTop: 6, fontSize: 12, lineHeight: 1.5, color: !webAuthn.secure || !webAuthn.supported ? COLOR_ERR : "var(--dsw-alias-label-tertiary,#8b93a1)" } },
          !webAuthn.secure ? t("passkeyInsecure") : !webAuthn.supported ? t("passkeyUnsupported") : t("passkeySecureHint")
        ),
        // 在本设备注册通行密钥：入口仅位于插件设置页
        webAuthn.secure && webAuthn.supported && passkeyView.enabled === true ? row(
          t("passkeyRegister"),
          (0, import_react.createElement)(
            "button",
            { style: styles.smallBtn, onClick: registerThisDevice, disabled: regBusy },
            regBusy ? t("passkeyRegistering") : t("passkeyRegisterBtn")
          ),
          regMsg ? (0, import_react.createElement)("div", { style: { marginTop: 4, fontSize: 12, lineHeight: 1.5, wordBreak: "break-word", color: regMsg.ok ? COLOR_OK : COLOR_ERR } }, regMsg.text) : null
        ) : null,
        row(
          t("passkeyRpId"),
          (0, import_react.createElement)(
            "span",
            { style: { fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12, wordBreak: "break-all" } },
            passkeyView.rpId || (typeof location !== "undefined" ? location.hostname : "\u2014")
          )
        ),
        row(
          fmt(t, "passkeyDeviceCount", { n: passkeyView.deviceCount ?? 0 }),
          (0, import_react.createElement)("button", { style: styles.smallBtn, onClick: loadDevices, disabled: passkeyBusy }, t("refresh"))
        ),
        // 设备列表：名称 / 注册时间 / 最后登录 + 重命名/撤销（撤销两步确认，避免误触）
        (0, import_react.createElement)("div", { style: { fontWeight: 600, fontSize: 12, marginTop: 10 } }, t("passkeyDevices")),
        devicesErr ? (0, import_react.createElement)("div", { style: { color: COLOR_ERR, fontSize: 12, marginTop: 6, wordBreak: "break-word" } }, fmt(t, "passkeyLoadFailed", { err: errText(devicesErr) })) : null,
        devices && devices.length === 0 && !devicesErr ? (0, import_react.createElement)("div", { style: { ...styles.muted, marginTop: 6 } }, t("passkeyNoDevices")) : null,
        (devices ?? []).map((d, i) => (0, import_react.createElement)(
          "div",
          { key: String(d?.id ?? d?.credentialId ?? i), style: { borderTop: "1px solid var(--dsw-alias-border-l2,#e5e7eb)", paddingTop: 8, marginTop: 8 } },
          (0, import_react.createElement)(
            "div",
            { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" } },
            (0, import_react.createElement)("span", { style: { fontSize: 13, wordBreak: "break-word", minWidth: 0 } }, d?.name || t("passkeyUnnamed")),
            (0, import_react.createElement)(
              "div",
              { style: styles.btnRow },
              (0, import_react.createElement)("button", { style: styles.miniBtn, onClick: () => {
                setRevokeId(null);
                setRenameId(d?.id);
                setRenameVal(d?.name ?? "");
              } }, t("passkeyRename")),
              (0, import_react.createElement)("button", { style: { ...styles.miniBtn, color: COLOR_ERR }, onClick: () => {
                setRenameId(null);
                setRevokeId(d?.id);
              } }, t("passkeyRevoke"))
            )
          ),
          (0, import_react.createElement)(
            "div",
            { style: { ...styles.muted, marginTop: 2, wordBreak: "break-word" } },
            `${t("passkeyColCreated")}: ${fmtTime(d?.createdAt, "\u2014")} \xB7 ${t("passkeyColLastLogin")}: ${fmtTime(d?.lastLoginAt, t("passkeyNever"))}`
          ),
          // 重命名：内联输入，回车保存
          renameId === d?.id ? (0, import_react.createElement)(
            "div",
            { style: { marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" } },
            (0, import_react.createElement)("input", {
              style: { ...styles.input, maxWidth: 180 },
              value: renameVal,
              autoFocus: true,
              maxLength: 40,
              onChange: (e) => setRenameVal(e.target.value),
              onKeyDown: (e) => {
                if (e.key === "Enter") doRenameDevice(d?.id);
                if (e.key === "Escape") setRenameId(null);
              }
            }),
            (0, import_react.createElement)("button", { style: styles.miniBtn, onClick: () => doRenameDevice(d?.id) }, t("save")),
            (0, import_react.createElement)("button", { style: styles.miniBtn, onClick: () => setRenameId(null) }, t("cancel"))
          ) : null,
          // 撤销：先给后果说明，再确认
          revokeId === d?.id ? (0, import_react.createElement)(
            "div",
            { style: { marginTop: 6 } },
            (0, import_react.createElement)("div", { style: { ...styles.warn } }, t("passkeyRevokeConfirm")),
            (0, import_react.createElement)(
              "div",
              { style: { marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" } },
              (0, import_react.createElement)("button", { style: { ...styles.miniBtn, color: COLOR_ERR }, onClick: () => doRevokeDevice(d?.id) }, t("passkeyRevoke")),
              (0, import_react.createElement)("button", { style: styles.miniBtn, onClick: () => setRevokeId(null) }, t("cancel"))
            )
          ) : null
        ))
      )
    ),
    error ? (0, import_react.createElement)("div", { style: { color: "var(--dsw-alias-state-error-primary,#dc2626)", fontSize: 12, marginTop: 8 } }, `\u274C ${errText(error)}`) : null,
    // 恢复出厂设置：设置出问题时的临时兜底（最底部，避免误触）
    (0, import_react.createElement)(
      "div",
      { style: styles.block },
      (0, import_react.createElement)(
        "div",
        { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 } },
        (0, import_react.createElement)("span", { style: { fontWeight: 600, fontSize: 13 } }, t("resetFactory")),
        (0, import_react.createElement)("button", { style: { ...styles.btn, height: 28, padding: "0 12px", fontSize: 12, color: "var(--dsw-alias-state-error-primary,#dc2626)" }, onClick: () => setResetOpen(true) }, t("resetGo"))
      ),
      (0, import_react.createElement)("div", { style: { ...styles.muted, marginTop: 6 } }, t("resetIntro"))
    ),
    // 恢复出厂设置确认弹框
    resetOpen ? (0, import_react.createElement)(
      "div",
      { style: { position: "fixed", inset: 0, zIndex: 1e4, background: "rgba(0,0,0,.5)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 } },
      (0, import_react.createElement)(
        "div",
        { style: { background: "var(--dsw-alias-bg-layer-1,#fff)", borderRadius: 12, maxWidth: 440, width: "100%", padding: "20px 22px", boxShadow: "0 8px 32px rgba(0,0,0,.18)" } },
        (0, import_react.createElement)("div", { style: { fontWeight: 600, fontSize: 15, color: "var(--dsw-alias-state-warn-primary,#b45309)", marginBottom: 10 } }, t("resetTitle")),
        (0, import_react.createElement)("div", { style: { fontSize: 13, lineHeight: 1.7, color: "var(--dsw-alias-label-primary,inherit)", whiteSpace: "pre-line" } }, t("resetBody")),
        (0, import_react.createElement)(
          "div",
          { style: { display: "flex", gap: 8, marginTop: 16 } },
          (0, import_react.createElement)("button", { style: { ...styles.btn, flex: 1 }, onClick: () => setResetOpen(false) }, t("cancel")),
          (0, import_react.createElement)("button", { style: { ...styles.primary, flex: 1, background: "var(--dsw-alias-state-error-primary,#dc2626)" }, onClick: doFactoryReset }, t("resetConfirm"))
        )
      )
    ) : null,
    // Toast：重置等操作的即时反馈（固定屏幕正中央，2.6s 自动消失）
    toast ? (0, import_react.createElement)("div", {
      style: { position: "fixed", left: "50%", top: "50%", transform: "translate(-50%, -50%)", zIndex: 10001, width: "auto", maxWidth: 280, background: "rgba(17,24,39,.92)", color: "#fff", border: "none", borderRadius: 10, padding: "10px 16px", fontSize: 13, lineHeight: 1.5, textAlign: "center", boxShadow: "0 8px 24px rgba(0,0,0,.22)" }
    }, toast) : null,
    // 局域网访问开关确认弹框（关闭/打开时弹窗提醒）
    lanToggleOpen !== null ? (0, import_react.createElement)(
      "div",
      { style: { position: "fixed", inset: 0, zIndex: 1e4, background: "rgba(0,0,0,.5)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 } },
      (0, import_react.createElement)(
        "div",
        { style: { background: "var(--dsw-alias-bg-layer-1,#fff)", borderRadius: 12, maxWidth: 420, width: "100%", padding: "20px 22px", boxShadow: "0 8px 32px rgba(0,0,0,.18)" } },
        (0, import_react.createElement)("div", { style: { fontWeight: 600, fontSize: 15, color: lanToggleOpen ? "var(--dsw-alias-brand-primary,#4f6ef7)" : "var(--dsw-alias-state-warn-primary,#b45309)", marginBottom: 10 } }, t(lanToggleOpen ? "lanToggleTitleOn" : "lanToggleTitleOff")),
        (0, import_react.createElement)("div", { style: { fontSize: 13, lineHeight: 1.7, color: "var(--dsw-alias-label-primary,inherit)" } }, t(lanToggleOpen ? "lanToggleBodyOn" : "lanToggleBodyOff")),
        (0, import_react.createElement)(
          "div",
          { style: { display: "flex", gap: 8, marginTop: 16 } },
          (0, import_react.createElement)("button", { style: { ...styles.btn, flex: 1 }, onClick: () => setLanToggleOpen(null) }, t("cancel")),
          (0, import_react.createElement)("button", { style: { ...styles.primary, flex: 1 }, onClick: confirmLanToggle }, t("confirm"))
        )
      )
    ) : null,
    // 安全免责声明弹框（issue #31）：每次开启公网访问前确认
    disclaimerOpen ? (0, import_react.createElement)(
      "div",
      { style: { position: "fixed", inset: 0, zIndex: 1e4, background: "rgba(0,0,0,.5)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 } },
      (0, import_react.createElement)(
        "div",
        { style: { background: "var(--dsw-alias-bg-layer-1,#fff)", borderRadius: 12, maxWidth: 420, width: "100%", padding: "20px 22px", boxShadow: "0 8px 32px rgba(0,0,0,.18)" } },
        (0, import_react.createElement)("div", { style: { fontWeight: 600, fontSize: 15, color: "var(--dsw-alias-state-warn-primary,#b45309)", marginBottom: 10 } }, t("disclaimerTitle")),
        (0, import_react.createElement)("div", { style: { fontSize: 13, lineHeight: 1.7, color: "var(--dsw-alias-label-primary,inherit)" } }, t("disclaimerBody")),
        (0, import_react.createElement)(
          "label",
          { style: { display: "flex", alignItems: "center", gap: 8, marginTop: 14, fontSize: 13, cursor: "pointer" } },
          (0, import_react.createElement)("input", { type: "checkbox", checked: disclaimerChecked, onChange: (e) => setDisclaimerChecked(e.target.checked), style: { width: 16, height: 16 } }),
          t("disclaimerAgree")
        ),
        (0, import_react.createElement)(
          "div",
          { style: { display: "flex", gap: 8, marginTop: 16 } },
          (0, import_react.createElement)("button", { style: { ...styles.btn, flex: 1 }, onClick: () => setDisclaimerOpen(false) }, t("cancel")),
          (0, import_react.createElement)("button", {
            style: { ...styles.primary, flex: 1, opacity: disclaimerChecked ? 1 : 0.5 },
            disabled: !disclaimerChecked,
            onClick: confirmDisclaimer
          }, t("disclaimerAgree"))
        ),
        !disclaimerChecked ? (0, import_react.createElement)("div", { style: { marginTop: 8, fontSize: 12, color: "var(--dsw-alias-state-error-primary,#dc2626)" } }, t("disclaimerHint")) : null
      )
    ) : null,
    // 页面最底部：反馈入口
    (0, import_react.createElement)(
      "div",
      { style: { ...styles.block, textAlign: "center" } },
      (0, import_react.createElement)(
        "a",
        { href: "https://github.com/shaobeichen/dsh-pocket/issues", target: "_blank", rel: "noreferrer", style: { fontSize: 12, color: "var(--dsw-alias-label-secondary,#6b7280)", textDecoration: "none" } },
        t("feedback")
      )
    )
  );
}
function apply(ctx) {
  const rpcCall = (endpoint, payload, signal) => ctx.connection.rpc.call(POCKET_RPC_CHANNEL, endpoint, payload, signal);
  const translate = ctx.locale.bind(NS);
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-pocket: pocket locale dictionaries");
  ctx.slots.inject(
    "settings.section",
    () => ctx.slots.register(
      {
        name: "settings.section",
        id: "pocket",
        order: 1,
        label: () => translate("section"),
        inject: () => ({ rpcCall, t: translate })
      },
      PocketSettingsTab
    )
  );
}

    return module.exports;
  }
});
