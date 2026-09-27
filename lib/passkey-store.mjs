// 设备凭据存储：$DSH_HOME/dsh-pocket/passkeys.json
//
// 一条通行密钥 = 一台「被记住的设备」。文件结构（版本化）：
//   { version: 1,
//     credentials: [{ id, name, publicKeyJwk, aaguid, transports, signCount, createdAt, lastLoginAt }],
//     devices:     [{ id, name, createdAt, lastUsedAt, tokens: [{ hash, createdAt, expiresAt }] }] }
//
// 设计取舍（WHY）：
//   1) credentials[].id === devices[].id === credentialId：撤销一处即连带另一处。
//      如果两者能用不同 id，就可能出现「设备已撤销、凭证还在」——凭证还在就能再跑一次
//      断言并换到**新令牌**，撤销等于没撤。共享 id 让 revokeDevice 一次性关掉两条路。
//   2) 文件只存 token 的 sha256（hex），不存明文：文件被读走 ≠ 设备被接管；
//      明文 token 只在 issueDeviceToken 的返回值里出现一次，服务端自己也不留底。
//   3) 原子写（临时文件 + rename）：断电/写满不会留下半截 JSON；写失败时旧文件原封不动，
//      并把异常抛给调用方 —— 「发了 token 但没落盘」这种事必须让上层知道。
//   4) 读路径永不抛：文件损坏 → 备份成 .bak 后当作空库。一个坏字节不该让用户永久进不去
//      （自愈），而且备份留着还能人工捞回设备记录。
//   5) 每次调用都重新读文件（与 lib/settings.mjs 同一风格）：代理进程与 CLI/设置页可能同时
//      在跑，内存缓存会让撤销「延迟生效」。文件只有几 KB，读一次远比留着不一致安全。
//
// 安全要求：任何读取路径都不得把 token 明文或 tokenHash 暴露给调用方（list/find/touch/
// verifyDeviceToken 的返回值里都没有 hashes）。verifyDeviceToken 用 timingSafeEqual 比较。

import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const REL_PATH = join('dsh-pocket', 'passkeys.json');
const VERSION = 1;
const MAX_NAME_LEN = 64;
const MAX_TOKENS_PER_DEVICE = 8; // 同一设备只留最近 8 个未过期令牌，避免重复登录把文件撑大
const LAST_USED_FLUSH_MS = 30000; // lastUsedAt 落盘节流：不必每个 HTTP 请求都写一次磁盘

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function normalizeName(name) {
  if (typeof name !== 'string') return '';
  // 名字会显示在设置页里：去掉控制字符、压掉空白、限长，避免把文件/界面撑坏
  return name.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LEN);
}

function normalizeTransports(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().slice(0, 32)))];
}

/** 只保留字符串/数字字段：JWK 是扁平的，嵌套垃圾没必要写进磁盘。 */
function sanitizeJwk(jwk) {
  const out = {};
  for (const [k, v] of Object.entries(jwk)) {
    if (typeof v === 'string' || typeof v === 'number') out[k] = v;
  }
  return out;
}

function requireId(value, field) {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id) throw new Error(`${field} 必填（非空字符串） | ${field} is required`);
  if (id.length > 512) throw new Error(`${field} 过长 | ${field} too long`);
  return id;
}

function entryView(c) {
  return {
    id: c.id,
    name: c.name,
    publicKeyJwk: { ...c.publicKeyJwk },
    aaguid: c.aaguid,
    transports: [...c.transports],
    signCount: c.signCount,
    createdAt: c.createdAt,
    lastLoginAt: c.lastLoginAt,
  };
}

/**
 * 创建设备凭据存储。`home` 必须显式传入（测试用临时目录），不传则回落到
 * `$DSH_HOME` / `~/.dsh` —— 与 lib/settings.mjs 完全一致的默认值。
 *
 * @param {{home?: string}} [opts]
 */
export function createPasskeyStore({ home = process.env.DSH_HOME ?? join(homedir(), '.dsh') } = {}) {
  const base = String(home ?? '').trim() || join(homedir(), '.dsh');
  const file = join(base, REL_PATH);
  const bakFile = `${file}.bak`;
  const tmpFile = `${file}.tmp`; // 固定名（不是随机名）：便于测试注入写失败，单进程代理不存在并发写
  const lastUsedMemo = new Map(); // tokenHash → 上次落盘时间（仅用于节流）

  function emptyDb() {
    return { version: VERSION, credentials: [], devices: [] };
  }

  function normalizeDevice(raw) {
    if (!isPlainObject(raw)) return null;
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (!id) return null;
    const tokens = Array.isArray(raw.tokens)
      ? raw.tokens
        .filter((t) => isPlainObject(t) && typeof t.hash === 'string' && /^[0-9a-f]{64}$/.test(t.hash))
        .slice(-MAX_TOKENS_PER_DEVICE)
        .map((t) => ({
          hash: t.hash,
          createdAt: Number.isFinite(t.createdAt) ? t.createdAt : 0,
          expiresAt: Number.isFinite(t.expiresAt) ? t.expiresAt : null,
        }))
      : [];
    return {
      id,
      name: normalizeName(raw.name),
      createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
      lastUsedAt: Number.isFinite(raw.lastUsedAt) ? raw.lastUsedAt : null,
      tokens,
    };
  }

  function normalizeCredential(raw) {
    if (!isPlainObject(raw) || typeof raw.id !== 'string' || !raw.id) return null;
    if (!isPlainObject(raw.publicKeyJwk)) return null;
    return {
      id: raw.id,
      name: normalizeName(raw.name),
      publicKeyJwk: sanitizeJwk(raw.publicKeyJwk),
      aaguid: typeof raw.aaguid === 'string' ? raw.aaguid : null,
      transports: normalizeTransports(raw.transports),
      signCount: Number.isFinite(raw.signCount) && raw.signCount >= 0 ? Math.floor(raw.signCount) : 0,
      createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
      lastLoginAt: Number.isFinite(raw.lastLoginAt) ? raw.lastLoginAt : null,
    };
  }

  /** 损坏文件搬家：留一份 .bak 再把它移开，返回空库（自愈）。 */
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

  function readDb() {
    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      return emptyDb(); // 文件不存在 = 全新安装
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return quarantine(raw);
    }
    if (!isPlainObject(parsed) || Number(parsed.version) !== VERSION) return quarantine(raw);
    return {
      version: VERSION,
      credentials: (Array.isArray(parsed.credentials) ? parsed.credentials : []).map(normalizeCredential).filter(Boolean),
      devices: (Array.isArray(parsed.devices) ? parsed.devices : []).map(normalizeDevice).filter(Boolean),
    };
  }

  /** 原子写：先写 .tmp（0o600），再 rename 覆盖正式文件。任何一步失败都抛给调用方。 */
  function writeDb(db) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const body = JSON.stringify({ version: VERSION, credentials: db.credentials, devices: db.devices }, null, 2);
    writeFileSync(tmpFile, body, { mode: 0o600 });
    renameSync(tmpFile, file); // POSIX/Windows 都是「替换式」重命名，旧文件要么完整保留要么被完整替换
  }

  /** 清掉过期令牌，返回是否有改动（写盘前调用）。 */
  function dropExpired(db, now) {
    let changed = false;
    for (const dev of db.devices) {
      const keep = dev.tokens.filter((t) => t.expiresAt == null || t.expiresAt > now);
      if (keep.length !== dev.tokens.length) {
        dev.tokens = keep;
        changed = true;
      }
    }
    return changed;
  }

  /**
   * 设备清单。凭据与「只发过令牌、还没建凭据」的设备都列出来，
   * 字段固定为 id/name/createdAt/lastLoginAt/transports/aaguid/signCount。
   */
  function list() {
    const db = readDb();
    const out = new Map();
    for (const c of db.credentials) {
      out.set(c.id, {
        id: c.id,
        name: c.name,
        createdAt: c.createdAt,
        lastLoginAt: c.lastLoginAt,
        transports: [...c.transports],
        aaguid: c.aaguid,
        signCount: c.signCount,
      });
    }
    for (const d of db.devices) {
      const cur = out.get(d.id);
      if (cur) {
        if (!cur.name && d.name) cur.name = d.name;
        if (cur.lastLoginAt == null) cur.lastLoginAt = d.lastUsedAt;
      } else {
        out.set(d.id, {
          id: d.id,
          name: d.name,
          createdAt: d.createdAt,
          lastLoginAt: d.lastUsedAt,
          transports: [],
          aaguid: null,
          signCount: 0,
        });
      }
    }
    return [...out.values()];
  }

  /** 记下一条通行密钥（同一 credentialId 重复注册时原地更新，保留 createdAt/lastLoginAt）。 */
  function addCredential({ credentialId, publicKeyJwk, name, aaguid, transports, signCount = 0 } = {}) {
    const id = requireId(credentialId, 'credentialId');
    if (!isPlainObject(publicKeyJwk)) throw new Error('publicKeyJwk 必填（对象） | publicKeyJwk is required');
    const db = readDb();
    const now = Date.now();
    const prev = db.credentials.find((c) => c.id === id);
    const entry = {
      id,
      name: normalizeName(name) || prev?.name || '',
      publicKeyJwk: sanitizeJwk(publicKeyJwk),
      aaguid: typeof aaguid === 'string' && aaguid ? aaguid : null,
      transports: normalizeTransports(transports),
      signCount: Number.isFinite(signCount) && signCount >= 0 ? Math.floor(signCount) : 0,
      createdAt: prev?.createdAt ?? now,
      lastLoginAt: prev?.lastLoginAt ?? null,
    };
    db.credentials = [...db.credentials.filter((c) => c.id !== id), entry];
    writeDb(db);
    return entryView(entry);
  }

  function findCredential(credentialId) {
    const id = typeof credentialId === 'string' ? credentialId.trim() : '';
    if (!id) return null;
    const found = readDb().credentials.find((c) => c.id === id);
    return found ? entryView(found) : null;
  }

  /** 更新计数器与最后登录时间（断言校验通过后调用）。找不到返回 null。 */
  function touchCredential(credentialId, { signCount, lastLoginAt = Date.now() } = {}) {
    const id = typeof credentialId === 'string' ? credentialId.trim() : '';
    if (!id) return null;
    const db = readDb();
    const c = db.credentials.find((x) => x.id === id);
    if (!c) return null;
    // 计数器只增不减：同步型通行密钥（iCloud/Google）永远上报 0，
    // 若把它当新的真值写回去，之后真正的回退攻击就再也检测不出来了。
    if (Number.isFinite(signCount) && signCount >= 0) c.signCount = Math.max(c.signCount, Math.floor(signCount));
    c.lastLoginAt = Number.isFinite(lastLoginAt) ? lastLoginAt : Date.now();
    writeDb(db);
    return entryView(c);
  }

  /**
   * 撤销一台设备：凭据 + 令牌一起删（两者共享 id）。
   * 只删令牌是不够的 —— 凭据还在就能重新断言并换一个新令牌。
   */
  function revokeDevice(id) {
    const dev = typeof id === 'string' ? id.trim() : '';
    if (!dev) return false;
    const db = readDb();
    const before = db.credentials.length + db.devices.length;
    db.credentials = db.credentials.filter((c) => c.id !== dev);
    db.devices = db.devices.filter((d) => d.id !== dev);
    const changed = db.credentials.length + db.devices.length !== before;
    if (changed) {
      for (const key of lastUsedMemo.keys()) lastUsedMemo.delete(key);
      writeDb(db);
    }
    return changed;
  }

  /**
   * 给设备签发长期令牌（写进 HttpOnly cookie 的那串）。
   * 明文只在这里返回一次，磁盘上只有 sha256。
   */
  function issueDeviceToken({ deviceId, name, ttlMs = null } = {}) {
    const id = requireId(deviceId, 'deviceId');
    if (ttlMs != null && !(Number.isFinite(ttlMs) && ttlMs > 0)) {
      throw new Error('ttlMs 必须是正数毫秒（或 null 表示不过期） | ttlMs must be a positive number or null');
    }
    const db = readDb();
    const now = Date.now();
    const token = randomBytes(32).toString('base64url');
    const cred = db.credentials.find((c) => c.id === id);
    let dev = db.devices.find((d) => d.id === id);
    const wanted = normalizeName(name) || cred?.name || dev?.name || '';
    if (!dev) {
      dev = { id, name: wanted, createdAt: now, lastUsedAt: null, tokens: [] };
      db.devices.push(dev);
    } else if (wanted) {
      dev.name = wanted;
    }
    dev.tokens = [...dev.tokens.filter((t) => t.expiresAt == null || t.expiresAt > now), {
      hash: sha256Hex(token),
      createdAt: now,
      expiresAt: ttlMs ? now + ttlMs : null,
    }].slice(-MAX_TOKENS_PER_DEVICE);
    writeDb(db);
    return { token, deviceId: id };
  }

  /**
   * 校验设备令牌：命中返回 { deviceId, name }，否则 null。
   * 比较走 timingSafeEqual，并且**不提前返回**：比较次数与命中的是哪台设备无关，
   * 攻击者无法用计时差探测「这个 token 前缀对不对」。
   */
  function verifyDeviceToken(token) {
    if (typeof token !== 'string' || !token) return null;
    const hash = Buffer.from(sha256Hex(token), 'hex');
    const db = readDb();
    const now = Date.now();
    let matched = null;
    for (const dev of db.devices) {
      for (const t of dev.tokens) {
        if (t.expiresAt != null && t.expiresAt <= now) continue;
        const stored = Buffer.from(t.hash, 'hex');
        if (stored.length === hash.length && timingSafeEqual(stored, hash)) matched = dev;
      }
    }
    if (!matched) {
      if (dropExpired(db, now)) {
        try { writeDb(db); } catch { /* 顺手清理失败不影响鉴权结果 */ }
      }
      return null;
    }
    const key = hash.toString('hex');
    let dirty = false;
    if (now - (lastUsedMemo.get(key) ?? 0) >= LAST_USED_FLUSH_MS) {
      lastUsedMemo.set(key, now);
      matched.lastUsedAt = now;
      dirty = true;
    }
    if (dropExpired(db, now)) dirty = true;
    if (dirty) {
      // 令牌本身已验过：这里只是记一笔 lastUsedAt，写失败不该把已认证的设备踢下线
      try { writeDb(db); } catch { /* 忽略 */ }
    }
    return { deviceId: matched.id, name: matched.name };
  }

  /** 用令牌撤销自己（「忘记此设备」）：先验令牌再删，防止拿别人的 id 撤别人的设备。 */
  function revokeDeviceByToken(token) {
    const hit = verifyDeviceToken(token);
    if (!hit) return false;
    return revokeDevice(hit.deviceId);
  }

  /** 清空全部设备与凭据（重置设置里的「清除所有已记住的设备」）。 */
  function revokeAll() {
    lastUsedMemo.clear();
    writeDb(emptyDb());
    return true;
  }

  /** 改设备显示名（凭据与设备记录同步改）。返回是否有命中的记录。 */
  function setDeviceName(id, name) {
    const dev = typeof id === 'string' ? id.trim() : '';
    if (!dev) return false;
    const nm = normalizeName(name);
    const db = readDb();
    let hit = false;
    const d = db.devices.find((x) => x.id === dev);
    if (d) {
      d.name = nm;
      hit = true;
    }
    const c = db.credentials.find((x) => x.id === dev);
    if (c) {
      c.name = nm;
      hit = true;
    }
    if (hit) writeDb(db);
    return hit;
  }

  return {
    list,
    addCredential,
    findCredential,
    touchCredential,
    revokeDevice,
    issueDeviceToken,
    verifyDeviceToken,
    revokeDeviceByToken,
    revokeAll,
    setDeviceName,
  };
}
