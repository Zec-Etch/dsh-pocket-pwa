// 设置页 i18n 词典完整性（PR #36）：zh/en key 集合必须一致、占位符一致、
// 源码 t()/fmt() 引用的 key 必须都在词典中——防止加字符串时 key 不同步（英文漏翻/白屏 key）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { NS, zh, en } = await import('../client/pocket-locales.js');

const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('pocket 词典：zh/en key 集合完全一致', () => {
  const zhKeys = Object.keys(zh).sort();
  const enKeys = Object.keys(en).sort();
  assert.deepEqual(enKeys, zhKeys, 'en 与 zh 的 key 必须一一对应');
  assert.ok(zhKeys.length >= 40, `词典 key 数异常（${zhKeys.length}）——i18n 重构后应有 40+`);
});

test('pocket 词典：占位符 {placeholder} 在 zh/en 中一致', () => {
  for (const key of Object.keys(zh)) {
    assert.deepEqual(ph(en[key]), ph(zh[key]), `key "${key}" 的占位符在 zh/en 不一致`);
  }
});

test('pocket 词典：源码 t()/fmt() 引用的 key 都在词典中', () => {
  const src = readFileSync(new URL('../client/index.jsx', import.meta.url), 'utf8');
  const used = new Set();
  for (const m of src.matchAll(/\bt\('([^']+)'\)/g)) used.add(m[1]);
  for (const m of src.matchAll(/fmt\(t,\s*'([^']+)'/g)) used.add(m[1]);
  const missing = [...used].filter((k) => !(k in zh));
  assert.deepEqual(missing, [], '源码引用了词典中不存在的 key');
  // section 经 translate() 调用，单独校验
  assert.equal(zh.section, '手机访问', 'tab 标签中文');
  assert.equal(en.section, 'Phone access', 'tab 标签英文');
  assert.equal(NS, 'pocket', 'namespace 固定');
});

// ── 三通道 SSH / 通知与 PWA / 通行密钥设备（task-6）新增文案 ──────────────
// 这些 key 有一部分是经「静态表」引用的（SSH 状态机、Webhook 预设），t() 直接扫描
// 覆盖不到，所以先按清单断言成对存在，再扫描源码里的表引用。
const SSH_STATES = ['idle', 'starting', 'connected', 'reconnecting', 'failed', 'stopped'];
const NOTIFY_PRESETS = ['generic', 'wecom', 'dingtalk', 'feishu', 'ntfy', 'bark'];

const NEW_KEYS = [
  'modeSsh', 'sshTitle', 'sshHint', 'sshHost', 'sshPort', 'sshUser', 'sshKeyPath', 'sshKeyPathHint',
  'sshKeyPathSet', 'sshRemoteBindPort', 'sshRemoteBindPortHint', 'sshAccessProtocol', 'sshAccessHost',
  'sshAccessHostHint', 'sshAccessPort', 'sshAutoRestore', 'sshAutoRestoreHint', 'sshNeedCfg', 'sshStartHint',
  'sshTest', 'sshTesting', 'sshTestOk', 'sshTestFail', 'sshTestUnavailable',
  'sshSaved', 'sshLastError', 'sshUrlHint', 'sshRunningHint',
  'startChannel', 'channelQuick', 'channelNamed', 'channelSsh', 'modePendingHint',
  'notifyTitle', 'notifyPush', 'notifyPushHint', 'notifySubsCount', 'notifySubscribe', 'notifyUnsubscribe',
  'notifySubscribed', 'notifyUnsubscribed', 'notifySubscribeFailed', 'notifyUnsubscribeFailed',
  'notifyPushUnsupported', 'notifyPushInsecure', 'notifyTest', 'notifyTesting', 'notifyTestSent', 'notifyTestFailed',
  'notifyLastResult', 'notifyRecentTitle', 'notifyHostFcm', 'notifyHostMozilla', 'notifyHostApple',
  'notifyDiagnose', 'notifyDiagnoseBtn', 'notifyDiagnosing', 'notifyDiagnoseNoProxy', 'notifyDiagnoseEnv',
  'notifyResultOk', 'notifyResultFail', 'notifyResultPush', 'notifyResultWebhook',
  'notifyNoResult', 'notifyClear', 'notifyClearConfirm', 'notifyCleared', 'notifyClearFailed', 'notifyWebhook', 'notifyWebhookHint', 'notifyPreset', 'notifyUrl', 'notifySecret',
  'notifySecretHint', 'notifySecretSet', 'notifyOnTaskDone', 'notifyMinInterval', 'notifyMinIntervalHint',
  'notifyMinIntervalPlaceholder', 'notifySaved',
  'pwaRow', 'pwaInstall', 'pwaInstallTriggered', 'pwaInstallDismissed', 'pwaInstallUnavailable',
  'pwaStandalone', 'pwaNeedHttps', 'pwaUnsupported', 'pwaNotReady',
  'passkeyTitle', 'passkeyHint', 'passkeyRpId', 'passkeyDeviceCount', 'passkeyUnsupported', 'passkeyInsecure',
  'passkeySecureHint', 'passkeyDevices', 'passkeyNoDevices', 'passkeyColCreated', 'passkeyColLastLogin',
  'passkeyRegister', 'passkeyRegisterBtn', 'passkeyRegistering', 'passkeyRegistered',
  'passkeyRegisterUnavailable', 'passkeyThisDevice',
  'passkeyRename', 'passkeyRevoke', 'passkeyRevokeConfirm', 'passkeyRevokeDone', 'passkeyRenamed',
  'passkeyLoadFailed', 'passkeyNever', 'passkeyUnnamed', 'passkeyEnabledDone', 'passkeyDisabledDone',
  'copy', 'copied', 'copyFailed', 'hostUnsupported',
  ...SSH_STATES.map((s) => `sshState${s[0].toUpperCase()}${s.slice(1)}`),
  ...NOTIFY_PRESETS.map((p) => `notifyPreset${p[0].toUpperCase()}${p.slice(1)}`),
];

test('pocket 词典（task-6）：三通道/通知/通行密钥新增 key 全部 zh/en 成对', () => {
  const missing = NEW_KEYS.filter((k) => !(k in zh) || !(k in en));
  assert.deepEqual(missing, [], '新增 key 必须在 zh 与 en 中同时存在');
  assert.ok(NEW_KEYS.length >= 90, `新增 key 数异常（${NEW_KEYS.length}）`);
  for (const k of NEW_KEYS) {
    assert.ok(String(zh[k]).trim().length > 0 && String(en[k]).trim().length > 0, `key "${k}" 不该是空串`);
  }
});

test('pocket 词典（task-6）：SSH 状态表 / Webhook 预设表引用的 key 都在词典里', () => {
  const src = readFileSync(new URL('../client/index.jsx', import.meta.url), 'utf8');
  // SSH 状态机六个状态必须各有文案（lib/ssh.mjs 的 state 取值）
  for (const s of SSH_STATES) {
    assert.match(src, new RegExp(`\\b${s}:\\s*'sshState`), `SSH 状态 "${s}" 缺少文案映射`);
  }
  // Webhook 六个预设必须各有文案（lib/webhook.mjs 的 preset 取值）
  for (const p of NOTIFY_PRESETS) {
    assert.match(src, new RegExp(`\\['${p}',\\s*'notifyPreset`), `Webhook 预设 "${p}" 缺少文案映射`);
  }
  // 源码里出现的所有静态表 key 字面量都必须在词典中（防止表里写了错 key）
  const used = new Set(
    [...src.matchAll(/'(sshState[A-Za-z]+|notifyPreset[A-Za-z]+)'/g)].map((m) => m[1]),
  );
  assert.ok(used.size >= SSH_STATES.length + NOTIFY_PRESETS.length, `静态表 key 扫描异常（${used.size}）`);
  const missing = [...used].filter((k) => !(k in zh) || !(k in en));
  assert.deepEqual(missing, [], '静态表引用了词典中不存在的 key');
});
