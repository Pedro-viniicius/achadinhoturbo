// Rastreio por grupo nos links de afiliado (docs/produto/planos/dashboard-ganhos.md, ADR-006).
// O dono associa um código a um grupo ou bloco, por loja (tabela rastreio_codigos):
//   Mercado Livre: nome de uma etiqueta de afiliado cadastrada (tags);
//   Amazon: ID de rastreamento (mesmo formato da tag de Conexões);
//   Shopee: Sub_id, só por bloco (decisão do dono, P6: cada código é um pedido de link a mais).
// Precedência: grupo > bloco (o de menor id) > padrão de hoje. Sem associação, nada muda (CA9).
// Cada envio de oferta que deu certo grava uma linha por grupo em rastreio_envios (CA1); daí saem a
// cobertura (M9) e o alcance (M10) do catálogo de métricas. Nenhum dado de pessoa passa por aqui.
// Rotas (montarRotas, todas só do Dono, inclusive as de leitura: decisão P2 do dono):
//   GET /api/rastreio/codigos → { codigos }; PUT /api/rastreio/codigos (uma associação ou { associacoes: [...] },
//   tudo ou nada) → { codigos }; GET /api/rastreio/cobertura?periodo=&de=&ate=&loja=&bloco= → { de, ate, total,
//   por_loja, por_grupo }. Erros: { erro } com frase fixa de MENSAGENS_RASTREIO, sem eco do valor recebido.

import { periodRange } from './analytics.js';
import { RE_TAG } from './amazon.js';
import { RE_SUB_ID } from './shopee.js';

/** Dias que uma linha de rastreio_envios fica guardada (P3: mais que o atraso dos relatórios das lojas). */
export const RETENCAO_RASTREIO_DIAS = 400;
export const LOJAS = Object.freeze(['mercadolivre', 'amazon', 'shopee']);
export const ALVOS = Object.freeze(['grupo', 'bloco']);
export const ORIGENS = Object.freeze(['regra', 'manual', 'catalogo', 'espelho']);
export const NIVEIS = Object.freeze(['grupo', 'bloco', 'padrao', 'nenhum']);
// Só para a frase de MENSAGENS_RASTREIO.shopee: o formato é o RE_SUB_ID de src/shopee.js (mudar o teto lá pede mudar aqui).
export const MAX_SUB_ID = 30; // provisório: o limite real da Shopee não foi verificado (plano, D3)
const RE_ID_BLOCO = /^[1-9]\d{0,15}$/;
const MAX_JID = 200;
const MAX_MOTIVO = 40;
/** Associações por PUT: o formulário do bloco manda 3 (uma por loja); folga para o painel juntar mais. */
export const MAX_LOTE = 10;
const DIA_MS = 86400000;

export const MENSAGENS_RASTREIO = Object.freeze({
  loja: 'Loja desconhecida.',
  alvo: 'Escolha um grupo ou bloco.',
  corpo: 'Envie a associação.',
  vazio: 'Informe o código.',
  duplicado: 'Este código já está associado a outro grupo ou bloco.',
  bloco: 'Este bloco não existe mais.',
  grupo: 'Este grupo não existe mais.',
  shopee_grupo: 'O Sub_id da Shopee se define só no bloco, não no grupo.',
  shopee: `O Sub_id aceita só letras e números, sem espaços (até ${MAX_SUB_ID} caracteres).`,
  amazon: 'O ID de rastreamento da Amazon costuma terminar em -20, como casa-20. Confira em Gerenciar IDs de rastreamento.',
  amazon_numero: 'Isso parece um ID de afiliado. O ID de rastreamento da Amazon tem letras e termina em -20.',
  amazon_padrao: 'Essa é a tag padrão da conta (Conexões > Amazon) e não separa as vendas deste grupo ou bloco. Use outro ID de rastreamento.',
  lote: `Envie no máximo ${MAX_LOTE} associações de uma vez.`,
  etiqueta: 'Essa etiqueta não está cadastrada. Escolha uma da lista.',
  // rotas de blocos e etiquetas (src/server.js): apagar o bloco ou trocar os grupos dele mexe nas associações (CA11)
  bloco_apagar: 'Este bloco tem códigos de rastreio. Só o Dono pode apagá-lo.',
  bloco_grupos: 'Este bloco tem códigos de rastreio. Só o Dono pode mudar os grupos dele.',
  etiqueta_em_uso: 'Esta etiqueta é código de rastreio de um grupo ou bloco. Tire a associação antes de apagá-la.',
});

/** Erro com status HTTP e frase pronta para a tela. Nunca carrega o valor recebido. */
export class ErroRastreio extends Error {
  constructor(status, mensagem) { super(mensagem); this.status = status; }
}

const lojaValida = (loja) => typeof loja === 'string' && LOJAS.includes(loja);
function exigirLoja(loja) {
  if (!lojaValida(loja)) throw new ErroRastreio(400, MENSAGENS_RASTREIO.loja);
}

/** Id do bloco em texto ('7'), como fica em rastreio_codigos.alvo; null se não for um id. */
function idBloco(v) {
  const s = typeof v === 'number' ? String(v) : v;
  return typeof s === 'string' && RE_ID_BLOCO.test(s) ? s : null;
}

/**
 * A tag padrão da Amazon (Conexões) é `c`? Sem maiúsculas/minúsculas, como src/amazon.js a lê (config.tag, ou
 * segredos.tag das versões antigas). A comparação fica dentro do SQLite: a tag não passa pelo JavaScript.
 */
function ehTagPadraoAmazon(db, c) {
  const tag = (col) => `CASE WHEN json_valid(${col}) THEN json_extract(${col}, '$.tag') END`;
  return !!db.prepare(`SELECT 1 FROM conexoes WHERE plataforma = 'amazon'
    AND lower(trim(COALESCE(${tag('config')}, ${tag('segredos')}))) = lower(?)`).get(c);
}

/**
 * Confere o código de uma loja e devolve-o limpo (sem espaço nas pontas). `alvo_tipo` 'grupo' recusa a
 * Shopee (P6). Etiqueta do ML tem de existir em tags com o nome exato. A Amazon recusa a tag padrão de
 * Conexões: o envio sem associação já sai com ela, e a comissão desse código seria atribuída ao grupo
 * associado mesmo vindo dos outros. Erro: ErroRastreio 400.
 */
export function validarCodigo(db, loja, codigo, alvo_tipo) {
  exigirLoja(loja);
  const c = typeof codigo === 'string' ? codigo.trim() : '';
  if (!c) throw new ErroRastreio(400, MENSAGENS_RASTREIO.vazio);
  if (loja === 'shopee') {
    if (alvo_tipo === 'grupo') throw new ErroRastreio(400, MENSAGENS_RASTREIO.shopee_grupo);
    if (!RE_SUB_ID.test(c)) throw new ErroRastreio(400, MENSAGENS_RASTREIO.shopee);
  } else if (loja === 'amazon') {
    if (/^\d+$/.test(c)) throw new ErroRastreio(400, MENSAGENS_RASTREIO.amazon_numero);
    if (!RE_TAG.test(c)) throw new ErroRastreio(400, MENSAGENS_RASTREIO.amazon);
    if (ehTagPadraoAmazon(db, c)) throw new ErroRastreio(400, MENSAGENS_RASTREIO.amazon_padrao);
  } else if (!db.prepare('SELECT 1 FROM tags WHERE name = ?').get(c)) {
    throw new ErroRastreio(400, MENSAGENS_RASTREIO.etiqueta);
  }
  return c;
}

const SQL_LISTAR = 'SELECT id, loja, alvo_tipo, alvo, codigo, criado_em, atualizado_em FROM rastreio_codigos';

/** Todas as associações, por loja, tipo de alvo e alvo. */
export function listar(db) {
  return db.prepare(`${SQL_LISTAR} ORDER BY loja, alvo_tipo, alvo`).all();
}

/**
 * Grava a associação loja × alvo → código (troca a que houver). Código vazio apaga (mesmo de alvo que já
 * sumiu). Devolve a linha gravada, ou null quando apagou. Erros: ErroRastreio 400 (dado) ou 404 (alvo).
 */
export function salvar(db, entrada, agora = Date.now()) {
  if (!entrada || typeof entrada !== 'object') throw new ErroRastreio(400, MENSAGENS_RASTREIO.corpo);
  const { loja, alvo_tipo: tipo, codigo } = entrada;
  exigirLoja(loja);
  if (!ALVOS.includes(tipo)) throw new ErroRastreio(400, MENSAGENS_RASTREIO.alvo);
  const alvo = tipo === 'bloco' ? idBloco(entrada.alvo)
    : (typeof entrada.alvo === 'string' && entrada.alvo.length > 0 && entrada.alvo.length <= MAX_JID ? entrada.alvo : null);
  if (alvo === null) throw new ErroRastreio(404, MENSAGENS_RASTREIO[tipo]);

  const chave = [loja, tipo, alvo];
  if (codigo == null || (typeof codigo === 'string' && !codigo.trim())) {
    db.prepare('DELETE FROM rastreio_codigos WHERE loja = ? AND alvo_tipo = ? AND alvo = ?').run(...chave);
    return null;
  }
  const c = validarCodigo(db, loja, codigo, tipo);
  const existeAlvo = tipo === 'bloco'
    ? db.prepare('SELECT 1 FROM blocks WHERE id = ?').get(Number(alvo))
    : db.prepare('SELECT 1 FROM groups WHERE jid = ?').get(alvo);
  if (!existeAlvo) throw new ErroRastreio(404, MENSAGENS_RASTREIO[tipo]);

  // a Amazon não distingue maiúsculas no ID de rastreamento (Q2): casa-20 e Casa-20 são o mesmo código
  const mesmoCodigo = loja === 'amazon' ? 'lower(codigo) = lower(?)' : 'codigo = ?';
  const dono = db.prepare(`SELECT alvo_tipo, alvo, codigo FROM rastreio_codigos WHERE loja = ? AND ${mesmoCodigo}`).get(loja, c);
  if (dono && (dono.alvo_tipo !== tipo || dono.alvo !== alvo)) throw new ErroRastreio(400, MENSAGENS_RASTREIO.duplicado);
  if (!dono || dono.codigo !== c) {
    try {
      db.prepare(`INSERT INTO rastreio_codigos (loja, alvo_tipo, alvo, codigo, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (loja, alvo_tipo, alvo) DO UPDATE SET codigo = excluded.codigo, atualizado_em = excluded.atualizado_em`)
        .run(...chave, c, agora, agora);
    } catch (e) {
      // outra gravação levou o código entre a leitura e esta escrita
      if (/UNIQUE constraint failed: rastreio_codigos\.loja, rastreio_codigos\.codigo/.test(e?.message)) {
        throw new ErroRastreio(400, MENSAGENS_RASTREIO.duplicado);
      }
      throw e;
    }
  }
  return db.prepare(`${SQL_LISTAR} WHERE loja = ? AND alvo_tipo = ? AND alvo = ?`).get(...chave);
}

/**
 * Corpo do PUT: uma associação (`{loja, alvo_tipo, alvo, codigo}`) ou `{ associacoes: [...] }` (até MAX_LOTE).
 * Tudo ou nada: a primeira recusa desfaz as anteriores e sobe o ErroRastreio dela.
 */
export function salvarVarios(db, corpo, agora = Date.now()) {
  const objeto = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  if (!objeto(corpo)) throw new ErroRastreio(400, MENSAGENS_RASTREIO.corpo);
  const lista = 'associacoes' in corpo ? corpo.associacoes : [corpo];
  if (!Array.isArray(lista) || !lista.length || !lista.every(objeto)) throw new ErroRastreio(400, MENSAGENS_RASTREIO.corpo);
  if (lista.length > MAX_LOTE) throw new ErroRastreio(400, MENSAGENS_RASTREIO.lote);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const a of lista) salvar(db, a, agora);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Apaga as associações de um bloco em todas as lojas (bloco apagado). Devolve quantas saíram. */
export function apagarDoBloco(db, id) {
  const alvo = idBloco(id);
  if (alvo === null) return 0;
  return Number(db.prepare("DELETE FROM rastreio_codigos WHERE alvo_tipo = 'bloco' AND alvo = ?").run(alvo).changes);
}

/** O bloco tem associação em alguma loja? Id que não é inteiro positivo canônico ('01', '1e0') → false. */
export function blocoTemCodigo(db, id) {
  const alvo = idBloco(id);
  return alvo !== null && !!db.prepare("SELECT 1 FROM rastreio_codigos WHERE alvo_tipo = 'bloco' AND alvo = ?").get(alvo);
}

/** A etiqueta (nome exato em tags) é código de rastreio do Mercado Livre de algum grupo ou bloco? */
export function etiquetaEmUso(db, nome) {
  return typeof nome === 'string' && !!nome
    && !!db.prepare("SELECT 1 FROM rastreio_codigos WHERE loja = 'mercadolivre' AND codigo = ?").get(nome);
}

const padrao = (esperado = 0, motivo = null) => ({ codigo: null, nivel: 'padrao', bloco_id: null, esperado, motivo });

/**
 * Código de rastreio do grupo numa loja: `{codigo, nivel, bloco_id, esperado, motivo}`.
 * Sem associação: `codigo` null, nivel 'padrao', esperado 0 (quem envia usa o código de hoje).
 * Etiqueta do ML associada mas apagada de tags: padrão, esperado 1, motivo 'etiqueta_apagada'.
 * Sub_id da Shopee gravado por grupo (só por fora do salvar) é ignorado (P6). Bloco apagado não vale.
 */
export function resolver(db, loja, jid) {
  exigirLoja(loja);
  let achado = null;
  if (loja !== 'shopee') {
    const g = db.prepare("SELECT codigo FROM rastreio_codigos WHERE loja = ? AND alvo_tipo = 'grupo' AND alvo = ?").get(loja, jid);
    if (g) achado = { codigo: g.codigo, nivel: 'grupo', bloco_id: null };
  }
  if (!achado) {
    const b = db.prepare(`SELECT bg.block_id, rc.codigo FROM block_groups bg
      JOIN blocks b ON b.id = bg.block_id
      JOIN rastreio_codigos rc ON rc.loja = ? AND rc.alvo_tipo = 'bloco' AND rc.alvo = CAST(bg.block_id AS TEXT)
      WHERE bg.jid = ? ORDER BY bg.block_id LIMIT 1`).get(loja, jid);
    if (b) achado = { codigo: b.codigo, nivel: 'bloco', bloco_id: Number(b.block_id) };
  }
  if (!achado) return padrao();
  if (loja === 'mercadolivre' && !db.prepare('SELECT 1 FROM tags WHERE name = ?').get(achado.codigo)) return padrao(1, 'etiqueta_apagada');
  return { ...achado, esperado: 1, motivo: null };
}

/**
 * Divide os grupos de um envio pelo código que cada um recebe: `[{codigo, nivel, bloco_id, esperado, motivo, jids}]`,
 * na ordem do primeiro grupo de cada entrada, com os grupos na ordem recebida. `padrao` é o código de hoje
 * (etiqueta da regra/envio, tag de Conexões, null na Shopee sem Sub_id); sem associação sai uma entrada só.
 * As entradas são homogêneas: duas podem ter o mesmo código (etiqueta apagada usa o padrão; associação igual
 * ao padrão). Quem gera o link deve reaproveitá-lo pelo código para não pedir o mesmo link duas vezes.
 */
export function agrupar(db, { loja, jids, padrao: codigoPadrao = null } = {}) {
  exigirLoja(loja);
  const entradas = new Map();
  for (const jid of jids || []) {
    const r = resolver(db, loja, jid);
    const codigo = r.nivel === 'padrao' ? (codigoPadrao || null) : r.codigo;
    const chave = JSON.stringify([codigo, r.nivel, r.bloco_id, r.esperado, r.motivo]);
    if (!entradas.has(chave)) entradas.set(chave, { codigo, nivel: r.nivel, bloco_id: r.bloco_id, esperado: r.esperado, motivo: r.motivo, jids: [] });
    entradas.get(chave).jids.push(jid);
  }
  return [...entradas.values()];
}

const textoOuNulo = (v) => (typeof v === 'string' && v ? v : null);
const inteiroOuNulo = (v) => (Number.isInteger(v) ? v : null);

/**
 * Grava a linha de um grupo que recebeu a oferta. Campos: ts (padrão agora), jid, loja, origem, link, nivel
 * (obrigatórios), rule_id, envio_id, oferta_chave, codigo, bloco_id, esperado, motivo. Devolve o id.
 * Linha inválida: TypeError que nomeia só o campo (nunca o valor: o link é de afiliado).
 */
export function registrar(db, linha) {
  if (!linha || typeof linha !== 'object') throw new TypeError('rastreio: linha ausente');
  const invalido = (campo) => { throw new TypeError(`rastreio: campo ${campo} inválido`); };
  if (!lojaValida(linha.loja)) invalido('loja');
  if (!ORIGENS.includes(linha.origem)) invalido('origem');
  if (!NIVEIS.includes(linha.nivel)) invalido('nivel');
  if (typeof linha.jid !== 'string' || !linha.jid || linha.jid.length > MAX_JID) invalido('jid');
  if (typeof linha.link !== 'string' || !linha.link) invalido('link');
  const ts = Number.isFinite(linha.ts) ? Math.trunc(linha.ts) : Date.now();
  const motivo = textoOuNulo(linha.motivo);
  const r = db.prepare(`INSERT INTO rastreio_envios (ts, jid, loja, origem, rule_id, envio_id, oferta_chave, link, codigo, nivel, bloco_id, esperado, motivo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    ts, linha.jid, linha.loja, linha.origem, inteiroOuNulo(linha.rule_id), inteiroOuNulo(linha.envio_id), textoOuNulo(linha.oferta_chave),
    linha.link, textoOuNulo(linha.codigo), linha.nivel, inteiroOuNulo(linha.bloco_id), linha.esperado ? 1 : 0, motivo && motivo.slice(0, MAX_MOTIVO));
  return Number(r.lastInsertRowid);
}

const razao = (a, b) => (b > 0 ? a / b : null);
function contas(envios, esperados, rastreados) {
  // M9 = rastreados ÷ esperados; M10 = esperados ÷ envios (catálogo de métricas do plano)
  return { envios, esperados, rastreados, cobertura: razao(rastreados, esperados), alcance: razao(esperados, envios) };
}

/**
 * Cobertura do rastreio (M9) e alcance das associações (M10) no período [de, ate] (ms, inclusive, como
 * periodRange de analytics.js), opcionalmente de uma loja e/ou de alguns grupos (lista vazia = nenhum).
 * Devolve `{ total, por_loja: [{loja, …}], por_grupo: [{jid, …}] }` com envios, esperados, rastreados,
 * cobertura e alcance; divisão por zero = null.
 */
export function cobertura(db, { de, ate, loja, jids } = {}) {
  if (!Number.isFinite(de) || !Number.isFinite(ate)) throw new TypeError('rastreio: período inválido');
  if (loja != null) exigirLoja(loja);
  if (jids != null && (!Array.isArray(jids) || !jids.every((j) => typeof j === 'string'))) throw new TypeError('rastreio: lista de grupos inválida');
  const vazio = { total: contas(0, 0, 0), por_loja: [], por_grupo: [] };
  if (jids && !jids.length) return vazio;

  let sql = `SELECT loja, jid, COUNT(*) AS envios, SUM(esperado = 1) AS esperados,
    SUM(esperado = 1 AND nivel IN ('grupo', 'bloco')) AS rastreados
    FROM rastreio_envios WHERE ts BETWEEN ? AND ?`;
  const params = [de, ate];
  if (loja != null) { sql += ' AND loja = ?'; params.push(loja); }
  if (jids) { sql += ` AND jid IN (${jids.map(() => '?').join(',')})`; params.push(...jids); }
  const linhas = db.prepare(`${sql} GROUP BY loja, jid ORDER BY jid`).all(...params);
  if (!linhas.length) return vazio;

  // [envios, esperados, rastreados] somados por loja, por grupo e no total
  const somar = (mapa, chave, l) => {
    const s = mapa.get(chave) || [0, 0, 0];
    mapa.set(chave, [s[0] + Number(l.envios), s[1] + Number(l.esperados), s[2] + Number(l.rastreados)]);
  };
  const porLoja = new Map(); const porGrupo = new Map(); const total = new Map();
  for (const l of linhas) { somar(porLoja, l.loja, l); somar(porGrupo, l.jid, l); somar(total, 'total', l); }
  return {
    total: contas(...total.get('total')),
    por_loja: LOJAS.filter((l) => porLoja.has(l)).map((l) => ({ loja: l, ...contas(...porLoja.get(l)) })),
    por_grupo: [...porGrupo].map(([jid, s]) => ({ jid, ...contas(...s) })),
  };
}

/** Apaga as linhas de rastreio_envios com mais de `dias` dias (inválido vale RETENCAO_RASTREIO_DIAS). Devolve quantas. */
export function limpar(db, dias = RETENCAO_RASTREIO_DIAS, now = Date.now()) {
  const d = Number.isFinite(dias) && dias > 0 ? dias : RETENCAO_RASTREIO_DIAS;
  return Number(db.prepare('DELETE FROM rastreio_envios WHERE ts < ?').run(now - d * DIA_MS).changes);
}

// ---------- rotas ----------

/** Sem `ctx.soDono` (servidor montado sem login), ninguém mexe nem lê: falha fechada. */
const negar = (_req, res) => res.status(403).json({ erro: 'Só o Dono pode fazer isso.' });

const responder = (fn) => (req, res) => {
  try { res.json(fn(req)); } catch (e) {
    if (e instanceof ErroRastreio) return res.status(e.status).json({ erro: e.message });
    // sem e.message: o erro do SQLite pode trazer os valores da consulta
    console.error('[rastreio] falha inesperada:', e?.code || e?.name || 'erro');
    res.status(500).json({ erro: 'Não consegui concluir. Tente de novo.' });
  }
};

/** Grupos do bloco pedido no filtro da cobertura; bloco que não é id ou não existe → 404. */
function gruposDoBloco(db, bloco) {
  const id = idBloco(bloco);
  if (id === null || !db.prepare('SELECT 1 FROM blocks WHERE id = ?').get(Number(id))) throw new ErroRastreio(404, MENSAGENS_RASTREIO.bloco);
  return db.prepare('SELECT jid FROM block_groups WHERE block_id = ?').all(Number(id)).map((r) => r.jid);
}

/**
 * Rotas do rastreio, montadas por buildApp depois do Host/Origin e do login. Todas só do Dono (P2), inclusive GET.
 * `ctx.viradaMin()` (opcional) dá a virada do dia de negócio do período da cobertura, como a Visão Geral.
 */
export function montarRotas(app, ctx) {
  const { db } = ctx;
  const soDono = typeof ctx.soDono === 'function' ? ctx.soDono : negar;
  app.get('/api/rastreio/codigos', soDono, responder(() => ({ codigos: listar(db) })));
  app.put('/api/rastreio/codigos', soDono, responder((req) => {
    salvarVarios(db, req.body);
    return { codigos: listar(db) };
  }));
  app.get('/api/rastreio/cobertura', soDono, responder((req) => {
    const q = req.query;
    const loja = q.loja == null || q.loja === '' ? null : q.loja; // repetido (?loja=a&loja=b) vira lista: cobertura recusa
    const jids = q.bloco == null || q.bloco === '' ? null : gruposDoBloco(db, q.bloco);
    const virada = typeof ctx.viradaMin === 'function' ? ctx.viradaMin() : 0;
    const texto = (v) => (typeof v === 'string' ? v : '');
    const { de, ate } = periodRange(texto(q.periodo) || 'hoje', Date.now(), { de: texto(q.de), ate: texto(q.ate) }, virada);
    return { de, ate, ...cobertura(db, { de, ate, loja, jids }) };
  }));
}
