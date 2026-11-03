// QA, espelhamento da Amazon, rodada 1 dos grupos C e D (etapas 12 a 15; 03/11/2026).
// Foco: a ligação de ponta a ponta (criarServicos/buildApp → wa._onMensagens → tick → simulated/socket falso),
// CA1, CA7, CA9, CA11, CA12, a ordem do tick, a retenção no main e o contrato tela ↔ API do Histórico.
// Sem rede (o fetch global é bloqueado e o último teste prova que ninguém o chamou), WhatsApp em dryRun (ou socket
// falso), banco numa pasta temporária. Não duplica test/espelho.test.js nem os outros qa-espelhamento*.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDb } from '../src/db.js';
import { buildApp, criarServicos } from '../src/server.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createLinkService } from '../src/links.js';
import { createAmazon } from '../src/amazon.js';
import { createScheduler } from '../src/scheduler.js';
import { segredosDe } from '../src/conexoes.js';
import { lerOfertaDoTexto } from '../src/oferta-texto.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let acessosRede = 0;
globalThis.fetch = async () => { acessosRede++; throw new Error('rede proibida no teste'); };

const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-qaec-')); pastas.push(p); return p; };

const HORA = 3600000;
const DIA = 24 * HORA;
const ORIGEM = '100@g.us';
const DEST1 = '200@g.us';
const DEST2 = '300@g.us';
const GRUPOS = [[ORIGEM, 'Ofertas Origem'], [DEST1, 'Achadinhos Tech'], [DEST2, 'Tech Dois']];
const ASIN = 'B0FG2MD49G';
const TAG = 'pedro-20';
const CRED_ID = 'credencial-id-0001';
const SEGREDO = 'segredo-super-secreto-123';
const TOKEN = 'token-oauth-secreto-xyz';
const SEGREDOS = [CRED_ID, SEGREDO, TOKEN];
const IMG = 'https://m.media-amazon.com/images/I/71abcDEF.jpg';
const URL_CURTO = 'https://link.amazon/2q3Xk9Z';
const URL_TERCEIRO = `https://www.amazon.com.br/Roteador-Mesh/dp/${ASIN}?tag=terceiro-20&crid=ABC123&qid=1730000000`;
const dp = (asin) => `https://www.amazon.com.br/dp/${asin}`;

const respJson = (status, corpo, headers = {}) => new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json', ...headers } });
const itemApi = (asin, preco = 1310.05) => ({
  asin, itemInfo: { title: { displayValue: `Produto ${asin} da Amazon` } },
  images: { primary: { large: { url: IMG, height: 500, width: 500 } } },
  offersV2: { listings: [{ isBuyBoxWinner: true, availability: { type: 'IN_STOCK' }, price: { money: { amount: preco }, savingBasis: { money: { amount: preco + 500 } } } }] },
});

/**
 * fetch falso da Amazon. estado.api: 'ok' | '403' | 'hostil500' | 'hostilThrow' | 'hostil401'; estado.preco: preço da
 * API (muda no meio do teste); estado.curtos: URL → Location.
 */
function fetchAmazon(estado) {
  const chamadas = [];
  const f = async (url, init = {}) => {
    const u = String(url);
    chamadas.push({ url: u, metodo: init.method || 'GET' });
    if (Object.hasOwn(estado.curtos, u)) return new Response(null, { status: 301, headers: { location: estado.curtos[u] } });
    if (u === 'https://api.amazon.com/auth/o2/token') {
      if (estado.api === 'hostil401') return respJson(401, { error: 'invalid_client', detalhe: `client_id=${CRED_ID} client_secret=${SEGREDO} Authorization: Bearer ${TOKEN}` });
      return respJson(200, { access_token: TOKEN, token_type: 'bearer', expires_in: 3600 });
    }
    if (u === 'https://creatorsapi.amazon/catalog/v1/getItems') {
      if (estado.api === '403') return respJson(403, { type: 'AccessDeniedException', reason: 'AssociateNotEligible' });
      if (estado.api === 'hostil500') return respJson(500, { message: `falha interna: client_id=${CRED_ID} client_secret=${SEGREDO} Authorization: Bearer ${TOKEN}` });
      if (estado.api === 'hostilThrow') throw new Error(`request failed: Authorization: Bearer ${TOKEN} client_id=${CRED_ID} secret=${SEGREDO} para ${u}`);
      const pedidos = JSON.parse(init.body).itemIds;
      return respJson(200, { itemsResult: { items: pedidos.map((a) => itemApi(a, estado.preco ?? 1310.05)) } });
    }
    throw new Error('rede não prevista no teste');
  };
  f.chamadas = chamadas;
  return f;
}

const hojeAs = (h, m = 0) => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime(); };
const capturarConsole = (t) => ['error', 'warn', 'log', 'info'].map((m) => t.mock.method(console, m, () => {}));
const textoDoConsole = (espias) => espias.flatMap((e) => e.mock.calls.map((c) => c.arguments.map(String).join(' '))).join('\n');
const semSegredo = (texto, onde) => { for (const x of SEGREDOS) assert.ok(!String(texto).includes(x), `${onde}: vazou credencial/segredo/token`); };

/** Espera por iterações (não pelo relógio: nos testes com `Date` falso o tempo não anda). */
async function esperarAte(cond, tentativas = 300) {
  for (let i = 0; i < tentativas && !cond(); i++) await new Promise((ok) => setTimeout(ok, 20));
  return cond();
}
const n = (db, sql, ...a) => db.prepare(sql).get(...a).n;
/** Nada em andamento: sem item sendo decidido ou vencido e sem envio pendente. Item adiado (espera_ate no futuro) conta como parado. */
const quieto = (db) => n(db, "SELECT COUNT(*) AS n FROM espelho_itens WHERE status = 'processando'") === 0
  && n(db, "SELECT COUNT(*) AS n FROM espelho_itens WHERE status = 'recebido' AND (espera_ate IS NULL OR espera_ate <= ?)", Date.now()) === 0
  && n(db, "SELECT COUNT(*) AS n FROM envios WHERE status IN ('pendente', 'enviando')") === 0;
const assentar = async (db) => { assert.ok(await esperarAte(() => quieto(db)), 'o agendador não assentou'); await new Promise((ok) => setTimeout(ok, 40)); };

/** Mensagem de grupo como o Baileys entrega no messages.upsert. `extra` vai na mensagem (participant, pushName). */
const upsert = (texto, id, { jid = ORIGEM, fromMe = false, extra = {} } = {}) => ({
  type: 'notify', messages: [{ key: { remoteJid: jid, fromMe, id }, message: { conversation: texto }, messageTimestamp: Math.floor(Date.now() / 1000), ...extra }],
});

/**
 * Serviços como o main os monta. composto: false = criarServicos (a ligação de verdade); true = a mesma composição
 * com `esperar` sem pausa (o limite de 1 chamada/s da API faria o teste esperar de verdade).
 */
function montar({ api = 'ok', composto = false, dryRun = true, tag = TAG, preco } = {}) {
  const dir = tmp();
  const db = openDb(dir);
  for (const [jid, nome] of GRUPOS) db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, nome, 10, Date.now());
  db.prepare("INSERT INTO conexoes (plataforma, config, segredos, updated_at) VALUES ('amazon', ?, ?, ?)")
    .run(JSON.stringify({ tag, credencial_versao: '3.1' }), JSON.stringify({ credencial_id: CRED_ID, credencial_secret: SEGREDO }), Date.now());
  const wa = createWhatsApp({ db, dir, dryRun }); if (dryRun) wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const estado = { api, preco, curtos: { [URL_CURTO]: URL_TERCEIRO, 'https://amzn.to/b': `${dp('B0AAAAAAA2')}?tag=terceiro-20` } };
  const fetchF = fetchAmazon(estado);
  let amazon; let scheduler;
  if (composto) {
    amazon = createAmazon({ db, fetch: fetchF, esperar: async () => {}, lerConexao: () => segredosDe(db, 'amazon') });
    scheduler = createScheduler({ db, wa, links, fast: true, dir, amazon });
    wa.onMensagem((m) => scheduler.espelho.receber(m));
  } else ({ amazon, scheduler } = criarServicos({ db, wa, links, fast: true, dir, fetch: fetchF }));
  const tpl = db.prepare("SELECT id FROM templates WHERE name = 'Amazon'").get().id;
  return {
    dir, db, wa, links, amazon, scheduler, estado, fetchF, tpl,
    regra: (extra = {}) => scheduler.espelho.criar({ nome: 'Amazon → Achadinhos', origem_jids: [ORIGEM], destino_jids: [DEST1, DEST2], template_id: tpl, ...extra }).id,
    msg: (texto, id, o) => wa._onMensagens(upsert(texto, id, o)),
    itens: () => db.prepare('SELECT * FROM espelho_itens ORDER BY id').all().map((r) => ({ ...r })),
    enviados: () => wa.simulated.filter((m) => m.jid !== 'status@broadcast'),
  };
}

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
async function subir(s) {
  const app = buildApp({ db: s.db, wa: s.wa, links: s.links, scheduler: s.scheduler, amazon: s.amazon, publicHost: '', panelPassword: '', dataDir: s.dir });
  const server = await new Promise((ok) => { const x = app.listen(0, '127.0.0.1', () => ok(x)); });
  return { port: server.address().port, fechar: async () => { server.closeAllConnections?.(); await new Promise((ok) => server.close(ok)); } };
}

// =================================================================================================== CA9 (laço)

test('CA9 (ponta a ponta, socket falso): o que o programa envia volta pelo upsert e nunca vira item, nem com "minhas mensagens" ligado em ciclo A → B → C → A; o controle prova que as regras B e C estão ativas', async () => {
  const s = montar({ dryRun: false });
  const idsOut = []; const chamadas = [];
  let ecoAntes = true; // eco "notify" com o mesmo id ANTES de sendMessage voltar: o id ainda não foi registrado
  const sock = {
    user: { id: '5531900000000:1@s.whatsapp.net' },
    sendMessage: async (jid, conteudo) => {
      const id = `OUT${idsOut.length + 1}`; idsOut.push(id);
      chamadas.push({ jid, id, texto: conteudo.caption ?? conteudo.text });
      if (ecoAntes) s.wa._onMensagens({ type: 'notify', messages: [{ key: { remoteJid: jid, fromMe: true, id }, message: { imageMessage: { caption: conteudo.caption } }, messageTimestamp: Math.floor(Date.now() / 1000) }] });
      return { key: { remoteJid: jid, fromMe: true, id } };
    },
  };
  s.wa._usarSocket(sock);
  // ciclo: A origem→DEST1 e DEST2; B DEST1→DEST2; C DEST2→ORIGEM; B e C espelham também as minhas mensagens
  s.regra({ nome: 'A' });
  s.regra({ nome: 'B', origem_jids: [DEST1], destino_jids: [DEST2], incluir_minhas: true });
  s.regra({ nome: 'C', origem_jids: [DEST2], destino_jids: [ORIGEM], incluir_minhas: true });

  s.msg(URL_CURTO, 'IN1');
  assert.ok(await esperarAte(() => chamadas.length >= 2 && quieto(s.db)), 'A enviou aos dois destinos');
  assert.deepEqual(chamadas.map((c) => c.jid).sort(), [DEST1, DEST2]);
  // eco depois do retorno (id registrado: guarda 1) e repostagem por outro membro com a mesma mensagem (nossa tag: guarda 2)
  for (const c of chamadas) {
    s.wa._onMensagens({ type: 'notify', messages: [{ key: { remoteJid: c.jid, fromMe: true, id: c.id }, message: { conversation: c.texto }, messageTimestamp: 1 }] });
    s.msg(c.texto, `REPOST-${c.id}`, { jid: c.jid });
  }
  await assentar(s.db);
  assert.equal(chamadas.length, 2, 'nenhum envio a mais: sem laço');
  assert.deepEqual(s.itens().map((i) => [i.espelho_id, i.origem_jid, i.status]), [[1, ORIGEM, 'enviado']], 'um item só; B e C não viram nada');
  assert.ok(chamadas.every((c) => c.texto.includes(`${dp(ASIN)}?tag=${TAG}`)));

  // controle: um link da Amazon sem a nossa tag postado por um membro em DEST1 É espelhado por B (as regras funcionam)
  ecoAntes = false;
  s.msg(`${dp('B0CONTROL1')}?tag=outro-20`, 'IN2', { jid: DEST1 });
  assert.ok(await esperarAte(() => chamadas.length >= 3 && quieto(s.db)));
  assert.equal(chamadas[2].jid, DEST2);
  await assentar(s.db);
  // e o eco do que B mandou (fromMe, id conhecido) com C ligada em DEST2 não gera mais nada
  s.wa._onMensagens({ type: 'notify', messages: [{ key: { remoteJid: DEST2, fromMe: true, id: chamadas[2].id }, message: { conversation: chamadas[2].texto }, messageTimestamp: 1 }] });
  await assentar(s.db);
  assert.equal(chamadas.length, 3);
  assert.deepEqual(s.itens().map((i) => i.espelho_id), [1, 2]);
  s.db.close();
});

// =================================================================================================== CA11 + CA7 (servidor)

const TODOS_OS_GETS = ['/api/state', '/api/espelhos', '/api/espelhos/itens', '/api/log', '/api/envios?tipo=oferta', '/api/simulados'];

function tabelasSemConexoes(db) {
  const nomes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'conexoes'").all().map((r) => r.name);
  return nomes.map((nome) => `${nome}: ${JSON.stringify(db.prepare(`SELECT * FROM "${nome}"`).all())}`).join('\n');
}

test('CA11 (servidor): número, pushName, e-mail e telefone do participante não chegam a nenhuma tabela, resposta do painel, console nem mensagem enviada; texto_origem fica mascarado e nunca vai ao navegador', async (t) => {
  const espias = capturarConsole(t);
  const s = montar({ api: '403' }); // sem API: o texto da origem alimenta a oferta
  s.regra();
  const srv = await subir(s);
  try {
    const texto = ['Fone Bluetooth JBL Tune 520BT', 'De R$ 399,00', 'Por R$ 199,00', 'Chama no zap 31 99999-8888 ou joana.silva@example.com', dp('B0TESTE001')].join('\n');
    s.wa._onMensagens(upsert(texto, 'PESSOAL1', { extra: { participant: '5531998765432@s.whatsapp.net', participantPn: '5531998765432@s.whatsapp.net', pushName: 'Joana Silva', verifiedBizName: 'Loja da Joana' } }));
    assert.ok(await esperarAte(() => s.enviados().length === 2 && quieto(s.db)));
    const [item] = s.itens();
    assert.equal(item.status, 'enviado'); assert.equal(item.fonte_dados, 'texto');
    assert.ok(item.texto_origem, 'o texto da origem foi guardado (mascarado)');
    const PROIBIDO = /5531998765432|99999-8888|999998888|joana\.silva|example\.com|Joana|Loja da Joana/i;
    assert.doesNotMatch(tabelasSemConexoes(s.db), PROIBIDO, 'banco inteiro (menos Conexões)');
    for (const caminho of TODOS_OS_GETS) {
      const r = await pedir(srv.port, 'GET', caminho);
      assert.equal(r.status, 200, caminho);
      assert.doesNotMatch(r.txt, PROIBIDO, caminho);
    }
    for (const rota of ['/api/espelhos/itens', '/api/espelhos', '/api/state', '/api/log']) {
      const r = await pedir(srv.port, 'GET', rota);
      assert.doesNotMatch(r.txt, /texto_origem|Fone Bluetooth JBL Tune 520BT.*De R\$|Chama no zap/s, `${rota}: texto da origem foi ao navegador`);
    }
    assert.doesNotMatch(textoDoConsole(espias), PROIBIDO, 'console');
  } finally { await srv.fechar(); s.db.close(); }
});

test('CA7 (servidor): API que responde 500 ou 401 com a credencial no corpo, ou rede que lança com o token na mensagem, não vaza em log, console, banco, respostas do painel nem na prévia do "Testar"; a tag só sai inteira ao WhatsApp', async (t) => {
  const espias = capturarConsole(t);
  for (const api of ['hostil500', 'hostil401', 'hostilThrow']) {
    const s = montar({ api });
    const id = s.regra();
    const srv = await subir(s);
    try {
      // com o texto escrito (sai pelo texto) e só o link (vai para a fila): os dois caminhos de falha da API
      s.msg(['Roteador Mesh TP-Link Deco BE22, Wi-Fi 7', 'De R$ 1.999,00', 'Por R$ 1.310,05', dp('B0HOSTI001')].join('\n'), `H1-${api}`);
      s.msg(dp('B0HOSTI002'), `H2-${api}`);
      assert.ok(await esperarAte(() => s.itens().length === 2 && quieto(s.db)), api);
      assert.deepEqual(s.itens().map((i) => i.status), ['enviado', 'na_fila'], api);
      const r = await pedir(srv.port, 'POST', `/api/espelhos/${id}/testar`, { texto: `Teste\nPor R$ 10,00\n${dp('B0HOSTI003')}` });
      assert.equal(r.status, 200, r.txt);
      for (const caminho of ['/api/state', '/api/espelhos', '/api/espelhos/itens', '/api/log', '/api/envios?tipo=oferta']) {
        const g = await pedir(srv.port, 'GET', caminho);
        semSegredo(g.txt, `${api} ${caminho}`);
        assert.ok(!g.txt.includes(TAG), `${api} ${caminho}: a tag apareceu fora da mensagem enviada ao WhatsApp`);
      }
      semSegredo(r.txt, `${api} testar`);
      assert.ok(!r.txt.includes(TAG), `${api} testar: tag sem máscara`);
      semSegredo(tabelasSemConexoes(s.db), `${api} banco`);
      semSegredo(JSON.stringify(s.wa.simulated), `${api} mensagens enviadas`);
      // a mensagem de WhatsApp leva a tag (é o que o dono quer), e só ela
      assert.ok(s.enviados().every((m) => m.text.includes(`?tag=${TAG}`)));
    } finally { await srv.fechar(); s.db.close(); }
  }
  semSegredo(textoDoConsole(espias), 'console');
});

// =================================================================================================== CA12 (pelo tick)

test('CA12 (pelo tick): fora da janela o item espera com espera_ate na abertura e, ao abrir, sai com o preço reconsultado na hora; janela que vira a noite; antes de abrir nada sai', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: hojeAs(10, 0) });
  const s = montar({ composto: true, preco: 100 });
  s.regra({ janela_inicio: '14:00', janela_fim: '18:00' });
  s.msg(dp('B0JANEL001'), 'J1');
  assert.ok(await esperarAte(() => s.itens()[0]?.espera_ate != null && quieto(s.db)));
  let [item] = s.itens();
  assert.equal(item.status, 'recebido'); assert.equal(item.espera_ate, hojeAs(14, 0));
  assert.match(item.motivo, /aguardando o horário \(abre às 14:00\)/);
  assert.equal(s.enviados().length, 0);
  assert.equal(s.fetchF.chamadas.filter((c) => c.url.includes('getItems')).length, 0, 'fora da janela não consulta a API');

  t.mock.timers.setTime(hojeAs(13, 59));
  await s.scheduler.tick();
  assert.equal(s.enviados().length, 0, 'um minuto antes de abrir ainda espera');
  s.estado.preco = 249.9; // o preço mudou enquanto esperava
  t.mock.timers.setTime(hojeAs(14, 0) + 1000);
  await s.scheduler.tick();
  assert.equal(s.enviados().length, 2);
  assert.ok(s.enviados().every((m) => /R\$ 249,90/.test(m.text) && !/R\$ 100,00/.test(m.text)), 'dados consultados na hora de sair');
  assert.equal(s.itens()[0].status, 'enviado'); assert.equal(s.itens()[0].espera_ate, null);

  // janela que vira a noite (22:00 → 02:00): ao meio-dia espera até as 22:00 de hoje
  s.db.prepare('UPDATE espelhos SET janela_inicio = ?, janela_fim = ?').run('22:00', '02:00');
  t.mock.timers.setTime(hojeAs(12, 0));
  s.msg(dp('B0JANEL002'), 'J2');
  assert.ok(await esperarAte(() => s.itens()[1]?.espera_ate != null && quieto(s.db)));
  assert.equal(s.itens()[1].espera_ate, hojeAs(22, 0));
  t.mock.timers.setTime(hojeAs(23, 30));
  await s.scheduler.tick();
  assert.equal(s.itens()[1].status, 'enviado');
  s.db.close();
});

test('CA12 (pelo tick): acima do máximo por hora o excedente espera até a hora do primeiro envio + 1 h e sai então; ordem de chegada preservada', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: hojeAs(9, 0) });
  const s = montar({ composto: true });
  s.regra({ max_por_hora: 2 });
  for (const [i, a] of ['B0MAXHOR01', 'B0MAXHOR02', 'B0MAXHOR03', 'B0MAXHOR04'].entries()) { t.mock.timers.setTime(hojeAs(9, i)); s.msg(dp(a), `M${i}`); await assentar(s.db); }
  assert.deepEqual(s.itens().map((i) => i.status), ['enviado', 'enviado', 'recebido', 'recebido']);
  assert.equal(s.enviados().length, 4, 'dois itens × dois destinos');
  const primeiro = s.itens()[0].decidido_em;
  assert.deepEqual(s.itens().slice(2).map((i) => i.espera_ate), [primeiro + HORA, primeiro + HORA]);
  t.mock.timers.setTime(primeiro + HORA - 1000);
  await s.scheduler.tick();
  assert.equal(s.enviados().length, 4, 'ainda não passou 1 h');
  t.mock.timers.setTime(primeiro + HORA + 1000);
  await s.scheduler.tick();
  assert.deepEqual(s.itens().map((i) => i.status), ['enviado', 'enviado', 'enviado', 'recebido'], 'abre uma vaga: só o 3º sai, o 4º continua esperando');
  assert.ok(s.enviados().slice(4).every((m) => m.text.includes('B0MAXHOR03')));
  s.db.close();
});

test('CA12 (pelo tick): item parado há mais de 2 h expira em vez de sair, tanto o que ficou "processando" (queda no meio) quanto o que nem foi decidido; o start() recupera antes do primeiro tick', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: hojeAs(12, 0) });
  const s = montar({ composto: true });
  const id = s.regra();
  const velho = Date.now() - 3 * HORA; const novo = Date.now() - 10 * 60000;
  const ins = s.db.prepare("INSERT INTO espelho_itens (espelho_id, origem_jid, origem_nome, msg_id, ts, url, asin, status) VALUES (?, ?, 'Ofertas Origem', ?, ?, ?, ?, ?)");
  ins.run(id, ORIGEM, 'Q1', velho, dp('B0PARAD001'), 'B0PARAD001', 'processando'); // caiu no meio da decisão
  ins.run(id, ORIGEM, 'Q2', velho, dp('B0PARAD002'), 'B0PARAD002', 'recebido'); // serviço desligado desde então
  ins.run(id, ORIGEM, 'Q3', novo, dp('B0RECENT01'), 'B0RECENT01', 'processando'); // caiu agora há pouco: ainda vale
  s.scheduler.start(); s.scheduler.stop(); // recuperar() roda sincronamente no start; os timers ficam parados
  await s.scheduler.tick();
  assert.deepEqual(s.itens().map((i) => [i.msg_id, i.status]), [['Q1', 'expirado'], ['Q2', 'expirado'], ['Q3', 'enviado']]);
  assert.match(s.itens()[0].motivo, /mais de 2 h/);
  assert.ok(s.enviados().every((m) => m.text.includes('B0RECENT01')), 'só o recente saiu');
  assert.equal(s.enviados().length, 2);
  assert.equal(s.fetchF.chamadas.filter((c) => c.url.includes('getItems') && /B0PARAD/.test(String(c.url))).length, 0);
  const log = s.db.prepare("SELECT message FROM log WHERE rule_name LIKE 'Espelho:%'").all().map((l) => l.message);
  assert.equal(log.filter((m) => /^Descartada: ficou parada mais de 2 h/.test(m)).length, 2);
  s.db.close();
});

// =================================================================================================== ordem, concorrência, idempotência

test('tick: várias mensagens, ticks simultâneos e a mesma mensagem entregue duas vezes não duplicam envio; o mesmo produto postado por dois membros no mesmo lote sai uma vez só', async () => {
  const s = montar({ composto: true });
  s.regra();
  // reentrega do mesmo id (reconexão do Baileys) + dois membros postando o mesmo produto + um produto diferente
  s.msg(dp('B0IDEMPO01'), 'DUP1'); s.msg(dp('B0IDEMPO01'), 'DUP1');
  s.msg(`${dp('B0IDEMPO01')}?ref=outro`, 'DUP2');
  s.msg(dp('B0IDEMPO02'), 'DUP3');
  await Promise.all([s.scheduler.tick(), s.scheduler.tick(), s.scheduler.tick()]);
  await assentar(s.db);
  assert.deepEqual(s.itens().map((i) => [i.msg_id, i.status]), [['DUP1', 'enviado'], ['DUP2', 'duplicado'], ['DUP3', 'enviado']]);
  assert.match(s.itens()[1].motivo, /repetida/);
  const porDestino = (jid, asin) => s.enviados().filter((m) => m.jid === jid && m.text.includes(asin)).length;
  for (const jid of [DEST1, DEST2]) { assert.equal(porDestino(jid, 'B0IDEMPO01'), 1, jid); assert.equal(porDestino(jid, 'B0IDEMPO02'), 1, jid); }
  assert.equal(s.enviados().length, 4);
  assert.equal(n(s.db, 'SELECT COUNT(*) AS n FROM envios'), 2);
  s.db.close();
});

test('tick: WhatsApp fora do ar na hora de enviar → o item fica "enviado" com o envio pendente e sai uma vez quando volta; o link não é espelhado de novo enquanto espera', async () => {
  const s = montar({ composto: true });
  s.regra();
  let pronto = false;
  const isReadyReal = s.wa.isReady; s.wa.isReady = () => pronto && isReadyReal();
  s.msg(dp('B0OFFLIN01'), 'OFF1');
  assert.ok(await esperarAte(() => s.itens()[0]?.status === 'enviado'));
  await new Promise((ok) => setTimeout(ok, 60));
  assert.equal(s.enviados().length, 0);
  assert.equal(n(s.db, "SELECT COUNT(*) AS n FROM envios WHERE status = 'pendente'"), 1);
  s.msg(dp('B0OFFLIN01'), 'OFF2'); // outro membro posta o mesmo produto enquanto o envio espera
  await new Promise((ok) => setTimeout(ok, 100));
  pronto = true;
  await s.scheduler.tick();
  await assentar(s.db);
  assert.deepEqual(s.itens().map((i) => i.status), ['enviado', 'duplicado']);
  assert.equal(s.enviados().length, 2, 'uma imagem por destino, uma vez');
  s.db.close();
});

test('Q2 (CA12): se o WhatsApp só volta depois de 2 h, o envio perde o horário; o Histórico não pode continuar mostrando "Espelhada" como se tivesse saído', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: hojeAs(8, 0) });
  const s = montar({ composto: true });
  s.regra();
  let pronto = false;
  const isReadyReal = s.wa.isReady; s.wa.isReady = () => pronto && isReadyReal();
  s.msg(dp('B0OFFLIN02'), 'OFF3');
  assert.ok(await esperarAte(() => s.itens()[0]?.status === 'enviado'));
  t.mock.timers.setTime(hojeAs(11, 0)); pronto = true;
  await s.scheduler.tick();
  assert.equal(s.enviados().length, 0, 'nada sai: perdeu o horário');
  assert.equal(n(s.db, "SELECT COUNT(*) AS n FROM envios WHERE status = 'erro'"), 1);
  const srv = await subir(s);
  try {
    const r = await pedir(srv.port, 'GET', '/api/espelhos/itens');
    const it = r.json[0];
    // o item nunca chegou a nenhum grupo: a tela precisa dizer isso (erro ou destino com falha), não "Espelhada ... enviando"
    const dizSaiu = it.status === 'enviado' && it.destinos.every((d) => d.ok == null);
    assert.ok(!dizSaiu, `item ${it.id} segue "enviado" com destinos sem resultado, e o envio ${it.envio_id} está em erro (perdeu o horário): o Histórico mostra "Espelhada · enviando…" para sempre`);
  } finally { await srv.fechar(); s.db.close(); }
});

// =================================================================================================== retenção e recuperar no main

test('main (processo de verdade): ao subir, apaga os itens antigos já decididos (guarda os que ainda contam para "Horas sem repetir" e os ativos) e recupera o que ficou "processando"', async (t) => {
  const dir = tmp();
  const db = openDb(dir);
  for (const [jid, nome] of GRUPOS) db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, nome, 10, Date.now());
  const agora = Date.now();
  const esp = db.prepare("INSERT INTO espelhos (nome, enabled, origem_jids, destino_jids, template_id, dedupe_horas, created_at, updated_at) VALUES (?, 1, ?, ?, 1, ?, ?, ?)");
  const curto = Number(esp.run('curta', JSON.stringify([ORIGEM]), JSON.stringify([DEST1]), 24, agora, agora).lastInsertRowid);
  const longo = Number(esp.run('longa', JSON.stringify([ORIGEM]), JSON.stringify([DEST1]), 8760, agora, agora).lastInsertRowid);
  const ins = db.prepare("INSERT INTO espelho_itens (espelho_id, origem_jid, msg_id, ts, url, asin, status, decidido_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const antigo = agora - 120 * DIA; const dezDias = agora - 100 * DIA;
  ins.run(curto, ORIGEM, 'v-desc', antigo, dp('B0VELHO001'), 'B0VELHO001', 'descartado', antigo); // apaga
  ins.run(curto, ORIGEM, 'v-env-curta', antigo, dp('B0VELHO002'), 'B0VELHO002', 'enviado', antigo); // fora de 24 h: apaga
  ins.run(longo, ORIGEM, 'v-env-longa', dezDias, dp('B0VELHO003'), 'B0VELHO003', 'enviado', dezDias); // dedupe de 1 ano: fica
  ins.run(curto, ORIGEM, 'v-recente', agora - 3600000, dp('B0RECENT02'), 'B0RECENT02', 'descartado', agora - 3600000); // novo: fica
  ins.run(longo, ORIGEM, 'v-fila', agora - 2 * HORA, dp('B0FILA0001'), 'B0FILA0001', 'na_fila', agora - 2 * HORA); // ativo: fica
  ins.run(curto, ORIGEM, 'v-proc', agora - 60000, dp('B0CAIU0001'), 'B0CAIU0001', 'processando', null); // caiu no meio
  db.close();

  const bloqueio = path.join(dir, 'sem-rede.mjs');
  fs.writeFileSync(bloqueio, "globalThis.fetch = async () => { throw new Error('rede proibida no teste'); };\n");
  const env = { ...process.env, PORT: '0', DATA_DIR: dir, DRY_RUN: '1', FAST: '1', PANEL_PASSWORD: '', PUBLIC_HOST: '' };
  const filho = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', pathToFileURL(bloqueio).href, path.join(RAIZ, 'src', 'server.js')], { cwd: RAIZ, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const saiu = new Promise((r) => filho.once('exit', r));
  t.after(() => { if (filho.exitCode == null && filho.signalCode == null) filho.kill('SIGKILL'); });
  let saida = '';
  filho.stdout.on('data', (c) => { saida += c; }); filho.stderr.on('data', (c) => { saida += c; });
  const ler = () => { const d = openDb(dir); try { return d.prepare('SELECT msg_id, status, motivo FROM espelho_itens ORDER BY id').all().map((r) => ({ ...r })); } finally { d.close(); } };
  // recuperar() devolve o item a "recebido" no start; o primeiro tick roda 2 s depois e o decide (sem tag: erro)
  assert.ok(await esperarAte(() => ler().find((i) => i.msg_id === 'v-proc')?.status === 'erro', 400), `o item "processando" não foi recuperado e decidido:\n${JSON.stringify(ler())}\n${saida}`);
  filho.kill('SIGTERM'); await saiu;
  const itens = ler();
  assert.deepEqual(itens.map((i) => i.msg_id), ['v-env-longa', 'v-recente', 'v-fila', 'v-proc']);
  assert.match(saida, /Retenção \(espelhamento\): apagados 2 itens antigos\./);
  const proc = itens.find((i) => i.msg_id === 'v-proc');
  assert.equal(proc.status, 'erro'); assert.match(proc.motivo, /tag de associado/, 'recuperado, decidido no primeiro tick (sem tag configurada)');
  assert.doesNotMatch(saida, /rede proibida|ERRO/);
});

// =================================================================================================== UI: contrato tela ↔ API

function carregarTela() {
  const app = fs.readFileSync(path.join(RAIZ, 'public', 'app.js'), 'utf8');
  const pega = (nome) => app.split('\n').find((l) => l.startsWith(`const ${nome} = `));
  const ctx = { hora: () => '03/11, 10:00:00', S: { st: {}, templates: [], groups: [] } };
  vm.createContext(ctx);
  vm.runInContext(`${pega('esc')}\n${pega('zap')}\n${fs.readFileSync(path.join(RAIZ, 'public', 'espelhamento.js'), 'utf8')}\nglobalThis.__x = { espResultado, espLinhaHtml, histEhAutomatico, zap, esc, TEXTOS_ESPELHAMENTO };`, ctx);
  return ctx.__x;
}

test('tela ↔ API (CA1, CA3, CA4, CA5): os itens que o servidor de verdade devolve viram o texto certo no Histórico; título hostil vindo do grupo de origem sai escapado; a linha não leva tag, link bruto nem texto da origem; o log do espelho não aparece em "Disparo automático"', async () => {
  const P = carregarTela();
  const s = montar({ api: '403' });
  s.regra({ palavras_bloqueadas: ['usado'] });
  const srv = await subir(s);
  try {
    const hostil = 'Fone <img src=x onerror=alert(1)> JBL "Tune" & Cia';
    s.msg([hostil, 'De R$ 399,00', 'Por R$ 199,00', 'Frete Grátis', dp('B0TELA0001')].join('\n'), 'T1'); // texto → enviado
    s.msg(dp('B0TELA0002'), 'T2'); // sem dados → fila
    s.msg(dp('B0TELA0001'), 'T3'); // repetida
    s.msg(['Fone usado JBL', 'Por R$ 99,00', dp('B0TELA0003')].join('\n'), 'T4'); // palavra bloqueada
    s.msg('https://amzn.to/nao-existe', 'T5'); // não resolve
    assert.ok(await esperarAte(() => s.itens().length === 5 && quieto(s.db)));
    const r = await pedir(srv.port, 'GET', '/api/espelhos/itens');
    const por = (msgAsin) => r.json.find((i) => i.asin === msgAsin);
    const env = r.json.find((i) => i.status === 'enviado');
    const fila = r.json.find((i) => i.status === 'na_fila');
    const rep = r.json.find((i) => i.status === 'duplicado');
    const pal = r.json.find((i) => i.status === 'descartado');
    const erro = r.json.find((i) => i.status === 'erro');
    assert.ok(env && fila && rep && pal && erro, JSON.stringify(r.json.map((i) => [i.status, i.motivo])));
    assert.deepEqual(JSON.parse(JSON.stringify(P.espResultado(env))), { cls: 'nivel-ok', texto: 'Espelhada', detalhe: 'com o texto da origem', extra: [] });
    assert.match(P.espResultado(fila).texto, /^Na fila: falta completar \(sem título e preço\)/);
    assert.match(P.espResultado(rep).texto, /^Descartada: repetida \(enviada há menos de 1 h\)$/);
    assert.equal(P.espResultado(pal).texto, 'Descartada: palavra bloqueada (usado)');
    assert.equal(P.espResultado(erro).cls, 'nivel-aviso'); assert.equal(P.espResultado(erro).texto, 'Descartada: link não resolvido');
    assert.ok(por('B0TELA0002') === fila);
    // HTML da linha: título hostil escapado, botão Completar só na fila, nada de tag/URL/texto da origem
    const html = P.espLinhaHtml(env);
    assert.ok(!html.includes('<img'), 'o título do grupo de terceiros virou marcação');
    assert.ok(html.includes('Fone &lt;img src=x onerror=alert(1)&gt; JBL &quot;Tune&quot; &amp; Cia'), html);
    assert.ok(!P.espLinhaHtml(env).includes('data-completar') && P.espLinhaHtml(fila).includes(`data-completar="${fila.id}"`));
    for (const it of r.json) {
      const h = P.espLinhaHtml(it);
      assert.ok(!h.includes(TAG) && !/tag=|link\.amazon|amzn\.to|texto_origem/.test(h), `linha ${it.id} mostra dado que não devia`);
    }
    // a prévia do "Completar" passa o título pelo zap(): a marcação do grupo de origem não pode virar HTML
    assert.ok(!P.zap(`*${hostil}*`).includes('<img'));
    // /api/log: as linhas do espelho não são "Disparo automático"
    const log = (await pedir(srv.port, 'GET', '/api/log')).json;
    const doEspelho = log.filter((l) => String(l.rule_name).startsWith('Espelho: '));
    assert.ok(doEspelho.length >= 5);
    assert.ok(doEspelho.every((l) => !P.histEhAutomatico(l)));
  } finally { await srv.fechar(); s.db.close(); }
});

test('servidor (CA3, CA1): completar um item da fila pelo HTTP envia a imagem com os valores ajustados e o link limpo; repetir dá 409; descartar item já tratado dá 409; sem WhatsApp dá 400 e o item continua na fila', async () => {
  const s = montar({ api: '403' });
  s.regra();
  const srv = await subir(s);
  try {
    s.msg(dp('B0COMPLET1'), 'C1'); s.msg(dp('B0COMPLET2'), 'C2');
    assert.ok(await esperarAte(() => s.itens().length === 2 && quieto(s.db)));
    const [a, b] = s.itens();
    let r = await pedir(srv.port, 'POST', `/api/espelhos/itens/${a.id}/enviar`, { ajustes: { title: 'Cafeteira 3 em 1', price: '1.299,90', oldPrice: '1.999,00' } });
    assert.equal(r.status, 200, r.txt);
    assert.ok(await esperarAte(() => s.enviados().length === 2 && quieto(s.db)));
    for (const m of s.enviados()) {
      assert.equal(m.tipo, 'text', 'sem foto da API (403) sai como texto');
      assert.match(m.text, /Cafeteira 3 em 1/); assert.match(m.text, /R\$ 1\.299,90/);
      assert.ok(m.text.endsWith(`${dp('B0COMPLET1')}?tag=${TAG}`) || m.text.includes(`${dp('B0COMPLET1')}?tag=${TAG}`));
    }
    r = await pedir(srv.port, 'POST', `/api/espelhos/itens/${a.id}/enviar`, { ajustes: { title: 'x', price: 10 } });
    assert.equal(r.status, 409);
    r = await pedir(srv.port, 'POST', `/api/espelhos/itens/${a.id}/descartar`);
    assert.equal(r.status, 409);
    assert.equal(s.enviados().length, 2, 'o 409 não enviou nada');
    // WhatsApp desconectado: recusa sem tocar no item
    const real = s.wa.isReady; s.wa.isReady = () => false;
    r = await pedir(srv.port, 'POST', `/api/espelhos/itens/${b.id}/enviar`, { ajustes: { title: 'Outro', price: 50 } });
    s.wa.isReady = real;
    assert.equal(r.status, 400); assert.match(r.json.erro, /WhatsApp está desconectado/);
    assert.equal(s.itens()[1].status, 'na_fila');
    // sem título: 400 com o texto do servidor
    r = await pedir(srv.port, 'POST', `/api/espelhos/itens/${b.id}/enviar`, { ajustes: { price: 50 } });
    assert.equal(r.status, 400); assert.match(r.json.erro, /título/);
    assert.equal(s.itens()[1].status, 'na_fila');
  } finally { await srv.fechar(); s.db.close(); }
});

test('formulário ↔ servidor: o corpo que o formulário monta é aceito (nova e edição) e cada erro que o cliente mostra tem a mesma mensagem do servidor', async () => {
  const T = carregarTela().TEXTOS_ESPELHAMENTO;
  const s = montar();
  const srv = await subir(s);
  try {
    const semLink = Number(s.db.prepare("INSERT INTO templates (name, body, created_at) VALUES ('Sem link', 'Oferta {TITULO}', 1)").run().lastInsertRowid);
    // exatamente as chaves e os tipos que public/espelhamento.js envia no submit
    const corpo = (extra = {}) => ({
      nome: 'Eletrônicos', origem_jids: [ORIGEM], destino_jids: [DEST1], template_id: s.tpl, incluir_minhas: false, dedupe_horas: 168,
      palavras_bloqueadas: ['usado', 'vitrine'], sem_preco: 'fila', max_por_hora: 10, janela_inicio: null, janela_fim: null, enviar_foto: true, enabled: true, ...extra,
    });
    let r = await pedir(srv.port, 'POST', '/api/espelhos', corpo());
    assert.equal(r.status, 200, r.txt);
    const id = r.json.id;
    const edicao = corpo({ nome: 'Eletrônicos 2', janela_inicio: '08:00', janela_fim: '22:00', sem_preco: 'curto', enviar_foto: false, dedupe_horas: 0, max_por_hora: 0 });
    delete edicao.enabled; // a edição não manda "enabled": o servidor mantém o que já era
    r = await pedir(srv.port, 'PUT', `/api/espelhos/${id}`, edicao);
    assert.equal(r.status, 200, r.txt);
    const salvo = (await pedir(srv.port, 'GET', '/api/espelhos')).json.espelhos[0];
    assert.deepEqual([salvo.nome, salvo.janela_inicio, salvo.janela_fim, salvo.sem_preco, salvo.enviar_foto, salvo.dedupe_horas, salvo.max_por_hora, salvo.enabled], ['Eletrônicos 2', '08:00', '22:00', 'curto', false, 0, 0, true]);
    const erro = async (extra, esperado, rotulo) => {
      const x = await pedir(srv.port, 'POST', '/api/espelhos', corpo(extra));
      assert.equal(x.status, 400, rotulo); assert.equal(x.json.erro, esperado, rotulo);
    };
    await erro({ nome: '' }, T.erroNome, 'nome');
    await erro({ origem_jids: [] }, T.erroOrigem, 'origem');
    await erro({ destino_jids: [] }, T.erroDestino, 'destino');
    await erro({ origem_jids: [ORIGEM, DEST1], destino_jids: [DEST1] }, T.erroAmbos('Achadinhos Tech'), 'origem = destino');
    await erro({ template_id: null }, T.erroTemplate, 'template');
    await erro({ template_id: semLink }, T.erroLink, 'template sem {LINK}');
    await erro({ dedupe_horas: 9000 }, T.erroRepetir, 'dedupe');
    await erro({ max_por_hora: 61 }, T.erroMaxHora, 'máximo por hora');
    await erro({ janela_inicio: '08:00' }, T.erroJanela, 'janela com um lado só');
    await erro({ palavras_bloqueadas: ['x'.repeat(61)] }, T.erroPalavraGrande, 'palavra grande');
    await erro({ palavras_bloqueadas: Array.from({ length: 51 }, (_, i) => `p${i}`) }, T.erroPalavrasMuitas, 'palavras demais');
    assert.equal((await pedir(srv.port, 'GET', '/api/espelhos')).json.espelhos.length, 1, 'nenhum erro gravou regra');
  } finally { await srv.fechar(); s.db.close(); }
});

// =================================================================================================== título do texto da origem

test('Q1 (CA3): título que termina em "Link" (TP-Link, D-Link) é lido como título, não descartado como "Compre aqui: link"', () => {
  for (const titulo of ['Roteador Wi-Fi TP-Link', 'Switch 8 portas D-Link']) {
    const r = lerOfertaDoTexto([titulo, 'Por R$ 199,00', dp(ASIN)].join('\n'));
    assert.equal(r.title, titulo, `o título "${titulo}" foi descartado pelo filtro de "Compre aqui: link"`);
  }
  // o filtro continua valendo para a linha de chamada que ficou sem o link
  assert.equal(lerOfertaDoTexto(['Compre aqui: link', 'Por R$ 199,00', dp(ASIN)].join('\n')).title, null);
});

// =================================================================================================== CA10

test('CA10: nada neste arquivo chamou o fetch global (a Amazon e os encurtadores foram simulados)', () => {
  assert.equal(acessosRede, 0);
});
