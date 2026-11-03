// QA do grupo B do plano espelhamento-amazon (etapas 7 a 10), rodada 1.
// Testes exploratórios além dos arquivos dos devs (lojas, conexoes, envios, seletor-grupos): armadilhas de host e de CDN,
// ajustes do painel hostis (placeholders, colchetes, preços ambíguos), foto apagada antes do envio, cota e concorrência no
// Identificar, segredo que não pode voltar nem em mensagem de validação, estado do cartão da Amazon depois de trocar a
// credencial e o front do Disparo manual e de Conexões rodando em DOM falso. Nenhum teste acessa a rede: o `fetch` global é
// um falso que só conhece os hosts da Amazon (e conta qualquer outro pedido, que falha o teste final) e o WhatsApp é `dryRun`.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { openDb } from '../src/db.js';
import { buildApp, criarServicos } from '../src/server.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createLinkService } from '../src/links.js';
import { createScheduler } from '../src/scheduler.js';
import { createEnvios } from '../src/envios.js';
import { createAmazon, ErroAmazon, IMAGEM_AMAZON } from '../src/amazon.js';
import { identificar, imagemPermitida, linkAfiliado, lerProduto } from '../src/lojas.js';

// ---------------------------------------------------------------------------------------- rede bloqueada
let pedidosForaDaAmazon = 0;
const fetchOriginal = globalThis.fetch;
globalThis.fetch = async (url) => { pedidosForaDaAmazon++; throw new Error(`rede proibida no teste: ${new URL(String(url)).host}`); };
after(() => { globalThis.fetch = fetchOriginal; });

const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-b-')); pastas.push(p); return p; };

const SENHA = 'senha-de-teste-123';
const ASIN = 'B0FG2MD49G';
const TAG = 'dono-20';
const CRED_ID = 'amzn1.application-oa2-client.QAIDSECRETO0123456789';
const SEGREDO = 'QA-SEGREDO-Super-Secreto-xyz789!';
const TOKEN = 'Atza|QA-TOKEN-ULTRA-SECRETO-abc123';
const SEGREDOS = [CRED_ID, SEGREDO, TOKEN, 'QAIDSECRETO', 'Super-Secreto', 'ULTRA-SECRETO'];
const IMG_AMAZON = 'https://m.media-amazon.com/images/I/71abcDEF.jpg';
const LINK_LIMPO = `https://www.amazon.com.br/dp/${ASIN}?tag=${TAG}`;
const URL_LONGO = `https://www.amazon.com.br/Fone-Bluetooth-XYZ/dp/${ASIN}?tag=terceiro-20&crid=XYZ123&linkId=abc&ascsubtag=q`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsSAAALEgHS3X78AAAADUlEQVQImWNgYPhfDwACggF/NGwuCgAAAABJRU5ErkJggg==', 'base64');

const respJson = (status, corpo, headers = {}) => new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json', ...headers } });
const itemApi = (asin, extra = {}) => ({
  asin, detailPageURL: `https://www.amazon.com.br/dp/${asin}?tag=terceiro-20`,
  itemInfo: { title: { displayValue: 'Fone Bluetooth XYZ' } },
  images: { primary: { large: { url: IMG_AMAZON, height: 500, width: 500 } } },
  offersV2: { listings: [{ isBuyBoxWinner: true, price: { money: { amount: 99.9 }, savingBasis: { money: { amount: 199.9 } }, savings: { percentage: 50 } } }] },
  ...extra,
});

/** fetch falso da Amazon (injetado no createAmazon): encurtador, token e GetItems. `estado` escolhe as respostas. */
function fetchAmazon(estado = {}) {
  const chamadas = [];
  const f = async (url, init = {}) => {
    const u = String(url); chamadas.push({ url: u, metodo: init.method || 'GET' });
    if (u === 'https://amzn.to/curto1') return new Response(null, { status: 301, headers: { location: URL_LONGO } });
    if (u === 'https://api.amazon.com/auth/o2/token') return respJson(200, { access_token: TOKEN, token_type: 'bearer', expires_in: 3600 });
    if (u === 'https://creatorsapi.amazon/catalog/v1/getItems') {
      if (estado.getItems) return estado.getItems(init);
      return respJson(200, { itemsResult: { items: JSON.parse(init.body).itemIds.map((a) => itemApi(a, estado.item)) } });
    }
    throw new Error('rede não prevista no teste');
  };
  f.chamadas = chamadas;
  return f;
}
const getItemsDe = (f) => f.chamadas.filter((c) => c.url.endsWith('/getItems')).length;

function req(port, caminho, { method = 'GET', headers = {}, body, raw } = {}) {
  return new Promise((ok, err) => {
    const data = raw ?? (body != null ? Buffer.from(JSON.stringify(body)) : null);
    const h = { ...(body != null && raw == null ? { 'content-type': 'application/json' } : {}), ...(data ? { 'content-length': data.length } : {}), ...headers };
    const r = http.request({ host: '127.0.0.1', port, path: caminho, method, headers: h }, (res) => {
      const partes = []; res.on('data', (c) => partes.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(partes).toString('utf8'); let json = null; try { json = JSON.parse(txt); } catch { /* não é JSON */ }
        ok({ status: res.statusCode, headers: res.headers, json, txt });
      });
    });
    r.on('error', err); if (data) r.write(data); r.end();
  });
}

/**
 * Servidor com login, grupos 111/222 e a Amazon injetada na fila de envios (conexão fixa, fetch falso). Com
 * `doBanco`, sobe como o servidor de verdade (criarServicos): um cliente só, que lê a conexão salva e usa o fetch
 * global, para a fila e para as rotas de Conexões.
 */
async function subir({ tag = TAG, credenciais = true, getItems, item, doBanco = false } = {}) {
  const dir = tmp(); const db = openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const real = doBanco ? criarServicos({ db, wa, links, fast: true, dir }) : null;
  const scheduler = real ? real.scheduler : createScheduler({ db, wa, links, fast: true, dir });
  for (const [jid, nome] of [['111@g.us', 'Achadinhos'], ['222@g.us', 'Tech']]) {
    db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, nome, 10, Date.now());
  }
  const fetchF = fetchAmazon({ getItems, item });
  const conexao = { tag, credencial_versao: '3.1', ...(credenciais ? { credencial_id: CRED_ID, credencial_secret: SEGREDO } : {}) };
  const amazon = real ? real.amazon : createAmazon({ db, fetch: fetchF, esperar: async () => {}, lerConexao: () => conexao });
  if (!real) scheduler.envios = createEnvios({ db, wa, links, fast: true, dir, amazon });
  const app = buildApp({ db, wa, links, scheduler, publicHost: '', panelPassword: SENHA, dataDir: dir });
  const server = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  const { port } = server.address();
  const entrou = await req(port, '/api/login', { method: 'POST', body: { senha: SENHA } });
  const h = { cookie: String(entrou.headers['set-cookie']?.[0] || '').split(';')[0], origin: `http://127.0.0.1:${port}` };
  return {
    dir, db, wa, port, amazon, fetchF, conexao, envios: scheduler.envios,
    get: (c) => req(port, c, { headers: h }),
    post: (c, body = {}) => req(port, c, { method: 'POST', body, headers: h }),
    put: (c, body = {}) => req(port, c, { method: 'PUT', body, headers: h }),
    upload: (raw, tipo) => req(port, '/api/uploads', { method: 'POST', raw, headers: { ...h, 'content-type': tipo } }),
    fechar: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => { db.close(); r(); }); }),
  };
}

const statusDe = (db, id) => db.prepare('SELECT status FROM envios WHERE id = ?').get(id)?.status;
async function terminar(db, id, ms = 3000) {
  const t0 = Date.now();
  while (['pendente', 'enviando'].includes(statusDe(db, id))) {
    if (Date.now() - t0 > ms) throw new Error(`o envio ${id} não terminou`);
    await new Promise((r) => setTimeout(r, 5));
  }
  return statusDe(db, id);
}
const payloadDe = (db, id) => JSON.parse(db.prepare('SELECT payload FROM envios WHERE id = ?').get(id).payload);
function semSegredo(texto, onde) {
  for (const x of SEGREDOS) assert.ok(!String(texto).includes(x), `${onde}: vazou credencial/segredo/token (${x.slice(0, 8)}…)`);
}
const oferta = (extra = {}) => ({ tipo: 'oferta', url: URL_LONGO, template_id: 1, group_jids: ['111@g.us'], ...extra });

// ================================================================================ lojas.js (CA2, CA7)
test('QA lojas: identificar com truques de host da Amazon (userinfo, ponto final, porta, maiúsculas, subdomínio legítimo)', () => {
  for (const u of [
    'https://amazon.com.br@evil.com/dp/B0FG2MD49G', 'https://www.amazon.com.br.evil.com/dp/B0FG2MD49G', 'https://amzn.to.evil.com/x',
    'https://a.co.evil.com/x', 'https://evil.com/dp/B0FG2MD49G?u=https://www.amazon.com.br', 'https://amazon.com.br./dp/B0FG2MD49G',
    'https://www.amazon.com.br%2eevil.com/dp/B0FG2MD49G', 'https://xn--amazon-9ve.com.br/dp/B0FG2MD49G',
    'https://amazon.com.br.\\evil.com/', 'amazon.com.br/dp/B0FG2MD49G', 'https://www.amazon.de/dp/B0FG2MD49G',
  ]) assert.equal(identificar(u), null, u);
  // legítimos: caixa do host, subdomínio, porta explícita (a porta só é recusada pelo resolvedor de redirecionamento), http
  for (const u of ['HTTPS://WWW.AMAZON.COM.BR/dp/B0FG2MD49G', 'https://smile.amazon.com.br/dp/B0FG2MD49G', 'http://amzn.to/abc', 'https://amazon.com/dp/B0FG2MD49G', 'https://link.amazon/aBc12']) {
    assert.equal(identificar(u)?.id, 'amazon', u);
  }
});

test('QA lojas: IMAGEM_AMAZON recusa URL que só parece do CDN (userinfo, porta, caminho, barra invertida, quebra de linha)', () => {
  for (const img of [
    'https://media-amazon.com@evil.com/x.jpg', 'https://m.media-amazon.com:8443/x.jpg', 'https://evil.com/m.media-amazon.com/x.jpg',
    'https://evil.com\\.media-amazon.com/x.jpg', 'https://m.media-amazon.com.evil.com/x.jpg', 'https://m.media-amazon.com\n.evil.com/x.jpg',
    'https://evil.com?.media-amazon.com/x.jpg', 'https://m.media-amazon.com', 'HTTP://m.media-amazon.com/x.jpg', ' https://m.media-amazon.com/x.jpg',
    'ftp://m.media-amazon.com/x.jpg',
  ]) assert.equal(imagemPermitida('amazon', img), false, JSON.stringify(img));
  // o que o CDN real manda continua passando (caixa do esquema e do host, subdomínios, números e hífen)
  for (const img of [IMG_AMAZON, 'HTTPS://M.MEDIA-AMAZON.COM/images/I/x.jpg', 'https://images-na.ssl-images-amazon.com/images/I/x.jpg', 'https://m.media-amazon.com/images/I/71+abc%2B.jpg?x=1']) {
    assert.equal(imagemPermitida('amazon', img), true, img);
  }
});

test('QA lojas: linkAfiliado da Amazon ignora `tag` e ASIN malformado do chamador e usa o ASIN do link; `asin` válido (minúsculo) vale', async () => {
  const montados = [];
  const amazon = {
    montarLink: (a) => { montados.push(a); return `https://www.amazon.com.br/dp/${a}?tag=${TAG}`; },
    resolver: async () => { throw new Error('não devia resolver: o link já traz o ASIN'); },
  };
  const outro = 'B0AAAAAAAA';
  assert.equal(await linkAfiliado('amazon', { url: URL_LONGO, tag: 'evil-20', asin: `${outro}&tag=evil-20` }, { amazon }), LINK_LIMPO, 'ASIN com lixo é descartado');
  assert.equal(await linkAfiliado('amazon', { url: URL_LONGO, asin: outro.toLowerCase() }, { amazon }), `https://www.amazon.com.br/dp/${outro}?tag=${TAG}`, 'asin válido em minúsculas sobe para maiúsculas');
  for (const lixo of [null, 42, {}, [ASIN], 'B0FG2MD49', 'B0FG2MD49GG', ' ']) {
    assert.equal(await linkAfiliado('amazon', { url: URL_LONGO, asin: lixo }, { amazon }), LINK_LIMPO, String(lixo));
  }
  assert.ok(montados.every((a) => /^[A-Z0-9]{10}$/.test(a)), `montarLink só recebeu ASIN limpo: ${montados}`);
  await assert.rejects(linkAfiliado('amazon', { url: 'https://produto.mercadolivre.com.br/MLB-1-x_JM', asin: ASIN }, { amazon }), /não é da loja Amazon/);
});

test('QA lojas: erro cru de lerItem (com ID, segredo e URL na mensagem) não chega ao chamador; vira ErroAmazon fixo com o ASIN', async () => {
  const amazon = {
    resolver: async () => ({ asin: ASIN, urlFinal: URL_LONGO }),
    lerItem: async () => { throw new Error(`fetch failed https://creatorsapi.amazon/x?client=${CRED_ID}&secret=${SEGREDO} token ${TOKEN}`); },
  };
  let e;
  try { await lerProduto('amazon', URL_LONGO, { amazon }); } catch (x) { e = x; }
  assert.ok(e instanceof ErroAmazon, 'vira ErroAmazon');
  assert.equal(e.tipo, 'indisponivel'); assert.equal(e.asin, ASIN);
  semSegredo(`${e.message} ${e.stack?.split('\n')[0]} ${JSON.stringify(e)}`, 'erro de lerProduto');
  assert.ok(!/creatorsapi|https?:/.test(e.message), 'sem URL na mensagem');
});

// ================================================================================ envios.js (CA2, CA6, CA7)
test('QA envios: ajustes hostis (placeholders, colchetes, markdown, quebra de linha) no título e no cupom saem como texto puro', async () => {
  const s = await subir();
  try {
    const r = await s.post('/api/envios', oferta({
      ajustes: { title: '{LINK} [{CUPOM}] *negrito* {PRECO_PRODUTO}\n\n{FRETE}', coupon: '{TITULO_COMPLETO} [x]', freeShipping: false },
    }));
    assert.equal(r.status, 200, r.txt);
    assert.equal(await terminar(s.db, r.json.id), 'concluido');
    const texto = s.wa.simulated[0].text;
    assert.equal(texto.split(LINK_LIMPO).length - 1, 1, 'o link aparece uma vez só (o {LINK} do título não foi expandido)');
    assert.ok(texto.includes('{LINK}') || texto.includes('LINK'), 'o título vai como texto, sem virar placeholder');
    assert.match(texto, /Cupom: \*\{TITULO_COMPLETO\} \[x\]\*/, 'o cupom também não é interpretado');
    assert.ok(!texto.includes('terceiro') && !texto.includes('crid'));
    assert.equal(payloadDe(s.db, r.json.id).offer.title.includes('\n'), false, 'quebra de linha do título vira espaço');
  } finally { await s.fechar(); }
});

test('QA envios: preços do painel em formatos ambíguos (milhar, R$, ponto decimal, vírgula e ponto juntos) viram o valor certo ou erro claro', async () => {
  const s = await subir({ getItems: () => respJson(403, { __type: 'AccessDeniedException', reason: 'AssociateNotEligible', message: 'x' }) });
  try {
    const casos = [
      ['1.299,90', 1299.9], ['R$ 89,90', 89.9], ['r$89,90', 89.9], ['89.90', 89.9], ['89', 89], ['1.299.999,00', 1299999], [' 12,5 ', 12.5], [10, 10], [89.999, 90],
    ];
    for (const [entrada, esperado] of casos) {
      const r = await s.post('/api/envios', oferta({ ajustes: { title: 'Produto', price: entrada } }));
      assert.equal(r.status, 200, `${JSON.stringify(entrada)}: ${r.txt}`);
      assert.equal(payloadDe(s.db, r.json.id).offer.price, esperado, JSON.stringify(entrada));
    }
    for (const ruim of ['1,299.90', '1.29', '1..299,90', '12,345', '9,9,9', '1e3', '0x10', '٣٠', 'NaN', 'Infinity', '89,90 reais', '-5', '0,00', '10000001']) {
      const r = await s.post('/api/envios', oferta({ ajustes: { title: 'Produto', price: ruim } }));
      if (ruim === '1.29') { assert.equal(r.status, 200, '"1.29" é 1,29 (ponto decimal com 2 casas)'); continue; }
      assert.equal(r.status, 400, `${ruim} deveria ser recusado (obtido ${r.status}: ${r.txt.slice(0, 80)})`);
      assert.match(r.json.erro, /Preço atual inválido/);
    }
    // oldPrice igual ao price some (sem linha "De" inventada) e o "De" nunca fica maior que o desconto permite
    const igual = await s.post('/api/envios', oferta({ ajustes: { title: 'P', price: '50,00', oldPrice: '50,00' } }));
    assert.equal(payloadDe(s.db, igual.json.id).offer.oldPrice, null);
  } finally { await s.fechar(); }
});

test('QA envios: título só com espaços e "ajustes.title" vazio apagam o título da API e o disparo é recusado (nada gravado)', async () => {
  const s = await subir();
  try {
    for (const title of ['', '   ', '\n\t']) {
      const r = await s.post('/api/envios', oferta({ ajustes: { title } }));
      assert.equal(r.status, 400, JSON.stringify(title));
      assert.equal(r.json.erro, 'Preencha o título do produto.');
    }
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM envios').get().n, 0);
    // chave ausente mantém o título da API (o painel só manda `title` quando o campo existe)
    const ok = await s.post('/api/envios', oferta({ ajustes: { coupon: 'X1' } }));
    assert.equal(ok.status, 200, ok.txt);
    assert.equal(payloadDe(s.db, ok.json.id).offer.title, 'Fone Bluetooth XYZ');
  } finally { await s.fechar(); }
});

test('QA envios: foto da API fora do CDN da Amazon (detalhe da API hostil) nunca vai ao navegador nem ao WhatsApp', async () => {
  const s = await subir({ item: { images: { primary: { large: { url: 'https://evil.example/pixel.jpg' } } } } });
  try {
    const id = await s.post('/api/disparo/identificar', { url: URL_LONGO, template_id: 1 });
    assert.equal(id.status, 200, id.txt);
    assert.equal(id.json.produto.image, null, 'o produto devolvido ao painel não traz URL de fora do CDN');
    assert.ok(!id.txt.includes('evil.example'));
    const r = await s.post('/api/envios', oferta());
    assert.equal(await terminar(s.db, r.json.id), 'concluido');
    assert.equal(s.wa.simulated[0].tipo, 'text', 'sem foto permitida: só texto');
    assert.ok(!JSON.stringify(payloadDe(s.db, r.json.id)).includes('evil.example'));
  } finally { await s.fechar(); }
});

test('QA envios: Identificar repetido e simultâneo do mesmo produto faz uma consulta só à API (cache e fila), sem vazar segredo', async () => {
  const s = await subir();
  try {
    const rs = await Promise.all(Array.from({ length: 6 }, () => s.post('/api/disparo/identificar', { url: URL_LONGO, template_id: 1 })));
    for (const r of rs) { assert.equal(r.status, 200, r.txt); assert.equal(r.json.produto.title, 'Fone Bluetooth XYZ'); semSegredo(r.txt, 'identificar'); }
    assert.equal(getItemsDe(s.fetchF), 1, 'seis pedidos ao mesmo tempo → um GetItems só');
    assert.equal(s.fetchF.chamadas.filter((c) => c.url.includes('/auth/o2/token')).length, 1, 'um token só');
    assert.ok(s.fetchF.chamadas.every((c) => c.metodo === 'POST' || c.metodo === 'GET'));
    assert.equal(s.fetchF.chamadas.filter((c) => c.metodo === 'HEAD').length, 0, 'nunca HEAD');
  } finally { await s.fechar(); }
});

test('QA envios: cota (429) e credencial recusada (401) no Identificar dão causa e campos em branco, e o disparo manual continua possível', async () => {
  const cota = await subir({ getItems: () => respJson(429, { type: 'ThrottleException', message: `limite ${CRED_ID}` }, { 'retry-after': '30' }) });
  try {
    const r = await cota.post('/api/disparo/identificar', { url: URL_LONGO, template_id: 1 });
    assert.deepEqual([r.status, r.json.causa, r.json.produto.title, r.json.produto.price], [200, 'cota', null, null]);
    semSegredo(r.txt, 'identificar 429');
    const e = await cota.post('/api/envios', oferta({ ajustes: { title: 'À mão', price: '10,00' } }));
    assert.equal(e.status, 200, e.txt);
    assert.equal(await terminar(cota.db, e.json.id), 'concluido');
    assert.equal(payloadDe(cota.db, e.json.id).fonte_dados, 'manual');
  } finally { await cota.fechar(); }
  const recusada = await subir({ getItems: () => respJson(401, { __type: 'UnauthorizedException', reason: 'InvalidToken', message: `bearer ${TOKEN}` }) });
  try {
    const r = await recusada.post('/api/disparo/identificar', { url: URL_LONGO, template_id: 1 });
    assert.equal(r.status, 200, r.txt); assert.equal(r.json.causa, 'sem_acesso'); semSegredo(r.txt, 'identificar 401');
    assert.equal(recusada.amazon.situacao().acesso, 'credenciais_invalidas');
  } finally { await recusada.fechar(); }
});

test('QA envios: "agora" com o WhatsApp desconectado é recusado também na Amazon (sem rede e sem gravar)', async () => {
  const s = await subir();
  try {
    s.wa.isReady = () => false;
    const r = await s.post('/api/envios', oferta());
    assert.deepEqual([r.status, r.json.erro], [400, 'O WhatsApp está desconectado. Conecte o número antes de disparar.']);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM envios').get().n, 0);
    assert.equal(getItemsDe(s.fetchF), 0, 'recusou antes de consultar a API');
  } finally { await s.fechar(); }
});

test('QA envios: mensagem com prévia de link da Amazon é recusada (a prévia é só do Mercado Livre) e não vai à rede', async () => {
  const s = await subir();
  try {
    const r = await s.post('/api/envios', { tipo: 'mensagem', texto: `olha ${LINK_LIMPO}`, imagem: 'previa', previa_url: URL_LONGO, group_jids: ['111@g.us'] });
    assert.equal(r.status, 400, r.txt);
    assert.match(r.json.erro, /prévia/i);
    assert.equal(s.fetchF.chamadas.length, 0);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM envios').get().n, 0);
  } finally { await s.fechar(); }
});

test('QA envios: foto trocada que some antes do horário (agendado) deixa o envio em erro, com o motivo, sem enviar texto nem vazar segredo', async (t) => {
  const alvo = Date.now() + 3 * 60000;
  if (new Date(alvo).toDateString() !== new Date().toDateString()) { t.skip('perto da meia-noite: o disparo manual só agenda para hoje'); return; }
  const T = new Date(alvo).setSeconds(0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  const s = await subir();
  try {
    const up = await s.upload(PNG, 'image/png');
    assert.equal(up.status, 200, up.txt);
    const r = await s.post('/api/envios', oferta({ quando: 'agendado', agendar_hhmm: `${pad(new Date(alvo).getHours())}:${pad(new Date(alvo).getMinutes())}`, ajustes: { upload: up.json.id } }));
    assert.equal(r.status, 200, r.txt);
    fs.rmSync(path.join(s.dir, 'uploads', up.json.id)); // o dono (ou a limpeza) apagou a foto
    await s.envios.processarPendentes(T + 1000);
    assert.equal(statusDe(s.db, r.json.id), 'erro');
    assert.equal(s.wa.simulated.length, 0, 'não manda a oferta sem a foto que o dono escolheu');
    const erro = s.db.prepare('SELECT erro FROM envio_resultados WHERE envio_id = ?').get(r.json.id)?.erro
      ?? s.db.prepare("SELECT message FROM log WHERE level = 'erro'").get()?.message;
    assert.match(String(erro), /foto/i);
    semSegredo(JSON.stringify(s.db.prepare('SELECT * FROM log').all()), 'log');
  } finally { await s.fechar(); }
});

test('QA envios: dois disparos da mesma oferta ao mesmo tempo viram dois envios independentes, cada grupo recebe um de cada, com o link limpo', async () => {
  const s = await subir();
  try {
    const rs = await Promise.all([1, 2].map(() => s.post('/api/envios', oferta({ group_jids: ['111@g.us', '222@g.us'] }))));
    for (const r of rs) assert.equal(r.status, 200, r.txt);
    assert.notEqual(rs[0].json.id, rs[1].json.id);
    for (const r of rs) assert.equal(await terminar(s.db, r.json.id), 'concluido');
    assert.equal(s.wa.simulated.length, 4);
    for (const jid of ['111@g.us', '222@g.us']) assert.equal(s.wa.simulated.filter((m) => m.jid === jid).length, 2, jid);
    assert.ok(s.wa.simulated.every((m) => m.text.endsWith(`Compre aqui: ${LINK_LIMPO}`)));
  } finally { await s.fechar(); }
});

// ================================================================================ conexoes.js (CA2, CA7)
test('QA conexões: erro de validação nunca repete o valor digitado (ID, segredo, tag, versão), mesmo em campo inválido', async () => {
  const s = await subir();
  try {
    const valores = {
      credencial_id: 'ID com espaço SECRETOQA1', credencial_secret: 'segredo com espaço QASEGREDO2', tag: 'tag com espaço QATAG3', credencial_versao: '3.9-QAVERSAO4',
    };
    const r = await s.put('/api/conexoes/amazon', { campos: valores });
    assert.equal(r.status, 400, r.txt);
    for (const v of Object.values(valores)) assert.ok(!r.txt.includes(v), `a resposta repete "${v}"`);
    for (const marca of ['SECRETOQA1', 'QASEGREDO2', 'QATAG3', 'QAVERSAO4']) assert.ok(!r.txt.includes(marca), marca);
    const cru = s.db.prepare("SELECT config, segredos FROM conexoes WHERE plataforma = 'amazon'").get();
    assert.equal(cru, undefined, 'tudo ou nada: nada foi gravado');
    // tipos errados no corpo
    for (const campos of [{ tag: 123456 }, { tag: ['dono-20'] }, { tag: { a: 1 } }, { credencial_secret: true }]) {
      const e = await s.put('/api/conexoes/amazon', { campos });
      if (typeof campos.tag === 'number') { assert.equal(e.status, 200, 'número vira texto, como nas outras lojas'); continue; }
      assert.equal(e.status, 400, JSON.stringify(campos)); assert.match(e.json.erro, /valor inválido/);
    }
  } finally { await s.fechar(); }
});

test('QA conexões: limites da tag (2 a 64, só letras, números, _ e -), da versão (3.1 a 3.3) e aparamento de espaços', async () => {
  const s = await subir();
  try {
    const salvar = (campos) => s.put('/api/conexoes/amazon', { campos });
    const cartao = async () => (await s.get('/api/conexoes')).json.find((p) => p.id === 'amazon');
    for (const tag of ['a', 'a'.repeat(65), 'dono 20', 'dono.20', 'dono@20', 'dóno-20', 'dono-20\nx', 'dono-20; DROP', '<b>x</b>', 'dono-20&x=1', 'ＤＯＮＯ']) {
      const r = await salvar({ tag }); assert.equal(r.status, 400, JSON.stringify(tag));
    }
    for (const [entrada, esperado] of [['ab', 'ab'], ['a'.repeat(64), 'a'.repeat(64)], ['  seunome-20  ', 'seunome-20'], ['--', '--'], ['Dono_20', 'Dono_20']]) {
      const r = await salvar({ tag: entrada });
      assert.equal(r.status, 200, `${entrada}: ${r.txt}`); assert.equal(r.json.config.tag, esperado);
    }
    for (const v of ['3.0', '3.4', '3.10', '3', '3.1 ', '3,1', 'v3.1']) {
      const r = await salvar({ credencial_versao: v });
      if (v === '3.1 ') { assert.equal(r.status, 200, 'espaço no fim é aparado'); continue; }
      assert.equal(r.status, 400, v);
    }
    for (const v of ['3.1', '3.2', '3.3']) assert.equal((await salvar({ credencial_versao: v })).json.config.credencial_versao, v);
    assert.equal((await cartao()).config.tag, 'Dono_20', 'os 400 não mexeram no que estava salvo');
    // apagar a tag (texto vazio) volta o cartão a "falta configurar" e o espelhamento deixa de poder ligar
    const sem = await salvar({ tag: '' });
    assert.deepEqual([sem.status, sem.json.estado, 'tag' in sem.json.config], [200, 'falta_configurar', false]);
  } finally { await s.fechar(); }
});

test('QA conexões: o servidor de verdade (criarServicos) testa a Amazon só pelos hosts da Amazon e salvar uma credencial nova tira o "Conectada" da antiga', async (t) => {
  const s = await subir({ doBanco: true }); // cliente único lendo a conexão salva, sobre o fetch global
  const original = globalThis.fetch;
  const pedidos = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url); pedidos.push(u);
    if (u === 'https://api.amazon.com/auth/o2/token') return respJson(200, { access_token: TOKEN, token_type: 'bearer', expires_in: 3600 });
    if (u === 'https://creatorsapi.amazon/catalog/v1/getItems') return respJson(200, { itemsResult: { items: JSON.parse(init.body).itemIds.map((a) => itemApi(a)) } });
    pedidosForaDaAmazon++; throw new Error('rede proibida no teste');
  };
  try {
    const estado = async () => (await s.get('/api/conexoes')).json.find((p) => p.id === 'amazon');
    const salvar = (campos) => s.put('/api/conexoes/amazon', { campos });
    assert.equal((await estado()).estado, 'falta_configurar');
    assert.equal((await salvar({ tag: TAG })).json.estado, 'so_tag');
    assert.equal((await salvar({ credencial_id: CRED_ID, credencial_secret: SEGREDO })).json.estado, 'pronta');
    const teste = await s.post('/api/conexoes/amazon/testar');
    assert.deepEqual([teste.status, teste.json.ok, teste.json.resultado], [200, true, 'ok']);
    semSegredo(teste.txt, 'testar');
    const conectada = await estado();
    assert.equal(conectada.estado, 'conectada'); assert.equal(conectada.situacao.acesso, 'ok');
    // outra credencial: a confirmação da antiga não vale mais
    const nova = await salvar({ credencial_id: `${CRED_ID}-NOVA`, credencial_secret: `${SEGREDO}-NOVO` });
    assert.equal(nova.json.estado, 'pronta', 'credencial trocada: volta a "pronta" até testar de novo');
    assert.notEqual(nova.json.situacao.acesso, 'ok');
    // e a tag nova também (o "ok" depende da tag)
    assert.equal((await s.post('/api/conexoes/amazon/testar')).json.ok, true);
    assert.equal((await estado()).estado, 'conectada');
    const comTagNova = await salvar({ tag: 'outra-20' });
    assert.equal(comTagNova.json.estado, 'pronta', 'tag trocada: volta a "pronta" até testar de novo');
    semSegredo(JSON.stringify(await estado()), 'GET /api/conexoes');
    assert.ok(pedidos.every((u) => /^https:\/\/(api\.amazon\.com|creatorsapi\.amazon)\//.test(u)), pedidos.join(' '));
  } finally { globalThis.fetch = original; await s.fechar(); }
});

// ================================================================================ front (CA6): Disparo manual e Conexões em DOM falso
function elementoFalso(id = '') {
  const e = {
    id, children: [], style: {}, dataset: {}, attrs: {}, hidden: false, disabled: false, checked: false, value: '', textContent: '', className: '', _html: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] ?? null; }, removeAttribute(k) { delete this.attrs[k]; },
    appendChild(c) { this.children.push(c); return c; }, focus() {}, click() {}, addEventListener() {}, remove() {}, closest() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    get innerHTML() { return this._html; }, set innerHTML(v) { this._html = String(v); },
  };
  return e;
}

/** Carrega public/disparos.js num contexto vm com o mínimo de DOM; devolve o escopo para chamar `dispLerPreco` e afins. */
function carregarDisparos() {
  const ctx = {
    console, setTimeout, clearTimeout, Number, String, Math, Date, JSON, Array, Object, RegExp, URL, Intl, Promise, Symbol, Error, Set, Map,
    document: { createElement: () => elementoFalso(), getElementById: () => null, activeElement: null, body: elementoFalso('body') },
    $: () => null, $$: () => [], esc: (s) => String(s), zap: (s) => String(s), REQ: '*', S: { templates: [], tags: [], groups: [], st: {} },
    seletorGrupos: () => ({ html: '', ligar() {}, marcados: () => [] }), aviso() {}, mostrarErros() {}, opcoes: () => '', q: () => '',
    location: { hash: '' }, confirm: () => true, FileReader: class {}, fetch: async () => { throw new Error('rede proibida no teste'); },
  };
  vm.createContext(ctx);
  const codigo = fs.readFileSync(new URL('../public/disparos.js', import.meta.url), 'utf8');
  vm.runInContext(`${codigo}\n;globalThis.__x = { dispLerPreco, dispDesconto, dispPrecoCampo, dispImgSegura, DISP_IMG_AMAZON, TEXTOS_DISPAROS };`, ctx);
  return ctx.__x;
}

test('QA front: dispLerPreco do painel e o lerPreco do servidor concordam nos formatos comuns (o que o painel mostra é o que o servidor grava)', async () => {
  const { dispLerPreco } = carregarDisparos();
  const s = await subir({ getItems: () => respJson(403, { __type: 'AccessDeniedException', reason: 'AssociateNotEligible', message: 'x' }) });
  try {
    for (const campo of ['1.299,90', 'R$ 89,90', '89.90', '89,9', '1299', '12', '1.299', '0,99', '1.234.567,89']) {
      const painel = dispLerPreco(campo);
      assert.ok(Number.isFinite(painel), `${campo}: o painel não entendeu`);
      // o painel manda o NÚMERO (ajustes() usa o valor já interpretado), então o servidor recebe um número
      const r = await s.post('/api/envios', oferta({ ajustes: { title: 'P', price: painel } }));
      assert.equal(r.status, 200, `${campo}: ${r.txt}`);
      assert.equal(payloadDe(s.db, r.json.id).offer.price, painel, campo);
    }
    for (const ruim of ['abc', '12,3x', '-5', '0', '0,00', '1e3', '10000000', '1,2,3']) assert.ok(Number.isNaN(dispLerPreco(ruim)), `${ruim} devia ser inválido no painel`);
    assert.equal(dispLerPreco(''), null); assert.equal(dispLerPreco('   '), null); assert.equal(dispLerPreco(null), null);
  } finally { await s.fechar(); }
});

test('QA front: o CDN que a tela mostra é o mesmo que o servidor aceita (IMAGEM_AMAZON) e o resto vira o desenho de sacola', () => {
  const { DISP_IMG_AMAZON, dispImgSegura } = carregarDisparos();
  assert.equal(DISP_IMG_AMAZON.source, IMAGEM_AMAZON.source, 'mesma regex nos dois lados');
  assert.equal(DISP_IMG_AMAZON.flags, IMAGEM_AMAZON.flags);
  assert.equal(dispImgSegura(IMG_AMAZON), IMG_AMAZON);
  for (const x of ['https://evil.com/x.jpg', 'javascript:alert(1)', 'https://media-amazon.com@evil.com/x.jpg', '', null, undefined]) assert.notEqual(dispImgSegura(x), x, String(x));
});

test('QA front: a CSP do servidor libera o CDN da Amazon; foto que não carrega cai no desenho de sacola em vez de quebrar', () => {
  // A ligação da Amazon no servidor (rodada 1 de correção, R1) liberou o CDN no img-src: a asserção foi invertida
  // como este alarme pedia.
  const server = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const csp = /const CSP = "([^"]+)"/.exec(server)?.[1] ?? '';
  assert.match(csp, /img-src 'self' data: https:\/\/\*\.mlstatic\.com/);
  assert.match(csp, /img-src [^;]*https:\/\/\*\.media-amazon\.com/, 'a CSP libera media-amazon.com');
  assert.match(csp, /img-src [^;]*https:\/\/\*\.ssl-images-amazon\.com/, 'a CSP libera ssl-images-amazon.com');
  const painel = fs.readFileSync(new URL('../public/disparos.js', import.meta.url), 'utf8');
  assert.match(painel, /img\.onerror = \(\) => \{ img\.onerror = null; img\.src = DISP_IMG_VAZIA; \}/, 'a foto que não carrega vira o desenho de sacola');
});

test('QA: nenhum teste deste arquivo acessou a rede fora dos hosts simulados da Amazon', () => {
  assert.equal(pedidosForaDaAmazon, 0);
});
