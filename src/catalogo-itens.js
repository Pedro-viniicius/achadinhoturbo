// Fonte "catalogo" (plano fonte-catalogo-etiqueta, D1, D5 e D6; ADR-004): o que já foi tratado em cada regra e a
// fila de revisão do Dono.
//
// Tabela `catalogo_itens` (src/db.js): uma linha por (regra, chave). Chave Turbo: ML `MLB<n>`, Amazon `ASIN:<ASIN>`,
// Shopee `SHOPEE:<shop>.<item>`; a loja (`ml` | `amazon` | `shopee`) sai da chave, nunca do que veio de fora.
// status: 'revisao' (espera o Dono), 'enviado' (saiu sozinho pela regra ou pela revisão) e 'descartado'.
//
// Contrato com o agendador (etapa 4) e com src/catalogo.js (etapa 1). O candidato `c` que chega a tratada() e
// registrar() é o de `paraCandidato`: { key, title, price, oldPrice, discountPct, sold, freeShipping, coupon, image,
// link? (só Shopee: o link do catálogo), categoria, tag_id, source_index }. `url`, `asin` e `loja` do candidato são
// ignorados: a URL e o ASIN guardados são remontados da chave (ML `https://produto.mercadolivre.com.br/MLB-<n>`,
// Amazon `https://www.amazon.com.br/dp/<ASIN>`), e a foto só fica se for do CDN da própria loja.
//
// Envio aprovado (o "Enviar" da revisão, só do Dono): grava a linha de `envios` direto (tipo 'oferta', quando
// 'agora', pendente vencido) com o payload que `preparar('oferta')` de src/envios.js entende, com
// origem:{ tipo:'catalogo', rule_id, nome }. Na mesma transação (BEGIN IMMEDIATE) o item vira 'enviado' com o
// envio_id e a chave entra em `sent_offers` (reserva enquanto o envio está na fila); quem chegar depois recebe 409
// "Esta oferta já foi tratada.".
// Envio aprovado que termina (concluido, erro ou cancelado) sem NENHUM grupo ok (R3): a oferta não fica "queimada".
// liberarFalhos() (o agendador chama depois de cada passada da fila e no começo de cada regra) tira a reserva de
// `sent_offers` e, na mesma transação, devolve o item à revisão (CA2.8 do plano rodar-sozinho-entrega2: `decidido_em`
// NULL, `envio_id` mantido); a lista diz `ultimo_envio_falhou` e os erros por grupo. Até ele passar, o item segue
// 'enviado' com `pode_reenviar: true` e o "Enviar" aceita o item de novo (mesma trava, mesmo 409, mesmas regras de preço).
// "Enviar" de oferta do ML com o Mercado Livre em espera (links.central().estado 'em_espera', src/links.js) recusa com
// frase fixa, sem gravar nada: o link sairia da fila só para ser recusado pela espera.
// Nenhum link comum (CA4): ML só com links em modo extensão/simulação e etiqueta; Amazon só com a tag de Conexões
// (o link é montado na hora do envio); Shopee só com o link do catálogo conferido por LINK_SHOPEE.
// Rastreio por grupo (plano dashboard-ganhos, etapa 7): ML e Amazon seguem o código de cada grupo no envio
// (src/envios.js). Na Shopee, o link do catálogo é o base e, se algum grupo da regra tem Sub_id (por bloco), o
// "Enviar" pede os links com Sub_id à fila de envios (envios.linksRastreioShopee) e guarda em `links_rastreio`.
// Preço suspeito (CA7, decisão P4 do dono): sem "Enviar mesmo com 100%". Depois dos ajustes, desconto de 100% ou
// preço antigo ≥ 10× o preço recusa com frase fixa.
// Produto igual ou parecido (plano nao-repetir-produto-parecido, etapa 5; CA4–CA7): com "dias sem repetir" > 0, o
// "Enviar" passa pela trava de src/parecido.js DENTRO da transação, comparando o título e o preço da oferta já com os
// ajustes contra o que já está gravado em `sent_offers` na janela (outra chave). Dois "Enviar" de parecidas não passam
// juntos, nem um "Enviar" depois do que a regra já gravou. A rodada da regra em andamento só grava a reserva depois
// de mandar aos grupos: o agendador entrega as ofertas que ela escolheu (usarEmEnvio, desde a escolha de cada uma) e a
// mesma oferta ou a parecida com uma delas recebe 409 "…que está saindo agora…", com qualquer "dias sem repetir" e
// mesmo mais barata (achados Q1 e R1).
// Barrada → 409 com a frase "Não enviada: …". Liberada por ser o mesmo título pelo menos DESCONTO_MINIMO_MAIS_BARATA%
// mais barato, sem parecida nas últimas 24 h (adendo do plano, D10/D11) → o payload leva
// `mais_barata: { preco_anterior }` (centavos) e, só para o texto do Histórico, `parecida_anterior: { titulo,
// enviada_em }`; a fila confere o preço de novo, põe a frase na mensagem e, se a oferta sair em algum grupo, escreve
// a linha "Saiu como oportunidade melhor: …" (src/envios.js). A reserva em `sent_offers` guarda título e preço (centavos).
//
// Privacidade: nada aqui é dado pessoal (ofertas e nomes de regra e de grupo). Erro inesperado do banco não vai à
// resposta nem ao console com a mensagem (ela pode trazer valores da query).

import { addLog, parseRule } from './db.js';
import { imagemPermitida } from './lojas.js';
import { LINK_SHOPEE } from './shopee.js';
import { discountPct } from './template.js';
import { emCentavos } from './catalogo.js';
import { validarAjustesOferta } from './espelho.js';
import { centavos, criarTrava, lerEnviados, textoConflito, tituloParaGuardar } from './parecido.js';

const DIA = 86400000;
export const TETO_REVISAO = 50;             // pendentes por regra (P5): acima, as novas esperam sem entrar
// `falha_link` e `nao_conferido` só para ler itens antigos (as migrações de src/db.js tiraram os que estavam só por eles);
// `queda_preco` (preço conferido muito abaixo da lista) e `falhas_repetidas` (3ª falha do ML) são da entrega 2
export const MOTIVOS = Object.freeze(['shopee', 'desconto_100', 'preco_antigo', 'falha_link', 'nao_conferido', 'queda_preco', 'falhas_repetidas']);
const STATUS = ['revisao', 'enviado', 'descartado'];
// motivos do verificador que descartam a oferta do catálogo (o `nao_conferido` nunca descarta). `indisponivel` e
// `outro_produto` vêm da releitura da Amazon pelo Etiqueta (plano rodar-sozinho-entrega1). O `nao_conferido` segue em
// MOTIVOS só para ler itens antigos: a migração de src/db.js tira da revisão os que estavam só por ele.
// `recusada_ml`: o Mercado Livre recusou gerar o link (anúncio pausado ou inativo; rodar-sozinho entrega 2, CA2.2)
const DESCARTE_VERIFICADOR = ['esgotado', 'preco_subiu', 'indisponivel', 'outro_produto', 'recusada_ml'];
/** Queda do preço em % (rodar-sozinho entrega 2, CA2.11) que vale para a tela: inteiro de 1 a 99; senão null. */
const quedaValida = (v) => (Number.isInteger(v) && v >= 1 && v <= 99 ? v : null);
const ORDEM_NOVIDADES = 'atualizacao';      // a ordem "Novidades" do contrato: oferta tratada nunca sai de novo
const LIMITE_PADRAO = 100;
const LIMITE_MAX = 200;
const MAX_NOME = 80;
const MAX_TITULO = 200;
const MAX_CUPOM_GUARDADO = 100;              // o que vem do catálogo e o que o "Revisar oferta" deixa digitar (R5)
const MAX_CATEGORIA = 200;
const MAX_URL = 2048;
const MAX_GRUPOS = 500;
const PRECO_MAX = 10_000_000;
const SONDA_ASIN = 'B000000000';             // montarLink com um ASIN de sonda diz se há tag salva, sem rede
const ENVIO_ATIVO = ['pendente', 'enviando', 'pausado'];
const ENVIO_FIM = ['concluido', 'erro', 'cancelado'];
// o envio (alias v) terminou sem nenhum grupo ok: a oferta aprovada pode sair de novo (R3)
const SQL_ENVIO_FALHOU = `v.status IN ('concluido','erro','cancelado') AND NOT EXISTS (SELECT 1 FROM envio_resultados r WHERE r.envio_id = v.id AND r.ok = 1)`;
const MAX_MOTIVO_ENVIO = 200;

const RE_ML = /^MLB(\d{1,20})$/;
const RE_AMAZON = /^ASIN:([A-Z0-9]{10})$/;
const RE_SHOPEE = /^SHOPEE:(\d{1,20})\.(\d{1,20})$/;
/** loja da tabela → id de src/lojas.js (o que `preparar` e `imagemPermitida` entendem). */
const LOJA_ID = Object.freeze({ ml: 'mercadolivre', amazon: 'amazon', shopee: 'shopee' });

const JA_TRATADA = 'Esta oferta já foi tratada.';
const PRECO_SUSPEITO = 'Corrija o preço ou apague o preço antigo para enviar.';
const LINK_SHOPEE_FORA = 'O link da Shopee desta oferta está fora do esperado. Descarte a oferta.';
const ML_DIRETO = 'Os links do Mercado Livre estão no modo direto, sem comissão: ofertas do catálogo não saem assim. Volte ao modo da extensão em Ajustes.';
const ML_SEM_EXTENSAO = 'A extensão do Chrome não está conectada: abra o Chrome com a extensão para gerar o link de afiliado.';
const ML_EM_ESPERA = 'O Mercado Livre está em espera: a Central de Afiliados não está respondendo. O programa testa de novo sozinho; envie quando ela voltar.';
const SEM_ETIQUETA = 'A etiqueta desta oferta foi apagada. Escolha uma etiqueta na regra.';
const SEM_AMAZON = 'A integração com a Amazon não está disponível neste servidor.';
const SEM_TAG = 'Falta a tag de associado da Amazon. Cadastre em Conexões → Amazon antes de enviar.';

/**
 * Erro com status HTTP (montarRotas responde com ele). A mensagem é fixa, nunca com dado de fora; a exceção é o 409 de
 * produto igual ou parecido, montado pelas frases de src/parecido.js com o título de uma oferta (texto do catálogo,
 * cortado em 60, sem dado pessoal).
 */
export class ErroCatalogoItem extends Error {
  constructor(status, mensagem) {
    super(mensagem);
    this.name = 'ErroCatalogoItem';
    this.status = status;
  }
}

const lerJson = (txt, padrao) => { try { return JSON.parse(txt) ?? padrao; } catch { return padrao; } };
const listaDeTexto = (txt) => { const l = lerJson(txt, []); return Array.isArray(l) ? l.filter((x) => typeof x === 'string') : []; };

/** Chave Turbo → { loja, url, asin?, shopId?, itemId? }, ou null se a chave não fecha. */
export function lerChave(chave) {
  const k = typeof chave === 'string' ? chave : '';
  let m = RE_ML.exec(k);
  if (m) return { loja: 'ml', url: `https://produto.mercadolivre.com.br/MLB-${m[1]}` };
  m = RE_AMAZON.exec(k);
  if (m) return { loja: 'amazon', url: `https://www.amazon.com.br/dp/${m[1]}`, asin: m[1] };
  m = RE_SHOPEE.exec(k);
  if (m) return { loja: 'shopee', url: `https://shopee.com.br/product/${m[1]}/${m[2]}`, shopId: m[1], itemId: m[2] };
  return null;
}

/**
 * A oferta tem preço suspeito (CA7)? Desconto de 100% (ou mais) ou preço antigo ≥ 10× o preço, comparados em
 * centavos inteiros (Q6). A mesma conta vale para os motivos da revisão (src/catalogo.js) e para o "Enviar" (aqui),
 * sempre sobre a oferta já com os ajustes.
 */
export function precoSuspeito(o) {
  const pct = Number(o?.discountPct);
  if (Number.isFinite(pct) && pct >= 100) return true;
  const preco = emCentavos(o?.price); const antigo = emCentavos(o?.oldPrice);
  return preco != null && antigo != null && preco > 0 && antigo >= 10 * preco;
}

const numeroPositivo = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= PRECO_MAX ? Math.round(v * 100) / 100 : null);
const textoGuardado = (v, max) => (typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim().slice(0, max) : null);
const inteiroOuNulo = (v, min = 0) => (Number.isInteger(v) && v >= min ? v : null);

/**
 * Oferta para o banco (JSON de `catalogo_itens.oferta`): só os campos do template e da tela, com tamanho e tipo.
 * url e asin vêm da chave; foto só do CDN da loja; link só na Shopee (texto até 2048; conferido no envio).
 */
function ofertaParaGuardar(c, info) {
  const pct = c?.discountPct;
  return {
    title: textoGuardado(c?.title, MAX_TITULO),
    price: numeroPositivo(c?.price),
    oldPrice: numeroPositivo(c?.oldPrice),
    discountPct: typeof pct === 'number' && Number.isFinite(pct) && pct > 0 ? Math.min(Math.round(pct), 100) : null,
    sold: inteiroOuNulo(c?.sold),
    freeShipping: c?.freeShipping === true,
    coupon: textoGuardado(c?.coupon, MAX_CUPOM_GUARDADO),
    image: imagemPermitida(LOJA_ID[info.loja], c?.image) ? c.image : null,
    url: info.url,
    ...(info.asin ? { asin: info.asin } : {}),
    ...(info.loja === 'shopee' ? { link: typeof c?.link === 'string' && c.link.length <= MAX_URL ? c.link.trim() : null } : {}),
    categoria: textoGuardado(c?.categoria, MAX_CATEGORIA),
    tag_id: inteiroOuNulo(c?.tag_id, 1),
    source_index: inteiroOuNulo(c?.source_index),
  };
}

/**
 * Oferta guardada com os ajustes por cima (como o "Completar" do espelho): preço antigo só se maior que o atual. O
 * desconto que o catálogo informou só vale entre 1% e 99% e com os preços intactos (a mesma regra do `dadosOferta`
 * do painel); fora disso, ele é refeito dos preços. Assim um "100%" informado nunca sai na mensagem.
 */
function aplicarAjustes(base, a) {
  const o = { ...base };
  for (const k of ['title', 'price', 'oldPrice', 'coupon', 'freeShipping']) if (Object.hasOwn(a, k)) o[k] = a[k];
  if (o.oldPrice != null && (o.price == null || o.oldPrice <= o.price)) o.oldPrice = null;
  const intacto = o.price === base.price && o.oldPrice === base.oldPrice;
  const informado = Number(base.discountPct);
  o.discountPct = intacto && Number.isFinite(informado) && informado > 0 && informado < 100 ? informado : discountPct(o.price, o.oldPrice) || null;
  if (a.sem_foto || a.upload) o.image = null;
  return o;
}

/**
 * Fila de revisão e registro do que o catálogo já tratou. `wa`: o WhatsApp (isReady); `links`: o serviço de links
 * (modo e status da extensão); `amazon`: o cliente da Amazon (montarLink, para saber se há tag); `envios`: a fila de
 * src/envios.js (lerFoto e, sem `acordar`, processarPendentes); `acordar`: pede um tick do agendador (é por ele que
 * o envio aprovado sai); `agora`: relógio (testes).
 * → { tratada, registrar, revisaoCheia, listar, enviar, descartar, contar, liberarFalhos, usarEmEnvio }
 */
export function createCatalogoItens({ db, wa = null, links = null, amazon = null, envios = null, acordar = null, agora = Date.now } = {}) {
  const regraPorId = (id) => parseRule(db.prepare('SELECT * FROM rules WHERE id = ?').get(id));
  const grupoExiste = (jid) => !!db.prepare('SELECT 1 FROM groups WHERE jid = ?').get(jid);
  const nomeDaRegra = (nome) => String(nome ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NOME) || 'sem nome';
  const log = (regra, o) => addLog(db, { rule: { id: null, name: `Catálogo: ${nomeDaRegra(regra?.name)}` }, ...o });

  // ofertas que a execução em andamento de cada regra escolheu e ainda não gravou em `sent_offers`: o agendador,
  // criado depois, liga a leitura dele por usarEmEnvio (sem agendador, nenhuma)
  let emEnvio = null;
  function usarEmEnvio(fn) { emEnvio = typeof fn === 'function' ? fn : null; }
  /** → [{ key, title }] da execução em andamento da regra; nunca lança (lista em memória). */
  function saindoNaRegra(ruleId) {
    let lista = [];
    try { lista = emEnvio ? emEnvio(ruleId) : []; } catch (e) { console.error('[catalogo] ofertas em envio:', e?.name || 'erro'); }
    return (Array.isArray(lista) ? lista : []).filter((o) => o && typeof o.title === 'string');
  }

  function pedirEnvio() {
    if (acordar) { acordar(); return; }
    envios?.processarPendentes?.().catch((e) => console.error('[catalogo] fila de envios:', e?.name || 'erro'));
  }

  function transacao(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  /** Há tag de associado da Amazon salva? (montarLink com o ASIN de sonda, sem rede) */
  function temTagAmazon() {
    if (!amazon?.montarLink) return false;
    try { return !!amazon.montarLink(SONDA_ASIN); } catch { return false; }
  }

  // ------------------------------------------------------------------------------------------- regra (agendador)

  /**
   * A oferta já foi tratada nesta regra (D6)? `modo` é a ordem da fonte (`config.ordem`).
   * - "Novidades" (`atualizacao`): qualquer linha em `catalogo_itens` ou em `sent_offers`, sem janela (nem com
   *   "dias sem repetir" = 0): a oferta tratada nunca sai de novo.
   * - Outras ordens: linha 'revisao' ou 'descartado' bloqueia; o envio vale pela janela da regra (`dedupe_days`,
   *   0 = repete), como `wasSent` do agendador.
   * Candidato sem chave válida conta como tratado (não há o que fazer com ele).
   */
  function tratada(rule, c, modo) {
    const chave = c?.key;
    if (!Number.isInteger(rule?.id) || !lerChave(chave)) return true;
    const linha = db.prepare('SELECT status FROM catalogo_itens WHERE rule_id = ? AND chave = ?').get(rule.id, chave);
    if (modo === ORDEM_NOVIDADES) {
      return !!linha || !!db.prepare('SELECT 1 FROM sent_offers WHERE rule_id = ? AND offer_key = ? LIMIT 1').get(rule.id, chave);
    }
    if (linha && linha.status !== 'enviado') return true;
    const dias = Number(rule.dedupe_days);
    if (!(dias > 0)) return false;
    return !!db.prepare('SELECT 1 FROM sent_offers WHERE rule_id = ? AND offer_key = ? AND sent_at > ? LIMIT 1').get(rule.id, chave, agora() - dias * DIA);
  }

  /** A regra já tem TETO_REVISAO ofertas esperando revisão? */
  function revisaoCheia(ruleId) {
    return pendentesDe(ruleId) >= TETO_REVISAO;
  }
  const pendentesDe = (ruleId) => Number(db.prepare("SELECT COUNT(*) AS n FROM catalogo_itens WHERE rule_id = ? AND status = 'revisao'").get(ruleId)?.n) || 0;

  /**
   * Grava (upsert por regra e chave) o que a regra fez com a oferta: 'revisao' (com ao menos um motivo de MOTIVOS),
   * 'enviado' ou 'descartado'. Não mexe em `sent_offers` (o envio da regra já grava lá).
   * Nunca sobrescreve um item que ainda espera revisão (quem decide é o Dono) e não passa do teto de revisão.
   * `descartadoPor` (só com 'descartado'): 'esgotado', 'preco_subiu', 'indisponivel' ou 'outro_produto' (de
   * MOTIVOS_VERIFICADOR) quando foi o verificador que barrou a oferta, ou 'recusada_ml' quando o Mercado Livre recusou
   * gerar o link (DESCARTE_VERIFICADOR); fica em `oferta.descartado_por` e volta em
   * `listar` (a tela diz o porquê). `quedaPct` (só com 'revisao' e o motivo `queda_preco`): quanto o preço conferido
   * ficou abaixo do da lista, inteiro de 1 a 99 (fora disso não é guardado); fica em `oferta.queda_pct` e volta em `listar`.
   * → true se gravou; false se a entrada não fecha (regra, chave, título, preço, status, motivos), se a revisão da
   * regra está cheia ou se o item está em revisão.
   */
  function registrar(rule, c, status, motivos = [], { descartadoPor = null, quedaPct = null } = {}) {
    const info = lerChave(c?.key);
    if (!Number.isInteger(rule?.id) || rule.id <= 0 || !info || !STATUS.includes(status)) return false;
    const lista = [...new Set(Array.isArray(motivos) ? motivos.filter((m) => MOTIVOS.includes(m)) : [])];
    if (status === 'revisao' && !lista.length) return false;
    const oferta = ofertaParaGuardar(c, info);
    if (!oferta.title || oferta.price == null) return false;
    if (status === 'descartado' && DESCARTE_VERIFICADOR.includes(descartadoPor)) oferta.descartado_por = descartadoPor;
    if (status === 'revisao' && lista.includes('queda_preco') && quedaValida(quedaPct) != null) oferta.queda_pct = quedaPct;
    if (status === 'revisao' && revisaoCheia(rule.id)) return false;
    const now = agora();
    const r = db.prepare(`INSERT INTO catalogo_itens (rule_id, chave, loja, status, motivos, oferta, envio_id, criado_em, decidido_em)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
      ON CONFLICT (rule_id, chave) DO UPDATE SET loja = excluded.loja, status = excluded.status, motivos = excluded.motivos,
        oferta = excluded.oferta, envio_id = NULL, criado_em = excluded.criado_em, decidido_em = excluded.decidido_em
      WHERE catalogo_itens.status != 'revisao'`)
      .run(rule.id, c.key, info.loja, status, JSON.stringify(lista), JSON.stringify(oferta), now, status === 'revisao' ? null : now);
    return r.changes === 1;
  }

  // ------------------------------------------------------------------------------------------- listagem

  function idValido(id, msg = 'Oferta não encontrada.') {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) throw new ErroCatalogoItem(404, msg);
    return n;
  }

  /** O envio aprovado `envioId` terminou sem nenhum grupo ok (R3)? Envio já apagado pela retenção: não se sabe → false. */
  function envioFalhou(envioId) {
    if (!Number.isInteger(envioId)) return false;
    return !!db.prepare(`SELECT 1 FROM envios v WHERE v.id = ? AND ${SQL_ENVIO_FALHOU}`).get(envioId);
  }

  const SQL_FALHOS = `SELECT i.id, i.rule_id, i.chave, i.envio_id, i.decidido_em FROM catalogo_itens i JOIN envios v ON v.id = i.envio_id
      WHERE i.status = 'enviado' AND i.envio_id IS NOT NULL AND ${SQL_ENVIO_FALHOU}`;

  /**
   * Envios aprovados que terminaram sem nenhum grupo ok (R3, CA2.8): tira de `sent_offers` a reserva (a linha que o
   * "Enviar" gravou: mesma regra, chave e instante) e devolve o item à revisão (`decidido_em` NULL, `envio_id` mantido
   * para a lista mostrar os erros), tudo numa transação só: ou os dois, ou nenhum. A oferta volta a valer no "dias sem
   * repetir" e o Dono decide de novo. Envio já apagado pela retenção: não se sabe, o item fica. Idempotente.
   * → quantos itens voltaram à revisão.
   */
  function liberarFalhos() {
    if (!db.prepare(`${SQL_FALHOS} LIMIT 1`).get()) return 0; // o caso comum (a cada tick): sem abrir transação
    return transacao(() => {
      const apagar = db.prepare('DELETE FROM sent_offers WHERE rule_id = ? AND offer_key = ? AND sent_at = ?');
      const devolver = db.prepare("UPDATE catalogo_itens SET status = 'revisao', decidido_em = NULL WHERE id = ? AND status = 'enviado' AND envio_id = ?");
      let n = 0;
      for (const l of db.prepare(SQL_FALHOS).all()) {
        if (l.decidido_em != null) apagar.run(l.rule_id, l.chave, l.decidido_em);
        n += Number(devolver.run(l.id, l.envio_id).changes);
      }
      return n;
    });
  }

  /** Pendentes por regra (só as que têm algum): [{ rule_id, regra, para_revisar, cheia }] e o total. */
  function contar() {
    const regras = db.prepare(`SELECT i.rule_id, r.name AS regra, COUNT(*) AS n FROM catalogo_itens i LEFT JOIN rules r ON r.id = i.rule_id
      WHERE i.status = 'revisao' GROUP BY i.rule_id ORDER BY i.rule_id`).all()
      .map((l) => ({ rule_id: l.rule_id, regra: l.regra ?? null, para_revisar: Number(l.n) || 0, cheia: Number(l.n) >= TETO_REVISAO }));
    return { para_revisar: regras.reduce((s, r) => s + r.para_revisar, 0), teto_revisao: TETO_REVISAO, regras };
  }

  /** Motivo de um envio encerrado para os grupos que ele não tentou (o da fila de envios, já sem dado de fora). */
  function motivoDoEnvio(status, resultado) {
    const m = lerJson(resultado, {})?.motivo;
    if (typeof m === 'string' && m.trim()) return m.trim().slice(0, MAX_MOTIVO_ENVIO);
    return status === 'cancelado' ? 'o envio foi cancelado' : 'não foi enviado';
  }

  /** Link para conferir na revisão (spec, item 10): ML página do produto, Amazon /dp/<ASIN> sem tag, Shopee o do catálogo. */
  const linkParaConferir = (info, o) => (info.loja === 'shopee' ? (typeof o.link === 'string' ? o.link : null) : info.url);

  /**
   * GET /api/catalogo/itens?regra=&status=revisao|enviado|descartado|todos&limite=&antes= → { itens, proximo,
   * contadores_24h, regras, para_revisar, teto_revisao }. Itens do mais recente para o mais antigo (decisão ou
   * criação, depois o id). Paginação (R12): `antes=<ts>:<id>` traz só os que vêm depois desse par na ordem;
   * `proximo` é o par do último item devolvido quando há mais, senão null.
   * `grupos`: os do envio, com ok true/false (null enquanto ele está na fila); para o item em revisão, os grupos da
   * regra (ok null), que é para onde o "Enviar" manda. `pode_reenviar`: item 'enviado' pela revisão cujo envio
   * terminou (erro, cancelado ou concluído) sem nenhum grupo ok; o "Enviar" aceita de novo (R3). `ultimo_envio_falhou`
   * (CA2.8): o envio do item (`envio_id`) terminou sem nenhum grupo ok, seja o item 'enviado' (antes do liberarFalhos)
   * ou de volta à revisão; `ultimo_envio_erros`: [{ nome, erro }] dos grupos desse envio (vazio quando não falhou ou o
   * envio já foi apagado pela retenção). `contadores_24h`:
   * enviadas e descartadas nas últimas 24 h e todas as que esperam revisão (a fila não vence), com o filtro de regra
   * se houver.
   */
  function listar(q = {}) {
    const filtros = []; const args = [];
    let ruleId = null;
    if (q.regra != null && q.regra !== '') { ruleId = idValido(q.regra, 'Regra não encontrada.'); filtros.push('i.rule_id = ?'); args.push(ruleId); }
    const status = q.status == null || q.status === '' ? 'todos' : String(q.status);
    if (STATUS.includes(status)) { filtros.push('i.status = ?'); args.push(status); }
    else if (status !== 'todos') throw new ErroCatalogoItem(400, 'Filtro inválido: use revisao, enviado, descartado ou todos.');
    const lim = Math.min(Math.max(Number.parseInt(q.limite, 10) || LIMITE_PADRAO, 1), LIMITE_MAX);
    if (q.antes != null && q.antes !== '') {
      const m = /^(\d{1,16}):(\d{1,16})$/.exec(String(q.antes));
      if (!m) throw new ErroCatalogoItem(400, 'Paginação inválida: use antes=<instante>:<id>.');
      const ts = Number(m[1]); const idAntes = Number(m[2]);
      filtros.push('(COALESCE(i.decidido_em, i.criado_em) < ? OR (COALESCE(i.decidido_em, i.criado_em) = ? AND i.id < ?))');
      args.push(ts, ts, idAntes);
    }
    // um a mais que o limite: diz se há próxima página
    const lidas = db.prepare(`SELECT i.*, r.name AS regra, r.group_jids AS regra_grupos, v.group_jids AS envio_grupos, v.status AS envio_status,
        v.resultado AS envio_resultado
      FROM catalogo_itens i LEFT JOIN rules r ON r.id = i.rule_id LEFT JOIN envios v ON v.id = i.envio_id
      ${filtros.length ? `WHERE ${filtros.join(' AND ')}` : ''} ORDER BY COALESCE(i.decidido_em, i.criado_em) DESC, i.id DESC LIMIT ?`).all(...args, lim + 1);
    const linhas = lidas.slice(0, lim);
    const ultima = lidas.length > lim ? linhas.at(-1) : null;
    const proximo = ultima ? `${ultima.decidido_em ?? ultima.criado_em}:${ultima.id}` : null;
    const nomes = new Map(db.prepare('SELECT jid, name FROM groups').all().map((g) => [g.jid, g.name]));
    const resultados = db.prepare('SELECT jid, group_name, ok, erro FROM envio_resultados WHERE envio_id = ? ORDER BY id');
    const itens = linhas.map((l) => {
      const info = lerChave(l.chave) ?? { loja: l.loja, url: null };
      const o = lerJson(l.oferta, {});
      let grupos = []; let falhou = false; let doEnvio = [];
      if (l.envio_id != null && l.envio_grupos != null) {
        const todos = resultados.all(l.envio_id);
        const ultimo = new Map(todos.map((r) => [r.jid, r]));
        const encerrado = !ENVIO_ATIVO.includes(l.envio_status);
        falhou = ENVIO_FIM.includes(l.envio_status) && !todos.some((r) => r.ok);
        const motivo = encerrado ? motivoDoEnvio(l.envio_status, l.envio_resultado) : null;
        doEnvio = listaDeTexto(l.envio_grupos).map((jid) => {
          const r = ultimo.get(jid); const nome = r?.group_name || nomes.get(jid) || '(grupo removido)';
          if (!r) return encerrado ? { nome, ok: false, erro: motivo } : { nome, ok: null, erro: null };
          return { nome, ok: !!r.ok, erro: r.ok ? null : r.erro };
        });
      }
      // em revisão (também a que voltou de um envio que falhou, CA2.8): os grupos da regra, para onde o "Enviar" manda
      if (l.status === 'revisao') grupos = listaDeTexto(l.regra_grupos).filter((j) => nomes.has(j)).map((jid) => ({ nome: nomes.get(jid), ok: null, erro: null }));
      else grupos = doEnvio;
      const podeReenviar = l.status === 'enviado' && falhou;
      return {
        id: l.id, rule_id: l.rule_id, regra: l.regra ?? null, loja: l.loja, status: l.status,
        motivos: listaDeTexto(l.motivos).filter((m) => MOTIVOS.includes(m)),
        // só o item que o verificador barrou (DESCARTE_VERIFICADOR): a tela diz o porquê em vez de "na revisão"
        ...(l.status === 'descartado' && DESCARTE_VERIFICADOR.includes(o.descartado_por) ? { descartado_por: o.descartado_por } : {}),
        // a queda em % do item que foi à revisão por ela (a tela diz "Preço N% abaixo da lista")
        ...(listaDeTexto(l.motivos).includes('queda_preco') && quedaValida(o.queda_pct) != null ? { queda_pct: o.queda_pct } : {}),
        oferta: {
          title: o.title ?? null, price: o.price ?? null, oldPrice: o.oldPrice ?? null, discountPct: o.discountPct ?? null,
          sold: o.sold ?? null, freeShipping: o.freeShipping === true, coupon: o.coupon ?? null,
          image: imagemPermitida(LOJA_ID[info.loja], o.image) ? o.image : null, categoria: o.categoria ?? null,
          link: linkParaConferir(info, o),
        },
        grupos, envio_id: l.envio_id ?? null, envio_status: l.envio_status ?? null, pode_reenviar: podeReenviar,
        ultimo_envio_falhou: falhou,
        ultimo_envio_erros: falhou ? doEnvio.filter((g) => g.ok === false).map((g) => ({ nome: g.nome, erro: g.erro })) : [],
        criado_em: l.criado_em, decidido_em: l.decidido_em ?? null,
      };
    });
    const desde = agora() - DIA;
    const c = db.prepare(`SELECT SUM(status = 'enviado' AND decidido_em >= ?) AS enviadas, SUM(status = 'descartado' AND decidido_em >= ?) AS descartadas,
        SUM(status = 'revisao') AS para_revisar FROM catalogo_itens ${ruleId != null ? 'WHERE rule_id = ?' : ''}`)
      .get(desde, desde, ...(ruleId != null ? [ruleId] : []));
    const contados = contar();
    return {
      itens, proximo,
      contadores_24h: { enviadas: Number(c?.enviadas) || 0, descartadas: Number(c?.descartadas) || 0, para_revisar: Number(c?.para_revisar) || 0 },
      regras: ruleId != null ? contados.regras.filter((r) => r.rule_id === ruleId) : contados.regras,
      para_revisar: contados.para_revisar, teto_revisao: TETO_REVISAO,
    };
  }

  // ------------------------------------------------------------------------------------------- revisão (Dono)

  /**
   * O Mercado Livre está em espera (src/links.js `central()`, entrega 2)? Só lê o estado, sem gastar o teste da espera.
   * Serviço de links sem `central()` (de antes da entrega 2) ou que lança: não recusa aqui; a fila de envios ainda passa
   * pela espera ao pedir o link. No console só o nome do erro.
   */
  function mlEmEspera() {
    if (typeof links?.central !== 'function') return false;
    try { return links.central()?.estado === 'em_espera'; } catch (e) {
      console.error('[catalogo] estado da Central:', e?.name || 'erro');
      return false;
    }
  }

  /**
   * Ajustes do "Revisar" (os mesmos do "Completar": validarAjustesOferta de src/espelho.js, R9), com o erro daqui e
   * cupom até MAX_CUPOM_GUARDADO (R5: o catálogo traz cupons maiores que os do espelho). Só estas chaves; image e
   * link nunca vêm do navegador.
   */
  const validarAjustes = (a) => validarAjustesOferta(a, {
    maxCupom: MAX_CUPOM_GUARDADO,
    lerFoto: envios?.lerFoto ? (up) => envios.lerFoto(up) : null,
    erro: (mensagem) => new ErroCatalogoItem(400, mensagem),
  });

  /**
   * Campos de loja do payload de `preparar('oferta')`, com a recusa de link comum (CA4). Sem rede: o link do ML e o
   * da Amazon são gerados na hora do envio; o da Shopee é o do catálogo, conferido aqui e de novo no `preparar`.
   */
  function camposDaLoja(info, o, regra) {
    if (info.loja === 'shopee') {
      if (typeof o.link !== 'string' || !LINK_SHOPEE.test(o.link)) throw new ErroCatalogoItem(400, LINK_SHOPEE_FORA);
      return { tag_id: null, etiqueta: null, shop_id: info.shopId, item_id: info.itemId, link_afiliado: o.link };
    }
    if (info.loja === 'amazon') {
      if (!amazon?.montarLink) throw new ErroCatalogoItem(400, SEM_AMAZON);
      if (!temTagAmazon()) throw new ErroCatalogoItem(400, SEM_TAG);
      return { tag_id: null, etiqueta: null, asin: info.asin };
    }
    const modo = links?.modo?.();
    if (modo !== 'extension' && modo !== 'fake') throw new ErroCatalogoItem(400, ML_DIRETO);
    const tagId = Number.isInteger(o.tag_id) ? o.tag_id : regra.tag_id;
    const etq = Number.isInteger(tagId) ? db.prepare('SELECT id, name FROM tags WHERE id = ?').get(tagId) : null;
    if (!etq) throw new ErroCatalogoItem(400, SEM_ETIQUETA);
    if (modo === 'extension' && links?.status?.()?.online !== true) throw new ErroCatalogoItem(400, ML_SEM_EXTENSAO);
    if (mlEmEspera()) throw new ErroCatalogoItem(400, ML_EM_ESPERA);
    return { tag_id: etq.id, etiqueta: etq.name };
  }

  /**
   * POST /api/catalogo/itens/:id/enviar { ajustes } → { envio_id }. Item em 'revisao', ou 'enviado' cujo envio
   * aprovado terminou sem nenhum grupo ok (pode_reenviar, R3); senão 409. Preço ainda suspeito depois dos ajustes →
   * 400 com frase fixa. Oferta do ML com o Mercado Livre em espera → 400 com frase fixa, sem gravar nada. Grupos,
   * template e "enviar foto" são os da regra. Igual (outra chave) ou parecida com uma oferta enviada pela regra na
   * janela, sem a exceção do mais barato (só o mesmo título, DESCONTO_MINIMO_MAIS_BARATA% abaixo) → 409 "Não enviada: …" (src/parecido.js). A mesma oferta (mesma chave), igual ou parecida com uma que a
   * regra está mandando agora (usarEmEnvio) → 409 "…que está saindo agora…", mesmo se mais barata.
   */
  async function enviar(itemId, corpo, { userId = null } = {}) {
    const id = idValido(itemId);
    const b = corpo && typeof corpo === 'object' && !Array.isArray(corpo) ? corpo : {};
    const item = db.prepare('SELECT * FROM catalogo_itens WHERE id = ?').get(id);
    if (!item) throw new ErroCatalogoItem(404, 'Oferta não encontrada.');
    const reenvio = item.status === 'enviado' && envioFalhou(item.envio_id);
    if (item.status !== 'revisao' && !reenvio) throw new ErroCatalogoItem(409, JA_TRATADA);
    const regra = regraPorId(item.rule_id);
    if (!regra) throw new ErroCatalogoItem(404, 'A regra desta oferta foi apagada.');
    const info = lerChave(item.chave);
    if (!info) throw new ErroCatalogoItem(400, 'Esta oferta está sem o código do produto.');
    const ajustes = await validarAjustes(b.ajustes);
    const guardada = lerJson(item.oferta, {});
    const oferta = aplicarAjustes(guardada, ajustes);
    if (!oferta.title) throw new ErroCatalogoItem(400, 'Preencha o título do produto.');
    if (oferta.price == null) throw new ErroCatalogoItem(400, 'Preencha o preço atual.');
    if (precoSuspeito(oferta)) throw new ErroCatalogoItem(400, PRECO_SUSPEITO);
    const loja = camposDaLoja(info, guardada, regra);

    const tpl = Number.isInteger(regra.template_id) ? db.prepare('SELECT id, created_at FROM templates WHERE id = ?').get(regra.template_id) : null;
    if (!tpl) throw new ErroCatalogoItem(400, 'O template desta regra foi apagado. Escolha outro na regra.');
    const destinos = [...new Set(Array.isArray(regra.group_jids) ? regra.group_jids : [])].slice(0, MAX_GRUPOS)
      .filter((j) => typeof j === 'string' && grupoExiste(j));
    if (!destinos.length) throw new ErroCatalogoItem(400, 'A regra desta oferta não tem grupos. Escolha ao menos um grupo na regra.');
    if (wa && !wa.isReady()) throw new ErroCatalogoItem(400, 'O WhatsApp está desconectado. Conecte o número antes de enviar.');

    // Shopee com Sub_id por bloco: os links saem agora (como no Disparo manual), com o do catálogo como base. Sem a
    // função na fila (servidor que ainda não a expõe), sai só o base e o envio conta como não rastreado.
    if (info.loja === 'shopee' && typeof envios?.linksRastreioShopee === 'function') {
      const porGrupo = await envios.linksRastreioShopee({ urlProduto: info.url, jids: destinos, base: loja.link_afiliado });
      if (Object.values(porGrupo).some((l) => l.esperado)) loja.links_rastreio = porGrupo;
    }

    const lojaId = LOJA_ID[info.loja];
    const imagem = imagemPermitida(lojaId, oferta.image) ? oferta.image : null;
    const enviarFoto = ajustes.sem_foto ? false : ajustes.upload ? true : regra.send_image;
    const payload = {
      url: info.url, loja: lojaId, ...loja,
      template_id: tpl.id, template_criado_em: tpl.created_at ?? null, fonte_dados: 'manual', enviar_foto: enviarFoto,
      ...(ajustes.upload ? { upload: ajustes.upload } : {}),
      origem: { tipo: 'catalogo', rule_id: regra.id, nome: regra.name },
      offer: {
        key: item.chave, title: oferta.title, price: oferta.price, oldPrice: oferta.oldPrice ?? null, discountPct: oferta.discountPct ?? null,
        sold: oferta.sold ?? null, freeShipping: oferta.freeShipping === true, coupon: oferta.coupon ?? null, image: imagem,
      },
    };
    const { key: _chave, ...semChave } = payload.offer;
    const guardar = JSON.stringify({ ...guardada, ...semChave }); // a oferta como saiu (com os ajustes), para a lista
    const now = agora();
    const envioId = transacao(() => {
      // produto igual ou parecido já enviado pela regra na janela (outra chave; a própria reserva não conta)
      const dias = Number(regra.dedupe_days);
      if (dias > 0) {
        const trava = criarTrava({ enviados: lerEnviados(db, regra.id, now - dias * DIA), agora: now, dedupeDias: dias });
        const v = trava.avaliar({ key: item.chave, title: oferta.title, price: oferta.price });
        if (v?.acao === 'barrar') throw new ErroCatalogoItem(409, textoConflito(v, now, { prefixo: 'Não enviada' }));
        if (v?.acao === 'liberar') {
          payload.mais_barata = { preco_anterior: v.anterior.preco };
          // a linha "Saiu como oportunidade melhor" é da fila, quando a oferta sair de fato (achados R5/Q3)
          payload.parecida_anterior = { titulo: v.anterior.title, enviada_em: v.anterior.sent_at };
        }
      }
      // escolhida por uma execução da regra em andamento, que só grava em `sent_offers` depois de mandar aos grupos
      // (achado Q1): parecida com ela barra sempre, como na mesma rodada, sem a exceção do mais barato
      const naRegra = saindoNaRegra(regra.id);
      // a própria oferta escolhida pela regra (o "Enviar de novo" de um envio que falhou): a trava pula a mesma chave,
      // e sem esta conferência ela sairia duas vezes, pela regra e pelo clique
      const propria = naRegra.find((o) => String(o.key) === String(item.chave));
      if (propria) throw new ErroCatalogoItem(409, textoConflito({ tipo: 'saindo', anterior: { title: propria.title } }, now, { prefixo: 'Não enviada' }));
      const saindo = criarTrava({ enviados: [], agora: now, dedupeDias: 0 });
      for (const o of naRegra) saindo.acrescentar(o);
      const s = saindo.avaliar({ key: item.chave, title: oferta.title, price: oferta.price });
      if (s?.acao === 'barrar') throw new ErroCatalogoItem(409, textoConflito({ ...s, tipo: 'saindo' }, now, { prefixo: 'Não enviada' }));
      // a trava: só um "Enviar" muda o item de 'revisao' (ou do envio que falhou); o segundo vê 0 linhas e recebe 409.
      // No reenvio, o liberarFalhos pode ter devolvido o item à revisão enquanto este "Enviar" esperava (CA2.8): vale igual.
      const r = reenvio
        ? db.prepare(`UPDATE catalogo_itens SET status = 'enviado', oferta = ?, decidido_em = ? WHERE id = ? AND (status = 'revisao'
            OR (status = 'enviado' AND envio_id = ? AND EXISTS (SELECT 1 FROM envios v WHERE v.id = ? AND ${SQL_ENVIO_FALHOU})))`)
          .run(guardar, now, id, item.envio_id, item.envio_id)
        : db.prepare("UPDATE catalogo_itens SET status = 'enviado', oferta = ?, decidido_em = ? WHERE id = ? AND status = 'revisao'").run(guardar, now, id);
      if (r.changes !== 1) throw new ErroCatalogoItem(409, JA_TRATADA);
      // a reserva do envio que falhou (se o agendador ainda não a tirou)
      if (reenvio && item.decidido_em != null) db.prepare('DELETE FROM sent_offers WHERE rule_id = ? AND offer_key = ? AND sent_at = ?').run(regra.id, item.chave, item.decidido_em);
      const novo = Number(db.prepare(`INSERT INTO envios (tipo, payload, group_jids, quando, repetir, status, next_run_at, user_id, created_at)
        VALUES ('oferta', ?, ?, 'agora', NULL, 'pendente', ?, ?, ?)`)
        .run(JSON.stringify(payload), JSON.stringify(destinos), now, Number.isInteger(userId) ? userId : null, now).lastInsertRowid);
      db.prepare('UPDATE catalogo_itens SET envio_id = ? WHERE id = ?').run(novo, id);
      db.prepare('INSERT INTO sent_offers (rule_id, offer_key, sent_at, title, price_cents) VALUES (?,?,?,?,?)')
        .run(regra.id, item.chave, now, tituloParaGuardar(oferta.title), centavos(oferta.price));
      return novo;
    });
    pedirEnvio();
    return { envio_id: envioId };
  }

  /** POST /api/catalogo/itens/:id/descartar → { ok }. Só item em 'revisao' (senão 409). */
  function descartar(itemId) {
    const id = idValido(itemId);
    const item = db.prepare('SELECT * FROM catalogo_itens WHERE id = ?').get(id);
    if (!item) throw new ErroCatalogoItem(404, 'Oferta não encontrada.');
    const r = db.prepare("UPDATE catalogo_itens SET status = 'descartado', decidido_em = ? WHERE id = ? AND status = 'revisao'").run(agora(), id);
    if (r.changes !== 1) throw new ErroCatalogoItem(409, JA_TRATADA);
    const regra = regraPorId(item.rule_id);
    log(regra, { level: 'info', offer_title: lerJson(item.oferta, {})?.title || null, message: 'Descartada na revisão' });
    return { ok: true };
  }

  return { tratada, registrar, revisaoCheia, listar, enviar, descartar, contar, liberarFalhos, usarEmEnvio };
}

/** Responde JSON; ErroCatalogoItem vira o status dele. Erro inesperado (banco) não devolve nem registra a mensagem. */
const responder = (fn) => async (req, res) => {
  try { res.json(await fn(req)); } catch (e) {
    if (e instanceof ErroCatalogoItem) return res.status(e.status).json({ erro: e.message });
    console.error('[catalogo] falha inesperada:', e?.code || e?.name || 'erro'); // sem e.message: pode trazer valores da query
    res.status(500).json({ erro: 'Não consegui concluir. Tente de novo.' });
  }
};

/** Sem `ctx.soDono` (servidor montado sem login), ninguém envia nem descarta: falha fechada. */
const negar = (_req, res) => res.status(403).json({ erro: 'Só o Dono pode fazer isso.' });

/**
 * Rotas da revisão, montadas por buildApp depois do login e da checagem Host/Origin (a ligação é da etapa 5).
 * A lista é de quem estiver logado (Dono e Operador); enviar e descartar são só do Dono (P6: `ctx.soDono` responde
 * 403 ao Operador). O serviço é `ctx.catalogoItens` (ou `ctx.scheduler.catalogoItens`), lido na hora.
 */
export function montarRotas(app, ctx) {
  const itens = () => {
    const s = ctx.catalogoItens ?? ctx.scheduler?.catalogoItens;
    if (!s) throw new ErroCatalogoItem(503, 'O catálogo não está disponível neste servidor.');
    return s;
  };
  const soDono = typeof ctx.soDono === 'function' ? ctx.soDono : negar;
  app.get('/api/catalogo/itens', responder((req) => itens().listar(req.query)));
  app.post('/api/catalogo/itens/:id/enviar', soDono, responder((req) => itens().enviar(req.params.id, req.body, { userId: req.user?.id ?? null })));
  app.post('/api/catalogo/itens/:id/descartar', soDono, responder((req) => itens().descartar(req.params.id)));
}
