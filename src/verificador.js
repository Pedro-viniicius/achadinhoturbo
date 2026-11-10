// Verificador de preço e estoque logo antes do envio (plano verificador-preco-estoque, etapa 5; ADR-010).
//
// Contrato do módulo:
//
// - decidir({ leitura, referencia, precoOferta, limitePct, lidoEm, agora, digitado }) → decisão. Pura: sem rede,
//   sem banco, sem relógio próprio.
//   - leitura = { price, disponivel, discountPct?, oldPrice?, varias? } (a loja respondeu) ou { causa } (sem conferência;
//     chave de CAUSAS). `varias: true`: catálogo do ML de várias versões e o link não diz qual (ml.urlProdutoML e
//     resumoDasVariantes de src/ml.js); `price` é o menor preço entre as versões, todas à venda.
//   - Esgotado só com sinal explícito (D5): `disponivel === false`, com ou sem preço → descartar 'esgotado'.
//   - Sem preço lido (> 0) → sem conferência (causa da leitura, 'varias_versoes' com `varias`, ou 'sem_preco').
//   - `varias` com preço: só o descarte vale (o menor preço acima do limite → 'preco_subiu'); senão, sem conferência
//     ('varias_versoes'): nunca o preço de uma versão como se fosse o do anúncio.
//   - Sem conferência (D3): `lidoEm` (ms) de até FRESCOR_MIN atrás → enviar, sem conferir, com o sufixo
//     " · preço não conferido (<causa>)"; mais velho, no futuro ou desconhecido → descartar 'nao_conferido'.
//   - Conferido (D4): referência inválida → enviar sem comparar. Preço atual acima de referência × (1 + L/100)
//     → descartar 'preco_subiu'. Senão, se o preço da oferta é a referência (e não foi digitado), sai com o preço
//     atual (`precoNovo`) e o sufixo " · preço atualizado de R$ X para R$ Y"; preço digitado à mão é mantido.
//   → { acao: 'enviar', conferido, precoNovo: número|null, sufixo: texto|null }
//     | { acao: 'descartar', motivo: 'esgotado'|'preco_subiu'|'nao_conferido', texto }
// - createVerificador({ db, ml, amazon, shopee, links = null, simulado = false, agora = Date.now, tempoMaxMs = TEMPO_MAX_MS })
//   → { ativo(), limitePct(), conferir(oferta, { lidoEm, referencia }), podeConferir(loja) }
//   - ativo(): `settings.verificador_ativo` diferente de '0' (ausente = ligado). limitePct(): inteiro de 0 a
//     LIMITE_MAX_PCT de `settings.verificador_limite_pct`; ausente ou fora disso = LIMITE_PADRAO_PCT.
//   - oferta = { loja: 'mercadolivre'|'amazon'|'shopee'|'magalu', url, asin, shopId, itemId, price, oldPrice,
//     discountPct, digitado, … }. Amazon: `asin` ou a chave 'ASIN:<asin>'. Shopee: `shopId`/`itemId` (ou
//     `shop_id`/`item_id` do payload da fila) ou a chave 'SHOPEE:<shop>.<item>'.
//   - podeConferir(loja): a loja tem como ser conferida agora (Magalu nunca; ML sempre; Amazon e Shopee com a API ligada,
//     ou na simulação). A leitura do ML não traz preço antigo; a da Amazon traz `oldPrice` e ele vale mais que o gravado.
//   - Leitura por loja (D2): ML por ml.conferirProduto(url); Amazon por amazon.lerItem(asin, { fresco: true });
//     Shopee por shopee.lerItem(shopId, itemId, { fresco: true }), só preço (a API não traz estoque); Magalu nunca.
//   - ML no modo de link 'extension' (`links.modo()`; plano verificador-ml-extensao, D5/D8/D9): só pela extensão do
//     Chrome, por links.requestProduto({ url }), e nunca pelo servidor (a leitura dele é barrada e soma pontos no
//     anti-robô da sessão do dono). A URL passa por ml.urlProdutoML (só anúncio ou catálogo do ML; senão 'loja_fora'
//     sem pedido), com o anúncio da oferta (`item_id`, `itemId` ou a chave `MLB…`, como o `metadata.id` da Central)
//     como `pdp_filters` num catálogo sem filtro. A resposta
//     (nunca rejeita) é { price, disponivel } (já validada por ml.lerProdutoDaExtensao) ou { falha }, que vira causa:
//     desconectada → extensao_off, antiga → extensao_antiga, verificacao → ml_verificacao, limite → limite_hora,
//     tempo → demorou, erro (ou outra) → loja_fora. Modo 'direct'/'fake' ou sem `links`: ml.conferirProduto.
//   - Cada leitura leva no máximo `tempoMaxMs` (Promise.race; a promessa perdedora tem o seu .catch e o timer é
//     limpo). Erro do leitor = sem conferência; no console vai só a loja e o `e.name` (nunca URL, corpo ou mensagem).
//   - `conferir` nunca lança. → { acao: 'enviar', oferta, conferido, sufixo|null } (cópia da oferta; `vistoEm` = agora()
//     só quando conferido; preço, preço antigo e desconto atualizados quando o preço mudou)
//     | { acao: 'descartar', motivo, texto }.
//   - Desligado: enviar a oferta como veio, sem `vistoEm` e sem sufixo, sem ler a loja.
//   - simulado (DRY_RUN): confirma sem rede (conferido, `vistoEm`, preço como veio). A Magalu segue sem conferência,
//     como fora da simulação (nunca há leitura dela).
//
// Os textos são frases fixas, CAUSAS e preços formatados por brl(): nada vindo da loja além de números validados.

import * as mlPadrao from './ml.js';
import { urlProdutoML } from './ml.js';
import { getSetting } from './db.js';
import { brl, discountPct as calcularDesconto } from './template.js';

export const LIMITE_PADRAO_PCT = 5;
export const LIMITE_MAX_PCT = 50;
export const FRESCOR_MIN = 30;
/** Folga do agendado sem conferência: o tick e a pausa entre envios atrasam a saída, e os dados (criação) não podem passar de FRESCOR_MIN. */
export const MARGEM_AGENDADO_MIN = 5;
export const TEMPO_MAX_MS = 20000;
export const PAUSA_DESCARTADA_H = 6;

export const MOTIVOS_VERIFICADOR = Object.freeze({
  esgotado: 'Descartada: esgotado na loja',
  preco_subiu: 'Descartada: preço subiu',
  nao_conferido: 'Descartada: não deu para conferir o preço',
});

/** Por que não houve conferência. Frases fixas: entram no Histórico entre parênteses. */
export const CAUSAS = Object.freeze({
  loja_fora: 'a loja não respondeu',
  amazon_sem_api: 'a API da Amazon não está ligada',
  shopee_sem_api: 'a API da Shopee não está ligada',
  magalu: 'a Magalu não deixa ler a página',
  shopee_sem_produto: 'a Shopee não devolveu o produto',
  sem_preco: 'a página não trouxe o preço',
  demorou: 'a loja demorou demais',
  extensao_off: 'a extensão do Chrome não está conectada',
  extensao_antiga: 'a extensão do Chrome precisa ser recarregada',
  ml_verificacao: 'o Mercado Livre pediu verificação no navegador',
  limite_hora: 'o limite de conferências por hora foi atingido',
  varias_versoes: 'o produto tem várias versões e o link não diz qual',
});

/** Falha nomeada de links.requestProduto → chave de CAUSAS (D8). Outra falha → 'loja_fora'. */
const CAUSA_DA_FALHA = Object.freeze({
  desconectada: 'extensao_off',
  antiga: 'extensao_antiga',
  verificacao: 'ml_verificacao',
  limite: 'limite_hora',
  tempo: 'demorou',
  erro: 'loja_fora',
});

/** Oferta que o verificador barrou (a fila lança esta no preparar). `motivo` é chave de MOTIVOS_VERIFICADOR. */
export class OfertaDescartada extends Error {
  constructor(motivo, texto) {
    const m = Object.hasOwn(MOTIVOS_VERIFICADOR, motivo) ? motivo : 'nao_conferido';
    const t = typeof texto === 'string' && texto ? texto : MOTIVOS_VERIFICADOR[m];
    super(t);
    this.name = 'OfertaDescartada';
    this.motivo = m;
    this.texto = t;
  }
}

const FRESCOR_MS = FRESCOR_MIN * 60 * 1000;
const TOLERANCIA_FUTURO_MS = 60 * 1000; // created_at do SQLite tem resolução de segundos
const RE_ASIN = /^[A-Z0-9]{10}$/;
const RE_ID_SHOPEE = /^\d{1,20}$/;

const precoValido = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
const centavos = (v) => Math.round(v * 100);
const causaValida = (c) => (Object.hasOwn(CAUSAS, c) ? c : 'loja_fora');

/** Limite de alta aceito: inteiro de 0 a LIMITE_MAX_PCT; outro valor vira o padrão. */
function limiteValido(v) {
  return Number.isInteger(v) && v >= 0 && v <= LIMITE_MAX_PCT ? v : LIMITE_PADRAO_PCT;
}

/** Os dados da oferta são de até FRESCOR_MIN atrás? Idade desconhecida, ou no futuro além da tolerância, não é. */
function dadosFrescos(lidoEm, agora) {
  if (typeof lidoEm !== 'number' || !Number.isFinite(lidoEm) || typeof agora !== 'number' || !Number.isFinite(agora)) return false;
  const idade = agora - lidoEm;
  return idade >= -TOLERANCIA_FUTURO_MS && idade <= FRESCOR_MS;
}

/**
 * A alta em % para o texto, sem nunca parecer dentro do limite: inteiro quando ele já passa do limite; senão com
 * uma ou duas casas (truncadas), e só em último caso arredondada para cima em duas casas.
 */
function altaTexto(pct, limite) {
  const virgula = (n, casas) => n.toFixed(casas).replace('.', ',');
  const inteiro = Math.round(pct);
  if (inteiro > limite) return String(inteiro);
  for (const casas of [1, 2]) {
    const f = 10 ** casas;
    const v = Math.floor(pct * f) / f;
    if (v > limite) return virgula(v, casas);
  }
  return virgula(Math.ceil(pct * 100) / 100, 2);
}

export function decidir({ leitura, referencia, precoOferta, limitePct, lidoEm, agora, digitado = false } = {}) {
  if (leitura && leitura.disponivel === false) {
    return { acao: 'descartar', motivo: 'esgotado', texto: MOTIVOS_VERIFICADOR.esgotado };
  }
  const semConferencia = (chave) => {
    const causa = CAUSAS[causaValida(chave)];
    if (dadosFrescos(lidoEm, agora)) return { acao: 'enviar', conferido: false, precoNovo: null, sufixo: ` · preço não conferido (${causa})` };
    return { acao: 'descartar', motivo: 'nao_conferido', texto: `${MOTIVOS_VERIFICADOR.nao_conferido} (${causa})` };
  };
  const varias = leitura?.varias === true;
  const atual = precoValido(leitura?.price);
  if (atual == null) return semConferencia(varias ? 'varias_versoes' : leitura?.causa ?? 'sem_preco');
  const ref = precoValido(referencia);
  if (ref == null) return varias ? semConferencia('varias_versoes') : { acao: 'enviar', conferido: true, precoNovo: null, sufixo: null };
  const limite = limiteValido(limitePct);
  const atualC = centavos(atual);
  const refC = centavos(ref);
  // em centavos inteiros: 89,90 × 1,05 em ponto flutuante não é exato
  if (atualC * 100 > refC * (100 + limite)) {
    const alta = altaTexto(((atualC - refC) / refC) * 100, limite);
    return { acao: 'descartar', motivo: 'preco_subiu', texto: `${MOTIVOS_VERIFICADOR.preco_subiu} de ${brl(ref)} para ${brl(atual)} (+${alta}%, o limite é ${limite}%)` };
  }
  // várias versões: até a mais barata passou do limite, ou não dá para saber o preço do anúncio
  if (varias) return semConferencia('varias_versoes');
  const oferta = precoValido(precoOferta);
  if (digitado !== true && oferta != null && centavos(oferta) === refC && atualC !== refC) {
    return { acao: 'enviar', conferido: true, precoNovo: atual, sufixo: ` · preço atualizado de ${brl(ref)} para ${brl(atual)}` };
  }
  return { acao: 'enviar', conferido: true, precoNovo: null, sufixo: null };
}

/** Loja da oferta como o verificador conhece ('ml' do Catálogo = 'mercadolivre'); outra → null. */
function lojaDe(oferta) {
  const l = oferta?.loja;
  if (l === 'ml') return 'mercadolivre';
  return ['mercadolivre', 'amazon', 'shopee', 'magalu'].includes(l) ? l : null;
}

function asinDe(oferta) {
  const direto = typeof oferta.asin === 'string' ? oferta.asin.trim().toUpperCase() : '';
  if (RE_ASIN.test(direto)) return direto;
  const m = /^ASIN:([A-Z0-9]{10})$/.exec(String(oferta.key ?? ''));
  return m ? m[1] : null;
}

function idsShopee(oferta) {
  const texto = (v) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? String(v) : typeof v === 'string' ? v.trim() : '');
  const shopId = texto(oferta.shopId ?? oferta.shop_id);
  const itemId = texto(oferta.itemId ?? oferta.item_id);
  if (RE_ID_SHOPEE.test(shopId) && RE_ID_SHOPEE.test(itemId)) return { shopId, itemId };
  const m = /^SHOPEE:(\d{1,20})\.(\d{1,20})$/.exec(String(oferta.key ?? ''));
  return m ? { shopId: m[1], itemId: m[2] } : null;
}

/** O anúncio que a oferta do ML conhece (`MLB…`): `item_id`/`itemId` do payload ou a chave (o `metadata.id` da Central). */
function itemDaOferta(oferta) {
  for (const v of [oferta.item_id, oferta.itemId, oferta.key]) if (typeof v === 'string' && /^MLB\d{6,20}$/.test(v)) return v;
  return null;
}

/** Leitura do ML ({ price, disponivel, varias? }) só com número válido, estoque booleano e `varias` só se for true. */
const leituraMl = (r) => ({
  price: precoValido(r?.price), disponivel: r?.disponivel === true || r?.disponivel === false ? r.disponivel : null,
  ...(r?.varias === true ? { varias: true } : {}),
});

const SEM_API_AMAZON = new Set(['sem_credenciais', 'sem_tag', 'credenciais_invalidas', 'sem_acesso', 'tag_invalida']);
const SEM_API_SHOPEE = new Set(['sem_credenciais', 'credencial_recusada', 'sem_acesso', 'conta_restrita']);

/** Causa de uma exceção do leitor: só pelo nome e pelo tipo fixo do erro, nunca pela mensagem. */
function causaDoErro(loja, e) {
  if (loja === 'amazon' && e?.name === 'ErroAmazon' && SEM_API_AMAZON.has(e.tipo)) return 'amazon_sem_api';
  if (loja === 'shopee' && e?.name === 'ErroShopee' && SEM_API_SHOPEE.has(e.tipo)) return 'shopee_sem_api';
  return 'loja_fora';
}

export function createVerificador({ db, ml = mlPadrao, amazon = null, shopee = null, links = null, simulado = false, agora = Date.now, tempoMaxMs = TEMPO_MAX_MS } = {}) {
  const prazo = typeof tempoMaxMs === 'number' && Number.isFinite(tempoMaxMs) && tempoMaxMs > 0 ? tempoMaxMs : TEMPO_MAX_MS;

  function ativo() {
    if (!db) return true;
    return getSetting(db, 'verificador_ativo') !== '0';
  }

  function limitePct() {
    if (!db) return LIMITE_PADRAO_PCT;
    const v = getSetting(db, 'verificador_limite_pct');
    return typeof v === 'string' && /^\d{1,2}$/.test(v) ? limiteValido(Number(v)) : LIMITE_PADRAO_PCT;
  }

  const amazonLiga = () => !!amazon && (typeof amazon.configurado !== 'function' || amazon.configurado());
  const shopeeLiga = () => !!shopee && (typeof shopee.apiUtil === 'function' ? shopee.apiUtil() : typeof shopee.configurado === 'function' ? shopee.configurado() : true);

  /**
   * Esta loja tem como ser conferida agora? Magalu nunca; ML sempre (a leitura em si pode falhar); Amazon e Shopee só
   * com a API ligada (na simulação, sempre). Serve ao Disparo manual, que recusa o agendamento distante de quem nunca
   * será conferido: o descarte pela regra do frescor seria certo.
   */
  function podeConferir(loja) {
    const l = lojaDe({ loja });
    if (!l || l === 'magalu') return false;
    if (l === 'mercadolivre' || simulado) return true;
    return l === 'amazon' ? amazonLiga() : shopeeLiga();
  }

  /** O ML é lido pela extensão (modo de link 'extension')? Nesse modo o servidor nunca lê o ML (D5). */
  const mlPelaExtensao = () => typeof links?.modo === 'function' && links.modo() === 'extension';

  /** Leitura do ML pela extensão. → { price, disponivel, varias? } | { causa }. */
  async function lerMlPelaExtensao(oferta) {
    const url = urlProdutoML(oferta.url, { item: itemDaOferta(oferta) });
    if (!url) return { causa: 'loja_fora' };
    const r = await links.requestProduto({ url });
    if (!r || typeof r !== 'object') return { causa: 'loja_fora' };
    if (Object.hasOwn(r, 'falha')) {
      return { causa: typeof r.falha === 'string' && Object.hasOwn(CAUSA_DA_FALHA, r.falha) ? CAUSA_DA_FALHA[r.falha] : 'loja_fora' };
    }
    return leituraMl(r);
  }

  /** Lê a loja. → { price, disponivel, discountPct? } | { causa }. Pode lançar (o lerComPrazo trata). */
  async function lerLoja(loja, oferta) {
    if (loja === 'magalu') return { causa: 'magalu' };
    if (loja === 'mercadolivre') {
      if (mlPelaExtensao()) return lerMlPelaExtensao(oferta);
      return leituraMl(await ml.conferirProduto(oferta.url));
    }
    if (loja === 'amazon') {
      if (!amazonLiga()) return { causa: 'amazon_sem_api' };
      const asin = asinDe(oferta);
      if (!asin) return { causa: 'sem_preco' };
      const o = await amazon.lerItem(asin, { fresco: true });
      if (!o) return { causa: 'sem_preco' };
      return { price: precoValido(o.price), disponivel: o.disponivel === true || o.disponivel === false ? o.disponivel : null, discountPct: o.discountPct, oldPrice: precoValido(o.oldPrice) };
    }
    if (loja === 'shopee') {
      if (!shopeeLiga()) return { causa: 'shopee_sem_api' };
      const ids = idsShopee(oferta);
      if (!ids) return { causa: 'shopee_sem_produto' };
      const o = await shopee.lerItem(ids.shopId, ids.itemId, { fresco: true });
      if (!o) return { causa: 'shopee_sem_produto' };
      // a API de afiliados não informa estoque: só o preço é conferido
      return { price: precoValido(o.price), disponivel: null, discountPct: o.discountPct };
    }
    return { causa: 'loja_fora' };
  }

  /** lerLoja com o teto de `prazo` ms. Nunca rejeita: erro e demora viram { causa }. */
  async function lerComPrazo(loja, oferta) {
    let timer = null;
    const limite = new Promise((resolve) => { timer = setTimeout(() => resolve({ causa: 'demorou' }), prazo); });
    // o .catch fica na própria promessa: se ela perder a corrida e falhar depois, não sobra rejeição sem tratamento
    const leitura = Promise.resolve().then(() => lerLoja(loja, oferta)).catch((e) => {
      console.error(`[verificador] conferência sem resposta (${loja}):`, e?.name || 'erro');
      return { causa: causaDoErro(loja, e) };
    });
    try { return await Promise.race([leitura, limite]); } finally { clearTimeout(timer); }
  }

  /** A oferta que sai: cópia, sem `vistoEm` herdado; com preço novo, o preço antigo só fica se ainda for maior. */
  function ofertaQueSai(oferta, decisao, leitura, instante) {
    const { vistoEm: _antigo, ...copia } = oferta;
    if (!decisao.conferido) return copia;
    copia.vistoEm = instante;
    if (decisao.precoNovo != null) {
      const atual = decisao.precoNovo;
      // o preço antigo que a loja acabou de informar (Amazon) vale mais que o gravado; sem ele, o da oferta
      const antigo = precoValido(leitura?.oldPrice) ?? precoValido(oferta.oldPrice);
      copia.price = atual;
      copia.oldPrice = antigo != null && antigo > atual ? antigo : null;
      // sem preço antigo (Shopee, Amazon sem "de"), o desconto da leitura de agora; senão a conta pelo preço antigo
      const daLoja = leitura?.discountPct;
      copia.discountPct = copia.oldPrice != null ? calcularDesconto(atual, copia.oldPrice)
        : Number.isInteger(daLoja) && daLoja >= 1 && daLoja <= 99 ? daLoja : 0;
    }
    return copia;
  }

  async function conferir(oferta, { lidoEm = null, referencia } = {}) {
    try {
      if (!oferta || typeof oferta !== 'object') {
        return { acao: 'descartar', motivo: 'nao_conferido', texto: `${MOTIVOS_VERIFICADOR.nao_conferido} (${CAUSAS.loja_fora})` };
      }
      if (!ativo()) {
        const { vistoEm: _antigo, ...copia } = oferta;
        return { acao: 'enviar', oferta: copia, conferido: false, sufixo: null };
      }
      const loja = lojaDe(oferta);
      if (simulado && loja && loja !== 'magalu') {
        return { acao: 'enviar', oferta: { ...oferta, vistoEm: agora() }, conferido: true, sufixo: null };
      }
      const leitura = loja ? await lerComPrazo(loja, oferta) : { causa: 'loja_fora' };
      const instante = agora();
      const decisao = decidir({
        leitura, referencia: referencia ?? oferta.price, precoOferta: oferta.price, limitePct: limitePct(),
        lidoEm, agora: instante, digitado: oferta.digitado === true,
      });
      if (decisao.acao === 'descartar') return { acao: 'descartar', motivo: decisao.motivo, texto: decisao.texto };
      return { acao: 'enviar', oferta: ofertaQueSai(oferta, decisao, leitura, instante), conferido: decisao.conferido, sufixo: decisao.sufixo };
    } catch (e) {
      // defesa (ex.: o banco falhou ao ler os Ajustes): vale a regra de quem não conferiu, a do frescor
      console.error('[verificador] falha inesperada:', e?.name || 'erro');
      let instante = null;
      try { instante = agora(); } catch { instante = Date.now(); }
      const decisao = decidir({ leitura: { causa: 'loja_fora' }, lidoEm, agora: instante });
      if (decisao.acao === 'descartar') return { acao: 'descartar', motivo: decisao.motivo, texto: decisao.texto };
      const { vistoEm: _antigo, ...copia } = oferta;
      return { acao: 'enviar', oferta: copia, conferido: false, sufixo: decisao.sufixo };
    }
  }

  return { ativo, limitePct, conferir, podeConferir };
}
