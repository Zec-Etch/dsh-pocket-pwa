// Browser-safe helpers shared by the settings/PWA API and the proxy login page.
// WebIDL properties are often non-enumerable; JSON.stringify(credential) is not a serializer.
export function pocketErrorText(error, fallback = '操作失败，请重试 | Operation failed — please retry') {
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error && typeof error === 'object') {
    if (typeof error.message === 'string' && error.message.trim()) return error.message.trim();
    if (error.error && error.error !== error) return pocketErrorText(error.error, fallback);
    if (typeof error.name === 'string' && error.name.trim()) return error.name.trim();
    if (typeof error.code === 'string' && error.code.trim()) return error.code.trim();
  }
  return fallback;
}

export function pocketCredentialToJSON(credential, ceremony) {
  if (!credential) throw new Error('验证已取消，请重试 | Verification cancelled — please retry');
  let json = {};
  try {
    if (typeof credential.toJSON === 'function') json = credential.toJSON() || {};
  } catch { /* Older browser implementations may throw; read WebIDL properties instead. */ }
  const response = credential.response || {};
  const encoded = json.response || {};
  const bytes = (value) => {
    if (typeof value === 'string') return /^[A-Za-z0-9_-]+$/.test(value) ? value : '';
    let view;
    if (ArrayBuffer.isView(value)) view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    else if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') view = new Uint8Array(value);
    else return '';
    let text = '';
    for (let i = 0; i < view.length; i++) text += String.fromCharCode(view[i]);
    return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const required = (field, value) => {
    if (!value) throw new Error('浏览器返回的通行密钥缺少 ' + field + '，请重试或更新浏览器 | Passkey response is missing ' + field + ' — retry or update your browser');
    return value;
  };
  const rawId = required('rawId', bytes(credential.rawId) || bytes(json.rawId) || bytes(credential.id) || bytes(json.id));
  const result = { id: rawId, rawId, type: credential.type || json.type || 'public-key', response: {} };
  if (result.type !== 'public-key') throw new Error('通行密钥类型无效 | Invalid passkey type');
  const fields = ceremony === 'register' ? ['clientDataJSON', 'attestationObject'] : ['clientDataJSON', 'authenticatorData', 'signature'];
  for (const field of fields) {
    result.response[field] = required(field, bytes(response[field]) || bytes(encoded[field]));
  }
  if (ceremony === 'register') {
    let transports = encoded.transports;
    try { if (typeof response.getTransports === 'function') transports = response.getTransports(); } catch { /* optional hint */ }
    result.response.transports = Array.isArray(transports) ? [...new Set(transports.filter((v) => typeof v === 'string'))] : [];
  } else {
    result.response.userHandle = bytes(response.userHandle) || bytes(encoded.userHandle) || null;
  }
  return result;
}

export const PASSKEY_CLIENT_HELPERS_SRC = `${pocketErrorText.toString()}\n${pocketCredentialToJSON.toString()}`;
