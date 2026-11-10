// Utilitários sem dependência de outros módulos do projeto (evita ciclos de import entre scheduler e envios).

/** Espera `ms` milissegundos. */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Variação das pausas anti-bloqueio em torno do valor de Ajustes: ±30% (o /state expõe para o painel mostrar a faixa). */
export const VARIACAO_PAUSA = 0.3;

/**
 * `s` segundos com variação de ±VARIACAO_PAUSA, em ms: as pausas anti-bloqueio entre mensagens. `aleatorio` (0 a 1) é
 * injetável para os testes; valor fora da faixa é preso a ela e um não numérico vale o meio, para a pausa nunca sumir.
 */
export const jitter = (s, aleatorio = Math.random) => {
  const r = Number(aleatorio());
  const x = Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0.5;
  return Math.round(s * 1000 * (1 - VARIACAO_PAUSA + x * 2 * VARIACAO_PAUSA));
};

/** "HH:MM" em minutos desde a meia-noite. */
export const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + (m || 0); };

/** O horário de funcionamento pode virar a noite (ex.: 20:00 até 02:00). Início igual ao fim = o dia todo. */
export function inWindow(ts, start, end) {
  const d = new Date(ts); const m = d.getHours() * 60 + d.getMinutes();
  const s = toMin(start); const e = toMin(end);
  if (s === e) return true;
  return s < e ? m >= s && m < e : m >= s || m < e;
}

/** Se `ts` cai fora do horário, devolve o próximo início de janela. */
export function alignToWindow(ts, start, end) {
  if (inWindow(ts, start, end)) return ts;
  const d = new Date(ts); const s = toMin(start);
  d.setHours(Math.floor(s / 60), s % 60, 0, 0);
  if (d.getTime() <= ts) d.setDate(d.getDate() + 1);
  return d.getTime();
}
