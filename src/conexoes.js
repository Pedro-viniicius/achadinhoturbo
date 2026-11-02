// Conexões por loja (plano disparos-comunicacao-conta, F4): `config` e `segredos` guardados separados na tabela
// `conexoes`, campos só os do registro (PLATAFORMAS[id].campos, em src/lojas.js). O segredo nunca volta ao
// navegador nem vai para `log`, console ou mensagem de erro. O dono decidiu: Operador não vê nem troca segredos.
//
// Os valores dos segredos não saem do SQLite na leitura: a listagem só pergunta quais nomes estão preenchidos
// (json_each) e a gravação faz o merge no próprio banco (json_patch). Ficam em claro no banco, como o ext_token.
//
// Mercado Livre: a "configuração" dele são as etiquetas (tabela tags, seção "Etiquetas de afiliado") mais a
// extensão do Chrome. Não há campo para salvar aqui; o estado vem do mesmo que o /api/state mostra.

import { PLATAFORMAS } from './lojas.js';
import { getSetting } from './db.js';
import { DRY_RUN } from './config.js';

/** Erro com status HTTP e mensagem pronta para a tela. Nunca carrega valor vindo do corpo. */
class ErroConexao extends Error {
  constructor(status, mensagem, extra = {}) { super(mensagem); this.status = status; this.extra = extra; }
}

/** Texto JSON da coluna se for um objeto válido; senão '{}' (linha corrompida não quebra a tela nem a gravação). */
const objetoOuVazio = (col) => `CASE WHEN json_valid(${col}) THEN CASE WHEN json_type(${col}) = 'object' THEN ${col} ELSE '{}' END ELSE '{}' END`;

// Leitura para o painel: config + NOMES dos segredos preenchidos. O valor do segredo não entra no SELECT.
const SQL_LER = `SELECT plataforma, config, updated_at,
  (SELECT json_group_array(key) FROM json_each(${objetoOuVazio('c.segredos')}) WHERE type = 'text' AND length(value) > 0) AS salvos
  FROM conexoes c`;

// Gravação: json_patch junta o que veio com o que já estava (null apaga a chave). Segredo que não veio fica como está.
const SQL_GRAVAR = `INSERT INTO conexoes (plataforma, config, segredos, updated_at)
  VALUES (:id, json_patch('{}', :config), json_patch('{}', :segredos), :agora)
  ON CONFLICT(plataforma) DO UPDATE SET
    config = json_patch(${objetoOuVazio('config')}, :config),
    segredos = json_patch(${objetoOuVazio('segredos')}, :segredos),
    updated_at = :agora`;

const regexes = new Map(); // padrao (texto) -> RegExp
const regexDe = (padrao) => { if (!regexes.has(padrao)) regexes.set(padrao, new RegExp(padrao)); return regexes.get(padrao); };

/** Plataforma do registro pelo id da URL, ou 404. PLATAFORMAS não tem protótipo: 'constructor' não acha nada. */
function plataformaDe(id) {
  if (typeof id !== 'string' || !Object.hasOwn(PLATAFORMAS, id)) throw new ErroConexao(404, 'Conexão desconhecida.');
  return PLATAFORMAS[id];
}

const descreverCampo = (c) => ({ nome: c.nome, rotulo: c.rotulo, tipo: c.tipo, max: c.max, padrao: c.padrao ?? null, ajuda: c.ajuda ?? '' });

function lerJson(texto) {
  try { const o = JSON.parse(texto); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; }
}
function lerLista(texto) {
  try { const a = JSON.parse(texto); return Array.isArray(a) ? a : []; } catch { return []; }
}

/** Mensagem de erro do campo, ou ''. Nunca inclui o valor (pode ser um segredo). */
function validarCampo(c, valor) {
  if (valor.length > c.max) return `${c.rotulo}: até ${c.max} caracteres.`;
  const ok = c.padrao ? regexDe(c.padrao).test(valor) : !/[\u0000-\u001f\u007f]/.test(valor);
  if (ok) return '';
  return c.tipo === 'segredo' ? `${c.rotulo}: formato inválido. Confira se copiou o valor inteiro, sem espaços.`
    : `${c.rotulo}: formato inválido.${c.ajuda ? ' ' + c.ajuda : ''}`;
}

/**
 * Regra das conexões. db: banco aberto; links: serviço de links (status da extensão).
 * → { listar(verSegredos), salvar(id, corpo, verSegredos), testar(id) }
 */
export function createConexoes({ db, links }) {
  const linhaDe = (id) => db.prepare(`${SQL_LER} WHERE plataforma = ?`).get(id);

  /** Mercado Livre: etiqueta cadastrada, modo de link e extensão, como o /api/state e o cartão do painel. */
  function situacaoML() {
    const etiquetas = db.prepare('SELECT name FROM tags ORDER BY name COLLATE NOCASE').all().map((t) => t.name);
    const direto = getSetting(db, 'link_mode', 'extension') === 'direct';
    const online = !!links?.status?.().online;
    const faltas = [];
    if (!etiquetas.length) faltas.push('Nenhuma etiqueta de afiliado cadastrada: cadastre uma em "Etiquetas de afiliado".');
    if (direto) faltas.push('Modo direto ligado em Ajustes: os links saem sem etiqueta e não geram comissão.');
    else if (!online) faltas.push('Extensão do Chrome desconectada: abra o Chrome com a extensão instalada e logado na Central de Afiliados.');
    const simulacao = DRY_RUN ? ' Modo simulação: os links são falsos e nada é enviado de verdade.' : '';
    const ok = !faltas.length;
    const mensagem = ok
      ? `Tudo certo: ${etiquetas.length} ${etiquetas.length === 1 ? 'etiqueta cadastrada' : 'etiquetas cadastradas'} e a extensão do Chrome conectada.${simulacao}`
      : faltas.join(' ') + simulacao;
    return { ok, mensagem, etiquetas };
  }

  /** Objeto que vai para o painel. Sem valor de segredo; os nomes dos salvos só para quem pode vê-los. */
  function visao(p, linha, verSegredos) {
    const base = { id: p.id, nome: p.nome, implementada: p.implementada, descricao: p.descricao };
    if (p.id === 'mercadolivre') {
      const ml = situacaoML();
      return { ...base, campos: [], config: { etiquetas: ml.etiquetas }, ...(verSegredos ? { segredos_salvos: [] } : {}),
        estado: ml.ok ? 'conectado' : 'falta_configurar', updated_at: null };
    }
    const salvo = lerJson(linha?.config);
    const nomesSalvos = new Set(lerLista(linha?.salvos));
    const config = {}; const segredosSalvos = [];
    for (const c of p.campos) {
      if (c.tipo === 'segredo') { if (nomesSalvos.has(c.nome)) segredosSalvos.push(c.nome); }
      else if (typeof salvo[c.nome] === 'string') config[c.nome] = salvo[c.nome];
    }
    const completo = p.campos.length > 0 && p.campos.every((c) => (c.tipo === 'segredo' ? nomesSalvos.has(c.nome) : !!config[c.nome]));
    const estado = !p.implementada ? 'nao_implementada' : completo ? 'pronta' : 'falta_configurar';
    return { ...base, campos: p.campos.map(descreverCampo), config, ...(verSegredos ? { segredos_salvos: segredosSalvos } : {}),
      estado, updated_at: linha?.updated_at ?? null };
  }

  function listar(verSegredos) {
    const linhas = new Map(db.prepare(SQL_LER).all().map((l) => [l.plataforma, l]));
    return Object.values(PLATAFORMAS).map((p) => visao(p, linhas.get(p.id), verSegredos));
  }

  /**
   * corpo = { campos: { nome: valor } }. Só os campos do registro (o resto é descartado). Texto vazio apaga o
   * campo; segredo vazio ou ausente mantém o salvo; segredo com valor substitui. Tudo ou nada: com um campo
   * inválido, nada é gravado.
   */
  function salvar(id, corpo, verSegredos) {
    const p = plataformaDe(id);
    if (p.id === 'mercadolivre') throw new ErroConexao(400, 'As etiquetas do Mercado Livre ficam em "Etiquetas de afiliado", no cartão do Mercado Livre.');
    if (!p.campos.length) throw new ErroConexao(400, `${p.nome} ainda não tem dados para guardar.`);
    const vindos = corpo?.campos;
    if (!vindos || typeof vindos !== 'object' || Array.isArray(vindos)) throw new ErroConexao(400, 'Envie os campos da conexão.');
    const config = {}; const segredos = {}; const erros = [];
    for (const c of p.campos) {
      if (!Object.hasOwn(vindos, c.nome)) continue;
      let v = vindos[c.nome] ?? '';
      if (typeof v === 'number' && Number.isFinite(v)) v = String(v);
      if (typeof v !== 'string') { erros.push({ campo: c.nome, msg: `${c.rotulo}: valor inválido.` }); continue; }
      v = v.trim();
      if (!v) { if (c.tipo !== 'segredo') config[c.nome] = null; continue; } // null: json_patch apaga
      const msg = validarCampo(c, v);
      if (msg) { erros.push({ campo: c.nome, msg }); continue; }
      (c.tipo === 'segredo' ? segredos : config)[c.nome] = v;
    }
    if (erros.length) throw new ErroConexao(400, erros.map((e) => e.msg).join(' '), { erros });
    if (Object.keys(config).length || Object.keys(segredos).length) {
      db.prepare(SQL_GRAVAR).run({ id: p.id, config: JSON.stringify(config), segredos: JSON.stringify(segredos), agora: Date.now() });
    }
    return visao(p, linhaDe(p.id), verSegredos);
  }

  /** "Testar": { ok, mensagem }. Só o Mercado Livre tem o que testar; as outras dizem que não existem ainda. */
  function testar(id) {
    const p = plataformaDe(id);
    if (p.id === 'mercadolivre') { const { ok, mensagem } = situacaoML(); return { ok, mensagem }; }
    if (!p.implementada) {
      return { ok: false, mensagem: `${p.nome} ainda não está implementada.${p.campos.length ? ' Os dados ficam salvos para quando a integração existir.' : ''}` };
    }
    return { ok: false, mensagem: `O teste de ${p.nome} ainda não está disponível.` }; // nunca sucesso sem testar
  }

  return { listar, salvar, testar };
}

/** Responde JSON; ErroConexao vira o status dele. Erro inesperado (banco) não devolve nem registra a mensagem. */
const responder = (fn) => async (req, res) => {
  try { res.json(await fn(req)); } catch (e) {
    if (e instanceof ErroConexao) return res.status(e.status).json({ erro: e.message, ...e.extra });
    console.error('[conexões] falha inesperada:', e?.code || e?.name || 'erro'); // sem e.message: pode trazer valores da query
    res.status(500).json({ erro: 'Não consegui concluir. Tente de novo.' });
  }
};

// Operador não vê nem troca segredos (decisão do dono, 02/11/2026). Até a Equipe existir (etapa 7) não há
// req.user: com a senha única ou sem senha, quem entrou é o Dono.
const podeVerSegredos = (req) => req.user == null || req.user.papel === 'dono';

/**
 * Rotas de F4, montadas por buildApp depois do login e da checagem Host/Origin.
 * ctx = { db, wa, links, scheduler, auth, wrap, soDono, dataDir, ml, enderecoPublico }.
 */
export function montarRotas(app, ctx) {
  const conexoes = createConexoes({ db: ctx.db, links: ctx.links });
  app.get('/api/conexoes', responder((req) => conexoes.listar(podeVerSegredos(req))));
  app.put('/api/conexoes/:id', ctx.soDono, responder((req) => conexoes.salvar(req.params.id, req.body, podeVerSegredos(req))));
  app.post('/api/conexoes/:id/testar', ctx.soDono, responder((req) => conexoes.testar(req.params.id)));
}
