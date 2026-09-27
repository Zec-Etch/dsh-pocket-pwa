// 宿主进程内的网络自检：回答"为什么推送/Webhook 报 fetch failed"。
//
// 只做只读连接探测（DNS → TCP → TLS+HTTP HEAD），不发送任何凭据、不写任何文件。
// 关键点：它跑在**宿主进程**里，所以能反映那个进程真实的网络环境（代理变量、Node 版本、
// 可否解析/连接），这正是浏览器里看不出来的部分。
import { lookup } from 'node:dns/promises';
import { connect } from 'node:net';

/** 三大浏览器推送服务；FCM 在国内通常不可达，另外两家一般可达。 */
export const PUSH_SERVICE_HOSTS = Object.freeze([
  'updates.push.services.mozilla.com', // Firefox
  'web.push.apple.com', // Safari / iOS
  'fcm.googleapis.com', // Chrome / Edge / Android
]);

/** 把异常压成一行可读原因（undici 的网络错误真实原因在 cause.code 上）。 */
export function shortError(err) {
  const code = err?.cause?.code ?? err?.code;
  const msg = String(err?.cause?.message ?? err?.message ?? err ?? 'unknown');
  return code ? `${code}${msg && msg !== code ? ` (${msg})` : ''}` : msg;
}

function tcpProbe(address, port, family, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: address, port, family });
    const timer = setTimeout(() => {
      socket.destroy();
      const e = new Error('connect timeout');
      e.code = 'ETIMEDOUT';
      reject(e);
    }, timeoutMs);
    socket.on('connect', () => { clearTimeout(timer); socket.end(); resolve(); });
    socket.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

async function httpsProbe(host, port, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // HEAD 足够证明"能连上并完成 TLS 握手"，且不拉取正文
    const res = await fetch(`https://${host}:${port}/`, { method: 'HEAD', redirect: 'manual', signal: ctrl.signal });
    return res.status;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 探测单个主机：DNS（全部地址）→ 每个协议族的 TCP 连接 → HTTPS HEAD。
 * @returns {Promise<{host:string, port:number, dns:string, addresses:Array<{address:string,family:number}>, tcp:Array<object>, http:object|null}>}
 */
export async function probeHost(host, { port = 443, timeoutMs = 5000 } = {}) {
  const out = { host, port, dns: '', addresses: [], tcp: [], http: null };
  try {
    out.addresses = await lookup(host, { all: true });
    out.dns = out.addresses.map((a) => `IPv${a.family} ${a.address}`).join('、');
  } catch (err) {
    out.dns = `DNS 失败：${shortError(err)}`;
    return out;
  }
  for (const family of [4, 6]) {
    const addr = out.addresses.find((a) => a.family === family);
    if (!addr) { out.tcp.push({ family, ok: false, error: '无该协议族地址' }); continue; }
    const started = Date.now();
    try {
      await tcpProbe(addr.address, port, family, timeoutMs);
      out.tcp.push({ family, ok: true, address: addr.address, ms: Date.now() - started });
    } catch (err) {
      out.tcp.push({ family, ok: false, address: addr.address, error: shortError(err), ms: Date.now() - started });
    }
  }
  try {
    const status = await httpsProbe(host, port, timeoutMs);
    out.http = { ok: true, status };
  } catch (err) {
    out.http = { ok: false, error: shortError(err) };
  }
  return out;
}

/** 宿主进程的网络环境快照（判断是否被代理变量影响）。 */
export function processNetEnv() {
  const env = process.env ?? {};
  return {
    node: process.version,
    httpsProxy: env.HTTPS_PROXY || env.https_proxy || '',
    httpProxy: env.HTTP_PROXY || env.http_proxy || '',
    noProxy: env.NO_PROXY || env.no_proxy || '',
    useEnvProxy: env.NODE_USE_ENV_PROXY ?? '',
    platform: process.platform,
  };
}

/**
 * 自检一组目标：推送订阅里出现的主机 + Webhook 主机 + 三大推送服务（便于对照）。
 * @param {{endpoints?:string[], webhookUrl?:string, timeoutMs?:number}} opts
 */
export async function diagnoseNotify({ endpoints = [], webhookUrl = '', timeoutMs = 5000 } = {}) {
  const hosts = new Set(PUSH_SERVICE_HOSTS);
  for (const ep of endpoints) {
    try { hosts.add(new URL(String(ep)).hostname); } catch { /* 非法端点忽略 */ }
  }
  if (webhookUrl) {
    try { hosts.add(new URL(String(webhookUrl)).hostname); } catch { /* 同上 */ }
  }
  const results = [];
  for (const host of hosts) {
    // 本地 Webhook（127.0.0.1 等）不需要 TLS 探针，TCP 通了就够
    const isLocal = host === 'localhost' || /^127\./.test(host) || host === '::1';
    results.push(await probeHost(host, { port: isLocal ? 80 : 443, timeoutMs }));
  }
  return { env: processNetEnv(), results };
}
