// QA da entrega 3 (Vigia), rodada 2: prova, de ponta a ponta (agendador, vigia, avisos, ritmo, catálogo e banco reais
// numa pasta temporária; só o WhatsApp simulado, a extensão/Central, o Etiqueta e o verificador são de mentira), as
// correções da rodada 1: Q2 (suspensão do computador), R9 (ts da execução com horários marcados), R1/Q1 (regra mista),
// R7 (Falhas), poda do freio e S1 (nome de regra). Relógio: só o Date é falso (desde antes do agendador); o relógio
// monotônico do vigia é o Date falso menos o tempo "dormido" (s.relogio.dormiu). Nenhuma rede, nenhum aleatório.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openDb, setSetting, getSetting } from '../src/db.js';
import { createScheduler } from '../src/scheduler.js';
import { createLinkService, ErroLinkML } from '../src/links.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createCatalogoItens } from '../src/catalogo-itens.js';
import { createAmazon } from '../src/amazon.js';
import { paraCandidato } from '../src/catalogo.js';
import { buildApp } from '../src/server.js';
import { CHAVE_ESTADO } from '../src/vigia.js';

const fetchOriginal = globalThis.fetch;
let chamadasDeRede = 0;
test.before(() => { globalThis.fetch = async () => { chamadasDeRede++; throw new Error('rede proibida no teste'); }; });
test.after(() => {
  globalThis.fetch = fetchOriginal;
  assert.equal(chamadasDeRede, 0, 'nenhum pedido de rede');
});

const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-qa-vigia2-')); pastas.push(p); return p; };

const MIN = 60000;
const HORA = 60 * MIN;
const dia = (d, h, m = 0, s = 0) => new Date(2026, 10, d, h, m, s).getTime(); // novembro/2026, horário local
const G1 = '111@g.us';
const PEDRO = '5511900000001@s.whatsapp.net';

const SIL = ['ba', 'ce', 'di', 'fo', 'gu', 'ha', 'je', 'ki', 'lo', 'mu'];
const palavra = (i, k) => `${SIL[(i + k) % 10]}${SIL[(Math.floor(i / 10) + 3 * k) % 10]}${SIL[(i * (k + 2) + 7 * k) % 10]}nex${k}`;
const titulo = (i) => `Produto ${palavra(i, 1)} ${palavra(i, 2)} ${palavra(i, 3)}`;

function oferta(i, loja, { precoEm = null } = {}) {
  const o = { id: i, loja, titulo: titulo(i), preco: 100, preco_antigo: 150, desconto_pct: 33, categoria: 'Casa' };
  if (loja === 'amazon') Object.assign(o, { item_id: `B0${String(i).padStart(8, '0')}`, link: 'https://www.amazon.com.br/dp/X?tag=terceiro-20' });
  if (loja === 'ml') Object.assign(o, { item_id: `MLB${4000000000 + i}`, link: 'https://meli.la/TerCeiro1' });
  if (precoEm != null) {
    const d = new Date(precoEm); const p = (n) => String(n).padStart(2, '0');
    o.preco_em = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  return o;
}

/** Verificador falso: `semConferencia` (Set de precoEm que não têm como ser conferidos agora) é mutável. */
function verificadorFalso({ semConferencia = new Set() } = {}) {
  const v = {
    semConferencia,
    ativo: () => true,
    async conferir(o) { return { acao: 'enviar', oferta: o, sufixo: null }; },
    semConfirmacaoAgora: ({ loja, precoEm }) => loja === 'amazon' && v.semConferencia.has(precoEm),
    pausaDaLeituraMl: () => null,
  };
  return v;
}

function linksDuble({ online = true, central = 'respondendo', desde = null } = {}) {
  const base = createLinkService({ getMode: () => 'fake' });
  const pedir = base.requestLink;
  const d = { online, central: { estado: central, emEsperaDesde: desde }, link: null, modo: 'extension', ultimoPoll: online ? Date.now() : 0 };
  Object.assign(base, {
    modo: () => d.modo,
    status: () => ({ online: d.online, lastPollAt: d.online ? Date.now() : d.ultimoPoll, central: { ...d.central } }),
    central: () => ({ ...d.central, testeLiberado: false }),
    requestLink: (p) => (d.link ? d.link(p) : pedir(p)),
    async requestOffers() { throw new ErroLinkML('nenhum pedido saiu', { classe: 'espera', causa: 'central_sem_resposta' }); },
  });
  d.cair = () => { d.ultimoPoll = Date.now(); d.online = false; };
  return { links: base, d };
}

function montar(t, { agora = dia(12, 8), links = null, verificador = null, ofertas = [] } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: agora });
  const dir = tmp(); const db = openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  if (!links) links = linksDuble().links;
  const amazon = createAmazon({ db, fetch: async () => { throw new Error('rede proibida (Amazon)'); }, esperar: async () => {}, lerConexao: () => ({ tag: 'achadinho-20' }) });
  const estado = { ofertas };
  const fonte = {
    async candidatos(cfg, ctx) { return estado.ofertas.filter((o) => (cfg.lojas?.length ? cfg.lojas.includes(o.loja) : true)).map(paraCandidato).filter((c) => c && !ctx.tratada(c, cfg.ordem)); },
    avancar() {},
  };
  const catalogoItens = createCatalogoItens({ db, wa, links, amazon });
  const relogio = { dormiu: 0 };
  const agendador = (l = links) => createScheduler({ db, wa, links: l, fast: true, amazon, verificador, catalogo: fonte, catalogoItens, monotonico: () => Date.now() - relogio.dormiu });
  const scheduler = agendador();
  db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(G1, 'Achadinhos', 10, Date.now());
  db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etiquetaA', Date.now());
  db.prepare('INSERT INTO aviso_destinos (nome, jid, resumo_blocos, avisos, ativo, created_at) VALUES (?,?,?,?,?,?)')
    .run('Pedro', PEDRO, null, JSON.stringify(['erro']), 1, 1);
  const s = { db, dir, wa, links, estado, scheduler, agendador, verificador, relogio };
  s.paraPedro = () => wa.simulated.filter((m) => m.jid === PEDRO).map((m) => m.text);
  s.paraGrupo = () => wa.simulated.filter((m) => m.jid === G1).length;
  s.execucoes = () => db.prepare('SELECT * FROM execucoes ORDER BY id').all()
    .map((x) => ({ ...x, lojas_pedidas: JSON.parse(x.lojas_pedidas), por_loja: JSON.parse(x.por_loja) }));
  s.linhasVigia = () => db.prepare("SELECT level, message FROM log WHERE rule_name = 'Vigia' ORDER BY id").all().map((l) => ({ ...l }));
  s.estadoGravado = () => JSON.parse(getSetting(db, CHAVE_ESTADO));
  s.avancar = (ms) => t.mock.timers.setTime(Date.now() + ms);
  s.ir = (quando) => t.mock.timers.setTime(quando);
  /** O computador suspende e acorda em `quando`: o relógio de parede anda, o monotônico não. */
  s.suspenderAte = (quando) => { s.relogio.dormiu += quando - Date.now(); s.ir(quando); };
  return s;
}

const COLUNAS = 'name, enabled, tag_id, template_id, group_jids, source_type, source_config, sources, per_run, interval_min, window_start, window_end, dedupe_days, send_image, created_at';
function regraCatalogo(db, { nome = 'Catálogo', lojas = ['ml'], per = 1, janela = ['08:00', '22:00'], intervalo = 60, id = null } = {}) {
  const fontes = [{ type: 'catalogo', tag_id: null, config: { ordem: 'relevancia', lojas } }];
  return inserir(db, { nome, fontes, per, janela, intervalo, id });
}
function inserir(db, { nome, fontes, per = 1, janela = ['08:00', '22:00'], intervalo = 60, id = null }) {
  const cols = id ? `id, ${COLUNAS}` : COLUNAS;
  return Number(db.prepare(`INSERT INTO rules (${cols}) VALUES (${id ? '?, ' : ''}?, 1, 1, 1, ?, 'list', '{}', ?, ?, ?, ?, ?, 7, 0, ?)`)
    .run(...(id ? [id] : []), nome, JSON.stringify([G1]), JSON.stringify(fontes), per, intervalo, janela[0], janela[1], Date.now()).lastInsertRowid);
}
const itensLista = (ids) => ids.map((i) => `https://produto.mercadolivre.com.br/MLB-${4000000000 + i}-x | ${titulo(i)} | 50`).join('\n');

async function manual(s, id) {
  await s.scheduler.vigia.tick();
  await s.scheduler.runRule(id, { manual: true });
  await s.scheduler.vigia.aposExecucao();
}
const passada = (s) => s.scheduler.vigia.tick();

function req(port, caminho) {
  return new Promise((ok, err) => {
    const r = http.request({ host: '127.0.0.1', port, path: caminho, method: 'GET', headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let txt = ''; res.setEncoding('utf8'); res.on('data', (c) => (txt += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(txt); } catch { /* html */ } ok({ status: res.statusCode, json }); });
    });
    r.on('error', err); r.end();
  });
}
function subirPainel(t, s) {
  const app = buildApp({ db: s.db, wa: s.wa, links: s.links, scheduler: s.scheduler, publicHost: '', panelPassword: '', dataDir: s.dir });
  return new Promise((ok) => {
    const server = app.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }));
      ok({ port: server.address().port });
    });
  });
}

// ============================================================================================ Q2: suspensão do computador

/** Mundo da suspensão: regra de ML (janela 08:00 a 22:00, a cada 60 min), extensão on-line às 21:00 com um envio feito. */
async function noiteDeSuspensao(t) {
  const { links, d } = linksDuble();
  const s = montar(t, { links, agora: dia(11, 21), ofertas: [0, 1, 2, 3, 4, 5].map((i) => oferta(i, 'ml')) });
  regraCatalogo(s.db);
  await s.scheduler.tick(); // 21:00: a extensão está on-line (último contato 21:00) e o ML envia
  assert.equal(s.paraGrupo(), 1);
  return { s, d };
}

test('Q2: PC suspenso a noite inteira e a extensão reconecta 10 min depois de acordar (dentro da carência): nenhum aviso, nem "voltou"', async (t) => {
  const { s, d } = await noiteDeSuspensao(t);
  d.cair();                                // a extensão perde a conexão junto com a suspensão (último contato 21:00)
  s.suspenderAte(dia(12, 8, 0, 2));
  await s.scheduler.tick();                // 1º tick ao acordar: a regra vencida roda e o ML espera a extensão
  for (let k = 1; k <= 9; k++) { s.avancar(MIN); await s.scheduler.tick(); } // 08:01 a 08:09: ainda fora
  s.ir(dia(12, 8, 10)); d.online = true; d.ultimoPoll = Date.now();
  await s.scheduler.tick();
  s.avancar(HORA); await s.scheduler.tick(); // 09:10: a regra roda de novo e envia
  assert.deepEqual(s.paraPedro(), [], 'sem aviso: a extensão esteve fora 10 min depois de acordar, não 11 h');
  assert.deepEqual(s.scheduler.vigia.estado().causas, []);
  assert.deepEqual(s.linhasVigia(), [], 'nenhuma linha do vigia no Histórico');
});

test('Q2: a extensão que de fato não volta depois de acordar avisa depois da carência, com o "desde" do despertar (não o da véspera)', async (t) => {
  const { s, d } = await noiteDeSuspensao(t);
  d.cair();
  s.suspenderAte(dia(12, 8, 0, 2));
  await s.scheduler.tick();                         // 08:00: execução 1 (falta de 2 s)
  assert.deepEqual(s.paraPedro(), []);
  s.ir(dia(12, 8, 40)); await s.scheduler.tick();    // dentro da hora: a regra não roda (intervalo de 60 min)
  assert.deepEqual(s.paraPedro(), []);
  s.ir(dia(12, 9, 0, 3)); await s.scheduler.tick();  // 09:00: execução 2, com 60 min de falta contados do despertar
  const msgs = s.paraPedro();
  assert.equal(msgs.length, 1, msgs.join('\n---\n'));
  assert.match(msgs[0], /^⚠️ \*Extensão do Chrome desconectada desde 08:00\*\nO Mercado Livre não envia sem ela/);
  assert.doesNotMatch(msgs[0], /21:00|de 11\/11/, 'o "desde" não volta à véspera');
  assert.equal(s.scheduler.vigia.estado().causas[0].desdeEm, dia(12, 8, 0, 2), 'a causa fica gravada com o despertar');
  // e a causa tem "voltou" quando a extensão responde
  d.online = true; d.ultimoPoll = Date.now(); s.avancar(MIN); await s.scheduler.tick();
  assert.equal(s.paraPedro().length, 2);
  assert.match(s.paraPedro()[1], /^✅ \*Mercado Livre voltou a enviar\*\nA extensão do Chrome voltou a se conectar \(esteve fora por 1 h 1 min\)/);
});

test('Q2: execução longa (40 min entre duas passadas) com o PC acordado NÃO zera a carência; a mesma lacuna com o PC suspenso, sim', async (t) => {
  await t.test('PC acordado: a falta conta desde 08:00 e o aviso sai na execução de 08:40', async (tt) => {
    const { links, d } = linksDuble();
    const s = montar(tt, { links, agora: dia(12, 8), ofertas: [0, 1, 2, 3].map((i) => oferta(i, 'ml')) });
    const id = regraCatalogo(s.db);
    d.cair();                                                     // fora desde 08:00
    await manual(s, id);                                          // 08:00: falta de 0 min
    assert.deepEqual(s.paraPedro(), []);
    s.avancar(40 * MIN);                                          // uma passada longa: os dois relógios andam juntos
    await manual(s, id);                                          // 08:40: 40 min de falta
    const msgs = s.paraPedro();
    assert.equal(msgs.length, 1, msgs.join('\n---\n'));
    assert.match(msgs[0], /^⚠️ \*Extensão do Chrome desconectada desde 08:00\*/);
  });
  await t.test('PC suspenso nos mesmos 40 min: a falta recomeça às 08:40 e nada avisa ainda', async (tt) => {
    const { links, d } = linksDuble();
    const s = montar(tt, { links, agora: dia(12, 8), ofertas: [0, 1, 2, 3].map((i) => oferta(i, 'ml')) });
    const id = regraCatalogo(s.db);
    d.cair();
    await manual(s, id);
    s.suspenderAte(dia(12, 8, 40));
    await manual(s, id);
    assert.deepEqual(s.paraPedro(), [], 'o computador estava suspenso: a falta recomeça ao acordar');
    s.ir(dia(12, 9, 11)); await manual(s, id);                    // 31 min depois de acordar: a carência passou
    assert.match(s.paraPedro().join('\n'), /^⚠️ \*Extensão do Chrome desconectada desde 08:40\*/);
  });
});

test('Q2: suspensão curta (3 min, abaixo dos 5 do vigia) não recomeça a carência: a falta segue contada de quando a extensão caiu', async (t) => {
  const { links, d } = linksDuble();
  const s = montar(t, { links, agora: dia(12, 8), ofertas: [0, 1, 2, 3].map((i) => oferta(i, 'ml')) });
  const id = regraCatalogo(s.db);
  d.cair();
  await manual(s, id);                 // 08:00
  s.avancar(20 * MIN); await passada(s);
  s.suspenderAte(Date.now() + 3 * MIN); // 08:23: o PC dormiu 3 min
  await passada(s);
  s.ir(dia(12, 8, 40)); await manual(s, id);
  assert.match(s.paraPedro().join('\n'), /^⚠️ \*Extensão do Chrome desconectada desde 08:00\*/);
});

test('Q2: dois ciclos de suspensão seguidos: cada despertar recomeça a carência; o "desde" é o do último', async (t) => {
  const { s, d } = await noiteDeSuspensao(t);
  d.cair();
  s.suspenderAte(dia(12, 2, 0));   // 1º ciclo: 21:00 a 02:00 (fora da janela das regras)
  await s.scheduler.tick();
  s.avancar(5 * MIN); await s.scheduler.tick();
  s.suspenderAte(dia(12, 8, 0, 5)); // 2º ciclo: 02:05 a 08:00
  await s.scheduler.tick();         // 08:00: execução 1
  assert.deepEqual(s.paraPedro(), [], 'nenhum alarme ao acordar, em nenhum dos dois ciclos');
  s.ir(dia(12, 9, 0, 5)); await s.scheduler.tick(); // execução 2: 60 min depois do último despertar
  const msgs = s.paraPedro();
  assert.equal(msgs.length, 1, msgs.join('\n---\n'));
  assert.match(msgs[0], /^⚠️ \*Extensão do Chrome desconectada desde 08:00\*/);
  assert.doesNotMatch(msgs[0], /02:0\d|21:00/);
});

// ============================================================================================ R9: ts das execuções com grade

const grade = (...horas) => JSON.stringify({ dias: [0, 1, 2, 3, 4, 5, 6], horarios: horas.map((hora) => ({ hora, qtd: 2, template_id: null })) });

test('R9: com horários marcados, execucoes.ts é o horário da grade (cumprido com atraso); "Às 12:00 e às 13:00" na mensagem; o "Enviar agora" grava o instante', async (t) => {
  const VELHO = dia(11, 8);
  const s = montar(t, { agora: dia(12, 12, 7), verificador: verificadorFalso({ semConferencia: new Set([VELHO]) }), ofertas: [oferta(0, 'amazon', { precoEm: VELHO }), oferta(1, 'amazon', { precoEm: VELHO })] });
  const id = regraCatalogo(s.db, { nome: 'Amazon', lojas: ['amazon'], per: 2 });
  s.db.prepare('UPDATE rules SET grade = ?, next_run_at = ? WHERE id = ?').run(grade('12:00', '13:00'), dia(12, 12), id);
  await s.scheduler.tick();                   // 12:07: cumpre o horário das 12:00
  s.ir(dia(12, 13, 25)); await s.scheduler.tick(); // 13:25: cumpre o das 13:00 (25 min de atraso, dentro dos 30)
  assert.deepEqual(s.execucoes().map((x) => x.ts), [dia(12, 12), dia(12, 13)], 'o horário da grade, não 12:07 e 13:25');
  const msgs = s.paraPedro();
  assert.equal(msgs.length, 1, msgs.join('\n---\n'));
  assert.match(msgs[0], /^⚠️ \*A regra “Amazon” saiu vazia 2 vezes seguidas\*\nÀs 12:00 e às 13:00 nenhuma oferta saiu/);
  s.ir(dia(12, 13, 40));
  await s.scheduler.runRule(id, { manual: true });
  const manualX = s.execucoes().at(-1);
  assert.equal(manualX.ts, dia(12, 13, 40), '"Enviar agora" grava o instante, não o próximo horário da grade');
  assert.equal(s.db.prepare('SELECT next_run_at FROM rules WHERE id = ?').get(id).next_run_at, dia(13, 12), 'e não mexe na grade (o próximo horário segue o da grade: 12:00 do dia seguinte)');
});

test('R9: horário da grade cumprido depois da meia-noite com atraso grava o horário (do dia anterior) e a mensagem traz a data', async (t) => {
  const VELHO = dia(11, 8);
  const s = montar(t, { agora: dia(12, 23, 40), verificador: verificadorFalso({ semConferencia: new Set([VELHO]) }), ofertas: [oferta(0, 'amazon', { precoEm: VELHO }), oferta(1, 'amazon', { precoEm: VELHO })] });
  const id = regraCatalogo(s.db, { nome: 'Amazon', lojas: ['amazon'], per: 2, janela: ['00:00', '23:59'] });
  s.db.prepare('UPDATE rules SET grade = ?, next_run_at = ? WHERE id = ?').run(grade('23:40', '23:50'), dia(12, 23, 40), id);
  await s.scheduler.tick();                         // 23:40: cumpre o horário das 23:40
  s.ir(dia(13, 0, 12)); await s.scheduler.tick();   // 00:12 de 13/11: cumpre o das 23:50 de 12/11 (22 min de atraso)
  assert.deepEqual(s.execucoes().map((x) => x.ts), [dia(12, 23, 40), dia(12, 23, 50)], 'o horário da grade (12/11), não o fim da execução (13/11)');
  const msgs = s.paraPedro();
  assert.equal(msgs.length, 1, msgs.join('\n---\n'));
  assert.match(msgs[0], /Às 23:40 de 12\/11 e às 23:50 de 12\/11 nenhuma oferta saiu/);
  assert.equal(s.execucoes().every((x) => x.ts <= Date.now()), true, 'nenhum ts no futuro');
});

test('R9: sem grade, o ts é o instante do fim da execução (como antes)', async (t) => {
  const s = montar(t, { agora: dia(12, 8), ofertas: [oferta(0, 'ml')] });
  regraCatalogo(s.db);
  await s.scheduler.tick();
  assert.deepEqual(s.execucoes().map((x) => x.ts), [dia(12, 8)]);
});

// ============================================================================================ R1/Q1: regra mista

/** Regra com o Catálogo (`lojas`) e a Lista de links de ML (fonte antiga) juntos. */
function regraMista(db, { nome = 'Mista', lojas = ['amazon'], ids = [0, 1, 2, 3, 4] } = {}) {
  const fontes = [
    { type: 'catalogo', tag_id: null, config: { ordem: 'relevancia', lojas } },
    { type: 'list', tag_id: null, config: { items: itensLista(ids) } },
  ];
  return inserir(db, { nome, fontes, per: 2, janela: ['08:00', '22:00'] });
}

test('R1/Q1: regra mista (Catálogo só Amazon + Lista de ML) pede Amazon e ML: lojas_pedidas traz as duas', async (t) => {
  const { links } = linksDuble();
  const s = montar(t, { links, ofertas: [] });
  regraMista(s.db);
  await s.scheduler.tick();
  assert.deepEqual(s.execucoes().map((x) => [...x.lojas_pedidas].sort()), [['amazon', 'ml']]);
});

test('R1/Q1: regra mista com a Central em espera: o "Mercado Livre em espera" sai; a regra vazia NÃO é calada (ela também pede a Amazon)', async (t) => {
  const VELHO = dia(11, 8);
  const { links, d } = linksDuble();
  d.central = { estado: 'em_espera', emEsperaDesde: dia(12, 8) };
  const s = montar(t, { links, verificador: verificadorFalso({ semConferencia: new Set([VELHO]) }), ofertas: [oferta(10, 'amazon', { precoEm: VELHO }), oferta(11, 'amazon', { precoEm: VELHO })] });
  regraMista(s.db, { ids: [0, 1, 2, 3, 4] });
  for (let k = 0; k < 3; k++) { await s.scheduler.tick(); s.avancar(HORA); }
  const msgs = s.paraPedro().join('\n---\n');
  assert.match(msgs, /\*Mercado Livre em espera desde 08:00\.\*/);
  assert.match(msgs, /\*A regra “Mista” saiu vazia 2 vezes seguidas\.\*/, 'a regra mista não é "só de ML": a Central não cala o aviso dela');
  assert.ok(!s.linhasVigia().some((l) => /a regra “Mista” saiu vazia, mas/.test(l.message)));
});

test('R1/Q1: regra só de ML pelo Catálogo e pela lista antiga (Catálogo ML + Lista) com a Central em espera: a regra vazia é calada', async (t) => {
  const { links, d } = linksDuble();
  d.central = { estado: 'em_espera', emEsperaDesde: dia(12, 8) };
  const s = montar(t, { links, ofertas: [0, 1, 2].map((i) => oferta(i, 'ml')) });
  regraMista(s.db, { nome: 'So ML', lojas: ['ml'] });
  for (let k = 0; k < 3; k++) { await s.scheduler.tick(); s.avancar(HORA); }
  assert.deepEqual(s.execucoes().map((x) => x.lojas_pedidas), [['ml'], ['ml'], ['ml']]);
  const msgs = s.paraPedro();
  assert.equal(msgs.length, 1, msgs.join('\n---\n'));
  assert.match(msgs[0], /^⚠️ \*Mercado Livre em espera desde 08:00\*/);
  assert.ok(s.linhasVigia().some((l) => l.level === 'info' && /a regra “So ML” saiu vazia, mas o Mercado Livre está em espera: sem aviso separado/.test(l.message)));
});

// ============================================================================================ R7: Falhas

test('R7: WhatsApp fora por 2 h (execução tentada a cada minuto, "Enviar agora" ou corrida): a saúde diz "Falhas: 0", não 120', async (t) => {
  const s = montar(t, { agora: dia(12, 8), ofertas: [0, 1, 2].map((i) => oferta(i, 'ml')) });
  const id = regraCatalogo(s.db);
  s.wa.isReady = () => false;
  for (let k = 0; k < 120; k++) { await s.scheduler.tick(); s.avancar(MIN); }
  assert.deepEqual(s.execucoes(), [], 'o tick nem roda a regra com o WhatsApp fora (observação: a tentativa a cada minuto só vem de "Enviar agora" ou de corrida)');
  s.ir(dia(12, 8));
  for (let k = 0; k < 120; k++) { await s.scheduler.runRule(id, { manual: true }); s.avancar(MIN); }
  const x = s.execucoes();
  assert.equal(x.length, 120);
  assert.ok(x.every((e) => e.conta === 0 && e.erros === 1), 'cada tentativa grava um erro e não conta');
  s.ir(dia(12, 10, 1));
  const p = await subirPainel(t, s);
  const { json } = await req(p.port, '/api/avisos/previa');
  assert.match(json.texto, /Falhas: 0\b/, json.texto);
  assert.doesNotMatch(json.texto, /Falhas: [1-9]/);
});

test('R7: uma falha de verdade (execução que conta, com erro) continua somando em "Falhas"', async (t) => {
  const { links, d } = linksDuble();
  const s = montar(t, { links, agora: dia(12, 8) });
  d.link = async () => { throw new ErroLinkML('A extensão do Chrome não está conectada.', { classe: 'desconectada', causa: 'extensao_off' }); };
  inserir(s.db, { nome: 'Antiga', fontes: [{ type: 'list', tag_id: null, config: { items: itensLista([0, 1, 2]) } }], per: 2 });
  s.wa.isReady = () => false;
  for (let k = 0; k < 30; k++) { await s.scheduler.tick(); s.avancar(MIN); } // 30 tentativas sem WhatsApp: nenhuma falha de verdade
  s.wa.isReady = () => true;
  d.cair();
  s.avancar(HORA); await s.scheduler.tick();
  const x = s.execucoes();
  const contam = x.filter((e) => e.conta === 1);
  assert.ok(contam.length >= 1 && contam.every((e) => e.erros >= 1), `a execução que conta falhou: ${JSON.stringify(contam.map((e) => [e.conta, e.erros]))}`);
  const esperado = contam.reduce((a, e) => a + e.erros, 0);
  const p = await subirPainel(t, s);
  const { json } = await req(p.port, '/api/avisos/previa');
  assert.match(json.texto, new RegExp(`Falhas: ${esperado}\\b`), json.texto);
});

// ============================================================================================ poda do freio

/** Amazon com 2 ofertas sem como conferir: a regra sai vazia. */
function mundoAmazonVazia(t) {
  const VELHO = dia(11, 6);
  const v = verificadorFalso({ semConferencia: new Set([VELHO]) });
  const s = montar(t, { agora: dia(12, 8), verificador: v, ofertas: [oferta(0, 'amazon', { precoEm: VELHO }), oferta(1, 'amazon', { precoEm: VELHO })] });
  return { s, v, VELHO };
}

test('poda do freio: id de regra reaproveitado por uma regra nova não herda o freio da antiga (avisa na hora)', async (t) => {
  const { s } = mundoAmazonVazia(t);
  const id = regraCatalogo(s.db, { nome: 'Velha', lojas: ['amazon'], per: 2, id: 77 });
  await manual(s, id); s.avancar(MIN); await manual(s, id);
  assert.equal(s.paraPedro().length, 1, 'a regra antiga avisou');
  assert.match(s.paraPedro()[0], /saiu vazia 2 vezes seguidas/);
  assert.ok(Object.hasOwn(s.estadoGravado().ultimoAviso, 'regra:77'), 'o freio da regra 77 está gravado');
  // a regra é apagada; a passada seguinte poda o freio
  s.db.prepare('DELETE FROM rules WHERE id = 77').run();
  s.avancar(MIN); await passada(s);
  assert.deepEqual(Object.keys(s.estadoGravado().ultimoAviso).filter((c) => c.startsWith('regra:')), [], 'freio podado');
  // 10 min depois (dentro das 3 h) uma regra NOVA ocupa o mesmo id e também sai vazia 2 vezes
  s.avancar(10 * MIN);
  const novo = regraCatalogo(s.db, { nome: 'Nova', lojas: ['amazon'], per: 2, id: 77 });
  assert.equal(novo, 77);
  await manual(s, novo); s.avancar(MIN); await manual(s, novo);
  const msgs = s.paraPedro();
  assert.equal(msgs.length, 2, msgs.join('\n---\n'));
  assert.match(msgs[1], /^⚠️ \*A regra “Nova” saiu vazia 2 vezes seguidas\*/);
});

test('poda do freio: a regra que segue ativa mantém o freio de 3 h (reabrir dentro dele não avisa; passadas as 3 h, avisa), mesmo com outra regra apagada no meio', async (t) => {
  const { s, v, VELHO } = mundoAmazonVazia(t);
  const r1 = regraCatalogo(s.db, { nome: 'Fica', lojas: ['amazon'], per: 2 });
  const r2 = regraCatalogo(s.db, { nome: 'Sai', lojas: ['ml'] });
  const inicio = Date.now();
  await manual(s, r1); s.avancar(MIN); await manual(s, r1);
  assert.equal(s.paraPedro().length, 1);
  // a outra regra é apagada (a poda roda), a "Fica" continua ativa: o freio dela continua gravado
  s.db.prepare('DELETE FROM rules WHERE id = ?').run(r2);
  s.avancar(MIN); await passada(s);
  assert.ok(Object.hasOwn(s.estadoGravado().ultimoAviso, `regra:${r1}`), 'o freio da regra ativa não é podado');
  // a regra sai de verdade (oferta boa), o "voltou" sai e ela volta a sair vazia dentro das 3 h
  v.semConferencia.delete(VELHO);
  s.avancar(MIN); await manual(s, r1);
  assert.equal(s.paraPedro().length, 2, 'o "voltou"');
  assert.match(s.paraPedro()[1], /^✅ \*A regra “Fica” voltou a enviar\*/);
  v.semConferencia.add(VELHO);
  s.estado.ofertas.push(oferta(2, 'amazon', { precoEm: VELHO }), oferta(3, 'amazon', { precoEm: VELHO }), oferta(4, 'amazon', { precoEm: VELHO }), oferta(5, 'amazon', { precoEm: VELHO }));
  s.avancar(MIN); await manual(s, r1); s.avancar(MIN); await manual(s, r1);
  assert.equal(s.paraPedro().length, 2, 'dentro das 3 h do último aviso o freio segura');
  assert.ok(s.linhasVigia().some((l) => l.message === 'Aviso do vigia sobre regra “Fica” vazia não enviado: freio de 3 h para essa causa.'));
  s.ir(inicio + 3 * HORA + 5 * MIN); await passada(s);
  assert.equal(s.paraPedro().length, 3, 'passadas 3 h do último aviso, a causa ainda aberta sai');
  assert.match(s.paraPedro()[2], /^⚠️ \*A regra “Fica” saiu vazia/);
});

// ============================================================================================ S1: nome de regra

test('S1: nome de regra com número disfarçado ou link não chega ao WhatsApp, ao Histórico, ao estado gravado nem ao /api/state', async (t) => {
  const nomes = [
    ['11_98765_4321', 'sublinhado'],
    ['11 9 8765.4321', 'espaços e ponto'],
    ['１１９８７６５４３２１', 'dígitos de largura inteira'],
    ['zap 11\u200b98765\u200b4321', 'espaço de largura zero no meio'],
    ['11.98765.4321', 'pontos'],
    ['liga 9-8765-4321 já', 'hífens, sem o 11'],
    ['https://chat.whatsapp.com/AbCdEf', 'convite de grupo'],
    ['wa.me/5511987654321', 'wa.me com número'],
    ['bit.ly/promo', 'encurtador'],
    ['ｗｗｗ．ｌｏｊａ．ｃｏｍ', 'domínio de largura inteira'],
    ['ana＠exemplo.com', 'e-mail com arroba de largura inteira'],
    ['http://x', 'só o esquema'],
    ['1 2 3 4 5 6 7 8', 'oito dígitos soltos'],
    ['1_2_3_4_5_6_7_8', 'oito dígitos com sublinhado'],
    ['11/98765/4321', 'barras'],
    ['11·98765·4321', 'ponto médio'],
    ['zap (11) 9.8765-4321', 'parênteses, pontos e hífen'],
  ];
  for (const [nome, rotulo] of nomes) await t.test(rotulo, async (tt) => {
    const { s } = mundoAmazonVazia(tt);
    const id = regraCatalogo(s.db, { nome, lojas: ['amazon'], per: 2 });
    await manual(s, id); s.avancar(MIN); await manual(s, id);
    const msg = s.paraPedro().join('\n');
    assert.match(msg, /saiu vazia 2 vezes seguidas/, `o aviso saiu para ${rotulo}`);
    // o número disfarçado (separadores que o \d{8,} não vê): do nome entre aspas sobram menos de 8 dígitos no total
    const nomeNaMsg = /“([^”]*)”/.exec(msg)?.[1] ?? '';
    assert.ok((nomeNaMsg.match(/\p{Nd}/gu) ?? []).length < 8, `dígitos demais no nome (${rotulo}): ${nomeNaMsg}`);
    const historico = s.db.prepare('SELECT rule_name, message FROM log').all().map((l) => `${l.rule_name}|${l.message}`).join('\n');
    const p = await subirPainel(tt, s);
    const semNumeros = (txt) => JSON.stringify(JSON.parse(txt), (k, v) => (typeof v === 'number' ? 0 : v)); // tira os instantes (13 dígitos)
    const state = semNumeros(JSON.stringify((await req(p.port, '/api/state')).json.vigia));
    const gravado = semNumeros(getSetting(s.db, CHAVE_ESTADO));
    const sem = (txt) => txt.replace(/\d\d:\d\d/g, '');
    for (const [onde, txt] of [['WhatsApp', msg], ['Histórico do vigia', historico.split('\n').filter((l) => /^(Vigia|Avisos)\|/.test(l)).join('\n')], ['/api/state', state], ['estado em settings', gravado]]) {
      assert.doesNotMatch(sem(txt), /\d{8,}/, `${onde}: sequência de 8+ dígitos (${rotulo})`);
      assert.doesNotMatch(sem(txt), /:\/\//, `${onde}: esquema de link (${rotulo})`);
      assert.doesNotMatch(sem(txt), /[\p{L}\p{Nd}]\.[\p{L}]/u, `${onde}: domínio colável (${rotulo})`);
      assert.doesNotMatch(sem(txt), /[\w.+-]+@[\w-]+\.[\w.]+/, `${onde}: e-mail (${rotulo})`);
      assert.doesNotMatch(sem(txt), /９|１|＠|．/, `${onde}: caractere de largura inteira (${rotulo})`);
    }
  });
});

test('S1: nome comum continua legível (acento, número curto, ponto de abreviação) e só vira "sem nome" quando nada sobra', async (t) => {
  const { s } = mundoAmazonVazia(t);
  const a = regraCatalogo(s.db, { nome: 'Achados da Casa 2026', lojas: ['amazon'], per: 2 });
  await manual(s, a); s.avancar(MIN); await manual(s, a);
  assert.match(s.paraPedro().join('\n'), /A regra “Achados da Casa 2026” saiu vazia 2 vezes seguidas/);
});

// ============================================================================================ CA3.7 / CA3.11 após as mudanças

test('CA3.7: depois de todos os cenários de suspensão e freio, nenhuma linha do vigia no Histórico é "erro"', async (t) => {
  const { s, d } = await noiteDeSuspensao(t);
  d.cair();
  s.suspenderAte(dia(12, 8, 0, 2));
  await s.scheduler.tick();
  s.ir(dia(12, 9, 0, 3)); await s.scheduler.tick();
  const niveis = s.linhasVigia().map((l) => l.level);
  assert.ok(niveis.length > 0);
  assert.ok(niveis.every((n) => n === 'aviso' || n === 'info'));
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM log WHERE level = 'erro'").get().n, 0);
});
