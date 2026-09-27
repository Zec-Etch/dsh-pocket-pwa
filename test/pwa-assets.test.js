// PWA 资源（lib/pwa-assets.mjs）测试
//
// 三条硬要求：
//   1) manifest 必须满足 Chrome 安装条件（name/short_name/start_url/scope/display + 192/512 图标）；
//   2) service worker 必须**能编译**并且 6 个处理器（install/activate/fetch/push/notificationclick/
//      pushsubscriptionchange）都真的能跑起来 —— 所以这里不是只用正则匹配，还在 vm 沙箱里
//      带桩执行每个事件，检查 install 预缓存、push 弹通知、点击开窗口、续订回传后端；
//   3) 图标必须是真实 PNG：校验签名、chunk CRC、IDAT 可 inflate、IHDR 尺寸与像素内容。
//
// 运行：node --test --test-isolation=none --test-timeout=30000 test/pwa-assets.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { inflateSync, crc32 } from 'node:zlib';
import {
  ICONS,
  PUSH_SUB_TO_JSON_SRC,
  PWA_PATHS,
  SW_SOURCE,
  contentTypeFor,
  iconBuffer,
  iconPath,
  manifestFor,
  pwaAssetFor,
} from '../lib/pwa-assets.mjs';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ORIGIN = 'https://pocket.example.com';

/** 解 PNG：校验签名与每个 chunk 的 CRC，并 inflate IDAT。 */
function decodePng(buf) {
  assert.deepEqual(buf.subarray(0, 8), PNG_MAGIC, 'PNG 签名不对');
  let offset = 8;
  const chunks = [];
  let header = null;
  const idat = [];
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    const crc = buf.readUInt32BE(offset + 8 + length);
    assert.equal(crc, crc32(buf.subarray(offset + 4, offset + 8 + length)) >>> 0, `${type} chunk CRC 不对`);
    chunks.push(type);
    if (type === 'IHDR') {
      header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), bitDepth: data[8], colorType: data[9] };
    }
    if (type === 'IDAT') idat.push(Buffer.from(data));
    offset += 12 + length;
  }
  assert.deepEqual(chunks[0], 'IHDR');
  assert.deepEqual(chunks.at(-1), 'IEND');
  assert.equal(header.bitDepth, 8);
  assert.equal(header.colorType, 6, '图标应为 RGBA（color type 6）');
  const raw = inflateSync(Buffer.concat(idat));
  const stride = header.width * 4;
  assert.equal(raw.length, (stride + 1) * header.height, 'IDAT 解压后长度应与尺寸匹配');
  for (let y = 0; y < header.height; y++) {
    assert.equal(raw[y * (stride + 1)], 0, '只应使用 filter 0');
  }
  const pixels = Buffer.alloc(stride * header.height);
  for (let y = 0; y < header.height; y++) {
    raw.copy(pixels, y * stride, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
  }
  const at = (x, y) => {
    const i = (y * header.width + x) * 4;
    return [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]];
  };
  return { ...header, pixels, at, raw };
}

// ---------------------------------------------------------------- manifest

test('manifestFor：Chrome 安装所需字段齐全，且不含绝对域名', () => {
  const manifest = manifestFor();
  assert.equal(manifest.id, '/');
  assert.equal(manifest.name, 'DSH Pocket');
  assert.equal(manifest.short_name, 'DSH');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.deepEqual(manifest.display_override, ['standalone', 'minimal-ui']);
  assert.equal(manifest.lang, 'zh-CN');
  assert.ok(manifest.description.length > 0);
  assert.equal(manifest.prefer_related_applications, false);
  assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/i);
  assert.match(manifest.background_color, /^#[0-9a-f]{6}$/i);

  const sizes = manifest.icons.map((icon) => icon.sizes);
  assert.ok(sizes.includes('192x192'), '必须有 192 图标');
  assert.ok(sizes.includes('512x512'), '必须有 512 图标');
  assert.ok(manifest.icons.some((icon) => icon.purpose === 'maskable' && icon.sizes === '512x512'), '必须有 512 maskable 图标');
  for (const icon of manifest.icons) {
    assert.equal(icon.type, 'image/png');
    assert.ok(icon.src.startsWith('/'), `图标路径必须是站内绝对路径: ${icon.src}`);
    assert.ok(iconBuffer(icon.src), `manifest 里的图标必须真的存在: ${icon.src}`);
  }
  const json = JSON.stringify(manifest);
  assert.equal(json.includes('://'), false, 'manifest 里不允许出现绝对域名');
});

test('manifestFor：参数可覆盖，空字符串回退默认值', () => {
  const custom = manifestFor({ name: 'My DSH', shortName: 'DSH2', description: 'd', themeColor: '#123456', backgroundColor: '#654321', display: 'minimal-ui' });
  assert.equal(custom.name, 'My DSH');
  assert.equal(custom.short_name, 'DSH2');
  assert.equal(custom.theme_color, '#123456');
  assert.equal(custom.background_color, '#654321');
  assert.equal(custom.display, 'minimal-ui');
  const fallback = manifestFor({ name: '', shortName: '   ', description: '', themeColor: '', backgroundColor: '', display: '' });
  assert.equal(fallback.name, 'DSH Pocket');
  assert.equal(fallback.short_name, 'DSH');
  assert.equal(fallback.display, 'standalone');
});

// ---------------------------------------------------------------- service worker

test('SW_SOURCE：能编译，且包含 6 个处理器', () => {
  assert.doesNotThrow(() => new vm.Script(SW_SOURCE, { filename: 'pocket-sw.js' }), 'SW 源码必须能编译');
  for (const name of ['install', 'activate', 'fetch', 'push', 'notificationclick', 'pushsubscriptionchange']) {
    assert.match(SW_SOURCE, new RegExp(`addEventListener\\('${name}'`), `SW 缺少 ${name} 处理器`);
  }
  assert.equal(/https?:\/\//.test(SW_SOURCE), false, 'SW 里不应出现绝对域名');
  // fetch 处理器必须非空（Chrome 安装提示要求）
  const fetchHandler = /addEventListener\('fetch',([\s\S]*?)\n\}\);/.exec(SW_SOURCE);
  assert.ok(fetchHandler, '找不到 fetch 处理器');
  assert.ok(fetchHandler[1].replace(/\s+/g, '').length > 40, 'fetch 处理器不能是空壳');
  assert.match(fetchHandler[1], /respondWith/);
});

/** 在 vm 沙箱里带桩执行 SW，返回 { handlers, calls, dispatch }。 */
function loadServiceWorker(overrides = {}) {
  const handlers = new Map();
  const calls = { add: [], delete: [], put: [], skipWaiting: 0, claim: 0, notifications: [], openWindow: [], fetch: [], subscribe: [], matched: [] };
  const store = new Map();
  const cache = {
    add: async (url) => {
      calls.add.push(url);
      store.set(url, { url, body: `cached:${url}` });
    },
    match: async (request) => {
      const url = typeof request === 'string' ? request : request.url;
      calls.matched.push(url);
      return store.get(url);
    },
    put: async (request, response) => {
      const url = typeof request === 'string' ? request : request.url;
      calls.put.push(url);
      store.set(url, response);
    },
  };
  const clientsList = overrides.clients ?? [];
  const selfObj = {
    location: { origin: ORIGIN, href: `${ORIGIN}${PWA_PATHS.serviceWorker}` },
    addEventListener: (name, handler) => handlers.set(name, handler),
    skipWaiting: async () => {
      calls.skipWaiting += 1;
    },
    registration: {
      showNotification: async (title, options) => {
        calls.notifications.push({ title, options });
      },
      pushManager: {
        subscribe: async (options) => {
          calls.subscribe.push(options);
          return overrides.newSubscription ?? { endpoint: 'https://fcm.googleapis.com/fcm/send/renewed', toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/renewed', keys: { p256dh: 'p', auth: 'a' } }) };
        },
      },
    },
    clients: {
      claim: async () => {
        calls.claim += 1;
      },
      matchAll: async () => clientsList,
      openWindow: async (url) => {
        calls.openWindow.push(url);
        return { url };
      },
    },
  };
  const sandbox = {
    self: selfObj,
    caches: {
      open: async () => cache,
      keys: async () => ['dsh-pocket-assets-v1', 'some-old-cache'],
      delete: async (key) => {
        calls.delete.push(key);
        return true;
      },
    },
    fetch: async (url, init) => {
      calls.fetch.push({ url, init });
      if (overrides.fetchImpl) return overrides.fetchImpl(url, init);
      return new Response('fresh', { status: 200, headers: { 'content-type': 'text/plain' } });
    },
    URL,
    Response,
    console,
  };
  vm.createContext(sandbox);
  new vm.Script(SW_SOURCE, { filename: 'pocket-sw.js' }).runInContext(sandbox);
  const dispatch = (name, event) => {
    const handler = handlers.get(name);
    assert.ok(handler, `SW 没有注册 ${name}`);
    const waited = [];
    handler({ ...event, waitUntil: (promise) => waited.push(promise) });
    return Promise.all(waited);
  };
  return { handlers, calls, dispatch, store };
}

test('SW 运行时：install 预缓存 + skipWaiting，activate 清旧缓存 + claim', async () => {
  const sw = loadServiceWorker();
  await sw.dispatch('install', {});
  assert.equal(sw.calls.skipWaiting, 1);
  assert.deepEqual(sw.calls.add.sort(), [PWA_PATHS.manifest, PWA_PATHS.icon192, PWA_PATHS.icon512, PWA_PATHS.iconMaskable512, PWA_PATHS.badge].sort());
  await sw.dispatch('activate', {});
  assert.equal(sw.calls.claim, 1);
  assert.deepEqual(sw.calls.delete, ['some-old-cache'], '只清掉不认识的旧缓存');
});

test('SW 运行时：fetch 命中缓存走缓存，导航断网回离线页，非 GET 不接管', async () => {
  let fetchCount = 0;
  const sw = loadServiceWorker({
    fetchImpl: async () => {
      fetchCount += 1;
      return new Response('network', { status: 200 });
    },
  });
  const makeRequest = (url, extra = {}) => ({ url, method: 'GET', mode: 'cors', ...extra });

  // 第一次：缓存空 → 走网络并写缓存
  const first = [];
  await sw.dispatch('fetch', { request: makeRequest(`${ORIGIN}${PWA_PATHS.icon192}`), respondWith: (p) => first.push(p) });
  assert.equal((await first[0]).status, 200);
  assert.equal(fetchCount, 1);
  assert.deepEqual(sw.calls.put, [`${ORIGIN}${PWA_PATHS.icon192}`]);

  // 第二次：命中缓存 → 不再打网络
  const second = [];
  await sw.dispatch('fetch', { request: makeRequest(`${ORIGIN}${PWA_PATHS.icon192}`), respondWith: (p) => second.push(p) });
  assert.equal(await (await second[0]).text(), 'network', '缓存里存的是第一次的响应');
  assert.equal(fetchCount, 1, '缓存命中时不应再请求网络');
  assert.equal(sw.calls.matched.length, 2, '两次都应先查缓存');

  // 导航断网 → 离线兜底页（不是直接抛错）
  const offlineSw = loadServiceWorker({
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });
  const nav = [];
  await offlineSw.dispatch('fetch', {
    request: makeRequest(`${ORIGIN}/`, { mode: 'navigate' }),
    respondWith: (p) => nav.push(p),
  });
  const html = await (await nav[0]).text();
  assert.match(html, /<html/i);
  assert.match(html, /DSH/);

  // 非 GET 与跨域请求：不接管
  const ignored = [];
  await sw.dispatch('fetch', { request: makeRequest(`${ORIGIN}/api`, { method: 'POST' }), respondWith: (p) => ignored.push(p) });
  await sw.dispatch('fetch', { request: makeRequest('https://other.example.com/x.png'), respondWith: (p) => ignored.push(p) });
  assert.equal(ignored.length, 0, 'POST/跨域请求不应 respondWith');
});

test('SW 运行时：push 一定 showNotification，字段按后端约定解析', async () => {
  const sw = loadServiceWorker();
  const payload = { title: '任务完成', body: '会话 abc 结束', url: '/?session=abc', tag: 'dsh-pocket:abc', sessionId: 'abc' };
  await sw.dispatch('push', { data: { json: () => payload, text: () => JSON.stringify(payload) } });
  assert.equal(sw.calls.notifications.length, 1);
  const [title, options] = [sw.calls.notifications[0].title, sw.calls.notifications[0].options];
  assert.equal(title, '任务完成');
  assert.equal(options.body, '会话 abc 结束');
  assert.equal(options.tag, 'dsh-pocket:abc');
  assert.equal(options.icon, PWA_PATHS.icon192);
  assert.equal(options.badge, PWA_PATHS.badge);
  assert.equal(options.data.url, '/?session=abc');
  assert.equal(options.data.sessionId, 'abc');

  // 非 JSON 推送（别的系统乱发的）也不能崩
  const sw2 = loadServiceWorker();
  await sw2.dispatch('push', {
    data: {
      json: () => {
        throw new Error('not json');
      },
      text: () => '纯文本通知',
    },
  });
  assert.equal(sw2.calls.notifications[0].title, '纯文本通知');
  assert.equal(sw2.calls.notifications[0].options.body, '');

  // 没有 data 的静默推送：仍然要弹（否则 Chrome 会吊销订阅）
  const sw3 = loadServiceWorker();
  await sw3.dispatch('push', {});
  assert.equal(sw3.calls.notifications[0].title, 'DSH Pocket');
  assert.equal(sw3.calls.notifications[0].options.tag, 'dsh-pocket');
});

test('SW 运行时：notificationclick 先聚焦已有窗口，没有窗口才 openWindow', async () => {
  const focused = [];
  const navigated = [];
  const sw = loadServiceWorker({
    clients: [
      { url: `${ORIGIN}/#/session/1`, focus: async () => focused.push('focus'), navigate: async (url) => navigated.push(url) },
    ],
  });
  await sw.dispatch('notificationclick', { notification: { close: () => focused.push('close'), data: { url: '/?session=abc' } } });
  assert.deepEqual(focused, ['close', 'focus']);
  assert.deepEqual(navigated, [`${ORIGIN}/?session=abc`]);
  assert.equal(sw.calls.openWindow.length, 0);

  const sw2 = loadServiceWorker({ clients: [] });
  await sw2.dispatch('notificationclick', { notification: { close: () => {}, data: { url: '/?session=xyz' } } });
  assert.deepEqual(sw2.calls.openWindow, [`${ORIGIN}/?session=xyz`]);
});

test('SW 运行时：pushsubscriptionchange 重新订阅并回传 /pocket-push-subscribe', async () => {
  const sub = { toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/new', keys: { p256dh: 'p', auth: 'a' } }) };
  const sw = loadServiceWorker({ newSubscription: sub });
  await sw.dispatch('pushsubscriptionchange', {
    oldSubscription: { options: { applicationServerKey: 'SERVER_KEY' } },
  });
  assert.equal(sw.calls.subscribe.length, 1);
  assert.equal(sw.calls.subscribe[0].userVisibleOnly, true);
  assert.equal(sw.calls.subscribe[0].applicationServerKey, 'SERVER_KEY');
  assert.equal(sw.calls.fetch.length, 1);
  const call = sw.calls.fetch[0];
  assert.equal(call.url, PWA_PATHS.subscribe);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.credentials, 'same-origin');
  const body = JSON.parse(call.init.body);
  assert.equal(body.reason, 'pushsubscriptionchange');
  assert.deepEqual(body.subscription, sub.toJSON());

  // 浏览器已经给了 newSubscription：不该再 subscribe 一次
  const sw2 = loadServiceWorker();
  await sw2.dispatch('pushsubscriptionchange', { newSubscription: sub });
  assert.equal(sw2.calls.subscribe.length, 0);
  assert.equal(sw2.calls.fetch.length, 1);
});

// ---------------------------------------------------------------- 图标

test('ICONS：4 张真实 PNG，尺寸/CRC/像素都对', () => {
  assert.deepEqual(Object.keys(ICONS).sort(), ['pocket-badge.png', 'pocket-icon-192.png', 'pocket-icon-512.png', 'pocket-icon-maskable-512.png']);
  const expected = {
    'pocket-icon-192.png': 192,
    'pocket-icon-512.png': 512,
    'pocket-icon-maskable-512.png': 512,
    'pocket-badge.png': 72,
  };
  const colors = new Set();
  for (const [name, size] of Object.entries(expected)) {
    const isBadge = name === 'pocket-badge.png';
    const buf = iconBuffer(name);
    assert.ok(buf && buf.length > 100, `${name} 应该有内容`);
    assert.equal(Buffer.from(ICONS[name], 'base64').toString('hex'), buf.toString('hex'), `${name} base64 常量应能解出原图`);
    const png = decodePng(buf);
    assert.equal(png.width, size, `${name} 宽度`);
    assert.equal(png.height, size, `${name} 高度`);
    // 深色底 + 浅色字形：普通图标中心不透明且深浅两色都有；badge 是透明底上的白色字形
    if (!isBadge) {
      assert.equal(png.at(size >> 1, size >> 1)[3], 255, `${name} 中心应不透明`);
    }
    let dark = 0;
    let light = 0;
    for (let y = 0; y < size; y += Math.max(1, size >> 6)) {
      for (let x = 0; x < size; x += Math.max(1, size >> 6)) {
        const px = png.at(x, y);
        colors.add(px.join(','));
        if (px[3] > 200 && px[0] < 80 && px[1] < 80) dark += 1;
        if (px[3] > 200 && px[0] > 180 && px[1] > 180 && px[2] > 180) light += 1;
      }
    }
    if (!isBadge) assert.ok(dark > 10, `${name} 应有深色底`);
    assert.ok(light > 5, `${name} 应有浅色字形`);
  }
  // 圆角图标四角透明；maskable 必须铺满（平台自己裁圆角）
  assert.equal(decodePng(iconBuffer('pocket-icon-192.png')).at(0, 0)[3], 0, '192 图标应为圆角（角落透明）');
  assert.equal(decodePng(iconBuffer('pocket-icon-512.png')).at(0, 0)[3], 0, '512 图标应为圆角（角落透明）');
  assert.equal(decodePng(iconBuffer('pocket-icon-maskable-512.png')).at(0, 0)[3], 255, 'maskable 必须满幅');
  const badge = decodePng(iconBuffer('pocket-badge.png'));
  assert.equal(badge.at(0, 0)[3], 0, 'badge 应透明底');
  const middle = badge.at(30, 36);
  assert.ok(middle[3] > 200 && middle[0] > 200, `badge 应是白色字形，实际 ${middle.join(',')}`);
  assert.ok(colors.size > 3, '图标不是纯色块');
});

test('iconBuffer / iconPath / contentTypeFor', () => {
  assert.equal(iconPath('pocket-icon-192.png'), PWA_PATHS.icon192);
  assert.equal(iconPath('/pocket-badge.png'), PWA_PATHS.badge);
  assert.equal(iconPath('nope.png'), null);
  assert.equal(iconBuffer('nope.png'), null);
  assert.equal(iconBuffer('/pocket-icon-192.png').length, iconBuffer('pocket-icon-192.png').length);

  assert.equal(contentTypeFor('/pocket.webmanifest'), 'application/manifest+json; charset=utf-8');
  assert.equal(contentTypeFor('/pocket-sw.js'), 'text/javascript; charset=utf-8');
  assert.equal(contentTypeFor('/pocket-icon-192.png'), 'image/png');
  assert.equal(contentTypeFor('/a.PNG?x=1#y'), 'image/png');
  assert.equal(contentTypeFor('/x.json'), 'application/json; charset=utf-8');
  assert.equal(contentTypeFor('/unknown.bin'), 'application/octet-stream');
});

test('pwaAssetFor：路由表与 manifest 图标一致', () => {
  const manifest = pwaAssetFor(PWA_PATHS.manifest);
  assert.equal(manifest.contentType, 'application/manifest+json; charset=utf-8');
  assert.equal(manifest.cacheControl, 'no-cache');
  const parsed = JSON.parse(manifest.body);
  assert.equal(parsed.start_url, '/');
  for (const icon of parsed.icons) {
    const asset = pwaAssetFor(icon.src);
    assert.ok(asset, `${icon.src} 应有对应路由`);
    assert.equal(asset.contentType, 'image/png');
    assert.ok(Buffer.isBuffer(asset.body));
  }
  const sw = pwaAssetFor(PWA_PATHS.serviceWorker);
  assert.equal(sw.contentType, 'text/javascript; charset=utf-8');
  assert.equal(sw.body, SW_SOURCE);
  assert.equal(pwaAssetFor('/nope'), null);
  assert.equal(pwaAssetFor('/pocket-icon-192.png?v=2').body.length > 0, true, '带 query 也要能命中');
  // 自定义 manifest 参数能透传
  assert.equal(JSON.parse(pwaAssetFor(PWA_PATHS.manifest, { manifest: { name: 'X' } }).body).name, 'X');
});

test('订阅序列化（客户端与 SW 共用）：不依赖 toJSON 也能拿到 endpoint 与密钥', async () => {
  // 同一段源码被 SW 与代理注入脚本共用，这里直接把它编译出来执行
  const make = new Function(`${PUSH_SUB_TO_JSON_SRC}; return dshPushSubscriptionToJson;`)();
  const b64u = (buf) => Buffer.from(buf).toString('base64url');

  // 1) 有 toJSON 且带 endpoint → 直接用（保留浏览器给的全部字段）
  const withToJson = { toJSON: () => ({ endpoint: 'https://push.example.com/x', keys: { p256dh: 'p', auth: 'a' } }) };
  assert.deepEqual(make(withToJson), { endpoint: 'https://push.example.com/x', keys: { p256dh: 'p', auth: 'a' } });

  // 2) 没有 toJSON（部分 Safari 版本）→ 手工构造 endpoint + getKey 密钥
  const raw = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
    expirationTime: null,
    getKey: (name) => (name === 'p256dh' ? new Uint8Array([4, 1, 2]) : name === 'auth' ? new Uint8Array([9, 8]) : null),
  };
  const out = make(raw);
  assert.equal(out.endpoint, 'https://fcm.googleapis.com/fcm/send/abc');
  assert.equal(out.keys.p256dh, b64u([4, 1, 2]));
  assert.equal(out.keys.auth, b64u([9, 8]));

  // 3) toJSON 抛错 → 回落到手工构造，不把异常抛给调用方
  const broken = { endpoint: 'https://a.example/b', getKey: () => null, toJSON: () => { throw new Error('nope'); } };
  assert.equal(make(broken).endpoint, 'https://a.example/b');

  // 4) 什么都没有 → endpoint 为空，调用方据此报可读错误（而不是 POST 一个 {} 给后端）
  assert.equal(make({}).endpoint, '');

  // 5) 两个消费点都必须用这个共用函数，而不是裸 toJSON
  const { POCKET_PWA_JS } = await import('../lib/proxy.mjs');
  assert.ok(SW_SOURCE.includes('dshPushSubscriptionToJson(subscription)'), 'SW 续订必须用共用序列化函数');
  assert.ok(POCKET_PWA_JS.includes('dshPushSubscriptionToJson(sub)'), '注入脚本订阅必须用共用序列化函数');
  assert.ok(!/typeof sub\.toJSON === .function. \? sub\.toJSON\(\) : sub/.test(POCKET_PWA_JS), '不应再有裸 toJSON 回落');
});
