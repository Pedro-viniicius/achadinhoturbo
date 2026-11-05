// QA da entrega 1 (plano disparos-comunicacao-conta): costuras entre módulos feitos por devs diferentes, telas ↔
// contratos reais das rotas e casos de borda (virada do dia, fuso, limites, reinício, apagar o que um agendado usa).
// As telas de public/disparos.js rodam de verdade num contexto vm, com um DOM falso mínimo e um fetch que fala com o
// servidor real em porta aleatória. WhatsApp simulado, links meli.la/fake-… e `ml` falso: nenhum teste acessa a rede.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb, setSetting } from '../src/db.js';
import { buildApp } from '../src/server.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createLinkService } from '../src/links.js';
import { createScheduler } from '../src/scheduler.js';
import { proximaOcorrencia } from '../src/envios.js';
import { dayOf } from '../src/analytics.js';
import { viradaMin } from '../src/avisos.js';
import * as mlReal from '../src/ml.js';
import zlib from 'node:zlib';

let acessosRede = 0;
globalThis.fetch = async () => { acessosRede++; throw new Error('rede proibida no teste'); };

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-qa-')); pastas.push(p); return p; };

const SENHA = 'senha-de-teste-123';
const MIN = 60000; const HORA = 3600000; const DIA = 86400000;
const IMG = 'https://http2.mlstatic.com/D_NQ_NP_123-O.jpg';
const URL_ML = 'https://produto.mercadolivre.com.br/MLB-1234567890-fone-bom-_JM';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const TODOS = [0, 1, 2, 3, 4, 5, 6];
const NUMERO = '(11) 98765-4321'; const JID_DESTINO = '5511987654321@s.whatsapp.net';
const seg = (h, m = 0) => new Date(2026, 10, 2, h, m).getTime(); // segunda-feira, 02/11/2026, hora local

const pad = (n) => String(n).padStart(2, '0');
const hhmmDe = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const amanha = (h, m = 0) => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, h, m).getTime(); };
const dataDe = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const statusDe = (db, id) => db.prepare('SELECT status FROM envios WHERE id = ?').get(id)?.status;
const contar = (db, sql, ...a) => db.prepare(sql).get(...a).n;
const proximoDe = (db, id) => db.prepare('SELECT next_run_at FROM envios WHERE id = ?').get(id).next_run_at;
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));
async function esperar(cond, ms = 3000, oQue = 'condição') {
  const t0 = Date.now();
  while (!(await cond())) { if (Date.now() - t0 > ms) throw new Error(`esperei ${ms} ms por: ${oQue}`); await dorme(5); }
}

/** Stub do módulo ml: oferta pronta, sem rede. */
function mlFalso() {
  return {
    chamadas: [],
    async resolveOffer(c) {
      this.chamadas.push(c.url);
      return { key: c.key, url: c.url, title: 'Fone Bom', price: 89.9, oldPrice: 149.9, discountPct: 40, sold: 1200, freeShipping: true, image: IMG };
    },
  };
}

/** Banco, WhatsApp simulado, links falsos e agendador; dois grupos (com convite) e duas etiquetas na primeira vez. */
function montar({ dir = tmp(), ml = mlFalso(), fast = true, modo = 'fake' } = {}) {
  const db = openDb(dir);
  // como src/server.js: a leitura conta pelo dia de negócio (virada do dia de Relatórios e avisos)
  const wa = createWhatsApp({ db, dir, dryRun: true, diaDe: (ts) => dayOf(ts, viradaMin(db)) }); wa.connect();
  const links = createLinkService({ getMode: () => modo });
  const scheduler = createScheduler({ db, wa, links, fast, dir, ml });
  if (!db.prepare('SELECT 1 FROM groups LIMIT 1').get()) {
    for (const [jid, nome, convite] of [['111@g.us', 'Achadinhos', 'AAAAAAAAAAAA'], ['222@g.us', 'Tech', 'BBBBBBBBBBBB']]) {
      db.prepare('INSERT INTO groups (jid, name, size, updated_at, invite_code) VALUES (?,?,?,?,?)').run(jid, nome, 10, Date.now(), convite);
    }
    for (const nome of ['etiquetaA', 'etiquetaB']) db.prepare('INSERT INTO tags (name, created_at) VALUES (?, 1)').run(nome);
  }
  return { dir, db, wa, links, ml, scheduler, envios: scheduler.envios };
}

/** Requisição crua; `raw` manda um Buffer com o Content-Type dos headers. */
function req(port, caminho, { method = 'GET', headers = {}, body, raw } = {}) {
  return new Promise((ok, err) => {
    const data = raw ?? (body != null ? Buffer.from(JSON.stringify(body)) : null);
    const h = { ...(body != null && raw == null ? { 'content-type': 'application/json' } : {}), ...(data ? { 'content-length': data.length } : {}), ...headers };
    const r = http.request({ host: '127.0.0.1', port, path: caminho, method, headers: h }, (res) => {
      const partes = []; res.on('data', (c) => partes.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(partes); const txt = buf.toString('utf8');
        let json = null; try { json = JSON.parse(txt); } catch { /* binário ou html */ }
        ok({ status: res.statusCode, headers: res.headers, json, txt, buf });
      });
    });
    r.on('error', err); if (data) r.write(data); r.end();
  });
}

/** Servidor com login, em porta aleatória, já com a sessão aberta. */
async function subir(opcoes) {
  const m = montar(opcoes);
  const app = buildApp({ db: m.db, wa: m.wa, links: m.links, scheduler: m.scheduler, publicHost: '', panelPassword: SENHA, dataDir: m.dir, ml: m.ml });
  const server = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  const { port } = server.address();
  const entrou = await req(port, '/api/login', { method: 'POST', body: { senha: SENHA } });
  const h = { cookie: String(entrou.headers['set-cookie']?.[0] || '').split(';')[0], origin: `http://127.0.0.1:${port}` };
  return {
    ...m, port,
    req: (c, o = {}) => req(port, c, { ...o, headers: { ...h, ...(o.headers || {}) } }),
    get: (c) => req(port, c, { headers: h }),
    post: (c, body = {}) => req(port, c, { method: 'POST', body, headers: h }),
    put: (c, body = {}) => req(port, c, { method: 'PUT', body, headers: h }),
    upload: (raw, tipo) => req(port, '/api/uploads', { method: 'POST', raw, headers: { ...h, 'content-type': tipo } }),
    fechar: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => { m.db.close(); r(); }); }),
  };
}

// ---------- telas de public/disparos.js num contexto vm ----------
const fonte = (arq) => fs.readFileSync(path.join(RAIZ, 'public', arq), 'utf8');
/** Uma linha `const nome = …` de public/app.js (esc e zap), para a tela usar os utilitários de verdade. */
const linhaDeApp = (nome) => {
  const l = fonte('app.js').split('\n').find((x) => x.startsWith(`const ${nome} = `));
  assert.ok(l, `public/app.js define ${nome} numa linha só`);
  return l;
};

/** Elemento falso: guarda valor, HTML, atributos e tratadores (onclick, oninput…) que a tela pendura nele. */
function elementoFalso(sel) {
  const attrs = new Map(); const classes = new Set();
  return {
    sel, value: '', checked: false, disabled: false, hidden: false, open: false, innerHTML: '', textContent: '', className: '',
    dataset: {}, style: {}, files: [], isConnected: true, parentNode: null, src: '', placeholder: '', tabIndex: 0,
    classList: {
      add: (c) => { classes.add(c); }, remove: (c) => { classes.delete(c); }, contains: (c) => classes.has(c),
      toggle: (c, on) => { const v = on ?? !classes.has(c); if (v) classes.add(c); else classes.delete(c); return v; },
    },
    setAttribute: (k, v) => { attrs.set(k, String(v)); }, getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null), removeAttribute: (k) => { attrs.delete(k); },
    focus() {}, blur() {}, click() {}, closest: () => null, contains: () => false, insertBefore() {}, remove() {}, scrollIntoView() {},
    showModal() {}, close() {}, addEventListener() {},
  };
}

/**
 * Abre public/disparos.js com o servidor `s`. `marcados` = grupos marcados no seletor (seletorGrupos é de app.js).
 * → { $, erros (mostrarErros), avisos (toasts), pedidos (o que a tela mandou ao servidor), rodar(código) }
 */
async function abrirTela(s, { marcados = ['111@g.us'], estado = {} } = {}) {
  const els = new Map(); const erros = []; const avisos = []; const pedidos = [];
  const $ = (sel) => { if (!els.has(sel)) els.set(sel, elementoFalso(sel)); return els.get(sel); };
  const fetchDaTela = async (url, opts = {}) => {
    const method = opts.method || 'GET'; const corpo = typeof opts.body === 'string' ? opts.body : null;
    pedidos.push({ url, method, corpo: corpo ? JSON.parse(corpo) : null });
    const r = await s.req(url, { method, raw: corpo == null ? undefined : Buffer.from(corpo), headers: opts.headers || {} });
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => { if (r.json == null) throw new Error('sem JSON'); return r.json; } };
  };
  const S = {
    st: { simulacao: true, whatsapp: { status: 'open' }, extensao: { online: true }, ajustes: { link_mode: 'extension' }, ...estado },
    templates: (await s.get('/api/templates')).json, tags: (await s.get('/api/tags')).json, groups: [], blocks: [],
  };
  const ctx = vm.createContext({
    $, $$: () => [], S, REQ: '', q: () => '', opcoes: () => '',
    aviso: (msg, erro = false) => { avisos.push({ msg, erro }); },
    mostrarErros: (_onde, lista) => { for (const e of lista) erros.push(e.msg); return lista.length > 0; },
    seletorGrupos: () => ({ html: '', ligar: () => () => {}, marcados: () => [...marcados] }),
    fetch: fetchDaTela, location: { hash: '#qa', replace() {} }, document: { activeElement: null, body: {} }, confirm: () => true,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; }, clearTimeout, console,
  });
  vm.runInContext(`${linhaDeApp('esc')}\n${linhaDeApp('zap')}`, ctx);
  vm.runInContext(fonte('disparos.js'), ctx, { filename: 'public/disparos.js' });
  return { $, erros, avisos, pedidos, rodar: (codigo) => vm.runInContext(codigo, ctx) };
}
/** Espera a tela pintar um elemento pela primeira vez (dispRepintar grava dataset.ass) e devolve o HTML. */
async function pintado(t, sel) {
  await esperar(() => t.$(sel).dataset.ass != null, 3000, `a tela pintar ${sel}`);
  return t.$(sel).innerHTML;
}
/** Um botão falso para os tratadores por delegação (segmentados, dias da semana). */
const alvo = (dados) => ({ target: { closest: () => ({ dataset: dados, disabled: false, focus() {}, getAttribute: () => 'false', setAttribute() {} }) } });
/** Espera os envios "agora" terminarem. */
const semFila = (db) => esperar(() => !contar(db, "SELECT COUNT(*) AS n FROM envios WHERE status IN ('pendente','enviando') AND quando = 'agora'"), 3000, 'os envios "agora" terminarem');

// ================= Q1: telas F1/F2 ↔ POST /api/envios =================
test('Q1 tela Disparo manual: Identificar e Disparar mandam a oferta com o corpo que a tela monta (CA1 pela tela)', async () => {
  const s = await subir();
  try {
    s.links.poll(0); // extensão conectada (o modo de link padrão é a extensão)
    const t = await abrirTela(s, { marcados: ['111@g.us'] });
    t.rodar('paginaDisparoManual()');
    t.$('#dm-tpl').value = '1'; t.$('#dm-tag').value = '2';
    t.$('#dm-url').value = URL_ML;
    await t.$('#dm-identificar').onclick();
    assert.match(t.$('#dm-prod').innerHTML, /Fone Bom/, 'a tela identificou o produto');
    assert.equal(t.$('#dm-disparar').disabled, false, `botão Disparar travado: ${t.$('#dm-motivo').textContent}`);
    await t.$('#dm-disparar').onclick();
    const corpo = t.pedidos.find((p) => p.url === '/api/envios' && p.method === 'POST')?.corpo;
    assert.ok(corpo, 'a tela chamou POST /api/envios');
    assert.deepEqual(t.erros, [], `a tela mostrou erro para o corpo ${JSON.stringify(corpo)}`);
    await semFila(s.db);
    assert.equal(s.wa.simulated.length, 1, 'a oferta saiu');
    assert.deepEqual([s.wa.simulated[0].tipo, s.wa.simulated[0].jid], ['image', '111@g.us']);
    assert.match(s.wa.simulated[0].text, /https:\/\/meli\.la\/fake-etiquetaB-\d+/, 'com a etiqueta escolhida na tela');
  } finally { await s.fechar(); }
});

test('Q1 tela Disparar mensagem: texto agora, enquete agora e repetição saem com o corpo que a tela monta (CA4 pela tela)', async () => {
  const s = await subir();
  try {
    const t = await abrirTela(s, { marcados: ['222@g.us'] });
    t.rodar('paginaDispararMensagem()');
    // mensagem agora
    t.$('#mg-texto').value = 'Bom dia, *grupo*!';
    await t.$('#mg-enviar').onclick();
    assert.deepEqual(t.erros, [], `mensagem: a tela mostrou erro para ${JSON.stringify(t.pedidos.at(-1)?.corpo)}`);
    await semFila(s.db);
    assert.deepEqual(s.wa.simulated.map((x) => [x.tipo, x.jid, x.text]), [['text', '222@g.us', 'Bom dia, *grupo*!']]);
    // enquete agora
    t.$('#mg-tipo').onclick(alvo({ v: 'enquete' }));
    t.$('#mg-pergunta').value = 'Qual o melhor achado?';
    t.$('#mg-opcoes').oninput({ target: { dataset: { i: '0' }, value: 'Fone' } });
    t.$('#mg-opcoes').oninput({ target: { dataset: { i: '1' }, value: 'Mouse' } });
    await t.$('#mg-enviar').onclick();
    assert.deepEqual(t.erros, [], `enquete: a tela mostrou erro para ${JSON.stringify(t.pedidos.at(-1)?.corpo)}`);
    await semFila(s.db);
    assert.deepEqual(s.wa.simulated.at(-1).poll, { name: 'Qual o melhor achado?', values: ['Fone', 'Mouse'], selectableCount: 1 });
    // mensagem repetida às segundas, 09:00
    t.$('#mg-tipo').onclick(alvo({ v: 'mensagem' }));
    t.$('#mg-texto').value = 'Bom dia de segunda';
    t.$('#mg-quando').onclick(alvo({ v: 'repetir' }));
    t.$('#mg-dias').onclick(alvo({ d: '1' }));
    t.$('#mg-hor-novo').value = '09:00'; t.$('#mg-hor-add').onclick();
    await t.$('#mg-enviar').onclick();
    assert.deepEqual(t.erros, [], `repetição: a tela mostrou erro para ${JSON.stringify(t.pedidos.at(-1)?.corpo)}`);
    const r = s.db.prepare("SELECT payload, repetir, next_run_at FROM envios WHERE quando = 'repetir'").get();
    assert.equal(JSON.parse(r.payload).texto, 'Bom dia de segunda');
    assert.deepEqual(JSON.parse(r.repetir), { dias: [1], horarios: ['09:00'] });
  } finally { await s.fechar(); }
});

// ================= Q2/Q3/Q4: telas ↔ GET /api/envios =================
test('Q2 histórico das duas telas mostra quando e o grupo de cada linha que a API devolve (e a hora do pendente)', async () => {
  const s = await subir();
  try {
    s.links.poll(0);
    assert.equal((await s.post('/api/envios', { tipo: 'oferta', url: URL_ML, tag_id: 1, template_id: 1, group_jids: ['111@g.us'] })).status, 200);
    assert.equal((await s.post('/api/envios', { tipo: 'mensagem', texto: 'Aviso geral', group_jids: ['222@g.us'] })).status, 200);
    const TB = amanha(10);
    assert.equal((await s.post('/api/envios', { tipo: 'mensagem', texto: 'Amanhã cedo', group_jids: ['111@g.us'], quando: 'agendado', agendar_data: dataDe(TB), agendar_hhmm: '10:00' })).status, 200);
    await semFila(s.db);
    const api = (await s.get('/api/envios?tipo=mensagem')).json;
    assert.deepEqual(api.linhas.map((l) => [l.titulo, l.grupo, l.status]), [['Amanhã cedo', 'Achadinhos', 'pendente'], ['Aviso geral', 'Tech', 'enviado']], 'contrato da API');

    const t1 = await abrirTela(s);
    t1.rodar('paginaDisparoManual()');
    const h1 = await pintado(t1, '#dm-hist');
    assert.match(h1, /Fone Bom/);
    assert.match(h1, /Achadinhos/, 'Disparo manual: a coluna Grupo mostra o grupo da linha');
    assert.match(h1, /Hoje \d\d:\d\d/, 'Disparo manual: a coluna Quando mostra a hora do envio');

    const t2 = await abrirTela(s);
    t2.rodar('paginaDispararMensagem()');
    const h2 = await pintado(t2, '#mg-hist');
    assert.match(h2, /Tech/, 'Disparar mensagem: a coluna Grupo mostra o grupo da linha');
    assert.match(h2, /Hoje \d\d:\d\d/, 'Disparar mensagem: a coluna Quando mostra a hora do envio');
    assert.match(h2, /Pendente · 10:00/, 'o pendente mostra a hora em que vai sair (spec: "Pendente · 18:00")');
  } finally { await s.fechar(); }
});

test('Q3 "Agendadas e repetidas" mostra o texto da mensagem e a pergunta da enquete de cada item', async () => {
  const s = await subir();
  try {
    const TA = amanha(10);
    assert.equal((await s.post('/api/envios', { tipo: 'mensagem', texto: 'Promoção de amanhã', group_jids: ['111@g.us'], quando: 'agendado', agendar_data: dataDe(TA), agendar_hhmm: '10:00' })).status, 200);
    assert.equal((await s.post('/api/envios', { tipo: 'enquete', pergunta: 'Achado do dia?', opcoes: ['Sim', 'Não'], group_jids: ['111@g.us'], quando: 'repetir', repetir: { dias: TODOS, horarios: ['09:00'] } })).status, 200);
    const t = await abrirTela(s);
    t.rodar('paginaDispararMensagem()');
    const html = await pintado(t, '#mg-agendadas');
    assert.match(html, /Promoção de amanhã/, 'o item agendado diz qual mensagem é');
    assert.match(html, /Enquete: Achado do dia\?/, 'o item repetido diz qual enquete é');
  } finally { await s.fechar(); }
});

test('Q4 "Pausar" só aparece para envio repetido (o servidor recusa pausar o agendado único)', async () => {
  const s = await subir();
  try {
    const TA = amanha(10);
    const ag = (await s.post('/api/envios', { tipo: 'mensagem', texto: 'Único', group_jids: ['111@g.us'], quando: 'agendado', agendar_data: dataDe(TA), agendar_hhmm: '10:00' })).json.id;
    const rep = (await s.post('/api/envios', { tipo: 'mensagem', texto: 'Sempre', group_jids: ['111@g.us'], quando: 'repetir', repetir: { dias: TODOS, horarios: ['09:00'] } })).json.id;
    assert.equal((await s.post(`/api/envios/${ag}/pausar`)).status, 400, 'contrato: agendado único não pausa');
    const t = await abrirTela(s);
    t.rodar('paginaDispararMensagem()');
    const html = await pintado(t, '#mg-agendadas');
    assert.match(html, new RegExp(`data-act="pausar" data-id="${rep}"`), 'o repetido tem Pausar');
    assert.match(html, new RegExp(`data-act="cancelar" data-id="${ag}"`), 'o agendado único tem Cancelar');
    assert.doesNotMatch(html, new RegExp(`data-act="pausar" data-id="${ag}"`), 'o agendado único não pode ter um Pausar que sempre dá erro');
  } finally { await s.fechar(); }
});

test('Q5 cartão do produto mostra a foto do mlstatic que /api/disparo/identificar devolve (a CSP do painel permite)', async () => {
  const s = await subir();
  try {
    const csp = (await s.get('/')).headers['content-security-policy'];
    // decisão do lead (rodada 1): a CSP pode liberar o host exato ou https://*.mlstatic.com, alinhada a IMAGEM_PERMITIDA
    assert.match(csp, /img-src 'self' data: https:\/\/(http2|\*)\.mlstatic\.com/, 'a CSP libera as fotos do mlstatic');
    const t = await abrirTela(s);
    t.rodar('paginaDisparoManual()');
    t.$('#dm-tpl').value = '1'; t.$('#dm-url').value = URL_ML;
    await t.$('#dm-identificar').onclick();
    assert.match(t.$('#dm-prod').innerHTML, /alt="Fone Bom"/);
    assert.match(t.$('#dm-prod').innerHTML, /<img src="https:\/\/http2\.mlstatic\.com\/D_NQ_NP_123-O\.jpg"/, 'spec: imagem 72×72 do produto, não o desenho de sacola');
  } finally { await s.fechar(); }
});

// ================= Q6, Q7, Q8: casos de borda que mudam o que sai =================
test('Q6 etiqueta apagada e recriada: o disparo agendado não sai com a etiqueta nova que herdou o id', async (t) => {
  const s = await subir();
  try {
    t.mock.timers.enable({ apis: ['Date'], now: seg(10, 0) });
    const { id } = await s.envios.criar({ tipo: 'oferta', url: URL_ML, tag_id: 2, template_id: 1, group_jids: ['111@g.us'], quando: 'agendado', agendar_hhmm: '10:30' });
    t.mock.timers.reset();
    assert.equal((await s.req('/api/tags/2', { method: 'DELETE' })).status, 200, 'nada impede apagar a etiqueta que o agendado usa');
    assert.equal((await s.post('/api/tags', { name: 'etiquetaC' })).status, 200);
    assert.equal(s.db.prepare("SELECT id FROM tags WHERE name = 'etiquetaC'").get().id, 2, 'o SQLite reaproveitou o id 2');
    await s.envios.processarPendentes(seg(10, 30) + 1000);
    assert.equal(statusDe(s.db, id) === 'concluido' || statusDe(s.db, id) === 'erro', true);
    for (const m of s.wa.simulated) assert.doesNotMatch(m.text, /etiquetaC/, 'a comissão iria para uma etiqueta que o dono não escolheu');
  } finally { await s.fechar(); }
});

test('Q7 repetido pausado e retomado enquanto outro envio sai não é enviado antes do próximo horário', async () => {
  const m = montar();
  try {
    const agora = Date.now();
    const insere = (texto, quando, next, repetir = null) => Number(m.db.prepare(`INSERT INTO envios (tipo, payload, group_jids, quando, repetir, status, next_run_at, created_at)
      VALUES ('mensagem', ?, '["111@g.us"]', ?, ?, 'pendente', ?, ?)`).run(JSON.stringify({ texto, imagem: 'nenhuma' }), quando, repetir && JSON.stringify(repetir), next, agora).lastInsertRowid);
    const rep = { dias: TODOS, horarios: [hhmmDe(agora - MIN)] };
    insere('A', 'agendado', agora - 2 * MIN);
    const b = insere('B', 'repetir', agora - MIN, rep);
    const enviar = m.wa.sendText;
    m.wa.sendText = async (jid, texto, o) => {
      if (texto === 'A') { await m.envios.pausar(b); await m.envios.retomar(b); } // o dono pausa e retoma B enquanto A sai
      return enviar(jid, texto, o);
    };
    await m.envios.processarPendentes(agora);
    const proximo = proximaOcorrencia(rep, agora);
    assert.ok(proximo > Date.now(), 'retomar pôs B no próximo horário (amanhã)');
    assert.deepEqual(m.wa.simulated.map((x) => x.text), ['A'], 'B saiu agora, antes do horário para o qual foi retomado');
  } finally { m.db.close(); }
});

test('Q8 prévia do link que não carrega: a mensagem de erro não fala da "lista" das regras', async () => {
  const ml = { async resolveOffer() { throw new Error('não consegui ler o produto (API HTTP 403; página HTTP 403). Escreva na lista: URL | título | preço | preço antigo'); } };
  const m = montar({ ml });
  try {
    const p = m.envios.criar({ tipo: 'mensagem', texto: 'Olha', imagem: 'previa', previa_url: URL_ML, group_jids: ['111@g.us'] });
    await assert.rejects(p, (e) => {
      assert.doesNotMatch(e.message, /Escreva na lista/, e.message);
      assert.match(e.message, /^Não consegui ler/, 'mesmo padrão do disparo manual (lerOferta)');
      return true;
    });
    assert.equal(contar(m.db, 'SELECT COUNT(*) AS n FROM envios'), 0);
  } finally { m.db.close(); }
});

// ================= bordas que já funcionam (ficam como regressão) =================
test('upload de exatamente 5 MB é aceito e lido até o fim; 5 MB + 1 byte dá 413', async () => {
  const s = await subir();
  try {
    // R16: o upload regrava a foto e o que vem depois do IEND sai; o enchimento vai num bloco antes do IDAT,
    // então a foto só é lida (200) se os 5 MB chegarem inteiros
    const exato = Buffer.concat([PNG.subarray(0, 33), blocoPng('prVt', '\0'.repeat(5 * 1024 * 1024 - PNG.length - 12)), PNG.subarray(33)]);
    assert.equal(exato.length, 5 * 1024 * 1024);
    const r = await s.upload(exato, 'image/png');
    assert.equal(r.status, 200, r.txt);
    const g = await s.get(`/api/uploads/${r.json.id}`);
    assert.ok(g.status === 200 && g.buf.length < 1000 && !g.buf.includes('prVt'), 'servida a foto, sem o enchimento');
    const maior = Buffer.alloc(5 * 1024 * 1024 + 1); PNG.copy(maior);
    assert.equal((await s.upload(maior, 'image/png')).status, 413);
  } finally { await s.fechar(); }
});

test('enquete com 12 opções sai com as 12; repetição com 6 horários é aceita e começa no próximo deles', async () => {
  const s = await subir();
  try {
    const opcoes = Array.from({ length: 12 }, (_, i) => `Opção ${i + 1}`);
    const e = await s.post('/api/envios', { tipo: 'enquete', pergunta: 'Doze?', opcoes, group_jids: ['111@g.us'] });
    assert.equal(e.status, 200, e.txt);
    await semFila(s.db);
    assert.deepEqual(s.wa.simulated.at(-1).poll.values, opcoes);
    const rep = { dias: TODOS, horarios: ['08:00', '10:00', '12:00', '14:00', '16:00', '23:59'] };
    const antes = Date.now();
    const r = await s.post('/api/envios', { tipo: 'mensagem', texto: 'Seis', group_jids: ['111@g.us'], quando: 'repetir', repetir: rep });
    assert.equal(r.status, 200, r.txt);
    assert.equal(r.json.next_run_at, proximaOcorrencia(rep, antes));
    assert.deepEqual((await s.get('/api/envios?tipo=mensagem')).json.agendadas[0].repetir.horarios, rep.horarios);
  } finally { await s.fechar(); }
});

test('limite padrão nas bordas (2 e 1024 sim; 1, 0, 1025 não) e respeitado no link novo, no /g/<slug> e no aviso de lotação', async () => {
  const s = await subir();
  try {
    for (const [v, st] of [[2, 200], [1024, 200], [1025, 400], [1, 400], [0, 400], ['abc', 400]]) {
      assert.equal((await s.put('/api/avisos/config', { limite_padrao: v })).status, st, `limite_padrao ${v}`);
    }
    assert.equal((await s.post('/api/links', { name: 'Grande', group_jids: ['222@g.us'] })).status, 200);
    assert.equal((await s.put('/api/avisos/config', { limite_padrao: 100 })).json.limite_padrao, 100);
    assert.equal((await s.post('/api/links', { name: 'Fila', group_jids: ['111@g.us'] })).status, 200);
    const links = (await s.get('/api/links')).json;
    assert.deepEqual(links.map((l) => [l.slug, l.limit_members, l.reopen_below]), [['grande', 1024, 921], ['fila', 100, 90]]);

    const tamanho = (n) => s.db.prepare("UPDATE groups SET size = ? WHERE jid = '111@g.us'").run(n);
    tamanho(99);
    const aberto = await req(s.port, '/g/fila');
    assert.deepEqual([aberto.status, aberto.headers.location], [302, 'https://chat.whatsapp.com/AAAAAAAAAAAA']);
    tamanho(100);
    assert.equal((await req(s.port, '/g/fila')).status, 503, 'com 100 de 100 o grupo está lotado');

    s.db.prepare("INSERT INTO aviso_destinos (nome, jid, resumo_blocos, avisos, ativo, created_at) VALUES ('Pedro', ?, NULL, '[\"lotacao\"]', 1, 1)").run(JID_DESTINO);
    tamanho(94); await s.scheduler.avisos.tick();
    assert.equal(s.wa.simulated.filter((x) => x.jid === JID_DESTINO).length, 0, '94% do limite padrão ainda não');
    tamanho(95); await s.scheduler.avisos.tick();
    const [aviso] = s.wa.simulated.filter((x) => x.jid === JID_DESTINO);
    assert.match(aviso.text, /Achadinhos: 95 de 100 membros \(link “Fila”\)/);
  } finally { await s.fechar(); }
});

test('template apagado depois de agendar: erro em cada grupo sem enviar, painel com o motivo e aviso de erro agregado ao destino', async (t) => {
  const s = await subir();
  try {
    s.db.prepare("INSERT INTO aviso_destinos (nome, jid, resumo_blocos, avisos, ativo, created_at) VALUES ('Pedro', ?, NULL, '[\"erro\"]', 1, 1)").run(JID_DESTINO);
    await s.scheduler.avisos.tick(); // primeira vez: só marca o cursor do log
    const tpl = (await s.post('/api/templates', { name: 'Curto', body: '{TITULO_PRODUTO} {LINK}' })).json.id;
    t.mock.timers.enable({ apis: ['Date'], now: seg(10, 0) });
    const { id } = await s.envios.criar({ tipo: 'oferta', url: URL_ML, template_id: tpl, group_jids: ['111@g.us', '222@g.us'], quando: 'agendado', agendar_hhmm: '10:30' });
    t.mock.timers.reset();
    assert.equal((await s.req(`/api/templates/${tpl}`, { method: 'DELETE' })).status, 200);
    await s.envios.processarPendentes(seg(10, 30) + 1000);
    assert.equal(s.wa.simulated.length, 0, 'nada sai sem o template');
    assert.equal(statusDe(s.db, id), 'erro');
    const p = (await s.get('/api/envios?tipo=oferta')).json;
    assert.deepEqual(p.linhas.map((l) => [l.status, l.erro]).sort(), [['erro', 'o template foi apagado'], ['erro', 'o template foi apagado']]);
    assert.equal(p.contadores.com_erro, 2);
    await s.scheduler.avisos.tick();
    const avisos = s.wa.simulated.filter((x) => x.jid === JID_DESTINO);
    assert.equal(avisos.length, 1);
    assert.match(avisos[0].text, /^⚠️ \*2 disparos falharam desde /);
    assert.ok(avisos[0].text.includes('• Não enviado: o template foi apagado (2×)'), avisos[0].text);
  } finally { await s.fechar(); }
});

test('grupo que sumiu da tabela depois de agendar: a lista e o histórico mostram "(grupo removido)" sem quebrar', async () => {
  const m = montar();
  try {
    const T = amanha(10);
    const { id } = await m.envios.criar({ tipo: 'mensagem', texto: 'Para dois', group_jids: ['111@g.us', '222@g.us'], quando: 'agendado', agendar_data: dataDe(T), agendar_hhmm: '10:00' });
    m.db.prepare("DELETE FROM groups WHERE jid = '222@g.us'").run(); // saiu do grupo / sync do WhatsApp
    let p = await m.envios.painel('mensagem');
    assert.deepEqual(p.agendadas[0].grupos_nomes, ['Achadinhos', '(grupo removido)']);
    await m.envios.processarPendentes(T + 1000);
    assert.notEqual(statusDe(m.db, id), 'enviando');
    p = await m.envios.painel('mensagem');
    assert.deepEqual(p.linhas.map((l) => l.grupo).sort(), ['(grupo removido)', 'Achadinhos']);
    assert.equal(contar(m.db, "SELECT COUNT(*) AS n FROM log WHERE message LIKE '%@%' OR group_name LIKE '%@%'"), 0, 'log sem JID');
  } finally { m.db.close(); }
});

test('reinício no meio de um "agora": o agendador novo (start → recuperar → tick) manda só o grupo que faltava', async () => {
  const m = montar(); const T = Date.now() - MIN;
  const id = Number(m.db.prepare("INSERT INTO envios (tipo, payload, group_jids, quando, status, next_run_at, created_at) VALUES ('mensagem', ?, ?, 'agora', 'enviando', ?, ?)")
    .run(JSON.stringify({ texto: 'Reinício', imagem: 'nenhuma' }), JSON.stringify(['111@g.us', '222@g.us']), T, T).lastInsertRowid);
  m.db.prepare('INSERT INTO envio_resultados (envio_id, ocorrencia, ts, jid, group_name, ok) VALUES (?,?,?,?,?,1)').run(id, T, T, '111@g.us', 'Achadinhos');
  m.db.close();
  const r = montar({ dir: m.dir });
  r.scheduler.start();
  try {
    await r.scheduler.tick();
    assert.deepEqual(r.wa.simulated.map((x) => [x.jid, x.text]), [['222@g.us', 'Reinício']]);
    assert.equal(statusDe(r.db, id), 'concluido');
    await r.scheduler.tick();
    assert.equal(r.wa.simulated.length, 1, 'não repete');
  } finally { r.scheduler.stop(); r.db.close(); }
});

test('repetido interrompido no meio: a retomada completa a ocorrência e depois segue para a próxima, sem pular nem repetir', async () => {
  const m = montar();
  const T = new Date(Date.now() - 10 * MIN).setSeconds(0, 0); const rep = { dias: TODOS, horarios: [hhmmDe(T)] };
  const id = Number(m.db.prepare("INSERT INTO envios (tipo, payload, group_jids, quando, repetir, status, next_run_at, created_at) VALUES ('mensagem', ?, ?, 'repetir', ?, 'enviando', ?, ?)")
    .run(JSON.stringify({ texto: 'Todo dia', imagem: 'nenhuma' }), JSON.stringify(['111@g.us', '222@g.us']), JSON.stringify(rep), T, T - DIA).lastInsertRowid);
  m.db.prepare('INSERT INTO envio_resultados (envio_id, ocorrencia, ts, jid, group_name, ok) VALUES (?,?,?,?,?,1)').run(id, T, T, '111@g.us', 'Achadinhos');
  m.db.close();
  const r = montar({ dir: m.dir });
  try {
    assert.equal(await r.envios.recuperar(), 1);
    assert.equal(await r.envios.processarPendentes(Date.now()), 1);
    assert.deepEqual(r.wa.simulated.map((x) => x.jid), ['222@g.us'], 'só o que faltava da ocorrência interrompida');
    const prox = proximoDe(r.db, id);
    assert.equal(prox, proximaOcorrencia(rep, T), 'a próxima é a de amanhã no mesmo horário');
    assert.equal(statusDe(r.db, id), 'pendente');
    assert.equal(await r.envios.processarPendentes(prox + 1000), 1);
    assert.deepEqual(r.wa.simulated.map((x) => x.jid), ['222@g.us', '111@g.us', '222@g.us'], 'a ocorrência seguinte vai para os dois');
  } finally { r.db.close(); }
});

test('pausar um repetido no meio da rodada: os grupos que faltam não recebem e retomar vai para o próximo horário', async () => {
  const m = montar();
  try {
    const { id } = await m.envios.criar({ tipo: 'mensagem', texto: 'R', group_jids: ['111@g.us', '222@g.us'], quando: 'repetir', repetir: { dias: TODOS, horarios: ['09:00'] } });
    const rodada = m.envios.runEnvio(id);
    assert.equal(statusDe(m.db, id), 'enviando');
    assert.deepEqual(await m.envios.pausar(id), { ok: true, status: 'pausado' });
    await rodada;
    assert.equal(m.wa.simulated.length, 0);
    assert.equal(statusDe(m.db, id), 'pausado', 'o fim da rodada não desfaz a pausa');
    const r = await m.envios.retomar(id);
    assert.ok(r.next_run_at > Date.now());
    assert.equal(await m.envios.processarPendentes(Date.now()), 0, 'retomar não manda na hora');
  } finally { m.db.close(); }
});

test('virada do dia: 23:59 e 00:00 nos agendados, nas repetições e no "só hoje" do disparo manual', async (t) => {
  const m = montar();
  try {
    t.mock.timers.enable({ apis: ['Date'], now: seg(23, 58) });
    const oferta = (extra) => m.envios.criar({ tipo: 'oferta', url: URL_ML, group_jids: ['111@g.us'], quando: 'agendado', ...extra });
    assert.equal((await oferta({ agendar_hhmm: '23:59' })).next_run_at, seg(23, 59), 'disparo manual às 23:59 de hoje');
    await assert.rejects(oferta({ agendar_hhmm: '00:00' }), /já passou/);
    await assert.rejects(oferta({ agendar_data: '2026-11-03', agendar_hhmm: '00:00' }), /só pode ser agendado para hoje/);
    const meia = await m.envios.criar({ tipo: 'mensagem', texto: 'Virou', group_jids: ['111@g.us'], quando: 'agendado', agendar_data: '2026-11-03', agendar_hhmm: '00:00' });
    assert.equal(meia.next_run_at, new Date(2026, 10, 3, 0, 0).getTime());
    const rep = { dias: [1], horarios: ['00:00', '23:59'] }; // só segunda
    assert.equal((await m.envios.criar({ tipo: 'mensagem', texto: 'Rep', group_jids: ['111@g.us'], quando: 'repetir', repetir: rep })).next_run_at, seg(23, 59));
    assert.equal(proximaOcorrencia(rep, seg(23, 59)), new Date(2026, 10, 9, 0, 0).getTime(), 'depois das 23:59 de segunda, a 00:00 da segunda seguinte');
    assert.equal(proximaOcorrencia({ dias: [2], horarios: ['00:00'] }, seg(23, 59)), new Date(2026, 10, 3, 0, 0).getTime(), 'terça 00:00 é um minuto depois');
  } finally { m.db.close(); }
});

test('atraso de exatamente 2 h ainda sai; 2 h e 1 ms vira erro sem enviar', async (t) => {
  const m = montar();
  try {
    t.mock.timers.enable({ apis: ['Date'], now: seg(10, 0) });
    const a = await m.envios.criar({ tipo: 'mensagem', texto: 'A', group_jids: ['111@g.us'], quando: 'agendado', agendar_hhmm: '10:30' });
    t.mock.timers.setTime(seg(12, 30));
    assert.equal(await m.envios.processarPendentes(seg(12, 30)), 1);
    assert.equal(statusDe(m.db, a.id), 'concluido');
    t.mock.timers.setTime(seg(10, 0));
    const b = await m.envios.criar({ tipo: 'mensagem', texto: 'B', group_jids: ['111@g.us'], quando: 'agendado', agendar_hhmm: '10:30' });
    t.mock.timers.setTime(seg(12, 30) + 1);
    assert.equal(await m.envios.processarPendentes(seg(12, 30) + 1), 0);
    assert.equal(statusDe(m.db, b.id), 'erro');
    assert.deepEqual(m.wa.simulated.map((x) => x.text), ['A']);
  } finally { m.db.close(); }
});

test('fuso horário (TZ): repetição atravessa o horário de verão sem pular nem duplicar; fuso de meia hora no agendado', async (t) => {
  const antes = process.env.TZ;
  t.after(() => { if (antes === undefined) delete process.env.TZ; else process.env.TZ = antes; });
  process.env.TZ = 'America/New_York';
  // começo do horário de verão (08/03/2026): 02:30 não existe; sai às 03:30 e no dia seguinte volta às 02:30
  const rep = { dias: TODOS, horarios: ['02:30'] };
  const p1 = proximaOcorrencia(rep, new Date(2026, 2, 8, 1, 0).getTime());
  assert.equal(new Date(p1).toISOString(), '2026-03-08T07:30:00.000Z');
  assert.equal(new Date(proximaOcorrencia(rep, p1)).toISOString(), '2026-03-09T06:30:00.000Z');
  // fim do horário de verão (01/11/2026): 01:30 acontece duas vezes; sai só uma
  const rep2 = { dias: TODOS, horarios: ['01:30'] };
  const q1 = proximaOcorrencia(rep2, new Date(2026, 10, 1, 0, 0).getTime());
  assert.equal(new Date(q1).toISOString(), '2026-11-01T05:30:00.000Z');
  assert.equal(new Date(proximaOcorrencia(rep2, q1)).toISOString(), '2026-11-02T06:30:00.000Z', 'não repete na segunda 01:30 do mesmo dia');

  process.env.TZ = 'Asia/Kolkata'; // UTC+05:30
  const m = montar();
  try {
    t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 2, 0, 0) });
    const r = await m.envios.criar({ tipo: 'mensagem', texto: 'Índia', group_jids: ['111@g.us'], quando: 'agendado', agendar_data: '2026-11-03', agendar_hhmm: '10:00' });
    assert.equal(r.next_run_at, Date.UTC(2026, 10, 3, 4, 30), '10:00 no fuso do servidor');
    assert.equal(proximaOcorrencia({ dias: TODOS, horarios: ['10:00'] }, Date.UTC(2026, 10, 2, 4, 0)), Date.UTC(2026, 10, 2, 4, 30));
  } finally { m.db.close(); }
});

test('resumo diário pelo tick do agendador, no horário salvo em /api/avisos/config e respeitando a virada', async (t) => {
  const s = await subir();
  try {
    assert.equal((await s.put('/api/avisos/config', { resumo_horario: '08:15', virada_dia: '03:00' })).status, 200);
    assert.equal((await s.post('/api/avisos/destinos', { nome: 'Pedro', numero: NUMERO, resumo_blocos: [], avisos: [] })).status, 200);
    const recebidas = () => s.wa.simulated.filter((x) => x.jid === JID_DESTINO);
    t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 3, 8, 14).getTime() });
    await s.scheduler.tick(); assert.equal(recebidas().length, 0, 'antes do horário');
    t.mock.timers.setTime(new Date(2026, 10, 3, 8, 15).getTime());
    await s.scheduler.tick(); assert.equal(recebidas().length, 1);
    assert.match(recebidas()[0].text, /^📊 \*Resumo de 03\/11\* \(até 08:15\)/);
    t.mock.timers.setTime(new Date(2026, 10, 4, 2, 59).getTime());
    await s.scheduler.tick(); assert.equal(recebidas().length, 1, '02:59 de 04/11 ainda é o dia de negócio 03/11');
    t.mock.timers.setTime(new Date(2026, 10, 4, 8, 15).getTime());
    await s.scheduler.tick(); assert.equal(recebidas().length, 2);
    assert.match(recebidas()[1].text, /^📊 \*Resumo de 04\/11\* \(até 08:15\)/);
    for (const l of s.db.prepare('SELECT * FROM log').all()) assert.doesNotMatch(Object.values(l).join(' '), /98765|5511987|whatsapp\.net/, 'número no log');
  } finally { await s.fechar(); }
});

test('server.js: a retenção ao iniciar chama envios.limpar (envio encerrado antigo, os resultados dele e foto sem uso somem)', async (t) => {
  const dir = tmp(); const db = openDb(dir); const velho = Date.now() - 200 * DIA;
  const id = Number(db.prepare("INSERT INTO envios (tipo, payload, group_jids, quando, status, last_run_at, created_at) VALUES ('mensagem', '{}', '[]', 'agora', 'concluido', ?, ?)").run(velho, velho).lastInsertRowid);
  db.prepare('INSERT INTO envio_resultados (envio_id, ocorrencia, ts, jid, group_name, ok) VALUES (?,?,?,?,?,1)').run(id, velho, velho, '111@g.us', 'X');
  db.prepare("INSERT INTO envios (tipo, payload, group_jids, quando, status, next_run_at, created_at) VALUES ('mensagem', '{}', '[]', 'agendado', 'pendente', ?, ?)").run(Date.now() + DIA, velho);
  db.close();
  fs.mkdirSync(path.join(dir, 'uploads'));
  const foto = path.join(dir, 'uploads', `${'a'.repeat(32)}.png`); fs.writeFileSync(foto, PNG); fs.utimesSync(foto, velho / 1000, velho / 1000);
  const env = { ...process.env, PORT: '0', DATA_DIR: dir, DRY_RUN: '1', FAST: '1', PANEL_PASSWORD: '', PUBLIC_HOST: '' };
  const filho = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(RAIZ, 'src', 'server.js')], { cwd: RAIZ, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const saiu = new Promise((r) => filho.once('exit', r));
  t.after(() => { if (filho.exitCode == null && filho.signalCode == null) filho.kill('SIGKILL'); });
  let saida = '';
  const linha = await new Promise((ok, falha) => {
    const timer = setTimeout(() => falha(new Error(`sem a linha da retenção em 10 s:\n${saida}`)), 10000);
    const ler = (c) => { saida += c; const m = /Retenção \(envios avulsos\): [^\n]*/.exec(saida); if (m) { clearTimeout(timer); ok(m[0]); } };
    filho.stdout.on('data', ler); filho.stderr.on('data', ler);
    saiu.then((c) => { clearTimeout(timer); falha(new Error(`o servidor saiu (${c}) antes:\n${saida}`)); });
  });
  assert.equal(linha, 'Retenção (envios avulsos): apagados 1 envios, 1 fotos.');
  filho.kill('SIGTERM'); await saiu;
  const db2 = openDb(dir);
  try {
    assert.equal(contar(db2, 'SELECT COUNT(*) AS n FROM envios'), 1, 'o pendente fica');
    assert.equal(contar(db2, 'SELECT COUNT(*) AS n FROM envio_resultados'), 0);
  } finally { db2.close(); }
  assert.equal(fs.existsSync(foto), false);
});

// ================= CA8: navegação, ajuda e README =================
test('CA8: menu em grupos na ordem da spec, rodapé, rotas e aliases, verbetes de ajuda usados existem, README atualizado', () => {
  const html = fonte('index.html');
  const nav = /<nav id="nav"[^>]*>([\s\S]*?)<\/nav>/.exec(html)[1];
  const grupos = []; let atual = { grupo: '', itens: [] }; grupos.push(atual);
  for (const m of nav.matchAll(/<p class="nav-grupo"[^>]*>([^<]+)<\/p>|<a href="(#[^"]+)">/g)) {
    if (m[1]) { atual = { grupo: m[1].trim(), itens: [] }; grupos.push(atual); } else atual.itens.push(m[2]);
  }
  assert.deepEqual(grupos, [
    { grupo: '', itens: ['#visao'] },
    { grupo: 'Principal', itens: ['#links', '#grupos', '#blocos'] },
    { grupo: 'Disparos', itens: ['#disparo-manual', '#disparo-automatico', '#disparar-mensagem', '#templates'] },
    { grupo: 'Comunicação', itens: ['#relatorios'] },
    { grupo: 'Conta', itens: ['#conexoes', '#numeros'] }, // Equipe entra por app.js só para o Dono
  ]);
  const rodape = /<nav aria-label="Apoio">([\s\S]*?)<\/nav>/.exec(html)[1];
  assert.deepEqual([...rodape.matchAll(/href="(#[^"]+)"/g)].map((m) => m[1]), ['#historico', '#ajustes', '#docs']);

  // app.js de verdade num contexto vm: ROTAS, aliases e a rota que cada endereço abre
  const els = new Map(); const el = (s) => { if (!els.has(s)) els.set(s, elementoFalso(s)); return els.get(s); };
  const ctx = vm.createContext({
    document: { querySelector: el, querySelectorAll: () => [], addEventListener() {}, activeElement: null, body: {} },
    location: { hash: '' }, history: { replaceState() {} }, addEventListener() {},
    fetch: () => Promise.reject(new Error('sem servidor no teste')), setInterval: () => 0, clearTimeout,
    setTimeout: (fn, ms) => { const tm = setTimeout(fn, ms); tm.unref(); return tm; }, console,
  });
  ctx.window = ctx;
  vm.runInContext(fonte('app.js'), ctx, { filename: 'public/app.js' });
  const rotas = JSON.parse(vm.runInContext('JSON.stringify(Object.keys(ROTAS))', ctx));
  for (const h of [...grupos.flatMap((g) => g.itens), '#historico', '#ajustes', '#docs', '#equipe']) assert.ok(rotas.includes(h.slice(1)), `rota ${h}`);
  assert.ok(!rotas.includes('ajuda'), '#ajuda é só um endereço antigo (alias) dos Docs');
  const abre = (hash) => { ctx.location.hash = hash; return vm.runInContext('rotaAtual()', ctx); };
  assert.deepEqual(['#regras', '#whatsapp', '#etiquetas', '#nao-existe', '#constructor', ''].map(abre), ['disparo-automatico', 'numeros', 'conexoes', 'visao', 'visao', 'visao']);
  // Docs: #ajuda é alias; o trecho depois da "/" não muda a rota (e o "?" continua cortando antes)
  assert.deepEqual(['#ajuda', '#docs', '#docs/conexoes', '#docs/conexoes/amazon', '#docs/xyz', '#ajuda/conexoes', '#docs?a=b', '#historico?tipo=automatico', '#visao/x', '#/docs'].map(abre),
    ['docs', 'docs', 'docs', 'docs', 'docs', 'docs', 'docs', 'historico', 'visao', 'visao']);
  // ir(): a rota docs recebe o pedido já validado (o mesmo do endereço reescrito: alias e malformado viram 'docs') e o endereço mantém capítulo e seção; as outras rotas seguem como antes
  const abertos = []; const enderecos = [];
  ctx.history.replaceState = (_a, _b, u) => { enderecos.push(u); ctx.location.hash = u; };
  ctx.URLSearchParams = URLSearchParams; // o vm não traz; só o Histórico a usa
  vm.runInContext('globalThis.paginaDocs = (pedido) => { globalThis.__docsPedidos.push(pedido); }; globalThis.__docsPedidos = []; paginaHistorico = () => {}; paginaVisao = () => {};', ctx);
  const vai = (hash) => { ctx.location.hash = hash; enderecos.length = 0; vm.runInContext('ir()', ctx); abertos.push(...JSON.parse(vm.runInContext('JSON.stringify(__docsPedidos.splice(0))', ctx))); return enderecos.at(-1) ?? hash; };
  assert.equal(vai('#docs/conexoes/amazon'), '#docs/conexoes/amazon', 'seção: o endereço fica');
  assert.equal(vai('#docs/conexoes'), '#docs/conexoes');
  assert.equal(vai('#docs/xyz'), '#docs/xyz', 'capítulo que não existe: o endereço fica (a página explica)');
  assert.equal(vai('#docs'), '#docs');
  assert.equal(vai('#ajuda'), '#docs', '#ajuda vira #docs');
  assert.equal(vai('#docs/a/b/c'), '#docs', 'mais de duas partes: volta ao início dos Docs');
  assert.equal(vai('#docs/Conexoes'), '#docs', 'só minúsculas, dígitos e hífen');
  assert.equal(vai('#historico?tipo=automatico'), '#historico?tipo=automatico', 'o Histórico segue levando o filtro');
  assert.equal(vai('#visao/qualquer'), '#visao', 'fora dos Docs, o que vem depois da "/" não fica no endereço');
  assert.deepEqual(abertos, ['docs/conexoes/amazon', 'docs/conexoes', 'docs/xyz', 'docs', 'docs', 'docs', 'docs']);

  // ajuda: todo q('…') das telas tem verbete (o conteúdo longo mora nos capítulos de public/docs/)
  const actx = vm.createContext({ document: { addEventListener() {}, getElementById: () => null }, addEventListener() {} });
  vm.runInContext(fonte('ajuda.js'), actx, { filename: 'public/ajuda.js' });
  const TIPS = JSON.parse(vm.runInContext('JSON.stringify(TIPS)', actx));
  for (const arq of fs.readdirSync(path.join(RAIZ, 'public')).filter((f) => f.endsWith('.js'))) {
    for (const m of fonte(arq).matchAll(/\bq\(\s*'([^']+)'\s*\)/g)) assert.ok(Object.hasOwn(TIPS, m[1]), `${arq}: q('${m[1]}') sem verbete`);
  }
  for (const k of ['manual', 'manual.link', 'manual.agendar', 'manual.etiqueta', 'mensagem', 'mensagem.formato', 'mensagem.enquete', 'mensagem.imagem',
    'mensagem.quando', 'relatorios', 'relatorios.virada', 'relatorios.limite', 'relatorios.avisos', 'conexoes', 'conexoes.segredo']) assert.ok(Object.hasOwn(TIPS, k), `TIPS.${k}`);
  assert.equal(vm.runInContext("typeof AJUDA + typeof GLOSSARIO + typeof paginaAjuda", actx), 'undefinedundefinedundefined', 'AJUDA, GLOSSARIO e paginaAjuda foram para os Docs');

  const readme = fs.readFileSync(path.join(RAIZ, 'README.md'), 'utf8');
  for (const t of ['Disparo manual', 'Disparo automático', 'Disparar mensagem', 'Relatórios e avisos', 'Conexões', 'Números de WhatsApp']) assert.ok(readme.includes(t), `README cita "${t}"`);
});

// ================= rodada 2: cenários próprios do qa sobre as correções do servidor =================
const finalizado = (db, id) => ['concluido', 'erro', 'cancelado'].includes(statusDe(db, id));

test('S14 rodada 2: três "agora" seguidos (mensagem, enquete e oferta) para dois grupos saem um de cada vez, com a pausa entre todas as 6 mensagens', async () => {
  const s = await subir({ fast: false });
  try {
    setSetting(s.db, 'delay_group_s', 0.5); // jitter: de 0,35 s a 0,65 s
    const ids = [];
    for (const c of [{ tipo: 'mensagem', texto: 'um' }, { tipo: 'enquete', pergunta: 'dois?', opcoes: ['a', 'b'] }, { tipo: 'oferta', url: URL_ML, tag_id: 1, template_id: 1 }]) {
      const r = await s.post('/api/envios', { ...c, group_jids: ['111@g.us', '222@g.us'] });
      assert.equal(r.status, 200, r.txt);
      assert.equal(r.json.status, 'pendente', 'a resposta não espera o envio');
      ids.push(r.json.id);
    }
    await esperar(() => ids.every((id) => finalizado(s.db, id)), 15000, 'os três envios terminarem');
    assert.deepEqual(ids.map((id) => statusDe(s.db, id)), ['concluido', 'concluido', 'concluido']);
    const res = s.db.prepare('SELECT envio_id, jid, ts FROM envio_resultados ORDER BY ts, id').all();
    assert.deepEqual(res.map((r) => [r.envio_id, r.jid]), ids.flatMap((id) => [[id, '111@g.us'], [id, '222@g.us']]), 'um envio de cada vez, sem intercalar');
    // 340 e não 350: o timer do Node pode disparar 1 ms antes do Date.now(); em paralelo, o intervalo seria ~0
    for (let i = 1; i < res.length; i++) assert.ok(res[i].ts - res[i - 1].ts >= 340, `intervalo ${i}: ${res[i].ts - res[i - 1].ts} ms`);
    assert.deepEqual(s.wa.simulated.map((x) => x.tipo), ['text', 'text', 'poll', 'poll', 'image', 'image']);
    await dorme(50); // o tick termina avisos e regras antes de fechar o banco
  } finally { await s.fechar(); }
});

test('S14 rodada 2: "agora" criado enquanto uma regra envia sai no mesmo tick, depois da regra e sem se intercalar com ela', async () => {
  const m = montar({ ml: mlReal }); // regra de lista com título e preço: o módulo ml de verdade não acessa a rede
  try {
    m.db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id, group_jids, source_type, source_config, per_run, interval_min,
      window_start, window_end, dedupe_days, send_image, created_at) VALUES ('Regra QA', 1, 1, 1, '["111@g.us","222@g.us"]', 'list', ?, 1, 60, '00:00', '00:00', 7, 0, 1)`)
      .run(JSON.stringify({ items: 'https://produto.mercadolivre.com.br/MLB-1000001-a | Fone da Regra | 50 | 100' }));
    const enviar = m.wa.sendText; let criado = null;
    m.wa.sendText = async (jid, texto, o) => {
      if (!criado && /Fone da Regra/.test(texto)) criado = await m.envios.criar({ tipo: 'mensagem', texto: 'agora no meio da regra', group_jids: ['111@g.us'] });
      return enviar(jid, texto, o);
    };
    await m.scheduler.tick();
    assert.ok(criado, 'a regra começou a enviar');
    assert.equal(statusDe(m.db, criado.id), 'concluido', 'saiu antes de o tick terminar');
    assert.deepEqual(m.wa.simulated.map((x) => [x.jid, /Fone da Regra/.test(x.text) ? 'regra' : x.text]),
      [['111@g.us', 'regra'], ['222@g.us', 'regra'], ['111@g.us', 'agora no meio da regra']]);
  } finally { m.db.close(); }
});

test('S14 rodada 2: "agora" criado enquanto outro "agora" está saindo também sai no mesmo tick, depois dele', async () => {
  const m = montar();
  try {
    const agora = Date.now();
    const primeiro = Number(m.db.prepare(`INSERT INTO envios (tipo, payload, group_jids, quando, status, next_run_at, created_at)
      VALUES ('mensagem', ?, '["111@g.us","222@g.us"]', 'agora', 'pendente', ?, ?)`).run(JSON.stringify({ texto: 'primeiro', imagem: 'nenhuma' }), agora, agora).lastInsertRowid);
    const enviar = m.wa.sendText; let segundo = null;
    m.wa.sendText = async (jid, texto, o) => {
      if (texto === 'primeiro' && !segundo) segundo = await m.envios.criar({ tipo: 'mensagem', texto: 'segundo', group_jids: ['111@g.us'] });
      return enviar(jid, texto, o);
    };
    await m.scheduler.tick();
    assert.deepEqual([statusDe(m.db, primeiro), statusDe(m.db, segundo.id)], ['concluido', 'concluido']);
    assert.deepEqual(m.wa.simulated.map((x) => [x.jid, x.text]), [['111@g.us', 'primeiro'], ['222@g.us', 'primeiro'], ['111@g.us', 'segundo']]);
  } finally { m.db.close(); }
});

/** Bloco PNG com o CRC certo. */
const blocoPng = (tipo, dados) => {
  const td = Buffer.concat([Buffer.from(tipo, 'latin1'), Buffer.from(dados, 'latin1')]);
  const tam = Buffer.alloc(4); tam.writeUInt32BE(td.length - 4); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
  return Buffer.concat([tam, td, crc]);
};
/** Segmento APP1 Exif (TIFF big-endian) com ImageDescription e Orientation no IFD0, como o de uma câmera de celular. */
function app1Exif({ orientacao, descricao }) {
  const texto = Buffer.from(`${descricao}\0`, 'latin1');
  const tiff = Buffer.alloc(8 + 2 + 2 * 12 + 4);
  tiff.write('MM', 0, 'latin1'); tiff.writeUInt16BE(42, 2); tiff.writeUInt32BE(8, 4); tiff.writeUInt16BE(2, 8);
  tiff.writeUInt16BE(0x010e, 10); tiff.writeUInt16BE(2, 12); tiff.writeUInt32BE(texto.length, 14); tiff.writeUInt32BE(tiff.length, 18); // ImageDescription
  tiff.writeUInt16BE(0x0112, 22); tiff.writeUInt16BE(3, 24); tiff.writeUInt32BE(1, 26); tiff.writeUInt16BE(orientacao, 30);           // Orientation
  tiff.writeUInt32BE(0, 34); // sem IFD seguinte
  const corpo = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff, texto]);
  return Buffer.concat([Buffer.from([0xff, 0xe1, (corpo.length + 2) >> 8, (corpo.length + 2) & 0xff]), corpo]);
}
/** Segmentos de um JPEG até o primeiro scan: [{ m, corpo }]. */
function segmentosJpeg(buf) {
  const out = []; let i = 2;
  while (i + 4 <= buf.length && buf[i] === 0xff) {
    const m = buf[i + 1];
    if (m === 0xd9 || m === 0xda) break;
    const tam = buf.readUInt16BE(i + 2);
    out.push({ m, corpo: buf.subarray(i + 4, i + 2 + tam) }); i += 2 + tam;
  }
  return out;
}
/** Orientação do Exif (tag 0x0112 do IFD0); 1 se não houver. */
function orientacaoJpeg(buf) {
  for (const { m, corpo } of segmentosJpeg(buf)) {
    if (m !== 0xe1 || corpo.toString('latin1', 0, 6) !== 'Exif\0\0') continue;
    const t = corpo.subarray(6); const le = t[0] === 0x49;
    const u16 = (o) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o)); const u32 = (o) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
    const ifd = u32(4);
    for (let k = 0; k < u16(ifd); k++) if (u16(ifd + 2 + k * 12) === 0x0112) return u16(ifd + 2 + k * 12 + 8);
  }
  return 1;
}
/** Como a foto aparece na tela (quem respeita o Exif gira 90° nas orientações 5 a 8). → [largura, altura] */
function comoAparece(buf) {
  const sof = segmentosJpeg(buf).find(({ m }) => m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m));
  const [w, h] = [sof.corpo.readUInt16BE(3), sof.corpo.readUInt16BE(1)];
  return [5, 6, 7, 8].includes(orientacaoJpeg(buf)) ? [h, w] : [w, h];
}
async function sharpOuNada() { try { return (await import('sharp')).default; } catch { return null; } }

test('S15 rodada 2: JPEG real com Exif (aparelho, GPS) e PNG real com tEXt/iTXt antes e depois do IDAT são gravados sem eles e com a mesma imagem', async (t) => {
  const sharp = await sharpOuNada();
  if (!sharp) t.diagnostic('sharp ausente: só o PNG mínimo');
  const s = await subir();
  try {
    const gravar = async (buf, tipo) => {
      const r = await s.upload(buf, tipo); assert.equal(r.status, 200, r.txt);
      return fs.readFileSync(path.join(s.dir, 'uploads', r.json.id));
    };
    if (sharp) {
      const jpg = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#3366cc' } }).jpeg()
        .withExif({ IFD0: { Make: 'Apple', Model: 'iPhone de Pedro', Artist: 'Pedro da Silva' }, IFD3: { GPSLatitudeRef: 'S', GPSLongitudeRef: 'W' } }).toBuffer();
      assert.ok((await sharp(jpg).metadata()).exif && jpg.includes('iPhone de Pedro'), 'a foto de teste tem Exif');
      const limpo = await gravar(jpg, 'image/jpeg');
      for (const marca of ['iPhone', 'Pedro', 'Apple', 'Exif']) assert.ok(!limpo.includes(marca), `${marca} ficou na foto`);
      const info = await sharp(limpo).metadata();
      assert.deepEqual([info.format, info.width, info.height, info.exif], ['jpeg', 8, 6, undefined]);
      assert.deepEqual(await sharp(limpo).raw().toBuffer(), await sharp(jpg).raw().toBuffer(), 'mesmos pixels');
    }
    const png = sharp ? await sharp({ create: { width: 5, height: 4, channels: 4, background: '#ff8800cc' } }).png().toBuffer() : PNG;
    const fim = png.length - 12; // IEND
    const comMeta = Buffer.concat([png.subarray(0, 33), blocoPng('tEXt', 'Author\0Pedro da Silva'), png.subarray(33, fim),
      blocoPng('iTXt', 'XML:com.adobe.xmp\0\0\0\0\0<GPS>-22.90,-43.17</GPS>'), png.subarray(fim)]);
    const limpo = await gravar(comMeta, 'image/png');
    assert.deepEqual(limpo, png, 'o PNG volta a ser o original, byte a byte');
    if (sharp) assert.deepEqual(await sharp(limpo).raw().toBuffer(), await sharp(png).raw().toBuffer());
  } finally { await s.fechar(); }
});

test('S15 rodada 2: foto de celular com orientação no Exif perde os dados pessoais mas continua em pé no grupo', async () => {
  const sharp = await sharpOuNada();
  // 8×6 gravada "deitada" com orientação 6 (girar 90°), como a câmera de muitos celulares faz com foto em pé
  const base = sharp ? await sharp({ create: { width: 8, height: 6, channels: 3, background: '#3366cc' } }).jpeg().toBuffer()
    : Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from('ffc0000b080006000801011100', 'hex'), Buffer.from([0xff, 0xd9])]);
  const foto = Buffer.concat([base.subarray(0, 2), app1Exif({ orientacao: 6, descricao: 'iPhone de Pedro GPS -22.9068 -43.1729' }), base.subarray(2)]);
  assert.deepEqual(comoAparece(foto), [6, 8], 'no computador e na miniatura do painel ela aparece em pé (6×8)');
  if (sharp) assert.deepEqual((await sharp(foto).metadata()).autoOrient, { width: 6, height: 8 }, 'o sharp concorda');
  const s = await subir();
  try {
    const r = await s.upload(foto, 'image/jpeg'); assert.equal(r.status, 200, r.txt);
    const gravada = fs.readFileSync(path.join(s.dir, 'uploads', r.json.id));
    for (const marca of ['iPhone', 'Pedro', 'GPS']) assert.ok(!gravada.includes(marca), `${marca} ficou na foto`);
    assert.deepEqual(comoAparece(gravada), [6, 8], 'a foto gravada (a que vai ao grupo) aparece deitada: a orientação saiu junto com o Exif');
  } finally { await s.fechar(); }
});

test('Q9 rodada 3: JPEG progressivo de celular (orientação 6 + GPS), CMYK e Display P3 saem em pé, sem metadados e com as cores certas; HEIC/WEBP/AVIF dizendo JPEG → 415', async (t) => {
  const sharp = await sharpOuNada();
  if (!sharp) { t.skip('sharp ausente: o upload usa o percurso manual'); return; }
  // 80×60 "deitada": metade de cima vermelha, de baixo azul, quadrado verde no canto de cima à esquerda
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="30" fill="#dd2222"/><rect y="30" width="80" height="30" fill="#2222dd"/><rect width="20" height="15" fill="#22dd22"/></svg>');
  const s = await subir();
  try {
    const gravada = async (buf, tipo) => {
      const r = await s.upload(buf, tipo); assert.equal(r.status, 200, r.txt);
      return fs.readFileSync(path.join(s.dir, 'uploads', r.json.id));
    };
    const cor = async (buf, fx, fy) => { // [r,g,b] do ponto (fração da largura/altura), sem aplicar perfil de cor
      const { data, info } = await sharp(buf, { ignoreIcc: true }).raw().toBuffer({ resolveWithObject: true });
      const o = (Math.floor(info.height * fy) * info.width + Math.floor(info.width * fx)) * info.channels;
      return [...data.subarray(o, o + 3)];
    };
    const bin = (c) => c.map((v) => (v > 128 ? 1 : 0));

    // progressivo, como o celular grava: orientação 6, aparelho e GPS no Exif
    const prog = await sharp(svg).jpeg({ progressive: true })
      .withExif({ IFD0: { Model: 'iPhone de Pedro' }, IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '22/1 54/1 2448/100' } }).withMetadata({ orientation: 6 }).toBuffer();
    const pm = await sharp(prog).metadata();
    const temGps = (buf) => segmentosJpeg(buf).some(({ m, corpo }) => { // tag 0x8825 (GPSInfo) no IFD0 do Exif
      if (m !== 0xe1 || corpo.toString('latin1', 0, 6) !== 'Exif\0\0') return false;
      const tf = corpo.subarray(6); const le = tf[0] === 0x49;
      const u16 = (o) => (le ? tf.readUInt16LE(o) : tf.readUInt16BE(o)); const ifd = le ? tf.readUInt32LE(4) : tf.readUInt32BE(4);
      return Array.from({ length: u16(ifd) }, (_, k) => u16(ifd + 2 + k * 12)).includes(0x8825);
    });
    assert.deepEqual([pm.isProgressive, pm.orientation, prog.includes('iPhone de Pedro'), temGps(prog)], [true, 6, true, true], 'a foto de teste');
    const g1 = await gravada(prog, 'image/jpeg');
    const m1 = await sharp(g1).metadata();
    assert.deepEqual([m1.width, m1.height, m1.orientation, m1.exif, m1.icc], [60, 80, undefined, undefined, undefined], 'em pé pelos pixels, sem Exif nem ICC');
    for (const marca of ['iPhone', 'Pedro', 'Exif']) assert.ok(!g1.includes(marca), `${marca} ficou na foto`);
    assert.equal(temGps(g1), false, 'o GPS ficou na foto');
    // girar 90° no horário: o verde (alto à esquerda no arquivo) vai para o alto à direita, o vermelho para a direita
    assert.deepEqual([bin(await cor(g1, 0.9, 0.08)), bin(await cor(g1, 0.8, 0.6)), bin(await cor(g1, 0.2, 0.6))], [[0, 1, 0], [1, 0, 0], [0, 0, 1]], 'girou para o lado certo');

    // CMYK (foto baixada de gráfica): vira sRGB com as mesmas cores, não fica com as cores invertidas
    const cmyk = await sharp(svg).toColourspace('cmyk').jpeg().toBuffer();
    assert.equal((await sharp(cmyk).metadata()).space, 'cmyk');
    const g2 = await gravada(cmyk, 'image/jpeg');
    const m2 = await sharp(g2).metadata();
    assert.deepEqual([m2.space, m2.channels, m2.width, m2.height], ['srgb', 3, 80, 60]);
    assert.deepEqual([bin(await cor(g2, 0.6, 0.3)), bin(await cor(g2, 0.5, 0.8))], [[1, 0, 0], [0, 0, 1]], 'vermelho em cima, azul embaixo');

    // Display P3 (o perfil das fotos de iPhone): o perfil sai, então os pixels têm de ser convertidos para sRGB
    const verde = Buffer.alloc(16 * 12 * 3); for (let i = 0; i < verde.length; i += 3) verde.set([40, 200, 60], i);
    const p3 = await sharp(verde, { raw: { width: 16, height: 12, channels: 3 } }).withIccProfile('p3').jpeg({ quality: 95 }).toBuffer();
    const noArquivo = await cor(p3, 0.5, 0.5);
    assert.ok(noArquivo[0] - 40 > 30, `a foto de teste guarda os valores em P3 (${noArquivo}), diferentes do sRGB`);
    const g3 = await gravada(p3, 'image/jpeg');
    assert.equal((await sharp(g3).metadata()).icc, undefined, 'sem perfil ICC');
    const c3 = await cor(g3, 0.5, 0.5);
    assert.ok(c3.every((v, i) => Math.abs(v - [40, 200, 60][i]) <= 6), `cores convertidas para sRGB: ${c3} ≈ 40,200,60`);

    // formatos que o celular também gera, com Content-Type mentindo: nada é gravado
    const pasta = path.join(s.dir, 'uploads'); const antes = fs.readdirSync(pasta).length;
    const webp = await sharp(svg).webp().toBuffer(); const avif = await sharp(svg).avif().toBuffer();
    const heic = Buffer.from(avif.toString('latin1').replace('ftypavif', 'ftypheic').replace('avif', 'heic'), 'latin1'); // contêiner HEIF com a marca do iPhone
    assert.equal(heic.toString('latin1', 4, 12), 'ftypheic');
    for (const [buf, tipo, erro, nome] of [
      [heic, 'image/jpeg', 'Envie uma foto JPG ou PNG.', 'HEIC dizendo JPEG'], [webp, 'image/jpeg', 'Envie uma foto JPG ou PNG.', 'WEBP dizendo JPEG'],
      [avif, 'image/jpeg', 'Envie uma foto JPG ou PNG.', 'AVIF dizendo JPEG'], [heic, 'image/png', 'Envie uma foto JPG ou PNG.', 'HEIC dizendo PNG'],
      [heic, 'image/heic', 'Envie uma foto JPG ou PNG.', 'HEIC'], [webp, 'image/webp', 'Envie uma foto JPG ou PNG.', 'WEBP'],
      [Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), heic]), 'image/jpeg', 'Não consegui ler esta foto.', 'FF D8 FF + HEIC'],
      [Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), webp]), 'image/jpeg', 'Não consegui ler esta foto.', 'FF D8 FF + WEBP'],
    ]) {
      const r = await s.upload(buf, tipo);
      assert.deepEqual([r.status, r.json?.erro], [415, erro], nome);
    }
    assert.equal(fs.readdirSync(pasta).length, antes, 'nada foi gravado');
  } finally { await s.fechar(); }
});

test('S13 rodada 2: erro de 1 MB devolvido pela extensão num disparo "agora" não trava o servidor e chega curto ao painel e ao log', async () => {
  const s = await subir({ modo: 'extension' });
  try {
    const ext = { 'x-token': s.db.prepare("SELECT value FROM settings WHERE key = 'ext_token'").get().value };
    const poll = req(s.port, '/api/ext/poll', { headers: ext }); // a extensão fica esperando um pedido
    await esperar(() => s.links.status().online, 3000, 'a extensão aparecer conectada');
    const e = await s.post('/api/envios', { tipo: 'oferta', url: URL_ML, tag_id: 1, template_id: 1, group_jids: ['111@g.us'] });
    assert.equal(e.status, 200, e.txt);
    const { job } = (await poll).json;
    assert.ok(job?.id, 'o pedido do link chegou à extensão');
    const enorme = `${'a'.repeat(1024 * 1024)}@s.whatsapp.net 5511987654321`;
    const t0 = performance.now();
    const r = await req(s.port, '/api/ext/result', { method: 'POST', headers: ext, body: { id: job.id, ok: false, error: enorme } });
    assert.equal(r.status, 200, r.txt);
    await esperar(() => finalizado(s.db, e.json.id), 5000, 'o envio terminar');
    const ms = performance.now() - t0;
    assert.ok(ms < 1000, `do erro da extensão ao envio encerrado: ${ms.toFixed(0)} ms`);
    const t1 = performance.now();
    assert.equal((await s.get('/api/state')).status, 200);
    assert.ok(performance.now() - t1 < 500, 'o painel responde logo depois');
    assert.equal(statusDe(s.db, e.json.id), 'erro');
    const linha = (await s.get('/api/envios?tipo=oferta')).json.linhas.find((l) => l.status === 'erro');
    assert.ok(linha && linha.erro.length <= 200, `erro no painel: ${linha?.erro?.length} letras`);
    assert.match(linha.erro, /^link de afiliado não gerado: a+/);
    for (const l of s.db.prepare('SELECT message FROM log').all()) assert.ok(String(l.message).length <= 1000);
    assert.ok(s.links.status().lastError.length <= 300);
    assert.equal(s.wa.simulated.length, 0);
  } finally { await s.fechar(); }
});

test('R7 rodada 2: com virada 02:00, leituras às 23:30 e 01:30 (dias diferentes do calendário) contam 1×; a das 02:30 conta de novo; mudar a virada vale na hora', () => {
  const m = montar();
  try {
    setSetting(m.db, 'virada_dia', '02:00');
    const leitura = (d, h, mi) => ({ key: { remoteJid: '111@g.us', fromMe: true }, receipt: { userJid: '5511999990000@s.whatsapp.net', readTimestamp: new Date(2026, 10, d, h, mi).getTime() / 1000 } });
    const linhas = () => m.db.prepare('SELECT day, ts FROM group_reads ORDER BY ts').all().map((r) => [r.day, hhmmDe(r.ts)]);
    m.wa._onReceipts([leitura(2, 23, 30), leitura(3, 1, 30), leitura(3, 2, 30)]);
    assert.deepEqual(linhas(), [['2026-11-02', '23:30'], ['2026-11-03', '02:30']], 'pelo calendário seriam 23:30 e 01:30');
    setSetting(m.db, 'virada_dia', '00:00'); // Relatórios e avisos: a próxima leitura já usa a virada nova
    m.wa._onReceipts([leitura(4, 0, 30), leitura(4, 1, 30)]);
    assert.deepEqual(linhas().slice(2), [['2026-11-04', '00:30']]);
  } finally { m.db.close(); }
});

test('Q6 rodada 2: etiqueta e template apagados e recriados pelo painel (mesmos ids): nada sai com a etiqueta nem com o template intrusos', async (t) => {
  const s = await subir();
  try {
    const tpl = (await s.post('/api/templates', { name: 'Original', body: 'ORIGINAL {TITULO_PRODUTO} {LINK}' })).json.id;
    t.mock.timers.enable({ apis: ['Date'], now: seg(10, 0) });
    const a = await s.envios.criar({ tipo: 'oferta', url: URL_ML, tag_id: 2, template_id: tpl, group_jids: ['111@g.us'], quando: 'agendado', agendar_hhmm: '10:30' });
    const b = await s.envios.criar({ tipo: 'oferta', url: URL_ML, tag_id: 2, template_id: 1, group_jids: ['222@g.us'], quando: 'agendado', agendar_hhmm: '10:30' });
    t.mock.timers.reset();
    assert.equal((await s.req('/api/tags/2', { method: 'DELETE' })).status, 200);
    assert.equal((await s.req(`/api/templates/${tpl}`, { method: 'DELETE' })).status, 200);
    assert.equal((await s.post('/api/tags', { name: 'etiquetaIntrusa' })).status, 200);
    assert.equal((await s.post('/api/templates', { name: 'Intruso', body: 'INTRUSO {TITULO_PRODUTO} {LINK}' })).json.id, tpl, 'o SQLite reaproveitou o id do template');
    assert.equal(s.db.prepare("SELECT id FROM tags WHERE name = 'etiquetaIntrusa'").get().id, 2, 'e o da etiqueta');
    await s.envios.processarPendentes(seg(10, 30) + 1000);
    assert.deepEqual([statusDe(s.db, a.id), statusDe(s.db, b.id)], ['erro', 'concluido']);
    assert.deepEqual(s.wa.simulated.map((x) => x.jid), ['222@g.us'], 'só o que usa o template que ainda existe');
    assert.match(s.wa.simulated[0].text, /https:\/\/meli\.la\/fake-etiquetaB-\d+/, 'com a etiqueta escolhida ao agendar');
    for (const x of s.wa.simulated) assert.doesNotMatch(x.text, /Intrus|INTRUSO/);
    const p = (await s.get('/api/envios?tipo=oferta')).json;
    assert.deepEqual(p.linhas.filter((l) => l.status === 'erro').map((l) => [l.grupo, l.erro]), [['Achadinhos', 'o template foi apagado']]);
  } finally { await s.fechar(); }
});

test('Q7 rodada 2: pausar e retomar perto do horário de um repetido (antes, depois e no meio da rodada) não manda fora de hora nem repete', async (t) => {
  const m = montar();
  try {
    const at = (d, h, mi = 0, sg = 0) => new Date(2026, 10, d, h, mi, sg).getTime();
    const rodar = (ts) => { t.mock.timers.setTime(ts); return m.envios.processarPendentes(ts); };
    t.mock.timers.enable({ apis: ['Date'], now: at(2, 9, 0) });
    const { id } = await m.envios.criar({ tipo: 'mensagem', texto: 'Diário', group_jids: ['111@g.us', '222@g.us'], quando: 'repetir', repetir: { dias: TODOS, horarios: ['10:00'] } });
    assert.equal(proximoDe(m.db, id), at(2, 10));

    // (a) pausa e retoma 30 s antes: continua às 10:00 de hoje e sai uma vez só
    t.mock.timers.setTime(at(2, 9, 59, 30)); await m.envios.pausar(id); await m.envios.retomar(id);
    assert.equal(proximoDe(m.db, id), at(2, 10));
    assert.equal(await rodar(at(2, 10)), 1);
    assert.equal(await rodar(at(2, 10, 0, 5)), 0, 'não repete no mesmo horário');
    assert.equal(m.wa.simulated.length, 2);

    // (b) pausado às 09:59 do dia 3: nada sai às 10:00; retomado às 10:00:30, vai para o dia 4 e não sai na hora
    t.mock.timers.setTime(at(3, 9, 59)); await m.envios.pausar(id);
    assert.equal(await rodar(at(3, 10)), 0);
    t.mock.timers.setTime(at(3, 10, 0, 30));
    assert.equal((await m.envios.retomar(id)).next_run_at, at(4, 10));
    assert.equal(await rodar(at(3, 10, 0, 31)), 0, 'retomar logo depois do horário não manda o que foi pulado');
    assert.equal(m.wa.simulated.length, 2);

    // (c) no dia 4, pausa e retoma depois do 1º grupo: o 2º não recebe fora de hora, a rodada não desfaz o retomar
    const enviar = m.wa.sendText; let mexer = true;
    m.wa.sendText = async (jid, texto, o) => {
      const r = await enviar(jid, texto, o);
      if (mexer) { mexer = false; t.mock.timers.setTime(at(4, 10, 0, 1)); await m.envios.pausar(id); await m.envios.retomar(id); }
      return r;
    };
    await rodar(at(4, 10));
    assert.deepEqual(m.wa.simulated.slice(2).map((x) => x.jid), ['111@g.us']);
    assert.deepEqual([statusDe(m.db, id), proximoDe(m.db, id)], ['pendente', at(5, 10)]);
    assert.equal(await rodar(at(4, 10, 0, 10)), 0);
    assert.equal(await rodar(at(5, 10)), 1);
    assert.deepEqual(m.wa.simulated.slice(3).map((x) => x.jid), ['111@g.us', '222@g.us'], 'o dia 5 vai para os dois');
  } finally { m.db.close(); }
});

test('S16 rodada 2: o freio de consultas de número vale por IP para duas sessões e libera de novo depois de 10 min', async (t) => {
  const s = await subir();
  try {
    let consultas = 0; const resolver = s.wa.resolverNumero;
    s.wa.resolverNumero = async (d) => { consultas++; return resolver(d); };
    const entrou = await req(s.port, '/api/login', { method: 'POST', body: { senha: SENHA } });
    const h2 = { cookie: String(entrou.headers['set-cookie']?.[0] || '').split(';')[0], origin: `http://127.0.0.1:${s.port}` };
    const pela2 = (body) => req(s.port, '/api/avisos/destinos', { method: 'POST', body, headers: h2 });
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    for (let i = 0; i < 10; i++) {
      const body = { nome: `Pessoa ${i}`, numero: `11 9000${i}-0000` };
      const r = i % 2 ? await s.post('/api/avisos/destinos', body) : await pela2(body);
      assert.equal(r.status, 200, r.txt);
    }
    assert.equal((await pela2({ nome: 'Onze', numero: '11 90010-0000' })).status, 429, 'a outra sessão do mesmo IP também está no freio');
    assert.equal((await s.post('/api/avisos/destinos', { nome: 'Onze', numero: '11 90010-0000' })).status, 429);
    assert.equal(consultas, 10);
    t.mock.timers.setTime(Date.now() + 10 * MIN + 1000);
    const depois = await pela2({ nome: 'Onze', numero: '11 90010-0000' });
    assert.equal(depois.status, 200, depois.txt);
    assert.equal(consultas, 11);
    assert.equal((await s.post('/api/avisos/destinos', { nome: 'Pedro 35 99999-1234', numero: '11 90012-0000' })).status, 400, 'S17: telefone no nome');
    assert.equal(consultas, 11, 'o nome recusado não gasta consulta');
  } finally { await s.fechar(); }
});

// ---- "Ler mais" dos ícones "?" (docs-do-sistema, etapa 11) -------------------------------------------------
/** ajuda.js (e, se pedido, docs.js + capítulos) num vm com um DOM falso que guarda os ouvintes e os dispara à mão. */
function montarDicas({ capitulos = true } = {}) {
  const ouvintes = {}; const janela = {}; const doc = { activeElement: null };
  const dispara = (tipo, e) => { for (const fn of ouvintes[tipo] || []) fn(e); };
  const tip = {
    id: 'tip', hidden: true, aberto: false, filhos: [], texto: '', aberturas: 0, classes: new Set(), style: {},
    set textContent(v) { this.texto = String(v); this.filhos = []; }, get textContent() { return this.texto + this.filhos.map((f) => f.textContent).join(''); },
    set innerHTML(_) { throw new Error('innerHTML na dica é proibido: o texto do link vai por textContent'); },
    appendChild(f) { f.pai = this; this.filhos.push(f); return f; },
    classList: { add: (...c) => c.forEach((x) => tip.classes.add(x)), remove: (...c) => c.forEach((x) => tip.classes.delete(x)) },
    showPopover() { this.aberto = true; this.aberturas++; }, hidePopover() { this.aberto = false; }, matches: (s) => s === ':popover-open' && tip.aberto,
    offsetWidth: 200, offsetHeight: 60,
    closest: (s) => (s === '#tip' ? tip : null),
  };
  const noCorpo = (f) => { f.parentNode = doc.body; return f; };
  doc.body = { appendChild: noCorpo }; tip.parentNode = doc.body;
  doc.createElement = (tag) => {
    const el = { tag, style: {}, className: '', href: '', texto: '', get textContent() { return this.texto; }, set textContent(v) { this.texto = String(v); },
      closest(s) { return s === '#tip' ? (this.pai === tip ? tip : null) : s === 'a' ? this : null; },
      focus() { doc.activeElement = this; } };
    return el;
  };
  doc.getElementById = (id) => (id === 'tip' ? tip : null);
  doc.addEventListener = (tipo, fn) => { (ouvintes[tipo] ||= []).push(fn); };
  const ctx = vm.createContext({ document: doc, addEventListener: (tipo, fn) => { (janela[tipo] ||= []).push(fn); }, innerWidth: 1024, innerHeight: 768 });
  vm.runInContext(fonte('ajuda.js'), ctx, { filename: 'public/ajuda.js' });
  if (capitulos) {
    vm.runInContext(fonte('docs.js'), ctx, { filename: 'public/docs.js' });
    for (const arq of fs.readdirSync(path.join(RAIZ, 'public', 'docs')).filter((f) => f.endsWith('.js'))) vm.runInContext(fonte('docs/' + arq), ctx, { filename: 'public/docs/' + arq });
  }
  /** Ícone "?" falso: dataset do HTML de q(); focus() dispara o focusin como o navegador. */
  const icone = (chave, dialogo = null) => {
    const html = vm.runInContext(`q(${JSON.stringify(chave)})`, ctx);
    const dataset = {}; for (const m of html.matchAll(/ data-(tip|docs)="([^"]*)"/g)) dataset[m[1]] = m[2].replace(/&quot;/g, '"');
    const attrs = {}; for (const m of html.matchAll(/ (role|aria-expanded)="([^"]*)"/g)) attrs[m[1]] = m[2];
    const el = { html, dataset, attrs, isConnected: true, focos: 0,
      closest: (s) => (s === '.q' || (s === '.q[data-docs]' && dataset.docs) ? el : s === 'dialog' ? dialogo : null),
      getBoundingClientRect: () => ({ left: 100, right: 112, top: 200, bottom: 214, width: 12, height: 14 }),
      setAttribute(k, v) { attrs[k] = String(v); },
      focus() { doc.activeElement = el; el.focos++; dispara('focusin', { target: el }); } };
    return el;
  };
  const tecla = (alvoEl, key, extra = {}) => { const e = { key, target: alvoEl, defaultPrevented: false, parou: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.parou = true; }, ...extra }; dispara('keydown', e); return e; };
  const clique = (alvoEl) => { const e = { target: alvoEl, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; dispara('click', e); return e; };
  const sobre = (el) => dispara('mouseover', { target: el });
  const sai = (el) => dispara('mouseout', { target: el });
  const rola = () => { for (const fn of janela.scroll || []) fn({}); };
  const hash = () => { for (const fn of janela.hashchange || []) fn({}); };
  return { ctx, doc, tip, icone, tecla, clique, sobre, sai, rola, hash, dispara, janela, rodar: (c) => vm.runInContext(c, ctx) };
}
const TITULO_AMAZON = 'Amazon: tag e API'; // título da seção conexoes/amazon em public/docs/cap-comecar.js

test('Ler mais (etapa 11): toda chave de LEIA_MAIS existe em TIPS e todo destino existe nos capítulos; o mapa da spec está inteiro', () => {
  const D = montarDicas();
  const TIPS = JSON.parse(D.rodar('JSON.stringify(TIPS)'));
  const LEIA = JSON.parse(D.rodar('JSON.stringify(LEIA_MAIS)'));
  const CAPS = JSON.parse(D.rodar('JSON.stringify(DOCS_CAPS)'));
  assert.ok(Object.keys(LEIA).length >= 30, 'o mapa não ficou vazio');
  for (const [chave, destino] of Object.entries(LEIA)) {
    assert.ok(Object.hasOwn(TIPS, chave), `LEIA_MAIS.${chave} não tem verbete em TIPS`);
    assert.match(destino, /^[a-z0-9-]+\/[a-z0-9-]+$/, `${chave}: destino mal formado`);
    const [cap, sec] = destino.split('/');
    assert.ok(CAPS[cap], `${chave}: o capítulo ${cap} não existe`);
    assert.ok(CAPS[cap].secoes.some((x) => x.id === sec), `${chave}: a seção ${destino} não existe`);
  }
  // mapa inicial da spec (docs/produto/specs/docs-do-sistema.md, seção 3)
  const SPEC = { 'conexoes.amazon': 'conexoes/amazon', 'espelhamento.formato': 'espelhamento/formato', 'espelhamento.fila': 'espelhamento/fila', espelhamento: 'espelhamento/criar',
    'conexoes.shopee': 'conexoes/shopee', 'conexoes.shopee.id': 'perguntas/id-shopee', 'conexoes.shopee.appid': 'perguntas/id-shopee', 'conexoes.shopee.senha': 'perguntas/id-shopee',
    'conexoes.shopee.extensao': 'primeiros-passos/extensao', 'ajustes.extensao': 'primeiros-passos/extensao', 'conexoes.catalogo': 'conexoes/catalogo',
    'conexoes.catalogo.endereco': 'conexoes/catalogo', 'conexoes.catalogo.token': 'conexoes/catalogo', 'regras.etiqueta': 'perguntas/etiqueta-desta-fonte',
    'fonte.etiqueta': 'perguntas/etiqueta-desta-fonte', 'fonte.catalogo': 'disparo-automatico/catalogo', 'fonte.catalogo.ordem': 'disparo-automatico/catalogo',
    'fonte.catalogo.revisao': 'revisao/motivos', 'regras.fontes': 'disparo-automatico/fontes', 'fonte.tipos': 'disparo-automatico/fontes',
    'manual.link': 'disparo-manual/mercado-livre', 'manual.amazon': 'disparo-manual/amazon', 'manual.shopee': 'disparo-manual/shopee',
    'regras.template': 'templates/linha-some', templates: 'templates/linha-some', whatsapp: 'primeiros-passos/whatsapp', equipe: 'equipe/papeis',
    'equipe.convite': 'equipe/convidar', 'ajustes.privacidade': 'privacidade/retencao', links: 'grupos/rotacionador', 'links.modo': 'grupos/rotacionador',
    'links.proximo': 'grupos/proximo-grupo', relatorios: 'resultados/avisos', 'relatorios.virada': 'resultados/avisos', 'remetente': 'disparo-automatico/remetentes' };
  assert.deepEqual(LEIA, SPEC);
  // todo ícone q('chave') de uma tela com destino sai com data-docs; os demais seguem sem
  for (const chave of Object.keys(TIPS)) {
    const html = D.rodar(`q(${JSON.stringify(chave)})`);
    if (LEIA[chave]) assert.match(html, new RegExp(`data-docs="${LEIA[chave]}"`), chave); else assert.doesNotMatch(html, /data-docs/, chave);
  }
});

test('Ler mais (etapa 11): q() — com destino vira botão que ainda não está aberto; sem destino fica como era; chave de protótipo não vale', () => {
  const D = montarDicas({ capitulos: false });
  const com = D.rodar("q('conexoes.amazon')");
  assert.match(com, /^<span class="q" tabindex="0" role="button" aria-expanded="false" aria-label="Ajuda: [^"]+" data-tip="[^"]+" data-docs="conexoes\/amazon">\?<\/span>$/);
  const sem = D.rodar("q('regras')");
  assert.match(sem, /^<span class="q" tabindex="0" role="img" aria-label="Ajuda: [^"]+" data-tip="[^"]+">\?<\/span>$/);
  assert.equal(D.rodar("q('nao.existe')"), '');
  assert.equal(D.rodar("q('constructor')"), '');
  assert.equal(D.rodar("leiaMaisDe('constructor') + leiaMaisDe('__proto__') + leiaMaisDe(null)"), '');
  // aspas na dica não quebram o atributo (como antes)
  assert.doesNotMatch(D.rodar("q('regras.fontes')").replace(/&quot;/g, ''), /data-tip="[^"]*"[^>]*"[^>]*data-docs/);
});

test('Ler mais (etapa 11): hover só mostra a prévia; clique, toque, Enter e Espaço fixam a dica com o link e o foco nele', () => {
  const D = montarDicas(); const q1 = D.icone('conexoes.amazon');
  D.sobre(q1);
  assert.equal(D.tip.aberto, true); assert.equal(D.tip.filhos.length, 0, 'prévia sem link'); assert.equal(D.tip.style.pointerEvents ?? '', '');
  D.sai(q1); assert.equal(D.tip.aberto, false, 'a prévia some ao sair');

  // clique (e o toque, que o navegador entrega como mouseover + focusin + click)
  D.sobre(q1); q1.focus();
  const e = D.clique(q1);
  assert.ok(e.defaultPrevented);
  assert.equal(D.tip.aberto, true); assert.equal(D.tip.filhos.length, 1);
  const a = D.tip.filhos[0];
  assert.equal(a.tag, 'a'); assert.equal(a.href, '#docs/conexoes/amazon'); assert.equal(a.textContent, `Ler mais: ${TITULO_AMAZON} →`);
  assert.equal(D.doc.activeElement, a, 'o foco vai para o link');
  // R5: o pointer-events da dica fixa e o layout do link vêm do CSS (.tip.tip-fixo e .tip-link), nada inline
  assert.ok(D.tip.classes.has('tip-fixo'), 'a dica fixa recebe cliques pela classe tip-fixo'); assert.equal(D.tip.style.pointerEvents ?? '', ''); assert.deepEqual({ ...a.style }, {}, 'o link não leva style inline');
  assert.match(fs.readFileSync(path.join(RAIZ, 'public', 'style.css'), 'utf8'), /\.tip\.tip-fixo\s*\{[^}]*pointer-events:\s*auto/);
  assert.equal(a.target ?? '', '', 'fora de diálogo o link navega na mesma aba'); assert.equal(a.rel ?? '', '');
  assert.equal(q1.attrs['aria-expanded'], 'true');
  assert.equal(D.tip.textContent, `${q1.dataset.tip}Ler mais: ${TITULO_AMAZON} →`);

  // Enter e Espaço no "?" com o foco nele (sem clique): fixam; o Espaço não rola a página
  for (const key of ['Enter', ' ']) {
    const D2 = montarDicas(); const k = D2.icone('conexoes.shopee.id'); k.focus();
    assert.equal(D2.tip.filhos.length, 0, 'foco: só a prévia');
    const ev = D2.tecla(k, key);
    assert.ok(ev.defaultPrevented, `${JSON.stringify(key)} não rola nem clica`);
    assert.equal(D2.tip.filhos[0].href, '#docs/perguntas/id-shopee');
    assert.equal(D2.tip.filhos[0].textContent, 'Ler mais: Meu ID de afiliado da Shopee vai no AppID? →');
    assert.equal(D2.doc.activeElement, D2.tip.filhos[0]);
  }
  // Enter com Ctrl/Alt/Meta não fixa; Enter em outro elemento não faz nada
  const D3 = montarDicas(); const k3 = D3.icone('whatsapp'); k3.focus();
  D3.tecla(k3, 'Enter', { ctrlKey: true }); assert.equal(D3.tip.filhos.length, 0);
  assert.equal(D3.tecla({ closest: () => null }, 'Enter').defaultPrevented, false);
});

test('Ler mais (etapa 11): a dica fixa não some ao tirar o mouse, ao perder o foco no "?" nem ao rolar; Esc devolve o foco ao "?" e não reabre a prévia', () => {
  const D = montarDicas(); const k = D.icone('conexoes.catalogo'); k.focus(); D.clique(k);
  const a = D.tip.filhos[0];
  D.sai(k); D.dispara('focusout', { target: k, relatedTarget: a }); D.rola(); D.rola();
  assert.equal(D.tip.aberto, true, 'segue aberta');
  // passar o mouse por outro "?" não troca a dica fixa
  const outro = D.icone('regras'); D.sobre(outro); outro.focus();
  assert.equal(D.tip.textContent, `${k.dataset.tip}Ler mais: Catálogo do Etiqueta →`.replace('Catálogo do Etiqueta', a.textContent.slice('Ler mais: '.length, -2)));
  const antes = k.focos;
  const esc = D.tecla(a, 'Escape');
  assert.ok(esc.defaultPrevented && esc.parou, 'o Esc não fecha também o diálogo que contém o "?"');
  assert.equal(D.tip.aberto, false); assert.equal(D.doc.activeElement, k); assert.equal(k.focos, antes + 1);
  assert.equal(D.tip.aberto, false, 'o foco devolvido não reabre a prévia');
  assert.equal(k.attrs['aria-expanded'], 'false');
  // Esc sem dica fixa: fecha a prévia e não bloqueia o Esc de quem está embaixo
  const D2 = montarDicas(); const p = D2.icone('regras'); D2.sobre(p);
  const e2 = D2.tecla(p, 'Escape'); assert.equal(D2.tip.aberto, false); assert.equal(e2.defaultPrevented, false);
});

test('Ler mais (etapa 11): clicar de novo no "?", fora, no link ou mudar de página fecha; clicar no texto da dica fixa não; Tab sai do link para o "?"', () => {
  const abre = () => { const D = montarDicas(); const k = D.icone('equipe.convite'); k.focus(); D.clique(k); return { D, k, a: D.tip.filhos[0] }; };
  let c = abre(); D_ok(c.D.clique(c.k)); assert.equal(c.D.tip.aberto, false, 'segundo clique no "?" fecha'); assert.equal(c.D.doc.activeElement, c.k);
  c = abre(); c.D.clique({ closest: () => null }); assert.equal(c.D.tip.aberto, false, 'clique fora');
  c = abre(); c.D.clique(c.D.tip); assert.equal(c.D.tip.aberto, true, 'clicar no texto da dica não fecha');
  c = abre(); const ev = c.D.clique(c.a); assert.equal(c.D.tip.aberto, false, 'clicar no link fecha'); assert.equal(ev.defaultPrevented, false, 'e deixa o link navegar');
  c = abre(); c.D.hash(); assert.equal(c.D.tip.aberto, false, 'mudou o endereço');
  // Tab (ou Shift+Tab) dentro da dica: fecha e o foco volta ao "?" para o Tab seguir dali
  c = abre(); const t = c.D.tecla(c.a, 'Tab'); assert.equal(c.D.tip.aberto, false); assert.equal(c.D.doc.activeElement, c.k); assert.equal(t.defaultPrevented, false);
  // o foco indo para outro lugar da página fecha; ir para o próprio "?" ou para dentro da dica não
  c = abre(); c.D.dispara('focusout', { target: c.a, relatedTarget: c.k }); assert.equal(c.D.tip.aberto, true);
  c.D.dispara('focusout', { target: c.k, relatedTarget: c.a }); assert.equal(c.D.tip.aberto, true);
  c.D.dispara('focusout', { target: c.a, relatedTarget: { closest: () => null } }); assert.equal(c.D.tip.aberto, false);
  c = abre(); c.D.dispara('focusout', { target: c.a, relatedTarget: null }); assert.equal(c.D.tip.aberto, true, 'janela perdendo o foco não fecha');
  // outro "?" com destino, clicado com a primeira aberta, passa a ser a fixa (e a primeira volta a "fechada")
  c = abre(); const k2 = c.D.icone('whatsapp'); c.D.clique(k2);
  assert.equal(c.k.attrs['aria-expanded'], 'false'); assert.equal(k2.attrs['aria-expanded'], 'true');
  assert.equal(c.D.tip.filhos.length, 1); assert.equal(c.D.tip.filhos[0].href, '#docs/primeiros-passos/whatsapp');
  function D_ok(e) { assert.ok(e.defaultPrevented); }
});

test('Ler mais (etapa 11): "?" dentro de um <dialog> modal: a dica fixa vai para dentro dele (fora dele tudo é inerte) e volta ao <body> ao fechar', () => {
  const D = montarDicas();
  const dlg = { appendChild(f) { f.parentNode = this; return f; } };
  const k = D.icone('conexoes.amazon', dlg);
  D.sobre(k); assert.equal(D.tip.parentNode, D.doc.body, 'a prévia (só hover) fica no <body>');
  D.clique(k); assert.equal(D.tip.parentNode, dlg, 'fixa: dentro do diálogo'); assert.equal(D.tip.aberto, true); assert.equal(D.doc.activeElement, D.tip.filhos[0]);
  D.tecla(D.tip.filhos[0], 'Escape'); assert.equal(D.tip.parentNode, D.doc.body, 'Esc devolve a dica ao <body>');
  D.clique(k); assert.equal(D.tip.parentNode, dlg);
  D.clique({ closest: () => null }); assert.equal(D.tip.parentNode, D.doc.body, 'clique fora também');
  D.clique(k); D.dispara('close', { target: dlg }); assert.equal(D.tip.aberto, false, 'diálogo fechado por fora fecha a dica'); assert.equal(D.tip.parentNode, D.doc.body);
  // "?" fora de diálogo: a dica fica no <body>, mesmo depois de ter estado dentro de um
  const fora = D.icone('whatsapp'); D.clique(fora); assert.equal(D.tip.parentNode, D.doc.body); assert.equal(D.tip.aberto, true);
});

test('Ler mais (D4/R2): "?" dentro de um <dialog> abre o link em outra aba (o formulário aberto não se perde); fora dele, igual a antes', () => {
  const D = montarDicas();
  const dlg = { appendChild(f) { f.parentNode = this; return f; } };
  const k = D.icone('conexoes.amazon', dlg); D.clique(k);
  const a = D.tip.filhos[0];
  assert.equal(a.href, '#docs/conexoes/amazon');
  assert.equal(a.target, '_blank'); assert.equal(a.rel, 'noopener');
  assert.equal(a.textContent, `Ler mais (abre em outra aba): ${TITULO_AMAZON} →`);
  assert.equal(D.doc.activeElement, a, 'o foco continua indo para o link');
  assert.deepEqual({ ...a.style }, {}, 'sem style inline também aqui');
  // "?" sem <dialog> na ascendência: texto e atributos de sempre
  const fora = D.icone('conexoes.amazon'); D.clique(fora);
  const b = D.tip.filhos[0];
  assert.equal(b.textContent, `Ler mais: ${TITULO_AMAZON} →`); assert.ok(!b.target && !b.rel);
  // a mesma chave, agora em outro diálogo, e depois fora de novo: cada abertura decide pelo seu "?"
  const k2 = D.icone('conexoes.shopee.id', dlg); D.clique(k2);
  assert.equal(D.tip.filhos[0].target, '_blank'); assert.match(D.tip.filhos[0].textContent, /^Ler mais \(abre em outra aba\): /);
  D.clique(fora); assert.equal(D.tip.filhos[0].target ?? '', '');
  // R9: o exemplo do desconto bate com o que o template gera ("25%", sem "OFF")
  assert.match(D.rodar('DICAS_PLACEHOLDERS.DESCONTO_PRODUTO'), /como 25%\./); assert.doesNotMatch(D.rodar('DICAS_PLACEHOLDERS.DESCONTO_PRODUTO'), /OFF/);
});

test('Ler mais (etapa 11): "?" sem destino mantém o comportamento de antes (prévia, alterna no clique, sem link nem foco movido)', () => {
  const D = montarDicas(); const k = D.icone('regras');
  D.sobre(k); assert.equal(D.tip.aberto, true); D.sai(k); assert.equal(D.tip.aberto, false);
  k.focus(); assert.equal(D.tip.aberto, true); D.dispara('focusout', { target: k, relatedTarget: null }); assert.equal(D.tip.aberto, false);
  D.sobre(k); D.clique(k); assert.equal(D.tip.aberto, false, 'clique com a prévia aberta fecha (como antes)');
  D.clique(k); assert.equal(D.tip.aberto, true); assert.equal(D.tip.filhos.length, 0); assert.equal(D.tip.style.pointerEvents ?? '', '');
  assert.notEqual(D.doc.activeElement, undefined);
  D.rola(); assert.equal(D.tip.aberto, false, 'rolar esconde a prévia');
  D.tecla(k, 'Enter'); assert.equal(D.tip.filhos.length, 0, 'Enter não fixa quem não tem destino');
});

test('Ler mais (etapa 11): sem os capítulos carregados o link usa o próprio destino; destino malformado no HTML não vira link', () => {
  const D = montarDicas({ capitulos: false }); const k = D.icone('conexoes.amazon'); D.clique(k);
  assert.equal(D.tip.filhos[0].textContent, 'Ler mais: conexoes/amazon →');
  for (const ruim of ['', 'javascript:alert(1)', '../x/y', 'a/b/c', 'A/B', 'a"b/c', 'a/b" onmouseover="x']) {
    const D2 = montarDicas({ capitulos: false }); const k2 = D2.icone('regras'); k2.dataset.docs = ruim; D2.clique(k2);
    assert.equal(D2.tip.filhos.length, 0, `destino ${JSON.stringify(ruim)}: sem link`);
  }
  assert.doesNotMatch(fonte('ajuda.js'), /innerHTML\s*=/, 'a dica nunca recebe HTML');
});

test('nenhum teste deste arquivo acessou a rede', () => {
  assert.equal(acessosRede, 0);
});
