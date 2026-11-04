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

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { addLog, getSetting } from './db.js';
import * as lojasPadrao from './lojas.js';
import { LinkNaoResolvido } from './amazon.js';
import { ErroShopee, LinkShopeeNaoResolvido, LINK_SHOPEE, RE_ID_AFILIADO, extrairIds } from './shopee.js';
import { montarEnquete } from './whatsapp.js';
import { renderTemplate, discountPct } from './template.js';
import { sleep, jitter } from './util.js';

const { PLATAFORMAS, LojaNaoConectada } = lojasPadrao;

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
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
const CAMPOS_OFERTA = ['key', 'title', 'price', 'oldPrice', 'discountPct', 'sold', 'freeShipping', 'coupon', 'image'];
const LINK_EXEMPLO = 'https://meli.la/(gerado no envio)';
const NAO_RECONHECI = 'Não reconheci este link. Cole o endereço completo da página do produto.';
const PERDEU = 'perdeu o horário: passou mais de 2 h (WhatsApp desconectado ou programa desligado).';
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
/** Link com a tag mascarada, para as prévias do painel (CA7): a tag só vai inteira ao WhatsApp. */
const mascararTag = (link) => String(link).replace(/([?&]tag=)[^&#]*/, '$1•••');

const pad = (n) => String(n).padStart(2, '0');
const hora = (ts) => { const d = new Date(ts); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const lerJson = (txt, padrao) => { try { return JSON.parse(txt) ?? padrao; } catch { return padrao; } };
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

/** Enquete com a mesma regra de quem envia (montarEnquete) mais os limites de tamanho. */
function validarEnquete(b) {
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
 * Nome da origem no log (log.rule_name): "Disparo manual", "Mensagem", "Enquete", "Espelho: <nome>" ou
 * "Catálogo: <regra>" (oferta do catálogo aprovada na revisão, src/catalogo-itens.js).
 */
function origemDoLog(tipo, p) {
  const prefixo = { espelho: 'Espelho', catalogo: 'Catálogo' }[p?.origem?.tipo];
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
 * src/shopee.js (createShopee); sem ele, oferta da Shopee é recusada. `lojas`: o módulo src/lojas.js (injetável nos
 * testes). O Identificar do Disparo manual (identificar) usa os mesmos ml/amazon/shopee/lojas do envio.
 */
export function createEnvios({ db, wa, links, ml, fast = false, dir = null, acordar = null, amazon = null, shopee = null, lojas = lojasPadrao } = {}) {
  const pastaFotos = dir ? path.join(dir, 'uploads') : null;
  const pausaEntreGrupos = () => (fast ? 0 : Number(getSetting(db, 'delay_group_s', 6)));
  // o modo em que o serviço de links vai gerar o link (src/links.js): simulação = links falsos, sem extensão
  const modoLink = () => links?.modo?.();
  let ultimaMensagem = 0; // quando este módulo mandou a última mensagem: o envio seguinte espera a pausa
  const lerEnvio = (id) => db.prepare('SELECT * FROM envios WHERE id = ?').get(id);
  const estadoDe = (id) => db.prepare('SELECT status, next_run_at FROM envios WHERE id = ?').get(id);
  const nomeDoGrupo = (jid) => db.prepare('SELECT name FROM groups WHERE jid = ?').get(jid)?.name ?? null;
  const okNaOcorrencia = (id, ocorrencia) => new Set(db.prepare('SELECT jid FROM envio_resultados WHERE envio_id = ? AND ocorrencia = ? AND ok = 1')
    .all(id, ocorrencia).map((r) => r.jid));
  const registrar = (id, ocorrencia, jid, nome, ok, erro) => db.prepare('INSERT INTO envio_resultados (envio_id, ocorrencia, ts, jid, group_name, ok, erro) VALUES (?,?,?,?,?,?,?)')
    .run(id, ocorrencia, Date.now(), jid, nome, ok ? 1 : 0, erro);
  const logDe = (e, p) => (o) => addLog(db, { rule: { id: null, name: origemDoLog(e.tipo, p) }, offer_title: tituloDe(e.tipo, p) || null, ...o });

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
    const texto = typeof b.texto === 'string' ? b.texto.replace(/\r\n/g, '\n').trim() : '';
    if (texto.length > MAX_TEXTO) throw new Error(`A mensagem passa de ${MAX_TEXTO} caracteres.`);
    const imagem = b.imagem == null || b.imagem === '' ? 'nenhuma' : b.imagem;
    if (!IMAGENS.includes(imagem)) throw new Error('Imagem: sem imagem, foto ou prévia do link.');
    if (!texto && imagem !== 'upload') throw new Error('Escreva a mensagem.');
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

  /** ASIN do link (encurtador: segue os redirecionamentos, só hosts da Amazon). Falha → LinkNaoResolvido. */
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

  /** Oferta da Amazon do disparo manual: ASIN, dados da API e os ajustes do painel. → campos do payload */
  async function ofertaAmazon(url, ajustes) {
    const asin = await asinDoLink(url);
    const { produto, causa } = await produtoAmazon(asin);
    const offer = aplicarAjustes(produto, ajustes);
    if (!offer.title) throw new Error(causa ? 'Não consegui buscar os dados na Amazon: preencha o título do produto.' : 'Preencha o título do produto.');
    return {
      asin, fonte_dados: !causa && igualAApi(produto, offer, ajustes) ? 'api' : 'manual',
      ...(ajustes.upload ? { upload: ajustes.upload } : {}), offer,
    };
  }

  /** ID de afiliado da Shopee salvo em Conexões (só a coluna `config`: nenhum segredo é lido). → texto ou '' */
  function idAfiliadoShopee() {
    const linha = db.prepare("SELECT config FROM conexoes WHERE plataforma = 'shopee'").get();
    const id = lerJson(linha?.config, null)?.id_afiliado;
    return typeof id === 'string' && RE_ID_AFILIADO.test(id.trim()) ? id.trim() : '';
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
   * Oferta da Shopee do disparo manual: ids, dados da API, os ajustes do painel e o link de afiliado, gerado por
   * último (só depois de a oferta estar válida). → campos do payload (a `url` passa a ser o endereço sem parâmetros)
   */
  async function ofertaShopee(url, ajustes) {
    const { ids, produto, causa } = await produtoShopee(url);
    if (causa === 'nao_encontrado') throw new ErroShopee('nao_encontrado'); // fora do programa: sem comissão
    const offer = aplicarAjustes(produto, ajustes);
    if (!offer.title) throw new Error(causa ? 'Não consegui buscar os dados na Shopee: preencha o título do produto.' : 'Preencha o título do produto.');
    const link = await linkShopee(ids.urlProduto);
    return {
      url: ids.urlProduto, shop_id: ids.shopId, item_id: ids.itemId, link_afiliado: link,
      fonte_dados: !causa && igualAApi(produto, offer, ajustes) ? 'api' : 'manual',
      ...(ajustes.upload ? { upload: ajustes.upload } : {}), offer,
    };
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
      pode_disparar: causa !== 'nao_encontrado' && !causaLink,
      texto: renderTemplate(template.body, { ...produto, link: LINK_EXEMPLO_SHOPEE }, tplOpts(db)),
    };
  }

  /**
   * POST /api/disparo/identificar: loja do link e, se integrada, o produto e o texto com o template.
   * Amazon: { loja, motivo:null, editavel:true, produto, causa, texto (tag mascarada), template_id, etiqueta:null,
   * tag_salva }. Sem tag → causa 'sem_tag' sem acessar a rede; link que não chega a um produto → 'invalido' ou
   * 'nao_produto' (produto null); API fora → produto com os campos nulos e a causa. Shopee: identificarShopee.
   */
  async function identificarLink(corpo) {
    const url = typeof corpo?.url === 'string' ? corpo.url.trim() : '';
    if (!url) throw new Error('Cole o link do produto.');
    const loja = url.length <= MAX_URL ? lojas.identificar(url) : null;
    if (!loja) throw new Error(NAO_RECONHECI);
    if (!loja.implementada) {
      return { loja, motivo: new LojaNaoConectada(loja).message, produto: null, texto: null, template_id: null, etiqueta: null };
    }
    const template = templateDe(db, corpo.template_id);
    if (loja.id === 'shopee') return identificarShopee(url, loja, template);
    if (loja.id === 'amazon') {
      if (!amazon) throw new Error(SEM_AMAZON);
      const base = { loja, motivo: null, editavel: true, produto: null, causa: null, texto: null, template_id: template.id, etiqueta: null, tag_salva: true };
      if (!temTagAmazon()) return { ...base, causa: 'sem_tag', tag_salva: false };
      let asin;
      try { asin = await asinDoLink(url); } catch (e) { return { ...base, causa: e.causa }; }
      const { produto, causa } = await produtoAmazon(asin);
      const link = mascararTag(amazon.montarLink(asin));
      return { ...base, produto, causa, texto: renderTemplate(template.body, { ...produto, link }, tplOpts(db)) };
    }
    const etiqueta = etiquetaDe(db, corpo.tag_id, { exigir: false });
    const produto = await lerOferta(loja.id, url, { ml, amazon, lojas });
    return {
      loja, motivo: null, editavel: false, causa: null, produto,
      texto: renderTemplate(template.body, { ...produto, link: LINK_EXEMPLO }, tplOpts(db)),
      template_id: template.id, etiqueta,
    };
  }

  /**
   * Valida o corpo de POST /api/envios por tipo (oferta|mensagem|enquete) e quando (agora|agendado|repetir),
   * resolve a oferta no servidor (o que o navegador manda não é confiável) e grava em `envios`.
   * "agora" grava `pendente` já vencido e chama acordar() (sai no tick do agendador, na fila); sem agendador,
   * processarPendentes() sem esperar. → { id, status, next_run_at }
   */
  async function criar(corpo, { userId = null } = {}) {
    const b = corpo && typeof corpo === 'object' && !Array.isArray(corpo) ? corpo : {};
    const tipo = b.tipo;
    if (!TIPOS.includes(tipo)) throw new Error('Tipo de envio inválido.');
    const quando = b.quando == null || b.quando === '' ? 'agora' : b.quando;
    if (!QUANDOS.includes(quando)) throw new Error('Quando enviar: agora, agendado ou repetir.');
    if (tipo === 'oferta' && quando === 'repetir') throw new Error('O disparo manual sai agora ou agendado para hoje.');

    // 1. conteúdo, sem rede (a loja não conectada é recusada aqui, antes de qualquer coisa: CA2)
    let conteudo;
    if (tipo === 'oferta') {
      const { url, loja } = lojaDoLink(b.url, lojas);
      conteudo = { url, loja, template: templateDe(db, b.template_id) };
      if (loja.id === 'amazon') {
        // a Amazon não tem etiqueta: o link leva a tag de associado de Conexões (sem ela, não dispara: CA2)
        if (!amazon) throw new Error(SEM_AMAZON);
        if (!temTagAmazon()) throw new Error(SEM_TAG);
        conteudo.ajustes = validarAjustes(b.ajustes);
      } else if (loja.id === 'shopee') {
        // a Shopee não tem etiqueta: o link sai com o ID de afiliado de Conexões, pela API ou pela extensão (CA3)
        if (!shopee) throw new Error(SEM_SHOPEE);
        if (!idAfiliadoShopee()) throw new Error(SEM_ID_SHOPEE);
        if (!caminhoLinkShopee()) throw new Error(SEM_LINK_SHOPEE);
        conteudo.ajustes = validarAjustes(b.ajustes);
      } else conteudo.etiqueta = etiquetaDe(db, b.tag_id);
    } else conteudo = tipo === 'mensagem' ? validarMensagem(b) : validarEnquete(b);
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
      const { url, loja, etiqueta, template } = conteudo;
      const base = {
        url, loja: loja.id, tag_id: etiqueta?.id ?? null, etiqueta: etiqueta?.name ?? null,
        template_id: template.id, template_criado_em: template.created_at, // created_at: ver preparar (Q6)
        origem: { tipo: 'manual' },
      };
      if (loja.id === 'amazon') payload = { ...base, ...(await ofertaAmazon(url, conteudo.ajustes)) };
      else if (loja.id === 'shopee') payload = { ...base, ...(await ofertaShopee(url, conteudo.ajustes)) };
      else {
        const lida = await lerOfertaComUrl(loja.id, url, { ml, amazon, lojas });
        payload = { ...base, url: lida.url, offer: lida.offer };
      }
    } else if (tipo === 'mensagem' && conteudo.imagem === 'previa') {
      const previa = await lerPrevia(conteudo.previa_url);
      // o WhatsApp liga a prévia ao link escrito na mensagem: se ele não estiver no texto, vai no fim
      const texto = conteudo.texto.includes(conteudo.previa_url) ? conteudo.texto : `${conteudo.texto}\n\n${conteudo.previa_url}`.trim();
      payload = { ...conteudo, texto, previa };
    } else payload = conteudo;

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

  /** O que vai a cada grupo, preparado uma vez por ocorrência. → { enviar(jid) → texto do log } */
  async function preparar(tipo, p) {
    if (tipo === 'oferta') {
      const ehAmazon = p.loja === 'amazon';
      const ehShopee = p.loja === 'shopee';
      // a etiqueta é a escolhida ao criar, pelo nome: se ela for apagada e outra herdar o id, a comissão não muda de dono.
      // Só o Mercado Livre tem etiqueta; a Amazon usa a tag de Conexões da hora do envio e a Shopee, o link gerado ao criar.
      const semEtiqueta = ehAmazon || ehShopee;
      const etiqueta = semEtiqueta ? null : p.etiqueta || (Number.isInteger(p.tag_id) && db.prepare('SELECT name FROM tags WHERE id = ?').get(p.tag_id)?.name);
      if (!semEtiqueta && !etiqueta) throw new Error('a etiqueta foi apagada');
      // o template é o mesmo id e a mesma criação (renomear ou editar não muda created_at; apagar e recriar muda)
      const tpl = Number.isInteger(p.template_id) && db.prepare('SELECT body, created_at FROM templates WHERE id = ?').get(p.template_id);
      if (!tpl || (p.template_criado_em != null && tpl.created_at !== p.template_criado_em)) throw new Error('o template foi apagado');
      let link;
      try {
        // Shopee: o link gerado ao criar (API ou extensão), conferido de novo; nada de rede nem de link montado aqui
        if (ehShopee && !(typeof p.link_afiliado === 'string' && LINK_SHOPEE.test(p.link_afiliado))) throw new Error('o link da Shopee guardado no envio não é válido');
        // catálogo (plano fonte-catalogo-etiqueta, D4): o ML nunca sai com link comum, nem se o modo mudou depois da revisão
        if (p.origem?.tipo === 'catalogo' && !semEtiqueta && !['extension', 'fake'].includes(modoLink())) throw new Error('os links do Mercado Livre estão no modo direto (sem comissão)');
        if (ehAmazon && !amazon) throw new Error(SEM_AMAZON);
        // sem ASIN válido no payload, nada de resolver link na hora do envio: só o ASIN gravado ao criar vale
        if (ehAmazon && !RE_ASIN.test(String(p.asin ?? ''))) throw new Error('o produto da Amazon está sem ASIN');
        // Amazon: sempre https://www.amazon.com.br/dp/<ASIN>?tag=<tag>, montado do ASIN (nunca o link que veio)
        if (ehShopee) link = p.link_afiliado;
        else if (ehAmazon) link = await lojas.linkAfiliado('amazon', { url: urlDoAsin(p.asin), asin: p.asin }, { links, amazon });
        else link = await lojas.linkAfiliado(p.loja, { url: p.url, tag: etiqueta }, { links, amazon });
      } catch (e) {
        throw new Error(`link de afiliado não gerado: ${e?.message || 'erro desconhecido'}`);
      }
      const texto = renderTemplate(tpl.body, { ...p.offer, link }, tplOpts(db));
      // foto: a enviada pelo painel (Buffer) ou a URL que a loja devolveu, só de CDN permitido (o Baileys baixa a URL)
      let foto = null; let mimetype = null;
      if (p.enviar_foto !== false && p.upload) {
        const m = UPLOAD_ID.exec(String(p.upload));
        if (!m || !pastaFotos) throw new Error('a foto não foi encontrada');
        try { foto = await fs.promises.readFile(path.join(pastaFotos, m[0])); } catch { throw new Error('a foto não foi encontrada (foi apagada?)'); }
        mimetype = MIME[m[1]];
      } else if (p.enviar_foto !== false && p.offer?.image && lojas.imagemPermitida(p.loja, p.offer.image)) foto = p.offer.image;
      const ok = ehAmazon ? 'Enviado com a tag de associado da Amazon'
        : ehShopee ? 'Enviado com o link de afiliado da Shopee' : `Enviado com a etiqueta ${etiqueta}`;
      return {
        async enviar(jid) {
          if (foto) {
            try { await wa.sendImage(jid, foto, texto, ...(mimetype ? [{ mimetype }] : [])); return ok; } catch { /* cai para o texto, como as regras */ }
            await wa.sendText(jid, texto); return `${ok} (sem a foto: ela não carregou)`;
          }
          await wa.sendText(jid, texto); return ok;
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
   */
  function finalizar(e, ocorrencia, { ok, erro, motivo }) {
    const fim = Date.now();
    db.prepare('UPDATE envios SET last_run_at = ?, resultado = ? WHERE id = ? AND next_run_at = ?')
      .run(fim, JSON.stringify(motivo ? { ok, erro, motivo } : { ok, erro }), e.id, ocorrencia);
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
   * → { ok, erro } da ocorrência, ou { pulado: true } se outro já está enviando ou a ocorrência mudou.
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
    let ok = 0; let erro = 0; let motivo = null;
    try {
      const jids = lerJson(e.group_jids, []);
      const feitos = okNaOcorrencia(n, ocorrencia); // retomada: quem já recebeu nesta ocorrência não recebe de novo
      const faltam = jids.filter((j) => !feitos.has(j));
      ok = jids.length - faltam.length;
      let envio = null;
      if (faltam.length) {
        try { envio = await preparar(e.tipo, p); } catch (err) { motivo = limparErro(err?.message); }
      }
      if (faltam.length && !envio) {
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
          const jid = faltam[i]; const nome = nomeDoGrupo(jid);
          try {
            const detalhe = await envio.enviar(jid);
            registrar(n, ocorrencia, jid, nome, true, null); ok++;
            log({ level: 'ok', group_name: nome, message: detalhe });
          } catch (err) {
            const m = limparErro(err?.message);
            registrar(n, ocorrencia, jid, nome, false, m); erro++;
            log({ level: 'erro', group_name: nome, message: `Falha no envio: ${m}` });
          }
          ultimaMensagem = Date.now();
          if (i < faltam.length - 1) await sleep(jitter(pausa));
        }
      }
    } catch (err) {
      // falha inesperada (banco, JSON): registra e não deixa o envio preso em 'enviando'
      motivo = limparErro(err?.message); erro = Math.max(erro, 1);
      log({ level: 'erro', message: `Falha no envio: ${motivo}` });
    } finally {
      finalizar(e, ocorrencia, { ok, erro, motivo });
    }
    return { ok, erro };
  }

  /** Agendado que perdeu o horário: o único vira erro; o repetido pula para a próxima ocorrência. */
  function perdeuHorario(e, now) {
    const log = logDe(e, lerJson(e.payload, {}));
    if (e.quando === 'repetir') {
      const prox = proximaOcorrencia(lerJson(e.repetir, null), now);
      const r = db.prepare("UPDATE envios SET status = ?, next_run_at = ? WHERE id = ? AND status = 'pendente' AND next_run_at = ?")
        .run(prox ? 'pendente' : 'concluido', prox, e.id, e.next_run_at);
      if (r.changes) log({ level: 'aviso', message: `Horário de ${hora(e.next_run_at)} pulado: ${PERDEU}${prox ? ` Próximo: ${hora(prox)}.` : ''}` });
      return;
    }
    const r = db.prepare("UPDATE envios SET status = 'erro', last_run_at = ?, resultado = ? WHERE id = ? AND status = 'pendente'")
      .run(Date.now(), JSON.stringify({ ok: 0, erro: 0, motivo: PERDEU }), e.id);
    if (r.changes) log({ level: 'erro', message: `Não enviado: ${PERDEU}` });
  }

  /**
   * Roda, um de cada vez, os envios 'pendente' com next_run_at vencido (e trata o horário perdido), com a pausa entre
   * grupos também entre um envio e o seguinte. → quantos rodaram
   */
  async function processarPendentes(now = Date.now()) {
    const vencidos = db.prepare(`SELECT id, tipo, quando, repetir, next_run_at, payload FROM envios
      WHERE status = 'pendente' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at, id`).all(now);
    let rodaram = 0;
    for (const e of vencidos) {
      if (now - e.next_run_at > ATRASO_MAX) { perdeuHorario(e, now); continue; }
      if (!wa.isReady()) continue; // espera o WhatsApp voltar (até 2 h)
      const espera = ultimaMensagem + jitter(pausaEntreGrupos()) - Date.now();
      if (espera > 0) await sleep(espera);
      try {
        const r = await runEnvio(e.id, { ocorrencia: e.next_run_at }); // pausado e retomado nesse meio-tempo: não sai agora
        if (!r.pulado) rodaram++;
      } catch (err) { console.error(`[envios] envio ${e.id}:`, limparErro(err?.message)); }
    }
    return rodaram;
  }

  /** Dados da tela: tipo 'oferta' (F1) ou 'mensagem' (F2: mensagens e enquetes). Contadores dos últimos 30 dias. */
  function painel(tipo) {
    const tipos = tipo === 'oferta' ? ['oferta'] : tipo === 'mensagem' ? ['mensagem', 'enquete'] : null;
    if (!tipos) throw new Error('Tipo inválido: use oferta ou mensagem.');
    const desde = Date.now() - 30 * DIA;
    const em = `e.tipo IN (${tipos.map(() => '?').join(',')})`;
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
      const faltam = jids.filter((j) => !feitos.has(j));
      if (!faltam.length) continue;
      naFila += faltam.length;
      fila.push({ ...cabecalho(e), quando: e.next_run_at ?? e.created_at, grupo: grupoDe(faltam), grupos: faltam.length, status: e.status, erro: null });
    }
    const resultados = db.prepare(`SELECT r.ts, r.jid, r.group_name, r.ok, r.erro, e.id, e.tipo, e.payload
      FROM envio_resultados r JOIN envios e ON e.id = r.envio_id WHERE ${em} ORDER BY r.ts DESC, r.id DESC LIMIT 20`).all(...tipos)
      .map((r) => ({ ...cabecalho(r), quando: r.ts, grupo: r.group_name || nomeDe(r.jid), grupos: 1, status: r.ok ? 'enviado' : 'erro', erro: r.ok ? null : r.erro }));
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
