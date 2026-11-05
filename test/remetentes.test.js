// Envio pelo sócio (plano envio-pelo-socio, etapa 5; CA2 a CA10): o núcleo de src/remetentes.js.
// createRemetentes direto, com a fila de envios real (createEnvios, modo rápido), o WhatsApp em dryRun (o que "sai"
// fica em wa.simulated) e os links no modo `fake`. As 3 lojas: ML por um `ml` falso (página lida sem rede), Amazon e
// Shopee de verdade com fetch falso injetado. O fetch global fica bloqueado no arquivo inteiro e o último teste prova
// que ele nunca foi chamado. O relógio do módulo é injetado (limite por hora, repetição, expiração, respostas).
// O cadastro (etapa 6) ainda não existe: o remetente é gravado direto na tabela.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createLinkService } from '../src/links.js';
import { createEnvios } from '../src/envios.js';
import { createAmazon } from '../src/amazon.js';
import { createShopee, URL_API as URL_API_SHOPEE } from '../src/shopee.js';
import { extractItemId } from '../src/ml.js';
import { createRemetentes, RESPOSTAS } from '../src/remetentes.js';
import * as rastreio from '../src/rastreio.js';

let acessosRede = 0;
globalThis.fetch = async () => { acessosRede++; throw new Error('rede proibida no teste'); };

const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-rem-')); pastas.push(p); return p; };

const HORA = 3600000;
const NUMERO = '5535999991234';
const PN = `${NUMERO}@s.whatsapp.net`;
const LID = '207654321098765@lid';
const LID2 = '209999999999999@lid';
const OUTRO = '5511988887777@s.whatsapp.net';
const DEST1 = '200@g.us';
const DEST2 = '300@g.us';
const SUMIDO = '999@g.us'; // está nos destinos do remetente, mas o grupo não existe mais
const GRUPOS = [[DEST1, 'Achadinhos Tech'], [DEST2, 'Tech Dois']];
const NOME = 'Sócio Pedro';
const IMG = 'https://http2.mlstatic.com/D_NQ_NP_123-O.jpg';

// Mercado Livre
const URL_ML = 'https://produto.mercadolivre.com.br/MLB-1234567890-fone-bom-_JM';
const URL_ML2 = 'https://produto.mercadolivre.com.br/MLB-2222222222-caixa-de-som-_JM';
const URL_MELI = 'https://meli.la/1AbCdEf'; // o meli.la de outro afiliado: a página leva ao URL_ML
const mlN = (n) => `https://produto.mercadolivre.com.br/MLB-${3000000000 + n}-produto-${n}-_JM`;
// Amazon
const ASIN = 'B0FG2MD49G';
const TAG = 'pedro-20';
const URL_AMAZON = `https://www.amazon.com.br/Roteador-Mesh/dp/${ASIN}?tag=terceiro-20&crid=ABC123`;
const URL_BUSCA_AMAZON = 'https://amzn.to/busca1';
const IMG_AMAZON = 'https://m.media-amazon.com/images/I/71abcDEF.jpg';
const CRED_ID = 'credencial-id-0001';
const SEGREDO = 'segredo-super-secreto-123';
const TOKEN = 'token-oauth-secreto-xyz';
// Shopee
const ID_AF = '98765432101';
const SHOP = '52377417';
const ITEM = '6309028319';
const URL_SHOPEE = `https://shopee.com.br/Fone-Bom-Sem-Fio-i.${SHOP}.${ITEM}`;
const IMG_SHOPEE = 'https://down-br.img.susercontent.com/file/br-11134207-7r98o-abc123';
const LINK_SHOPEE = 'https://s.shopee.com.br/ApiLink123';
const CHAVE_SHOPEE = 'Senha-Api-SECRETA-q1w2e3';

const FRASES = {
  falhaEnvio: 'Não consegui enviar esse link para os grupos. O dono vai ver o motivo no painel.',
  montar: 'Não consegui montar esse link agora. O dono vai ver o motivo no painel.',
  semDados: 'Não consegui ler os dados desse produto. Mande o link junto com o nome e o preço.',
  linkInvalido: 'Não reconheci esse link. Mande o link da página do produto.',
  semLinkDeLoja: 'Não encontrei um link do Mercado Livre, Amazon ou Shopee nessa mensagem.',
  limite: 'Muitos links em pouco tempo. Tente de novo daqui a pouco.',
};

const respJson = (status, corpo) => new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } });

/** fetch falso da Amazon: o encurtador de busca (não é produto), o token e o GetItems. Guarda as URLs. */
function fetchAmazon() {
  const chamadas = [];
  const f = async (url, init = {}) => {
    const u = String(url);
    chamadas.push(u);
    if (u === URL_BUSCA_AMAZON) return new Response(null, { status: 302, headers: { location: 'https://www.amazon.com.br/s?k=fone' } });
    if (u === 'https://www.amazon.com.br/s?k=fone') return new Response('<html>busca</html>', { status: 200 });
    if (u === 'https://api.amazon.com/auth/o2/token') return respJson(200, { access_token: TOKEN, token_type: 'bearer', expires_in: 3600 });
    if (u === 'https://creatorsapi.amazon/catalog/v1/getItems') {
      return respJson(200, { itemsResult: { items: JSON.parse(init.body).itemIds.map((asin) => ({
        asin, detailPageURL: `https://www.amazon.com.br/dp/${asin}?tag=${TAG}`,
        itemInfo: { title: { displayValue: 'Roteador Mesh Wi-Fi 7' } },
        images: { primary: { large: { url: IMG_AMAZON, height: 500, width: 500 } } },
        offersV2: { listings: [{ isBuyBoxWinner: true, availability: { type: 'IN_STOCK' }, price: { money: { amount: 1310.05 } } }] },
      })) } });
    }
    throw new Error('rede não prevista no teste');
  };
  f.chamadas = chamadas;
  return f;
}

/**
 * fetch falso da Shopee: a Open API (produto e link curto; com Sub_id, `https://s.shopee.com.br/Sub<sub_id>`). Guarda
 * as URLs e, em `consultas`, as consultas da API. `f.antes(consulta)`, se houver, roda antes de cada resposta da API.
 */
function fetchShopee() {
  const chamadas = [];
  const consultas = [];
  const f = async (url, init = {}) => {
    const u = String(url);
    chamadas.push(u);
    if (u === URL_API_SHOPEE) {
      const consulta = JSON.parse(init.body).query;
      consultas.push(consulta);
      if (f.antes) await f.antes(consulta);
      if (consulta.startsWith('mutation')) {
        const sub = /subIds:\["(\w+)"\]/.exec(consulta)?.[1];
        return respJson(200, { data: { generateShortLink: { shortLink: sub ? `https://s.shopee.com.br/Sub${sub}` : LINK_SHOPEE } } });
      }
      return respJson(200, { data: { productOfferV2: { nodes: [{ itemId: Number(ITEM), productName: 'Fone Bom Sem Fio', priceMin: '89.90', priceMax: '99.90',
        priceDiscountRate: 15, sales: 1234, ratingStar: '4.83', imageUrl: IMG_SHOPEE, shopName: 'Loja Oficial' }] } } });
    }
    throw new Error('rede não prevista no teste');
  };
  f.chamadas = chamadas;
  f.consultas = consultas;
  f.antes = null;
  return f;
}

/**
 * ML falso: a página de cada link. estado.mlDestino: link → produto achado (o meli.la); estado.mlCampos: produto →
 * campos que trocam os padrões (price: null = a página não informa o preço); estado.mlEspera: promessa que segura a
 * leitura (concorrência).
 */
function mlFalso(estado) {
  const chamadas = [];
  return {
    chamadas,
    async resolveOffer(c) {
      chamadas.push(c.url);
      if (estado.mlEspera) await estado.mlEspera;
      const destino = estado.mlDestino[c.url] ?? c.url;
      return { key: extractItemId(destino) ?? c.key, url: destino, title: 'Fone Bom', price: 89.9, oldPrice: null, discountPct: null,
        sold: 1200, freeShipping: false, image: IMG, ...(estado.mlCampos[destino] ?? {}) };
    },
  };
}

/** Banco com 2 grupos e 1 etiqueta, WhatsApp simulado, as 3 lojas, a fila de envios real e o módulo com relógio próprio. */
function montar({ modo = 'fake' } = {}) {
  const dir = tmp();
  const db = openDb(dir);
  for (const [jid, nome] of GRUPOS) db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, nome, 10, Date.now());
  db.prepare("INSERT INTO tags (name, created_at) VALUES ('etiquetaA', 1)").run();
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const estado = { modo, mlDestino: { [URL_MELI]: URL_ML }, mlCampos: {}, mlEspera: null };
  const links = createLinkService({ getMode: () => estado.modo });
  const ml = mlFalso(estado);
  const conexaoAmazon = { tag: TAG, credencial_versao: '3.1', credencial_id: CRED_ID, credencial_secret: SEGREDO };
  const fetchA = fetchAmazon();
  const amazon = createAmazon({ db, fetch: fetchA, esperar: async () => {}, lerConexao: () => conexaoAmazon });
  db.prepare("INSERT INTO conexoes (plataforma, config, segredos, updated_at) VALUES ('shopee', ?, ?, ?)")
    .run(JSON.stringify({ id_afiliado: ID_AF, app_id: '123456789' }), JSON.stringify({ chave: CHAVE_SHOPEE }), Date.now());
  const fetchS = fetchShopee();
  const shopee = createShopee({ db, fetch: fetchS });
  const envios = createEnvios({ db, wa, links, ml, fast: true, dir, amazon, shopee });
  const relogio = { t: Date.now() };
  const acordou = { n: 0 };
  const criar = () => createRemetentes({ db, wa, envios, acordar: () => { acordou.n++; }, agora: () => relogio.t });
  const rem = criar();
  let seq = 0;
  const s = {
    dir, db, wa, envios, estado, ml, fetchA, fetchS, conexaoAmazon, relogio, acordou, rem, criar,
    /** Remetente gravado direto (o cadastro é a etapa 6). → id */
    cadastrar(extra = {}) {
      const r = { nome: NOME, jid: PN, lid: null, enabled: 1, destino_jids: JSON.stringify([DEST1, DEST2, SUMIDO]), template_id: 1, tag_id: null,
        enviar_foto: 1, max_por_hora: 10, dedupe_horas: 24, responder: 1, ...extra };
      return Number(db.prepare(`INSERT INTO remetentes (nome, jid, lid, enabled, destino_jids, template_id, tag_id, enviar_foto, max_por_hora,
        dedupe_horas, responder, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(r.nome, r.jid, r.lid, r.enabled, r.destino_jids, r.template_id, r.tag_id, r.enviar_foto, r.max_por_hora, r.dedupe_horas, r.responder, 1, 1).lastInsertRowid);
    },
    /** Mensagem privada como o ouvinte do whatsapp.js entrega. → itens gravados */
    msg: (texto, o = {}) => rem.receber({ ids: [PN], texto, msgId: `MSG${++seq}`, ts: relogio.t, ...o }),
    /** Um passo do módulo, um da fila de envios e as respostas, no relógio do teste. */
    async rodar(r = rem) {
      const n = await r.processarPendentes(relogio.t);
      await envios.processarPendentes(relogio.t);
      await r.responderPendentes(relogio.t);
      return n;
    },
    itens: () => db.prepare('SELECT * FROM remetente_itens ORDER BY id').all().map((x) => ({ ...x })),
    item: (id) => ({ ...db.prepare('SELECT * FROM remetente_itens WHERE id = ?').get(id) }),
    gravados: () => db.prepare('SELECT * FROM envios ORDER BY id').all().map((x) => ({ ...x, payload: JSON.parse(x.payload), group_jids: JSON.parse(x.group_jids) })),
    logs: () => db.prepare('SELECT * FROM log ORDER BY id').all().map((x) => ({ ...x })),
    remetente: (id) => ({ ...db.prepare('SELECT * FROM remetentes WHERE id = ?').get(id) }),
    /** O que foi aos grupos. */
    nosGrupos: () => wa.simulated.filter((m) => m.jid.endsWith('@g.us')),
    /** As respostas ao remetente, já conferidas (CA8): sem link, número, nome de grupo nem texto recebido. */
    respostas() {
      const r = wa.simulated.filter((m) => !m.jid.endsWith('@g.us'));
      for (const m of r) {
        assert.equal(m.jid, PN, 'a resposta vai ao número cadastrado');
        assert.equal(m.tipo, 'text');
        assert.doesNotMatch(m.text, /http|www\.|meli\.la|\.com|@/i, `resposta com link: ${m.text}`);
        assert.ok(!m.text.includes(NUMERO) && !m.text.includes(NUMERO.slice(-8)), `resposta com o número: ${m.text}`);
        for (const [, nome] of GRUPOS) assert.ok(!m.text.includes(nome), `resposta com nome de grupo: ${m.text}`);
      }
      return r.map((m) => m.text);
    },
  };
  return s;
}

/** Troca os envios do WhatsApp simulado para falharem nos jids pedidos (com o jid na mensagem, como uma biblioteca faria). */
function falharEm(s, jids) {
  const { sendText, sendImage } = s.wa;
  s.wa.sendText = async (jid, ...r) => { if (jids.includes(jid)) throw new Error(`falha ao enviar para ${jid} (+${NUMERO})`); return sendText(jid, ...r); };
  s.wa.sendImage = async (jid, ...r) => { if (jids.includes(jid)) throw new Error(`falha ao enviar para ${jid}`); return sendImage(jid, ...r); };
}

const capturarConsole = (t) => ['error', 'warn', 'log', 'info'].map((m) => t.mock.method(console, m, () => {}));
const textoDoConsole = (espias) => espias.flatMap((e) => e.mock.calls.map((c) => c.arguments.map(String).join(' '))).join('\n');
/** Todo texto guardado no banco (log, itens, envios, resultados), para procurar dado pessoal. */
const tudoNoBanco = (db) => ['log', 'remetente_itens', 'envios', 'envio_resultados'].map((t) => JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all())).join('\n');
const statusDe = (it) => [it.status, it.codigo];

// ------------------------------------------------------------------------------------------------ CA2

test('CA2: número de fora, mensagem minha, remetente desligado, mensagem sem link e entrada inválida: nenhum item, resposta nem log', async (t) => {
  const espias = capturarConsole(t);
  const s = montar();
  const desligado = s.cadastrar({ enabled: 0, jid: OUTRO, lid: LID2 });
  s.cadastrar();
  assert.equal(s.msg(`Olha esse ${URL_ML}`, { ids: ['5531977776666@s.whatsapp.net'] }), 0, 'número de fora');
  assert.equal(s.msg(`Olha esse ${URL_ML}`, { ids: ['207000000000001@lid'] }), 0, 'LID de fora');
  assert.equal(s.msg(`Olha esse ${URL_ML}`, { fromMe: true }), 0, 'mensagem minha');
  assert.equal(s.msg(`Olha esse ${URL_ML}`, { ids: [OUTRO] }), 0, 'remetente desligado (pelo número)');
  assert.equal(s.msg(`Olha esse ${URL_ML}`, { ids: [LID2] }), 0, 'remetente desligado (pelo LID)');
  assert.equal(s.msg('Bom dia! Sem link hoje.'), 0, 'mensagem sem link não vira item');
  assert.equal(s.msg(`Antiga ${URL_ML}`, { ts: s.relogio.t - 2 * HORA - 60000 }), 0, 'mensagem com mais de 2 h');
  for (const lixo of [null, undefined, 'x', {}, { ids: PN, texto: URL_ML, msgId: 'A' }, { ids: [PN], texto: URL_ML, msgId: '' },
    { ids: [PN], texto: URL_ML, msgId: 'x'.repeat(300) }, { ids: [PN], texto: 42, msgId: 'B' }, { ids: [42, null], texto: URL_ML, msgId: 'C' },
    { ids: ['5535999991234'], texto: URL_ML, msgId: 'D' }, { ids: ['120363000000000000@g.us'], texto: URL_ML, msgId: 'E' }]) {
    assert.equal(s.rem.receber(lixo), 0, JSON.stringify(lixo));
  }
  await s.rodar();
  assert.deepEqual(s.itens(), []);
  assert.deepEqual(s.logs(), []);
  assert.deepEqual(s.respostas(), []);
  assert.equal(s.acordou.n, 0);
  assert.equal(s.remetente(desligado).lid, LID2, 'nada mudou no remetente desligado');
  assert.equal(textoDoConsole(espias), '');
});

test('CA2: a mensagem que chega do próprio número conectado é ignorada', async () => {
  const s = montar();
  s.cadastrar();
  s.wa.meuJid = () => PN; // o dono cadastrou o próprio número por engano (o cadastro recusa: etapa 6)
  assert.equal(s.msg(URL_ML), 0);
  assert.deepEqual(s.itens(), []);
});

// ------------------------------------------------------------------------------------------------ CA3

test('CA3/D2: casou pelo número com LID na mensagem → aprende o LID; depois casa só pelo LID; casou só pelo LID → não mexe', async () => {
  const s = montar();
  const id = s.cadastrar();
  assert.equal(s.msg(URL_ML, { ids: [LID, PN] }), 1);
  assert.equal(s.remetente(id).lid, LID, 'aprendeu o LID');
  assert.equal(s.msg(URL_ML2, { ids: [LID] }), 1, 'só o LID guardado');
  // o LID casou, mas o número que veio junto é outro: aceita (casou pelo LID) e não troca nada
  assert.equal(s.msg(mlN(1), { ids: [LID, OUTRO] }), 1);
  assert.deepEqual([s.remetente(id).jid, s.remetente(id).lid], [PN, LID]);
  // casou pelo número com outro LID: o LID novo vale (o Baileys trocou)
  assert.equal(s.msg(mlN(2), { ids: [LID2, PN] }), 1);
  assert.equal(s.remetente(id).lid, LID2);
});

test('CA3/D2: remetente desligado não aprende o LID; LID que já é de outro remetente não é tomado (sem lançar)', async (t) => {
  const espias = capturarConsole(t);
  const s = montar();
  const desligado = s.cadastrar({ enabled: 0 });
  assert.equal(s.msg(URL_ML, { ids: [LID, PN] }), 0);
  assert.equal(s.remetente(desligado).lid, null);
  s.db.prepare('DELETE FROM remetentes').run();
  const outro = s.cadastrar({ jid: OUTRO, lid: LID, nome: 'Outro' });
  const id = s.cadastrar();
  assert.equal(s.msg(URL_ML, { ids: [LID, PN] }), 1, 'casou pelo número: o item é deste remetente');
  assert.equal(s.itens()[0].remetente_id, id);
  assert.deepEqual([s.remetente(id).lid, s.remetente(outro).lid], [null, LID]);
  assert.equal(textoDoConsole(espias), '');
});

// ------------------------------------------------------------------------------------------------ CA4, CA5, CA6

test('CA6: as 3 lojas ponta a ponta: item → envios (origem remetente, só os grupos que existem) → grupos com o link do dono → resposta', async () => {
  const s = montar();
  const id = s.cadastrar();
  assert.equal(s.msg(`Fone Bom\nPor R$ 79,90\nCupom FONE10\n${URL_MELI}`), 1);
  assert.equal(s.acordou.n, 1, 'receber acorda o agendador');
  assert.equal(s.msg(`Roteador top ${URL_AMAZON}`), 1);
  assert.equal(s.msg(`${URL_SHOPEE}?sp_atk=abc&utm_source=an_999`), 1);
  assert.deepEqual(s.itens().map((i) => [i.status, i.loja, i.chave]), [
    ['recebido', 'mercadolivre', null], ['recebido', 'amazon', `ASIN:${ASIN}`], ['recebido', 'shopee', `SHOPEE:${SHOP}.${ITEM}`]]);
  // a URL guardada da Amazon e da Shopee já vai limpa (nada da tag nem do rastreio de terceiro)
  assert.deepEqual(s.itens().map((i) => i.url), [URL_MELI, `https://www.amazon.com.br/dp/${ASIN}`, URL_SHOPEE]);

  assert.equal(await s.rem.processarPendentes(s.relogio.t), 3);
  assert.deepEqual(s.respostas(), [], 'nada de resposta antes de o envio terminar');
  await s.rem.responderPendentes(s.relogio.t);
  assert.deepEqual(s.respostas(), [], 'o envio ainda está na fila');
  await s.rodar();

  const itens = s.itens();
  assert.deepEqual(itens.map((i) => [i.status, i.codigo, i.chave]), [
    ['enviado', null, 'MLB1234567890'], ['enviado', null, `ASIN:${ASIN}`], ['enviado', null, `SHOPEE:${SHOP}.${ITEM}`]]);
  assert.deepEqual(itens.map((i) => i.fonte_dados), ['api+texto', 'api', 'api']);
  assert.ok(itens.every((i) => i.envio_id && i.decidido_em === s.relogio.t && i.respondido_em === s.relogio.t));
  assert.deepEqual(JSON.parse(itens[0].oferta), { title: 'Fone Bom', price: 89.9, oldPrice: null, discountPct: null, sold: 1200, freeShipping: false, coupon: 'FONE10', image: IMG });

  const envios = s.gravados();
  assert.equal(envios.length, 3);
  for (const e of envios) {
    assert.deepEqual([e.tipo, e.quando, e.status], ['oferta', 'agora', 'concluido']);
    assert.deepEqual(e.group_jids, [DEST1, DEST2], 'o grupo que sumiu fica de fora');
    assert.deepEqual(e.payload.origem, { tipo: 'remetente', remetente_id: id, nome: NOME });
    assert.equal(e.payload.enviar_foto, true);
  }
  assert.equal(envios[0].payload.url, URL_ML, 'ML: o produto achado, nunca o meli.la recebido');
  assert.equal(envios[0].payload.etiqueta, 'etiquetaA');
  assert.equal(envios[1].payload.asin, ASIN);
  assert.equal(envios[2].payload.link_afiliado, LINK_SHOPEE);

  const grupos = s.nosGrupos();
  assert.equal(grupos.length, 6);
  const textos = grupos.map((m) => m.text);
  assert.ok(textos.filter((x) => /meli\.la\/fake-/.test(x)).length === 2, 'ML com o link do dono');
  assert.ok(textos.every((x) => !x.includes(URL_MELI)), 'o meli.la do sócio nunca vai aos grupos');
  assert.ok(textos.filter((x) => x.includes(`https://www.amazon.com.br/dp/${ASIN}?tag=${TAG}`)).length === 2, 'Amazon com a tag do dono');
  assert.ok(textos.every((x) => !/terceiro-20|crid|an_999|sp_atk/.test(x)));
  assert.ok(textos.filter((x) => x.includes(LINK_SHOPEE)).length === 2, 'Shopee com o link da conta do dono');
  assert.ok(textos.some((x) => /FONE10/.test(x)), 'o cupom do texto completou a oferta do ML');

  assert.ok(s.logs().some((l) => l.rule_name === `Remetente: ${NOME}`), 'Histórico: "Remetente: <nome>"');
  assert.deepEqual(s.respostas(), ['Enviado para 2 grupos.', 'Enviado para 2 grupos.', 'Enviado para 2 grupos.']);
  assert.equal(RESPOSTAS.enviadoTodos(2), 'Enviado para 2 grupos.');
});

// ------------------------------------------------------------------------------------------------ rastreio por grupo
// Dashboard de ganhos (brief dashboard-ganhos, CA1, CA2 e CA9; achados R1 e S1 do merge com o Remetente): a oferta do
// remetente ganha uma linha de rastreio por grupo, a Shopee pede o Sub_id do bloco como o Disparo manual e o catálogo,
// e o ML guarda a chave do produto, nunca o meli.la do sócio.
const DEST3 = '400@g.us';
const LINK_SUB_B1 = 'https://s.shopee.com.br/Subb1';
/** Bloco `id` com os grupos `jids` e o Sub_id `codigo` da Shopee (como as telas de Blocos e de Ganhos gravam). */
function blocoComSubId(db, id, jids, codigo) {
  db.prepare('INSERT INTO blocks (id, name, created_at) VALUES (?,?,?)').run(id, `Bloco ${id}`, Date.now());
  for (const j of jids) db.prepare('INSERT INTO block_groups (block_id, jid) VALUES (?,?)').run(id, j);
  rastreio.salvar(db, { loja: 'shopee', alvo_tipo: 'bloco', alvo: String(id), codigo });
}
const rastreados = (db) => db.prepare(`SELECT jid, loja, origem, rule_id, envio_id, oferta_chave, link, codigo, nivel, bloco_id, esperado, motivo
  FROM rastreio_envios ORDER BY id`).all().map((x) => ({ ...x }));
/** Pedidos de link à API da Shopee, na ordem: 'base' (sem Sub_id) ou o Sub_id pedido. */
const mutacoes = (s) => s.fetchS.consultas.filter((c) => c.startsWith('mutation')).map((c) => /subIds:\["(\w+)"\]/.exec(c)?.[1] ?? 'base');
const linkShopeeDe = (m) => /https:\/\/s\.shopee\.com\.br\/\w+/.exec(m.text)?.[0] ?? null;

test('R1/CA1/CA2: Shopee do remetente com Sub_id no bloco: o grupo do bloco recebe o link com o Sub_id, o rastreio guarda o código e o outro grupo sai com o base', async (t) => {
  const erros = t.mock.method(console, 'error', () => {});
  const s = montar();
  blocoComSubId(s.db, 1, [DEST1], 'b1');
  s.cadastrar();
  assert.equal(s.msg(URL_SHOPEE), 1);
  await s.rodar();
  assert.deepEqual(s.itens().map(statusDe), [['enviado', null]]);
  assert.deepEqual(mutacoes(s), ['base', 'b1'], 'o base primeiro (o fallback de todos), depois um pedido por Sub_id');
  const [e] = s.gravados();
  assert.equal(e.status, 'concluido');
  assert.equal(e.payload.link_afiliado, LINK_SHOPEE, 'o link base continua no payload');
  assert.deepEqual(e.payload.links_rastreio, {
    [DEST1]: { link: LINK_SUB_B1, codigo: 'b1', nivel: 'bloco', bloco_id: 1, esperado: 1, motivo: null },
    [DEST2]: { link: LINK_SHOPEE, codigo: null, nivel: 'padrao', bloco_id: null, esperado: 0, motivo: null },
  }, 'só os grupos do envio (o que sumiu fica de fora)');
  assert.deepEqual(s.nosGrupos().map((m) => [m.jid, linkShopeeDe(m)]), [[DEST1, LINK_SUB_B1], [DEST2, LINK_SHOPEE]]);
  const base = { loja: 'shopee', origem: 'manual', rule_id: null, envio_id: e.id, oferta_chave: `SHOPEE:${SHOP}.${ITEM}` };
  assert.deepEqual(rastreados(s.db), [
    { jid: DEST1, ...base, link: LINK_SUB_B1, codigo: 'b1', nivel: 'bloco', bloco_id: 1, esperado: 1, motivo: null },
    { jid: DEST2, ...base, link: LINK_SHOPEE, codigo: null, nivel: 'padrao', bloco_id: null, esperado: 0, motivo: null },
  ]);
  assert.deepEqual(s.respostas(), ['Enviado para 2 grupos.']);
  assert.equal(erros.mock.callCount(), 0);
});

test('R1/CA9: sem Sub_id associado, a Shopee do remetente sai como antes (um pedido de link, payload sem links_rastreio); ML e Amazon não pedem Sub_id', async () => {
  const s = montar();
  s.cadastrar();
  s.msg(URL_SHOPEE); s.msg(URL_ML); s.msg(URL_AMAZON);
  await s.rodar();
  assert.deepEqual(s.itens().map(statusDe), [['enviado', null], ['enviado', null], ['enviado', null]]);
  assert.deepEqual(mutacoes(s), ['base']);
  for (const e of s.gravados()) assert.equal(Object.hasOwn(e.payload, 'links_rastreio'), false, e.payload.loja);
  const shopee = rastreados(s.db).filter((l) => l.loja === 'shopee');
  assert.deepEqual(shopee.map((l) => [l.jid, l.link, l.codigo, l.nivel, l.esperado, l.motivo]),
    [[DEST1, LINK_SHOPEE, null, 'padrao', 0, null], [DEST2, LINK_SHOPEE, null, 'padrao', 0, null]]);
  assert.equal(rastreados(s.db).length, 6, 'uma linha por grupo nas 3 lojas');
});

test('R1: os grupos do remetente mudam durante a leitura da Shopee: vale a lista nova; o Sub_id do grupo que saiu não fica e o grupo novo associado sai com o base e conta como não rastreado', async () => {
  const s = montar();
  s.db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(DEST3, 'Tech Três', 10, Date.now());
  blocoComSubId(s.db, 1, [DEST1], 'b1');
  blocoComSubId(s.db, 2, [DEST3], 'b3');
  const id = s.cadastrar({ destino_jids: JSON.stringify([DEST1, DEST2]) });
  s.fetchS.antes = () => {
    // o dono troca os grupos enquanto o programa lê a loja (uma vez só)
    s.fetchS.antes = null;
    s.db.prepare('UPDATE remetentes SET destino_jids = ? WHERE id = ?').run(JSON.stringify([DEST2, DEST3]), id);
  };
  s.msg(URL_SHOPEE);
  await s.rodar();
  assert.deepEqual(mutacoes(s), ['base', 'b1'], 'os Sub_ids pedidos são os dos grupos lidos antes da rede');
  const [e] = s.gravados();
  assert.deepEqual(e.group_jids, [DEST2, DEST3]);
  assert.equal(Object.hasOwn(e.payload, 'links_rastreio'), false, 'nenhum dos grupos novos tem um Sub_id pronto: o payload fica como antes');
  assert.deepEqual(s.nosGrupos().map((m) => [m.jid, linkShopeeDe(m)]), [[DEST2, LINK_SHOPEE], [DEST3, LINK_SHOPEE]]);
  assert.deepEqual(rastreados(s.db).map((l) => [l.jid, l.link, l.codigo, l.nivel, l.esperado, l.motivo]), [
    [DEST2, LINK_SHOPEE, null, 'padrao', 0, null],
    [DEST3, LINK_SHOPEE, null, 'nenhum', 1, 'sem_link_rastreio'],
  ]);
  assert.ok(!JSON.stringify(s.db.prepare('SELECT payload FROM envios').all()).includes(LINK_SUB_B1), 'o link do grupo que saiu não fica no payload');
});

test('CA1: ML do remetente com etiqueta de rastreio no grupo: o grupo recebe o link com ela (vence a do remetente) e o rastreio guarda o código', async () => {
  const s = montar();
  s.db.prepare("INSERT INTO tags (name, created_at) VALUES ('etiquetaB', 1)").run();
  rastreio.salvar(s.db, { loja: 'mercadolivre', alvo_tipo: 'grupo', alvo: DEST1, codigo: 'etiquetaB' });
  s.cadastrar();
  s.msg(URL_ML);
  await s.rodar();
  const [e] = s.gravados();
  assert.equal(e.payload.etiqueta, 'etiquetaA', 'a etiqueta do remetente (a primeira)');
  const meli = (m) => /https:\/\/meli\.la\/fake-(\w+)-\d+/.exec(m.text)?.[1] ?? null;
  assert.deepEqual(s.nosGrupos().map((m) => [m.jid, meli(m)]), [[DEST1, 'etiquetaB'], [DEST2, 'etiquetaA']]);
  assert.deepEqual(rastreados(s.db).map((l) => [l.jid, l.origem, l.oferta_chave, l.codigo, l.nivel, l.esperado]), [
    [DEST1, 'manual', 'MLB1234567890', 'etiquetaB', 'grupo', 1],
    [DEST2, 'manual', 'MLB1234567890', 'etiquetaA', 'padrao', 0],
  ]);
});

test('S1/CA1: ML do remetente pelo meli.la: o envio e o rastreio guardam a chave do produto (MLB…), nunca o meli.la do sócio', async () => {
  const s = montar();
  // como o leitor real (src/ml.js resolveOffer): a key da leitura é a do link colado, o meli.la do sócio
  s.estado.mlCampos[URL_ML] = { key: URL_MELI };
  s.cadastrar();
  s.msg(URL_MELI);
  await s.rodar();
  assert.deepEqual(s.itens().map((i) => [i.status, i.chave]), [['enviado', 'MLB1234567890']]);
  const [e] = s.gravados();
  assert.equal(e.payload.offer.key, 'MLB1234567890');
  const linhas = rastreados(s.db);
  assert.deepEqual(linhas.map((l) => [l.jid, l.loja, l.oferta_chave]), [[DEST1, 'mercadolivre', 'MLB1234567890'], [DEST2, 'mercadolivre', 'MLB1234567890']]);
  assert.ok(linhas.every((l) => l.oferta_chave.startsWith('MLB')));
  assert.doesNotMatch(JSON.stringify(s.db.prepare('SELECT * FROM rastreio_envios').all()), /meli\.la\/1AbCdEf/);
  assert.doesNotMatch(JSON.stringify(s.db.prepare('SELECT payload FROM envios').all()), /meli\.la\/1AbCdEf/);
});

test('CA5: o texto completa a oferta só com 1 link de loja e é guardado mascarado; o texto da mensagem nunca é guardado', async () => {
  const s = montar();
  s.cadastrar();
  const frase = 'Fala chefe, me liga no 35 99999-1234 ou pedro.socio@gmail.com';
  assert.equal(s.msg(`Caixa de Som Boa\nDe R$ 199,90 Por R$ 99,90\n${frase}\n${URL_ML2}`), 1);
  const it = s.itens()[0];
  const comp = JSON.parse(it.complemento);
  assert.deepEqual([comp.title, comp.price, comp.oldPrice], ['Caixa de Som Boa', 99.9, 199.9]);
  assert.equal(comp.urls, undefined, 'só os campos lidos');
  const banco = tudoNoBanco(s.db);
  for (const x of ['99999-1234', '999991234', 'pedro.socio', 'gmail', 'Fala chefe']) assert.ok(!banco.includes(x), `guardou ${x}`);

  // 2 links: o texto não completa nenhum (não dá para saber de qual produto ele fala)
  assert.equal(s.msg(`Fone Bom Por R$ 9,90 ${URL_ML} ${mlN(5)}`), 2);
  assert.deepEqual(s.itens().slice(1).map((i) => i.complemento), [null, null]);
});

test('CA5: sem preço na loja nem no texto → descartado/sem_dados, sem envio, com a frase que pede nome e preço', async () => {
  const s = montar();
  s.cadastrar();
  s.estado.mlCampos[URL_ML] = { price: null };
  s.msg(URL_ML);
  await s.rodar();
  const it = s.itens()[0];
  assert.deepEqual(statusDe(it), ['descartado', 'sem_dados']);
  assert.ok(it.motivo);
  assert.deepEqual(s.gravados(), []);
  assert.deepEqual(s.respostas(), [FRASES.semDados]);
  assert.ok(s.logs().some((l) => l.level === 'aviso' && l.rule_name === `Remetente: ${NOME}`));
  // com o preço no texto, sai
  s.msg(`Fone Bom por R$ 59,90 ${URL_ML}`);
  await s.rodar();
  assert.deepEqual(statusDe(s.itens()[1]), ['enviado', null]);
  assert.equal(s.gravados()[0].payload.offer.price, 59.9);
});

test('CA4/D5: afiliação checada antes da rede: Amazon sem tag e ML no modo direto viram erro com log "erro" e sem rede', async () => {
  const s = montar({ modo: 'direct' });
  s.cadastrar();
  s.conexaoAmazon.tag = '';
  const montagens = [];
  const montar0 = s.envios.montarOferta;
  s.envios.montarOferta = (...a) => { montagens.push(a[0].url); return montar0(...a); };
  s.msg(URL_ML);
  s.msg(URL_AMAZON);
  await s.rodar();
  assert.deepEqual(s.itens().map(statusDe), [['erro', 'modo_direto'], ['erro', 'sem_tag_amazon']]);
  assert.deepEqual(montagens, [], 'nada foi montado');
  assert.deepEqual(s.ml.chamadas, [], 'o ML não foi lido');
  assert.deepEqual(s.fetchA.chamadas, [], 'a Amazon não foi chamada');
  assert.deepEqual(s.gravados(), []);
  const erros = s.logs().filter((l) => l.level === 'erro');
  assert.equal(erros.length, 2, 'o aviso de erro do dono é alimentado');
  assert.ok(erros.every((l) => l.rule_name === `Remetente: ${NOME}`));
  assert.deepEqual(s.respostas(), [FRASES.montar, FRASES.montar]);
  // ML sem etiqueta nenhuma, extensão fora e Shopee sem ID: os outros códigos de situacaoLink
  s.estado.modo = 'extension';
  s.msg(URL_ML2);
  s.db.prepare('DELETE FROM tags').run();
  s.msg(mlN(1));
  s.db.prepare("UPDATE conexoes SET config = '{}' WHERE plataforma = 'shopee'").run();
  s.msg(URL_SHOPEE);
  await s.rem.processarPendentes(s.relogio.t);
  assert.deepEqual(s.itens().slice(2).map(statusDe), [['erro', 'sem_etiqueta'], ['erro', 'sem_etiqueta'], ['erro', 'sem_id_shopee']]);
});

test('CA4: com a extensão desligada, o ML do remetente não sai (sem_extensao)', async () => {
  const s = montar({ modo: 'extension' });
  s.cadastrar();
  s.msg(URL_ML);
  await s.rodar();
  assert.deepEqual(statusDe(s.itens()[0]), ['erro', 'sem_extensao']);
  assert.deepEqual(s.ml.chamadas, []);
});

test('CA6: template apagado, nenhum grupo que exista e link que não é produto: erro ou descarte com o código certo', async () => {
  const s = montar();
  const sem = s.cadastrar({ destino_jids: JSON.stringify([SUMIDO]) });
  s.msg(URL_ML);
  await s.rodar();
  assert.deepEqual(statusDe(s.itens()[0]), ['erro', 'sem_grupos']);
  s.db.prepare('DELETE FROM remetentes WHERE id = ?').run(sem);
  s.cadastrar({ template_id: 999 });
  s.msg(URL_ML2);
  await s.rodar();
  assert.deepEqual(statusDe(s.itens()[1]), ['erro', 'sem_template']);
  s.db.prepare('UPDATE remetentes SET template_id = 1').run();
  s.msg(URL_BUSCA_AMAZON);
  s.msg('Olha https://www.magazineluiza.com.br/fone/p/abc123/ e https://exemplo.com/x');
  await s.rodar();
  assert.deepEqual(s.itens().slice(2).map((i) => [...statusDe(i), i.url]), [['descartado', 'link_invalido', URL_BUSCA_AMAZON], ['descartado', 'sem_link_de_loja', '']]);
  assert.deepEqual(s.gravados(), []);
  assert.deepEqual(s.respostas(), [FRASES.montar, FRASES.montar, FRASES.linkInvalido, FRASES.semLinkDeLoja]);
});

// ------------------------------------------------------------------------------------------------ CA7

test('CA7/D6: o mesmo produto dentro de "horas sem repetir" → duplicado/repetida, com as horas na resposta; depois da janela sai de novo', async () => {
  const s = montar();
  s.cadastrar({ dedupe_horas: 24 });
  s.msg(URL_ML);
  await s.rodar();
  s.relogio.t += 3 * HORA + 60000;
  s.msg(`${URL_ML}?tracking=x`); // o mesmo anúncio com outro rastreio
  await s.rodar();
  const it = s.itens()[1];
  assert.deepEqual(statusDe(it), ['duplicado', 'repetida']);
  assert.equal(it.motivo, 'repetida (enviada há 3 h)');
  assert.deepEqual(s.ml.chamadas, [URL_ML], 'pré-teste com a chave rápida: nem leu a página');
  // o meli.la do mesmo produto: só a chave final (depois da rede) mostra que é repetida
  s.msg(URL_MELI);
  await s.rodar();
  assert.deepEqual(statusDe(s.itens()[2]), ['duplicado', 'repetida']);
  assert.equal(s.gravados().length, 1);
  assert.deepEqual(s.respostas(), ['Enviado para 2 grupos.', 'Esse produto já foi enviado há 3 h. Não repeti.', 'Esse produto já foi enviado há 3 h. Não repeti.']);
  // passou da janela: sai de novo
  s.relogio.t += 22 * HORA;
  s.msg(URL_ML);
  await s.rodar();
  assert.deepEqual(statusDe(s.itens()[3]), ['enviado', null]);
  assert.equal(s.gravados().length, 2);
});

test('CA7: "horas sem repetir" 0 repete; envio que não chegou a nenhum grupo não conta como enviado', async () => {
  const s = montar();
  const id = s.cadastrar({ dedupe_horas: 0 });
  s.msg(URL_ML); await s.rodar();
  s.msg(URL_ML); await s.rodar();
  assert.deepEqual(s.itens().map(statusDe), [['enviado', null], ['enviado', null]]);
  s.db.prepare('UPDATE remetentes SET dedupe_horas = 24 WHERE id = ?').run(id);
  falharEm(s, [DEST1, DEST2]);
  s.msg(URL_ML2); await s.rodar();
  assert.equal(s.respostas().at(-1), FRASES.falhaEnvio, 'nenhum grupo recebeu');
  s.msg(URL_ML2); await s.rodar();
  assert.deepEqual(statusDe(s.itens()[3]), ['enviado', null], 'o anterior não chegou a nenhum grupo: não é repetido');
});

test('CA7/D6: o mesmo produto na mesma mensagem → duplicado/mesma_mensagem (mesmo com "horas sem repetir" 0); o mesmo link 2 vezes vira 1 item', async () => {
  const s = montar();
  s.cadastrar({ dedupe_horas: 0 });
  assert.equal(s.msg(`${URL_MELI}\n${URL_ML}`), 2, 'meli.la e o link do produto: a chave só aparece depois da rede');
  await s.rodar();
  assert.deepEqual(s.itens().map(statusDe), [['enviado', null], ['duplicado', 'mesma_mensagem']]);
  assert.equal(s.gravados().length, 1);
  assert.deepEqual(s.respostas(), ['Recebi 2 links: 1 enviado, 1 repetido.']);
  // o mesmo ASIN em duas formas e o mesmo link repetido: um item só (chave rápida e URL)
  assert.equal(s.msg(`${URL_AMAZON} https://www.amazon.com.br/dp/${ASIN} ${URL_ML2} ${URL_ML2}`), 2);
});

// Q1 (rodada 2): a chave do ML é a do produto achado (anúncio ou catálogo), nunca a do meli.la recebido
test('Q1: a chave do ML vem do endereço do produto; catálogo (/p/MLB…) tem chave própria e não se confunde com o anúncio de mesmo número', async () => {
  const CATALOGO = 'https://www.mercadolivre.com.br/tablet-x/p/MLB79725856';
  const ANUNCIO_MESMO_NUMERO = 'https://produto.mercadolivre.com.br/MLB-79725856-outro-produto-_JM';
  const s = montar();
  s.cadastrar();
  s.estado.mlDestino['https://meli.la/cat1'] = CATALOGO;
  s.estado.mlDestino['https://meli.la/cat2'] = `${CATALOGO}?matt_tool=99999`;
  s.msg(CATALOGO); await s.rodar();
  assert.equal(s.itens()[0].chave, 'CATALOGO:MLB79725856', 'chave rápida do catálogo, já no receber');
  s.msg('https://meli.la/cat1'); await s.rodar(); // o meli.la leva ao mesmo catálogo
  s.msg('https://meli.la/cat2'); await s.rodar(); // outro meli.la, o mesmo catálogo com rastreio
  s.msg(ANUNCIO_MESMO_NUMERO); await s.rodar(); // o número do catálogo não é o de um anúncio
  assert.deepEqual(s.itens().map((i) => [...statusDe(i), i.chave]), [
    ['enviado', null, 'CATALOGO:MLB79725856'], ['duplicado', 'repetida', 'CATALOGO:MLB79725856'],
    ['duplicado', 'repetida', 'CATALOGO:MLB79725856'], ['enviado', null, 'MLB79725856'],
  ]);
  assert.deepEqual(s.gravados().map((g) => g.payload.url), [CATALOGO, ANUNCIO_MESMO_NUMERO]);
  // o MLB… escondido na query não vira chave
  s.msg('https://www.mercadolivre.com.br/ofertas?item_id=MLB1234567890');
  assert.equal(s.itens().at(-1).chave, null);
});

// Q4 e resíduo do S1 (rodada 2): a chave do ML segue as regras do produtoMl de src/envios.js (não divergem)
test('Q4/S1: chave do ML só para o endereço de um produto: porta, %73ocial, MLB… fora do começo do caminho e a busca (lista.) ficam sem chave', () => {
  const s = montar();
  s.cadastrar({ max_por_hora: 60 });
  const casos = [
    ['https://produto.mercadolivre.com.br/MLB-9876543210-fone-achado-_JM', 'MLB9876543210'],
    ['https://produto.mercadolivre.com.br:443/MLB-9876543211-fone-_JM', 'MLB9876543211'],
    ['https://produto.mercadolivre.com.br/mlb-9876543212-outro-_JM?utm_source=x', 'MLB9876543212'],
    ['https://www.mercadolivre.com.br/MLB9876543213', 'MLB9876543213'],
    ['https://www.mercadolivre.com.br/fone-x/p/MLB79725856', 'CATALOGO:MLB79725856'],
    ['https://www.mercadolivre.com.br/p/MLB79725857', 'CATALOGO:MLB79725857'],
    ['https://www.mercadolivre.com.br/fone-x/p/MLB79725858/s', 'CATALOGO:MLB79725858'],
    ['https://www.mercadolivre.com.br/fone-%C3%A9/p/MLB79725859', 'CATALOGO:MLB79725859'],
    ['https://produto.mercadolivre.com.br:8443/MLB-3000000112-x-_JM', null],
    ['https://www.mercadolivre.com.br/%73ocial/outro-MLB-123456789?matt_tool=1', null],
    ['https://www.mercadolivre.com.br/MLB-3000000113/%73ocial/outroafiliado', null],
    ['https://www.mercadolivre.com.br/perfil/LOJA_X/MLB3000000114', null],
    ['https://www.mercadolivre.com.br/fone/%4DLB-3000000115', null],
    ['https://www.mercadolivre.com.br/a/b/p/MLB3000000116', null],
    ['https://lista.mercadolivre.com.br/MLB-3000000117-fone', null],
    ['http://produto.mercadolivre.com.br/MLB-3000000118-fone-_JM', null],
  ];
  for (const [url, chave] of casos) {
    assert.equal(s.msg(url), 1, url);
    assert.equal(s.itens().at(-1).chave, chave, url);
  }
});

// S3/R5 (rodada 2): depois de decidido, o item não guarda os campos lidos do texto; ML e encurtadores nunca guardam a query
test('S3: complemento apagado na decisão; ML e encurtadores guardados sem query nem fragmento; a repetição pela chave continua', async () => {
  const s = montar();
  s.cadastrar({ max_por_hora: 60 });
  s.msg(`Caixa de Som Boa Por R$ 99,90 ${URL_ML2}?matt_tool=88888&matt_word=OUTRO#x`);
  assert.equal(s.itens()[0].url, URL_ML2, 'ML sem a query de terceiro desde o receber');
  assert.ok(s.itens()[0].complemento, 'antes da decisão, os campos lidos ficam para a montagem');
  await s.rodar();
  assert.deepEqual([...statusDe(s.itens()[0]), s.itens()[0].complemento], ['enviado', null, null]);
  assert.equal(s.gravados()[0].payload.offer.title, 'Fone Bom');
  // descartado e erro também apagam
  s.estado.mlCampos[URL_ML] = { price: null };
  s.msg(`Fone Por R$ 9,90 ${URL_ML}`);
  s.msg(`Fone Bom ${URL_BUSCA_AMAZON}?tag=terceiro-20&ref=x#y`);
  assert.equal(s.itens()[2].url, URL_BUSCA_AMAZON, 'encurtador da Amazon sem a query');
  await s.rodar(); await s.rodar();
  assert.deepEqual(s.itens().map((i) => i.complemento), [null, null, null]);
  assert.deepEqual(s.itens().slice(1).map(statusDe), [['enviado', null], ['descartado', 'link_invalido']]);
  // o mesmo anúncio com outra query, em outra mensagem: repetida pela chave
  s.msg(`${URL_ML2}?outro=1`); await s.rodar();
  assert.deepEqual(statusDe(s.itens()[3]), ['duplicado', 'repetida']);
  // a mesma mensagem entregue de novo (mesmo id) não vira item novo, nem com a URL guardada sem a query
  const antes = s.itens().length;
  assert.equal(s.rem.receber({ ids: [PN], texto: `${URL_ML2}?matt_tool=1`, msgId: 'MSG1', ts: s.relogio.t }), 0);
  assert.equal(s.itens().length, antes);
});

// Q2/S2 (rodada 2): o limite por hora conta pela hora de chegada (chegou_em), não pela hora da mensagem
test('Q2: limite por hora pela chegada: mensagens atrasadas contam; o ts da mensagem segue valendo para a expiração de 2 h', async () => {
  const s = montar();
  s.cadastrar({ max_por_hora: 2 });
  const chegada = s.relogio.t;
  assert.equal(s.msg(mlN(1), { ts: chegada - 90 * 60000 }), 1);
  assert.equal(s.msg(mlN(2), { ts: chegada - 70 * 60000 }), 1);
  assert.equal(s.msg(mlN(3), { ts: chegada - 61 * 60000 }), 1, 'a 3ª grava só a linha do limite');
  assert.deepEqual(s.itens().map((i) => [...statusDe(i), i.chegou_em, i.ts]), [
    ['recebido', null, chegada, chegada - 90 * 60000], ['recebido', null, chegada, chegada - 70 * 60000],
    ['descartado', 'limite', chegada, chegada - 61 * 60000],
  ]);
  // item de banco antigo (sem chegou_em) conta pelo ts
  s.relogio.t += HORA + 60000;
  s.db.prepare('UPDATE remetente_itens SET chegou_em = NULL').run();
  s.db.prepare('UPDATE remetente_itens SET ts = ? WHERE id = 1').run(s.relogio.t - 10 * 60000);
  assert.equal(s.msg(mlN(4)), 1);
  assert.equal(s.msg(mlN(5)), 1, 'o item antigo com ts recente ocupa uma vaga: a 5ª grava a linha do limite');
  assert.deepEqual(statusDe(s.itens().at(-1)), ['descartado', 'limite']);
});

test('CA7: no máximo 5 links por mensagem', async () => {
  const s = montar();
  s.cadastrar({ max_por_hora: 60 });
  const urls = [1, 2, 3, 4, 5, 6, 7].map(mlN);
  assert.equal(s.msg(urls.join('\n')), 5);
  assert.deepEqual(s.itens().map((i) => i.url), urls.slice(0, 5));
});

test('CA7/D7: acima do limite por hora → uma única linha descartado/limite por hora; o resto é ignorado sem gravar', async () => {
  const s = montar();
  s.cadastrar({ max_por_hora: 2, dedupe_horas: 0 });
  assert.equal(s.msg(`${mlN(1)} ${mlN(2)} ${mlN(3)}`), 3, '2 links e a linha do limite');
  assert.deepEqual(s.itens().map(statusDe), [['recebido', null], ['recebido', null], ['descartado', 'limite']]);
  assert.equal(s.msg(mlN(4)), 0, 'acima do limite de novo, na mesma hora: nada');
  assert.equal(s.msg(`só texto https://exemplo.com/x`), 0, 'mensagem sem link de loja também conta');
  await s.rodar();
  const linhasLimite = s.logs().filter((l) => /limite/.test(l.message));
  assert.equal(linhasLimite.length, 1, 'uma linha por hora no Histórico');
  assert.equal(linhasLimite[0].level, 'aviso');
  assert.deepEqual(s.respostas(), ['Recebi 3 links: 2 enviados, 1 não enviado.']);
  // 1 link por mensagem: o primeiro acima do limite leva a frase do limite (1 vez por hora)
  s.relogio.t += HORA + 1;
  s.msg(mlN(5)); s.msg(mlN(6)); s.msg(mlN(7)); s.msg(mlN(8));
  await s.rodar();
  assert.deepEqual(s.itens().slice(3).map(statusDe), [['enviado', null], ['enviado', null], ['descartado', 'limite']]);
  assert.deepEqual(s.respostas().slice(1), ['Enviado para 2 grupos.', 'Enviado para 2 grupos.', FRASES.limite]);
});

test('CA7/P10: item parado há mais de 2 h expira, sem envio e sem resposta', async () => {
  const s = montar();
  s.cadastrar();
  s.msg(URL_ML);
  s.relogio.t += 2 * HORA + 1;
  await s.rodar();
  const it = s.itens()[0];
  assert.deepEqual(statusDe(it), ['descartado', 'expirado']);
  assert.ok(it.respondido_em, 'marcado como respondido, sem enviar');
  assert.deepEqual(s.gravados(), []);
  assert.deepEqual(s.ml.chamadas, []);
  assert.deepEqual(s.respostas(), []);
});

test('remetente desligado ou excluído depois da chegada: descartado, sem envio e sem resposta', async () => {
  const s = montar();
  const id = s.cadastrar();
  s.msg(URL_ML);
  s.db.prepare('UPDATE remetentes SET enabled = 0 WHERE id = ?').run(id);
  await s.rodar();
  s.db.prepare('UPDATE remetentes SET enabled = 1 WHERE id = ?').run(id);
  s.msg(URL_ML2);
  s.db.prepare('DELETE FROM remetentes WHERE id = ?').run(id);
  await s.rodar();
  assert.deepEqual(s.itens().map(statusDe), [['descartado', 'desligado'], ['descartado', 'apagado']]);
  assert.ok(s.itens().every((i) => i.respondido_em && i.remetente_nome === NOME));
  assert.deepEqual(s.gravados(), []);
  assert.deepEqual(s.respostas(), []);
});

// ------------------------------------------------------------------------------------------------ CA8

test('CA8/D8: a resposta só sai depois de o envio terminar: total, parcial e nenhum grupo', async () => {
  const s = montar();
  const id = s.cadastrar();
  s.msg(URL_ML);
  await s.rem.processarPendentes(s.relogio.t);
  await s.rem.responderPendentes(s.relogio.t);
  assert.deepEqual(s.respostas(), [], 'envio pendente: espera');
  await s.envios.processarPendentes(s.relogio.t);
  await s.rem.responderPendentes(s.relogio.t);
  assert.deepEqual(s.respostas(), ['Enviado para 2 grupos.']);
  await s.rem.responderPendentes(s.relogio.t);
  assert.equal(s.respostas().length, 1, 'uma resposta por mensagem');

  falharEm(s, [DEST2]);
  s.msg(URL_ML2); await s.rodar();
  assert.equal(s.respostas().at(-1), 'Enviado para 1 de 2 grupos.');
  falharEm(s, [DEST1]);
  s.msg(mlN(1)); await s.rodar();
  assert.equal(s.respostas().at(-1), FRASES.falhaEnvio);

  s.db.prepare('UPDATE remetentes SET destino_jids = ? WHERE id = ?').run(JSON.stringify([DEST1]), id);
  s.wa.sendText = s.wa.sendImage = async () => {}; // volta a enviar (sem registrar)
  s.msg(mlN(2)); await s.rodar();
  assert.equal(s.wa.simulated.filter((m) => m.jid === PN).length, 3, 'o sendText trocado não registra');
});

test('CA8: "Enviado para 1 grupo." no singular; vários links com as partes no singular e plural', async () => {
  const s = montar();
  s.cadastrar({ destino_jids: JSON.stringify([DEST1]), dedupe_horas: 24, max_por_hora: 60 });
  s.msg(URL_ML); await s.rodar();
  s.msg(`${mlN(1)} ${mlN(2)} ${URL_ML} ${URL_BUSCA_AMAZON}`); await s.rodar();
  s.msg(`${mlN(3)} ${mlN(4)}`); await s.rodar();
  assert.deepEqual(s.respostas(), ['Enviado para 1 grupo.', 'Recebi 4 links: 2 enviados, 1 repetido, 1 não enviado.', 'Recebi 2 links: 2 enviados.']);
});

test('CA8: "responder" desligado, WhatsApp fora (espera e, passadas 2 h, desiste) e falha do sendText sem o número no log', async (t) => {
  const espias = capturarConsole(t);
  const s = montar();
  const id = s.cadastrar({ responder: 0 });
  s.msg(URL_ML); await s.rodar();
  assert.deepEqual(s.respostas(), []);
  assert.ok(s.itens()[0].respondido_em, 'marcado sem enviar');

  s.db.prepare('UPDATE remetentes SET responder = 1 WHERE id = ?').run(id);
  const pronto = s.wa.isReady;
  s.msg(URL_ML2); await s.rem.processarPendentes(s.relogio.t); await s.envios.processarPendentes(s.relogio.t); // envio feito
  s.wa.isReady = () => false;
  await s.rem.responderPendentes(s.relogio.t);
  assert.deepEqual(s.respostas(), []);
  assert.equal(s.itens()[1].respondido_em, null, 'espera o WhatsApp voltar');
  s.wa.isReady = pronto;
  await s.rem.responderPendentes(s.relogio.t);
  assert.deepEqual(s.respostas(), ['Enviado para 2 grupos.']);

  // WhatsApp fora por mais de 2 h desde que a mensagem ficou pronta: marca sem enviar
  s.msg(mlN(2)); await s.rem.processarPendentes(s.relogio.t); await s.envios.processarPendentes(s.relogio.t);
  s.wa.isReady = () => false;
  s.relogio.t += 2 * HORA + 60000; // o last_run_at do envio é do relógio real, alguns ms depois do relógio do teste
  await s.rem.responderPendentes(s.relogio.t);
  assert.ok(s.itens()[2].respondido_em);
  s.wa.isReady = pronto;
  await s.rem.responderPendentes(s.relogio.t);
  assert.equal(s.respostas().length, 1, 'não manda a resposta velha');

  // falha do sendText: aviso no log sem número nem jid; o console não leva a mensagem
  falharEm(s, [PN]);
  s.msg(mlN(3)); await s.rodar();
  const aviso = s.logs().find((l) => /responder/.test(l.message));
  assert.ok(aviso, 'a falha da resposta fica no Histórico');
  assert.equal(aviso.level, 'aviso');
  assert.ok(s.itens()[3].respondido_em, 'não tenta de novo (nada de laço)');
  await s.rem.responderPendentes(s.relogio.t);
  assert.equal(s.logs().filter((l) => /responder/.test(l.message)).length, 1);
  assert.ok(!tudoNoBanco(s.db).includes(NUMERO) && !tudoNoBanco(s.db).includes('99999'), 'número no banco fora de remetentes');
  assert.ok(!textoDoConsole(espias).includes(NUMERO));
});

test('CA8: no máximo 20 respostas por hora por remetente; a 21ª não sai (e não sai depois)', async () => {
  const s = montar();
  s.cadastrar({ max_por_hora: 60 });
  for (let i = 0; i < 21; i++) s.msg(`Olha https://exemplo.com/p${i}`);
  await s.rem.responderPendentes(s.relogio.t);
  assert.equal(s.respostas().length, 20);
  assert.ok(s.respostas().every((r) => r === FRASES.semLinkDeLoja));
  assert.ok(s.itens().every((i) => i.respondido_em), 'a 21ª foi marcada sem enviar');
  await s.rem.responderPendentes(s.relogio.t);
  assert.equal(s.respostas().length, 20);
  s.relogio.t += HORA + 1;
  s.msg('Olha https://exemplo.com/nova');
  await s.rem.responderPendentes(s.relogio.t);
  assert.equal(s.respostas().length, 21, 'na hora seguinte volta a responder');
});

test('CA8: as frases são as do plano', () => {
  assert.equal(RESPOSTAS.enviadoTodos(1), 'Enviado para 1 grupo.');
  assert.equal(RESPOSTAS.enviadoTodos(3), 'Enviado para 3 grupos.');
  assert.equal(RESPOSTAS.enviadoParte(2, 3), 'Enviado para 2 de 3 grupos.');
  assert.equal(RESPOSTAS.falhaEnvio, FRASES.falhaEnvio);
  assert.equal(RESPOSTAS.repetida('3'), 'Esse produto já foi enviado há 3 h. Não repeti.');
  assert.equal(RESPOSTAS.montar, FRASES.montar);
  assert.equal(RESPOSTAS.sem_dados, FRASES.semDados);
  assert.equal(RESPOSTAS.link_invalido, FRASES.linkInvalido);
  assert.equal(RESPOSTAS.sem_link_de_loja, FRASES.semLinkDeLoja);
  assert.equal(RESPOSTAS.limite, FRASES.limite);
  assert.equal(RESPOSTAS.varios(3, { enviados: 2, repetidos: 1, nao: 0 }), 'Recebi 3 links: 2 enviados, 1 repetido.');
  assert.equal(RESPOSTAS.varios(2, { enviados: 0, repetidos: 0, nao: 2 }), 'Recebi 2 links: 2 não enviados.');
  assert.equal(RESPOSTAS.varios(3, { enviados: 1, repetidos: 0, nao: 2 }), 'Recebi 3 links: 1 enviado, 2 não enviados.');
});

// ------------------------------------------------------------------------------------------------ CA9, CA10

test('CA9: número e LID nunca vão a log, console, erro nem itens; nome do remetente no Histórico', async (t) => {
  const espias = capturarConsole(t);
  const s = montar();
  s.cadastrar({ dedupe_horas: 24, max_por_hora: 10 });
  s.msg(`Fone ${URL_ML} ligue 35999991234`, { ids: [LID, PN] });
  s.msg(URL_ML, { ids: [LID] });
  s.msg('https://exemplo.com/x', { ids: [LID] });
  s.msg(`${mlN(1)} ${mlN(2)}`, { ids: [LID] });
  s.conexaoAmazon.tag = '';
  s.msg(URL_AMAZON, { ids: [LID] });
  falharEm(s, [DEST2, PN]);
  await s.rodar();
  const banco = tudoNoBanco(s.db);
  for (const x of [NUMERO, NUMERO.slice(2), LID.split('@')[0], '999991234']) {
    assert.ok(!banco.includes(x), `vazou ${x} no banco`);
    assert.ok(!textoDoConsole(espias).includes(x), `vazou ${x} no console`);
  }
  assert.ok(s.logs().length > 0);
  assert.ok(s.logs().every((l) => l.rule_name === `Remetente: ${NOME}`));
});

test('CA10: reinício no meio: o item travado em "processando" volta e sai uma vez; o já decidido não sai de novo', async () => {
  const s = montar();
  s.cadastrar();
  s.msg(URL_ML);
  s.msg(URL_ML2);
  await s.rem.processarPendentes(s.relogio.t); // os 2 decididos, envios gravados, nada enviado ainda
  s.msg(mlN(1));
  s.db.prepare("UPDATE remetente_itens SET status = 'processando' WHERE status = 'recebido'").run(); // caiu no meio deste
  const novo = s.criar(); // o serviço voltou
  assert.equal(novo.recuperar(), 1);
  assert.equal(s.itens()[2].status, 'recebido');
  await s.rodar(novo);
  await s.rodar(novo);
  assert.deepEqual(s.itens().map(statusDe), [['enviado', null], ['enviado', null], ['enviado', null]]);
  assert.equal(s.gravados().length, 3);
  assert.equal(s.nosGrupos().length, 6);
  assert.deepEqual(s.respostas(), ['Enviado para 2 grupos.', 'Enviado para 2 grupos.', 'Enviado para 2 grupos.']);
});

test('CA10: duas instâncias ao mesmo tempo: cada item é tratado uma vez (trava) e o mesmo produto sai uma vez (BEGIN IMMEDIATE)', async () => {
  const s = montar();
  s.cadastrar();
  let soltar;
  s.estado.mlEspera = new Promise((r) => { soltar = r; });
  s.estado.mlDestino['https://meli.la/outro2'] = URL_ML;
  s.msg(URL_MELI); // dois meli.la diferentes do mesmo produto: o pré-teste não vê (sem chave rápida)
  s.msg('https://meli.la/outro2');
  const outra = s.criar();
  // a 2ª passada da mesma instância chega antes da outra instância: sem a guarda, ela pegaria o 2º item
  const corrida = Promise.all([s.rem.processarPendentes(s.relogio.t), s.rem.processarPendentes(s.relogio.t), outra.processarPendentes(s.relogio.t)]);
  await new Promise((r) => setImmediate(r));
  soltar();
  const [a, b, c] = await corrida;
  assert.deepEqual([a, b, c], [1, 0, 1], 'cada item uma vez; a mesma instância não roda duas passadas juntas');
  assert.deepEqual(s.itens().map(statusDe).sort(), [['duplicado', 'repetida'], ['enviado', null]]);
  assert.equal(s.gravados().length, 1);
});

test('CA10: a falha de um item não trava os outros; o console leva só o nome do erro', async (t) => {
  const espias = capturarConsole(t);
  const s = montar();
  s.cadastrar();
  const montar0 = s.envios.montarOferta;
  s.envios.montarOferta = (d, o) => (d.url === URL_ML ? Promise.reject(new TypeError(`quebrou com ${PN} ${URL_ML}`)) : montar0(d, o));
  s.msg(URL_ML);
  s.msg(URL_ML2);
  await s.rodar();
  assert.deepEqual(s.itens().map(statusDe), [['erro', 'falha'], ['enviado', null]]);
  const erro = s.logs().find((l) => l.level === 'erro');
  assert.ok(erro && !erro.message.includes(NUMERO));
  assert.deepEqual(s.respostas(), [FRASES.montar, 'Enviado para 2 grupos.']);
  assert.ok(!textoDoConsole(espias).includes(NUMERO));

  // banco travado num item (erro do SQLite no meio da decisão): o item fica com erro e o resto segue
  const prep = s.db.prepare.bind(s.db);
  let quebrar = true;
  s.db.prepare = (sql) => {
    if (quebrar && /INSERT INTO envios/.test(sql)) { quebrar = false; throw Object.assign(new Error(`constraint ${PN}`), { code: 'ERR_SQLITE_ERROR' }); }
    return prep(sql);
  };
  s.msg(mlN(1)); s.msg(mlN(2));
  await s.rodar();
  s.db.prepare = prep;
  assert.deepEqual(s.itens().slice(2).map(statusDe), [['erro', 'falha'], ['enviado', null]]);
  assert.ok(!textoDoConsole(espias).includes(NUMERO));
});

test('recuperar e limpar(dias): apaga o que passou do prazo, mantém o "enviado" que ainda conta para a repetição e o que está na fila', async () => {
  const s = montar();
  const id = s.cadastrar({ dedupe_horas: 72 });
  s.msg(URL_ML); await s.rodar();                       // enviado (conta por 72 h)
  s.msg('https://exemplo.com/x'); await s.rodar();      // descartado
  s.relogio.t += 2 * 86400000;
  s.msg(URL_ML2);                                        // recebido (na fila)
  assert.deepEqual(s.rem.limpar(1, s.relogio.t), { itens: 1 }, 'só o descartado');
  assert.deepEqual(s.itens().map(statusDe), [['enviado', null], ['recebido', null]]);
  assert.deepEqual(s.rem.limpar(0, s.relogio.t), { itens: 0 }, '0 = não apaga');
  s.db.prepare('UPDATE remetentes SET dedupe_horas = 24 WHERE id = ?').run(id);
  assert.deepEqual(s.rem.limpar(1, s.relogio.t), { itens: 1 }, 'passou da repetição: o enviado também sai');
  assert.equal(s.rem.recuperar(), 0);
});

test('CA10: nenhum teste acessou a rede de verdade', () => {
  assert.equal(acessosRede, 0);
});
