// dsh-pocket：任务完成通知（Web Push + Webhook）事件钩子
//
// 挂载点（lib/index.js 的 apply）：
//   ctx.on('session/event', (session, event) => event.type === 'turn/end' → 记下结束原因)
//   ctx.on('agent/status', ({ agent, status })  => status === 'idle'  → 判定「任务结束」
//
// 判定与过滤（冻结契约 D）：
//   - 去抖：同一会话在 notifyMinIntervalSec 内只推一次；
//   - 跳过子代理会话（parentSession 非空）——子代理跑完不算「任务完成」，
//     否则一条主任务会连带打出十几条通知；
//   - notifyOnTaskDone 关闭 / 两个渠道都没开 → 不发（返回 skipped 说明原因）；
//   - 同一时刻只允许一轮发送（inFlight 复用），避免手机被并发推送刷屏。
//
// 载荷：{ title: 会话标题或 'DSH 任务完成'，body: 结束原因 + 会话标题，
//         url: 当前公网入口地址或 '/'，tag: `dsh-${sessionId}` }
//
// 发送：pushToAll（404/410 自动删本地订阅）+ sendWebhook（若启用）；
// 结果存内存 lastResults 供 notify.status/notify.test 展示（'push' | 'webhook' 两类）。
//
// 本模块无 import 期副作用、不联网（fetch 可注入），事件对象形状全部防御式读取——
// DSH 版本之间的 session/agent 字段差异不能把插件搞崩。

import { pushToAll, pushPayload } from './push.mjs';
import { sendWebhook } from './webhook.mjs';

/** lastResults 只保留最近这么多条（status 展示用，避免内存随运行时长增长）。 */
const MAX_RESULTS = 20;
const DEFAULT_TITLE = 'DSH 任务完成';
/** notify.test 的固定标题（前端 toast 的成败只看 results，标题只是通知里显示的那行字）。 */
export const NOTIFY_TEST_TITLE = 'DSH 通知测试';
export const NOTIFY_TEST_BODY = '通知渠道自检：能收到这条说明配置可用 | test notification';

/** 防御式取字段：pick(a, b) 与 pick(obj, ['a','b']) 两种用法。 */
function pick(source, ...keys) {
  if (!source || typeof source !== 'object') return undefined;
  for (const key of keys) {
    const v = source[key];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/** 会话唯一 id（不同 DSH 版本字段名不同：id / sessionId / key / uuid）。 */
export function sessionKeyOf(session) {
  const raw = pick(session, 'id', 'sessionId', 'key', 'uuid', 'session_id');
  if (typeof raw === 'string' || typeof raw === 'number') return String(raw);
  return '';
}

/** 父会话 id：非空 → 这是子代理会话，不通知。 */
export function parentKeyOf(session) {
  const raw = pick(session, 'parentSession', 'parentSessionId', 'parentId', 'parent_session', 'parent');
  if (typeof raw === 'string' || typeof raw === 'number') return String(raw);
  if (raw && typeof raw === 'object') return sessionKeyOf(raw);
  return '';
}

/** 从任意事件形状里挖出结束原因（reason / status / error 都可能承载它）。 */
export function reasonFrom(event) {
  if (event && typeof event === 'object') {
    const direct = pick(event, 'reason', 'message', 'summary', 'status');
    if (typeof direct === 'string' && direct.trim()) return direct.trim().slice(0, 200);
    const nested = pick(event, 'data', 'payload', 'result', 'detail');
    if (nested && typeof nested === 'object') {
      const r = reasonFrom(nested);
      if (r) return r;
    }
    const err = event.error;
    if (err) {
      const msg = typeof err === 'string' ? err : pick(err, 'message', 'code');
      if (typeof msg === 'string' && msg.trim()) return msg.trim().slice(0, 200);
    }
  }
  return '';
}

/**
 * 创建通知钩子。
 *
 * @param {object} opts
 * @param {() => object} opts.getConfig 读通知设置（含 webhookSecret 明文；只在本模块内用）
 * @param {object} [opts.pushStore] 推送订阅存储（createPushStore 的返回值；缺省表示没有推送能力）
 * @param {() => string} [opts.getPublicUrl] 当前公网入口地址（无入口返回 ''）
 * @param {Function} [opts.getSessionTitle] 可选注入：(session) => string
 * @param {Function} [opts.fetchImpl] 注入 fetch（测试）
 * @param {Function} [opts.now] 注入时钟（测试）
 * @param {object} [opts.log] 日志（DSH logger 或 console）
 * @returns {{onSessionEvent:Function, onAgentStatus:Function, trigger:Function, sendNow:Function,
 *   status:Function, dispose:Function}}
 */
export function createNotifyHook({
  getConfig,
  pushStore = null,
  getPublicUrl = () => '',
  getSessionTitle = null,
  fetchImpl,
  now = () => Date.now(),
  log = console,
} = {}) {
  const logWarn = (...args) => (log.warn ?? log.log ?? (() => {})).call(log, ...args);
  /** sessionKey → 最近一次 turn/end 的结束原因（通知正文用它）。 */
  const reasons = new Map();
  /** sessionKey → 上次通知时间（去抖）。 */
  const sentAt = new Map();
  /** 最近一轮发送结果（status / notify.status 展示）。 */
  let lastResults = [];
  let lastAt = null;
  /** 单飞：同一时刻只允许一轮发送。 */
  let inFlight = null;
  let disposed = false;

  function config() {
    try {
      return (typeof getConfig === 'function' ? getConfig() : {}) ?? {};
    } catch (err) {
      logWarn('dsh-pocket: 读取通知配置失败 | failed to read notify config: %s', err?.message ?? err);
      return {};
    }
  }

  function resolveTitle(session, fallback = DEFAULT_TITLE) {
    try {
      if (typeof getSessionTitle === 'function') {
        const t = getSessionTitle(session);
        if (typeof t === 'string' && t.trim()) return t.trim().slice(0, 120);
      }
    } catch { /* 注入实现异常不影响通知 */ }
    const raw = pick(session, 'title', 'name', 'summary', 'label', 'description');
    if (typeof raw === 'string' && raw.trim()) return raw.trim().slice(0, 120);
    const meta = pick(session, 'meta', 'metadata');
    if (meta && typeof meta === 'object') {
      const t = pick(meta, 'title', 'name', 'summary');
      if (typeof t === 'string' && t.trim()) return t.trim().slice(0, 120);
    }
    return fallback;
  }

  /** 记录 turn/end 的原因（真正发通知在 agent/status → idle）。 */
  function onSessionEvent(session, event) {
    if (disposed) return;
    const type = pick(event, 'type', 'kind', 'event');
    if (type !== 'turn/end') return;
    const key = sessionKeyOf(session);
    if (!key) return;
    const reason = reasonFrom(event);
    if (reason) reasons.set(key, reason);
  }

  /** agent 进入 idle → 一个任务结束，按过滤规则决定是否通知。 */
  function onAgentStatus(payload) {
    if (disposed) return;
    const status = pick(payload, 'status', 'state');
    if (status !== 'idle') return;
    const agent = pick(payload, 'agent', 'session') ?? null;
    trigger(agent ?? payload, 'agent-idle').catch((err) => {
      logWarn('dsh-pocket: 通知发送失败 | notify send failed: %s', err?.message ?? err);
    });
  }

  /**
   * 任务完成判定入口（可测试）。
   * @param {object} session 会话（形状兼容多种 DSH 版本）
   * @param {string} [source] 触发来源（诊断用）
   * @returns {Promise<{sent:boolean, skipped?:string, results?:Array, push?:object, webhook?:object}>}
   */
  async function trigger(session, source = 'manual') {
    if (disposed) return { sent: false, skipped: 'disposed' };
    const cfg = config();
    if (cfg.onTaskDone === false) return { sent: false, skipped: 'notifyOnTaskDone-off' };
    if (!cfg.pushEnabled && !cfg.webhookEnabled) return { sent: false, skipped: 'no-channel' };
    const key = sessionKeyOf(session);
    if (!key) return { sent: false, skipped: 'no-session-id' };
    if (isSubagent(session)) return { sent: false, skipped: 'subagent' };
    const gapMs = Math.max(0, Number(cfg.minIntervalSec ?? 10) * 1000);
    const last = sentAt.get(key) ?? 0;
    if (gapMs > 0 && now() - last < gapMs) return { sent: false, skipped: 'debounced' };
    sentAt.set(key, now());
    if (sentAt.size > 200) {
      // 防内存膨胀：清掉早就过了去抖窗口的会话
      const cutoff = now() - Math.max(gapMs, 60_000) * 2;
      for (const [k, at] of sentAt) if (at < cutoff) sentAt.delete(k);
    }

    const title = resolveTitle(session);
    const reason = reasons.get(key) ?? '';
    reasons.delete(key); // 一次性消费：下一轮的结束原因由下一个 turn/end 写入
    // 正文 = 结束原因 + 会话标题（两者相同/缺一时不重复堆叠）
    const body = reason && reason !== title ? `${reason} · ${title}` : (reason || title);
    const out = await sendNow({
      title,
      body,
      tag: `dsh-${key}`,
      sessionId: key,
      source,
    });
    return { sent: true, ...out };
  }

  /** 子代理会话判定：parentSession / parentId 等任一非空都算。 */
  function isSubagent(session) {
    if (parentKeyOf(session)) return true;
    const agent = pick(session, 'agent');
    return !!(agent && typeof agent === 'object' && parentKeyOf(agent));
  }

  /**
   * 立即发送一轮（notify.test 也走这里：显式动作不看 notifyOnTaskDone，只看渠道开关）。
   * @returns {Promise<{push:object|null, webhook:object|null, results:Array}>}
   */
  async function sendNow({ title, body, url, tag, sessionId, source = 'manual' } = {}) {
    if (disposed) return { push: null, webhook: null, results: [], error: '已卸载 | disposed', source };
    if (inFlight) {
      // 同一时刻只允许一轮：等上一轮收尾再发（不丢事件，也不并发刷手机）
      try { await inFlight; } catch { /* 上一轮失败与本轮无关 */ }
    }
    const run = (async () => {
      const cfg = config();
      const entryTitle = String(title ?? '').trim() || DEFAULT_TITLE;
      const link = String(url ?? '').trim() || publicUrl() || '/';
      const payload = pushPayload({
        title: entryTitle,
        body: String(body ?? '').trim() || entryTitle,
        url: link,
        tag: tag || 'dsh-pocket',
        ...(sessionId ? { sessionId } : {}),
      });
      const results = [];
      let push = null;
      if (cfg.pushEnabled && pushStore) {
        const subs = pushStore.all();
        if (subs.length === 0) {
          // 渠道开着但没有订阅：如实记一条失败结果（notify.test 的 toast 要说「没订阅」，
          // 而不是假装「已发送」——手机上从没点过推送就是这个状态）
          push = { sent: 0, removed: 0, failed: 0, subscriptions: 0 };
          results.push({
            channel: 'push',
            ok: false,
            status: 0,
            error: '没有已订阅的设备（先在手机上打开推送） | no push subscriptions yet',
            reason: 'no-subscriptions',
            endpoint: '',
            at: now(),
          });
        } else {
          const outcome = await pushToAll(subs, payload, {
            vapid: pushStore.vapid(),
            ...(fetchImpl ? { fetchImpl } : {}),
            onResult: (entry) => {
              results.push({
                channel: 'push',
                ok: entry.ok === true,
                status: Number(entry.status) || 0,
                error: entry.error ?? null,
                reason: entry.reason ?? null,
                endpoint: entry.endpoint ?? '',
                at: now(),
              });
            },
          });
          // 404/410 → 订阅已失效，本地删掉（否则每轮都白推一遍）
          const gone = outcome.results.filter((r) => r.shouldDelete && r.endpoint).map((r) => r.endpoint);
          const removed = gone.length ? pushStore.removeMany(gone) : 0;
          for (const r of outcome.results) {
            if (r.ok && r.endpoint) {
              // lastUsedAt 用同一个时钟（生产就是 Date.now；测试可注入）
              try { pushStore.touch(r.endpoint, now()); } catch { /* 记录失败不影响发送结果 */ }
            }
          }
          push = { sent: outcome.sent, removed, failed: outcome.failed, subscriptions: subs.length };
        }
      }
      let webhook = null;
      if (cfg.webhookEnabled && String(cfg.webhookUrl ?? '').trim()) {
        const r = await sendWebhook({
          preset: cfg.webhookPreset,
          url: cfg.webhookUrl,
          secret: cfg.webhookSecret,
          title: entryTitle,
          body: String(body ?? '').trim() || entryTitle,
          link,
        }, {
          ...(fetchImpl ? { fetchImpl } : {}),
          now: now(),
        });
        webhook = { ok: r.ok === true, status: Number(r.status) || 0, error: r.error ?? null };
        results.push({ channel: 'webhook', ...webhook, endpoint: '', at: now() });
      }
      if (!push && !webhook) {
        // 渠道都没开：RPC 层据此回可读错误（notify.test 用）
        return { push: null, webhook: null, results: [], error: '未启用任何通知渠道 | no notification channel enabled', source };
      }
      lastResults = [...results].slice(-MAX_RESULTS);
      lastAt = now();
      return { push, webhook, results: lastResults, source };
    })();
    inFlight = run;
    try {
      return await run;
    } finally {
      if (inFlight === run) inFlight = null;
    }
  }

  function publicUrl() {
    try {
      const v = typeof getPublicUrl === 'function' ? getPublicUrl() : '';
      return typeof v === 'string' ? v.trim() : '';
    } catch {
      return '';
    }
  }

  /** 状态（notify.status 用）：最近一轮结果 + 是否正在发送。 */
  function status() {
    return {
      lastResults: lastResults.slice(),
      results: lastResults.slice(),
      sending: inFlight !== null,
      lastAt,
    };
  }

  return {
    onSessionEvent,
    onAgentStatus,
    trigger,
    sendNow,
    status,
    /** 测试/调试用：清掉去抖与原因缓存。 */
    reset() {
      reasons.clear();
      sentAt.clear();
      lastResults = [];
      lastAt = null;
    },
    dispose() {
      disposed = true;
      reasons.clear();
      sentAt.clear();
    },
  };
}
