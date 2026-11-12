// Base das features novas (plano disparos-comunicacao-conta): esquema aditivo e idempotente em src/db.js (etapa 1);
// agendador único, módulos novos com a interface final e ganchos do servidor (etapa 5).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { openDb, getSetting, setSetting, addLog, parseRule } from '../src/db.js';
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
import { ROOT, pastaDeDados, modoSimulacao } from '../src/config.js';
import { execFileSync } from 'node:child_process';

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
    // A marca tpl_ultimo_envio_migrado entrou em 11/11/2026 (plano baixou-de-para, etapa 3): "Meu template" não tem linha
    // de preço, então a migração da linha "Baixou de … para …" não mexe nele e a marca fica com a lista vazia.
    // A marca migracao_e1_nao_conferido é da migração da revisão do Catálogo (plano rodar-sozinho-entrega1, CA1.10).
    const semSemente = { settings: " WHERE key NOT IN ('tpl_amazon_seed', 'migracao_e1_nao_conferido', 'tpl_ultimo_envio_migrado')", templates: " WHERE name <> 'Amazon'" };
    for (const t of ['settings', 'tags', 'templates']) {
      assert.deepEqual(linhas(db, `SELECT * FROM ${t}${semSemente[t] || ''} ORDER BY rowid`), antes[t], `${t} intacta (abertura ${abertura})`);
    }
    assert.equal(getSetting(db, 'tpl_ultimo_envio_migrado'), '[]', `nenhum template ganhou a linha (abertura ${abertura})`);
    // A coluna groups.admins entrou em 10/11/2026 (plano anti-banimento, etapa 1): nula = contagem desconhecida.
    assert.deepEqual(linhas(db, 'SELECT * FROM groups ORDER BY rowid'), antes.groups.map((g) => ({ ...g, admins: null })), `groups intacta, com admins nulo (abertura ${abertura})`);
    // A coluna rules.grade entrou em 05/11/2026 (plano grade-de-disparos, etapa 1): nula = ritmo por intervalo, como antes.
    assert.deepEqual(linhas(db, 'SELECT * FROM rules ORDER BY rowid'), antes.rules.map((r) => ({ ...r, grade: null })), `rules intacta, com grade nula (abertura ${abertura})`);
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

test('servidor: a CSP libera as fotos de produto dos CDNs do Mercado Livre, da Amazon e da Shopee (como IMAGEM_PERMITIDA, IMAGEM_AMAZON e IMAGEM_SHOPEE) e nada mais de fora', async () => {
  const s = await subir();
  try {
    const csp = (await req(s.port, '/login.html')).headers['content-security-policy'];
    const img = csp.split(';').map((p) => p.trim()).find((p) => p.startsWith('img-src'));
    // os hosts da Shopee são conferidos contra IMAGEM_SHOPEE em test/servidor.test.js
    assert.equal(img, "img-src 'self' data: https://*.mlstatic.com https://*.media-amazon.com https://*.ssl-images-amazon.com https://*.images-amazon.com https://*.susercontent.com https://cf.shopee.com.br");
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
// A linha "📉 Baixou de … para …" entrou em 11/11/2026 (plano baixou-de-para, etapas 1 e 3): o "Amazon" já nasce com ela.
const LINHA_BAIXOU = '[📉 Baixou de ~{PRECO_ULTIMO_ENVIO}~ para *{PRECO_PRODUTO}*]';
const TEXTO_AMAZON = [
  '*{TITULO_PRODUTO}*', '', '😱 De ~{PRECO_ANTIGO}~', '🔥 Por *{PRECO_PRODUTO}*[ ({DESCONTO_PRODUTO} OFF)]', LINHA_BAIXOU,
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
  // e com o template "Padrão" no texto antigo, mais dados em várias tabelas. Sem a marca tpl_ultimo_envio_migrado
  // (plano baixou-de-para, etapa 3, 11/11/2026), que um banco daquela época também não tinha.
  const velho = openDb(dir);
  velho.exec(`
    DROP TABLE espelho_itens; DROP TABLE espelhos;
    DELETE FROM templates; DELETE FROM settings WHERE key IN ('tpl_amazon_seed', 'tpl_ultimo_envio_migrado');
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
    // Desde a migração do plano baixou-de-para (etapa 3, 11/11/2026), o Padrão antigo ganha só a linha "Baixou de … para …"
    // abaixo do "🔥 Por"; o resto do texto e o "Meu template" (sem linha de preço) ficam como estavam.
    const padraoMigrado = DEFAULT_ANTERIOR.replace('({DESCONTO_PRODUTO} OFF)\n', `({DESCONTO_PRODUTO} OFF)\n${LINHA_BAIXOU}\n`);
    assert.notEqual(padraoMigrado, DEFAULT_ANTERIOR);
    assert.deepEqual(templates.slice(0, antes.templates.length), antes.templates.map((t) => (t.id === 1 ? { ...t, body: padraoMigrado } : t)),
      `templates existentes intactos, Padrão com o texto antigo e a linha nova (abertura ${abertura})`);
    assert.equal(templates.length, antes.templates.length + 1, `só o "Amazon" a mais (abertura ${abertura})`);
    assert.equal(templates.at(-1).name, 'Amazon');
    assert.equal(templates.at(-1).body, TEXTO_AMAZON);
    assert.ok(templates.at(-1).id > 7, 'id novo, sem reaproveitar o de um template existente');
    const settings = linhas(db, 'SELECT * FROM settings ORDER BY rowid');
    assert.deepEqual(settings.filter((s) => !['tpl_amazon_seed', 'tpl_ultimo_envio_migrado'].includes(s.key)), antes.settings, `settings intactas (abertura ${abertura})`);
    assert.equal(getSetting(db, 'tpl_amazon_seed'), String(templates.at(-1).id));
    assert.equal(getSetting(db, 'tpl_ultimo_envio_migrado'), '[1]', `só o Padrão ganhou a linha (abertura ${abertura})`);
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
  // Plano baixou-de-para, etapa 3 (11/11/2026): o DEFAULT_TEMPLATE ganhou a linha "Baixou de … para …" logo abaixo do "🔥 Por".
  const comLinha = dbMod.DEFAULT_TEMPLATE.split('\n');
  assert.equal(comLinha[comLinha.indexOf('🔥 Por *{PRECO_PRODUTO}*[ ({DESCONTO_PRODUTO} OFF)]') + 1], LINHA_BAIXOU, 'a linha nova fica abaixo do "🔥 Por"');
  assert.equal(comLinha.filter((l) => l === LINHA_BAIXOU).length, 1);
  const novo = comLinha.filter((l) => l !== LINHA_BAIXOU);
  const antigo = DEFAULT_ANTERIOR.split('\n');
  assert.equal(novo.length, antigo.length);
  const diferentes = novo.map((l, i) => [l, antigo[i]]).filter(([a, b]) => a !== b);
  assert.deepEqual(diferentes, [['🔥 Por *{PRECO_PRODUTO}*[ ({DESCONTO_PRODUTO} OFF)]', '🔥 Por *{PRECO_PRODUTO}* ({DESCONTO_PRODUTO} OFF)']]);
  const db = openDb(tmp());
  assert.equal(db.prepare("SELECT body FROM templates WHERE name = 'Padrão'").get().body, dbMod.DEFAULT_TEMPLATE, 'instalação nova recebe o texto novo');
  db.close();
});

// ---------------------------------------------------------------------------------------------
// "Baixou de/para", etapa 3 (docs/produto/planos/baixou-de-para.md, CA3 e CA6): migração única que acrescenta a linha
// "[📉 Baixou de ~{PRECO_ULTIMO_ENVIO}~ para *{PRECO_PRODUTO}*]" nos templates existentes, marca tpl_ultimo_envio_migrado.
const { renderTemplate } = await import('../src/template.js');

/** Os 6 casos de template de um banco de antes da migração: [id, nome, corpo antes, corpo esperado depois]. */
const TEMPLATES_ANTIGOS = [
  [1, 'Padrão', DEFAULT_ANTERIOR, DEFAULT_ANTERIOR.replace('({DESCONTO_PRODUTO} OFF)\n', `({DESCONTO_PRODUTO} OFF)\n${LINHA_BAIXOU}\n`)],
  [2, 'Sem preço', '*{TITULO_PRODUTO}*\n🛒 {LINK}', null],
  [3, 'Preço e link juntos', '*{TITULO_PRODUTO}*\nSó {PRECO_PRODUTO}: {LINK}', null],
  [4, 'Já tem o campo', '*{TITULO_PRODUTO}*\nPor {PRECO_PRODUTO}\n[Antes {PRECO_ULTIMO_ENVIO}]\n{LINK}', null],
  [5, 'CRLF', '*{TITULO_PRODUTO}*\r\n🔥 Por {PRECO_PRODUTO}\r\n🛒 {LINK}', `*{TITULO_PRODUTO}*\r\n🔥 Por {PRECO_PRODUTO}\r\n${LINHA_BAIXOU}\r\n🛒 {LINK}`],
  [6, 'Do dono', 'Olha isso!\n{TITULO_PRODUTO} por {PRECO_PRODUTO}\nDe {PRECO_ANTIGO} por {PRECO_PRODUTO}\n👉 {LINK}',
    `Olha isso!\n{TITULO_PRODUTO} por {PRECO_PRODUTO}\n${LINHA_BAIXOU}\nDe {PRECO_ANTIGO} por {PRECO_PRODUTO}\n👉 {LINK}`],
];
const IDS_MIGRADOS = TEMPLATES_ANTIGOS.filter((t) => t[3] !== null).map((t) => t[0]);

/** Banco como o do serviço antes desta etapa: sem a marca, com os 6 templates de TEMPLATES_ANTIGOS e o "Amazon" já semeado. */
function bancoAntesDaLinha() {
  const dir = tmp();
  const velho = openDb(dir);
  velho.exec("DELETE FROM templates; DELETE FROM settings WHERE key IN ('tpl_amazon_seed', 'tpl_ultimo_envio_migrado')");
  const inserir = velho.prepare('INSERT INTO templates (id, name, body, created_at) VALUES (?, ?, ?, 1)');
  for (const [id, nome, corpo] of TEMPLATES_ANTIGOS) inserir.run(id, nome, corpo);
  assert.equal(getSetting(velho, 'tpl_ultimo_envio_migrado'), null, 'o banco simulado não tem a marca');
  velho.close();
  return dir;
}
const corpos = (db) => Object.fromEntries(linhas(db, 'SELECT id, body FROM templates ORDER BY id').map((t) => [t.id, t.body]));

test('baixou etapa 3: instalação nova já nasce com a linha no Padrão e no Amazon e grava a marca vazia', (t) => {
  const avisos = t.mock.method(console, 'log', () => {});
  const db = openDb(tmp());
  assert.equal(getSetting(db, 'tpl_ultimo_envio_migrado'), '[]', 'nada a migrar: a marca é a lista vazia');
  for (const { name, body } of linhas(db, 'SELECT name, body FROM templates ORDER BY id')) {
    assert.equal(body.split('\n').filter((l) => l === LINHA_BAIXOU).length, 1, `${name} tem a linha uma vez só`);
  }
  assert.equal(avisos.mock.callCount(), 0, 'sem template alterado, nada no console');
  db.close();
});

test('baixou etapa 3: banco antigo só ganha a linha onde deve, a marca guarda os ids e reabrir não muda nada', (t) => {
  const dir = bancoAntesDaLinha();
  const avisos = t.mock.method(console, 'log', () => {});
  const erros = t.mock.method(console, 'error', () => {});
  const db = openDb(dir);
  const depois = corpos(db);
  for (const [id, nome, antes, esperado] of TEMPLATES_ANTIGOS) {
    assert.equal(depois[id], esperado ?? antes, `${nome} (id ${id}) ${esperado ? 'ganha a linha' : 'fica como estava'}`);
  }
  const amazon = templatesAmazon(db);
  assert.equal(amazon.length, 1);
  assert.equal(amazon[0].body, TEXTO_AMAZON, 'o "Amazon" semeado nesta abertura não ganha uma segunda linha');
  assert.deepEqual(JSON.parse(getSetting(db, 'tpl_ultimo_envio_migrado')), IDS_MIGRADOS, 'a marca guarda só os ids alterados');
  assert.equal(erros.mock.callCount(), 0);
  assert.equal(avisos.mock.callCount(), 1, 'a contagem vai ao console uma vez');
  const dito = avisos.mock.calls[0].arguments.map(String).join(' ');
  assert.match(dito, /\b3 template/, 'diz quantos mudaram');
  assert.doesNotMatch(dito, /\{|Padrão|Do dono|CRLF/, 'sem corpo nem nome de template no console');

  // sem queda (campo vazio), a mensagem sai igual à de antes, inclusive no corpo com CRLF
  const oferta = { title: 'Fone Bluetooth', price: 252, oldPrice: 349, link: 'https://meli.la/abc', freeShipping: true };
  for (const [id, nome, antes] of TEMPLATES_ANTIGOS) {
    assert.equal(renderTemplate(depois[id], oferta), renderTemplate(antes, oferta), `${nome}: texto igual sem queda`);
  }
  assert.match(renderTemplate(depois[1], { ...oferta, precoUltimoEnvio: 299 }), /\n📉 Baixou de ~R\$ 299,00~ para \*R\$ 252,00\*\n/,
    'com queda, a linha aparece no Padrão migrado');
  const esquema = linhas(db, 'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name');
  const tudo = linhas(db, 'SELECT * FROM templates ORDER BY id');
  const marcas = linhas(db, 'SELECT * FROM settings ORDER BY rowid');
  db.close();

  const db2 = openDb(dir);
  assert.deepEqual(linhas(db2, 'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name'), esquema);
  assert.deepEqual(linhas(db2, 'SELECT * FROM templates ORDER BY id'), tudo, 'reabrir não muda nenhum template');
  assert.deepEqual(linhas(db2, 'SELECT * FROM settings ORDER BY rowid'), marcas, 'nem as settings');
  assert.equal(avisos.mock.callCount(), 1, 'a segunda abertura não diz nada');
  db2.close();
});

test('baixou etapa 3: linha apagada pelo dono não volta; template criado depois não é tocado', () => {
  const dir = bancoAntesDaLinha();
  let db = openDb(dir);
  db.prepare('UPDATE templates SET body = ? WHERE id = 1').run(DEFAULT_ANTERIOR); // o dono tira a linha no editor
  const { lastInsertRowid } = db.prepare("INSERT INTO templates (name, body, created_at) VALUES ('Novo', 'Por {PRECO_PRODUTO}\n{LINK}', 2)").run();
  const antes = linhas(db, 'SELECT * FROM templates ORDER BY id');
  db.close();
  db = openDb(dir);
  assert.deepEqual(linhas(db, 'SELECT * FROM templates ORDER BY id'), antes, 'nada muda ao reabrir');
  assert.equal(corpos(db)[1], DEFAULT_ANTERIOR, 'o Padrão continua sem a linha');
  assert.equal(corpos(db)[Number(lastInsertRowid)], 'Por {PRECO_PRODUTO}\n{LINK}');
  assert.deepEqual(JSON.parse(getSetting(db, 'tpl_ultimo_envio_migrado')), IDS_MIGRADOS, 'a marca é a da primeira vez');
  db.close();
});

test('baixou etapa 3: erro no meio desfaz tudo, o console só leva o código, o openDb segue e a próxima abertura migra', (t) => {
  const dir = bancoAntesDaLinha();
  // gatilho falha no UPDATE do 2º template migrado (id 5): o do id 1, já feito, tem de ser desfeito pelo ROLLBACK
  const velho = new DatabaseSync(path.join(dir, 'disparador.db'));
  velho.exec("CREATE TRIGGER falha_tpl BEFORE UPDATE ON templates WHEN NEW.id = 5 BEGIN SELECT RAISE(ABORT, 'falhou 5531999990000 {PRECO_PRODUTO}'); END");
  velho.close();
  const erros = t.mock.method(console, 'error', () => {});
  let db = openDb(dir);
  assert.deepEqual(corpos(db), { ...Object.fromEntries(TEMPLATES_ANTIGOS.map(([id, , antes]) => [id, antes])), [templatesAmazon(db)[0].id]: TEXTO_AMAZON },
    'nenhum template mudou');
  assert.equal(getSetting(db, 'tpl_ultimo_envio_migrado'), null, 'sem a marca: tenta de novo na próxima abertura');
  assert.ok(getSetting(db, 'ext_token'), 'o openDb terminou');
  assert.equal(db.isTransaction, false, 'nenhuma transação ficou aberta');
  assert.equal(erros.mock.callCount(), 1);
  const dito = erros.mock.calls[0].arguments.map(String).join(' ');
  assert.match(dito, /ERR_SQLITE_ERROR/);
  assert.doesNotMatch(dito, /5531999990000|\{|falhou/, 'sem a mensagem do banco');
  db.exec('DROP TRIGGER falha_tpl');
  db.close();

  db = openDb(dir);
  for (const [id, nome, antes, esperado] of TEMPLATES_ANTIGOS) assert.equal(corpos(db)[id], esperado ?? antes, `${nome} migrado na abertura seguinte`);
  assert.deepEqual(JSON.parse(getSetting(db, 'tpl_ultimo_envio_migrado')), IDS_MIGRADOS);
  assert.equal(erros.mock.callCount(), 1);
  db.close();
});

test('baixou etapa 3: banco ocupado por outra conexão não derruba o openDb; a linha entra na abertura seguinte', (t) => {
  const dir = bancoAntesDaLinha();
  const outra = new DatabaseSync(path.join(dir, 'disparador.db'));
  outra.exec("INSERT INTO settings (key, value) VALUES ('tpl_amazon_seed', '99')"); // a semente do "Amazon" já rodou antes
  outra.exec('BEGIN IMMEDIATE'); // outro processo escrevendo agora
  const erros = t.mock.method(console, 'error', () => {});
  let db;
  try {
    db = openDb(dir);
  } finally {
    outra.exec('ROLLBACK');
    outra.close();
  }
  assert.equal(getSetting(db, 'tpl_ultimo_envio_migrado'), null);
  assert.equal(corpos(db)[1], DEFAULT_ANTERIOR, 'Padrão sem a linha por enquanto');
  assert.equal(erros.mock.callCount(), 1);
  assert.match(erros.mock.calls[0].arguments.map(String).join(' '), /ERR_SQLITE_ERROR/);
  db.close();
  db = openDb(dir);
  assert.deepEqual(JSON.parse(getSetting(db, 'tpl_ultimo_envio_migrado')), IDS_MIGRADOS);
  db.close();
});

// Junção da entrega 1 do "Rodar sozinho" (migração migracao_e1_nao_conferido, CA1.10) com o "Baixou de/para"
// (tpl_ultimo_envio_migrado, CA3): as duas rodam no openDb, cada uma com a sua marca, em qualquer ordem de chegada.
// (a) banco novo: as duas marcas nascem e nada é apagado; (b) banco de antes das duas (main f3906fa): as duas rodam
// na mesma abertura; (c) banco que já rodou o "Baixou" (main 9d4965a, o do serviço): só a da revisão roda;
// (d) banco que só rodou a entrega 1: só a dos templates roda. Reabrir não muda nada em nenhum caso.
test('junção E1 × baixou: as duas migrações rodam uma vez cada, nos quatro casos de banco', (t) => {
  t.mock.method(console, 'log', () => {});
  const erros = t.mock.method(console, 'error', () => {});
  const MARCA_E1 = 'migracao_e1_nao_conferido';
  const MARCA_TPL = 'tpl_ultimo_envio_migrado';
  /** Banco aberto pela versão de agora, com dois itens na revisão e, sem as marcas de `semMarcas`, como antes delas. */
  const banco = (semMarcas) => {
    const dir = tmp();
    const db = openDb(dir);
    const regra = Number(db.prepare("INSERT INTO rules (name, group_jids, created_at) VALUES ('Catálogo', '[]', 1)").run().lastInsertRowid);
    const item = db.prepare(`INSERT INTO catalogo_itens (rule_id, chave, loja, status, motivos, oferta, criado_em)
      VALUES (?, ?, 'ml', 'revisao', ?, '{"title":"Fone","price":10}', 1)`);
    item.run(regra, 'MLB1', '["nao_conferido"]');
    item.run(regra, 'MLB2', '["nao_conferido","desconto_100"]');
    db.exec('DELETE FROM log');
    if (semMarcas.includes(MARCA_TPL)) {
      // como bancoAntesDaLinha: os 6 templates antigos, sem a semente "Amazon" nem a marca dos templates
      db.exec("DELETE FROM templates; DELETE FROM settings WHERE key IN ('tpl_amazon_seed', 'tpl_ultimo_envio_migrado')");
      const inserir = db.prepare('INSERT INTO templates (id, name, body, created_at) VALUES (?, ?, ?, 1)');
      for (const [id, nome, corpo] of TEMPLATES_ANTIGOS) inserir.run(id, nome, corpo);
    }
    if (semMarcas.includes(MARCA_E1)) db.prepare('DELETE FROM settings WHERE key = ?').run(MARCA_E1);
    db.close();
    return dir;
  };
  const chaves = (db) => linhas(db, 'SELECT chave FROM catalogo_itens ORDER BY id').map((l) => l.chave);
  const casos = [
    // [caso, marcas ausentes, a da revisão roda?, a dos templates roda?]
    ['b) banco de antes das duas', [MARCA_E1, MARCA_TPL], true, true],
    ['c) banco que já rodou o "Baixou" (main)', [MARCA_E1], true, false],
    ['d) banco que só rodou a entrega 1', [MARCA_TPL], false, true],
  ];
  for (const [caso, semMarcas, revisao, templates] of casos) {
    const dir = banco(semMarcas);
    const antes = new DatabaseSync(path.join(dir, 'disparador.db'));
    const tplAntes = linhas(antes, 'SELECT * FROM templates ORDER BY id');
    antes.close();
    const db = openDb(dir);
    assert.equal(getSetting(db, MARCA_E1), '1', `${caso}: marca da revisão`);
    assert.deepEqual(chaves(db), revisao ? ['MLB2'] : ['MLB1', 'MLB2'], `${caso}: a revisão ${revisao ? 'perdeu só o item nao_conferido' : 'ficou como estava'}`);
    assert.equal(linhas(db, 'SELECT message FROM log').length, revisao ? 1 : 0, `${caso}: linha do Histórico só quando a revisão migra`);
    if (templates) {
      assert.deepEqual(JSON.parse(getSetting(db, MARCA_TPL)), IDS_MIGRADOS, `${caso}: marca dos templates`);
      for (const [id, nome, corpo, esperado] of TEMPLATES_ANTIGOS) assert.equal(corpos(db)[id], esperado ?? corpo, `${caso}: ${nome}`);
    } else {
      assert.equal(getSetting(db, MARCA_TPL), '[]', `${caso}: a marca dos templates é a de antes`);
      assert.deepEqual(linhas(db, 'SELECT * FROM templates ORDER BY id'), tplAntes, `${caso}: nenhum template é tocado de novo`);
    }
    const tudo = ['catalogo_itens', 'templates', 'settings', 'log'].map((tb) => linhas(db, `SELECT * FROM ${tb} ORDER BY rowid`));
    db.close();
    const db2 = openDb(dir);
    assert.deepEqual(['catalogo_itens', 'templates', 'settings', 'log'].map((tb) => linhas(db2, `SELECT * FROM ${tb} ORDER BY rowid`)), tudo, `${caso}: reabrir não muda nada`);
    db2.close();
  }
  // a) banco novo: as duas marcas, nenhum item a tirar e nenhuma linha no Histórico
  const novo = openDb(tmp());
  assert.equal(getSetting(novo, MARCA_E1), '1');
  assert.equal(getSetting(novo, MARCA_TPL), '[]');
  assert.equal(linhas(novo, 'SELECT * FROM log').length, 0);
  novo.close();
  assert.equal(erros.mock.callCount(), 0, 'nenhuma migração falhou');
});

// Fonte "catalogo" (plano fonte-catalogo-etiqueta, etapa 0): fila/registro do que já foi tratado e cursor por regra.
const TABELAS_CATALOGO = {
  catalogo_itens: ['id', 'rule_id', 'chave', 'loja', 'status', 'motivos', 'oferta', 'envio_id', 'criado_em', 'decidido_em'],
  catalogo_cursores: ['rule_id', 'filtro', 'cursor', 'pronto', 'atualizado_em'],
};
const INDICES_CATALOGO = {
  idx_cat_item: [['rule_id', 'chave'], 1],
  idx_cat_status: [['status', 'rule_id', 'criado_em'], 0],
  idx_cat_lista: [['rule_id', 'status', null], 0], // a 3ª coluna é a expressão COALESCE(decidido_em, criado_em) (R10)
};

function conferirTabelasCatalogo(db, quando) {
  for (const [tabela, cols] of Object.entries(TABELAS_CATALOGO)) {
    assert.ok(existe(db, 'table', tabela), `tabela ${tabela} (${quando})`);
    assert.deepEqual(colunas(db, tabela), cols, `colunas de ${tabela} (${quando})`);
  }
  for (const [indice, [cols, unico]] of Object.entries(INDICES_CATALOGO)) {
    assert.equal(db.prepare("SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = ?").get(indice)?.tbl_name, 'catalogo_itens', `índice ${indice} (${quando})`);
    assert.deepEqual(db.prepare(`PRAGMA index_info(${indice})`).all().map((c) => c.name), cols, `colunas de ${indice} (${quando})`);
    assert.equal(db.prepare('PRAGMA index_list(catalogo_itens)').all().find((i) => i.name === indice)?.unique, unico, `${indice} ${unico ? 'é' : 'não é'} único (${quando})`);
  }
  const pk = db.prepare('PRAGMA table_info(catalogo_cursores)').all().filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
  assert.deepEqual(pk, ['rule_id', 'filtro'], `chave primária do cursor (${quando})`);
}

test('catálogo etapa 0: banco novo tem catalogo_itens, catalogo_cursores e índices; reabrir não cria nem altera nada', () => {
  const dir = tmp();
  const db1 = openDb(dir);
  conferirTabelasCatalogo(db1, 'primeira abertura');
  for (const tabela of Object.keys(TABELAS_CATALOGO)) assert.equal(db1.prepare(`SELECT COUNT(*) AS n FROM ${tabela}`).get().n, 0, `${tabela} nasce vazia`);
  db1.prepare("INSERT INTO catalogo_itens (rule_id, chave, loja, status, oferta, criado_em) VALUES (1, 'MLB1', 'ml', 'enviado', '{}', 1)").run();
  db1.prepare("INSERT INTO catalogo_cursores (rule_id, filtro, cursor) VALUES (1, 'abcd', 'c1')").run();
  const esquema = linhas(db1, 'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name');
  const dados = { itens: linhas(db1, 'SELECT * FROM catalogo_itens'), cursores: linhas(db1, 'SELECT * FROM catalogo_cursores') };
  db1.close();

  const db2 = openDb(dir);
  conferirTabelasCatalogo(db2, 'segunda abertura');
  assert.deepEqual(linhas(db2, 'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name'), esquema, 'reabrir não cria nem altera nada');
  assert.deepEqual(linhas(db2, 'SELECT * FROM catalogo_itens'), dados.itens, 'itens intactos ao reabrir');
  assert.deepEqual(linhas(db2, 'SELECT * FROM catalogo_cursores'), dados.cursores, 'cursores intactos ao reabrir');
  db2.close();
});

test('catálogo etapa 0: banco da versão anterior (sem as tabelas do catálogo) migra com os dados intactos', () => {
  const dir = tmp();
  // Banco como o do serviço antes desta etapa: esquema atual sem as tabelas e índices do catálogo, com dados em várias tabelas.
  const velho = openDb(dir);
  velho.exec(`
    DROP TABLE catalogo_itens; DROP TABLE catalogo_cursores;
    INSERT INTO groups (jid, name, size, updated_at) VALUES ('g1@g.us', 'Grupo 1', 250, 1);
    INSERT INTO rules (id, name, template_id, group_jids, sources, created_at) VALUES (3, 'Regra', 1, '["g1@g.us"]', '[{"type":"list","config":{}}]', 1);
    INSERT INTO sent_offers (rule_id, offer_key, sent_at) VALUES (3, 'MLB123', 1730000000000);
    INSERT INTO envios (id, tipo, payload, group_jids, status, created_at) VALUES (5, 'mensagem', '{"texto":"oi"}', '["g1@g.us"]', 'concluido', 1);
    INSERT INTO espelhos (id, nome, created_at) VALUES (2, 'Espelho', 1);
    INSERT INTO espelho_itens (espelho_id, origem_jid, msg_id, ts, url) VALUES (2, 'o1@g.us', 'M1', 1, 'https://amzn.to/abc');
    INSERT INTO conexoes (plataforma, config, segredos, updated_at) VALUES ('amazon', '{}', '{"tag":"minhatag-20"}', 1);
  `);
  for (const tabela of Object.keys(TABELAS_CATALOGO)) assert.ok(!existe(velho, 'table', tabela), `o banco simulado não tem ${tabela}`);
  for (const indice of Object.keys(INDICES_CATALOGO)) assert.ok(!existe(velho, 'index', indice), `o banco simulado não tem ${indice}`);
  const objetosAntigos = linhas(velho, 'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name');
  const tabelasAntigas = objetosAntigos.filter((o) => o.type === 'table').map((o) => o.name);
  const antes = {};
  for (const t of tabelasAntigas) antes[t] = linhas(velho, `SELECT * FROM ${t} ORDER BY rowid`);
  velho.close();

  for (let abertura = 1; abertura <= 2; abertura++) {
    const db = openDb(dir);
    conferirTabelasCatalogo(db, `abertura ${abertura}`);
    for (const t of tabelasAntigas) {
      assert.deepEqual(linhas(db, `SELECT * FROM ${t} ORDER BY rowid`), antes[t], `${t} intacta (abertura ${abertura})`);
    }
    const objetos = linhas(db, 'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name');
    assert.deepEqual(objetos.filter((o) => !Object.keys(TABELAS_CATALOGO).includes(o.tbl_name)), objetosAntigos, `nenhuma tabela ou índice antigo muda (abertura ${abertura})`);
    assert.deepEqual(objetos.filter((o) => Object.keys(TABELAS_CATALOGO).includes(o.tbl_name)).map((o) => o.name).sort(),
      ['catalogo_cursores', 'catalogo_itens', 'idx_cat_item', 'idx_cat_lista', 'idx_cat_status', 'sqlite_autoindex_catalogo_cursores_1'],
      `só as tabelas e índices do catálogo a mais, sem duplicar (abertura ${abertura})`);
    for (const tabela of Object.keys(TABELAS_CATALOGO)) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${tabela}`).get().n, 0, `${tabela} nasce vazia (abertura ${abertura})`);
    db.close();
  }
});

test('catálogo etapa 0: defaults, status permitido, obrigatórios e unicidade por regra e chave', () => {
  const db = openDb(tmp());
  const item = db.prepare('INSERT INTO catalogo_itens (rule_id, chave, loja, status, oferta, criado_em) VALUES (?, ?, ?, ?, ?, ?)');
  const { lastInsertRowid: id } = item.run(1, 'MLB1', 'ml', 'revisao', '{"title":"x"}', 10);
  assert.deepEqual({ ...db.prepare('SELECT motivos, envio_id, decidido_em FROM catalogo_itens WHERE id = ?').get(id) },
    { motivos: '[]', envio_id: null, decidido_em: null });
  for (const status of ['enviado', 'descartado']) item.run(1, `ASIN:${status}`, 'amazon', status, '{}', 10);
  assert.throws(() => item.run(1, 'MLB9', 'ml', 'na_fila', '{}', 10), /CHECK/, 'status fora de revisao|enviado|descartado é recusado');
  assert.throws(() => item.run(1, 'MLB1', 'ml', 'enviado', '{}', 11), /UNIQUE/, 'a mesma chave não entra duas vezes na mesma regra');
  item.run(2, 'MLB1', 'ml', 'enviado', '{}', 11); // outra regra pode tratar a mesma oferta
  const vals = { rule_id: 1, chave: 'SHOPEE:1.2', loja: 'shopee', status: 'revisao', oferta: '{}', criado_em: 1 };
  for (const col of Object.keys(vals)) {
    const v = { ...vals, [col]: null };
    assert.throws(() => item.run(v.rule_id, v.chave, v.loja, v.status, v.oferta, v.criado_em), /NOT NULL/, `${col} é obrigatório`);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM catalogo_itens').get().n, 4);

  const cursor = db.prepare('INSERT INTO catalogo_cursores (rule_id, filtro, cursor) VALUES (?, ?, ?)');
  cursor.run(1, '0123456789abcdef', null);
  assert.deepEqual({ ...db.prepare('SELECT cursor, pronto, atualizado_em FROM catalogo_cursores').get() }, { cursor: null, pronto: 0, atualizado_em: null });
  assert.throws(() => cursor.run(1, '0123456789abcdef', 'c2'), /UNIQUE|PRIMARY KEY/, 'um cursor por regra e filtro');
  cursor.run(1, 'fedcba9876543210', 'c2'); // outro filtro da mesma regra
  assert.throws(() => cursor.run(null, 'ffff', null), /NOT NULL/, 'rule_id é obrigatório');
  assert.throws(() => cursor.run(1, null, null), /NOT NULL/, 'filtro é obrigatório');
  db.close();
});

// Envio pelo sócio (plano envio-pelo-socio, etapa 1): cadastro de remetentes e um item por link recebido no privado.
const TABELAS_REMETENTES = {
  remetentes: ['id', 'nome', 'jid', 'lid', 'enabled', 'destino_jids', 'template_id', 'tag_id', 'enviar_foto', 'max_por_hora',
    'dedupe_horas', 'responder', 'created_at', 'updated_at'],
  remetente_itens: ['id', 'remetente_id', 'remetente_nome', 'msg_id', 'ts', 'url', 'loja', 'complemento', 'status', 'codigo',
    'motivo', 'chave', 'oferta', 'fonte_dados', 'envio_id', 'decidido_em', 'respondido_em', 'chegou_em', 'qtd_links'],
};
const INDICES_REMETENTES = {
  idx_rem_msg: [['remetente_id', 'msg_id', 'url'], 1],
  idx_rem_status: [['status', 'ts'], 0],
  idx_rem_dedupe: [['remetente_id', 'chave', 'status', 'decidido_em'], 0],
  idx_rem_hora: [['remetente_id', 'ts'], 0],
};
const OBJETOS_REMETENTES = ['idx_rem_dedupe', 'idx_rem_hora', 'idx_rem_msg', 'idx_rem_status', 'remetente_itens', 'remetentes',
  'sqlite_autoindex_remetentes_1', 'sqlite_autoindex_remetentes_2'];

function conferirTabelasRemetentes(db, quando) {
  for (const [tabela, cols] of Object.entries(TABELAS_REMETENTES)) {
    assert.ok(existe(db, 'table', tabela), `tabela ${tabela} (${quando})`);
    assert.deepEqual(colunas(db, tabela), cols, `colunas de ${tabela} (${quando})`);
  }
  for (const [indice, [cols, unico]] of Object.entries(INDICES_REMETENTES)) {
    assert.equal(db.prepare("SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = ?").get(indice)?.tbl_name, 'remetente_itens', `índice ${indice} (${quando})`);
    assert.deepEqual(db.prepare(`PRAGMA index_info(${indice})`).all().map((c) => c.name), cols, `colunas de ${indice} (${quando})`);
    assert.equal(db.prepare('PRAGMA index_list(remetente_itens)').all().find((i) => i.name === indice)?.unique, unico, `${indice} ${unico ? 'é' : 'não é'} único (${quando})`);
  }
  // jid e lid UNIQUE: um índice único de uma coluna só para cada um
  const unicos = db.prepare('PRAGMA index_list(remetentes)').all().filter((i) => i.unique === 1)
    .map((i) => db.prepare(`PRAGMA index_info(${i.name})`).all().map((c) => c.name).join(',')).sort();
  assert.deepEqual(unicos, ['jid', 'lid'], `jid e lid únicos em remetentes (${quando})`);
}

test('remetentes etapa 1: banco novo tem remetentes, remetente_itens e índices; reabrir não cria nem altera nada', () => {
  const dir = tmp();
  const db1 = openDb(dir);
  conferirTabelasRemetentes(db1, 'primeira abertura');
  for (const tabela of Object.keys(TABELAS_REMETENTES)) assert.equal(db1.prepare(`SELECT COUNT(*) AS n FROM ${tabela}`).get().n, 0, `${tabela} nasce vazia`);
  db1.prepare("INSERT INTO remetentes (nome, jid, lid, created_at) VALUES ('Sócio', '5531999990000@s.whatsapp.net', '123@lid', 1)").run();
  db1.prepare("INSERT INTO remetente_itens (remetente_id, remetente_nome, msg_id, ts, url) VALUES (1, 'Sócio', 'M1', 1, 'https://meli.la/abc')").run();
  const esquema = linhas(db1, 'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name');
  const dados = { remetentes: linhas(db1, 'SELECT * FROM remetentes'), itens: linhas(db1, 'SELECT * FROM remetente_itens') };
  db1.close();

  const db2 = openDb(dir);
  conferirTabelasRemetentes(db2, 'segunda abertura');
  assert.deepEqual(linhas(db2, 'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name'), esquema, 'reabrir não cria nem altera nada');
  assert.deepEqual(linhas(db2, 'SELECT * FROM remetentes'), dados.remetentes, 'remetentes intactos ao reabrir');
  assert.deepEqual(linhas(db2, 'SELECT * FROM remetente_itens'), dados.itens, 'itens intactos ao reabrir');
  db2.close();
});

test('remetentes etapa 1: banco da versão anterior (sem as tabelas de remetentes) migra com os dados intactos', () => {
  const dir = tmp();
  // Banco como o do serviço antes desta etapa: esquema atual sem as tabelas e índices de remetentes, com dados em várias tabelas.
  const velho = openDb(dir);
  velho.exec(`
    DROP TABLE remetente_itens; DROP TABLE remetentes;
    INSERT INTO groups (jid, name, size, updated_at) VALUES ('g1@g.us', 'Grupo 1', 250, 1);
    INSERT INTO rules (id, name, template_id, group_jids, sources, created_at) VALUES (3, 'Regra', 1, '["g1@g.us"]', '[{"type":"list","config":{}}]', 1);
    INSERT INTO sent_offers (rule_id, offer_key, sent_at) VALUES (3, 'MLB123', 1730000000000);
    INSERT INTO envios (id, tipo, payload, group_jids, status, created_at) VALUES (5, 'mensagem', '{"texto":"oi"}', '["g1@g.us"]', 'concluido', 1);
    INSERT INTO envio_resultados (envio_id, ocorrencia, ts, jid, group_name, ok) VALUES (5, 1, 2, 'g1@g.us', 'Grupo 1', 1);
    INSERT INTO aviso_destinos (nome, jid, created_at) VALUES ('Dono', '5531988887777@s.whatsapp.net', 1);
    INSERT INTO espelhos (id, nome, created_at) VALUES (2, 'Espelho', 1);
    INSERT INTO espelho_itens (espelho_id, origem_jid, msg_id, ts, url) VALUES (2, 'o1@g.us', 'M1', 1, 'https://amzn.to/abc');
    INSERT INTO catalogo_itens (rule_id, chave, loja, status, oferta, criado_em) VALUES (3, 'MLB1', 'ml', 'enviado', '{}', 1);
    INSERT INTO conexoes (plataforma, config, segredos, updated_at) VALUES ('amazon', '{}', '{"tag":"minhatag-20"}', 1);
  `);
  for (const tabela of Object.keys(TABELAS_REMETENTES)) assert.ok(!existe(velho, 'table', tabela), `o banco simulado não tem ${tabela}`);
  for (const indice of Object.keys(INDICES_REMETENTES)) assert.ok(!existe(velho, 'index', indice), `o banco simulado não tem ${indice}`);
  const objetosAntigos = linhas(velho, 'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name');
  const tabelasAntigas = objetosAntigos.filter((o) => o.type === 'table').map((o) => o.name);
  const antes = {};
  for (const t of tabelasAntigas) antes[t] = linhas(velho, `SELECT * FROM ${t} ORDER BY rowid`);
  velho.close();

  for (let abertura = 1; abertura <= 2; abertura++) {
    const db = openDb(dir);
    conferirTabelasRemetentes(db, `abertura ${abertura}`);
    for (const t of tabelasAntigas) {
      assert.deepEqual(linhas(db, `SELECT * FROM ${t} ORDER BY rowid`), antes[t], `${t} intacta (abertura ${abertura})`);
    }
    const objetos = linhas(db, 'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name');
    assert.deepEqual(objetos.filter((o) => !Object.keys(TABELAS_REMETENTES).includes(o.tbl_name)), objetosAntigos, `nenhuma tabela ou índice antigo muda (abertura ${abertura})`);
    assert.deepEqual(objetos.filter((o) => Object.keys(TABELAS_REMETENTES).includes(o.tbl_name)).map((o) => o.name).sort(), OBJETOS_REMETENTES,
      `só as tabelas e índices de remetentes a mais, sem duplicar (abertura ${abertura})`);
    for (const tabela of Object.keys(TABELAS_REMETENTES)) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${tabela}`).get().n, 0, `${tabela} nasce vazia (abertura ${abertura})`);
    db.close();
  }
});

test('remetentes etapa 1 (CA1): valores padrão, obrigatórios e jid/lid únicos', () => {
  const db = openDb(tmp());
  const rem = db.prepare('INSERT INTO remetentes (nome, jid, lid) VALUES (?, ?, ?)');
  const { lastInsertRowid: id } = rem.run('Sócio', '5531999990000@s.whatsapp.net', null);
  assert.deepEqual({ ...db.prepare('SELECT * FROM remetentes WHERE id = ?').get(id) }, {
    id: Number(id), nome: 'Sócio', jid: '5531999990000@s.whatsapp.net', lid: null, enabled: 1, destino_jids: '[]',
    template_id: null, tag_id: null, enviar_foto: 1, max_por_hora: 10, dedupe_horas: 24, responder: 1, created_at: null, updated_at: null,
  });
  assert.throws(() => rem.run('Outro', '5531999990000@s.whatsapp.net', null), /UNIQUE/, 'o mesmo jid não entra duas vezes');
  rem.run('Sem LID', '5531999991111@s.whatsapp.net', null); // vários remetentes sem LID convivem
  rem.run('Com LID', '5531999992222@s.whatsapp.net', '111@lid');
  assert.throws(() => rem.run('Outro LID', '5531999993333@s.whatsapp.net', '111@lid'), /UNIQUE/, 'o mesmo lid não entra duas vezes');
  assert.throws(() => rem.run(null, '5531999994444@s.whatsapp.net', null), /NOT NULL/, 'nome é obrigatório');
  assert.throws(() => rem.run('Sem jid', null, null), /NOT NULL/, 'jid é obrigatório');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM remetentes').get().n, 3);
  db.close();
});

test('remetentes etapa 1 (CA9): remetente_itens tem padrões, obrigatórios, um item por mensagem e link, e nenhum texto ou número', () => {
  const db = openDb(tmp());
  const item = db.prepare('INSERT INTO remetente_itens (remetente_id, msg_id, ts) VALUES (?, ?, ?)');
  const { lastInsertRowid: id } = item.run(1, 'M1', 10);
  assert.deepEqual({ ...db.prepare('SELECT * FROM remetente_itens WHERE id = ?').get(id) }, {
    id: Number(id), remetente_id: 1, remetente_nome: null, msg_id: 'M1', ts: 10, url: '', loja: null, complemento: null,
    status: 'recebido', codigo: null, motivo: null, chave: null, oferta: null, fonte_dados: null, envio_id: null,
    decidido_em: null, respondido_em: null, chegou_em: null, qtd_links: null,
  });
  const comUrl = db.prepare('INSERT INTO remetente_itens (remetente_id, msg_id, ts, url) VALUES (?, ?, ?, ?)');
  comUrl.run(1, 'M2', 10, 'https://amzn.to/a');
  assert.throws(() => comUrl.run(1, 'M2', 11, 'https://amzn.to/a'), /UNIQUE/, 'a mesma mensagem e link não entram duas vezes');
  assert.throws(() => item.run(1, 'M1', 11), /UNIQUE/, 'a mesma mensagem sem link (url vazia) não entra duas vezes');
  comUrl.run(1, 'M2', 10, 'https://amzn.to/b'); // outro link da mesma mensagem
  comUrl.run(2, 'M2', 10, 'https://amzn.to/a'); // outro remetente
  const vals = { remetente_id: 3, msg_id: 'M9', ts: 1 };
  for (const col of Object.keys(vals)) {
    const v = { ...vals, [col]: null };
    assert.throws(() => item.run(v.remetente_id, v.msg_id, v.ts), /NOT NULL/, `${col} é obrigatório`);
  }
  assert.throws(() => comUrl.run(3, 'M9', 1, null), /NOT NULL/, 'url nunca é nula');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM remetente_itens').get().n, 4);
  // LGPD: o item não guarda o texto da mensagem nem o número (jid/lid ficam só no cadastro e somem ao excluir).
  for (const proibida of ['texto', 'texto_origem', 'mensagem', 'jid', 'lid', 'numero', 'telefone', 'participante', 'remetente_jid']) {
    assert.ok(!colunas(db, 'remetente_itens').includes(proibida), `remetente_itens não tem ${proibida}`);
  }
  db.close();
});

// Remetente, rodada 2 (Q2/S2 e Q3): remetente_itens ganha chegou_em (hora de chegada, para o limite por hora) e qtd_links
// (quantos links a linha 'limite' representa) por ALTER TABLE, sem perder os itens da versão anterior.
test('remetentes rodada 2: banco da versão anterior com itens ganha chegou_em e qtd_links sem perder dado', () => {
  const dir = tmp();
  const velho = openDb(dir);
  velho.exec('ALTER TABLE remetente_itens DROP COLUMN qtd_links; ALTER TABLE remetente_itens DROP COLUMN chegou_em;');
  assert.deepEqual(colunas(velho, 'remetente_itens'), TABELAS_REMETENTES.remetente_itens.slice(0, -2), 'o banco simulado é o da versão anterior');
  velho.prepare("INSERT INTO remetentes (id, nome, jid, lid, created_at) VALUES (4, 'Sócio', '5531999990000@s.whatsapp.net', '123@lid', 1)").run();
  const ins = velho.prepare(`INSERT INTO remetente_itens (remetente_id, remetente_nome, msg_id, ts, url, loja, status, codigo, motivo, chave,
    oferta, fonte_dados, envio_id, decidido_em, respondido_em) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  ins.run(4, 'Sócio', 'M1', 1000, 'https://produto.mercadolivre.com.br/MLB-1234567890-x', 'mercadolivre', 'enviado', null, null, 'MLB1234567890',
    '{"title":"Fone"}', 'api', 9, 1100, 1200);
  ins.run(4, 'Sócio', 'M2', 2000, '', null, 'descartado', 'limite', 'passou do limite de links por hora', null, null, null, null, 2000, null);
  ins.run(4, 'Sócio', 'M3', 3000, 'https://amzn.to/abc', 'amazon', 'recebido', null, null, null, null, null, null, null, null);
  const antes = linhas(velho, 'SELECT * FROM remetente_itens ORDER BY id');
  const remetentes = linhas(velho, 'SELECT * FROM remetentes');
  velho.close();

  for (let abertura = 1; abertura <= 2; abertura++) {
    const db = openDb(dir);
    conferirTabelasRemetentes(db, `abertura ${abertura}`);
    assert.deepEqual(linhas(db, 'SELECT * FROM remetente_itens ORDER BY id'), antes.map((i) => ({ ...i, chegou_em: null, qtd_links: null })),
      `itens intactos, com as colunas novas vazias (abertura ${abertura})`);
    assert.deepEqual(linhas(db, 'SELECT * FROM remetentes'), remetentes, `remetentes intactos (abertura ${abertura})`);
    db.close();
  }
});

// Grade de horários e Grupo vivo (plano grade-de-disparos, etapa 1): a migração só acrescenta rules.grade (JSON; NULL = ritmo
// por intervalo, o de hoje) e a tabela rotinas com o índice da fila. Regra que já existe não muda em nada (CA1).
const COLUNAS_ROTINAS = ['id', 'nome', 'enabled', 'tipo', 'conteudos', 'ordem', 'proximo_indice', 'group_jids', 'repetir',
  'next_run_at', 'last_run_at', 'ultimo_envio_id', 'created_at', 'updated_at'];
const objetosDe = (db) => linhas(db, 'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name');

function conferirGradeERotinas(db, quando) {
  const grade = db.prepare('PRAGMA table_info(rules)').all().filter((c) => c.name === 'grade');
  assert.equal(grade.length, 1, `rules.grade existe uma vez (${quando})`);
  assert.deepEqual({ type: grade[0].type, notnull: grade[0].notnull, dflt_value: grade[0].dflt_value, pk: grade[0].pk },
    { type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 }, `rules.grade é TEXT, aceita nulo e não tem padrão (${quando})`);
  assert.ok(existe(db, 'table', 'rotinas'), `tabela rotinas (${quando})`);
  assert.deepEqual(colunas(db, 'rotinas'), COLUNAS_ROTINAS, `colunas de rotinas (${quando})`);
  assert.equal(db.prepare("SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'idx_rotinas_fila'").get()?.tbl_name, 'rotinas', `índice da fila (${quando})`);
  assert.deepEqual(db.prepare('PRAGMA index_info(idx_rotinas_fila)').all().map((c) => c.name), ['enabled', 'next_run_at'], `colunas do índice da fila (${quando})`);
  assert.equal(db.prepare('PRAGMA index_list(rotinas)').all().find((i) => i.name === 'idx_rotinas_fila')?.unique, 0, `o índice da fila não é único (${quando})`);
  assert.deepEqual(objetosDe(db).filter((o) => o.tbl_name === 'rotinas').map((o) => o.name).sort(), ['idx_rotinas_fila', 'rotinas'],
    `só a tabela rotinas e o índice da fila, sem duplicar (${quando})`);
}

test('grade etapa 1: banco novo tem rules.grade e a tabela rotinas com o índice; reabrir não cria nem altera nada', () => {
  const dir = tmp();
  const db1 = openDb(dir);
  conferirGradeERotinas(db1, 'primeira abertura');
  assert.equal(db1.prepare('SELECT COUNT(*) AS n FROM rotinas').get().n, 0, 'rotinas nasce vazia');
  const { lastInsertRowid: id } = db1.prepare("INSERT INTO rules (name, created_at) VALUES ('Nova', 1)").run();
  assert.equal(db1.prepare('SELECT grade FROM rules WHERE id = ?').get(id).grade, null, 'regra criada sem grade fica no modo intervalo');
  db1.prepare(`INSERT INTO rotinas (nome, tipo, conteudos, group_jids, repetir, next_run_at, created_at)
    VALUES ('Bom dia', 'mensagem', '["Bom dia!"]', '["g1@g.us"]', '{"dias":[1],"horarios":["08:00"]}', 5, 1)`).run();
  const esquema = objetosDe(db1);
  const dados = { rules: linhas(db1, 'SELECT * FROM rules'), rotinas: linhas(db1, 'SELECT * FROM rotinas') };
  db1.close();

  const db2 = openDb(dir);
  conferirGradeERotinas(db2, 'segunda abertura');
  assert.deepEqual(objetosDe(db2), esquema, 'reabrir não cria nem altera nada');
  assert.deepEqual(linhas(db2, 'SELECT * FROM rules'), dados.rules, 'regras intactas ao reabrir');
  assert.deepEqual(linhas(db2, 'SELECT * FROM rotinas'), dados.rotinas, 'rotinas intactas ao reabrir');
  db2.close();
});

test('grade etapa 1 (CA1): banco da versão anterior, com regras e dados, abre sem perder nada; grade fica NULL e parseRule devolve o mesmo de antes', () => {
  const dir = tmp();
  // Banco como o do serviço antes desta etapa: esquema atual sem rules.grade e sem rotinas, com dados em todas as áreas.
  const velho = openDb(dir);
  velho.exec('DROP TABLE IF EXISTS rotinas');
  if (colunas(velho, 'rules').includes('grade')) velho.exec('ALTER TABLE rules DROP COLUMN grade');
  velho.exec(`
    INSERT INTO settings (key, value) VALUES ('delay_group_s', '9'), ('delay_offer_s', '12');
    INSERT INTO tags (id, name, created_at) VALUES (1, 'etiqueta1', 1), (2, 'etiqueta2', 1);
    INSERT INTO templates (id, name, body, created_at) VALUES (7, 'Meu template', '{TITULO_PRODUTO} {LINK}', 1);
    INSERT INTO groups (jid, name, size, updated_at, invite_code, is_admin) VALUES ('g1@g.us', 'Grupo 1', 250, 1, 'abc', 1), ('g2@g.us', 'Grupo 2', 90, 1, NULL, 0);
    INSERT INTO rules (id, name, enabled, tag_id, template_id, group_jids, source_type, source_config, min_price, max_price, min_discount,
      per_run, interval_min, window_start, window_end, dedupe_days, send_image, next_run_at, last_run_at, created_at, sources)
      VALUES (3, 'Ofertas tech', 1, 1, 7, '["g1@g.us","g2@g.us"]', 'list', '{"items":"https://produto.mercadolivre.com.br/MLB-1-a | A | 10"}',
        10, 500.5, 20, 5, 45, '07:30', '23:15', 3, 0, 1730000000000, 1729990000000, 1, '[{"type":"catalogo","config":{"lojas":["ml"]},"tag_id":2}]'),
      (4, 'Noturna', 0, 2, 1, '[]', 'list', '{}', NULL, NULL, NULL, 2, 120, '22:00', '02:00', 7, 1, NULL, NULL, 2, NULL);
    INSERT INTO sent_offers (rule_id, offer_key, sent_at) VALUES (3, 'MLB123', 1730000000000);
    INSERT INTO log (ts, rule_id, rule_name, level, group_name, offer_title, message) VALUES (1730000000000, 3, 'Ofertas tech', 'ok', 'Grupo 1', 'Fone', 'enviado');
    INSERT INTO envios (id, tipo, payload, group_jids, quando, repetir, status, next_run_at, created_at)
      VALUES (5, 'mensagem', '{"texto":"oi"}', '["g1@g.us"]', 'repetir', '{"dias":[1],"horarios":["08:00"]}', 'pendente', 1730000000000, 1);
    INSERT INTO envio_resultados (envio_id, ocorrencia, ts, jid, group_name, ok) VALUES (5, 1, 2, 'g1@g.us', 'Grupo 1', 1);
    INSERT INTO espelhos (id, nome, created_at) VALUES (2, 'Espelho', 1);
    INSERT INTO catalogo_itens (rule_id, chave, loja, status, oferta, criado_em) VALUES (3, 'MLB1', 'ml', 'enviado', '{}', 1);
    INSERT INTO catalogo_cursores (rule_id, filtro, cursor) VALUES (3, '0123456789abcdef', 'c1');
    INSERT INTO remetentes (nome, jid, created_at) VALUES ('Sócio', '5531999990000@s.whatsapp.net', 1);
  `);
  assert.ok(!existe(velho, 'table', 'rotinas') && !existe(velho, 'index', 'idx_rotinas_fila'), 'o banco simulado não tem rotinas');
  assert.ok(!colunas(velho, 'rules').includes('grade'), 'o banco simulado não tem rules.grade');
  const objetosAntigos = objetosDe(velho);
  const tabelasAntigas = objetosAntigos.filter((o) => o.type === 'table').map((o) => o.name);
  const colunasRegraAntes = velho.prepare('PRAGMA table_info(rules)').all().map((c) => ({ ...c }));
  const antes = {};
  for (const t of tabelasAntigas) antes[t] = linhas(velho, `SELECT * FROM ${t} ORDER BY rowid`);
  // parseRule de antes desta etapa sobre as regras gravadas (sem a coluna grade): é o que tem de continuar saindo.
  const regraDeAntes = (r) => ({ ...r, enabled: !!r.enabled, send_image: !!r.send_image, group_jids: JSON.parse(r.group_jids || '[]'),
    source_config: JSON.parse(r.source_config || '{}'),
    sources: r.sources ? JSON.parse(r.sources).map((s) => ({ type: s.type, config: s.config, tag_id: s.tag_id ?? null }))
      : [{ type: r.source_type, config: JSON.parse(r.source_config), tag_id: null }] });
  const parseadasAntes = antes.rules.map(regraDeAntes);
  assert.deepEqual(parseadasAntes.map((r) => [r.sources[0].type, r.sources[0].tag_id, r.enabled, r.send_image]),
    [['catalogo', 2, true, false], ['list', null, false, true]], 'referência de "antes" montada com as duas formas de fonte');
  velho.close();

  for (let abertura = 1; abertura <= 2; abertura++) {
    const db = openDb(dir);
    conferirGradeERotinas(db, `abertura ${abertura}`);
    for (const t of tabelasAntigas.filter((t) => t !== 'rules')) {
      assert.deepEqual(linhas(db, `SELECT * FROM ${t} ORDER BY rowid`), antes[t], `${t} intacta (abertura ${abertura})`);
    }
    const regras = linhas(db, 'SELECT * FROM rules ORDER BY rowid');
    assert.deepEqual(regras, antes.rules.map((r) => ({ ...r, grade: null })), `regras intactas, com grade NULL (abertura ${abertura})`);
    assert.deepEqual(db.prepare('PRAGMA table_info(rules)').all().map((c) => ({ ...c })),
      [...colunasRegraAntes, { cid: colunasRegraAntes.length, name: 'grade', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 }],
      `rules só ganha grade no fim; as outras colunas não mudam (abertura ${abertura})`);
    assert.deepEqual(objetosDe(db).filter((o) => o.tbl_name !== 'rotinas' && !(o.type === 'table' && o.name === 'rules')),
      objetosAntigos.filter((o) => !(o.type === 'table' && o.name === 'rules')), `nenhuma outra tabela ou índice muda (abertura ${abertura})`);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rotinas').get().n, 0, `rotinas nasce vazia (abertura ${abertura})`);
    assert.deepEqual(regras.map(parseRule), parseadasAntes.map((r) => ({ ...r, grade: null })),
      `parseRule devolve o mesmo de antes, fora grade: null (abertura ${abertura})`);
    db.close();
  }
});

test('grade etapa 1: parseRule lê grade como objeto e devolve null se vier vazia, ilegível ou fora de forma, sem nunca lançar', () => {
  const base = { id: 1, name: 'R', enabled: 1, send_image: 1, group_jids: '["g1@g.us"]', source_type: 'list', source_config: '{}', sources: null };
  const semGrade = parseRule(base);
  assert.equal(semGrade.grade, null, 'linha sem a coluna grade (código ou banco de antes) vira grade: null');
  assert.ok(Object.hasOwn(semGrade, 'grade'), 'o campo grade sempre existe no objeto da regra');

  const grade = { dias: [1, 2, 3, 4, 5], horarios: [{ hora: '09:00', qtd: 3, template_id: null }, { hora: '12:30', qtd: 5, template_id: 7 }] };
  const comGrade = parseRule({ ...base, grade: JSON.stringify(grade) });
  assert.deepEqual(comGrade.grade, grade, 'grade gravada volta como objeto');
  assert.deepEqual({ ...comGrade, grade: null }, semGrade, 'a grade não mexe em nenhum outro campo');

  const invalidas = [null, undefined, '', '   ', '{', '{"dias":[1],', 'null', '[]', '[{"hora":"09:00"}]', '"09:00"', '5', 'true', 'NaN',
    new Uint8Array([123, 125]), Buffer.from('{"dias":[1]}'), 7]; // só texto: BLOB nunca vira grade
  for (const valor of invalidas) {
    let r;
    assert.doesNotThrow(() => { r = parseRule({ ...base, grade: valor }); }, `parseRule não lança com grade ${String(valor)}`);
    assert.equal(r.grade, null, `grade ${typeof valor === 'string' ? JSON.stringify(valor) : String(valor)} vira null`);
    assert.deepEqual({ ...r }, semGrade, 'o resto da regra sai igual');
  }
  assert.equal(parseRule(null), null, 'sem linha continua null');
  assert.equal(parseRule(undefined), null);
});

test('grade etapa 1 (CA1): no agendador, regra com grade NULL ou ilegível roda pelo intervalo, como hoje, e não trava o tick', async () => {
  const { db, wa, scheduler } = montarAgendador();
  const nula = novaRegra(db, { name: 'Sem grade' });
  const quebrada = novaRegra(db, { name: 'Grade quebrada', groups: ['222@g.us'] });
  db.prepare("UPDATE rules SET grade = '{quebrado' WHERE id = ?").run(quebrada);
  await scheduler.tick();
  assert.deepEqual(wa.simulated.map((m) => m.jid), ['111@g.us', '222@g.us'], 'as duas regras enviaram no mesmo tick');
  for (const id of [nula, quebrada]) {
    const prox = db.prepare('SELECT next_run_at FROM rules WHERE id = ?').get(id).next_run_at;
    assert.ok(prox > Date.now() + 59 * 60000 && prox <= Date.now() + 60 * 60000, `próximo envio da regra ${id} pelo intervalo de 60 min`);
  }
  db.close();
});

test('grade etapa 1 (CA11): rotinas tem padrões, tipo e ordem só dos valores do plano, e os obrigatórios', () => {
  const db = openDb(tmp());
  const ins = db.prepare('INSERT INTO rotinas (nome, tipo, repetir) VALUES (?, ?, ?)');
  const { lastInsertRowid: id } = ins.run('Bom dia', 'mensagem', '{"dias":[0,1,2,3,4,5,6],"horarios":["08:00"]}');
  assert.deepEqual({ ...db.prepare('SELECT * FROM rotinas WHERE id = ?').get(id) }, {
    id: Number(id), nome: 'Bom dia', enabled: 1, tipo: 'mensagem', conteudos: '[]', ordem: 'rodizio', proximo_indice: 0,
    group_jids: '[]', repetir: '{"dias":[0,1,2,3,4,5,6],"horarios":["08:00"]}', next_run_at: null, last_run_at: null,
    ultimo_envio_id: null, created_at: null, updated_at: null,
  });
  ins.run('Enquete da sexta', 'enquete', '{"dias":[5],"horarios":["18:00"]}');
  assert.throws(() => ins.run('Foto', 'foto', '{}'), /CHECK/, 'tipo só mensagem ou enquete');
  assert.throws(() => ins.run('Maiúscula', 'Mensagem', '{}'), /CHECK/, 'tipo diferencia caixa');
  const comOrdem = db.prepare("INSERT INTO rotinas (nome, tipo, repetir, ordem) VALUES ('O', 'mensagem', '{}', ?)");
  comOrdem.run('sorteio');
  assert.throws(() => comOrdem.run('aleatorio'), /CHECK/, 'ordem só rodizio ou sorteio');
  const vals = { nome: 'X', tipo: 'mensagem', repetir: '{}' };
  for (const col of Object.keys(vals)) {
    const v = { ...vals, [col]: null };
    assert.throws(() => ins.run(v.nome, v.tipo, v.repetir), /NOT NULL/, `${col} é obrigatório`);
  }
  for (const col of ['enabled', 'conteudos', 'ordem', 'proximo_indice', 'group_jids']) {
    assert.throws(() => db.prepare(`INSERT INTO rotinas (nome, tipo, repetir, ${col}) VALUES ('X', 'mensagem', '{}', NULL)`).run(), /NOT NULL/, `${col} nunca é nulo`);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rotinas').get().n, 3);
  db.close();
});

// Anti-banimento (plano anti-banimento, etapa 1): a migração só acrescenta a tabela wa_saidas (só a hora de cada mensagem
// enviada, para o teto por hora do CA1) com o índice por ts, e groups.admins (só a contagem; NULL = desconhecido).
const COLUNAS_WA_SAIDAS = [{ name: 'ts', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 }];
const colunaAdmins = { name: 'admins', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 };
const semCid = (db, tabela) => db.prepare(`PRAGMA table_info(${tabela})`).all().map(({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk }));

function conferirProtecao(db, quando) {
  assert.ok(existe(db, 'table', 'wa_saidas'), `tabela wa_saidas (${quando})`);
  assert.deepEqual(semCid(db, 'wa_saidas'), COLUNAS_WA_SAIDAS, `wa_saidas só tem ts, inteiro e obrigatório: sem jid nem número (${quando})`);
  assert.equal(db.prepare("SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'idx_wa_saidas_ts'").get()?.tbl_name, 'wa_saidas', `índice por ts (${quando})`);
  assert.deepEqual(db.prepare('PRAGMA index_info(idx_wa_saidas_ts)').all().map((c) => c.name), ['ts'], `colunas do índice (${quando})`);
  assert.equal(db.prepare('PRAGMA index_list(wa_saidas)').all().find((i) => i.name === 'idx_wa_saidas_ts')?.unique, 0,
    `o índice não é único: duas mensagens no mesmo milissegundo contam as duas (${quando})`);
  assert.deepEqual(objetosDe(db).filter((o) => o.tbl_name === 'wa_saidas').map((o) => o.name).sort(), ['idx_wa_saidas_ts', 'wa_saidas'],
    `só a tabela e o índice, sem duplicar (${quando})`);
  const admins = semCid(db, 'groups').filter((c) => c.name === 'admins');
  assert.deepEqual(admins, [colunaAdmins], `groups.admins existe uma vez, inteiro, aceita nulo e não tem padrão (${quando})`);
  assert.equal(semCid(db, 'groups').at(-1).name, 'admins', `groups.admins é a última coluna (${quando})`);
}

test('anti-banimento etapa 1 (CA1): banco novo tem wa_saidas com o índice e groups.admins; reabrir não cria nem altera nada', () => {
  const dir = tmp();
  const db1 = openDb(dir);
  conferirProtecao(db1, 'primeira abertura');
  assert.equal(db1.prepare('SELECT COUNT(*) AS n FROM wa_saidas').get().n, 0, 'wa_saidas nasce vazia');
  db1.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run('g1@g.us', 'Grupo 1', 10, 1);
  assert.equal(db1.prepare("SELECT admins FROM groups WHERE jid = 'g1@g.us'").get().admins, null, 'grupo gravado sem contagem fica com admins nulo');
  db1.prepare("UPDATE groups SET admins = 1 WHERE jid = 'g1@g.us'").run();
  const ins = db1.prepare('INSERT INTO wa_saidas (ts) VALUES (?)');
  ins.run(1000); ins.run(1000); ins.run(2000);
  assert.throws(() => ins.run(null), /NOT NULL/, 'toda saída tem hora');
  const esquema = objetosDe(db1);
  const dados = { groups: linhas(db1, 'SELECT * FROM groups'), wa_saidas: linhas(db1, 'SELECT * FROM wa_saidas ORDER BY rowid') };
  assert.deepEqual(dados.wa_saidas, [{ ts: 1000 }, { ts: 1000 }, { ts: 2000 }], 'duas saídas no mesmo instante ficam as duas');
  db1.close();

  const db2 = openDb(dir);
  conferirProtecao(db2, 'segunda abertura');
  assert.deepEqual(objetosDe(db2), esquema, 'reabrir não cria nem altera nada');
  assert.deepEqual(linhas(db2, 'SELECT * FROM groups'), dados.groups, 'groups intacta ao reabrir, com admins = 1');
  assert.deepEqual(linhas(db2, 'SELECT * FROM wa_saidas ORDER BY rowid'), dados.wa_saidas, 'wa_saidas intacta ao reabrir');
  db2.close();
});

test('anti-banimento etapa 1 (CA1): banco da versão anterior abre sem perder nada; groups ganha admins nulo no fim e wa_saidas nasce vazia', () => {
  const dir = tmp();
  // Banco como o do serviço antes desta etapa: esquema atual sem wa_saidas e sem groups.admins, com dados.
  const velho = openDb(dir);
  velho.exec('DROP TABLE IF EXISTS wa_saidas');
  if (colunas(velho, 'groups').includes('admins')) velho.exec('ALTER TABLE groups DROP COLUMN admins');
  velho.exec(`
    INSERT INTO settings (key, value) VALUES ('delay_group_s', '9'), ('delay_offer_s', '12');
    INSERT INTO groups (jid, name, size, updated_at, invite_code, is_admin, description)
      VALUES ('g1@g.us', 'Grupo 1', 250, 1, 'abc', 1, 'Ofertas do dia'), ('g2@g.us', 'Grupo 2', 90, 2, NULL, 0, NULL);
    INSERT INTO rules (id, name, group_jids, next_run_at, created_at) VALUES (3, 'Regra', '["g1@g.us"]', 1730000000000, 1);
    INSERT INTO log (ts, rule_id, rule_name, level, group_name, offer_title, message) VALUES (1730000000000, 3, 'Regra', 'ok', 'Grupo 1', 'Fone', 'enviado');
    INSERT INTO envios (id, tipo, payload, group_jids, quando, status, next_run_at, created_at)
      VALUES (5, 'mensagem', '{"texto":"oi"}', '["g1@g.us"]', 'agora', 'pendente', 1730000000000, 1);
  `);
  assert.ok(!existe(velho, 'table', 'wa_saidas') && !existe(velho, 'index', 'idx_wa_saidas_ts'), 'o banco simulado não tem wa_saidas');
  assert.ok(!colunas(velho, 'groups').includes('admins'), 'o banco simulado não tem groups.admins');
  const objetosAntigos = objetosDe(velho);
  const tabelasAntigas = objetosAntigos.filter((o) => o.type === 'table').map((o) => o.name);
  const colunasGruposAntes = semCid(velho, 'groups');
  const antes = {};
  for (const t of tabelasAntigas) antes[t] = linhas(velho, `SELECT * FROM ${t} ORDER BY rowid`);
  velho.close();

  for (let abertura = 1; abertura <= 2; abertura++) {
    const db = openDb(dir);
    conferirProtecao(db, `abertura ${abertura}`);
    for (const t of tabelasAntigas.filter((t) => t !== 'groups')) {
      assert.deepEqual(linhas(db, `SELECT * FROM ${t} ORDER BY rowid`), antes[t], `${t} intacta (abertura ${abertura})`);
    }
    assert.deepEqual(linhas(db, 'SELECT * FROM groups ORDER BY rowid'), antes.groups.map((g) => ({ ...g, admins: null })),
      `grupos intactos, com admins nulo = desconhecido até o próximo sync (abertura ${abertura})`);
    assert.deepEqual(semCid(db, 'groups'), [...colunasGruposAntes, colunaAdmins], `groups só ganha admins no fim (abertura ${abertura})`);
    assert.deepEqual(objetosDe(db).filter((o) => o.tbl_name !== 'wa_saidas' && !(o.type === 'table' && o.name === 'groups')),
      objetosAntigos.filter((o) => !(o.type === 'table' && o.name === 'groups')), `nenhuma outra tabela ou índice muda (abertura ${abertura})`);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM wa_saidas').get().n, 0, `wa_saidas nasce vazia (abertura ${abertura})`);
    db.close();
  }
});

// Não repetir produto parecido (plano nao-repetir-produto-parecido, etapa 1): sent_offers ganha title e price_cents
// (centavos; NULL = desconhecido) no fim, o índice por regra e hora, e os envios antigos do catálogo são preenchidos uma
// vez a partir de catalogo_itens.oferta (título de qualquer item da mesma regra e chave; preço só de item 'enviado').
const COLUNAS_SENT_OFFERS = ['id', 'rule_id', 'offer_key', 'sent_at', 'title', 'price_cents'];

function conferirSentOffers(db, quando) {
  assert.deepEqual(colunas(db, 'sent_offers'), COLUNAS_SENT_OFFERS, `colunas de sent_offers, as novas no fim (${quando})`);
  assert.deepEqual(semCid(db, 'sent_offers').slice(-2), [
    { name: 'title', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'price_cents', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
  ], `title e price_cents aceitam nulo e não têm padrão (${quando})`);
  assert.equal(db.prepare("SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'idx_sent_quando'").get()?.tbl_name, 'sent_offers', `índice por regra e hora (${quando})`);
  assert.deepEqual(db.prepare('PRAGMA index_info(idx_sent_quando)').all().map((c) => c.name), ['rule_id', 'sent_at'], `colunas do índice (${quando})`);
  assert.equal(db.prepare('PRAGMA index_list(sent_offers)').all().find((i) => i.name === 'idx_sent_quando')?.unique, 0, `o índice não é único (${quando})`);
  assert.deepEqual(objetosDe(db).filter((o) => o.tbl_name === 'sent_offers').map((o) => o.name).sort(), ['idx_sent', 'idx_sent_quando', 'sent_offers'],
    `sent_offers só com os dois índices, sem duplicar (${quando})`);
}

/** Banco como o do serviço antes desta etapa: esquema atual sem sent_offers.title/price_cents e sem idx_sent_quando. */
function bancoSemTituloNosEnvios(dir, { manterTitulo = false } = {}) {
  const velho = openDb(dir);
  velho.exec('DROP INDEX IF EXISTS idx_sent_quando');
  for (const col of ['price_cents', ...(manterTitulo ? [] : ['title'])]) {
    if (colunas(velho, 'sent_offers').includes(col)) velho.exec(`ALTER TABLE sent_offers DROP COLUMN ${col}`);
  }
  return velho;
}

test('não repetir parecido etapa 1: banco novo tem sent_offers.title, price_cents e idx_sent_quando; reabrir não cria nem altera nada', () => {
  const dir = tmp();
  const db1 = openDb(dir);
  conferirSentOffers(db1, 'primeira abertura');
  db1.prepare('INSERT INTO sent_offers (rule_id, offer_key, sent_at) VALUES (1, ?, 10)').run('MLB1');
  db1.prepare('INSERT INTO sent_offers (rule_id, offer_key, sent_at, title, price_cents) VALUES (1, ?, 20, ?, ?)').run('MLB2', 'Fone Bluetooth Sem Fio', 4990);
  const esquema = objetosDe(db1);
  const dados = linhas(db1, 'SELECT * FROM sent_offers ORDER BY id');
  assert.deepEqual(dados.map((r) => [r.title, r.price_cents]), [[null, null], ['Fone Bluetooth Sem Fio', 4990]], 'gravação sem título fica com os dois nulos');
  db1.close();

  const db2 = openDb(dir);
  conferirSentOffers(db2, 'segunda abertura');
  assert.deepEqual(objetosDe(db2), esquema, 'reabrir não cria nem altera nada');
  assert.deepEqual(linhas(db2, 'SELECT * FROM sent_offers ORDER BY id'), dados, 'envios intactos ao reabrir');
  db2.close();
});

test('não repetir parecido etapa 1 (CA1, CA4): banco da versão anterior abre sem perder nada e ganha título e preço dos envios do catálogo', () => {
  const dir = tmp();
  const velho = bancoSemTituloNosEnvios(dir);
  const item = velho.prepare('INSERT INTO catalogo_itens (rule_id, chave, loja, status, oferta, criado_em) VALUES (3, ?, ?, ?, ?, 1)');
  const envio = velho.prepare('INSERT INTO sent_offers (rule_id, offer_key, sent_at) VALUES (?, ?, ?)');
  // [chave, loja, status, oferta, título esperado, preço esperado em centavos]
  const casos = [
    ['MLB1', 'ml', 'enviado', '{"title":"Shampoo Lola From Rio 500ml","price":49.9}', 'Shampoo Lola From Rio 500ml', 4990],
    ['MLB2', 'ml', 'enviado', '{"title":"Areia Higiênica Fina 4kg","price":10}', 'Areia Higiênica Fina 4kg', 1000],
    ['MLB3', 'ml', 'enviado', '{"title":"Ração Gatos 1kg","price":19.9}', 'Ração Gatos 1kg', 1990], // 19.9 * 100 = 1989.99…
    ['ASIN:B0X', 'amazon', 'descartado', '{"title":"Cicaplast Baume B5 40ml","price":59.9}', 'Cicaplast Baume B5 40ml', null],
    ['SHOPEE:1.2', 'shopee', 'enviado', '{"title":"Kit Escova Dental","price":"49.90"}', 'Kit Escova Dental', null], // preço em texto
    ['MLB4', 'ml', 'enviado', '{"title":"Fone Sem Preço","price":0}', 'Fone Sem Preço', null],
    ['MLB5', 'ml', 'enviado', '{"title":"Fone Negativo","price":-5}', 'Fone Negativo', null],
    ['MLB6', 'ml', 'enviado', '{"title":"Fone Nulo","price":null}', 'Fone Nulo', null],
    ['MLB7', 'ml', 'enviado', 'isto não é json {', null, null],
    ['MLB8', 'ml', 'enviado', '{"price":25.5}', null, 2550], // oferta sem título
  ];
  for (const [chave, loja, status, oferta] of casos) { item.run(chave, loja, status, oferta); envio.run(3, chave, 1730000000000); }
  envio.run(3, 'MLB999', 1730000000001); // fonte do ML, sem item no catálogo
  envio.run(4, 'MLB1', 1730000000002); // mesma chave em outra regra: o item é da regra 3
  velho.exec(`
    INSERT INTO groups (jid, name, size, updated_at) VALUES ('g1@g.us', 'Grupo 1', 250, 1);
    INSERT INTO rules (id, name, group_jids, dedupe_days, created_at) VALUES (3, 'Catálogo', '["g1@g.us"]', 7, 1), (4, 'ML', '["g1@g.us"]', 3, 1);
    INSERT INTO log (ts, rule_id, rule_name, level, group_name, offer_title, message) VALUES (1730000000000, 3, 'Catálogo', 'ok', 'Grupo 1', 'Fone', 'enviado');
    INSERT INTO envios (id, tipo, payload, group_jids, status, created_at) VALUES (5, 'oferta', '{"oferta":{"title":"Fone"}}', '["g1@g.us"]', 'concluido', 1);
  `);
  assert.ok(!colunas(velho, 'sent_offers').includes('title') && !colunas(velho, 'sent_offers').includes('price_cents'), 'o banco simulado não tem as colunas novas');
  assert.ok(!existe(velho, 'index', 'idx_sent_quando'), 'o banco simulado não tem idx_sent_quando');
  const objetosAntigos = objetosDe(velho);
  const tabelasAntigas = objetosAntigos.filter((o) => o.type === 'table').map((o) => o.name);
  const colunasAntes = semCid(velho, 'sent_offers');
  const antes = {};
  for (const t of tabelasAntigas) antes[t] = linhas(velho, `SELECT * FROM ${t} ORDER BY rowid`);
  velho.close();

  const esperado = [...casos.map(([, , , , title, price_cents]) => ({ title, price_cents })), { title: null, price_cents: null }, { title: null, price_cents: null }];
  for (let abertura = 1; abertura <= 2; abertura++) {
    const db = openDb(dir);
    conferirSentOffers(db, `abertura ${abertura}`);
    assert.deepEqual(semCid(db, 'sent_offers').slice(0, colunasAntes.length), colunasAntes, `as colunas antigas de sent_offers não mudam (abertura ${abertura})`);
    assert.deepEqual(linhas(db, 'SELECT * FROM sent_offers ORDER BY rowid'), antes.sent_offers.map((r, i) => ({ ...r, ...esperado[i] })),
      `envios intactos, com título e preço preenchidos só onde o catálogo tem o dado (abertura ${abertura})`);
    for (const t of tabelasAntigas.filter((t) => t !== 'sent_offers')) {
      assert.deepEqual(linhas(db, `SELECT * FROM ${t} ORDER BY rowid`), antes[t], `${t} intacta (abertura ${abertura})`);
    }
    assert.deepEqual(objetosDe(db).filter((o) => o.name !== 'idx_sent_quando' && o.name !== 'sent_offers'),
      objetosAntigos.filter((o) => o.name !== 'sent_offers'), `nenhuma outra tabela ou índice muda (abertura ${abertura})`);
    db.close();
  }
});

test('não repetir parecido etapa 1: o preenchimento roda uma vez só e nunca troca o que já está gravado', () => {
  const dir = tmp();
  // Banco que já tinha title (abertura interrompida entre os dois ALTER TABLE): o título gravado fica, o preço vem do catálogo.
  const velho = bancoSemTituloNosEnvios(dir, { manterTitulo: true });
  velho.exec(`
    INSERT INTO catalogo_itens (rule_id, chave, loja, status, oferta, criado_em) VALUES
      (3, 'MLB1', 'ml', 'enviado', '{"title":"Título do catálogo","price":49.9}', 1),
      (3, 'MLB2', 'ml', 'enviado', '{"title":"Fone Bluetooth Sem Fio","price":79.9}', 1);
    INSERT INTO sent_offers (rule_id, offer_key, sent_at, title) VALUES (3, 'MLB1', 10, 'Título já gravado'), (3, 'MLB2', 20, NULL);
  `);
  velho.close();

  const db1 = openDb(dir);
  assert.deepEqual(linhas(db1, 'SELECT offer_key, title, price_cents FROM sent_offers ORDER BY id'), [
    { offer_key: 'MLB1', title: 'Título já gravado', price_cents: 4990 },
    { offer_key: 'MLB2', title: 'Fone Bluetooth Sem Fio', price_cents: 7990 },
  ], 'COALESCE: o título gravado não é trocado pelo do catálogo');
  // Depois da migração, envio novo sem título (código antigo) e um apagado à mão: a próxima abertura não preenche de novo.
  db1.exec(`UPDATE sent_offers SET title = NULL, price_cents = NULL WHERE offer_key = 'MLB2';
    INSERT INTO sent_offers (rule_id, offer_key, sent_at) VALUES (3, 'MLB1', 30);`);
  const depois = linhas(db1, 'SELECT * FROM sent_offers ORDER BY id');
  db1.close();

  const db2 = openDb(dir);
  assert.deepEqual(linhas(db2, 'SELECT * FROM sent_offers ORDER BY id'), depois, 'a segunda abertura não refaz o preenchimento');
  db2.close();
});

test('não repetir parecido etapa 1: falha no preenchimento não derruba o openDb, deixa os envios como estavam e não loga a mensagem do banco', (t) => {
  const dir = tmp();
  const velho = bancoSemTituloNosEnvios(dir);
  velho.exec(`
    INSERT INTO catalogo_itens (rule_id, chave, loja, status, oferta, criado_em) VALUES (3, 'MLB1', 'ml', 'enviado', '{"title":"Fone Bluetooth Sem Fio","price":49.9}', 1);
    INSERT INTO sent_offers (rule_id, offer_key, sent_at) VALUES (3, 'MLB1', 10);
    CREATE TRIGGER trava_envios BEFORE UPDATE ON sent_offers BEGIN SELECT RAISE(ABORT, 'Maria 5531999990000'); END;
  `);
  velho.close();
  const erro = t.mock.method(console, 'error', () => {});

  const db1 = openDb(dir);
  assert.deepEqual(colunas(db1, 'sent_offers'), COLUNAS_SENT_OFFERS, 'as colunas novas entram mesmo com a falha');
  assert.ok(existe(db1, 'index', 'idx_sent_quando'), 'o índice novo também');
  assert.deepEqual(linhas(db1, 'SELECT offer_key, title, price_cents FROM sent_offers'), [{ offer_key: 'MLB1', title: null, price_cents: null }],
    'o UPDATE inteiro volta atrás: o envio fica sem título e sem preço (não é comparado)');
  assert.equal(erro.mock.callCount(), 1, 'a falha é avisada uma vez no console');
  const dito = erro.mock.calls[0].arguments.map(String).join(' ');
  assert.match(dito, /^\[db\] .* ERR_SQLITE_ERROR$/, 'só o código do erro');
  assert.doesNotMatch(dito, /Maria|5531999990000/, 'nada da mensagem do banco');
  db1.close();

  const db2 = openDb(dir);
  assert.equal(erro.mock.callCount(), 1, 'a segunda abertura não tenta de novo');
  db2.close();
});

test('anti-banimento etapa 1 (CA5): jitter varia ±VARIACAO_PAUSA em torno do valor, com o aleatório injetável', (t) => {
  assert.equal(util.VARIACAO_PAUSA, 0.3, 'variação de ±30%, a mesma que o /state vai expor');
  // determinístico: as pontas e o meio da faixa
  assert.equal(util.jitter(10, () => 0), 7000, '0 dá o mínimo (−30%)');
  assert.equal(util.jitter(10, () => 0.5), 10000, '0,5 dá o valor de Ajustes');
  assert.equal(util.jitter(10, () => 1), 13000, '1 dá o máximo (+30%)');
  assert.equal(util.jitter(6, () => 0), 4200);
  assert.equal(util.jitter(6, () => 0.25), 5100);
  assert.deepEqual([util.jitter(30, () => 0), util.jitter(30, () => 1)], [21000, 39000], '30 s dá de 21 a 39 s, como na spec');
  assert.equal(util.jitter(0, () => 0.9), 0, 'pausa 0 continua 0');
  // aleatório fora da faixa ou que não é número não faz a pausa sumir nem crescer além de ±30%
  assert.equal(util.jitter(10, () => -5), 7000, 'abaixo de 0 vale 0');
  assert.equal(util.jitter(10, () => 7), 13000, 'acima de 1 vale 1');
  for (const ruim of [NaN, undefined, null, 'x', Infinity, -Infinity]) {
    const j = util.jitter(10, () => ruim);
    assert.ok(j >= 7000 && j <= 13000, `aleatório ${String(ruim)} dá ${j}, dentro da faixa`);
  }
  // sem o segundo argumento, continua usando Math.random (e o agendador reexporta a mesma função)
  const sorteio = t.mock.method(Math, 'random', () => 0);
  assert.equal(jitter(10), 7000, 'Math.random = 0 dá o mínimo');
  sorteio.mock.mockImplementation(() => 0.75);
  assert.equal(util.jitter(10), 11500);
  assert.equal(sorteio.mock.callCount(), 2, 'uma sorteada por pausa');
});

test('anti-banimento etapa 1: inWindow e alignToWindow moram em src/util.js e o agendador só reexporta (padrão R14)', async () => {
  const sched = await import('../src/scheduler.js');
  assert.deepEqual([sched.inWindow, sched.alignToWindow], [util.inWindow, util.alignToWindow], 'a mesma função, não uma cópia');
  assert.equal(typeof util.toMin, 'function');
  assert.deepEqual(['00:00', '07:00', '23:00', '23:59', '7:5'].map(util.toMin), [0, 420, 1380, 1439, 425]);
  const at = (h, m = 0) => new Date(2026, 10, 2, h, m).getTime();
  // o silêncio padrão (23:00 às 07:00) vira a noite: o mesmo cálculo do "Funciona das"
  assert.deepEqual([at(22, 59), at(23), at(3), at(6, 59), at(7)].map((ts) => util.inWindow(ts, '23:00', '07:00')), [false, true, true, true, false]);
  assert.equal(util.alignToWindow(at(12), '23:00', '07:00'), at(23), 'fora do período, o próximo início é no mesmo dia');
  assert.equal(util.alignToWindow(at(7, 30), '07:00', '23:00'), at(7, 30), 'dentro do período, fica onde está');
  assert.equal(util.alignToWindow(at(23, 30), '07:00', '23:00'), new Date(2026, 10, 3, 7, 0).getTime(), 'depois do fim, vai para o início do dia seguinte');
  assert.ok(util.inWindow(at(4), '10:00', '10:00'), 'início igual ao fim é o dia todo');
});

// R1 (docs-do-sistema, rodada 1): a simulação roda o agendador de verdade (encerra agendados vencidos, marca o resumo
// do dia e ofertas como enviadas com links falsos). Por isso, sem DATA_DIR, ela usa data-simulacao/, nunca data/.
test('config: sem DATA_DIR, o serviço normal usa data/ e a simulação (--simular ou DRY_RUN=1) usa data-simulacao/', () => {
  const raiz = path.join(path.sep, 'projeto');
  assert.equal(pastaDeDados({ env: {}, argv: ['node', 'src/server.js'], raiz }), path.join(raiz, 'data'));
  assert.equal(pastaDeDados({ env: {}, argv: ['node', 'src/server.js', '--simular'], raiz }), path.join(raiz, 'data-simulacao'));
  assert.equal(pastaDeDados({ env: { DRY_RUN: '1' }, argv: ['node', 'src/server.js'], raiz }), path.join(raiz, 'data-simulacao'));
  assert.equal(pastaDeDados({ env: { DRY_RUN: '0' }, argv: ['node', 'src/server.js'], raiz }), path.join(raiz, 'data'), 'só DRY_RUN=1 liga a simulação');
  assert.equal(pastaDeDados({ env: { DATA_DIR: '' }, argv: ['node', 'src/server.js', '--simular'], raiz }), path.join(raiz, 'data-simulacao'), 'DATA_DIR vazio é o mesmo que não passar');
  // DATA_DIR explícito vale sempre, com ou sem simulação
  assert.equal(pastaDeDados({ env: { DATA_DIR: '/outra/pasta' }, argv: ['node', 'src/server.js'], raiz }), '/outra/pasta');
  assert.equal(pastaDeDados({ env: { DATA_DIR: '/outra/pasta' }, argv: ['node', 'src/server.js', '--simular'], raiz }), '/outra/pasta');
  assert.equal(pastaDeDados({ env: { DATA_DIR: '/outra/pasta', DRY_RUN: '1' }, argv: [], raiz }), '/outra/pasta');
  assert.equal(modoSimulacao({ env: {}, argv: ['node', 'src/server.js'] }), false);
  assert.equal(modoSimulacao({ env: {}, argv: ['--simular'] }), true);
  assert.equal(modoSimulacao({ env: { DRY_RUN: '1' }, argv: [] }), true);
});

test('config: o módulo carregado de verdade (como o npm start e o npm run simular) escolhe a pasta pelo modo', () => {
  const env = { ...process.env }; delete env.DATA_DIR; delete env.DRY_RUN;
  const ler = (args, extra = {}) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    `const c = await import(${JSON.stringify(new URL('../src/config.js', import.meta.url).href)}); console.log(JSON.stringify([c.DATA_DIR, c.DRY_RUN]));`,
    '--', ...args], { cwd: ROOT, env: { ...env, ...extra }, encoding: 'utf8' }));
  assert.deepEqual(ler([]), [path.join(ROOT, 'data'), false], 'npm start: data/');
  assert.deepEqual(ler(['--simular']), [path.join(ROOT, 'data-simulacao'), true], 'npm run simular: data-simulacao/');
  assert.deepEqual(ler([], { DRY_RUN: '1' }), [path.join(ROOT, 'data-simulacao'), true], 'DRY_RUN=1: data-simulacao/');
  const dir = tmp();
  assert.deepEqual(ler(['--simular'], { DATA_DIR: dir }), [dir, true], 'DATA_DIR explícito vale na simulação');
  assert.deepEqual(ler([], { DATA_DIR: dir }), [dir, false]);
});
