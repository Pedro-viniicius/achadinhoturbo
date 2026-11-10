// Proteção do número (plano anti-banimento, ADR-012): o porteiro único das saídas do WhatsApp.
// - Conta toda mensagem que o número envia (tabela wa_saidas, só a hora: sem jid, número nem conteúdo) para o teto por
//   hora em janela deslizante de 60 min, e garante uma pausa mínima entre QUAISQUER duas mensagens, de qualquer origem
//   (regras, fila de envios, avisos, resposta ao remetente). Isso é o embrulho do `wa` (embrulhar), montado no agendador.
// - Teto e horário de silêncio NÃO são impostos aqui: quem manda a grupos (regras e fila) pergunta `liberado()` antes e
//   deixa o excedente na fila que já existe. O privado (avisos, resposta ao remetente) só conta e respeita a pausa.
// - Reserva (achados S1/Q1/Q2 da rodada 1): quem manda a grupos pega uma `vaga()` e pede por ela; o pedido aprovado
//   separa as vagas na hora (síncrono, sem await entre conferir e separar), e liberado() de qualquer outro já as conta.
//   Assim duas execuções ao mesmo tempo (tick e "Enviar agora", ou dois "Enviar agora") não passam juntas da última vaga.
// - Sem a configuração no banco, teto e silêncio ficam desligados (os testes não dependem da hora em que rodam); o
//   serviço real grava os padrões no início com semearProtecao(db), sem sobrescrever o que o dono escolheu.
// Relógio (`agora`), relógio monotônico, aleatório e espera são injetáveis para os testes.

import { addLog, getSetting } from './db.js';
import { sleep, jitter, toMin, inWindow, alignToWindow } from './util.js';

export const LIMITE_HORA_PADRAO = 40;
export const LIMITE_HORA_MIN = 1;
export const LIMITE_HORA_MAX = 200;
export const SILENCIO_PADRAO = Object.freeze({ de: '23:00', ate: '07:00' });
export const PAUSA_MIN_GRUPO_S = 2;
export const PAUSA_MIN_OFERTA_S = 5;
// Máximos das pausas (etapa 6): o embrulho impõe a pausa entre grupos a TODA mensagem, inclusive aos avisos privados,
// então um valor enorme seguraria os alertas ao dono. 60 s entre grupos e 10 min entre ofertas cobrem qualquer ritmo humano.
export const PAUSA_MAX_GRUPO_S = 60;
export const PAUSA_MAX_OFERTA_S = 600;

const HORA_MS = 3600000;
const GUARDA_MS = 2 * HORA_MS; // wa_saidas guarda só as últimas 2 h (o teto olha 1 h)
export const PAUSA_GRUPO_PADRAO_S = 6; // o mesmo padrão de delay_group_s do agendador e da fila
export const PAUSA_OFERTA_PADRAO_S = 30; // o mesmo padrão de delay_offer_s do agendador
const ORIGEM = { id: null, name: 'Proteção do número' }; // coluna "Regra" do Histórico
const EMBRULHADO = Symbol('ritmo.embrulhado');
const RE_HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const CHAVES = { limite: 'wa_limite_hora', ativo: 'wa_silencio_ativo', de: 'wa_silencio_de', ate: 'wa_silencio_ate' };

// Frases da spec (docs/produto/specs/anti-banimento.md, "Textos da interface"); o painel mostra a do servidor no toast
export const ERRO_LIMITE_HORA = `Use um número inteiro de ${LIMITE_HORA_MIN} a ${LIMITE_HORA_MAX}.`;
export const ERRO_SILENCIO_IGUAIS = 'Escolha dois horários diferentes.';
export const ERRO_SILENCIO_HORA = 'Use um horário no formato HH:MM, de 00:00 a 23:59.';
export const ERRO_SILENCIO_ATIVO = 'Horário de silêncio: escolha ligado ou desligado.';
export const erroPausa = (min, max) => `Use um número inteiro de ${min} a ${max}.`;

/**
 * Pausa gravada em segundos, presa entre o mínimo e o máximo da proteção (achado S2): um valor gravado antes da
 * validação, ou à mão no banco, nunca vale menos que o mínimo nem trava os avisos com uma espera enorme. Ilegível = o
 * padrão. Usada pelo embrulho, pelas pausas da regra (src/scheduler.js) e pela fila sem ritmo (src/envios.js).
 */
export function pausaGravada(valor, { min, max, padrao }) {
  const n = Number(valor ?? padrao);
  return Math.min(Math.max(Number.isFinite(n) ? n : padrao, min), max);
}
export const pausaGrupoGravada = (valor) => pausaGravada(valor, { min: PAUSA_MIN_GRUPO_S, max: PAUSA_MAX_GRUPO_S, padrao: PAUSA_GRUPO_PADRAO_S });
export const pausaOfertaGravada = (valor) => pausaGravada(valor, { min: PAUSA_MIN_OFERTA_S, max: PAUSA_MAX_OFERTA_S, padrao: PAUSA_OFERTA_PADRAO_S });

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

/** Inteiro vindo do JSON: número inteiro ou texto só de algarismos; o resto (vazio, booleano, fração) é null. */
function inteiro(v) {
  if (typeof v === 'number') return Number.isSafeInteger(v) ? v : null;
  if (typeof v === 'string' && /^\d{1,9}$/.test(v.trim())) return Number(v.trim());
  return null;
}

/** Último instante (ms) em que o relógio local marcou `hora` ('HH:MM'), em `ts` ou antes. */
function ultimaVez(ts, hora) {
  const m = toMin(hora);
  const d = new Date(ts);
  d.setHours(Math.floor(m / 60), m % 60, 0, 0);
  if (d.getTime() > ts) d.setDate(d.getDate() - 1);
  return d.getTime();
}

/**
 * Valida o corpo do PUT /api/protecao antes de gravar qualquer campo. Só os campos presentes (nem null nem undefined)
 * são conferidos e devolvidos, já normalizados. `atual` ({ silencio_de, silencio_ate }, os gravados) completa a
 * comparação "Das ≠ Até" quando o corpo traz só um dos dois. Lança Error com a frase da spec.
 */
export function validarProtecao(corpo, atual = {}) {
  const c = corpo && typeof corpo === 'object' && !Array.isArray(corpo) ? corpo : {};
  const tem = (k) => c[k] !== undefined && c[k] !== null;
  const r = {};
  if (tem('limite_hora')) {
    const n = inteiro(c.limite_hora);
    if (n == null || n < LIMITE_HORA_MIN || n > LIMITE_HORA_MAX) throw new Error(ERRO_LIMITE_HORA);
    r.limite_hora = n;
  }
  if (tem('silencio_ativo')) {
    if (typeof c.silencio_ativo !== 'boolean') throw new Error(ERRO_SILENCIO_ATIVO);
    r.silencio_ativo = c.silencio_ativo;
  }
  for (const k of ['silencio_de', 'silencio_ate']) {
    if (!tem(k)) continue;
    if (typeof c[k] !== 'string' || !RE_HHMM.test(c[k])) throw new Error(ERRO_SILENCIO_HORA);
    r[k] = c[k];
  }
  const de = r.silencio_de ?? atual.silencio_de; const ate = r.silencio_ate ?? atual.silencio_ate;
  if ((r.silencio_de != null || r.silencio_ate != null) && de != null && de === ate) throw new Error(ERRO_SILENCIO_IGUAIS);
  for (const [k, min, max] of [['delay_group_s', PAUSA_MIN_GRUPO_S, PAUSA_MAX_GRUPO_S], ['delay_offer_s', PAUSA_MIN_OFERTA_S, PAUSA_MAX_OFERTA_S]]) {
    if (!tem(k)) continue;
    const n = inteiro(c[k]);
    if (n == null || n < min || n > max) throw new Error(erroPausa(min, max));
    r[k] = n;
  }
  return r;
}

/**
 * Grava os padrões da proteção (40 por hora, silêncio ligado das 23:00 às 07:00) só onde ainda não há valor: chamado
 * no início do serviço real. O que o dono já escolheu, inclusive o silêncio desligado ('0'), nunca é sobrescrito.
 */
export function semearProtecao(db) {
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  ins.run(CHAVES.limite, String(LIMITE_HORA_PADRAO));
  ins.run(CHAVES.ativo, '1');
  ins.run(CHAVES.de, SILENCIO_PADRAO.de);
  ins.run(CHAVES.ate, SILENCIO_PADRAO.ate);
}

/**
 * Porteiro das saídas. `fast` (testes) zera a pausa mínima, mas a contagem continua. `agora`: relógio de parede (ms),
 * o mesmo de wa_saidas e do horário de silêncio; `monotonico`: mede a pausa entre mensagens (não pula com acerto de
 * relógio nem suspensão); `aleatorio`: o sorteio da pausa (0 a 1); `dormir(ms)`: a espera.
 */
export function createRitmo({ db, fast = false, agora = Date.now, monotonico = () => performance.now(), aleatorio = Math.random, dormir = sleep } = {}) {
  // pausa mínima (relógio monotônico): fim da última tentativa de envio e início reservado pela última chamada
  let fimUltima = -Infinity;
  let reservada = -Infinity;
  // teto: quando foi escrita a linha do episódio atual (null = nenhum episódio aberto)
  let avisadoEm = null;
  // teto: vagas separadas por pedidos aprovados (vaga().pedir) e ainda não usadas nem soltas, de todas as vagas
  let reservadas = 0;

  const contar = db.prepare('SELECT COUNT(*) AS n FROM wa_saidas WHERE ts > ? AND ts <= ?');
  const kEsima = db.prepare('SELECT ts FROM wa_saidas WHERE ts > ? AND ts <= ? ORDER BY ts LIMIT 1 OFFSET ?');
  const inserir = db.prepare('INSERT INTO wa_saidas (ts) VALUES (?)');
  const apagar = db.prepare('DELETE FROM wa_saidas WHERE ts < ? OR ts > ?');

  /** Teto gravado (1 a 200) ou null = desligado (sem configuração ou valor fora da faixa). */
  function limite() {
    const n = inteiro(getSetting(db, CHAVES.limite));
    return n != null && n >= LIMITE_HORA_MIN && n <= LIMITE_HORA_MAX ? n : null;
  }

  /**
   * Mensagens na janela de 60 min que termina em `now`. Uma saída com hora no futuro (relógio do computador
   * atrasado depois do envio) conta só até 1 h à frente: um acerto de relógio de dias não trava o teto por dias.
   */
  const janela = (now) => [now - HORA_MS, now + HORA_MS];

  /** Quando a k-ésima mais antiga da janela sai dela (k ≥ 1). */
  function saiDaJanela(now, k) {
    const [de, ate] = janela(now);
    const r = kEsima.get(de, ate, k - 1);
    return r ? Number(r.ts) + HORA_MS : now;
  }

  // reinício do serviço (achado S3): a última saída gravada vale como o fim da última mensagem, para a primeira depois
  // do `--watch` também esperar a pausa. Hora no futuro (relógio atrasado) vale como agora.
  try {
    const ultima = db.prepare('SELECT MAX(ts) AS ts FROM wa_saidas').get()?.ts;
    if (ultima != null) fimUltima = monotonico() - Math.max(0, agora() - Number(ultima));
  } catch { /* sem a tabela (banco antigo ainda não migrado): começa sem pausa, como antes */ }

  /** Registra uma mensagem enviada agora e apaga o que passou de 2 h (ou está mais de 2 h no futuro). */
  function registrar() {
    const now = agora();
    inserir.run(now);
    apagar.run(now - GUARDA_MS, now + GUARDA_MS);
  }

  /**
   * Uso do teto: { limite, usados, libera_em }. `limite` null = teto desligado (a contagem segue, para o painel).
   * `libera_em`: quando volta a haver 1 vaga, só com o teto cheio (inclusive com o teto reduzido abaixo do uso).
   */
  function uso(now = agora()) {
    const lim = limite();
    const usados = Number(contar.get(...janela(now)).n);
    const libera_em = lim != null && usados >= lim ? saiDaJanela(now, usados - lim + 1) : null;
    // fim do episódio do teto: há vaga e a pressão passou (metade livre) ou já se foi uma janela inteira desde a linha
    if (avisadoEm != null && (lim == null || (usados < lim && (usados * 2 <= lim || now - avisadoEm >= HORA_MS)))) avisadoEm = null;
    return { limite: lim, usados, libera_em };
  }

  /**
   * Horário de silêncio em `now`: { ativo, de, ate, agora, ate_ts }. `ativo` é a chave de Ajustes (configuração
   * ilegível ou com Das = Até vale como desligado); `agora` diz se `now` cai dentro; `ate_ts` é o fim do silêncio
   * atual (null fora dele).
   */
  function silencio(now = agora()) {
    const hora = (v) => typeof v === 'string' && RE_HHMM.test(v);
    const deGravado = getSetting(db, CHAVES.de); const ateGravado = getSetting(db, CHAVES.ate);
    const de = hora(deGravado) ? deGravado : SILENCIO_PADRAO.de; const ate = hora(ateGravado) ? ateGravado : SILENCIO_PADRAO.ate;
    const ativo = getSetting(db, CHAVES.ativo) === '1' && hora(deGravado) && hora(ateGravado) && de !== ate;
    const dentro = ativo && inWindow(now, de, ate);
    // o silêncio acaba quando começa o horário livre, que vai de `ate` até `de`
    return { ativo, de, ate, agora: dentro, ate_ts: dentro ? alignToWindow(now, ate, de) : null };
  }

  /**
   * Pode mandar `precisa` mensagens a grupos agora? → { ok: true } ou { ok: false, motivo: 'silencio', ate } ou
   * { ok: false, motivo: 'limite', ate, limite, usados }. `ate` é quando tentar de novo (fim do silêncio, ou quando a
   * janela abre `precisa` vagas). `precisa` é preso entre 1 e o teto (quem manda a 50 grupos com teto 40 espera o
   * teto inteiro, não para sempre). `ignorarSilencio`: o "Enviar mesmo assim" do envio "agora"; nunca ignora o teto.
   * As vagas separadas por outros (vaga().pedir) já contam como usadas. `usados` é só o que saiu (o do painel).
   */
  function liberado(now = agora(), { precisa = 1, ignorarSilencio = false } = {}) {
    return pedirPara(null, now, { precisa, ignorarSilencio });
  }

  /**
   * liberado() de uma vaga (`v`: { n }, as vagas que ela já separou; null = só pergunta). Pedido aprovado separa o que
   * falta para `precisa` na hora, sem await: o próximo liberado() já conta. Quem já tem as vagas passa mesmo com o
   * teto reduzido no meio. Teto cheio por vagas separadas que ainda não saíram: elas saem a partir de agora, então a
   * vaga volta no máximo 1 h depois (conservador).
   */
  function pedirPara(v, now, { precisa = 1, ignorarSilencio = false } = {}) {
    if (!ignorarSilencio) {
      const s = silencio(now);
      if (s.agora) return { ok: false, motivo: 'silencio', ate: s.ate_ts };
    }
    const u = uso(now);
    if (u.limite == null) return { ok: true };
    const p = Math.min(Math.max(1, Math.floor(Number(precisa)) || 1), u.limite);
    const falta = Math.max(0, p - (v?.n ?? 0));
    const ocupados = u.usados + reservadas;
    if (!falta || ocupados + falta <= u.limite) {
      if (v && falta) { v.n += falta; reservadas += falta; }
      return { ok: true };
    }
    const k = ocupados + falta - u.limite; // quantas saídas precisam sair da janela
    const ate = k <= u.usados ? saiDaJanela(now, k) : now + HORA_MS;
    return { ok: false, motivo: 'limite', ate, limite: u.limite, usados: u.usados };
  }

  /**
   * Vagas de uma execução que manda a grupos (uma regra, um envio da fila). `pedir(now, { precisa, ignorarSilencio })`:
   * o liberado() que separa o que falta para ter `precisa` vagas; `usar()`: depois de cada mensagem que saiu (a linha
   * de wa_saidas passa a contar no lugar da vaga); `soltar()`: devolve as que sobraram (no fim, sempre). Sem o teto
   * ligado, nada é separado e `pedir` só confere o silêncio.
   */
  function vaga() {
    const v = { n: 0 };
    return {
      pedir: (now = agora(), opcoes = {}) => pedirPara(v, now, opcoes),
      usar() { if (v.n > 0) { v.n--; reservadas = Math.max(0, reservadas - 1); } },
      soltar() { reservadas = Math.max(0, reservadas - v.n); v.n = 0; },
      get separadas() { return v.n; },
    };
  }

  /**
   * Atraso de um envio "agora" para o prazo máximo da fila: `now - nextRunAt` menos o trecho que caiu no último
   * período de silêncio (o tempo em silêncio não conta). Silêncio desligado: o atraso inteiro.
   */
  function atrasoAgora(nextRunAt, now = agora()) {
    const atraso = Math.max(0, now - nextRunAt);
    const s = silencio(now);
    if (!s.ativo) return atraso;
    // último período: o atual (até agora) ou o mais recente já encerrado; começa no último "Das" antes do fim
    const fim = s.agora ? now : ultimaVez(now, s.ate);
    const inicio = ultimaVez(fim, s.de);
    const sobreposto = Math.max(0, fim - Math.max(inicio, nextRunAt));
    return Math.max(0, atraso - sobreposto);
  }

  /**
   * Linha `aviso` no Histórico quando o teto enche: uma por episódio, nunca uma por mensagem segurada. O episódio
   * acaba (uso) quando há vaga e metade do teto está livre, ou quando já passou uma janela inteira desde a linha; o
   * próximo teto cheio escreve de novo. `r`: o resultado de liberado() (ou de uso(), com libera_em). `log(linha)`
   * recebe o objeto de addLog ({ rule, level, message }); sem ele, a linha vai direto ao Histórico. → true se escreveu.
   */
  function avisarLimite(log, r) {
    if (!r || (r.motivo != null && r.motivo !== 'limite')) return false;
    const ate = r.ate ?? r.libera_em; const lim = r.limite;
    if (ate == null || lim == null || avisadoEm != null) return false;
    const linha = { rule: ORIGEM, level: 'aviso', message: `Limite de ${lim} mensagens por hora atingido: o que falta sai a partir das ${hhmm(ate)}.` };
    if (typeof log === 'function') log(linha); else addLog(db, linha);
    avisadoEm = agora();
    return true;
  }

  /** Pausa mínima desta mensagem: jitter de delay_group_s (±30%, preso entre 2 e 60 s), em ms. */
  function pausa() {
    if (fast) return 0;
    return jitter(pausaGrupoGravada(getSetting(db, 'delay_group_s')), aleatorio);
  }

  /**
   * Espera a vez desta mensagem: pelo menos a pausa depois do fim da anterior e depois do início reservado pela
   * chamada anterior. A reserva é síncrona, então duas origens ao mesmo tempo (tick e "Enviar teste") saem espaçadas.
   * Não há trava: se um envio travar no Baileys, os outros saem na vez deles.
   */
  async function esperarVez() {
    if (fast) return;
    const p = pausa();
    const m = monotonico();
    const alvo = Math.max(m, fimUltima + p, reservada + p);
    reservada = alvo;
    if (alvo > m) await dormir(alvo - m);
  }

  /**
   * `wa` com sendText/sendImage/sendPoll que esperam a vez, chamam `wa.<fn>` NO MOMENTO do envio (um teste pode
   * trocar wa.sendText depois) e só contam se o envio deu certo. O resto do `wa` vem por herança. Um `wa` já
   * embrulhado volta como está (embrulhar duas vezes contaria em dobro).
   */
  function embrulhar(wa) {
    if (wa?.[EMBRULHADO]) return wa;
    const e = Object.create(wa);
    const envolver = (nome) => async (...args) => {
      await esperarVez();
      let r;
      try {
        r = await wa[nome](...args);
      } finally {
        fimUltima = monotonico(); // tentativa que falhou também pode ter saído: a próxima espera do mesmo jeito
      }
      try {
        registrar();
      } catch {
        // a mensagem já saiu: falhar aqui faria quem chamou repetir o envio. Sem o erro da biblioteca (e sem jid).
        console.error('[ritmo] não consegui registrar uma saída do WhatsApp no contador do teto');
      }
      return r;
    };
    Object.defineProperties(e, {
      sendText: { value: envolver('sendText'), writable: true, configurable: true },
      sendImage: { value: envolver('sendImage'), writable: true, configurable: true },
      sendPoll: { value: envolver('sendPoll'), writable: true, configurable: true },
      [EMBRULHADO]: { value: true },
    });
    return e;
  }

  return { registrar, uso, liberado, vaga, silencio, atrasoAgora, embrulhar, avisarLimite };
}
