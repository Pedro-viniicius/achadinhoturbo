// Proteção do número na fila de envios (plano anti-banimento, etapa 5): src/envios.js com o porteiro src/ritmo.js.
// O ritmo é criado aqui com relógio de parede, relógio monotônico, aleatório e espera de mentira (nada depende da hora
// em que o teste roda nem dorme de verdade); a fila roda sem o agendador (acordar vazio + processarPendentes).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openDb, setSetting } from '../src/db.js';
import { createRitmo } from '../src/ritmo.js';
import { createEnvios, SILENCIO_SO_AGORA } from '../src/envios.js';
import { createLinkService } from '../src/links.js';
import { buildApp } from '../src/server.js';

const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-ritmo-env-')); pastas.push(p); return p; };

const SEG = 1000;
const MIN = 60 * SEG;
const HORA = 60 * MIN;
const TODOS = [0, 1, 2, 3, 4, 5, 6];
const GRUPOS = ['111@g.us', '222@g.us', '333@g.us'];
const PROTECAO = 'Proteção do número';
const PULADO = 'pulado: horário de silêncio.';
/** Hora local de novembro de 2026 (o silêncio usa o relógio do computador). */
const em = (dia, h, mi = 0, s = 0) => new Date(2026, 10, dia, h, mi, s).getTime();

/**
 * Banco com três grupos, ritmo de mentira e a fila. `r.t`: relógio de parede; `r.m`: monotônico; `dormir` anota e
 * avança os dois. O WhatsApp de mentira anota cada envio; `r.demora` (ms) faz cada envio levar esse tempo.
 * `embrulhado`: passa à fila o `wa` já embrulhado (como o agendador faz). `ritmo: false`: a fila sem proteção.
 */
function montar({ ritmoRapido = false, embrulhado = false, comRitmo = true } = {}) {
  const dir = tmp();
  const db = openDb(dir);
  for (const [i, jid] of GRUPOS.entries()) db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, `Grupo ${i + 1}`, 10, 1);
  const r = { t: em(10, 12), m: 1000, sorteio: 0.5, dormidas: [], demora: 0 };
  const ritmo = createRitmo({
    db, fast: ritmoRapido, agora: () => r.t, monotonico: () => r.m, aleatorio: () => r.sorteio,
    dormir: async (ms) => { r.dormidas.push(ms); r.m += ms; r.t += ms; },
  });
  const chamadas = [];
  const anotar = (fn, jid) => { chamadas.push({ fn, jid, t: r.t }); r.t += r.demora; r.m += r.demora; };
  const wa = {
    isReady: () => true,
    async sendText(jid) { anotar('sendText', jid); },
    async sendImage(jid) { anotar('sendImage', jid); },
    async sendPoll(jid) { anotar('sendPoll', jid); },
  };
  const envios = createEnvios({
    db, wa: embrulhado ? ritmo.embrulhar(wa) : wa, links: null, ml: null, dir, acordar: () => {},
    ...(comRitmo ? { ritmo } : {}),
  });
  return { dir, db, r, ritmo, wa, chamadas, envios };
}

/** Linha em `envios` como as que o painel, o espelho e o Grupo vivo gravam. → id */
function gravar(db, { tipo = 'mensagem', payload = { texto: 'Oi, pessoal', imagem: 'nenhuma' }, jids = GRUPOS, quando = 'agora', repetir = null, em: quandoSai, criado = quandoSai }) {
  return Number(db.prepare(`INSERT INTO envios (tipo, payload, group_jids, quando, repetir, status, next_run_at, user_id, created_at)
    VALUES (?,?,?,?,?,'pendente',?,NULL,?)`).run(tipo, JSON.stringify(payload), JSON.stringify(jids), quando,
    repetir ? JSON.stringify(repetir) : null, quandoSai, criado).lastInsertRowid);
}
const envio = (db, id) => ({ ...db.prepare('SELECT status, next_run_at, resultado, payload FROM envios WHERE id = ?').get(id) });
const okDe = (db, id) => db.prepare('SELECT jid FROM envio_resultados WHERE envio_id = ? AND ok = 1 ORDER BY id').all(id).map((x) => x.jid);
const logs = (db) => db.prepare('SELECT rule_name, level, message FROM log ORDER BY id').all().map((x) => ({ ...x }));
const saidas = (db) => Number(db.prepare('SELECT COUNT(*) AS n FROM wa_saidas').get().n);
const ligarSilencio = (db, de = '23:00', ate = '07:00') => {
  setSetting(db, 'wa_silencio_ativo', '1'); setSetting(db, 'wa_silencio_de', de); setSetting(db, 'wa_silencio_ate', ate);
};
const semErroNoLog = (db) => assert.deepEqual(logs(db).filter((l) => l.level === 'erro'), [], 'nenhuma linha `erro` (que vira alerta por WhatsApp)');

// ---------- CA2/CA3: teto cheio ----------

test('CA2/CA3: teto cheio no meio do envio: volta a pendente na mesma ocorrência, sem resultado, e depois sai só para quem faltou', async () => {
  const s = montar();
  setSetting(s.db, 'wa_limite_hora', '2');
  const t0 = s.r.t;
  const id = gravar(s.db, { em: t0 });

  await s.envios.processarPendentes(s.r.t);
  assert.deepEqual(s.chamadas.map((c) => c.jid), GRUPOS.slice(0, 2), 'só cabem 2 na hora');
  let e = envio(s.db, id);
  assert.equal(e.status, 'pendente');
  assert.equal(e.next_run_at, t0, 'mesma ocorrência: a retomada pula quem já recebeu');
  assert.equal(e.resultado, null, 'nenhum resultado gravado na volta à fila');
  const aviso = { rule_name: PROTECAO, level: 'aviso', message: 'Limite de 2 mensagens por hora atingido: o que falta sai a partir das 13:00.' };
  assert.deepEqual(logs(s.db).filter((l) => l.rule_name === PROTECAO), [aviso]);

  // outra passada com o teto cheio: nada sai e nenhuma linha nova (uma por vez que o teto enche)
  await s.envios.processarPendentes(s.r.t);
  assert.equal(s.chamadas.length, 2);
  assert.equal(logs(s.db).filter((l) => l.rule_name === PROTECAO).length, 1);

  // a janela de 60 min liberou: sai só o terceiro, sem repetir os dois primeiros
  s.r.t = em(10, 13, 1);
  await s.envios.processarPendentes(s.r.t);
  assert.deepEqual(s.chamadas.map((c) => c.jid), GRUPOS);
  e = envio(s.db, id);
  assert.equal(e.status, 'concluido');
  assert.deepEqual(JSON.parse(e.resultado), { ok: 3, erro: 0 });
  assert.deepEqual(okDe(s.db, id), GRUPOS);
  assert.equal(s.db.prepare('SELECT COUNT(DISTINCT ocorrencia) AS n FROM envio_resultados WHERE envio_id = ?').get(id).n, 1);
  semErroNoLog(s.db);
});

test('CA2: teto cheio antes de começar: a fila para, o envio nem é preparado e as mensagens de outras origens contam', async () => {
  const s = montar();
  setSetting(s.db, 'wa_limite_hora', '2');
  // duas mensagens de uma regra (ou de um aviso) há 5 min, pelo mesmo porteiro
  s.r.t = em(10, 11, 55); s.ritmo.registrar(); s.ritmo.registrar();
  s.r.t = em(10, 12);
  // foto que não existe: se a fila preparasse o envio, ele viraria erro na hora
  const id = gravar(s.db, { payload: { texto: 'Com foto', imagem: 'upload', upload: `${'a'.repeat(32)}.jpg` }, jids: GRUPOS.slice(0, 1), em: s.r.t });
  const outro = gravar(s.db, { jids: GRUPOS.slice(0, 1), em: s.r.t + 1 });

  await s.envios.processarPendentes(s.r.t + 1);
  assert.deepEqual(s.chamadas, []);
  assert.equal(envio(s.db, id).status, 'pendente');
  assert.equal(envio(s.db, outro).status, 'pendente');
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM envio_resultados').get().n, 0, 'nada tentado');
  assert.deepEqual(logs(s.db), [{ rule_name: PROTECAO, level: 'aviso', message: 'Limite de 2 mensagens por hora atingido: o que falta sai a partir das 12:55.' }]);

  // quem chama runEnvio direto (catálogo, testes) também é segurado antes de preparar, na mesma ocorrência
  assert.deepEqual(await s.envios.runEnvio(id), { ok: 0, erro: 0, adiado: true });
  assert.deepEqual([envio(s.db, id).status, envio(s.db, id).next_run_at, envio(s.db, id).resultado], ['pendente', em(10, 12), null]);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM envio_resultados').get().n, 0, 'nem a foto que falta foi procurada');
  assert.equal(logs(s.db).length, 1, 'o mesmo episódio do teto: nenhuma linha nova');

  // com vaga, a fila volta a andar (e a foto que falta vira o erro de sempre)
  s.r.t = em(10, 12, 56);
  await s.envios.processarPendentes(s.r.t);
  assert.equal(envio(s.db, id).status, 'erro');
  assert.equal(envio(s.db, outro).status, 'concluido');
});

test('CA2: o prazo de 2 h continua valendo para o envio que o teto segurou, com o motivo do teto e nível aviso (R1)', async () => {
  const s = montar();
  setSetting(s.db, 'wa_limite_hora', '1');
  const id = gravar(s.db, { jids: GRUPOS.slice(0, 2), em: s.r.t });
  await s.envios.processarPendentes(s.r.t);
  assert.equal(envio(s.db, id).status, 'pendente');
  s.r.t = em(10, 14, 1);
  await s.envios.processarPendentes(s.r.t);
  assert.equal(envio(s.db, id).status, 'erro');
  assert.equal(JSON.parse(envio(s.db, id).resultado).motivo, 'o limite de 1 mensagens por hora ficou cheio por mais de 2 h.');
  assert.equal(s.chamadas.length, 1);
  assert.ok(logs(s.db).some((l) => l.level === 'aviso' && l.message === 'Não enviado: o limite de 1 mensagens por hora ficou cheio por mais de 2 h.'));
  assert.deepEqual(logs(s.db).filter((l) => l.level === 'erro'), [], 'o teto não é falha: nenhuma linha erro (que alertaria)');
});

// ---------- CA4: toda mensagem conta; a pausa é a do embrulho ----------

test('CA4: texto, foto e enquete da fila contam no teto, uma vez cada (com o wa já embrulhado ou não)', async () => {
  for (const embrulhado of [false, true]) {
    const s = montar({ embrulhado });
    const foto = `${'b'.repeat(32)}.png`;
    fs.mkdirSync(path.join(s.dir, 'uploads'), { recursive: true });
    fs.writeFileSync(path.join(s.dir, 'uploads', foto), Buffer.from('png'));
    gravar(s.db, { em: s.r.t });
    gravar(s.db, { payload: { texto: 'Foto', imagem: 'upload', upload: foto }, jids: GRUPOS.slice(0, 1), em: s.r.t + 1 });
    gravar(s.db, { tipo: 'enquete', payload: { pergunta: 'Qual?', opcoes: ['A', 'B'], multipla: false }, jids: GRUPOS.slice(0, 1), em: s.r.t + 2 });
    await s.envios.processarPendentes(s.r.t + 2);
    assert.deepEqual(s.chamadas.map((c) => c.fn), ['sendText', 'sendText', 'sendText', 'sendImage', 'sendPoll']);
    assert.equal(saidas(s.db), 5, `uma linha em wa_saidas por mensagem (embrulhado: ${embrulhado})`);
  }
});

test('CA4/CA5: com o ritmo, a fila não dorme por conta própria: a pausa entre grupos e entre envios é a do embrulho', async () => {
  const s = montar();
  setSetting(s.db, 'delay_group_s', '6'); // a fila antiga dormiria de verdade 4,2 s ou mais em cada pausa
  gravar(s.db, { jids: GRUPOS.slice(0, 2), em: s.r.t });
  gravar(s.db, { jids: GRUPOS.slice(2), em: s.r.t + 1 });
  const inicio = performance.now();
  await s.envios.processarPendentes(s.r.t + 1);
  assert.ok(performance.now() - inicio < 3000, 'sem sleep real');
  assert.equal(s.chamadas.length, 3);
  assert.deepEqual(s.r.dormidas, [6000, 6000], 'uma pausa (6 s com o sorteio no meio) antes do 2º grupo e antes do envio seguinte');
});

// ---------- CA6: horário de silêncio ----------

test('CA6: no silêncio, o que tem hora marcada é pulado com aviso e o "agora" espera, sem contar o silêncio nas 2 h', async () => {
  const s = montar();
  ligarSilencio(s.db);
  s.r.t = em(10, 23, 30);
  const t = s.r.t;
  const agendado = gravar(s.db, { quando: 'agendado', em: t });
  const repetido = gravar(s.db, { quando: 'repetir', repetir: { dias: TODOS, horarios: ['12:00', '23:30'] }, em: t });
  const rotina = gravar(s.db, { payload: { texto: 'Bom dia!', imagem: 'nenhuma', origem: { tipo: 'rotina', rotina_id: 1, nome: 'Bom dia' } }, em: t });
  const agora = gravar(s.db, { jids: GRUPOS.slice(0, 1), em: t });
  const espelho = gravar(s.db, { payload: { texto: 'Oferta', imagem: 'nenhuma', origem: { tipo: 'espelho', espelho_id: 1, nome: 'Amazon' } }, jids: GRUPOS.slice(1, 2), em: t });

  await s.envios.processarPendentes(t);
  assert.deepEqual(s.chamadas, [], 'nada sai para grupo no silêncio');
  assert.equal(envio(s.db, agendado).status, 'erro');
  assert.deepEqual(JSON.parse(envio(s.db, agendado).resultado), { ok: 0, erro: 0, motivo: PULADO });
  assert.equal(envio(s.db, repetido).status, 'pendente');
  assert.equal(envio(s.db, repetido).next_run_at, em(11, 12), 'o repetido segue para a próxima ocorrência');
  assert.equal(envio(s.db, rotina).status, 'erro', 'o Grupo vivo tem horário: é pulado');
  for (const id of [agora, espelho]) assert.deepEqual([envio(s.db, id).status, envio(s.db, id).next_run_at], ['pendente', t], 'o "agora" espera');
  const linha = 'Horário de 23:30 pulado: horário de silêncio.';
  assert.deepEqual(logs(s.db), [
    { rule_name: 'Mensagem', level: 'aviso', message: linha },
    { rule_name: 'Mensagem', level: 'aviso', message: linha },
    { rule_name: 'Grupo vivo: Bom dia', level: 'aviso', message: linha },
    { rule_name: PROTECAO, level: 'aviso', message: 'Horário de silêncio (23:00 às 07:00): a fila espera até as 07:00.' },
  ]);

  // outras passadas no mesmo silêncio: nenhuma linha nova
  s.r.t = em(11, 3);
  await s.envios.processarPendentes(s.r.t);
  assert.equal(logs(s.db).length, 4);

  // 07:05: 7 h 35 depois de criado, mas só 5 min fora do silêncio: sai
  s.r.t = em(11, 7, 5);
  await s.envios.processarPendentes(s.r.t);
  assert.deepEqual(s.chamadas.map((c) => c.jid), [GRUPOS[0], GRUPOS[1]]);
  assert.equal(envio(s.db, agora).status, 'concluido');
  assert.equal(envio(s.db, espelho).status, 'concluido');
  semErroNoLog(s.db);
});

test('CA6: o "agora" parado há mais de 2 h fora do silêncio ainda perde o horário', async () => {
  const s = montar();
  ligarSilencio(s.db);
  s.r.t = em(10, 23, 30);
  const velho = gravar(s.db, { jids: GRUPOS.slice(0, 1), em: em(8, 12) });
  await s.envios.processarPendentes(s.r.t);
  assert.equal(envio(s.db, velho).status, 'erro');
  assert.match(JSON.parse(envio(s.db, velho).resultado).motivo, /passou mais de 2 h/);
});

test('CA6: o silêncio que começa no meio de um envio segura o resto; o marcado é pulado depois, sem repetir ninguém', async () => {
  for (const quando of ['agendado', 'agora']) {
    const s = montar({ ritmoRapido: true });
    ligarSilencio(s.db);
    s.r.demora = 10 * SEG; // cada envio leva 10 s: o 2º termina às 23:00:05
    s.r.t = em(10, 22, 59, 45);
    const id = gravar(s.db, { quando, em: s.r.t });
    await s.envios.processarPendentes(s.r.t);
    assert.deepEqual(okDe(s.db, id), GRUPOS.slice(0, 2), quando);
    assert.deepEqual([envio(s.db, id).status, envio(s.db, id).resultado], ['pendente', null], quando);

    await s.envios.processarPendentes(s.r.t);
    if (quando === 'agendado') {
      assert.equal(envio(s.db, id).status, 'erro');
      assert.deepEqual(JSON.parse(envio(s.db, id).resultado), { ok: 2, erro: 0, motivo: PULADO }, 'conta quem já tinha recebido');
    } else {
      s.r.t = em(11, 7, 1);
      await s.envios.processarPendentes(s.r.t);
      assert.equal(envio(s.db, id).status, 'concluido');
      assert.deepEqual(okDe(s.db, id), GRUPOS);
    }
    assert.equal(s.chamadas.length, quando === 'agendado' ? 2 : 3, 'nenhum grupo recebe duas vezes');
    semErroNoLog(s.db);
  }
});

test('CA6: sem o ritmo (testes e módulos antigos), a fila não tem teto nem silêncio', async () => {
  const s = montar({ comRitmo: false });
  ligarSilencio(s.db);
  setSetting(s.db, 'wa_limite_hora', '1');
  s.r.t = em(10, 23, 30);
  const id = gravar(s.db, { quando: 'agendado', jids: GRUPOS.slice(0, 2), em: Date.now() - 1000 });
  await s.envios.processarPendentes();
  assert.equal(envio(s.db, id).status, 'concluido');
  assert.equal(s.chamadas.length, 2);
});

// ---------- CA7: "Enviar mesmo assim" ----------

test('CA7: com ignorar_silencio, o "agora" do painel sai no silêncio, mas nunca passa do teto', async () => {
  const s = montar();
  ligarSilencio(s.db);
  setSetting(s.db, 'wa_limite_hora', '1');
  s.r.t = em(10, 23, 30);
  const id = gravar(s.db, { payload: { texto: 'Urgente', imagem: 'nenhuma', ignorar_silencio: true }, jids: GRUPOS.slice(0, 2), em: s.r.t });
  await s.envios.processarPendentes(s.r.t);
  assert.deepEqual(s.chamadas.map((c) => c.jid), GRUPOS.slice(0, 1));
  assert.equal(envio(s.db, id).status, 'pendente', 'o 2º grupo espera a vaga');
  assert.deepEqual(logs(s.db).filter((l) => l.rule_name === PROTECAO).map((l) => l.message), ['Limite de 1 mensagens por hora atingido: o que falta sai a partir das 00:30.']);
});

test('CA7: ignorar_silencio gravado fora do "agora" do painel (agendado, espelho, Grupo vivo) não vale', async () => {
  const s = montar();
  ligarSilencio(s.db);
  s.r.t = em(10, 23, 30);
  const agendado = gravar(s.db, { quando: 'agendado', payload: { texto: 'x', imagem: 'nenhuma', ignorar_silencio: true }, em: s.r.t });
  const espelho = gravar(s.db, { payload: { texto: 'x', imagem: 'nenhuma', ignorar_silencio: true, origem: { tipo: 'espelho', nome: 'E' } }, em: s.r.t });
  const rotina = gravar(s.db, { payload: { texto: 'x', imagem: 'nenhuma', ignorar_silencio: true, origem: { tipo: 'rotina', nome: 'R' } }, em: s.r.t });
  const texto = gravar(s.db, { payload: { texto: 'x', imagem: 'nenhuma', ignorar_silencio: 'true' }, em: s.r.t });
  await s.envios.processarPendentes(s.r.t);
  assert.deepEqual(s.chamadas, []);
  assert.deepEqual([agendado, espelho, rotina, texto].map((id) => envio(s.db, id).status), ['erro', 'pendente', 'erro', 'pendente']);
});

test('CA7/P5: criar aceita ignorar_silencio só com "agora" (senão, erro claro) e grava no payload só o true', async (t) => {
  // relógio fixo ao meio-dia: o agendado sem data é "hoje às HH:MM", então "daqui a 2 h" não pode atravessar a meia-noite
  // (depois das 22h o teste dependia da hora do dia e a rota respondia "Esse horário já passou")
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 11, 12, 0, 0).getTime() });
  const s = montar();
  const base = { tipo: 'mensagem', texto: 'Oi', group_jids: [GRUPOS[0]] };
  const futuro = new Date(Date.now() + 2 * HORA);
  const hhmm = `${String(futuro.getHours()).padStart(2, '0')}:${String(futuro.getMinutes()).padStart(2, '0')}`;
  for (const corpo of [
    { ...base, quando: 'agendado', agendar_hhmm: hhmm, ignorar_silencio: true },
    { ...base, quando: 'repetir', repetir: { dias: TODOS, horarios: ['10:00'] }, ignorar_silencio: true },
    { tipo: 'oferta', url: 'https://produto.mercadolivre.com.br/MLB-1', group_jids: [GRUPOS[0]], quando: 'agendado', agendar_hhmm: hhmm, ignorar_silencio: true },
  ]) {
    await assert.rejects(s.envios.criar(corpo), { message: SILENCIO_SO_AGORA }, corpo.quando);
  }
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM envios').get().n, 0, 'nada gravado');
  assert.match(SILENCIO_SO_AGORA, /"agora"/);

  const sim = await s.envios.criar({ ...base, quando: 'agora', ignorar_silencio: true });
  assert.deepEqual(JSON.parse(envio(s.db, sim.id).payload), { texto: 'Oi', imagem: 'nenhuma', ignorar_silencio: true });
  for (const valor of [undefined, false, 'true', 1]) {
    const r = await s.envios.criar({ ...base, quando: 'agora', ignorar_silencio: valor });
    assert.deepEqual(JSON.parse(envio(s.db, r.id).payload), { texto: 'Oi', imagem: 'nenhuma' }, String(valor));
  }
  // agendado sem o campo (ou com false) segue aceito
  const ag = await s.envios.criar({ ...base, quando: 'agendado', agendar_hhmm: hhmm, ignorar_silencio: false });
  assert.equal(envio(s.db, ag.id).status, 'pendente');
});

test('CA7/P5: POST /api/envios com ignorar_silencio fora do "agora" responde 400 com a frase', async () => {
  const s = montar();
  const links = createLinkService({ getMode: () => 'fake' });
  const app = buildApp({ db: s.db, wa: s.wa, links, scheduler: { envios: s.envios, ritmo: s.ritmo, wa: s.ritmo.embrulhar(s.wa) }, publicHost: '', panelPassword: '', dataDir: s.dir });
  const server = await new Promise((ok) => { const x = app.listen(0, '127.0.0.1', () => ok(x)); });
  const { port } = server.address();
  const post = (body) => new Promise((ok, err) => {
    const data = Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port, path: '/api/envios', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length, origin: `http://127.0.0.1:${port}` } }, (res) => {
      const partes = []; res.on('data', (c) => partes.push(c));
      res.on('end', () => ok({ status: res.statusCode, json: JSON.parse(Buffer.concat(partes).toString('utf8')) }));
    });
    r.on('error', err); r.end(data);
  });
  try {
    const recusado = await post({ tipo: 'mensagem', texto: 'Oi', group_jids: [GRUPOS[0]], quando: 'repetir', repetir: { dias: TODOS, horarios: ['10:00'] }, ignorar_silencio: true });
    assert.equal(recusado.status, 400);
    assert.deepEqual(recusado.json, { erro: SILENCIO_SO_AGORA });
    const aceito = await post({ tipo: 'mensagem', texto: 'Oi', group_jids: [GRUPOS[0]], quando: 'agora', ignorar_silencio: true });
    assert.equal(aceito.status, 200);
    assert.equal(JSON.parse(envio(s.db, aceito.json.id).payload).ignorar_silencio, true);
  } finally {
    await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  }
});

test('CA7/P5: em src/, só a fila de envios conhece ignorar_silencio (espelho, remetente, catálogo e rotina nunca gravam o campo)', () => {
  const pasta = path.join(import.meta.dirname, '..', 'src');
  const com = fs.readdirSync(pasta).filter((f) => f.endsWith('.js') && fs.readFileSync(path.join(pasta, f), 'utf8').includes('ignorar_silencio'));
  assert.deepEqual(com, ['envios.js']);
});
