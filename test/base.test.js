// Base das features novas (plano disparos-comunicacao-conta): esquema aditivo e idempotente em src/db.js (etapa 1);
// agendador único, módulos novos com a interface final e ganchos do servidor (etapa 5).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { openDb, getSetting, setSetting, addLog } from '../src/db.js';
import { createScheduler, sleep, jitter } from '../src/scheduler.js';
import * as util from '../src/util.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createLinkService } from '../src/links.js';
import { buildApp } from '../src/server.js';
import * as mlReal from '../src/ml.js';
import { IMAGEM_AMAZON } from '../src/amazon.js';
import * as envios from '../src/envios.js';
import * as avisos from '../src/avisos.js';
import * as conexoes from '../src/conexoes.js';
import * as equipe from '../src/equipe.js';

// pastas temporárias apagadas no fim do arquivo
const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-base-')); pastas.push(p); return p; };
/** Linhas como objetos comuns (o node:sqlite devolve objetos sem protótipo). */
const linhas = (db, sql) => db.prepare(sql).all().map((r) => ({ ...r }));
const colunas = (db, tabela) => db.prepare(`PRAGMA table_info(${tabela})`).all().map((c) => c.name);
const existe = (db, tipo, nome) => !!db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get(tipo, nome);

const TABELAS_NOVAS = {
  envios: ['id', 'tipo', 'payload', 'group_jids', 'quando', 'repetir', 'status', 'next_run_at', 'last_run_at', 'resultado', 'user_id', 'created_at'],
  envio_resultados: ['id', 'envio_id', 'ocorrencia', 'ts', 'jid', 'group_name', 'ok', 'erro'],
  aviso_destinos: ['id', 'nome', 'jid', 'resumo_blocos', 'avisos', 'ativo', 'created_at'],
  conexoes: ['plataforma', 'config', 'segredos', 'updated_at'],
  users: ['id', 'nome', 'email', 'senha_hash', 'papel', 'created_at', 'last_login_at'],
  invites: ['id', 'token_hash', 'email', 'papel', 'expires_at', 'created_by', 'created_at', 'used_at', 'canceled_at'],
};
const INDICES_NOVOS = { idx_envios_fila: ['envios', ['status', 'next_run_at']], idx_envio_res: ['envio_resultados', ['envio_id', 'ocorrencia']] };

test('esquema: openDb duas vezes no mesmo diretório não falha nem duplica nada', () => {
  const dir = tmp();
  const db1 = openDb(dir);
  const esquema1 = linhas(db1, 'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name');
  const token = getSetting(db1, 'ext_token');
  db1.close();

  const db2 = openDb(dir);
  assert.deepEqual(linhas(db2, 'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name'), esquema1, 'a segunda abertura não cria nem altera nada');
  assert.equal(colunas(db2, 'sessions').filter((c) => c === 'user_id').length, 1);
  // A semente "Amazon" entrou em 02/11/2026 (etapa 1 do plano espelhamento-amazon): aqui conta só o Padrão.
  assert.equal(db2.prepare("SELECT COUNT(*) AS n FROM templates WHERE name = 'Padrão'").get().n, 1, 'template padrão não é semeado de novo');
  assert.equal(db2.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'ext_token'").get().n, 1);
  assert.equal(getSetting(db2, 'ext_token'), token, 'o token da extensão não muda ao reabrir');
  db2.close();
});

test('esquema: tabelas novas, índices da fila e sessions.user_id existem', () => {
  const db = openDb(tmp());
  for (const [tabela, cols] of Object.entries(TABELAS_NOVAS)) {
    assert.ok(existe(db, 'table', tabela), `tabela ${tabela}`);
    assert.deepEqual(colunas(db, tabela), cols, `colunas de ${tabela}`);
  }
  for (const [indice, [tabela, cols]] of Object.entries(INDICES_NOVOS)) {
    assert.equal(db.prepare("SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = ?").get(indice)?.tbl_name, tabela, `índice ${indice}`);
    assert.deepEqual(db.prepare(`PRAGMA index_info(${indice})`).all().map((c) => c.name), cols, `colunas de ${indice}`);
  }
  const userId = db.prepare('PRAGMA table_info(sessions)').all().find((c) => c.name === 'user_id');
  assert.equal(userId?.type, 'INTEGER');
  assert.equal(userId.notnull, 0, 'sessões antigas ficam com user_id nulo');
  db.close();
});

test('esquema: banco da versão anterior reabre com os dados intactos e ganha tabelas e coluna novas', () => {
  const dir = tmp();
  // Banco como o do serviço antes desta etapa: SCHEMA anterior com as EXTRA_COLUMNS de então já aplicadas.
  const velho = new DatabaseSync(path.join(dir, 'disparador.db'));
  velho.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, note TEXT DEFAULT '', created_at INTEGER);
    CREATE TABLE templates (id INTEGER PRIMARY KEY, name TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER);
    CREATE TABLE groups (jid TEXT PRIMARY KEY, name TEXT, size INTEGER, updated_at INTEGER,
      invite_code TEXT, is_admin INTEGER, description TEXT);
    CREATE TABLE rules (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER DEFAULT 1,
      tag_id INTEGER, template_id INTEGER, group_jids TEXT DEFAULT '[]',
      source_type TEXT DEFAULT 'list', source_config TEXT DEFAULT '{}',
      min_price REAL, max_price REAL, min_discount REAL,
      per_run INTEGER DEFAULT 3, interval_min INTEGER DEFAULT 60,
      window_start TEXT DEFAULT '08:00', window_end TEXT DEFAULT '22:00',
      dedupe_days INTEGER DEFAULT 7, send_image INTEGER DEFAULT 1,
      next_run_at INTEGER, last_run_at INTEGER, created_at INTEGER, sources TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, created_at INTEGER, expires_at INTEGER, ip TEXT, last_seen INTEGER);
    INSERT INTO settings (key, value) VALUES ('ext_token', 'token-antigo'), ('panel_password_hash', 'scrypt$hash-antigo'), ('delay_group_s', '9');
    INSERT INTO tags (id, name, created_at) VALUES (1, 'etiqueta1', 1);
    INSERT INTO templates (id, name, body, created_at) VALUES (7, 'Meu template', '{TITULO_PRODUTO} {LINK}', 1);
    INSERT INTO groups (jid, name, size, updated_at, invite_code, is_admin) VALUES ('g1@g.us', 'Grupo 1', 250, 1, 'abc', 1);
    INSERT INTO rules (id, name, tag_id, template_id, group_jids, sources, next_run_at, created_at)
      VALUES (3, 'Regra', 1, 7, '["g1@g.us"]', '[{"type":"list","config":{}}]', 1730000000000, 1);
    INSERT INTO sessions (id, created_at, expires_at, ip, last_seen) VALUES ('${'a'.repeat(64)}', 1, 9999999999999, '127.0.0.1', 2);
  `);
  const antes = {};
  for (const t of ['settings', 'tags', 'templates', 'groups', 'rules', 'sessions']) antes[t] = linhas(velho, `SELECT * FROM ${t} ORDER BY rowid`);
  assert.ok(!existe(velho, 'table', 'users') && !colunas(velho, 'sessions').includes('user_id'), 'o banco simulado é mesmo o antigo');
  velho.close();

  for (let abertura = 1; abertura <= 2; abertura++) {
    const db = openDb(dir);
    // A semente "Amazon" entrou em 02/11/2026 (etapa 1 do plano espelhamento-amazon): fora a marca e o template dela, nada muda.
    const semSemente = { settings: " WHERE key <> 'tpl_amazon_seed'", templates: " WHERE name <> 'Amazon'" };
    for (const t of ['settings', 'tags', 'templates', 'groups', 'rules']) {
      assert.deepEqual(linhas(db, `SELECT * FROM ${t}${semSemente[t] || ''} ORDER BY rowid`), antes[t], `${t} intacta (abertura ${abertura})`);
    }
    assert.deepEqual(linhas(db, 'SELECT * FROM sessions ORDER BY rowid'), antes.sessions.map((s) => ({ ...s, user_id: null })), `sessão aberta continua, com user_id nulo (abertura ${abertura})`);
    for (const tabela of Object.keys(TABELAS_NOVAS)) assert.ok(existe(db, 'table', tabela), `tabela ${tabela} criada (abertura ${abertura})`);
    for (const indice of Object.keys(INDICES_NOVOS)) assert.ok(existe(db, 'index', indice), `índice ${indice} criado (abertura ${abertura})`);
    for (const tabela of Object.keys(TABELAS_NOVAS)) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${tabela}`).get().n, 0, `${tabela} nasce vazia`);
    db.close();
  }
});

test('users e invites: papel só dono ou operador; e-mail único sem distinção de caixa', () => {
  const db = openDb(tmp());
  const novoUser = db.prepare('INSERT INTO users (nome, email, senha_hash, papel, created_at) VALUES (?, ?, ?, ?, 1)');
  const novoConvite = db.prepare('INSERT INTO invites (token_hash, email, papel, expires_at, created_at) VALUES (?, ?, ?, ?, 1)');

  novoUser.run('Dono', null, 'h', 'dono'); // o Dono migrado da senha única não tem e-mail
  novoUser.run('Ana', 'Ana@Exemplo.com', 'h', 'operador');
  for (const papel of ['admin', 'Dono', 'OPERADOR', '']) {
    assert.throws(() => novoUser.run('X', `x-${papel}@exemplo.com`, 'h', papel), /CHECK constraint failed/, `users recusa papel "${papel}"`);
    assert.throws(() => novoConvite.run(`t-${papel}`, 'x@exemplo.com', papel, 2), /CHECK constraint failed/, `invites recusa papel "${papel}"`);
  }
  assert.throws(() => novoUser.run('X', 'x@exemplo.com', 'h', null), /NOT NULL constraint failed: users\.papel/);

  assert.throws(() => novoUser.run('Outra Ana', 'ana@exemplo.COM', 'h', 'operador'), /UNIQUE constraint failed: users\.email/);
  assert.equal(db.prepare('SELECT nome FROM users WHERE email = ?').get('ANA@EXEMPLO.COM')?.nome, 'Ana', 'busca por e-mail ignora a caixa');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2);

  novoConvite.run('hash1', 'Bia@Exemplo.com', 'operador', 2);
  assert.equal(db.prepare('SELECT token_hash FROM invites WHERE email = ?').get('bia@exemplo.com')?.token_hash, 'hash1', 'e-mail do convite também ignora a caixa');
  assert.throws(() => novoConvite.run('hash1', 'c@exemplo.com', 'dono', 2), /UNIQUE constraint failed: invites\.token_hash/);
  db.close();
});

test('tabelas novas: valores padrão e unicidade', () => {
  const db = openDb(tmp());
  const { lastInsertRowid } = db.prepare("INSERT INTO envios (tipo, created_at) VALUES ('mensagem', 1)").run();
  assert.deepEqual({ ...db.prepare('SELECT payload, group_jids, quando, repetir, status, next_run_at FROM envios WHERE id = ?').get(lastInsertRowid) },
    { payload: '{}', group_jids: '[]', quando: 'agora', repetir: null, status: 'pendente', next_run_at: null });
  assert.throws(() => db.prepare('INSERT INTO envios (created_at) VALUES (1)').run(), /NOT NULL constraint failed: envios\.tipo/);
  assert.throws(() => db.prepare('INSERT INTO envio_resultados (envio_id, ocorrencia) VALUES (1, 1)').run(), /NOT NULL constraint failed: envio_resultados\.ok/);

  db.prepare("INSERT INTO aviso_destinos (nome, jid) VALUES ('Eu', '5511900000000@s.whatsapp.net')").run();
  assert.deepEqual({ ...db.prepare('SELECT resumo_blocos, avisos, ativo FROM aviso_destinos').get() }, { resumo_blocos: null, avisos: '[]', ativo: 1 });
  assert.throws(() => db.prepare("INSERT INTO aviso_destinos (nome, jid) VALUES ('Outro', '5511900000000@s.whatsapp.net')").run(), /UNIQUE constraint failed: aviso_destinos\.jid/);

  db.prepare("INSERT INTO conexoes (plataforma) VALUES ('amazon')").run();
  assert.deepEqual({ ...db.prepare('SELECT config, segredos FROM conexoes').get() }, { config: '{}', segredos: '{}' });
  assert.throws(() => db.prepare("INSERT INTO conexoes (plataforma) VALUES ('amazon')").run(), /UNIQUE constraint failed: conexoes\.plataforma/);
  db.close();
});

test('S13: addLog guarda no máximo 1000 letras da mensagem (erro enorme de biblioteca ou da extensão)', () => {
  const db = openDb(tmp());
  addLog(db, { rule: { id: null, name: 'R' }, level: 'erro', message: 'x'.repeat(1024 * 1024) });
  addLog(db, { rule: null, level: 'info', message: 'curta' });
  addLog(db, { rule: null, level: 'info', message: null });
  assert.deepEqual(linhas(db, 'SELECT length(message) AS n FROM log ORDER BY id').map((l) => l.n), [1000, 5, null]);
  db.close();
});

// ---------- etapa 5: agendador único ----------
const ITENS = [
  'https://produto.mercadolivre.com.br/MLB-1000001-a | Fone A | 50 | 100',
  'https://produto.mercadolivre.com.br/MLB-1000002-b | Mouse B | 30 | 40',
].join('\n');

/** Agendador em modo simulado (WhatsApp falso, links meli.la/fake-…), com dois grupos e a etiqueta 1. */
function montarAgendador({ ml } = {}) {
  const dir = tmp(); const db = openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const scheduler = createScheduler({ db, wa, links, fast: true, dir, ...(ml ? { ml } : {}) });
  for (const [jid, nome] of [['111@g.us', 'Achadinhos'], ['222@g.us', 'Tech']]) {
    db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, nome, 10, Date.now());
  }
  db.prepare("INSERT INTO tags (name, created_at) VALUES ('etiquetaA', 1)").run();
  return { dir, db, wa, links, scheduler };
}
/** Regra de lista de links com o template padrão, aberta o dia todo (janela 00:00–00:00). */
const novaRegra = (db, { name, groups = ['111@g.us'], per = 1, enabled = 1, next_run_at = null }) => db.prepare(`INSERT INTO rules
  (name, enabled, tag_id, template_id, group_jids, source_type, source_config, per_run, interval_min, window_start, window_end, dedupe_days, send_image, next_run_at, created_at)
  VALUES (?, ?, 1, 1, ?, 'list', ?, ?, 60, '00:00', '00:00', 7, 1, ?, 1)`)
  .run(name, enabled, JSON.stringify(groups), JSON.stringify({ items: ITENS }), per, next_run_at).lastInsertRowid;

test('agendador: expõe envios e avisos com a interface final; módulos novos exportam montarRotas; sleep e jitter exportados', async () => {
  const { db, scheduler } = montarAgendador();
  for (const f of ['criar', 'processarPendentes', 'runEnvio', 'recuperar', 'cancelar', 'pausar', 'retomar', 'painel', 'limpar']) {
    assert.equal(typeof scheduler.envios[f], 'function', `envios.${f}`);
  }
  for (const f of ['tick', 'montarResumo', 'enviarResumo']) assert.equal(typeof scheduler.avisos[f], 'function', `avisos.${f}`);
  assert.equal(typeof envios.createEnvios, 'function');
  assert.equal(typeof envios.proximaOcorrencia, 'function');
  assert.equal(typeof avisos.createAvisos, 'function');
  for (const [nome, m] of Object.entries({ envios, avisos, conexoes, equipe })) assert.equal(typeof m.montarRotas, 'function', `${nome}.montarRotas`);

  assert.equal(jitter(0), 0);
  assert.deepEqual([sleep, jitter], [util.sleep, util.jitter], 'R14: moram em src/util.js; o agendador só reexporta');
  for (let i = 0; i < 50; i++) { const j = jitter(10); assert.ok(j >= 7000 && j <= 13000, `jitter(10) = ${j} fora de ±30%`); }
  const t0 = Date.now(); await sleep(20);
  assert.ok(Date.now() - t0 >= 15, 'sleep espera');
  db.close();
});

test('agendador: o tick roda envios → avisos → regras, e os envios de novo depois de cada regra', async () => {
  const ordem = [];
  // espião nas regras: cada runRule busca os candidatos uma vez
  const ml = { ...mlReal, candidates: (rule, deps) => { ordem.push(`regra ${rule.name}`); return mlReal.candidates(rule, deps); } };
  const { db, wa, scheduler } = montarAgendador({ ml });
  novaRegra(db, { name: 'A' });
  novaRegra(db, { name: 'Desligada', enabled: 0 });
  novaRegra(db, { name: 'Mais tarde', next_run_at: Date.now() + 3600000 });
  novaRegra(db, { name: 'B', groups: ['222@g.us'] });
  scheduler.envios.processarPendentes = async () => { ordem.push(`envios (${wa.simulated.length} enviadas)`); };
  scheduler.avisos.tick = async () => { ordem.push('avisos'); };

  await scheduler.tick();
  assert.deepEqual(ordem, ['envios (0 enviadas)', 'avisos', 'regra A', 'envios (1 enviadas)', 'regra B', 'envios (2 enviadas)']);
  assert.deepEqual(wa.simulated.map((m) => m.jid), ['111@g.us', '222@g.us']);
  assert.ok(wa.simulated.every((m) => m.text.includes('https://meli.la/fake-etiquetaA-')), 'as regras enviam como antes');
  db.close();
});

test('agendador: falha em envios ou avisos não impede as regras', async (t) => {
  const erros = t.mock.method(console, 'error', () => {});
  const { db, wa, scheduler } = montarAgendador();
  novaRegra(db, { name: 'A' });
  scheduler.envios.processarPendentes = async () => { throw new Error('envios quebrou'); };
  scheduler.avisos.tick = () => { throw new Error('avisos quebrou'); }; // até o erro síncrono é contido

  await scheduler.tick();
  assert.equal(wa.simulated.length, 1, 'a regra enviou mesmo assim');
  assert.deepEqual(erros.mock.calls.map((c) => c.arguments.join(' ')),
    ['[agendador] envios: envios quebrou', '[agendador] avisos: avisos quebrou', '[agendador] envios: envios quebrou']);
  await scheduler.tick(); // e o agendador não ficou travado
  db.close();
});

test('agendador: start() chama envios.recuperar() antes do primeiro tick', async () => {
  const { db, scheduler } = montarAgendador();
  const ordem = []; let liberar;
  scheduler.envios.recuperar = () => { ordem.push('recuperar'); return new Promise((r) => { liberar = r; }); };
  scheduler.envios.processarPendentes = async () => { ordem.push('envios'); };
  scheduler.avisos.tick = async () => { ordem.push('avisos'); };
  scheduler.start();
  try {
    assert.deepEqual(ordem, ['recuperar'], 'chamado já no start');
    scheduler.start(); // de novo: não repete
    const tick = scheduler.tick();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(ordem, ['recuperar'], 'o tick espera o recuperar terminar');
    liberar(); await tick;
    assert.deepEqual(ordem, ['recuperar', 'envios', 'avisos']);
  } finally { scheduler.stop(); db.close(); }
});

test('agendador: regras seguem iguais (runRule em modo simulado) e o tick sem nada vencido não envia', async () => {
  const { db, wa, scheduler } = montarAgendador();
  const id = novaRegra(db, { name: 'Tech', groups: ['111@g.us', '222@g.us'], per: 2 });
  const r = await scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages, r.errors], [2, 4, 0]);
  assert.equal(wa.simulated.length, 4);
  assert.ok(wa.simulated.every((m) => m.tipo === 'text' && m.text.includes('https://meli.la/fake-etiquetaA-')), 'texto com o link da etiqueta da regra');
  assert.deepEqual([...new Set(wa.simulated.map((m) => m.jid))].sort(), ['111@g.us', '222@g.us']);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM log WHERE level = 'ok' AND rule_name = 'Tech'").get().n, 4);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sent_offers WHERE rule_id = ?').get(id).n, 2);
  assert.ok(db.prepare('SELECT next_run_at FROM rules WHERE id = ?').get(id).next_run_at > Date.now() + 59 * 60000, 'próximo envio em ~60 min');

  await scheduler.tick(); // regra ainda não venceu e a fila de envios está vazia
  assert.equal(wa.simulated.length, 4);
  db.close();
});

test('proximaOcorrencia: próximo dia e horário da repetição, na hora local', () => {
  const t = (dia, h, m = 0) => new Date(2026, 10, dia, h, m).getTime(); // novembro de 2026: o dia 2 é segunda-feira
  const todos = [0, 1, 2, 3, 4, 5, 6];
  const p = envios.proximaOcorrencia;
  assert.equal(p({ dias: todos, horarios: ['09:00', '18:30'] }, t(2, 10)), t(2, 18, 30), 'hoje mais tarde');
  assert.equal(p({ dias: todos, horarios: ['09:00'] }, t(2, 10)), t(3, 9), 'amanhã');
  assert.equal(p({ dias: [3, 5], horarios: ['07:15'] }, t(2, 10)), t(4, 7, 15), 'próximo dia marcado (quarta)');
  assert.equal(p({ dias: [1], horarios: ['09:00'] }, t(2, 10)), t(9, 9), 'só segunda: a da semana que vem');
  assert.equal(p({ dias: [1], horarios: ['09:00'] }, t(2, 9)), t(9, 9), 'no horário exato conta como passado');
  assert.equal(p({ dias: [1], horarios: ['09:00'] }, t(2, 8, 59)), t(2, 9), 'um minuto antes: hoje');
  assert.equal(p({ dias: todos, horarios: ['21:00', '08:00', '12:15'] }, t(2, 10)), t(2, 12, 15), 'horários fora de ordem');
  assert.equal(p({ dias: todos, horarios: ['21:00', '08:00', '12:15'] }, t(2, 7)), t(2, 8), 'horários fora de ordem, antes do primeiro');
  assert.equal(p({ dias: todos, horarios: ['21:00', '08:00', '12:15'] }, t(2, 22)), t(3, 8), 'depois do último: o primeiro de amanhã');
  assert.equal(p({ dias: [5], horarios: ['00:30'] }, new Date(2026, 11, 31, 23).getTime()), new Date(2027, 0, 1, 0, 30).getTime(), 'vira o ano');
  assert.equal(p({ dias: [1], horarios: ['9:05', 'lixo', '25:00'] }, t(2, 9)), t(2, 9, 5), 'hora de um dígito vale; inválidas são ignoradas');
  const agora = Date.now(); const prox = p({ dias: todos, horarios: ['00:00'] });
  assert.ok(prox > agora && prox <= agora + 25 * 3600000, 'sem depoisDe: a partir de agora');
  for (const vazio of [{ dias: [], horarios: ['09:00'] }, { dias: todos, horarios: [] }, {}, null, undefined,
    { dias: [7, -1, 1.5, '1'], horarios: ['09:00'] }, { dias: todos, horarios: ['24:00', '9h', '12:60', 900] }]) {
    assert.equal(p(vazio, t(2, 10)), null, `sem dia ou horário válido: ${JSON.stringify(vazio)}`);
  }
  assert.equal(p({ dias: todos, horarios: ['09:00'] }, NaN), null, 'depoisDe inválido');
});

// ---------- etapa 5: ganchos do servidor ----------
const SENHA = 'senha-de-teste-123';
function subir() {
  const { dir, db, wa, links, scheduler } = montarAgendador();
  const app = buildApp({ db, wa, links, scheduler, publicHost: 'painel.exemplo.com', panelPassword: SENHA, dataDir: dir, ml: mlReal });
  return new Promise((ok) => {
    const server = app.listen(0, '127.0.0.1', () => ok({
      db, port: server.address().port,
      fechar: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => { db.close(); r(); }); }),
    }));
  });
}
function req(port, caminho, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((ok, err) => {
    const data = body != null ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, path: caminho, method, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let txt = ''; res.setEncoding('utf8'); res.on('data', (c) => (txt += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(txt); } catch { /* html */ } ok({ status: res.statusCode, headers: res.headers, json, txt }); });
    });
    r.on('error', err); if (data) r.write(data); r.end();
  });
}
/** Entra com a senha e devolve o cookie de sessão ("sid=…"). */
const entrar = async (port) => String((await req(port, '/api/login', { method: 'POST', body: { senha: SENHA } })).headers['set-cookie']?.[0] || '').split(';')[0];

test('servidor: /api/state traz o usuario da sessão (Dono migrado, sem e-mail) e conta_nome', async () => {
  const s = await subir();
  try {
    const cookie = await entrar(s.port);
    assert.match(cookie, /^sid=/);
    const st = await req(s.port, '/api/state', { headers: { cookie } });
    assert.equal(st.status, 200);
    assert.deepEqual(st.json.usuario, { id: 1, nome: 'Dono', email: null, papel: 'dono', precisa_completar: true });
    assert.equal(st.json.conta_nome, '', 'sem nome de conta: vazio');
    assert.equal(st.json.auth, true, 'o resto do estado continua');
    setSetting(s.db, 'conta_nome', 'Achadinhos da Ana');
    assert.equal((await req(s.port, '/api/state', { headers: { cookie } })).json.conta_nome, 'Achadinhos da Ana');
  } finally { await s.fechar(); }
});

test('servidor: a CSP libera as fotos de produto dos CDNs do Mercado Livre e da Amazon (como IMAGEM_PERMITIDA e IMAGEM_AMAZON) e nada mais de fora', async () => {
  const s = await subir();
  try {
    const csp = (await req(s.port, '/login.html')).headers['content-security-policy'];
    const img = csp.split(';').map((p) => p.trim()).find((p) => p.startsWith('img-src'));
    assert.equal(img, "img-src 'self' data: https://*.mlstatic.com https://*.media-amazon.com https://*.ssl-images-amazon.com https://*.images-amazon.com");
    assert.equal(csp.split(';').map((p) => p.trim()).find((p) => p.startsWith('connect-src')), "connect-src 'self'", 'nenhum connect-src de fora');
    assert.ok(mlReal.IMAGEM_PERMITIDA.test('https://http2.mlstatic.com/D_1.jpg') && !mlReal.IMAGEM_PERMITIDA.test('https://evil.com/mlstatic.com/x.jpg'));
    // cada host da Amazon liberado na CSP é um que a regra do servidor aceita para a foto
    for (const h of ['m.media-amazon.com', 'images-na.ssl-images-amazon.com', 'g-ecx.images-amazon.com']) assert.ok(IMAGEM_AMAZON.test(`https://${h}/images/I/1.jpg`), h);
  } finally { await s.fechar(); }
});

// Rotas do plano que os módulos novos já montam (as públicas de convite/login entram na etapa 7).
// Enquanto stub, respondem 501. As etapas 7, 8, 10, 11 e 12 as implementam sem precisar mexer aqui: o que este teste
// exige depois disso continua valendo (rota montada, atrás do Host/Origin e do login).
const ROTAS_STUB = [
  ['POST', '/api/disparo/identificar'], ['GET', '/api/envios?tipo=oferta'], ['POST', '/api/envios'],
  ['POST', '/api/envios/1/cancelar'], ['POST', '/api/envios/1/pausar'], ['POST', '/api/envios/1/retomar'],
  ['POST', '/api/uploads'], ['GET', '/api/uploads/abc'],
  ['GET', '/api/avisos'], ['GET', '/api/avisos/destinos'], ['POST', '/api/avisos/destinos'], ['PUT', '/api/avisos/destinos/1'],
  ['DELETE', '/api/avisos/destinos/1'], ['PUT', '/api/avisos/config'], ['GET', '/api/avisos/previa?destino=1'], ['POST', '/api/avisos/resumo-agora'],
  ['GET', '/api/conexoes'], ['PUT', '/api/conexoes/amazon'], ['POST', '/api/conexoes/amazon/testar'],
  ['PUT', '/api/me'], ['GET', '/api/equipe'], ['PUT', '/api/equipe/conta'], ['POST', '/api/equipe/convites'],
  ['POST', '/api/equipe/convites/1/link'], ['DELETE', '/api/equipe/convites/1'], ['PUT', '/api/equipe/pessoas/1'], ['DELETE', '/api/equipe/pessoas/1'],
];

test('servidor: rotas dos módulos novos montadas atrás do Host/Origin e do login; os stubs respondem 501', async (t) => {
  const s = await subir();
  try {
    const cookie = await entrar(s.port);
    const daCasa = { cookie, origin: `http://127.0.0.1:${s.port}` };
    let stubs = 0;
    for (const [method, caminho] of ROTAS_STUB) {
      const rota = `${method} ${caminho}`;
      const body = ['POST', 'PUT'].includes(method) ? {} : undefined;
      const r = await req(s.port, caminho, { method, headers: daCasa, body });
      assert.doesNotMatch(r.txt, /Cannot (GET|POST|PUT|DELETE)/, `${rota}: montada (não caiu no 404 do Express)`);
      assert.ok(r.status === 501 || (r.status < 500 && ![401, 403].includes(r.status)), `${rota}: com login responde ${r.status}`);
      if (r.status === 501) { stubs++; assert.deepEqual(r.json, { erro: 'ainda não implementado' }, `${rota}: stub`); }
      assert.equal((await req(s.port, caminho, { method, body })).status, 401, `${rota} sem login`);
      assert.equal((await req(s.port, caminho, { method, headers: { ...daCasa, origin: 'https://outro-site.com' }, body })).status, 403, `${rota} de outra origem`);
    }
    t.diagnostic(`${stubs} de ${ROTAS_STUB.length} rotas ainda em stub (501)`);
  } finally { await s.fechar(); }
});

// ---------------------------------------------------------------------------------------------
// Espelhamento Amazon, etapa 1 (docs/produto/planos/espelhamento-amazon.md, CA8): tabelas espelhos e
// espelho_itens, índices, semente única do template "Amazon" e DEFAULT_TEMPLATE com pedaço opcional "[ … ]".
const dbMod = await import('../src/db.js');
const { TEMPLATE_AMAZON } = await import('../src/template.js');

const TABELAS_ESPELHO = {
  espelhos: ['id', 'nome', 'enabled', 'origem_jids', 'destino_jids', 'template_id', 'incluir_minhas', 'dedupe_horas',
    'palavras_bloqueadas', 'sem_preco', 'max_por_hora', 'janela_inicio', 'janela_fim', 'enviar_foto', 'created_at', 'updated_at'],
  espelho_itens: ['id', 'espelho_id', 'origem_jid', 'origem_nome', 'msg_id', 'ts', 'url', 'asin', 'texto_origem',
    'status', 'motivo', 'fonte_dados', 'oferta', 'envio_id', 'tentativas', 'espera_ate', 'decidido_em'],
};
const INDICES_ESPELHO = {
  idx_esp_msg: [['espelho_id', 'origem_jid', 'msg_id', 'url'], 1],
  idx_esp_dedupe: [['espelho_id', 'asin', 'status', 'decidido_em'], 0],
  idx_esp_status: [['status', 'espera_ate', 'ts'], 0],
};
const TEXTO_AMAZON = [
  '*{TITULO_PRODUTO}*', '', '😱 De ~{PRECO_ANTIGO}~', '🔥 Por *{PRECO_PRODUTO}*[ ({DESCONTO_PRODUTO} OFF)]',
  '🚚 {FRETE}', '🎟️ Cupom: *{CUPOM}*', '', '🛒 Compre aqui: {LINK}',
].join('\n');
const DEFAULT_ANTERIOR = [
  '*{TITULO_PRODUTO}*', '', '😱 De ~{PRECO_ANTIGO}~', '🔥 Por *{PRECO_PRODUTO}* ({DESCONTO_PRODUTO} OFF)',
  '⭐ {NUMERO_VENDAS}', '🚚 {FRETE}', '🎟️ Cupom: *{CUPOM}*', '', '🛒 Compre aqui: {LINK}',
].join('\n');
const templatesAmazon = (db) => linhas(db, "SELECT id, name, body FROM templates WHERE name = 'Amazon'");

function conferirTabelasEspelho(db, quando) {
  for (const [tabela, cols] of Object.entries(TABELAS_ESPELHO)) {
    assert.ok(existe(db, 'table', tabela), `tabela ${tabela} (${quando})`);
    assert.deepEqual(colunas(db, tabela), cols, `colunas de ${tabela} (${quando})`);
  }
  for (const [indice, [cols, unico]] of Object.entries(INDICES_ESPELHO)) {
    assert.equal(db.prepare("SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = ?").get(indice)?.tbl_name, 'espelho_itens', `índice ${indice} (${quando})`);
    assert.deepEqual(db.prepare(`PRAGMA index_info(${indice})`).all().map((c) => c.name), cols, `colunas de ${indice} (${quando})`);
    assert.equal(db.prepare('PRAGMA index_list(espelho_itens)').all().find((i) => i.name === indice)?.unique, unico, `${indice} ${unico ? 'é' : 'não é'} único (${quando})`);
  }
}

test('espelho etapa 1: banco novo tem espelhos, espelho_itens, índices e um único template "Amazon"; reabrir não muda nada', () => {
  const dir = tmp();
  const db1 = openDb(dir);
  conferirTabelasEspelho(db1, 'primeira abertura');
  const amazon = templatesAmazon(db1);
  assert.equal(amazon.length, 1, 'template "Amazon" semeado');
  assert.equal(amazon[0].body, TEXTO_AMAZON, 'texto do brief com o desconto como pedaço opcional');
  assert.equal(TEMPLATE_AMAZON, TEXTO_AMAZON, 'a semente usa o TEMPLATE_AMAZON de template.js');
  assert.equal(getSetting(db1, 'tpl_amazon_seed'), String(amazon[0].id), 'a marca guarda o id do template semeado');
  assert.deepEqual(linhas(db1, 'SELECT name FROM templates ORDER BY id').map((t) => t.name), ['Padrão', 'Amazon'], 'Padrão continua sendo o primeiro (id 1)');
  const esquema = linhas(db1, 'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name');
  const templates = linhas(db1, 'SELECT * FROM templates ORDER BY id');
  db1.close();

  const db2 = openDb(dir);
  conferirTabelasEspelho(db2, 'segunda abertura');
  assert.deepEqual(linhas(db2, 'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name'), esquema, 'reabrir não cria nem altera nada');
  assert.deepEqual(linhas(db2, 'SELECT * FROM templates ORDER BY id'), templates, 'a semente não duplica');
  assert.equal(db2.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'tpl_amazon_seed'").get().n, 1);
  for (const tabela of Object.keys(TABELAS_ESPELHO)) assert.equal(db2.prepare(`SELECT COUNT(*) AS n FROM ${tabela}`).get().n, 0, `${tabela} nasce vazia`);
  db2.close();
});

test('espelho etapa 1: template "Amazon" apagado ou renomeado pelo dono não volta ao reabrir', () => {
  const dir = tmp();
  let db = openDb(dir);
  const id = templatesAmazon(db)[0].id;
  db.prepare("UPDATE templates SET name = 'Minha Amazon', body = '{TITULO_PRODUTO} {LINK}' WHERE id = ?").run(id);
  db.close();
  db = openDb(dir);
  assert.equal(templatesAmazon(db).length, 0, 'renomeado: não cria outro "Amazon"');
  assert.equal(db.prepare('SELECT body FROM templates WHERE id = ?').get(id).body, '{TITULO_PRODUTO} {LINK}', 'a edição do dono fica');
  db.prepare('DELETE FROM templates WHERE id = ?').run(id);
  db.close();
  db = openDb(dir);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM templates').get().n, 1, 'apagado: fica só o Padrão');
  assert.equal(getSetting(db, 'tpl_amazon_seed'), String(id), 'a marca continua');
  db.close();
});

test('espelho etapa 1: banco da versão anterior (sem as tabelas de espelho) migra com os dados intactos', () => {
  const dir = tmp();
  // Banco como o do serviço antes desta etapa: esquema atual sem espelhos/espelho_itens/índices, sem a semente
  // e com o template "Padrão" no texto antigo, mais dados em várias tabelas.
  const velho = openDb(dir);
  velho.exec(`
    DROP TABLE espelho_itens; DROP TABLE espelhos;
    DELETE FROM templates; DELETE FROM settings WHERE key = 'tpl_amazon_seed';
    INSERT INTO templates (id, name, body, created_at) VALUES (1, 'Padrão', '${DEFAULT_ANTERIOR}', 1), (7, 'Meu template', '{TITULO_PRODUTO} {LINK}', 2);
    INSERT INTO groups (jid, name, size, updated_at) VALUES ('g1@g.us', 'Grupo 1', 250, 1);
    INSERT INTO rules (id, name, template_id, group_jids, created_at) VALUES (3, 'Regra', 7, '["g1@g.us"]', 1);
    INSERT INTO envios (id, tipo, payload, group_jids, status, created_at) VALUES (5, 'mensagem', '{"texto":"oi"}', '["g1@g.us"]', 'concluido', 1);
    INSERT INTO conexoes (plataforma, config, segredos, updated_at) VALUES ('amazon', '{}', '{"tag":"minhatag-20"}', 1);
  `);
  for (const tabela of Object.keys(TABELAS_ESPELHO)) assert.ok(!existe(velho, 'table', tabela), `o banco simulado não tem ${tabela}`);
  for (const indice of Object.keys(INDICES_ESPELHO)) assert.ok(!existe(velho, 'index', indice), `o banco simulado não tem ${indice}`);
  const tabelasAntigas = linhas(velho, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((t) => t.name);
  const antes = {};
  for (const t of tabelasAntigas) antes[t] = linhas(velho, `SELECT * FROM ${t} ORDER BY rowid`);
  velho.close();

  for (let abertura = 1; abertura <= 2; abertura++) {
    const db = openDb(dir);
    conferirTabelasEspelho(db, `abertura ${abertura}`);
    for (const t of tabelasAntigas) {
      if (t === 'templates' || t === 'settings') continue;
      assert.deepEqual(linhas(db, `SELECT * FROM ${t} ORDER BY rowid`), antes[t], `${t} intacta (abertura ${abertura})`);
    }
    const templates = linhas(db, 'SELECT * FROM templates ORDER BY rowid');
    assert.deepEqual(templates.slice(0, antes.templates.length), antes.templates, `templates existentes intactos, Padrão com o texto antigo (abertura ${abertura})`);
    assert.equal(templates.length, antes.templates.length + 1, `só o "Amazon" a mais (abertura ${abertura})`);
    assert.equal(templates.at(-1).name, 'Amazon');
    assert.equal(templates.at(-1).body, TEXTO_AMAZON);
    assert.ok(templates.at(-1).id > 7, 'id novo, sem reaproveitar o de um template existente');
    const settings = linhas(db, 'SELECT * FROM settings ORDER BY rowid');
    assert.deepEqual(settings.filter((s) => s.key !== 'tpl_amazon_seed'), antes.settings, `settings intactas (abertura ${abertura})`);
    assert.equal(getSetting(db, 'tpl_amazon_seed'), String(templates.at(-1).id));
    db.close();
  }
});

test('espelho etapa 1: defaults das tabelas e índice único por mensagem e link', () => {
  const db = openDb(tmp());
  const { lastInsertRowid: espId } = db.prepare("INSERT INTO espelhos (nome, created_at) VALUES ('Amazon → meus grupos', 1)").run();
  assert.deepEqual({ ...db.prepare('SELECT * FROM espelhos WHERE id = ?').get(espId) }, {
    id: Number(espId), nome: 'Amazon → meus grupos', enabled: 1, origem_jids: '[]', destino_jids: '[]', template_id: null,
    incluir_minhas: 0, dedupe_horas: 168, palavras_bloqueadas: '[]', sem_preco: 'fila', max_por_hora: 10,
    janela_inicio: null, janela_fim: null, enviar_foto: 1, created_at: 1, updated_at: null,
  });
  assert.throws(() => db.prepare('INSERT INTO espelhos (created_at) VALUES (1)').run(), /NOT NULL/, 'nome é obrigatório');

  const item = db.prepare('INSERT INTO espelho_itens (espelho_id, origem_jid, msg_id, ts, url) VALUES (?, ?, ?, ?, ?)');
  const { lastInsertRowid: itemId } = item.run(espId, 'o1@g.us', 'MSG1', 10, 'https://amzn.to/abc');
  const r = { ...db.prepare('SELECT status, tentativas, asin, oferta, envio_id FROM espelho_itens WHERE id = ?').get(itemId) };
  assert.deepEqual(r, { status: 'recebido', tentativas: 0, asin: null, oferta: null, envio_id: null });
  assert.throws(() => item.run(espId, 'o1@g.us', 'MSG1', 11, 'https://amzn.to/abc'), /UNIQUE/, 'mesma mensagem e mesmo link não entram duas vezes');
  item.run(espId, 'o1@g.us', 'MSG1', 11, 'https://amzn.to/outro'); // segundo link da mesma mensagem
  item.run(espId, 'o2@g.us', 'MSG1', 11, 'https://amzn.to/abc'); // outra origem
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM espelho_itens').get().n, 3);
  for (const col of ['espelho_id', 'origem_jid', 'ts', 'url']) {
    const vals = { espelho_id: espId, origem_jid: 'o3@g.us', ts: 1, url: 'https://amzn.to/x' };
    vals[col] = null;
    assert.throws(() => item.run(vals.espelho_id, vals.origem_jid, 'M9', vals.ts, vals.url), /NOT NULL/, `${col} é obrigatório`);
  }
  db.close();
});

test('espelho etapa 1: DEFAULT_TEMPLATE só troca o desconto por pedaço opcional; o resto é o texto de antes', () => {
  const novo = dbMod.DEFAULT_TEMPLATE.split('\n');
  const antigo = DEFAULT_ANTERIOR.split('\n');
  assert.equal(novo.length, antigo.length);
  const diferentes = novo.map((l, i) => [l, antigo[i]]).filter(([a, b]) => a !== b);
  assert.deepEqual(diferentes, [['🔥 Por *{PRECO_PRODUTO}*[ ({DESCONTO_PRODUTO} OFF)]', '🔥 Por *{PRECO_PRODUTO}* ({DESCONTO_PRODUTO} OFF)']]);
  const db = openDb(tmp());
  assert.equal(db.prepare("SELECT body FROM templates WHERE name = 'Padrão'").get().body, dbMod.DEFAULT_TEMPLATE, 'instalação nova recebe o texto novo');
  db.close();
});
