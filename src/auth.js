// Login do painel: senha única (hash scrypt no banco), sessão em cookie httpOnly guardada no SQLite
// (só o hash do identificador; sobrevive a reinício), expiração por inatividade, limite de tentativas
// e comparação de segredos em tempo constante.

import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { getSetting, setSetting } from './db.js';

const SCRYPT = { N: 16384, r: 8, p: 1 };
const scrypt = promisify(crypto.scrypt);
export const SESSION_MS = 30 * 24 * 60 * 60 * 1000;   // vida máxima: 30 dias
export const INATIVIDADE_MS = 7 * 24 * 60 * 60 * 1000; // sem uso por 7 dias, cai
const TOQUE_MS = 10 * 60 * 1000;                       // atualiza "último uso" no máximo a cada 10 min
const HASH_KEY = 'panel_password_hash';
export const SENHA_MIN = 8;

export function hashPassword(pw, salt = crypto.randomBytes(16)) {
  const h = crypto.scryptSync(String(pw), salt, 32, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}

/** Assíncrono: não trava o servidor enquanto calcula. */
export async function verifyPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const h = await scrypt(String(pw), Buffer.from(saltHex, 'hex'), 32, SCRYPT);
  return safeEqual(h, Buffer.from(hashHex, 'hex'));
}

/** Compara dois segredos sem vazar, pelo tempo, em que posição divergem. */
export function safeEqual(a, b) {
  const x = Buffer.isBuffer(a) ? a : Buffer.from(String(a ?? ''));
  const y = Buffer.isBuffer(b) ? b : Buffer.from(String(b ?? ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/** Troca a senha do painel e encerra todas as sessões. */
export function setPassword(db, pw) {
  if (String(pw).length < SENHA_MIN) throw new Error(`A senha precisa ter ao menos ${SENHA_MIN} caracteres.`);
  setSetting(db, HASH_KEY, hashPassword(pw));
  db.exec('DELETE FROM sessions');
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* cookie malformado: ignora */ }
  }
  return out;
}

/** Conta falhas por chave (IP, ou 'global') e bloqueia depois de `max` dentro de `windowMs`. */
export function createLimiter({ max, windowMs }) {
  const hits = new Map();
  const get = (k) => { const h = hits.get(k); if (h && h.resetAt <= Date.now()) { hits.delete(k); return null; } return h || null; };
  return {
    blocked: (k) => { const h = get(k); return !!h && h.count >= max; },
    fail(k) {
      const h = get(k) || { count: 0, resetAt: Date.now() + windowMs };
      h.count++; hits.set(k, h);
      if (hits.size > 10000) for (const [key, v] of hits) if (v.resetAt <= Date.now()) hits.delete(key);
    },
    reset: (k) => hits.delete(k),
    retryAfterS: (k) => { const h = get(k); return h ? Math.max(1, Math.ceil((h.resetAt - Date.now()) / 1000)) : 0; },
  };
}

const sidHash = (sid) => crypto.createHash('sha256').update(String(sid)).digest('hex');

export function createAuth({ db, password = '' }) {
  if (password && !getSetting(db, HASH_KEY)) {
    if (String(password).length < SENHA_MIN) throw new Error(`PANEL_PASSWORD precisa ter ao menos ${SENHA_MIN} caracteres.`);
    setSetting(db, HASH_KEY, hashPassword(password));
  }
  const enabled = () => !!getSetting(db, HASH_KEY);

  async function login(pw, ip) {
    if (!(await verifyPassword(pw, getSetting(db, HASH_KEY)))) return null;
    const now = Date.now();
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
    const sid = crypto.randomBytes(32).toString('hex');
    // no banco fica só o hash: um vazamento do banco ou de um backup não dá sessões válidas
    db.prepare('INSERT INTO sessions (id, created_at, expires_at, ip, last_seen) VALUES (?,?,?,?,?)').run(sidHash(sid), now, now + SESSION_MS, String(ip || ''), now);
    return sid;
  }
  function sessionFrom(sid) {
    if (!sid || !/^[a-f0-9]{64}$/.test(sid)) return null;
    const h = sidHash(sid);
    const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(h);
    if (!s) return null;
    const now = Date.now();
    if (s.expires_at < now || (s.last_seen || s.created_at) + INATIVIDADE_MS < now) { db.prepare('DELETE FROM sessions WHERE id = ?').run(h); return null; }
    if (now - (s.last_seen || 0) > TOQUE_MS) db.prepare('UPDATE sessions SET last_seen = ? WHERE id = ?').run(now, h);
    return s;
  }
  const logout = (sid) => { if (sid) db.prepare('DELETE FROM sessions WHERE id = ?').run(sidHash(sid)); };

  return { enabled, login, logout, sessionFrom, setPassword: (pw) => setPassword(db, pw) };
}
