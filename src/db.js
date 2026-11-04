import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { TEMPLATE_AMAZON } from './template.js';

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
CREATE TABLE IF NOT EXISTS blocks (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, tag_id INTEGER, note TEXT DEFAULT '', created_at INTEGER);
CREATE TABLE IF NOT EXISTS block_groups (block_id INTEGER, jid TEXT, PRIMARY KEY (block_id, jid));
CREATE TABLE IF NOT EXISTS group_events (
  id INTEGER PRIMARY KEY, ts INTEGER, jid TEXT, participant TEXT, action TEXT, by_link INTEGER DEFAULT 0, actor TEXT);
CREATE INDEX IF NOT EXISTS idx_gev ON group_events (jid, participant, ts);
CREATE INDEX IF NOT EXISTS idx_gev_ts ON group_events (ts);
CREATE TABLE IF NOT EXISTS group_reads (
  jid TEXT, participant TEXT, day TEXT, ts INTEGER, PRIMARY KEY (jid, participant, day));
CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, mode TEXT DEFAULT 'fill',
  fallback_url TEXT, limit_members INTEGER DEFAULT 1000, reopen_below INTEGER DEFAULT 900,
  group_jids TEXT DEFAULT '[]', state TEXT DEFAULT '{}', enabled INTEGER DEFAULT 1, created_at INTEGER);
CREATE TABLE IF NOT EXISTS link_clicks (id INTEGER PRIMARY KEY, ts INTEGER, link_id INTEGER, jid TEXT, ip_hash TEXT);
CREATE INDEX IF NOT EXISTS idx_clicks ON link_clicks (link_id, ts);
CREATE TABLE IF NOT EXISTS group_proposals (
  id INTEGER PRIMARY KEY, link_id INTEGER, source_jid TEXT, name TEXT, status TEXT DEFAULT 'pending',
  created_jid TEXT, detail TEXT, created_at INTEGER, decided_at INTEGER);
-- Disparo manual, mensagem e enquete. status: pendente|enviando|concluido|erro|pausado|cancelado
CREATE TABLE IF NOT EXISTS envios (
  id INTEGER PRIMARY KEY, tipo TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
  group_jids TEXT NOT NULL DEFAULT '[]', quando TEXT NOT NULL DEFAULT 'agora', repetir TEXT,
  status TEXT NOT NULL DEFAULT 'pendente',
  next_run_at INTEGER, last_run_at INTEGER, resultado TEXT, user_id INTEGER, created_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_envios_fila ON envios (status, next_run_at);
CREATE TABLE IF NOT EXISTS envio_resultados (
  id INTEGER PRIMARY KEY, envio_id INTEGER NOT NULL, ocorrencia INTEGER NOT NULL,
  ts INTEGER, jid TEXT, group_name TEXT, ok INTEGER NOT NULL, erro TEXT);
CREATE INDEX IF NOT EXISTS idx_envio_res ON envio_resultados (envio_id, ocorrencia);
-- Destinos dos avisos. jid é o telefone (dado pessoal). resumo_blocos: NULL = não recebe resumo,
-- '[]' = todos os grupos, '[ids]' = esses blocos. avisos: lista com 'lotacao' e/ou 'erro'.
CREATE TABLE IF NOT EXISTS aviso_destinos (
  id INTEGER PRIMARY KEY, nome TEXT NOT NULL, jid TEXT NOT NULL UNIQUE,
  resumo_blocos TEXT, avisos TEXT NOT NULL DEFAULT '[]', ativo INTEGER NOT NULL DEFAULT 1, created_at INTEGER);
-- Conexões por loja. segredos nunca sai em SELECT de listagem.
CREATE TABLE IF NOT EXISTS conexoes (
  plataforma TEXT PRIMARY KEY, config TEXT NOT NULL DEFAULT '{}', segredos TEXT NOT NULL DEFAULT '{}', updated_at INTEGER);
-- Equipe. email é dado pessoal; o convite guarda só o sha256 do token.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, nome TEXT NOT NULL, email TEXT COLLATE NOCASE UNIQUE,
  senha_hash TEXT NOT NULL, papel TEXT NOT NULL CHECK (papel IN ('dono','operador')), created_at INTEGER, last_login_at INTEGER);
CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, email TEXT NOT NULL COLLATE NOCASE,
  papel TEXT NOT NULL CHECK (papel IN ('dono','operador')), expires_at INTEGER NOT NULL, created_by INTEGER,
  created_at INTEGER, used_at INTEGER, canceled_at INTEGER);
-- Espelhamento de ofertas (Amazon). origem_jids/destino_jids/palavras_bloqueadas: listas JSON. sem_preco: fila|curto.
CREATE TABLE IF NOT EXISTS espelhos (
  id INTEGER PRIMARY KEY, nome TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  origem_jids TEXT NOT NULL DEFAULT '[]', destino_jids TEXT NOT NULL DEFAULT '[]', template_id INTEGER,
  incluir_minhas INTEGER NOT NULL DEFAULT 0, dedupe_horas INTEGER NOT NULL DEFAULT 168,
  palavras_bloqueadas TEXT NOT NULL DEFAULT '[]', sem_preco TEXT NOT NULL DEFAULT 'fila',
  max_por_hora INTEGER NOT NULL DEFAULT 10, janela_inicio TEXT, janela_fim TEXT, enviar_foto INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER, updated_at INTEGER);
-- Um item por link da Amazon visto numa origem. status: recebido|processando|na_fila|enviado|duplicado|descartado|expirado|erro.
-- fonte_dados: api|api+texto|texto|curto|manual. oferta: JSON da oferta. texto_origem vai mascarado e nunca ao navegador.
-- Nunca há participante (autor da mensagem) aqui.
CREATE TABLE IF NOT EXISTS espelho_itens (
  id INTEGER PRIMARY KEY, espelho_id INTEGER NOT NULL, origem_jid TEXT NOT NULL, origem_nome TEXT, msg_id TEXT,
  ts INTEGER NOT NULL, url TEXT NOT NULL, asin TEXT, texto_origem TEXT,
  status TEXT NOT NULL DEFAULT 'recebido', motivo TEXT, fonte_dados TEXT, oferta TEXT,
  envio_id INTEGER, tentativas INTEGER NOT NULL DEFAULT 0, espera_ate INTEGER, decidido_em INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS idx_esp_msg ON espelho_itens (espelho_id, origem_jid, msg_id, url);
CREATE INDEX IF NOT EXISTS idx_esp_dedupe ON espelho_itens (espelho_id, asin, status, decidido_em);
CREATE INDEX IF NOT EXISTS idx_esp_status ON espelho_itens (status, espera_ate, ts);
-- Fonte "catalogo" (API de ofertas do Etiqueta). Uma linha por oferta já tratada numa regra; chave: MLB<n>|ASIN:<asin>|SHOPEE:<shop>.<item>.
-- loja: ml|amazon|shopee. motivos: lista JSON (shopee|desconto_100|preco_antigo|falha_link). oferta: JSON da oferta, sem dado pessoal.
CREATE TABLE IF NOT EXISTS catalogo_itens (
  id INTEGER PRIMARY KEY, rule_id INTEGER NOT NULL, chave TEXT NOT NULL, loja TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('revisao','enviado','descartado')), motivos TEXT NOT NULL DEFAULT '[]',
  oferta TEXT NOT NULL, envio_id INTEGER, criado_em INTEGER NOT NULL, decidido_em INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cat_item ON catalogo_itens (rule_id, chave);
CREATE INDEX IF NOT EXISTS idx_cat_status ON catalogo_itens (status, rule_id, criado_em);
-- listagem da revisão por regra e status, da decisão mais recente (GET /api/catalogo/itens)
CREATE INDEX IF NOT EXISTS idx_cat_lista ON catalogo_itens (rule_id, status, COALESCE(decidido_em, criado_em));
-- Cursor da API por regra e filtro (sha256 do config normalizado, 16 hex). pronto=0: ainda avançando até o fim sem enviar.
CREATE TABLE IF NOT EXISTS catalogo_cursores (
  rule_id INTEGER NOT NULL, filtro TEXT NOT NULL, cursor TEXT, pronto INTEGER NOT NULL DEFAULT 0,
  atualizado_em INTEGER, PRIMARY KEY (rule_id, filtro));
`;

// Colunas acrescentadas depois da primeira versão (ALTER TABLE só se faltar).
const EXTRA_COLUMNS = [
  ['groups', 'invite_code', 'TEXT'],
  ['groups', 'is_admin', 'INTEGER'],
  ['groups', 'description', 'TEXT'],
  ['links', 'auto_next', 'INTEGER DEFAULT 0'],
  ['rules', 'sources', 'TEXT'],
  ['sessions', 'last_seen', 'INTEGER'],
  ['sessions', 'user_id', 'INTEGER'],
];

// "[ … ]" é um pedaço opcional: some sozinho quando algum placeholder dentro dele está vazio (renderTemplate).
// Só vale para instalações novas; quem já tem o template "Padrão" no banco continua com o texto de antes.
export const DEFAULT_TEMPLATE = [
  '*{TITULO_PRODUTO}*',
  '',
  '😱 De ~{PRECO_ANTIGO}~',
  '🔥 Por *{PRECO_PRODUTO}*[ ({DESCONTO_PRODUTO} OFF)]',
  '⭐ {NUMERO_VENDAS}',
  '🚚 {FRETE}',
  '🎟️ Cupom: *{CUPOM}*',
  '',
  '🛒 Compre aqui: {LINK}',
].join('\n');

/** Nome do template "Amazon" (texto em TEMPLATE_AMAZON, de template.js), semeado uma vez por openDb (setting tpl_amazon_seed). */
export const NOME_TEMPLATE_AMAZON = 'Amazon';

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
  for (const [table, col, type] of EXTRA_COLUMNS) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
  if (!db.prepare('SELECT 1 FROM templates LIMIT 1').get()) {
    db.prepare('INSERT INTO templates (name, body, created_at) VALUES (?, ?, ?)')
      .run('Padrão', DEFAULT_TEMPLATE, Date.now());
  }
  semearTemplateAmazon(db);
  if (!getSetting(db, 'ext_token')) setSetting(db, 'ext_token', crypto.randomBytes(24).toString('hex'));
  return db;
}

/**
 * Cria o template "Amazon" uma única vez por banco, em instalação nova ou antiga. A marca tpl_amazon_seed
 * (id do template criado) impede recriar: se o dono apagar ou renomear o template, ele não volta.
 */
function semearTemplateAmazon(db) {
  if (getSetting(db, 'tpl_amazon_seed') !== null) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (getSetting(db, 'tpl_amazon_seed') === null) {
      const { lastInsertRowid } = db.prepare('INSERT INTO templates (name, body, created_at) VALUES (?, ?, ?)')
        .run(NOME_TEMPLATE_AMAZON, TEMPLATE_AMAZON, Date.now());
      setSetting(db, 'tpl_amazon_seed', Number(lastInsertRowid));
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function getSetting(db, key, def = null) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : def;
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

export const MAX_SOURCES = 5;
/** Fontes da regra (até 5). Regras antigas, com uma fonte só, viram uma lista de um item. */
function parseSources(r) {
  let list = null;
  try { list = JSON.parse(r.sources || 'null'); } catch { /* inválido: usa a fonte única */ }
  if (Array.isArray(list) && list.length) return list.slice(0, MAX_SOURCES).map((s) => ({ type: s.type || 'list', config: s.config || {}, tag_id: s.tag_id ?? null }));
  return [{ type: r.source_type || 'list', config: JSON.parse(r.source_config || '{}'), tag_id: null }];
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
    sources: parseSources(r),
  };
}

const MAX_MENSAGEM_LOG = 1000; // erro de biblioteca ou da extensão pode vir enorme: o histórico guarda só o começo

export function addLog(db, { rule, level = 'info', group_name = null, offer_title = null, message }) {
  const msg = message == null ? null : String(message).slice(0, MAX_MENSAGEM_LOG);
  db.prepare('INSERT INTO log (ts, rule_id, rule_name, level, group_name, offer_title, message) VALUES (?,?,?,?,?,?,?)')
    .run(Date.now(), rule?.id ?? null, rule?.name ?? null, level, group_name, offer_title, msg);
  // mantém o histórico enxuto
  db.prepare('DELETE FROM log WHERE id < (SELECT MAX(id) FROM log) - 5000').run();
}
