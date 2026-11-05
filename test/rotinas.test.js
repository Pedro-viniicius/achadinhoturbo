// Grupo vivo (plano grade-de-disparos, etapa 5; D6, D7; CA11): o núcleo de src/rotinas.js e o que ele pede de
// src/envios.js (validarTextoMensagem, validarEnquete, HHMM, o prefixo "Grupo vivo" no log e o painel de Disparar
// mensagem sem as rotinas). createRotinas direto, com a fila de envios real (createEnvios, modo rápido) e o WhatsApp em
// dryRun (o que "sai" fica em wa.simulated). O relógio do módulo é injetado; o sorteio também.
// A ligação no agendador e no servidor é da etapa 6: aqui as rotas sobem num Express mínimo.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { openDb } from '../src/db.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createEnvios, validarTextoMensagem, validarEnquete, HHMM } from '../src/envios.js';
import { createRotinas, montarRotas, MAX_CONTEUDOS, MAX_HORARIOS_ROTINA } from '../src/rotinas.js';

// o fetch de verdade só serve ao teste das rotas (HTTP local); o global fica bloqueado e o último teste confere
const fetchLocal = globalThis.fetch;
let acessosRede = 0;
globalThis.fetch = async () => { acessosRede++; throw new Error('rede proibida no teste'); };

const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-rot-')); pastas.push(p); return p; };

const MIN = 60000;
const DIA = 86400000;
const G1 = '120363000000000001@g.us';
const G2 = '120363000000000002@g.us';
const G3 = '120363000000000003@g.us';
const TODOS = [0, 1, 2, 3, 4, 5, 6];
/** Hora local (o fuso do computador, como o Repetir). 05/01/2026 é uma segunda-feira. */
const em = (d, h, m = 0) => new Date(2026, 0, d, h, m).getTime();
const TEXTOS = ['Bom dia, pessoal!', 'Bom dia! Café na mão.', 'Bom dia, gente!'];
const ENQUETE = { pergunta: 'O que você quer ver mais por aqui?', opcoes: ['Casa', 'Eletrônicos', 'Moda'], multipla: true };

const BOM_DIA = () => ({
  nome: 'Bom dia', tipo: 'mensagem', conteudos: [...TEXTOS], ordem: 'rodizio', group_jids: [G1, G2],
  repetir: { dias: [...TODOS], horarios: ['08:00'] },
});

const DESCONECTADO = 'O WhatsApp está desconectado. Conecte o número antes de disparar.';

/** Banco, WhatsApp simulado, fila de envios real e rotinas com relógio e sorteio injetados. */
function montar({ conectado = true, sorteios = [] } = {}) {
  const dir = tmp();
  const db = openDb(dir);
  for (const [jid, nome] of [[G1, 'Achadinhos'], [G2, 'Tech'], [G3, 'Casa']]) {
    db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, nome, 10, Date.now());
  }
  const wa = createWhatsApp({ db, dir, dryRun: true });
  if (conectado) wa.connect();
  const relogio = { t: em(5, 7) };
  const estado = { acordou: 0, sorteios: [...sorteios] };
  const envios = createEnvios({ db, wa, fast: true, dir, acordar: () => {} }); // a fila só anda quando o teste manda
  const rotinas = createRotinas({
    db, wa, acordar: () => { estado.acordou++; }, agora: () => relogio.t,
    sortear: () => (estado.sorteios.length ? estado.sorteios.shift() : 0),
  });
  return { dir, db, wa, envios, rotinas, relogio, estado };
}

const rotina = (s, id) => s.db.prepare('SELECT * FROM rotinas WHERE id = ?').get(id);
const enviosDa = (s) => s.db.prepare("SELECT * FROM envios ORDER BY id").all().map((e) => ({ ...e, payload: JSON.parse(e.payload), group_jids: JSON.parse(e.group_jids) }));
const logs = (s) => s.db.prepare('SELECT rule_id, rule_name, level, group_name, offer_title, message FROM log ORDER BY id').all().map((l) => ({ ...l }));
/** Erro de campo: 400 com a frase da tela. */
const recusa = (msg, status = 400) => (e) => { assert.equal(e.message, msg); assert.equal(e.status, status); return true; };

// ------------------------------------------------------------------------------------------- envios.js (D7)

test('envios exporta HHMM, validarTextoMensagem e validarEnquete com as frases de Disparar mensagem', () => {
  assert.ok(HHMM.test('8:05') && HHMM.test('23:59') && !HHMM.test('24:00') && !HHMM.test('08:60'));
  assert.equal(validarTextoMensagem('  Oi\r\ntudo bem  '), 'Oi\ntudo bem');
  assert.throws(() => validarTextoMensagem('   '), /^Error: Escreva a mensagem\.$/);
  assert.throws(() => validarTextoMensagem(undefined), /^Error: Escreva a mensagem\.$/);
  assert.equal(validarTextoMensagem('', { vazioOk: true }), '');
  assert.throws(() => validarTextoMensagem('x'.repeat(4097)), /^Error: A mensagem passa de 4096 caracteres\.$/);
  assert.equal(validarTextoMensagem('x'.repeat(4096)).length, 4096);
  assert.deepEqual(validarEnquete({ pergunta: ' Qual? ', opcoes: [' A ', 'B'], extra: 1 }), { pergunta: 'Qual?', opcoes: ['A', 'B'], multipla: false });
  assert.throws(() => validarEnquete({ pergunta: '', opcoes: ['A', 'B'] }), /^Error: A enquete precisa de uma pergunta\.$/);
  assert.throws(() => validarEnquete({ pergunta: 'Q', opcoes: ['A', 'a'] }), /^Error: A enquete tem opções repetidas\.$/);
});

test('json_extract e json_valid existem no node:sqlite (o painel e a lista das rotinas dependem deles)', () => {
  const s = montar();
  const r = s.db.prepare(`SELECT json_valid(?) AS ok, json_valid('{x') AS ruim, json_extract(?, '$.origem.tipo') AS tipo,
    (CASE WHEN json_valid('{x') THEN json_extract('{x', '$.a') END) AS protegido`).get('{"origem":{"tipo":"rotina"}}', '{"origem":{"tipo":"rotina"}}');
  assert.deepEqual({ ...r }, { ok: 1, ruim: 0, tipo: 'rotina', protegido: null });
});

// ------------------------------------------------------------------------------------------- cadastro e validações

test('criar: normaliza o corpo, grava ligada com o próximo horário e não envia nada', () => {
  const s = montar();
  const { id, next_run_at } = s.rotinas.criar({
    nome: '  Bom   dia  ', tipo: 'mensagem', conteudos: ['  Bom dia!\r\nTudo bem?  ', 'Olá'], group_jids: [G2, G1, G2],
    repetir: { dias: ['3', 1, 1], horarios: ['18:30', '8:05'] },
  });
  const r = rotina(s, id);
  assert.equal(r.nome, 'Bom dia');
  assert.equal(r.enabled, 1);
  assert.equal(r.tipo, 'mensagem');
  assert.deepEqual(JSON.parse(r.conteudos), ['Bom dia!\nTudo bem?', 'Olá']);
  assert.equal(r.ordem, 'rodizio');
  assert.equal(r.proximo_indice, 0);
  assert.deepEqual(JSON.parse(r.group_jids), [G2, G1]);
  assert.deepEqual(JSON.parse(r.repetir), { dias: [1, 3], horarios: ['08:05', '18:30'] });
  assert.equal(r.next_run_at, em(5, 8, 5), 'segunda 07:00 → segunda 08:05');
  assert.equal(next_run_at, r.next_run_at);
  assert.equal(r.created_at, s.relogio.t);
  assert.equal(r.updated_at, s.relogio.t);
  assert.equal(r.last_run_at, null);
  assert.equal(enviosDa(s).length, 0);
  assert.equal(s.estado.acordou, 0);

  // desligada: sem próximo horário
  const b = s.rotinas.criar({ ...BOM_DIA(), enabled: false });
  assert.equal(rotina(s, b.id).enabled, 0);
  assert.equal(rotina(s, b.id).next_run_at, null);
  // enquete normalizada pelo validador de Disparar mensagem
  const c = s.rotinas.criar({ ...BOM_DIA(), tipo: 'enquete', ordem: 'sorteio', conteudos: [{ pergunta: ' Qual? ', opcoes: ['A', ' B '], multipla: true, x: 1 }] });
  assert.deepEqual(JSON.parse(rotina(s, c.id).conteudos), [{ pergunta: 'Qual?', opcoes: ['A', 'B'], multipla: true }]);
  assert.equal(rotina(s, c.id).ordem, 'sorteio');
});

test('validações: cada campo inválido volta 400 com a frase da tela e nada é gravado', () => {
  const s = montar();
  const casos = [
    [{ nome: '' }, 'Dê um nome à rotina.'],
    [{ nome: '   ' }, 'Dê um nome à rotina.'],
    [{ nome: 42 }, 'Dê um nome à rotina.'],
    [{ nome: 'x'.repeat(61) }, 'O nome pode ter até 60 letras.'],
    [{ tipo: 'oferta' }, 'Escolha o tipo: mensagem ou enquete.'],
    [{ tipo: undefined }, 'Escolha o tipo: mensagem ou enquete.'],
    [{ conteudos: [] }, 'Escreva a mensagem.'],
    [{ conteudos: 'Bom dia' }, 'Escreva a mensagem.'],
    [{ conteudos: ['   '] }, 'Escreva a mensagem.'],
    [{ conteudos: [{ texto: 'oi' }] }, 'Escreva a mensagem.'],
    [{ conteudos: ['ok', ''] }, 'Texto 2: Escreva a mensagem.'],
    [{ conteudos: ['x'.repeat(4097)] }, 'A mensagem passa de 4096 caracteres.'],
    [{ conteudos: ['1', '2', '3', '4', '5', '6'] }, 'Uma rotina tem no máximo 5 textos.'],
    [{ tipo: 'enquete', conteudos: [] }, 'A enquete precisa de uma pergunta.'],
    [{ tipo: 'enquete', conteudos: ['Qual?'] }, 'A enquete precisa de uma pergunta.'],
    [{ tipo: 'enquete', conteudos: [null] }, 'A enquete precisa de uma pergunta.'],
    [{ tipo: 'enquete', conteudos: [{ pergunta: 'Q', opcoes: ['A'] }] }, 'A enquete precisa de 2 a 12 opções.'],
    [{ tipo: 'enquete', conteudos: [ENQUETE, { pergunta: 'Q', opcoes: ['A', 'a'] }] }, 'Enquete 2: A enquete tem opções repetidas.'],
    [{ tipo: 'enquete', conteudos: Array(6).fill(ENQUETE) }, 'Uma rotina tem no máximo 5 enquetes.'],
    [{ ordem: 'aleatoria' }, 'Ordem: um depois do outro ou sorteio.'],
    [{ group_jids: [] }, 'Marque ao menos um grupo.'],
    [{ group_jids: undefined }, 'Marque ao menos um grupo.'],
    [{ group_jids: [G1, 7] }, 'Lista de grupos inválida.'],
    [{ group_jids: Array.from({ length: 501 }, (_, i) => `${i}@g.us`) }, 'Marque no máximo 500 grupos.'],
    [{ group_jids: [G1, '999@g.us'] }, 'Algum grupo escolhido não existe mais. Atualize a lista e escolha de novo.'],
    [{ repetir: null }, 'Escolha os dias e os horários da rotina.'],
    [{ repetir: [] }, 'Escolha os dias e os horários da rotina.'],
    [{ repetir: { dias: [], horarios: ['08:00'] } }, 'Marque ao menos um dia.'],
    [{ repetir: { dias: [7], horarios: ['08:00'] } }, 'Marque ao menos um dia.'],
    [{ repetir: { dias: [1.5], horarios: ['08:00'] } }, 'Marque ao menos um dia.'],
    [{ repetir: { dias: [1], horarios: [] } }, 'Adicione ao menos um horário.'],
    [{ repetir: { dias: [1] } }, 'Adicione ao menos um horário.'],
    [{ repetir: { dias: [1], horarios: ['25:00'] } }, 'Horário inválido: use HH:MM.'],
    [{ repetir: { dias: [1], horarios: [800] } }, 'Horário inválido: use HH:MM.'],
    [{ repetir: { dias: [1], horarios: ['18:00', '9:00', '18:00'] } }, 'Já existe um horário às 18:00.'],
    [{ repetir: { dias: [1], horarios: ['01:00', '02:00', '03:00', '04:00', '05:00', '06:00', '07:00'] } }, 'Uma rotina aceita no máximo 6 horários.'],
    [{ enabled: 'sim' }, 'Ativo: ligue ou desligue.'],
  ];
  for (const [mudanca, frase] of casos) {
    assert.throws(() => s.rotinas.criar({ ...BOM_DIA(), ...mudanca }), recusa(frase), JSON.stringify(mudanca).slice(0, 80));
  }
  for (const corpo of [null, 'x', [BOM_DIA()]]) assert.throws(() => s.rotinas.criar(corpo), (e) => e.status === 400);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM rotinas').get().n, 0);
  // no limite passa
  assert.equal(MAX_CONTEUDOS, 5);
  assert.equal(MAX_HORARIOS_ROTINA, 6);
  const ok = s.rotinas.criar({ ...BOM_DIA(), nome: 'x'.repeat(60), conteudos: ['1', '2', '3', '4', '5'],
    repetir: { dias: [0], horarios: ['01:00', '02:00', '03:00', '04:00', '05:00', '06:00'] } });
  assert.ok(ok.id);
});

// ------------------------------------------------------------------------------------------- a ocorrência

test('ocorrência: no horário grava um envio "agora" com a origem da rotina, avança a rotina e acorda o agendador', async () => {
  const s = montar();
  const { id } = s.rotinas.criar(BOM_DIA());
  assert.equal(await s.rotinas.processarPendentes(em(5, 7, 59)), 0, 'antes do horário não sai');
  assert.equal(enviosDa(s).length, 0);

  assert.equal(await s.rotinas.processarPendentes(em(5, 8, 1)), 1);
  const [e] = enviosDa(s);
  assert.equal(e.tipo, 'mensagem');
  assert.equal(e.quando, 'agora');
  assert.equal(e.status, 'pendente');
  assert.equal(e.repetir, null);
  assert.equal(e.next_run_at, em(5, 8, 1));
  assert.deepEqual(e.group_jids, [G1, G2]);
  assert.deepEqual(e.payload, { texto: TEXTOS[0], imagem: 'nenhuma', origem: { tipo: 'rotina', rotina_id: id, nome: 'Bom dia' } });
  const r = rotina(s, id);
  assert.equal(r.next_run_at, em(6, 8), 'próximo: terça 08:00');
  assert.equal(r.proximo_indice, 1);
  assert.equal(r.last_run_at, em(5, 8, 1));
  assert.equal(r.ultimo_envio_id, e.id);
  assert.equal(s.estado.acordou, 1);
  assert.equal(await s.rotinas.processarPendentes(em(5, 8, 2)), 0, 'a mesma ocorrência não sai duas vezes');

  // a fila de envios manda e o Histórico mostra "Grupo vivo: <nome>"
  await s.envios.runEnvio(e.id);
  assert.deepEqual(s.wa.simulated.map((m) => [m.jid, m.text]), [[G1, TEXTOS[0]], [G2, TEXTOS[0]]]);
  assert.deepEqual(logs(s).map((l) => [l.rule_id, l.rule_name, l.level, l.group_name, l.offer_title, l.message]), [
    [null, 'Grupo vivo: Bom dia', 'ok', 'Achadinhos', TEXTOS[0], 'Mensagem enviada'],
    [null, 'Grupo vivo: Bom dia', 'ok', 'Tech', TEXTOS[0], 'Mensagem enviada'],
  ]);
});

test('ocorrência de enquete: payload com pergunta, opções e múltipla; sai como enquete', async () => {
  const s = montar();
  const { id } = s.rotinas.criar({ ...BOM_DIA(), nome: 'Enquete da sexta', tipo: 'enquete', conteudos: [ENQUETE], group_jids: [G3] });
  await s.rotinas.processarPendentes(em(5, 8));
  const [e] = enviosDa(s);
  assert.equal(e.tipo, 'enquete');
  assert.deepEqual(e.payload, { ...ENQUETE, origem: { tipo: 'rotina', rotina_id: id, nome: 'Enquete da sexta' } });
  await s.envios.runEnvio(e.id);
  assert.deepEqual(s.wa.simulated.map((m) => [m.tipo, m.jid, m.text]), [['poll', G3, ENQUETE.pergunta]]);
  assert.equal(logs(s)[0].rule_name, 'Grupo vivo: Enquete da sexta');
});

test('rodízio: um depois do outro, 0, 1, 2 e volta ao 0', async () => {
  const s = montar();
  s.rotinas.criar(BOM_DIA());
  for (const d of [5, 6, 7, 8]) assert.equal(await s.rotinas.processarPendentes(em(d, 8, 1)), 1);
  assert.deepEqual(enviosDa(s).map((e) => e.payload.texto), [TEXTOS[0], TEXTOS[1], TEXTOS[2], TEXTOS[0]]);
});

test('sorteio: nunca repete o último texto; com um texto só, sempre ele', async () => {
  // sorteios: 0 → índice 0 (primeiro envio, qualquer um); depois o sorteio é entre os outros dois
  const s = montar({ sorteios: [0, 0, 0, 0.99, 0.5, 0.5, 0.99, 0] });
  s.rotinas.criar({ ...BOM_DIA(), ordem: 'sorteio' });
  for (let d = 5; d < 13; d++) await s.rotinas.processarPendentes(em(d, 8));
  const indices = enviosDa(s).map((e) => TEXTOS.indexOf(e.payload.texto));
  assert.equal(indices.length, 8);
  assert.deepEqual(indices, [0, 1, 0, 2, 1, 2, 1, 0]);
  for (let i = 1; i < indices.length; i++) assert.notEqual(indices[i], indices[i - 1], `envio ${i} repetiu o anterior`);

  // sorteio que devolve lixo não quebra nem repete
  const t = montar({ sorteios: [Number.NaN, 1, -3, 7] });
  t.rotinas.criar({ ...BOM_DIA(), ordem: 'sorteio' });
  for (let d = 5; d < 9; d++) await t.rotinas.processarPendentes(em(d, 8));
  const outros = enviosDa(t).map((e) => TEXTOS.indexOf(e.payload.texto));
  assert.ok(outros.every((i) => i >= 0 && i <= 2), String(outros));
  for (let i = 1; i < outros.length; i++) assert.notEqual(outros[i], outros[i - 1]);

  const u = montar({ sorteios: [0.7, 0.7, 0.7] });
  u.rotinas.criar({ ...BOM_DIA(), ordem: 'sorteio', conteudos: ['Só este'] });
  for (let d = 5; d < 8; d++) await u.rotinas.processarPendentes(em(d, 8));
  assert.deepEqual(enviosDa(u).map((e) => e.payload.texto), ['Só este', 'Só este', 'Só este']);
});

test('trava atômica: dois processarPendentes juntos gravam um envio só', async () => {
  const s = montar();
  const { id } = s.rotinas.criar(BOM_DIA());
  const outra = createRotinas({ db: s.db, wa: s.wa, acordar: () => {}, agora: () => s.relogio.t });
  const r = await Promise.all([s.rotinas.processarPendentes(em(5, 8, 1)), outra.processarPendentes(em(5, 8, 1)), s.rotinas.processarPendentes(em(5, 8, 1))]);
  assert.deepEqual(r.sort(), [0, 0, 1]);
  assert.equal(enviosDa(s).length, 1);
  assert.equal(rotina(s, id).proximo_indice, 1);
});

test('trava atômica: quem leu a rotina vencida antes do outro gravar não grava de novo', async () => {
  // o segundo processarPendentes roda logo depois de o primeiro ler as vencidas e antes de ele travar a rotina
  const s = montar();
  const { id } = s.rotinas.criar(BOM_DIA());
  const outra = createRotinas({ db: s.db, wa: s.wa, acordar: () => {}, agora: () => s.relogio.t });
  const original = s.db.prepare.bind(s.db);
  let intrometeu = false;
  s.db.prepare = (sql) => {
    const st = original(sql);
    if (intrometeu || !/FROM rotinas WHERE enabled = 1/.test(sql)) return st;
    return new Proxy(st, {
      get(alvo, k) {
        if (k !== 'all') return typeof alvo[k] === 'function' ? alvo[k].bind(alvo) : alvo[k];
        return (...args) => {
          const linhas = alvo.all(...args);
          if (!intrometeu) { intrometeu = true; outra.processarPendentes(em(5, 8, 1)); }
          return linhas;
        };
      },
    });
  };
  const n = await s.rotinas.processarPendentes(em(5, 8, 1));
  s.db.prepare = original;
  assert.ok(intrometeu, 'o outro processarPendentes rodou no meio');
  assert.equal(n, 0, 'o primeiro viu a rotina vencida, mas a trava já tinha mudado');
  assert.equal(enviosDa(s).length, 1);
  assert.equal(rotina(s, id).proximo_indice, 1, 'o rodízio avançou uma vez só');
});

test('horário perdido: atraso de até 30 min sai; de 31 min pula com aviso e sem envio', async () => {
  const s = montar();
  const { id } = s.rotinas.criar(BOM_DIA());
  assert.equal(await s.rotinas.processarPendentes(em(5, 8, 30)), 1, '30 min de atraso: sai');
  assert.equal(rotina(s, id).next_run_at, em(6, 8));

  assert.equal(await s.rotinas.processarPendentes(em(6, 8, 31)), 0, '31 min: pula');
  assert.equal(enviosDa(s).length, 1);
  const r = rotina(s, id);
  assert.equal(r.next_run_at, em(7, 8));
  assert.equal(r.proximo_indice, 1, 'o pulado não gasta texto do rodízio');
  assert.deepEqual(logs(s).map((l) => [l.rule_name, l.level, l.message]), [
    ['Grupo vivo: Bom dia', 'aviso', 'Horário de 06/01 08:00 pulado: o programa estava desligado, o WhatsApp desconectado ou outro envio demorou. Próximo: 07/01 08:00.'],
  ]);
  assert.equal(await s.rotinas.processarPendentes(em(6, 8, 32)), 0, 'o aviso não se repete');
  assert.equal(logs(s).length, 1);
});

test('horário perdido: vários vencidos saem só o mais recente (sem rajada), com um aviso dos pulados', async () => {
  const s = montar();
  const { id } = s.rotinas.criar({ ...BOM_DIA(), repetir: { dias: TODOS, horarios: ['08:00', '09:00', '10:00'] } });
  assert.equal(await s.rotinas.processarPendentes(em(5, 10, 5)), 1);
  assert.equal(enviosDa(s).length, 1);
  assert.equal(enviosDa(s)[0].payload.texto, TEXTOS[0]);
  assert.equal(rotina(s, id).next_run_at, em(6, 8));
  assert.deepEqual(logs(s).map((l) => [l.level, l.message]), [
    ['aviso', '2 horários pulados, o último de 05/01 09:00: o programa estava desligado, o WhatsApp desconectado ou outro envio demorou. Sai agora o de 05/01 10:00.'],
  ]);

  // programa desligado por dias: nada sai, um aviso só, próximo no futuro
  const t = montar();
  const b = t.rotinas.criar(BOM_DIA());
  assert.equal(await t.rotinas.processarPendentes(em(12, 9)), 0);
  assert.equal(enviosDa(t).length, 0);
  assert.equal(rotina(t, b.id).next_run_at, em(13, 8));
  assert.equal(logs(t).length, 1);
  assert.match(logs(t)[0].message, /^8 horários pulados, o último de 12\/01 08:00: .* Próximo: 13\/01 08:00\.$/);
});

test('WhatsApp fora: a rotina vencida espera sem gravar; volta em até 30 min e sai, passou disso pula', async () => {
  const s = montar({ conectado: false });
  const { id } = s.rotinas.criar(BOM_DIA());
  assert.equal(await s.rotinas.processarPendentes(em(5, 8, 10)), 0);
  assert.equal(enviosDa(s).length, 0);
  assert.equal(rotina(s, id).next_run_at, em(5, 8), 'mantém o horário');
  assert.equal(logs(s).length, 0);
  s.wa.connect();
  assert.equal(await s.rotinas.processarPendentes(em(5, 8, 20)), 1);

  // fora de novo e passou da tolerância: pula com aviso (sem precisar do WhatsApp para isso)
  const pronto = s.wa.isReady; s.wa.isReady = () => false;
  try {
    assert.equal(await s.rotinas.processarPendentes(em(6, 8, 45)), 0);
    assert.equal(rotina(s, id).next_run_at, em(7, 8));
    assert.equal(logs(s).filter((l) => l.level === 'aviso').length, 1);
  } finally { s.wa.isReady = pronto; }
  // sem WhatsApp nenhum (wa null) também não grava
  const t = montar();
  const sem = createRotinas({ db: t.db, wa: null, acordar: () => {}, agora: () => t.relogio.t });
  sem.criar(BOM_DIA());
  assert.equal(await sem.processarPendentes(em(5, 8)), 0);
  assert.equal(enviosDa(t).length, 0);
});

test('grupo apagado é filtrado; sem nenhum grupo, aviso e nenhum envio', async () => {
  const s = montar();
  const { id } = s.rotinas.criar({ ...BOM_DIA(), group_jids: [G1, G2, G3] });
  s.db.prepare('DELETE FROM groups WHERE jid = ?').run(G2);
  await s.rotinas.processarPendentes(em(5, 8));
  assert.deepEqual(enviosDa(s)[0].group_jids, [G1, G3]);
  assert.equal(logs(s).length, 0, 'filtrar não gera aviso');

  s.db.prepare('DELETE FROM groups').run();
  assert.equal(await s.rotinas.processarPendentes(em(6, 8)), 0);
  assert.equal(enviosDa(s).length, 1);
  const r = rotina(s, id);
  assert.equal(r.next_run_at, em(7, 8), 'avança o horário');
  assert.equal(r.proximo_indice, 1, 'não gasta texto');
  assert.deepEqual(logs(s).map((l) => [l.rule_name, l.level, l.message]), [
    ['Grupo vivo: Bom dia', 'aviso', 'Não enviada: os grupos desta rotina não existem mais. Edite a rotina e escolha os grupos.'],
  ]);
  assert.doesNotMatch(JSON.stringify(logs(s)), /@g\.us/);
});

test('rotina desligada não sai, mesmo com horário vencido gravado; conteúdo ilegível não derruba as outras', async () => {
  const s = montar();
  const a = s.rotinas.criar(BOM_DIA());
  const b = s.rotinas.criar({ ...BOM_DIA(), nome: 'Outra' });
  s.db.prepare('UPDATE rotinas SET enabled = 0 WHERE id = ?').run(a.id);
  s.db.prepare("UPDATE rotinas SET conteudos = '{x' WHERE id = ?").run(b.id);
  const c = s.rotinas.criar({ ...BOM_DIA(), nome: 'Boa' });
  const erros = [];
  const err = console.error; console.error = (...x) => erros.push(x.join(' '));
  try { assert.equal(await s.rotinas.processarPendentes(em(5, 8)), 1); } finally { console.error = err; }
  assert.deepEqual(enviosDa(s).map((e) => e.payload.origem.rotina_id), [c.id]);
  assert.equal(rotina(s, a.id).next_run_at, em(5, 8), 'a desligada fica como estava');
  assert.equal(rotina(s, b.id).next_run_at, em(6, 8), 'a sem texto avança');
  assert.deepEqual(logs(s).map((l) => [l.rule_name, l.message]), [['Grupo vivo: Outra', 'Não enviada: a rotina está sem texto. Edite a rotina.']]);
  assert.deepEqual(erros, []);
});

// ------------------------------------------------------------------------------------------- Enviar agora

test('Enviar agora: sem WhatsApp falha sem gravar; conectado grava já, avança o rodízio e não mexe no próximo horário', async () => {
  const s = montar({ conectado: false });
  const { id } = s.rotinas.criar(BOM_DIA());
  assert.throws(() => s.rotinas.enviarAgora(id), recusa(DESCONECTADO));
  assert.equal(enviosDa(s).length, 0);
  assert.equal(rotina(s, id).proximo_indice, 0);

  s.wa.connect();
  s.relogio.t = em(5, 7, 30);
  assert.deepEqual(s.rotinas.enviarAgora(String(id)), { envio_id: 1, grupos: 2 });
  const [e] = enviosDa(s);
  assert.equal(e.quando, 'agora');
  assert.equal(e.next_run_at, em(5, 7, 30));
  assert.equal(e.payload.texto, TEXTOS[0]);
  assert.equal(e.payload.origem.tipo, 'rotina');
  const r = rotina(s, id);
  assert.equal(r.next_run_at, em(5, 8), 'o próximo horário continua o mesmo');
  assert.equal(r.proximo_indice, 1);
  assert.equal(r.ultimo_envio_id, e.id);
  assert.equal(s.estado.acordou, 1);
  // o horário das 08:00 sai com o texto seguinte
  await s.rotinas.processarPendentes(em(5, 8));
  assert.equal(enviosDa(s)[1].payload.texto, TEXTOS[1]);

  // desligada também envia na hora (é um pedido do dono); sem grupos, não
  s.rotinas.ativar(id, false);
  assert.equal(s.rotinas.enviarAgora(id).grupos, 2);
  assert.equal(rotina(s, id).next_run_at, null);
  s.db.prepare('DELETE FROM groups').run();
  assert.throws(() => s.rotinas.enviarAgora(id), recusa('Os grupos desta rotina não existem mais. Edite a rotina e escolha os grupos de novo.'));
  assert.throws(() => s.rotinas.enviarAgora(999), recusa('Rotina não encontrada.', 404));
  assert.throws(() => s.rotinas.enviarAgora('abc'), recusa('Rotina não encontrada.', 404));
});

// ------------------------------------------------------------------------------------------- editar, ligar, excluir

test('editar: recalcula o próximo horário, mantém o que não veio e não muda o tipo', () => {
  const s = montar();
  const { id } = s.rotinas.criar(BOM_DIA());
  s.relogio.t = em(5, 9);
  assert.deepEqual(s.rotinas.atualizar(id, { repetir: { dias: [3], horarios: ['12:00'] } }), { id, next_run_at: em(7, 12) });
  let r = rotina(s, id);
  assert.equal(r.next_run_at, em(7, 12), 'segunda 09:00 → quarta 12:00');
  assert.equal(r.nome, 'Bom dia');
  assert.deepEqual(JSON.parse(r.conteudos), TEXTOS);
  assert.equal(r.updated_at, em(5, 9));

  s.rotinas.atualizar(id, { ...BOM_DIA(), nome: 'Bom dia útil', conteudos: ['Só um'], tipo: 'mensagem' });
  r = rotina(s, id);
  assert.equal(r.nome, 'Bom dia útil');
  assert.deepEqual(JSON.parse(r.conteudos), ['Só um']);
  assert.equal(r.next_run_at, em(6, 8));

  assert.throws(() => s.rotinas.atualizar(id, { tipo: 'enquete', conteudos: [ENQUETE] }),
    recusa('O tipo de uma rotina não muda. Crie outra rotina para mudar de mensagem para enquete.'));
  assert.throws(() => s.rotinas.atualizar(id, { nome: '' }), recusa('Dê um nome à rotina.'));
  assert.throws(() => s.rotinas.atualizar(999, BOM_DIA()), recusa('Rotina não encontrada.', 404));
  assert.equal(rotina(s, id).nome, 'Bom dia útil', 'o erro não grava nada');

  // salvar desligada: sem próximo horário; salvar ligada de novo: recalcula
  s.rotinas.atualizar(id, { enabled: false });
  assert.equal(rotina(s, id).next_run_at, null);
  assert.equal(rotina(s, id).enabled, 0);
  s.rotinas.atualizar(id, { enabled: true });
  assert.equal(rotina(s, id).next_run_at, em(6, 8));
});

test('editar no meio: a ocorrência lida antes da edição não grava (a trava vê a mudança)', async () => {
  const s = montar();
  const { id } = s.rotinas.criar(BOM_DIA());
  const original = s.db.prepare.bind(s.db);
  let editou = false;
  s.db.prepare = (sql) => {
    const st = original(sql);
    if (editou || !/FROM rotinas WHERE enabled = 1/.test(sql)) return st;
    return { all: (...a) => { const l = st.all(...a); editou = true; s.relogio.t = em(5, 8, 1); s.rotinas.atualizar(id, { conteudos: ['Novo'] }); return l; } };
  };
  try { assert.equal(await s.rotinas.processarPendentes(em(5, 8, 1)), 0); } finally { s.db.prepare = original; }
  assert.ok(editou);
  assert.equal(enviosDa(s).length, 0, 'nada sai com o texto velho');
  assert.equal(rotina(s, id).next_run_at, em(6, 8));
});

test('ligar e desligar: desligar = sem próximo horário; ligar recalcula a partir de agora', async () => {
  const s = montar();
  const { id } = s.rotinas.criar(BOM_DIA());
  s.relogio.t = em(5, 9);
  assert.deepEqual(s.rotinas.ativar(id, false), { ok: true, enabled: false, next_run_at: null });
  assert.equal(rotina(s, id).enabled, 0);
  assert.equal(rotina(s, id).next_run_at, null);
  assert.equal(await s.rotinas.processarPendentes(em(9, 8)), 0);
  s.relogio.t = em(9, 9);
  assert.deepEqual(s.rotinas.ativar(id, true), { ok: true, enabled: true, next_run_at: em(10, 8) });
  assert.equal(logs(s).length, 0, 'religar não acusa os horários de quando estava desligada');
  assert.throws(() => s.rotinas.ativar(id, 'true'), recusa('Ativo: ligue ou desligue.'));
  assert.throws(() => s.rotinas.ativar(0, true), recusa('Rotina não encontrada.', 404));
});

test('excluir: some a rotina; o envio já gravado e o Histórico ficam', async () => {
  const s = montar();
  const { id } = s.rotinas.criar(BOM_DIA());
  await s.rotinas.processarPendentes(em(5, 8));
  await s.envios.runEnvio(enviosDa(s)[0].id);
  assert.deepEqual(s.rotinas.apagar(id), { ok: true });
  assert.equal(rotina(s, id), undefined);
  assert.equal(enviosDa(s).length, 1);
  assert.equal(logs(s).filter((l) => l.rule_name === 'Grupo vivo: Bom dia').length, 2);
  assert.throws(() => s.rotinas.apagar(id), recusa('Rotina não encontrada.', 404));
  // o id da excluída não volta: os envios dela não passam a contar para outra
  const outra = s.rotinas.criar({ ...BOM_DIA(), nome: 'Nova' });
  assert.ok(outra.id > id);
  assert.equal(s.rotinas.listar().find((r) => r.id === outra.id).enviadas_24h, 0);
});

// ------------------------------------------------------------------------------------------- lista e painel

test('listar: campos do contrato, contagens de 24 h e o último erro pelo nome do grupo, sem JID fora de group_jids', async () => {
  const s = montar();
  const a = s.rotinas.criar(BOM_DIA());
  const b = s.rotinas.criar({ ...BOM_DIA(), nome: 'Boa noite', group_jids: [G3], enabled: false });
  s.relogio.t = Date.now();
  // envios da rotina A: dois resultados ok e um erro no Tech; um erro antigo (fora das 24 h)
  await s.rotinas.processarPendentes(rotina(s, a.id).next_run_at);
  const envioId = enviosDa(s)[0].id;
  const ins = s.db.prepare('INSERT INTO envio_resultados (envio_id, ocorrencia, ts, jid, group_name, ok, erro) VALUES (?,?,?,?,?,?,?)');
  ins.run(envioId, 1, s.relogio.t - 2 * DIA, G1, 'Achadinhos', 0, 'velho');
  ins.run(envioId, 1, s.relogio.t - 3000, G1, 'Achadinhos', 1, null);
  ins.run(envioId, 1, s.relogio.t - 2000, G2, 'Tech', 0, 'Falha no envio: o número saiu do grupo');
  ins.run(envioId, 1, s.relogio.t - 1000, G1, 'Achadinhos', 1, null);
  const lista = s.rotinas.listar();
  assert.deepEqual(lista.map((r) => Object.keys(r).sort()), [a, b].map(() => ['conteudos', 'enabled', 'enviadas_24h', 'erros_24h', 'group_jids',
    'id', 'next_run_at', 'nome', 'ordem', 'repetir', 'tipo', 'ultimo_erro_grupo']));
  const [ra, rb] = lista;
  assert.deepEqual({ ...ra, next_run_at: typeof ra.next_run_at }, {
    id: a.id, nome: 'Bom dia', enabled: true, tipo: 'mensagem', conteudos: TEXTOS, ordem: 'rodizio', group_jids: [G1, G2],
    repetir: { dias: TODOS, horarios: ['08:00'] }, next_run_at: 'number', enviadas_24h: 2, erros_24h: 1, ultimo_erro_grupo: 'Tech',
  });
  assert.deepEqual({ ...rb }, { id: b.id, nome: 'Boa noite', enabled: false, tipo: 'mensagem', conteudos: TEXTOS, ordem: 'rodizio',
    group_jids: [G3], repetir: { dias: TODOS, horarios: ['08:00'] }, next_run_at: null, enviadas_24h: 0, erros_24h: 0, ultimo_erro_grupo: null });
  const semJids = JSON.stringify(lista.map(({ group_jids: _g, ...r }) => r));
  assert.doesNotMatch(semJids, /@g\.us|@s\.whatsapp\.net|120363/);

  // o Tech recebeu depois do erro: o problema some
  ins.run(envioId, 1, s.relogio.t - 500, G2, 'Tech', 1, null);
  assert.equal(s.rotinas.listar()[0].ultimo_erro_grupo, null);
  // grupo apagado e resultado sem nome: nome guardado em groups não existe mais
  ins.run(envioId, 1, s.relogio.t - 100, G3, null, 0, 'x');
  s.db.prepare('DELETE FROM groups WHERE jid = ?').run(G3);
  assert.equal(s.rotinas.listar()[0].ultimo_erro_grupo, '(grupo removido)');
  // payload ilegível em outro envio não derruba a lista
  s.db.prepare("INSERT INTO envios (tipo, payload, group_jids, quando, status, created_at) VALUES ('mensagem', '{x', '[]', 'agora', 'erro', 1)").run();
  assert.equal(s.rotinas.listar().length, 2);
});

test('painel de Disparar mensagem não mostra nem conta o que é das rotinas', async () => {
  const s = montar();
  const antes = await s.envios.painel('mensagem');
  await s.envios.criar({ tipo: 'mensagem', texto: 'Aviso pontual', group_jids: [G1], quando: 'repetir', repetir: { dias: [1], horarios: ['10:00'] } });
  const { id } = await s.envios.criar({ tipo: 'mensagem', texto: 'Agora mesmo', group_jids: [G1] });
  await s.envios.runEnvio(id);
  s.rotinas.criar(BOM_DIA());
  s.rotinas.criar({ ...BOM_DIA(), nome: 'Enquete', tipo: 'enquete', conteudos: [ENQUETE] });
  await s.rotinas.processarPendentes(em(5, 8));
  const [m, q] = enviosDa(s).filter((e) => e.payload.origem?.tipo === 'rotina');
  await s.envios.runEnvio(m.id);
  // a enquete fica na fila (pendente) e uma rotina repetida falsa (agendada) também não pode aparecer
  s.db.prepare(`INSERT INTO envios (tipo, payload, group_jids, quando, repetir, status, next_run_at, created_at)
    VALUES ('mensagem', ?, ?, 'repetir', ?, 'pendente', ?, 1)`).run(JSON.stringify({ texto: 'x', imagem: 'nenhuma', origem: { tipo: 'rotina', rotina_id: 9, nome: 'x' } }),
    JSON.stringify([G1]), JSON.stringify({ dias: [1], horarios: ['10:00'] }), Date.now() + DIA);
  // e um envio de mensagem com payload ilegível não derruba o painel
  s.db.prepare("INSERT INTO envios (tipo, payload, group_jids, quando, status, created_at) VALUES ('mensagem', '{x', '[]', 'agora', 'erro', ?)").run(Date.now());
  const p = await s.envios.painel('mensagem');
  assert.equal(antes.contadores.enviados, 0);
  assert.deepEqual(p.agendadas.map((a) => a.titulo), ['Aviso pontual']);
  assert.equal(p.contadores.enviados, 1, 'só o "Agora mesmo"');
  assert.equal(p.contadores.na_fila, 1, 'só o "Aviso pontual" agendado: a enquete da rotina na fila e a rotina falsa não contam');
  assert.ok(p.linhas.every((l) => !TEXTOS.includes(l.titulo) && l.titulo !== ENQUETE.pergunta), JSON.stringify(p.linhas.map((l) => l.titulo)));
  assert.ok(p.linhas.some((l) => l.titulo === 'Agora mesmo'));
  assert.ok(q, 'a enquete da rotina foi gravada');
  // o painel de ofertas segue igual
  assert.equal((await s.envios.painel('oferta')).linhas.length, 0);
});

// ------------------------------------------------------------------------------------------- rotas

async function subirRotas(ctx) {
  const app = express();
  app.use(express.json());
  montarRotas(app, ctx);
  const srv = await new Promise((ok) => { const x = app.listen(0, '127.0.0.1', () => ok(x)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const pedir = async (metodo, url, corpo) => {
    const r = await fetchLocal(base + url, { method: metodo, headers: { 'content-type': 'application/json' }, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
    return { status: r.status, texto: await r.text() };
  };
  return { pedir, fechar: () => new Promise((ok) => srv.close(ok)) };
}

test('rotas: listar, criar, editar, ligar, enviar agora e excluir; erros com a frase e o status certos', async () => {
  const s = montar({ conectado: false });
  const { pedir, fechar } = await subirRotas({ scheduler: { rotinas: s.rotinas } });
  try {
    assert.deepEqual(await pedir('GET', '/api/rotinas'), { status: 200, texto: '[]' });
    let r = await pedir('POST', '/api/rotinas', { ...BOM_DIA(), nome: '' });
    assert.deepEqual(r, { status: 400, texto: JSON.stringify({ erro: 'Dê um nome à rotina.' }) });
    r = await pedir('POST', '/api/rotinas', BOM_DIA());
    assert.equal(r.status, 200);
    const { id } = JSON.parse(r.texto);
    assert.equal(JSON.parse((await pedir('GET', '/api/rotinas')).texto)[0].nome, 'Bom dia');
    r = await pedir('PUT', `/api/rotinas/${id}`, { nome: 'Bom dia útil' });
    assert.equal(r.status, 200);
    assert.equal(rotina(s, id).nome, 'Bom dia útil');
    r = await pedir('POST', `/api/rotinas/${id}/enabled`, { enabled: false });
    assert.deepEqual(JSON.parse(r.texto), { ok: true, enabled: false, next_run_at: null });
    r = await pedir('POST', `/api/rotinas/${id}/enviar`);
    assert.deepEqual(r, { status: 400, texto: JSON.stringify({ erro: DESCONECTADO }) });
    s.wa.connect();
    r = await pedir('POST', `/api/rotinas/${id}/enviar`);
    assert.deepEqual(JSON.parse(r.texto), { envio_id: 1, grupos: 2 });
    assert.deepEqual(await pedir('PUT', '/api/rotinas/999', BOM_DIA()), { status: 404, texto: JSON.stringify({ erro: 'Rotina não encontrada.' }) });
    assert.equal((await pedir('DELETE', '/api/rotinas/x')).status, 404);
    assert.deepEqual(await pedir('DELETE', `/api/rotinas/${id}`), { status: 200, texto: '{"ok":true}' });
    assert.deepEqual(await pedir('GET', '/api/rotinas'), { status: 200, texto: '[]' });
  } finally { await fechar(); }

  // sem o serviço: 503; falha inesperada: 500 sem a mensagem do banco nem no console
  const sem = await subirRotas({});
  try {
    assert.deepEqual(await sem.pedir('GET', '/api/rotinas'), { status: 503, texto: JSON.stringify({ erro: 'O Grupo vivo não está disponível neste servidor.' }) });
  } finally { await sem.fechar(); }
  const quebrado = { listar() { throw Object.assign(new Error('UNIQUE constraint failed: segredo 5535999991234'), { code: 'ERR_SQLITE_ERROR' }); } };
  const q = await subirRotas({ rotinas: quebrado });
  const erros = [];
  const err = console.error; console.error = (...x) => erros.push(x.join(' '));
  try {
    assert.deepEqual(await q.pedir('GET', '/api/rotinas'), { status: 500, texto: JSON.stringify({ erro: 'Não consegui concluir. Tente de novo.' }) });
  } finally { console.error = err; await q.fechar(); }
  assert.deepEqual(erros, ['[grupo vivo] falha inesperada: ERR_SQLITE_ERROR']);
});

test('nenhum acesso à rede no arquivo inteiro', () => {
  assert.equal(acessosRede, 0);
});
