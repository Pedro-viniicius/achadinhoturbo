// Fonte "catalogo": cliente da API de ofertas do Etiqueta (plano fonte-catalogo-etiqueta, etapa 1; ADR-004).
// Contrato da API (só leitura, exceto a confirmação de preço da Amazon): ~/Documentos/mensagensParaEnviar/docs/produto/referencias/api-ofertas.md.
//
// Contrato do módulo:
//
// - createCatalogo({ db, fetch, lerConexao, agora, timeoutMs, orcamentoMs, esperar }) →
//   { testar(), situacao(), ultimaVerificacao(), candidatos(cfg, ctx), avancar(ruleId, paginas, tratada),
//     recomecar(ruleId), esquecerRegra(ruleId), confirmarPreco(asin) }
//   - Conexão lida a cada chamada: `lerConexao()` → { endereco, caminho_token } (o servidor passa
//     `() => segredosDe(db, 'catalogo')`); sem ele, a linha 'catalogo' de `conexoes` (config).
//   - Endereço (D3): só `http://localhost:<porta>` ou `http://127.0.0.1:<porta>`, conferido de novo a cada
//     chamada; `fetch` com redirect:'error', timeout de 15 s, corpo até 2 MiB, sem Origin: o único cabeçalho
//     enviado é Authorization.
//   - Token (D2): lido do arquivo do caminho salvo a cada pedido, só numa variável local do pedido. O arquivo
//     precisa se chamar api_token.txt (S1, conferido no PUT e de novo aqui), ser arquivo comum (lstat antes de
//     abrir: nem link simbólico, nem pasta, nem FIFO; aberto com O_NOFOLLOW e O_NONBLOCK), até 4096 bytes, conteúdo
//     aparado em ^[A-Za-z0-9_-]{32,}$. Sem caminho salvo: nenhuma leitura e nenhuma rede. Nunca em banco, URL,
//     log, console, erro ou resposta.
//   - Fila única: um pedido ao Etiqueta por vez, de todas as funções desta instância (CA3). A pré-visualização é
//     recusada (resultado `ocupado`, que não muda a situação) quando já há MAX_ESPERA_PREVIA pedidos esperando.
//   - Resultados fixos: ok | nao_configurada | sem_arquivo | arquivo_invalido | token_recusado (401) |
//     desligada (503) | fora_do_ar (rede, tempo, 5xx) | resposta_inesperada (3xx, 400/403/404, JSON fora do
//     contrato, versao ≠ 1).
//   - testar() → { ok, resultado, mensagem, total, categorias:[{ nome, total, lojas:{ amazon, ml, shopee } }] }.
//     Chama GET /api/v1/categorias e grava `settings.catalogo_verificacao` (resultado, verificado_em, impressão do
//     endereço + caminho, e as categorias do último teste aceito; um teste que falha mantém as anteriores).
//   - situacao() → { estado, resultado, verificado_em, falha_desde }. Vale o mais recente entre o último "Testar"
//     (banco) e o último pedido de candidatos (memória), só se for do mesmo endereço + caminho. estado:
//     falta_configurar | salva | conectada | token_recusado | indisponivel | sem_arquivo. falha_desde: início da
//     sequência atual de falhas (testes e pedidos), null depois de um sucesso.
//   - ultimaVerificacao() → { resultado, verificado_em, total, categorias } | null (sem rede; para a regra).
//   - candidatos(cfg, ctx) → lista de candidatos (paraCandidato) ainda não tratados, na ordem do Etiqueta.
//     ctx = { rule, fonteIndex, quer, tratada(c, modo) → bool, utilizavel(c) → bool, vistas: Set, paginas: Map,
//     onWarn(msg), previa, conferenciaNaHora }. modo é a ordem da fonte (config.ordem), como em catalogoItens.tratada(rule, c, modo):
//     'atualizacao' (Novidades: tratada = já passou pela regra, sem prazo) ou outra (prazo de repetição da regra).
//     utilizavel(c): a regra usaria a oferta agora (filtros de preço e desconto, loja disponível, revisão com
//     vaga; o agendador monta); só as utilizáveis contam para o alvo da leitura (Q4, Q5). vistas: chaves que outra
//     fonte da mesma regra já trouxe nesta execução; contam como tratadas (nem voltam, nem seguram o cursor). Grava
//     em ctx.paginas (chave fonteIndex) o que leu, para o avancar(). Não grava nada no banco.
//     - Novidades com cursor pronto: lê a partir do cursor (nulo = do começo, depois de "Reler do começo"). As que
//       não são utilizáveis seguram o cursor (P8), mas a leitura segue nas páginas seguintes até o teto.
//     - Novidades sem cursor (primeira leitura do filtro), ou cursor recusado (400), também na primeira leitura:
//       avança até o fim sem devolver nada, até 20 páginas por execução (D6, P3).
//     - previa: true (pré-visualização): nunca avança até o fim. Sem cursor pronto, devolve [] sem rede e marca
//       { modo: 'primeira_leitura' } em ctx.paginas; não chama onWarn.
//     - Demais ordens (D7): páginas do início até achar max(quer × 4, 20) ofertas utilizáveis não tratadas, no
//       máximo 10.
//     - conferenciaNaHora === true (cada oferta será conferida antes do envio: verificador ligado) e lojas da fonte
//       só ml e/ou amazon (lista não vazia): todo pedido leva preco_max_horas=IDADE_CATALOGO_CONFERIDO_H (72);
//       fora disso, nada (vale a validade do Etiqueta). O filtroDe (chave do cursor) não muda com isso.
//     - Sempre limite=200. Orçamento de ORCAMENTO_PADRAO (30 s) para a chamada inteira, compartilhado pelas
//       páginas: esgotado depois da primeira página, devolve o que leu (o resto fica para a próxima execução);
//       antes dela, fora_do_ar. Falha → ErroCatalogo (frase fixa "Catálogo do Etiqueta indisponível…").
//   - primeiraLeitura(ruleId, config) → true se a fonte é Novidades e o cursor dela ainda não está pronto (sem rede).
//   - avancar(ruleId, paginas, tratada) grava o cursor de cada fonte Novidades: passa por cada página cujas
//     ofertas foram todas tratadas (tratada(c, 'atualizacao'), que inclui as recusadas pelos filtros da regra
//     nesta execução); vazio com proximo:null não muda nada. → [{ fonteIndex, filtro, paginas_avancadas, pronto }]
//   - recomecar(ruleId): cursor nulo com pronto=1 em toda fonte Novidades da regra (varredura do zero). → nº de fontes.
//   - esquecerRegra(ruleId): apaga os cursores da regra.
//   - confirmarPreco(asin): POST /api/v1/amazon/<ASIN>/confirmar-preco (o Etiqueta relê a página e grava o preço;
//     plano rodar-sozinho-entrega1). Nunca lança; resultados e causas no comentário da função. Fila única, sem
//     corpo, só Authorization, redirect:'error', timeout por pedido, corpo até 4 KiB. Não muda situacao(). O freio
//     curto do Etiqueta (429 `intervalo`/`ocupado`) é esperado dentro da fila e o pedido é refeito.
// - Puros: paraCandidato(oferta), motivosDeRevisao(c), emCentavos(v), limparFonteCatalogo(config), precisaEtiqueta(sources),
//   filtroDe(config), enderecoValido(v), caminhoValido(v), fraseDoTeste(resultado, dados), lerPrecoEm(texto).
// - settings.catalogo_verificacao (contrato com src/conexoes.js, etapa 3): { verificado_em, total,
//   categorias:[{ nome, total, lojas:{ amazon, ml, shopee } }] }, o formato de GET /api/catalogo/categorias, mais
//   `resultado` e `impressao` (sha256 de endereço + caminho, 16 hex) para a situacao().
//
// Candidato: { key, loja:'ml'|'amazon'|'shopee' (como no Etiqueta e em catalogo_itens), plataforma
// ('mercadolivre'|'amazon'|'shopee', o id das lojas do painel: imagemPermitida, envios), url, title, price,
// oldPrice, discountPct (o do contrato), sold, freeShipping, coupon, image (só do CDN da loja), categoria,
// precoEm (preco_em do Etiqueta em ms, hora local; null se ausente ou inválido), asin (Amazon), link (só Shopee) }.
// O link do ML e o da Amazon que vêm do Etiqueta não são usados: o ML é
// gerado de novo com a etiqueta e a Amazon é remontada com a tag de Conexões (D4).
//
// As regras do endereço e do caminho e a foto por CDN são as de src/lojas.js (o PUT de Conexões usa as mesmas);
// lojas.js não importa este módulo.

import { createHash } from 'node:crypto';
import { promises as fsp, constants as FS } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getSetting, setSetting, parseRule } from './db.js';
import { discountPct as calcularDesconto } from './template.js';
import { tituloDeUmaLinha } from './titulo.js';
import { lerCorpoLimitado } from './rede.js';
import { LINK_SHOPEE } from './shopee.js';
import { RE_ENDERECO_CATALOGO, RE_CAMINHO_TOKEN, PARECE_TOKEN, caminhoDoArquivoDoToken, imagemPermitida } from './lojas.js';
import { temCaraDeLink } from './oferta-texto.js';

const RE_TOKEN = /^[A-Za-z0-9_-]{32,}$/;
const MAX_ARQUIVO_TOKEN = 4096;
const MAX_CORPO = 2 * 1024 * 1024;
const TIMEOUT_PADRAO = 15000;
const ORCAMENTO_PADRAO = 30000;  // ms para uma chamada de candidatos() inteira (todas as páginas)
const MAX_ESPERA_PREVIA = 4;     // pedidos já esperando na fila: acima disso, a pré-visualização é recusada
const LIMITE = 200;              // ofertas por página (o máximo do contrato)
const PAGINAS_FIM = 20;          // primeira leitura de Novidades: páginas por execução até o fim
const PAGINAS_LEITURA = 10;      // demais leituras
const MAX_CURSOR = 500;
const MAX_CATEGORIAS_RESPOSTA = 1000;
const MAX_CORPO_CONFIRMAR = 4096; // a resposta da confirmação de preço tem algumas dezenas de bytes
const PRECO_MAX = 10_000_000;     // o mesmo teto de preço dos outros caminhos (catalogo-itens.js, envios.js)
/** Motivos do 429 (freio da confirmação) que o contrato do Etiqueta define. */
const MOTIVOS_FREIO = Object.freeze(['ocupado', 'pausa', 'intervalo', 'teto', 'rodada']);
/** 429 de espera curta (outra leitura começou há menos de 3 s ou está em curso): espera dentro da fila e tenta de novo. */
const FREIO_CURTO = Object.freeze(['intervalo', 'ocupado']);
const ESPERA_FREIO_CURTO_MAX_S = 3; // o intervalo do freio do Etiqueta; espera maior não é "curta"
const NOVAS_TENTATIVAS_FREIO = 2;   // no pior caso 2 × 3 s de espera, mais a leitura, dentro do prazo do verificador (20 s)
const dormir = (ms) => new Promise((ok) => { setTimeout(ok, ms); });
/**
 * Idade máxima do preço (h) pedida ao Etiqueta quando toda oferta da fonte é conferida na hora (verificador
 * ligado, só ML e/ou Amazon). Fora disso, vale a validade do próprio Etiqueta (48 h).
 */
export const IDADE_CATALOGO_CONFERIDO_H = 72;
const LOJAS_CONFERIDAS_NA_HORA = Object.freeze(['ml', 'amazon']);
export const LOJAS = Object.freeze(['amazon', 'ml', 'shopee']);
export const ORDENS = Object.freeze(['atualizacao', 'relevancia', 'desconto', 'menor_preco', 'maior_preco', 'cupom', 'recentes']);
/** Loja do Etiqueta → id da loja no painel (src/lojas.js). */
export const PLATAFORMA_DA_LOJA = Object.freeze(Object.assign(Object.create(null), { ml: 'mercadolivre', amazon: 'amazon', shopee: 'shopee' }));
const CHAVE_VERIFICACAO = 'catalogo_verificacao';

// ---------------------------------------------------------------------------------------------- erros

export const MENSAGENS_CATALOGO = Object.freeze({
  nao_configurada: 'O catálogo do Etiqueta não está configurado em Conexões.',
  sem_arquivo: 'Catálogo do Etiqueta indisponível: não encontrei o arquivo do token.',
  arquivo_invalido: 'Catálogo do Etiqueta indisponível: o arquivo do token está fora do formato.',
  token_recusado: 'Catálogo do Etiqueta indisponível: o Etiqueta recusou o token.',
  desligada: 'Catálogo do Etiqueta indisponível: a API do Etiqueta está desligada.',
  fora_do_ar: 'Catálogo do Etiqueta indisponível: o Etiqueta não respondeu.',
  resposta_inesperada: 'Catálogo do Etiqueta indisponível: o Etiqueta respondeu algo inesperado.',
  // não é falha do Etiqueta: a fila deste programa está cheia (só a pré-visualização recebe; a situação não muda)
  ocupado: 'Catálogo do Etiqueta ocupado: há pedidos demais na fila. Tente de novo em instantes.',
});

/** Falha ao falar com o Etiqueta. Mensagem fixa por resultado: nunca token, URL, caminho ou corpo de resposta. */
export class ErroCatalogo extends Error {
  constructor(resultado) {
    const r = Object.hasOwn(MENSAGENS_CATALOGO, resultado) ? resultado : 'fora_do_ar';
    super(MENSAGENS_CATALOGO[r]);
    this.name = 'ErroCatalogo';
    this.resultado = r;
    this.codigo = r;
  }
}

/** Cursor salvo recusado pelo Etiqueta (400 com cursor). Interno: vira "avançar até o fim de novo". */
class CursorRecusado extends Error {
  constructor() { super('cursor recusado'); this.name = 'CursorRecusado'; }
}

/** O orçamento de tempo da chamada de candidatos() acabou. Interno: a leitura para e devolve o que já leu. */
class SemTempo extends Error {
  constructor() { super('sem tempo'); this.name = 'SemTempo'; }
}

const ESTADO_DO_RESULTADO = Object.freeze({
  ok: 'conectada', nao_configurada: 'falta_configurar', token_recusado: 'token_recusado',
  desligada: 'indisponivel', fora_do_ar: 'indisponivel', resposta_inesperada: 'indisponivel',
  sem_arquivo: 'sem_arquivo', arquivo_invalido: 'sem_arquivo',
});

const numeroBr = (n) => Number(n).toLocaleString('pt-BR');
const plural = (n, um, varios) => `${numeroBr(n)} ${n === 1 ? um : varios}`;

/** Frase do "Testar" por resultado (spec, seção 1). O endereço e o caminho são do dono; o token nunca entra. */
export function fraseDoTeste(resultado, { endereco = '', caminho = '', total = 0, categorias = 0 } = {}) {
  switch (resultado) {
    case 'ok': return `Conectado. ${plural(total, 'oferta', 'ofertas')} em ${plural(categorias, 'categoria', 'categorias')}.`;
    case 'token_recusado': return 'O Etiqueta recusou o token. Se você trocou o arquivo do token, reinicie o servidor.py do Etiqueta (ele lê o arquivo só ao ligar) e teste de novo.';
    case 'desligada': return 'O Etiqueta está no ar, mas a API dele está desligada. Falta o arquivo api_token.txt (ou ele é inválido) na pasta do Etiqueta. O terminal do servidor.py diz o motivo. Depois de corrigir, reinicie-o e teste de novo.';
    case 'fora_do_ar': return `Não consegui falar com o Etiqueta em ${endereco}. Confira se ele está ligado (python3 servidor.py) e se o endereço e a porta estão certos.`;
    case 'sem_arquivo': return `Não encontrei o arquivo do token em ${caminho}. Confira o caminho, e se este programa tem permissão para ler o arquivo.`;
    case 'arquivo_invalido': return 'O arquivo do token está vazio ou fora do formato (32 ou mais letras, números, _ e -). Gere o token de novo no Etiqueta.';
    case 'resposta_inesperada': return 'O Etiqueta respondeu algo que não esperávamos. Tente de novo; se continuar, veja o terminal do servidor.py.';
    case 'ocupado': return 'Há pedidos demais esperando o Etiqueta. Tente de novo em instantes.';
    default: return 'Salve o endereço e o caminho do token para testar.';
  }
}

// ------------------------------------------------------------------------------------- validações puras

/** Endereço do Etiqueta aceito (D3): http, localhost ou 127.0.0.1, porta de 1 a 65535, sem caminho (RE_ENDERECO_CATALOGO). */
export const enderecoValido = (v) => typeof v === 'string' && RE_ENDERECO_CATALOGO.test(v);

/**
 * Caminho do arquivo do token aceito: / ou ~/, até 500 caracteres, sem controle, que não seja o próprio token e que
 * termine no arquivo do Etiqueta (…/api_token.txt, S1).
 */
export const caminhoValido = (v) => typeof v === 'string' && RE_CAMINHO_TOKEN.test(v) && !PARECE_TOKEN.test(v) && caminhoDoArquivoDoToken(v);

const comprimento = (s) => [...s].length; // em caracteres, como o Etiqueta (Python) conta

/** Frases fixas do 400 da regra. Nunca repetem o valor recebido. */
export const ERROS_FONTE = Object.freeze({
  categorias: 'Escolha no máximo 20 categorias.',
  categoria: 'Categorias do catálogo: cada uma com 1 a 200 caracteres, sem repetir.',
  lojas: 'Lojas do catálogo: escolha entre Mercado Livre, Amazon e Shopee, sem repetir.',
  q: 'Buscar por: até 200 caracteres e 10 palavras, separadas por vírgula, sem palavra vazia.',
  desconto_min: 'Desconto mínimo: número inteiro de 0 a 99.',
  ordem: 'Ordem do catálogo inválida.',
});
const erroFonte = (campo) => Object.assign(new Error(ERROS_FONTE[campo]), { campo });

/**
 * Config da fonte "catalogo" limpa: { categorias, lojas, q, desconto_min, ordem }, só com os limites do contrato.
 * Ausente vira o padrão (todas as categorias e lojas, sem busca, sem desconto mínimo, Novidades). Inválido →
 * Error com frase fixa (ERROS_FONTE) e `campo`.
 */
export function limparFonteCatalogo(config) {
  const c = config && typeof config === 'object' && !Array.isArray(config) ? config : {};

  const categorias = c.categorias == null ? [] : c.categorias;
  if (!Array.isArray(categorias)) throw erroFonte('categoria');
  if (categorias.length > 20) throw erroFonte('categorias');
  const cats = new Set();
  for (const x of categorias) {
    if (typeof x !== 'string' || !x.trim() || comprimento(x) > 200 || cats.has(x)) throw erroFonte('categoria');
    cats.add(x);
  }

  const lojas = c.lojas == null ? [] : c.lojas;
  if (!Array.isArray(lojas) || lojas.length > LOJAS.length) throw erroFonte('lojas');
  const ls = new Set();
  for (const x of lojas) {
    if (!LOJAS.includes(x) || ls.has(x)) throw erroFonte('lojas');
    ls.add(x);
  }

  let q = c.q == null ? '' : c.q;
  if (typeof q !== 'string') throw erroFonte('q');
  q = q.trim();
  if (q) {
    const termos = q.split(',');
    if (comprimento(q) > 200 || termos.length > 10 || termos.some((t) => !t.trim())) throw erroFonte('q');
  }

  let desconto = c.desconto_min;
  if (desconto === '' || desconto == null) desconto = null;
  else {
    if (typeof desconto === 'string' && /^\d{1,2}$/.test(desconto.trim())) desconto = Number(desconto.trim());
    if (!(typeof desconto === 'number' && Number.isInteger(desconto) && desconto >= 0 && desconto <= 99)) throw erroFonte('desconto_min');
  }

  const ordem = c.ordem == null || c.ordem === '' ? 'atualizacao' : c.ordem;
  if (!ORDENS.includes(ordem)) throw erroFonte('ordem');

  return { categorias: [...cats], lojas: [...ls], q, desconto_min: desconto, ordem };
}

/** Identidade do filtro (chave do cursor): sha256 do config normalizado, 16 hex. A ordem das listas não importa. */
export function filtroDe(config) {
  const c = limparFonteCatalogo(config);
  const normal = { categorias: [...c.categorias].sort(), lojas: [...c.lojas].sort(), q: c.q, desconto_min: c.desconto_min, ordem: c.ordem };
  return createHash('sha256').update(JSON.stringify(normal)).digest('hex').slice(0, 16);
}

/**
 * A regra precisa da etiqueta do Mercado Livre (D8)? Sim se alguma fonte não é catálogo, ou é catálogo com
 * todas as lojas (lista vazia) ou com o ML. Sem fontes (regra antiga): sim.
 */
export function precisaEtiqueta(sources) {
  if (!Array.isArray(sources) || !sources.length) return true;
  return sources.some((s) => {
    if (s?.type !== 'catalogo') return true;
    const lojas = s.config?.lojas;
    return !Array.isArray(lojas) || !lojas.length || lojas.includes('ml');
  });
}

// ------------------------------------------------------------------------------------ oferta → candidato

const RE_ML = /^MLB(\d{6,20})$/;
const RE_ASIN = /^[A-Z0-9]{10}$/;
const RE_SHOPEE = /^\d{1,20}\.\d{1,20}$/;
const MAX_TITULO = 200;
const MAX_CUPOM = 200;

const inteiroNaoNegativo = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

const RE_PRECO_EM = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;

/**
 * `preco_em` do Etiqueta ("AAAA-MM-DDTHH:MM:SS", hora local, sem fuso) → ms, ou null quando está fora do formato
 * ou a data não existe (31/04, 29/02 fora de ano bissexto, 24:00…): a ida e volta pelo Date precisa dar os mesmos
 * campos. Pura.
 */
export function lerPrecoEm(texto) {
  if (typeof texto !== 'string') return null;
  const m = RE_PRECO_EM.exec(texto);
  if (!m) return null;
  const [a, mes, d, h, mi, s] = m.slice(1).map(Number);
  const dt = new Date(a, mes - 1, d, h, mi, s); // anos 0000-0099 viram 19xx e não voltam iguais: null
  if (dt.getFullYear() !== a || dt.getMonth() !== mes - 1 || dt.getDate() !== d
    || dt.getHours() !== h || dt.getMinutes() !== mi || dt.getSeconds() !== s) return null;
  const ms = dt.getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Oferta do Etiqueta → candidato do Turbo, ou null quando não fecha (loja, código do produto, título, preço > 0,
 * link da Shopee fora de LINK_SHOPEE) ou quando título, cupom ou categoria têm cara de link ou de menção (S2: o
 * WhatsApp faria link de "…bit.ly/x" no texto; temCaraDeLink de src/oferta-texto.js). Pura: sem rede, sem banco.
 */
export function paraCandidato(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const loja = o.loja;
  if (typeof loja !== 'string' || !Object.hasOwn(PLATAFORMA_DA_LOJA, loja)) return null;
  const itemId = typeof o.item_id === 'string' ? o.item_id.trim() : '';
  const title = tituloDeUmaLinha(o.titulo, MAX_TITULO);
  const price = o.preco;
  if (!title || typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return null;

  let key; let url; let extra = {};
  if (loja === 'ml') {
    const m = RE_ML.exec(itemId);
    if (!m) return null;
    key = `MLB${m[1]}`;
    url = `https://produto.mercadolivre.com.br/MLB-${m[1]}`;
  } else if (loja === 'amazon') {
    const asin = itemId.toUpperCase();
    if (!RE_ASIN.test(asin)) return null;
    key = `ASIN:${asin}`;
    url = `https://www.amazon.com.br/dp/${asin}`; // sem tag: o link do envio é montado com a tag de Conexões
    extra = { asin };
  } else {
    if (!RE_SHOPEE.test(itemId)) return null;
    const link = typeof o.link === 'string' ? o.link.trim() : '';
    if (!LINK_SHOPEE.test(link)) return null;
    key = `SHOPEE:${itemId}`;
    url = link;
    extra = { link };
  }

  const oldPrice = typeof o.preco_antigo === 'number' && Number.isFinite(o.preco_antigo) && o.preco_antigo > price ? o.preco_antigo : null;
  // o desconto do contrato (inclui o calculado pelo preço antigo); fora do formato, a conta local
  const discountPct = typeof o.desconto_pct === 'number' && Number.isFinite(o.desconto_pct)
    ? Math.min(100, Math.max(0, Math.round(o.desconto_pct)))
    : calcularDesconto(price, oldPrice);
  const coupon = tituloDeUmaLinha(o.cupom, MAX_CUPOM);
  const categoria = typeof o.categoria === 'string' ? o.categoria.slice(0, 200) : '';
  if (temCaraDeLink(title) || (coupon && temCaraDeLink(coupon)) || (categoria && temCaraDeLink(categoria))) return null;
  return {
    key, loja, plataforma: PLATAFORMA_DA_LOJA[loja], url, title, price, oldPrice, discountPct,
    sold: inteiroNaoNegativo(o.vendas), freeShipping: o.frete_gratis === true, coupon: coupon || null,
    image: imagemPermitida(PLATAFORMA_DA_LOJA[loja], o.imagem) ? o.imagem : null, categoria,
    precoEm: lerPrecoEm(o.preco_em), ...extra,
  };
}

/** Valor em reais → centavos inteiros (a conta do "10×" sem ponto flutuante: 0,33 × 10 = 3,3000000000000003). null se não é número. */
export function emCentavos(v) {
  const n = Number(v);
  return v != null && v !== '' && Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** Por que o candidato espera revisão (D5, CA4, CA7): 'shopee', 'desconto_100', 'preco_antigo'. Lista vazia = pode sair. */
export function motivosDeRevisao(c) {
  const motivos = [];
  if (c?.loja === 'shopee') motivos.push('shopee');
  if (Number(c?.discountPct) >= 100) motivos.push('desconto_100');
  const preco = emCentavos(c?.price);
  const antigo = emCentavos(c?.oldPrice);
  if (preco != null && antigo != null && preco > 0 && antigo >= 10 * preco) motivos.push('preco_antigo');
  return motivos;
}

// ------------------------------------------------------------------------------------------ token

function expandirCaminho(caminho) {
  return caminho.startsWith('~/') ? path.join(os.homedir(), caminho.slice(2)) : caminho;
}

/**
 * Lê o token do arquivo. → { token } | { resultado: 'sem_arquivo' | 'arquivo_invalido' }. Nunca guarda o valor
 * nem o põe em erro. Só o arquivo api_token.txt (S1, de novo aqui); lstat antes de abrir recusa link simbólico,
 * pasta e FIFO; O_NOFOLLOW fecha a troca por um link entre o lstat e o open; O_NONBLOCK: um FIFO posto no lugar
 * nesse meio tempo não trava a leitura (e o fstat o recusa por não ser arquivo comum).
 */
async function lerToken(caminho) {
  if (!caminhoDoArquivoDoToken(caminho)) return { resultado: 'arquivo_invalido' };
  const real = expandirCaminho(caminho);
  try {
    const st = await fsp.lstat(real);
    if (!st.isFile()) return { resultado: 'arquivo_invalido' };
  } catch { return { resultado: 'sem_arquivo' }; }
  let fh;
  try {
    fh = await fsp.open(real, FS.O_RDONLY | FS.O_NONBLOCK | (FS.O_NOFOLLOW ?? 0) | (FS.O_NOCTTY ?? 0));
  } catch (e) { return { resultado: e?.code === 'ELOOP' ? 'arquivo_invalido' : 'sem_arquivo' }; }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > MAX_ARQUIVO_TOKEN) return { resultado: 'arquivo_invalido' };
    const buf = Buffer.alloc(MAX_ARQUIVO_TOKEN + 1);
    let lidos = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, lidos, buf.length - lidos, null);
      if (!bytesRead) break;
      lidos += bytesRead;
      if (lidos > MAX_ARQUIVO_TOKEN) return { resultado: 'arquivo_invalido' };
    }
    const token = buf.subarray(0, lidos).toString('latin1').trim();
    buf.fill(0);
    return RE_TOKEN.test(token) ? { token } : { resultado: 'arquivo_invalido' };
  } catch {
    return { resultado: 'sem_arquivo' };
  } finally {
    try { await fh.close(); } catch { /* já fechado */ }
  }
}

// ------------------------------------------------------------------------------------- respostas

function lerJson(texto) {
  try { const o = JSON.parse(texto); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; }
}

const inteiroValido = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** Categorias da resposta, só com os campos do contrato; null se fora dele. */
function lerCategorias(json) {
  if (!json || json.versao !== 1 || !Array.isArray(json.categorias) || json.categorias.length > MAX_CATEGORIAS_RESPOSTA) return null;
  const out = [];
  for (const c of json.categorias) {
    if (!c || typeof c !== 'object' || typeof c.nome !== 'string' || !c.nome || comprimento(c.nome) > 200 || !inteiroValido(c.total)) return null;
    const l = c.lojas;
    if (!l || typeof l !== 'object' || !LOJAS.every((x) => inteiroValido(l[x]))) return null;
    out.push({ nome: c.nome, total: c.total, lojas: { amazon: l.amazon, ml: l.ml, shopee: l.shopee } });
  }
  const total = inteiroValido(json.total) ? json.total : out.reduce((s, c) => s + c.total, 0);
  return { categorias: out, total };
}

/** Página de ofertas; null se fora do contrato. */
function lerPagina(json) {
  if (!json || json.versao !== 1 || !Array.isArray(json.ofertas) || json.ofertas.length > LIMITE) return null;
  const p = json.proximo;
  if (p !== null && !(typeof p === 'string' && p.length > 0 && p.length <= MAX_CURSOR)) return null;
  return { ofertas: json.ofertas, proximo: p };
}

// ------------------------------------------------------------------------------------------ cliente

function lerConexaoDoBanco(db) {
  const linha = db?.prepare("SELECT config FROM conexoes WHERE plataforma = 'catalogo'").get();
  return lerJson(linha?.config);
}

const impressaoDe = (c) => createHash('sha256').update(`${c.endereco}\n${c.caminho}`).digest('hex').slice(0, 16);

/**
 * Cliente do Etiqueta (ver o contrato no topo do arquivo). db: banco aberto; fetch: injetado nos testes;
 * lerConexao(): { endereco, caminho_token }; agora: relógio; timeoutMs: tempo máximo por pedido; esperar(ms): a espera
 * do freio curto da confirmação de preço (injetada nos testes, para não dormir de verdade).
 */
export function createCatalogo({ db, fetch: f, lerConexao, agora = Date.now, timeoutMs = TIMEOUT_PADRAO, orcamentoMs = ORCAMENTO_PADRAO, esperar = dormir } = {}) {
  const doFetch = (...a) => (f ?? globalThis.fetch)(...a);
  let fila = Promise.resolve();
  let esperando = 0;        // pedidos na fila que ainda não começaram
  let ultimaChamada = null; // { resultado, em, impressao } do último pedido de candidatos
  let falha = null;         // { desde, impressao }: início da sequência atual de falhas

  function conexao() {
    let c = {};
    try { c = (lerConexao ? lerConexao() : lerConexaoDoBanco(db)) || {}; } catch { c = {}; }
    const endereco = typeof c.endereco === 'string' ? c.endereco : '';
    const caminho = typeof c.caminho_token === 'string' ? c.caminho_token : '';
    return { endereco, caminho, configurada: enderecoValido(endereco) && caminhoValido(caminho) };
  }

  /** Um pedido por vez: cada chamada espera a anterior terminar (com sucesso ou falha). */
  function naFila(fn) {
    esperando++;
    const comecar = () => { esperando--; return fn(); };
    const p = fila.then(comecar, comecar);
    fila = p.then(() => {}, () => {});
    return p;
  }

  function anotar(c, resultado) {
    const impressao = impressaoDe(c);
    if (resultado === 'ok') falha = null;
    else if (!falha || falha.impressao !== impressao) falha = { desde: agora(), impressao };
  }

  /**
   * GET de uma rota da v1 com os parâmetros dados (lista de [nome, valor]). → JSON do 200. Falha → ErroCatalogo;
   * 400 com cursor → CursorRecusado; `sinal` (orçamento da chamada) esgotado → SemTempo. `previa`: recusa com
   * `ocupado` se a fila já tem MAX_ESPERA_PREVIA esperando. O token só existe dentro desta função.
   */
  async function pedir(c, rota, params = [], { comCursor = false, sinal = null, previa = false } = {}) {
    if (!c.configurada) throw new ErroCatalogo('nao_configurada');
    if (previa && esperando >= MAX_ESPERA_PREVIA) throw new ErroCatalogo('ocupado');
    return naFila(async () => {
      if (sinal?.aborted) throw new SemTempo();
      const lido = await lerToken(c.caminho);
      if (!lido.token) throw new ErroCatalogo(lido.resultado);
      const url = new URL(rota, `${c.endereco}/`);
      for (const [k, v] of params) url.searchParams.append(k, String(v));
      const limite = AbortSignal.timeout(timeoutMs);
      let r;
      try {
        r = await doFetch(url.href, {
          method: 'GET', redirect: 'error', signal: sinal ? AbortSignal.any([limite, sinal]) : limite,
          headers: { Authorization: `Bearer ${lido.token}` },
        });
      } catch {
        if (sinal?.aborted) throw new SemTempo();
        throw new ErroCatalogo('fora_do_ar');
      }
      const status = Number(r?.status) || 0;
      if (status !== 200) {
        try { await r?.body?.cancel?.(); } catch { /* corpo já fechado */ }
        if (status === 401) throw new ErroCatalogo('token_recusado');
        if (status === 503) throw new ErroCatalogo('desligada');
        if (status === 400 && comCursor) throw new CursorRecusado();
        if (status >= 500 || status === 0) throw new ErroCatalogo('fora_do_ar');
        throw new ErroCatalogo('resposta_inesperada');
      }
      const { json, recusado } = await lerCorpoLimitado(r, MAX_CORPO);
      if (sinal?.aborted && (recusado || !json)) throw new SemTempo();
      if (recusado || !json) throw new ErroCatalogo('resposta_inesperada');
      return json;
    });
  }

  function lerVerificacao() {
    const v = lerJson(getSetting(db, CHAVE_VERIFICACAO, '{}'));
    return Object.hasOwn(ESTADO_DO_RESULTADO, v.resultado) ? v : null;
  }

  async function testar() {
    const c = conexao();
    const vazio = { total: 0, categorias: [] };
    if (!c.configurada) return { ok: false, resultado: 'nao_configurada', mensagem: fraseDoTeste('nao_configurada'), ...vazio };
    let resultado = 'ok'; let dados = null;
    try {
      dados = lerCategorias(await pedir(c, '/api/v1/categorias'));
      if (!dados) resultado = 'resposta_inesperada';
    } catch (e) {
      resultado = e instanceof ErroCatalogo ? e.resultado : 'fora_do_ar';
    }
    anotar(c, resultado);
    const anterior = lerVerificacao();
    const guardar = resultado === 'ok' ? dados
      : (anterior && Array.isArray(anterior.categorias) ? { categorias: anterior.categorias, total: anterior.total ?? 0 } : vazio);
    setSetting(db, CHAVE_VERIFICACAO, JSON.stringify({
      resultado, verificado_em: agora(), impressao: impressaoDe(c), total: guardar.total, categorias: guardar.categorias,
    }));
    if (resultado !== 'ok') {
      return { ok: false, resultado, mensagem: fraseDoTeste(resultado, { endereco: c.endereco, caminho: c.caminho }), ...vazio };
    }
    return {
      ok: true, resultado, total: dados.total, categorias: dados.categorias,
      mensagem: fraseDoTeste('ok', { total: dados.total, categorias: dados.categorias.length }),
    };
  }

  function situacao() {
    const c = conexao();
    if (!c.configurada) return { estado: 'falta_configurar', resultado: 'nao_configurada', verificado_em: null, falha_desde: null };
    const impressao = impressaoDe(c);
    const v = lerVerificacao();
    const candidatas = [
      v && v.impressao === impressao && Number.isFinite(v.verificado_em) ? { resultado: v.resultado, em: v.verificado_em } : null,
      ultimaChamada && ultimaChamada.impressao === impressao ? ultimaChamada : null,
    ].filter(Boolean).sort((a, b) => b.em - a.em);
    const falhaDesde = falha && falha.impressao === impressao ? falha.desde : null;
    if (!candidatas.length) return { estado: 'salva', resultado: null, verificado_em: null, falha_desde: falhaDesde };
    const u = candidatas[0];
    return { estado: ESTADO_DO_RESULTADO[u.resultado], resultado: u.resultado, verificado_em: u.em, falha_desde: u.resultado === 'ok' ? null : falhaDesde };
  }

  function ultimaVerificacao() {
    const v = lerVerificacao();
    if (!v) return null;
    return {
      resultado: v.resultado, verificado_em: Number.isFinite(v.verificado_em) ? v.verificado_em : null,
      total: inteiroValido(v.total) ? v.total : 0, categorias: Array.isArray(v.categorias) ? v.categorias : [],
    };
  }

  // ------------------------------------------------------------------------ confirmação de preço (Amazon)

  const falhaConfirmar = (causa) => ({ resultado: 'falha', causa });

  /** Corpo do 200 da confirmação → resultado do confirmarPreco; fora do contrato → resposta_inesperada. */
  function lerConfirmacao(json) {
    if (!json || typeof json !== 'object' || Array.isArray(json) || json.versao !== 1) return falhaConfirmar('resposta_inesperada');
    switch (json.resultado) {
      case 'sem_preco': case 'outro_produto': return { resultado: json.resultado };
      case 'bloqueado': case 'falha_rede': return falhaConfirmar(json.resultado);
      case 'confirmado': break;
      default: return falhaConfirmar('resposta_inesperada');
    }
    const positivo = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= PRECO_MAX;
    const { preco, preco_antigo: antigo, desconto_pct: desconto } = json;
    const precoEm = lerPrecoEm(json.preco_em);
    if (!positivo(preco) || precoEm == null) return falhaConfirmar('resposta_inesperada');
    if (antigo != null && !positivo(antigo)) return falhaConfirmar('resposta_inesperada');
    if (desconto != null && !(typeof desconto === 'number' && Number.isFinite(desconto) && desconto >= 0 && desconto <= 100)) {
      return falhaConfirmar('resposta_inesperada');
    }
    return {
      resultado: 'confirmado', preco,
      precoAntigo: antigo != null && antigo > preco ? antigo : null, // como no paraCandidato: só o maior que o preço
      descontoPct: desconto != null ? Math.round(desconto) : null,
      precoEm,
    };
  }

  /**
   * O 429 do freio da confirmação → { resultado:'falha', causa:'freio', motivo, tentarEmS }. `motivo`: um de
   * MOTIVOS_FREIO ou null (corpo fora do contrato); `tentarEmS`: inteiro ≥ 1 do corpo (`tentar_em_s`) ou, sem ele,
   * do cabeçalho Retry-After; null se nenhum dos dois vale.
   */
  async function lerFreio(r) {
    const { json } = await lerCorpoLimitado(r, MAX_CORPO_CONFIRMAR);
    const doCorpo = json && typeof json === 'object' && !Array.isArray(json) && json.versao === 1 && json.resultado === 'freio' ? json : {};
    const motivo = MOTIVOS_FREIO.includes(doCorpo.motivo) ? doCorpo.motivo : null;
    const segundos = (v) => (Number.isSafeInteger(v) && v >= 1 ? v : null);
    const cabecalho = r?.headers?.get?.('retry-after');
    const tentarEmS = segundos(doCorpo.tentar_em_s) ?? (typeof cabecalho === 'string' && /^\d{1,7}$/.test(cabecalho.trim()) ? segundos(Number(cabecalho)) : null);
    return { ...falhaConfirmar('freio'), motivo, tentarEmS };
  }

  /**
   * Pede ao Etiqueta para reler a página de um produto da Amazon (POST /api/v1/amazon/<ASIN>/confirmar-preco).
   * → { resultado:'confirmado', preco, precoAntigo|null, descontoPct|null, precoEm } | { resultado:'sem_preco' } |
   * { resultado:'outro_produto' } | { resultado:'falha', causa }. causa: bloqueado | falha_rede (o Etiqueta não
   * leu a Amazon) | freio (429; vem com `motivo` e `tentarEmS`, ver lerFreio) | nao_encontrado (404, ou ASIN fora de
   * [A-Z0-9]{10}, que o Etiqueta recusaria com 404) | fora_do_ar (rede, tempo, 5xx) | token_recusado (401) |
   * desligada (503) | resposta_inesperada (3xx, 400/403/405, JSON fora do contrato, preço acima de PRECO_MAX) |
   * nao_configurada (sem endereço e caminho válidos, ou sem token legível no arquivo). Nunca lança. Na fila única,
   * POST sem corpo, só Authorization, redirect:'error', mesmo timeout por pedido e corpo limitado. Não muda
   * situacao(): ela fala da lista de ofertas, não da releitura. O token só existe dentro desta função.
   * Freio curto (429 `intervalo` ou `ocupado` com espera de até ESPERA_FREIO_CURTO_MAX_S): espera o `tentar_em_s`
   * ainda dentro da fila (nenhum outro pedido passa na frente) e pede de novo, até NOVAS_TENTATIVAS_FREIO vezes; assim
   * duas Amazon seguidas são as duas relidas. Os outros motivos voltam na hora (quem chama decide a pausa).
   */
  async function confirmarPreco(asin) {
    try {
      if (typeof asin !== 'string' || !RE_ASIN.test(asin)) return falhaConfirmar('nao_encontrado');
      const c = conexao();
      if (!c.configurada) return falhaConfirmar('nao_configurada');
      return await naFila(async () => {
        const lido = await lerToken(c.caminho);
        if (!lido.token) return falhaConfirmar('nao_configurada');
        const url = new URL(`/api/v1/amazon/${asin}/confirmar-preco`, `${c.endereco}/`);
        for (let tentativa = 0; ; tentativa++) {
          let r;
          try {
            r = await doFetch(url.href, {
              method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
              headers: { Authorization: `Bearer ${lido.token}` },
            });
          } catch { return falhaConfirmar('fora_do_ar'); }
          const status = Number(r?.status) || 0;
          if (status === 429) {
            const freio = await lerFreio(r);
            const curto = FREIO_CURTO.includes(freio.motivo) && freio.tentarEmS != null && freio.tentarEmS <= ESPERA_FREIO_CURTO_MAX_S;
            if (!curto || tentativa >= NOVAS_TENTATIVAS_FREIO) return freio;
            await esperar(freio.tentarEmS * 1000);
            continue;
          }
          if (status !== 200) {
            try { await r?.body?.cancel?.(); } catch { /* corpo já fechado */ }
            if (status === 401) return falhaConfirmar('token_recusado');
            if (status === 503) return falhaConfirmar('desligada');
            if (status === 404) return falhaConfirmar('nao_encontrado');
            if (status >= 500 || status === 0) return falhaConfirmar('fora_do_ar');
            return falhaConfirmar('resposta_inesperada');
          }
          const { json, recusado } = await lerCorpoLimitado(r, MAX_CORPO_CONFIRMAR);
          if (recusado || !json) return falhaConfirmar('resposta_inesperada');
          return lerConfirmacao(json);
        }
      });
    } catch {
      return falhaConfirmar('resposta_inesperada');
    }
  }

  // --------------------------------------------------------------------------------------- cursores

  const cursorDe = (ruleId, filtro) => db.prepare('SELECT cursor, pronto FROM catalogo_cursores WHERE rule_id = ? AND filtro = ?').get(ruleId, filtro) ?? null;
  function gravarCursor(ruleId, filtro, cursor, pronto) {
    db.prepare(`INSERT INTO catalogo_cursores (rule_id, filtro, cursor, pronto, atualizado_em) VALUES (?,?,?,?,?)
      ON CONFLICT(rule_id, filtro) DO UPDATE SET cursor = excluded.cursor, pronto = excluded.pronto, atualizado_em = excluded.atualizado_em`)
      .run(ruleId, filtro, cursor, pronto ? 1 : 0, agora());
  }

  /** cfg.preco_max_horas não é campo da fonte: candidatos() o põe numa cópia (nunca entra no filtroDe). */
  function parametros(cfg, cursor) {
    const p = [];
    for (const x of cfg.categorias) p.push(['cat', x]);
    for (const x of cfg.lojas) p.push(['loja', x]);
    if (cfg.q) p.push(['q', cfg.q]);
    if (cfg.desconto_min != null) p.push(['desconto_min', cfg.desconto_min]);
    if (cfg.preco_max_horas != null) p.push(['preco_max_horas', cfg.preco_max_horas]);
    p.push(['ordem', cfg.ordem], ['limite', LIMITE]);
    if (cursor != null) p.push(['cursor', cursor]);
    return p;
  }

  async function pagina(c, cfg, cursor, opcoes = {}) {
    const json = await pedir(c, '/api/v1/ofertas', parametros(cfg, cursor), { ...opcoes, comCursor: cursor != null && cfg.ordem === 'atualizacao' });
    const p = lerPagina(json);
    if (!p) throw new ErroCatalogo('resposta_inesperada');
    return p;
  }

  /**
   * Avança até o fim sem devolver ofertas (primeira leitura de Novidades). Sem tempo depois de alguma página:
   * devolve até onde chegou (a próxima execução continua dali). Sem tempo antes: fora_do_ar.
   */
  async function avancarAteOFim(c, cfg, cursorInicial, sinal) {
    let cursor = cursorInicial; let fim = false; let lidas = 0;
    for (let i = 0; i < PAGINAS_FIM; i++) {
      let p;
      try { p = await pagina(c, cfg, cursor, { sinal }); } catch (e) {
        if (!(e instanceof SemTempo)) throw e;
        if (!lidas) throw new ErroCatalogo('fora_do_ar');
        break;
      }
      lidas++;
      if (!p.ofertas.length) { fim = true; break; }
      if (p.proximo == null || p.proximo === cursor) break; // fora do contrato na ordem atualizacao: para aqui
      cursor = p.proximo;
    }
    return { cursor, fim };
  }

  async function candidatos(config, ctx = {}) {
    const cfg = limparFonteCatalogo(config); // cópia nova: o campo abaixo não volta para a regra
    // idade larga só quando cada oferta da fonte será conferida na hora (CA1.11); filtroDe(cfg) a ignora
    if (ctx.conferenciaNaHora === true && cfg.lojas.length && cfg.lojas.every((l) => LOJAS_CONFERIDAS_NA_HORA.includes(l))) {
      cfg.preco_max_horas = IDADE_CATALOGO_CONFERIDO_H;
    }
    const c = conexao();
    if (!c.configurada) throw new ErroCatalogo('nao_configurada');
    const ruleId = ctx.rule?.id;
    const fonteIndex = Number.isInteger(ctx.fonteIndex) ? ctx.fonteIndex : 0;
    const filtro = filtroDe(cfg);
    const novidades = cfg.ordem === 'atualizacao';
    const modo = novidades ? 'novidades' : 'ordem';
    const previa = ctx.previa === true;
    const avisar = (m) => { if (previa) return; try { ctx.onWarn?.(m); } catch { /* aviso não derruba a leitura */ } };
    const jaTratada = (cand) => { try { return !!ctx.tratada?.(cand, cfg.ordem); } catch { return false; } };
    // sem o predicado (testes, chamadas antigas), toda não tratada conta para o alvo
    const podeUsar = (cand) => { if (typeof ctx.utilizavel !== 'function') return true; try { return !!ctx.utilizavel(cand); } catch { return false; } };
    const outraFonte = ctx.vistas instanceof Set ? ctx.vistas : new Set();
    const registrar = (entrada) => { if (ctx.paginas instanceof Map) ctx.paginas.set(fonteIndex, { filtro, fonteIndex, ...entrada }); };
    const sinal = AbortSignal.timeout(Math.max(1, Number(orcamentoMs) || ORCAMENTO_PADRAO));
    const opcoes = { sinal, previa };
    const AVISO_CURSOR = 'Catálogo do Etiqueta: o cursor salvo foi recusado. A leitura recomeça do fim do catálogo; só o que chegar ou for atualizado depois sai.';

    /** Cursor recusado: avisa e avança até o fim a partir do começo (um novo 400 aqui é resposta inesperada). */
    async function recomecarDoFim() {
      avisar(AVISO_CURSOR);
      let fimNovo;
      try { fimNovo = await avancarAteOFim(c, cfg, null, sinal); } catch (e) {
        if (e instanceof CursorRecusado) throw new ErroCatalogo('resposta_inesperada');
        throw e;
      }
      registrar({ modo: 'fim', cursor: fimNovo.cursor, fim: fimNovo.fim });
      concluir(c, 'ok');
      return [];
    }

    const resultadoDe = (e) => (e instanceof ErroCatalogo ? e.resultado : 'fora_do_ar');
    try {
      const salvo = novidades && ruleId != null ? cursorDe(ruleId, filtro) : null;
      if (novidades && !(salvo && salvo.pronto)) {
        // a pré-visualização nunca faz a leitura até o fim (S3): sem rede, lista vazia
        if (previa) { registrar({ modo: 'primeira_leitura' }); return []; }
        let fim;
        try { fim = await avancarAteOFim(c, cfg, salvo?.cursor ?? null, sinal); } catch (e) {
          if (!(e instanceof CursorRecusado)) throw e;
          return await recomecarDoFim(); // R2: cursor de uma primeira leitura pela metade recusado
        }
        registrar({ modo: 'fim', cursor: fim.cursor, fim: fim.fim });
        concluir(c, 'ok');
        return [];
      }

      const alvo = Math.max((Number(ctx.quer) || 1) * 4, 20);
      const paginas = []; const out = []; const vistas = new Set();
      let cursor = novidades ? salvo.cursor : null; let ignoradas = 0; let uteis = 0;
      for (let i = 0; i < PAGINAS_LEITURA && uteis < alvo; i++) {
        let p;
        try { p = await pagina(c, cfg, cursor, opcoes); } catch (e) {
          if (e instanceof SemTempo) {
            if (!paginas.length) throw new ErroCatalogo('fora_do_ar');
            avisar('Catálogo do Etiqueta: a leitura passou do tempo e parou; o resto fica para a próxima execução.');
            break;
          }
          if (!(e instanceof CursorRecusado)) throw e;
          if (previa) return [];
          return await recomecarDoFim();
        }
        const daPagina = [];
        for (const o of p.ofertas) {
          const cand = paraCandidato(o);
          if (!cand) { ignoradas++; continue; }
          if (outraFonte.has(cand.key)) continue; // R11: outra fonte da regra já trouxe; conta como tratada aqui
          daPagina.push(cand);
          if (vistas.has(cand.key)) continue;
          vistas.add(cand.key);
          if (!jaTratada(cand)) {
            out.push(cand);
            if (podeUsar(cand)) uteis++;
          }
        }
        paginas.push({ cursor, proximo: p.proximo, vazia: !p.ofertas.length, candidatos: daPagina });
        if (!p.ofertas.length || p.proximo == null || p.proximo === cursor) break;
        cursor = p.proximo;
      }
      if (ignoradas) avisar(`Catálogo do Etiqueta: ${plural(ignoradas, 'oferta ignorada', 'ofertas ignoradas')} por estar fora do formato esperado.`);
      registrar({ modo, cursorInicial: novidades ? salvo.cursor : null, paginas });
      concluir(c, 'ok');
      return out;
    } catch (e) {
      if (e instanceof ErroCatalogo) { concluir(c, resultadoDe(e)); throw new ErroCatalogo(e.resultado); }
      throw e; // erro de validação da fonte (frase fixa) ou de banco
    }
  }

  /** A fonte é Novidades e ainda não terminou a primeira leitura (cursor não pronto)? Sem rede; config inválida → false. */
  function primeiraLeitura(ruleId, config) {
    let cfg;
    try { cfg = limparFonteCatalogo(config); } catch { return false; }
    if (cfg.ordem !== 'atualizacao') return false;
    return !cursorDe(ruleId, filtroDe(cfg))?.pronto;
  }

  function concluir(c, resultado) {
    if (resultado === 'nao_configurada' || resultado === 'ocupado') return; // ocupado: a fila daqui, não o Etiqueta
    ultimaChamada = { resultado, em: agora(), impressao: impressaoDe(c) };
    anotar(c, resultado);
  }

  const regraExiste = (ruleId) => !!db.prepare('SELECT 1 FROM rules WHERE id = ?').get(ruleId);

  function avancar(ruleId, paginas, tratada) {
    const out = [];
    if (!(paginas instanceof Map) || !regraExiste(ruleId)) return out;
    const foiTratada = (cand) => { try { return !!tratada?.(cand, 'atualizacao'); } catch { return false; } };
    for (const e of paginas.values()) {
      if (!e || typeof e.filtro !== 'string') continue;
      if (e.modo === 'fim') {
        const atual = cursorDe(ruleId, e.filtro);
        gravarCursor(ruleId, e.filtro, e.cursor ?? atual?.cursor ?? null, e.fim);
        out.push({ fonteIndex: e.fonteIndex, filtro: e.filtro, paginas_avancadas: 0, pronto: !!e.fim });
        continue;
      }
      if (e.modo !== 'novidades') continue;
      let cursor = e.cursorInicial ?? null; let n = 0;
      for (const p of e.paginas || []) {
        if (p.vazia || p.proximo == null) break; // vazio com proximo:null não muda o cursor
        if (!p.candidatos.every(foiTratada)) break; // oferta fora do formato (fora de candidatos) não segura a página
        cursor = p.proximo; n++;
      }
      if (n) gravarCursor(ruleId, e.filtro, cursor, true);
      out.push({ fonteIndex: e.fonteIndex, filtro: e.filtro, paginas_avancadas: n, pronto: true });
    }
    return out;
  }

  function recomecar(ruleId) {
    const regra = parseRule(db.prepare('SELECT * FROM rules WHERE id = ?').get(ruleId));
    if (!regra) return 0;
    const filtros = new Set();
    for (const s of regra.sources || []) {
      if (s?.type !== 'catalogo') continue;
      let cfg;
      try { cfg = limparFonteCatalogo(s.config); } catch { continue; }
      if (cfg.ordem === 'atualizacao') filtros.add(filtroDe(cfg));
    }
    const trocar = () => {
      db.prepare('DELETE FROM catalogo_cursores WHERE rule_id = ?').run(ruleId);
      for (const filtro of filtros) gravarCursor(ruleId, filtro, null, true);
    };
    if (db.isTransaction === true) trocar(); // já dentro da transação de quem chamou
    else {
      db.exec('BEGIN IMMEDIATE');
      try { trocar(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
    }
    return filtros.size;
  }

  function esquecerRegra(ruleId) {
    db.prepare('DELETE FROM catalogo_cursores WHERE rule_id = ?').run(ruleId);
  }

  return { testar, situacao, ultimaVerificacao, candidatos, primeiraLeitura, avancar, recomecar, esquecerRegra, confirmarPreco };
}
