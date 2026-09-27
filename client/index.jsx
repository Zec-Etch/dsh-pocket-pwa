// dsh-pocket 网页客户端：
//   1. 设置页签「手机访问」（局域网/公网二维码 + 更新/重启提示）
//   2. 移动端适配（移植自 MIT 项目 dsh-web-mobile，见 client/mobile/LICENSE.dsh-web-mobile）
//
// 手机扫码打开的就是电脑上的 dsh web，实时同步；窄屏自动变成抽屉布局。
//
// 注：本页的 Web Push 走宿主注入的 window.dshPocketPush（/pocket-pwa.js）——
// 订阅/取消必须在用户手势里发起，通知本身由宿主的 /sw.js 显示。

import { createElement as h, useEffect, useRef, useState } from 'react';

import { POCKET_RPC_CHANNEL, POCKET_ENDPOINTS, MOBILE_RIGHTBAR_ATTRIBUTE, MOBILE_RIGHTBAR_EVENT, redactStatus, compareVersions, buildAccessUrl } from './api.js';
import { mobileApply } from './mobile/mobile-apply.tsx';
import { NS as POCKET_NS, zh as POCKET_ZH, en as POCKET_EN } from './pocket-locales.js';

const name = 'dsh-pocket';
const inject = ['slots', 'connection', 'layout', 'locale', 'sessionLogDownload'];

// 词典在 pocket-locales.js；这里只做「取 key → 替换 {占位符} → 字符串」。
// 不依赖 DSH t() 的插值能力，避免行为不一致。
function fmt(t, key, vars) {
  let s = t(key);
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = String(s).split(`{${k}}`).join(String(v));
    }
  }
  return s;
}

// 官方 DeepSeek Harness 设计系统（dsh-client-ui-theme design-platform.css）：
// 按钮 md=36px 胶囊形 / sm=28px；品牌色 --dsw-alias-brand-primary；
// hover 走 --dsw-alias-button-*-hover；间距 4px 栅格；正文 13px。
const styles = {
  card: { background: 'var(--dsw-alias-bg-layer-1,#fff)', border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', borderRadius: 12, padding: '16px 20px', maxWidth: 480 },
  block: { borderTop: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', marginTop: 16, paddingTop: 16 },
  muted: { color: 'var(--dsw-alias-label-tertiary,#8b93a1)', fontSize: 12, lineHeight: 1.5 },
  code: { fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 12, wordBreak: 'break-all', margin: '6px 0 10px', color: 'var(--dsw-alias-label-primary,inherit)' },
  // 主按钮：官方 md 胶囊形（36px）
  primary: { font: 'inherit', cursor: 'pointer', border: 'none', background: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary,#4f6ef7))', color: 'var(--dsw-alias-label-primary-foreground, #fff)', height: 36, padding: '0 16px', borderRadius: 999, fontSize: 13, fontWeight: 500, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
  // 次级按钮：官方 outline/ghost 胶囊形
  btn: { font: 'inherit', cursor: 'pointer', border: '1px solid var(--dsw-alias-button-ghost-active-border, var(--dsw-alias-border-l2,#d1d5db))', background: 'var(--dsw-alias-bg-layer-1,#fff)', color: 'var(--dsw-alias-label-primary,inherit)', height: 36, padding: '0 16px', borderRadius: 999, fontSize: 13, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
  qr: { width: 220, height: 220, borderRadius: 10, border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', margin: '8px 0' },
  warn: { color: 'var(--dsw-alias-state-warn-primary,#b45309)', fontSize: 12, lineHeight: 1.5 },
  // 表单输入：窄屏单列，宽度收在卡片内不溢出（box-sizing 必须有，否则 padding 撑破 320px）
  input: {
    boxSizing: 'border-box', width: '100%', maxWidth: 260, padding: '6px 8px', fontSize: 13, font: 'inherit',
    border: '1px solid var(--dsw-alias-border-l2,#d1d5db)', borderRadius: 6, outline: 'none',
    background: 'var(--dsw-alias-bg-layer-1,#fff)', color: 'var(--dsw-alias-label-primary,inherit)',
  },
  select: {
    boxSizing: 'border-box', width: '100%', maxWidth: 260, height: 30, padding: '0 8px', fontSize: 13, font: 'inherit',
    border: '1px solid var(--dsw-alias-border-l2,#d1d5db)', borderRadius: 6,
    background: 'var(--dsw-alias-bg-layer-1,#fff)', color: 'var(--dsw-alias-label-primary,inherit)',
  },
  // 小按钮（行内操作：复制/测试/重命名…）：与现有 26px 高度一致
  miniBtn: { font: 'inherit', cursor: 'pointer', border: '1px solid var(--dsw-alias-button-ghost-active-border, var(--dsw-alias-border-l2,#d1d5db))', background: 'var(--dsw-alias-bg-layer-1,#fff)', color: 'var(--dsw-alias-label-primary,inherit)', height: 26, padding: '0 10px', borderRadius: 999, fontSize: 12, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
  smallBtn: { font: 'inherit', cursor: 'pointer', border: '1px solid var(--dsw-alias-button-ghost-active-border, var(--dsw-alias-border-l2,#d1d5db))', background: 'var(--dsw-alias-bg-layer-1,#fff)', color: 'var(--dsw-alias-label-primary,inherit)', height: 28, padding: '0 12px', borderRadius: 999, fontSize: 12, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
  btnRow: { display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end', minWidth: 0 },
};

// ── 第三通道 SSH / 通知 / 通行密钥的静态表（task-6）─────────────────────────
// SSH 状态机（lib/ssh.mjs 冻结契约）→ 文案 key。用表而不是内联三元，好让
// test/locales.test.js 静态校验每个 key 都在词典里。
const SSH_STATE_TEXT = {
  idle: 'sshStateIdle',
  starting: 'sshStateStarting',
  connected: 'sshStateConnected',
  reconnecting: 'sshStateReconnecting',
  failed: 'sshStateFailed',
  stopped: 'sshStateStopped',
};

// Webhook 预设（lib/webhook.mjs 的 preset 取值）→ 文案 key
const NOTIFY_PRESETS = [
  ['generic', 'notifyPresetGeneric'],
  ['wecom', 'notifyPresetWecom'],
  ['dingtalk', 'notifyPresetDingtalk'],
  ['feishu', 'notifyPresetFeishu'],
  ['ntfy', 'notifyPresetNtfy'],
  ['bark', 'notifyPresetBark'],
];

/** 输入框里的整数：空/非法回退默认值（避免把 NaN 发给宿主）。 */
function intField(value, fallback) {
  const n = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

/** 时间戳 → 本地可读时间；缺失/非法显示占位文本。 */
function fmtTime(ts, fallback) {
  const n = typeof ts === 'number' ? ts : Number(ts);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  try { return new Date(n).toLocaleString(); } catch { return fallback; }
}

/** WebAuthn 能力探测：安全上下文优先（Chrome 在非安全上下文会隐藏 PublicKeyCredential）。 */
function detectWebAuthn() {
  try {
    if (typeof window === 'undefined') return { supported: false, secure: false };
    return {
      supported: typeof window.PublicKeyCredential === 'function',
      secure: window.isSecureContext === true,
    };
  } catch {
    return { supported: false, secure: false };
  }
}

function applyMobileRightbarSetting(enabled) {
  const on = enabled !== false;
  document.body?.setAttribute(MOBILE_RIGHTBAR_ATTRIBUTE, on ? 'on' : 'off');
  window.dispatchEvent(new CustomEvent(MOBILE_RIGHTBAR_EVENT, { detail: { enabled: on } }));
}

function PocketSettingsTab({ rpcCall, t }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [tunnelState, setTunnelState] = useState(null); // 隧道进度 {phase, detail, startedAt}
  const [restartNotice, setRestartNotice] = useState(false); // 重启后提示
  const [updateInfo, setUpdateInfo] = useState(null); // { current, latest, updating, result, startedAt } | null
  const [isDesktop, setIsDesktop] = useState(false); // DSH Desktop（Electron）环境：更新/重启由桌面版管理
  const [now, setNow] = useState(Date.now()); // 每秒 tick，驱动倒计时

  // 进行中操作的「已等待 X 秒」倒计时
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const elapsed = (startedAt) => (startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0);

  const call = async (endpoint, payload) => {
    const res = await rpcCall(endpoint, payload);
    if (!res?.ok) throw new Error(res?.error?.message ?? 'RPC failed');
    return res.value;
  };

  const load = async () => {
    try {
      const s = await call(POCKET_ENDPOINTS.status, {});
      setStatus(s);
      applyMobileRightbarSetting(s.mobileRightbarEnabled);
      setTunnelState(s.tunnelState ?? null);
      // 宿主注入的 /pocket-pwa.js 可能比本组件晚到：每轮轮询都重探一次浏览器能力
      refreshBrowserCapabilities();
      if (s.desktop) setIsDesktop(true);
      if (s.restartNotice) {
        // 新进程确认起来了：显示一次「已重启」，清掉旧的更新横幅（单状态，不并存），
        // 然后自动刷新页面加载新代码——不用用户手动刷新
        setRestartNotice(true);
        setUpdateInfo(null);
        if (!sessionStorage.getItem('dshp-auto-reloaded')) {
          sessionStorage.setItem('dshp-auto-reloaded', '1');
          setTimeout(() => { try { location.reload(); } catch { /* 忽略 */ } }, 2000);
        }
      }
    } catch { /* 忽略瞬时失败 */ }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);

  // 每次页面加载清掉自动刷新标记——这样下次重启（更新后）才能再次触发自动刷新
  useEffect(() => {
    try { sessionStorage.removeItem('dshp-auto-reloaded'); } catch { /* 忽略 */ }
  }, []);

  // 版本检测：host 当前版本 vs npm registry latest（registry 带 CORS *）
  // 两种情况显示横幅：① 有新版可更新；② 磁盘已更新但进程还是旧代码（重启生效）
  // cache: 'no-store' —— registry 响应带缓存头，浏览器会缓存旧版本号导致「小版本不提示」
  // 周期重查（每 5 分钟）：npm registry 的 /latest 走 CDN 边缘缓存，刚发布后打开页面
  // 可能拿到旧版本号——周期性重查让更新提示在缓存刷新后自动出现，不用重开页面。
  // 桌面端（isDesktop）：更新/重启由 DSH Desktop 管理，这里不做版本检测、不显示更新横幅
  useEffect(() => {
    if (isDesktop) return;
    let alive = true;
    const check = async () => {
      try {
        const v = await call(POCKET_ENDPOINTS.version, {});
        const meta = await (await fetch('https://registry.npmjs.org/dsh-pocket/latest', { cache: 'no-store' })).json();
        if (!alive) return;
        const latest = typeof meta?.version === 'string' ? meta.version : null;
        if (latest && v.current && compareVersions(latest, v.current) > 0) {
          setUpdateInfo({ current: v.current, latest, updating: false, result: null });
        } else if (v.current && v.loaded && compareVersions(v.current, v.loaded) > 0) {
          // 已更新未重启：显示「已更新，重启生效」+ 重启按钮
          setUpdateInfo({ current: v.current, latest: v.current, updating: false, result: 'ok', updated: true });
        }
      } catch { /* 网络失败静默 */ }
    };
    check();
    const t = setInterval(check, 5 * 60 * 1000);
    return () => { alive = false; clearInterval(t); };
  }, [isDesktop]);

  // 重启宿主（更新生效必需：刷新页面不会重载服务端代码）
  const restartPocket = async () => {
    setUpdateInfo((u) => ({ ...u, restarting: true, startedAt: Date.now() }));
    try {
      // 宿主 500ms 后自杀，RPC 响应可能来不及送达 → 3 秒超时兜底，别让按钮永远卡「重启中…」
      await Promise.race([
        call(POCKET_ENDPOINTS.restart, {}),
        new Promise((_, rej) => setTimeout(() => rej(new Error('restart requested (no reply within 3s)')), 3000)),
      ]);
      setUpdateInfo((u) => ({ ...u, restarting: true, result: 'ok' }));
    } catch (err) {
      // 网络断连/超时同样视为「已请求重启」——旧进程即将退出，等新进程起来后刷新即可
      const msg = String(err?.message ?? '');
      if (/connection|socket|fetch|network|abort|cancelled|ECONN|disconnect|closed|timeout/i.test(msg)) {
        setUpdateInfo((u) => ({ ...u, restarting: true, result: 'ok' }));
        return;
      }
      setUpdateInfo((u) => ({ ...u, restarting: false, result: 'fail', output: err.message }));
    }
  };

  // 一键更新：调宿主 dsh plugin update（成功后宿主自动重启生效，用户只点一次）
  const runUpdate = async () => {
    setUpdateInfo((u) => ({ ...u, updating: true, result: null, startedAt: Date.now() }));
    try {
      const r = await call(POCKET_ENDPOINTS.update, {});
      setUpdateInfo((u) => ({
        ...u,
        updating: false,
        result: r.ok ? 'ok' : 'fail',
        autoRestart: r.autoRestart === true,
        output: r.output ?? r.error,
      }));
    } catch (err) {
      setUpdateInfo((u) => ({ ...u, updating: false, result: 'fail', output: err.message }));
    }
  };

  // 安全免责声明（issue #31）：每次开启公网都必须先弹框勾选「我已知情」。
  // 服务端同样强制（tunnel.start 需 disclaimer: true），防绕过前端直接调 RPC。

  const [disclaimerOpen, setDisclaimerOpen] = useState(false);
  const [disclaimerChecked, setDisclaimerChecked] = useState(false);

  const doStartTunnel = async () => {
    // 命名隧道模式：Token/域名没配齐就不发起（服务端同样会拒绝）
    const cfg = status?.tunnelConfig;
    if (cfg?.mode === 'named' && (!cfg.hostname || !cfg.tokenSet)) {
      setError(t('namedNeedCfg'));
      return;
    }
    // SSH 通道：主机/用户名没填齐就不发起（服务端同样会拒绝）
    if (cfg?.mode === 'ssh' && (!status?.ssh?.config?.host || !status?.ssh?.config?.user)) {
      setError(t('sshNeedCfg'));
      return;
    }
    setBusy(true);
    setError(null);
    setTunnelState({ phase: 'starting', detail: '正在开启…', startedAt: Date.now() });
    try {
      setStatus(await call(POCKET_ENDPOINTS.tunnelStart, { disclaimer: true }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const startTunnel = () => {
    // 每次开启都弹免责确认（勾选后才能继续）
    setDisclaimerChecked(false);
    setDisclaimerOpen(true);
  };
  const confirmDisclaimer = () => {
    if (!disclaimerChecked) return; // 未勾选不允许
    setDisclaimerOpen(false);
    doStartTunnel();
  };

  const stopTunnel = async () => {
    try { setStatus(await call(POCKET_ENDPOINTS.tunnelStop, {})); } catch { /* 忽略 */ }
  };

  // 公网模式（issue #66）：随机域名（默认零配置）/ 固定域名（Cloudflare 命名隧道 + Tunnel Token）
  // tunnelCfg：编辑态 { hostname, token, err } | null；token 输入留空 = 保持已存的 Token 不变
  const [tunnelCfg, setTunnelCfg] = useState(null);
  const switchToQuick = async () => {
    try { setStatus(await call(POCKET_ENDPOINTS.tunnelSetConfig, { mode: 'quick' })); } catch (err) { setError(err.message); }
  };
  const saveNamedTunnel = async () => {
    try {
      setStatus(await call(POCKET_ENDPOINTS.tunnelSetConfig, {
        mode: 'named',
        hostname: tunnelCfg?.hostname ?? '',
        token: tunnelCfg?.token || undefined, // 留空不覆盖已存 Token
      }));
      setTunnelCfg(null);
    } catch (err) {
      setTunnelCfg((c) => ({ ...c, err: err.message }));
    }
  };

  // 恢复出厂设置：清本机设置 + 重设随机密码（弹窗确认；RPC 端也强制校验 confirm）
  const [resetOpen, setResetOpen] = useState(false);
  const doFactoryReset = async () => {
    setResetOpen(false);
    setBusy(true);
    setError(null);
    try {
      const next = await call(POCKET_ENDPOINTS.pocketReset, { confirm: true });
      setStatus(next);
      applyMobileRightbarSetting(next.mobileRightbarEnabled);
      setTunnelCfg(null);
      setCustomPin(null);
      setAdvOpen(false);
      showToast(t('resetDone'));
    } catch (err) {
      setError(err.message);
      showToast(t('resetFailed'));
    } finally {
      setBusy(false);
    }
  };

  // 刷新局域网访问密码（旧密码立即作废）
  const refreshLanPin = async () => {
    try {
      const r = await call(POCKET_ENDPOINTS.lanTokenRefresh, {});
      setStatus((s) => ({ ...s, lanToken: r.lanToken }));
    } catch { /* 忽略 */ }
  };

  // 局域网访问密码开关（issue #24）：默认开启；关闭后局域网扫码直连（公网不受影响）
  const setLanAuth = async (on) => {
    try {
      const r = await call(POCKET_ENDPOINTS.lanAuthSetEnabled, { on });
      setStatus((s) => ({ ...s, lanAuthEnabled: r.lanAuthEnabled }));
    } catch { /* 忽略 */ }
  };

  const setMobileRightbar = async (on) => {
    try {
      const r = await call(POCKET_ENDPOINTS.mobileRightbarSetEnabled, { on });
      const enabled = r.mobileRightbarEnabled === true;
      setStatus((s) => ({ ...s, mobileRightbarEnabled: enabled }));
      applyMobileRightbarSetting(enabled);
    } catch (err) {
      setError(err.message);
    }
  };

  // 局域网访问总开关：关闭后局域网扫码/链接直接失效（公网不受影响）。
  // 切换前弹窗确认（弹窗提醒）；服务端用 setLanEnabled 持久化，代理按 Host 实时拦截。
  const [lanToggleOpen, setLanToggleOpen] = useState(null); // null | true | false（目标 on 状态）
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

  // 局域网地址手动覆盖（Tailscale/VPN 等远程访问场景）：空值恢复自动选择
  const setLanAddress = async (ip) => {
    try {
      setStatus(await call(POCKET_ENDPOINTS.lanSetOverride, { ip }));
    } catch (err) {
      setError(err.message);
    }
  };

  // 自定义访问密码（issue #33）：公网/局域网各自设固定 8–64 位密码（英文字母大小写或数字）；自定义后公网不再自动轮换。
  // customPin: { which: 'public'|'lan', value, err } | null —— 正在输入自定义密码的区块
  const [customPin, setCustomPin] = useState(null);
  const saveCustomPin = async (which) => {
    try {
      const r = await call(POCKET_ENDPOINTS.pinSetCustom, { which, value: customPin?.value ?? '' });
      setStatus((s) => ({
        ...s,
        accessToken: which === 'public' ? r.pin : s.accessToken,
        lanToken: which === 'lan' ? r.pin : s.lanToken,
        publicPinCustom: which === 'public' ? true : s.publicPinCustom,
        lanPinCustom: which === 'lan' ? true : s.lanPinCustom,
      }));
      setCustomPin(null);
    } catch (err) {
      setCustomPin((c) => ({ ...c, err: err.message }));
    }
  };
  // 渲染自定义输入行（共用）：输入框 + 保存/取消
  const customPinRow = (which) => h('div', { style: { marginTop: 6, fontSize: 12, color: 'var(--dsw-alias-label-secondary,#6b7280)', lineHeight: 1.5 } },
    t('customizing'),
    h('input', {
      style: { width: 130, margin: '0 6px', padding: '4px 8px', fontSize: 14, letterSpacing: 1, textAlign: 'center', border: '1px solid var(--dsw-alias-border-l2,#d1d5db)', borderRadius: 6, outline: 'none' },
      type: 'password',
      minLength: 8,
      maxLength: 64,
      value: customPin?.value ?? '',
      autoFocus: true,
      onChange: (e) => setCustomPin((c) => ({ ...c, value: e.target.value.replace(/[^a-zA-Z0-9]/g, ''), err: null })),
      onKeyDown: (e) => { if (e.key === 'Enter') saveCustomPin(which); if (e.key === 'Escape') setCustomPin(null); },
    }),
    h('button', { style: { ...styles.btn, height: 26, padding: '0 10px', fontSize: 12, marginLeft: 2 }, onClick: () => saveCustomPin(which) }, t('save')),
    h('button', { style: { ...styles.btn, height: 26, padding: '0 10px', fontSize: 12 }, onClick: () => setCustomPin(null) }, t('cancel')),
    customPin?.err ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary,#dc2626)', marginTop: 4 } }, errText(customPin.err)) : null,
  );
  // 「自定义」按钮（非输入态显示在密码行末尾）
  const customBtn = (which) => h('button', { style: { ...styles.btn, height: 26, padding: '0 10px', fontSize: 12, marginLeft: 8 }, onClick: () => setCustomPin({ which, value: '', err: null }) }, t('customize'));

  const lanUrl = status?.lanUrl;
  const tunnelUrl = status?.tunnelUrl;
  const tunnelPhase = tunnelState?.phase ?? 'idle';
  const tunnelStarting = ['downloading', 'starting', 'registering'].includes(tunnelPhase);
  const tunnelStateDetail = tunnelState?.detail ?? '';
  const tunnelStateStarted = tunnelState?.startedAt ?? null;
  // 公网模式视图（issue #66）：{ mode, hostname, tokenSet }
  const tunnelModeView = status?.tunnelConfig ?? { mode: 'quick', hostname: '', tokenSet: false };
  const namedMode = tunnelModeView.mode === 'named';
  // 模式按钮选中态高亮：固定域名模式本身，或正在编辑固定域名配置，都视为「选中」
  const namedActive = namedMode || tunnelCfg !== null;
  // 后端错误消息统一为「中文 | English」混排；按当前界面语言只显示对应一半
  const errText = (msg) => {
    const s = String(msg ?? '');
    const i = s.indexOf(' | ');
    if (i < 0) return s;
    return (t('ok') === POCKET_ZH.ok ? s.slice(0, i) : s.slice(i + 3)).trim();
  };
  // 轻量 Toast：操作成功/失败后短暂提示（自动消失，不打断操作）
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const showToast = (text) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  };
  useEffect(() => () => clearTimeout(toastTimer.current), []);
  const modeBtnStyle = (active) => ({
    ...styles.btn, height: 28, padding: '0 12px', fontSize: 12,
    fontWeight: active ? 600 : 400,
    background: active ? 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary,#4f6ef7))' : 'var(--dsw-alias-bg-layer-1,#fff)',
    color: active ? 'var(--dsw-alias-label-primary-foreground, #fff)' : 'var(--dsw-alias-label-primary,inherit)',
  });
  // iOS 风格小开关（重排后统一用：局域网总开关 / 局域网密码开关）
  const Switch = (on, onClick) => h('button', {
    role: 'switch', 'aria-checked': !!on,
    style: { flexShrink: 0, width: 40, height: 22, borderRadius: 11, border: 'none', padding: 0, position: 'relative', cursor: 'pointer', font: 'inherit', background: on ? 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary,#4f6ef7))' : 'var(--dsw-alias-border-l2,#d1d5db)' },
    onClick,
  }, h('span', { style: { position: 'absolute', top: 2, left: on ? 20 : 2, width: 18, height: 18, borderRadius: '50%', background: '#fff' } }));
  // 卡片内主内容：二维码 + 地址 + 提示
  const qrArea = (src, url, hint) => h('div', { style: { background: 'var(--dsw-alias-bg-layer-2,#f3f4f6)', borderRadius: 10, padding: '10px 12px', textAlign: 'center', margin: '10px 0' } },
    h('img', { src, alt: 'QR', style: styles.qr }),
    h('div', { style: styles.code }, url),
    h('div', { style: styles.muted }, hint));
  // 设置行：上分隔线，内部第一行 = 左标签 + 右操作；extra 作为第二段渲染
  const row = (label, control, extra) => h('div', { style: { borderTop: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', paddingTop: 9, marginTop: 9 } },
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
      h('span', { style: { fontSize: 13 } }, label), control), extra ?? null);
  // 高级（手动选地址）展开态
  const [advOpen, setAdvOpen] = useState(false);

  // ══ 第三通道 SSH（task-6）════════════════════════════════════════════════
  // 公网入口三选一：quick / named / ssh（宿主 tunnelMode 互斥）。旧宿主不返回
  // status.ssh 时只降级提示，不影响 Quick/Named 现有行为。
  const [sshCfg, setSshCfg] = useState(null); // 编辑态；null = 直接回显宿主配置
  const [sshTestResult, setSshTestResult] = useState(null); // { ok, state, message, unavailable }
  const [sshTesting, setSshTesting] = useState(false);

  const publicMode = tunnelModeView?.mode === 'ssh' ? 'ssh' : (tunnelModeView?.mode === 'named' ? 'named' : 'quick');
  const sshView = status?.ssh ?? null; // null = 旧宿主不返回该字段
  const sshRunning = sshView?.running === true;
  const sshMode = publicMode === 'ssh';
  const sshState = typeof sshView?.state === 'string' ? sshView.state : 'idle';
  const sshStateKey = SSH_STATE_TEXT[sshState] ?? SSH_STATE_TEXT.idle;
  const sshEdit = sshCfg !== null;
  const sshActive = sshEdit || sshMode || sshRunning;
  const sshStarting = sshState === 'starting' || sshState === 'reconnecting';
  const sshConfigView = sshView?.config ?? {};
  // 访问地址：宿主给的 url 优先，否则按 accessProtocol + accessHost(+accessPort) 本地拼
  const sshAddress = sshView?.url ?? buildAccessUrl(sshConfigView);
  // SSH 表单：编辑态用本地值，否则回显宿主已保存的配置
  const sshForm = sshCfg ?? {
    host: sshConfigView.host ?? '',
    port: String(sshConfigView.port ?? 22),
    user: sshConfigView.user ?? '',
    keyPath: '',
    remoteBindPort: String(sshConfigView.remoteBindPort ?? 7788),
    accessProtocol: sshConfigView.accessProtocol === 'http' ? 'http' : 'https',
    accessHost: sshConfigView.accessHost ?? '',
    accessPort: String(sshConfigView.accessPort ?? 0),
    autoRestore: sshConfigView.autoRestore !== false,
    err: null,
  };
  // 公网是否有出口在跑（Quick/Named 的 tunnelUrl 或 SSH 的 running）
  const publicRunning = !!tunnelUrl || sshRunning;

  const patchSshForm = (patch) => setSshCfg((c) => ({ ...(c ?? sshForm), ...patch, err: null }));
  const openSshEditor = () => {
    setTunnelCfg(null);
    setSshTestResult(null);
    setSshCfg({
      host: sshConfigView.host ?? '',
      port: String(sshConfigView.port ?? 22),
      user: sshConfigView.user ?? '',
      keyPath: '',
      remoteBindPort: String(sshConfigView.remoteBindPort ?? 7788),
      accessProtocol: sshConfigView.accessProtocol === 'http' ? 'http' : 'https',
      accessHost: sshConfigView.accessHost ?? '',
      accessPort: String(sshConfigView.accessPort ?? 0),
      autoRestore: sshConfigView.autoRestore !== false,
      err: null,
    });
  };
  // 宿主返回完整 status（同 tunnel.setConfig）时整体替换；返回区块对象时合并，两种都不崩
  const mergeStatus = (next) => {
    if (!next || typeof next !== 'object' || Array.isArray(next)) return;
    setStatus((s) => ({ ...(s ?? {}), ...next }));
  };
  const saveSshConfig = async () => {
    const f = sshForm;
    const host = String(f.host ?? '').trim();
    const user = String(f.user ?? '').trim();
    if (!host || !user) {
      setSshCfg((c) => ({ ...(c ?? f), err: t('sshNeedCfg') }));
      return;
    }
    try {
      const next = await call(POCKET_ENDPOINTS.sshSetConfig, {
        mode: 'ssh', // 保存 SSH 配置即把公网入口切到 ssh（与 quick/named 互斥）
        host,
        user,
        port: intField(f.port, 22),
        keyPath: String(f.keyPath ?? '').trim(), // 空 = 用默认 ssh 配置
        remoteBindPort: intField(f.remoteBindPort, 7788),
        accessProtocol: f.accessProtocol === 'http' ? 'http' : 'https',
        accessHost: String(f.accessHost ?? '').trim(),
        accessPort: intField(f.accessPort, 0),
        autoRestore: f.autoRestore !== false,
      });
      mergeStatus(next);
      setSshCfg(null); // 回到回显态（值以宿主返回为准）
      showToast(t('sshSaved'));
    } catch (err) {
      setSshCfg((c) => ({ ...(c ?? f), err: err.message }));
    }
  };
  // 测试连接：ssh.status 带 test:true，宿主应做一次真实探测并回 test:{ok,message}；
  // 不支持探测的宿主只回状态 → 按状态如实显示，不谎报「连接正常」。
  const testSshConnection = async () => {
    setSshTesting(true);
    setSshTestResult(null);
    try {
      const r = await call(POCKET_ENDPOINTS.sshStatus, { test: true });
      if (r && typeof r === 'object') {
        if (r.ssh && typeof r.ssh === 'object') mergeStatus({ ssh: r.ssh });
        else if ('running' in r || 'state' in r) mergeStatus({ ssh: { ...(status?.ssh ?? {}), ...r } });
      }
      const probe = r?.test && typeof r.test === 'object' ? r.test : null;
      if (probe) setSshTestResult({ ok: probe.ok === true, message: probe.message ?? probe.error ?? null });
      else if (r?.running === true || r?.state === 'connected') setSshTestResult({ ok: true, message: null });
      else if (typeof r?.state === 'string') setSshTestResult({ ok: false, state: r.state, message: r.lastError ?? null });
      else setSshTestResult({ ok: false, unavailable: true, message: null });
    } catch (err) {
      setSshTestResult({ ok: false, message: err.message });
    } finally {
      setSshTesting(false);
    }
  };

  // 模式切换（互斥）：Quick 直接切回；Named/SSH 先展开配置表单，保存后才切换
  const selectQuick = () => {
    setTunnelCfg(null);
    setSshCfg(null);
    if (publicMode !== 'quick') switchToQuick();
  };
  const selectNamed = () => {
    setSshCfg(null);
    setTunnelCfg(tunnelCfg ? null : { hostname: tunnelModeView.hostname ?? '', token: '', err: null });
  };
  const selectSsh = () => {
    setTunnelCfg(null);
    if (!sshCfg) openSshEditor();
  };
  // 表单排版：标签在上、控件在下（窄屏单列，不依赖 hover，不横向挤压）。
  // 用 div 而不是 label：内部可能放 Switch 按钮，label 会把点击转发给它造成误触。
  const sshField = (label, node, hint) => h('div', { style: { marginTop: 9, fontSize: 12, color: 'var(--dsw-alias-label-secondary,#6b7280)', lineHeight: 1.5 } },
    h('div', { style: { marginBottom: 3 } }, label),
    node,
    hint ? h('div', { style: { ...styles.muted, marginTop: 2 } }, hint) : null);
  const sshInput = (value, onChange, extra) => h('input', {
    style: styles.input, value: value ?? '', autoComplete: 'off', onChange: (e) => onChange(e.target.value), ...extra,
  });
  const COLOR_OK = 'var(--dsw-alias-state-success-primary,#15803d)';
  const COLOR_ERR = 'var(--dsw-alias-state-error-primary,#dc2626)';
  // SSH 区块（选中 SSH / 正在编辑时渲染）：状态与阶段 → 地址/二维码 → 配置表单 → 操作按钮
  const sshSection = !sshActive ? null : h('div', { style: { marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--dsw-alias-border-l2,#e5e7eb)' } },
    h('span', { style: { fontWeight: 600, fontSize: 13 } }, t('sshTitle')),
    h('div', { style: { ...styles.muted, marginTop: 4 } }, t('sshHint')),
    // 运行状态与阶段
    h('div', { style: { marginTop: 8, fontSize: 12, lineHeight: 1.5, wordBreak: 'break-word', color: sshState === 'connected' ? COLOR_OK : (sshState === 'failed' ? COLOR_ERR : 'var(--dsw-alias-label-secondary,#6b7280)') } },
      t(sshStateKey)),
    sshView?.lastError ? h('div', { style: { ...styles.warn, marginTop: 4, wordBreak: 'break-word' } }, fmt(t, 'sshLastError', { err: errText(sshView.lastError) })) : null,
    sshTestResult ? h('div', { style: { marginTop: 4, fontSize: 12, lineHeight: 1.5, wordBreak: 'break-word', color: sshTestResult.ok ? COLOR_OK : COLOR_ERR } },
      sshTestResult.ok
        ? t('sshTestOk')
        : sshTestResult.unavailable
          ? t('sshTestUnavailable')
          : sshTestResult.state
            ? t(SSH_STATE_TEXT[sshTestResult.state] ?? SSH_STATE_TEXT.idle)
            : fmt(t, 'sshTestFail', { err: errText(sshTestResult.message) || t('unknownError') })) : null,
    // 地址与二维码：运行且有二维码时优先展示，否则只显示地址 + 复制
    sshRunning && sshAddress && sshView?.qr
      ? qrArea(sshView.qr, sshAddress, t('sshRunningHint'))
      : (sshAddress
        ? h('div', { style: { marginTop: 8 } },
          h('div', { style: styles.code }, sshAddress),
          h('div', null, h('button', { style: styles.miniBtn, onClick: () => copyText(sshAddress) }, t('copy'))),
          h('div', { style: { ...styles.muted, marginTop: 4 } }, t('sshUrlHint')))
        : null),
    // 配置表单
    h('div', null,
      !sshView ? h('div', { style: { ...styles.warn, marginTop: 8 } }, t('hostUnsupported')) : null,
      (sshView || sshEdit) ? h('div', null,
        sshField(t('sshHost'), sshInput(sshForm.host, (v) => patchSshForm({ host: v.trim() }), { placeholder: 'vps.example.com' })),
        sshField(t('sshPort'), sshInput(sshForm.port, (v) => patchSshForm({ port: v }), { inputMode: 'numeric' })),
        sshField(t('sshUser'), sshInput(sshForm.user, (v) => patchSshForm({ user: v.trim() }), { placeholder: 'dsh' })),
        sshField(t('sshKeyPath'), sshInput(sshForm.keyPath, (v) => patchSshForm({ keyPath: v.trim() }), { placeholder: '~/.ssh/id_ed25519' }),
          sshConfigView.keyPathSet ? t('sshKeyPathSet') : t('sshKeyPathHint')),
        sshField(t('sshRemoteBindPort'), sshInput(sshForm.remoteBindPort, (v) => patchSshForm({ remoteBindPort: v }), { inputMode: 'numeric' }),
          t('sshRemoteBindPortHint')),
        sshField(t('sshAccessProtocol'),
          h('select', { style: styles.select, value: sshForm.accessProtocol, onChange: (e) => patchSshForm({ accessProtocol: e.target.value }) },
            h('option', { value: 'https' }, 'https'),
            h('option', { value: 'http' }, 'http'))),
        sshField(t('sshAccessHost'), sshInput(sshForm.accessHost, (v) => patchSshForm({ accessHost: v.trim() }), { placeholder: sshForm.host || 'dsh.example.com' }),
          t('sshAccessHostHint')),
        sshField(t('sshAccessPort'), sshInput(sshForm.accessPort, (v) => patchSshForm({ accessPort: v }), { inputMode: 'numeric' })),
        sshField(t('sshAutoRestore'), Switch(sshForm.autoRestore !== false, () => patchSshForm({ autoRestore: sshForm.autoRestore === false })),
          t('sshAutoRestoreHint')),
      ) : null,
      sshForm.err ? h('div', { style: { color: COLOR_ERR, marginTop: 6, fontSize: 12, lineHeight: 1.5, wordBreak: 'break-word' } }, errText(sshForm.err)) : null,
      // 操作：保存 / 启动(停止)隧道 / 测试连接（窄屏自动换行）
      h('div', { style: { marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' } },
        h('button', { style: styles.smallBtn, onClick: saveSshConfig }, t('save')),
        sshRunning
          ? h('button', { style: { ...styles.smallBtn, color: COLOR_ERR }, onClick: stopTunnel }, t('sshStop'))
          : h('button', { style: { ...styles.primary, height: 28, padding: '0 14px', fontSize: 12 }, onClick: startTunnel, disabled: busy || sshStarting }, busy || sshStarting ? t('sshStarting') : t('sshStart')),
        h('button', { style: styles.smallBtn, onClick: testSshConnection, disabled: sshTesting }, sshTesting ? t('sshTesting') : t('sshTest')),
        sshEdit ? h('button', { style: styles.smallBtn, onClick: () => setSshCfg(null) }, t('cancel')) : null,
      ),
    ),
  );

  // ══ 通知与 PWA（task-6）══════════════════════════════════════════════════
  // window.dshPocketPush 由宿主注入的 /pocket-pwa.js 提供（订阅/取消必须在用户手势内调用）
  const [notifyEdit, setNotifyEdit] = useState(null); // { preset, url, secret, minInterval } 编辑态
  const [notifyStatusData, setNotifyStatusData] = useState(null); // notify.status 的返回（含 lastResults）
  const [notifyBusy, setNotifyBusy] = useState(false);
  const [pushApiReady, setPushApiReady] = useState(false);
  const [canInstall, setCanInstall] = useState(false);
  const [clearSubsAsk, setClearSubsAsk] = useState(false); // 清空全部订阅的二次确认
  const installEvRef = useRef(null); // beforeinstallprompt 缓存的事件（宿主注入脚本提供）

  const notifyView = status?.notify ?? null; // null = 旧宿主不返回该字段
  const notifyForm = notifyEdit ?? {
    preset: notifyView?.webhookPreset ?? 'generic',
    url: notifyView?.webhookUrl ?? '',
    secret: '',
    minInterval: notifyView?.minIntervalSec == null ? '' : String(notifyView.minIntervalSec),
  };
  const patchNotifyForm = (patch) => setNotifyEdit((f) => ({ ...(f ?? notifyForm), ...patch }));

  const pushApi = () => {
    try { return typeof window === 'undefined' ? null : (window.dshPocketPush ?? null); } catch { return null; }
  };
  /** 宿主注入脚本（/pocket-pwa.js）可能晚到：每轮 status 轮询重探一次。 */
  const refreshBrowserCapabilities = () => {
    try {
      const api = pushApi();
      setPushApiReady(typeof api?.subscribe === 'function');
      const ev = typeof api?.installPrompt === 'function' ? api.installPrompt() : null;
      if (ev && !installEvRef.current) installEvRef.current = ev;
      setCanInstall(!!installEvRef.current);
    } catch { /* 注入脚本异常不影响设置页 */ }
  };
  const loadNotifyStatus = async () => {
    if (!status?.notify) return; // 旧宿主：不请求，避免无谓报错
    try {
      const r = await call(POCKET_ENDPOINTS.notifyStatus, {});
      if (!r || typeof r !== 'object') return;
      setNotifyStatusData(r);
      const patch = r.notify && typeof r.notify === 'object' ? r.notify : r;
      setStatus((s) => ({ ...(s ?? {}), notify: { ...(s?.notify ?? {}), ...patch } }));
    } catch { /* 静默：状态由 status 轮询兜底 */ }
  };
  const setNotifyFlag = async (field, value) => {
    try {
      mergeStatus(await call(POCKET_ENDPOINTS.notifySetConfig, { [field]: value }));
    } catch (err) {
      setError(err.message);
    }
  };
  const saveNotifyConfig = async () => {
    if (!notifyView) { showToast(t('hostUnsupported')); return; }
    setNotifyBusy(true);
    try {
      const payload = {
        webhookPreset: notifyForm.preset,
        webhookUrl: String(notifyForm.url ?? '').trim(),
      };
      const secret = String(notifyForm.secret ?? '').trim();
      if (secret) payload.webhookSecret = secret; // 留空 = 保持已存密钥（只写不回显）
      const minRaw = String(notifyForm.minInterval ?? '').trim();
      if (minRaw !== '') payload.minIntervalSec = intField(minRaw, 10);
      mergeStatus(await call(POCKET_ENDPOINTS.notifySetConfig, payload));
      setNotifyEdit(null);
      showToast(t('notifySaved'));
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
      const results = Array.isArray(r?.results) ? r.results : (Array.isArray(r?.lastResults) ? r.lastResults : []);
      const failed = results.find((x) => x && x.ok === false);
      showToast(failed
        ? fmt(t, 'notifyTestFailed', { err: errText(failed.error) || `${resultChannel(failed)} HTTP ${failed.status ?? '—'}` })
        : t('notifyTestSent'));
      loadNotifyStatus();
    } catch (err) {
      showToast(fmt(t, 'notifyTestFailed', { err: errText(err?.message) || t('unknownError') }));
    } finally {
      setNotifyBusy(false);
    }
  };
  const resultChannel = (r) => (r?.channel === 'webhook' ? t('notifyResultWebhook') : t('notifyResultPush'));
  const resultText = (r) => `${resultChannel(r)} · ${r?.ok === true ? t('notifyResultOk') : fmt(t, 'notifyResultFail', { err: errText(r?.error) || `HTTP ${r?.status ?? '—'}` })}`;
  // 最近一次推送结果（notify.status 的 lastResults/results 末条；宿主没返回就不显示）
  const notifyResults = Array.isArray(notifyStatusData?.lastResults)
    ? notifyStatusData.lastResults
    : (Array.isArray(notifyStatusData?.results) ? notifyStatusData.results : []);
  const notifyLastResult = notifyResults.length ? notifyResults[notifyResults.length - 1] : null;
  // 订阅/取消必须在用户手势里直接调用 window.dshPocketPush（浏览器要求）
  const subscribePush = async () => {
    const api = pushApi();
    if (typeof api?.subscribe !== 'function') { showToast(t('notifyPushUnsupported')); return; }
    setNotifyBusy(true);
    try {
      const r = await api.subscribe();
      if (r && r.ok === false) throw new Error(r.error?.message ?? r.error ?? 'subscribe failed');
      showToast(t('notifySubscribed'));
      loadNotifyStatus();
    } catch (err) {
      showToast(fmt(t, 'notifySubscribeFailed', { err: errText(err?.message) || t('unknownError') }));
    } finally {
      setNotifyBusy(false);
    }
  };
  const unsubscribePush = async () => {
    const api = pushApi();
    if (typeof api?.unsubscribe !== 'function') { showToast(t('notifyPushUnsupported')); return; }
    setNotifyBusy(true);
    try {
      const r = await api.unsubscribe();
      if (r && r.ok === false) throw new Error(r.error?.message ?? r.error ?? 'unsubscribe failed');
      showToast(t('notifyUnsubscribed'));
      loadNotifyStatus();
    } catch (err) {
      showToast(fmt(t, 'notifyUnsubscribeFailed', { err: errText(err?.message) || t('unknownError') }));
    } finally {
      setNotifyBusy(false);
    }
  };
  // 清空全部订阅（服务器侧）：手机换浏览器/清数据后残留的订阅在这里一次性清掉
  const clearSubscriptions = async () => {
    setClearSubsAsk(false);
    setNotifyBusy(true);
    try {
      mergeStatus(await call(POCKET_ENDPOINTS.notifyClearSubscriptions, {}));
      showToast(t('notifyCleared'));
      loadNotifyStatus();
    } catch (err) {
      showToast(fmt(t, 'notifyClearFailed', { err: errText(err?.message) || t('unknownError') }));
    } finally {
      setNotifyBusy(false);
    }
  };
  const promptInstall = async () => {
    try {
      const api = pushApi();
      const ev = installEvRef.current ?? (typeof api?.installPrompt === 'function' ? api.installPrompt() : null);
      if (!ev) { showToast(t('pwaInstallUnavailable')); return; }
      if (typeof ev.prompt === 'function') {
        await ev.prompt();
        const choice = await Promise.resolve(ev.userChoice ?? null).catch(() => null);
        showToast(choice?.outcome === 'accepted' ? t('pwaInstallTriggered') : t('pwaInstallDismissed'));
        installEvRef.current = null;
        setCanInstall(false);
        return;
      }
      showToast(t('pwaInstallTriggered'));
    } catch (err) {
      showToast(fmt(t, 'notifySubscribeFailed', { err: errText(err?.message) || t('unknownError') }));
    }
  };
  /** PWA 不可安装时的简短原因（非 HTTPS / 不支持 / 已安装 / 还没准备好）。 */
  const pwaReason = () => {
    try {
      if (typeof window === 'undefined') return t('pwaUnsupported');
      if (window.isSecureContext !== true) return t('pwaNeedHttps');
      if (window.matchMedia?.('(display-mode: standalone)')?.matches === true || window.navigator?.standalone === true) return t('pwaStandalone');
      if (!('serviceWorker' in (window.navigator ?? {}))) return t('pwaUnsupported');
      return t('pwaNotReady');
    } catch {
      return t('pwaNotReady');
    }
  };

  // ══ 通行密钥设备（task-6）════════════════════════════════════════════════
  const [devices, setDevices] = useState(null); // null = 未加载
  const [devicesErr, setDevicesErr] = useState(null);
  const [renameId, setRenameId] = useState(null);
  const [renameVal, setRenameVal] = useState('');
  const [revokeId, setRevokeId] = useState(null);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const passkeyView = status?.passkey ?? null; // null = 旧宿主不返回该字段
  const webAuthn = detectWebAuthn();

  const loadDevices = async () => {
    try {
      const r = await call(POCKET_ENDPOINTS.passkeyList, {});
      const list = Array.isArray(r) ? r : (Array.isArray(r?.devices) ? r.devices : []);
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
      showToast(on ? t('passkeyEnabledDone') : t('passkeyDisabledDone'));
      loadDevices();
    } catch (err) {
      setError(err.message);
    } finally {
      setPasskeyBusy(false);
    }
  };
  const doRenameDevice = async (id) => {
    const name = String(renameVal ?? '').trim();
    if (!name) { setRenameId(null); return; }
    try {
      await call(POCKET_ENDPOINTS.passkeyRename, { id, name });
      setRenameId(null);
      setRenameVal('');
      showToast(t('passkeyRenamed'));
      loadDevices();
    } catch (err) {
      setError(err.message);
    }
  };
  const doRevokeDevice = async (id) => {
    try {
      await call(POCKET_ENDPOINTS.passkeyRevoke, { id });
      setRevokeId(null);
      showToast(t('passkeyRevokeDone'));
      loadDevices();
    } catch (err) {
      setError(err.message);
    }
  };

  // 复制地址：非安全上下文没有 navigator.clipboard，回退 textarea + execCommand
  const copyText = async (text) => {
    const value = String(text ?? '').trim();
    if (!value) return;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        showToast(t('copied'));
        return;
      }
    } catch { /* 权限拒绝/非 HTTPS → 走兜底 */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.setAttribute('readonly', 'readonly');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand?.('copy');
      document.body.removeChild(ta);
      showToast(ok ? t('copied') : t('copyFailed'));
    } catch {
      showToast(t('copyFailed'));
    }
  };

  // 首次拿到 status 后拉一次设备列表与通知详情（旧宿主缺字段则跳过，不产生报错噪音）
  const initialLoadRef = useRef(false);
  useEffect(() => {
    if (!status || initialLoadRef.current) return;
    initialLoadRef.current = true;
    if (status.passkey) loadDevices();
    if (status.notify) loadNotifyStatus();
  }, [status]);

  return h('div', { style: styles.card },
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
      h('div', null,
        h('strong', null, t('title')),
        h('div', { style: styles.muted }, t('subtitle')),
      ),
      h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary,#8b93a1)', textAlign: 'right' } },
        h('div', { style: { whiteSpace: 'nowrap' } }, t('developer')),
        h('div', { style: { whiteSpace: 'nowrap' } }, t('starAsk')),
        h('a', { href: 'https://github.com/shaobeichen/dsh-pocket', target: '_blank', rel: 'noreferrer', style: { color: 'var(--dsw-alias-brand-primary,#4f6ef7)', fontSize: 12, lineHeight: 1.6, textDecoration: 'underline' } },
          t('starCta')),
      ),
    ),

    // 桌面端不显示更新/重启横幅（更新由 DSH Desktop 管理），也不需要额外提示

    // 重启后提示（进程在后台运行，停止方法）——左侧蓝色色条（桌面端不会触发本插件的自重启）
    !isDesktop && restartNotice ? h('div', { style: { ...styles.block, borderLeft: '4px solid var(--dsw-alias-brand-primary,#4f6ef7)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2,#f3f4f6)', padding: '10px 12px' } },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
        h('div', { style: { fontWeight: 600, fontSize: 13 } }, t('restarted')),
        h('button', { style: styles.btn, onClick: () => setRestartNotice(false) }, t('ok')),
      ),
      h('div', { style: styles.muted, marginTop: 4, wordBreak: 'break-all' }, fmt(t, 'bgHint', { cmd: status?.killHint ?? `lsof -ti :${status?.dshPort ?? 3080} | xargs kill -9` })),
    ) : null,

    // 更新提示——左侧黄色色条（提示有新版本）；单状态：有更新/更新中/已更新自动重启，不并存
    // 桌面端不渲染（更新由 DSH Desktop 管理）
    !isDesktop && updateInfo ? h('div', { style: { ...styles.block, borderLeft: '4px solid var(--dsw-alias-state-warn-primary,#b45309)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2,#f3f4f6)', padding: '10px 12px' } },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
        h('div', { style: { fontWeight: 600, fontSize: 13 } },
          updateInfo.updated
            ? fmt(t, 'updatedRestart', { ver: updateInfo.current })
            : updateInfo.result === 'ok'
              ? (updateInfo.autoRestart ? fmt(t, 'updateAutoRestarting', { ver: updateInfo.latest }) : fmt(t, 'updatedOk', { ver: updateInfo.latest }))
              : fmt(t, 'updateAvailable', { ver: updateInfo.latest })),
        updateInfo.result !== 'ok'
          ? h('button', { style: styles.primary, onClick: runUpdate, disabled: updateInfo.updating }, updateInfo.updating ? t('updating') : fmt(t, 'updateTo', { ver: updateInfo.latest }))
          : updateInfo.autoRestart
            ? h('button', { style: styles.btn, disabled: true }, t('restartingNow'))
            : h('button', { style: styles.primary, onClick: restartPocket, disabled: updateInfo.restarting }, updateInfo.restarting ? t('restarting') : t('restartNow')),
      ),
      h('div', { style: styles.muted, marginTop: 4 },
        updateInfo.updating
          ? fmt(t, 'updatingDetail', { s: elapsed(updateInfo.startedAt) })
        : updateInfo.restarting
          ? fmt(t, 'restartingDetail', { s: elapsed(updateInfo.startedAt) })
        : updateInfo.result === 'ok'
          ? (updateInfo.autoRestart ? t('updatedAutoDetail')
            : t('updatedRestartDetail'))
        : updateInfo.result === 'fail' ? fmt(t, 'updateFailed', { err: errText(updateInfo.output) || t('unknownError') })
        : fmt(t, 'versionRange', { cur: updateInfo.current, latest: updateInfo.latest })),
    ) : null,

    // 局域网：标题行自带总开关 → 二维码+地址 → 设置行（访问密码 / 高级·手动选地址）
    h('div', { style: styles.block },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
        h('span', { style: { fontWeight: 600, fontSize: 13 } }, t('lanAccess')),
        Switch(status?.lanEnabled !== false, () => requestLanToggle(status?.lanEnabled === false)),
      ),
      status?.lanEnabled === false
        ? h('div', { style: { marginTop: 8, fontSize: 12, color: 'var(--dsw-alias-state-warn-primary,#b45309)', lineHeight: 1.5 } }, t('lanDisabledHint'))
        : (lanUrl
          ? h('div', null,
            qrArea(status.lanQr, lanUrl, t('lanHint')),
            // 访问密码行：开关 + 值（关闭时提示直连）
            row(t('lanPin'), Switch(status?.lanAuthEnabled !== false, () => setLanAuth(status?.lanAuthEnabled === false)),
              status?.lanAuthEnabled === false
                ? h('div', { style: { ...styles.muted, marginTop: 6 } }, t('lanPinOff'))
                : (customPin?.which === 'lan'
                  ? customPinRow('lan')
                  : h('div', { style: { marginTop: 6, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                    h('span', { style: { fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 13, letterSpacing: 1 } }, status.lanToken),
                    h('button', { style: { ...styles.btn, height: 26, padding: '0 10px', fontSize: 12 }, onClick: refreshLanPin }, t('refresh')),
                    customBtn('lan'),
                    status?.lanPinCustom ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-state-warn-primary,#b45309)' } }, t('pinCustomHint')) : null,
                  ))),
            // 高级：手动选地址（默认收起）
            row(t('advAddress'),
              h('button', { style: { border: 'none', background: 'none', font: 'inherit', cursor: 'pointer', fontSize: 12, color: 'var(--dsw-alias-label-tertiary,#8b93a1)', padding: 0 }, onClick: () => setAdvOpen((v) => !v) },
                (status?.lanIpOverride || t('lanAddressAuto')) + ' ›'),
              advOpen ? h('div', { style: { marginTop: 8 } },
                h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--dsw-alias-label-secondary,#6b7280)' } },
                  t('lanAddress'),
                  h('select', {
                    value: status?.lanIpOverride || '',
                    onChange: (e) => setLanAddress(e.target.value),
                    style: { font: 'inherit', height: 30, padding: '0 8px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2,#d1d5db)', background: 'var(--dsw-alias-bg-layer-1,#fff)', color: 'var(--dsw-alias-label-primary,inherit)' },
                  },
                  h('option', { value: '' }, t('lanAddressAuto')),
                  (status?.lanCandidates || []).map((ip) => h('option', { key: ip, value: ip }, ip)),
                  ),
                ),
              ) : null),
          )
          : h('div', { style: styles.muted }, t('lanStarting'))),
    ),

    // 公网：标题行自带 开启/关闭 → 开启后：二维码+地址、地址模式行、访问密码行
    h('div', { style: styles.block },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
        h('span', { style: { fontWeight: 600, fontSize: 13 } }, t('wanAccess')),
        publicRunning
          ? h('button', { style: { ...styles.btn, height: 28, padding: '0 12px', fontSize: 12, color: 'var(--dsw-alias-state-error-primary,#dc2626)' }, onClick: stopTunnel }, t('stopTunnel'))
          : h('button', { style: { ...styles.primary, height: 28, padding: '0 14px', fontSize: 12 }, onClick: startTunnel, disabled: busy || tunnelStarting }, busy || tunnelStarting ? t('opening') : t('enable')),
      ),
      tunnelStarting
        ? h('div', { style: { marginTop: 8, fontSize: 12, color: 'var(--dsw-alias-label-secondary,#6b7280)' } },
          tunnelPhase === 'downloading'
            ? fmt(t, 'downloading', { s: elapsed(tunnelStateStarted) })
            : fmt(t, 'connecting', { s: elapsed(tunnelStateStarted), suffix: elapsed(tunnelStateStarted) > 30 ? t('slowHint') : '' }))
        : tunnelPhase === 'error'
          ? h('div', { style: { marginTop: 8, fontSize: 12, color: 'var(--dsw-alias-state-error-primary,#dc2626)' } },
            fmt(t, 'error', { detail: errText(tunnelStateDetail) || t('unknownError') }))
          : (!publicRunning && !isDesktop ? h('div', { style: { ...styles.muted, marginTop: 8 } }, t('wanOffHint')) : null),
      // 公网入口三选一（Quick/Named/SSH 互斥）：不依赖隧道是否在运行，随时可切换/配置
      row(t('modeLabel'),
            h('span', { style: { display: 'inline-flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end', minWidth: 0 } },
              h('button', { style: modeBtnStyle(!namedActive && !sshActive), onClick: selectQuick }, t('modeQuick')),
              h('button', { style: modeBtnStyle(namedActive), onClick: selectNamed }, t('modeNamed')),
              h('button', { style: modeBtnStyle(sshActive), onClick: selectSsh }, t('modeSsh')),
            ),
            h('div', { style: { marginTop: 6 } },
              // 刚保存固定域名但当前连接仍是随机域名：需关闭后重新开启才生效
              namedMode && /trycloudflare\.com/i.test(tunnelUrl ?? '') ? h('div', { style: { ...styles.warn } }, t('namedTakeEffect')) : null,
              // 固定域名：已保存摘要 + 修改入口（非编辑态）
              namedMode && !tunnelCfg ? h('div', { style: { ...styles.muted } },
                fmt(t, 'namedSummary', { host: tunnelModeView.hostname || '—', token: tunnelModeView.tokenSet ? t('namedTokenSet') : t('namedTokenMissing') }),
                h('button', { style: { ...styles.btn, height: 26, padding: '0 10px', fontSize: 12, marginLeft: 8 }, onClick: () => setTunnelCfg({ hostname: tunnelModeView.hostname ?? '', token: '', err: null }) }, t('namedEdit')),
                h('div', { style: { ...styles.muted, marginTop: 4 } }, t('namedHow')),
                !tunnelModeView.tokenSet || !tunnelModeView.hostname ? h('div', { style: { marginTop: 2, color: 'var(--dsw-alias-state-error-primary,#dc2626)' } }, t('namedNeedCfg')) : null,
              ) : null,
              // 固定域名：编辑表单（域名 + Tunnel Token，Token 留空保持不变）
              tunnelCfg ? h('div', { style: { marginTop: 6, fontSize: 12, color: 'var(--dsw-alias-label-secondary,#6b7280)', lineHeight: 1.6 } },
                h('div', null,
                  t('namedHostnameLabel'),
                  h('input', {
                    style: { margin: '4px 0 0 6px', padding: '4px 8px', fontSize: 13, border: '1px solid var(--dsw-alias-border-l2,#d1d5db)', borderRadius: 6, outline: 'none', width: 200 },
                    placeholder: 'pocket.example.com',
                    value: tunnelCfg.hostname ?? '',
                    autoFocus: true,
                    onChange: (e) => setTunnelCfg((c) => ({ ...c, hostname: e.target.value.trim(), err: null })),
                    onKeyDown: (e) => { if (e.key === 'Enter') saveNamedTunnel(); if (e.key === 'Escape') setTunnelCfg(null); },
                  }),
                ),
                h('div', { style: { marginTop: 6 } },
                  t('namedTokenLabel'),
                  h('input', {
                    style: { margin: '4px 0 0 6px', padding: '4px 8px', fontSize: 13, border: '1px solid var(--dsw-alias-border-l2,#d1d5db)', borderRadius: 6, outline: 'none', width: 240, fontFamily: 'ui-monospace,Menlo,monospace' },
                    type: 'password',
                    value: tunnelCfg.token ?? '',
                    onChange: (e) => setTunnelCfg((c) => ({ ...c, token: e.target.value.trim(), err: null })),
                    onKeyDown: (e) => { if (e.key === 'Enter') saveNamedTunnel(); if (e.key === 'Escape') setTunnelCfg(null); },
                  }),
                ),
                h('div', { style: { marginTop: 6, display: 'flex', gap: 8 } },
                  h('button', { style: { ...styles.btn, height: 26, padding: '0 10px', fontSize: 12 }, onClick: saveNamedTunnel }, t('save')),
                  h('button', { style: { ...styles.btn, height: 26, padding: '0 10px', fontSize: 12 }, onClick: () => setTunnelCfg(null) }, t('cancel')),
                ),
                h('div', { style: { ...styles.muted, marginTop: 6 } }, t('namedHow')),
                h('div', { style: { marginTop: 2, fontSize: 11, color: 'var(--dsw-alias-state-warn-primary,#b45309)', lineHeight: 1.5 } }, t('namedSecurity')),
                tunnelCfg.err ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary,#dc2626)', marginTop: 4 } }, errText(tunnelCfg.err)) : null,
              ) : null,
            ),
      ),
      // SSH 通道：状态 + 地址/二维码 + 配置表单（选中 SSH 或正在编辑时显示）
      sshSection,
      // Quick/Named 运行中：二维码 + 防钓鱼提示（SSH 的二维码在 SSH 区块内）
      tunnelUrl ? h('div', null,
        qrArea(status.tunnelQr, tunnelUrl, namedMode ? t('namedRunningHint') : t('wanHint')),
        h('div', { style: { marginTop: 8, fontSize: 12, lineHeight: 1.5, borderLeft: '4px solid var(--dsw-alias-state-warn-primary,#b45309)', background: 'var(--dsw-alias-bg-layer-2,#f3f4f6)', borderRadius: 8, padding: '8px 10px' } }, t('wanEphemeralWarn')),
      ) : null,
      // 访问密码行：值 + 自定义（公网共享 PIN，Quick/Named/SSH 三种通道共用；公网开启后显示）
      publicRunning && status?.accessToken
        ? row(t('pinLabel'),
          customPin?.which === 'public'
            ? null
            : h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 8 } },
              h('span', { style: { fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 13, letterSpacing: 1 } }, status.accessToken),
              customBtn('public')),
          h('div', { style: { marginTop: 6 } },
            customPin?.which === 'public' ? customPinRow('public') : null,
            status?.publicPinCustom ? h('div', { style: { ...styles.warn } }, t('pinCustomHint')) : null,
            namedMode ? h('div', { style: { ...styles.warn } }, t('namedSecurity')) : null))
        : null,
    ),

    h('div', { style: styles.block },
      row(
        t('mobileRightbar'),
        Switch(status?.mobileRightbarEnabled !== false, () => setMobileRightbar(status?.mobileRightbarEnabled === false)),
        h('div', { style: { ...styles.muted, marginTop: 6 } }, t('mobileRightbarHint')),
      ),
    ),

    // 通知与 PWA（task-6）：Web Push 订阅 + Webhook；旧宿主不返回 notify 字段时降级提示
    h('div', { style: styles.block },
      h('span', { style: { fontWeight: 600, fontSize: 13 } }, t('notifyTitle')),
      !status
        ? h('div', { style: { ...styles.muted, marginTop: 6 } }, t('lanStarting'))
        : (!notifyView
          ? h('div', { style: { ...styles.muted, marginTop: 6 } }, t('hostUnsupported'))
          : h('div', null,
            // Web Push 总开关 + 说明（浏览器推送依赖厂商服务，可能延迟）
            row(t('notifyPush'),
              Switch(notifyView.pushEnabled === true, () => setNotifyFlag('pushEnabled', notifyView.pushEnabled !== true)),
              h('div', { style: { ...styles.muted, marginTop: 6 } }, t('notifyPushHint'))),
            // 订阅数量 + 本机订阅/取消（浏览器要求：必须在用户手势里调用）
            row(fmt(t, 'notifySubsCount', { n: notifyView.subscriptionCount ?? 0 }),
              h('div', { style: styles.btnRow },
                h('button', { style: styles.smallBtn, onClick: subscribePush, disabled: notifyBusy || !pushApiReady }, t('notifySubscribe')),
                h('button', { style: styles.smallBtn, onClick: unsubscribePush, disabled: notifyBusy }, t('notifyUnsubscribe')),
              ),
              h('div', null,
                !pushApiReady ? h('div', { style: { ...styles.muted, marginTop: 4 } }, t('notifyPushUnsupported')) : null,
                // 有订阅时才给「清空全部订阅」（手机换浏览器/清数据后的残留订阅）
                (notifyView.subscriptionCount ?? 0) > 0 ? h('div', { style: { marginTop: 6 } },
                  clearSubsAsk
                    ? h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
                      h('span', { style: { ...styles.warn, flex: '1 1 100%' } }, t('notifyClearConfirm')),
                      h('button', { style: styles.miniBtn, onClick: clearSubscriptions, disabled: notifyBusy }, t('confirm')),
                      h('button', { style: styles.miniBtn, onClick: () => setClearSubsAsk(false) }, t('cancel')))
                    : h('button', { style: styles.miniBtn, onClick: () => setClearSubsAsk(true) }, t('notifyClear')),
                ) : null)),
            // 发送测试通知
            row(t('notifyTest'),
              h('button', { style: styles.smallBtn, onClick: sendTestNotification, disabled: notifyBusy }, notifyBusy ? t('notifyTesting') : t('notifyTest'))),
            // 最近一次推送结果（notify.status 的 lastResults；宿主没返回就不显示）
            h('div', { style: { ...styles.muted, marginTop: 6, wordBreak: 'break-word' } },
              notifyLastResult
                ? fmt(t, 'notifyLastResult', { text: resultText(notifyLastResult) })
                : t('notifyNoResult')),
            // 任务完成时推送（与 Webhook 无关的全局开关）
            row(t('notifyOnTaskDone'), Switch(notifyView.onTaskDone !== false, () => setNotifyFlag('onTaskDone', notifyView.onTaskDone === false))),
            // Webhook：开关 + 预设/URL/密钥/间隔（开启后才展开字段，保持页面紧凑）
            row(t('notifyWebhook'), Switch(notifyView.webhookEnabled === true, () => setNotifyFlag('webhookEnabled', notifyView.webhookEnabled !== true)),
              h('div', { style: { marginTop: 6 } },
                h('div', { style: { ...styles.muted } }, t('notifyWebhookHint')),
                notifyView.webhookEnabled ? h('div', null,
                  sshField(t('notifyPreset'),
                    h('select', { style: styles.select, value: notifyForm.preset, onChange: (e) => patchNotifyForm({ preset: e.target.value }) },
                      NOTIFY_PRESETS.map(([value, key]) => h('option', { key: value, value }, t(key))))),
                  sshField(t('notifyUrl'), sshInput(notifyForm.url, (v) => patchNotifyForm({ url: v.trim() }), { placeholder: 'https://…' })),
                  sshField(t('notifySecret'), sshInput(notifyForm.secret, (v) => patchNotifyForm({ secret: v }), { type: 'password', placeholder: notifyView.webhookConfigured ? t('notifySecretSet') : '' }),
                    notifyView.webhookConfigured ? t('notifySecretSet') : t('notifySecretHint')),
                  sshField(t('notifyMinInterval'), sshInput(notifyForm.minInterval, (v) => patchNotifyForm({ minInterval: v }), { inputMode: 'numeric', placeholder: t('notifyMinIntervalPlaceholder') }),
                    t('notifyMinIntervalHint')),
                  h('div', { style: { marginTop: 10 } },
                    h('button', { style: styles.smallBtn, onClick: saveNotifyConfig, disabled: notifyBusy }, t('save'))),
                ) : null,
              )),
            // PWA 安装提示：可安装时给按钮，否则给一句为什么不可安装
            row(t('pwaRow'),
              canInstall ? h('button', { style: styles.smallBtn, onClick: promptInstall }, t('pwaInstall')) : null,
              h('div', { style: { ...styles.muted, marginTop: 4 } }, canInstall ? null : pwaReason())),
          )),
    ),

    // 通行密钥设备（task-6）：启用开关 + rpId + 设备列表（重命名/撤销）
    h('div', { style: styles.block },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
        h('span', { style: { fontWeight: 600, fontSize: 13 } }, t('passkeyTitle')),
        passkeyView ? Switch(passkeyView.enabled === true, () => setPasskeyEnabled(passkeyView.enabled !== true)) : null,
      ),
      !status
        ? h('div', { style: { ...styles.muted, marginTop: 6 } }, t('lanStarting'))
        : (!passkeyView
          ? h('div', { style: { ...styles.muted, marginTop: 6 } }, t('hostUnsupported'))
          : h('div', null,
            h('div', { style: { ...styles.muted, marginTop: 6 } }, t('passkeyHint')),
            // 三态说明：非安全上下文 → 浏览器不支持 → 可用
            h('div', { style: { marginTop: 6, fontSize: 12, lineHeight: 1.5, color: (!webAuthn.secure || !webAuthn.supported) ? COLOR_ERR : 'var(--dsw-alias-label-tertiary,#8b93a1)' } },
              !webAuthn.secure ? t('passkeyInsecure') : (!webAuthn.supported ? t('passkeyUnsupported') : t('passkeySecureHint'))),
            row(t('passkeyRpId'),
              h('span', { style: { fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 12, wordBreak: 'break-all' } },
                passkeyView.rpId || (typeof location !== 'undefined' ? location.hostname : '—'))),
            row(fmt(t, 'passkeyDeviceCount', { n: passkeyView.deviceCount ?? 0 }),
              h('button', { style: styles.smallBtn, onClick: loadDevices, disabled: passkeyBusy }, t('refresh'))),
            // 设备列表：名称 / 注册时间 / 最后登录 + 重命名/撤销（撤销两步确认，避免误触）
            h('div', { style: { fontWeight: 600, fontSize: 12, marginTop: 10 } }, t('passkeyDevices')),
            devicesErr ? h('div', { style: { color: COLOR_ERR, fontSize: 12, marginTop: 6, wordBreak: 'break-word' } }, fmt(t, 'passkeyLoadFailed', { err: errText(devicesErr) })) : null,
            devices && devices.length === 0 && !devicesErr ? h('div', { style: { ...styles.muted, marginTop: 6 } }, t('passkeyNoDevices')) : null,
            (devices ?? []).map((d, i) => h('div', { key: String(d?.id ?? d?.credentialId ?? i), style: { borderTop: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', paddingTop: 8, marginTop: 8 } },
              h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' } },
                h('span', { style: { fontSize: 13, wordBreak: 'break-word', minWidth: 0 } }, d?.name || t('passkeyUnnamed')),
                h('div', { style: styles.btnRow },
                  h('button', { style: styles.miniBtn, onClick: () => { setRevokeId(null); setRenameId(d?.id); setRenameVal(d?.name ?? ''); } }, t('passkeyRename')),
                  h('button', { style: { ...styles.miniBtn, color: COLOR_ERR }, onClick: () => { setRenameId(null); setRevokeId(d?.id); } }, t('passkeyRevoke')),
                ),
              ),
              h('div', { style: { ...styles.muted, marginTop: 2, wordBreak: 'break-word' } },
                `${t('passkeyColCreated')}: ${fmtTime(d?.createdAt, '—')} · ${t('passkeyColLastLogin')}: ${fmtTime(d?.lastLoginAt, t('passkeyNever'))}`),
              // 重命名：内联输入，回车保存
              renameId === d?.id ? h('div', { style: { marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' } },
                h('input', {
                  style: { ...styles.input, maxWidth: 180 },
                  value: renameVal,
                  autoFocus: true,
                  maxLength: 40,
                  onChange: (e) => setRenameVal(e.target.value),
                  onKeyDown: (e) => { if (e.key === 'Enter') doRenameDevice(d?.id); if (e.key === 'Escape') setRenameId(null); },
                }),
                h('button', { style: styles.miniBtn, onClick: () => doRenameDevice(d?.id) }, t('save')),
                h('button', { style: styles.miniBtn, onClick: () => setRenameId(null) }, t('cancel')),
              ) : null,
              // 撤销：先给后果说明，再确认
              revokeId === d?.id ? h('div', { style: { marginTop: 6 } },
                h('div', { style: { ...styles.warn } }, t('passkeyRevokeConfirm')),
                h('div', { style: { marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' } },
                  h('button', { style: { ...styles.miniBtn, color: COLOR_ERR }, onClick: () => doRevokeDevice(d?.id) }, t('passkeyRevoke')),
                  h('button', { style: styles.miniBtn, onClick: () => setRevokeId(null) }, t('cancel')),
                ),
              ) : null,
            )),
          )),
    ),

    error ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary,#dc2626)', fontSize: 12, marginTop: 8 } }, `❌ ${errText(error)}`) : null,

    // 恢复出厂设置：设置出问题时的临时兜底（最底部，避免误触）
    h('div', { style: styles.block },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
        h('span', { style: { fontWeight: 600, fontSize: 13 } }, t('resetFactory')),
        h('button', { style: { ...styles.btn, height: 28, padding: '0 12px', fontSize: 12, color: 'var(--dsw-alias-state-error-primary,#dc2626)' }, onClick: () => setResetOpen(true) }, t('resetGo')),
      ),
      h('div', { style: { ...styles.muted, marginTop: 6 } }, t('resetIntro')),
    ),

    // 恢复出厂设置确认弹框
    resetOpen ? h('div', { style: { position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 } },
      h('div', { style: { background: 'var(--dsw-alias-bg-layer-1,#fff)', borderRadius: 12, maxWidth: 440, width: '100%', padding: '20px 22px', boxShadow: '0 8px 32px rgba(0,0,0,.18)' } },
        h('div', { style: { fontWeight: 600, fontSize: 15, color: 'var(--dsw-alias-state-warn-primary,#b45309)', marginBottom: 10 } }, t('resetTitle')),
        h('div', { style: { fontSize: 13, lineHeight: 1.7, color: 'var(--dsw-alias-label-primary,inherit)', whiteSpace: 'pre-line' } }, t('resetBody')),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 16 } },
          h('button', { style: { ...styles.btn, flex: 1 }, onClick: () => setResetOpen(false) }, t('cancel')),
          h('button', { style: { ...styles.primary, flex: 1, background: 'var(--dsw-alias-state-error-primary,#dc2626)' }, onClick: doFactoryReset }, t('resetConfirm')),
        ),
      ),
    ) : null,

    // Toast：重置等操作的即时反馈（固定屏幕正中央，2.6s 自动消失）
    toast ? h('div', {
      style: { position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', zIndex: 10001, width: 'auto', maxWidth: 280, background: 'rgba(17,24,39,.92)', color: '#fff', border: 'none', borderRadius: 10, padding: '10px 16px', fontSize: 13, lineHeight: 1.5, textAlign: 'center', boxShadow: '0 8px 24px rgba(0,0,0,.22)' },
    }, toast) : null,

    // 局域网访问开关确认弹框（关闭/打开时弹窗提醒）
    lanToggleOpen !== null ? h('div', { style: { position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 } },
      h('div', { style: { background: 'var(--dsw-alias-bg-layer-1,#fff)', borderRadius: 12, maxWidth: 420, width: '100%', padding: '20px 22px', boxShadow: '0 8px 32px rgba(0,0,0,.18)' } },
        h('div', { style: { fontWeight: 600, fontSize: 15, color: lanToggleOpen ? 'var(--dsw-alias-brand-primary,#4f6ef7)' : 'var(--dsw-alias-state-warn-primary,#b45309)', marginBottom: 10 } }, t(lanToggleOpen ? 'lanToggleTitleOn' : 'lanToggleTitleOff')),
        h('div', { style: { fontSize: 13, lineHeight: 1.7, color: 'var(--dsw-alias-label-primary,inherit)' } }, t(lanToggleOpen ? 'lanToggleBodyOn' : 'lanToggleBodyOff')),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 16 } },
          h('button', { style: { ...styles.btn, flex: 1 }, onClick: () => setLanToggleOpen(null) }, t('cancel')),
          h('button', { style: { ...styles.primary, flex: 1 }, onClick: confirmLanToggle }, t('confirm')),
        ),
      ),
    ) : null,

    // 安全免责声明弹框（issue #31）：每次开启公网访问前确认
    disclaimerOpen ? h('div', { style: { position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 } },
      h('div', { style: { background: 'var(--dsw-alias-bg-layer-1,#fff)', borderRadius: 12, maxWidth: 420, width: '100%', padding: '20px 22px', boxShadow: '0 8px 32px rgba(0,0,0,.18)' } },
        h('div', { style: { fontWeight: 600, fontSize: 15, color: 'var(--dsw-alias-state-warn-primary,#b45309)', marginBottom: 10 } }, t('disclaimerTitle')),
        h('div', { style: { fontSize: 13, lineHeight: 1.7, color: 'var(--dsw-alias-label-primary,inherit)' } }, t('disclaimerBody')),
        h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, fontSize: 13, cursor: 'pointer' } },
          h('input', { type: 'checkbox', checked: disclaimerChecked, onChange: (e) => setDisclaimerChecked(e.target.checked), style: { width: 16, height: 16 } }),
          t('disclaimerAgree'),
        ),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 16 } },
          h('button', { style: { ...styles.btn, flex: 1 }, onClick: () => setDisclaimerOpen(false) }, t('cancel')),
          h('button', {
            style: { ...styles.primary, flex: 1, opacity: disclaimerChecked ? 1 : .5 },
            disabled: !disclaimerChecked,
            onClick: confirmDisclaimer,
          }, t('disclaimerAgree')),
        ),
        !disclaimerChecked ? h('div', { style: { marginTop: 8, fontSize: 12, color: 'var(--dsw-alias-state-error-primary,#dc2626)' } }, t('disclaimerHint')) : null,
      ),
    ) : null,

    // 页面最底部：反馈入口
    h('div', { style: { ...styles.block, textAlign: 'center' } },
      h('a', { href: 'https://github.com/shaobeichen/dsh-pocket/issues', target: '_blank', rel: 'noreferrer', style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary,#6b7280)', textDecoration: 'none' } },
        t('feedback')),
    ),
  );
}

export function apply(ctx) {
  // 兜底：确保 connection.isLoopback 为 true（issue #58）。
  // 注：代理注入的 loopback 补丁（proxy.mjs LOOPBACK_ENV_PATCH）已在 #105 移除——
  // 它与 DSH Desktop 2.0.4+ 客户端运行时不兼容，会令 BootHandoff 阶段白屏。
  // #58「远程浏览器开设置页」需上游提供官方信任来源机制才能正经解决；此处仅保留兜底。
  if (ctx?.connection) {
    try {
      Object.defineProperty(ctx.connection, 'isLoopback', { value: true, writable: true, configurable: true });
    } catch {
      try { ctx.connection.isLoopback = true; } catch { /* 忽略 */ }
    }
  }

  // 移动端适配（dsh-web-mobile 移植）：抽屉布局/触控/安全区，仅窄屏生效
  mobileApply(ctx);

  const rpcCall = (endpoint, payload, signal) =>
    ctx.connection.rpc.call(POCKET_RPC_CHANNEL, endpoint, payload, signal);

  // 设置页签接入 DSH 本地化：注册 pocket 词典（zh/en），并绑定一个随当前 locale 切换的 t()。
  const translate = ctx.locale.bind(POCKET_NS);
  ctx.effect(() => ctx.locale.register(POCKET_NS, { zh: POCKET_ZH, en: POCKET_EN }), 'dsh-pocket: pocket locale dictionaries');

  // 设置一级入口（与 通用设置/模型/插件 同级，order 1 = 通用之后、最外层）
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'pocket',
        order: 1,
        label: () => translate('section'),
        inject: () => ({ rpcCall, t: translate }),
      },
      PocketSettingsTab,
    ),
  );
}

export { name, inject, redactStatus };
