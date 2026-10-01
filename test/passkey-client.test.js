import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { POCKET_PWA_JS } from '../lib/proxy.mjs';
import { pocketCredentialToJSON, pocketErrorText } from '../lib/passkey-client.mjs';

const raw = Uint8Array.from([0, 255, 128, 1]).buffer;
const expected = Buffer.from(raw).toString('base64url');
const variants = {
  absent: undefined,
  throwing: () => { throw new Error('unsupported'); },
  empty: () => ({}),
  partial: () => ({ response: { clientDataJSON: {} } }),
  binary: () => ({ rawId: raw, response: { clientDataJSON: raw } }),
  standard: () => ({ id: expected, rawId: expected, type: 'public-key', response: {
    clientDataJSON: expected, attestationObject: expected, authenticatorData: expected, signature: expected,
  } }),
};
function credential(toJSON) {
  const response = Object.create(null);
  for (const field of ['clientDataJSON', 'attestationObject', 'authenticatorData', 'signature']) {
    Object.defineProperty(response, field, { get: () => raw });
  }
  response.getTransports = () => ['internal', 'internal', 'hybrid'];
  const result = Object.create(null);
  for (const [field, value] of Object.entries({ rawId: raw, id: expected, type: 'public-key', response })) {
    Object.defineProperty(result, field, { get: () => value });
  }
  if (toJSON) Object.defineProperty(result, 'toJSON', { value: toJSON });
  return result;
}
for (const [variant, toJSON] of Object.entries(variants)) {
  for (const ceremony of ['register', 'login']) test(`${ceremony}: ${variant} toJSON with non-enumerable WebIDL fields`, () => {
    const value = pocketCredentialToJSON(credential(toJSON), ceremony);
    assert.equal(value.rawId, expected);
    assert.equal(value.id, expected);
    assert.equal(value.response.clientDataJSON, expected);
    if (ceremony === 'register') {
      assert.equal(value.response.attestationObject, expected);
      assert.deepEqual(value.response.transports, ['internal', 'hybrid']);
    } else {
      assert.equal(value.response.authenticatorData, expected);
      assert.equal(value.response.signature, expected);
      assert.equal(value.response.userHandle, null);
    }
  });
  test(`PWA register script: ${variant} toJSON submits encoded response`, async () => {
    const calls = [];
    const window = { __DSH_POCKET_CFG__: { passkey: true }, PublicKeyCredential() {}, addEventListener() {} };
    runInNewContext(POCKET_PWA_JS, { window, navigator: { credentials: { create: async () => credential(toJSON) } },
      btoa, atob, Uint8Array, ArrayBuffer, fetch: async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return { ok: true, json: async () => url.endsWith('/begin') ? {
          flowId: 'flow', challenge: expected, rp: { id: 'example.com' }, user: { id: expected, name: 'user', displayName: 'User' },
        } : { device: { id: expected } } };
      } });
    const result = await window.dshPocketPasskey.register('phone');
    assert.equal(result.ok, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].body.response.attestationObject, expected);
    assert.deepEqual(calls[1].body.response.transports, ['internal', 'hybrid']);
    assert.equal(calls[1].body.flowId, 'flow');
  });
}
test('empty credentials fail clearly before the finish request', async () => {
  for (const value of [null, {}, { rawId: raw, response: {} }]) {
    assert.throws(() => pocketCredentialToJSON(value, 'register'), /cancelled|missing/);
  }
  const calls = [];
  const window = { __DSH_POCKET_CFG__: { passkey: true }, PublicKeyCredential() {}, addEventListener() {} };
  runInNewContext(POCKET_PWA_JS, { window, navigator: { credentials: { create: async () => ({}) } },
    btoa, atob, Uint8Array, ArrayBuffer, fetch: async (url) => {
      calls.push(url);
      return { ok: true, json: async () => ({ flowId: 'flow', challenge: expected, rp: {}, user: { id: expected } }) };
    } });
  const result = await window.dshPocketPasskey.register('phone');
  assert.equal(result.ok, false);
  assert.match(result.error.message, /missing rawId/);
  assert.equal(calls.length, 1);
});
test('error objects never render as object Object or an empty message', () => {
  assert.equal(pocketErrorText({ error: { message: 'specific failure' } }), 'specific failure');
  assert.equal(pocketErrorText(new DOMException('cancelled', 'NotAllowedError')), 'cancelled');
  assert.match(pocketErrorText({}), /Operation failed/);
  assert.match(pocketErrorText(null), /Operation failed/);
});
for (const [name, code, message] of [
  ['InvalidStateError', 'already-registered', /无需重复注册/],
  ['NotAllowedError', 'registration-cancelled', /取消、超时或未获授权/],
  ['AbortError', 'registration-cancelled', /取消、超时或未获授权/],
  [undefined, 'register-failed', /Operation failed/],
]) test('registration rejection is actionable: ' + (name || 'empty object'), async () => {
  const calls = [];
  const window = { __DSH_POCKET_CFG__: { passkey: true }, PublicKeyCredential() {}, addEventListener() {} };
  runInNewContext(POCKET_PWA_JS, { window, navigator: { credentials: { create: async ({ publicKey }) => {
    assert.equal(publicKey.excludeCredentials.length, 1);
    throw name ? { name, message: 'opaque browser error' } : {};
  } } }, btoa, atob, Uint8Array, ArrayBuffer, fetch: async (url) => {
    calls.push(url);
    return { ok: true, json: async () => ({ flowId: 'flow', challenge: expected, rp: {}, user: { id: expected },
      excludeCredentials: [{ type: 'public-key', id: expected }] }) };
  } });
  const result = await window.dshPocketPasskey.register('phone');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, code);
  assert.match(result.error.message, message);
  assert.ok(!result.error.message.includes('opaque browser error'));
  assert.equal(calls.length, 1, 'rejected registration never submits finish or changes credentials');
});

test('PWA script does not add a floating registration bar or modify the host DOM', () => {
  assert.ok(!POCKET_PWA_JS.includes('document.createElement'));
  assert.ok(!POCKET_PWA_JS.includes('dsh-pocket-passkey-bar'));
});
