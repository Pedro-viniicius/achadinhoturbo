// Proteção do número no agendador (plano anti-banimento, etapa 4; CA2, CA3, CA4 e CA6): o agendador cria o ritmo,
// embrulha o `wa` de todos os módulos e pergunta teto e silêncio antes de cada regra e de cada oferta.
// Relógio falso só no Date (ligado ANTES de criar o agendador: o ritmo lê o Date.now do momento em que nasce), timers
// reais. WhatsApp simulado, links falsos, sem rede. 02/11/2026 é segunda-feira.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createScheduler } from '../src/scheduler.js';
import { createRitmo } from '../src/ritmo.js';
import { createLinkService } from '../src/links.js';
import { createWhatsApp } from '../src/whatsapp.js';

const globalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('rede proibida no teste'); };
const pastas = [];
after(() => { globalThis.fetch = globalFetch; for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-ritmo-ag-')); pastas.push(p); return p; };

const TODOS = [0, 1, 2, 3, 4, 5, 6];
const HORA = 3600000;
const dia = (d, h, m = 0, s = 0, ms = 0) => new Date(2026, 10, d, h, m, s, ms).getTime();
const relogio = (t, ts) => t.mock.timers.enable({ apis: ['Date'], now: ts });
const ITEMS = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `https://produto.mercadolivre.com.br/MLB-30000${n}-x | Item ${n} | ${10 * n} | ${20 * n}`).join('\n');
const GRUPOS = ['111@g.us', '222@g.us', '333@g.us'];

/** Agendador real com WhatsApp simulado. `protecao`: { limite, silencio: [de, ate] } gravados em settings. */
function montar({ fast = true, protecao = {}, ritmo } = {}) {
  const dir = tmp();
  const db = openDb(dir);
  const set = (k, v) => db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, String(v));
  if (protecao.limite != null) set('wa_limite_hora', protecao.limite);
  if (protecao.silencio) {
    set('wa_silencio_ativo', '1'); set('wa_silencio_de', protecao.silencio[0]); set('wa_silencio_ate', protecao.silencio[1]);
  }
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const scheduler = createScheduler({ db, wa, links, fast, ritmo: ritmo?.(db) });
  const agora = Date.now();
  for (const jid of GRUPOS) db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, `Grupo ${jid.slice(0, 3)}`, 10, agora);
  db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etiquetaA', agora);
  const regra = (o = {}) => Number(db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id, group_jids, source_type, source_config,
    per_run, interval_min, window_start, window_end, dedupe_days, send_image, created_at, next_run_at, grade)
    VALUES (?,1,1,1,?, 'list', ?, ?, ?, ?, ?, 7, 0, ?, ?, ?)`).run(o.name ?? 'R', JSON.stringify(o.grupos ?? ['111@g.us']), JSON.stringify({ items: ITEMS }),
    o.per ?? 1, o.interval ?? 60, o.janela?.[0] ?? '00:00', o.janela?.[1] ?? '00:00', agora, o.next ?? null, o.grade ? JSON.stringify(o.grade) : null).lastInsertRowid);
  // saídas já feitas pelo número (outras origens) nesta janela de 60 min
  const saidas = (n, ts = Date.now()) => { for (let i = 0; i < n; i++) db.prepare('INSERT INTO wa_saidas (ts) VALUES (?)').run(ts); };
  const contadas = () => Number(db.prepare('SELECT COUNT(*) AS n FROM wa_saidas').get().n);
  return { dir, db, wa, links, scheduler, regra, saidas, contadas };
}
const gradeDe = (...horas) => ({ dias: [...TODOS], horarios: horas.map(([hora, qtd = 1]) => ({ hora, qtd, template_id: null })) });
const linhaRegra = (db, id) => ({ ...db.prepare('SELECT next_run_at, last_run_at FROM rules WHERE id = ?').get(id) });
const logs = (db) => db.prepare('SELECT rule_name, level, message FROM log ORDER BY id').all().map((l) => ({ ...l }));
const avisos = (db) => logs(db).filter((l) => l.level === 'aviso').map((l) => l.message);
const semErro = (db) => assert.deepEqual(logs(db).filter((l) => l.level === 'erro'), [], 'nenhuma linha erro (erro dispara o alerta)');
const linhasDoTeto = (db) => logs(db).filter((l) => l.rule_name === 'Proteção do número');
const espera = (ms) => new Promise((r) => setTimeout(r, ms)); // timer real: o relógio falso é só o Date

/** Espera o envio da fila sair de pendente/enviando (o "agora" é fire-and-forget). */
async function terminar(db, id, ms = 3000) {
  const fim = performance.now() + ms;
  for (;;) {
    const st = db.prepare('SELECT status FROM envios WHERE id = ?').get(id)?.status;
    if (st && !['pendente', 'enviando'].includes(st)) return st;
    if (performance.now() > fim) return st;
    await espera(20);
  }
}

// ---------- contrato com as etapas 5 e 6 ----------

test('contrato: o agendador expõe `ritmo` e o `wa` embrulhado; o wa trocado depois de criado continua valendo e cada envio conta no teto', async (t) => {
  relogio(t, dia(2, 10, 0));
  const s = montar();
  assert.equal(typeof s.scheduler.ritmo?.liberado, 'function');
  assert.equal(typeof s.scheduler.ritmo?.uso, 'function');
  assert.notEqual(s.scheduler.wa, s.wa, 'o wa exposto é o embrulho, não o original');
  assert.equal(s.scheduler.wa.isReady(), true, 'o resto do wa vem por herança');
  const recebidos = []; const original = s.wa.sendText.bind(s.wa);
  s.wa.sendText = async (jid, text) => { recebidos.push(jid); return original(jid, text); }; // troca DEPOIS de criar
  await s.scheduler.wa.sendText('111@g.us', 'oi');
  assert.deepEqual(recebidos, ['111@g.us']);
  assert.equal(s.contadas(), 1);
  assert.equal(s.scheduler.ritmo.uso().usados, 1);
  // um ritmo injetado é o usado (o mesmo objeto que o /state lê)
  let r;
  const s2 = montar({ ritmo: (db) => (r = createRitmo({ db, fast: true })) });
  assert.equal(s2.scheduler.ritmo, r);
});

// ---------- CA4: toda mensagem conta ----------

test('CA4: regra, fila (Disparar mensagem "agora") e "Enviar teste" dos avisos contam no teto pelo mesmo wa embrulhado', async (t) => {
  relogio(t, dia(2, 10, 0));
  const s = montar();
  const id = s.regra({ grupos: ['111@g.us', '222@g.us'], per: 1 });
  await s.scheduler.tick();
  assert.equal(s.wa.simulated.length, 2);
  assert.equal(s.contadas(), 2, 'regra: uma por grupo');

  const e = await s.scheduler.envios.criar({ tipo: 'mensagem', texto: 'Recado', group_jids: ['333@g.us'], quando: 'agora' });
  assert.equal(await terminar(s.db, e.id), 'concluido');
  assert.equal(s.contadas(), 3, 'fila de envios');

  const destino = Number(s.db.prepare('INSERT INTO aviso_destinos (nome, jid, avisos, ativo, created_at) VALUES (?,?,?,?,?)')
    .run('Eu', '5511900000000@s.whatsapp.net', JSON.stringify(['erro']), 1, 1).lastInsertRowid);
  await s.scheduler.avisos.enviarTeste({ destinoId: destino });
  assert.equal(s.contadas(), 4, '"Enviar teste" (privado)');
  // só a hora: nenhuma coluna com jid ou número
  assert.deepEqual(s.db.prepare('PRAGMA table_info(wa_saidas)').all().map((c) => c.name), ['ts']);
  assert.ok(linhaRegra(s.db, id).last_run_at);
});

test('CA4: o privado nunca fica preso: com teto cheio e no silêncio, o "Enviar teste" sai e conta', async (t) => {
  relogio(t, dia(2, 23, 30));
  const s = montar({ protecao: { limite: 2, silencio: ['23:00', '07:00'] } });
  s.saidas(2);
  const destino = Number(s.db.prepare('INSERT INTO aviso_destinos (nome, jid, avisos, ativo, created_at) VALUES (?,?,?,?,?)')
    .run('Eu', '5511900000000@s.whatsapp.net', JSON.stringify(['erro']), 1, 1).lastInsertRowid);
  const r = await s.scheduler.avisos.enviarTeste({ destinoId: destino });
  assert.equal(r.enviado, true);
  assert.equal(s.wa.simulated.length, 1);
  assert.equal(s.contadas(), 3);
});

test('CA4: sem o modo rápido, duas mensagens de origens diferentes ao mesmo tempo saem com a pausa mínima entre elas', async (t) => {
  const s = montar({ fast: false });
  s.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('delay_group_s', '0.5')").run();
  const marcas = []; const original = s.wa.sendText.bind(s.wa);
  s.wa.sendText = async (jid, text) => { marcas.push(performance.now()); return original(jid, text); };
  // a regra (pelo wa do agendador) e o "Enviar teste" (pelo mesmo wa, vindo da requisição) disputam o número
  await Promise.all([s.scheduler.wa.sendText('111@g.us', 'a'), s.scheduler.wa.sendText('5511900000000@s.whatsapp.net', 'b')]);
  assert.equal(marcas.length, 2);
  assert.ok(marcas[1] - marcas[0] >= 330, `pausa de ${Math.round(marcas[1] - marcas[0])} ms (mínimo 0,7 × 0,5 s)`);
  t.diagnostic('sem o embrulho as duas sairiam coladas');
});

// ---------- CA2 e CA3: teto ----------

test('CA2/CA3: regra por intervalo com o teto cheio não roda, o next_run_at fica intocado e entra UMA linha aviso com a hora de liberação', async (t) => {
  relogio(t, dia(2, 10, 0));
  const s = montar({ protecao: { limite: 3 } });
  s.saidas(3, dia(2, 9, 20));
  const id = s.regra({ grupos: ['111@g.us'], next: dia(2, 9, 59) });
  await s.scheduler.tick();
  await s.scheduler.tick(); // o tick seguinte não repete a linha
  assert.equal(s.wa.simulated.length, 0);
  assert.deepEqual(linhaRegra(s.db, id), { next_run_at: dia(2, 9, 59), last_run_at: null });
  assert.deepEqual(linhasDoTeto(s.db), [{ rule_name: 'Proteção do número', level: 'aviso', message: 'Limite de 3 mensagens por hora atingido: o que falta sai a partir das 10:20.' }]);
  semErro(s.db);
  // a janela abriu: a regra roda sozinha, sem nada perdido
  t.mock.timers.setTime(dia(2, 10, 20, 1));
  await s.scheduler.tick();
  assert.equal(s.wa.simulated.length, 1);
  assert.equal(linhasDoTeto(s.db).length, 1);
});

test('CA2: a regra pede uma vaga por grupo (min(grupos, teto)): 2 grupos com 1 vaga não rodam; 3 grupos com teto 2 rodam quando a janela está livre e param no teto', async (t) => {
  relogio(t, dia(2, 10, 0));
  const s = montar({ protecao: { limite: 4 } });
  s.saidas(3, dia(2, 9, 30));
  const a = s.regra({ name: 'A', grupos: ['111@g.us', '222@g.us'] });
  await s.scheduler.tick();
  assert.equal(s.wa.simulated.length, 0, 'sairia para um grupo e não para o outro');
  assert.equal(linhaRegra(s.db, a).next_run_at, null);

  t.mock.timers.setTime(dia(2, 12, 0));
  const s2 = montar({ protecao: { limite: 2 } });
  s2.regra({ grupos: GRUPOS });
  await s2.scheduler.tick();
  // nunca fica presa para sempre (roda com a janela vazia), mas também não passa do teto (Q1 da rodada 1): a oferta
  // vai aos 2 primeiros grupos e para no 3º
  assert.equal(s2.wa.simulated.length, 2, 'roda com a janela vazia e para no teto');
  assert.equal(s2.scheduler.ritmo.uso().usados, 2);
});

test('CA2/CA3: o teto enche no meio da execução: para antes da próxima oferta, nada duplica, a regra volta em libera_em e retoma só o que faltou', async (t) => {
  relogio(t, dia(2, 10, 0));
  const s = montar({ protecao: { limite: 4 } });
  const id = s.regra({ grupos: ['111@g.us', '222@g.us'], per: 3, interval: 30 });
  await s.scheduler.tick();
  assert.equal(s.wa.simulated.length, 4, '2 ofertas × 2 grupos; a 3ª não cabe');
  const primeiras = s.wa.simulated.map((m) => m.text.split('\n')[0]);
  assert.equal(new Set(primeiras).size, 2);
  assert.equal(Number(s.db.prepare('SELECT COUNT(*) AS n FROM sent_offers').get().n), 2);
  assert.equal(linhaRegra(s.db, id).next_run_at, dia(2, 11, 0), 'libera_em: a mais antiga da janela + 60 min');
  assert.deepEqual(linhasDoTeto(s.db).map((l) => l.message), ['Limite de 4 mensagens por hora atingido: o que falta sai a partir das 11:00.']);
  semErro(s.db);

  t.mock.timers.setTime(dia(2, 11, 0, 1));
  await s.scheduler.tick();
  const depois = s.wa.simulated.slice(4).map((m) => m.text.split('\n')[0]);
  assert.equal(depois.length, 4);
  assert.ok(depois.every((x) => !primeiras.includes(x)), 'nenhuma oferta repetida (dias sem repetir)');
});

test('CA2: grade com o teto cheio não roda; o horário fica marcado e a tolerância de 30 min continua valendo, com o motivo de sempre', async (t) => {
  relogio(t, dia(2, 9, 0));
  const s = montar({ protecao: { limite: 2 } });
  s.saidas(2, dia(2, 8, 50));
  const id = s.regra({ grade: gradeDe(['09:00', 2], ['12:00', 1]), next: dia(2, 9, 0) });
  await s.scheduler.tick();
  assert.equal(s.wa.simulated.length, 0);
  assert.equal(linhaRegra(s.db, id).next_run_at, dia(2, 9, 0));
  assert.equal(linhasDoTeto(s.db).length, 1);
  // a janela libera às 09:50: já passou da tolerância, o horário é pulado como qualquer atraso
  t.mock.timers.setTime(dia(2, 9, 31));
  s.db.prepare('DELETE FROM wa_saidas').run();
  await s.scheduler.tick();
  assert.equal(s.wa.simulated.length, 0);
  assert.equal(linhaRegra(s.db, id).next_run_at, dia(2, 12, 0));
  assert.ok(avisos(s.db).some((m) => m === 'Horário 09:00 pulado: o programa estava desligado, o WhatsApp desconectado ou outro envio demorou. Próximo: 12:00.'), avisos(s.db).join(' | '));
  semErro(s.db);
});

test('CA2: grade que o teto para no meio: o horário se encerra com o que saiu e o próximo horário fica gravado', async (t) => {
  relogio(t, dia(2, 9, 0));
  const s = montar({ protecao: { limite: 2 } });
  s.saidas(1, dia(2, 8, 30));
  const id = s.regra({ grade: gradeDe(['09:00', 3], ['12:00', 1]), next: dia(2, 9, 0) });
  await s.scheduler.tick();
  assert.equal(s.wa.simulated.length, 1);
  assert.equal(linhaRegra(s.db, id).next_run_at, dia(2, 12, 0));
  const a = avisos(s.db);
  assert.ok(a.includes('Horário 09:00: saíram 1 de 3 ofertas; o limite de 2 mensagens por hora encheu.'), a.join(' | '));
  assert.ok(a.includes('Limite de 2 mensagens por hora atingido: o que falta sai a partir das 09:30.'), a.join(' | '));
  semErro(s.db);
});

test('CA2/CA3: "Enviar agora" com o teto cheio não sai, não lê as fontes e não mexe no next_run_at', async (t) => {
  relogio(t, dia(2, 10, 0));
  const s = montar({ protecao: { limite: 1 } });
  s.saidas(1, dia(2, 9, 45));
  const id = s.regra({ next: dia(2, 11, 0) });
  const r = await s.scheduler.runRule(id, { manual: true });
  assert.equal(r.parou, 'limite');
  assert.equal(r.messages, 0);
  assert.equal(s.wa.simulated.length, 0);
  assert.deepEqual(linhaRegra(s.db, id), { next_run_at: dia(2, 11, 0), last_run_at: null });
  assert.deepEqual(avisos(s.db), [
    'Enviar agora não saiu: limite de 1 mensagens por hora atingido; há vaga a partir das 10:45.',
    'Limite de 1 mensagens por hora atingido: o que falta sai a partir das 10:45.',
  ]);
  assert.equal(s.scheduler.isRunning(id), false);
  semErro(s.db);
});

// ---------- CA6: silêncio ----------

test('CA6: regra por intervalo no silêncio é adiada para o fim dele, com uma linha aviso por silêncio, e sai às 07:00', async (t) => {
  relogio(t, dia(2, 23, 30));
  const s = montar({ protecao: { silencio: ['23:00', '07:00'] } });
  const id = s.regra({ next: dia(2, 23, 20) });
  await s.scheduler.tick();
  t.mock.timers.setTime(dia(3, 2, 0));
  await s.scheduler.tick();
  assert.equal(s.wa.simulated.length, 0);
  assert.equal(linhaRegra(s.db, id).next_run_at, dia(3, 7, 0));
  assert.deepEqual(avisos(s.db), ['Horário de silêncio (23:00 às 07:00): disparo adiado para as 07:00.']);
  t.mock.timers.setTime(dia(3, 7, 0, 5));
  await s.scheduler.tick();
  assert.equal(s.wa.simulated.length, 1);
  semErro(s.db);
});

test('CA6: o "Funciona das/até" da regra continua valendo: os dois limites se somam', async (t) => {
  relogio(t, dia(2, 23, 30));
  const s = montar({ protecao: { silencio: ['23:00', '07:00'] } });
  // funciona das 22:00 às 02:00: o fim do silêncio (07:00) cai fora, então a regra volta às 22:00
  const id = s.regra({ janela: ['22:00', '02:00'] });
  await s.scheduler.tick();
  assert.equal(linhaRegra(s.db, id).next_run_at, dia(3, 22, 0));
  assert.deepEqual(avisos(s.db), ['Horário de silêncio (23:00 às 07:00): disparo adiado para as 22:00.']);
  // às 22:10 já não é silêncio: sai
  t.mock.timers.setTime(dia(3, 22, 10));
  await s.scheduler.tick();
  assert.equal(s.wa.simulated.length, 1);
});

test('CA6: sem a configuração (testes e banco sem semente) o silêncio fica desligado: nada muda de madrugada', async (t) => {
  relogio(t, dia(2, 3, 0));
  const s = montar();
  s.regra();
  await s.scheduler.tick();
  assert.equal(s.wa.simulated.length, 1);
  assert.deepEqual(avisos(s.db), []);
});

test('CA6: horário da grade que vence no silêncio é pulado com aviso e o próximo horário fica gravado (P4)', async (t) => {
  relogio(t, dia(2, 23, 30));
  const s = montar({ protecao: { silencio: ['23:00', '07:00'] } });
  const id = s.regra({ grade: gradeDe(['23:30', 1], ['09:00', 1]), next: dia(2, 23, 30) });
  await s.scheduler.tick();
  await s.scheduler.tick();
  assert.equal(s.wa.simulated.length, 0);
  assert.equal(linhaRegra(s.db, id).next_run_at, dia(3, 9, 0));
  assert.deepEqual(avisos(s.db), ['Horário 23:30 pulado: horário de silêncio.']);
  semErro(s.db);
});

test('CA6: horário marcado no silêncio é pulado mesmo visto depois do fim (computador dormindo), e o de antes do silêncio visto já dentro dele também', async (t) => {
  relogio(t, dia(3, 7, 5));
  const s = montar({ protecao: { silencio: ['23:00', '07:00'] } });
  const a = s.regra({ name: 'A', grade: gradeDe(['06:50', 1], ['12:00', 1]), next: dia(3, 6, 50) });
  await s.scheduler.tick();
  assert.equal(s.wa.simulated.length, 0, '06:50 era silêncio: não "sai quando acabar"');
  assert.equal(linhaRegra(s.db, a).next_run_at, dia(3, 12, 0));

  assert.deepEqual(avisos(s.db), ['Horário 06:50 pulado: horário de silêncio.']);

  t.mock.timers.setTime(dia(3, 23, 5));
  const s2 = montar({ protecao: { silencio: ['23:00', '07:00'] } });
  const b = s2.regra({ name: 'B', grade: gradeDe(['22:50', 1]), next: dia(3, 22, 50) });
  await s2.scheduler.tick();
  assert.equal(s2.wa.simulated.length, 0, 'às 23:05 é silêncio: nada sai para grupo');
  assert.equal(linhaRegra(s2.db, b).next_run_at, dia(4, 22, 50));
  assert.deepEqual(avisos(s2.db), ['Horário 22:50 pulado: horário de silêncio.']);
});

test('CA6: o aviso de horários perdidos não diz "sai agora" para o horário que o silêncio vai pular', async (t) => {
  relogio(t, dia(3, 6, 55));
  const s = montar({ protecao: { silencio: ['23:00', '07:00'] } });
  s.regra({ grade: gradeDe(['06:00', 1], ['06:40', 1], ['12:00', 1]), next: dia(3, 6, 0) });
  await s.scheduler.tick();
  const a = avisos(s.db);
  assert.equal(a.length, 2, a.join(' | '));
  assert.doesNotMatch(a[0], /sai agora/);
  assert.equal(a[1], 'Horário 06:40 pulado: horário de silêncio.');
});

test('CA6: o silêncio começa no meio da execução: a regra por intervalo para antes da oferta seguinte e volta no fim do silêncio', async (t) => {
  relogio(t, dia(2, 22, 59, 50));
  const s = montar({ protecao: { silencio: ['23:00', '07:00'] } });
  const id = s.regra({ per: 3 });
  const original = s.wa.sendText.bind(s.wa);
  s.wa.sendText = async (jid, text) => { const r = await original(jid, text); t.mock.timers.setTime(dia(2, 23, 0, 5)); return r; };
  await s.scheduler.tick();
  assert.equal(s.wa.simulated.length, 1);
  assert.equal(linhaRegra(s.db, id).next_run_at, dia(3, 7, 0));
  assert.deepEqual(avisos(s.db), ['Horário de silêncio (23:00 às 07:00): disparo adiado para as 07:00.']);
  semErro(s.db);
});

test('CA6: "Enviar agora" no silêncio não sai, com aviso, e não mexe no next_run_at (regra por intervalo e com grade)', async (t) => {
  relogio(t, dia(2, 23, 30));
  const s = montar({ protecao: { silencio: ['23:00', '07:00'] } });
  const a = s.regra({ name: 'A', next: dia(3, 9, 0) });
  const b = s.regra({ name: 'B', grade: gradeDe(['09:00', 1]), next: dia(3, 9, 0) });
  assert.equal((await s.scheduler.runRule(a, { manual: true })).parou, 'silencio');
  assert.equal((await s.scheduler.runRule(b, { manual: true })).parou, 'silencio');
  assert.equal(s.wa.simulated.length, 0);
  assert.deepEqual(linhaRegra(s.db, a), { next_run_at: dia(3, 9, 0), last_run_at: null });
  assert.deepEqual(linhaRegra(s.db, b), { next_run_at: dia(3, 9, 0), last_run_at: null });
  assert.deepEqual(avisos(s.db), ['Enviar agora não saiu: horário de silêncio até 07:00.', 'Enviar agora não saiu: horário de silêncio até 07:00.']);
  semErro(s.db);
});
