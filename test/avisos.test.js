// Relatórios e avisos (plano disparos-comunicacao-conta, etapa 11): destinos com número canônico e listagem mascarada,
// "Enviar resumo agora", resumo diário 1× por dia de negócio, aviso de erro agregado (no máximo 1 a cada 30 min),
// lotação com dedupe, virada do dia e limite padrão. Servidor em porta aleatória e WhatsApp simulado: nenhum teste
// acessa a rede. O número dos destinos é dado pessoal: nenhum teste aceita vê-lo no log nem no console.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openDb, getSetting, setSetting } from '../src/db.js';
import { buildApp } from '../src/server.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createLinkService } from '../src/links.js';
import { createScheduler } from '../src/scheduler.js';
import { createAvisos, mascararNumero, semNumero } from '../src/avisos.js';
import { startOfDay } from '../src/analytics.js';

let acessosRede = 0;
globalThis.fetch = async () => { acessosRede++; throw new Error('rede proibida no teste'); };

// Espião do console: tudo o que este arquivo imprimir fica aqui para conferir que nenhum número vazou.
const saidaConsole = [];
for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
  const original = console[k].bind(console);
  console[k] = (...a) => { saidaConsole.push(a.map((x) => (x instanceof Error ? `${x.message} ${x.stack}` : String(x))).join(' ')); original(...a); };
}

const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-avi-')); pastas.push(p); return p; };

const SENHA = 'senha-de-teste-123';
const NUM = '(11) 98765-4321'; const JID = '5511987654321@s.whatsapp.net';
const NUM2 = '21 91234-5678'; const JID2 = '5521912345678@s.whatsapp.net';
const NUM3 = '31 99876-5432'; const JID3 = '5531998765432@s.whatsapp.net';
// pedaços que só existem no número completo (os 4 últimos aparecem de propósito na máscara)
const VAZAMENTO = /98765|5511987|91234|5521912|99876|5531998|@s\.whatsapp\.net/;
const at = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime(); // novembro de 2026, hora local

/** Banco, WhatsApp simulado, agendador, dois grupos e um bloco para cada. */
function montar() {
  const dir = tmp(); const db = openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const scheduler = createScheduler({ db, wa, links, fast: true, dir });
  const grupo = db.prepare('INSERT INTO groups (jid, name, size, updated_at, invite_code) VALUES (?,?,?,?,?)');
  grupo.run('g1@g.us', 'Casa', 100, Date.now(), 'AAAAAAAAAAAA'); grupo.run('g2@g.us', 'Beleza', 50, Date.now(), 'BBBBBBBBBBBB');
  const bloco = (nome, jid) => {
    const id = Number(db.prepare('INSERT INTO blocks (name, created_at) VALUES (?,?)').run(nome, 1).lastInsertRowid);
    db.prepare('INSERT INTO block_groups (block_id, jid) VALUES (?,?)').run(id, jid); return id;
  };
  return { dir, db, wa, links, scheduler, casa: bloco('Casa', 'g1@g.us'), beleza: bloco('Beleza', 'g2@g.us') };
}
function subir() {
  const m = montar();
  const app = buildApp({ db: m.db, wa: m.wa, links: m.links, scheduler: m.scheduler, publicHost: 'painel.exemplo.com', panelPassword: SENHA, dataDir: m.dir });
  return new Promise((ok) => {
    const server = app.listen(0, '127.0.0.1', () => ok({
      ...m, port: server.address().port,
      fechar: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => { m.db.close(); r(); }); }),
    }));
  });
}
function req(port, caminho, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((ok, err) => {
    const data = body != null ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, path: caminho, method, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let txt = ''; res.setEncoding('utf8'); res.on('data', (c) => (txt += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(txt); } catch { /* html */ } ok({ status: res.statusCode, headers: res.headers, json, txt }); });
    });
    r.on('error', err); if (data) r.write(data); r.end();
  });
}
/** Entra e devolve um cliente com cookie e Origin da casa. */
async function cliente(s) {
  const login = await req(s.port, '/api/login', { method: 'POST', body: { senha: SENHA } });
  const headers = { cookie: login.headers['set-cookie'][0].split(';')[0], origin: `http://127.0.0.1:${s.port}` };
  return (caminho, method = 'GET', body) => req(s.port, caminho, { method, headers, body: body ?? (['POST', 'PUT'].includes(method) ? {} : undefined) });
}
const paraJid = (wa, jid) => wa.simulated.filter((m) => m.jid === jid);
const destino = (db, { nome = 'Pedro', jid = JID, blocos = null, avisos = [], ativo = 1 } = {}) => Number(db.prepare(
  'INSERT INTO aviso_destinos (nome, jid, resumo_blocos, avisos, ativo, created_at) VALUES (?,?,?,?,?,?)',
).run(nome, jid, blocos == null ? null : JSON.stringify(blocos), JSON.stringify(avisos), ativo, 1).lastInsertRowid);
const erroNoLog = (db, ts, message) => db.prepare("INSERT INTO log (ts, rule_name, level, group_name, message) VALUES (?, 'R', 'erro', 'Casa', ?)").run(ts, message);
/** Nenhum número nem JID de destino na tabela log. */
function semNumeroNoLog(db) {
  for (const l of db.prepare('SELECT * FROM log').all()) assert.doesNotMatch(Object.values(l).join(' | '), VAZAMENTO, 'número no log');
}

// ---------- destinos ----------
test('destinos: JID canônico gravado, listagem mascarada, número inválido ou fora do WhatsApp dá 400, edição e remoção', async () => {
  const s = await subir();
  try {
    const api = await cliente(s);
    const r = await api('/api/avisos/destinos', 'POST', { nome: ' Pedro ', numero: NUM, resumo_blocos: [s.casa], avisos: ['erro', 'lotacao', 'outro'], ativo: true });
    assert.equal(r.status, 200, r.txt);
    assert.deepEqual({ ...s.db.prepare('SELECT nome, jid, resumo_blocos, avisos, ativo FROM aviso_destinos').get() },
      { nome: 'Pedro', jid: JID, resumo_blocos: `[${s.casa}]`, avisos: '["lotacao","erro"]', ativo: 1 });

    const tudo = await api('/api/avisos');
    assert.equal(tudo.status, 200);
    assert.doesNotMatch(tudo.txt, VAZAMENTO, 'a resposta não traz o número completo nem o JID');
    assert.deepEqual(tudo.json.destinos, [{ id: r.json.id, nome: 'Pedro', numero: '+55 11 •••••-4321', resumo_blocos: [s.casa], avisos: ['lotacao', 'erro'], ativo: true, created_at: tudo.json.destinos[0].created_at }]);
    assert.deepEqual(tudo.json.config, { resumo_horario: '21:00', virada_dia: '00:00', limite_padrao: 1000 });
    assert.deepEqual(tudo.json.blocos, [{ id: s.beleza, nome: 'Beleza' }, { id: s.casa, nome: 'Casa' }]);
    const lista = await api('/api/avisos/destinos');
    assert.doesNotMatch(lista.txt, VAZAMENTO); assert.equal(lista.json[0].numero, '+55 11 •••••-4321');

    // validação: nada é gravado e a mensagem não repete o número
    const invalido = await api('/api/avisos/destinos', 'POST', { nome: 'X', numero: '123' });
    assert.equal(invalido.status, 400); assert.equal(invalido.json.erro, 'Número inválido. Use DDD e número, ex.: 35 99999-1234.');
    assert.equal((await api('/api/avisos/destinos', 'POST', { nome: '', numero: NUM2 })).json.erro, 'Dê um nome ao número.');
    assert.equal((await api('/api/avisos/destinos', 'POST', { nome: 'De novo', numero: '11987654321' })).json.erro, 'Este número já está cadastrado.');
    const resolver = s.wa.resolverNumero;
    s.wa.resolverNumero = async (d) => ({ jid: `${d}@s.whatsapp.net`, existe: false });
    const fora = await api('/api/avisos/destinos', 'POST', { nome: 'Fora', numero: NUM2 });
    assert.equal(fora.status, 400); assert.equal(fora.json.erro, 'Este número não está no WhatsApp.');
    s.wa.resolverNumero = async () => { throw new Error(`falhou ${JID2}`); };
    const caiu = await api('/api/avisos/destinos', 'POST', { nome: 'Caiu', numero: NUM2 });
    assert.equal(caiu.status, 400); assert.doesNotMatch(caiu.txt, VAZAMENTO);
    s.wa.resolverNumero = resolver;
    assert.equal((await api('/api/avisos/destinos', 'POST', { nome: 'Bloco sumido', numero: NUM2, resumo_blocos: [999] })).status, 400);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM aviso_destinos').get().n, 1);

    // edição: número vazio mantém o salvo; campo ausente fica como está; liga/desliga sozinho
    const id = r.json.id;
    assert.equal((await api(`/api/avisos/destinos/${id}`, 'PUT', { nome: 'Pedro celular', numero: '', resumo_blocos: [], avisos: ['erro'] })).status, 200);
    assert.equal((await api(`/api/avisos/destinos/${id}`, 'PUT', { ativo: false })).status, 200);
    assert.deepEqual({ ...s.db.prepare('SELECT nome, jid, resumo_blocos, avisos, ativo FROM aviso_destinos').get() },
      { nome: 'Pedro celular', jid: JID, resumo_blocos: '[]', avisos: '["erro"]', ativo: 0 });
    assert.equal((await api(`/api/avisos/destinos/${id}`, 'PUT', { numero: NUM2, resumo_blocos: null })).status, 200);
    assert.deepEqual({ ...s.db.prepare('SELECT jid, resumo_blocos FROM aviso_destinos').get() }, { jid: JID2, resumo_blocos: null });
    assert.equal((await api('/api/avisos/destinos/999', 'PUT', { nome: 'x' })).status, 400);
    assert.equal((await api(`/api/avisos/destinos/${id}`, 'DELETE')).status, 200);
    assert.equal((await api(`/api/avisos/destinos/${id}`, 'DELETE')).status, 400, 'já removido');
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM aviso_destinos').get().n, 0);
    semNumeroNoLog(s.db);
  } finally { await s.fechar(); }
});

test('máscara do número: só os 4 últimos dígitos', () => {
  assert.equal(mascararNumero(JID), '+55 11 •••••-4321');
  assert.equal(mascararNumero('551133334444@s.whatsapp.net'), '+55 11 ••••-4444');
  assert.equal(mascararNumero('14155550123@s.whatsapp.net'), '+•••••••-0123');
  assert.equal(mascararNumero(''), '•••');
});

// ---------- resumo agora e prévia ----------
test('resumo agora: chega ao JID do destino com os blocos marcados; todos os ativos; prévia; sem número ativo dá 400', async () => {
  const s = await subir();
  try {
    const api = await cliente(s);
    const vazio = await api('/api/avisos/resumo-agora', 'POST', {});
    assert.equal(vazio.status, 400); assert.equal(vazio.json.erro, 'Cadastre um número ativo para enviar o resumo.');

    // hoje: em Casa entraram 2 (um saiu no mesmo dia), 3 cliques e 1 leitura; em Beleza entrou 1
    const sod = startOfDay(Date.now());
    const ev = (ts, jid, quem, acao) => s.db.prepare('INSERT INTO group_events (ts, jid, participant, action, by_link) VALUES (?,?,?,?,1)').run(ts, jid, quem, acao);
    ev(sod + 1, 'g1@g.us', 'a', 'add'); ev(sod + 2, 'g1@g.us', 'b', 'add'); ev(sod + 3, 'g1@g.us', 'a', 'remove'); ev(sod + 4, 'g2@g.us', 'c', 'add');
    for (let i = 0; i < 3; i++) s.db.prepare('INSERT INTO link_clicks (ts, link_id, jid) VALUES (?,?,?)').run(sod + 5 + i, 1, 'g1@g.us');
    s.db.prepare('INSERT INTO group_reads (jid, participant, day, ts) VALUES (?,?,?,?)').run('g1@g.us', 'b', 'x', sod + 9);

    const ids = {};
    for (const [nome, numero, resumo_blocos, avisos] of [['Pedro', NUM, [s.casa], []], ['Ana', NUM2, [], []], ['Só avisos', NUM3, null, ['erro']]]) {
      const r = await api('/api/avisos/destinos', 'POST', { nome, numero, resumo_blocos, avisos });
      assert.equal(r.status, 200, r.txt); ids[nome] = r.json.id;
    }

    const um = await api('/api/avisos/resumo-agora', 'POST', { destino_id: ids.Pedro });
    assert.deepEqual(um.json, { enviados: 1, falhas: 0 });
    const msg = paraJid(s.wa, JID);
    assert.equal(msg.length, 1); assert.equal(msg[0].tipo, 'text');
    assert.match(msg[0].text, /^📊 \*Resumo de \d\d\/\d\d\* \(até \d\d:\d\d\)\n/);
    for (const linha of ['*Casa* · 1 grupo · 100 membros', '➕ Entraram: 2 · ➖ Saíram: 1', '🏃 Saíram no mesmo dia: 50%', '👀 Abriram: 1', '🔗 Cliques: 3']) {
      assert.ok(msg[0].text.includes(linha), `falta "${linha}" em:\n${msg[0].text}`);
    }
    assert.ok(!msg[0].text.includes('Beleza'), 'só os blocos marcados');

    const todos = await api('/api/avisos/resumo-agora', 'POST', {});
    assert.deepEqual(todos.json, { enviados: 2, falhas: 0 }, 'Pedro e Ana; "Só avisos" não recebe o resumo');
    assert.equal(paraJid(s.wa, JID).length, 2); assert.equal(paraJid(s.wa, JID3).length, 0);
    const ana = paraJid(s.wa, JID2)[0].text;
    assert.ok(ana.includes('*Todos os grupos* · 2 grupos · 150 membros'), ana);
    assert.ok(ana.includes('➕ Entraram: 3 · ➖ Saíram: 1'), ana);

    assert.match((await api('/api/avisos/resumo-agora', 'POST', { destino_id: ids['Só avisos'] })).json.erro, /não recebe o resumo/);
    await api(`/api/avisos/destinos/${ids.Ana}`, 'PUT', { ativo: false });
    assert.equal((await api('/api/avisos/resumo-agora', 'POST', { destino_id: ids.Ana })).status, 400, 'desligado');
    assert.equal((await api('/api/avisos/resumo-agora', 'POST', { destino_id: 999 })).status, 400);

    // prévia: o texto que cada um receberia
    const pPedro = await api(`/api/avisos/previa?destino=${ids.Pedro}`);
    assert.equal(pPedro.json.recebe, true); assert.ok(pPedro.json.texto.includes('*Casa*') && !pPedro.json.texto.includes('Beleza'));
    assert.deepEqual((await api(`/api/avisos/previa?destino=${ids['Só avisos']}`)).json, { texto: '', recebe: false });
    assert.ok((await api('/api/avisos/previa')).json.texto.includes('*Todos os grupos*'));
    assert.equal((await api('/api/avisos/previa?destino=abc')).status, 400);

    // WhatsApp fora: recusa sem enviar
    s.wa.isReady = () => false;
    assert.match((await api('/api/avisos/resumo-agora', 'POST', {})).json.erro, /Conecte o WhatsApp/);
    assert.match(s.db.prepare("SELECT message FROM log WHERE level = 'ok' ORDER BY id DESC LIMIT 1").get().message, /Enviei o resumo para “(Pedro|Ana)”/);
    semNumeroNoLog(s.db);
    assert.equal(acessosRede, 0);
  } finally { await s.fechar(); }
});

// ---------- resumo diário pelo tick ----------
test('resumo diário: 1× no horário; atrasado no mesmo dia; de novo no dia seguinte; espera o WhatsApp; respeita a virada', async () => {
  const { db, wa } = montar(); const avisos = createAvisos({ db, wa });
  destino(db, { blocos: [] });
  destino(db, { nome: 'Desligado', jid: JID2, blocos: [], ativo: 0 });
  destino(db, { nome: 'Sem resumo', jid: JID3, blocos: null, avisos: ['erro'] });
  const n = () => paraJid(wa, JID).length;

  await avisos.tick(at(2, 20, 59)); assert.equal(n(), 0, 'antes das 21:00');
  await avisos.tick(at(2, 21, 0)); assert.equal(n(), 1, 'às 21:00');
  await avisos.tick(at(2, 21, 30)); await avisos.tick(at(2, 23, 59)); assert.equal(n(), 1, 'dois ticks no mesmo dia: 1 envio');
  assert.match(paraJid(wa, JID)[0].text, /^📊 \*Resumo de 02\/11\* \(até 21:00\)/);
  assert.equal(getSetting(db, 'resumo_ultimo_dia'), '2026-11-02');

  await avisos.tick(at(3, 20, 0)); assert.equal(n(), 1);
  await avisos.tick(at(3, 22, 10)); assert.equal(n(), 2, 'serviço parado às 21:00: sai atrasado no mesmo dia');
  assert.match(paraJid(wa, JID)[1].text, /^📊 \*Resumo de 03\/11\* \(até 22:10\)/);

  wa.isReady = () => false;
  await avisos.tick(at(4, 21, 0)); assert.equal(n(), 2, 'WhatsApp fora: espera');
  assert.equal(getSetting(db, 'resumo_ultimo_dia'), '2026-11-03', 'o dia não é marcado sem enviar');
  wa.isReady = () => true;
  await avisos.tick(at(4, 21, 20)); assert.equal(n(), 3, 'WhatsApp de volta: sai');
  assert.equal(paraJid(wa, JID2).length + paraJid(wa, JID3).length, 0, 'desligado e "sem resumo" não recebem');

  // virada 02:00 e resumo à 01:00: o resumo do dia 05/11 sai à 01:00 de 06/11
  setSetting(db, 'virada_dia', '02:00'); setSetting(db, 'resumo_horario', '01:00');
  await avisos.tick(at(5, 23, 0)); assert.equal(n(), 3);
  await avisos.tick(at(6, 1, 0)); assert.equal(n(), 4);
  assert.match(paraJid(wa, JID)[3].text, /^📊 \*Resumo de 05\/11\* \(até 01:00\)/);
  await avisos.tick(at(6, 1, 59)); assert.equal(n(), 4, 'ainda o dia de negócio 05/11');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM log WHERE level = 'ok' AND message LIKE 'Enviei o resumo diário para “Pedro”%'").get().n, 4);
  semNumeroNoLog(db);
});

// ---------- aviso de erro ----------
test('aviso de erro: agregado, no máximo 1 a cada 30 min, só com o WhatsApp de pé; falha de entrega vira "aviso" sem número', async () => {
  const { db, wa } = montar(); const avisos = createAvisos({ db, wa });
  destino(db, { avisos: ['erro'] });
  destino(db, { nome: 'Só lotação', jid: JID2, avisos: ['lotacao'] });
  erroNoLog(db, at(2, 9, 0), 'erro antigo, de antes do aviso existir');
  await avisos.tick(at(2, 14, 0)); assert.equal(paraJid(wa, JID).length, 0, 'o primeiro tick só marca o cursor');

  erroNoLog(db, at(2, 14, 0), 'Falha ao enviar: WhatsApp desconectado');
  erroNoLog(db, at(2, 14, 1), 'Falha ao enviar: WhatsApp desconectado');
  erroNoLog(db, at(2, 14, 2), 'Não consegui gerar o link: extensão offline');
  await avisos.tick(at(2, 14, 3));
  let msgs = paraJid(wa, JID); assert.equal(msgs.length, 1);
  assert.match(msgs[0].text, /^⚠️ \*3 disparos falharam desde 14:00\*/);
  assert.ok(msgs[0].text.includes('• Falha ao enviar: WhatsApp desconectado (2×)'), msgs[0].text);
  assert.ok(msgs[0].text.includes('• Não consegui gerar o link: extensão offline'), msgs[0].text);
  assert.ok(!msgs[0].text.includes('erro antigo'));
  assert.equal(paraJid(wa, JID2).length, 0, 'quem não marcou "erro" não recebe');

  erroNoLog(db, at(2, 14, 5), 'Falha ao enviar: grupo não encontrado');
  await avisos.tick(at(2, 14, 10)); await avisos.tick(at(2, 14, 32));
  assert.equal(paraJid(wa, JID).length, 1, 'menos de 30 min desde o último aviso: acumula');
  await avisos.tick(at(2, 14, 34));
  msgs = paraJid(wa, JID); assert.equal(msgs.length, 2);
  assert.match(msgs[1].text, /^⚠️ \*1 disparo falhou desde 14:05\*\n• Falha ao enviar: grupo não encontrado\n/);

  // WhatsApp fora: acumula e manda quando volta, com no máximo 3 motivos
  for (const [i, m] of ['a', 'b', 'c', 'd', 'e'].entries()) erroNoLog(db, at(2, 15, i), `motivo ${m}`);
  wa.isReady = () => false; await avisos.tick(at(2, 15, 10)); assert.equal(paraJid(wa, JID).length, 2);
  wa.isReady = () => true; await avisos.tick(at(2, 15, 11));
  msgs = paraJid(wa, JID); assert.equal(msgs.length, 3);
  assert.match(msgs[2].text, /^⚠️ \*5 disparos falharam desde 15:00\*\n• motivo a\n• motivo b\n• motivo c\n• e mais 2 motivos\n/);

  // a entrega falha (erro com o número): vira 'aviso' com o nome, sem número, e não gera aviso de erro novo
  const erros = () => db.prepare("SELECT COUNT(*) AS n FROM log WHERE level = 'erro'").get().n;
  const antes = erros();
  wa.sendText = async (jid) => { throw new Error(`não entregue para ${jid} (+55 11 98765-4321)`); };
  erroNoLog(db, at(2, 16, 0), 'Falha ao enviar: tempo esgotado');
  await avisos.tick(at(2, 16, 1));
  const falha = db.prepare("SELECT message FROM log WHERE level = 'aviso' ORDER BY id DESC LIMIT 1").get().message;
  assert.match(falha, /^Não consegui enviar o aviso de erro para “Pedro”: não entregue para … \(…\)$/);
  assert.equal(erros(), antes + 1, 'só o erro inserido pelo teste: a falha do aviso não é "erro"');
  await avisos.tick(at(2, 17, 0)); assert.equal(erros(), antes + 1);
  semNumeroNoLog(db);
});

// ---------- grupo lotando ----------
test('lotação: avisa 1× por grupo de link ativo, cita a proposta pendente e só avisa de novo depois de esvaziar', async () => {
  const { db, wa } = montar(); const avisos = createAvisos({ db, wa });
  destino(db, { avisos: ['lotacao'] });
  destino(db, { nome: 'Só erro', jid: JID2, avisos: ['erro'] });
  db.prepare("INSERT INTO links (name, slug, group_jids, limit_members, enabled, created_at) VALUES ('Achadinhos', 'a', '[\"g1@g.us\",\"g2@g.us\"]', 100, 1, 1)").run();
  db.prepare("INSERT INTO links (name, slug, group_jids, limit_members, enabled, created_at) VALUES ('Pausado', 'p', '[\"g2@g.us\"]', 50, 0, 1)").run(); // Beleza cheio, mas o link está pausado
  db.prepare("INSERT INTO group_proposals (link_id, source_jid, name, status, created_at) VALUES (1, 'g1@g.us', 'Casa #2', 'pending', 1)").run();
  const tamanho = (n) => db.prepare("UPDATE groups SET size = ? WHERE jid = 'g1@g.us'").run(n);
  const n = () => paraJid(wa, JID).length;

  tamanho(94); await avisos.tick(at(2, 10, 0)); assert.equal(n(), 0, '94% ainda não');
  tamanho(96); await avisos.tick(at(2, 10, 1)); assert.equal(n(), 1);
  const texto = paraJid(wa, JID)[0].text;
  assert.match(texto, /^🚨 \*Grupo lotando\*\n• Casa: 96 de 100 membros \(link “Achadinhos”\)\. Há uma proposta para criar “Casa #2”/);
  assert.ok(!texto.includes('Beleza'));
  assert.equal(paraJid(wa, JID2).length, 0);

  await avisos.tick(at(2, 10, 2)); assert.equal(n(), 1, 'uma vez por grupo');
  tamanho(92); await avisos.tick(at(2, 10, 3)); tamanho(97); await avisos.tick(at(2, 10, 4));
  assert.equal(n(), 1, 'caiu um pouco e voltou: não repete');
  tamanho(80); await avisos.tick(at(2, 10, 5)); assert.deepEqual(JSON.parse(getSetting(db, 'avisos_lotacao')), [], 'esvaziou: pode avisar de novo');
  db.prepare("UPDATE group_proposals SET status = 'dismissed'").run();
  wa.isReady = () => false; tamanho(95); await avisos.tick(at(2, 10, 6)); assert.equal(n(), 1, 'WhatsApp fora: espera');
  wa.isReady = () => true; await avisos.tick(at(2, 10, 7)); assert.equal(n(), 2);
  assert.match(paraJid(wa, JID)[1].text, /Casa: 95 de 100 membros .*Crie o próximo grupo ou aumente o limite/);
  assert.match(db.prepare("SELECT message FROM log WHERE level = 'ok' ORDER BY id DESC LIMIT 1").get().message, /^Enviei o aviso de grupo lotando para “Pedro”\.$/);
  semNumeroNoLog(db);
});

// ---------- configurações: virada do dia e limite padrão ----------
test('configurações: validação; virada repassada a /api/overview, /api/blocks e /api/links; link novo usa o limite padrão', async () => {
  const s = await subir();
  try {
    const api = await cliente(s);
    for (const [corpo, re] of [[{ resumo_horario: '25:00' }, /Horário do resumo/], [{ virada_dia: 'meia-noite' }, /Virada do dia/],
      [{ limite_padrao: 2000 }, /de 2 a 1024/], [{ limite_padrao: 1 }, /de 2 a 1024/], [{ limite_padrao: 10.5 }, /de 2 a 1024/]]) {
      const r = await api('/api/avisos/config', 'PUT', corpo);
      assert.equal(r.status, 400, JSON.stringify(corpo)); assert.match(r.json.erro, re);
    }
    assert.equal((await api('/api/avisos/config', 'PUT', { resumo_horario: '20:30', limite_padrao: 2000 })).status, 400);
    assert.equal(getSetting(s.db, 'resumo_horario'), null, 'um campo inválido: nada é gravado');
    const ok = await api('/api/avisos/config', 'PUT', { resumo_horario: '20:30', virada_dia: '2:00', limite_padrao: '500' });
    assert.deepEqual(ok.json, { resumo_horario: '20:30', virada_dia: '02:00', limite_padrao: 500 });
    const st = (await api('/api/state')).json.ajustes;
    assert.deepEqual([st.limite_padrao, st.virada_dia], [500, '02:00']);

    // limite padrão: link novo sem limit_members usa 500 (reabre em 450); com limite explícito, o dele
    assert.equal((await api('/api/links', 'POST', { name: 'Fila', group_jids: ['g1@g.us'] })).status, 200);
    assert.equal((await api('/api/links', 'POST', { name: 'Outro', group_jids: ['g2@g.us'], limit_members: 300 })).status, 200);
    let links = (await api('/api/links')).json;
    assert.deepEqual(links.map((l) => [l.name, l.limit_members, l.reopen_below]), [['Fila', 500, 450], ['Outro', 300, 270]]);

    // virada 02:00: 30 min antes da virada de hoje é ontem; 1 min depois é hoje
    const sod = startOfDay(Date.now(), 120);
    const ev = (ts, quem) => s.db.prepare("INSERT INTO group_events (ts, jid, participant, action, by_link) VALUES (?, 'g1@g.us', ?, 'add', 1)").run(ts, quem);
    ev(sod - 30 * 60000, 'antes'); ev(sod + 60000, 'depois');
    for (const ts of [sod - 30 * 60000, sod + 60000]) s.db.prepare('INSERT INTO link_clicks (ts, link_id, jid) VALUES (?, 1, ?)').run(ts, 'g1@g.us');
    const hoje = (await api('/api/overview?periodo=hoje')).json;
    if (startOfDay(Date.now(), 120) === sod) { // (a não ser que o teste tenha cruzado as 02:00)
      assert.equal(hoje.periodo.de, sod);
      assert.deepEqual([hoje.entradas, hoje.anterior.entradas, hoje.cliques], [1, 1, 1]);
      assert.equal(hoje.serie[0].k, 2, 'série por hora a partir da virada');
      assert.equal((await api('/api/overview?periodo=ontem')).json.entradas, 1);
      assert.equal((await api('/api/blocks')).json.find((b) => b.id === s.casa).hoje.entradas, 1);
      links = (await api('/api/links')).json;
      assert.equal(links.find((l) => l.name === 'Fila').cliques_hoje, 1);
    }
    // de volta à meia-noite: o padrão antigo
    await api('/api/avisos/config', 'PUT', { virada_dia: '00:00' });
    assert.equal((await api('/api/overview?periodo=hoje')).json.periodo.de, startOfDay(Date.now()));
  } finally { await s.fechar(); }
});

// ---------- rodada 1 de correções (servidor): S13, S16, S17, S22 ----------
test('S16: no máximo 10 consultas de número ao WhatsApp por IP a cada 10 min; depois, 429 sem consultar', async () => {
  const s = await subir();
  try {
    const api = await cliente(s);
    let consultas = 0; const resolver = s.wa.resolverNumero;
    s.wa.resolverNumero = async (d) => { consultas++; return resolver(d); };
    for (let i = 0; i < 3; i++) assert.equal((await api('/api/avisos/destinos', 'POST', { nome: 'X', numero: '123' })).status, 400);
    assert.equal(consultas, 0, 'número inválido não chega ao WhatsApp nem conta');
    for (let i = 0; i < 10; i++) {
      const r = await api('/api/avisos/destinos', 'POST', { nome: `Pessoa ${i}`, numero: `11 9000${i}-0000` });
      assert.equal(r.status, 200, r.txt);
    }
    assert.equal(consultas, 10);
    const bloqueado = await api('/api/avisos/destinos', 'POST', { nome: 'Onze', numero: '11 90010-0000' });
    assert.equal(bloqueado.status, 429);
    assert.equal(bloqueado.json.erro, 'Muitas consultas de número em pouco tempo. Tente de novo em 10 min.');
    const id = s.db.prepare('SELECT id FROM aviso_destinos ORDER BY id LIMIT 1').get().id;
    assert.equal((await api(`/api/avisos/destinos/${id}`, 'PUT', { numero: '11 90011-0000' })).status, 429, 'trocar o número também consulta');
    assert.equal(consultas, 10, 'o freio vem antes da consulta');
    assert.equal((await api(`/api/avisos/destinos/${id}`, 'PUT', { nome: 'Renomeado', numero: '' })).status, 200, 'editar sem trocar o número não consulta');
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM aviso_destinos').get().n, 10);
    semNumeroNoLog(s.db);
  } finally { await s.fechar(); }
});

test('S17: nome do destino com 6 ou mais algarismos (um telefone) é recusado no cadastro e na edição', async () => {
  const s = await subir();
  try {
    const api = await cliente(s);
    let consultas = 0; const resolver = s.wa.resolverNumero;
    s.wa.resolverNumero = async (d) => { consultas++; return resolver(d); };
    for (const nome of ['Pedro 987654', NUM, 'Ana 1 2 3 4 5 6']) {
      const r = await api('/api/avisos/destinos', 'POST', { nome, numero: NUM });
      assert.equal(r.status, 400, nome);
      assert.equal(r.json.erro, 'Não ponha o número no nome (ele aparece no Histórico): use até 5 algarismos.');
    }
    assert.equal(consultas, 0, 'recusado antes de consultar o número');
    const ok = await api('/api/avisos/destinos', 'POST', { nome: 'Loja 12345', numero: NUM });
    assert.equal(ok.status, 200, '5 algarismos ainda valem');
    assert.equal((await api(`/api/avisos/destinos/${ok.json.id}`, 'PUT', { nome: 'Pedro 11987654321' })).status, 400);
    assert.equal((await api(`/api/avisos/destinos/${ok.json.id}`, 'PUT', { ativo: false })).status, 200, 'sem mexer no nome, nada a conferir');
    assert.equal(s.db.prepare('SELECT nome FROM aviso_destinos').get().nome, 'Loja 12345');
    semNumeroNoLog(s.db);
  } finally { await s.fechar(); }
});

test('S13: semNumero corta antes das regex (texto enorme em menos de 50 ms) e continua tirando número e JID', () => {
  for (const texto of ['a'.repeat(1e5), 'a'.repeat(1e6), '9'.repeat(1e6)]) {
    const t0 = performance.now(); const r = semNumero(texto); const ms = performance.now() - t0;
    assert.ok(ms < 50, `semNumero(${texto.length}): ${ms.toFixed(1)} ms`); assert.ok(r.length <= 160);
  }
  assert.equal(semNumero(new Error(`falhou para ${JID} e +55 11 98765-4321`)), 'falhou para … e …');
  // 16 JIDs (480 letras) e uma palavra com número que o corte em 500 partiria em 6 dígitos (a regex só pega 7+)
  const cortado = semNumero(`${'5511999998888@s.whatsapp.net '.repeat(16)}${'n'.repeat(14)}5511987654321 fim`);
  assert.doesNotMatch(cortado, /551198/, cortado);
});

test('S22: /api/simulados mostra o grupo e mascara o número de pessoa (destino de aviso)', async () => {
  const s = await subir();
  try {
    const api = await cliente(s);
    assert.equal((await api('/api/avisos/destinos', 'POST', { nome: 'Pedro', numero: NUM, resumo_blocos: [] })).status, 200);
    assert.deepEqual((await api('/api/avisos/resumo-agora', 'POST', {})).json, { enviados: 1, falhas: 0 });
    await s.wa.sendText('g1@g.us', 'oi, grupo');
    const sim = await api('/api/simulados');
    assert.equal(sim.status, 200);
    assert.doesNotMatch(sim.txt, VAZAMENTO);
    assert.deepEqual(sim.json.map((m) => m.jid), ['+55 11 •••••-4321', 'g1@g.us']);
    assert.equal(paraJid(s.wa, JID).length, 1, 'na memória do processo o registro guarda o JID (é por ele que se envia)');
  } finally { await s.fechar(); }
});

test('nada do que este arquivo fez imprimiu número ou JID de destino no console', () => {
  for (const linha of saidaConsole) assert.doesNotMatch(linha, VAZAMENTO, linha);
  assert.equal(acessosRede, 0);
});
