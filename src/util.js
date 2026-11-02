// Utilitários sem dependência de outros módulos do projeto (evita ciclos de import entre scheduler e envios).

/** Espera `ms` milissegundos. */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `s` segundos com variação de ±30%, em ms: as pausas anti-bloqueio entre mensagens. */
export const jitter = (s) => Math.round(s * 1000 * (0.7 + Math.random() * 0.6));
