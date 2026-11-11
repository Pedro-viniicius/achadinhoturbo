// Testes de src/catalogo.js (plano fonte-catalogo-etiqueta, etapa 1; CA1, CA3, CA4, CA5, CA6, CA7, CA8 e CA9).
// O Etiqueta é sempre falso: fetch injetado (etiquetaFalsa) ou servidor HTTP em 127.0.0.1, porta aleatória.
// O token é falso, gravado num arquivo de pasta temporária. O fetch global só alcança os servidores deste
// arquivo: qualquer outro endereço (inclusive localhost:8765, o Etiqueta de verdade) lança e é contado.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import util from 'node:util';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { openDb, addLog, getSetting } from '../src/db.js';
import {
  createCatalogo, paraCandidato, motivosDeRevisao, limparFonteCatalogo, precisaEtiqueta, filtroDe,
  enderecoValido, caminhoValido, ErroCatalogo, MENSAGENS_CATALOGO, ERROS_FONTE, fraseDoTeste, emCentavos,
  lerPrecoEm, IDADE_CATALOGO_CONFERIDO_H,
} from '../src/catalogo.js';
import { candidatesFor } from '../src/ml.js';

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
test.after(() => { globalThis.fetch = fetchOriginal; });

// ------------------------------------------------------------------------------------------------ dados
const TOKEN = `tkFALSO_${randomBytes(30).toString('base64url')}`;
const pastas = [];
const pastaTemp = (nome) => { const p = fs.mkdtempSync(path.join(os.tmpdir(), `catalogo-${nome}-`)); pastas.push(p); return p; };
test.after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });

function arquivoToken(conteudo = `${TOKEN}\n`) {
  const p = path.join(pastaTemp('token'), 'api_token.txt');
  fs.writeFileSync(p, conteudo, { mode: 0o600 });
  return p;
}

function banco() {
  const dir = pastaTemp('db');
  const db = openDb(dir);
  return { db, dir };
}

function criarRegra(db, sources, extra = {}) {
  const r = db.prepare("INSERT INTO rules (name, sources, per_run, dedupe_days, created_at) VALUES (?,?,?,?,?)")
    .run(extra.name ?? 'Regra catálogo', JSON.stringify(sources), extra.per_run ?? 3, extra.dedupe_days ?? 7, Date.now());
  return Number(r.lastInsertRowid);
}

const asin = (i) => `B0${String(i).padStart(8, '0')}`;
/** Oferta no formato do contrato v1. */
function oferta(i, loja = 'amazon', mais = {}) {
  const base = {
    id: i, loja, categoria: 'Casa e Decoração', busca: '', titulo: `Produto ${i}`, preco: 100 + i, preco_antigo: 200 + i,
    desconto_pct: 50, vendas: 10, avaliacao: 4.5, num_avaliacoes: 3, frete_gratis: true, cupom: '',
    criado_em: '2026-11-03T12:00:00', atualizado_em: '2026-11-03T12:00:00', genero: 'sem',
  };
  if (loja === 'amazon') Object.assign(base, { item_id: asin(i), link: `https://www.amazon.com.br/dp/${asin(i)}?tag=terceiro-20`, imagem: `https://m.media-amazon.com/images/I/${i}.jpg` });
  if (loja === 'ml') Object.assign(base, { item_id: `MLB${4000000000 + i}`, link: 'https://meli.la/AbC123', imagem: `https://http2.mlstatic.com/D_${i}.jpg` });
  if (loja === 'shopee') Object.assign(base, { item_id: `123.${i}`, link: `https://s.shopee.com.br/Ab${i}cd`, imagem: `https://down-br.img.susercontent.com/file/${i}`, preco_antigo: null, desconto_pct: 0 });
  base.chave = `${loja}:${base.item_id}`;
  return { ...base, ...mais };
}

const categoriasResposta = {
  versao: 1, total: 30,
  categorias: [
    { nome: 'Casa e Decoração', total: 10, lojas: { amazon: 5, ml: 5, shopee: 0 }, generos: { feminino: 0, masculino: 0, unissex: 0, sem: 10 } },
    { nome: 'Perfumes e Perfumaria', total: 20, lojas: { amazon: 10, ml: 0, shopee: 10 }, generos: { feminino: 5, masculino: 5, unissex: 5, sem: 5 } },
  ],
};

/**
 * Etiqueta falsa (regras do contrato). ordem atualizacao: cursor "c<n>" = já entregou n ofertas; vazio → proximo
 * null. Demais: deslocamento; proximo null quando acaba. estado.cursorRuim = true faz o 400 de cursor.
 * Responde { status, corpo } e guarda cada pedido em estado.pedidos.
 */
function etiqueta(estado = {}) {
  estado.ofertas ??= [];
  estado.pedidos ??= [];
  return (urlTexto, headers = {}) => {
    const u = new URL(urlTexto);
    estado.pedidos.push({ url: urlTexto, headers: { ...headers }, rota: u.pathname, params: [...u.searchParams] });
    if (estado.forcar) return estado.forcar(u, headers);
    if (headers.authorization !== `Bearer ${TOKEN}`) return { status: 401, corpo: { error: 'token ausente ou inválido: envie Authorization: Bearer <token>' } };
    if (u.pathname === '/api/v1/categorias') return { status: 200, corpo: estado.categorias ?? categoriasResposta };
    if (u.pathname !== '/api/v1/ofertas') return { status: 404, corpo: { error: 'rota não encontrada' } };
    const limite = Number(u.searchParams.get('limite') ?? 50);
    const ordem = u.searchParams.get('ordem') ?? 'atualizacao';
    const cursor = u.searchParams.get('cursor');
    const todas = estado.ofertas;
    let inicio = 0;
    if (cursor != null) {
      if (estado.cursorRuim) return { status: 400, corpo: { error: 'cursor inválido' } };
      const m = ordem === 'atualizacao' ? /^c(\d+)$/.exec(cursor) : /^(\d+)$/.exec(cursor);
      if (!m) return { status: 400, corpo: { error: 'cursor inválido' } };
      inicio = Number(m[1]);
    }
    const pagina = todas.slice(inicio, inicio + limite);
    const fim = inicio + pagina.length;
    const proximo = ordem === 'atualizacao' ? (pagina.length ? `c${fim}` : null) : (fim < todas.length ? String(fim) : null);
    return { status: 200, corpo: { versao: 1, ofertas: pagina, proximo, total: todas.length } };
  };
}

/** fetch falso sobre a etiqueta: guarda { url, init } de cada chamada. */
function fetchDe(responder) {
  const chamadas = [];
  const f = async (url, init = {}) => {
    chamadas.push({ url: String(url), init });
    const h = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const { status, corpo } = await responder(String(url), h);
    return new Response(corpo == null ? null : JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
  };
  f.chamadas = chamadas;
  return f;
}

/** Servidor HTTP local (127.0.0.1, porta aleatória) que responde pela etiqueta. → { endereco, fechar, emVoo } */
async function servidor(responder, { atraso = 0 } = {}) {
  const info = { maxEmVoo: 0, emVoo: 0, cabecalhos: [] };
  const srv = http.createServer(async (req, res) => {
    info.emVoo++; info.maxEmVoo = Math.max(info.maxEmVoo, info.emVoo);
    info.cabecalhos.push({ ...req.headers });
    try {
      if (atraso) await new Promise((ok) => setTimeout(ok, atraso));
      const r = await responder(`http://${req.headers.host}${req.url}`, req.headers, req, res);
      if (r === 'manual') return;
      const corpo = r.bruto ?? JSON.stringify(r.corpo);
      res.writeHead(r.status, { 'content-type': 'application/json; charset=utf-8', ...(r.headers ?? {}) });
      res.end(corpo);
    } finally { info.emVoo--; }
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const porta = String(srv.address().port);
  portasLiberadas.add(porta);
  info.endereco = `http://127.0.0.1:${porta}`;
  info.fechar = () => new Promise((ok) => { srv.closeAllConnections?.(); srv.close(() => ok()); portasLiberadas.delete(porta); });
  return info;
}

function cliente({ db, fetch, endereco = 'http://127.0.0.1:8765', caminho, agora, timeoutMs, orcamentoMs } = {}) {
  const conexao = { endereco, caminho_token: caminho };
  const cat = createCatalogo({ db: db ?? banco().db, fetch, lerConexao: () => conexao, agora, timeoutMs, orcamentoMs });
  return { cat, conexao };
}

/** Lê todos os arquivos de uma pasta (banco e WAL) e diz se algum contém o texto. */
function pastaContem(dir, texto) {
  return fs.readdirSync(dir).some((f) => fs.readFileSync(path.join(dir, f)).includes(Buffer.from(texto)));
}

const ctxDe = (ruleId, mais = {}) => ({ rule: { id: ruleId }, fonteIndex: 0, quer: 3, paginas: new Map(), ...mais });
const cursorSalvo = (db, ruleId) => db.prepare('SELECT filtro, cursor, pronto FROM catalogo_cursores WHERE rule_id = ? ORDER BY filtro').all(ruleId).map((r) => ({ ...r }));

// ============================================================================================ validações puras

test('endereço só local (D3) e caminho do token', () => {
  for (const ok of ['http://localhost:8765', 'http://127.0.0.1:8765', 'http://127.0.0.1:1', 'http://localhost:65535']) assert.equal(enderecoValido(ok), true, ok);
  for (const ruim of ['https://localhost:8765', 'http://localhost', 'http://localhost:8765/', 'http://localhost:8765/api',
    'http://exemplo.com:8765', 'http://127.0.0.2:8765', 'http://user:x@localhost:8765', 'http://localhost:0', 'http://localhost:65536',
    'http://[::1]:8765', ' http://localhost:8765', 'http://localhost:8765?x=1', null, 8765]) {
    assert.equal(enderecoValido(ruim), false, String(ruim));
  }
  assert.equal(caminhoValido('/home/u/api_token.txt'), true);
  assert.equal(caminhoValido('~/Documentos/api_token.txt'), true);
  for (const ruim of ['api_token.txt', TOKEN, `/${TOKEN}`, `~/${TOKEN}`, '', '/', '/a\nb', `/${'a'.repeat(501)}`, '~user/x', null]) assert.equal(caminhoValido(ruim), false, String(ruim).slice(0, 20));
});

test('limparFonteCatalogo: padrões, normalização e 400 com frase fixa que não ecoa o valor', () => {
  assert.deepEqual(limparFonteCatalogo(undefined), { categorias: [], lojas: [], q: '', desconto_min: null, ordem: 'atualizacao' });
  assert.deepEqual(limparFonteCatalogo({ categorias: ['Casa'], lojas: ['shopee', 'amazon'], q: ' air fryer, fritadeira ', desconto_min: '30', ordem: 'desconto', extra: 1 }),
    { categorias: ['Casa'], lojas: ['shopee', 'amazon'], q: 'air fryer, fritadeira', desconto_min: 30, ordem: 'desconto' });
  assert.equal(limparFonteCatalogo({ desconto_min: 0 }).desconto_min, 0);
  assert.equal(limparFonteCatalogo({ desconto_min: '' }).desconto_min, null);

  const VALOR = '<img src=x onerror=alert(1)>';
  const casos = [
    [{ categorias: Array.from({ length: 21 }, (_, i) => `c${i}`) }, ERROS_FONTE.categorias],
    [{ categorias: ['a', 'a'] }, ERROS_FONTE.categoria],
    [{ categorias: [''] }, ERROS_FONTE.categoria],
    [{ categorias: ['x'.repeat(201)] }, ERROS_FONTE.categoria],
    [{ categorias: [VALOR, 3] }, ERROS_FONTE.categoria],
    [{ categorias: VALOR }, ERROS_FONTE.categoria],
    [{ lojas: ['ml', 'ml'] }, ERROS_FONTE.lojas],
    [{ lojas: [VALOR] }, ERROS_FONTE.lojas],
    [{ q: 'a,,b' }, ERROS_FONTE.q],
    [{ q: ',a' }, ERROS_FONTE.q],
    [{ q: 'x'.repeat(201) }, ERROS_FONTE.q],
    [{ q: Array.from({ length: 11 }, (_, i) => `t${i}`).join(',') }, ERROS_FONTE.q],
    [{ q: 5 }, ERROS_FONTE.q],
    [{ desconto_min: 100 }, ERROS_FONTE.desconto_min],
    [{ desconto_min: -1 }, ERROS_FONTE.desconto_min],
    [{ desconto_min: 2.5 }, ERROS_FONTE.desconto_min],
    [{ desconto_min: true }, ERROS_FONTE.desconto_min],
    [{ desconto_min: VALOR }, ERROS_FONTE.desconto_min],
    [{ ordem: 'aleatoria' }, ERROS_FONTE.ordem],
    [{ ordem: VALOR }, ERROS_FONTE.ordem],
  ];
  for (const [cfg, frase] of casos) {
    assert.throws(() => limparFonteCatalogo(cfg), (e) => {
      assert.equal(e.message, frase, JSON.stringify(cfg).slice(0, 60));
      assert.ok(!e.message.includes('onerror'));
      return true;
    });
  }
});

test('filtroDe: 16 hex, igual com as listas em outra ordem, diferente com outro filtro', () => {
  const a = filtroDe({ categorias: ['B', 'A'], lojas: ['ml', 'amazon'] });
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(a, filtroDe({ categorias: ['A', 'B'], lojas: ['amazon', 'ml'], ordem: 'atualizacao' }));
  assert.notEqual(a, filtroDe({ categorias: ['A', 'B'], lojas: ['amazon'] }));
  assert.notEqual(a, filtroDe({ categorias: ['A', 'B'], lojas: ['amazon', 'ml'], q: 'x' }));
});

test('precisaEtiqueta (D8, CA6): só catálogo sem ML dispensa a etiqueta', () => {
  const cat = (lojas) => ({ type: 'catalogo', config: { lojas } });
  assert.equal(precisaEtiqueta([cat(['amazon'])]), false);
  assert.equal(precisaEtiqueta([cat(['amazon', 'shopee']), cat(['shopee'])]), false);
  assert.equal(precisaEtiqueta([cat(['amazon', 'ml'])]), true);
  assert.equal(precisaEtiqueta([cat([])]), true, 'nenhuma loja marcada = as três, inclusive o ML');
  assert.equal(precisaEtiqueta([{ type: 'catalogo', config: {} }]), true);
  assert.equal(precisaEtiqueta([cat(['amazon']), { type: 'list', config: { items: 'x' } }]), true);
  assert.equal(precisaEtiqueta([{ type: 'afiliados' }]), true);
  assert.equal(precisaEtiqueta([]), true);
  assert.equal(precisaEtiqueta(undefined), true);
});

// ============================================================================================ oferta → candidato

test('paraCandidato: ML vira MLB<n> com a página do produto, sem o meli.la do Etiqueta (CA4)', () => {
  const c = paraCandidato(oferta(1, 'ml'));
  assert.equal(c.key, 'MLB4000000001');
  assert.equal(c.loja, 'ml');
  assert.equal(c.plataforma, 'mercadolivre');
  assert.equal(c.url, 'https://produto.mercadolivre.com.br/MLB-4000000001');
  assert.equal(c.link, undefined);
  assert.ok(!JSON.stringify(c).includes('meli.la'));
  assert.equal(c.title, 'Produto 1');
  assert.equal(c.image, 'https://http2.mlstatic.com/D_1.jpg');
  // item_id que não é MLB<n> (itens antigos trazem a URL) é ignorado
  assert.equal(paraCandidato(oferta(1, 'ml', { item_id: 'https://produto.mercadolivre.com.br/MLB-123456789' })), null);
  assert.equal(paraCandidato(oferta(1, 'ml', { item_id: 'MLB12' })), null);
});

test('paraCandidato: Amazon vira ASIN:<asin>, URL sem tag e sem o link de terceiro (CA4)', () => {
  const c = paraCandidato(oferta(7, 'amazon', { item_id: 'b0abcdef12' }));
  assert.equal(c.key, 'ASIN:B0ABCDEF12');
  assert.equal(c.asin, 'B0ABCDEF12');
  assert.equal(c.url, 'https://www.amazon.com.br/dp/B0ABCDEF12');
  assert.equal(c.plataforma, 'amazon');
  assert.equal(c.link, undefined);
  assert.ok(!JSON.stringify(c).includes('tag='));
  assert.equal(paraCandidato(oferta(7, 'amazon', { item_id: 'B0ABC' })), null);
});

test('paraCandidato: Shopee só com link s.shopee.com.br e item <shop>.<item>', () => {
  const c = paraCandidato(oferta(5, 'shopee'));
  assert.equal(c.key, 'SHOPEE:123.5');
  assert.equal(c.link, 'https://s.shopee.com.br/Ab5cd');
  assert.equal(c.url, c.link);
  assert.equal(c.oldPrice, null);
  for (const link of ['https://shopee.com.br/produto-i.1.2', 'http://s.shopee.com.br/Abcd', 'https://s.shopee.com.br/Ab/../x', 'https://evil.com/s.shopee.com.br/x', null]) {
    assert.equal(paraCandidato(oferta(5, 'shopee', { link })), null, String(link));
  }
  assert.equal(paraCandidato(oferta(5, 'shopee', { item_id: '123' })), null);
  assert.equal(paraCandidato(oferta(5, 'shopee', { item_id: '1.2.3' })), null);
});

test('paraCandidato: oferta que não fecha é ignorada', () => {
  for (const [nome, o] of [
    ['loja desconhecida', oferta(1, 'amazon', { loja: 'magalu' })],
    ['loja do protótipo', oferta(1, 'amazon', { loja: 'constructor' })],
    ['título vazio', oferta(1, 'amazon', { titulo: '   ' })],
    ['título não texto', oferta(1, 'amazon', { titulo: 5 })],
    ['preço 0', oferta(1, 'amazon', { preco: 0 })],
    ['preço texto', oferta(1, 'amazon', { preco: '10' })],
    ['preço infinito', oferta(1, 'amazon', { preco: Infinity })],
    ['nulo', null], ['lista', []], ['texto', 'x'],
  ]) assert.equal(paraCandidato(o), null, nome);
});

test('paraCandidato: discountPct do contrato (não recalculado), preço antigo só se maior, campos opcionais', () => {
  // Shopee: sem preço antigo, mas com desconto do contrato; não pode virar 0
  assert.equal(paraCandidato(oferta(2, 'shopee', { desconto_pct: 37 })).discountPct, 37);
  // o contrato manda 30 com preços que dariam 50: vale o do contrato
  assert.equal(paraCandidato(oferta(2, 'amazon', { preco: 100, preco_antigo: 200, desconto_pct: 30 })).discountPct, 30);
  // fora do formato: conta local; acima de 100 fica em 100 (vai à revisão)
  assert.equal(paraCandidato(oferta(2, 'amazon', { preco: 100, preco_antigo: 200, desconto_pct: null })).discountPct, 50);
  assert.equal(paraCandidato(oferta(2, 'amazon', { desconto_pct: 250 })).discountPct, 100);
  const c = paraCandidato(oferta(2, 'amazon', { preco: 100, preco_antigo: 90, vendas: -3, frete_gratis: 'sim', cupom: '  CUPOM10 ' }));
  assert.equal(c.oldPrice, null);
  assert.equal(c.sold, 0);
  assert.equal(c.freeShipping, false);
  assert.equal(c.coupon, 'CUPOM10');
  assert.equal(paraCandidato(oferta(2, 'amazon', { cupom: '' })).coupon, null);
  // texto cru chega cru (o painel escapa: CA9), mas numa linha só e com teto
  const cru = paraCandidato(oferta(2, 'amazon', { titulo: '<b>"x"</b>\n<img onerror=1>', categoria: '<script>' }));
  assert.equal(cru.title, '<b>"x"</b> <img onerror=1>');
  assert.equal(cru.categoria, '<script>');
  assert.ok(paraCandidato(oferta(2, 'amazon', { titulo: 'palavra '.repeat(100) })).title.length <= 200);
});

test('paraCandidato: foto só do CDN da própria loja (CA5)', () => {
  const foto = (loja, imagem) => paraCandidato(oferta(3, loja, { imagem })).image;
  assert.equal(foto('ml', 'https://http2.mlstatic.com/D_1.jpg'), 'https://http2.mlstatic.com/D_1.jpg');
  assert.equal(foto('amazon', 'https://m.media-amazon.com/images/I/1.jpg'), 'https://m.media-amazon.com/images/I/1.jpg');
  assert.equal(foto('shopee', 'https://down-br.img.susercontent.com/file/1'), 'https://down-br.img.susercontent.com/file/1');
  // CDN de outra loja, http, host parecido ou fora: recusado
  assert.equal(foto('ml', 'https://m.media-amazon.com/images/I/1.jpg'), null);
  assert.equal(foto('amazon', 'https://http2.mlstatic.com/D_1.jpg'), null);
  assert.equal(foto('shopee', 'https://m.media-amazon.com/images/I/1.jpg'), null);
  assert.equal(foto('amazon', 'http://m.media-amazon.com/images/I/1.jpg'), null);
  assert.equal(foto('ml', 'https://mlstatic.com.evil.com/x.jpg'), null);
  assert.equal(foto('amazon', 'https://evil.com/x.jpg'), null);
  assert.equal(foto('amazon', `https://m.media-amazon.com/${'a'.repeat(5000)}`), null);
  assert.equal(foto('amazon', null), null);
});

test('motivosDeRevisao (D5, CA4, CA7): Shopee, desconto 100% e preço antigo ≥ 10×', () => {
  assert.deepEqual(motivosDeRevisao(paraCandidato(oferta(1, 'amazon'))), []);
  assert.deepEqual(motivosDeRevisao(paraCandidato(oferta(1, 'ml'))), []);
  assert.deepEqual(motivosDeRevisao(paraCandidato(oferta(1, 'shopee'))), ['shopee']);
  assert.deepEqual(motivosDeRevisao(paraCandidato(oferta(1, 'amazon', { preco: 10, preco_antigo: 10000, desconto_pct: 100 }))), ['desconto_100', 'preco_antigo']);
  assert.deepEqual(motivosDeRevisao(paraCandidato(oferta(1, 'amazon', { preco: 10, preco_antigo: 100, desconto_pct: 90 }))), ['preco_antigo']);
  assert.deepEqual(motivosDeRevisao(paraCandidato(oferta(1, 'amazon', { preco: 10, preco_antigo: 99.99, desconto_pct: 90 }))), []);
  assert.deepEqual(motivosDeRevisao(paraCandidato(oferta(1, 'shopee', { desconto_pct: 100 }))), ['shopee', 'desconto_100']);
  assert.deepEqual(motivosDeRevisao(null), []);
});

// ============================================================================================ token e conexão

test('sem caminho ou endereço válido: nenhuma leitura e nenhuma rede (D2, D3)', async () => {
  const f = fetchDe(etiqueta());
  const caminho = arquivoToken();
  for (const conexao of [
    { endereco: 'http://127.0.0.1:8765' },
    { endereco: 'http://127.0.0.1:8765', caminho_token: '' },
    { caminho_token: caminho },
    { endereco: 'https://127.0.0.1:8765', caminho_token: caminho },
    { endereco: 'http://exemplo.com:80', caminho_token: caminho },
    { endereco: 'http://127.0.0.1:8765/api', caminho_token: caminho },
    { endereco: 'http://127.0.0.1:8765', caminho_token: 'api_token.txt' },
    { endereco: 'http://127.0.0.1:8765', caminho_token: `/${TOKEN}` }, // o próprio token no campo: nunca é lido
    { endereco: ' http://127.0.0.1:8765', caminho_token: caminho },
  ]) {
    const { db } = banco();
    const cat = createCatalogo({ db, fetch: f, lerConexao: () => conexao });
    const r = await cat.testar();
    assert.equal(r.resultado, 'nao_configurada');
    assert.equal(r.ok, false);
    assert.equal(r.mensagem, 'Salve o endereço e o caminho do token para testar.');
    assert.deepEqual(cat.situacao(), { estado: 'falta_configurar', resultado: 'nao_configurada', verificado_em: null, falha_desde: null });
    await assert.rejects(cat.candidatos({}, ctxDe(1)), (e) => e instanceof ErroCatalogo && e.resultado === 'nao_configurada');
    assert.equal(getSetting(db, 'catalogo_verificacao'), null);
  }
  assert.equal(f.chamadas.length, 0);
});

test('sem lerConexao: lê endereço e caminho da linha catalogo de conexoes', async () => {
  const { db } = banco();
  const f = fetchDe(etiqueta());
  const cat = createCatalogo({ db, fetch: f });
  assert.equal((await cat.testar()).resultado, 'nao_configurada');
  db.prepare("INSERT INTO conexoes (plataforma, config, segredos) VALUES ('catalogo', ?, '{}')")
    .run(JSON.stringify({ endereco: 'http://127.0.0.1:8765', caminho_token: arquivoToken() }));
  assert.equal((await cat.testar()).resultado, 'ok');
  assert.equal(f.chamadas.length, 1);
});

test('arquivo do token: ausente, vazio, curto, fora do formato, grande, pasta, FIFO e link simbólico, sem enviar nada', { timeout: 10000 }, async () => {
  const f = fetchDe(etiqueta());
  const dir = pastaTemp('arquivos');
  // cada caso numa pasta própria, com o nome do arquivo do Etiqueta (S1: outro nome nem é configuração válida)
  const lugar = (nome) => { const d = path.join(dir, nome.replace(/\W/g, '_')); fs.mkdirSync(d); return path.join(d, 'api_token.txt'); };
  const casos = [
    ['ausente', null, 'sem_arquivo'],
    ['vazio', '', 'arquivo_invalido'],
    ['curto', 'abc123', 'arquivo_invalido'],
    ['com espaço no meio', `${TOKEN.slice(0, 20)} ${TOKEN.slice(20)}`, 'arquivo_invalido'],
    ['não ASCII', `${TOKEN}é`, 'arquivo_invalido'],
    ['duas linhas', `${TOKEN}\n${TOKEN}`, 'arquivo_invalido'],
    ['grande', `${TOKEN}${' '.repeat(5000)}`, 'arquivo_invalido'],
    ['pasta', 'pasta', 'arquivo_invalido'],
  ];
  for (const [nome, conteudo, esperado] of casos) {
    const caminho = lugar(nome);
    if (conteudo === 'pasta') fs.mkdirSync(caminho);
    else if (conteudo != null) fs.writeFileSync(caminho, conteudo);
    const { cat } = cliente({ fetch: f, caminho });
    const r = await cat.testar();
    assert.equal(r.resultado, esperado, nome);
    assert.equal(cat.situacao().estado, 'sem_arquivo', nome);
    assert.ok(!r.mensagem.includes(TOKEN.slice(0, 20)), nome);
  }
  // FIFO: recusado na hora (lstat antes de abrir; O_NONBLOCK se trocarem no meio), sem esperar alguém escrever nele
  const fifo = lugar('fifo');
  let temFifo = true;
  try { execFileSync('mkfifo', [fifo]); } catch { temFifo = false; }
  if (temFifo) {
    const { cat } = cliente({ fetch: f, caminho: fifo });
    assert.equal((await cat.testar()).resultado, 'arquivo_invalido');
  }
  // S1: link simbólico com o nome certo, apontando para um token válido (ou para um arquivo qualquer): recusado
  const alvo = arquivoToken();
  const link = lugar('link');
  fs.symlinkSync(alvo, link);
  assert.equal((await cliente({ fetch: f, caminho: link }).cat.testar()).resultado, 'arquivo_invalido', 'link simbólico');
  // S1: arquivo com o token válido, mas com outro nome: não é configuração (nenhuma leitura, nenhuma rede)
  const outroNome = path.join(path.dirname(alvo), 'token.txt');
  fs.copyFileSync(alvo, outroNome);
  for (const caminho of [outroNome, `${alvo}/`, path.join(path.dirname(alvo), 'xapi_token.txt'), `${alvo}.bak`]) {
    assert.equal(caminhoValido(caminho), false, caminho);
    const { cat } = cliente({ fetch: f, caminho });
    assert.equal((await cat.testar()).resultado, 'nao_configurada', caminho);
    assert.equal(cat.situacao().estado, 'falta_configurar', caminho);
  }
  assert.equal(f.chamadas.length, 0);
  // espaços e quebras de linha nas pontas valem
  const { cat } = cliente({ fetch: f, caminho: arquivoToken(`  \n${TOKEN}\r\n\n`) });
  assert.equal((await cat.testar()).resultado, 'ok');
  // mensagem sem_arquivo traz o caminho (é do dono), nunca o conteúdo
  const sem = cliente({ fetch: f, caminho: '/nao/existe/api_token.txt' });
  assert.equal((await sem.cat.testar()).mensagem, 'Não encontrei o arquivo do token em /nao/existe/api_token.txt. Confira o caminho, e se este programa tem permissão para ler o arquivo.');
});

test('caminho com ~/ é relativo à pasta pessoal', async (t) => {
  const casa = pastaTemp('casa');
  fs.mkdirSync(path.join(casa, 'etiqueta'));
  fs.writeFileSync(path.join(casa, 'etiqueta', 'api_token.txt'), TOKEN);
  const antes = process.env.HOME;
  t.after(() => { process.env.HOME = antes; });
  process.env.HOME = casa;
  const { cat } = cliente({ fetch: fetchDe(etiqueta()), caminho: '~/etiqueta/api_token.txt' });
  assert.equal((await cat.testar()).resultado, 'ok');
});

test('o token é lido do arquivo a cada pedido (D2): trocar o arquivo vale no pedido seguinte', async () => {
  const estado = {};
  const f = fetchDe(etiqueta(estado));
  const caminho = arquivoToken();
  const { cat } = cliente({ fetch: f, caminho });
  assert.equal((await cat.testar()).resultado, 'ok');
  const outro = `outro_${randomBytes(30).toString('base64url')}`;
  fs.writeFileSync(caminho, outro);
  assert.equal((await cat.testar()).resultado, 'token_recusado');
  assert.equal(f.chamadas[1].init.headers.Authorization, `Bearer ${outro}`);
  fs.writeFileSync(caminho, TOKEN);
  assert.equal((await cat.testar()).resultado, 'ok');
});

test('pedido: só GET, só o cabeçalho Authorization, redirect:error, limite=200 e token fora da URL (fetch falso)', async () => {
  const { db } = banco();
  const ruleId = criarRegra(db, [{ type: 'catalogo', config: { ordem: 'relevancia' } }]);
  const estado = { ofertas: [oferta(1), oferta(2, 'ml')] };
  const f = fetchDe(etiqueta(estado));
  const { cat } = cliente({ db, fetch: f, caminho: arquivoToken() });
  await cat.testar();
  await cat.candidatos({ categorias: ['Casa e Decoração', 'Perfumes'], lojas: ['amazon', 'ml'], q: 'air fryer', desconto_min: 30, ordem: 'relevancia' }, ctxDe(ruleId));
  assert.equal(f.chamadas.length, 2);
  for (const { url, init } of f.chamadas) {
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    assert.deepEqual(Object.keys(init.headers), ['Authorization']);
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(init.body, undefined);
    assert.ok(!url.includes(TOKEN) && !url.includes('token'), url);
    assert.ok(url.startsWith('http://127.0.0.1:8765/api/v1/'));
  }
  const params = estado.pedidos[1].params;
  assert.deepEqual(params, [['cat', 'Casa e Decoração'], ['cat', 'Perfumes'], ['loja', 'amazon'], ['loja', 'ml'], ['q', 'air fryer'],
    ['desconto_min', '30'], ['ordem', 'relevancia'], ['limite', '200']]);
  assert.equal(estado.pedidos[0].params.length, 0, 'categorias não aceita parâmetros');
});

test('servidor local: sem Origin nem Sec-Fetch-Site, Authorization certo e categorias guardadas', async (t) => {
  const estado = {};
  const srv = await servidor(etiqueta(estado));
  t.after(srv.fechar);
  const { db } = banco();
  const caminhoDoTeste = arquivoToken();
  const { cat } = cliente({ db, fetch: undefined, endereco: srv.endereco, caminho: caminhoDoTeste, agora: () => 1_000 });
  const r = await cat.testar();
  assert.deepEqual(r, {
    ok: true, resultado: 'ok', total: 30, mensagem: 'Conectado. 30 ofertas em 2 categorias.',
    categorias: [
      { nome: 'Casa e Decoração', total: 10, lojas: { amazon: 5, ml: 5, shopee: 0 } },
      { nome: 'Perfumes e Perfumaria', total: 20, lojas: { amazon: 10, ml: 0, shopee: 10 } },
    ],
  });
  const h = srv.cabecalhos[0];
  assert.equal(h.authorization, `Bearer ${TOKEN}`);
  assert.equal(h.origin, undefined);
  assert.equal(h['sec-fetch-site'], undefined);
  assert.equal(h.cookie, undefined);
  assert.equal(chamadasBloqueadas, 0);
  // verificação guardada no banco (sem o token), no formato combinado com src/conexoes.js (o de
  // GET /api/catalogo/categorias) mais resultado e impressão; lida de novo por outra instância (persiste ao reiniciar)
  const v = JSON.parse(getSetting(db, 'catalogo_verificacao'));
  assert.deepEqual(Object.keys(v).sort(), ['categorias', 'impressao', 'resultado', 'total', 'verificado_em']);
  assert.equal(v.resultado, 'ok');
  assert.equal(v.verificado_em, 1_000);
  assert.equal(v.total, 30);
  assert.deepEqual(v.categorias, r.categorias);
  for (const c of v.categorias) {
    assert.deepEqual(Object.keys(c), ['nome', 'total', 'lojas']);
    assert.deepEqual(Object.keys(c.lojas), ['amazon', 'ml', 'shopee']);
  }
  assert.match(v.impressao, /^[0-9a-f]{16}$/);
  const reiniciado = createCatalogo({ db, lerConexao: () => ({ endereco: srv.endereco, caminho_token: v && caminhoDoTeste }) });
  assert.equal(reiniciado.situacao().estado, 'conectada', 'outra instância lê a verificação do banco');
  const outroCaminho = createCatalogo({ db, lerConexao: () => ({ endereco: srv.endereco, caminho_token: arquivoToken() }) });
  assert.equal(outroCaminho.situacao().estado, 'salva', 'outro caminho: a verificação antiga não vale');
  const semCaminho = cliente({ db, endereco: srv.endereco, caminho: undefined });
  assert.equal(semCaminho.cat.situacao().estado, 'falta_configurar');
  assert.deepEqual(cat.ultimaVerificacao(), { resultado: 'ok', verificado_em: 1_000, total: 30, categorias: r.categorias });
});

test('redirecionamento não é seguido: o token nunca vai a outro endereço', async (t) => {
  const alvo = [];
  const srv = await servidor((url, headers, req) => {
    if (req.url.startsWith('/destino')) { alvo.push(headers.authorization ?? null); return { status: 200, corpo: categoriasResposta }; }
    return { status: 302, corpo: {}, headers: { location: '/destino' } };
  });
  t.after(srv.fechar);
  const { cat } = cliente({ endereco: srv.endereco, caminho: arquivoToken() });
  const r = await cat.testar();
  assert.equal(r.resultado, 'fora_do_ar');
  assert.deepEqual(alvo, []);
  // com um fetch que não segue (falso), 3xx é resposta inesperada
  const f = fetchDe(() => ({ status: 302, corpo: null }));
  assert.equal((await cliente({ fetch: f, caminho: arquivoToken() }).cat.testar()).resultado, 'resposta_inesperada');
});

test('tempo esgotado vira fora_do_ar', async (t) => {
  const srv = await servidor(() => 'manual');
  t.after(srv.fechar);
  const { cat } = cliente({ endereco: srv.endereco, caminho: arquivoToken(), timeoutMs: 150 });
  const r = await cat.testar();
  assert.equal(r.resultado, 'fora_do_ar');
  assert.equal(cat.situacao().estado, 'indisponivel');
});

test('respostas do Etiqueta: 401, 503, 5xx, rede, 4xx, JSON ruim, versão e corpo grande', async () => {
  const casos = [
    ['401', () => ({ status: 401, corpo: { error: 'x' } }), 'token_recusado', 'token_recusado'],
    ['503', () => ({ status: 503, corpo: { error: 'x' } }), 'desligada', 'indisponivel'],
    ['500', () => ({ status: 500, corpo: { error: 'x' } }), 'fora_do_ar', 'indisponivel'],
    ['502', () => ({ status: 502, corpo: null }), 'fora_do_ar', 'indisponivel'],
    ['rede', () => { throw new Error('ECONNREFUSED'); }, 'fora_do_ar', 'indisponivel'],
    ['400', () => ({ status: 400, corpo: { error: 'x' } }), 'resposta_inesperada', 'indisponivel'],
    ['403', () => ({ status: 403, corpo: { error: 'a API v1 não aceita pedidos de navegador' } }), 'resposta_inesperada', 'indisponivel'],
    ['404', () => ({ status: 404, corpo: { error: 'x' } }), 'resposta_inesperada', 'indisponivel'],
    ['204', () => ({ status: 204, corpo: null }), 'resposta_inesperada', 'indisponivel'],
    ['versão 2', () => ({ status: 200, corpo: { ...categoriasResposta, versao: 2 } }), 'resposta_inesperada', 'indisponivel'],
    ['sem versão', () => ({ status: 200, corpo: { categorias: [] } }), 'resposta_inesperada', 'indisponivel'],
    ['categoria sem lojas', () => ({ status: 200, corpo: { versao: 1, categorias: [{ nome: 'x', total: 1 }] } }), 'resposta_inesperada', 'indisponivel'],
    ['total negativo', () => ({ status: 200, corpo: { versao: 1, categorias: [{ nome: 'x', total: -1, lojas: { amazon: 0, ml: 0, shopee: 0 } }] } }), 'resposta_inesperada', 'indisponivel'],
    ['lista', () => ({ status: 200, corpo: [1, 2] }), 'resposta_inesperada', 'indisponivel'],
  ];
  for (const [nome, resp, resultado, estado] of casos) {
    const f = fetchDe(async () => resp());
    const { cat } = cliente({ fetch: f, caminho: arquivoToken() });
    const r = await cat.testar();
    assert.equal(r.resultado, resultado, nome);
    assert.equal(r.ok, false, nome);
    assert.deepEqual(r.categorias, [], nome);
    assert.equal(cat.situacao().estado, estado, nome);
  }
  // JSON quebrado e corpo acima de 2 MiB (servidor de verdade)
  for (const [nome, bruto] of [['JSON quebrado', '{"versao": 1, "categ'], ['corpo grande', `{"versao":1,"categorias":[],"x":"${'a'.repeat(2 * 1024 * 1024)}"}`]]) {
    const srv = await servidor(() => ({ status: 200, bruto }));
    try {
      const { cat } = cliente({ endereco: srv.endereco, caminho: arquivoToken() });
      assert.equal((await cat.testar()).resultado, 'resposta_inesperada', nome);
    } finally { await srv.fechar(); }
  }
  // frases da spec por resultado
  assert.equal(fraseDoTeste('fora_do_ar', { endereco: 'http://localhost:8765' }),
    'Não consegui falar com o Etiqueta em http://localhost:8765. Confira se ele está ligado (python3 servidor.py) e se o endereço e a porta estão certos.');
  assert.equal(fraseDoTeste('ok', { total: 3853, categorias: 12 }), 'Conectado. 3.853 ofertas em 12 categorias.');
  assert.equal(fraseDoTeste('ok', { total: 1, categorias: 1 }), 'Conectado. 1 oferta em 1 categoria.');
});

test('teste que falha mantém as categorias anteriores; situacao e falha_desde seguem o último pedido', async () => {
  const { db } = banco();
  let relogio = 100;
  const estado = {};
  const f = fetchDe(etiqueta(estado));
  const { cat } = cliente({ db, fetch: f, caminho: arquivoToken(), agora: () => relogio });
  assert.deepEqual(cat.situacao(), { estado: 'salva', resultado: null, verificado_em: null, falha_desde: null });
  await cat.testar();
  assert.deepEqual(cat.situacao(), { estado: 'conectada', resultado: 'ok', verificado_em: 100, falha_desde: null });

  estado.forcar = () => ({ status: 503, corpo: { error: 'x' } });
  relogio = 200;
  const r = await cat.testar();
  assert.equal(r.resultado, 'desligada');
  assert.deepEqual(cat.situacao(), { estado: 'indisponivel', resultado: 'desligada', verificado_em: 200, falha_desde: 200 });
  assert.equal(cat.ultimaVerificacao().categorias.length, 2, 'as categorias do último teste aceito ficam');

  // pedido de candidatos que falha depois (rede): a situação passa a ser a do pedido; falha_desde continua 200
  const ruleId = criarRegra(db, [{ type: 'catalogo', config: { ordem: 'relevancia' } }]);
  relogio = 300;
  estado.forcar = () => { throw new Error('rede'); };
  await assert.rejects(cat.candidatos({ ordem: 'relevancia' }, ctxDe(ruleId)), (e) => e.resultado === 'fora_do_ar' && e.message === MENSAGENS_CATALOGO.fora_do_ar);
  assert.deepEqual(cat.situacao(), { estado: 'indisponivel', resultado: 'fora_do_ar', verificado_em: 300, falha_desde: 200 });

  // sucesso zera falha_desde
  estado.forcar = null;
  estado.ofertas = [oferta(1)];
  relogio = 400;
  await cat.candidatos({ ordem: 'relevancia' }, ctxDe(ruleId));
  assert.deepEqual(cat.situacao(), { estado: 'conectada', resultado: 'ok', verificado_em: 400, falha_desde: null });
  estado.forcar = () => ({ status: 401, corpo: {} });
  relogio = 500;
  await assert.rejects(cat.candidatos({ ordem: 'relevancia' }, ctxDe(ruleId)), (e) => e.resultado === 'token_recusado');
  assert.deepEqual(cat.situacao(), { estado: 'token_recusado', resultado: 'token_recusado', verificado_em: 500, falha_desde: 500 });
});

test('dois pedidos simultâneos saem em fila: nunca dois ao mesmo tempo no Etiqueta (CA3)', async (t) => {
  const estado = { ofertas: Array.from({ length: 450 }, (_, i) => oferta(i + 1)) };
  const srv = await servidor(etiqueta(estado), { atraso: 40 });
  t.after(srv.fechar);
  const { db } = banco();
  const ruleId = criarRegra(db, [{ type: 'catalogo', config: { ordem: 'relevancia' } }]);
  const { cat } = cliente({ db, endereco: srv.endereco, caminho: arquivoToken() });
  const ctx = ctxDe(ruleId, { quer: 20 }); // alvo 80: uma página basta
  const ctx2 = ctxDe(ruleId, { quer: 200 }); // alvo 800: lê as 3 páginas
  const [a, b, c] = await Promise.all([cat.testar(), cat.candidatos({ ordem: 'relevancia' }, ctx), cat.candidatos({ ordem: 'desconto' }, ctx2), cat.testar()]);
  assert.equal(a.resultado, 'ok');
  assert.equal(b.length, 200);
  assert.equal(c.length, 450);
  assert.equal(srv.cabecalhos.length, 1 + 1 + 3 + 1);
  assert.equal(srv.maxEmVoo, 1);
  // uma falha no meio não trava a fila
  estado.forcar = () => ({ status: 500, corpo: {} });
  const falhas = await Promise.allSettled([cat.testar(), cat.testar()]);
  assert.deepEqual(falhas.map((x) => x.value.resultado), ['fora_do_ar', 'fora_do_ar']);
  estado.forcar = null;
  assert.equal((await cat.testar()).resultado, 'ok');
  assert.equal(srv.maxEmVoo, 1);
});

// ============================================================================================ token fora de tudo (CA8)

test('o token não aparece em URL, erro, mensagem, situação, console, log nem no banco (CA8)', async () => {
  const { db, dir } = banco();
  const ruleId = criarRegra(db, [{ type: 'catalogo', config: { ordem: 'relevancia' } }]);
  const capturado = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug, out: process.stdout.write, err: process.stderr.write };
  const pegar = (...a) => { capturado.push(a.map((x) => (typeof x === 'string' ? x : util.inspect(x))).join(' ')); };
  const erros = [];
  const respostas = [];
  // o fetch falha com o token na mensagem (como uma biblioteca que repete o cabeçalho): nada disso pode vazar
  const vazador = async (url, init) => { throw new Error(`falhou: ${init.headers.Authorization}`); };
  const estados = [
    (url, init) => { throw Object.assign(new TypeError('fetch failed'), { cause: new Error(String(init.headers.Authorization)) }); },
    async (url, init) => new Response(JSON.stringify({ error: `token ${init.headers.Authorization}` }), { status: 401 }),
    async (url, init) => new Response(JSON.stringify({ error: `token ${init.headers.Authorization}` }), { status: 503 }),
    async (url, init) => new Response(`{"versao":1, ${init.headers.Authorization}`, { status: 200 }),
    async (url, init) => new Response(JSON.stringify({ versao: 1, ofertas: [{ titulo: init.headers.Authorization }], proximo: null }), { status: 200 }),
  ];
  console.log = console.error = console.warn = console.info = console.debug = pegar;
  // stdout/stderr seguem escrevendo (o runner do node:test usa o stdout entre os awaits)
  process.stdout.write = function (s, ...r) { capturado.push(String(s)); return orig.out.call(this, s, ...r); };
  process.stderr.write = function (s, ...r) { capturado.push(String(s)); return orig.err.call(this, s, ...r); };
  try {
    for (const f of [vazador, ...estados]) {
      const cat = createCatalogo({ db, fetch: f, lerConexao: () => ({ endereco: 'http://127.0.0.1:8765', caminho_token: arquivoToken() }) });
      respostas.push(await cat.testar());
      const ctx = ctxDe(ruleId, { onWarn: (m) => addLog(db, { rule: { id: ruleId, name: 'r' }, level: 'aviso', message: m }) });
      try { respostas.push(await cat.candidatos({ ordem: 'relevancia' }, ctx)); } catch (e) { erros.push(e); }
      respostas.push(cat.situacao(), cat.ultimaVerificacao());
    }
  } finally {
    Object.assign(console, { log: orig.log, error: orig.error, warn: orig.warn, info: orig.info, debug: orig.debug });
    process.stdout.write = orig.out; process.stderr.write = orig.err;
  }
  assert.ok(erros.length >= 4);
  for (const e of erros) {
    assert.ok(e instanceof ErroCatalogo);
    assert.equal(e.cause, undefined);
    assert.ok(!util.inspect(e, { depth: 5 }).includes(TOKEN));
    assert.ok(!String(e.stack).includes(TOKEN));
    assert.ok(!JSON.stringify(e).includes(TOKEN));
  }
  const tudo = JSON.stringify(respostas) + capturado.join('\n');
  assert.ok(!tudo.includes(TOKEN));
  assert.ok(!tudo.includes(TOKEN.slice(8, 30)), 'nem um pedaço do token');
  const linhasLog = db.prepare('SELECT message FROM log').all().map((r) => r.message).join('\n');
  assert.ok(!linhasLog.includes(TOKEN));
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  assert.ok(!pastaContem(dir, TOKEN), 'o token não pode estar no banco nem no WAL');
  assert.ok(!pastaContem(dir, TOKEN.slice(8, 30)));
});

// ============================================================================================ candidatos: demais ordens (D7)

test('demais ordens: lê do início até max(quer×4, 20) não tratadas, pula tratadas, no máximo 10 páginas, sem gravar', async () => {
  const { db } = banco();
  const ruleId = criarRegra(db, [{ type: 'catalogo', config: { ordem: 'desconto' } }]);
  const estado = { ofertas: Array.from({ length: 2500 }, (_, i) => oferta(i + 1)) };
  const f = fetchDe(etiqueta(estado));
  const { cat } = cliente({ db, fetch: f, caminho: arquivoToken() });
  const modos = new Set();
  // as 190 primeiras já foram tratadas: a 1ª página dá 10 novas (menos que o alvo 20, quer 2), a 2ª completa
  const tratada = (c, modo) => { modos.add(modo); return Number(c.asin.slice(2)) <= 190; };
  const ctx = ctxDe(ruleId, { quer: 2, tratada });
  const out = await cat.candidatos({ ordem: 'desconto' }, ctx);
  assert.deepEqual([...modos], ['desconto'], 'modo = a ordem da fonte, como em catalogoItens.tratada');
  assert.equal(estado.pedidos.length, 2, 'parou quando passou do alvo');
  assert.equal(out.length, 210);
  assert.equal(out[0].key, `ASIN:${asin(191)}`);
  assert.deepEqual(estado.pedidos.map((p) => new URLSearchParams(p.params).get('cursor')), [null, '200']);
  assert.ok(estado.pedidos.every((p) => new URLSearchParams(p.params).get('limite') === '200'));
  estado.pedidos.length = 0;
  const out2 = await cat.candidatos({ ordem: 'desconto' }, ctxDe(ruleId, { quer: 2, tratada: (c) => Number(c.asin.slice(2)) <= 2390 }));
  assert.equal(estado.pedidos.length, 10, 'no máximo 10 páginas');
  assert.equal(out2.length, 0);
  // nada gravado em cursores; registra só o que leu
  assert.deepEqual(cursorSalvo(db, ruleId), []);
  assert.equal(ctx.paginas.get(0).modo, 'ordem');
  // repetidas (deslocamento que andou) saem uma vez só
  estado.ofertas = [oferta(1), oferta(2), oferta(1), oferta(3, 'ml'), oferta(4, 'ml', { item_id: 'x' })];
  const avisos = [];
  const out3 = await cat.candidatos({ ordem: 'menor_preco' }, ctxDe(ruleId, { onWarn: (m) => avisos.push(m) }));
  assert.deepEqual(out3.map((c) => c.key), [`ASIN:${asin(1)}`, `ASIN:${asin(2)}`, 'MLB4000000003']);
  assert.deepEqual(avisos, ['Catálogo do Etiqueta: 1 oferta ignorada por estar fora do formato esperado.']);
});

test('candidatos com config inválida: erro de validação com frase fixa e sem rede', async () => {
  const f = fetchDe(etiqueta());
  const { cat } = cliente({ fetch: f, caminho: arquivoToken() });
  await assert.rejects(cat.candidatos({ ordem: 'aleatoria' }, ctxDe(1)), { message: ERROS_FONTE.ordem });
  assert.equal(f.chamadas.length, 0);
});

// ============================================================================================ Novidades e cursor (D6, CA3)

const NOV = { categorias: ['Casa e Decoração'], ordem: 'atualizacao' };

test('Novidades, primeira leitura: avança até o fim sem enviar; só grava no avancar', async () => {
  const { db } = banco();
  const ruleId = criarRegra(db, [{ type: 'catalogo', config: NOV }]);
  const estado = { ofertas: Array.from({ length: 450 }, (_, i) => oferta(i + 1)) };
  const f = fetchDe(etiqueta(estado));
  const { cat } = cliente({ db, fetch: f, caminho: arquivoToken() });
  const ctx = ctxDe(ruleId);
  const out = await cat.candidatos(NOV, ctx);
  assert.deepEqual(out, []);
  assert.deepEqual(estado.pedidos.map((p) => new URLSearchParams(p.params).get('cursor')), [null, 'c200', 'c400', 'c450']);
  assert.ok(estado.pedidos.every((p) => new URLSearchParams(p.params).get('limite') === '200'));
  assert.deepEqual(cursorSalvo(db, ruleId), [], 'candidatos (e a pré-visualização) não gravam');
  const r = cat.avancar(ruleId, ctx.paginas, () => false);
  assert.deepEqual(r, [{ fonteIndex: 0, filtro: filtroDe(NOV), paginas_avancadas: 0, pronto: true }]);
  assert.deepEqual(cursorSalvo(db, ruleId), [{ filtro: filtroDe(NOV), cursor: 'c450', pronto: 1 }]);

  // depois: só o que chegar; sem novidade, vazio com proximo:null mantém o cursor
  estado.pedidos.length = 0;
  const ctx2 = ctxDe(ruleId);
  assert.deepEqual(await cat.candidatos(NOV, ctx2), []);
  cat.avancar(ruleId, ctx2.paginas, () => true);
  assert.deepEqual(cursorSalvo(db, ruleId), [{ filtro: filtroDe(NOV), cursor: 'c450', pronto: 1 }]);
  assert.equal(new URLSearchParams(estado.pedidos[0].params).get('cursor'), 'c450');

  estado.ofertas.push(oferta(451), oferta(452, 'ml'));
  const ctx3 = ctxDe(ruleId);
  const novas = await cat.candidatos(NOV, ctx3);
  assert.deepEqual(novas.map((c) => c.key), [`ASIN:${asin(451)}`, 'MLB4000000452']);
});

test('Novidades, primeira leitura grande: até 20 páginas por execução, pronto=0 até achar o fim', async () => {
  const { db } = banco();
  const ruleId = criarRegra(db, [{ type: 'catalogo', config: NOV }]);
  const estado = { ofertas: Array.from({ length: 4500 }, (_, i) => oferta(i + 1)) };
  const { cat } = cliente({ db, fetch: fetchDe(etiqueta(estado)), caminho: arquivoToken() });
  const ctx = ctxDe(ruleId);
  await cat.candidatos(NOV, ctx);
  assert.equal(estado.pedidos.length, 20);
  cat.avancar(ruleId, ctx.paginas, () => false);
  assert.deepEqual(cursorSalvo(db, ruleId), [{ filtro: filtroDe(NOV), cursor: 'c4000', pronto: 0 }]);
  // próxima execução continua do cursor e acha o fim (2 páginas + a vazia)
  estado.pedidos.length = 0;
  const ctx2 = ctxDe(ruleId);
  assert.deepEqual(await cat.candidatos(NOV, ctx2), []);
  assert.deepEqual(estado.pedidos.map((p) => new URLSearchParams(p.params).get('cursor')), ['c4000', 'c4200', 'c4400', 'c4500']);
  cat.avancar(ruleId, ctx2.paginas, () => false);
  assert.deepEqual(cursorSalvo(db, ruleId), [{ filtro: filtroDe(NOV), cursor: 'c4500', pronto: 1 }]);
});

test('Novidades: catálogo vazio na primeira leitura fica pronto com cursor nulo (tudo que chegar é novidade)', async () => {
  const { db } = banco();
  const ruleId = criarRegra(db, [{ type: 'catalogo', config: NOV }]);
  const estado = { ofertas: [] };
  const { cat } = cliente({ db, fetch: fetchDe(etiqueta(estado)), caminho: arquivoToken() });
  const ctx = ctxDe(ruleId);
  await cat.candidatos(NOV, ctx);
  cat.avancar(ruleId, ctx.paginas, () => false);
  assert.deepEqual(cursorSalvo(db, ruleId), [{ filtro: filtroDe(NOV), cursor: null, pronto: 1 }]);
  estado.ofertas.push(oferta(1));
  assert.equal((await cat.candidatos(NOV, ctxDe(ruleId))).length, 1);
});

test('Novidades: o cursor só passa da página inteira tratada; a parcial é relida (nada se perde)', async () => {
  const { db } = banco();
  const ruleId = criarRegra(db, [{ type: 'catalogo', config: NOV }]);
  const estado = { ofertas: Array.from({ length: 10 }, (_, i) => oferta(i + 1)) };
  const { cat } = cliente({ db, fetch: fetchDe(etiqueta(estado)), caminho: arquivoToken() });
  cat.recomecar(ruleId); // varredura do zero: cursor nulo, pronto
  assert.deepEqual(cursorSalvo(db, ruleId), [{ filtro: filtroDe(NOV), cursor: null, pronto: 1 }]);

  const tratadas = new Set();
  const modos = new Set();
  const tratada = (c, modo) => { modos.add(modo); return tratadas.has(c.key); };
  const ctx = ctxDe(ruleId, { tratada });
  const lidas = await cat.candidatos(NOV, ctx);
  assert.equal(lidas.length, 10);
  assert.deepEqual([...modos], ['atualizacao']);
  // a regra tratou 3 (enviadas/revisão/recusadas pelo filtro): a página não fecha, o cursor não anda
  for (const c of lidas.slice(0, 3)) tratadas.add(c.key);
  assert.deepEqual(cat.avancar(ruleId, ctx.paginas, tratada), [{ fonteIndex: 0, filtro: filtroDe(NOV), paginas_avancadas: 0, pronto: true }]);
  assert.deepEqual(cursorSalvo(db, ruleId), [{ filtro: filtroDe(NOV), cursor: null, pronto: 1 }]);
  // na próxima execução, as 7 restantes voltam (as tratadas não)
  const ctx2 = ctxDe(ruleId, { tratada });
  const resto = await cat.candidatos(NOV, ctx2);
  assert.deepEqual(resto.map((c) => c.key), lidas.slice(3).map((c) => c.key));
  for (const c of resto) tratadas.add(c.key);
  cat.avancar(ruleId, ctx2.paginas, tratada);
  assert.deepEqual(cursorSalvo(db, ruleId), [{ filtro: filtroDe(NOV), cursor: 'c10', pronto: 1 }]);
});

test('Novidades: várias páginas, para na primeira não tratada; oferta fora do formato não prende', async () => {
  const { db } = banco();
  const ruleId = criarRegra(db, [{ type: 'catalogo', config: NOV }]);
  const estado = { ofertas: Array.from({ length: 450 }, (_, i) => oferta(i + 1)) };
  estado.ofertas[5] = oferta(6, 'ml', { item_id: 'lixo' }); // ignorada: não segura a página 1
  const { cat } = cliente({ db, fetch: fetchDe(etiqueta(estado)), caminho: arquivoToken() });
  cat.recomecar(ruleId);
  const ctx = ctxDe(ruleId, { quer: 50 }); // alvo 200: lê 2 páginas (199 válidas na 1ª)
  const lidas = await cat.candidatos(NOV, ctx);
  assert.equal(estado.pedidos.length, 2);
  assert.equal(lidas.length, 399);
  // tratadas: toda a página 1 e metade da 2
  const ok = new Set(lidas.slice(0, 299).map((c) => c.key));
  cat.avancar(ruleId, ctx.paginas, (c) => ok.has(c.key));
  assert.deepEqual(cursorSalvo(db, ruleId), [{ filtro: filtroDe(NOV), cursor: 'c200', pronto: 1 }]);
  // tratada que lança conta como não tratada (o cursor não anda)
  const ctx2 = ctxDe(ruleId);
  await cat.candidatos(NOV, ctx2);
  cat.avancar(ruleId, ctx2.paginas, () => { throw new Error('x'); });
  assert.deepEqual(cursorSalvo(db, ruleId), [{ filtro: filtroDe(NOV), cursor: 'c200', pronto: 1 }]);
});

test('Novidades: cursor recusado (400) volta ao avanço até o fim e avisa', async () => {
  const { db } = banco();
  const ruleId = criarRegra(db, [{ type: 'catalogo', config: NOV }]);
  const estado = { ofertas: Array.from({ length: 300 }, (_, i) => oferta(i + 1)) };
  const { cat } = cliente({ db, fetch: fetchDe(etiqueta(estado)), caminho: arquivoToken() });
  db.prepare('INSERT INTO catalogo_cursores (rule_id, filtro, cursor, pronto) VALUES (?,?,?,1)').run(ruleId, filtroDe(NOV), 'cursor-de-outra-versao');
  const avisos = [];
  const ctx = ctxDe(ruleId, { onWarn: (m) => avisos.push(m) });
  assert.deepEqual(await cat.candidatos(NOV, ctx), []);
  assert.deepEqual(avisos, ['Catálogo do Etiqueta: o cursor salvo foi recusado. A leitura recomeça do fim do catálogo; só o que chegar ou for atualizado depois sai.']);
  assert.deepEqual(estado.pedidos.map((p) => new URLSearchParams(p.params).get('cursor')), ['cursor-de-outra-versao', null, 'c200', 'c300']);
  assert.equal(cat.situacao().estado, 'conectada', 'cursor recusado não é fonte indisponível');
  cat.avancar(ruleId, ctx.paginas, () => false);
  assert.deepEqual(cursorSalvo(db, ruleId), [{ filtro: filtroDe(NOV), cursor: 'c300', pronto: 1 }]);
  // 400 sem cursor (ou em outra ordem) é resposta inesperada
  estado.forcar = () => ({ status: 400, corpo: { error: 'x' } });
  await assert.rejects(cat.candidatos({ ordem: 'relevancia' }, ctxDe(ruleId)), (e) => e.resultado === 'resposta_inesperada');
});

test('Novidades: página fora do contrato vira resposta_inesperada', async () => {
  const { db } = banco();
  const ruleId = criarRegra(db, [{ type: 'catalogo', config: NOV }]);
  for (const corpo of [
    { versao: 1, ofertas: 'x', proximo: null },
    { versao: 2, ofertas: [], proximo: null },
    { versao: 1, ofertas: [], proximo: 5 },
    { versao: 1, ofertas: Array.from({ length: 201 }, (_, i) => oferta(i)), proximo: 'c1' },
    { versao: 1, ofertas: [], proximo: 'x'.repeat(501) },
  ]) {
    const { cat } = cliente({ db, fetch: fetchDe(() => ({ status: 200, corpo })), caminho: arquivoToken() });
    await assert.rejects(cat.candidatos(NOV, ctxDe(ruleId)), (e) => e.resultado === 'resposta_inesperada');
  }
  assert.deepEqual(cursorSalvo(db, ruleId), []);
});

test('filtro mudou: cursor novo (começa do fim de novo); recomecar marca todas as fontes Novidades da regra', async () => {
  const { db } = banco();
  const outro = { ...NOV, lojas: ['amazon'] };
  const ruleId = criarRegra(db, [
    { type: 'catalogo', config: NOV }, { type: 'catalogo', config: outro },
    { type: 'catalogo', config: { ordem: 'relevancia' } }, { type: 'list', config: { items: 'x' } },
    { type: 'catalogo', config: { ordem: 'aleatoria' } },
  ]);
  const estado = { ofertas: [oferta(1)] };
  const { cat } = cliente({ db, fetch: fetchDe(etiqueta(estado)), caminho: arquivoToken() });
  const ctx = ctxDe(ruleId);
  await cat.candidatos(NOV, ctx);
  cat.avancar(ruleId, ctx.paginas, () => false);
  assert.deepEqual(cursorSalvo(db, ruleId).map((r) => r.filtro), [filtroDe(NOV)]);
  // o outro filtro nunca foi lido: primeira leitura de novo
  const ctx2 = ctxDe(ruleId, { fonteIndex: 1 });
  assert.deepEqual(await cat.candidatos(outro, ctx2), []);
  assert.equal(ctx2.paginas.get(1).modo, 'fim');

  assert.equal(cat.recomecar(ruleId), 2);
  const esperado = [filtroDe(NOV), filtroDe(outro)].sort().map((filtro) => ({ filtro, cursor: null, pronto: 1 }));
  assert.deepEqual(cursorSalvo(db, ruleId), esperado);
  assert.equal(cat.recomecar(9999), 0);
});

test('esquecerRegra apaga os cursores; avancar de regra apagada não grava nada', async () => {
  const { db } = banco();
  const ruleId = criarRegra(db, [{ type: 'catalogo', config: NOV }]);
  const outra = criarRegra(db, [{ type: 'catalogo', config: NOV }]);
  const estado = { ofertas: [oferta(1)] };
  const { cat } = cliente({ db, fetch: fetchDe(etiqueta(estado)), caminho: arquivoToken() });
  cat.recomecar(ruleId);
  cat.recomecar(outra);
  const ctx = ctxDe(ruleId);
  await cat.candidatos(NOV, ctx);
  cat.esquecerRegra(ruleId);
  db.prepare('DELETE FROM rules WHERE id = ?').run(ruleId);
  assert.deepEqual(cat.avancar(ruleId, ctx.paginas, () => true), []);
  assert.deepEqual(cursorSalvo(db, ruleId), []);
  assert.equal(cursorSalvo(db, outra).length, 1, 'a outra regra fica');
  assert.deepEqual(cat.avancar(outra, null, () => true), []);
});

// ============================================================================================ rodada 1 de correções

/** fetch falso que demora `atraso` ms e respeita o AbortSignal (como o fetch de verdade). */
function fetchLento(responder, atraso) {
  const f = fetchDe(responder);
  const lento = async (url, init = {}) => {
    await new Promise((ok, falha) => {
      const tm = setTimeout(ok, atraso);
      init.signal?.addEventListener('abort', () => { clearTimeout(tm); falha(new DOMException('abortado', 'AbortError')); }, { once: true });
    });
    return f(url, init);
  };
  lento.chamadas = f.chamadas;
  return lento;
}

test('Q6: motivosDeRevisao compara o "10×" em centavos inteiros (0,33 × 10 = 3,30, sem ponto flutuante)', () => {
  assert.deepEqual([emCentavos(0.33), emCentavos(3.3), emCentavos('1.10'), emCentavos(null), emCentavos(''), emCentavos('x'), emCentavos(Infinity)], [33, 330, 110, null, null, null, null]);
  for (const [preco, antigo] of [[0.33, 3.3], [0.07, 0.7], [1.1, 11], [0.29, 2.9], [10, 100], [0.01, 0.1]]) {
    assert.deepEqual(motivosDeRevisao({ loja: 'amazon', price: preco, oldPrice: antigo, discountPct: 90 }), ['preco_antigo'], `${preco} × 10 = ${antigo}`);
  }
  for (const [preco, antigo] of [[0.33, 3.29], [10, 99.99], [1.1, 10.99]]) {
    assert.deepEqual(motivosDeRevisao({ loja: 'amazon', price: preco, oldPrice: antigo, discountPct: 90 }), [], `${preco} / ${antigo}`);
  }
});

test('S2: título, cupom ou categoria com cara de link (…bit.ly/x, +bit.ly/x, @menção) tornam a oferta ignorada', () => {
  for (const [campo, valor] of [['titulo', 'Fone ...bit.ly/x'], ['titulo', 'Fone +bit.ly/x'], ['titulo', 'Fone evil.example/promo'], ['titulo', 'Fale com @vendedor'],
    ['cupom', '...bit.ly/x'], ['cupom', '+bit.ly/x'], ['categoria', 'Casa bit.ly/x'], ['categoria', '+bit.ly/x']]) {
    assert.equal(paraCandidato(oferta(1, 'amazon', { [campo]: valor })), null, `${campo}: ${valor}`);
  }
  // o normal segue: preço com ponto, "Amazon.com.br" sozinho, cupom e categoria comuns
  assert.ok(paraCandidato(oferta(1, 'amazon', { titulo: 'Echo Dot 5ª geração Amazon.com.br 3.5mm', cupom: 'PROMO10', categoria: 'Casa e Decoração' })));
});

test('Q4/Q5: só as ofertas utilizáveis contam para o alvo; as recusadas ou que esperam não prendem a leitura', async () => {
  const { db } = banco();
  const ruleId = criarRegra(db, [{ type: 'catalogo', config: { ordem: 'relevancia' } }]);
  // 400 baratas (inutilizáveis) e depois 30 boas
  const estado = { ofertas: [...Array.from({ length: 400 }, (_, i) => oferta(i + 1, 'amazon', { preco: 5 })), ...Array.from({ length: 30 }, (_, i) => oferta(1000 + i))] };
  const { cat } = cliente({ db, fetch: fetchDe(etiqueta(estado)), caminho: arquivoToken() });
  const utilizavel = (c) => c.price >= 100;
  const out = await cat.candidatos({ ordem: 'relevancia' }, ctxDe(ruleId, { quer: 3, utilizavel }));
  assert.equal(estado.pedidos.length, 3, 'leu além das 2 primeiras páginas');
  assert.equal(out.filter(utilizavel).length, 30);
  assert.equal(out.length, 430, 'as inutilizáveis voltam também (o agendador conta recusadas e esperas)');
  // sem o predicado, conta todas (comportamento antigo): para na 1ª página
  estado.pedidos.length = 0;
  await cat.candidatos({ ordem: 'relevancia' }, ctxDe(ruleId, { quer: 3 }));
  assert.equal(estado.pedidos.length, 1);
  // predicado que lança: a oferta não conta (nem derruba a leitura)
  estado.pedidos.length = 0;
  await cat.candidatos({ ordem: 'relevancia' }, ctxDe(ruleId, { quer: 3, utilizavel: () => { throw new Error('x'); } }));
  assert.equal(estado.pedidos.length, 3);
});

test('Q4/P8 (Novidades): as que esperam seguram o cursor, mas a leitura segue nas páginas seguintes até o teto', async () => {
  const { db } = banco();
  const ruleId = criarRegra(db, [{ type: 'catalogo', config: NOV }]);
  const estado = { ofertas: [...Array.from({ length: 200 }, (_, i) => oferta(i + 1, 'ml')), oferta(500), oferta(501)] };
  const { cat } = cliente({ db, fetch: fetchDe(etiqueta(estado)), caminho: arquivoToken() });
  cat.recomecar(ruleId);
  const utilizavel = (c) => c.loja !== 'ml'; // o ML espera a extensão
  const tratadas = new Set();
  const tratada = (c) => tratadas.has(c.key);
  const ctx = ctxDe(ruleId, { utilizavel, tratada });
  const out = await cat.candidatos(NOV, ctx);
  assert.deepEqual(estado.pedidos.map((p) => new URLSearchParams(p.params).get('cursor')), [null, 'c200', 'c202']);
  assert.deepEqual(out.filter(utilizavel).map((c) => c.key), [`ASIN:${asin(500)}`, `ASIN:${asin(501)}`]);
  // as da Amazon saíram; as do ML esperaram: a 1ª página não fecha e o cursor fica
  tratadas.add(`ASIN:${asin(500)}`); tratadas.add(`ASIN:${asin(501)}`);
  cat.avancar(ruleId, ctx.paginas, tratada);
  assert.deepEqual(cursorSalvo(db, ruleId), [{ filtro: filtroDe(NOV), cursor: null, pronto: 1 }]);
});

test('R11: chave que outra fonte da regra já trouxe conta como tratada (não volta e não segura o cursor)', async () => {
  const { db } = banco();
  const ruleId = criarRegra(db, [{ type: 'catalogo', config: NOV }]);
  const estado = { ofertas: [oferta(1), oferta(2, 'ml')] };
  const { cat } = cliente({ db, fetch: fetchDe(etiqueta(estado)), caminho: arquivoToken() });
  cat.recomecar(ruleId);
  const vistas = new Set(['MLB4000000002']);
  const enviadas = new Set();
  const tratada = (c) => enviadas.has(c.key);
  const ctx = ctxDe(ruleId, { vistas, tratada });
  const out = await cat.candidatos(NOV, ctx);
  assert.deepEqual(out.map((c) => c.key), [`ASIN:${asin(1)}`]);
  enviadas.add(`ASIN:${asin(1)}`);
  cat.avancar(ruleId, ctx.paginas, tratada);
  assert.deepEqual(cursorSalvo(db, ruleId), [{ filtro: filtroDe(NOV), cursor: 'c2', pronto: 1 }], 'a do ML veio pela outra fonte: a página fecha');
});

test('R2: primeira leitura grande pela metade com o cursor recusado: avisa e recomeça do fim, sem erro', async () => {
  const { db } = banco();
  const ruleId = criarRegra(db, [{ type: 'catalogo', config: NOV }]);
  const estado = { ofertas: Array.from({ length: 300 }, (_, i) => oferta(i + 1)) };
  const { cat } = cliente({ db, fetch: fetchDe(etiqueta(estado)), caminho: arquivoToken() });
  // primeira leitura parou no meio (pronto=0) com um cursor que o Etiqueta não aceita mais
  db.prepare('INSERT INTO catalogo_cursores (rule_id, filtro, cursor, pronto) VALUES (?,?,?,0)').run(ruleId, filtroDe(NOV), 'cursor-velho');
  const avisos = [];
  const ctx = ctxDe(ruleId, { onWarn: (m) => avisos.push(m) });
  assert.deepEqual(await cat.candidatos(NOV, ctx), []);
  assert.deepEqual(avisos, ['Catálogo do Etiqueta: o cursor salvo foi recusado. A leitura recomeça do fim do catálogo; só o que chegar ou for atualizado depois sai.']);
  assert.deepEqual(estado.pedidos.map((p) => new URLSearchParams(p.params).get('cursor')), ['cursor-velho', null, 'c200', 'c300']);
  assert.equal(cat.situacao().estado, 'conectada');
  cat.avancar(ruleId, ctx.paginas, () => false);
  assert.deepEqual(cursorSalvo(db, ruleId), [{ filtro: filtroDe(NOV), cursor: 'c300', pronto: 1 }]);
  // um 400 de novo no recomeço é resposta inesperada (não laço)
  db.prepare('UPDATE catalogo_cursores SET cursor = ?, pronto = 0').run('cursor-velho');
  estado.cursorRuim = true;
  await assert.rejects(cat.candidatos(NOV, ctxDe(ruleId)), (e) => e instanceof ErroCatalogo && e.resultado === 'resposta_inesperada');
});

test('S3: a pré-visualização nunca faz a primeira leitura (nem a do cursor recusado) e não avisa', async () => {
  const { db } = banco();
  const ruleId = criarRegra(db, [{ type: 'catalogo', config: NOV }]);
  const estado = { ofertas: Array.from({ length: 450 }, (_, i) => oferta(i + 1)) };
  const { cat } = cliente({ db, fetch: fetchDe(etiqueta(estado)), caminho: arquivoToken() });
  const avisos = [];
  const ctx = ctxDe(ruleId, { previa: true, onWarn: (m) => avisos.push(m) });
  assert.equal(cat.primeiraLeitura(ruleId, NOV), true);
  assert.deepEqual(await cat.candidatos(NOV, ctx), []);
  assert.equal(estado.pedidos.length, 0, 'sem rede');
  assert.equal(ctx.paginas.get(0).modo, 'primeira_leitura');
  assert.deepEqual(cat.avancar(ruleId, ctx.paginas, () => true), [], 'nada a gravar');
  // pronto=0 no meio da primeira leitura: também não lê
  db.prepare('INSERT INTO catalogo_cursores (rule_id, filtro, cursor, pronto) VALUES (?,?,?,0)').run(ruleId, filtroDe(NOV), 'c200');
  assert.deepEqual(await cat.candidatos(NOV, ctxDe(ruleId, { previa: true })), []);
  assert.equal(estado.pedidos.length, 0);
  assert.equal(cat.primeiraLeitura(ruleId, NOV), true);
  // cursor pronto: lê dali, sem avisos (nem de oferta fora do formato)
  db.prepare('UPDATE catalogo_cursores SET pronto = 1').run();
  assert.equal(cat.primeiraLeitura(ruleId, NOV), false);
  estado.ofertas.splice(250, 0, oferta(9, 'ml', { item_id: 'x' })); // fora do formato, na página lida
  const lidas = await cat.candidatos(NOV, ctxDe(ruleId, { previa: true, onWarn: (m) => avisos.push(m) }));
  assert.equal(lidas.length, 199);
  // cursor recusado na prévia: lista vazia, sem avançar até o fim e sem aviso
  estado.pedidos.length = 0;
  estado.cursorRuim = true;
  assert.deepEqual(await cat.candidatos(NOV, ctxDe(ruleId, { previa: true, onWarn: (m) => avisos.push(m) })), []);
  assert.equal(estado.pedidos.length, 1);
  assert.deepEqual(avisos, []);
  assert.deepEqual(cursorSalvo(db, ruleId), [{ filtro: filtroDe(NOV), cursor: 'c200', pronto: 1 }], 'a prévia não grava');
  // outras ordens e config inválida: nunca primeira leitura
  assert.equal(cat.primeiraLeitura(ruleId, { ordem: 'relevancia' }), false);
  assert.equal(cat.primeiraLeitura(ruleId, { ordem: 'x' }), false);
});

test('S3: orçamento de tempo da chamada inteira: para depois da página que der e devolve o que leu; sem página, fora_do_ar', async () => {
  const { db } = banco();
  const ruleId = criarRegra(db, [{ type: 'catalogo', config: NOV }]);
  const estado = { ofertas: Array.from({ length: 2500 }, (_, i) => oferta(i + 1)) };
  const avisos = [];
  const lento = cliente({ db, fetch: fetchLento(etiqueta(estado), 80), caminho: arquivoToken(), orcamentoMs: 300 }).cat;
  const out = await lento.candidatos({ ordem: 'desconto' }, ctxDe(ruleId, { quer: 20, tratada: () => false, utilizavel: () => false, onWarn: (m) => avisos.push(m) }));
  const lidas = estado.pedidos.length;
  assert.ok(lidas >= 1 && lidas < 10, `parou pelo tempo (${lidas} páginas)`);
  assert.ok(out.length >= 200 && out.length <= lidas * 200, String(out.length));
  assert.deepEqual(avisos, ['Catálogo do Etiqueta: a leitura passou do tempo e parou; o resto fica para a próxima execução.']);
  assert.equal(lento.situacao().estado, 'conectada', 'o que leu vale');

  // primeira leitura: guarda até onde chegou (pronto=0) e a próxima execução continua dali
  estado.pedidos.length = 0;
  const ctx = ctxDe(ruleId);
  assert.deepEqual(await lento.candidatos(NOV, ctx), []);
  const e = ctx.paginas.get(0);
  assert.equal(e.modo, 'fim'); assert.equal(e.fim, false); assert.match(e.cursor, /^c\d+$/);
  lento.avancar(ruleId, ctx.paginas, () => false);
  assert.deepEqual(cursorSalvo(db, ruleId), [{ filtro: filtroDe(NOV), cursor: e.cursor, pronto: 0 }]);

  // orçamento menor que a primeira página: fora_do_ar (fonte indisponível), nada lido
  const semTempo = cliente({ db, fetch: fetchLento(etiqueta(estado), 200), caminho: arquivoToken(), orcamentoMs: 50 }).cat;
  await assert.rejects(semTempo.candidatos({ ordem: 'desconto' }, ctxDe(ruleId)), (x) => x instanceof ErroCatalogo && x.resultado === 'fora_do_ar');
  await assert.rejects(semTempo.candidatos(NOV, ctxDe(ruleId)), (x) => x instanceof ErroCatalogo && x.resultado === 'fora_do_ar');
});

test('S3: com vários pedidos esperando na fila, a pré-visualização é recusada (ocupado) sem mudar a situação', async () => {
  const { db } = banco();
  const ruleId = criarRegra(db, [{ type: 'catalogo', config: { ordem: 'relevancia' } }]);
  const estado = { ofertas: [oferta(1)] };
  const f = fetchLento(etiqueta(estado), 60);
  const { cat } = cliente({ db, fetch: f, caminho: arquivoToken() });
  const testes = Array.from({ length: 5 }, () => cat.testar()); // 1 em andamento e 4 esperando
  await assert.rejects(cat.candidatos({ ordem: 'relevancia' }, ctxDe(ruleId, { previa: true })), (e) => {
    assert.ok(e instanceof ErroCatalogo);
    assert.deepEqual([e.resultado, e.message], ['ocupado', MENSAGENS_CATALOGO.ocupado]);
    return true;
  });
  const sem = await cat.candidatos({ ordem: 'relevancia' }, ctxDe(ruleId)); // a execução da regra nunca é recusada
  assert.equal(sem.length, 1);
  assert.ok((await Promise.all(testes)).every((r) => r.ok));
  assert.deepEqual([cat.situacao().estado, cat.situacao().falha_desde], ['conectada', null]);
  assert.equal((await cat.candidatos({ ordem: 'relevancia' }, ctxDe(ruleId, { previa: true }))).length, 1, 'fila vazia: a prévia lê');
  assert.equal(fraseDoTeste('ocupado'), 'Há pedidos demais esperando o Etiqueta. Tente de novo em instantes.');
});

// ======================================================= rodar sozinho, entrega 1, etapa B1 (CA1.3, CA1.5, CA1.11)

const local = (a, m, d, h = 0, mi = 0, s = 0) => new Date(a, m - 1, d, h, mi, s).getTime();

test('CA1.5: lerPrecoEm lê AAAA-MM-DDTHH:MM:SS na hora local; fora do formato, data inexistente ou ausente vira null', () => {
  assert.equal(lerPrecoEm('2026-11-11T08:30:05'), local(2026, 11, 11, 8, 30, 5));
  assert.equal(lerPrecoEm('2026-01-01T00:00:00'), local(2026, 1, 1));
  assert.equal(lerPrecoEm('2026-12-31T23:59:59'), local(2026, 12, 31, 23, 59, 59));
  assert.equal(lerPrecoEm('2024-02-29T12:00:00'), local(2024, 2, 29, 12), 'ano bissexto');
  for (const v of [
    '2026-02-29T12:00:00', '2026-02-30T10:00:00', '2026-04-31T10:00:00', '2026-13-01T10:00:00', '2026-00-10T10:00:00',
    '2026-11-00T10:00:00', '2026-11-11T24:00:00', '2026-11-11T23:60:00', '2026-11-11T23:59:60',
    '2026-11-11T10:60:00', '2026-11-11T10:30:60', '2026-11-11T10:99:00', '0050-01-01T00:00:00',
    '2026-11-11 08:30:00', '2026-11-11T08:30:00Z', '2026-11-11T08:30:00-03:00', '2026-11-11T08:30:00.000', '2026-11-11T08:30',
    '2026-11-11', ' 2026-11-11T08:30:00', '2026-11-11T08:30:00\n', '26-11-11T08:30:00', '2026-1-11T08:30:00', '２０２６-11-11T08:30:00',
    '', null, undefined, 1762860600000, {}, [], true,
  ]) assert.equal(lerPrecoEm(v), null, JSON.stringify(v) ?? String(v));
});

test('CA1.5: paraCandidato carrega preco_em como precoEm (ms); inválido ou ausente vira null sem descartar a oferta', () => {
  for (const loja of ['amazon', 'ml', 'shopee']) {
    assert.equal(paraCandidato(oferta(1, loja, { preco_em: '2026-11-10T21:15:00' })).precoEm, local(2026, 11, 10, 21, 15), loja);
  }
  const semData = paraCandidato(oferta(1));
  assert.ok(semData, 'oferta sem preco_em continua candidata');
  assert.equal(semData.precoEm, null);
  for (const v of ['2026-02-30T10:00:00', '2026-11-10 21:15:00', 'ontem', 1762860600000, null]) {
    const c = paraCandidato(oferta(1, 'amazon', { preco_em: v }));
    assert.ok(c, String(v));
    assert.equal(c.precoEm, null, String(v));
  }
});

test('CA1.11: preco_max_horas=72 só com a conferência na hora ligada e lojas ⊆ {ml, amazon}, lista não vazia', async () => {
  assert.equal(IDADE_CATALOGO_CONFERIDO_H, 72);
  const { db } = banco();
  const ruleId = criarRegra(db, [{ type: 'catalogo', config: { ordem: 'relevancia' } }]);
  const estado = { ofertas: [oferta(1), oferta(2, 'ml')] };
  const { cat } = cliente({ db, fetch: fetchDe(etiqueta(estado)), caminho: arquivoToken() });
  const idade = async (lojas, conferenciaNaHora) => {
    estado.pedidos.length = 0;
    const ctx = ctxDe(ruleId);
    if (conferenciaNaHora !== undefined) ctx.conferenciaNaHora = conferenciaNaHora;
    await cat.candidatos({ lojas, ordem: 'relevancia' }, ctx);
    assert.equal(estado.pedidos.length, 1);
    return estado.pedidos[0].params.filter(([k]) => k === 'preco_max_horas').map(([, v]) => v);
  };
  for (const lojas of [['ml'], ['amazon'], ['ml', 'amazon'], ['amazon', 'ml']]) {
    assert.deepEqual(await idade(lojas, true), ['72'], `ligado, ${lojas}`);
  }
  for (const lojas of [[], ['shopee'], ['amazon', 'shopee'], ['ml', 'amazon', 'shopee'], undefined]) {
    assert.deepEqual(await idade(lojas, true), [], `ligado, ${lojas}: validade do Etiqueta`);
  }
  for (const flag of [false, undefined, null, 'sim', 1, {}]) {
    assert.deepEqual(await idade(['ml', 'amazon'], flag), [], `conferência ${JSON.stringify(flag)}`);
  }
  // a ordem e o resto dos parâmetros não mudam; o parâmetro vem antes da ordem
  estado.pedidos.length = 0;
  await cat.candidatos({ lojas: ['amazon'], desconto_min: 30, ordem: 'relevancia' }, ctxDe(ruleId, { conferenciaNaHora: true }));
  assert.deepEqual(estado.pedidos[0].params, [['loja', 'amazon'], ['desconto_min', '30'], ['preco_max_horas', '72'], ['ordem', 'relevancia'], ['limite', '200']]);
});

test('CA1.11: Novidades pede a mesma idade em todas as páginas (primeira leitura e cursor) e o filtro do cursor não muda', async () => {
  const { db } = banco();
  const cfg = { lojas: ['amazon'], ordem: 'atualizacao' };
  const ruleId = criarRegra(db, [{ type: 'catalogo', config: cfg }]);
  const estado = { ofertas: Array.from({ length: 450 }, (_, i) => oferta(i + 1)) };
  const { cat } = cliente({ db, fetch: fetchDe(etiqueta(estado)), caminho: arquivoToken() });
  const ctx = ctxDe(ruleId, { conferenciaNaHora: true });
  assert.deepEqual(await cat.candidatos(cfg, ctx), []);
  cat.avancar(ruleId, ctx.paginas, () => false);
  assert.deepEqual(cursorSalvo(db, ruleId), [{ filtro: filtroDe(cfg), cursor: 'c450', pronto: 1 }], 'mesma chave de filtro com ou sem a idade');
  estado.ofertas.push(oferta(451));
  assert.equal((await cat.candidatos(cfg, ctxDe(ruleId, { conferenciaNaHora: true }))).length, 1);
  assert.ok(estado.pedidos.length >= 4);
  for (const p of estado.pedidos) assert.equal(new URLSearchParams(p.params).get('preco_max_horas'), '72', p.url);
});

test('CA1.11: ml.candidatesFor repassa conferenciaNaHora (só true) ao catálogo', async () => {
  const vistos = [];
  const catalogo = { candidatos: async (cfg, ctx) => { vistos.push(ctx.conferenciaNaHora); return []; } };
  for (const v of [true, false, undefined, 'sim']) await candidatesFor({ type: 'catalogo', config: {} }, { catalogo, conferenciaNaHora: v });
  assert.deepEqual(vistos, [true, false, false, false]);
  // de ponta a ponta, pelo cliente de verdade
  const { db } = banco();
  const ruleId = criarRegra(db, [{ type: 'catalogo', config: { lojas: ['ml'], ordem: 'relevancia' } }]);
  const estado = { ofertas: [oferta(1, 'ml')] };
  const { cat } = cliente({ db, fetch: fetchDe(etiqueta(estado)), caminho: arquivoToken() });
  const out = await candidatesFor({ type: 'catalogo', config: { lojas: ['ml'], ordem: 'relevancia' } }, { catalogo: cat, rule: { id: ruleId }, fonteIndex: 0, quer: 1, conferenciaNaHora: true });
  assert.equal(out.length, 1);
  assert.equal(new URLSearchParams(estado.pedidos[0].params).get('preco_max_horas'), '72');
});

const ASIN_OK = 'B0ABCDEF12';
const ROTA_CONFIRMAR = `/api/v1/amazon/${ASIN_OK}/confirmar-preco`;
const CONFIRMADO = { versao: 1, resultado: 'confirmado', preco: 89.9, preco_antigo: 119.9, desconto_pct: 25, preco_em: '2026-11-11T09:41:07' };

test('CA1.3: confirmarPreco faz POST sem corpo, só Authorization, redirect:error, e devolve o preço lido', async () => {
  const { db } = banco();
  const f = fetchDe(() => ({ status: 200, corpo: CONFIRMADO }));
  const { cat } = cliente({ db, fetch: f, caminho: arquivoToken() });
  const r = await cat.confirmarPreco(ASIN_OK);
  assert.deepEqual(r, { resultado: 'confirmado', preco: 89.9, precoAntigo: 119.9, descontoPct: 25, precoEm: local(2026, 11, 11, 9, 41, 7) });
  assert.equal(f.chamadas.length, 1);
  const { url, init } = f.chamadas[0];
  assert.equal(url, `http://127.0.0.1:8765${ROTA_CONFIRMAR}`);
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
  assert.equal(init.body, undefined);
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(Object.keys(init.headers), ['Authorization']);
  assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.ok(!url.includes(TOKEN));
  // preço antigo e desconto opcionais; antigo que não é maior que o preço não vale (como no paraCandidato)
  for (const [mais, esperado] of [
    [{ preco_antigo: null, desconto_pct: null }, { precoAntigo: null, descontoPct: null }],
    [{ preco_antigo: undefined, desconto_pct: undefined }, { precoAntigo: null, descontoPct: null }],
    [{ preco_antigo: 89.9, desconto_pct: 0 }, { precoAntigo: null, descontoPct: 0 }],
    [{ preco_antigo: 50 }, { precoAntigo: null, descontoPct: 25 }],
    [{ desconto_pct: 33.4 }, { precoAntigo: 119.9, descontoPct: 33 }],
  ]) {
    const g = fetchDe(() => ({ status: 200, corpo: { ...CONFIRMADO, ...mais } }));
    const x = await cliente({ db, fetch: g, caminho: arquivoToken() }).cat.confirmarPreco(ASIN_OK);
    assert.deepEqual(x, { resultado: 'confirmado', preco: 89.9, precoEm: local(2026, 11, 11, 9, 41, 7), ...esperado }, JSON.stringify(mais));
  }
});

test('CA1.3: confirmarPreco, resultados do 200: sem_preco, outro_produto, bloqueado, falha_rede e o que foge do contrato', async () => {
  const casos = [
    [{ versao: 1, resultado: 'sem_preco' }, { resultado: 'sem_preco' }],
    [{ versao: 1, resultado: 'outro_produto' }, { resultado: 'outro_produto' }],
    [{ versao: 1, resultado: 'bloqueado' }, { resultado: 'falha', causa: 'bloqueado' }],
    [{ versao: 1, resultado: 'falha_rede' }, { resultado: 'falha', causa: 'falha_rede' }],
    [{ versao: 1, resultado: 'freio' }, { resultado: 'falha', causa: 'resposta_inesperada' }],
    [{ versao: 1, resultado: 'outra_coisa' }, { resultado: 'falha', causa: 'resposta_inesperada' }],
    [{ versao: 1 }, { resultado: 'falha', causa: 'resposta_inesperada' }],
    [{ versao: 2, resultado: 'sem_preco' }, { resultado: 'falha', causa: 'resposta_inesperada' }],
    [{ resultado: 'sem_preco' }, { resultado: 'falha', causa: 'resposta_inesperada' }],
    [{ ...CONFIRMADO, versao: '1' }, { resultado: 'falha', causa: 'resposta_inesperada' }],
    [[CONFIRMADO], { resultado: 'falha', causa: 'resposta_inesperada' }],
    [null, { resultado: 'falha', causa: 'resposta_inesperada' }],
    // números e preco_em validados
    ...[
      { preco: 0 }, { preco: -1 }, { preco: '89.9' }, { preco: null }, { preco: undefined }, { preco: true }, { preco: 1e400 },
      { preco_antigo: '119.9' }, { preco_antigo: -5 }, { preco_antigo: 0 }, { preco_antigo: {} },
      { desconto_pct: -1 }, { desconto_pct: 101 }, { desconto_pct: '25' }, { desconto_pct: [] },
      { preco_em: null }, { preco_em: undefined }, { preco_em: '2026-02-30T10:00:00' }, { preco_em: '2026-11-11 09:41:07' }, { preco_em: 1762860600000 },
      // o mesmo teto de preço dos outros caminhos (achado S1): acima de 10 milhões é leitura errada
      { preco: 10_000_000.01 }, { preco: 1e9 }, { preco_antigo: 10_000_000.01 },
    ].map((mais) => [{ ...CONFIRMADO, ...mais }, { resultado: 'falha', causa: 'resposta_inesperada' }]),
  ];
  for (const [corpo, esperado] of casos) {
    const f = fetchDe(() => ({ status: 200, corpo }));
    const r = await cliente({ fetch: f, caminho: arquivoToken() }).cat.confirmarPreco(ASIN_OK);
    assert.deepEqual(r, esperado, JSON.stringify(corpo));
  }
});

test('CA1.3: confirmarPreco, códigos HTTP, rede, tempo e corpo grande viram causa fixa; nunca lança', async (t) => {
  const casos = [
    ['401', () => ({ status: 401, corpo: { error: 'x' } }), 'token_recusado'],
    ['503', () => ({ status: 503, corpo: { error: 'x' } }), 'desligada'],
    ['404', () => ({ status: 404, corpo: { error: 'oferta da Amazon não encontrada' } }), 'nao_encontrado'],
    ['405 (Etiqueta antigo)', () => ({ status: 405, corpo: { error: 'a API v1 só aceita GET' } }), 'resposta_inesperada'],
    ['403', () => ({ status: 403, corpo: { error: 'x' } }), 'resposta_inesperada'],
    ['400', () => ({ status: 400, corpo: { error: 'esta rota não aceita corpo' } }), 'resposta_inesperada'],
    ['302', () => ({ status: 302, corpo: null }), 'resposta_inesperada'],
    ['204', () => ({ status: 204, corpo: null }), 'resposta_inesperada'],
    ['500', () => ({ status: 500, corpo: { error: 'x' } }), 'fora_do_ar'],
    ['502', () => ({ status: 502, corpo: null }), 'fora_do_ar'],
    ['rede', () => { throw new Error('ECONNREFUSED'); }, 'fora_do_ar'],
  ];
  for (const [nome, resp, causa] of casos) {
    const f = fetchDe(async () => resp());
    const r = await cliente({ fetch: f, caminho: arquivoToken() }).cat.confirmarPreco(ASIN_OK);
    assert.deepEqual(r, { resultado: 'falha', causa }, nome);
    assert.equal(f.chamadas.length, 1, nome);
  }
  // fetch que lança algo que nem é Error, e Response sem corpo legível: falha, sem lançar
  const estranho = cliente({ fetch: async () => { throw 'texto'; }, caminho: arquivoToken() }).cat;
  assert.deepEqual(await estranho.confirmarPreco(ASIN_OK), { resultado: 'falha', causa: 'fora_do_ar' });
  const semResposta = cliente({ fetch: async () => undefined, caminho: arquivoToken() }).cat;
  assert.deepEqual(await semResposta.confirmarPreco(ASIN_OK), { resultado: 'falha', causa: 'fora_do_ar' });

  // servidor de verdade: tempo esgotado, JSON quebrado, corpo grande e redirecionamento (não seguido)
  const parado = await servidor(() => 'manual');
  t.after(parado.fechar);
  assert.deepEqual(await cliente({ endereco: parado.endereco, caminho: arquivoToken(), timeoutMs: 150 }).cat.confirmarPreco(ASIN_OK), { resultado: 'falha', causa: 'fora_do_ar' });
  for (const [nome, bruto] of [['JSON quebrado', '{"versao": 1, "resul'], ['corpo grande', JSON.stringify({ ...CONFIRMADO, x: 'a'.repeat(64 * 1024) })]]) {
    const srv = await servidor(() => ({ status: 200, bruto }));
    try {
      assert.deepEqual(await cliente({ endereco: srv.endereco, caminho: arquivoToken() }).cat.confirmarPreco(ASIN_OK), { resultado: 'falha', causa: 'resposta_inesperada' }, nome);
    } finally { await srv.fechar(); }
  }
  const alvo = [];
  const desvio = await servidor((url, headers, req) => {
    if (req.url.startsWith('/destino')) { alvo.push(headers.authorization ?? null); return { status: 200, corpo: CONFIRMADO }; }
    return { status: 307, corpo: {}, headers: { location: '/destino' } };
  });
  t.after(desvio.fechar);
  assert.deepEqual(await cliente({ endereco: desvio.endereco, caminho: arquivoToken() }).cat.confirmarPreco(ASIN_OK), { resultado: 'falha', causa: 'fora_do_ar' });
  assert.deepEqual(alvo, [], 'o token nunca vai a outro endereço');
});

test('confirmarPreco: preço de até 10 milhões vale (o teto é inclusivo)', async () => {
  const f = fetchDe(() => ({ status: 200, corpo: { ...CONFIRMADO, preco: 10_000_000, preco_antigo: null } }));
  const r = await cliente({ fetch: f, caminho: arquivoToken() }).cat.confirmarPreco(ASIN_OK);
  assert.deepEqual([r.resultado, r.preco], ['confirmado', 10_000_000]);
});

/** fetch falso da confirmação que responde, em ordem, cada item de `respostas` ({ status, corpo, headers }); guarda as chamadas. */
function fetchEmSequencia(respostas) {
  const chamadas = [];
  const f = async (url, init = {}) => {
    chamadas.push(`${init.method ?? 'GET'} ${new URL(String(url)).pathname}`);
    const r = respostas[Math.min(chamadas.length - 1, respostas.length - 1)];
    return new Response(r.corpo == null ? null : JSON.stringify(r.corpo), { status: r.status, headers: { 'content-type': 'application/json; charset=utf-8', ...(r.headers ?? {}) } });
  };
  f.chamadas = chamadas;
  return f;
}
const freio429 = (motivo, s, extra = {}) => ({ status: 429, corpo: { versao: 1, resultado: 'freio', motivo, tentar_em_s: s }, headers: { 'retry-after': String(s) }, ...extra });
/** Cliente com a espera do freio injetada (nunca dorme de verdade): guarda os ms pedidos. */
function clienteComEspera(f, extra = {}) {
  const esperas = [];
  const cat = createCatalogo({ db: banco().db, fetch: f, lerConexao: () => ({ endereco: 'http://127.0.0.1:8765', caminho_token: arquivoToken() }), esperar: async (ms) => { esperas.push(ms); }, ...extra });
  return { cat, esperas };
}

test('R1: 429 "intervalo" ou "ocupado" (espera de até 3 s): espera o tentar_em_s dentro da fila e pede de novo — a segunda Amazon seguida é relida', async () => {
  for (const motivo of ['intervalo', 'ocupado']) {
    const f = fetchEmSequencia([freio429(motivo, 2), { status: 200, corpo: CONFIRMADO }]);
    const { cat, esperas } = clienteComEspera(f);
    const r = await cat.confirmarPreco(ASIN_OK);
    assert.equal(r.resultado, 'confirmado', motivo);
    assert.deepEqual(esperas, [2000], motivo);
    assert.deepEqual(f.chamadas, [`POST ${ROTA_CONFIRMAR}`, `POST ${ROTA_CONFIRMAR}`], motivo);
  }
  // até duas novas tentativas; a terceira recusa volta como freio, com o motivo e a espera
  const sempre = fetchEmSequencia([freio429('ocupado', 3)]);
  const { cat, esperas } = clienteComEspera(sempre);
  assert.deepEqual(await cat.confirmarPreco(ASIN_OK), { resultado: 'falha', causa: 'freio', motivo: 'ocupado', tentarEmS: 3 });
  assert.deepEqual(esperas, [3000, 3000]);
  assert.equal(sempre.chamadas.length, 3);
  // duas recusas e depois o 200: sai confirmado
  const duas = fetchEmSequencia([freio429('intervalo', 1), freio429('ocupado', 3), { status: 200, corpo: CONFIRMADO }]);
  const d = clienteComEspera(duas);
  assert.equal((await d.cat.confirmarPreco(ASIN_OK)).resultado, 'confirmado');
  assert.deepEqual(d.esperas, [1000, 3000]);
});

test('R1: 429 "teto", "pausa", "rodada", espera longa ou corpo fora do contrato voltam na hora, sem esperar, com o motivo e o tentar_em_s', async () => {
  const casos = [
    [freio429('teto', 1800), { motivo: 'teto', tentarEmS: 1800 }],
    [freio429('pausa', 600), { motivo: 'pausa', tentarEmS: 600 }],
    [freio429('rodada', 60), { motivo: 'rodada', tentarEmS: 60 }],
    [freio429('intervalo', 4), { motivo: 'intervalo', tentarEmS: 4 }], // espera longa não é "curta"
    // sem corpo: o Retry-After; sem os dois, nada
    [{ status: 429, corpo: null, headers: { 'retry-after': '45' } }, { motivo: null, tentarEmS: 45 }],
    [{ status: 429, corpo: null }, { motivo: null, tentarEmS: null }],
    // corpo fora do contrato: motivo desconhecido, tentar_em_s inválido (o Retry-After vale no lugar)
    [{ status: 429, corpo: { versao: 1, resultado: 'freio', motivo: 'xyz', tentar_em_s: 2 } }, { motivo: null, tentarEmS: 2 }],
    [{ status: 429, corpo: { versao: 1, resultado: 'freio', motivo: 'intervalo', tentar_em_s: '2' }, headers: { 'retry-after': '7' } }, { motivo: 'intervalo', tentarEmS: 7 }],
    [{ status: 429, corpo: { versao: 1, resultado: 'freio', motivo: 'intervalo', tentar_em_s: 0 } }, { motivo: 'intervalo', tentarEmS: null }],
    [{ status: 429, corpo: { versao: 1, resultado: 'freio', motivo: 'intervalo', tentar_em_s: 2.5 }, headers: { 'retry-after': 'Wed, 11 Nov 2026 10:00:00 GMT' } }, { motivo: 'intervalo', tentarEmS: null }],
    [{ status: 429, corpo: { versao: 2, resultado: 'freio', motivo: 'intervalo', tentar_em_s: 2 } }, { motivo: null, tentarEmS: null }],
    [{ status: 429, corpo: ['intervalo'] }, { motivo: null, tentarEmS: null }],
  ];
  for (const [resposta, esperado] of casos) {
    const f = fetchEmSequencia([resposta, { status: 200, corpo: CONFIRMADO }]);
    const { cat, esperas } = clienteComEspera(f);
    assert.deepEqual(await cat.confirmarPreco(ASIN_OK), { resultado: 'falha', causa: 'freio', ...esperado }, JSON.stringify(resposta));
    assert.deepEqual(esperas, [], JSON.stringify(resposta));
    assert.equal(f.chamadas.length, 1, JSON.stringify(resposta));
  }
});

test('R1: a espera do freio curto segura a fila — nenhum outro pedido ao Etiqueta passa no meio', async () => {
  const estado = { ofertas: [oferta(1)] };
  const ofertas = etiqueta(estado);
  let posts = 0;
  const f = fetchDe((url, h) => {
    if (url.includes('/confirmar-preco')) return ++posts === 1 ? { status: 429, corpo: { versao: 1, resultado: 'freio', motivo: 'intervalo', tentar_em_s: 3 } } : { status: 200, corpo: CONFIRMADO };
    return ofertas(url, h);
  });
  const { cat } = clienteComEspera(f, { esperar: () => new Promise((ok) => setTimeout(ok, 30)) });
  const [a, b] = await Promise.all([cat.confirmarPreco(ASIN_OK), cat.testar()]);
  assert.equal(a.resultado, 'confirmado');
  assert.equal(b.resultado, 'ok');
  assert.deepEqual(f.chamadas.map((c) => new URL(c.url).pathname), [ROTA_CONFIRMAR, ROTA_CONFIRMAR, '/api/v1/categorias']);
});

test('R1: sem `esperar` injetado, a espera do freio curto é um timer de tentar_em_s', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fetchEmSequencia([freio429('intervalo', 2), { status: 200, corpo: CONFIRMADO }]);
  const cat = createCatalogo({ db: banco().db, fetch: f, lerConexao: () => ({ endereco: 'http://127.0.0.1:8765', caminho_token: arquivoToken() }) });
  const p = cat.confirmarPreco(ASIN_OK);
  for (let i = 0; i < 20 && f.chamadas.length < 1; i++) await new Promise((ok) => setImmediate(ok));
  for (let i = 0; i < 20; i++) await new Promise((ok) => setImmediate(ok));
  t.mock.timers.tick(1999);
  for (let i = 0; i < 20; i++) await new Promise((ok) => setImmediate(ok));
  assert.equal(f.chamadas.length, 1, 'antes dos 2 s não pede de novo');
  t.mock.timers.tick(1);
  assert.equal((await p).resultado, 'confirmado');
  assert.equal(f.chamadas.length, 2);
});

test('CA1.3: confirmarPreco sem conexão, sem token ou com ASIN fora do formato: falha sem rede', async () => {
  const f = fetchDe(() => ({ status: 200, corpo: CONFIRMADO }));
  const semConexao = createCatalogo({ db: banco().db, fetch: f, lerConexao: () => ({ endereco: 'http://127.0.0.1:8765' }) });
  assert.deepEqual(await semConexao.confirmarPreco(ASIN_OK), { resultado: 'falha', causa: 'nao_configurada' });
  const quebrada = createCatalogo({ db: banco().db, fetch: f, lerConexao: () => { throw new Error('banco'); } });
  assert.deepEqual(await quebrada.confirmarPreco(ASIN_OK), { resultado: 'falha', causa: 'nao_configurada' });
  const semArquivo = cliente({ fetch: f, caminho: path.join(pastaTemp('vazia'), 'api_token.txt') }).cat;
  assert.deepEqual(await semArquivo.confirmarPreco(ASIN_OK), { resultado: 'falha', causa: 'nao_configurada' });
  const tokenRuim = cliente({ fetch: f, caminho: arquivoToken('curto') }).cat;
  assert.deepEqual(await tokenRuim.confirmarPreco(ASIN_OK), { resultado: 'falha', causa: 'nao_configurada' });
  const { cat } = cliente({ fetch: f, caminho: arquivoToken() });
  for (const a of ['b0abcdef12', 'B0ABC', 'B0ABCDEF123', 'B0ABCDEF1/', '../x/aaaaa', 'B0ABCDEF1%', ` ${ASIN_OK}`, '', null, undefined, 12345678901, {}]) {
    assert.deepEqual(await cat.confirmarPreco(a), { resultado: 'falha', causa: 'nao_encontrado' }, String(a));
  }
  assert.equal(f.chamadas.length, 0);
});

test('CA1.3: confirmarPreco não muda a situação do catálogo e o token não vaza no resultado', async () => {
  const { db } = banco();
  let relogio = 100;
  const respostas = [
    async (url, init) => new Response(JSON.stringify({ error: `token ${init.headers.Authorization}` }), { status: 401 }),
    async (url, init) => new Response(JSON.stringify({ error: `token ${init.headers.Authorization}` }), { status: 503 }),
    async (url, init) => new Response(`{"versao":1, ${init.headers.Authorization}`, { status: 200 }),
    async (url, init) => new Response(JSON.stringify({ versao: 1, resultado: init.headers.Authorization }), { status: 200 }),
    async (url, init) => new Response(JSON.stringify({ ...CONFIRMADO, preco_em: init.headers.Authorization }), { status: 200 }),
    async (url, init) => { throw new Error(`falhou: ${init.headers.Authorization}`); },
    async () => new Response(JSON.stringify(CONFIRMADO), { status: 200 }),
  ];
  let i = 0;
  const f = async (...a) => respostas[i++](...a);
  const { cat } = cliente({ db, fetch: f, caminho: arquivoToken(), agora: () => relogio });
  const antes = cat.situacao();
  assert.deepEqual(antes, { estado: 'salva', resultado: null, verificado_em: null, falha_desde: null });
  const saidas = [];
  for (let k = 0; k < respostas.length; k++) { relogio += 100; saidas.push(await cat.confirmarPreco(ASIN_OK)); }
  assert.deepEqual(saidas.map((s) => s.causa ?? s.resultado), ['token_recusado', 'desligada', 'resposta_inesperada', 'resposta_inesperada', 'resposta_inesperada', 'fora_do_ar', 'confirmado']);
  assert.deepEqual(cat.situacao(), antes, 'nem a falha nem o sucesso mudam a situação');
  assert.equal(getSetting(db, 'catalogo_verificacao', null), null, 'nada gravado');
  assert.ok(!JSON.stringify(saidas).includes(TOKEN.slice(8, 30)));
});

test('CA1.3: confirmarPreco entra na fila única: nunca dois pedidos ao mesmo tempo no Etiqueta', async (t) => {
  const estado = { ofertas: [oferta(1)] };
  const ofertas = etiqueta(estado);
  const srv = await servidor((url, headers, req) => {
    if (req.method === 'POST') return { status: 200, corpo: CONFIRMADO };
    return ofertas(url, headers);
  }, { atraso: 40 });
  t.after(srv.fechar);
  const { db } = banco();
  const ruleId = criarRegra(db, [{ type: 'catalogo', config: { ordem: 'relevancia' } }]);
  const { cat } = cliente({ db, endereco: srv.endereco, caminho: arquivoToken() });
  const [a, b, c, d] = await Promise.all([
    cat.confirmarPreco(ASIN_OK), cat.candidatos({ ordem: 'relevancia' }, ctxDe(ruleId)), cat.confirmarPreco(ASIN_OK), cat.testar(),
  ]);
  assert.equal(a.resultado, 'confirmado');
  assert.equal(b.length, 1);
  assert.equal(c.resultado, 'confirmado');
  assert.equal(d.resultado, 'ok');
  assert.equal(srv.cabecalhos.length, 4);
  assert.equal(srv.maxEmVoo, 1);
  // pelo servidor de verdade: sem Origin, sem cookie e sem corpo
  const posts = srv.cabecalhos.filter((h) => h['content-length'] != null && h['content-length'] !== '0');
  assert.deepEqual(posts, [], 'nenhum pedido com corpo');
  for (const h of srv.cabecalhos) { assert.equal(h.origin, undefined); assert.equal(h.cookie, undefined); }
});

test('nenhum teste chamou a rede de fora (fetch global bloqueado para o resto)', () => {
  assert.equal(chamadasBloqueadas, 0);
});
