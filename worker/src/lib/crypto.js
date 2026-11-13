const enc = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function hmacKey(secret) {
  if (!secret || secret.length < 16) throw new Error('SESSION_SECRET is missing or too short (set it with wrangler secret put)');
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function hmacHex(secret, data) {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** Signed, expiring token: base64url(json).base64url(hmac) */
export async function sign(secret, payload, ttlSec) {
  const body = b64url(enc.encode(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec })));
  const sig = b64url(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body)));
  return `${body}.${sig}`;
}
export async function verify(secret, token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64url(sig), enc.encode(body));
  if (!ok) return null;
  const data = JSON.parse(new TextDecoder().decode(fromB64url(body)));
  if (data.exp && data.exp < Date.now() / 1000) return null;
  return data;
}

/** PBKDF2 password hashing (100k iterations, SHA-256). Format: pbkdf2$iter$salt$hash */
export async function hashPassword(pw, iter = 100000) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
  return `pbkdf2$${iter}$${b64url(salt)}$${b64url(bits)}`;
}
/** Iterations from env (free plan: 20000 to stay inside the 10 ms CPU limit; paid plan: 100000). */
export const pwIter = (env) => Math.max(10000, +env?.PBKDF2_ITERATIONS || 100000);
export const needsRehash = (stored, env) => +String(stored).split('$')[1] < pwIter(env);

export async function checkPassword(pw, stored) {
  const [, iter, salt, hash] = String(stored).split('$');
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromB64url(salt), iterations: +iter }, key, 256);
  return safeEqual(b64url(bits), hash);
}
export const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
