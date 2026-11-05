// Testes do envio pelo WhatsApp: texto com e sem prévia, foto por URL ou Buffer, enquete e resolução de número.
// Nada aqui conecta ao WhatsApp: o modo simulado registra em `simulated`, e o "modo real" usa um socket falso.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateWAMessageContent } from '@whiskeysockets/baileys';
import { openDb, setSetting } from '../src/db.js';
import libsignal from 'libsignal';
import { createWhatsApp, montarEnquete, normalizarNumero, textoDaMensagem, MAX_TEXTO_RECEBIDO, protegerConsole } from '../src/whatsapp.js';
import { dayOf } from '../src/analytics.js';
import { viradaMin } from '../src/avisos.js';

// rede bloqueada no arquivo inteiro (CA10): quem precisa de fetch usa t.mock.method; o último teste prova que o
// fetch global nunca foi chamado
const fetchOriginal = globalThis.fetch;
let chamadasGlobais = 0;
test.before(() => { globalThis.fetch = async () => { chamadasGlobais++; throw new Error('rede proibida no teste'); }; });
test.after(() => { globalThis.fetch = fetchOriginal; });

// pastas temporárias apagadas no fim do arquivo
const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-wa-')); pastas.push(p); return p; };
const GRUPO = '120363000000000001@g.us';

function simulado() {
  const dir = tmp(); const db = openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  return { wa, fechar: () => db.close() };
}

/** "Modo real" com um socket falso que guarda o que iria ao Baileys. */
function comSocketFalso({ onWhatsApp = async () => [] } = {}) {
  const dir = tmp(); const db = openDb(dir);
  const wa = createWhatsApp({ db, dir });
  const enviados = []; const consultas = [];
  wa._usarSocket({
    // como o Baileys, devolve a mensagem enviada com key.id
    sendMessage: async (jid, conteudo) => { enviados.push({ jid, conteudo }); return { key: { remoteJid: jid, fromMe: true, id: `ENVIADA${enviados.length}` } }; },
    onWhatsApp: async (...nums) => { consultas.push(nums); return onWhatsApp(...nums); },
  });
  return { wa, enviados, consultas, fechar: () => db.close() };
}

test('sendImage: Buffer registra mimetype e tamanho; URL continua como antes; entrada inválida é recusada', async () => {
  const { wa, fechar } = simulado();
  const foto = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  await wa.sendImage(GRUPO, foto, 'Legenda', { mimetype: 'image/png' });
  await wa.sendImage(GRUPO, 'https://http2.mlstatic.com/D_x.jpg', 'Oferta');
  assert.deepEqual(wa.simulated[0], { tipo: 'image', jid: GRUPO, text: 'Legenda', image: { bytes: 7 }, mimetype: 'image/png' });
  assert.deepEqual(wa.simulated[1], { tipo: 'image', jid: GRUPO, text: 'Oferta', image: 'https://http2.mlstatic.com/D_x.jpg' });
  await assert.rejects(wa.sendImage(GRUPO, Buffer.alloc(0), 'x'), /Imagem inválida/);
  await assert.rejects(wa.sendImage(GRUPO, foto, 'x', { mimetype: 'text/html' }), /Tipo de imagem inválido/);
  assert.equal(wa.simulated.length, 2, 'nada registrado nas recusas');
  fechar();
});

test('sendPoll: registra name/values/selectableCount; recusa 1 opção, 13 opções, repetidas e vazias', async () => {
  const { wa, fechar } = simulado();
  await wa.sendPoll(GRUPO, { pergunta: ' Qual oferta? ', opcoes: ['Fone', ' Mouse '] });
  await wa.sendPoll(GRUPO, { pergunta: 'Quais?', opcoes: ['A', 'B', 'C'], multipla: true });
  assert.deepEqual(wa.simulated[0], { tipo: 'poll', jid: GRUPO, text: 'Qual oferta?', poll: { name: 'Qual oferta?', values: ['Fone', 'Mouse'], selectableCount: 1 } });
  assert.deepEqual(wa.simulated[1].poll, { name: 'Quais?', values: ['A', 'B', 'C'], selectableCount: 0 });

  const doze = Array.from({ length: 12 }, (_, i) => `Opção ${i + 1}`);
  await wa.sendPoll(GRUPO, { pergunta: 'Limite', opcoes: doze });
  assert.equal(wa.simulated[2].poll.values.length, 12, '12 opções passam');

  await assert.rejects(wa.sendPoll(GRUPO, { pergunta: 'P', opcoes: ['Só uma'] }), /2 a 12 opções/);
  await assert.rejects(wa.sendPoll(GRUPO, { pergunta: 'P', opcoes: [...doze, 'Opção 13'] }), /2 a 12 opções/);
  await assert.rejects(wa.sendPoll(GRUPO, { pergunta: 'P', opcoes: ['Sim', 'Não', 'Sim'] }), /repetidas/);
  await assert.rejects(wa.sendPoll(GRUPO, { pergunta: 'P', opcoes: ['Sim', ' sim '] }), /repetidas/, 'maiúscula e espaço não disfarçam a repetição');
  await assert.rejects(wa.sendPoll(GRUPO, { pergunta: 'P', opcoes: ['Sim', '  '] }), /opção vazia/);
  await assert.rejects(wa.sendPoll(GRUPO, { pergunta: '  ', opcoes: ['A', 'B'] }), /pergunta/);
  await assert.rejects(wa.sendPoll(GRUPO, { pergunta: 'P' }), /2 a 12 opções/);
  assert.equal(wa.simulated.length, 3, 'nada registrado nas recusas');
  assert.throws(() => montarEnquete({ pergunta: 'P', opcoes: ['A'] }), /2 a 12/, 'a mesma validação fica exportada');
  fechar();
});

test('sendText: sem prévia registra só o texto; com prévia (objeto ou URL) registra a prévia', async () => {
  const { wa, fechar } = simulado();
  await wa.sendText(GRUPO, 'Oi, grupo! https://meli.la/abc');
  assert.deepEqual(wa.simulated[0], { tipo: 'text', jid: GRUPO, text: 'Oi, grupo! https://meli.la/abc' });

  const miniatura = Buffer.from([0xff, 0xd8, 0xff, 1]);
  await wa.sendText(GRUPO, 'Olha só https://meli.la/abc', { previa: { title: 'Fone Bluetooth', description: 'R$ 99', image: miniatura } });
  assert.deepEqual(wa.simulated[1].previa, { url: 'https://meli.la/abc', title: 'Fone Bluetooth', description: 'R$ 99', image: { bytes: 4 } });

  await wa.sendText(GRUPO, 'Sem link no texto', { previa: 'https://www.mercadolivre.com.br/p/MLB1' });
  assert.deepEqual(wa.simulated[2].previa, { url: 'https://www.mercadolivre.com.br/p/MLB1', title: 'www.mercadolivre.com.br', description: undefined, image: undefined });

  await wa.sendText(GRUPO, 'Sem link nenhum', { previa: { title: 'Sem URL' } });
  assert.equal(wa.simulated[3].previa, undefined, 'sem URL não há prévia');
  fechar();
});

test('resolverNumero: normaliza, põe o 55 e devolve o JID; número inválido é recusado sem ecoar o número', async () => {
  const { wa, fechar } = simulado();
  assert.deepEqual(await wa.resolverNumero('11999999999'), { jid: '5511999999999@s.whatsapp.net', existe: true });
  assert.equal((await wa.resolverNumero('(11) 99999-9999')).jid, '5511999999999@s.whatsapp.net');
  assert.equal((await wa.resolverNumero('+55 11 99999-9999')).jid, '5511999999999@s.whatsapp.net');
  assert.equal((await wa.resolverNumero('011 99999-9999')).jid, '5511999999999@s.whatsapp.net', 'zero de longa distância');
  assert.equal((await wa.resolverNumero('(55) 99999-9999')).jid, '5555999999999@s.whatsapp.net', 'DDD 55 (RS) sem o código do país');
  assert.equal(normalizarNumero('1133334444'), '551133334444', 'fixo com DDD');
  await assert.rejects(wa.resolverNumero('12345'), (e) => /Número inválido/.test(e.message) && !e.message.includes('12345'));
  await assert.rejects(wa.resolverNumero(''), /Número inválido/);
  fechar();
});

test('modo real (socket falso): o que vai ao Baileys e como o Baileys monta a mensagem', async () => {
  const { wa, enviados, fechar } = comSocketFalso();

  // texto comum: linkPreview null, e o Baileys não tenta gerar prévia (não carrega o link-preview-js)
  await wa.sendText(GRUPO, 'Oferta https://meli.la/abc');
  assert.deepEqual(enviados[0], { jid: GRUPO, conteudo: { text: 'Oferta https://meli.la/abc', linkPreview: null } });
  let chamouPrevia = false;
  const texto = await generateWAMessageContent(enviados[0].conteudo, { getUrlInfo: async () => { chamouPrevia = true; } });
  assert.equal(chamouPrevia, false, 'sem prévia o Baileys não busca a página');
  assert.equal(texto.extendedTextMessage.text, 'Oferta https://meli.la/abc');
  assert.equal(texto.extendedTextMessage.title, undefined);

  // texto com prévia
  await wa.sendText(GRUPO, 'Veja https://meli.la/abc', { previa: { url: 'https://www.mercadolivre.com.br/p/MLB1', title: 'Fone', description: 'R$ 99' } });
  assert.deepEqual(enviados[1].conteudo.linkPreview, { 'canonical-url': 'https://www.mercadolivre.com.br/p/MLB1', 'matched-text': 'https://meli.la/abc', title: 'Fone', description: 'R$ 99' });
  const comPrevia = await generateWAMessageContent(enviados[1].conteudo, { getUrlInfo: async () => { chamouPrevia = true; } });
  assert.equal(chamouPrevia, false);
  assert.equal(comPrevia.extendedTextMessage.title, 'Fone');
  assert.equal(comPrevia.extendedTextMessage.matchedText, 'https://meli.la/abc');

  // foto por Buffer e por URL
  const foto = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  await wa.sendImage(GRUPO, foto, 'Legenda', { mimetype: 'image/jpeg' });
  assert.deepEqual(enviados[2].conteudo, { image: foto, caption: 'Legenda', mimetype: 'image/jpeg' });
  await wa.sendImage(GRUPO, 'https://http2.mlstatic.com/D_x.jpg', 'Oferta');
  assert.deepEqual(enviados[3].conteudo, { image: { url: 'https://http2.mlstatic.com/D_x.jpg' }, caption: 'Oferta' });

  // enquete: uma escolha vira pollCreationMessageV3; múltipla, pollCreationMessage com 0
  await wa.sendPoll(GRUPO, { pergunta: 'Qual?', opcoes: ['A', 'B'] });
  await wa.sendPoll(GRUPO, { pergunta: 'Quais?', opcoes: ['A', 'B', 'C'], multipla: true });
  assert.deepEqual(enviados[4].conteudo, { poll: { name: 'Qual?', values: ['A', 'B'], selectableCount: 1 } });
  const uma = await generateWAMessageContent(enviados[4].conteudo, {});
  assert.equal(uma.pollCreationMessageV3.selectableOptionsCount, 1);
  assert.deepEqual(uma.pollCreationMessageV3.options.map((o) => o.optionName), ['A', 'B']);
  const varias = await generateWAMessageContent(enviados[5].conteudo, {});
  assert.equal(varias.pollCreationMessage.selectableOptionsCount, 0);
  assert.equal(varias.pollCreationMessage.name, 'Quais?');
  fechar();
});

test('modo real (socket falso): resolverNumero usa onWhatsApp e devolve o JID canônico (9º dígito)', async () => {
  const canonico = comSocketFalso({ onWhatsApp: async () => [{ jid: '551199999999@s.whatsapp.net', exists: true }] });
  assert.deepEqual(await canonico.wa.resolverNumero('(11) 99999-9999'), { jid: '551199999999@s.whatsapp.net', existe: true });
  assert.deepEqual(canonico.consultas, [['5511999999999']]);
  canonico.fechar();

  const naoExiste = comSocketFalso({ onWhatsApp: async () => [] });
  assert.deepEqual(await naoExiste.wa.resolverNumero('11999999999'), { jid: '5511999999999@s.whatsapp.net', existe: false });
  naoExiste.fechar();
});

test('modo real desconectado: todos os envios recusam com "WhatsApp desconectado"', async () => {
  const dir = tmp(); const db = openDb(dir);
  const wa = createWhatsApp({ db, dir });
  await assert.rejects(wa.sendText(GRUPO, 'x'), /WhatsApp desconectado/);
  await assert.rejects(wa.sendImage(GRUPO, Buffer.from([1]), 'x'), /WhatsApp desconectado/);
  await assert.rejects(wa.sendPoll(GRUPO, { pergunta: 'P', opcoes: ['A', 'B'] }), /WhatsApp desconectado/);
  await assert.rejects(wa.resolverNumero('11999999999'), /WhatsApp desconectado/);
  db.close();
});

test('prévia com miniatura: imagem boa vira jpegThumbnail; imagem ruim ou não https sai sem miniatura e não derruba o envio', async (t) => {
  let sharp;
  try { sharp = (await import('sharp')).default; } catch { t.skip('sharp não disponível (peer do Baileys)'); return; }
  const { wa, enviados, fechar } = comSocketFalso();
  const avisos = []; t.mock.method(console, 'warn', (...a) => avisos.push(a.join(' ')));

  const png = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#ff0000' } }).png().toBuffer();
  await wa.sendText(GRUPO, 'https://meli.la/abc', { previa: { title: 'Com foto', image: png } });
  const miniatura = enviados[0].conteudo.linkPreview.jpegThumbnail;
  assert.ok(Buffer.isBuffer(miniatura) && miniatura[0] === 0xff && miniatura[1] === 0xd8, 'miniatura em JPEG');
  assert.equal((await sharp(miniatura).metadata()).width, 192);

  await wa.sendText(GRUPO, 'https://meli.la/abc', { previa: { title: 'Imagem quebrada', image: Buffer.from('não é imagem') } });
  await wa.sendText(GRUPO, 'https://meli.la/abc', { previa: { title: 'Sem https', image: 'http://127.0.0.1/x.png' } });
  assert.equal(enviados.length, 3, 'os três foram enviados');
  assert.equal(enviados[1].conteudo.linkPreview.title, 'Imagem quebrada');
  assert.equal(enviados[1].conteudo.linkPreview.jpegThumbnail, undefined);
  assert.equal(enviados[2].conteudo.linkPreview.jpegThumbnail, undefined);
  assert.equal(avisos.length, 2);
  fechar();
});

// ---------- rodada 1 de correções (servidor): R7 e S20 ----------
test('R7: leitura conta 1× por pessoa por dia de negócio (virada 02:00): 01:00 e 03:00 do mesmo dia do calendário são 2', () => {
  const dir = tmp(); const db = openDb(dir);
  setSetting(db, 'virada_dia', '02:00');
  const leitura = (h) => ({ key: { remoteJid: GRUPO, fromMe: true }, receipt: { userJid: '5511999999999@s.whatsapp.net', readTimestamp: new Date(2026, 10, 2, h).getTime() / 1000 } });
  const dias = () => db.prepare('SELECT day FROM group_reads ORDER BY ts').all().map((r) => r.day);
  // como src/server.js monta: dia de negócio com a virada salva em Relatórios e avisos
  const wa = createWhatsApp({ db, dir, dryRun: true, diaDe: (ts) => dayOf(ts, viradaMin(db)) });
  wa._onReceipts([leitura(1), leitura(3), leitura(4)]);
  assert.deepEqual(dias(), ['2026-11-01', '2026-11-02'], '01:00 é do dia anterior; 03:00 e 04:00 contam uma vez');
  // sem diaDe: o dia do calendário, como antes
  db.exec('DELETE FROM group_reads');
  createWhatsApp({ db, dir, dryRun: true })._onReceipts([leitura(1), leitura(3)]);
  assert.deepEqual(dias(), ['2026-11-02']);
  db.close();
});

test('S20: a prévia só baixa imagem do mlstatic (a regra está no próprio baixarImagem); outro host nem chega ao fetch', async (t) => {
  const pedidos = [];
  t.mock.method(globalThis, 'fetch', async (u) => { pedidos.push(String(u)); throw new Error('rede proibida no teste'); });
  const avisos = []; t.mock.method(console, 'warn', (...a) => avisos.push(a.join(' ')));
  const { wa, enviados, fechar } = comSocketFalso();
  for (const image of ['https://evil.example/x.jpg', 'https://mlstatic.com.evil.example/x.jpg', 'https://127.0.0.1/x.jpg']) {
    await wa.sendText(GRUPO, 'https://meli.la/abc', { previa: { title: 'Fone', image } });
  }
  assert.deepEqual(pedidos, [], 'nenhum pedido para fora do Mercado Livre');
  assert.ok(avisos.every((a) => /só pode vir do Mercado Livre/.test(a)), avisos.join('\n'));
  await wa.sendText(GRUPO, 'https://meli.la/abc', { previa: { title: 'Fone', image: 'https://http2.mlstatic.com/D_x.jpg' } });
  assert.deepEqual(pedidos, ['https://http2.mlstatic.com/D_x.jpg'], 'o mlstatic continua permitido');
  assert.equal(enviados.length, 4, 'todos saem, sem miniatura');
  assert.ok(enviados.every((e) => e.conteudo.linkPreview.jpegThumbnail === undefined));
  fechar();
});

// ---------- etapa 5 do espelhamento da Amazon: ouvinte de mensagens dos grupos (CA9, CA11) ----------
const PESSOA = '5511988887777@s.whatsapp.net';
const LINK = 'https://link.amazon/xyz';
/** Um WAMessage do Baileys como chega no messages.upsert, com participante e pushName (que nunca podem sair). */
const recebida = (message, { id = 'MSG1', jid = GRUPO, fromMe = false, ts = 1793620000 } = {}) => ({
  key: { remoteJid: jid, fromMe, id, participant: PESSOA, participantPn: PESSOA },
  pushName: 'Maria da Silva', participant: PESSOA, messageTimestamp: ts, message,
});
function ouvinte(opcoes = {}) {
  const dir = tmp(); const db = openDb(dir);
  const recebidas = [];
  const wa = createWhatsApp({ db, dir, dryRun: true, onMensagem: (m) => { recebidas.push(m); }, ...opcoes });
  return { wa, recebidas, fechar: () => db.close() };
}

test('textoDaMensagem: cada formato do Baileys vira o texto; sem texto, string vazia', () => {
  const texto = `Fone por R$ 99 ${LINK}`;
  assert.equal(textoDaMensagem({ conversation: texto }), texto);
  assert.equal(textoDaMensagem({ extendedTextMessage: { text: texto, matchedText: LINK, canonicalUrl: 'https://www.amazon.com.br/dp/B0ABCDEFGH' } }), texto, 'texto com link: não repete o da prévia');
  assert.equal(textoDaMensagem({ extendedTextMessage: { text: 'Fone por R$ 99', matchedText: LINK } }), `Fone por R$ 99\n${LINK}`, 'link só na prévia');
  assert.equal(textoDaMensagem({ extendedTextMessage: { text: 'Fone', canonicalUrl: LINK } }), `Fone\n${LINK}`);
  assert.equal(textoDaMensagem({ extendedTextMessage: { text: 'Só texto' } }), 'Só texto');
  assert.equal(textoDaMensagem({ imageMessage: { caption: texto, mimetype: 'image/jpeg' } }), texto);
  assert.equal(textoDaMensagem({ videoMessage: { caption: texto } }), texto);
  assert.equal(textoDaMensagem({ documentWithCaptionMessage: { message: { documentMessage: { caption: texto } } } }), texto);
  assert.equal(textoDaMensagem({ ephemeralMessage: { message: { extendedTextMessage: { text: texto } } } }), texto);
  assert.equal(textoDaMensagem({ viewOnceMessage: { message: { imageMessage: { caption: texto } } } }), texto);
  assert.equal(textoDaMensagem({ viewOnceMessageV2: { message: { imageMessage: { caption: texto } } } }), texto);
  assert.equal(textoDaMensagem({ ephemeralMessage: { message: { viewOnceMessageV2: { message: { videoMessage: { caption: texto } } } } } }), texto, 'embrulho dentro de embrulho');
  for (const vazio of [null, undefined, 'texto solto', {}, { imageMessage: {} }, { reactionMessage: { text: '👍' } },
    { protocolMessage: { type: 14, editedMessage: { conversation: texto } } }, { conversation: 42 }, { extendedTextMessage: { text: { x: 1 } } }]) {
    assert.equal(textoDaMensagem(vazio), '', JSON.stringify(vazio));
  }
});

test('onMensagem: cada formato chega como o mesmo { jid, fromMe, texto, msgId, ts }, sem participante nem pushName (CA11)', () => {
  const { wa, recebidas, fechar } = ouvinte();
  const texto = `Fone por R$ 99 ${LINK}`;
  const formatos = [
    { conversation: texto },
    { extendedTextMessage: { text: texto, matchedText: LINK } },
    { imageMessage: { caption: texto } },
    { videoMessage: { caption: texto } },
    { documentWithCaptionMessage: { message: { documentMessage: { caption: texto } } } },
    { ephemeralMessage: { message: { conversation: texto } } },
    { viewOnceMessageV2: { message: { imageMessage: { caption: texto } } } },
  ];
  wa._onMensagens({ type: 'notify', messages: formatos.map((m, i) => recebida(m, { id: `M${i}` })) });
  assert.equal(recebidas.length, formatos.length);
  recebidas.forEach((r, i) => {
    assert.deepEqual(r, { jid: GRUPO, fromMe: false, texto, msgId: `M${i}`, ts: 1793620000 * 1000 });
    assert.deepEqual(Object.keys(r).sort(), ['fromMe', 'jid', 'msgId', 'texto', 'ts']);
  });
  const cru = JSON.stringify(recebidas);
  assert.ok(!cru.includes('5511988887777') && !cru.includes('Maria') && !/participant|pushName/.test(cru), 'nada da pessoa sai do ouvinte');
  fechar();
});

test('onMensagem: append, conversa privada, status, sem id e sem texto são ignorados', () => {
  const { wa, recebidas, fechar } = ouvinte();
  const msg = { conversation: `Oferta ${LINK}` };
  wa._onMensagens({ type: 'append', messages: [recebida(msg, { id: 'HIST' })] });
  wa._onMensagens({ type: 'notify', messages: [
    recebida(msg, { id: 'PV', jid: PESSOA }),
    recebida(msg, { id: 'LID', jid: '123456789@lid' }),
    recebida(msg, { id: 'ST', jid: 'status@broadcast' }),
    recebida(msg, { id: '' }),
    { key: { remoteJid: GRUPO }, message: msg },
    recebida({ reactionMessage: { text: '👍' } }, { id: 'REACAO' }),
    recebida(null, { id: 'STUB' }),
    null,
  ] });
  wa._onMensagens(undefined); wa._onMensagens({ type: 'notify' }); wa._onMensagens({ type: 'notify', messages: 'x' });
  assert.deepEqual(recebidas, []);
  fechar();
});

test('onMensagem: fromMe chega como está (quem decide é o espelho); ts sem valor ou como Long', () => {
  const { wa, recebidas, fechar } = ouvinte();
  const antes = Date.now();
  wa._onMensagens({ type: 'notify', messages: [
    recebida({ conversation: 'minha' }, { id: 'A', fromMe: true }),
    recebida({ conversation: 'long' }, { id: 'B', ts: { toNumber: () => 1793620001, low: 1, high: 0 } }),
    recebida({ conversation: 'texto' }, { id: 'C', ts: '1793620002' }),
    recebida({ conversation: 'sem ts' }, { id: 'D', ts: null }),
  ] });
  assert.equal(recebidas[0].fromMe, true);
  assert.equal(recebidas[1].fromMe, false);
  assert.equal(recebidas[1].ts, 1793620001000);
  assert.equal(recebidas[2].ts, 1793620002000);
  assert.ok(recebidas[3].ts >= antes && recebidas[3].ts <= Date.now());
  fechar();
});

test('onMensagem: id de mensagem que o próprio programa enviou é ignorado ao voltar pelo upsert (CA9, anti-laço)', async () => {
  const dir = tmp(); const db = openDb(dir);
  const recebidas = [];
  const wa = createWhatsApp({ db, dir, onMensagem: (m) => recebidas.push(m) });
  const enviados = [];
  wa._usarSocket({ sendMessage: async (jid, conteudo) => { enviados.push(conteudo); return { key: { remoteJid: jid, fromMe: true, id: `NOSSA${enviados.length}` } }; } });
  await wa.sendImage(GRUPO, 'https://http2.mlstatic.com/D_x.jpg', `Oferta ${LINK}`);
  await wa.sendText(GRUPO, `Oferta ${LINK}`);
  await wa.sendPoll(GRUPO, { pergunta: 'Qual?', opcoes: ['A', 'B'] });
  wa._onMensagens({ type: 'notify', messages: [
    recebida({ imageMessage: { caption: `Oferta ${LINK}` } }, { id: 'NOSSA1', fromMe: true }),
    recebida({ conversation: `Oferta ${LINK}` }, { id: 'NOSSA2', fromMe: true }),
    recebida({ conversation: 'enquete' }, { id: 'NOSSA3', fromMe: true }),
    recebida({ conversation: `Do celular ${LINK}` }, { id: 'DO-CELULAR', fromMe: true }),
  ] });
  assert.deepEqual(recebidas.map((r) => r.msgId), ['DO-CELULAR'], 'só a mensagem que não saiu do programa');

  // guarda só os últimos 1000 ids: o mais antigo sai
  for (let i = 0; i < 1000; i++) await wa.sendText(GRUPO, 'x');
  recebidas.length = 0;
  wa._onMensagens({ type: 'notify', messages: [recebida({ conversation: 'a' }, { id: 'NOSSA1' }), recebida({ conversation: 'b' }, { id: 'NOSSA1003' })] });
  assert.deepEqual(recebidas.map((r) => r.msgId), ['NOSSA1']);

  // sendMessage sem retorno (ou sem key) não quebra o envio
  wa._usarSocket({ sendMessage: async () => undefined });
  await wa.sendText(GRUPO, 'ok');
  db.close();
});

test('onMensagem: erro no handler (síncrono ou assíncrono) não derruba o ouvinte nem vaza o texto no console', async (t) => {
  const erros = []; t.mock.method(console, 'error', (...a) => erros.push(a.join(' ')));
  const vistas = [];
  const { wa, fechar } = ouvinte({ onMensagem: (m) => {
    vistas.push(m.msgId);
    if (m.msgId === 'SINC') throw new Error('falhou');
    if (m.msgId === 'ASSINC') return Promise.reject(new Error('falhou depois'));
  } });
  const segredo = `texto-da-pessoa ${LINK}`;
  assert.doesNotThrow(() => wa._onMensagens({ type: 'notify', messages: [
    recebida({ conversation: segredo }, { id: 'SINC' }),
    recebida({ conversation: segredo }, { id: 'ASSINC' }),
    recebida({ conversation: segredo }, { id: 'DEPOIS' }),
  ] }));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(vistas, ['SINC', 'ASSINC', 'DEPOIS'], 'as mensagens seguintes continuam chegando');
  assert.equal(erros.length, 2);
  assert.ok(erros.every((e) => e.startsWith('[espelho]') && !e.includes('texto-da-pessoa') && !e.includes('5511988887777')), erros.join('\n'));
  assert.deepEqual(erros, ['[espelho] erro no handler: Error', '[espelho] erro no handler: Error'], 'só o nome do erro (S7)');
  fechar();
});

test('S7: erro cuja mensagem carrega o texto recebido (SyntaxError do JSON.parse, Error com o texto) vai ao console só pelo nome', async (t) => {
  const erros = []; t.mock.method(console, 'error', (...a) => erros.push(a.join(' ')));
  const { wa, fechar } = ouvinte({ onMensagem: (m) => {
    if (m.msgId === 'JSON') JSON.parse(m.texto);
    if (m.msgId === 'ECO') return Promise.reject(new Error(`não entendi: ${m.texto}`));
    if (m.msgId === 'NOME') { const e = new Error('x'); e.name = `Nome ${m.texto}`; throw e; }
    if (m.msgId === 'NADA') throw null; // valor lançado sem nome
  } });
  const segredo = `{texto-da-pessoa 5511988887777 ${LINK}`;
  wa._onMensagens({ type: 'notify', messages: ['JSON', 'ECO', 'NOME', 'NADA'].map((id) => recebida({ conversation: segredo }, { id })) });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(erros.sort(), [
    '[espelho] erro no handler: Error', '[espelho] erro no handler: Error',
    '[espelho] erro no handler: Error', '[espelho] erro no handler: SyntaxError',
  ]);
  assert.ok(erros.every((e) => !e.includes('texto-da-pessoa') && !e.includes('5511988887777') && !e.includes('amazon')));
  fechar();
});

test('S1: texto recebido é cortado em 4.096 caracteres antes do handler (mensagem de 100 k caracteres)', () => {
  assert.equal(MAX_TEXTO_RECEBIDO, 4096);
  const { wa, recebidas, fechar } = ouvinte();
  const grande = `${LINK} ${'a'.repeat(100_000)}`;
  wa._onMensagens({ type: 'notify', messages: [
    recebida({ conversation: grande }, { id: 'CONV' }),
    recebida({ extendedTextMessage: { text: 'b'.repeat(100_000), canonicalUrl: LINK } }, { id: 'EXT' }),
    recebida({ imageMessage: { caption: grande } }, { id: 'IMG' }),
    recebida({ conversation: 'curta' }, { id: 'CURTA' }),
  ] });
  assert.deepEqual(recebidas.map((r) => r.texto.length), [4096, 4096, 4096, 5]);
  assert.equal(recebidas[0].texto, grande.slice(0, 4096));
  assert.ok(recebidas[0].texto.startsWith(LINK), 'o começo (com o link) é preservado');
  fechar();
});

test('onMensagem(handler): troca ou desliga quem recebe; sem handler nada é processado', () => {
  const dir = tmp(); const db = openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true });
  const lote = (id) => ({ type: 'notify', messages: [recebida({ conversation: 'oi' }, { id })] });
  assert.doesNotThrow(() => wa._onMensagens(lote('X')));
  const recebidas = [];
  wa.onMensagem((m) => recebidas.push(m.msgId));
  wa._onMensagens(lote('Y'));
  wa.onMensagem(null);
  wa._onMensagens(lote('Z'));
  assert.deepEqual(recebidas, ['Y']);
  db.close();
});

// ---------- envio pelo sócio, etapa 3 (D1): ouvinte da conversa privada (CA2, CA3, CA9) ----------
const SOCIO = '5535999990000@s.whatsapp.net';
const SOCIO_LID = '187654321098765@lid';
const LINK_ML = 'https://mercadolivre.com/sec/abc123';
/** Mensagem privada como chega no messages.upsert, com pushName (que nunca pode sair do ouvinte). */
const privada = (message, { id = 'PV1', jid = SOCIO, alt, fromMe = false, ts = 1793620000 } = {}) => ({
  key: { remoteJid: jid, ...(alt ? { remoteJidAlt: alt } : {}), fromMe, id, addressingMode: jid.endsWith('@lid') ? 'lid' : 'pn' },
  pushName: 'João Sócio', messageTimestamp: ts, message,
});
/** Modo real com socket falso; `lidMapping` é o `signalRepository.lidMapping` do Baileys (ou null para não ter). */
function ouvintePrivado({ lidMapping = null, user, privado, grupo } = {}) {
  const dir = tmp(); const db = openDb(dir);
  const privadas = []; const grupos = [];
  const wa = createWhatsApp({ db, dir, onMensagem: grupo || ((m) => { grupos.push(m); }) });
  wa.onPrivada(privado || ((m) => { privadas.push(m); }));
  const enviados = [];
  wa._usarSocket({
    ...(user ? { user } : {}),
    ...(lidMapping ? { signalRepository: { lidMapping } } : {}),
    sendMessage: async (jid, conteudo) => { enviados.push(conteudo); return { key: { remoteJid: jid, fromMe: true, id: `NOSSA${enviados.length}` } }; },
  });
  return { wa, privadas, grupos, fechar: () => db.close() };
}

test('onPrivada: número comum (PN) chega como { ids, texto, msgId, ts }, sem pushName (CA3, CA9)', async () => {
  const { wa, privadas, grupos, fechar } = ouvintePrivado();
  const texto = `Olha esse ${LINK_ML}`;
  await wa._onMensagens({ type: 'notify', messages: [
    privada({ conversation: texto }, { id: 'PN1' }),
    privada({ extendedTextMessage: { text: texto } }, { id: 'PN2', jid: '5535999990000:7@s.whatsapp.net' }),
  ] });
  assert.deepEqual(privadas, [
    { ids: [SOCIO], texto, msgId: 'PN1', ts: 1793620000 * 1000 },
    { ids: [SOCIO], texto, msgId: 'PN2', ts: 1793620000 * 1000 },
  ], 'o :device sai (bareJid)');
  assert.deepEqual(Object.keys(privadas[0]).sort(), ['ids', 'msgId', 'texto', 'ts']);
  assert.ok(!JSON.stringify(privadas).includes('João'), 'pushName nunca sai do ouvinte');
  assert.deepEqual(grupos, [], 'privado não vai ao ouvinte de grupos');
  fechar();
});

// R3 (rodada 2, desvio da D1): com o número no remoteJid, o LID do remoteJidAlt (atributo do servidor) também vai em
// `ids`, para o remetente aprender o LID (src/remetentes.js só aprende quando casou pelo número).
test('onPrivada: o remoteJidAlt completa o par: LID + número, ou número + LID; alt de outro tipo fica de fora (CA3)', async () => {
  let consultas = 0;
  const { wa, privadas, fechar } = ouvintePrivado({ lidMapping: { getPNForLID: async () => { consultas++; return null; } } });
  await wa._onMensagens({ type: 'notify', messages: [
    privada({ conversation: LINK_ML }, { id: 'L1', jid: '187654321098765:3@lid', alt: '5535999990000:3@s.whatsapp.net' }),
    privada({ conversation: LINK_ML }, { id: 'L2', jid: SOCIO, alt: '187654321098765:5@lid' }),
    privada({ conversation: LINK_ML }, { id: 'L3', jid: SOCIO, alt: '5535999998888@s.whatsapp.net' }), // número com número: fica só o remoteJid
    privada({ conversation: LINK_ML }, { id: 'L4', jid: SOCIO, alt: '120363000000000000@g.us' }),
    privada({ conversation: LINK_ML }, { id: 'L5', jid: SOCIO_LID, alt: '207000000000001@lid' }), // LID com LID: vai ao mapa
    privada({ conversation: LINK_ML }, { id: 'L6', jid: SOCIO, alt: SOCIO }),
  ] });
  // L5 espera o mapa (assíncrono) e chega depois: a ordem é a do msgId
  assert.deepEqual(privadas.map((p) => [p.msgId, p.ids]).sort(([a], [b]) => a.localeCompare(b)), [
    ['L1', [SOCIO_LID, SOCIO]], ['L2', [SOCIO, SOCIO_LID]], ['L3', [SOCIO]], ['L4', [SOCIO]], ['L5', [SOCIO_LID]], ['L6', [SOCIO]],
  ]);
  assert.equal(consultas, 1, 'com o número no remoteJidAlt, o mapa nem é consultado; o número no remoteJid também não pede o mapa');
  fechar();
});

test('onPrivada: LID sem remoteJidAlt é resolvido pelo getPNForLID do Baileys (CA3)', async () => {
  const pedidos = [];
  const { wa, privadas, fechar } = ouvintePrivado({ lidMapping: { getPNForLID: async (lid) => { pedidos.push(lid); return '5535999990000:0@s.whatsapp.net'; } } });
  await wa._onMensagens({ type: 'notify', messages: [privada({ conversation: LINK_ML }, { id: 'L3', jid: SOCIO_LID })] });
  assert.deepEqual(pedidos, [SOCIO_LID]);
  assert.deepEqual(privadas, [{ ids: [SOCIO_LID, SOCIO], texto: LINK_ML, msgId: 'L3', ts: 1793620000 * 1000 }]);
  fechar();
});

test('onPrivada: LID sem mapa chega só com o LID, sem lançar nem escrever no console (CA3, CA9)', async (t) => {
  const saida = []; for (const n of ['log', 'info', 'warn', 'error']) t.mock.method(console, n, (...a) => saida.push(a.join(' ')));
  const mapas = [
    { getPNForLID: async () => null },
    { getPNForLID: async () => { throw new Error(`falhou ${SOCIO_LID}`); } },
    { getPNForLID: () => { throw new Error('síncrono'); } },
    { getPNForLID: async () => '5535999990000@hosted' }, // não é número de WhatsApp comum
    { getPNForLID: async () => ({ jid: SOCIO }) }, // formato inesperado
    null, // socket sem signalRepository
  ];
  for (const lidMapping of mapas) {
    const { wa, privadas, fechar } = ouvintePrivado({ lidMapping });
    await wa._onMensagens({ type: 'notify', messages: [privada({ conversation: LINK_ML }, { id: 'L4', jid: SOCIO_LID })] });
    assert.deepEqual(privadas.map((p) => p.ids), [[SOCIO_LID]], JSON.stringify(lidMapping && Object.keys(lidMapping)));
    fechar();
  }
  // modo simulado: não há socket nem mapa
  const dir = tmp(); const db = openDb(dir);
  const recebidas = [];
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  wa.onPrivada((m) => recebidas.push(m));
  await wa._onMensagens({ type: 'notify', messages: [privada({ conversation: LINK_ML }, { id: 'L5', jid: SOCIO_LID })] });
  assert.deepEqual(recebidas.map((p) => p.ids), [[SOCIO_LID]]);
  db.close();
  assert.deepEqual(saida, [], 'nada no console');
});

test('onPrivada: fromMe, status, canal, grupo, append, sem texto e o que o programa enviou nunca chegam (CA2)', async () => {
  const { wa, privadas, fechar } = ouvintePrivado();
  await wa.sendText(SOCIO, 'Enviado para 3 grupos.'); // volta pelo upsert como NOSSA1
  const msg = { conversation: `Oferta ${LINK_ML}` };
  await wa._onMensagens({ type: 'append', messages: [privada(msg, { id: 'HIST' })] });
  await wa._onMensagens({ type: 'notify', messages: [
    privada(msg, { id: 'MEU', fromMe: true }),
    privada(msg, { id: 'MEU-LID', jid: SOCIO_LID, alt: SOCIO, fromMe: true }),
    privada(msg, { id: 'NOSSA1' }),
    privada(msg, { id: 'ST', jid: 'status@broadcast', alt: SOCIO }),
    privada(msg, { id: 'LISTA', jid: '1793620000@broadcast' }),
    privada(msg, { id: 'CANAL', jid: '120363000000000099@newsletter' }),
    privada(msg, { id: 'GRUPO', jid: GRUPO }),
    privada(msg, { id: 'BOT', jid: '13135550002@bot' }),
    privada(msg, { id: 'HOSTED', jid: '187654321098765@hosted.lid' }),
    privada(msg, { id: 'ESTRANHO', jid: 'abc@s.whatsapp.net' }),
    privada(msg, { id: '' }),
    privada({ reactionMessage: { text: '👍' } }, { id: 'REACAO' }),
    privada(null, { id: 'STUB' }),
    { key: { remoteJid: SOCIO, id: 'SEM-MSG' } },
    { key: { remoteJid: 42, id: 'JID-NUMERO' }, message: msg },
    null,
  ] });
  await wa._onMensagens(undefined); await wa._onMensagens({ type: 'notify' }); await wa._onMensagens({ type: 'notify', messages: 'x' });
  assert.deepEqual(privadas, []);
  fechar();
});

test('onPrivada: grupo continua indo só ao onMensagem, e o privado só ao onPrivada (D1)', async () => {
  const { wa, privadas, grupos, fechar } = ouvintePrivado();
  await wa._onMensagens({ type: 'notify', messages: [
    recebida({ conversation: `Grupo ${LINK}` }, { id: 'G1' }),
    privada({ conversation: `Privado ${LINK_ML}` }, { id: 'P1' }),
    recebida({ conversation: 'minha no grupo' }, { id: 'G2', fromMe: true }),
  ] });
  assert.deepEqual(grupos.map((g) => g.msgId), ['G1', 'G2'], 'o ouvinte de grupos segue igual (fromMe chega como está)');
  assert.deepEqual(Object.keys(grupos[0]).sort(), ['fromMe', 'jid', 'msgId', 'texto', 'ts']);
  assert.deepEqual(privadas.map((p) => p.msgId), ['P1']);

  // só o privado ligado: grupo não é entregue a ninguém
  wa.onMensagem(null); grupos.length = 0; privadas.length = 0;
  await wa._onMensagens({ type: 'notify', messages: [recebida({ conversation: 'g' }, { id: 'G3' }), privada({ conversation: 'p' }, { id: 'P2' })] });
  assert.deepEqual([grupos.length, privadas.map((p) => p.msgId)], [0, ['P2']]);
  fechar();
});

test('onPrivada: handler que lança (síncrono, assíncrono ou com o texto no nome) não derruba o ouvinte; console só com e.name (CA9)', async (t) => {
  const saida = []; for (const n of ['log', 'info', 'warn', 'error']) t.mock.method(console, n, (...a) => saida.push(a.join(' ')));
  const vistas = [];
  const { wa, fechar } = ouvintePrivado({
    lidMapping: { getPNForLID: async () => SOCIO },
    privado: (m) => {
      vistas.push(m.msgId);
      if (m.msgId === 'SINC') throw new Error(`falhou ${m.ids.join(',')} ${m.texto}`);
      if (m.msgId === 'ASSINC') return Promise.reject(new Error(`depois ${m.ids[0]}`));
      if (m.msgId === 'JSON') JSON.parse(m.texto);
      if (m.msgId === 'NOME') { const e = new Error('x'); e.name = `Nome ${m.ids[0]}`; throw e; }
      if (m.msgId === 'NADA') throw null;
    },
  });
  const segredo = `{texto-do-socio ${LINK_ML}`;
  let retorno;
  assert.doesNotThrow(() => { retorno = wa._onMensagens({ type: 'notify', messages: ['SINC', 'ASSINC', 'JSON', 'NOME', 'NADA', 'DEPOIS']
    .map((id) => privada({ conversation: segredo }, { id, jid: SOCIO_LID })) }); });
  await retorno;
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(vistas, ['SINC', 'ASSINC', 'JSON', 'NOME', 'NADA', 'DEPOIS'], 'as mensagens seguintes continuam chegando');
  assert.deepEqual(saida.sort(), [
    '[remetente] erro no handler: Error', '[remetente] erro no handler: Error', '[remetente] erro no handler: Error',
    '[remetente] erro no handler: Error', '[remetente] erro no handler: SyntaxError',
  ]);
  for (const proibido of ['5535999990000', '187654321098765', 'texto-do-socio', 'mercadolivre', 'João']) {
    assert.ok(!saida.join('\n').includes(proibido), `vazou ${proibido}`);
  }
  fechar();
});

test('onPrivada(handler): troca ou desliga quem recebe; sem handler nada é entregue nem consultado', async () => {
  let consultas = 0;
  const { wa, privadas, fechar } = ouvintePrivado({ lidMapping: { getPNForLID: async () => { consultas++; return SOCIO; } } });
  const lote = (id) => ({ type: 'notify', messages: [privada({ conversation: 'oi' }, { id, jid: SOCIO_LID })] });
  wa.onPrivada(null);
  await wa._onMensagens(lote('X'));
  assert.equal(consultas, 0, 'desligado: nem consulta o mapa');
  const outras = [];
  wa.onPrivada((m) => outras.push(m.msgId));
  await wa._onMensagens(lote('Y'));
  wa.onPrivada('não é função');
  await wa._onMensagens(lote('Z'));
  assert.deepEqual([privadas.length, outras], [0, ['Y']]);
  fechar();
});

test('lidDe: LID do número pelo getLIDForPN do Baileys; null no modo simulado, sem mapa ou em falha (D2)', async (t) => {
  const saida = []; for (const n of ['log', 'info', 'warn', 'error']) t.mock.method(console, n, (...a) => saida.push(a.join(' ')));
  const pedidos = [];
  const { wa, fechar } = ouvintePrivado({ lidMapping: { getLIDForPN: async (pn) => { pedidos.push(pn); return '187654321098765:4@lid'; } } });
  assert.equal(await wa.lidDe(SOCIO), SOCIO_LID, 'sem o :device');
  assert.equal(await wa.lidDe('5535999990000:2@s.whatsapp.net'), SOCIO_LID);
  assert.deepEqual(pedidos, [SOCIO, SOCIO]);
  for (const invalido of [null, undefined, '', 42, GRUPO, SOCIO_LID, 'status@broadcast']) assert.equal(await wa.lidDe(invalido), null, String(invalido));
  assert.equal(pedidos.length, 2, 'entrada que não é número nem chega ao Baileys');
  fechar();

  for (const lidMapping of [
    { getLIDForPN: async () => null },
    { getLIDForPN: async () => { throw new Error(`USYNC falhou ${SOCIO}`); } },
    { getLIDForPN: () => { throw new Error('síncrono'); } },
    { getLIDForPN: async () => SOCIO }, // não é LID
    null,
  ]) {
    const x = ouvintePrivado({ lidMapping });
    assert.equal(await x.wa.lidDe(SOCIO), null);
    x.fechar();
  }
  const { wa: sim, fechar: fecharSim } = simulado();
  assert.equal(await sim.lidDe(SOCIO), null, 'modo simulado');
  fecharSim();
  assert.deepEqual(saida, []);
});

test('meuJid: o número conectado sem o :device; null desconectado e no modo simulado', () => {
  const { wa, fechar } = ouvintePrivado({ user: { id: '5535911112222:12@s.whatsapp.net', lid: '99887766554433:12@lid' } });
  assert.equal(wa.meuJid(), '5535911112222@s.whatsapp.net');
  fechar();
  const { wa: semUser, fechar: f2 } = ouvintePrivado();
  assert.equal(semUser.meuJid(), null);
  f2();
  const dir = tmp(); const db = openDb(dir);
  const desligado = createWhatsApp({ db, dir });
  assert.equal(desligado.meuJid(), null);
  const { wa: sim, fechar: f3 } = simulado();
  assert.equal(sim.meuJid(), null, 'modo simulado não tem número');
  f3(); db.close();
});

test('R9 (decisão documentada): link sem esquema no texto não impede o link da prévia; os dois saem (a etapa 11 deduplica por ASIN)', () => {
  const canonico = 'https://www.amazon.com.br/dp/B0ABCDEFGH';
  assert.equal(textoDaMensagem({ extendedTextMessage: { text: 'Fone amzn.to/x', canonicalUrl: canonico } }), `Fone amzn.to/x\n${canonico}`);
});

// ---------------------------------------------------------------- S1 (rodada 1 de correção): sessão do Signal fora do journal
/** Sessão falsa da libsignal com chaves marcadas, para procurar os valores (texto, hex e base64) no que foi escrito. */
function sessaoFalsa() {
  const chaves = { privKey: 'PRIVKEYzzSEGREDO1', rootKey: 'ROOTKEYzzSEGREDO2', chainKey: 'CHAINKEYzSEGREDO3', baseKey: 'BASEKEYzzSEGREDO4', remoteIdentityKey: 'REMOTEIDzSEGREDO5' };
  const b = Object.fromEntries(Object.entries(chaves).map(([k, v]) => [k, Buffer.from(v)]));
  const s = libsignal.SessionRecord.createEntry();
  s.indexInfo = { baseKey: b.baseKey, baseKeyType: 1, closed: -1, used: 1, created: 1, remoteIdentityKey: b.remoteIdentityKey };
  s.currentRatchet = { rootKey: b.rootKey, ephemeralKeyPair: { privKey: b.privKey, pubKey: Buffer.from('pub') }, lastRemoteEphemeralKey: Buffer.from('last'), previousCounter: 0 };
  s._chains = { abc: { chainKey: { counter: 0, key: b.chainKey }, chainType: 1, messageKeys: {} } };
  const proibidos = [...Object.keys(chaves), ...Object.values(b).flatMap((x) => [x.toString(), x.toString('hex'), x.toString('base64'), [...x].map((n) => n.toString(16).padStart(2, '0')).join(' ')])];
  return { s, proibidos };
}

/** Roda `fn` (síncrona) com o stdout e o stderr do processo capturados; devolve o que o console escreveu. */
function capturarSaida(fn) {
  const escrito = [];
  const { write: out } = process.stdout; const { write: err } = process.stderr;
  process.stdout.write = (c) => { escrito.push(String(c)); return true; };
  process.stderr.write = (c) => { escrito.push(String(c)); return true; };
  try { fn(); } finally { process.stdout.write = out; process.stderr.write = err; }
  return escrito.join('');
}

test('S1: a libsignal fecha, reabre e descarta sessões sem escrever as chaves no console (o journal do serviço)', () => {
  const { s, proibidos } = sessaoFalsa();
  const velha = sessaoFalsa().s; velha.indexInfo.closed = 1; velha.indexInfo.baseKey = Buffer.from('outraBase');
  const rec = new libsignal.SessionRecord();
  const saida = capturarSaida(() => {
    rec.setSession(s);
    rec.closeSession(s); // "Closing session:", sessão
    rec.closeSession(s); // "Session already closed", sessão
    rec.openSession(s); // "Opening session:", sessão
    for (let i = 0; i < 40; i++) { const x = sessaoFalsa().s; x.indexInfo.closed = i + 1; x.indexInfo.baseKey = Buffer.from(`b${i}`); rec.setSession(x); }
    rec.setSession(velha);
    rec.removeOldSessions(); // "Removing old closed session:", sessão
    console.info('captura viva', 42); // prova de que a captura pega o que o console escreve
  });
  assert.equal(saida, 'captura viva 42\n');
  for (const p of proibidos) assert.ok(!saida.includes(p), `vazou ${p}`);
});

test('S1: o resto do console segue igual; objeto com cara de sessão do Signal vira [omitido]; o filtro nunca lança', () => {
  const linhas = [];
  const falso = {};
  for (const n of ['log', 'info', 'warn', 'error', 'debug']) falso[n] = (...a) => { linhas.push([n, ...a]); };
  assert.equal(protegerConsole(falso), falso);
  const embrulhadas = { ...falso };
  assert.equal(protegerConsole(falso), falso, 'idempotente');
  assert.deepEqual({ ...falso }, embrulhadas, 'a segunda chamada não embrulha de novo');
  const { s, proibidos } = sessaoFalsa();
  const erro = new Error('boom');
  falso.info('Closing session:', s);
  falso.warn('Session already open');
  falso.warn('Closing open session in favor of incoming prekey bundle');
  falso.error('Session error:Error: Bad MAC', 'stack');
  falso.error('Failed to decrypt message with any known session...');
  falso.warn('Decrypted message with closed session.');
  falso.info('Migrating session to:', 'v1');
  falso.error('[espelho] erro no handler:', 'TypeError');
  falso.error('[grupos]', erro);
  falso.log('%o', s);
  falso.log('registro', { record: { sessions: { k: s } } }, 7);
  falso.debug('getter', { get privKey() { throw new Error('não leia'); } });
  falso.warn('proxy', new Proxy({}, { ownKeys() { throw new Error('não liste'); } }));
  falso.log('grande', Array.from({ length: 2000 }, () => ({ a: 1 })));
  falso.log('normal', { a: 1 }, Buffer.from('x'));
  assert.deepEqual(linhas, [
    ['error', '[espelho] erro no handler:', 'TypeError'],
    ['error', '[grupos]', erro],
    ['log', '%o', '[omitido]'],
    ['log', 'registro', '[omitido]', 7],
    ['debug', 'getter', '[omitido]'],
    ['warn', 'proxy', '[omitido]'],
    ['log', 'grande', '[omitido]'],
    ['log', 'normal', { a: 1 }, Buffer.from('x')],
  ]);
  const texto = JSON.stringify(linhas);
  for (const p of proibidos) assert.ok(!texto.includes(p), `vazou ${p}`);
  assert.doesNotThrow(() => protegerConsole(null));
});

test('CA10: nenhum teste deste arquivo chamou o fetch global', () => {
  assert.equal(chamadasGlobais, 0);
});
