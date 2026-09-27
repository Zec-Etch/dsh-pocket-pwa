import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { setTimeout } from 'node:timers/promises';
import { apply } from '../lib/index.js';
import { POCKET_ENDPOINTS, redactStatus, buildAccessUrl } from '../client/api.js';
import { zh as POCKET_ZH } from '../client/pocket-locales.js';

async function waitFor(check, message) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await setTimeout(10);
  }
  assert.fail(message);
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pocket-entry-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  const disposers = [];
  t.after(async () => {
    for (const dispose of disposers.reverse()) await dispose();
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(dir, { recursive: true, force: true });
  });
  let starts = 0;
  let restores = 0;
  const originalInfo = console.info;
  t.mock.method(console, 'info', (message, ...args) => {
    if (message.includes('public tunnel auto-restored')) restores += 1;
    originalInfo(message, ...args);
  });
  const marker = (home = dir) => join(home, 'dsh-pocket', 'tunnel-auto.json');
  const hasMarker = async (home) => /"at"\s*:/.test(await readFile(marker(home), 'utf8').catch(() => ''));

  function mount({ desktop = false, home } = {}) {
    let handler;
    let proxyReady = false;
    let disposed = false;
    let cleanup;
    const ctx = {
      webServer: { port: 3080 },
      connection: { rpc: { handle: (_channel, fn) => { handler = fn; return () => {}; } } },
      get: (name) => desktop && name === 'desktopProfiles' ? {} : undefined,
      logger: () => ({
        info(message) { if (message.includes('proxy ready')) proxyReady = true; },
        warn() {}, error() {},
      }),
      effect: (callback) => { cleanup = callback(); },
    };
    // Keep the real entry, service, RPC and filesystem. Only the network/process
    // boundaries are replaced; no service or persistence home is injected by default.
    apply(ctx, {}, {
      ...(home === undefined ? {} : { home }),
      createProxy: async () => ({ port: 3081, close: async () => {} }),
      startTunnel: async () => {
        starts += 1;
        return { url: 'https://example.trycloudflare.com', kill() {} };
      },
      lanIPv4: () => '192.168.1.2',
      lanCandidates: async () => ['192.168.1.2'],
      encodeQr: async () => 'data:qr',
    });
    const dispose = async () => { if (!disposed) { disposed = true; await cleanup(); } };
    disposers.push(dispose);
    return {
      ready: () => waitFor(() => proxyReady, 'entry did not start its proxy'),
      call: (endpoint, payload = {}) => handler(endpoint, payload),
      dispose,
    };
  }
  return { dir, mount, hasMarker, starts: () => starts, restores: () => restores };
}

for (const desktop of [false, true]) {
  test(`plugin entry persists and restores tunnels using DSH_HOME (desktop=${desktop})`, async (t) => {
    const f = await fixture(t);
    const first = f.mount({ desktop });
    await first.ready();
    const started = await first.call(POCKET_ENDPOINTS.tunnelStart, { disclaimer: true });
    assert.equal(started.ok, true);
    assert.equal(f.starts(), 1);
    await waitFor(() => f.hasMarker(), 'production entry did not persist the tunnel marker in DSH_HOME');
    await first.dispose();
    assert.equal(await f.hasMarker(), true, 'unloading keeps the restoration marker');

    const restarted = f.mount({ desktop });
    await restarted.ready();
    await waitFor(() => f.restores() === 1, 'new entry did not finish restoring the previous tunnel');
    assert.equal(f.starts(), 2);
    const stopped = await restarted.call(POCKET_ENDPOINTS.tunnelStop);
    assert.equal(stopped.ok, true);
    await waitFor(async () => !await f.hasMarker(), 'manual stop did not clear the marker');
    await restarted.dispose();
  });
}

test('plugin entry preserves an explicit persistence home override', async (t) => {
  const f = await fixture(t);
  const override = join(f.dir, 'override');
  const entry = f.mount({ home: override });
  await entry.ready();
  assert.equal((await entry.call(POCKET_ENDPOINTS.tunnelStart, { disclaimer: true })).ok, true);
  await waitFor(() => f.hasMarker(override), 'explicit persistence home was not used');
  assert.equal(await f.hasMarker(), false, 'DSH_HOME must not replace an explicit home');
});

// ── task-6 冻结契约：新增端点常量 + redactStatus 向后兼容 ─────────────────
// 前端按这些名字调用（client/index.jsx），后端按同样名字实现（lib/web-rpc.js）。
// 名字改动会让前端静默失效，所以在这里钉死。

test('client/api.js：三通道/通知/通行密钥端点名沿用 x.y 命名', () => {
  const expected = {
    sshSetConfig: 'ssh.setConfig',
    sshStatus: 'ssh.status',
    passkeySetEnabled: 'passkey.setEnabled',
    passkeyList: 'passkey.list',
    passkeyRevoke: 'passkey.revoke',
    passkeyRename: 'passkey.rename',
    notifySetConfig: 'notify.setConfig',
    notifyStatus: 'notify.status',
    notifyRemoveSubscription: 'notify.removeSubscription',
    notifyClearSubscriptions: 'notify.clearSubscriptions',
    notifyTest: 'notify.test',
  };
  assert.deepEqual(
    Object.fromEntries(Object.keys(expected).map((k) => [k, POCKET_ENDPOINTS[k]])),
    expected,
  );
  // 既有端点名不得被改动
  assert.equal(POCKET_ENDPOINTS.status, 'pocket.status');
  assert.equal(POCKET_ENDPOINTS.tunnelStart, 'tunnel.start');
  assert.equal(POCKET_ENDPOINTS.tunnelSetConfig, 'tunnel.setConfig');
  assert.equal(POCKET_ENDPOINTS.fileRead, 'pocket.fileRead');
});

test('redactStatus：旧宿主不返回新字段时不崩，且给出可用默认值', () => {
  const s = redactStatus({});
  assert.deepEqual(s.ssh, {
    running: false,
    state: 'idle',
    url: null,
    qr: null,
    lastError: null,
    // task-19：诊断字段与 ssh.status 对等（旧宿主缺失 → 默认值）
    evidence: null,
    attempts: 0,
    nextRetryInMs: null,
    stderrTail: [],
    target: null,
    config: {
      host: '', port: 22, user: '', keyPathSet: false, remoteBindPort: 7788,
      accessProtocol: 'https', accessHost: '', accessPort: 0, autoRestore: true,
    },
  });
  assert.deepEqual(s.notify, {
    pushEnabled: false, onTaskDone: true, webhookEnabled: false, webhookPreset: 'generic',
    webhookUrl: '', webhookConfigured: false, subscriptionCount: 0, minIntervalSec: null,
  });
  assert.deepEqual(s.passkey, { enabled: false, rpId: '', deviceCount: 0 });
  // 完全空/畸形输入也不能抛
  assert.equal(redactStatus(undefined).ssh.running, false);
  assert.equal(redactStatus({ ssh: null, notify: 'x', passkey: 42 }).ssh.state, 'idle');
});

test('redactStatus：私钥路径 / webhook 密钥 / 设备机密都不外泄', () => {
  const s = redactStatus({
    ssh: {
      running: true, state: 'connected',
      // task-19：诊断字段透出的同时，任何位置的私钥材料都必须被挡住
      evidence: 'forward-ok', attempts: 3, nextRetryInMs: 1500,
      stderrTail: [
        'debug1: identity file /home/u/.ssh/id_ed25519 type 3',
        '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3NzaC1yc2E=\n-----END OPENSSH PRIVATE KEY-----',
      ],
      target: { host: 'vps.example.com', user: 'dsh', port: 22, remote: '127.0.0.1:7788', local: '127.0.0.1:3081', keyPath: '/home/u/.ssh/id_ed25519' },
      privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----AAAAB3NzaC1yc2E=-----END OPENSSH PRIVATE KEY-----',
      config: { host: 'vps.example.com', user: 'dsh', keyPath: '/home/u/.ssh/id_ed25519', keyPathSet: true, privateKey: 'leaked' },
    },
    notify: { webhookSecret: 'super-secret', webhookUrl: 'https://hook.example.com/x', webhookConfigured: true },
    passkey: { enabled: true, rpId: 'dsh.example.com', deviceCount: 1, devices: [{ id: 'd1', token: 'plaintext' }] },
  });
  assert.equal(s.ssh.config.keyPath, undefined, '私钥路径不回显（只回 keyPathSet）');
  assert.equal(s.ssh.config.keyPathSet, true);
  assert.equal(s.ssh.target.keyPath, undefined, 'target 逐字段白名单：白名单外的字段一律丢弃');
  assert.equal(s.ssh.target.host, 'vps.example.com', 'target 白名单字段照常透出');
  assert.equal(s.ssh.privateKey, undefined, '顶层未知字段不进白名单');
  assert.equal(s.notify.webhookSecret, undefined, 'webhook 密钥不回显（只回 webhookConfigured）');
  assert.equal(s.notify.webhookConfigured, true);
  assert.equal(s.passkey.devices, undefined, '设备列表不进 status（走 passkey.list）');
  assert.ok(!JSON.stringify(s).includes('super-secret'), '序列化后不得出现密钥明文');
  assert.ok(!JSON.stringify(s).includes('id_ed25519'), '序列化后不得出现私钥路径');
  // task-19 强化：keyPath 字段名本身也不许出现在序列化结果里（keyPathSet 不算）
  assert.ok(!/"keyPath"\s*:/.test(JSON.stringify(s)), '序列化后不得出现 keyPath 字段');
  assert.ok(!/BEGIN [A-Z ]*PRIVATE KEY/.test(JSON.stringify(s)), '序列化后不得出现私钥块（诊断文本也要清洗）');
  // 清洗是有损但可读的：路径变占位符，诊断信息保留
  assert.ok(s.ssh.stderrTail[0].includes('[redacted key path]'), 'stderr 尾巴里的密钥路径被替换成占位符');
  assert.ok(s.ssh.stderrTail[0].includes('identity file'), '替换后仍保留原文的诊断语义');
  assert.ok(s.ssh.stderrTail[0].includes('type 3'));
  assert.ok(s.ssh.stderrTail[1].includes('[redacted private key]'), 'PEM 块被整体替换');
});

test('redactSsh（task-19）：stderrTail 裁到 5×500、evidence 只认两个结构化取值、target 逐字段收敛', () => {
  const long = 'x'.repeat(900);
  const s = redactStatus({
    ssh: {
      evidence: 'grace',
      attempts: 3.9,
      nextRetryInMs: 0,
      stderrTail: ['a', 'b', 'c', long, 'e', 'f', 'g'],
      target: { host: 'vps.example.com', user: 'dsh', port: '22', remote: null, local: '127.0.0.1:3081' },
    },
  });
  assert.equal(s.ssh.evidence, 'grace', 'grace 是合法证据');
  assert.equal(s.ssh.attempts, 3, '小数收敛为非负整数');
  assert.equal(s.ssh.nextRetryInMs, 0, '0 是合法的非负整数（null 才表示不在退避）');
  assert.equal(s.ssh.stderrTail.length, 5, '最多 5 条（保留最近 5 条）');
  assert.equal(s.ssh.stderrTail[0], 'c', '从头截断，保留尾部');
  assert.equal(s.ssh.stderrTail[1].length, 500, '单条截到 500 字符');
  assert.equal(s.ssh.stderrTail[4], 'g', '最后一条原样保留');
  assert.equal(s.ssh.target.port, 22, 'target.port 数字字符串按同规则解析');
  assert.equal(s.ssh.target.remote, null, 'target.remote 非字符串 → null');
  assert.equal(s.ssh.target.local, '127.0.0.1:3081');
  // 非法证据值（拼错/旧值/注入）一律 null，绝不透给 UI
  assert.equal(redactStatus({ ssh: { evidence: 'forward-ok-ish' } }).ssh.evidence, null);
  assert.equal(redactStatus({ ssh: { evidence: true } }).ssh.evidence, null);
  assert.equal(redactStatus({ ssh: { evidence: 'forward-ok' } }).ssh.evidence, 'forward-ok');
});

test('打包产物（task-19）：client.js 带上 redactSsh 的新字段名与清洗标记（改 api.js 必须重新打包）', () => {
  // 与 mobile-nav.test.js 的「打包产物里带上关键字」同一思路：源码改了但忘记重新打包时，
  // 浏览器侧拿到的还是旧白名单——这条断言把它钉死。
  const bundle = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
  for (const needle of ['stderrTail', 'nextRetryInMs', 'attempts', '[redacted key path]']) {
    assert.ok(bundle.includes(needle), `client.js 缺 ${needle}：改完 client/api.js 要重新打包（见 client/build.mjs 的 esbuild 配置）`);
  }
  // 包装模板没被破坏（与 client/build.mjs 逐字一致的头尾）
  assert.ok(bundle.startsWith('window.__ModuleLoader__.load({'), '打包产物必须是 ModuleLoader 包装');
  assert.ok(bundle.includes('var React = require("react");'), 'React 绑定注释与语句必须保留');
  assert.ok(bundle.trimEnd().endsWith('});'), '包装结尾完整');
});

test('redactStatus / buildAccessUrl：访问地址按 accessProtocol+accessHost(+accessPort) 拼接', () => {
  assert.equal(buildAccessUrl({ accessProtocol: 'https', accessHost: 'dsh.example.com', accessPort: 0 }), 'https://dsh.example.com');
  assert.equal(buildAccessUrl({ accessProtocol: 'https', accessHost: 'dsh.example.com', accessPort: 443 }), 'https://dsh.example.com');
  assert.equal(buildAccessUrl({ accessProtocol: 'http', accessHost: '1.2.3.4', accessPort: 8080 }), 'http://1.2.3.4:8080');
  assert.equal(buildAccessUrl({ accessProtocol: 'https', accessHost: '', host: 'vps.example.com' }), 'https://vps.example.com');
  assert.equal(buildAccessUrl({ accessProtocol: 'https', accessHost: 'x.example.com:8443', accessPort: 8443 }), 'https://x.example.com:8443');
  assert.equal(buildAccessUrl({}), null);
  assert.equal(buildAccessUrl(null), null);
  // 宿主给了 url 就用宿主的；没给就本地按同一规则拼
  assert.equal(redactStatus({ ssh: { url: 'https://from-host', config: { accessHost: 'x.example.com' } } }).ssh.url, 'https://from-host');
  assert.equal(redactStatus({ ssh: { config: { accessProtocol: 'http', accessHost: 'dsh.example.com', accessPort: 8000 } } }).ssh.url, 'http://dsh.example.com:8000');
});

test('redactStatus：字段类型不对时收敛到默认值（不把字符串/NaN 透给 UI）', () => {
  const s = redactStatus({
    ssh: {
      running: 'yes', state: 7,
      // task-19 诊断字段的类型错误也必须降级，且不抛
      evidence: 42, attempts: '3', nextRetryInMs: '1500', stderrTail: 'not-an-array', target: 'not-an-object',
      config: { port: '', remoteBindPort: 'abc', accessPort: '8080', accessProtocol: 'ftp', autoRestore: 'no' },
    },
    notify: { pushEnabled: 'true', onTaskDone: 'false', subscriptionCount: 'x', webhookPreset: 'telegram', minIntervalSec: '30' },
    passkey: { enabled: 1, deviceCount: '2' },
  });
  assert.equal(s.ssh.running, false, '只认 true');
  assert.equal(s.ssh.state, 'idle');
  assert.equal(s.ssh.evidence, null, '非字符串证据 → null');
  assert.equal(s.ssh.attempts, 0, '字符串 attempts → 0（严格只认 number）');
  assert.equal(s.ssh.nextRetryInMs, null, '字符串倒计时 → null');
  assert.deepEqual(s.ssh.stderrTail, [], '非数组 stderrTail → []');
  assert.equal(s.ssh.target, null, '非对象 target → null');
  // 负数/NaN 同样降级（不会把 -5 或 NaN 透给 UI）
  assert.equal(redactStatus({ ssh: { attempts: -5 } }).ssh.attempts, 0);
  assert.equal(redactStatus({ ssh: { attempts: Number.NaN } }).ssh.attempts, 0);
  assert.equal(redactStatus({ ssh: { nextRetryInMs: -1 } }).ssh.nextRetryInMs, null);
  assert.equal(redactStatus({ ssh: { nextRetryInMs: Number.POSITIVE_INFINITY } }).ssh.nextRetryInMs, null);
  assert.equal(s.ssh.config.port, 22, '空字符串回退默认端口');
  assert.equal(s.ssh.config.remoteBindPort, 7788);
  assert.equal(s.ssh.config.accessPort, 8080, '数字字符串可解析');
  assert.equal(s.ssh.config.accessProtocol, 'https', '未知协议回退 https');
  assert.equal(s.ssh.config.autoRestore, true, '只认 false 才关');
  assert.equal(s.notify.pushEnabled, false);
  assert.equal(s.notify.onTaskDone, true);
  assert.equal(s.notify.subscriptionCount, 0);
  assert.equal(s.notify.webhookPreset, 'generic');
  assert.equal(s.notify.minIntervalSec, 30, '宿主返回的最小间隔透传（缺失才是 null）');
  assert.equal(s.passkey.enabled, false);
  assert.equal(s.passkey.deviceCount, 2);
});

// ── task-6：设置页渲染冒烟 ────────────────────────────────────────────────
// 沙箱里没有 react / react-dom / jsdom，也不允许起子进程。这里用最小 React 桩执行
// **打包产物**里的设置页组件（client/client.js）：h() 变成可遍历的普通对象，
// useState/useEffect/useRef 按最小语义实现。目的不是替代浏览器，而是真把渲染树
// 跑一遍——未定义变量、空值访问、宿主字段缺失都会立刻抛；并驱动关键按钮验证
// RPC 载荷。跑之前需要先构建 client/client.js。

const FLUSH = () => setTimeout(0); // node:timers/promises：await 一轮宏任务 + 微任务

/** 最小 React 桩：createElement + useState/useEffect/useRef。 */
function createReactStub() {
  const cells = [];
  const pending = [];
  const api = {
    __index: 0,
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useState: (init) => {
      const i = api.__index++;
      if (!(i in cells)) cells[i] = typeof init === 'function' ? init() : init;
      const set = (next) => {
        const value = typeof next === 'function' ? next(cells[i]) : next;
        if (value !== cells[i]) cells[i] = value;
      };
      return [cells[i], set];
    },
    useEffect: (fn, deps) => {
      const i = api.__index++;
      const prev = cells[i];
      const changed = prev === undefined || deps === undefined || deps.some((d, k) => d !== prev.deps[k]);
      if (changed) pending.push({ i, fn, deps });
    },
    useRef: (init) => {
      const i = api.__index++;
      if (!(i in cells)) cells[i] = { current: init };
      return cells[i];
    },
  };
  /** 渲染一轮 + 跑本轮新挂的副作用 + 等在跑完的 setState 落定。 */
  const pass = async (Component, props) => {
    api.__index = 0;
    const tree = Component(props);
    const cleanups = [];
    for (const e of pending.splice(0)) {
      cells[e.i] = { deps: e.deps };
      const cleanup = e.fn();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    }
    await FLUSH();
    await FLUSH();
    for (const cleanup of cleanups) cleanup(); // 清掉 load 的定时器，避免测试进程挂住
    return tree;
  };
  return { api, pass };
}

function collect(node, pred, out = []) {
  if (Array.isArray(node)) { for (const n of node) collect(n, pred, out); return out; }
  if (!node || typeof node !== 'object') return out;
  if (node.type !== undefined && pred(node)) out.push(node);
  if (node.children) collect(node.children, pred, out);
  return out;
}
function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return '';
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node !== 'object') return String(node);
  return textOf(node.children);
}

/** 挂载打包产物里的设置页组件（真实组件代码 → 真实渲染树 + 可点的按钮）。 */
async function mountSettingsTab({ status, push = null, passkey = null, rpc = () => ({}) }) {
  const rpcCalls = [];
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  const navigatorStub = { clipboard: { writeText: async () => {} }, serviceWorker: {}, standalone: false, userAgent: 'node' };
  const element = () => ({ dataset: {}, style: {}, content: '', name: '', parentElement: null, setAttribute() {}, remove() {}, appendChild() {}, select() {}, removeChild() {} });
  const body = { setAttribute() {}, removeAttribute() {} };
  const documentStub = { body, head: { appendChild: () => {} }, createElement: element, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {}, execCommand: () => true };
  const windowStub = {
    location: { href: 'http://127.0.0.1:3080/', hostname: '127.0.0.1', protocol: 'http:' },
    navigator: navigatorStub,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    isSecureContext: true, PublicKeyCredential: function PublicKeyCredential() {},
    dshPocketPush: push,
    dshPocketPasskey: passkey,
  };
  const react = createReactStub();
  // 定时器全部换成不落地的桩：组件里的轮询/Toast 定时器不需要真的跑，
  // 也让测试进程不会因为残留 handle 挂住（清理函数照常调用）。
  const noTimer = () => 0;
  const sandbox = {
    window: windowStub, document: documentStub, navigator: navigatorStub,
    localStorage: storage, sessionStorage: storage, location: windowStub.location,
    CustomEvent, URL, console,
    setTimeout: noTimer, setInterval: noTimer, clearTimeout: () => {}, clearInterval: () => {},
  };
  let loadedModule = null;
  windowStub.__ModuleLoader__ = { load: (m) => { loadedModule = m; } };
  runInNewContext(readFileSync(new URL('../client/client.js', import.meta.url), 'utf8'), sandbox);
  assert.ok(loadedModule?.factory, '打包产物没有调用 window.__ModuleLoader__.load');
  assert.equal(loadedModule.id, 'dsh-pocket', '打包产物模块 id 固定');
  const mod = loadedModule.factory((id) => {
    if (id === 'react') return react.api;
    // 图标已改为 client/mobile/icons.tsx 自带内联 SVG：这里**故意不再提供任何图标导出**。
    // 之前这个桩恰好提供了 IconPanelLeftOutline16 等三个名字，而真实
    // @deepseek-ai/dsh-client-ui-primitives（DSH 0.1.7-rc.2）根本没有这些带 16 后缀的导出 ——
    // 桩把"引用了不存在的导出 → undefined → React #130 → 槽位崩溃"的真实故障掩盖了。
    // 现在若还有人从该包导入图标，渲染时会拿到 undefined，测试必须失败。
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {};
    throw new Error(`unexpected require("${id}")`);
  });

  let Tab = null;
  const ctx = {
    // 与真实宿主一致：RPC 失败返回 { ok:false, error }，而不是抛异常
    connection: {
      rpc: {
        call: async (_channel, endpoint, payload) => {
          rpcCalls.push({ endpoint, payload });
          const value = rpc(endpoint, payload);
          if (value === undefined) return { ok: false, error: { message: `unsupported ${endpoint}` } };
          return { ok: true, value };
        },
      },
    },
    locale: { bind: () => (key) => (key in POCKET_ZH ? POCKET_ZH[key] : key), register: () => () => {} },
    slots: { inject: (_name, cb) => cb(), register: (config, comp) => { if (config?.id === 'pocket') Tab = comp; return () => {}; } },
    effect: (cb) => { const d = cb(); return typeof d === 'function' ? d : () => {}; },
  };
  mod.apply(ctx);
  assert.equal(typeof Tab, 'function', '设置页组件没有注册到 settings.section');

  const t = (key) => (key in POCKET_ZH ? POCKET_ZH[key] : key);
  const props = () => ({ rpcCall: (endpoint, payload) => ctx.connection.rpc.call(null, endpoint, payload), t });
  let tree = null;
  const render = async () => { tree = await react.pass(Tab, props()); return tree; };
  const buttonsOf = (label) => collect(tree, (n) => n.type === 'button').filter((b) => textOf(b) === label);
  return {
    get tree() { return tree; },
    settle: async (rounds = 4) => { for (let i = 0; i < rounds; i++) await render(); return tree; },
    rpcCalls,
    buttons: buttonsOf,
    /** 点击按钮（可按文案取第 index 个），点完重渲染一轮。 */
    click: async (label, index = 0) => {
      const node = buttonsOf(label)[index];
      assert.ok(node, `找不到按钮「${label}」#${index}；当前按钮：${collect(tree, (n) => n.type === 'button').map(textOf).join(' / ')}`);
      await node.props.onClick?.();
      await FLUSH();
      await render();
      return node;
    },
    clickNode: async (node) => { await node.props.onClick?.(); await FLUSH(); await render(); },
    texts: () => collect(tree, () => true).map(textOf).join(' | '),
    nodes: (pred) => collect(tree, pred),
    /** 卡片根的直接子区块里，文本包含该文案 key 的那个（用于定位区块内的开关）。 */
    section: (key) => (tree?.children ?? []).find((c) => c && typeof c === 'object' && textOf(c).includes(POCKET_ZH[key])),
  };
}

/** 新宿主（task-5 契约）完整 status 快照。 */
const FULL_STATUS = {
  proxyRunning: true, proxyPort: 3081, lanUrl: 'http://192.168.1.5:3081', lanQr: 'data:qr-lan',
  lanCandidates: ['192.168.1.5'], lanIpOverride: '', tunnelRunning: false, tunnelUrl: null, tunnelQr: null,
  tunnelState: { phase: 'idle' }, tunnelConfig: { mode: 'ssh', hostname: '', tokenSet: false },
  dshPort: 3080, desktop: false, restartNotice: false, killHint: 'lsof -ti :3080 | xargs kill -9',
  accessToken: 'PIN12345', lanToken: 'LAN12345', lanAuthEnabled: true, lanEnabled: true,
  mobileRightbarEnabled: true, publicPinCustom: false, lanPinCustom: false,
  ssh: {
    running: true, state: 'connected', url: 'https://dsh.example.com', qr: 'data:qr-ssh', lastError: null,
    config: { host: 'vps.example.com', port: 22, user: 'dsh', keyPathSet: true, remoteBindPort: 7788, accessProtocol: 'https', accessHost: 'dsh.example.com', accessPort: 0, autoRestore: true },
  },
  notify: { pushEnabled: true, onTaskDone: true, webhookEnabled: true, webhookPreset: 'wecom', webhookUrl: 'https://hook.example.com/x', webhookConfigured: true, subscriptionCount: 2, minIntervalSec: 30 },
  passkey: { enabled: true, rpId: 'dsh.example.com', deviceCount: 1 },
};

/** 旧宿主：status 里完全没有 ssh / notify / passkey 三块（向后兼容路径）。 */
const LEGACY_STATUS = {
  proxyRunning: true, proxyPort: 3081, lanUrl: 'http://192.168.1.5:3081', lanQr: 'data:qr-lan',
  lanCandidates: [], lanIpOverride: '', tunnelRunning: false, tunnelUrl: null, tunnelQr: null,
  tunnelState: { phase: 'idle' }, tunnelConfig: { mode: 'quick', hostname: '', tokenSet: false },
  dshPort: 3080, desktop: false, restartNotice: false, killHint: 'x',
  accessToken: null, lanToken: 'LAN12345', lanAuthEnabled: true, lanEnabled: true,
  mobileRightbarEnabled: true, publicPinCustom: false, lanPinCustom: false,
};

function fullRpc(endpoint) {
  if (endpoint === POCKET_ENDPOINTS.status) return FULL_STATUS;
  if (endpoint === POCKET_ENDPOINTS.passkeyList) {
    return { devices: [{ id: 'dev-1', name: 'iPhone', createdAt: 1700000000000, lastLoginAt: 1700000500000 }] };
  }
  if (endpoint === POCKET_ENDPOINTS.notifyStatus) {
    return { ...FULL_STATUS.notify, lastResults: [{ channel: 'push', ok: true, status: 201, at: 1700000600000 }] };
  }
  // 写操作按契约返回完整 status（前端 setStatus 直接替换），避免把 state 打空
  if ([
    POCKET_ENDPOINTS.tunnelStart, POCKET_ENDPOINTS.tunnelStop, POCKET_ENDPOINTS.tunnelSetConfig,
    POCKET_ENDPOINTS.sshSetConfig, POCKET_ENDPOINTS.notifySetConfig, POCKET_ENDPOINTS.passkeySetEnabled,
    POCKET_ENDPOINTS.pocketReset, POCKET_ENDPOINTS.lanSetOverride,
  ].includes(endpoint)) return FULL_STATUS;
  return {};
}

test('设置页（task-6）：新宿主完整状态渲染不崩，三通道/通知/通行密钥区块齐全', async () => {
  const pushCalls = [];
  const installEvent = { prompt: async () => { pushCalls.push('prompt'); }, userChoice: Promise.resolve({ outcome: 'accepted' }) };
  const tab = await mountSettingsTab({
    status: FULL_STATUS,
    rpc: fullRpc,
    push: {
      supported: true,
      subscribe: async () => { pushCalls.push('subscribe'); return { ok: true }; },
      unsubscribe: async () => { pushCalls.push('unsubscribe'); return { ok: true }; },
      installPrompt: () => installEvent,
    },
  });
  await tab.settle();
  const texts = tab.texts();
  for (const key of ['sshTitle', 'sshStateConnected', 'sshRunningHint', 'notifyTitle', 'notifyPush', 'pwaRow', 'passkeyTitle', 'passkeyDevices', 'passkeySecureHint']) {
    assert.ok(texts.includes(POCKET_ZH[key]), `设置页缺少「${POCKET_ZH[key]}」`);
  }
  assert.ok(texts.includes('iPhone'), '通行密钥设备列表没渲染');
  assert.ok(texts.includes('dsh.example.com'), 'SSH 访问地址没渲染');
  assert.ok(texts.includes(`Web Push · ${POCKET_ZH.notifyResultOk}`), '最近推送结果没渲染');
  // 关键按钮都在，且可安装时给出「安装到主屏」
  assert.ok(tab.buttons(POCKET_ZH.stopTunnel).length, '公网入口运行中应显示唯一的「关闭公网」按钮');
  assert.ok(tab.buttons(POCKET_ZH.sshTest).length, '应有「测试连接」');
  assert.ok(tab.buttons(POCKET_ZH.notifyTest).length, '应有「发送测试通知」');
  assert.ok(tab.buttons(POCKET_ZH.notifyClear).length, '有订阅时应显示「清空全部订阅」');
  assert.ok(tab.buttons(POCKET_ZH.passkeyRevoke).length, '设备行应有「撤销」');
  assert.ok(tab.buttons(POCKET_ZH.pwaInstall).length, '可安装时应显示「安装到主屏」');

  // 订阅/取消必须在用户手势里直接调用 window.dshPocketPush
  await tab.click(POCKET_ZH.notifySubscribe);
  assert.deepEqual(pushCalls, ['subscribe']);
  await tab.click(POCKET_ZH.notifyUnsubscribe);
  assert.deepEqual(pushCalls, ['subscribe', 'unsubscribe']);
  // 发送测试通知 → notify.test
  await tab.click(POCKET_ZH.notifyTest);
  assert.ok(tab.rpcCalls.some((c) => c.endpoint === POCKET_ENDPOINTS.notifyTest), '测试通知没打到 notify.test');
  // PWA 安装 → 消费缓存的 beforeinstallprompt
  await tab.click(POCKET_ZH.pwaInstall);
  assert.deepEqual(pushCalls, ['subscribe', 'unsubscribe', 'prompt']);

  // 撤销设备：两步确认（先看后果，再撤销）→ passkey.revoke { id }
  await tab.click(POCKET_ZH.passkeyRevoke);
  await tab.settle(2);
  assert.ok(tab.texts().includes(POCKET_ZH.passkeyRevokeConfirm), '撤销前必须显示后果说明');
  await tab.click(POCKET_ZH.passkeyRevoke, 1);
  const revoke = tab.rpcCalls.find((c) => c.endpoint === POCKET_ENDPOINTS.passkeyRevoke);
  assert.ok(revoke, '撤销设备没打到 passkey.revoke');
  assert.equal(revoke.payload?.id, 'dev-1');

  // 重命名：输入框回车提交 → passkey.rename { id, name }
  await tab.click(POCKET_ZH.passkeyRename);
  await tab.settle(2);
  const renameInput = tab.nodes((n) => n.type === 'input' && n.props.maxLength === 40 && n.props.value === 'iPhone')[0];
  assert.ok(renameInput, '重命名输入框没渲染');
  renameInput.props.onChange({ target: { value: '办公 iPhone' } });
  await tab.settle(1); // React 语义：输入后重渲染，事件处理器才拿到新值
  const renameInput2 = tab.nodes((n) => n.type === 'input' && n.props.maxLength === 40)[0];
  await renameInput2.props.onKeyDown({ key: 'Enter' });
  await tab.settle(2);
  const rename = tab.rpcCalls.find((c) => c.endpoint === POCKET_ENDPOINTS.passkeyRename);
  assert.ok(rename, '重命名没打到 passkey.rename');
  assert.deepEqual({ id: rename.payload?.id, name: rename.payload?.name }, { id: 'dev-1', name: '办公 iPhone' });

  // 通行密钥总开关（区块标题行的 switch）→ passkey.setEnabled { on }
  const passkeySwitch = collect(tab.section('passkeyTitle'), (n) => n.type === 'button' && n.props.role === 'switch')[0];
  assert.ok(passkeySwitch, '通行密钥区块没渲染开关');
  await tab.clickNode(passkeySwitch);
  const toggle = tab.rpcCalls.find((c) => c.endpoint === POCKET_ENDPOINTS.passkeySetEnabled);
  assert.ok(toggle, '通行密钥开关没打到 passkey.setEnabled');
  assert.deepEqual({ ...toggle.payload }, { on: false });
});

test('设置页（task-6）：SSH 保存/测试连接走冻结端点，字段与契约一致', async () => {
  const tab = await mountSettingsTab({ status: FULL_STATUS, rpc: fullRpc });
  await tab.settle();
  // 改 SSH 主机后再保存：ssh.setConfig 必须带 mode:'ssh' + 全部字段
  const hostInput = tab.nodes((n) => n.type === 'input' && n.props.value === 'vps.example.com')[0];
  assert.ok(hostInput, 'SSH 主机输入框没渲染');
  hostInput.props.onChange({ target: { value: 'vps2.example.com' } });
  await tab.settle(2);
  await tab.click(POCKET_ZH.save, 0); // 树里第一个「保存」＝SSH 区块的保存
  const saved = tab.rpcCalls.find((c) => c.endpoint === POCKET_ENDPOINTS.sshSetConfig);
  assert.ok(saved, '保存 SSH 配置没打到 ssh.setConfig');
  // 注意用展开复制成宿主对象再比：vm 上下文里的对象原型不同，deepStrictEqual 会误报
  assert.deepEqual({ ...saved.payload }, {
    mode: 'ssh', host: 'vps2.example.com', user: 'dsh', port: 22, keyPath: '',
    remoteBindPort: 7788, accessProtocol: 'https', accessHost: 'dsh.example.com', accessPort: 0, autoRestore: true,
  });
  // 测试连接 → ssh.status { test: true }
  await tab.click(POCKET_ZH.sshTest);
  const probe = tab.rpcCalls.find((c) => c.endpoint === POCKET_ENDPOINTS.sshStatus);
  assert.ok(probe, '测试连接没打到 ssh.status');
  assert.deepEqual({ ...probe.payload }, { test: true });
  // 运行中：唯一的停止按钮走 tunnel.stop（不新增端点，SSH 与 cloudflared 一起停）
  await tab.click(POCKET_ZH.stopTunnel);
  assert.ok(tab.rpcCalls.some((c) => c.endpoint === POCKET_ENDPOINTS.tunnelStop), '关闭公网没打到 tunnel.stop');
  // 切到固定域名：只展开既有表单并记为"选中但未保存"，不立刻改已存模式（保存时才切）
  await tab.click(POCKET_ZH.modeNamed);
  await tab.settle(1);
  assert.ok(tab.texts().includes(POCKET_ZH.namedHostnameLabel), '切到固定域名应展开既有表单');
  // 切回 Quick：沿用既有 tunnel.setConfig（三通道互斥，保存即生效）
  await tab.click(POCKET_ZH.modeQuick);
  const quick = tab.rpcCalls.find((c) => c.endpoint === POCKET_ENDPOINTS.tunnelSetConfig);
  assert.ok(quick, '切回 Quick 没打到 tunnel.setConfig');
  assert.deepEqual({ ...quick.payload }, { mode: 'quick' });
});

test('设置页（task-6）：旧宿主（无 ssh/notify/passkey 字段）只降级提示，不崩不白屏', async () => {
  const tab = await mountSettingsTab({
    status: LEGACY_STATUS,
    rpc: (endpoint) => (endpoint === POCKET_ENDPOINTS.status ? LEGACY_STATUS : {}),
  });
  await tab.settle();
  const texts = tab.texts();
  assert.ok(texts.includes(POCKET_ZH.lanAccess), '旧宿主下原有局域网区块必须照常渲染');
  assert.ok(texts.includes(POCKET_ZH.wanAccess), '旧宿主下原有公网区块必须照常渲染');
  // texts() 会把祖先容器的文本也算进来，所以按「卡片根的直接子区块」计数
  const notedBlocks = () => (tab.tree?.children ?? []).filter((c) => c && typeof c === 'object' && textOf(c).includes(POCKET_ZH.hostUnsupported));
  assert.equal(notedBlocks().length, 2, '通知/通行密钥两个状态块应给出明确提示');
  // SSH 区块只在选中 SSH 时展开：旧宿主上点它也要能打开并明确说「本版本不支持」
  await tab.click(POCKET_ZH.modeSsh);
  await tab.settle(2);
  assert.equal(notedBlocks().length, 3, '点开 SSH 后应出现第三个提示块');
  assert.ok(tab.texts().includes(POCKET_ZH.sshTitle), 'SSH 区块打开后应有标题');
  // 旧宿主不该去调新端点（避免无谓报错噪音）
  const called = new Set(tab.rpcCalls.map((c) => c.endpoint));
  assert.ok(!called.has(POCKET_ENDPOINTS.passkeyList), '旧宿主不该请求 passkey.list');
  assert.ok(!called.has(POCKET_ENDPOINTS.notifyStatus), '旧宿主不该请求 notify.status');
  assert.ok(!called.has(POCKET_ENDPOINTS.sshSetConfig), '旧宿主不该写 ssh.setConfig');
  // 非 HTTPS（局域网 http）时通行密钥文案优先解释安全上下文
  assert.ok(texts.includes(POCKET_ZH.passkeyInsecure) || texts.includes(POCKET_ZH.hostUnsupported));
});

/** Quick 模式、SSH 尚未配置：复现用户实测场景「配完 SSH 点启动却开了 Cloudflare」。 */
const QUICK_UNCONFIGURED_STATUS = {
  ...FULL_STATUS,
  tunnelRunning: false, tunnelUrl: null, tunnelQr: null, tunnelState: { phase: 'idle' },
  tunnelConfig: { mode: 'quick', hostname: '', tokenSet: false },
  ssh: {
    running: false, state: 'idle', url: null, qr: null, lastError: null,
    config: { host: '', port: 22, user: '', keyPathSet: false, remoteBindPort: 7788, accessProtocol: 'https', accessHost: '', accessPort: 0, autoRestore: true },
  },
};
const startLabelFor = (key) => POCKET_ZH.startChannel.replace('{channel}', POCKET_ZH[key]);
/** 状态接口固定返回"Quick 模式 + SSH 未配置"，其余端点沿用 fullRpc。 */
const quickRpc = (endpoint, payload) => (endpoint === POCKET_ENDPOINTS.status ? QUICK_UNCONFIGURED_STATUS : fullRpc(endpoint, payload));
/** 走完「点启动 → 勾选免责声明 → 确认」的完整手势。 */
async function startViaDisclaimer(tab, label) {
  await tab.click(label);
  const checkbox = tab.nodes((n) => n.type === 'input' && n.props.type === 'checkbox')[0];
  assert.ok(checkbox, '免责声明弹窗应出现勾选框');
  checkbox.props.onChange({ target: { checked: true } });
  await tab.settle(1);
  await tab.click(POCKET_ZH.disclaimerAgree);
  await tab.settle(2);
}

test('设置页：公网入口只有一个启动按钮，文案指明将要启动的通道，SSH 区块内不再有启动按钮', async () => {
  const tab = await mountSettingsTab({ status: QUICK_UNCONFIGURED_STATUS, rpc: quickRpc });
  await tab.settle();
  assert.equal(tab.buttons(startLabelFor('channelQuick')).length, 1, 'Quick 模式应只有一个启动按钮');
  assert.equal(tab.buttons(POCKET_ZH.enable).length, 0, '不应再出现不带通道名的笼统「开启公网访问」按钮');
  // 选中 SSH（尚未保存）：按钮文案立刻指向 SSH 隧道，并给出未保存提示
  await tab.click(POCKET_ZH.modeSsh);
  await tab.settle(2);
  assert.equal(tab.buttons(startLabelFor('channelSsh')).length, 1, '选中 SSH 后启动按钮应指向 SSH 隧道');
  assert.equal(tab.buttons(startLabelFor('channelQuick')).length, 0, '不应同时出现两条通道的启动按钮');
  assert.ok(tab.texts().includes(POCKET_ZH.modePendingHint.replace('{channel}', POCKET_ZH.channelSsh)), '应有未保存提示');
  // 整页只允许一个启动入口（SSH 区块内的重复启动按钮已删除），区块内只保留保存/测试连接
  const startish = collect(tab.tree, (n) => n.type === 'button').map(textOf).filter((txt) => txt.includes('开启公网访问'));
  assert.equal(startish.length, 1, '整页只应有一个启动入口');
  const sshButtons = collect(tab.section('sshTitle'), (n) => n.type === 'button').map(textOf);
  assert.ok(sshButtons.includes(POCKET_ZH.save) && sshButtons.includes(POCKET_ZH.sshTest), 'SSH 区块应保留保存与测试连接');
  assert.ok(sshButtons.includes(POCKET_ZH.sshStartHint) === false, 'SSH 区块按钮里不应再出现启动隧道文案');
});

test('设置页：配好 SSH 但未保存就点启动 → 先保存 SSH 配置再启动，绝不悄悄开 Cloudflare', async () => {
  const tab = await mountSettingsTab({ status: QUICK_UNCONFIGURED_STATUS, rpc: quickRpc });
  await tab.settle();
  await tab.click(POCKET_ZH.modeSsh);
  await tab.settle(2);
  const hostInput = tab.nodes((n) => n.type === 'input' && n.props.placeholder === 'vps.example.com')[0];
  assert.ok(hostInput, 'SSH 主机输入框没渲染');
  hostInput.props.onChange({ target: { value: 'vps.test' } });
  await tab.settle(2);
  const userInput = tab.nodes((n) => n.type === 'input' && n.props.placeholder === 'dsh')[0];
  userInput.props.onChange({ target: { value: 'deploy' } });
  await tab.settle(2);

  await startViaDisclaimer(tab, startLabelFor('channelSsh'));

  const saveIdx = tab.rpcCalls.findIndex((c) => c.endpoint === POCKET_ENDPOINTS.sshSetConfig);
  const startIdx = tab.rpcCalls.findIndex((c) => c.endpoint === POCKET_ENDPOINTS.tunnelStart);
  assert.ok(saveIdx >= 0, '必须先落盘 SSH 配置（ssh.setConfig）');
  assert.ok(startIdx >= 0, '随后应发起 tunnel.start');
  assert.ok(saveIdx < startIdx, '顺序必须是先保存 SSH 配置、再启动隧道');
  assert.equal(tab.rpcCalls[saveIdx].payload.mode, 'ssh');
  assert.equal(tab.rpcCalls[saveIdx].payload.host, 'vps.test');
  assert.equal(tab.rpcCalls[saveIdx].payload.user, 'deploy');
  assert.ok(
    !tab.rpcCalls.some((c) => c.endpoint === POCKET_ENDPOINTS.tunnelSetConfig && c.payload?.mode === 'quick'),
    '不应在用户选择 SSH 的情况下切回 Cloudflare',
  );
});

test('设置页：选中 SSH 但主机/用户名没填 → 启动被明确阻止，不落盘也不发起隧道', async () => {
  const tab = await mountSettingsTab({ status: QUICK_UNCONFIGURED_STATUS, rpc: quickRpc });
  await tab.settle();
  await tab.click(POCKET_ZH.modeSsh);
  await tab.settle(2);
  await startViaDisclaimer(tab, startLabelFor('channelSsh'));
  assert.ok(!tab.rpcCalls.some((c) => c.endpoint === POCKET_ENDPOINTS.tunnelStart), '配置不全时绝不能发起隧道');
  assert.ok(!tab.rpcCalls.some((c) => c.endpoint === POCKET_ENDPOINTS.sshSetConfig), '配置不全时也不该落盘');
  assert.ok(tab.texts().includes(POCKET_ZH.sshNeedCfg), '应明确提示「请先填写 SSH 主机与用户名」');
});

test('设置页：推送结果列出多条并标注推送服务归属（FCM 失败不再掩盖 Mozilla/Apple 成功）', async () => {
  const lastResults = [
    { channel: 'push', ok: false, status: 0, error: '推送网络错误: fetch failed | network error', endpoint: 'https://fcm.googleapis.com/fcm/send/abc', at: 1 },
    { channel: 'push', ok: true, status: 201, endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/xyz', at: 2 },
    { channel: 'webhook', ok: true, status: 200, at: 3 },
  ];
  const status = { ...FULL_STATUS, notify: { ...FULL_STATUS.notify, lastResults } };
  const rpc = (endpoint) => (endpoint === POCKET_ENDPOINTS.status ? status
    : endpoint === POCKET_ENDPOINTS.notifyStatus ? { ...status.notify }
      : fullRpc(endpoint));
  const tab = await mountSettingsTab({ status, rpc });
  await tab.settle();
  const texts = tab.texts();
  assert.ok(texts.includes(POCKET_ZH.notifyRecentTitle), '应列出多条最近推送，而不是只显示末条');
  assert.ok(texts.includes(POCKET_ZH.notifyHostFcm), 'FCM 订阅应标注 Google FCM（国内通常不可达）');
  assert.ok(texts.includes(POCKET_ZH.notifyHostMozilla), 'Mozilla 订阅应标注来源');
  assert.ok(texts.includes(POCKET_ZH.notifyResultOk), '同一批里成功的订阅结果也必须显示（不被失败项掩盖）');
});

test('设置页：通行密钥注册入口常驻（登录后的横幅被关掉也能注册）', async () => {
  // 没有注入 dshPocketPasskey：点击给出明确原因，而不是静默失败
  const noApi = await mountSettingsTab({ status: FULL_STATUS, rpc: fullRpc });
  await noApi.settle();
  assert.equal(noApi.buttons(POCKET_ZH.passkeyRegisterBtn).length, 1, '设置页应有「在此设备注册」按钮');
  await noApi.click(POCKET_ZH.passkeyRegisterBtn);
  assert.ok(noApi.texts().includes(POCKET_ZH.passkeyRegisterUnavailable), '缺少注入接口时应说明原因');

  // 有注入接口：成功路径 → 带上设备名、提示已注册、刷新设备列表
  const calls = [];
  const okTab = await mountSettingsTab({
    status: FULL_STATUS, rpc: fullRpc,
    passkey: { register: async (name) => { calls.push(name); return { ok: true, device: { id: 'new-dev' } }; } },
  });
  await okTab.settle();
  await okTab.click(POCKET_ZH.passkeyRegisterBtn);
  assert.deepEqual(calls, [POCKET_ZH.passkeyThisDevice], '注册时应带上设备名');
  assert.ok(okTab.texts().includes(POCKET_ZH.passkeyRegistered), '成功应提示已注册');
  assert.ok(okTab.rpcCalls.some((c) => c.endpoint === POCKET_ENDPOINTS.passkeyList), '成功应刷新设备列表');

  // 失败路径：错误原因透出（用户取消 / 非 HTTPS 等）
  const badTab = await mountSettingsTab({
    status: FULL_STATUS, rpc: fullRpc,
    passkey: { register: async () => ({ ok: false, error: { message: '用户取消 | cancelled' } }) },
  });
  await badTab.settle();
  await badTab.click(POCKET_ZH.passkeyRegisterBtn);
  assert.ok(badTab.texts().includes('用户取消'), '失败原因应显示出来');
});


