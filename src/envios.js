// Envios avulsos (plano disparos-comunicacao-conta, decisões 1 e 2): disparo manual de oferta (F1),
// mensagem e enquete (F2), agora, agendados ou repetidos. A fila é a tabela `envios` (src/db.js) e é
// processada pelo mesmo tick das regras (src/scheduler.js), nunca por um timer próprio.
//
// Sem envio duplicado: a trava é atômica (pendente → enviando na mesma ocorrência, changes === 1) e a retomada
// depois de uma queda pula os grupos que já têm `ok` na mesma ocorrência (= next_run_at da rodada).
// Um envio de cada vez: até o "agora" passa pelo tick do agendador (acordar), e há pausa entre um envio e o seguinte.
// Pausas: `sleep` e `jitter` de ./util.js, as mesmas das regras.
// Dado pessoal: log, tela e console levam o nome do grupo, nunca JID nem número (ver limparErro). As fotos enviadas
// pelo painel são regravadas pelo sharp (giradas pelo Exif, sem metadados: GPS, aparelho, textos): ver regravarFoto.
// Amazon (plano espelhamento-amazon, decisão 6): sem etiqueta; o link é sempre .../dp/<ASIN>?tag=<tag de Conexões>,
// montado na hora do envio. Do painel vêm só ajustes de título, preços, cupom, frete e foto (por upload, nunca por URL);
// a imagem por URL e o link são sempre do servidor. `payload.origem` diz se veio do Disparo manual ou de um espelho.
// Shopee (plano integracao-shopee, decisão 6; ADR-003): sem etiqueta; dados pela Open API ou à mão (como a Amazon).
// O link (https://s.shopee.com.br/…, da conta do dono: API primeiro, extensão de reserva) é gerado AO CRIAR o envio,
// a partir do endereço do produto sem parâmetros, e guardado no payload: qualquer falha recusa sem gravar nada, e o
// envio (inclusive o agendado) não depende de rede para o link. O preparar só confere o link guardado.
// Rastreio por grupo (plano dashboard-ganhos, etapa 7; ADR-006): o link é um por CÓDIGO distinto entre os grupos
// (src/rastreio.js, agrupar; a associação do grupo/bloco vence a etiqueta escolhida, P1). Sem associação, um link só,
// como antes (CA9). O código associado que falha cai no link de afiliado padrão, com `motivo`; nunca link comum.
// Shopee: os links com Sub_id saem ao criar (linksRastreioShopee) e ficam em `payload.links_rastreio`, conferidos de
// novo no envio. Cada grupo que recebeu a oferta ganha uma linha em rastreio_envios (CA1).
// Remetente (plano envio-pelo-socio, D4 e D5): a oferta de um link mandado pelo sócio no privado sai pela mesma montagem
// do Disparo manual (montarOferta; o criar faz as mesmas duas metades e o INSERT), com o texto da mensagem completando
// os dados da loja (mesclarOferta) e só com o link do dono: situacaoLink diz, sem rede, o que impede o link; o preparar
// barra o ML no modo direto; o ML só vai à Central com o endereço de um produto, sem parâmetros (produtoMl: nem o
// meli.la nem a vitrine de outro afiliado). Os erros que o remetente distingue levam `.codigo` ('sem_dados',
// 'link_invalido'), com a mensagem de sempre.
// Magalu (plano integracao-magalu, D2 a D6; ADR-008): sem etiqueta e sem leitura do produto (título e preço à mão, foto
// só por upload). O payload guarda só o endereço canônico do produto (magazineluiza) e o código; o link
// https://www.magazinevoce.com.br/<loja>/… é montado no preparar, sem rede, com a loja de parceiro salva em Conexões
// NA HORA DO ENVIO (como a tag da Amazon). A loja do link colado nunca segue: vira só o aviso `outra_loja` do Identificar.
// Sem rastreio por grupo (rastreio.LOJAS não tem a Magalu).
// Verificador (plano verificador-preco-estoque, D1, D7, D8 e D11; ADR-010): com `verificador` (src/verificador.js), o
// preparar('oferta') relê preço e estoque na loja depois das checagens sem rede e antes de gerar o link. A referência é
// `payload.preco_loja` (o preço da loja lido ao criar, antes dos ajustes e do texto; sem ele, `offer.price`) e a idade dos
// dados é `envios.created_at`. A oferta barrada (OfertaDescartada) não pede link nem manda nada: uma linha `aviso` no
// Histórico, o motivo em cada grupo e `resultado.descartado`; o envio termina em `erro` (sem status novo) e nada vai ao
// log com o nível `erro` (que vira aviso por WhatsApp). A que sai leva o preço conferido e o `vistoEm` ({HORA_PRECO}), e
// o sufixo do verificador (" · preço não conferido (…)", " · preço atualizado de …") vai na linha `ok` de cada grupo.
// Sem `verificador` (null), nada disso acontece: a oferta sai como foi gravada.
// Proteção do número (plano anti-banimento, etapa 5; ADR-012): com `ritmo` (src/ritmo.js), o `wa` daqui é o embrulhado
// (conta toda mensagem e faz a pausa mínima entre quaisquer duas, de qualquer origem: as esperas próprias da fila saem)
// e a fila pergunta ritmo.liberado() antes de cada envio e de cada grupo. Sem vaga no teto, o envio volta a `pendente`
// NA MESMA ocorrência (a retomada pula quem já recebeu) e a fila para até o próximo tick. No horário de silêncio, o que
// tem hora marcada (agendado, repetido, Grupo vivo) é pulado com `aviso`; o "agora" espera, e o tempo em silêncio não
// conta para as 2 h. Só o "agora" criado pelo painel com `ignorar_silencio` ("Enviar mesmo assim") sai no silêncio, e
// nunca passa do teto. Sem `ritmo` (null), a fila é a de antes, com as próprias pausas.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { addLog, getSetting } from './db.js';
import * as lojasPadrao from './lojas.js';
import * as rastreio from './rastreio.js';
import { LIMITE_SHOPEE_ATINGIDO } from './links.js';
import { LinkNaoResolvido } from './amazon.js';
import { ErroShopee, LinkShopeeNaoResolvido, LINK_SHOPEE, RE_ID_AFILIADO, RE_SUB_ID, extrairIds } from './shopee.js';
import { LinkMagaluNaoResolvido, LINK_MAGALU, RE_LOJA_MAGALU, extrairProdutoMagalu } from './magalu.js';
import { mesclarOferta } from './oferta-texto.js';
import { hostPermitido } from './ml.js';
import { montarEnquete } from './whatsapp.js';
import { renderTemplate, discountPct } from './template.js';
import { sleep, jitter } from './util.js';
import { pausaGrupoGravada } from './ritmo.js';
import { OfertaDescartada, MOTIVOS_VERIFICADOR, FRESCOR_MIN, MARGEM_AGENDADO_MIN } from './verificador.js';

/** Disparo manual agendado para longe, de uma loja que o verificador não consegue conferir (ela sairia sem preço novo ou nunca). */
export const SEM_CONFERENCIA_AGENDADO = `Esta loja não tem conferência de preço: agende para até ${FRESCOR_MIN - MARGEM_AGENDADO_MIN} min ou envie agora.`;

const { PLATAFORMAS, LojaNaoConectada, SubIdIndisponivel } = lojasPadrao;

/** Hora 'H:MM' ou 'HH:MM' (00:00 a 23:59), a do Repetir; também a da grade (src/grade.js) e das rotinas (src/rotinas.js). */
export const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const DATA = /^(\d{4})-(\d{2})-(\d{2})$/;
const DIA = 86400000;
const ATRASO_MAX = 2 * 3600000;    // agendado único com mais que isso de atraso não sai mais (vira erro)
const FOTO_SEM_USO = 7 * DIA;      // foto sem envio ativo é apagada 7 dias depois do último uso
const MAX_TEXTO = 4096;
const MAX_PERGUNTA = 255;
const MAX_OPCAO = 100;
const MAX_HORARIOS = 6;
const MAX_URL = 2048;
const UPLOAD_ID = /^[a-f0-9]{32}\.(jpg|png)$/;
const MIME = { jpg: 'image/jpeg', png: 'image/png' };
const ASSINATURA_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TIPOS = ['oferta', 'mensagem', 'enquete'];
const QUANDOS = ['agora', 'agendado', 'repetir'];
const IMAGENS = ['nenhuma', 'upload', 'previa'];
const ATIVOS = ['pendente', 'enviando', 'pausado'];
const ORIGEM = { oferta: 'Disparo manual', mensagem: 'Mensagem', enquete: 'Enquete' }; // vai em log.rule_name
// payload.origem.tipo de um envio `e` no SQL; payload ilegível dá NULL (json_extract sozinho lançaria erro)
const ORIGEM_DO_ENVIO = "(CASE WHEN json_valid(e.payload) THEN json_extract(e.payload, '$.origem.tipo') END)";
const CAMPOS_OFERTA = ['key', 'title', 'price', 'oldPrice', 'discountPct', 'sold', 'freeShipping', 'coupon', 'image'];
const LINK_EXEMPLO = 'https://meli.la/(gerado no envio)';
const NAO_RECONHECI = 'Não reconheci este link. Cole o endereço completo da página do produto.';
const PERDEU = 'perdeu o horário: passou mais de 2 h (WhatsApp desconectado ou programa desligado).';
// o mesmo prazo das 2 h, quando quem segurou foi o teto da proteção (achado R1): nível `aviso`, nunca `erro`
const limiteCheio = (n) => `o limite de ${n} mensagens por hora ficou cheio por mais de 2 h.`;
const SEM_TEXTO = 'Escreva a mensagem.';
// Proteção do número (plano anti-banimento): motivo do envio marcado que caiu no silêncio e linha do Histórico da fila
const PULADO_SILENCIO = 'pulado: horário de silêncio.';
const PROTECAO = { id: null, name: 'Proteção do número' }; // a mesma origem das linhas do teto (src/ritmo.js)
export const SILENCIO_SO_AGORA = 'Só o envio "agora" pode sair no horário de silêncio. O agendado e o repetido que caem nele são pulados.';
// Amazon (plano espelhamento-amazon, decisão 6): o navegador só ajusta estes campos; `image` e `link` são sempre do servidor
const MAX_TITULO = 200;
const MAX_CUPOM = 30;
const PRECO_MAX = 10_000_000;
const SEM_AMAZON = 'A integração com a Amazon não está disponível neste servidor.';
const SEM_TAG = 'Falta a tag de associado da Amazon. Cadastre em Conexões → Amazon antes de disparar.';
const RE_ASIN = /^[A-Z0-9]{10}$/;
const SONDA_ASIN = 'B000000000'; // ASIN de sonda: montarLink diz se há tag salva sem acessar a rede
// ErroAmazon.tipo → causa que o Identificar devolve (a tela tem um texto por causa; o resto vira "indisponível")
const CAUSA_DA_API = {
  sem_credenciais: 'sem_credenciais', sem_tag: 'sem_tag', sem_acesso: 'sem_acesso', credenciais_invalidas: 'sem_acesso',
  tag_invalida: 'sem_acesso', cota: 'cota', nao_encontrado: 'indisponivel', indisponivel: 'indisponivel',
};
// Shopee (plano integracao-shopee, decisão 6)
const SEM_SHOPEE = 'A integração com a Shopee não está disponível neste servidor.';
const SEM_ID_SHOPEE = 'Falta o ID de afiliado da Shopee. Cadastre em Conexões → Shopee antes de disparar.';
const SEM_LINK_SHOPEE = 'Não tenho como gerar o seu link de afiliado da Shopee agora. Abra o Chrome com a extensão e entre no portal de afiliados da Shopee, ou ligue a API em Conexões.';
const LINK_EXEMPLO_SHOPEE = 'https://s.shopee.com.br/(gerado ao disparar)';
// ErroShopee.tipo que o Identificar devolve como `causa` (o resto vira 'indisponivel')
const CAUSAS_SHOPEE = new Set(['sem_credenciais', 'credencial_recusada', 'conta_restrita', 'sem_acesso', 'cota', 'nao_encontrado', 'indisponivel']);
const chaveShopee = (ids) => `SHOPEE:${ids.shopId}.${ids.itemId}`;
const urlDoAsin = (asin) => `https://www.amazon.com.br/dp/${asin}`;
// Magalu (plano integracao-magalu, D2 e D3)
const SEM_LOJA_MAGALU = 'Falta o nome da sua loja de parceiro da Magalu. Cadastre em Conexões → Magalu antes de disparar.';
const SEM_LEITURA_MAGALU = 'sem_leitura'; // causa interna: nada vem da Magalu (a página é bloqueada), os dados são à mão
// Rastreio (plano dashboard-ganhos, D5): no máximo 10 links com Sub_id por envio da Shopee; do 11º em diante, o base
export const MAX_SUBIDS_POR_ENVIO = 10;
// Vagas do teto de links da Shopee por hora (src/links.js) que o Sub_id nunca usa: ficam para o link base, sem o qual a
// oferta não sai para ninguém (R3/S2). Um envio inteiro (o base e os seus 10 Sub_ids) cabe nelas.
export const RESERVA_LINK_BASE_SHOPEE = MAX_SUBIDS_POR_ENVIO + 1;
const ORIGENS_RASTREIO = new Set(['manual', 'catalogo', 'espelho']);
const MAX_MOTIVO_RASTREIO = 40;
/** Linha do grupo que fica com o link base da Shopee: sem código, esperado ou não, com o motivo. */
const baseShopee = (link, motivo, esperado = 1) => ({ link, codigo: null, nivel: esperado ? 'nenhum' : 'padrao', bloco_id: null, esperado, motivo });
/** Só guarda o mapa no payload se algum grupo tem associação: sem nenhuma, o payload é o de antes (CA9). */
const comLinksRastreio = (mapa) => (Object.values(mapa).some((l) => l.esperado) ? { links_rastreio: mapa } : {});
const tagDoLink = (link) => { try { return new URL(link).searchParams.get('tag') || null; } catch { return null; } };
// Remetente (plano envio-pelo-socio, D4)
const SEM_PRECO = 'Preencha o preço do produto.';
const SEM_TITULO_ML = 'Não consegui ler o título do produto.';
const SEM_PRODUTO_ML = 'Não achei o produto deste link do Mercado Livre.';
// origens em que o Mercado Livre nunca sai com link comum (modo direto, sem comissão): catálogo (fonte-catalogo-etiqueta,
// D4) e remetente (envio-pelo-socio, D5: seria o meli.la de outro afiliado)
const SO_COM_AFILIACAO = new Set(['catalogo', 'remetente']);
/** Link com a tag mascarada, para as prévias do painel (CA7): a tag só vai inteira ao WhatsApp. */
const mascararTag = (link) => String(link).replace(/([?&]tag=)[^&#]*/, '$1•••');

const pad = (n) => String(n).padStart(2, '0');
const hora = (ts) => { const d = new Date(ts); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const horaMin = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const lerJson = (txt, padrao) => { try { return JSON.parse(txt) ?? padrao; } catch { return padrao; } };
/**
 * Quando os dados da oferta foram lidos, em ms, para a regra do frescor do verificador: `envios.created_at` (ms, como
 * todo INSERT grava; o texto 'AAAA-MM-DD HH:MM:SS' do SQLite é lido em UTC). Outro valor → null (idade desconhecida).
 */
function lidoEmDe(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v !== 'string') return null;
  if (/^\d{1,15}$/.test(v)) return Number(v) > 0 ? Number(v) : null;
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(v)) return null;
  const ms = Date.parse(`${v.replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? ms : null;
}
/** Motivo do verificador da linha do histórico: só no grupo que ficou sem a oferta com o texto do descarte. → chave ou null */
function descartadoDe(resultado, erro) {
  const r = lerJson(resultado, null);
  const d = r && typeof r === 'object' ? r.descartado : null;
  return typeof d === 'string' && Object.hasOwn(MOTIVOS_VERIFICADOR, d) && r.motivo === erro ? d : null;
}
const tplOpts = (db) => ({ tituloMax: Number(getSetting(db, 'titulo_max', 60)) });

const MAX_ERRO_BRUTO = 500; // corta antes das regex: texto enorme de uma biblioteca não trava o servidor

/** Erro de biblioteca sem JID, número ou e-mail: a mensagem vai para o log e para a tela. */
export function limparErro(m) {
  let t = String(m || 'erro desconhecido');
  // o corte pode partir um número ou e-mail no meio: a última palavra cortada sai inteira
  if (t.length > MAX_ERRO_BRUTO) t = t.slice(0, MAX_ERRO_BRUTO).replace(/\S*$/, '…');
  return t.replace(/[\w.+:-]*@[\w.-]+/g, '…').replace(/\d{8,}/g, '…').slice(0, 200);
}

/** O motivo de uma falha ao ler o produto, sem a dica de "lista" que só vale para as regras. → ' (motivo)' ou '' */
function motivoDe(e) {
  const msg = String(e?.message || '');
  const motivo = (/^não consegui ler o produto \((.*)\)/i.exec(msg)?.[1] ?? msg).trim();
  return motivo ? ` (${limparErro(motivo)})` : '';
}

/** Título curto para o log e o painel: produto, pergunta ou o começo do texto. */
function tituloDe(tipo, p, max = 80) {
  let t = tipo === 'oferta' ? p?.offer?.title || p?.url : tipo === 'enquete' ? p?.pergunta : p?.texto;
  t = String(t || '').replace(/\s+/g, ' ').trim();
  if (!t && tipo === 'mensagem' && p?.imagem === 'upload') t = '(foto sem legenda)';
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function idValido(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw new Error('Envio não encontrado.');
  return n;
}

/** Etiqueta escolhida ou, sem escolha, a primeira da lista (a mesma ordem da tela). */
function etiquetaDe(db, id, { exigir = true } = {}) {
  if (id != null && id !== '') {
    const n = Number(id);
    const t = Number.isInteger(n) ? db.prepare('SELECT id, name FROM tags WHERE id = ?').get(n) : null;
    if (!t) throw new Error('Etiqueta não encontrada. Escolha outra.');
    return { id: t.id, name: t.name };
  }
  const t = db.prepare('SELECT id, name FROM tags ORDER BY name COLLATE NOCASE LIMIT 1').get();
  if (!t && exigir) throw new Error('Cadastre uma etiqueta antes de disparar (Conexões → Mercado Livre).');
  return t ? { id: t.id, name: t.name } : null;
}

/** Template escolhido ou, sem escolha, o primeiro. created_at identifica o template se outro herdar o id. */
function templateDe(db, id) {
  let t;
  if (id != null && id !== '') {
    const n = Number(id);
    t = Number.isInteger(n) ? db.prepare('SELECT id, name, body, created_at FROM templates WHERE id = ?').get(n) : null;
    if (!t) throw new Error('Template não encontrado. Escolha outro.');
  } else t = db.prepare('SELECT id, name, body, created_at FROM templates ORDER BY id LIMIT 1').get();
  if (!t) throw new Error('Crie um template antes de disparar.');
  return { id: t.id, name: t.name, body: t.body, created_at: t.created_at ?? null };
}

/** Link de oferta: só loja conhecida e integrada (sem rede). → { url, loja } */
function lojaDoLink(url, lojas) {
  const limpo = typeof url === 'string' ? url.trim() : '';
  if (!limpo) throw new Error('Cole o link do produto.');
  if (limpo.length > MAX_URL) throw new Error(NAO_RECONHECI);
  const loja = lojas.identificar(limpo);
  if (!loja) throw new Error(NAO_RECONHECI);
  if (!loja.implementada) throw new LojaNaoConectada(loja);
  return { url: limpo, loja };
}

const soCamposDaOferta = (o) => Object.fromEntries(CAMPOS_OFERTA.map((k) => [k, o?.[k] ?? null]));

/** Erro com o código que o remetente grava no item (src/remetentes.js). A mensagem é a de sempre. */
function comCodigo(erro, codigo) {
  erro.codigo = codigo;
  return erro;
}
const semDados = (mensagem) => comCodigo(new Error(mensagem), 'sem_dados');

/**
 * Link que não chegou a um produto → o mesmo erro (classe, causa e mensagem) com `.codigo = 'link_invalido'`. Instância
 * nova: o objeto que o resolvedor lançou pode ser compartilhado (cache), e o `.codigo` dele ('invalido'|'nao_produto') fica.
 */
function comoLinkInvalido(e) {
  if (e instanceof LinkNaoResolvido) return comCodigo(new LinkNaoResolvido(e.causa), 'link_invalido');
  if (e instanceof LinkShopeeNaoResolvido) return comCodigo(new LinkShopeeNaoResolvido(e.causa), 'link_invalido');
  if (e instanceof LinkMagaluNaoResolvido) return comCodigo(new LinkMagaluNaoResolvido(e.causa), 'link_invalido');
  return e;
}

/** Caminho de anúncio: o id no começo (produto.mercadolivre.com.br/MLB-123456…-_JM, …/MLB123456…). */
const ANUNCIO_ML = /^\/MLB-?(\d{6,})/i;
/** Caminho de catálogo: /p/MLB… no começo ou depois de um slug só (www.mercadolivre.com.br/<slug>/p/MLB…). */
const CATALOGO_ML = /^\/(?:[^/]+\/)?p\/MLB(\d+)/i;

/**
 * Produto do Mercado Livre que pode ir à Central numa origem só com afiliação (SO_COM_AFILIACAO: remetente e catálogo;
 * plano envio-pelo-socio, S1 e Q4): https na porta padrão, sem usuário nem senha, host do Mercado Livre, nem o
 * encurtador (meli.la) nem a busca (lista.…), nem a vitrine social (/social/…, também escrita com %xx), que seriam os
 * de outro afiliado, e o caminho de um anúncio (MLB-… no começo) ou de um catálogo (/p/MLB…, no começo ou depois de um
 * slug). A chave do remetente (chaveMercadoLivre, src/remetentes.js) sai daqui, para as duas não divergirem.
 * → { url: origin + pathname (a query e o fragmento, onde vem o rastreio de terceiro como matt_tool e matt_word, ficam
 * de fora), chave: 'MLB123…' (anúncio) ou 'CATALOGO:MLB123…' (o número do catálogo não é o de um anúncio) } ou null.
 */
export function produtoMl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' || u.port !== '' || u.username || u.password || !hostPermitido(u.href)) return null;
  if (/(?:^|\.)meli\.la$/i.test(u.hostname) || /^lista\./i.test(u.hostname)) return null;
  let caminho;
  try { caminho = decodeURIComponent(u.pathname); } catch { return null; }
  if (/\/social(?:\/|$)/i.test(caminho)) return null;
  // os padrões olham o caminho como ele vai à Central (sem decodificar): %xx no lugar de uma letra não casa
  const catalogo = CATALOGO_ML.exec(u.pathname);
  if (catalogo) return { url: u.origin + u.pathname, chave: `CATALOGO:MLB${catalogo[1]}` };
  const anuncio = ANUNCIO_ML.exec(u.pathname);
  return anuncio ? { url: u.origin + u.pathname, chave: `MLB${anuncio[1]}` } : null;
}

/**
 * Dados da loja com o texto do remetente completando campo a campo (mesclarOferta: a loja primeiro, a imagem só da
 * loja). `causa` (a API não respondeu) = nada veio da loja. Sem complemento, os dados da loja como vieram.
 * → { dados (campos do template, com a key da loja), fonte: 'api'|'api+texto'|'texto'|null (null sem complemento) }
 */
function completarComTexto(produto, causa, complemento) {
  if (!complemento) return { dados: produto, fonte: null };
  const { oferta, fonte } = mesclarOferta(causa ? null : produto, complemento);
  return { dados: { key: produto.key, ...oferta }, fonte };
}

/** Lê o produto no servidor (o que o navegador manda não é confiável) e guarda só os campos do template. */
async function lerOferta(lojaId, url, { ml, amazon, lojas }) {
  return (await lerOfertaComUrl(lojaId, url, { ml, amazon, lojas })).offer;
}

/**
 * Como lerOferta, e devolve também o endereço do produto que a leitura achou (o meli.la de afiliado leva à página do
 * produto de verdade): é ele que vai à Central de Afiliados no envio. Só vale se for da mesma loja do link colado;
 * senão, o link colado.
 */
async function lerOfertaComUrl(lojaId, url, { ml, amazon, lojas }) {
  let o;
  try { o = await lojas.lerProduto(lojaId, url, { ml, amazon }); } catch (e) {
    if (e instanceof LojaNaoConectada) throw e;
    throw new Error(`Não consegui ler o produto deste link${motivoDe(e)}. Confira o link e tente de novo.`);
  }
  const achada = typeof o?.url === 'string' && o.url.length <= MAX_URL && lojas.identificar(o.url)?.id === lojaId ? o.url : null;
  return { offer: soCamposDaOferta(o), url: achada || url };
}

/**
 * Preço digitado no painel: número, ou texto como "89,90", "1.299,90" ou "89.90". Vazio → null.
 * → número > 0 com 2 casas, ou erro com o nome do campo.
 */
function lerPreco(v, rotulo) {
  if (v == null || v === '') return null;
  let n = NaN;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string') {
    const t = v.replace(/^\s*R\$\s*/i, '').trim();
    if (t === '') return null;
    if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(t)) n = Number(t.replace(/\./g, '').replace(',', '.'));
    else if (/^\d+(,\d{1,2})?$/.test(t)) n = Number(t.replace(',', '.'));
    else if (/^\d+\.\d{1,2}$/.test(t)) n = Number(t);
  }
  if (!Number.isFinite(n) || n <= 0 || n > PRECO_MAX) throw new Error(`${rotulo} inválido: use só números, como 89,90.`);
  return Math.round(n * 100) / 100;
}

/** Texto curto do painel numa linha só (título, cupom): espaços e quebras viram um espaço. Vazio → null. */
function lerTextoCurto(v, nome, max) {
  if (v == null) return null;
  if (typeof v !== 'string') throw new Error(`O ${nome} precisa ser texto.`);
  const t = v.replace(/\s+/g, ' ').trim();
  if (t.length > max) throw new Error(`O ${nome} passa de ${max} caracteres.`);
  return t || null;
}

/**
 * Oferta da API com os ajustes do painel por cima. Preço antigo só se for maior que o atual (nenhuma linha "De"
 * inventada); o desconto é recalculado quando um dos preços mudou; `sem_foto` tira a foto da API.
 */
function aplicarAjustes(produto, a) {
  const o = { ...produto };
  for (const k of ['title', 'price', 'oldPrice', 'coupon', 'freeShipping']) if (Object.hasOwn(a, k)) o[k] = a[k];
  if (o.oldPrice != null && (o.price == null || o.oldPrice <= o.price)) o.oldPrice = null;
  if (o.price !== produto.price || o.oldPrice !== produto.oldPrice) o.discountPct = discountPct(o.price, o.oldPrice);
  if (a.sem_foto) o.image = null;
  return o;
}

/** A oferta sai como a API mandou? → fonte_dados 'api'; senão 'manual'. */
function igualAApi(produto, o, a) {
  if (a.upload || a.sem_foto) return false;
  const mudou = ['title', 'price', 'oldPrice', 'discountPct', 'coupon', 'image'].some((k) => (o[k] ?? null) !== (produto[k] ?? null));
  return !mudou && !!o.freeShipping === !!produto.freeShipping;
}

/** Hora de um agendado no fuso do servidor. Sem data, hoje. Tem que ser no futuro. */
function horarioAgendado(data, hhmm, now, { soHoje = false } = {}) {
  const h = HHMM.exec(typeof hhmm === 'string' ? hhmm.trim() : '');
  if (!h) throw new Error('Escolha o horário (HH:MM).');
  const hoje = new Date(now);
  let [y, mo, d] = [hoje.getFullYear(), hoje.getMonth(), hoje.getDate()];
  if (data != null && data !== '') {
    const m = DATA.exec(String(data).trim());
    if (!m) throw new Error('Data inválida.');
    [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  }
  const alvo = new Date(y, mo, d, Number(h[1]), Number(h[2]));
  if (alvo.getFullYear() !== y || alvo.getMonth() !== mo || alvo.getDate() !== d) throw new Error('Data inválida.');
  if (soHoje && alvo.toDateString() !== hoje.toDateString()) throw new Error('O disparo manual só pode ser agendado para hoje.');
  if (alvo.getTime() <= now) throw new Error('Esse horário já passou. Escolha um horário mais tarde.');
  return alvo.getTime();
}

/** { dias:[0..6], horarios:['HH:MM'] (1..6) } normalizado: sem repetir, em ordem, hora com 2 dígitos. */
function validarRepetir(r) {
  if (!r || typeof r !== 'object') throw new Error('Escolha os dias e os horários da repetição.');
  const dias = [...new Set((Array.isArray(r.dias) ? r.dias : []).map((d) => (typeof d === 'string' && /^[0-6]$/.test(d) ? Number(d) : d)))];
  if (!dias.length || dias.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error('Escolha ao menos um dia da semana.');
  const horarios = [...new Set((Array.isArray(r.horarios) ? r.horarios : []).map((h) => {
    const m = HHMM.exec(typeof h === 'string' ? h.trim() : '');
    if (!m) throw new Error('Horário inválido: use HH:MM.');
    return `${pad(m[1])}:${m[2]}`;
  }))].sort();
  if (horarios.length < 1 || horarios.length > MAX_HORARIOS) throw new Error(`A repetição aceita de 1 a ${MAX_HORARIOS} horários.`);
  return { dias: dias.sort((a, b) => a - b), horarios };
}

/**
 * Texto de uma mensagem com os limites de Disparar mensagem: CRLF vira LF, sem espaços nas pontas, até 4096 caracteres.
 * Vazio só passa com `vazioOk` (foto sem legenda). Também é o texto das rotinas do Grupo vivo (src/rotinas.js).
 */
export function validarTextoMensagem(v, { vazioOk = false } = {}) {
  const texto = typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim() : '';
  if (texto.length > MAX_TEXTO) throw new Error(`A mensagem passa de ${MAX_TEXTO} caracteres.`);
  if (!texto && !vazioOk) throw new Error(SEM_TEXTO);
  return texto;
}

/**
 * Enquete com a mesma regra de quem envia (montarEnquete) mais os limites de tamanho. Também é a das rotinas do Grupo
 * vivo (src/rotinas.js). → { pergunta, opcoes, multipla }, sem outros campos
 */
export function validarEnquete(b) {
  if (typeof b.pergunta !== 'string') throw new Error('A enquete precisa de uma pergunta.');
  if (!Array.isArray(b.opcoes) || b.opcoes.some((o) => typeof o !== 'string')) throw new Error('A enquete precisa de 2 a 12 opções.');
  const multipla = b.multipla === true;
  const poll = montarEnquete({ pergunta: b.pergunta, opcoes: b.opcoes, multipla });
  if (poll.name.length > MAX_PERGUNTA) throw new Error(`A pergunta passa de ${MAX_PERGUNTA} caracteres.`);
  if (poll.values.some((v) => v.length > MAX_OPCAO)) throw new Error(`Cada opção pode ter até ${MAX_OPCAO} caracteres.`);
  return { pergunta: poll.name, opcoes: poll.values, multipla };
}

/**
 * Próximo horário de um envio repetido, estritamente depois de `depoisDe`, na hora local do servidor (TZ).
 * `repetir = { dias: [0..6] (0 = domingo, como Date#getDay), horarios: ['HH:MM'] }`, em qualquer ordem.
 * Dia ou horário inválido é ignorado. Devolve o timestamp em ms, ou null se não sobrar dia ou horário válido.
 */
export function proximaOcorrencia(repetir, depoisDe = Date.now()) {
  const dias = new Set((Array.isArray(repetir?.dias) ? repetir.dias : []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6));
  const minutos = (Array.isArray(repetir?.horarios) ? repetir.horarios : [])
    .map((h) => HHMM.exec(typeof h === 'string' ? h.trim() : ''))
    .filter(Boolean)
    .map((m) => Number(m[1]) * 60 + Number(m[2]))
    .sort((a, b) => a - b);
  if (!dias.size || !minutos.length || !Number.isFinite(depoisDe)) return null;
  const base = new Date(depoisDe);
  // hoje e os 7 dias seguintes: cobre o mesmo dia da semana que vem quando os horários de hoje já passaram
  for (let d = 0; d <= 7; d++) {
    const dia = new Date(base.getFullYear(), base.getMonth(), base.getDate() + d);
    if (!dias.has(dia.getDay())) continue;
    for (const min of minutos) {
      const ts = new Date(dia.getFullYear(), dia.getMonth(), dia.getDate(), Math.floor(min / 60), min % 60).getTime();
      if (ts > depoisDe) return ts;
    }
  }
  return null;
}

/**
 * Nome da origem no log (log.rule_name): "Disparo manual", "Mensagem", "Enquete", "Espelho: <nome>",
 * "Catálogo: <regra>" (oferta do catálogo aprovada na revisão, src/catalogo-itens.js), "Remetente: <nome>" (link
 * mandado pelo sócio no privado, src/remetentes.js) ou "Grupo vivo: <nome>" (rotina, src/rotinas.js).
 */
function origemDoLog(tipo, p) {
  const prefixo = { espelho: 'Espelho', catalogo: 'Catálogo', remetente: 'Remetente', rotina: 'Grupo vivo' }[p?.origem?.tipo];
  if (prefixo) {
    const nome = String(p.origem.nome ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    return `${prefixo}: ${nome || 'sem nome'}`;
  }
  return ORIGEM[tipo] || 'Envio';
}

/**
 * Fila de envios. `dir` é a pasta de dados (as fotos enviadas ficam em <dir>/uploads); `fast` zera as pausas (testes).
 * O agendador chama recuperar() ao iniciar e processarPendentes() a cada tick e depois de cada regra, e passa
 * `acordar` (pede um tick já): é por ele que o "agora" sai. Sem agendador, o "agora" chama processarPendentes().
 * `amazon`: cliente de src/amazon.js (createAmazon); sem ele, oferta da Amazon é recusada. `shopee`: cliente de
 * src/shopee.js (createShopee); sem ele, oferta da Shopee é recusada. `magalu`: cliente de src/magalu.js (createMagalu),
 * só para resolver link curto; sem ele, o link curto da Magalu vira 'invalido' (o de produto não precisa dele).
 * `lojas`: o módulo src/lojas.js (injetável nos testes). O Identificar do Disparo manual (identificar) usa os mesmos
 * ml/amazon/shopee/magalu/lojas do envio. `verificador`: createVerificador de src/verificador.js; sem ele (null), a
 * oferta sai sem a conferência de preço e estoque (ver o topo). `ritmo`: createRitmo de src/ritmo.js, a proteção do
 * número (ver o topo); sem ele (null), sem teto nem silêncio, com as pausas próprias da fila.
 */
export function createEnvios({ db, wa, links, ml, fast = false, dir = null, acordar = null, amazon = null, shopee = null, magalu = null, lojas = lojasPadrao, verificador = null, ritmo = null } = {}) {
  // o agendador já passa o `wa` embrulhado (embrulhar de novo devolve o mesmo); quem passa só o ritmo também conta
  if (ritmo) wa = ritmo.embrulhar(wa);
  const pastaFotos = dir ? path.join(dir, 'uploads') : null;
  // presa entre o mínimo e o máximo da proteção também na leitura (achado S2)
  const pausaEntreGrupos = () => (fast ? 0 : pausaGrupoGravada(getSetting(db, 'delay_group_s', 6)));
  // o modo em que o serviço de links vai gerar o link (src/links.js): simulação = links falsos, sem extensão
  const modoLink = () => links?.modo?.();
  let ultimaMensagem = 0; // quando este módulo mandou a última mensagem: o envio seguinte espera a pausa
  /**
   * Preço da loja lido ao criar, para o payload (`preco_loja`, a referência do verificador): só número > 0 e só com o
   * verificador (D9: sem ele, o payload é o de antes); senão, nada.
   */
  const precoDaLoja = (v) => (verificador && typeof v === 'number' && Number.isFinite(v) && v > 0 ? { preco_loja: v } : {});
  /** Com o verificador ligado, esta loja não tem como ser conferida (Magalu; Amazon ou Shopee sem a API)? */
  const semConferencia = (lojaId) => !!verificador && verificador.ativo?.() !== false && verificador.podeConferir?.(lojaId) === false;
  const lerEnvio = (id) => db.prepare('SELECT * FROM envios WHERE id = ?').get(id);
  const estadoDe = (id) => db.prepare('SELECT status, next_run_at FROM envios WHERE id = ?').get(id);
  const nomeDoGrupo = (jid) => db.prepare('SELECT name FROM groups WHERE jid = ?').get(jid)?.name ?? null;
  const okNaOcorrencia = (id, ocorrencia) => new Set(db.prepare('SELECT jid FROM envio_resultados WHERE envio_id = ? AND ocorrencia = ? AND ok = 1')
    .all(id, ocorrencia).map((r) => r.jid));
  /** Grupos com resultado de falha nesta ocorrência e nenhum ok (o envio que lançou pode ter saído). */
  const falhosNaOcorrencia = (id, ocorrencia) => new Set(db.prepare(`SELECT jid FROM envio_resultados WHERE envio_id = ? AND ocorrencia = ?
    GROUP BY jid HAVING MAX(ok) = 0`).all(id, ocorrencia).map((r) => r.jid));
  const registrar = (id, ocorrencia, jid, nome, ok, erro) => db.prepare('INSERT INTO envio_resultados (envio_id, ocorrencia, ts, jid, group_name, ok, erro) VALUES (?,?,?,?,?,?,?)')
    .run(id, ocorrencia, Date.now(), jid, nome, ok ? 1 : 0, erro);
  const logDe = (e, p) => (o) => addLog(db, { rule: { id: null, name: origemDoLog(e.tipo, p) }, offer_title: tituloDe(e.tipo, p) || null, ...o });

  // Proteção do número (ver o topo). O "Enviar mesmo assim" (CA7, P5) vale só para o "agora" do Disparo manual e do
  // Disparar mensagem: espelho, remetente, catálogo e Grupo vivo nunca gravam o campo, e mesmo assim não o seguem.
  const ignoraSilencio = (e, p) => e.quando === 'agora' && p?.ignorar_silencio === true && (p.origem?.tipo ?? 'manual') === 'manual';
  // hora marcada: no silêncio é pulado (P4), não espera. O Grupo vivo grava 'agora', mas sai num horário da rotina.
  const temHoraMarcada = (e, p) => e.quando !== 'agora' || p?.origem?.tipo === 'rotina';
  let silencioAvisado = null; // fim do período de silêncio já avisado no Histórico (uma linha por período)
  // envios que o teto segurou na ocorrência atual (id → { ocorrencia, limite }), só em memória: se o prazo das 2 h
  // vencer, o motivo é o teto e a linha é `aviso` (R1). Reiniciar o programa esquece: volta o motivo de sempre.
  const seguradoPeloTeto = new Map();
  const marcarTeto = (e, r) => { if (r?.motivo === 'limite') seguradoPeloTeto.set(e.id, { ocorrencia: e.next_run_at, limite: r.limite }); };
  /** Pode mandar mais uma mensagem deste envio a um grupo agora? Sem ritmo, sempre. → o resultado de liberado() */
  const vez = (e, p) => (ritmo ? ritmo.liberado(undefined, { ignorarSilencio: ignoraSilencio(e, p) }) : { ok: true });

  /** "Agora" no silêncio: uma linha `aviso` por período, por mais envios que fiquem esperando. */
  function avisarSilencio(fim) {
    if (fim == null || silencioAvisado === fim) return;
    silencioAvisado = fim;
    const s = ritmo.silencio();
    addLog(db, { rule: PROTECAO, level: 'aviso', message: `Horário de silêncio (${s.de} às ${s.ate}): a fila espera até as ${horaMin(fim)}.` });
  }

  /**
   * Envio com hora marcada que venceu no silêncio (P4): o repetido vai para a próxima ocorrência, o único termina em
   * `erro` (com quantos grupos já tinham recebido nesta ocorrência), e a linha do Histórico é `aviso`, nunca `erro`.
   */
  function puladoNoSilencio(e, p, now) {
    const log = logDe(e, p);
    const linha = { level: 'aviso', message: `Horário de ${horaMin(e.next_run_at)} ${PULADO_SILENCIO}` };
    if (e.quando === 'repetir') {
      const prox = proximaOcorrencia(lerJson(e.repetir, null), Math.max(now, e.next_run_at));
      const r = db.prepare("UPDATE envios SET status = ?, next_run_at = ? WHERE id = ? AND status = 'pendente' AND next_run_at = ?")
        .run(prox ? 'pendente' : 'concluido', prox, e.id, e.next_run_at);
      if (r.changes) log(linha);
      return;
    }
    const ok = okNaOcorrencia(e.id, e.next_run_at).size;
    const r = db.prepare("UPDATE envios SET status = 'erro', last_run_at = ?, resultado = ? WHERE id = ? AND status = 'pendente' AND next_run_at = ?")
      .run(Date.now(), JSON.stringify({ ok, erro: 0, motivo: PULADO_SILENCIO }), e.id, e.next_run_at);
    if (r.changes) log(linha);
  }

  /**
   * Linha de rastreio_envios do grupo que recebeu a oferta (CA1). Falha ao gravar não desfaz o envio (a mensagem já
   * saiu) e vai ao console só pelo código do erro (a mensagem do banco pode trazer o link e o grupo).
   */
  function gravarRastreio(e, p, jid, linha) {
    if (e.tipo !== 'oferta' || !linha?.link || !rastreio.LOJAS.includes(p.loja)) return;
    // O envio do remetente (origem.tipo 'remetente') entra como 'manual' de propósito (achados R2/S2 do merge com o
    // Remetente): o CHECK de rastreio_envios.origem (src/db.js) não tem 'remetente', e acrescentar exigiria recriar a
    // tabela. A linha continua ligada ao envio por envio_id; o painel do ganho não separa as duas origens.
    const origem = ORIGENS_RASTREIO.has(p.origem?.tipo) ? p.origem.tipo : 'manual';
    try {
      rastreio.registrar(db, {
        jid, loja: p.loja, origem, rule_id: origem === 'catalogo' ? p.origem.rule_id : null, envio_id: e.id, oferta_chave: p.offer?.key,
        link: linha.link, codigo: linha.codigo, nivel: linha.nivel, bloco_id: linha.bloco_id, esperado: linha.esperado, motivo: linha.motivo,
      });
    } catch (err) { console.error('[envios] rastreio do envio:', err?.code || err?.name || 'erro'); }
  }

  /** Grupos do corpo: lista não vazia, sem repetir, só grupos que existem na tabela `groups`. */
  function validarGrupos(lista) {
    if (!Array.isArray(lista) || !lista.length) throw new Error('Escolha ao menos um grupo.');
    if (lista.some((j) => typeof j !== 'string')) throw new Error('Lista de grupos inválida.');
    const jids = [...new Set(lista)];
    const existe = db.prepare('SELECT 1 FROM groups WHERE jid = ?');
    if (jids.some((j) => !existe.get(j))) throw new Error('Algum grupo escolhido não existe mais. Atualize a lista e escolha de novo.');
    return jids;
  }

  /** Mensagem sem o que depende de rede. → { texto, imagem, upload?, previa_url? } */
  function validarMensagem(b) {
    const texto = validarTextoMensagem(b.texto, { vazioOk: true }); // o vazio é conferido depois da imagem, como antes
    const imagem = b.imagem == null || b.imagem === '' ? 'nenhuma' : b.imagem;
    if (!IMAGENS.includes(imagem)) throw new Error('Imagem: sem imagem, foto ou prévia do link.');
    if (!texto && imagem !== 'upload') throw new Error(SEM_TEXTO);
    if (imagem === 'upload') {
      const up = typeof b.upload === 'string' ? b.upload : '';
      if (!UPLOAD_ID.test(up)) throw new Error('Escolha a foto de novo.');
      if (!pastaFotos || !fs.existsSync(path.join(pastaFotos, up))) throw new Error('A foto não foi encontrada. Envie de novo.');
      return { texto, imagem, upload: up };
    }
    if (imagem === 'previa') {
      const url = typeof b.previa_url === 'string' ? b.previa_url.trim() : '';
      if (!url) throw new Error('Cole o link da prévia.');
      if (url.length > MAX_URL) throw new Error('Link da prévia longo demais.');
      return { texto, imagem, previa_url: url };
    }
    return { texto, imagem };
  }

  /** Foto enviada pelo painel (POST /api/uploads): id no formato do upload e arquivo existente. */
  function exigirUpload(v) {
    const up = typeof v === 'string' ? v : '';
    if (!UPLOAD_ID.test(up)) throw new Error('Escolha a foto de novo.');
    if (!pastaFotos || !fs.existsSync(path.join(pastaFotos, up))) throw new Error('A foto não foi encontrada. Envie de novo.');
    return up;
  }

  /**
   * Ajustes do painel para uma oferta da Amazon (sem rede). Só title, price, oldPrice, coupon, freeShipping,
   * upload e sem_foto, com tamanho e tipo; o resto (image, link, url…) é ignorado. Chave presente substitui o
   * valor da API (vazio/null apaga); chave ausente mantém. → objeto só com as chaves presentes
   */
  function validarAjustes(a) {
    if (a == null) return {};
    if (typeof a !== 'object' || Array.isArray(a)) throw new Error('Dados da oferta inválidos.');
    const r = {};
    if (Object.hasOwn(a, 'title')) r.title = lerTextoCurto(a.title, 'título', MAX_TITULO);
    if (Object.hasOwn(a, 'price')) r.price = lerPreco(a.price, 'Preço atual');
    if (Object.hasOwn(a, 'oldPrice')) r.oldPrice = lerPreco(a.oldPrice, 'Preço antigo');
    if (Object.hasOwn(a, 'coupon')) r.coupon = lerTextoCurto(a.coupon, 'cupom', MAX_CUPOM);
    if (Object.hasOwn(a, 'freeShipping') && a.freeShipping != null) {
      if (typeof a.freeShipping !== 'boolean') throw new Error('Frete grátis: marque ou desmarque.');
      r.freeShipping = a.freeShipping;
    }
    if (a.sem_foto != null && typeof a.sem_foto !== 'boolean') throw new Error('Foto: envie com ou sem foto.');
    if (a.sem_foto === true) r.sem_foto = true;
    if (a.upload != null && a.upload !== '') r.upload = exigirUpload(a.upload);
    if (r.sem_foto && r.upload) throw new Error('Escolha entre trocar a foto e enviar sem foto.');
    return r;
  }

  /** Há tag de associado salva? Pergunta ao montarLink com um ASIN de sonda (sem rede). */
  function temTagAmazon() {
    try { amazon.montarLink(SONDA_ASIN); return true; } catch (e) {
      if (e?.tipo === 'sem_tag') return false;
      throw e;
    }
  }

  /**
   * ASIN do link (encurtador: segue os redirecionamentos, só hosts da Amazon, mais o amzlinks.in de terceiro só como
   * salto e só no host exato). Falha → LinkNaoResolvido.
   */
  async function asinDoLink(url) {
    try { return (await amazon.resolver(url)).asin; } catch (e) {
      throw e instanceof LinkNaoResolvido ? e : new LinkNaoResolvido('invalido');
    }
  }

  /**
   * Dados do produto pela API (lojas.lerProduto). A falha da API não impede o disparo manual: o dono preenche.
   * → { produto (campos nulos se a API não respondeu), causa: null | 'sem_credenciais' | 'sem_acesso' | … }
   */
  async function produtoAmazon(asin) {
    const vazio = { ...soCamposDaOferta(null), key: `ASIN:${asin}` };
    try {
      const o = await lojas.lerProduto('amazon', urlDoAsin(asin), { ml, amazon });
      return o ? { produto: { ...soCamposDaOferta(o), key: `ASIN:${asin}` }, causa: null } : { produto: vazio, causa: 'indisponivel' };
    } catch (e) {
      // ErroAmazon tem mensagem fixa por tipo; de outro erro, só o nome (nada de URL, ID, segredo ou token)
      if (!e?.tipo) console.error('[envios] dados da Amazon:', e?.name || 'erro');
      return { produto: vazio, causa: CAUSA_DA_API[e?.tipo] ?? 'indisponivel' };
    }
  }

  /**
   * Oferta da Amazon: ASIN, dados da API (completados pelo `complemento`, o texto do remetente) e os ajustes do painel.
   * Sem título (ou sem preço, com `exigirPreco`) → erro `sem_dados`. → campos do payload
   */
  async function ofertaAmazon(url, ajustes, { complemento = null, exigirPreco = false } = {}) {
    const asin = await asinDoLink(url);
    const { produto, causa } = await produtoAmazon(asin);
    const { dados, fonte } = completarComTexto(produto, causa, complemento);
    const offer = aplicarAjustes(dados, ajustes);
    if (!offer.title) throw semDados(causa ? 'Não consegui buscar os dados na Amazon: preencha o título do produto.' : 'Preencha o título do produto.');
    if (exigirPreco && offer.price == null) throw semDados(SEM_PRECO);
    return {
      asin, fonte_dados: fonteDosDados({ produto, dados, offer, ajustes, causa, fonte, complemento }),
      ...(ajustes.upload ? { upload: ajustes.upload } : {}), ...precoDaLoja(produto.price), offer,
    };
  }

  /**
   * fonte_dados da oferta da Amazon ou da Shopee. Sem complemento: 'api' se saiu como a API mandou, senão 'manual'.
   * Com complemento: a fonte da mescla ('api', 'api+texto' ou 'texto'), ou 'manual' se um ajuste do painel mudou algo.
   */
  function fonteDosDados({ produto, dados, offer, ajustes, causa, fonte, complemento }) {
    if (complemento) return fonte && igualAApi(dados, offer, ajustes) ? fonte : 'manual';
    return !causa && igualAApi(produto, offer, ajustes) ? 'api' : 'manual';
  }

  /** ID de afiliado da Shopee salvo em Conexões (só a coluna `config`: nenhum segredo é lido). → texto ou '' */
  function idAfiliadoShopee() {
    const linha = db.prepare("SELECT config FROM conexoes WHERE plataforma = 'shopee'").get();
    const id = lerJson(linha?.config, null)?.id_afiliado;
    return typeof id === 'string' && RE_ID_AFILIADO.test(id.trim()) ? id.trim() : '';
  }

  /**
   * Nome da loja de parceiro da Magalu salvo em Conexões (só a coluna `config`), revalidado contra RE_LOJA_MAGALU a cada
   * leitura: o valor no banco pode ter sido mexido. → texto ou ''
   */
  function lojaParceiroMagalu() {
    const linha = db.prepare("SELECT config FROM conexoes WHERE plataforma = 'magalu'").get();
    const loja = lerJson(linha?.config, null)?.loja;
    return typeof loja === 'string' && RE_LOJA_MAGALU.test(loja.trim()) ? loja.trim() : '';
  }

  /**
   * Produto da Magalu (lojas.lerProduto: o próprio link ou, se curto, os redirecionamentos; nada é lido da página),
   * refeito por extrairProdutoMagalu. → { codigo, urlProduto, lojaDoLink, produto (campos nulos, key MAGALU:<codigo>) }.
   * Link que não chega a um produto → LinkMagaluNaoResolvido { causa: 'invalido' | 'nao_produto' }. Outro erro vira
   * 'invalido', com só o nome dele no console (nada de link, loja ou URL).
   */
  async function produtoMagalu(url) {
    let o;
    try { o = await lojas.lerProduto('magalu', url, { ml, amazon, shopee, magalu }); } catch (e) {
      if (e instanceof LinkMagaluNaoResolvido || e instanceof LojaNaoConectada) throw e;
      console.error('[envios] link da Magalu:', e?.name || 'erro');
      throw new LinkMagaluNaoResolvido('invalido');
    }
    const v = extrairProdutoMagalu(o?.urlProduto);
    if (!v) throw new LinkMagaluNaoResolvido('invalido');
    const lojaDoLink = typeof o.lojaDoLink === 'string' && RE_LOJA_MAGALU.test(o.lojaDoLink) ? o.lojaDoLink : null;
    return { codigo: v.codigo, urlProduto: v.urlProduto, lojaDoLink, produto: { ...soCamposDaOferta(null), key: `MAGALU:${v.codigo}` } };
  }

  /**
   * Oferta da Magalu: o produto do link, os dados do `complemento` (o texto do remetente) e os ajustes do painel. Sem
   * título (ou sem preço, com `exigirPreco`) → erro `sem_dados`. O link não entra no payload: sai no preparar, com a loja
   * de parceiro da hora do envio. → campos do payload (`url` = o endereço canônico do produto, sem a loja de ninguém)
   */
  async function ofertaMagalu(url, ajustes, { complemento = null, exigirPreco = false } = {}) {
    const { codigo, urlProduto, produto } = await produtoMagalu(url);
    const causa = SEM_LEITURA_MAGALU;
    const { dados, fonte } = completarComTexto(produto, causa, complemento);
    const offer = aplicarAjustes(dados, ajustes);
    if (!offer.title) throw semDados('Preencha o título do produto.');
    if (exigirPreco && offer.price == null) throw semDados(SEM_PRECO);
    return {
      url: urlProduto, codigo, fonte_dados: fonteDosDados({ produto, dados, offer, ajustes, causa, fonte, complemento }),
      ...(ajustes.upload ? { upload: ajustes.upload } : {}), offer,
    };
  }

  /**
   * Por onde o link da Shopee sairia agora (sem rede): 'api' (API útil: configurada e sem recusa conhecida),
   * 'extensao' (extensão on-line, ou links simulados) ou null. O modo direto do ML não vale: fora da simulação, sem
   * API, só a extensão gera o link.
   */
  function caminhoLinkShopee() {
    let api = false;
    try { api = typeof shopee?.apiUtil === 'function' && shopee.apiUtil() === true; } catch { api = false; }
    if (api) return 'api';
    if (modoLink() === 'fake' || links?.status?.()?.online === true) return 'extensao';
    return null;
  }

  /**
   * Ids e dados do produto da Shopee (lojas.lerProduto). A falha da API não impede o disparo manual: o dono preenche.
   * → { ids: { shopId, itemId, urlProduto }, produto (campos nulos se a API não respondeu), extra, causa }.
   * Link que não chega a um produto → LinkShopeeNaoResolvido { causa: 'invalido' | 'nao_produto' }. ErroShopee sem
   * os ids (o teto de acessos barrou o resolvedor) segue adiante, com a frase fixa dele.
   */
  async function produtoShopee(url) {
    try {
      const o = await lojas.lerProduto('shopee', url, { ml, amazon, shopee });
      const ids = { shopId: o.shopId, itemId: o.itemId, urlProduto: o.urlProduto };
      return { ids, produto: { ...soCamposDaOferta(o), key: chaveShopee(ids) }, extra: o.extra ?? null, causa: null };
    } catch (e) {
      if (e instanceof LinkShopeeNaoResolvido) throw e;
      const vazio = (ids, causa) => ({ ids, produto: { ...soCamposDaOferta(null), key: chaveShopee(ids) }, extra: null, causa });
      if (e instanceof ErroShopee && e.ids) return vazio(e.ids, CAUSAS_SHOPEE.has(e.tipo) ? e.tipo : 'indisponivel');
      if (e instanceof ErroShopee) throw e;
      // erro que não é da Shopee: só o nome (nada de URL, ID ou segredo). Se o link já traz o produto, o dono
      // preenche (R6); senão, não há como saber qual é o produto.
      console.error('[envios] dados da Shopee:', e?.name || 'erro');
      const ids = extrairIds(url);
      if (ids) return vazio(ids, 'indisponivel');
      throw new LinkShopeeNaoResolvido('invalido');
    }
  }

  /**
   * Link de afiliado da Shopee para o endereço do produto (lojas.linkAfiliado: API primeiro, extensão de reserva,
   * ID do longLink conferido). Erro da Shopee sai com a mensagem fixa; o da extensão, limpo e com contexto.
   */
  async function linkShopee(urlProduto) {
    let link;
    try {
      link = await lojas.linkAfiliado('shopee', { urlProduto }, { shopee, links, idAfiliado: idAfiliadoShopee() });
    } catch (e) {
      if (e instanceof ErroShopee || e instanceof LinkShopeeNaoResolvido) throw e;
      throw new Error(`Não consegui gerar o seu link de afiliado da Shopee: ${limparErro(e?.message)}`);
    }
    if (typeof link !== 'string' || !LINK_SHOPEE.test(link)) throw new ErroShopee('link_falhou');
    return link;
  }

  /**
   * Grupos de um envio divididos por código de rastreio (rastreio.agrupar). Se a leitura das associações falhar, o envio
   * segue como sem associação (um código só, o padrão): o rastreio nunca impede a oferta de sair.
   */
  function agruparPorCodigo(loja, jids, padrao = null) {
    const semAssociacao = () => [{ codigo: padrao, nivel: 'padrao', bloco_id: null, esperado: 0, motivo: null, jids: [...jids] }];
    if (!rastreio.LOJAS.includes(loja)) return semAssociacao();
    try { return rastreio.agrupar(db, { loja, jids, padrao }); } catch (e) {
      console.error('[envios] associações de rastreio:', e?.code || e?.name || 'erro'); // sem a mensagem: pode trazer valores da query
      return semAssociacao();
    }
  }

  /**
   * Um link da Shopee com o Sub_id (lojas: guardado → API → extensão, ligada por SUBID_PELA_EXTENSAO). → { link } se o
   * Sub_id foi aplicado e o link é s.shopee.com.br; senão { motivo, parar } (motivo: limite_shopee, subid_nao_aplicado,
   * subid_extensao_indisponivel ou falha_link). Nunca lança.
   * A extensão só recebe o Sub_id com mais de RESERVA_LINK_BASE_SHOPEE vagas no teto da hora (senão limite_shopee).
   * `parar` (o envio não pede mais Sub_id; o motivo vale para os seguintes): todo motivo, menos a falha só da API com a
   * extensão desligada para o Sub_id (SubIdIndisponivel 'falha_link'), que não gasta o teto e pode passar no próximo.
   * Com a extensão ligada, falha_link é timeout, falha ou link recusado da extensão, ou erro que se repetiria.
   */
  async function linkComSubId(urlProduto, subId, idAfiliado) {
    try {
      const r = await lojas.linkAfiliadoShopeeRastreado(urlProduto, { shopee, links, idAfiliado, subId, reservaVagas: RESERVA_LINK_BASE_SHOPEE });
      if (typeof r?.link !== 'string' || !LINK_SHOPEE.test(r.link)) return { motivo: 'falha_link', parar: true };
      if (r.sub_id == null) return { motivo: 'subid_nao_aplicado', parar: true };
      return r.sub_id === subId ? { link: r.link } : { motivo: 'falha_link', parar: true };
    } catch (e) {
      if (e instanceof SubIdIndisponivel) return { motivo: e.motivo, parar: e.motivo !== 'falha_link' };
      if (e?.message === LIMITE_SHOPEE_ATINGIDO) return { motivo: 'limite_shopee', parar: true };
      return { motivo: 'falha_link', parar: true };
    }
  }

  /**
   * Links da Shopee por Sub_id para os grupos de um envio (plano dashboard-ganhos, D5), gerados ao criar (Disparo
   * manual) ou no "Enviar" do catálogo. `base` é o link de afiliado padrão (já gerado, ou o do catálogo): vale para
   * quem não tem Sub_id e para toda falha. Um pedido por Sub_id distinto, até MAX_SUBIDS_POR_ENVIO; depois do limite
   * da Shopee (ou da reserva de vagas do link base), da extensão que não aplicou o Sub_id, de timeout ou falha dela (ou
   * sem a API, com a extensão sem Sub_id), os Sub_ids seguintes nem são pedidos e ficam com o base e o mesmo motivo.
   * → { [jid]: { link, codigo, nivel, bloco_id, esperado, motivo } }. `base` fora de LINK_SHOPEE → ErroShopee('link_falhou').
   */
  async function linksRastreioShopee({ urlProduto, jids, base } = {}) {
    if (typeof base !== 'string' || !LINK_SHOPEE.test(base)) throw new ErroShopee('link_falhou');
    const porGrupo = {};
    const porCodigo = new Map(); // Sub_id → { link } | { motivo }: o mesmo Sub_id nunca é pedido duas vezes
    let pedidos = 0;
    let parou = null; // motivo que vale para todos os Sub_ids seguintes (nenhum pedido a mais)
    const idAfiliado = idAfiliadoShopee();
    for (const g of agruparPorCodigo('shopee', Array.isArray(jids) ? jids : [])) {
      let linha;
      if (!g.codigo) linha = { link: base, codigo: null, nivel: g.nivel, bloco_id: g.bloco_id, esperado: g.esperado, motivo: g.motivo };
      else {
        if (!porCodigo.has(g.codigo)) {
          let feito;
          if (parou) feito = { motivo: parou };
          else if (pedidos >= MAX_SUBIDS_POR_ENVIO) feito = { motivo: 'limite_subids' };
          else {
            pedidos++;
            feito = await linkComSubId(urlProduto, g.codigo, idAfiliado);
            if (feito.parar) parou = feito.motivo;
          }
          porCodigo.set(g.codigo, feito);
        }
        const feito = porCodigo.get(g.codigo);
        linha = feito.link ? { link: feito.link, codigo: g.codigo, nivel: g.nivel, bloco_id: g.bloco_id, esperado: 1, motivo: null }
          : baseShopee(base, feito.motivo);
      }
      for (const jid of g.jids) porGrupo[jid] = { ...linha };
    }
    return porGrupo;
  }

  /**
   * Oferta da Shopee: ids, dados da API (completados pelo `complemento`, o texto do remetente), os ajustes do painel e
   * o link de afiliado, gerado por último (só depois de a oferta estar válida). Sem título (ou sem preço, com
   * `exigirPreco`) → erro `sem_dados`, sem pedir o link. → campos do payload (a `url` passa a ser o endereço sem parâmetros)
   */
  async function ofertaShopee(url, ajustes, { complemento = null, exigirPreco = false } = {}) {
    const { ids, produto, causa } = await produtoShopee(url);
    const { dados, fonte } = completarComTexto(produto, causa, complemento);
    const offer = aplicarAjustes(dados, ajustes);
    if (!offer.title) throw semDados(causa ? 'Não consegui buscar os dados na Shopee: preencha o título do produto.' : 'Preencha o título do produto.');
    if (exigirPreco && offer.price == null) throw semDados(SEM_PRECO);
    const link = await linkShopee(ids.urlProduto);
    return {
      url: ids.urlProduto, shop_id: ids.shopId, item_id: ids.itemId, link_afiliado: link,
      fonte_dados: fonteDosDados({ produto, dados, offer, ajustes, causa, fonte, complemento }),
      ...(ajustes.upload ? { upload: ajustes.upload } : {}), ...precoDaLoja(produto.price), offer,
    };
  }

  /**
   * Oferta do Mercado Livre: o produto lido na página (o meli.la de afiliado leva ao produto de verdade, e é ele que
   * vai à Central no envio), completado pelo `complemento`. Origem só com afiliação (remetente, catálogo): só sai o
   * endereço de um produto, sem parâmetros (produtoMl); o resto (o meli.la que não levou a um produto, a vitrine
   * de outro afiliado) é recusado com `link_invalido`, mesmo com nome e preço no texto, porque seria o link de outro
   * afiliado. Nessas origens a `key` da oferta é a do produto achado (produtoMl: 'MLB…' ou 'CATALOGO:MLB…'), não a da
   * leitura, que é a do link colado (o meli.la do sócio): ela vai a rastreio_envios.oferta_chave, guardada por 400
   * dias, e casa com o produto das comissões. → campos do payload (fonte_dados só com complemento)
   */
  async function ofertaMercadoLivre(lojaId, url, origem, { complemento = null, exigirPreco = false } = {}) {
    const lida = await lerOfertaComUrl(lojaId, url, { ml, amazon, lojas });
    let urlProduto = lida.url;
    let chave = null;
    if (SO_COM_AFILIACAO.has(origem?.tipo)) {
      const produto = produtoMl(lida.url);
      if (!produto) throw comCodigo(new Error(SEM_PRODUTO_ML), 'link_invalido');
      ({ url: urlProduto, chave } = produto);
    }
    const { dados, fonte } = completarComTexto(lida.offer, null, complemento);
    const offer = chave ? { ...dados, key: chave } : dados;
    if (exigirPreco && !offer.title) throw semDados(SEM_TITULO_ML);
    if (exigirPreco && offer.price == null) throw semDados(SEM_PRECO);
    return { url: urlProduto, ...(complemento ? { fonte_dados: fonte } : {}), ...precoDaLoja(lida.offer?.price), offer };
  }

  /**
   * Checagens da oferta sem rede, na ordem do Disparo manual: loja conhecida e integrada (a não conectada é recusada
   * antes de qualquer coisa: CA2), template e, por loja, a etiqueta (ML), a tag da Amazon ou o ID e o caminho do link
   * da Shopee, ou a loja de parceiro da Magalu. → { url, loja, template, etiqueta? (ML), ajustes? (Amazon, Shopee e Magalu) }
   */
  function conteudoDaOferta({ url, template_id: templateId, tag_id: tagId, ajustes } = {}) {
    const { url: limpo, loja } = lojaDoLink(url, lojas);
    const conteudo = { url: limpo, loja, template: templateDe(db, templateId) };
    if (loja.id === 'amazon') {
      // a Amazon não tem etiqueta: o link leva a tag de associado de Conexões (sem ela, não dispara: CA2)
      if (!amazon) throw new Error(SEM_AMAZON);
      if (!temTagAmazon()) throw new Error(SEM_TAG);
      conteudo.ajustes = validarAjustes(ajustes);
    } else if (loja.id === 'shopee') {
      // a Shopee não tem etiqueta: o link sai com o ID de afiliado de Conexões, pela API ou pela extensão (CA3)
      if (!shopee) throw new Error(SEM_SHOPEE);
      if (!idAfiliadoShopee()) throw new Error(SEM_ID_SHOPEE);
      if (!caminhoLinkShopee()) throw new Error(SEM_LINK_SHOPEE);
      conteudo.ajustes = validarAjustes(ajustes);
    } else if (loja.id === 'magalu') {
      // a Magalu não tem etiqueta: o link leva o nome da loja de parceiro de Conexões (sem ele, não dispara)
      if (!lojaParceiroMagalu()) throw new Error(SEM_LOJA_MAGALU);
      conteudo.ajustes = validarAjustes(ajustes);
    } else conteudo.etiqueta = etiquetaDe(db, tagId);
    return conteudo;
  }

  /**
   * O que depende de rede, depois das checagens de conteudoDaOferta: o produto (Mercado Livre, ou link resolvido e API
   * da Amazon ou da Shopee, ou o produto do link da Magalu) e o link de afiliado da Shopee. Não grava nada. → payload da
   * oferta, com `preco_loja` (o preço que a loja devolveu, antes dos ajustes do painel e do texto do remetente) quando
   * há verificador e a loja trouxe preço: é a referência dele no envio (a Magalu nunca traz).
   */
  async function payloadDaOferta({ url, loja, etiqueta, template, ajustes }, { origem, complemento = null, exigirPreco = false }) {
    const base = {
      url, loja: loja.id, tag_id: etiqueta?.id ?? null, etiqueta: etiqueta?.name ?? null,
      template_id: template.id, template_criado_em: template.created_at, // created_at: ver preparar (Q6)
      origem,
    };
    const opcoes = { complemento, exigirPreco };
    try {
      if (loja.id === 'amazon') return { ...base, ...(await ofertaAmazon(url, ajustes, opcoes)) };
      if (loja.id === 'shopee') return { ...base, ...(await ofertaShopee(url, ajustes, opcoes)) };
      if (loja.id === 'magalu') return { ...base, ...(await ofertaMagalu(url, ajustes, opcoes)) };
    } catch (e) { throw comoLinkInvalido(e); }
    return { ...base, ...(await ofertaMercadoLivre(loja.id, url, origem, opcoes)) };
  }

  /**
   * Oferta pronta para a fila, sem gravar: as checagens sem rede e depois a rede (o criar faz as mesmas duas metades,
   * com os grupos e o horário no meio, e o INSERT). `dados` = { url, template_id, tag_id (ML; vazio = a primeira
   * etiqueta), ajustes (Amazon e Shopee) }. `origem` vai no payload ({ tipo: 'manual' }, { tipo: 'remetente',
   * remetente_id, nome }…). `complemento` (lerOfertaDoTexto do texto do remetente) completa os dados da loja campo a
   * campo. `exigirPreco`: sem título ou sem preço, erro `sem_dados` (em todas as lojas). Link sem produto: `link_invalido`.
   * → payload (o mesmo formato do que o criar grava)
   */
  async function montarOferta(dados, { origem, complemento = null, exigirPreco = false } = {}) {
    if (!origem || typeof origem !== 'object' || typeof origem.tipo !== 'string') throw new Error('Origem da oferta inválida.');
    return payloadDaOferta(conteudoDaOferta(dados ?? {}), { origem, complemento, exigirPreco });
  }

  /**
   * Por que o link de afiliado do dono não sairia agora para esta loja, sem rede (plano envio-pelo-socio, D5):
   * 'sem_etiqueta', 'modo_direto' (link comum, sem comissão) ou 'sem_extensao' (Mercado Livre); 'sem_tag_amazon' (também
   * sem o cliente da Amazon); 'sem_id_shopee' ou 'sem_link_shopee' (sem API útil nem extensão, ou sem o cliente da
   * Shopee); 'sem_loja_magalu' (sem o nome da loja de parceiro). Loja sem integração → 'link_invalido'. null = o link sai.
   */
  function situacaoLink(lojaId, { tag_id: tagId = null } = {}) {
    if (lojaId === 'mercadolivre') {
      let etiqueta = null;
      try { etiqueta = etiquetaDe(db, tagId, { exigir: false }); } catch { etiqueta = null; }
      if (!etiqueta) return 'sem_etiqueta';
      const modo = modoLink();
      if (modo === 'fake') return null;
      if (modo !== 'extension') return 'modo_direto';
      return links?.status?.()?.online === true ? null : 'sem_extensao';
    }
    if (lojaId === 'amazon') {
      let tem = false;
      try { tem = !!amazon && temTagAmazon(); } catch { tem = false; }
      return tem ? null : 'sem_tag_amazon';
    }
    if (lojaId === 'shopee') {
      if (!idAfiliadoShopee()) return 'sem_id_shopee';
      return shopee && caminhoLinkShopee() ? null : 'sem_link_shopee';
    }
    if (lojaId === 'magalu') return lojaParceiroMagalu() ? null : 'sem_loja_magalu';
    return 'link_invalido';
  }

  /**
   * Identificar da Shopee → { loja, motivo:null, editavel:true, produto, causa, extra, link_via, causa_link,
   * pode_disparar, texto, template_id, etiqueta:null }. Os dados são lidos mesmo sem ID ou caminho para o link
   * (a tela mostra os dois avisos). Link que não chega a um produto → causa 'invalido'|'nao_produto', produto null.
   */
  async function identificarShopee(url, loja, template) {
    if (!shopee) throw new Error(SEM_SHOPEE);
    const base = {
      loja, motivo: null, editavel: true, produto: null, causa: null, extra: null,
      link_via: null, causa_link: null, pode_disparar: false, texto: null, template_id: template.id, etiqueta: null,
    };
    let dados = null;
    try { dados = await produtoShopee(url); } catch (e) { base.causa = e?.causa === 'nao_produto' ? 'nao_produto' : 'invalido'; }
    // depois da leitura: ela atualiza o que se sabe do acesso à API
    const linkVia = caminhoLinkShopee();
    const causaLink = !idAfiliadoShopee() ? 'sem_id' : linkVia ? null : 'sem_link';
    if (!dados) return { ...base, link_via: linkVia, causa_link: causaLink };
    const { produto, extra, causa } = dados;
    return {
      ...base, produto, extra, causa, link_via: linkVia, causa_link: causaLink,
      pode_disparar: !causaLink, // `nao_encontrado` (fora do programa) não bloqueia: sem aviso, os dados vão à mão
      texto: renderTemplate(template.body, { ...produto, link: LINK_EXEMPLO_SHOPEE, vistoEm: Date.now() }, tplOpts(db)),
    };
  }

  /**
   * Identificar da Magalu → { loja, motivo:null, editavel:true, produto, causa, causa_link, loja_parceiro, outra_loja,
   * pode_disparar, texto, template_id, etiqueta:null }. Nada é lido da página: o produto vem com os campos nulos. Sem
   * loja de parceiro salva → causa_link 'sem_loja' (o produto ainda volta, para a tela) e texto null (não há link real).
   * Link que não chega a um produto → causa 'invalido'|'nao_produto', produto null. `outra_loja`: há loja salva e o link
   * colado é da loja de outro parceiro, sem diferenciar maiúsculas (só o booleano; o nome dela nunca sai daqui). Sem loja
   * salva é sempre false: o link pode ser da própria loja do dono, ainda não cadastrada. O texto leva o link real, com a
   * loja salva.
   */
  async function identificarMagalu(url, loja, template) {
    const salva = lojaParceiroMagalu();
    const base = {
      loja, motivo: null, editavel: true, produto: null, causa: null, causa_link: salva ? null : 'sem_loja',
      loja_parceiro: salva || null, outra_loja: false, pode_disparar: false, texto: null, template_id: template.id, etiqueta: null,
    };
    let dados;
    try { dados = await produtoMagalu(url); } catch (e) {
      if (e instanceof LojaNaoConectada) throw e;
      return { ...base, causa: e?.causa === 'nao_produto' ? 'nao_produto' : 'invalido' };
    }
    const outraLoja = !!salva && !!dados.lojaDoLink && dados.lojaDoLink.toLowerCase() !== salva.toLowerCase();
    let texto = null;
    if (salva) {
      let link;
      try { link = await lojas.linkAfiliado('magalu', { urlProduto: dados.urlProduto }, { lojaParceiro: salva }); } catch (e) {
        if (e instanceof LojaNaoConectada) throw e;
        return { ...base, causa: 'invalido' };
      }
      if (typeof link !== 'string' || !LINK_MAGALU.test(link)) return { ...base, causa: 'invalido' };
      texto = renderTemplate(template.body, { ...dados.produto, link, vistoEm: Date.now() }, tplOpts(db));
    }
    return { ...base, produto: dados.produto, outra_loja: outraLoja, pode_disparar: !!salva, texto };
  }

  /**
   * POST /api/disparo/identificar: loja do link e, se integrada, o produto e o texto com o template.
   * O texto é a prévia: {HORA_PRECO} sai com a hora de agora (a prévia não confere; no envio é a hora da conferência).
   * Amazon: { loja, motivo:null, editavel:true, produto, causa, texto (tag mascarada), template_id, etiqueta:null,
   * tag_salva }. Sem tag → causa 'sem_tag' sem acessar a rede; link que não chega a um produto → 'invalido' ou
   * 'nao_produto' (produto null); API fora → produto com os campos nulos e a causa. Shopee: identificarShopee. Magalu:
   * identificarMagalu. Com o verificador ligado e a loja sem conferência de preço, a resposta ganha
   * `sem_conferencia: true` (o agendar de mais de 25 min é recusado no criar; a chave só existe nesse caso).
   */
  async function identificarLink(corpo) {
    const r = await identificarLinkBruto(corpo);
    // verificador (R1): o painel troca a dica do agendar pela explicação quando a loja não tem conferência de preço
    return r?.loja?.implementada && semConferencia(r.loja.id) ? { ...r, sem_conferencia: true } : r;
  }
  async function identificarLinkBruto(corpo) {
    const url = typeof corpo?.url === 'string' ? corpo.url.trim() : '';
    if (!url) throw new Error('Cole o link do produto.');
    const loja = url.length <= MAX_URL ? lojas.identificar(url) : null;
    if (!loja) throw new Error(NAO_RECONHECI);
    if (!loja.implementada) {
      return { loja, motivo: new LojaNaoConectada(loja).message, produto: null, texto: null, template_id: null, etiqueta: null };
    }
    const template = templateDe(db, corpo.template_id);
    if (loja.id === 'shopee') return identificarShopee(url, loja, template);
    if (loja.id === 'magalu') return identificarMagalu(url, loja, template);
    if (loja.id === 'amazon') {
      if (!amazon) throw new Error(SEM_AMAZON);
      const base = { loja, motivo: null, editavel: true, produto: null, causa: null, texto: null, template_id: template.id, etiqueta: null, tag_salva: true };
      if (!temTagAmazon()) return { ...base, causa: 'sem_tag', tag_salva: false };
      let asin;
      try { asin = await asinDoLink(url); } catch (e) { return { ...base, causa: e.causa }; }
      const { produto, causa } = await produtoAmazon(asin);
      const link = mascararTag(amazon.montarLink(asin));
      return { ...base, produto, causa, texto: renderTemplate(template.body, { ...produto, link, vistoEm: Date.now() }, tplOpts(db)) };
    }
    const etiqueta = etiquetaDe(db, corpo.tag_id, { exigir: false });
    const produto = await lerOferta(loja.id, url, { ml, amazon, lojas });
    return {
      loja, motivo: null, editavel: false, causa: null, produto,
      texto: renderTemplate(template.body, { ...produto, link: LINK_EXEMPLO, vistoEm: Date.now() }, tplOpts(db)),
      template_id: template.id, etiqueta,
    };
  }

  /**
   * Valida o corpo de POST /api/envios por tipo (oferta|mensagem|enquete) e quando (agora|agendado|repetir),
   * resolve a oferta no servidor (o que o navegador manda não é confiável) e grava em `envios`.
   * "agora" grava `pendente` já vencido e chama acordar() (sai no tick do agendador, na fila); sem agendador,
   * processarPendentes() sem esperar. `ignorar_silencio: true` ("Enviar mesmo assim") só com "agora" (senão, erro) e
   * vai ao payload; nunca ignora o teto. → { id, status, next_run_at }
   */
  async function criar(corpo, { userId = null } = {}) {
    const b = corpo && typeof corpo === 'object' && !Array.isArray(corpo) ? corpo : {};
    const tipo = b.tipo;
    if (!TIPOS.includes(tipo)) throw new Error('Tipo de envio inválido.');
    const quando = b.quando == null || b.quando === '' ? 'agora' : b.quando;
    if (!QUANDOS.includes(quando)) throw new Error('Quando enviar: agora, agendado ou repetir.');
    if (tipo === 'oferta' && quando === 'repetir') throw new Error('O disparo manual sai agora ou agendado para hoje.');
    // "Enviar mesmo assim" (CA7, decisão P5 do dono): só `true` liga, e só no envio "agora"; agendado e repetido seguem o silêncio
    const ignorarSilencio = b.ignorar_silencio === true;
    if (ignorarSilencio && quando !== 'agora') throw new Error(SILENCIO_SO_AGORA);

    // 1. conteúdo, sem rede (a loja não conectada é recusada aqui, antes de qualquer coisa: CA2)
    const conteudo = tipo === 'oferta' ? conteudoDaOferta({ url: b.url, template_id: b.template_id, tag_id: b.tag_id, ajustes: b.ajustes })
      : tipo === 'mensagem' ? validarMensagem(b) : validarEnquete(b);
    // 2. grupos e horário
    const groupJids = validarGrupos(b.group_jids);
    const now = Date.now();
    let nextRunAt = null; let repetir = null;
    if (quando === 'agendado') nextRunAt = horarioAgendado(b.agendar_data, b.agendar_hhmm, now, { soHoje: tipo === 'oferta' });
    if (quando === 'repetir') {
      repetir = validarRepetir(b.repetir);
      nextRunAt = proximaOcorrencia(repetir, now);
      if (!nextRunAt) throw new Error('Escolha ao menos um dia e um horário.');
    }
    // verificador (R1): oferta de loja sem conferência possível, agendada para depois do frescor de 30 min menos a margem de 5 (25 min), sairia com dados
    // velhos e seria descartada na hora: recusa já aqui, antes de qualquer rede, em vez de aceitar e nunca enviar
    if (tipo === 'oferta' && quando === 'agendado' && nextRunAt - now > (FRESCOR_MIN - MARGEM_AGENDADO_MIN) * 60000 && semConferencia(conteudo.loja.id)) {
      throw new Error(SEM_CONFERENCIA_AGENDADO);
    }
    if (quando === 'agora') {
      if (!wa.isReady()) throw new Error('O WhatsApp está desconectado. Conecte o número antes de disparar.');
      if (tipo === 'oferta' && conteudo.loja.id === 'mercadolivre' && modoLink() === 'extension' && !links.status().online) {
        throw new Error('A extensão do Chrome não está conectada: abra o Chrome com a extensão para gerar o link de afiliado.');
      }
    }
    // 3. o que depende de rede: o produto (Mercado Livre, ou link resolvido e API da Amazon ou da Shopee), o link de
    // afiliado da Shopee e a prévia do link. Qualquer falha aqui também acontece antes do INSERT: nada é gravado.
    let payload;
    if (tipo === 'oferta') {
      payload = await payloadDaOferta(conteudo, { origem: { tipo: 'manual' } });
      if (payload.loja === 'shopee') {
        // os links com Sub_id vêm depois do base (o fallback de todos): falha de um Sub_id nunca recusa o envio
        const porGrupo = await linksRastreioShopee({ urlProduto: payload.url, jids: groupJids, base: payload.link_afiliado });
        payload = { ...payload, ...comLinksRastreio(porGrupo) };
      }
    } else if (tipo === 'mensagem' && conteudo.imagem === 'previa') {
      const previa = await lerPrevia(conteudo.previa_url);
      // o WhatsApp liga a prévia ao link escrito na mensagem: se ele não estiver no texto, vai no fim
      const texto = conteudo.texto.includes(conteudo.previa_url) ? conteudo.texto : `${conteudo.texto}\n\n${conteudo.previa_url}`.trim();
      payload = { ...conteudo, texto, previa };
    } else payload = conteudo;
    if (ignorarSilencio) payload = { ...payload, ignorar_silencio: true };

    if (quando === 'agora') nextRunAt = Date.now();
    const id = Number(db.prepare(`INSERT INTO envios (tipo, payload, group_jids, quando, repetir, status, next_run_at, user_id, created_at)
      VALUES (?,?,?,?,?,'pendente',?,?,?)`).run(tipo, JSON.stringify(payload), JSON.stringify(groupJids), quando,
      repetir ? JSON.stringify(repetir) : null, nextRunAt, Number.isInteger(userId) ? userId : null, Date.now()).lastInsertRowid);
    // "agora" = pendente vencido: sai pelo agendador, na fila e com a pausa entre envios (nunca em paralelo)
    if (quando === 'agora') {
      if (acordar) acordar();
      else processarPendentes().catch((e) => console.error('[envios] fila:', limparErro(e?.message)));
    }
    const r = lerEnvio(id);
    return { id, status: r.status, next_run_at: r.next_run_at };
  }

  /** Prévia do link (só Mercado Livre). Falha ao ler o produto vira mensagem própria, sem a dica das regras. */
  async function lerPrevia(url) {
    // outro site ou loja não conectada: previaDoLink recusa antes de ler nada, com a mensagem dela
    if (lojas.identificar(url)?.id !== 'mercadolivre') return lojas.previaDoLink(url, { ml });
    try { return await lojas.previaDoLink(url, { ml }); } catch (e) {
      throw new Error(`Não consegui ler a prévia deste link${motivoDe(e)}. Confira o link ou envie sem a prévia.`);
    }
  }

  /**
   * Linha de `payload.links_rastreio` conferida de novo no envio (o payload fica no banco): Sub_id com link
   * s.shopee.com.br, ou o base. Qualquer coisa fora disso vira o base com motivo 'link_invalido'.
   */
  function entradaShopee(e, base) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return baseShopee(base, 'link_invalido');
    if (e.nivel === 'grupo' || e.nivel === 'bloco') {
      const bloco = e.bloco_id == null ? null : Number.isInteger(e.bloco_id) ? e.bloco_id : NaN;
      if (typeof e.link === 'string' && LINK_SHOPEE.test(e.link) && typeof e.codigo === 'string' && RE_SUB_ID.test(e.codigo) && !Number.isNaN(bloco)) {
        return { link: e.link, codigo: e.codigo, nivel: e.nivel, bloco_id: bloco, esperado: 1, motivo: null };
      }
      return baseShopee(base, 'link_invalido');
    }
    if (e.nivel === 'padrao' || e.nivel === 'nenhum') {
      const motivo = typeof e.motivo === 'string' && e.motivo ? e.motivo.slice(0, MAX_MOTIVO_RASTREIO) : null;
      return { link: base, codigo: null, nivel: e.nivel, bloco_id: null, esperado: e.esperado ? 1 : 0, motivo };
    }
    return baseShopee(base, 'link_invalido');
  }

  /**
   * Link de cada grupo, um pedido por código distinto. → Map jid → { link, codigo, nivel, bloco_id, esperado, motivo }
   * ou { erro } (o link padrão do grupo não saiu). Sem nenhum link, lança o erro do padrão (o envio inteiro falha,
   * como antes). Shopee: o link guardado no payload, sem rede. Amazon: a tag de Conexões é o padrão; o ID de
   * rastreamento associado é montado do ASIN. Mercado Livre: a etiqueta do envio é o padrão. Magalu: um link só, montado
   * agora do endereço do produto com a loja de parceiro de agora (sem rede, sem rastreio por grupo).
   */
  async function linksPorGrupo(p, etiqueta, jids, avisos = []) {
    const porGrupo = new Map();
    if (p.loja === 'magalu') {
      let linha;
      try {
        // lojas.linkAfiliado: a loja revalidada e a Magalu ainda integrada (implementada:false barra o envio aqui)
        const link = await lojas.linkAfiliado('magalu', { urlProduto: p.url }, { lojaParceiro: lojaParceiroMagalu() });
        if (typeof link !== 'string' || !LINK_MAGALU.test(link)) throw new Error('o link da Magalu montado não é válido');
        linha = { link, codigo: null, nivel: 'padrao', bloco_id: null, esperado: 0, motivo: null };
      } catch (e) { linha = { erro: e }; }
      for (const jid of jids) porGrupo.set(jid, linha);
      if (linha.erro) throw linha.erro; // nenhum grupo tem link: o envio inteiro falha, como o padrão das outras lojas
      return porGrupo;
    }
    if (p.loja === 'shopee') {
      const mapa = p.links_rastreio && typeof p.links_rastreio === 'object' && !Array.isArray(p.links_rastreio) ? p.links_rastreio : null;
      for (const jid of jids) {
        if (mapa && Object.hasOwn(mapa, jid)) { porGrupo.set(jid, entradaShopee(mapa[jid], p.link_afiliado)); continue; }
        // sem a linha (envio criado antes da associação, ou sem nenhuma ao criar): o base; a associação de agora conta
        // como esperada e não rastreada
        const [g] = agruparPorCodigo('shopee', [jid]);
        porGrupo.set(jid, g?.esperado ? baseShopee(p.link_afiliado, 'sem_link_rastreio') : baseShopee(p.link_afiliado, null, 0));
      }
      return porGrupo;
    }
    const ehAmazon = p.loja === 'amazon';
    const cache = new Map(); // código → { link } | { e }: cada código é pedido uma vez só, na ordem dos grupos
    // ML: a etiqueta do envio e a associada estão no mesmo espaço (a associada igual à do envio não é pedida de novo);
    // Amazon: o padrão é o link de hoje (tag de Conexões), à parte das tags associadas
    const gerar = async (codigo, padrao) => {
      const tag = padrao && !ehAmazon ? etiqueta : codigo;
      const chave = padrao && ehAmazon ? '\u0000padrao' : tag;
      if (!cache.has(chave)) {
        let r;
        try {
          if (ehAmazon && padrao) r = { link: await lojas.linkAfiliado('amazon', { url: urlDoAsin(p.asin), asin: p.asin }, { links, amazon }) };
          else if (ehAmazon) r = { link: amazon.montarLink(p.asin, { tag }) };
          else r = { link: await lojas.linkAfiliado(p.loja, { url: p.url, tag }, { links, amazon }) };
        } catch (e) { r = { e }; }
        cache.set(chave, r);
      }
      return cache.get(chave);
    };
    // o código padrão: a etiqueta do envio (ML) ou a tag de Conexões, lida do link montado (Amazon)
    const codigoPadrao = (r) => (ehAmazon ? tagDoLink(r.link) : etiqueta);
    let primeiroErro = null;
    for (const g of agruparPorCodigo(p.loja, jids, ehAmazon ? null : etiqueta)) {
      const associado = g.nivel === 'grupo' || g.nivel === 'bloco';
      let linha;
      const r = associado ? await gerar(g.codigo, false) : await gerar(null, true);
      if (r.link) {
        linha = associado ? { link: r.link, codigo: g.codigo, nivel: g.nivel, bloco_id: g.bloco_id, esperado: 1, motivo: null }
          : { link: r.link, codigo: codigoPadrao(r), nivel: 'padrao', bloco_id: null, esperado: g.esperado, motivo: g.motivo };
      } else {
        // o código associado falhou: o link de afiliado padrão (nunca link comum), com o motivo
        const padrao = associado ? await gerar(null, true) : r;
        linha = padrao.link ? { link: padrao.link, codigo: codigoPadrao(padrao), nivel: 'padrao', bloco_id: null, esperado: 1, motivo: associado ? 'falha_link' : g.motivo }
          : { erro: padrao.e };
        // a mesma frase das regras (src/scheduler.js), sem o ID recusado nem a tag
        if (ehAmazon && associado && padrao.link) {
          avisos.push(`Rastreio: o ID de rastreamento do ${g.nivel} foi recusado; ${g.jids.length === 1 ? 'o grupo recebeu' : 'os grupos receberam'} o link com a sua tag.`);
        }
      }
      if (linha.erro) primeiroErro ??= linha.erro;
      for (const jid of g.jids) porGrupo.set(jid, linha);
    }
    if (primeiroErro && ![...porGrupo.values()].some((l) => l.link)) throw primeiroErro;
    return porGrupo;
  }

  /**
   * Conferência do verificador (D1, D4 e D7), logo antes de gerar o link. A oferta vai com a loja e os ids do payload
   * (`asin`, `shop_id`/`item_id`, `url`), a referência é `preco_loja` (sem ele, o verificador usa `offer.price`) e
   * `lidoEm` é a idade dos dados (`envios.created_at`). → { offer: os campos gravados com o preço, o preço antigo e o
   * desconto conferidos e `vistoEm` só quando conferido; sufixo: '' ou ' · …' para a linha `ok` }. Barrada → lança
   * OfertaDescartada. Sem verificador: a oferta gravada, sem sufixo. O `vistoEm` gravado no payload nunca vale.
   */
  async function conferirOferta(p, lidoEm) {
    const { vistoEm: _gravado, ...gravada } = p.offer && typeof p.offer === 'object' && !Array.isArray(p.offer) ? p.offer : {};
    if (!verificador) return { offer: gravada, sufixo: '' };
    const r = await verificador.conferir(
      { ...gravada, loja: p.loja, url: p.url, asin: p.asin, shop_id: p.shop_id, item_id: p.item_id },
      { lidoEm, referencia: p.preco_loja },
    );
    if (r?.acao === 'descartar') throw new OfertaDescartada(r.motivo, r.texto);
    if (r?.acao !== 'enviar') throw new OfertaDescartada('nao_conferido');
    const offer = { ...gravada };
    const conferida = r.oferta && typeof r.oferta === 'object' ? r.oferta : {};
    for (const k of ['price', 'oldPrice', 'discountPct']) if (Object.hasOwn(conferida, k)) offer[k] = conferida[k];
    if (r.conferido === true && Number.isFinite(conferida.vistoEm)) offer.vistoEm = conferida.vistoEm;
    return { offer, sufixo: typeof r.sufixo === 'string' ? r.sufixo : '' };
  }

  /**
   * O que vai a cada grupo, preparado uma vez por ocorrência, para os grupos `jids` que faltam. `lidoEm` (oferta): a
   * idade dos dados para o verificador (conferirOferta), que pode lançar OfertaDescartada antes de qualquer link.
   * → { enviar(jid) → texto do log, falha(jid) → motivo do grupo sem link (ou null), rastreio(jid) → linha do rastreio,
   *   avisos (oferta) → frases para o Histórico, nível aviso (ID de rastreamento da Amazon recusado) }
   */
  async function preparar(tipo, p, jids = [], { lidoEm = null } = {}) {
    if (tipo === 'oferta') {
      const ehAmazon = p.loja === 'amazon';
      const ehShopee = p.loja === 'shopee';
      const ehMagalu = p.loja === 'magalu';
      // a etiqueta é a escolhida ao criar, pelo nome: se ela for apagada e outra herdar o id, a comissão não muda de dono.
      // Só o Mercado Livre tem etiqueta; a Amazon usa a tag de Conexões da hora do envio, a Shopee o link gerado ao criar e
      // a Magalu a loja de parceiro de Conexões da hora do envio.
      const semEtiqueta = ehAmazon || ehShopee || ehMagalu;
      const etiqueta = semEtiqueta ? null : p.etiqueta || (Number.isInteger(p.tag_id) && db.prepare('SELECT name FROM tags WHERE id = ?').get(p.tag_id)?.name);
      if (!semEtiqueta && !etiqueta) throw new Error('a etiqueta foi apagada');
      // o template é o mesmo id e a mesma criação (renomear ou editar não muda created_at; apagar e recriar muda)
      const tpl = Number.isInteger(p.template_id) && db.prepare('SELECT body, created_at FROM templates WHERE id = ?').get(p.template_id);
      if (!tpl || (p.template_criado_em != null && tpl.created_at !== p.template_criado_em)) throw new Error('o template foi apagado');
      const semLink = (e) => new Error(`link de afiliado não gerado: ${e?.message || 'erro desconhecido'}`);
      try {
        // Shopee: o link gerado ao criar (API ou extensão), conferido de novo; nada de rede nem de link montado aqui
        if (ehShopee && !(typeof p.link_afiliado === 'string' && LINK_SHOPEE.test(p.link_afiliado))) throw new Error('o link da Shopee guardado no envio não é válido');
        // catálogo (plano fonte-catalogo-etiqueta, D4) e remetente (envio-pelo-socio, D5): o ML nunca sai com link comum,
        // nem se o modo mudou depois da revisão ou da chegada (o do remetente seria o meli.la de outro afiliado)
        if (SO_COM_AFILIACAO.has(p.origem?.tipo) && !semEtiqueta && !['extension', 'fake'].includes(modoLink())) throw new Error('os links do Mercado Livre estão no modo direto (sem comissão)');
        if (ehAmazon && !amazon) throw new Error(SEM_AMAZON);
        // sem ASIN válido no payload, nada de resolver link na hora do envio: só o ASIN gravado ao criar vale
        if (ehAmazon && !RE_ASIN.test(String(p.asin ?? ''))) throw new Error('o produto da Amazon está sem ASIN');
        // Magalu: só o endereço de produto e o código gravados ao criar valem (o link é refeito deles, nunca o colado)
        if (ehMagalu && (typeof p.codigo !== 'string' || extrairProdutoMagalu(p.url)?.codigo !== p.codigo)) throw new Error('o produto da Magalu está sem código');
      } catch (e) { throw semLink(e); }
      // verificador (D1): depois das checagens sem rede e antes do link, fora do try acima (a descartada não é "link de
      // afiliado não gerado"); a oferta barrada sai daqui como OfertaDescartada, sem pedir link nenhum
      const { offer, sufixo } = await conferirOferta(p, lidoEm);
      let porGrupo; const avisos = [];
      // Amazon: sempre https://www.amazon.com.br/dp/<ASIN>?tag=<tag>, montado do ASIN (nunca o link que veio)
      try { porGrupo = await linksPorGrupo(p, etiqueta, jids, avisos); } catch (e) { throw semLink(e); }
      const textos = new Map(); // link → texto: um por código, não por grupo
      const textoDe = (link) => {
        if (!textos.has(link)) textos.set(link, renderTemplate(tpl.body, { ...offer, link }, tplOpts(db)));
        return textos.get(link);
      };
      // foto: a enviada pelo painel (Buffer) ou a URL que a loja devolveu, só de CDN permitido (o Baileys baixa a URL)
      let foto = null; let mimetype = null;
      if (p.enviar_foto !== false && p.upload) {
        const m = UPLOAD_ID.exec(String(p.upload));
        if (!m || !pastaFotos) throw new Error('a foto não foi encontrada');
        try { foto = await fs.promises.readFile(path.join(pastaFotos, m[0])); } catch { throw new Error('a foto não foi encontrada (foi apagada?)'); }
        mimetype = MIME[m[1]];
      } else if (p.enviar_foto !== false && p.offer?.image && lojas.imagemPermitida(p.loja, p.offer.image)) foto = p.offer.image;
      const okDe = (linha) => (ehAmazon ? 'Enviado com a tag de associado da Amazon'
        : ehShopee ? 'Enviado com o link de afiliado da Shopee'
          : ehMagalu ? 'Enviado pela Magalu, com a sua loja de parceiro' : `Enviado com a etiqueta ${linha.codigo}`);
      return {
        avisos,
        falha(jid) {
          const l = porGrupo.get(jid);
          if (l?.link) return null;
          return `link de afiliado não gerado: ${l?.erro?.message || 'erro desconhecido'}`;
        },
        rastreio: (jid) => (porGrupo.get(jid)?.link ? porGrupo.get(jid) : null),
        async enviar(jid) {
          const linha = porGrupo.get(jid);
          if (!linha?.link) throw new Error('link de afiliado não gerado');
          const texto = textoDe(linha.link); const ok = okDe(linha);
          if (foto) {
            try { await wa.sendImage(jid, foto, texto, ...(mimetype ? [{ mimetype }] : [])); return `${ok}${sufixo}`; } catch { /* cai para o texto, como as regras */ }
            await wa.sendText(jid, texto); return `${ok} (sem a foto: ela não carregou)${sufixo}`;
          }
          await wa.sendText(jid, texto); return `${ok}${sufixo}`;
        },
      };
    }
    if (tipo === 'enquete') {
      const enquete = { pergunta: p.pergunta, opcoes: p.opcoes, multipla: p.multipla === true };
      return { async enviar(jid) { await wa.sendPoll(jid, enquete); return 'Enquete enviada'; } };
    }
    const texto = String(p.texto || '');
    if (p.imagem === 'upload') {
      const m = UPLOAD_ID.exec(String(p.upload || ''));
      if (!m || !pastaFotos) throw new Error('a foto não foi encontrada');
      let foto;
      try { foto = await fs.promises.readFile(path.join(pastaFotos, m[0])); } catch { throw new Error('a foto não foi encontrada (foi apagada?)'); }
      const mimetype = MIME[m[1]];
      return {
        async enviar(jid) {
          try { await wa.sendImage(jid, foto, texto, { mimetype }); return 'Mensagem enviada com foto'; } catch (e) {
            if (!texto) throw e;
            await wa.sendText(jid, texto); return 'Mensagem enviada sem a foto (ela não carregou)';
          }
        },
      };
    }
    if (p.imagem === 'previa') {
      let previa = p.previa || {};
      try { previa = await lojas.previaDoLink(p.previa_url, { ml }); } catch { /* usa a prévia lida ao criar */ }
      const opcoes = { previa: { ...previa, url: p.previa_url } };
      return { async enviar(jid) { await wa.sendText(jid, texto, opcoes); return 'Mensagem enviada com prévia do link'; } };
    }
    return { async enviar(jid) { await wa.sendText(jid, texto); return 'Mensagem enviada'; } };
  }

  /**
   * Fecha a rodada: concluido/erro, ou de volta a pendente na próxima ocorrência (repetir). Só mexe no envio se ele
   * ainda está nesta ocorrência: quem pausou e retomou (outro next_run_at) não tem o estado desfeito por esta rodada.
   * `descartado` (o motivo do verificador) vai em `resultado.descartado` (D11); o envio descartado termina em `erro`.
   * `adiado` (proteção do número: sem vaga no teto ou em silêncio): volta a `pendente` NA MESMA ocorrência, sem
   * resultado; a próxima rodada pula quem já recebeu (okNaOcorrencia) e o prazo das 2 h segue contando dela.
   */
  function finalizar(e, ocorrencia, { ok, erro, motivo, descartado = null, adiado = false }) {
    if (adiado) {
      db.prepare("UPDATE envios SET status = 'pendente' WHERE id = ? AND status = 'enviando' AND next_run_at = ?").run(e.id, ocorrencia);
      return;
    }
    const fim = Date.now();
    const resultado = motivo ? { ok, erro, motivo } : { ok, erro };
    if (descartado) resultado.descartado = descartado;
    db.prepare('UPDATE envios SET last_run_at = ?, resultado = ? WHERE id = ? AND next_run_at = ?')
      .run(fim, JSON.stringify(resultado), e.id, ocorrencia);
    // só mexe no status se ninguém cancelou ou pausou no meio
    if (e.quando === 'repetir') {
      const prox = proximaOcorrencia(lerJson(e.repetir, null), Math.max(fim, ocorrencia));
      db.prepare("UPDATE envios SET status = ?, next_run_at = ? WHERE id = ? AND status = 'enviando' AND next_run_at = ?")
        .run(prox ? 'pendente' : 'concluido', prox, e.id, ocorrencia);
    } else {
      db.prepare("UPDATE envios SET status = ? WHERE id = ? AND status = 'enviando' AND next_run_at = ?").run(erro ? 'erro' : 'concluido', e.id, ocorrencia);
    }
  }

  /**
   * Envia um envio a todos os grupos. Trava atômica (pendente → enviando na ocorrência esperada, changes === 1),
   * retomada que pula os grupos já 'ok' na mesma ocorrência, resultado em `envio_resultados` e linha no `log`.
   * `ocorrencia`: o next_run_at que quem chamou viu vencido (processarPendentes); se ele mudou nesse meio-tempo
   * (pausado e retomado para o próximo horário), não envia. Sem ela, vale o next_run_at atual.
   * Oferta barrada pelo verificador (OfertaDescartada no preparar): uma linha `aviso` com o motivo, o mesmo texto em cada
   * grupo que faltava (ok = 0) e `resultado.descartado`; nenhuma linha `erro` no log (D8).
   * Com `ritmo`: antes de preparar (link, conferência de preço) e antes de cada grupo, liberado(); sem vaga no teto (uma
   * linha `aviso` por episódio, de avisarLimite) ou com o silêncio começando no meio, o resto fica para depois (`adiado`).
   * → { ok, erro } da ocorrência (mais `adiado: true` se o resto voltou à fila), ou { pulado: true } se outro já está
   * enviando ou a ocorrência mudou.
   */
  async function runEnvio(id, { ocorrencia: esperada } = {}) {
    const n = idValido(id);
    const e = lerEnvio(n);
    if (!e) throw new Error('Envio não encontrado.');
    let ocorrencia = esperada !== undefined ? esperada : e.next_run_at;
    // dois ticks podem chegar juntos: só quem muda pendente → enviando, na ocorrência que viu, envia
    if (db.prepare("UPDATE envios SET status = 'enviando' WHERE id = ? AND status = 'pendente' AND next_run_at IS ?").run(n, ocorrencia).changes !== 1) {
      return { pulado: true };
    }
    if (ocorrencia == null) { ocorrencia = Date.now(); db.prepare('UPDATE envios SET next_run_at = ? WHERE id = ?').run(ocorrencia, n); }
    const p = lerJson(e.payload, {});
    const log = logDe(e, p);
    let ok = 0; let erro = 0; let motivo = null; let descartado = null; let adiado = false;
    // teto (achados S1/Q2): a vaga do próximo grupo fica separada no ritmo desde a conferência até a mensagem sair
    const vaga = ritmo ? ritmo.vaga() : null;
    /** Proteção do número: falta vaga no teto (avisa uma vez por episódio) ou é horário de silêncio? */
    const segurar = () => {
      if (!vaga) return false;
      const r = vaga.pedir(undefined, { ignorarSilencio: ignoraSilencio(e, p) });
      if (r.ok) return false;
      if (r.motivo === 'limite') { ritmo.avisarLimite(undefined, r); marcarTeto({ ...e, next_run_at: ocorrencia }, r); }
      return true;
    };
    try {
      const jids = lerJson(e.group_jids, []);
      const feitos = okNaOcorrencia(n, ocorrencia); // retomada: quem já recebeu nesta ocorrência não recebe de novo
      // nem quem falhou nesta ocorrência: o envio que lançou pode ter saído, e repetir mandaria duas vezes ("a verificar"
      // do seguranca); a falha continua contando no fim da ocorrência
      const falhos = falhosNaOcorrencia(n, ocorrencia);
      const faltam = jids.filter((j) => !feitos.has(j) && !falhos.has(j));
      ok = jids.filter((j) => feitos.has(j)).length;
      erro = jids.filter((j) => falhos.has(j) && !feitos.has(j)).length;
      let envio = null;
      if (faltam.length && segurar()) adiado = true; // nem prepara: o link e a conferência de preço ficam para quando sair
      if (faltam.length && !adiado) {
        try { envio = await preparar(e.tipo, p, faltam, { lidoEm: lidoEmDe(e.created_at) }); } catch (err) {
          motivo = limparErro(err instanceof OfertaDescartada ? err.texto : err?.message);
          if (err instanceof OfertaDescartada) descartado = err.motivo;
        }
        for (const aviso of envio?.avisos || []) log({ level: 'aviso', message: aviso });
      }
      if (adiado) {
        // nada sai agora: o finalizar devolve o envio a 'pendente' nesta ocorrência
      } else if (faltam.length && descartado) {
        // verificador (D8): a oferta não sai para ninguém, sem link pedido; um `aviso` só (nunca `erro`, que vira aviso
        // por WhatsApp) e o motivo em cada grupo, para o histórico do Disparo manual, do espelho e do catálogo
        log({ level: 'aviso', message: motivo });
        for (const jid of faltam) { registrar(n, ocorrencia, jid, nomeDoGrupo(jid), false, motivo); erro++; }
      } else if (faltam.length && !envio) {
        // nada dá para enviar (link não gerado, foto apagada…): erro em cada grupo, sem tentar
        for (const jid of faltam) {
          const nome = nomeDoGrupo(jid);
          registrar(n, ocorrencia, jid, nome, false, motivo); erro++;
          log({ level: 'erro', group_name: nome, message: `Não enviado: ${motivo}` });
        }
      } else if (faltam.length) {
        const pausa = pausaEntreGrupos();
        for (let i = 0; i < faltam.length; i++) {
          // cancelado ou pausado no meio da rodada, ou já em outra ocorrência (pausado e retomado): para aqui
          const agora = estadoDe(n);
          if (agora?.status !== 'enviando' || agora.next_run_at !== ocorrencia) break;
          // proteção do número: o teto encheu (outra origem também conta) ou o silêncio começou: o resto volta à fila
          if (segurar()) { adiado = true; break; }
          const jid = faltam[i]; const nome = nomeDoGrupo(jid);
          // só os grupos deste link ficam sem a oferta (ex.: o padrão falhou e o código associado não): sem tentar
          const semLink = envio.falha?.(jid);
          if (semLink) {
            const m = limparErro(semLink);
            registrar(n, ocorrencia, jid, nome, false, m); erro++;
            log({ level: 'erro', group_name: nome, message: `Não enviado: ${m}` });
            continue;
          }
          try {
            const detalhe = await envio.enviar(jid);
            vaga?.usar(); // a saída já conta em wa_saidas
            registrar(n, ocorrencia, jid, nome, true, null); ok++;
            log({ level: 'ok', group_name: nome, message: detalhe });
            gravarRastreio(e, p, jid, envio.rastreio?.(jid));
          } catch (err) {
            const m = limparErro(err?.message);
            registrar(n, ocorrencia, jid, nome, false, m); erro++;
            log({ level: 'erro', group_name: nome, message: `Falha no envio: ${m}` });
          }
          ultimaMensagem = Date.now();
          // com o ritmo, a pausa entre grupos é a do embrulho do `wa` (entre quaisquer duas mensagens)
          if (!ritmo && i < faltam.length - 1) await sleep(jitter(pausa));
        }
      }
    } catch (err) {
      // falha inesperada (banco, JSON): registra e não deixa o envio preso em 'enviando'
      motivo = limparErro(err?.message); erro = Math.max(erro, 1); adiado = false;
      log({ level: 'erro', message: `Falha no envio: ${motivo}` });
    } finally {
      vaga?.soltar(); // vaga separada e não usada (falha do envio, cancelado no meio) volta ao teto
      if (!adiado) seguradoPeloTeto.delete(n);
      finalizar(e, ocorrencia, { ok, erro, motivo, descartado, adiado });
    }
    return adiado ? { ok, erro, adiado: true } : { ok, erro };
  }

  /**
   * Agendado que perdeu o horário: o único vira erro; o repetido pula para a próxima ocorrência. Se quem o segurou
   * nesta ocorrência foi o teto (seguradoPeloTeto), o motivo diz isso e a linha é `aviso` (R1): não é falha do
   * programa nem do WhatsApp, e `erro` dispararia o alerta por WhatsApp.
   */
  function perdeuHorario(e, now) {
    const log = logDe(e, lerJson(e.payload, {}));
    const teto = seguradoPeloTeto.get(e.id);
    seguradoPeloTeto.delete(e.id);
    const pelo = teto && teto.ocorrencia === e.next_run_at ? limiteCheio(teto.limite) : null;
    const motivo = pelo ?? PERDEU;
    if (e.quando === 'repetir') {
      const prox = proximaOcorrencia(lerJson(e.repetir, null), now);
      const r = db.prepare("UPDATE envios SET status = ?, next_run_at = ? WHERE id = ? AND status = 'pendente' AND next_run_at = ?")
        .run(prox ? 'pendente' : 'concluido', prox, e.id, e.next_run_at);
      if (r.changes) log({ level: 'aviso', message: `Horário de ${hora(e.next_run_at)} pulado: ${motivo}${prox ? ` Próximo: ${hora(prox)}.` : ''}` });
      return;
    }
    const r = db.prepare("UPDATE envios SET status = 'erro', last_run_at = ?, resultado = ? WHERE id = ? AND status = 'pendente'")
      .run(Date.now(), JSON.stringify({ ok: 0, erro: 0, motivo }), e.id);
    if (r.changes) log({ level: pelo ? 'aviso' : 'erro', message: `Não enviado: ${motivo}` });
  }

  /**
   * Roda, um de cada vez, os envios 'pendente' com next_run_at vencido (e trata o horário perdido), com a pausa entre
   * grupos também entre um envio e o seguinte. Com `ritmo` (ver o topo), a pausa é a do embrulho do `wa`; no
   * silêncio, o envio com hora marcada é pulado e o "agora" espera (o tempo em silêncio não conta para as 2 h); sem
   * vaga no teto, a fila para aqui até o próximo tick. → quantos rodaram
   */
  async function processarPendentes(now = Date.now()) {
    const vencidos = db.prepare(`SELECT id, tipo, quando, repetir, next_run_at, payload FROM envios
      WHERE status = 'pendente' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at, id`).all(now);
    let rodaram = 0;
    for (let i = 0; i < vencidos.length; i++) {
      const e = vencidos[i];
      const p = ritmo ? lerJson(e.payload, {}) : null;
      const atraso = ritmo && !temHoraMarcada(e, p) ? ritmo.atrasoAgora(e.next_run_at, now) : now - e.next_run_at;
      if (atraso > ATRASO_MAX) { perdeuHorario(e, now); continue; }
      if (ritmo) {
        // hora marcada que caiu no silêncio e só foi vista depois dele (Q3: serviço desligado de madrugada, tick das
        // 07:05 para o das 06:50): pulada como a da grade, não sai fora de hora
        if (temHoraMarcada(e, p) && ritmo.silencio(e.next_run_at).agora) { puladoNoSilencio(e, p, now); continue; }
        const r = vez(e, p);
        if (!r.ok && r.motivo === 'silencio') {
          if (temHoraMarcada(e, p)) puladoNoSilencio(e, p, now); else avisarSilencio(r.ate);
          continue;
        }
        if (!r.ok) {
          // teto cheio: o resto da fila espera o próximo tick, e todos os que esperam ficam marcados como segurados pelo
          // teto (o motivo certo, se passarem das 2 h)
          ritmo.avisarLimite(undefined, r);
          for (const outro of vencidos.slice(i)) marcarTeto(outro, r);
          break;
        }
      }
      if (!wa.isReady()) { seguradoPeloTeto.delete(e.id); continue; } // espera o WhatsApp voltar (até 2 h)
      if (!ritmo) {
        const espera = ultimaMensagem + jitter(pausaEntreGrupos()) - Date.now();
        if (espera > 0) await sleep(espera);
      }
      try {
        const r = await runEnvio(e.id, { ocorrencia: e.next_run_at }); // pausado e retomado nesse meio-tempo: não sai agora
        if (!r.pulado) rodaram++;
      } catch (err) { console.error(`[envios] envio ${e.id}:`, limparErro(err?.message)); }
    }
    return rodaram;
  }

  /**
   * Dados da tela: tipo 'oferta' (F1) ou 'mensagem' (F2: mensagens e enquetes). Contadores dos últimos 30 dias.
   * As ocorrências das rotinas do Grupo vivo (origem 'rotina') ficam de fora: são da tela delas (plano grade-de-disparos, D7).
   * A linha do histórico de um grupo que ficou sem a oferta por causa do verificador ganha `descartado` (a chave de
   * MOTIVOS_VERIFICADOR: 'esgotado', 'preco_subiu' ou 'nao_conferido'), com o texto do descarte em `erro`; as outras
   * linhas não têm o campo.
   */
  function painel(tipo) {
    const tipos = tipo === 'oferta' ? ['oferta'] : tipo === 'mensagem' ? ['mensagem', 'enquete'] : null;
    if (!tipos) throw new Error('Tipo inválido: use oferta ou mensagem.');
    const desde = Date.now() - 30 * DIA;
    const em = `e.tipo IN (${tipos.map(() => '?').join(',')}) AND ${ORIGEM_DO_ENVIO} IS NOT 'rotina'`;
    const semResultado = 'NOT EXISTS (SELECT 1 FROM envio_resultados r WHERE r.envio_id = e.id)';
    const nomes = new Map(db.prepare('SELECT jid, name FROM groups').all().map((g) => [g.jid, g.name]));
    const nomeDe = (jid) => nomes.get(jid) || '(grupo removido)';
    const grupoDe = (jids) => (jids.length === 1 ? nomeDe(jids[0]) : `${jids.length} grupos`);
    const lojaDe = (e, p) => (e.tipo === 'oferta' ? PLATAFORMAS[p.loja]?.nome || null : null);
    const cabecalho = (e, p = lerJson(e.payload, {})) => ({ envio_id: e.id, tipo: e.tipo, titulo: tituloDe(e.tipo, p, 160), loja: lojaDe(e, p) });
    const conta = (sql, ...extra) => db.prepare(sql).get(...tipos, ...extra).n;

    const agendadas = db.prepare(`SELECT * FROM envios e WHERE ${em} AND e.quando IN ('agendado','repetir')
      AND e.status IN ('pendente','enviando','pausado') ORDER BY e.status = 'pausado', e.next_run_at, e.id`).all(...tipos).map((e) => {
      const p = lerJson(e.payload, {}); const jids = lerJson(e.group_jids, []);
      return {
        id: e.id, tipo: e.tipo, quando: e.quando, status: e.status,
        next_run_at: e.status === 'pausado' ? null : e.next_run_at, repetir: lerJson(e.repetir, null),
        titulo: tituloDe(e.tipo, p, 160), loja: lojaDe(e, p), imagem: e.tipo === 'mensagem' ? p.imagem || 'nenhuma' : null,
        grupos: jids.length, grupos_nomes: jids.map(nomeDe), created_at: e.created_at,
      };
    });

    // fila: o que ainda falta mandar na ocorrência atual de cada envio pendente ou em andamento
    let naFila = 0; const fila = [];
    for (const e of db.prepare(`SELECT * FROM envios e WHERE ${em} AND e.status IN ('pendente','enviando')`).all(...tipos)) {
      const jids = lerJson(e.group_jids, []);
      const feitos = e.next_run_at == null ? new Set() : okNaOcorrencia(e.id, e.next_run_at);
      // quem falhou nesta ocorrência não é tentado de novo nela (runEnvio): não está mais na fila
      const falhos = e.next_run_at == null ? new Set() : falhosNaOcorrencia(e.id, e.next_run_at);
      const faltam = jids.filter((j) => !feitos.has(j) && !falhos.has(j));
      if (!faltam.length) continue;
      naFila += faltam.length;
      fila.push({ ...cabecalho(e), quando: e.next_run_at ?? e.created_at, grupo: grupoDe(faltam), grupos: faltam.length, status: e.status, erro: null });
    }
    const resultados = db.prepare(`SELECT r.ts, r.jid, r.group_name, r.ok, r.erro, e.id, e.tipo, e.payload, e.resultado
      FROM envio_resultados r JOIN envios e ON e.id = r.envio_id WHERE ${em} ORDER BY r.ts DESC, r.id DESC LIMIT 20`).all(...tipos)
      .map((r) => {
        const descartado = r.ok ? null : descartadoDe(r.resultado, r.erro);
        return { ...cabecalho(r), quando: r.ts, grupo: r.group_name || nomeDe(r.jid), grupos: 1, status: r.ok ? 'enviado' : 'erro', erro: r.ok ? null : r.erro, ...(descartado ? { descartado } : {}) };
      });
    // erro sem nenhum grupo tentado (perdeu o horário)
    const perdidos = db.prepare(`SELECT * FROM envios e WHERE ${em} AND e.status = 'erro' AND ${semResultado}
      ORDER BY COALESCE(e.last_run_at, e.created_at) DESC LIMIT 20`).all(...tipos).map((e) => {
      const jids = lerJson(e.group_jids, []);
      return { ...cabecalho(e), quando: e.next_run_at ?? e.last_run_at ?? e.created_at, grupo: grupoDe(jids), grupos: jids.length, status: 'erro', erro: lerJson(e.resultado, {})?.motivo || null };
    });

    return {
      agendadas,
      contadores: {
        enviados: conta(`SELECT COUNT(*) AS n FROM envio_resultados r JOIN envios e ON e.id = r.envio_id WHERE ${em} AND r.ok = 1 AND r.ts >= ?`, desde),
        na_fila: naFila,
        com_erro: conta(`SELECT COUNT(*) AS n FROM envio_resultados r JOIN envios e ON e.id = r.envio_id WHERE ${em} AND r.ok = 0 AND r.ts >= ?`, desde)
          + conta(`SELECT COUNT(*) AS n FROM envios e WHERE ${em} AND e.status = 'erro' AND ${semResultado} AND COALESCE(e.last_run_at, e.created_at) >= ?`, desde),
      },
      linhas: [...fila, ...resultados, ...perdidos].sort((a, b) => b.quando - a.quando).slice(0, 20),
    };
  }

  /** Fotos sem envio ativo e sem uso há mais de 7 dias (pela data do arquivo ou do último envio que a usou). */
  function limparFotos(now) {
    if (!pastaFotos) return 0;
    let nomes;
    try { nomes = fs.readdirSync(pastaFotos); } catch { return 0; } // ainda não houve upload
    const uso = new Map(); // id -> { ativo, ultimo }
    // a foto da mensagem (imagem 'upload') e a trocada na oferta da Amazon (payload.upload)
    for (const e of db.prepare("SELECT tipo, status, last_run_at, payload FROM envios WHERE tipo IN ('mensagem','oferta')").all()) {
      const p = lerJson(e.payload, {});
      if ((e.tipo === 'mensagem' && p?.imagem !== 'upload') || !UPLOAD_ID.test(String(p?.upload || ''))) continue;
      const u = uso.get(p.upload) || { ativo: false, ultimo: 0 };
      if (ATIVOS.includes(e.status)) u.ativo = true;
      u.ultimo = Math.max(u.ultimo, e.last_run_at || 0);
      uso.set(p.upload, u);
    }
    let apagadas = 0;
    for (const nome of nomes) {
      if (!UPLOAD_ID.test(nome)) continue; // só mexe no que este módulo gravou
      const u = uso.get(nome);
      if (u?.ativo) continue;
      const arquivo = path.join(pastaFotos, nome);
      let mtime;
      try { mtime = fs.statSync(arquivo).mtimeMs; } catch { continue; }
      if (now - Math.max(mtime, u?.ultimo || 0) <= FOTO_SEM_USO) continue;
      try { fs.unlinkSync(arquivo); apagadas++; } catch { /* some na próxima limpeza */ }
    }
    return apagadas;
  }

  /**
   * Grava a foto de um upload (JPG ou PNG pelos bytes iniciais) regravada sem metadados (regravarFoto), em <dir>/uploads.
   * Foto que não dá para ler → FotoIlegivel (a rota responde 415). → id do arquivo
   */
  async function gravarFoto(buf, ext) {
    if (!pastaFotos || !MIME[ext]) throw new Error('sem pasta para as fotos');
    const limpa = await regravarFoto(buf, ext); // antes da pasta: foto ilegível não cria nada
    const id = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
    await fs.promises.mkdir(pastaFotos, { recursive: true, mode: 0o700 }); // só no primeiro upload: montar não cria pasta
    await fs.promises.writeFile(path.join(pastaFotos, id), limpa, { flag: 'wx', mode: 0o600 });
    return id;
  }

  /** Foto de <dir>/uploads pelo id (validado pela regex, sem caminho). → { buf, tipo } ou null */
  async function lerFoto(id) {
    const m = UPLOAD_ID.exec(String(id));
    if (!m || !pastaFotos) return null;
    try { return { buf: await fs.promises.readFile(path.join(pastaFotos, m[0])), tipo: MIME[m[1]] }; } catch { return null; }
  }

  return {
    criar,
    linksRastreioShopee,
    montarOferta,
    situacaoLink,
    identificar: identificarLink,
    processarPendentes,
    runEnvio,
    gravarFoto,
    lerFoto,
    /** Ao iniciar o serviço: o que ficou 'enviando' quando ele caiu volta a 'pendente'. → quantos voltaram */
    async recuperar() {
      return Number(db.prepare("UPDATE envios SET status = 'pendente' WHERE status = 'enviando'").run().changes);
    },
    /** Pendente, pausado ou em andamento → cancelado (o que estiver enviando para antes do próximo grupo). */
    async cancelar(id) {
      const n = idValido(id);
      if (!lerEnvio(n)) throw new Error('Envio não encontrado.');
      const r = db.prepare("UPDATE envios SET status = 'cancelado' WHERE id = ? AND status IN ('pendente','pausado','enviando')").run(n);
      if (r.changes !== 1) throw new Error('Este envio já terminou: não há o que cancelar.');
      return { ok: true, status: 'cancelado' };
    },
    /** Só o repetido pausa (o agendado único se cancela). */
    async pausar(id) {
      const n = idValido(id);
      const e = lerEnvio(n);
      if (!e) throw new Error('Envio não encontrado.');
      if (e.quando !== 'repetir') throw new Error('Só envios repetidos podem ser pausados. Para não enviar um agendado, cancele.');
      const r = db.prepare("UPDATE envios SET status = 'pausado' WHERE id = ? AND status IN ('pendente','enviando')").run(n);
      if (r.changes !== 1) throw new Error(e.status === 'pausado' ? 'Este envio já está pausado.' : 'Este envio já terminou.');
      return { ok: true, status: 'pausado' };
    },
    /** Repetido pausado volta à fila na próxima ocorrência a partir de agora. */
    async retomar(id) {
      const n = idValido(id);
      const e = lerEnvio(n);
      if (!e) throw new Error('Envio não encontrado.');
      if (e.quando !== 'repetir' || e.status !== 'pausado') throw new Error('Só um envio repetido e pausado pode ser retomado.');
      const prox = proximaOcorrencia(lerJson(e.repetir, null), Date.now());
      if (!prox) throw new Error('A repetição não tem dia ou horário válido.');
      const r = db.prepare("UPDATE envios SET status = 'pendente', next_run_at = ? WHERE id = ? AND status = 'pausado'").run(prox, n);
      if (r.changes !== 1) throw new Error('Este envio não está mais pausado.');
      return { ok: true, status: 'pendente', next_run_at: prox };
    },
    async painel(tipo) { return painel(tipo); },
    /**
     * Retenção (o servidor chama a cada 6 h): apaga envios encerrados mais velhos que `dias` (0 = não apaga)
     * e as fotos que nenhum envio ativo usa há 7 dias. → contagens; o servidor imprime só as maiores que 0
     */
    async limpar(dias, now = Date.now()) {
      let envios = 0;
      const d = Number(dias);
      if (d > 0) {
        const velho = "status IN ('concluido','erro','cancelado') AND COALESCE(last_run_at, created_at) < ?";
        const limite = now - d * DIA;
        db.exec('BEGIN');
        try {
          db.prepare(`DELETE FROM envio_resultados WHERE envio_id IN (SELECT id FROM envios WHERE ${velho})`).run(limite);
          envios = Number(db.prepare(`DELETE FROM envios WHERE ${velho}`).run(limite).changes);
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); throw e; }
      }
      return { envios, fotos: limparFotos(now) };
    },
  };
}

/** Foto do upload que não dá para ler (corrompida, cortada, fora do formato ou com pixels demais): a rota responde 415. */
class FotoIlegivel extends Error {
  constructor() { super('Não consegui ler esta foto.'); this.name = 'FotoIlegivel'; }
}

const MAX_PIXELS = 25e6; // acima disso o sharp nem decodifica (bomba de descompressão); cabe a foto de 24 MP do celular; o limite de 5 MB fica na rota
let filaRegravacao = Promise.resolve(); // uma regravação de cada vez: a decodificação de uma foto grande chega a centenas de MB
let sharpMod; // undefined: ainda não tentou carregar; null: o sharp não carrega nesta máquina
/** O sharp (binário nativo), carregado uma vez. → a função sharp ou null */
async function carregarSharp() {
  if (sharpMod === undefined) {
    try { sharpMod = (await import('sharp')).default; } catch {
      sharpMod = null;
      console.error('[uploads] o sharp não carregou: as fotos perdem os metadados pelo percurso manual, sem regravar a imagem');
    }
  }
  return sharpMod;
}

/**
 * A foto do upload regravada antes de ir para o disco: o sharp decodifica, gira os pixels conforme a orientação do
 * Exif (a foto em pé do celular continua em pé no grupo) e codifica de novo sem nenhum metadado (Exif com GPS, ICC,
 * XMP, comentários, textos do PNG e o que vier depois do fim da imagem). Sem o sharp, vai pelo percurso manual
 * (semMetadados). Qualquer erro → FotoIlegivel. → Buffer
 */
function regravarFoto(buf, ext) {
  const vez = filaRegravacao.then(async () => {
    const sharp = await carregarSharp();
    try {
      if (!sharp) return semMetadados(buf, ext);
      const img = sharp(buf, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).rotate();
      return await (ext === 'jpg' ? img.jpeg({ quality: 90, mozjpeg: false }) : img.png()).toBuffer();
    } catch (e) {
      // a mensagem do sharp/libvips não traz dado pessoal (formato, pixels demais, memória); fica curta no console
      console.warn('[uploads] foto recusada:', String(e?.message || e).slice(0, 120));
      throw new FotoIlegivel();
    }
  });
  filaRegravacao = vez.catch(() => {}); // a fila segue mesmo quando uma foto falha
  return vez;
}

const APP1 = 0xe1; const APP15 = 0xef; const COM = 0xfe;
/** Orientação (tag 0x0112 do IFD0) do corpo de um APP1 Exif. → 1 a 8; 1 se não houver ou estiver fora do formato */
function orientacaoExif(corpo) {
  if (corpo.length < 14 || corpo.toString('latin1', 0, 6) !== 'Exif\0\0') return 1;
  const t = corpo.subarray(6); const ordem = t.toString('latin1', 0, 2);
  if (ordem !== 'II' && ordem !== 'MM') return 1;
  const u16 = (o) => (ordem === 'II' ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const ifd = ordem === 'II' ? t.readUInt32LE(4) : t.readUInt32BE(4);
  if (ifd + 2 > t.length) return 1;
  for (let k = 0, e = ifd + 2; k < u16(ifd) && e + 12 <= t.length; k++, e += 12) {
    if (u16(e) === 0x0112) { const o = u16(e + 8); return o >= 1 && o <= 8 ? o : 1; }
  }
  return 1;
}
/** APP1 Exif mínimo, só com a orientação (TIFF big-endian, IFD0 de uma entrada SHORT). */
function app1Orientacao(o) {
  const corpo = Buffer.concat([Buffer.from('Exif\0\0MM\0*', 'latin1'),
    Buffer.from([0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, o, 0, 0, 0, 0, 0, 0])]);
  return Buffer.concat([Buffer.from([0xff, APP1, 0, corpo.length + 2]), corpo]);
}

/**
 * Percurso manual (só quando o sharp não carrega): JPEG sem os segmentos APP1–APP15 (Exif com GPS, XMP, ICC, MPF…)
 * nem COM, e sem o que vem depois do fim da imagem (EOI: a segunda imagem do MPF ou o trailer de alguns celulares).
 * Percorre os segmentos e pula os dados comprimidos de cada scan. A orientação do Exif (2 a 8) volta num APP1 mínimo
 * logo depois do SOI, para a foto em pé não chegar deitada. Arquivo que sai do formato antes do EOI → erro (falha
 * fechada: o upload só confere os bytes iniciais, e nada vai como está).
 */
function jpegSemMetadados(buf) {
  const partes = [buf.subarray(0, 2)]; // SOI
  let orientacao = 1;
  let i = 2;
  while (i < buf.length && buf[i] === 0xff) {
    let j = i + 1;
    while (j < buf.length && buf[j] === 0xff) j++; // bytes de preenchimento antes do marcador
    if (j >= buf.length) break;
    const m = buf[j];
    if (m === 0xd9) { // EOI
      partes.push(buf.subarray(i, j + 1));
      if (orientacao > 1) partes.splice(1, 0, app1Orientacao(orientacao));
      return Buffer.concat(partes);
    }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { partes.push(buf.subarray(i, j + 1)); i = j + 1; continue; } // sem tamanho
    if (j + 2 >= buf.length) break;
    const fim = j + 1 + buf.readUInt16BE(j + 1);
    if (fim < j + 3 || fim > buf.length) break; // tamanho impossível
    if (m === APP1 && orientacao === 1) orientacao = orientacaoExif(buf.subarray(j + 3, fim));
    if ((m < APP1 || m > APP15) && m !== COM) partes.push(buf.subarray(i, fim));
    i = fim;
    if (m === 0xda) { // SOS: dados comprimidos até o próximo marcador (0xFF seguido de algo que não é 0x00 nem RSTn)
      let k = i;
      for (;;) {
        k = buf.indexOf(0xff, k);
        if (k < 0 || k + 1 >= buf.length) { k = buf.length; break; }
        const b = buf[k + 1];
        if (b !== 0x00 && (b < 0xd0 || b > 0xd7)) break;
        k += 2;
      }
      partes.push(buf.subarray(i, k)); i = k;
    }
  }
  throw new Error('JPEG fora do formato');
}

const PNG_METADADOS = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt']);
/**
 * Percurso manual (sem o sharp): PNG sem os blocos de metadados (eXIf, tEXt, zTXt, iTXt) e sem o que vem depois do
 * IEND. Bloco fora do formato antes do IEND → erro (falha fechada).
 */
function pngSemMetadados(buf) {
  const partes = [buf.subarray(0, 8)]; // assinatura
  let i = 8;
  while (i + 12 <= buf.length) {
    const fim = i + 12 + buf.readUInt32BE(i); // tamanho + tipo + dados + CRC
    if (fim > buf.length) break;
    const tipo = buf.toString('latin1', i + 4, i + 8);
    if (!PNG_METADADOS.has(tipo)) partes.push(buf.subarray(i, fim));
    i = fim;
    if (tipo === 'IEND') return Buffer.concat(partes);
  }
  throw new Error('PNG fora do formato');
}

/** Percurso manual, sem o sharp: a foto do upload sem metadados (localização, aparelho, textos). Fora do formato → erro. */
export const semMetadados = (buf, ext) => (ext === 'jpg' ? jpegSemMetadados(buf) : pngSemMetadados(buf));

/** JPG ou PNG pelos bytes iniciais, e coerente com o Content-Type. → 'jpg' | 'png' | null */
function extensaoDaFoto(req) {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length < 8) return null;
  const tipo = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (tipo === 'image/jpeg' && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (tipo === 'image/png' && buf.subarray(0, 8).equals(ASSINATURA_PNG)) return 'png';
  return null;
}

/**
 * Rotas de F1/F2, montadas por buildApp depois do login e da checagem Host/Origin.
 * ctx = { db, wa, links, scheduler, auth, wrap, soDono, dataDir, ml, enderecoPublico }; a fila é ctx.scheduler.envios,
 * e as fotos ficam na pasta dela (createEnvios({ dir })), a mesma que o envio lê.
 * Na montagem, não toque em ctx.scheduler.envios nem crie pastas: há testes que montam com scheduler falso e dataDir real.
 */
export function montarRotas(app, ctx) {
  const { wrap } = ctx;
  const fila = () => ctx.scheduler.envios;
  // o Identificar usa o ml, o amazon, o shopee e o lojas da fila de envios: os mesmos que vão ler o produto e montar o link
  app.post('/api/disparo/identificar', wrap((req) => fila().identificar(req.body)));
  app.get('/api/envios', wrap((req) => fila().painel(String(req.query.tipo ?? 'oferta'))));
  app.post('/api/envios', wrap((req) => fila().criar(req.body, { userId: req.user?.id ?? null })));
  for (const acao of ['cancelar', 'pausar', 'retomar']) app.post(`/api/envios/:id/${acao}`, wrap((req) => fila()[acao](req.params.id)));

  // Foto: corpo binário cru, só nesta rota (o login já passou), até 5 MB, conferida pelos bytes iniciais.
  const fotoCrua = express.raw({ type: ['image/jpeg', 'image/png'], limit: '5mb' });
  const naoAchei = (res) => res.status(404).json({ erro: 'Foto não encontrada.' });
  app.post('/api/uploads', (req, res, next) => fotoCrua(req, res, (err) => {
    if (!err) return next();
    if (err.status === 413) return res.status(413).json({ erro: 'A foto passa de 5 MB.' });
    res.status(400).json({ erro: 'Não consegui receber a foto.' });
  }), async (req, res) => {
    const ext = extensaoDaFoto(req);
    if (!ext) return res.status(415).json({ erro: 'Envie uma foto JPG ou PNG.' });
    let id;
    try { id = await fila().gravarFoto(req.body, ext); } catch (e) {
      if (e instanceof FotoIlegivel) return res.status(415).json({ erro: e.message });
      console.error('[uploads] não consegui gravar a foto:', e?.code || 'erro'); // sem caminho nem nome do arquivo
      return res.status(500).json({ erro: 'Não consegui guardar a foto.' });
    }
    res.json({ id });
  });
  app.get('/api/uploads/:id', async (req, res) => {
    if (!UPLOAD_ID.test(String(req.params.id))) return naoAchei(res);
    const foto = await fila().lerFoto(req.params.id);
    if (!foto) return naoAchei(res);
    res.set({ 'Content-Type': foto.tipo, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=3600' });
    res.send(foto.buf);
  });
}
