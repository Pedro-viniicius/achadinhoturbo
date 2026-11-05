// QA da feature "Remetente" (plano envio-pelo-socio), rodada 1: bordas e regressões que os testes dos dev
// (remetentes*.test.js) não cobrem. Concorrência, limite por hora com mensagens atrasadas, LID de ponta a ponta pelo
// ouvinte do WhatsApp, link malicioso, foto, orçamento de tempo, vazamento de dado pessoal no texto que vai ao grupo.
// Harness próprio e pequeno (o dos dev roda testes ao ser importado): WhatsApp simulado, links `fake`, ML falso,
// Amazon e Shopee com fetch falso; o fetch global fica bloqueado e o último teste prova que ninguém o chamou.
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
import { extractItemId, resolveOffer as resolveOfferReal } from '../src/ml.js';
import { createRemetentes } from '../src/remetentes.js';

let acessosRede = 0;
globalThis.fetch = async () => { acessosRede++; throw new Error('rede proibida no teste'); };

const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-qarem-')); pastas.push(p); return p; };

const HORA = 3600000;
const NUMERO = '5535999991234';
const PN = `${NUMERO}@s.whatsapp.net`;
const LID = '207654321098765@lid';
const DEST1 = '200@g.us';
const DEST2 = '300@g.us';
const GRUPOS = [[DEST1, 'Achadinhos Tech'], [DEST2, 'Tech Dois']];
const NOME = 'Sócio Pedro';
const IMG = 'https://http2.mlstatic.com/D_NQ_NP_123-O.jpg';
const mlN = (n) => `https://produto.mercadolivre.com.br/MLB-${3000000000 + n}-produto-${n}-_JM`;
const URL_ML = mlN(1);
const ASIN = 'B0FG2MD49G';
const URL_AMAZON = `https://www.amazon.com.br/Roteador-Mesh/dp/${ASIN}?tag=terceiro-20`;
const URL_AMZN_CURTO = 'https://amzn.to/curto1';
const URL_AMZN_CURTO2 = 'https://amzn.to/curto2';
const SHOP = '52377417';
const ITEM = '6309028319';
const URL_SHOPEE = `https://shopee.com.br/Fone-Bom-Sem-Fio-i.${SHOP}.${ITEM}`;
const LINK_SHOPEE = 'https://s.shopee.com.br/ApiLink123';

const respJson = (status, corpo) => new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } });

function fetchAmazon() {
  const chamadas = [];
  const pagina = `https://www.amazon.com.br/Roteador-Mesh/dp/${ASIN}`;
  const f = async (url, init = {}) => {
    const u = String(url);
    chamadas.push(u);
    if (u === URL_AMZN_CURTO || u === URL_AMZN_CURTO2) return new Response(null, { status: 302, headers: { location: pagina } });
    if (u === pagina) return new Response('<html>produto</html>', { status: 200 });
    if (u === 'https://api.amazon.com/auth/o2/token') return respJson(200, { access_token: 'tok', token_type: 'bearer', expires_in: 3600 });
    if (u === 'https://creatorsapi.amazon/catalog/v1/getItems') {
      return respJson(200, { itemsResult: { items: JSON.parse(init.body).itemIds.map((asin) => ({
        asin, detailPageURL: `https://www.amazon.com.br/dp/${asin}?tag=pedro-20`,
        itemInfo: { title: { displayValue: 'Roteador Mesh Wi-Fi 7' } },
        images: { primary: { large: { url: 'https://m.media-amazon.com/images/I/71abcDEF.jpg', height: 500, width: 500 } } },
        offersV2: { listings: [{ isBuyBoxWinner: true, availability: { type: 'IN_STOCK' }, price: { money: { amount: 1310.05 } } }] },
      })) } });
    }
    throw new Error(`rede não prevista no teste: ${u}`);
  };
  f.chamadas = chamadas;
  return f;
}

function fetchShopee() {
  const f = async (url, init = {}) => {
    if (String(url) === URL_API_SHOPEE) {
      if (JSON.parse(init.body).query.startsWith('mutation')) return respJson(200, { data: { generateShortLink: { shortLink: LINK_SHOPEE } } });
      return respJson(200, { data: { productOfferV2: { nodes: [{ itemId: Number(ITEM), productName: 'Fone Bom Sem Fio', priceMin: '89.90', priceMax: '99.90',
        priceDiscountRate: 15, sales: 1234, ratingStar: '4.83', imageUrl: 'https://down-br.img.susercontent.com/file/br-11134207-7r98o-abc123', shopName: 'Loja' }] } } });
    }
    throw new Error('rede não prevista no teste');
  };
  return f;
}

/** ML falso: cada leitura guarda a URL; `estado.mlEspera` segura a leitura; `estado.mlRelogio` faz a "rede" demorar (ms no relógio do teste). */
function mlFalso(estado, relogio) {
  const chamadas = [];
  return {
    chamadas,
    async resolveOffer(c) {
      chamadas.push(c.url);
      if (estado.mlEspera) await estado.mlEspera;
      if (estado.mlDemora) relogio.t += estado.mlDemora;
      return { key: extractItemId(c.url) ?? c.key, url: c.url, title: 'Fone Bom', price: 89.9, oldPrice: null, discountPct: null,
        sold: 1200, freeShipping: false, image: IMG };
    },
  };
}

function montar({ resolverNumero } = {}) {
  const dir = tmp();
  const db = openDb(dir);
  for (const [jid, nome] of GRUPOS) db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, nome, 10, Date.now());
  db.prepare("INSERT INTO tags (name, created_at) VALUES ('etiquetaA', 1)").run();
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const relogio = { t: Date.now() };
  const estado = { mlEspera: null, mlDemora: 0 };
  const links = createLinkService({ getMode: () => 'fake' });
  const ml = mlFalso(estado, relogio);
  const fetchA = fetchAmazon();
  const amazon = createAmazon({ db, fetch: fetchA, esperar: async () => {}, lerConexao: () => ({ tag: 'pedro-20', credencial_versao: '3.1', credencial_id: 'cid-0001', credencial_secret: 'segredo-123' }) });
  db.prepare("INSERT INTO conexoes (plataforma, config, segredos, updated_at) VALUES ('shopee', ?, ?, ?)")
    .run(JSON.stringify({ id_afiliado: '98765432101', app_id: '123456789' }), JSON.stringify({ chave: 'Senha-Api-SECRETA-q1w2e3' }), Date.now());
  const shopee = createShopee({ db, fetch: fetchShopee() });
  const envios = createEnvios({ db, wa, links, ml, fast: true, dir, amazon, shopee });
  if (resolverNumero) wa.resolverNumero = resolverNumero;
  const criar = () => createRemetentes({ db, wa, envios, acordar: () => {}, agora: () => relogio.t });
  const rem = criar();
  let seq = 0;
  const s = {
    dir, db, wa, envios, estado, ml, fetchA, relogio, rem, criar,
    cadastrar(extra = {}) {
      const r = { nome: NOME, jid: PN, lid: null, enabled: 1, destino_jids: JSON.stringify([DEST1, DEST2]), template_id: 1, tag_id: null,
        enviar_foto: 1, max_por_hora: 10, dedupe_horas: 24, responder: 1, ...extra };
      return Number(db.prepare(`INSERT INTO remetentes (nome, jid, lid, enabled, destino_jids, template_id, tag_id, enviar_foto, max_por_hora,
        dedupe_horas, responder, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(r.nome, r.jid, r.lid, r.enabled, r.destino_jids, r.template_id, r.tag_id, r.enviar_foto, r.max_por_hora, r.dedupe_horas, r.responder, 1, 1).lastInsertRowid);
    },
    msg: (texto, o = {}) => rem.receber({ ids: [PN], texto, msgId: `MSG${++seq}`, ts: relogio.t, ...o }),
    async rodar(r = rem) {
      const n = await r.processarPendentes(relogio.t);
      await envios.processarPendentes(relogio.t);
      await r.responderPendentes(relogio.t);
      return n;
    },
    itens: () => db.prepare('SELECT * FROM remetente_itens ORDER BY id').all().map((x) => ({ ...x })),
    gravados: () => db.prepare('SELECT * FROM envios ORDER BY id').all().map((x) => ({ ...x, payload: JSON.parse(x.payload) })),
    logs: () => db.prepare('SELECT * FROM log ORDER BY id').all().map((x) => ({ ...x })),
    nosGrupos: () => wa.simulated.filter((m) => m.jid.endsWith('@g.us')),
    respostas: () => wa.simulated.filter((m) => !m.jid.endsWith('@g.us')).map((m) => m.text),
  };
  return s;
}

const statusDe = (it) => [it.status, it.codigo];

// ------------------------------------------------------------------------------------------------ CA7: limite por hora

test('CA7: o limite por hora vale também para mensagens que chegam atrasadas (programa fora do ar): 12 links com hora de 90 min atrás, limite 10', () => {
  const s = montar();
  s.cadastrar({ max_por_hora: 10 });
  // o sócio mandou 12 links há 90 min (dentro das 2 h aceitas); o programa volta e o WhatsApp entrega tudo de uma vez
  const aceitos = [];
  for (let i = 1; i <= 12; i++) aceitos.push(s.msg(mlN(i), { ts: s.relogio.t - 90 * 60000 }));
  const gravados = s.itens().filter((i) => i.codigo !== 'limite').length;
  assert.ok(gravados <= 10, `limite de 10 por hora furado: ${gravados} itens aceitos de ${aceitos.length} mensagens`);
});

test('CA7: no tempo real o limite segura exatamente na 11ª e solta quando a hora passa', async () => {
  const s = montar();
  s.cadastrar({ max_por_hora: 10 });
  for (let i = 1; i <= 10; i++) assert.equal(s.msg(mlN(i)), 1, `link ${i}`);
  assert.equal(s.msg(mlN(11)), 1, 'a 11ª grava só a linha "limite"');
  assert.equal(s.msg(mlN(12)), 0, 'a 12ª é ignorada sem gravar');
  assert.deepEqual(s.itens().slice(10).map(statusDe), [['descartado', 'limite']]);
  s.relogio.t += HORA + 1;
  assert.equal(s.msg(mlN(13)), 1, 'passada a hora, volta a aceitar');
});

test('CA7: limite 1 por hora: o segundo link já é barrado e o terceiro é ignorado; mensagem com 5 links grava 1 item e a linha "limite"', async () => {
  const s = montar();
  s.cadastrar({ max_por_hora: 1 });
  assert.equal(s.msg(`${mlN(1)} ${mlN(2)} ${mlN(3)} ${mlN(4)} ${mlN(5)}`), 2);
  assert.deepEqual(s.itens().map(statusDe), [['recebido', null], ['descartado', 'limite']]);
});

test('CA7 (baixa): "Recebi N links" conta a linha de limite como 1, mesmo quando ela representa vários links cortados', async () => {
  const s = montar();
  s.cadastrar({ max_por_hora: 2 });
  assert.equal(s.msg(`${mlN(1)} ${mlN(2)} ${mlN(3)} ${mlN(4)} ${mlN(5)}`), 3, '2 links + a linha de limite');
  await s.rodar(); await s.rodar();
  // a mensagem tinha 5 links: dizer "Recebi 3 links" é mentira; o esperado é refletir os 5 (ou não contar a linha de limite como link)
  assert.deepEqual(s.respostas(), ['Recebi 5 links: 2 enviados, 3 não enviados.']);
});

// ------------------------------------------------------------------------------------------------ CA2/CA3: ouvinte de verdade

/** Upsert como o Baileys entrega. */
const upsert = (key, texto, id) => ({ type: 'notify', messages: [{ key: { id, fromMe: false, ...key }, messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: texto } }] });

test('CA3 (ponta a ponta pelo ouvinte do WhatsApp): PN, LID com remoteJidAlt, LID resolvido pelo mapa e LID aprendido', async () => {
  const s = montar();
  const id = s.cadastrar();
  const mapa = { getPNForLID: async (lid) => (lid === LID ? PN : null) };
  s.wa._usarSocket({ user: { id: '5511900000000:7@s.whatsapp.net' }, signalRepository: { lidMapping: mapa } });
  s.wa.onPrivada((m) => s.rem.receber(m));
  // 1) número
  await s.wa._onMensagens(upsert({ remoteJid: `${NUMERO}:3@s.whatsapp.net` }, mlN(1), 'A1'));
  // 2) LID com o número no remoteJidAlt
  await s.wa._onMensagens(upsert({ remoteJid: LID, remoteJidAlt: PN }, mlN(2), 'A2'));
  assert.equal(s.db.prepare('SELECT lid FROM remetentes WHERE id = ?').get(id).lid, LID, 'aprendeu o LID pela mensagem');
  // 3) só o LID, já guardado, mapa fora do ar
  mapa.getPNForLID = async () => { throw new Error('mapa fora'); };
  await s.wa._onMensagens(upsert({ remoteJid: LID }, mlN(3), 'A3'));
  assert.deepEqual(s.itens().map((i) => i.msg_id), ['A1', 'A2', 'A3']);
  // 4) LID desconhecido, sem mapa, nunca casa
  await s.wa._onMensagens(upsert({ remoteJid: '209999999999999@lid' }, mlN(4), 'A4'));
  // 5) o que não é privado ou é meu
  await s.wa._onMensagens(upsert({ remoteJid: '120363000000000000@g.us', participant: PN }, mlN(5), 'A5'));
  await s.wa._onMensagens(upsert({ remoteJid: 'status@broadcast', participant: PN }, mlN(6), 'A6'));
  await s.wa._onMensagens(upsert({ remoteJid: '120363000000000001@newsletter' }, mlN(7), 'A7'));
  await s.wa._onMensagens(upsert({ remoteJid: PN, fromMe: true }, mlN(8), 'A8'));
  assert.equal(s.itens().length, 3);
});

test('CA3: mensagem entregue duas vezes (mesmo id) vira um item só e uma resposta só', async () => {
  const s = montar();
  s.cadastrar();
  assert.equal(s.msg(URL_ML, { msgId: 'DUP' }), 1);
  assert.equal(s.msg(URL_ML, { msgId: 'DUP' }), 0);
  await s.rodar(); await s.rodar();
  assert.equal(s.itens().length, 1);
  assert.equal(s.nosGrupos().length, 2);
  assert.equal(s.respostas().length, 1);
  assert.equal(s.msg(URL_ML, { msgId: 'DUP' }), 0, 'depois de decidida também');
});

test('CA2: texto patológico de 4 KB (dígitos, pontos, "R$", links, e-mails, CPF) é tratado em menos de 300 ms no total: o receber() é síncrono e trava o servidor se uma regex explodir', () => {
  const s = montar();
  s.cadastrar({ max_por_hora: 60 });
  const N = 4096;
  const casos = ['1'.repeat(N), '1.'.repeat(N / 2), 'R$ '.repeat(N / 3), 'R$ 1.'.repeat(N / 5), 'https://' + 'a.'.repeat(N / 2), 'a@'.repeat(N / 2),
    'a'.repeat(N / 2) + '@' + 'b.'.repeat(N / 4), '123.456.789-'.repeat(N / 12), ' '.repeat(N) + 'x', '('.repeat(N), 'amazon.com.br/'.repeat(N / 14), '\t\n '.repeat(N / 3) + 'R$',
    `${URL_ML} ` + 'OFF 10% cupom frete '.repeat(N / 20)];
  const t0 = performance.now();
  for (const c of casos) s.msg(c.slice(0, N));
  const ms = performance.now() - t0;
  assert.ok(ms < 300, `levou ${ms.toFixed(0)} ms`);
});

// ------------------------------------------------------------------------------------------------ CA2/CA4: link malicioso

test('CA4: link de outro endereço disfarçado (userinfo, subdomínio, sufixo, parâmetro) nunca vira item de loja nem vai à rede', async () => {
  const s = montar();
  s.cadastrar();
  const maus = [
    `https://www.amazon.com.br@evil.example/dp/${ASIN}`,
    `https://www.amazon.com.br.evil.example/dp/${ASIN}`,
    `https://evil.example/?u=https://www.amazon.com.br/dp/${ASIN}`,
    'https://meli.la.evil.example/1AbCdEf',
    'https://xmeli.la/1AbCdEf',
    'https://mercadolivre.com.br.evil.example/MLB-1234567890-x_JM',
    `https://shopee.com.br.evil.example/Fone-i.${SHOP}.${ITEM}`,
    `https://evil.example/shopee.com.br/Fone-i.${SHOP}.${ITEM}`,
  ];
  for (const m of maus) s.msg(`olha ${m}`);
  await s.rodar(); await s.rodar();
  assert.ok(s.itens().every((i) => i.status === 'descartado' && i.codigo === 'sem_link_de_loja' && i.url === ''), JSON.stringify(s.itens().map(statusDe)));
  assert.equal(s.gravados().length, 0);
  assert.deepEqual(s.ml.chamadas, []);
  assert.deepEqual(s.fetchA.chamadas, []);
  assert.equal(acessosRede, 0);
});

test('CA4: o meli.la que não leva a produto (ML não achou o produto) nunca sai; o link do sócio não vai ao grupo', async () => {
  const s = montar();
  s.cadastrar();
  s.ml.resolveOffer = async (c) => ({ key: null, url: c.url, title: 'Algo', price: 10, image: null }); // ficou no meli.la
  s.msg('https://meli.la/1AbCdEf');
  await s.rodar(); await s.rodar();
  assert.deepEqual(statusDe(s.itens()[0]), ['descartado', 'link_invalido']);
  assert.deepEqual(s.nosGrupos(), []);
});

test('CA2 (baixa, lacuna): link do ML ou da Shopee sem "https://" não é reconhecido e o sócio fica sem resposta nenhuma', async () => {
  const s = montar();
  s.cadastrar();
  assert.equal(s.msg('meli.la/1AbCdEf'), 0);
  assert.equal(s.msg(`shopee.com.br/Fone-i.${SHOP}.${ITEM}`), 0);
  assert.deepEqual(s.itens(), []);
  assert.deepEqual(s.respostas(), []);
});

test('CA4: link entre parênteses, com pontuação final e rastreio: o produto certo sai uma vez e o rastreio de terceiro não vai ao grupo', async () => {
  const s = montar();
  s.cadastrar();
  assert.equal(s.msg(`Corre (${URL_AMAZON}). Acaba hoje!`), 1);
  await s.rodar(); await s.rodar();
  assert.deepEqual(statusDe(s.itens()[0]), ['enviado', null]);
  for (const m of s.nosGrupos()) {
    assert.ok(m.text.includes(`https://www.amazon.com.br/dp/${ASIN}?tag=pedro-20`), m.text);
    assert.ok(!/terceiro-20|\)\.|crid/.test(m.text), m.text);
  }
});

// ------------------------------------------------------------------------------------------------ CA7: repetição

test('CA7: o mesmo produto da Amazon por dois encurtadores diferentes na mesma mensagem sai uma vez (mesma_mensagem) e em outra mensagem vira repetida', async () => {
  const s = montar();
  s.cadastrar();
  assert.equal(s.msg(`${URL_AMZN_CURTO} ${URL_AMZN_CURTO2}`), 2, 'sem ASIN no endereço, só a resolução diz que é o mesmo');
  await s.rodar(); await s.rodar();
  assert.deepEqual(s.itens().map(statusDe), [['enviado', null], ['duplicado', 'mesma_mensagem']]);
  assert.equal(s.gravados().length, 1);
  assert.equal(s.msg(URL_AMAZON), 1);
  await s.rodar(); await s.rodar();
  assert.deepEqual(statusDe(s.itens()[2]), ['duplicado', 'repetida']);
  assert.equal(s.gravados().length, 1);
  assert.deepEqual(s.respostas().slice(-1), ['Esse produto já foi enviado há menos de 1 h. Não repeti.']);
});

test('CA7: o mesmo link mandado de novo com outro id de mensagem é repetida e a resposta traz as horas', async () => {
  const s = montar();
  s.cadastrar();
  s.msg(URL_ML); await s.rodar(); await s.rodar();
  s.relogio.t += 5 * HORA + 60000;
  s.msg(URL_ML); await s.rodar(); await s.rodar();
  assert.deepEqual(statusDe(s.itens()[1]), ['duplicado', 'repetida']);
  assert.deepEqual(s.respostas(), ['Enviado para 2 grupos.', 'Esse produto já foi enviado há 5 h. Não repeti.']);
});

test('CA7: remetentes diferentes não se repetem entre si (cada um tem a própria janela)', async () => {
  const s = montar();
  s.cadastrar();
  s.cadastrar({ nome: 'Outro', jid: '5511988887777@s.whatsapp.net' });
  s.msg(URL_ML);
  s.msg(URL_ML, { ids: ['5511988887777@s.whatsapp.net'] });
  await s.rodar(); await s.rodar();
  assert.deepEqual(s.itens().map(statusDe), [['enviado', null], ['enviado', null]]);
});

// ------------------------------------------------------------------------------------------------ CA7: expiração, bordas de tempo

test('CA7: mensagem de exatos 2 h entra e a de 2 h + 1 ms não; hora do futuro (relógio do celular adiantado) vale como agora', () => {
  const s = montar();
  s.cadastrar();
  assert.equal(s.msg(mlN(1), { ts: s.relogio.t - 2 * HORA }), 1);
  assert.equal(s.msg(mlN(2), { ts: s.relogio.t - 2 * HORA - 1 }), 0);
  assert.equal(s.msg(mlN(3), { ts: s.relogio.t + 3 * HORA }), 1);
  assert.equal(s.itens()[1].ts, s.relogio.t, 'a hora do futuro vira "agora"');
  assert.equal(s.msg(mlN(4), { ts: Number.NaN }), 1);
  assert.equal(s.msg(mlN(5), { ts: -5 }), 1);
});

// ------------------------------------------------------------------------------------------------ CA6: foto

test('CA6: "enviar a foto" ligado manda foto com legenda; desligado manda só o texto', async () => {
  const s = montar();
  s.cadastrar({ enviar_foto: 1 });
  s.msg(mlN(1)); await s.rodar(); await s.rodar();
  assert.deepEqual(s.nosGrupos().map((m) => m.tipo), ['image', 'image']);
  const s2 = montar();
  s2.cadastrar({ enviar_foto: 0 });
  s2.msg(mlN(1)); await s2.rodar(); await s2.rodar();
  assert.deepEqual(s2.nosGrupos().map((m) => m.tipo), ['text', 'text']);
});

// ------------------------------------------------------------------------------------------------ CA10: concorrência

test('CA10: o dono desliga o remetente enquanto o programa lê a loja: o item vira "desligado", sem envio nem resposta', async () => {
  const s = montar();
  const id = s.cadastrar();
  let soltar;
  s.estado.mlEspera = new Promise((r) => { soltar = r; });
  s.msg(URL_ML);
  const p = s.rem.processarPendentes(s.relogio.t);
  await new Promise((r) => setImmediate(r));
  s.db.prepare('UPDATE remetentes SET enabled = 0 WHERE id = ?').run(id);
  soltar(); await p;
  await s.rodar();
  assert.deepEqual(statusDe(s.itens()[0]), ['descartado', 'desligado']);
  assert.deepEqual(s.gravados(), []);
  assert.deepEqual(s.respostas(), []);
});

test('CA10: o dono exclui o remetente durante a leitura: item "apagado", sem envio; e trocar os grupos durante a leitura vale a lista nova', async () => {
  const s = montar();
  const id = s.cadastrar();
  let soltar;
  s.estado.mlEspera = new Promise((r) => { soltar = r; });
  s.msg(URL_ML);
  const p = s.rem.processarPendentes(s.relogio.t);
  await new Promise((r) => setImmediate(r));
  s.rem.apagar(id);
  soltar(); await p;
  assert.deepEqual(statusDe(s.itens()[0]), ['descartado', 'apagado']);
  assert.deepEqual(s.gravados(), []);

  const s2 = montar();
  const id2 = s2.cadastrar();
  let soltar2;
  s2.estado.mlEspera = new Promise((r) => { soltar2 = r; });
  s2.msg(URL_ML);
  const p2 = s2.rem.processarPendentes(s2.relogio.t);
  await new Promise((r) => setImmediate(r));
  s2.db.prepare('UPDATE remetentes SET destino_jids = ? WHERE id = ?').run(JSON.stringify([DEST2]), id2);
  soltar2(); await p2;
  assert.deepEqual(s2.gravados().map((e) => JSON.parse(e.group_jids)), [[DEST2]]);
});

test('CA10: a mensagem do sócio chega enquanto o item anterior ainda lê a loja: nada se perde nem duplica', async () => {
  const s = montar();
  s.cadastrar();
  let soltar;
  s.estado.mlEspera = new Promise((r) => { soltar = r; });
  s.msg(mlN(1));
  const p = s.rem.processarPendentes(s.relogio.t);
  await new Promise((r) => setImmediate(r));
  s.msg(mlN(2)); // chega no meio
  soltar(); await p;
  assert.deepEqual(s.itens().map((i) => i.status), ['enviado', 'recebido']);
  await s.rodar(); await s.rodar();
  assert.deepEqual(s.itens().map((i) => i.status), ['enviado', 'enviado']);
  assert.equal(s.gravados().length, 2);
});

test('CA10: orçamento de tempo da passada: com cada leitura levando 25 s, a passada trata um item e deixa o resto para a próxima', async () => {
  const s = montar();
  s.cadastrar({ max_por_hora: 60 });
  s.estado.mlDemora = 25000;
  for (let i = 1; i <= 4; i++) s.msg(mlN(i));
  assert.equal(await s.rem.processarPendentes(s.relogio.t), 1);
  assert.deepEqual(s.itens().map((i) => i.status), ['enviado', 'recebido', 'recebido', 'recebido']);
  s.estado.mlDemora = 0;
  assert.equal(await s.rem.processarPendentes(s.relogio.t), 3);
});

test('CA10: lote de 20 por passada (ordem de chegada); o resto fica recebido', async () => {
  const s = montar();
  s.cadastrar({ max_por_hora: 60 });
  for (let i = 1; i <= 25; i++) s.msg(mlN(i));
  assert.equal(await s.rem.processarPendentes(s.relogio.t), 20);
  assert.equal(s.itens().filter((i) => i.status === 'recebido').length, 5);
  assert.deepEqual(s.itens().slice(0, 20).map((i) => i.status), Array(20).fill('enviado'));
});

test('CA10: dois remetentes processados juntos pelo mesmo ciclo não se misturam (grupos, template e resposta de cada um)', async () => {
  const s = montar();
  s.cadastrar();
  s.cadastrar({ nome: 'Outro', jid: '5511988887777@s.whatsapp.net', destino_jids: JSON.stringify([DEST2]) });
  s.msg(mlN(1));
  s.msg(mlN(2), { ids: ['5511988887777@s.whatsapp.net'] });
  await s.rodar(); await s.rodar();
  const porNome = Object.fromEntries(s.gravados().map((e) => [e.payload.origem.nome, JSON.parse(e.group_jids)]));
  assert.deepEqual(porNome, { [NOME]: [DEST1, DEST2], Outro: [DEST2] });
  const respostas = s.wa.simulated.filter((m) => !m.jid.endsWith('@g.us')).map((m) => [m.jid, m.text]);
  assert.deepEqual(respostas.sort(), [[PN, 'Enviado para 2 grupos.'], ['5511988887777@s.whatsapp.net', 'Enviado para 1 grupo.']].sort());
});

test('CA1/CA10: duas requisições de cadastro do mesmo número ao mesmo tempo: uma cria e a outra recebe 409, nunca 500 nem duplicado', async () => {
  let libera;
  const espera = new Promise((r) => { libera = r; });
  const s = montar({ resolverNumero: async (n) => { await espera; return { jid: `${n}@s.whatsapp.net`, existe: true }; } });
  const corpo = { nome: 'Sócio', numero: '(35) 99999-1234', destino_jids: [DEST1], template_id: 1 };
  const a = s.rem.criar(corpo).then((r) => ({ ok: r }), (e) => ({ erro: e }));
  const b = s.rem.criar(corpo).then((r) => ({ ok: r }), (e) => ({ erro: e }));
  await new Promise((r) => setImmediate(r));
  libera();
  const r = await Promise.all([a, b]);
  assert.equal(r.filter((x) => x.ok).length, 1, JSON.stringify(r.map((x) => x.erro?.message)));
  const falha = r.find((x) => x.erro).erro;
  assert.equal(falha.status, 409);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM remetentes').get().n, 1);
  assert.ok(!falha.message.includes('999991234'));
});

// ------------------------------------------------------------------------------------------------ CA9: dado pessoal no texto

test('CA9: telefone, e-mail, CPF e chave Pix no texto do sócio não vão ao grupo, ao banco nem ao log', async () => {
  const s = montar();
  s.cadastrar();
  const texto = `Chama no zap (35) 99999-1234\nFone Bom por R$ 59,90\npix: pedro.socio@gmail.com cpf 123.456.789-09\n${URL_ML}`;
  s.msg(texto);
  await s.rodar(); await s.rodar();
  const tudo = [JSON.stringify(s.db.prepare('SELECT * FROM remetente_itens').all()), JSON.stringify(s.logs()), JSON.stringify(s.db.prepare('SELECT * FROM envios').all()),
    ...s.nosGrupos().map((m) => m.text)].join('\n');
  for (const x of ['99999-1234', '999991234', 'pedro.socio', 'gmail', '123.456.789-09', '12345678909']) assert.ok(!tudo.includes(x), `vazou ${x}: ${tudo.match(new RegExp(`.{0,40}${x.replace(/[.-]/g, '\\$&')}.{0,40}`))?.[0]}`);
});

test('CA9: título vindo da 1ª linha do texto com telefone colado ou link wa.me não leva o número ao grupo', async () => {
  const s = montar();
  s.cadastrar();
  s.msg(`wa.me/5535999991234 Fone Bom por R$ 59,90 ${URL_AMAZON}`);
  s.msg(`35999991234 chama no zap Caixa de Som por R$ 59,90 ${URL_SHOPEE}`);
  await s.rodar(); await s.rodar();
  const tudo = [JSON.stringify(s.db.prepare('SELECT * FROM remetente_itens').all()), ...s.nosGrupos().map((m) => m.text)].join('\n');
  assert.ok(!tudo.includes('999991234'), tudo);
});

test('CA9: o número do sócio não aparece em nenhuma linha do banco além da tabela remetentes, nem no console, em todo o ciclo', async (t) => {
  const espias = ['error', 'warn', 'log', 'info'].map((m) => t.mock.method(console, m, () => {}));
  const s = montar();
  s.cadastrar({ lid: LID });
  s.msg(URL_ML, { ids: [PN, LID] }); s.msg('https://exemplo.com/x'); s.msg(mlN(2), { ids: [PN] });
  s.estado.mlEspera = null;
  s.envios.montarOferta = async () => { throw new Error(`falha ${PN} ${LID}`); };
  await s.rodar(); await s.rodar();
  const num = [NUMERO, NUMERO.slice(2), '999991234', LID.replace('@lid', '')];
  const outras = ['log', 'remetente_itens', 'envios', 'envio_resultados', 'groups', 'settings'].map((tb) => JSON.stringify(s.db.prepare(`SELECT * FROM ${tb}`).all())).join('\n');
  const consola = espias.flatMap((e) => e.mock.calls.map((c) => c.arguments.map(String).join(' '))).join('\n');
  for (const n of num) { assert.ok(!outras.includes(n), `banco leva ${n}`); assert.ok(!consola.includes(n), `console leva ${n}`); }
});

// ------------------------------------------------------------------------------------------------ CA8: respostas

test('CA8: teto de 20 respostas por hora conta por remetente e libera depois da hora', async () => {
  const s = montar();
  s.cadastrar({ max_por_hora: 60 });
  s.cadastrar({ nome: 'Outro', jid: '5511988887777@s.whatsapp.net', max_por_hora: 60 });
  for (let i = 1; i <= 21; i++) s.msg(`Link ${i} de nada https://exemplo.com/${i}`); // 21 mensagens sem link de loja: cada uma pede resposta
  s.msg('https://exemplo.com/outro', { ids: ['5511988887777@s.whatsapp.net'] });
  await s.rem.responderPendentes(s.relogio.t);
  const por = (jid) => s.wa.simulated.filter((m) => m.jid === jid).length;
  assert.equal(por(PN), 20);
  assert.equal(por('5511988887777@s.whatsapp.net'), 1, 'o teto de um não segura o outro');
  s.relogio.t += HORA + 1;
  await s.rem.responderPendentes(s.relogio.t);
  assert.equal(por(PN), 20, 'a 21ª já foi marcada como respondida e não sai depois');
});

test('CA8: "responder" desligado no meio: quem já estava na fila não recebe resposta, e ligar de novo não faz sair a antiga', async () => {
  const s = montar();
  const id = s.cadastrar();
  s.msg(URL_ML);
  await s.rem.processarPendentes(s.relogio.t);
  s.db.prepare('UPDATE remetentes SET responder = 0 WHERE id = ?').run(id);
  await s.rodar();
  s.db.prepare('UPDATE remetentes SET responder = 1 WHERE id = ?').run(id);
  await s.rodar();
  assert.deepEqual(s.respostas(), []);
});

test('CA8: o envio pausado só é respondido depois de retomado e concluído', async () => {
  const s = montar();
  s.cadastrar();
  s.msg(URL_ML);
  await s.rem.processarPendentes(s.relogio.t);
  s.db.prepare("UPDATE envios SET status = 'pausado'").run();
  await s.rodar();
  assert.deepEqual(s.respostas(), []);
  s.db.prepare("UPDATE envios SET status = 'pendente'").run();
  await s.rodar(); await s.rodar();
  assert.deepEqual(s.respostas(), ['Enviado para 2 grupos.']);
});

// ------------------------------------------------------------------------------------------------ CA9/CA10: retenção e reinício

test('CA10: reinício com atraso: item "processando" que passou de 2 h ao voltar expira sem enviar nem responder', async () => {
  const s = montar();
  s.cadastrar();
  s.msg(URL_ML);
  s.db.prepare("UPDATE remetente_itens SET status = 'processando'").run();
  s.relogio.t += 3 * HORA;
  const novo = s.criar();
  assert.equal(novo.recuperar(), 1);
  await s.rodar(novo); await s.rodar(novo);
  assert.deepEqual(statusDe(s.itens()[0]), ['descartado', 'expirado']);
  assert.deepEqual(s.gravados(), []);
  assert.deepEqual(s.respostas(), []);
});

test('CA10: reinício depois da decisão e antes da resposta: a resposta sai uma vez só, mesmo com duas instâncias', async () => {
  const s = montar();
  s.cadastrar();
  s.msg(URL_ML);
  await s.rem.processarPendentes(s.relogio.t);
  await s.envios.processarPendentes(s.relogio.t);
  const outra = s.criar();
  await Promise.all([s.rem.responderPendentes(s.relogio.t), outra.responderPendentes(s.relogio.t)]);
  await Promise.all([s.rem.responderPendentes(s.relogio.t), outra.responderPendentes(s.relogio.t)]);
  assert.deepEqual(s.respostas(), ['Enviado para 2 grupos.']);
});

test('CA9: limpar() nunca apaga item ainda na fila nem o que conta para "horas sem repetir"; o resto vai embora', async () => {
  const s = montar();
  s.cadastrar({ dedupe_horas: 24 });
  s.msg(URL_ML); await s.rodar(); await s.rodar();
  s.relogio.t += 10 * 86400000;
  s.msg(mlN(2)); // fica recebido
  s.msg('https://exemplo.com/x');
  const antes = s.itens().length;
  const r = s.rem.limpar(7, s.relogio.t);
  assert.equal(r.itens, 1, 'o enviado (fora da janela de 24 h) vai embora');
  assert.equal(s.itens().length, antes - 1);
  assert.ok(s.itens().some((i) => i.status === 'recebido'));
});

test('CA10: nenhum teste deste arquivo acessou a rede de verdade', () => {
  assert.equal(acessosRede, 0);
});

// ------------------------------------------------------------------------------------------------ CA7 com o leitor real do ML

const URL_PRODUTO_ML = 'https://www.mercadolivre.com.br/tablet-x/p/MLB79725856';
const paginaSocialMl = () => `<html><head><meta property="og:title" content="Tablet X - R$ 725"/><meta property="og:image" content="${IMG}"/></head><body>
<script>window.__PRELOADED_STATE__ = ${JSON.stringify({ page: { components: [{ id: 'card-featured', polycards: [{
  metadata: { id: 'MLB0000000001', product_id: 'MLB79725856', url: URL_PRODUTO_ML },
  components: [{ type: 'price', id: 'price', price: { current_price: { value: 725, currency: 'BRL' } } }] }] }] } })};</script></body></html>`;

/** O leitor REAL do ML (src/ml.js resolveOffer) com a página social falsa: o meli.la leva ao produto, como na Central. */
function comLeitorRealDoMl(s) {
  const lidos = [];
  s.ml.resolveOffer = (cand) => { lidos.push(cand.url); return resolveOfferReal(cand, { fetchText: async () => paginaSocialMl() }); };
  return lidos;
}

test('CA7 (real): dois meli.la diferentes do mesmo produto, em mensagens diferentes, saem uma vez só (a chave é a do produto, não a do meli.la)', async () => {
  const s = montar();
  s.cadastrar();
  comLeitorRealDoMl(s);
  s.msg('Olha esse https://meli.la/1AbCdEf'); await s.rodar(); await s.rodar();
  s.msg('Outro afiliado mandou https://meli.la/2ZyXwVu'); await s.rodar(); await s.rodar();
  assert.deepEqual(s.itens().map(statusDe), [['enviado', null], ['duplicado', 'repetida']], `chaves: ${JSON.stringify(s.itens().map((i) => i.chave))}`);
  assert.equal(s.gravados().length, 1);
});

test('CA7 (real): dois meli.la diferentes do mesmo produto na mesma mensagem saem uma vez só (mesma_mensagem)', async () => {
  const s = montar();
  s.cadastrar();
  comLeitorRealDoMl(s);
  s.msg('https://meli.la/1AbCdEf https://meli.la/2ZyXwVu'); await s.rodar(); await s.rodar();
  assert.deepEqual(s.itens().map(statusDe), [['enviado', null], ['duplicado', 'mesma_mensagem']], `chaves: ${JSON.stringify(s.itens().map((i) => i.chave))}`);
  assert.equal(s.gravados().length, 1);
});

// ------------------------------------------------------------------------------------------------ CA9/CA12: servidor de verdade

async function subirServidor() {
  const [{ buildApp, criarServicos }, http] = await Promise.all([import('../src/server.js'), import('node:http')]);
  const dir = tmp();
  const db = openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const mlSemRede = { async resolveOffer(c) { return { key: 'MLB1234567890', url: c.url, title: 'Fone Bom', price: 89.9, oldPrice: null, discountPct: null, sold: 1, freeShipping: false, image: IMG }; } };
  const { amazon, shopee, catalogo, catalogoItens, scheduler } = criarServicos({ db, wa, links, fast: true, dir, fetch: async () => { throw new Error('rede proibida'); }, ml: mlSemRede });
  const app = buildApp({ db, wa, links, scheduler, amazon, shopee, catalogo, catalogoItens, publicHost: '', panelPassword: '', ml: mlSemRede });
  const server = await new Promise((ok) => { const sv = app.listen(0, '127.0.0.1', () => ok(sv)); });
  const port = server.address().port;
  const req = (caminho, { method = 'GET', body, headers = {} } = {}) => new Promise((ok, err) => {
    const data = body != null ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, path: caminho, method, headers: { host: `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let txt = ''; res.setEncoding('utf8'); res.on('data', (c) => (txt += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(txt); } catch { /* html */ } ok({ status: res.statusCode, json, txt }); });
    });
    r.on('error', err); if (data) r.write(data); r.end();
  });
  return { db, wa, scheduler, req, fechar: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => { db.close(); r(); }); }) };
}

test('CA1/CA9/CA12: cadastro pela API real; mensagem do sócio vira envio; nenhuma rota de leitura devolve o número nem o LID', async (t) => {
  const espias = ['error', 'warn', 'log', 'info'].map((m) => t.mock.method(console, m, () => {}));
  const s = await subirServidor();
  try {
    for (const [jid, nome] of GRUPOS) s.db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, nome, 10, Date.now());
    s.db.prepare("INSERT INTO tags (name, created_at) VALUES ('etiquetaA', 1)").run();
    const criado = await s.req('/api/remetentes', { method: 'POST', body: { nome: 'Sócio Pedro', numero: '(35) 99999-1234', destino_jids: [DEST1], template_id: 1, max_por_hora: 5 } });
    assert.equal(criado.status, 200, criado.txt);
    assert.deepEqual(Object.keys(criado.json), ['id']);
    const jidCanonico = s.db.prepare('SELECT jid FROM remetentes').get().jid;
    // mensagem do sócio (com pushName, que nunca deve passar) por LID + número
    await s.wa._onMensagens({ type: 'notify', messages: [{ key: { remoteJid: LID, remoteJidAlt: jidCanonico, fromMe: false, id: 'S1' }, pushName: 'Pedro Silva', messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: `Olha ${URL_ML}` } }] });
    for (let i = 0; i < 40 && !s.wa.simulated.some((m) => m.jid === jidCanonico); i++) { await s.scheduler.tick(); await new Promise((r) => setTimeout(r, 10)); }
    assert.ok(s.wa.simulated.some((m) => m.jid === jidCanonico), 'a resposta ao sócio saiu');
    assert.equal(s.wa.simulated.filter((m) => m.jid === DEST1).length, 1);

    const rotas = ['/api/remetentes', '/api/remetentes/itens', '/api/simulados', '/api/log', '/api/envios?tipo=oferta', '/api/state', '/api/groups', '/api/rules', '/api/overview'];
    for (const r of rotas) {
      const resp = await s.req(r);
      assert.equal(resp.status, 200, `${r}: ${resp.status}`);
      for (const x of [NUMERO, '999991234', LID.replace('@lid', ''), 'Pedro Silva']) assert.ok(!resp.txt.includes(x), `${r} devolve ${x}`);
    }
    // o banco, fora da tabela remetentes, também não guarda o número
    const fora = ['log', 'remetente_itens', 'envios', 'envio_resultados', 'settings'].map((tb) => JSON.stringify(s.db.prepare(`SELECT * FROM ${tb}`).all())).join('\n');
    for (const x of [NUMERO, '999991234', LID.replace('@lid', ''), 'Pedro Silva']) assert.ok(!fora.includes(x), `banco leva ${x}`);
    const consola = espias.flatMap((e) => e.mock.calls.map((c) => c.arguments.map(String).join(' '))).join('\n');
    for (const x of [NUMERO, '999991234', LID.replace('@lid', ''), 'Pedro Silva']) assert.ok(!consola.includes(x), `console leva ${x}`);
    assert.equal(s.db.prepare('SELECT lid FROM remetentes').get().lid, LID, 'o LID foi aprendido pela mensagem');

    // CSRF: escrita com Origin de outro site é recusada
    const csrf = await s.req('/api/remetentes', { method: 'POST', headers: { origin: 'https://evil.example' }, body: { nome: 'X', numero: '(35) 98888-0000', destino_jids: [DEST1], template_id: 1 } });
    assert.ok([400, 403].includes(csrf.status), `Origin estranho passou: ${csrf.status}`);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM remetentes').get().n, 1);
  } finally { await s.fechar(); }
});

// ------------------------------------------------------------------------------------------------ rodada 2: regressões das correções

const catalogoN = (n, slug = 'tablet-x') => `https://www.mercadolivre.com.br/${slug}/p/MLB${n}`;

test('rodada 2 / Q1: catálogo (/p/MLB…) e anúncio (MLB-…) com os mesmos dígitos são produtos diferentes: os dois saem; o mesmo catálogo com outro slug e rastreio é repetida', async () => {
  const s = montar();
  s.cadastrar();
  const digitos = '3000000777';
  s.msg(`${catalogoN(digitos)} https://produto.mercadolivre.com.br/MLB-${digitos}-fone-_JM`);
  await s.rodar(); await s.rodar();
  assert.deepEqual(s.itens().map(statusDe), [['enviado', null], ['enviado', null]]);
  assert.deepEqual(s.itens().map((i) => i.chave).sort(), [`CATALOGO:MLB${digitos}`, `MLB${digitos}`]);
  s.msg(`${catalogoN(digitos, 'outro-slug')}?pdp_filters=item_id:MLB999&matt_tool=123#polycard`);
  await s.rodar(); await s.rodar();
  assert.deepEqual(statusDe(s.itens()[2]), ['duplicado', 'repetida']);
  s.msg(catalogoN('3000000888'));
  await s.rodar(); await s.rodar();
  assert.deepEqual(statusDe(s.itens()[3]), ['enviado', null], 'outro catálogo não é repetição');
  assert.equal(s.gravados().length, 3);
});

test('rodada 2 / Q1: o anúncio com outro slug, caixa diferente e rastreio é repetida; nada de query ou fragmento vai ao banco nem ao grupo', async () => {
  const s = montar();
  s.cadastrar();
  s.msg('https://produto.mercadolivre.com.br/MLB-3000000555-fone-bom-_JM?matt_tool=77&matt_word=terceiro#polycard_client=search');
  await s.rodar(); await s.rodar();
  s.msg('https://produto.mercadolivre.com.br/mlb-3000000555-outro-nome-_JM?utm_source=x');
  await s.rodar(); await s.rodar();
  assert.deepEqual(s.itens().map(statusDe), [['enviado', null], ['duplicado', 'repetida']]);
  for (const i of s.itens()) assert.ok(!/[?#]|matt_|terceiro|utm_/.test(i.url), `url gravada com rastreio: ${i.url}`);
  for (const m of s.nosGrupos()) assert.ok(!/matt_|terceiro|polycard|utm_/.test(m.text), m.text);
  assert.ok(s.ml.chamadas.every((u) => !/[?#]/.test(u)), `a leitura recebeu rastreio: ${s.ml.chamadas}`);
});

test('rodada 2 / Q1: o meli.la que leva ao catálogo (leitor real) e o mesmo catálogo mandado direto saem uma vez só', async () => {
  const s = montar();
  s.cadastrar();
  comLeitorRealDoMl(s);
  s.msg('https://meli.la/1AbCdEf'); await s.rodar(); await s.rodar();
  s.msg(`${URL_PRODUTO_ML}?matt_tool=1`); await s.rodar(); await s.rodar();
  assert.deepEqual(s.itens().map(statusDe), [['enviado', null], ['duplicado', 'repetida']], JSON.stringify(s.itens().map((i) => i.chave)));
});

test('rodada 2 / S1: ML de origem remetente por http nunca chega à Central; userinfo no endereço nunca é gravado nem vai ao grupo', async () => {
  const s = montar();
  s.cadastrar();
  s.msg('http://produto.mercadolivre.com.br/MLB-3000000111-x-_JM');
  s.msg('https://usuario:SENHA-x9@produto.mercadolivre.com.br/MLB-3000000112-x-_JM');
  await s.rodar(); await s.rodar();
  assert.notEqual(s.itens()[0].status, 'enviado', 'http não sai');
  assert.ok(!JSON.stringify(s.itens()).includes('SENHA-x9'), 'userinfo no banco');
  assert.ok(!JSON.stringify(s.gravados()).includes('SENHA-x9'), 'userinfo na fila de envios');
  for (const m of s.nosGrupos()) assert.ok(!m.text.includes('SENHA-x9'), m.text);
});

test('rodada 2 / R5: a mesma mensagem reentregue com rastreio diferente no mesmo link é um item só; links só diferentes no rastreio na mesma mensagem também', async () => {
  const s = montar();
  s.cadastrar();
  const base = 'https://produto.mercadolivre.com.br/MLB-3000000321-fone-_JM';
  assert.equal(s.msg(`${base}?a=1`, { msgId: 'DUP1' }), 1);
  assert.equal(s.msg(`${base}?a=2#x`, { msgId: 'DUP1' }), 0, 'reentrega com outra query cai no índice único (url limpa)');
  assert.equal(s.msg(`${base}?a=3 ${base}#frag ${base}`, { msgId: 'DUP2' }), 1, 'três grafias do mesmo endereço na mesma mensagem');
  assert.equal(s.itens().length, 2);
  assert.ok(s.itens().every((i) => i.url === base), JSON.stringify(s.itens().map((i) => i.url)));
});

test('rodada 2 / Q2: o limite por hora com itens de banco antigo (chegou_em vazio): vale o ts; o que passou de 1 h sai da conta', async () => {
  const s = montar();
  s.cadastrar({ max_por_hora: 2 });
  assert.equal(s.msg(mlN(1)), 1);
  assert.equal(s.msg(mlN(2)), 1);
  s.db.prepare('UPDATE remetente_itens SET chegou_em = NULL').run(); // como os itens da versão anterior
  assert.equal(s.msg(mlN(3)), 1, 'limite: a 3ª vira a linha "limite"');
  assert.deepEqual(s.itens().map(statusDe).slice(2), [['descartado', 'limite']]);
  s.relogio.t += HORA + 1;
  assert.equal(s.msg(mlN(4)), 1);
  assert.deepEqual(statusDe(s.itens()[3]), ['recebido', null], 'os itens antigos saíram da janela da hora');
});

test('rodada 2 / Q3: linha de limite de banco antigo (qtd_links vazio) conta como 1 link na resposta; a nova conta os cortados', async () => {
  const s = montar();
  s.cadastrar({ max_por_hora: 1 });
  s.msg(`${mlN(1)} ${mlN(2)} ${mlN(3)}`);
  s.db.prepare("UPDATE remetente_itens SET qtd_links = NULL WHERE codigo = 'limite'").run();
  await s.rodar(); await s.rodar();
  assert.deepEqual(s.respostas(), ['Recebi 2 links: 1 enviado, 1 não enviado.']);
});

test('rodada 2 / Q3: a mensagem de 1 link só, já no limite, responde sobre 1 link e não "Recebi 1 links"', async () => {
  const s = montar();
  s.cadastrar({ max_por_hora: 1 });
  s.msg(mlN(1)); await s.rodar(); await s.rodar();
  s.msg(mlN(2)); await s.rodar(); await s.rodar();
  const r = s.respostas();
  assert.equal(r.length, 2);
  assert.ok(!/Recebi \d+ links?:/.test(r[1]) || r[1] === 'Recebi 1 link: 1 não enviado.', r[1]);
  assert.ok(!/^Recebi 1 links/.test(r[1]), r[1]);
});

test('rodada 2 / R3: número no remoteJid e LID no remoteJidAlt: o LID é aprendido; depois a mensagem só com o LID casa sem consultar o mapa', async () => {
  const s = montar();
  const id = s.cadastrar();
  s.wa._usarSocket({ user: { id: '5511900000000:7@s.whatsapp.net' }, signalRepository: { lidMapping: { getPNForLID: async () => { throw new Error('mapa fora'); } } } });
  s.wa.onPrivada((m) => s.rem.receber(m));
  await s.wa._onMensagens(upsert({ remoteJid: PN, remoteJidAlt: LID }, mlN(1), 'L1'));
  assert.equal(s.db.prepare('SELECT lid FROM remetentes WHERE id = ?').get(id).lid, LID);
  await s.wa._onMensagens(upsert({ remoteJid: LID }, mlN(2), 'L2'));
  assert.deepEqual(s.itens().map((i) => i.msg_id), ['L1', 'L2']);
});

test('rodada 2 / R3: o LID de outro remetente no remoteJidAlt não troca o dono da mensagem nem rouba o LID dele', () => {
  const s = montar();
  const outroPn = '5535988887777@s.whatsapp.net';
  const outroLid = '999000111222333@lid';
  const a = s.cadastrar({ nome: 'A' });
  const b = s.cadastrar({ nome: 'B', jid: outroPn, lid: outroLid });
  assert.equal(s.rem.receber({ ids: [PN, outroLid], texto: mlN(1), msgId: 'X1', ts: s.relogio.t }), 1);
  assert.deepEqual(s.itens().map((i) => i.remetente_id), [a], 'o número vale mais que o LID');
  assert.equal(s.db.prepare('SELECT lid FROM remetentes WHERE id = ?').get(b).lid, outroLid);
  assert.equal(s.db.prepare('SELECT lid FROM remetentes WHERE id = ?').get(a).lid, null);
});
