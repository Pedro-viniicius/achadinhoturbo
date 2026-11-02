// Testes do envio pelo WhatsApp: texto com e sem prévia, foto por URL ou Buffer, enquete e resolução de número.
// Nada aqui conecta ao WhatsApp: o modo simulado registra em `simulated`, e o "modo real" usa um socket falso.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateWAMessageContent } from '@whiskeysockets/baileys';
import { openDb, setSetting } from '../src/db.js';
import { createWhatsApp, montarEnquete, normalizarNumero } from '../src/whatsapp.js';
import { dayOf } from '../src/analytics.js';
import { viradaMin } from '../src/avisos.js';

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
    sendMessage: async (jid, conteudo) => { enviados.push({ jid, conteudo }); },
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
