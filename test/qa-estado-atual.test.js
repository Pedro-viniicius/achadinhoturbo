// QA, avaliação do estado atual do espelhamento da Amazon (rodada 1, 03/11/2026): testes que reproduzem achados
// em src/espelho.js, src/template.js, src/privacidade.js e a ligação pendente (etapa 13). Os de "bug" falham de
// propósito até a correção do dev; os de "ETAPA 13 PENDENTE" falham até o scheduler/server.js ligarem o espelho.
// Mesma base de test/espelho.test.js: createEspelho direto, fila de envios real, WhatsApp em dryRun, fetch falso da
// Amazon e fetch global bloqueado.
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
import { createEnvios } from '../src/envios.js';
import { createScheduler } from '../src/scheduler.js';
import { createAmazon } from '../src/amazon.js';
import { FIXTURES } from '../src/oferta-texto.js';
import { createEspelho } from '../src/espelho.js';
import { renderTemplate } from '../src/template.js';
import { mascararPessoais } from '../src/privacidade.js';

let acessosRede = 0;
globalThis.fetch = async () => { acessosRede++; throw new Error('rede proibida no teste'); };

const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-qaea-')); pastas.push(p); return p; };

const HORA = 3600000;
const ORIGEM = '100@g.us';
const DEST1 = '200@g.us';
const DEST2 = '300@g.us';
const GRUPOS = [[ORIGEM, 'Ofertas Origem'], [DEST1, 'Achadinhos Tech'], [DEST2, 'Tech Dois']];
const ASIN = 'B0FG2MD49G';
const TAG = 'pedro-20';
const TOKEN = 'token-oauth-qa';
const URL_CURTO = 'https://link.amazon/2q3Xk9Z';
const IMG = 'https://m.media-amazon.com/images/I/71abcDEF.jpg';

const respJson = (status, corpo) => new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } });

/** fetch falso da Amazon: curtos → Location; token; GetItems (api 'ok' | '403'). */
function fetchAmazon(estado) {
  return async (url, init = {}) => {
    const u = String(url);
    if (Object.hasOwn(estado.curtos, u)) return new Response(null, { status: 301, headers: { location: estado.curtos[u] } });
    if (u === 'https://api.amazon.com/auth/o2/token') return respJson(200, { access_token: TOKEN, token_type: 'bearer', expires_in: 3600 });
    if (u === 'https://creatorsapi.amazon/catalog/v1/getItems') {
      if (estado.api === '403') return respJson(403, { type: 'AccessDeniedException', reason: 'AssociateNotEligible' });
      const pedidos = JSON.parse(init.body).itemIds;
      return respJson(200, { itemsResult: { items: pedidos.map((asin) => ({
        asin, itemInfo: { title: { displayValue: 'Roteador Mesh TP-Link Deco BE22' } },
        images: { primary: { large: { url: IMG } } },
        offersV2: { listings: [{ isBuyBoxWinner: true, availability: { type: 'IN_STOCK' }, price: { money: { amount: 1310.05 }, savingBasis: { money: { amount: 1999 } }, savings: { percentage: 34 } } }] },
      })) } });
    }
    throw new Error('rede não prevista no teste');
  };
}

function montar({ api = 'ok' } = {}) {
  const dir = tmp();
  const db = openDb(dir);
  for (const [jid, nome] of GRUPOS) db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, nome, 10, Date.now());
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const estado = { api, curtos: { [URL_CURTO]: `https://www.amazon.com.br/Roteador/dp/${ASIN}?tag=terceiro-20&crid=X` } };
  const conexao = { tag: TAG, credencial_versao: '3.1', credencial_id: 'credencial-id-0001', credencial_secret: 'segredo-super-secreto-123' };
  const amazon = createAmazon({ db, fetch: fetchAmazon(estado), esperar: async () => {}, lerConexao: () => conexao });
  const envios = createEnvios({ db, wa, links, ml: null, fast: true, dir, amazon });
  const relogio = { t: Date.now() };
  const espelho = createEspelho({ db, wa, amazon, envios, acordar: () => {}, agora: () => relogio.t });
  const tplAmazon = db.prepare("SELECT id FROM templates WHERE name = 'Amazon'").get().id;
  let seq = 0;
  return {
    dir, db, wa, envios, amazon, espelho, estado, relogio, tplAmazon,
    regra: (extra = {}) => espelho.criar({ nome: 'Amazon → Achadinhos', origem_jids: [ORIGEM], destino_jids: [DEST1, DEST2], template_id: tplAmazon, ...extra }).id,
    receber: (texto, o = {}) => espelho.receber({ jid: ORIGEM, fromMe: false, texto, msgId: `MSG${++seq}`, ts: relogio.t, ...o }),
    async rodar() { const n = await espelho.processarPendentes(relogio.t); await envios.processarPendentes(relogio.t); return n; },
    itens: () => db.prepare('SELECT * FROM espelho_itens ORDER BY id').all().map((r) => ({ ...r })),
    item: (id) => ({ ...db.prepare('SELECT * FROM espelho_itens WHERE id = ?').get(id) }),
    enviados: () => wa.simulated.filter((m) => m.jid !== 'status@broadcast'),
  };
}

// ------------------------------------------------------------------------------------------------ CA4

test('Q1 (CA4): dois itens da fila com o mesmo ASIN: completar o primeiro não deixa o segundo sair de novo dentro de dedupe_horas', async () => {
  const s = montar({ api: '403' });
  s.regra({ dedupe_horas: 168 });
  s.estado.curtos['https://amzn.to/outro'] = `https://www.amazon.com.br/dp/${ASIN}`;
  s.receber(FIXTURES.soLink);
  s.receber('https://amzn.to/outro'); // o mesmo produto, em outra mensagem, ainda sem preço
  await s.rodar();
  assert.deepEqual(s.itens().map((i) => [i.asin, i.status]), [[ASIN, 'na_fila'], [ASIN, 'na_fila']], 'pré-condição: os dois esperam na fila');

  await s.espelho.completar(1, { ajustes: { title: 'Roteador Mesh', price: '1310,05' } });
  await s.envios.processarPendentes(s.relogio.t);
  const antes = s.enviados().length;
  assert.equal(antes, 2, 'o primeiro saiu para os dois destinos');

  // o segundo é o mesmo produto, dentro da janela de 168 h: não pode sair de novo (ou é recusado, ou já virou "repetida")
  const tentativa = await s.espelho.completar(2, { ajustes: { title: 'Roteador Mesh', price: '1310,05' } }).then(() => 'enviou', (e) => `recusou: ${e.message}`);
  await s.envios.processarPendentes(s.relogio.t);
  assert.equal(s.enviados().length, antes, `o mesmo ASIN saiu duas vezes pelo mesmo espelho dentro de 168 h (${tentativa})`);
});

test('Q2 (CA4): envio que falhou em todos os grupos não conta como "enviada" para a deduplicação', async () => {
  const s = montar();
  s.regra({ dedupe_horas: 168 });
  const reais = { sendText: s.wa.sendText, sendImage: s.wa.sendImage }; // funções próprias do objeto (não há protótipo)
  s.wa.sendText = async () => { throw new Error('WhatsApp caiu'); };
  s.wa.sendImage = async () => { throw new Error('WhatsApp caiu'); };
  s.receber(FIXTURES.linkLongo);
  await s.rodar();
  const resultados = s.db.prepare('SELECT ok FROM envio_resultados').all().map((r) => r.ok);
  assert.deepEqual(resultados, [0, 0], 'pré-condição: nenhum grupo recebeu');
  assert.equal(s.enviados().length, 0);

  // o grupo de origem posta a oferta de novo 1 h depois, com o WhatsApp de volta: é a segunda chance
  s.relogio.t += HORA;
  Object.assign(s.wa, reais); // volta às funções reais (dryRun); `delete` as apagaria de vez
  s.receber(FIXTURES.linkLongo);
  await s.rodar();
  const segundo = s.item(2);
  assert.notEqual(segundo.status, 'duplicado', `a oferta nunca chegou a nenhum grupo, mas foi descartada: ${segundo.motivo}`);
  assert.equal(s.enviados().length, 2, 'a segunda postagem sai para os dois destinos');
});

// ------------------------------------------------------------------------------------------------ CA8

test('Q3 (CA8): template existente com colchetes literais em volta de um placeholder renderiza como antes', { todo: 'decisão do dono: colchetes com placeholder' }, () => {
  const oferta = { title: 'Fone Bluetooth', price: 89.9, oldPrice: 149.9, coupon: 'ABC10', link: 'https://meli.la/x', sold: 0, freeShipping: false };
  // antes da sintaxe "[ … ]" estes textos saíam com os colchetes; "Templates existentes renderizam exatamente como hoje"
  assert.equal(renderTemplate('[{TITULO_PRODUTO}] por {PRECO_PRODUTO}', oferta), '[Fone Bluetooth] por R$ 89,90');
  assert.equal(renderTemplate('Cupom: [{CUPOM}]', oferta), 'Cupom: [ABC10]');
  assert.equal(renderTemplate('Compre: [{LINK}]', oferta), 'Compre: [https://meli.la/x]');
});

// ------------------------------------------------------------------------------------------------ CA11

test('Q4 (CA11): telefone escrito com " - " ou travessão entre os blocos não chega inteiro ao banco', () => {
  const casos = [
    ['Chama no zap 31 - 99999 - 8888', ['99999', '8888']],
    ['Chama no zap 31 99999–8888', ['99999', '8888']],       // travessão (en dash)
    ['Chama no zap 31 99999‑8888', ['99999', '8888']],       // hífen que não quebra (U+2011)
    ['Zap +55 (31) 99999 - 8888', ['99999', '8888']],
  ];
  for (const [texto, pedacos] of casos) {
    const m = mascararPessoais(texto);
    for (const p of pedacos) assert.ok(!m.includes(p), `"${texto}" saiu como "${m}" e ainda tem ${p}`);
  }
});

// ------------------------------------------------------------------------------------------------ ETAPA 13

test('ETAPA 13 PENDENTE (CA1): createScheduler com a Amazon cria o espelho e o tick o processa depois dos envios', async () => {
  const dir = tmp();
  const db = openDb(dir);
  for (const [jid, nome] of GRUPOS) db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, nome, 10, Date.now());
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const estado = { api: 'ok', curtos: { [URL_CURTO]: `https://www.amazon.com.br/dp/${ASIN}` } };
  const conexao = { tag: TAG, credencial_versao: '3.1', credencial_id: 'credencial-id-0001', credencial_secret: 'segredo-super-secreto-123' };
  const amazon = createAmazon({ db, fetch: fetchAmazon(estado), esperar: async () => {}, lerConexao: () => conexao });
  const scheduler = createScheduler({ db, wa, links, fast: true, dir, amazon });
  assert.ok(scheduler.espelho, 'o agendador precisa expor o espelho (plano, etapa 13)');
  const tpl = db.prepare("SELECT id FROM templates WHERE name = 'Amazon'").get().id;
  scheduler.espelho.criar({ nome: 'E2E', origem_jids: [ORIGEM], destino_jids: [DEST1], template_id: tpl });
  // o handler do ouvinte é ligado ao espelho pelo server.js (createWhatsApp({ onMensagem })); aqui faz o mesmo
  wa.onMensagem((m) => scheduler.espelho.receber(m));
  wa._onMensagens({ type: 'notify', messages: [{ key: { remoteJid: ORIGEM, fromMe: false, id: 'E2E2' }, message: { conversation: URL_CURTO }, messageTimestamp: Math.floor(Date.now() / 1000) }] });
  // receber() acorda o agendador (acordar → tick); espera o envio sair, no máximo 5 s
  for (let i = 0; i < 100 && !wa.simulated.some((m) => m.jid === DEST1); i++) await new Promise((ok) => setTimeout(ok, 50));
  assert.equal(wa.simulated.filter((m) => m.jid === DEST1).length, 1, 'a oferta espelhada saiu logo depois da mensagem');
  db.close();
});

test('CA6/CA7 (rodada 2): o servidor montado por criarServicos identifica um link da Amazon sem credencial (causa da API, não "indisponível neste servidor")', async () => {
  const dir = tmp();
  const db = openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  // mesmo caminho do main de src/server.js: um cliente da Amazon só, lendo a conexão salva no banco (só a tag, sem credencial)
  db.prepare("INSERT INTO conexoes (plataforma, config, segredos, updated_at) VALUES ('amazon', ?, '{}', ?)").run(JSON.stringify({ tag: TAG }), Date.now());
  const { amazon, scheduler } = criarServicos({ db, wa, links, fast: true, dir, fetch: fetchAmazon({ api: 'ok', curtos: {} }) });
  const app = buildApp({ db, wa, links, scheduler, publicHost: '', panelPassword: '', amazon });
  const server = await new Promise((ok) => { const sv = app.listen(0, '127.0.0.1', () => ok(sv)); });
  try {
    const { port } = server.address();
    const r = await new Promise((ok, err) => {
      const corpo = JSON.stringify({ url: `https://www.amazon.com.br/dp/${ASIN}` });
      const rq = http.request({ host: '127.0.0.1', port, path: '/api/disparo/identificar', method: 'POST', headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(corpo) } }, (res) => {
        let txt = ''; res.setEncoding('utf8'); res.on('data', (c) => (txt += c));
        res.on('end', () => ok({ status: res.statusCode, json: JSON.parse(txt) }));
      });
      rq.on('error', err); rq.end(corpo);
    });
    assert.equal(r.status, 200, `identificar respondeu ${r.status}: ${r.json.erro}`);
    assert.equal(r.json.editavel, true);
    assert.equal(r.json.causa, 'sem_credenciais');
    assert.equal(r.json.tag_salva, true);
    assert.equal(r.json.produto.key, `ASIN:${ASIN}`);
  } finally {
    server.closeAllConnections?.(); await new Promise((ok) => server.close(ok)); db.close();
  }
});

test('QA: este arquivo não acessou a rede (o fetch global ficou bloqueado)', () => {
  assert.equal(acessosRede, 0);
});
