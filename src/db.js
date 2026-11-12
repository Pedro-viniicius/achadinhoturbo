import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { TEMPLATE_AMAZON } from './template.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, note TEXT DEFAULT '', created_at INTEGER);
CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER);
CREATE TABLE IF NOT EXISTS groups (
  jid TEXT PRIMARY KEY, name TEXT, size INTEGER, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER DEFAULT 1,
  tag_id INTEGER, template_id INTEGER,
  group_jids TEXT DEFAULT '[]',
  source_type TEXT DEFAULT 'list', source_config TEXT DEFAULT '{}',
  min_price REAL, max_price REAL, min_discount REAL,
  per_run INTEGER DEFAULT 3, interval_min INTEGER DEFAULT 60,
  window_start TEXT DEFAULT '08:00', window_end TEXT DEFAULT '22:00',
  dedupe_days INTEGER DEFAULT 7, send_image INTEGER DEFAULT 1,
  next_run_at INTEGER, last_run_at INTEGER, created_at INTEGER);
CREATE TABLE IF NOT EXISTS sent_offers (
  id INTEGER PRIMARY KEY, rule_id INTEGER, offer_key TEXT, sent_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_sent ON sent_offers (rule_id, offer_key, sent_at);
-- envios da regra numa janela de tempo, com título e preço (src/parecido.js: não repetir produto igual ou parecido)
CREATE INDEX IF NOT EXISTS idx_sent_quando ON sent_offers (rule_id, sent_at);
CREATE TABLE IF NOT EXISTS log (
  id INTEGER PRIMARY KEY, ts INTEGER, rule_id INTEGER, rule_name TEXT, level TEXT,
  group_name TEXT, offer_title TEXT, message TEXT);
CREATE INDEX IF NOT EXISTS idx_log_ts ON log (ts DESC);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, created_at INTEGER, expires_at INTEGER, ip TEXT);
CREATE TABLE IF NOT EXISTS blocks (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, tag_id INTEGER, note TEXT DEFAULT '', created_at INTEGER);
CREATE TABLE IF NOT EXISTS block_groups (block_id INTEGER, jid TEXT, PRIMARY KEY (block_id, jid));
CREATE TABLE IF NOT EXISTS group_events (
  id INTEGER PRIMARY KEY, ts INTEGER, jid TEXT, participant TEXT, action TEXT, by_link INTEGER DEFAULT 0, actor TEXT);
CREATE INDEX IF NOT EXISTS idx_gev ON group_events (jid, participant, ts);
CREATE INDEX IF NOT EXISTS idx_gev_ts ON group_events (ts);
CREATE TABLE IF NOT EXISTS group_reads (
  jid TEXT, participant TEXT, day TEXT, ts INTEGER, PRIMARY KEY (jid, participant, day));
CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, mode TEXT DEFAULT 'fill',
  fallback_url TEXT, limit_members INTEGER DEFAULT 1000, reopen_below INTEGER DEFAULT 900,
  group_jids TEXT DEFAULT '[]', state TEXT DEFAULT '{}', enabled INTEGER DEFAULT 1, created_at INTEGER);
CREATE TABLE IF NOT EXISTS link_clicks (id INTEGER PRIMARY KEY, ts INTEGER, link_id INTEGER, jid TEXT, ip_hash TEXT);
CREATE INDEX IF NOT EXISTS idx_clicks ON link_clicks (link_id, ts);
CREATE TABLE IF NOT EXISTS group_proposals (
  id INTEGER PRIMARY KEY, link_id INTEGER, source_jid TEXT, name TEXT, status TEXT DEFAULT 'pending',
  created_jid TEXT, detail TEXT, created_at INTEGER, decided_at INTEGER);
-- Disparo manual, mensagem e enquete. status: pendente|enviando|concluido|erro|pausado|cancelado
CREATE TABLE IF NOT EXISTS envios (
  id INTEGER PRIMARY KEY, tipo TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
  group_jids TEXT NOT NULL DEFAULT '[]', quando TEXT NOT NULL DEFAULT 'agora', repetir TEXT,
  status TEXT NOT NULL DEFAULT 'pendente',
  next_run_at INTEGER, last_run_at INTEGER, resultado TEXT, user_id INTEGER, created_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_envios_fila ON envios (status, next_run_at);
CREATE TABLE IF NOT EXISTS envio_resultados (
  id INTEGER PRIMARY KEY, envio_id INTEGER NOT NULL, ocorrencia INTEGER NOT NULL,
  ts INTEGER, jid TEXT, group_name TEXT, ok INTEGER NOT NULL, erro TEXT);
CREATE INDEX IF NOT EXISTS idx_envio_res ON envio_resultados (envio_id, ocorrencia);
-- Destinos dos avisos. jid é o telefone (dado pessoal). resumo_blocos: NULL = não recebe resumo,
-- '[]' = todos os grupos, '[ids]' = esses blocos. avisos: lista com 'lotacao' e/ou 'erro'.
CREATE TABLE IF NOT EXISTS aviso_destinos (
  id INTEGER PRIMARY KEY, nome TEXT NOT NULL, jid TEXT NOT NULL UNIQUE,
  resumo_blocos TEXT, avisos TEXT NOT NULL DEFAULT '[]', ativo INTEGER NOT NULL DEFAULT 1, created_at INTEGER);
-- Conexões por loja. segredos nunca sai em SELECT de listagem.
CREATE TABLE IF NOT EXISTS conexoes (
  plataforma TEXT PRIMARY KEY, config TEXT NOT NULL DEFAULT '{}', segredos TEXT NOT NULL DEFAULT '{}', updated_at INTEGER);
-- Equipe. email é dado pessoal; o convite guarda só o sha256 do token.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, nome TEXT NOT NULL, email TEXT COLLATE NOCASE UNIQUE,
  senha_hash TEXT NOT NULL, papel TEXT NOT NULL CHECK (papel IN ('dono','operador')), created_at INTEGER, last_login_at INTEGER);
CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, email TEXT NOT NULL COLLATE NOCASE,
  papel TEXT NOT NULL CHECK (papel IN ('dono','operador')), expires_at INTEGER NOT NULL, created_by INTEGER,
  created_at INTEGER, used_at INTEGER, canceled_at INTEGER);
-- Espelhamento de ofertas (Amazon). origem_jids/destino_jids/palavras_bloqueadas: listas JSON. sem_preco: fila|curto.
CREATE TABLE IF NOT EXISTS espelhos (
  id INTEGER PRIMARY KEY, nome TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  origem_jids TEXT NOT NULL DEFAULT '[]', destino_jids TEXT NOT NULL DEFAULT '[]', template_id INTEGER,
  incluir_minhas INTEGER NOT NULL DEFAULT 0, dedupe_horas INTEGER NOT NULL DEFAULT 168,
  palavras_bloqueadas TEXT NOT NULL DEFAULT '[]', sem_preco TEXT NOT NULL DEFAULT 'fila',
  max_por_hora INTEGER NOT NULL DEFAULT 10, janela_inicio TEXT, janela_fim TEXT, enviar_foto INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER, updated_at INTEGER);
-- Um item por link da Amazon visto numa origem. status: recebido|processando|na_fila|enviado|duplicado|descartado|expirado|erro.
-- fonte_dados: api|api+texto|texto|curto|manual. oferta: JSON da oferta. texto_origem vai mascarado e nunca ao navegador.
-- Nunca há participante (autor da mensagem) aqui.
CREATE TABLE IF NOT EXISTS espelho_itens (
  id INTEGER PRIMARY KEY, espelho_id INTEGER NOT NULL, origem_jid TEXT NOT NULL, origem_nome TEXT, msg_id TEXT,
  ts INTEGER NOT NULL, url TEXT NOT NULL, asin TEXT, texto_origem TEXT,
  status TEXT NOT NULL DEFAULT 'recebido', motivo TEXT, fonte_dados TEXT, oferta TEXT,
  envio_id INTEGER, tentativas INTEGER NOT NULL DEFAULT 0, espera_ate INTEGER, decidido_em INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS idx_esp_msg ON espelho_itens (espelho_id, origem_jid, msg_id, url);
CREATE INDEX IF NOT EXISTS idx_esp_dedupe ON espelho_itens (espelho_id, asin, status, decidido_em);
CREATE INDEX IF NOT EXISTS idx_esp_status ON espelho_itens (status, espera_ate, ts);
-- Fonte "catalogo" (API de ofertas do Etiqueta). Uma linha por oferta já tratada numa regra; chave: MLB<n>|ASIN:<asin>|SHOPEE:<shop>.<item>.
-- loja: ml|amazon|shopee. motivos: lista JSON (shopee|desconto_100|preco_antigo|falha_link|nao_conferido). oferta: JSON da oferta, sem dado pessoal.
CREATE TABLE IF NOT EXISTS catalogo_itens (
  id INTEGER PRIMARY KEY, rule_id INTEGER NOT NULL, chave TEXT NOT NULL, loja TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('revisao','enviado','descartado')), motivos TEXT NOT NULL DEFAULT '[]',
  oferta TEXT NOT NULL, envio_id INTEGER, criado_em INTEGER NOT NULL, decidido_em INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cat_item ON catalogo_itens (rule_id, chave);
CREATE INDEX IF NOT EXISTS idx_cat_status ON catalogo_itens (status, rule_id, criado_em);
-- listagem da revisão por regra e status, da decisão mais recente (GET /api/catalogo/itens)
CREATE INDEX IF NOT EXISTS idx_cat_lista ON catalogo_itens (rule_id, status, COALESCE(decidido_em, criado_em));
-- Cursor da API por regra e filtro (sha256 do config normalizado, 16 hex). pronto=0: ainda avançando até o fim sem enviar.
CREATE TABLE IF NOT EXISTS catalogo_cursores (
  rule_id INTEGER NOT NULL, filtro TEXT NOT NULL, cursor TEXT, pronto INTEGER NOT NULL DEFAULT 0,
  atualizado_em INTEGER, PRIMARY KEY (rule_id, filtro));
-- Rastreio por grupo (src/rastreio.js). Associação loja × grupo (jid) ou bloco (id em texto) -> código:
-- etiqueta do ML (nome em tags), ID de rastreamento da Amazon ou Sub_id da Shopee (só bloco). Um código, um alvo.
CREATE TABLE IF NOT EXISTS rastreio_codigos (id INTEGER PRIMARY KEY,
  loja TEXT NOT NULL CHECK (loja IN ('mercadolivre','amazon','shopee')),
  alvo_tipo TEXT NOT NULL CHECK (alvo_tipo IN ('grupo','bloco')), alvo TEXT NOT NULL,
  codigo TEXT NOT NULL, criado_em INTEGER, atualizado_em INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rcod_alvo ON rastreio_codigos (loja, alvo_tipo, alvo);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rcod_cod ON rastreio_codigos (loja, codigo);
-- Uma linha por grupo em todo envio de oferta que deu certo. esperado=1: havia associação para o grupo;
-- nivel grupo|bloco = saiu com o código dela; padrao|nenhum = não saiu (motivo diz por quê). Sem dado de pessoa.
CREATE TABLE IF NOT EXISTS rastreio_envios (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, jid TEXT NOT NULL,
  loja TEXT NOT NULL, origem TEXT NOT NULL CHECK (origem IN ('regra','manual','catalogo','espelho')),
  rule_id INTEGER, envio_id INTEGER, oferta_chave TEXT, link TEXT NOT NULL, codigo TEXT,
  nivel TEXT NOT NULL CHECK (nivel IN ('grupo','bloco','padrao','nenhum')), bloco_id INTEGER,
  esperado INTEGER NOT NULL DEFAULT 0, motivo TEXT);
CREATE INDEX IF NOT EXISTS idx_renv_ts ON rastreio_envios (ts);
CREATE INDEX IF NOT EXISTS idx_renv_cod ON rastreio_envios (loja, codigo, ts);
-- Atribuição dos ganhos (src/ganhos.js): só as linhas grupo/bloco, para não percorrer os envios com o código padrão.
-- A consulta repete o WHERE do índice parcial; o _ci é o da Amazon, que não distingue maiúsculas no código.
CREATE INDEX IF NOT EXISTS idx_renv_atrib ON rastreio_envios (loja, codigo, ts) WHERE nivel IN ('grupo','bloco');
CREATE INDEX IF NOT EXISTS idx_renv_atrib_ci ON rastreio_envios (loja, lower(codigo), ts) WHERE nivel IN ('grupo','bloco');
-- Ganhos (src/ganhos.js, src/importador.js). Uma linha por arquivo importado: só o sha256 do arquivo, nunca o conteúdo.
CREATE TABLE IF NOT EXISTS importacoes (id INTEGER PRIMARY KEY, loja TEXT NOT NULL, tipo TEXT NOT NULL CHECK (tipo IN ('comissoes','cliques')),
  arquivo_sha256 TEXT NOT NULL, codigo_arquivo TEXT, lidas INTEGER, novas INTEGER, atualizadas INTEGER, ignoradas INTEGER,
  criado_em INTEGER NOT NULL, user_id INTEGER);
-- Comissão por venda, em centavos. chave = HMAC-SHA256 com a pseudo_key local (32 hex): com pedido, de
-- loja|pedido|produto|código da coluna; sem pedido, de loja|data|produto|código (o da coluna ou o do arquivo);
-- mais "#n" para a n-ésima linha igual no mesmo arquivo (src/importador.js). O pedido não é guardado;
-- só as colunas da lista branca do importador, nada do comprador.
CREATE TABLE IF NOT EXISTS comissoes (id INTEGER PRIMARY KEY, loja TEXT NOT NULL, chave TEXT NOT NULL, data TEXT NOT NULL,
  codigo TEXT, produto TEXT, titulo TEXT, quantidade INTEGER NOT NULL DEFAULT 1, venda_centavos INTEGER NOT NULL DEFAULT 0,
  comissao_centavos INTEGER NOT NULL, status TEXT NOT NULL CHECK (status IN ('confirmada','pendente','cancelada')),
  importacao_id INTEGER NOT NULL, atualizado_em INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_com_chave ON comissoes (loja, chave);
CREATE INDEX IF NOT EXISTS idx_com_cod ON comissoes (loja, codigo, data);
-- Cliques do relatório da loja, um total por dia e código ('' = sem código); a última importação vale.
CREATE TABLE IF NOT EXISTS cliques_loja (loja TEXT NOT NULL, dia TEXT NOT NULL, codigo TEXT NOT NULL DEFAULT '',
  cliques INTEGER NOT NULL, importacao_id INTEGER NOT NULL, atualizado_em INTEGER, PRIMARY KEY (loja, dia, codigo));
-- Gasto com anúncio informado à mão por grupo (jid) ou bloco (id em texto), de inicio a fim (AAAA-MM-DD), rateado por dia.
CREATE TABLE IF NOT EXISTS gastos_anuncio (id INTEGER PRIMARY KEY, alvo_tipo TEXT NOT NULL CHECK (alvo_tipo IN ('grupo','bloco')),
  alvo TEXT NOT NULL, inicio TEXT NOT NULL, fim TEXT NOT NULL, valor_centavos INTEGER NOT NULL CHECK (valor_centavos > 0),
  nota TEXT, criado_em INTEGER, user_id INTEGER);
-- Envio pelo sócio: números de WhatsApp autorizados a mandar links no privado. jid e lid são dado pessoal (nunca saem
-- do servidor) e só existem aqui: excluir o remetente apaga o número. destino_jids: lista JSON de grupos.
CREATE TABLE IF NOT EXISTS remetentes (
  id INTEGER PRIMARY KEY, nome TEXT NOT NULL, jid TEXT NOT NULL UNIQUE, lid TEXT UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1, destino_jids TEXT NOT NULL DEFAULT '[]', template_id INTEGER, tag_id INTEGER,
  enviar_foto INTEGER NOT NULL DEFAULT 1, max_por_hora INTEGER NOT NULL DEFAULT 10, dedupe_horas INTEGER NOT NULL DEFAULT 24,
  responder INTEGER NOT NULL DEFAULT 1, created_at INTEGER, updated_at INTEGER);
-- Um item por link recebido de um remetente. status: recebido|processando|enviado|duplicado|descartado|erro.
-- Sem texto da mensagem e sem número: o remetente vai pelo id e pelo nome.
CREATE TABLE IF NOT EXISTS remetente_itens (
  id INTEGER PRIMARY KEY, remetente_id INTEGER NOT NULL, remetente_nome TEXT, msg_id TEXT NOT NULL, ts INTEGER NOT NULL,
  url TEXT NOT NULL DEFAULT '', loja TEXT, complemento TEXT, status TEXT NOT NULL DEFAULT 'recebido', codigo TEXT, motivo TEXT,
  chave TEXT, oferta TEXT, fonte_dados TEXT, envio_id INTEGER, decidido_em INTEGER, respondido_em INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rem_msg ON remetente_itens (remetente_id, msg_id, url);
CREATE INDEX IF NOT EXISTS idx_rem_status ON remetente_itens (status, ts);
CREATE INDEX IF NOT EXISTS idx_rem_dedupe ON remetente_itens (remetente_id, chave, status, decidido_em);
CREATE INDEX IF NOT EXISTS idx_rem_hora ON remetente_itens (remetente_id, ts);
-- Grupo vivo: rotinas recorrentes de mensagem ou enquete. No horário, a rotina grava uma ocorrência 'agora' em envios.
-- conteudos: lista JSON de 1 a 5 (mensagem: ["texto",…]; enquete: [{pergunta,opcoes,multipla}]), em rodízio ou sorteio.
-- repetir: {dias:[0..6], horarios:['HH:MM'] 1..6}, igual ao do Disparar mensagem. next_run_at NULL = desligada.
CREATE TABLE IF NOT EXISTS rotinas (
  id INTEGER PRIMARY KEY, nome TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  tipo TEXT NOT NULL CHECK (tipo IN ('mensagem','enquete')),
  conteudos TEXT NOT NULL DEFAULT '[]',
  ordem TEXT NOT NULL DEFAULT 'rodizio' CHECK (ordem IN ('rodizio','sorteio')), proximo_indice INTEGER NOT NULL DEFAULT 0,
  group_jids TEXT NOT NULL DEFAULT '[]', repetir TEXT NOT NULL,
  next_run_at INTEGER, last_run_at INTEGER, ultimo_envio_id INTEGER, created_at INTEGER, updated_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_rotinas_fila ON rotinas (enabled, next_run_at);
-- Proteção do número (plano anti-banimento): uma linha por mensagem que o número enviou, para o teto por hora em janela
-- deslizante. Só a hora do envio: sem jid, número nem conteúdo. src/ritmo.js apaga o que passa de 2 h.
CREATE TABLE IF NOT EXISTS wa_saidas (ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_wa_saidas_ts ON wa_saidas (ts);
-- Vigia (plano rodar-sozinho-entrega3): uma linha por execução de regra, para as sequências ("3 execuções seguidas") e a
-- linha de saúde do dia. Só o id da regra e números, sem dado pessoal. conta = 0: não soma nem zera sequência.
-- lojas_pedidas: lista JSON das lojas da regra; por_loja: {loja: {saiu, pulada, descartada, revisao, esperou, motivos}}.
-- rule_id sem FK: a linha fica se a regra for apagada. O agendador apaga o que passa de 35 dias.
CREATE TABLE IF NOT EXISTS execucoes (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, rule_id INTEGER, conta INTEGER NOT NULL CHECK (conta IN (0,1)),
  want INTEGER NOT NULL DEFAULT 0, saidas INTEGER NOT NULL DEFAULT 0, erros INTEGER NOT NULL DEFAULT 0,
  lojas_pedidas TEXT NOT NULL DEFAULT '[]', por_loja TEXT NOT NULL DEFAULT '{}');
CREATE INDEX IF NOT EXISTS execucoes_ts ON execucoes(ts);
CREATE INDEX IF NOT EXISTS execucoes_regra ON execucoes(rule_id, id);
`;

// Colunas acrescentadas depois da primeira versão (ALTER TABLE só se faltar).
const EXTRA_COLUMNS = [
  ['groups', 'invite_code', 'TEXT'],
  ['groups', 'is_admin', 'INTEGER'],
  ['groups', 'description', 'TEXT'],
  ['links', 'auto_next', 'INTEGER DEFAULT 0'],
  ['rules', 'sources', 'TEXT'],
  ['sessions', 'last_seen', 'INTEGER'],
  ['sessions', 'user_id', 'INTEGER'],
  // envio pelo sócio (rodada 2): hora em que o item chegou ao programa (o limite por hora conta por ela, não pelo ts da
  // mensagem, que pode chegar atrasada) e quantos links a linha 'limite' representa (a resposta "Recebi N links")
  ['remetente_itens', 'chegou_em', 'INTEGER'],
  ['remetente_itens', 'qtd_links', 'INTEGER'],
  // grade de horários da regra (JSON {dias, horarios:[{hora, qtd, template_id}]}); NULL = ritmo por intervalo, o de antes
  ['rules', 'grade', 'TEXT'],
  // quantos admins o grupo tem (proteção do número: selo "Falta 2º admin"); só a contagem, sem quem são. NULL = desconhecido
  ['groups', 'admins', 'INTEGER'],
  // não repetir produto parecido: título e preço (em centavos) de cada oferta enviada pela regra. NULL = desconhecido,
  // e a linha não entra na comparação (título) ou barra a exceção do mais barato (preço)
  ['sent_offers', 'title', 'TEXT'],
  ['sent_offers', 'price_cents', 'INTEGER'],
];

// Preenche título e preço dos envios antigos a partir do item do catálogo da mesma regra e chave. O preço só vem de
// item 'enviado' com price numérico > 0. CASE aninhado: json_type/json_extract só rodam sobre JSON válido. Envios das
// outras fontes (sem item no catálogo) ficam NULL. COALESCE: nunca troca o que já está gravado.
const PREENCHER_ENVIADOS = `
UPDATE sent_offers SET
  title = COALESCE(title, (SELECT CASE WHEN json_valid(c.oferta) THEN json_extract(c.oferta, '$.title') END
    FROM catalogo_itens c WHERE c.rule_id = sent_offers.rule_id AND c.chave = sent_offers.offer_key)),
  price_cents = COALESCE(price_cents, (SELECT CASE WHEN json_valid(c.oferta) THEN
      CASE WHEN json_type(c.oferta, '$.price') IN ('integer', 'real') AND json_extract(c.oferta, '$.price') > 0
        THEN CAST(ROUND(json_extract(c.oferta, '$.price') * 100) AS INTEGER) END END
    FROM catalogo_itens c WHERE c.rule_id = sent_offers.rule_id AND c.chave = sent_offers.offer_key AND c.status = 'enviado'))
WHERE title IS NULL OR price_cents IS NULL`;

// "[ … ]" é um pedaço opcional: some sozinho quando algum placeholder dentro dele está vazio (renderTemplate).
// Só vale para instalações novas; quem já tem o template "Padrão" no banco continua com o texto de antes.
export const DEFAULT_TEMPLATE = [
  '*{TITULO_PRODUTO}*',
  '',
  '😱 De ~{PRECO_ANTIGO}~',
  '🔥 Por *{PRECO_PRODUTO}*[ ({DESCONTO_PRODUTO} OFF)]',
  '⭐ {NUMERO_VENDAS}',
  '🚚 {FRETE}',
  '🎟️ Cupom: *{CUPOM}*',
  '',
  '🛒 Compre aqui: {LINK}',
].join('\n');

/** Nome do template "Amazon" (texto em TEMPLATE_AMAZON, de template.js), semeado uma vez por openDb (setting tpl_amazon_seed). */
export const NOME_TEMPLATE_AMAZON = 'Amazon';

/** SQLite aceita só null/número/texto: converte undefined e booleanos. */
export function nz(v) {
  if (v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

export function openDb(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'disparador.db'));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  // o preenchimento roda uma vez só: na abertura em que sent_offers ganha price_cents
  const preencherEnviados = !db.prepare('PRAGMA table_info(sent_offers)').all().some((c) => c.name === 'price_cents');
  for (const [table, col, type] of EXTRA_COLUMNS) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
  if (preencherEnviados) {
    try {
      db.exec(PREENCHER_ENVIADOS);
    } catch (e) {
      // sem e.message: a mensagem do banco pode trazer dados. Os envios antigos ficam sem título e preço (não comparados).
      console.error('[db] não consegui preencher título e preço dos envios antigos:', e?.code || e?.name || 'erro');
    }
  }
  if (!db.prepare('SELECT 1 FROM templates LIMIT 1').get()) {
    db.prepare('INSERT INTO templates (name, body, created_at) VALUES (?, ?, ?)')
      .run('Padrão', DEFAULT_TEMPLATE, Date.now());
  }
  semearTemplateAmazon(db);
  migrarNaoConferido(db);
  migrarFalhaLink(db);
  if (!getSetting(db, 'ext_token')) setSetting(db, 'ext_token', crypto.randomBytes(24).toString('hex'));
  return db;
}

/**
 * Cria o template "Amazon" uma única vez por banco, em instalação nova ou antiga. A marca tpl_amazon_seed
 * (id do template criado) impede recriar: se o dono apagar ou renomear o template, ele não volta.
 */
function semearTemplateAmazon(db) {
  if (getSetting(db, 'tpl_amazon_seed') !== null) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (getSetting(db, 'tpl_amazon_seed') === null) {
      const { lastInsertRowid } = db.prepare('INSERT INTO templates (name, body, created_at) VALUES (?, ?, ?)')
        .run(NOME_TEMPLATE_AMAZON, TEMPLATE_AMAZON, Date.now());
      setSetting(db, 'tpl_amazon_seed', Number(lastInsertRowid));
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Rodar sozinho, entrega 1 (plano rodar-sozinho-entrega1, decisão 6 e P6): o catálogo deixa de mandar à revisão a
// oferta que só não pôde ser conferida. Uma vez por banco, os itens que esperam revisão SÓ por esse motivo saem da fila
// (DELETE: são cópias de ofertas do Etiqueta e voltam se o catálogo as trouxer de novo). Outro motivo, junto ou não, e
// outro status ficam. A marca é gravada também em banco novo, para a migração nunca rodar depois.
export const MARCA_MIGRACAO_E1 = 'migracao_e1_nao_conferido';
const SO_NAO_CONFERIDO = '["nao_conferido"]'; // como o registrar de src/catalogo-itens.js grava (JSON.stringify)

/** Linha `info` do Histórico com quantos itens a migração tirou da revisão. Sem dado pessoal: só a contagem. */
export function textoMigracaoE1(n) {
  const base = 'Revisão do Catálogo:';
  const motivo = 'só porque não deu para conferir o preço';
  if (n === 1) return `${base} 1 oferta que esperava revisão ${motivo} saiu da fila. Ela volta se o catálogo a trouxer de novo.`;
  if (n > 1) return `${base} ${n} ofertas que esperavam revisão ${motivo} saíram da fila. Elas voltam se o catálogo as trouxer de novo.`;
  return `${base} nenhuma oferta esperava revisão ${motivo}.`;
}

// Rodar sozinho, entrega 2 (plano rodar-sozinho-entrega2, decisão 9 e CA2.17): o link que falha deixa de mandar a oferta
// do catálogo para a revisão (a falha passageira é pulada; na 3ª, `falhas_repetidas`). Uma vez por banco, os itens que
// esperam revisão SÓ por `falha_link` saem da fila, no mesmo molde da migração da entrega 1. `falha_link` segue em
// MOTIVOS (src/catalogo-itens.js) só para ler as linhas que ficaram.
export const MARCA_MIGRACAO_E2 = 'migracao_e2_falha_link';
const SO_FALHA_LINK = '["falha_link"]'; // como o registrar de src/catalogo-itens.js grava (JSON.stringify)

/** Linha `info` do Histórico com quantos itens a migração da entrega 2 tirou da revisão (texto da spec). Só a contagem. */
export function textoMigracaoE2(n) {
  const base = 'Revisão do Catálogo:';
  const motivo = 'só porque o link não foi gerado';
  if (n === 1) return `${base} 1 oferta que esperava revisão ${motivo} saiu da fila. Ela volta se o catálogo a trouxer de novo.`;
  if (n > 1) return `${base} ${n} ofertas que esperavam revisão ${motivo} saíram da fila. Elas voltam se o catálogo as trouxer de novo.`;
  return `${base} nenhuma oferta esperava revisão ${motivo}.`;
}

/** Migração do `nao_conferido` (CA1.10). */
function migrarNaoConferido(db) {
  tirarDaRevisaoSo(db, { marca: MARCA_MIGRACAO_E1, motivos: SO_NAO_CONFERIDO, texto: textoMigracaoE1, quais: 'só não conferidas' });
}

/** Migração do `falha_link` (CA2.17). */
function migrarFalhaLink(db) {
  tirarDaRevisaoSo(db, { marca: MARCA_MIGRACAO_E2, motivos: SO_FALHA_LINK, texto: textoMigracaoE2, quais: 'só com o link não gerado' });
}

/**
 * Miolo das migrações únicas da revisão do Catálogo: DELETE restrito a status 'revisao' e `motivos` exatamente igual a
 * `motivos` (o texto JSON do registrar), a marca e a linha do Histórico na mesma transação. A linha só sai em banco com
 * catálogo em uso (instalação nova não ganha linha). Falha desfaz tudo, sem marca: tenta de novo na próxima abertura e
 * não impede o programa de subir.
 */
function tirarDaRevisaoSo(db, { marca, motivos, texto, quais }) {
  if (getSetting(db, marca) !== null) return;
  let aberta = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    aberta = true;
    if (getSetting(db, marca) === null) {
      const comCatalogo = !!db.prepare('SELECT 1 FROM catalogo_itens LIMIT 1').get();
      const { changes } = db.prepare("DELETE FROM catalogo_itens WHERE status = 'revisao' AND motivos = ?").run(motivos);
      setSetting(db, marca, '1');
      if (comCatalogo) addLog(db, { level: 'info', message: texto(Number(changes)) });
    }
    db.exec('COMMIT');
  } catch (e) {
    if (aberta) { try { db.exec('ROLLBACK'); } catch { /* a transação já foi desfeita */ } }
    // sem e.message: a mensagem do banco pode trazer dados. Os itens ficam na revisão até a próxima abertura.
    console.error(`[db] não consegui tirar da revisão as ofertas ${quais}:`, e?.code || e?.name || 'erro');
  }
}

export function getSetting(db, key, def = null) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : def;
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

export const MAX_SOURCES = 5;
/** Fontes da regra (até 5). Regras antigas, com uma fonte só, viram uma lista de um item. */
function parseSources(r) {
  let list = null;
  try { list = JSON.parse(r.sources || 'null'); } catch { /* inválido: usa a fonte única */ }
  if (Array.isArray(list) && list.length) return list.slice(0, MAX_SOURCES).map((s) => ({ type: s.type || 'list', config: s.config || {}, tag_id: s.tag_id ?? null }));
  return [{ type: r.source_type || 'list', config: JSON.parse(r.source_config || '{}'), tag_id: null }];
}

/**
 * Grade de horários da regra: o objeto gravado, ou null (modo intervalo) se vier vazia, ilegível ou fora de forma.
 * Nunca lança: uma regra com grade quebrada não pode travar o tick. A forma completa é conferida ao salvar (src/grade.js).
 */
function parseGrade(valor) {
  if (typeof valor !== 'string' || !valor.trim()) return null;
  try {
    const g = JSON.parse(valor);
    return g && typeof g === 'object' && !Array.isArray(g) ? g : null;
  } catch {
    return null;
  }
}

/** Linha do banco -> objeto de regra com os campos JSON já lidos. */
export function parseRule(r) {
  if (!r) return null;
  return {
    ...r,
    enabled: !!r.enabled,
    send_image: !!r.send_image,
    group_jids: JSON.parse(r.group_jids || '[]'),
    source_config: JSON.parse(r.source_config || '{}'),
    sources: parseSources(r),
    grade: parseGrade(r.grade),
  };
}

const MAX_MENSAGEM_LOG = 1000; // erro de biblioteca ou da extensão pode vir enorme: o histórico guarda só o começo

export function addLog(db, { rule, level = 'info', group_name = null, offer_title = null, message }) {
  const msg = message == null ? null : String(message).slice(0, MAX_MENSAGEM_LOG);
  db.prepare('INSERT INTO log (ts, rule_id, rule_name, level, group_name, offer_title, message) VALUES (?,?,?,?,?,?,?)')
    .run(Date.now(), rule?.id ?? null, rule?.name ?? null, level, group_name, offer_title, msg);
  // mantém o histórico enxuto
  db.prepare('DELETE FROM log WHERE id < (SELECT MAX(id) FROM log) - 5000').run();
}
