// dsh-pocket 核心：Host/Origin 改写反向代理
//
// 为什么需要它：DSH 的 /api 浏览器信任栅栏只认 loopback（127.0.0.1）或
// `--trusted-host` 白名单（且官方禁了 0.0.0.0 绑定，防止把远程执行代码暴露给网络）。
// 本代理把入站请求的 Host / Origin 统一改写成 loopback 权威（127.0.0.1:3080），
// 转发给本机 dsh web——栅栏永远看到 loopback，于是：
//   - 局域网：手机直接访问 http://<电脑IP>:端口
//   - 公网：cloudflared 隧道指到本代理，任意域名都能进
// 都不需要改 dsh 的任何配置。
//
// 同步保证：普通请求与 WebSocket upgrade（/api/events.host 流式推送）都原样透传，
// 手机看到的界面与电脑完全一致、实时。

import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { createGzip, createBrotliCompress, constants as zlibConstants } from 'node:zlib';
import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { pwaAssetFor, PWA_PATHS, PUSH_SUB_TO_JSON_SRC } from './pwa-assets.mjs';
import { verifyRegistration, verifyAuthentication, makeRegistrationOptions, makeAuthenticationOptions } from './webauthn.mjs';

const DEFAULT_UPSTREAM = { host: '127.0.0.1', port: 3080 };

/**
 * 非安全上下文（http://<LAN-IP>:端口）里浏览器缺两个 API，由代理注入 polyfill
 * （只在缺少时生效，不覆盖原生实现）：
 *   1. crypto.randomUUID——DSH 连接层 mint RPC id 用，缺失直接抛错；
 *   2. AbortSignal.any（issue #53）——Android 厂商浏览器/WebView（Chrome < 116）
 *      无原生实现，DSH 连接层发送消息会调 AbortSignal.any([...])，缺失则消息发不出。
 * 带 data-dsh-pocket-polyfill 标记：注入判重用它，而不是搜索 "crypto.randomUUID"
 * 字样（dsh 页面源码里可能恰好出现该字符串，导致误判为已注入而跳过）。
 */
export const RANDOM_UUID_POLYFILL = `<script data-dsh-pocket-polyfill="1">!function(){try{if(self.crypto&&!self.crypto.randomUUID){self.crypto.randomUUID=function(){var b=new Uint8Array(16);self.crypto.getRandomValues(b);b[6]=b[6]&15|64;b[8]=b[8]&63|128;var h="";for(var i=0;i<16;i++){var x=b[i].toString(16);h+=(x.length<2?"0":"")+x;if(i===3||i===5||i===7||i===9)h+="-";}return h;}}}catch(e){}}();
!function(){try{if(self.AbortSignal&&!self.AbortSignal.any){self.AbortSignal.any=function(signals){var controller=new AbortController();var list=Array.from(signals||[]);var done=false;var handlers=list.map(function(signal){return function(){abort(signal);};});function cleanup(){for(var i=0;i<list.length;i++){try{list[i].removeEventListener('abort',handlers[i]);}catch(e){}}}function abort(signal){if(done)return;done=true;cleanup();try{controller.abort(signal.reason);}catch(e){controller.abort();}}for(var j=0;j<list.length;j++){var sig=list[j];if(sig.aborted){abort(sig);break;}sig.addEventListener('abort',handlers[j],{once:true});}return controller.signal;};}}catch(e){}}();
/* 注：曾用「全局 let location + Proxy」伪装 location.hostname 修 DSH isLoopback 判定
（issue #58：局域网访问模型设置页报 settings unavailable）——但 let location 全局
词法绑定会让任何恰好顶层声明 location 的脚本（DSH 插件经典 script）SyntaxError 崩溃，
导致会话列表不显示（实测 PAGEERROR: Identifier 'location' has already been declared）。
已回退；该问题属 DSH 客户端限制（location.hostname 是 unforgeable 属性）无法安全绕过。*/</script>`;

/**
 * issue #96：dsh 0.1.1-rc.2 起，`@deepseek-ai/dsh-client-connection` 的连接层改成
 *   const api = fixtureClient ?? transport?.createApiClient() ?? new WebApiClient()
 * 其中 transport = globalThis.__DSH_TRANSPORT__（由 DSH 宿主 web shell 注入，本仓库
 * 全程不创建、不引用这个全局）。桌面直连 127.0.0.1:3080 时宿主给的 transport 带
 * createApiClient；经本代理（局域网 / 隧道域名）访问时宿主给的 transport 不带该方法
 * → 手机上一执行就 TypeError: transport?.createApiClient is not a function，整页崩。
 *
 * 兜底策略：只在该方法缺失时补一个返回 null 的实现。null 会触发宿主自己那条
 * `?? new WebApiClient()` 兜底分支，等于让连接层回到旧版本（0.1.1-rc.2 之前）的
 * 行为。宿主自己有实现时一律不覆盖。
 *
 * 这是 stopgap 不是根治：真正的契约缺口在 DSH 宿主，需上游修复。
 */
export const TRANSPORT_API_CLIENT_SHIM = `<script data-dsh-pocket-transport-shim="1">!function(){try{var K='__DSH_TRANSPORT__',cur=globalThis[K];function patch(t){try{if(t&&typeof t==='object'&&typeof t.createApiClient!=='function'){try{Object.defineProperty(t,'createApiClient',{value:function(){return null;},writable:true,configurable:true});}catch(e){try{t.createApiClient=function(){return null;};}catch(e2){}}}}catch(e){}return t;}if(cur)patch(cur);Object.defineProperty(globalThis,K,{configurable:true,enumerable:true,get:function(){return cur;},set:function(t){cur=patch(t);}});}catch(e){}}();</script>`;

const INJECT_MARK = 'data-dsh-pocket-polyfill="1"';

/**
 * DSH Desktop（桌面版）渲染进程兼容补丁（issue #3/#4，已于 issue #76 停用）。
 *
 * 历史：旧版 dsh-plugin-desktop 的 client 在页面加载时从 URL query 读
 * `dsh-desktop-mode` 与 `dsh-desktop-platform`，缺失即抛
 * "invalid or missing dsh-desktop-mode null" → 页面崩（手机扫码访问桌面版时正是如此）。
 * 本脚本用 history.replaceState 补上这两个参数（无跳转、不重载），取最轻的
 * `compatibility` 模式——不激活桌面布局，避免与移动端适配叠加。
 *
 * @deprecated 不要再注入（issue #76，DSH Desktop 2.0.3 起）：
 *   ① mode 与 platform **同时缺失**时，parseDesktopClientEnvironment 直接返回 undefined
 *      （视作非桌面外壳，跳过全部桌面逻辑），正是手机/浏览器页面需要的效果；
 *   ② 只要 URL 上出现任一 dsh-desktop-* 标记，客户端就强制校验整组（material +
 *      semver version + mica），只补两个必然抛 "invalid or missing
 *      dsh-desktop-material" → 插件树加载失败 → 页面变成「打开恢复模式」；
 *   ③ 更糟：decideDesktopBrowserAccess 见到 dsh-desktop-* 前缀就把没有渲染器 token 的
 *      普通浏览器判为 denied（403），刷新后直接打不开。
 * lib/index.js 已不再注入本脚本；保留导出仅为兼容旧版本桌面端与既有测试。
 */
export function desktopEnvPatchScript(platform) {
  const p = ['darwin', 'win32', 'linux'].includes(platform) ? platform : 'linux';
  return `<script data-dsh-pocket-desktop-patch="1">!function(){try{var s=new URLSearchParams(location.search);if(!s.has('dsh-desktop-mode')||!s.has('dsh-desktop-platform')){s.set('dsh-desktop-mode','compatibility');s.set('dsh-desktop-platform','${p}');var u=new URL(location.href);u.search=s.toString();history.replaceState(null,'',u);}}catch(e){}}();</script>`;
}

/** 上游响应是否压缩过（压缩流不能做文本注入，会损坏页面）。 */
function isCompressed(headers) {
  return /(^|,\s*)(gzip|br|deflate)(\s*,|$)/i.test(String(headers['content-encoding'] ?? ''));
}

/**
 * 默认注入到经代理的 HTML 文档里：crypto.randomUUID / AbortSignal.any polyfill
 * （非安全上下文必需）+ issue #96 的 transport.createApiClient 兜底。
 */
export const DEFAULT_INJECT = RANDOM_UUID_POLYFILL + TRANSPORT_API_CLIENT_SHIM;

/**
 * DSH Desktop advanced 模式不支持的提示覆盖层（issue #19）。
 * advanced 组合会禁用网页版 ui-layout，而桌面 layout 只在 advanced client 提供——
 * 手机页面被注入 compatibility 后无任何 layout 服务 → 启动白屏（Failed to load plugins）。
 * 该脚本在页面上叠加一个固定警告层，让用户明确知道原因（而不是无解白屏）。
 */
export function advancedNoticeScript() {
  return `<script data-dsh-pocket-advanced-notice="1">!function(){try{var d=document.createElement('div');d.style.cssText='position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);color:#fff;font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:center;padding:24px';d.textContent='DSH 桌面端处于 advanced 模式，手机访问暂不支持。请在桌面端设置中切回 compatibility 模式后重启。| DSH Desktop is in advanced mode — phone access is not supported yet. Switch back to compatibility in the desktop app and restart.';document.documentElement.appendChild(d);}catch(e){}}();</script>`;
}

// ---------- 可选访问令牌认证（issue #13 + #33） ----------
// 只对受保护 Host（公网隧道 + 局域网按开关）强制。
// 登录成功后种 HttpOnly 持久 cookie（Max-Age 30 天）→ SPA 内部 API/WS 自动携带。
// 会话保持（issue #33）：cookie 值 = sha256(PIN:sessionKey)——sessionKey 是 dsh web
// 进程级随机密钥（lib/index.js 每次启动生成）。于是：
//   - 电脑 dsh web 一直开着 → 手机输一次密码后长期免输（持久 cookie）
//   - dsh web 重启/更新 → sessionKey 变化 → 旧 cookie 失效 → 手机重新输入
const TOKEN_COOKIE = 'dsh_pocket_token';
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 天（秒）

/** cookie 校验值：有 sessionKey 时派生，无则退化为 PIN 本身（向后兼容）。 */
function cookieFor(token, sessionKey) {
  if (!sessionKey) return token;
  return createHash('sha256').update(`${token}:${sessionKey}`).digest('hex');
}

// ---------- 登录速率限制（issue #40，改进版方案 A） ----------
// 8 位数字密码（10^8 组合）本身可接受，真正风险是「无限制重试」让穷举可行。
// 这里做三层防护（内存态，随进程生命周期，与 sessionKey 一致）：
//   1) 单 IP 滑动窗口：60 秒内失败 ≥5 次 → 锁 60 秒（429）
//   2) 全局滑动窗口：1 分钟全局失败 > 50 次 → 全局锁 30 秒（防分布式扫描换 IP 绕过）
//   3) 成功登录清空该 IP 计数
// IP 识别：优先 cf-connecting-ip（Cloudflare 在隧道入口设置的**真实**客户端 IP，
// 可信）；无则回退 socket remoteAddress。**不信任客户端 x-forwarded-for**（可伪造）。
export const DEFAULT_RATE_LIMIT = {
  windowMs: 60_000,      // 失败计数滑动窗口
  maxFailures: 5,        // 窗口内失败阈值 → 触发单 IP 锁
  lockMs: 60_000,        // 单 IP 锁定时长
  globalMaxFailures: 50, // 全局失败阈值（同窗口）→ 触发全局锁
  globalLockMs: 30_000,  // 全局锁定时长
};
function createRateLimiter(cfg = {}) {
  const c = { ...DEFAULT_RATE_LIMIT, ...cfg };
  const failCounts = new Map(); // ip -> { count, windowStart }
  const ipLocks = new Map();    // ip -> lockedUntil
  const global = { count: 0, windowStart: 0, lockedUntil: 0 };
  return {
    /** 该 IP 当前是否被锁；返回 { locked, retryAfter }。 */
    status(ip) {
      const now = Date.now();
      if (global.lockedUntil > now) return { locked: true, retryAfter: Math.ceil((global.lockedUntil - now) / 1000) };
      const until = ipLocks.get(ip) ?? 0;
      if (until > now) return { locked: true, retryAfter: Math.ceil((until - now) / 1000) };
      return { locked: false, retryAfter: 0 };
    },
    /** 记一次失败：维护滑动窗口计数，达阈值触发单 IP / 全局锁。 */
    record(ip) {
      const now = Date.now();
      let rec = failCounts.get(ip);
      if (!rec || now - rec.windowStart > c.windowMs) rec = { count: 0, windowStart: now };
      rec.count++;
      failCounts.set(ip, rec);
      if (now - global.windowStart > c.windowMs) { global.count = 0; global.windowStart = now; }
      global.count++;
      if (rec.count >= c.maxFailures) ipLocks.set(ip, now + c.lockMs);
      if (global.count >= c.globalMaxFailures) global.lockedUntil = now + c.globalLockMs;
      // 防内存膨胀：超过 2000 条记录时清掉已过窗口期的条目
      if (failCounts.size > 2000) {
        for (const [k, v] of failCounts) {
          if (now - v.windowStart > c.windowMs) failCounts.delete(k);
        }
      }
    },
    /** 成功登录：清空该 IP 计数与锁。 */
    clear(ip) {
      failCounts.delete(ip);
      ipLocks.delete(ip);
    },
  };
}
/**
 * 客户端真实 IP（限速与握手计数的身份键）：
 *   - 来自本机（cloudflared 隧道回连，源地址 loopback）→ 认 cf-connecting-ip（Cloudflare 边缘写的真实客户端 IP）；
 *   - 其余一律用 socket 源地址。
 *
 * 为什么不能无条件信任 cf-connecting-ip：那是**请求头**，能直连代理端口的人可以随手
 * 伪造。隧道流量必经本机 cloudflared（源地址必为 loopback），所以把它限定在 loopback
 * 来源既不影响隧道场景，又让「换头即换身份」的限速绕过失效。XFF 同理，始终不认。
 */
export function clientIp(req) {
  const addr = String(req.socket?.remoteAddress ?? '');
  if (classifySource(addr) === 'loopback') {
    const cf = String(req.headers['cf-connecting-ip'] ?? '').trim();
    if (cf) return cf;
  }
  return addr || 'unknown';
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

/**
 * 登录页：按访问来源显示提示（局域网 / 公网）；error: false|true|'locked'（locked 带剩余秒数）。
 * passkey=true 时额外渲染「用通行密钥登录」按钮（只在 named / ssh 固定域名通道、HTTPS 下出现）：
 * 通行密钥按 rpId（域名）隔离，随机域名/纯 IP 上注册了也留不住，所以宁可不显示按钮。
 * 按钮逻辑内联在页面里（页面本身是代理直出的，不依赖 /pocket-pwa.js）。
 *
 * 头部带 manifest / apple-touch-icon / theme-color（与已认证页面同一套）：
 * 未登录时从登录页「添加到主屏幕」也应该装出真正的 PWA，而不是普通书签。
 * 这三个资源都在免认证白名单里（PWA 静态资源先于 PIN 闸门），未登录也能取到；
 * 页面本身不含任何敏感信息，也不注册 Service Worker、不改登录流程。
 */
function loginPageHtml(error, isPublic, retryAfter = 0, { passkey = false, channel = null } = {}) {
  const where = isPublic ? '此公网地址' : '此局域网地址';
  const whereEn = isPublic ? 'This public address' : 'This LAN address';
  const errMsg = error === 'locked'
    ? `尝试次数过多，请 ${retryAfter} 秒后再试 | Too many attempts — try again in ${retryAfter}s`
    : error ? '密码错误，请重试 | Wrong PIN, try again' : '';
  const passkeyArea = passkey ? `
<button id="pk" type="button" style="display:none;margin-top:10px;background:#111827" data-channel="${String(channel ?? '')}">🔑 用通行密钥登录 | Sign in with a passkey</button>
<div class="err" id="pkerr" style="margin-top:8px"></div>` : '';
  const passkeyScript = passkey ? `
<script>
(function(){
  var btn=document.getElementById('pk'), out=document.getElementById('pkerr');
  function b64u(buf){var b=new Uint8Array(buf),s='';for(var i=0;i<b.length;i++)s+=String.fromCharCode(b[i]);return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');}
  function unb64u(v){var s=String(v||'').replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';var raw=atob(s),u=new Uint8Array(raw.length);for(var i=0;i<raw.length;i++)u[i]=raw.charCodeAt(i);return u;}
  function post(url,body){return fetch(url,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})}).then(function(r){return r.json().catch(function(){return null;}).then(function(j){if(!r.ok||(j&&j.error))throw new Error((j&&j.error)||('HTTP '+r.status));return j;});});}
  function fail(e){if(out)out.textContent=String((e&&e.message)||e);}
  if(!window.PublicKeyCredential||!navigator.credentials){return;}
  btn.style.display='block';
  btn.addEventListener('click',function(){
    out.textContent='';
    post('/pocket-passkey/login/begin',{}).then(function(opts){
      var pk={challenge:unb64u(opts.challenge),rpId:opts.rpId,timeout:opts.timeout,userVerification:opts.userVerification||'preferred',allowCredentials:(opts.allowCredentials||[]).map(function(c){return {type:c.type,id:unb64u(c.id),transports:c.transports};})};
      return navigator.credentials.get({publicKey:pk}).then(function(cred){
        if(!cred)throw new Error('已取消 | cancelled');
        var j=cred.toJSON();
        return post('/pocket-passkey/login/finish',{flowId:opts.flowId,id:j.id,rawId:j.rawId,type:j.type,response:j.response});
      });
    }).then(function(){location.replace('/?dsh-pocket-auth=1');}).catch(fail);
  });
})();
</script>` : '';
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="manifest" href="${PWA_PATHS.manifest}">
<link rel="apple-touch-icon" href="${PWA_PATHS.icon192}">
<meta name="theme-color" content="#101a2e">
<title>DSH Pocket · 访问验证</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px 24px;max-width:320px;width:calc(100% - 48px);text-align:center}
h1{font-size:16px;margin:0 0 4px;color:#111827}
p{font-size:13px;color:#6b7280;margin:0 0 16px}
input{width:100%;box-sizing:border-box;padding:10px 12px;font-size:18px;letter-spacing:6px;text-align:center;border:1px solid #d1d5db;border-radius:8px;outline:none;margin-bottom:12px}
input:focus{border-color:#4f6ef7}
button{width:100%;padding:10px;font-size:15px;background:#4f6ef7;color:#fff;border:none;border-radius:8px;cursor:pointer}
.err{color:#dc2626;font-size:12px;margin-bottom:10px;min-height:16px}
</style></head><body><div class="card">
<h1>🔐 DSH Pocket</h1>
<p>${where}受访问密码保护，请输入访问密码 | ${whereEn} is password-protected — enter the access PIN</p>
<div class="err">${errMsg}</div>
<form method="post" action="/pocket-login">
<input name="token" type="password" minlength="8" maxlength="64" autocomplete="one-time-code" autofocus required>
<button type="submit">进入 | Enter</button>
</form>${passkeyArea}
</div>${passkeyScript}</body></html>`;
}

/**
 * Host 信任边界分类（issue #66：fail closed）。
 *
 * 旧逻辑只认 `*.trycloudflare.com` 后缀为公网，其余一律当局域网——用户自建
 * 命名隧道/反向代理指向本机端口时，固定域名被误判成局域网；若局域网密码又
 * 关着，公网入口就无密码裸奔。现在反转为 fail closed：
 *   - loopback：localhost / 127.x / ::1 / 0.0.0.0（本机与 cloudflared 回连）
 *   - lan：RFC1918 私网 IPv4、CGNAT 100.64/10（RFC 6598，Tailscale/ZeroTier 默认网段，
 *     公网不可路由）、IPv6 ULA/link-local、`.local`（mDNS）、无点单标签名（NetBIOS 计算机名等）
 *   - public：其余一切 Host（trycloudflare 或任何陌生域名）→ 强制公网密码
 *
 * @returns {'loopback'|'lan'|'public'}
 */
// ---------- 公网子通道判定（quick / named / ssh，fail closed） ----------
// 三条公网通道各有自己的地址：
//   quick = 运行中的 cloudflared 快速隧道域名（每次重启都变，代理运行期才知道）
//   named = 设置里的固定域名（Cloudflare 命名隧道）
//   ssh   = 自有 VPS 的访问域名（accessHost，为空回退 sshHost）
// 判定只按 Host 的 hostname 精确匹配（去端口、去尾点、小写）——Host 头可伪造，所以
// 不匹配任何已配置固定地址的陌生公网 Host 一律 403（fail closed），绝不回落到共享 PIN：
// 否则同一入口换个 Host 就从设备/固定通道降级到 8 位 PIN（alternate-Host 降级）。

/**
 * 取 Host 的主机名部分（去端口、去尾点、小写；兼容 [::1]:3081）。
 * @param {string} host
 * @returns {string}
 */
export function hostNameOnly(host) {
  let name = String(host ?? '').trim().toLowerCase();
  if (name.startsWith('[')) {
    const end = name.indexOf(']');
    if (end >= 0) return name.slice(1, end);
  }
  return name.replace(/:\d+$/, '').replace(/\.$/, '');
}

/**
 * 公网 Host → 子通道（HTTP 与 WebSocket 共用同一条判定）。
 *
 * `channels.mode` 决定「当前生效的公网通道」：只有该通道的地址参与匹配，
 * 配置里残留的其它通道地址不会被误认（切通道后旧域名必须失效）。
 * 没给 mode 时退化为「任意已配置地址都能匹配」（纯函数测试/旧调用用）。
 *
 * @param {string} host 请求 Host（可带端口）
 * @param {{mode?:'quick'|'named'|'ssh', quick?:string, named?:string, ssh?:string}} [channels]
 * @returns {'quick'|'named'|'ssh'|null} null = 不匹配任何公网通道（调用方 fail closed）
 */
export function publicChannelForHost(host, channels = {}) {
  const name = hostNameOnly(host);
  if (!name) return null;
  const named = hostNameOnly(channels?.named);
  const ssh = hostNameOnly(channels?.ssh);
  const quick = hostNameOnly(channels?.quick);
  const mode = channels?.mode;
  if (mode === 'named') return named && name === named ? 'named' : null;
  if (mode === 'ssh') return ssh && name === ssh ? 'ssh' : null;
  if (mode === 'quick') return quick && name === quick ? 'quick' : null;
  if (named && name === named) return 'named';
  if (ssh && name === ssh) return 'ssh';
  if (quick && name === quick) return 'quick';
  return null;
}

/** 注入脚本路径（PWA / 推送 / 通行密钥的浏览器 API 都在这里，无依赖、免认证）。 */
export const POCKET_PWA_JS_PATH = '/pocket-pwa.js';

/** 通行密钥 HTTP 端点（冻结路径；注册需要已登录会话，登录不需要）。 */
export const PASSKEY_PATHS = Object.freeze({
  registerBegin: '/pocket-passkey/register/begin',
  registerFinish: '/pocket-passkey/register/finish',
  loginBegin: '/pocket-passkey/login/begin',
  loginFinish: '/pocket-passkey/login/finish',
});

/** Web Push 端点（subscribe 与 lib/pwa-assets.mjs 的 SW 约定同一个地址）。 */
export const PUSH_PATHS = Object.freeze({
  subscribe: PWA_PATHS.subscribe,
  unsubscribe: '/pocket-push-unsubscribe',
  vapid: '/pocket-push/vapid',
});

/** 设备 Cookie（长期凭据）：不是会话 cookie，所以 dsh web 重启后依然免 PIN。 */
export const DEVICE_COOKIE = 'pocket_device';
/** 180 天（契约值）：手机浏览器基本不会主动清。 */
export const DEVICE_COOKIE_MAX_AGE = 180 * 24 * 60 * 60;

/** 通行密钥/Push 端点的请求体上限（64KB：这些都是小 JSON）。 */
export const AUTH_BODY_MAX = 64 * 1024;
/** 端点级来源限速：30 次/分（沿用登录限速的思路，不信任 x-forwarded-for）。 */
export const AUTH_ENDPOINT_LIMIT = { max: 30, windowMs: 60_000 };
/** 挑战值（begin 生成的一次性记录）有效期：5 分钟，用完即焚。 */
export const PASSKEY_FLOW_TTL_MS = 5 * 60 * 1000;
/** 同时挂起的一次性流程上限（防止 begin 被刷爆内存）。 */
const PASSKEY_FLOW_MAX = 200;
/**
 * 可以原样回给客户端的错误码白名单（D-2）。
 *
 * 这些都是 lib/webauthn.mjs 抛出的**受控文案**（"挑战值不匹配" 之类），对排查有用且不含环境信息。
 * 白名单之外的异常（磁盘写失败、store 抛错……）一律只回固定文案：fs 异常里带绝对路径，
 * Windows 上还带用户名，回给客户端就是信息泄露。原文只进服务端日志。
 */
const PASSKEY_VERIFY_CODES = new Set([
  'ERR_CBOR', 'ERR_CLIENT_DATA', 'ERR_TYPE', 'ERR_CHALLENGE', 'ERR_ORIGIN', 'ERR_RPID',
  'ERR_FLAGS', 'ERR_ALG', 'ERR_ATTESTATION', 'ERR_CREDENTIAL', 'ERR_SIGNATURE', 'ERR_COUNTER',
]);

/** 转发协议判定：X-Forwarded-Proto 优先（VPS 上的 Caddy 会写），否则 https；本机回环用 http。 */
function forwardedProto(req) {
  const raw = String(req.headers?.['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase();
  return raw === 'https' || raw === 'http' ? raw : null;
}

/**
 * rpId / expectedOrigin 解析（两条公网通道共用）。
 *
 * rpId **只能**来自请求的 Host 头：它是通行密钥的作用域，用 policyHost() 会被改写成
 * 源 IP，而 IP 永远不能当 rpId（浏览器直接拒绝）。Host 在 begin/finish 两次请求之间
 * 可能被换掉，所以 finish 阶段必须复用 begin 时存下的 rpId/origin（见 passkeyFlow）。
 *
 * @returns {{host:string, rpId:string, origin:string, proto:string}}
 */
export function rpContextFromRequest(req) {
  const host = String(req?.headers?.host ?? '').trim() || 'localhost';
  const rpId = hostNameOnly(host) || 'localhost';
  const loopbackish = rpId === 'localhost' || rpId === '::1' || /^127\./.test(rpId);
  const proto = forwardedProto(req) ?? (loopbackish ? 'http' : 'https');
  return { host, rpId, origin: `${proto}://${host}`, proto };
}

/** 本机回环 / 有域名的 rpId 才能用于 WebAuthn（纯 IP 与单标签名一律拒绝）。 */
function rpIdUsable(rpId) {
  const id = String(rpId ?? '');
  if (!id) return false;
  if (id === 'localhost') return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(id)) return false; // IPv4：浏览器不允许
  if (id.includes(':')) return false;                   // IPv6：同上
  return id.includes('.');
}

/** 端点级来源限速（内存态，随进程生命周期；与登录限速同一套「按源地址」思路）。 */
function createSourceLimiter({ max = 30, windowMs = 60_000 } = {}) {
  const hits = new Map(); // ip → { count, start }
  return {
    /** 记一次请求；超限返回 false。 */
    allow(ip) {
      const now = Date.now();
      const rec = hits.get(ip);
      if (!rec || now - rec.start > windowMs) {
        hits.set(ip, { count: 1, start: now });
        return true;
      }
      rec.count += 1;
      if (hits.size > 2000) {
        for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
      }
      return rec.count <= max;
    },
  };
}

/** 小 JSON 响应（错误一律只回 { error }，不泄露内部细节）；extra 可带 set-cookie 等头。 */
function sendJson(res, status, body, extra = null) {
  // 已经发过响应就静默放弃（task-17）：重复 writeHead 会抛 ERR_HTTP_HEADERS_SENT，
  // 而这里的调用点几乎都在 http 事件回调里 —— 那个异常等于 uncaughtException，
  // 会直接把宿主进程带走。第一条响应已经到达客户端，第二条没有任何价值。
  if (res.headersSent) return;
  const text = JSON.stringify(body ?? {});
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(text)),
  };
  if (extra && typeof extra === 'object') {
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined || v === null) continue;
      headers[k.toLowerCase()] = k.toLowerCase() === 'set-cookie' && !Array.isArray(v) ? [v] : v;
    }
    // 带 set-cookie 时必须重新算 content-length 之外的语义：Node 接受数组形式的多条 cookie
    if (headers['set-cookie'] && !Array.isArray(headers['set-cookie'])) headers['set-cookie'] = [headers['set-cookie']];
  }
  res.writeHead(status, headers);
  res.end(text);
}

/**
 * 读一个上限 64KB 的 JSON 请求体。超限 → 413、非法 JSON → 400（已写响应），返回 null。
 *
 * 所有出口都必须是**幂等**的（task-17）：chunked body 会分多次触发 'data'，超限之后
 * 客户端还会把剩下的分块发完并触发 'end'；任何一条路径在响应之后再写一次
 * res.writeHead 都会抛 ERR_HTTP_HEADERS_SENT —— 抛在 http 回调里就是 uncaughtException，
 * 未认证请求即可打死宿主进程。所以这里用统一的 `done` 标记封住每一条出口。
 *
 * @returns {Promise<object|null>}
 */
function readJsonBody(req, res, max = AUTH_BODY_MAX) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    // 超限：回 413 并**排空**（丢弃）剩余请求体，而不是 destroy 连接——
    // destroy 会让客户端拿到 RST、丢掉的正是刚写出的 413（浏览器报网络错误，看不到原因）。
    // 先 finish 占住 done 再写响应：后续分块与 'end' 都进不来（否则第二个超限分块会二次 writeHead）。
    const reject413 = () => {
      if (done) return;
      finish(null);
      sendJson(res, 413, { error: '请求体过大 | request body too large' }, { connection: 'close' });
      req.resume?.();
    };
    const declared = Number(req.headers?.['content-length'] ?? 0);
    if (Number.isFinite(declared) && declared > max) {
      reject413();
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      if (done) return; // 已答复/已结束：不再累计、不再响应
      size += chunk.length;
      if (size > max) {
        reject413();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return; // 413 之后半截 body 不得再进解析/响应路径（task-17 的崩溃点）
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        finish({});
        return;
      }
      try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          finish(null);
          sendJson(res, 400, { error: '请求体必须是 JSON 对象 | body must be a JSON object' });
          return;
        }
        finish(parsed);
      } catch {
        finish(null);
        sendJson(res, 400, { error: '请求体不是合法 JSON | body is not valid JSON' });
      }
    });
    req.on('error', () => finish(null));
  });
}

/**
 * 注入脚本（免认证 GET /pocket-pwa.js）：注册 Service Worker + 暴露推送与通行密钥浏览器 API。
 *
 * 全部防御式：任何浏览器 API 缺失都只让对应能力返回 {ok:false}，绝不抛到页面。
 * 配置（是否允许通行密钥、当前设备是否已注册）由注入的 inline <script> 写进
 * window.__DSH_POCKET_CFG__，本文件本身保持静态可缓存。
 */
export const POCKET_PWA_JS = `/* dsh-pocket 注入脚本：PWA 安装 + Web Push + 通行密钥（无依赖） */
(function () {
  var cfg = (window.__DSH_POCKET_CFG__ || {});
  var SW_URL = '${PWA_PATHS.serviceWorker}';
  var err = function (code, message) { return { ok: false, error: { code: code, message: String(message || '') } }; };
  var installEvent = null;
  window.addEventListener('beforeinstallprompt', function (e) { installEvent = e; });

  function pushSupported() {
    try {
      return !!(window.PushManager && navigator.serviceWorker && window.Notification);
    } catch (e) { return false; }
  }
  function ready() { return navigator.serviceWorker.ready; }
  function b64uToBytes(v) {
    var s = String(v || '').split('-').join('+').split('_').join('/');
    while (s.length % 4) s += '=';
    var raw = atob(s), out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function bytesToB64u(buf) {
    var b = new Uint8Array(buf), s = '';
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).split('+').join('-').split('/').join('_').split('=').join('');
  }
${PUSH_SUB_TO_JSON_SRC}
  function post(url, body) {
    return fetch(url, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) {
        if (!r.ok || (j && j.error)) throw new Error((j && j.error) || ('HTTP ' + r.status));
        return j;
      });
    });
  }

  window.dshPocketPush = {
    supported: pushSupported,
    status: function () {
      return {
        supported: pushSupported(),
        permission: (window.Notification && Notification.permission) || 'default',
        config: cfg,
      };
    },
    subscribe: function () {
      if (!pushSupported()) return Promise.resolve(err('unsupported', '此浏览器不支持 Web Push | push not supported'));
      return ready().then(function (reg) {
        var perm = Notification.permission;
        var ask = perm === 'default' && typeof Notification.requestPermission === 'function'
          ? Notification.requestPermission() : Promise.resolve(perm);
        return Promise.resolve(ask).then(function (granted) {
          if (granted !== 'granted') throw new Error('通知权限被拒绝 | notification permission denied');
          return fetch('/pocket-push/vapid', { credentials: 'same-origin' }).then(function (r) {
            if (!r.ok) throw new Error('拿不到推送公钥 HTTP ' + r.status);
            return r.json();
          }).then(function (info) {
            return reg.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: b64uToBytes(info.publicKey),
            });
          }).then(function (sub) {
            // 不依赖 toJSON（Safari 各版本可用性不一）：手工构造 endpoint + getKey 密钥，
            // 否则 JSON.stringify(sub) 会是 {}，后端只能报「订阅缺少 endpoint」。
            var json = dshPushSubscriptionToJson(sub);
            if (!json || !json.endpoint) throw new Error('浏览器没有返回推送端点（请确认已允许通知） | no push endpoint');
            return post('${PWA_PATHS.subscribe}', { subscription: json });
          });
        });
      }).catch(function (e) { return err('subscribe-failed', (e && e.message) || e); });
    },
    unsubscribe: function () {
      if (!pushSupported()) return Promise.resolve(err('unsupported', '此浏览器不支持 Web Push | push not supported'));
      return ready().then(function (reg) {
        return reg.pushManager.getSubscription().then(function (sub) {
          if (!sub) return { ok: true, removed: false };
          var endpoint = sub.endpoint;
          return post('${PUSH_PATHS.unsubscribe}', { endpoint: endpoint }).then(function (r) {
            return sub.unsubscribe().catch(function () { return false; }).then(function () {
              return { ok: true, removed: true, backend: r };
            });
          });
        });
      }).catch(function (e) { return err('unsubscribe-failed', (e && e.message) || e); });
    },
    installPrompt: function () { return installEvent; },
  };

  window.dshPocketPasskey = {
    supported: function () {
      try { return !!(window.PublicKeyCredential && navigator.credentials && cfg.passkey === true); } catch (e) { return false; }
    },
    /** 已登录页面上注册一台新设备（需要 HTTPS + 固定域名通道）。 */
    register: function (name) {
      if (!window.dshPocketPasskey.supported()) {
        return Promise.resolve(err('unsupported', '通行密钥需要 HTTPS + 固定域名访问 | passkeys need HTTPS on a fixed domain'));
      }
      return post('${PASSKEY_PATHS.registerBegin}', {}).then(function (opts) {
        var pk = {
          challenge: b64uToBytes(opts.challenge),
          rp: opts.rp,
          user: { id: b64uToBytes(opts.user.id), name: opts.user.name, displayName: opts.user.displayName },
          pubKeyCredParams: opts.pubKeyCredParams,
          timeout: opts.timeout,
          attestation: opts.attestation,
          authenticatorSelection: opts.authenticatorSelection,
          excludeCredentials: (opts.excludeCredentials || []).map(function (c) {
            return { type: c.type, id: b64uToBytes(c.id), transports: c.transports };
          }),
        };
        return navigator.credentials.create({ publicKey: pk }).then(function (cred) {
          if (!cred) throw new Error('已取消 | cancelled');
          var j = cred.toJSON();
          return post('${PASSKEY_PATHS.registerFinish}', {
            flowId: opts.flowId, id: j.id, rawId: j.rawId, type: j.type, name: name || '', response: j.response,
          });
        });
      }).then(function (r) {
        return { ok: true, device: r && r.device };
      }).catch(function (e) { return err('register-failed', (e && e.message) || e); });
    },
  };

  // Service Worker：PWA 安装提示与推送都依赖它；注册失败不影响页面。
  try {
    if (navigator.serviceWorker) {
      navigator.serviceWorker.register(SW_URL, { scope: '/' }).catch(function () {});
    }
  } catch (e) { /* 不支持就跳过 */ }

  // PIN 登录成功后（已认证、但本设备还没注册通行密钥）→ 显示一个可关闭的注册入口。
  try {
    if (cfg.passkey === true && cfg.deviceKnown !== true) {
      var add = function () {
        if (document.getElementById('dsh-pocket-passkey-bar')) return;
        var bar = document.createElement('div');
        bar.id = 'dsh-pocket-passkey-bar';
        bar.setAttribute('style', 'position:fixed;left:12px;right:12px;bottom:12px;z-index:99998;display:flex;gap:8px;align-items:center;'
          + 'background:#111827;color:#f9fafb;padding:10px 12px;border-radius:10px;font:13px/1.5 system-ui;box-shadow:0 6px 20px rgba(0,0,0,.25)');
        var text = document.createElement('div');
        text.setAttribute('style', 'flex:1');
        text.textContent = '🔑 在此设备注册通行密钥，下次一键登录 | Register a passkey on this device';
        var go = document.createElement('button');
        go.type = 'button';
        go.textContent = '注册 | Register';
        go.setAttribute('style', 'background:#4f6ef7;color:#fff;border:0;border-radius:8px;padding:6px 10px;font:inherit;cursor:pointer');
        var close = document.createElement('button');
        close.type = 'button';
        close.textContent = '×';
        close.setAttribute('style', 'background:transparent;color:#9ca3af;border:0;font-size:18px;cursor:pointer;padding:0 4px');
        close.onclick = function () { bar.remove(); };
        go.onclick = function () {
          go.disabled = true;
          window.dshPocketPasskey.register('').then(function (r) {
            if (r && r.ok) { go.textContent = '已注册 | registered'; setTimeout(function () { bar.remove(); }, 1200); }
            else { go.disabled = false; text.textContent = ((r && r.error && r.error.message) || '注册失败'); }
          });
        };
        bar.appendChild(text); bar.appendChild(go); bar.appendChild(close);
        document.body.appendChild(bar);
      };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add);
      else add();
    }
  } catch (e) { /* 注入脚本异常绝不影响页面 */ }
})();
`;

/** PWA 静态资源路由（免认证白名单）：命中返回 {body, contentType, cacheControl}，否则 null。 */
function pwaAssetRoute(pathname) {
  const clean = String(pathname ?? '').split(/[?#]/)[0];
  if (clean === POCKET_PWA_JS_PATH) {
    return { body: POCKET_PWA_JS, contentType: 'text/javascript; charset=utf-8', cacheControl: 'no-store' };
  }
  return pwaAssetFor(clean); // manifest / service worker / 图标
}

/** 注入标记：判重用它，避免同一份 HTML 被注入两次。 */
const PWA_INJECT_MARK = 'data-dsh-pocket-pwa="1"';

/**
 * PWA / 通行密钥的 <head> 注入片段。
 * - manifest + apple-touch-icon：手机「添加到主屏幕」用；
 * - inline 配置：告诉注入脚本当前通道是否允许通行密钥、本设备是否已注册；
 * - /pocket-pwa.js：注册 Service Worker + 暴露推送/通行密钥 API。
 */
export function pwaInjectHtml({ passkey = false, deviceKnown = false, channel = null, push = true } = {}) {
  const cfg = JSON.stringify({
    passkey: passkey === true,
    deviceKnown: deviceKnown === true,
    channel: channel ?? null,
    push: push !== false,
  }).replace(/</g, '\\u003c');
  return `<link rel="manifest" href="${PWA_PATHS.manifest}">`
    + `<link rel="apple-touch-icon" href="${PWA_PATHS.icon192}">`
    + `<meta name="theme-color" content="#101a2e">`
    + `<script ${PWA_INJECT_MARK}>window.__DSH_POCKET_CFG__=${cfg};</script>`
    + `<script src="${POCKET_PWA_JS_PATH}" defer></script>`;
}

export function classifyHost(host) {
  let name = String(host ?? '').trim().toLowerCase();
  if (name.startsWith('[')) {
    const end = name.indexOf(']');
    if (end >= 0) name = name.slice(1, end); // [::1]:3081 → ::1
  } else {
    name = name.replace(/:\d+$/, ''); // hostname:3081 / 127.0.0.1:3081 → 去掉端口
  }
  if (name === 'localhost' || name === '0.0.0.0' || name === '::1' || /^127\./.test(name)) return 'loopback';
  // RFC1918 私网 + CGNAT 100.64/10（RFC 6598，Tailscale/ZeroTier 默认网段，公网不可路由）
  if (/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1(?:0\d|1\d|2[0-7]))\.)/.test(name)) return 'lan';
  if (/^(?:fe80:|f[cd][0-9a-f]{2}:)/.test(name) && name.includes(':')) return 'lan'; // IPv6 link-local / ULA
  if (name === '' || name.includes(':')) return 'loopback'; // 裸 IPv6 / 无 Host → 当本机
  if (name.endsWith('.local') || !name.includes('.')) return 'lan'; // mDNS / NetBIOS 单标签名
  return 'public';
}

/** 该 Host 是否受访问密码保护（公网一律要密码；局域网/本机按设置页开关）。 */
function isProtectedHost(host, isProtected) {
  return isProtected ? isProtected(host) : classifyHost(host) === 'public';
}

/** 保护强度序：本机最弱（可免密）→ 局域网（按开关）→ 公网（永远要密码）。 */
const HOST_CLASS_RANK = { loopback: 0, lan: 1, public: 2 };

/**
 * 按 TCP 源地址给出来源类别（issue #90）。
 * 与 classifyHost 的区别在**兜底方向**：Host 头里认不出的形态按 loopback 处理
 * （历史行为，避免裸 IPv6 之类把本机访问判成公网）；而源地址认不出时必须按
 * public 处理——源地址是我们唯一不可伪造的信息，兜底方向错了整条防线就白搭。
 * @returns {'loopback'|'lan'|'public'|null} null 表示拿不到源地址（不做任何收紧）
 */
export function classifySource(addr) {
  let a = String(addr ?? '').trim().toLowerCase();
  if (!a) return null;
  if (a.startsWith('::ffff:')) a = a.slice(7); // IPv4-mapped IPv6（Node 双栈监听时常见）
  if (a === '::1' || /^127\./.test(a)) return 'loopback';
  // RFC1918 私网 + CGNAT 100.64/10（与 classifyHost 保持同一套网段判定）
  if (/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1(?:0\d|1\d|2[0-7]))\.)/.test(a)) return 'lan';
  if (/^169\.254\./.test(a)) return 'lan';            // IPv4 link-local
  if (/^(?:fe80:|f[cd][0-9a-f]{2}:)/.test(a)) return 'lan'; // IPv6 link-local / ULA
  return 'public';
}

/**
 * 用于策略判定的 Host（issue #90 第 7 条）。
 *
 * Host 头完全由客户端控制：能直连代理端口的人只要写 `Host: 127.0.0.1:3081`
 * 就会被 classifyHost 判成本机，从而绕过局域网开关和局域网密码——用户若按
 * README 关掉了局域网密码，这就是一条零认证通道。TCP 源地址无法伪造，用它给
 * Host 声明设一个下限。
 *
 * **只收紧、绝不放松**：经 cloudflared 隧道进来的公网请求源地址正是 127.0.0.1，
 * 若按源地址覆盖就会把公网访问降级成本机免密，比原来的问题更严重。所以仅当
 * 声明的保护级别**低于**来源真实级别时，才改用源地址参与判定。
 */
export function policyHost(req, host) {
  const actual = classifySource(req?.socket?.remoteAddress);
  if (!actual) return host;
  const claimed = classifyHost(host);
  if (HOST_CLASS_RANK[actual] <= HOST_CLASS_RANK[claimed]) return host;
  // 用真实源地址替代被伪造的 Host 参与后续全部策略判定（密码归属、局域网开关、
  // 局域网地址覆盖），保证各处判定看到的是同一个来源。
  let addr = String(req.socket.remoteAddress);
  if (addr.toLowerCase().startsWith('::ffff:')) addr = addr.slice(7);
  return addr;
}

/**
 * 该 Host 是否 loopback（本机 / cloudflared 回环）。
 * 「关闭局域网」只拦截经局域网 IP/主机名访问的请求，loopback 与公网（trycloudflare）放行：
 *   - cloudflared 隧道以 `http://127.0.0.1:<port>` 回连本机代理，必须放行；
 *   - 电脑自己访问 127.0.0.1/localhost 也应放行（仅当用户手动浏览本代理时）。
 */
function isLoopbackHost(host) {
  let name = String(host ?? '').trim().toLowerCase();
  if (name.startsWith('[')) {
    const end = name.indexOf(']');
    if (end >= 0) name = name.slice(1, end); // [::1]:port → ::1
  } else {
    name = name.replace(/:\d+$/, ''); // hostname:port / 127.0.0.1:port → 去掉端口
  }
  return name === 'localhost' || name === '127.0.0.1' || name === '::1' || name === '0.0.0.0';
}

/** 局域网访问已关闭时的提示页（浏览器导航时显示；API/WS 返回 403 JSON/拒绝握手）。 */
function lanDisabledPageHtml() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Pocket · 局域网访问已关闭</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px 24px;max-width:360px;width:calc(100% - 48px);text-align:center}
h1{font-size:16px;margin:0 0 8px;color:#111827}
p{font-size:13px;color:#6b7280;margin:0;line-height:1.6}
</style></head><body><div class="card">
<h1>🔒 DSH Pocket</h1>
<p>局域网访问已关闭，扫码/链接均不可用。<br>请在电脑上重新开启后再试。<br><br>LAN access is disabled — the QR code and link are unavailable.<br>Re-enable it on the computer to continue.</p>
</div></body></html>`;
}

/** 桌面端浏览器访问门禁提示页（issue #81）：DSH Desktop 未开启「浏览器访问」时，
 * 上游 desktop-browser-access 门禁对普通浏览器（含经本代理转发的手机）返回 403
 * `forbidden`，且本代理无法携带 Electron renderer secret 绕过。对符合该特征的
 * 浏览器导航请求返回此可操作提示页；API/WS 与其余 403 原样透传。 */
function desktopAccessBlockedPageHtml() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Pocket · 桌面端未开启浏览器访问</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px 24px;max-width:392px;width:calc(100% - 48px);text-align:center}
h1{font-size:16px;margin:0 0 8px;color:#111827}
p{font-size:13px;color:#6b7280;margin:0 0 12px;line-height:1.6}
code{background:#f3f4f6;padding:2px 6px;border-radius:6px;font-size:12px;color:#374151}
.step{text-align:left;background:#f9fafb;border:1px solid #eef2f7;border-radius:10px;padding:12px 14px;margin-top:8px;font-size:12px;color:#4b5563;line-height:1.8}
</style></head><body><div class="card">
<h1>🖥️ DSH Pocket</h1>
<p>你已通过访问密码，但页面仍被拦截。<br>因为本机 DSH Desktop 未开启「浏览器访问」，桌面门禁拒绝了普通浏览器（含手机）的页面请求。</p>
<div class="step">
<strong>解决方法（任选其一）：</strong><br>
1. DSH Desktop → 设置 → 窗口 / 模式 → 开启「浏览器访问」（自动切到 compatibility 模式）→ <strong>重启 DSH Desktop</strong>。<br>
2. 或在配置文件中设置：<br>
<code>dsh-desktop: { mode: compatibility, openBrowser: true }</code><br>
然后重启 DSH Desktop，再刷新本页。
</div>
<p style="margin-top:14px">注意：访问密码登录成功 ≠ 已获得桌面 Web 访问授权。门禁由 DSH Desktop 控制，pocket 无法代为绕过。</p>
<p style="color:#9ca3af">The host DSH Desktop has "browser access" disabled. Enable it (Settings → window/mode → browser access → restart), or set <code>dsh-desktop.mode: compatibility, openBrowser: true</code>, then refresh.</p>
</div></body></html>`;
}

/** 请求是否期望 HTML（浏览器导航 → 返回登录页；API/WS → 401）。 */
function isHtmlRequest(req) {
  const accept = String(req.headers.accept ?? '');
  if (accept.includes('text/html')) return true;
  const url = String(req.url ?? '');
  // 按 pathname 判断，别用 `url === '/'` 严格比 —— 根路径常带 query
  // （`/?dsh-pocket-auth=1`、`/?dsh-pocket-retry=1`、`/?token=…`），
  // 那些同样是浏览器导航，漏判会让它们拿到 401/303 而不是该给的页面。
  let pathname = url;
  try { pathname = new URL(url || '/', 'http://dsh.invalid').pathname; } catch { /* 用原值兜底 */ }
  return pathname === '/' || /\.html?$/i.test(pathname);
}

/**
 * 常量时间的密码比较（issue #90）：普通 `===` 会在首个不同字节处提前返回，
 * 理论上可被计时侧信道逐字节还原 PIN。长度不同直接判否（PIN 长度固定，
 * 长度本身不是秘密），等长则走 timingSafeEqual。
 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * 安全解析请求目标（宿主退出防护）。
 *
 * Node 的 HTTP 解析器接受 absolute-form 请求行（`GET http://host/path HTTP/1.1`），
 * 但**不校验**其中的 URL 是否合法：`GET http://[ HTTP/1.1` 会原样落进 `req.url`
 * （实测 Node 22/24 均如此）。此时 `new URL(req.url, base)` 抛 TypeError
 * （ERR_INVALID_URL）——而本文件几乎全部调用点都在 http 事件回调里，抛出去就是
 * uncaughtException；dsh 宿主的 fail-loud 处理器会直接 `process.exit(1)`
 * （见 @deepseek-ai/dsh-app-boot 的 installFailLoud）。
 * 结论：**一个未认证请求就能打死整个 DSH**，所以凡是拿 req.url 做 URL 解析的地方
 * 一律经过这里。
 * @param {unknown} reqUrl 原始请求目标
 * @returns {URL|null} 解析失败返回 null，调用方按「无 query token / 400 收口」处理
 */
export function parseRequestTarget(reqUrl) {
  try {
    return new URL(String(reqUrl ?? '/'), 'http://dsh.invalid');
  } catch {
    return null;
  }
}

/**
 * 请求是否携带 `?token=` —— 用于区分「一次密码尝试」与「普通未认证访问」（issue #90）。
 * 只有前者计入限速失败：普通未认证访问（无 cookie 无 token）本来就该看到登录页，
 * 若也计数，正常用户第一次打开页面就会把自己锁死（子资源还会放大）。
 * cookie 不匹配同样不计数——cookie 值是 sha256(PIN:sessionKey)，攻击者不知道
 * 进程级 sessionKey，这条通道本身不可穷举；而 dsh web 重启后旧 cookie 必然失配，
 * 计数只会误锁老用户。
 */
function hasQueryToken(req) {
  return parseRequestTarget(req.url)?.searchParams.get('token') != null;
}

/** 校验请求是否已认证。返回 { ok, rawQueryToken }：
 *  - ok=true：已认证；rawQueryToken 是 URL `?token=<PIN>` 命中的那条原始密码（用于种 cookie）；
 *  - 已有 cookie 命中 → rawQueryToken=null（不要重复种）。 */
function authCheck(req, tokens, sessionKey) {
  const list = (Array.isArray(tokens) ? tokens : tokens ? [tokens] : []).filter(Boolean);
  if (list.length === 0) return { ok: true, rawQueryToken: null };
  const cookies = parseCookies(req.headers.cookie);
  const cookieTok = cookies[TOKEN_COOKIE];
  if (cookieTok) {
    for (const token of list) {
      if (safeEqual(cookieTok, cookieFor(token, sessionKey))) return { ok: true, rawQueryToken: null };
    }
  }
  // 畸形请求目标在这里就被上层 400 拦掉了（见 handleHttpRequest 顶部）；这里再兜一层，
  // 拿不到 URL 就当「没有 ?token=」处理（fail closed：继续走 PIN 闸门，绝不放行）。
  const qTok = parseRequestTarget(req.url)?.searchParams.get('token') ?? null;
  if (qTok) {
    // URL `?token=<原始 PIN>` 用于分享/扫码直达：用户拿到 URL 就能直输明文 PIN，
    // 不需要把 sha256 哈希也告诉他们。匹配上后由调用方通过 maybeSeedAuthCookie
    // 种 HttpOnly 哈希 cookie，让浏览器后续子资源（assets/*.js 等）也走 cookie
    // 路径——避免「主页 200 但子资源 401」白屏（issue #35）。
    for (const token of list) {
      if (safeEqual(qTok, token)) return { ok: true, rawQueryToken: qTok };
    }
  }
  return { ok: false, rawQueryToken: null };
}

/** 当请求通过 `?token=<原始 PIN>` 进入且尚无 cookie 时，在响应里种 HttpOnly cookie。
 *  monkey-patch res.writeHead 把 set-cookie 头注入到第一个响应里——同 POST /pocket-login
 *  路径（lib/proxy.mjs 显式 res.writeHead 加 set-cookie）效果一致。 */
function maybeSeedAuthCookie(req, res, rawToken, sessionKey) {
  if (!rawToken || !sessionKey) return;
  if (parseCookies(req.headers.cookie)[TOKEN_COOKIE]) return; // 已有 cookie 就不重复种
  const expected = cookieFor(rawToken, sessionKey);
  if (!expected) return;
  const origWriteHead = res.writeHead.bind(res);
  res.writeHead = function (statusCode, headers) {
    const h = { ...(headers ?? {}) };
    const cookie = `${TOKEN_COOKIE}=${expected}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`;
    // 已有 set-cookie 头（数组/字符串都支持）则追加
    const prev = h['set-cookie'];
    if (Array.isArray(prev)) h['set-cookie'] = [...prev, cookie];
    else if (typeof prev === 'string') h['set-cookie'] = [prev, cookie];
    else h['set-cookie'] = cookie;
    return origWriteHead(statusCode, h);
  };
}

/**
 * 把浏览器可见的权威改写成 loopback 权威。
 * 除 Host/Origin 外，还必须规范化 Referer 与 Sec-Fetch-Site：DSH 宿主的特权方法
 * 栅栏（settings.describe/credentials.* 等 PRIVILEGED_METHODS）会拒绝
 * sec-fetch-site === 'cross-site'，并校验 Origin 与 Host 匹配；远程访问的这两个头
 * 若不改写，设置/凭据平面会在宿主侧被 403（issue #58 的另一半）。
 * 统一小写化键名，避免 Node 原样转发时大小写键并存导致重复头。
 */
function loopbackAuthority(headers, upstream) {
  const authority = `${upstream.host}:${upstream.port}`;
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (lk === 'host' || lk === 'origin' || lk === 'referer' || lk === 'sec-fetch-site') continue;
    out[lk] = v;
  }
  out.host = authority;
  out.origin = `http://${authority}`;
  const referer = headers.referer ?? headers.Referer;
  if (referer) {
    try {
      const ref = new URL(referer);
      ref.protocol = 'http:';
      ref.host = authority;
      out.referer = ref.toString();
    } catch {
      out.referer = `http://${authority}/`;
    }
  }
  out['sec-fetch-site'] = 'same-origin';
  return out;
}

// ---------- dsh web 浏览器会话 token（issue #77） ----------
// 新版 dsh web（>= 0.1.2-alpha.1）给浏览器会话加了启动 token：根路径 `GET /` 必须带一次
// `?token=<启动 token>` 换一个绑定 authority 的 cookie，之后 /api 与 WebSocket 才放行；
// 否则一律 401（"dsh web authentication required"）。手机扫码进来的 URL 天然没有这个
// token，所以代理要在转发时补一次。
//
// 只在 `GET /` 且请求还没带 dsh-auth-* cookie 时注入：上游拿到 token 会 303 回干净的根
// 路径，若每次都注入就会 303 循环（浏览器很快报"重定向次数过多"）。
const DSH_AUTH_COOKIE = 'dsh-auth-';
/**
 * 去掉 URL 上所有 `dsh-desktop-*` query 参数（issue #75）。
 *
 * dsh-pocket 在 ≤ 2.1.1 会用 `history.replaceState` 往页面 URL 上写
 * `dsh-desktop-mode=compatibility` 和 `dsh-desktop-platform=<系统>`
 * （desktopEnvPatchScript，已在 2.1.2 删除）。副作用是：用户当时收藏/保存过
 * 的那个地址**一直带着这两个参数**。升级之后我们不再注入了，但用户打开旧
 * 收藏时 URL 里仍然有 —— 上游 `decideDesktopBrowserAccess` 只要见到
 * `dsh-desktop-` 前缀就认定是渲染器请求，普通浏览器没有渲染器 token，直接
 * 403 forbidden。表现就是「我已经升到最新版了，还是 forbidden」。
 *
 * 脏参数是我们写进去的，就得由我们清掉。所有方法、所有路径都清理（不只是
 * `GET /`）——API 与 WebSocket 握手带上这些参数同样会被拦。
 *
 * @param {string} reqUrl - 原始请求路径（含 query）。
 * @returns {string} 清理后的路径；无该前缀参数或解析失败时原样返回。
 */
export function stripDesktopMarkers(reqUrl) {
  let u;
  try {
    u = new URL(reqUrl ?? '/', 'http://dsh.invalid');
  } catch {
    return reqUrl;
  }
  const doomed = [...u.searchParams.keys()].filter((k) => k.startsWith('dsh-desktop-'));
  if (doomed.length === 0) return reqUrl;
  for (const key of doomed) u.searchParams.delete(key);
  return `${u.pathname}${u.search}`;
}

export function upstreamPathWithLaunchToken(reqUrl, method, cookieHeader, launchToken) {
  if (method !== 'GET') return reqUrl;
  let u;
  try { u = new URL(reqUrl ?? '/', 'http://dsh.invalid'); } catch { return reqUrl; }
  if (u.pathname !== '/') return reqUrl;
  // 登录成功后跳回的 `/?dsh-pocket-auth=1`：强制重做一次握手（旧 cookie 可能已过期/被撤销）
  const force = u.searchParams.has('dsh-pocket-auth');
  if (!force && String(cookieHeader ?? '').includes(DSH_AUTH_COOKIE)) return reqUrl;
  if (!launchToken) return reqUrl;
  u.searchParams.set('token', launchToken);
  return `${u.pathname}${u.search}`;
}

// ---------- 会话握手重试计数（issue #91） ----------
// Safari（iOS/macOS）不持久化「http:// + 纯 IP 源」上由 3xx 响应下发的 cookie，
// 于是 dsh web 的 launch-token→cookie 握手永远收敛不了：代理每次 `GET /`
// 都补 `?token=`，上游每次 303 回 `/`，浏览器每次都不带 cookie → 无限重定向
// （Safari 报「发生了太多重定位」）。
//
// 两道防线：
//   1) 代理把这次 303 改写成 200 过渡页（Set-Cookie 照发 + meta refresh 跳回 `/`），
//      200 响应上的 cookie 不会被 Safari 的重定向 cookie 策略丢掉；
//   2) 万一 1) 也不管用，用下面的计数器在若干次尝试后停止注入 token 并给出
//      可操作提示页——宁可给用户一句人话，也不要无限转圈。
//
// 只按客户端 IP 计数（无需 cookie 支持，正适合「cookie 用不了」的这个场景）。
export const DEFAULT_HANDSHAKE_LIMIT = 3;
export const HANDSHAKE_WINDOW_MS = 60_000;
/** 提示页「重试」按钮用的查询参数：命中即清空该 IP 的失败计数，且不往上游透传。 */
export const HANDSHAKE_RETRY_PARAM = 'dsh-pocket-retry';

/** 摘掉某个查询参数后重新拼路径；解析失败或本来就没有则原样返回。 */
export function stripQueryParam(reqUrl, name) {
  let u;
  try { u = new URL(reqUrl ?? '/', 'http://dsh.invalid'); } catch { return reqUrl; }
  if (!u.searchParams.has(name)) return reqUrl;
  u.searchParams.delete(name);
  return `${u.pathname}${u.search}`;
}

export function createHandshakeTracker({ max = DEFAULT_HANDSHAKE_LIMIT, windowMs = HANDSHAKE_WINDOW_MS } = {}) {
  /** ip -> { count, start } */
  const hits = new Map();
  return {
    /** 记一次握手注入，返回窗口内的累计次数。 */
    record(ip, now = Date.now()) {
      const rec = hits.get(ip);
      if (!rec || now - rec.start > windowMs) {
        hits.set(ip, { count: 1, start: now });
        return 1;
      }
      rec.count += 1;
      return rec.count;
    },
    /** 握手成功（拿到会话 cookie 的请求）→ 清零。 */
    clear(ip) {
      hits.delete(ip);
    },
    /** 该 IP 是否已达重试上限。 */
    exhausted(ip) {
      const rec = hits.get(ip);
      return !!rec && rec.count >= max;
    },
    /** 清理过期条目，防长期运行内存膨胀。 */
    prune(now = Date.now()) {
      for (const [ip, rec] of hits) {
        if (now - rec.start > windowMs) hits.delete(ip);
      }
    },
  };
}

/** 握手过渡页：200 + Set-Cookie（由调用方带上）+ meta refresh 跳回干净根路径。 */
export function handshakePageHtml() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="0; url=/">
<title>DSH Pocket · 正在进入 | opening…</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
p{font-size:13px;color:#6b7280;margin:0}
</style></head><body><p>正在进入… | opening…</p></body></html>`;
}

/** 握手反复失败时的提示页（issue #91）：说清原因并给出可操作的规避办法。 */
export function handshakeBlockedPageHtml() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Pocket · 无法完成登录握手</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:24px 22px;max-width:380px;width:calc(100% - 40px)}
h1{font-size:15px;margin:0 0 10px;color:#111827}
p{font-size:13px;color:#6b7280;margin:0 0 10px;line-height:1.7}
code{background:#f3f4f6;padding:1px 5px;border-radius:4px;font-size:12px}
a{color:#4f6ef7}
</style></head><body><div class="card">
<h1>🔁 无法完成登录握手</h1>
<p>浏览器没有保存 DSH 下发的会话 cookie，代理反复重试后仍未成功，因此停在这里而不是无限跳转。</p>
<p><strong>Safari（iOS/macOS）</strong> 在 <code>http://</code> 纯 IP 地址上不会保存这类 cookie，局域网入口因此进不去。</p>
<p>可以试试：<br>
① 换 Chromium 系浏览器（Chrome / Edge）打开局域网地址；<br>
② 改用<strong>公网入口</strong>（设置页开启公网访问，拿到 <code>https://…trycloudflare.com</code> 地址）——HTTPS 域名上 Safari 正常。</p>
<p style="margin-top:14px"><a href="/?${HANDSHAKE_RETRY_PARAM}=1" style="display:inline-block;padding:8px 14px;background:#4f6ef7;color:#fff;border-radius:8px;text-decoration:none;font-size:13px">重试一次 | Retry</a></p>
<p style="color:#9ca3af;font-size:12px">Browser did not keep the session cookie, so the login handshake could not complete (issue #91). Safari over plain <code>http://</code> + IP is the known case — try Chrome, or use the public HTTPS entry.</p>
</div></body></html>`;
}

// ---------- WebSocket 心跳注入（PR #41，issue #29） ----------
// DSH 客户端与宿主的 WebSocket downlink 都不发 ping/pong（客户端只读流、
// 宿主只推帧），空闲连接会被路由器 NAT 空闲超时或手机系统省电机制**静默**
// 丢弃：没有 FIN/RST，浏览器收不到 close 事件，dsh-client-connection 也就
// 永远不会重连——手机页面看起来还开着，实则实时通道已死（消息不同步、
// 点击会话卡在加载）。
//
// 代理在每个透传的 WS 连接上定期向浏览器侧发送协议层 Ping（0x89 0x00，
// server→client 不掩码）：
//   - 浏览器网络栈按 RFC 6455 自动回 Pong（不经过任何 JS），一来一回让
//     双向都有流量，NAT/防火墙空闲超时不再触发；
//   - 连续 missLimit 个周期没有任何入站字节（浏览器已死或链路被静默丢弃）
//     → 主动 destroy 连接：浏览器拿到 close 后 dsh-client-connection 会
//     按指数退避自动重连，实时通道随即恢复。
// 只 Ping 浏览器侧：上游是本机 loopback，不会过期；浏览器回的 Pong 原样
// 透传给上游 ws 服务（未请求的 Pong 对 ws 库无害，只触发无害的 pong 事件）。
const WS_PING_FRAME = Buffer.from([0x89, 0x00]); // FIN + opcode 9、长度 0、不掩码

/**
 * 在透传的浏览器侧 socket 上挂载心跳：定期 Ping 保活 + 静默断链检测。
 * 任一路由方向只要有字节流动（Pong 响应）就把静默计数归零；连续 missLimit
 * 个周期零入站流量则判定链路已死，销毁 socket 触发浏览器端重连。
 * @param {import('node:net').Socket} socket 浏览器侧的透传 socket
 * @param {{intervalMs?:number, missLimit?:number}} [opts] 心跳周期与容忍的静默周期数
 */
function attachWebSocketHeartbeat(socket, { intervalMs = 30_000, missLimit = 2 } = {}) {
  let misses = 0;
  let stopped = false;
  const onInbound = () => { misses = 0; };
  const timer = setInterval(() => {
    if (stopped) return;
    misses += 1;
    if (misses >= missLimit) {
      // 连续多个周期没有任何入站流量（连 Pong 都没有）→ 静默断链，断开让客户端重连
      socket.destroy();
      return;
    }
    // write 到已销毁的 socket 会抛错（destroy 竞态），写前检查并兜底
    if (!socket.destroyed) {
      try { socket.write(WS_PING_FRAME); } catch { /* 忽略 */ }
    }
  }, intervalMs);
  timer.unref?.();
  socket.on('data', onInbound);
  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    socket.off('data', onInbound);
    socket.off('close', cleanup);
    socket.off('error', cleanup);
  };
  socket.on('close', cleanup);
  socket.on('error', cleanup);
}

/**
 * 启动 dsh-pocket 代理。
 * @param {object} opts
 * @param {number} [opts.port]      监听端口（默认 3081；dsh web 保持 3080）
 * @param {string} [opts.host]      监听地址（默认 0.0.0.0：LAN 与隧道都能到）
 * @param {{host:string,port:number}} [opts.upstream] 上游 dsh web（默认 127.0.0.1:3080）
 * @param {string} [opts.injectHtml] 注入 HTML 的内容（默认 polyfill + 移动端适配；传 '' 关闭）
 * @param {object} [opts.auth]       可选访问令牌认证（issue #13）：{ getToken, getAltTokens?, isProtected, sessionKey }
 *   - getToken(host) → 主 PIN（公网/局域网各一个，按 host 分类）
 *   - getAltTokens?(host) → 替代令牌列表（可选），校验时与主 PIN 任一命中即放行
 * @param {object|false} [opts.rateLimit] 登录速率限制参数覆盖（issue #40；测试用短窗口）
 * @param {object|false} [opts.heartbeat] WebSocket 心跳注入（PR #41）：{ intervalMs, missLimit }；false 关闭（默认开：30s/容忍 2 个静默周期）
 * @param {() => boolean} [opts.lanAccessEnabled] 局域网访问是否开启（默认开启）。关闭时拦截经局域网 Host 的请求（公网/loopback 不受影响）。
 * @param {() => ({mode?:string, quick?:string, named?:string, ssh?:string})} [opts.getPublicChannels]
 *   公网子通道地址（第三通道 + 命名/快速隧道）。**不传时完全保持原有语义**（未知公网 Host → PIN 闸门）；
 *   传入且当前模式有已知固定地址时，不匹配的公网 Host 一律 403 fail closed（HTTP 与 WS 共用判定）。
 * @param {object} [opts.passkeyStore] createPasskeyStore() 的实例（通行密钥凭据 + 设备令牌）
 * @param {() => boolean} [opts.getPasskeyEnabled] 通行密钥总开关（settings.passkeyEnabled）
 * @param {object} [opts.pushStore] createPushStore() 的实例（推送订阅 + VAPID 密钥）
 * @returns {Promise<{server:import('node:http').Server, close:()=>Promise<void>}>}
 */
export function createPocketProxy({ port = 3081, host = '0.0.0.0', upstream = DEFAULT_UPSTREAM, log = null, injectHtml = DEFAULT_INJECT, auth = null, rateLimit = null, heartbeat = {}, lanAccessEnabled = () => true, launchToken = () => '', handshakeLimit, getPublicChannels = null, passkeyStore = null, getPasskeyEnabled = null, pushStore = null } = {}) {
  const limiter = auth ? createRateLimiter(rateLimit ?? {}) : null;
  /** 通行密钥/推送端点的来源限速（30 次/分；与登录限速互相独立）。 */
  const authLimiter = createSourceLimiter(AUTH_ENDPOINT_LIMIT);
  // 会话握手重试计数（issue #91）：Safari 在 http://IP 源上丢 3xx 的 cookie → 死循环
  const handshake = createHandshakeTracker(
    typeof handshakeLimit === 'number' ? { max: handshakeLimit } : {},
  );
  const sessionKey = auth?.sessionKey ?? null;
  /** 公网通道地址（宿主注入；未注入时返回 null = 保持旧的 PIN 闸门语义）。 */
  const readPublicChannels = () => {
    if (typeof getPublicChannels !== 'function') return null;
    try {
      const c = getPublicChannels();
      return c && typeof c === 'object' && !Array.isArray(c) ? c : null;
    } catch {
      return null;
    }
  };
  /** 当前模式是否有「已知固定地址」：有才启用 403 fail closed（Quick 未启动时不知道地址，不能拦）。 */
  const pinnedMode = (channels) => {
    const mode = channels?.mode === 'named' || channels?.mode === 'ssh' || channels?.mode === 'quick' ? channels.mode : null;
    if (!mode) return null;
    const address = mode === 'named' ? channels.named : mode === 'ssh' ? channels.ssh : channels.quick;
    return String(address ?? '').trim() ? mode : null;
  };
  /** 403 日志节流：同一 Host 每分钟最多记一条，扫描器刷不出日志。 */
  const guardLogged = new Map();
  function logUnknownPublicHost(name) {
    const now = Date.now();
    if ((guardLogged.get(name) ?? 0) > now - 60_000) return;
    guardLogged.set(name, now);
    if (guardLogged.size > 200) {
      for (const [h, t] of guardLogged) if (t < now - 60_000) guardLogged.delete(h);
    }
    log?.(`dsh-pocket: 公网 Host 不属于当前通道，已按 fail closed 拒绝（403）: ${name}`);
  }
  const passkeyOn = () => {
    try {
      return typeof getPasskeyEnabled === 'function' && getPasskeyEnabled() === true;
    } catch {
      return false;
    }
  };
  /** 只有固定域名的通道（named / ssh）才谈得上通行密钥：rpId 跟着域名走，Quick 每次换域名会失效。 */
  const fixedChannel = (channel) => (channel === 'named' || channel === 'ssh' ? channel : null);
  const pathnameOf = (url) => {
    try {
      return new URL(String(url ?? '/'), 'http://dsh.invalid').pathname;
    } catch {
      return String(url ?? '/').split(/[?#]/)[0] || '/';
    }
  };
  /** 一次性挑战流水（begin → finish）：单次使用、5 分钟过期、容量有上限。 */
  const flows = new Map();
  function putFlow(record) {
    const now = Date.now();
    for (const [id, rec] of flows) if (rec.expiresAt <= now) flows.delete(id);
    while (flows.size >= PASSKEY_FLOW_MAX) {
      const oldest = flows.keys().next().value;
      flows.delete(oldest);
    }
    const flowId = randomBytes(16).toString('base64url');
    flows.set(flowId, { ...record, expiresAt: now + PASSKEY_FLOW_TTL_MS });
    return flowId;
  }
  /** 取出并删除（单次使用）；不存在/过期/用途不符返回 null。 */
  function takeFlow(flowId, purpose) {
    const id = typeof flowId === 'string' ? flowId.trim() : '';
    if (!id) return null;
    const rec = flows.get(id);
    if (!rec) return null;
    flows.delete(id); // 无论后续校验成败都作废：挑战值绝不能二次使用
    if (rec.expiresAt <= Date.now() || rec.purpose !== purpose) return null;
    return rec;
  }
  const deviceTokenOf = (req) => parseCookies(req?.headers?.cookie)[DEVICE_COOKIE] ?? '';
  /**
   * 设备 Cookie 快路径（免 PIN）：只在固定域名通道（named / ssh）+ passkey 开关打开时生效。
   * 令牌校验每次都读磁盘（lib/passkey-store.mjs 的 verifyDeviceToken），撤销立即生效。
   */
  function tryDeviceAuth(req, channel) {
    if (!fixedChannel(channel)) return null;
    if (!passkeyOn() || !passkeyStore || typeof passkeyStore.verifyDeviceToken !== 'function') return null;
    const token = deviceTokenOf(req);
    if (!token) return null;
    try {
      return passkeyStore.verifyDeviceToken(token) ?? null;
    } catch {
      return null;
    }
  }
  /** 当前 Host 对应的会话 cookie 值（PIN 登录成功 / 通行密钥登录成功共用）。 */
  function sessionCookieFor(hostValue) {
    const pin = auth?.getToken?.(hostValue) ?? null;
    if (!pin) return '';
    return `${TOKEN_COOKIE}=${cookieFor(pin, sessionKey)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`;
  }
  /**
   * 长期设备 cookie（HttpOnly + SameSite=Lax + 180 天 + **无条件 Secure**）。
   *
   * 为什么不再看 proto：这是一枚 180 天的长期凭据，而它只在固定域名通道（named / ssh，
   * 必然 HTTPS）里才被 tryDeviceAuth 认账。无条件加 Secure 之后，哪怕 X-Forwarded-Proto
   * 缺失/被写错，也不可能下发一枚可被明文 HTTP 截获的长期凭据（D-1 的另一半）。
   */
  function deviceCookieFor(token) {
    return `${DEVICE_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${DEVICE_COOKIE_MAX_AGE}; Secure`;
  }
  /** 端点统一的限速 + 方法校验（返回 false 表示已回响应）。 */
  function endpointAllowed(req, res) {
    const ip = clientIp(req);
    if (!authLimiter.allow(ip)) {
      sendJson(res, 429, { error: '请求过于频繁，请稍后再试 | too many requests' });
      return false;
    }
    return true;
  }
  /**
   * 注册通行密钥（POST /pocket-passkey/register/begin|finish）。
   * 需要已认证会话（本函数在 PIN/设备闸门之后调用）；rpId/origin 复用 begin 时存下的值，
   * 防止两次请求之间 Host 被换掉（Host 头可伪造）。
   */
  async function handlePasskeyRegister(req, res, { host: hostValue, path, channel }) {
    if (!endpointAllowed(req, res)) return;
    if (!passkeyOn() || !passkeyStore) {
      sendJson(res, 400, { error: '通行密钥未启用 | passkeys are disabled' });
      return;
    }
    if (!channel) {
      sendJson(res, 400, { error: '通行密钥只在固定域名通道（固定域名 / 自有服务器）可用；局域网 IP 与随机域名不支持 | passkeys require a fixed-domain channel' });
      return;
    }
    const ctx = rpContextFromRequest(req);
    // 安全上下文门槛（D-1）：WebAuthn 只允许在安全上下文里创建凭据。判定必须走
    // rpContextFromRequest（Host + X-Forwarded-Proto），**绝不能**用 TCP 源地址 ——
    // 经 cloudflared / Caddy 进来的请求源地址永远是 127.0.0.1，按源地址放行
    // 等于给所有隧道流量开一条 http 后门。localhost 也不开例外：本机 Host 的
    // passkeyChannel 本来就是 null，会在上面的通道判定被挡掉，例外只会是死代码。
    if (ctx.proto !== 'https') {
      sendJson(res, 400, { error: '通行密钥只能在 HTTPS 安全上下文中注册（当前是明文 HTTP） | passkeys can only be created in a secure context (HTTPS)' });
      return;
    }
    if (!rpIdUsable(ctx.rpId)) {
      sendJson(res, 400, { error: '当前地址不能用作通行密钥作用域（需要域名 + HTTPS） | this host cannot scope a passkey (need a domain over HTTPS)' });
      return;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return;
    try {
      if (path === PASSKEY_PATHS.registerBegin) {
        const challenge = randomBytes(32).toString('base64url');
        const excludeCredentials = passkeyStore.list().map((d) => ({ id: d.id, type: 'public-key' }));
        const options = makeRegistrationOptions({
          rpId: ctx.rpId,
          rpName: 'DSH Pocket',
          userId: `dsh-pocket:${ctx.rpId}`,
          userName: 'dsh-pocket',
          challenge,
          excludeCredentials,
          timeoutMs: 60_000,
        });
        const flowId = putFlow({ challenge, rpId: ctx.rpId, origin: ctx.origin, purpose: 'register' });
        sendJson(res, 200, { flowId, ...options });
        return;
      }
      // finish
      const flow = takeFlow(body.flowId, 'register');
      if (!flow) {
        sendJson(res, 400, { error: '注册流程已过期或不存在，请重新发起 | registration flow expired — start again' });
        return;
      }
      const response = body.response && typeof body.response === 'object' ? body.response : {};
      const verified = verifyRegistration({
        clientDataJSON: response.clientDataJSON,
        attestationObject: response.attestationObject,
        expectedChallenge: flow.challenge,
        expectedOrigin: flow.origin, // begin 时的 origin，不用当前 Host 重新推导
        rpId: flow.rpId,
        transports: body.transports ?? [],
      });
      const name = typeof body.name === 'string' ? body.name : '';
      const entry = passkeyStore.addCredential({
        credentialId: verified.credentialId,
        publicKeyJwk: verified.publicKeyJwk,
        name,
        aaguid: verified.aaguid,
        transports: verified.transports,
        signCount: verified.signCount,
      });
      const issued = passkeyStore.issueDeviceToken({ deviceId: verified.credentialId, name: entry.name });
      sendJson(res, 200, {
        ok: true,
        device: { id: entry.id, name: entry.name, createdAt: entry.createdAt, lastLoginAt: entry.lastLoginAt },
      }, { 'set-cookie': deviceCookieFor(issued.token) });
    } catch (err) {
      respondVerifyError(res, err, 'registration');
    }
  }
  /**
   * 通行密钥登录（POST /pocket-passkey/login/begin|finish）：**无需任何会话**，
   * 成功了才种会话/设备 cookie（这就是「手机不用等电脑批准」的路径）。
   *
   * 与 register / WS upgrade 一致的 fail closed（P6.3）：受保护 Host 但宿主拿不到 PIN 时
   * 一律 401。登录端点本身免会话是设计使然，但「这个 Host 本该有 PIN 却没有」是接线/配置
   * 故障，不能因为登录免会话就继续下发挑战值 —— 否则三条入口里只有 login 漏着。
   */
  async function handlePasskeyLogin(req, res, { host: hostValue, path, channel }) {
    if (!endpointAllowed(req, res)) return;
    // 与另外两条入口同一条判定（HTTP 闸门 L1625、WS upgrade L1980），复用同一套函数，不另起一套。
    if (auth) {
      const protectedHost = isProtectedHost(hostValue, auth.isProtected);
      const token = protectedHost ? (auth.getToken?.(hostValue) ?? null) : null;
      if (protectedHost && !token) {
        log?.(`dsh-pocket: protected host ${hostNameOnly(hostValue)} has no PIN configured — refusing passkey login (fail closed)`);
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
    }
    if (!passkeyOn() || !passkeyStore) {
      sendJson(res, 400, { error: '通行密钥未启用 | passkeys are disabled' });
      return;
    }
    if (!channel) {
      sendJson(res, 400, { error: '通行密钥只在固定域名通道（固定域名 / 自有服务器）可用 | passkeys require a fixed-domain channel' });
      return;
    }
    const ctx = rpContextFromRequest(req);
    // P8.1：登录**故意不设 https 门槛**（register 有），这不是遗漏：
    //   1) 非安全上下文里浏览器根本不暴露 PublicKeyCredential，http 上跑不起真正的登录 ceremony；
    //   2) 设备 cookie 现在无条件带 Secure（deviceCookieFor），http 上即使手工构造出一次 finish
    //      也留不下可复用的凭据；
    //   3) 凭据与 rpId 的绑定发生在注册时（register 已强制 https），登录只是复用已有凭据。
    // 再补一道门槛只会多一个分支，不增加实际安全性。
    if (!rpIdUsable(ctx.rpId)) {
      sendJson(res, 400, { error: '当前地址不能用作通行密钥作用域（需要域名 + HTTPS） | this host cannot scope a passkey' });
      return;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return;
    try {
      if (path === PASSKEY_PATHS.loginBegin) {
        const challenge = randomBytes(32).toString('base64url');
        // allowCredentials 留空：支持手机上的可发现凭据（不用先输用户名）
        const options = makeAuthenticationOptions({ rpId: ctx.rpId, challenge, allowCredentials: [] });
        const flowId = putFlow({ challenge, rpId: ctx.rpId, origin: ctx.origin, purpose: 'login' });
        sendJson(res, 200, { flowId, ...options });
        return;
      }
      // finish
      const flow = takeFlow(body.flowId, 'login');
      if (!flow) {
        sendJson(res, 400, { error: '登录流程已过期或不存在，请重新发起 | login flow expired — start again' });
        return;
      }
      const credentialId = typeof body.id === 'string' ? body.id.trim() : String(body.rawId ?? '').trim();
      const credential = credentialId ? passkeyStore.findCredential(credentialId) : null;
      if (!credential) {
        // 未注册/已撤销的设备 → 401：前端回落到 PIN 页面
        sendJson(res, 401, { error: '这台设备没有注册通行密钥（可能已被撤销） | unknown credential — fall back to the PIN' });
        return;
      }
      const response = body.response && typeof body.response === 'object' ? body.response : {};
      const verified = verifyAuthentication({
        authenticatorData: response.authenticatorData,
        clientDataJSON: response.clientDataJSON,
        signature: response.signature,
        expectedChallenge: flow.challenge,
        expectedOrigin: flow.origin,
        rpId: flow.rpId,
        publicKeyJwk: credential.publicKeyJwk,
        previousSignCount: credential.signCount,
        requireCounter: true,
      });
      passkeyStore.touchCredential(credential.id, { signCount: verified.newSignCount });
      const issued = passkeyStore.issueDeviceToken({ deviceId: credential.id, name: credential.name });
      const cookies = [deviceCookieFor(issued.token)];
      const session = sessionCookieFor(hostValue);
      if (session) cookies.push(session); // 会话 cookie 与 PIN 登录同值：浏览器后续子资源/WS 直接放行
      sendJson(res, 200, {
        ok: true,
        device: { id: credential.id, name: credential.name, createdAt: credential.createdAt, lastLoginAt: Date.now() },
      }, { 'set-cookie': cookies });
    } catch (err) {
      respondVerifyError(res, err, 'login');
    }
  }
  /**
   * 通行密钥端点的异常出口。
   *
   * 白名单内的校验类错误 → 400 + 受控文案 + code（前端能显示「挑战值不匹配」这类可操作提示）；
   * 白名单外的任何异常（典型：passkeys.json 写失败）→ 400 + 固定文案 + code:'INTERNAL'，
   * 真实 err.message 只写服务端日志（D-2：fs 异常里带绝对路径与用户名，不能回给客户端）。
   */
  function respondVerifyError(res, err, what) {
    const code = err?.code ?? null;
    const message = err?.message ?? String(err);
    log?.(`dsh-pocket: passkey ${what} failed (${code ?? 'unknown'}): ${message}`);
    if (typeof code === 'string' && PASSKEY_VERIFY_CODES.has(code)) {
      sendJson(res, 400, { error: message, code });
      return;
    }
    sendJson(res, 400, { error: '通行密钥操作失败，请稍后重试 | passkey operation failed — please retry', code: 'INTERNAL' });
  }
  /** 已认证的推送订阅端点（GET /pocket-push/vapid、POST subscribe/unsubscribe）。 */
  async function handlePushEndpoint(req, res, { path }) {
    if (!endpointAllowed(req, res)) return;
    if (!pushStore) {
      sendJson(res, 400, { error: '推送未启用 | push is unavailable' });
      return;
    }
    try {
      if (path === PUSH_PATHS.vapid) {
        sendJson(res, 200, { publicKey: pushStore.publicKey() });
        return;
      }
      const body = await readJsonBody(req, res);
      if (body === null) return;
      if (path === PUSH_PATHS.subscribe) {
        const sub = body.subscription && typeof body.subscription === 'object' ? body.subscription : body;
        const ua = String(req.headers['user-agent'] ?? '');
        const saved = pushStore.add(sub, { ua });
        sendJson(res, 200, { ok: true, count: saved.count, endpoint: saved.endpoint });
        return;
      }
      // unsubscribe
      const endpoint = String(
        body.endpoint ?? body.subscription?.endpoint ?? '',
      ).trim();
      if (!endpoint) {
        sendJson(res, 400, { error: '缺少 endpoint | missing endpoint' });
        return;
      }
      const removed = pushStore.remove(endpoint);
      sendJson(res, 200, { ok: true, removed, count: pushStore.count() });
    } catch (err) {
      log?.(`dsh-pocket: push endpoint ${path} failed: ${err?.message ?? err}`);
      sendJson(res, 400, { error: err?.message ?? String(err) });
    }
  }
  /**
   * HTTP 请求处理体（宿主退出防护）。
   *
   * 这个函数是**同步**执行的，任何逃逸异常都会变成 uncaughtException，而 dsh 宿主的
   * fail-loud 处理器（@deepseek-ai/dsh-app-boot 的 installFailLoud）会直接
   * `process.exit(1)` —— 一个请求即可打死整个 DSH。所以：
   *   1) 顶部先把无法解析的请求目标 400 收口（Node 允许 `GET http://[` 这类
   *      absolute-form，但不校验合法性）；
   *   2) 外层 createServer 再套一层 try/catch 兜底，任何意外抛错只回 500。
   */
  function handleHttpRequest(req, res) {
    // 畸形请求目标：解析失败一律 400 收口，绝不继续往下传——下游任何一处
    // `new URL(req.url)` 抛错都会打死宿主。
    if (!parseRequestTarget(req.url)) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
      res.end('dsh-pocket: bad request target');
      return;
    }
    // 策略判定一律用 policyHost（issue #90）：Host 头可伪造，用不可伪造的 TCP 源地址
    // 给它设下限。转发给上游的 Host 由 loopbackAuthority 单独改写，不受这里影响。
    const host = policyHost(req, String(req.headers.host ?? ''));
    const isPublic = classifyHost(host) === 'public';
    // 公网子通道判定（第三通道 + 命名/快速隧道）：只有宿主注入了 getPublicChannels 才收紧，
    // 且当前模式必须有「已知固定地址」。不匹配的陌生公网 Host → 403 fail closed，
    // 绝不回落到共享 PIN（否则换个 Host 就降级到 8 位 PIN）。
    const channels = readPublicChannels();
    const pinned = pinnedMode(channels);
    const publicChannel = isPublic ? publicChannelForHost(host, channels ?? {}) : null;
    if (isPublic && pinned && publicChannel === null) {
      logUnknownPublicHost(hostNameOnly(host));
      sendJson(res, 403, {
        error: 'unknown-public-host',
        message: '此地址不是当前启用的公网入口 | this host is not the active public entry',
      });
      return;
    }
    /** 可用通行密钥的通道（只有固定域名的 named / ssh）；null = 该入口不提供通行密钥。 */
    const passkeyChannel = fixedChannel(publicChannel);
    /** 已验证的设备（设备 Cookie 快路径命中时填；用于页面注入「已注册」状态）。 */
    let deviceInfo = null;
    // 局域网访问关闭（issue #54）：拦截经局域网 IP/主机名访问的请求；
    // 公网（含任意非内网 Host——issue #66 fail closed）与 loopback（本机/cloudflared 回连）放行，
    // 公网流量随后照常走访问密码认证。
    if (!isPublic && !isLoopbackHost(host) && !lanAccessEnabled()) {
      if (isHtmlRequest(req)) {
        res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(lanDisabledPageHtml());
      } else {
        res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end('{"error":"lan-disabled"}');
      }
      return;
    }
    // 免认证白名单（GET/HEAD，只有 PWA 静态资源：manifest / service worker / 图标 / 注入脚本）。
    // 必须排在 PIN 闸门之前：SW 与 manifest 的子资源请求若拿到 401 或重定向到登录页，PWA 直接失效。
    if (req.method === 'GET' || req.method === 'HEAD') {
      const asset = pwaAssetRoute(pathnameOf(req.url));
      if (asset) {
        const body = asset.body;
        const length = typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : body.length;
        const headers = {
          'content-type': asset.contentType,
          'cache-control': asset.cacheControl,
          'content-length': String(length),
          'x-content-type-options': 'nosniff',
        };
        // SW 脚本不在根路径时，声明允许的 scope（规范要求；现代浏览器对同目录 scope 本已放行）
        if (pathnameOf(req.url) === PWA_PATHS.serviceWorker) headers['service-worker-allowed'] = '/';
        res.writeHead(200, headers);
        if (req.method === 'HEAD') res.end();
        else res.end(body);
        return;
      }
    }
    // 通行密钥登录端点（无需会话）：必须在 PIN 闸门之前，否则「免 PIN 一键登录」无从谈起。
    // 只允许固定域名通道 + HTTPS；成功后由处理函数种会话/设备 cookie。
    if (req.method === 'POST') {
      const path = pathnameOf(req.url);
      if (path === PASSKEY_PATHS.loginBegin || path === PASSKEY_PATHS.loginFinish) {
        void handlePasskeyLogin(req, res, { host, path, channel: passkeyChannel }).catch((err) => {
          log?.(`dsh-pocket: passkey login crashed: ${err?.message ?? err}`);
          if (!res.headersSent) sendJson(res, 500, { error: '内部错误 | internal error' });
        });
        return;
      }
    }
    // 访问令牌认证（issue #13 + #18 + #33 + #40 + #69）：局域网与公网按开关/来源要求密码
    // 登录页的可选入口：只有固定域名通道 + 通行密钥开关都满足时才显示「用通行密钥登录」
    const loginOpts = { passkey: passkeyOn() && Boolean(passkeyChannel), channel: passkeyChannel };
    if (auth) {
      const protectedHost = isProtectedHost(host, auth.isProtected);
      const token = protectedHost ? (auth.getToken?.(host) ?? null) : null;
      // 临时 PIN（issue #69）：按 host 同源分发（公网临时 PIN 只在公网入口放行，局域网同理）
      const altTokens = protectedHost && token && typeof auth.getAltTokens === 'function' ? (auth.getAltTokens(host) ?? []) : [];
      const acceptedTokens = token ? [token, ...altTokens] : [];
      // 受保护 Host 但宿主没给出任何 PIN（token 为空）：fail closed（D-3）。
      // 旧写法 `if (protectedHost && token && !deviceInfo)` 在 token 为空时把整段认证闸门
      // 跳过去，而 authCheck 在 token 列表为空时返回 ok —— 那就是一个零认证入口。
      // 生产接线永远有非空 PIN，这里是防「宿主实现变化 / 注入空 auth 对象」的形状问题；
      // 连设备 Cookie 快路径也不放行，保持「未配置 PIN 时该 Host 不可访问」的语义。
      if (protectedHost && !token) {
        log?.(`dsh-pocket: protected host ${hostNameOnly(host)} has no PIN configured — refusing (fail closed)`);
        res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end('{"error":"unauthorized"}');
        return;
      }
      // 设备 Cookie 快路径（免 PIN）：已注册设备在固定域名通道直接放行（撤销立即生效）。
      deviceInfo = protectedHost ? tryDeviceAuth(req, publicChannel) : null;
      if (protectedHost && !deviceInfo) {
        const ip = clientIp(req);
        // 登录提交：速率限制（issue #40）→ 校验密码 → 种持久 HttpOnly cookie（30 天，绑定进程会话密钥）→ 回首页
        if (req.method === 'POST' && req.url?.startsWith('/pocket-login')) {
          const rl = limiter?.status(ip) ?? { locked: false, retryAfter: 0 };
          if (rl.locked) {
              res.writeHead(429, {
                'content-type': 'text/html; charset=utf-8',
                'cache-control': 'no-store',
                'retry-after': String(rl.retryAfter),
              });
              res.end(loginPageHtml('locked', isPublic, rl.retryAfter, loginOpts));
            return;
          }
          let body = '';
          let bodyAborted = false;
          req.on('data', (c) => {
            if (bodyAborted) return; // 已判定超长：不再累计
            body += c;
            // 登录表单只有几十字节：超过 1KB 直接断连（不做流式排空，这里不需要 413 文案）
            if (body.length > 1024) {
              bodyAborted = true;
              req.destroy();
            }
          });
          req.on('end', () => {
            // destroy() 之后仍可能收到 'end'：不能再进响应路径，也不能二次 writeHead
            // ——「先答复/先断连、再继续处理」是 task-17 的同类形状，一并加固。
            if (bodyAborted || res.headersSent) return;
            // 请求体读取期间其他并发请求可能已触发锁定，比较密码前必须再次检查。
            // 否则攻击者可预先挂起大量 POST，再同时结束请求体，批量穿透限速。
            const finalRl = limiter?.status(ip) ?? { locked: false, retryAfter: 0 };
            if (finalRl.locked) {
              res.writeHead(429, {
                'content-type': 'text/html; charset=utf-8',
                'cache-control': 'no-store',
                'retry-after': String(finalRl.retryAfter),
              });
              res.end(loginPageHtml('locked', isPublic, finalRl.retryAfter, loginOpts));
              return;
            }
            const submitted = String(new URLSearchParams(body).get('token') ?? '');
            // 与 cookie / ?token= 两条通道保持一致：常量时间比较 + 主 PIN 与替代令牌
            // （临时 PIN，issue #69 钩子）任一命中即放行。原先这里是 `submitted === token`
            // ——既会提前返回（计时侧信道可逐字节还原 PIN），又把替代令牌挡在门外。
            const matched = acceptedTokens.find((candidate) => safeEqual(submitted, candidate));
            if (matched !== undefined) {
              limiter?.clear(ip);
              res.writeHead(302, {
                // 带上 dsh-pocket-auth=1：登录成功后强制重做一次浏览器会话握手，
                // 换掉可能已过期/被撤销的 dsh web 会话 cookie（issue #77）
                location: '/?dsh-pocket-auth=1',
                'set-cookie': `${TOKEN_COOKIE}=${cookieFor(matched, sessionKey)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`,
                'cache-control': 'no-store',
              });
              res.end();
            } else {
              limiter?.record(ip);
              log?.(`dsh-pocket: login failed from ${ip} | 登录失败 IP: ${ip}`);
              res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
              res.end(loginPageHtml(true, isPublic, 0, loginOpts));
            }
          });
          return;
        }
        // `?token=<PIN>` 是与 POST 登录等价的一次密码尝试（issue #90）：此前只有 POST
        // 分支调用 limiter.record()，这条通道既不计数也不受锁定约束，等于给攻击者留了
        // 一个可全速穷举 8 位 PIN 的旁路。下面把它并入同一套限速。
        const isGuess = hasQueryToken(req);
        if (isGuess) {
          const rl = limiter?.status(ip) ?? { locked: false, retryAfter: 0 };
          // 锁定期内直接拒绝、不做比对——否则锁定窗口本身就是免费的穷举窗口。
          // 正确密码也一并拒绝，与 POST 登录的锁定语义保持一致。
          if (rl.locked) {
            if (isHtmlRequest(req)) {
              res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
              res.end(loginPageHtml('locked', isPublic, rl.retryAfter, loginOpts));
            } else {
              res.writeHead(429, {
                'content-type': 'application/json',
                'cache-control': 'no-store',
                'retry-after': String(rl.retryAfter),
              });
              res.end('{"error":"too-many-attempts"}');
            }
            return;
          }
        }
        const authResult = authCheck(req, acceptedTokens, sessionKey);
        if (!authResult.ok) {
          if (isGuess) {
            limiter?.record(ip);
            log?.(`dsh-pocket: bad ?token= from ${ip} | URL 密码错误 IP: ${ip}`);
          }
          if (isHtmlRequest(req)) {
            // 锁定期间打开登录页也给提示（HTTP 200 + 锁定文案；429 语义留给 POST 拒绝）
            const rl = limiter?.status(ip) ?? { locked: false, retryAfter: 0 };
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(loginPageHtml(rl.locked ? 'locked' : false, isPublic, rl.retryAfter, loginOpts));
          } else {
            res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            res.end('{"error":"unauthorized"}');
          }
          return;
        }
        // ?token=<原始 PIN> 直达时种 HttpOnly cookie，让浏览器后续子资源也走 cookie 路径（issue #35）
        if (authResult.rawQueryToken) {
          limiter?.clear(ip); // 与 POST 登录成功一致：正确的分享链接不该逐步累积到锁定
          maybeSeedAuthCookie(req, res, authResult.rawQueryToken, sessionKey);
        }
      }
    }
    // 已认证后的浏览器端点（通行密钥注册 + 推送订阅）：只回 JSON，不转发上游。
    // 走到这里说明已经过了 PIN 闸门（或设备 Cookie 快路径）——注册必须已有 PIN 会话。
    {
      const path = pathnameOf(req.url);
      if (req.method === 'POST' && (path === PASSKEY_PATHS.registerBegin || path === PASSKEY_PATHS.registerFinish)) {
        void handlePasskeyRegister(req, res, { host, path, channel: passkeyChannel }).catch((err) => {
          log?.(`dsh-pocket: passkey register crashed: ${err?.message ?? err}`);
          if (!res.headersSent) sendJson(res, 500, { error: '内部错误 | internal error' });
        });
        return;
      }
      if ((req.method === 'POST' && (path === PUSH_PATHS.subscribe || path === PUSH_PATHS.unsubscribe))
        || (req.method === 'GET' && path === PUSH_PATHS.vapid)) {
        void handlePushEndpoint(req, res, { path }).catch((err) => {
          log?.(`dsh-pocket: push endpoint crashed: ${err?.message ?? err}`);
          if (!res.headersSent) sendJson(res, 500, { error: '内部错误 | internal error' });
        });
        return;
      }
    }
    const headers = loopbackAuthority({ ...req.headers }, upstream);
    // HTML 文档一律向上游要未压缩正文：浏览器都会带 accept-encoding: gzip/br，而上游一旦压缩，
    // 下面的注入分支（!isCompressed 守卫）就会被跳过 —— 真实浏览器因此拿不到 polyfill、
    // PWA 注入脚本（window.dshPocketPush）与通行密钥配置（window.dshPocketPasskey）。
    // 只对 HTML 导航去掉该头，静态资源与大 JSON 仍保持压缩（大 JSON 由下面的流式压缩处理）。
    if (isHtmlRequest(req)) delete headers['accept-encoding'];
    // HTML 注入内容 = PWA（manifest/SW/注入脚本）+ 通行密钥配置 + 宿主自定义补丁。
    // 每个请求单独算：通行密钥是否可用、本设备是否已注册都随 Host/设备 cookie 变化。
    const injectOut = injectHtml
      ? pwaInjectHtml({
        passkey: passkeyOn() && Boolean(passkeyChannel),
        deviceKnown: deviceInfo !== null,
        channel: passkeyChannel,
      }) + injectHtml
      : '';
    // dsh web 浏览器会话 token（issue #77）：首屏根路径补一次，换回绑定 authority 的 cookie
    const launchTok = (typeof launchToken === 'function' ? launchToken() : '') || '';
    // 先清掉历史遗留的 dsh-desktop-* 参数（issue #75），再补 launch token
    // 握手重试上限（issue #91）：Safari 不保存 http://IP 源上 3xx 下发的 cookie →
    // 补 token → 上游 303 → 浏览器仍无 cookie → 无限循环。达到上限就别再补了，
    // 让请求落到提示页，而不是继续转圈。
    const handshakeIp = clientIp(req);
    // `/?dsh-pocket-retry=1`：提示页上的「重试」入口——清掉这一轮的失败计数，让握手
    // 重新走一遍（否则用户得干等窗口过期）。这参数是我们自己加的，不往上游透传。
    let cleanPath = stripDesktopMarkers(req.url);
    if (cleanPath.includes(HANDSHAKE_RETRY_PARAM)) {
      handshake.clear(handshakeIp);
      cleanPath = stripQueryParam(cleanPath, HANDSHAKE_RETRY_PARAM);
    }
    const handshakeOver = launchTok !== '' && handshake.exhausted(handshakeIp);
    const upstreamPath = handshakeOver
      ? cleanPath
      : upstreamPathWithLaunchToken(cleanPath, req.method, req.headers.cookie, launchTok);
    const didInjectToken = upstreamPath !== cleanPath;
    if (didInjectToken) {
      handshake.record(handshakeIp);
      handshake.prune();
    }
    // 请求带上了会话 cookie → 这一轮的握手计数可以清掉了（说明 cookie 通路是好的）
    if (!didInjectToken && String(req.headers.cookie ?? '').includes(DSH_AUTH_COOKIE)) {
      handshake.clear(handshakeIp);
    }
    if (handshakeOver && isHtmlRequest(req)) {
      // 已判定握不上手 → 停在这里给人话，别再转圈。API/WS 不走这里（上游会 401）。
      res.writeHead(503, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-dsh-pocket-handshake': 'blocked',
      });
      res.end(handshakeBlockedPageHtml());
      return;
    }
    const proxyReq = httpRequest(
      { host: upstream.host, port: upstream.port, method: req.method, path: upstreamPath, headers, agent: false },
      (proxyRes) => {
        log?.(`${req.method} ${req.url} -> ${proxyRes.statusCode}`);
        const contentType = String(proxyRes.headers['content-type'] ?? '');
        // issue #91：我们刚注入了 launch token，上游回 303（换 cookie 后回干净根路径）。
        // Safari 不保存 http://IP 源上 3xx 响应下发的 cookie，于是浏览器下次仍无 cookie
        // → 代理再注入 → 再 303 → 死循环。这里把这次 303 改成 200 过渡页：Set-Cookie
        // 照发（200 上的 cookie 不会被那条重定向策略丢掉），页面用 meta refresh 跳回 `/`。
        if (didInjectToken && proxyRes.statusCode === 303 && isHtmlRequest(req)) {
          const out = { ...proxyRes.headers };
          delete out['content-length'];
          delete out['transfer-encoding'];
          delete out.location; // 自己跳，不留给浏览器去重做一次 303
          const page = Buffer.from(handshakePageHtml(), 'utf8');
          out['content-type'] = 'text/html; charset=utf-8';
          out['content-length'] = String(page.length);
          out['cache-control'] = 'no-store';
          out['x-dsh-pocket-handshake'] = 'transition';
          proxyRes.resume(); // 消费掉上游响应体，释放连接
          res.writeHead(200, out);
          res.end(page);
          return;
        }
        // issue #81：上游 desktop-browser-access 门禁（DSH Desktop 未开启「浏览器访问」时）
        // 对普通浏览器（含经本代理转发的手机）返回 403 text/plain "forbidden"，且本代理无法
        // 携带 Electron renderer secret 绕过。对符合该特征的**浏览器导航**请求改写为可操作
        // 提示页；API/WS 与其余 403 原样透传（不猜 secret、不把任意 403 都判为桌面门禁）。
        if (proxyRes.statusCode === 403 && contentType.includes('text/plain')) {
          const navReq = isHtmlRequest(req);
          const gateChunks = [];
          let gateOverflow = false;
          const passRaw403 = () => {
            if (res.headersSent) return;
            res.writeHead(403, { ...proxyRes.headers });
            if (gateChunks.length) res.write(Buffer.concat(gateChunks));
            proxyRes.pipe(res);
          };
          proxyRes.on('data', (c) => {
            if (gateOverflow) return;
            gateChunks.push(c);
            if (Buffer.concat(gateChunks).length > 65536) { gateOverflow = true; gateChunks.length = 0; passRaw403(); }
          });
          proxyRes.on('end', () => {
            if (gateOverflow || res.headersSent) return;
            const body = Buffer.concat(gateChunks).toString('utf8').trim();
            if (navReq && body === 'forbidden') {
              res.writeHead(403, {
                'content-type': 'text/html; charset=utf-8',
                'cache-control': 'no-store',
                'x-dsh-pocket-gate': 'desktop-browser-access',
              });
              res.end(desktopAccessBlockedPageHtml());
            } else {
              res.writeHead(403, { ...proxyRes.headers });
              res.end(Buffer.concat(gateChunks));
            }
          });
          proxyRes.on('error', () => res.destroy());
          return;
        }
        // 只给**未压缩**的 HTML 文档注入（SSE/WS/JS/CSS 原样透传；压缩流注入会损坏页面）；
        // 注入后修正 Content-Length
        if (injectOut && contentType.includes('text/html') && !isCompressed(proxyRes.headers)) {
          const chunks = [];
          proxyRes.on('data', (c) => chunks.push(c));
          proxyRes.on('end', () => {
            let html = Buffer.concat(chunks).toString('utf8');
            if (!html.includes(INJECT_MARK) && !html.includes(PWA_INJECT_MARK)) {
              html = html.replace(/<head[^>]*>/i, (m) => `${m}${injectOut}`);
            }
            const out = Buffer.from(html, 'utf8');
            const outHeaders = { ...proxyRes.headers };
            delete outHeaders['content-length'];
            delete outHeaders['transfer-encoding'];
            outHeaders['content-length'] = String(out.length);
            // 注入后的 HTML 携带本代理的动态补丁（含注入标记判重），
            // 必须禁用缓存——否则手机/中间层（nginx 等）拿到没有补丁的旧
            // 文档后，isLoopback 修复不生效且难以排查（表现为"改了没效果"）。
            outHeaders['cache-control'] = 'no-store';
            delete outHeaders['etag'];
            delete outHeaders['last-modified'];
            delete outHeaders['expires'];
            res.writeHead(proxyRes.statusCode ?? 200, outHeaders);
            res.end(out);
          });
          proxyRes.on('error', () => res.destroy());
          return;
        }
        // 大 JSON/text 响应**流式压缩**（issue #12）：长会话历史一次返回 17MB+，
        // 局域网直连与隧道段都吃满带宽；压缩到 ~1MB。跳过已压缩、SSE 流
        // （/api/events.* 原样透传）、HTML（走上面的注入分支）。
        // brotli 质量选 6（issue #25）：zlib 默认 q11 压 17MB 要 40s+，手机直接超时；
        // q6 实测 128ms（比 gzip 的 88ms 略慢但同档）且输出更小（1.00MB vs 1.20MB）。
        const acceptEncoding = String(req.headers['accept-encoding'] ?? '');
        const canGzip = /\bgzip\b/.test(acceptEncoding);
        const canBr = /\bbr\b/.test(acceptEncoding);
        const isEventStream = contentType.includes('text/event-stream');
        const knownLen = Number(proxyRes.headers['content-length'] || 0);
        const shouldCompress = (canGzip || canBr)
          && !isCompressed(proxyRes.headers)
          && !isEventStream
          && (contentType.includes('application/json') || contentType.startsWith('text/'))
          && (knownLen === 0 || knownLen >= 1024);
        if (shouldCompress) {
          const enc = canBr ? 'br' : 'gzip';
          const outHeaders = { ...proxyRes.headers };
          delete outHeaders['content-length'];
          delete outHeaders['transfer-encoding'];
          outHeaders['content-encoding'] = enc;
          res.writeHead(proxyRes.statusCode ?? 200, outHeaders);
          const z = enc === 'br'
            ? createBrotliCompress({ params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 6 } })
            : createGzip();
          proxyRes.pipe(z).pipe(res);
          // 任一端断开都要清理（含压缩流）。注意：不能用 proxyRes 的 'close'
          // 来掐 res——正常结束后 close 也会触发，此时压缩流可能还没写完，
          // 会误杀连接；异常中止用 'aborted'。
          res.on('close', () => { proxyRes.destroy(); z.destroy(); });
          proxyRes.on('error', () => { z.destroy(); res.destroy(); });
          proxyRes.on('aborted', () => { z.destroy(); res.destroy(); });
          z.on('error', () => res.destroy());
          return;
        }
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
        // 任一端断开都要清理另一端：客户端断连销毁上游流（不留僵尸），
        // 上游流中途断开也要掐断客户端（否则响应头已发、体没发完 → 悬挂）
        res.on('close', () => proxyRes.destroy());
        proxyRes.on('error', () => res.destroy());
        proxyRes.on('close', () => { if (!res.writableEnded) res.destroy(); });
      },
    );
    proxyReq.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`dsh-pocket: 无法连接上游 dsh web（${upstream.host}:${upstream.port}）——先启动 dsh web | ${err.message}`);
    });
    req.pipe(proxyReq);
  }

  /** 崩溃屏障（宿主退出防护）：http 回调里逃逸的异常 = uncaughtException = 宿主 exit(1)。 */
  const server = createServer((req, res) => {
    try {
      handleHttpRequest(req, res);
    } catch (err) {
      log?.(`dsh-pocket: request handler crashed: ${err?.stack ?? err}`);
      try {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
        }
        res.end('dsh-pocket: internal error');
      } catch { /* 响应已不可用（连接已断）：不再二次抛错 */ }
    }
  });

  /**
   * WebSocket upgrade 处理体（DSH 的 /api/events.mux + events.host 流式通道）原样透传。
   * 与 handleHttpRequest 同样必须收口：upgrade 回调也是同步的，抛错即打死宿主（宿主退出防护）。
   */
  function handleUpgrade(req, socket, head) {
    // 畸形请求目标：与 HTTP 侧一致 400 收口（`GET http://[` 这类绝对形式会让
    // `new URL(req.url)` 抛 ERR_INVALID_URL，下面 authCheck 曾经就是这样打死宿主的）。
    if (!parseRequestTarget(req.url)) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    // 与 HTTP 侧同一套判定（issue #90）：否则伪造 Host 的 WS 握手仍可绕过局域网开关
    const host = policyHost(req, String(req.headers.host ?? ''));
    const isPublic = classifyHost(host) === 'public';
    // 公网子通道判定（与 HTTP 完全一致）：不匹配当前通道的陌生公网 Host → 403 fail closed
    const channels = readPublicChannels();
    const pinned = pinnedMode(channels);
    const publicChannel = isPublic ? publicChannelForHost(host, channels ?? {}) : null;
    if (isPublic && pinned && publicChannel === null) {
      logUnknownPublicHost(hostNameOnly(host));
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    // 局域网访问关闭：拦截经局域网 Host 的 WS 握手（公网/loopback 放行——issue #66 fail closed）
    if (!isPublic && !isLoopbackHost(host) && !lanAccessEnabled()) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    // WebSocket 同样校验（防止绕过 HTTP 认证从 WS 进入；含临时 PIN，issue #69）
    if (auth) {
      const protectedHost = isProtectedHost(host, auth.isProtected);
      const token = protectedHost ? (auth.getToken?.(host) ?? null) : null;
      // 受保护 Host 但宿主没给出任何 PIN：与 HTTP 侧同形状的 fail closed（task-13 D-3 / task-16）。
      // 旧写法 `if (token && !wsAuth.ok)` 在 token 为空时既不写 401、也不拦截，握手被直接透传
      // 上游 —— HTTP 入口堵住了、WS 入口漏着，等于没堵。这里显式拒绝，两条入口保持一致。
      if (protectedHost && !token) {
        log?.(`dsh-pocket: protected host ${hostNameOnly(host)} has no PIN configured — refusing ws upgrade (fail closed)`);
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      const altTokens = token && typeof auth.getAltTokens === 'function' ? (auth.getAltTokens(host) ?? []) : [];
      const acceptedTokens = token ? [token, ...altTokens] : [];
      // WS 握手上的 ?token= 与 HTTP 侧同权（issue #90）：不并入限速的话，攻击者
      // 只要把穷举换到 upgrade 请求上就照样不受限。
      const wsIp = clientIp(req);
      const wsGuess = hasQueryToken(req);
      if (token && wsGuess) {
        const rl = limiter?.status(wsIp) ?? { locked: false, retryAfter: 0 };
        if (rl.locked) {
          socket.write(`HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${rl.retryAfter}\r\nConnection: close\r\n\r\n`);
          socket.destroy();
          return;
        }
      }
      const wsAuth = tryDeviceAuth(req, publicChannel) ? { ok: true } : authCheck(req, acceptedTokens, sessionKey);
      if (token && !wsAuth.ok) {
        if (wsGuess) {
          limiter?.record(wsIp);
          log?.(`dsh-pocket: bad ws ?token= from ${wsIp} | WS 密码错误 IP: ${wsIp}`);
        }
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      if (token && wsAuth.ok && wsGuess) limiter?.clear(wsIp);
    }
    const headers = loopbackAuthority({ ...req.headers }, upstream);
    const proxyReq = httpRequest({
      // 同样清掉历史遗留的 dsh-desktop-* 参数（issue #75）
      host: upstream.host, port: upstream.port, method: req.method, path: stripDesktopMarkers(req.url), headers, agent: false,
    });
    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\n');
      // 原样回传上游的 upgrade 头（Sec-WebSocket-Accept 等）
      const raw = [];
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        raw.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
      }
      socket.write(`${raw.join('\r\n')}\r\n\r\n`);
      if (proxyHead?.length) socket.write(proxyHead);
      // pipe 必须 end:false：默认 end:true 会在对端 FIN 时抢先 end() 对端 socket
      // （优雅 FIN），此时 teardown 的 destroy() 已无法强制关闭对方——上游只收
      // 到 FIN 进入 half-open 永不关闭（PR #56）。半关闭统一交给下面的 'end'
      // 监听 → teardown destroy（RST 强制关闭双方）。
      socket.pipe(proxySocket, { end: false });
      proxySocket.pipe(socket, { end: false });
      // 心跳注入（PR #41）：保活 + 静默断链检测（见 attachWebSocketHeartbeat）
      if (heartbeat !== false) attachWebSocketHeartbeat(socket, heartbeat ?? {});
      // 任一端断开都要清理另一端（避免上游残留僵尸连接占用 dsh 连接槽）。
      // 上游侧必须 resetAndDestroy（发 RST）：destroy() 只发干净 FIN，而上游
      // http server 默认 allowHalfOpen=true，收到 FIN 不自动关闭 → 上游仍悬挂
      // （PR #56 实测）。RST 强制对端立即关闭。
      const teardown = () => {
        try { proxySocket.resetAndDestroy?.() ?? proxySocket.destroy(); } catch { try { proxySocket.destroy(); } catch {} }
        try { socket.destroy(); } catch {}
      };
      // 上游侧透传 socket 的读错误（如 dsh web 重启/断开时的 ECONNRESET）必须
      // 吞掉并清理对端，否则未处理的 'error' 事件会让整个 dsh web 进程崩溃退出。
      proxySocket.on('error', () => { try { socket.destroy(); } catch {} });
      proxySocket.on('close', teardown);
      socket.on('close', teardown);
      // 半关闭（收到对端 FIN 的 'end'）对双向转发同样意味着这一端要走了：http server
      // 默认 allowHalfOpen=true，收到 FIN 只触发 'end' 不自动关——若不在 'end' 时销毁，
      // 浏览器/App 直接关页（不发 WS close 帧就 FIN）留下的连接会永久挂在 half-open
      // 状态，上游连接槽被占（且 server.close() 永远等不完）。双向流里半关闭无意义。
      socket.on('end', teardown);
      proxySocket.on('end', teardown);
    });
    // 上游返回普通 HTTP 响应（非 101）：把状态码/头回写后断开，别让客户端永久挂起
    proxyReq.on('response', (proxyRes) => {
      if (proxyRes.statusCode === 101) return; // 理论上 101 走 upgrade 事件
      try {
        const raw = [`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage ?? ''}`.trim()];
        for (const [k, v] of Object.entries(proxyRes.headers)) {
          raw.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
        }
        // end 会 flush 响应头再 FIN——不要紧跟 destroy()，否则排队的头会被丢弃
        socket.end(raw.join('\r\n') + '\r\n\r\n');
        proxyRes.resume(); // 消费掉上游响应体，释放连接
      } catch { socket.destroy(); }
    });
    proxyReq.on('error', () => socket.destroy());
    // 关键：浏览器在握手请求后可能立即发出首帧（如 mux 流的初始 RPC），
    // node 把它放在 upgrade 事件的 head 里。必须先于 end() 写入 proxyReq，
    // 让上游在 upgrade 事件里就拿到它（与直连行为一致）；等 101 之后再写
    // 会变成迟到的 socket 数据，DSH 的 mux 协议可能错过这个窗口。
    if (head?.length) proxyReq.write(head);
    proxyReq.end();
    socket.on('error', () => socket.destroy());
  }

  /** 崩溃屏障（宿主退出防护）：upgrade 回调抛错 = uncaughtException = 宿主 exit(1)。 */
  server.on('upgrade', (req, socket, head) => {
    try {
      handleUpgrade(req, socket, head);
    } catch (err) {
      log?.(`dsh-pocket: ws upgrade handler crashed: ${err?.stack ?? err}`);
      try { socket.destroy(); } catch { /* 已断开 */ }
    }
  });

  // 跟踪所有 TCP 连接（含 WebSocket upgrade 后的 socket——Node 的
  // closeAllConnections 不包含它们，不手动销毁 close() 会永远等）
  const clientSockets = new Set();
  server.on('connection', (sock) => {
    clientSockets.add(sock);
    sock.on('close', () => clientSockets.delete(sock));
    sock.on('error', () => {}); // 防未处理 error 崩进程
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actualPort = server.address().port;
      resolve({
        server,
        port: actualPort,
        close: () => new Promise((r) => {
          for (const s of clientSockets) { try { s.destroy(); } catch { /* 忽略 */ } }
          server.close(() => r());
        }),
      });
    });
  });
}
