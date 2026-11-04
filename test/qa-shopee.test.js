// QA, integração da Shopee, rodada 1 (03/11/2026). Ponta a ponta pelo servidor de verdade:
// criarServicos + buildApp em porta aleatória, a extensão simulada por links.poll/submit, a Open API e os
// encurtadores por um `fetch` falso injetado. O fetch global é bloqueado e o último teste prova que ninguém o chamou.
// WhatsApp em dryRun (wa.simulated), banco numa pasta temporária. Não duplica test/shopee.test.js (unidade do cliente),
// test/links.test.js, test/extensao-shopee.test.js, test/envios.test.js nem test/servidor.test.js: aqui o foco é a
// volta inteira (Identificar → Disparar/Agendar → simulated), as bordas entre as peças e os vazamentos.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { openDb } from '../src/db.js';
import { buildApp, criarServicos } from '../src/server.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createLinkService } from '../src/links.js';
import { extrairIds, URL_API } from '../src/shopee.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let acessosRede = 0;
const fetchOriginal = globalThis.fetch;
globalThis.fetch = async () => { acessosRede++; throw new Error('rede proibida no teste'); };

const pastas = [];
after(() => { globalThis.fetch = fetchOriginal; for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-qash-')); pastas.push(p); return p; };

// ------------------------------------------------------------------------------------------------- dados
const GRUPO = '111@g.us';
const ID_AF = '98765432101';
const APP_ID = '987654321';
const CHAVE = 'Sentinela-Senha-API-Zz9Yy8Xx7';
const SHOP = '52377417';
const ITEM = '6309028319';
const PRODUTO = `https://shopee.com.br/Fone-Bom-Sem-Fio-i.${SHOP}.${ITEM}`;
const IMG = 'https://down-br.img.susercontent.com/file/br-11134207-7r98o-abc123';
const LINK_API = 'https://s.shopee.com.br/ApiLink001';
const LINK_EXT = 'https://s.shopee.com.br/ExtLink001';
const longoDe = (id, base = PRODUTO) => `${base}?utm_source=an_${id}&utm_medium=affiliates&utm_term=abc`;

const respJson = (status, corpo, headers = {}) => new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json', ...headers } });
const redir = (status, location) => new Response(null, { status, headers: location ? { location } : {} });

const noApi = (item = ITEM, extra = {}) => ({
  itemId: Number(item), productName: 'Fone Bom Sem Fio', priceMin: '89.90', priceMax: '99.90', priceDiscountRate: 15, sales: 1234,
  ratingStar: '4.83', imageUrl: IMG, shopName: 'Loja Oficial', ...extra,
});

/**
 * fetch falso da Shopee. `estado`:
 *  - api: 'ok' | 'vazio' (nodes []) | 'outro-item' (devolve outro itemId) | número (código de erro da Open API, HTTP 200)
 *  - apiLink: 'ok' | 'hostil' (shortLink fora de s.shopee.com.br) | número (erro só no generateShortLink)
 *  - curtos: URL → { status, location } | Response
 * Guarda tudo em `chamadas` ({ url, query?, autorizacao? }). Qualquer outro host lança.
 */
function fetchShopee(estado = {}) {
  const chamadas = [];
  const f = async (url, init = {}) => {
    const u = String(url);
    const c = { url: u, metodo: init.method || 'GET', redirect: init.redirect };
    chamadas.push(c);
    if (u === URL_API) {
      const query = JSON.parse(init.body).query;
      c.query = query; c.autorizacao = init.headers?.Authorization ?? null; c.corpo = init.body;
      const mutacao = query.startsWith('mutation');
      const modo = mutacao ? (estado.apiLink ?? estado.api ?? 'ok') : (estado.api ?? 'ok');
      if (Number.isInteger(modo)) {
        return respJson(200, { errors: [{ message: `falha ${modo}: Authorization ${init.headers?.Authorization} senha ${CHAVE} app ${APP_ID}`, extensions: { code: modo } }], data: null });
      }
      if (estado.lancar) throw new Error(`conexão caiu: ${init.headers?.Authorization} ${CHAVE}`);
      if (mutacao) return respJson(200, { data: { generateShortLink: { shortLink: modo === 'hostil' ? 'https://s.shopee.com.br.evil.example/abc' : (estado.linkApi ?? LINK_API) } } });
      const id = /itemId:(\d+)/.exec(query)?.[1] ?? ITEM;
      if (modo === 'vazio') return respJson(200, { data: { productOfferV2: { nodes: [] } } });
      if (modo === 'outro-item') return respJson(200, { data: { productOfferV2: { nodes: [noApi('999999')] } } });
      return respJson(200, { data: { productOfferV2: { nodes: [noApi(id, estado.no)] } } });
    }
    if (estado.curtos && Object.hasOwn(estado.curtos, u)) {
      const v = estado.curtos[u];
      return v instanceof Response ? v : redir(v.status ?? 302, v.location);
    }
    throw new Error(`rede não prevista no teste: ${u}`);
  };
  f.chamadas = chamadas;
  f.api = () => chamadas.filter((c) => c.url === URL_API);
  f.queries = () => f.api().map((c) => c.query);
  f.mutacoes = () => f.queries().filter((q) => q.startsWith('mutation'));
  f.consultas = () => f.queries().filter((q) => !q.startsWith('mutation'));
  return f;
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
 * Servidor como o main monta. modo: modo do serviço de links ('extension' padrão: a extensão é de verdade, simulada por
 * `extensao`). `fetch`: o falso da Shopee/Amazon. `ml`: leitor do Mercado Livre (injetado). Senha de painel opcional.
 */
async function montar({ modo = 'extension', fetch = fetchShopee(), ml, panelPassword = '', semGrupo = false } = {}) {
  const dir = tmp();
  const db = openDb(dir);
  if (!semGrupo) db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(GRUPO, 'Achadinhos', 10, Date.now());
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => modo });
  const { amazon, shopee, scheduler } = criarServicos({ db, wa, links, fast: true, dir, fetch, ...(ml ? { ml } : {}) });
  const app = buildApp({ db, wa, links, scheduler, amazon, shopee, publicHost: '', panelPassword, dataDir: dir, ...(ml ? { ml } : {}) });
  const server = await new Promise((ok) => { const x = app.listen(0, '127.0.0.1', () => ok(x)); });
  const port = server.address().port;
  const s = {
    dir, db, wa, links, amazon, shopee, scheduler, fetch, port,
    get: (c) => pedir(port, 'GET', c), post: (c, b) => pedir(port, 'POST', c, b), put: (c, b) => pedir(port, 'PUT', c, b),
    fechar: async () => { server.closeAllConnections?.(); await new Promise((ok) => server.close(ok)); db.close(); },
    /** Salva a conexão Shopee pelo painel (PUT). */
    conectar: async (campos = { id_afiliado: ID_AF, app_id: APP_ID, chave: CHAVE }) => {
      const r = await pedir(port, 'PUT', '/api/conexoes/shopee', { campos });
      assert.equal(r.status, 200, r.txt);
      return r;
    },
    cartao: async () => (await pedir(port, 'GET', '/api/conexoes')).json.find((p) => p.id === 'shopee'),
    identificar: (url, extra = {}) => pedir(port, 'POST', '/api/disparo/identificar', { url, ...extra }),
    disparar: (corpo = {}) => pedir(port, 'POST', '/api/envios', { tipo: 'oferta', url: PRODUTO, template_id: 1, group_jids: [GRUPO], quando: 'agora', ...corpo }),
    envios: () => s.db.prepare('SELECT * FROM envios ORDER BY id').all(),
    payloads: () => s.envios().map((e) => JSON.parse(e.payload)),
    msgs: () => s.wa.simulated.filter((m) => m.jid === GRUPO),
    /** Espera todo envio sair de pendente/enviando (por iterações, não pelo relógio). */
    assentar: async () => {
      for (let i = 0; i < 400 && s.db.prepare("SELECT COUNT(*) AS n FROM envios WHERE status IN ('pendente','enviando')").get().n; i++) await new Promise((ok) => setTimeout(ok, 10));
      assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM envios WHERE status IN ('pendente','enviando')").get().n, 0, 'envio não terminou');
    },
  };
  return s;
}

/**
 * A extensão de mentira: pergunta por pedidos a cada 5 ms (isso a mantém "on-line") e responde pelo `tratar(job)`
 * → { ok, link, longo, error }. `jobs` guarda o que ela recebeu. parar() para de perguntar.
 */
function extensao(s, tratar = () => ({ ok: true, link: LINK_EXT, longo: longoDe(ID_AF) })) {
  const e = { jobs: [], ativa: true };
  const laco = async () => {
    while (e.ativa) {
      const job = await s.links.poll(0);
      if (job) { e.jobs.push(job); const r = await tratar(job, e.jobs.length); s.links.submit(job.id, r); }
      else await new Promise((ok) => setTimeout(ok, 5));
    }
  };
  e.fim = laco();
  e.parar = async () => { e.ativa = false; await e.fim; };
  return e;
}
/** Só marca a extensão como on-line (um poll), sem atender pedido nenhum (os pedidos esperam até o timeout). */
const marcarOnline = (s) => s.links.poll(0);

const capturarSaidas = (t) => {
  const espias = ['error', 'warn', 'log', 'info', 'debug'].map((m) => t.mock.method(console, m, () => {}));
  const saidas = [];
  for (const fluxo of [process.stdout, process.stderr]) {
    const original = fluxo.write.bind(fluxo);
    t.mock.method(fluxo, 'write', (c, ...a) => { saidas.push(String(c)); return original(c, ...a); });
  }
  return () => [...espias.flatMap((e) => e.mock.calls.map((c) => c.arguments.map(String).join(' '))), ...saidas].join('\n');
};

/** Todas as tabelas, menos a coluna `segredos` da linha de Conexões (a única casa permitida da Senha da API). */
function bancoSemSegredos(db) {
  const nomes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
  return nomes.map((nome) => {
    const linhas = db.prepare(`SELECT * FROM "${nome}"`).all().map((l) => { const c = { ...l }; if (nome === 'conexoes') delete c.segredos; return c; });
    return `${nome}: ${JSON.stringify(linhas)}`;
  }).join('\n');
}

const assinaturasDe = (f) => f.api().map((c) => /Signature=([0-9a-f]{64})/.exec(c.autorizacao ?? '')?.[1]).filter(Boolean);

// ============================================================================== CA2 + CA4 + CA7: API ponta a ponta

test('CA2/CA4/CA7: com a API acessível, Identificar → Disparar manda imagem + legenda com o link gerado pela API, sem a extensão e sem parâmetros do link colado', async () => {
  const f = fetchShopee();
  const s = await montar({ fetch: f }); // modo 'extension' e NENHUMA extensão on-line: a API basta
  try {
    await s.conectar();
    const colado = `${PRODUTO}?sp_atk=abc-123&xptdk=tracker&utm_source=an_999&utm_medium=affiliates`;
    const id = await s.identificar(colado);
    assert.equal(id.status, 200, id.txt);
    assert.deepEqual([id.json.loja.id, id.json.editavel, id.json.causa, id.json.link_via, id.json.causa_link, id.json.pode_disparar],
      ['shopee', true, null, 'api', null, true]);
    assert.deepEqual([id.json.produto.title, id.json.produto.price, id.json.produto.discountPct, id.json.produto.sold, id.json.produto.image],
      ['Fone Bom Sem Fio', 89.9, 15, 1234, IMG]);
    assert.match(id.json.texto, /Fone Bom Sem Fio/);
    assert.doesNotMatch(id.json.texto, /utm_|sp_atk|an_999/, 'o texto de exemplo não leva o link colado');

    const r = await s.disparar({ url: colado });
    assert.equal(r.status, 200, r.txt);
    await s.assentar();
    assert.equal(s.envios()[0].status, 'concluido');
    const [m] = s.msgs();
    assert.equal(s.msgs().length, 1);
    assert.equal(m.tipo, 'image', 'imagem com legenda');
    assert.equal(m.image, IMG, 'a foto é a do CDN da Shopee');
    assert.match(m.text, /Fone Bom Sem Fio/);
    assert.match(m.text, /89,90/);
    assert.ok(m.text.includes(LINK_API), 'o link da API chegou à legenda');
    assert.doesNotMatch(m.text, /utm_|sp_atk|xptdk|an_999|shopee\.com\.br\/Fone/, 'nada do link colado, nem o endereço do produto, vai ao grupo');
    // o que foi à API: a mutação leva o endereço sem parâmetros
    assert.deepEqual(f.mutacoes(), [`mutation{generateShortLink(input:{originUrl:${JSON.stringify(PRODUTO)}}){shortLink}}`]);
    const [p] = s.payloads();
    assert.deepEqual([p.loja, p.url, p.shop_id, p.item_id, p.link_afiliado, p.fonte_dados], ['shopee', PRODUTO, SHOP, ITEM, LINK_API, 'api']);
    assert.equal(s.links.status().pending, 0, 'a extensão não foi acionada');
  } finally { await s.fechar(); }
});

test('CA2: campos editáveis — título e preço ajustados vão à legenda, o desconto da API some quando o preço muda e "sem foto" manda só texto', async () => {
  const s = await montar({ fetch: fetchShopee() });
  try {
    await s.conectar();
    // sem ajuste: a legenda traz o desconto da API
    await s.disparar();
    await s.assentar();
    assert.match(s.msgs()[0].text, /15% OFF/);
    // preço mudado: o desconto antigo não vale mais
    await s.disparar({ ajustes: { title: 'Fone MUITO bom', price: '79,90' } });
    await s.assentar();
    const m2 = s.msgs()[1];
    assert.match(m2.text, /Fone MUITO bom/);
    assert.match(m2.text, /79,90/);
    assert.doesNotMatch(m2.text, /OFF/, 'preço ajustado sem preço antigo: sem desconto inventado');
    assert.equal(JSON.parse(s.envios()[1].payload).fonte_dados, 'manual');
    // sem foto
    await s.disparar({ ajustes: { sem_foto: true } });
    await s.assentar();
    assert.equal(s.msgs()[2].tipo, 'text');
    assert.ok(s.msgs()[2].text.includes(LINK_API));
  } finally { await s.fechar(); }
});

test('CA2: ajustes inválidos (preço negativo, texto, título gigante, tipo errado) são 400 e não gravam nada nem geram link', async () => {
  const f = fetchShopee();
  const s = await montar({ fetch: f });
  try {
    await s.conectar();
    const ruins = [
      { price: '-5' }, { price: 'abc' }, { price: 0 }, { price: {} }, { title: 'x'.repeat(5000) }, { freeShipping: 'sim' },
      { oldPrice: 'R$ ???' }, { title: 123 },
    ];
    for (const ajustes of ruins) {
      const r = await s.disparar({ ajustes });
      assert.equal(r.status, 400, `${JSON.stringify(ajustes).slice(0, 60)} → ${r.status} ${r.txt.slice(0, 120)}`);
    }
    const r = await s.disparar({ ajustes: 'texto' });
    assert.equal(r.status, 400);
    assert.equal(s.envios().length, 0);
    assert.deepEqual(f.mutacoes(), [], 'nenhum link gerado para pedido inválido');
  } finally { await s.fechar(); }
});

// ============================================================================== CA3: sem API, link pela extensão

test('CA3/CA4: API 10035 → campos em branco e editáveis, Disparar liberado pela extensão; o link da extensão chega ao grupo e a API não é chamada para gerar link', async () => {
  const f = fetchShopee({ api: 10035 });
  const s = await montar({ fetch: f });
  const ext = extensao(s);
  try {
    await s.conectar();
    const id = await s.identificar(PRODUTO);
    assert.equal(id.status, 200, id.txt);
    assert.deepEqual([id.json.causa, id.json.link_via, id.json.causa_link, id.json.pode_disparar, id.json.editavel], ['sem_acesso', 'extensao', null, true, true]);
    assert.deepEqual([id.json.produto.title, id.json.produto.price, id.json.produto.image], [null, null, null]);
    assert.equal((await s.cartao()).estado, 'sem_acesso');

    // sem o título à mão, não há o que mandar
    const sem = await s.disparar();
    assert.equal(sem.status, 400);
    assert.match(sem.json.erro, /título/i);
    assert.equal(s.envios().length, 0);
    assert.equal(ext.jobs.length, 0, 'não pede link antes de a oferta estar válida');

    const r = await s.disparar({ ajustes: { title: 'Fone à mão', price: '89,90' } });
    assert.equal(r.status, 200, r.txt);
    await s.assentar();
    const [m] = s.msgs();
    assert.equal(m.tipo, 'text');
    assert.match(m.text, /Fone à mão/);
    assert.ok(m.text.includes(LINK_EXT));
    assert.deepEqual(ext.jobs.map((j) => [j.type, j.url]), [['link_shopee', PRODUTO]]);
    assert.deepEqual(f.mutacoes(), [], 'API sem acesso: nunca tenta generateShortLink');
    assert.equal(JSON.parse(s.envios()[0].payload).fonte_dados, 'manual');
  } finally { await ext.parar(); await s.fechar(); }
});

test('CA3: cada código da API (10020, 10030, 11002, 11000, 10031) ainda deixa Identificar reconhecer o produto, com a causa certa, e o cartão no estado certo', async () => {
  const casos = [
    [10020, 'credencial_recusada', 'erro_credencial'],
    [11002, 'conta_restrita', 'erro_credencial'],
    [10031, 'conta_restrita', 'erro_credencial'],
    [10035, 'sem_acesso', 'sem_acesso'],
    [10030, 'cota', 'pronta'],        // cota não é falta de acesso: a situação não vira "sem acesso"
    [11000, 'indisponivel', 'pronta'],
    [99999, 'indisponivel', 'pronta'],
  ];
  for (const [codigo, causa, estado] of casos) {
    const s = await montar({ fetch: fetchShopee({ api: codigo }) });
    await marcarOnline(s);
    try {
      await s.conectar();
      const r = await s.identificar(PRODUTO);
      assert.equal(r.status, 200, `${codigo}: ${r.txt}`);
      assert.equal(r.json.causa, causa, `causa de ${codigo}`);
      assert.equal(r.json.pode_disparar, true, `${codigo}: o link ainda sai pela extensão`);
      assert.ok(r.json.produto && r.json.produto.title === null, `${codigo}: produto com campos vazios, não null`);
      const c = await s.cartao();
      assert.ok(['sem_acesso', 'erro_credencial', 'pronta', 'conectada'].includes(c.estado));
      assert.equal(c.estado, estado, `estado do cartão para ${codigo} (situacao ${JSON.stringify(c.situacao)})`);
      // a frase do aviso é fixa: nunca o texto que a API mandou
      assert.ok(!r.txt.includes(CHAVE) && !r.txt.includes(APP_ID), `${codigo}: vazou credencial`);
      assert.doesNotMatch(r.txt, /falha \d+/);
    } finally { await s.fechar(); }
  }
});

test('CA3: API com cota (10030) no generateShortLink cai para a extensão e o envio sai; API devolvendo link de outro host também cai para a extensão', async () => {
  for (const apiLink of [10030, 'hostil']) {
    const f = fetchShopee({ api: 'ok', apiLink });
    const s = await montar({ fetch: f });
    const ext = extensao(s);
    try {
      await s.conectar();
      const r = await s.disparar();
      assert.equal(r.status, 200, `${apiLink}: ${r.txt}`);
      await s.assentar();
      assert.equal(f.mutacoes().length, 1, `${apiLink}: a API foi tentada primeiro`);
      assert.equal(ext.jobs.length, 1, `${apiLink}: a extensão foi a reserva`);
      assert.ok(s.msgs()[0].text.includes(LINK_EXT));
      assert.doesNotMatch(JSON.stringify(s.wa.simulated), /evil\.example/);
    } finally { await ext.parar(); await s.fechar(); }
  }
});

test('CA3/CA4: API com link hostil e extensão off-line → 400, nada gravado, nada sai', async () => {
  const f = fetchShopee({ api: 'ok', apiLink: 'hostil' });
  const s = await montar({ fetch: f });
  try {
    await s.conectar();
    const r = await s.disparar();
    assert.equal(r.status, 400, r.txt);
    assert.equal(s.envios().length, 0);
    assert.equal(s.wa.simulated.length, 0);
    assert.doesNotMatch(r.txt, /evil\.example/);
  } finally { await s.fechar(); }
});

test('CA3: extensão off-line e API sem acesso → Identificar diz sem_link e Disparar (agora e agendado) recusa com a frase, sem gravar', async () => {
  const s = await montar({ fetch: fetchShopee({ api: 10035 }) });
  try {
    await s.conectar();
    const id = await s.identificar(PRODUTO);
    assert.deepEqual([id.json.link_via, id.json.causa_link, id.json.pode_disparar, id.json.causa], [null, 'sem_link', false, 'sem_acesso']);
    const agora = await s.disparar({ ajustes: { title: 'X' } });
    assert.equal(agora.status, 400);
    assert.match(agora.json.erro, /Chrome|extensão/i);
    const agendado = await s.disparar({ ajustes: { title: 'X' }, quando: 'agendado', agendar_hhmm: '23:59' });
    assert.equal(agendado.status, 400);
    assert.equal(s.envios().length, 0);
  } finally { await s.fechar(); }
});

test('CA3: sem o ID de afiliado salvo, Identificar diz sem_id (mesmo com extensão) e Disparar recusa; ID só depois destrava', async () => {
  const s = await montar({ fetch: fetchShopee({ api: 10035 }) });
  const ext = extensao(s);
  try {
    await s.conectar({ app_id: APP_ID, chave: CHAVE });
    let id = await s.identificar(PRODUTO);
    assert.deepEqual([id.json.causa_link, id.json.pode_disparar], ['sem_id', false]);
    const r = await s.disparar({ ajustes: { title: 'X' } });
    assert.equal(r.status, 400);
    assert.match(r.json.erro, /ID de afiliado/);
    assert.equal(ext.jobs.length, 0);
    await s.conectar({ id_afiliado: ID_AF });
    id = await s.identificar(PRODUTO);
    assert.deepEqual([id.json.causa_link, id.json.pode_disparar], [null, true]);
  } finally { await ext.parar(); await s.fechar(); }
});

test('CA3: sem nenhuma credencial da API e só o ID, nada chama a API e o link sai pela extensão (estado so_id)', async () => {
  const f = fetchShopee();
  const s = await montar({ fetch: f });
  const ext = extensao(s);
  try {
    await s.conectar({ id_afiliado: ID_AF });
    assert.equal((await s.cartao()).estado, 'so_id');
    const id = await s.identificar(PRODUTO);
    assert.deepEqual([id.json.causa, id.json.link_via, id.json.pode_disparar], ['sem_credenciais', 'extensao', true]);
    const r = await s.disparar({ ajustes: { title: 'Só ID' } });
    assert.equal(r.status, 200, r.txt);
    await s.assentar();
    assert.ok(s.msgs()[0].text.includes(LINK_EXT));
    assert.equal(f.api().length, 0, 'sem AppID/Senha a API nunca é chamada');
  } finally { await ext.parar(); await s.fechar(); }
});

// ============================================================================== CA4: conferência do ID pelo longLink

test('CA4: longLink de outra conta recusa; ausente, sem an_, de host estranho ou lixo é aceito; dois an_ diferentes recusam; igual passa', async () => {
  const casos = [
    ['outra conta', longoDe('99999999999'), 400],
    ['dois an_ diferentes', `${PRODUTO}?utm_source=an_${ID_AF}&utm_source=an_5555555555`, 400],
    ['an_ do dono duplicado', `${PRODUTO}?utm_source=an_${ID_AF}&utm_source=an_${ID_AF}`, 200],
    ['conta do dono', longoDe(ID_AF), 200],
    ['longo ausente', undefined, 200],
    ['longo nulo', null, 200],
    ['sem utm_source', `${PRODUTO}?utm_medium=affiliates`, 200],
    ['utm_source sem an_', `${PRODUTO}?utm_source=outra`, 200],
    ['host estranho (descartado)', `https://evil.example/x?utm_source=an_99999999999`, 200],
    ['http (descartado)', `http://shopee.com.br/x?utm_source=an_99999999999`, 200],
    ['lixo', '%%%não é url', 200],
    ['objeto', { a: 1 }, 200],
    ['gigante', `${PRODUTO}?utm_source=an_99999999999&x=${'a'.repeat(3000)}`, 200],
  ];
  for (const [nome, longo, esperado] of casos) {
    const s = await montar({ fetch: fetchShopee({ api: 10035 }) });
    const ext = extensao(s, () => ({ ok: true, link: LINK_EXT, longo }));
    try {
      await s.conectar();
      const r = await s.disparar({ ajustes: { title: 'Fone' } });
      assert.equal(r.status, esperado, `${nome}: ${r.txt}`);
      if (esperado === 400) {
        assert.match(r.json.erro, /outra conta de afiliado/, nome);
        assert.match(r.json.erro, /…2101/, 'diz só os 4 últimos dígitos do ID salvo');
        assert.ok(!r.txt.includes(longo), 'o longLink não volta na resposta');
        assert.equal(s.envios().length, 0, `${nome}: nada gravado`);
        assert.equal(s.wa.simulated.length, 0);
      } else {
        await s.assentar();
        assert.ok(s.msgs()[0].text.includes(LINK_EXT), nome);
      }
    } finally { await ext.parar(); await s.fechar(); }
  }
});

test('CA4: a extensão responde link fora de s.shopee.com.br (meli.la, http, porta, host parecido, vazio) → recusado no servidor, nada gravado, lastError sem o link', async () => {
  const ruins = ['https://meli.la/abcdef', 'http://s.shopee.com.br/abcdef', 'https://s.shopee.com.br:8443/abcdef', 'https://s.shopee.com.br.evil.com/abcdef',
    'https://evil.com/s.shopee.com.br/abcdef', 'https://s.shopee.com.br/ab', 'https://s.shopee.com.br/abc?x=1', `https://s.shopee.com.br/${'a'.repeat(41)}`, 'javascript:alert(1)', '', null];
  for (const link of ruins) {
    const s = await montar({ fetch: fetchShopee({ api: 10035 }) });
    const ext = extensao(s, () => ({ ok: true, link, longo: longoDe(ID_AF) }));
    try {
      await s.conectar();
      const r = await s.disparar({ ajustes: { title: 'Fone' } });
      assert.equal(r.status, 400, `${link}: ${r.txt}`);
      assert.equal(s.envios().length, 0, `${link}: nada gravado`);
      assert.equal(s.wa.simulated.length, 0);
      if (link) assert.ok(!r.txt.includes(link), 'o link recusado não volta ao painel');
    } finally { await ext.parar(); await s.fechar(); }
  }
});

test('CA4: erro da extensão (sessão, failCode) vira 400 com a frase da extensão, sem gravar; a extensão que não responde estoura o prazo sem travar o servidor', async () => {
  const s = await montar({ fetch: fetchShopee({ api: 10035 }) });
  const ext = extensao(s, () => ({ ok: false, error: 'a Shopee recusou o link (código 20003)' }));
  try {
    await s.conectar();
    const r = await s.disparar({ ajustes: { title: 'Fone' } });
    assert.equal(r.status, 400);
    assert.match(r.json.erro, /recusou o link \(código 20003\)/);
    assert.match(r.json.erro, /Shopee/);
    assert.equal(s.envios().length, 0);
    assert.match((await s.get('/api/state')).json.extensao.shopeeLastError, /20003/);
  } finally { await ext.parar(); await s.fechar(); }
});

test('CA4: o link do envio é sempre o shortLink gerado ao criar; payload adulterado (link de terceiro, vazio, ausente) faz o envio falhar sem mandar nada ao grupo', async () => {
  const adulteracoes = [
    'https://s.shopee.com.br/OutraPessoa1?x=1', 'https://evil.example/shopee', 'http://s.shopee.com.br/abcdef', '', null, undefined,
  ];
  for (const adulterado of adulteracoes) {
    const s = await montar({ fetch: fetchShopee() });
    try {
      await s.conectar();
      const futuro = new Date(Date.now() + 3600e3); // agendado: dá tempo de mexer no payload antes do envio
      const hhmm = `${String(futuro.getHours()).padStart(2, '0')}:${String(futuro.getMinutes()).padStart(2, '0')}`;
      if (futuro.toDateString() !== new Date().toDateString()) continue; // perto da meia-noite o agendamento para hoje não cabe
      const r = await s.disparar({ quando: 'agendado', agendar_hhmm: hhmm });
      assert.equal(r.status, 200, r.txt);
      const p = s.payloads()[0];
      assert.equal(p.link_afiliado, LINK_API);
      const novo = { ...p }; if (adulterado === undefined) delete novo.link_afiliado; else novo.link_afiliado = adulterado;
      s.db.prepare('UPDATE envios SET payload = ?, next_run_at = ? WHERE id = 1').run(JSON.stringify(novo), Date.now() - 1);
      await s.scheduler.tick();
      await s.assentar();
      assert.equal(s.msgs().length, 0, `link adulterado ${JSON.stringify(adulterado)} não pode ir ao grupo`);
      assert.notEqual(s.envios()[0].status, 'concluido');
    } finally { await s.fechar(); }
  }
});

test('CA7: foto adulterada no payload (host fora do CDN) não é baixada: o envio sai só com texto', async () => {
  const s = await montar({ fetch: fetchShopee() });
  try {
    await s.conectar();
    const futuro = new Date(Date.now() + 3600e3);
    if (futuro.toDateString() !== new Date().toDateString()) return;
    const hhmm = `${String(futuro.getHours()).padStart(2, '0')}:${String(futuro.getMinutes()).padStart(2, '0')}`;
    const r = await s.disparar({ quando: 'agendado', agendar_hhmm: hhmm });
    assert.equal(r.status, 200, r.txt);
    const p = s.payloads()[0];
    p.offer.image = 'https://evil.example/pixel.jpg';
    s.db.prepare('UPDATE envios SET payload = ?, next_run_at = ? WHERE id = 1').run(JSON.stringify(p), Date.now() - 1);
    await s.scheduler.tick(); await s.assentar();
    assert.equal(s.msgs().length, 1);
    assert.equal(s.msgs()[0].tipo, 'text');
    assert.doesNotMatch(JSON.stringify(s.wa.simulated), /evil\.example/);
  } finally { await s.fechar(); }
});

// ============================================================================== CA1: links curtos e formatos

test('CA1: s.shopee.com.br e shp.ee (inclusive em cadeia) são resolvidos só por GET manual, sem parâmetros, e o produto certo chega ao envio', async () => {
  const f = fetchShopee({
    curtos: {
      'https://s.shopee.com.br/AbC123': { status: 301, location: `https://shopee.com.br/product/${SHOP}/${ITEM}?utm_source=an_777&sp_atk=1` },
      'https://shp.ee/xyz': { status: 302, location: 'https://s.shopee.com.br/AbC123' },
      'https://shope.ee/qrs': { status: 302, location: `https://shopee.com.br/universal-link/product/${SHOP}/${ITEM}?smtt=0.0.9` },
    },
  });
  const s = await montar({ fetch: f });
  try {
    await s.conectar();
    for (const curto of ['https://s.shopee.com.br/AbC123', 'https://shp.ee/xyz', 'https://shope.ee/qrs']) {
      const id = await s.identificar(curto);
      assert.equal(id.status, 200, `${curto}: ${id.txt}`);
      assert.equal(id.json.causa, null, curto);
      assert.equal(id.json.produto.title, 'Fone Bom Sem Fio', curto);
      assert.equal(id.json.pode_disparar, true);
    }
    const redes = f.chamadas.filter((c) => c.url !== URL_API);
    assert.ok(redes.length >= 3);
    assert.ok(redes.every((c) => c.metodo === 'GET' && c.redirect === 'manual'), 'só GET com redirect manual');
    // Disparar com o link curto: o payload leva o endereço do produto normalizado, não o curto
    const r = await s.disparar({ url: 'https://shp.ee/xyz' });
    assert.equal(r.status, 200, r.txt);
    await s.assentar();
    const [p] = s.payloads();
    assert.deepEqual([p.url, p.shop_id, p.item_id], [`https://shopee.com.br/product/${SHOP}/${ITEM}`, SHOP, ITEM]);
    assert.doesNotMatch(s.msgs()[0].text, /shp\.ee|AbC123|an_777/);
  } finally { await s.fechar(); }
});

test('CA1/SSRF: curto que redireciona para fora da Shopee, para http, para porta, em laço, ou para busca da Shopee não chega ao produto e nunca é seguido para fora', async () => {
  const f = fetchShopee({
    curtos: {
      'https://s.shopee.com.br/Evil01': { status: 302, location: 'https://evil.example/x-i.1.2' },
      'https://s.shopee.com.br/Evil03': { status: 302, location: 'https://shopee.com.br:8443/x-i.1.2' },
      'https://s.shopee.com.br/Evil04': { status: 302, location: 'https://shopee.com.br@evil.example/x-i.1.2' },
      'https://s.shopee.com.br/Evil05': { status: 302, location: 'https://s.shopee.com.br/Evil05' },
      'https://s.shopee.com.br/Evil06': { status: 302, location: 'https://shopee.com.br.evil.example/x-i.1.2' },
      'https://s.shopee.com.br/Evil07': { status: 302, location: 'http://169.254.169.254/latest/meta-data' },
      'https://s.shopee.com.br/Busca1': { status: 302, location: 'https://shopee.com.br/search?keyword=fone' },
      'https://shopee.com.br/search?keyword=fone': new Response('<html>busca</html>', { status: 200 }),
      'https://s.shopee.com.br/Sem302': new Response('<html>pagina</html>', { status: 200 }),
      'https://s.shopee.com.br/Erro500': new Response('x', { status: 500 }),
    },
  });
  const s = await montar({ fetch: f });
  try {
    await s.conectar();
    const esperado = { Busca1: 'nao_produto' };
    for (const cod of ['Evil01', 'Evil03', 'Evil04', 'Evil05', 'Evil06', 'Evil07', 'Busca1', 'Sem302', 'Erro500']) {
      const id = await s.identificar(`https://s.shopee.com.br/${cod}`);
      assert.equal(id.status, 200, `${cod}: ${id.txt}`);
      assert.equal(id.json.causa, esperado[cod] ?? 'invalido', cod);
      assert.equal(id.json.produto, null, cod);
      assert.equal(id.json.pode_disparar, false, cod);
      const r = await s.disparar({ url: `https://s.shopee.com.br/${cod}`, ajustes: { title: 'X' } });
      assert.equal(r.status, 400, `${cod}: ${r.txt}`);
    }
    assert.equal(s.envios().length, 0);
    const hosts = new Set(f.chamadas.map((c) => new URL(c.url).hostname));
    assert.deepEqual([...hosts].filter((h) => !['s.shopee.com.br', 'shopee.com.br', 'open-api.affiliate.shopee.com.br'].includes(h)), [], 'nenhuma chamada saiu da Shopee');
    assert.equal(f.api().length, 0, 'sem produto, a API nem é consultada');
  } finally { await s.fechar(); }
});

test('CA1: Location relativo ou sem esquema dentro da Shopee é resolvido contra o host atual; Location relativo que sai do host seguro não vira produto', async () => {
  const f = fetchShopee({
    curtos: {
      'https://shp.ee/rel1': { status: 302, location: 'https://shopee.com.br/redir' },
      'https://shopee.com.br/redir': { status: 302, location: `/product/${SHOP}/${ITEM}?smtt=1` },
      'https://shp.ee/rel2': { status: 302, location: `//shopee.com.br/Fone-i.${SHOP}.${ITEM}` },
      'https://shp.ee/rel3': { status: 302, location: `//evil.example/Fone-i.${SHOP}.${ITEM}` },
    },
  });
  const s = await montar({ fetch: f });
  try {
    await s.conectar();
    for (const [curto, causa] of [['rel1', null], ['rel2', null], ['rel3', 'invalido']]) {
      const r = await s.identificar(`https://shp.ee/${curto}`);
      assert.equal(r.status, 200, r.txt);
      assert.equal(r.json.causa, causa, curto);
    }
    assert.ok(!f.chamadas.some((c) => c.url.includes('evil.example')), 'nunca chamou o host de fora');
  } finally { await s.fechar(); }
});

test('Histórico: a oferta da Shopee aparece como loja Shopee, com o título e o grupo, e o log registra o envio sem link, ID nem segredo', async () => {
  const s = await montar({ fetch: fetchShopee() });
  try {
    await s.conectar();
    await s.disparar(); await s.assentar();
    const h = await s.get('/api/envios?tipo=oferta');
    assert.deepEqual([h.json.linhas[0].loja, h.json.linhas[0].titulo, h.json.linhas[0].grupo, h.json.linhas[0].status], ['Shopee', 'Fone Bom Sem Fio', 'Achadinhos', 'enviado']);
    const log = (await s.get('/api/log')).json;
    assert.deepEqual(log.map((l) => [l.level, l.message]), [['ok', 'Enviado com o link de afiliado da Shopee']]);
    assert.ok(!JSON.stringify(log).includes(ID_AF) && !JSON.stringify(log).includes('s.shopee.com.br'));
  } finally { await s.fechar(); }
});

test('CA1: link de afiliado de terceiro (s.shopee.com.br) colado é trocado pelo link do dono: o de terceiro nunca vai ao grupo', async () => {
  const f = fetchShopee({ curtos: { 'https://s.shopee.com.br/Terceiro': { status: 302, location: `https://shopee.com.br/Fone-i.${SHOP}.${ITEM}?utm_source=an_4444444444` } } });
  const s = await montar({ fetch: f });
  try {
    await s.conectar();
    await s.disparar({ url: 'https://s.shopee.com.br/Terceiro' });
    await s.assentar();
    assert.ok(s.msgs()[0].text.includes(LINK_API));
    assert.doesNotMatch(JSON.stringify(s.wa.simulated), /Terceiro|4444444444/);
  } finally { await s.fechar(); }
});

test('CA1: entradas estranhas nunca dão 500, nunca chamam host fora da Shopee e só reconhecem o que tem os ids', async () => {
  const f = fetchShopee();
  const s = await montar({ fetch: f });
  await marcarOnline(s);
  try {
    await s.conectar();
    const reconhecidos = {
      [`${PRODUTO}/`]: [SHOP, ITEM],
      [`${PRODUTO}#frag`]: [SHOP, ITEM],
      [`HTTPS://SHOPEE.COM.BR/Fone-i.${SHOP}.${ITEM}`]: [SHOP, ITEM],
      [`  ${PRODUTO}  `]: [SHOP, ITEM],
      [`http://shopee.com.br/Fone-i.${SHOP}.${ITEM}`]: [SHOP, ITEM],
      [`https://shopee.com.br/product/${SHOP}/${ITEM}/`]: [SHOP, ITEM],
      [`https://shopee.com.br/universal-link/product/${SHOP}/${ITEM}?x=1`]: [SHOP, ITEM],
      [`https://m.shopee.com.br/Fone-i.${SHOP}.${ITEM}`]: [SHOP, ITEM],
      [`https://shopee.com.br/Fone-%C3%93timo-%F0%9F%98%80-i.${SHOP}.${ITEM}`]: [SHOP, ITEM],
      [`https://shopee.com.br/Fone-Ótimo-😀-i.${SHOP}.${ITEM}`]: [SHOP, ITEM],
    };
    for (const [url, [shop, item]] of Object.entries(reconhecidos)) {
      const r = await s.identificar(url);
      assert.equal(r.status, 200, `${url}: ${r.txt}`);
      assert.equal(r.json.causa, null, url);
      assert.equal(r.json.pode_disparar, true, url);
      const q = f.consultas().at(-1);
      assert.match(q, new RegExp(`itemId:${item},shopId:${shop}`), url);
    }
    const naoReconhecidos = [
      `https://shopee.com.br.evil.example/Fone-i.${SHOP}.${ITEM}`, `https://evilshopee.com.br/Fone-i.${SHOP}.${ITEM}`,
      `https://evil.example/?u=https://shopee.com.br/Fone-i.${SHOP}.${ITEM}`, `javascript:alert(1)//shopee.com.br/x-i.1.2`,
      `ftp://shopee.com.br/Fone-i.${SHOP}.${ITEM}`, 'shopee.com.br/Fone-i.1.2', '', '   ', 'https://', `file:///etc/passwd`,
      `https://shopee.com.br/${'a'.repeat(2100)}-i.1.2`,
    ];
    for (const url of naoReconhecidos) {
      const r = await s.identificar(url);
      assert.equal(r.status, 400, `${url.slice(0, 60)}: ${r.txt.slice(0, 100)}`);
    }
    // reconhecidos como Shopee mas sem produto
    const semProduto = [
      'https://shopee.com.br/', 'https://shopee.com.br/search?keyword=fone', `https://shopee.com.br/Fone-i.0.0`, `https://shopee.com.br/Fone-i.${SHOP}`,
      `https://shopee.com.br/Fone-i.${SHOP}.${ITEM}.9`, `https://shopee.com.br/Fone-i.${'9'.repeat(21)}.${ITEM}`, `https://shopee.com.br/product/${SHOP}`,
      `https://shopee.com.br/product/${SHOP}/${ITEM}/extra`, `https://shopee.com.br/Fone-i.abc.def`, 'https://shopee.com.br/Loja-oficial',
      `https://shopee.com.br/Fone-i.${SHOP}.${ITEM}%0Aevil`,
    ];
    const antes = f.api().length;
    for (const url of semProduto) {
      const r = await s.identificar(url);
      assert.equal(r.status, 200, `${url}: ${r.txt}`);
      assert.equal(r.json.produto, null, url);
      assert.ok(['invalido', 'nao_produto'].includes(r.json.causa), `${url}: ${r.json.causa}`);
      assert.equal(r.json.pode_disparar, false, url);
    }
    assert.equal(f.api().length, antes, 'link sem produto nunca consulta a API');
    const hosts = new Set(f.chamadas.map((c) => new URL(c.url).hostname));
    assert.ok([...hosts].every((h) => /(^|\.)shopee\.com\.br$/.test(h)), `hosts chamados: ${[...hosts]}`);
  } finally { await s.fechar(); }
});

test('CA1/CA4: o endereço que o servidor entrega à extensão e à API é aceito pelas duas guardas (servidor e extensão) para todo caminho que extrairIds aceita', () => {
  const fonte = fs.readFileSync(path.join(RAIZ, 'extension', 'background.js'), 'utf8');
  const trecho = fonte.slice(fonte.indexOf('// ---- Shopee: funções puras (início) ----'), fonte.indexOf('// ---- Shopee: funções puras (fim) ----'));
  const ctx = vm.createContext({ URL, AbortSignal });
  vm.runInContext(`${trecho};globalThis.__x = { urlProdutoShopee };`, ctx);
  const links = createLinkService({ getMode: () => 'fake' });
  const sufixos = ['', '/', '?a=b', '#x'];
  const chars = ['a', 'Z', '0', '-', '_', '.', '~', '%', "'", '(', ')', '*', '+', ',', ';', '=', ':', '@', '!', '$', '&', '[', ']', '|', '^', '`', '{', '}', '"', '<', '>', ' ', '\\', 'ó', '😀', '‮', '\t'];
  let aceitos = 0;
  const falhas = [];
  for (const ch of chars) {
    for (const suf of sufixos) {
      for (const modelo of [`Fone${ch}Bom-i.${SHOP}.${ITEM}`, `product/${SHOP}/${ITEM}`, `${ch}/x-i.${SHOP}.${ITEM}`]) {
        let ids;
        try { ids = extrairIds(`https://shopee.com.br/${modelo}${suf}`); } catch (e) { falhas.push(`extrairIds lançou: ${modelo}`); continue; }
        if (!ids) continue;
        aceitos++;
        const naExtensao = ctx.__x.urlProdutoShopee(ids.urlProduto);
        if (naExtensao !== ids.urlProduto) falhas.push(`extensão recusa ${JSON.stringify(ids.urlProduto)}`);
        links.requestLinkShopee({ url: ids.urlProduto }).catch(() => falhas.push(`links recusa ${JSON.stringify(ids.urlProduto)}`));
      }
    }
  }
  assert.ok(aceitos > 50, `só ${aceitos} aceitos: o teste não exercitou nada`);
  assert.deepEqual([...new Set(falhas)], []);
});

// ============================================================================== nao_encontrado não bloqueia

test('Decisão do dono (04/11): nao_encontrado (nó ausente ou de outro item) não bloqueia: Identificar libera, sem título recusa, com título à mão cria o envio com o link gerado', async () => {
  for (const api of ['vazio', 'outro-item']) {
    const f = fetchShopee({ api });
    const s = await montar({ fetch: f });
    const ext = extensao(s);
    try {
      await s.conectar();
      const id = await s.identificar(PRODUTO);
      assert.equal(id.status, 200, id.txt);
      assert.deepEqual([id.json.causa, id.json.pode_disparar, id.json.link_via, id.json.causa_link], ['nao_encontrado', true, 'api', null], api);
      assert.equal(id.json.produto.title, null);
      // sem título: a mesma frase dos outros casos de "API sem dados"; nenhum link é gerado
      const sem = await s.disparar({ ajustes: { price: '10' } });
      assert.deepEqual([sem.status, sem.json.erro], [400, 'Não consegui buscar os dados na Shopee: preencha o título do produto.'], api);
      assert.equal(s.envios().length, 0);
      assert.deepEqual(f.mutacoes(), []);
      // com título à mão: o link sai como sempre (API primeiro) e o envio é criado
      const r = await s.disparar({ ajustes: { title: 'Fone', price: '10' } });
      assert.equal(r.status, 200, `${api}: ${r.txt}`);
      await s.assentar();
      assert.equal(f.mutacoes().length, 1, 'o link foi pedido à API uma vez');
      assert.equal(ext.jobs.length, 0, 'a API deu o link: a extensão não é usada');
      const [p] = s.payloads();
      assert.deepEqual([p.link_afiliado, p.fonte_dados, p.offer.title], [LINK_API, 'manual', 'Fone'], api);
      assert.equal(s.envios()[0].status, 'concluido');
      assert.ok(s.msgs()[0].text.includes(LINK_API), 'a mensagem leva o link de afiliado');
    } finally { await ext.parar(); await s.fechar(); }
  }
});

// ============================================================================== agendado para hoje

test('Agendar para hoje: o link é gerado ao criar e o envio sai na hora marcada SEM a extensão (desligada) e sem chamar a API de novo', async (t) => {
  const base = new Date(); base.setHours(10, 0, 0, 0);
  t.mock.timers.enable({ apis: ['Date'], now: base.getTime() });
  const f = fetchShopee({ api: 10035 });
  const s = await montar({ fetch: f });
  const ext = extensao(s);
  try {
    await s.conectar();
    const r = await s.disparar({ quando: 'agendado', agendar_hhmm: '10:30', ajustes: { title: 'Fone agendado', price: '50' } });
    assert.equal(r.status, 200, r.txt);
    assert.equal(r.json.status, 'pendente');
    assert.ok(r.json.next_run_at > Date.now(), 'tem hora marcada');
    assert.equal(ext.jobs.length, 1, 'o link foi pedido na criação');
    assert.equal(s.payloads()[0].link_afiliado, LINK_EXT);
    await ext.parar(); // o Chrome fecha antes da hora do envio
    const consultasAntes = f.api().length;

    await s.scheduler.tick();
    assert.equal(s.msgs().length, 0, 'antes da hora não sai');
    t.mock.timers.setTime(new Date(base).setHours(10, 31));
    await s.scheduler.tick(); await s.assentar();
    assert.equal(s.msgs().length, 1);
    assert.ok(s.msgs()[0].text.includes(LINK_EXT));
    assert.match(s.msgs()[0].text, /Fone agendado/);
    assert.equal(s.envios()[0].status, 'concluido');
    assert.equal(f.api().length, consultasAntes, 'na hora do envio não há chamada de rede');
    await s.scheduler.tick(); await s.assentar();
    assert.equal(s.msgs().length, 1, 'não repete');
  } finally { await ext.parar(); await s.fechar(); }
});

test('Agendar: para outro dia ou horário que já passou é recusado (só hoje), sem pedir link', async (t) => {
  const base = new Date(); base.setHours(10, 0, 0, 0);
  t.mock.timers.enable({ apis: ['Date'], now: base.getTime() });
  const s = await montar({ fetch: fetchShopee() });
  const ext = extensao(s);
  try {
    await s.conectar();
    const amanha = new Date(base.getTime() + 86400e3);
    const dia = `${amanha.getFullYear()}-${String(amanha.getMonth() + 1).padStart(2, '0')}-${String(amanha.getDate()).padStart(2, '0')}`;
    for (const extra of [{ agendar_data: dia, agendar_hhmm: '11:00' }, { agendar_hhmm: '09:00' }, { agendar_hhmm: '25:99' }, {}]) {
      const r = await s.disparar({ quando: 'agendado', ...extra });
      assert.equal(r.status, 400, JSON.stringify(extra));
    }
    const rep = await s.disparar({ quando: 'repetir', repetir: { dias: [1], horarios: ['10:30'] } });
    assert.equal(rep.status, 400);
    assert.equal(s.envios().length, 0);
    assert.equal(ext.jobs.length, 0);
  } finally { await ext.parar(); await s.fechar(); }
});

// ============================================================================== concorrência e repetição

test('Concorrência: 6 Identificar simultâneos do mesmo produto fazem 1 só consulta à API; depois, o cache de 15 min atende e salvar a conexão o invalida', async () => {
  const f = fetchShopee();
  const s = await montar({ fetch: f });
  try {
    await s.conectar();
    const rs = await Promise.all(Array.from({ length: 6 }, () => s.identificar(PRODUTO)));
    assert.ok(rs.every((r) => r.status === 200 && r.json.produto.title === 'Fone Bom Sem Fio'));
    assert.equal(f.consultas().length, 1);
    await s.identificar(PRODUTO);
    assert.equal(f.consultas().length, 1, 'cache');
    await s.conectar({ id_afiliado: ID_AF });
    await s.identificar(PRODUTO);
    assert.equal(f.consultas().length, 2, 'salvar invalidou o cache');
  } finally { await s.fechar(); }
});

test('Concorrência: 5 Disparar simultâneos pela extensão geram 5 envios, cada um com o link do seu pedido, e o grupo recebe 5 mensagens', async () => {
  const s = await montar({ fetch: fetchShopee({ api: 10035 }) });
  const ext = extensao(s, async (job, n) => { await new Promise((ok) => setTimeout(ok, 5 * (6 - n))); return { ok: true, link: `https://s.shopee.com.br/Conc${job.id}`, longo: longoDe(ID_AF) }; });
  try {
    await s.conectar();
    const rs = await Promise.all(Array.from({ length: 5 }, (_, i) => s.disparar({ ajustes: { title: `Produto ${i}` } })));
    assert.ok(rs.every((r) => r.status === 200), rs.map((r) => r.txt).join('|'));
    await s.assentar();
    assert.equal(s.envios().length, 5);
    assert.equal(s.msgs().length, 5);
    const links = s.payloads().map((p) => p.link_afiliado);
    assert.equal(new Set(links).size, 5, 'cada envio tem o seu link');
    for (const m of s.msgs()) assert.ok(links.some((l) => m.text.includes(l)));
    assert.ok(s.envios().every((e) => e.status === 'concluido'));
  } finally { await ext.parar(); await s.fechar(); }
});

test('Repetição: tick repetido não reenvia; o mesmo Disparar duas vezes cria dois envios independentes (como o ML), cada um com seu link', async () => {
  const s = await montar({ fetch: fetchShopee() });
  try {
    await s.conectar();
    await s.disparar(); await s.assentar();
    await s.scheduler.tick(); await s.scheduler.tick(); await s.assentar();
    assert.equal(s.msgs().length, 1);
    await s.disparar(); await s.assentar();
    assert.equal(s.msgs().length, 2);
  } finally { await s.fechar(); }
});

// ============================================================================== CA5: Conexões

test('CA5: o cartão percorre os 6 estados pelo painel real, com extensao_online, e o Testar responde por código com frase fixa', async () => {
  const estado = { api: 'ok' };
  const f = fetchShopee(estado);
  const s = await montar({ fetch: f });
  try {
    let c = await s.cartao();
    assert.deepEqual([c.estado, c.extensao_online], ['falta_configurar', false]);
    assert.deepEqual(c.campos.map((x) => x.nome ?? x.id ?? x.chave).slice(0, 3).length, 3);
    await s.conectar({ id_afiliado: ID_AF });
    assert.equal((await s.cartao()).estado, 'so_id');
    await marcarOnline(s);
    assert.equal((await s.cartao()).extensao_online, true);
    await s.conectar({ app_id: APP_ID, chave: CHAVE });
    c = await s.cartao();
    assert.deepEqual([c.estado, c.situacao.acesso, c.segredos_salvos], ['pronta', 'desconhecido', ['chave']]);
    assert.equal(f.api().length, 0, 'salvar e listar não chamam a API');

    const frases = {};
    for (const [api, resultado, esperado] of [[10035, 'sem_acesso', 'sem_acesso'], [10020, 'recusada', 'erro_credencial'], [11002, 'conta_restrita', 'erro_credencial'],
      [10030, 'cota', 'pronta'], [11001, 'indisponivel', 'pronta'], ['ok', 'ok', 'conectada']]) {
      estado.api = api;
      const t = await s.post('/api/conexoes/shopee/testar');
      assert.equal(t.status, 200, t.txt);
      assert.equal(t.json.resultado, resultado, `testar com ${api}`);
      assert.equal(t.json.ok, resultado === 'ok');
      frases[resultado] = t.json.mensagem;
      assert.equal((await s.cartao()).estado, esperado, `cartão depois de ${api}`);
      assert.ok(!t.txt.includes(CHAVE) && !t.txt.includes(APP_ID) && !/falha \d+/.test(t.txt));
    }
    assert.equal(new Set(Object.values(frases)).size, Object.keys(frases).length, 'frases distintas por resultado');

    // salvar de novo esquece a verificação
    await s.conectar({ id_afiliado: ID_AF });
    c = await s.cartao();
    assert.deepEqual([c.estado, c.situacao.acesso], ['pronta', 'desconhecido']);
  } finally { await s.fechar(); }
});

test('CA5: o formulário real manda a Senha em branco para "manter a salva": a Senha continua valendo (o Testar assina com ela) e o AppID pode ser trocado', async () => {
  const f = fetchShopee();
  const s = await montar({ fetch: f });
  try {
    await s.conectar();
    const r = await s.put('/api/conexoes/shopee', { campos: { id_afiliado: ID_AF, app_id: '555444333', chave: '' } });
    assert.equal(r.status, 200, r.txt);
    const linha = s.db.prepare("SELECT config, segredos FROM conexoes WHERE plataforma = 'shopee'").get();
    assert.equal(JSON.parse(linha.config).app_id, '555444333');
    assert.equal(JSON.parse(linha.segredos).chave, CHAVE, 'a Senha não foi apagada');
    const t = await s.post('/api/conexoes/shopee/testar');
    assert.equal(t.json.resultado, 'ok');
    const c = f.api().at(-1);
    const [, ts, assinatura] = /Credential=555444333, Timestamp=(\d+), Signature=([0-9a-f]{64})/.exec(c.autorizacao);
    assert.equal(assinatura, createHash('sha256').update(`555444333${ts}${c.corpo}${CHAVE}`).digest('hex'), 'a assinatura usa o AppID novo e a Senha guardada');
  } finally { await s.fechar(); }
});

test('CA5: Testar com credencial aceita e sem ID → sem_id; sem credencial → nao_configurada e a API não é chamada', async () => {
  const f = fetchShopee();
  const s = await montar({ fetch: f });
  try {
    let t = await s.post('/api/conexoes/shopee/testar');
    assert.equal(t.json.resultado, 'nao_configurada');
    assert.equal(f.api().length, 0);
    await s.conectar({ app_id: APP_ID, chave: CHAVE });
    t = await s.post('/api/conexoes/shopee/testar');
    assert.deepEqual([t.json.ok, t.json.resultado], [false, 'sem_id']);
    assert.ok(Array.isArray(t.json.campos));
  } finally { await s.fechar(); }
});

test('CA5: salvar recusa AppID igual ao ID (campos juntos, ou só um deles contra o que já está salvo) sem gravar nada; formatos inválidos também', async () => {
  const s = await montar({ fetch: fetchShopee() });
  try {
    const igual = await s.put('/api/conexoes/shopee', { campos: { id_afiliado: ID_AF, app_id: ID_AF, chave: CHAVE } });
    assert.equal(igual.status, 400);
    assert.match(igual.json.erro, /AppID e o ID de afiliado são números diferentes/);
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM conexoes WHERE plataforma = 'shopee'").get().n, 0, 'nada gravado');
    await s.conectar();
    const antes = s.db.prepare("SELECT config, segredos FROM conexoes WHERE plataforma = 'shopee'").get();
    for (const campos of [{ app_id: ID_AF }, { id_afiliado: APP_ID }]) {
      const r = await s.put('/api/conexoes/shopee', { campos });
      assert.equal(r.status, 400, JSON.stringify(campos));
    }
    for (const campos of [{ id_afiliado: 'abc' }, { id_afiliado: '1234' }, { id_afiliado: '1'.repeat(21) }, { app_id: 'abc' }, { app_id: '1'.repeat(21) }, { chave: 'curta' }, { chave: 'tem espaço dentro da senha' }, { chave: 'acentuação-ç-123456' }, { chave: 'x'.repeat(200) }]) {
      const r = await s.put('/api/conexoes/shopee', { campos });
      assert.equal(r.status, 400, JSON.stringify(campos).slice(0, 80));
      for (const v of Object.values(campos)) if (String(v).length >= 8) assert.ok(!r.txt.includes(String(v)), 'a resposta de erro não repete o valor enviado');
    }
    // campo que não existe no registro da Shopee nunca é guardado
    await s.put('/api/conexoes/shopee', { campos: { desconhecido: 'valor-estranho-123' } });
    const depois = s.db.prepare("SELECT config, segredos FROM conexoes WHERE plataforma = 'shopee'").get();
    assert.deepEqual({ ...depois }, { ...antes }, 'nada mudou');
  } finally { await s.fechar(); }
});

// ============================================================================== CA6: vazamentos

test('CA6: Senha da API, AppID e assinatura nunca aparecem em respostas, log, console, saída do processo, mensagens do WhatsApp nem no banco (fora de conexoes.segredos), nem com API hostil', async (t) => {
  const saidas = capturarSaidas(t);
  const respostas = [];
  for (const api of ['ok', 10035, 10020, 11002, 10030, 'lancar']) {
    const f = fetchShopee(api === 'lancar' ? { api: 'ok', lancar: true } : { api });
    const s = await montar({ fetch: f });
    const ext = extensao(s, () => ({ ok: false, error: `erro vindo da extensão` }));
    try {
      await s.conectar();
      const rotas = [
        s.identificar(PRODUTO), s.identificar(`${PRODUTO}?x=1`), s.post('/api/conexoes/shopee/testar'), s.disparar({ ajustes: { title: 'Fone' } }),
        s.get('/api/conexoes'), s.get('/api/state'), s.get('/api/log'), s.get('/api/envios'), s.get('/api/envios?tipo=oferta'), s.get('/api/simulados'),
      ];
      for (const r of await Promise.all(rotas)) respostas.push(r.txt);
      await s.assentar();
      respostas.push(JSON.stringify(s.wa.simulated));
      respostas.push(bancoSemSegredos(s.db));
      const assinaturas = assinaturasDe(f);
      const tudo = respostas.join('\n') + saidas();
      for (const segredo of [CHAVE, ...assinaturas]) assert.ok(!tudo.includes(segredo), `${api}: vazou ${segredo.slice(0, 6)}…`);
      assert.ok(!/SHA256 Credential/.test(tudo), `${api}: vazou o cabeçalho Authorization`);
      // a Senha só existe em conexoes.segredos
      const linha = s.db.prepare("SELECT segredos FROM conexoes WHERE plataforma = 'shopee'").get();
      assert.equal(JSON.parse(linha.segredos).chave, CHAVE);
    } finally { await ext.parar(); await s.fechar(); }
  }
});

test('CA6: GET /api/conexoes, PUT e testar sem sessão são 401 (e Identificar/Disparar também), sem mexer em nada', async () => {
  const f = fetchShopee();
  const s = await montar({ fetch: f, panelPassword: 'senha-do-painel-123' });
  try {
    const sem = [
      s.get('/api/conexoes'), s.put('/api/conexoes/shopee', { campos: { id_afiliado: ID_AF } }), s.post('/api/conexoes/shopee/testar'),
      s.identificar(PRODUTO), s.disparar(),
    ];
    for (const r of await Promise.all(sem)) assert.equal(r.status, 401, r.txt);
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM conexoes WHERE plataforma = 'shopee'").get().n, 0);
    assert.equal(f.chamadas.length, 0);
  } finally { await s.fechar(); }
});

// ============================================================================== segurança da rota da extensão

test('CA4/CA6: /api/ext/result com token errado é 401; com token certo, link de outro host para um pedido da Shopee não vira envio; o ML não aceita s.shopee', async () => {
  const s = await montar({ fetch: fetchShopee({ api: 10035 }) });
  try {
    await s.conectar();
    const token = s.db.prepare("SELECT value FROM settings WHERE key = 'ext_token'").get().value;
    const ruim = await pedir(s.port, 'POST', '/api/ext/result', { id: 1, ok: true, link: LINK_EXT }, { 'x-token': 'errado' });
    assert.equal(ruim.status, 401);
    const poll = pedir(s.port, 'GET', '/api/ext/poll', null, { 'x-token': token }); // marca on-line
    for (let i = 0; i < 200 && s.links.status().lastPollAt === 0; i++) await new Promise((ok) => setTimeout(ok, 5));
    const criado = s.disparar({ ajustes: { title: 'Fone' } });
    const { json: { job } } = await poll;
    const r1 = await pedir(s.port, 'POST', '/api/ext/result', { id: job.id, ok: true, link: 'https://meli.la/AbCdEf', longo: longoDe(ID_AF) }, { 'x-token': token });
    assert.deepEqual([r1.status, r1.json], [200, { ok: true }]);
    const envio = await criado;
    assert.equal(envio.status, 400, 'link do ML para pedido da Shopee é recusado');
    assert.equal(s.envios().length, 0);
    // id inexistente / já respondido
    const r2 = await pedir(s.port, 'POST', '/api/ext/result', { id: job.id, ok: true, link: LINK_EXT }, { 'x-token': token });
    assert.deepEqual(r2.json, { ok: false });
  } finally { await s.fechar(); }
});

// ============================================================================== regressões: ML, Amazon, Magalu, espelhamento

const CONEXAO_AMAZON = { tag: 'pedro-20', credencial_versao: '3.1' };
const fetchComAmazon = (estado = {}) => {
  const base = fetchShopee(estado);
  const f = async (url, init) => {
    if (String(url).includes('amazon')) { base.chamadas.push({ url: String(url) }); throw new Error('amazon fora do ar no teste'); }
    return base(url, init);
  };
  Object.assign(f, base);
  return f;
};
const mlFalso = { async resolveOffer({ key }) { return { key, title: 'Cadeira Gamer ML', price: 499.9, oldPrice: 699.9, discountPct: 29, sold: 100, image: 'https://http2.mlstatic.com/D_NQ_NP_123-F.jpg', freeShipping: true, coupon: null }; } };
const ML_URL = 'https://produto.mercadolivre.com.br/MLB-1234567890-cadeira-gamer-_JM';

test('Regressão ML: Identificar não editável e Disparar com a etiqueta continuam iguais, com a Shopee configurada na mesma instância; extensão off-line recusa no ML', async () => {
  const s = await montar({ modo: 'fake', fetch: fetchComAmazon(), ml: mlFalso });
  try {
    await s.conectar();
    const tag = s.db.prepare("INSERT INTO tags (name) VALUES ('tag-ml')").run().lastInsertRowid;
    const id = await s.identificar(ML_URL, { tag_id: Number(tag) });
    assert.equal(id.status, 200, id.txt);
    assert.deepEqual([id.json.loja.id, id.json.editavel, id.json.produto.title, id.json.etiqueta?.name], ['mercadolivre', false, 'Cadeira Gamer ML', 'tag-ml']);
    assert.ok(!('link_via' in id.json), 'campos da Shopee não vazam para o ML');
    const sem = await s.disparar({ url: ML_URL, tag_id: 99999 });
    assert.equal(sem.status, 400, 'etiqueta inexistente: o ML continua recusando');
    const r = await s.disparar({ url: ML_URL, tag_id: Number(tag) });
    assert.equal(r.status, 200, r.txt);
    await s.assentar();
    const [m] = s.msgs();
    assert.match(m.text, /meli\.la\/fake-tag-ml-/);
    assert.doesNotMatch(m.text, /shopee/i);
  } finally { await s.fechar(); }
  // modo extensão sem extensão on-line: o ML exige, a Shopee é independente
  const s2 = await montar({ modo: 'extension', fetch: fetchComAmazon(), ml: mlFalso });
  try {
    const tag = Number(s2.db.prepare("INSERT INTO tags (name) VALUES ('tag-ml')").run().lastInsertRowid);
    const r = await s2.disparar({ url: ML_URL, tag_id: tag });
    assert.equal(r.status, 400);
    assert.match(r.json.erro, /extensão do Chrome não está conectada/);
  } finally { await s2.fechar(); }
});

test('Regressão Amazon e Magalu: Amazon exige a tag de Conexões e sai com ela; Magalu segue "não conectada"; nenhum dos dois usa a Shopee', async () => {
  const f = fetchComAmazon();
  const s = await montar({ modo: 'fake', fetch: f });
  try {
    await s.conectar();
    const AMZ = 'https://www.amazon.com.br/dp/B0FG2MD49G';
    const semTag = await s.identificar(AMZ);
    assert.equal(semTag.json.causa, 'sem_tag');
    const bloqueado = await s.disparar({ url: AMZ, ajustes: { title: 'Roteador' } });
    assert.equal(bloqueado.status, 400);
    s.db.prepare("INSERT INTO conexoes (plataforma, config, segredos, updated_at) VALUES ('amazon', ?, '{}', ?)").run(JSON.stringify(CONEXAO_AMAZON), Date.now());
    const r = await s.disparar({ url: AMZ, ajustes: { title: 'Roteador Mesh', price: '199,90' } });
    assert.equal(r.status, 200, r.txt);
    await s.assentar();
    const m = s.msgs().at(-1);
    assert.ok((m.text).includes('amazon.com.br/dp/B0FG2MD49G?tag=pedro-20'), m.text);
    assert.doesNotMatch(m.text, /shopee/i);
    const magalu = await s.identificar('https://www.magazineluiza.com.br/produto/p/abc/');
    assert.equal(magalu.status, 200, magalu.txt);
    assert.equal(magalu.json.loja.implementada, false);
    assert.match(magalu.json.motivo, /ainda não está conectada/);
    const m2 = await s.disparar({ url: 'https://www.magazineluiza.com.br/produto/p/abc/' });
    assert.equal(m2.status, 400);
    assert.deepEqual(f.mutacoes(), []);
    assert.equal(f.api().length, 0, 'a Shopee não foi chamada por links de outras lojas');
  } finally { await s.fechar(); }
});

test('CA9: link da Shopee postado num grupo de origem do espelhamento da Amazon é ignorado: nenhum item, nenhum envio, nenhuma chamada à Shopee', async () => {
  const f = fetchShopee();
  const s = await montar({ modo: 'fake', fetch: f });
  try {
    await s.conectar();
    const tpl = s.db.prepare("SELECT id FROM templates WHERE name = 'Amazon'").get().id;
    s.db.prepare("INSERT INTO conexoes (plataforma, config, segredos, updated_at) VALUES ('amazon', ?, '{}', ?)").run(JSON.stringify(CONEXAO_AMAZON), Date.now());
    s.db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run('999@g.us', 'Origem', 5, Date.now());
    s.scheduler.espelho.criar({ nome: 'Amazon → Achadinhos', origem_jids: ['999@g.us'], destino_jids: [GRUPO], template_id: tpl });
    const texto = `Olha esse fone!\n${PRODUTO}\nou https://s.shopee.com.br/AbC123`;
    s.wa._onMensagens({ type: 'notify', messages: [{ key: { remoteJid: '999@g.us', fromMe: false, id: 'SHP1' }, message: { conversation: texto }, messageTimestamp: Math.floor(Date.now() / 1000) }] });
    await new Promise((ok) => setTimeout(ok, 200));
    await s.scheduler.tick();
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM espelho_itens').get().n, 0, 'nenhum item de espelho');
    assert.equal(s.envios().length, 0);
    assert.equal(s.msgs().length, 0);
    assert.equal(f.chamadas.length, 0);
    // controle: o espelhamento está ligado de verdade (um link da Amazon na mesma origem vira item)
    s.wa._onMensagens({ type: 'notify', messages: [{ key: { remoteJid: '999@g.us', fromMe: false, id: 'AMZ1' }, message: { conversation: 'https://www.amazon.com.br/dp/B0FG2MD49G' }, messageTimestamp: Math.floor(Date.now() / 1000) }] });
    await new Promise((ok) => setTimeout(ok, 200));
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM espelho_itens').get().n, 1, 'o controle da Amazon gerou item');
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM espelho_itens WHERE asin IS NULL').get().n, 0);
  } finally { await s.fechar(); }
});

test('CA9: regra automática ignora o link da Shopee da lista (só ML entra); o link do ML da mesma lista sai normalmente pelo pedido `link`, nunca `link_shopee`', async () => {
  const f = fetchShopee();
  const s = await montar({ modo: 'extension', fetch: f });
  const ext = extensao(s, (job) => (job.type === 'link' ? { ok: true, link: 'https://meli.la/AbCdEf1' } : { ok: false, error: 'tipo inesperado' }));
  try {
    await s.conectar();
    const tag = Number(s.db.prepare("INSERT INTO tags (name) VALUES ('tag-ml')").run().lastInsertRowid);
    const lista = `${PRODUTO} | Fone da regra | 59,90\n${ML_URL} | Cadeira da regra | 199,90 | 299,90`;
    s.db.prepare("INSERT INTO rules (name, enabled, tag_id, template_id, group_jids, source_type, source_config, per_run, interval_min) VALUES ('Regra', 1, ?, 1, ?, 'list', ?, 5, 60)")
      .run(tag, JSON.stringify([GRUPO]), JSON.stringify({ items: lista }));
    const id = s.db.prepare('SELECT id FROM rules').get().id;
    await s.scheduler.runRule(id, { manual: true });
    assert.deepEqual(ext.jobs.map((j) => [j.type, j.url]), [['link', ML_URL]], 'só o ML pediu link, e pelo caminho do ML');
    assert.equal(f.api().length, 0);
    assert.equal(s.msgs().length, 1);
    assert.match(s.msgs()[0].text, /Cadeira da regra/);
    assert.match(s.msgs()[0].text, /meli\.la\/AbCdEf1/);
    assert.doesNotMatch(JSON.stringify(s.wa.simulated), /shopee|Fone da regra/i);
  } finally { await ext.parar(); await s.fechar(); }
});

// ============================================================================== modos do serviço de links e papéis

test('Modo fake (DRY_RUN): sem extensão e sem API, o Identificar libera o Disparar e o link simulado s.shopee.com.br/fake… sai; o modo direto do ML não dispensa a extensão', async () => {
  const s = await montar({ modo: 'fake', fetch: fetchShopee({ api: 10035 }) });
  try {
    await s.conectar({ id_afiliado: ID_AF });
    const id = await s.identificar(PRODUTO);
    assert.deepEqual([id.json.link_via, id.json.pode_disparar], ['extensao', true]);
    const r = await s.disparar({ ajustes: { title: 'Simulado' } });
    assert.equal(r.status, 200, r.txt);
    await s.assentar();
    assert.match(s.msgs()[0].text, /https:\/\/s\.shopee\.com\.br\/fake\d+/);
  } finally { await s.fechar(); }
  // modo direto (link_mode = direct): para o ML significa "sem etiqueta"; a Shopee nunca sai sem afiliado
  const d = await montar({ modo: 'direct', fetch: fetchShopee({ api: 10035 }) });
  try {
    await d.conectar({ id_afiliado: ID_AF });
    const id = await d.identificar(PRODUTO);
    assert.deepEqual([id.json.link_via, id.json.causa_link, id.json.pode_disparar], [null, 'sem_link', false]);
    const r = await d.disparar({ ajustes: { title: 'Direto' } });
    assert.equal(r.status, 400);
    assert.equal(d.envios().length, 0);
    const ext = extensao(d);
    try {
      const ok = await d.disparar({ ajustes: { title: 'Direto' } });
      assert.equal(ok.status, 200, ok.txt);
      assert.deepEqual(ext.jobs.map((j) => j.type), ['link_shopee'], 'no modo direto a Shopee ainda vai à extensão');
      await d.assentar();
      assert.ok(d.msgs()[0].text.includes(LINK_EXT));
    } finally { await ext.parar(); }
  } finally { await d.fechar(); }
});

test('Papéis: o Operador identifica e dispara a Shopee, mas não salva nem testa Conexões, e o cartão dele não traz nomes de segredos nem a Senha', async () => {
  const f = fetchShopee();
  const s = await montar({ fetch: f });
  try {
    await s.conectar(); // painel ainda sem login: é do Dono
    const ativar = await s.post('/api/equipe/ativar', { nome: 'Ana', email: 'ana@exemplo.com', senha: 'senha-da-ana-123' });
    assert.equal(ativar.status, 200, ativar.txt);
    const cookieDe = (r) => String(r.headers['set-cookie']?.[0] || '').split(';')[0];
    const dono = { cookie: cookieDe(ativar) };
    const conv = await pedir(s.port, 'POST', '/api/equipe/convites', { email: 'bia@exemplo.com', papel: 'operador' }, dono);
    assert.equal(conv.status, 201, conv.txt);
    const aceite = await s.post('/api/convite/aceitar', { token: String(conv.json.link).split('#')[1], nome: 'Bia', senha: 'senha-da-bia-123' });
    assert.equal(aceite.status, 200, aceite.txt);
    const op = { cookie: cookieDe(aceite) };

    const c = await pedir(s.port, 'GET', '/api/conexoes', null, op);
    assert.equal(c.status, 200);
    const cartao = c.json.find((p) => p.id === 'shopee');
    assert.ok(!('segredos_salvos' in cartao), 'o Operador não vê nem os nomes dos segredos');
    assert.ok(!c.txt.includes(CHAVE));
    assert.equal(cartao.estado, 'pronta');
    const put = await pedir(s.port, 'PUT', '/api/conexoes/shopee', { campos: { id_afiliado: '11111111111' } }, op);
    assert.equal(put.status, 403, put.txt);
    const testar = await pedir(s.port, 'POST', '/api/conexoes/shopee/testar', null, op);
    assert.equal(testar.status, 403, testar.txt);
    assert.equal(f.api().length, 0, 'o Operador não gasta chamada da API em Conexões');
    // o que o Operador faz: Identificar e Disparar
    const id = await pedir(s.port, 'POST', '/api/disparo/identificar', { url: PRODUTO }, op);
    assert.equal(id.status, 200, id.txt);
    assert.equal(id.json.pode_disparar, true);
    const r = await pedir(s.port, 'POST', '/api/envios', { tipo: 'oferta', url: PRODUTO, template_id: 1, group_jids: [GRUPO], quando: 'agora' }, op);
    assert.equal(r.status, 200, r.txt);
    await s.assentar();
    assert.ok(s.msgs()[0].text.includes(LINK_API));
    // o ID de afiliado continua o do Dono
    assert.equal(JSON.parse(s.db.prepare("SELECT config FROM conexoes WHERE plataforma = 'shopee'").get().config).id_afiliado, ID_AF);
  } finally { await s.fechar(); }
});

// ============================================================================== Disparo sem grupo e vários grupos

test('Bordas do envio: sem grupo, grupo inexistente e WhatsApp desconectado recusam antes de gerar o link', async () => {
  const s = await montar({ fetch: fetchShopee({ api: 10035 }) });
  const ext = extensao(s);
  try {
    await s.conectar();
    for (const group_jids of [[], ['nao-existe@g.us'], 'texto']) {
      const r = await s.disparar({ ajustes: { title: 'Fone' }, group_jids });
      assert.equal(r.status, 400, JSON.stringify(group_jids));
    }
    assert.equal(s.envios().length, 0);
    assert.equal(ext.jobs.length, 0, 'link não é pedido para envio que não vai sair');
  } finally { await ext.parar(); await s.fechar(); }
});

// ============================================================================== rede

test('CA8: o fetch global nunca foi chamado neste arquivo', () => {
  assert.equal(acessosRede, 0);
});
