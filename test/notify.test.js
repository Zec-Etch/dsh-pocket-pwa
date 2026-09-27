// dsh-pocket：通知（lib/push-store.mjs + lib/notify-hook.mjs）测试
//
// 全部本地跑：推送/Webhook 都注入假 fetch，不需要网络；推送订阅用真实 store（临时 DSH_HOME）。
// 覆盖：VAPID 生成/持久化/不外泄私钥、订阅增删去重、404/410 自动清理、任务结束判定与去抖、
// 子代理跳过、单飞、Webhook 载荷字段、notify.test 自检。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createECDH } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPushStore } from '../lib/push-store.mjs';
import { createNotifyHook, sessionKeyOf, reasonFrom, NOTIFY_TEST_TITLE } from '../lib/notify-hook.mjs';

/**
 * 一条形状合法**且密码学可用**的推送订阅：
 * endpoint https + 65 字节未压缩 P-256 公钥（真点，随机 64 字节过不了库的曲线校验）
 * + 16 字节 auth 密钥。
 */
function subscription(endpoint) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint: endpoint ?? `https://push.example.com/send/${randomBytes(6).toString('hex')}`,
    keys: {
      p256dh: ecdh.getPublicKey().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
  };
}

/** 临时 DSH_HOME（push.json 写在里面）；fn 可以是 async（真正的清理在 await 之后）。 */
async function withStore(fn) {
  const home = mkdtempSync(join(tmpdir(), 'dshp-notify-'));
  try {
    return await fn(createPushStore({ home, log: () => {} }), home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const silentLog = { warn: () => {}, log: () => {}, error: () => {} };

test('push-store：首次读取生成并持久化 VAPID 公钥，实例之间一致（换进程也不变）', async () => withStore((store, home) => {
  const pub = store.publicKey();
  assert.match(pub, /^[A-Za-z0-9_-]+$/, 'base64url 公钥');
  assert.equal(Buffer.from(pub, 'base64url').length, 65, '65 字节未压缩 P-256 点');
  assert.ok(existsSync(join(home, 'dsh-pocket', 'push.json')), 'VAPID 落盘');

  // 新实例（等价于 DSH 重启）读到的必须是同一对密钥：换了公钥所有订阅立即失效
  const again = createPushStore({ home, log: () => {} });
  assert.equal(again.publicKey(), pub);
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(home, 'dsh-pocket', 'push.json')).mode & 0o777, 0o600, '文件含私钥 → 0o600');
  }
  // vapid() 给宿主内部用（含私钥），publicKey() 之外不泄露私钥
  const pair = store.vapid();
  assert.equal(pair.publicKey, pub);
  assert.match(pair.privateKey, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(pair.privateKey, pub);
}));

test('push-store：订阅增删去重；list/count 不外泄密钥材料', async () => withStore((store) => {
  assert.equal(store.count(), 0);
  const a = subscription();
  const saved = store.add(a, { ua: 'Mozilla/5.0 (iPhone)' });
  assert.equal(saved.count, 1);
  assert.equal(saved.endpoint, a.endpoint);
  assert.equal(store.count(), 1);

  // 同 endpoint 再来一次 → 原地更新，不新增
  store.add(a, { ua: 'Mozilla/5.0 (iPhone) v2' });
  assert.equal(store.count(), 1);
  const list = store.list();
  assert.equal(list[0].ua, 'Mozilla/5.0 (iPhone) v2');
  assert.ok(!('keys' in list[0]), 'list 只回脱敏视图（不含 p256dh/auth）');
  assert.ok(!JSON.stringify(list).includes(a.keys.p256dh), '列表响应里没有客户端公钥');

  store.add(subscription());
  assert.equal(store.count(), 2);
  assert.equal(store.remove(a.endpoint), true);
  assert.equal(store.count(), 1);
  assert.equal(store.remove('https://nope.example.com/x'), false, '不存在的 endpoint 返回 false');

  // all() 给发送方用，带密钥材料
  const all = store.all();
  assert.equal(all.length, 1);
  assert.match(all[0].keys.p256dh, /^[A-Za-z0-9_-]+$/);
  assert.equal(store.clear(), 1);
  assert.equal(store.count(), 0);
}));

test('push-store：非法订阅被拒（endpoint 非 https / 密钥长度不对），坏文件自愈并在 .bak 留档', async () => withStore((store, home) => {
  assert.throws(() => store.add({ endpoint: 'http://push.example.com/x', keys: { p256dh: 'AA', auth: 'BB' } }), /https/);
  assert.throws(() => store.add({ endpoint: 'https://push.example.com/x', keys: { p256dh: 'AA', auth: 'BB' } }), /p256dh/);
  assert.equal(store.count(), 0, '非法订阅不入库');

  const file = join(home, 'dsh-pocket', 'push.json');
  writeFileSync(file, '{ this is not json', 'utf8');
  const healed = createPushStore({ home, log: () => {} });
  assert.equal(healed.count(), 0, '损坏文件当空库（自愈）');
  assert.ok(existsSync(`${file}.bak`), '损坏内容备份成 .bak 供人工捞回');
  assert.match(JSON.parse(readFileSync(file, 'utf8')).vapid.publicKey, /^[A-Za-z0-9_-]+$/, '自愈后重新生成 VAPID');
}));

test('sessionKeyOf / reasonFrom：不同 DSH 版本的会话形状都能读到 id 与原因', () => {
  assert.equal(sessionKeyOf({ id: 's1' }), 's1');
  assert.equal(sessionKeyOf({ sessionId: 's2' }), 's2');
  assert.equal(sessionKeyOf({ key: 42 }), '42');
  assert.equal(sessionKeyOf(null), '');
  assert.equal(reasonFrom({ reason: '完成' }), '完成');
  assert.equal(reasonFrom({ data: { reason: '嵌套' } }), '嵌套');
  assert.equal(reasonFrom({ error: { message: 'boom' } }), 'boom');
  assert.equal(reasonFrom({}), '');
});

test('notify-hook：任务结束判定 —— 关闭开关 / 无渠道 / 子代理会话 / 无会话 id 都不发', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => { fetchCalls += 1; return { status: 201, text: async () => '' }; };
  const base = {
    pushStore: null,
    fetchImpl,
    log: silentLog,
    now: () => 1000,
  };
  // 1) notifyOnTaskDone 关闭
  let hook = createNotifyHook({ ...base, getConfig: () => ({ pushEnabled: true, onTaskDone: false, webhookEnabled: false }) });
  assert.deepEqual((await hook.trigger({ id: 's1' })).skipped, 'notifyOnTaskDone-off');

  // 2) 两个渠道都没开
  hook = createNotifyHook({ ...base, getConfig: () => ({ pushEnabled: false, webhookEnabled: false }) });
  assert.deepEqual((await hook.trigger({ id: 's1' })).skipped, 'no-channel');

  // 3) 子代理会话（parentSession 非空）
  hook = createNotifyHook({ ...base, getConfig: () => ({ pushEnabled: true, webhookEnabled: false }) });
  assert.deepEqual((await hook.trigger({ id: 'child', parentSession: 'root' })).skipped, 'subagent');

  // 4) 没有会话 id
  hook = createNotifyHook({ ...base, getConfig: () => ({ pushEnabled: true, webhookEnabled: false }) });
  assert.deepEqual((await hook.trigger({})).skipped, 'no-session-id');
  assert.equal(fetchCalls, 0);
});

test('notify-hook：turn/end 的结束原因进正文；同会话在 notifyMinIntervalSec 内只发一次', async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')));
    return { status: 200, text: async () => '{"code":0}' };
  };
  let clock = 10_000;
  const hook = createNotifyHook({
    getConfig: () => ({
      pushEnabled: false,
      onTaskDone: true,
      webhookEnabled: true,
      webhookPreset: 'generic',
      webhookUrl: 'https://hook.example.com/abc',
      webhookSecret: '',
      minIntervalSec: 10,
    }),
    getPublicUrl: () => 'https://pocket.example.com/?token=abc',
    fetchImpl,
    now: () => clock,
    log: silentLog,
  });

  hook.onSessionEvent({ id: 's1', title: '修登录 bug' }, { type: 'turn/end', reason: '回答完成' });
  const first = await hook.trigger({ id: 's1', title: '修登录 bug' });
  assert.equal(first.sent, true);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].title, '修登录 bug');
  // generic 预设把正文放在 message（标题单独一段），其它平台（wecom/feishu/ntfy）才拼成一段
  assert.equal(bodies[0].message, '回答完成 · 修登录 bug', '正文 = 结束原因 · 会话标题');
  assert.equal(bodies[0].url, 'https://pocket.example.com/?token=abc', '跳转目标 = 当前公网入口（没有时回退 /）');

  // 10 秒内第二次 → 去抖
  clock += 3000;
  hook.onSessionEvent({ id: 's1' }, { type: 'turn/end', reason: '又完成' });
  const second = await hook.trigger({ id: 's1' });
  assert.equal(second.skipped, 'debounced');
  assert.equal(bodies.length, 1, '窗口内不重复发');

  // 超过窗口 → 再发；另一个会话不受影响
  clock += 11_000;
  const third = await hook.trigger({ id: 's1' });
  assert.equal(third.sent, true);
  assert.equal(bodies.length, 2);
  const other = await hook.trigger({ id: 's2', title: '别的会话' });
  assert.equal(other.sent, true, '去抖按会话隔离');
  assert.equal(bodies.length, 3);

  // 结果列表形状（前端 notify.status / notify.test 用；只保留最近一轮，前端取末条展示）
  const st = hook.status();
  assert.equal(st.lastResults.length, 1, 'lastResults = 最近一轮的结果');
  const last = st.lastResults[st.lastResults.length - 1];
  assert.equal(last.channel, 'webhook');
  assert.equal(last.ok, true);
  assert.equal(typeof last.status, 'number');
  assert.equal(typeof last.at, 'number');
});

test('notify-hook：推送 404/410 自动删订阅；成功时更新 lastUsedAt；结果带 channel/status', async () => withStore(async (store) => {
  const good = subscription();
  const gone = subscription();
  const failing = subscription();
  store.add(good);
  store.add(gone);
  store.add(failing);
  assert.equal(store.count(), 3);

  const fetchImpl = async (url) => {
    if (url === gone.endpoint) return { status: 410, text: async () => '' };
    if (url === failing.endpoint) return { status: 500, text: async () => '' };
    return { status: 201, text: async () => '' };
  };
  const hook = createNotifyHook({
    getConfig: () => ({ pushEnabled: true, onTaskDone: true, webhookEnabled: false, minIntervalSec: 0 }),
    pushStore: store,
    fetchImpl,
    now: () => 12345,
    log: silentLog,
  });
  const out = await hook.sendNow({ title: '完成', body: '任务完成', tag: 'dsh-s1', sessionId: 's1' });
  assert.equal(out.push.sent, 1, '一条成功');
  assert.equal(out.push.removed, 1, '410 的那条被判定失效');
  assert.equal(out.push.failed, 1, '500 的那条算失败但不删');
  assert.equal(store.count(), 2, '失效订阅已从本地删除');
  assert.ok(!store.list().some((s) => s.endpoint === gone.endpoint), '410 订阅确实不在列表里');
  assert.equal(store.list().find((s) => s.endpoint === good.endpoint)?.lastUsedAt, 12345, '成功发送更新 lastUsedAt');
  const pushResults = hook.status().lastResults.filter((r) => r.channel === 'push');
  assert.equal(pushResults.length, 3);
  assert.ok(pushResults.every((r) => typeof r.status === 'number'));
}));

test('notify-hook：同一时刻只允许一轮发送（单飞），notify.test 不受 notifyOnTaskDone 影响', async () => withStore(async (store) => {
  store.add(subscription());
  let concurrent = 0;
  let maxConcurrent = 0;
  const fetchImpl = async () => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((r) => setTimeout(r, 5));
    concurrent -= 1;
    return { status: 201, text: async () => '' };
  };
  const hook = createNotifyHook({
    getConfig: () => ({ pushEnabled: true, onTaskDone: false, webhookEnabled: false, minIntervalSec: 0 }),
    pushStore: store,
    fetchImpl,
    log: silentLog,
  });
  await Promise.all([hook.sendNow({ title: NOTIFY_TEST_TITLE }), hook.sendNow({ title: NOTIFY_TEST_TITLE })]);
  assert.equal(maxConcurrent, 1, '并发调用被串行化：手机不会被并发推送刷屏');
  // 渠道都没开时给出可读原因（RPC 转成错误响应）
  const empty = createNotifyHook({ getConfig: () => ({ pushEnabled: false, webhookEnabled: false }), fetchImpl, log: silentLog });
  const out = await empty.sendNow({ title: 'x' });
  assert.match(String(out.error ?? ''), /渠道/);
}));

test('notify-hook：onSessionEvent 只认 turn/end；onAgentStatus 只在 idle 时触发', async () => {
  let sent = 0;
  const fetchImpl = async () => { sent += 1; return { status: 200, text: async () => '{"code":0}' }; };
  const hook = createNotifyHook({
    getConfig: () => ({ pushEnabled: false, onTaskDone: true, webhookEnabled: true, webhookPreset: 'generic', webhookUrl: 'https://hook.example.com/x', minIntervalSec: 0 }),
    fetchImpl,
    log: silentLog,
  });
  hook.onSessionEvent({ id: 's9' }, { type: 'turn/start' });
  hook.onAgentStatus({ agent: { id: 's9', status: 'running' }, status: 'running' });
  assert.equal(sent, 0, '非 idle 不触发');
  hook.onAgentStatus({ agent: { id: 's9' }, status: 'idle' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent, 1, 'idle → 发出通知');
  // dispose 之后不再发
  hook.dispose();
  hook.onAgentStatus({ agent: { id: 's9' }, status: 'idle' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent, 1);
});
