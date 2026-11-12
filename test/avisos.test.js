// Relatórios e avisos (plano disparos-comunicacao-conta, etapa 11): destinos com número canônico e listagem mascarada,
// "Enviar resumo agora", resumo diário 1× por dia de negócio, aviso de erro agregado (no máximo 1 a cada 30 min),
// lotação com dedupe, virada do dia e limite padrão. Servidor em porta aleatória e WhatsApp simulado: nenhum teste
// acessa a rede. O número dos destinos é dado pessoal: nenhum teste aceita vê-lo no log nem no console.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { openDb, getSetting, setSetting } from '../src/db.js';
import { buildApp } from '../src/server.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createLinkService } from '../src/links.js';
import { createScheduler } from '../src/scheduler.js';
import { createAvisos, mascararNumero, semNumero, montarRotas as montarRotasAvisos, TEXTO_TESTE, MANUAL_INTERVALO_S, MANUAL_MAX_HORA } from '../src/avisos.js';
import { startOfDay } from '../src/analytics.js';
import { linhaDeSaude } from '../src/vigia.js';

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
/** Nenhum número nem JID de destino na tabela log. O `ts` (Date.now()) fica de fora: 1794452991234 contém "91234". */
function semNumeroNoLog(db) {
  for (const { ts, ...l } of db.prepare('SELECT * FROM log').all()) assert.doesNotMatch(Object.values(l).join(' | '), VAZAMENTO, 'número no log');
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

    const relogio = relogioManual(s); // freio das mensagens manuais (S1) com o relógio do teste
    const um = await api('/api/avisos/resumo-agora', 'POST', { destino_id: ids.Pedro });
    assert.deepEqual(um.json, { enviados: 1, falhas: 0 });
    const msg = paraJid(s.wa, JID);
    assert.equal(msg.length, 1); assert.equal(msg[0].tipo, 'text');
    assert.match(msg[0].text, /^📊 \*Resumo de \d\d\/\d\d\* \(até \d\d:\d\d\)\n/);
    for (const linha of ['*Casa* · 1 grupo · 100 membros', '➕ Entraram: 2 · ➖ Saíram: 1', '🏃 Saíram no mesmo dia: 50%', '👀 Abriram: 1', '🔗 Cliques: 3']) {
      assert.ok(msg[0].text.includes(linha), `falta "${linha}" em:\n${msg[0].text}`);
    }
    assert.ok(!msg[0].text.includes('Beleza'), 'só os blocos marcados');

    const cedo = await api('/api/avisos/resumo-agora', 'POST', {});
    assert.equal(cedo.status, 429, 'Pedro recebeu há menos de 60 s: nada sai'); assert.equal(paraJid(s.wa, JID2).length, 0);
    relogio.agora += MANUAL_INTERVALO_S * 1000;
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

// ---------- backup (plano backup-automatico, etapa 2) ----------
const H = 3600000;
const AGORA = at(10, 12, 0);
/** Estado como o scripts/backup.js grava (versão 1); `extra` troca qualquer campo. */
const estadoDoBackup = (tentativa, extra = {}) => ({
  versao: 1, tentativa_em: tentativa,
  local: { ok: true, em: tentativa, arquivo: 'disparador-2026-11-10-03-00-00.tar.gz', motivo: null },
  drive: { ok: true, em: tentativa, copias: 3, motivo: null },
  ultimo_ok_local: tentativa, ultimo_ok_drive: tentativa, ...extra,
});
/**
 * Monta o aviso lendo um backup-estado.json de verdade, numa pasta própria. `inicio` = 2 h antes de AGORA (fora da carência).
 * Relógio monotônico falso: anda junto com o `now` de cada tick (o PC ficou acordado entre um tick e outro, mesmo com
 * horas entre eles), menos o que `dormir(ms)` descontar (suspensão).
 */
function montarBackup({ inicio = AGORA - 2 * H, destinos = true } = {}) {
  const m = montar();
  const arquivo = path.join(m.dir, 'backup-estado.json');
  let acordado = 0; let dormiu = 0;
  const avisos = createAvisos({ db: m.db, wa: m.wa, estadoBackup: arquivo, inicio, monotonico: () => acordado });
  const tickReal = avisos.tick;
  avisos.tick = (now) => { acordado = now - dormiu; return tickReal(now); };
  if (destinos) destino(m.db, { avisos: ['erro'] });
  return {
    ...m, avisos, arquivo,
    dormir: (ms) => { dormiu += ms; },
    gravar: (o) => fs.writeFileSync(arquivo, typeof o === 'string' ? o : JSON.stringify(o)),
    msgs: () => paraJid(m.wa, JID),
    linhas: () => m.db.prepare("SELECT level, rule_name, message FROM log WHERE rule_name = 'Backup' ORDER BY id").all().map((l) => ({ ...l })),
  };
}
const velho = (h) => AGORA - h * H;

test('backup: sem arquivo, ou sem estadoBackup, nada acontece', async () => {
  const b = montarBackup();
  await b.avisos.tick(AGORA);
  assert.equal(b.msgs().length, 0); assert.deepEqual(b.linhas(), []);
  assert.equal(getSetting(b.db, 'backup_visto'), null); assert.equal(getSetting(b.db, 'avisos_backup_ultimo'), null);
  // sem caminho (agendador sem dir), mesmo havendo um arquivo velho na pasta
  b.gravar(estadoDoBackup(velho(100), { ultimo_ok_local: velho(100), ultimo_ok_drive: velho(100) }));
  const sem = createAvisos({ db: b.db, wa: b.wa, inicio: velho(10) });
  await sem.tick(AGORA);
  assert.equal(b.msgs().length, 0); assert.deepEqual(b.linhas(), []);
});

test('backup fresco: cada execução nova vira uma linha "ok" no Histórico, sem repetir, e ninguém é avisado', async () => {
  const b = montarBackup();
  b.gravar(estadoDoBackup(velho(3)));
  await b.avisos.tick(AGORA); await b.avisos.tick(AGORA + 60000);
  assert.deepEqual(b.linhas(), [{ level: 'ok', rule_name: 'Backup', message: 'Backup automático: cópia no computador ok; cópia no Google Drive ok (3 cópias guardadas).' }]);
  assert.equal(b.msgs().length, 0, 'em dia: sem aviso');
  assert.equal(getSetting(b.db, 'avisos_backup_ultimo'), null);

  b.gravar(estadoDoBackup(velho(2)));
  await b.avisos.tick(AGORA); await b.avisos.tick(AGORA);
  assert.equal(b.linhas().length, 2, 'execução nova: mais uma linha, uma só');
  // exatamente 26 h ainda não é atraso
  b.gravar(estadoDoBackup(velho(26), { tentativa_em: velho(2), ultimo_ok_local: velho(26), ultimo_ok_drive: velho(26) }));
  await b.avisos.tick(AGORA);
  assert.equal(b.msgs().length, 0, 'até 26 h: em dia');
});

test('backup: execução com falha vira "aviso" (nunca "erro"), com a frase fixa da etapa, e não dispara o aviso de erro de disparo', async () => {
  const b = montarBackup();
  await b.avisos.tick(AGORA - 3 * H); // primeiro tick do aviso de erro: marca o cursor
  b.gravar(estadoDoBackup(velho(1), {
    local: { ok: true, em: velho(1), arquivo: 'x.tar.gz', motivo: null },
    drive: { ok: false, em: null, copias: null, motivo: 'envio' },
    ultimo_ok_drive: velho(5),
  }));
  await b.avisos.tick(AGORA);
  b.gravar(estadoDoBackup(velho(0.5), {
    local: { ok: false, em: null, arquivo: null, motivo: 'banco' },
    drive: { ok: null, em: null, copias: null, motivo: null },
    ultimo_ok_local: velho(6), ultimo_ok_drive: velho(6),
  }));
  await b.avisos.tick(AGORA);
  b.gravar(estadoDoBackup(velho(0.2), { drive: { ok: true, em: velho(0.2), copias: 14, motivo: 'limpeza_drive' } }));
  await b.avisos.tick(AGORA);
  assert.deepEqual(b.linhas().map((l) => [l.level, l.message]), [
    ['aviso', 'Backup automático: cópia no computador ok; cópia no Google Drive falhou (o envio ao Google Drive falhou).'],
    ['aviso', 'Backup automático: cópia no computador falhou (não consegui copiar o banco); cópia no Google Drive não foi tentada.'],
    ['aviso', 'Backup automático: cópia no computador ok; cópia no Google Drive ok (14 cópias guardadas); atenção: não consegui apagar as cópias antigas do Drive.'],
  ]);
  assert.equal(b.db.prepare("SELECT COUNT(*) AS n FROM log WHERE level = 'erro'").get().n, 0);
  assert.equal(b.msgs().length, 0, 'nenhuma mensagem "disparos falharam"');
});

test('backup atrasado há 27 h: avisa os destinos com "Erro de disparo", só eles, e deixa uma linha no Histórico', async () => {
  const b = montarBackup();
  destino(b.db, { nome: 'Só lotação', jid: JID2, avisos: ['lotacao'] });
  destino(b.db, { nome: 'Desligado', jid: JID3, avisos: ['erro'], ativo: 0 });
  b.gravar(estadoDoBackup(velho(1), {
    local: { ok: true, em: velho(1), arquivo: 'disparador-2026-11-10-03-00-00.tar.gz', motivo: null },
    drive: { ok: false, em: null, copias: null, motivo: 'envio' },
    ultimo_ok_drive: velho(27),
  }));
  await b.avisos.tick(AGORA);
  assert.equal(b.msgs().length, 1);
  assert.equal(b.msgs()[0].text, '⚠️ *O backup está atrasado*\n• Cópia no computador: há 1 h\n• Cópia no Google Drive: há 27 h\n\nVeja o Histórico no painel e confira o backup automático (capítulo Manutenção dos Docs).');
  assert.equal(paraJid(b.wa, JID2).length, 0); assert.equal(paraJid(b.wa, JID3).length, 0);
  const atraso = b.linhas().filter((l) => /^Backup atrasado/.test(l.message));
  assert.deepEqual(atraso, [{ level: 'aviso', rule_name: 'Backup', message: 'Backup atrasado. Cópia no computador: há 1 h; Cópia no Google Drive: há 27 h.' }]);
  assert.equal(Number(getSetting(b.db, 'avisos_backup_ultimo')), AGORA);
  assert.doesNotMatch(b.msgs()[0].text, /\/|\\|\.tar|gpg|rclone|chave/i, 'sem caminho, arquivo nem ferramenta');
  assert.ok(b.db.prepare("SELECT 1 FROM log WHERE level = 'ok' AND message LIKE 'Enviei o aviso de backup atrasado para “Pedro”.'").get());
  assert.equal(b.db.prepare("SELECT COUNT(*) AS n FROM log WHERE level = 'erro'").get().n, 0);
  semNumeroNoLog(b.db);
});

test('backup atrasado: o lado local sozinho basta, e "nunca deu certo" também conta', async () => {
  const a = montarBackup();
  a.gravar(estadoDoBackup(velho(1), { ultimo_ok_local: velho(30) }));
  await a.avisos.tick(AGORA);
  assert.match(a.msgs()[0].text, /Cópia no computador: há 30 h\n• Cópia no Google Drive: há 1 h/);

  const c = montarBackup();
  c.gravar(estadoDoBackup(velho(1), { ultimo_ok_drive: null, drive: { ok: false, em: null, copias: null, motivo: 'envio' } }));
  await c.avisos.tick(AGORA);
  assert.match(c.msgs()[0].text, /Cópia no Google Drive: nunca deu certo/);
  assert.ok(c.linhas().some((l) => l.message === 'Backup atrasado. Cópia no computador: há 1 h; Cópia no Google Drive: nunca deu certo.'));
});

test('backup atrasado: não repete em 23 h, repete em 25 h (a cada 24 h)', async () => {
  const b = montarBackup();
  b.gravar(estadoDoBackup(velho(1), { ultimo_ok_local: velho(40), ultimo_ok_drive: velho(40) }));
  await b.avisos.tick(AGORA); assert.equal(b.msgs().length, 1);
  await b.avisos.tick(AGORA + 5 * 60000); assert.equal(b.msgs().length, 1, 'cinco minutos depois: não');
  await b.avisos.tick(AGORA + 23 * H); assert.equal(b.msgs().length, 1, '23 h depois: não');
  await b.avisos.tick(AGORA + 25 * H); assert.equal(b.msgs().length, 2, '25 h depois: sim');
  assert.equal(Number(getSetting(b.db, 'avisos_backup_ultimo')), AGORA + 25 * H);
  assert.match(b.msgs()[1].text, /Cópia no computador: há 65 h/);
  // voltou ao normal: nada mais
  b.gravar(estadoDoBackup(AGORA + 26 * H, { tentativa_em: AGORA + 26 * H }));
  await b.avisos.tick(AGORA + 50 * H); assert.equal(b.msgs().length, 2);
});

test('backup atrasado: nunca na primeira hora depois de o programa ligar (carência de 60 min)', async () => {
  const inicio = AGORA - 30 * 60000;
  const b = montarBackup({ inicio });
  b.gravar(estadoDoBackup(velho(1), { ultimo_ok_local: velho(40), ultimo_ok_drive: velho(40) }));
  await b.avisos.tick(inicio); await b.avisos.tick(inicio + 59 * 60000 + 59000);
  assert.equal(b.msgs().length, 0, 'dentro da hora de carência');
  assert.equal(getSetting(b.db, 'avisos_backup_ultimo'), null, 'a carência não gasta o intervalo de 24 h');
  assert.equal(b.linhas().length, 1, 'a linha da execução já vai para o Histórico: só o aviso espera');
  assert.match(b.linhas()[0].message, /^Backup automático:/);
  await b.avisos.tick(inicio + 60 * 60000); assert.equal(b.msgs().length, 1, 'passada a hora: avisa');
});

const MIN = 60000;
/** Ticks de `passo` em `passo` de `de` (exclusive) até antes de `ate`. */
async function ticksAte(avisos, de, ate, passo = 5 * MIN) { for (let t = de + passo; t < ate; t += passo) await avisos.tick(t); }

test('backup atrasado: o PC que volta da suspensão ganha nova carência de 60 min (R1: o timer Persistent roda logo ao acordar)', async () => {
  const b = montarBackup();
  b.gravar(estadoDoBackup(velho(1))); // em dia quando o PC dormiu
  await b.avisos.tick(AGORA);
  assert.equal(b.msgs().length, 0);
  // 3 dias suspenso: entre os dois ticks o PC ficou acordado só 15 s; o estado agora tem 73 h
  const VOLTA = AGORA + 72 * H;
  b.dormir(72 * H - 15000);
  await b.avisos.tick(VOLTA);
  assert.equal(b.msgs().length, 0, 'acabou de acordar: espera o backup do timer');
  await ticksAte(b.avisos, VOLTA, VOLTA + 60 * MIN);
  assert.equal(b.msgs().length, 0, 'nenhum aviso antes de 60 min acordado');
  assert.equal(getSetting(b.db, 'avisos_backup_ultimo'), null, 'a carência não gasta o intervalo de 24 h');
  await b.avisos.tick(VOLTA + 60 * MIN);
  assert.equal(b.msgs().length, 1, '60 min depois de acordar e o backup não rodou: avisa');
  assert.match(b.msgs()[0].text, /Cópia no computador: há 74 h/);

  // o timer roda logo depois de acordar: ninguém é avisado
  const c = montarBackup();
  c.gravar(estadoDoBackup(velho(1)));
  await c.avisos.tick(AGORA);
  c.dormir(72 * H - 15000);
  await c.avisos.tick(VOLTA);
  c.gravar(estadoDoBackup(VOLTA + 3 * MIN));
  await ticksAte(c.avisos, VOLTA, VOLTA + 2 * H);
  assert.equal(c.msgs().length, 0);
  assert.deepEqual(c.linhas().map((l) => l.level), ['ok', 'ok'], 'só as duas execuções no Histórico');
});

test('backup atrasado: um tick demorado (regra disparando por 20 min) não é suspensão e não recomeça a carência', async () => {
  const b = montarBackup({ inicio: AGORA - 50 * MIN });
  b.gravar(estadoDoBackup(velho(1), { ultimo_ok_local: velho(40), ultimo_ok_drive: velho(40) }));
  await b.avisos.tick(AGORA);
  assert.equal(b.msgs().length, 0, 'ligou há 50 min: carência');
  await b.avisos.tick(AGORA + 20 * MIN); // o PC ficou acordado os 20 min (o relógio monotônico andou junto)
  assert.equal(b.msgs().length, 1, '70 min ligado: avisa');
});

test('backup atrasado: com o relógio padrão (performance.now), dois ticks com 3 dias de diferença contam como suspensão', async () => {
  const m = montar();
  destino(m.db, { avisos: ['erro'] });
  const arquivo = path.join(m.dir, 'backup-estado.json');
  fs.writeFileSync(arquivo, JSON.stringify(estadoDoBackup(velho(1))));
  const avisos = createAvisos({ db: m.db, wa: m.wa, estadoBackup: arquivo, inicio: AGORA - 2 * H });
  await avisos.tick(AGORA);
  const VOLTA = AGORA + 72 * H;
  await avisos.tick(VOLTA); // o relógio do teste pulou 3 dias; o monotônico real, alguns milissegundos
  // passos de 4 min (abaixo dos 5 min de salto): o relógio real quase não anda, mas cada passo não é suspensão
  await ticksAte(avisos, VOLTA, VOLTA + 60 * MIN, 4 * MIN);
  assert.equal(paraJid(m.wa, JID).length, 0, 'antes de 60 min: nada');
  await avisos.tick(VOLTA + 60 * MIN);
  assert.equal(paraJid(m.wa, JID).length, 1);
});

test('backup: estado ilegível (JSON quebrado, lixo, arquivo grande demais) conta como atrasado, com o texto fixo', async () => {
  for (const conteudo of ['{"versao":1,"tentativa_em":', '[1,2]', 'null', '', JSON.stringify({ x: 'a'.repeat(70000) })]) {
    const b = montarBackup();
    b.gravar(conteudo);
    await b.avisos.tick(AGORA);
    assert.equal(b.msgs().length, 1, `conteúdo ${conteudo.slice(0, 20)}`);
    assert.equal(b.msgs()[0].text, '⚠️ *O backup está atrasado*\nNão consegui ler o estado do backup.\n\nVeja o Histórico no painel e confira o backup automático (capítulo Manutenção dos Docs).');
    assert.deepEqual(b.linhas(), [{ level: 'aviso', rule_name: 'Backup', message: 'Backup atrasado. Não consegui ler o estado do backup.' }]);
    await b.avisos.tick(AGORA + 23 * H); assert.equal(b.msgs().length, 1, 'repete no máximo a cada 24 h');
  }
  // o caminho do estado ser uma pasta também é "ilegível", não um erro do tick
  const d = montarBackup();
  fs.mkdirSync(d.arquivo);
  await d.avisos.tick(AGORA);
  assert.match(d.msgs()[0].text, /Não consegui ler o estado do backup/);
});

test('backup atrasado: um sendText lento (20 min) antes do passo do backup não é suspensão e não reinicia a carência (R7)', async () => {
  const m = montar();
  destino(m.db, { blocos: [], avisos: ['erro'] }); // recebe o resumo diário e o aviso de backup
  setSetting(m.db, 'resumo_horario', '11:00'); // o resumo de hoje já venceu: sai no 1º tick, antes do passo do backup
  const arquivo = path.join(m.dir, 'backup-estado.json');
  // em dia (25 h 50 min) no 1º tick; passa das 26 h no 2º, 21 min depois
  const ok = AGORA - 26 * H + 10 * MIN;
  fs.writeFileSync(arquivo, JSON.stringify(estadoDoBackup(ok, { ultimo_ok_local: ok, ultimo_ok_drive: ok })));
  let mono = 0;
  const avisos = createAvisos({ db: m.db, wa: m.wa, estadoBackup: arquivo, inicio: AGORA - 2 * H, monotonico: () => mono });
  const enviar = m.wa.sendText;
  m.wa.sendText = async (jid, texto) => { if (texto.startsWith('📊')) mono += 20 * MIN; return enviar(jid, texto); }; // o PC segue acordado durante o envio
  mono = AGORA; await avisos.tick(AGORA);
  assert.equal(paraJid(m.wa, JID).length, 1, 'só o resumo (backup ainda em dia)');
  assert.match(paraJid(m.wa, JID)[0].text, /^📊/);
  mono = AGORA + 21 * MIN; await avisos.tick(AGORA + 21 * MIN);
  const msgs = paraJid(m.wa, JID);
  assert.equal(msgs.length, 2, 'fora da carência: o aviso de backup atrasado sai');
  assert.match(msgs[1].text, /O backup está atrasado/);
});

/** Estado do backup que NÃO é arquivo comum: o tick não trava e conta como ilegível. */
async function estadoIlegivelSemTravar(montarEstado) {
  const b = montarBackup();
  montarEstado(b.arquivo);
  const antes = Date.now();
  await b.avisos.tick(AGORA);
  assert.ok(Date.now() - antes < 2000, 'o tick não pode esperar o arquivo');
  assert.equal(b.msgs().length, 1);
  assert.match(b.msgs()[0].text, /Não consegui ler o estado do backup/);
  assert.deepEqual(b.linhas(), [{ level: 'aviso', rule_name: 'Backup', message: 'Backup atrasado. Não consegui ler o estado do backup.' }]);
}

test('backup: estado que é um FIFO conta como ilegível e não trava o tick (S: leitura bloqueante)', async (t) => {
  try { execFileSync('mkfifo', ['--version'], { stdio: 'ignore' }); } catch (e) { if (e.code === 'ENOENT') return t.skip('mkfifo não existe aqui'); }
  await estadoIlegivelSemTravar((arq) => execFileSync('mkfifo', [arq]));
});

test('backup: estado que é link simbólico (para /dev/zero ou para um JSON válido) conta como ilegível', async () => {
  await estadoIlegivelSemTravar((arq) => fs.symlinkSync('/dev/zero', arq));
  const alvo = path.join(tmp(), 'estado-real.json');
  const hoje = estadoDoBackup(AGORA - H);
  fs.writeFileSync(alvo, JSON.stringify(hoje));
  await estadoIlegivelSemTravar((arq) => fs.symlinkSync(alvo, arq));
  await estadoIlegivelSemTravar((arq) => fs.symlinkSync(path.join(path.dirname(arq), 'nao-existe.json'), arq)); // link quebrado
});

test('backup atrasado sem destinos: só o Histórico, 1× a cada 24 h; destino sem "Erro de disparo" ou desligado não conta', async () => {
  const b = montarBackup({ destinos: false });
  destino(b.db, { avisos: ['lotacao'] });
  destino(b.db, { nome: 'Desligado', jid: JID2, avisos: ['erro'], ativo: 0 });
  b.gravar(estadoDoBackup(velho(1), { ultimo_ok_local: velho(40), ultimo_ok_drive: velho(40) }));
  b.wa.isReady = () => false; // sem destinos o WhatsApp fora não pode segurar o registro
  await b.avisos.tick(AGORA);
  assert.equal(b.wa.simulated.length, 0);
  assert.deepEqual(b.linhas().filter((l) => /^Backup atrasado/.test(l.message)).map((l) => [l.level, l.message]),
    [['aviso', 'Backup atrasado. Cópia no computador: há 40 h; Cópia no Google Drive: há 40 h. Nenhum número recebe o aviso de erro de disparo.']]);
  await b.avisos.tick(AGORA + 10 * 60000);
  assert.equal(b.linhas().filter((l) => /^Backup atrasado/.test(l.message)).length, 1, 'não repete a linha a cada tick');
});

test('backup atrasado com o WhatsApp fora: espera, não gasta o intervalo e avisa quando volta', async () => {
  const b = montarBackup();
  b.gravar(estadoDoBackup(velho(1), { ultimo_ok_local: velho(40), ultimo_ok_drive: velho(40) }));
  b.wa.isReady = () => false;
  await b.avisos.tick(AGORA); await b.avisos.tick(AGORA + 5 * 60000);
  assert.equal(b.msgs().length, 0);
  assert.equal(getSetting(b.db, 'avisos_backup_ultimo'), null);
  assert.equal(b.linhas().filter((l) => /^Backup atrasado/.test(l.message)).length, 0, 'ainda não aconteceu: nada no Histórico');
  b.wa.isReady = () => true;
  await b.avisos.tick(AGORA + 10 * 60000);
  assert.equal(b.msgs().length, 1);
});

test('backup: o texto do arquivo nunca vai ao Histórico nem ao WhatsApp (caminho, número, motivo desconhecido)', async () => {
  const b = montarBackup();
  b.gravar(estadoDoBackup(velho(1), {
    local: { ok: false, em: null, arquivo: '/home/ufla/data/backups/x.tar.gz', motivo: '/home/ufla/.config/achadinhoturbo/backup.chave' },
    drive: { ok: false, em: null, copias: '+55 11 98765-4321', motivo: 'rclone: token 5511987654321@s.whatsapp.net' },
    ultimo_ok_local: velho(40), ultimo_ok_drive: velho(40),
  }));
  await b.avisos.tick(AGORA);
  const tudo = [...b.linhas().map((l) => l.message), ...b.msgs().map((m) => m.text)].join('\n');
  assert.doesNotMatch(tudo, /home|backup\.chave|\.tar|rclone|token|98765|5511987/);
  assert.match(b.linhas()[0].message, /^Backup automático: cópia no computador falhou; cópia no Google Drive falhou\.$/);
});

test('backup: o agendador passa data/backup-estado.json aos avisos (o nome do arquivo bate nos dois lados)', async () => {
  const { dir, db, wa, scheduler } = montar();
  destino(db, { avisos: ['erro'] });
  const agora = Date.now() + 3 * H; // o programa "ligou" há menos de 1 h: fora da carência só assim
  fs.writeFileSync(path.join(dir, 'backup-estado.json'), JSON.stringify(estadoDoBackup(agora - H, { ultimo_ok_local: agora - 30 * H, ultimo_ok_drive: agora - 30 * H })));
  await scheduler.avisos.tick(agora);
  assert.equal(paraJid(wa, JID).length, 1);
  assert.match(paraJid(wa, JID)[0].text, /Cópia no computador: há 30 h/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM log WHERE rule_name = 'Backup'").get().n, 2);
});

test('backup: motivo que é nome de propriedade herdada ("constructor", "toString") não vira texto de função no Histórico', async () => {
  for (const motivo of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const b = montarBackup();
    b.gravar(estadoDoBackup(velho(1), {
      local: { ok: false, em: null, arquivo: null, motivo },
      drive: { ok: false, em: null, copias: null, motivo },
    }));
    await b.avisos.tick(AGORA);
    assert.equal(b.linhas()[0].message, 'Backup automático: cópia no computador falhou; cópia no Google Drive falhou.', motivo);
  }
});

test('backup: estado com formato torto (local/drive que não são objetos, datas em texto) não derruba o tick nem grava lixo', async () => {
  const tortos = [
    { versao: 1, tentativa_em: 5, local: 'x', drive: 7 },
    { versao: 1, tentativa_em: 5, local: null, drive: [] },
    { versao: 1, tentativa_em: '5', ultimo_ok_local: '5', ultimo_ok_drive: { a: 1 } },
    { versao: 1, tentativa_em: -1, local: { ok: 'true' }, drive: { ok: 1, copias: -3 } },
    { versao: 1, tentativa_em: 5, local: { ok: true, motivo: { x: 1 } }, drive: { ok: true, copias: 1e9 } },
    {},
  ];
  for (const e of tortos) {
    const b = montarBackup();
    b.gravar(e);
    await b.avisos.tick(AGORA); // não pode lançar
    for (const l of b.linhas()) {
      assert.match(l.message, /^(Backup automático: cópia no computador (ok|falhou); cópia no Google Drive (ok|falhou|não foi tentada)|Backup atrasado\. )/, JSON.stringify(e));
      assert.doesNotMatch(l.message, /object|undefined|NaN|null/i, JSON.stringify(e));
    }
    for (const m of b.msgs()) assert.doesNotMatch(m.text, /object|undefined|NaN|null/i, JSON.stringify(e));
    assert.ok(b.linhas().every((l) => l.level !== 'erro'));
  }
});

test('backup atrasado: se a entrega do aviso falha, vira "aviso" no Histórico (nunca "erro") e não gera "disparos falharam"', async () => {
  const b = montarBackup();
  await b.avisos.tick(AGORA - 3 * H); // marca o cursor do aviso de erro
  b.gravar(estadoDoBackup(velho(1), { ultimo_ok_local: velho(40), ultimo_ok_drive: velho(40) }));
  const antes = b.wa.sendText;
  b.wa.sendText = async () => { throw new Error('rede fora'); };
  await b.avisos.tick(AGORA);
  b.wa.sendText = antes;
  await b.avisos.tick(AGORA + 31 * 60000);
  assert.equal(b.db.prepare("SELECT COUNT(*) AS n FROM log WHERE level = 'erro'").get().n, 0);
  assert.equal(b.msgs().length, 0, 'a falha de entrega não gerou "disparos falharam" para ninguém');
  assert.ok(b.db.prepare("SELECT 1 FROM log WHERE level = 'aviso' AND message LIKE 'Não consegui enviar o aviso de backup atrasado%'").get());
});

// ---------- "Enviar teste" (só o Dono; freio: 1 por número a cada 60 s e 5 por hora no total) ----------
const linhasDoLog = (db) => db.prepare('SELECT rule_name, level, message FROM log ORDER BY id').all().map((l) => ({ ...l }));
const testar = (api, id) => api(`/api/avisos/destinos/${id}/teste`, 'POST');

test('enviar teste: 1 mensagem com o texto fixo ao JID do destino; desligado ou sem "Erro de disparo" também recebe e a resposta diz; Histórico com o nome', async () => {
  const s = await subir();
  try {
    const api = await cliente(s);
    const pedro = destino(s.db, { avisos: ['erro', 'lotacao'] });
    const ana = destino(s.db, { nome: 'Ana', jid: JID2, avisos: ['lotacao'], ativo: 0 });
    const bia = destino(s.db, { nome: 'Bia', jid: JID3, avisos: ['erro'], ativo: 0 });

    const r = await testar(api, pedro);
    assert.equal(r.status, 200, r.txt);
    assert.deepEqual(r.json, { enviado: true, ativo: true, recebe_erro: true });
    assert.deepEqual(s.wa.simulated, [{ tipo: 'text', jid: JID, text: TEXTO_TESTE }], 'uma mensagem só, ao JID do destino');
    assert.doesNotMatch(r.txt, VAZAMENTO, 'a resposta não traz o número');

    const desligada = await testar(api, ana);
    assert.equal(desligada.status, 200, desligada.txt);
    assert.deepEqual(desligada.json, { enviado: true, ativo: false, recebe_erro: false }, 'desligado e sem "Erro de disparo": recebe e a resposta diz');
    assert.deepEqual(paraJid(s.wa, JID2).map((m) => m.text), [TEXTO_TESTE]);
    assert.deepEqual((await testar(api, bia)).json, { enviado: true, ativo: false, recebe_erro: true });
    assert.equal(s.wa.simulated.length, 3);

    // o texto é fixo, marcado como teste, e não leva número, caminho nem segredo
    assert.equal(TEXTO_TESTE, '🔔 *Teste* do aviso de erro do Achadinho Turbo.\nSe esta mensagem chegou, o WhatsApp consegue entregar os avisos a este número.\nNada falhou de verdade.');
    assert.match(TEXTO_TESTE, /Nada falhou de verdade\.$/);
    assert.doesNotMatch(TEXTO_TESTE, /\d|\/|@|token|senha/i);

    // Histórico: uma linha por teste, origem Avisos, nível ok, só o nome
    assert.deepEqual(linhasDoLog(s.db), [
      { rule_name: 'Avisos', level: 'ok', message: 'Enviei o teste do aviso de erro para “Pedro”.' },
      { rule_name: 'Avisos', level: 'ok', message: 'Enviei o teste do aviso de erro para “Ana”.' },
      { rule_name: 'Avisos', level: 'ok', message: 'Enviei o teste do aviso de erro para “Bia”.' },
    ]);

    // destino que não existe (ou id torto): "Número não encontrado.", sem envio nem linha no Histórico
    s.db.prepare('DELETE FROM aviso_destinos WHERE id = ?').run(bia);
    for (const id of [bia, 999, 0, 'abc', '1.5']) {
      const x = await testar(api, id);
      assert.equal(x.status, 400, String(id)); assert.equal(x.json.erro, 'Número não encontrado.', String(id));
    }
    assert.equal(s.wa.simulated.length, 3); assert.equal(linhasDoLog(s.db).length, 3);
    semNumeroNoLog(s.db);
    assert.equal(acessosRede, 0);
  } finally { await s.fechar(); }
});

test('enviar teste: só o Dono (Operador recebe 403, sem login 401) e nada é enviado', async () => {
  const s = await subir();
  try {
    const api = await cliente(s);
    const id = destino(s.db, { avisos: ['erro'] });
    s.db.prepare("UPDATE users SET papel = 'operador'").run(); // o papel é relido a cada requisição
    const op = await testar(api, id);
    assert.equal(op.status, 403); assert.equal(op.json.erro, 'Só o Dono pode fazer isso.');
    const anonimo = await req(s.port, `/api/avisos/destinos/${id}/teste`, { method: 'POST', headers: { origin: `http://127.0.0.1:${s.port}` }, body: {} });
    assert.equal(anonimo.status, 401);
    assert.equal(s.wa.simulated.length, 0); assert.equal(linhasDoLog(s.db).length, 0);

    // a recusa do Operador não gasta o freio: o Dono manda logo depois
    s.db.prepare("UPDATE users SET papel = 'dono'").run();
    assert.equal((await testar(api, id)).status, 200);
    assert.equal(s.wa.simulated.length, 1);
  } finally { await s.fechar(); }
});

test('enviar teste: sem ctx.soDono (servidor montado sem ele) ninguém manda: falha fechada', async () => {
  const m = montar(); const id = destino(m.db, { avisos: ['erro'] });
  const rotas = [];
  const app = { get() {}, put() {}, delete() {}, post: (caminho, ...fns) => rotas.push({ caminho, fns }) };
  montarRotasAvisos(app, { db: m.db, wa: m.wa, scheduler: m.scheduler, wrap: (fn) => fn });
  const rota = rotas.find((r) => r.caminho === '/api/avisos/destinos/:id/teste');
  assert.ok(rota, 'a rota existe');
  let status = 0; let corpo = null; let seguiu = false;
  const res = { status(n) { status = n; return this; }, json(j) { corpo = j; return this; }, set() { return this; } };
  await rota.fns[0]({ params: { id: String(id) }, user: null }, res, () => { seguiu = true; });
  assert.equal(seguiu, false); assert.equal(status, 403); assert.deepEqual(corpo, { erro: 'Só o Dono pode fazer isso.' });
  assert.equal(m.wa.simulated.length, 0);
  m.db.close();
});

test('enviar teste: WhatsApp fora dá erro claro e não envia nem gasta o freio', async () => {
  const s = await subir();
  try {
    const api = await cliente(s);
    const id = destino(s.db, { avisos: ['erro'] });
    s.wa.isReady = () => false;
    let enviou = 0; const sendText = s.wa.sendText; s.wa.sendText = async (...a) => { enviou++; return sendText(...a); };
    const fora = await testar(api, id);
    assert.equal(fora.status, 400); assert.equal(fora.json.erro, 'Conecte o WhatsApp em Números de WhatsApp para enviar o teste.');
    assert.equal(enviou, 0); assert.equal(s.wa.simulated.length, 0); assert.equal(linhasDoLog(s.db).length, 0);
    s.wa.isReady = () => true;
    assert.equal((await testar(api, id)).status, 200, 'o freio não contou a tentativa com o WhatsApp fora');
    assert.equal(enviou, 1);
  } finally { await s.fechar(); }
});

test('enviar teste: dois cliques em menos de 60 s mandam uma mensagem só; o segundo recebe 429 com os segundos que faltam', async () => {
  const s = await subir();
  try {
    const api = await cliente(s);
    const id = destino(s.db, { avisos: ['erro'] });
    // clique duplo: o 2º pedido chega enquanto o 1º ainda está no WhatsApp (envio lento de propósito)
    const sendText = s.wa.sendText;
    s.wa.sendText = async (...x) => { await new Promise((r) => setTimeout(r, 150)); return sendText(...x); };
    const [a, b] = await Promise.all([testar(api, id), testar(api, id)]);
    assert.deepEqual([a.status, b.status].sort(), [200, 429]);
    const recusa = a.status === 429 ? a : b;
    assert.equal(recusa.json.segundos, MANUAL_INTERVALO_S);
    assert.equal(recusa.headers['retry-after'], String(MANUAL_INTERVALO_S));
    assert.equal(recusa.json.erro, `Espere ${MANUAL_INTERVALO_S} s para mandar outro teste ou resumo a este número.`);
    assert.equal(s.wa.simulated.length, 1);
    // de novo, logo depois: continua recusando
    const outra = await testar(api, id);
    assert.equal(outra.status, 429); assert.ok(outra.json.segundos >= 1 && outra.json.segundos <= MANUAL_INTERVALO_S, outra.txt);
    assert.equal(s.wa.simulated.length, 1);
    assert.equal(linhasDoLog(s.db).length, 1, 'recusa não vira linha no Histórico');
  } finally { await s.fechar(); }
});

test('enviar teste: no máximo 5 por hora somando todos os números; o 6º recebe 429 e não sai', async () => {
  const s = await subir();
  try {
    const api = await cliente(s);
    const ids = Array.from({ length: MANUAL_MAX_HORA + 1 }, (_, i) => destino(s.db, { nome: `Pessoa ${i + 1}`, jid: `55119000000${i}@s.whatsapp.net`, avisos: ['erro'] }));
    for (const id of ids.slice(0, MANUAL_MAX_HORA)) assert.equal((await testar(api, id)).status, 200);
    const sexto = await testar(api, ids[MANUAL_MAX_HORA]);
    assert.equal(sexto.status, 429, sexto.txt);
    assert.ok(sexto.json.segundos > 3500 && sexto.json.segundos <= 3600, `segundos: ${sexto.json.segundos}`);
    assert.equal(sexto.headers['retry-after'], String(sexto.json.segundos));
    assert.equal(sexto.json.erro, `O limite é de ${MANUAL_MAX_HORA} envios manuais por hora (cada teste ou resumo conta 1, mesmo o resumo para todos). Tente de novo em 60 min.`);
    assert.equal(s.wa.simulated.length, MANUAL_MAX_HORA);
    assert.equal(paraJid(s.wa, `55119000000${MANUAL_MAX_HORA}@s.whatsapp.net`).length, 0);
  } finally { await s.fechar(); }
});

test('enviar teste (relógio controlado): 60 s depois o mesmo número pode de novo; a janela de 1 h anda; falha de entrega vira "aviso" sem número e gasta a vaga', async () => {
  const { db } = montar();
  let relogio = 1000; const enviados = [];
  const wa = { isReady: () => true, sendText: async (jid, text) => { enviados.push({ jid, text }); } };
  const avisos = createAvisos({ db, wa, monotonico: () => relogio });
  const pedro = destino(db, { avisos: ['erro'] });
  const outros = [JID2, JID3, '5511900000001@s.whatsapp.net', '5511900000002@s.whatsapp.net', '5511900000003@s.whatsapp.net']
    .map((jid, i) => destino(db, { nome: `N${i}`, jid }));
  const espera = async (id) => { try { await avisos.enviarTeste({ destinoId: id }); return 0; } catch (e) { assert.equal(e.status, 429, e.message); return e.segundos; } };

  assert.deepEqual(await avisos.enviarTeste({ destinoId: pedro }), { enviado: true, ativo: true, recebe_erro: true });
  relogio += 59_000; assert.equal(await espera(pedro), 1, '59 s depois: falta 1 s');
  relogio += 1_000; assert.equal(await espera(pedro), 0, '60 s depois: sai');
  assert.equal(enviados.length, 2);

  // já foram 2 nesta hora; mais 3 completam 5
  for (const id of outros.slice(0, 3)) assert.equal(await espera(id), 0);
  assert.equal(await espera(outros[3]), 3600 - 60, 'o mais antigo saiu há 60 s');
  relogio = 1000 + 3600_000; assert.equal(await espera(outros[3]), 0, 'uma hora depois do 1º, abre uma vaga');
  assert.ok(await espera(outros[4]) > 0, 'a segunda vaga só abre quando o 2º fizer uma hora');
  relogio = 1000 + 3600_000 + 60_000; assert.equal(await espera(outros[4]), 0);
  assert.equal(enviados.length, 7);

  // falha de entrega: 400 com frase fixa, linha "aviso" no Histórico sem o número, e a vaga fica gasta
  relogio += 3 * 3600_000;
  wa.sendText = async (jid) => { throw new Error(`não entregue para ${jid} (+55 11 98765-4321)`); };
  await assert.rejects(avisos.enviarTeste({ destinoId: pedro }), (e) => e.message === 'Não consegui enviar o teste. Veja o motivo no Histórico.' && e.status == null);
  const falha = db.prepare("SELECT rule_name, level, message FROM log ORDER BY id DESC LIMIT 1").get();
  assert.deepEqual({ ...falha }, { rule_name: 'Avisos', level: 'aviso', message: 'Não consegui enviar o teste do aviso de erro para “Pedro”: não entregue para … (…)' });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM log WHERE level = 'erro'").get().n, 0, 'a falha do teste nunca vira "erro" (não gera aviso de erro)');
  assert.equal(await espera(pedro), MANUAL_INTERVALO_S, 'a tentativa que falhou conta no freio');
  semNumeroNoLog(db);
  db.close();
});

// ---------- Rodada 1 de correção: S1 (papéis e freio dividido com o resumo), R1 (a espera maior manda), S2 ----------
/** Troca os avisos do servidor por uns com relógio monotônico do teste (a rota lê ctx.scheduler.avisos a cada pedido). */
function relogioManual(s) {
  const r = { agora: 0 };
  s.scheduler.avisos = createAvisos({ db: s.db, wa: s.wa, monotonico: () => r.agora });
  return r;
}
const linhaDestino = (db, id) => ({ ...db.prepare('SELECT nome, jid, resumo_blocos, avisos, ativo FROM aviso_destinos WHERE id = ?').get(id) });

test('S1: o Operador recebe 403 ao cadastrar, apagar, trocar o número e tirar "Erro de disparo"; liga, desliga, renomeia e mexe nos blocos', async () => {
  const s = await subir();
  try {
    const api = await cliente(s);
    let consultas = 0; const resolver = s.wa.resolverNumero;
    s.wa.resolverNumero = async (d) => { consultas++; return resolver(d); };
    const pedro = destino(s.db, { avisos: ['erro', 'lotacao'], blocos: [s.casa] });
    const ana = destino(s.db, { nome: 'Ana', jid: JID2, avisos: ['lotacao'] });
    s.db.prepare("UPDATE users SET papel = 'operador'").run(); // o papel é relido a cada requisição
    const antes = [linhaDestino(s.db, pedro), linhaDestino(s.db, ana)];

    const recusas = [
      ['POST', '/api/avisos/destinos', { nome: 'Novo', numero: NUM3, avisos: ['erro'] }],
      ['DELETE', `/api/avisos/destinos/${pedro}`],
      ['PUT', `/api/avisos/destinos/${pedro}`, { numero: NUM3 }],
      ['PUT', `/api/avisos/destinos/${pedro}`, { numero: NUM }, 'o mesmo número digitado de novo também é troca'],
      ['PUT', `/api/avisos/destinos/${pedro}`, { avisos: ['lotacao'] }],
      ['PUT', `/api/avisos/destinos/${pedro}`, { avisos: [] }],
      ['PUT', `/api/avisos/destinos/${pedro}`, { avisos: 'erro' }, 'avisos que não é lista vira [] no servidor: tira "erro"'],
      ['PUT', `/api/avisos/destinos/${pedro}`, { avisos: null }],
      ['PUT', `/api/avisos/destinos/${pedro}`, { nome: 'Pedro', ativo: false, avisos: ['lotacao'] }, 'misturado com o que pode'],
      ['PUT', `/api/avisos/destinos/${pedro}`, { ativo: false }, 'rodada 2: desligar quem recebe "Erro de disparo" cala os avisos de erro'],
    ];
    for (const [metodo, caminho, corpo, nota] of recusas) {
      const r = await api(caminho, metodo, corpo);
      assert.equal(r.status, 403, `${metodo} ${caminho} ${JSON.stringify(corpo)} ${nota || ''}`);
      assert.equal(r.json.erro, 'Só o Dono pode fazer isso.');
    }
    assert.deepEqual([linhaDestino(s.db, pedro), linhaDestino(s.db, ana)], antes, 'nada mudou');
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM aviso_destinos').get().n, 2);
    assert.equal(consultas, 0, 'nenhuma consulta de número ao WhatsApp');

    // o que o Operador pode: ligar (e desligar quem não recebe "Erro de disparo"), nome, blocos, manter (ou pôr) "Erro de disparo", número vazio
    const pode = [
      [ana, { ativo: false }], [ana, { ativo: true }], [pedro, { ativo: true }],
      [pedro, { nome: 'Pedro celular', resumo_blocos: [s.beleza], numero: '' }],
      [pedro, { avisos: ['erro'] }],
      [ana, { avisos: ['lotacao', 'erro'], resumo_blocos: null }],
      [ana, { avisos: ['erro'] }, 'tirar "Grupo lotando" pode'],
    ];
    for (const [id, corpo] of pode) {
      const r = await api(`/api/avisos/destinos/${id}`, 'PUT', corpo);
      assert.equal(r.status, 200, `${JSON.stringify(corpo)}: ${r.txt}`);
    }
    assert.deepEqual(linhaDestino(s.db, pedro), { nome: 'Pedro celular', jid: JID, resumo_blocos: `[${s.beleza}]`, avisos: '["erro"]', ativo: 1 });
    assert.deepEqual(linhaDestino(s.db, ana), { nome: 'Ana', jid: JID2, resumo_blocos: null, avisos: '["erro"]', ativo: 1 });
    // destino que não existe: o mesmo 400 de antes, para os dois papéis
    assert.equal((await api('/api/avisos/destinos/999', 'PUT', { ativo: false })).json.erro, 'Número não encontrado.');

    // o Dono faz tudo isso
    s.db.prepare("UPDATE users SET papel = 'dono'").run();
    assert.equal((await api(`/api/avisos/destinos/${pedro}`, 'PUT', { avisos: [] })).status, 200);
    assert.equal((await api(`/api/avisos/destinos/${pedro}`, 'PUT', { numero: NUM3 })).status, 200);
    assert.equal((await api(`/api/avisos/destinos/${ana}`, 'DELETE')).status, 200);
    assert.equal((await api('/api/avisos/destinos', 'POST', { nome: 'Novo', numero: NUM2 })).status, 200);
    assert.equal(s.wa.simulated.length, 0);
    semNumeroNoLog(s.db);
  } finally { await s.fechar(); }
});

test('S1: sem ctx.soDono, cadastrar, apagar, trocar número e desligar quem recebe "Erro de disparo" também são recusados (falha fechada); ligar e desligar os outros segue', async () => {
  const m = montar(); const id = destino(m.db, { avisos: ['erro'] }); const ana = destino(m.db, { nome: 'Ana', jid: JID2, avisos: ['lotacao'] });
  const rotas = {};
  const guardar = (metodo) => (caminho, ...fns) => { rotas[`${metodo} ${caminho}`] = fns; };
  montarRotasAvisos({ get: guardar('GET'), post: guardar('POST'), put: guardar('PUT'), delete: guardar('DELETE') }, { db: m.db, wa: m.wa, scheduler: m.scheduler, wrap: (fn) => fn });
  const chamar = async (chave, req) => {
    let status = 200; let corpo = null; let i = 0; const fns = rotas[chave];
    const res = { status(n) { status = n; return this; }, json(j) { corpo = j; return this; }, set() { return this; } };
    const proximo = async () => { const fn = fns[i++]; if (fn) await fn({ params: {}, body: {}, ip: '127.0.0.1', user: null, ...req }, res, proximo); };
    await proximo();
    return { status, corpo };
  };
  for (const [chave, req] of [['POST /api/avisos/destinos', { body: { nome: 'X', numero: NUM2 } }], ['DELETE /api/avisos/destinos/:id', { params: { id: String(id) } }],
    ['PUT /api/avisos/destinos/:id', { params: { id: String(id) }, body: { numero: NUM2 } }], ['PUT /api/avisos/destinos/:id', { params: { id: String(id) }, body: { avisos: [] } }],
    ['PUT /api/avisos/destinos/:id', { params: { id: String(id) }, body: { ativo: false } }]]) {
    assert.deepEqual(await chamar(chave, req), { status: 403, corpo: { erro: 'Só o Dono pode fazer isso.' } }, `${chave} ${JSON.stringify(req.body)}`);
  }
  assert.deepEqual(linhaDestino(m.db, id), { nome: 'Pedro', jid: JID, resumo_blocos: null, avisos: '["erro"]', ativo: 1 }, 'o número com "Erro de disparo" segue ligado');
  assert.deepEqual(await chamar('PUT /api/avisos/destinos/:id', { params: { id: String(ana) }, body: { ativo: false } }), { status: 200, corpo: { ok: true } });
  assert.equal(linhaDestino(m.db, ana).ativo, 0);
  assert.deepEqual(await chamar('PUT /api/avisos/destinos/:id', { params: { id: String(ana) }, body: { ativo: true } }), { status: 200, corpo: { ok: true } });
  assert.equal(linhaDestino(m.db, ana).ativo, 1);
  m.db.close();
});

test('S1: "Enviar resumo agora" e "Enviar teste" dividem o freio; resumo repetido em menos de 60 s dá 429 sem envio; o Operador usa o resumo', async () => {
  const s = await subir();
  try {
    const api = await cliente(s); const relogio = relogioManual(s);
    const pedro = destino(s.db, { avisos: ['erro'], blocos: [] });
    const ana = destino(s.db, { nome: 'Ana', jid: JID2, blocos: [] });
    const resumo = (corpo = {}) => api('/api/avisos/resumo-agora', 'POST', corpo);

    // teste para Pedro e, logo depois, resumo para Pedro: 429, nada sai
    assert.equal((await testar(api, pedro)).status, 200);
    const depoisDoTeste = await resumo({ destino_id: pedro });
    assert.equal(depoisDoTeste.status, 429, depoisDoTeste.txt);
    assert.deepEqual(depoisDoTeste.json, { erro: `Espere ${MANUAL_INTERVALO_S} s para mandar outro teste ou resumo a este número.`, segundos: MANUAL_INTERVALO_S });
    assert.equal(depoisDoTeste.headers['retry-after'], String(MANUAL_INTERVALO_S));
    // para todos: Pedro ainda está no freio, então nem a Ana recebe (todas as vagas ou nenhuma)
    relogio.agora = 20_000;
    const todos = await resumo();
    assert.equal(todos.status, 429);
    assert.equal(todos.json.erro, `Espere 40 s: um dos números recebeu um teste ou resumo há menos de ${MANUAL_INTERVALO_S} s.`);
    assert.equal(s.wa.simulated.length, 1, 'só o teste saiu'); assert.equal(paraJid(s.wa, JID2).length, 0);

    // resumo para a Ana, e de novo em menos de 60 s: 429 sem envio
    assert.deepEqual((await resumo({ destino_id: ana })).json, { enviados: 1, falhas: 0 });
    relogio.agora = 79_000;
    const repetido = await resumo({ destino_id: ana });
    assert.equal(repetido.status, 429); assert.equal(repetido.json.segundos, 1);
    assert.equal(paraJid(s.wa, JID2).length, 1);
    // e o teste para a Ana também está no freio que o resumo gastou
    assert.equal((await testar(api, ana)).status, 429);

    // 60 s depois de cada um: o resumo para todos sai, com as duas vagas
    relogio.agora = 80_000;
    assert.deepEqual((await resumo()).json, { enviados: 2, falhas: 0 });
    // o Operador usa o resumo (mesmo freio), mas não o teste
    s.db.prepare("UPDATE users SET papel = 'operador'").run();
    relogio.agora = 200_000;
    assert.equal((await resumo({ destino_id: pedro })).status, 200);
    assert.equal((await testar(api, ana)).status, 403);
    assert.equal(s.wa.simulated.length, 5);
    semNumeroNoLog(s.db);
  } finally { await s.fechar(); }
});

test('rodada 2: o resumo para todos conta 1 envio na hora (não 1 por número), mas confere o freio de cada número: sem vaga em todos, 429 e nada sai', async () => {
  const { db } = montar();
  let relogio = 0; const enviados = [];
  const wa = { isReady: () => true, sendText: async (jid, text) => { enviados.push({ jid, text }); } };
  const avisos = createAvisos({ db, wa, monotonico: () => relogio });
  const a = destino(db, { nome: 'A', jid: JID, blocos: [] }); destino(db, { nome: 'B', jid: JID2, blocos: [] });
  const c = destino(db, { nome: 'C', jid: JID3, avisos: ['erro'] }); const d = destino(db, { nome: 'D', jid: '5511900000004@s.whatsapp.net', avisos: ['erro'] });
  assert.deepEqual(await avisos.enviarResumo({}), { enviados: 2, falhas: 0 });                 // 1 envio na hora
  await avisos.enviarTeste({ destinoId: c }); await avisos.enviarTeste({ destinoId: d });      // 3
  relogio = 61_000;
  assert.deepEqual(await avisos.enviarResumo({}), { enviados: 2, falhas: 0 }, 'o resumo para 2 números gasta 1 vaga da hora, não 2'); // 4
  relogio = 122_000;
  assert.deepEqual(await avisos.enviarResumo({ destinoId: a }), { enviados: 1, falhas: 0 });   // 5
  assert.equal(enviados.length, 7);
  relogio = 183_000;
  await assert.rejects(avisos.enviarResumo({}), (e) => {
    assert.equal(e.status, 429); assert.equal(e.segundos, 3600 - 183);
    assert.equal(e.message, `O limite é de ${MANUAL_MAX_HORA} envios manuais por hora (cada teste ou resumo conta 1, mesmo o resumo para todos). Tente de novo em 57 min.`);
    return true;
  });
  assert.equal(enviados.length, 7, 'nada saiu');
  // tudo ou nada pelo freio de cada número: A recebeu um teste há 10 s, então nem B recebe o resumo
  relogio = 2 * 3600_000;
  await avisos.enviarTeste({ destinoId: a });
  relogio += 10_000;
  await assert.rejects(avisos.enviarResumo({}), (e) => e.status === 429 && e.segundos === 50 && e.limite === 'numero'
    && e.message === `Espere 50 s: um dos números recebeu um teste ou resumo há menos de ${MANUAL_INTERVALO_S} s.`);
  assert.equal(enviados.length, 8); assert.equal(enviados.filter((m) => m.jid === JID2).length, 2);
  // a recusa não gastou vaga: 50 s depois, sai para os dois
  relogio += 50_000;
  assert.deepEqual(await avisos.enviarResumo({}), { enviados: 2, falhas: 0 });
  db.close();
});

test('R1: com os dois limites cheios vale a espera maior: 5 testes ao mesmo número (0, 60, 120, 180, 240 s) e, aos 250 s, a espera é a da hora', async () => {
  const { db } = montar();
  let relogio = 0;
  const avisos = createAvisos({ db, wa: { isReady: () => true, sendText: async () => {} }, monotonico: () => relogio });
  const pedro = destino(db, { avisos: ['erro'] });
  for (const t of [0, 60, 120, 180, 240]) { relogio = t * 1000; await avisos.enviarTeste({ destinoId: pedro }); }
  relogio = 250_000;
  await assert.rejects(avisos.enviarTeste({ destinoId: pedro }), (e) => {
    assert.equal(e.status, 429); assert.equal(e.segundos, 3600 - 250, 'não os 50 s do número');
    assert.equal(e.message, `O limite é de ${MANUAL_MAX_HORA} envios manuais por hora (cada teste ou resumo conta 1, mesmo o resumo para todos). Tente de novo em 56 min.`);
    return true;
  });
  // só o número no freio (a hora com folga): a espera e a frase são as do número
  relogio = 3600_000 + 250_000;
  await avisos.enviarTeste({ destinoId: pedro });
  relogio += 10_000;
  await assert.rejects(avisos.enviarTeste({ destinoId: pedro }), (e) => e.segundos === 50 && e.message === 'Espere 50 s para mandar outro teste ou resumo a este número.');
  db.close();
});

for (const n of [6, 20]) {
  test(`rodada 2: "Enviar resumo agora" com ${n} números manda a todos; clique duplo e 2º clique em menos de 60 s dão 429 sem envio; 5 envios por hora, com a maior espera`, async () => {
    const s = await subir();
    try {
      const api = await cliente(s); const relogio = relogioManual(s);
      const jids = Array.from({ length: n }, (_, i) => `55119${String(i).padStart(8, '0')}@s.whatsapp.net`);
      jids.forEach((jid, i) => destino(s.db, { nome: `Pessoa ${i + 1}`, jid, blocos: [] }));
      const resumo = () => api('/api/avisos/resumo-agora', 'POST', {});
      const porJid = () => jids.map((j) => paraJid(s.wa, j).length);

      // clique duplo: o 2º chega enquanto o 1º ainda está mandando (envio lento de propósito)
      const sendText = s.wa.sendText;
      s.wa.sendText = async (...x) => { await new Promise((r) => setTimeout(r, 20)); return sendText(...x); };
      const [a, b] = await Promise.all([resumo(), resumo()]);
      s.wa.sendText = sendText;
      assert.deepEqual([a.status, b.status].sort(), [200, 429], `${a.txt} | ${b.txt}`);
      const ok = a.status === 200 ? a : b; const recusa = a.status === 429 ? a : b;
      assert.deepEqual(ok.json, { enviados: n, falhas: 0 });
      assert.deepEqual(porJid(), jids.map(() => 1), 'cada número recebeu 1 resumo');
      assert.deepEqual(recusa.json, { erro: `O resumo para todos os números acabou de sair. Espere ${MANUAL_INTERVALO_S} s para mandar de novo.`, segundos: MANUAL_INTERVALO_S });
      assert.equal(recusa.headers['retry-after'], String(MANUAL_INTERVALO_S));

      // 2º clique 30 s depois: 429 com 30 s, nada sai
      relogio.agora = 30_000;
      const cedo = await resumo();
      assert.equal(cedo.status, 429); assert.equal(cedo.json.segundos, 30); assert.equal(cedo.headers['retry-after'], '30');
      assert.match(cedo.json.erro, /^O resumo para todos os números acabou de sair\. Espere 30 s/);
      assert.equal(s.wa.simulated.length, n);

      // a cada 60 s sai de novo, até 5 envios na hora (o 1º foi em 0 s)
      for (const t of [60, 120, 180, 240]) {
        relogio.agora = t * 1000;
        const r = await resumo(); assert.equal(r.status, 200, `${t} s: ${r.txt}`); assert.deepEqual(r.json, { enviados: n, falhas: 0 });
      }
      assert.equal(s.wa.simulated.length, 5 * n);
      // aos 250 s os três freios estão cheios (todos e número: 50 s; hora: 3350 s): vale a maior espera
      relogio.agora = 250_000;
      const hora = await resumo();
      assert.equal(hora.status, 429); assert.equal(hora.json.segundos, 3600 - 250, 'não os 50 s do clique repetido');
      assert.equal(hora.headers['retry-after'], String(3600 - 250));
      assert.equal(hora.json.erro, `O limite é de ${MANUAL_MAX_HORA} envios manuais por hora (cada teste ou resumo conta 1, mesmo o resumo para todos). Tente de novo em 56 min.`);
      // só a hora cheia: a espera é a da hora; o "Enviar teste" divide o mesmo teto
      relogio.agora = 300_000;
      assert.equal((await resumo()).json.segundos, 3300);
      const teste = await testar(api, Number(s.db.prepare('SELECT id FROM aviso_destinos ORDER BY id LIMIT 1').get().id));
      assert.equal(teste.status, 429); assert.equal(teste.json.segundos, 3300);
      assert.equal(s.wa.simulated.length, 5 * n, 'nenhuma recusa mandou nada');
      // uma hora depois do 1º, abre uma vaga
      relogio.agora = 3600_000;
      assert.deepEqual((await resumo()).json, { enviados: n, falhas: 0 });
      assert.equal(linhasDoLog(s.db).filter((l) => l.level === 'ok').length, 6 * n);
      semNumeroNoLog(s.db);
    } finally { await s.fechar(); }
  });
}

test('rodada 2: o resumo diário do horário (tick) não passa pelo freio manual: sai para 7 números com o freio cheio e não gasta vaga', async () => {
  const { db, wa } = montar();
  let relogio = 0; const avisos = createAvisos({ db, wa, monotonico: () => relogio });
  const jids = Array.from({ length: MANUAL_MAX_HORA + 2 }, (_, i) => `55219${String(i).padStart(8, '0')}@s.whatsapp.net`);
  jids.forEach((jid, i) => destino(db, { nome: `Pessoa ${i + 1}`, jid, blocos: [] }));
  const diarios = () => wa.simulated.filter((m) => /^📊 \*Resumo de 02\/11\*/.test(m.text));
  // o freio manual cheio: 5 resumos para todos, a cada 60 s
  for (let i = 0; i < MANUAL_MAX_HORA; i++) { relogio = i * 60_000; await avisos.enviarResumo({ now: at(1, 20, 0) }); } // o manual diz "Resumo de 01/11"
  relogio = MANUAL_MAX_HORA * 60_000;
  const espera = async () => { try { await avisos.enviarResumo({}); return 0; } catch (e) { assert.equal(e.status, 429, e.message); return e.segundos; } };
  assert.equal(await espera(), 3600 - 300, 'o manual está barrado');
  assert.equal(wa.simulated.length, MANUAL_MAX_HORA * jids.length);

  await avisos.tick(at(2, 21, 0));
  assert.equal(diarios().length, jids.length, 'o resumo diário saiu para todos, com o freio manual cheio');
  assert.deepEqual(jids.map((j) => diarios().filter((m) => m.jid === j).length), jids.map(() => 1));
  assert.equal(await espera(), 3600 - 300, 'o tick não gastou nem devolveu vaga do freio manual');

  // e, com o freio vazio, o tick também não reserva vaga: o manual sai logo depois do diário
  const { db: db2, wa: wa2 } = montar();
  const avisos2 = createAvisos({ db: db2, wa: wa2, monotonico: () => 0 });
  jids.forEach((jid, i) => destino(db2, { nome: `Pessoa ${i + 1}`, jid, blocos: [] }));
  await avisos2.tick(at(2, 21, 0));
  assert.equal(wa2.simulated.length, jids.length);
  assert.deepEqual(await avisos2.enviarResumo({}), { enviados: jids.length, falhas: 0 }, 'nenhum número ficou no freio por causa do diário');
  semNumeroNoLog(db); db.close(); db2.close();
});

test('S1 rodada 2: o Operador não desliga um número ligado que recebe "Erro de disparo" (403, banco igual); desliga os outros e liga qualquer um; o Dono faz tudo', async () => {
  const s = await subir();
  try {
    const api = await cliente(s);
    const pedro = destino(s.db, { avisos: ['erro', 'lotacao'], blocos: [] });            // ligado, com erro
    const ana = destino(s.db, { nome: 'Ana', jid: JID2, avisos: ['lotacao'] });          // ligado, sem erro
    const bia = destino(s.db, { nome: 'Bia', jid: JID3, avisos: ['erro'], ativo: 0 });   // desligado, com erro
    s.db.prepare("UPDATE users SET papel = 'operador'").run(); // sessão de Operador (o papel é relido a cada pedido)
    const put = (id, corpo) => api(`/api/avisos/destinos/${id}`, 'PUT', corpo);
    const banco = () => [pedro, ana, bia].map((id) => linhaDestino(s.db, id));
    const antes = banco();

    for (const corpo of [{ ativo: false }, { ativo: 0 }, { ativo: null }, { ativo: '' },
      { ativo: false, avisos: [] }, { ativo: false, avisos: ['lotacao'] }, { ativo: false, avisos: ['erro', 'lotacao'] }, { nome: 'Pedro 2', ativo: false }]) {
      const r = await put(pedro, corpo);
      assert.equal(r.status, 403, JSON.stringify(corpo)); assert.equal(r.json.erro, 'Só o Dono pode fazer isso.');
    }
    assert.deepEqual(banco(), antes, 'nada mudou no banco');
    assert.equal(linhasDoLog(s.db).length, 0);

    // pode: desligar e ligar quem não recebe "Erro de disparo"
    assert.equal((await put(ana, { ativo: false })).status, 200); assert.equal(linhaDestino(s.db, ana).ativo, 0);
    assert.equal((await put(ana, { ativo: true })).status, 200); assert.equal(linhaDestino(s.db, ana).ativo, 1);
    // pode: "desligar" um número com erro que já está desligado (nada cala) e ligá-lo
    assert.equal((await put(bia, { ativo: false })).status, 200); assert.equal(linhaDestino(s.db, bia).ativo, 0);
    assert.equal((await put(bia, { ativo: true })).status, 200); assert.equal(linhaDestino(s.db, bia).ativo, 1);
    // ligado agora, a Bia também só o Dono desliga
    assert.equal((await put(bia, { ativo: false })).status, 403); assert.equal(linhaDestino(s.db, bia).ativo, 1);
    // ligar quem já está ligado e um texto qualquer em `ativo` (que o servidor lê como ligado) passam e não desligam
    assert.equal((await put(pedro, { ativo: true })).status, 200);
    assert.equal((await put(pedro, { ativo: 'false' })).status, 200); assert.equal(linhaDestino(s.db, pedro).ativo, 1);
    // o Operador pode tirar "Erro de disparo"? não (rodada 1); então desligar e tirar juntos continua do Dono
    assert.equal((await put(pedro, { ativo: false, avisos: [] })).status, 403);

    // o Dono faz tudo
    s.db.prepare("UPDATE users SET papel = 'dono'").run();
    assert.equal((await put(pedro, { ativo: false })).status, 200); assert.equal(linhaDestino(s.db, pedro).ativo, 0);
    assert.equal((await put(pedro, { ativo: true })).status, 200);
    assert.equal((await put(pedro, { ativo: false, avisos: [] })).status, 200);
    assert.deepEqual(linhaDestino(s.db, pedro), { nome: 'Pedro', jid: JID, resumo_blocos: '[]', avisos: '[]', ativo: 0 });
    assert.equal(s.wa.simulated.length, 0);
    semNumeroNoLog(s.db);
  } finally { await s.fechar(); }
});

test('S2: algarismos de largura total (e outros \\p{Nd}) contam no limite de 5 do nome, no cadastro e na edição', async () => {
  const s = await subir();
  try {
    const api = await cliente(s);
    const msg = 'Não ponha o número no nome (ele aparece no Histórico): use até 5 algarismos.';
    for (const nome of ['Pedro １１９８７６', 'Pedro ٩٨٧٦٥٤', 'Pedro 12３４５６']) {
      const r = await api('/api/avisos/destinos', 'POST', { nome, numero: NUM });
      assert.equal(r.status, 400, nome); assert.equal(r.json.erro, msg, nome);
    }
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM aviso_destinos').get().n, 0);
    assert.equal((await api('/api/avisos/destinos', 'POST', { nome: 'Loja １２３４５', numero: NUM })).status, 200, '5 algarismos ainda podem');
    const id = s.db.prepare('SELECT id FROM aviso_destinos').get().id;
    const ed = await api(`/api/avisos/destinos/${id}`, 'PUT', { nome: 'Pedro ９８７６５４' });
    assert.equal(ed.status, 400); assert.equal(ed.json.erro, msg);
    assert.equal(linhaDestino(s.db, id).nome, 'Loja １２３４５');
  } finally { await s.fechar(); }
});

// Tela (public/relatorios.js num vm, com o `esc` de verdade do app.js e o resto falso): o botão só para o Dono, travado enquanto envia.
function telaRelatorios({ dono = true } = {}) {
  const pub = (arq) => fs.readFileSync(new URL(`../public/${arq}`, import.meta.url), 'utf8');
  const els = new Map(); const avisosTela = []; const pedidos = [];
  const el = (s) => { if (!els.has(s)) els.set(s, { textContent: '', isConnected: true, attrs: {}, setAttribute(k, v) { this.attrs[k] = String(v); }, removeAttribute(k) { delete this.attrs[k]; } }); return els.get(s); };
  // #id que só existe se a página o desenhou (como no navegador): devolve null quando não está no HTML de #pagina/#dlg
  const desenhado = new Set(['#rel-novo', '#f-salvar', '#cancelar', '#f']);
  const $ = (s) => (desenhado.has(s) && ![el('#pagina'), el('#dlg')].some((e) => String(e.innerHTML || '').includes(`id="${s.slice(1)}"`)) ? null : el(s));
  const ctx = {
    $, $$: () => [], q: () => '', podeEquipe: () => dono, REQ: '*', tentar: (fn) => fn, mostrarErros: () => false, zap: (x) => x,
    aviso: (msg, erro = false) => avisosTela.push({ msg, erro }),
    api: (caminho, metodo, corpo) => new Promise((ok, falha) => pedidos.push({ caminho, metodo, corpo, ok, falha })),
  };
  vm.createContext(ctx);
  vm.runInContext(/^const esc = .*$/m.exec(pub('app.js'))[0], ctx);
  vm.runInContext(pub('relatorios.js'), ctx);
  return { ctx, el, avisosTela, pedidos, rodar: (c) => vm.runInContext(c, ctx) };
}
const DADOS_TELA = { blocos: [], destinos: [
  { id: 4, nome: 'Pedro', numero: '+55 11 •••••-4321', resumo_blocos: null, avisos: ['erro'], ativo: true },
  { id: 5, nome: '<b>"Zé"</b>', numero: '+55 21 •••••-5678', resumo_blocos: [], avisos: [], ativo: false },
] };
const botaoFalso = () => ({ disabled: false, textContent: 'Enviar teste', isConnected: true, focos: 0, attrs: {}, setAttribute(k, v) { this.attrs[k] = String(v); }, removeAttribute(k) { delete this.attrs[k]; }, focus() { this.focos++; } });

test('S1 (tela): o Operador não vê Adicionar número nem Remover; o Dono vê', () => {
  for (const dono of [true, false]) {
    const t = telaRelatorios({ dono }); t.ctx.__d = { ...DADOS_TELA, config: { resumo_horario: '21:00', virada_dia: '00:00', limite_padrao: 1000 } };
    t.el('#dlg').showModal = () => {}; t.el('#pagina').innerHTML = '';
    t.rodar('pintarRelatorios(__d)');
    const html = t.el('#pagina').innerHTML;
    assert.equal(/id="rel-novo"/.test(html), dono, `Adicionar número (dono=${dono})`);
    assert.equal((html.match(/data-act="remover"/g) || []).length, dono ? 2 : 0, `Remover (dono=${dono})`);
    assert.equal((html.match(/data-act="editar"/g) || []).length, 2, 'Editar fica para os dois');
    assert.equal((html.match(/data-act="ativo"/g) || []).length, 2, 'a chave Ativo fica para os dois');
    assert.match(html, /id="rel-agora"/, 'Enviar resumo agora fica para os dois');
  }
});

test('S1 (tela): no Editar do Operador o número fica travado e “Erro de disparo” marcado não se desmarca; no do Dono, nada travado', () => {
  const abrir = (dono, x) => {
    const t = telaRelatorios({ dono }); t.ctx.__d = DADOS_TELA; t.ctx.__x = x;
    t.el('#dlg').showModal = () => {}; t.el('[name=nome]').focus = () => {};
    t.rodar('formDestinoAviso(__d, __x)');
    return t.el('#dlg').innerHTML;
  };
  const [pedro, ze] = DADOS_TELA.destinos;
  const op = abrir(false, pedro);
  assert.match(op, /<input name="numero"[^>]* disabled>/, 'número travado');
  assert.match(op, /Hoje: \+55 11 •••••-4321\. Só o Dono troca o número\./);
  assert.match(op, /<input type="checkbox" name="aviso" value="erro" checked disabled/);
  assert.match(op, /Uma mensagem não saiu\.[^<]*Só o Dono tira este aviso\./);
  assert.match(op, /<input type="checkbox" name="aviso" value="lotacao"  style/, '“Grupo lotando” continua livre');
  // sem "Erro de disparo" marcado, o Operador pode marcar
  assert.match(abrir(false, ze), /<input type="checkbox" name="aviso" value="erro"  style/);
  const dono = abrir(true, pedro);
  assert.doesNotMatch(dono, / disabled/); assert.doesNotMatch(dono, /Só o Dono/);
  assert.match(dono, /Deixe em branco para manter; digite outro para trocar\./);
});

test('enviar teste (tela): o Dono vê "Enviar teste" em cada número, com type=button e nome acessível; o Operador não vê', () => {
  const t = telaRelatorios(); t.ctx.__d = DADOS_TELA;
  const html = t.rodar('tabelaDestinosAviso(__d)');
  assert.ok(html.includes('<button type="button" data-act="teste" aria-label="Enviar teste do aviso de erro para Pedro">Enviar teste</button>'), html);
  assert.ok(html.includes('aria-label="Enviar teste do aviso de erro para &lt;b&gt;&quot;Zé&quot;&lt;/b&gt;">Enviar teste</button>'), 'nome escapado');
  assert.equal(html.match(/data-act="teste"/g).length, 2);
  // fica ao lado dos botões que já existiam, na mesma célula, antes do Editar
  assert.match(html, /data-act="teste"[^]*?data-act="editar"[^]*?data-act="remover"/);
  const op = telaRelatorios({ dono: false }); op.ctx.__d = DADOS_TELA;
  const htmlOp = op.rodar('tabelaDestinosAviso(__d)');
  assert.doesNotMatch(htmlOp, /data-act="teste"|Enviar teste/);
  assert.match(htmlOp, /data-act="editar"/, 'o resto da linha continua');
});

test('enviar teste (tela): trava o botão com "Enviando…" enquanto envia, um 2º clique não pede de novo, e o resultado vai ao aviso', async () => {
  const t = telaRelatorios(); const btn = botaoFalso(); t.ctx.__btn = btn;
  t.ctx.__x = DADOS_TELA.destinos[0];
  const p = t.rodar('enviarTesteAviso(__btn, __x)');
  assert.deepEqual([btn.disabled, btn.textContent, btn.attrs['aria-busy']], [true, 'Enviando…', 'true']);
  await t.rodar('enviarTesteAviso(__btn, __x)'); // clique duplo
  assert.equal(t.pedidos.length, 1);
  assert.deepEqual({ caminho: t.pedidos[0].caminho, metodo: t.pedidos[0].metodo }, { caminho: '/avisos/destinos/4/teste', metodo: 'POST' });
  t.pedidos[0].ok({ enviado: true, ativo: true, recebe_erro: true });
  await p;
  assert.deepEqual([btn.disabled, btn.textContent, 'aria-busy' in btn.attrs], [false, 'Enviar teste', false]);
  assert.equal(btn.focos, 1, 'D2: o foco volta ao botão');
  const ok = 'Teste enviado para “Pedro”. Confira no WhatsApp. Ele recebe os avisos de erro e de backup atrasado.';
  assert.deepEqual(t.avisosTela, [{ msg: ok, erro: false }]);
  assert.equal(t.el('#rel-estado').textContent, ok, 'o resultado fica na tela depois que o aviso some');

  // desligado e sem "Erro de disparo": a resposta diz os dois
  const p2 = t.rodar('enviarTesteAviso(__btn, __x)');
  t.pedidos[1].ok({ enviado: true, ativo: false, recebe_erro: false }); await p2;
  assert.equal(t.avisosTela[1].msg, 'Teste enviado para “Pedro”. Confira no WhatsApp. Este número está desligado: ligue-o para receber os avisos de verdade. Ele não recebe os avisos de erro: marque “Erro de disparo” em Editar.');
  const p3 = t.rodar('enviarTesteAviso(__btn, __x)');
  t.pedidos[2].ok({ enviado: true, ativo: false, recebe_erro: true }); await p3;
  assert.equal(t.avisosTela[2].msg, 'Teste enviado para “Pedro”. Confira no WhatsApp. Este número está desligado: ligue-o para receber os avisos de verdade.');

  // recusa (429 do freio): o botão volta e o erro sobe (o tentar da página o mostra como aviso de erro)
  const p4 = t.rodar('enviarTesteAviso(__btn, __x)');
  t.pedidos[3].falha(new Error('Espere 42 s para mandar outro teste ou resumo a este número.'));
  await assert.rejects(p4, /Espere 42 s/);
  assert.deepEqual([btn.disabled, btn.textContent], [false, 'Enviar teste']);
  assert.equal(btn.focos, 4, 'D2: também depois de um erro (o 2º clique travado não conta)');
  assert.equal(t.avisosTela.length, 3);
  // botão que saiu do documento (a página foi redesenhada) não recebe o foco
  const fora = botaoFalso(); t.ctx.__fora = fora; const p5 = t.rodar('enviarTesteAviso(__fora, __x)');
  fora.isConnected = false; t.pedidos[4].ok({ enviado: true, ativo: true, recebe_erro: true }); await p5;
  assert.equal(fora.focos, 0);
});

// Rodada 2 (S1): a chave Ativo travada para o Operador num número ligado que recebe "Erro de disparo"
const DADOS_CHAVE = { blocos: [], config: { resumo_horario: '21:00', virada_dia: '00:00', limite_padrao: 1000 }, destinos: [
  { id: 4, nome: 'Pedro', numero: '+55 11 •••••-4321', resumo_blocos: null, avisos: ['erro'], ativo: true },
  { id: 5, nome: 'Ana', numero: '+55 21 •••••-5678', resumo_blocos: [], avisos: ['lotacao'], ativo: true },
  { id: 6, nome: 'Bia', numero: '+55 31 •••••-5432', resumo_blocos: [], avisos: ['erro'], ativo: false },
] };
const SO_DONO_DESLIGA = 'Só o Dono desliga um número que recebe “Erro de disparo”.';
const chaveDe = (html, id) => new RegExp(`<tr data-id="${id}">[^]*?(<label class="chave"[^]*?</label><span class="sr-only" id="rel-ativo-d-${id}">[^<]*</span>)`).exec(html)[1];

test('S1 rodada 2 (tela): para o Operador, a chave Ativo de um número ligado com “Erro de disparo” fica travada, com a dica; as outras ficam livres; o Dono não tem trava', () => {
  const op = telaRelatorios({ dono: false }); op.ctx.__d = DADOS_CHAVE;
  const html = op.rodar('tabelaDestinosAviso(__d)');
  const pedro = chaveDe(html, 4);
  assert.match(pedro, new RegExp(`<label class="chave" title="${SO_DONO_DESLIGA}"`));
  assert.match(pedro, /<input type="checkbox" data-act="ativo" checked disabled aria-label="Ativo: Pedro" aria-describedby="rel-ativo-d-4">/);
  assert.ok(pedro.endsWith(`<span class="sr-only" id="rel-ativo-d-4">${SO_DONO_DESLIGA}</span>`), 'a dica chega ao leitor de tela');
  for (const [id, marcada] of [[5, ' checked'], [6, '']]) {
    const c = chaveDe(html, id);
    assert.doesNotMatch(c, /disabled|Só o Dono/, `id ${id}: desligar sem erro e ligar ficam livres`);
    assert.match(c, new RegExp(`data-act="ativo"${marcada}\\s+aria-label`));
  }
  const dono = telaRelatorios(); dono.ctx.__d = DADOS_CHAVE;
  const htmlDono = dono.rodar('tabelaDestinosAviso(__d)');
  assert.doesNotMatch(htmlDono, /data-act="ativo"[^>]*disabled|Só o Dono desliga/);
});

test('S1 rodada 2 (tela): o Operador liga um número com “Erro de disparo” e a chave trava em seguida; falha volta a chave e não trava; desligar a Ana segue livre', async () => {
  const t = telaRelatorios({ dono: false });
  const d = JSON.parse(JSON.stringify(DADOS_CHAVE)); t.ctx.__d = d;
  const rotulos = {}; const chaves = d.destinos.map((x) => {
    rotulos[x.id] = { title: 'Ativo' };
    return { checked: x.ativo, disabled: false, closest: (sel) => (sel === '[data-id]' ? { dataset: { id: String(x.id) } } : sel === 'label' ? rotulos[x.id] : null) };
  });
  t.ctx.$$ = (sel) => (sel === '[data-act=ativo]' ? chaves : []);
  t.el('#dlg').showModal = () => {}; t.el('#pagina').innerHTML = '';
  t.rodar('pintarRelatorios(__d)');
  const [, ana, bia] = chaves;
  const mudar = async (inp, valor, resposta) => {
    inp.checked = valor; const p = inp.onchange(); const pedido = t.pedidos.at(-1);
    assert.deepEqual({ caminho: pedido.caminho, metodo: pedido.metodo, corpo: JSON.parse(JSON.stringify(pedido.corpo)) }, { caminho: `/avisos/destinos/${d.destinos[chaves.indexOf(inp)].id}`, metodo: 'PUT', corpo: { ativo: valor } });
    assert.equal(inp.disabled, true, 'travada enquanto pede');
    if (resposta instanceof Error) { pedido.falha(resposta); await assert.rejects(p); } else { pedido.ok(resposta); await p; }
  };
  // ligar a Bia falha: a chave volta a desligada e continua livre
  await mudar(bia, true, new Error('Só o Dono pode fazer isso.'));
  assert.deepEqual([bia.checked, bia.disabled, rotulos[6].title], [false, false, 'Ativo']);
  // ligar a Bia dá certo: agora ela recebe "Erro de disparo" ligada, então a chave trava, com a dica
  await mudar(bia, true, { ok: true });
  assert.deepEqual([bia.checked, bia.disabled, rotulos[6].title], [true, true, SO_DONO_DESLIGA]);
  assert.equal(t.el('#rel-ativo-d-6').textContent, SO_DONO_DESLIGA);
  assert.equal(d.destinos[2].ativo, true);
  // a Ana (sem erro) desliga e liga sem trava
  await mudar(ana, false, { ok: true });
  assert.deepEqual([ana.checked, ana.disabled, rotulos[5].title], [false, false, 'Ativo']);
  assert.equal(t.el('#rel-ativo-d-5').textContent, '');
  assert.deepEqual(t.avisosTela.map((a) => a.msg), ['Número ligado', 'Número desligado']);
});

test('S1 rodada 2 (tela): no Editar do Operador, “Ativo” de um número ligado com “Erro de disparo” fica travado com a dica; desligado, fica livre para ligar; no Dono, nada travado', () => {
  const abrir = (dono, x) => {
    const t = telaRelatorios({ dono }); t.ctx.__d = DADOS_CHAVE; t.ctx.__x = x;
    t.el('#dlg').showModal = () => {}; t.el('[name=nome]').focus = () => {};
    t.rodar('formDestinoAviso(__d, __x)');
    return t.el('#dlg').innerHTML;
  };
  const [pedro, ana, bia] = DADOS_CHAVE.destinos;
  const op = abrir(false, pedro);
  assert.match(op, /<input type="checkbox" name="ativo" checked disabled style/);
  assert.ok(op.includes(`Desligado, o número não recebe nada até você ligar de novo. ${SO_DONO_DESLIGA}</small>`));
  for (const x of [ana, bia]) {
    const h = abrir(false, x);
    assert.match(h, /<input type="checkbox" name="ativo" (checked)? style/, x.nome);
    assert.ok(!h.includes(SO_DONO_DESLIGA), x.nome);
  }
  assert.ok(!abrir(true, pedro).includes(SO_DONO_DESLIGA));
  assert.match(abrir(true, pedro), /<input type="checkbox" name="ativo" checked style/);
});

// ---------- vigia: linha de saúde no resumo e entrega aos destinos de "Erro de disparo" (entrega 3, etapa 4) ----------

/** Uma linha de `execucoes` como o agendador grava (etapa 5): `por` = { loja: { saiu, pulada, descartada, esperou } }. */
function execucao(db, ts, { rule_id = 1, conta = 1, erros = 0, lojas = ['ml', 'amazon'], ...por } = {}) {
  const saidas = Object.values(por).reduce((s, l) => s + (l.saiu || 0), 0);
  db.prepare('INSERT INTO execucoes (ts, rule_id, conta, saidas, erros, lojas_pedidas, por_loja) VALUES (?,?,?,?,?,?,?)')
    .run(ts, rule_id, conta, saidas, erros, JSON.stringify(lojas), JSON.stringify(por));
}
const regraNoBanco = (db, enabled = 1) => db.prepare("INSERT INTO rules (name, enabled, created_at) VALUES ('Ofertas', ?, 1)").run(enabled);
let itemCatalogo = 0;
function itensNoCatalogo(db, n, { rule_id = 1, loja = 'amazon', status = 'revisao' } = {}) {
  for (let i = 0; i < n; i++) {
    db.prepare("INSERT INTO catalogo_itens (rule_id, chave, loja, status, oferta, criado_em) VALUES (?,?,?,?,'{}',1)")
      .run(rule_id, `K${++itemCatalogo}`, loja, status);
  }
}
/** Causa aberta no formato de `causasAbertas` do vigia (o que a opção `abertas` devolve). */
const AMAZON_PARADA = Object.freeze({ tipo: 'loja', chave: 'loja:amazon', loja: 'amazon', n: 3, desdeEm: at(10, 9, 10), calada: false });
const BLOCO_SAUDE = [
  '🩺 *Saúde dos envios* (todas as regras)',
  'Amazon: 14 enviadas · Mercado Livre: 9 enviadas',
  'Puladas: 6 · Descartadas: 2 · Falhas: 1',
  'Esperando revisão: 7',
  'Em aberto agora: Amazon parada desde 09:10.',
].join('\n');
/** O dia 10/11 do exemplo da spec (§2), mais o que não pode contar: ontem, depois do `now` e revisão já decidida. */
function diaDoExemplo(db) {
  regraNoBanco(db); regraNoBanco(db);
  execucao(db, at(10, 9, 0), { ml: { saiu: 5, descartada: 1 }, amazon: { saiu: 10, pulada: 2 }, erros: 1 });
  execucao(db, at(10, 12, 0), { rule_id: 2, lojas: ['amazon', 'ml'], ml: { saiu: 4, descartada: 1 }, amazon: { saiu: 4, pulada: 1, esperou: 3 } });
  execucao(db, at(9, 23, 59), { shopee: { saiu: 50, pulada: 9 }, erros: 9 }); // dia anterior
  execucao(db, at(10, 21, 1), { amazon: { saiu: 100 }, erros: 9 });           // depois do `now` do resumo
  itensNoCatalogo(db, 5); itensNoCatalogo(db, 2, { rule_id: 2, loja: 'shopee' }); // D6: a revisão conta a Shopee
  itensNoCatalogo(db, 3, { status: 'enviado' }); itensNoCatalogo(db, 1, { status: 'descartado' });
}
const comSaude = (db, wa) => createAvisos({ db, wa, linhaDeSaude, abertas: () => [AMAZON_PARADA] });

test('saúde (CA3.3): o resumo traz os números do dia de todas as regras, uma vez, no fim, depois das seções; o que é de ontem ou de depois não conta', async () => {
  const { db, wa, casa, beleza } = montar(); diaDoExemplo(db);
  const avisos = comSaude(db, wa);
  const texto = avisos.montarResumo([casa, beleza], at(10, 21, 0));
  assert.ok(texto.endsWith(`\n\n${BLOCO_SAUDE}`), texto);
  assert.equal(texto.split('🩺').length, 2, 'o bloco aparece uma vez só');
  assert.ok(texto.indexOf('*Beleza*') < texto.indexOf('🩺') && texto.indexOf('*Casa*') < texto.indexOf('🩺'), 'depois das seções por bloco');
  assert.ok(avisos.montarResumo([], at(10, 21, 0)).endsWith(`\n\n${BLOCO_SAUDE}`), 'igual com "Todos os grupos": o bloco não é filtrado por bloco');

  // o resumo diário do horário leva o mesmo bloco
  destino(db, { blocos: [] });
  await avisos.tick(at(10, 21, 0));
  const msg = paraJid(wa, JID);
  assert.equal(msg.length, 1); assert.ok(msg[0].text.endsWith(`\n\n${BLOCO_SAUDE}`), msg[0].text);

  db.prepare('DELETE FROM blocks').run();
  assert.ok(avisos.montarResumo([casa], at(10, 21, 0)).endsWith(`Edite o número em Relatórios e avisos.\n\n${BLOCO_SAUDE}`), 'blocos apagados: a saúde continua');
  semNumeroNoLog(db);
});

test('saúde (CA3.3): dia sem execução, regra ativa sem execução, dia sem nada a relatar e a virada do dia', () => {
  const { db, wa } = montar(); const avisos = createAvisos({ db, wa, linhaDeSaude, abertas: () => [] });
  const bloco = (now) => avisos.montarResumo([], now).split('\n\n').at(-1);
  const NENHUMA = '🩺 *Saúde dos envios*\nNenhuma regra rodou hoje: não havia regra ativa com horário no dia.';
  assert.equal(bloco(at(10, 21, 0)), NENHUMA);
  regraNoBanco(db, 0);
  assert.equal(bloco(at(10, 21, 0)), NENHUMA, 'regra desligada não é regra ativa');
  regraNoBanco(db, 1);
  assert.equal(bloco(at(10, 21, 0)), ['🩺 *Saúde dos envios* (todas as regras)', 'Puladas: 0 · Descartadas: 0 · Falhas: 0', 'Esperando revisão: nenhuma'].join('\n'),
    'regra ativa e nenhuma execução: os zeros');

  // virada às 02:00: o dia de negócio 10/11 vai de 10/11 02:00 a 11/11 01:59
  setSetting(db, 'virada_dia', '02:00');
  execucao(db, at(10, 1, 59), { amazon: { saiu: 7, pulada: 4 } }); // ainda o dia 09/11
  execucao(db, at(10, 2, 0), { amazon: { saiu: 1 } });
  execucao(db, at(11, 1, 0), { ml: { saiu: 2 } });
  assert.equal(bloco(at(11, 1, 30)), ['🩺 *Saúde dos envios* (todas as regras)', 'Mercado Livre: 2 enviadas · Amazon: 1 enviada',
    'Nenhuma pulada, descartada nem falha. Nada esperando revisão.'].join('\n'));
  itensNoCatalogo(db, 1);
  assert.equal(bloco(at(11, 1, 30)), ['🩺 *Saúde dos envios* (todas as regras)', 'Mercado Livre: 2 enviadas · Amazon: 1 enviada',
    'Puladas: 0 · Descartadas: 0 · Falhas: 0', 'Esperando revisão: 1'].join('\n'), 'uma na revisão já é algo a relatar');
});

test('saúde: sem as opções o resumo é o de hoje (prévia inclusive); abertas que falha não esconde o bloco; linhaDeSaude que falha não derruba o resumo diário', async () => {
  const s = await subir();
  try {
    diaDoExemplo(s.db);
    const api = await cliente(s);
    const sem = createAvisos({ db: s.db, wa: s.wa }).montarResumo([], at(10, 21, 0));
    assert.ok(!sem.includes('🩺') && sem.endsWith('🔗 Cliques: 0'), sem);
    assert.ok(!(await api('/api/avisos/previa')).json.texto.includes('🩺'), 'agendador sem as opções: a prévia como hoje');
    s.scheduler.avisos = comSaude(s.db, s.wa);
    const previa = (await api('/api/avisos/previa')).json.texto;
    assert.match(previa, /\n\n🩺 \*Saúde dos envios\* \(todas as regras\)\n/, 'a prévia chama o mesmo montarResumo');
    assert.equal(previa.split('🩺').length, 2);

    // abertas() que lança ou não devolve lista: o bloco sai sem "Em aberto agora"; sem `abertas`, igual
    const semAbertas = `\n\n${BLOCO_SAUDE.split('\n').slice(0, 4).join('\n')}`;
    for (const abertas of [() => { throw new Error('vigia quebrado 11 98765-4321'); }, () => null, () => ({ causas: [AMAZON_PARADA] }), 'não é função', undefined]) {
      const t = createAvisos({ db: s.db, wa: s.wa, linhaDeSaude, abertas }).montarResumo([], at(10, 21, 0));
      assert.ok(t.endsWith(semAbertas), t);
    }

    // linhaDeSaude que lança ou não devolve texto: o resumo sai sem o bloco, e nada vira "erro"
    const erros = () => s.db.prepare("SELECT COUNT(*) AS n FROM log WHERE level = 'erro'").get().n;
    for (const f of [() => { throw new Error('quebrou para 5511987654321@s.whatsapp.net'); }, () => null, () => 42, () => '', 'não é função']) {
      assert.equal(createAvisos({ db: s.db, wa: s.wa, linhaDeSaude: f, abertas: () => [] }).montarResumo([], at(10, 21, 0)), sem);
    }
    destino(s.db, { blocos: [] });
    const quebrado = createAvisos({ db: s.db, wa: s.wa, linhaDeSaude: () => { throw new Error('quebrou'); }, abertas: () => [] });
    await quebrado.tick(at(10, 21, 0));
    assert.deepEqual(paraJid(s.wa, JID).map((m) => m.text), [sem], 'o resumo diário sai sem a saúde');
    assert.equal(erros(), 0);

    // um bloco com mais de 5 linhas é cortado em 5
    const longo = createAvisos({ db: s.db, wa: s.wa, linhaDeSaude: () => 'a\nb\nc\nd\ne\nf\ng' }).montarResumo([], at(10, 21, 0));
    assert.ok(longo.endsWith('🔗 Cliques: 0\n\na\nb\nc\nd\ne'), longo);
    // o que linhaDeSaude recebe: as execuções do dia, a revisão, as abertas, se há regra ativa e o `now`
    let recebido = null;
    createAvisos({ db: s.db, wa: s.wa, linhaDeSaude: (x) => { recebido = x; return 'ok'; }, abertas: () => [AMAZON_PARADA] }).montarResumo([], at(10, 21, 0));
    assert.deepEqual(recebido.execucoes.map((e) => e.ts), [at(10, 9, 0), at(10, 12, 0)]);
    assert.deepEqual([recebido.revisao, recebido.abertas, recebido.temRegraAtiva, recebido.agora], [7, [AMAZON_PARADA], true, at(10, 21, 0)]);
    semNumeroNoLog(s.db);
  } finally { await s.fechar(); }
});

test('entregarAosDeErro (CA3.5): só os destinos ativos com "Erro de disparo"; a linha do Histórico tem o nome do destino, nunca o número', async () => {
  const { db, wa } = montar(); const avisos = createAvisos({ db, wa });
  const TEXTO = '⚠️ *Amazon parada desde 09:10*\nNas últimas 3 execuções nenhuma oferta da Amazon saiu.';
  const linhasNoLog = () => db.prepare('SELECT COUNT(*) AS n FROM log').get().n;
  const antes = linhasNoLog();
  assert.equal(await avisos.entregarAosDeErro(TEXTO, 'o aviso do vigia'), 0, 'sem destino: ninguém recebe');
  assert.equal(linhasNoLog(), antes, 'e nada vai ao Histórico');

  destino(db, { avisos: ['erro'] });
  destino(db, { nome: 'Ana', jid: JID2, avisos: ['erro', 'lotacao'], ativo: 0 });
  destino(db, { nome: 'Bia', jid: JID3, avisos: ['lotacao'], blocos: [] });
  assert.equal(await avisos.entregarAosDeErro(TEXTO, 'o aviso do vigia'), 1);
  assert.deepEqual(paraJid(wa, JID).map((m) => [m.tipo, m.text]), [['text', TEXTO]]);
  assert.equal(paraJid(wa, JID2).length + paraJid(wa, JID3).length, 0, 'desligado e quem não marcou "Erro de disparo" não recebem');
  const linha = db.prepare('SELECT rule_name, level, message FROM log ORDER BY id DESC LIMIT 1').get();
  assert.deepEqual({ ...linha }, { rule_name: 'Avisos', level: 'ok', message: 'Enviei o aviso do vigia para “Pedro”.' });

  db.prepare('UPDATE aviso_destinos SET ativo = 1').run();
  assert.equal(await avisos.entregarAosDeErro(TEXTO, 'o aviso de volta do vigia'), 2, 'devolve quantos receberam');
  assert.deepEqual(db.prepare("SELECT message FROM log WHERE level = 'ok' ORDER BY id DESC LIMIT 2").all().map((l) => l.message).sort(),
    ['Enviei o aviso de volta do vigia para “Ana”.', 'Enviei o aviso de volta do vigia para “Pedro”.']);

  // o "o quê" também não leva número ao Histórico; texto vazio ou que não é texto não sai
  const COM_NUMERO = 'o aviso para (11) 98765-4321 e 5511987654321@s.whatsapp.net';
  await avisos.entregarAosDeErro(TEXTO, COM_NUMERO);
  assert.equal(db.prepare('SELECT message FROM log ORDER BY id DESC LIMIT 1').get().message, `Enviei ${semNumero(COM_NUMERO)} para “Pedro”.`);
  for (const oQue of [undefined, null, '', 7]) {
    await avisos.entregarAosDeErro(TEXTO, oQue);
    assert.equal(db.prepare('SELECT message FROM log ORDER BY id DESC LIMIT 1').get().message, 'Enviei o aviso do vigia para “Pedro”.', String(oQue));
  }
  const enviados = wa.simulated.length;
  for (const t of ['', '   ', null, undefined, 42, { texto: TEXTO }]) assert.equal(await avisos.entregarAosDeErro(t, 'o aviso do vigia'), 0);
  assert.equal(wa.simulated.length, enviados);
  semNumeroNoLog(db);
});

test('entregarAosDeErro (CA3.7): falha de entrega vira "aviso" sem número, nunca "erro"; não dispara o aviso de erro nem tenta de novo; nunca lança', async () => {
  const { db, wa } = montar(); const avisos = createAvisos({ db, wa });
  destino(db, { avisos: ['erro'] }); destino(db, { nome: 'Ana', jid: JID2, avisos: ['erro'] });
  await avisos.tick(at(10, 9, 0)); // o 1º tick só marca o cursor do aviso de erro
  let tentativas = 0;
  const original = wa.sendText.bind(wa);
  wa.sendText = async (jid) => { tentativas++; throw new Error(`não entregue para ${jid} (+55 11 98765-4321)`); };
  assert.equal(await avisos.entregarAosDeErro('⚠️ *Extensão do Chrome fora desde 09:10*', 'o aviso do vigia'), 0);
  assert.equal(tentativas, 2, 'uma tentativa por destino, sem repetir');
  assert.deepEqual(db.prepare("SELECT message FROM log WHERE level = 'aviso' ORDER BY id").all().map((l) => l.message),
    ['Não consegui enviar o aviso do vigia para “Ana”: não entregue para … (…)', 'Não consegui enviar o aviso do vigia para “Pedro”: não entregue para … (…)']);
  const erros = () => db.prepare("SELECT COUNT(*) AS n FROM log WHERE level = 'erro'").get().n;
  assert.equal(erros(), 0);
  await avisos.tick(at(10, 9, 5)); await avisos.tick(at(10, 10, 0));
  assert.equal(tentativas, 2, 'o aviso de erro não vê a falha do vigia: nada sai de novo');

  // um destino falha e o outro recebe: conta só o que recebeu
  wa.sendText = async (jid, texto) => { if (jid === JID2) throw new Error('falhou'); return original(jid, texto); };
  assert.equal(await avisos.entregarAosDeErro('texto', 'o aviso do vigia'), 1);
  // erro que não é Error: vira "aviso" do mesmo jeito, sem número
  wa.sendText = async () => { throw 'texto solto 5511987654321'; };
  assert.equal(await avisos.entregarAosDeErro('texto', 'o aviso do vigia'), 0);
  assert.equal(erros(), 0);
  semNumeroNoLog(db);
  // o Histórico recusa a linha da Ana: a mensagem dela saiu, mas a falha não impede a do Pedro nem lança
  wa.sendText = original;
  db.exec("CREATE TRIGGER sem_ana BEFORE INSERT ON log WHEN NEW.message LIKE '%“Ana”%' BEGIN SELECT RAISE(ABORT, 'log recusado'); END");
  assert.equal(await avisos.entregarAosDeErro('texto', 'o aviso do vigia'), 1, 'só o Pedro conta (a da Ana não tem a linha do Histórico)');
  assert.equal(paraJid(wa, JID).at(-1).text, 'texto');
  db.exec('DROP TRIGGER sem_ana');
  // o banco (destinos e Histórico) fora do ar: devolve 0 sem lançar
  db.close();
  assert.equal(await avisos.entregarAosDeErro('texto', 'o aviso do vigia'), 0);
});

test('entregarAosDeErro (CA3.5): pelo agendador, a mensagem passa pelo porteiro do ritmo e conta em wa_saidas', async () => {
  const { db, wa, scheduler } = montar();
  destino(db, { avisos: ['erro'] }); destino(db, { nome: 'Ana', jid: JID2, avisos: ['erro'] });
  const saidas = () => db.prepare('SELECT COUNT(*) AS n FROM wa_saidas').get().n;
  const antes = saidas();
  assert.equal(await scheduler.avisos.entregarAosDeErro('✅ *Amazon voltou a enviar*', 'o aviso do vigia'), 2);
  assert.equal(saidas(), antes + 2, 'cada mensagem conta no teto da hora');
  assert.equal(paraJid(wa, JID).length + paraJid(wa, JID2).length, 2);
});

test('nada do que este arquivo fez imprimiu número ou JID de destino no console', () => {
  for (const linha of saidaConsole) assert.doesNotMatch(linha, VAZAMENTO, linha);
  assert.equal(acessosRede, 0);
});
