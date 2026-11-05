// QA da feature "grade de horários + Grupo vivo" (plano grade-de-disparos), rodada 1: o que os testes dos dev
// (grade, rotinas, disparador, servidor, *-painel) não cobrem. Foco em "sem derrubar o atual":
//  - corridas e edições no meio do envio (tick x "Enviar agora", duas instâncias, regra salva em outro modo durante a execução);
//  - bordas de horário (30 min exatos, virada do dia, dias desligado, dias da semana desmarcados);
//  - coerência entre `proximo_horario` (API/cartão) e o que de fato sai;
//  - grade e rotina editadas à mão no banco;
//  - rotinas: rodízio/sorteio em volume, grupo apagado, desligar com o horário vencido, repetir ilegível;
//  - estimativa de mensagens por dia (aviso de 400) contra o agendador real;
//  - acesso: rotas novas sem sessão e com Origin de fora.
// Relógio falso só de Date (t.mock.timers) ligado ANTES de criar o agendador (createRotinas guarda Date.now na criação);
// 02/11/2026 é segunda-feira. WhatsApp simulado, links `fake`, lista de ofertas com título e preço (sem rede).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { createScheduler, alignToWindow } from '../src/scheduler.js';
import { createLinkService } from '../src/links.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { buildApp } from '../src/server.js';
import { horarioDe } from '../src/grade.js';

const globalFetch = globalThis.fetch;
let acessosRede = 0;
globalThis.fetch = async () => { acessosRede++; throw new Error('rede proibida no teste'); };

const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-qagrade-')); pastas.push(p); return p; };

const MIN = 60000;
const TODOS = [0, 1, 2, 3, 4, 5, 6];
const dia = (d, h, m = 0, s = 0, ms = 0) => new Date(2026, 10, d, h, m, s, ms).getTime();
const relogio = (t, ts) => t.mock.timers.enable({ apis: ['Date'], now: ts });
const ITEMS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => `https://produto.mercadolivre.com.br/MLB-20000${String(n).padStart(2, '0')}-x | Item ${n} | ${10 * n} | ${20 * n}`).join('\n');

function montar({ grupos = ['111@g.us'], dir = tmp() } = {}) {
  const db = openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const scheduler = createScheduler({ db, wa, links, fast: true });
  const agora = Date.now();
  for (const jid of ['111@g.us', '222@g.us', '333@g.us']) db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, `Grupo ${jid.slice(0, 3)}`, 10, agora);
  db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etiquetaA', agora);
  const regra = (o = {}) => Number(db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id, group_jids, source_type, source_config,
    per_run, interval_min, window_start, window_end, dedupe_days, send_image, created_at, grade, next_run_at)
    VALUES (?,1,1,1,?, 'list', ?, ?, ?, ?, ?, 7, 1, ?, ?, ?)`).run(o.name ?? 'R', JSON.stringify(o.grupos ?? grupos), JSON.stringify({ items: o.items ?? ITEMS }),
    o.per ?? 3, o.interval ?? 60, o.janela?.[0] ?? '00:00', o.janela?.[1] ?? '23:59', agora, o.grade ? JSON.stringify(o.grade) : null, o.next ?? null).lastInsertRowid);
  return { dir, db, wa, links, scheduler, regra };
}
const gradeDe = (...linhas) => ({ dias: [...TODOS], horarios: linhas.map(([hora, qtd, template_id = null]) => ({ hora, qtd, template_id })) });
const linhaRegra = (db, id) => ({ ...db.prepare('SELECT next_run_at, last_run_at, enabled FROM rules WHERE id = ?').get(id) });
const avisosDe = (db) => db.prepare("SELECT message FROM log WHERE level = 'aviso' ORDER BY id").all().map((l) => l.message);
const novoTemplate = (db, nome, prefixo) => Number(db.prepare('INSERT INTO templates (name, body, created_at) VALUES (?,?,?)')
  .run(nome, `${prefixo} {TITULO_PRODUTO}\n{LINK}`, Date.now()).lastInsertRowid);
const titulos = (wa) => wa.simulated.map((m) => m.text.split('\n')[0]);
/** Porta que o teste abre e fecha: o agendador e o WhatsApp são os do `montar`. */
const comPorta = (db, wa, links, scheduler) => {
  const app = buildApp({ db, wa, links, scheduler, publicHost: 'qa.exemplo.com.br', panelPassword: SENHA });
  return new Promise((ok) => {
    const server = app.listen(0, '127.0.0.1', () => ok({ port: server.address().port, fechar: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) }));
  });
};
function chamar(port, caminho, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((ok, err) => {
    const data = body != null ? JSON.stringify(body) : null;
    const h = { host: `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers };
    const r = http.request({ host: '127.0.0.1', port, path: caminho, method, headers: h }, (res) => {
      let txt = ''; res.setEncoding('utf8'); res.on('data', (c) => (txt += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(txt); } catch { /* html */ } ok({ status: res.statusCode, headers: res.headers, json, txt }); });
    });
    r.on('error', err); if (data) r.write(data); r.end();
  });
}
const SENHA = 'senha-de-teste-123';
/** Entra no painel de teste: { cookie, origin } para as chamadas que mudam algo. */
async function entrar(port) {
  const r = await chamar(port, '/api/login', { method: 'POST', body: { senha: SENHA } });
  return { cookie: String(r.headers['set-cookie']?.[0] || '').split(';')[0], origin: `http://127.0.0.1:${port}` };
}
const corpoRegra = (mais = {}) => ({ name: 'Regra QA', enabled: true, tag_id: null, template_id: 1, group_jids: [], sources: [{ type: 'list', config: { items: 'https://x/MLB-1-a' } }], per_run: 4, interval_min: 45, window_start: '07:00', window_end: '20:00', ...mais });
/** Segura a criação do 1º link até `liberar()`: o envio fica "no meio", como um WhatsApp lento. */
function segurarEnvio(links) {
  const pedir = links.requestLink.bind(links);
  let solta; const porta = new Promise((r) => { solta = r; });
  let chegou; const noMeio = new Promise((r) => { chegou = r; });
  let primeiro = true;
  links.requestLink = async (o) => { if (primeiro) { primeiro = false; chegou(); await porta; } return pedir(o); };
  return { noMeio, liberar: () => solta() };
}

// =====================================================================================================================
// Regressão (CA1)
// =====================================================================================================================

test('CA1 rollback: toda coluna de rules que o código anterior lê continua lá, e grade é nula por padrão', () => {
  // a prova com o código antigo de verdade (git archive HEAD) foi feita à mão na rodada 1; aqui fica o que o código novo
  // garante e o rollback precisa: a coluna é só acrescentada, nada que a versão antiga lê foi renomeado ou removido
  const { db } = montar();
  const colunas = db.prepare('PRAGMA table_info(rules)').all().map((c) => c.name);
  for (const c of ['name', 'enabled', 'tag_id', 'template_id', 'group_jids', 'source_type', 'source_config', 'sources', 'min_price', 'max_price',
    'min_discount', 'per_run', 'interval_min', 'window_start', 'window_end', 'dedupe_days', 'send_image', 'next_run_at', 'last_run_at', 'created_at']) {
    assert.ok(colunas.includes(c), `a coluna ${c} continua em rules`);
  }
  assert.equal(db.prepare('PRAGMA table_info(rules)').all().find((c) => c.name === 'grade').notnull, 0, 'grade é nula por padrão');
});

// =====================================================================================================================
// Corridas e edições no meio do envio
// =====================================================================================================================

test('Q1 regra salva em "horários marcados" enquanto roda pelo intervalo: o next_run_at do intervalo não pode sobrar', async (t) => {
  relogio(t, dia(2, 10, 0));
  const s = montar();
  const id = s.regra({ per: 2, interval: 60 }); // sem grade: next_run_at NULL, roda já
  const gate = segurarEnvio(s.links);
  const tick = s.scheduler.tick();
  await gate.noMeio;
  // o dono salva a regra com grade no meio da execução (o PUT grava a grade e zera o next_run_at)
  const grade = gradeDe(['10:30', 1], ['12:00', 2]);
  s.db.prepare('UPDATE rules SET grade = ?, next_run_at = NULL WHERE id = ?').run(JSON.stringify(grade), id);
  gate.liberar();
  await tick;
  assert.equal(s.wa.simulated.length, 2, 'o envio em curso (per_run do intervalo) termina');
  // o tick seguinte (15 s depois) e o horário das 10:30: tem de sair a linha da grade (1 oferta), não esperar o intervalo
  t.mock.timers.setTime(dia(2, 10, 0, 15));
  await s.scheduler.tick();
  assert.equal(s.wa.simulated.length, 2, 'nada novo antes do 10:30');
  t.mock.timers.setTime(dia(2, 10, 30, 5));
  await s.scheduler.tick();
  assert.equal(s.wa.simulated.length, 2 + 1, 'às 10:30 sai 1 oferta (a linha da grade); o next_run_at de agora + intervalo (11:00) engoliu esse horário');
  const depois = linhaRegra(s.db, id).next_run_at;
  assert.ok(horarioDe(grade, depois), 'o próximo gravado é um horário da grade');
});

test('regra desligada e depois ligada durante o envio: não sobrescreve o horário e não trava', async (t) => {
  relogio(t, dia(2, 10, 0, 5));
  const s = montar();
  const id = s.regra({ grade: gradeDe(['10:00', 1], ['11:00', 1]), next: dia(2, 10, 0) });
  const gate = segurarEnvio(s.links);
  const tick = s.scheduler.tick();
  await gate.noMeio;
  s.db.prepare('UPDATE rules SET enabled = 0, next_run_at = NULL WHERE id = ?').run(id); // o liga/desliga zera
  gate.liberar();
  await tick;
  assert.deepEqual(linhaRegra(s.db, id), { next_run_at: null, last_run_at: dia(2, 10, 0, 5), enabled: 0 });
  s.db.prepare('UPDATE rules SET enabled = 1, next_run_at = NULL WHERE id = ?').run(id);
  await s.scheduler.tick();
  assert.equal(linhaRegra(s.db, id).next_run_at, dia(2, 11, 0), 'ligar: o tick calcula o próximo horário sem enviar');
  assert.equal(s.wa.simulated.length, 1);
});

test('regra excluída durante o envio: o agendador termina sem lançar e as outras regras seguem', async (t) => {
  relogio(t, dia(2, 10, 0, 5));
  const s = montar();
  const id = s.regra({ name: 'Apagada', grade: gradeDe(['10:00', 1]), next: dia(2, 10, 0) });
  const outra = s.regra({ name: 'Outra', grupos: ['222@g.us'], grade: gradeDe(['10:00', 1]), next: dia(2, 10, 0) });
  const gate = segurarEnvio(s.links);
  const tick = s.scheduler.tick();
  await gate.noMeio;
  s.db.prepare('DELETE FROM rules WHERE id = ?').run(id);
  gate.liberar();
  await tick;
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM rules WHERE id = ?').get(id).n, 0);
  assert.equal(linhaRegra(s.db, outra).next_run_at, dia(3, 10, 0));
  assert.ok(s.wa.simulated.some((m) => m.jid === '222@g.us'));
});

test('"Enviar agora" no meio de um horário em andamento é recusado e o horário sai uma vez só', async (t) => {
  relogio(t, dia(2, 10, 0, 5));
  const s = montar();
  const id = s.regra({ grade: gradeDe(['10:00', 2], ['11:00', 1]), next: dia(2, 10, 0), per: 5 });
  const gate = segurarEnvio(s.links);
  const tick = s.scheduler.tick();
  await gate.noMeio;
  assert.equal(s.scheduler.isRunning(id), true);
  assert.deepEqual(await s.scheduler.runRule(id, { manual: true }), { skipped: 'já está em andamento' });
  gate.liberar();
  await tick;
  assert.equal(s.wa.simulated.length, 2, 'só as 2 ofertas do horário, sem o manual (5 do per_run)');
  assert.equal(linhaRegra(s.db, id).next_run_at, dia(2, 11, 0));
});

test('horário que vence enquanto o "Enviar agora" roda: o tick não entra, não mexe no horário, e ele sai depois (dentro de 30 min)', async (t) => {
  relogio(t, dia(2, 9, 59, 50));
  const s = montar();
  const id = s.regra({ grade: gradeDe(['10:00', 2], ['11:00', 1]), next: dia(2, 10, 0), per: 4 });
  const gate = segurarEnvio(s.links);
  const manual = s.scheduler.runRule(id, { manual: true });
  await gate.noMeio;
  t.mock.timers.setTime(dia(2, 10, 0, 20));
  await s.scheduler.tick(); // a regra está em andamento: pula
  assert.equal(linhaRegra(s.db, id).next_run_at, dia(2, 10, 0), 'o horário continua guardado');
  gate.liberar();
  await manual;
  assert.equal(s.wa.simulated.length, 2, 'o manual usou a linha do 10:00 (2 ofertas)');
  assert.equal(linhaRegra(s.db, id).next_run_at, dia(2, 10, 0), 'manual não consome o horário');
  t.mock.timers.setTime(dia(2, 10, 0, 40));
  await s.scheduler.tick();
  assert.equal(s.wa.simulated.length, 4, 'o 10:00 sai agora, com atraso de 40 s');
  assert.equal(linhaRegra(s.db, id).next_run_at, dia(2, 11, 0));
});

test('dois ticks juntos (acordar durante o tick) não rodam o mesmo horário duas vezes', async (t) => {
  relogio(t, dia(2, 10, 0, 5));
  const s = montar();
  const id = s.regra({ grade: gradeDe(['10:00', 3], ['11:00', 1]), next: dia(2, 10, 0) });
  await Promise.all([s.scheduler.tick(), s.scheduler.tick(), s.scheduler.tick()]);
  assert.equal(s.wa.simulated.length, 3);
  assert.equal(linhaRegra(s.db, id).next_run_at, dia(2, 11, 0));
});

// =====================================================================================================================
// Bordas de horário
// =====================================================================================================================

test('tolerância: 30 min exatos o horário sai; 1 ms depois é pulado com aviso', async (t) => {
  relogio(t, dia(2, 10, 30));
  const dentro = montar();
  dentro.regra({ grade: gradeDe(['10:00', 1], ['12:00', 1]), next: dia(2, 10, 0) });
  await dentro.scheduler.tick();
  assert.equal(dentro.wa.simulated.length, 1, '30:00,000 de atraso: sai');
  assert.deepEqual(avisosDe(dentro.db), []);

  t.mock.timers.setTime(dia(2, 10, 30, 0, 1));
  const fora = montar();
  const id = fora.regra({ grade: gradeDe(['10:00', 1], ['12:00', 1]), next: dia(2, 10, 0) });
  await fora.scheduler.tick();
  assert.equal(fora.wa.simulated.length, 0, '30:00,001 de atraso: pulado');
  assert.equal(avisosDe(fora.db).length, 1);
  assert.equal(linhaRegra(fora.db, id).next_run_at, dia(2, 12, 0));
});

test('virada do dia: horário das 23:50 de segunda sai 20 min depois, já na terça (dia não marcado), e o próximo é na segunda seguinte', async (t) => {
  relogio(t, dia(3, 0, 10));
  const s = montar();
  const grade = { dias: [1], horarios: [{ hora: '09:00', qtd: 1, template_id: null }, { hora: '23:50', qtd: 2, template_id: null }] };
  const id = s.regra({ grade, next: dia(2, 23, 50) });
  await s.scheduler.tick();
  assert.equal(s.wa.simulated.length, 2, 'o horário é o de segunda; o atraso é de 20 min');
  assert.equal(linhaRegra(s.db, id).next_run_at, dia(9, 9, 0), 'terça a domingo não têm horário');
  await s.scheduler.tick();
  assert.equal(s.wa.simulated.length, 2);
});

test('só domingo: no sábado à noite nada sai, o domingo 00:00 sai e a semana seguinte é a próxima', async (t) => {
  relogio(t, dia(7, 23, 59, 50)); // sábado
  const s = montar();
  const grade = { dias: [0], horarios: [{ hora: '00:00', qtd: 1, template_id: null }, { hora: '12:00', qtd: 1, template_id: null }] };
  const id = s.regra({ grade });
  await s.scheduler.tick();
  assert.equal(linhaRegra(s.db, id).next_run_at, dia(8, 0, 0), 'NULL: grava o próximo (domingo 00:00)');
  t.mock.timers.setTime(dia(8, 0, 0, 5));
  await s.scheduler.tick();
  assert.equal(s.wa.simulated.length, 1);
  assert.equal(linhaRegra(s.db, id).next_run_at, dia(8, 12, 0));
  t.mock.timers.setTime(dia(8, 12, 0, 5));
  await s.scheduler.tick();
  assert.equal(s.wa.simulated.length, 2);
  assert.equal(linhaRegra(s.db, id).next_run_at, dia(15, 0, 0), 'depois do domingo, só no outro domingo');
});

test('programa desligado por dias com 48 horários: nada em rajada, um aviso só e os ticks seguintes ficam quietos', async (t) => {
  relogio(t, dia(7, 9, 7)); // sábado; a regra parou na segunda
  const s = montar();
  const horarios = Array.from({ length: 48 }, (_, k) => [`${String(Math.floor(k / 2)).padStart(2, '0')}:${k % 2 ? '30' : '00'}`, 1]);
  const todos = gradeDe(...horarios);
  const semana = { ...todos, dias: [1, 2, 3, 4, 5] };
  const id = s.regra({ grade: semana, next: dia(2, 9, 0) });
  await s.scheduler.tick();
  assert.equal(s.wa.simulated.length, 0, 'sábado não é dia marcado e a sexta 23:30 passou há muito');
  assert.equal(avisosDe(s.db).length, 1);
  assert.equal(linhaRegra(s.db, id).next_run_at, dia(9, 0, 0));
  for (let i = 1; i <= 5; i++) { t.mock.timers.setTime(dia(7, 9, 7, i * 15)); await s.scheduler.tick(); }
  assert.equal(avisosDe(s.db).length, 1, 'sem aviso repetido');

  // todos os dias: o 09:00 de hoje (7 min) sai uma vez só
  const t2 = montar();
  const id2 = t2.regra({ grade: todos, next: dia(2, 9, 0) });
  await t2.scheduler.tick();
  assert.equal(t2.wa.simulated.length, 1);
  assert.equal(avisosDe(t2.db).length, 1);
  assert.match(avisosDe(t2.db)[0], /horários pulados/);
  assert.equal(linhaRegra(t2.db, id2).next_run_at, dia(7, 9, 30));
});

test('WhatsApp fora por 20 min com vários horários vencidos: ao voltar sai só o último, uma vez', async (t) => {
  relogio(t, dia(2, 10, 25));
  const s = montar();
  const id = s.regra({ grade: gradeDe(['10:00', 1], ['10:10', 2], ['10:20', 3], ['12:00', 1]), next: dia(2, 10, 0) });
  const pronto = s.wa.isReady;
  s.wa.isReady = () => false;
  await s.scheduler.tick();
  assert.equal(s.wa.simulated.length, 0);
  s.wa.isReady = pronto;
  await s.scheduler.tick();
  assert.equal(s.wa.simulated.length, 3, 'o das 10:20 (3 ofertas), não 1+2+3');
  assert.equal(linhaRegra(s.db, id).next_run_at, dia(2, 12, 0));
  await s.scheduler.tick();
  assert.equal(s.wa.simulated.length, 3);
});

// =====================================================================================================================
// Coerência: o que o cartão e a API anunciam é o que sai
// =====================================================================================================================

test('coerência: proximo_horario da API (ts, qtd, template) é exatamente o que o tick envia, em cada estado da regra', async (t) => {
  relogio(t, dia(2, 8, 0));
  const s = montar();
  const A = novoTemplate(s.db, 'Aaa', 'AAA'); const B = novoTemplate(s.db, 'Bbb', 'BBB');
  const grade = gradeDe(['09:00', 2, A], ['10:00', 5], ['11:30', 1, B], ['13:00', 3]);
  const id = s.regra({ per: 7, grade, items: ITEMS });
  const porta = await comPorta(s.db, s.wa, s.links, s.scheduler);
  try {
    const { cookie } = await entrar(porta.port);
    // [agora, next_run_at gravado]
    const estados = [
      [dia(2, 8, 0), null], [dia(2, 8, 0), dia(2, 9, 0)], [dia(2, 9, 10), dia(2, 9, 0)], [dia(2, 9, 31), dia(2, 9, 0)],
      [dia(2, 11, 40), dia(2, 11, 30)], [dia(2, 13, 20), dia(2, 13, 0)], [dia(2, 14, 0), null], [dia(2, 14, 0), dia(2, 9, 0)],
      [dia(3, 7, 0), null], [dia(3, 9, 29), dia(3, 9, 0)],
    ];
    const divergencias = [];
    for (const [agora, next] of estados) {
      s.db.prepare('DELETE FROM sent_offers').run();
      t.mock.timers.setTime(agora);
      s.db.prepare('UPDATE rules SET next_run_at = ?, last_run_at = NULL WHERE id = ?').run(next, id);
      const antes = s.wa.simulated.length;
      const r = (await chamar(porta.port, '/api/rules', { headers: { cookie } })).json.find((x) => x.id === id);
      const ph = r.proximo_horario;
      await s.scheduler.tick();
      if (s.wa.simulated.length === antes) { // não saiu já: sai no horário anunciado
        t.mock.timers.setTime(ph.ts + 2000);
        await s.scheduler.tick();
      }
      const novas = s.wa.simulated.slice(antes);
      const prefixo = novas[0]?.text.startsWith('AAA') ? A : novas[0]?.text.startsWith('BBB') ? B : null;
      const real = { qtd: novas.length, template_id: prefixo };
      const anunciado = { qtd: ph.qtd, template_id: ph.template_id };
      if (real.qtd !== anunciado.qtd || real.template_id !== anunciado.template_id) divergencias.push({ agora: new Date(agora).toString().slice(0, 21), next, anunciado, real });
    }
    assert.deepEqual(divergencias, []);
  } finally { await porta.fechar(); }
});

test('Q2 coerência com a grade editada à mão: o que o cartão anuncia (qtd, template, horário) tem de ser o que o agendador usa', async (t) => {
  // casos que só existem com o banco editado à mão (a API normaliza); proximoDaGrade (server) e o agendador devem concordar
  const casos = {
    'hora sem zero à esquerda': { hora: '9:00', qtd: 2, template_id: null },
    'qtd acima de 20': { hora: '09:00', qtd: 99, template_id: null },
    'qtd como texto': { hora: '09:00', qtd: '2', template_id: null },
  };
  const divergencias = {};
  relogio(t, dia(2, 8, 0));
  for (const [nome, linha] of Object.entries(casos)) {
    t.mock.timers.setTime(dia(2, 8, 0));
    const s = montar();
    const id = s.regra({ per: 5, grade: { dias: TODOS, horarios: [linha, { hora: '15:00', qtd: 1, template_id: null }] } });
    const porta = await comPorta(s.db, s.wa, s.links, s.scheduler);
    try {
      const { cookie } = await entrar(porta.port);
      const ph = (await chamar(porta.port, '/api/rules', { headers: { cookie } })).json.find((x) => x.id === id).proximo_horario;
      t.mock.timers.setTime(dia(2, 8, 30));
      s.db.prepare('UPDATE rules SET next_run_at = ? WHERE id = ?').run(dia(2, 9, 0), id);
      t.mock.timers.setTime(dia(2, 9, 1));
      await s.scheduler.tick();
      const saiu = s.wa.simulated.length;
      if (!ph || ph.qtd !== saiu) divergencias[nome] = { anunciado: ph && { hora: ph.hora, qtd: ph.qtd }, saiu };
    } finally { await porta.fechar(); }
  }
  assert.deepEqual(divergencias, {});
});

// =====================================================================================================================
// Rotinas do Grupo vivo
// =====================================================================================================================

const rotinaBase = (o = {}) => ({
  nome: 'Bom dia', tipo: 'mensagem', conteudos: ['um', 'dois', 'tres'], ordem: 'rodizio', group_jids: ['111@g.us'],
  repetir: { dias: TODOS, horarios: ['08:00'] }, ...o,
});
const enviosDeRotina = (db) => db.prepare('SELECT * FROM envios ORDER BY id').all().map((e) => ({ ...e, payload: JSON.parse(e.payload) }));

test('rodízio: depois de editar para menos textos o índice não estoura, e depois de aumentar volta a andar na ordem', async (t) => {
  relogio(t, dia(2, 7, 0));
  const s = montar();
  const { id } = s.scheduler.rotinas.criar(rotinaBase({ conteudos: ['a', 'b', 'c', 'd', 'e'] }));
  const sair = async (ts) => { t.mock.timers.setTime(ts); await s.scheduler.rotinas.processarPendentes(); };
  await sair(dia(2, 8, 0, 5)); await sair(dia(3, 8, 0, 5)); await sair(dia(4, 8, 0, 5)); await sair(dia(5, 8, 0, 5));
  assert.deepEqual(enviosDeRotina(s.db).map((e) => e.payload.texto), ['a', 'b', 'c', 'd']);
  s.scheduler.rotinas.atualizar(id, { conteudos: ['x', 'y'] }); // proximo_indice = 4
  await sair(dia(6, 8, 0, 5)); await sair(dia(7, 8, 0, 5));
  assert.deepEqual(enviosDeRotina(s.db).slice(4).map((e) => e.payload.texto), ['x', 'y'], '4 % 2 = 0: começa do primeiro');
  s.scheduler.rotinas.atualizar(id, { conteudos: ['x', 'y', 'z'] });
  await sair(dia(8, 8, 0, 5)); await sair(dia(9, 8, 0, 5));
  assert.deepEqual(enviosDeRotina(s.db).slice(6).map((e) => e.payload.texto), ['x', 'y'], 'o índice já tinha voltado a 0 com 2 textos; com 3 segue na ordem');
});

test('sorteio: em 600 ocorrências nunca repete o texto anterior e todos os textos aparecem (2 a 5 textos)', async (t) => {
  relogio(t, dia(2, 7, 0));
  for (const n of [2, 3, 5]) {
    const s = montar();
    const textos = Array.from({ length: n }, (_, k) => `texto ${k}`);
    const { id } = s.scheduler.rotinas.criar(rotinaBase({ conteudos: textos, ordem: 'sorteio' }));
    const vistos = [];
    for (let i = 0; i < 200; i++) {
      s.db.prepare('UPDATE rotinas SET next_run_at = ? WHERE id = ?').run(dia(2, 8, 0), id);
      t.mock.timers.setTime(dia(2, 8, 0, 5));
      await s.scheduler.rotinas.processarPendentes();
    }
    for (const e of enviosDeRotina(s.db)) vistos.push(e.payload.texto);
    assert.equal(vistos.length, 200);
    for (let i = 1; i < vistos.length; i++) assert.notEqual(vistos[i], vistos[i - 1], `repetiu na posição ${i} com ${n} textos`);
    assert.equal(new Set(vistos).size, n, `todos os ${n} textos saem`);
  }
});

test('grupo apagado: um aviso, nenhum envio, o horário avança e os ticks seguintes não repetem o aviso', async (t) => {
  relogio(t, dia(2, 8, 0, 5));
  const s = montar();
  const { id } = s.scheduler.rotinas.criar(rotinaBase({ group_jids: ['111@g.us', '222@g.us'] }));
  s.db.prepare('UPDATE rotinas SET next_run_at = ? WHERE id = ?').run(dia(2, 8, 0), id);
  s.db.prepare("DELETE FROM groups WHERE jid IN ('111@g.us','222@g.us')").run();
  for (let i = 0; i < 4; i++) { t.mock.timers.setTime(dia(2, 8, 0, 5 + i * 15)); await s.scheduler.tick(); }
  assert.equal(enviosDeRotina(s.db).length, 0);
  assert.equal(avisosDe(s.db).length, 1);
  assert.equal(s.db.prepare('SELECT next_run_at FROM rotinas WHERE id = ?').get(id).next_run_at, dia(3, 8, 0));
  assert.equal(s.wa.simulated.length, 0);
});

test('desligar a rotina com o horário vencido e o WhatsApp fora: ao voltar nada sai', async (t) => {
  relogio(t, dia(2, 8, 5));
  const s = montar();
  const { id } = s.scheduler.rotinas.criar(rotinaBase());
  s.db.prepare('UPDATE rotinas SET next_run_at = ? WHERE id = ?').run(dia(2, 8, 0), id);
  const pronto = s.wa.isReady;
  s.wa.isReady = () => false;
  await s.scheduler.tick();
  assert.equal(enviosDeRotina(s.db).length, 0);
  s.scheduler.rotinas.ativar(id, false);
  s.wa.isReady = pronto;
  t.mock.timers.setTime(dia(2, 8, 10));
  await s.scheduler.tick();
  assert.equal(enviosDeRotina(s.db).length, 0);
  assert.equal(s.wa.simulated.length, 0);
});

test('rotina com repetir ilegível no banco: não derruba o tick, nem as outras rotinas, nem as regras, e não envia em loop', async (t) => {
  relogio(t, dia(2, 8, 0, 5));
  const s = montar();
  const erros = []; const antes = console.error; console.error = (...a) => erros.push(a.join(' '));
  t.after(() => { console.error = antes; });
  const ruim = ['null', '{}', 'isto não é json', '{"dias":"x","horarios":5}'].map((repetir, i) => {
    const { id } = s.scheduler.rotinas.criar(rotinaBase({ nome: `Ruim ${i}` }));
    s.db.prepare('UPDATE rotinas SET repetir = ?, next_run_at = ? WHERE id = ?').run(repetir, dia(2, 8, 0), id);
    return id;
  });
  const boa = s.scheduler.rotinas.criar(rotinaBase({ nome: 'Boa', group_jids: ['222@g.us'] })).id;
  s.db.prepare('UPDATE rotinas SET next_run_at = ? WHERE id = ?').run(dia(2, 8, 0), boa);
  const regra = s.regra({ grade: gradeDe(['08:00', 1]), next: dia(2, 8, 0), grupos: ['333@g.us'] });
  for (let i = 0; i < 6; i++) { t.mock.timers.setTime(dia(2, 8, 0, 5 + i * 15)); await s.scheduler.tick(); }
  assert.equal(s.wa.simulated.filter((m) => m.jid === '222@g.us').length, 1, 'a rotina boa saiu uma vez');
  assert.equal(s.wa.simulated.filter((m) => m.jid === '333@g.us').length, 1, 'a regra saiu uma vez');
  assert.equal(linhaRegra(s.db, regra).next_run_at, dia(3, 8, 0));
  const deRuins = enviosDeRotina(s.db).filter((e) => e.payload.origem.rotina_id !== boa);
  assert.ok(deRuins.length <= ruim.length, `no máximo a ocorrência que já estava vencida, uma por rotina: ${deRuins.length}`);
  for (const id of ruim) assert.equal(s.db.prepare('SELECT next_run_at FROM rotinas WHERE id = ?').get(id).next_run_at, null, 'rotina sem próximo horário válido fica parada, não em loop');
  assert.ok(erros.every((e) => !/@g\.us|um|dois/.test(e.replace(/rotina|grupo vivo|undefined/gi, ''))), `console sem JID nem texto: ${erros.join(' | ')}`);
});

test('Histórico e erros das rotinas e da grade nunca levam JID de grupo nem número', async (t) => {
  relogio(t, dia(2, 10, 0, 5));
  const s = montar({ grupos: ['111@g.us', '222@g.us'] });
  s.regra({ grade: gradeDe(['10:00', 8], ['10:10', 1]), next: dia(2, 10, 0) });
  const { id } = s.scheduler.rotinas.criar(rotinaBase({ group_jids: ['111@g.us', '333@g.us'] }));
  s.db.prepare("UPDATE rotinas SET next_run_at = ? WHERE id = ?").run(dia(2, 9, 0), id); // vencido há 65 min: pulado, com aviso
  await s.scheduler.tick();
  t.mock.timers.setTime(dia(2, 11, 0));
  await s.scheduler.tick();
  const msgs = s.db.prepare('SELECT message, group_name, rule_name FROM log').all().flatMap((l) => [l.message, l.rule_name]);
  assert.ok(msgs.length >= 3);
  assert.deepEqual(msgs.filter((m) => /@g\.us|@s\.whatsapp|\b55\d{10,11}\b/.test(String(m))), []);
});

// =====================================================================================================================
// Estimativa de mensagens por dia (aviso de 400): contra o agendador de verdade
// =====================================================================================================================

test('CA13: a estimativa de uma regra por intervalo é o número real de execuções por dia (alignToWindow) vezes ofertas e grupos', () => {
  const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const ctx = { S: { st: {} } };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(raiz, 'public/grade.js'), 'utf8') + '\n;globalThis.__f = { gradeMensagensRegra, gradeMensagensDia };', ctx);
  const { gradeMensagensRegra } = ctx.__f;
  const janelas = [['00:00', '23:59'], ['08:00', '22:00'], ['20:00', '02:00'], ['09:30', '09:30'], ['06:15', '18:45'], ['22:00', '06:00']];
  const falhas = [];
  for (const [ini, fim] of janelas) {
    for (const iv of [1, 7, 10, 15, 30, 45, 50, 60, 90, 120, 180, 600, 900, 1440, 3000]) {
      // execuções por dia no regime: a partir do início da janela, next = alignToWindow(agora + iv), contadas em 14 dias
      const base = new Date(2026, 10, 2, Number(ini.slice(0, 2)), Number(ini.slice(3)), 0, 0).getTime();
      let tt = alignToWindow(base, ini, fim); let n = 0; const fimDoPeriodo = base + 14 * 86400000;
      while (tt < fimDoPeriodo && n < 100000) { n++; tt = alignToWindow(tt + iv * MIN, ini, fim); }
      const real = n / 14;
      const est = gradeMensagensRegra({ group_jids: ['a'], per_run: 1, interval_min: iv, window_start: ini, window_end: fim });
      // a estimativa pode superestimar um pouco (conservadora), nunca subestimar em mais de uma execução por dia
      if (est < real - 1) falhas.push(`${ini}-${fim} a cada ${iv} min: real ${real.toFixed(1)}/dia, estimado ${est}`);
    }
  }
  assert.deepEqual(falhas, []);
});

// =====================================================================================================================
// Acesso
// =====================================================================================================================

test('segurança: as rotas novas (rotinas e regras com grade) exigem sessão e recusam Origin de fora', async () => {
  const s = montar();
  const porta = await comPorta(s.db, s.wa, s.links, s.scheduler);
  try {
    const sem = [
      ['GET', '/api/rotinas'], ['POST', '/api/rotinas'], ['PUT', '/api/rotinas/1'], ['DELETE', '/api/rotinas/1'],
      ['POST', '/api/rotinas/1/enabled'], ['POST', '/api/rotinas/1/enviar'], ['GET', '/api/rules'], ['PUT', '/api/rules/1'],
    ];
    for (const [method, caminho] of sem) {
      const r = await chamar(porta.port, caminho, { method, body: method === 'GET' ? undefined : {} });
      assert.equal(r.status, 401, `${method} ${caminho} sem login`);
    }
    const login = await chamar(porta.port, '/api/login', { method: 'POST', body: { senha: SENHA } });
    const cookie = String(login.headers['set-cookie']?.[0] || '').split(';')[0];
    assert.ok(cookie);
    for (const [method, caminho] of sem.filter(([m]) => m !== 'GET')) {
      const r = await chamar(porta.port, caminho, { method, headers: { cookie, origin: 'https://site-malvado.example' }, body: {} });
      assert.equal(r.status, 403, `${method} ${caminho} com Origin de fora`);
    }
    const host = await chamar(porta.port, '/api/rotinas', { headers: { cookie, host: 'malvado.example' } });
    assert.equal(host.status, 403);
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM rotinas').get().n, 0);
  } finally { await porta.fechar(); }
});

test('a API de rotinas e de regras não devolve JID de grupo em mensagem de erro e a rotina com grupo inexistente é recusada com a frase', async () => {
  const s = montar();
  const porta = await comPorta(s.db, s.wa, s.links, s.scheduler);
  try {
    const login = await chamar(porta.port, '/api/login', { method: 'POST', body: { senha: 'senha-de-teste-123' } });
    const cookie = String(login.headers['set-cookie']?.[0] || '').split(';')[0];
    const origin = `http://127.0.0.1:${porta.port}`;
    const r = await chamar(porta.port, '/api/rotinas', { method: 'POST', headers: { cookie, origin }, body: rotinaBase({ group_jids: ['999@g.us'] }) });
    assert.equal(r.status, 400);
    assert.doesNotMatch(r.txt, /999@g\.us/);
    const g = await chamar(porta.port, '/api/rules', { method: 'POST', headers: { cookie, origin }, body: corpoRegra({ grade: { dias: [1], horarios: [{ hora: '99:99', qtd: 1 }] } }) });
    assert.equal(g.status, 400);
    assert.equal(g.json.erro, 'Horário inválido: use HH:MM.');
  } finally { await porta.fechar(); }
});

test('CA8 pela API: "Enviar agora" e "Ver ofertas" de uma regra com grade usam a linha do próximo horário e não consomem o horário', async (t) => {
  relogio(t, dia(2, 9, 30));
  const s = montar();
  const A = novoTemplate(s.db, 'Aaa', 'AAA');
  const id = s.regra({ per: 7, grade: gradeDe(['09:00', 1], ['10:00', 2, A]), next: dia(2, 10, 0) });
  const porta = await comPorta(s.db, s.wa, s.links, s.scheduler);
  try {
    const { cookie, origin } = await entrar(porta.port);
    const previa = await chamar(porta.port, `/api/rules/${id}/offers`, { headers: { cookie } });
    assert.equal(previa.status, 200);
    assert.equal(previa.json.length, 2);
    assert.ok(previa.json.every((o) => o.text.startsWith('AAA ')));
    const rodar = await chamar(porta.port, `/api/rules/${id}/run`, { method: 'POST', headers: { cookie, origin }, body: {} });
    assert.deepEqual(rodar.json, { iniciado: true });
    // o /run é "dispare e esqueça": espera (relógio real; o falso é só o Date) o envio terminar
    for (let i = 0; i < 300 && (s.scheduler.isRunning(id) || s.wa.simulated.length < 2); i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(titulos(s.wa).map((l) => l.slice(0, 4)), ['AAA ', 'AAA ']);
    assert.equal(linhaRegra(s.db, id).next_run_at, dia(2, 10, 0));
    const lista = (await chamar(porta.port, '/api/rules', { headers: { cookie } })).json.find((x) => x.id === id);
    assert.deepEqual([lista.proximo_horario.hora, lista.proximo_horario.qtd, lista.proximo_horario.template_id], ['10:00', 2, A]);
  } finally { await porta.fechar(); }
});

test('CA10: template usado numa grade não é apagado nem com o template_id gravado como texto; a frase cita a regra e o horário', async () => {
  const s = montar();
  const A = novoTemplate(s.db, 'Aaa', 'AAA');
  s.regra({ name: 'Promoções', grade: { dias: TODOS, horarios: [{ hora: '10:00', qtd: 1, template_id: String(A) }] } });
  const porta = await comPorta(s.db, s.wa, s.links, s.scheduler);
  try {
    const { cookie, origin } = await entrar(porta.port);
    const r = await chamar(porta.port, `/api/templates/${A}`, { method: 'DELETE', headers: { cookie, origin } });
    assert.equal(r.status, 400);
    assert.equal(r.json.erro, 'A regra "Promoções" usa este template no horário 10:00.');
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM templates WHERE id = ?').get(A).n, 1);
  } finally { await porta.fechar(); }
});

test('P15: o Operador cria e muda regra com grade e rotinas do Grupo vivo (mesmos direitos do Disparo automático)', async () => {
  const s = montar();
  const porta = await comPorta(s.db, s.wa, s.links, s.scheduler);
  try {
    const dono = await entrar(porta.port);
    const convite = await chamar(porta.port, '/api/equipe/convites', { method: 'POST', headers: { cookie: dono.cookie, origin: dono.origin }, body: { email: 'bia@exemplo.com', papel: 'operador' } });
    assert.equal(convite.status, 201, convite.txt);
    const aceite = await chamar(porta.port, '/api/convite/aceitar', { method: 'POST', body: { token: convite.json.link.split('#')[1], nome: 'Bia', senha: 'senha-da-bia-123' } });
    assert.equal(aceite.status, 200, aceite.txt);
    const bia = { cookie: String(aceite.headers['set-cookie']?.[0] || '').split(';')[0], origin: dono.origin };
    const h = { cookie: bia.cookie, origin: bia.origin };
    const regra = await chamar(porta.port, '/api/rules', { method: 'POST', headers: h, body: corpoRegra({ group_jids: ['111@g.us'], grade: gradeDe(['09:00', 2]) }) });
    assert.equal(regra.status, 200, regra.txt);
    const rot = await chamar(porta.port, '/api/rotinas', { method: 'POST', headers: h, body: rotinaBase() });
    assert.equal(rot.status, 200, rot.txt);
    assert.equal((await chamar(porta.port, `/api/rotinas/${rot.json.id}/enabled`, { method: 'POST', headers: h, body: { enabled: false } })).status, 200);
    assert.equal((await chamar(porta.port, `/api/rotinas/${rot.json.id}`, { method: 'PUT', headers: h, body: { nome: 'Bom dia 2' } })).status, 200);
    assert.equal((await chamar(porta.port, `/api/rotinas/${rot.json.id}`, { method: 'DELETE', headers: h })).status, 200);
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM rotinas').get().n, 0);
  } finally { await porta.fechar(); }
});

test('nenhum acesso à rede no arquivo inteiro', () => {
  globalThis.fetch = globalFetch;
  assert.equal(acessosRede, 0);
});
