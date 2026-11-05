// Importador de comissões e cliques por CSV (docs/produto/planos/dashboard-ganhos.md, D7, D8 e etapa 14).
// O dono baixa o relatório no portal da loja e envia pelo painel (corpo cru text/csv, só Dono). O arquivo é lido
// em memória (src/csv.js) e nunca vai ao disco; de `importacoes` fica só o sha256 dele.
// Lista branca (LGPD): só as colunas de COLUNAS são lidas (data, código, produto, título, quantidade, venda,
// comissão, status, devoluções, cliques e o pedido). Nome, endereço, telefone, e-mail ou documento de comprador
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
// Uma linha pertence à importação que a criou: apagar uma importação apaga só as linhas criadas por ela.
// Rotas (montarRotas, todas só do Dono, inclusive GET, P2):
//   POST /api/ganhos/importar?loja=&tipo=comissoes|cliques&codigo=&previa=1 (corpo text/csv ou text/plain, até
//   5 MB) → resumo; GET /api/ganhos/importacoes → { importacoes }; DELETE /api/ganhos/importacoes/:id.
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
const RE_CONTROLE = /[\u0000-\u001f\u007f]/;

/**
 * Sinônimos de cabeçalho por campo, já normalizados (normalizarNome). PROVISÓRIOS até os exemplos dos portais
 * (P5): ajustar formato é só acrescentar sinônimo aqui. Quando duas colunas casam com o mesmo campo, vale a do
 * sinônimo que vem antes na lista. A ordem dos campos é a de `colunas_usadas` na resposta.
 */
export const COLUNAS = Object.freeze({
  data: ['data', 'data do pedido', 'hora do pedido', 'data da venda', 'data da compra', 'data de envio', 'date shipped',
    'order time', 'order date', 'purchase time', 'data da conversao', 'date', 'dia', 'day', 'data do clique', 'hora do clique', 'click time'],
  pedido: ['id do pedido', 'order id', 'checkout id', 'numero do pedido', 'id da compra', 'pedido'],
  loja_id: ['id da loja', 'shop id'],
  produto: ['asin', 'mlb', 'id do item', 'item id', 'id do produto', 'product id', 'codigo do produto'],
  titulo: ['titulo', 'titulo do produto', 'nome do item', 'nome do produto', 'item name', 'product name'],
  codigo: ['sub id1', 'sub id 1', 'subid1', 'sub id', 'subid', 'tracking id', 'id de rastreamento', 'etiqueta'],
  venda: ['valor de compra', 'valor da compra', 'valor da venda', 'purchase value', 'order amount', 'revenue', 'receita', 'valor do pedido'],
  comissao: ['ad fees', 'taxas de publicidade', 'comissao total do item', 'comissao do item', 'comissao', 'commission',
    'total commission', 'net commission', 'comissao total', 'comissao liquida', 'ganhos', 'comissao total do pedido'],
  status: ['status', 'status do pedido', 'order status', 'status da conversao', 'conversion status', 'situacao'],
  quantidade: ['items shipped', 'itens enviados', 'quantidade', 'qtd', 'qty', 'quantity'],
  devolucoes: ['returns', 'devolucoes', 'itens devolvidos'],
  cliques: ['clicks', 'cliques', 'total de cliques'],
});
const CAMPOS = Object.freeze({
  comissoes: ['data', 'pedido', 'loja_id', 'produto', 'titulo', 'codigo', 'venda', 'comissao', 'status', 'quantidade', 'devolucoes'],
  cliques: ['data', 'codigo', 'cliques'],
});
const OBRIGATORIO = Object.freeze({ comissoes: 'comissao', cliques: 'cliques' });

const formato = 'O portal pode ter mudado o formato. Mande o arquivo de exemplo para a equipe ajustar.';
export const MENSAGENS_IMPORTADOR = Object.freeze({
  loja: 'Escolha a loja do arquivo: Shopee, Amazon ou Mercado Livre.',
  tipo: 'Escolha o tipo do relatório: comissões ou cliques.',
  codigo: 'O código do arquivo tem caractere inválido ou passa de 100 caracteres.',
  semData: `Não encontrei a coluna de data (esperada: Data, Data do pedido ou Date Shipped). ${formato}`,
  semComissao: `Não encontrei a coluna de comissão (esperada: Comissão, Commission ou Ad Fees). ${formato}`,
  semCliques: `Não encontrei a coluna de cliques (esperada: Cliques ou Clicks). ${formato}`,
  naoAchei: 'Importação não encontrada.',
  recebimento: 'Não consegui receber o arquivo. Tente de novo.',
  interno: 'Não consegui importar agora. Nada foi salvo. Tente de novo; se repetir, veja o histórico do programa.',
  falha: 'Não consegui concluir. Tente de novo.',
  previa: 'O parâmetro de prévia veio repetido ou inválido. Mande previa=1 uma vez só.',
  semStatus: 'O arquivo não tem coluna de status: as vendas entram como pendentes.',
  jaImportado: 'Este arquivo já foi importado antes. As linhas repetidas não mudam nada.',
});
const SEM_COLUNA = { data: 'semData', comissao: 'semComissao', cliques: 'semCliques' };

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

/** Inteiro não negativo (quantidade, devoluções, cliques), com milhar por ponto ou vírgula; senão null. */
function lerInteiro(s) {
  const t = String(s ?? '').replace(/\s/g, '');
  let n = null;
  if (/^\d{1,10}$/.test(t)) n = Number(t);
  else if (/^\d{1,3}([.,]\d{3}){1,3}$/.test(t)) n = Number(t.replace(/[.,]/g, ''));
  return n !== null && n <= 1e9 ? n : null;
}

const diasNoMes = (a, m) => new Date(Date.UTC(a, m, 0)).getUTCDate();
/** Data → 'AAAA-MM-DD' ou null: `AAAA-MM-DD`, `AAAA/MM/DD`, `DD/MM/AAAA`, `DD-MM-AAAA`, com hora ou fuso depois (ignorados). */
export function lerData(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  let a; let m; let d;
  let r = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:$|[ T])/.exec(t);
  if (r) [, a, m, d] = r;
  else if ((r = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:$|[ T])/.exec(t))) [, d, m, a] = r;
  else return null;
  [a, m, d] = [Number(a), Number(m), Number(d)];
  if (a < 2000 || a > 2100 || m < 1 || m > 12 || d < 1 || d > diasNoMes(a, m)) return null;
  return `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const STATUS = new Map([
  ...['concluido', 'concluida', 'completed', 'complete', 'validado', 'validada', 'validated', 'pago', 'paga', 'paid',
    'confirmado', 'confirmada', 'confirmed', 'aprovado', 'aprovada', 'approved'].map((s) => [s, 'confirmada']),
  ...['pendente', 'pending', 'nao pago', 'nao paga', 'unpaid', 'em andamento', 'processando', 'em processamento',
    'processing', 'aguardando'].map((s) => [s, 'pendente']),
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

/** Liga cada campo do tipo à coluna da linha (o sinônimo que vem antes em COLUNAS vence). */
function mapear(celulas, campos) {
  const melhor = {};
  celulas.forEach((c, idx) => {
    const n = normalizarNome(c);
    if (!n) return;
    for (const campo of campos) {
      const p = COLUNAS[campo].indexOf(n);
      if (p >= 0 && (!melhor[campo] || p < melhor[campo].p)) melhor[campo] = { idx, p };
    }
  });
  return Object.fromEntries(Object.entries(melhor).map(([campo, { idx }]) => [campo, idx]));
}

/**
 * Procura o cabeçalho nas primeiras LINHAS_PARA_CABECALHO linhas: a primeira com a data e o campo obrigatório do
 * tipo (comissão ou cliques). Sem cabeçalho: erro dizendo qual coluna faltou.
 */
function acharCabecalho(linhas, tipo) {
  const campos = CAMPOS[tipo];
  const obrigatorio = OBRIGATORIO[tipo];
  let faltou = obrigatorio;
  for (let i = 0; i < Math.min(linhas.length, LINHAS_PARA_CABECALHO); i++) {
    const mapa = mapear(linhas[i], campos);
    if (mapa.data !== undefined && mapa[obrigatorio] !== undefined) {
      const usados = new Set(Object.values(mapa));
      return {
        indice: i,
        mapa,
        colunas_usadas: campos.filter((c) => mapa[c] !== undefined).map((campo) => ({ campo, coluna: textoLimpo(linhas[i][mapa[campo]]).slice(0, MAX_NOME_COLUNA) })),
        colunas_ignoradas: linhas[i].map((c, idx) => (usados.has(idx) ? '' : textoLimpo(c).slice(0, MAX_NOME_COLUNA))).filter(Boolean),
      };
    }
    if (mapa[obrigatorio] !== undefined) faltou = 'data';
  }
  throw recusar(400, SEM_COLUNA[faltou]);
}

// ---------- análise (sem banco) ----------

function validarOpcoes({ loja, tipo, codigo } = {}) {
  if (typeof loja !== 'string' || !LOJAS.includes(loja)) throw recusar(400, 'loja');
  const t = tipo === undefined || tipo === null || tipo === '' ? 'comissoes' : tipo;
  if (typeof t !== 'string' || !TIPOS.includes(t)) throw recusar(400, 'tipo');
  if (codigo !== undefined && codigo !== null && typeof codigo !== 'string') throw recusar(400, 'codigo');
  const c = lerCodigo(codigo);
  if (c === null) throw recusar(400, 'codigo');
  return { loja, tipo: t, codigo: c || null };
}

const plural = (n, um, varios) => (n === 1 ? um : varios).replace('{n}', n);

/**
 * Lê o arquivo e devolve o que seria importado, sem tocar no banco: { loja, tipo, codigo_arquivo, sha256,
 * colunas_usadas, colunas_ignoradas, lidas, ignoradas, linhas_ignoradas, registros, avisos }.
 * `registros` (comissões): { chave, data, codigo, produto, titulo, quantidade, venda_centavos, comissao_centavos,
 * status } e, sem pedido com o código do parâmetro, `chave_sem_codigo` (a chave sem o parâmetro, para achar a linha
 * importada antes sem código); (cliques): { dia, codigo, cliques }, já somados por dia e código. O pedido não sai daqui.
 * `opcoes.hashChave(partes)` faz a chave (importar passa o HMAC com a chave local do banco). Sem ela, usa uma
 * chave aleatória desta chamada: as chaves só servem para comparar linhas do mesmo resultado, nunca para gravar.
 */
export function analisar(buf, opcoes = {}) {
  const { loja, tipo, codigo: codigoArquivo } = validarOpcoes(opcoes);
  const hashChave = typeof opcoes.hashChave === 'function' ? opcoes.hashChave : criarHashChave(crypto.randomBytes(32));
  let csv;
  try { csv = lerCsv(buf); } catch (e) {
    if (e instanceof ErroCsv) throw new ErroImportacao(e.status, e.message);
    throw e;
  }
  const cab = acharCabecalho(csv.linhas, tipo);
  const { mapa } = cab;
  const dados = csv.linhas.slice(cab.indice + 1);
  if (dados.length === 0) throw new ErroImportacao(400, MENSAGENS_CSV.vazio);
  const numeros = csv.numeros.slice(cab.indice + 1);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

  let ignoradas = 0; let milhar = 0; let desconhecido = 0;
  const linhasIgnoradas = [];
  const pular = (i) => { ignoradas++; if (linhasIgnoradas.length < MAX_LINHAS_IGNORADAS_LISTADAS) linhasIgnoradas.push(numeros[i]); };
  const codigoDe = (cel) => { const c = lerCodigo(cel('codigo')); return c === '' ? codigoArquivo : c; };
  const registros = [];

  if (tipo === 'cliques') {
    const somas = new Map();
    dados.forEach((linha, i) => {
      const cel = (campo) => (mapa[campo] === undefined ? '' : String(linha[mapa[campo]] ?? '').trim());
      const dia = lerData(cel('data'));
      const n = lerInteiro(cel('cliques'));
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
      const cel = (campo) => (mapa[campo] === undefined ? '' : String(linha[mapa[campo]] ?? '').trim());
      const data = lerData(cel('data'));
      const comissao = lerDinheiro(cel('comissao'));
      if (!data || !comissao) return pular(i);
      const venda = lerDinheiro(cel('venda'));
      milhar += (comissao.milhar ? 1 : 0) + (venda?.milhar ? 1 : 0);
      let quantidade = lerInteiro(cel('quantidade')) ?? 1;
      const devolucoes = lerInteiro(cel('devolucoes')) ?? 0;
      let status = 'pendente';
      if (mapa.status !== undefined) { status = lerStatus(cel('status')); if (!status) { desconhecido++; status = 'pendente'; } }
      if (devolucoes > 0 && devolucoes >= quantidade) status = 'cancelada';
      else quantidade -= devolucoes;
      const item = cel('produto'); const lojaId = cel('loja_id');
      const p = loja === 'shopee' && item && lojaId ? `SHOPEE:${lojaId}.${item}` : item;
      const produto = RE_PRODUTO.test(p) ? p : null;
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
        registros.push({ chave: n === 1 ? base : `${base}#${n}`, ...valores });
        return;
      }
      // na chave, o código vai na forma da loja (Amazon sem caixa, R14); a coluna `codigo` guarda como veio
      const semPedido = (cod) => hashChave(['linha', loja, data, produto ?? titulo ?? '', formaDoCodigo(loja)(cod)]);
      const base = semPedido(doParametro ? codigoArquivo : codigoColuna);
      const chave = `${base}#${contar(iguais, base)}`;
      // a chave que a linha teria importada sem o parâmetro (o mesmo #n de então): só para achar a linha sem código
      const baseSem = semPedido(codigoColuna);
      const nSem = contar(iguaisSemParametro, baseSem);
      registros.push(doParametro ? { chave, chave_sem_codigo: `${baseSem}#${nSem}`, ...valores } : { chave, ...valores });
    });
  }

  const avisos = [];
  if (tipo === 'comissoes' && mapa.status === undefined) avisos.push(MENSAGENS_IMPORTADOR.semStatus);
  if (desconhecido) avisos.push(plural(desconhecido, '1 linha com status que o painel não conhece entrou como pendente.', '{n} linhas com status que o painel não conhece entraram como pendentes.'));
  if (milhar) avisos.push(plural(milhar, '1 valor como 1.234, sem vírgula, foi lido como milhar. Confira os números.', '{n} valores como 1.234, sem vírgula, foram lidos como milhar. Confira os números.'));
  return {
    loja, tipo, codigo_arquivo: codigoArquivo, sha256,
    colunas_usadas: cab.colunas_usadas, colunas_ignoradas: cab.colunas_ignoradas,
    lidas: dados.length, ignoradas, linhas_ignoradas: linhasIgnoradas, registros, avisos,
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
 * ignoradas, linhas_ignoradas, colunas_usadas, colunas_ignoradas, periodo, comissao_centavos, cliques_total,
 * sem_grupo, codigos_desconhecidos, ja_importado, avisos }. Em cliques, novas/atualizadas/repetidas contam
 * pares dia × código (o arquivo pode ter várias linhas por dia). Tudo numa transação: falhou, nada fica.
 */
export function importar(db, buf, { loja, tipo, codigo, previa = false, userId = null, now = Date.now() } = {}) {
  const a = analisar(buf, { loja, tipo, codigo, hashChave: criarHashChave(chavePseudo(db)) });
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

  const gravar = () => {
    const ops = classificar();
    if (previa) return { ops, id: null };
    const { lastInsertRowid } = db.prepare(`INSERT INTO importacoes (loja, tipo, arquivo_sha256, codigo_arquivo, lidas, novas,
      atualizadas, ignoradas, criado_em, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(a.loja, a.tipo, a.sha256, a.codigo_arquivo, a.lidas, contar(ops, 'nova'), contar(ops, 'atualizada'), a.ignoradas, now, userId);
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
    return { ops, id };
  };
  const { ops, id } = previa ? gravar() : emTransacao(db, gravar);

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
  return {
    previa: !!previa, importacao_id: id, loja: a.loja, tipo: a.tipo, codigo_arquivo: a.codigo_arquivo,
    lidas: a.lidas, novas: contar(ops, 'nova'), atualizadas: contar(ops, 'atualizada'), repetidas: contar(ops, 'repetida'),
    ignoradas: a.ignoradas, linhas_ignoradas: a.linhas_ignoradas,
    colunas_usadas: a.colunas_usadas, colunas_ignoradas: a.colunas_ignoradas,
    periodo: datas.length ? { de: datas[0], ate: datas[datas.length - 1] } : null,
    comissao_centavos: ehCliques ? null : a.registros.filter((r) => r.status !== 'cancelada').reduce((s, r) => s + r.comissao_centavos, 0),
    cliques_total: ehCliques ? a.registros.reduce((s, r) => s + r.cliques, 0) : null,
    sem_grupo: semGrupo, codigos_desconhecidos: desconhecidos, ja_importado: jaImportado, avisos,
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
      loja: q.loja, tipo: q.tipo, codigo: q.codigo,
      previa: q.previa === '1' || q.previa === 'true', userId: req.user?.id ?? null,
    });
  }, MENSAGENS_IMPORTADOR.interno));

  app.get('/api/ganhos/importacoes', soDono, responder(() => ({ importacoes: listarImportacoes(db) })));
  app.delete('/api/ganhos/importacoes/:id', soDono, responder((req) => apagarImportacao(db, req.params.id)));
}
