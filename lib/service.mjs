// dsh-pocket 服务：在 dsh web 进程内跑改头代理 + 公网隧道
//
// - 代理：监听 0.0.0.0:<port>（默认 3081），把入站 Host/Origin 改写成
//   127.0.0.1:<dshPort>（dsh web 实际端口），HTTP + WebSocket 全透传。
//   这样 DSH 的 /api 浏览器信任栅栏永远看到 loopback，局域网/公网都能进，
//   且不需要改 dsh 的任何配置（0.0.0.0 绑定被 dsh 官方禁用）。
// - 隧道：cloudflared 快速隧道（可选），公网 https URL，供人在外面访问。

import { networkInterfaces } from 'node:os';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createPocketProxy } from './proxy.mjs';
import { startQuickTunnel, startNamedTunnel } from './tunnel.mjs';
import { createSshChannel, normalizeSshChannelConfig, buildAccessUrl } from './ssh-channel.mjs';
import { isValidIpv4 } from './ip.mjs';

const require = createRequire(import.meta.url);

/** URL → 二维码 data URL（浏览器 <img> 直接显示，全本地不依赖第三方）。 */
export async function qrDataUrl(text, { width = 220, margin = 1 } = {}) {
  const QRCode = require('qrcode');
  return QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin, width, type: 'image/png' });
}

// RFC1918 私网地址：手机与电脑连同一局域网时通常可直连。
// 另含 CGNAT 100.64/10（RFC 6598，Tailscale/ZeroTier 默认网段，公网不可路由），保持一致（issue #79）。
const PRIVATE_IPV4_RE = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1(?:0\d|1\d|2[0-7]))\.)/;

/** 名称像真实物理网卡的接口（WLAN / Wi-Fi / Ethernet / 以太网 / 有线 / 无线 / en / eth）。 */
const PHYSICAL_IFACE_RE = /^(?:wlan|wi-?fi|wireless|ethernet|eth\d|en\d|wlp\d|以太网|有线|无线|本地连接)/i;

/** 常见的 VPN / 虚拟网卡名称：手机通常无法通过它们直连电脑。 */
const VPN_IFACE_RE = /(?:radmin|tailscale|zerotier|easytier|et_|tun|tap|vpn|vethernet|virtual|vmware|virtualbox|wsl|docker|teredo|hamachi|bluetooth|bridge)/i;

/**
 * 从 networkInterfaces() 返回的接口表里选出手机最可能可达的 IPv4。
 *
 * `os.networkInterfaces()` 的枚举顺序不可靠：Windows 上 Radmin VPN / Tailscale /
 * vEthernet 等虚拟网卡常排在 WLAN 前面，旧实现直接取第一张非回环网卡，会生成
 * 手机打不开的二维码。这里按以下规则打分排序：
 *   - RFC1918 私网地址优先（10/8、172.16/12、192.168/16）；
 *   - 名称像物理网卡再加分；
 *   - 名称像 VPN/虚拟网卡减分；
 *   - 同分保持原枚举顺序。
 * 没有任何私网地址时回退到最高分地址（例如纯 VPN 环境仍可用）。
 *
 * @param {ReturnType<typeof networkInterfaces>} interfaces
 * @returns {string|null}
 */
export function selectLanIPv4(interfaces) {
  const candidates = [];
  for (const [name, addrs] of Object.entries(interfaces ?? {})) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const ip = addr.address;
      // 排除 loopback 与 link-local；其余地址即使不是私网（如 Radmin 的 26.x）也保留兜底
      if (!ip || ip.startsWith('127.') || ip.startsWith('169.254.')) continue;

      let score = 0;
      if (PRIVATE_IPV4_RE.test(ip)) score += 100;
      if (PHYSICAL_IFACE_RE.test(name)) score += 20;
      else if (VPN_IFACE_RE.test(name)) score -= 50;

      candidates.push({ ip, score, order: candidates.length });
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.order - b.order);
  return candidates[0]?.ip ?? null;
}

// ---------- WSL 局域网 IP（issue #39） ----------
// WSL2 是 NAT 模式：WSL 内部 os.networkInterfaces() 只能看到自己的虚拟网卡
// （172.x.x.x），看不到 Windows 宿主机的物理网卡 IP（192.168.x.x）——手机在
// 同一 WiFi 下访问的是 Windows 宿主机，拿 WSL 的 IP 生成的二维码必然打不开。
// 解法：检测到 WSL 时，通过 WSL interop 直接执行 Windows 的 ipconfig.exe，
// 解析出 Windows 侧非虚拟网卡的 IPv4 作为局域网地址；失败回退本机探测。

/** WSL 检测：/proc/version 含 microsoft/wsl，或 WSL 专属环境变量存在。 */
export function detectWsl() {
  try {
    const v = readFileSync('/proc/version', 'utf8').toLowerCase();
    if (v.includes('microsoft') || v.includes('wsl')) return true;
  } catch { /* 非 Linux：无 /proc/version */ }
  // 注意：**不能**用 WSLENV 判据——Windows Terminal 在原生 Windows 上也会设置
  // WSLENV（如 WT_SESSION:WT_PROFILE_ID:），会误判成 WSL。只认 WSL 内部才有的变量。
  return Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

/**
 * 解析 ipconfig.exe 输出，默认取非虚拟网卡块的 IPv4 地址（保持输出顺序）。
 * 支持中文（`IPv4 地址 . . . :`）与英文（`IPv4 Address. . . :`）两种格式。
 * @param {string} text ipconfig.exe 的完整输出
 * @param {{ includeVpn?: boolean }} [opts] 传 includeVpn 时保留 Tailscale/VPN 等候选
 * @returns {string[]} 候选 IPv4 列表
 */
export function parseIpconfig(text, { includeVpn = false } = {}) {
  const out = [];
  // 网卡块：块标题行顶格（行首无缩进），其后内容行带缩进
  const blocks = String(text).split(/\r?\n(?=\S)/);
  const ipRe = /IPv4[^0-9]{0,40}((?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)/;
  for (const block of blocks) {
    const title = String(block.split(/\r?\n/)[0] ?? '');
    // 跳过虚拟网卡块（vEthernet (WSL)、Docker、VirtualBox、VPN 等）
    if (!includeVpn && VPN_IFACE_RE.test(title)) continue;
    const m = block.match(ipRe);
    if (m) out.push(m[0].replace(/^IPv4[^0-9]*/i, ''));
  }
  return out;
}

function runIpconfig() {
  // WSL 内 PATH 可能不含 Windows System32；用绝对路径兜底
  const candidates = ['ipconfig.exe', '/mnt/c/Windows/System32/ipconfig.exe'];
  return new Promise((resolve) => {
    const tryNext = (i) => {
      if (i >= candidates.length) return resolve(null);
      execFile(candidates[i], [], { timeout: 5000, windowsHide: true }, (err, stdout) => {
        if (err || !stdout) return tryNext(i + 1);
        resolve(String(stdout));
      });
    };
    tryNext(0);
  });
}

async function lanIPv4() {
  // WSL：优先 Windows 物理网卡 IP（手机可达）；超时/失败回退本机探测
  if (detectWsl()) {
    try {
      const out = await runIpconfig();
      const candidates = parseIpconfig(out ?? '');
      const ip = candidates.find((c) => PRIVATE_IPV4_RE.test(c)) ?? candidates[0];
      if (ip) return ip;
    } catch { /* 回退 */ }
  }
  return selectLanIPv4(networkInterfaces());
}

/** 收集所有可手动选择的局域网/Tailnet 候选 IP（WSL 下以 Windows ipconfig 为准）。 */
async function listLanCandidates() {
  if (detectWsl()) {
    try {
      const out = await runIpconfig();
      const ips = parseIpconfig(out ?? '', { includeVpn: true });
      if (ips.length) return [...new Set(ips)];
    } catch { /* 回退 */ }
  }
  const ips = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const ip = addr.address;
      if (!ip || ip.startsWith('127.') || ip.startsWith('169.254.')) continue;
      if (!ips.includes(ip)) ips.push(ip);
    }
  }
  return ips;
}

/**
 * 创建 Pocket 服务。
 * @param {object} opts
 * @param {number} opts.dshPort   dsh web 实际端口（从 ctx.webServer.port 取）
 * @param {number} [opts.port]    代理端口（默认 3081）
 * @param {object} [opts.internals] 测试注入：createProxy / startTunnel / lanIPv4
 * @returns {PocketService}
 */
export function createPocketService({
  dshPort,
  port = 3081,
  home,
  internals = {},
  /** 局域网地址手动覆盖：返回 IPv4 字符串；空值表示自动选择 */
  getLanIpOverride,
  /** 局域网访问总开关：返回 boolean；默认开启。关闭后代理拒绝局域网 Host 请求 */
  getLanEnabled = () => true,
  /** 代理注入 HTML 的内容（桌面端补丁等由 lib/index.js 传入；默认 randomUUID polyfill） */
  injectHtml,
  /** 访问令牌认证配置（issue #13）：{ getToken, isProtected }，传给代理 */
  auth,
  /** @type {() => string} dsh web 浏览器会话启动 token（issue #77；老版本返回空字符串） */
  launchToken = () => '',
  /** 隧道配置（issue #66）：() => ({ mode:'quick'|'named'|'ssh', token, hostname })；named 用固定域名 */
  getTunnelConfig,
  /** SSH 通道配置读取：() => settings.sshChannelConfig() 形状（host/port/user/keyPath/access* 等） */
  getSshConfig = () => ({}),
  /** 代理追加选项：{ passkeyStore, getPasskeyEnabled, pushStore, getPublicChannels } 由 lib/index.js 注入 */
  proxyExtras = null,
  /** 只读状态区块：通知（含订阅数）/ 通行密钥（由 lib/index.js 提供闭包，service 不直接依赖设置模块） */
  getNotifyStatus = null,
  getPasskeyStatus = null,
  /** 隧道就绪回调（lib/index.js 用它轮换公网密码；参数为 'quick'|'named'|'ssh'） */
  onTunnelReady,
  /** 日志（DSH 宿主 ctx.logger 有 info/warn/error；默认 console 无 info，自动退回 log）。
   *  隧道自动恢复的成败必须走这里：console 输出在 DSH Desktop 里不进日志文件，
   *  出问题时无法排查（2026-09-07 实测教训）。 */
  log = console,
} = {}) {
  // ctx.logger 形状是 info/warn/error；console 只有 log/warn/error——info 做兜底兼容
  const logInfo = (...args) => (log.info ?? log.log).call(log, ...args);
  const logWarn = (...args) => log.warn(...args);
  const createProxy = internals.createProxy ?? createPocketProxy;
  const startTunnel = internals.startTunnel ?? startQuickTunnel;
  const startNamed = internals.startNamedTunnel ?? startNamedTunnel;
  const getLanOverride = () => {
    const value = String(getLanIpOverride?.() ?? '').trim();
    return isValidIpv4(value) ? value : '';
  };
  const getLan = async () => getLanOverride() || (internals.lanIPv4 ? internals.lanIPv4() : lanIPv4());
  let lanCandidateCache = null;
  const getLanCandidates = async () => {
    if (internals.lanCandidates) return internals.lanCandidates();
    const now = Date.now();
    if (!lanCandidateCache || now - lanCandidateCache.at > 15000) {
      lanCandidateCache = { at: now, ips: await listLanCandidates() };
    }
    return lanCandidateCache.ips;
  };

  let proxy = null;
  let tunnel = null;
  let tunnelAbort = null;
  /** in-flight 隧道启动（单飞）：并发调用复用同一次，避免 spawn 多个 cloudflared 孤儿进程 */
  let tunnelPromise = null;
  /** 隧道进度：{ phase: idle|downloading|starting|registering|ready|error, detail, startedAt } */
  const tunnelState = { phase: 'idle', detail: '', startedAt: null };
  /** 二维码缓存：URL → data URL promise。status() 每 3 秒轮询一次，不能每次都重新生成（CPU 密集）。 */
  const qrCache = new Map();
  const encodeQr = internals.encodeQr ?? qrDataUrl;
  async function qrCached(text) {
    if (!text) return null;
    if (!qrCache.has(text)) {
      if (qrCache.size >= 8) {
        // 只淘汰最旧一条（隧道 URL 每次重启换新），别殃及稳定的 LAN 二维码
        const oldest = qrCache.keys().next().value;
        qrCache.delete(oldest);
      }
      qrCache.set(text, encodeQr(text).catch(() => null));
    }
    return qrCache.get(text);
  }

  // 公网隧道自动恢复（issue #11）：DSH 重启后 cloudflared 子进程被杀、隧道消失，
  // 插件无从知晓。启动时检查持久化的「隧道开启中」标记，自动重新拉起。
  const autoStatePath = home ? join(home, 'dsh-pocket', 'tunnel-auto.json') : null;
  // 写入与删除必须串行：隧道刚就绪就立即关闭时，异步写不能晚于删除重新落盘，
  // 否则标记被晚到的写操作复活，下次启动误恢复（writeFile 与 rm 的完成顺序不保证）。
  let autoStateQueue = Promise.resolve();
  function persistAutoTunnel() {
    if (!autoStatePath) return;
    autoStateQueue = autoStateQueue.then(async () => {
      try {
        await mkdir(dirname(autoStatePath), { recursive: true });
        await writeFile(autoStatePath, JSON.stringify({ at: Date.now() }), 'utf8');
      } catch { /* 忽略 */ }
    });
    return autoStateQueue;
  }
  function clearAutoTunnel() {
    if (!autoStatePath) return;
    autoStateQueue = autoStateQueue.then(async () => {
      try { await rm(autoStatePath, { force: true }); } catch { /* 忽略 */ }
    });
    return autoStateQueue;
  }

  // ---------- SSH 通道（自有 VPS + 反向端口转发） ----------
  // 三条公网通道（quick / named / ssh）互斥：由 settings.tunnelMode 单键决定，
  // 启动任何一条之前先关掉另一条（否则两套入口同时活着，用户以为已经切走了）。
  const createSsh = internals.createSshChannel ?? createSshChannel;
  let sshChannel = null;
  const getSshChannel = () => {
    if (!sshChannel) {
      sshChannel = createSsh({
        // 每次调用都重新读设置：设置页改完不必重启
        getConfig: () => (typeof getSshConfig === 'function' ? (getSshConfig() ?? {}) : {}),
        // ssh -R 的另一端就是本机代理；代理还没起来时为 0 → start() 抛可读错误
        getLocalPort: () => proxy?.port ?? 0,
        ...(internals.sshSpawnImpl ? { spawnImpl: internals.sshSpawnImpl } : {}),
        ...(internals.sshStdioFactory ? { stdioFactory: internals.sshStdioFactory } : {}),
        ...(internals.sshGraceMs !== undefined ? { graceMs: internals.sshGraceMs } : {}),
        log: logInfo,
      });
    }
    return sshChannel;
  };
  const tunnelModeNow = () => {
    const cfg = typeof getTunnelConfig === 'function' ? (getTunnelConfig() ?? {}) : {};
    return cfg?.mode === 'named' ? 'named' : cfg?.mode === 'ssh' ? 'ssh' : 'quick';
  };
  /** 关掉 cloudflared 通道（若在跑），并把隧道状态清空。 */
  function stopCloudflared() {
    tunnelAbort?.abort();
    tunnelAbort = null;
    tunnelPromise = null; // 丢弃已 abort 的 in-flight（其 finally 会再清一次，无害）
    if (tunnel) {
      try { tunnel.kill(); } catch { /* 已退出 */ }
    }
    tunnel = null;
  }
  /** 关掉 ssh 通道（若在跑）。 */
  function stopSshChannel() {
    if (!sshChannel) return;
    try { sshChannel.stop(); } catch (err) { logWarn('dsh-pocket: stop ssh tunnel failed | 停止 SSH 隧道失败: %s', err?.message ?? err); }
  }
  /** 手动停掉公网通道后清状态。 */
  function resetTunnelState(phase = 'idle', detail = '') {
    tunnelState.phase = phase;
    tunnelState.detail = detail;
    tunnelState.startedAt = null;
  }
  /**
   * 等 SSH 通道给出「已连上 / 失败」结论。
   * 启动是异步的（真 ssh 连上要 1–3 秒，受限环境里 spawn 会 EPERM），这里短暂等一下再回报，
   * 免得 UI 显示「已开启」而进程其实起不来。仍在重连中不算失败——状态块会实时反映。
   */
  async function waitForSshOutcome(ch, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const st = ch.status();
      if (st.state === 'connected') return { ok: true, status: st };
      if (st.state === 'failed') return { ok: false, status: st };
      if (Date.now() >= deadline) return { ok: true, status: st };
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  /** 设置里的模式变了：关掉不再匹配的那条公网通道（三通道互斥）。 */
  function syncChannelsForMode() {
    const mode = tunnelModeNow();
    if (mode !== 'ssh' && sshChannel?.status?.().running) {
      stopSshChannel();
      resetTunnelState();
    }
    if (mode === 'ssh' && tunnel !== null) {
      stopCloudflared();
      resetTunnelState();
    }
    return mode;
  }
  /** 当前 SSH 通道状态（未创建实例时为 idle；只暴露脱敏字段）。 */
  function sshStatusView() {
    const st = sshChannel ? sshChannel.status() : { running: false, state: 'idle', lastError: null, url: null };
    const cfg = normalizeSshChannelConfig(typeof getSshConfig === 'function' ? (getSshConfig() ?? {}) : {});
    return { ...st, url: st.url ?? buildAccessUrl(cfg), config: cfg };
  }

  return {
    dshPort,
    /** 启动局域网代理（幂等）。端口被占（EADDRINUSE，如桌面版与普通环境同时运行）时自动尝试下一个端口。 */
    async startProxy() {
      if (proxy) return proxy;
      let lastErr = null;
      for (let p = port; p < port + 10; p++) {
        try {
          proxy = await createProxy({
            port: p,
            host: '0.0.0.0',
            upstream: { host: '127.0.0.1', port: dshPort },
            ...(injectHtml ? { injectHtml } : {}),
            ...(auth ? { auth } : {}),
            // 每次请求实时读开关：设置页切换后立即生效，无需重启代理
            lanAccessEnabled: () => getLanEnabled(),
            // dsh web 浏览器会话启动 token（issue #77）：实时取，新版 dsh 才有
            ...(launchToken ? { launchToken } : {}),
            // 第三通道 / 通行密钥 / 推送的代理扩展（由 lib/index.js 注入，测试可省）
            ...(proxyExtras ?? {}),
          });
          if (p !== port) {
            logInfo(`dsh-pocket: port ${port} busy, proxy on ${p} | 端口 ${port} 被占用，代理改用 ${p}`);
          }
          break;
        } catch (err) {
          if (err?.code !== 'EADDRINUSE') throw err; // 非端口冲突直接失败
          lastErr = err;
        }
      }
      if (!proxy) throw lastErr ?? new Error('proxy start failed | 代理启动失败');
      return proxy;
    },

    /** 启动公网入口（幂等；返回公网 URL）。按 tunnelMode 分流：ssh 走 SSH 反向隧道，其余走 cloudflared。 */
    async startTunnel() {
      await this.startProxy();
      if (tunnelModeNow() === 'ssh') return this.startSshTunnel();
      // 从 ssh 切回 cloudflared：先关掉 ssh 进程（三通道互斥，同一远端不该有两个入口）
      if (sshChannel?.status?.().running) {
        stopSshChannel();
        resetTunnelState();
      }
      if (tunnel) return tunnel.url;
      if (tunnelPromise) return tunnelPromise; // 复用 in-flight，防孤儿 cloudflared
      const controller = new AbortController();
      tunnelAbort = controller;
      tunnelState.startedAt = Date.now();
      const onPhase = (phase) => {
        tunnelState.phase = phase;
        if (phase === 'downloading') tunnelState.detail = '首次下载 cloudflared（约 20MB）| first run downloads cloudflared (~20MB)';
        else if (phase === 'starting') tunnelState.detail = '启动隧道进程… | starting tunnel…';
        else if (phase === 'registering') tunnelState.detail = '连接 Cloudflare 边缘（通常 5-30 秒）| connecting to Cloudflare edge (usually 5-30s)';
        else if (phase === 'ready') tunnelState.detail = '隧道就绪 | ready';
      };
      // 先 `await null` 让函数体从微任务开始执行：否则在 `p` 初始化之前（getTunnelConfig
      // 之类的同步抛错）就会走到 finally，引用未初始化的 const 触发 TDZ 报错，
      // tunnelPromise 会永久停在 rejected —— 此后 startTunnel 一直复用这个失败的
      // promise，隧道再也起不来。
      const p = (async () => {
        await null;
        try {
          // 命名隧道（issue #66）：固定域名模式——URL 由设置里的域名拼出（cloudflared 不打印）
          const cfg = typeof getTunnelConfig === 'function' ? (getTunnelConfig() ?? {}) : {};
          if (cfg?.mode === 'named') {
            if (!cfg.token || !cfg.hostname) {
              throw new Error(
                '命名隧道未配置完整：需要 Tunnel Token 和固定域名（设置页「固定域名」里填写） | '
                + 'named tunnel is incomplete — set the Tunnel Token and the fixed hostname in Settings',
              );
            }
            const result = await startNamed({ token: cfg.token, home, signal: controller.signal, onPhase });
            tunnel = { url: `https://${cfg.hostname}`, kill: result.kill, onExit: result.onExit };
          } else {
            const result = await startTunnel({ port: proxy.port, home, signal: controller.signal, onPhase });
            // 归一化：startTunnel 契约返回 {url, kill}（字符串也兼容）
            tunnel = typeof result === 'string' ? { url: result, kill: () => {} } : result;
          }
          tunnelState.phase = 'ready';
          // M1：隧道进程运行中死亡（崩溃/被杀）→ 状态打回，别让 UI 永远显示"可用"
          tunnel.onExit?.((code) => {
            if (controller.signal.aborted) return; // 主动停止（stopTunnel）不算故障
            tunnelState.phase = 'error';
            tunnelState.detail = `隧道进程退出（code=${code}） | tunnel process exited (code=${code})`;
          });
          // 记录「隧道开启中」，供重启后自动恢复（issue #11）
          void persistAutoTunnel();
          // 公网隧道就绪 → 回调（快速模式轮换访问密码；命名模式不轮换，见 lib/index.js）
          try { onTunnelReady?.(cfg?.mode === 'named' ? 'named' : 'quick'); } catch { /* 忽略 */ }
          return tunnel.url;
        } catch (err) {
          // stopTunnel 触发的 abort 不算错误：保持 idle，别把状态刷成 error
          if (!controller.signal.aborted) {
            tunnelState.phase = 'error';
            tunnelState.detail = err?.message ?? String(err);
          }
          tunnelState.startedAt = null; // 失败后清掉计时，避免 UI 误显"启动中"
          throw err;
        } finally {
          // 只清自己的引用：stopTunnel 后立即 startTunnel 可能已建了新的 in-flight
          // （tunnelPromise=B），A 的 finally 不能把 B 清掉，否则第三次调用会并发 spawn
          if (tunnelPromise === p) tunnelPromise = null;
        }
      })();
      tunnelPromise = p;
      return p;
    },

    /**
     * 启动 SSH 反向隧道通道（tunnelMode === 'ssh'）。cloudflared 完全不参与，
     * 访问地址由 accessProtocol/accessHost/accessPort 拼出（见 lib/ssh-channel.mjs）。
     */
    async startSshTunnel() {
      await this.startProxy();
      if (tunnel !== null) stopCloudflared(); // 三通道互斥：拉起 ssh 前先关掉 cloudflared
      tunnelState.startedAt = Date.now();
      tunnelState.phase = 'starting';
      tunnelState.detail = '正在建立 SSH 反向隧道 | starting ssh reverse tunnel…';
      const ch = getSshChannel();
      try {
        ch.start(); // 同步；配置错误（主机缺失/用户名/端口非法）在这里抛出
      } catch (err) {
        resetTunnelState('error', err?.message ?? String(err));
        throw err;
      }
      const outcome = await waitForSshOutcome(ch);
      const st = outcome.status;
      if (!outcome.ok) {
        resetTunnelState('error', st.lastError ?? 'SSH 隧道启动失败 | ssh tunnel failed');
        throw new Error(st.lastError || 'SSH 隧道启动失败 | ssh tunnel failed');
      }
      if (st.state === 'connected') {
        resetTunnelState('ready', 'SSH 反向隧道已就绪 | ssh reverse tunnel ready');
      } else {
        // 仍在连接/重连：如实显示（状态块会随状态机实时更新），不谎报「已就绪」
        resetTunnelState('starting',
          st.state === 'reconnecting' ? 'SSH 连接中断，正在自动重连 | ssh reconnecting…' : 'SSH 正在连接（掉线自动重连）| ssh connecting…');
      }
      // 记录「公网入口开启中」：DSH 重启后按 sshAutoRestore 自动拉起（与 named 同理）
      void persistAutoTunnel();
      try { onTunnelReady?.('ssh'); } catch { /* 回调异常不影响启动 */ }
      return st.url ?? buildAccessUrl(typeof getSshConfig === 'function' ? (getSshConfig() ?? {}) : {});
    },

    /**
     * 「测试连接」（ssh.status 带 test:true）：真实探测一次 SSH 通道。
     * 已在运行 → 直接回报；否则拉起来等一会儿看结论（状态机自己会写 failed/lastError）。
     * 非 ssh 模式下只做一次性探测，拿到结论就把进程收掉——不给别的模式留常驻 ssh。
     * @returns {Promise<{ok:boolean, state:string, message:string|null}>}
     */
    async testSshConnection({ timeoutMs = 4000 } = {}) {
      await this.startProxy();
      const cfg = normalizeSshChannelConfig(typeof getSshConfig === 'function' ? (getSshConfig() ?? {}) : {});
      if (!cfg.host) {
        return { ok: false, state: 'idle', message: 'SSH 主机未配置：请先填写自有服务器的域名或 IP | SSH host is not configured' };
      }
      const ch = getSshChannel();
      const before = ch.status();
      if (before.state === 'connected') return { ok: true, state: 'connected', message: null };
      const probeOnly = tunnelModeNow() !== 'ssh' && !before.running;
      if (!before.running) {
        try {
          ch.start();
        } catch (err) {
          return { ok: false, state: ch.status().state, message: err?.message ?? String(err) };
        }
      }
      const outcome = await waitForSshOutcome(ch, timeoutMs);
      if (probeOnly) stopSshChannel();
      const st = outcome.status;
      if (st.state === 'connected') return { ok: true, state: st.state, message: null };
      return { ok: false, state: st.state, message: st.lastError ?? 'SSH 未在超时时间内连上 | ssh did not connect in time' };
    },

    /**
     * 设置里的模式变了：关掉不再匹配的那条公网通道（三通道互斥）。
     * @returns {'quick'|'named'|'ssh'} 当前模式
     */
    syncTunnelMode() {
      return syncChannelsForMode();
    },

    /**
     * 当前公网入口地址（同步；通知载荷的跳转目标、公网通道判定都用它）。
     * cloudflared 隧道与 ssh 通道互斥，取在跑的那条；都没跑返回 null。
     * @returns {string|null}
     */
    publicUrl() {
      if (tunnel?.url) return tunnel.url;
      const st = sshChannel?.status?.();
      return st?.running ? (st.url ?? null) : null;
    },

    /**
     * 停止公网入口（代理保持；SSH 与 cloudflared 一起停）。
     * @param {{ keepAutoMarker?: boolean }} [opts] - keepAutoMarker=true 用于进程退出/
     *   自重启（dispose / pocketRestart）：隧道是随进程被动消失的，不是用户主动关闭，
     *   必须保留 tunnel-auto.json，下次启动才能自动恢复（issue #11 的本意）。
     *   默认（设置页手动关闭、恢复出厂）删除标记。
     */
    stopTunnel({ keepAutoMarker = false } = {}) {
      stopCloudflared();
      stopSshChannel();
      resetTunnelState();
      if (!keepAutoMarker) void clearAutoTunnel(); // 手动关闭后不再自动恢复
    },

    /** 启动时自动恢复上次开启的公网入口（DSH 重启后子进程被杀，issue #11）。 */
    async restoreTunnelIfNeeded() {
      logInfo('dsh-pocket: auto-restore check | 自动恢复检查：读取上次隧道状态');
      if (!autoStatePath || tunnel || tunnelPromise || sshChannel?.status?.().running) return;
      const mode = tunnelModeNow();
      // ssh 与 named 都是固定地址，适合常驻；用户关掉 sshAutoRestore 时尊重设置。
      if (mode === 'ssh') {
        const cfg = normalizeSshChannelConfig(typeof getSshConfig === 'function' ? (getSshConfig() ?? {}) : {});
        if (!cfg.autoRestore) {
          logInfo('dsh-pocket: ssh auto-restore disabled by setting | SSH 自动恢复已被设置关闭');
          return;
        }
        if (!cfg.host) {
          logWarn('dsh-pocket: ssh host not configured — skip auto-restore | SSH 主机未配置，跳过自动恢复');
          return;
        }
      }
      let has = false;
      try {
        const raw = await readFile(autoStatePath, 'utf8');
        has = /"at"\s*:/.test(raw);
      } catch { return; } // 无标记 → 不恢复
      if (!has) return;
      logInfo('dsh-pocket: auto-restore: marker found, starting tunnel | 发现上次开启标记，尝试自动恢复');
      try {
        await this.startTunnel();
        logInfo('dsh-pocket: public tunnel auto-restored | 已自动恢复公网隧道');
      } catch (err) {
        // 恢复失败保留标记（下次启动再试）；网络问题见 README 排障
        logWarn('dsh-pocket: tunnel auto-restore failed | 自动恢复隧道失败: %s', err?.message ?? err);
      }
    },

    /** 状态快照（RPC 返回，不含敏感信息；二维码 data URL 本地生成 + 缓存）。 */
    async status() {
      const lan = await getLan();
      const proxyPort = proxy?.port ?? null;
      const lanUrl = lan && proxyPort ? `http://${lan}:${proxyPort}` : null;
      const lanIpOverride = getLanOverride();
      const lanCandidates = [...new Set(await getLanCandidates())];
      if (lanIpOverride && !lanCandidates.includes(lanIpOverride)) lanCandidates.push(lanIpOverride);
      const ssh = sshStatusView();
      const sshCfg = ssh.config;
      const sshUrl = ssh.url ?? null;
      return {
        proxyRunning: proxy !== null,
        proxyPort,
        lanUrl,
        lanQr: await qrCached(lanUrl),
        lanCandidates,
        lanIpOverride,
        // 公网出口 = cloudflared 或 ssh（三者互斥），tunnelUrl 仍只表示 cloudflared 的地址
        tunnelRunning: tunnel !== null || ssh.running === true,
        tunnelUrl: tunnel?.url ?? null,
        tunnelQr: await qrCached(tunnel?.url ?? null),
        tunnelState: { ...tunnelState },
        // 隧道配置脱敏视图（issue #66）：token 永不回显，只有 tokenSet 布尔值
        tunnelConfig: (() => {
          const cfg = typeof getTunnelConfig === 'function' ? (getTunnelConfig() ?? {}) : {};
          return {
            mode: cfg?.mode === 'named' ? 'named' : cfg?.mode === 'ssh' ? 'ssh' : 'quick',
            hostname: typeof cfg?.hostname === 'string' ? cfg.hostname : '',
            tokenSet: Boolean(cfg?.token),
          };
        })(),
        // SSH 通道状态（第三通道）：私钥只回 keyPathSet，绝不回原文
        ssh: {
          running: ssh.running === true,
          state: ssh.state,
          url: sshUrl,
          qr: await qrCached(sshUrl),
          lastError: ssh.lastError ?? null,
          // connected 的证据：'forward-ok'（看到就绪行）/ 'grace'（无 stderr 兜底）/ null
          evidence: ssh.evidence ?? null,
          config: {
            host: sshCfg.host,
            port: sshCfg.port,
            user: sshCfg.user,
            keyPathSet: sshCfg.keyPath.length > 0,
            remoteBindHost: sshCfg.remoteBindHost,
            remoteBindPort: sshCfg.remoteBindPort,
            accessProtocol: sshCfg.accessProtocol,
            accessHost: sshCfg.accessHost,
            accessPort: sshCfg.accessPort,
            autoRestore: sshCfg.autoRestore,
          },
        },
        // 通知 / 通行密钥区块由 lib/index.js 注入（缺省为 null：旧宿主/测试不崩）
        notify: typeof getNotifyStatus === 'function' ? (getNotifyStatus() ?? null) : null,
        passkey: typeof getPasskeyStatus === 'function' ? (getPasskeyStatus() ?? null) : null,
        dshPort,
      };
    },

    /** 停止一切（插件卸载时）。进程退出不是用户手动关闭：保留自动恢复标记。 */
    async dispose() {
      this.stopTunnel({ keepAutoMarker: true });
      if (proxy) {
        const p = proxy;
        proxy = null;
        try { await p.close(); } catch { /* server 已关闭等边缘情况 */ }
      }
    },
  };
}
