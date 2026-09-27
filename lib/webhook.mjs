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
//
// 头安全（issue：ntfy + 中文标题一条都发不出去）：
//   HTTP 头值必须是 ByteString（每个字符 ≤0xFF）。标题默认是中文（notify-hook 的 DEFAULT_TITLE），
//   原样塞进 `Title` 头会让 undici 抛 TypeError，请求根本发不出去。所以：
//     1) 凡是用户可控文本要进头，一律先过 isHeaderSafe（只允许可打印 ASCII，顺带堵掉 CR/LF 头注入）；
//     2) ntfy 的 Title 用 RFC 2047 encoded-word 承载非 ASCII（`=?UTF-8?B?…?=`）—— 这是 ntfy 官方文档
//        给出的写法（docs.ntfy.sh/publish：“you may also encode any header (including the title)
//        as RFC 2047”），手机上看到的仍是中文标题；编码产物是纯 ASCII，头集合始终合法。
//        控制字符会被先剔除（无意义 + 头注入），剔完为空就不发这个头（标题仍在正文第一行）；
//     3) ntfy 的 Click 属于 URL，非 ASCII 先百分号编码再放头；
//     4) Priority 走白名单，Tags 逐个过滤，调用方自带的头（如 Authorization）非法时直接报 request 错，
//        绝不静默丢弃（否则用户会拿着"其实没带鉴权"的 401 排查半天）。

import { createHmac } from 'node:crypto';

/** 支持的 webhook 预设。 */
export const WEBHOOK_PRESETS = Object.freeze(['generic', 'wecom', 'dingtalk', 'feishu', 'ntfy', 'bark']);

/** 默认请求超时（毫秒）：webhook 打不通不能把任务完成回调挂死。 */
export const DEFAULT_WEBHOOK_TIMEOUT_MS = 10000;

/** ntfy 默认优先级（任务完成属于「看一眼就好」，用 high 不打扰）。 */
export const DEFAULT_NTFY_PRIORITY = 'high';

const JSON_UTF8 = 'application/json; charset=utf-8';
const TEXT_UTF8 = 'text/plain; charset=utf-8';

/** 可打印 ASCII 且不含 CR/LF —— 能安全作为 HTTP 头值的字符集（ByteString 的安全子集）。 */
const HEADER_VALUE_RE = /^[\x20-\x7E]+$/;

/** ntfy 官方支持的优先级取值（1-5 或名字）；白名单同时挡掉 CR/LF 头注入。 */
const NTFY_PRIORITIES = new Set(['1', '2', '3', '4', '5', 'min', 'low', 'default', 'high', 'max', 'urgent']);

/**
 * 该字符串能否安全地作为 HTTP 头值（可打印 ASCII、无控制字符）。
 * 中文/emoji 一律为 false —— undici 对这类值直接抛 TypeError。
 */
export function isHeaderSafe(value) {
  return typeof value === 'string' && HEADER_VALUE_RE.test(value);
}

/** URL 类头（ntfy 的 Click）：非 ASCII 先按百分号编码，编码后仍不安全就返回 ''。 */
function urlHeaderValueOrEmpty(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (isHeaderSafe(text)) return text;
  try {
    const encoded = encodeURI(text);
    return isHeaderSafe(encoded) ? encoded : '';
  } catch {
    return '';
  }
}

/** ntfy 优先级：白名单内的原样（转小写），其余回退默认，避免非法值/头注入。 */
function ntfyPriority(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return NTFY_PRIORITIES.has(text) ? text : DEFAULT_NTFY_PRIORITY;
}

/** RFC 2047 encoded-word 上限 75 字符（含 `=?UTF-8?B?` 与 `?=` 共 12 个字符）。 */
const ENCODED_WORD_MAX = 75;
const ENCODED_WORD_OVERHEAD = 12;

/**
 * 把非 ASCII / 含控制字符的文本编码成 RFC 2047 encoded-word（`=?UTF-8?B?…?=`）。
 *
 * 依据（官方文档原文）：ntfy 的发布文档在 “Message title / Tags” 一节明确写了
 * “ntfy supports UTF-8 in HTTP headers, but not every library or programming language does.
 *  If non-ASCII characters are causing issues for you in the title … you may also encode any header
 *  (including the title) as RFC 2047, e.g. `=?UTF-8?B?8J+HqfCfh6o=?=`”
 * （https://docs.ntfy.sh/publish/）。而 Node 的 fetch（undici）正是那个“不支持的库”，
 * 所以这里按官方建议编码 —— 手机上仍然能看到中文标题。
 *
 * 编码产物只含 `[A-Za-z0-9+/=?-]`，天然是合法 HTTP 头值；超长标题按 UTF-8 字符边界切成多个词
 * （RFC 2047 §5 允许相邻 encoded-word，词间空格在解码时被丢弃；不按字符边界切会把中文劈成乱码）。
 */
export function encodeHeaderWord(value) {
  const text = String(value ?? '');
  if (!text || isHeaderSafe(text)) return text;
  const chunkBytes = Math.floor((ENCODED_WORD_MAX - ENCODED_WORD_OVERHEAD) / 4) * 3; // 45 字节 → 60 个 base64 字符
  const words = [];
  let current = '';
  let size = 0;
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (size + charBytes > chunkBytes && current) {
      words.push(`=?UTF-8?B?${Buffer.from(current, 'utf8').toString('base64')}?=`);
      current = '';
      size = 0;
    }
    current += char;
    size += charBytes;
  }
  if (current) words.push(`=?UTF-8?B?${Buffer.from(current, 'utf8').toString('base64')}?=`);
  return words.join(' ');
}

/** 标题 → 可安全放进 HTTP 头的值：先去控制字符；纯 ASCII 原样，否则按 RFC 2047 编码。 */
function titleHeaderValue(title) {
  const text = String(title ?? '').replace(/[\u0000-\u001F\u007F]/g, '');
  if (!text.trim()) return '';
  return isHeaderSafe(text) ? text : encodeHeaderWord(text);
}

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
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error('Webhook URL 不能为空 | webhook url is required');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Webhook URL 不是合法地址 | invalid webhook url');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Webhook URL 必须是 http(s) | webhook url must be http(s)');
  }
  // 含非 ASCII 的地址（例如 https://ntfy.sh/我的主题）交给 URL 规范化做百分号编码；
  // 纯 ASCII 的原样返回，避免 new URL().href 的小动作（如补尾斜杠）改掉用户已配置的地址。
  const url = isHeaderSafe(raw) ? raw : parsed.href;
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
 *   - priority ntfy 优先级（默认 high，取值 1-5 / min·low·default·high·max·urgent，其余回退默认）
 * @returns {{ url: string, method: 'POST', headers: Record<string,string>, body: string }}
 *   头安全：ntfy 的 `Title` 用 RFC 2047 encoded-word 承载非 ASCII（控制字符先剔除），
 *   `Click` 非 ASCII 先百分号编码，`Tags` 逐项过滤，`Priority` 走白名单 —— 保证返回的头一定能被 fetch 发出。
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
    // 注意：这里每个头都必须过「头安全」判定，否则中文标题会让整个请求发不出去（见文件头说明）。
    const list = normalizeTags(tags).filter((tag) => isHeaderSafe(tag)).slice(0, 20);
    const headers = { 'content-type': TEXT_UTF8 };
    // 标题：可打印 ASCII 原样；中文/emoji 按 RFC 2047 编码（ntfy 官方文档支持的写法，手机端能还原成中文）；
    // 先去掉控制字符（头注入 + 无意义字符），全空则不发送这个头。
    const safeTitle = titleHeaderValue(head);
    if (safeTitle) headers.Title = safeTitle;
    headers.Priority = ntfyPriority(priority);
    const safeClick = urlHeaderValueOrEmpty(click);
    if (safeClick) headers.Click = safeClick;
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
 * 结果对象：成功时保持冻结的三字段契约 `{ ok, status, error }`；
 * 失败时补一个 reason（'config' | 'request' | 'timeout' | 'network' | 'http' | 'api-error'）便于排障。
 */
function webhookResult(ok, status, error, reason) {
  return ok ? { ok: true, status, error: null } : { ok: false, status, error, reason };
}

/**
 * 把 fetch 抛出的错误分成三类：超时 / 请求构造（编码、非法头、非法 URL） / 网络。
 *
 * 不能只看错误类型：Node 的 fetch 网络失败也是 `TypeError: fetch failed`（真正原因放在 cause 里，
 * 例如 ENOTFOUND/ECONNREFUSED），而 undici 的头编码错误是无 cause 的 TypeError。
 * 所以判据是「有没有 cause / 错误码」+ 文案特征。
 *
 * @returns {'network'|'request'} 错误类别（超时由调用方的 timedOut 标记单独处理）。
 */
function classifyFetchFailure(err) {
  if (err?.code || err?.cause?.code || err?.cause) return 'network';
  const message = String(err?.message ?? '');
  if (/ByteString|Invalid header|invalid header|header value|Failed to parse URL|Invalid URL|invalid argument type/i.test(message)) {
    return 'request';
  }
  if (err?.name === 'TypeError' || err?.name === 'RangeError' || err?.name === 'SyntaxError') return 'request';
  return 'network';
}

/**
 * 发送 webhook。
 *
 * @param {object} cfg buildWebhookRequest 的入参，另支持 `headers`（额外请求头，例如 ntfy 的
 *   Authorization）与 `timeoutMs`。
 * @param {object} [options] `{ fetchImpl, now, timeoutMs }`；fetchImpl 默认全局 fetch。
 * @returns {Promise<{ ok: boolean, status: number, error: string|null, reason?: string }>} 任何失败都不抛异常：
 *   url 空/非法、preset 不支持等配置错误返回 status:0 + error + reason:'config'（纯函数 buildWebhookRequest 才抛）；
 *   请求构造/编码失败 reason:'request'（不再误报成网络错误），网络失败 reason:'network'，超时 reason:'timeout'。
 */
export async function sendWebhook(cfg = {}, options = {}) {
  const { fetchImpl = fetch, now, timeoutMs = DEFAULT_WEBHOOK_TIMEOUT_MS } = options ?? {};
  let request;
  try {
    request = buildWebhookRequest({ ...cfg, now: cfg?.now ?? now });
  } catch (err) {
    // 配置错误（空 url / 不支持的类型）也走返回值：调用点在任务完成回调里，不希望抛出去打断流程
    return webhookResult(false, 0, err?.message ?? String(err), 'config');
  }
  if (typeof fetchImpl !== 'function') {
    return webhookResult(false, 0, '没有可用的 fetch | fetch implementation is missing', 'config');
  }
  // 调用方自带的头（如 ntfy 的 Authorization）：非法值直接报错，不静默丢弃 ——
  // 静默丢弃只会让用户拿到一个莫名其妙的 401。
  const extraHeaders = cfg?.headers && typeof cfg.headers === 'object' ? cfg.headers : null;
  if (extraHeaders) {
    for (const [name, value] of Object.entries(extraHeaders)) {
      if (!isHeaderSafe(String(value ?? ''))) {
        return webhookResult(false, 0, `Webhook 请求头 ${name} 含非 ASCII/控制字符，无法作为 HTTP 头发送 | invalid header value: ${name}`, 'request');
      }
    }
  }
  const headers = { ...request.headers, ...(extraHeaders ?? {}) };
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
      return webhookResult(false, status, `Webhook 返回 HTTP ${status}${excerpt ? `: ${excerpt}` : ''} | webhook http error`, 'http');
    }
    const apiError = apiErrorFromBody(text);
    if (apiError) {
      return webhookResult(false, status, `Webhook 平台报错 code=${apiError.code}${apiError.message ? ` ${apiError.message}` : ''} | webhook api error`, 'api-error');
    }
    return webhookResult(true, status, null, null);
  } catch (err) {
    if (timedOut || err?.name === 'AbortError' || err?.name === 'TimeoutError') {
      return webhookResult(false, 0, `Webhook 超时（${budget}ms 内未返回） | webhook request timed out`, 'timeout');
    }
    if (classifyFetchFailure(err) === 'request') {
      return webhookResult(false, 0, `Webhook 请求构造失败: ${err?.message ?? err} | invalid webhook request`, 'request');
    }
    return webhookResult(false, 0, `Webhook 网络错误: ${err?.message ?? err} | network error`, 'network');
  } finally {
    clearTimeout(timer);
  }
}
