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
//
// Shopee (plano integracao-shopee, decisão 5): o ID de afiliado e o AppID são texto; a Senha da API (`chave`) é o
// único segredo. O cartão leva `estado` (6 valores da spec), `situacao` (da última chamada à API, src/shopee.js) e
// `extensao_online` (os links saem pela extensão quando a API não serve). AppID igual ao ID de afiliado é recusado
// (400, nada gravado). O "Testar" é real (shopee.testar, injetado) e responde só com frases fixas por resultado;
// com a credencial aceita e sem ID de afiliado, o resultado é `sem_id`. Salvar esquece a verificação e o cache.
//
// Catálogo do Etiqueta (plano fonte-catalogo-etiqueta, etapa 3): `endereco` e `caminho_token` são texto e não há
// segredo. Este módulo NUNCA lê o arquivo do token (quem lê é src/catalogo.js, injetado) e recusa no PUT um caminho
// que pareça o próprio token, sem ecoar o valor, e um caminho que não termine em api_token.txt (S1). O cartão leva
// `estado` (6 valores da spec), `situacao` (resultado da última chamada ao Etiqueta, pelo mesmo critério do
// /api/state: só se for do endereço e caminho salvos agora, a impressão de src/catalogo.js) e as categorias da última verificação
// (settings.catalogo_verificacao, gravada pelo "Testar" de src/catalogo.js). O "Testar" chama catalogo.testar() e
// responde só com frases fixas por resultado e categorias limpas: nada do que o cliente ou o Etiqueta devolveu
// (corpo, mensagem de erro) chega ao navegador, ao log ou ao console.

import { PLATAFORMAS, RE_ENDERECO_CATALOGO, RE_CAMINHO_TOKEN, ENDERECO_CATALOGO_PADRAO, PARECE_TOKEN, ARQUIVO_TOKEN, caminhoDoArquivoDoToken } from './lojas.js';
import { getSetting } from './db.js';
import { DRY_RUN } from './config.js';
import { ErroAmazon, MENSAGENS_AMAZON } from './amazon.js';
import { ErroShopee, MENSAGENS_SHOPEE, FRASES_TESTE_SHOPEE, RE_ID_AFILIADO as RE_ID_AFILIADO_SHOPEE } from './shopee.js';

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

// "Testar" da Shopee: ErroShopee.tipo → resultado (as frases são FRASES_TESTE_SHOPEE, de src/shopee.js).
const RESULTADO_DO_ERRO_SHOPEE = Object.freeze({
  sem_credenciais: 'nao_configurada', credencial_recusada: 'recusada', sem_acesso: 'sem_acesso',
  conta_restrita: 'conta_restrita', cota: 'cota',
});
// Resultados que podem vir de shopee.testar(). `sem_id` não está aqui: só este módulo decide (precisa do ID salvo).
const RESULTADOS_SHOPEE = ['ok', 'nao_configurada', 'recusada', 'sem_acesso', 'conta_restrita', 'cota', 'indisponivel'];
const CAMPOS_TESTE_SHOPEE = ['itemId', 'productName', 'priceMin', 'priceMax', 'priceDiscountRate', 'sales', 'ratingStar', 'imageUrl', 'shopName'];
const ACESSOS_SHOPEE = ['nao_configurada', 'desconhecido', 'ok', 'sem_acesso', 'credencial_recusada', 'conta_restrita', 'cota', 'indisponivel'];
const APPID_IGUAL_AO_ID = 'O AppID e o ID de afiliado são números diferentes. Confira os dois no portal da Shopee.';
/** Mesmo número com ou sem zeros à esquerda. */
const semZeros = (v) => (typeof v === 'string' ? v.replace(/^0+/, '') : '');

/** Mensagem de erro do campo, ou ''. Nunca inclui o valor (pode ser um segredo). */
function validarCampo(c, valor) {
  if (valor.length > c.max) return `${c.rotulo}: até ${c.max} caracteres.`;
  const ok = c.padrao ? regexDe(c.padrao).test(valor) : !/[\u0000-\u001f\u007f]/.test(valor);
  if (ok) return '';
  if (c.erro) return c.erro;
  return c.tipo === 'segredo' ? `${c.rotulo}: formato inválido. Confira se copiou o valor inteiro, sem espaços.`
    : `${c.rotulo}: formato inválido.${c.ajuda ? ' ' + c.ajuda : ''}`;
}

// ------------------------------------------------------------------ Catálogo do Etiqueta

// "Caminho" que é, na verdade, o próprio token (PARECE_TOKEN de src/lojas.js): recusado antes de qualquer outra
// regra (inclusive o tamanho) e sem ecoar o valor.
const ARQUIVO_TOKEN_MSG = `O arquivo do token precisa ser o ${ARQUIVO_TOKEN} da pasta do Etiqueta. Cole o caminho completo dele, terminando em /${ARQUIVO_TOKEN}.`;
const PARECE_TOKEN_MSG = 'Isto parece o token, não o caminho do arquivo. Cole o caminho (por exemplo, …/api_token.txt). Se você colou o token em algum lugar, gere outro no Etiqueta.';

// resultado do "Testar" e da última chamada (src/catalogo.js) → estado do cartão (spec, seção 1)
const ESTADO_DO_RESULTADO_CATALOGO = Object.freeze({
  ok: 'conectada', token_recusado: 'token_recusado', desligada: 'indisponivel', fora_do_ar: 'indisponivel',
  resposta_inesperada: 'indisponivel', sem_arquivo: 'sem_arquivo', arquivo_invalido: 'sem_arquivo',
});
const RESULTADOS_CATALOGO = ['nao_configurada', ...Object.keys(ESTADO_DO_RESULTADO_CATALOGO)];
const CATALOGO_INDISPONIVEL = 'O teste do Catálogo não está disponível agora. Tente de novo.';
const MAX_CATEGORIAS = 500;
const LOJAS_CATALOGO = ['amazon', 'ml', 'shopee'];

const milhar = (n) => n.toLocaleString('pt-BR');
const plural = (n, um, varios) => `${milhar(n)} ${n === 1 ? um : varios}`;

/**
 * Frase fixa por resultado (spec, "Resultados do Testar"). Só entram o endereço e o caminho salvos (são do dono e
 * passaram pela validação do PUT) e os números; nunca texto do cliente, do Etiqueta ou do arquivo do token.
 */
function fraseCatalogo(resultado, { endereco, caminho } = {}, { total = 0, categorias = 0 } = {}) {
  switch (resultado) {
    case 'ok': return `Conectado. ${plural(total, 'oferta', 'ofertas')} em ${plural(categorias, 'categoria', 'categorias')}.`;
    case 'nao_configurada': return 'Salve o endereço e o caminho do token para testar.';
    case 'token_recusado': return 'O Etiqueta recusou o token. Se você trocou o arquivo do token, reinicie o servidor.py do Etiqueta (ele lê o arquivo só ao ligar) e teste de novo.';
    case 'desligada': return 'O Etiqueta está no ar, mas a API dele está desligada. Falta o arquivo api_token.txt (ou ele é inválido) na pasta do Etiqueta. O terminal do servidor.py diz o motivo. Depois de corrigir, reinicie-o e teste de novo.';
    case 'fora_do_ar': return `Não consegui falar com o Etiqueta${endereco ? ` em ${endereco}` : ''}. Confira se ele está ligado (python3 servidor.py) e se o endereço e a porta estão certos.`;
    case 'sem_arquivo': return `Não encontrei o arquivo do token${caminho ? ` em ${caminho}` : ''}. Confira o caminho, e se este programa tem permissão para ler o arquivo.`;
    case 'arquivo_invalido': return 'O arquivo do token está vazio ou fora do formato (32 ou mais letras, números, _ e -). Gere o token de novo no Etiqueta.';
    default: return 'O Etiqueta respondeu algo que não esperávamos. Tente de novo; se continuar, veja o terminal do servidor.py.'; // resposta_inesperada
  }
}

const inteiro = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const instante = (v) => (Number.isFinite(v) && v > 0 ? v : null);

/**
 * Categorias vindas do cliente ou do banco, só com os campos do contrato: { nome (texto, 1–200), total, lojas:
 * { amazon, ml, shopee } } (inteiros ≥ 0). Item fora disso é descartado; até MAX_CATEGORIAS. O nome é texto cru do
 * Etiqueta: o painel escapa (esc()).
 */
function limparCategorias(lista) {
  if (!Array.isArray(lista)) return [];
  const saida = [];
  for (const c of lista.slice(0, MAX_CATEGORIAS)) {
    const nome = typeof c?.nome === 'string' ? c.nome.trim() : '';
    const total = inteiro(c?.total);
    if (!nome || nome.length > 200 || total == null) continue;
    const lojas = {};
    for (const l of LOJAS_CATALOGO) lojas[l] = inteiro(c?.lojas?.[l]) ?? 0;
    saida.push({ nome, total, lojas });
  }
  return saida;
}

const somaTotais = (categorias) => categorias.reduce((s, c) => s + c.total, 0);

/** Nome de erro que pode ir ao console: só letras e curto (um token tem 32 ou mais caracteres). */
const nomeDoErro = (e) => (typeof e?.name === 'string' && /^[A-Za-z]{1,31}$/.test(e.name) ? e.name : 'erro');

/**
 * Regra das conexões. db: banco aberto; links: serviço de links (status da extensão); amazon: createAmazon
 * (situação da API, "Testar" e invalidar o token ao salvar); shopee: createShopee (o mesmo papel); catalogo:
 * createCatalogo de src/catalogo.js (situacao() e testar(); é ele quem lê o arquivo do token, nunca este módulo).
 * → { listar(verSegredos), salvar(id, corpo, verSegredos), testar(id) }
 */
export function createConexoes({ db, links, amazon, shopee, catalogo }) {
  const linhaDe = (id) => db.prepare(`${SQL_LER} WHERE plataforma = ?`).get(id);
  const extensaoOnline = () => !!links?.status?.().online;

  /** Situação da API da Shopee para o cartão: só acesso conhecido, número e frase fixa de shopee.js. */
  function situacaoShopee(temCredencial) {
    let s = null;
    try { s = typeof shopee?.situacao === 'function' ? shopee.situacao() : null; } catch (e) {
      console.error('[conexões] situação da Shopee falhou:', e?.name || 'erro'); // sem e.message
    }
    if (!s) return { acesso: temCredencial ? 'desconhecido' : 'nao_configurada', verificado_em: null, motivo: null };
    return {
      acesso: ACESSOS_SHOPEE.includes(s.acesso) ? s.acesso : 'desconhecido',
      verificado_em: Number.isFinite(s.verificado_em) ? s.verificado_em : null,
      motivo: Object.values(MENSAGENS_SHOPEE).includes(s.motivo) ? s.motivo : null,
    };
  }

  /**
   * Estado do cartão da Shopee (spec, seção 1):
   * falta_configurar (nada salvo) | so_id (ID sem AppID e Senha: links pela extensão) | pronta (credenciais
   * ainda não verificadas; também credenciais aceitas sem ID, com a linha de estado avisando) | conectada (acesso
   * ok e ID salvo) | sem_acesso (10035) | erro_credencial (credencial recusada ou conta restrita).
   * A recusa da API vale com ou sem ID (R2): sem ID, a tela avisa da falta dele também nesses estados.
   */
  function estadoShopee(temId, temCredencial, acesso) {
    if (!temCredencial) return temId ? 'so_id' : 'falta_configurar';
    if (acesso === 'sem_acesso') return 'sem_acesso';
    if (acesso === 'credencial_recusada' || acesso === 'conta_restrita') return 'erro_credencial';
    if (!temId) return 'pronta';
    if (acesso === 'ok') return 'conectada';
    return 'pronta';
  }

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

  /** Endereço e caminho salvos, só se ainda casam a regra do PUT (linha mexida por fora não vira chamada). */
  function configCatalogo(config) {
    const endereco = typeof config?.endereco === 'string' && RE_ENDERECO_CATALOGO.test(config.endereco) ? config.endereco : null;
    const caminho = typeof config?.caminho_token === 'string' && RE_CAMINHO_TOKEN.test(config.caminho_token) && !PARECE_TOKEN.test(config.caminho_token)
      && caminhoDoArquivoDoToken(config.caminho_token) ? config.caminho_token : null;
    return { endereco, caminho, configurada: !!endereco && !!caminho };
  }

  /** Categorias da última verificação (settings.catalogo_verificacao, gravada pelo "Testar" de src/catalogo.js). Sem rede. */
  function verificacaoCatalogo() {
    let o = null;
    try { o = JSON.parse(getSetting(db, 'catalogo_verificacao', 'null')); } catch { o = null; }
    const categorias = limparCategorias(o?.categorias);
    return { categorias, total: inteiro(o?.total) ?? somaTotais(categorias), verificado_em: instante(o?.verificado_em) };
  }

  /**
   * Situação do Catálogo para o cartão: resultado da última chamada (src/catalogo.js) só se for conhecido. O cliente
   * já descarta o que foi de outro endereço ou caminho (impressão de endereço + caminho): é o mesmo critério do
   * /api/state.catalogo (R7), e salvar os mesmos valores de novo não apaga a verificação. A frase é a fixa do
   * resultado. falha_desde (chip "Catálogo indisponível" das regras) segue a do cliente, só com a conexão configurada.
   */
  function situacaoCatalogo(cfg, verificacao) {
    let s = null;
    try { s = typeof catalogo?.situacao === 'function' ? catalogo.situacao() : null; } catch (e) {
      console.error('[conexões] situação do Catálogo falhou:', nomeDoErro(e)); // sem e.message
    }
    const resultado = typeof s?.resultado === 'string' && RESULTADOS_CATALOGO.includes(s.resultado) ? s.resultado : null;
    const verificadoEm = instante(s?.verificado_em);
    const falhaDesde = cfg.configurada ? instante(s?.falha_desde) : null;
    const valida = cfg.configurada && resultado && resultado !== 'nao_configurada' && verificadoEm != null;
    if (!valida) return { resultado: null, verificado_em: null, falha_desde: falhaDesde, mensagem: null };
    const numeros = { total: verificacao.total, categorias: verificacao.categorias.length };
    return { resultado, verificado_em: verificadoEm, falha_desde: falhaDesde, mensagem: fraseCatalogo(resultado, cfg, numeros) };
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
    if (p.id === 'shopee') {
      const temId = RE_ID_AFILIADO_SHOPEE.test(config.id_afiliado ?? '');
      const temCredencial = !!config.app_id && nomesSalvos.has('chave');
      const situacao = situacaoShopee(temCredencial);
      const estado = estadoShopee(temId, temCredencial, situacao.acesso);
      return { ...comum, estado, situacao, extensao_online: extensaoOnline(), updated_at: linha?.updated_at ?? null };
    }
    if (p.id === 'catalogo') {
      // falta_configurar (sem endereço ou sem caminho válidos) | salva (sem verificação depois do último "Salvar") |
      // conectada | token_recusado | indisponivel | sem_arquivo (pelo resultado, ESTADO_DO_RESULTADO_CATALOGO)
      const cfg = configCatalogo(config);
      const verificacao = verificacaoCatalogo();
      const situacao = situacaoCatalogo(cfg, verificacao);
      const estado = !cfg.configurada ? 'falta_configurar' : situacao.resultado ? ESTADO_DO_RESULTADO_CATALOGO[situacao.resultado] : 'salva';
      // Só volta o que passa na regra do PUT: valor mexido por fora no banco (até um token) não chega à tela.
      const valido = { ...(cfg.endereco ? { endereco: cfg.endereco } : {}), ...(cfg.caminho ? { caminho_token: cfg.caminho } : {}) };
      return { ...comum, config: valido, estado, situacao, verificacao, endereco_padrao: ENDERECO_CATALOGO_PADRAO, updated_at: linha?.updated_at ?? null };
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
      // Catálogo: o token colado no lugar do caminho é recusado antes de qualquer outra regra, sem ecoar o valor.
      let msg = p.id === 'catalogo' && c.nome === 'caminho_token' && PARECE_TOKEN.test(v) ? PARECE_TOKEN_MSG : validarCampo(c, v);
      // S1: só o arquivo do token do Etiqueta (outro arquivo do dono nunca vira cabeçalho de pedido)
      if (!msg && p.id === 'catalogo' && c.nome === 'caminho_token' && !caminhoDoArquivoDoToken(v)) msg = ARQUIVO_TOKEN_MSG;
      if (msg) { erros.push({ campo: c.nome, msg }); continue; }
      (c.tipo === 'segredo' ? segredos : config)[c.nome] = v;
    }
    if (p.id === 'shopee' && !erros.length) {
      // Compara o que fica salvo depois do merge: o que veio agora (null apaga) ou o que já estava no banco.
      const atual = lerJson(linhaDe(p.id)?.config);
      const final = (nome) => (Object.hasOwn(config, nome) ? config[nome] : atual[nome]);
      const appId = semZeros(final('app_id')); const idAfiliado = semZeros(final('id_afiliado'));
      if (appId && appId === idAfiliado) erros.push({ campo: 'app_id', msg: APPID_IGUAL_AO_ID });
    }
    if (erros.length) throw new ErroConexao(400, erros.map((e) => e.msg).join(' '), { erros });
    if (Object.keys(config).length || Object.keys(segredos).length) {
      db.prepare(SQL_GRAVAR).run({ id: p.id, config: JSON.stringify(config), segredos: JSON.stringify(segredos), agora: Date.now() });
      if (p.id === 'amazon') amazon?.invalidarToken?.(); // credencial ou tag nova: token e situação velhos não valem
      if (p.id === 'shopee') shopee?.invalidar?.(); // AppID, Senha ou ID novos: verificação e cache velhos não valem
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

  /**
   * "Testar" da Shopee: uma consulta real à Open API (shopee.testar). Só frases fixas por resultado; nada do que
   * a Shopee devolveu (corpo, código cru) nem a Senha chegam à resposta. Credencial aceita sem ID de afiliado
   * salvo → `sem_id` (sucesso parcial: ok falso, a tela mostra em aviso).
   * → { ok, resultado: 'ok'|'nao_configurada'|'recusada'|'sem_acesso'|'conta_restrita'|'cota'|'indisponivel'|'sem_id', mensagem, campos }
   */
  async function testarShopee() {
    if (typeof shopee?.testar !== 'function') {
      return { ok: false, resultado: 'indisponivel', mensagem: 'O teste da Shopee não está disponível agora.', campos: [] };
    }
    const falha = (resultado) => ({ ok: false, resultado, mensagem: FRASES_TESTE_SHOPEE[resultado], campos: [] });
    let r;
    try { r = await shopee.testar(); } catch (e) {
      if (!(e instanceof ErroShopee)) console.error('[conexões] teste da Shopee falhou:', e?.name || 'erro'); // sem e.message
      return falha((e instanceof ErroShopee && RESULTADO_DO_ERRO_SHOPEE[e.tipo]) || 'indisponivel');
    }
    const vindo = typeof r?.resultado === 'string' && RESULTADOS_SHOPEE.includes(r.resultado) ? r.resultado : 'indisponivel';
    const ok = vindo === 'ok' && r.ok === true; // nunca sucesso sem os dois sinais
    if (!ok) return falha(vindo === 'ok' ? 'indisponivel' : vindo);
    const campos = Array.isArray(r.campos) ? CAMPOS_TESTE_SHOPEE.filter((c) => r.campos.includes(c)) : [];
    const temId = RE_ID_AFILIADO_SHOPEE.test(lerJson(linhaDe('shopee')?.config).id_afiliado ?? '');
    if (!temId) return { ok: false, resultado: 'sem_id', mensagem: FRASES_TESTE_SHOPEE.sem_id, campos };
    return { ok: true, resultado: 'ok', mensagem: FRASES_TESTE_SHOPEE.ok, campos };
  }

  /**
   * "Testar" do Catálogo: catalogo.testar() (lê o arquivo do token e consulta o Etiqueta; grava as categorias em
   * settings.catalogo_verificacao). Sem endereço e caminho válidos salvos, não chama nada. A resposta só leva a
   * frase fixa do resultado e as categorias limpas (limparCategorias); erro do cliente vira frase fixa, e o console
   * só recebe o nome do erro.
   * → { ok, resultado: 'ok'|'nao_configurada'|'sem_arquivo'|'arquivo_invalido'|'token_recusado'|'desligada'|
   *     'fora_do_ar'|'resposta_inesperada'|'indisponivel' (sem o cliente), mensagem, total, categorias }
   */
  async function testarCatalogo() {
    const cfg = configCatalogo(lerJson(linhaDe('catalogo')?.config));
    const falha = (resultado, mensagem = fraseCatalogo(resultado, cfg)) => ({ ok: false, resultado, mensagem, total: 0, categorias: [] });
    if (!cfg.configurada) return falha('nao_configurada');
    if (typeof catalogo?.testar !== 'function') return falha('indisponivel', CATALOGO_INDISPONIVEL);
    let r;
    try { r = await catalogo.testar(); } catch (e) {
      console.error('[conexões] teste do Catálogo falhou:', nomeDoErro(e)); // sem e.message
      return falha('indisponivel', CATALOGO_INDISPONIVEL);
    }
    const vindo = typeof r?.resultado === 'string' && RESULTADOS_CATALOGO.includes(r.resultado) ? r.resultado : 'resposta_inesperada';
    if (vindo !== 'ok' || r.ok !== true) return falha(vindo === 'ok' ? 'resposta_inesperada' : vindo); // nunca sucesso sem os dois sinais
    const categorias = limparCategorias(r.categorias);
    const total = inteiro(r.total) ?? somaTotais(categorias);
    return { ok: true, resultado: 'ok', mensagem: fraseCatalogo('ok', cfg, { total, categorias: categorias.length }), total, categorias };
  }

  /** "Testar": { ok, mensagem } (+ resultado e campos na Amazon e na Shopee; resultado, total e categorias no Catálogo). Lojas não implementadas dizem que não existem ainda. */
  async function testar(id) {
    const p = plataformaDe(id);
    if (p.id === 'mercadolivre') { const { ok, mensagem } = situacaoML(); return { ok, mensagem }; }
    if (!p.implementada) {
      return { ok: false, mensagem: `${p.nome} ainda não está implementada.${p.campos.length ? ' Os dados ficam salvos para quando a integração existir.' : ''}` };
    }
    if (p.id === 'amazon') return testarAmazon();
    if (p.id === 'shopee') return testarShopee();
    if (p.id === 'catalogo') return testarCatalogo();
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
 * ctx = { db, wa, links, scheduler, auth, wrap, soDono, dataDir, ml, enderecoPublico, amazon, shopee, catalogo }.
 * ctx.amazon é o cliente único do servidor (criarServicos em src/server.js), o mesmo da fila de envios: salvar a
 * conexão invalida o token de todos e o "Testar" usa a mesma fila de 1 chamada/s. Sem ele, o teste da Amazon diz
 * que não está disponível (createConexoes já trata). ctx.shopee é o mesmo para a Shopee (cliente único, ligado
 * pelo servidor): salvar esquece a verificação e o cache de itens dele. ctx.catalogo é o cliente único do Etiqueta
 * (src/catalogo.js, ligado pelo servidor na etapa 5); sem ele, o "Testar" do Catálogo diz que não está disponível.
 */
export function montarRotas(app, ctx) {
  const conexoes = createConexoes({ db: ctx.db, links: ctx.links, amazon: ctx.amazon ?? null, shopee: ctx.shopee ?? null, catalogo: ctx.catalogo ?? null });
  app.get('/api/conexoes', responder((req) => conexoes.listar(podeVerSegredos(req))));
  app.put('/api/conexoes/:id', ctx.soDono, responder((req) => conexoes.salvar(req.params.id, req.body, podeVerSegredos(req))));
  app.post('/api/conexoes/:id/testar', ctx.soDono, responder((req) => conexoes.testar(req.params.id)));
}
