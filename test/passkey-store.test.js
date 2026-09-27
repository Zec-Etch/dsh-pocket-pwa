// lib/passkey-store.mjs 回归测试。
//
// 关注点：文件权限、秘密不外泄（磁盘上没有 token 明文、读取路径不返回 hash）、
// 原子写不破坏旧文件、损坏自愈、撤销要连凭据一起删、令牌校验必须常量时间。
// 所有测试都用 os.tmpdir() 下的临时 HOME，绝不碰真实的 $DSH_HOME。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { createPasskeyStore } from '../lib/passkey-store.mjs';

const FILE_REL = join('dsh-pocket', 'passkeys.json');
const LIB_PATH = join(import.meta.dirname, '..', 'lib', 'passkey-store.mjs');
const IS_POSIX = process.platform !== 'win32';

const JWK = { kty: 'EC', crv: 'P-256', x: 'eA-eA', y: 'why-why' };
const sha256Hex = (s) => createHash('sha256').update(s).digest('hex');

function newHome() {
  return mkdtempSync(join(tmpdir(), 'dshp-passkey-'));
}

/** 每个用例一个临时 HOME，自动清理。 */
function withHome(fn) {
  const home = newHome();
  try {
    return fn(home, createPasskeyStore({ home }));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const storePath = (home) => join(home, FILE_REL);
const readRaw = (home) => readFileSync(storePath(home), 'utf8');
const readJson = (home) => JSON.parse(readRaw(home));

function seed(store, id = 'cred-1', name = 'iPhone') {
  store.addCredential({ credentialId: id, publicKeyJwk: JWK, name, aaguid: 'aaguid-1', transports: ['internal'], signCount: 3 });
  return store.issueDeviceToken({ deviceId: id, name });
}

test('存储：不存在的文件视为空库，且读操作不会创建文件', () => withHome((home, store) => {
  assert.deepEqual(store.list(), []);
  assert.equal(store.findCredential('cred-1'), null);
  assert.equal(store.verifyDeviceToken('whatever'), null);
  assert.equal(existsSync(storePath(home)), false, '纯读不应写盘');
}));

test('存储：首次写入即版本化文件，令牌只存 sha256', () => withHome((home, store) => {
  store.addCredential({ credentialId: 'cred-1', publicKeyJwk: JWK, name: 'iPhone', aaguid: 'aaguid-1', transports: ['internal', 'internal'], signCount: 3 });
  const { token, deviceId } = store.issueDeviceToken({ deviceId: 'cred-1', name: 'iPhone' });
  assert.equal(deviceId, 'cred-1');
  assert.equal(typeof token, 'string');
  assert.ok(token.length >= 40, 'base64url(randomBytes(32)) 长度 ≥ 40');

  const raw = readJson(home);
  assert.equal(raw.version, 1, '文件带版本号');
  assert.equal(raw.credentials.length, 1);
  assert.equal(raw.devices.length, 1);
  assert.equal(raw.credentials[0].id, 'cred-1');
  assert.deepEqual(raw.credentials[0].transports, ['internal'], 'transports 去重');
  assert.equal(raw.devices[0].tokens.length, 1);
  assert.match(raw.devices[0].tokens[0].hash, /^[0-9a-f]{64}$/, '只存 sha256(hex)');
  assert.equal(raw.devices[0].tokens[0].hash, sha256Hex(token), '哈希就是 token 的 sha256');
  const text = readRaw(home);
  assert.equal(text.includes(token), false, '磁盘上没有 token 明文');
  assert.equal(existsSync(`${storePath(home)}.tmp`), false, '原子写的临时文件已被 rename 掉');
}));

test('存储：文件权限 0600（POSIX）；Windows 上以源码检查兜底', () => withHome((home, store) => {
  seed(store);
  if (IS_POSIX) {
    assert.equal(statSync(storePath(home)).mode & 0o777, 0o600, '文件 0600');
    assert.equal(statSync(join(home, 'dsh-pocket')).mode & 0o777, 0o700, '目录 0700');
  } else {
    // Windows 的 stat 不反映 POSIX 权限位（0o600 与 0o666 都读回 0o666），
    // 只能退一步守住源码里的 mode 参数，防止重构时被悄悄删掉。
    assert.match(readFileSync(LIB_PATH, 'utf8'), /mode: 0o600/, '源码仍以 0o600 创建文件');
  }
}));

test('list()：字段固定、按 id 去重、不泄露任何秘密', () => withHome((home, store) => {
  const { token } = seed(store);
  const list = store.list();
  assert.equal(list.length, 1);
  assert.deepEqual(Object.keys(list[0]).sort(), ['aaguid', 'createdAt', 'id', 'lastLoginAt', 'name', 'signCount', 'transports']);
  assert.equal(list[0].id, 'cred-1');
  assert.equal(list[0].name, 'iPhone');
  assert.equal(list[0].aaguid, 'aaguid-1');
  assert.deepEqual(list[0].transports, ['internal']);
  assert.equal(list[0].signCount, 3);
  assert.equal(list[0].lastLoginAt, null, '还没登录过');
  assert.equal(typeof list[0].createdAt, 'number');

  const text = JSON.stringify(list);
  assert.equal(text.includes(token), false, 'list 不含 token 明文');
  assert.equal(text.includes(sha256Hex(token)), false, 'list 不含 tokenHash');
  assert.equal(text.includes('publicKeyJwk'), false, 'list 不含公钥（设置页不需要）');
}));

test('findCredential / touchCredential：读公钥、更新计数器与最后登录时间', () => withHome((_home, store) => {
  seed(store);
  const found = store.findCredential('cred-1');
  assert.deepEqual(found.publicKeyJwk, JWK);
  assert.equal(found.signCount, 3);
  assert.equal(found.lastLoginAt, null);
  assert.equal(store.findCredential('不存在'), null);
  assert.equal(store.findCredential(''), null);

  const at = Date.now();
  const touched = store.touchCredential('cred-1', { signCount: 9, lastLoginAt: at });
  assert.equal(touched.signCount, 9);
  assert.equal(touched.lastLoginAt, at);
  assert.equal(store.findCredential('cred-1').signCount, 9, '落盘后重新读取仍是 9');
  // 同步型通行密钥上报 0 时不能把计数器抹回去（否则以后再也测不出回退）
  assert.equal(store.touchCredential('cred-1', { signCount: 0 }).signCount, 9);
  assert.equal(store.touchCredential('未知设备', { signCount: 1 }), null);
  assert.ok(store.list()[0].lastLoginAt >= at, 'list 反映最后登录时间');
}));

test('addCredential：同 credentialId 重复注册原地更新，保留 createdAt', () => withHome((_home, store) => {
  const first = store.addCredential({ credentialId: 'cred-1', publicKeyJwk: JWK, name: '旧名', signCount: 1 });
  const second = store.addCredential({ credentialId: 'cred-1', publicKeyJwk: { ...JWK, x: 'new-x' }, name: '新名', signCount: 5 });
  assert.equal(store.list().length, 1, '不重复插入');
  assert.equal(second.createdAt, first.createdAt, 'createdAt 保留');
  assert.equal(second.name, '新名');
  assert.equal(second.signCount, 5);
  assert.equal(store.findCredential('cred-1').publicKeyJwk.x, 'new-x');
  assert.throws(() => store.addCredential({ credentialId: '', publicKeyJwk: JWK }), /credentialId/, '空 id 拒绝');
  assert.throws(() => store.addCredential({ credentialId: 'x', publicKeyJwk: null }), /publicKeyJwk/, '缺公钥拒绝');
}));

test('令牌：issue → verify 命中；篡改 / 截断 / 空值一律 null', () => withHome((home, store) => {
  const { token } = seed(store, 'cred-1', 'iPhone');
  // 换一个 store 实例（重新读盘）也能验：令牌是文件级契约，不是内存态
  assert.deepEqual(createPasskeyStore({ home }).verifyDeviceToken(token), { deviceId: 'cred-1', name: 'iPhone' });

  const tampered = `${token.slice(0, 5)}${token[5] === 'A' ? 'B' : 'A'}${token.slice(6)}`;
  assert.equal(tampered.length, token.length, '只改一个字符，长度不变');
  assert.equal(store.verifyDeviceToken(tampered), null);
  assert.equal(store.verifyDeviceToken(token.slice(0, -1)), null, '截断');
  assert.equal(store.verifyDeviceToken(`${token}x`), null, '加长');
  assert.equal(store.verifyDeviceToken(''), null);
  assert.equal(store.verifyDeviceToken(undefined), null);
  assert.equal(store.verifyDeviceToken(12345), null);
  assert.equal(store.verifyDeviceToken('x'.repeat(43)), null, '同长度的错误令牌');

  const dev = readJson(home).devices[0];
  assert.equal(typeof dev.lastUsedAt, 'number', '验证成功后记录 lastUsedAt');
}));

test('令牌：ttlMs 过期后 verify 返回 null', async () => {
  const home = newHome();
  try {
    const store = createPasskeyStore({ home });
    store.addCredential({ credentialId: 'cred-1', publicKeyJwk: JWK, name: 'iPhone' });
    const long = store.issueDeviceToken({ deviceId: 'cred-1', ttlMs: 60000 }).token;
    const short = store.issueDeviceToken({ deviceId: 'cred-1', ttlMs: 1 }).token;
    assert.deepEqual(store.verifyDeviceToken(long), { deviceId: 'cred-1', name: 'iPhone' }, '未过期时有效');
    await delay(20);
    assert.equal(store.verifyDeviceToken(short), null, '过期后无效');
    assert.deepEqual(store.verifyDeviceToken(long), { deviceId: 'cred-1', name: 'iPhone' }, '未过期的另一个令牌不受影响');
    assert.throws(() => store.issueDeviceToken({ deviceId: 'cred-1', ttlMs: -5 }), /ttlMs/, 'ttlMs 非正数拒绝');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('令牌：一台设备可同时有多个有效令牌（多台手机上登录同一设备）', () => withHome((_home, store) => {
  seed(store);
  const a = store.issueDeviceToken({ deviceId: 'cred-1' }).token;
  const b = store.issueDeviceToken({ deviceId: 'cred-1' }).token;
  assert.notEqual(a, b);
  assert.equal(store.verifyDeviceToken(a).deviceId, 'cred-1');
  assert.equal(store.verifyDeviceToken(b).deviceId, 'cred-1');
  store.revokeDevice('cred-1');
  assert.equal(store.verifyDeviceToken(a), null, '撤销后两个令牌都失效');
  assert.equal(store.verifyDeviceToken(b), null);
}));

test('撤销：revokeDevice 同时删掉凭据与令牌（共享 id）', () => withHome((_home, store) => {
  seed(store);
  const { token } = store.issueDeviceToken({ deviceId: 'cred-1' });
  assert.equal(store.revokeDevice('cred-1'), true);
  assert.equal(store.findCredential('cred-1'), null, '凭据已删 —— 否则还能再断言换新令牌');
  assert.equal(store.verifyDeviceToken(token), null, '令牌已删');
  assert.deepEqual(store.list(), []);
  assert.equal(store.revokeDevice('cred-1'), false, '重复撤销返回 false');
  assert.equal(store.revokeDevice(''), false);
}));

test('撤销：revokeDeviceByToken 用令牌撤销自己；未知令牌返回 false', () => withHome((_home, store) => {
  const { token } = seed(store);
  assert.equal(store.revokeDeviceByToken(token), true);
  assert.equal(store.verifyDeviceToken(token), null);
  assert.equal(store.findCredential('cred-1'), null);
  assert.equal(store.revokeDeviceByToken('伪造的令牌'), false);
}));

test('撤销：revokeAll 清空设备与凭据，文件仍是合法 v1', () => withHome((home, store) => {
  seed(store, 'cred-1');
  const { token } = store.issueDeviceToken({ deviceId: 'cred-1' });
  seed(store, 'cred-2', 'Pixel');
  assert.equal(store.list().length, 2);
  assert.equal(store.revokeAll(), true);
  assert.deepEqual(store.list(), []);
  assert.equal(store.verifyDeviceToken(token), null);
  const raw = readJson(home);
  assert.equal(raw.version, 1);
  assert.deepEqual(raw.devices, []);
  assert.deepEqual(raw.credentials, []);
}));

test('setDeviceName：凭据与设备名同步；控制字符清理、超长截断', () => withHome((home, store) => {
  const { token } = seed(store, 'cred-1', 'iPhone');
  assert.equal(store.setDeviceName('cred-1', '  客厅的 iPhone  '), true);
  assert.equal(store.list()[0].name, '客厅的 iPhone', 'list 名字更新');
  assert.equal(store.verifyDeviceToken(token).name, '客厅的 iPhone', 'verify 返回新名字');

  store.setDeviceName('cred-1', 'a\u0000b\nc');
  assert.equal(store.list()[0].name, 'abc', '控制字符被删掉');
  store.setDeviceName('cred-1', '  多   空格  ');
  assert.equal(store.list()[0].name, '多 空格', '空白折叠并去首尾');
  store.setDeviceName('cred-1', 'x'.repeat(100));
  assert.equal(store.list()[0].name.length, 64, '名字限长 64');
  assert.equal(store.setDeviceName('未知设备', 'y'), false);
  assert.equal(store.setDeviceName('', 'y'), false);
  assert.equal(readJson(home).devices[0].name, readJson(home).credentials[0].name, '两处名字一致');
}));

test('自愈：损坏的 JSON 备份为 .bak、当作空库，之后还能继续用', () => withHome((home, store) => {
  const corrupt = '{ 这不是 JSON';
  mkdirSync(join(home, 'dsh-pocket'), { recursive: true });
  writeFileSync(storePath(home), corrupt);
  assert.deepEqual(store.list(), [], '损坏 = 空库');
  assert.equal(readFileSync(`${storePath(home)}.bak`, 'utf8'), corrupt, '原始内容留在 .bak');
  assert.equal(existsSync(storePath(home)), false, '损坏文件被移开');

  seed(store);
  assert.equal(store.list().length, 1, '自愈后继续工作');
  assert.equal(readJson(home).version, 1);
  assert.equal(readFileSync(`${storePath(home)}.bak`, 'utf8'), corrupt, '备份不被后续写入覆盖');
}));

test('自愈：非对象 / 不认识的版本同样按损坏处理', () => withHome((home, store) => {
  mkdirSync(join(home, 'dsh-pocket'), { recursive: true });
  writeFileSync(storePath(home), JSON.stringify([1, 2, 3]));
  assert.deepEqual(store.list(), [], '顶层是数组 → 空库');

  writeFileSync(storePath(home), JSON.stringify({ version: 99, devices: [], credentials: [] }));
  assert.deepEqual(store.list(), [], '版本 99 不当作 v1 硬读');
  assert.match(readFileSync(`${storePath(home)}.bak`, 'utf8'), /99/, '备份里有原始版本号');

  writeFileSync(storePath(home), '');
  assert.deepEqual(store.list(), [], '空文件（崩溃残留）也算损坏');
  seed(store);
  assert.equal(store.list().length, 1);
}));

test('原子写：写失败时抛错且旧文件原封不动，旧令牌仍可用', () => withHome((home, store) => {
  const { token } = seed(store, 'cred-1', 'iPhone');
  const before = readRaw(home);
  // 把临时文件路径占成目录：writeFileSync 必然失败（EISDIR/EPERM）
  const tmp = `${storePath(home)}.tmp`;
  mkdirSync(tmp);
  assert.throws(() => store.issueDeviceToken({ deviceId: 'cred-1' }), Error, '写失败必须抛给调用方（不能发了令牌却没落盘）');
  assert.equal(readRaw(home), before, '旧文件一字未动');
  assert.deepEqual(store.verifyDeviceToken(token), { deviceId: 'cred-1', name: 'iPhone' }, '旧令牌照常有效');
  assert.deepEqual(store.list().map((d) => d.id), ['cred-1']);

  rmSync(tmp, { recursive: true, force: true });
  assert.doesNotThrow(() => store.issueDeviceToken({ deviceId: 'cred-1' }));
  assert.deepEqual(store.verifyDeviceToken(token), { deviceId: 'cred-1', name: 'iPhone' });
}));

test('令牌校验：近失令牌全部拒绝；比较实现必须走 timingSafeEqual', () => withHome((_home, store) => {
  const { token } = seed(store);
  const variants = new Set();
  for (let i = 0; i < token.length; i += 7) {
    variants.add(`${token.slice(0, i)}${token[i] === 'A' ? 'B' : 'A'}${token.slice(i + 1)}`);
  }
  for (const v of variants) assert.equal(store.verifyDeviceToken(v), null, '每一位都经得起试探');

  // 行为上无法区分「常量时间比较」与「提前 return 的 === 比较」（要证明得做统计计时，
  // 不适合放进单元测试）。这里留一条白盒护栏：比较实现必须是 timingSafeEqual。
  const src = readFileSync(LIB_PATH, 'utf8');
  assert.match(src, /timingSafeEqual\(/, 'verifyDeviceToken 必须用常量时间比较');
}));

test('home 参数：缺省时用 $DSH_HOME，显式传入时优先于环境变量', () => {
  const envHome = newHome();
  const explicit = newHome();
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = envHome;
  try {
    const viaEnv = createPasskeyStore();
    viaEnv.addCredential({ credentialId: 'env-cred', publicKeyJwk: JWK, name: 'env' });
    assert.ok(existsSync(join(envHome, FILE_REL)), '不传 home 时落在 $DSH_HOME');
    assert.equal(existsSync(join(explicit, FILE_REL)), false);

    const viaArg = createPasskeyStore({ home: explicit });
    viaArg.addCredential({ credentialId: 'arg-cred', publicKeyJwk: JWK, name: 'arg' });
    assert.ok(existsSync(join(explicit, FILE_REL)), '显式 home 生效');
    assert.equal(viaArg.list()[0].id, 'arg-cred');
    assert.deepEqual(viaEnv.list().map((d) => d.id), ['env-cred'], '两个库互不影响');
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    rmSync(envHome, { recursive: true, force: true });
    rmSync(explicit, { recursive: true, force: true });
  }
});

test('读取路径不外泄秘密：findCredential / verifyDeviceToken 的返回值里没有 token 或 hash', () => withHome((_home, store) => {
  const { token } = seed(store);
  const hash = sha256Hex(token);
  const surfaces = [
    JSON.stringify(store.list()),
    JSON.stringify(store.findCredential('cred-1')),
    JSON.stringify(store.verifyDeviceToken(token)),
    JSON.stringify(store.touchCredential('cred-1', { signCount: 4 })),
  ];
  for (const text of surfaces) {
    assert.equal(text.includes(token), false, '不含 token 明文');
    assert.equal(text.includes(hash), false, '不含 tokenHash');
    assert.equal(text.includes('tokens'), false, '不含令牌数组字段');
    assert.equal(text.includes('hash'), false, '不含 hash 字段名/值');
  }
}));
