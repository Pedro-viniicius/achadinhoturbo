// Proteção do número (plano anti-banimento, etapa 2): o porteiro src/ritmo.js, com relógio de parede, relógio
// monotônico, aleatório e espera injetados (nada aqui depende da hora em que o teste roda nem dorme de verdade).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, getSetting, setSetting } from '../src/db.js';
import { createWhatsApp } from '../src/whatsapp.js';
import {
  createRitmo, semearProtecao, validarProtecao, pausaGrupoGravada, pausaOfertaGravada, LIMITE_HORA_PADRAO, LIMITE_HORA_MAX, SILENCIO_PADRAO,
  PAUSA_MIN_GRUPO_S, PAUSA_MIN_OFERTA_S, PAUSA_MAX_GRUPO_S, PAUSA_MAX_OFERTA_S, ERRO_LIMITE_HORA, ERRO_SILENCIO_IGUAIS, ERRO_SILENCIO_HORA, ERRO_SILENCIO_ATIVO,
} from '../src/ritmo.js';

const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-ritmo-')); pastas.push(p); return p; };

const MIN = 60000;
const HORA = 60 * MIN;
/** Hora local de novembro de 2026 (o silêncio usa o relógio do computador, como o "Funciona das"). */
const em = (dia, h, mi = 0) => new Date(2026, 10, dia, h, mi).getTime();

/**
 * Banco novo + ritmo com relógios de mentira: `r.t` é o relógio de parede, `r.m` o monotônico; `dormir` anota a
 * espera e avança os dois (a não ser com `parado: true`). `r.sorteio` é o aleatório (0,5 = o valor do meio).
 */
function montar({ parado = false, ...opts } = {}) {
  const db = openDb(tmp());
  const r = { t: em(10, 12), m: 1000, sorteio: 0.5, dormidas: [] };
  const ritmo = createRitmo({
    db, agora: () => r.t, monotonico: () => r.m, aleatorio: () => r.sorteio,
    dormir: async (ms) => { r.dormidas.push(ms); if (!parado) { r.m += ms; r.t += ms; } },
    ...opts,
  });
  return { db, r, ritmo };
}
const saidas = (db) => db.prepare('SELECT ts FROM wa_saidas ORDER BY ts').all().map((x) => Number(x.ts));
/** Registra uma saída na hora `ts` (relógio de parede). */
const saiuEm = (s, ts) => { s.r.t = ts; s.ritmo.registrar(); };
const ligarSilencio = (db, de = '23:00', ate = '07:00') => {
  setSetting(db, 'wa_silencio_ativo', '1'); setSetting(db, 'wa_silencio_de', de); setSetting(db, 'wa_silencio_ate', ate);
};
const logs = (db) => db.prepare('SELECT rule_name, level, message FROM log ORDER BY id').all().map((x) => ({ ...x }));

/** WhatsApp de mentira: anota cada chamada com a hora monotônica; `falhar` faz o próximo envio lançar. */
function waFalso(r) {
  const chamadas = [];
  const wa = {
    falhar: null,
    isReady: () => true,
    async sendText(jid, text) { if (wa.falhar) { const e = wa.falhar; wa.falhar = null; throw e; } chamadas.push({ fn: 'sendText', jid, text, m: r.m }); return 'ok-texto'; },
    async sendImage(jid, img, caption) { chamadas.push({ fn: 'sendImage', jid, img, caption, m: r.m }); },
    async sendPoll(jid, enquete) { chamadas.push({ fn: 'sendPoll', jid, enquete, m: r.m }); },
  };
  return { wa, chamadas };
}

// ---------- configuração: desligado sem configuração, semente e validação ----------

test('CA1/CA6: sem configuração no banco, teto e silêncio ficam desligados (testes não dependem da hora)', () => {
  const s = montar();
  for (let i = 0; i < 300; i++) saiuEm(s, em(10, 12) + i * 1000);
  s.r.t = em(10, 12, 5);
  const u = s.ritmo.uso();
  assert.equal(u.limite, null);
  assert.equal(u.usados, 300, 'a contagem segue, para o painel');
  assert.equal(u.libera_em, null);
  assert.deepEqual(s.ritmo.liberado(em(10, 3), { precisa: 50 }), { ok: true });
  const sil = s.ritmo.silencio(em(10, 3));
  assert.equal(sil.ativo, false); assert.equal(sil.agora, false); assert.equal(sil.ate_ts, null);
  assert.deepEqual([sil.de, sil.ate], [SILENCIO_PADRAO.de, SILENCIO_PADRAO.ate], 'o painel mostra o padrão nos campos desligados');
});

test('CA1/CA6: semearProtecao grava 40/h e silêncio 23:00–07:00 e não sobrescreve o que o dono escolheu', () => {
  const { db } = montar();
  assert.equal(LIMITE_HORA_PADRAO, 40); assert.equal(LIMITE_HORA_MAX, 200);
  assert.deepEqual({ ...SILENCIO_PADRAO }, { de: '23:00', ate: '07:00' });
  semearProtecao(db);
  assert.deepEqual(['wa_limite_hora', 'wa_silencio_ativo', 'wa_silencio_de', 'wa_silencio_ate'].map((k) => getSetting(db, k)), ['40', '1', '23:00', '07:00']);

  const outro = montar().db;
  setSetting(outro, 'wa_silencio_ativo', '0'); setSetting(outro, 'wa_limite_hora', '12');
  semearProtecao(outro); semearProtecao(outro);
  assert.equal(getSetting(outro, 'wa_silencio_ativo'), '0', 'silêncio desligado pelo dono continua desligado');
  assert.equal(getSetting(outro, 'wa_limite_hora'), '12');
  assert.equal(getSetting(outro, 'wa_silencio_de'), '23:00', 'só o que faltava foi gravado');
});

test('CA1/CA6: semeado, o ritmo já vem ligado (teto 40 e silêncio de madrugada)', () => {
  const s = montar();
  semearProtecao(s.db);
  assert.equal(s.ritmo.uso().limite, 40);
  assert.equal(s.ritmo.silencio(em(10, 3)).agora, true);
  assert.equal(s.ritmo.silencio(em(10, 12)).agora, false);
});

test('validarProtecao: aceita o corpo do cartão e devolve só os campos presentes, normalizados', () => {
  assert.deepEqual(
    validarProtecao({ limite_hora: 40, silencio_ativo: true, silencio_de: '23:00', silencio_ate: '07:00', delay_group_s: 6, delay_offer_s: '30', outro: 1 }),
    { limite_hora: 40, silencio_ativo: true, silencio_de: '23:00', silencio_ate: '07:00', delay_group_s: 6, delay_offer_s: 30 });
  assert.deepEqual(validarProtecao({ limite_hora: '1', silencio_ativo: false }), { limite_hora: 1, silencio_ativo: false });
  assert.deepEqual(validarProtecao({ limite_hora: 200, delay_group_s: PAUSA_MIN_GRUPO_S, delay_offer_s: PAUSA_MIN_OFERTA_S }),
    { limite_hora: 200, delay_group_s: 2, delay_offer_s: 5 });
  assert.deepEqual(validarProtecao({ limite_hora: null, silencio_de: undefined }), {});
  assert.deepEqual(validarProtecao(null), {});
  assert.deepEqual(validarProtecao({ silencio_de: '00:00', silencio_ate: '23:59' }), { silencio_de: '00:00', silencio_ate: '23:59' });
});

test('validarProtecao: recusa com a frase da spec (teto, horários, Das = Até, pausas)', () => {
  for (const v of [0, 201, 40.5, -1, '', ' ', 'abc', '4e1', true, [40], {}, Infinity, NaN]) {
    assert.throws(() => validarProtecao({ limite_hora: v }), { message: ERRO_LIMITE_HORA }, `limite_hora ${JSON.stringify(v)}`);
  }
  assert.equal(ERRO_LIMITE_HORA, 'Use um número inteiro de 1 a 200.');
  for (const v of ['1', 1, 'sim', 0]) assert.throws(() => validarProtecao({ silencio_ativo: v }), { message: ERRO_SILENCIO_ATIVO });
  for (const v of ['24:00', '7:00', '07:60', '07:00:00', '', 700, ' 07:00']) {
    assert.throws(() => validarProtecao({ silencio_de: v }), { message: ERRO_SILENCIO_HORA }, `de ${JSON.stringify(v)}`);
    assert.throws(() => validarProtecao({ silencio_ate: v }), { message: ERRO_SILENCIO_HORA }, `até ${JSON.stringify(v)}`);
  }
  assert.equal(ERRO_SILENCIO_IGUAIS, 'Escolha dois horários diferentes.');
  assert.throws(() => validarProtecao({ silencio_de: '07:00', silencio_ate: '07:00' }), { message: ERRO_SILENCIO_IGUAIS });
  // só um dos dois no corpo: compara com o gravado
  assert.throws(() => validarProtecao({ silencio_de: '07:00' }, { silencio_de: '23:00', silencio_ate: '07:00' }), { message: ERRO_SILENCIO_IGUAIS });
  assert.deepEqual(validarProtecao({ silencio_de: '22:00' }, { silencio_de: '23:00', silencio_ate: '07:00' }), { silencio_de: '22:00' });
  for (const v of [1, 2.5, '1', 'x', -6, 61, '61']) assert.throws(() => validarProtecao({ delay_group_s: v }), { message: 'Use um número inteiro de 2 a 60.' }, `grupo ${v}`);
  for (const v of [4, 5.5, '', 601, 1e6]) assert.throws(() => validarProtecao({ delay_offer_s: v }), { message: 'Use um número inteiro de 5 a 600.' }, `oferta ${v}`);
  // os máximos (etapa 6): a pausa entre grupos vale para toda mensagem, inclusive os avisos privados ao dono
  assert.deepEqual([PAUSA_MAX_GRUPO_S, PAUSA_MAX_OFERTA_S], [60, 600]);
  assert.deepEqual(validarProtecao({ delay_group_s: 60, delay_offer_s: '600' }), { delay_group_s: 60, delay_offer_s: 600 });
});

test('validarProtecao valida tudo antes: um campo inválido no fim recusa o corpo inteiro', () => {
  assert.throws(() => validarProtecao({ limite_hora: 40, silencio_ativo: true, silencio_de: '23:00', silencio_ate: '07:00', delay_group_s: 6, delay_offer_s: 1 }),
    { message: 'Use um número inteiro de 5 a 600.' });
});

// ---------- teto: janela deslizante, libera_em e registro ----------

test('CA1: janela deslizante de 60 min — a saída de 60 min atrás já não conta e a vaga volta no minuto certo', () => {
  const s = montar();
  setSetting(s.db, 'wa_limite_hora', '3');
  const T = em(10, 12);
  saiuEm(s, T - 59 * MIN); saiuEm(s, T - 30 * MIN); saiuEm(s, T - 10 * MIN);
  s.r.t = T;
  assert.deepEqual(s.ritmo.uso(), { limite: 3, usados: 3, libera_em: T + MIN });
  assert.deepEqual(s.ritmo.liberado(), { ok: false, motivo: 'limite', ate: T + MIN, limite: 3, usados: 3 });
  assert.deepEqual(s.ritmo.liberado(T + MIN - 1).ok, false, 'um ms antes ainda está cheio');
  assert.deepEqual(s.ritmo.liberado(T + MIN), { ok: true });
  assert.deepEqual(s.ritmo.uso(T + MIN), { limite: 3, usados: 2, libera_em: null });
  // não é hora cheia: às 12:00 a janela não zera
  assert.equal(s.ritmo.uso(em(10, 12, 0)).usados, 3);
});

test('CA1: teto reduzido abaixo do uso — libera_em espera sair o excesso e mais uma', () => {
  const s = montar();
  const T = em(10, 12);
  for (let i = 0; i < 10; i++) saiuEm(s, T - 50 * MIN + i * MIN); // 11:10, 11:11 … 11:19
  setSetting(s.db, 'wa_limite_hora', '5');
  s.r.t = T;
  const u = s.ritmo.uso();
  assert.equal(u.usados, 10);
  assert.equal(u.libera_em, T - 50 * MIN + 5 * MIN + HORA, 'a 6ª mais antiga (11:15) sai às 12:15');
  const l = s.ritmo.liberado();
  assert.equal(l.motivo, 'limite'); assert.equal(l.ate, u.libera_em);
  assert.equal(s.ritmo.liberado(u.libera_em - 1).ok, false);
  assert.equal(s.ritmo.liberado(u.libera_em).ok, true);
});

test('CA1: precisa — a regra pede vagas para todos os grupos, preso ao teto', () => {
  const s = montar();
  setSetting(s.db, 'wa_limite_hora', '5');
  const T = em(10, 12);
  saiuEm(s, T - 40 * MIN); saiuEm(s, T - 30 * MIN); saiuEm(s, T - 20 * MIN);
  s.r.t = T;
  assert.deepEqual(s.ritmo.liberado(T, { precisa: 2 }), { ok: true });
  assert.deepEqual(s.ritmo.liberado(T, { precisa: 3 }), { ok: false, motivo: 'limite', ate: T - 40 * MIN + HORA, limite: 5, usados: 3 });
  // 50 grupos com teto 5: espera o teto inteiro vagar (a 3ª mais antiga), não para sempre
  assert.equal(s.ritmo.liberado(T, { precisa: 50 }).ate, T - 20 * MIN + HORA);
  for (const p of [0, -3, 'x', null]) assert.equal(s.ritmo.liberado(T, { precisa: p }).ok, true, `precisa ${p} vale 1`);
});

test('CA1: registrar grava só a hora e apaga o que passou de 2 h', () => {
  const s = montar();
  const T = em(10, 12);
  saiuEm(s, T - 3 * HORA); saiuEm(s, T - 2 * HORA - 1); saiuEm(s, T - 90 * MIN);
  assert.equal(saidas(s.db).length, 3);
  saiuEm(s, T);
  assert.deepEqual(saidas(s.db), [T - 90 * MIN, T]);
  assert.deepEqual(s.db.prepare('PRAGMA table_info(wa_saidas)').all().map((c) => c.name), ['ts'], 'sem jid, número nem conteúdo');
});

test('CA1: relógio do computador atrasado em dias não trava o teto (saídas "do futuro" não contam)', () => {
  const s = montar();
  setSetting(s.db, 'wa_limite_hora', '2');
  const T = em(10, 12);
  saiuEm(s, T + 24 * HORA); saiuEm(s, T + 24 * HORA + MIN);
  s.r.t = T; // o relógio voltou um dia
  assert.equal(s.ritmo.uso().usados, 0);
  assert.equal(s.ritmo.liberado().ok, true);
  s.ritmo.registrar();
  assert.deepEqual(saidas(s.db), [T], 'e a próxima saída limpa as do futuro');
});

// ---------- CA3: uma linha de aviso por vez que o teto enche ----------

test('CA3: teto cheio deixa UMA linha aviso com a hora de liberação, nunca erro, e não uma por mensagem segurada', () => {
  const s = montar();
  setSetting(s.db, 'wa_limite_hora', '4');
  const T = em(10, 12);
  for (const m of [50, 40, 30, 20]) saiuEm(s, T - m * MIN); // 11:10 … 11:40
  s.r.t = T;
  const l = s.ritmo.liberado();
  assert.equal(s.ritmo.avisarLimite(null, l), true);
  for (let i = 0; i < 5; i++) assert.equal(s.ritmo.avisarLimite(null, s.ritmo.liberado()), false);
  assert.deepEqual(logs(s.db), [{ rule_name: 'Proteção do número', level: 'aviso', message: 'Limite de 4 mensagens por hora atingido: o que falta sai a partir das 12:10.' }]);

  // sobrecarga contínua: a vaga das 12:10 é ocupada logo e o teto enche de novo — continua uma linha só
  s.r.t = em(10, 12, 10); assert.equal(s.ritmo.liberado().ok, true); s.ritmo.registrar();
  assert.equal(s.ritmo.avisarLimite(null, s.ritmo.liberado()), false);
  assert.equal(logs(s.db).length, 1);
});

test('CA3: o episódio do teto acaba quando metade do teto vaga; o próximo teto cheio escreve de novo', () => {
  const s = montar();
  setSetting(s.db, 'wa_limite_hora', '4');
  const T = em(10, 12);
  for (const m of [50, 40, 30, 20]) saiuEm(s, T - m * MIN);
  s.r.t = T;
  s.ritmo.avisarLimite(null, s.ritmo.liberado());
  s.r.t = em(10, 12, 25); // saíram 11:10 e 11:20: 2 de 4
  assert.equal(s.ritmo.uso().usados, 2);
  saiuEm(s, em(10, 12, 26)); saiuEm(s, em(10, 12, 27));
  assert.equal(s.ritmo.avisarLimite(null, s.ritmo.liberado()), true);
  assert.equal(logs(s.db).at(-1).message, 'Limite de 4 mensagens por hora atingido: o que falta sai a partir das 12:30.');
  assert.equal(logs(s.db).length, 2);
});

test('CA3: sobrecarga que dura mais de uma hora ganha uma linha nova por hora, não por mensagem', () => {
  const s = montar();
  setSetting(s.db, 'wa_limite_hora', '4');
  let t = em(10, 11);
  for (let i = 0; i < 4; i++) saiuEm(s, t + i * 15 * MIN); // 11:00, 11:15, 11:30, 11:45
  s.r.t = em(10, 11, 50);
  s.ritmo.avisarLimite(null, s.ritmo.liberado());
  // a fila ocupa cada vaga assim que abre, por mais de uma hora
  for (t = em(10, 12); t <= em(10, 13, 15); t += 15 * MIN) {
    s.r.t = t;
    assert.equal(s.ritmo.liberado().ok, true, new Date(t).toTimeString());
    s.ritmo.registrar();
    s.ritmo.avisarLimite(null, s.ritmo.liberado());
  }
  assert.deepEqual(logs(s.db).map((l) => l.message), [
    'Limite de 4 mensagens por hora atingido: o que falta sai a partir das 12:00.',
    'Limite de 4 mensagens por hora atingido: o que falta sai a partir das 13:15.', // às 13:00, mais de uma hora depois da linha
  ]);
});

test('CA3: avisarLimite usa o log de quem chama e ignora silêncio e teto desligado', () => {
  const s = montar();
  const recebidas = [];
  assert.equal(s.ritmo.avisarLimite((l) => recebidas.push(l), { ok: false, motivo: 'silencio', ate: em(10, 7) }), false);
  assert.equal(s.ritmo.avisarLimite((l) => recebidas.push(l), s.ritmo.uso()), false, 'teto desligado');
  setSetting(s.db, 'wa_limite_hora', '1');
  saiuEm(s, em(10, 11, 30));
  s.r.t = em(10, 12);
  assert.equal(s.ritmo.avisarLimite((l) => recebidas.push(l), s.ritmo.uso()), true, 'aceita também o uso() (libera_em)');
  assert.deepEqual(recebidas, [{ rule: { id: null, name: 'Proteção do número' }, level: 'aviso', message: 'Limite de 1 mensagens por hora atingido: o que falta sai a partir das 12:30.' }]);
  assert.equal(logs(s.db).length, 0, 'com log próprio, nada vai direto ao Histórico');
});

// ---------- CA6: horário de silêncio ----------

test('CA6: silêncio que vira a noite (23:00–07:00), com o fim do silêncio atual', () => {
  const s = montar();
  ligarSilencio(s.db);
  const casos = [
    [em(10, 22, 59), false, null],
    [em(10, 23, 0), true, em(11, 7)],
    [em(11, 0, 0), true, em(11, 7)],
    [em(11, 3, 0), true, em(11, 7)],
    [em(11, 6, 59), true, em(11, 7)],
    [em(11, 7, 0), false, null],
    [em(11, 12, 0), false, null],
  ];
  for (const [ts, dentro, ate] of casos) {
    const r = s.ritmo.silencio(ts);
    assert.deepEqual(r, { ativo: true, de: '23:00', ate: '07:00', agora: dentro, ate_ts: ate }, new Date(ts).toString());
    assert.deepEqual(s.ritmo.liberado(ts), dentro ? { ok: false, motivo: 'silencio', ate } : { ok: true });
  }
});

test('CA6: silêncio no mesmo dia (13:00–14:00) e configuração inválida vale como desligado', () => {
  const s = montar();
  ligarSilencio(s.db, '13:00', '14:00');
  assert.equal(s.ritmo.silencio(em(10, 12, 59)).agora, false);
  assert.equal(s.ritmo.silencio(em(10, 13, 30)).ate_ts, em(10, 14));
  assert.equal(s.ritmo.silencio(em(10, 14)).agora, false);
  ligarSilencio(s.db, '07:00', '07:00');
  assert.equal(s.ritmo.silencio(em(10, 7, 0)).ativo, false, 'Das = Até gravado à mão não vira silêncio de 24 h');
  ligarSilencio(s.db, '25:00', '07:00');
  assert.equal(s.ritmo.silencio(em(10, 3)).ativo, false);
  ligarSilencio(s.db);
  setSetting(s.db, 'wa_silencio_ativo', '0');
  const r = s.ritmo.silencio(em(10, 3));
  assert.equal(r.ativo, false); assert.equal(r.agora, false);
});

test('CA6: ignorarSilencio deixa passar o silêncio, mas nunca o teto', () => {
  const s = montar();
  ligarSilencio(s.db); setSetting(s.db, 'wa_limite_hora', '1');
  const madrugada = em(11, 2);
  assert.equal(s.ritmo.liberado(madrugada).motivo, 'silencio');
  assert.deepEqual(s.ritmo.liberado(madrugada, { ignorarSilencio: true }), { ok: true });
  saiuEm(s, madrugada - MIN);
  assert.equal(s.ritmo.liberado(madrugada, { ignorarSilencio: true }).motivo, 'limite');
});

test('CA6: atrasoAgora desconta o último período de silêncio do prazo de 2 h da fila', () => {
  const s = montar();
  ligarSilencio(s.db);
  assert.equal(s.ritmo.atrasoAgora(em(10, 23, 30), em(11, 7, 5)), 5 * MIN, 'criado às 23:30, às 07:05: 5 min');
  assert.equal(s.ritmo.atrasoAgora(em(10, 22, 50), em(11, 7, 5)), 15 * MIN, '10 min antes e 5 min depois do silêncio');
  assert.equal(s.ritmo.atrasoAgora(em(11, 7, 2), em(11, 7, 5)), 3 * MIN, 'criado depois do silêncio');
  assert.equal(s.ritmo.atrasoAgora(em(10, 23, 30), em(11, 2)), 0, 'dentro do silêncio, nada conta');
  assert.equal(s.ritmo.atrasoAgora(em(10, 22, 0), em(10, 23, 30)), HORA, 'dentro do silêncio, conta só o que veio antes dele');
  assert.ok(s.ritmo.atrasoAgora(em(9, 7, 5), em(11, 7, 5)) > 2 * HORA, 'criado há 2 dias: mais de 2 h');
  assert.equal(s.ritmo.atrasoAgora(em(11, 7, 10), em(11, 7, 5)), 0, 'no futuro: sem atraso');
  setSetting(s.db, 'wa_silencio_ativo', '0');
  assert.equal(s.ritmo.atrasoAgora(em(10, 23, 30), em(11, 7, 5)), 7 * HORA + 35 * MIN, 'silêncio desligado: o atraso inteiro');
});

// ---------- CA4 e CA5: o embrulho do wa ----------

test('CA5: intervalo mínimo entre duas mensagens de origens diferentes, com a variação de ±30%', async () => {
  const s = montar();
  setSetting(s.db, 'delay_group_s', '10');
  const { wa, chamadas } = waFalso(s.r);
  const w = s.ritmo.embrulhar(wa);
  s.r.sorteio = 0; // a ponta de baixo: 7 s
  await w.sendText('111@g.us', 'oferta da regra');
  await w.sendPoll('5535999990000@s.whatsapp.net', { pergunta: 'p', opcoes: ['a', 'b'] }); // um aviso privado logo depois
  s.r.sorteio = 1; // a ponta de cima: 13 s
  await w.sendImage('222@g.us', 'https://x/y.jpg', 'legenda');
  assert.deepEqual(s.r.dormidas, [7000, 13000]);
  assert.deepEqual(chamadas.map((c) => c.m), [1000, 8000, 21000]);
  // passou mais que a pausa desde a última: sai sem esperar
  s.r.m += 20000; s.r.t += 20000;
  await w.sendText('111@g.us', 'depois');
  assert.equal(s.r.dormidas.length, 2);
});

test('CA5: duas origens ao mesmo tempo (tick e "Enviar teste") saem espaçadas, sem trava', async () => {
  const s = montar({ parado: true });
  setSetting(s.db, 'delay_group_s', '10');
  const { wa, chamadas } = waFalso(s.r);
  const w = s.ritmo.embrulhar(wa);
  s.r.sorteio = 0.5;
  await Promise.all([w.sendText('a@g.us', '1'), w.sendText('b@s.whatsapp.net', '2'), w.sendImage('c@g.us', 'u', '3')]);
  assert.deepEqual(s.r.dormidas, [10000, 20000], 'cada uma reserva a vez seguinte na hora da chamada');
  assert.equal(chamadas.length, 3);
});

test('CA4: toda mensagem conta (texto, foto, enquete, grupo ou privado) e só quando o envio deu certo', async () => {
  const s = montar({ fast: true });
  const { wa, chamadas } = waFalso(s.r);
  const w = s.ritmo.embrulhar(wa);
  assert.equal(await w.sendText('111@g.us', 'a'), 'ok-texto', 'devolve o que o wa devolveu');
  await w.sendImage('111@g.us', 'u', 'b');
  await w.sendPoll('111@g.us', { pergunta: 'p', opcoes: ['a', 'b'] });
  await w.sendText('5535999990000@s.whatsapp.net', 'aviso privado');
  assert.equal(saidas(s.db).length, 4);
  assert.deepEqual(s.r.dormidas, [], 'fast: sem pausa, mas conta');
  const erro = new Error('WhatsApp desconectado');
  wa.falhar = erro;
  await assert.rejects(w.sendText('111@g.us', 'c'), (e) => e === erro, 'o erro do envio chega igual a quem chamou');
  assert.equal(saidas(s.db).length, 4, 'envio que falhou não conta');
  assert.equal(chamadas.length, 4);
});

test('CA5: a pausa conta do FIM do envio anterior, também quando ele falhou (pode ter saído)', async () => {
  const s = montar();
  setSetting(s.db, 'delay_group_s', '10');
  const { wa, chamadas } = waFalso(s.r);
  const w = s.ritmo.embrulhar(wa);
  const enviar = wa.sendText;
  // um envio lento (foto grande, rede ruim): 6 s dentro do Baileys até falhar
  wa.sendText = async () => { s.r.m += 6000; s.r.t += 6000; throw new Error('tempo esgotado'); };
  await assert.rejects(w.sendText('111@g.us', 'a'));
  wa.sendText = enviar;
  await w.sendText('111@g.us', 'b');
  assert.deepEqual(s.r.dormidas, [10000], '10 s depois do fim, não 4 s');
  assert.equal(chamadas[0].m, 1000 + 6000 + 10000);
});

test('CA4: falha ao gravar a contagem não vira falha do envio (a mensagem já saiu) e não vaza o destino', async (t) => {
  const s = montar({ fast: true });
  const { wa, chamadas } = waFalso(s.r);
  const w = s.ritmo.embrulhar(wa);
  const erros = t.mock.method(console, 'error', () => {});
  s.db.exec('DROP TABLE wa_saidas');
  assert.equal(await w.sendText('5535999990000@s.whatsapp.net', 'oi'), 'ok-texto');
  assert.equal(chamadas.length, 1);
  assert.equal(erros.mock.callCount(), 1);
  const impresso = erros.mock.calls[0].arguments.join(' ');
  assert.doesNotMatch(impresso, /5535|whatsapp\.net|oi/);
});

test('CA4: o embrulho chama wa.sendText no momento do envio (troca depois de embrulhado) e herda o resto', async () => {
  const s = montar({ fast: true });
  const { wa } = waFalso(s.r);
  const w = s.ritmo.embrulhar(wa);
  const trocadas = [];
  wa.sendText = async (jid, text) => { trocadas.push([jid, text]); };
  await w.sendText('111@g.us', 'depois da troca');
  assert.deepEqual(trocadas, [['111@g.us', 'depois da troca']]);
  assert.equal(saidas(s.db).length, 1);
  assert.equal(w.isReady(), true);
  wa.isReady = () => false;
  assert.equal(w.isReady(), false, 'o resto vem por herança, também trocado depois');
  assert.equal(s.ritmo.embrulhar(w), w, 'embrulhar de novo não conta em dobro');
  await s.ritmo.embrulhar(w).sendText('111@g.us', 'x');
  assert.equal(saidas(s.db).length, 2);
});

test('CA4: com o WhatsApp simulado, o embrulho não muda o que vai ao WhatsApp', async () => {
  const s = montar({ fast: true });
  const wa = createWhatsApp({ db: s.db, dir: tmp(), dryRun: true });
  wa.connect();
  const w = s.ritmo.embrulhar(wa);
  await w.sendText('111@g.us', 'texto', { previa: 'https://meli.la/abc' });
  await w.sendImage('111@g.us', Buffer.from([1, 2, 3]), 'legenda', { mimetype: 'image/png' });
  await w.sendPoll('111@g.us', { pergunta: 'Qual?', opcoes: ['A', 'B'], multipla: false });
  const direto = createWhatsApp({ db: s.db, dir: tmp(), dryRun: true });
  direto.connect();
  await direto.sendText('111@g.us', 'texto', { previa: 'https://meli.la/abc' });
  await direto.sendImage('111@g.us', Buffer.from([1, 2, 3]), 'legenda', { mimetype: 'image/png' });
  await direto.sendPoll('111@g.us', { pergunta: 'Qual?', opcoes: ['A', 'B'], multipla: false });
  assert.deepEqual(w.simulated, direto.simulated);
  assert.equal(w.simulated, wa.simulated, 'a mesma lista do wa embrulhado');
  assert.equal(saidas(s.db).length, 3);
  await assert.rejects(w.sendPoll('111@g.us', { pergunta: '', opcoes: [] }));
  assert.equal(saidas(s.db).length, 3, 'enquete recusada pela validação não conta');
});

// ---------- rodada 1 de correções: reserva de vagas (S1/Q1/Q2), pausas presas na leitura (S2), reinício (S3) ----------

test('S1: vaga().pedir separa as vagas na hora: o liberado() seguinte já as conta, usar() troca pela saída gravada e soltar() devolve', () => {
  const s = montar();
  setSetting(s.db, 'wa_limite_hora', '3');
  const a = s.ritmo.vaga(); const b = s.ritmo.vaga();
  assert.deepEqual(a.pedir(s.r.t, { precisa: 2 }), { ok: true });
  assert.equal(a.separadas, 2);
  assert.equal(s.ritmo.uso().usados, 0, 'o painel mostra só o que saiu');
  assert.equal(s.ritmo.liberado(s.r.t, { precisa: 2 }).ok, false, 'sobrou 1 vaga');
  assert.equal(b.pedir(s.r.t).ok, true);
  const c = s.ritmo.vaga();
  const cheio = c.pedir(s.r.t);
  assert.equal(cheio.ok, false);
  assert.equal(cheio.ate, s.r.t + HORA, 'as vagas separadas ainda não saíram: no máximo 1 h a partir de agora');
  assert.equal(cheio.usados, 0);
  // a mensagem saiu: a linha de wa_saidas conta no lugar da vaga (nem em dobro nem a menos)
  s.ritmo.registrar(); a.usar();
  assert.equal(a.separadas, 1);
  assert.equal(c.pedir(s.r.t).ok, false, '1 saída + 2 separadas = 3');
  assert.equal(a.pedir(s.r.t).ok, true, 'quem já tem a vaga passa');
  a.soltar(); assert.equal(a.separadas, 0);
  assert.equal(c.pedir(s.r.t).ok, true, 'a vaga solta voltou');
  a.soltar(); a.usar(); // soltar ou usar de novo não devolve vaga que não é dela
  assert.equal(s.ritmo.vaga().pedir(s.r.t).ok, false, 'teto 3: 1 saída + b + c');
});

test('S1: a vaga que já tem o que pede passa com o teto reduzido no meio; teto desligado não separa nada; silêncio vale antes do teto', () => {
  const s = montar();
  setSetting(s.db, 'wa_limite_hora', '5');
  const a = s.ritmo.vaga();
  assert.equal(a.pedir(s.r.t, { precisa: 3 }).ok, true);
  setSetting(s.db, 'wa_limite_hora', '1');
  assert.equal(a.pedir(s.r.t, { precisa: 1 }).ok, true);
  assert.equal(s.ritmo.vaga().pedir(s.r.t).ok, false);
  a.soltar();
  s.db.prepare("DELETE FROM settings WHERE key = 'wa_limite_hora'").run();
  const d = s.ritmo.vaga();
  assert.deepEqual(d.pedir(s.r.t, { precisa: 50 }), { ok: true });
  assert.equal(d.separadas, 0);
  ligarSilencio(s.db, '11:00', '13:00');
  assert.equal(d.pedir(s.r.t).motivo, 'silencio');
  assert.equal(d.pedir(s.r.t, { ignorarSilencio: true }).ok, true);
});

test('S2: pausas gravadas fora da faixa são presas na leitura (delay_group_s=600 vale 60 s; 0,5 vale 2 s; ilegível vale o padrão)', async () => {
  assert.equal(pausaGrupoGravada('600'), PAUSA_MAX_GRUPO_S);
  assert.equal(pausaGrupoGravada('0.5'), PAUSA_MIN_GRUPO_S);
  assert.equal(pausaGrupoGravada('8'), 8);
  assert.equal(pausaGrupoGravada('x'), 6);
  assert.equal(pausaGrupoGravada(null), 6);
  assert.equal(pausaOfertaGravada('100000'), PAUSA_MAX_OFERTA_S);
  assert.equal(pausaOfertaGravada('1'), PAUSA_MIN_OFERTA_S);
  assert.equal(pausaOfertaGravada(undefined), 30);
  const s = montar();
  setSetting(s.db, 'delay_group_s', '600');
  const { wa } = waFalso(s.r);
  const w = s.ritmo.embrulhar(wa);
  s.r.sorteio = 1;
  await w.sendText('a@g.us', '1'); await w.sendText('b@g.us', '2');
  assert.deepEqual(s.r.dormidas, [78000], 'no máximo 60 s × 1,3 entre duas mensagens, mesmo com 600 gravado');
  setSetting(s.db, 'delay_group_s', '0');
  s.r.sorteio = 0;
  await w.sendText('c@g.us', '3');
  assert.deepEqual(s.r.dormidas, [78000, 1400], 'e nunca menos que 2 s × 0,7');
});

test('S3: no reinício, a última saída gravada vale como a última mensagem: a primeira depois do --watch espera a pausa', async () => {
  const db = openDb(tmp());
  setSetting(db, 'delay_group_s', '10');
  const r = { t: em(10, 12), m: 500, dormidas: [] };
  db.prepare('INSERT INTO wa_saidas (ts) VALUES (?)').run(r.t - 1000); // saiu 1 s antes do reinício
  const ritmo = createRitmo({ db, agora: () => r.t, monotonico: () => r.m, aleatorio: () => 0, dormir: async (ms) => { r.dormidas.push(ms); r.m += ms; r.t += ms; } });
  await ritmo.embrulhar(waFalso(r).wa).sendText('a@g.us', 'x');
  assert.deepEqual(r.dormidas, [6000], '7 s de pausa menos o 1 s que já passou');
  // saída "do futuro" (relógio atrasado depois do envio) vale como agora; saída velha não segura nada
  const db2 = openDb(tmp());
  setSetting(db2, 'delay_group_s', '10');
  db2.prepare('INSERT INTO wa_saidas (ts) VALUES (?)').run(r.t + 30 * MIN);
  const d2 = [];
  const r2 = createRitmo({ db: db2, agora: () => r.t, monotonico: () => r.m, aleatorio: () => 0, dormir: async (ms) => { d2.push(ms); } });
  await r2.embrulhar(waFalso(r).wa).sendText('a@g.us', 'x');
  assert.deepEqual(d2, [7000]);
  const db3 = openDb(tmp());
  setSetting(db3, 'delay_group_s', '10');
  db3.prepare('INSERT INTO wa_saidas (ts) VALUES (?)').run(r.t - 5 * MIN);
  const d3 = [];
  const r3 = createRitmo({ db: db3, agora: () => r.t, monotonico: () => r.m, aleatorio: () => 0, dormir: async (ms) => { d3.push(ms); } });
  await r3.embrulhar(waFalso(r).wa).sendText('a@g.us', 'x');
  assert.deepEqual(d3, []);
});
