// Importador de comissões e cliques por CSV (docs/produto/planos/dashboard-ganhos.md, D7, D8 e etapa 14).
// O dono baixa o relatório no portal da loja e envia pelo painel (corpo cru text/csv, só Dono). O arquivo é lido
// em memória (src/csv.js, que também abre o .zip com um único CSV da Amazon) e nunca vai ao disco; de `importacoes`
// fica só o sha256 dele (do que foi enviado: o .zip, quando veio .zip).
// Formatos reais (P5): docs/produto/referencias/relatorios-dos-portais.md. Com loja=amazon, a data `NN-NN-AAAA` com
// hífen é mês-dia-ano; célula "-" é vazia (0 nos números); relatório sem coluna de data (o "ID de rastreamento" da
// Amazon) pede o parâmetro `dia`, mas só se nenhuma coluna tem cara de data (R1); relatório de cliques com uma linha
// por clique (Shopee) conta 1 por linha; em comissões, a linha só de cliques (comissão, venda e quantidade 0) não é
// gravada e conta em `so_cliques` (R2).
// Lista branca (LGPD): só as colunas de COLUNAS são lidas (data, código, produto, título, quantidade, venda,
// comissão, status, devoluções, cliques e o pedido); "Número de rastreamento" e afins só na Amazon (S1).
// Nome, endereço, telefone, e-mail ou documento de comprador
// nunca são lidos; a resposta lista só os NOMES das colunas ignoradas. O pedido só entra no hash da `chave`.
// Dedupe: `chave` por (loja, chave) em comissoes; reimportar não duplica, pendente → confirmada atualiza a linha.
// A chave é HMAC-SHA256 com a `pseudo_key` local (src/privacidade.js), 32 hex: com pedido, de (loja, pedido,
// produto, código da coluna); sem pedido, de (loja, data, produto, código efetivo = o da coluna ou, com a célula
// vazia, o "Código do arquivo" do parâmetro). A n-ésima linha com a mesma base no arquivo ganha `#n` (com pedido,
// a primeira fica sem sufixo; sem pedido, toda linha leva `#n`). Valores e status ficam fora da chave: baixar de
// novo com valor revisado atualiza a linha. Sem pedido, o código do arquivo separa grupos (R11): outro código é
// outra linha; mas a linha que entrou sem código nenhum é a mesma venda e ganha o código (R4, `chave_sem_codigo`).
// Com pedido, o pedido já separa as vendas e o código do parâmetro fica fora da chave (preencher só atualiza).
// Cliques: total por (loja, dia, código); a última importação vale (substitui, não soma).
// Avisos de código (Entrega C, D1): a prévia e o resumo contam as linhas novas sem pedido com a mesma data e produto
// de vendas já gravadas com outro código ou sem código (`outro_codigo`) e as linhas sem código que vão receber o
// código do arquivo (`recebem_codigo`). Só contagem e frase fixa: não bloqueiam nem mudam o que é gravado.
// Uma linha pertence à importação que a criou: apagar uma importação apaga só as linhas criadas por ela.
// Rotas (montarRotas, todas só do Dono, inclusive GET, P2):
//   POST /api/ganhos/importar?loja=&tipo=comissoes|cliques&codigo=&dia=AAAA-MM-DD&previa=1 (corpo text/csv ou
//   text/plain, até 5 MB; CSV ou .zip com um CSV) → resumo; GET /api/ganhos/importacoes → { importacoes };
//   DELETE /api/ganhos/importacoes/:id.
// Erros: { erro } com frase fixa (MENSAGENS_IMPORTADOR, MENSAGENS_CSV), sem nada do conteúdo do arquivo.

import crypto from 'node:crypto';
import express from 'express';
import { lerCsv, ErroCsv, MENSAGENS_CSV, MAX_BYTES_ARQUIVO } from './csv.js';
import { LOJAS } from './rastreio.js';
import { chavePseudo } from './privacidade.js';

export { MAX_BYTES_ARQUIVO, MAX_LINHAS_ARQUIVO, MAX_COLUNAS_ARQUIVO, MAX_CARACTERES_CELULA } from './csv.js';

export const TIPOS = Object.freeze(['comissoes', 'cliques']);
/** O cabeçalho é procurado nas primeiras linhas (o relatório da Amazon pode trazer um título antes). */
export const LINHAS_PARA_CABECALHO = 20;
export const MAX_TITULO = 200;
/** Código de rastreio (da coluna ou do parâmetro `codigo`). */
export const MAX_CODIGO = 100;
/** Números de linha puladas que a resposta lista (sem o conteúdo delas). */
export const MAX_LINHAS_IGNORADAS_LISTADAS = 5;
const MAX_CODIGOS_DESCONHECIDOS = 20;
const MAX_NOME_COLUNA = 80;
const MAX_IMPORTACOES_LISTADAS = 100;
const RE_PRODUTO = /^[A-Za-z0-9._:-]{1,40}$/; // ASIN, MLB…, SHOPEE:<loja>.<item>
const RE_ASIN = /^(?:ASIN:)?[A-Z0-9]{10}$/i; // na Amazon, o resto (a linha "Other" do relatório) não é produto
const RE_DIA = /^\d{4}-\d{2}-\d{2}$/;
/** Célula que o portal preenche com "-" quando não há valor (Amazon): vazia, ou 0 nos números. */
const TRACO = '-';
const RE_CONTROLE = /[\u0000-\u001f\u007f]/;

/**
 * Sinônimos de cabeçalho por campo, já normalizados (normalizarNome): ajustar formato é só acrescentar sinônimo
 * aqui. Os da Amazon ("Produto relacionado" em inglês e "ID de rastreamento" em português) e os do relatório de
 * cliques da Shopee vêm dos relatórios reais (P5); os outros seguem prováveis. Quando duas colunas casam com o
 * mesmo campo, vale a do sinônimo que vem antes na lista (Total Earnings antes de Items Shipped Earnings).
 * A ordem dos campos é a de `colunas_usadas` na resposta. `id_clique` (uma linha por clique) só é lido para contar.
 */
export const COLUNAS = Object.freeze({
  data: ['data', 'data do pedido', 'hora do pedido', 'horario do pedido', 'data da venda', 'data da compra', 'data de envio', 'date shipped',
    'order time', 'order date', 'purchase time', 'data da conversao', 'date', 'dia', 'day', 'data do clique', 'hora do clique', 'click time',
    'periodo dos cliques'],
  pedido: ['id do pedido', 'order id', 'checkout id', 'numero do pedido', 'id da compra', 'pedido'],
  loja_id: ['id da loja', 'shop id'],
  produto: ['asin', 'mlb', 'id do item', 'item id', 'id do produto', 'product id', 'codigo do produto'],
  titulo: ['titulo', 'titulo do produto', 'nome do item', 'nome do produto', 'item name', 'product name', 'product title'],
  codigo: ['sub id1', 'sub id 1', 'subid1', 'sub id', 'subid', 'tracking id', 'id de rastreamento', 'etiqueta', 'numero de rastreamento'],
  venda: ['valor de compra', 'valor da compra', 'valor da venda', 'purchase value', 'order amount', 'revenue', 'receita', 'valor do pedido',
    'items shipped revenue', 'receita de produtos enviados'],
  comissao: ['ad fees', 'taxas de publicidade', 'comissao total do item', 'comissao do item', 'comissao', 'commission',
    'total commission', 'net commission', 'comissao total', 'comissao liquida', 'ganhos', 'comissao total do pedido',
    'total earnings', 'items shipped earnings', 'ganhos totais'],
  status: ['status', 'status do pedido', 'order status', 'status da conversao', 'conversion status', 'situacao'],
  quantidade: ['items shipped', 'itens enviados', 'quantidade', 'qtd', 'qty', 'quantity', 'produtos enviados'],
  devolucoes: ['returns', 'devolucoes', 'itens devolvidos', 'items returned', 'produtos devolvidos'],
  cliques: ['clicks', 'cliques', 'total de cliques'],
  id_clique: ['id dos cliques'],
});
/**
 * Sinônimos que só valem com loja=amazon (S1): nas outras lojas, "Número de rastreamento" ou "Tracking ID" pode ser
 * o código de envio dos Correios de um comprador (dado pessoal); lá a coluna fica nas ignoradas e não é lida.
 */
const SO_DA_AMAZON = new Set(['tracking id', 'id de rastreamento', 'numero de rastreamento']);
/** Nome (normalizado) com cara de data: sem coluna de data reconhecida, ele impede de usar a data do relatório (R1). */
// começo de palavra ("media"/"mediana" não contam, R7/Q1) ou date/time no fim (OrderDate, ClickTime colados)
const RE_CARA_DE_DATA = /\b(?:data|date|hora|horario|time|periodo|dia)|(?:date|time)\b/;
const CAMPOS = Object.freeze({
  comissoes: ['data', 'pedido', 'loja_id', 'produto', 'titulo', 'codigo', 'venda', 'comissao', 'status', 'quantidade', 'devolucoes'],
  cliques: ['data', 'codigo', 'cliques', 'id_clique'],
});
/** Campos que bastam (um deles) para reconhecer o cabeçalho do tipo, além da data. */
const OBRIGATORIO = Object.freeze({ comissoes: ['comissao'], cliques: ['cliques', 'id_clique'] });

const formato = 'O portal pode ter mudado o formato. Mande o arquivo de exemplo para a equipe ajustar.';
export const MENSAGENS_IMPORTADOR = Object.freeze({
  loja: 'Escolha a loja do arquivo: Shopee, Amazon ou Mercado Livre.',
  tipo: 'Escolha o tipo do relatório: comissões ou cliques.',
  codigo: 'O código do arquivo tem caractere inválido ou passa de 100 caracteres.',
  semData: 'Este relatório não tem data por linha: informe a data do relatório.',
  dataDesconhecida: `Não reconheci a coluna de data deste relatório. ${formato}`,
  semComissao: `Não encontrei a coluna de comissão (esperada: Comissão, Commission ou Ad Fees). ${formato}`,
  semCliques: `Não encontrei a coluna de cliques (esperada: Cliques ou Clicks). ${formato}`,
  naoAchei: 'Importação não encontrada.',
  recebimento: 'Não consegui receber o arquivo. Tente de novo.',
  interno: 'Não consegui importar agora. Nada foi salvo. Tente de novo; se repetir, veja o histórico do programa.',
  falha: 'Não consegui concluir. Tente de novo.',
  previa: 'O parâmetro de prévia veio repetido ou inválido. Mande previa=1 uma vez só.',
  semStatus: 'O arquivo não tem coluna de status: as vendas entram como pendentes.',
  jaImportado: 'Este arquivo já foi importado antes. As linhas repetidas não mudam nada.',
  dia: 'A data do relatório veio inválida ou repetida. Escolha uma data válida (AAAA-MM-DD).',
  diaUsado: 'O relatório não tem data por linha: todas as linhas usam a data do relatório informada.',
  diaIgnorado: 'O arquivo tem data em cada linha: a data do relatório informada não vale para ele.',
  soCliques: Object.freeze([
    '1 linha só tem cliques (sem venda nem comissão) e ficou de fora. Os cliques entram ao importar o arquivo como cliques.',
    '{n} linhas só têm cliques (sem venda nem comissão) e ficaram de fora. Os cliques entram ao importar o arquivo como cliques.',
  ]),
  // [singular, plural] montadas com plural(n, ...); só a contagem entra no texto (nada do arquivo nem do código)
  outroCodigoPrevia: Object.freeze([
    '1 linha tem a mesma data e produto de uma venda já importada com outro código (ou sem código). Se for o mesmo relatório importado de novo, não importe: a venda contaria em dobro.',
    '{n} linhas têm a mesma data e produto de vendas já importadas com outro código (ou sem código). Se for o mesmo relatório importado de novo, não importe: as vendas contariam em dobro.',
  ]),
  outroCodigoGravado: Object.freeze([
    '1 linha tem a mesma data e produto de uma venda já importada com outro código (ou sem código). Se era o mesmo relatório, apague esta importação em Importações recentes.',
    '{n} linhas têm a mesma data e produto de vendas já importadas com outro código (ou sem código). Se era o mesmo relatório, apague esta importação em Importações recentes.',
  ]),
  recebemCodigoPrevia: Object.freeze([
    '1 linha importada antes sem código vai receber o código deste arquivo. Se era de outro grupo, não importe: apague a importação antiga e importe os dois arquivos de novo, cada um com o seu código.',
    '{n} linhas importadas antes sem código vão receber o código deste arquivo. Se eram de outro grupo, não importe: apague a importação antiga e importe os dois arquivos de novo, cada um com o seu código.',
  ]),
  recebemCodigoGravado: Object.freeze([
    '1 linha importada antes sem código recebeu o código deste arquivo. Se era de outro grupo, apague a importação antiga e importe os dois arquivos de novo, cada um com o seu código.',
    '{n} linhas importadas antes sem código receberam o código deste arquivo. Se eram de outro grupo, apague a importação antiga e importe os dois arquivos de novo, cada um com o seu código.',
  ]),
});
const SEM_COLUNA = { data: 'semData', dataDesconhecida: 'dataDesconhecida', comissoes: 'semComissao', cliques: 'semCliques' };

/** Recusa com status HTTP e frase fixa (nunca com conteúdo do arquivo). */
export class ErroImportacao extends Error {
  constructor(status, mensagem) {
    super(mensagem);
    this.name = 'ErroImportacao';
    this.status = status;
  }
}
const recusar = (status, chave) => new ErroImportacao(status, MENSAGENS_IMPORTADOR[chave]);

// ---------- valores ----------

/** Nome de coluna para comparar com COLUNAS: minúsculas, sem acento, "R$" fora, "%" vira "pct", pontuação vira espaço. */
export function normalizarNome(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/r\$/g, ' ').replace(/%/g, ' pct ').replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Dinheiro → { centavos, milhar } ou null. BR e US: `R$ 1.234,56`, `1,234.56`, `-12,30`, `(12,30)`; com os dois
 * separadores, o último é o decimal; só vírgula = decimal; `1.234` (ponto e 3 dígitos, sem vírgula) = milhar, com
 * `milhar: true` para o aviso. Mais de 2 casas decimais: arredonda pela 3ª (meio para longe do zero).
 */
export function lerDinheiro(s) {
  if (typeof s !== 'string') return null;
  let t = s.replace(/\s/g, '');
  let negativo = false;
  const parenteses = /^\((.*)\)$/.exec(t);
  if (parenteses) { negativo = true; t = parenteses[1]; }
  const sinal = () => { if (/^[+-]/.test(t)) { if (t[0] === '-') negativo = !negativo; t = t.slice(1); return true; } return false; };
  const teveSinal = sinal();
  t = t.replace(/^(r\$|us\$|\$|brl|usd)/i, '');
  if (!teveSinal && !parenteses) sinal();
  if (!/^\d[\d.,]*\d$|^\d$/.test(t)) return null;
  const ponto = t.lastIndexOf('.');
  const virgula = t.lastIndexOf(',');
  let inteiro; let fracao = ''; let milhar = false;
  if (ponto >= 0 && virgula >= 0) {
    const dec = ponto > virgula ? '.' : ',';
    const mil = dec === '.' ? ',' : '.';
    const i = t.lastIndexOf(dec);
    inteiro = t.slice(0, i); fracao = t.slice(i + 1);
    if (!/^\d+$/.test(fracao) || inteiro.includes(dec)) return null;
    const grupos = new RegExp(`^\\d{1,3}(\\${mil}\\d{3})+$`);
    if (inteiro.includes(mil)) { if (!grupos.test(inteiro)) return null; inteiro = inteiro.split(mil).join(''); }
  } else if (virgula >= 0) {
    const partes = t.split(',');
    if (partes.length === 2) { [inteiro, fracao] = partes; } else if (/^\d{1,3}(,\d{3})+$/.test(t)) { inteiro = partes.join(''); } else return null;
  } else if (ponto >= 0) {
    const partes = t.split('.');
    const pareceMilhar = /^[1-9]\d{0,2}(\.\d{3})+$/.test(t); // 1.234 ou 1.234.567 (o 0.005 é decimal)
    if (pareceMilhar) { inteiro = partes.join(''); milhar = true; }
    else if (partes.length === 2) [inteiro, fracao] = partes;
    else return null;
  } else inteiro = t;
  if (!/^\d+$/.test(inteiro) || !/^\d*$/.test(fracao) || inteiro.length > 13) return null;
  const f = (fracao + '000').slice(0, 3);
  let centavos = Number(inteiro) * 100 + Number(f.slice(0, 2)) + (Number(f[2]) >= 5 ? 1 : 0);
  if (negativo && centavos !== 0) centavos = -centavos;
  return { centavos, milhar };
}

/**
 * Inteiro não negativo (quantidade, devoluções, cliques), com milhar por ponto ou vírgula (`1.234`) ou com casa
 * decimal zerada (`245.0`, `3,00`: a Amazon escreve assim); senão null (`1.5` não é inteiro).
 */
function lerInteiro(s) {
  const t = String(s ?? '').replace(/\s/g, '');
  let n = null;
  if (/^\d{1,10}$/.test(t)) n = Number(t);
  else if (/^\d{1,10}[.,]0{1,2}$/.test(t)) n = Number(t.split(/[.,]/)[0]);
  else if (/^\d{1,3}([.,]\d{3}){1,3}$/.test(t)) n = Number(t.replace(/[.,]/g, ''));
  return n !== null && n <= 1e9 ? n : null;
}

const diasNoMes = (a, m) => new Date(Date.UTC(a, m, 0)).getUTCDate();
/**
 * Data → 'AAAA-MM-DD' ou null: `AAAA-MM-DD`, `AAAA/MM/DD`, `DD/MM/AAAA`, `DD-MM-AAAA`, com hora ou fuso depois
 * (ignorados). Com `loja: 'amazon'`, `NN-NN-AAAA` com hífen é mês-dia-ano (`11-04-2026` = 4 de novembro, como no
 * relatório da Amazon); com barra continua dia/mês em todas as lojas.
 */
export function lerData(s, { loja } = {}) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  let a; let m; let d;
  let r = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:$|[ T])/.exec(t);
  if (r) [, a, m, d] = r;
  else if ((r = /^(\d{1,2})-(\d{1,2})-(\d{4})(?:$|[ T])/.exec(t))) [, d, m, a] = loja === 'amazon' ? [r[0], r[2], r[1], r[3]] : r;
  else if ((r = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:$|[ T])/.exec(t))) [, d, m, a] = r;
  else return null;
  [a, m, d] = [Number(a), Number(m), Number(d)];
  if (a < 2000 || a > 2100 || m < 1 || m > 12 || d < 1 || d > diasNoMes(a, m)) return null;
  return `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const STATUS = new Map([
  ...['concluido', 'concluida', 'completed', 'complete', 'validado', 'validada', 'validated', 'pago', 'paga', 'paid',
    'confirmado', 'confirmada', 'confirmed', 'aprovado', 'aprovada', 'approved'].map((s) => [s, 'confirmada']),
  ...['pendente', 'pending', 'nao pago', 'nao paga', 'unpaid', 'em andamento', 'processando', 'em processamento',
    'processing', 'aguardando', 'em revisao'].map((s) => [s, 'pendente']),
  ...['cancelado', 'cancelada', 'cancelled', 'canceled', 'invalido', 'invalida', 'invalid', 'devolvido', 'devolvida',
    'returned', 'refunded', 'reembolsado', 'reembolsada', 'rejeitado', 'rejeitada', 'rejected'].map((s) => [s, 'cancelada']),
]);
/** Status do portal → 'confirmada' | 'pendente' | 'cancelada'; desconhecido ou vazio → null. */
export function lerStatus(s) {
  return STATUS.get(normalizarNome(s)) ?? null;
}

/** Código de rastreio de uma célula ou do parâmetro: vazio → '', inválido (longo ou com controle) → null. */
function lerCodigo(s) {
  const t = String(s ?? '').trim();
  if (t === '') return '';
  return t.length > MAX_CODIGO || RE_CONTROLE.test(t) ? null : t;
}
const textoLimpo = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
/** Função (partes) → HMAC-SHA256 de 32 hex com a chave dada. A chave nunca sai daqui (nem em log). */
const criarHashChave = (segredo) => (partes) => crypto.createHmac('sha256', segredo).update(JSON.stringify(partes)).digest('hex').slice(0, 32);

// ---------- cabeçalho ----------

/** Liga cada campo do tipo à coluna da linha (o sinônimo que vem antes em COLUNAS vence; SO_DA_AMAZON só na Amazon). */
function mapear(celulas, campos, loja) {
  const melhor = {};
  celulas.forEach((c, idx) => {
    const n = normalizarNome(c);
    if (!n || (loja !== 'amazon' && SO_DA_AMAZON.has(n))) return;
    for (const campo of campos) {
      const p = COLUNAS[campo].indexOf(n);
      if (p >= 0 && (!melhor[campo] || p < melhor[campo].p)) melhor[campo] = { idx, p };
    }
  });
  return Object.fromEntries(Object.entries(melhor).map(([campo, { idx }]) => [campo, idx]));
}

/**
 * Procura o cabeçalho nas primeiras LINHAS_PARA_CABECALHO linhas: a primeira com um campo obrigatório do tipo
 * (comissão; cliques ou ID do clique) e com a data. `semDataOk` (veio a data do relatório, `dia`): a data por linha
 * pode faltar, mas só se nenhuma outra coluna tem cara de data (RE_CARA_DE_DATA), para não juntar num dia só um
 * relatório com data num formato de coluna que o painel não conhece (R1). Sem cabeçalho: erro dizendo o que faltou
 * (a coluna do tipo ou, achada ela, a data: 'semData' pede a data do relatório; 'dataDesconhecida' não pede).
 */
function acharCabecalho(linhas, tipo, { loja, semDataOk = false } = {}) {
  const campos = CAMPOS[tipo];
  const temObrigatorio = (mapa) => OBRIGATORIO[tipo].some((c) => mapa[c] !== undefined);
  let faltou = tipo;
  for (let i = 0; i < Math.min(linhas.length, LINHAS_PARA_CABECALHO); i++) {
    const mapa = mapear(linhas[i], campos, loja);
    if (!temObrigatorio(mapa)) continue;
    const usados = new Set(Object.values(mapa));
    const caraDeData = mapa.data === undefined && linhas[i].some((c, idx) => !usados.has(idx) && RE_CARA_DE_DATA.test(normalizarNome(c)));
    if (mapa.data !== undefined || (semDataOk && !caraDeData)) {
      return {
        indice: i,
        mapa,
        colunas_usadas: campos.filter((c) => mapa[c] !== undefined).map((campo) => ({ campo, coluna: textoLimpo(linhas[i][mapa[campo]]).slice(0, MAX_NOME_COLUNA) })),
        colunas_ignoradas: linhas[i].map((c, idx) => (usados.has(idx) ? '' : textoLimpo(c).slice(0, MAX_NOME_COLUNA))).filter(Boolean),
      };
    }
    if (faltou !== 'dataDesconhecida') faltou = caraDeData ? 'dataDesconhecida' : 'data';
  }
  throw recusar(400, SEM_COLUNA[faltou]);
}

// ---------- análise (sem banco) ----------

function validarOpcoes({ loja, tipo, codigo, dia } = {}) {
  if (typeof loja !== 'string' || !LOJAS.includes(loja)) throw recusar(400, 'loja');
  const t = tipo === undefined || tipo === null || tipo === '' ? 'comissoes' : tipo;
  if (typeof t !== 'string' || !TIPOS.includes(t)) throw recusar(400, 'tipo');
  if (codigo !== undefined && codigo !== null && typeof codigo !== 'string') throw recusar(400, 'codigo');
  const c = lerCodigo(codigo);
  if (c === null) throw recusar(400, 'codigo');
  // data do relatório (relatório sem data por linha): AAAA-MM-DD de um dia que existe; vazio = sem data
  const semDia = dia === undefined || dia === null || dia === '';
  if (!semDia && (typeof dia !== 'string' || !RE_DIA.test(dia) || lerData(dia) !== dia)) throw recusar(400, 'dia');
  return { loja, tipo: t, codigo: c || null, dia: semDia ? null : dia };
}

const plural = (n, um, varios) => (n === 1 ? um : varios).replace('{n}', n);

/**
 * Lê o arquivo e devolve o que seria importado, sem tocar no banco: { loja, tipo, codigo_arquivo, sha256,
 * colunas_usadas, colunas_ignoradas, lidas, ignoradas, linhas_ignoradas, so_cliques, registros, avisos }.
 * `so_cliques` (comissões; null em cliques): linhas com comissão, venda e quantidade 0 depois de lidas, que ficam
 * fora de `registros` (R2) e não contam como puladas.
 * `registros` (comissões): { chave, sem_pedido, data, codigo, produto, titulo, quantidade, venda_centavos,
 * comissao_centavos, status } e, sem pedido com o código do parâmetro, `chave_sem_codigo` (a chave sem o parâmetro,
 * para achar a linha importada antes sem código); (cliques): { dia, codigo, cliques }, já somados por dia e código.
 * O pedido não sai daqui. `opcoes.dia` (AAAA-MM-DD): a data de toda linha quando o arquivo não tem coluna de data.
 * `opcoes.hashChave(partes)` faz a chave (importar passa o HMAC com a chave local do banco). Sem ela, usa uma
 * chave aleatória desta chamada: as chaves só servem para comparar linhas do mesmo resultado, nunca para gravar.
 */
export function analisar(buf, opcoes = {}) {
  const { loja, tipo, codigo: codigoArquivo, dia: diaRelatorio } = validarOpcoes(opcoes);
  const hashChave = typeof opcoes.hashChave === 'function' ? opcoes.hashChave : criarHashChave(crypto.randomBytes(32));
  let csv;
  try { csv = lerCsv(buf); } catch (e) {
    if (e instanceof ErroCsv) throw new ErroImportacao(e.status, e.message);
    throw e;
  }
  const cab = acharCabecalho(csv.linhas, tipo, { loja, semDataOk: diaRelatorio !== null });
  const { mapa } = cab;
  const usaDia = mapa.data === undefined; // só sem coluna de data (e então veio `dia`)
  const dados = csv.linhas.slice(cab.indice + 1);
  if (dados.length === 0) throw new ErroImportacao(400, MENSAGENS_CSV.vazio);
  const numeros = csv.numeros.slice(cab.indice + 1);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

  let ignoradas = 0; let milhar = 0; let desconhecido = 0; let soCliques = 0;
  const linhasIgnoradas = [];
  const pular = (i) => { ignoradas++; if (linhasIgnoradas.length < MAX_LINHAS_IGNORADAS_LISTADAS) linhasIgnoradas.push(numeros[i]); };
  const codigoDe = (cel) => { const c = lerCodigo(cel('codigo')); return c === '' ? codigoArquivo : c; };
  const registros = [];
  // célula como veio (sem espaços nas pontas) e como valor: "-" é vazio; nos números, `traco` diz que vale 0
  const leitor = (linha) => {
    const bruto = (campo) => (mapa[campo] === undefined ? '' : String(linha[mapa[campo]] ?? '').trim());
    const cel = (campo) => { const v = bruto(campo); return v === TRACO ? '' : v; };
    return { cel, traco: (campo) => bruto(campo) === TRACO, data: () => (usaDia ? diaRelatorio : lerData(cel('data'), { loja })) };
  };

  if (tipo === 'cliques') {
    const somas = new Map();
    const porLinha = mapa.cliques === undefined; // relatório com uma linha por clique (ID do clique, sem total)
    dados.forEach((linha, i) => {
      const { cel, traco, data } = leitor(linha);
      const dia = data();
      const n = porLinha ? (cel('id_clique') ? 1 : null) : traco('cliques') ? 0 : lerInteiro(cel('cliques'));
      if (!dia || n === null) return pular(i);
      const codigo = formaDoCodigo(loja)(codigoDe(cel) ?? ''); // Amazon sem caixa (R15), como na atribuição
      const k = JSON.stringify([dia, codigo]);
      if (somas.has(k)) somas.get(k).cliques += n; else somas.set(k, { dia, codigo, cliques: n });
    });
    registros.push(...somas.values());
  } else {
    const iguais = new Map(); // quantas linhas com a mesma base de chave já vieram neste arquivo
    const iguaisSemParametro = new Map(); // o mesmo, contando como se o arquivo viesse sem o código do parâmetro
    const contar = (mapa, base) => { const n = (mapa.get(base) ?? 0) + 1; mapa.set(base, n); return n; };
    dados.forEach((linha, i) => {
      const { cel, traco, data: lerDataDaLinha } = leitor(linha);
      const data = lerDataDaLinha();
      const comissao = traco('comissao') ? { centavos: 0, milhar: false } : lerDinheiro(cel('comissao'));
      if (!data || !comissao) return pular(i);
      const venda = lerDinheiro(cel('venda'));
      let quantidade = traco('quantidade') ? 0 : lerInteiro(cel('quantidade')) ?? 1;
      const devolucoes = lerInteiro(cel('devolucoes')) ?? 0;
      const devolvida = devolucoes > 0 && devolucoes >= quantidade;
      if (!devolvida) quantidade -= devolucoes;
      // só cliques (R2: o produto com cliques e sem venda e a "Other" da Amazon): não é venda; os cliques vêm do tipo cliques
      if (comissao.centavos === 0 && (venda?.centavos ?? 0) === 0 && quantidade === 0) { soCliques++; return; }
      milhar += (comissao.milhar ? 1 : 0) + (venda?.milhar ? 1 : 0);
      let status = 'pendente';
      if (mapa.status !== undefined) { status = lerStatus(cel('status')); if (!status) { desconhecido++; status = 'pendente'; } }
      if (devolvida) status = 'cancelada';
      const item = cel('produto'); const lojaId = cel('loja_id');
      const p = loja === 'shopee' && item && lojaId ? `SHOPEE:${lojaId}.${item}` : item;
      const produto = RE_PRODUTO.test(p) && (loja !== 'amazon' || RE_ASIN.test(p)) ? p : null;
      const titulo = textoLimpo(cel('titulo')).slice(0, MAX_TITULO) || null;
      const codigo = codigoDe(cel);
      const valores = { data, codigo, produto, titulo, quantidade, venda_centavos: venda ? venda.centavos : 0, comissao_centavos: comissao.centavos, status };
      const codigoColuna = lerCodigo(cel('codigo')) ?? ''; // célula inválida conta como vazia (sem o parâmetro)
      const doParametro = codigoArquivo !== null && lerCodigo(cel('codigo')) === '';
      const pedido = cel('pedido');
      if (pedido) {
        // o pedido separa as vendas: só o código da coluna entra; preencher o código do arquivo depois só atualiza
        const base = hashChave(['pedido', loja, pedido, produto ?? '', formaDoCodigo(loja)(codigoColuna)]);
        const n = contar(iguais, base);
        registros.push({ chave: n === 1 ? base : `${base}#${n}`, sem_pedido: false, ...valores });
        return;
      }
      // na chave, o código vai na forma da loja (Amazon sem caixa, R14); a coluna `codigo` guarda como veio
      const semPedido = (cod) => hashChave(['linha', loja, data, produto ?? titulo ?? '', formaDoCodigo(loja)(cod)]);
      const base = semPedido(doParametro ? codigoArquivo : codigoColuna);
      const chave = `${base}#${contar(iguais, base)}`;
      // a chave que a linha teria importada sem o parâmetro (o mesmo #n de então): só para achar a linha sem código
      const baseSem = semPedido(codigoColuna);
      const nSem = contar(iguaisSemParametro, baseSem);
      registros.push(doParametro ? { chave, sem_pedido: true, chave_sem_codigo: `${baseSem}#${nSem}`, ...valores } : { chave, sem_pedido: true, ...valores });
    });
  }

  const avisos = [];
  if (diaRelatorio !== null) avisos.push(usaDia ? MENSAGENS_IMPORTADOR.diaUsado : MENSAGENS_IMPORTADOR.diaIgnorado);
  if (tipo === 'comissoes' && mapa.status === undefined) avisos.push(MENSAGENS_IMPORTADOR.semStatus);
  if (desconhecido) avisos.push(plural(desconhecido, '1 linha com status que o painel não conhece entrou como pendente.', '{n} linhas com status que o painel não conhece entraram como pendentes.'));
  if (milhar) avisos.push(plural(milhar, '1 valor como 1.234, sem vírgula, foi lido como milhar. Confira os números.', '{n} valores como 1.234, sem vírgula, foram lidos como milhar. Confira os números.'));
  if (soCliques) avisos.push(plural(soCliques, ...MENSAGENS_IMPORTADOR.soCliques));
  return {
    loja, tipo, codigo_arquivo: codigoArquivo, sha256,
    colunas_usadas: cab.colunas_usadas, colunas_ignoradas: cab.colunas_ignoradas,
    lidas: dados.length, ignoradas, linhas_ignoradas: linhasIgnoradas, so_cliques: tipo === 'cliques' ? null : soCliques, registros, avisos,
  };
}

// ---------- banco ----------

function emTransacao(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* a transação já caiu */ }
    throw e;
  }
}

const CAMPOS_COMISSAO = ['data', 'codigo', 'produto', 'titulo', 'quantidade', 'venda_centavos', 'comissao_centavos', 'status'];
const mesmaComissao = (a, b) => CAMPOS_COMISSAO.every((c) => (a[c] ?? null) === (b[c] ?? null));

/** Forma do código para comparar: a Amazon não distingue maiúsculas no ID de rastreamento (como src/ganhos.js). */
const formaDoCodigo = (loja) => (loja === 'amazon' ? (c) => c.toLowerCase() : (c) => c);

/**
 * Códigos que já são de um grupo ou bloco na loja: associados hoje ou que já saíram num envio com esse nível.
 * Já na forma de `formaDoCodigo(loja)`.
 */
function codigosConhecidos(db, loja) {
  const sql = `SELECT codigo FROM rastreio_codigos WHERE loja = ?
    UNION SELECT DISTINCT codigo FROM rastreio_envios WHERE loja = ? AND nivel IN ('grupo', 'bloco') AND codigo IS NOT NULL`;
  const forma = formaDoCodigo(loja);
  return new Set(db.prepare(sql).all(loja, loja).map((r) => forma(r.codigo)));
}

/**
 * Importa (ou só mostra a prévia, `previa: true`) um arquivo de comissões ou cliques de uma loja.
 * Devolve o resumo: { previa, importacao_id, loja, tipo, codigo_arquivo, lidas, novas, atualizadas, repetidas,
 * ignoradas, linhas_ignoradas, so_cliques, colunas_usadas, colunas_ignoradas, periodo, comissao_centavos, cliques_total,
 * sem_grupo, codigos_desconhecidos, ja_importado, outro_codigo, recebem_codigo, avisos }. Em cliques,
 * novas/atualizadas/repetidas contam pares dia × código (o arquivo pode ter várias linhas por dia) e
 * outro_codigo/recebem_codigo/so_cliques são null. `dia`: a data do relatório sem data por linha. Tudo numa transação:
 * falhou, nada fica.
 */
export function importar(db, buf, { loja, tipo, codigo, dia, previa = false, userId = null, now = Date.now() } = {}) {
  const a = analisar(buf, { loja, tipo, codigo, dia, hashChave: criarHashChave(chavePseudo(db)) });
  const ehCliques = a.tipo === 'cliques';
  const jaImportado = !!db.prepare('SELECT 1 FROM importacoes WHERE loja = ? AND tipo = ? AND arquivo_sha256 = ?').get(a.loja, a.tipo, a.sha256);

  // classifica cada registro contra o banco e contra os anteriores do mesmo arquivo
  const classificar = () => {
    const vistos = new Map();
    const ops = [];
    const sel = ehCliques
      ? db.prepare('SELECT cliques FROM cliques_loja WHERE loja = ? AND dia = ? AND codigo = ?')
      : db.prepare(`SELECT ${CAMPOS_COMISSAO.join(', ')} FROM comissoes WHERE loja = ? AND chave = ?`);
    const selSemCodigo = ehCliques ? null : db.prepare('SELECT 1 FROM comissoes WHERE loja = ? AND chave = ? AND codigo IS NULL');
    // uma linha do banco é de um registro só: a chave sem código não vale se outro registro do arquivo já a tem
    const doArquivo = ehCliques ? null : new Set(a.registros.map((r) => r.chave));
    for (const r of a.registros) {
      const k = ehCliques ? JSON.stringify([r.dia, r.codigo]) : r.chave;
      const atual = vistos.has(k) ? vistos.get(k) : (ehCliques ? sel.get(a.loja, r.dia, r.codigo) : sel.get(a.loja, r.chave)) ?? null;
      if (!atual && r.chave_sem_codigo && !doArquivo.has(r.chave_sem_codigo) && selSemCodigo.get(a.loja, r.chave_sem_codigo)) {
        // a mesma venda importada antes sem código: ganha o código e a chave dele (R4)
        ops.push({ r, tipo: 'atualizada', chaveAntiga: r.chave_sem_codigo });
      } else {
        const igual = atual && (ehCliques ? atual.cliques === r.cliques : mesmaComissao(atual, r));
        ops.push({ r, tipo: !atual ? 'nova' : igual ? 'repetida' : 'atualizada' });
      }
      vistos.set(k, r);
    }
    return ops;
  };
  const contar = (ops, t) => ops.filter((o) => o.tipo === t).length;

  /**
   * Avisos de código (D1), contados antes de gravar. recebem: linhas do banco sem código que vão ganhar o código
   * do arquivo (R4). outro: linhas novas sem pedido, com produto ou título, que casam (data e produto ou título)
   * com uma linha já gravada de outro código ou sem código; cada linha do banco conta uma vez só, e ficam de fora
   * as do próprio arquivo, as que vão receber o código e as zeradas (só cliques, R2). Sem produto nem título não há
   * "mesmo produto".
   */
  const contarCodigos = (ops) => {
    if (ehCliques) return { outro: null, recebem: null };
    const recebem = ops.filter((o) => o.chaveAntiga).length;
    const novas = ops.filter((o) => o.tipo === 'nova' && o.r.sem_pedido && (o.r.produto ?? o.r.titulo));
    if (novas.length === 0) return { outro: 0, recebem };
    const forma = formaDoCodigo(a.loja);
    const casamento = (data, produto, titulo) => JSON.stringify([String(data).slice(0, 10), produto ?? titulo ?? '']);
    const fora = new Set([...a.registros.map((r) => r.chave), ...ops.filter((o) => o.chaveAntiga).map((o) => o.chaveAntiga)]);
    const datas = novas.map((o) => o.r.data).sort();
    const doBanco = new Map(); // casamento → códigos (na forma da loja) das linhas gravadas
    const sql = `SELECT chave, data, produto, titulo, codigo, quantidade, venda_centavos, comissao_centavos FROM comissoes
      WHERE loja = ? AND substr(data, 1, 10) BETWEEN ? AND ?`;
    for (const l of db.prepare(sql).all(a.loja, datas[0], datas[datas.length - 1])) {
      if (fora.has(l.chave)) continue;
      if (!l.quantidade && !l.venda_centavos && !l.comissao_centavos) continue; // só cliques, gravada antes do R2: não é venda
      const k = casamento(l.data, l.produto, l.titulo);
      if (!doBanco.has(k)) doBanco.set(k, []);
      doBanco.get(k).push(forma(l.codigo ?? ''));
    }
    let outro = 0;
    for (const { r } of novas) {
      const lista = doBanco.get(casamento(r.data, r.produto, r.titulo));
      const i = lista ? lista.findIndex((c) => c !== forma(r.codigo ?? '')) : -1;
      if (i >= 0) { lista.splice(i, 1); outro++; }
    }
    return { outro, recebem };
  };

  const gravar = () => {
    const ops = classificar();
    const codigos = contarCodigos(ops);
    if (previa) return { ops, codigos, id: null };
    const { lastInsertRowid } = db.prepare(`INSERT INTO importacoes (loja, tipo, arquivo_sha256, codigo_arquivo, lidas, novas,
      atualizadas, ignoradas, criado_em, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(a.loja, a.tipo, a.sha256, a.codigo_arquivo, a.lidas, contar(ops, 'nova'), contar(ops, 'atualizada'),
        a.ignoradas + (a.so_cliques ?? 0), now, userId); // no histórico, as só de cliques vão com as puladas (não são repetidas)
    const id = Number(lastInsertRowid);
    if (ehCliques) {
      const ins = db.prepare('INSERT INTO cliques_loja (loja, dia, codigo, cliques, importacao_id, atualizado_em) VALUES (?, ?, ?, ?, ?, ?)');
      const upd = db.prepare('UPDATE cliques_loja SET cliques = ?, atualizado_em = ? WHERE loja = ? AND dia = ? AND codigo = ?');
      for (const { r, tipo: t } of ops) {
        if (t === 'nova') ins.run(a.loja, r.dia, r.codigo, r.cliques, id, now);
        else if (t === 'atualizada') upd.run(r.cliques, now, a.loja, r.dia, r.codigo);
      }
    } else {
      const ins = db.prepare(`INSERT INTO comissoes (loja, chave, data, codigo, produto, titulo, quantidade, venda_centavos,
        comissao_centavos, status, importacao_id, atualizado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const upd = db.prepare(`UPDATE comissoes SET chave = ?, data = ?, codigo = ?, produto = ?, titulo = ?, quantidade = ?,
        venda_centavos = ?, comissao_centavos = ?, status = ?, atualizado_em = ? WHERE loja = ? AND chave = ?`); // importacao_id fica o de quem criou
      for (const { r, tipo: t, chaveAntiga } of ops) {
        const v = [r.data, r.codigo, r.produto, r.titulo, r.quantidade, r.venda_centavos, r.comissao_centavos, r.status];
        if (t === 'nova') ins.run(a.loja, r.chave, ...v, id, now);
        else if (t === 'atualizada') upd.run(r.chave, ...v, now, a.loja, chaveAntiga ?? r.chave);
      }
    }
    return { ops, codigos, id };
  };
  const { ops, codigos, id } = previa ? gravar() : emTransacao(db, gravar);

  const datas = a.registros.map((r) => (ehCliques ? r.dia : r.data)).sort();
  let semGrupo = null; let desconhecidos = null;
  if (!ehCliques) {
    const conhecidos = codigosConhecidos(db, a.loja);
    const forma = formaDoCodigo(a.loja);
    semGrupo = a.registros.filter((r) => !r.codigo || !conhecidos.has(forma(r.codigo))).length;
    const fora = new Map(); // forma → o primeiro código como veio no arquivo
    for (const { codigo: c } of a.registros) if (c && !conhecidos.has(forma(c)) && !fora.has(forma(c))) fora.set(forma(c), c);
    desconhecidos = [...fora.values()].sort().slice(0, MAX_CODIGOS_DESCONHECIDOS);
  }
  const avisos = [...a.avisos];
  if (a.ignoradas) {
    const resto = previa ? 'As outras serão importadas.' : 'As outras foram importadas.';
    avisos.push(plural(a.ignoradas, `1 linha foi pulada por valor ou data inválidos. ${resto}`, `{n} linhas foram puladas por valor ou data inválidos. ${resto}`));
  }
  if (jaImportado) avisos.push(MENSAGENS_IMPORTADOR.jaImportado);
  const M = MENSAGENS_IMPORTADOR;
  if (codigos.outro) avisos.push(plural(codigos.outro, ...(previa ? M.outroCodigoPrevia : M.outroCodigoGravado)));
  if (codigos.recebem) avisos.push(plural(codigos.recebem, ...(previa ? M.recebemCodigoPrevia : M.recebemCodigoGravado)));
  return {
    previa: !!previa, importacao_id: id, loja: a.loja, tipo: a.tipo, codigo_arquivo: a.codigo_arquivo,
    lidas: a.lidas, novas: contar(ops, 'nova'), atualizadas: contar(ops, 'atualizada'), repetidas: contar(ops, 'repetida'),
    ignoradas: a.ignoradas, linhas_ignoradas: a.linhas_ignoradas, so_cliques: a.so_cliques,
    colunas_usadas: a.colunas_usadas, colunas_ignoradas: a.colunas_ignoradas,
    periodo: datas.length ? { de: datas[0], ate: datas[datas.length - 1] } : null,
    comissao_centavos: ehCliques ? null : a.registros.filter((r) => r.status !== 'cancelada').reduce((s, r) => s + r.comissao_centavos, 0),
    cliques_total: ehCliques ? a.registros.reduce((s, r) => s + r.cliques, 0) : null,
    sem_grupo: semGrupo, codigos_desconhecidos: desconhecidos, ja_importado: jaImportado,
    outro_codigo: codigos.outro, recebem_codigo: codigos.recebem, avisos,
  };
}

/**
 * Importações mais recentes primeiro (até 100): contagens gravadas, `repetidas` (comissões: lidas − novas −
 * atualizadas − ignoradas; cliques: null) e `linhas` que ainda pertencem a cada uma. Sem sha256 nem usuário.
 */
export function listarImportacoes(db) {
  const donas = new Map();
  for (const t of ['comissoes', 'cliques_loja']) {
    for (const r of db.prepare(`SELECT importacao_id AS id, COUNT(*) AS n FROM ${t} GROUP BY importacao_id`).all()) {
      donas.set(r.id, (donas.get(r.id) ?? 0) + r.n);
    }
  }
  return db.prepare(`SELECT id, loja, tipo, codigo_arquivo, lidas, novas, atualizadas, ignoradas, criado_em
    FROM importacoes ORDER BY id DESC LIMIT ?`).all(MAX_IMPORTACOES_LISTADAS).map((i) => ({
    ...i,
    repetidas: i.tipo === 'comissoes' ? Math.max(0, (i.lidas ?? 0) - (i.novas ?? 0) - (i.atualizadas ?? 0) - (i.ignoradas ?? 0)) : null,
    linhas: donas.get(i.id) ?? 0,
  }));
}

/** Id de importação: inteiro positivo (número ou só dígitos, sem zero à esquerda); senão null. */
function idImportacao(v) {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v > 0 ? v : null;
  return typeof v === 'string' && /^[1-9]\d{0,14}$/.test(v) ? Number(v) : null;
}

/** Apaga a importação e só as linhas criadas por ela. Inexistente ou id inválido → 404. */
export function apagarImportacao(db, idBruto) {
  const id = idImportacao(idBruto);
  if (id === null) throw recusar(404, 'naoAchei');
  return emTransacao(db, () => {
    if (!db.prepare('SELECT 1 FROM importacoes WHERE id = ?').get(id)) throw recusar(404, 'naoAchei');
    const comissoes = Number(db.prepare('DELETE FROM comissoes WHERE importacao_id = ?').run(id).changes);
    const cliques = Number(db.prepare('DELETE FROM cliques_loja WHERE importacao_id = ?').run(id).changes);
    db.prepare('DELETE FROM importacoes WHERE id = ?').run(id);
    return { id, comissoes, cliques };
  });
}

// ---------- rotas ----------

/** Sem `ctx.soDono` (servidor montado sem login), ninguém importa nem lê: falha fechada. */
const negar = (_req, res) => res.status(403).json({ erro: 'Só o Dono pode fazer isso.' });
const TIPOS_DE_CONTEUDO = ['text/csv', 'text/plain'];

const responder = (fn, mensagem500 = MENSAGENS_IMPORTADOR.falha) => (req, res) => {
  try { res.json(fn(req)); } catch (e) {
    if (e instanceof ErroImportacao) return res.status(e.status).json({ erro: e.message });
    // só o código: a mensagem do SQLite pode trazer valores da consulta
    console.error('[importador] falha inesperada:', e?.code || e?.name || 'erro');
    res.status(500).json({ erro: mensagem500 });
  }
};

/**
 * Rotas do importador, montadas por buildApp depois do Host/Origin e do login. Todas só do Dono (P2).
 * O corpo cru só é lido nesta rota, depois do soDono, com tipo e tamanho conferidos antes (415, 413).
 */
export function montarRotas(app, ctx) {
  const { db } = ctx;
  const soDono = typeof ctx.soDono === 'function' ? ctx.soDono : negar;
  const corpoCru = express.raw({ type: TIPOS_DE_CONTEUDO, limit: MAX_BYTES_ARQUIVO, inflate: false });

  app.post('/api/ganhos/importar', soDono, (req, res, next) => {
    const temCorpo = req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length']) > 0;
    if (!temCorpo) return res.status(400).json({ erro: MENSAGENS_CSV.vazio });
    if (!req.is(TIPOS_DE_CONTEUDO)) { req.resume(); return res.status(415).json({ erro: MENSAGENS_CSV.tipo }); }
    corpoCru(req, res, (err) => {
      if (!err) return next();
      if (err.status === 413) return res.status(413).json({ erro: MENSAGENS_CSV.tamanho });
      res.status(400).json({ erro: MENSAGENS_IMPORTADOR.recebimento });
    });
  }, responder((req) => {
    const q = req.query; // parâmetro repetido (?loja=a&loja=b) vira lista e é recusado na validação
    if (q.previa !== undefined && typeof q.previa !== 'string') throw recusar(400, 'previa'); // ?previa=1&previa=1
    return importar(db, req.body, {
      loja: q.loja, tipo: q.tipo, codigo: q.codigo, dia: q.dia,
      previa: q.previa === '1' || q.previa === 'true', userId: req.user?.id ?? null,
    });
  }, MENSAGENS_IMPORTADOR.interno));

  app.get('/api/ganhos/importacoes', soDono, responder(() => ({ importacoes: listarImportacoes(db) })));
  app.delete('/api/ganhos/importacoes/:id', soDono, responder((req) => apagarImportacao(db, req.params.id)));
}
