// Envio pelo sócio (plano envio-pelo-socio, D2 a D8; ADR-006): números de WhatsApp cadastrados pelo dono (os
// "remetentes") mandam no privado links do Mercado Livre, da Amazon, da Shopee ou da Magalu, e cada link vira uma oferta
// com a afiliação do dono na fila única de envios, sem aprovação, para os grupos daquele remetente. Na Magalu (plano
// integracao-magalu, etapa 5) nada é lido da loja: título e preço vêm do texto da mensagem, e o link sai com a loja de
// parceiro do dono, montada no envio a partir do endereço do produto. A loja de parceiro do sócio que vem no link nunca
// é guardada: o link de produto vira o endereço do produto sem loja (magazineluiza.com.br) e a chave MAGALU:<código>;
// o link curto (maga.lu, onelink.me, magalu.com e subdomínios) fica sem query nem fragmento; a página da Magalu que não
// é de produto (busca, vitrine da loja de um parceiro) é descartada já na chegada (link_invalido), sem endereço.
//
// Ciclo (o do espelho, src/espelho.js): o ouvinte privado do whatsapp.js (onPrivada) entrega { ids, texto, msgId, ts }
// a receber(), que é síncrono e sem rede e grava um item `recebido` por link (`remetente_itens`). O tick decide em
// processarPendentes() (trava recebido → processando, lote e orçamento de tempo, expiração de 2 h) e grava a linha de
// `envios` direto (tipo 'oferta', 'agora', origem remetente), que tem a trava, a retomada, as pausas de Ajustes e o
// histórico por grupo. A oferta vem da montagem do Disparo manual (envios.montarOferta: leitura da loja, link do
// dono, texto completando os campos); antes da rede, envios.situacaoLink diz se o link do dono sai. Quando os envios
// de uma mensagem terminam, responderPendentes() manda uma frase fixa (RESPOSTAS) ao remetente, fora da fila (como os
// avisos de src/avisos.js).
//
// Quem pode (D2): só remetente cadastrado e ligado, casado pelo número (`jid`) ou pelo LID guardado. O LID só é
// aprendido quando a mensagem casou pelo número. Desconhecido, desligado ou mensagem minha: silêncio total (nenhum
// item, linha de log ou resposta), para não confirmar que o número existe.
//
// Privacidade (CA9): o número e o LID ficam só na tabela `remetentes`; os itens levam o id e o nome do remetente, e o
// log o nome ("Remetente: <nome>"). O texto da mensagem nunca é guardado: só os campos lidos dele (`complemento`), já
// mascarados (mascararPessoais), só quando a mensagem tem um link de loja só e só até a decisão do item. O link do ML e
// os encurtadores ficam sem query nem fragmento (o rastreio de terceiro). O console leva só o código ou o nome
// do erro, nunca a mensagem (ela pode trazer o número ou os valores da query); a falha do envio da resposta vai ao log
// passada por semNumero.
//
// Cadastro e rotas (etapa 6): só o Dono escreve (P9); o número é validado (BR), conferido no WhatsApp com freio de
// consultas por IP e nunca volta ao navegador (a lista leva só o mascarado). Excluir apaga o número e o LID; os itens
// ficam com o nome. O cartão traz contadores de 24 h, o último link e o problema real (CA11).

import { addLog } from './db.js';
import { identificar } from './lojas.js';
import { extrairAsin } from './amazon.js';
import { extrairIds } from './shopee.js';
import { extrairProdutoMagalu } from './magalu.js';
import { produtoMl } from './envios.js';
import { extrairUrls, lerOfertaDoTexto, MAX_URLS } from './oferta-texto.js';
import { mascararPessoais, chaveIp } from './privacidade.js';
import { MAX_TEXTO_RECEBIDO } from './whatsapp.js';
import { semNumero, mascararNumero } from './avisos.js';
import { createLimiter } from './auth.js';

const HORA = 3600000;
const DIA = 24 * HORA;
const PARADO_MAX = 2 * HORA;          // mensagem ou item parado (programa fora do ar) há mais que isso não sai (P10, CA7)
const LOTE = 20;                      // itens por chamada de processarPendentes (o tick não fica preso aqui)
const TEMPO_LOTE = 20000;             // ms por passada de processarPendentes: o resto fica 'recebido' para o próximo tick
const LOTE_RESPOSTAS = 50;            // mensagens por chamada de responderPendentes
const MAX_RESPOSTAS_HORA = 20;        // respostas por remetente por hora (D8): nada de laço com outro robô
const RESPOSTA_MAX_DIAS = 1;          // mensagem sem resposta há mais que isso (envio pausado esquecido) é dada por respondida
const MAX_IDS = 5;
const MAX_MSG_ID = 256;
const MAX_NOME_LOG = 80;
const LOJAS = new Set(['mercadolivre', 'amazon', 'shopee', 'magalu']);
const ATIVOS = ['recebido', 'processando'];
const JID_PRIVADO = /^\d+@(?:s\.whatsapp\.net|lid)$/;
const CAMPOS_OFERTA = ['title', 'price', 'oldPrice', 'discountPct', 'sold', 'freeShipping', 'coupon', 'image'];
const CAMPOS_TEXTO = ['title', 'price', 'oldPrice', 'discountPct', 'sold', 'freeShipping', 'coupon'];
const JID_NUMERO = /^\d+@s\.whatsapp\.net$/;
const JID_LID = /^\d+@lid$/;
// encurtadores da Amazon, da Shopee e da Magalu (src/amazon.js, src/shopee.js, src/magalu.js): o código está no
// caminho, a query é só rastreio
const ENCURTADORES = ['link.amazon', 'amzn.to', 'amzn.com', 'a.co', 's.shopee.com.br', 'shp.ee', 'shope.ee', 'maga.lu', 'magazineluiza.onelink.me'];
// páginas da Magalu (a loja e as lojas de parceiro): o que não é produto aqui (busca, vitrine) pode ter a loja do sócio
// no caminho e nunca chega a um produto
const PAGINAS_MAGALU = ['magazineluiza.com.br', 'magazinevoce.com.br'];

// Cadastro e consulta (etapa 6)
const MAX_NOME = 60;
const MAX_DIGITOS_NOME = 5;           // o nome vai ao log e ao Histórico: com 6 ou mais algarismos pode ser um telefone
const MAX_NUMERO = 40;                // caracteres do número digitado, antes de tirar o que não é dígito
const MAX_GRUPOS = 500;
const MAX_POR_HORA = 60;              // "links por hora" do remetente: de 1 a isto (padrão 10, no SCHEMA)
const MAX_DEDUPE_HORAS = 8760;
const MAX_LIMITE_ITENS = 50;
const MAX_NOME_GRUPO = 100;
const MAX_MOTIVO_ENVIO = 200;
const CONSULTAS_MAX = 10;             // consultas de número ao WhatsApp (onWhatsApp) por IP…
const CONSULTAS_JANELA_MS = 10 * 60000; // …a cada 10 min (como em src/avisos.js): cadastrar é raro, varrer números não
const NAO_ENVIADO = 'não foi enviado';
const CONTADORES = ['recebidos', 'enviados', 'repetidos', 'descartados', 'com_erro'];

/** Frases fixas do cadastro. Nenhuma repete o número. */
const MSG = Object.freeze({
  naoEncontrado: 'Remetente não encontrado.',
  semNome: 'Dê um nome ao remetente.',
  nomeLongo: `O nome pode ter até ${MAX_NOME} letras.`,
  nomeComNumero: `Não ponha o número no nome (ele aparece no Histórico): use até ${MAX_DIGITOS_NOME} algarismos.`,
  numero: 'Informe o número com DDD. Exemplo: (35) 99999-1234.',
  foraDoWhats: 'Este número não está no WhatsApp.',
  conectado: 'Este é o número conectado ao painel. Cadastre o número de quem vai mandar os links.',
  semConferir: 'Não consegui conferir o número no WhatsApp. Confira se ele está conectado em Números de WhatsApp.',
  duplicado: (nome) => `Este número já está cadastrado como ${nome}.`,
  semGrupos: 'Marque ao menos um grupo de destino.',
  gruposInvalidos: 'Lista de grupos inválida.',
  muitosGrupos: `Marque no máximo ${MAX_GRUPOS} grupos de destino.`,
  grupoSumiu: 'Algum grupo de destino não existe mais. Atualize a lista e escolha de novo.',
  semTemplate: 'Escolha um template.',
  templateSemLink: 'O template precisa do campo {LINK}.',
  semEtiqueta: 'A etiqueta escolhida não existe mais. Escolha outra.',
  porHora: `Links por hora: use um número de 1 a ${MAX_POR_HORA}.`,
  dedupe: `Horas sem repetir: use de 0 a ${MAX_DEDUPE_HORAS}.`,
  bool: (campo) => `${campo}: ligue ou desligue.`,
  indisponivel: 'O envio pelo remetente não está disponível neste servidor.',
  inesperado: 'Não consegui concluir. Tente de novo.',
  muitasConsultas: (s) => `Muitas consultas de número em pouco tempo. Tente de novo em ${Math.max(1, Math.ceil(s / 60))} min.`,
});

/** Problema de configuração no cartão (CA11): só o que impede o envio e o dono resolve editando o remetente. */
const PROBLEMAS = Object.freeze({
  grupoSumiu: (nome) => `O número saiu do grupo ${nome}. Edite o remetente.`,
  umGrupoSumiu: 'O número saiu de um grupo deste remetente. Edite o remetente.',
  gruposSumiram: (n) => `O número saiu de ${n} grupos deste remetente. Edite o remetente.`,
  semTemplate: 'O template deste remetente foi apagado. Edite o remetente.',
  templateSemLink: 'O template deste remetente está sem o campo {LINK}. Edite o template ou o remetente.',
  semEtiqueta: 'A etiqueta deste remetente foi apagada. Edite o remetente.',
});

/**
 * Bloqueios de afiliação (os códigos de envios.situacaoLink): a loja, a frase do cartão e a conexão que resolve (o
 * painel liga a frase a Conexões; o modo direto é de Ajustes, então vai sem conexão).
 */
const AFILIACAO = Object.freeze({
  sem_etiqueta: { loja: 'mercadolivre', conexao: 'mercadolivre', texto: 'Os links do Mercado Livre não saem: falta a etiqueta. Cadastre em Conexões.' },
  modo_direto: { loja: 'mercadolivre', conexao: null, texto: 'Os links do Mercado Livre não saem: o modo direto está ligado em Ajustes e não gera comissão. Mude em Ajustes.' },
  sem_extensao: { loja: 'mercadolivre', conexao: 'mercadolivre', texto: 'Os links do Mercado Livre não saem: a extensão do Chrome está desconectada. Abra o Chrome e confira em Conexões.' },
  sem_tag_amazon: { loja: 'amazon', conexao: 'amazon', texto: 'Os links da Amazon não saem: falta a tag. Cadastre em Conexões.' },
  sem_id_shopee: { loja: 'shopee', conexao: 'shopee', texto: 'Os links da Shopee não saem: falta o ID de afiliado. Cadastre em Conexões.' },
  sem_link_shopee: { loja: 'shopee', conexao: 'shopee', texto: 'Os links da Shopee não saem: falta a API ou a extensão para gerar o link. Confira em Conexões.' },
  sem_loja_magalu: { loja: 'magalu', conexao: 'magalu', texto: 'Os links da Magalu não saem: falta o nome da sua loja de parceiro. Cadastre em Conexões.' },
});

/** Erro com status HTTP (montarRotas responde com ele). A mensagem é sempre fixa ou leva só o nome de um remetente. */
class ErroRemetente extends Error {
  constructor(status, mensagem) {
    super(mensagem);
    this.name = 'ErroRemetente';
    this.status = status;
  }
}

/**
 * Número digitado → DDD + número (10 ou 11 dígitos), ou null. Regra do plano, a mesma do painel: só os dígitos; o 55
 * sai de 12 ou 13 dígitos; DDD de 11 a 99; com 11 dígitos o 3º é 9. Mais estrita que a dos avisos porque o número tem
 * de casar com quem manda a mensagem.
 */
function digitosDoNumero(v) {
  if (typeof v !== 'string' || v.length > MAX_NUMERO) return null;
  let d = v.replace(/\D/g, '');
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  if (d.length !== 10 && d.length !== 11) return null;
  if (Number(d.slice(0, 2)) < 11) return null;
  if (d.length === 11 && d[2] !== '9') return null;
  return d;
}

/** Inteiro de um número ou de um texto só com dígitos (o select do painel manda texto); senão NaN. */
const inteiroDe = (v) => (typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN);

// Item que conta como "enviado" para "Horas sem repetir" (como no espelho, Q2): status 'enviado' e o envio não terminou
// sem nenhum grupo recebido. Envio ainda na fila conta (dois itens do mesmo produto não saem juntos); envio encerrado
// só conta se ao menos um grupo recebeu. Envio já apagado pela retenção conta.
const ENVIO_ATIVO = ['pendente', 'enviando', 'pausado'];
const LISTA_ENVIO_ATIVO = ENVIO_ATIVO.map((x) => `'${x}'`).join(', ');
const CONTA_COMO_ENVIADO = `status = 'enviado' AND NOT EXISTS (SELECT 1 FROM envios v WHERE v.id = remetente_itens.envio_id
  AND v.status NOT IN (${LISTA_ENVIO_ATIVO})
  AND NOT EXISTS (SELECT 1 FROM envio_resultados r WHERE r.envio_id = v.id AND r.ok = 1))`;

/** Status de cada código (o que não está aqui é 'erro'). */
const DUPLICADOS = new Set(['repetida', 'mesma_mensagem']);
const DESCARTES = new Set(['limite', 'sem_link_de_loja', 'link_invalido', 'sem_dados', 'desligado', 'apagado', 'expirado']);
/** Códigos que não pedem resposta: o remetente foi desligado ou excluído, ou a mensagem ficou velha (P10). */
const SEM_RESPOSTA = new Set(['desligado', 'apagado', 'expirado']);

/** Motivo de cada código, para o Histórico (frase fixa; o log leva o nome do remetente, nunca o número). */
export const MOTIVOS = Object.freeze({
  repetida: (horas) => `repetida (enviada há ${horas} h)`,
  mesma_mensagem: 'mesmo produto de outro link desta mensagem',
  limite: 'passou do limite de links por hora',
  sem_link_de_loja: 'sem link do Mercado Livre, Amazon, Shopee ou Magalu',
  link_invalido: 'link não reconhecido',
  sem_dados: 'sem dados para montar a oferta (título ou preço)',
  desligado: 'o remetente foi desligado',
  apagado: 'o remetente foi excluído',
  expirado: 'ficou parada mais de 2 h (programa desligado ou fora do ar)',
  sem_etiqueta: 'falta a etiqueta do Mercado Livre',
  modo_direto: 'os links do Mercado Livre estão no modo direto (sem comissão)',
  sem_extensao: 'a extensão do Chrome está desconectada (Mercado Livre)',
  sem_tag_amazon: 'falta a tag da Amazon',
  sem_id_shopee: 'falta o ID da Shopee',
  sem_link_shopee: 'sem como gerar o link da Shopee (API ou extensão)',
  sem_loja_magalu: 'falta o nome da loja de parceiro da Magalu',
  sem_grupos: 'nenhum grupo de destino disponível',
  sem_template: 'o template foi apagado ou está sem {LINK}',
  falha: 'falha inesperada ao montar a oferta',
});

const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

/**
 * Frases da resposta ao remetente (plano, "Esquema e contratos"). Nunca levam link, número, nome de grupo nem o texto
 * recebido: só contagens.
 */
export const RESPOSTAS = Object.freeze({
  enviadoTodos: (n) => `Enviado para ${plural(n, 'grupo', 'grupos')}.`,
  enviadoParte: (x, n) => `Enviado para ${x} de ${n} grupos.`,
  falhaEnvio: 'Não consegui enviar esse link para os grupos. O dono vai ver o motivo no painel.',
  repetida: (horas) => `Esse produto já foi enviado há ${horas} h. Não repeti.`,
  montar: 'Não consegui montar esse link agora. O dono vai ver o motivo no painel.',
  sem_dados: 'Não consegui ler os dados desse produto. Mande o link junto com o nome e o preço.',
  link_invalido: 'Não reconheci esse link. Mande o link da página do produto.',
  sem_link_de_loja: 'Não encontrei um link do Mercado Livre, Amazon, Shopee ou Magalu nessa mensagem.',
  limite: 'Muitos links em pouco tempo. Tente de novo daqui a pouco.',
  varios: (n, { enviados, repetidos, nao }) => {
    const partes = [];
    if (enviados) partes.push(plural(enviados, 'enviado', 'enviados'));
    if (repetidos) partes.push(plural(repetidos, 'repetido', 'repetidos'));
    if (nao) partes.push(plural(nao, 'não enviado', 'não enviados'));
    return `Recebi ${n} links: ${partes.join(', ')}.`;
  },
});

const lerJson = (txt, padrao) => { try { return JSON.parse(txt) ?? padrao; } catch { return padrao; } };
const listaDeTexto = (txt) => { const l = lerJson(txt, []); return Array.isArray(l) ? l.filter((x) => typeof x === 'string') : []; };
const urlDoAsin = (asin) => `https://www.amazon.com.br/dp/${asin}`;
const soCampos = (o) => Object.fromEntries(CAMPOS_OFERTA.map((k) => [k, o?.[k] ?? null]));
const statusDoCodigo = (codigo) => (DUPLICADOS.has(codigo) ? 'duplicado' : DESCARTES.has(codigo) ? 'descartado' : 'erro');
/** "menos de 1" ou o número de horas inteiras desde `ultima`. */
const horasDesde = (ultima, now) => { const h = Math.floor((now - ultima) / HORA); return h < 1 ? 'menos de 1' : String(h); };
/** Só o código ou o nome do erro (nunca a mensagem: pode trazer o número ou os valores da query). */
const nomeDoErro = (e) => String(e?.code || e?.name || 'erro').slice(0, 60);

/** Linha de `remetentes` → remetente com a lista de grupos já lida. */
function lerRemetente(r) {
  if (!r) return null;
  return { ...r, enabled: !!r.enabled, responder: !!r.responder, enviar_foto: !!r.enviar_foto, destino_jids: listaDeTexto(r.destino_jids) };
}

/** Endereço sem query nem fragmento (origin + pathname), ou o próprio texto se não for uma URL. */
const semParametros = (url) => { try { const u = new URL(url); return u.origin + u.pathname; } catch { return url; } };

/** O host da URL é um da lista (ou subdomínio dele)? */
function hostNaLista(url, lista) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return lista.some((e) => h === e || h.endsWith(`.${e}`));
  } catch { return false; }
}

/** O host é um encurtador da Amazon, da Shopee ou da Magalu (ou subdomínio dele)? */
const ehEncurtador = (url) => hostNaLista(url, ENCURTADORES);

/**
 * Chave do produto do ML pelo caminho do endereço, sem rede (a query nunca conta), com as regras do produtoMl de
 * src/envios.js (o mesmo endereço que pode ir à Central): anúncio → 'MLB123…'; catálogo (/p/MLB…) → 'CATALOGO:MLB123…'
 * (o número do catálogo não é o de um anúncio); meli.la, vitrine social, busca e o resto → null.
 */
const chaveMercadoLivre = (url) => produtoMl(url)?.chave ?? null;

/**
 * Link de loja → { url (a guardar), loja, chave (rápida, sem rede, ou null) }, ou, para a página da Magalu que não é de
 * produto, o item já decidido { url: '', loja, chave: null, status: 'descartado', codigo: 'link_invalido' }. A Amazon com
 * ASIN, a Shopee com os ids e a Magalu com o código já ficam no endereço limpo do produto (na Magalu,
 * magazineluiza.com.br sem a loja de parceiro do link e só com o seller_id válido); o ML e os encurtadores (na Magalu,
 * maga.lu, onelink.me, magalu.com e subdomínios), sem query nem fragmento; a página da Magalu sem produto (busca,
 * vitrine de magazineluiza.com.br ou magazinevoce.com.br) não guarda endereço nenhum. Nada da tag, da loja de parceiro
 * nem do rastreio de terceiro vai ao banco.
 */
function linkDeLoja(url) {
  const loja = identificar(url)?.id;
  if (!LOJAS.has(loja)) return null;
  if (loja === 'amazon') {
    const asin = extrairAsin(url);
    if (asin) return { url: urlDoAsin(asin), loja, chave: `ASIN:${asin}` };
  } else if (loja === 'shopee') {
    const ids = extrairIds(url);
    if (ids) return { url: ids.urlProduto, loja, chave: `SHOPEE:${ids.shopId}.${ids.itemId}` };
  } else if (loja === 'magalu') {
    const p = extrairProdutoMagalu(url);
    if (p) return { url: p.urlProduto, loja, chave: `MAGALU:${p.codigo}` };
    // busca ou vitrine (o caminho pode ter a loja do sócio): descartado na chegada, sem endereço e sem rede
    if (hostNaLista(url, PAGINAS_MAGALU)) return { url: '', loja, chave: null, status: 'descartado', codigo: 'link_invalido' };
    // o resto é link curto (maga.lu, onelink.me, magalu.com e subdomínios, como divulgador.magalu.com): o código está
    // no caminho; a query, que pode trazer a loja do sócio, nunca é guardada
    return { url: semParametros(url), loja, chave: null };
  } else {
    // ML: o meli.la não tem o produto no endereço (a chave só aparece depois da rede, pelo produto achado)
    return { url: semParametros(url), loja, chave: chaveMercadoLivre(url) };
  }
  return { url: ehEncurtador(url) ? semParametros(url) : url, loja, chave: null };
}

/**
 * Campos da oferta lidos do texto (lerOfertaDoTexto), mascarado antes. Se o whatsapp.js cortou o texto, a última
 * palavra (que pode ser um número pela metade, que a máscara não reconhece) sai antes. → objeto ou null (nada lido)
 */
function complementoDoTexto(texto) {
  let t = String(texto ?? '');
  if (t.length >= MAX_TEXTO_RECEBIDO) t = t.slice(0, MAX_TEXTO_RECEBIDO).replace(/\S*$/, '');
  const lido = lerOfertaDoTexto(mascararPessoais(t));
  const c = Object.fromEntries(CAMPOS_TEXTO.map((k) => [k, lido?.[k] ?? null]));
  const temAlgo = CAMPOS_TEXTO.some((k) => (k === 'freeShipping' ? c[k] === true : c[k] != null && c[k] !== ''));
  return temAlgo ? c : null;
}

/**
 * Payload com os links da Shopee por Sub_id (links_rastreio) só dos grupos que vão receber o envio: os grupos podem ter
 * mudado durante a rede. O grupo novo fica sem linha e sai com o base no envio (associado: conta como não rastreado);
 * sem nenhum grupo com associação, o mapa sai e o payload fica como antes (CA9).
 */
function comLinksDosDestinos(payload, destinos) {
  const mapa = payload?.links_rastreio;
  if (!mapa || typeof mapa !== 'object') return payload;
  const { links_rastreio: _mapa, ...semMapa } = payload;
  const dosDestinos = Object.fromEntries(destinos.filter((j) => Object.hasOwn(mapa, j)).map((j) => [j, mapa[j]]));
  return Object.values(dosDestinos).some((l) => l?.esperado) ? { ...semMapa, links_rastreio: dosDestinos } : semMapa;
}

/**
 * Remetentes. `wa`: o WhatsApp (sendText, isReady, meuJid e, no cadastro, resolverNumero e lidDe); `envios`: a fila de
 * src/envios.js (montarOferta, situacaoLink, linksRastreioShopee e, sem `acordar`, processarPendentes); `acordar`:
 * pede um tick do agendador já; `agora`: relógio (testes).
 */
export function createRemetentes({ db, wa = null, envios = null, acordar = null, agora = Date.now } = {}) {
  const respostasPorRemetente = new Map(); // remetente_id → horários das respostas da última hora (D8, em memória)
  let emAndamento = false;
  let respondendo = false;

  const remetentePorId = (id) => lerRemetente(db.prepare('SELECT * FROM remetentes WHERE id = ?').get(id));
  const grupoExiste = (jid) => !!db.prepare('SELECT 1 FROM groups WHERE jid = ?').get(jid);
  const destinosDe = (rem) => [...new Set(rem.destino_jids)].filter(grupoExiste);
  const nomeDoLog = (nome) => `Remetente: ${String(nome ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NOME_LOG) || 'sem nome'}`;
  const log = (nome, o) => addLog(db, { rule: { id: null, name: nomeDoLog(nome) }, ...o });

  function transacao(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  function pedirEnvio() {
    if (acordar) { acordar(); return; }
    envios?.processarPendentes?.().catch((e) => console.error('[remetente] fila de envios:', nomeDoErro(e)));
  }

  // ------------------------------------------------------------------------------------------- receber

  /**
   * Remetente da mensagem pelos `ids` (número e LID, D2): o que casou pelo número vale mais que o que casou pelo LID.
   * → { rem, porNumero } ou null
   */
  function quemMandou(ids) {
    const marcas = ids.map(() => '?').join(',');
    const achados = db.prepare(`SELECT * FROM remetentes WHERE jid IN (${marcas}) OR lid IN (${marcas})`).all(...ids, ...ids);
    const porNumero = achados.find((r) => ids.includes(r.jid));
    const r = porNumero ?? achados[0];
    return r ? { rem: lerRemetente(r), porNumero: !!porNumero } : null;
  }

  /** Casou pelo número e veio um LID: guarda (o Baileys pode mandar só o LID depois). LID de outro remetente fica. */
  function aprenderLid(rem, ids) {
    const lid = ids.find((i) => i.endsWith('@lid'));
    if (!lid || rem.lid === lid) return;
    db.prepare('UPDATE remetentes SET lid = ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM remetentes o WHERE o.lid = ? AND o.id != ?)')
      .run(lid, rem.id, lid, rem.id);
  }

  /**
   * Mensagem privada nova ({ ids, texto, msgId, ts }, do ouvinte onPrivada do whatsapp.js). Síncrono e sem rede (D3):
   * grava um item `recebido` por link de loja (até MAX_URLS, sem repetir URL nem produto), respeitando o limite por
   * hora (D7), e acorda o agendador. Mensagem com link, mas nenhum de loja, vira um item descartado (para a resposta).
   * Nunca lança. → itens gravados
   */
  function receber(msg) {
    try {
      if (!msg || typeof msg !== 'object' || msg.fromMe === true) return 0;
      const ids = Array.isArray(msg.ids) ? [...new Set(msg.ids.filter((i) => typeof i === 'string' && JID_PRIVADO.test(i)))].slice(0, MAX_IDS) : [];
      const msgId = typeof msg.msgId === 'string' ? msg.msgId : '';
      const texto = typeof msg.texto === 'string' ? msg.texto : '';
      if (!ids.length || !msgId || msgId.length > MAX_MSG_ID || !texto) return 0;
      const meu = wa?.meuJid?.();
      if (meu && ids.includes(meu)) return 0; // o próprio número conectado nunca é remetente
      const achado = quemMandou(ids);
      if (!achado || !achado.rem.enabled) return 0; // silêncio total: sem item, log nem resposta (CA2)
      const { rem } = achado;
      if (achado.porNumero) aprenderLid(rem, ids);

      const agoraMs = agora();
      const ts = Number.isFinite(msg.ts) && msg.ts > 0 ? Math.min(Math.floor(msg.ts), agoraMs) : agoraMs;
      if (agoraMs - ts > PARADO_MAX) return 0; // chegou com o programa fora do ar há mais de 2 h (P10)

      // URLs do texto como veio (antes da máscara, que apagaria um ASIN só de dígitos); só as das lojas de LOJAS
      const urls = extrairUrls(texto.slice(0, MAX_TEXTO_RECEBIDO)).slice(0, MAX_URLS);
      if (!urls.length) return 0; // sem link: sem item nem resposta (CA8)
      const vistos = new Set();
      const links = [];
      for (const url of urls) {
        const l = linkDeLoja(url);
        if (!l || vistos.has(l.url) || (l.chave && vistos.has(l.chave))) continue;
        vistos.add(l.url);
        if (l.chave) vistos.add(l.chave);
        links.push(l);
      }
      // o texto só completa os dados quando fala de um produto só (P11)
      const complemento = links.length === 1 ? complementoDoTexto(texto) : null;
      const linhas = links.length
        ? links.map((l) => (l.status ? { ...l, complemento: null } : { ...l, status: 'recebido', codigo: null, complemento }))
        : [{ url: '', loja: null, chave: null, status: 'descartado', codigo: 'sem_link_de_loja', complemento: null }];

      const decididos = [];
      const gravados = transacao(() => {
        // o limite conta pela chegada (chegou_em), não pelo ts da mensagem: a atrasada (programa fora do ar) também
        // conta. Item de antes da coluna: pelo ts.
        const usados = db.prepare(`SELECT COUNT(*) AS n FROM remetente_itens WHERE remetente_id = ? AND COALESCE(chegou_em, ts) >= ?
          AND COALESCE(codigo, '') != 'limite'`).get(rem.id, agoraMs - HORA).n;
        let livres = rem.max_por_hora - usados;
        const inserir = db.prepare(`INSERT OR IGNORE INTO remetente_itens (remetente_id, remetente_nome, msg_id, ts, chegou_em, url, loja,
          complemento, status, codigo, motivo, chave, decidido_em, qtd_links) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
        let n = 0;
        for (const [pos, l] of linhas.entries()) {
          if (livres <= 0) {
            // uma linha 'limite' por hora (D7), com quantos links da mensagem ela representa; o resto é ignorado sem gravar nada
            const jaAvisou = db.prepare("SELECT 1 FROM remetente_itens WHERE remetente_id = ? AND codigo = 'limite' AND decidido_em > ?")
              .get(rem.id, agoraMs - HORA);
            if (!jaAvisou && inserir.run(rem.id, rem.nome, msgId, ts, agoraMs, '', null, null, 'descartado', 'limite', MOTIVOS.limite, null, agoraMs,
              links.length ? linhas.length - pos : null).changes) {
              n++; decididos.push('limite');
            }
            break;
          }
          const decidido = l.status !== 'recebido';
          const { changes } = inserir.run(rem.id, rem.nome, msgId, ts, agoraMs, l.url, l.loja, l.complemento ? JSON.stringify(l.complemento) : null,
            l.status, l.codigo, decidido ? MOTIVOS[l.codigo] : null, l.chave, decidido ? agoraMs : null, null);
          if (changes) { n++; livres--; if (decidido) decididos.push(l.codigo); }
        }
        return n;
      });
      for (const codigo of decididos) {
        const message = codigo === 'limite'
          ? `Descartada: ${MOTIVOS.limite} (${rem.max_por_hora}). Os próximos links são ignorados até a hora seguinte.`
          : `Descartada: ${MOTIVOS[codigo]}`;
        log(rem.nome, { level: 'aviso', message });
      }
      if (gravados) pedirEnvio();
      return gravados;
    } catch (e) {
      console.error('[remetente] receber:', nomeDoErro(e));
      return 0;
    }
  }

  // ------------------------------------------------------------------------------------------- decidir

  /** Última vez (decidido_em) que o mesmo produto saiu por este remetente dentro de `dedupe_horas`, ou null. */
  function ultimaEnviada(rem, chave, now, excetoId) {
    if (!(rem.dedupe_horas > 0) || !chave) return null;
    return db.prepare(`SELECT MAX(decidido_em) AS em FROM remetente_itens WHERE remetente_id = ? AND chave = ? AND decidido_em > ?
      AND id != ? AND ${CONTA_COMO_ENVIADO}`).get(rem.id, chave, now - rem.dedupe_horas * HORA, excetoId).em ?? null;
  }

  /** Repetição (D6): o mesmo produto já saiu nesta mensagem, ou dentro de "Horas sem repetir". → { codigo, motivo } ou null */
  function repeticao(rem, item, chave, now) {
    if (!chave) return null;
    const naMensagem = db.prepare(`SELECT 1 FROM remetente_itens WHERE remetente_id = ? AND msg_id = ? AND id != ? AND chave = ?
      AND status = 'enviado'`).get(item.remetente_id, item.msg_id, item.id, chave);
    if (naMensagem) return { codigo: 'mesma_mensagem', motivo: MOTIVOS.mesma_mensagem };
    const ultima = ultimaEnviada(rem, chave, now, item.id);
    return ultima != null ? { codigo: 'repetida', motivo: MOTIVOS.repetida(horasDesde(ultima, now)) } : null;
  }

  /** Template do remetente para o envio: existe e tem {LINK}. */
  function templateOk(id) {
    const tpl = Number.isInteger(id) ? db.prepare('SELECT body FROM templates WHERE id = ?').get(id) : null;
    return !!tpl && String(tpl.body).includes('{LINK}');
  }

  /** Linha em `envios` com o payload de envios.montarOferta e a foto do remetente. Chamar dentro de transação. → id */
  function gravarEnvio(payload, rem, destinos, now) {
    const p = { ...payload, enviar_foto: rem.enviar_foto };
    return Number(db.prepare(`INSERT INTO envios (tipo, payload, group_jids, quando, repetir, status, next_run_at, user_id, created_at)
      VALUES ('oferta', ?, ?, 'agora', NULL, 'pendente', ?, NULL, ?)`).run(JSON.stringify(p), JSON.stringify(destinos), now, now).lastInsertRowid);
  }

  const DETALHE = { api: 'com os dados da loja', 'api+texto': 'com os dados da loja e do texto do remetente', texto: 'com o texto do remetente', manual: 'com ajustes' };

  /**
   * Fecha o item (sai de 'processando') e registra no log com o nome do remetente. Os campos lidos do texto
   * (`complemento`) só servem à montagem: saem do banco aqui.
   */
  function decidir(item, rem, { status, codigo = null, motivo = null, chave = null, oferta = null, fonte = null, envioId = null, nota = null }, now) {
    db.prepare(`UPDATE remetente_itens SET status = ?, codigo = ?, motivo = ?, chave = COALESCE(?, chave), oferta = COALESCE(?, oferta),
      fonte_dados = COALESCE(?, fonte_dados), envio_id = COALESCE(?, envio_id), decidido_em = ?, complemento = NULL WHERE id = ?`)
      .run(status, codigo, motivo, chave, oferta ? JSON.stringify(soCampos(oferta)) : null, fonte, envioId, now, item.id);
    const linha = {
      enviado: ['ok', `Recebida e posta na fila de envios ${DETALHE[fonte] || ''}`.trim()],
      duplicado: ['aviso', `Descartada: ${motivo}`],
      descartado: ['aviso', `Descartada: ${motivo}`],
      erro: ['erro', `Não saiu: ${motivo}`],
    }[status];
    if (linha) log(rem?.nome ?? item.remetente_nome, { level: linha[0], offer_title: oferta?.title || null, message: nota ? `${linha[1]}. ${nota}` : linha[1] });
  }

  const porCodigo = (codigo, extra = {}) => ({ status: statusDoCodigo(codigo), codigo, motivo: MOTIVOS[codigo], ...extra });

  /** Um item já travado em 'processando'. */
  async function processarItem(item, now) {
    const rem = remetentePorId(item.remetente_id);
    if (!rem) return decidir(item, null, porCodigo('apagado'), now);
    if (!rem.enabled) return decidir(item, rem, porCodigo('desligado'), now);
    if (now - item.ts > PARADO_MAX) return decidir(item, rem, porCodigo('expirado'), now);
    // sem rede: repetição pela chave rápida, afiliação do dono (D5), template e grupos
    const antes = repeticao(rem, item, item.chave, now);
    if (antes) return decidir(item, rem, { status: 'duplicado', ...antes }, now);
    const bloqueio = envios?.situacaoLink ? envios.situacaoLink(item.loja, { tag_id: rem.tag_id }) : 'falha';
    if (bloqueio) return decidir(item, rem, porCodigo(MOTIVOS[bloqueio] ? bloqueio : 'falha'), now);
    if (!templateOk(rem.template_id)) return decidir(item, rem, porCodigo('sem_template'), now);
    const destinosAntes = destinosDe(rem);
    if (!destinosAntes.length) return decidir(item, rem, porCodigo('sem_grupos'), now);

    // rede: leitura da loja e link do dono, pela montagem do Disparo manual (D4)
    let payload;
    try {
      payload = await envios.montarOferta({ url: item.url, template_id: rem.template_id, tag_id: rem.tag_id }, {
        origem: { tipo: 'remetente', remetente_id: rem.id, nome: rem.nome },
        complemento: lerJson(item.complemento, null),
        exigirPreco: true,
      });
      // Shopee com Sub_id por bloco (dashboard-ganhos, CA2; achado R1 do merge): os links saem agora, como no Disparo
      // manual e no "Enviar" do catálogo, com o base como fallback, para os grupos lidos antes da rede. O teto de links
      // por hora e a parada no primeiro motivo ficam em linksRastreioShopee. Sem a função, sai só o base.
      if (payload?.loja === 'shopee' && typeof envios.linksRastreioShopee === 'function') {
        const porGrupo = await envios.linksRastreioShopee({ urlProduto: payload.url, jids: destinosAntes, base: payload.link_afiliado });
        if (Object.values(porGrupo).some((l) => l.esperado)) payload = { ...payload, links_rastreio: porGrupo };
      }
    } catch (e) {
      if (e?.codigo === 'sem_dados' || e?.codigo === 'link_invalido') return decidir(item, rem, porCodigo(e.codigo), now);
      return decidir(item, rem, porCodigo('falha', { nota: semNumero(e) }), now);
    }
    // a chave do produto achado: no ML, a do endereço do produto (a key da leitura é o meli.la recebido, que muda a cada
    // afiliado); na Amazon, na Shopee e na Magalu, a da leitura (ASIN, ids, código)
    const chave = (item.loja === 'mercadolivre' ? chaveMercadoLivre(payload?.url) : null)
      || (typeof payload?.offer?.key === 'string' && payload.offer.key ? payload.offer.key : item.chave);
    const fonte = payload.fonte_dados || 'api';

    // o remetente pode ter mudado durante a rede; a repetição e o INSERT na mesma transação (D6)
    let envioId = null;
    transacao(() => {
      const atual = remetentePorId(item.remetente_id);
      if (!atual) return decidir(item, null, porCodigo('apagado'), now);
      if (!atual.enabled) return decidir(item, atual, porCodigo('desligado'), now);
      const rep = repeticao(atual, item, chave, now);
      if (rep) return decidir(item, atual, { status: 'duplicado', ...rep, chave, oferta: payload.offer, fonte }, now);
      const destinos = destinosDe(atual);
      if (!destinos.length) return decidir(item, atual, porCodigo('sem_grupos', { chave, oferta: payload.offer, fonte }), now);
      envioId = gravarEnvio(comLinksDosDestinos(payload, destinos), atual, destinos, now);
      return decidir(item, atual, { status: 'enviado', chave, oferta: payload.offer, fonte, envioId }, now);
    });
    if (envioId != null) pedirEnvio();
    return envioId;
  }

  /**
   * No tick: decide os itens 'recebido', um de cada vez (trava atômica recebido → processando, changes === 1). A passada
   * para de pegar itens depois de TEMPO_LOTE (cada item pode levar segundos de rede); o que sobrou fica para o próximo
   * tick. O primeiro item sempre roda. A falha de um item vira 'erro' nele e não para os outros. → quantos foram tratados
   */
  async function processarPendentes(now = agora()) {
    if (emAndamento) return 0;
    emAndamento = true;
    let tratados = 0;
    try {
      const itens = db.prepare("SELECT * FROM remetente_itens WHERE status = 'recebido' ORDER BY ts, id LIMIT ?").all(LOTE);
      const inicio = agora();
      for (const item of itens) {
        if (tratados > 0 && agora() - inicio >= TEMPO_LOTE) break;
        if (db.prepare("UPDATE remetente_itens SET status = 'processando' WHERE id = ? AND status = 'recebido'").run(item.id).changes !== 1) continue;
        try { await processarItem(item, now); } catch (e) {
          console.error('[remetente] item:', nomeDoErro(e));
          try { decidir(item, remetentePorId(item.remetente_id), porCodigo('falha'), now); } catch { /* fica para recuperar() */ }
        }
        tratados++;
      }
    } finally { emAndamento = false; }
    return tratados;
  }

  // ------------------------------------------------------------------------------------------- responder

  /** Teto de respostas por hora do remetente (D8). Conta a resposta quando há vaga. → true se pode responder */
  function vagaDeResposta(remId, now) {
    const lista = (respostasPorRemetente.get(remId) ?? []).filter((t) => now - t < HORA);
    if (lista.length >= MAX_RESPOSTAS_HORA) { respostasPorRemetente.set(remId, lista); return false; }
    lista.push(now);
    respostasPorRemetente.set(remId, lista);
    if (respostasPorRemetente.size > 1000) respostasPorRemetente.delete(respostasPorRemetente.keys().next().value);
    return true;
  }

  /** Grupos do envio e quantos receberam (em qualquer ocorrência). */
  function resultadoDoEnvio(envioId) {
    const e = Number.isInteger(envioId) ? db.prepare('SELECT group_jids FROM envios WHERE id = ?').get(envioId) : null;
    const total = e ? listaDeTexto(e.group_jids).length : 0;
    const ok = e ? db.prepare('SELECT COUNT(DISTINCT jid) AS n FROM envio_resultados WHERE envio_id = ? AND ok = 1').get(envioId).n : 0;
    return { total, ok };
  }

  /** Frase da resposta a uma mensagem já decidida (RESPOSTAS), ou null quando ela não pede resposta. */
  function textoDaResposta(itens) {
    if (!itens.length || itens.some((i) => SEM_RESPOSTA.has(i.codigo))) return null;
    const enviado = (i) => i.status === 'enviado' && resultadoDoEnvio(i.envio_id).ok > 0;
    if (itens.length > 1) {
      // a linha 'limite' vale pelos links da mensagem que ela cortou
      const links = itens.reduce((n, i) => n + (i.codigo === 'limite' && i.qtd_links > 0 ? i.qtd_links : 1), 0);
      const enviados = itens.filter(enviado).length;
      const repetidos = itens.filter((i) => i.status === 'duplicado').length;
      return RESPOSTAS.varios(links, { enviados, repetidos, nao: links - enviados - repetidos });
    }
    const [i] = itens;
    if (i.status === 'enviado') {
      const { total, ok } = resultadoDoEnvio(i.envio_id);
      if (ok > 0 && ok >= total) return RESPOSTAS.enviadoTodos(total);
      return ok > 0 ? RESPOSTAS.enviadoParte(ok, total) : RESPOSTAS.falhaEnvio;
    }
    if (i.status === 'duplicado') return RESPOSTAS.repetida(/há (menos de 1|\d+) h/.exec(String(i.motivo ?? ''))?.[1] ?? 'menos de 1');
    if (['sem_dados', 'link_invalido', 'sem_link_de_loja', 'limite'].includes(i.codigo)) return RESPOSTAS[i.codigo];
    return RESPOSTAS.montar; // bloqueio de afiliação, sem grupos, sem template, falha
  }

  /** Marca a mensagem como respondida (com ou sem envio). → true se foi esta chamada que marcou */
  const marcarRespondida = (remId, msgId, now) => db.prepare(`UPDATE remetente_itens SET respondido_em = ?
    WHERE remetente_id = ? AND msg_id = ? AND respondido_em IS NULL`).run(now, remId, msgId).changes > 0;

  /**
   * No tick (D8): para cada mensagem com todos os itens decididos e nenhum envio dela ativo, uma resposta ao remetente
   * por wa.sendText, fora da fila (como os avisos). Marca antes de enviar (no máximo uma resposta, nunca de novo).
   * Sem enviar, só marca: "responder" desligado, remetente desligado ou excluído, mensagem que não pede resposta, teto
   * de 20 por hora, ou pronta há mais de 2 h (WhatsApp ou programa fora do ar). WhatsApp fora há menos tempo: espera.
   * A falha do envio vai ao log como aviso (sem número). → quantas respostas foram enviadas
   */
  async function responderPendentes(now = agora()) {
    if (respondendo) return 0;
    respondendo = true;
    let enviadas = 0;
    try {
      // mensagem esquecida (envio pausado e nunca retomado): deixa de esperar
      db.prepare(`UPDATE remetente_itens SET respondido_em = ? WHERE respondido_em IS NULL AND ts < ?
        AND status NOT IN (${ATIVOS.map(() => '?').join(',')})`).run(now, now - RESPOSTA_MAX_DIAS * DIA, ...ATIVOS);
      const prontas = db.prepare(`SELECT i.remetente_id, i.msg_id, MIN(i.id) AS primeiro FROM remetente_itens i
        WHERE i.respondido_em IS NULL AND NOT EXISTS (SELECT 1 FROM remetente_itens o WHERE o.remetente_id = i.remetente_id
          AND o.msg_id = i.msg_id AND (o.status IN ('recebido', 'processando') OR (o.status = 'enviado'
          AND EXISTS (SELECT 1 FROM envios v WHERE v.id = o.envio_id AND v.status IN (${LISTA_ENVIO_ATIVO})))))
        GROUP BY i.remetente_id, i.msg_id ORDER BY primeiro LIMIT ?`).all(LOTE_RESPOSTAS);
      for (const m of prontas) {
        try {
          const itens = db.prepare('SELECT * FROM remetente_itens WHERE remetente_id = ? AND msg_id = ? ORDER BY id').all(m.remetente_id, m.msg_id);
          const rem = remetentePorId(m.remetente_id);
          const texto = rem?.enabled && rem.responder ? textoDaResposta(itens) : null;
          const fins = itens.flatMap((i) => [i.decidido_em, i.envio_id ? db.prepare('SELECT last_run_at FROM envios WHERE id = ?').get(i.envio_id)?.last_run_at : null]);
          const prontaEm = Math.max(...fins.filter(Number.isFinite), 0);
          if (!texto || now - prontaEm > PARADO_MAX) { marcarRespondida(m.remetente_id, m.msg_id, now); continue; }
          if (!wa?.isReady?.()) continue; // espera o WhatsApp voltar (até 2 h)
          if (!marcarRespondida(m.remetente_id, m.msg_id, now)) continue;
          if (!vagaDeResposta(rem.id, now)) continue; // passou do teto: fica marcada, sem enviar
          try {
            await wa.sendText(rem.jid, texto);
            enviadas++;
          } catch (e) {
            log(rem.nome, { level: 'aviso', message: `Não consegui responder ao remetente: ${semNumero(e)}` });
          }
        } catch (e) {
          console.error('[remetente] resposta:', nomeDoErro(e));
        }
      }
    } finally { respondendo = false; }
    return enviadas;
  }

  // ------------------------------------------------------------------------------------------- manutenção

  /** Ao iniciar o serviço: o que ficou 'processando' quando ele caiu volta a 'recebido'. → quantos */
  function recuperar() {
    return Number(db.prepare("UPDATE remetente_itens SET status = 'recebido' WHERE status = 'processando'").run().changes);
  }

  /**
   * Retenção: apaga itens decididos há mais de `dias` (0 = não apaga), menos os 'enviado' que ainda contam para
   * "Horas sem repetir" do remetente. → { itens }
   */
  function limpar(dias, now = agora()) {
    const d = Number(dias);
    if (!(d > 0)) return { itens: 0 };
    const itens = db.prepare(`DELETE FROM remetente_itens WHERE status NOT IN (${ATIVOS.map(() => '?').join(',')})
      AND COALESCE(decidido_em, ts) < ?
      AND NOT (status = 'enviado' AND decidido_em > ? - ? * COALESCE((SELECT r.dedupe_horas FROM remetentes r WHERE r.id = remetente_itens.remetente_id), 0))`)
      .run(...ATIVOS, now - d * DIA, now, HORA).changes;
    return { itens: Number(itens) };
  }

  // ------------------------------------------------------------------------------------------- cadastro e consulta

  function idValido(v, msg = MSG.naoEncontrado) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new ErroRemetente(404, msg);
    return n;
  }

  function exigirRemetente(id) {
    const r = remetentePorId(idValido(id));
    if (!r) throw new ErroRemetente(404, MSG.naoEncontrado);
    return r;
  }

  function lerNome(v) {
    const nome = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim() : '';
    if (!nome) throw new ErroRemetente(400, MSG.semNome);
    if (nome.length > MAX_NOME) throw new ErroRemetente(400, MSG.nomeLongo);
    if ((nome.match(/\d/g) || []).length > MAX_DIGITOS_NOME) throw new ErroRemetente(400, MSG.nomeComNumero);
    return nome;
  }

  function lerGrupos(lista) {
    if (!Array.isArray(lista) || !lista.length) throw new ErroRemetente(400, MSG.semGrupos);
    if (lista.length > MAX_GRUPOS) throw new ErroRemetente(400, MSG.muitosGrupos);
    if (lista.some((j) => typeof j !== 'string' || !j)) throw new ErroRemetente(400, MSG.gruposInvalidos);
    const jids = [...new Set(lista)];
    if (jids.some((j) => !grupoExiste(j))) throw new ErroRemetente(400, MSG.grupoSumiu);
    return jids;
  }

  function lerTemplate(v) {
    const n = inteiroDe(v);
    const tpl = Number.isInteger(n) ? db.prepare('SELECT body FROM templates WHERE id = ?').get(n) : null;
    if (!tpl) throw new ErroRemetente(400, MSG.semTemplate);
    if (!String(tpl.body).includes('{LINK}')) throw new ErroRemetente(400, MSG.templateSemLink);
    return n;
  }

  /** null = a etiqueta padrão (a primeira por nome, como no Disparo manual). */
  function lerEtiqueta(v) {
    if (v == null || v === '') return null;
    const n = inteiroDe(v);
    if (!Number.isInteger(n) || !db.prepare('SELECT 1 FROM tags WHERE id = ?').get(n)) throw new ErroRemetente(400, MSG.semEtiqueta);
    return n;
  }

  function lerInteiro(v, padrao, min, max, msg) {
    if (v == null || v === '') return padrao;
    const n = inteiroDe(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new ErroRemetente(400, msg);
    return n;
  }

  function lerBool(v, padrao, campo) {
    if (v == null) return padrao;
    if (typeof v !== 'boolean') throw new ErroRemetente(400, MSG.bool(campo));
    return v;
  }

  /**
   * Corpo do POST/PUT → campos validados, sem rede. No PUT (`atual`), campo ausente mantém o atual e número vazio
   * mantém o número salvo (`digitos` null). Tudo é validado antes da consulta ao WhatsApp, que gasta o freio.
   */
  function validarCadastro(corpo, atual) {
    const b = corpo && typeof corpo === 'object' && !Array.isArray(corpo) ? corpo : {};
    const tem = (k) => Object.hasOwn(b, k);
    const campo = (k, padrao) => (tem(k) ? b[k] : padrao);
    const nome = lerNome(campo('nome', atual?.nome));
    const bruto = campo('numero', undefined);
    const vazio = bruto == null || (typeof bruto === 'string' && !bruto.trim());
    let digitos = null;
    if (!vazio || !atual) {
      digitos = digitosDoNumero(bruto);
      if (!digitos) throw new ErroRemetente(400, MSG.numero);
    }
    return {
      nome, digitos,
      destino_jids: lerGrupos(campo('destino_jids', atual?.destino_jids)),
      template_id: lerTemplate(campo('template_id', atual?.template_id)),
      tag_id: lerEtiqueta(campo('tag_id', atual?.tag_id ?? null)),
      max_por_hora: lerInteiro(campo('max_por_hora', atual?.max_por_hora), 10, 1, MAX_POR_HORA, MSG.porHora),
      dedupe_horas: lerInteiro(campo('dedupe_horas', atual?.dedupe_horas), 24, 0, MAX_DEDUPE_HORAS, MSG.dedupe),
      enabled: lerBool(campo('enabled', undefined), atual ? atual.enabled : true, 'Ativo'),
      enviar_foto: lerBool(campo('enviar_foto', undefined), atual ? atual.enviar_foto : true, 'Enviar a foto'),
      responder: lerBool(campo('responder', undefined), atual ? atual.responder : true, 'Responder ao remetente'),
    };
  }

  const meuNumero = () => { try { return wa?.meuJid?.() || null; } catch { return null; } };

  /** Número de outro remetente: 409 com o nome dele (nunca o número). */
  function exigirLivre(jid, idAtual) {
    const outro = db.prepare('SELECT nome FROM remetentes WHERE jid = ? AND id IS NOT ?').get(jid, idAtual ?? null);
    if (outro) throw new ErroRemetente(409, MSG.duplicado(outro.nome));
  }

  const lidLivre = (lid, idAtual) => !db.prepare('SELECT 1 FROM remetentes WHERE lid = ? AND id IS NOT ?').get(lid, idAtual ?? null);

  /**
   * DDD + número → JID canônico conferido no WhatsApp (wa.resolverNumero resolve o 9º dígito). Recusa o número conectado
   * (antes da consulta, pelo digitado, e depois, pelo canônico) e o de outro remetente. `antesDeConsultar()` roda logo
   * antes de perguntar ao WhatsApp: é o freio de consultas e pode lançar. Nenhuma mensagem repete o número.
   */
  async function conferirNumero(digitos, idAtual, antesDeConsultar) {
    const meu = meuNumero();
    if (meu && meu === `55${digitos}@s.whatsapp.net`) throw new ErroRemetente(400, MSG.conectado);
    if (typeof wa?.resolverNumero !== 'function') throw new ErroRemetente(400, MSG.semConferir);
    antesDeConsultar();
    let r;
    try { r = await wa.resolverNumero(`55${digitos}`); } catch { throw new ErroRemetente(400, MSG.semConferir); }
    if (!r?.existe || typeof r.jid !== 'string' || !JID_NUMERO.test(r.jid)) throw new ErroRemetente(400, MSG.foraDoWhats);
    if (meu && r.jid === meu) throw new ErroRemetente(400, MSG.conectado);
    exigirLivre(r.jid, idAtual);
    return r.jid;
  }

  /**
   * LID do número pelo mapa do Baileys (wa.lidDe, esforço): null em falha ou no modo simulado. Se ele já é de outro
   * remetente, quem grava (na transação) descarta.
   */
  async function lidDoNumero(jid) {
    let lid = null;
    try { lid = await wa?.lidDe?.(jid); } catch { lid = null; }
    return typeof lid === 'string' && JID_LID.test(lid) ? lid : null;
  }

  /** A consulta extra do LID (sem troca de número) só acontece se o freio deixar; ela nunca impede o salvar. */
  const freioDeixa = (antesDeConsultar) => { try { antesDeConsultar(); return true; } catch { return false; } };

  const COLUNAS = ['nome', 'jid', 'lid', 'enabled', 'destino_jids', 'template_id', 'tag_id', 'enviar_foto', 'max_por_hora', 'dedupe_horas', 'responder'];
  const valoresDe = (v) => COLUNAS.map((c) => {
    const x = v[c];
    if (Array.isArray(x)) return JSON.stringify(x);
    if (typeof x === 'boolean') return x ? 1 : 0;
    return x ?? null;
  });

  /**
   * POST /api/remetentes (CA1). O número é conferido no WhatsApp e o LID pedido no cadastro (esforço). → { id }
   * O id nunca repete o de um remetente excluído: os itens dele ficam no Histórico com o nome e não podem passar a contar
   * para outro (repetição, limite por hora, nome no Histórico).
   */
  async function criar(corpo, { antesDeConsultar = () => {} } = {}) {
    const v = validarCadastro(corpo, null);
    const jid = await conferirNumero(v.digitos, null, antesDeConsultar);
    const lid = await lidDoNumero(jid);
    const now = agora();
    const id = transacao(() => {
      exigirLivre(jid, null); // outro cadastro do mesmo número pode ter entrado durante a consulta
      const novoId = Number(db.prepare(`SELECT MAX(COALESCE((SELECT MAX(id) FROM remetentes), 0),
        COALESCE((SELECT MAX(remetente_id) FROM remetente_itens), 0)) + 1 AS id`).get().id);
      const linha = { ...v, jid, lid: lid && lidLivre(lid, null) ? lid : null };
      db.prepare(`INSERT INTO remetentes (id, ${COLUNAS.join(', ')}, created_at, updated_at) VALUES (?, ${COLUNAS.map(() => '?').join(', ')}, ?, ?)`)
        .run(novoId, ...valoresDe(linha), now, now);
      return novoId;
    });
    return { id };
  }

  /**
   * PUT /api/remetentes/:id. Número vazio mantém o salvo; número novo é conferido como no cadastro e o LID do número
   * antigo nunca fica (senão o número antigo continuaria mandando links pelo LID). Sem LID guardado, salvar pede o LID
   * de novo (risco do plano), se o freio deixar. → { id }
   */
  async function atualizar(id, corpo, { antesDeConsultar = () => {} } = {}) {
    const atual = exigirRemetente(id);
    const v = validarCadastro(corpo, atual);
    let jid = atual.jid;
    let lid = null;
    if (v.digitos) {
      jid = await conferirNumero(v.digitos, atual.id, antesDeConsultar);
      lid = await lidDoNumero(jid);
    } else if (!atual.lid && freioDeixa(antesDeConsultar)) {
      lid = await lidDoNumero(jid);
    }
    transacao(() => {
      const agoraRow = remetentePorId(atual.id); // pode ter sido excluído ou aprendido o LID durante a consulta
      if (!agoraRow) throw new ErroRemetente(404, MSG.naoEncontrado);
      exigirLivre(jid, atual.id);
      const novo = lid && lidLivre(lid, atual.id) ? lid : null;
      const linha = { ...v, jid, lid: jid === agoraRow.jid ? (novo ?? agoraRow.lid) : novo };
      db.prepare(`UPDATE remetentes SET ${COLUNAS.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...valoresDe(linha), agora(), atual.id);
    });
    return { id: atual.id };
  }

  /**
   * DELETE /api/remetentes/:id (CA9): apaga o número e o LID. Os itens ficam, com o último nome do remetente (o Histórico
   * mostra o nome). Item ainda na fila é descartado no tick ('apagado'); envio já criado segue na fila de envios. → { ok }
   */
  function apagar(id) {
    const r = exigirRemetente(id);
    transacao(() => {
      db.prepare('UPDATE remetente_itens SET remetente_nome = ? WHERE remetente_id = ?').run(r.nome, r.id);
      db.prepare('DELETE FROM remetentes WHERE id = ?').run(r.id);
    });
    respostasPorRemetente.delete(r.id);
    return { ok: true };
  }

  /** POST /api/remetentes/:id/enabled. → { ok, enabled } */
  function ativar(id, enabled) {
    const r = exigirRemetente(id);
    if (typeof enabled !== 'boolean') throw new ErroRemetente(400, MSG.bool('Ativo'));
    db.prepare('UPDATE remetentes SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, agora(), r.id);
    return { ok: true, enabled };
  }

  /** Nome do grupo que sumiu de `groups`: o do último envio para ele, se houver. */
  const nomeAntigo = (jid) => {
    const n = db.prepare("SELECT group_name FROM envio_resultados WHERE jid = ? AND COALESCE(group_name, '') != '' ORDER BY id DESC LIMIT 1").get(jid)?.group_name;
    return n ? String(n).slice(0, MAX_NOME_GRUPO) : null;
  };

  /**
   * Último link barrado por falta de afiliação que ainda não sairia (CA11). Regra do dono: nada de aviso sobre
   * configuração que ele já conhece, só o que bloqueia de verdade. Por loja, vale o item mais recente que chegou à
   * checagem (saiu ou foi barrado): se foi barrado e a checagem de agora (envios.situacaoLink, sem rede) ainda barra, é
   * o problema, com a frase do bloqueio de agora. Entre as lojas, a barrada mais recente. Sem a fila, o item basta.
   */
  function afiliacaoBarrada(r) {
    const codigos = Object.keys(AFILIACAO);
    const ultimo = db.prepare(`SELECT codigo, decidido_em FROM remetente_itens WHERE remetente_id = ? AND loja = ?
      AND (status = 'enviado' OR codigo IN (${codigos.map(() => '?').join(',')})) ORDER BY decidido_em DESC, id DESC LIMIT 1`);
    const barrados = [];
    for (const loja of LOJAS) {
      const u = ultimo.get(r.id, loja, ...codigos);
      if (u && AFILIACAO[u.codigo]) barrados.push({ loja, codigo: u.codigo, em: Number(u.decidido_em) || 0 });
    }
    barrados.sort((a, b) => b.em - a.em);
    for (const b of barrados) {
      let codigo = b.codigo;
      if (typeof envios?.situacaoLink === 'function') {
        try { codigo = envios.situacaoLink(b.loja, { tag_id: r.tag_id }); } catch { codigo = b.codigo; }
      }
      const p = AFILIACAO[codigo];
      if (p && p.loja === b.loja) return { nivel: 'aviso', texto: p.texto, conexao: p.conexao };
    }
    return null;
  }

  /** Problema do cartão ({ nivel, texto, conexao }, só nomes de grupo), ou null. */
  function problemaDe(r, nomes, tpl, etiquetas) {
    const erro = (texto) => ({ nivel: 'erro', texto, conexao: null });
    const sumiram = [...new Set(r.destino_jids)].filter((j) => !nomes.has(j));
    if (sumiram.length === 1) {
      const nome = nomeAntigo(sumiram[0]);
      return erro(nome ? PROBLEMAS.grupoSumiu(nome) : PROBLEMAS.umGrupoSumiu);
    }
    if (sumiram.length > 1) return erro(PROBLEMAS.gruposSumiram(sumiram.length));
    if (!tpl) return erro(PROBLEMAS.semTemplate);
    if (!String(tpl.body).includes('{LINK}')) return erro(PROBLEMAS.templateSemLink);
    if (r.tag_id != null && !etiquetas.has(r.tag_id)) return erro(PROBLEMAS.semEtiqueta);
    return r.enabled ? afiliacaoBarrada(r) : null;
  }

  /**
   * GET /api/remetentes (CA11). O número só mascarado (mascararNumero); nunca `jid` nem `lid`. Contadores de 24 h por
   * remetente e o horário do último link; os totais contam todos os itens das 24 h (inclusive de remetente excluído,
   * que o Histórico mostra). "Enviados" só conta o que chegou a algum grupo ou ainda está na fila (CONTA_COMO_ENVIADO).
   */
  function listar(now = agora()) {
    const nomes = new Map(db.prepare('SELECT jid, name FROM groups').all().map((g) => [g.jid, g.name]));
    const templates = new Map(db.prepare('SELECT id, name, body FROM templates').all().map((t) => [t.id, t]));
    const etiquetas = new Map(db.prepare('SELECT id, name FROM tags').all().map((t) => [t.id, t.name]));
    const desde = now - DIA;
    const contagem = `SUM(ts >= ?) AS recebidos, SUM(decidido_em >= ? AND (${CONTA_COMO_ENVIADO})) AS enviados,
      SUM(status = 'duplicado' AND decidido_em >= ?) AS repetidos, SUM(status = 'descartado' AND decidido_em >= ?) AS descartados,
      SUM(status = 'erro' AND decidido_em >= ?) AS com_erro`;
    const args = [desde, desde, desde, desde, desde];
    const contadores = (c) => Object.fromEntries(CONTADORES.map((k) => [k, Number(c?.[k]) || 0]));
    const porRemetente = new Map(db.prepare(`SELECT remetente_id, ${contagem}, MAX(ts) AS ultimo_em FROM remetente_itens GROUP BY remetente_id`)
      .all(...args).map((c) => [c.remetente_id, { contadores_24h: contadores(c), ultimo_em: c.ultimo_em ?? null }]));
    const totais = contadores(db.prepare(`SELECT ${contagem} FROM remetente_itens`).get(...args));
    const remetentes = db.prepare('SELECT * FROM remetentes ORDER BY id').all().map(lerRemetente).map((r) => {
      const c = porRemetente.get(r.id) ?? { contadores_24h: contadores(null), ultimo_em: null };
      const tpl = templates.get(r.template_id) ?? null;
      return {
        id: r.id, nome: r.nome, numero: mascararNumero(r.jid), enabled: r.enabled,
        destino_jids: r.destino_jids, destinos_nomes: r.destino_jids.map((j) => nomes.get(j) ?? '(grupo removido)'),
        template_id: r.template_id, template_nome: tpl?.name ?? null,
        tag_id: r.tag_id, etiqueta_nome: r.tag_id == null ? null : etiquetas.get(r.tag_id) ?? null,
        enviar_foto: r.enviar_foto, max_por_hora: r.max_por_hora, dedupe_horas: r.dedupe_horas, responder: r.responder,
        problema: problemaDe(r, nomes, tpl, etiquetas), contadores_24h: c.contadores_24h, ultimo_em: c.ultimo_em,
      };
    });
    return { remetentes, totais_24h: totais };
  }

  /** Motivo de um envio encerrado para os grupos que ele não tentou (o da fila de envios, já sem dado de fora). */
  function motivoDoEnvio(status, resultado) {
    const m = lerJson(resultado, {})?.motivo;
    if (typeof m === 'string' && m.trim()) return m.trim().slice(0, MAX_MOTIVO_ENVIO);
    return status === 'cancelado' ? 'o envio foi cancelado' : NAO_ENVIADO;
  }

  /**
   * GET /api/remetentes/itens?remetente=&antes=<id>&limite=50 → itens do mais novo para o mais velho, sem `url` nem
   * `complemento` (nem o número). O nome é o do remetente, ou o guardado no item se ele foi excluído. `destinos` vem do
   * envio: ok true/false, ou null enquanto o envio está na fila; envio encerrado sem resultado para um grupo → ok false
   * com o motivo do envio (como no espelho).
   */
  function itens(q = {}) {
    const filtros = []; const args = [];
    if (q.remetente != null && q.remetente !== '') { filtros.push('i.remetente_id = ?'); args.push(idValido(q.remetente)); }
    if (q.antes != null && q.antes !== '') { filtros.push('i.id < ?'); args.push(idValido(q.antes, 'Item não encontrado.')); }
    const lim = Math.min(Math.max(Number.parseInt(q.limite, 10) || MAX_LIMITE_ITENS, 1), MAX_LIMITE_ITENS);
    const linhas = db.prepare(`SELECT i.id, i.remetente_id, COALESCE(r.nome, i.remetente_nome) AS remetente_nome, i.ts, i.loja, i.status,
        i.codigo, i.motivo, i.fonte_dados, i.oferta, i.envio_id, i.decidido_em, v.group_jids, v.status AS envio_status, v.resultado AS envio_resultado
      FROM remetente_itens i LEFT JOIN remetentes r ON r.id = i.remetente_id LEFT JOIN envios v ON v.id = i.envio_id
      ${filtros.length ? `WHERE ${filtros.join(' AND ')}` : ''} ORDER BY i.id DESC LIMIT ?`).all(...args, lim);
    const nomes = new Map(db.prepare('SELECT jid, name FROM groups').all().map((g) => [g.jid, g.name]));
    const resultados = db.prepare('SELECT jid, group_name, ok, erro FROM envio_resultados WHERE envio_id = ? ORDER BY id');
    return linhas.map((l) => {
      const ultimo = new Map();
      if (l.envio_id != null) for (const r of resultados.all(l.envio_id)) ultimo.set(r.jid, r);
      const encerrado = l.envio_status != null && !ENVIO_ATIVO.includes(l.envio_status);
      const motivoEnvio = encerrado ? motivoDoEnvio(l.envio_status, l.envio_resultado) : null;
      const destinos = listaDeTexto(l.group_jids).map((jid) => {
        const r = ultimo.get(jid);
        const nome = r?.group_name || nomes.get(jid) || '(grupo removido)';
        if (!r) return encerrado ? { nome, ok: false, erro: motivoEnvio } : { nome, ok: null, erro: null };
        return { nome, ok: !!r.ok, erro: r.ok ? null : r.erro };
      });
      return {
        id: l.id, remetente_id: l.remetente_id, remetente_nome: l.remetente_nome ?? null, ts: l.ts, loja: l.loja, status: l.status,
        codigo: l.codigo, motivo: l.motivo, fonte_dados: l.fonte_dados,
        oferta: l.oferta ? soCampos(lerJson(l.oferta, {})) : null, destinos, decidido_em: l.decidido_em,
      };
    });
  }

  return {
    receber, processarPendentes, responderPendentes, recuperar, limpar,
    listar, criar, atualizar, apagar, ativar, itens,
  };
}

/** Responde JSON; ErroRemetente vira o status dele. Erro inesperado (banco) não devolve nem registra a mensagem. */
const responder = (fn) => async (req, res) => {
  try { res.json(await fn(req)); } catch (e) {
    if (e instanceof ErroRemetente) return res.status(e.status).json({ erro: e.message });
    console.error('[remetente] falha inesperada:', nomeDoErro(e)); // sem e.message: pode trazer os valores da query
    res.status(500).json({ erro: MSG.inesperado });
  }
};

/** Sem `ctx.soDono` (servidor montado sem ele), ninguém escreve: falha fechada. */
const negar = (_req, res) => res.status(403).json({ erro: 'Só o Dono pode fazer isso.' });

/**
 * Rotas do Remetente, montadas por buildApp depois do login e da checagem Host/Origin (a ligação é da etapa 9). A lista
 * e o histórico são de quem estiver logado (Dono e Operador); cadastrar, editar, ligar e excluir são só do Dono (P9:
 * `ctx.soDono` responde 403 ao Operador). O serviço é `ctx.remetentes` ou `ctx.scheduler.remetentes`, lido na hora.
 * Freio do cadastro: cada consulta de número ao WhatsApp (onWhatsApp) conta, por IP (10 a cada 10 min, como nos
 * avisos); passou disso, 429. Varrer números com a sessão do painel poderia marcar o número do dono como robô.
 */
export function montarRotas(app, ctx) {
  const servico = () => {
    const s = ctx.remetentes ?? ctx.scheduler?.remetentes;
    if (!s) throw new ErroRemetente(503, MSG.indisponivel);
    return s;
  };
  const soDono = typeof ctx.soDono === 'function' ? ctx.soDono : negar;
  const consultas = createLimiter({ max: CONSULTAS_MAX, windowMs: CONSULTAS_JANELA_MS });
  const freioDe = (req) => () => {
    const ip = chaveIp(req.ip);
    if (consultas.blocked(ip)) throw new ErroRemetente(429, MSG.muitasConsultas(consultas.retryAfterS(ip)));
    consultas.fail(ip);
  };
  app.get('/api/remetentes', responder(() => servico().listar()));
  app.get('/api/remetentes/itens', responder((req) => servico().itens(req.query)));
  app.post('/api/remetentes', soDono, responder((req) => servico().criar(req.body, { antesDeConsultar: freioDe(req) })));
  app.put('/api/remetentes/:id', soDono, responder((req) => servico().atualizar(req.params.id, req.body, { antesDeConsultar: freioDe(req) })));
  app.delete('/api/remetentes/:id', soDono, responder((req) => servico().apagar(req.params.id)));
  app.post('/api/remetentes/:id/enabled', soDono, responder((req) => servico().ativar(req.params.id, req.body?.enabled)));
}
