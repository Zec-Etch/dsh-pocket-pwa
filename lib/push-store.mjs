// dsh-pocket：Web Push 订阅 + VAPID 密钥持久化（$DSH_HOME/dsh-pocket/push.json）
//
// 文件结构（版本化）：
//   { version: 1,
//     vapid: { publicKey, privateKey },
//     subscriptions: [{ endpoint, keys: { p256dh, auth }, ua, createdAt, lastUsedAt }] }
//
// 设计取舍（WHY）：
//   1) VAPID 密钥**必须持久化**：浏览器订阅时把公钥写死在推送服务侧，密钥一变所有
//      订阅立刻失效（推送服务回 401/403）。所以首次读取时缺密钥就生成并落盘，
//      绝不在每次启动时重新生成。
//   2) 文件含私钥 → 0o600；原子写（临时文件 + rename）：断电/写满不会留下半截 JSON，
//      写失败时旧文件原封不动，异常抛给调用方。
//   3) 私钥**永不**出现在任何返回值里：对外只有 publicKey()/vapid()（后者仅宿主内部
//      构造 sendPush 参数用，见 lib/notify-hook.mjs）。
//   4) 读路径自愈：损坏 → 备份 .bak 当空库（重新生成 VAPID；旧订阅失效但服务不会
//      永久起不来），与 lib/passkey-store.mjs 同一策略。
//   5) 每次调用重新读文件（与 settings / passkey-store 同风格）：撤销/清空立即生效，
//      不会因为内存缓存而延迟。

import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { generateVapidKeys, buildVapidKeyPair, normalizeSubscription } from './push.mjs';

const REL_PATH = join('dsh-pocket', 'push.json');
const VERSION = 1;
/** 订阅上限：单机不可能有几十台设备，超出的按最久未用淘汰，避免文件被撑大。 */
const MAX_SUBSCRIPTIONS = 50;

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 时间归一化为 epoch 毫秒（容忍 ISO 字符串 / 数字 / null）。 */
function toMillis(value, fallback = null) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const t = Date.parse(value);
    if (Number.isFinite(t)) return t;
  }
  return fallback;
}

/** 一条订阅的对外视图（不含任何密钥材料，只有推送必需的字段）。 */
function subscriptionView(s) {
  return {
    endpoint: s.endpoint,
    ua: s.ua,
    createdAt: s.createdAt,
    lastUsedAt: s.lastUsedAt,
  };
}

/**
 * 创建推送订阅存储。`home` 必须显式传入（测试用临时目录），不传则回落到
 * `$DSH_HOME` / `~/.dsh` —— 与 lib/settings.mjs、lib/passkey-store.mjs 一致。
 *
 * @param {{home?: string, log?: Function}} [opts]
 */
export function createPushStore({ home = process.env.DSH_HOME ?? join(homedir(), '.dsh'), log = () => {} } = {}) {
  const base = String(home ?? '').trim() || join(homedir(), '.dsh');
  const file = join(base, REL_PATH);
  const bakFile = `${file}.bak`;
  const tmpFile = `${file}.tmp`;
  /** VAPID 落盘失败时的进程内兜底：宁可这一轮用内存里那对，也不要每次读都换新密钥。 */
  let vapidMemo = null;

  function emptyDb() {
    return { version: VERSION, vapid: null, subscriptions: [] };
  }

  function quarantine(raw) {
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(bakFile, raw ?? '', { mode: 0o600 });
    } catch { /* 备份失败也要能继续用空库 —— 自愈优先于留档 */ }
    try {
      rmSync(file, { force: true });
    } catch { /* 删不掉就下次写覆盖 */ }
    return emptyDb();
  }

  function normalizeEntry(raw) {
    if (!isPlainObject(raw)) return null;
    const endpoint = typeof raw.endpoint === 'string' ? raw.endpoint.trim() : '';
    if (!endpoint) return null;
    const keys = isPlainObject(raw.keys) ? raw.keys : {};
    const p256dh = typeof keys.p256dh === 'string' ? keys.p256dh.trim() : '';
    const auth = typeof keys.auth === 'string' ? keys.auth.trim() : '';
    if (!p256dh || !auth) return null; // 缺密钥材料的订阅推不出去，直接丢
    return {
      endpoint,
      keys: { p256dh, auth },
      ua: typeof raw.ua === 'string' ? raw.ua.slice(0, 300) : '',
      createdAt: toMillis(raw.createdAt, Date.now()),
      lastUsedAt: toMillis(raw.lastUsedAt, null),
    };
  }

  /** 原子写：先写 .tmp（0o600），再 rename 覆盖正式文件；任何一步失败都抛给调用方。 */
  function writeDb(db) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const body = JSON.stringify({
      version: VERSION,
      vapid: db.vapid,
      subscriptions: db.subscriptions,
    }, null, 2);
    writeFileSync(tmpFile, body, { mode: 0o600 });
    renameSync(tmpFile, file); // POSIX/Windows 都是替换式重命名：旧文件要么完整保留要么被完整替换
  }

  /** 校验并补齐 VAPID 密钥（缺失/非法就生成一对并落盘）。 */
  function ensureVapid(db) {
    if (db.vapid) {
      try {
        return buildVapidKeyPair(db.vapid); // 顺手校验公私钥匹配
      } catch (err) {
        log(`推送 VAPID 密钥不可用，重新生成：${err?.message ?? err}`);
      }
    }
    if (vapidMemo) {
      db.vapid = vapidMemo;
      try { writeDb(db); } catch { /* 落盘失败也用内存里这对 */ }
      return vapidMemo;
    }
    const fresh = generateVapidKeys();
    db.vapid = fresh;
    try {
      writeDb(db);
    } catch (err) {
      // 写不进去时不抛：调用点可能在任务完成回调里，抛出去会打断正常流程；
      // 用进程内 memo 保证同一轮运行里密钥稳定。
      vapidMemo = fresh;
      log(`推送 VAPID 密钥落盘失败（本轮用内存密钥）：${err?.message ?? err}`);
    }
    return fresh;
  }

  function readDb() {
    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      const db = emptyDb();
      ensureVapid(db); // 全新安装：先把 VAPID 建好（契约要求首次读取即持久化）
      return db;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const db = quarantine(raw);
      ensureVapid(db);
      return db;
    }
    if (!isPlainObject(parsed) || Number(parsed.version) !== VERSION) {
      const db = quarantine(raw);
      ensureVapid(db);
      return db;
    }
    const db = {
      version: VERSION,
      vapid: isPlainObject(parsed.vapid) ? parsed.vapid : null,
      subscriptions: (Array.isArray(parsed.subscriptions) ? parsed.subscriptions : []).map(normalizeEntry).filter(Boolean),
    };
    db.vapid = ensureVapid(db);
    return db;
  }

  /** VAPID 密钥对（**含私钥**：只给宿主内部构造 sendPush 参数用，绝不进 status/RPC）。 */
  function vapid() {
    const pair = readDb().vapid;
    return { publicKey: pair.publicKey, privateKey: pair.privateKey };
  }

  /** VAPID 公钥（可以给浏览器的那个；pushManager.subscribe 的 applicationServerKey）。 */
  function publicKey() {
    return vapid().publicKey;
  }

  /** 订阅清单（脱敏视图：只有 endpoint/ua/时间，没有密钥材料）。 */
  function list() {
    return readDb().subscriptions.map(subscriptionView);
  }

  /** 订阅数（status 用）。 */
  function count() {
    return readDb().subscriptions.length;
  }

  /**
   * 订阅清单（**含 p256dh/auth**：sendPush 必需）。只给宿主内部（notify-hook）使用。
   * @returns {Array<{endpoint:string, keys:{p256dh:string,auth:string}, ua:string, createdAt:number, lastUsedAt:number|null}>}
   */
  function all() {
    return readDb().subscriptions.map((s) => ({ ...s, keys: { ...s.keys } }));
  }

  /**
   * 保存/更新一条订阅（同一 endpoint 原地更新，保留 createdAt）。
   * @param {object|string} input 浏览器 `PushSubscription.toJSON()` 形状
   * @param {{ua?: string}} [meta]
   * @returns {{endpoint:string, ua:string, createdAt:number, lastUsedAt:number|null, count:number}}
   */
  function add(input, { ua = '' } = {}) {
    const sub = normalizeSubscription(input); // 非法订阅在这里抛可读错误（RPC 转成 {error}）
    const db = readDb();
    const now = Date.now();
    const prev = db.subscriptions.find((s) => s.endpoint === sub.endpoint);
    const entry = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      ua: String(ua || sub.ua || prev?.ua || '').slice(0, 300),
      createdAt: prev?.createdAt ?? now,
      lastUsedAt: prev?.lastUsedAt ?? null,
    };
    let rest = db.subscriptions.filter((s) => s.endpoint !== sub.endpoint);
    rest.push(entry);
    if (rest.length > MAX_SUBSCRIPTIONS) {
      rest = rest.sort((a, b) => (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt)).slice(0, MAX_SUBSCRIPTIONS);
    }
    db.subscriptions = rest;
    writeDb(db);
    return { ...subscriptionView(entry), count: rest.length };
  }

  /** 删除一条订阅（按 endpoint）。返回是否有改动。 */
  function remove(endpoint) {
    const target = String(endpoint ?? '').trim();
    if (!target) return false;
    const db = readDb();
    const next = db.subscriptions.filter((s) => s.endpoint !== target);
    if (next.length === db.subscriptions.length) return false;
    db.subscriptions = next;
    writeDb(db);
    return true;
  }

  /** 批量删除（推送服务回 404/410 时用）。返回删除条数。 */
  function removeMany(endpoints) {
    const targets = new Set((Array.isArray(endpoints) ? endpoints : [endpoints]).map((e) => String(e ?? '').trim()).filter(Boolean));
    if (targets.size === 0) return 0;
    const db = readDb();
    const next = db.subscriptions.filter((s) => !targets.has(s.endpoint));
    const removed = db.subscriptions.length - next.length;
    if (removed > 0) {
      db.subscriptions = next;
      writeDb(db);
    }
    return removed;
  }

  /** 清空全部订阅（保留 VAPID 密钥：清了订阅不必换密钥）。返回清掉的条数。 */
  function clear() {
    const db = readDb();
    const n = db.subscriptions.length;
    if (n > 0) {
      db.subscriptions = [];
      writeDb(db);
    }
    return n;
  }

  /** 记一次「用过」（推送成功时更新 lastUsedAt）。 */
  function touch(endpoint, at = Date.now()) {
    const target = String(endpoint ?? '').trim();
    if (!target) return false;
    const db = readDb();
    const entry = db.subscriptions.find((s) => s.endpoint === target);
    if (!entry) return false;
    entry.lastUsedAt = Number.isFinite(at) ? at : Date.now();
    writeDb(db);
    return true;
  }

  /** 清掉全部数据（恢复出厂设置用）：订阅 + VAPID 密钥一起重来。 */
  function reset() {
    vapidMemo = null;
    try { rmSync(file, { force: true }); } catch { /* 忽略 */ }
    try { rmSync(bakFile, { force: true }); } catch { /* 忽略 */ }
    return true;
  }

  return {
    filePath: () => file,
    vapid,
    publicKey,
    list,
    all,
    count,
    add,
    remove,
    removeMany,
    clear,
    touch,
    reset,
  };
}
