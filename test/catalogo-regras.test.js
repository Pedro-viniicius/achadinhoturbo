// Regras com a fonte "catalogo" de ponta a ponta (plano fonte-catalogo-etiqueta, etapa 4; CA1, CA3, CA4, CA5, CA6,
// CA7 e CA8): agendador real (createScheduler), cliente real do Etiqueta (createCatalogo), registro real
// (createCatalogoItens), WhatsApp simulado e links em modo simulado ou de extensão com a extensão feita pelo teste.
// O Etiqueta é falso: servidor HTTP em 127.0.0.1, porta aleatória, e o token é falso, num arquivo de pasta
// temporária. O fetch global só alcança esses servidores; qualquer outro endereço (inclusive localhost:8765, o
// Etiqueta de verdade) lança e é contado.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db.js';
import { createScheduler } from '../src/scheduler.js';
import { createLinkService } from '../src/links.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createCatalogo, filtroDe } from '../src/catalogo.js';
import { createCatalogoItens, TETO_REVISAO } from '../src/catalogo-itens.js';
import { createAmazon } from '../src/amazon.js';
import { candidates, NOME_FONTE } from '../src/ml.js';

// ------------------------------------------------------------------------------- rede só para os servidores locais
const fetchOriginal = globalThis.fetch;
const portasLiberadas = new Set();
let chamadasBloqueadas = 0;
test.before(() => {
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (u.hostname === '127.0.0.1' && portasLiberadas.has(u.port)) return fetchOriginal(url, init);
    chamadasBloqueadas++;
    throw new Error('rede proibida no teste');
  };
});
test.after(() => {
  globalThis.fetch = fetchOriginal;
  assert.equal(chamadasBloqueadas, 0, 'nenhum pedido fora dos servidores do teste');
});

// ------------------------------------------------------------------------------------------------ dados
const TOKEN = `tkFALSO_${randomBytes(30).toString('base64url')}`;
const TAG_AMAZON = 'achadinho-20';
const pastas = [];
const pastaTemp = (nome) => { const p = fs.mkdtempSync(path.join(os.tmpdir(), `catregra-${nome}-`)); pastas.push(p); return p; };
test.after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });

const asin = (i) => `B0${String(i).padStart(8, '0')}`;
const mlb = (i) => `MLB${4000000000 + i}`;
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
 * Etiqueta falso (regras do contrato). Ordem atualizacao: cursor "c<n>" = já entregou n ofertas; vazio → proximo
 * null. Demais ordens: deslocamento; proximo null quando acaba. Guarda cada pedido em estado.pedidos.
 */
async function etiqueta(estado) {
  estado.ofertas ??= [];
  estado.pedidos = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    estado.pedidos.push({ rota: u.pathname, params: [...u.searchParams], headers: { ...req.headers } });
    const responder = (status, corpo) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(corpo)); };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return responder(401, { error: 'token ausente ou inválido' });
    if (u.pathname !== '/api/v1/ofertas') return responder(404, { error: 'rota não encontrada' });
    const limite = Number(u.searchParams.get('limite') ?? 50);
    const ordem = u.searchParams.get('ordem') ?? 'atualizacao';
    const cursor = u.searchParams.get('cursor');
    let inicio = 0;
    if (cursor != null) {
      const m = ordem === 'atualizacao' ? /^c(\d+)$/.exec(cursor) : /^(\d+)$/.exec(cursor);
      if (!m) return responder(400, { error: 'cursor inválido' });
      inicio = Number(m[1]);
    }
    const lojas = u.searchParams.getAll('loja');
    const todas = lojas.length ? estado.ofertas.filter((o) => lojas.includes(o.loja)) : estado.ofertas;
    const pagina = todas.slice(inicio, inicio + limite);
    const fim = inicio + pagina.length;
    const proximo = ordem === 'atualizacao' ? (pagina.length ? `c${fim}` : null) : (fim < todas.length ? String(fim) : null);
    return responder(200, { versao: 1, ofertas: pagina, proximo, total: todas.length });
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const porta = String(srv.address().port);
  portasLiberadas.add(porta);
  return { endereco: `http://127.0.0.1:${porta}`, fechar: () => new Promise((ok) => { srv.close(ok); srv.closeAllConnections?.(); }) };
}

/**
 * Monta o agendador com o catálogo. modoLinks: 'fake' | 'extension' | 'direct'. tagAmazon: '' = sem tag salva.
 * comCatalogo: false = servidor sem o cliente do Etiqueta. → { db, wa, links, estado, conexaoAmazon, scheduler, … }
 */
async function montar(t, { ofertas = [], modoLinks = 'fake', tagAmazon = TAG_AMAZON, comCatalogo = true } = {}) {
  const dir = pastaTemp('db');
  const db = openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true }); await wa.connect();
  const modo = { atual: modoLinks };
  const links = createLinkService({ getMode: () => modo.atual });
  const conexaoAmazon = { tag: tagAmazon };
  const amazon = createAmazon({ db, fetch: async () => { throw new Error('rede proibida (Amazon)'); }, esperar: async () => {}, lerConexao: () => conexaoAmazon });
  const estado = { ofertas };
  const srv = await etiqueta(estado);
  t.after(srv.fechar);
  const caminhoToken = path.join(pastaTemp('token'), 'api_token.txt');
  fs.writeFileSync(caminhoToken, `${TOKEN}\n`, { mode: 0o600 });
  const conexao = { endereco: srv.endereco, caminho_token: caminhoToken };
  const catalogo = comCatalogo ? createCatalogo({ db, lerConexao: () => conexao, timeoutMs: 3000 }) : null;
  const catalogoItens = comCatalogo ? createCatalogoItens({ db, wa, links, amazon }) : null;
  const scheduler = createScheduler({ db, wa, links, fast: true, amazon, catalogo, catalogoItens });
  const now = Date.now();
  for (const [jid, nome] of [['111@g.us', 'Achadinhos'], ['222@g.us', 'Tech']]) {
    db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, nome, 10, now);
  }
  db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etiquetaA', now);
  return { db, wa, links, modo, estado, conexao, conexaoAmazon, catalogo, catalogoItens, scheduler, srv };
}

/** Regra com as fontes dadas (padrão: um catálogo com `cfg`). */
function regra(db, { cfg = {}, fontes = null, tag = 1, per = 3, dedupe = 7, imagem = 0, min = null, grupos = ['111@g.us'], enabled = 1 } = {}) {
  const sources = fontes ?? [{ type: 'catalogo', tag_id: null, config: cfg }];
  return Number(db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id, group_jids, source_type, source_config, sources,
    min_price, per_run, interval_min, window_start, window_end, dedupe_days, send_image, created_at)
    VALUES (?, ?, ?, 1, ?, 'list', '{}', ?, ?, ?, 60, '00:00', '23:59', ?, ?, ?)`)
    .run('Catálogo', enabled, tag, JSON.stringify(grupos), JSON.stringify(sources), min, per, dedupe, imagem, Date.now()).lastInsertRowid);
}

const itens = (db, ruleId) => db.prepare('SELECT chave, loja, status, motivos FROM catalogo_itens WHERE rule_id = ? ORDER BY id').all(ruleId)
  .map((l) => ({ chave: l.chave, loja: l.loja, status: l.status, motivos: JSON.parse(l.motivos) }));
const enviadas = (db, ruleId) => db.prepare('SELECT offer_key FROM sent_offers WHERE rule_id = ? ORDER BY id').all(ruleId).map((l) => l.offer_key);
const cursor = (db, ruleId, cfg) => {
  const l = db.prepare('SELECT cursor, pronto FROM catalogo_cursores WHERE rule_id = ? AND filtro = ?').get(ruleId, filtroDe(cfg));
  return l ? { cursor: l.cursor, pronto: l.pronto } : null;
};
const logs = (db, ruleId) => db.prepare('SELECT level, message, offer_title FROM log WHERE rule_id = ? ORDER BY id').all(ruleId).map((l) => ({ ...l }));
const tudoDoBanco = (db) => JSON.stringify([
  db.prepare('SELECT * FROM log').all(), db.prepare('SELECT * FROM catalogo_itens').all(), db.prepare('SELECT * FROM catalogo_cursores').all(),
  db.prepare("SELECT * FROM settings WHERE key NOT IN ('ext_token', 'pseudo_key')").all(),
]);
const contagens = (db) => ['catalogo_itens', 'catalogo_cursores', 'sent_offers'].map((tb) => db.prepare(`SELECT COUNT(*) AS n FROM ${tb}`).get().n);

// ---------------------------------------------------------------------------------------------------- CA1, CA4

test('CA1/CA4: a regra envia ML e Amazon com o link do dono (nunca o do Etiqueta) e não repete pela chave', async (t) => {
  const s = await montar(t, { ofertas: [oferta(1, 'ml'), oferta(2, 'amazon'), oferta(3, 'ml')] });
  const id = regra(s.db, { cfg: { ordem: 'relevancia' }, per: 3 });

  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages, r.errors, r.revisao], [3, 3, 0, 0]);
  const textos = s.wa.simulated.map((m) => m.text);
  assert.match(textos[0], /https:\/\/meli\.la\/fake-etiquetaA-\d+/, 'ML: meli.la gerado de novo com a etiqueta');
  assert.ok(textos[1].includes(`https://www.amazon.com.br/dp/${asin(2)}?tag=${TAG_AMAZON}`), 'Amazon: remontada com a tag de Conexões');
  assert.match(textos[2], /https:\/\/meli\.la\/fake-etiquetaA-\d+/);
  for (const tx of textos) assert.ok(!tx.includes('terceiro-20') && !tx.includes('TerCeiro1'), 'nenhum link do Etiqueta sai');
  assert.deepEqual(enviadas(s.db, id), [mlb(1), `ASIN:${asin(2)}`, mlb(3)]);
  assert.deepEqual(itens(s.db, id).map((i) => [i.chave, i.status]), [[mlb(1), 'enviado'], [`ASIN:${asin(2)}`, 'enviado'], [mlb(3), 'enviado']]);
  assert.match(logs(s.db, id).find((l) => l.level === 'ok' && l.offer_title === 'Produto 2').message, /^Enviado pela Amazon, com a sua tag$/);

  // pedido ao Etiqueta: limite=200, a ordem da fonte, só Authorization (sem Origin)
  const p = s.estado.pedidos[0];
  assert.deepEqual(p.params, [['ordem', 'relevancia'], ['limite', '200']]);
  assert.equal(p.headers.origin, undefined);

  const r2 = await s.scheduler.runRule(id);
  assert.equal(r2.offers, 0, 'as mesmas ofertas não saem de novo');
  assert.equal(s.wa.simulated.length, 3);
  assert.equal(logs(s.db, id).at(-1).message, 'Sem ofertas novas dentro dos filtros desta vez.');
});

test('CA1/CA3: Novidades começa do fim; o que chega depois sai uma vez só, mesmo com "dias sem repetir" = 0', async (t) => {
  const s = await montar(t, { ofertas: [oferta(1), oferta(2), oferta(3)] });
  const cfg = { lojas: ['amazon'] }; // ordem padrão: atualizacao (Novidades)
  const id = regra(s.db, { cfg, dedupe: 0, per: 5 });

  const r1 = await s.scheduler.runRule(id);
  assert.equal(r1.offers, 0, 'a primeira leitura não despeja o catálogo antigo');
  assert.deepEqual(cursor(s.db, id, cfg), { cursor: 'c3', pronto: 1 });

  s.estado.ofertas.push(oferta(4), oferta(5));
  const r2 = await s.scheduler.runRule(id);
  assert.equal(r2.offers, 2);
  assert.deepEqual(enviadas(s.db, id), [`ASIN:${asin(4)}`, `ASIN:${asin(5)}`]);
  assert.deepEqual(cursor(s.db, id, cfg), { cursor: 'c5', pronto: 1 }, 'a página toda foi tratada: o cursor avança');

  const r3 = await s.scheduler.runRule(id);
  assert.equal(r3.offers, 0);
  assert.equal(s.wa.simulated.length, 2);
});

test('CA3: recusada pelos filtros da regra conta como tratada para o cursor; a que espera segura a página', async (t) => {
  const s = await montar(t, { ofertas: [oferta(1, 'amazon', { preco: 50 }), oferta(2, 'amazon', { preco: 300, preco_antigo: 600 })] });
  const cfg = {};
  const id = regra(s.db, { cfg, min: 150 });
  s.catalogo.recomecar(id); // "Reler do começo": cursor nulo, pronto
  const r = await s.scheduler.runRule(id);
  assert.equal(r.offers, 1);
  assert.deepEqual(enviadas(s.db, id), [`ASIN:${asin(2)}`]);
  assert.deepEqual(cursor(s.db, id, cfg), { cursor: 'c2', pronto: 1 });

  // ML em modo direto: espera (não vai à revisão), não grava nada e o cursor fica
  s.estado.ofertas.push(oferta(3, 'ml', { preco: 300, preco_antigo: 600 }));
  s.modo.atual = 'direct';
  const r2 = await s.scheduler.runRule(id);
  assert.deepEqual([r2.offers, r2.revisao], [0, 0]);
  assert.deepEqual(cursor(s.db, id, cfg), { cursor: 'c2', pronto: 1 });
  assert.equal(itens(s.db, id).length, 1);
  assert.ok(logs(s.db, id).some((l) => l.level === 'aviso' && /^Catálogo do Etiqueta: 1 oferta do Mercado Livre esperando: os links estão no modo direto/.test(l.message)));

  s.modo.atual = 'fake';
  const r3 = await s.scheduler.runRule(id);
  assert.equal(r3.offers, 1);
  assert.deepEqual(cursor(s.db, id, cfg), { cursor: 'c3', pronto: 1 });
});

test('CA4: ML pela extensão — off-line espera; on-line pede o link com a etiqueta; falha do item vai à revisão', async (t) => {
  const s = await montar(t, { ofertas: [oferta(1, 'ml')], modoLinks: 'extension' });
  const id = regra(s.db, { cfg: { ordem: 'relevancia', lojas: ['ml'] } });

  const r1 = await s.scheduler.runRule(id);
  assert.deepEqual([r1.offers, r1.revisao], [0, 0], 'extensão desligada: a oferta espera');
  assert.equal(itens(s.db, id).length, 0);
  assert.ok(logs(s.db, id).some((l) => /1 oferta do Mercado Livre esperando a extensão do Chrome conectar\./.test(l.message)));

  // a extensão conecta: o pedido leva a página do produto e a etiqueta, nunca o link do Etiqueta
  await s.links.poll(1);
  const rodando = s.scheduler.runRule(id);
  const job = await s.links.poll(3000);
  assert.deepEqual([job.type, job.url, job.tag], ['link', `https://produto.mercadolivre.com.br/MLB-${4000000001}`, 'etiquetaA']);
  s.links.submit(job.id, { ok: true, link: 'https://meli.la/Afil01' });
  const r2 = await rodando;
  assert.equal(r2.offers, 1);
  assert.match(s.wa.simulated[0].text, /https:\/\/meli\.la\/Afil01/);
  assert.deepEqual(itens(s.db, id).map((i) => i.status), ['enviado']);

  // outro item: a Central recusa o link → revisão com falha_link, nada enviado
  s.estado.ofertas.push(oferta(2, 'ml'));
  const rodando3 = s.scheduler.runRule(id);
  const job3 = await s.links.poll(3000);
  s.links.submit(job3.id, { ok: false, error: 'a Central recusou' });
  const r3 = await rodando3;
  assert.deepEqual([r3.offers, r3.revisao], [0, 1]);
  assert.equal(s.wa.simulated.length, 1);
  assert.deepEqual(itens(s.db, id)[1], { chave: mlb(2), loja: 'ml', status: 'revisao', motivos: ['falha_link'] });
  assert.ok(!enviadas(s.db, id).includes(mlb(2)));
  assert.ok(logs(s.db, id).some((l) => l.message === 'Separada para revisão: não consegui gerar o link (a Central recusou).'));
});

test('CA4: Amazon sem tag espera; Shopee vai sempre à revisão, sem pedir link', async (t) => {
  const s = await montar(t, { ofertas: [oferta(1, 'amazon'), oferta(2, 'shopee')], tagAmazon: '' });
  s.links.requestLinkShopee = async () => { throw new Error('não deveria pedir link da Shopee'); };
  s.links.requestLink = async () => { throw new Error('não deveria pedir link do ML'); };
  // por envio = 1: a Amazon que espera não ocupa a vaga (a Shopee atrás dela entra)
  const id = regra(s.db, { cfg: { ordem: 'relevancia', lojas: ['amazon', 'shopee'] }, tag: null, per: 1 });

  const r1 = await s.scheduler.runRule(id);
  assert.deepEqual([r1.offers, r1.revisao, r1.errors], [0, 1, 0]);
  assert.equal(s.wa.simulated.length, 0);
  assert.deepEqual(itens(s.db, id), [{ chave: 'SHOPEE:123.2', loja: 'shopee', status: 'revisao', motivos: ['shopee'] }]);
  assert.ok(logs(s.db, id).some((l) => /1 oferta da Amazon esperando: falta a tag de associado em Conexões → Amazon\./.test(l.message)));

  s.conexaoAmazon.tag = TAG_AMAZON;
  const r2 = await s.scheduler.runRule(id);
  assert.deepEqual([r2.offers, r2.revisao], [1, 0], 'com a tag salva, a Amazon sai; a Shopee já está em revisão');
  assert.ok(s.wa.simulated[0].text.includes(`?tag=${TAG_AMAZON}`));
  assert.equal(itens(s.db, id).find((i) => i.loja === 'shopee').status, 'revisao');
});

// --------------------------------------------------------------------------------------------------------- CA5

test('CA5: foto só do CDN da loja da oferta; fora dele, a oferta sai só com texto', async (t) => {
  const s = await montar(t, {
    ofertas: [
      oferta(1, 'ml'), oferta(2, 'amazon'),
      oferta(3, 'amazon', { imagem: 'https://evil.example.com/x.jpg' }),
      oferta(4, 'amazon', { imagem: 'https://http2.mlstatic.com/D_4.jpg' }), // CDN de outra loja
    ],
  });
  const id = regra(s.db, { cfg: { ordem: 'relevancia' }, per: 4, imagem: 1 });
  const r = await s.scheduler.runRule(id);
  assert.equal(r.offers, 4);
  assert.deepEqual(s.wa.simulated.map((m) => [m.tipo, m.image ?? null]), [
    ['image', 'https://http2.mlstatic.com/D_1.jpg'],
    ['image', 'https://m.media-amazon.com/images/I/2.jpg'],
    ['text', null],
    ['text', null],
  ]);
});

test('CA5: no envio a foto é conferida de novo pelo CDN da loja (candidato com foto de fora sai só com texto)', async (t) => {
  const s = await montar(t, { ofertas: [oferta(1, 'amazon'), oferta(2, 'ml')] });
  const original = s.catalogo.candidatos;
  // simula um candidato que escapou do mapeamento: a foto de cada um troca de loja ou vai para fora
  s.catalogo.candidatos = async (...a) => (await original(...a)).map((c, i) => ({ ...c, image: i ? 'https://m.media-amazon.com/images/I/x.jpg' : 'https://evil.example.com/x.jpg' }));
  const id = regra(s.db, { cfg: { ordem: 'relevancia' }, imagem: 1 });
  const r = await s.scheduler.runRule(id);
  assert.equal(r.offers, 2);
  assert.deepEqual(s.wa.simulated.map((m) => m.tipo), ['text', 'text']);
});

// --------------------------------------------------------------------------------------------------------- CA6

test('CA6: catálogo só Amazon/Shopee dispensa a etiqueta do ML; com ML (ou todas as lojas, ou outra fonte) ela é exigida', async (t) => {
  const s = await montar(t, { ofertas: [oferta(1, 'amazon')] });
  const incompleta = (id) => logs(s.db, id).some((l) => l.message === 'Regra incompleta: escolha uma etiqueta.');

  const so = regra(s.db, { cfg: { ordem: 'relevancia', lojas: ['amazon', 'shopee'] }, tag: null });
  const r = await s.scheduler.runRule(so);
  assert.equal(r.offers, 1);
  assert.ok(!incompleta(so));

  for (const fontes of [
    [{ type: 'catalogo', config: { ordem: 'relevancia', lojas: [] } }],
    [{ type: 'catalogo', config: { ordem: 'relevancia', lojas: ['ml'] } }],
    [{ type: 'catalogo', config: { ordem: 'relevancia', lojas: ['amazon'] } }, { type: 'list', config: { items: 'https://produto.mercadolivre.com.br/MLB-1000001-a | Fone | 50' } }],
  ]) {
    const id = regra(s.db, { fontes, tag: null });
    const r2 = await s.scheduler.runRule(id);
    assert.deepEqual([r2.offers, r2.errors], [0, 1], JSON.stringify(fontes));
    assert.ok(incompleta(id), JSON.stringify(fontes));
  }
});

// --------------------------------------------------------------------------------------------------------- CA7

// a separada para revisão não ocupa a vaga: ela é reposta (plano rodar-sozinho-entrega1, CA1.7)
test('CA7: desconto de 100% ou preço antigo ≥ 10× vai à revisão (a vaga é reposta); revisão cheia faz esperar', async (t) => {
  const s = await montar(t, {
    ofertas: [
      oferta(1, 'amazon', { desconto_pct: 100 }),
      oferta(2, 'amazon', { preco: 10, preco_antigo: 100, desconto_pct: 90 }),
      oferta(3, 'amazon'),
      oferta(4, 'amazon'),
    ],
  });
  const id = regra(s.db, { cfg: { ordem: 'relevancia' }, per: 3 });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.revisao], [2, 2], 'as duas suspeitas vão à revisão e as vagas vão às seguintes');
  assert.deepEqual(itens(s.db, id).map((i) => [i.chave, i.status, i.motivos]), [
    [`ASIN:${asin(1)}`, 'revisao', ['desconto_100']],
    [`ASIN:${asin(2)}`, 'revisao', ['preco_antigo']],
    [`ASIN:${asin(3)}`, 'enviado', []],
    [`ASIN:${asin(4)}`, 'enviado', []],
  ]);
  assert.equal(s.wa.simulated.length, 2);
  assert.ok(logs(s.db, id).some((l) => l.message === 'Saíram 2 de 3 ofertas; 2 separadas para revisão; não havia mais ofertas novas dentro dos filtros.'));
  assert.ok(logs(s.db, id).some((l) => l.message === 'Separada para revisão: desconto de 100%, confira o preço.'));

  // revisão cheia (TETO_REVISAO pendentes): a suspeita nova espera, sem entrar nem ocupar a vaga; a normal sai
  const outra = regra(s.db, { cfg: { ordem: 'relevancia' }, per: 1 });
  for (let i = 0; i < TETO_REVISAO; i++) {
    assert.ok(s.catalogoItens.registrar({ id: outra }, { key: `SHOPEE:9.${i}`, title: `P${i}`, price: 10, link: `https://s.shopee.com.br/x${i}` }, 'revisao', ['shopee']));
  }
  s.estado.ofertas.splice(0, 4, oferta(5, 'amazon', { desconto_pct: 100 }), oferta(6, 'amazon'));
  const r2 = await s.scheduler.runRule(outra);
  assert.deepEqual([r2.offers, r2.revisao], [1, 0]);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM catalogo_itens WHERE rule_id = ? AND status = 'revisao'").get(outra).n, TETO_REVISAO);
  assert.ok(!itens(s.db, outra).some((i) => i.chave === `ASIN:${asin(5)}`));
  assert.ok(logs(s.db, outra).some((l) => /^Catálogo do Etiqueta: 1 oferta esperando: a revisão desta regra está cheia\./.test(l.message)));
});

// ------------------------------------------------------------------------------------------- pré-visualização

test('pré-visualização: não grava item, cursor nem envio, e mostra o motivo de revisão e o link por loja', async (t) => {
  const s = await montar(t, { ofertas: [oferta(1, 'ml'), oferta(2, 'amazon'), oferta(3, 'shopee'), oferta(4, 'amazon', { desconto_pct: 100 })] });
  const id = regra(s.db, { cfg: { ordem: 'relevancia' }, per: 4 });
  const antes = contagens(s.db);
  const prev = await s.scheduler.previewOffers(id);
  assert.deepEqual(contagens(s.db), antes, 'nada gravado');
  assert.deepEqual(prev.map((o) => [o.key, o.etiqueta, o.revisao, o.motivos]), [
    [mlb(1), 'etiquetaA', false, []],
    [`ASIN:${asin(2)}`, null, false, []],
    ['SHOPEE:123.3', null, true, ['shopee']],
    [`ASIN:${asin(4)}`, null, true, ['desconto_100']],
  ]);
  assert.ok(prev[0].text.includes('https://meli.la/(gerado no envio)'));
  assert.ok(prev[1].text.includes(`https://www.amazon.com.br/dp/${asin(2)}?tag=•••`), 'a tag não aparece na prévia');
  assert.ok(!prev.some((o) => o.text.includes(TAG_AMAZON)));
  assert.ok(prev[2].text.includes('https://s.shopee.com.br/Ab3cd'));

  // Novidades: a primeira leitura na prévia não cria o cursor
  const nov = regra(s.db, { cfg: { lojas: ['amazon'] } });
  assert.deepEqual(await s.scheduler.previewOffers(nov), []);
  assert.equal(cursor(s.db, nov, { lojas: ['amazon'] }), null);
  assert.deepEqual(contagens(s.db), antes);
});

// ---------------------------------------------------------------------------------------------- falhas, CA8

test('CA8: Etiqueta fora do ar vira "fonte indisponível", sem derrubar o tick; as outras fontes e regras seguem', async (t) => {
  const s = await montar(t, { ofertas: [oferta(1, 'amazon')] });
  await s.srv.fechar();
  const so = regra(s.db, { cfg: { ordem: 'relevancia' } });
  const r = await s.scheduler.runRule(so);
  assert.deepEqual([r.offers, r.errors], [0, 1]);
  assert.equal(logs(s.db, so).at(-1).message, 'Não consegui buscar ofertas: Catálogo do Etiqueta indisponível: o Etiqueta não respondeu.');

  const mista = regra(s.db, { fontes: [
    { type: 'list', config: { items: 'https://produto.mercadolivre.com.br/MLB-1000001-a | Fone A | 50 | 100' } },
    { type: 'catalogo', config: { ordem: 'relevancia' } },
  ] });
  // o tick roda as regras ativas: a do catálogo falha, a mista sai pela lista, nada lança
  s.db.prepare('UPDATE rules SET next_run_at = NULL').run();
  await s.scheduler.tick();
  assert.ok(logs(s.db, mista).some((l) => l.message === 'Fonte ignorada neste envio: fonte 2 (Catálogo do Etiqueta): Catálogo do Etiqueta indisponível: o Etiqueta não respondeu.'));
  assert.deepEqual(enviadas(s.db, mista), ['MLB1000001']);
  assert.ok(!tudoDoBanco(s.db).includes(TOKEN), 'o token não vai a log nem a tabela');
  assert.ok(!tudoDoBanco(s.db).includes(s.conexao.caminho_token), 'nem o caminho do arquivo');
});

test('CA8: sem o cliente do Etiqueta no servidor, a fonte catálogo falha como indisponível', async (t) => {
  const s = await montar(t, { ofertas: [oferta(1, 'amazon')], comCatalogo: false });
  const id = regra(s.db, { cfg: { ordem: 'relevancia' } });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.errors], [0, 1]);
  assert.equal(logs(s.db, id).at(-1).message, 'Não consegui buscar ofertas: Catálogo do Etiqueta indisponível neste servidor.');
  assert.equal(s.estado.pedidos.length, 0);
});

test('o token nunca vai ao console nem ao Histórico numa execução completa', async (t) => {
  const saida = [];
  for (const nome of ['log', 'info', 'warn', 'error']) t.mock.method(console, nome, (...a) => { saida.push(a.join(' ')); });
  const s = await montar(t, { ofertas: [oferta(1, 'ml'), oferta(2, 'amazon'), oferta(3, 'shopee'), oferta(4, 'amazon', { desconto_pct: 100 })] });
  const id = regra(s.db, { cfg: { ordem: 'relevancia' }, per: 4 });
  await s.scheduler.runRule(id);
  await s.scheduler.previewOffers(id);
  assert.ok(!saida.join('\n').includes(TOKEN));
  assert.ok(!tudoDoBanco(s.db).includes(TOKEN));
  assert.ok(s.estado.pedidos.every((p) => !p.params.some(([, v]) => v.includes(TOKEN))), 'nem na URL');
});

test('regra apagada no meio da execução: nada do catálogo é gravado (o id pode ser reaproveitado)', async (t) => {
  const s = await montar(t, { ofertas: [oferta(1, 'amazon'), oferta(2, 'shopee')] });
  const id = regra(s.db, { cfg: { ordem: 'relevancia' } });
  // a regra some enquanto a oferta da Amazon vai ao grupo (antes da Shopee ir à revisão)
  const enviarTexto = s.wa.sendText;
  s.wa.sendText = async (...a) => { s.db.prepare('DELETE FROM rules WHERE id = ?').run(id); return enviarTexto(...a); };
  const r = await s.scheduler.runRule(id);
  assert.equal(s.wa.simulated.length, 1, 'a mensagem já ia sair');
  assert.equal(r.revisao, 0);
  assert.deepEqual(contagens(s.db), [0, 0, 0], 'nem item, nem cursor, nem sent_offers');
  s.wa.sendText = enviarTexto;

  // revisão: a regra some depois da leitura do catálogo
  const outra = regra(s.db, { cfg: { ordem: 'relevancia', lojas: ['shopee'] } });
  const original = s.catalogo.candidatos;
  s.catalogo.candidatos = async (...a) => { const l = await original(...a); s.db.prepare('DELETE FROM rules WHERE id = ?').run(outra); return l; };
  const r2 = await s.scheduler.runRule(outra);
  assert.equal(r2.revisao, 0);
  assert.deepEqual(contagens(s.db), [0, 0, 0]);

  // regra viva: a mesma Shopee vai à revisão (o teste acima não passou por acaso)
  s.catalogo.candidatos = original;
  const viva = regra(s.db, { cfg: { ordem: 'relevancia', lojas: ['shopee'] } });
  assert.equal(viva, id, 'o SQLite reaproveitou o id da regra apagada');
  assert.equal((await s.scheduler.runRule(viva)).revisao, 1);
  assert.deepEqual(itens(s.db, viva), [{ chave: 'SHOPEE:123.2', loja: 'shopee', status: 'revisao', motivos: ['shopee'] }], 'só o item da regra nova');
});

test('createScheduler expõe acordar: pede um tick já (o "Enviar" da revisão do catálogo usa)', async (t) => {
  const s = await montar(t);
  assert.equal(typeof s.scheduler.acordar, 'function');
  let chamou;
  const passou = new Promise((ok) => { chamou = ok; });
  s.scheduler.envios.processarPendentes = async () => { chamou(); };
  s.scheduler.acordar();
  await Promise.race([passou, new Promise((_, falha) => setTimeout(() => falha(new Error('o tick não rodou')), 2000))]);
});

// ------------------------------------------------------------------------------------------------- src/ml.js

test('ml.candidates passa a regra e a posição da fonte ao catálogo e o nome da fonte aparece no aviso', async () => {
  const vistos = [];
  const catalogo = {
    candidatos: async (cfg, ctx) => {
      vistos.push({ cfg, ...ctx });
      if (ctx.fonteIndex === 2) throw new Error('Catálogo do Etiqueta indisponível: o Etiqueta não respondeu.');
      return [{ key: `ASIN:${asin(ctx.fonteIndex)}`, title: 'X', price: 10 }];
    },
  };
  const rule = { id: 7, sources: [
    { type: 'list', config: { items: 'https://produto.mercadolivre.com.br/MLB-1000001-a | Fone | 50' } },
    { type: 'catalogo', tag_id: 3, config: { ordem: 'desconto' } },
    { type: 'catalogo', config: {} },
  ] };
  const paginas = new Map(); const tratada = () => false; const avisos = [];
  const c = await candidates(rule, { catalogo, quer: 2, tratada, paginas, onWarn: (m) => avisos.push(m) });
  assert.deepEqual(c.map((x) => [x.key, x.source_index, x.tag_id]), [['MLB1000001', 0, null], [`ASIN:${asin(1)}`, 1, 3]]);
  assert.deepEqual(vistos.map((v) => [v.rule, v.fonteIndex, v.quer, v.tratada, v.paginas, v.cfg]), [
    [rule, 1, 2, tratada, paginas, { ordem: 'desconto' }],
    [rule, 2, 2, tratada, paginas, {}],
  ]);
  assert.equal(typeof vistos[0].onWarn, 'function');
  assert.deepEqual(avisos, ['Fonte ignorada neste envio: fonte 3 (Catálogo do Etiqueta): Catálogo do Etiqueta indisponível: o Etiqueta não respondeu.']);
  assert.equal(NOME_FONTE.catalogo, 'Catálogo do Etiqueta');
  await assert.rejects(candidates({ id: 1, sources: [{ type: 'catalogo', config: {} }] }, {}), /Catálogo do Etiqueta indisponível neste servidor/);
});

// ------------------------------------------------------------------------------------- rodada 1 de correções

test('R11/S3: ml.candidates passa ao catálogo as chaves das fontes anteriores, utilizavel e previa; na prévia a falha do catálogo não vira aviso', async () => {
  const vistos = [];
  const catalogo = {
    candidatos: async (cfg, ctx) => {
      vistos.push({ fonte: ctx.fonteIndex, vistas: [...ctx.vistas], utilizavel: ctx.utilizavel, previa: ctx.previa });
      if (ctx.fonteIndex === 2) throw new Error('Catálogo do Etiqueta indisponível: o Etiqueta não respondeu.');
      return [{ key: `ASIN:${asin(ctx.fonteIndex)}`, title: 'X', price: 10 }];
    },
  };
  const rule = { id: 7, sources: [
    { type: 'list', config: { items: 'https://produto.mercadolivre.com.br/MLB-1000001-a | Fone | 50' } },
    { type: 'catalogo', config: { ordem: 'desconto' } },
    { type: 'catalogo', config: {} },
  ] };
  const utilizavel = () => true; const avisos = [];
  await candidates(rule, { catalogo, quer: 2, utilizavel, onWarn: (m) => avisos.push(m), previa: true });
  assert.deepEqual(vistos, [
    { fonte: 1, vistas: ['MLB1000001'], utilizavel, previa: true },
    { fonte: 2, vistas: ['MLB1000001', `ASIN:${asin(1)}`], utilizavel, previa: true },
  ]);
  assert.deepEqual(avisos, [], 'prévia: sem aviso da fonte catálogo');
  // só o catálogo, falhando na prévia: o erro continua com a frase da fonte
  await assert.rejects(candidates({ id: 7, sources: [{ type: 'catalogo', config: {} }, { type: 'catalogo', config: {} }] }, { catalogo: { candidatos: async () => { throw new Error('Catálogo do Etiqueta indisponível: o Etiqueta não respondeu.'); } }, previa: true }),
    /fonte 1 \(Catálogo do Etiqueta\): Catálogo do Etiqueta indisponível: o Etiqueta não respondeu\./);
});

test('S3: a pré-visualização não lê Novidades sem cursor pronto e não escreve avisos do catálogo no Histórico', async (t) => {
  const s = await montar(t, { ofertas: [oferta(1), oferta(2, 'ml', { item_id: 'x' })] });
  const nov = regra(s.db, { cfg: { lojas: ['amazon', 'ml'] } });
  assert.deepEqual(await s.scheduler.previewOffers(nov), []);
  assert.equal(s.estado.pedidos.length, 0, 'nenhum pedido ao Etiqueta');
  const rel = regra(s.db, { cfg: { ordem: 'relevancia' } });
  const prev = await s.scheduler.previewOffers(rel);
  assert.deepEqual(prev.map((o) => o.key), [`ASIN:${asin(1)}`]);
  assert.deepEqual([...logs(s.db, nov), ...logs(s.db, rel)], [], 'a oferta fora do formato não vira aviso na prévia');
  await s.scheduler.runRule(rel);
  assert.ok(logs(s.db, rel).some((l) => l.message === 'Catálogo do Etiqueta: 1 oferta ignorada por estar fora do formato esperado.'), 'na execução, vira');
});

test('R3 pelo agendador: envio aprovado sem nenhum grupo ok sai do dedupe no tick e a regra pode trazer a oferta de novo', async (t) => {
  const s = await montar(t, { ofertas: [oferta(4, 'shopee')] });
  const id = regra(s.db, { cfg: { ordem: 'relevancia' }, dedupe: 7 });
  await s.scheduler.runRule(id);
  assert.deepEqual(itens(s.db, id), [{ chave: 'SHOPEE:123.4', loja: 'shopee', status: 'revisao', motivos: ['shopee'] }]);
  const revisao = createCatalogoItens({ db: s.db, wa: s.wa, links: s.links, envios: s.scheduler.envios });
  const item = s.db.prepare('SELECT id FROM catalogo_itens WHERE rule_id = ?').get(id).id;
  const reais = { sendText: s.wa.sendText, sendImage: s.wa.sendImage };
  s.wa.sendText = async () => { throw new Error('socket caiu'); };
  s.wa.sendImage = async () => { throw new Error('socket caiu'); };
  const { envio_id: envioId } = await revisao.enviar(item, {});
  for (let i = 0; i < 300 && ['pendente', 'enviando'].includes(s.db.prepare('SELECT status FROM envios WHERE id = ?').get(envioId).status); i++) await new Promise((ok) => setTimeout(ok, 10));
  Object.assign(s.wa, reais);
  assert.deepEqual(enviadas(s.db, id), ['SHOPEE:123.4'], 'a reserva fica até o agendador passar');
  await s.scheduler.tick();
  assert.deepEqual(enviadas(s.db, id), [], 'o tick tirou a reserva do envio sem grupo ok');
  await s.scheduler.runRule(id);
  assert.deepEqual(itens(s.db, id), [{ chave: 'SHOPEE:123.4', loja: 'shopee', status: 'revisao', motivos: ['shopee'] }], 'voltou para a revisão');
});
