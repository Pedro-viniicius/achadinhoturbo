// QA do cartão 05 "Anti-banimento" (rodada 1): bordas que os testes de cada etapa (ritmo*.test.js) não cruzam.
// Relógio falso só no Date (ligado ANTES de criar o agendador), timers reais; WhatsApp simulado; links falsos; sem rede.
// 02/11/2026 é segunda-feira. Q1 a Q3 (abertos como `todo` na rodada 1) foram corrigidos e valem como teste normal.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openDb, addLog } from '../src/db.js';
import { createScheduler } from '../src/scheduler.js';
import { createRitmo, validarProtecao, ERRO_LIMITE_HORA } from '../src/ritmo.js';
import { createLinkService } from '../src/links.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { buildApp, criarServicos } from '../src/server.js';
import { createEnvios } from '../src/envios.js';

const globalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('rede proibida no teste'); };
const pastas = [];
after(() => { globalThis.fetch = globalFetch; for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-qa-ab-')); pastas.push(p); return p; };

const HORA = 3600000;
const MIN = 60000;
const TODOS = [0, 1, 2, 3, 4, 5, 6];
const dia = (d, h, m = 0, s = 0, ms = 0) => new Date(2026, 10, d, h, m, s, ms).getTime();
const relogio = (t, ts) => t.mock.timers.enable({ apis: ['Date'], now: ts });
const ITEMS = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `https://produto.mercadolivre.com.br/MLB-30000${n}-x | Item ${n} | ${10 * n} | ${20 * n}`).join('\n');
const GRUPOS = ['111@g.us', '222@g.us', '333@g.us', '444@g.us'];
const PROTECAO = 'Proteção do número';

function montar({ fast = true, limite, silencio } = {}) {
  const dir = tmp();
  const db = openDb(dir);
  const set = (k, v) => db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, String(v));
  if (limite != null) set('wa_limite_hora', limite);
  if (silencio) { set('wa_silencio_ativo', '1'); set('wa_silencio_de', silencio[0]); set('wa_silencio_ate', silencio[1]); }
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const scheduler = createScheduler({ db, wa, links, fast });
  const agora = Date.now();
  for (const jid of GRUPOS) db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, `Grupo ${jid.slice(0, 3)}`, 10, agora);
  db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etiquetaA', agora);
  // tudo que vai ao WhatsApp, com a hora do relógio falso (o embrulho chama wa.sendText no momento do envio)
  const enviadas = [];
  for (const fn of ['sendText', 'sendImage', 'sendPoll']) {
    const original = wa[fn].bind(wa);
    wa[fn] = async (jid, ...resto) => { const r = await original(jid, ...resto); enviadas.push({ fn, jid, texto: typeof resto[0] === 'string' ? resto[0] : '', t: Date.now() }); return r; };
  }
  const regra = (o = {}) => Number(db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id, group_jids, source_type, source_config,
    per_run, interval_min, window_start, window_end, dedupe_days, send_image, created_at, next_run_at, grade)
    VALUES (?,1,1,1,?, 'list', ?, ?, ?, ?, ?, 7, 0, ?, ?, ?)`).run(o.name ?? 'R', JSON.stringify(o.grupos ?? ['111@g.us']), JSON.stringify({ items: ITEMS }),
    o.per ?? 1, o.interval ?? 60, '00:00', '00:00', agora, o.next ?? null, o.grade ? JSON.stringify(o.grade) : null).lastInsertRowid);
  const gravar = ({ tipo = 'mensagem', texto = 'Oi', origem = null, extra = {}, jids = GRUPOS.slice(0, 1), quando = 'agora', repetir = null, em }) =>
    Number(db.prepare(`INSERT INTO envios (tipo, payload, group_jids, quando, repetir, status, next_run_at, user_id, created_at)
      VALUES (?,?,?,?,?,'pendente',?,NULL,?)`).run(tipo, JSON.stringify({ texto, imagem: 'nenhuma', ...(origem ? { origem } : {}), ...extra }), JSON.stringify(jids), quando,
      repetir ? JSON.stringify(repetir) : null, em, em).lastInsertRowid);
  return { dir, db, wa, links, scheduler, regra, gravar, enviadas };
}
const logs = (db) => db.prepare('SELECT rule_name, level, message FROM log ORDER BY id').all().map((l) => ({ ...l }));
const semErro = (db) => assert.deepEqual(logs(db).filter((l) => l.level === 'erro'), [], 'nenhuma linha erro (erro dispara o alerta por WhatsApp)');
const envio = (db, id) => ({ ...db.prepare('SELECT status, next_run_at, resultado FROM envios WHERE id = ?').get(id) });
const saidasNoBanco = (db) => Number(db.prepare('SELECT COUNT(*) AS n FROM wa_saidas').get().n);
const gradeDe = (...horas) => ({ dias: [...TODOS], horarios: horas.map(([hora, qtd = 1]) => ({ hora, qtd, template_id: null })) });

/** Maior número de mensagens em qualquer janela de 60 min (hora de saída das mensagens, em ms). */
function picoPorHora(ts) {
  let pico = 0;
  for (const a of ts) pico = Math.max(pico, ts.filter((b) => b >= a && b < a + HORA).length);
  return pico;
}

// ---------- silêncio: limites exatos e virada da noite ----------

test('CA6 borda: 23:00:00.000 já é silêncio, 22:59:59.999 não; 07:00:00.000 já não é, 06:59:59.999 ainda é (ate_ts exato)', () => {
  const db = openDb(tmp());
  db.prepare("INSERT INTO settings (key, value) VALUES ('wa_silencio_ativo','1'),('wa_silencio_de','23:00'),('wa_silencio_ate','07:00')").run();
  const r = createRitmo({ db });
  assert.equal(r.silencio(dia(2, 22, 59, 59, 999)).agora, false);
  assert.equal(r.silencio(dia(2, 23, 0, 0, 0)).agora, true);
  assert.equal(r.silencio(dia(2, 23, 0, 0, 0)).ate_ts, dia(3, 7, 0));
  assert.equal(r.silencio(dia(3, 0, 0, 0, 0)).ate_ts, dia(3, 7, 0), 'depois da meia-noite o fim é o mesmo dia');
  assert.equal(r.silencio(dia(3, 6, 59, 59, 999)).agora, true);
  assert.equal(r.silencio(dia(3, 6, 59, 59, 999)).ate_ts, dia(3, 7, 0));
  assert.equal(r.silencio(dia(3, 7, 0, 0, 0)).agora, false);
  assert.equal(r.silencio(dia(3, 7, 0, 0, 0)).ate_ts, null);
  assert.deepEqual(r.liberado(dia(3, 6, 59, 59, 999)), { ok: false, motivo: 'silencio', ate: dia(3, 7, 0) });
  assert.deepEqual(r.liberado(dia(3, 7, 0, 0, 0)), { ok: true });
  // silêncio que não vira a noite (01:00 às 05:00) e o "mesmo assim" que ignora só o silêncio
  db.prepare("UPDATE settings SET value = '01:00' WHERE key = 'wa_silencio_de'").run();
  db.prepare("UPDATE settings SET value = '05:00' WHERE key = 'wa_silencio_ate'").run();
  assert.equal(r.silencio(dia(3, 0, 59, 59, 999)).agora, false);
  assert.equal(r.silencio(dia(3, 1, 0)).agora, true);
  assert.equal(r.silencio(dia(3, 4, 59, 59, 999)).agora, true);
  assert.equal(r.silencio(dia(3, 5, 0)).agora, false);
  assert.equal(r.liberado(dia(3, 2, 0), { ignorarSilencio: true }).ok, true);
});

test('CA1 borda: a janela de 60 min é aberta no começo — a saída de exatamente 1 h atrás já não conta, 1 ms antes ainda conta', () => {
  const db = openDb(tmp());
  db.prepare("INSERT INTO settings (key, value) VALUES ('wa_limite_hora','3')").run();
  const t0 = dia(2, 10, 0);
  for (const dt of [0, 10 * MIN, 20 * MIN]) db.prepare('INSERT INTO wa_saidas (ts) VALUES (?)').run(t0 + dt);
  const r = createRitmo({ db });
  assert.deepEqual(r.liberado(t0 + HORA - 1), { ok: false, motivo: 'limite', ate: t0 + HORA, limite: 3, usados: 3 });
  assert.equal(r.liberado(t0 + HORA).ok, true, 'a vaga volta no milissegundo anunciado em libera_em');
  assert.equal(r.uso(t0 + HORA - 1).libera_em, t0 + HORA);
  assert.equal(r.uso(t0 + HORA).usados, 2);
});

test('reinício do serviço: um ritmo novo no mesmo banco continua com a contagem e com a mesma hora de liberação', () => {
  const dir = tmp();
  const t0 = dia(2, 10, 0);
  const db = openDb(dir);
  db.prepare("INSERT INTO settings (key, value) VALUES ('wa_limite_hora','2')").run();
  const a = createRitmo({ db, agora: () => t0 });
  a.registrar(); a.registrar();
  const antes = a.uso(t0 + 5 * MIN);
  db.close();
  const db2 = openDb(dir); // o `--watch` reinicia o processo: nada em memória sobrevive
  const b = createRitmo({ db: db2, agora: () => t0 + 5 * MIN });
  assert.deepEqual(b.uso(), antes);
  assert.equal(b.uso().usados, 2);
  assert.equal(b.liberado(t0 + 5 * MIN).ok, false);
  assert.equal(b.liberado(t0 + HORA).ok, true);
  db2.close();
});

test('relógio voltando 30 min depois do envio: as saídas "do futuro" continuam contando (conservador) e o teto segue valendo', () => {
  const db = openDb(tmp());
  db.prepare("INSERT INTO settings (key, value) VALUES ('wa_limite_hora','3')").run();
  const t0 = dia(2, 10, 0);
  let agora = t0;
  const r = createRitmo({ db, agora: () => agora });
  r.registrar(); r.registrar(); r.registrar();
  agora = t0 - 30 * MIN; // acerto do relógio do computador
  assert.equal(r.uso().usados, 3);
  const lib = r.liberado();
  assert.equal(lib.ok, false);
  assert.ok(lib.ate > agora && lib.ate <= t0 + HORA, 'a vaga volta no máximo 1 h depois da hora gravada');
  agora = lib.ate;
  assert.equal(r.liberado().ok, true);
});

test('CA4/CA5: 20 mensagens ao mesmo tempo (várias origens) saem uma depois da outra, nunca a menos que 70% da pausa uma da outra', async () => {
  const db = openDb(tmp());
  db.prepare("INSERT INTO settings (key, value) VALUES ('delay_group_s','6')").run();
  // tempo virtual: dormir(ms) só acorda quando o teste avança o relógio monotônico até a hora marcada
  let m = 0; const inicios = []; const dormindo = [];
  const r = createRitmo({ db, aleatorio: () => 0, monotonico: () => m, agora: () => dia(2, 10), dormir: (ms) => new Promise((ok) => dormindo.push({ em: m + ms, ok })) });
  const wa = { async sendText() { inicios.push(m); }, async sendImage() { inicios.push(m); }, async sendPoll() { inicios.push(m); } };
  const e = r.embrulhar(wa);
  const todas = Promise.all(Array.from({ length: 20 }, (_, i) => (i % 3 === 0 ? e.sendText('g', 'x') : i % 3 === 1 ? e.sendImage('g', 'u', 'c') : e.sendPoll('g', {}))));
  for (let i = 0; i < 100; i++) {
    await new Promise((ok) => setImmediate(ok));
    if (!dormindo.length) continue;
    dormindo.sort((x, y) => x.em - y.em);
    const prox = dormindo.shift(); m = Math.max(m, prox.em); prox.ok();
  }
  await todas;
  assert.equal(inicios.length, 20);
  for (let i = 1; i < inicios.length; i++) assert.ok(inicios[i] - inicios[i - 1] >= 4200, `saída ${i} só ${inicios[i] - inicios[i - 1]} ms depois da anterior`);
});

// ---------- validação ----------

test('validarProtecao: números em formatos estranhos não passam (texto com lixo, expoente, hexadecimal, fração, lista, booleano)', () => {
  for (const ruim of ['40abc', '1e2', '0x10', 40.5, [], [40], {}, true, '', ' ', '-5', 0, 201, '٤٠', '40.0', Number.MAX_SAFE_INTEGER + 2, Infinity]) {
    assert.throws(() => validarProtecao({ limite_hora: ruim }), { message: ERRO_LIMITE_HORA }, JSON.stringify(ruim));
  }
  assert.equal(validarProtecao({ limite_hora: ' 40 ' }).limite_hora, 40);
  assert.equal(validarProtecao({ limite_hora: '0040' }).limite_hora, 40);
  assert.equal(validarProtecao({ limite_hora: 200 }).limite_hora, 200);
  assert.equal(validarProtecao({ limite_hora: 1 }).limite_hora, 1);
  // corpo que não é objeto não grava nada
  for (const corpo of [null, undefined, 'x', 5, [1]]) assert.deepEqual(validarProtecao(corpo), {});
});

// ---------- teto e silêncio na fila e nas regras, cruzados ----------

test('CA2: teto 5 com três envios de origens diferentes e uma regra: ao longo das horas nada se perde nem duplica e nenhuma hora passa de 5', async (t) => {
  relogio(t, dia(2, 10, 0));
  const s = montar({ limite: 5 });
  const g3 = GRUPOS.slice(0, 3);
  const manual = s.gravar({ texto: 'M', jids: g3, em: Date.now() });
  const espelho = s.gravar({ texto: 'E', jids: g3, origem: { tipo: 'espelho', espelho_id: 1, nome: 'Amazon' }, em: Date.now() });
  const remetente = s.gravar({ texto: 'R', jids: g3, origem: { tipo: 'remetente', nome: 'Socio' }, em: Date.now() });
  s.regra({ name: 'Regra', grupos: ['444@g.us'], per: 1, interval: 100000 });
  for (let i = 0; i <= 24; i++) { t.mock.timers.setTime(dia(2, 10, 0) + i * 10 * MIN); await s.scheduler.tick(); }
  // cada (texto, grupo) saiu exatamente uma vez
  const por = new Map();
  for (const e of s.enviadas) por.set(`${e.texto.slice(0, 1)}|${e.jid}`, (por.get(`${e.texto.slice(0, 1)}|${e.jid}`) ?? 0) + 1);
  for (const [k, n] of por) assert.equal(n, 1, `${k} saiu ${n} vezes`);
  for (const [id, nome] of [[manual, 'manual'], [espelho, 'espelho'], [remetente, 'remetente']]) {
    assert.equal(envio(s.db, id).status, 'concluido', nome);
    assert.equal(s.enviadas.filter((e) => e.texto.startsWith({ manual: 'M', espelho: 'E', remetente: 'R' }[nome])).length, 3, nome);
  }
  assert.equal(s.enviadas.filter((e) => e.jid === '444@g.us').length >= 1, true, 'a regra também saiu depois que a fila deixou vaga');
  assert.ok(picoPorHora(s.enviadas.map((e) => e.t)) <= 5, `pico de ${picoPorHora(s.enviadas.map((e) => e.t))} em 60 min`);
  assert.equal(saidasNoBanco(s.db), s.enviadas.length, 'o contador é o que de fato saiu');
  const doTeto = logs(s.db).filter((l) => l.rule_name === PROTECAO);
  assert.ok(doTeto.length >= 1 && doTeto.every((l) => l.level === 'aviso' && /^Limite de 5 mensagens por hora atingido: o que falta sai a partir das \d\d:\d\d\.$/.test(l.message)), JSON.stringify(doTeto));
  semErro(s.db);
});

test('CA2/CA6: teto e silêncio juntos: o que o teto segurou às 22:58 sai às 07:00:00.000 só para quem faltava, e nada sai antes, nem em 06:59:59.999', async (t) => {
  relogio(t, dia(2, 22, 58));
  const s = montar({ limite: 2, silencio: ['23:00', '07:00'] });
  const id = s.gravar({ texto: 'Boa noite', jids: GRUPOS.slice(0, 3), em: Date.now() });
  await s.scheduler.tick();
  assert.deepEqual(s.enviadas.map((e) => e.jid), ['111@g.us', '222@g.us'], 'o teto segura o 3º grupo');
  assert.equal(envio(s.db, id).status, 'pendente');
  for (const quando of [dia(2, 23, 0, 0, 0), dia(3, 3, 0), dia(3, 6, 59, 59, 999)]) { t.mock.timers.setTime(quando); await s.scheduler.tick(); }
  assert.equal(s.enviadas.length, 2, 'nada sai no silêncio, até o último milissegundo');
  t.mock.timers.setTime(dia(3, 7, 0, 0, 0));
  await s.scheduler.tick();
  assert.deepEqual(s.enviadas.map((e) => e.jid), ['111@g.us', '222@g.us', '333@g.us'], 'só o grupo que faltava, às 07:00');
  assert.equal(envio(s.db, id).status, 'concluido');
  semErro(s.db);
});

test('CA6: fila com tudo junto às 22:59:59 — "agora" espera e sai às 07:00, agendado do silêncio é pulado, repetido vai para a próxima ocorrência', async (t) => {
  relogio(t, dia(2, 23, 0, 0, 0));
  const s = montar({ silencio: ['23:00', '07:00'] });
  const agora = s.gravar({ texto: 'A', em: dia(2, 22, 59, 59) });
  const agendado = s.gravar({ texto: 'G', quando: 'agendado', em: dia(2, 23, 30) });
  const repetido = s.gravar({ texto: 'P', quando: 'repetir', repetir: { dias: TODOS, horarios: ['23:30'] }, em: dia(2, 23, 30) });
  t.mock.timers.setTime(dia(2, 23, 30)); await s.scheduler.tick();
  assert.deepEqual(s.enviadas, []);
  assert.equal(envio(s.db, agendado).status, 'erro');
  assert.equal(envio(s.db, agora).status, 'pendente');
  assert.deepEqual([envio(s.db, repetido).status, envio(s.db, repetido).next_run_at], ['pendente', dia(3, 23, 30)]);
  t.mock.timers.setTime(dia(3, 7, 0)); await s.scheduler.tick();
  assert.deepEqual(s.enviadas.map((e) => e.texto), ['A'], 'só o "agora" saiu; o repetido só vale às 23:30');
  assert.equal(envio(s.db, agora).status, 'concluido');
  assert.equal(saidasNoBanco(s.db), 1);
  semErro(s.db);
});

test('CA6: o "agora" de 2 dias atrás perde o horário mesmo com o silêncio, e o motivo não é o do silêncio (nada se perde sem aviso)', async (t) => {
  relogio(t, dia(4, 8, 0));
  const s = montar({ silencio: ['23:00', '07:00'] });
  const velho = s.gravar({ texto: 'Velho', em: dia(2, 8, 0) });
  await s.scheduler.tick();
  assert.equal(envio(s.db, velho).status, 'erro');
  assert.match(JSON.parse(envio(s.db, velho).resultado).motivo, /passou mais de 2 h/);
  assert.equal(s.enviadas.length, 0);
});

test('CA6 grade: o horário 23:00 cai no silêncio (pulado), o 07:00 sai, e o 22:59 visto às 22:59:50 sai', async (t) => {
  relogio(t, dia(2, 22, 59, 50));
  const s = montar({ silencio: ['23:00', '07:00'] });
  const a = s.regra({ name: 'A', grade: gradeDe(['22:59', 1], ['23:00', 1], ['07:00', 1]), next: dia(2, 22, 59) });
  await s.scheduler.tick();
  assert.equal(s.enviadas.length, 1, '22:59 sai');
  const proximo = db_next(s.db, a);
  assert.equal(proximo, dia(2, 23, 0));
  t.mock.timers.setTime(dia(2, 23, 0, 0, 0));
  await s.scheduler.tick();
  assert.equal(s.enviadas.length, 1, '23:00 é silêncio');
  assert.equal(db_next(s.db, a), dia(3, 7, 0));
  assert.ok(logs(s.db).some((l) => l.level === 'aviso' && l.message === 'Horário 23:00 pulado: horário de silêncio.'));
  t.mock.timers.setTime(dia(3, 7, 0, 0, 0));
  await s.scheduler.tick();
  assert.equal(s.enviadas.length, 2, '07:00 sai');
  semErro(s.db);
});
const db_next = (db, id) => db.prepare('SELECT next_run_at FROM rules WHERE id = ?').get(id).next_run_at;

// ---------- privado nunca preso ----------

test('CA4: o alerta de erro por WhatsApp (privado) sai com o teto cheio e no silêncio, e conta no teto', async (t) => {
  relogio(t, dia(2, 23, 30));
  const s = montar({ limite: 1, silencio: ['23:00', '07:00'] });
  s.db.prepare('INSERT INTO wa_saidas (ts) VALUES (?)').run(Date.now());
  s.db.prepare('INSERT INTO aviso_destinos (nome, jid, avisos, ativo, created_at) VALUES (?,?,?,?,?)').run('Eu', '5511900000000@s.whatsapp.net', JSON.stringify(['erro']), 1, 1);
  await s.scheduler.avisos.tick(); // 1ª vez só marca o cursor do log
  addLog(s.db, { rule: { id: null, name: 'Regra' }, level: 'erro', message: 'Falha no envio: teste' });
  t.mock.timers.setTime(dia(2, 23, 40));
  await s.scheduler.avisos.tick();
  assert.deepEqual(s.enviadas.map((e) => e.jid), ['5511900000000@s.whatsapp.net'], 'o alerta saiu, apesar do teto cheio e do silêncio');
  assert.equal(saidasNoBanco(s.db), 2, 'e contou');
});

// ---------- teto: regra com mais grupos que o teto ----------

test('Q1 (corrigido): regra com mais grupos que o teto para no teto (4 grupos, teto 2): uma vaga por grupo', async (t) => {
  relogio(t, dia(2, 10, 0));
  const s = montar({ limite: 2 });
  s.regra({ grupos: GRUPOS, per: 1 });
  await s.scheduler.tick();
  assert.ok(s.enviadas.length <= 2, `saíram ${s.enviadas.length} mensagens com o teto em 2 por hora`);
});

test('Q2/S1 (corrigido): duas execuções ao mesmo tempo ("Enviar agora" de duas regras) não passam da última vaga do teto: a vaga é separada na conferência', async (t) => {
  relogio(t, dia(2, 10, 0));
  const s = montar({ limite: 40 });
  for (let i = 0; i < 39; i++) s.db.prepare('INSERT INTO wa_saidas (ts) VALUES (?)').run(Date.now() - 5 * MIN);
  const a = s.regra({ name: 'A', grupos: ['111@g.us'] });
  const b = s.regra({ name: 'B', grupos: ['222@g.us'] });
  // as duas passam pela checagem e esperam no mesmo ponto (geração do link), como no modo extensão
  let libera; const portao = new Promise((r) => { libera = r; }); let chegaram = 0;
  const original = s.links.requestLink.bind(s.links);
  s.links.requestLink = async (...args) => { chegaram++; await portao; return original(...args); };
  const pa = s.scheduler.runRule(a, { manual: true });
  const pb = s.scheduler.runRule(b, { manual: true });
  const fim = Date.now();
  for (let i = 0; i < 200 && chegaram < 2; i++) await new Promise((r) => setTimeout(r, 5));
  libera();
  await Promise.all([pa, pb]);
  assert.ok(fim);
  assert.ok(saidasNoBanco(s.db) <= 40, `${saidasNoBanco(s.db)} mensagens na última hora com teto 40`);
});

// ---------- fila: hora marcada que venceu no silêncio mas só foi vista depois dele ----------

test('Q3 (corrigido): envio agendado/repetido de 06:50 visto às 07:05 (serviço desligado de madrugada) é pulado, como na grade', async (t) => {
  relogio(t, dia(3, 7, 5));
  const s = montar({ silencio: ['23:00', '07:00'] });
  const agendado = s.gravar({ texto: 'G', quando: 'agendado', em: dia(3, 6, 50) });
  const repetido = s.gravar({ texto: 'P', quando: 'repetir', repetir: { dias: TODOS, horarios: ['06:50'] }, em: dia(3, 6, 50) });
  await s.scheduler.tick();
  assert.deepEqual(s.enviadas, [], 'a hora marcada (06:50) era silêncio: é pulada, como a da grade');
  assert.equal(envio(s.db, agendado).status, 'erro');
  assert.equal(envio(s.db, repetido).next_run_at, dia(4, 6, 50));
});

// ---------- servidor: ignorar_silencio forjado, estado, validação em bloco ----------

function req(port, caminho, { method = 'GET', body } = {}) {
  return new Promise((ok, err) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) };
    const r = http.request({ host: '127.0.0.1', port, path: caminho, method, headers: h }, (res) => {
      let txt = ''; res.setEncoding('utf8'); res.on('data', (c) => (txt += c));
      res.on('end', () => { let j = null; try { j = JSON.parse(txt); } catch { /* texto */ } ok({ status: res.statusCode, json: j, txt }); });
    });
    r.on('error', err); if (data) r.write(data); r.end();
  });
}
async function subir(t) {
  relogio(t, dia(2, 12, 0));
  const dir = tmp(); const db = openDb(dir);
  db.prepare("INSERT INTO settings (key, value) VALUES ('wa_silencio_ativo','1'),('wa_silencio_de','23:00'),('wa_silencio_ate','07:00'),('wa_limite_hora','40')").run();
  for (const jid of GRUPOS) db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, `G${jid.slice(0, 3)}`, 5, 1);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const s = criarServicos({ db, wa, links, fast: true, dir, fetch: async () => { throw new Error('sem rede'); } });
  const app = buildApp({ db, wa, links, scheduler: s.scheduler, amazon: s.amazon, shopee: s.shopee, catalogo: s.catalogo, catalogoItens: s.catalogoItens, publicHost: null, panelPassword: '', dataDir: dir });
  const server = await new Promise((ok) => { const sv = app.listen(0, '127.0.0.1', () => ok(sv)); });
  t.after(() => { s.scheduler.stop?.(); server.closeAllConnections?.(); server.close(); db.close(); });
  return { db, port: server.address().port, scheduler: s.scheduler };
}

test('CA7 segurança: ignorar_silencio forjado — agendado e repetir dão 400; "agora" só liga com o booleano true; origem forjada no corpo não vira origem do envio', async (t) => {
  const s = await subir(t);
  const base = { tipo: 'mensagem', texto: 'Oi', group_jids: ['111@g.us'] };
  const futuro = new Date(Date.now() + 3 * HORA).toISOString().slice(0, 16);
  for (const extra of [{ quando: 'agendado', quando_em: futuro, agendar_para: futuro, hora: futuro }, { quando: 'repetir', repetir: { dias: TODOS, horarios: ['12:00'] } }]) {
    const r = await req(s.port, '/api/envios', { method: 'POST', body: { ...base, ...extra, ignorar_silencio: true } });
    assert.equal(r.status, 400, `${extra.quando}: ${r.txt}`);
    assert.match(r.json?.erro ?? '', /Só o envio "agora" pode sair no horário de silêncio/);
  }
  assert.equal(Number(s.db.prepare('SELECT COUNT(*) AS n FROM envios').get().n), 0, 'nenhum envio criado pelos pedidos recusados');
  // "agora": só o true liga; o resto é gravado sem o campo
  const gravado = async (v, extraCorpo = {}) => {
    const r = await req(s.port, '/api/envios', { method: 'POST', body: { ...base, quando: 'agora', ignorar_silencio: v, ...extraCorpo } });
    assert.equal(r.status, 200, r.txt);
    return JSON.parse(s.db.prepare('SELECT payload FROM envios WHERE id = ?').get(r.json.id ?? r.json.dados?.id).payload);
  };
  assert.equal((await gravado(true)).ignorar_silencio, true);
  for (const v of ['true', 1, 'sim', {}, [], 0, false, null]) assert.equal((await gravado(v)).ignorar_silencio, undefined, JSON.stringify(v));
  const forjado = await gravado(true, { origem: { tipo: 'rotina', nome: 'X' } });
  assert.equal(forjado.origem, undefined, 'a origem do envio é do servidor, nunca do corpo');
  await new Promise((r) => setTimeout(r, 50)); // deixa o tick que o "agora" acordou terminar antes de fechar o banco
});

test('CA1/CA6: PUT /api/protecao com corpo estranho (lista, texto) não grava nada e não derruba; e os padrões não mudam', async (t) => {
  const s = await subir(t);
  const antes = JSON.stringify(s.db.prepare("SELECT key, value FROM settings WHERE key LIKE 'wa_%' OR key LIKE 'delay_%' ORDER BY key").all());
  for (const corpo of [[], [1, 2], 'x', 7, null, {}, { limite_hora: null, silencio_ativo: null }]) {
    const r = await req(s.port, '/api/protecao', { method: 'PUT', body: corpo });
    assert.ok([200, 400].includes(r.status), `${JSON.stringify(corpo)} → ${r.status}`);
  }
  assert.equal(JSON.stringify(s.db.prepare("SELECT key, value FROM settings WHERE key LIKE 'wa_%' OR key LIKE 'delay_%' ORDER BY key").all()), antes);
  assert.equal(logs(s.db).filter((l) => l.rule_name === PROTECAO).length, 0, 'sem mudança, sem linha no Histórico');
  const st = await req(s.port, '/api/state');
  assert.equal(st.json.protecao.variacao_pausa, 0.3);
  assert.equal(st.json.protecao.limite_hora, 40);
});

test('CA2/CA3: teto cheio reduzido pelo Dono em Ajustes vale na hora (teto 40 → 1 com 3 mensagens na última hora): o envio espera e há UMA linha aviso', async (t) => {
  const s = await subir(t);
  for (let i = 0; i < 3; i++) s.db.prepare('INSERT INTO wa_saidas (ts) VALUES (?)').run(Date.now() - 10 * MIN);
  const r = await req(s.port, '/api/protecao', { method: 'PUT', body: { limite_hora: 1 } });
  assert.equal(r.status, 200, r.txt);
  const e = await req(s.port, '/api/envios', { method: 'POST', body: { tipo: 'mensagem', texto: 'Oi', group_jids: ['111@g.us'], quando: 'agora' } });
  assert.equal(e.status, 200, e.txt);
  await s.scheduler.tick(); await s.scheduler.tick(); await s.scheduler.tick();
  const id = e.json.id ?? e.json.dados?.id;
  assert.equal(envio(s.db, id).status, 'pendente');
  const avisos = logs(s.db).filter((l) => l.rule_name === PROTECAO && l.message.startsWith('Limite de 1 mensagens'));
  assert.equal(avisos.length, 1, JSON.stringify(avisos));
  assert.equal(avisos[0].level, 'aviso');
  semErro(s.db);
});

// ---------- migração e reinício no meio de um envio ----------

test('migração: um banco da versão anterior (sem wa_saidas e sem groups.admins) ganha os dois ao abrir, sem perder os grupos', () => {
  const dir = tmp();
  let db = openDb(dir);
  db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run('1@g.us', 'Antigo', 3, 1);
  db.exec('DROP TABLE wa_saidas; ALTER TABLE groups DROP COLUMN admins;');
  db.close();
  db = openDb(dir);
  const colunas = db.prepare('PRAGMA table_info(groups)').all().map((c) => c.name);
  assert.ok(colunas.includes('admins'));
  assert.equal(db.prepare('SELECT admins FROM groups WHERE jid = ?').get('1@g.us').admins, null, 'NULL = desconhecido: o painel não mostra selo');
  assert.deepEqual(db.prepare('PRAGMA table_info(wa_saidas)').all().map((c) => c.name), ['ts']);
  const r = createRitmo({ db });
  r.registrar();
  assert.equal(r.uso().usados, 1);
  db.close();
  openDb(dir).close(); // abrir de novo não falha (idempotente)
});

test('reinício no meio do envio com o teto: o que ficou "enviando" volta, quem já recebeu não recebe de novo e a contagem da hora é a do banco', async (t) => {
  relogio(t, dia(2, 10, 0));
  const s = montar({ limite: 3 });
  const id = s.gravar({ texto: 'Meio', jids: GRUPOS.slice(0, 3), em: dia(2, 10, 0) });
  // o serviço caiu depois de entregar a 111 e a 222 (já contadas no teto)
  s.db.prepare("UPDATE envios SET status = 'enviando' WHERE id = ?").run(id);
  for (const jid of ['111@g.us', '222@g.us']) {
    s.db.prepare('INSERT INTO envio_resultados (envio_id, ocorrencia, ts, jid, group_name, ok, erro) VALUES (?,?,?,?,?,1,NULL)').run(id, dia(2, 10, 0), Date.now(), jid, 'G');
    s.db.prepare('INSERT INTO wa_saidas (ts) VALUES (?)').run(Date.now());
  }
  const novo = createScheduler({ db: s.db, wa: s.wa, links: s.links, fast: true }); // processo novo: nada em memória
  assert.equal(await novo.envios.recuperar(), 1);
  await novo.tick();
  assert.deepEqual(s.enviadas.map((e) => e.jid), ['333@g.us'], 'só o grupo que faltava');
  assert.equal(envio(s.db, id).status, 'concluido');
  assert.equal(novo.ritmo.uso().usados, 3);
  assert.equal(novo.ritmo.liberado().ok, false, 'o teto de 3 já está cheio com o que saiu antes e depois do reinício');
});

// ---------- rodada 1 de correções: S1/Q2 (reserva), R1 (prazo pelo teto), R2 (Grupo vivo), R4 (409), "a verificar" ----------

/** Segura a geração do link de todas as execuções até `libera()`: todas passam pela conferência antes de qualquer saída. */
function portaoNoLink(s) {
  let libera; const portao = new Promise((r) => { libera = r; }); const st = { chegaram: 0 };
  const original = s.links.requestLink.bind(s.links);
  s.links.requestLink = async (...args) => { st.chegaram++; await portao; return original(...args); };
  return { st, libera };
}
const esperarAte = async (cond) => { for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 5)); };

test('S1/Q2: cinco "Enviar agora" ao mesmo tempo (regras diferentes) com teto 3: só as vagas do teto saem, e o resto é barrado na hora', async (t) => {
  relogio(t, dia(2, 10, 0));
  const s = montar({ limite: 3 });
  s.db.prepare('INSERT INTO wa_saidas (ts) VALUES (?)').run(Date.now() - 5 * MIN);
  const ids = GRUPOS.concat(['111@g.us']).map((jid, i) => s.regra({ name: `R${i}`, grupos: [jid] }));
  const { st, libera } = portaoNoLink(s);
  const corridas = ids.map((id) => s.scheduler.runRule(id, { manual: true }));
  await esperarAte(() => st.chegaram >= 2);
  libera();
  const r = await Promise.all(corridas);
  assert.equal(saidasNoBanco(s.db), 3, 'nunca passa do teto: 1 antiga + 2 vagas');
  assert.equal(s.enviadas.length, 2);
  assert.equal(r.filter((x) => x.parou === 'limite').length, 3, 'os outros três foram barrados antes de começar');
  assert.equal(st.chegaram, 2, 'os barrados nem pedem link');
  semErro(s.db);
});

test('S1: "Enviar agora" segura a vaga enquanto gera o link; o "agora" da fila no tick espera em vez de passar junto', async (t) => {
  relogio(t, dia(2, 10, 0));
  const s = montar({ limite: 2 });
  s.db.prepare('INSERT INTO wa_saidas (ts) VALUES (?)').run(Date.now() - 5 * MIN);
  const a = s.regra({ name: 'A', grupos: ['111@g.us'] });
  const { st, libera } = portaoNoLink(s);
  const pa = s.scheduler.runRule(a, { manual: true });
  await esperarAte(() => st.chegaram >= 1);
  const id = s.gravar({ texto: 'Fila', jids: ['222@g.us'], em: Date.now() });
  await s.scheduler.tick();
  assert.equal(envio(s.db, id).status, 'pendente', 'a vaga separada pela regra já conta para a fila');
  libera(); await pa;
  assert.deepEqual(s.enviadas.map((e) => e.jid), ['111@g.us']);
  assert.equal(saidasNoBanco(s.db), 2);
});

test('S1: vaga separada e não usada volta ao teto (execução sem ofertas, envio que falha)', async (t) => {
  relogio(t, dia(2, 10, 0));
  const s = montar({ limite: 1 });
  const vazia = Number(s.db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id, group_jids, source_type, source_config, per_run, interval_min,
    window_start, window_end, dedupe_days, send_image, created_at) VALUES ('Vazia',1,1,1,?,'list',?,1,60,'00:00','00:00',7,0,?)`)
    .run(JSON.stringify(['111@g.us']), JSON.stringify({ items: '' }), Date.now()).lastInsertRowid);
  await s.scheduler.runRule(vazia, { manual: true });
  assert.equal(s.scheduler.ritmo.liberado().ok, true, 'sem oferta nenhuma: a vaga voltou');
  const r = s.regra({ name: 'Falha', grupos: ['111@g.us'] });
  s.wa.sendText = async () => { throw new Error('timeout'); };
  await s.scheduler.runRule(r, { manual: true });
  assert.equal(saidasNoBanco(s.db), 0);
  assert.equal(s.scheduler.ritmo.liberado().ok, true, 'falha do envio: a vaga voltou no fim');
});

test('R1: teto 1 ocupado das 09:00 às 11:01 segura o envio do espelho das 09:00 por mais de 2 h: termina com aviso e o motivo do teto, nenhuma linha erro', async (t) => {
  relogio(t, dia(2, 9, 0));
  const s = montar({ limite: 1 });
  const id = s.gravar({ texto: 'Espelho', origem: { tipo: 'espelho', espelho_id: 1, nome: 'Amazon' }, em: dia(2, 9, 0) });
  for (const m of [0, 30, 60, 90, 120]) {
    t.mock.timers.setTime(dia(2, 9, m));
    s.db.prepare('INSERT INTO wa_saidas (ts) VALUES (?)').run(Date.now()); // outra origem ocupa o teto
    await s.scheduler.tick();
  }
  t.mock.timers.setTime(dia(2, 11, 1));
  await s.scheduler.tick();
  assert.deepEqual(s.enviadas, []);
  assert.equal(envio(s.db, id).status, 'erro');
  assert.equal(JSON.parse(envio(s.db, id).resultado).motivo, 'o limite de 1 mensagens por hora ficou cheio por mais de 2 h.');
  assert.ok(logs(s.db).some((l) => l.level === 'aviso' && l.message === 'Não enviado: o limite de 1 mensagens por hora ficou cheio por mais de 2 h.'), JSON.stringify(logs(s.db)));
  semErro(s.db);
});

test('R1: o mesmo prazo vencido sem o teto (WhatsApp fora) continua erro com o motivo de sempre', async (t) => {
  relogio(t, dia(2, 9, 0));
  const s = montar({ limite: 1 });
  const id = s.gravar({ texto: 'Fora', em: dia(2, 9, 0) });
  s.db.prepare('INSERT INTO wa_saidas (ts) VALUES (?)').run(Date.now());
  await s.scheduler.tick(); // o teto segura
  s.wa.isReady = () => false;
  t.mock.timers.setTime(dia(2, 10, 30)); await s.scheduler.tick(); // o teto já abriu: quem segura é o WhatsApp
  t.mock.timers.setTime(dia(2, 11, 1)); await s.scheduler.tick();
  assert.equal(envio(s.db, id).status, 'erro');
  assert.match(JSON.parse(envio(s.db, id).resultado).motivo, /perdeu o horário: passou mais de 2 h/);
});

test('"a verificar": na retomada depois do teto, o grupo cujo envio lançou (pode ter saído) não é tentado de novo na mesma ocorrência', async (t) => {
  relogio(t, dia(2, 10, 0));
  const s = montar({ limite: 1 });
  const id = s.gravar({ texto: 'Uma vez', jids: GRUPOS.slice(0, 3), em: Date.now() });
  const antes = s.wa.sendText; let lancou = false;
  // entrega ao 111 e lança mesmo assim (o Baileys pode estourar o tempo depois de mandar)
  s.wa.sendText = async (jid, ...resto) => { const r = await antes(jid, ...resto); if (jid === '111@g.us' && !lancou) { lancou = true; throw new Error('Timed Out'); } return r; };
  await s.scheduler.tick();
  assert.deepEqual(s.enviadas.map((e) => e.jid), ['111@g.us', '222@g.us'], 'o 333 ficou para quando o teto abrir');
  assert.equal(envio(s.db, id).status, 'pendente');
  t.mock.timers.setTime(dia(2, 11, 1));
  await s.scheduler.tick();
  assert.deepEqual(s.enviadas.map((e) => e.jid), ['111@g.us', '222@g.us', '333@g.us'], 'o 111 não recebe duas vezes');
  assert.equal(envio(s.db, id).status, 'erro', 'a falha do 111 continua contando no fim da ocorrência');
  assert.deepEqual(JSON.parse(envio(s.db, id).resultado), { ok: 2, erro: 1 });
});

test('R2: "Enviar agora" do Grupo vivo no silêncio é recusado com a frase, sem gravar envio nem avançar o rodízio; fora dele sai', async (t) => {
  relogio(t, dia(2, 23, 30));
  const s = montar({ silencio: ['23:00', '07:00'] });
  const { id } = s.scheduler.rotinas.criar({ nome: 'Bom dia', tipo: 'mensagem', conteudos: ['Bom dia!', 'Olá!'], ordem: 'rodizio', group_jids: ['111@g.us'], repetir: { dias: TODOS, horarios: ['08:00'] } });
  const indice = () => s.db.prepare('SELECT proximo_indice FROM rotinas WHERE id = ?').get(id).proximo_indice;
  const antes = indice();
  assert.throws(() => s.scheduler.rotinas.enviarAgora(id), (e) => e.status === 400 && e.message === 'Horário de silêncio até 07:00: o Enviar agora do Grupo vivo não sai agora.');
  assert.equal(Number(s.db.prepare('SELECT COUNT(*) AS n FROM envios').get().n), 0, 'nada gravado');
  assert.equal(indice(), antes, 'o rodízio não andou');
  t.mock.timers.setTime(dia(3, 7, 0));
  assert.equal(s.scheduler.rotinas.enviarAgora(id).grupos, 1, 'o recusado não conta no freio de um minuto');
  assert.notEqual(indice(), antes);
});

test('R4: POST /api/rules/:id/run barrado pelo teto ou pelo silêncio responde 409 com a frase do Histórico; liberado, 200', async (t) => {
  const s = await subir(t);
  const regra = Number(s.db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id, group_jids, source_type, source_config, per_run, interval_min,
    window_start, window_end, dedupe_days, send_image, created_at) VALUES ('R',1,NULL,1,?,'list',?,1,60,'00:00','00:00',7,0,?)`)
    .run(JSON.stringify(['111@g.us']), JSON.stringify({ items: '' }), Date.now()).lastInsertRowid);
  const ok = await req(s.port, `/api/rules/${regra}/run`, { method: 'POST', body: {} });
  assert.deepEqual([ok.status, ok.json], [200, { iniciado: true }]);
  await new Promise((r) => setTimeout(r, 30));
  for (let i = 0; i < 40; i++) s.db.prepare('INSERT INTO wa_saidas (ts) VALUES (?)').run(dia(2, 11, 30));
  const teto = await req(s.port, `/api/rules/${regra}/run`, { method: 'POST', body: {} });
  assert.deepEqual([teto.status, teto.json], [409, { erro: 'Enviar agora não saiu: limite de 40 mensagens por hora atingido; há vaga a partir das 12:30.' }]);
  s.db.exec('DELETE FROM wa_saidas');
  t.mock.timers.setTime(dia(2, 23, 30));
  const sil = await req(s.port, `/api/rules/${regra}/run`, { method: 'POST', body: {} });
  assert.deepEqual([sil.status, sil.json], [409, { erro: 'Enviar agora não saiu: horário de silêncio até 07:00.' }]);
  assert.equal(Number(s.db.prepare("SELECT COUNT(*) AS n FROM log WHERE message LIKE 'Enviar agora não saiu:%'").get().n), 2, 'e a linha do Histórico continua');
});

/** Gira o relógio falso dos timers aos poucos (as promessas entre um timer e outro andam) até `cond()` ou `ms`. */
async function girar(t, ms, cond) {
  for (let feito = 0; feito < ms && !cond(); feito += 1000) {
    t.mock.timers.tick(1000);
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  }
}

test('S2: delay_group_s=600 gravado à mão vale 60 s nas pausas da regra (agendador) e da fila sem ritmo, nunca 600', async (t) => {
  t.mock.method(Math, 'random', () => 1); // a ponta de cima do sorteio: 1,3 × a pausa
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dir = tmp(); const db = openDb(dir);
  db.prepare("INSERT INTO settings (key, value) VALUES ('delay_group_s','600')").run();
  for (const jid of GRUPOS.slice(0, 2)) db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, 'G', 5, 1);
  db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etiquetaA', 1);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  // agendador sem o modo rápido; o embrulho (que já prende a pausa no ritmo) fica rápido para medir só a da regra
  const s = createScheduler({ db, wa, links, fast: false, ritmo: createRitmo({ db, fast: true }) });
  const regra = Number(db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id, group_jids, source_type, source_config, per_run, interval_min,
    window_start, window_end, dedupe_days, send_image, created_at) VALUES ('R',1,1,1,?,'list',?,1,60,'00:00','00:00',7,0,1)`)
    .run(JSON.stringify(GRUPOS.slice(0, 2)), JSON.stringify({ items: ITEMS })).lastInsertRowid);
  const corrida = s.runRule(regra, { manual: true });
  await girar(t, 77000, () => false);
  assert.equal(wa.simulated.length, 1, 'antes de 78 s, só o 1º grupo');
  await girar(t, 2000, () => wa.simulated.length >= 2);
  assert.equal(wa.simulated.length, 2, 'aos 78 s (60 s × 1,3) sai o 2º, não aos 780 s');
  await corrida;
  // a fila sem ritmo (pausaEntreGrupos)
  const fila = createEnvios({ db, wa, links, ml: null, dir, acordar: () => {} });
  const id = Number(db.prepare(`INSERT INTO envios (tipo, payload, group_jids, quando, status, next_run_at, created_at)
    VALUES ('mensagem', ?, ?, 'agora', 'pendente', ?, ?)`).run(JSON.stringify({ texto: 'Fila', imagem: 'nenhuma' }), JSON.stringify(GRUPOS.slice(0, 2)), Date.now(), Date.now()).lastInsertRowid);
  const antes = wa.simulated.length;
  const p = fila.runEnvio(id);
  await girar(t, 77000, () => false);
  assert.equal(wa.simulated.length, antes + 1);
  await girar(t, 2000, () => wa.simulated.length >= antes + 2);
  assert.equal(wa.simulated.length, antes + 2);
  await p;
  db.close();
});

// ---------- rodada 2 (QA) ----------

test('Q3 rodada 2: o agendado/repetido pulado às 07:05 deixa linha aviso (nunca erro) e o alerta por WhatsApp não é disparado', async (t) => {
  relogio(t, dia(3, 7, 5));
  const s = montar({ silencio: ['23:00', '07:00'] });
  s.db.prepare('INSERT INTO aviso_destinos (nome, jid, avisos, ativo, created_at) VALUES (?,?,?,?,?)').run('Eu', '5511900000000@s.whatsapp.net', JSON.stringify(['erro']), 1, 1);
  await s.scheduler.avisos.tick(); // marca o cursor do log
  const agendado = s.gravar({ texto: 'G', quando: 'agendado', em: dia(3, 6, 50) });
  const repetido = s.gravar({ texto: 'P', quando: 'repetir', repetir: { dias: TODOS, horarios: ['06:50'] }, em: dia(3, 6, 50) });
  await s.scheduler.tick();
  t.mock.timers.setTime(dia(3, 7, 45)); // 30 min depois: o alerta de erro, se houvesse, já poderia sair
  await s.scheduler.avisos.tick();
  assert.deepEqual(s.enviadas, [], 'nada sai: nem as mensagens, nem um alerta de erro');
  const nivel = logs(s.db).filter((l) => /pulado: horário de silêncio/.test(l.message)).map((l) => l.level);
  assert.deepEqual(nivel, ['aviso', 'aviso']);
  semErro(s.db);
  assert.equal(envio(s.db, agendado).status, 'erro', 'o status do envio único é erro (desenho do plano), mas o log é aviso');
  assert.match(JSON.parse(envio(s.db, agendado).resultado).motivo, /pulado: horário de silêncio/);
  assert.deepEqual([envio(s.db, repetido).status, envio(s.db, repetido).next_run_at], ['pendente', dia(4, 6, 50)]);
});

test('S1 rodada 2: nenhuma vaga fica "separada" depois de falha (link que lança, envio que lança, WhatsApp fora, execução sem ofertas)', async (t) => {
  relogio(t, dia(2, 10, 0));
  const s = montar({ limite: 3 });
  const todasLivres = (m) => assert.deepEqual(s.scheduler.ritmo.liberado(undefined, { precisa: 3 }), { ok: true }, m);
  // 1. o link lança
  const a = s.regra({ name: 'A', grupos: ['111@g.us', '222@g.us'], per: 1 });
  const original = s.links.requestLink.bind(s.links);
  s.links.requestLink = async () => { throw new Error('boom'); };
  await s.scheduler.runRule(a, { manual: true }).catch(() => {});
  todasLivres('após link que lança');
  s.links.requestLink = original;
  // 2. o envio ao WhatsApp lança
  const envioOriginal = s.wa.sendText;
  s.wa.sendText = async () => { throw new Error('falhou'); };
  await s.scheduler.runRule(a, { manual: true }).catch(() => {});
  todasLivres('após sendText que lança');
  s.wa.sendText = envioOriginal;
  // 3. WhatsApp fora
  const pronto = s.wa.isReady;
  s.wa.isReady = () => false;
  await s.scheduler.runRule(a, { manual: true }).catch(() => {});
  todasLivres('após WhatsApp fora');
  s.wa.isReady = pronto;
  // 4. fila: envio cancelado no meio e envio que lança no meio
  const id = s.gravar({ texto: 'C', jids: GRUPOS.slice(0, 3), em: Date.now() });
  s.wa.sendText = async (jid, texto) => { s.db.prepare("UPDATE envios SET status = 'cancelado' WHERE id = ?").run(id); return envioOriginal(jid, texto); };
  await s.scheduler.tick();
  s.wa.sendText = envioOriginal;
  assert.equal(s.enviadas.length, 1, 'só o 1º grupo saiu antes do cancelamento');
  const usados = Number(s.db.prepare('SELECT COUNT(*) AS n FROM wa_saidas').get().n);
  assert.deepEqual(s.scheduler.ritmo.liberado(undefined, { precisa: 3 - usados }), { ok: true }, `só o que saiu de fato (${usados}) ocupa o teto`);
});
