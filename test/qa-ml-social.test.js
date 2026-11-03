// QA, bug: Identificar do Disparo manual com um link meli.la de afiliado (rodada 1, 03/11/2026).
// O meli.la redireciona para a vitrine social do afiliado (/social/mp...), que não tem JSON-LD de produto:
// só og:title ("<título> - R$ <preço>"), og:image e um JSON embutido com o cartão "card-featured".
// parseProductHtml (src/ml.js) só lia JSON-LD, e o Identificar falhava com "página sem dados de produto".
// A fixture é sintética (mesma estrutura da página real, sem dados do perfil do afiliado, ref, matt_word etc.).
// Nenhum teste acessa a rede: o fetch global é bloqueado (e, no teste do redirecionamento, trocado por um falso).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openDb } from '../src/db.js';
import { buildApp, criarServicos } from '../src/server.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createLinkService } from '../src/links.js';
import * as mlReal from '../src/ml.js';

const { parseProductHtml, resolveOffer } = mlReal;

const redeBloqueada = async () => { throw new Error('rede proibida no teste'); };
globalThis.fetch = redeBloqueada;

const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-qamls-')); pastas.push(p); return p; };

const URL_META = 'https://meli.la/1qttG3Q';
const URL_SOCIAL = 'https://www.mercadolivre.com.br/social/mp0000000000000';
const TITULO = 'Tablet UJJ U3 de 10.1" com Android 15, 128 GB e 30 GB RAM - Preto';
const IMAGEM = 'https://http2.mlstatic.com/D_NQ_NP_772418-MLA118025542979_092026-P.webp';
const ESPERADO = { title: TITULO, price: 725, oldPrice: 2900, image: IMAGEM };

/** Como o Mercado Livre serializa o JSON embutido: "/" vira /. */
const json = (o) => JSON.stringify(o).replaceAll('/', '\\u002F');

const cartao = ({ id, titulo, atual, anterior, desconto, produto, semPreco = false, url }) => ({
  id, type: 'recommendations',
  recommendation_data: { recommendation_info: { polycard_context: { contract_version: '1.0.0', type: 'list-multicolumn' } },
    polycards: [{
      metadata: { id: 'MLB0000000001', product_id: produto, ...(url ? { url } : {}) },
      pictures: { pictures: [{ id: '772418-MLA118025542979_092026' }] },
      components: [
        { type: 'title', id: 'title', title: { text: titulo, long_title: false } },
        ...(semPreco ? [] : [{ type: 'price', id: 'price', column: 1, price: {
          ...(anterior ? { previous_price: { value: anterior, currency: 'BRL', decimal_style: 'normal' } } : {}),
          current_price: { value: atual, currency: 'BRL', decimal_style: 'superscript' },
          ...(desconto ? { discount_label: { text: `${desconto}% OFF` }, discount_pct: desconto } : {}),
          installments: { text: '10x {price} sem juros', values: [{ key: 'price', type: 'price', price: { value: atual / 10, currency: 'BRL' } }] },
        } }]),
        { type: 'action_links', id: 'action_links', column: 2, action_links: [{ id: 'show_product', type: 'link', text: 'Ir para produto', url: `https://www.mercadolivre.com.br/tablet-ujj-u3/p/${produto}` }] },
      ],
    }],
  },
});

/**
 * Página social sintética: og:* no <head> + JSON embutido com o card em destaque seguido de outros cartões.
 * `destaque` sobrescreve o cartão em destaque; `idsOutros` troca o prefixo dos ids dos outros (na página real não são "card-…").
 */
function paginaSocial({ og = true, card = true, destaque = {}, idsOutros = 'card-', atualOutro = 635.54, ogTitle = 'Tablet UJJ U3 de 10.1&quot; com Android 15, 128 GB e 30 GB RAM - Preto - R$ 725', ogImage = IMAGEM } = {}) {
  const estado = {
    page: { components: [
      ...(card ? [cartao({ id: 'card-featured', titulo: TITULO, atual: 725, anterior: 2900, desconto: 75, produto: 'MLB79725856', ...destaque })] : []),
      cartao({ id: `${idsOutros}1`, titulo: 'Tablet 10.1 Teclado Mouse Fone 6gb Ram 128gb Android 13 50mp', atual: atualOutro, anterior: 1100, desconto: 42, produto: 'MLB11111111' }),
      cartao({ id: `${idsOutros}2`, titulo: 'Tablet Android De 10 Polegadas, 128 Gb, 6000 Mah, Wifi 6', atual: 575.99, produto: 'MLB22222222' }),
    ] },
  };
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>Vitrine do afiliado | Mercado Livre</title>
${og ? `<meta property="og:title" content="${ogTitle}"/>
<meta property="og:description" content="Olha o que eu encontrei! ${ogTitle} no Mercado Livre."/>
<meta property="og:image" content="${ogImage}"/>
<meta property="og:url" content="${URL_SOCIAL}"/>
<meta property="og:type" content="website"/>` : ''}
<script async="" src="https://http2.mlstatic.com/frontend-assets/ml-web-navigation/widgets/7.50.0/categories.js"></script>
</head><body><div id="root"></div>
<script nonce="abc">window.__PRELOADED_STATE__ = ${json(estado)};</script>
</body></html>`;
}

/** Página de produto "clássica", com JSON-LD (o que o parser já lia). */
function paginaJsonLd({ imagem = IMAGEM, preco = '725.00', antigo = true } = {}) {
  const ld = { '@context': 'https://schema.org', '@type': 'Product', name: 'Fone Bluetooth Bom', image: imagem, offers: { '@type': 'Offer', price: preco, priceCurrency: 'BRL' } };
  return `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body>${antigo ? '<script>var s={"original_price":1000.5}</script>' : ''}</body></html>`;
}

// ---------------------------------------------------------------- CA1
test('CA1: parseProductHtml lê título, preço, preço antigo e imagem da página social', () => {
  assert.deepEqual(parseProductHtml(paginaSocial()), ESPERADO);
});

test('CA1: o título perde só o sufixo " - R$ preço" (o " - Preto" do nome fica) e a entidade &quot; vira aspas', () => {
  const p = parseProductHtml(paginaSocial());
  assert.equal(p.title, TITULO);
  assert.ok(!p.title.includes('R$') && !p.title.includes('&quot;'));
});

test('CA1: o preço vem do cartão em destaque, não dos outros cartões da vitrine', () => {
  const p = parseProductHtml(paginaSocial());
  assert.equal(p.price, 725);
  assert.equal(p.oldPrice, 2900);
});

// ---------------------------------------------------------------- CA2
test('CA2: resolveOffer do link meli.la resolve o produto pela página social, com 75% de desconto', async () => {
  const buscadas = [];
  const fetchText = async (u) => { buscadas.push(u); return paginaSocial(); };
  const fetchJson = async () => { throw new Error('o link meli.la não tem id de anúncio: não há API a consultar'); };
  const o = await resolveOffer({ key: mlReal.offerKey(URL_META), url: URL_META }, { fetchText, fetchJson });
  assert.deepEqual(buscadas, [URL_META]);
  assert.equal(o.title, TITULO);
  assert.equal(o.price, 725);
  assert.equal(o.oldPrice, 2900);
  assert.equal(o.discountPct, 75);
  assert.equal(o.image, IMAGEM);
  assert.equal(o.url, URL_META);
  assert.equal(o.key, mlReal.offerKey(URL_META));
});

test('CA2: título e preço digitados à mão continuam valendo sobre o que a página social traz', async () => {
  const fetchText = async () => paginaSocial();
  const o = await resolveOffer({ key: 'k', url: URL_META, title: 'Meu título', price: 700 }, { fetchText });
  assert.equal(o.title, 'Meu título');
  assert.equal(o.price, 700);
});

// ---------------------------------------------------------------- CA3
test('CA3: só com og:title e og:image (sem o JSON do cartão) ainda dá título e preço, sem preço antigo', () => {
  assert.deepEqual(parseProductHtml(paginaSocial({ card: false })), { title: TITULO, price: 725, oldPrice: null, image: IMAGEM });
});

test('CA3: preço em formato brasileiro no og:title ("R$ 1.299,90") vira 1299.9', () => {
  const p = parseProductHtml(paginaSocial({ card: false, ogTitle: 'Notebook Bom 15 - R$ 1.299,90' }));
  assert.equal(p.title, 'Notebook Bom 15');
  assert.equal(p.price, 1299.9);
});

test('CA3: entidades do og:title são decodificadas uma vez só (&amp;quot; fica &quot;)', () => {
  const p = parseProductHtml(paginaSocial({ card: false, ogTitle: 'Cabo A&amp;B 2&#39; &amp;quot;x&amp;quot; - R$ 10' }));
  assert.equal(p.title, "Cabo A&B 2' &quot;x&quot;");
  assert.equal(p.price, 10);
});

test('CA3: og:title sem preço no final não inventa produto', () => {
  assert.equal(parseProductHtml(paginaSocial({ card: false, ogTitle: 'Vitrine da loja do afiliado' })), null);
});

test('CA3: og:image fora do CDN mlstatic.com vira null, mas título e preço seguem', () => {
  const p = parseProductHtml(paginaSocial({ ogImage: 'https://exemplo.com/foto.jpg' }));
  assert.equal(p.image, null);
  assert.equal(p.title, TITULO);
  assert.equal(p.price, 725);
  assert.equal(parseProductHtml(paginaSocial({ card: false, ogImage: 'https://mlstatic.com.evil.com/x.jpg' })).image, null);
  assert.equal(parseProductHtml(paginaSocial({ card: false, ogImage: 'http://http2.mlstatic.com/x.jpg' })).image, null, 'http puro não passa');
});

// ---------------------------------------------------------------- CA4
test('CA4: página com JSON-LD continua lida como antes (preço antigo vem do original_price)', () => {
  assert.deepEqual(parseProductHtml(paginaJsonLd()), { title: 'Fone Bluetooth Bom', price: 725, oldPrice: 1000.5, image: IMAGEM });
  assert.deepEqual(parseProductHtml(paginaJsonLd({ antigo: false })), { title: 'Fone Bluetooth Bom', price: 725, oldPrice: null, image: IMAGEM });
});

test('CA4: com JSON-LD, imagem fora do mlstatic.com continua virando null', () => {
  const p = parseProductHtml(paginaJsonLd({ imagem: 'https://evil.example.com/x.jpg' }));
  assert.equal(p.image, null);
  assert.equal(p.price, 725);
});

test('CA4: página sem JSON-LD, sem og:title e sem cartão continua sem dados (null)', () => {
  assert.equal(parseProductHtml('<html><head><title>Login</title></head><body>Entre na sua conta</body></html>'), null);
  assert.equal(parseProductHtml(''), null);
});

test('CA4: resolveOffer de página sem dados de produto continua lançando "página sem dados de produto"', async () => {
  const fetchText = async () => '<html><head><title>Login</title></head><body>Entre</body></html>';
  await assert.rejects(
    resolveOffer({ key: 'k', url: URL_META }, { fetchText }),
    (e) => /não consegui ler o produto \(página sem dados de produto\)/.test(e.message),
  );
});

// ---------------------------------------------------------------- CA5
const HOST = '127.0.0.1';
function req(port, caminho, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((ok, err) => {
    const data = body != null ? JSON.stringify(body) : null;
    const h = { host: `${HOST}:${port}`, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers };
    const r = http.request({ host: HOST, port, path: caminho, method, headers: h }, (res) => {
      let txt = ''; res.setEncoding('utf8'); res.on('data', (c) => (txt += c));
      res.on('end', () => { let j = null; try { j = JSON.parse(txt); } catch { /* html */ } ok({ status: res.statusCode, json: j, txt }); });
    });
    r.on('error', err); if (data) r.write(data); r.end();
  });
}

function subir({ ml, links: linksDado }) {
  const dir = tmp();
  const db = openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = linksDado ?? createLinkService({ getMode: () => 'fake' });
  const { amazon, scheduler } = criarServicos({ db, wa, links, fast: true, dir, ml, fetch: redeBloqueada });
  const app = buildApp({ db, wa, links, scheduler, amazon, ml, publicHost: '', panelPassword: '' });
  return new Promise((ok) => {
    const server = app.listen(0, HOST, () => {
      const port = server.address().port;
      ok({ db, port, links, fechar: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => { db.close(); r(); }); }) });
    });
  });
}

const identificar = (s, url) => req(s.port, '/api/disparo/identificar', { method: 'POST', headers: { origin: `http://${HOST}:${s.port}` }, body: { url } });

test('CA5: POST /api/disparo/identificar com o link meli.la devolve o produto preenchido (fetchText falso)', async () => {
  const buscadas = [];
  const ml = { ...mlReal, resolveOffer: (cand, deps = {}) => mlReal.resolveOffer(cand, { ...deps, fetchText: async (u) => { buscadas.push(u); return paginaSocial(); } }) };
  const s = await subir({ ml });
  try {
    const r = await identificar(s, URL_META);
    assert.equal(r.status, 200, `identificar respondeu ${r.status}: ${r.txt.slice(0, 200)}`);
    assert.equal(r.json.loja.id, 'mercadolivre');
    assert.equal(r.json.produto.title, TITULO);
    assert.equal(r.json.produto.price, 725);
    assert.equal(r.json.produto.oldPrice, 2900);
    assert.equal(r.json.produto.discountPct, 75);
    assert.equal(r.json.produto.image, IMAGEM);
    assert.match(r.json.texto, /Tablet UJJ U3/);
    assert.deepEqual(buscadas, [URL_META]);
  } finally { await s.fechar(); }
});

test('CA5: caminho real de leitura (sem fetchText): meli.la 301 -> página social, tudo com fetch global falso', async () => {
  const original = globalThis.fetch; const pedidos = [];
  globalThis.fetch = async (url) => {
    const u = String(url); pedidos.push(u);
    if (u === URL_META) return new Response(null, { status: 301, headers: { location: URL_SOCIAL } });
    if (u === URL_SOCIAL) return new Response(paginaSocial(), { status: 200, headers: { 'content-type': 'text/html' } });
    throw new Error(`rede não prevista no teste: ${u}`);
  };
  const s = await subir({ ml: mlReal });
  try {
    const r = await identificar(s, URL_META);
    assert.equal(r.status, 200, `identificar respondeu ${r.status}: ${r.txt.slice(0, 200)}`);
    assert.equal(r.json.produto.title, TITULO);
    assert.equal(r.json.produto.price, 725);
    assert.equal(r.json.produto.discountPct, 75);
    assert.deepEqual(pedidos, [URL_META, URL_SOCIAL]);
  } finally { globalThis.fetch = original; await s.fechar(); }
});

test('CA5: link meli.la que cai numa página sem dados continua recusado com a mensagem de hoje (sem vazar a página)', async () => {
  const ml = { ...mlReal, resolveOffer: (cand, deps = {}) => mlReal.resolveOffer(cand, { ...deps, fetchText: async () => '<html><title>Login</title></html>' }) };
  const s = await subir({ ml });
  try {
    const r = await identificar(s, URL_META);
    assert.ok(r.status >= 400, `esperava erro, veio ${r.status}`);
    assert.match(r.json.erro, /Não consegui ler o produto deste link/);
    assert.match(r.json.erro, /página sem dados de produto/);
  } finally { await s.fechar(); }
});

// ---------------------------------------------------------------- R1 (revisor): janela do cartão em destaque
test('R1a: destaque sem componente de preço seguido de cartão com preço: fica o preço do og:title, sem preço antigo', () => {
  const p = parseProductHtml(paginaSocial({ destaque: { semPreco: true } }));
  assert.deepEqual(p, { title: TITULO, price: 725, oldPrice: null, image: IMAGEM });
});

test('R1a: o mesmo com a vitrine real (outros produtos no mesmo JSON, sem ids "card-…")', () => {
  const p = parseProductHtml(paginaSocial({ destaque: { semPreco: true }, idsOutros: 'recomendacao-' }));
  assert.deepEqual(p, { title: TITULO, price: 725, oldPrice: null, image: IMAGEM });
});

test('R1a: o preço do cartão seguinte nem com o mesmo valor do og:title entra (a janela termina no próprio destaque)', () => {
  for (const idsOutros of ['card-', 'recomendacao-']) {
    const p = parseProductHtml(paginaSocial({ destaque: { semPreco: true }, idsOutros, atualOutro: 725 }));
    assert.deepEqual(p, { title: TITULO, price: 725, oldPrice: null, image: IMAGEM }, `ids ${idsOutros}`);
  }
});

test('R1b: destaque sem previous_price seguido de cartão com previous_price: sem preço antigo', () => {
  for (const idsOutros of ['card-', 'recomendacao-']) {
    const p = parseProductHtml(paginaSocial({ destaque: { anterior: null, desconto: null }, idsOutros }));
    assert.equal(p.price, 725);
    assert.equal(p.oldPrice, null, `ids ${idsOutros}`);
  }
});

test('R1c: preço do cartão divergente do og:title: vale o do og:title e não há preço antigo (nem url)', () => {
  const p = parseProductHtml(paginaSocial({ destaque: { atual: 800, url: 'www.mercadolivre.com.br/outro/p/MLB1' } }));
  assert.deepEqual(p, { title: TITULO, price: 725, oldPrice: null, image: IMAGEM });
});

test('R1c: og:title sem centavos tolera o cartão com centavos (diferença menor que R$ 1)', () => {
  const p = parseProductHtml(paginaSocial({ destaque: { atual: 725.4 } }));
  assert.equal(p.price, 725.4);
  assert.equal(p.oldPrice, 2900);
});

// ---------------------------------------------------------------- P1 (lead): endereço do produto
const PRODUTO_PATH = 'www.mercadolivre.com.br/tablet-ujj-u3-de-101-com-android-15-128-gb-e-30-gb-ram-preto/p/MLB79725856';
const URL_PRODUTO = `https://${PRODUTO_PATH}`;
const comUrl = (url) => parseProductHtml(paginaSocial({ destaque: { url } }));

test('P1: a página social devolve a url do produto em destaque (metadata.url sem esquema, "/" escapado)', () => {
  assert.deepEqual(comUrl(PRODUTO_PATH), { ...ESPERADO, url: URL_PRODUTO });
  assert.ok(!('url' in parseProductHtml(paginaSocial())), 'sem metadata.url, sem url');
});

test('P1: metadata.url fora do Mercado Livre, com query, fragmento, http ou credenciais: sem url', () => {
  for (const ruim of ['evil.example.com/p/MLB1', 'mercadolivre.com.br.evil.com/p/MLB1', `${PRODUTO_PATH}?ref=x`, `${PRODUTO_PATH}#x`,
    `http://${PRODUTO_PATH}`, `ftp://${PRODUTO_PATH}`, `user:senha@${PRODUTO_PATH}`, 'javascript:alert(1)', '']) {
    assert.ok(!('url' in comUrl(ruim)), `aceitou ${ruim}`);
  }
  assert.equal(comUrl('evil.example.com/p/MLB1').title, TITULO, 'o resto da leitura segue valendo');
});

test('P1: a url do cartão seguinte nunca é usada (destaque sem metadata.url)', () => {
  const html = paginaSocial().replace('"MLB11111111"', '"MLB11111111","url":"www.mercadolivre.com.br\\u002Foutro\\u002Fp\\u002FMLB11111111"');
  assert.ok(html.includes('outro'));
  assert.ok(!('url' in parseProductHtml(html)));
});

test('P1: resolveOffer devolve a url do produto (não o meli.la) e mantém a key do candidato', async () => {
  const fetchText = async () => paginaSocial({ destaque: { url: PRODUTO_PATH } });
  const o = await resolveOffer({ key: mlReal.offerKey(URL_META), url: URL_META }, { fetchText });
  assert.equal(o.url, URL_PRODUTO);
  assert.equal(o.key, mlReal.offerKey(URL_META));
  assert.equal(o.price, 725);
});

test('P1: o envio de um meli.la pede o link de afiliado da url do produto, não do meli.la colado', async () => {
  const links = createLinkService({ getMode: () => 'fake' });
  const pedidos = []; const requestLink = links.requestLink;
  links.requestLink = async (a) => { pedidos.push(a.url); return requestLink(a); };
  const ml = { ...mlReal, resolveOffer: (cand, deps = {}) => mlReal.resolveOffer(cand, { ...deps, fetchText: async () => paginaSocial({ destaque: { url: PRODUTO_PATH } }) }) };
  const s = await subir({ ml, links });
  try {
    s.db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run('111@g.us', 'Achadinhos', 10, Date.now());
    s.db.prepare('INSERT INTO tags (name, created_at) VALUES (?, 1)').run('etiquetaA');
    s.links.poll(0);
    const r = await req(s.port, '/api/envios', { method: 'POST', headers: { origin: `http://${HOST}:${s.port}` },
      body: { tipo: 'oferta', url: URL_META, tag_id: 1, group_jids: ['111@g.us'], quando: 'agora', link: 'https://evil.example/x', ajustes: { url: 'https://evil.example/y' } } });
    assert.equal(r.status, 200, r.txt);
    const t0 = Date.now(); let st;
    do { await new Promise((ok) => setTimeout(ok, 10)); st = s.db.prepare('SELECT status, payload FROM envios WHERE id = ?').get(r.json.id); } while (['pendente', 'enviando'].includes(st.status) && Date.now() - t0 < 5000);
    assert.equal(st.status, 'concluido');
    assert.deepEqual(pedidos, [URL_PRODUTO]);
    assert.equal(JSON.parse(st.payload).url, URL_PRODUTO);
  } finally { await s.fechar(); }
});

test('P1: sem url na página, o envio continua usando o link colado', async () => {
  const links = createLinkService({ getMode: () => 'fake' });
  const pedidos = []; const requestLink = links.requestLink;
  links.requestLink = async (a) => { pedidos.push(a.url); return requestLink(a); };
  const ml = { ...mlReal, resolveOffer: (cand, deps = {}) => mlReal.resolveOffer(cand, { ...deps, fetchText: async () => paginaSocial() }) };
  const s = await subir({ ml, links });
  try {
    s.db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run('111@g.us', 'Achadinhos', 10, Date.now());
    s.db.prepare('INSERT INTO tags (name, created_at) VALUES (?, 1)').run('etiquetaA');
    s.links.poll(0);
    const r = await req(s.port, '/api/envios', { method: 'POST', headers: { origin: `http://${HOST}:${s.port}` },
      body: { tipo: 'oferta', url: URL_META, tag_id: 1, group_jids: ['111@g.us'], quando: 'agora' } });
    assert.equal(r.status, 200, r.txt);
    const t0 = Date.now(); let st;
    do { await new Promise((ok) => setTimeout(ok, 10)); st = s.db.prepare('SELECT status FROM envios WHERE id = ?').get(r.json.id); } while (['pendente', 'enviando'].includes(st.status) && Date.now() - t0 < 5000);
    assert.equal(st.status, 'concluido');
    assert.deepEqual(pedidos, [URL_META]);
  } finally { await s.fechar(); }
});

// ---------------------------------------------------------------- S3 / S5 (rodada 1 de correção do espelhamento)
test('S3: metadata.url só vale se for endereço de produto: meli.la, vitrine /social/ e caminho sem MLB ficam sem url', () => {
  for (const ruim of ['meli.la/1qttG3Q', 'meli.la/p/MLB79725856', 'www.meli.la/MLB-1234567890', 'www.mercadolivre.com.br/social/mp0000000000000',
    'www.mercadolivre.com.br/social/p/MLB79725856', 'www.mercadolivre.com.br/ofertas', 'www.mercadolivre.com.br/', 'www.mercadolivre.com.br',
    'lista.mercadolivre.com.br/tablet', 'www.mercadolivre.com.br/p/', 'www.mercadolivre.com.br/MLB-123']) {
    assert.ok(!('url' in comUrl(ruim)), `aceitou ${ruim}`);
  }
  // anúncio (MLB-…) e catálogo (/p/MLB…) continuam valendo, inclusive em outro subdomínio do Mercado Livre
  for (const [bom, esperado] of [
    [PRODUTO_PATH, URL_PRODUTO],
    ['produto.mercadolivre.com.br/MLB-1234567890-fone-bluetooth-_JM', 'https://produto.mercadolivre.com.br/MLB-1234567890-fone-bluetooth-_JM'],
    ['www.mercadolivre.com.br/fone/p/MLB123', 'https://www.mercadolivre.com.br/fone/p/MLB123'],
  ]) assert.equal(comUrl(bom).url, esperado, bom);
  assert.equal(comUrl('meli.la/1qttG3Q').title, TITULO, 'o resto da leitura segue valendo');
});

test('S3: resolveOffer com metadata.url de meli.la mantém o link colado (não troca por outro encurtador)', async () => {
  const fetchText = async () => paginaSocial({ destaque: { url: 'meli.la/outroAfiliado' } });
  const o = await resolveOffer({ key: mlReal.offerKey(URL_META), url: URL_META }, { fetchText });
  assert.equal(o.url, URL_META);
  assert.equal(o.price, 725);
});

test('S5: página maior que 2 MiB é recusada (pelo content-length e pelo que chega sem ele); até 2 MiB é lida', async () => {
  assert.equal(mlReal.MAX_PAGINA, 2 * 1024 * 1024);
  const original = globalThis.fetch;
  const pagina = paginaSocial();
  const enchimento = (n) => `<!--${'x'.repeat(n)}-->`;
  let lidos = 0;
  /** Corpo em pedaços de 64 KiB contados conforme são lidos, sem content-length. */
  const emPedacos = (texto) => {
    const bytes = Buffer.from(texto); let i = 0;
    return new ReadableStream({ pull(c) { if (i >= bytes.length) return c.close(); const p = bytes.subarray(i, i + 65536); i += p.length; lidos += p.length; c.enqueue(p); } });
  };
  const casos = [
    ['content-length acima do teto', () => new Response('x', { headers: { 'content-length': String(mlReal.MAX_PAGINA + 1) } }), /página grande demais/],
    ['sem content-length, corpo acima do teto', () => new Response(emPedacos(pagina + enchimento(3 * 1024 * 1024))), /página grande demais/],
    ['content-length inválido', () => new Response('x', { headers: { 'content-length': 'abc' } }), /página grande demais/],
  ];
  try {
    for (const [nome, resposta, erro] of casos) {
      globalThis.fetch = async () => resposta();
      lidos = 0;
      await assert.rejects(resolveOffer({ key: 'k', url: URL_SOCIAL }), erro, nome);
      // o stream adianta um ou dois pedaços; o que importa é parar perto do teto, não ler os 5 MiB
      assert.ok(lidos <= mlReal.MAX_PAGINA + 4 * 65536, `${nome}: leu ${lidos} bytes`);
    }
    globalThis.fetch = async () => new Response(emPedacos(pagina + enchimento(mlReal.MAX_PAGINA - Buffer.byteLength(pagina) - 8)));
    const o = await resolveOffer({ key: 'k', url: URL_SOCIAL });
    assert.equal(o.title, TITULO);
    assert.equal(o.price, 725);
  } finally { globalThis.fetch = original; }
});
