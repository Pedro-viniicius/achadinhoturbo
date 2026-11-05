// Envio pelo sócio (plano envio-pelo-socio, etapa 6; CA1, CA9, CA11): cadastro, lista, histórico e rotas de
// src/remetentes.js. As rotas são montadas num Express mínimo (a ligação ao server.js é a etapa 9), com o soDono real de
// src/auth.js e o papel vindo do cabeçalho x-papel. O WhatsApp é o de verdade com um socket falso (onWhatsApp e o mapa
// LID do Baileys), para o número passar por resolverNumero, meuJid e lidDe como no serviço. A fila de envios é falsa:
// só situacaoLink, que diz se a afiliação de uma loja está bloqueada agora. Toda resposta HTTP é guardada e o último
// teste de cada servidor confere que nenhuma traz o número digitado, o JID ou o LID (CA9).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { openDb } from '../src/db.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { soDono } from '../src/auth.js';
import { createRemetentes, montarRotas } from '../src/remetentes.js';

const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-remcad-')); pastas.push(p); return p; };

const HORA = 3600000;
const DIA = 24 * HORA;
const NUMERO = '5535988776655';
const PN = `${NUMERO}@s.whatsapp.net`;
const LID = '207654321098765@lid';
const LID2 = '209999999999999@lid';
const NUMERO2 = '5511988887777';
const PN2 = `${NUMERO2}@s.whatsapp.net`;
const MEU = '5535912345678';           // o número conectado ao painel
const MEU_JID = `${MEU}@s.whatsapp.net`;
const DIGITADO = '(35) 98877-6655';
const MASCARADO = '+55 35 •••••-6655';
const DEST1 = '200@g.us';
const DEST2 = '300@g.us';
const DEST3 = '400@g.us';
const GRUPOS = [[DEST1, 'Achadinhos Tech'], [DEST2, 'Tech Dois'], [DEST3, 'Casa e Cozinha']];
const NOME = 'Sócio Pedro';

const MSG = {
  numero: 'Informe o número com DDD. Exemplo: (35) 99999-1234.',
  foraDoWhats: 'Este número não está no WhatsApp.',
  conectado: 'Este é o número conectado ao painel. Cadastre o número de quem vai mandar os links.',
  semConferir: 'Não consegui conferir o número no WhatsApp. Confira se ele está conectado em Números de WhatsApp.',
  naoEncontrado: 'Remetente não encontrado.',
  soDono: 'Só o Dono pode fazer isso.',
};

const CHAVES_LISTA = ['id', 'nome', 'numero', 'enabled', 'destino_jids', 'destinos_nomes', 'template_id', 'template_nome', 'tag_id',
  'etiqueta_nome', 'enviar_foto', 'max_por_hora', 'dedupe_horas', 'responder', 'problema', 'contadores_24h', 'ultimo_em'].sort();
const CHAVES_ITEM = ['id', 'remetente_id', 'remetente_nome', 'ts', 'loja', 'status', 'codigo', 'motivo', 'fonte_dados', 'oferta',
  'destinos', 'decidido_em'].sort();

/**
 * Banco com 3 grupos, 2 templates (um sem {LINK}) e 2 etiquetas; WhatsApp "real" com socket falso; o módulo com relógio
 * próprio. `estado.existe(digitos)` diz se o número está no WhatsApp; `estado.canonico` troca o JID devolvido (9º dígito).
 */
function montar() {
  const dir = tmp();
  const db = openDb(dir);
  for (const [jid, nome] of GRUPOS) db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, nome, 10, Date.now());
  db.prepare('DELETE FROM templates').run(); // os do openDb dão lugar a 2 conhecidos
  db.prepare("INSERT INTO templates (id, name, body, created_at) VALUES (1, 'Padrão', '{TITULO} {LINK}', 1), (2, 'Sem link', 'Só {TITULO}', 1)").run();
  db.prepare("INSERT INTO tags (id, name, created_at) VALUES (1, 'etiquetaA', 1), (2, 'etiquetaB', 1)").run();
  const estado = { existe: () => true, canonico: {}, lid: LID, lidFalha: false, consultaFalha: false };
  const consultas = []; const pedidosLid = [];
  const wa = createWhatsApp({ db, dir });
  wa._usarSocket({
    user: { id: `${MEU}:7@s.whatsapp.net` },
    onWhatsApp: async (...nums) => {
      consultas.push(nums);
      if (estado.consultaFalha) throw new Error(`timeout consultando ${nums[0]}`);
      const d = nums[0];
      return estado.existe(d) ? [{ jid: `${estado.canonico[d] ?? d}@s.whatsapp.net`, exists: true }] : [];
    },
    signalRepository: { lidMapping: { getLIDForPN: async (pn) => { pedidosLid.push(pn); if (estado.lidFalha) throw new Error(`sem mapa ${pn}`); return estado.lid; } } },
  });
  const situacao = {};
  const envios = { situacaoLink: (loja, { tag_id: tagId } = {}) => (typeof situacao[loja] === 'function' ? situacao[loja](tagId) : situacao[loja] ?? null) };
  const relogio = { t: Date.now() };
  const rem = createRemetentes({ db, wa, envios, agora: () => relogio.t });
  let seq = 0;
  return {
    db, wa, estado, consultas, pedidosLid, situacao, relogio, rem,
    corpo: (extra = {}) => ({ nome: NOME, numero: DIGITADO, destino_jids: [DEST1, DEST2], template_id: 1, tag_id: null, enviar_foto: true,
      max_por_hora: 10, dedupe_horas: 24, responder: true, enabled: true, ...extra }),
    remetente: (id) => { const r = db.prepare('SELECT * FROM remetentes WHERE id = ?').get(id); return r ? { ...r } : null; },
    /** Item gravado direto (o ciclo é da etapa 5). → id */
    item(remetenteId, extra = {}) {
      const r = { remetente_nome: NOME, msg_id: `M${++seq}`, ts: relogio.t, url: `https://x.test/${seq}`, loja: 'mercadolivre', status: 'enviado',
        codigo: null, motivo: null, chave: null, oferta: null, fonte_dados: null, envio_id: null, decidido_em: relogio.t, complemento: null, ...extra };
      return Number(db.prepare(`INSERT INTO remetente_itens (remetente_id, remetente_nome, msg_id, ts, url, loja, complemento, status, codigo, motivo,
        chave, oferta, fonte_dados, envio_id, decidido_em) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(remetenteId, r.remetente_nome, r.msg_id, r.ts, r.url, r.loja, r.complemento, r.status, r.codigo, r.motivo, r.chave, r.oferta,
          r.fonte_dados, r.envio_id, r.decidido_em).lastInsertRowid);
    },
    envio(jids, status = 'concluido', resultado = null) {
      return Number(db.prepare("INSERT INTO envios (tipo, payload, group_jids, status, resultado, created_at) VALUES ('oferta', '{}', ?, ?, ?, 1)")
        .run(JSON.stringify(jids), status, resultado).lastInsertRowid);
    },
    resultado(envioId, jid, ok, { nome = null, erro = null } = {}) {
      db.prepare('INSERT INTO envio_resultados (envio_id, ocorrencia, ts, jid, group_name, ok, erro) VALUES (?,1,?,?,?,?,?)')
        .run(envioId, relogio.t, jid, nome, ok ? 1 : 0, erro);
    },
  };
}

function req(port, caminho, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((ok, err) => {
    const data = body != null ? Buffer.from(JSON.stringify(body)) : null;
    const h = { ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers };
    const r = http.request({ host: '127.0.0.1', port, path: caminho, method, headers: h }, (res) => {
      const partes = []; res.on('data', (c) => partes.push(c));
      res.on('end', () => { const txt = Buffer.concat(partes).toString('utf8'); let json = null; try { json = JSON.parse(txt); } catch { /* */ } ok({ status: res.statusCode, json, txt }); });
    });
    r.on('error', err); if (data) r.write(data); r.end();
  });
}

/** Express mínimo: o papel vem do cabeçalho x-papel; soDono é o de src/auth.js. Guarda o texto de toda resposta. */
async function subir(s, { comSoDono = true, servico = 'ctx' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((rq, _rs, next) => { const p = rq.headers['x-papel']; rq.user = p ? { id: p === 'dono' ? 1 : 2, papel: p } : null; next(); });
  const ctx = { db: s.db, wa: s.wa, ...(comSoDono ? { soDono: soDono({ enabled: () => true }) } : {}) };
  if (servico === 'ctx') ctx.remetentes = s.rem;
  if (servico === 'scheduler') ctx.scheduler = { remetentes: s.rem };
  montarRotas(app, ctx);
  const server = await new Promise((ok) => { const x = app.listen(0, '127.0.0.1', () => ok(x)); });
  const { port } = server.address();
  const respostas = [];
  return {
    respostas,
    async pedir(caminho, papel = 'dono', o = {}) {
      const r = await req(port, caminho, { ...o, headers: { ...(papel ? { 'x-papel': papel } : {}) } });
      respostas.push(r.txt);
      return r;
    },
    fechar: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

/** CA9: nenhuma resposta traz o número (cheio, sem o 55, com máscara de digitação), o JID nem o LID. */
function semNumeroNasRespostas(respostas, numeros = [NUMERO], lids = [LID, LID2]) {
  const tudo = respostas.join('\n');
  for (const n of numeros) {
    for (const pedaco of [n, n.slice(2), n.slice(4), `${n}@s.whatsapp.net`, `${n.slice(4, 9)}-${n.slice(9)}`]) {
      assert.ok(!tudo.includes(pedaco), `resposta com o número (${pedaco})`);
    }
  }
  for (const l of lids) { assert.ok(!tudo.includes(l) && !tudo.includes(l.split('@')[0]), 'resposta com o LID'); }
  assert.doesNotMatch(tudo, /"(jid|lid|url|complemento)"/, 'resposta com campo que não sai do servidor');
}

const capturarConsole = (t) => ['error', 'warn', 'log', 'info'].map((m) => t.mock.method(console, m, () => {}));
const textoDoConsole = (espias) => espias.flatMap((e) => e.mock.calls.map((c) => c.arguments.map(String).join(' '))).join('\n');

// ------------------------------------------------------------------------------------------------ CA1

test('CA1: o Dono cadastra; o número é conferido no WhatsApp, o LID é pedido e a resposta é só { id }', async () => {
  const s = montar();
  const h = await subir(s);
  try {
    const r = await h.pedir('/api/remetentes', 'dono', { method: 'POST', body: s.corpo({ tag_id: 2, enviar_foto: false, max_por_hora: 60, dedupe_horas: 0, responder: false }) });
    assert.equal(r.status, 200, r.txt);
    assert.deepEqual(Object.keys(r.json), ['id']);
    const row = s.remetente(r.json.id);
    assert.equal(row.jid, PN);
    assert.equal(row.lid, LID);
    assert.deepEqual([row.nome, JSON.parse(row.destino_jids), row.template_id, row.tag_id, row.enviar_foto, row.max_por_hora, row.dedupe_horas, row.responder, row.enabled],
      [NOME, [DEST1, DEST2], 1, 2, 0, 60, 0, 0, 1]);
    assert.ok(row.created_at > 0 && row.updated_at > 0);
    assert.deepEqual(s.consultas, [[NUMERO]], 'uma consulta, com o 55 e só dígitos');
    assert.deepEqual(s.pedidosLid, [PN], 'lidDe recebe o JID já conferido');

    // os formatos aceitos para o mesmo tipo de número: com 55, com +, com espaços; fixo de 10 dígitos
    const formatos = [['+55 (11) 98888-7777', `${NUMERO2}`], ['551133334444', '551133334444'], ['21 3333-4444', '552133334444'], ['55 55 99999-0000', '5555999990000']];
    for (const [i, [numero, digitos]] of formatos.entries()) {
      s.estado.lid = null;
      const ok = await h.pedir('/api/remetentes', 'dono', { method: 'POST', body: s.corpo({ nome: `Outro ${i}`, numero }) });
      assert.equal(ok.status, 200, `${numero}: ${ok.txt}`);
      assert.equal(s.remetente(ok.json.id).jid, `${digitos}@s.whatsapp.net`, numero);
      assert.equal(s.remetente(ok.json.id).lid, null, 'sem mapa: o LID fica para a primeira mensagem');
    }
    // padrões: foto, responder e ligado; 10 por hora; 24 h sem repetir; etiqueta padrão (null)
    s.estado.lid = null;
    const minimo = await h.pedir('/api/remetentes', 'dono', { method: 'POST', body: { nome: 'Mínimo', numero: '35 98888-1111', destino_jids: [DEST3], template_id: '1' } });
    assert.equal(minimo.status, 200, minimo.txt);
    const m = s.remetente(minimo.json.id);
    assert.deepEqual([m.tag_id, m.enviar_foto, m.max_por_hora, m.dedupe_horas, m.responder, m.enabled, m.template_id], [null, 1, 10, 24, 1, 1, 1]);
    semNumeroNasRespostas(h.respostas);
  } finally { await h.fechar(); }
});

test('CA1: cada validação recusa com 400 e frase fixa, antes de consultar o WhatsApp', async () => {
  const s = montar();
  const h = await subir(s);
  const muitos = Array.from({ length: 501 }, (_, i) => `${1000 + i}@g.us`);
  const casos = [
    [{ nome: '' }, 'Dê um nome ao remetente.'],
    [{ nome: '   ' }, 'Dê um nome ao remetente.'],
    [{ nome: undefined }, 'Dê um nome ao remetente.'],
    [{ nome: 'x'.repeat(61) }, 'O nome pode ter até 60 letras.'],
    [{ nome: 'Pedro 123456' }, 'Não ponha o número no nome (ele aparece no Histórico): use até 5 algarismos.'],
    [{ numero: '' }, MSG.numero],
    [{ numero: undefined }, MSG.numero],
    [{ numero: 35999991234 }, MSG.numero],
    [{ numero: '123' }, MSG.numero],
    [{ numero: '35 89999-1234' }, MSG.numero],          // 11 dígitos sem o 9 na 3ª posição
    [{ numero: '10 99999-1234' }, MSG.numero],          // DDD abaixo de 11
    [{ numero: '05 3333-4444' }, MSG.numero],
    [{ numero: '+1 415 555 2671' }, MSG.numero],
    [{ numero: '035 99999-1234' }, MSG.numero],         // 12 dígitos que não começam com 55
    [{ numero: '55 35 99999-12345' }, MSG.numero],
    [{ numero: '9'.repeat(50) }, MSG.numero],
    [{ destino_jids: [] }, 'Marque ao menos um grupo de destino.'],
    [{ destino_jids: undefined }, 'Marque ao menos um grupo de destino.'],
    [{ destino_jids: DEST1 }, 'Marque ao menos um grupo de destino.'],
    [{ destino_jids: [DEST1, 7] }, 'Lista de grupos inválida.'],
    [{ destino_jids: muitos }, 'Marque no máximo 500 grupos de destino.'],
    [{ destino_jids: [DEST1, '999@g.us'] }, 'Algum grupo de destino não existe mais. Atualize a lista e escolha de novo.'],
    [{ template_id: null }, 'Escolha um template.'],
    [{ template_id: 99 }, 'Escolha um template.'],
    [{ template_id: 'abc' }, 'Escolha um template.'],
    [{ template_id: 2 }, 'O template precisa do campo {LINK}.'],
    [{ tag_id: 99 }, 'A etiqueta escolhida não existe mais. Escolha outra.'],
    [{ tag_id: 'x' }, 'A etiqueta escolhida não existe mais. Escolha outra.'],
    [{ max_por_hora: 0 }, 'Links por hora: use um número de 1 a 60.'],
    [{ max_por_hora: 61 }, 'Links por hora: use um número de 1 a 60.'],
    [{ max_por_hora: 1.5 }, 'Links por hora: use um número de 1 a 60.'],
    [{ dedupe_horas: -1 }, 'Horas sem repetir: use de 0 a 8760.'],
    [{ dedupe_horas: 8761 }, 'Horas sem repetir: use de 0 a 8760.'],
    [{ enabled: 'sim' }, 'Ativo: ligue ou desligue.'],
    [{ enviar_foto: 1 }, 'Enviar a foto: ligue ou desligue.'],
    [{ responder: 'true' }, 'Responder ao remetente: ligue ou desligue.'],
  ];
  try {
    for (const [extra, erro] of casos) {
      const r = await h.pedir('/api/remetentes', 'dono', { method: 'POST', body: s.corpo(extra) });
      assert.deepEqual([r.status, r.json], [400, { erro }], JSON.stringify(extra).slice(0, 80));
    }
    const semCorpo = await h.pedir('/api/remetentes', 'dono', { method: 'POST' });
    assert.deepEqual([semCorpo.status, semCorpo.json], [400, { erro: 'Dê um nome ao remetente.' }]);
    assert.deepEqual(s.consultas, [], 'nenhuma validação consultou o WhatsApp');
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM remetentes').get().n, 0);
    // 5 algarismos no nome passam; os limites exatos passam
    const ok = await h.pedir('/api/remetentes', 'dono', { method: 'POST', body: s.corpo({ nome: 'Loja 12345', max_por_hora: 1, dedupe_horas: 8760, destino_jids: [DEST1, DEST1] }) });
    assert.equal(ok.status, 200, ok.txt);
    assert.deepEqual(JSON.parse(s.remetente(ok.json.id).destino_jids), [DEST1], 'grupo repetido entra uma vez');
    semNumeroNasRespostas(h.respostas);
  } finally { await h.fechar(); }
});

test('CA1: número fora do WhatsApp, WhatsApp fora do ar, número conectado e número duplicado são recusados sem repetir o número', async (t) => {
  const espias = capturarConsole(t);
  const s = montar();
  const h = await subir(s);
  const post = (extra) => h.pedir('/api/remetentes', 'dono', { method: 'POST', body: s.corpo(extra) });
  try {
    s.estado.existe = () => false;
    assert.deepEqual(await post({}).then((r) => [r.status, r.json]), [400, { erro: MSG.foraDoWhats }]);
    s.estado.existe = () => true;

    s.estado.consultaFalha = true;
    assert.deepEqual(await post({}).then((r) => [r.status, r.json]), [400, { erro: MSG.semConferir }]);
    s.estado.consultaFalha = false;

    // o conectado digitado: recusado antes de consultar
    const antes = s.consultas.length;
    assert.deepEqual(await post({ numero: '(35) 91234-5678' }).then((r) => [r.status, r.json]), [400, { erro: MSG.conectado }]);
    assert.equal(s.consultas.length, antes, 'o próprio número não gasta consulta');
    // o conectado pelo JID canônico (o WhatsApp acertou o 9º dígito)
    s.estado.canonico['553512345678'] = MEU;
    assert.deepEqual(await post({ numero: '35 1234-5678' }).then((r) => [r.status, r.json]), [400, { erro: MSG.conectado }]);
    assert.equal(s.consultas.length, antes + 1);

    const ok = await post({});
    assert.equal(ok.status, 200, ok.txt);
    const pedidos = s.pedidosLid.length;
    const dup = await post({ nome: 'Outro nome', numero: '+55 35 98877-6655' });
    assert.deepEqual([dup.status, dup.json], [409, { erro: `Este número já está cadastrado como ${NOME}.` }]);
    // duplicado pelo JID canônico (número digitado sem o 9)
    s.estado.canonico['553588776655'] = NUMERO;
    const dup2 = await post({ nome: 'Outro nome', numero: '35 8877-6655' });
    assert.deepEqual([dup2.status, dup2.json], [409, { erro: `Este número já está cadastrado como ${NOME}.` }]);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM remetentes').get().n, 1);
    assert.equal(s.pedidosLid.length, pedidos, 'duplicado é recusado antes de pedir o LID');

    semNumeroNasRespostas(h.respostas, [NUMERO, MEU]);
    assert.ok(!textoDoConsole(espias).includes('98877'), 'o console não leva o número');
  } finally { await h.fechar(); }
});

test('CA1: lidDe é esforço: falha ou LID de outro remetente deixam o LID vazio e o cadastro passa', async (t) => {
  const espias = capturarConsole(t);
  const s = montar();
  const h = await subir(s);
  try {
    const a = await h.pedir('/api/remetentes', 'dono', { method: 'POST', body: s.corpo() });
    assert.equal(s.remetente(a.json.id).lid, LID);
    // o mapa devolve o mesmo LID para outro número: não rouba o LID (UNIQUE) nem falha
    const b = await h.pedir('/api/remetentes', 'dono', { method: 'POST', body: s.corpo({ nome: 'Segundo', numero: '11 98888-7777' }) });
    assert.equal(b.status, 200, b.txt);
    assert.equal(s.remetente(b.json.id).lid, null);
    assert.equal(s.remetente(a.json.id).lid, LID);
    // o mapa lança (com o número na mensagem)
    s.estado.lidFalha = true;
    const c = await h.pedir('/api/remetentes', 'dono', { method: 'POST', body: s.corpo({ nome: 'Terceiro', numero: '21 97777-6666' }) });
    assert.equal(c.status, 200, c.txt);
    assert.equal(s.remetente(c.json.id).lid, null);
    assert.equal(textoDoConsole(espias), '', 'nada no console');
    semNumeroNasRespostas(h.respostas, [NUMERO, NUMERO2, '5521977776666']);
  } finally { await h.fechar(); }
});

test('CA1: PUT com número vazio mantém o número sem consultar; trocar o número troca o JID e esquece o LID antigo', async () => {
  const s = montar();
  const h = await subir(s);
  try {
    const { json: { id } } = await h.pedir('/api/remetentes', 'dono', { method: 'POST', body: s.corpo() });
    const consultas = s.consultas.length; const pedidos = s.pedidosLid.length;

    const r = await h.pedir(`/api/remetentes/${id}`, 'dono', { method: 'PUT', body: s.corpo({ nome: 'Pedro Novo', numero: '', destino_jids: [DEST3], max_por_hora: 5 }) });
    assert.deepEqual([r.status, r.json], [200, { id }]);
    let row = s.remetente(id);
    assert.deepEqual([row.nome, row.jid, row.lid, JSON.parse(row.destino_jids), row.max_por_hora], ['Pedro Novo', PN, LID, [DEST3], 5]);
    assert.equal(s.consultas.length, consultas, 'número vazio não consulta');
    assert.equal(s.pedidosLid.length, pedidos, 'com o LID já guardado, não pede de novo');

    // campo ausente mantém o atual (o número também)
    const parcial = await h.pedir(`/api/remetentes/${id}`, 'dono', { method: 'PUT', body: { enabled: false } });
    assert.equal(parcial.status, 200, parcial.txt);
    row = s.remetente(id);
    assert.deepEqual([row.nome, row.jid, row.enabled, row.max_por_hora, row.template_id], ['Pedro Novo', PN, 0, 5, 1]);

    // sem LID guardado, salvar pede o LID de novo (risco do plano)
    s.db.prepare('UPDATE remetentes SET lid = NULL WHERE id = ?').run(id);
    await h.pedir(`/api/remetentes/${id}`, 'dono', { method: 'PUT', body: { numero: '' } });
    assert.equal(s.remetente(id).lid, LID);
    assert.deepEqual(s.pedidosLid.slice(pedidos), [PN]);
    assert.equal(s.consultas.length, consultas);

    // troca de número: novo JID; o LID do número antigo nunca fica (o mapa não conhece o novo)
    s.estado.lid = null;
    const troca = await h.pedir(`/api/remetentes/${id}`, 'dono', { method: 'PUT', body: { numero: '11 98888-7777' } });
    assert.equal(troca.status, 200, troca.txt);
    row = s.remetente(id);
    assert.deepEqual([row.jid, row.lid], [PN2, null]);
    // o mesmo número de novo: o próprio cadastro não conta como duplicado
    s.estado.lid = LID2;
    const mesmo = await h.pedir(`/api/remetentes/${id}`, 'dono', { method: 'PUT', body: { numero: '+55 11 98888-7777' } });
    assert.equal(mesmo.status, 200, mesmo.txt);
    assert.deepEqual([s.remetente(id).jid, s.remetente(id).lid], [PN2, LID2]);

    // validação no PUT e 404
    const ruim = await h.pedir(`/api/remetentes/${id}`, 'dono', { method: 'PUT', body: { template_id: 2 } });
    assert.deepEqual([ruim.status, ruim.json], [400, { erro: 'O template precisa do campo {LINK}.' }]);
    for (const alvo of ['999', 'abc', '0', '-1', '1.5']) {
      const nao = await h.pedir(`/api/remetentes/${alvo}`, 'dono', { method: 'PUT', body: s.corpo({ numero: '' }) });
      assert.deepEqual([nao.status, nao.json], [404, { erro: MSG.naoEncontrado }], alvo);
    }
    // duplicado no PUT
    const { json: outro } = await h.pedir('/api/remetentes', 'dono', { method: 'POST', body: s.corpo({ nome: 'Outro', numero: DIGITADO }) });
    assert.equal(s.remetente(outro.id).lid, null, 'o LID2 já é do primeiro');
    // o PUT pede o LID de novo e o mapa devolve o LID de outro remetente: não rouba nem falha
    const rouba = await h.pedir(`/api/remetentes/${outro.id}`, 'dono', { method: 'PUT', body: { numero: '' } });
    assert.equal(rouba.status, 200, rouba.txt);
    assert.deepEqual([s.remetente(outro.id).lid, s.remetente(id).lid], [null, LID2]);
    const dup = await h.pedir(`/api/remetentes/${outro.id}`, 'dono', { method: 'PUT', body: { numero: '11 98888-7777' } });
    assert.deepEqual([dup.status, dup.json], [409, { erro: 'Este número já está cadastrado como Pedro Novo.' }]);
    semNumeroNasRespostas(h.respostas, [NUMERO, NUMERO2]);
  } finally { await h.fechar(); }
});

// ------------------------------------------------------------------------------------------------ autorização e freio

test('autorização: o Operador vê a lista e o histórico, mas recebe 403 em toda escrita; sem login, 401; sem soDono no ctx, ninguém escreve', async () => {
  const s = montar();
  const h = await subir(s);
  let id;
  try {
    ({ json: { id } } = await h.pedir('/api/remetentes', 'dono', { method: 'POST', body: s.corpo() }));
    const escritas = [
      ['/api/remetentes', 'POST', s.corpo({ numero: '11 98888-7777', nome: 'Op' })],
      [`/api/remetentes/${id}`, 'PUT', s.corpo({ numero: '' , nome: 'Mudou' })],
      [`/api/remetentes/${id}/enabled`, 'POST', { enabled: false }],
      [`/api/remetentes/${id}`, 'DELETE', undefined],
    ];
    const consultas = s.consultas.length;
    for (const [caminho, method, body] of escritas) {
      const r = await h.pedir(caminho, 'operador', { method, body });
      assert.deepEqual([r.status, r.json], [403, { erro: MSG.soDono }], `${method} ${caminho}`);
      const semLogin = await h.pedir(caminho, null, { method, body });
      assert.equal(semLogin.status, 401, `${method} ${caminho} sem login`);
    }
    assert.equal(s.consultas.length, consultas, 'o Operador não gasta consulta ao WhatsApp');
    const row = s.remetente(id);
    assert.deepEqual([row.nome, row.enabled], [NOME, 1]);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM remetentes').get().n, 1);

    const lista = await h.pedir('/api/remetentes', 'operador');
    assert.equal(lista.status, 200);
    assert.equal(lista.json.remetentes.length, 1);
    const itens = await h.pedir('/api/remetentes/itens', 'operador');
    assert.deepEqual([itens.status, itens.json], [200, []]);
  } finally { await h.fechar(); }

  const sem = await subir(s, { comSoDono: false });
  try {
    for (const [caminho, method, body] of [['/api/remetentes', 'POST', s.corpo({ numero: '11 98888-7777' })], [`/api/remetentes/${id}`, 'DELETE']]) {
      const r = await sem.pedir(caminho, 'dono', { method, body });
      assert.equal(r.status, 403, `${method} ${caminho}: falha fechada`);
    }
    assert.ok(s.remetente(id));
  } finally { await sem.fechar(); }

  // o serviço também pode vir do agendador (etapa 9); sem ele, 503
  const pelaAgenda = await subir(s, { servico: 'scheduler' });
  try { assert.equal((await pelaAgenda.pedir('/api/remetentes')).status, 200); } finally { await pelaAgenda.fechar(); }
  const semServico = await subir(s, { servico: null });
  try {
    const r = await semServico.pedir('/api/remetentes');
    assert.deepEqual([r.status, r.json], [503, { erro: 'O envio pelo remetente não está disponível neste servidor.' }]);
  } finally { await semServico.fechar(); }
});

test('freio: 10 consultas de número por 10 min por IP; a 11ª recebe 429 sem consultar o WhatsApp; número mal digitado não conta', async () => {
  const s = montar();
  const h = await subir(s);
  try {
    s.estado.existe = () => false;
    for (let i = 0; i < 9; i++) {
      const r = await h.pedir('/api/remetentes', 'dono', { method: 'POST', body: s.corpo({ numero: `35 9${String(i).repeat(4)}-0000` }) });
      assert.deepEqual([r.status, r.json], [400, { erro: MSG.foraDoWhats }]);
    }
    // número mal digitado e número conectado: não perguntam ao WhatsApp, não contam
    for (const numero of ['123', '(35) 91234-5678']) {
      assert.equal((await h.pedir('/api/remetentes', 'dono', { method: 'POST', body: s.corpo({ numero }) })).status, 400);
    }
    s.estado.existe = () => true;
    const decima = await h.pedir('/api/remetentes', 'dono', { method: 'POST', body: s.corpo() });
    assert.equal(decima.status, 200, decima.txt);
    assert.equal(s.consultas.length, 10);

    const bloqueada = await h.pedir('/api/remetentes', 'dono', { method: 'POST', body: s.corpo({ nome: 'Outro', numero: '11 98888-7777' }) });
    assert.equal(bloqueada.status, 429);
    assert.match(bloqueada.json.erro, /^Muitas consultas de número em pouco tempo\. Tente de novo em \d+ min\.$/);
    assert.deepEqual(Object.keys(bloqueada.json), ['erro']);
    // o PUT com número novo divide o mesmo freio; com número vazio continua livre
    const put = await h.pedir(`/api/remetentes/${decima.json.id}`, 'dono', { method: 'PUT', body: { numero: '11 98888-7777' } });
    assert.equal(put.status, 429);
    // sem LID guardado, salvar pediria o LID de novo; com o freio cheio, salva sem pedir
    s.db.prepare('UPDATE remetentes SET lid = NULL WHERE id = ?').run(decima.json.id);
    const pedidos = s.pedidosLid.length;
    const putVazio = await h.pedir(`/api/remetentes/${decima.json.id}`, 'dono', { method: 'PUT', body: { numero: '', nome: 'Renomeado' } });
    assert.equal(putVazio.status, 200, putVazio.txt);
    assert.equal(s.pedidosLid.length, pedidos, 'freio cheio: o LID não é pedido');
    assert.equal(s.remetente(decima.json.id).lid, null);
    assert.equal(s.remetente(decima.json.id).nome, 'Renomeado');
    assert.equal(s.consultas.length, 10, 'bloqueado não consulta');
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM remetentes').get().n, 1);
    // validação antes do freio: corpo inválido continua 400, não 429
    const invalido = await h.pedir('/api/remetentes', 'dono', { method: 'POST', body: s.corpo({ nome: '' }) });
    assert.equal(invalido.status, 400);
    semNumeroNasRespostas(h.respostas, [NUMERO, NUMERO2]);
  } finally { await h.fechar(); }
});

// ------------------------------------------------------------------------------------------------ CA9

test('CA9: excluir apaga o número; os itens ficam com o nome; o id não é reaproveitado por outro remetente', async () => {
  const s = montar();
  const h = await subir(s);
  try {
    const { json: a } = await h.pedir('/api/remetentes', 'dono', { method: 'POST', body: s.corpo({ nome: 'Ana' }) });
    s.estado.lid = LID2;
    const { json: b } = await h.pedir('/api/remetentes', 'dono', { method: 'POST', body: s.corpo({ nome: 'Bruno', numero: '11 98888-7777' }) });
    // o nome guardado no item é o do recebimento; renomear antes de excluir: o histórico fica com o último nome
    const it = s.item(b.id, { remetente_nome: 'Bruno' });
    await h.pedir(`/api/remetentes/${b.id}`, 'dono', { method: 'PUT', body: { nome: 'Bruno Silva' } });

    const del = await h.pedir(`/api/remetentes/${b.id}`, 'dono', { method: 'DELETE' });
    assert.deepEqual([del.status, del.json], [200, { ok: true }]);
    assert.equal(s.remetente(b.id), null);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM remetentes WHERE jid = ? OR lid = ?').get(PN2, LID2).n, 0, 'o número e o LID saíram do banco');
    const itens = await h.pedir('/api/remetentes/itens');
    assert.deepEqual(itens.json.map((i) => [i.id, i.remetente_id, i.remetente_nome]), [[it, b.id, 'Bruno Silva']]);
    const nao = await h.pedir(`/api/remetentes/${b.id}`, 'dono', { method: 'DELETE' });
    assert.deepEqual([nao.status, nao.json], [404, { erro: MSG.naoEncontrado }]);

    // o próximo cadastro não herda o id (e com ele os itens, a repetição e o limite por hora) do excluído
    s.estado.lid = null;
    const { json: c } = await h.pedir('/api/remetentes', 'dono', { method: 'POST', body: s.corpo({ nome: 'Carla', numero: '11 98888-7777' }) });
    assert.ok(c.id > b.id, `id ${c.id} reaproveitado`);
    const depois = await h.pedir(`/api/remetentes/itens?remetente=${b.id}`);
    assert.deepEqual(depois.json.map((i) => i.remetente_nome), ['Bruno Silva']);
    assert.ok(s.remetente(a.id));
    semNumeroNasRespostas(h.respostas, [NUMERO, NUMERO2]);
  } finally { await h.fechar(); }
});

test('CA9 e CA11: a lista traz só o contrato, com o número mascarado, os contadores de 24 h e o último link', async () => {
  const s = montar();
  const h = await subir(s);
  try {
    const vazia = await h.pedir('/api/remetentes');
    assert.deepEqual(vazia.json, { remetentes: [], totais_24h: { recebidos: 0, enviados: 0, repetidos: 0, descartados: 0, com_erro: 0 } });

    const { json: { id } } = await h.pedir('/api/remetentes', 'dono', { method: 'POST', body: s.corpo({ tag_id: 1, destino_jids: [DEST1, DEST2] }) });
    s.estado.lid = null;
    const { json: { id: id2 } } = await h.pedir('/api/remetentes', 'dono', { method: 'POST', body: s.corpo({ nome: 'Quieto', numero: '11 98888-7777', enabled: false }) });
    const t = s.relogio.t;
    const ok = s.envio([DEST1]); s.resultado(ok, DEST1, true);
    const falhou = s.envio([DEST1]); s.resultado(falhou, DEST1, false, { erro: 'x' });
    const naFila = s.envio([DEST1], 'pendente');
    s.item(id, { envio_id: ok, ts: t - 3 * HORA, decidido_em: t - 3 * HORA });            // enviado
    s.item(id, { envio_id: naFila, ts: t - HORA, decidido_em: t - HORA });                // enviado (na fila conta)
    s.item(id, { envio_id: falhou, ts: t - HORA, decidido_em: t - HORA });                // nenhum grupo recebeu: não conta como enviado
    s.item(id, { status: 'duplicado', codigo: 'repetida', ts: t - 2 * HORA, decidido_em: t - 2 * HORA });
    s.item(id, { status: 'descartado', codigo: 'limite', url: '', ts: t - 10 * 60000, decidido_em: t - 10 * 60000 });
    s.item(id, { status: 'erro', codigo: 'falha', ts: t - 5 * 60000, decidido_em: t - 5 * 60000 });
    s.item(id, { status: 'recebido', decidido_em: null, ts: t - 60000 });                // ainda na fila do módulo
    s.item(id, { status: 'enviado', envio_id: ok, ts: t - 2 * DIA, decidido_em: t - 2 * DIA }); // fora das 24 h
    s.item(999, { remetente_nome: 'Excluído', status: 'erro', codigo: 'falha', ts: t - HORA, decidido_em: t - HORA }); // de um remetente excluído

    const r = await h.pedir('/api/remetentes', 'operador');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json).sort(), ['remetentes', 'totais_24h']);
    const [a, b] = r.json.remetentes;
    for (const x of r.json.remetentes) assert.deepEqual(Object.keys(x).sort(), CHAVES_LISTA);
    assert.deepEqual(a, {
      id, nome: NOME, numero: MASCARADO, enabled: true, destino_jids: [DEST1, DEST2], destinos_nomes: ['Achadinhos Tech', 'Tech Dois'],
      template_id: 1, template_nome: 'Padrão', tag_id: 1, etiqueta_nome: 'etiquetaA', enviar_foto: true, max_por_hora: 10, dedupe_horas: 24,
      responder: true, problema: null, contadores_24h: { recebidos: 7, enviados: 2, repetidos: 1, descartados: 1, com_erro: 1 }, ultimo_em: t - 60000,
    });
    assert.deepEqual([b.id, b.nome, b.numero, b.enabled, b.tag_id, b.etiqueta_nome, b.ultimo_em], [id2, 'Quieto', '+55 11 •••••-7777', false, null, null, null]);
    assert.deepEqual(b.contadores_24h, { recebidos: 0, enviados: 0, repetidos: 0, descartados: 0, com_erro: 0 });
    // totais: todos os itens das 24 h, inclusive os de remetente excluído (o Histórico mostra todos)
    assert.deepEqual(r.json.totais_24h, { recebidos: 8, enviados: 2, repetidos: 1, descartados: 1, com_erro: 2 });
    semNumeroNasRespostas(h.respostas, [NUMERO, NUMERO2]);
  } finally { await h.fechar(); }
});

// ------------------------------------------------------------------------------------------------ CA11: problema

test('CA11: problema real no cartão: grupo que sumiu, template ou etiqueta apagados (nivel erro)', async () => {
  const s = montar();
  const h = await subir(s);
  const problema = async () => (await h.pedir('/api/remetentes')).json.remetentes[0].problema;
  try {
    const { json: { id } } = await h.pedir('/api/remetentes', 'dono', { method: 'POST', body: s.corpo({ tag_id: 2, destino_jids: [DEST1, DEST2, DEST3] }) });
    assert.equal(await problema(), null);

    s.db.prepare('DELETE FROM tags WHERE id = 2').run();
    assert.deepEqual(await problema(), { nivel: 'erro', texto: 'A etiqueta deste remetente foi apagada. Edite o remetente.', conexao: null });

    s.db.prepare("UPDATE templates SET body = 'sem link' WHERE id = 1").run();
    assert.deepEqual(await problema(), { nivel: 'erro', texto: 'O template deste remetente está sem o campo {LINK}. Edite o template ou o remetente.', conexao: null });
    s.db.prepare('DELETE FROM templates WHERE id = 1').run();
    assert.deepEqual(await problema(), { nivel: 'erro', texto: 'O template deste remetente foi apagado. Edite o remetente.', conexao: null });

    // grupo que sumiu: o nome vem do último envio para ele; sem envio, sem nome; vários, a contagem
    const e = s.envio([DEST3]); s.resultado(e, DEST3, true, { nome: 'Casa e Cozinha' });
    s.db.prepare('DELETE FROM groups WHERE jid = ?').run(DEST3);
    assert.deepEqual(await problema(), { nivel: 'erro', texto: 'O número saiu do grupo Casa e Cozinha. Edite o remetente.', conexao: null });
    const lista = (await h.pedir('/api/remetentes')).json.remetentes[0];
    assert.deepEqual(lista.destinos_nomes, ['Achadinhos Tech', 'Tech Dois', '(grupo removido)']);
    s.db.prepare('DELETE FROM envio_resultados').run();
    assert.deepEqual(await problema(), { nivel: 'erro', texto: 'O número saiu de um grupo deste remetente. Edite o remetente.', conexao: null });
    s.db.prepare('DELETE FROM groups WHERE jid = ?').run(DEST2);
    assert.deepEqual(await problema(), { nivel: 'erro', texto: 'O número saiu de 2 grupos deste remetente. Edite o remetente.', conexao: null });
    assert.ok(id);
  } finally { await h.fechar(); }
});

test('CA11: afiliação só vira problema quando um link foi barrado e o bloqueio continua; configuração que falta sem link barrado não aparece', async () => {
  const s = montar();
  const h = await subir(s);
  const problema = async () => (await h.pedir('/api/remetentes')).json.remetentes[0].problema;
  try {
    const { json: { id } } = await h.pedir('/api/remetentes', 'dono', { method: 'POST', body: s.corpo() });
    // a regra do dono: falta de configuração sozinha não vira aviso
    Object.assign(s.situacao, { mercadolivre: 'sem_etiqueta', amazon: 'sem_tag_amazon', shopee: 'sem_id_shopee' });
    assert.equal(await problema(), null);

    const t = s.relogio.t;
    s.item(id, { loja: 'amazon', status: 'erro', codigo: 'sem_tag_amazon', decidido_em: t - 5000 });
    assert.deepEqual(await problema(), { nivel: 'aviso', texto: 'Os links da Amazon não saem: falta a tag. Cadastre em Conexões.', conexao: 'amazon' });
    // o bloqueio de agora vale mais que o do item (a etiqueta tem prioridade sobre o modo, que é o que falta agora)
    s.item(id, { loja: 'mercadolivre', status: 'erro', codigo: 'sem_etiqueta', decidido_em: t - 1000 });
    s.situacao.mercadolivre = 'modo_direto';
    // o modo direto é de Ajustes: sem conexão
    assert.deepEqual(await problema(), { nivel: 'aviso', texto: 'Os links do Mercado Livre não saem: o modo direto está ligado em Ajustes e não gera comissão. Mude em Ajustes.', conexao: null });
    // a etiqueta do remetente vai à checagem
    const pedidas = [];
    s.situacao.mercadolivre = (tagId) => { pedidas.push(tagId); return 'sem_etiqueta'; };
    assert.deepEqual(await problema(), { nivel: 'aviso', texto: 'Os links do Mercado Livre não saem: falta a etiqueta. Cadastre em Conexões.', conexao: 'mercadolivre' });
    assert.deepEqual(pedidas, [null]);
    // o dono resolveu o ML: volta o da Amazon (o link barrado mais recente que ainda não sai)
    s.situacao.mercadolivre = null;
    assert.equal((await problema()).conexao, 'amazon');
    // um link da Amazon saiu depois: a Amazon está resolvida
    s.item(id, { loja: 'amazon', status: 'enviado', decidido_em: t });
    assert.equal(await problema(), null);

    // cada código de afiliação tem a sua frase e a sua conexão
    const frases = {
      sem_extensao: ['mercadolivre', 'Os links do Mercado Livre não saem: a extensão do Chrome está desconectada. Abra o Chrome e confira em Conexões.'],
      sem_id_shopee: ['shopee', 'Os links da Shopee não saem: falta o ID de afiliado. Cadastre em Conexões.'],
      sem_link_shopee: ['shopee', 'Os links da Shopee não saem: falta a API ou a extensão para gerar o link. Confira em Conexões.'],
    };
    let d = t + 1;
    for (const [codigo, [loja, texto]] of Object.entries(frases)) {
      s.situacao[loja] = codigo;
      s.item(id, { loja, status: 'erro', codigo, decidido_em: d++ });
      assert.deepEqual(await problema(), { nivel: 'aviso', texto, conexao: loja }, codigo);
      s.situacao[loja] = null;
    }
    // outro erro (falha, sem dados) não é de afiliação
    s.item(id, { loja: 'shopee', status: 'erro', codigo: 'falha', decidido_em: d++ });
    s.situacao.shopee = 'sem_id_shopee';
    assert.equal((await problema())?.conexao, 'shopee', 'o último barrado por afiliação da Shopee ainda vale');
    s.item(id, { loja: 'shopee', status: 'enviado', decidido_em: d++ });
    assert.equal(await problema(), null);
    // remetente desligado: nada sai, o aviso de afiliação some (grupo e template continuam)
    s.item(id, { loja: 'shopee', status: 'erro', codigo: 'sem_id_shopee', decidido_em: d++ });
    await h.pedir(`/api/remetentes/${id}/enabled`, 'dono', { method: 'POST', body: { enabled: false } });
    assert.equal(await problema(), null);
  } finally { await h.fechar(); }
});

// ------------------------------------------------------------------------------------------------ itens e ativar

test('itens: histórico com destinos por grupo, filtros e paginação; sem url, complemento nem número', async () => {
  const s = montar();
  const h = await subir(s);
  try {
    const { json: { id } } = await h.pedir('/api/remetentes', 'dono', { method: 'POST', body: s.corpo() });
    s.estado.lid = null;
    const { json: { id: id2 } } = await h.pedir('/api/remetentes', 'dono', { method: 'POST', body: s.corpo({ nome: 'Outro', numero: '11 98888-7777' }) });
    const oferta = JSON.stringify({ title: 'Fone', price: 10, oldPrice: null, discountPct: null, sold: null, freeShipping: false, coupon: null, image: null, extra: 'x' });
    const parcial = s.envio([DEST1, DEST2, '999@g.us']);
    s.resultado(parcial, DEST1, true, { nome: 'Achadinhos Tech' });
    s.resultado(parcial, DEST2, false, { nome: 'Tech Dois', erro: 'sem permissão' });
    const fila = s.envio([DEST1], 'pendente');
    const cancelado = s.envio([DEST1], 'cancelado');
    const perdeu = s.envio([DEST2], 'erro', JSON.stringify({ motivo: 'perdeu o horário' }));
    const i1 = s.item(id, { envio_id: parcial, oferta, fonte_dados: 'api+texto', complemento: '{"title":"Fone"}', url: 'https://meli.la/abc' });
    const i2 = s.item(id, { envio_id: fila });
    const i3 = s.item(id, { envio_id: cancelado });
    const i4 = s.item(id, { envio_id: perdeu });
    const i5 = s.item(id2, { status: 'descartado', codigo: 'sem_link_de_loja', motivo: 'sem link do Mercado Livre, Amazon ou Shopee', url: '', loja: null, remetente_nome: 'Outro' });

    const r = await h.pedir('/api/remetentes/itens', 'operador');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json));
    assert.deepEqual(r.json.map((i) => i.id), [i5, i4, i3, i2, i1]);
    for (const i of r.json) assert.deepEqual(Object.keys(i).sort(), CHAVES_ITEM);
    const porId = new Map(r.json.map((i) => [i.id, i]));
    assert.deepEqual(porId.get(i1), {
      id: i1, remetente_id: id, remetente_nome: NOME, ts: s.relogio.t, loja: 'mercadolivre', status: 'enviado', codigo: null, motivo: null,
      fonte_dados: 'api+texto', decidido_em: s.relogio.t,
      oferta: { title: 'Fone', price: 10, oldPrice: null, discountPct: null, sold: null, freeShipping: false, coupon: null, image: null },
      destinos: [{ nome: 'Achadinhos Tech', ok: true, erro: null }, { nome: 'Tech Dois', ok: false, erro: 'sem permissão' }, { nome: '(grupo removido)', ok: false, erro: 'não foi enviado' }],
    });
    assert.deepEqual(porId.get(i2).destinos, [{ nome: 'Achadinhos Tech', ok: null, erro: null }]);
    assert.deepEqual(porId.get(i3).destinos, [{ nome: 'Achadinhos Tech', ok: false, erro: 'o envio foi cancelado' }]);
    assert.deepEqual(porId.get(i4).destinos, [{ nome: 'Tech Dois', ok: false, erro: 'perdeu o horário' }]);
    assert.deepEqual([porId.get(i5).destinos, porId.get(i5).codigo, porId.get(i5).oferta, porId.get(i5).remetente_nome], [[], 'sem_link_de_loja', null, 'Outro']);

    assert.deepEqual((await h.pedir(`/api/remetentes/itens?remetente=${id2}`)).json.map((i) => i.id), [i5]);
    assert.deepEqual((await h.pedir(`/api/remetentes/itens?antes=${i3}`)).json.map((i) => i.id), [i2, i1]);
    assert.deepEqual((await h.pedir(`/api/remetentes/itens?antes=${i3}&limite=1`)).json.map((i) => i.id), [i2]);
    assert.equal((await h.pedir('/api/remetentes/itens?limite=999')).json.length, 5);
    for (const q of ['remetente=abc', 'remetente=0', 'antes=-3']) {
      const ruim = await h.pedir(`/api/remetentes/itens?${q}`);
      assert.equal(ruim.status, 404, q);
      assert.deepEqual(Object.keys(ruim.json), ['erro']);
    }
    assert.ok(!h.respostas.join('\n').includes('meli.la'), 'a URL recebida não sai');
    semNumeroNasRespostas(h.respostas, [NUMERO, NUMERO2]);
  } finally { await h.fechar(); }
});

test('ativar: liga e desliga com booleano estrito; 404 para remetente que não existe', async () => {
  const s = montar();
  const h = await subir(s);
  try {
    const { json: { id } } = await h.pedir('/api/remetentes', 'dono', { method: 'POST', body: s.corpo() });
    const off = await h.pedir(`/api/remetentes/${id}/enabled`, 'dono', { method: 'POST', body: { enabled: false } });
    assert.deepEqual([off.status, off.json], [200, { ok: true, enabled: false }]);
    assert.equal(s.remetente(id).enabled, 0);
    for (const enabled of ['true', 1, null, undefined]) {
      const r = await h.pedir(`/api/remetentes/${id}/enabled`, 'dono', { method: 'POST', body: { enabled } });
      assert.deepEqual([r.status, r.json], [400, { erro: 'Ativo: ligue ou desligue.' }], String(enabled));
    }
    const on = await h.pedir(`/api/remetentes/${id}/enabled`, 'dono', { method: 'POST', body: { enabled: true } });
    assert.deepEqual([on.status, on.json], [200, { ok: true, enabled: true }]);
    assert.equal(s.remetente(id).enabled, 1);
    const nao = await h.pedir('/api/remetentes/999/enabled', 'dono', { method: 'POST', body: { enabled: true } });
    assert.deepEqual([nao.status, nao.json], [404, { erro: MSG.naoEncontrado }]);
    semNumeroNasRespostas(h.respostas);
  } finally { await h.fechar(); }
});

test('erro inesperado do banco: 500 com frase fixa e o console só com o código (sem a mensagem, que traz os valores)', async (t) => {
  const espias = capturarConsole(t);
  const s = montar();
  const h = await subir(s);
  try {
    const { json: { id } } = await h.pedir('/api/remetentes', 'dono', { method: 'POST', body: s.corpo() });
    const original = s.db.prepare.bind(s.db);
    s.db.prepare = (sql) => {
      if (/^UPDATE remetentes SET nome/.test(sql)) { const e = new Error(`constraint falhou com ${PN}`); e.code = 'ERR_SQLITE_ERROR'; throw e; }
      return original(sql);
    };
    const r = await h.pedir(`/api/remetentes/${id}`, 'dono', { method: 'PUT', body: { nome: 'X' } });
    assert.deepEqual([r.status, r.json], [500, { erro: 'Não consegui concluir. Tente de novo.' }]);
    s.db.prepare = original;
    const console_ = textoDoConsole(espias);
    assert.match(console_, /ERR_SQLITE_ERROR/);
    assert.ok(!console_.includes(NUMERO));
    semNumeroNasRespostas(h.respostas);
  } finally { await h.fechar(); }
});

test('createRemetentes direto: criar sem freio e sem WhatsApp recusa com frase fixa; listar e itens funcionam sem rotas', async () => {
  const s = montar();
  const semWa = createRemetentes({ db: s.db, envios: null, agora: () => s.relogio.t });
  await assert.rejects(semWa.criar(s.corpo()), (e) => e.status === 400 && e.message === MSG.semConferir);
  const { id } = await s.rem.criar(s.corpo());
  assert.equal(s.remetente(id).jid, PN);
  // sem situacaoLink (sem a fila de envios), o último barrado por afiliação basta para o aviso
  s.item(id, { loja: 'amazon', status: 'erro', codigo: 'sem_tag_amazon' });
  assert.equal(semWa.listar().remetentes[0].problema.conexao, 'amazon');
  assert.equal(semWa.itens({}).length, 1);
  // o freio (antesDeConsultar) roda logo antes da consulta e pode recusar
  const pare = Object.assign(new Error('freio'), { status: 429 });
  const consultas = s.consultas.length;
  await assert.rejects(s.rem.criar(s.corpo({ numero: '11 98888-7777', nome: 'Outro' }), { antesDeConsultar: () => { throw pare; } }), (e) => e === pare);
  assert.equal(s.consultas.length, consultas);
});
