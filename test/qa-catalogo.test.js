// QA, fonte "catalogo" (API de ofertas do Etiqueta), rodada 1 (03/11/2026). Ponta a ponta pelo servidor de verdade:
// criarServicos + buildApp em porta aleatória, WhatsApp em dryRun (wa.simulated), extensão simulada por links.poll/submit
// (e, num teste, pelas rotas HTTP /api/ext/poll e /api/ext/result), Etiqueta FALSO em HTTP numa porta aleatória, no
// formato do contrato v1, e token FALSO num arquivo de pasta temporária.
// Não duplica test/catalogo*.test.js (unidade e integração dos devs): aqui o foco é a volta inteira
// (regra → tick → envio/revisão → "Enviar"), as bordas entre as peças, os vazamentos e as permissões.
// Rede: o fetch global só alcança as portas dos servidores do teste; qualquer outro destino (inclusive
// localhost:8765, o Etiqueta de verdade) lança e é contado; o último teste exige zero. Nunca a porta 3737 nem data/.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db.js';
import { buildApp, criarServicos } from '../src/server.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createLinkService } from '../src/links.js';
import { filtroDe, motivosDeRevisao, paraCandidato } from '../src/catalogo.js';
import { precoSuspeito } from '../src/catalogo-itens.js';
import { imagemPermitida } from '../src/lojas.js';
import { IMAGEM_PERMITIDA } from '../src/ml.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ------------------------------------------------------------------------------- rede só para os servidores do teste
const fetchOriginal = globalThis.fetch;
const portasLiberadas = new Set();
let chamadasBloqueadas = 0;
const fetchFiltrado = async (url, init) => {
  const u = new URL(String(url));
  if (u.hostname === '127.0.0.1' && portasLiberadas.has(u.port)) return fetchOriginal(url, init);
  chamadasBloqueadas++;
  throw new Error('rede proibida no teste');
};
globalThis.fetch = fetchFiltrado;

const pastas = [];
const tmp = (nome = 'x') => { const p = fs.mkdtempSync(path.join(os.tmpdir(), `disp-qacat-${nome}-`)); pastas.push(p); return p; };
after(() => { globalThis.fetch = fetchOriginal; for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });

// ------------------------------------------------------------------------------------------------------------ dados
const TOKEN = `tkFALSO_${randomBytes(30).toString('base64url')}`;
const TAG_AMAZON = 'achadinho-20';
const GRUPO = '111@g.us';
const asin = (i) => `B0${String(i).padStart(8, '0')}`;
const mlb = (i) => `MLB${4000000000 + i}`;
const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** Oferta no formato do contrato v1. O link do ML e o da Amazon são de terceiros: nunca podem sair. */
function oferta(i, loja = 'amazon', mais = {}) {
  const base = {
    id: i, loja, categoria: 'Casa e Decoração', busca: '', titulo: `Produto ${i}`, preco: 100 + i, preco_antigo: 200 + i,
    desconto_pct: 50, vendas: 10, avaliacao: 4.5, num_avaliacoes: 3, frete_gratis: true, cupom: '',
    criado_em: '2026-11-03T12:00:00', atualizado_em: '2026-11-03T12:00:00', genero: 'sem',
  };
  if (loja === 'amazon') Object.assign(base, { item_id: asin(i), link: `https://www.amazon.com.br/dp/${asin(i)}?tag=terceiro-20`, imagem: `https://m.media-amazon.com/images/I/${i}.jpg` });
  if (loja === 'ml') Object.assign(base, { item_id: mlb(i), link: 'https://meli.la/TerCeiro1', imagem: `https://http2.mlstatic.com/D_${i}.jpg` });
  if (loja === 'shopee') Object.assign(base, { item_id: `123.${i}`, link: `https://s.shopee.com.br/Ab${i}cd`, imagem: `https://down-br.img.susercontent.com/file/${i}`, preco_antigo: null, desconto_pct: 0 });
  base.chave = `${loja}:${base.item_id}`;
  return { ...base, ...mais };
}

/**
 * Etiqueta falso (regras do contrato v1). `estado`: ofertas (a ordem do array é a de atualização), modo
 * ('ok' | 401 | 503 | 500 | 'json-ruim' | 'html' | 'versao-2' | 'cai' | 'redireciona'), recusarCursor (o cursor que ele recusa), atraso (ms),
 * categorias (resposta de /categorias), destinoRedirect. Guarda cada pedido em estado.pedidos e mede a
 * concorrência (estado.maxSimultaneos).
 */
async function etiqueta(estado) {
  estado.ofertas ??= []; estado.pedidos = []; estado.modo ??= 'ok'; estado.emAndamento = 0; estado.maxSimultaneos = 0;
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    estado.pedidos.push({ rota: u.pathname, url: req.url, params: [...u.searchParams], headers: { ...req.headers } });
    estado.emAndamento++; estado.maxSimultaneos = Math.max(estado.maxSimultaneos, estado.emAndamento);
    try {
      if (estado.atraso) await esperar(estado.atraso);
      const responder = (status, corpo, tipo = 'application/json; charset=utf-8') => {
        res.writeHead(status, { 'content-type': tipo });
        res.end(typeof corpo === 'string' ? corpo : JSON.stringify(corpo));
      };
      if (estado.modo === 'cai') return void req.socket.destroy();
      if (estado.modo === 'redireciona') { res.writeHead(302, { location: `${estado.destinoRedirect}${req.url}` }); return void res.end(); }
      if (estado.modo === 503) return responder(503, { error: 'a API v1 está desligada' });
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return responder(401, { error: 'token ausente ou inválido' });
      if (estado.modo === 401) return responder(401, { error: 'token ausente ou inválido' });
      if (estado.modo === 500) return responder(500, { error: 'erro interno na API v1' });
      if (estado.modo === 'json-ruim') return responder(200, '{"versao":1,"ofertas":[');
      if (estado.modo === 'html') return responder(200, '<html><body>captive portal</body></html>', 'text/html');
      if (u.pathname === '/api/v1/categorias') {
        if (estado.modo === 'versao-2') return responder(200, { versao: 2, categorias: [] });
        return responder(200, estado.categorias ?? { versao: 1, categorias: [{ nome: 'Casa e Decoração', total: estado.ofertas.length, lojas: { amazon: 1, ml: 1, shopee: 0 }, generos: { sem: 1 } }], total: estado.ofertas.length });
      }
      if (u.pathname !== '/api/v1/ofertas') return responder(404, { error: 'rota não encontrada' });
      if (estado.modo === 'versao-2') return responder(200, { versao: 2, ofertas: [], proximo: null });
      const limite = Number(u.searchParams.get('limite') ?? 50);
      const ordem = u.searchParams.get('ordem') ?? 'atualizacao';
      const cursor = u.searchParams.get('cursor');
      let inicio = 0;
      if (cursor != null) {
        const m = ordem === 'atualizacao' ? /^c(\d+)$/.exec(cursor) : /^(\d+)$/.exec(cursor);
        if (!m || (ordem === 'atualizacao' && estado.recusarCursor === cursor)) return responder(400, { error: 'cursor inválido' });
        inicio = Number(m[1]);
      }
      const lojas = u.searchParams.getAll('loja');
      const cats = u.searchParams.getAll('cat');
      let todas = estado.ofertas;
      if (lojas.length) todas = todas.filter((o) => lojas.includes(o.loja));
      if (cats.length) todas = todas.filter((o) => cats.includes(o.categoria));
      const pagina = todas.slice(inicio, inicio + limite);
      const fim = inicio + pagina.length;
      const proximo = ordem === 'atualizacao' ? (pagina.length ? `c${fim}` : null) : (fim < todas.length ? String(fim) : null);
      return responder(200, { versao: 1, ofertas: pagina, proximo, total: todas.length });
    } finally { estado.emAndamento--; }
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const porta = String(srv.address().port);
  portasLiberadas.add(porta);
  return { porta, endereco: `http://127.0.0.1:${porta}`, fechar: () => new Promise((ok) => { srv.closeAllConnections?.(); srv.close(ok); }) };
}

function pedir(port, metodo, caminho, corpo, headers = {}) {
  return new Promise((ok, err) => {
    const data = corpo == null ? null : Buffer.from(JSON.stringify(corpo));
    const h = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers };
    const r = http.request({ host: '127.0.0.1', port, path: caminho, method: metodo, headers: h }, (res) => {
      let txt = ''; res.setEncoding('utf8'); res.on('data', (c) => { txt += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(txt); } catch { /* html */ } ok({ status: res.statusCode, headers: res.headers, txt, json }); });
    });
    r.on('error', err); if (data) r.write(data); r.end();
  });
}

/**
 * Servidor como o main monta (criarServicos + buildApp), com o Etiqueta falso e o token falso num arquivo.
 * modo: modo do serviço de links ('extension' | 'direct' | 'fake'), mutável em s.ctl.modo. tag: tag da Amazon
 * salva (pelo PUT real de Conexões); '' = sem tag. conectar: salva endereço e caminho do token pelo PUT real.
 */
async function montar(t, { modo = 'extension', tag = TAG_AMAZON, ofertas = [], conectar = true, estado = {} } = {}) {
  const dir = tmp('srv');
  const db = openDb(dir);
  db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(GRUPO, 'Achadinhos', 10, Date.now());
  db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etiquetaA', Date.now());
  const wa = createWhatsApp({ db, dir, dryRun: true }); await wa.connect();
  const ctl = { modo };
  const links = createLinkService({ getMode: () => ctl.modo });
  const et = { ofertas, ...estado };
  const srvEt = await etiqueta(et);
  const { amazon, shopee, catalogo, catalogoItens, scheduler } = criarServicos({ db, wa, links, fast: true, dir, fetch: fetchFiltrado });
  const app = buildApp({ db, wa, links, scheduler, amazon, shopee, catalogo, catalogoItens, publicHost: '', panelPassword: '', dataDir: dir });
  const server = await new Promise((ok) => { const x = app.listen(0, '127.0.0.1', () => ok(x)); });
  const port = server.address().port;
  const caminhoToken = path.join(tmp('token'), 'api_token.txt');
  fs.writeFileSync(caminhoToken, `${TOKEN}\n`, { mode: 0o600 });
  const s = {
    dir, db, wa, links, scheduler, catalogo, catalogoItens, ctl, et, srvEt, port, caminhoToken,
    get: (c, h) => pedir(port, 'GET', c, null, h), post: (c, b, h) => pedir(port, 'POST', c, b, h),
    put: (c, b, h) => pedir(port, 'PUT', c, b, h), del: (c, h) => pedir(port, 'DELETE', c, null, h),
    msgs: () => wa.simulated.filter((m) => m.jid === GRUPO),
    textos: () => wa.simulated.map((m) => m.text),
    conectar: async () => {
      const r = await pedir(port, 'PUT', '/api/conexoes/catalogo', { campos: { endereco: srvEt.endereco, caminho_token: caminhoToken } });
      assert.equal(r.status, 200, r.txt); return r;
    },
    salvarTag: async (v = TAG_AMAZON) => {
      const r = await pedir(port, 'PUT', '/api/conexoes/amazon', { campos: { tag: v } });
      assert.equal(r.status, 200, r.txt); return r;
    },
    /** Cria a regra pelo POST real (a mesma validação do painel). */
    regra: async (corpo = {}) => {
      const b = {
        name: 'Catálogo', enabled: true, tag_id: 1, template_id: 1, group_jids: [GRUPO], per_run: 3, interval_min: 60,
        window_start: '00:00', window_end: '23:59', dedupe_days: 7, send_image: true,
        sources: [{ type: 'catalogo', tag_id: null, config: { ordem: 'relevancia' } }], ...corpo,
      };
      const r = await pedir(port, 'POST', '/api/rules', b);
      assert.equal(r.status, 200, r.txt); return r.json.id;
    },
    fechar: async () => { server.closeAllConnections?.(); await new Promise((ok) => server.close(ok)); await srvEt.fechar(); db.close(); },
  };
  t.after(s.fechar);
  if (conectar) await s.conectar();
  if (tag) await s.salvarTag(tag);
  return s;
}

/** Extensão de mentira: pergunta por pedidos (isso a mantém on-line) e responde por `tratar(job)` → { ok, link, error }. */
function extensao(s, tratar) {
  let n = 0;
  const e = { jobs: [], ativa: true };
  const padrao = () => ({ ok: true, link: `https://meli.la/Ext${String(++n).padStart(5, '0')}` });
  e.fim = (async () => {
    while (e.ativa) {
      const job = await s.links.poll(0);
      if (job) { e.jobs.push(job); s.links.submit(job.id, await (tratar ?? padrao)(job, e.jobs.length)); } else await esperar(5);
    }
  })();
  e.parar = async () => { e.ativa = false; await e.fim; };
  return e;
}

const itens = (db, ruleId) => db.prepare('SELECT chave, loja, status, motivos FROM catalogo_itens WHERE rule_id = ? ORDER BY id').all(ruleId)
  .map((l) => ({ chave: l.chave, loja: l.loja, status: l.status, motivos: JSON.parse(l.motivos) }));
const itemDe = (db, ruleId, chave) => itens(db, ruleId).find((i) => i.chave === chave);
const enviadas = (db, ruleId) => db.prepare('SELECT offer_key FROM sent_offers WHERE rule_id = ? ORDER BY id').all(ruleId).map((l) => l.offer_key);
const cursor = (db, ruleId, cfg) => {
  const l = db.prepare('SELECT cursor, pronto FROM catalogo_cursores WHERE rule_id = ? AND filtro = ?').get(ruleId, filtroDe(cfg));
  return l ? { cursor: l.cursor, pronto: l.pronto } : null;
};
const logs = (db, ruleId) => db.prepare('SELECT level, message, offer_title, rule_name FROM log WHERE rule_id = ? ORDER BY id').all(ruleId).map((l) => ({ ...l }));
const contar = (db, sql, ...a) => db.prepare(sql).get(...a).n;
/** Espera o envio da fila (a revisão) sair de pendente/enviando, por iterações (não pelo relógio). */
async function assentar(s) {
  for (let i = 0; i < 400 && contar(s.db, "SELECT COUNT(*) AS n FROM envios WHERE status IN ('pendente','enviando')"); i++) await esperar(10);
  assert.equal(contar(s.db, "SELECT COUNT(*) AS n FROM envios WHERE status IN ('pendente','enviando')"), 0, 'envio não terminou');
}

const capturarSaidas = (t) => {
  const espias = ['error', 'warn', 'log', 'info', 'debug'].map((m) => t.mock.method(console, m, () => {}));
  const saidas = [];
  for (const fluxo of [process.stdout, process.stderr]) {
    const original = fluxo.write.bind(fluxo);
    t.mock.method(fluxo, 'write', (c, ...a) => { saidas.push(String(c)); return original(c, ...a); });
  }
  return () => [...espias.flatMap((e) => e.mock.calls.map((c) => c.arguments.map(String).join(' '))), ...saidas].join('\n');
};

/** Todas as tabelas, todas as colunas (inclusive settings e a coluna segredos de conexoes). */
function bancoInteiro(db) {
  const nomes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
  return nomes.map((nome) => `${nome}: ${JSON.stringify(db.prepare(`SELECT * FROM "${nome}"`).all())}`).join('\n');
}

// ======================================================================================== CA1, CA4, CA5, CA7: volta inteira

test('CA1/CA4/CA5/CA7: ML, Amazon, Shopee, 100%, preço antigo 10× e falha de link, pelo servidor real', async (t) => {
  const falha = mlb(7);
  const s = await montar(t, {
    ofertas: [
      oferta(1, 'ml'), oferta(2, 'amazon'),
      oferta(3, 'amazon', { imagem: 'https://http2.mlstatic.com/D_3.jpg' }), // foto do CDN de outra loja
      oferta(4, 'shopee'),
      oferta(5, 'amazon', { preco: 1, preco_antigo: 1000, desconto_pct: 100 }),
      oferta(6, 'ml', { preco: 20, preco_antigo: 200, desconto_pct: 90 }),
      oferta(7, 'ml'), oferta(8, 'amazon', { cupom: 'VOLTA10' }),
    ],
  });
  const ext = extensao(s, (job) => (job.url.includes(falha.slice(3)) ? { ok: false, error: 'a Central não aceitou o produto' } : { ok: true, link: `https://meli.la/Ext${job.id}` }));
  t.after(() => ext.parar());
  const id = await s.regra({ per_run: 20 });

  const r = await s.scheduler.runRule(id);
  // a falha do link do ML é pulada, sem revisão (rodar-sozinho entrega 2, CA2.1)
  assert.deepEqual([r.offers, r.messages, r.errors, r.revisao, r.puladas], [4, 4, 0, 3, 1], JSON.stringify(logs(s.db, id)));

  const msgs = s.msgs();
  assert.equal(msgs.length, 4);
  const ml1 = msgs.find((m) => m.text.includes('Produto 1')); const am2 = msgs.find((m) => m.text.includes('Produto 2'));
  const am3 = msgs.find((m) => m.text.includes('Produto 3')); const am8 = msgs.find((m) => m.text.includes('Produto 8'));
  assert.match(ml1.text, /https:\/\/meli\.la\/Ext\d+/, 'ML: meli.la gerado pela extensão com a etiqueta do dono');
  assert.ok(am2.text.includes(`https://www.amazon.com.br/dp/${asin(2)}?tag=${TAG_AMAZON}`), 'Amazon: remontada com a tag de Conexões');
  assert.ok(am8.text.includes(`https://www.amazon.com.br/dp/${asin(8)}?tag=${TAG_AMAZON}`));
  assert.equal(ml1.tipo, 'image'); assert.equal(ml1.image, 'https://http2.mlstatic.com/D_1.jpg');
  assert.equal(am2.tipo, 'image'); assert.equal(am2.image, 'https://m.media-amazon.com/images/I/2.jpg');
  assert.equal(am3.tipo, 'text', 'foto do CDN de outra loja: sai só o texto');
  for (const m of msgs) {
    assert.ok(!/terceiro-20|TerCeiro/.test(m.text), 'nenhum link do Etiqueta sai');
    assert.ok(!/100%/.test(m.text), 'nenhum "100%" sai sem revisão');
  }
  // o que a extensão recebeu: a página do produto remontada e a etiqueta do dono
  assert.deepEqual(ext.jobs.map((j) => [j.type, j.tag]).filter((x, i, a) => a.findIndex((y) => y[0] === x[0] && y[1] === x[1]) === i), [['link', 'etiquetaA']]);
  assert.ok(ext.jobs.every((j) => /^https:\/\/produto\.mercadolivre\.com\.br\/MLB-4000000\d{3}$/.test(j.url)), JSON.stringify(ext.jobs.map((j) => j.url)));

  assert.deepEqual(itens(s.db, id).map((i) => [i.chave, i.status, i.motivos]), [
    [mlb(1), 'enviado', []], [`ASIN:${asin(2)}`, 'enviado', []], [`ASIN:${asin(3)}`, 'enviado', []],
    ['SHOPEE:123.4', 'revisao', ['shopee']], [`ASIN:${asin(5)}`, 'revisao', ['desconto_100', 'preco_antigo']],
    [mlb(6), 'revisao', ['preco_antigo']], [`ASIN:${asin(8)}`, 'enviado', []],
  ]);
  assert.ok(logs(s.db, id).some((l) => l.message === 'Pulada: não deu para gerar o link de afiliado (a Central de Afiliados não respondeu). Tenta de novo no próximo envio.'));
  assert.deepEqual(enviadas(s.db, id), [mlb(1), `ASIN:${asin(2)}`, `ASIN:${asin(3)}`, `ASIN:${asin(8)}`], 'só o que saiu entra em sent_offers');
  assert.equal(contar(s.db, 'SELECT COUNT(*) AS n FROM envios'), 0, 'a revisão não cria envio sozinha');

  // a lista do painel (Dono): 3 para revisar, link para conferir por loja, foto só do CDN
  const rev = await s.get(`/api/catalogo/itens?regra=${id}&status=revisao`);
  assert.equal(rev.status, 200);
  assert.equal(rev.json.itens.length, 3);
  const shp = rev.json.itens.find((i) => i.loja === 'shopee');
  assert.equal(shp.oferta.link, 'https://s.shopee.com.br/Ab4cd');
  assert.equal(shp.oferta.image, 'https://down-br.img.susercontent.com/file/4');
  assert.equal(rev.json.itens.find((i) => i.loja === 'amazon').oferta.link, `https://www.amazon.com.br/dp/${asin(5)}`, 'Amazon sem tag na tela');
  assert.equal(rev.json.contadores_24h.para_revisar, 3);

  // o pedido ao Etiqueta: limite=200, a ordem da fonte, só Authorization (sem Origin, sem token na URL)
  const p = s.et.pedidos[0];
  assert.deepEqual(p.params, [['ordem', 'relevancia'], ['limite', '200']]);
  assert.equal(p.headers.origin, undefined);
  assert.ok(!p.url.includes(TOKEN));

  // repetir a regra não repete nada nem duplica a fila; só a do link que falhou é tentada de novo (2ª falha dela)
  const r2 = await s.scheduler.runRule(id);
  assert.equal(r2.offers, 0); assert.equal(s.msgs().length, 4);
  assert.equal(itens(s.db, id).length, 7);
  assert.deepEqual(logs(s.db, id).slice(-2).map((l) => l.message), [
    'Pulada: não deu para gerar o link de afiliado (a Central de Afiliados não respondeu). Tenta de novo no próximo envio. É a 2ª vez que falha; na 3ª ela vai para a revisão.',
    'Saíram 0 de 20 ofertas; 1 pulada (Central sem resposta); não havia mais ofertas novas dentro dos filtros.',
  ]);
});

test('CA4: o link do ML da regra vem da extensão pelas rotas HTTP /api/ext/poll e /api/ext/result (a volta de verdade)', async (t) => {
  const s = await montar(t, { ofertas: [oferta(1, 'ml')] });
  const tokenExt = s.db.prepare("SELECT value FROM settings WHERE key = 'ext_token'").get().value;
  const id = await s.regra({ per_run: 1 });
  // o poll fica pendurado; o pedido de link chega por ele e a resposta volta por /result
  const poll = pedir(s.port, 'GET', '/api/ext/poll', null, { 'x-token': tokenExt });
  await esperar(30); // o poll registrado marca a extensão como on-line
  const rodando = s.scheduler.runRule(id);
  const { json } = await poll;
  assert.equal(json.job.type, 'link');
  assert.equal(json.job.tag, 'etiquetaA');
  assert.equal(json.job.url, `https://produto.mercadolivre.com.br/MLB-${mlb(1).slice(3)}`);
  const res = await pedir(s.port, 'POST', '/api/ext/result', { id: json.job.id, ok: true, link: 'https://meli.la/ViaHttp1' }, { 'x-token': tokenExt });
  assert.equal(res.json.ok, true);
  const r = await rodando;
  assert.deepEqual([r.offers, r.messages, r.errors], [1, 1, 0]);
  assert.ok(s.textos()[0].includes('https://meli.la/ViaHttp1'));
});

test('CA4/CA5: foto de fora do CDN da loja nunca sai, nem na regra nem na lista da revisão (hosts parecidos, http, outro CDN)', async (t) => {
  const hostis = [
    'http://m.media-amazon.com/images/I/a.jpg', 'https://m.media-amazon.com.evil.example/a.jpg', 'https://evil.example/m.media-amazon.com/a.jpg',
    'https://m.media-amazon.com@evil.example/a.jpg', 'https://http2.mlstatic.com/a.jpg', 'https://down-br.img.susercontent.com/a',
    'javascript:alert(1)', 'data:image/png;base64,AAAA', '//m.media-amazon.com/a.jpg', 'https://evilm.media-amazon.com.br/a.jpg',
  ];
  const s = await montar(t, {
    ofertas: [...hostis.map((img, i) => oferta(10 + i, 'amazon', { imagem: img })), oferta(30, 'amazon', { imagem: 'https://m.media-amazon.com/images/I/ok.jpg' }),
      ...hostis.slice(0, 4).map((img, i) => oferta(40 + i, 'shopee', { imagem: img })), oferta(50, 'shopee')],
  });
  const id = await s.regra({ per_run: 20 });
  // a Shopee vai à revisão (até 20 por envio): o limite por envio é 20, então rodamos mais de uma vez
  for (let i = 0; i < 4; i++) await s.scheduler.runRule(id);
  const imagens = s.wa.simulated.filter((m) => m.tipo === 'image').map((m) => m.image);
  assert.deepEqual(imagens, ['https://m.media-amazon.com/images/I/ok.jpg'], 'só a foto do CDN da Amazon sai');
  assert.equal(s.msgs().length, 11, 'as outras 10 saem só com texto');
  const rev = await s.get(`/api/catalogo/itens?regra=${id}&status=revisao&limite=200`);
  const shopee = rev.json.itens.filter((i) => i.loja === 'shopee');
  assert.equal(shopee.length, 5);
  assert.deepEqual(shopee.map((i) => i.oferta.image).filter(Boolean), ['https://down-br.img.susercontent.com/file/50']);
});

// ============================================================================================ CA3: leitura sem fome

test('Q4: ofertas que esperam (extensão desligada) nas primeiras 200 não impedem a Amazon de sair', async (t) => {
  // 200 do ML (esperam a extensão) na frente e 3 da Amazon logo depois: a Amazon não depende da extensão
  const ml = Array.from({ length: 200 }, (_, i) => oferta(1000 + i, 'ml'));
  const s = await montar(t, { ofertas: [...ml, oferta(1, 'amazon'), oferta(2, 'amazon'), oferta(3, 'amazon')] });
  const id = await s.regra({ per_run: 3 });
  await s.scheduler.runRule(id);
  assert.deepEqual(enviadas(s.db, id), [`ASIN:${asin(1)}`, `ASIN:${asin(2)}`, `ASIN:${asin(3)}`], JSON.stringify(logs(s.db, id)));
});

test('Q4 (Novidades, a ordem padrão): 200 novidades do ML esperando a extensão não impedem as da Amazon que vêm depois de sair', async (t) => {
  const s = await montar(t, { ofertas: [oferta(900, 'amazon')] });
  const id = await s.regra({ tag_id: 1, per_run: 3, dedupe_days: 0, sources: [{ type: 'catalogo', tag_id: null, config: {} }] });
  await s.scheduler.runRule(id); // primeira leitura: vai ao fim
  s.et.ofertas.push(...Array.from({ length: 200 }, (_, i) => oferta(1000 + i, 'ml')), oferta(1, 'amazon'), oferta(2, 'amazon'));
  await s.scheduler.runRule(id);
  assert.deepEqual(enviadas(s.db, id), [`ASIN:${asin(1)}`, `ASIN:${asin(2)}`], JSON.stringify(logs(s.db, id)));
});

test('Q5: o filtro de preço mínimo da regra não prende a leitura nas primeiras 200 recusadas', async (t) => {
  // 200 baratas na frente (recusadas pelo preço mínimo da regra) e 3 caras depois
  const baratas = Array.from({ length: 200 }, (_, i) => oferta(1000 + i, 'amazon', { preco: 10, preco_antigo: 20, desconto_pct: 50 }));
  const s = await montar(t, { ofertas: [...baratas, oferta(1, 'amazon', { preco: 300 }), oferta(2, 'amazon', { preco: 300 }), oferta(3, 'amazon', { preco: 300 })] });
  const id = await s.regra({ per_run: 3, min_price: 100, tag_id: null, sources: [{ type: 'catalogo', tag_id: null, config: { ordem: 'relevancia', lojas: ['amazon'] } }] });
  await s.scheduler.runRule(id);
  assert.deepEqual(enviadas(s.db, id), [`ASIN:${asin(1)}`, `ASIN:${asin(2)}`, `ASIN:${asin(3)}`], JSON.stringify(logs(s.db, id)));
});

test('Q6: preço antigo exatamente 10× o preço vai à revisão também nos centavos que o ponto flutuante arredonda (R$ 0,33 e R$ 3,30)', () => {
  // 0,33 × 10 = 3,3000000000000003 em ponto flutuante: 3,30 "<" 10 × 0,33 e a oferta escapava da revisão
  assert.deepEqual(motivosDeRevisao({ loja: 'amazon', price: 0.33, oldPrice: 3.3, discountPct: 90 }), ['preco_antigo']);
  assert.equal(precoSuspeito({ price: 0.33, oldPrice: 3.3, discountPct: 90 }), true);
});

// ============================================================================================ "Enviar" da revisão

/** Roda a regra uma vez e devolve o id do item (catalogo_itens) da chave. */
const idDoItem = (db, ruleId, chave) => db.prepare('SELECT id FROM catalogo_itens WHERE rule_id = ? AND chave = ?').get(ruleId, chave).id;

test('CA4/CA7: "Enviar" da revisão — Shopee sai com o link do catálogo pela fila; uma vez só; 409 depois; log "Catálogo: <regra>"', async (t) => {
  const s = await montar(t, { ofertas: [oferta(4, 'shopee', { cupom: 'SHOP5' })] });
  const id = await s.regra({ name: 'Ofertas Tech', per_run: 3 });
  await s.scheduler.runRule(id);
  const item = idDoItem(s.db, id, 'SHOPEE:123.4');
  assert.equal(s.msgs().length, 0, 'a Shopee nunca sai sozinha');

  const r = await s.post(`/api/catalogo/itens/${item}/enviar`, {});
  assert.equal(r.status, 200, r.txt);
  assert.ok(Number.isInteger(r.json.envio_id));
  await assentar(s);
  assert.equal(s.msgs().length, 1);
  assert.ok(s.msgs()[0].text.includes('https://s.shopee.com.br/Ab4cd'), 'sai o link de afiliado do catálogo');
  assert.equal(s.msgs()[0].tipo, 'image');
  assert.equal(s.msgs()[0].image, 'https://down-br.img.susercontent.com/file/4');
  assert.equal(itemDe(s.db, id, 'SHOPEE:123.4').status, 'enviado');
  assert.deepEqual(enviadas(s.db, id), ['SHOPEE:123.4']);
  const envio = s.db.prepare('SELECT * FROM envios WHERE id = ?').get(r.json.envio_id);
  assert.equal(envio.status, 'concluido');
  assert.deepEqual(JSON.parse(envio.payload).origem, { tipo: 'catalogo', rule_id: id, nome: 'Ofertas Tech' });
  const log = s.db.prepare("SELECT rule_name, level, message FROM log WHERE rule_name LIKE 'Catálogo:%' AND level = 'ok'").all();
  assert.ok(log.some((l) => l.rule_name === 'Catálogo: Ofertas Tech'), JSON.stringify(log));

  // repetição: 409 com a frase fixa, nada sai de novo; descartar o que já saiu também é 409
  const de_novo = await s.post(`/api/catalogo/itens/${item}/enviar`, {});
  assert.deepEqual([de_novo.status, de_novo.json.erro], [409, 'Esta oferta já foi tratada.']);
  const desc = await s.post(`/api/catalogo/itens/${item}/descartar`);
  assert.equal(desc.status, 409);
  await assentar(s);
  assert.equal(s.msgs().length, 1);
  // e a regra não a reenvia (Novidades ou não)
  await s.scheduler.runRule(id);
  assert.equal(s.msgs().length, 1);
});

test('CA7/P4: 100% e preço antigo 10× só saem com o preço corrigido à mão; dois "Enviar" juntos geram um envio só', async (t) => {
  const s = await montar(t, { ofertas: [oferta(5, 'amazon', { preco: 1, preco_antigo: 1000, desconto_pct: 100 })] });
  const id = await s.regra({ per_run: 3 });
  await s.scheduler.runRule(id);
  const item = idDoItem(s.db, id, `ASIN:${asin(5)}`);

  const a = await s.post(`/api/catalogo/itens/${item}/enviar`, {});
  assert.deepEqual([a.status, a.json.erro], [400, 'Corrija o preço ou apague o preço antigo para enviar.']);
  const b = await s.post(`/api/catalogo/itens/${item}/enviar`, { ajustes: { price: 1, oldPrice: 1000 } });
  assert.equal(b.status, 400, 'o mesmo preço suspeito continua recusado');
  const c = await s.post(`/api/catalogo/itens/${item}/enviar`, { ajustes: { price: 'abc' } });
  assert.equal(c.status, 400);
  assert.equal(contar(s.db, 'SELECT COUNT(*) AS n FROM envios'), 0, 'nada gravado nas recusas');
  assert.equal(itemDe(s.db, id, `ASIN:${asin(5)}`).status, 'revisao');

  const [x, y] = await Promise.all([
    s.post(`/api/catalogo/itens/${item}/enviar`, { ajustes: { price: '400,00', oldPrice: '1.000,00' } }),
    s.post(`/api/catalogo/itens/${item}/enviar`, { ajustes: { price: '400,00', oldPrice: '1.000,00' } }),
  ]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
  await assentar(s);
  assert.equal(contar(s.db, 'SELECT COUNT(*) AS n FROM envios'), 1);
  assert.equal(s.msgs().length, 1);
  assert.ok(s.msgs()[0].text.includes(`https://www.amazon.com.br/dp/${asin(5)}?tag=${TAG_AMAZON}`));
  assert.ok(s.msgs()[0].text.includes('60%'), 'o desconto sai refeito dos preços corrigidos: ' + s.msgs()[0].text);
  assert.ok(!/100%/.test(s.msgs()[0].text));
  assert.equal(contar(s.db, "SELECT COUNT(*) AS n FROM sent_offers WHERE offer_key = ?", `ASIN:${asin(5)}`), 1);
});

test('CA4: "Enviar" de ML da revisão gera o link na hora pela extensão; modo direto e Amazon sem tag recusam e nada é gravado', async (t) => {
  // o ML vai à revisão pelo preço antigo de 10× (a falha do link não manda mais à revisão: rodar-sozinho entrega 2, CA2.1)
  const s = await montar(t, { ofertas: [oferta(7, 'ml', { preco: 20, preco_antigo: 200, desconto_pct: 90 }), oferta(8, 'amazon', { preco: 1, preco_antigo: 1000, desconto_pct: 100 })] });
  const ext = extensao(s, () => ({ ok: true, link: 'https://meli.la/Revisao1' }));
  t.after(() => ext.parar());
  const id = await s.regra({ per_run: 5 });
  await s.scheduler.runRule(id);
  assert.deepEqual(itens(s.db, id).map((i) => [i.chave, i.status, i.motivos]), [[mlb(7), 'revisao', ['preco_antigo']], [`ASIN:${asin(8)}`, 'revisao', ['desconto_100', 'preco_antigo']]]);
  assert.equal(ext.jobs.length, 0, 'a que vai à revisão não pede link');
  const ml = idDoItem(s.db, id, mlb(7)); const am = idDoItem(s.db, id, `ASIN:${asin(8)}`);
  const corrigido = { ajustes: { oldPrice: '30,00' } }; // o dono corrige o preço antigo

  // modo direto: link comum (sem comissão) nunca sai
  s.ctl.modo = 'direct';
  const d = await s.post(`/api/catalogo/itens/${ml}/enviar`, corrigido);
  assert.equal(d.status, 400); assert.match(d.json.erro, /modo direto/);
  assert.equal(itemDe(s.db, id, mlb(7)).status, 'revisao');
  assert.equal(contar(s.db, 'SELECT COUNT(*) AS n FROM envios'), 0);
  // de volta à extensão: o link é gerado na hora e a oferta sai
  s.ctl.modo = 'extension';
  const ok = await s.post(`/api/catalogo/itens/${ml}/enviar`, corrigido);
  assert.equal(ok.status, 200, ok.txt);
  await assentar(s);
  assert.ok(s.textos().some((x) => x.includes('https://meli.la/Revisao1')));
  // Amazon sem tag salva
  s.db.prepare("DELETE FROM conexoes WHERE plataforma = 'amazon'").run();
  const semTag = await s.post(`/api/catalogo/itens/${am}/enviar`, { ajustes: { price: '400', oldPrice: '1000' } });
  assert.equal(semTag.status, 400); assert.match(semTag.json.erro, /tag de associado/);
  assert.equal(itemDe(s.db, id, `ASIN:${asin(8)}`).status, 'revisao');
  assert.ok(s.textos().every((x) => !x.includes('mercadolivre.com.br/MLB')), 'nenhum link comum do ML saiu');
});

// ================================================================================================ CA3: cursor (Novidades)

const NOVIDADES = { lojas: ['amazon'] }; // ordem padrão: atualizacao
const regraNovidades = (s, extra = {}) => s.regra({ tag_id: null, per_run: 5, dedupe_days: 0, sources: [{ type: 'catalogo', tag_id: null, config: NOVIDADES }], ...extra });

test('CA3: Novidades pelo servidor — a primeira leitura não envia; vazio com proximo:null mantém o cursor; o que entra depois sai uma vez só', async (t) => {
  const s = await montar(t, { ofertas: [oferta(1), oferta(2), oferta(3)] });
  const id = await regraNovidades(s);

  const r1 = await s.scheduler.runRule(id);
  assert.equal(r1.offers, 0, 'a primeira leitura não despeja o catálogo antigo');
  assert.deepEqual(cursor(s.db, id, NOVIDADES), { cursor: 'c3', pronto: 1 });
  assert.equal(s.wa.simulated.length, 0);

  // nada novo: a leitura volta vazia (proximo null) e o cursor guardado continua valendo
  const pedidosAntes = s.et.pedidos.length;
  for (let i = 0; i < 2; i++) await s.scheduler.runRule(id);
  assert.deepEqual(cursor(s.db, id, NOVIDADES), { cursor: 'c3', pronto: 1 });
  const ultimo = s.et.pedidos.at(-1);
  assert.deepEqual(ultimo.params.filter(([k]) => k === 'cursor'), [['cursor', 'c3']], 'a leitura parte do cursor guardado');
  assert.equal(s.et.pedidos.length - pedidosAntes, 2, 'um pedido por execução, nunca em paralelo');
  assert.equal(s.wa.simulated.length, 0);

  s.et.ofertas.push(oferta(4), oferta(5));
  const r3 = await s.scheduler.runRule(id);
  assert.equal(r3.offers, 2);
  assert.deepEqual(enviadas(s.db, id), [`ASIN:${asin(4)}`, `ASIN:${asin(5)}`]);
  assert.deepEqual(cursor(s.db, id, NOVIDADES), { cursor: 'c5', pronto: 1 });
  const r4 = await s.scheduler.runRule(id);
  assert.equal(r4.offers, 0);
  assert.equal(s.wa.simulated.length, 2, 'mesmo com "dias sem repetir" = 0 a oferta tratada não volta em Novidades');
});

test('CA3: com mais novidades que o "por envio", nada se perde: o cursor só passa da página inteira tratada', async (t) => {
  const s = await montar(t, { ofertas: [oferta(1)] });
  const id = await regraNovidades(s, { per_run: 2 });
  await s.scheduler.runRule(id); // primeira leitura: fim
  for (let i = 2; i <= 6; i++) s.et.ofertas.push(oferta(i));
  const enviadasPor = [];
  for (let i = 0; i < 3; i++) { await s.scheduler.runRule(id); enviadasPor.push(enviadas(s.db, id).length); }
  assert.deepEqual(enviadasPor, [2, 4, 5], 'cinco novidades, duas por execução');
  assert.deepEqual(enviadas(s.db, id), [2, 3, 4, 5, 6].map((i) => `ASIN:${asin(i)}`));
  assert.equal(cursor(s.db, id, NOVIDADES).cursor, 'c6');
});

test('CA3: cursor recusado pelo Etiqueta (400): não envia, avisa, recomeça do fim; o que chegar depois sai', async (t) => {
  const s = await montar(t, { ofertas: [oferta(1), oferta(2)] });
  const id = await regraNovidades(s);
  await s.scheduler.runRule(id);
  s.et.ofertas.push(oferta(3));
  s.et.recusarCursor = 'c2'; // o Etiqueta passou a recusar o cursor guardado (ex.: banco refeito)
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.errors], [0, 0]);
  assert.ok(logs(s.db, id).some((l) => l.level === 'aviso' && /cursor salvo foi recusado/.test(l.message)), JSON.stringify(logs(s.db, id)));
  assert.equal(s.wa.simulated.length, 0);
  s.et.recusarCursor = null;
  s.et.ofertas.push(oferta(4));
  await s.scheduler.runRule(id);
  assert.deepEqual(enviadas(s.db, id), [`ASIN:${asin(4)}`]);
});

test('CA3: "Reler do começo" (só o Dono) varre do zero e deduplica pela chave; 404 e 409 nas bordas', async (t) => {
  const s = await montar(t, { ofertas: [oferta(1), oferta(2), oferta(3)] });
  const id = await regraNovidades(s, { per_run: 20 });
  await s.scheduler.runRule(id);
  s.et.ofertas.push(oferta(4));
  await s.scheduler.runRule(id);
  assert.deepEqual(enviadas(s.db, id), [`ASIN:${asin(4)}`]);

  assert.equal((await s.post('/api/rules/9999/catalogo/recomecar')).status, 404);
  assert.equal((await s.post('/api/rules/abc/catalogo/recomecar')).status, 404);
  const r = await s.post(`/api/rules/${id}/catalogo/recomecar`);
  assert.deepEqual([r.status, r.json.ok, r.json.fontes], [200, true, 1]);
  assert.deepEqual(cursor(s.db, id, NOVIDADES), { cursor: null, pronto: 1 });
  await s.scheduler.runRule(id);
  assert.deepEqual(enviadas(s.db, id), [4, 1, 2, 3].map((i) => `ASIN:${asin(i)}`), 'varreu do zero; o 4 (já enviado) não repete');
  assert.equal(s.msgs().length, 4);
  assert.equal(cursor(s.db, id, NOVIDADES).cursor, 'c4');

  // com a regra rodando, a recusa é 409 e o cursor não muda
  s.et.atraso = 150;
  const rodando = s.scheduler.runRule(id);
  await esperar(30);
  assert.equal(s.scheduler.isRunning(id), true);
  const ocupado = await s.post(`/api/rules/${id}/catalogo/recomecar`);
  assert.equal(ocupado.status, 409);
  await rodando;
  assert.deepEqual(cursor(s.db, id, NOVIDADES), { cursor: 'c4', pronto: 1 });
});

test('CA3: o mesmo item em duas fontes catálogo da mesma regra sai uma vez só; dedupe pela chave também entre regras diferentes (cada uma a sua)', async (t) => {
  const s = await montar(t, { ofertas: [oferta(1), oferta(2)] });
  const fontes = [{ type: 'catalogo', tag_id: null, config: { ordem: 'relevancia', lojas: ['amazon'] } }, { type: 'catalogo', tag_id: null, config: { ordem: 'desconto', lojas: ['amazon'] } }];
  const a = await s.regra({ name: 'A', tag_id: null, per_run: 10, sources: fontes });
  const b = await s.regra({ name: 'B', tag_id: null, per_run: 10 , sources: [fontes[0]] });
  await s.scheduler.runRule(a);
  assert.deepEqual(enviadas(s.db, a), [`ASIN:${asin(1)}`, `ASIN:${asin(2)}`]);
  assert.equal(s.msgs().length, 2);
  await s.scheduler.runRule(b);
  assert.equal(s.msgs().length, 4, 'a regra B tem o próprio histórico');
  await s.scheduler.runRule(a); await s.scheduler.runRule(b);
  assert.equal(s.msgs().length, 4);
  // as 2 chaves × 2 regras, sem linha duplicada (índice único por regra e chave)
  assert.equal(contar(s.db, 'SELECT COUNT(*) AS n FROM catalogo_itens'), 4);
});

test('CA1: passada a janela de "dias sem repetir" (ordem ≠ Novidades) a oferta volta, sem duplicar a linha do catálogo', async (t) => {
  const s = await montar(t, { ofertas: [oferta(1)] });
  const id = await s.regra({ tag_id: null, per_run: 3, dedupe_days: 7, sources: [{ type: 'catalogo', tag_id: null, config: { ordem: 'relevancia', lojas: ['amazon'] } }] });
  await s.scheduler.runRule(id);
  assert.equal(s.msgs().length, 1);
  s.db.prepare('UPDATE sent_offers SET sent_at = sent_at - ? WHERE rule_id = ?').run(8 * 86400000, id);
  await s.scheduler.runRule(id);
  assert.equal(s.msgs().length, 2, 'depois de 8 dias, vale de novo');
  assert.equal(contar(s.db, 'SELECT COUNT(*) AS n FROM catalogo_itens WHERE rule_id = ?', id), 1);
  await s.scheduler.runRule(id);
  assert.equal(s.msgs().length, 2, 'e de novo protegida pela janela');
});

test('dedupe entre fontes: a lista de links (ML) e o catálogo cruzam pela chave MLB', async (t) => {
  const s = await montar(t, { modo: 'fake', ofertas: [oferta(1, 'ml')] });
  const lista = `https://produto.mercadolivre.com.br/MLB-${mlb(1).slice(3)} | Produto da lista | 99,90 | 150,00`;
  const id = await s.regra({ per_run: 5, sources: [
    { type: 'list', config: { items: lista }, tag_id: null },
    { type: 'catalogo', tag_id: null, config: { ordem: 'relevancia', lojas: ['ml'] } },
  ] });
  await s.scheduler.runRule(id);
  assert.equal(s.msgs().length, 1, 'o mesmo anúncio vindo de duas fontes sai uma vez: ' + JSON.stringify(logs(s.db, id)));
  await s.scheduler.runRule(id);
  assert.equal(s.msgs().length, 1);
  assert.deepEqual(enviadas(s.db, id), [mlb(1)]);
});

// ======================================================================================= CA8: Etiqueta indisponível

test('CA8: 401, 503, 5xx, rede, JSON ruim, HTML e versão 2 = "fonte indisponível": nada enviado, o tick não cai e a outra regra segue', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 3, 12, 0, 0).getTime() });
  const saidas = capturarSaidas(t);
  const casos = [
    [401, 'token_recusado', 'recusou o token', 'token_recusado'], [503, 'desligada', 'está desligada', 'indisponivel'],
    [500, 'fora_do_ar', 'não respondeu', 'indisponivel'], ['cai', 'fora_do_ar', 'não respondeu', 'indisponivel'],
    ['json-ruim', 'resposta_inesperada', 'respondeu algo inesperado', 'indisponivel'], ['html', 'resposta_inesperada', 'respondeu algo inesperado', 'indisponivel'],
    ['versao-2', 'resposta_inesperada', 'respondeu algo inesperado', 'indisponivel'],
  ];
  for (const [modoEt, resultado, frase, estadoCartao] of casos) {
    const s = await montar(t, { modo: 'fake', ofertas: [oferta(1)], estado: { modo: modoEt } });
    const lista = `https://produto.mercadolivre.com.br/MLB-${mlb(9).slice(3)} | Da lista | 99,90 | 150,00`;
    const cat = await s.regra({ name: 'Catálogo', tag_id: null, sources: [{ type: 'catalogo', tag_id: null, config: { ordem: 'relevancia', lojas: ['amazon'] } }] });
    const outra = await s.regra({ name: 'Lista', sources: [{ type: 'list', config: { items: lista }, tag_id: null }] });
    await s.scheduler.tick(); // as duas regras vencidas, na ordem
    const lc = logs(s.db, cat);
    assert.ok(lc.some((l) => l.level === 'erro' && l.message.startsWith('Não consegui buscar ofertas: Catálogo do Etiqueta indisponível:') && l.message.includes(frase)), `${modoEt}: ${JSON.stringify(lc)}`);
    assert.equal(itens(s.db, cat).length, 0, modoEt);
    assert.equal(enviadas(s.db, cat).length, 0, modoEt);
    assert.deepEqual(enviadas(s.db, outra), [mlb(9)], `${modoEt}: a regra da lista segue no mesmo tick`);
    assert.equal(s.msgs().length, 1, modoEt);
    // o cartão e o estado do painel (sem rede)
    const st = (await s.get('/api/state')).json.catalogo;
    assert.equal(st.estado, estadoCartao, modoEt);
    assert.equal(st.situacao.resultado, resultado, modoEt);
    assert.ok(Number.isFinite(st.falha_desde), `${modoEt}: falha_desde`);
    // o Etiqueta volta: a próxima execução funciona e a falha some
    s.et.modo = 'ok';
    await s.scheduler.runRule(cat);
    assert.equal((await s.get('/api/state')).json.catalogo.falha_desde, null, `${modoEt}: recuperou`);
  }
  const todas = saidas();
  assert.ok(!todas.includes(TOKEN), 'o token não vai a console, stdout nem stderr');
});

test('CA8: o catálogo fora do ar não derruba regra com outras fontes: a fonte falha vira aviso e as outras seguem', async (t) => {
  const s = await montar(t, { modo: 'fake', ofertas: [oferta(1)], estado: { modo: 503 } });
  const lista = `https://produto.mercadolivre.com.br/MLB-${mlb(9).slice(3)} | Da lista | 99,90 | 150,00`;
  const id = await s.regra({ per_run: 5, sources: [
    { type: 'catalogo', tag_id: null, config: { ordem: 'relevancia' } }, { type: 'list', config: { items: lista }, tag_id: null }] });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.errors], [1, 0]);
  assert.deepEqual(enviadas(s.db, id), [mlb(9)]);
  const aviso = logs(s.db, id).find((l) => l.level === 'aviso');
  assert.match(aviso.message, /^Fonte ignorada neste envio: fonte 1 \(Catálogo do Etiqueta\): Catálogo do Etiqueta indisponível: a API do Etiqueta está desligada\.$/);
});

test('CA8: sem endereço e caminho salvos, nenhum pedido sai; com endereço adulterado no banco (fora de localhost), também nenhum', async (t) => {
  const s = await montar(t, { ofertas: [oferta(1)], conectar: false });
  const id = await s.regra({ tag_id: null, sources: [{ type: 'catalogo', tag_id: null, config: { ordem: 'relevancia', lojas: ['amazon'] } }] });
  const r = await s.scheduler.runRule(id);
  assert.equal(r.errors, 1);
  assert.match(logs(s.db, id)[0].message, /não está configurado em Conexões/);
  assert.equal(s.et.pedidos.length, 0);
  // adulteração direta no banco: o cliente confere de novo antes de cada chamada
  await s.conectar();
  const fora = s.db.prepare("SELECT config FROM conexoes WHERE plataforma = 'catalogo'").get();
  for (const endereco of ['http://evil.example:8765', `https://127.0.0.1:${s.srvEt.porta}`, `http://127.0.0.1:${s.srvEt.porta}/api`, `http://user@127.0.0.1:${s.srvEt.porta}`, 'http://[::1]:8765', 'http://0.0.0.0:8765']) {
    s.db.prepare("UPDATE conexoes SET config = ? WHERE plataforma = 'catalogo'").run(JSON.stringify({ ...JSON.parse(fora.config), endereco }));
    const rr = await s.scheduler.runRule(id);
    assert.equal(rr.errors, 1, endereco);
    assert.equal(s.et.pedidos.length, 0, `${endereco}: nenhum pedido (nem com o token)`);
  }
  assert.equal(chamadasBloqueadas, 0);
});

test('CA8: redirecionamento do Etiqueta não é seguido: o token nunca chega ao outro servidor', async (t) => {
  const alvo = { ofertas: [] };
  const outro = await etiqueta(alvo);
  t.after(outro.fechar);
  const s = await montar(t, { ofertas: [oferta(1)], estado: { modo: 'redireciona', destinoRedirect: outro.endereco } });
  const id = await s.regra({ tag_id: null, sources: [{ type: 'catalogo', tag_id: null, config: { ordem: 'relevancia', lojas: ['amazon'] } }] });
  const r = await s.scheduler.runRule(id);
  assert.equal(r.errors, 1);
  assert.equal(alvo.pedidos.length, 0, 'o outro servidor não recebeu nada (nem o cabeçalho Authorization)');
  assert.equal(s.msgs().length, 0);
});

// ============================================================================ CA4/CA6, P8: lojas indisponíveis esperam

test('P8: ML com a extensão desligada espera (sem revisão, sem sent_offers) e sai sozinho quando ela volta; a Amazon não espera', async (t) => {
  const s = await montar(t, { ofertas: [oferta(1, 'ml'), oferta(2, 'amazon')] });
  const id = await s.regra({ per_run: 5 });
  const r1 = await s.scheduler.runRule(id);
  assert.deepEqual([r1.offers, r1.revisao], [1, 0]);
  assert.deepEqual(enviadas(s.db, id), [`ASIN:${asin(2)}`]);
  assert.equal(itemDe(s.db, id, mlb(1)), undefined, 'esperar não grava item nem vai à revisão');
  assert.ok(logs(s.db, id).some((l) => l.level === 'aviso' && l.message === 'Catálogo do Etiqueta: 1 oferta do Mercado Livre esperando a extensão do Chrome conectar.'), JSON.stringify(logs(s.db, id)));
  const ext = extensao(s); t.after(() => ext.parar());
  await esperar(20);
  const r2 = await s.scheduler.runRule(id);
  assert.equal(r2.offers, 1);
  assert.deepEqual(enviadas(s.db, id), [`ASIN:${asin(2)}`, mlb(1)]);
  assert.match(s.textos().at(-1), /https:\/\/meli\.la\/Ext\d+/);
});

test('CA4: modo direto — o ML do catálogo nunca sai (nem como link comum), a Amazon sai; nenhum pedido vai à extensão', async (t) => {
  const s = await montar(t, { modo: 'direct', ofertas: [oferta(1, 'ml'), oferta(2, 'amazon')] });
  const ext = extensao(s); t.after(() => ext.parar());
  const id = await s.regra({ per_run: 5 });
  for (let i = 0; i < 3; i++) await s.scheduler.runRule(id);
  assert.deepEqual(enviadas(s.db, id), [`ASIN:${asin(2)}`]);
  assert.equal(ext.jobs.length, 0);
  assert.ok(s.textos().every((x) => !/mercadolivre\.com\.br|meli\.la/.test(x)), 'nenhum link do ML');
  assert.equal(itemDe(s.db, id, mlb(1)), undefined);
  assert.ok(logs(s.db, id).some((l) => /modo direto, sem comissão/.test(l.message)));
});

test('CA4: Amazon sem tag espera; salvar a tag em Conexões libera na execução seguinte; Shopee vai à revisão mesmo assim', async (t) => {
  const s = await montar(t, { tag: '', ofertas: [oferta(2, 'amazon'), oferta(4, 'shopee')] });
  const id = await s.regra({ tag_id: null, per_run: 5, sources: [{ type: 'catalogo', tag_id: null, config: { ordem: 'relevancia', lojas: ['amazon', 'shopee'] } }] });
  const r1 = await s.scheduler.runRule(id);
  assert.deepEqual([r1.offers, r1.revisao], [0, 1]);
  assert.deepEqual(itens(s.db, id).map((i) => [i.chave, i.status]), [['SHOPEE:123.4', 'revisao']]);
  assert.ok(logs(s.db, id).some((l) => /da Amazon esperando: falta a tag de associado/.test(l.message)));
  assert.equal(s.msgs().length, 0);
  await s.salvarTag();
  const r2 = await s.scheduler.runRule(id);
  assert.equal(r2.offers, 1);
  assert.ok(s.textos()[0].includes(`?tag=${TAG_AMAZON}`));
});

test('CA6: catálogo só Amazon/Shopee dispensa a etiqueta (regra sem etiqueta roda); com ML, todas as lojas ou outra fonte, ela é exigida', async (t) => {
  const s = await montar(t, { ofertas: [oferta(2, 'amazon')] });
  const sem = await s.regra({ tag_id: null, sources: [{ type: 'catalogo', tag_id: null, config: { ordem: 'relevancia', lojas: ['amazon', 'shopee'] } }] });
  assert.equal((await s.scheduler.runRule(sem)).offers, 1);
  for (const [nome, sources] of [
    ['com ML', [{ type: 'catalogo', tag_id: null, config: { ordem: 'relevancia', lojas: ['ml'] } }]],
    ['todas as lojas', [{ type: 'catalogo', tag_id: null, config: { ordem: 'relevancia' } }]],
    ['com outra fonte', [{ type: 'catalogo', tag_id: null, config: { ordem: 'relevancia', lojas: ['amazon'] } }, { type: 'list', config: { items: 'https://produto.mercadolivre.com.br/MLB-123456789' }, tag_id: null }]],
  ]) {
    const id = await s.regra({ name: nome, tag_id: null, sources });
    const r = await s.scheduler.runRule(id);
    assert.deepEqual([r.errors, r.offers], [1, 0], nome);
    assert.equal(logs(s.db, id)[0].message, 'Regra incompleta: escolha uma etiqueta.', nome);
  }
});

test('CA6/CA4: a etiqueta da FONTE (tag_id) vale para o ML do catálogo; a da regra é o padrão', async (t) => {
  const s = await montar(t, { ofertas: [oferta(1, 'ml')] });
  s.db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etiquetaB', Date.now());
  const ext = extensao(s); t.after(() => ext.parar());
  const id = await s.regra({ tag_id: 1, sources: [{ type: 'catalogo', tag_id: 2, config: { ordem: 'relevancia', lojas: ['ml'] } }] });
  await s.scheduler.runRule(id);
  assert.deepEqual(ext.jobs.map((j) => j.tag), ['etiquetaB']);
});

// ============================================================================================== permissões (P6) e sessão

const cookieDe = (r) => String(r.headers['set-cookie']?.[0] || '').split(';')[0];
/** Liga o login (cadastro do Dono) e cria um Operador por convite. → { dono, operador } (cabeçalhos com o cookie). */
async function ativarEquipe(s) {
  const ativar = await s.post('/api/equipe/ativar', { nome: 'Ana', email: 'ana@exemplo.com', senha: 'senha-da-ana-123' });
  assert.equal(ativar.status, 200, ativar.txt);
  const dono = { cookie: cookieDe(ativar) };
  const conv = await s.post('/api/equipe/convites', { email: 'bia@exemplo.com', papel: 'operador' }, dono);
  assert.equal(conv.status, 201, conv.txt);
  const aceite = await s.post('/api/convite/aceitar', { token: String(conv.json.link).split('#')[1], nome: 'Bia', senha: 'senha-da-bia-123' });
  assert.equal(aceite.status, 200, aceite.txt);
  return { dono, operador: { cookie: cookieDe(aceite) } };
}

test('P6/CA8: sem sessão tudo é 401; Operador lista mas não envia, descarta, relê nem muda a conexão; o Dono faz tudo; Origin de fora é 403', async (t) => {
  const s = await montar(t, { ofertas: [oferta(4, 'shopee'), oferta(5, 'shopee')] });
  const id = await s.regra({ tag_id: null, sources: [{ type: 'catalogo', tag_id: null, config: { ordem: 'relevancia', lojas: ['shopee'] } }] });
  await s.scheduler.runRule(id);
  const a = idDoItem(s.db, id, 'SHOPEE:123.4'); const b = idDoItem(s.db, id, 'SHOPEE:123.5');
  const { dono, operador } = await ativarEquipe(s);

  // sem sessão
  for (const [m, c] of [['GET', '/api/catalogo/itens'], ['GET', '/api/catalogo/categorias'], ['POST', `/api/catalogo/itens/${a}/enviar`], ['POST', `/api/catalogo/itens/${a}/descartar`],
    ['POST', `/api/rules/${id}/catalogo/recomecar`], ['PUT', '/api/conexoes/catalogo'], ['POST', '/api/conexoes/catalogo/testar']]) {
    const r = await pedir(s.port, m, c, m === 'GET' ? null : {});
    assert.equal(r.status, 401, `${m} ${c}`);
  }
  // Operador
  const lista = await s.get('/api/catalogo/itens?status=revisao', operador);
  assert.equal(lista.status, 200); assert.equal(lista.json.itens.length, 2);
  assert.equal((await s.get('/api/catalogo/categorias', operador)).status, 200);
  for (const [m, c, corpo] of [['POST', `/api/catalogo/itens/${a}/enviar`, {}], ['POST', `/api/catalogo/itens/${a}/descartar`, {}], ['POST', `/api/rules/${id}/catalogo/recomecar`, {}],
    ['PUT', '/api/conexoes/catalogo', { campos: { endereco: 'http://localhost:8765', caminho_token: '/x/token.txt' } }], ['POST', '/api/conexoes/catalogo/testar', {}]]) {
    const r = await pedir(s.port, m, c, corpo, operador);
    assert.equal(r.status, 403, `${m} ${c}: ${r.txt}`);
  }
  assert.equal(itemDe(s.db, id, 'SHOPEE:123.4').status, 'revisao');
  assert.equal(contar(s.db, 'SELECT COUNT(*) AS n FROM envios'), 0);
  assert.equal(s.et.pedidos.length, 1, 'o Operador não fez o Etiqueta ser consultado (só a execução da regra)');
  const cx = (await s.get('/api/conexoes', operador)).json.find((p) => p.id === 'catalogo');
  assert.ok(!('segredos_salvos' in cx));

  // Origin de fora: o guarda de Host/Origin barra antes da rota (mesmo com o cookie do Dono)
  const fora = await s.post(`/api/catalogo/itens/${a}/enviar`, {}, { ...dono, origin: 'http://evil.example' });
  assert.equal(fora.status, 403);
  assert.equal(itemDe(s.db, id, 'SHOPEE:123.4').status, 'revisao');

  // o Dono
  const d = await s.post(`/api/catalogo/itens/${b}/descartar`, {}, dono);
  assert.deepEqual([d.status, d.json.ok], [200, true]);
  assert.equal(itemDe(s.db, id, 'SHOPEE:123.5').status, 'descartado');
  const e = await s.post(`/api/catalogo/itens/${a}/enviar`, {}, dono);
  assert.equal(e.status, 200, e.txt);
  await assentar(s);
  assert.equal(s.msgs().length, 1);
  const n = await s.post(`/api/rules/${id}/catalogo/recomecar`, {}, dono);
  assert.equal(n.status, 200);
  // descartado nunca volta pela regra (nem relendo do começo, nem na ordem por deslocamento)
  await s.scheduler.runRule(id);
  assert.equal(itemDe(s.db, id, 'SHOPEE:123.5').status, 'descartado');
  assert.equal(contar(s.db, "SELECT COUNT(*) AS n FROM catalogo_itens WHERE status = 'revisao'"), 0);
});

test('rotas de itens: parâmetros hostis (regra, status, limite, id) respondem 400/404 sem erro 500 nem vazamento', async (t) => {
  const s = await montar(t, { ofertas: [oferta(4, 'shopee')] });
  const id = await s.regra({ tag_id: null, sources: [{ type: 'catalogo', tag_id: null, config: { ordem: 'relevancia', lojas: ['shopee'] } }] });
  await s.scheduler.runRule(id);
  for (const q of ['regra=1%20OR%201%3D1', "regra=1';DROP%20TABLE%20catalogo_itens;--", 'regra=-1', 'regra=abc']) {
    const r = await s.get(`/api/catalogo/itens?${q}`);
    assert.ok([400, 404].includes(r.status), `${q}: ${r.status}`);
  }
  assert.equal((await s.get('/api/catalogo/itens?status=todos%27%3B--')).status, 400);
  const g = await s.get('/api/catalogo/itens?limite=-5'); assert.equal(g.status, 200);
  const h = await s.get('/api/catalogo/itens?limite=999999'); assert.equal(h.status, 200);
  assert.equal(contar(s.db, 'SELECT COUNT(*) AS n FROM catalogo_itens'), 1, 'a tabela continua lá');
  for (const i of ['abc', '-1', '0', '1.5', '99999999999999999999', '1%20OR%201']) {
    for (const acao of ['enviar', 'descartar']) {
      const r = await s.post(`/api/catalogo/itens/${i}/${acao}`, {});
      assert.ok([400, 404].includes(r.status), `${acao} ${i}: ${r.status} ${r.txt}`);
    }
  }
  // corpo estranho no "Enviar": nunca 500
  const item = idDoItem(s.db, id, 'SHOPEE:123.4');
  for (const corpo of [[], 'texto', { ajustes: [] }, { ajustes: 'x' }, { ajustes: { image: 'https://evil.example/a.jpg', link: 'https://evil.example/' } }]) {
    const r = await pedir(s.port, 'POST', `/api/catalogo/itens/${item}/enviar`, corpo);
    assert.notEqual(r.status, 500, JSON.stringify(corpo));
  }
});

test('CA4/CA5: "Enviar" nunca usa image/link vindos do navegador (só o do catálogo, conferido)', async (t) => {
  const s = await montar(t, { ofertas: [oferta(4, 'shopee')] });
  const id = await s.regra({ tag_id: null, sources: [{ type: 'catalogo', tag_id: null, config: { ordem: 'relevancia', lojas: ['shopee'] } }] });
  await s.scheduler.runRule(id);
  const item = idDoItem(s.db, id, 'SHOPEE:123.4');
  const r = await s.post(`/api/catalogo/itens/${item}/enviar`, { ajustes: { title: 'Fone Bluetooth JBL', image: 'https://evil.example/a.jpg', link: 'https://evil.example/x' }, link: 'https://evil.example/y', image: 'https://evil.example/b.jpg' });
  assert.equal(r.status, 200, r.txt);
  await assentar(s);
  assert.ok(s.msgs()[0].text.includes('Fone Bluetooth JBL') && s.msgs()[0].text.includes('https://s.shopee.com.br/Ab4cd'), s.msgs()[0].text);
  assert.ok(!s.msgs()[0].text.includes('evil.example'));
  assert.equal(s.msgs()[0].image, 'https://down-br.img.susercontent.com/file/4');
});

// ==================================================================================================== CA8: o token

test('CA8: o token só viaja no cabeçalho Authorization — nunca em resposta, banco, log, console, URL nem mensagem de erro', async (t) => {
  const saidas = capturarSaidas(t);
  const s = await montar(t, { modo: 'fake', ofertas: [oferta(1), oferta(4, 'shopee'), oferta(5, 'amazon', { preco: 1, preco_antigo: 1000, desconto_pct: 100 })] });
  const id = await s.regra({ per_run: 5, tag_id: null, sources: [{ type: 'catalogo', tag_id: null, config: { ordem: 'relevancia', lojas: ['amazon', 'shopee'] } }] });
  await s.scheduler.runRule(id);                                     // envia e separa para revisão
  const testar = await s.post('/api/conexoes/catalogo/testar', {});    // Testar
  assert.equal(testar.json.ok, true, testar.txt);
  const prev = await s.get(`/api/rules/${id}/offers`);                 // "Ver ofertas" (pré-visualização)
  assert.equal(prev.status, 200);
  const item = idDoItem(s.db, id, 'SHOPEE:123.4');
  await s.post(`/api/catalogo/itens/${item}/enviar`, {});
  await assentar(s);
  // falhas: arquivo inexistente, arquivo fora do formato, token recusado, API desligada, rede
  const guarda = s.db.prepare("SELECT config FROM conexoes WHERE plataforma = 'catalogo'").get().config;
  for (const caminho of ['/nao/existe/api_token.txt', path.join(tmp('lixo'), 'creds.json')]) {
    if (caminho.endsWith('creds.json')) fs.writeFileSync(caminho, JSON.stringify({ noiseKey: 'SEGREDO-DA-SESSAO-WHATSAPP-0123456789abcdef' }));
    s.db.prepare("UPDATE conexoes SET config = ? WHERE plataforma = 'catalogo'").run(JSON.stringify({ ...JSON.parse(guarda), caminho_token: caminho }));
    await s.scheduler.runRule(id); await s.post('/api/conexoes/catalogo/testar', {});
  }
  s.db.prepare("UPDATE conexoes SET config = ? WHERE plataforma = 'catalogo'").run(guarda);
  for (const modo of [401, 503, 500, 'cai', 'json-ruim']) { s.et.modo = modo; await s.scheduler.runRule(id); await s.post('/api/conexoes/catalogo/testar', {}); }

  // 1. o Etiqueta: o token só no cabeçalho Authorization; nada na URL; só o cabeçalho de autenticação e os do cliente HTTP
  const comToken = s.et.pedidos.filter((p) => p.headers.authorization?.includes(TOKEN));
  assert.ok(comToken.length >= 4);
  for (const p of s.et.pedidos) {
    assert.ok(!p.url.includes(TOKEN), 'token na URL');
    assert.equal(p.headers.origin, undefined); assert.equal(p.headers['sec-fetch-site'], undefined); assert.equal(p.headers.cookie, undefined);
    for (const [k, v] of Object.entries(p.headers)) if (k !== 'authorization') assert.ok(!String(v).includes(TOKEN), `token no cabeçalho ${k}`);
    assert.ok(!JSON.stringify(p.headers).includes('SEGREDO-DA-SESSAO'), 'o conteúdo de outro arquivo nunca vira cabeçalho');
  }
  assert.ok(s.et.pedidos.every((p) => (p.headers.authorization ?? '') === '' || p.headers.authorization === `Bearer ${TOKEN}`), 'o arquivo sem formato de token não foi enviado');
  // 2. banco inteiro (inclusive settings e a coluna segredos), sem o token nem o conteúdo do outro arquivo
  const banco = bancoInteiro(s.db);
  assert.ok(!banco.includes(TOKEN), 'token no banco');
  assert.ok(!banco.includes('SEGREDO-DA-SESSAO'));
  // 3. as respostas de todos os GET do painel
  const caminhos = ['/api/state', '/api/conexoes', '/api/rules', '/api/log?limite=1000', '/api/catalogo/itens?limite=200', '/api/catalogo/categorias', '/api/simulados', '/api/groups', '/api/envios',
    '/api/tags', '/api/templates', '/api/equipe', '/api/overview', '/api/espelhos', '/api/avisos'];
  for (const c of caminhos) {
    const r = await s.get(c);
    assert.ok(!r.txt.includes(TOKEN), `token em ${c}`); assert.ok(!r.txt.includes('SEGREDO-DA-SESSAO'), `conteúdo do arquivo em ${c}`);
  }
  // 4. mensagens enviadas e console
  assert.ok(!s.wa.simulated.some((m) => JSON.stringify(m).includes(TOKEN)));
  assert.ok(!saidas().includes(TOKEN), 'token em console, stdout ou stderr');
  assert.ok(!saidas().includes('SEGREDO-DA-SESSAO'));
});

test('CA8: PUT de Conexões recusa endereço fora de localhost/127.0.0.1 e caminho que é o próprio token, sem gravar nem ecoar', async (t) => {
  const s = await montar(t, { conectar: false });
  const antes = JSON.stringify(s.db.prepare('SELECT * FROM conexoes').all());
  for (const endereco of ['http://evil.example:8765', 'https://localhost:8765', 'http://localhost', 'http://localhost:8765/', 'http://localhost:8765/api', 'http://127.0.0.1:99999', 'http://127.0.0.1:0',
    'http://localhost:8765@evil.example', 'http://user:senha@localhost:8765', 'http://[::1]:8765', 'http://0.0.0.0:8765', 'http://127.0.0.1.evil.example:80', 'http://localhost.evil.example:80', 'http://169.254.169.254:80', 'ftp://localhost:21']) {
    const r = await pedir(s.port, 'PUT', '/api/conexoes/catalogo', { campos: { endereco, caminho_token: '/home/x/api_token.txt' } });
    assert.equal(r.status, 400, `${endereco}: ${r.txt}`);
    assert.ok(!r.txt.includes('evil.example') && !r.txt.includes('169.254'), 'a resposta não repete o valor');
  }
  for (const caminho of [TOKEN, `/${TOKEN}`, `~/${TOKEN}`, 'relativo/token.txt', `/${'a'.repeat(501)}`, '/tmp/x\u0000y']) {
    const r = await pedir(s.port, 'PUT', '/api/conexoes/catalogo', { campos: { endereco: 'http://localhost:8765', caminho_token: caminho } });
    assert.equal(r.status, 400, `caminho ${caminho.slice(0, 20)}`);
    assert.ok(!r.txt.includes(TOKEN), 'o token digitado no campo errado não é ecoado');
  }
  assert.equal(JSON.stringify(s.db.prepare('SELECT * FROM conexoes').all()), antes, 'nada foi gravado');
  assert.ok(!bancoInteiro(s.db).includes(TOKEN));
  assert.equal(s.et.pedidos.length, 0);
});

test('CA2/CA8: "Testar" guarda as categorias; /api/catalogo/categorias as devolve sem chamar o Etiqueta; texto hostil volta como dado, sem marcação do servidor', async (t) => {
  const XSS = '<img src=x onerror=alert(1)>"\'&';
  const s = await montar(t, { ofertas: [oferta(1)], estado: { categorias: { versao: 1, total: 7, categorias: [{ nome: `Casa ${XSS}`, total: 7, lojas: { amazon: 4, ml: 2, shopee: 1 } }] } } });
  assert.deepEqual((await s.get('/api/catalogo/categorias')).json.categorias, [], 'antes do Testar: nada');
  const r = await s.post('/api/conexoes/catalogo/testar', {});
  assert.deepEqual([r.json.ok, r.json.resultado, r.json.total], [true, 'ok', 7]);
  assert.equal(s.et.pedidos.length, 1);
  assert.equal(s.et.pedidos[0].rota, '/api/v1/categorias');
  const c = await s.get('/api/catalogo/categorias');
  assert.equal(c.json.categorias[0].nome, `Casa ${XSS}`);
  assert.deepEqual(c.json.categorias[0].lojas, { amazon: 4, ml: 2, shopee: 1 });
  assert.equal(c.json.estado, 'conectada');
  await s.get('/api/state'); await s.get('/api/conexoes');
  assert.equal(s.et.pedidos.length, 1, 'abrir telas não consulta o Etiqueta');
  assert.match(c.headers['content-type'], /application\/json/);
});

test('CA8: o painel nunca fala com o Etiqueta — nenhum arquivo de public/ cita a API v1, o token ou a porta; a CSP só deixa o próprio servidor', async (t) => {
  for (const arq of fs.readdirSync(path.join(RAIZ, 'public')).filter((f) => /\.(js|html)$/.test(f))) {
    const txt = fs.readFileSync(path.join(RAIZ, 'public', arq), 'utf8');
    assert.ok(!/api\/v1\//.test(txt), `${arq}: chama a API v1`);
    assert.ok(!/Bearer/.test(txt), `${arq}: monta Authorization`);
  }
  const s = await montar(t, { conectar: false });
  const r = await s.get('/');
  const csp = String(r.headers['content-security-policy']);
  assert.match(csp, /connect-src 'self'(;|$)/);
  assert.ok(!/8765|localhost/.test(csp), csp);
  // o único lugar do painel que cita a porta é o texto de ajuda/valor padrão do campo (nunca um fetch)
  const fetches = fs.readdirSync(path.join(RAIZ, 'public')).filter((f) => f.endsWith('.js'))
    .flatMap((f) => [...fs.readFileSync(path.join(RAIZ, 'public', f), 'utf8').matchAll(/fetch\(([^)]*)\)/g)].map((m) => `${f}: ${m[1]}`));
  assert.ok(fetches.every((x) => !/localhost|127\.0\.0\.1|http:/.test(x)), fetches.filter((x) => /localhost|127\.0\.0\.1|http:/.test(x)).join('\n'));
});

// ======================================================================================== regra: criar, apagar, limpar

test('CA1/CA3: apagar a regra leva itens e cursores; a regra nova que reaproveita o id não herda nada; "Limpar já enviadas" tira só as enviadas', async (t) => {
  const s = await montar(t, { ofertas: [oferta(1), oferta(4, 'shopee')] });
  const cfg = { ordem: 'atualizacao', lojas: ['amazon', 'shopee'] };
  const id = await s.regra({ tag_id: null, per_run: 5, dedupe_days: 0, sources: [{ type: 'catalogo', tag_id: null, config: cfg }] });
  await s.scheduler.runRule(id);                  // primeira leitura: cursor
  s.et.ofertas.push(oferta(2), oferta(5, 'shopee'));
  await s.scheduler.runRule(id);                  // Amazon 2 sai; Shopee 5 vai à revisão
  assert.deepEqual(itens(s.db, id).map((i) => [i.chave, i.status]), [[`ASIN:${asin(2)}`, 'enviado'], ['SHOPEE:123.5', 'revisao']]);
  assert.ok(cursor(s.db, id, cfg));

  // "Limpar já enviadas": a revisão fica, as enviadas somem (de sent_offers e do catálogo)
  assert.equal((await s.post(`/api/rules/${id}/reset-sent`, {})).status, 200);
  assert.deepEqual(itens(s.db, id).map((i) => [i.chave, i.status]), [['SHOPEE:123.5', 'revisao']]);
  assert.deepEqual(enviadas(s.db, id), []);

  const item = idDoItem(s.db, id, 'SHOPEE:123.5');
  assert.equal((await s.del(`/api/rules/${id}`)).status, 200);
  for (const tb of ['catalogo_itens', 'catalogo_cursores', 'sent_offers']) assert.equal(contar(s.db, `SELECT COUNT(*) AS n FROM ${tb} WHERE rule_id = ?`, id), 0, tb);
  assert.equal((await s.post(`/api/catalogo/itens/${item}/enviar`, {})).status, 404, 'a revisão da regra apagada some');
  assert.equal((await s.get('/api/state')).json.catalogo.para_revisar, 0);

  const novo = await s.regra({ tag_id: null, per_run: 5, dedupe_days: 0, sources: [{ type: 'catalogo', tag_id: null, config: cfg }] });
  assert.equal(novo, id, 'o SQLite reaproveitou o id (é o caso que a limpeza protege)');
  const wa0 = s.msgs().length;
  const r = await s.scheduler.runRule(novo);
  assert.equal(r.offers, 0, 'regra nova: primeira leitura, nada herdado');
  assert.equal(s.msgs().length, wa0);
  assert.deepEqual(cursor(s.db, novo, cfg), { cursor: 'c4', pronto: 1 });
});

test('CA3/CA9: a regra com catálogo inválida é recusada com frase fixa e campo; válida é normalizada; várias fontes marcam a fonte', async (t) => {
  const s = await montar(t, { conectar: false });
  const base = { name: 'R', tag_id: 1, template_id: 1, group_jids: [GRUPO] };
  const XSS = '<script>alert(1)</script>';
  const casos = [
    [{ ordem: 'aleatoria' }, 'ordem', 'Ordem do catálogo inválida.'], [{ lojas: ['americanas'] }, 'lojas', null], [{ lojas: ['ml', 'ml'] }, 'lojas', null],
    [{ categorias: Array.from({ length: 21 }, (_, i) => `c${i}`) }, 'categorias', 'Escolha no máximo 20 categorias.'], [{ categorias: ['a', 'a'] }, 'categoria', null],
    [{ categorias: ['x'.repeat(201)] }, 'categoria', null], [{ categorias: [XSS, ''] }, 'categoria', null],
    [{ q: 'a,,b' }, 'q', null], [{ q: 'x'.repeat(201) }, 'q', null], [{ q: 'a,b,c,d,e,f,g,h,i,j,k' }, 'q', null],
    [{ desconto_min: 100 }, 'desconto_min', null], [{ desconto_min: -1 }, 'desconto_min', null], [{ desconto_min: 3.5 }, 'desconto_min', null], [{ desconto_min: 'abc' }, 'desconto_min', null],
  ];
  for (const [config, campo, frase] of casos) {
    const r = await s.post('/api/rules', { ...base, sources: [{ type: 'catalogo', config }] });
    assert.equal(r.status, 400, JSON.stringify(config).slice(0, 60));
    assert.equal(r.json.campo, campo, JSON.stringify(config).slice(0, 60));
    assert.equal(r.json.fonte, 1);
    if (frase) assert.equal(r.json.erro, frase);
    assert.ok(!r.txt.includes('<script>') && !r.txt.includes('americanas'), 'a frase nunca repete o valor');
  }
  const segunda = await s.post('/api/rules', { ...base, sources: [{ type: 'catalogo', config: {} }, { type: 'catalogo', config: { ordem: 'x' } }] });
  assert.deepEqual([segunda.status, segunda.json.fonte, segunda.json.campo], [400, 2, 'ordem']);
  assert.equal(contar(s.db, 'SELECT COUNT(*) AS n FROM rules'), 0);
  const ok = await s.post('/api/rules', { ...base, sources: [{ type: 'catalogo', config: { categorias: ['Casa'], lojas: ['shopee', 'amazon'], q: ' fone, jbl ', desconto_min: '30', ordem: '' } }] });
  assert.equal(ok.status, 200, ok.txt);
  const salva = JSON.parse(s.db.prepare('SELECT sources FROM rules WHERE id = ?').get(ok.json.id).sources);
  assert.deepEqual(salva[0].config, { categorias: ['Casa'], lojas: ['shopee', 'amazon'], q: 'fone, jbl', desconto_min: 30, ordem: 'atualizacao' });
  const sem = await s.post('/api/rules', { ...base, sources: [{ type: 'catalogo' }] });
  assert.equal(sem.status, 200, 'sem config: o padrão (todas as categorias e lojas, Novidades)');
});

test('CA3: filtros da fonte chegam ao Etiqueta como o contrato pede (cat, loja, q, desconto_min, ordem, limite), com acentos, & e +', async (t) => {
  const s = await montar(t, { ofertas: [oferta(1)] });
  const id = await s.regra({ tag_id: null, sources: [{ type: 'catalogo', tag_id: null, config: { categorias: ['Casa e Decoração', 'A&B+C 100%'], lojas: ['amazon', 'shopee'], q: 'fone, café', desconto_min: 30, ordem: 'relevancia' } }] });
  await s.scheduler.runRule(id);
  assert.deepEqual(s.et.pedidos[0].params, [['cat', 'Casa e Decoração'], ['cat', 'A&B+C 100%'], ['loja', 'amazon'], ['loja', 'shopee'], ['q', 'fone, café'], ['desconto_min', '30'], ['ordem', 'relevancia'], ['limite', '200']]);
  assert.ok(!s.et.pedidos[0].url.includes(' '), 'a URL sai codificada');
});

// ================================================================================================ concorrência (CA3)

test('CA3: nunca dois pedidos ao Etiqueta ao mesmo tempo, mesmo com duas regras, o Testar e a pré-visualização juntos; a mesma regra duas vezes roda uma', async (t) => {
  const s = await montar(t, { ofertas: [oferta(1), oferta(2), oferta(3)], estado: { atraso: 40 } });
  const mk = (nome) => s.regra({ name: nome, tag_id: null, per_run: 1, sources: [{ type: 'catalogo', tag_id: null, config: { ordem: 'relevancia', lojas: ['amazon'] } }] });
  const a = await mk('A'); const b = await mk('B');
  const [r1, r2, r3, testar, previa, previaB] = await Promise.all([
    s.scheduler.runRule(a), s.scheduler.runRule(a), s.scheduler.runRule(b),
    s.post('/api/conexoes/catalogo/testar', {}), s.get(`/api/rules/${b}/offers`), s.get(`/api/rules/${a}/offers`),
  ]);
  assert.equal(s.et.maxSimultaneos, 1, 'fila única no cliente do Etiqueta');
  assert.ok(r1.skipped || r2.skipped, 'a mesma regra não roda duas vezes ao mesmo tempo');
  assert.equal(enviadas(s.db, a).length, 1, 'e não envia em dobro');
  assert.equal(enviadas(s.db, b).length, 1);
  assert.equal(testar.json.ok, true);
  assert.equal(previa.status, 200); assert.equal(previaB.status, 200);
  assert.equal(r3.offers, 1);
});

// ============================================================================================ "Ver ofertas" (prévia)

test('prévia: não grava item, cursor, envio nem sent_offers; mostra a oferta que iria à revisão e o link sem tag/sem expor o do Etiqueta', async (t) => {
  const s = await montar(t, { ofertas: [oferta(2), oferta(4, 'shopee'), oferta(5, 'amazon', { preco: 1, preco_antigo: 1000, desconto_pct: 100 })] });
  const id = await s.regra({ tag_id: null, per_run: 5, sources: [{ type: 'catalogo', tag_id: null, config: { ordem: 'relevancia', lojas: ['amazon', 'shopee'] } }] });
  const antes = ['catalogo_itens', 'catalogo_cursores', 'sent_offers', 'envios'].map((tb) => contar(s.db, `SELECT COUNT(*) AS n FROM ${tb}`));
  const r = await s.get(`/api/rules/${id}/offers`);
  assert.equal(r.status, 200, r.txt);
  const ofertas = r.json.ofertas ?? r.json;
  assert.equal(ofertas.length, 3);
  assert.deepEqual(ofertas.map((o) => [o.key, !!o.revisao]), [[`ASIN:${asin(2)}`, false], ['SHOPEE:123.4', true], [`ASIN:${asin(5)}`, true]]);
  assert.ok(!r.txt.includes('terceiro-20'), 'o link do Etiqueta não vaza na prévia');
  assert.ok(!r.txt.includes(TAG_AMAZON), 'a tag do dono não aparece na prévia (mascarada)');
  assert.deepEqual(['catalogo_itens', 'catalogo_cursores', 'sent_offers', 'envios'].map((tb) => contar(s.db, `SELECT COUNT(*) AS n FROM ${tb}`)), antes);
  assert.equal(s.msgs().length, 0);
});

// ================================================================================== ofertas fora do contrato, texto hostil

test('CA4/CA9: oferta que não fecha (item_id, link da Shopee de fora, preço ≤ 0, título vazio, loja nova) é ignorada e só vira um aviso', async (t) => {
  const ruins = [
    oferta(10, 'shopee', { link: 'https://s.shopee.com.br.evil.example/x' }), oferta(11, 'shopee', { link: 'https://s.shopee.com.br@evil.example/x' }),
    oferta(12, 'shopee', { link: 'http://s.shopee.com.br/x' }), oferta(13, 'shopee', { link: 'https://meli.la/abc' }), oferta(14, 'shopee', { item_id: 'abc' }),
    oferta(15, 'amazon', { item_id: 'B0123' }), oferta(16, 'amazon', { preco: 0 }), oferta(17, 'amazon', { preco: '99,90' }), oferta(18, 'amazon', { titulo: '   ' }),
    oferta(19, 'ml', { item_id: 'https://produto.mercadolivre.com.br/MLB-123456789' }), oferta(20, 'ml', { item_id: 'MLA123456789' }), oferta(21, 'ml', { item_id: 'MLB1' }),
    { ...oferta(22, 'amazon'), loja: 'americanas' }, { ...oferta(23, 'amazon'), loja: '__proto__' }, oferta(24, 'amazon', { preco: null }), null, 'texto', [],
  ];
  const s = await montar(t, { modo: 'fake', ofertas: [...ruins, oferta(1, 'amazon')] });
  const id = await s.regra({ per_run: 20 });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.errors, r.revisao], [1, 0, 0]);
  assert.deepEqual(itens(s.db, id).map((i) => i.chave), [`ASIN:${asin(1)}`]);
  assert.ok(logs(s.db, id).some((l) => l.level === 'aviso' && /ofertas? ignoradas?/.test(l.message)), JSON.stringify(logs(s.db, id)));
  assert.equal(s.msgs().length, 1);
});

test('CA9: título, categoria e cupom hostis seguem como TEXTO até o painel (JSON cru) e o painel os escapa; o título da mensagem fica em uma linha', async (t) => {
  const XSS = '<img src=x onerror=alert(1)>"\'&';
  const s = await montar(t, { ofertas: [
    oferta(4, 'shopee', { titulo: `Fone ${XSS}\n*negrito* _it_ ~ris~ \`código\``, categoria: `Cat ${XSS}`, cupom: `CUPOM ${XSS}\nlinha2` }),
    oferta(2, 'amazon', { titulo: `Caixa ${XSS}\r\nsegunda linha`, cupom: `CP ${XSS}` }),
  ] });
  const id = await s.regra({ name: `Regra ${XSS}`, tag_id: null, per_run: 5, sources: [{ type: 'catalogo', tag_id: null, config: { ordem: 'relevancia', lojas: ['amazon', 'shopee'] } }] });
  await s.scheduler.runRule(id);
  const msg = s.msgs()[0].text;
  assert.ok(!/\r|\u0000/.test(msg));
  const linhaTitulo = msg.split('\n').find((l) => l.includes('Caixa'));
  assert.ok(linhaTitulo && linhaTitulo.includes('segunda linha'), 'o título (e o que veio colado nele) fica numa linha só: ' + msg);
  const api = await s.get(`/api/catalogo/itens?regra=${id}&status=revisao`);
  assert.equal(api.status, 200);
  const it = api.json.itens[0];
  assert.ok(!/\n|\r/.test(it.oferta.title) && !/\n|\r/.test(it.oferta.coupon ?? ''), 'título e cupom em uma linha');
  assert.ok(it.oferta.title.includes('<img src=x onerror=alert(1)>'), 'o dado fica cru no JSON (o painel escapa)');

  // o painel (public/app.js + espelhamento.js num vm) escapa a linha vinda do servidor de verdade
  const html = renderizarLinhaDoHistorico(it, true);
  assert.ok(!/<img|<script|onerror=alert\(1\)>/i.test(html.replaceAll('&lt;img src=x onerror=alert(1)&gt;', '')), html);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  const log = (await s.get('/api/log?limite=200')).json;
  assert.ok(log.length > 0);
});

/** Carrega espelhamento.js e app.js com um DOM mínimo e devolve hcatLinhaHtml (a linha do Histórico > Catálogo). */
function renderizarLinhaDoHistorico(item, dono) {
  const novo = () => {
    const e = { textContent: '', value: '', hidden: false, disabled: false, checked: false, className: '', dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      setAttribute() {}, getAttribute: () => null, removeAttribute() {}, hasAttribute: () => false, querySelector: () => novo(), querySelectorAll: () => [], addEventListener() {}, appendChild() {},
      insertAdjacentHTML() {}, remove() {}, focus() {}, scrollIntoView() {}, closest: () => null, showModal() {}, close() {}, innerHTML: '' };
    return e;
  };
  const ctx = { console, URLSearchParams, document: { querySelector: novo, querySelectorAll: () => [], addEventListener() {}, createElement: novo, body: {} }, location: { hash: '#historico', replace() {} },
    history: { replaceState() {} }, addEventListener() {}, setInterval: () => 0, setTimeout: () => 0, clearTimeout() {}, confirm: () => true, q: () => '', dispSegHtml: () => '', dispLigarSeg() {},
    dispBrl: (n) => `R$ ${Number(n).toFixed(2)}`, fetch: () => new Promise(() => {}) };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(RAIZ, 'public', 'espelhamento.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(RAIZ, 'public', 'app.js'), 'utf8'), ctx);
  ctx.__it = JSON.parse(JSON.stringify(item)); ctx.__dono = dono;
  return vm.runInContext('hcatLinhaHtml(__it, __dono)', ctx);
}

// ======================================================================================================= regressões

test('regressão: a foto das fontes antigas (ML) é decidida como antes — imagemPermitida("mercadolivre") ≡ IMAGEM_PERMITIDA em muitas URLs', () => {
  const urls = ['https://http2.mlstatic.com/D_1.jpg', 'https://mlstatic.com/x', 'http://http2.mlstatic.com/x', 'https://http2.mlstatic.com.evil.example/x', 'https://evilmlstatic.com/x',
    'https://a.b.mlstatic.com/x', 'HTTPS://HTTP2.MLSTATIC.COM/x', 'https://mlstatic.com', 'https://m.media-amazon.com/x', '', null, undefined, 'javascript:alert(1)', 'https://http2.mlstatic.com@evil.example/x',
    'https://evil.example/https://http2.mlstatic.com/x', 'https://http2.mlstatic.com:8443/x', ' https://http2.mlstatic.com/x'];
  for (const u of urls) {
    const antigo = IMAGEM_PERMITIDA.test(u || '');
    const novo = !!imagemPermitida('mercadolivre', u);
    // o novo pode ser MAIS estrito (host exato, sem porta/usuário), nunca mais frouxo
    assert.ok(!novo || antigo, `mais frouxo que o antigo: ${u}`);
    if (antigo && !novo) assert.match(String(u), /@|:\d+\/|\s|\.evil|evilml/i, `ficou mais estrito sem motivo claro: ${u}`);
  }
  assert.ok(imagemPermitida('mercadolivre', 'https://http2.mlstatic.com/D_1.jpg'));
});

test('regressão: regra antiga (lista de links, ML) segue igual — etiqueta obrigatória, link da extensão, foto do ML, sem tocar no catálogo', async (t) => {
  const s = await montar(t, { modo: 'fake', conectar: false });
  const lista = 'https://produto.mercadolivre.com.br/MLB-123456789 | Teclado | 99,90 | 150,00';
  const sem = await s.regra({ name: 'sem etiqueta', tag_id: null, sources: [{ type: 'list', config: { items: lista }, tag_id: null }] });
  const r0 = await s.scheduler.runRule(sem);
  assert.equal(r0.errors, 1);
  assert.equal(logs(s.db, sem)[0].message, 'Regra incompleta: escolha uma etiqueta.');
  const id = await s.regra({ sources: [{ type: 'list', config: { items: lista }, tag_id: null }] });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages, r.errors, r.revisao], [1, 1, 0, 0]);
  assert.match(s.textos()[0], /https:\/\/meli\.la\/fake-etiquetaA-\d+/);
  assert.equal(enviadas(s.db, id).join(), 'MLB123456789');
  assert.equal(contar(s.db, 'SELECT COUNT(*) AS n FROM catalogo_itens'), 0);
  assert.equal(s.et.pedidos.length, 0);
  // repetir não manda de novo (dedupe_days 7)
  await s.scheduler.runRule(id);
  assert.equal(s.msgs().length, 1);
  const st = (await s.get('/api/state')).json;
  assert.equal(st.catalogo.estado, 'falta_configurar');
  assert.equal(st.catalogo.para_revisar, 0);
});

test('regressão: a rota de regras e o /api/state seguem com o catálogo sem conexão; o log de regra antiga não ganhou campo novo', async (t) => {
  const s = await montar(t, { modo: 'fake', conectar: false });
  const id = await s.regra({ sources: [{ type: 'list', config: { items: 'https://produto.mercadolivre.com.br/MLB-123456789' }, tag_id: null }] });
  const regras = (await s.get('/api/rules')).json;
  assert.equal(regras.length, 1);
  assert.equal(regras[0].sources[0].type, 'list');
  assert.equal(regras[0].em_andamento, false);
  const put = await s.put(`/api/rules/${id}`, { ...regras[0], name: 'Renomeada', sources: regras[0].sources });
  assert.equal(put.status, 200, put.txt);
  assert.equal((await s.get('/api/rules')).json[0].name, 'Renomeada');
  assert.equal((await s.post(`/api/rules/${id}/enabled`, { enabled: false })).status, 200);
});

// ========================================================================================= falha depois do "Enviar"

test('"Enviar" cujo envio falha no WhatsApp: o item fica rastreável na lista (envio_status e erro por grupo) e nada sai em dobro', async (t) => {
  const s = await montar(t, { ofertas: [oferta(4, 'shopee')] });
  const id = await s.regra({ tag_id: null, sources: [{ type: 'catalogo', tag_id: null, config: { ordem: 'relevancia', lojas: ['shopee'] } }] });
  await s.scheduler.runRule(id);
  const item = idDoItem(s.db, id, 'SHOPEE:123.4');
  s.wa.sendImage = async () => { throw new Error('socket caiu'); };
  s.wa.sendText = async () => { throw new Error('socket caiu'); };
  const r = await s.post(`/api/catalogo/itens/${item}/enviar`, {});
  assert.equal(r.status, 200, r.txt);
  await assentar(s);
  const lista = (await s.get(`/api/catalogo/itens?regra=${id}`)).json.itens[0];
  // Rodar sozinho, entrega 2 (CA2.8): o "Enviar" que falhou em todos os grupos volta à revisão.
  assert.deepEqual([lista.status, lista.envio_status, lista.ultimo_envio_falhou], ['revisao', 'erro', true]);
  assert.deepEqual(lista.ultimo_envio_erros, [{ nome: 'Achadinhos', erro: 'socket caiu' }]);
  assert.equal(s.msgs().length, 0);
});

// ================================================================================ leitura grande, reinício, cartão

test('CA3: Novidades com 450 ofertas lê 3 páginas de 200 e a vazia, guarda o cursor no fim e sobrevive a um reinício (serviços novos, mesmo banco)', async (t) => {
  const s = await montar(t, { ofertas: Array.from({ length: 450 }, (_, i) => oferta(i + 1)) });
  const id = await regraNovidades(s, { per_run: 5 });
  const r = await s.scheduler.runRule(id);
  assert.equal(r.offers, 0);
  assert.deepEqual(cursor(s.db, id, NOVIDADES), { cursor: 'c450', pronto: 1 });
  assert.deepEqual(s.et.pedidos.map((p) => p.params.find(([k]) => k === 'cursor')?.[1] ?? null), [null, 'c200', 'c400', 'c450']);
  assert.ok(s.et.pedidos.every((p) => p.params.some(([k, v]) => k === 'limite' && v === '200')));
  assert.equal(s.et.maxSimultaneos, 1);

  // "reinício": novos serviços sobre o mesmo banco (o cursor está no SQLite, não na memória)
  const { catalogo, catalogoItens, scheduler } = criarServicos({ db: s.db, wa: s.wa, links: s.links, fast: true, dir: s.dir, fetch: fetchFiltrado });
  assert.ok(catalogo && catalogoItens);
  s.et.ofertas.push(oferta(451));
  const r2 = await scheduler.runRule(id);
  assert.equal(r2.offers, 1);
  assert.deepEqual(enviadas(s.db, id), [`ASIN:${asin(451)}`]);
  assert.equal(s.et.pedidos.at(-2).params.find(([k]) => k === 'cursor')[1], 'c450', 'continuou do cursor guardado');
});

test('CA2: depois de "Testar" ok, trocar o caminho do token volta o cartão para "salva" (a verificação antiga não vale para o novo endereço)', async (t) => {
  const s = await montar(t, { ofertas: [oferta(1)] });
  const t1 = await s.post('/api/conexoes/catalogo/testar', {});
  assert.equal(t1.json.ok, true);
  const estado = async () => (await s.get('/api/conexoes')).json.find((p) => p.id === 'catalogo').estado;
  assert.equal(await estado(), 'conectada');
  const outro = path.join(tmp('token2'), 'api_token.txt'); // S1: o arquivo precisa se chamar api_token.txt; muda a pasta
  fs.writeFileSync(outro, `${TOKEN}\n`);
  const put = await pedir(s.port, 'PUT', '/api/conexoes/catalogo', { campos: { endereco: s.srvEt.endereco, caminho_token: outro } });
  assert.equal(put.status, 200, put.txt);
  assert.notEqual(await estado(), 'conectada', 'não herda o "conectada" do caminho antigo');
  assert.equal((await s.get('/api/state')).json.catalogo.estado, 'salva');
});

test('CA8: pedido ao painel com Host de fora (DNS rebinding) é recusado nas rotas do catálogo', async (t) => {
  const s = await montar(t, { ofertas: [oferta(4, 'shopee')] });
  const id = await s.regra({ tag_id: null, sources: [{ type: 'catalogo', tag_id: null, config: { ordem: 'relevancia', lojas: ['shopee'] } }] });
  await s.scheduler.runRule(id);
  const item = idDoItem(s.db, id, 'SHOPEE:123.4');
  const host = { host: 'evil.example' };
  assert.equal((await s.get('/api/catalogo/itens', host)).status, 403);
  assert.equal((await s.get('/api/catalogo/categorias', host)).status, 403);
  assert.equal((await s.post(`/api/catalogo/itens/${item}/enviar`, {}, host)).status, 403);
  assert.equal(itemDe(s.db, id, 'SHOPEE:123.4').status, 'revisao');
});

// ================================================================================== S1/S2 (rodada 2): token e texto com cara de link

test('S2: título, cupom ou categoria com cara de link fazem a oferta ser ignorada (não sai, não vai à revisão) e só contam no aviso', async (t) => {
  const s = await montar(t, { modo: 'fake', ofertas: [
    oferta(10, 'amazon', { titulo: 'Caixa de som http://evil.example/x' }), oferta(11, 'amazon', { cupom: 'USE evil.example/promo' }),
    oferta(12, 'shopee', { categoria: 'Casa https://evil.example' }), oferta(13, 'amazon', { titulo: 'Caixa www.evil.example' }), oferta(1, 'amazon'),
  ] });
  const id = await s.regra({ tag_id: null, per_run: 20, sources: [{ type: 'catalogo', tag_id: null, config: { ordem: 'relevancia', lojas: ['amazon', 'shopee'] } }] });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.revisao], [1, 0]);
  assert.deepEqual(itens(s.db, id).map((i) => i.chave), [`ASIN:${asin(1)}`]);
  assert.ok(s.textos().every((x) => !x.includes('evil.example')));
});

test('S1: o arquivo do token só vale com o nome api_token.txt e sem ser link simbólico: nenhum pedido sai com o outro', async (t) => {
  const s = await montar(t, { ofertas: [oferta(1)] });
  const dir = tmp('token3');
  const pasta = (nome) => path.join(dir, nome);
  fs.writeFileSync(pasta('outro.txt'), `${TOKEN}\n`);
  fs.writeFileSync(pasta('api_token.txt'), `${TOKEN}\n`);
  fs.mkdirSync(pasta('l')); fs.symlinkSync(pasta('api_token.txt'), path.join(pasta('l'), 'api_token.txt'));
  const guarda = JSON.parse(s.db.prepare("SELECT config FROM conexoes WHERE plataforma = 'catalogo'").get().config);
  const testar = async (caminho) => {
    s.db.prepare("UPDATE conexoes SET config = ? WHERE plataforma = 'catalogo'").run(JSON.stringify({ ...guarda, caminho_token: caminho }));
    return (await s.post('/api/conexoes/catalogo/testar', {})).json;
  };
  const antes = s.et.pedidos.length;
  const a = await testar(pasta('outro.txt'));
  const b = await testar(path.join(pasta('l'), 'api_token.txt'));
  assert.deepEqual([a.ok, b.ok], [false, false]);
  assert.equal(s.et.pedidos.length, antes, 'nada foi enviado ao Etiqueta com o token desses caminhos');
  assert.equal((await testar(pasta('api_token.txt'))).ok, true);
  assert.equal(s.et.pedidos.length, antes + 1);
});

// ==================================================================================================== sem rede

test('nenhum teste deste arquivo chamou a rede de fora (fetch global bloqueado fora das portas do teste)', () => {
  assert.equal(chamadasBloqueadas, 0);
});
