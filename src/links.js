// Conversa com a extensão do Chrome, que roda no seu navegador já logado no Mercado Livre
// (e no portal de afiliados da Shopee). Quatro tipos de pedido: gerar o link de afiliado do ML
// (meli.la), gerar o link de afiliado da Shopee (s.shopee.com.br, pelo Link personalizado do
// portal), buscar a lista de ofertas da Central de Afiliados e ler preço e estoque de um produto
// do ML para o verificador (`produto_ml`). Nenhum cookie sai do navegador: só o link pronto, a
// lista ou os dados estruturados do produto voltam.

import { amostraHub, validarPaginas } from './afiliados.js';
import { addLog, getSetting, setSetting } from './db.js';
import { lerProdutoDaExtensao, urlProdutoML } from './ml.js';
import { LINK_SHOPEE, RE_SUB_ID } from './shopee.js';

// No modo extensão só aceitamos o link curto do Mercado Livre: quem tiver o token não consegue
// fazer o programa publicar uma URL qualquer nos grupos.
export const LINK_MELI = /^https:\/\/meli\.la\/[A-Za-z0-9_-]{3,40}$/;

// O link da Shopee só é aceito no formato curto oficial (LINK_SHOPEE de src/shopee.js), em qualquer
// modo: a Shopee nunca sai sem afiliado.
// O pedido só leva à extensão o endereço do produto já normalizado pelo servidor:
// shopee.com.br, caminho em ASCII visível, sem `?` nem `#` (sem parâmetros).
const URL_PRODUTO_SHOPEE = /^https:\/\/shopee\.com\.br\/[!"$->@-~]*$/;
const MAX_URL = 2048;
// Sub_id1 da Shopee (plano dashboard-ganhos, D3): RE_SUB_ID de src/shopee.js; extension/background.js confere de novo.
const semSubId = (v) => v === undefined || v === null || v === '';

/**
 * O `longo` (longLink) só serve para conferir o ID de afiliado. Vale só se for https, num host
 * da Shopee (shopee.com.br ou subdomínio), sem porta nem credenciais e com até 2048 caracteres;
 * qualquer outra coisa é descartada (null), sem recusar o link curto.
 */
function longoDaShopee(v) {
  if (typeof v !== 'string' || !v || v.length > MAX_URL) return null;
  let u;
  try { u = new URL(v.trim()); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const daShopee = host === 'shopee.com.br' || host.endsWith('.shopee.com.br');
  if (u.protocol !== 'https:' || !daShopee || u.port || u.username || u.password) return null;
  return u.href;
}

const ONLINE_MS = 45000;
// Pedido entregue à extensão e ainda sem resposta: ela está trabalhando nele (a 1.6.0 desiste em até 40 s e a 1.5.0
// em até 80 s; a lista, em 55 s; extension/background.js). Enquanto isso, e por até ENTREGUE_MS desde a entrega, ela
// conta como on-line.
const ENTREGUE_MS = 90000;
/** O servidor desiste do link do ML em 45 s (a extensão 1.6.0, em 40 s; plano rodar-sozinho-entrega2, Decisão 3). */
export const PRAZO_LINK_MS = 45000;
// Teto de pedidos de link da Shopee à extensão (S2): o portal de afiliados não é feito para geração em massa.
const JANELA_SHOPEE_MS = 3600 * 1000;
const LIMITE_SHOPEE_HORA = 60;
export const LIMITE_SHOPEE_ATINGIDO = 'Limite de links da Shopee por hora atingido; tente mais tarde.';
const MAX_ERRO = 300; // o erro vem da extensão (texto livre): vai para o log, para a tela e para /api/state
const erroCurto = (t) => String(t).slice(0, MAX_ERRO);

// Leitura de produto do ML pela extensão (plano verificador-ml-extensao, D2 a D7; ADR-011).
/** O servidor desiste do pedido de produto em 18 s (a extensão, em 15 s; o verificador, em 20 s). */
export const PRAZO_PRODUTO_MS = 18000;
/** Teto de pedidos `produto_ml` entregues à fila por hora (D7): a sessão do dono no ML é a mesma dos meli.la. */
export const LIMITE_PRODUTO_HORA = 120;
/** Depois que o ML pede verificação no navegador, nenhum pedido de produto vai à extensão por 30 min (D7). */
export const PAUSA_VERIFICACAO_MIN = 30;
/**
 * Verificações seguidas (sem uma leitura bem-sucedida entre elas) alongam a pausa: 30 min, depois 2 h, depois 6 h (o
 * teto, que se repete). Uma leitura bem-sucedida volta aos 30 min (achado S2).
 */
export const PAUSAS_VERIFICACAO_MIN = Object.freeze([PAUSA_VERIFICACAO_MIN, 2 * 60, 6 * 60]);
const PAUSA_MAX_MS = PAUSAS_VERIFICACAO_MIN.at(-1) * 60 * 1000;
const JANELA_PRODUTO_MS = 3600 * 1000;
// A pausa e a janela do teto ficam em `settings` (com `db`): o `node --watch-path=src` reinicia o serviço a cada
// mudança em src/, e a proteção da sessão do dono não pode zerar junto.
const CHAVE_PAUSA = 'ml_produto_pausa';      // { ate, nivel }
const CHAVE_PEDIDOS = 'ml_produto_pedidos';  // [instantes dos pedidos entregues na última hora]
// Recursos que a extensão anuncia no poll (cabeçalho x-recursos). Só liga uma capacidade; quem autentica é o x-token.
const RECURSOS_CONHECIDOS = new Set(['produto_ml']);
const MAX_RECURSOS = 200;

/** Conjunto de recursos anunciados: só nomes conhecidos; cabeçalho ausente, de outro tipo ou com mais de 200 caracteres → vazio. */
function lerRecursos(v) {
  if (typeof v !== 'string' || v.length > MAX_RECURSOS) return new Set();
  return new Set(v.split(',').map((x) => x.trim()).filter((x) => RECURSOS_CONHECIDOS.has(x)));
}

// ---------- Central de Afiliados: espera e teste (plano rodar-sozinho-entrega2, Decisão 1 e 2; ADR-015)
// 3 falhas seguidas abrem a espera: link e lista são recusados na hora, sem pedido à extensão, e o primeiro pedido
// depois de TESTE_ESPERA_MIN é o teste. Só link gerado, lista lida ou recusa do ML (a Central respondeu) fecham a espera.
export const FALHAS_PARA_ESPERA = 3;
export const TESTE_ESPERA_MIN = 5;
const TESTE_ESPERA_MS = TESTE_ESPERA_MIN * 60 * 1000;
/** Versão da extensão que o painel espera; abaixo dela (ou sem versão no poll) a extensão aparece desatualizada. */
export const VERSAO_EXTENSAO = '1.6.0';
/**
 * Recusas definitivas do ML ao gerar o link: só estas descartam a oferta. Vista no banco do dono: "The article must be
 * active, status: paused". Recusa que não casa com a lista conta como falha da oferta (D6).
 */
export const RECUSAS_DEFINITIVAS = Object.freeze([
  Object.freeze({ re: /must be active|status:\s*(paused|closed|inactive)/i, causa: 'anuncio_inativo' }),
]);
/** Tipos de erro que a extensão 1.6.0 manda no resultado; qualquer outro valor é ignorado (vale o texto). */
export const TIPOS_ERRO_EXTENSAO = Object.freeze(['recusa', 'sessao', 'sem_resposta', 'aba', 'http', 'formato']);
const TIPOS_ERRO = new Set(TIPOS_ERRO_EXTENSAO);
/**
 * Frase de cada causa que o serviço de links dá à falha da Central (no molde de CAUSAS em src/verificador.js:
 * minúscula, sem ponto). `extensao_off` (extensão desconectada) é a de CAUSAS.
 */
export const CAUSAS_CENTRAL = Object.freeze({
  central_sem_resposta: 'a Central de Afiliados não respondeu',
  central_aba: 'não deu para abrir a Central de Afiliados no Chrome',
  central_login: 'a Central de Afiliados pediu login',
  anuncio_inativo: 'o anúncio está pausado ou inativo',
  recusa_ml: 'o Mercado Livre recusou gerar o link',
});
const CAUSA_DO_TIPO = Object.freeze({
  sessao: 'central_login', aba: 'central_aba', recusa: 'recusa_ml', sem_resposta: 'central_sem_resposta', http: 'central_sem_resposta', formato: 'central_sem_resposta',
});
/** O erro real da extensão (texto livre) vai para o painel com no máximo 160 caracteres. */
export const MAX_DETALHE = 160;
const CHAVE_CENTRAL = 'ml_central';
const MSG_DESCONECTADA = 'a extensão do Chrome não está conectada (abra o Chrome com a extensão instalada)';
const MSG_EM_ESPERA = `o Mercado Livre está em espera: a Central de Afiliados não está respondendo (novo teste a cada ${TESTE_ESPERA_MIN} min)`;
const MSG_TEMPO = 'a extensão não respondeu a tempo';

/**
 * Falha de um pedido de link ou de lista do ML. `classe`: 'passageira' (tenta de novo depois), 'recusa' (o ML recusou
 * o anúncio; não adianta repetir), 'espera' (a Central está em espera; nenhum pedido saiu) ou 'desconectada' (a
 * extensão está fora). `causa`: chave de CAUSAS_CENTRAL (ou 'extensao_off'). `detalhe`: o erro real, limpo e cortado
 * (vazio quando nenhum pedido saiu). A mensagem é a de antes (o texto da extensão, até 300 caracteres).
 */
export class ErroLinkML extends Error {
  constructor(mensagem, { classe, causa, detalhe = '', tempo = false }) {
    super(mensagem);
    this.name = 'ErroLinkML';
    this.classe = classe; this.causa = causa; this.detalhe = detalhe;
    if (tempo) this.tempo = true;
  }
}

/** Texto livre de fora → uma linha sem caracteres de controle nem de formatação, com até MAX_DETALHE (reticências no corte). */
function limparDetalhe(v) {
  let s = String(v ?? '').slice(0, 4 * MAX_DETALHE).replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (s.length > MAX_DETALHE) {
    s = s.slice(0, MAX_DETALHE - 1);
    if (/[\uD800-\uDBFF]$/.test(s)) s = s.slice(0, -1); // não parte um par substituto
    s += '…';
  }
  return s;
}

/**
 * Classe e causa da falha de um pedido à Central. Recusa definitiva só pela lista RECUSAS_DEFINITIVAS (nunca na lista de
 * ofertas: `recusaPossivel: false`). Depois vale o `tipo` da extensão 1.6.0 (só da lista fechada) e, sem ele, o texto
 * da extensão antiga. → { classe: 'recusa'|'passageira', causa }.
 */
export function classificarFalhaLink(texto, tipo, { recusaPossivel = true } = {}) {
  const t = String(texto ?? '').slice(0, 1000);
  if (recusaPossivel) for (const r of RECUSAS_DEFINITIVAS) if (r.re.test(t)) return { classe: 'recusa', causa: r.causa };
  const tipoValido = typeof tipo === 'string' && TIPOS_ERRO.has(tipo) ? tipo : null;
  let causa;
  if (tipoValido) causa = CAUSA_DO_TIPO[tipoValido];
  else if (/não há sessão|entre na sua conta|pediu login/i.test(t)) causa = 'central_login';
  else if (/não consegui abrir a Central/i.test(t)) causa = 'central_aba';
  // a extensão antiga devolve a resposta da Central seguida de (etiqueta "…") quando ela não gerou o link
  else if (/\(etiqueta ".*"\)\s*$/.test(t) && !/^resposta sem link/i.test(t)) causa = 'recusa_ml';
  else causa = 'central_sem_resposta';
  if (causa === 'recusa_ml' && !recusaPossivel) causa = 'central_sem_resposta';
  return { classe: 'passageira', causa };
}

/** Versão anunciada no poll (cabeçalho x-versao): só "N.N.N" com até 3 dígitos por parte; qualquer outra coisa → null. */
export function lerVersao(v) {
  return typeof v === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v) ? v : null;
}

/** a < b, comparando "N.N.N" parte por parte. */
function versaoMenor(a, b) {
  const x = a.split('.').map(Number); const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}

/** Linha do Histórico ao abrir a espera (nível aviso). Nunca leva o erro real, só a frase fixa da causa. */
export function textoEsperaAberta(causa) {
  const c = Object.hasOwn(CAUSAS_CENTRAL, causa ?? '') ? causa : 'central_sem_resposta';
  // sem resposta, a frase diz só isso (achado D6: "a Central falhou … (a Central não respondeu)" repetia o sujeito)
  const oQue = c === 'central_sem_resposta' ? `a Central de Afiliados não respondeu ${FALHAS_PARA_ESPERA} vezes seguidas`
    : `a Central de Afiliados falhou ${FALHAS_PARA_ESPERA} vezes seguidas (${CAUSAS_CENTRAL[c]})`;
  return `Mercado Livre em espera: ${oQue}. As ofertas do Mercado Livre esperam e o programa testa de novo em ${TESTE_ESPERA_MIN} min.`;
}

/** "1 h 20 min", "25 min", "2 h", "menos de 1 min". */
function duracao(ms) {
  const min = Math.round(Math.max(0, ms) / 60000);
  if (min < 1) return 'menos de 1 min';
  const h = Math.floor(min / 60); const m = min % 60;
  return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
}

/** Linha do Histórico ao fechar a espera (nível info), com quanto tempo ela durou. */
export function textoEsperaFechada(ms) {
  return `Mercado Livre voltou: a Central de Afiliados respondeu ao teste (esteve em espera por ${duracao(ms)}). `
    + 'As ofertas do Mercado Livre saem no próximo envio.';
}

/**
 * getMode(): 'extension' | 'direct' | 'fake'. limiteShopeeHora: pedidos `link_shopee` que vão à extensão por
 * hora (padrão 60). agora: relógio da janela desse teto, da janela de LIMITE_PRODUTO_HORA e da pausa de
 * PAUSAS_VERIFICACAO_MIN (injetado nos testes). db (opcional): guarda a pausa e a janela do teto de produtos em
 * `settings`, para valerem depois de um reinício; sem ele, só em memória.
 * status(): lastOkAt/lastError são do link do ML; shopeeLastOkAt/shopeeLastError, do link da Shopee (R4). O pedido
 * de produto (`produto_ml`) não mexe em nenhum deles. `central` é o estado da Central de Afiliados (estadoCentral),
 * gravado em `settings.ml_central` com `db`; `versao`/`desatualizada` vêm do último poll (x-versao).
 */
export function createLinkService({ getMode, limiteShopeeHora = LIMITE_SHOPEE_HORA, agora = Date.now, db = null }) {
  const jobs = new Map();   // id -> { resolve, reject, timer, type, subId, url, entregueEm }
  const queue = [];         // pedidos esperando a extensão buscar
  const waiters = [];       // extensão esperando pedido (long-poll): { res, t, recursos }
  let seq = 0; let lastPollAt = 0; let lastOkAt = 0; let lastError = ''; let lastOffersAt = 0;
  let shopeeLastOkAt = 0; let shopeeLastError = '';
  const tetoShopee = Number.isInteger(limiteShopeeHora) && limiteShopeeHora > 0 ? limiteShopeeHora : LIMITE_SHOPEE_HORA;
  const pedidosShopee = []; // instantes dos pedidos link_shopee entregues à fila na última hora
  let recursos = new Set(); // o que a extensão anunciou no último poll (x-recursos)
  let versao = null;        // versão anunciada no último poll (x-versao), ou null
  // pausa: até quando (agora()) nenhum produto_ml vai à extensão, e o degrau da próxima (índice de PAUSAS_VERIFICACAO_MIN)
  const pausa = lerPausa(db, agora());
  const pedidosProduto = lerPedidosProduto(db, agora()); // instantes dos pedidos produto_ml entregues na última hora
  const central = lerCentral(db, agora()); // estado da Central de Afiliados (formato em lerCentral)

  const online = () => {
    const t = Date.now();
    if (t - lastPollAt < ONLINE_MS) return true;
    for (const e of jobs.values()) if (e.entregueEm && t - e.entregueEm < ENTREGUE_MS) return true;
    return false;
  };
  /** Marca o pedido como entregue à extensão (conta para online()). */
  const entregar = (job) => {
    const e = jobs.get(job.id); if (e) e.entregueEm = Date.now();
    return job;
  };

  /**
   * Estado da Central para o painel: 'em_espera' (espera aberta), 'falhando' (1 ou 2 falhas seguidas), 'respondendo'
   * (sem falha pendente depois de algum resultado) ou 'sem_teste' (nada ainda), mais as horas e o último erro.
   */
  const estadoCentral = () => ({
    estado: central.emEsperaDesde !== null ? 'em_espera' : central.falhasSeguidas > 0 ? 'falhando'
      : central.ultimoOkEm || central.ultimoErroEm ? 'respondendo' : 'sem_teste',
    falhasSeguidas: central.falhasSeguidas, ultimoOkEm: central.ultimoOkEm, ultimoErroEm: central.ultimoErroEm,
    ultimoErro: central.ultimoErro, emEsperaDesde: central.emEsperaDesde, proximoTesteEm: central.proximoTesteEm,
  });
  /** estadoCentral() + testeLiberado (o próximo pedido seria o teste). Só consulta: não gasta o teste. */
  const centralInfo = () => ({ ...estadoCentral(), testeLiberado: central.emEsperaDesde !== null && agora() >= central.proximoTesteEm });

  const status = () => {
    const ligada = online();
    return {
      online: ligada, lastPollAt, lastOkAt, lastOffersAt, lastError, shopeeLastOkAt, shopeeLastError, pending: queue.length,
      versao, versaoEsperada: VERSAO_EXTENSAO, desatualizada: ligada && (versao === null || versaoMenor(versao, VERSAO_EXTENSAO)),
      central: estadoCentral(),
    };
  };

  const gravarCentral = () => gravar(db, CHAVE_CENTRAL, central);
  /** Linha do Histórico sem regra; uma falha do banco não derruba o pedido (só vai ao console, sem o texto). */
  function linhaCentral(level, message) {
    if (!db) return;
    try { addLog(db, { level, message }); } catch (e) { console.error('[links] não gravei a linha da Central no Histórico:', e?.name || 'erro'); }
  }

  /**
   * Um pedido à Central falhou (link ou lista que não veio, produto_ml entregue que expirou sem resposta). A 3ª seguida
   * abre a espera (linha aviso); com ela aberta, cada falha empurra o próximo teste (sem linha).
   */
  function falhaDaCentral(detalhe, causa) {
    const t = agora();
    central.falhasSeguidas += 1; central.ultimoErroEm = t; central.ultimoErro = limparDetalhe(detalhe);
    if (central.emEsperaDesde !== null) central.proximoTesteEm = t + TESTE_ESPERA_MS;
    else if (central.falhasSeguidas >= FALHAS_PARA_ESPERA) {
      central.emEsperaDesde = t; central.proximoTesteEm = t + TESTE_ESPERA_MS;
      linhaCentral('aviso', textoEsperaAberta(causa));
    }
    gravarCentral();
  }

  /** A Central respondeu: link gerado ou lista lida (`ok`), ou recusa do ML. Zera a contagem e fecha a espera (linha info). */
  function respostaDaCentral({ ok }) {
    const t = agora();
    const desde = central.emEsperaDesde;
    central.falhasSeguidas = 0; central.emEsperaDesde = null; central.proximoTesteEm = null;
    if (ok) central.ultimoOkEm = t;
    if (desde !== null) linhaCentral('info', textoEsperaFechada(t - desde));
    gravarCentral();
  }

  /**
   * Antes de um pedido de link ou lista ir à fila: a extensão fora → 'desconectada' (não gasta o teste); a espera
   * aberta → 'espera', sem pedido; teste liberado → este pedido é o teste e o próximo fica para daqui a 5 min. Tudo
   * síncrono: dois pedidos ao mesmo tempo nunca são dois testes.
   */
  function portaDaCentral() {
    if (!online()) throw new ErroLinkML(MSG_DESCONECTADA, { classe: 'desconectada', causa: 'extensao_off' });
    if (central.emEsperaDesde === null) return;
    const t = agora();
    if (t < central.proximoTesteEm) throw new ErroLinkML(MSG_EM_ESPERA, { classe: 'espera', causa: 'central_sem_resposta' });
    central.proximoTesteEm = t + TESTE_ESPERA_MS;
    gravarCentral();
  }

  /**
   * Quantos pedidos link_shopee ainda cabem na janela de 1 h (0 = o próximo é recusado com LIMITE_SHOPEE_ATINGIDO).
   * src/lojas.js consulta antes de pedir um Sub_id (`reservaVagas`, que o envio passa), para deixar vagas ao link base.
   * Na simulação o teto não vale, e as vagas não mudam.
   */
  function vagasShopee() {
    const limite = agora() - JANELA_SHOPEE_MS;
    while (pedidosShopee.length && pedidosShopee[0] <= limite) pedidosShopee.shift();
    return Math.max(0, tetoShopee - pedidosShopee.length);
  }

  /**
   * Tira da fila o primeiro pedido que esta extensão sabe atender: `produto_ml` só vai a quem anunciou o recurso
   * no próprio poll (a extensão 1.4.2 trataria o pedido como link sem etiqueta). Nada para ela → null.
   */
  function proximoPara(rec) {
    const i = queue.findIndex((j) => j.type !== 'produto_ml' || rec.has('produto_ml'));
    return i >= 0 ? queue.splice(i, 1)[0] : null;
  }

  function flush() {
    for (let k = 0; k < waiters.length && queue.length;) {
      const w = waiters[k];
      const job = proximoPara(w.recursos);
      if (!job) { k++; continue; }
      waiters.splice(k, 1); clearTimeout(w.t); w.res(entregar(job));
    }
  }

  /**
   * Entrega um pedido para a extensão e espera a resposta. Prioridade (D2): o `produto_ml` entra no fim da fila; os
   * outros tipos (links e lista) entram antes do primeiro `produto_ml` que ainda espera. O estouro do prazo tira o
   * pedido da fila e rejeita com `tempo: true`. Link e lista do ML rejeitam com ErroLinkML; o estouro de um pedido que
   * chegou à extensão (link, lista ou produto_ml) conta como falha da Central (o que ficou só na fila não conta).
   */
  function ask(job, timeoutMs) {
    if (!online()) return Promise.reject(new Error(MSG_DESCONECTADA));
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        const entregue = Boolean(jobs.get(id)?.entregueEm);
        jobs.delete(id);
        const i = queue.findIndex((j) => j.id === id); if (i >= 0) queue.splice(i, 1);
        const daCentral = job.type === 'link' || job.type === 'ofertas';
        if (entregue && (daCentral || job.type === 'produto_ml')) falhaDaCentral(MSG_TEMPO, 'central_sem_resposta');
        reject(daCentral
          ? new ErroLinkML(MSG_TEMPO, { classe: 'passageira', causa: 'central_sem_resposta', detalhe: MSG_TEMPO, tempo: true })
          : Object.assign(new Error(MSG_TEMPO), { tempo: true }));
      }, timeoutMs);
      jobs.set(id, { resolve, reject, timer, type: job.type, subId: job.subId, url: job.url });
      const pedido = { id, ...job };
      const antes = job.type === 'produto_ml' ? -1 : queue.findIndex((j) => j.type === 'produto_ml');
      if (antes >= 0) queue.splice(antes, 0, pedido); else queue.push(pedido);
      flush();
    });
  }

  /**
   * modo: 'extension' (padrão) | 'direct' (usa a URL como está, SEM comissão) | 'fake' (simulação/testes). No modo
   * extension rejeita com ErroLinkML (classe e causa da falha); a espera da Central nunca troca o link de afiliado pela
   * URL comum: é sempre erro (CA2.9).
   */
  async function requestLink({ url, tag, timeoutMs = PRAZO_LINK_MS }) {
    const mode = getMode();
    if (mode === 'direct') return url;
    if (mode === 'fake') return `https://meli.la/fake-${encodeURIComponent(tag)}-${++seq}`;
    portaDaCentral();
    const { link } = await ask({ type: 'link', url, tag }, timeoutMs);
    return link;
  }

  /**
   * Link de afiliado da Shopee para o endereço do produto (`https://shopee.com.br/…`, sem parâmetros).
   * Devolve `{ link, longo, subIdAplicado }`: `link` sempre passa em LINK_SHOPEE; `longo` é o longLink (ou null).
   * `subId` (opcional, RE_SUB_ID; vazio = sem Sub_id) vai no pedido; `subIdAplicado` só é true quando a extensão
   * responde `sub_id_aplicado: true` (a extensão antiga não responde o campo: o link sai sem Sub_id).
   * O modo 'direct' do ML não vale aqui: fora da simulação, o link sai sempre pela extensão.
   * Teto: `limiteShopeeHora` pedidos entregues à extensão por hora (o que a extensão off-line recusou não conta);
   * passou → LIMITE_SHOPEE_ATINGIDO, sem pedido. A simulação (fake) não conta e simula a extensão que aplica o Sub_id.
   */
  async function requestLinkShopee({ url, subId, timeoutMs = 90000 }) {
    if (typeof url !== 'string' || url.length > MAX_URL || !URL_PRODUTO_SHOPEE.test(url)) {
      throw new Error('endereço de produto da Shopee inválido');
    }
    const comSubId = !semSubId(subId);
    if (comSubId && !(typeof subId === 'string' && RE_SUB_ID.test(subId))) throw new Error('Sub_id da Shopee inválido');
    if (getMode() === 'fake') return { link: `https://s.shopee.com.br/fake${++seq}`, longo: null, subIdAplicado: comSubId };
    if (vagasShopee() === 0) throw new Error(LIMITE_SHOPEE_ATINGIDO);
    if (online()) pedidosShopee.push(agora()); // off-line, ask recusa sem pôr na fila
    // sem Sub_id, o pedido é o de antes (sem o campo)
    return ask(comSubId ? { type: 'link_shopee', url, subId } : { type: 'link_shopee', url }, timeoutMs);
  }

  /**
   * Por que um produto_ml não iria à extensão agora, sem pedido: 'verificacao' (pausa depois da verificação),
   * 'desconectada', 'antiga' (nenhum poll anunciou o recurso) ou 'limite' (LIMITE_PRODUTO_HORA na última hora); null =
   * iria. A mesma ordem de requestProduto (o verificador consulta antes de escolher a oferta).
   */
  function produtoDisponivel() {
    if (agora() < pausa.ate) return 'verificacao';
    if (!online()) return 'desconectada';
    // a extensão nova pode estar esperando enquanto outra (antiga) fez o último poll (achado Q1)
    if (!recursos.has('produto_ml') && !waiters.some((w) => w.recursos.has('produto_ml'))) return 'antiga';
    if (produtosNaHora() >= LIMITE_PRODUTO_HORA) return 'limite';
    return null;
  }

  /** Pedidos produto_ml entregues à fila na última hora (a janela anda com agora()). */
  function produtosNaHora() {
    const limite = agora() - JANELA_PRODUTO_MS;
    while (pedidosProduto.length && pedidosProduto[0] <= limite) pedidosProduto.shift();
    return pedidosProduto.length;
  }

  /**
   * Preço e estoque de agora de um produto do ML, lidos pela extensão com a sessão do navegador (verificador, D4).
   * Aceita `{ url, timeoutMs }` ou só a URL; a URL passa por ml.urlProdutoML (só anúncio ou catálogo; o pedido leva a
   * forma dela). NUNCA rejeita: devolve `{ price, disponivel }` (como ml.lerProdutoDaExtensao: `price` número > 0 ou
   * null; `disponivel` true, false ou null; `varias: true` no resumo de um catálogo de várias versões) ou `{ falha }`:
   *   'verificacao'  o ML pediu verificação (agora ou dentro da pausa: PAUSAS_VERIFICACAO_MIN), sem pedido à extensão;
   *   'desconectada' a extensão está off-line, sem pedido;
   *   'antiga'       nem o último poll nem um poll em espera anunciou `produto_ml` (extensão sem o recurso), sem pedido;
   *   'limite'       LIMITE_PRODUTO_HORA pedidos na última hora, sem pedido;
   *   'tempo'        sem resposta em `timeoutMs` (padrão PRAZO_PRODUTO_MS); o pedido sai da fila;
   *   'erro'         endereço que não é de produto do ML (sem pedido), `ok:false` da extensão ou resposta fora do contrato.
   * Pausa, off-line e antiga não contam no teto. Não olha o modo: quem decide usar a extensão é o verificador.
   */
  async function requestProduto(arg) {
    const { url, timeoutMs } = typeof arg === 'string' ? { url: arg } : (arg ?? {});
    const prazo = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : PRAZO_PRODUTO_MS;
    const alvo = urlProdutoML(url);
    if (!alvo) return { falha: 'erro' };
    const barrado = produtoDisponivel();
    if (barrado) return { falha: barrado };
    pedidosProduto.push(agora());
    gravar(db, CHAVE_PEDIDOS, pedidosProduto);
    try {
      return await ask({ type: 'produto_ml', url: alvo }, prazo);
    } catch (e) {
      return { falha: e?.tempo === true ? 'tempo' : 'erro' };
    }
  }

  /** Busca páginas da lista da Central de Afiliados. `paginas` = corpos prontos (ver afiliados.js). */
  async function requestOffers({ paginas, timeoutMs = 60000 }) {
    if (getMode() === 'fake') return amostraHub();
    portaDaCentral(); // a lista passa pela mesma espera do link
    const { data } = await ask({ type: 'ofertas', paginas }, timeoutMs);
    return data;
  }

  /**
   * Long-poll da extensão. `recursos`: o cabeçalho x-recursos (ver lerRecursos); `versao`: o x-versao (ver lerVersao).
   * Os dois valem até o próximo poll.
   */
  function poll(waitMs = 20000, { recursos: anunciados, versao: anunciada } = {}) {
    lastPollAt = Date.now();
    recursos = lerRecursos(anunciados);
    versao = lerVersao(anunciada);
    const rec = recursos;
    const job = proximoPara(rec);
    if (job) return Promise.resolve(entregar(job));
    return new Promise((res) => {
      const w = { res, recursos: rec };
      w.t = setTimeout(() => {
        const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1);
        lastPollAt = Date.now(); res(null);
      }, waitMs);
      waiters.push(w);
    });
  }

  /** Resposta a um pedido link_shopee: resultado em shopeeLastOkAt/shopeeLastError (o estado do ML não muda). */
  function respostaShopee(e, { ok, link, longo, error, sub_id_aplicado: aplicado }) {
    const l = String(link || '').trim();
    if (ok && LINK_SHOPEE.test(l)) {
      shopeeLastOkAt = Date.now(); shopeeLastError = '';
      // só vale o true literal, e só se o pedido levou Sub_id
      e.resolve({ link: l, longo: longoDaShopee(longo), subIdAplicado: e.subId !== undefined && aplicado === true });
      return true;
    }
    shopeeLastError = erroCurto(!ok ? error || 'a extensão não conseguiu'
      : error || (l ? 'a extensão devolveu um link que não é s.shopee.com.br; recusado' : 'resposta sem link'));
    e.reject(new Error(shopeeLastError));
    return true;
  }

  /**
   * Resposta a um pedido produto_ml (D4): `data` passa por ml.lerProdutoDaExtensao com a URL do pedido (que escolhe a
   * variante). `{ bloqueado }` liga a pausa (ligarPausa) e tira da fila os produto_ml que ainda esperam (D7); uma
   * leitura válida volta a pausa ao primeiro degrau. Sempre resolve; lastOkAt/lastError ficam como estão (o selo de
   * Conexões é dos links). Nenhuma resposta mexe no estado da Central: a página do produto não passa por ela (a
   * leitura fecharia a espera em laço; o erro da página, como um 404 de anúncio que saiu do ar, abriria a espera sem a
   * Central ter falhado: achados R2/Q1). Só o estouro do prazo conta (em `ask`).
   */
  function respostaProduto(e, { ok, data, error }) {
    let r = null;
    try { r = ok ? lerProdutoDaExtensao(data, { url: e.url }) : null; } catch { r = null; }
    if (r?.bloqueado === true) {
      ligarPausa();
      e.resolve({ falha: 'verificacao' });
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].type !== 'produto_ml') continue;
        const [j] = queue.splice(i, 1); const outro = jobs.get(j.id);
        if (outro) { clearTimeout(outro.timer); jobs.delete(j.id); outro.resolve({ falha: 'verificacao' }); }
      }
    } else if (r) {
      if (pausa.nivel !== 0) { pausa.nivel = 0; gravar(db, CHAVE_PAUSA, pausa); }
      e.resolve({ price: r.price, disponivel: r.disponivel, ...(r.varias === true ? { varias: true } : {}) });
    } else {
      e.resolve({ falha: 'erro' }); // neutra para a Central (acima)
    }
    return true;
  }

  /**
   * O ML pediu verificação: pausa do degrau atual (30 min, 2 h, 6 h) e o próximo degrau fica para a verificação
   * seguinte. Durante uma pausa já ligada (resposta de um pedido que já estava na extensão), nada muda.
   */
  function ligarPausa() {
    const t = agora();
    if (t < pausa.ate) return;
    const i = Math.min(pausa.nivel, PAUSAS_VERIFICACAO_MIN.length - 1);
    pausa.ate = t + PAUSAS_VERIFICACAO_MIN[i] * 60 * 1000;
    pausa.nivel = Math.min(i + 1, PAUSAS_VERIFICACAO_MIN.length - 1);
    gravar(db, CHAVE_PAUSA, pausa);
  }

  /** Rejeita um pedido de link ou lista com a falha passageira `causa` (conta para a espera). */
  function falhaPassageira(e, mensagem, detalhe, causa) {
    falhaDaCentral(detalhe, causa);
    e.reject(new ErroLinkML(mensagem, { classe: 'passageira', causa, detalhe: limparDetalhe(detalhe) }));
    return true;
  }

  /**
   * `tipo` (extensão 1.6.0, só no ok:false): recusa|sessao|sem_resposta|aba|http|formato; outro valor é ignorado e
   * vale o texto do erro (classificarFalhaLink).
   */
  function submit(id, { ok, link, longo, data, error, sub_id_aplicado, tipo }) {
    lastPollAt = Date.now(); // a extensão acabou de falar com o painel
    const e = jobs.get(id); if (!e) return false;
    clearTimeout(e.timer); jobs.delete(id);
    if (e.type === 'produto_ml') return respostaProduto(e, { ok, data, error });
    if (e.type === 'link_shopee') return respostaShopee(e, { ok, link, longo, error, sub_id_aplicado });
    if (!ok) {
      lastError = erroCurto(error || 'a extensão não conseguiu');
      const real = error || lastError;
      const { classe, causa } = classificarFalhaLink(real, tipo, { recusaPossivel: e.type === 'link' });
      // recusa do ML, definitiva ou não (achado S2): a Central respondeu, então zera a contagem e fecha a espera. A que não
      // está em RECUSAS_DEFINITIVAS segue passageira para a OFERTA (D6: conta para ela no agendador), não para a Central
      if (classe !== 'recusa' && causa !== 'recusa_ml') return falhaPassageira(e, lastError, real, causa);
      respostaDaCentral({ ok: false }); // a Central respondeu: o anúncio é que não serve
      e.reject(new ErroLinkML(lastError, { classe, causa, detalhe: limparDetalhe(real) }));
      return true;
    }
    if (e.type === 'ofertas') {
      const v = validarPaginas(data);
      if (!v.ok) { lastError = v.erro; return falhaPassageira(e, lastError, lastError, 'central_sem_resposta'); }
      lastOffersAt = Date.now(); respostaDaCentral({ ok: true }); e.resolve({ data: v.paginas }); return true;
    }
    const l = String(link || '').trim();
    const valido = getMode() === 'extension' ? LINK_MELI.test(l) : /^https?:\/\//i.test(l);
    if (valido) { lastOkAt = Date.now(); lastError = ''; respostaDaCentral({ ok: true }); e.resolve({ link: l }); return true; }
    lastError = erroCurto(error || (l ? 'a extensão devolveu um link que não é meli.la; recusado' : 'resposta sem link'));
    return falhaPassageira(e, lastError, lastError, 'central_sem_resposta');
  }

  // modo(): o modo em que requestLink vai gerar o link agora (quem precisa saber se a extensão é necessária pergunta aqui)
  return {
    requestLink, requestLinkShopee, requestOffers, requestProduto, produtoDisponivel, poll, submit, status, central: centralInfo,
    vagasShopee, modo: () => getMode(),
  };
}

/** Grava `valor` (JSON) em `settings`; sem `db`, nada. Uma falha do banco não derruba o pedido (só vai ao console, sem o valor). */
function gravar(db, chave, valor) {
  if (!db) return;
  try { setSetting(db, chave, JSON.stringify(valor)); } catch (e) { console.error('[links] não gravei a proteção da sessão do ML:', e?.name || 'erro'); }
}

/** JSON de `settings`, ou null (sem `db`, ausente, inválido ou falha do banco). */
function lerJson(db, chave) {
  if (!db) return null;
  try { return JSON.parse(getSetting(db, chave) ?? 'null'); } catch { return null; }
}

/**
 * Pausa gravada → { ate, nivel }. `ate` fora do formato vira 0 e nunca passa de agora + 6 h (o teto; o valor cortado é
 * gravado, para um reinício não esticar a pausa de novo); `nivel` é um índice de PAUSAS_VERIFICACAO_MIN.
 */
function lerPausa(db, t) {
  const v = lerJson(db, CHAVE_PAUSA);
  const ate = Number.isFinite(v?.ate) && v.ate > 0 ? Math.min(v.ate, t + PAUSA_MAX_MS) : 0;
  const nivel = Number.isInteger(v?.nivel) && v.nivel >= 0 && v.nivel < PAUSAS_VERIFICACAO_MIN.length ? v.nivel : 0;
  if (ate !== 0 && ate !== v.ate) gravar(db, CHAVE_PAUSA, { ate, nivel });
  return { ate, nivel };
}

/**
 * Estado gravado da Central → { falhasSeguidas, ultimoOkEm, ultimoErroEm, ultimoErro, emEsperaDesde, proximoTesteEm }.
 * É dado de fora: contagem fora do formato vira 0, hora fora do formato vira 0 (ou null) e nada fica no futuro, salvo o
 * próximo teste, que nunca passa de agora + TESTE_ESPERA_MIN (o valor corrigido é gravado, para um reinício não esticar a
 * espera). Espera aberta sem horário de teste: o teste fica liberado; horário de teste sem espera é descartado.
 */
function lerCentral(db, t) {
  const v = lerJson(db, CHAVE_CENTRAL);
  const o = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  const hora = (x) => (Number.isFinite(x) && x > 0 ? Math.min(x, t) : 0);
  const emEsperaDesde = hora(o.emEsperaDesde) || null;
  const c = {
    falhasSeguidas: Number.isSafeInteger(o.falhasSeguidas) && o.falhasSeguidas >= 0 ? o.falhasSeguidas : 0,
    ultimoOkEm: hora(o.ultimoOkEm),
    ultimoErroEm: hora(o.ultimoErroEm),
    ultimoErro: typeof o.ultimoErro === 'string' ? limparDetalhe(o.ultimoErro) : '',
    emEsperaDesde,
    proximoTesteEm: emEsperaDesde === null ? null
      : Number.isFinite(o.proximoTesteEm) && o.proximoTesteEm > 0 ? Math.min(o.proximoTesteEm, t + TESTE_ESPERA_MS) : t,
  };
  if (v !== null && JSON.stringify(c) !== JSON.stringify(v)) gravar(db, CHAVE_CENTRAL, c);
  return c;
}

/** Pedidos produto_ml gravados → os instantes da última hora (até LIMITE_PRODUTO_HORA, em ordem; nada no futuro). */
function lerPedidosProduto(db, t) {
  const v = lerJson(db, CHAVE_PEDIDOS);
  if (!Array.isArray(v)) return [];
  return v.filter((x) => Number.isFinite(x) && x > t - JANELA_PRODUTO_MS && x <= t).sort((a, b) => a - b).slice(-LIMITE_PRODUTO_HORA);
}
