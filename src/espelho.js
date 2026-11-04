// Espelhamento de ofertas da Amazon (plano espelhamento-amazon, decisão 5; ADR-002).
//
// Uma regra (`espelhos`) liga grupos de origem a grupos de destino. O ouvinte do WhatsApp entrega cada mensagem
// nova de grupo a receber(); cada link da Amazon vira um item (`espelho_itens`) que o tick do agendador decide em
// processarPendentes(): esperar (janela, máximo por hora, cota), descartar (repetida, palavra bloqueada, link que
// não resolve), ir para a fila do dono (sem preço) ou sair pela fila única de envios (tabela `envios`, ADR-001), que
// tem a trava, a retomada, as pausas de Ajustes e o histórico por grupo. O espelho não manda nada sozinho.
//
// Contrato com src/envios.js: o espelho grava a linha de `envios` direto (tipo 'oferta', quando 'agora', pendente
// vencido) com o payload que `preparar('oferta')` espera para a Amazon: { url (limpa), loja:'amazon', asin,
// tag_id:null, etiqueta:null, template_id, template_criado_em, fonte_dados, enviar_foto, upload?,
// origem:{ tipo:'espelho', espelho_id, nome }, offer }. O link com a tag é montado em `preparar`, na hora do envio.
//
// Três guardas contra laço (CA9): (1) o whatsapp.js ignora as mensagens que o próprio programa enviou, pelo id;
// (2) link que já leva a nossa tag é ignorado aqui; (3) o grupo de origem do item nunca está entre os destinos.
// Mensagem do próprio número (`fromMe`) só entra com `incluir_minhas`.
//
// Privacidade (CA11): o ouvinte entrega só { jid do grupo, fromMe, texto, msgId, ts }. O texto é guardado com
// telefones, sequências de 8+ dígitos e e-mails mascarados (mascararPessoais), até 1000 caracteres, e nunca vai ao
// navegador (itens() não devolve `texto_origem` nem `url`). As URLs são extraídas ANTES de mascarar: a máscara
// apagaria um ASIN só de dígitos e o `qid=` dos links. O msgId só entra no índice único. O log leva o nome do grupo,
// nunca número.
//
// Limites conhecidos:
// - O whatsapp.js corta o texto em MAX_TEXTO_RECEBIDO (4096) caracteres: um link depois do corte se perde.
// - Os dados do texto (lerOfertaDoTexto) descrevem um produto só. Mensagem com mais de um produto da Amazon não usa
//   o texto para nenhum deles: só a API; sem ela, cada item vai para a fila (ou sai curto, conforme a regra).
// - O texto é lido depois de mascarado: preço com 8+ dígitos ("R$ 12.345.678") ou número de modelo longo no título
//   viram "…". Fora disso, preço brasileiro ("R$ 1.310,05") passa intacto.

import { addLog, getSetting } from './db.js';
import { identificar } from './lojas.js';
import { extrairAsin, ErroAmazon, LinkNaoResolvido } from './amazon.js';
import { extrairUrls, lerOfertaDoTexto, palavraBloqueada, normalizar } from './oferta-texto.js';
import { mascararPessoais } from './privacidade.js';
import { MAX_TEXTO_RECEBIDO } from './whatsapp.js';
import { renderTemplate, discountPct } from './template.js';

const HORA = 3600000;
const DIA = 24 * HORA;
const PARADO_MAX = 2 * HORA;          // item parado (serviço fora do ar) há mais que isso expira (CA12)
const MAX_TEXTO_ORIGEM = 1000;
const MAX_LINKS_HORA = 60;            // links aceitos por regra e grupo de origem por hora: membro hostil não multiplica GETs
const LOTE = 20;                      // itens por chamada de processarPendentes (o tick não fica preso aqui)
const TEMPO_LOTE = 20000;             // ms por passada de processarPendentes: o resto fica 'recebido' para o próximo tick
const COTA_ESPERA_MAX = 120;          // s: acima disso, segue sem a API
const COTA_TENTATIVAS = 3;
const FILA_MIN_HORAS = 24;
const MAX_NOME = 80;
const MAX_PALAVRAS = 50;
const MAX_PALAVRA = 60;
const MAX_GRUPOS = 500;
const MAX_TITULO = 200;
const MAX_CUPOM = 30;
const PRECO_MAX = 10_000_000;
const MAX_LIMITE_ITENS = 50;
const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const RE_ASIN = /^[A-Z0-9]{10}$/;
const UPLOAD_ID = /^[a-f0-9]{32}\.(jpg|png)$/;
const SONDA_ASIN = 'B000000000'; // montarLink com um ASIN de sonda diz qual é a tag salva, sem rede
const SEM_PRECO = ['fila', 'curto'];
const ATIVOS = ['recebido', 'processando', 'na_fila'];
const DESCARTES = ['duplicado', 'descartado', 'expirado', 'erro'];
const CAMPOS_OFERTA = ['title', 'price', 'oldPrice', 'discountPct', 'sold', 'freeShipping', 'coupon', 'image'];

// Item que conta como "enviado" para "Horas sem repetir" e "Máximo por hora" (Q2): status 'enviado' e o envio não
// terminou sem nenhum grupo recebido. Envio ainda na fila (pendente, enviando, pausado) conta, para dois itens do
// mesmo produto não saírem juntos; envio encerrado (concluído, erro, cancelado) só conta se ao menos um grupo
// recebeu (envio_resultados.ok). Envio já apagado pela retenção conta (não há como saber; é antigo).
// O mesmo critério vale para o contador "Espelhadas" de listar().
const ENVIO_ATIVO = ['pendente', 'enviando', 'pausado'];
const CONTA_COMO_ENVIADO = `status = 'enviado' AND NOT EXISTS (SELECT 1 FROM envios v WHERE v.id = espelho_itens.envio_id
  AND v.status NOT IN (${ENVIO_ATIVO.map((x) => `'${x}'`).join(', ')})
  AND NOT EXISTS (SELECT 1 FROM envio_resultados r WHERE r.envio_id = v.id AND r.ok = 1))`;
const NAO_ENVIADO = 'não foi enviado';
const MAX_MOTIVO_ENVIO = 200;

const SEM_TAG = 'Falta a tag de associado da Amazon. Sem ela o espelhamento não liga. Cadastre em Conexões.';
const SEM_AMAZON = 'A integração com a Amazon não está disponível neste servidor.';
const JA_TRATADA = 'Esta oferta já foi tratada.';

/** Erro com status HTTP (montarRotas responde com ele). A mensagem é fixa ou montada com nomes, nunca com dado de fora. */
export class ErroEspelho extends Error {
  constructor(status, mensagem) {
    super(mensagem);
    this.name = 'ErroEspelho';
    this.status = status;
  }
}

const pad = (n) => String(n).padStart(2, '0');
const lerJson = (txt, padrao) => { try { return JSON.parse(txt) ?? padrao; } catch { return padrao; } };
const listaDeTexto = (txt) => { const l = lerJson(txt, []); return Array.isArray(l) ? l.filter((x) => typeof x === 'string') : []; };
const urlDoAsin = (asin) => `https://www.amazon.com.br/dp/${asin}`;
/** Link com a tag mascarada, para a prévia do painel (CA7): a tag só vai inteira ao WhatsApp. */
const mascararTag = (link) => String(link).replace(/([?&]tag=)[^&#]*/, '$1•••');
const minutosDe = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

/** O horário de funcionamento pode virar a noite (20:00 até 02:00); início = fim é o dia todo. */
function dentroDaJanela(ts, inicio, fim) {
  if (!inicio || !fim) return true;
  const d = new Date(ts); const m = d.getHours() * 60 + d.getMinutes();
  const s = minutosDe(inicio); const e = minutosDe(fim);
  if (s === e) return true;
  return s < e ? m >= s && m < e : m >= s || m < e;
}

/** Próxima abertura da janela depois de `ts` (hora local do servidor). */
function aberturaDaJanela(ts, inicio) {
  const d = new Date(ts); const s = minutosDe(inicio);
  d.setHours(Math.floor(s / 60), s % 60, 0, 0);
  if (d.getTime() <= ts) d.setDate(d.getDate() + 1);
  return d.getTime();
}

const horaCurta = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

/** Linha de `espelhos` → regra com as listas já lidas (a lista de palavras é sempre um array: palavraBloqueada pede lista). */
function lerRegra(r) {
  if (!r) return null;
  return {
    ...r,
    enabled: !!r.enabled, incluir_minhas: !!r.incluir_minhas, enviar_foto: !!r.enviar_foto,
    origem_jids: listaDeTexto(r.origem_jids), destino_jids: listaDeTexto(r.destino_jids),
    palavras_bloqueadas: listaDeTexto(r.palavras_bloqueadas),
  };
}

/** Oferta só com os campos do template (o link nunca é guardado: sai de montarLink na hora do envio). */
const soCampos = (o) => Object.fromEntries(CAMPOS_OFERTA.map((k) => [k, o?.[k] ?? null]));

/**
 * Texto da mensagem para o banco: mascarado e com até MAX_TEXTO_ORIGEM caracteres. Se o whatsapp.js cortou o texto,
 * a última palavra (que pode ser um número ou e-mail pela metade, que a máscara não reconhece) sai antes da máscara.
 */
function textoParaGuardar(texto) {
  let t = String(texto ?? '');
  if (t.length >= MAX_TEXTO_RECEBIDO) t = t.slice(0, MAX_TEXTO_RECEBIDO).replace(/\S*$/, '');
  return mascararPessoais(t).slice(0, MAX_TEXTO_ORIGEM);
}

/** Erro dos validadores de ajustes quando quem chama é o espelho (a rota responde com o status dele). */
const erroDoEspelho = (mensagem) => new ErroEspelho(400, mensagem);

/**
 * Preço digitado no "Completar" (mesma regra do Disparo manual): número ou "1.299,90". Vazio → null. `erro(msg)`
 * cria o erro de quem chama (src/catalogo-itens.js reaproveita com o dele); a frase é a mesma.
 */
export function lerPrecoDigitado(v, rotulo, erro = erroDoEspelho) {
  if (v == null || v === '') return null;
  let n = NaN;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string') {
    const t = v.replace(/^\s*R\$\s*/i, '').trim();
    if (t === '') return null;
    if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(t)) n = Number(t.replace(/\./g, '').replace(',', '.'));
    else if (/^\d+(,\d{1,2})?$/.test(t)) n = Number(t.replace(',', '.'));
    else if (/^\d+\.\d{1,2}$/.test(t)) n = Number(t);
  }
  if (!Number.isFinite(n) || n <= 0 || n > PRECO_MAX) throw erro(`${rotulo} inválido: use só números, como 89,90.`);
  return Math.round(n * 100) / 100;
}

/** Texto curto digitado (título, cupom): espaços juntados; vazio → null; acima de `max` → erro com frase fixa. */
export function lerTextoCurto(v, nome, max, erro = erroDoEspelho) {
  if (v == null) return null;
  if (typeof v !== 'string') throw erro(`O ${nome} precisa ser texto.`);
  const t = v.replace(/\s+/g, ' ').trim();
  if (t.length > max) throw erro(`O ${nome} passa de ${max} caracteres.`);
  return t || null;
}

/**
 * Ajustes do "Completar" (os mesmos do Disparo manual e do "Revisar oferta" do catálogo). Só estas chaves; image e
 * link nunca vêm do navegador. `lerFoto(id)`: a da fila de envios (sem ela, foto enviada é recusada); `maxCupom`:
 * tamanho do cupom (o catálogo aceita mais); `erro(msg)`: o erro de quem chama.
 */
export async function validarAjustesOferta(a, { maxCupom = MAX_CUPOM, lerFoto = null, erro = erroDoEspelho } = {}) {
  if (a == null) return {};
  if (typeof a !== 'object' || Array.isArray(a)) throw erro('Dados da oferta inválidos.');
  const r = {};
  if (Object.hasOwn(a, 'title')) r.title = lerTextoCurto(a.title, 'título', MAX_TITULO, erro);
  if (Object.hasOwn(a, 'price')) r.price = lerPrecoDigitado(a.price, 'Preço atual', erro);
  if (Object.hasOwn(a, 'oldPrice')) r.oldPrice = lerPrecoDigitado(a.oldPrice, 'Preço antigo', erro);
  if (Object.hasOwn(a, 'coupon')) r.coupon = lerTextoCurto(a.coupon, 'cupom', maxCupom, erro);
  if (Object.hasOwn(a, 'freeShipping') && a.freeShipping != null) {
    if (typeof a.freeShipping !== 'boolean') throw erro('Frete grátis: marque ou desmarque.');
    r.freeShipping = a.freeShipping;
  }
  if (a.sem_foto != null && typeof a.sem_foto !== 'boolean') throw erro('Foto: envie com ou sem foto.');
  if (a.sem_foto === true) r.sem_foto = true;
  if (a.upload != null && a.upload !== '') {
    const up = typeof a.upload === 'string' ? a.upload : '';
    if (!UPLOAD_ID.test(up)) throw erro('Escolha a foto de novo.');
    if (!lerFoto || !(await lerFoto(up))) throw erro('A foto não foi encontrada. Envie de novo.');
    r.upload = up;
  }
  if (r.sem_foto && r.upload) throw erro('Escolha entre trocar a foto e enviar sem foto.');
  return r;
}

/**
 * Espelhamento. `amazon`: cliente de src/amazon.js (resolver, lerItem, montarLink, situacao); `envios`: a fila de
 * src/envios.js (lerFoto para o "Completar" e, sem `acordar`, processarPendentes); `acordar`: pede um tick do
 * agendador já (é por ele que o envio criado sai); `agora`: relógio (testes). As pausas entre mensagens são as da
 * fila de envios: o `fast` do agendador não muda nada aqui.
 */
export function createEspelho({ db, wa = null, amazon = null, envios = null, acordar = null, agora = Date.now } = {}) {
  const avisosLimite = new Map(); // `${espelho}|${origem}` → hora em que o limite de links já foi registrado no log
  let emAndamento = false;

  const regraPorId = (id) => lerRegra(db.prepare('SELECT * FROM espelhos WHERE id = ?').get(id));
  const nomeDoGrupo = (jid) => db.prepare('SELECT name FROM groups WHERE jid = ?').get(jid)?.name ?? null;
  const grupoExiste = (jid) => !!db.prepare('SELECT 1 FROM groups WHERE jid = ?').get(jid);
  const log = (regra, o) => addLog(db, { rule: { id: null, name: `Espelho: ${String(regra?.nome ?? '').slice(0, MAX_NOME) || 'sem nome'}` }, ...o });

  /** Tag de associado salva em Conexões, ou null. */
  function nossaTag() {
    if (!amazon?.montarLink) return null;
    try { return new URL(amazon.montarLink(SONDA_ASIN)).searchParams.get('tag') || null; } catch { return null; }
  }

  /**
   * Última vez (decidido_em) que o mesmo produto saiu por este espelhamento dentro de `dedupe_horas`, ou null.
   * Só conta envio que chegou a algum grupo ou ainda está na fila (CONTA_COMO_ENVIADO). `excetoId`: o próprio item.
   */
  function ultimaEnviada(regra, asin, now, excetoId = null) {
    if (!(regra.dedupe_horas > 0) || !asin) return null;
    return db.prepare(`SELECT MAX(decidido_em) AS em FROM espelho_itens WHERE espelho_id = ? AND asin = ? AND decidido_em > ?
      AND id != ? AND ${CONTA_COMO_ENVIADO}`).get(regra.id, asin, now - regra.dedupe_horas * HORA, excetoId ?? 0).em ?? null;
  }
  /** "menos de 1" ou o número de horas inteiras desde `ultima`. */
  const horasDesde = (ultima, now) => { const h = Math.floor((now - ultima) / HORA); return h < 1 ? 'menos de 1' : String(h); };

  function pedirEnvio() {
    if (acordar) { acordar(); return; }
    envios?.processarPendentes?.().catch((e) => console.error('[espelho] fila de envios:', e?.name || 'erro'));
  }

  // ------------------------------------------------------------------------------------------- receber

  /**
   * Mensagem nova de um grupo ({ jid, fromMe, texto, msgId, ts }, do ouvinte do whatsapp.js). Síncrono e sem rede:
   * grava um item `recebido` por regra e link da Amazon e acorda o agendador. Nunca lança. → itens gravados
   */
  function receber(msg) {
    try {
      const jid = typeof msg?.jid === 'string' ? msg.jid : '';
      const msgId = typeof msg?.msgId === 'string' ? msg.msgId : '';
      const texto = typeof msg?.texto === 'string' ? msg.texto : '';
      if (!jid.endsWith('@g.us') || !msgId || msgId.length > 256 || !texto) return 0;
      const regras = db.prepare('SELECT * FROM espelhos WHERE enabled = 1').all().map(lerRegra)
        .filter((r) => r.origem_jids.includes(jid) && (msg.fromMe !== true || r.incluir_minhas));
      if (!regras.length) return 0;

      // URLs do texto como veio (antes da máscara); só as da Amazon, sem as que já levam a nossa tag (guarda 2)
      const tag = nossaTag()?.toLowerCase();
      const vistos = new Set();
      const links = [];
      for (const url of extrairUrls(texto.slice(0, MAX_TEXTO_RECEBIDO))) {
        if (identificar(url)?.id !== 'amazon') continue;
        let u;
        try { u = new URL(url); } catch { continue; }
        if (tag && [...u.searchParams].some(([k, v]) => k.toLowerCase() === 'tag' && v.toLowerCase() === tag)) continue;
        const asin = extrairAsin(url);
        // o mesmo produto duas vezes na mesma mensagem (link sem esquema + link da prévia, ou com parâmetros diferentes)
        const chave = asin ? `ASIN:${asin}` : url;
        if (vistos.has(chave)) continue;
        vistos.add(chave);
        // com o ASIN já no link, guarda só o link limpo: nada da tag de terceiro nem do rastreio vai ao banco
        links.push({ url: asin ? urlDoAsin(asin) : url, asin });
      }
      if (!links.length) return 0;
      links.sort((a, b) => (a.asin ? 0 : 1) - (b.asin ? 0 : 1)); // o que não precisa de rede primeiro

      const agoraMs = agora();
      const ts = Number.isFinite(msg.ts) && msg.ts > 0 ? Math.floor(msg.ts) : agoraMs;
      const textoOrigem = textoParaGuardar(texto);
      const origemNome = nomeDoGrupo(jid);
      const contarHora = db.prepare('SELECT COUNT(*) AS n FROM espelho_itens WHERE espelho_id = ? AND origem_jid = ? AND ts >= ?');
      const inserir = db.prepare(`INSERT OR IGNORE INTO espelho_itens (espelho_id, origem_jid, origem_nome, msg_id, ts, url, asin, texto_origem, status)
        VALUES (?,?,?,?,?,?,?,?,'recebido')`);
      let gravados = 0;
      for (const r of regras) {
        let livres = MAX_LINKS_HORA - contarHora.get(r.id, jid, agoraMs - HORA).n;
        for (const l of links) {
          if (livres <= 0) { avisarLimite(r, jid, origemNome, agoraMs); break; }
          const { changes } = inserir.run(r.id, jid, origemNome, msgId, ts, l.url, l.asin, textoOrigem);
          if (changes) { gravados++; livres--; }
        }
      }
      if (gravados) pedirEnvio();
      return gravados;
    } catch (e) {
      // sem e.message: pode trazer trecho da mensagem ou valores da query
      console.error('[espelho] receber:', e?.code || e?.name || 'erro');
      return 0;
    }
  }

  /** Uma linha no log por regra, grupo e hora quando o teto de links por hora é atingido. */
  function avisarLimite(regra, jid, origemNome, agoraMs) {
    const chave = `${regra.id}|${jid}`;
    const horaAtual = Math.floor(agoraMs / HORA);
    if (avisosLimite.get(chave) === horaAtual) return;
    avisosLimite.set(chave, horaAtual);
    if (avisosLimite.size > 1000) avisosLimite.delete(avisosLimite.keys().next().value);
    log(regra, { level: 'aviso', group_name: origemNome, message: `Mais de ${MAX_LINKS_HORA} links da Amazon em 1 hora neste grupo: os próximos são ignorados até a hora seguinte.` });
  }

  // ------------------------------------------------------------------------------------------- decidir

  /** ASIN de um link: do próprio link, sem rede, ou seguindo o encurtador (amazon.resolver). Falha → LinkNaoResolvido. */
  async function asinDe(url) {
    const direto = extrairAsin(url);
    if (direto) return direto;
    if (!amazon?.resolver) throw new LinkNaoResolvido('invalido');
    try {
      const a = String((await amazon.resolver(url))?.asin ?? '').toUpperCase();
      if (!RE_ASIN.test(a)) throw new LinkNaoResolvido('invalido');
      return a;
    } catch (e) {
      throw e instanceof LinkNaoResolvido ? e : new LinkNaoResolvido('invalido');
    }
  }

  /** A mensagem fala de mais de um produto? (outro link dela leva a outro ASIN ou não resolve) */
  async function variosProdutos(urls, asin) {
    for (const url of urls) {
      let outro = null;
      try { outro = await asinDe(url); } catch { outro = null; }
      if (outro !== asin) return true;
    }
    return false;
  }

  /**
   * Dados da oferta: API (prioridade) e texto da origem campo a campo. `usarTexto` false quando a mensagem tem mais de
   * um produto. → { oferta, fonte: 'api'|'api+texto'|'texto'|null, api (oferta|null), erroApi (ErroAmazon|null) }
   */
  async function dadosDaOferta(asin, textoOrigem, { usarTexto }) {
    let api = null; let erroApi = null;
    if (!amazon?.lerItem) erroApi = new ErroAmazon('indisponivel');
    else {
      try { api = await amazon.lerItem(asin); } catch (e) {
        erroApi = e instanceof ErroAmazon ? e : new ErroAmazon('indisponivel');
        if (!(e instanceof ErroAmazon)) console.error('[espelho] dados da Amazon:', e?.name || 'erro'); // sem mensagem
      }
    }
    const t = usarTexto ? lerOfertaDoTexto(textoOrigem) : {};
    const de = { api: false, texto: false };
    const pegar = (vApi, vTexto) => {
      if (vApi != null && vApi !== '') { de.api = true; return vApi; }
      if (vTexto != null && vTexto !== '') { de.texto = true; return vTexto; }
      return null;
    };
    const title = pegar(api?.title, t.title);
    const precoDaApi = api?.price != null;
    const price = pegar(api?.price, t.price);
    // preço antigo só quando é maior que o atual: nenhuma linha "De" inventada (e o que foi jogado fora não conta como fonte)
    let oldPrice = api?.oldPrice ?? t.oldPrice ?? null;
    if (oldPrice != null && (price == null || oldPrice <= price)) oldPrice = null;
    if (oldPrice != null) de[api?.oldPrice != null ? 'api' : 'texto'] = true;
    // desconto: o da API (0 = não veio); senão o dos dois preços; o "NN% OFF" do texto só vale para o preço do texto
    let pct = api?.discountPct || (oldPrice != null ? discountPct(price, oldPrice) : null);
    if (!pct && !precoDaApi && t.discountPct) { pct = t.discountPct; de.texto = true; }
    const oferta = {
      title, price, oldPrice, discountPct: pct || null,
      sold: pegar(api?.sold, t.sold),
      freeShipping: !!(api?.freeShipping || t.freeShipping), // a API não informa frete: false = "não veio"
      coupon: pegar(api?.coupon, t.coupon),
      image: api?.image ?? null,
    };
    if (!api?.freeShipping && t.freeShipping) de.texto = true;
    const fonte = de.api && de.texto ? 'api+texto' : de.api ? 'api' : de.texto ? 'texto' : null;
    return { oferta, fonte, api, erroApi };
  }

  /**
   * Passos (c) a (g) da decisão 5 para um link. Sem gravar nada. `item` (quando é um item do banco) liga a
   * deduplicação dentro da mesma mensagem e a nova tentativa por cota.
   * → { decisao: 'erro'|'duplicado'|'esperar'|'descartado'|'na_fila'|'enviar'|'curto', motivo, asin?, oferta?, fonte?, espera_ate? }
   */
  async function avaliar(regra, { url, textoOrigem, outrasUrls = [], item = null }, now) {
    // (c) link → ASIN
    let asin;
    try { asin = await asinDe(url); } catch (e) {
      return { decisao: 'erro', motivo: e?.causa === 'nao_produto' ? 'não é um produto' : 'link não resolvido' };
    }
    // mesmo produto já veio em outro link desta mensagem (ex.: link curto e o link da prévia)
    if (item) {
      const antes = db.prepare('SELECT url, asin FROM espelho_itens WHERE espelho_id = ? AND origem_jid = ? AND msg_id = ? AND id < ?')
        .all(item.espelho_id, item.origem_jid, item.msg_id, item.id);
      if (antes.some((o) => (o.asin || extrairAsin(o.url)) === asin)) return { decisao: 'duplicado', motivo: 'mesmo produto de outro link desta mensagem', asin };
    }
    // (d) repetida dentro da janela de deduplicação (só conta o que chegou a algum grupo ou ainda está na fila)
    const ultima = ultimaEnviada(regra, asin, now, item?.id);
    if (ultima != null) return { decisao: 'duplicado', motivo: `repetida (enviada há ${horasDesde(ultima, now)} h)`, asin };
    // (e) dados: API, e o texto campo a campo (só quando a mensagem fala de um produto só)
    const usarTexto = !(await variosProdutos(outrasUrls, asin));
    const { oferta, fonte, api, erroApi } = await dadosDaOferta(asin, textoOrigem, { usarTexto });
    if (erroApi?.tipo === 'cota' && item && Number(erroApi.retryAfterSeconds) > 0 && erroApi.retryAfterSeconds <= COTA_ESPERA_MAX
      && item.tentativas < COTA_TENTATIVAS) {
      return { decisao: 'esperar', motivo: 'a Amazon pediu para esperar', asin, espera_ate: now + erroApi.retryAfterSeconds * 1000 };
    }
    const motivoApi = erroApi ? erroApi.message : null; // mensagem fixa por tipo (nunca corpo, URL ou credencial)
    // (f) palavras bloqueadas no título (API ou texto) e no texto da origem
    const palavra = palavraBloqueada([oferta.title, textoOrigem], regra.palavras_bloqueadas);
    if (palavra) return { decisao: 'descartado', motivo: `palavra bloqueada (${palavra})`, asin, oferta, fonte };
    // produto fora da loja brasileira ou indisponível: o dono decide (o link levaria a uma página sem oferta)
    if (amazon?.lerItem && !erroApi && !api) return { decisao: 'na_fila', motivo: 'a Amazon não encontrou este produto na loja do Brasil', asin, oferta, fonte };
    if (api?.disponivel === false) return { decisao: 'na_fila', motivo: 'a Amazon diz que o produto está indisponível', asin, oferta, fonte };
    // (g) título e preço → envia; senão, fila ou formato curto
    if (oferta.title && oferta.price != null) return { decisao: 'enviar', motivo: fonte === 'texto' ? motivoApi : null, asin, oferta, fonte };
    const falta = !oferta.title && oferta.price == null ? 'sem título e preço' : !oferta.title ? 'sem título' : 'sem preço';
    const porque = usarTexto ? falta : `${falta}: a mensagem tem mais de um produto`;
    if (regra.sem_preco === 'curto') return { decisao: 'curto', motivo: porque, nota: motivoApi, asin, oferta, fonte: 'curto' };
    return { decisao: 'na_fila', motivo: `falta completar (${porque})`, nota: motivoApi, asin, oferta, fonte };
  }

  /** Template da regra para o envio: existe, é o mesmo e tem {LINK}. → linha ou mensagem de erro */
  function templateDoEnvio(id) {
    const tpl = Number.isInteger(id) ? db.prepare('SELECT id, name, body, created_at FROM templates WHERE id = ?').get(id) : null;
    if (!tpl) return { erro: 'o template foi apagado' };
    if (!String(tpl.body).includes('{LINK}')) return { erro: 'o template não tem o campo {LINK}' };
    return { tpl };
  }

  /** Destinos do envio: os da regra (ou os escolhidos), sem o grupo de origem (guarda 3) e só os que existem. */
  const destinosDe = (jids, origemJid) => [...new Set(jids)].filter((j) => j !== origemJid && grupoExiste(j));

  /** Linha em `envios` no formato que preparar('oferta') espera (ver o topo). Chamar dentro de transação. → id */
  function gravarEnvio({ regra, asin, oferta, fonte, tpl, destinos, enviarFoto, upload = null, userId = null, now }) {
    const payload = {
      url: urlDoAsin(asin), loja: 'amazon', asin, tag_id: null, etiqueta: null,
      template_id: tpl.id, template_criado_em: tpl.created_at ?? null, fonte_dados: fonte, enviar_foto: enviarFoto,
      ...(upload ? { upload } : {}),
      origem: { tipo: 'espelho', espelho_id: regra.id, nome: regra.nome },
      offer: { key: `ASIN:${asin}`, ...soCampos(oferta) },
    };
    return Number(db.prepare(`INSERT INTO envios (tipo, payload, group_jids, quando, repetir, status, next_run_at, user_id, created_at)
      VALUES ('oferta', ?, ?, 'agora', NULL, 'pendente', ?, ?, ?)`)
      .run(JSON.stringify(payload), JSON.stringify(destinos), now, Number.isInteger(userId) ? userId : null, now).lastInsertRowid);
  }

  function transacao(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  const DETALHE = { api: 'com dados da Amazon', 'api+texto': 'com dados da Amazon e do texto da origem', texto: 'com o texto da origem', curto: 'no formato curto', manual: 'completada à mão' };

  /** Fecha o item (sai de 'processando') e registra no log. */
  function decidir(item, regra, { status, motivo = null, nota = null, asin = null, oferta = null, fonte = null, envioId = null }, now) {
    db.prepare(`UPDATE espelho_itens SET status = ?, motivo = ?, asin = COALESCE(?, asin), oferta = COALESCE(?, oferta), fonte_dados = COALESCE(?, fonte_dados),
      envio_id = COALESCE(?, envio_id), espera_ate = NULL, decidido_em = ? WHERE id = ?`)
      .run(status, motivo, asin, oferta ? JSON.stringify(soCampos(oferta)) : null, fonte, envioId, now, item.id);
    if (!regra) return;
    const titulo = oferta?.title || null;
    const sufixo = motivo ? ` (${motivo})` : '';
    const linha = {
      enviado: ['ok', `Espelhada ${DETALHE[fonte] || ''}${sufixo}`.replace(/\s+/g, ' ').trim()],
      na_fila: ['aviso', `Na fila: ${motivo || 'falta completar'}`],
      duplicado: ['aviso', `Descartada: ${motivo}`],
      descartado: ['aviso', `Descartada: ${motivo}`],
      expirado: ['aviso', `Descartada: ${motivo}`],
      erro: ['erro', `Não espelhada: ${motivo}`],
    }[status];
    if (linha) log(regra, { level: linha[0], group_name: item.origem_nome, offer_title: titulo, message: nota ? `${linha[1]}. ${nota}` : linha[1] });
  }

  /** Volta a 'recebido' para tentar depois (janela, máximo por hora, cota), sem log. */
  function adiar(item, esperaAte, motivo, { contaTentativa = false, asin = null } = {}) {
    db.prepare(`UPDATE espelho_itens SET status = 'recebido', espera_ate = ?, motivo = ?, asin = COALESCE(?, asin),
      tentativas = tentativas + ? WHERE id = ?`).run(esperaAte, motivo, asin, contaTentativa ? 1 : 0, item.id);
  }

  /** Um item já travado em 'processando'. */
  async function processarItem(item, now) {
    const regra = regraPorId(item.espelho_id);
    if (!regra) return decidir(item, null, { status: 'descartado', motivo: 'o espelhamento foi apagado' }, now);
    if (!regra.enabled) return decidir(item, regra, { status: 'descartado', motivo: 'o espelhamento foi desligado' }, now);
    // (a) parado além de 2 h desde a mensagem ou desde a hora marcada para sair: o serviço estava fora do ar
    if (now - (item.espera_ate ?? item.ts) > PARADO_MAX) {
      return decidir(item, regra, { status: 'expirado', motivo: 'ficou parada mais de 2 h (programa desligado ou fora do ar)' }, now);
    }
    if (!nossaTag()) return decidir(item, regra, { status: 'erro', motivo: amazon ? 'falta a tag de associado da Amazon em Conexões' : SEM_AMAZON }, now);
    // (b) janela de horário e máximo por hora: espera, sem contar tentativa (CA12)
    if (!dentroDaJanela(now, regra.janela_inicio, regra.janela_fim)) {
      return adiar(item, aberturaDaJanela(now, regra.janela_inicio), `aguardando o horário (abre às ${regra.janela_inicio})`);
    }
    if (regra.max_por_hora > 0) {
      const r = db.prepare(`SELECT COUNT(*) AS n, MIN(decidido_em) AS primeiro FROM espelho_itens WHERE espelho_id = ? AND decidido_em > ?
        AND ${CONTA_COMO_ENVIADO}`).get(regra.id, now - HORA);
      if (r.n >= regra.max_por_hora) {
        const livre = r.primeiro + HORA;
        return adiar(item, livre, `aguardando o máximo por hora (sai às ${horaCurta(livre)})`);
      }
    }
    const outras = db.prepare('SELECT url FROM espelho_itens WHERE espelho_id = ? AND origem_jid = ? AND msg_id = ? AND id != ?')
      .all(item.espelho_id, item.origem_jid, item.msg_id, item.id).map((o) => o.url);
    const d = await avaliar(regra, { url: item.url, textoOrigem: item.texto_origem || '', outrasUrls: outras, item }, now);
    if (d.decisao === 'esperar') return adiar(item, d.espera_ate, d.motivo, { contaTentativa: true, asin: d.asin });
    if (d.decisao === 'enviar' || d.decisao === 'curto') {
      const { tpl, erro } = templateDoEnvio(regra.template_id);
      const destinos = destinosDe(regra.destino_jids, item.origem_jid);
      const problema = erro || (!destinos.length ? 'nenhum grupo de destino disponível' : null);
      if (problema) return decidir(item, regra, { status: 'erro', motivo: problema, asin: d.asin, oferta: d.oferta, fonte: d.fonte }, now);
      const envioId = transacao(() => {
        const id = gravarEnvio({ regra, asin: d.asin, oferta: d.oferta, fonte: d.fonte, tpl, destinos, enviarFoto: regra.enviar_foto, now });
        decidir(item, regra, { status: 'enviado', motivo: d.motivo, nota: d.nota, asin: d.asin, oferta: d.oferta, fonte: d.fonte, envioId: id }, now);
        return id;
      });
      pedirEnvio();
      return envioId;
    }
    const status = { erro: 'erro', duplicado: 'duplicado', descartado: 'descartado', na_fila: 'na_fila' }[d.decisao];
    return decidir(item, regra, { status, motivo: d.motivo, nota: d.nota, asin: d.asin, oferta: d.oferta, fonte: d.fonte }, now);
  }

  /**
   * No tick, depois dos envios: decide os itens 'recebido' vencidos, um de cada vez (trava atômica recebido →
   * processando, changes === 1). A passada para de pegar itens depois de TEMPO_LOTE (cada item pode levar segundos de
   * rede no encurtador e na API): o que sobrou fica 'recebido' para o próximo tick, que começa pela fila de envios
   * (um "agora" do Disparo manual não espera o lote inteiro). Não acorda o agendador: o tick termina e as regras e os
   * avisos seguem no ritmo deles. O primeiro item sempre roda. → quantos foram tratados (adiados também contam)
   */
  async function processarPendentes(now = agora()) {
    if (emAndamento) return 0;
    emAndamento = true;
    let tratados = 0;
    try {
      const itens = db.prepare(`SELECT * FROM espelho_itens WHERE status = 'recebido' AND (espera_ate IS NULL OR espera_ate <= ?)
        ORDER BY COALESCE(espera_ate, ts), id LIMIT ?`).all(now, LOTE);
      const inicio = agora();
      for (const item of itens) {
        if (tratados > 0 && agora() - inicio >= TEMPO_LOTE) break;
        if (db.prepare("UPDATE espelho_itens SET status = 'processando' WHERE id = ? AND status = 'recebido'").run(item.id).changes !== 1) continue;
        try { await processarItem(item, now); } catch (e) {
          console.error('[espelho] item:', e?.code || e?.name || 'erro'); // sem e.message: pode trazer valores da query
          try { decidir(item, regraPorId(item.espelho_id), { status: 'erro', motivo: 'falha inesperada ao processar' }, now); } catch { /* fica para recuperar() */ }
        }
        tratados++;
      }
    } finally { emAndamento = false; }
    return tratados;
  }

  // ------------------------------------------------------------------------------------------- fila

  function idValido(id, msg = 'Oferta não encontrada.') {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) throw new ErroEspelho(404, msg);
    return n;
  }

  /** Ajustes do "Completar" (validarAjustesOferta, com a foto da fila de envios). */
  const validarAjustes = (a) => validarAjustesOferta(a, { lerFoto: envios?.lerFoto ? (up) => envios.lerFoto(up) : null });

  /** Oferta guardada com os ajustes por cima: preço antigo só se maior que o atual; desconto refeito se um preço mudou. */
  function aplicarAjustes(base, a) {
    const o = { ...base };
    for (const k of ['title', 'price', 'oldPrice', 'coupon', 'freeShipping']) if (Object.hasOwn(a, k)) o[k] = a[k];
    if (o.oldPrice != null && (o.price == null || o.oldPrice <= o.price)) o.oldPrice = null;
    if (o.price !== base.price || o.oldPrice !== base.oldPrice) o.discountPct = discountPct(o.price, o.oldPrice) || null;
    if (a.sem_foto || a.upload) o.image = null;
    return o;
  }

  /**
   * "Completar" de um item na fila: { ajustes, template_id?, destino_jids? } → { envio_id }. O item precisa estar
   * 'na_fila' (409 "Esta oferta já foi tratada." se outra pessoa já tratou). As palavras bloqueadas valem de novo.
   * "Horas sem repetir" também (Q1): se o mesmo produto já saiu por este espelhamento dentro da janela, o item sai
   * da fila como repetida e a resposta é 409 com o motivo.
   */
  async function completar(itemId, corpo, { userId = null } = {}) {
    const id = idValido(itemId);
    const b = corpo && typeof corpo === 'object' && !Array.isArray(corpo) ? corpo : {};
    const item = db.prepare('SELECT * FROM espelho_itens WHERE id = ?').get(id);
    if (!item) throw new ErroEspelho(404, 'Oferta não encontrada.');
    if (item.status !== 'na_fila') throw new ErroEspelho(409, JA_TRATADA);
    const regra = regraPorId(item.espelho_id);
    if (!regra) throw new ErroEspelho(404, 'O espelhamento desta oferta foi apagado.');
    const asin = String(item.asin ?? '');
    if (!RE_ASIN.test(asin)) throw new ErroEspelho(400, 'Esta oferta está sem o código do produto da Amazon.');
    const ajustes = await validarAjustes(b.ajustes);
    const oferta = aplicarAjustes(soCampos(lerJson(item.oferta, {})), ajustes);
    if (!oferta.title) throw new ErroEspelho(400, 'Preencha o título do produto.');
    if (oferta.price == null) throw new ErroEspelho(400, 'Preencha o preço atual.');
    const palavra = palavraBloqueada([oferta.title], regra.palavras_bloqueadas);
    if (palavra) throw new ErroEspelho(400, `O título tem uma palavra bloqueada deste espelhamento: ${palavra}.`);

    let tpl;
    if (b.template_id != null && b.template_id !== '') {
      const t = templateDoEnvio(Number(b.template_id));
      if (t.erro) throw new ErroEspelho(400, t.erro === 'o template foi apagado' ? 'Template não encontrado. Escolha outro.' : 'O template precisa do campo {LINK}.');
      tpl = t.tpl;
    } else {
      const t = templateDoEnvio(regra.template_id);
      if (t.erro) throw new ErroEspelho(400, 'O template deste espelhamento foi apagado ou está sem {LINK}. Escolha outro.');
      tpl = t.tpl;
    }
    let jids = regra.destino_jids;
    if (b.destino_jids != null) {
      if (!Array.isArray(b.destino_jids) || b.destino_jids.length > MAX_GRUPOS || b.destino_jids.some((j) => typeof j !== 'string')) {
        throw new ErroEspelho(400, 'Lista de grupos inválida.');
      }
      jids = b.destino_jids;
    }
    const destinos = destinosDe(jids, item.origem_jid);
    if (!destinos.length) throw new ErroEspelho(400, 'Escolha ao menos um grupo de destino (o grupo de origem não conta).');
    if (!nossaTag()) throw new ErroEspelho(400, amazon ? 'Falta a tag de associado da Amazon. Cadastre em Conexões → Amazon antes de enviar.' : SEM_AMAZON);
    if (wa && !wa.isReady()) throw new ErroEspelho(400, 'O WhatsApp está desconectado. Conecte o número antes de enviar.');

    const now = agora();
    const enviarFoto = ajustes.sem_foto ? false : ajustes.upload ? true : regra.enviar_foto;
    let repetidaHa = null; // horas desde o último envio do mesmo produto, quando ele já saiu dentro de "Horas sem repetir"
    const envioId = transacao(() => {
      const r = db.prepare("UPDATE espelho_itens SET status = 'processando' WHERE id = ? AND status = 'na_fila'").run(id);
      if (r.changes !== 1) throw new ErroEspelho(409, JA_TRATADA);
      const ultima = ultimaEnviada(regra, asin, now, id);
      if (ultima != null) {
        repetidaHa = horasDesde(ultima, now);
        decidir(item, regra, { status: 'duplicado', motivo: `repetida (enviada há ${repetidaHa} h)` }, now);
        return null;
      }
      const novo = gravarEnvio({ regra, asin, oferta, fonte: 'manual', tpl, destinos, enviarFoto, upload: ajustes.upload, userId, now });
      decidir(item, regra, { status: 'enviado', motivo: null, oferta, fonte: 'manual', envioId: novo }, now);
      return novo;
    });
    if (repetidaHa != null) {
      throw new ErroEspelho(409, `Este produto já foi espelhado há ${repetidaHa} h, dentro de "Horas sem repetir". A oferta saiu da fila como repetida.`);
    }
    pedirEnvio();
    return { envio_id: envioId };
  }

  /** Descarta um item da fila. → { ok } */
  function descartar(itemId) {
    const id = idValido(itemId);
    const item = db.prepare('SELECT * FROM espelho_itens WHERE id = ?').get(id);
    if (!item) throw new ErroEspelho(404, 'Oferta não encontrada.');
    const now = agora();
    const r = db.prepare("UPDATE espelho_itens SET status = 'descartado', motivo = 'descartada à mão', decidido_em = ? WHERE id = ? AND status = 'na_fila'")
      .run(now, id);
    if (r.changes !== 1) throw new ErroEspelho(409, JA_TRATADA);
    const regra = regraPorId(item.espelho_id);
    if (regra) log(regra, { level: 'info', group_name: item.origem_nome, offer_title: lerJson(item.oferta, {})?.title || null, message: 'Descartada à mão' });
    return { ok: true };
  }

  /** 'na_fila' mais velho que dedupe_horas da regra (mínimo 24 h) → 'expirado', com linha no log. → quantos */
  function expirarFila(now = agora()) {
    const vencidos = db.prepare(`SELECT * FROM espelho_itens WHERE status = 'na_fila' AND COALESCE(decidido_em, ts) < ? - ? * COALESCE(
        (SELECT MAX(e.dedupe_horas, ?) FROM espelhos e WHERE e.id = espelho_itens.espelho_id), ?)`).all(now, HORA, FILA_MIN_HORAS, FILA_MIN_HORAS);
    let n = 0;
    for (const item of vencidos) {
      if (db.prepare("UPDATE espelho_itens SET status = 'processando' WHERE id = ? AND status = 'na_fila'").run(item.id).changes !== 1) continue;
      decidir(item, regraPorId(item.espelho_id), { status: 'expirado', motivo: 'expirou sem ser completada' }, now);
      n++;
    }
    return n;
  }

  /** Ao iniciar o serviço: o que ficou 'processando' quando ele caiu volta a 'recebido'. → quantos */
  function recuperar() {
    return Number(db.prepare("UPDATE espelho_itens SET status = 'recebido' WHERE status = 'processando'").run().changes);
  }

  /**
   * Retenção: apaga itens decididos há mais de `dias` (0 = não apaga), menos os 'enviado' que ainda contam para a
   * deduplicação da regra. → { itens }
   */
  function limpar(dias, now = agora()) {
    const d = Number(dias);
    if (!(d > 0)) return { itens: 0 };
    const itens = db.prepare(`DELETE FROM espelho_itens WHERE status NOT IN (${ATIVOS.map(() => '?').join(',')})
      AND COALESCE(decidido_em, ts) < ?
      AND NOT (status = 'enviado' AND decidido_em > ? - ? * COALESCE((SELECT e.dedupe_horas FROM espelhos e WHERE e.id = espelho_itens.espelho_id), 0))`)
      .run(...ATIVOS, now - d * DIA, now, HORA).changes;
    return { itens: Number(itens) };
  }

  // ------------------------------------------------------------------------------------------- regras (CRUD)

  function lerGrupos(lista, qual) {
    if (!Array.isArray(lista) || !lista.length) throw new ErroEspelho(400, `Marque ao menos um grupo de ${qual}.`);
    if (lista.length > MAX_GRUPOS || lista.some((j) => typeof j !== 'string' || !j)) throw new ErroEspelho(400, 'Lista de grupos inválida.');
    const jids = [...new Set(lista)];
    if (jids.some((j) => !grupoExiste(j))) throw new ErroEspelho(400, `Algum grupo de ${qual} não existe mais. Atualize a lista e escolha de novo.`);
    return jids;
  }

  function lerInteiro(v, padrao, min, max, msg) {
    if (v == null || v === '') return padrao;
    const n = typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : v;
    if (!Number.isInteger(n) || n < min || n > max) throw new ErroEspelho(400, msg);
    return n;
  }

  function lerHora(v) {
    if (v == null || v === '') return null;
    const m = HHMM.exec(typeof v === 'string' ? v.trim() : '');
    if (!m) throw new ErroEspelho(400, 'Horário inválido: use HH:MM.');
    return `${pad(m[1])}:${m[2]}`;
  }

  /** Palavras: lista ou texto (uma por linha ou separadas por vírgula); sem repetir (sem acento e caixa). */
  function lerPalavras(v) {
    if (v == null || v === '') return [];
    const bruta = typeof v === 'string' ? v.split(/[\n,;]/) : v;
    if (!Array.isArray(bruta) || bruta.some((p) => typeof p !== 'string')) throw new ErroEspelho(400, 'Palavras bloqueadas inválidas.');
    const vistas = new Set(); const out = [];
    for (const p of bruta) {
      const t = p.replace(/\s+/g, ' ').trim();
      if (!t) continue;
      if (t.length > MAX_PALAVRA) throw new ErroEspelho(400, `Uma palavra bloqueada tem mais de ${MAX_PALAVRA} caracteres.`);
      const n = normalizar(t);
      if (vistas.has(n)) continue;
      vistas.add(n); out.push(t);
    }
    if (out.length > MAX_PALAVRAS) throw new ErroEspelho(400, `Use até ${MAX_PALAVRAS} palavras bloqueadas.`);
    return out;
  }

  function lerBool(v, padrao, campo) {
    if (v == null) return padrao;
    if (typeof v !== 'boolean') throw new ErroEspelho(400, `${campo}: ligue ou desligue.`);
    return v;
  }

  /** Corpo de criar/atualizar → colunas validadas. */
  function validarRegra(corpo) {
    const b = corpo && typeof corpo === 'object' && !Array.isArray(corpo) ? corpo : {};
    const nome = typeof b.nome === 'string' ? b.nome.replace(/\s+/g, ' ').trim() : '';
    if (!nome) throw new ErroEspelho(400, 'Dê um nome ao espelhamento.');
    if (nome.length > MAX_NOME) throw new ErroEspelho(400, `O nome passa de ${MAX_NOME} caracteres.`);
    const origem = lerGrupos(b.origem_jids, 'origem');
    const destino = lerGrupos(b.destino_jids, 'destino');
    const ambos = origem.filter((j) => destino.includes(j));
    if (ambos.length) {
      const nomes = ambos.slice(0, 3).map((j) => nomeDoGrupo(j) || 'sem nome').join(', ');
      throw new ErroEspelho(400, `Um grupo não pode ser origem e destino ao mesmo tempo: ${nomes}.`);
    }
    const tplId = b.template_id == null || b.template_id === '' ? NaN : Number(b.template_id);
    const tpl = Number.isInteger(tplId) ? db.prepare('SELECT body FROM templates WHERE id = ?').get(tplId) : null;
    if (!tpl) throw new ErroEspelho(400, 'Escolha um template.');
    if (!String(tpl.body).includes('{LINK}')) throw new ErroEspelho(400, 'O template precisa do campo {LINK}.');
    const janelaInicio = lerHora(b.janela_inicio);
    const janelaFim = lerHora(b.janela_fim);
    if (!janelaInicio !== !janelaFim) throw new ErroEspelho(400, 'Preencha o início e o fim do horário, ou deixe os dois em branco.');
    const semPreco = b.sem_preco == null || b.sem_preco === '' ? 'fila' : b.sem_preco;
    if (!SEM_PRECO.includes(semPreco)) throw new ErroEspelho(400, 'Quando faltar o preço: esperar completar ou enviar mesmo assim.');
    const enabled = lerBool(b.enabled, true, 'Ativo');
    return {
      nome, enabled, origem_jids: origem, destino_jids: destino, template_id: tplId,
      incluir_minhas: lerBool(b.incluir_minhas, false, 'Espelhar também as minhas mensagens'),
      dedupe_horas: lerInteiro(b.dedupe_horas, 168, 0, 8760, 'Horas sem repetir: use de 0 a 8760.'),
      palavras_bloqueadas: lerPalavras(b.palavras_bloqueadas),
      sem_preco: semPreco,
      max_por_hora: lerInteiro(b.max_por_hora, 10, 0, 60, 'Máximo por hora: use de 0 a 60 (0 = sem limite).'),
      janela_inicio: janelaInicio, janela_fim: janelaFim,
      enviar_foto: lerBool(b.enviar_foto, true, 'Enviar a foto'),
    };
  }

  function exigirTagParaLigar() {
    if (!amazon) throw new ErroEspelho(400, SEM_AMAZON);
    if (!nossaTag()) throw new ErroEspelho(400, SEM_TAG);
  }

  const COLUNAS = ['nome', 'enabled', 'origem_jids', 'destino_jids', 'template_id', 'incluir_minhas', 'dedupe_horas',
    'palavras_bloqueadas', 'sem_preco', 'max_por_hora', 'janela_inicio', 'janela_fim', 'enviar_foto'];
  const valoresDe = (v) => COLUNAS.map((c) => {
    const x = v[c];
    if (Array.isArray(x)) return JSON.stringify(x);
    if (typeof x === 'boolean') return x ? 1 : 0;
    return x ?? null;
  });

  function exigirRegra(id) {
    const n = idValido(id, 'Espelhamento não encontrado.');
    const r = regraPorId(n);
    if (!r) throw new ErroEspelho(404, 'Espelhamento não encontrado.');
    return r;
  }

  /** → { id } */
  function criar(corpo) {
    const v = validarRegra(corpo);
    if (v.enabled) exigirTagParaLigar();
    const now = agora();
    const id = Number(db.prepare(`INSERT INTO espelhos (${COLUNAS.join(', ')}, created_at, updated_at) VALUES (${COLUNAS.map(() => '?').join(', ')}, ?, ?)`)
      .run(...valoresDe(v), now, now).lastInsertRowid);
    return { id };
  }

  /** Troca a regra inteira (o corpo traz todos os campos, como o formulário). → { id } */
  function atualizar(id, corpo) {
    const atual = exigirRegra(id);
    const v = validarRegra({ enabled: atual.enabled, ...(corpo && typeof corpo === 'object' ? corpo : {}) });
    if (v.enabled) exigirTagParaLigar();
    db.prepare(`UPDATE espelhos SET ${COLUNAS.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...valoresDe(v), agora(), atual.id);
    return { id: atual.id };
  }

  /** Apaga a regra e os itens dela (inclusive o texto guardado). Envios já criados seguem na fila de envios. → { ok } */
  function apagar(id) {
    const r = exigirRegra(id);
    transacao(() => {
      db.prepare('DELETE FROM espelho_itens WHERE espelho_id = ?').run(r.id);
      db.prepare('DELETE FROM espelhos WHERE id = ?').run(r.id);
    });
    return { ok: true };
  }

  /** Liga ou desliga. Ligar exige a tag de associado. → { ok, enabled } */
  function ativar(id, enabled) {
    const r = exigirRegra(id);
    if (typeof enabled !== 'boolean') throw new ErroEspelho(400, 'Ativo: ligue ou desligue.');
    if (enabled) exigirTagParaLigar();
    db.prepare('UPDATE espelhos SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, agora(), r.id);
    return { ok: true, enabled };
  }

  /** Nome do grupo que sumiu de `groups`: o último guardado num item, se houver. */
  const nomeAntigo = (jid) => db.prepare('SELECT origem_nome FROM espelho_itens WHERE origem_jid = ? AND origem_nome IS NOT NULL ORDER BY id DESC LIMIT 1').get(jid)?.origem_nome ?? null;

  /** Problema de configuração mostrado no cartão (só nomes de grupo), ou null. */
  function problemaDe(r, nomes, tplNome) {
    const sumiram = [...r.origem_jids, ...r.destino_jids].filter((j) => !nomes.has(j));
    if (sumiram.length === 1) {
      const nome = nomeAntigo(sumiram[0]);
      return nome ? `O número saiu do grupo ${nome}. Edite o espelhamento.` : 'O número saiu de um grupo deste espelhamento. Edite o espelhamento.';
    }
    if (sumiram.length > 1) return `O número saiu de ${sumiram.length} grupos deste espelhamento. Edite o espelhamento.`;
    if (tplNome == null) return 'O template deste espelhamento foi apagado. Edite o espelhamento.';
    if (r.enabled && !nossaTag()) return SEM_TAG;
    return null;
  }

  /** GET /api/espelhos. Sem `texto_origem`, sem URL e sem credencial. */
  function listar(now = agora()) {
    const nomes = new Map(db.prepare('SELECT jid, name FROM groups').all().map((g) => [g.jid, g.name]));
    const templates = new Map(db.prepare('SELECT id, name FROM templates').all().map((t) => [t.id, t.name]));
    const desde = now - DIA;
    // "Espelhadas" só conta o que chegou a algum grupo ou ainda está na fila de envios (CONTA_COMO_ENVIADO)
    const conta = new Map(db.prepare(`SELECT espelho_id,
        SUM(decidido_em >= ? AND ${CONTA_COMO_ENVIADO}) AS espelhadas,
        SUM(status IN (${DESCARTES.map(() => '?').join(',')}) AND decidido_em >= ?) AS descartadas,
        SUM(status = 'na_fila') AS na_fila
      FROM espelho_itens GROUP BY espelho_id`).all(desde, ...DESCARTES, desde)
      .map((c) => [c.espelho_id, { espelhadas: Number(c.espelhadas) || 0, descartadas: Number(c.descartadas) || 0, na_fila: Number(c.na_fila) || 0 }]));
    const totais = { espelhadas: 0, descartadas: 0, na_fila: 0 };
    const espelhos = db.prepare('SELECT * FROM espelhos ORDER BY id').all().map(lerRegra).map((r) => {
      const c = conta.get(r.id) ?? { espelhadas: 0, descartadas: 0, na_fila: 0 };
      for (const k of Object.keys(totais)) totais[k] += c[k];
      const tplNome = templates.get(r.template_id) ?? null;
      return {
        id: r.id, nome: r.nome, enabled: r.enabled,
        origem_jids: r.origem_jids, origens_nomes: r.origem_jids.map((j) => nomes.get(j) ?? '(grupo removido)'),
        destino_jids: r.destino_jids, destinos_nomes: r.destino_jids.map((j) => nomes.get(j) ?? '(grupo removido)'),
        template_id: r.template_id, template_nome: tplNome, incluir_minhas: r.incluir_minhas, dedupe_horas: r.dedupe_horas,
        palavras_bloqueadas: r.palavras_bloqueadas, sem_preco: r.sem_preco, max_por_hora: r.max_por_hora,
        janela_inicio: r.janela_inicio, janela_fim: r.janela_fim, enviar_foto: r.enviar_foto,
        problema: problemaDe(r, nomes, tplNome), contadores_24h: c,
      };
    });
    const situacao = amazon?.situacao ? amazon.situacao() : { acesso: 'nao_configurada', verificado_em: null, motivo: SEM_AMAZON };
    return { amazon: situacao, totais_24h: totais, espelhos };
  }

  /**
   * GET /api/espelhos/itens?espelho=&status=na_fila|todos&antes=<id>&limite=50 → itens do mais novo para o mais velho,
   * sem `url` e sem `texto_origem`. `destinos` vem do envio: ok true/false, ou null enquanto o envio está na fila.
   * Envio encerrado (erro, cancelado, concluído) sem resultado para um grupo → ok false com o motivo do envio (ex.:
   * perdeu o horário porque o WhatsApp ficou fora mais de 2 h): o item não fica "enviando" para sempre (Q2).
   */
  function itens(q = {}) {
    const filtros = []; const args = [];
    if (q.espelho != null && q.espelho !== '') { filtros.push('i.espelho_id = ?'); args.push(idValido(q.espelho, 'Espelhamento não encontrado.')); }
    const status = q.status == null || q.status === '' ? 'todos' : String(q.status);
    if (status === 'na_fila') filtros.push("i.status = 'na_fila'");
    else if (status !== 'todos') throw new ErroEspelho(400, 'Filtro inválido: use na_fila ou todos.');
    if (q.antes != null && q.antes !== '') { filtros.push('i.id < ?'); args.push(idValido(q.antes)); }
    const lim = Math.min(Math.max(Number.parseInt(q.limite, 10) || MAX_LIMITE_ITENS, 1), MAX_LIMITE_ITENS);
    const linhas = db.prepare(`SELECT i.id, i.espelho_id, e.nome AS espelho_nome, i.origem_nome, i.ts, i.asin, i.status, i.motivo,
        i.fonte_dados, i.oferta, i.envio_id, i.decidido_em, v.group_jids, v.status AS envio_status, v.resultado AS envio_resultado
      FROM espelho_itens i LEFT JOIN espelhos e ON e.id = i.espelho_id LEFT JOIN envios v ON v.id = i.envio_id
      ${filtros.length ? `WHERE ${filtros.join(' AND ')}` : ''} ORDER BY i.id DESC LIMIT ?`).all(...args, lim);
    const nomes = new Map(db.prepare('SELECT jid, name FROM groups').all().map((g) => [g.jid, g.name]));
    const resultados = db.prepare('SELECT jid, group_name, ok, erro FROM envio_resultados WHERE envio_id = ? ORDER BY id');
    return linhas.map((l) => {
      const ultimo = new Map();
      if (l.envio_id != null) for (const r of resultados.all(l.envio_id)) ultimo.set(r.jid, r);
      const encerrado = l.envio_status != null && !ENVIO_ATIVO.includes(l.envio_status);
      const motivoEnvio = encerrado ? motivoDoEnvio(l.envio_status, l.envio_resultado) : null;
      const destinos = listaDeTexto(l.group_jids).map((jid) => {
        const r = ultimo.get(jid);
        const nome = r?.group_name || nomes.get(jid) || '(grupo removido)';
        if (!r) return encerrado ? { nome, ok: false, erro: motivoEnvio } : { nome, ok: null, erro: null };
        return { nome, ok: !!r.ok, erro: r.ok ? null : r.erro };
      });
      return {
        id: l.id, espelho_id: l.espelho_id, espelho_nome: l.espelho_nome ?? null, origem_nome: l.origem_nome, ts: l.ts,
        asin: l.asin, status: l.status, motivo: l.motivo, fonte_dados: l.fonte_dados,
        oferta: l.oferta ? soCampos(lerJson(l.oferta, {})) : null, destinos, envio_id: l.envio_id, decidido_em: l.decidido_em,
      };
    });
  }

  /** Motivo de um envio encerrado para os grupos que ele não tentou (o da fila de envios, já sem dado de fora). */
  function motivoDoEnvio(status, resultado) {
    const m = lerJson(resultado, {})?.motivo;
    if (typeof m === 'string' && m.trim()) return m.trim().slice(0, MAX_MOTIVO_ENVIO);
    return status === 'cancelado' ? 'o envio foi cancelado' : NAO_ENVIADO;
  }

  /**
   * POST /api/espelhos/:id/testar { texto }: o que a regra faria com esta mensagem, sem gravar nem enviar.
   * → { links, asin, fonte_dados, oferta, texto (com a tag mascarada), decisao, motivo }
   */
  async function testar(id, corpo) {
    const regra = exigirRegra(id);
    const bruto = typeof corpo?.texto === 'string' ? corpo.texto : '';
    if (!bruto.trim()) throw new ErroEspelho(400, 'Cole uma mensagem de exemplo.');
    if (bruto.length > MAX_TEXTO_RECEBIDO) throw new ErroEspelho(400, `A mensagem passa de ${MAX_TEXTO_RECEBIDO} caracteres.`);
    const vazio = { links: [], asin: null, fonte_dados: null, oferta: null, texto: null };
    const tag = nossaTag()?.toLowerCase();
    const links = []; const vistos = new Set(); let comNossaTag = false;
    for (const url of extrairUrls(bruto)) {
      if (identificar(url)?.id !== 'amazon') continue;
      let u; try { u = new URL(url); } catch { continue; }
      if (tag && [...u.searchParams].some(([k, v]) => k.toLowerCase() === 'tag' && v.toLowerCase() === tag)) { comNossaTag = true; continue; }
      const asin = extrairAsin(url);
      const chave = asin ? `ASIN:${asin}` : url;
      if (vistos.has(chave)) continue;
      vistos.add(chave); links.push(url);
    }
    if (!links.length) {
      return { ...vazio, decisao: 'ignorado', motivo: comNossaTag ? 'o link já leva a sua tag (não é espelhado)' : 'nenhum link da Amazon na mensagem' };
    }
    const d = await avaliar(regra, { url: links[0], textoOrigem: textoParaGuardar(bruto), outrasUrls: links.slice(1) }, agora());
    let decisao = d.decisao; let motivo = d.motivo ?? null;
    if ((decisao === 'enviar' || decisao === 'curto') && !nossaTag()) { decisao = 'erro'; motivo = 'falta a tag de associado da Amazon em Conexões'; }
    let texto = null;
    if (d.asin && d.oferta) {
      const tpl = templateDoEnvio(regra.template_id).tpl;
      const tituloMax = Number(getSetting(db, 'titulo_max', 60));
      if (tpl) texto = renderTemplate(tpl.body, { ...d.oferta, link: mascararTag(`${urlDoAsin(d.asin)}?tag=x`) }, { tituloMax });
    }
    return { links, asin: d.asin ?? null, fonte_dados: d.fonte ?? null, oferta: d.oferta ? soCampos(d.oferta) : null, texto, decisao, motivo };
  }

  return {
    receber, processarPendentes, expirarFila, recuperar, limpar,
    listar, criar, atualizar, apagar, ativar, itens, completar, descartar, testar,
  };
}

/** Responde JSON; ErroEspelho vira o status dele. Erro inesperado (banco) não devolve nem registra a mensagem. */
const responder = (fn) => async (req, res) => {
  try { res.json(await fn(req)); } catch (e) {
    if (e instanceof ErroEspelho) return res.status(e.status).json({ erro: e.message });
    console.error('[espelho] falha inesperada:', e?.code || e?.name || 'erro'); // sem e.message: pode trazer valores da query
    res.status(500).json({ erro: 'Não consegui concluir. Tente de novo.' });
  }
};

/**
 * Rotas do espelhamento, montadas por buildApp depois do login e da checagem Host/Origin (qualquer pessoa logada,
 * como os envios). O espelho é ctx.scheduler.espelho, lido na hora (a ligação é da etapa 13).
 */
export function montarRotas(app, ctx) {
  const espelho = () => {
    const e = ctx.scheduler?.espelho;
    if (!e) throw new ErroEspelho(503, 'O espelhamento não está disponível neste servidor.');
    return e;
  };
  app.get('/api/espelhos', responder(() => espelho().listar()));
  app.post('/api/espelhos', responder((req) => espelho().criar(req.body)));
  app.get('/api/espelhos/itens', responder((req) => espelho().itens(req.query)));
  app.post('/api/espelhos/itens/:id/enviar', responder((req) => espelho().completar(req.params.id, req.body, { userId: req.user?.id ?? null })));
  app.post('/api/espelhos/itens/:id/descartar', responder((req) => espelho().descartar(req.params.id)));
  app.put('/api/espelhos/:id', responder((req) => espelho().atualizar(req.params.id, req.body)));
  app.delete('/api/espelhos/:id', responder((req) => espelho().apagar(req.params.id)));
  app.post('/api/espelhos/:id/enabled', responder((req) => espelho().ativar(req.params.id, req.body?.enabled)));
  app.post('/api/espelhos/:id/testar', responder((req) => espelho().testar(req.params.id, req.body)));
}
