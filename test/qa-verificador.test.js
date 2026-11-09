// QA, verificador de preço e estoque, rodada 1 (docs/produto/planos/verificador-preco-estoque.md; CA1 a CA7).
// Complementa test/verificador*.test.js do dev: aqui o verificador de verdade passa pelos módulos de verdade (espelho,
// remetente, "Enviar" da revisão do Catálogo, Disparo manual, regras), sem gravar payload na mão, e cada teste caça uma
// borda que os outros não pegam: cancelamento e concorrência durante a conferência, Magalu agendada, nenhum dado da loja
// em log ou console, nenhum nível `erro` por descarte (viraria aviso por WhatsApp) e o main de src/server.js em DRY_RUN.
// Nenhuma loja real: o fetch global é bloqueado (e o último teste prova que ninguém o chamou), as lojas são falsas.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb, setSetting } from '../src/db.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createLinkService } from '../src/links.js';
import { createEnvios } from '../src/envios.js';
import { createVerificador, MOTIVOS_VERIFICADOR, TEMPO_MAX_MS } from '../src/verificador.js';
import { createScheduler } from '../src/scheduler.js';
import { createMagalu } from '../src/magalu.js';
import { buildApp, criarServicos } from '../src/server.js';
import { segredosDe } from '../src/conexoes.js';
import { renderTemplate, horaPrecoDerrubaOLink } from '../src/template.js';
import { createCatalogoItens } from '../src/catalogo-itens.js';
import { createAmazon } from '../src/amazon.js';
import { paraCandidato } from '../src/catalogo.js';
import * as mlReal from '../src/ml.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let acessosRede = 0;
globalThis.fetch = async () => { acessosRede++; throw new Error('rede proibida no teste'); };

const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-qaverif-')); pastas.push(p); return p; };

const MIN = 60 * 1000;
const HORA = 60 * MIN;
const G1 = '111@g.us';
const G2 = '222@g.us';
const IMG = 'https://http2.mlstatic.com/D_NQ_NP_123-O.jpg';
const URL_ML = 'https://produto.mercadolivre.com.br/MLB-1234567890-fone-bom-_JM';
const ASIN = 'B0FG2MD49G';
const TAG = 'pedro-20';
const CRED_ID = 'credencial-id-0001';
const SEGREDO = 'segredo-super-secreto-123';
const TOKEN = 'token-oauth-secreto-xyz';
const IMG_AMAZON = 'https://m.media-amazon.com/images/I/71abcDEF.jpg';
const CORPO = '{TITULO_PRODUTO}\nPor {PRECO_PRODUTO}[ (de {PRECO_ANTIGO})]\n[🕒 Preço visto às {HORA_PRECO}]\n{LINK}';

const capturarConsole = (t) => ['error', 'warn', 'log', 'info'].map((m) => t.mock.method(console, m, () => {}));
const textoDoConsole = (espias) => espias.flatMap((e) => e.mock.calls.map((c) => c.arguments.map(String).join(' '))).join('\n');
const terminar = async (db) => {
  assert.ok(await esperarAte(() => db.prepare("SELECT COUNT(*) AS n FROM envios WHERE status IN ('pendente','enviando')").get().n === 0, 600), 'a fila não esvaziou');
  await dormir(30);
};
const dormir = (ms) => new Promise((ok) => setTimeout(ok, ms));
async function esperarAte(cond, tentativas = 400) {
  for (let i = 0; i < tentativas && !cond(); i++) await dormir(15);
  return cond();
}
const todoLog = (db) => db.prepare('SELECT rule_name, level, group_name, offer_title, message FROM log ORDER BY id').all().map((l) => ({ ...l }));
const niveisDoLog = (db) => todoLog(db).map((l) => l.level);
const semErroNoLog = (db, onde) => assert.deepEqual(todoLog(db).filter((l) => l.level === 'erro'), [], `${onde}: nenhuma linha com nível erro (viraria aviso por WhatsApp)`);
const descartes = (db) => todoLog(db).filter((l) => /^Descartada:/.test(l.message)).map((l) => l.message);
/** Tudo que o banco guarda em texto (log, resultados, envios), para procurar o que não pode estar lá. */
const tudoNoBanco = (db) => [
  JSON.stringify(db.prepare('SELECT * FROM log').all()), JSON.stringify(db.prepare('SELECT * FROM envio_resultados').all()),
  JSON.stringify(db.prepare('SELECT resultado FROM envios').all()),
].join('\n'); // (o payload do envio guarda o link que o dono colou: é dele, não da loja)

function semear(db, { magalu = false } = {}) {
  for (const [jid, nome] of [[G1, 'Achadinhos'], [G2, 'Tech']]) db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, nome, 10, Date.now());
  for (const nome of ['etiquetaA', 'etiquetaB']) db.prepare('INSERT INTO tags (name, created_at) VALUES (?, 1)').run(nome);
  if (magalu) {
    db.prepare("INSERT INTO conexoes (plataforma, config, segredos, updated_at) VALUES ('magalu', ?, '{}', ?)").run(JSON.stringify({ loja: 'lojadodono' }), Date.now());
  }
}

/**
 * Fila de envios (createEnvios) com o verificador de verdade e o `ml` falso. `ml.estado.leitura` é o que a conferência
 * lê; `ml.estado.segurar` (promessa) pendura a conferência; `ml.conferencias` guarda as URLs lidas.
 */
function montarFila({ agora = Date.now, verificar = true, tempoMaxMs } = {}) {
  const dir = tmp(); const db = openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const pedidosDeLink = [];
  const requestLink = links.requestLink;
  links.requestLink = async (o) => { pedidosDeLink.push(o.url); return requestLink(o); };
  const estado = { leitura: { price: 89.9, disponivel: true }, falha: null, segurar: null };
  const conferencias = [];
  const ml = {
    estado, conferencias,
    async resolveOffer(c) { return { key: c.key, url: c.url, title: 'Fone Bom', price: 89.9, oldPrice: 149.9, discountPct: 40, sold: 1200, freeShipping: true, image: IMG }; },
    async conferirProduto(url) {
      conferencias.push(url);
      if (estado.segurar) await estado.segurar;
      if (estado.falha) throw estado.falha;
      return { ...estado.leitura };
    },
  };
  const verificador = verificar ? createVerificador({ db, ml, agora, ...(tempoMaxMs ? { tempoMaxMs } : {}) }) : null;
  const magalu = createMagalu({ fetch: async () => { throw new Error('rede proibida (Magalu)'); } });
  const envios = createEnvios({ db, wa, links, ml, fast: true, dir, acordar: () => {}, magalu, verificador });
  semear(db, { magalu: true });
  const tpl = Number(db.prepare('INSERT INTO templates (name, body, created_at) VALUES (?,?,?)').run('Com hora', CORPO, Date.now()).lastInsertRowid);
  return { dir, db, wa, links, ml, estado, conferencias, pedidosDeLink, envios, verificador, tpl };
}
const criarManual = (s, extra = {}) => s.envios.criar({ tipo: 'oferta', url: URL_ML, tag_id: 2, template_id: s.tpl, group_jids: [G1, G2], quando: 'agora', ...extra });
const envioDe = (s, id) => ({ ...s.db.prepare('SELECT * FROM envios WHERE id = ?').get(id) });
const resultadosDe = (s, id) => s.db.prepare('SELECT jid, ok, erro FROM envio_resultados WHERE envio_id = ? ORDER BY id').all(id).map((r) => ({ ...r }));

// ============================================================================================ Magalu (CA1, CA4, D2, D3)

const URL_MAGALU = 'https://www.magazinevoce.com.br/lojadodono/fone-bom/p/abc123/audio/fones/?seller_id=magazineluiza';
const AJUSTES_MAGALU = { title: 'Fone Bom Magalu', price: '89,90', oldPrice: '149,90' };

test('Magalu agora (dados de menos de 30 min): sai com o preço digitado, sem {HORA_PRECO}, e o Histórico diz que não foi conferido', async () => {
  const s = montarFila();
  const { id } = await criarManual(s, { url: URL_MAGALU, tag_id: null, ajustes: AJUSTES_MAGALU });
  await s.envios.processarPendentes();
  assert.equal(envioDe(s, id).status, 'concluido');
  assert.deepEqual(s.conferencias, [], 'a Magalu nunca é lida (D2)');
  const textos = s.wa.simulated.map((m) => m.text);
  assert.equal(textos.length, 2);
  for (const t of textos) {
    assert.ok(t.includes('R$ 89,90'), 'o preço digitado vale');
    assert.ok(!t.includes('Preço visto às'), 'sem conferência, a linha da hora some');
  }
  const oks = todoLog(s.db).filter((l) => l.level === 'ok').map((l) => l.message);
  assert.equal(oks.length, 2);
  for (const m of oks) assert.match(m, /^Enviado pela Magalu, com a sua loja de parceiro · preço não conferido \(a Magalu não deixa ler a página\)$/);
  semErroNoLog(s.db, 'Magalu agora');
});

test('Magalu agendada para daqui a mais de 30 min: recusada ao criar (R1); até 30 min sai com o aviso de preço não conferido', async (t) => {
  const base = new Date(2026, 10, 9, 10, 0, 0).getTime();
  t.mock.timers.enable({ apis: ['Date'], now: base });
  const s = montarFila();
  // agenda para as 11:00 (60 min depois): não vale a pena aceitar, ela nunca sairia (dados velhos e a Magalu não se confere)
  await assert.rejects(criarManual(s, { url: URL_MAGALU, tag_id: null, ajustes: AJUSTES_MAGALU, quando: 'agendado', agendar_hhmm: '11:00' }),
    { message: 'Esta loja não tem conferência de preço: agende para até 25 min ou envie agora.' });
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM envios').get().n, 0, 'nada foi gravado');
  // até 25 min (10:20) sai, sem conferência, com o sufixo no Histórico
  const { id } = await criarManual(s, { url: URL_MAGALU, tag_id: null, ajustes: AJUSTES_MAGALU, quando: 'agendado', agendar_hhmm: '10:20' });
  assert.equal(envioDe(s, id).status, 'pendente');
  t.mock.timers.setTime(base + 20 * MIN + 1000);
  await s.envios.processarPendentes();
  assert.equal(s.wa.simulated.length, 2, 'saiu para os dois grupos');
  assert.equal(envioDe(s, id).status, 'concluido');
  assert.deepEqual(descartes(s.db), []);
  assert.ok(todoLog(s.db).some((l) => l.level === 'ok' && l.message.endsWith(' · preço não conferido (a Magalu não deixa ler a página)')));
  semErroNoLog(s.db, 'Magalu agendada');
});

// ===================================================================================== cancelamento e concorrência

test('cancelar durante a conferência: nada é enviado, o envio fica cancelado (nunca volta a "concluído" nem "enviando") e a conferência não se repete', async () => {
  const s = montarFila();
  let soltar; s.estado.segurar = new Promise((ok) => { soltar = ok; });
  const { id } = await criarManual(s);
  const rodando = s.envios.processarPendentes();
  assert.ok(await esperarAte(() => s.conferencias.length === 1), 'a conferência começou');
  assert.equal(envioDe(s, id).status, 'enviando', 'enquanto confere, o envio está enviando');
  await s.envios.cancelar(id);
  soltar();
  await rodando;
  assert.equal(envioDe(s, id).status, 'cancelado');
  assert.equal(s.wa.simulated.length, 0, 'cancelado durante a conferência: nada sai');
  assert.deepEqual(resultadosDe(s, id), [], 'não grava resultado de grupo para o envio cancelado');
  await s.envios.processarPendentes();
  assert.equal(s.conferencias.length, 1, 'o cancelado não é conferido de novo');
  semErroNoLog(s.db, 'cancelamento');
});

test('cancelar durante a conferência de uma oferta que seria descartada: o envio continua cancelado', async () => {
  const s = montarFila();
  s.estado.leitura = { price: 89.9, disponivel: false };
  let soltar; s.estado.segurar = new Promise((ok) => { soltar = ok; });
  const { id } = await criarManual(s);
  const rodando = s.envios.processarPendentes();
  assert.ok(await esperarAte(() => s.conferencias.length === 1));
  await s.envios.cancelar(id);
  soltar();
  await rodando;
  assert.equal(envioDe(s, id).status, 'cancelado', 'o cancelamento do dono vale: o descarte não ressuscita nem conclui o envio');
  assert.equal(s.wa.simulated.length, 0);
});

test('dois ticks juntos: a oferta é conferida uma vez e sai uma vez por grupo', async () => {
  const s = montarFila();
  let soltar; s.estado.segurar = new Promise((ok) => { soltar = ok; });
  const { id } = await criarManual(s);
  const a = s.envios.processarPendentes();
  assert.ok(await esperarAte(() => s.conferencias.length === 1));
  const b = s.envios.processarPendentes();
  await dormir(30);
  soltar();
  await Promise.all([a, b]);
  assert.equal(s.conferencias.length, 1, 'uma só conferência');
  assert.equal(s.wa.simulated.length, 2, 'um texto por grupo');
  assert.equal(envioDe(s, id).status, 'concluido');
});

test('a conferência que passa de 20 s não segura o envio para sempre: demorou vira "não conferido" e, com dados frescos, o "agora" sai', async () => {
  const s = montarFila({ tempoMaxMs: 60 });
  s.estado.segurar = new Promise(() => {}); // a loja nunca responde
  const { id } = await criarManual(s);
  const inicio = Date.now();
  await s.envios.processarPendentes();
  assert.ok(Date.now() - inicio < 2000, 'o tempo máximo vale');
  assert.equal(envioDe(s, id).status, 'concluido');
  assert.equal(s.wa.simulated.length, 2);
  const oks = todoLog(s.db).filter((l) => l.level === 'ok').map((l) => l.message);
  for (const m of oks) assert.match(m, /· preço não conferido \(a loja demorou demais\)$/);
  assert.equal(TEMPO_MAX_MS, 20000, 'o teto de produção são 20 s');
});

// ============================================================================ espelho de verdade (Amazon, ponta a ponta)

const respJson = (status, corpo) => new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } });
const itemApi = (asin, { preco, tipo = 'IN_STOCK', base }) => ({
  asin, itemInfo: { title: { displayValue: `Produto ${asin} da Amazon` } },
  images: { primary: { large: { url: IMG_AMAZON, height: 500, width: 500 } } },
  offersV2: { listings: [{ isBuyBoxWinner: true, availability: { type: tipo }, price: { money: { amount: preco }, ...(base ? { savingBasis: { money: { amount: base } } } : {}) } }] },
});
/** fetch falso da Amazon: a 1ª leitura (a do espelho) é a de `estado.antes`; as seguintes (a conferência) são as de `estado.depois`. */
function fetchAmazon(estado) {
  const chamadas = [];
  let getItems = 0;
  const f = async (url, init = {}) => {
    const u = String(url);
    chamadas.push(u);
    if (u === 'https://api.amazon.com/auth/o2/token') return respJson(200, { access_token: TOKEN, token_type: 'bearer', expires_in: 3600 });
    if (u === 'https://creatorsapi.amazon/catalog/v1/getItems') {
      getItems++;
      const c = getItems === 1 ? estado.antes : estado.depois;
      if (c === 'falha') throw new Error(`falha ${u} Authorization: Bearer ${TOKEN} client_secret=${SEGREDO}`);
      return respJson(200, { itemsResult: { items: JSON.parse(init.body).itemIds.map((a) => itemApi(a, c)) } });
    }
    throw new Error('rede não prevista no teste');
  };
  f.chamadas = chamadas; f.getItems = () => getItems;
  return f;
}

function montarServicos({ antes, depois, verificar = true, ml = null, credenciais = true }) {
  const dir = tmp(); const db = openDb(dir);
  semear(db);
  db.prepare("INSERT INTO conexoes (plataforma, config, segredos, updated_at) VALUES ('amazon', ?, ?, ?)")
    .run(JSON.stringify({ tag: TAG, credencial_versao: '3.1' }), JSON.stringify(credenciais ? { credencial_id: CRED_ID, credencial_secret: SEGREDO } : {}), Date.now());
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const estado = { antes, depois };
  const fetchF = fetchAmazon(estado);
  const serv = criarServicos({ db, wa, links, fast: true, dir, fetch: fetchF, verificar, ...(ml ? { ml } : {}) });
  return { dir, db, wa, links, estado, fetchF, ...serv };
}

const upsert = (texto, id, jid = '100@g.us') => ({
  type: 'notify', messages: [{ key: { remoteJid: jid, fromMe: false, id }, message: { conversation: texto }, messageTimestamp: Math.floor(Date.now() / 1000) }],
});
const quieto = (db) => db.prepare("SELECT COUNT(*) AS n FROM espelho_itens WHERE status IN ('processando') OR (status = 'recebido' AND (espera_ate IS NULL OR espera_ate <= ?))").get(Date.now()).n === 0
  && db.prepare("SELECT COUNT(*) AS n FROM envios WHERE status IN ('pendente','enviando')").get().n === 0;
const assentar = async (db) => { assert.ok(await esperarAte(() => quieto(db), 600), 'o agendador não assentou'); await dormir(40); };

function regraEspelho(s) {
  s.db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run('100@g.us', 'Origem', 10, Date.now());
  const tpl = s.db.prepare("SELECT id FROM templates WHERE name = 'Amazon'").get().id;
  return s.scheduler.espelho.criar({ nome: 'Amazon → Achadinhos', origem_jids: ['100@g.us'], destino_jids: [G1, G2], template_id: tpl }).id;
}

test('espelho (Amazon): preço igual na conferência → sai aos dois destinos, sem sufixo e sem erro', async () => {
  const s = montarServicos({ antes: { preco: 1310.05 }, depois: { preco: 1310.05 } });
  regraEspelho(s);
  s.wa._onMensagens(upsert(`olha https://www.amazon.com.br/dp/${ASIN}`, 'IN1'));
  await assentar(s.db);
  assert.equal(s.wa.simulated.filter((m) => m.jid.endsWith('@g.us') && m.jid !== '100@g.us').length, 2, 'dois destinos');
  assert.ok(s.fetchF.getItems() >= 2, 'a conferência foi à API de novo (fresco), não usou o cache da leitura do espelho');
  assert.deepEqual(descartes(s.db), []);
  semErroNoLog(s.db, 'espelho');
});

test('espelho (Amazon): o preço subiu 20% entre a leitura do espelho e o envio → nada sai, Histórico com os dois preços, item do espelho mostra o motivo', async (t) => {
  const espias = capturarConsole(t);
  const s = montarServicos({ antes: { preco: 1000 }, depois: { preco: 1200 } });
  regraEspelho(s);
  s.wa._onMensagens(upsert(`olha https://www.amazon.com.br/dp/${ASIN}`, 'IN2'));
  await assentar(s.db);
  assert.equal(s.wa.simulated.filter((m) => m.jid === G1 || m.jid === G2).length, 0, 'nada vai aos destinos');
  assert.deepEqual(descartes(s.db), ['Descartada: preço subiu de R$ 1.000,00 para R$ 1.200,00 (+20%, o limite é 5%)']);
  semErroNoLog(s.db, 'espelho, preço subiu');
  const itens = s.scheduler.espelho.itens({});
  assert.equal(itens.length, 1);
  assert.deepEqual(itens[0].destinos.map((d) => [d.ok, d.erro]), [[false, 'Descartada: preço subiu de R$ 1.000,00 para R$ 1.200,00 (+20%, o limite é 5%)'], [false, 'Descartada: preço subiu de R$ 1.000,00 para R$ 1.200,00 (+20%, o limite é 5%)']]);
  const texto = textoDoConsole(espias) + tudoNoBanco(s.db);
  for (const segredo of [CRED_ID, SEGREDO, TOKEN]) assert.ok(!texto.includes(segredo), 'credencial da Amazon fora de log e console');
});

test('espelho (Amazon): esgotada na conferência → nada sai e o motivo aparece em cada destino do item', async () => {
  const s = montarServicos({ antes: { preco: 1000 }, depois: { preco: 1000, tipo: 'OUT_OF_STOCK' } });
  regraEspelho(s);
  s.wa._onMensagens(upsert(`olha https://www.amazon.com.br/dp/${ASIN}`, 'IN3'));
  await assentar(s.db);
  assert.equal(s.wa.simulated.filter((m) => m.jid === G1 || m.jid === G2).length, 0);
  assert.deepEqual(descartes(s.db), ['Descartada: esgotado na loja']);
  semErroNoLog(s.db, 'espelho, esgotado');
  const [item] = s.scheduler.espelho.itens({});
  assert.equal(item.status, 'enviado', 'o item do espelho já estava decidido quando o envio nasceu');
  assert.deepEqual(item.destinos.map((d) => [d.ok, d.erro]), [[false, 'Descartada: esgotado na loja'], [false, 'Descartada: esgotado na loja']], 'o motivo aparece por destino');
});

test('espelho (Amazon) sem a API (a conferência falha): o item sai na hora (dados de segundos), com o aviso de "não conferido" no Histórico', async () => {
  const s = montarServicos({ antes: { preco: 1000 }, depois: 'falha' });
  regraEspelho(s);
  s.wa._onMensagens(upsert(`olha https://www.amazon.com.br/dp/${ASIN}`, 'IN5'));
  await assentar(s.db);
  assert.equal(s.wa.simulated.filter((m) => m.jid === G1 || m.jid === G2).length, 2);
  const oks = todoLog(s.db).filter((l) => l.level === 'ok' && /Enviado/.test(l.message)).map((l) => l.message);
  assert.ok(oks.length >= 2 && oks.every((m) => m.endsWith(' · preço não conferido (a loja não respondeu)')), JSON.stringify(oks));
  semErroNoLog(s.db, 'espelho, API falhou');
});

// ========================================================================================== remetente de verdade (ML)

const PN = '5535999991234@s.whatsapp.net';
function montarRemetente({ verificar = true } = {}) {
  const dir = tmp(); const db = openDb(dir);
  semear(db);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const estado = { leitura: { price: 89.9, disponivel: true } };
  const conferencias = [];
  const ml = {
    ...mlReal,
    async resolveOffer(c) { return { key: 'MLB1234567890', url: c.url, title: 'Fone Bom', price: 89.9, oldPrice: 149.9, discountPct: 40, sold: 1200, freeShipping: false, image: IMG }; },
    async conferirProduto(url) { conferencias.push(url); return { ...estado.leitura }; },
  };
  const serv = criarServicos({ db, wa, links, fast: true, dir, ml, verificar });
  db.prepare(`INSERT INTO remetentes (nome, jid, lid, enabled, destino_jids, template_id, tag_id, enviar_foto, max_por_hora, dedupe_horas, responder, created_at, updated_at)
    VALUES ('Sócio', ?, NULL, 1, ?, 1, NULL, 0, 10, 24, 1, 1, 1)`).run(PN, JSON.stringify([G1, G2]));
  let seq = 0;
  return {
    db, wa, estado, conferencias, ...serv,
    msg: (texto) => serv.scheduler.remetentes.receber({ ids: [PN], texto, msgId: `MSG${++seq}`, ts: Date.now() }),
    async rodar() {
      await serv.scheduler.remetentes.processarPendentes(Date.now());
      await serv.scheduler.envios.processarPendentes(Date.now());
      await serv.scheduler.remetentes.responderPendentes(Date.now());
    },
    nosGrupos: () => wa.simulated.filter((m) => m.jid.endsWith('@g.us')),
    respostas: () => wa.simulated.filter((m) => !m.jid.endsWith('@g.us')).map((m) => m.text),
  };
}

test('remetente (ML): esgotado na loja → nada vai aos grupos, a resposta ao sócio é a genérica (sem o motivo, sem link) e o Histórico não tem erro', async () => {
  const s = montarRemetente();
  s.estado.leitura = { price: 89.9, disponivel: false };
  assert.equal(s.msg(`Olha esse ${URL_ML}`), 1);
  await s.rodar();
  assert.deepEqual(s.conferencias.length, 1, 'o remetente passou pelo verificador');
  assert.equal(s.nosGrupos().length, 0);
  assert.deepEqual(descartes(s.db), ['Descartada: esgotado na loja']);
  semErroNoLog(s.db, 'remetente');
  const r = s.respostas();
  assert.equal(r.length, 1);
  assert.ok(!/esgotad|Descartad|preço/i.test(r[0]) || /preço/.test('Mande o link junto com o nome e o preço.'), `resposta: ${r[0]}`);
  assert.doesNotMatch(r[0], /http|meli\.la|R\$/);
});

test('remetente (ML): preço dentro do limite sai com o preço da loja; acima do limite não sai e o preço antigo da loja não vira "desconto" falso', async () => {
  const s = montarRemetente();
  s.estado.leitura = { price: 92.5, disponivel: true }; // +2,9%
  s.msg(`Olha esse ${URL_ML}`);
  await s.rodar();
  assert.equal(s.nosGrupos().length, 2);
  assert.ok(s.nosGrupos()[0].text.includes('R$ 92,50'), s.nosGrupos()[0].text);
  const s2 = montarRemetente();
  s2.estado.leitura = { price: 99.9, disponivel: true }; // +11%
  s2.msg(`Olha esse ${URL_ML}`);
  await s2.rodar();
  assert.equal(s2.nosGrupos().length, 0);
  assert.deepEqual(descartes(s2.db), ['Descartada: preço subiu de R$ 89,90 para R$ 99,90 (+11%, o limite é 5%)']);
  semErroNoLog(s2.db, 'remetente, preço');
});

// =================================================================================== "Enviar" da revisão do Catálogo

function montarRevisao({ verificar = true } = {}) {
  const dir = tmp(); const db = openDb(dir);
  semear(db);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const estado = { leitura: { price: 89.9, disponivel: true } };
  const conferencias = [];
  const ml = {
    ...mlReal,
    async resolveOffer() { throw new Error('não usado'); },
    async conferirProduto(url) { conferencias.push(url); return { ...estado.leitura }; },
  };
  const serv = criarServicos({ db, wa, links, fast: true, dir, ml, verificar });
  const regra = { id: Number(db.prepare(`INSERT INTO rules (name, tag_id, template_id, group_jids, dedupe_days, send_image, created_at) VALUES ('Catálogo', 1, 1, ?, 7, 0, ?)`)
    .run(JSON.stringify([G1, G2]), Date.now()).lastInsertRowid), name: 'Catálogo', dedupe_days: 7 };
  const c = { key: 'MLB1234567890', title: 'Fone Bom', price: 89.9, oldPrice: 149.9, discountPct: 40, sold: 1200, freeShipping: true, coupon: null, image: IMG, categoria: 'Eletrônicos', tag_id: null, source_index: 0 };
  assert.equal(serv.catalogoItens.registrar(regra, c, 'revisao', ['nao_conferido']), true);
  const itemId = db.prepare('SELECT id FROM catalogo_itens WHERE rule_id = ?').get(regra.id).id;
  return { db, wa, estado, conferencias, regra, itemId, ...serv };
}

test('"Enviar" da revisão (ML): esgotado na hora do envio → nada sai, o item pode ser reenviado e, voltando ao estoque, o reenvio sai', async () => {
  const s = montarRevisao();
  s.estado.leitura = { price: 89.9, disponivel: false };
  const { envio_id } = await s.catalogoItens.enviar(s.itemId, {});
  await terminar(s.db);
  assert.equal(s.conferencias.length, 1, 'o "Enviar" passou pelo verificador');
  assert.equal(s.wa.simulated.filter((m) => m.jid.endsWith('@g.us')).length, 0);
  assert.equal(s.db.prepare('SELECT status FROM envios WHERE id = ?').get(envio_id).status, 'erro');
  assert.deepEqual(descartes(s.db), ['Descartada: esgotado na loja']);
  semErroNoLog(s.db, 'revisão');
  const lista = s.catalogoItens.listar({ regra: s.regra.id });
  assert.equal(lista.itens[0].pode_reenviar, true, 'o dono pode tentar de novo');
  assert.deepEqual(lista.itens[0].grupos.map((g) => g.erro), ['Descartada: esgotado na loja', 'Descartada: esgotado na loja']);
  // a loja volta ao estoque
  s.estado.leitura = { price: 89.9, disponivel: true };
  const r2 = await s.catalogoItens.enviar(s.itemId, {});
  await terminar(s.db);
  assert.notEqual(r2.envio_id, envio_id);
  assert.equal(s.wa.simulated.filter((m) => m.jid.endsWith('@g.us')).length, 2, 'o reenvio saiu aos dois grupos');
});

test('"Enviar" da revisão (ML): o dono corrigiu o preço à mão e a loja cobra mais que o corrigido (acima do limite) → não sai; abaixo → o preço da loja vale', async () => {
  const s = montarRevisao();
  s.estado.leitura = { price: 99, disponivel: true }; // o dono digitou 89,90; a loja cobra 99,00 (+10,1%)
  await s.catalogoItens.enviar(s.itemId, { ajustes: { price: '89,90', oldPrice: '149,90' } });
  await terminar(s.db);
  assert.equal(s.wa.simulated.filter((m) => m.jid.endsWith('@g.us')).length, 0);
  assert.equal(descartes(s.db).length, 1);
  assert.match(descartes(s.db)[0], /^Descartada: preço subiu de R\$ 89,90 para R\$ 99,00 \(\+10%, o limite é 5%\)$/);
});

// ============================================================================================ log e console sem dado da loja

test('nada que a loja devolve (URL com token, mensagem de erro, título hostil) chega ao Histórico nem ao console, em nenhum desfecho', async (t) => {
  const espias = capturarConsole(t);
  const SENHA = 'TOKEN-SECRETO-DA-URL-9f8e7d';
  const urlComToken = `${URL_ML}?access_token=${SENHA}&utm=abc`;
  for (const falha of [
    new Error(`falha ao ler ${urlComToken} (${SENHA})`),
    Object.assign(new Error(`HTTP 500 em ${urlComToken}`), { name: 'TimeoutError', cause: new Error(urlComToken) }),
    Object.assign(new Error('x'), { status: 500, url: urlComToken, response: { body: SENHA } }),
  ]) {
    const s = montarFila();
    s.estado.falha = falha;
    const { id } = await criarManual(s, { url: urlComToken });
    await s.envios.processarPendentes();
    assert.equal(envioDe(s, id).status, 'concluido', 'dados frescos: sai sem conferência');
    // o agendado velho é descartado: o texto do descarte também não leva nada da loja
    const velho = Number(s.db.prepare(`INSERT INTO envios (tipo, payload, group_jids, quando, status, next_run_at, created_at)
      VALUES ('oferta', ?, ?, 'agora', 'pendente', ?, ?)`).run(envioDe(s, id).payload, JSON.stringify([G1]), Date.now(), Date.now() - 2 * HORA).lastInsertRowid);
    await s.envios.processarPendentes();
    assert.equal(envioDe(s, velho).status, 'erro');
    assert.ok(!tudoNoBanco(s.db).includes(SENHA), 'banco (log, envios, resultados) sem o token da loja');
    assert.deepEqual(descartes(s.db), ['Descartada: não deu para conferir o preço (a loja não respondeu)']);
    semErroNoLog(s.db, 'falha da loja');
  }
  const console_ = textoDoConsole(espias);
  assert.ok(!console_.includes(SENHA), `console sem o token: ${console_}`);
  assert.ok(!console_.includes('mercadolivre.com.br'), 'console sem a URL da loja');
});

test('o ml.conferirProduto de verdade lê um HTML hostil (JSON-LD, título e comentário com texto de ataque) e nada disso vira texto do Histórico', async (t) => {
  const espias = capturarConsole(t);
  const INJECAO = '<img src=x onerror=alert(1)>ATAQUE-DA-LOJA';
  const html = `<html><head><script type="application/ld+json">${JSON.stringify({
    '@type': 'Product', name: INJECAO, description: `availability OutOfStock ${INJECAO}`,
    offers: { '@type': 'Offer', price: '99.90', priceCurrency: 'BRL', availability: 'https://schema.org/InStock', url: `https://evil.example/${INJECAO}` },
  })}</script></head><body>"availability":"OutOfStock" ${INJECAO}</body></html>`;
  const s = montarFila();
  // o verificador usa o conferirProduto real, lendo a "página" pelo leitor injetado
  const mlLeitorFalso = { ...mlReal, conferirProduto: (url) => mlReal.conferirProduto(url, { fetchJson: async () => { throw new Error('API fora'); }, fetchText: async () => html }) };
  const verificador = createVerificador({ db: s.db, ml: mlLeitorFalso });
  const envios = createEnvios({ db: s.db, wa: s.wa, links: s.links, ml: s.ml, fast: true, dir: s.dir, acordar: () => {}, verificador });
  const { id } = await envios.criar({ tipo: 'oferta', url: URL_ML, tag_id: 2, template_id: s.tpl, group_jids: [G1], quando: 'agora' });
  await envios.processarPendentes();
  // a referência é o 89,90 do `ml` falso; a "página" diz 99,90 (+11%): descarta, com frase fixa e números, nunca o HTML
  assert.equal(envioDe(s, id).status, 'erro');
  assert.equal(s.wa.simulated.length, 0);
  assert.deepEqual(descartes(s.db), ['Descartada: preço subiu de R$ 89,90 para R$ 99,90 (+11%, o limite é 5%)']);
  const tudo = tudoNoBanco(s.db) + textoDoConsole(espias);
  assert.ok(!tudo.includes('ATAQUE-DA-LOJA') && !tudo.includes('onerror') && !tudo.includes('evil.example'), 'nada do HTML da loja no banco nem no console');
});

test('o HTML da loja com "OutOfStock" fora do JSON-LD (comentário, avaliação, outro script) não derruba a oferta', async () => {
  const html = `<html><head><script type="application/ld+json">${JSON.stringify({
    '@type': 'Product', name: 'Fone Bom', offers: { '@type': 'Offer', price: '89.90', availability: 'https://schema.org/InStock' },
  })}</script><script>var x = {"availability":"https://schema.org/OutOfStock"};</script></head>
  <body><!-- "availability":"OutOfStock" --><p>Um cliente disse: "availability":"SoldOut"</p></body></html>`;
  const r = await mlReal.conferirProduto(URL_ML, { fetchJson: async () => { throw new Error('API fora'); }, fetchText: async () => html });
  assert.deepEqual(r, { price: 89.9, disponivel: true });
});

// ================================================================================================= regras (Central e lista)

function montarRegras({ loja = {} } = {}) {
  const dir = tmp(); const db = openDb(dir);
  semear(db);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const conferidas = [];
  const mlLoja = { async conferirProduto(url) { const id = /MLB-?(\d+)/.exec(url)?.[1]; conferidas.push(id); const r = loja[id]; if (!r) throw new Error('fora'); return r; } };
  const verificador = createVerificador({ db, ml: mlLoja });
  const scheduler = createScheduler({ db, wa, links, fast: true, verificador });
  return { dir, db, wa, links, scheduler, conferidas, loja };
}
const regraCentral = (db, { per = 3, extra = '' } = {}) => Number(db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id, group_jids, source_type, source_config, per_run,
  interval_min, window_start, window_end, dedupe_days, send_image, created_at ${extra ? ', ' + extra.split('=')[0] : ''}) VALUES ('Central', 1, 1, 1, ?, 'afiliados', ?, ?, 60, '00:00', '23:59', 7, 0, ? ${extra ? ', ' + extra.split('=')[1] : ''})`)
  .run(JSON.stringify([G1]), JSON.stringify({ categoria: 'MLB1574', paginas: 1 }), per, Date.now()).lastInsertRowid);

test('regra Central: duas execuções da mesma regra ao mesmo tempo (a conferência é lenta) não conferem nem enviam duas vezes', async () => {
  const s = montarRegras({ loja: { 9000001: { price: 69.9, disponivel: true } } });
  let soltar; const segura = new Promise((ok) => { soltar = ok; });
  const antes = s.scheduler; void antes;
  const lojaLenta = { async conferirProduto() { s.conferidas.push('x'); await segura; return { price: 69.9, disponivel: true }; } };
  const verificador = createVerificador({ db: s.db, ml: lojaLenta });
  const sch = createScheduler({ db: s.db, wa: s.wa, links: s.links, fast: true, verificador });
  const id = regraCentral(s.db, { per: 1 });
  const a = sch.runRule(id);
  assert.ok(await esperarAte(() => s.conferidas.length === 1));
  const b = await sch.runRule(id).catch((e) => e);
  soltar();
  await a;
  assert.equal(s.conferidas.length, 1, 'a segunda execução não conferiu de novo');
  assert.equal(s.wa.simulated.length, 1, 'uma oferta, um envio');
  void b;
  assert.equal(sch.isRunning(id), false);
  semErroNoLog(s.db, 'regra concorrente');
});

test('regra Central: a oferta que subiu dentro do limite sai com o preço novo, mas a regra com "preço máximo" não deixa passar do máximo dela', async () => {
  // oferta da Central a R$ 69,90; a regra só aceita até R$ 70; a loja já cobra R$ 73,39 (+5%, dentro do limite do verificador)
  const s = montarRegras({ loja: { 9000001: { price: 73.39, disponivel: true } } });
  const id = regraCentral(s.db, { per: 1, extra: 'max_price=70' });
  const r = await s.scheduler.runRule(id);
  const saiu = s.wa.simulated.map((m) => m.text).filter((x) => x.includes('R$ 73,39'));
  assert.deepEqual(saiu, [], 'o filtro "preço máximo R$ 70" da regra foi violado: saiu a R$ 73,39');
  // fica "fora dos filtros" (como no pickOffers): nada saiu, nenhum aviso de descarte, nenhum erro
  assert.deepEqual([s.wa.simulated.length, r.offers, r.descartadas, r.errors], [0, 0, 0, 0]);
  assert.deepEqual(descartes(s.db), []);
  semErroNoLog(s.db, 'fora dos filtros');
});

// ================================================================================================ Ajustes (PUT /api/ajustes)

function pedir(port, metodo, caminho, corpo, headers = {}) {
  return new Promise((ok, err) => {
    const data = corpo == null ? null : Buffer.from(typeof corpo === 'string' ? corpo : JSON.stringify(corpo));
    const r = http.request({ host: '127.0.0.1', port, path: caminho, method: metodo,
      headers: { ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), origin: `http://127.0.0.1:${port}`, ...headers } }, (res) => {
      let txt = ''; res.on('data', (c) => { txt += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(txt); } catch { /* texto */ } ok({ status: res.statusCode, txt, json }); });
    });
    r.on('error', err); if (data) r.write(data); r.end();
  });
}

async function servidor({ senha = '' } = {}) {
  const dir = tmp(); const db = openDb(dir);
  semear(db);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const serv = criarServicos({ db, wa, links, fast: true, dir, verificar: true, simulado: true });
  const app = buildApp({ db, wa, links, scheduler: serv.scheduler, amazon: serv.amazon, publicHost: '', panelPassword: senha, dataDir: dir });
  const srv = await new Promise((ok) => { const x = app.listen(0, '127.0.0.1', () => ok(x)); });
  const port = srv.address().port;
  return { db, port, serv, fechar: async () => { srv.closeAllConnections?.(); await new Promise((ok) => srv.close(ok)); } };
}
const estadoAjustes = async (s) => (await pedir(s.port, 'GET', '/api/state')).json.ajustes;

test('PUT /api/ajustes: bordas do limite (0 e 50 valem; 51, -1, 5,5, texto, vazio, lista, objeto, true e notação científica não) e o valor guardado volta igual no GET', async () => {
  const s = await servidor();
  try {
    for (const [v, esperado] of [[0, 0], [50, 50], [7, 7], ['12', 12], [' 9 ', 9], [10.0, 10]]) {
      const r = await pedir(s.port, 'PUT', '/api/ajustes', { verificador_limite_pct: v });
      assert.equal(r.status, 200, `${JSON.stringify(v)} deveria valer: ${r.txt}`);
      assert.equal((await estadoAjustes(s)).verificador_limite_pct, esperado, JSON.stringify(v));
    }
    await pedir(s.port, 'PUT', '/api/ajustes', { verificador_limite_pct: 8 });
    for (const v of [51, -1, 5.5, 'x', '', [], {}, true, '1e1', '0x10', '5,5', '007x', 1e21, null === 1]) {
      const r = await pedir(s.port, 'PUT', '/api/ajustes', { verificador_limite_pct: v });
      assert.equal(r.status, 400, `${JSON.stringify(v)} deveria ser recusado (veio ${r.status})`);
      assert.match(r.json?.erro ?? r.txt, /número inteiro de 0 a 50/);
      assert.equal((await estadoAjustes(s)).verificador_limite_pct, 8, `recusado não grava (${JSON.stringify(v)})`);
    }
  } finally { await s.fechar(); }
});

test('PUT /api/ajustes: a chave aceita só booleano (nada de "0", "false", 1 ou 0) e uma rejeição não deixa o limite pela metade', async () => {
  const s = await servidor();
  try {
    for (const v of ['0', 'false', 0, 1, 'sim', [], {}]) {
      const r = await pedir(s.port, 'PUT', '/api/ajustes', { verificador_ativo: v, verificador_limite_pct: 20 });
      assert.equal(r.status, 400, JSON.stringify(v));
      assert.equal((await estadoAjustes(s)).verificador_ativo, true, 'a chave segue ligada');
      assert.equal((await estadoAjustes(s)).verificador_limite_pct, 5, 'o limite também não mudou: validação antes de gravar');
    }
    assert.equal((await pedir(s.port, 'PUT', '/api/ajustes', { verificador_ativo: false })).status, 200);
    assert.equal((await estadoAjustes(s)).verificador_ativo, false);
    assert.equal(s.serv.verificador.ativo(), false, 'o verificador do agendador lê a chave na hora, sem reiniciar');
    assert.deepEqual(niveisDoLog(s.db).filter((n) => n === 'erro'), []);
  } finally { await s.fechar(); }
});

test('PUT /api/ajustes do verificador exige sessão quando há senha, e Origin de outro site é recusada', async () => {
  const s = await servidor({ senha: 'senha-de-teste-123' });
  try {
    const sem = await pedir(s.port, 'PUT', '/api/ajustes', { verificador_ativo: false });
    assert.ok([401, 403].includes(sem.status), `sem sessão: ${sem.status}`);
    assert.equal(s.serv.verificador.ativo(), true, 'sem sessão, a proteção não desliga');
    const fora = await pedir(s.port, 'PUT', '/api/ajustes', { verificador_ativo: false }, { origin: 'http://evil.example' });
    assert.ok([401, 403].includes(fora.status), `Origin de fora: ${fora.status}`);
    assert.equal(s.serv.verificador.ativo(), true);
  } finally { await s.fechar(); }
});

// =============================================================================================== main de verdade em DRY_RUN

test('main de src/server.js em DRY_RUN: o verificador está ligado (a Magalu "agora" sai com o aviso de não conferida) e nada é acessado na rede', async (t) => {
  const dir = tmp(); const db = openDb(dir);
  db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(G1, 'Achadinhos', 10, Date.now());
  db.prepare("INSERT INTO conexoes (plataforma, config, segredos, updated_at) VALUES ('magalu', ?, '{}', ?)").run(JSON.stringify({ loja: 'lojadodono' }), Date.now());
  db.close?.();
  const porta = await new Promise((ok) => { const x = http.createServer().listen(0, '127.0.0.1', () => { const p = x.address().port; x.close(() => ok(p)); }); });
  const filho = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(RAIZ, 'src/server.js')], {
    cwd: RAIZ, env: { ...process.env, PORT: String(porta), DATA_DIR: dir, DRY_RUN: '1', PANEL_PASSWORD: '', PUBLIC_HOST: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { filho.kill('SIGKILL'); });
  let saida = '';
  filho.stdout.on('data', (c) => { saida += c; }); filho.stderr.on('data', (c) => { saida += c; });
  assert.ok(await esperarAte(() => saida.includes('rodando em'), 600), `o servidor não subiu: ${saida}`);
  const r = await pedir(porta, 'POST', '/api/envios', { tipo: 'oferta', url: URL_MAGALU, template_id: 1, group_jids: [G1], quando: 'agora', ajustes: AJUSTES_MAGALU });
  assert.equal(r.status, 200, r.txt);
  const banco = openDb(dir);
  assert.ok(await esperarAte(() => banco.prepare("SELECT 1 FROM log WHERE message LIKE 'Enviado pela Magalu%'").get() !== undefined, 600), `o envio não saiu: ${saida}`);
  const ok = banco.prepare("SELECT message FROM log WHERE level = 'ok'").all().map((l) => l.message);
  assert.deepEqual(ok, ['Enviado pela Magalu, com a sua loja de parceiro · preço não conferido (a Magalu não deixa ler a página)']);
  assert.equal(banco.prepare("SELECT COUNT(*) AS n FROM log WHERE level = 'erro'").get().n, 0);
  banco.close?.();
});

// ================================================================================ {HORA_PRECO} sem conferência e o {LINK}

test('template com {HORA_PRECO} na mesma linha do {LINK}: o servidor recusa salvar (POST e PUT) com frase clara; o formato seguro salva e sai com o link sem conferência (Q2)', async () => {
  const FRASE = 'Ponha o {HORA_PRECO} em outra linha, ou entre [ ] sem o {LINK}: sem conferência de preço, a linha some e a mensagem sai sem o link de afiliado.';
  const s = await servidor();
  try {
    const perigosos = [
      '*{TITULO_PRODUTO}*\nPreço visto às {HORA_PRECO}: {LINK}', // a linha inteira some sem conferência
      '[Visto às {HORA_PRECO}: {LINK}]', // o trecho (com o link) some
      'Visto às {HORA_PRECO}[ ({DESCONTO_PRODUTO})] {LINK}', '[{LINK}] às {HORA_PRECO}', '{LINK} {HORA_PRECO}',
    ];
    for (const body of perigosos) {
      const r = await pedir(s.port, 'POST', '/api/templates', { name: 'Perigoso', body });
      assert.deepEqual([r.status, r.json?.erro], [400, FRASE], JSON.stringify(body));
    }
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM templates WHERE name = 'Perigoso'").get().n, 0, 'recusado não grava');
    const seguros = ['{LINK}\n[🕒 Preço visto às {HORA_PRECO}]', '[🕒 Preço visto às {HORA_PRECO}] {LINK}', '{HORA_PRECO}\n{LINK}', '[🕒 {HORA_PRECO}][ {DESCONTO_PRODUTO} OFF] {LINK}', '{LINK}'];
    for (const body of seguros) {
      const r = await pedir(s.port, 'POST', '/api/templates', { name: 'Seguro', body });
      assert.equal(r.status, 200, `${JSON.stringify(body)}: ${r.txt}`);
    }
    // PUT: o template bom não vira o perigoso
    const id = Number(s.db.prepare("SELECT id FROM templates WHERE name = 'Seguro' ORDER BY id LIMIT 1").get().id);
    const put = await pedir(s.port, 'PUT', `/api/templates/${id}`, { name: 'Seguro', body: perigosos[0] });
    assert.deepEqual([put.status, put.json?.erro], [400, FRASE]);
    assert.equal(s.db.prepare('SELECT body FROM templates WHERE id = ?').get(id).body, seguros[0], 'o corpo anterior fica');
  } finally { await s.fechar(); }

  // o formato seguro, sem conferência (a loja fora do ar), sai com o link e sem a linha da hora
  const f = montarFila();
  f.estado.falha = new Error('fora do ar');
  const tpl = Number(f.db.prepare('INSERT INTO templates (name, body, created_at) VALUES (?,?,?)').run('Linha única', '*{TITULO_PRODUTO}*\n[Preço visto às {HORA_PRECO}] {LINK}', Date.now()).lastInsertRowid);
  await criarManual(f, { template_id: tpl, group_jids: [G1] });
  await f.envios.processarPendentes();
  assert.equal(f.wa.simulated.length, 1);
  assert.match(f.wa.simulated[0].text, /https:\/\/meli\.la\//, `saiu sem link: ${JSON.stringify(f.wa.simulated[0].text)}`);
  assert.doesNotMatch(f.wa.simulated[0].text, /Preço visto/);
});

test('pré-visualização da regra (Ver ofertas): {HORA_PRECO} sai com a hora de agora, como nas outras prévias, e não esconde o link', async () => {
  const s = montarRegras({ loja: {} });
  const tpl = Number(s.db.prepare('INSERT INTO templates (name, body, created_at) VALUES (?,?,?)').run('Com hora', '*{TITULO_PRODUTO}*\n[🕒 Preço visto às {HORA_PRECO}]\n{LINK}', Date.now()).lastInsertRowid);
  const id = regraCentral(s.db, { per: 1 });
  s.db.prepare('UPDATE rules SET template_id = ? WHERE id = ?').run(tpl, id);
  const previa = await s.scheduler.previewOffers(id);
  assert.equal(previa.length, 1);
  assert.match(previa[0].text, /Preço visto às \d{2}h\d{2}/, previa[0].text);
  assert.equal(s.conferidas.length, 0, 'a prévia não confere na loja');
});

// ==================================================================================== agendado: o preço mudou depois de criar

test('Disparo manual agendado (ML): o preço lido ao criar é a referência; 2 h depois a loja subiu 20% → descartado; subiu 3% → sai com o preço novo', async (t) => {
  const base = new Date(2026, 10, 9, 10, 0, 0).getTime();
  t.mock.timers.enable({ apis: ['Date'], now: base });
  // com a loja respondendo no horário, o agendado de dados velhos sai (a regra do frescor só vale sem conferência)
  for (const [leitura, saiu, texto] of [[{ price: 107.88, disponivel: true }, 0, null], [{ price: 92.6, disponivel: true }, 1, 'R$ 92,60']]) {
    const s = montarFila();
    s.estado.leitura = { price: 89.9, disponivel: true };
    const { id } = await criarManual(s, { quando: 'agendado', agendar_hhmm: '12:00', group_jids: [G1] });
    assert.equal(JSON.parse(envioDe(s, id).payload).preco_loja, 89.9, 'o preço da loja lido ao criar fica no payload');
    s.estado.leitura = leitura;
    t.mock.timers.setTime(new Date(2026, 10, 9, 12, 0, 5).getTime());
    await s.envios.processarPendentes();
    assert.equal(s.wa.simulated.length, saiu, JSON.stringify(leitura));
    if (texto) assert.ok(s.wa.simulated[0].text.includes(texto), s.wa.simulated[0].text);
    else assert.deepEqual(descartes(s.db), ['Descartada: preço subiu de R$ 89,90 para R$ 107,88 (+20%, o limite é 5%)']);
    semErroNoLog(s.db, 'agendado');
    t.mock.timers.setTime(base);
  }
});

// ================================================================================ rodada 2: recusa do agendado (R1)

const FRASE_SEM_CONFERENCIA = 'Esta loja não tem conferência de preço: agende para até 25 min ou envie agora.';

test('agendado: a borda é 25 min (30 min de frescor menos 5 de margem: 25 min exatos passam, 26 min são recusados) só para loja sem conferência; ML, chave desligada e fila sem verificador aceitam qualquer horário de hoje', async (t) => {
  const base = new Date(2026, 10, 9, 10, 0, 0).getTime();
  t.mock.timers.enable({ apis: ['Date'], now: base });
  const magalu = { url: URL_MAGALU, tag_id: null, ajustes: AJUSTES_MAGALU, quando: 'agendado', group_jids: [G1] };
  const s = montarFila();
  const { id } = await criarManual(s, { ...magalu, agendar_hhmm: '10:25' });
  assert.equal(envioDe(s, id).status, 'pendente', '25 min exatos: aceito');
  for (const hhmm of ['10:26', '10:31', '23:59']) {
    await assert.rejects(criarManual(s, { ...magalu, agendar_hhmm: hhmm }), { message: FRASE_SEM_CONFERENCIA }, hhmm);
  }
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM envios').get().n, 1, 'recusado não grava nada');
  // o "agora" da Magalu não é afetado
  assert.equal(envioDe(s, (await criarManual(s, { ...magalu, quando: 'agora' })).id).quando, 'agora');
  // ML é conferido: qualquer horário
  assert.equal(envioDe(s, (await criarManual(s, { quando: 'agendado', agendar_hhmm: '18:00', group_jids: [G1] })).id).status, 'pendente');
  // chave desligada: não há conferência a esperar, a recusa não se aplica
  setSetting(s.db, 'verificador_ativo', '0');
  assert.equal(envioDe(s, (await criarManual(s, { ...magalu, agendar_hhmm: '18:00' })).id).status, 'pendente', 'verificador desligado');
  // sem verificador na fila (D9): como antes
  const antigo = montarFila({ verificar: false });
  assert.equal(envioDe(antigo, (await criarManual(antigo, { ...magalu, agendar_hhmm: '18:00' })).id).status, 'pendente', 'sem verificador');
});

test('agendado: o horário de depois do frescor da Amazon sem API é recusado antes de qualquer rede; com a API ligada é aceito', async (t) => {
  const base = new Date(2026, 10, 9, 10, 0, 0).getTime();
  t.mock.timers.enable({ apis: ['Date'], now: base });
  const dados = (hhmm) => ({ tipo: 'oferta', url: `https://www.amazon.com.br/dp/${ASIN}`, group_jids: [G1], quando: 'agendado', agendar_hhmm: hhmm });
  const sem = montarServicos({ antes: { preco: 100 }, depois: { preco: 100 }, credenciais: false });
  const tpl = sem.db.prepare("SELECT id FROM templates WHERE name = 'Amazon'").get().id;
  await assert.rejects(sem.scheduler.envios.criar({ ...dados('12:00'), template_id: tpl, ajustes: { title: 'Roteador', price: '100,00' } }), { message: FRASE_SEM_CONFERENCIA });
  assert.deepEqual(sem.fetchF.chamadas, [], 'a recusa vem antes de ler a Amazon');
  assert.equal(sem.db.prepare('SELECT COUNT(*) AS n FROM envios').get().n, 0);
  const com = montarServicos({ antes: { preco: 100 }, depois: { preco: 100 } });
  const { id } = await com.scheduler.envios.criar({ ...dados('12:00'), template_id: com.db.prepare("SELECT id FROM templates WHERE name = 'Amazon'").get().id });
  assert.equal(com.db.prepare('SELECT status FROM envios WHERE id = ?').get(id).status, 'pendente');
});

// ================================================================================ rodada 2: filtros da regra depois da conferência (Q1)

test('regra Central: o desconto mínimo também vale depois da conferência; sem aviso de descarte, sem link, sem sent_offers e sem erro; preço que não mudou segue saindo', async () => {
  // MLB9000001: R$ 69,90 (de R$ 159,90, 56% OFF). A loja cobra R$ 73,39 (+4,99%): 54% OFF, abaixo do mínimo de 55%
  const s = montarRegras({ loja: { 9000001: { price: 73.39, disponivel: true }, 9000002: { price: 29.9, disponivel: true } } });
  const id = regraCentral(s.db, { per: 2, extra: 'min_discount=55' });
  const pedidos = [];
  const pedir = s.links.requestLink; s.links.requestLink = async (o) => { pedidos.push(o.url); return pedir(o); };
  const r = await s.scheduler.runRule(id);
  assert.ok(s.wa.simulated.every((m) => !m.text.includes('R$ 73,39')), 'a oferta que caiu abaixo do mínimo não sai');
  assert.equal(pedidos.some((u) => u.includes('9000001')), false, 'nem pede link dela');
  assert.deepEqual(descartes(s.db), [], 'é "fora dos filtros", não descarte do verificador');
  assert.equal(r.descartadas, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM sent_offers WHERE offer_key = 'MLB9000001'").get().n, 0);
  semErroNoLog(s.db, 'filtro depois da conferência');
});

test('regra Central: sem verificador, o filtro da regra não muda nada (a conferência não existe)', async () => {
  const s = montarRegras({ loja: {} });
  const sch = createScheduler({ db: s.db, wa: s.wa, links: s.links, fast: true });
  const id = regraCentral(s.db, { per: 1, extra: 'min_discount=55' });
  const r = await sch.runRule(id);
  assert.equal(r.offers, 1);
  assert.equal(s.conferidas.length, 0);
});

// ================================================================================ rodada 2: validador de template × renderizador

test('template: tudo que o validador aceita mantém o {LINK} no texto sem conferência (corpus aleatório com semente fixa); tudo que perderia o link é recusado', () => {
  let semente = 20261109;
  const aleatorio = (n) => { semente = (semente * 1664525 + 1013904223) % 4294967296; return semente % n; };
  const pedacos = ['{LINK}', '{HORA_PRECO}', '{TITULO_PRODUTO}', '[', ']', ' ', '\n', 'Visto às ', '[🕒 {HORA_PRECO}]', '[Preço {PRECO_PRODUTO}]', '{CUPOM}', '{DESCONTO_PRODUTO}', '[ {HORA_PRECO} {LINK}]'];
  const oferta = { title: 'Fone', price: 89.9, oldPrice: 149.9, coupon: 'CUPOM10', link: 'https://meli.la/fake-1' }; // só o {HORA_PRECO} fica vazio (sem vistoEm)
  let aceitos = 0; let recusados = 0;
  for (let i = 0; i < 4000; i++) {
    const corpo = Array.from({ length: 2 + aleatorio(8) }, () => pedacos[aleatorio(pedacos.length)]).join('');
    if (!corpo.includes('{LINK}') || !corpo.includes('{HORA_PRECO}')) continue;
    const derruba = horaPrecoDerrubaOLink(corpo);
    const texto = renderTemplate(corpo, oferta);
    if (!derruba) { aceitos++; assert.ok(texto.includes(oferta.link), `validador aceitou e o link sumiu: ${JSON.stringify(corpo)} → ${JSON.stringify(texto)}`); }
    else recusados++;
  }
  assert.ok(aceitos > 50 && recusados > 50, `corpus pouco útil: ${aceitos} aceitos, ${recusados} recusados`);
});

// ================================================================================ rodada 2: Catálogo descartado pelo verificador

test('Catálogo (regra): esgotado e preço que subiu viram "descartado" com o porquê em listar(); sem conferência vai à revisão sem porquê; o descarte do dono não tem porquê', async () => {
  const dir = tmp(); const db = openDb(dir); semear(db);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const amazon = createAmazon({ db, fetch: async () => { throw new Error('rede proibida (Amazon)'); }, esperar: async () => {}, lerConexao: () => ({ tag: 'achadinho-20' }) });
  const lojaMl = { 4000000001: { price: 100, disponivel: false }, 4000000002: { price: 120, disponivel: true }, 4000000003: null, 4000000004: { price: 100, disponivel: true }, 4000000005: { price: 100, disponivel: true } };
  const ml = { async conferirProduto(url) { const r = lojaMl[/MLB-?(\d+)/.exec(url)[1]]; if (!r) throw new Error('fora'); return r; } };
  const of = (i, mais = {}) => ({ id: i, loja: 'ml', titulo: `Produto ${i}`, preco: 100, preco_antigo: 150, desconto_pct: 33, categoria: 'Casa', item_id: `MLB${4000000000 + i}`, link: 'https://meli.la/TerCeiro1', ...mais });
  const catalogoItens = createCatalogoItens({ db, wa, links, amazon });
  const catalogo = { candidatos: async (cfg, { tratada }) => [of(1), of(2), of(3), of(4), of(5)].map(paraCandidato).filter((c) => c && !tratada(c, cfg.ordem)) };
  const verificador = createVerificador({ db, ml, amazon });
  const scheduler = createScheduler({ db, wa, links, fast: true, amazon, verificador, catalogo, catalogoItens });
  const id = Number(db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id, group_jids, source_type, source_config, sources, per_run, interval_min, window_start, window_end, dedupe_days, send_image, created_at)
    VALUES ('Catálogo', 1, 1, 1, ?, 'list', '{}', ?, 5, 60, '00:00', '23:59', 7, 0, ?)`).run(JSON.stringify([G1]), JSON.stringify([{ type: 'catalogo', tag_id: null, config: { ordem: 'relevancia' } }]), Date.now()).lastInsertRowid);
  const r = await scheduler.runRule(id);
  assert.deepEqual([r.offers, r.revisao, r.descartadas, r.errors], [2, 1, 2, 0]);
  const porChave = Object.fromEntries(catalogoItens.listar({ regra: id }).itens.map((it) => [it.oferta.title, it]));
  assert.equal(porChave['Produto 1'].status, 'descartado'); assert.equal(porChave['Produto 1'].descartado_por, 'esgotado');
  assert.equal(porChave['Produto 2'].status, 'descartado'); assert.equal(porChave['Produto 2'].descartado_por, 'preco_subiu');
  assert.equal(porChave['Produto 3'].status, 'revisao'); assert.deepEqual(porChave['Produto 3'].motivos, ['nao_conferido']);
  assert.equal('descartado_por' in porChave['Produto 3'], false);
  assert.equal('descartado_por' in porChave['Produto 4'], false, 'o enviado não tem porquê de descarte');
  assert.deepEqual(descartes(db).sort(), ['Descartada: esgotado na loja', 'Descartada: preço subiu de R$ 100,00 para R$ 120,00 (+20%, o limite é 5%)']);
  semErroNoLog(db, 'Catálogo');
  // o dono descarta o da revisão: sem `descartado_por` (o motivo "esgotado" não pode ser inventado)
  catalogoItens.descartar(porChave['Produto 3'].id);
  const depois = catalogoItens.listar({ regra: id }).itens.find((it) => it.oferta.title === 'Produto 3');
  assert.equal(depois.status, 'descartado'); assert.equal('descartado_por' in depois, false);
  // valor forjado no JSON guardado não vaza para a tela
  db.prepare("UPDATE catalogo_itens SET oferta = json_set(oferta, '$.descartado_por', 'constructor') WHERE id = ?").run(porChave['Produto 1'].id);
  assert.equal('descartado_por' in catalogoItens.listar({ regra: id }).itens.find((it) => it.oferta.title === 'Produto 1'), false);
});

test('Catálogo (regra): o preço máximo da regra também vale depois da conferência (resto do Q1: a correção só cobre as outras fontes)', async () => {
  const dir = tmp(); const db = openDb(dir); semear(db);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const amazon = createAmazon({ db, fetch: async () => { throw new Error('rede proibida (Amazon)'); }, esperar: async () => {}, lerConexao: () => ({ tag: 'achadinho-20' }) });
  const ml = { async conferirProduto() { return { price: 102.9, disponivel: true }; } }; // +5%, dentro do limite do verificador
  const oferta = { id: 1, loja: 'ml', titulo: 'Produto 1', preco: 98, preco_antigo: 150, desconto_pct: 34, categoria: 'Casa', item_id: 'MLB4000000001', link: 'https://meli.la/TerCeiro1' };
  const catalogoItens = createCatalogoItens({ db, wa, links, amazon });
  const catalogo = { candidatos: async () => [paraCandidato(oferta)] };
  const scheduler = createScheduler({ db, wa, links, fast: true, amazon, verificador: createVerificador({ db, ml, amazon }), catalogo, catalogoItens });
  const id = Number(db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id, group_jids, source_type, source_config, sources, per_run, interval_min, window_start, window_end, dedupe_days, send_image, max_price, created_at)
    VALUES ('Catálogo', 1, 1, 1, ?, 'list', '{}', ?, 5, 60, '00:00', '23:59', 7, 0, 100, ?)`).run(JSON.stringify([G1]), JSON.stringify([{ type: 'catalogo', tag_id: null, config: { ordem: 'relevancia' } }]), Date.now()).lastInsertRowid);
  const r = await scheduler.runRule(id);
  assert.deepEqual(wa.simulated.filter((m) => m.text.includes('R$ 102,90')), [], 'saiu a R$ 102,90 numa regra com preço máximo de R$ 100');
  // fora dos filtros: nada saiu, nenhum aviso de descarte nem erro, nada ficou registrado (o item não fica preso nem sai depois)
  assert.deepEqual([wa.simulated.length, r.offers, r.descartadas, r.errors, r.revisao], [0, 0, 0, 0, 0]);
  assert.deepEqual(db.prepare("SELECT level, message FROM log WHERE level IN ('aviso','erro')").all().map((l) => ({ ...l })), []);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM catalogo_itens').get().n, 0, 'nada registrado no Catálogo');
  // o preço cai de volta para dentro do filtro: a oferta (não registrada) sai na próxima execução
  ml.conferirProduto = async () => ({ price: 99, disponivel: true });
  const r2 = await scheduler.runRule(id);
  assert.equal(r2.offers, 1);
  assert.ok(wa.simulated.some((m) => m.text.includes('R$ 99,00')));
});

// ================================================================================ rodada 2: http vira https no ML

const HTML_ML = `<html><script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: 'Fone Bom', offers: { '@type': 'Offer', price: '89.90', availability: 'https://schema.org/InStock' } })}</script></html>`;

test('ML: link http:// da Lista de links é lido por https; a página só é pedida por https e sem porta, e o redirecionamento http é subido para https', async (t) => {
  const bloqueado = globalThis.fetch;
  const pedidos = [];
  t.after(() => { globalThis.fetch = bloqueado; });
  globalThis.fetch = async (url, init = {}) => {
    pedidos.push(String(url));
    assert.equal(init.redirect, 'manual', 'redirecionamento sempre manual');
    if (String(url) === 'https://produto.mercadolivre.com.br/MLB-1234567890-fone-bom-_JM') return new Response(null, { status: 301, headers: { location: 'http://www.mercadolivre.com.br/fone-bom/up/MLBU1' } });
    return new Response(HTML_ML, { status: 200, headers: { 'content-type': 'text/html' } });
  };
  const naoCalcula = async () => { throw new Error('API fora'); };
  const r = await mlReal.conferirProduto('http://produto.mercadolivre.com.br/MLB-1234567890-fone-bom-_JM', { fetchJson: naoCalcula });
  assert.deepEqual(r, { price: 89.9, disponivel: true });
  assert.deepEqual(pedidos, ['https://produto.mercadolivre.com.br/MLB-1234567890-fone-bom-_JM', 'https://www.mercadolivre.com.br/fone-bom/up/MLBU1'], 'nenhum pedido em http://');
  // o verificador inteiro (Disparo da lista, sem conferência velha): http digitado é conferido normalmente
  pedidos.length = 0;
  const db = openDb(tmp());
  const v = createVerificador({ db, ml: { conferirProduto: (u) => mlReal.conferirProduto(u, { fetchJson: naoCalcula }) } });
  const c = await v.conferir({ loja: 'mercadolivre', url: 'http://www.mercadolivre.com.br/p/MLB19', price: 89.9, digitado: true }, { lidoEm: null });
  assert.equal(c.acao, 'enviar'); assert.equal(c.conferido, true);
  assert.ok(pedidos.every((u) => u.startsWith('https://')), JSON.stringify(pedidos));
  // porta, usuário/senha, host de fora e http para outro site: recusados antes de qualquer pedido
  pedidos.length = 0;
  for (const url of ['https://produto.mercadolivre.com.br:8443/MLB-1234567890-x', 'http://produto.mercadolivre.com.br:8080/MLB-1234567890-x', 'https://usuario:senha@produto.mercadolivre.com.br/MLB-1234567890-x',
    'http://evil.example/produto.mercadolivre.com.br/MLB-1', 'ftp://produto.mercadolivre.com.br/MLB-1234567890-x', 'javascript:alert(1)']) {
    await assert.rejects(mlReal.conferirProduto(url, { fetchJson: naoCalcula }), (e) => { assert.ok(!e.message.includes('senha') && !e.message.includes('evil'), e.message); return true; }, url);
  }
  assert.deepEqual(pedidos, [], 'nenhum pedido saiu');
  // redirecionamento do ML para fora é recusado sem acessar o outro site
  globalThis.fetch = async (url) => { pedidos.push(String(url)); return new Response(null, { status: 302, headers: { location: 'http://evil.example/x' } }); };
  await assert.rejects(mlReal.conferirProduto('https://produto.mercadolivre.com.br/MLB-1234567890-x', { fetchJson: naoCalcula }));
  assert.deepEqual(pedidos, ['https://produto.mercadolivre.com.br/MLB-1234567890-x']);
});

// =================================================================================================== sem rede nenhuma

test('nenhum teste deste arquivo acessou a rede pelo fetch global', () => {
  assert.equal(acessosRede, 0);
  void MOTIVOS_VERIFICADOR; void segredosDe; void renderTemplate; void setSetting;
});
