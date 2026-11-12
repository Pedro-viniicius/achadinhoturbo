// Vigia (plano rodar-sozinho-entrega3; spec docs/produto/specs/rodar-sozinho-entrega3.md): avisa o dono quando algo
// para (loja parada, extensão ou Central fora, revisão acumulada, regra vazia) e quando volta.
//
// Este arquivo tem duas partes:
// - a parte PURA (etapa 2), aqui embaixo: `avaliar`, as mensagens, a linha de saúde e o estado. Sem banco, sem rede,
//   sem relógio próprio: tudo entra por parâmetro (o `agora` inclusive) e sai como valor;
// - `createVigia` (etapa 3), no fim do arquivo: lê e grava o estado em `settings.vigia_estado`, lê `execucoes`, as
//   regras ativas, a revisão e o estado da extensão e da Central, confere o silêncio e o WhatsApp e entrega as
//   mensagens pelo `entregar` injetado (o entregarAosDeErro de src/avisos.js, que passa pelo wa embrulhado do ritmo).
//
// Regras que valem nas duas partes:
// - nenhuma linha do vigia é `erro` (o `erro` dispara o aviso de erro e criaria um laço, CA3.7);
// - nenhum texto livre de terceiros vai para a mensagem (o "Último erro" da Central nunca é lido aqui). Os nomes de
//   regra passam por `nomeSeguro` (semNumero, sem `*`, até MAX_NOME_VIGIA caracteres), CA3.5;
// - o estado guarda só chaves de causa, instantes, contagens e ids de regra: nunca nome, número nem texto.

import { semNumero } from './avisos.js';
import { TESTE_ESPERA_MIN } from './links.js';
import { addLog, getSetting, setSetting } from './db.js';

// ---------- limites (Decisão 2; spec §1; números que aparecem nos Docs e no FATOS) ----------
/** Loja parada: execuções seguidas com atividade da loja, nenhuma saída e alguma oferta dela fora. */
export const EXECUCOES_LOJA_PARADA = 3;
/** Regra vazia: execuções seguidas da regra com 0 saídas e alguma oferta fora. */
export const EXECUCOES_REGRA_VAZIA = 2;
/** Extensão ou Central fora: minutos de falta, medidos numa execução que esperou por ela. */
export const FORA_MIN = 30;
/** Revisão acumulada: abre com REVISAO_ABRE ou mais pendentes; volta ao normal com REVISAO_FECHA ou menos (D4). */
export const REVISAO_ABRE = 10;
export const REVISAO_FECHA = 5;
/** Freio: no máximo um aviso de problema por causa a cada FREIO_VIGIA_H horas, contadas do último aviso dela. */
export const FREIO_VIGIA_H = 3;
/** Nome de regra nas mensagens e no Histórico: cortado neste tamanho. */
export const MAX_NOME_VIGIA = 40;

const FORA_MS = FORA_MIN * 60000;
const FREIO_MS = FREIO_VIGIA_H * 3600000;
/** Itens listados numa mensagem com várias causas; o resto vira "E mais N problemas." */
const MAX_ITENS = 6;
/** Lojas que o vigia acompanha (a Shopee entra na entrega 4, como diz o brief). */
export const LOJAS_VIGIADAS = Object.freeze(['ml', 'amazon']);
/** Nome, preposição ("da Amazon", "do Mercado Livre"), gênero de "parada" e artigo de cada loja (spec §1.1). */
const LOJAS = Object.freeze({
  ml: Object.freeze({ nome: 'Mercado Livre', de: 'do', parada: 'parado', artigo: 'o' }),
  amazon: Object.freeze({ nome: 'Amazon', de: 'da', parada: 'parada', artigo: 'a' }),
  shopee: Object.freeze({ nome: 'Shopee', de: 'da', parada: 'parada', artigo: 'a' }),
  magalu: Object.freeze({ nome: 'Magalu', de: 'da', parada: 'parada', artigo: 'a' }),
});
const ORDEM_LOJAS = Object.freeze(['ml', 'amazon', 'shopee', 'magalu']);
const CAMPOS_LOJA = Object.freeze(['saiu', 'pulada', 'descartada', 'revisao', 'esperou']);
/** Esperas do ML que são a falta da extensão ou da Central (src/scheduler.js TEXTO_ESPERA). */
const ESPERAS_DA_FALTA = Object.freeze(['ml_extensao', 'ml_espera']);

// ---------- motivo e ação (spec §1.6: lista fechada, na ordem da tabela; o empate fica com o primeiro) ----------
const MUDARAM = 'Em geral passa sozinho: são ofertas que mudaram. Se continuar por mais de um dia, confira o catálogo do Etiqueta.';
/**
 * As linhas da tabela, cada uma com as chaves internas que caem nela: as de CAUSAS (src/verificador.js, que inclui as
 * da Central de src/links.js) e, sem causa, as de PULADA_POR, DESCARTADA_POR e TEXTO_ESPERA (src/scheduler.js), mais
 * `semConferencia` e `mlPausa` (as filtradas antes da escolha). Chave fora da tabela = "outro motivo".
 */
const TABELA_MOTIVOS = Object.freeze([
  { motivo: 'a Amazon bloqueou a leitura', chaves: ['etiqueta_bloqueio'],
    acao: 'Nada por agora: o programa tenta de novo no próximo envio. Se continuar, abra a Amazon no Chrome e veja se pede verificação.' },
  { motivo: 'o Etiqueta não respondeu', chaves: ['etiqueta_fora'], acao: 'Confira se o Etiqueta está ligado no computador.' },
  { motivo: 'o preço não pôde ser conferido', acao: 'Veja o Histórico: ele diz a causa de cada oferta.',
    chaves: ['loja_fora', 'demorou', 'sem_preco', 'varias_versoes', 'amazon_sem_api', 'shopee_sem_api', 'shopee_sem_produto', 'magalu',
      'etiqueta_ocupado', 'ml_verificacao', 'limite_hora', 'extensao_antiga', 'conferencia', 'desligado', 'nao_conferido',
      'semConferencia', 'mlPausa'] },
  { motivo: 'preço subiu além do limite', chaves: ['preco_subiu'], acao: MUDARAM },
  { motivo: 'esgotada na loja', chaves: ['esgotado'], acao: MUDARAM },
  { motivo: 'indisponível na loja', chaves: ['indisponivel', 'anuncio_inativo', 'recusada_ml', 'etiqueta_sem_oferta'], acao: MUDARAM },
  { motivo: 'fora dos filtros da regra', chaves: ['filtros'], soRegra: true,
    acao: 'Afrouxe os filtros da regra em Disparo automático ou espere novidades no catálogo.' },
  { motivo: 'já enviadas ou parecidas', chaves: ['parecido'], soRegra: true,
    acao: 'O catálogo está repetindo ofertas recentes. Em geral nada a fazer.' },
  { motivo: 'outro motivo', acao: 'Veja o Histórico no painel.',
    chaves: ['outro_produto', 'preco_suspeito', 'extensao_off', 'central_sem_resposta', 'central_aba', 'central_login', 'recusa_ml',
      'link', 'link_central', 'envio', 'espera', 'revisao_cheia', 'orcamento', 'ml_espera', 'ml_extensao', 'ml_direto', 'etiqueta', 'amazon'] },
]);
const OUTRO = TABELA_MOTIVOS.at(-1);
/**
 * Chave interna → { motivo, acao, soRegra? } da spec, §1.6. `soRegra`: o motivo só vale para a regra vazia (na loja
 * parada ele não entra na escolha do mais comum).
 */
export const MOTIVO_VIGIA = Object.freeze(Object.fromEntries(TABELA_MOTIVOS.flatMap((m) => m.chaves.map((k) => [k,
  Object.freeze({ motivo: m.motivo, acao: m.acao, ...(m.soRegra ? { soRegra: true } : {}) })]))));

/**
 * O motivo mais comum entre as ofertas que caíram fora (`motivos`: chave → n) e a ação dele. Empate: o primeiro da
 * tabela. `regra`: false na loja parada (os motivos só de regra ficam de fora). Nada contado → "outro motivo".
 * → { motivo, acao }
 */
export function motivoDe(motivos, { regra = false } = {}) {
  const contagem = new Map();
  if (motivos && typeof motivos === 'object') {
    for (const [k, n] of Object.entries(motivos)) {
      if (!(Number.isFinite(n) && n > 0)) continue;
      const m = Object.hasOwn(MOTIVO_VIGIA, k) ? MOTIVO_VIGIA[k] : OUTRO;
      if (m.soRegra && !regra) continue;
      contagem.set(m.motivo, (contagem.get(m.motivo) || 0) + n);
    }
  }
  let melhor = OUTRO; let maior = 0;
  for (const m of TABELA_MOTIVOS) {
    const n = contagem.get(m.motivo) || 0;
    if (n > maior) { melhor = m; maior = n; }
  }
  return { motivo: melhor.motivo, acao: melhor.acao };
}

// ---------- formatos ----------
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
/** "09:10" se for no dia de `agora`; senão "09:10 de 10/11" (o formato do Histórico). Sem `agora`, sempre com a data. */
function quando(ts, agora) {
  const d = new Date(ts);
  if (Number.isFinite(agora) && d.toDateString() === new Date(agora).toDateString()) return hhmm(ts);
  return `${hhmm(ts)} de ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
}
/** "2 h 10 min", "35 min", "3 h", "menos de 1 min". */
function duracao(ms) {
  const min = Math.round(Math.max(0, ms) / 60000);
  if (min < 1) return 'menos de 1 min';
  const h = Math.floor(min / 60); const m = min % 60;
  return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
}
const num = (n) => Number(n || 0).toLocaleString('pt-BR');
const plural = (n, um, varios) => `${num(n)} ${n === 1 ? um : varios}`;
/** A ação da tabela depois de "O que fazer:" e "Fazer:" começa com minúscula, como nos textos da spec. */
const minuscula = (s) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * Nome de regra que pode ir para o WhatsApp e para o Histórico: uma linha, sem número de telefone nem e-mail
 * (semNumero), sem `*` (negrito do WhatsApp) e com até MAX_NOME_VIGIA caracteres (reticências no corte). Vazio → "sem nome".
 */
export function nomeSeguro(v) {
  const bruto = String(v ?? '').slice(0, 500).replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, ' ').trim();
  if (!bruto) return 'sem nome';
  let t = semNumero(bruto).replace(/\*/g, '').replace(/\s+/g, ' ').trim();
  if (!t) return 'sem nome';
  if (t.length > MAX_NOME_VIGIA) {
    t = t.slice(0, MAX_NOME_VIGIA - 1);
    if (/[\uD800-\uDBFF]$/.test(t)) t = t.slice(0, -1); // não parte um emoji ao meio
    t = `${t.trimEnd()}…`;
  }
  return t;
}

// ---------- estado (gravado em settings pela etapa 3) ----------
//
// { cursor, abertas: { chave: causa }, caladas: { chave: true }, voltas: { chave: causa fechada }, ultimoAviso: { chave: ts },
//   seq: { lojas: { ml|amazon: { n, desde, fora, motivos } }, regras: { id: { n, desde, ultima, fora, motivos } } } }
//
// - chave: 'loja:ml', 'loja:amazon', 'ml_fora' (extensão ou Central), 'revisao', 'regra:<id>';
// - cursor: o maior id de `execucoes` já avaliado (null = ainda não marcado: a próxima passada só marca);
// - causa: { tipo, desdeEm, avisadaEm, n, … } — `avisadaEm` é quando o aviso de problema saiu (null = ainda não);
// - caladas: derivadas calada pela causa-raiz (a linha `info` sai uma vez por mudança, não por execução);
// - voltas: causas que fecharam depois de avisadas e cujo "voltou" ainda não saiu (D9).
// O createVigia grava junto `segurado: { motivo: 'silencio'|'whatsapp', desde }` enquanto há aviso devido esperando
// (lido por seguradoDe; lerEstado o ignora).
const RE_CHAVE = /^(?:loja:(?:ml|amazon)|ml_fora|revisao|regra:[1-9]\d{0,14})$/;
const RE_ID_REGRA = /^[1-9]\d{0,14}$/;
const RE_MOTIVO = /^[a-z][A-Za-z_]{0,39}$/;
const MAX_MOTIVOS = 60;
const MAX_REGRAS_SEQ = 500;

const inteiro = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
/** Instante válido, cortado para `agora` se estiver no futuro; senão null. */
const instante = (v, agora) => (Number.isFinite(v) && v > 0 ? Math.min(v, agora) : null);
const objeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function motivosLimpos(m) {
  const r = {};
  if (!objeto(m)) return r;
  let k = 0;
  for (const [chave, n] of Object.entries(m)) {
    if (k >= MAX_MOTIVOS) break;
    if (RE_MOTIVO.test(chave) && Number.isSafeInteger(n) && n > 0) { r[chave] = n; k++; }
  }
  return r;
}
function somarMotivos(destino, origem) {
  for (const [k, n] of Object.entries(origem)) {
    if (Object.hasOwn(destino, k)) destino[k] += n;
    else if (Object.keys(destino).length < MAX_MOTIVOS) destino[k] = n;
  }
}

/** Causa gravada → causa no formato, ou null (descartada). */
function causaLimpa(chave, c, agora) {
  if (!objeto(c)) return null;
  const desdeEm = instante(c.desdeEm, agora);
  if (desdeEm === null) return null;
  const base = { desdeEm, avisadaEm: instante(c.avisadaEm, agora), n: inteiro(c.n) };
  if (chave.startsWith('loja:')) return { tipo: 'loja', loja: chave.slice(5), ...base, fora: inteiro(c.fora), motivos: motivosLimpos(c.motivos) };
  if (chave === 'ml_fora') return { tipo: c.tipo === 'central' ? 'central' : 'extensao', ...base };
  if (chave === 'revisao') return { tipo: 'revisao', ...base, maisAntigaEm: instante(c.maisAntigaEm, agora) };
  const horas = Array.isArray(c.horas) ? c.horas : [];
  return {
    tipo: 'regra', rule_id: Number(chave.slice(6)), ...base, fora: inteiro(c.fora), motivos: motivosLimpos(c.motivos),
    horas: [instante(horas[0], agora) ?? desdeEm, instante(horas[1], agora) ?? desdeEm],
  };
}
function sequenciaLimpa(s, agora, { regra = false } = {}) {
  if (!objeto(s)) return null;
  const desde = instante(s.desde, agora);
  if (desde === null || !inteiro(s.n)) return null;
  const r = { n: inteiro(s.n), desde, fora: inteiro(s.fora), motivos: motivosLimpos(s.motivos) };
  if (regra) r.ultima = instante(s.ultima, agora) ?? desde;
  return r;
}

/**
 * Estado gravado (texto JSON ou objeto) → estado no formato. O que está fora do formato é descartado e o instante no
 * futuro é cortado para `agora`. Nunca muda o valor recebido.
 */
export function lerEstado(valor, agora) {
  let o = valor;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch { o = null; } }
  const e = { cursor: null, abertas: {}, caladas: {}, voltas: {}, ultimoAviso: {}, seq: { lojas: {}, regras: {} } };
  if (!objeto(o)) return e;
  if (Number.isSafeInteger(o.cursor) && o.cursor >= 0) e.cursor = o.cursor;
  for (const [chave, c] of Object.entries(objeto(o.abertas) ? o.abertas : {})) {
    const limpa = RE_CHAVE.test(chave) ? causaLimpa(chave, c, agora) : null;
    if (limpa) e.abertas[chave] = limpa;
  }
  for (const [chave, c] of Object.entries(objeto(o.voltas) ? o.voltas : {})) {
    const limpa = RE_CHAVE.test(chave) ? causaLimpa(chave, c, agora) : null;
    const fechadaEm = instante(c?.fechadaEm, agora);
    if (limpa && fechadaEm !== null) e.voltas[chave] = { ...limpa, fechadaEm, saiu: inteiro(c.saiu) };
  }
  for (const [chave, v] of Object.entries(objeto(o.caladas) ? o.caladas : {})) if (RE_CHAVE.test(chave) && v === true) e.caladas[chave] = true;
  for (const [chave, ts] of Object.entries(objeto(o.ultimoAviso) ? o.ultimoAviso : {})) {
    const t = RE_CHAVE.test(chave) ? instante(ts, agora) : null;
    if (t !== null) e.ultimoAviso[chave] = t;
  }
  const seq = objeto(o.seq) ? o.seq : {};
  for (const loja of LOJAS_VIGIADAS) {
    const s = objeto(seq.lojas) && Object.hasOwn(seq.lojas, loja) ? sequenciaLimpa(seq.lojas[loja], agora) : null;
    if (s) e.seq.lojas[loja] = s;
  }
  for (const [id, s] of Object.entries(objeto(seq.regras) ? seq.regras : {})) {
    if (Object.keys(e.seq.regras).length >= MAX_REGRAS_SEQ) break;
    const limpa = RE_ID_REGRA.test(id) ? sequenciaLimpa(s, agora, { regra: true }) : null;
    if (limpa) e.seq.regras[id] = limpa;
  }
  return e;
}

// ---------- entrada de avaliar ----------

/** Contadores de uma loja numa execução (por_loja do agendador), sempre com os cinco campos e os motivos limpos. */
function contadores(x) {
  const r = { motivos: motivosLimpos(x?.motivos) };
  for (const c of CAMPOS_LOJA) r[c] = inteiro(x?.[c]);
  return r;
}
/** Linha de `execucoes` (como vem do banco: por_loja e lojas_pedidas em JSON) → execução normalizada, ou null. */
function execucaoLimpa(row) {
  if (!objeto(row) || !Number.isSafeInteger(row.id) || row.id <= 0 || !Number.isFinite(row.ts)) return null;
  let por = row.por_loja; let lojas = row.lojas_pedidas;
  if (typeof por === 'string') { try { por = JSON.parse(por); } catch { por = null; } }
  if (typeof lojas === 'string') { try { lojas = JSON.parse(lojas); } catch { lojas = null; } }
  const pl = {};
  for (const l of ORDEM_LOJAS) pl[l] = contadores(objeto(por) && Object.hasOwn(por, l) ? por[l] : null);
  const pedidas = Array.isArray(lojas) ? ORDEM_LOJAS.filter((l) => lojas.includes(l)) : [];
  const somaSaiu = ORDEM_LOJAS.reduce((a, l) => a + pl[l].saiu, 0);
  return {
    id: row.id, ts: row.ts, ruleId: Number.isSafeInteger(row.rule_id) ? row.rule_id : null,
    conta: row.conta === 1 || row.conta === true,
    saidas: Number.isSafeInteger(row.saidas) && row.saidas >= 0 ? row.saidas : somaSaiu,
    erros: inteiro(row.erros), lojas: pedidas.length ? pedidas : [...LOJAS_VIGIADAS], pl,
  };
}
/** Regras ativas → Map(id → { id, nome seguro, vigiadas }). Lista de lojas vazia (ou fonte antiga) = Amazon e ML. */
function mapaDeRegras(regrasAtivas) {
  const m = new Map();
  for (const r of regrasAtivas) {
    if (!objeto(r) || !Number.isSafeInteger(r.id) || r.id <= 0) continue;
    const lojas = Array.isArray(r.lojas) ? r.lojas.filter((l) => typeof l === 'string') : [];
    m.set(r.id, { id: r.id, nome: nomeSeguro(r.nome ?? r.name), vigiadas: lojas.length ? LOJAS_VIGIADAS.filter((l) => lojas.includes(l)) : [...LOJAS_VIGIADAS] });
  }
  return m;
}

// ---------- causa para fora (devidos, /api/state, saúde) ----------
const PRIORIDADE = Object.freeze({ loja: 0, extensao: 1, central: 1, revisao: 2, regra: 3 });
const valida = (c) => objeto(c) && Object.hasOwn(PRIORIDADE, c.tipo) && Number.isFinite(c.desdeEm)
  && (c.tipo !== 'loja' || Object.hasOwn(LOJAS, c.loja ?? ''));
/** Ordem das mensagens e das listas: loja, extensão ou Central, revisão, regra; dentro do tipo, a mais antiga antes. */
const ordenar = (lista) => (Array.isArray(lista) ? lista.filter(valida) : [])
  .sort((a, b) => PRIORIDADE[a.tipo] - PRIORIDADE[b.tipo] || a.desdeEm - b.desdeEm);

/** Causa do estado → { tipo, chave, loja?, rule_id?, regra?, n, desdeEm, calada: false, … } (nomes da spec e do plano). */
function publica(chave, c, regras) {
  const p = { tipo: c.tipo, chave, desdeEm: c.desdeEm, n: c.n, calada: false };
  if (c.tipo === 'loja') p.loja = c.loja;
  if (c.tipo === 'regra') { p.rule_id = c.rule_id; p.regra = regras.get(c.rule_id)?.nome ?? 'sem nome'; p.horas = [...c.horas]; }
  if (c.tipo === 'loja' || c.tipo === 'regra') { p.fora = c.fora; p.motivos = { ...c.motivos }; }
  if (c.tipo === 'revisao' && c.maisAntigaEm != null) p.maisAntigaEm = c.maisAntigaEm;
  if (c.fechadaEm != null) { p.fechadaEm = c.fechadaEm; p.saiu = c.saiu ?? 0; }
  return p;
}

/**
 * As causas abertas (nunca as caladas), no formato de `/api/state` e da linha de saúde, já em ordem. `regrasAtivas` dá o
 * nome da regra (o estado não guarda nomes).
 */
export function causasAbertas(estado, { regrasAtivas = [], agora } = {}) {
  const e = lerEstado(estado, Number.isFinite(agora) ? agora : Number.MAX_SAFE_INTEGER);
  const regras = mapaDeRegras(Array.isArray(regrasAtivas) ? regrasAtivas : []);
  return ordenar(Object.entries(e.abertas).map(([k, c]) => publica(k, c, regras)));
}

/** O aviso de problema destas causas saiu em `agora`: marca a causa como avisada e conta o freio. → estado novo */
export function marcarAvisados(estado, causas, agora) {
  const e = lerEstado(estado, agora);
  for (const c of Array.isArray(causas) ? causas : []) {
    const chave = c?.chave;
    if (typeof chave !== 'string' || !Object.hasOwn(e.abertas, chave)) continue;
    e.abertas[chave].avisadaEm = agora;
    e.ultimoAviso[chave] = agora;
  }
  return e;
}

/** O "voltou" destas causas saiu em `agora`: não fica mais devido e conta o freio do próximo problema. → estado novo */
export function marcarVoltas(estado, causas, agora) {
  const e = lerEstado(estado, agora);
  for (const c of Array.isArray(causas) ? causas : []) {
    const chave = c?.chave;
    if (typeof chave !== 'string' || !Object.hasOwn(e.voltas, chave)) continue;
    delete e.voltas[chave];
    e.ultimoAviso[chave] = agora;
  }
  return e;
}

// ---------- avaliar ----------

/** Nome curto da causa (título de várias causas, linha do freio, saúde). */
function nomeCurto(c) {
  if (c.tipo === 'loja') return `${LOJAS[c.loja].nome} ${LOJAS[c.loja].parada}`;
  if (c.tipo === 'extensao') return 'extensão fora';
  if (c.tipo === 'central') return 'Mercado Livre em espera';
  if (c.tipo === 'revisao') return 'revisão acumulada';
  return `regra “${nomeSeguro(c.regra)}” vazia`;
}

/**
 * Uma passada do vigia sobre as execuções novas (id acima do cursor) e o estado da hora. Pura: não grava nada, não
 * manda nada e não lê relógio.
 *
 * Entrada:
 * - `execucoes`: linhas de `execucoes` (pode trazer as já vistas: só as de id acima do cursor contam). Sem cursor no
 *   estado, a passada só marca o maior id e não avalia o passado;
 * - `estado`: o gravado (texto ou objeto; lido por lerEstado);
 * - `revisao`: { n, maisAntigaEm } das ofertas esperando revisão (n fora do formato = revisão não avaliada);
 * - `extensao`: { online, desde } — `desde` = max(lastPollAt, início do serviço) (D5);
 * - `central`: { estado, emEsperaDesde } de links.status().central (o `ultimoErro` nunca é lido);
 * - `regrasAtivas`: [{ id, nome, lojas }] — `lojas` vazia = Amazon e Mercado Livre;
 * - `modoLink`: 'extension' | 'direct' | 'fake' (a causa da extensão só existe no modo da extensão);
 * - `agora`: o relógio.
 *
 * → { estado, linhas: [{ level: 'aviso'|'info', message }], devidos: { problemas: [causa], voltas: [causa] } }.
 * `devidos.problemas`: abertas, ainda não avisadas e fora do freio. `devidos.voltas`: fechadas depois de avisadas e
 * com o "voltou" ainda por sair. Quem manda marca com marcarAvisados / marcarVoltas.
 */
export function avaliar({ execucoes = [], estado = null, revisao = null, extensao = null, central = null, regrasAtivas, modoLink = null, agora } = {}) {
  if (!Number.isFinite(agora)) throw new TypeError('vigia: agora inválido');
  if (!Array.isArray(regrasAtivas)) throw new TypeError('vigia: lista de regras ativas inválida');
  const e = lerEstado(estado, agora);
  const linhas = [];
  const info = (message) => linhas.push({ level: 'info', message });
  const aviso = (message) => linhas.push({ level: 'aviso', message });

  const regras = mapaDeRegras(regrasAtivas);
  const pedidas = new Set([...regras.values()].flatMap((r) => r.vigiadas));
  const viaExtensao = modoLink === 'extension';
  // a falta do Mercado Livre agora (estado da hora): extensão desconectada ou Central em espera
  let falta = null;
  if (viaExtensao && extensao?.online === false) falta = { tipo: 'extensao', desde: instante(extensao.desde, agora) };
  else if (viaExtensao && central?.estado === 'em_espera') falta = { tipo: 'central', desde: instante(central.emEsperaDesde, agora) };
  const nRevisao = Number.isSafeInteger(revisao?.n) && revisao.n >= 0 ? revisao.n : null;
  const maisAntiga = instante(revisao?.maisAntigaEm, agora);

  const freioLivre = (chave) => !Object.hasOwn(e.ultimoAviso, chave) || agora - e.ultimoAviso[chave] >= FREIO_MS;
  const nomeDe = (c) => nomeCurto(publica('', c, regras));

  /** Abre a causa. Se ela fechou avisada e o "voltou" não saiu, para o dono nunca acabou: herda o aviso e o início (D9). */
  function abrir(chave, causa, texto) {
    const pendente = e.voltas[chave];
    if (pendente) {
      delete e.voltas[chave];
      causa.desdeEm = pendente.desdeEm; causa.avisadaEm = pendente.avisadaEm;
    } else causa.avisadaEm = null;
    e.abertas[chave] = causa;
    delete e.caladas[chave];
    aviso(texto);
    if (causa.avisadaEm === null && !freioLivre(chave)) info(`Aviso do vigia sobre ${nomeDe(causa)} segurado (freio de ${FREIO_VIGIA_H} h).`);
  }
  /** Fecha a causa (linha info). Só a avisada deixa um "voltou" devido; `semVolta`: fechou por perder o objeto (CA3.12). */
  function fechar(chave, texto, { fechadaEm = agora, saiu = 0, semVolta = false } = {}) {
    const c = e.abertas[chave];
    delete e.abertas[chave]; delete e.caladas[chave];
    info(texto);
    if (!semVolta && c.avisadaEm !== null) e.voltas[chave] = { ...c, fechadaEm, saiu };
  }
  /** Derivada calada pela causa-raiz: não abre; uma linha info por mudança. */
  function calar(chave, texto) {
    if (e.caladas[chave]) return;
    e.caladas[chave] = true;
    info(texto);
  }
  /** O que cala o Mercado Livre agora: a causa da extensão ou da Central aberta, ou a falta da hora. → frase ou null */
  function raizDoMl() {
    const tipo = e.abertas.ml_fora?.tipo ?? falta?.tipo;
    if (tipo === 'central') return 'o Mercado Livre está em espera';
    if (tipo === 'extensao') return 'a extensão do Chrome está fora';
    return null;
  }
  /** O que cala a regra vazia: só a regra que pede uma loja vigiada (só ML: a falta do ML; a loja parada dela). */
  function raizDaRegra(r) {
    if (r.vigiadas.length !== 1) return null;
    const l = r.vigiadas[0];
    if (l === 'ml') { const t = raizDoMl(); if (t) return t; }
    if (e.abertas[`loja:${l}`]) return `${LOJAS[l].artigo} ${LOJAS[l].nome} está ${LOJAS[l].parada}`;
    return null;
  }

  // 1. causa que perdeu o objeto: fecha sem "voltou" (CA3.12); as sequências e as caladas do objeto somem junto
  for (const chave of Object.keys(e.abertas)) {
    const c = e.abertas[chave];
    if (c.tipo === 'regra' && !regras.has(c.rule_id)) {
      fechar(chave, 'Vigia: o aviso de regra vazia foi encerrado sem aviso de volta: a regra foi desligada ou apagada.', { semVolta: true });
    } else if (c.tipo === 'loja' && !pedidas.has(c.loja)) {
      const L = LOJAS[c.loja];
      fechar(chave, `Vigia: o aviso de ${L.nome} ${L.parada} foi encerrado sem aviso de volta: nenhuma regra ativa pede ${L.artigo} ${L.nome}.`, { semVolta: true });
    } else if (chave === 'ml_fora' && !viaExtensao) {
      fechar(chave, 'Vigia: o aviso do Mercado Livre foi encerrado sem aviso de volta: os links não usam mais a extensão do Chrome.', { semVolta: true });
    } else if (chave === 'ml_fora' && !pedidas.has('ml')) {
      fechar(chave, 'Vigia: o aviso do Mercado Livre foi encerrado sem aviso de volta: nenhuma regra ativa pede o Mercado Livre.', { semVolta: true });
    }
  }
  for (const id of Object.keys(e.seq.regras)) if (!regras.has(Number(id))) delete e.seq.regras[id];
  for (const l of Object.keys(e.seq.lojas)) if (!pedidas.has(l)) delete e.seq.lojas[l];
  for (const chave of Object.keys(e.voltas)) if (e.voltas[chave].tipo === 'regra' && !regras.has(e.voltas[chave].rule_id)) delete e.voltas[chave];
  for (const chave of Object.keys(e.caladas)) {
    const [tipo, id] = chave.split(':');
    if ((tipo === 'regra' && !regras.has(Number(id))) || (tipo === 'loja' && !pedidas.has(id))) delete e.caladas[chave];
  }

  // 2. as execuções novas, em ordem (só as que contam; as outras só andam o cursor)
  const todas = (Array.isArray(execucoes) ? execucoes : []).map(execucaoLimpa).filter(Boolean).sort((a, b) => a.id - b.id);
  let novas = [];
  if (e.cursor === null) {
    if (todas.length) e.cursor = todas.at(-1).id; // primeira passada (ou estado descartado): marca, não avalia o passado
  } else {
    novas = todas.filter((x) => x.id > e.cursor);
    if (novas.length) e.cursor = novas.at(-1).id;
  }
  let ultimaQueConta = null;
  for (const x of novas) {
    if (!x.conta) continue;
    ultimaQueConta = x.ts;

    // extensão ou Central fora: o ML esperou por ela nesta execução e a falta começou há FORA_MIN ou mais
    if (viaExtensao && pedidas.has('ml')) {
      const ml = x.pl.ml;
      const aberta = e.abertas.ml_fora;
      if (aberta) { if (ml.esperou > 0) aberta.n = ml.esperou; } else if (falta && falta.desde !== null && x.ts - falta.desde >= FORA_MS
        && ESPERAS_DA_FALTA.some((k) => ml.motivos[k] > 0)) {
        const texto = falta.tipo === 'central'
          ? `Vigia: Mercado Livre em espera desde ${quando(falta.desde, agora)} (a Central de Afiliados não está respondendo).`
          : `Vigia: extensão do Chrome fora desde ${quando(falta.desde, agora)} (o Mercado Livre não envia sem ela).`;
        abrir('ml_fora', { tipo: falta.tipo, desdeEm: falta.desde, n: ml.esperou }, texto);
      }
    }

    // loja parada: execução com atividade da loja; só revisão (ou nada) é neutra
    for (const l of LOJAS_VIGIADAS) {
      if (!pedidas.has(l)) continue;
      const L = LOJAS[l]; const chave = `loja:${l}`; const c = x.pl[l];
      const fora = c.pulada + c.descartada + c.esperou;
      if (c.saiu > 0) {
        delete e.seq.lojas[l];
        const aberta = e.abertas[chave];
        if (aberta) fechar(chave, `Vigia: ${L.nome} voltou a enviar (esteve ${L.parada} por ${duracao(x.ts - aberta.desdeEm)}).`, { fechadaEm: x.ts, saiu: c.saiu });
        else delete e.caladas[chave];
      } else if (fora > 0) {
        const s = e.seq.lojas[l] ??= { n: 0, desde: x.ts, fora: 0, motivos: {} };
        s.n++; s.fora += fora; somarMotivos(s.motivos, c.motivos);
        const aberta = e.abertas[chave];
        if (aberta) Object.assign(aberta, { n: s.n, fora: s.fora, motivos: { ...s.motivos } });
        else if (s.n >= EXECUCOES_LOJA_PARADA) {
          const raiz = l === 'ml' ? raizDoMl() : null;
          if (raiz) calar(chave, `Vigia: ${L.nome} ${L.parada} (${s.n} execuções sem envio), mas ${raiz}: sem aviso separado.`);
          else {
            const { motivo } = motivoDe(s.motivos);
            abrir(chave, { tipo: 'loja', loja: l, desdeEm: s.desde, n: s.n, fora: s.fora, motivos: { ...s.motivos } },
              `Vigia: ${L.nome} ${L.parada} (${s.n} execuções sem envio; motivo mais comum: ${motivo}).`);
          }
        }
      }
    }

    // regra vazia: 0 saídas e alguma oferta fora; só revisão (ou nada) é neutra
    const r = x.ruleId !== null ? regras.get(x.ruleId) : null;
    if (r) {
      const chave = `regra:${r.id}`; const id = String(r.id);
      const fora = ORDEM_LOJAS.reduce((a, l) => a + x.pl[l].pulada + x.pl[l].descartada + x.pl[l].esperou, 0);
      if (x.saidas > 0) {
        delete e.seq.regras[id];
        const aberta = e.abertas[chave];
        if (aberta) fechar(chave, `Vigia: a regra “${r.nome}” voltou a enviar (esteve vazia por ${duracao(x.ts - aberta.desdeEm)}).`, { fechadaEm: x.ts, saiu: x.saidas });
        else delete e.caladas[chave];
      } else if (fora > 0) {
        const s = e.seq.regras[id] ??= { n: 0, desde: x.ts, ultima: x.ts, fora: 0, motivos: {} };
        s.n++; s.ultima = x.ts; s.fora += fora;
        for (const l of ORDEM_LOJAS) somarMotivos(s.motivos, x.pl[l].motivos);
        const dados = { n: s.n, fora: s.fora, motivos: { ...s.motivos }, horas: [s.desde, s.ultima] };
        const aberta = e.abertas[chave];
        if (aberta) Object.assign(aberta, dados);
        else if (s.n >= EXECUCOES_REGRA_VAZIA) {
          const raiz = raizDaRegra(r);
          if (raiz) calar(chave, `Vigia: a regra “${r.nome}” saiu vazia, mas ${raiz}: sem aviso separado.`);
          else {
            const { motivo } = motivoDe(s.motivos, { regra: true });
            abrir(chave, { tipo: 'regra', rule_id: r.id, desdeEm: s.desde, ...dados },
              `Vigia: a regra “${r.nome}” saiu vazia ${s.n} vezes seguidas (motivo mais comum: ${motivo}).`);
          }
        }
      }
    }
  }

  // 3. revisão acumulada: abre numa passada com execução que conta; fecha (e se atualiza) em qualquer passada
  if (nRevisao !== null) {
    const aberta = e.abertas.revisao;
    if (aberta) {
      aberta.n = nRevisao; aberta.maisAntigaEm = maisAntiga;
      if (nRevisao <= REVISAO_FECHA) {
        fechar('revisao', `Vigia: revisão em dia (${nRevisao === 0 ? 'nenhuma oferta esperando' : `${nRevisao === 1 ? 'resta' : 'restam'} ${plural(nRevisao, 'oferta esperando', 'ofertas esperando')}`}).`);
      }
    } else if (ultimaQueConta !== null && nRevisao >= REVISAO_ABRE) {
      abrir('revisao', { tipo: 'revisao', desdeEm: ultimaQueConta, n: nRevisao, maisAntigaEm: maisAntiga },
        `Vigia: ${plural(nRevisao, 'oferta esperando', 'ofertas esperando')} revisão (o aviso abre com ${REVISAO_ABRE}).`);
    }
  }

  // 4. extensão de volta e Central respondendo: fecha a cada passada, sem esperar execução
  const fora = e.abertas.ml_fora;
  if (fora) {
    if (extensao?.online === true && central?.estado === 'respondendo') {
      const quem = fora.tipo === 'central' ? 'a Central de Afiliados' : 'a extensão do Chrome';
      fechar('ml_fora', `Vigia: Mercado Livre voltou a enviar (${quem} respondeu de novo; esteve fora por ${duracao(agora - fora.desdeEm)}).`);
    } else if (falta) fora.tipo = falta.tipo; // a redação acompanha o estado da hora (spec §1.2)
  }

  // 5. o que está devido
  const problemas = ordenar(Object.entries(e.abertas)
    .filter(([chave, c]) => c.avisadaEm === null && freioLivre(chave)).map(([chave, c]) => publica(chave, c, regras)));
  const voltas = ordenar(Object.entries(e.voltas).map(([chave, c]) => publica(chave, c, regras)));
  return { estado: e, linhas, devidos: { problemas, voltas } };
}

// ---------- mensagens do WhatsApp (spec §1) ----------

const ACAO_EXTENSAO = 'abra o Chrome com a extensão instalada e entre na Central de Afiliados com a sua conta.';
const ACAO_CENTRAL = 'nada, a menos que passe de 1 hora. Aí abra a Central no Chrome e veja se a página carrega e se a sua conta está logada.';
const SOB_O_TITULO = Object.freeze({
  silencio: 'O programa estava em silêncio e agora vai avisando.',
  whatsapp: 'O WhatsApp ficou desconectado e agora voltou.',
});
const ficaram = (n) => `${num(n)} ${n === 1 ? 'ficou' : 'ficaram'} de fora`;
const esperando = (n) => (n > 0 ? ` (${plural(n, 'oferta esperando', 'ofertas esperando')})` : '');

/** Horas da regra vazia: "Às 09:00 e às 12:00" (2 execuções) ou "De 09:00 a 15:00" (mais de 2). */
function horasDaRegra(c, agora) {
  const [h1, h2] = Array.isArray(c.horas) && c.horas.length === 2 ? c.horas : [c.desdeEm, c.desdeEm];
  return c.n === 2 ? `Às ${quando(h1, agora)} e às ${quando(h2, agora)}` : `De ${quando(h1, agora)} a ${quando(h2, agora)}`;
}

/**
 * As partes de uma causa: `linhas` (a mensagem dela sozinha), `item` (o título em negrito, nas mensagens de várias),
 * `detalhe` (a frase curta, só com 2 ou 3 causas) e `fazer` (a ação).
 */
function partes(c, agora) {
  const desde = quando(c.desdeEm, agora);
  if (c.tipo === 'loja') {
    const L = LOJAS[c.loja]; const m = motivoDe(c.motivos);
    const fora = c.fora > 0 ? ` (${ficaram(c.fora)}: ${m.motivo})` : '';
    return {
      linhas: [`⚠️ *${L.nome} ${L.parada} desde ${desde}*`, `Nas últimas ${num(c.n)} execuções nenhuma oferta ${L.de} ${L.nome} saiu${fora}.`, `O que fazer: ${minuscula(m.acao)}`],
      item: `*${L.nome} ${L.parada} desde ${desde}.*`, detalhe: `Nenhuma oferta saiu nas últimas ${num(c.n)} execuções.`, fazer: minuscula(m.acao),
    };
  }
  if (c.tipo === 'extensao') {
    return {
      linhas: [`⚠️ *Extensão do Chrome fora desde ${desde}*`, `O Mercado Livre não envia sem ela${esperando(c.n)}.`, `O que fazer: ${ACAO_EXTENSAO}`],
      item: `*Extensão do Chrome fora desde ${desde}.*`, detalhe: 'O Mercado Livre não envia sem ela.', fazer: ACAO_EXTENSAO,
    };
  }
  if (c.tipo === 'central') {
    return {
      linhas: [`⚠️ *Mercado Livre em espera desde ${desde}*`,
        `A Central de Afiliados não está respondendo${esperando(c.n)}. O programa testa de novo a cada ${TESTE_ESPERA_MIN} min.`, `O que fazer: ${ACAO_CENTRAL}`],
      item: `*Mercado Livre em espera desde ${desde}.*`, detalhe: 'A Central de Afiliados não está respondendo.', fazer: ACAO_CENTRAL,
    };
  }
  if (c.tipo === 'revisao') {
    const ofertas = plural(c.n, 'oferta esperando', 'ofertas esperando');
    const antiga = Number.isFinite(c.maisAntigaEm) && Number.isFinite(agora) ? ` A mais antiga espera há ${duracao(agora - c.maisAntigaEm)}.` : '';
    return {
      linhas: [`⚠️ *${ofertas} a sua revisão*`, `${c.n === 1 ? 'Ela não sai' : 'Elas não saem'} até você decidir.${antiga}`,
        'O que fazer: abra Histórico > Catálogo, confira e envie ou descarte.'],
      item: `*${ofertas} a sua revisão.*`, detalhe: '', fazer: 'abra Histórico > Catálogo.',
    };
  }
  const nome = nomeSeguro(c.regra); const m = motivoDe(c.motivos, { regra: true });
  const fora = c.fora > 0 ? ` (${ficaram(c.fora)}: ${m.motivo})` : '';
  return {
    linhas: [`⚠️ *A regra “${nome}” saiu vazia ${num(c.n)} vezes seguidas*`, `${horasDaRegra(c, agora)} nenhuma oferta saiu${fora}.`, `O que fazer: ${minuscula(m.acao)}`],
    item: `*A regra “${nome}” saiu vazia ${num(c.n)} vezes seguidas.*`, detalhe: `${horasDaRegra(c, agora)} nenhuma oferta saiu.`, fazer: minuscula(m.acao),
  };
}

/**
 * Mensagem de problema com as causas devidas (spec §1 e §1.8), ou null sem nenhuma. 1 causa: a mensagem dela, com o
 * início original. 2 ou 3: cabeçalho e um item com detalhe para cada. 4 ou mais: título com 3 nomes e "e mais N",
 * itens sem detalhe (até MAX_ITENS) e "Detalhes no painel, no Histórico.". `motivo`: por que a mensagem esperou
 * ('silencio' | 'whatsapp' | null), dito sob o título quando há mais de uma causa.
 */
export function mensagemProblemas(causas, { motivo = null, agora = null } = {}) {
  const lista = ordenar(causas);
  if (!lista.length) return null;
  if (lista.length === 1) return partes(lista[0], agora).linhas.join('\n');
  const k = lista.length; const curtas = k <= 3;
  const nomes = lista.slice(0, 3).map(nomeCurto).join(', ');
  const linhas = [`⚠️ *${k} problemas: ${nomes}${curtas ? '' : ` e mais ${k - 3}`}*`];
  if (Object.hasOwn(SOB_O_TITULO, motivo ?? '')) linhas.push(SOB_O_TITULO[motivo]);
  linhas.push('');
  lista.slice(0, MAX_ITENS).forEach((c, i) => {
    const p = partes(c, agora);
    linhas.push(`${i + 1}. ${p.item}${curtas && p.detalhe ? ` ${p.detalhe}` : ''} Fazer: ${p.fazer}`);
  });
  if (k > MAX_ITENS) linhas.push(`E mais ${plural(k - MAX_ITENS, 'problema', 'problemas')}.`);
  if (!curtas) linhas.push('Detalhes no painel, no Histórico.');
  return linhas.join('\n');
}

const saiuTexto = (n) => (n > 1 ? `Saíram ${num(n)} ofertas` : 'Saiu uma oferta');
const restam = (n) => (n === 0 ? 'Nenhuma oferta esperando' : `${n === 1 ? 'Resta' : 'Restam'} ${plural(n, 'oferta esperando', 'ofertas esperando')}`);

/** "Voltou" de uma causa: { titulo, corpo (mensagem sozinha), nota (entre parênteses, na mensagem de várias) }. */
function volta(c, agora) {
  const fechada = Number.isFinite(c.fechadaEm) ? c.fechadaEm : agora;
  const tempo = duracao(fechada - c.desdeEm);
  if (c.tipo === 'loja') {
    const L = LOJAS[c.loja];
    return { titulo: `${L.nome} voltou a enviar`, corpo: `${saiuTexto(c.saiu)} às ${quando(fechada, agora)} (a loja esteve parada por ${tempo}). Nada a fazer.`,
      nota: `esteve ${L.parada} por ${tempo}` };
  }
  if (c.tipo === 'extensao' || c.tipo === 'central') {
    const quem = c.tipo === 'central' ? 'Central de Afiliados' : 'Extensão do Chrome';
    return { titulo: 'Mercado Livre voltou a enviar', corpo: `A ${quem} respondeu de novo (esteve fora por ${tempo}). As ofertas saem sozinhas, nada a fazer.`,
      nota: `${c.tipo === 'central' ? 'a Central de Afiliados' : 'a extensão do Chrome'} respondeu de novo; esteve fora por ${tempo}` };
  }
  if (c.tipo === 'revisao') return { titulo: 'Revisão em dia', corpo: `${restam(c.n)}. Nada a fazer.`, nota: minuscula(restam(c.n)) };
  const s = `${saiuTexto(c.saiu)} às ${quando(fechada, agora)}`;
  return { titulo: `A regra “${nomeSeguro(c.regra)}” voltou a enviar`, corpo: `${s}. Nada a fazer.`, nota: minuscula(s) };
}

/** Mensagem de "voltou ao normal" com as causas devidas, ou null sem nenhuma. Várias vão numa mensagem só. */
export function mensagemVoltas(causas, agora) {
  const lista = ordenar(causas);
  if (!lista.length) return null;
  if (lista.length === 1) { const v = volta(lista[0], agora); return `✅ *${v.titulo}*\n${v.corpo}`; }
  const linhas = [`✅ *${lista.length} problemas voltaram ao normal*`];
  lista.slice(0, MAX_ITENS).forEach((c, i) => { const v = volta(c, agora); linhas.push(`${i + 1}. *${v.titulo}* (${v.nota}).`); });
  if (lista.length > MAX_ITENS) linhas.push(`E mais ${plural(lista.length - MAX_ITENS, 'problema', 'problemas')}.`);
  linhas.push('Nada a fazer.');
  return linhas.join('\n');
}

// ---------- linha de saúde do resumo diário (spec §2; Decisão 7) ----------

/** "Amazon parada desde 09:10", "extensão fora desde 14:20", "12 ofertas esperando revisão desde 08:30"… */
function abertaComDesde(c, agora) {
  const desde = `desde ${quando(c.desdeEm, agora)}`;
  if (c.tipo === 'revisao') return `${plural(c.n, 'oferta esperando', 'ofertas esperando')} revisão ${desde}`;
  return `${nomeCurto(c)} ${desde}`;
}

/**
 * O bloco "Saúde dos envios" do resumo (no máximo 5 linhas), com as execuções do dia de negócio de todas as regras.
 * `revisao`: n (ou { n }) esperando revisão; `abertas`: causasAbertas(); `temRegraAtiva`: há regra ativa (sem
 * execução e sem regra ativa, a frase de "nenhuma regra rodou"; com regra ativa, os zeros). `agora`: só para a hora
 * das causas em aberto (sem ele, a data vai sempre junto). Puladas = puladas + as que esperaram; Falhas = `erros`.
 */
export function linhaDeSaude({ execucoes = [], revisao = 0, abertas = [], temRegraAtiva = false, agora = null } = {}) {
  const dia = (Array.isArray(execucoes) ? execucoes : []).map(execucaoLimpa).filter(Boolean);
  const nRev = inteiro(typeof revisao === 'number' ? revisao : revisao?.n);
  const lista = ordenar(abertas);
  const emAberto = lista.length ? `Em aberto agora: ${lista.map((c) => abertaComDesde(c, agora)).join('; ')}.` : null;
  if (!dia.length && !temRegraAtiva) {
    return ['🩺 *Saúde dos envios*', 'Nenhuma regra rodou hoje: não havia regra ativa com horário no dia.', ...(emAberto ? [emAberto] : [])].join('\n');
  }
  const enviadas = Object.fromEntries(ORDEM_LOJAS.map((l) => [l, 0]));
  const pedidas = new Set();
  let puladas = 0; let descartadas = 0; let falhas = 0;
  for (const x of dia) {
    for (const l of x.lojas) pedidas.add(l);
    for (const l of ORDEM_LOJAS) {
      enviadas[l] += x.pl[l].saiu; puladas += x.pl[l].pulada + x.pl[l].esperou; descartadas += x.pl[l].descartada;
    }
    falhas += x.erros;
  }
  const lojas = ORDEM_LOJAS.filter((l) => pedidas.has(l) || enviadas[l] > 0)
    .sort((a, b) => enviadas[b] - enviadas[a] || ORDEM_LOJAS.indexOf(a) - ORDEM_LOJAS.indexOf(b)).slice(0, 6);
  const total = ORDEM_LOJAS.reduce((a, l) => a + enviadas[l], 0);
  const linhas = ['🩺 *Saúde dos envios* (todas as regras)'];
  if (lojas.length) linhas.push(lojas.map((l) => `${LOJAS[l].nome}: ${plural(enviadas[l], 'enviada', 'enviadas')}`).join(' · '));
  if (total > 0 && !puladas && !descartadas && !falhas && !nRev) linhas.push('Nenhuma pulada, descartada nem falha. Nada esperando revisão.');
  else linhas.push(`Puladas: ${num(puladas)} · Descartadas: ${num(descartadas)} · Falhas: ${num(falhas)}`, `Esperando revisão: ${nRev ? num(nRev) : 'nenhuma'}`);
  if (emAberto) linhas.push(emAberto);
  return linhas.join('\n');
}

// ---------- o serviço (etapa 3; Decisão 3, 4 e 6 do plano) ----------

/** Chave de `settings` com o estado do vigia (o de lerEstado, mais `segurado`). */
export const CHAVE_ESTADO = 'vigia_estado';
/** Linha `aviso` do Histórico quando o vigia não consegue ler: uma por sequência de falhas (spec §3, CA3.11). */
export const TEXTO_SEM_LEITURA = 'O vigia não conseguiu verificar agora. Tentando de novo no próximo ciclo.';
const TEXTO_SEM_ENTREGA = 'Aviso do vigia não chegou a nenhum número: confira em Relatórios e avisos quem recebe “Erro de disparo”.';
const ORIGEM = Object.freeze({ id: null, name: 'Vigia' }); // coluna "Regra" do Histórico
/** Por que a mensagem esperou → o texto da linha "Aviso do vigia segurado (…)." (spec, "Linhas do Histórico"). */
const SEGURADO_POR = Object.freeze({ silencio: 'silêncio', whatsapp: 'WhatsApp fora' });
/** O `oQue` do entregar: vai para a linha do Histórico de cada destino ("Enviei o aviso do vigia para “Pedro”."). */
const O_QUE = Object.freeze({ problema: 'o aviso do vigia', volta: 'o aviso de volta do vigia' });
/** Execuções lidas por passada (são ~50 por dia; o resto fica para a passada seguinte, pelo cursor). */
const MAX_EXECUCOES_PASSADA = 500;
const MAX_FONTES = 5; // o MAX_SOURCES de src/db.js

const lerJson = (texto) => { try { return JSON.parse(texto); } catch { return null; } };

/**
 * Lojas pedidas por uma regra (linha de `rules`): as das fontes catálogo. Qualquer fonte que não é catálogo (fonte
 * antiga), catálogo com a lista vazia ou JSON ilegível → [] (= todas: Amazon e Mercado Livre, como em mapaDeRegras).
 * Nunca lança. A etapa 5 usa a mesma função para `execucoes.lojas_pedidas`.
 */
export function lojasDaRegra(row) {
  let fontes = lerJson(row?.sources ?? 'null');
  if (!Array.isArray(fontes) || !fontes.length) {
    const config = lerJson(row?.source_config || '{}');
    fontes = [{ type: row?.source_type || 'list', config: objeto(config) ? config : {} }];
  }
  const lojas = new Set();
  for (const f of fontes.slice(0, MAX_FONTES)) {
    if (f?.type !== 'catalogo') return [];
    const l = f.config?.lojas;
    if (!Array.isArray(l) || !l.length) return [];
    for (const x of l) if (typeof x === 'string') lojas.add(x);
  }
  return [...lojas];
}

/** `segurado` gravado → { motivo, desde } ou null. */
function seguradoDe(o, agora) {
  const s = objeto(o) && objeto(o.segurado) ? o.segurado : null;
  if (!s || typeof s.motivo !== 'string' || !Object.hasOwn(SEGURADO_POR, s.motivo)) return null;
  return { motivo: s.motivo, desde: instante(s.desde, agora) ?? agora };
}

/**
 * O vigia ligado ao programa. Uma passada (`tick` ou `aposExecucao`, a mesma coisa: o agendador chama no tick, logo
 * depois dos avisos, e depois de cada regra):
 * 1. lê o estado (`settings.vigia_estado`), as execuções novas (id acima do cursor), as regras ativas com as lojas,
 *    a revisão (catalogo_itens 'revisao', todas as lojas, D6) e, de `links.status()`, a extensão e a Central (nunca
 *    o `ultimoErro`); a falta da extensão conta de max(lastPollAt, `inicio`) (D5);
 * 2. avalia (avaliar, puro) e, se há aviso devido: no silêncio do ritmo ou com o WhatsApp fora, não manda nem marca
 *    nada (uma linha "segurado" por episódio, gravada no estado); senão marca as causas e manda no máximo uma
 *    mensagem de problema e uma de "voltou", reavaliadas na hora, dizendo por que esperaram (§1.8);
 * 3. grava o estado (só se mudou) e as linhas do Histórico (só `aviso` e `info`, nunca `erro`: CA3.7).
 * A marca vem ANTES da entrega (como o aviso de erro): uma entrega que falha não se repete, nem na mesma passada nem
 * na seguinte; vale o freio. Entrega sem nenhum destinatário vira uma linha `info`.
 *
 * Falha da leitura (banco, links, entrada inválida): `ok = false`, uma linha `aviso` por sequência de falhas, só o
 * código do erro no console; nunca lança e nunca rejeita (CA3.11).
 *
 * `tick(now)` devolve undefined quando não há nada a mandar (quase sempre) e uma promise, que nunca rejeita, quando há
 * entrega: o agendador faz `const r = vigia.tick(); if (r) await r` e não ganha voltas de microtask à toa.
 *
 * `estado()` (para o /api/state): { ok, causas: causasAbertas(), avaliadoEm }; na falha (ou se o próprio estado()
 * falhar), { ok: false, causas: [], avaliadoEm }. Nunca lança.
 *
 * Injeções: `links` (status(), modo()), `ritmo` (silencio()), `wa` (isReady(); o embrulhado), `entregar(texto, oQue)`
 * (→ quantos receberam; não deveria lançar, mas se lançar vale 0), `inicio` (quando o serviço ligou) e `agora` (relógio).
 */
export function createVigia({ db, links = null, ritmo = null, wa = null, entregar = null, inicio = Date.now(), agora = Date.now } = {}) {
  let ok = true;          // a última passada leu tudo
  let falhando = false;   // já escreveu a linha desta sequência de falhas
  let avaliadoEm = null;  // quando foi a última passada boa (só em memória: muda a cada tick)

  /** Linha do Histórico do vigia. Nível só `aviso` ou `info`; falha do banco vai ao console só pelo código. */
  function linha(level, message) {
    try { addLog(db, { rule: ORIGEM, level: level === 'aviso' ? 'aviso' : 'info', message }); } catch (e) {
      console.error('[vigia] não gravei uma linha no Histórico:', e?.code || e?.name || 'erro');
    }
  }

  const regrasAtivas = () => db.prepare('SELECT id, name, sources, source_type, source_config FROM rules WHERE enabled = 1 ORDER BY id').all()
    .map((r) => ({ id: r.id, nome: r.name, lojas: lojasDaRegra(r) }));

  /** Por que segurar agora: 'silencio' (o do ritmo, o mesmo de Ajustes), 'whatsapp' (fora) ou null. */
  function porQueSegurar(now) {
    if (ritmo?.silencio?.(now)?.agora === true) return 'silencio';
    if (wa?.isReady?.() !== true) return 'whatsapp';
    return null;
  }

  /** A parte síncrona da passada (lê, avalia, grava). Lança na falha. → { problema, volta } a entregar, ou null */
  function passada(now) {
    const bruto = getSetting(db, CHAVE_ESTADO);
    const cru = typeof bruto === 'string' ? lerJson(bruto) : null;
    const base = lerEstado(cru, now);
    let segurado = seguradoDe(cru, now);

    // cursor: tabela vazia → 0 (o que vier é novo); à frente do maior id (tabela esvaziada e refeita) → o maior id
    const maxId = db.prepare('SELECT MAX(id) AS id FROM execucoes').get()?.id ?? null;
    if (maxId === null) base.cursor = 0;
    else if (base.cursor !== null && base.cursor > maxId) base.cursor = maxId;
    const execucoes = base.cursor === null
      ? db.prepare('SELECT * FROM execucoes WHERE id = ?').all(maxId) // estado novo ou perdido: só marca, não avalia o passado
      : db.prepare('SELECT * FROM execucoes WHERE id > ? ORDER BY id LIMIT ?').all(base.cursor, MAX_EXECUCOES_PASSADA);

    const rev = db.prepare("SELECT COUNT(*) AS n, MIN(criado_em) AS desde FROM catalogo_itens WHERE status = 'revisao'").get();
    const st = links?.status?.() ?? null;
    const extensao = st ? { online: st.online === true, desde: Math.max(Number(st.lastPollAt) || 0, inicio) } : null;
    const central = objeto(st?.central) ? { estado: st.central.estado, emEsperaDesde: st.central.emEsperaDesde } : null;

    const r = avaliar({
      execucoes, estado: base, revisao: { n: Number(rev?.n), maisAntigaEm: rev?.desde ?? null }, extensao, central,
      regrasAtivas: regrasAtivas(), modoLink: links?.modo?.() ?? null, agora: now,
    });
    let e = r.estado;
    const { problemas, voltas } = r.devidos;
    const extras = [];
    let envio = null;
    if (problemas.length || voltas.length) {
      const motivo = porQueSegurar(now);
      if (motivo) {
        if (segurado?.motivo !== motivo) {
          extras.push({ level: 'info', message: `Aviso do vigia segurado (${SEGURADO_POR[motivo]}).` });
          segurado = { motivo, desde: now };
        }
      } else {
        envio = { problema: mensagemProblemas(problemas, { motivo: segurado?.motivo ?? null, agora: now }), volta: mensagemVoltas(voltas, now) };
        e = marcarVoltas(marcarAvisados(e, problemas, now), voltas, now);
        segurado = null;
      }
    } else segurado = null; // nada mais devido: o episódio acabou (a causa fechou sem aviso)

    const novo = JSON.stringify(segurado ? { ...e, segurado } : e);
    if (novo !== bruto) setSetting(db, CHAVE_ESTADO, novo);
    for (const l of [...r.linhas, ...extras]) linha(l.level, l.message);
    return envio;
  }

  /** Entrega o que a passada marcou: uma tentativa por mensagem; sem destinatário, uma linha `info`. Nunca rejeita. */
  async function entregarTudo(envio) {
    for (const [texto, oQue] of [[envio.problema, O_QUE.problema], [envio.volta, O_QUE.volta]]) {
      if (!texto) continue;
      let n = 0;
      try { n = Number(await entregar?.(texto, oQue)) || 0; } catch { n = 0; } // o entregar já escreveu o motivo, sem número
      if (n <= 0) linha('info', TEXTO_SEM_ENTREGA);
    }
  }

  function tick(now = agora()) {
    let envio;
    const t = Number.isFinite(now) ? now : agora();
    try {
      envio = passada(t);
    } catch (e) {
      ok = false;
      console.error('[vigia] sem leitura agora:', e?.code || e?.name || 'erro'); // nunca a mensagem: a do banco traz valores
      if (!falhando) { falhando = true; linha('aviso', TEXTO_SEM_LEITURA); }
      return undefined;
    }
    ok = true; falhando = false; avaliadoEm = t;
    return envio ? entregarTudo(envio) : undefined;
  }

  function estado() {
    if (!ok) return { ok: false, causas: [], avaliadoEm };
    try {
      return { ok: true, causas: causasAbertas(getSetting(db, CHAVE_ESTADO), { regrasAtivas: regrasAtivas(), agora: agora() }), avaliadoEm };
    } catch (e) {
      console.error('[vigia] estado sem leitura:', e?.code || e?.name || 'erro');
      return { ok: false, causas: [], avaliadoEm };
    }
  }

  return { tick, aposExecucao: tick, estado };
}
