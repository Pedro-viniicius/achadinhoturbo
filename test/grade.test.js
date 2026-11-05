// Grade de horários do Disparo automático (plano grade-de-disparos, etapa 2, decisão D2): validação e normalização,
// próximo horário com dias da semana, linha de um horário e horário perdido (CA3 e CA6). Módulo puro: sem banco,
// sem rede, sem relógio real (todas as datas são da hora local, como o agendador).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validarGrade, proximoHorario, horarioDe, resolverVencido,
  MAX_HORARIOS_GRADE, INTERVALO_MIN_GRADE, TOLERANCIA_MIN, MAX_QTD_GRADE,
} from '../src/grade.js';
import { proximaOcorrencia } from '../src/envios.js';

const MIN = 60000;
const TOL = TOLERANCIA_MIN * MIN;
// 2026-11-02 é segunda-feira; os testes conferem o dia da semana antes de confiar nele
const em = (dia, h, m = 0) => new Date(2026, 10, dia, h, m).getTime();
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const TEMPLATES = new Set([1, 2, 7]);
const opts = { templateExiste: (id) => TEMPLATES.has(id) };
const linha = (hora, qtd = 3, template_id = null) => ({ hora, qtd, template_id });
const erro = (g, re, o = opts) => assert.throws(() => validarGrade(g, o), (e) => e instanceof Error && re.test(e.message), `esperava erro ${re}`);

test('constantes do plano aprovado pelo dono', () => {
  assert.equal(MAX_HORARIOS_GRADE, 48);
  assert.equal(INTERVALO_MIN_GRADE, 10);
  assert.equal(TOLERANCIA_MIN, 30);
  assert.equal(MAX_QTD_GRADE, 20);
  assert.equal(new Date(em(2, 0)).getDay(), 1, 'o calendário dos testes começa numa segunda');
});

// ---------- validarGrade ----------

test('validarGrade: sem grade (null/undefined) é o modo intervalo', () => {
  assert.equal(validarGrade(null, opts), null);
  assert.equal(validarGrade(undefined, opts), null);
});

test('validarGrade: normaliza (ordena, tira espaços, hora com 2 dígitos, dias sem repetir, template vazio = null)', () => {
  const g = validarGrade({
    dias: [5, '1', 3, 1],
    horarios: [linha(' 18:00 ', '4', 2), linha('9:30', 1, ''), linha('12:00', 20, '7'), { hora: '08:00', qtd: 2 }],
  }, opts);
  assert.deepEqual(g, {
    dias: [1, 3, 5],
    horarios: [linha('08:00', 2, null), linha('09:30', 1, null), linha('12:00', 20, 7), linha('18:00', 4, 2)],
  });
});

test('validarGrade: sem a lista de dias, valem todos (padrão do formulário)', () => {
  assert.deepEqual(validarGrade({ horarios: [linha('10:00')] }, opts).dias, [0, 1, 2, 3, 4, 5, 6]);
});

test('validarGrade: aceita exatamente 48 horários a 10 min um do outro; o 49º é recusado', () => {
  const quarentaEOito = Array.from({ length: 48 }, (_, i) => linha(hhmm(8 * 60 + i * 10)));
  assert.equal(validarGrade({ horarios: quarentaEOito }, opts).horarios.length, 48);
  const quarentaENove = Array.from({ length: 49 }, (_, i) => linha(hhmm(8 * 60 + i * 10)));
  erro({ horarios: quarentaENove }, /no máximo 48 horários/);
});

test('validarGrade: 10 min entre horários seguidos passa; 9 min é recusado (com os dois horários na frase)', () => {
  assert.equal(validarGrade({ horarios: [linha('10:00'), linha('10:10')] }, opts).horarios.length, 2);
  erro({ horarios: [linha('10:09'), linha('10:00')] }, /10:00 e 10:09.*menos de 10 min/);
  erro({ horarios: [linha('08:00'), linha('23:59'), linha('23:50')] }, /23:50 e 23:59/);
});

test('validarGrade: horário repetido é recusado, mesmo escrito de outro jeito', () => {
  erro({ horarios: [linha('10:00'), linha('10:00', 5)] }, /^Já existe um horário às 10:00\.$/);
  erro({ horarios: [linha('9:05'), linha(' 09:05')] }, /^Já existe um horário às 09:05\.$/);
});

test('validarGrade: ofertas de 1 a 20, inteiras (0, 21, fração, texto e falta da qtd são recusados)', () => {
  assert.equal(validarGrade({ horarios: [linha('10:00', 1), linha('11:00', 20)] }, opts).horarios[1].qtd, 20);
  for (const qtd of [0, 21, -1, 1.5, '1.5', 'três', true, null, undefined, Infinity, NaN, [3]]) {
    erro({ horarios: [{ hora: '10:00', qtd, template_id: null }] }, /^Horário 10:00: ofertas de 1 a 20\.$/);
  }
  erro({ horarios: [{ hora: '10:00' }] }, /^Horário 10:00: ofertas de 1 a 20\.$/);
});

test('validarGrade: template inexistente é recusado; sem templateExiste nenhum template passa', () => {
  erro({ horarios: [linha('10:00', 3, 99)] }, /Horário 10:00: o template escolhido não existe/);
  erro({ horarios: [linha('10:00', 3, 'abc')] }, /Horário 10:00: o template escolhido não existe/);
  erro({ horarios: [linha('10:00', 3, 1.5)] }, /Horário 10:00: o template escolhido não existe/);
  erro({ horarios: [linha('10:00', 3, 1)] }, /template escolhido não existe/, {});
  // o mesmo template em várias linhas é consultado uma vez só
  const vistos = [];
  validarGrade({ horarios: [linha('10:00', 3, 2), linha('11:00', 3, 2), linha('12:00', 3, null)] }, { templateExiste: (id) => (vistos.push(id), true) });
  assert.deepEqual(vistos, [2]);
});

test('validarGrade: campos a mais (na grade ou na linha) e formatos errados são recusados', () => {
  erro({ dias: [1], horarios: [linha('10:00')], extra: 1 }, /formato inválido/);
  erro({ horarios: [{ ...linha('10:00'), variacao: 5 }] }, /formato inválido/);
  erro(JSON.parse('{"horarios":[{"hora":"10:00","qtd":3,"__proto__":{"x":1}}]}'), /formato inválido/);
  erro([linha('10:00')], /formato inválido/);
  erro('10:00', /formato inválido/);
  erro({ horarios: ['10:00'] }, /formato inválido/);
  erro({ horarios: [[linha('10:00')]] }, /formato inválido/);
  erro({ horarios: [null] }, /formato inválido/);
});

test('validarGrade: sem horário, hora inválida e dias vazios ou fora de 0..6', () => {
  erro({ horarios: [] }, /^Adicione ao menos um horário\.$/);
  erro({ dias: [1] }, /^Adicione ao menos um horário\.$/);
  erro({ horarios: 'x' }, /^Adicione ao menos um horário\.$/);
  for (const hora of ['24:00', '10:60', '1000', '', null, 10, '10:00:00', 'aa:bb']) {
    erro({ horarios: [linha(hora)] }, /^Horário inválido: use HH:MM\.$/);
  }
  erro({ dias: [], horarios: [linha('10:00')] }, /^Marque ao menos um dia\.$/);
  erro({ dias: 'seg', horarios: [linha('10:00')] }, /^Marque ao menos um dia\.$/);
  for (const d of [7, -1, 1.5, '7', null]) erro({ dias: [d], horarios: [linha('10:00')] }, /^Marque ao menos um dia\.$/);
});

// ---------- proximoHorario ----------

test('proximoHorario: é a proximaOcorrencia do Repetir com as horas da grade, respeitando os dias', () => {
  const g = validarGrade({ dias: [1, 3], horarios: [linha('09:00'), linha('18:30', 5)] }, opts);
  // segunda 08:00 → segunda 09:00; segunda 09:00 (estritamente depois) → segunda 18:30
  assert.equal(proximoHorario(g, em(2, 8)), em(2, 9));
  assert.equal(proximoHorario(g, em(2, 9)), em(2, 18, 30));
  // segunda 19:00 → quarta 09:00 (terça não está nos dias)
  assert.equal(proximoHorario(g, em(2, 19)), em(4, 9));
  // quarta 18:30 → segunda seguinte 09:00
  assert.equal(proximoHorario(g, em(4, 18, 30)), em(9, 9));
  for (const t of [em(2, 0), em(3, 12), em(5, 23, 59), em(8, 7)]) {
    assert.equal(proximoHorario(g, t), proximaOcorrencia({ dias: [1, 3], horarios: ['09:00', '18:30'] }, t));
  }
});

test('proximoHorario: grade ausente ou sem dia válido não tem próximo', () => {
  assert.equal(proximoHorario(null, em(2, 8)), null);
  assert.equal(proximoHorario({ dias: [], horarios: [linha('10:00')] }, em(2, 8)), null);
  assert.equal(proximoHorario({ dias: [9], horarios: [linha('10:00')] }, em(2, 8)), null);
  assert.equal(proximoHorario({ dias: [1], horarios: 'x' }, em(2, 8)), null);
});

// ---------- horarioDe ----------

test('horarioDe: a linha do HH:MM exato do horário, no dia dele', () => {
  const g = validarGrade({ horarios: [linha('09:00', 2, 1), linha('09:30', 5, null), linha('21:00', 20, 7)] }, opts);
  assert.deepEqual(horarioDe(g, em(2, 9, 30)), linha('09:30', 5, null));
  assert.deepEqual(horarioDe(g, em(6, 21)), linha('21:00', 20, 7));
  assert.equal(horarioDe(g, em(2, 9, 31)), null, 'minuto diferente');
  assert.equal(horarioDe(g, em(2, 9, 30) + 1000), null, 'com segundos não é o horário');
  assert.equal(horarioDe(g, em(2, 10)), null);
  assert.equal(horarioDe(g, NaN), null);
  assert.equal(horarioDe(null, em(2, 9)), null);
  // o horário que o proximoHorario devolve sempre tem linha
  assert.deepEqual(horarioDe(g, proximoHorario(g, em(2, 9))), linha('09:30', 5, null));
});

// ---------- resolverVencido ----------

const gradeDe = (dias, ...horas) => validarGrade({ dias, horarios: horas.map((h) => linha(h)) }, opts);
const seguinte = (g) => (h) => proximoHorario(g, h);

test('resolverVencido: 29 min de atraso, o horário sai; o próximo é o seguinte da grade', () => {
  const g = gradeDe([1], '09:00', '12:00');
  assert.deepEqual(resolverVencido(seguinte(g), em(2, 9), em(2, 9, 29), TOL), { executar: em(2, 9), pulados: [], proximo: em(2, 12) });
  assert.deepEqual(resolverVencido(seguinte(g), em(2, 9), em(2, 9, 30), TOL).executar, em(2, 9), '30 min em ponto ainda sai');
});

test('resolverVencido: 31 min de atraso, o horário é pulado', () => {
  const g = gradeDe([1], '09:00', '12:00');
  assert.deepEqual(resolverVencido(seguinte(g), em(2, 9), em(2, 9, 31), TOL), { executar: null, pulados: [em(2, 9)], proximo: em(2, 12) });
});

test('resolverVencido: tolerância padrão é a do plano (30 min)', () => {
  const g = gradeDe([1], '09:00', '12:00');
  assert.equal(resolverVencido(seguinte(g), em(2, 9), em(2, 9, 30)).executar, em(2, 9));
  assert.equal(resolverVencido(seguinte(g), em(2, 9), em(2, 9, 30) + 1).executar, null);
});

test('resolverVencido: três vencidos, sai só o último (sem rajada)', () => {
  const g = gradeDe([1], '09:00', '10:00', '11:00', '15:00');
  assert.deepEqual(resolverVencido(seguinte(g), em(2, 9), em(2, 11, 20), TOL), {
    executar: em(2, 11), pulados: [em(2, 9), em(2, 10)], proximo: em(2, 15),
  });
  // o último também passou da tolerância: os três são pulados
  assert.deepEqual(resolverVencido(seguinte(g), em(2, 9), em(2, 11, 45), TOL), {
    executar: null, pulados: [em(2, 9), em(2, 10), em(2, 11)], proximo: em(2, 15),
  });
});

test('resolverVencido: horário ainda no futuro não é vencido', () => {
  const g = gradeDe([1], '09:00');
  assert.deepEqual(resolverVencido(seguinte(g), em(2, 9), em(2, 8, 59), TOL), { executar: null, pulados: [], proximo: em(2, 9) });
});

test('resolverVencido: nenhum dia válido (grade gravada estragada) não trava nem repete', () => {
  const quebrada = { dias: [], horarios: [linha('09:00')] };
  assert.deepEqual(resolverVencido(seguinte(quebrada), em(2, 9), em(2, 9, 10), TOL), { executar: em(2, 9), pulados: [], proximo: null });
  assert.deepEqual(resolverVencido(seguinte(quebrada), em(2, 9), em(2, 10), TOL), { executar: null, pulados: [em(2, 9)], proximo: null });
  assert.deepEqual(resolverVencido(seguinte(quebrada), null, em(2, 10), TOL), { executar: null, pulados: [], proximo: null });
});

test('resolverVencido: virada da semana (sábado à noite para domingo, e uma semana desligado)', () => {
  assert.equal(new Date(em(7, 23, 50)).getDay(), 6);
  const sabado = gradeDe([6], '22:00', '23:50');
  assert.deepEqual(resolverVencido(seguinte(sabado), em(7, 23, 50), em(8, 0, 15), TOL), {
    executar: em(7, 23, 50), pulados: [], proximo: em(14, 22),
  });
  // só domingo 08:00; o programa ficou desligado do domingo passado até domingo 08:20
  const domingo = gradeDe([0], '08:00');
  assert.deepEqual(resolverVencido(seguinte(domingo), em(1, 8), em(8, 8, 20), TOL), {
    executar: em(8, 8), pulados: [em(1, 8)], proximo: em(15, 8),
  });
});

test('resolverVencido: semanas desligado com 48 horários por dia, o laço é limitado e não sai rajada', () => {
  const g = validarGrade({ horarios: Array.from({ length: 48 }, (_, i) => linha(hhmm(i * 30))) }, opts);
  let chamadas = 0;
  const contado = (h) => { chamadas++; return proximoHorario(g, h); };
  // 30 dias desligado; volta às 10:05: o das 10:00 está dentro da tolerância
  const r = resolverVencido(contado, em(2, 0), em(2 + 30, 10, 5), TOL);
  assert.equal(r.executar, em(32, 10));
  assert.equal(r.proximo, em(32, 10, 30));
  assert.ok(chamadas <= 410, `laço limitado (${chamadas} chamadas)`);
  assert.ok(r.pulados.every((h) => h < r.executar));
  // volta às 10:45: o das 10:30 (15 min) é o mais recente dentro da tolerância
  assert.equal(resolverVencido(seguinte(g), em(2, 0), em(32, 10, 45), TOL).executar, em(32, 10, 30));
  // um horário por semana (quarta 07:00), desligado 400 semanas: nada na tolerância, o próximo é a quarta seguinte
  const semanal = gradeDe([3], '07:00');
  const r2 = resolverVencido(seguinte(semanal), em(4, 7), em(4 + 400 * 7, 10), TOL);
  assert.equal(r2.executar, null);
  assert.equal(r2.proximo, em(4 + 401 * 7, 7));
});

test('resolverVencido: função de próximo que não avança não prende o laço', () => {
  let chamadas = 0;
  const parado = (h) => { chamadas++; return h; };
  const r = resolverVencido(parado, em(2, 9), em(2, 9, 5), TOL);
  assert.deepEqual(r, { executar: em(2, 9), pulados: [], proximo: null });
  const passoDeUmMs = (h) => { chamadas++; return h + 1; };
  chamadas = 0;
  const r2 = resolverVencido(passoDeUmMs, em(2, 9), em(2, 10), TOL);
  assert.ok(chamadas < 2000, `laço limitado (${chamadas} chamadas)`);
  assert.equal(r2.executar, null, 'o salto também estourou: nada sai');
  assert.equal(r2.proximo, em(2, 10) + 1, 'o próximo é o primeiro depois de agora');
});
