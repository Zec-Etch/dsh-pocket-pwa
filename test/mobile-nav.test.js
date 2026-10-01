// The plugin must leave the host WebUI layout and interactions untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('client source and bundle do not adapt or patch the host WebUI', () => {
  for (const file of ['../client/index.jsx', '../client/client.js']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    for (const marker of ['mobileApply', 'data-mobile-nav', 'data-dsh-pocket-layout',
      'MOBILE_RIGHTBAR', 'mobile.rightbar.setEnabled', 'startFileGuard',
      'MutationObserver', 'Object.defineProperty(ctx.connection', 'ctx.connection.isLoopback =']) {
      assert.ok(!src.includes(marker), file + ' contains removed UI patch: ' + marker);
    }
  }
});

test('打包产物：三通道 SSH / 通知与 PWA / 通行密钥的端点与文案都在 client.js 里', () => {
  const bundle = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
  // RPC 端点名（client/api.js 冻结契约）：漏打包 = 设置页点了没反应
  for (const endpoint of [
    'ssh.setConfig', 'ssh.status', 'passkey.setEnabled', 'passkey.list', 'passkey.revoke', 'passkey.rename',
    'notify.setConfig', 'notify.status', 'notify.removeSubscription', 'notify.clearSubscriptions', 'notify.test',
  ]) {
    assert.ok(bundle.includes(`"${endpoint}"`), `打包产物缺少端点 "${endpoint}" —— 先跑 npm run build:client`);
  }
  // 宿主注入的浏览器入口（订阅/取消 + beforeinstallprompt）
  assert.ok(bundle.includes('dshPocketPush'), '打包产物缺少 window.dshPocketPush 用法');
  // 新增文案 key：SSH 状态表 / Webhook 预设表是「字符串字面量」引用，最容易被漏掉
  for (const key of [
    'sshStateIdle', 'sshStateStarting', 'sshStateConnected', 'sshStateReconnecting', 'sshStateFailed',
    'sshStateStopped', 'sshTitle', 'sshNeedCfg', 'sshTestUnavailable',
    'notifyTitle', 'notifySubsCount', 'notifySubscribeFailed', 'notifyMinIntervalPlaceholder',
    'notifyPresetGeneric', 'notifyPresetBark', 'notifyLastResult', 'notifyClear', 'notifyClearFailed',
    'pwaRow', 'pwaInstall', 'pwaNeedHttps', 'pwaNotReady',
    'passkeyTitle', 'passkeyInsecure', 'passkeyRevokeConfirm', 'passkeyLoadFailed', 'passkeyNever',
    'hostUnsupported', 'copyFailed',
  ]) {
    assert.ok(bundle.includes(`"${key}"`), `打包产物缺少文案 key "${key}" —— 先跑 npm run build:client`);
  }
});
