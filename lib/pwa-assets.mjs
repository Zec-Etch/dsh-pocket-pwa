// PWA 静态资源：Web App Manifest、Service Worker 源码、图标（真实 PNG，base64 内联）
//
// 为什么图标是 .mjs 里的 base64 常量而不是二进制文件：
//   - 插件按 npm `files` 发布（bin/lib/client），加二进制要额外处理打包与安装路径；
//   - 代理层直接把 Buffer 写回浏览器即可，不落盘、不读 fs，Windows 只读安装目录/asar 场景也不炸。
// 4 张图都是真实 PNG（IHDR：192x192、512x512、512x512 maskable、72x72 badge），
// 深色底 + 字母 D + 一个青点；test/pwa-assets.test.js 会解出 IHDR 尺寸并校验 CRC/IDAT 可解码。
//
// SW 的三条底线（Chrome 安装提示与手机体验）：
//   1) 必须有非空的 fetch 处理器；
//   2) 只缓存自己那几个静态资源，**绝不缓存 DSH 的 HTML/JS**（否则 UI 会变陈旧的旧壳）；
//   3) push 一定要 showNotification（否则 Chrome 会因「静默推送」把订阅吊销）。

/** 本模块负责的所有路径（manifest 里的 icons.src 与之一一对应）。 */
export const PWA_PATHS = Object.freeze({
  manifest: '/pocket.webmanifest',
  serviceWorker: '/pocket-sw.js',
  icon192: '/pocket-icon-192.png',
  icon512: '/pocket-icon-512.png',
  iconMaskable512: '/pocket-icon-maskable-512.png',
  badge: '/pocket-badge.png',
  /** SW 续订（pushsubscriptionchange）时 POST 订阅的地址（与后端路由冻结约定一致）。 */
  subscribe: '/pocket-push-subscribe',
});

const PWA_DEFAULT_NAME = 'DSH Pocket';
const PWA_DEFAULT_SHORT_NAME = 'DSH';
const PWA_DEFAULT_DESCRIPTION = '把 DeepSeek Harness 装进你的口袋：手机上看电脑里的 DSH 会话';
const PWA_DEFAULT_THEME = '#101a2e';

/** 只缓存这几张图/清单，避免把 DSH 的动态响应缓存成陈旧壳。 */
const SW_CACHE = 'dsh-pocket-assets-v1';
const SW_SHELL = [
  PWA_PATHS.manifest,
  PWA_PATHS.icon192,
  PWA_PATHS.icon512,
  PWA_PATHS.iconMaskable512,
  PWA_PATHS.badge,
];

/**
 * 构造 Web App Manifest（纯对象，路径全部相对，不含绝对域名）。
 *
 * @param {object} [input] `{ name, shortName, description, themeColor, backgroundColor, display }`
 * @returns {object} 可直接 JSON 序列化喂给 `Content-Type: application/manifest+json`。
 */
export function manifestFor(input = {}) {
  const {
    name = PWA_DEFAULT_NAME,
    shortName = PWA_DEFAULT_SHORT_NAME,
    description = PWA_DEFAULT_DESCRIPTION,
    themeColor = PWA_DEFAULT_THEME,
    backgroundColor = PWA_DEFAULT_THEME,
    display = 'standalone',
  } = input ?? {};
  return {
    id: '/',
    name: String(name ?? '').trim() || PWA_DEFAULT_NAME,
    short_name: String(shortName ?? '').trim() || PWA_DEFAULT_SHORT_NAME,
    description: String(description ?? '').trim() || PWA_DEFAULT_DESCRIPTION,
    lang: 'zh-CN',
    start_url: '/',
    scope: '/',
    display: String(display ?? '').trim() || 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    theme_color: String(themeColor ?? '').trim() || PWA_DEFAULT_THEME,
    background_color: String(backgroundColor ?? '').trim() || PWA_DEFAULT_THEME,
    prefer_related_applications: false,
    icons: [
      { src: PWA_PATHS.icon192, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: PWA_PATHS.icon512, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: PWA_PATHS.iconMaskable512, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}

/**
 * Service Worker 源码（字符串形式；由代理层以 `text/javascript` 直接返回）。
 *
 * 处理器：install（预缓存 + skipWaiting）/ activate（清旧缓存 + clients.claim）/
 * fetch（静态资源 cache-first、导航 network-first）/ push（showNotification）/
 * notificationclick（聚焦已有窗口或 openWindow）/ pushsubscriptionchange（重新订阅并回传后端）。
 * 全程不引用未定义变量（测试里在 vm 沙箱内带桩执行过）。
 */
export const SW_SOURCE = `/* dsh-pocket service worker：离线可用的小壳 + Web Push 通知 */
const SW_CACHE = '${SW_CACHE}';
const SW_SHELL = ${JSON.stringify(SW_SHELL, null, 2)};
const SW_OFFLINE_HTML =
  '<!doctype html><html lang="zh-CN"><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>DSH Pocket 离线</title>' +
  '<body style="margin:0;font:16px/1.6 system-ui;background:#101a2e;color:#eaf2ff;padding:12vh 8vw">' +
  '<h1 style="font-size:20px">暂时连不上电脑上的 DSH</h1>' +
  '<p>请确认电脑端 dsh web 还在运行、手机与电脑在同一网络，或公网隧道仍然有效。</p>' +
  '</body></html>';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(SW_CACHE);
        await Promise.all(
          SW_SHELL.map((url) => cache.add(url).catch(() => undefined)),
        );
      } catch (e) {
        // 预缓存失败不影响 SW 安装（离线时仍能启动）
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.filter((key) => key !== SW_CACHE).map((key) => caches.delete(key)));
      } catch (e) {
        // 清缓存失败不影响激活
      }
      await self.clients.claim();
    })(),
  );
});

async function cacheFirst(request) {
  const cache = await caches.open(SW_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response && response.ok) {
    try {
      await cache.put(request, response.clone());
    } catch (e) {
      // 忽略缓存写入失败（响应不可克隆/配额不足）
    }
  }
  return response;
}

async function networkFirst(request) {
  try {
    return await fetch(request);
  } catch (e) {
    return new Response(SW_OFFLINE_HTML, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (!request || request.method !== 'GET') return;
  let url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return;
  }
  if (url.origin !== self.location.origin) return;
  const isShellAsset = SW_SHELL.indexOf(url.pathname) >= 0;
  if (isShellAsset || url.pathname.endsWith('.png') || url.pathname.endsWith('.webmanifest')) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
  }
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    if (event.data) data = event.data.json();
  } catch (e) {
    data = {};
    try {
      data = { title: event.data && event.data.text ? event.data.text() : '' };
    } catch (e2) {
      data = {};
    }
  }
  if (!data || typeof data !== 'object') data = { body: String(data === null || data === undefined ? '' : data) };
  const title = typeof data.title === 'string' && data.title ? data.title : '${PWA_DEFAULT_NAME}';
  const url = typeof data.url === 'string' && data.url ? data.url : '/';
  const options = {
    body: typeof data.body === 'string' ? data.body : '',
    tag: typeof data.tag === 'string' && data.tag ? data.tag : 'dsh-pocket',
    renotify: false,
    icon: '${PWA_PATHS.icon192}',
    badge: '${PWA_PATHS.badge}',
    data: { url: url, sessionId: typeof data.sessionId === 'string' ? data.sessionId : null },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const payload = event.notification.data || {};
  let target = self.location.origin + '/';
  try {
    target = new URL(payload.url || '/', self.location.origin).href;
  } catch (e) {
    target = self.location.origin + '/';
  }
  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clientList) {
        if (!client || !client.url) continue;
        let sameOrigin = false;
        try {
          sameOrigin = new URL(client.url).origin === self.location.origin;
        } catch (e) {
          sameOrigin = false;
        }
        if (!sameOrigin) continue;
        if (typeof client.focus === 'function') await client.focus();
        if (typeof client.navigate === 'function') {
          try {
            await client.navigate(target);
          } catch (e) {
            // 已有窗口不支持 navigate（旧内核）时只聚焦
          }
        }
        return;
      }
      if (typeof self.clients.openWindow === 'function') await self.clients.openWindow(target);
    })(),
  );
});

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const previous = event.oldSubscription;
      const serverKey = previous && previous.options ? previous.options.applicationServerKey : null;
      let subscription = event.newSubscription || null;
      if (!subscription && self.registration.pushManager) {
        subscription = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: serverKey || undefined,
        });
      }
      if (!subscription) return;
      const json = typeof subscription.toJSON === 'function' ? subscription.toJSON() : subscription;
      await fetch('${PWA_PATHS.subscribe}', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subscription: json, reason: 'pushsubscriptionchange' }),
      });
    })(),
  );
});
`;

/** 图标文件名 → base64 PNG（生成脚本产出，见文件头说明）。 */
export const ICONS = Object.freeze({
  'pocket-icon-192.png':
    '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',
  'pocket-icon-512.png':
    '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',
  'pocket-icon-maskable-512.png':
    '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',
  'pocket-badge.png':
    'iVBORw0KGgoAAAANSUhEUgAAAEgAAABICAYAAABV7bNHAAAA+0lEQVR42u3a3Q2CMBQGUAdhEQZhEBdhEAdxEQa5pklNjFGpBv96z0l8kLQ8fLmlpXS3AwAAAAD4GRExRMQcEYcbv7G2Of8v7abSJ1M4Szw23ble+u27DqtWxJqloc3cZVB12GylBDkJqKGaBLTuIKAMlfTmgOLvn0kfCGj569mtNaCLNVNZEx3TDLVnArrqNzauj86GVAG9METnlAHVe7RU0pI5oLGxisaUAdX7HLuc8jcMaOpydb1hQIOA1u8lIAEZYh7SpnkLRa8aXlZtd2Tc7rBhZsv1KwHZtPfZx4dDlfOpgLo8vOD4S8M2hQNUDSE5ggcAAAAAJHACSvmgjuL++1EAAAAASUVORK5CYII=',
});

/** 取图标的原始字节；名字/路径（带不带前导 `/` 都行）不认识时返回 null（方便路由层直接 404）。 */
export function iconBuffer(name) {
  const key = String(name ?? '').replace(/^\/+/, '');
  const base64 = Object.prototype.hasOwnProperty.call(ICONS, key) ? ICONS[key] : undefined;
  if (typeof base64 !== 'string') return null;
  return Buffer.from(base64, 'base64');
}

/** 图标文件名或路径 → manifest/URL 里的绝对路径；不认识时返回 null。 */
export function iconPath(name) {
  const key = String(name ?? '').replace(/^\/+/, '');
  return Object.prototype.hasOwnProperty.call(ICONS, key) ? `/${key}` : null;
}

/**
 * 按扩展名给 Content-Type（路径可带 query/hash）。
 * .webmanifest 用 `application/manifest+json`（Chrome 认这个，写 text/plain 或 application/json 都可能装不上）。
 */
export function contentTypeFor(path) {
  const clean = String(path ?? '').split(/[?#]/)[0].toLowerCase();
  if (clean.endsWith('.webmanifest') || clean.endsWith('.manifest')) return 'application/manifest+json; charset=utf-8';
  if (clean.endsWith('.js') || clean.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (clean.endsWith('.png')) return 'image/png';
  if (clean.endsWith('.json')) return 'application/json; charset=utf-8';
  if (clean.endsWith('.html') || clean.endsWith('/')) return 'text/html; charset=utf-8';
  if (clean.endsWith('.css')) return 'text/css; charset=utf-8';
  if (clean.endsWith('.svg')) return 'image/svg+xml';
  if (clean.endsWith('.ico')) return 'image/x-icon';
  if (clean.endsWith('.webp')) return 'image/webp';
  if (clean.endsWith('.txt')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

/**
 * PWA 路由表：代理层拿到 pathname 就能直接回响应（命中返回对象，未命中返回 null）。
 *
 * @param {string} pathname 请求路径（可带 query/hash，会被忽略）。
 * @param {object} [options] `{ manifest }` 传给 manifestFor 的参数。
 * @returns {{ body: string|Buffer, contentType: string, cacheControl: string }|null}
 *   manifest / SW 用 no-cache（改了要立刻生效），图标可以长缓存。
 */
export function pwaAssetFor(pathname, options = {}) {
  const path = String(pathname ?? '').split(/[?#]/)[0];
  if (path === PWA_PATHS.manifest) {
    return {
      body: JSON.stringify(manifestFor(options?.manifest), null, 2),
      contentType: contentTypeFor(path),
      cacheControl: 'no-cache',
    };
  }
  if (path === PWA_PATHS.serviceWorker) {
    return { body: SW_SOURCE, contentType: contentTypeFor(path), cacheControl: 'no-cache' };
  }
  const icon = iconPath(path);
  if (icon) {
    const body = iconBuffer(icon);
    if (body) return { body, contentType: 'image/png', cacheControl: 'public, max-age=86400' };
  }
  return null;
}
