// Espelhamento de ofertas da Amazon (plano espelhamento-amazon, etapa 11; CA1–CA5, CA7, CA9, CA10, CA11, CA12).
// createEspelho direto, com a fila de envios real (createEnvios) e o WhatsApp em dryRun: o que "sai" fica em
// wa.simulated. A Amazon é o createAmazon de verdade com um fetch falso injetado (encurtadores, token e GetItems).
// O fetch global fica bloqueado no arquivo inteiro e o último teste prova que ele nunca foi chamado (CA10).
// O relógio do espelho é injetado (janela de horário, máximo por hora, expiração).
// Etapa 13 (ligação): o agendador cria o espelho e o roda no tick; o servidor (criarServicos + buildApp) liga o
// ouvinte do WhatsApp ao espelho e monta as rotas. Ponta a ponta: wa._onMensagens → tick → wa.simulated.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { openDb } from '../src/db.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createLinkService } from '../src/links.js';
import { createEnvios } from '../src/envios.js';
import { createAmazon, MENSAGENS_AMAZON } from '../src/amazon.js';
import { FIXTURES } from '../src/oferta-texto.js';
import { createEspelho, montarRotas, ErroEspelho } from '../src/espelho.js';
import { createScheduler } from '../src/scheduler.js';
import { buildApp, criarServicos } from '../src/server.js';
import { SAMPLE_OFFER_AMAZON } from '../src/template.js';

let acessosRede = 0;
globalThis.fetch = async () => { acessosRede++; throw new Error('rede proibida no teste'); };

const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-esp-')); pastas.push(p); return p; };

const HORA = 3600000;
const ORIGEM = '100@g.us';
const DEST1 = '200@g.us';
const DEST2 = '300@g.us';
const GRUPOS = [[ORIGEM, 'Ofertas Origem'], [DEST1, 'Achadinhos Tech'], [DEST2, 'Tech Dois']];
const ASIN = 'B0FG2MD49G'; // o das fixtures de src/oferta-texto.js
const TAG = 'pedro-20';
const CRED_ID = 'credencial-id-0001';
const SEGREDO = 'segredo-super-secreto-123';
const TOKEN = 'token-oauth-secreto-xyz';
const SEGREDOS = [CRED_ID, SEGREDO, TOKEN];
const IMG = 'https://m.media-amazon.com/images/I/71abcDEF.jpg';
const LINK_LIMPO = `https://www.amazon.com.br/dp/${ASIN}?tag=${TAG}`;
const URL_CURTO = 'https://link.amazon/2q3Xk9Z'; // o das fixtures linkCurto e soLink
const URL_TERCEIRO = `https://www.amazon.com.br/Roteador-Mesh-TP-Link/dp/${ASIN}?tag=terceiro-20&crid=ABC123&dib=xyz&sr=8-1&qid=1730000000&linkId=l1&ascsubtag=s`;
const RASTREIO = /terceiro|crid|dib=|sr=|qid|linkId|ascsubtag|Roteador-Mesh/;
const TITULO_API = 'Roteador Mesh TP-Link Deco BE22, Wi-Fi 7';

const respJson = (status, corpo, headers = {}) => new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json', ...headers } });
const itemApi = (asin, { title = TITULO_API, price = 1310.05, oldPrice = 1999, pct = 34, disponivel = 'IN_STOCK' } = {}) => ({
  asin, detailPageURL: `https://www.amazon.com.br/dp/${asin}?tag=${TAG}&linkCode=ogi`,
  itemInfo: { title: { displayValue: title } },
  images: { primary: { large: { url: IMG, height: 500, width: 500 } } },
  offersV2: { listings: [{ isBuyBoxWinner: true, availability: { type: disponivel }, price: { money: { amount: price }, ...(oldPrice ? { savingBasis: { money: { amount: oldPrice } } } : {}), ...(pct ? { savings: { percentage: pct } } : {}) } }] },
});

/**
 * fetch falso da Amazon. estado.api: 'ok' | '403' | '429' | '401'; estado.itens: ASIN → opções de itemApi (ou null:
 * fora da resposta). estado.curtos: URL → Location (301). Guarda método e URL de cada chamada.
 */
function fetchAmazon(estado) {
  const chamadas = [];
  const f = async (url, init = {}) => {
    const u = String(url);
    chamadas.push({ url: u, metodo: init.method || 'GET' });
    if (Object.hasOwn(estado.curtos, u)) return new Response(null, { status: 301, headers: { location: estado.curtos[u] } });
    if (u === 'https://www.amazon.com.br/s?k=fone') return new Response('<html>busca</html>', { status: 200 });
    if (u === 'https://api.amazon.com/auth/o2/token') {
      if (estado.api === '401') return respJson(401, { error: 'invalid_client' });
      return respJson(200, { access_token: TOKEN, token_type: 'bearer', expires_in: 3600 });
    }
    if (u === 'https://creatorsapi.amazon/catalog/v1/getItems') {
      if (estado.api === '403') return respJson(403, { type: 'AccessDeniedException', reason: 'AssociateNotEligible' });
      if (estado.api === '429') return respJson(429, { type: 'ThrottleException' }, { 'retry-after': '30' });
      const pedidos = JSON.parse(init.body).itemIds;
      return respJson(200, { itemsResult: { items: pedidos.filter((a) => estado.itens[a] !== null).map((a) => itemApi(a, estado.itens[a] || {})) } });
    }
    throw new Error('rede não prevista no teste');
  };
  f.chamadas = chamadas;
  return f;
}

/** Banco com 3 grupos, WhatsApp simulado, Amazon com fetch falso, fila de envios real e o espelho com relógio próprio. */
function montar({ tag = TAG, credenciais = true, api = 'ok', comAmazon = true } = {}) {
  const dir = tmp();
  const db = openDb(dir);
  for (const [jid, nome] of GRUPOS) db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, nome, 10, Date.now());
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const estado = { api, itens: {}, curtos: { [URL_CURTO]: URL_TERCEIRO, 'https://amzn.to/busca': 'https://www.amazon.com.br/s?k=fone' } };
  const fetchF = fetchAmazon(estado);
  const conexao = { tag, credencial_versao: '3.1', ...(credenciais ? { credencial_id: CRED_ID, credencial_secret: SEGREDO } : {}) };
  const amazon = comAmazon ? createAmazon({ db, fetch: fetchF, esperar: async () => {}, lerConexao: () => conexao }) : null;
  const envios = createEnvios({ db, wa, links, ml: null, fast: true, dir, amazon });
  const relogio = { t: Date.now() };
  const acordou = { n: 0 };
  const espelho = createEspelho({ db, wa, amazon, envios, acordar: () => { acordou.n++; }, fast: true, agora: () => relogio.t });
  const tplAmazon = db.prepare("SELECT id FROM templates WHERE name = 'Amazon'").get().id;
  let seq = 0;
  const s = {
    dir, db, wa, envios, amazon, espelho, estado, fetchF, conexao, relogio, acordou, tplAmazon,
    /** Cria a regra (origem → 2 destinos, template Amazon) com os campos extras. → id */
    regra: (extra = {}) => espelho.criar({ nome: 'Amazon → Achadinhos', origem_jids: [ORIGEM], destino_jids: [DEST1, DEST2], template_id: tplAmazon, ...extra }).id,
    /** Mensagem como o ouvinte do whatsapp.js entrega. → itens gravados */
    receber: (texto, o = {}) => espelho.receber({ jid: ORIGEM, fromMe: false, texto, msgId: `MSG${++seq}`, ts: relogio.t, ...o }),
    /** Um passo do espelho e um da fila de envios, no relógio do teste. */
    async rodar() { const n = await espelho.processarPendentes(relogio.t); await envios.processarPendentes(relogio.t); return n; },
    itens: () => db.prepare('SELECT * FROM espelho_itens ORDER BY id').all().map((r) => ({ ...r })),
    item: (id) => ({ ...db.prepare('SELECT * FROM espelho_itens WHERE id = ?').get(id) }),
    enviados: () => wa.simulated.filter((m) => m.jid !== 'status@broadcast'),
    logs: () => db.prepare('SELECT * FROM log ORDER BY id').all().map((r) => ({ ...r })),
  };
  return s;
}

const hoje = (h, m = 0) => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime(); };
const semSegredo = (texto, onde) => { for (const x of SEGREDOS) assert.ok(!String(texto).includes(x), `${onde}: vazou credencial/segredo/token`); };
const capturarConsole = (t) => ['error', 'warn', 'log', 'info'].map((m) => t.mock.method(console, m, () => {}));
const textoDoConsole = (espias) => espias.flatMap((e) => e.mock.calls.map((c) => c.arguments.map(String).join(' '))).join('\n');

// ------------------------------------------------------------------------------------------------ CA1, CA2

test('CA1: link.amazon só com o link → API → imagem com legenda (título, preço, desconto, link limpo) em cada destino, nunca na origem', async () => {
  const s = montar();
  s.regra();
  assert.equal(s.receber(FIXTURES.soLink), 1);
  assert.equal(s.acordou.n, 1, 'receber acorda o agendador');
  assert.equal(s.item(1).status, 'recebido');
  await s.rodar();

  const it = s.item(1);
  assert.deepEqual([it.status, it.fonte_dados, it.asin, it.motivo], ['enviado', 'api', ASIN, null]);
  const enviados = s.enviados();
  assert.deepEqual(enviados.map((m) => [m.tipo, m.jid]).sort(), [['image', DEST1], ['image', DEST2]]);
  for (const m of enviados) {
    assert.equal(m.image, IMG);
    assert.match(m.text, new RegExp(`^\\*${TITULO_API}\\*`));
    assert.match(m.text, /De ~R\$ 1\.999,00~/);
    assert.match(m.text, /Por \*R\$ 1\.310,05\* \(34% OFF\)/);
    assert.ok(m.text.endsWith(`Compre aqui: ${LINK_LIMPO}`), m.text);
    assert.doesNotMatch(m.text, RASTREIO);
  }
  assert.ok(!enviados.some((m) => m.jid === ORIGEM), 'a origem nunca recebe');
  // o encurtador foi resolvido só com GET; depois token e GetItems
  assert.deepEqual(s.fetchF.chamadas.map((c) => `${c.metodo} ${c.url}`), [
    `GET ${URL_CURTO}`, 'POST https://api.amazon.com/auth/o2/token', 'POST https://creatorsapi.amazon/catalog/v1/getItems',
  ]);
  // histórico: "Espelhada · com dados da Amazon", com o resultado por grupo
  const [h] = s.espelho.itens();
  assert.deepEqual([h.status, h.fonte_dados, h.origem_nome, h.espelho_nome], ['enviado', 'api', 'Ofertas Origem', 'Amazon → Achadinhos']);
  assert.deepEqual(h.destinos, [{ nome: 'Achadinhos Tech', ok: true, erro: null }, { nome: 'Tech Dois', ok: true, erro: null }]);
  const linha = s.logs().find((l) => l.rule_name === 'Espelho: Amazon → Achadinhos' && l.group_name === 'Ofertas Origem');
  assert.deepEqual([linha.level, linha.message, linha.offer_title], ['ok', 'Espelhada com dados da Amazon', TITULO_API]);
  assert.ok(s.logs().some((l) => l.rule_name === 'Espelho: Amazon → Achadinhos' && l.group_name === 'Achadinhos Tech' && l.level === 'ok'), 'o envio por grupo vai ao log com o nome do espelho');
});

test('CA1: fixture completa com link.amazon → dados da API e, campo a campo, vendas e frete do texto (api+texto)', async () => {
  const s = montar();
  s.regra();
  s.receber(FIXTURES.linkCurto);
  await s.rodar();
  const it = s.item(1);
  assert.deepEqual([it.status, it.fonte_dados], ['enviado', 'api+texto']);
  assert.deepEqual(JSON.parse(it.oferta), { title: TITULO_API, price: 1310.05, oldPrice: 1999, discountPct: 34, sold: 200, freeShipping: true, coupon: null, image: IMG });
  const [m] = s.enviados();
  assert.match(m.text, /🚚 Frete grátis/);
  assert.ok(m.text.endsWith(`Compre aqui: ${LINK_LIMPO}`));
});

test('CA2: link longo com slug, tag de terceiro e rastreio → sai só /dp/<ASIN>?tag=<nossa>, sem rede para resolver; o banco guarda o link limpo', async () => {
  const s = montar();
  s.regra();
  s.receber(FIXTURES.compreAquiNaLinha);
  assert.equal(s.item(1).url, `https://www.amazon.com.br/dp/${ASIN}`, 'nada da tag de terceiro nem do rastreio vai ao banco');
  await s.rodar();
  assert.equal(s.item(1).status, 'enviado');
  for (const m of s.enviados()) {
    assert.ok(m.text.includes(LINK_LIMPO), m.text);
    assert.doesNotMatch(m.text, RASTREIO);
    assert.equal(m.text.match(/https:\/\/\S+/g).length, 1, 'um link só');
  }
  assert.ok(!s.fetchF.chamadas.some((c) => c.metodo === 'GET'), 'link com o ASIN não passa pelo resolvedor');
});

test('CA2: sem tag em Conexões o espelhamento não liga; se a tag some depois, o item não sai (erro com motivo)', async () => {
  const s = montar({ tag: '' });
  assert.throws(() => s.regra(), (e) => e instanceof ErroEspelho && e.status === 400 && /Falta a tag de associado da Amazon/.test(e.message));
  const id = s.regra({ enabled: false });
  assert.throws(() => s.espelho.ativar(id, true), /Falta a tag/);
  s.conexao.tag = TAG;
  assert.deepEqual(s.espelho.ativar(id, true), { ok: true, enabled: true });
  s.receber(FIXTURES.linkLongo);
  s.conexao.tag = '';
  await s.rodar();
  assert.deepEqual([s.item(1).status, s.item(1).motivo], ['erro', 'falta a tag de associado da Amazon em Conexões']);
  assert.equal(s.enviados().length, 0);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM envios').get().n, 0);
  assert.equal(s.espelho.listar().espelhos[0].problema, 'Falta a tag de associado da Amazon. Sem ela o espelhamento não liga. Cadastre em Conexões.');
});

// ------------------------------------------------------------------------------------------------ CA3

test('CA3: API em 403 + mensagem com De/Por → sai com o texto da origem (fonte texto, sem foto), motivo no histórico e no log', async () => {
  const s = montar({ api: '403' });
  s.regra();
  s.receber(FIXTURES.linkLongo);
  await s.rodar();
  const it = s.item(1);
  assert.deepEqual([it.status, it.fonte_dados, it.motivo], ['enviado', 'texto', MENSAGENS_AMAZON.sem_acesso]);
  const enviados = s.enviados();
  assert.equal(enviados.length, 2);
  for (const m of enviados) {
    assert.equal(m.tipo, 'text', 'sem a API não há foto');
    assert.match(m.text, /^\*Roteador Mesh TP-Link Deco BE22, Wi-Fi 7, Pack com 3 Unidades\*|^\*Roteador Mesh TP-Link Deco BE22/);
    assert.match(m.text, /De ~R\$ 1\.999,00~/);
    assert.match(m.text, /Por \*R\$ 1\.310,05\* \(34% OFF\)/);
    assert.match(m.text, /Frete grátis/);
    assert.ok(m.text.endsWith(`Compre aqui: ${LINK_LIMPO}`));
  }
  assert.equal(s.amazon.situacao().acesso, 'sem_acesso');
  assert.ok(s.logs().some((l) => l.message === `Espelhada com o texto da origem (${MENSAGENS_AMAZON.sem_acesso})`));
});

test('CA3: só o link e API fora → na fila (padrão); "curto" envia só o link; completar envia com os valores; repetir dá 409', async (t) => {
  const s = montar({ api: '403' });
  const fila = s.regra();
  s.receber(FIXTURES.soLink);
  await s.rodar();
  let it = s.item(1);
  assert.deepEqual([it.status, it.motivo, it.envio_id], ['na_fila', 'falta completar (sem título e preço)', null]);
  assert.equal(s.enviados().length, 0);
  assert.ok(s.logs().some((l) => l.message === `Na fila: falta completar (sem título e preço). ${MENSAGENS_AMAZON.sem_acesso}`));
  assert.equal(s.espelho.listar().espelhos[0].contadores_24h.na_fila, 1);
  assert.deepEqual(s.espelho.itens({ status: 'na_fila' }).map((i) => i.id), [1]);

  // completar: ajustes do painel; palavra bloqueada vale de novo; preço obrigatório
  s.espelho.atualizar(fila, { nome: 'Amazon → Achadinhos', origem_jids: [ORIGEM], destino_jids: [DEST1, DEST2], template_id: s.tplAmazon, palavras_bloqueadas: ['usado'] });
  await assert.rejects(s.espelho.completar(1, { ajustes: { title: 'Roteador Usado' , price: '100' } }), /palavra bloqueada deste espelhamento: usado/);
  await assert.rejects(s.espelho.completar(1, { ajustes: { title: 'Roteador Mesh' } }), /Preencha o preço atual/);
  await assert.rejects(s.espelho.completar(1, { ajustes: { title: 'Roteador Mesh', price: 'abc' } }), /Preço atual inválido/);
  await assert.rejects(s.espelho.completar(1, { ajustes: { title: 'Roteador Mesh', price: '10', upload: '../../etc/passwd' } }), /Escolha a foto de novo/);
  const r = await s.espelho.completar(1, { ajustes: { title: 'Roteador Mesh Deco', price: '1.299,90', oldPrice: '1999', coupon: 'DESEJO10', freeShipping: true, image: 'https://evil.example/x.jpg', link: 'https://evil.example' } });
  assert.ok(Number.isInteger(r.envio_id));
  it = s.item(1);
  assert.deepEqual([it.status, it.fonte_dados, it.envio_id], ['enviado', 'manual', r.envio_id]);
  await s.envios.processarPendentes(s.relogio.t);
  const enviados = s.enviados();
  assert.equal(enviados.length, 2);
  for (const m of enviados) {
    assert.equal(m.tipo, 'text');
    assert.match(m.text, /^\*Roteador Mesh Deco\*/);
    assert.match(m.text, /De ~R\$ 1\.999,00~/); assert.match(m.text, /Por \*R\$ 1\.299,90\* \(35% OFF\)/);
    assert.match(m.text, /Cupom: \*DESEJO10\*/); assert.match(m.text, /Frete grátis/);
    assert.ok(m.text.endsWith(`Compre aqui: ${LINK_LIMPO}`));
    assert.doesNotMatch(m.text, /evil/);
  }
  await assert.rejects(s.espelho.completar(1, { ajustes: { title: 'x', price: '1' } }), (e) => e.status === 409 && e.message === 'Esta oferta já foi tratada.');
  assert.throws(() => s.espelho.descartar(1), (e) => e.status === 409);

  // a mesma oferta com "enviar mesmo assim": sai só com o link (formato curto)
  const curto = s.regra({ nome: 'Curto', sem_preco: 'curto', dedupe_horas: 0 });
  s.receber(FIXTURES.soLink);
  await s.rodar();
  const itCurto = s.itens().find((i) => i.espelho_id === curto);
  assert.deepEqual([itCurto.status, itCurto.fonte_dados, itCurto.motivo], ['enviado', 'curto', 'sem título e preço']);
  const novos = s.enviados().slice(2);
  assert.deepEqual(novos.map((m) => [m.tipo, m.text]), [['text', `🛒 Compre aqui: ${LINK_LIMPO}`], ['text', `🛒 Compre aqui: ${LINK_LIMPO}`]]);
  // na regra da fila, o mesmo produto completado à mão conta para a deduplicação
  assert.deepEqual(s.itens().filter((i) => i.espelho_id === fila).map((i) => i.status), ['enviado', 'duplicado']);
  // outro produto só com o link: vai para a fila; descartar à mão
  s.estado.curtos['https://amzn.to/outro2'] = 'https://www.amazon.com.br/dp/B0OUTRO222';
  s.receber('https://amzn.to/outro2');
  await s.rodar();
  const naFila = s.itens().find((i) => i.espelho_id === fila && i.status === 'na_fila');
  assert.deepEqual(s.espelho.descartar(naFila.id), { ok: true });
  assert.deepEqual([s.item(naFila.id).status, s.item(naFila.id).motivo], ['descartado', 'descartada à mão']);
  assert.throws(() => s.espelho.descartar(naFila.id), /Esta oferta já foi tratada/);
  t.diagnostic(`itens: ${s.itens().length}`);
});

test('CA3: API com cota (429, Retry-After 30 s) → espera e tenta de novo até 3 vezes; depois segue com o texto', async () => {
  const s = montar({ api: '429' });
  s.regra();
  s.receber(FIXTURES.linkLongo);
  const t0 = s.relogio.t;
  for (let i = 1; i <= 3; i++) {
    await s.rodar();
    const it = s.item(1);
    assert.deepEqual([it.status, it.tentativas, it.espera_ate], ['recebido', i, s.relogio.t + 30000], `tentativa ${i}`);
    assert.equal(await s.espelho.processarPendentes(s.relogio.t + 29000), 0, 'antes da hora não processa');
    s.relogio.t += 30000;
  }
  await s.rodar();
  const it = s.item(1);
  assert.deepEqual([it.status, it.fonte_dados, it.motivo], ['enviado', 'texto', MENSAGENS_AMAZON.cota]);
  assert.equal(s.enviados().length, 2);
  assert.ok(s.relogio.t - t0 < 2 * HORA);
});

test('CA3: link que não chega a um produto → erro com motivo; produto que a API não acha no Brasil → fila', async () => {
  const s = montar();
  s.regra();
  s.receber('Olha isso https://amzn.to/busca');
  s.receber('Sem rota https://amzn.to/naoexiste');
  s.estado.itens.B0SUMIU000 = null;
  s.receber('Produto que sumiu Por R$ 10,00 https://www.amazon.com.br/dp/B0SUMIU000');
  await s.rodar();
  const [a, b, c] = s.itens();
  assert.deepEqual([a.status, a.motivo], ['erro', 'não é um produto']);
  assert.deepEqual([b.status, b.motivo], ['erro', 'link não resolvido']);
  assert.deepEqual([c.status, c.motivo], ['na_fila', 'a Amazon não encontrou este produto na loja do Brasil']);
  assert.equal(s.enviados().length, 0);
  assert.ok(s.logs().some((l) => l.message === 'Não espelhada: não é um produto' && l.level === 'erro'));
});

// ------------------------------------------------------------------------------------------------ CA4, CA5

test('CA4: o mesmo ASIN dentro da janela vira "repetida (enviada há N h)"; fora dela, sai de novo; dedupe_horas 0 sempre envia', async () => {
  const s = montar();
  s.regra({ dedupe_horas: 5 });
  s.receber(FIXTURES.linkLongo);
  await s.rodar();
  s.relogio.t += 10 * 60000;
  s.receber(FIXTURES.soLink); // outro link, o mesmo ASIN
  await s.rodar();
  assert.deepEqual([s.item(2).status, s.item(2).motivo, s.item(2).asin], ['duplicado', 'repetida (enviada há menos de 1 h)', ASIN]);
  s.relogio.t += 3 * HORA;
  s.receber(FIXTURES.linkLongo);
  await s.rodar();
  assert.deepEqual([s.item(3).status, s.item(3).motivo], ['duplicado', 'repetida (enviada há 3 h)']);
  assert.equal(s.enviados().length, 2, 'só o primeiro saiu');
  assert.ok(s.logs().some((l) => l.message === 'Descartada: repetida (enviada há 3 h)'));
  s.relogio.t += 2 * HORA + 60000; // passou das 5 h
  s.receber(FIXTURES.linkLongo);
  await s.rodar();
  assert.equal(s.item(4).status, 'enviado');
  assert.equal(s.enviados().length, 4);

  const z = montar();
  z.regra({ dedupe_horas: 0 });
  z.receber(FIXTURES.linkLongo); await z.rodar();
  z.receber(FIXTURES.linkLongo); await z.rodar();
  assert.deepEqual(z.itens().map((i) => i.status), ['enviado', 'enviado']);
  assert.equal(z.enviados().length, 4);
});

test('CA4 (Q1): completar item da fila cujo produto já saiu dentro de "Horas sem repetir" → 409 com o motivo e o item sai da fila como repetida', async () => {
  const s = montar({ api: '403' });
  s.regra({ dedupe_horas: 24 });
  s.estado.curtos['https://amzn.to/mesmo'] = `https://www.amazon.com.br/dp/${ASIN}`;
  s.receber(FIXTURES.soLink);
  s.receber('https://amzn.to/mesmo'); // o mesmo produto em outra mensagem, também sem preço
  await s.rodar();
  assert.deepEqual(s.itens().map((i) => i.status), ['na_fila', 'na_fila']);
  await s.espelho.completar(1, { ajustes: { title: 'Roteador Mesh', price: '1310,05' } });
  await s.envios.processarPendentes(s.relogio.t);
  assert.equal(s.enviados().length, 2);

  s.relogio.t += 2 * HORA;
  await assert.rejects(s.espelho.completar(2, { ajustes: { title: 'Roteador Mesh', price: '1310,05' } }),
    (e) => e instanceof ErroEspelho && e.status === 409 && e.message === 'Este produto já foi espelhado há 2 h, dentro de "Horas sem repetir". A oferta saiu da fila como repetida.');
  assert.deepEqual([s.item(2).status, s.item(2).motivo, s.item(2).envio_id], ['duplicado', 'repetida (enviada há 2 h)', null]);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM envios').get().n, 1, 'nenhum envio novo gravado');
  await s.envios.processarPendentes(s.relogio.t);
  assert.equal(s.enviados().length, 2, 'o mesmo produto não saiu de novo');
  assert.ok(s.logs().some((l) => l.message === 'Descartada: repetida (enviada há 2 h)'));
  assert.deepEqual(s.espelho.itens({ status: 'na_fila' }), [], 'a fila ficou vazia');
});

test('CA4/CA12 (Q2): envio que não chegou a nenhum grupo não conta para "Horas sem repetir" nem para "Máximo por hora"; envio ainda na fila conta', async () => {
  const s = montar({ credenciais: false }); // dados do texto, sem rede
  s.regra({ dedupe_horas: 24, max_por_hora: 1 });
  const reais = { sendText: s.wa.sendText, sendImage: s.wa.sendImage };
  s.wa.sendText = async () => { throw new Error('WhatsApp caiu'); };
  s.wa.sendImage = async () => { throw new Error('WhatsApp caiu'); };
  const msg = (n) => `Produto ${n}\nPor R$ ${n},00\nhttps://www.amazon.com.br/dp/B0TESTE00${n}`;
  s.receber(msg(1));
  await s.rodar();
  assert.equal(s.item(1).status, 'enviado');
  assert.deepEqual(s.db.prepare('SELECT ok FROM envio_resultados').all().map((r) => r.ok), [0, 0], 'nenhum grupo recebeu');

  // o máximo por hora (1) não foi gasto: outro produto na mesma hora sai, e o mesmo produto também (não é repetida)
  Object.assign(s.wa, reais);
  s.relogio.t += 60000;
  s.receber(msg(2));
  await s.rodar();
  assert.equal(s.item(2).status, 'enviado', `o envio que falhou não gastou o máximo por hora: ${s.item(2).motivo}`);
  assert.equal(s.enviados().length, 2);

  s.relogio.t += HORA;
  s.receber(msg(1));
  await s.rodar();
  assert.equal(s.item(3).status, 'enviado', `não é repetida: a primeira vez não chegou a ninguém (${s.item(3).motivo})`);
  assert.equal(s.enviados().length, 4);

  // envio ainda na fila (a fila de envios não rodou) conta: o 2º do mesmo produto espera o máximo por hora e,
  // depois dele, é repetida
  s.relogio.t += HORA;
  s.receber(msg(3)); s.receber(msg(3));
  await s.espelho.processarPendentes(s.relogio.t);
  assert.equal(s.item(4).status, 'enviado');
  assert.equal(s.db.prepare('SELECT status FROM envios WHERE id = ?').get(s.item(4).envio_id).status, 'pendente');
  assert.deepEqual([s.item(5).status, /^aguardando o máximo por hora/.test(s.item(5).motivo)], ['recebido', true]);
  s.relogio.t += HORA;
  await s.espelho.processarPendentes(s.relogio.t);
  assert.deepEqual([s.item(5).status, s.item(5).motivo], ['duplicado', 'repetida (enviada há 1 h)']);
});

test('Q2 (rodada 1, CA12): envio encerrado sem resultado (perdeu o horário, cancelado) → destinos com falha e o motivo; "Espelhadas" não conta; envio na fila segue sem resultado', async () => {
  const s = montar({ credenciais: false }); // dados do texto, sem rede
  s.regra({ dedupe_horas: 0, max_por_hora: 0 });
  const msg = (n) => `Produto ${n}\nPor R$ ${n},00\nhttps://www.amazon.com.br/dp/B0PERDEU0${n}`;
  const t0 = s.relogio.t;
  s.receber(msg(1)); s.receber(msg(2));
  await s.espelho.processarPendentes(t0);
  const porId = () => new Map(s.espelho.itens().map((i) => [i.id, i]));
  assert.deepEqual([...porId().values()].map((i) => [i.status, i.destinos.map((d) => [d.ok, d.erro])]),
    [['enviado', [[null, null], [null, null]]], ['enviado', [[null, null], [null, null]]]], 'na fila de envios: ainda sem resultado');
  assert.equal(s.espelho.listar(t0).totais_24h.espelhadas, 2, 'envio na fila conta');

  // o item 2 é cancelado na fila de envios; o WhatsApp só volta 3 h depois: o envio do item 1 perde o horário
  s.db.prepare("UPDATE envios SET status = 'cancelado' WHERE id = ?").run(s.item(2).envio_id);
  s.relogio.t = t0 + 3 * HORA;
  await s.envios.processarPendentes(s.relogio.t);
  assert.equal(s.enviados().length, 0);
  assert.equal(s.db.prepare('SELECT status FROM envios WHERE id = ?').get(s.item(1).envio_id).status, 'erro');
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM envio_resultados').get().n, 0, 'nenhum grupo tentado');

  // um item novo, já depois da volta, fica na fila de envios
  s.receber(msg(3));
  await s.espelho.processarPendentes(s.relogio.t);
  let m = porId();
  assert.equal(m.get(1).status, 'enviado', 'o status do item não muda: quem diz que não saiu são os destinos');
  assert.deepEqual(m.get(1).destinos.map((d) => d.nome), ['Achadinhos Tech', 'Tech Dois']);
  for (const d of m.get(1).destinos) { assert.equal(d.ok, false); assert.match(d.erro, /^perdeu o horário: passou mais de 2 h/); }
  assert.deepEqual(m.get(2).destinos.map((d) => [d.ok, d.erro]), [[false, 'o envio foi cancelado'], [false, 'o envio foi cancelado']]);
  assert.deepEqual(m.get(3).destinos.map((d) => [d.ok, d.erro]), [[null, null], [null, null]]);
  assert.deepEqual(s.espelho.listar(s.relogio.t).totais_24h, { espelhadas: 1, descartadas: 0, na_fila: 0 }, 'só o que ainda está na fila conta');

  // o item 3 sai: destinos ok e continua contando
  await s.envios.processarPendentes(s.relogio.t);
  m = porId();
  assert.deepEqual(m.get(3).destinos.map((d) => [d.ok, d.erro]), [[true, null], [true, null]]);
  assert.equal(s.espelho.listar(s.relogio.t).espelhos[0].contadores_24h.espelhadas, 1);
  // envio encerrado com erro e sem motivo guardado (resultado vazio): motivo genérico
  s.db.prepare("UPDATE envios SET resultado = NULL WHERE id = ?").run(s.item(1).envio_id);
  assert.deepEqual(porId().get(1).destinos.map((d) => [d.ok, d.erro]), [[false, 'não foi enviado'], [false, 'não foi enviado']]);
});

test('Pergunta 1 do revisor: a passada do espelho para de pegar itens depois de 20 s (relógio falso); o resto fica "recebido", sem acordar o agendador, e sai na passada seguinte', async () => {
  const s = montar({ credenciais: false }); // dados do texto; a "rede" é o relógio andando a cada consulta
  s.regra({ dedupe_horas: 0, max_por_hora: 0 });
  const lerItem = s.amazon.lerItem;
  let custo = 8000;
  s.amazon.lerItem = async (asin) => { s.relogio.t += custo; return lerItem(asin); };
  const msg = (n) => `Produto ${n}\nPor R$ ${n},00\nhttps://www.amazon.com.br/dp/B0LOTEXX0${n}`;
  for (let n = 1; n <= 5; n++) s.receber(msg(n));
  const acordouAntes = s.acordou.n;
  const status = () => s.itens().map((i) => i.status);

  // 0 s → 8 → 16 → 24: o 4º item já não começa
  assert.equal(await s.espelho.processarPendentes(), 3);
  assert.deepEqual(status(), ['enviado', 'enviado', 'enviado', 'recebido', 'recebido']);
  assert.deepEqual(s.itens().slice(3).map((i) => [i.motivo, i.espera_ate, i.tentativas, i.decidido_em]), [[null, null, 0, null], [null, null, 0, null]], 'intactos');
  assert.equal(s.acordou.n - acordouAntes, 3, 'acorda só pelos 3 envios criados, não pelo corte');
  assert.equal(await s.espelho.processarPendentes(), 2);
  assert.deepEqual(status(), Array(5).fill('enviado'));

  // um item que sozinho passa de 20 s ainda roda: cada passada trata pelo menos um
  custo = 60000;
  s.receber(msg(6)); s.receber(msg(7));
  assert.equal(await s.espelho.processarPendentes(), 1);
  assert.deepEqual(status().slice(5), ['enviado', 'recebido']);
  assert.equal(await s.espelho.processarPendentes(), 1);
  assert.deepEqual(status().slice(5), ['enviado', 'enviado']);
  await s.envios.processarPendentes(s.relogio.t);
  assert.equal(s.enviados().length, 14, '7 ofertas × 2 destinos, cada uma uma vez');
});

test('Pergunta 2 do revisor: sem a tag de associado, criar e salvar um espelhamento desligado passa (pela rota também); só ligar pede a tag', async () => {
  const s = montar({ tag: '' });
  const srv = await servidor({ espelho: s.espelho });
  try {
    const base = { nome: 'Rascunho', origem_jids: [ORIGEM], destino_jids: [DEST1], template_id: s.tplAmazon };
    const semTag = { erro: 'Falta a tag de associado da Amazon. Sem ela o espelhamento não liga. Cadastre em Conexões.' };
    let r = await pedir(srv.port, 'POST', '/api/espelhos', { ...base, enabled: false });
    assert.equal(r.status, 200, r.txt);
    const id = r.json.id;
    assert.deepEqual([r.status, r.json], [200, { id }]);
    const regra = () => s.espelho.listar().espelhos.find((e) => e.id === id);
    assert.deepEqual([regra().enabled, regra().problema], [false, null], 'desligado sem tag não é erro de configuração');

    r = await pedir(srv.port, 'PUT', `/api/espelhos/${id}`, { ...base, nome: 'Rascunho 2', enabled: false });
    assert.deepEqual([r.status, r.json], [200, { id }]);
    r = await pedir(srv.port, 'PUT', `/api/espelhos/${id}`, { ...base, nome: 'Rascunho 3' }); // sem `enabled`: continua desligado
    assert.deepEqual([r.status, regra().nome, regra().enabled], [200, 'Rascunho 3', false]);

    // ligar (salvando, criando ligado ou pelo interruptor) continua exigindo a tag
    r = await pedir(srv.port, 'PUT', `/api/espelhos/${id}`, { ...base, nome: 'Ligado', enabled: true });
    assert.deepEqual([r.status, r.json, regra().nome, regra().enabled], [400, semTag, 'Rascunho 3', false]);
    r = await pedir(srv.port, 'POST', '/api/espelhos', base);
    assert.deepEqual([r.status, r.json], [400, semTag]);
    r = await pedir(srv.port, 'POST', `/api/espelhos/${id}/enabled`, { enabled: true });
    assert.deepEqual([r.status, r.json, regra().enabled], [400, semTag, false]);
    assert.equal(s.espelho.listar().espelhos.length, 1);

    s.conexao.tag = TAG;
    r = await pedir(srv.port, 'POST', `/api/espelhos/${id}/enabled`, { enabled: true });
    assert.deepEqual([r.status, r.json, regra().enabled], [200, { ok: true, enabled: true }, true]);
  } finally { await srv.fechar(); }
});

test('CA5: palavra bloqueada no título (API) ou no texto, sem caixa nem acento, descarta; "acusado" não casa com "usado"', async () => {
  const s = montar();
  const id = s.regra({ palavras_bloqueadas: 'Usado, recondicionado\nvitrine\nusado' });
  assert.deepEqual(s.espelho.listar().espelhos[0].palavras_bloqueadas, ['Usado', 'recondicionado', 'vitrine'], 'texto vira lista, sem repetir');
  assert.equal(s.db.prepare('SELECT palavras_bloqueadas FROM espelhos WHERE id = ?').get(id).palavras_bloqueadas, '["Usado","recondicionado","vitrine"]');
  s.estado.itens.B0USADO001 = { title: 'Fone Bluetooth Usádo em ótimo estado' };
  s.receber('Fone bom https://www.amazon.com.br/dp/B0USADO001');
  s.receber('Notebook (produto USADO, sem marcas) https://www.amazon.com.br/dp/B0TEXTO001');
  s.receber('Roteador do acusado Por R$ 10,00 https://www.amazon.com.br/dp/B0LIMPO001');
  await s.rodar();
  const [a, b, c] = s.itens();
  assert.deepEqual([a.status, a.motivo], ['descartado', 'palavra bloqueada (Usado)']);
  assert.deepEqual([b.status, b.motivo], ['descartado', 'palavra bloqueada (Usado)']);
  assert.equal(c.status, 'enviado');
  assert.ok(s.logs().some((l) => l.message === 'Descartada: palavra bloqueada (Usado)' && l.offer_title === 'Fone Bluetooth Usádo em ótimo estado'));
  assert.equal(s.espelho.listar().espelhos[0].contadores_24h.descartadas, 2);
});

// ------------------------------------------------------------------------------------------------ CA9

test('CA9: fromMe só com incluir_minhas; link com a nossa tag ignorado; origem = destino recusado; a origem sai dos destinos do envio', async () => {
  const s = montar();
  const id = s.regra();
  assert.equal(s.receber(FIXTURES.linkLongo, { fromMe: true }), 0, 'minha mensagem: desligado por padrão');
  assert.equal(s.receber(`Meu link https://www.amazon.com.br/dp/${ASIN}?tag=${TAG}`), 0, 'link com a nossa tag');
  assert.equal(s.receber(`Meu link https://www.amazon.com.br/dp/${ASIN}?TAG=PEDRO-20`), 0, 'sem distinguir caixa');
  assert.equal(s.receber(FIXTURES.linkLongo, { jid: DEST1 }), 0, 'grupo que não é origem');
  assert.equal(s.receber(FIXTURES.linkLongo, { jid: '5531999998888@s.whatsapp.net' }), 0, 'conversa privada');
  assert.equal(s.receber('sem link nenhum'), 0);
  assert.equal(s.receber('https://www.mercadolivre.com.br/p/MLB123'), 0, 'só Amazon');
  assert.equal(s.itens().length, 0);
  assert.equal(s.acordou.n, 0);

  s.espelho.atualizar(id, { nome: 'Amazon → Achadinhos', origem_jids: [ORIGEM], destino_jids: [DEST1, DEST2], template_id: s.tplAmazon, incluir_minhas: true });
  assert.equal(s.receber(FIXTURES.linkLongo, { fromMe: true }), 1);

  assert.throws(() => s.espelho.criar({ nome: 'Laço', origem_jids: [ORIGEM, DEST1], destino_jids: [DEST1, ORIGEM, DEST2], template_id: s.tplAmazon }),
    (e) => e.status === 400 && e.message === 'Um grupo não pode ser origem e destino ao mesmo tempo: Ofertas Origem, Achadinhos Tech.');
  assert.throws(() => s.espelho.atualizar(id, { nome: 'x', origem_jids: [ORIGEM], destino_jids: [ORIGEM], template_id: s.tplAmazon }), /origem e destino ao mesmo tempo/);

  // regra gravada à mão com a origem nos destinos (banco antigo, edição direta): o envio não vai à origem (guarda 3)
  s.db.prepare('UPDATE espelhos SET destino_jids = ? WHERE id = ?').run(JSON.stringify([ORIGEM, DEST1]), id);
  await s.rodar();
  const it = s.item(1);
  assert.equal(it.status, 'enviado');
  assert.deepEqual(JSON.parse(s.db.prepare('SELECT group_jids FROM envios WHERE id = ?').get(it.envio_id).group_jids), [DEST1]);
  assert.deepEqual(s.enviados().map((m) => m.jid), [DEST1]);
});

test('mesma mensagem: link sem esquema + link da prévia do mesmo produto → um envio só; mensagem com dois produtos não usa o texto', async () => {
  const s = montar();
  s.regra();
  s.estado.curtos['https://amzn.to/abc'] = URL_TERCEIRO;
  // o whatsapp.js anexa o link da prévia quando o texto só tem link sem esquema (decisão R9)
  assert.equal(s.receber(`Roteador barato\nPor R$ 999,00\namzn.to/abc\nhttps://www.amazon.com.br/dp/${ASIN}`), 2);
  await s.rodar();
  const [a, b] = s.itens();
  assert.equal(a.url, `https://www.amazon.com.br/dp/${ASIN}`, 'o link com ASIN vem primeiro (sem rede)');
  assert.deepEqual([a.status, b.status, b.motivo], ['enviado', 'duplicado', 'mesmo produto de outro link desta mensagem']);
  assert.equal(s.enviados().length, 2);
  assert.equal(s.fetchF.chamadas.filter((c) => c.url === 'https://amzn.to/abc').length, 1, 'o encurtador é resolvido uma vez (cache)');
  // a mesma mensagem entregue de novo pelo WhatsApp não duplica (índice único)
  assert.equal(s.espelho.receber({ jid: ORIGEM, fromMe: false, texto: `x https://www.amazon.com.br/dp/${ASIN}`, msgId: 'MSG1', ts: s.relogio.t }), 0);

  const d = montar({ api: '403' });
  d.regra();
  d.receber('Produto A Por R$ 10,00 https://www.amazon.com.br/dp/B0AAAAAAAA\nProduto B Por R$ 20,00 https://www.amazon.com.br/dp/B0BBBBBBBB');
  await d.rodar();
  assert.deepEqual(d.itens().map((i) => [i.status, i.motivo]), [
    ['na_fila', 'falta completar (sem título e preço: a mensagem tem mais de um produto)'],
    ['na_fila', 'falta completar (sem título e preço: a mensagem tem mais de um produto)'],
  ]);
});

// ------------------------------------------------------------------------------------------------ CA11, CA7

test('CA11: nada de número, e-mail ou participante em espelho_itens, log, console ou no que vai à tela; ASIN numérico intacto no link', async (t) => {
  // Relógio fixo: os timestamps (13 dígitos, em ms) vão para o banco, o log e a tela, e com o relógio real
  // um deles às vezes contém "5432" ou "99876" e a busca por dígitos de telefone acusava vazamento que não houve.
  t.mock.timers.enable({ apis: ['Date'], now: 1786000000000 });
  const espias = capturarConsole(t);
  const s = montar({ api: '403' });
  s.regra();
  const texto = [
    'Livro Clássico Capa Dura',
    'Por R$ 39,90',
    'Dúvidas: +55 (31) 99876-5432 ou 5531998765432@s.whatsapp.net, joao.silva@example.com',
    'https://www.amazon.com.br/Livro-Classico/dp/8535902775?qid=1730000000&ref=sr_1_1',
  ].join('\n');
  s.espelho.receber({ jid: ORIGEM, fromMe: false, texto, msgId: '3EB0C431D5A1B2C3D4E5', ts: s.relogio.t, participant: '5531998765432@s.whatsapp.net', pushName: 'João Silva' });
  await s.rodar();
  const it = s.item(1);
  assert.equal(it.status, 'enviado');
  assert.equal(it.url, 'https://www.amazon.com.br/dp/8535902775', 'a URL é lida antes da máscara: o ASIN só de dígitos sobrevive');
  assert.match(it.texto_origem, /Dúvidas: … ou …, …/);
  const proibidos = ['99876', '5432', '998765432', 'joao.silva', 'example.com', '1730000000', 'João Silva', '3EB0C431D5A1B2C3D4E5'];
  const banco = JSON.stringify(s.itens().map(({ msg_id, ...resto }) => resto)); // msg_id só no índice
  const log = JSON.stringify(s.logs());
  const tela = JSON.stringify([s.espelho.itens(), s.espelho.listar()]);
  for (const p of proibidos) {
    assert.ok(!banco.includes(p), `espelho_itens tem ${p}`);
    assert.ok(!log.includes(p), `log tem ${p}`);
    assert.ok(!tela.includes(p), `tela tem ${p}`);
    assert.ok(!textoDoConsole(espias).includes(p), `console tem ${p}`);
  }
  assert.ok(!Object.hasOwn(s.espelho.itens()[0], 'url') && !Object.hasOwn(s.espelho.itens()[0], 'texto_origem'), 'itens() não devolve url nem texto_origem');
  assert.ok(!Object.keys(it).some((k) => /participant|push/i.test(k)));
  for (const m of s.enviados()) assert.ok(m.text.endsWith('https://www.amazon.com.br/dp/8535902775?tag=pedro-20'), m.text);
  // texto longo: até 1000 caracteres guardados
  s.receber(`${'Oferta boa '.repeat(300)} https://www.amazon.com.br/dp/B0LONGO001`);
  assert.ok(s.item(2).texto_origem.length <= 1000);
});

test('CA7: credencial, segredo e token nunca em log, console, histórico ou listagem (API ok e credencial recusada)', async (t) => {
  const espias = capturarConsole(t);
  const s = montar();
  s.regra();
  s.receber(FIXTURES.linkCurto);
  await s.rodar();
  s.estado.api = '401';
  s.amazon.invalidarToken();
  s.receber(FIXTURES.linkLongo.replace(ASIN, 'B0OUTRO001'));
  await s.rodar();
  assert.deepEqual(s.itens().map((i) => [i.status, i.fonte_dados]), [['enviado', 'api+texto'], ['enviado', 'texto']]);
  assert.equal(s.item(2).motivo, MENSAGENS_AMAZON.credenciais_invalidas);
  semSegredo(JSON.stringify(s.logs()), 'log');
  semSegredo(JSON.stringify(s.itens()), 'espelho_itens');
  semSegredo(JSON.stringify([s.espelho.listar(), s.espelho.itens()]), 'listagem');
  semSegredo(textoDoConsole(espias), 'console');
  semSegredo(JSON.stringify(s.enviados()), 'WhatsApp');
  assert.ok(s.enviados().every((m) => !m.text.includes(TAG) || m.text.includes(`?tag=${TAG}`)), 'a tag só aparece dentro do link');
});

// ------------------------------------------------------------------------------------------------ CA12

test('CA12: fora da janela a oferta espera e sai ao abrir, com os dados consultados na hora', async () => {
  const s = montar();
  s.regra({ janela_inicio: '08:00', janela_fim: '22:00' });
  s.relogio.t = hoje(3);
  s.receber(FIXTURES.soLink);
  await s.rodar();
  let it = s.item(1);
  assert.deepEqual([it.status, it.espera_ate, it.tentativas, it.motivo], ['recebido', hoje(8), 0, 'aguardando o horário (abre às 08:00)']);
  assert.equal(s.enviados().length, 0);
  assert.equal(s.fetchF.chamadas.length, 0, 'nada consultado antes da hora');
  s.relogio.t = hoje(7, 59);
  assert.equal(await s.espelho.processarPendentes(s.relogio.t), 0);
  s.relogio.t = hoje(8);
  await s.rodar();
  it = s.item(1);
  assert.deepEqual([it.status, it.fonte_dados], ['enviado', 'api']);
  assert.equal(s.enviados().length, 2);
  // janela que vira a noite (22:00 → 02:00): 23:00 está dentro
  const n = montar();
  n.regra({ janela_inicio: '22:00', janela_fim: '02:00' });
  n.relogio.t = hoje(23);
  n.receber(FIXTURES.linkLongo); await n.rodar();
  assert.equal(n.item(1).status, 'enviado');
});

test('CA12: acima do máximo por hora o 11º item espera até a hora liberar, sem contar tentativa', async () => {
  const s = montar({ credenciais: false }); // sem API: dados do texto, sem rede
  s.regra();
  for (let i = 1; i <= 11; i++) s.receber(`Produto ${i}\nPor R$ ${i},00\nhttps://www.amazon.com.br/dp/B0TESTE${String(i).padStart(3, '0')}`);
  const t0 = s.relogio.t;
  await s.rodar();
  const itens = s.itens();
  assert.deepEqual(itens.slice(0, 10).map((i) => i.status), Array(10).fill('enviado'));
  assert.deepEqual([itens[10].status, itens[10].espera_ate, itens[10].tentativas], ['recebido', t0 + HORA, 0]);
  assert.match(itens[10].motivo, /^aguardando o máximo por hora \(sai às \d\d:\d\d\)$/);
  assert.equal(s.enviados().length, 20);
  s.relogio.t = t0 + HORA;
  await s.rodar();
  assert.equal(s.item(11).status, 'enviado');
  assert.equal(s.enviados().length, 22);
});

test('CA12: item parado por queda do serviço expira em 2 h (pela mensagem ou pela hora marcada)', async () => {
  const s = montar();
  s.regra();
  s.receber(FIXTURES.linkLongo, { ts: s.relogio.t - 3 * HORA });
  s.receber(FIXTURES.soLink);
  s.db.prepare('UPDATE espelho_itens SET espera_ate = ? WHERE id = 2').run(s.relogio.t - 2 * HORA - 1);
  await s.rodar();
  assert.deepEqual(s.itens().map((i) => i.status), ['expirado', 'expirado']);
  assert.equal(s.enviados().length, 0);
  assert.ok(s.logs().some((l) => l.message.startsWith('Descartada: ficou parada mais de 2 h')));
});

// ------------------------------------------------------------------------------------------------ fila, retenção, regras

test('expirarFila (mínimo 24 h), recuperar e limpar (guarda o que ainda conta para a deduplicação)', async () => {
  const s = montar({ api: '403' });
  const id = s.regra({ dedupe_horas: 0 });
  s.receber(FIXTURES.soLink);
  await s.rodar();
  assert.equal(s.item(1).status, 'na_fila');
  assert.equal(s.espelho.expirarFila(s.relogio.t + 23 * HORA), 0);
  assert.equal(s.espelho.expirarFila(s.relogio.t + 25 * HORA), 1);
  assert.deepEqual([s.item(1).status, s.item(1).motivo], ['expirado', 'expirou sem ser completada']);

  s.receber(FIXTURES.linkLongo);
  s.db.prepare("UPDATE espelho_itens SET status = 'processando' WHERE id = 2").run();
  assert.equal(s.espelho.recuperar(), 1);
  assert.equal(s.item(2).status, 'recebido');
  await s.rodar();
  assert.equal(s.item(2).status, 'enviado');

  // limpar: decididos há mais de N dias somem; 'enviado' dentro da janela de deduplicação fica
  s.espelho.atualizar(id, { nome: 'x', origem_jids: [ORIGEM], destino_jids: [DEST1], template_id: s.tplAmazon, dedupe_horas: 8760 });
  const velho = s.relogio.t - 40 * 86400000;
  s.db.prepare('UPDATE espelho_itens SET decidido_em = ?').run(velho);
  assert.deepEqual(s.espelho.limpar(0, s.relogio.t), { itens: 0 });
  assert.deepEqual(s.espelho.limpar(30, s.relogio.t), { itens: 1 });
  assert.deepEqual(s.itens().map((i) => i.id), [2]);
  s.espelho.atualizar(id, { nome: 'x', origem_jids: [ORIGEM], destino_jids: [DEST1], template_id: s.tplAmazon, dedupe_horas: 24 });
  assert.deepEqual(s.espelho.limpar(30, s.relogio.t), { itens: 1 });
});

test('CRUD: validações, padrões, listar com contadores e problema, apagar leva os itens', async () => {
  const s = montar();
  const base = { nome: 'Regra', origem_jids: [ORIGEM], destino_jids: [DEST1], template_id: s.tplAmazon };
  const erro = (extra, re) => assert.throws(() => s.espelho.criar({ ...base, ...extra }), (e) => e instanceof ErroEspelho && e.status === 400 && re.test(e.message), re.source);
  erro({ nome: '  ' }, /^Dê um nome ao espelhamento\.$/);
  erro({ nome: 'x'.repeat(81) }, /passa de 80/);
  erro({ origem_jids: [] }, /^Marque ao menos um grupo de origem\.$/);
  erro({ destino_jids: [] }, /^Marque ao menos um grupo de destino\.$/);
  erro({ destino_jids: ['999@g.us'] }, /não existe mais/);
  erro({ template_id: 9999 }, /^Escolha um template\.$/);
  const semLink = Number(s.db.prepare("INSERT INTO templates (name, body, created_at) VALUES ('Sem link', '*{TITULO_PRODUTO}*', 1)").run().lastInsertRowid);
  erro({ template_id: semLink }, /^O template precisa do campo \{LINK\}\.$/);
  erro({ dedupe_horas: 8761 }, /Horas sem repetir/);
  erro({ dedupe_horas: -1 }, /Horas sem repetir/);
  erro({ max_por_hora: 61 }, /Máximo por hora/);
  erro({ janela_inicio: '08:00' }, /início e o fim/);
  erro({ janela_inicio: '25:00', janela_fim: '08:00' }, /Horário inválido/);
  erro({ palavras_bloqueadas: ['x'.repeat(61)] }, /mais de 60 caracteres/);
  erro({ palavras_bloqueadas: Array.from({ length: 51 }, (_, i) => `p${i}`) }, /até 50/);
  erro({ sem_preco: 'talvez' }, /Quando faltar o preço/);
  erro({ incluir_minhas: 'sim' }, /ligue ou desligue/);

  const id = s.espelho.criar({ ...base, janela_inicio: '8:05', janela_fim: '08:05' }).id; // início = fim: o dia todo
  const [r] = s.espelho.listar().espelhos;
  assert.deepEqual({ ...r, contadores_24h: null }, {
    id, nome: 'Regra', enabled: true, origem_jids: [ORIGEM], origens_nomes: ['Ofertas Origem'], destino_jids: [DEST1], destinos_nomes: ['Achadinhos Tech'],
    template_id: s.tplAmazon, template_nome: 'Amazon', incluir_minhas: false, dedupe_horas: 168, palavras_bloqueadas: [], sem_preco: 'fila',
    max_por_hora: 10, janela_inicio: '08:05', janela_fim: '08:05', enviar_foto: true, problema: null, contadores_24h: null,
  });
  assert.deepEqual(s.espelho.ativar(id, false), { ok: true, enabled: false });
  assert.throws(() => s.espelho.ativar(id, 'sim'), /ligue ou desligue/);
  assert.throws(() => s.espelho.ativar(999, true), (e) => e.status === 404);
  s.espelho.ativar(id, true);

  // contadores e problema: o número saiu do grupo de origem (o nome vem do item guardado)
  s.receber(FIXTURES.linkLongo);
  await s.rodar();
  s.db.prepare('DELETE FROM groups WHERE jid = ?').run(ORIGEM);
  const l = s.espelho.listar();
  assert.deepEqual(l.totais_24h, { espelhadas: 1, descartadas: 0, na_fila: 0 });
  assert.equal(l.espelhos[0].problema, 'O número saiu do grupo Ofertas Origem. Edite o espelhamento.');
  assert.deepEqual(l.espelhos[0].origens_nomes, ['(grupo removido)']);
  assert.equal(l.amazon.acesso, 'ok');
  assert.throws(() => s.espelho.atualizar(id, base), /não existe mais/, 'salvar exige os grupos existentes');

  assert.deepEqual(s.espelho.apagar(id), { ok: true });
  assert.equal(s.itens().length, 0, 'apagar leva os itens (e o texto guardado)');
  assert.equal(s.espelho.listar().espelhos.length, 0);
  assert.equal(s.espelho.receber({ jid: DEST1, fromMe: false, texto: FIXTURES.linkLongo, msgId: 'Z', ts: s.relogio.t }), 0);
});

test('itens: cursor, filtro na_fila, destinos com o resultado do envio; regra desligada descarta o que não foi decidido', async () => {
  const s = montar({ api: '403' });
  const id = s.regra();
  s.receber(FIXTURES.soLink);
  s.receber(FIXTURES.linkLongo.replace(ASIN, 'B0SEGUND01'));
  s.receber(FIXTURES.linkLongo.replace(ASIN, 'B0TERCEI01'));
  await s.rodar();
  assert.deepEqual(s.espelho.itens({ limite: 2 }).map((i) => i.id), [3, 2]);
  assert.deepEqual(s.espelho.itens({ antes: 2 }).map((i) => i.id), [1]);
  assert.deepEqual(s.espelho.itens({ status: 'na_fila', espelho: id }).map((i) => i.id), [1]);
  assert.deepEqual(s.espelho.itens({ espelho: 999 }), []);
  assert.throws(() => s.espelho.itens({ status: 'x' }), (e) => e.status === 400);
  const [tres] = s.espelho.itens({ limite: 1 });
  assert.deepEqual(tres.destinos, [{ nome: 'Achadinhos Tech', ok: true, erro: null }, { nome: 'Tech Dois', ok: true, erro: null }]);
  assert.equal(tres.oferta.title, 'Roteador Mesh TP-Link Deco BE22, Wi-Fi 7, Pack com 3 Unidades');
  assert.ok(!('link' in tres.oferta));

  s.receber(FIXTURES.linkLongo.replace(ASIN, 'B0QUARTO01'));
  s.espelho.ativar(id, false);
  await s.rodar();
  assert.deepEqual([s.item(4).status, s.item(4).motivo], ['descartado', 'o espelhamento foi desligado']);
  assert.equal(s.espelho.receber({ jid: ORIGEM, fromMe: false, texto: FIXTURES.linkLongo, msgId: 'Y', ts: s.relogio.t }), 0, 'desligado não recebe');
});

test('testar: diz o que faria (com a tag mascarada) sem gravar, sem enviar e sem log', async () => {
  const s = montar();
  const id = s.regra({ palavras_bloqueadas: ['vitrine'] });
  const contar = () => ['espelho_itens', 'envios', 'log'].map((t) => s.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n);
  const antes = contar();
  const r = await s.espelho.testar(id, { texto: FIXTURES.linkCurto });
  assert.deepEqual({ ...r, texto: null }, {
    links: [URL_CURTO], asin: ASIN, fonte_dados: 'api+texto', decisao: 'enviar', motivo: null, texto: null,
    oferta: { title: TITULO_API, price: 1310.05, oldPrice: 1999, discountPct: 34, sold: 200, freeShipping: true, coupon: null, image: IMG },
  });
  assert.ok(r.texto.endsWith(`Compre aqui: https://www.amazon.com.br/dp/${ASIN}?tag=•••`), r.texto);
  assert.ok(!r.texto.includes(TAG));
  assert.equal((await s.espelho.testar(id, { texto: 'Peça de vitrine https://www.amazon.com.br/dp/B0VITRINE1' })).decisao, 'descartado');
  assert.deepEqual(await s.espelho.testar(id, { texto: `x https://www.amazon.com.br/dp/${ASIN}?tag=${TAG}` }),
    { links: [], asin: null, fonte_dados: null, oferta: null, texto: null, decisao: 'ignorado', motivo: 'o link já leva a sua tag (não é espelhado)' });
  assert.equal((await s.espelho.testar(id, { texto: 'nada' })).decisao, 'ignorado');
  await assert.rejects(s.espelho.testar(id, { texto: '' }), /Cole uma mensagem/);
  await assert.rejects(s.espelho.testar(id, { texto: 'x'.repeat(4097) }), /passa de 4096/);
  await assert.rejects(s.espelho.testar(999, { texto: 'x' }), (e) => e.status === 404);
  assert.deepEqual(contar(), antes);
  assert.equal(s.enviados().length, 0);
});

test('receber: teto de links por regra e grupo por hora (membro hostil não multiplica consultas), com um aviso só no log', () => {
  const s = montar();
  s.regra();
  let gravados = 0;
  for (let i = 0; i < 70; i++) gravados += s.receber(`https://amzn.to/x${i}`);
  assert.equal(gravados, 60);
  assert.equal(s.logs().filter((l) => /Mais de 60 links da Amazon em 1 hora/.test(l.message)).length, 1);
  s.relogio.t += HORA + 1;
  assert.equal(s.receber('https://amzn.to/depois'), 1);
});

test('sem o cliente da Amazon: o item não sai e o motivo diz por quê; receber nunca lança', async (t) => {
  const espias = capturarConsole(t);
  const s = montar({ comAmazon: false });
  s.db.prepare(`INSERT INTO espelhos (nome, origem_jids, destino_jids, template_id) VALUES ('Sem Amazon', ?, ?, ?)`)
    .run(JSON.stringify([ORIGEM]), JSON.stringify([DEST1]), s.tplAmazon);
  s.receber(FIXTURES.linkLongo);
  await s.rodar();
  assert.deepEqual([s.item(1).status, s.item(1).motivo], ['erro', 'A integração com a Amazon não está disponível neste servidor.']);
  assert.equal(s.espelho.receber(null), 0);
  assert.equal(s.espelho.receber({ jid: ORIGEM, texto: 5, msgId: 'a' }), 0);
  assert.throws(() => s.espelho.criar({ nome: 'x', origem_jids: [ORIGEM], destino_jids: [DEST1], template_id: s.tplAmazon }), /não está disponível/);
  assert.equal(textoDoConsole(espias), '');
});

// ------------------------------------------------------------------------------------------------ rotas

function pedir(port, metodo, caminho, corpo) {
  return new Promise((ok, err) => {
    const data = corpo == null ? null : Buffer.from(JSON.stringify(corpo));
    const r = http.request({ host: '127.0.0.1', port, path: caminho, method: metodo, headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {} }, (res) => {
      let txt = ''; res.on('data', (c) => { txt += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(txt); } catch { /* texto */ } ok({ status: res.statusCode, txt, json }); });
    });
    r.on('error', err); if (data) r.write(data); r.end();
  });
}

async function servidor(scheduler) {
  const app = express();
  app.use(express.json());
  montarRotas(app, { scheduler });
  const srv = await new Promise((ok) => { const x = app.listen(0, '127.0.0.1', () => ok(x)); });
  return { port: srv.address().port, fechar: () => new Promise((ok) => srv.close(ok)) };
}

test('rotas: contrato, 404/409, sem texto da origem nem URL; falha inesperada vira 500 sem a mensagem; sem espelho, 503', async (t) => {
  const espias = capturarConsole(t);
  const s = montar({ api: '403' });
  const srv = await servidor({ espelho: s.espelho });
  try {
    let r = await pedir(srv.port, 'POST', '/api/espelhos', { nome: 'Rota', origem_jids: [ORIGEM], destino_jids: [DEST1], template_id: s.tplAmazon });
    assert.equal(r.status, 200, r.txt);
    const id = r.json.id;
    r = await pedir(srv.port, 'POST', '/api/espelhos', { nome: '' });
    assert.deepEqual([r.status, r.json], [400, { erro: 'Dê um nome ao espelhamento.' }]);
    s.receber(`Dúvidas 31 99876-5432\n${FIXTURES.soLink}`);
    await s.rodar();
    r = await pedir(srv.port, 'GET', `/api/espelhos/itens?espelho=${id}&status=na_fila`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.map((i) => [i.id, i.status]), [[1, 'na_fila']]);
    assert.doesNotMatch(r.txt, /texto_origem|"url"|link\.amazon|99876|5432/);
    r = await pedir(srv.port, 'GET', '/api/espelhos');
    assert.equal(r.status, 200);
    assert.equal(r.json.espelhos[0].contadores_24h.na_fila, 1);
    assert.equal(r.json.amazon.acesso, 'sem_acesso');
    semSegredo(r.txt, 'GET /api/espelhos');
    r = await pedir(srv.port, 'POST', `/api/espelhos/${id}/testar`, { texto: FIXTURES.linkLongo });
    assert.deepEqual([r.status, r.json.decisao, r.json.fonte_dados], [200, 'enviar', 'texto']);
    r = await pedir(srv.port, 'POST', '/api/espelhos/itens/1/enviar', { ajustes: { title: 'Roteador', price: '999' } });
    assert.equal(r.status, 200, r.txt);
    r = await pedir(srv.port, 'POST', '/api/espelhos/itens/1/enviar', { ajustes: { title: 'Roteador', price: '999' } });
    assert.deepEqual([r.status, r.json], [409, { erro: 'Esta oferta já foi tratada.' }]);
    r = await pedir(srv.port, 'POST', '/api/espelhos/itens/1/descartar');
    assert.equal(r.status, 409);
    r = await pedir(srv.port, 'POST', '/api/espelhos/itens/77/descartar');
    assert.deepEqual([r.status, r.json], [404, { erro: 'Oferta não encontrada.' }]);
    r = await pedir(srv.port, 'POST', `/api/espelhos/${id}/enabled`, { enabled: false });
    assert.deepEqual([r.status, r.json], [200, { ok: true, enabled: false }]);
    r = await pedir(srv.port, 'PUT', `/api/espelhos/${id}`, { nome: 'Rota 2', origem_jids: [ORIGEM], destino_jids: [DEST2], template_id: s.tplAmazon });
    assert.equal(r.status, 200, r.txt);
    r = await pedir(srv.port, 'DELETE', `/api/espelhos/${id}`);
    assert.deepEqual([r.status, r.json], [200, { ok: true }]);
    r = await pedir(srv.port, 'DELETE', '/api/espelhos/abc');
    assert.equal(r.status, 404);
  } finally { await srv.fechar(); }

  // erro inesperado (ex.: do banco, com valores da query na mensagem): 500 genérico, nada da mensagem em lugar nenhum
  const quebrado = await servidor({ espelho: { listar() { throw new Error('SQLITE_ERROR: valores 5531998765432 joao@example.com'); } } });
  try {
    const r = await pedir(quebrado.port, 'GET', '/api/espelhos');
    assert.deepEqual([r.status, r.json], [500, { erro: 'Não consegui concluir. Tente de novo.' }]);
  } finally { await quebrado.fechar(); }
  assert.doesNotMatch(textoDoConsole(espias), /5531998765432|joao@|SQLITE_ERROR: valores/);

  const vazio = await servidor({});
  try {
    const r = await pedir(vazio.port, 'GET', '/api/espelhos');
    assert.equal(r.status, 503);
  } finally { await vazio.fechar(); }
});

// ------------------------------------------------------------------------------------------------ etapa 13: ligação

/** Espera `cond()` ficar verdadeira (até `ms`). → o último valor de cond() */
async function esperarAte(cond, ms = 6000) {
  for (const fim = Date.now() + ms; !cond() && Date.now() < fim;) await new Promise((ok) => setTimeout(ok, 20));
  return cond();
}
/** Mensagem de grupo como o Baileys entrega no messages.upsert. */
const upsert = (texto, id, { jid = ORIGEM, fromMe = false } = {}) => ({
  type: 'notify', messages: [{ key: { remoteJid: jid, fromMe, id }, message: { conversation: texto }, messageTimestamp: Math.floor(Date.now() / 1000) }],
});

test('etapa 13: o tick roda envios → espelho (expira a fila, decide) → avisos → regras; espelho e envios de novo depois de cada regra e quando chega mensagem no meio do tick; start() recupera o espelho', async () => {
  const dir = tmp();
  const db = openDb(dir);
  for (const [jid, nome] of GRUPOS) db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, nome, 10, Date.now());
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const estado = { api: 'ok', itens: {}, curtos: { [URL_CURTO]: URL_TERCEIRO } };
  const amazon = createAmazon({ db, fetch: fetchAmazon(estado), esperar: async () => {}, lerConexao: () => ({ tag: TAG, credencial_versao: '3.1', credencial_id: CRED_ID, credencial_secret: SEGREDO }) });
  const ordem = [];
  // regra do Mercado Livre que roda e não acha nada: só marca a posição dela na ordem
  const ml = { candidates: async () => { ordem.push('regra'); return []; } };
  const scheduler = createScheduler({ db, wa, links, ml, fast: true, dir, amazon });
  assert.equal(scheduler.espelho.receber({ jid: ORIGEM, texto: FIXTURES.soLink, msgId: 'sem-regra' }), 0, 'o agendador expõe o espelho');
  db.prepare("INSERT INTO tags (name, created_at) VALUES ('etiquetaA', 1)").run();
  db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id, group_jids, source_type, source_config, per_run, interval_min, window_start, window_end, dedupe_days, send_image, created_at)
    VALUES ('ML', 1, 1, 1, ?, 'list', '{}', 1, 60, '00:00', '00:00', 7, 1, 1)`).run(JSON.stringify([DEST1]));
  const tpl = db.prepare("SELECT id FROM templates WHERE name = 'Amazon'").get().id;
  const espId = scheduler.espelho.criar({ nome: 'Ordem', origem_jids: [ORIGEM], destino_jids: [DEST1, DEST2], template_id: tpl }).id;
  // item esquecido na fila há 200 h (dedupe 168 h): o tick o expira
  const velho = Date.now() - 200 * HORA;
  db.prepare("INSERT INTO espelho_itens (espelho_id, origem_jid, msg_id, ts, url, asin, status, decidido_em) VALUES (?, ?, 'velho', ?, ?, ?, 'na_fila', ?)")
    .run(espId, ORIGEM, velho, `https://www.amazon.com.br/dp/${ASIN}`, ASIN, velho);

  const espiar = (obj, nome, rotulo) => { const real = obj[nome]; obj[nome] = (...a) => { ordem.push(rotulo); return real(...a); }; };
  espiar(scheduler.envios, 'processarPendentes', 'envios');
  espiar(scheduler.espelho, 'expirarFila', 'expirar');
  espiar(scheduler.espelho, 'processarPendentes', 'espelho');
  let noAviso = () => {};
  scheduler.avisos.tick = async () => { ordem.push('avisos'); noAviso(); };

  await scheduler.tick();
  assert.deepEqual(ordem, ['envios', 'expirar', 'espelho', 'avisos', 'regra', 'espelho', 'envios']);
  assert.deepEqual([db.prepare("SELECT status FROM espelho_itens WHERE msg_id = 'velho'").get().status], ['expirado']);

  // mensagem nova chega no meio do tick (o ouvinte é síncrono): o espelho decide e a oferta sai antes do tick acabar
  wa.onMensagem((m) => scheduler.espelho.receber(m));
  noAviso = () => { noAviso = () => {}; wa._onMensagens(upsert(FIXTURES.soLink, 'MEIO1')); };
  ordem.length = 0;
  await scheduler.tick();
  // a regra ML só volta daqui a 60 min; espelho cria o envio (acorda de novo) → envios manda → uma volta vazia
  assert.deepEqual(ordem, ['envios', 'expirar', 'espelho', 'avisos', 'espelho', 'envios', 'espelho', 'envios']);
  assert.deepEqual(wa.simulated.map((m) => [m.tipo, m.jid]).sort(), [['image', DEST1], ['image', DEST2]]);
  assert.ok(wa.simulated.every((m) => m.text.endsWith(LINK_LIMPO)));

  // start(): o que ficou 'processando' (serviço caiu no meio) volta a 'recebido' antes do primeiro tick
  db.prepare("UPDATE espelho_itens SET status = 'processando' WHERE msg_id = 'MEIO1'").run();
  scheduler.start(); scheduler.stop();
  assert.equal(db.prepare("SELECT status FROM espelho_itens WHERE msg_id = 'MEIO1'").get().status, 'recebido');
  db.close();
});

test('etapa 13 (CA11): falha no passo do espelho não para o tick e vai ao console só pelo código, sem a mensagem', async (t) => {
  const espias = capturarConsole(t);
  const dir = tmp();
  const db = openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const scheduler = createScheduler({ db, wa, links: createLinkService({ getMode: () => 'fake' }), fast: true, dir });
  const ordem = [];
  const falha = () => { throw Object.assign(new Error('SQLITE_ERROR: valores 5531998765432 joao@example.com'), { code: 'ERR_SQLITE_ERROR' }); };
  scheduler.espelho.expirarFila = falha;
  scheduler.espelho.processarPendentes = async () => falha();
  scheduler.avisos.tick = async () => { ordem.push('avisos'); };
  await scheduler.tick();
  assert.deepEqual(ordem, ['avisos'], 'o tick seguiu');
  const saida = textoDoConsole(espias);
  assert.match(saida, /\[agendador\] espelho \(fila\): ERR_SQLITE_ERROR/);
  assert.match(saida, /\[agendador\] espelho: ERR_SQLITE_ERROR/);
  assert.doesNotMatch(saida, /5531998765432|joao@|valores/);
  db.close();
});

test('etapa 13 (CA1, CA7, CA9, CA11): servidor de verdade: mensagem do grupo de origem → tick → imagem com legenda em cada destino; /api/state e /api/espelhos sem segredo', async (t) => {
  const espias = capturarConsole(t);
  const dir = tmp();
  const db = openDb(dir);
  for (const [jid, nome] of GRUPOS) db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, nome, 10, Date.now());
  // a conexão salva no banco, como o painel grava (tag e versão em config; ID e segredo em segredos)
  db.prepare("INSERT INTO conexoes (plataforma, config, segredos, updated_at) VALUES ('amazon', ?, ?, ?)")
    .run(JSON.stringify({ tag: TAG, credencial_versao: '3.1' }), JSON.stringify({ credencial_id: CRED_ID, credencial_secret: SEGREDO }), Date.now());
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const outro = 'B0OUTRO123';
  const estado = { api: 'ok', itens: {}, curtos: { [URL_CURTO]: URL_TERCEIRO, 'https://amzn.to/outro': `https://www.amazon.com.br/dp/${outro}?tag=terceiro-20` } };
  const fetchF = fetchAmazon(estado);
  // o mesmo caminho do main de src/server.js: criarServicos liga o ouvinte do WhatsApp ao espelho
  const { amazon, scheduler } = criarServicos({ db, wa, links, fast: true, dir, fetch: fetchF });
  const app = buildApp({ db, wa, links, scheduler, amazon, publicHost: '', panelPassword: '', dataDir: dir });
  const server = await new Promise((ok) => { const x = app.listen(0, '127.0.0.1', () => ok(x)); });
  const port = server.address().port;
  const ociosa = () => db.prepare("SELECT COUNT(*) AS n FROM envios WHERE status IN ('pendente', 'enviando')").get().n === 0
    && db.prepare("SELECT COUNT(*) AS n FROM espelho_itens WHERE status IN ('recebido', 'processando')").get().n === 0;
  try {
    const tpl = db.prepare("SELECT id FROM templates WHERE name = 'Amazon'").get().id;
    let r = await pedir(port, 'POST', '/api/espelhos', { nome: 'Amazon → Achadinhos', origem_jids: [ORIGEM], destino_jids: [DEST1, DEST2], template_id: tpl });
    assert.equal(r.status, 200, r.txt);

    // CA9: a mensagem do próprio número não entra (incluir_minhas desligado); a de outro membro entra
    wa._onMensagens(upsert(FIXTURES.soLink, 'MINHA1', { fromMe: true }));
    wa._onMensagens(upsert(FIXTURES.soLink, 'E2E1'));
    assert.ok(await esperarAte(() => wa.simulated.length >= 2 && ociosa()), 'a oferta espelhada saiu sem esperar o próximo tick de 15 s');
    const enviados = wa.simulated.filter((m) => m.jid !== 'status@broadcast');
    assert.deepEqual(enviados.map((m) => [m.tipo, m.jid]).sort(), [['image', DEST1], ['image', DEST2]], 'uma imagem por destino, nada na origem');
    for (const m of enviados) {
      assert.equal(m.image, IMG);
      assert.match(m.text, new RegExp(`^\\*${TITULO_API}\\*`));
      assert.match(m.text, /Por \*R\$ 1\.310,05\* \(34% OFF\)/);
      assert.ok(m.text.endsWith(`Compre aqui: ${LINK_LIMPO}`), m.text);
      assert.doesNotMatch(m.text, RASTREIO);
    }
    assert.deepEqual(db.prepare('SELECT msg_id, status, fonte_dados FROM espelho_itens ORDER BY id').all().map((i) => ({ ...i })),
      [{ msg_id: 'E2E1', status: 'enviado', fonte_dados: 'api' }]);

    // sem API (403) e só o link: vai para a fila do dono; /api/state conta
    estado.api = '403';
    wa._onMensagens(upsert('https://amzn.to/outro', 'E2E2'));
    assert.ok(await esperarAte(() => db.prepare("SELECT status FROM espelho_itens WHERE msg_id = 'E2E2'").get()?.status === 'na_fila' && ociosa()));
    assert.equal(wa.simulated.length, 2, 'nada saiu');

    r = await pedir(port, 'GET', '/api/state');
    assert.equal(r.status, 200);
    assert.equal(r.json.espelhos_na_fila, 1);
    assert.deepEqual(r.json.amostras, { amazon: SAMPLE_OFFER_AMAZON });
    semSegredo(r.txt, 'GET /api/state');
    r = await pedir(port, 'GET', '/api/espelhos');
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.espelhos.length, r.json.totais_24h], [1, { espelhadas: 1, descartadas: 0, na_fila: 1 }]);
    assert.equal(r.json.amazon.acesso, 'sem_acesso');
    semSegredo(r.txt, 'GET /api/espelhos');
    r = await pedir(port, 'GET', '/api/espelhos/itens');
    assert.deepEqual(r.json.map((i) => [i.status, i.asin]), [['na_fila', outro], ['enviado', ASIN]]);
    assert.equal(r.json[1].fonte_dados, 'api');
    assert.doesNotMatch(r.txt, /texto_origem|"url"|link\.amazon|amzn\.to|terceiro/);
    semSegredo(r.txt, 'GET /api/espelhos/itens');
    for (const l of db.prepare('SELECT message FROM log').all()) semSegredo(l.message, 'log');
  } finally {
    server.closeAllConnections?.(); await new Promise((ok) => server.close(ok));
    await esperarAte(ociosa, 2000); db.close();
  }
  semSegredo(textoDoConsole(espias), 'console');
  assert.equal(fetchF.chamadas.filter((c) => c.metodo === 'HEAD').length, 0);
});

// ------------------------------------------------------------------------------------------------ CA10

test('CA10: nenhum teste deste arquivo acessou a rede (o fetch global ficou bloqueado)', () => {
  assert.equal(acessosRede, 0);
});
