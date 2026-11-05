// Dashboard de ganhos (docs/produto/planos/dashboard-ganhos.md, Entrega B, etapas 13 e 15).
// Métricas M1–M15 do "Catálogo de métricas (MDD)" calculadas na consulta (D8: nada pré-agregado, então corrigir
// uma associação reatribui sozinho), sobre comissoes, cliques_loja, rastreio_envios, gastos_anuncio e group_events.
// Dinheiro em centavos (inteiros); razões de 0 a 1; divisão por zero = null (a tela mostra "—").
// Atribuição (D6): a comissão (ou o clique) vai para o grupo ou bloco da linha de rastreio_envios mais recente com a
// mesma loja e código, nível grupo/bloco, até o fim do dia de negócio da venda. Sem ela: "não atribuída".
// Recorte de bloco: a comissão e o clique atribuídos ao bloco mais os atribuídos aos grupos que estão hoje nele; o gasto
// (M12), só o lançado para o próprio bloco.
// Nenhum dado de pessoa passa por aqui: as entradas são contadas em group_events, sem ler o participante.
// Entrega C (docs/produto/planos/dashboard-ganhos-c.md, etapa 2): M16 (comparar com o período anterior), filtro de
// grupo em por=oferta e a URL da página do produto (sem afiliado) em cada oferta.

import { periodRange, dayOf } from './analytics.js';
import { cobertura as coberturaRastreio, LOJAS } from './rastreio.js';
import { lerChave } from './catalogo-itens.js';

export const POR = Object.freeze(['grupo', 'bloco', 'loja', 'oferta', 'dia']);
export const PERIODOS = Object.freeze(['hoje', 'ontem', '7d', '30d', 'mes', 'mes_passado', 'custom']);
export const MAX_DIAS_GASTO = 366;
export const MAX_NOTA = 200;
/** Teto de um gasto (R$ 100 milhões): só para a soma nunca sair dos inteiros exatos. */
const MAX_VALOR_CENTAVOS = 10_000_000_000;
const MAX_JID = 200;
const RE_DIA = /^\d{4}-\d{2}-\d{2}$/;
const RE_ID_BLOCO = /^[1-9]\d{0,15}$/;
const RE_ID = /^\d{1,15}$/;
const DIA_MS = 86400000;

export const MENSAGENS_GANHOS = Object.freeze({
  loja: 'Loja desconhecida.',
  por: 'Escolha como agrupar: grupo, bloco, loja, oferta ou dia.',
  periodo_consulta: 'Período inválido. Use datas como 2026-10-31.',
  bloco: 'Este bloco não existe mais.',
  grupo: 'Este grupo não existe mais.',
  grupo_por: 'O filtro de grupo vale só para a tabela Por oferta.',
  grupo_e_bloco: 'Filtre por grupo ou por bloco, não pelos dois.',
  comparar: 'O parâmetro de comparação veio repetido ou inválido. Mande comparar=1 uma vez só.',
  corpo: 'Envie o gasto.',
  alvo: 'Escolha um grupo ou bloco.',
  periodo: 'Escolha o período do gasto.',
  ordem: 'A data final não pode ser antes da inicial.',
  longo: `O período do gasto vai até ${MAX_DIAS_GASTO} dias. Divida em partes menores.`,
  valor: 'O valor precisa ser maior que zero.',
  valor_formato: 'Digite o valor em reais, por exemplo 150,00.',
  nota: `A observação vai até ${MAX_NOTA} caracteres.`,
  sobreposto: 'Já existe gasto para este período e destino. Se for o mesmo anúncio, apague o anterior em vez de somar.',
  gasto_sumiu: 'Este gasto não existe mais.',
  // CA11 (P2): como o bloco com código de rastreio (MENSAGENS_RASTREIO), o com gasto só o Dono apaga ou regrupa
  bloco_apagar: 'Este bloco tem gasto com anúncio. Só o Dono pode apagá-lo.',
  bloco_grupos: 'Este bloco tem gasto com anúncio. Só o Dono pode mudar os grupos dele.',
});
const M = MENSAGENS_GANHOS;

/** Erro com status HTTP e frase pronta para a tela. Nunca carrega o valor recebido. */
export class ErroGanhos extends Error {
  constructor(status, mensagem) { super(mensagem); this.status = status; }
}

const razao = (a, b) => (b > 0 ? a / b : null);

/** 'AAAA-MM-DD' de calendário válido → número do dia (UTC, sem horário de verão); senão null. */
function diaNum(s) {
  if (typeof s !== 'string' || !RE_DIA.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.getTime() / DIA_MS;
}
const diaTexto = (n) => new Date(n * DIA_MS).toISOString().slice(0, 10);
/** Início e fim (ms) do dia de negócio `dia`, como periodRange calcula. */
const limitesDoDia = (dia, viradaMin) => periodRange('custom', 0, { de: dia, ate: dia }, viradaMin);

/** Id de bloco canônico (1, '7') → Number; '01', '1e0', jid → null. */
function idBloco(v) {
  const s = typeof v === 'number' ? String(v) : v;
  return typeof s === 'string' && RE_ID_BLOCO.test(s) ? Number(s) : null;
}

// ---------- atribuição (D6) ----------

/** Função (loja, codigo, data) → alvo, com cache por loja, código e dia (uma consulta por combinação). */
function criarAtribuidor(db, viradaMin = 0) {
  const sql = (cond) => db.prepare(`SELECT jid, nivel, bloco_id FROM rastreio_envios
    WHERE loja = ? AND ${cond} AND nivel IN ('grupo', 'bloco') AND ts <= ? ORDER BY ts DESC, id DESC LIMIT 1`);
  const exato = sql('codigo = ?');
  // a Amazon não distingue maiúsculas no ID de rastreamento (como rastreio.salvar)
  const semCaixa = sql('lower(codigo) = lower(?)');
  const memo = new Map();
  return (loja, codigo, data) => {
    if (typeof codigo !== 'string' || !codigo || typeof data !== 'string') return null;
    const dia = data.slice(0, 10);
    if (diaNum(dia) === null) return null;
    const chave = JSON.stringify([loja, codigo, dia]);
    if (memo.has(chave)) return memo.get(chave);
    const e = (loja === 'amazon' ? semCaixa : exato).get(loja, codigo, limitesDoDia(dia, viradaMin).ate);
    let alvo = null;
    if (e?.nivel === 'grupo') alvo = { alvo_tipo: 'grupo', jid: e.jid, bloco_id: null };
    else if (e?.nivel === 'bloco' && Number.isInteger(e.bloco_id)) alvo = { alvo_tipo: 'bloco', jid: null, bloco_id: e.bloco_id };
    memo.set(chave, alvo);
    return alvo;
  };
}

/**
 * A quem vai uma comissão ou clique (D6): `{alvo_tipo: 'grupo', jid, bloco_id: null}`,
 * `{alvo_tipo: 'bloco', jid: null, bloco_id}` ou null (não atribuída: sem código, código padrão, antes do envio).
 * `data` é o dia da venda (AAAA-MM-DD, com ou sem hora); vale o fim do dia de negócio (viradaMin).
 */
export function atribuir(db, { loja, codigo, data } = {}, viradaMin = 0) {
  return criarAtribuidor(db, viradaMin)(loja, codigo, data);
}

// ---------- métricas ----------

/** Acumulador de comissões e cliques de uma linha do recorte; `lojas` guarda [comissão, vendas, cliques] por loja. */
const novoAcc = () => ({ comissao: 0, comissao_confirmada: 0, receita: 0, vendas: 0, cliques: 0, comissao_atribuida: 0, lojas: new Map() });
function porLoja(acc, loja) {
  if (!acc.lojas.has(loja)) acc.lojas.set(loja, [0, 0, 0]);
  return acc.lojas.get(loja);
}
function somarComissao(acc, f) {
  acc.comissao += f.comissao; acc.receita += f.venda; acc.vendas += f.quantidade;
  if (f.status === 'confirmada') acc.comissao_confirmada += f.comissao;
  if (f.alvo) acc.comissao_atribuida += f.comissao;
  const l = porLoja(acc, f.loja); l[0] += f.comissao; l[1] += f.quantidade;
}
function somarCliques(acc, f) {
  acc.cliques += f.cliques; porLoja(acc, f.loja)[2] += f.cliques;
}
/** M1–M6 (e M11) de um acumulador. M5 e M6 usam só as lojas com clique no recorte (o clique só vem do relatório da loja). */
function dinheiro(acc) {
  let comComClique = 0; let vendasComClique = 0;
  for (const [c, v, k] of acc.lojas.values()) if (k > 0) { comComClique += c; vendasComClique += v; }
  return {
    comissao: acc.comissao, comissao_confirmada: acc.comissao_confirmada, receita: acc.receita, vendas: acc.vendas,
    cliques: acc.cliques, epc: razao(comComClique, acc.cliques), conversao: razao(vendasComClique, acc.cliques),
  };
}
const atribuicao = (acc) => ({ comissao_atribuida: acc.comissao_atribuida, atribuida: razao(acc.comissao_atribuida, acc.comissao) });
const SEM_ENVIO = Object.freeze({ envios: 0, esperados: 0, rastreados: 0, cobertura: null, alcance: null });
const envios = (c) => {
  const x = c || SEM_ENVIO;
  return { envios: x.envios, esperados: x.esperados, rastreados: x.rastreados, cobertura: x.cobertura, alcance: x.alcance };
};
/** M12–M15. `gasto` null = nenhum gasto informado para o alvo no período; o retorno não existe com filtro de loja. */
function custos(comissao, gasto, entradas, comLoja) {
  const g = gasto == null ? null : Math.round(gasto);
  return {
    gasto: g, entradas,
    custo_membro: g == null ? null : razao(g, entradas),
    retorno: g == null || comLoja ? null : comissao - g,
  };
}

/** Chave para casar a oferta da comissão (produto) com a do envio (oferta_chave): o ASIN vem com ou sem 'ASIN:'. */
const chaveOferta = (loja, produto) => `${loja}|${loja === 'amazon' ? produto.replace(/^ASIN:/i, '') : produto}`;

const RE_ASIN_OFERTA = /^(?:ASIN:)?([A-Z0-9]{10})$/i;
const RE_MLB_OFERTA = /^MLB-?(\d{1,20})$/i;
/** Loja de lerChave (src/catalogo-itens.js) → loja dos ganhos. */
const LOJA_DA_CHAVE = Object.freeze({ ml: 'mercadolivre', amazon: 'amazon', shopee: 'shopee' });

/**
 * Página do produto na loja, sem afiliado (D5), para o produto de uma comissão; null se o produto não fecha.
 * Só monta a URL pelas regex de lerChave, com domínio fixo: nada do arquivo importado passa inteiro para a URL.
 * Nunca é o link de afiliado (o clique do dono não entra no relatório da loja).
 */
export function urlDaOferta(loja, produto) {
  if (typeof produto !== 'string') return null;
  let chave = null;
  if (loja === 'amazon') {
    const m = RE_ASIN_OFERTA.exec(produto);
    if (m) chave = `ASIN:${m[1].toUpperCase()}`;
  } else if (loja === 'mercadolivre') {
    const m = RE_MLB_OFERTA.exec(produto);
    if (m) chave = `MLB${m[1]}`;
  } else if (loja === 'shopee') chave = produto;
  const r = chave === null ? null : lerChave(chave);
  return r && LOJA_DA_CHAVE[r.loja] === loja ? r.url : null;
}

/**
 * Confere o filtro de grupo (D4): jid de até MAX_JID caracteres (senão 404, como grupo que não existe), só com
 * por=oferta e sem bloco (400). Frases fixas, sem o valor recebido. A existência em `groups` fica com metricas.
 */
function conferirGrupo(grupo, por, bloco) {
  if (typeof grupo !== 'string' || !grupo || grupo.length > MAX_JID) throw new ErroGanhos(404, M.grupo);
  if (por !== 'oferta') throw new ErroGanhos(400, M.grupo_por);
  if (bloco != null) throw new ErroGanhos(400, M.grupo_e_bloco);
}

/** M16: as métricas dos cartões que ganham variação contra o período anterior. */
const CAMPOS_VARIACAO = Object.freeze(['comissao', 'receita', 'vendas', 'cliques', 'epc', 'conversao', 'envios', 'entradas']);
/** M16 = (X − X_ant) ÷ X_ant; null sem base (X_ant 0 ou null) ou sem valor no período (X null). */
const variacao = (x, xAnt) => (x == null || xAnt == null || xAnt === 0 ? null : (x - xAnt) / xAnt);

const porNome = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'pt-BR');
const porComissao = (nome) => (a, b) => b.comissao - a.comissao || porNome(nome(a), nome(b));

/**
 * Métricas do período [de, ate] (ms, dias de negócio de periodRange com `viradaMin`), recortadas por `por`
 * ('grupo' | 'bloco' | 'loja' | 'oferta' | 'dia'), com filtros opcionais de `loja`, de `bloco` (id) e de `grupo`
 * (jid; só com por='oferta' e sem bloco: as vendas atribuídas a esse grupo, não as do bloco inteiro, D4).
 * `comparar: true` acrescenta `anterior = { dia_de, dia_ate, total, variacao }` (M16): os mesmos N dias de negócio
 * logo antes, com os mesmos filtros; sem ele, `anterior: null`.
 * Devolve `{ de, ate, dia_de, dia_ate, por, loja, bloco, grupo, total, nao_atribuida, cobertura: {total, por_loja}, linhas,
 * importado_ate, gastos_informados, anterior }`. Erros: ErroGanhos 400 (por, loja, combinação do grupo) ou 404 (bloco,
 * grupo); período não numérico: TypeError.
 */
export function metricas(db, { de, ate, por = 'grupo', loja = null, bloco = null, grupo = null, comparar = false, viradaMin = 0 } = {}) {
  if (!Number.isFinite(de) || !Number.isFinite(ate)) throw new TypeError('ganhos: período inválido');
  if (!POR.includes(por)) throw new ErroGanhos(400, M.por);
  if (loja != null && !LOJAS.includes(loja)) throw new ErroGanhos(400, M.loja);
  if (grupo != null) conferirGrupo(grupo, por, bloco);
  const blocoId = bloco == null ? null : idBloco(bloco);
  if (bloco != null && (blocoId === null || !db.prepare('SELECT 1 FROM blocks WHERE id = ?').get(blocoId))) throw new ErroGanhos(404, M.bloco);
  const grupoJid = grupo == null ? null : grupo;
  if (grupoJid !== null && !db.prepare('SELECT 1 FROM groups WHERE jid = ?').get(grupoJid)) throw new ErroGanhos(404, M.grupo);
  const v = viradaMin;
  const diaDe = dayOf(de, v); const diaAte = dayOf(ate, v);

  // blocos e grupos de hoje
  const nomesGrupos = new Map(db.prepare('SELECT jid, name FROM groups').all().map((g) => [g.jid, g.name]));
  const blocos = db.prepare('SELECT id, name FROM blocks ORDER BY id').all().map((b) => ({ id: Number(b.id), nome: b.name }));
  const nomesBlocos = new Map(blocos.map((b) => [b.id, b.nome]));
  const blocosDoGrupo = new Map(); const gruposDoBloco = new Map();
  for (const { block_id: b, jid } of db.prepare('SELECT block_id, jid FROM block_groups ORDER BY block_id, jid').all()) {
    const id = Number(b);
    if (!nomesBlocos.has(id)) continue; // ligação de bloco apagado
    if (!blocosDoGrupo.has(jid)) blocosDoGrupo.set(jid, []);
    blocosDoGrupo.get(jid).push(id);
    if (!gruposDoBloco.has(id)) gruposDoBloco.set(id, []);
    gruposDoBloco.get(id).push(jid);
  }
  const blocosDoAlvo = (alvo) => (!alvo ? [] : alvo.alvo_tipo === 'bloco' ? [alvo.bloco_id] : blocosDoGrupo.get(alvo.jid) || []);
  // recorte de grupo: só o atribuído ao próprio grupo (a venda atribuída ao bloco não se divide, ADR-006)
  const jidsRecorte = grupoJid !== null ? [grupoJid] : blocoId === null ? null : gruposDoBloco.get(blocoId) || [];
  const noRecorte = grupoJid !== null ? (alvo) => alvo?.alvo_tipo === 'grupo' && alvo.jid === grupoJid
    : (alvo) => blocoId === null || blocosDoAlvo(alvo).includes(blocoId);

  // comissões válidas e cliques do período, já atribuídos e recortados
  const atribuidor = criarAtribuidor(db, v);
  const filtroLoja = loja == null ? '' : ' AND loja = ?';
  const params = loja == null ? [diaDe, diaAte] : [diaDe, diaAte, loja];
  const comissoes = db.prepare(`SELECT loja, substr(data, 1, 10) AS dia, codigo, produto, titulo, quantidade, venda_centavos, comissao_centavos, status
    FROM comissoes WHERE substr(data, 1, 10) BETWEEN ? AND ? AND status != 'cancelada'${filtroLoja} ORDER BY id`).all(...params)
    .map((c) => ({
      loja: c.loja, dia: c.dia, produto: c.produto || null, titulo: c.titulo || null, status: c.status,
      quantidade: Number(c.quantidade), venda: Number(c.venda_centavos), comissao: Number(c.comissao_centavos),
      alvo: atribuidor(c.loja, c.codigo, c.dia),
    })).filter((f) => noRecorte(f.alvo));
  const cliques = db.prepare(`SELECT loja, substr(dia, 1, 10) AS dia, codigo, cliques FROM cliques_loja
    WHERE substr(dia, 1, 10) BETWEEN ? AND ?${filtroLoja}`).all(...params)
    .map((c) => ({ loja: c.loja, dia: c.dia, cliques: Number(c.cliques), alvo: atribuidor(c.loja, c.codigo, c.dia) }))
    .filter((f) => noRecorte(f.alvo));

  // M7, M9, M10 vêm de rastreio.cobertura (mesma conta da aba Rastreio)
  const cob = coberturaRastreio(db, { de, ate, loja, jids: jidsRecorte });
  const cobGrupo = new Map(cob.por_grupo.map((g) => [g.jid, g]));
  const cobLoja = new Map(cob.por_loja.map((l) => [l.loja, l]));

  // M12: gasto rateado por dia (valor × dias sobrepostos ÷ dias do gasto), só no próprio alvo
  const nDe = diaNum(diaDe); const nAte = diaNum(diaAte);
  const gastoGrupo = new Map(); const gastoBloco = new Map(); let gastoTodos = null;
  for (const g of db.prepare('SELECT alvo_tipo, alvo, inicio, fim, valor_centavos FROM gastos_anuncio WHERE inicio <= ? AND fim >= ?').all(diaAte, diaDe)) {
    const ini = diaNum(g.inicio); const fim = diaNum(g.fim);
    if (ini === null || fim === null || fim < ini) continue;
    const sobre = Math.min(fim, nAte) - Math.max(ini, nDe) + 1;
    if (sobre <= 0) continue;
    const parcela = (Number(g.valor_centavos) * sobre) / (fim - ini + 1);
    const mapa = g.alvo_tipo === 'bloco' ? gastoBloco : gastoGrupo;
    const chave = g.alvo_tipo === 'bloco' ? idBloco(g.alvo) : g.alvo;
    if (chave === null) continue;
    mapa.set(chave, (mapa.get(chave) || 0) + parcela);
    gastoTodos = (gastoTodos || 0) + parcela;
  }
  // M13: entradas (group_events 'add') por grupo; só a contagem, nunca o participante
  const entradasGrupo = new Map(db.prepare("SELECT jid, COUNT(*) AS n FROM group_events WHERE action = 'add' AND ts BETWEEN ? AND ? GROUP BY jid")
    .all(de, ate).map((e) => [e.jid, Number(e.n)]));
  // M12 só no próprio alvo: o bloco conta o que foi lançado para ele, não o lançado para os grupos dele
  const gastoDoBloco = (id) => gastoBloco.get(id) ?? null;
  const entradasDoBloco = (id) => (gruposDoBloco.get(id) || []).reduce((s, j) => s + (entradasGrupo.get(j) || 0), 0);
  const comLoja = loja != null;

  // total do recorte e "sem grupo identificado"
  const accTotal = novoAcc(); const accSem = novoAcc(); let linhasSem = 0;
  for (const f of comissoes) { somarComissao(accTotal, f); if (!f.alvo) { somarComissao(accSem, f); linhasSem++; } }
  for (const f of cliques) { somarCliques(accTotal, f); if (!f.alvo) somarCliques(accSem, f); }
  const gastoTotal = grupoJid !== null ? gastoGrupo.get(grupoJid) ?? null : blocoId === null ? gastoTodos : gastoDoBloco(blocoId);
  const entradasTotal = grupoJid !== null ? entradasGrupo.get(grupoJid) || 0
    : blocoId === null ? [...entradasGrupo.values()].reduce((s, n) => s + n, 0) : entradasDoBloco(blocoId);
  const total = {
    ...dinheiro(accTotal), ...envios(cob.total), ...atribuicao(accTotal),
    ...custos(accTotal.comissao, gastoTotal, entradasTotal, comLoja),
  };
  const naoAtribuida = blocoId !== null || grupoJid !== null ? null
    : { linhas: linhasSem, comissao: accSem.comissao, receita: accSem.receita, vendas: accSem.vendas, cliques: accSem.cliques };

  /** Acumuladores por chave da linha: `chaves(f)` diz em quais linhas cada comissão/clique entra. */
  const agrupar = (chaves) => {
    const accs = new Map();
    const acc = (k) => { if (!accs.has(k)) accs.set(k, novoAcc()); return accs.get(k); };
    for (const f of comissoes) for (const k of chaves(f, 'comissao')) somarComissao(acc(k), f);
    for (const f of cliques) for (const k of chaves(f, 'cliques')) somarCliques(acc(k), f);
    return accs;
  };

  let linhas;
  if (por === 'grupo') {
    const accs = agrupar((f) => (f.alvo?.alvo_tipo === 'grupo' ? [f.alvo.jid] : []));
    // grupos com algum movimento no período (comissão, clique, envio, gasto ou entrada); no recorte, só os do bloco
    const doBloco = new Set(jidsRecorte || []);
    const jids = new Set([...accs.keys(), ...cobGrupo.keys(), ...gastoGrupo.keys(), ...entradasGrupo.keys()]
      .filter((j) => jidsRecorte === null || doBloco.has(j)));
    linhas = [...jids].map((jid) => {
      const acc = accs.get(jid) || novoAcc();
      return {
        jid, nome: nomesGrupos.get(jid) ?? null,
        blocos: (blocosDoGrupo.get(jid) || []).map((id) => ({ id, nome: nomesBlocos.get(id) })),
        ...dinheiro(acc), ...envios(cobGrupo.get(jid)),
        ...custos(acc.comissao, gastoGrupo.get(jid) ?? null, entradasGrupo.get(jid) || 0, comLoja),
      };
    }).sort(porComissao((l) => l.nome ?? l.jid));
  } else if (por === 'bloco') {
    const accs = agrupar((f) => blocosDoAlvo(f.alvo));
    const ids = new Set([...blocos.map((b) => b.id), ...accs.keys()].filter((id) => blocoId === null || id === blocoId));
    linhas = [...ids].map((id) => {
      const acc = accs.get(id) || novoAcc();
      const jids = gruposDoBloco.get(id) || [];
      return {
        bloco_id: id, nome: nomesBlocos.get(id) ?? null, grupos: jids.length,
        ...dinheiro(acc), ...envios(coberturaRastreio(db, { de, ate, loja, jids }).total),
        ...custos(acc.comissao, gastoDoBloco(id), entradasDoBloco(id), comLoja),
      };
    }).sort(porComissao((l) => l.nome ?? String(l.bloco_id)));
  } else if (por === 'loja') {
    const accs = agrupar((f) => [f.loja]);
    linhas = LOJAS.filter((l) => loja == null || l === loja).map((l) => {
      const acc = accs.get(l) || novoAcc();
      return { loja: l, ...dinheiro(acc), ...envios(cobLoja.get(l)), ...atribuicao(acc) };
    });
  } else if (por === 'oferta') {
    const ofertas = new Map(); // chave → { loja, oferta, titulo, acc }
    for (const f of comissoes) {
      if (!f.produto) continue;
      const k = chaveOferta(f.loja, f.produto);
      if (!ofertas.has(k)) ofertas.set(k, { loja: f.loja, oferta: f.produto, titulo: null, acc: novoAcc() });
      const o = ofertas.get(k);
      if (f.titulo) o.titulo = f.titulo; // o mais recente importado
      somarComissao(o.acc, f);
    }
    const filtroJids = jidsRecorte === null ? '' : ` AND jid IN (${jidsRecorte.map(() => '?').join(',') || 'NULL'})`;
    const enviados = new Map(db.prepare(`SELECT loja, oferta_chave, COUNT(*) AS envios, COUNT(DISTINCT jid) AS grupos FROM rastreio_envios
      WHERE ts BETWEEN ? AND ? AND oferta_chave IS NOT NULL${filtroLoja}${filtroJids} GROUP BY loja, oferta_chave`)
      .all(de, ate, ...(loja == null ? [] : [loja]), ...(jidsRecorte || []))
      .map((e) => [chaveOferta(e.loja, e.oferta_chave), e]));
    linhas = [...ofertas].map(([k, o]) => {
      const d = dinheiro(o.acc); const e = enviados.get(k);
      return {
        loja: o.loja, oferta: o.oferta, titulo: o.titulo, url: urlDaOferta(o.loja, o.oferta),
        comissao: d.comissao, comissao_confirmada: d.comissao_confirmada, receita: d.receita, vendas: d.vendas,
        envios: e ? Number(e.envios) : 0, grupos: e ? Number(e.grupos) : 0,
      };
    }).sort(porComissao((l) => l.titulo ?? l.oferta));
  } else {
    const accs = agrupar((f) => [f.dia]);
    linhas = [];
    for (let n = nDe; n <= nAte; n++) {
      const dia = diaTexto(n); const d = dinheiro(accs.get(dia) || novoAcc()); const lim = limitesDoDia(dia, v);
      linhas.push({
        dia, comissao: d.comissao, comissao_confirmada: d.comissao_confirmada, receita: d.receita, vendas: d.vendas, cliques: d.cliques,
        ...envios(coberturaRastreio(db, { de: lim.de, ate: lim.ate, loja, jids: jidsRecorte }).total),
      });
    }
  }

  const importadoAte = {};
  for (const r of db.prepare('SELECT loja, MAX(substr(data, 1, 10)) AS ate FROM comissoes GROUP BY loja').all()) {
    if (LOJAS.includes(r.loja)) importadoAte[r.loja] = r.ate;
  }
  // M16: os mesmos N dias de negócio logo antes (a regra da Visão Geral), com os mesmos filtros. O recorte mais
  // barato que dá o total: por loja; com grupo, por oferta (o grupo só vale nele).
  let anterior = null;
  if (comparar === true) {
    const n = Math.max(1, nAte - nDe + 1); // periodRange nunca dá de > ate; chamada direta com período invertido vale 1 dia
    const diaDeAnt = diaTexto(nDe - n); const diaAteAnt = diaTexto(nDe - 1);
    const tAnt = metricas(db, {
      de: limitesDoDia(diaDeAnt, v).de, ate: limitesDoDia(diaAteAnt, v).ate, por: grupoJid !== null ? 'oferta' : 'loja',
      loja, bloco: blocoId, grupo: grupoJid, viradaMin: v,
    }).total;
    anterior = {
      dia_de: diaDeAnt, dia_ate: diaAteAnt, total: tAnt,
      variacao: Object.fromEntries(CAMPOS_VARIACAO.map((k) => [k, variacao(total[k], tAnt[k])])),
    };
  }

  return {
    de, ate, dia_de: diaDe, dia_ate: diaAte, por, loja: loja ?? null, bloco: blocoId, grupo: grupoJid,
    total, nao_atribuida: naoAtribuida, cobertura: { total: envios(cob.total), por_loja: cob.por_loja }, linhas,
    importado_ate: importadoAte,
    gastos_informados: Number(db.prepare('SELECT COUNT(*) AS n FROM gastos_anuncio').get().n),
    anterior,
  };
}

// ---------- gastos com anúncio ----------

/** O bloco tem gasto com anúncio lançado (de qualquer período)? Id que não é inteiro positivo canônico ('01', '1e0') → false. */
export function blocoTemGasto(db, id) {
  const alvo = idBloco(id);
  return alvo !== null && !!db.prepare("SELECT 1 FROM gastos_anuncio WHERE alvo_tipo = 'bloco' AND alvo = ?").get(String(alvo));
}

const SQL_GASTOS = `SELECT g.id, g.alvo_tipo, g.alvo,
    CASE g.alvo_tipo WHEN 'grupo' THEN (SELECT name FROM groups WHERE jid = g.alvo)
      ELSE (SELECT name FROM blocks WHERE CAST(id AS TEXT) = g.alvo) END AS nome_alvo,
    g.inicio, g.fim, g.valor_centavos, g.nota, g.criado_em
  FROM gastos_anuncio g`;

/** Gastos informados, do início mais recente para o mais antigo, com o nome atual do alvo (null se sumiu). */
export function listarGastos(db) {
  return db.prepare(`${SQL_GASTOS} ORDER BY g.inicio DESC, g.id DESC`).all();
}

/**
 * Confere um gasto `{alvo_tipo, alvo, inicio, fim, valor_centavos, nota?}` e devolve-o limpo (alvo de bloco em
 * texto canônico, nota aparada ou null). Erros: ErroGanhos 400 (dado) ou 404 (alvo), com frase fixa.
 */
export function validarGasto(db, entrada) {
  if (!entrada || typeof entrada !== 'object' || Array.isArray(entrada)) throw new ErroGanhos(400, M.corpo);
  const { alvo_tipo: tipo } = entrada;
  if (tipo !== 'grupo' && tipo !== 'bloco') throw new ErroGanhos(400, M.alvo);
  let alvo;
  if (tipo === 'bloco') {
    const id = idBloco(entrada.alvo);
    if (id === null || !db.prepare('SELECT 1 FROM blocks WHERE id = ?').get(id)) throw new ErroGanhos(404, M.bloco);
    alvo = String(id);
  } else {
    alvo = entrada.alvo;
    if (typeof alvo !== 'string' || !alvo || alvo.length > MAX_JID || !db.prepare('SELECT 1 FROM groups WHERE jid = ?').get(alvo)) {
      throw new ErroGanhos(404, M.grupo);
    }
  }
  const ini = diaNum(entrada.inicio); const fim = diaNum(entrada.fim);
  if (ini === null || fim === null) throw new ErroGanhos(400, M.periodo);
  if (fim < ini) throw new ErroGanhos(400, M.ordem);
  if (fim - ini + 1 > MAX_DIAS_GASTO) throw new ErroGanhos(400, M.longo);
  const valor = entrada.valor_centavos;
  if (!Number.isInteger(valor)) throw new ErroGanhos(400, M.valor_formato);
  if (valor <= 0) throw new ErroGanhos(400, M.valor);
  if (valor > MAX_VALOR_CENTAVOS) throw new ErroGanhos(400, M.valor_formato);
  let nota = entrada.nota ?? null;
  if (nota !== null) {
    if (typeof nota !== 'string') throw new ErroGanhos(400, M.nota);
    nota = nota.trim();
    if (nota.length > MAX_NOTA) throw new ErroGanhos(400, M.nota);
    if (!nota) nota = null;
  }
  return { alvo_tipo: tipo, alvo, inicio: entrada.inicio, fim: entrada.fim, valor_centavos: valor, nota };
}

/**
 * Grava um gasto (sem edição: apaga e lança de novo). Devolve `{ gasto, aviso }`; `aviso` é a frase de
 * MENSAGENS_GANHOS.sobreposto quando o mesmo alvo já tem gasto que cruza o período (não bloqueia), senão null.
 */
export function salvarGasto(db, entrada, { agora = Date.now(), userId = null } = {}) {
  const g = validarGasto(db, entrada);
  const cruza = db.prepare('SELECT 1 FROM gastos_anuncio WHERE alvo_tipo = ? AND alvo = ? AND inicio <= ? AND fim >= ?')
    .get(g.alvo_tipo, g.alvo, g.fim, g.inicio);
  const { lastInsertRowid: id } = db.prepare(`INSERT INTO gastos_anuncio (alvo_tipo, alvo, inicio, fim, valor_centavos, nota, criado_em, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(g.alvo_tipo, g.alvo, g.inicio, g.fim, g.valor_centavos, g.nota,
    Number.isFinite(agora) ? Math.trunc(agora) : Date.now(), Number.isInteger(userId) ? userId : null);
  return { gasto: db.prepare(`${SQL_GASTOS} WHERE g.id = ?`).get(id), aviso: cruza ? M.sobreposto : null };
}

/** Apaga o gasto `id` (número ou texto só de dígitos). Devolve se apagou. */
export function apagarGasto(db, id) {
  const s = typeof id === 'number' ? String(id) : id;
  if (typeof s !== 'string' || !RE_ID.test(s)) return false;
  return Number(db.prepare('DELETE FROM gastos_anuncio WHERE id = ?').run(Number(s)).changes) > 0;
}

// ---------- rotas (etapa 15) ----------

/** Sem `ctx.soDono` (servidor montado sem login), ninguém lê nem mexe: falha fechada. */
const negar = (_req, res) => res.status(403).json({ erro: 'Só o Dono pode fazer isso.' });

const responder = (fn) => (req, res) => {
  try { res.json(fn(req)); } catch (e) {
    if (e instanceof ErroGanhos) return res.status(e.status).json({ erro: e.message });
    // sem e.message: o erro do SQLite pode trazer os valores da consulta
    console.error('[ganhos] falha inesperada:', e?.code || e?.name || 'erro');
    res.status(500).json({ erro: 'Não consegui concluir. Tente de novo.' });
  }
};

/**
 * Consulta de GET /api/ganhos → argumentos de metricas. Vazio vale o padrão (mês atual, por grupo, todas as lojas,
 * todos os blocos, sem grupo, sem comparar); parâmetro repetido (vira lista) ou fora do formato → ErroGanhos com
 * frase fixa. `comparar` só aceita '1'; `grupo` só com por=oferta e sem bloco (a existência fica com metricas).
 */
export function lerConsulta(q = {}, viradaMin = 0, now = Date.now()) {
  const recusa = { periodo: [400, M.periodo_consulta], de: [400, M.periodo_consulta], ate: [400, M.periodo_consulta],
    por: [400, M.por], loja: [400, M.loja], bloco: [404, M.bloco], grupo: [404, M.grupo], comparar: [400, M.comparar] };
  const texto = (campo, padrao) => {
    const x = q[campo];
    if (x == null || x === '') return padrao;
    if (typeof x !== 'string') throw new ErroGanhos(...recusa[campo]);
    return x;
  };
  const periodo = texto('periodo', 'mes');
  if (!PERIODOS.includes(periodo)) throw new ErroGanhos(400, M.periodo_consulta);
  const de = texto('de', ''); const ate = texto('ate', '');
  if ((de && diaNum(de) === null) || (ate && diaNum(ate) === null)) throw new ErroGanhos(400, M.periodo_consulta);
  const faixa = periodRange(periodo, now, { de, ate }, viradaMin);
  const por = texto('por', 'grupo'); const loja = texto('loja', null); const bloco = texto('bloco', null);
  const grupo = texto('grupo', null); const comparar = texto('comparar', null);
  if (comparar !== null && comparar !== '1') throw new ErroGanhos(400, M.comparar);
  if (grupo !== null) {
    if (!POR.includes(por)) throw new ErroGanhos(400, M.por); // a mesma recusa de metricas, antes da do grupo
    conferirGrupo(grupo, por, bloco);
  }
  return { de: faixa.de, ate: faixa.ate, por, loja, bloco, grupo, comparar: comparar === '1', viradaMin };
}

/**
 * Rotas dos ganhos, montadas por buildApp depois do Host/Origin e do login. Todas só do Dono, inclusive GET (D9, P2):
 *   GET /api/ganhos?periodo=&de=&ate=&por=grupo|bloco|loja|oferta|dia&loja=&bloco=&grupo=&comparar=1 → metricas(…)
 *   GET /api/ganhos/gastos → { gastos }; POST /api/ganhos/gastos → { gasto, aviso, gastos };
 *   DELETE /api/ganhos/gastos/:id → { gastos }. Erros: { erro } com frase fixa de MENSAGENS_GANHOS, sem eco.
 * `ctx.viradaMin()` (opcional) dá a virada do dia de negócio, como a Visão Geral.
 */
export function montarRotas(app, ctx) {
  const { db } = ctx;
  const soDono = typeof ctx.soDono === 'function' ? ctx.soDono : negar;
  const virada = () => (typeof ctx.viradaMin === 'function' ? ctx.viradaMin() : 0);
  app.get('/api/ganhos', soDono, responder((req) => metricas(db, lerConsulta(req.query, virada()))));
  app.get('/api/ganhos/gastos', soDono, responder(() => ({ gastos: listarGastos(db) })));
  app.post('/api/ganhos/gastos', soDono, responder((req) => {
    const r = salvarGasto(db, req.body, { userId: req.user?.id ?? null });
    return { ...r, gastos: listarGastos(db) };
  }));
  app.delete('/api/ganhos/gastos/:id', soDono, responder((req) => {
    if (!apagarGasto(db, req.params.id)) throw new ErroGanhos(404, M.gasto_sumiu);
    return { gastos: listarGastos(db) };
  }));
}
