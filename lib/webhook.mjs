// Webhook 通知核心：任务完成时把消息推给企业微信 / 钉钉 / 飞书 / ntfy / Bark / 通用 webhook
//
// 只负责「把一条通知翻译成对应平台要的请求形状」，不做任何持久化与调度：
//   - buildWebhookRequest 是纯函数（now 可注入，便于测试与补发历史时间）；
//   - sendWebhook 用可注入的 fetch 真正发出，并把 HTTP 状态与平台 errcode 归类成 { ok, status, error }。
//
// 各平台差异（实测/官方文档）：
//   - wecom / dingtalk / feishu 返回 HTTP 200 但 body 里带 errcode/code，**必须再看一眼 body**，
//     否则「机器人被踢出群」这类错误会被当成功；
//   - bark 成功时 body 是 { code: 200 }，所以 code===200 也算成功；
//   - dingtalk 加签：timestamp + sign=urlencode(base64(HMAC-SHA256(secret, `${ts}\n${secret}`)))；
//   - ntfy 走纯文本 body + Title/Priority/Click 头，不需要 JSON。

import { createHmac } from 'node:crypto';

/** 支持的 webhook 预设。 */
export const WEBHOOK_PRESETS = Object.freeze(['generic', 'wecom', 'dingtalk', 'feishu', 'ntfy', 'bark']);

/** 默认请求超时（毫秒）：webhook 打不通不能把任务完成回调挂死。 */
export const DEFAULT_WEBHOOK_TIMEOUT_MS = 10000;

/** ntfy 默认优先级（任务完成属于「看一眼就好」，用 high 不打扰）。 */
export const DEFAULT_NTFY_PRIORITY = 'high';

const JSON_UTF8 = 'application/json; charset=utf-8';
const TEXT_UTF8 = 'text/plain; charset=utf-8';

/** 该 preset 是否受支持。 */
export function isWebhookPreset(preset) {
  return WEBHOOK_PRESETS.includes(String(preset ?? '').trim().toLowerCase());
}

/** now（毫秒数 / Date / ISO 串 / 空）→ 毫秒时间戳。 */
function toMillis(now) {
  if (now === undefined || now === null || now === '') return Date.now();
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number') return Number.isFinite(now) ? now : Date.now();
  const parsed = new Date(String(now));
  return Number.isNaN(parsed.getTime()) ? Date.now() : parsed.getTime();
}

/** 校验 http(s) URL；空/非法抛可读错误。 */
function requireHttpUrl(value) {
  const url = String(value ?? '').trim();
  if (!url) throw new Error('Webhook URL 不能为空 | webhook url is required');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Webhook URL 不是合法地址 | invalid webhook url');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Webhook URL 必须是 http(s) | webhook url must be http(s)');
  }
  return { url, parsed };
}

/** 通知正文：把标题与正文拼成一段纯文本（各平台 text 消息共用）。 */
function contentText(title, body) {
  const head = String(title ?? '').trim();
  const tail = String(body ?? '').trim();
  return [head, tail].filter(Boolean).join('\n');
}

/** tags：数组或逗号分隔字符串 → 字符串数组。 */
function normalizeTags(tags) {
  if (Array.isArray(tags)) return tags.map((t) => String(t ?? '').trim()).filter(Boolean);
  return String(tags ?? '')
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** 钉钉加签（官方算法：`${timestamp}\n${secret}` 的 HMAC-SHA256，base64 后 URL 编码）。 */
export function dingtalkSign(secret, timestampMs) {
  const plain = `${timestampMs}\n${secret}`;
  return createHmac('sha256', String(secret)).update(plain, 'utf8').digest('base64');
}

/**
 * 构造 webhook 请求（纯函数）。
 *
 * @param {object} cfg
 *   - preset  'generic' | 'wecom' | 'dingtalk' | 'feishu' | 'ntfy' | 'bark'（默认 generic）
 *   - url     目标地址，必须 http(s) 非空
 *   - secret  钉钉加签密钥（其它 preset 忽略）
 *   - title / body / link  通知标题 / 正文 / 点击跳转地址
 *   - tags    标签数组或逗号分隔串（bark 取第一个做 group；ntfy 写 Tags 头）
 *   - now     时间来源（毫秒 / Date / ISO；默认当前时间），仅 generic 的 `at` 与钉钉 timestamp 用
 *   - priority ntfy 优先级（默认 high）
 * @returns {{ url: string, method: 'POST', headers: Record<string,string>, body: string }}
 * @throws {Error} url 空/非法、preset 不支持时抛可读错误。
 */
export function buildWebhookRequest(cfg = {}) {
  const { preset = 'generic', url, secret, title, body, link, tags, now, priority } = cfg ?? {};
  const kind = String(preset ?? 'generic').trim().toLowerCase() || 'generic';
  if (!isWebhookPreset(kind)) {
    throw new Error(`不支持的 webhook 类型: ${preset} | unsupported webhook preset`);
  }
  const { url: target, parsed } = requireHttpUrl(url);
  const text = contentText(title, body);
  const head = String(title ?? '').trim();
  const tail = String(body ?? '').trim();
  const click = String(link ?? '').trim();

  if (kind === 'generic') {
    return {
      url: target,
      method: 'POST',
      headers: { 'content-type': JSON_UTF8 },
      body: JSON.stringify({ title: head, message: tail, url: click, at: new Date(toMillis(now)).toISOString() }),
    };
  }

  if (kind === 'wecom' || kind === 'dingtalk') {
    let finalUrl = target;
    if (kind === 'dingtalk' && String(secret ?? '').trim()) {
      const ts = toMillis(now);
      parsed.searchParams.set('timestamp', String(ts));
      parsed.searchParams.set('sign', dingtalkSign(String(secret).trim(), ts));
      finalUrl = parsed.toString();
    }
    return {
      url: finalUrl,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
    };
  }

  if (kind === 'feishu') {
    return {
      url: target,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text } }),
    };
  }

  if (kind === 'ntfy') {
    const list = normalizeTags(tags);
    const headers = { 'content-type': TEXT_UTF8 };
    if (head) headers.Title = head;
    headers.Priority = String(priority ?? '').trim() || DEFAULT_NTFY_PRIORITY;
    if (click) headers.Click = click;
    if (list.length) headers.Tags = list.join(',');
    return { url: target, method: 'POST', headers, body: text };
  }

  // bark：title/body 分开，url 是点击跳转，group 用第一个 tag
  const list = normalizeTags(tags);
  return {
    url: target,
    method: 'POST',
    headers: { 'content-type': JSON_UTF8 },
    body: JSON.stringify({ title: head, body: tail || head, url: click, group: list[0] ?? 'dsh-pocket' }),
  };
}

/** 平台返回值里的错误码（HTTP 200 也可能是失败）。数字 0 / 200 视为成功。 */
function apiErrorFromBody(text) {
  const raw = String(text ?? '').trim();
  if (!raw || !raw.startsWith('{')) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const code = parsed.errcode ?? parsed.code ?? parsed.StatusCode ?? parsed.status_code;
  const message = parsed.errmsg ?? parsed.msg ?? parsed.message ?? parsed.error ?? '';
  if (typeof code !== 'number') return null;
  if (code === 0 || code === 200) return null;
  return { code, message: String(message ?? '').slice(0, 200) };
}

/**
 * 发送 webhook。
 *
 * @param {object} cfg buildWebhookRequest 的入参，另支持 `headers`（额外请求头，例如 ntfy 的
 *   Authorization）与 `timeoutMs`。
 * @param {object} [options] `{ fetchImpl, now, timeoutMs }`；fetchImpl 默认全局 fetch。
 * @returns {Promise<{ ok: boolean, status: number, error: string|null }>} 任何失败都不抛异常：
 *   url 空/非法、preset 不支持等配置错误返回 status:0 + error（纯函数 buildWebhookRequest 才抛）。
 */
export async function sendWebhook(cfg = {}, options = {}) {
  const { fetchImpl = fetch, now, timeoutMs = DEFAULT_WEBHOOK_TIMEOUT_MS } = options ?? {};
  let request;
  try {
    request = buildWebhookRequest({ ...cfg, now: cfg?.now ?? now });
  } catch (err) {
    // 配置错误（空 url / 不支持的类型）也走返回值：调用点在任务完成回调里，不希望抛出去打断流程
    return { ok: false, status: 0, error: err?.message ?? String(err) };
  }
  if (typeof fetchImpl !== 'function') return { ok: false, status: 0, error: '没有可用的 fetch | fetch implementation is missing' };
  const headers = { ...request.headers, ...(cfg?.headers && typeof cfg.headers === 'object' ? cfg.headers : {}) };
  const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_WEBHOOK_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, budget);
  try {
    const response = await fetchImpl(request.url, {
      method: request.method,
      headers,
      body: request.body,
      signal: controller.signal,
    });
    const status = Number(response?.status) || 0;
    let text = '';
    if (typeof response?.text === 'function') {
      try {
        text = (await response.text()).slice(0, 400);
      } catch { /* 读 body 失败不影响主判定 */ }
    }
    if (status < 200 || status >= 300) {
      const excerpt = text.replace(/\s+/g, ' ').trim().slice(0, 200);
      return { ok: false, status, error: `Webhook 返回 HTTP ${status}${excerpt ? `: ${excerpt}` : ''} | webhook http error` };
    }
    const apiError = apiErrorFromBody(text);
    if (apiError) {
      return { ok: false, status, error: `Webhook 平台报错 code=${apiError.code}${apiError.message ? ` ${apiError.message}` : ''} | webhook api error` };
    }
    return { ok: true, status, error: null };
  } catch (err) {
    if (timedOut || err?.name === 'AbortError' || err?.name === 'TimeoutError') {
      return { ok: false, status: 0, error: `Webhook 超时（${budget}ms 内未返回） | webhook request timed out` };
    }
    return { ok: false, status: 0, error: `Webhook 网络错误: ${err?.message ?? err} | network error` };
  } finally {
    clearTimeout(timer);
  }
}
