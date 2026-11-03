// Conexões por loja (plano disparos-comunicacao-conta, F4): `config` e `segredos` guardados separados na tabela
// `conexoes`, campos só os do registro (PLATAFORMAS[id].campos, em src/lojas.js). O segredo nunca volta ao
// navegador nem vai para `log`, console ou mensagem de erro. O dono decidiu: Operador não vê nem troca segredos.
//
// Os valores dos segredos não saem do SQLite na leitura: a listagem só pergunta quais nomes estão preenchidos
// (json_each) e a gravação faz o merge no próprio banco (json_patch). Ficam em claro no banco, como o ext_token.
//
// Mercado Livre: a "configuração" dele são as etiquetas (tabela tags, seção "Etiquetas de afiliado") mais a
// extensão do Chrome. Não há campo para salvar aqui; o estado vem do mesmo que o /api/state mostra.
//
// Amazon (plano espelhamento-amazon, etapa 7): a tag e a versão da credencial são texto; o ID e o segredo da
// credencial são segredo. O "Testar" é real (amazon.testar de src/amazon.js, injetado) e a resposta só carrega
// frases fixas desta tela: nada do que a Amazon devolveu (corpo, token) chega ao navegador. Salvar esquece o token.

import { PLATAFORMAS } from './lojas.js';
import { getSetting } from './db.js';
import { DRY_RUN } from './config.js';
import { ErroAmazon, MENSAGENS_AMAZON } from './amazon.js';

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

/**
 * Valores salvos da conexão (texto e segredo), só os campos do registro e só texto não vazio. USO INTERNO do
 * servidor (ex.: `lerConexao` de createAmazon): nunca vai para resposta, log, console ou mensagem de erro.
 */
export function segredosDe(db, id) {
  const p = plataformaDe(id);
  const linha = db.prepare('SELECT config, segredos FROM conexoes WHERE plataforma = ?').get(p.id);
  const config = lerJson(linha?.config);
  const segredos = lerJson(linha?.segredos);
  const valores = {};
  for (const c of p.campos) {
    const v = (c.tipo === 'segredo' ? segredos : config)[c.nome];
    if (typeof v === 'string' && v) valores[c.nome] = v;
  }
  return valores;
}

// "Testar" da Amazon: frases da spec por resultado. A resposta só leva estas frases (nunca o texto de um erro).
const FRASES_TESTE_AMAZON = Object.freeze({
  ok: 'Credencial aceita pela Amazon.',
  nao_configurada: 'Preencha o ID e o segredo da credencial e salve antes de testar.',
  recusada: MENSAGENS_AMAZON.credenciais_invalidas,
  sem_acesso: MENSAGENS_AMAZON.sem_acesso,
  tag_invalida: MENSAGENS_AMAZON.tag_invalida,
  indisponivel: MENSAGENS_AMAZON.indisponivel, // cota e instabilidade: a mesma frase (spec)
});
const SEM_TAG_NO_TESTE = ' Cadastre a tag de associado para conferir o acesso à API.';
// ErroAmazon.tipo → resultado do teste
const RESULTADO_DO_ERRO = Object.freeze({
  sem_credenciais: 'nao_configurada', sem_tag: 'nao_configurada', credenciais_invalidas: 'recusada',
  sem_acesso: 'sem_acesso', tag_invalida: 'tag_invalida', cota: 'indisponivel', nao_encontrado: 'indisponivel',
  indisponivel: 'indisponivel',
});
const CAMPOS_TESTE = ['title', 'price', 'oldPrice', 'discountPct', 'image']; // o que o teste diz que veio da API
const ACESSOS = ['nao_configurada', 'desconhecido', 'ok', 'sem_acesso', 'credenciais_invalidas', 'tag_invalida', 'cota', 'indisponivel'];

/** Mensagem de erro do campo, ou ''. Nunca inclui o valor (pode ser um segredo). */
function validarCampo(c, valor) {
  if (valor.length > c.max) return `${c.rotulo}: até ${c.max} caracteres.`;
  const ok = c.padrao ? regexDe(c.padrao).test(valor) : !/[\u0000-\u001f\u007f]/.test(valor);
  if (ok) return '';
  return c.tipo === 'segredo' ? `${c.rotulo}: formato inválido. Confira se copiou o valor inteiro, sem espaços.`
    : `${c.rotulo}: formato inválido.${c.ajuda ? ' ' + c.ajuda : ''}`;
}

/**
 * Regra das conexões. db: banco aberto; links: serviço de links (status da extensão); amazon: createAmazon
 * (situação da API, "Testar" e invalidar o token ao salvar).
 * → { listar(verSegredos), salvar(id, corpo, verSegredos), testar(id) }
 */
export function createConexoes({ db, links, amazon }) {
  const linhaDe = (id) => db.prepare(`${SQL_LER} WHERE plataforma = ?`).get(id);

  /** Situação da API da Amazon para o cartão: só os campos conhecidos (o motivo é uma frase fixa de amazon.js). */
  function situacaoAmazon(temCredencial) {
    const s = typeof amazon?.situacao === 'function' ? amazon.situacao() : null;
    if (!s) return { acesso: temCredencial ? 'desconhecido' : 'nao_configurada', verificado_em: null, motivo: null };
    return {
      acesso: ACESSOS.includes(s.acesso) ? s.acesso : 'desconhecido',
      verificado_em: Number.isFinite(s.verificado_em) ? s.verificado_em : null,
      motivo: Object.values(MENSAGENS_AMAZON).includes(s.motivo) ? s.motivo : null,
    };
  }

  const espelhosAtivos = () => db.prepare('SELECT COUNT(*) AS n FROM espelhos WHERE enabled = 1').get().n;

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
    const comum = { ...base, campos: p.campos.map(descreverCampo), config, ...(verSegredos ? { segredos_salvos: segredosSalvos } : {}) };
    if (p.id === 'amazon') {
      // falta_configurar (sem tag) | so_tag (tag sem credencial: dados do texto da origem) | pronta (tag e
      // credencial, API ainda não confirmada) | conectada (a última consulta com estas credenciais e tag deu certo)
      const temCredencial = nomesSalvos.has('credencial_id') && nomesSalvos.has('credencial_secret');
      const situacao = situacaoAmazon(temCredencial);
      const estado = !config.tag ? 'falta_configurar' : !temCredencial ? 'so_tag' : situacao.acesso === 'ok' ? 'conectada' : 'pronta';
      return { ...comum, estado, situacao, espelhos_ativos: espelhosAtivos(), updated_at: linha?.updated_at ?? null };
    }
    const completo = p.campos.length > 0 && p.campos.every((c) => (c.tipo === 'segredo' ? nomesSalvos.has(c.nome) : !!config[c.nome]));
    const estado = !p.implementada ? 'nao_implementada' : completo ? 'pronta' : 'falta_configurar';
    return { ...comum, estado, updated_at: linha?.updated_at ?? null };
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
      if (p.id === 'amazon') amazon?.invalidarToken?.(); // credencial ou tag nova: token e situação velhos não valem
    }
    return visao(p, linhaDe(p.id), verSegredos);
  }

  /** Resultado do teste a partir de um erro: ErroAmazon pelo tipo; qualquer outro vira 'indisponivel'. */
  function falhaDoTeste(e) {
    if (!(e instanceof ErroAmazon)) console.error('[conexões] teste da Amazon falhou:', e?.name || 'erro'); // sem e.message
    const tipo = e instanceof ErroAmazon ? e.tipo : 'indisponivel';
    const resultado = RESULTADO_DO_ERRO[tipo] ?? 'indisponivel';
    const mensagem = tipo === 'sem_tag' ? MENSAGENS_AMAZON.sem_tag : FRASES_TESTE_AMAZON[resultado];
    return { ok: false, resultado, mensagem, campos: [] };
  }

  /**
   * "Testar" da Amazon: token (prova a credencial) e, com tag, um GetItems de teste (amazon.testar).
   * → { ok, resultado: 'ok'|'nao_configurada'|'recusada'|'sem_acesso'|'tag_invalida'|'indisponivel', mensagem, campos }
   */
  async function testarAmazon() {
    if (typeof amazon?.testar !== 'function') {
      return { ok: false, resultado: 'indisponivel', mensagem: 'O teste da Amazon não está disponível agora.', campos: [] };
    }
    let r;
    try { r = await amazon.testar(); } catch (e) { return falhaDoTeste(e); }
    const vindo = typeof r?.resultado === 'string' && Object.hasOwn(FRASES_TESTE_AMAZON, r.resultado) ? r.resultado : 'indisponivel';
    const ok = vindo === 'ok' && r.ok === true; // nunca sucesso sem os dois sinais
    const resultado = ok ? 'ok' : vindo === 'ok' ? 'indisponivel' : vindo;
    let mensagem = FRASES_TESTE_AMAZON[resultado];
    if (ok && !lerJson(linhaDe('amazon')?.config).tag) mensagem += SEM_TAG_NO_TESTE;
    const campos = ok && Array.isArray(r.campos) ? CAMPOS_TESTE.filter((c) => r.campos.includes(c)) : [];
    return { ok, resultado, mensagem, campos };
  }

  /** "Testar": { ok, mensagem } (+ resultado e campos na Amazon). Lojas não implementadas dizem que não existem ainda. */
  async function testar(id) {
    const p = plataformaDe(id);
    if (p.id === 'mercadolivre') { const { ok, mensagem } = situacaoML(); return { ok, mensagem }; }
    if (!p.implementada) {
      return { ok: false, mensagem: `${p.nome} ainda não está implementada.${p.campos.length ? ' Os dados ficam salvos para quando a integração existir.' : ''}` };
    }
    if (p.id === 'amazon') return testarAmazon();
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
 * ctx = { db, wa, links, scheduler, auth, wrap, soDono, dataDir, ml, enderecoPublico, amazon }.
 * ctx.amazon é o cliente único do servidor (criarServicos em src/server.js), o mesmo da fila de envios: salvar a
 * conexão invalida o token de todos e o "Testar" usa a mesma fila de 1 chamada/s. Sem ele, o teste da Amazon diz
 * que não está disponível (createConexoes já trata).
 */
export function montarRotas(app, ctx) {
  const conexoes = createConexoes({ db: ctx.db, links: ctx.links, amazon: ctx.amazon ?? null });
  app.get('/api/conexoes', responder((req) => conexoes.listar(podeVerSegredos(req))));
  app.put('/api/conexoes/:id', ctx.soDono, responder((req) => conexoes.salvar(req.params.id, req.body, podeVerSegredos(req))));
  app.post('/api/conexoes/:id/testar', ctx.soDono, responder((req) => conexoes.testar(req.params.id)));
}
