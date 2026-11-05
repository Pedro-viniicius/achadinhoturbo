// QA da feature "grade de horários + Grupo vivo" (plano grade-de-disparos), rodada 2: prova de ponta a ponta, com o
// agendador real, a API real (buildApp + HTTP local), WhatsApp simulado e relógio injetado (só Date, ligado ANTES de criar
// o agendador). Foco no CA1 ("sem derrubar o atual"):
//  - o ritmo antigo (intervalo + janela) é o do `main`: a trilha de next_run_at de 6 cenários foi gerada rodando o
//    código do commit f22077f (o `main` antes da feature) e está colada aqui (GOLDEN_MAIN);
//  - uma regra com 3 horários próximos sai na hora certa, com a quantidade e o template que o cartão anuncia;
//  - uma rotina do Grupo vivo com enquete e outra com textos em rodízio saem pelo tick, pela fila, com o nome no Histórico;
//  - o freio de 1 por minuto do "Enviar agora" e o teto de 50 rotinas, pela API.
// 02/11/2026 é segunda-feira. Sem rede (fetch global bloqueado e contado).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openDb } from '../src/db.js';
import { createScheduler } from '../src/scheduler.js';
import { createLinkService } from '../src/links.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { buildApp } from '../src/server.js';

let acessosRede = 0;
const globalFetch = globalThis.fetch;
globalThis.fetch = async () => { acessosRede++; throw new Error('rede proibida no teste'); };

const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-qagrade2-')); pastas.push(p); return p; };

const TODOS = [0, 1, 2, 3, 4, 5, 6];
const dia = (d, h, m = 0, s = 0, ms = 0) => new Date(2026, 10, d, h, m, s, ms).getTime();
const relogio = (t, ts) => t.mock.timers.enable({ apis: ['Date'], now: ts });
const ITEMS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => `https://produto.mercadolivre.com.br/MLB-20000${String(n).padStart(2, '0')}-x | Item ${n} | ${10 * n} | ${20 * n}`).join('\n');
const SENHA = 'senha-de-teste-123';

function montar({ fast = true } = {}) {
  const dir = tmp();
  const db = openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const scheduler = createScheduler({ db, wa, links, fast });
  const agora = Date.now();
  for (const jid of ['111@g.us', '222@g.us', '333@g.us']) db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, `Grupo ${jid.slice(0, 3)}`, 10, agora);
  db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etiquetaA', agora);
  // sem a coluna `grade` quando a regra não tem grade: o mesmo INSERT roda no código do main (GOLDEN_MAIN)
  const regra = (o = {}) => Number(db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id, group_jids, source_type, source_config,
    per_run, interval_min, window_start, window_end, dedupe_days, send_image, created_at, next_run_at${o.grade ? ', grade' : ''})
    VALUES (?,1,1,?,?, 'list', ?, ?, ?, ?, ?, ?, 1, ?, ?${o.grade ? ', ?' : ''})`).run(o.name ?? 'R', o.template ?? 1, JSON.stringify(o.grupos ?? ['111@g.us']), JSON.stringify({ items: ITEMS }),
    o.per ?? 3, o.interval ?? 60, o.janela?.[0] ?? '00:00', o.janela?.[1] ?? '23:59', o.dedupe ?? 7, agora, o.next ?? null, ...(o.grade ? [JSON.stringify(o.grade)] : [])).lastInsertRowid);
  return { dir, db, wa, links, scheduler, regra };
}
const gradeDe = (...linhas) => ({ dias: [...TODOS], horarios: linhas.map(([hora, qtd, template_id = null]) => ({ hora, qtd, template_id })) });
const novoTemplate = (db, nome, prefixo) => Number(db.prepare('INSERT INTO templates (name, body, created_at) VALUES (?,?,?)')
  .run(nome, `${prefixo} {TITULO_PRODUTO}\n{LINK}`, Date.now()).lastInsertRowid);
const linhaRegra = (db, id) => ({ ...db.prepare('SELECT next_run_at, last_run_at, enabled, per_run, interval_min, window_start, window_end, grade FROM rules WHERE id = ?').get(id) });
const primeiras = (wa) => wa.simulated.map((m) => m.text.split('\n')[0]);
const espera = (ms) => new Promise((r) => setTimeout(r, ms)); // timer real: o relógio falso é só o Date

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
/** Painel de teste com sessão: { port, h (cookie+origin), get, enviar, fechar }. O agendador e o WhatsApp são os do `montar`. */
async function painel(s) {
  const app = buildApp({ db: s.db, wa: s.wa, links: s.links, scheduler: s.scheduler, publicHost: 'qa.exemplo.com.br', panelPassword: SENHA });
  const server = await new Promise((ok) => { const sv = app.listen(0, '127.0.0.1', () => ok(sv)); });
  const port = server.address().port;
  const login = await chamar(port, '/api/login', { method: 'POST', body: { senha: SENHA } });
  const cookie = String(login.headers['set-cookie']?.[0] || '').split(';')[0];
  const h = { cookie, origin: `http://127.0.0.1:${port}` };
  return {
    port,
    get: (c) => chamar(port, c, { headers: { cookie } }),
    enviar: (method, c, body) => chamar(port, c, { method, headers: h, body: body ?? {} }),
    fechar: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}
const corpoRegra = (mais = {}) => ({ name: 'Regra QA', enabled: true, tag_id: 1, template_id: 1, group_jids: ['111@g.us'], sources: [{ type: 'list', config: { items: ITEMS } }], per_run: 4, interval_min: 45, window_start: '07:00', window_end: '20:00', ...mais });

// =====================================================================================================================
// CA1: o ritmo antigo é o do main (golden gerado rodando o código de f22077f)
// =====================================================================================================================

const p2 = (n) => String(n).padStart(2, '0');
const hms = (ts) => { const d = new Date(ts); return `${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; };
const CENARIOS = {
  A_60_dia_todo: { per: 3, interval: 60, janela: ['00:00', '23:59'] },
  B_45_comercial: { per: 3, interval: 45, janela: ['08:00', '22:00'] },
  C_90_noite: { per: 2, interval: 90, janela: ['20:00', '02:00'] },
  E_next_passado: { per: 2, interval: 30, janela: ['09:00', '18:00'], next: dia(2, 5, 0) },
  F_next_futuro: { per: 2, interval: 30, janela: ['09:00', '18:00'], next: dia(2, 12, 7) },
  G_janela_igual: { per: 2, interval: 120, janela: ['09:30', '09:30'] },
};
/**
 * Roda o tick real a cada 30 s de 02/11 06:00 a 03/11 14:00 (o WhatsApp cai das 10:00 às 10:10 do dia 2) e devolve uma
 * linha por mudança: "<dia hh:mm:ss do tick> next=<dia hh:mm:ss ou -> n=<mensagens enviadas até aí>". dedupe_days = 0: as
 * 12 ofertas da lista voltam a sair e a regra nunca fica sem oferta.
 */
async function trilhaSemGrade(t, c) {
  t.mock.timers.setTime(dia(2, 6, 0));
  const s = montar(); const id = s.regra({ ...c, dedupe: 0 });
  const trilha = []; let ant = null;
  for (let ts = dia(2, 6, 0); ts <= dia(3, 14, 0); ts += 30000) {
    t.mock.timers.setTime(ts);
    s.wa.isReady = () => !(ts >= dia(2, 10, 0) && ts < dia(2, 10, 10));
    await s.scheduler.tick();
    const { next_run_at: next } = s.db.prepare('SELECT next_run_at FROM rules WHERE id = ?').get(id); // sem `grade`: roda também no main
    const atual = `next=${next == null ? '-' : hms(next)} n=${s.wa.simulated.length}`;
    if (atual !== ant) { trilha.push(`${hms(ts)} ${atual}`); ant = atual; }
  }
  return trilha;
}
// colado da execução em f22077f (git archive main src), com TZ America/Sao_Paulo; não editar a mão
const GOLDEN_MAIN = {
  A_60_dia_todo: [
    "02 06:00:00 next=02 07:00:00 n=3", "02 07:00:00 next=02 08:00:00 n=6", "02 08:00:00 next=02 09:00:00 n=9",
    "02 09:00:00 next=02 10:00:00 n=12", "02 10:10:00 next=02 11:10:00 n=15", "02 11:10:00 next=02 12:10:00 n=18",
    "02 12:10:00 next=02 13:10:00 n=21", "02 13:10:00 next=02 14:10:00 n=24", "02 14:10:00 next=02 15:10:00 n=27",
    "02 15:10:00 next=02 16:10:00 n=30", "02 16:10:00 next=02 17:10:00 n=33", "02 17:10:00 next=02 18:10:00 n=36",
    "02 18:10:00 next=02 19:10:00 n=39", "02 19:10:00 next=02 20:10:00 n=42", "02 20:10:00 next=02 21:10:00 n=45",
    "02 21:10:00 next=02 22:10:00 n=48", "02 22:10:00 next=02 23:10:00 n=51", "02 23:10:00 next=03 00:10:00 n=54",
    "03 00:10:00 next=03 01:10:00 n=57", "03 01:10:00 next=03 02:10:00 n=60", "03 02:10:00 next=03 03:10:00 n=63",
    "03 03:10:00 next=03 04:10:00 n=66", "03 04:10:00 next=03 05:10:00 n=69", "03 05:10:00 next=03 06:10:00 n=72",
    "03 06:10:00 next=03 07:10:00 n=75", "03 07:10:00 next=03 08:10:00 n=78", "03 08:10:00 next=03 09:10:00 n=81",
    "03 09:10:00 next=03 10:10:00 n=84", "03 10:10:00 next=03 11:10:00 n=87", "03 11:10:00 next=03 12:10:00 n=90",
    "03 12:10:00 next=03 13:10:00 n=93", "03 13:10:00 next=03 14:10:00 n=96",
  ],
  B_45_comercial: [
    "02 06:00:00 next=02 08:00:00 n=0", "02 08:00:00 next=02 08:45:00 n=3", "02 08:45:00 next=02 09:30:00 n=6",
    "02 09:30:00 next=02 10:15:00 n=9", "02 10:15:00 next=02 11:00:00 n=12", "02 11:00:00 next=02 11:45:00 n=15",
    "02 11:45:00 next=02 12:30:00 n=18", "02 12:30:00 next=02 13:15:00 n=21", "02 13:15:00 next=02 14:00:00 n=24",
    "02 14:00:00 next=02 14:45:00 n=27", "02 14:45:00 next=02 15:30:00 n=30", "02 15:30:00 next=02 16:15:00 n=33",
    "02 16:15:00 next=02 17:00:00 n=36", "02 17:00:00 next=02 17:45:00 n=39", "02 17:45:00 next=02 18:30:00 n=42",
    "02 18:30:00 next=02 19:15:00 n=45", "02 19:15:00 next=02 20:00:00 n=48", "02 20:00:00 next=02 20:45:00 n=51",
    "02 20:45:00 next=02 21:30:00 n=54", "02 21:30:00 next=03 08:00:00 n=57", "03 08:00:00 next=03 08:45:00 n=60",
    "03 08:45:00 next=03 09:30:00 n=63", "03 09:30:00 next=03 10:15:00 n=66", "03 10:15:00 next=03 11:00:00 n=69",
    "03 11:00:00 next=03 11:45:00 n=72", "03 11:45:00 next=03 12:30:00 n=75", "03 12:30:00 next=03 13:15:00 n=78",
    "03 13:15:00 next=03 14:00:00 n=81", "03 14:00:00 next=03 14:45:00 n=84",
  ],
  C_90_noite: [
    "02 06:00:00 next=02 20:00:00 n=0", "02 20:00:00 next=02 21:30:00 n=2", "02 21:30:00 next=02 23:00:00 n=4",
    "02 23:00:00 next=03 00:30:00 n=6", "03 00:30:00 next=03 20:00:00 n=8",
  ],
  E_next_passado: [
    "02 06:00:00 next=02 09:00:00 n=0", "02 09:00:00 next=02 09:30:00 n=2", "02 09:30:00 next=02 10:00:00 n=4",
    "02 10:10:00 next=02 10:40:00 n=6", "02 10:40:00 next=02 11:10:00 n=8", "02 11:10:00 next=02 11:40:00 n=10",
    "02 11:40:00 next=02 12:10:00 n=12", "02 12:10:00 next=02 12:40:00 n=14", "02 12:40:00 next=02 13:10:00 n=16",
    "02 13:10:00 next=02 13:40:00 n=18", "02 13:40:00 next=02 14:10:00 n=20", "02 14:10:00 next=02 14:40:00 n=22",
    "02 14:40:00 next=02 15:10:00 n=24", "02 15:10:00 next=02 15:40:00 n=26", "02 15:40:00 next=02 16:10:00 n=28",
    "02 16:10:00 next=02 16:40:00 n=30", "02 16:40:00 next=02 17:10:00 n=32", "02 17:10:00 next=02 17:40:00 n=34",
    "02 17:40:00 next=03 09:00:00 n=36", "03 09:00:00 next=03 09:30:00 n=38", "03 09:30:00 next=03 10:00:00 n=40",
    "03 10:00:00 next=03 10:30:00 n=42", "03 10:30:00 next=03 11:00:00 n=44", "03 11:00:00 next=03 11:30:00 n=46",
    "03 11:30:00 next=03 12:00:00 n=48", "03 12:00:00 next=03 12:30:00 n=50", "03 12:30:00 next=03 13:00:00 n=52",
    "03 13:00:00 next=03 13:30:00 n=54", "03 13:30:00 next=03 14:00:00 n=56", "03 14:00:00 next=03 14:30:00 n=58",
  ],
  F_next_futuro: [
    "02 06:00:00 next=02 12:07:00 n=0", "02 12:07:00 next=02 12:37:00 n=2", "02 12:37:00 next=02 13:07:00 n=4",
    "02 13:07:00 next=02 13:37:00 n=6", "02 13:37:00 next=02 14:07:00 n=8", "02 14:07:00 next=02 14:37:00 n=10",
    "02 14:37:00 next=02 15:07:00 n=12", "02 15:07:00 next=02 15:37:00 n=14", "02 15:37:00 next=02 16:07:00 n=16",
    "02 16:07:00 next=02 16:37:00 n=18", "02 16:37:00 next=02 17:07:00 n=20", "02 17:07:00 next=02 17:37:00 n=22",
    "02 17:37:00 next=03 09:00:00 n=24", "03 09:00:00 next=03 09:30:00 n=26", "03 09:30:00 next=03 10:00:00 n=28",
    "03 10:00:00 next=03 10:30:00 n=30", "03 10:30:00 next=03 11:00:00 n=32", "03 11:00:00 next=03 11:30:00 n=34",
    "03 11:30:00 next=03 12:00:00 n=36", "03 12:00:00 next=03 12:30:00 n=38", "03 12:30:00 next=03 13:00:00 n=40",
    "03 13:00:00 next=03 13:30:00 n=42", "03 13:30:00 next=03 14:00:00 n=44", "03 14:00:00 next=03 14:30:00 n=46",
  ],
  G_janela_igual: [
    "02 06:00:00 next=02 08:00:00 n=2", "02 08:00:00 next=02 10:00:00 n=4", "02 10:10:00 next=02 12:10:00 n=6",
    "02 12:10:00 next=02 14:10:00 n=8", "02 14:10:00 next=02 16:10:00 n=10", "02 16:10:00 next=02 18:10:00 n=12",
    "02 18:10:00 next=02 20:10:00 n=14", "02 20:10:00 next=02 22:10:00 n=16", "02 22:10:00 next=03 00:10:00 n=18",
    "03 00:10:00 next=03 02:10:00 n=20", "03 02:10:00 next=03 04:10:00 n=22", "03 04:10:00 next=03 06:10:00 n=24",
    "03 06:10:00 next=03 08:10:00 n=26", "03 08:10:00 next=03 10:10:00 n=28", "03 10:10:00 next=03 12:10:00 n=30",
    "03 12:10:00 next=03 14:10:00 n=32",
  ],
};

test('CA1: regra sem grade segue o ritmo do main (intervalo, janela, virada da noite, WhatsApp fora, next_run_at passado e futuro), tick a tick', async (t) => {
  relogio(t, dia(2, 6, 0));
  const obtido = {};
  for (const [nome, c] of Object.entries(CENARIOS)) obtido[nome] = await trilhaSemGrade(t, c);
  if (process.env.QA_GERAR_GOLDEN) { process.stdout.write(`\nGOLDEN ${JSON.stringify(obtido)}\n`); return; }
  for (const nome of Object.keys(CENARIOS)) assert.ok(obtido[nome].length >= 5, `${nome}: a trilha tem de ter execuções (${obtido[nome].length})`);
  assert.deepEqual(obtido, GOLDEN_MAIN);
});

test('CA1: a API de regra sem grade devolve o mesmo do main, e as únicas chaves novas são grade e proximo_horario (nulas)', async (t) => {
  relogio(t, dia(2, 10, 0));
  const s = montar();
  const p = await painel(s);
  try {
    const post = await p.enviar('POST', '/api/rules', corpoRegra());
    assert.deepEqual([post.status, post.json], [200, { id: 1 }]);
    const lista = (await p.get('/api/rules')).json;
    // as chaves de GET /api/rules do main (f22077f), mais as duas novas
    const DO_MAIN = ['created_at', 'dedupe_days', 'em_andamento', 'enabled', 'group_jids', 'id', 'interval_min', 'last_run_at', 'max_price', 'min_discount',
      'min_price', 'name', 'next_run_at', 'per_run', 'send_image', 'source_config', 'source_type', 'sources', 'tag_id', 'template_id', 'window_end', 'window_start'];
    assert.deepEqual(Object.keys(lista[0]).sort(), [...DO_MAIN, 'grade', 'proximo_horario'].sort());
    assert.equal(lista[0].grade, null);
    assert.equal(lista[0].proximo_horario, null);
    assert.equal(lista[0].next_run_at, null, 'regra nova: roda já');
    const put = await p.enviar('PUT', '/api/rules/1', corpoRegra({ per_run: 6, interval_min: 20, name: 'Regra 2' }));
    assert.deepEqual([put.status, put.json], [200, { ok: true }]);
    const depois = (await p.get('/api/rules')).json[0];
    assert.deepEqual([depois.name, depois.per_run, depois.interval_min, depois.window_start, depois.window_end, depois.grade, depois.proximo_horario, depois.next_run_at],
      ['Regra 2', 6, 20, '07:00', '20:00', null, null, null]);
    // as validações do main, caso a caso (o main aceita janela e template que não existem: continua assim, sem grade nova a mais)
    const casos = [[{ per_run: 0 }, 400, 'Ofertas por envio: de 1 a 20.'], [{ per_run: 21 }, 400, 'Ofertas por envio: de 1 a 20.'],
      [{ interval_min: 0 }, 400, 'O intervalo mínimo é 1 minuto.'], [{ window_start: '99:00' }, 200, undefined], [{ name: '' }, 400, 'Dê um nome à regra.'], [{ template_id: 999 }, 200, undefined]];
    for (const [m, status, erro] of casos) {
      const r = await p.enviar('POST', '/api/rules', corpoRegra(m));
      assert.deepEqual([r.status, r.json.erro], [status, erro], JSON.stringify(m));
    }
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM rules').get().n, 3, 'as inválidas não gravam nada; as duas que o main aceita gravam grade NULL');
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM rules WHERE grade IS NOT NULL').get().n, 0);
  } finally { await p.fechar(); }
});

// =====================================================================================================================
// CA5, CA8, CA9: 3 horários próximos, o que o cartão anuncia é o que sai, na hora certa
// =====================================================================================================================

test('E2E grade: 3 horários próximos, cada um com a sua quantidade e o seu template, saem na hora certa com o que o cartão anuncia', async (t) => {
  relogio(t, dia(2, 8, 58));
  const s = montar();
  const A = novoTemplate(s.db, 'Promo A', 'AAA'); const B = novoTemplate(s.db, 'Promo B', 'BBB');
  const id = s.regra({ name: 'Manhã', grupos: ['111@g.us', '222@g.us'], per: 7, interval: 60, janela: ['12:00', '13:00'], grade: gradeDe(['09:00', 2, A], ['09:10', 4, B], ['09:20', 1]) });
  const p = await painel(s);
  try {
    const cartao = async () => { const r = (await p.get('/api/rules')).json.find((x) => x.id === id).proximo_horario; return [r.hora, r.qtd, r.template_id, r.ts]; };
    const saidas = []; // [hora do tick, mensagens novas]
    const anunciado = [];
    for (let ts = dia(2, 8, 58); ts <= dia(2, 9, 22); ts += 15000) {
      t.mock.timers.setTime(ts);
      anunciado.push([ts, await cartao()]);
      const antes = s.wa.simulated.length;
      await s.scheduler.tick();
      if (s.wa.simulated.length !== antes) saidas.push([ts, s.wa.simulated.slice(antes)]);
    }
    // 3 saídas, exatamente nos 3 horários (tick de 15 s: o tick das 09:00:00 em ponto já envia), e nenhuma outra
    assert.deepEqual(saidas.map(([ts]) => ts), [dia(2, 9, 0), dia(2, 9, 10), dia(2, 9, 20)]);
    // qtd de ofertas × 2 grupos; template da linha (a última usa o da regra, o "Padrão")
    assert.deepEqual(saidas.map(([, m]) => m.length), [2 * 2, 4 * 2, 1 * 2]);
    assert.ok(saidas[0][1].every((m) => m.text.startsWith('AAA ')));
    assert.ok(saidas[1][1].every((m) => m.text.startsWith('BBB ')));
    assert.ok(saidas[2][1].every((m) => !/^(AAA|BBB) /.test(m.text) && m.text.includes('Item 7')));
    // um envio de cada vez: oferta a oferta, grupo a grupo; sem repetir oferta entre os horários (Item 1..7 em ordem)
    assert.deepEqual(saidas[0][1].map((m) => [m.jid, m.text.split('\n')[0]]), [['111@g.us', 'AAA Item 1'], ['222@g.us', 'AAA Item 1'], ['111@g.us', 'AAA Item 2'], ['222@g.us', 'AAA Item 2']]);
    assert.deepEqual([...new Set(saidas[1][1].map((m) => m.text.split('\n')[0]))], ['BBB Item 3', 'BBB Item 4', 'BBB Item 5', 'BBB Item 6']);
    // o cartão, em cada tick, anunciava o horário que ia sair (qtd e template) e só trocava depois que ele saiu
    const antesDe = (limite) => anunciado.filter(([ts]) => ts < limite).map(([, c]) => c.slice(0, 3).join('/'));
    assert.deepEqual([...new Set(antesDe(dia(2, 9, 0)))], [`09:00/2/${A}`]);
    assert.deepEqual([...new Set(anunciado.filter(([ts]) => ts > dia(2, 9, 0) && ts <= dia(2, 9, 10)).map(([, c]) => c.slice(0, 3).join('/')))], [`09:10/4/${B}`]);
    assert.deepEqual([...new Set(anunciado.filter(([ts]) => ts > dia(2, 9, 10) && ts <= dia(2, 9, 20)).map(([, c]) => c.slice(0, 3).join('/')))], ['09:20/1/']);
    // depois do último horário do dia, o cartão anuncia o primeiro de amanhã, e o banco guarda o mesmo
    t.mock.timers.setTime(dia(2, 9, 22));
    assert.deepEqual(await cartao(), ['09:00', 2, A, dia(3, 9, 0)]);
    const r = linhaRegra(s.db, id);
    assert.equal(r.next_run_at, dia(3, 9, 0));
    assert.equal(r.last_run_at, dia(2, 9, 20));
    // Histórico: 14 envios ok da regra e nenhum aviso (a janela 12:00–13:00 da regra não vale no modo grade)
    const log = (await p.get('/api/log?limite=100')).json;
    assert.equal(log.filter((l) => l.level === 'ok' && l.rule_name === 'Manhã').length, 14);
    assert.deepEqual(log.filter((l) => l.level !== 'ok').map((l) => l.message), []);
  } finally { await p.fechar(); }
});

test('E2E grade: faltou oferta no 2º horário: saem as que houver, o 3º horário não herda o que faltou e o Histórico avisa "saíram N de M"', async (t) => {
  relogio(t, dia(2, 8, 59));
  const s = montar();
  const id = s.regra({ grupos: ['111@g.us'], grade: gradeDe(['09:00', 6], ['09:10', 10], ['09:20', 3]), per: 1, next: dia(2, 9, 0) }); // a lista tem 12 ofertas
  for (const ts of [dia(2, 9, 0), dia(2, 9, 10), dia(2, 9, 20)]) { t.mock.timers.setTime(ts); await s.scheduler.tick(); }
  // 6 + 6 (só restavam 6 das 10 pedidas) + 0 (nada sobrou; o que faltou não é acumulado)
  assert.equal(s.wa.simulated.length, 12);
  const avisos = s.db.prepare("SELECT message FROM log WHERE level IN ('aviso','info') ORDER BY id").all().map((l) => l.message);
  assert.match(avisos[0], /^Horário 09:10: saíram 6 de 10 ofertas/);
  assert.match(avisos[1], /Sem ofertas novas dentro dos filtros desta vez\./);
  assert.equal(avisos.length, 2, avisos.join(' | ')); // com 0 ofertas não há "saíram 0 de 3": é a mensagem de hoje
  assert.equal(linhaRegra(s.db, id).next_run_at, dia(3, 9, 0));
});

test('CA5: no modo grade as pausas de Ajustes valem entre os grupos e entre as ofertas (sem o modo rápido)', async (t) => {
  relogio(t, dia(2, 9, 0));
  const s = montar({ fast: false });
  s.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('delay_group_s', '1'), ('delay_offer_s', '1')").run();
  s.regra({ grupos: ['111@g.us', '222@g.us'], grade: gradeDe(['09:00', 2], ['12:00', 1]), next: dia(2, 9, 0) });
  const marcas = []; const enviar = s.wa.sendText.bind(s.wa);
  s.wa.sendText = async (jid, text) => { marcas.push([jid, performance.now()]); return enviar(jid, text); };
  await s.scheduler.tick();
  assert.deepEqual(marcas.map(([j]) => j), ['111@g.us', '222@g.us', '111@g.us', '222@g.us']);
  // jitter de 0,7 a 1,3 vez o valor: pelo menos 0,65 s entre dois envios seguidos (grupo e oferta), nunca em rajada
  for (let i = 1; i < marcas.length; i++) assert.ok(marcas[i][1] - marcas[i - 1][1] >= 650, `pausa ${i}: ${Math.round(marcas[i][1] - marcas[i - 1][1])} ms`);
});

test('CA2: ciclo ponta a ponta intervalo → horários marcados → intervalo: o ritmo antigo volta intacto e a regra roda com o per_run de antes', async (t) => {
  relogio(t, dia(2, 10, 0));
  const s = montar();
  const p = await painel(s);
  try {
    const corpo = corpoRegra({ per_run: 2, interval_min: 40, window_start: '08:00', window_end: '22:00' });
    const id = (await p.enviar('POST', '/api/rules', corpo)).json.id;
    await s.scheduler.tick(); // intervalo: 2 ofertas já; próximo = 10:40
    assert.equal(s.wa.simulated.length, 2);
    assert.equal(linhaRegra(s.db, id).next_run_at, dia(2, 10, 40));
    // vira "horários marcados": o ritmo do intervalo continua gravado
    const g = await p.enviar('PUT', `/api/rules/${id}`, { ...corpo, grade: gradeDe(['11:00', 1], ['15:00', 3]) });
    assert.equal(g.status, 200, g.txt);
    let r = linhaRegra(s.db, id);
    assert.deepEqual([r.per_run, r.interval_min, r.window_start, r.window_end, r.next_run_at], [2, 40, '08:00', '22:00', null]);
    await s.scheduler.tick(); // NULL: grava o próximo horário e não envia
    assert.equal(linhaRegra(s.db, id).next_run_at, dia(2, 11, 0));
    assert.equal(s.wa.simulated.length, 2);
    t.mock.timers.setTime(dia(2, 11, 0, 3)); await s.scheduler.tick();
    assert.equal(s.wa.simulated.length, 3, 'o horário das 11:00 tem 1 oferta (não as 2 do per_run)');
    // volta ao intervalo (grade nula): zera o next_run_at, roda já com o per_run e o intervalo guardados
    const volta = await p.enviar('PUT', `/api/rules/${id}`, { ...corpo, grade: null });
    assert.equal(volta.status, 200, volta.txt);
    assert.equal((await p.get('/api/rules')).json[0].grade, null);
    t.mock.timers.setTime(dia(2, 11, 10)); await s.scheduler.tick();
    assert.equal(s.wa.simulated.length, 5, 'voltou a sair 2 por vez');
    r = linhaRegra(s.db, id);
    assert.equal(r.next_run_at, dia(2, 11, 50), '11:10 + 40 min de intervalo, dentro da janela 08:00–22:00');
    assert.equal(r.grade, null);
  } finally { await p.fechar(); }
});

// =====================================================================================================================
// CA11, CA12: Grupo vivo ponta a ponta (enquete e textos em rodízio)
// =====================================================================================================================

test('E2E Grupo vivo: rotina de enquete (2 enquetes, 2 horários) e rotina de textos (3 em rodízio) saem pelo tick, em ordem, com o nome no Histórico', async (t) => {
  relogio(t, dia(2, 7, 0));
  const s = montar();
  const p = await painel(s);
  try {
    const Q1 = { pergunta: 'Qual categoria você quer ver mais?', opcoes: ['Casa', 'Moda', 'Tech'], multipla: false };
    const Q2 = { pergunta: 'Que horas você mais compra?', opcoes: ['Manhã', 'Noite'], multipla: true };
    const enq = await p.enviar('POST', '/api/rotinas', { nome: 'Enquete da semana', tipo: 'enquete', conteudos: [Q1, Q2], ordem: 'rodizio', group_jids: ['111@g.us'], repetir: { dias: TODOS, horarios: ['08:00', '20:00'] } });
    const bom = await p.enviar('POST', '/api/rotinas', { nome: 'Bom dia', tipo: 'mensagem', conteudos: ['Bom dia, pessoal!', 'Bom dia! Café na mão.', 'Bom dia, gente!'], ordem: 'rodizio', group_jids: ['111@g.us', '222@g.us'], repetir: { dias: TODOS, horarios: ['08:00'] } });
    assert.equal(enq.status, 200, enq.txt); assert.equal(bom.status, 200, bom.txt);
    const lista0 = (await p.get('/api/rotinas')).json;
    assert.deepEqual(lista0.map((r) => [r.nome, r.next_run_at, r.enviadas_24h]), [['Enquete da semana', dia(2, 8, 0), 0], ['Bom dia', dia(2, 8, 0), 0]]);

    const marcos = [[dia(2, 7, 59, 45), 0], [dia(2, 8, 0), 3], [dia(2, 8, 0, 15), 0], [dia(2, 19, 59, 45), 0], [dia(2, 20, 0), 1],
      [dia(3, 8, 0), 3], [dia(3, 20, 0), 1], [dia(4, 8, 0), 3], [dia(4, 20, 0), 1], [dia(5, 8, 0), 3]];
    const rotulos = [];
    for (const [ts, esperado] of marcos) {
      t.mock.timers.setTime(ts);
      const antes = s.wa.simulated.length;
      await s.scheduler.tick();
      assert.equal(s.wa.simulated.length - antes, esperado, `dia ${new Date(ts).getDate()} às ${new Date(ts).toTimeString().slice(0, 8)}`);
      for (const m of s.wa.simulated.slice(antes)) rotulos.push(m.tipo === 'poll' ? `poll:${m.text}` : `${m.jid.slice(0, 3)}:${m.text}`);
    }
    // o rodízio anda a cada ocorrência que sai: a enquete alterna Q1/Q2 (08:00 e 20:00), os textos seguem 1, 2, 3 e voltam ao 1º
    assert.deepEqual(rotulos, [
      `poll:${Q1.pergunta}`, '111:Bom dia, pessoal!', '222:Bom dia, pessoal!',        // 02/11 08:00
      `poll:${Q2.pergunta}`,                                                           // 02/11 20:00
      `poll:${Q1.pergunta}`, '111:Bom dia! Café na mão.', '222:Bom dia! Café na mão.', // 03/11 08:00
      `poll:${Q2.pergunta}`,                                                           // 03/11 20:00
      `poll:${Q1.pergunta}`, '111:Bom dia, gente!', '222:Bom dia, gente!',             // 04/11 08:00
      `poll:${Q2.pergunta}`,                                                           // 04/11 20:00
      `poll:${Q1.pergunta}`, '111:Bom dia, pessoal!', '222:Bom dia, pessoal!',         // 05/11 08:00
    ]);
    // a enquete chegou com as opções e a escolha da rotina (Q2 é de resposta múltipla)
    const polls = s.wa.simulated.filter((m) => m.tipo === 'poll');
    assert.deepEqual([polls[0].poll.values, polls[0].poll.selectableCount], [['Casa', 'Moda', 'Tech'], 1]);
    assert.deepEqual([polls[1].poll.values, polls[1].poll.selectableCount], [['Manhã', 'Noite'], 0]);
    // Histórico: o nome da rotina, uma linha por grupo, nunca JID, nenhum aviso de horário pulado
    const log = (await p.get('/api/log?limite=200')).json;
    assert.equal(log.length, 15);
    assert.ok(log.every((l) => /^Grupo vivo: (Enquete da semana|Bom dia)$/.test(l.rule_name)), 'só linhas de rotina neste cenário');
    assert.deepEqual(log.filter((l) => l.level !== 'ok' || /@g\.us/.test(JSON.stringify(l))).map((l) => l.message), []);
    // cartão: contagem das últimas 24 h (de 04/11 08:05 a 05/11 08:05: 20:00 e 08:00) e o próximo horário de cada uma
    t.mock.timers.setTime(dia(5, 8, 5));
    const lista = (await p.get('/api/rotinas')).json;
    assert.deepEqual(lista.map((r) => [r.nome, r.enviadas_24h, r.erros_24h, r.next_run_at]), [
      ['Enquete da semana', 2, 0, dia(5, 20, 0)], ['Bom dia', 2, 0, dia(6, 8, 0)],
    ]);
  } finally { await p.fechar(); }
});

// =====================================================================================================================
// Freio de 1 por minuto do "Enviar agora" e teto de 50 rotinas (pela API)
// =====================================================================================================================

const rotinaCorpo = (mais = {}) => ({ nome: 'Bom dia', tipo: 'mensagem', conteudos: ['um', 'dois', 'tres'], ordem: 'rodizio', group_jids: ['111@g.us'], repetir: { dias: TODOS, horarios: ['08:00'] }, ...mais });
const FRASE_FREIO = 'Esta rotina já foi enviada agora há pouco. Espere um minuto para enviar de novo.';
const aguardarEnvios = async (s, n) => { for (let i = 0; i < 400 && s.wa.simulated.length < n; i++) await espera(10); await espera(30); };

test('freio: "Enviar agora" aceita 1 por minuto em cada rotina (429 com a frase), 59,999 s ainda freia, 60 s libera, e uma rotina não freia a outra', async (t) => {
  relogio(t, dia(2, 12, 0));
  const s = montar();
  const p = await painel(s);
  try {
    const a = (await p.enviar('POST', '/api/rotinas', rotinaCorpo({ nome: 'A' }))).json.id;
    const b = (await p.enviar('POST', '/api/rotinas', rotinaCorpo({ nome: 'B', group_jids: ['222@g.us'] }))).json.id;
    const r1 = await p.enviar('POST', `/api/rotinas/${a}/enviar`);
    assert.equal(r1.status, 200, r1.txt);
    assert.equal(r1.json.grupos, 1);
    await aguardarEnvios(s, 1);
    assert.deepEqual(s.wa.simulated.map((m) => m.text), ['um']);
    // clique repetido no mesmo segundo e 30 s depois: 429, a frase da tela, nenhum envio novo e o rodízio não anda
    for (const ms of [0, 1, 30000, 59999]) {
      t.mock.timers.setTime(dia(2, 12, 0) + ms);
      const r = await p.enviar('POST', `/api/rotinas/${a}/enviar`);
      assert.equal(r.status, 429, `${ms} ms depois`);
      assert.equal(r.json.erro, FRASE_FREIO);
    }
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM envios').get().n, 1, 'o freio vem antes de gravar');
    assert.equal(s.db.prepare('SELECT proximo_indice FROM rotinas WHERE id = ?').get(a).proximo_indice, 1);
    // outra rotina no mesmo instante não é freada
    const rb = await p.enviar('POST', `/api/rotinas/${b}/enviar`);
    assert.equal(rb.status, 200, rb.txt);
    // 60 s depois libera, e o rodízio segue (texto 2)
    t.mock.timers.setTime(dia(2, 12, 1));
    const r2 = await p.enviar('POST', `/api/rotinas/${a}/enviar`);
    assert.equal(r2.status, 200, r2.txt);
    await aguardarEnvios(s, 3);
    assert.deepEqual(s.wa.simulated.filter((m) => m.jid === '111@g.us').map((m) => m.text), ['um', 'dois']);
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM envios').get().n, 3);
    assert.equal((await p.enviar('POST', `/api/rotinas/${a}/enviar`)).status, 429, 'o novo envio rearma o freio');
  } finally { await p.fechar(); }
});

test('freio: cinco cliques simultâneos no "Enviar agora" geram um envio só', async (t) => {
  relogio(t, dia(2, 12, 0));
  const s = montar();
  const p = await painel(s);
  try {
    const id = (await p.enviar('POST', '/api/rotinas', rotinaCorpo())).json.id;
    const rs = await Promise.all(Array.from({ length: 5 }, () => p.enviar('POST', `/api/rotinas/${id}/enviar`)));
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 429, 429, 429, 429]);
    await aguardarEnvios(s, 1);
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM envios').get().n, 1);
    assert.equal(s.wa.simulated.length, 1);
  } finally { await p.fechar(); }
});

test('freio: só conta o que foi aceito (WhatsApp fora e rotina sem grupo não armam), e a ocorrência do horário não gasta o "Enviar agora"', async (t) => {
  relogio(t, dia(2, 7, 59, 50));
  const s = montar();
  const p = await painel(s);
  try {
    const id = (await p.enviar('POST', '/api/rotinas', rotinaCorpo())).json.id;
    const pronto = s.wa.isReady; s.wa.isReady = () => false;
    const fora = await p.enviar('POST', `/api/rotinas/${id}/enviar`);
    assert.equal(fora.status, 400); assert.match(fora.json.erro, /WhatsApp está desconectado/);
    s.wa.isReady = pronto;
    // grupos que não existem mais: 400 sem gravar, e o pedido recusado também não arma o freio
    const sem = (await p.enviar('POST', '/api/rotinas', rotinaCorpo({ nome: 'Sem grupo', group_jids: ['333@g.us'], enabled: false }))).json.id;
    s.db.prepare("DELETE FROM groups WHERE jid = '333@g.us'").run();
    assert.equal((await p.enviar('POST', `/api/rotinas/${sem}/enviar`)).status, 400);
    s.db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run('333@g.us', 'Grupo 333', 10, Date.now());
    assert.equal((await p.enviar('POST', `/api/rotinas/${sem}/enviar`)).status, 200, 'o 400 anterior não deixou freio');
    await aguardarEnvios(s, 1);
    s.wa.simulated.length = 0;
    // a ocorrência das 08:00 sai pelo tick; logo depois o dono clica em "Enviar agora" e passa (não é a mesma coisa)
    t.mock.timers.setTime(dia(2, 8, 0, 5)); await s.scheduler.tick();
    assert.deepEqual(s.wa.simulated.map((m) => m.text), ['um']);
    t.mock.timers.setTime(dia(2, 8, 0, 10));
    const agora = await p.enviar('POST', `/api/rotinas/${id}/enviar`);
    assert.equal(agora.status, 200, agora.txt);
    await aguardarEnvios(s, 2);
    assert.deepEqual(s.wa.simulated.map((m) => m.text), ['um', 'dois']);
    // o próximo horário (terça 08:00) não mudou com o "Enviar agora"
    assert.equal(s.db.prepare('SELECT next_run_at FROM rotinas WHERE id = ?').get(id).next_run_at, dia(3, 8, 0));
  } finally { await p.fechar(); }
});

test('teto: 50 rotinas (ligadas ou não); a 51ª volta 400 com a frase, nada é gravado, excluir libera uma vaga e o id não é reaproveitado', async (t) => {
  relogio(t, dia(2, 7, 0));
  const s = montar();
  const p = await painel(s);
  try {
    for (let i = 1; i <= 50; i++) {
      const r = await p.enviar('POST', '/api/rotinas', rotinaCorpo({ nome: `Rotina ${i}`, enabled: i % 2 === 0 }));
      assert.equal(r.status, 200, `rotina ${i}: ${r.txt}`);
    }
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM rotinas').get().n, 50);
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM rotinas WHERE enabled = 0').get().n, 25, 'as desligadas contam no teto');
    const frase = 'O programa guarda no máximo 50 rotinas. Exclua uma para criar outra.';
    const r51 = await p.enviar('POST', '/api/rotinas', rotinaCorpo({ nome: 'Rotina 51' }));
    assert.deepEqual([r51.status, r51.json.erro], [400, frase]);
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM rotinas').get().n, 50);
    assert.equal((await p.get('/api/rotinas')).json.length, 50, 'a lista mostra as 50');
    // editar, ligar e desligar não esbarram no teto
    assert.equal((await p.enviar('PUT', '/api/rotinas/7', { nome: 'Sete' })).status, 200);
    assert.equal((await p.enviar('POST', '/api/rotinas/8/enabled', { enabled: false })).status, 200);
    // a 50 já enviou algo (o que ficou no Histórico não pode passar a contar para outra): o id dela não volta
    assert.equal((await p.enviar('POST', '/api/rotinas/50/enviar')).status, 200);
    await aguardarEnvios(s, 1);
    // excluir libera exatamente uma vaga
    assert.equal((await p.enviar('DELETE', '/api/rotinas/50')).status, 200);
    const nova = await p.enviar('POST', '/api/rotinas', rotinaCorpo({ nome: 'Nova' }));
    assert.equal(nova.status, 200, nova.txt);
    assert.equal(nova.json.id, 51, 'o id da excluída que tem envios não volta');
    assert.equal((await p.enviar('POST', '/api/rotinas', rotinaCorpo({ nome: 'Outra' }))).status, 400);
  } finally { await p.fechar(); }
});

test('teto: com 48 guardadas, 6 criações simultâneas passam duas e recusam quatro (a contagem é atômica)', async (t) => {
  relogio(t, dia(2, 7, 0));
  const s = montar();
  const p = await painel(s);
  try {
    for (let i = 1; i <= 48; i++) assert.equal((await p.enviar('POST', '/api/rotinas', rotinaCorpo({ nome: `R${i}`, enabled: false }))).status, 200);
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => p.enviar('POST', '/api/rotinas', rotinaCorpo({ nome: `Corrida ${i}`, enabled: false }))));
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 200, 400, 400, 400, 400]);
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM rotinas').get().n, 50);
  } finally { await p.fechar(); }
});

test('teto: 50 rotinas ligadas no mesmo horário saem todas, uma vez cada, no mesmo tick, sem derrubar uma regra com grade do mesmo minuto', async (t) => {
  relogio(t, dia(2, 7, 59, 50));
  const s = montar();
  for (let i = 1; i <= 50; i++) s.scheduler.rotinas.criar(rotinaCorpo({ nome: `R${i}`, group_jids: [['111@g.us', '222@g.us', '333@g.us'][i % 3]] }));
  const regra = s.regra({ name: 'Regra da grade', grupos: ['111@g.us'], grade: gradeDe(['08:00', 2]), next: dia(2, 8, 0) });
  t.mock.timers.setTime(dia(2, 8, 0, 5));
  await s.scheduler.tick();
  const dasRotinas = s.wa.simulated.filter((m) => ['um', 'dois', 'tres'].includes(m.text));
  assert.equal(dasRotinas.length, 50);
  assert.equal(s.wa.simulated.length, 52, '50 das rotinas + 2 ofertas da regra');
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM log WHERE rule_name LIKE 'Grupo vivo: %' AND level = 'ok'").get().n, 50);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM log WHERE rule_name = 'Regra da grade' AND level = 'ok'").get().n, 2);
  assert.equal(linhaRegra(s.db, regra).next_run_at, dia(3, 8, 0));
  await s.scheduler.tick();
  assert.equal(s.wa.simulated.length, 52, 'o tick seguinte não repete nada');
});

test('nenhum acesso à rede no arquivo inteiro', () => {
  globalThis.fetch = globalFetch;
  assert.equal(acessosRede, 0);
});
