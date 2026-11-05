// Grade de horários do Disparo automático (plano grade-de-disparos, decisão D2; ADR-007). Módulo puro, sem estado:
// valida e normaliza a grade da regra (`rules.grade`), calcula o próximo horário (o mesmo cálculo do "Repetir" do
// Disparar mensagem, proximaOcorrencia), acha a linha de um horário e resolve horário perdido. O agendador
// (src/scheduler.js) e as rotinas do Grupo vivo (src/rotinas.js) usam resolverVencido com a mesma tolerância.
//
// Grade: { dias: [0..6] (0 = domingo, como Date#getDay), horarios: [{ hora: 'HH:MM', qtd: 1..20, template_id: int|null }] }.
// `template_id` null = template da regra. A hora é a do computador (fuso do sistema), como o Repetir e a janela.
// As frases de erro vão para a tela (400 da API de regras): sem dado pessoal, só horários e limites.

import { proximaOcorrencia, HHMM } from './envios.js';

export const MAX_HORARIOS_GRADE = 48;
export const INTERVALO_MIN_GRADE = 10;   // minutos entre dois horários seguidos da grade
export const TOLERANCIA_MIN = 30;        // atraso máximo para um horário perdido ainda sair
export const MAX_QTD_GRADE = 20;         // ofertas por horário (o mesmo teto de "Ofertas por envio")

const TOLERANCIA_MS = TOLERANCIA_MIN * 60000;
const MAX_VOLTAS = 400;                  // 48 horários × 8 dias cabem: uma semana desligado é percorrida inteira
const CAMPOS_GRADE = new Set(['dias', 'horarios']);
const CAMPOS_LINHA = new Set(['hora', 'qtd', 'template_id']);
const TODOS_OS_DIAS = [0, 1, 2, 3, 4, 5, 6];

const FORMATO = 'A grade tem um formato inválido.';
const SEM_HORARIO = 'Adicione ao menos um horário.';
const SEM_DIA = 'Marque ao menos um dia.';
const HORA_INVALIDA = 'Horário inválido: use HH:MM.';

const objetoSimples = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const soCampos = (o, permitidos) => Object.keys(o).every((k) => permitidos.has(k));
const pad = (n) => String(n).padStart(2, '0');
/** Inteiro de um número ou de um texto só com dígitos (o formulário pode mandar "3"). Outra coisa: NaN. */
const inteiro = (v) => {
  if (typeof v === 'number') return Number.isInteger(v) ? v : NaN;
  if (typeof v === 'string' && /^\d{1,9}$/.test(v.trim())) return Number(v.trim());
  return NaN;
};
const minutosDe = (hora) => Number(hora.slice(0, 2)) * 60 + Number(hora.slice(3));

/**
 * Grade validada e normalizada (dias sem repetir e em ordem, horários em ordem com hora de 2 dígitos, template vazio
 * = null), ou null se não houver grade (modo intervalo). Grade inválida lança Error com a frase para a tela.
 * Recusa campos a mais, mais de 48 horários, horário repetido, menos de 10 min entre dois horários seguidos (na ordem
 * do dia e também na virada: da última linha para a primeira do dia seguinte), ofertas fora de 1..20 e template que
 * `templateExiste(id)` não confirma (sem `templateExiste`, nenhum template passa).
 */
export function validarGrade(g, { templateExiste } = {}) {
  if (g == null) return null;
  if (!objetoSimples(g) || !soCampos(g, CAMPOS_GRADE)) throw new Error(FORMATO);

  let dias = TODOS_OS_DIAS;
  if (g.dias !== undefined) {
    if (!Array.isArray(g.dias) || !g.dias.length) throw new Error(SEM_DIA);
    const lidos = g.dias.map((d) => (typeof d === 'string' && /^[0-6]$/.test(d) ? Number(d) : d));
    if (lidos.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error(SEM_DIA);
    dias = [...new Set(lidos)].sort((a, b) => a - b);
  }

  if (!Array.isArray(g.horarios) || !g.horarios.length) throw new Error(SEM_HORARIO);
  // o teto vem antes de olhar cada linha: uma lista enorme não é percorrida
  if (g.horarios.length > MAX_HORARIOS_GRADE) throw new Error(`A grade aceita no máximo ${MAX_HORARIOS_GRADE} horários.`);

  const confirmados = new Map();
  const existe = (id) => {
    if (!confirmados.has(id)) confirmados.set(id, typeof templateExiste === 'function' && !!templateExiste(id));
    return confirmados.get(id);
  };
  const horarios = g.horarios.map((l) => {
    if (!objetoSimples(l) || !soCampos(l, CAMPOS_LINHA)) throw new Error(FORMATO);
    const hora = horaDaLinha(l.hora);
    if (!hora) throw new Error(HORA_INVALIDA);
    const qtd = inteiro(l.qtd);
    if (!(qtd >= 1 && qtd <= MAX_QTD_GRADE)) throw new Error(`Horário ${hora}: ofertas de 1 a ${MAX_QTD_GRADE}.`);
    let template_id = null;
    if (l.template_id != null && l.template_id !== '') {
      template_id = inteiro(l.template_id);
      if (!(template_id >= 1) || !existe(template_id)) throw new Error(`Horário ${hora}: o template escolhido não existe mais. Escolha outro.`);
    }
    return { hora, qtd, template_id };
  }).sort((a, b) => minutosDe(a.hora) - minutosDe(b.hora));

  for (let i = 1; i < horarios.length; i++) {
    const antes = horarios[i - 1].hora; const agora = horarios[i].hora;
    if (antes === agora) throw new Error(`Já existe um horário às ${agora}.`);
    if (minutosDe(agora) - minutosDe(antes) < INTERVALO_MIN_GRADE) {
      throw new Error(`Os horários ${antes} e ${agora} estão a menos de ${INTERVALO_MIN_GRADE} min um do outro.`);
    }
  }
  // virada do dia: a última linha contra a primeira do dia seguinte (23:55 e 00:00 seriam 5 min)
  if (horarios.length > 1) {
    const ult = horarios.at(-1).hora; const pri = horarios[0].hora;
    if (minutosDe(pri) + 1440 - minutosDe(ult) < INTERVALO_MIN_GRADE) {
      throw new Error(`Os horários ${ult} e ${pri} estão a menos de ${INTERVALO_MIN_GRADE} min um do outro.`);
    }
  }
  return { dias, horarios };
}

/** Próximo horário da grade estritamente depois de `depoisDe` (ms), nos dias marcados; null se não houver. */
export function proximoHorario(grade, depoisDe = Date.now()) {
  if (!objetoSimples(grade) || !Array.isArray(grade.horarios)) return null;
  return proximaOcorrencia({ dias: grade.dias, horarios: grade.horarios.map((l) => l?.hora) }, depoisDe);
}

/**
 * Hora de uma linha em 'HH:MM' ('9:00' vira '09:00', como o proximaOcorrencia a lê), ou null se não for hora.
 * A API grava a grade já normalizada; isto vale para a grade editada à mão no banco.
 */
export function horaDaLinha(hora) {
  const m = HHMM.exec(typeof hora === 'string' ? hora.trim() : '');
  return m ? `${pad(m[1])}:${m[2]}` : null;
}

/**
 * Linha da grade cujo HH:MM, no dia de `ts` (hora local), é exatamente o de `ts` (segundos e ms zerados, como os
 * horários que proximoHorario devolve). Não confere os dias: quem chama passa um horário que veio da própria grade.
 * Devolve a linha como está gravada; quem usa a quantidade e o template lê por qtdDaLinha e templateDaLinha.
 */
export function horarioDe(grade, ts) {
  if (!objetoSimples(grade) || !Array.isArray(grade.horarios) || !Number.isFinite(ts)) return null;
  const d = new Date(ts);
  if (d.getSeconds() !== 0 || d.getMilliseconds() !== 0) return null;
  const hora = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return grade.horarios.find((l) => objetoSimples(l) && horaDaLinha(l.hora) === hora) ?? null;
}

/**
 * Ofertas de uma linha da grade: a `qtd` de 1 a 20 (número ou texto só com dígitos); sem linha ou fora disso (só num
 * banco editado à mão), `padrao` (o per_run da regra). O agendador e o cartão (proximo_horario) usam esta mesma conta.
 */
export function qtdDaLinha(linha, padrao) {
  const qtd = objetoSimples(linha) ? inteiro(linha.qtd) : NaN;
  return qtd >= 1 && qtd <= MAX_QTD_GRADE ? qtd : padrao;
}

/** Template pedido pela linha da grade: inteiro ≥ 1 (número ou texto só com dígitos), ou null (o template da regra). */
export function templateDaLinha(linha) {
  const id = objetoSimples(linha) ? inteiro(linha.template_id) : NaN;
  return id >= 1 ? id : null;
}

/**
 * Horário do próximo envio de uma regra com grade, a mesma conta do tick (src/scheduler.js), do "Enviar agora", da
 * prévia e do cartão (proximo_horario em src/server.js). `nextRunAt` só vale se for um horário da grade: no futuro, é
 * ele; vencido, é o que resolverVencido vai executar (só o mais recente, até a tolerância) ou, se for pulado, o
 * seguinte. Sem horário gravado, ou com um que não é da grade (o tick o descarta), é o primeiro depois de `now`.
 */
export function proximoEnvio(grade, nextRunAt, now = Date.now(), tolMs = TOLERANCIA_MS) {
  const seguinte = (h) => proximoHorario(grade, h);
  if (!Number.isFinite(nextRunAt) || !horarioDe(grade, nextRunAt)) return seguinte(now);
  if (nextRunAt > now) return nextRunAt;
  const r = resolverVencido(seguinte, nextRunAt, now, tolMs);
  return r.executar ?? r.proximo;
}

/**
 * Horário perdido (CA6), para a grade e para as rotinas. `proximo(h)` dá o horário seguinte estritamente depois de
 * `h` (ou null); `visto` é o horário gravado (next_run_at) e já vencido. Anda pelos horários vencidos e só o mais
 * recente pode sair, e só se o atraso for de até `tolMs`: nunca há dois atrasados em rajada.
 * Devolve `{ executar: ts|null, pulados: [ts], proximo: ts|null }`: `pulados` são os vencidos que não saem (para o
 * aviso no Histórico) e `proximo` é o primeiro horário depois do último vencido (o que vem depois de `executar`).
 * O laço é limitado (400 voltas): com dias de programa desligado, salta direto para a janela de tolerância, e os
 * horários do meio do salto não entram em `pulados`.
 */
export function resolverVencido(proximo, visto, now, tolMs = TOLERANCIA_MS) {
  // função que não avança (ou devolve lixo) vira "sem próximo": o laço nunca fica preso
  const seguinte = (h) => { const n = proximo(h); return Number.isFinite(n) && n > h ? n : null; };
  if (!Number.isFinite(visto)) return { executar: null, pulados: [], proximo: seguinte(now) };
  if (visto > now) return { executar: null, pulados: [], proximo: visto };

  const pulados = [];
  let h = visto;
  let saltou = false;
  for (let voltas = 1; ; voltas++) {
    const n = seguinte(h);
    if (n == null || n > now) {
      // h é o último vencido
      if (now - h <= tolMs) return { executar: h, pulados, proximo: n };
      pulados.push(h);
      return { executar: null, pulados, proximo: n };
    }
    pulados.push(h);
    h = n;
    if (voltas < MAX_VOLTAS) continue;
    if (saltou) {
      // nem a janela de tolerância coube no limite (só com uma função de próximo fora do comum): nada sai
      pulados.push(h);
      return { executar: null, pulados, proximo: seguinte(now) };
    }
    saltou = true;
    voltas = 0;
    const c = seguinte(now - tolMs - 1); // primeiro horário dentro da tolerância, se houver
    if (c == null || c > now) {
      pulados.push(h);
      return { executar: null, pulados, proximo: c };
    }
    if (c > h) { pulados.push(h); h = c; }
  }
}
