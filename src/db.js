import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, note TEXT DEFAULT '', created_at INTEGER);
CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER);
CREATE TABLE IF NOT EXISTS groups (
  jid TEXT PRIMARY KEY, name TEXT, size INTEGER, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER DEFAULT 1,
  tag_id INTEGER, template_id INTEGER,
  group_jids TEXT DEFAULT '[]',
  source_type TEXT DEFAULT 'list', source_config TEXT DEFAULT '{}',
  min_price REAL, max_price REAL, min_discount REAL,
  per_run INTEGER DEFAULT 3, interval_min INTEGER DEFAULT 60,
  window_start TEXT DEFAULT '08:00', window_end TEXT DEFAULT '22:00',
  dedupe_days INTEGER DEFAULT 7, send_image INTEGER DEFAULT 1,
  next_run_at INTEGER, last_run_at INTEGER, created_at INTEGER);
CREATE TABLE IF NOT EXISTS sent_offers (
  id INTEGER PRIMARY KEY, rule_id INTEGER, offer_key TEXT, sent_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_sent ON sent_offers (rule_id, offer_key, sent_at);
CREATE TABLE IF NOT EXISTS log (
  id INTEGER PRIMARY KEY, ts INTEGER, rule_id INTEGER, rule_name TEXT, level TEXT,
  group_name TEXT, offer_title TEXT, message TEXT);
CREATE INDEX IF NOT EXISTS idx_log_ts ON log (ts DESC);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, created_at INTEGER, expires_at INTEGER, ip TEXT);
`;

export const DEFAULT_TEMPLATE = [
  '*{TITULO_PRODUTO}*',
  '',
  '😱 De ~{PRECO_ANTIGO}~',
  '🔥 Por *{PRECO_PRODUTO}* ({DESCONTO_PRODUTO} OFF)',
  '⭐ {NUMERO_VENDAS}',
  '🚚 {FRETE}',
  '🎟️ Cupom: *{CUPOM}*',
  '',
  '🛒 Compre aqui: {LINK}',
].join('\n');

/** SQLite aceita só null/número/texto: converte undefined e booleanos. */
export function nz(v) {
  if (v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

export function openDb(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'disparador.db'));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  if (!db.prepare('SELECT 1 FROM templates LIMIT 1').get()) {
    db.prepare('INSERT INTO templates (name, body, created_at) VALUES (?, ?, ?)')
      .run('Padrão', DEFAULT_TEMPLATE, Date.now());
  }
  if (!getSetting(db, 'ext_token')) setSetting(db, 'ext_token', crypto.randomBytes(24).toString('hex'));
  return db;
}

export function getSetting(db, key, def = null) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : def;
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

/** Linha do banco -> objeto de regra com os campos JSON já lidos. */
export function parseRule(r) {
  if (!r) return null;
  return {
    ...r,
    enabled: !!r.enabled,
    send_image: !!r.send_image,
    group_jids: JSON.parse(r.group_jids || '[]'),
    source_config: JSON.parse(r.source_config || '{}'),
  };
}

export function addLog(db, { rule, level = 'info', group_name = null, offer_title = null, message }) {
  db.prepare('INSERT INTO log (ts, rule_id, rule_name, level, group_name, offer_title, message) VALUES (?,?,?,?,?,?,?)')
    .run(Date.now(), rule?.id ?? null, rule?.name ?? null, level, group_name, offer_title, message);
  // mantém o histórico enxuto
  db.prepare('DELETE FROM log WHERE id < (SELECT MAX(id) FROM log) - 5000').run();
}
