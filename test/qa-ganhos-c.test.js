// QA da Entrega C do Dashboard de ganhos (plano dashboard-ganhos-c; CA2 e CA5 do brief) e dos formatos reais dos portais
// (docs/produto/referencias/relatorios-dos-portais.md, P5). Foco em PONTA A PONTA: o arquivo entra pela rota
// POST /api/ganhos/importar do servidor de verdade (buildApp) e sai por GET /api/ganhos com os valores certos; o painel
// é conferido num Chrome headless real quando o critério depende dele (parte 2, no fim do arquivo).
// Cabeçalhos são os reais do P5; os VALORES são inventados (nenhum dado de comprador). Nada acessa a rede: o fetch global
// é trocado por um que falha, o WhatsApp é simulado e os links são falsos.
// Um teste que falha aqui é bug do produto: não relaxe a asserção.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { buildApp } from '../src/server.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createLinkService } from '../src/links.js';
import { createScheduler } from '../src/scheduler.js';
import { createEnvios } from '../src/envios.js';
import { createShopee } from '../src/shopee.js';
import * as rastreio from '../src/rastreio.js';
import { importar } from '../src/importador.js';
import { atribuir, metricas, lerConsulta } from '../src/ganhos.js';

// o fetch global falha (nenhum teste acessa a rede); só a conversa local com o Chrome (127.0.0.1) usa o original
const fetchLocal = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('rede proibida no teste'); };

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pastas = [];
const filhos = [];
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));
const encerrar = async (filho) => {
  if (!filho || filho.exitCode != null || filho.signalCode != null) return;
  const saiu = new Promise((r) => filho.once('exit', r));
  try { process.kill(-filho.pid, 'SIGKILL'); } catch { try { filho.kill('SIGKILL'); } catch { /* já saiu */ } }
  await Promise.race([saiu, dorme(3000)]);
};
after(async () => { for (const f of filhos) await encerrar(f); for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-ganhos-c-')); pastas.push(p); return p; };
const linhas = (db, sql, ...a) => db.prepare(sql).all(...a).map((r) => ({ ...r }));
const contar = (db, tabela) => db.prepare(`SELECT COUNT(*) AS n FROM ${tabela}`).get().n;
const csv = (...l) => Buffer.from(l.join('\r\n') + '\r\n', 'utf8');
const quase = (a, b, msg) => assert.ok(typeof a === 'number' && Math.abs(a - b) < 1e-9, `${msg}: ${a} ≈ ${b}`);

/** .zip com um único arquivo, montado entrada por entrada (deflate), como o relatório da Amazon chega. */
function zip(nome, texto) {
  const dados = Buffer.isBuffer(texto) ? texto : Buffer.from(texto, 'utf8'); const n = Buffer.from(nome, 'utf8'); const comp = zlib.deflateRawSync(dados); const crc = zlib.crc32(dados);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(dados.length, 22); local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(dados.length, 24); central.writeUInt16LE(n.length, 28);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0); fim.writeUInt16LE(1, 8); fim.writeUInt16LE(1, 10);
  fim.writeUInt32LE(46 + n.length, 12); fim.writeUInt32LE(30 + n.length + comp.length, 16);
  return Buffer.concat([local, n, comp, central, n, fim]);
}

const G1 = '111@g.us'; const G2 = '222@g.us'; const G3 = '333@g.us';
const NOV = (dia, h = 12) => new Date(2026, 10, dia, h).getTime();
const PERIODO_NOV = 'periodo=custom&de=2026-11-01&ate=2026-11-30';

/**
 * Banco com G1 e G2 no bloco 1 (B1), G3 solto, a etiqueta `geral` e as associações: Amazon B1→turbob1-20 e G3→g3-20,
 * Shopee B1→casa. Os envios de 1º/11/2026 (antes de qualquer venda dos arquivos) é que dão a atribuição (D6).
 */
function montarDb({ envios = true } = {}) {
  const dir = tmp(); const db = openDb(dir);
  for (const [jid, nome] of [[G1, 'Achadinhos'], [G2, 'Tech'], [G3, 'Casa']]) db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, nome, 10, Date.now());
  db.prepare("INSERT INTO blocks (id, name, created_at) VALUES (1, 'B1', 1)").run();
  for (const jid of [G1, G2]) db.prepare('INSERT INTO block_groups (block_id, jid) VALUES (1, ?)').run(jid);
  db.prepare("INSERT INTO tags (name, created_at) VALUES ('geral', 1)").run();
  rastreio.salvar(db, { loja: 'shopee', alvo_tipo: 'bloco', alvo: '1', codigo: 'casa' });
  rastreio.salvar(db, { loja: 'amazon', alvo_tipo: 'bloco', alvo: '1', codigo: 'turbob1-20' });
  rastreio.salvar(db, { loja: 'amazon', alvo_tipo: 'grupo', alvo: G3, codigo: 'g3-20' });
  if (envios) {
    const e = (jid, loja, codigo, nivel, extra = {}) => rastreio.registrar(db, { ts: NOV(1), jid, loja, origem: 'regra', link: `https://exemplo.invalid/${loja}/${codigo}`, codigo, nivel, esperado: 1, ...extra });
    for (const jid of [G1, G2]) {
      e(jid, 'amazon', 'turbob1-20', 'bloco', { bloco_id: 1, oferta_chave: 'ASIN:B0TESTE001' });
      e(jid, 'shopee', 'casa', 'bloco', { bloco_id: 1, oferta_chave: 'SHOPEE:1.2' });
    }
    e(G3, 'amazon', 'g3-20', 'grupo', { oferta_chave: 'ASIN:B0TESTE002' });
  }
  return { dir, db };
}

// ------------------------------------------------------------------------------------------------ servidor HTTP

/** buildApp de verdade (Host/Origin, JSON global, rotas), sem login: o Dono é quem usa o computador. */
async function subir(opcoes = {}) {
  const { dir, db } = montarDb(opcoes);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const scheduler = createScheduler({ db, wa, links, fast: true });
  const app = buildApp({ db, wa, links, scheduler, publicHost: '', panelPassword: '', dataDir: dir, ml: {} });
  return new Promise((ok) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      ok({ db, dir, port, fechar: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => { db.close(); r(); }); }) });
    });
  });
}
function pedir(s, caminho, { method = 'GET', corpo = null, tipo, headers = {} } = {}) {
  return new Promise((ok, err) => {
    const data = corpo == null ? null : Buffer.isBuffer(corpo) ? corpo : Buffer.from(typeof corpo === 'string' ? corpo : JSON.stringify(corpo));
    const h = { origin: `http://127.0.0.1:${s.port}`, ...headers };
    if (data) { h['content-type'] = tipo ?? (Buffer.isBuffer(corpo) || typeof corpo === 'string' ? 'text/csv' : 'application/json'); h['content-length'] = data.length; }
    const r = http.request({ host: '127.0.0.1', port: s.port, path: caminho, method, headers: h }, (res) => {
      let txt = ''; res.setEncoding('utf8'); res.on('data', (c) => (txt += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(txt); } catch { /* não é JSON */ } ok({ status: res.statusCode, json, txt }); });
    });
    r.on('error', err); if (data) r.write(data); r.end();
  });
}
/** Importa pela rota (`extra` vai na query: `&tipo=cliques&codigo=x&dia=…&previa=1`). */
const importarPor = (s, loja, buf, extra = '') => pedir(s, `/api/ganhos/importar?loja=${loja}${extra}`, { method: 'POST', corpo: buf });
const ok200 = async (s, loja, buf, extra = '') => {
  const r = await importarPor(s, loja, buf, extra);
  assert.equal(r.status, 200, r.txt);
  return r.json;
};
const ganhos = async (s, por, extra = '', periodo = PERIODO_NOV) => {
  const r = await pedir(s, `/api/ganhos?${periodo}&por=${por}${extra}`);
  assert.equal(r.status, 200, r.txt);
  return r.json;
};
const linhaDe = (r, campo, valor) => {
  const l = r.linhas.find((x) => x[campo] === valor);
  assert.ok(l, `linha ${campo}=${valor} em por=${r.por}: ${JSON.stringify(r.linhas.map((x) => x[campo]))}`);
  return l;
};
const diaDe = (r, dia) => linhaDe(r, 'dia', dia);

// ------------------------------------------------------------------------------------------------ relatórios (cabeçalhos reais, P5)

// Amazon "Produto relacionado" (Linked-Product): cabeçalho em inglês, data MM-DD-AAAA, números com ponto, "-" para vazio,
// "Other" para os cliques sem produto. Não há coluna de ID de rastreamento por linha: vale o "Código do arquivo".
const CAB_LP = 'Date,Category,Product Title,ASIN,Clicks,Indirect Items Ordered,Direct Items Ordered,Items Ordered,Direct Conversion Rate,Order Quantity,Product Conversion Rate,Order Conversion Rate,Commission Rate,Ordered Revenue,Items Shipped,Items Returned,Items Shipped Revenue,Items Shipped Earnings,Items Returned Revenue,Items Returned Earnings,Total Earnings';
/** Uma linha do Linked-Product: (data, categoria, título, ASIN, cliques, enviados, devolvidos, receita enviada, ganho enviado, ganho total). */
const lp = (data, cat, titulo, asin, cliques, enviados, devolvidos, receita, ganhoEnviado, total) => [
  data, cat, titulo, asin, cliques, '0.0', '0.0', '0.0', '0', '0.0', '0', '0', '-', receita, enviados, devolvidos, receita, ganhoEnviado, '0.0', '0.0', total].join(',');
const LP_LINHAS = [
  lp('11-04-2026', 'Cozinha', 'Panela inventada', 'B0TESTE001', '10.0', '2.0', '0.0', '180.0', '9.0', '9.0'),
  lp('11-13-2026', 'Casa', '"Fone, sem fio inventado"', 'B0TESTE002', '20.0', '1.0', '0.0', '50.0', '2.5', '2.5'), // dia 13: só existe como MM-DD
  lp('11-04-2026', '-', '-', 'Other', '245.0', '0.0', '0.0', '0.0', '0.0', '0'), // os cliques sem produto
  lp('11-13-2026', '-', '-', 'Other', '5.0', '0.0', '0.0', '0.0', '0.0', '0'),
  lp('11-05-2026', 'Livros', 'Livro inventado', 'B0TESTE003', '7.0', '1.0', '1.0', '30.0', '1.5', '1.5'), // devolvido por inteiro: cancelada
];
const NOME_ZIP = '1234-Linked-Product-0f0f0f0f-aaaa-bbbb-cccc-000000000000-CSV.csv';
const ZIP_LP = () => zip(NOME_ZIP, [CAB_LP, ...LP_LINHAS].join('\n') + '\n');

// Amazon "ID de rastreamento" (Tracking-Id): cabeçalho em português, SEM coluna de data, um total do período por ID.
const CAB_TID = 'Número de rastreamento,cliques,produtos pedidos,receita solicitada,produtos enviados,produtos devolvidos,receita de produtos enviados,receita de produtos devolvidos,ganhos totais,bônus,ganhos de produtos enviados,ganhos de produtos devolvidos';
const TID = () => csv(CAB_TID,
  'turbob1-20,157.0,4.0,200.0,3.0,0.0,150.0,0.0,12.0,0.0,12.0,0.0',
  'g3-20,40.0,-,-,-,-,-,-,-,0.0,-,-',
  'desejodemen01-20,30.0,-,-,-,-,-,-,-,0.0,-,-');

// Shopee "Relatório de cliques": uma linha por clique, sem total. A Shopee não deixa ver o cabeçalho do arquivo (P5):
// as colunas da tela são `ID dos Cliques, Período dos Cliques, Região dos Cliques, Sub_id, Referenciador`.
const CAB_CLIQUES_SHOPEE = 'ID dos Cliques,Período dos Cliques,Região dos Cliques,Sub_id,Referenciador';
const CLIQUES_SHOPEE = () => csv(CAB_CLIQUES_SHOPEE,
  'c001,2026-11-04 10:15:32,MG,casa,https://exemplo.invalid/ref1',
  'c002,2026-11-04 11:00:00,SP,casa,https://exemplo.invalid/ref2',
  'c003,2026-11-04 23:59:59,RJ,casa,',
  'c004,2026-11-04 12:00:00,MG,Casa,', // outra caixa: na Shopee o Sub_id é exato
  'c005,2026-11-05 00:00:01,MG,casa,',
  'c006,2026-11-05 09:00:00,MG,,', // sem Sub_id
  ',2026-11-05 09:00:00,MG,casa,'); // sem ID do clique: não é clique

// ================================================================================================
// 1. Amazon "Produto relacionado": .zip, comissões E cliques com o mesmo Código do arquivo, datas MM-DD-AAAA
// ================================================================================================

test('CA5 + P5: o .zip do "Produto relacionado" da Amazon entra como comissões e como cliques e o dashboard mostra o certo no bloco do código', async () => {
  const s = await subir();
  try {
    const c = await ok200(s, 'amazon', ZIP_LP(), '&codigo=turbob1-20');
    assert.deepEqual([c.lidas, c.novas, c.atualizadas, c.repetidas, c.ignoradas], [5, 3, 0, 0, 0], 'as 5 linhas leem (data MM-DD-AAAA, "-" e título com vírgula); as 2 "Other" só têm cliques (R2) e ficam de fora');
    assert.equal(c.so_cliques, 2, 'as 2 linhas "Other" (comissão, venda e quantidade 0) contam em so_cliques, não em puladas');
    assert.deepEqual(c.periodo, { de: '2026-11-04', ate: '2026-11-13' }, '11-13-2026 é 13 de novembro: o dia 13 só existe como mês-dia');
    assert.equal(c.comissao_centavos, 900 + 250, 'a devolvida por inteiro (cancelada) não soma');
    assert.deepEqual(c.avisos, ['O arquivo não tem coluna de status: as vendas entram como pendentes.',
      '2 linhas só têm cliques (sem venda nem comissão) e ficaram de fora. Os cliques entram ao importar o arquivo como cliques.']);
    assert.ok(c.colunas_usadas.some((x) => x.campo === 'comissao' && x.coluna === 'Total Earnings'), 'Total Earnings vence Items Shipped Earnings');
    assert.ok(c.colunas_usadas.some((x) => x.campo === 'venda' && x.coluna === 'Items Shipped Revenue'));
    assert.deepEqual(c.codigos_desconhecidos, [], 'turbob1-20 é código de bloco conhecido');
    // as linhas gravadas: a "Other" (cliques sem produto) NÃO é gravada em comissoes (R2); o "-" não vira texto
    const g = linhas(s.db, 'SELECT data, codigo, produto, titulo, quantidade, venda_centavos, comissao_centavos, status FROM comissoes ORDER BY data, produto');
    assert.deepEqual(g.map((x) => [x.data, x.produto, x.titulo, x.quantidade, x.venda_centavos, x.comissao_centavos, x.status]), [
      ['2026-11-04', 'B0TESTE001', 'Panela inventada', 2, 18000, 900, 'pendente'],
      ['2026-11-05', 'B0TESTE003', 'Livro inventado', 1, 3000, 150, 'cancelada'], // devolvida por inteiro: a quantidade fica, o status cancela
      ['2026-11-13', 'B0TESTE002', 'Fone, sem fio inventado', 1, 5000, 250, 'pendente'],
    ]);
    assert.equal(linhas(s.db, 'SELECT COUNT(*) AS n FROM comissoes WHERE quantidade = 0 AND venda_centavos = 0 AND comissao_centavos = 0')[0].n, 0, 'nenhuma linha zerada no banco');
    assert.equal(linhas(s.db, 'SELECT ignoradas FROM importacoes')[0].ignoradas, 2, 'no histórico, as só de cliques vão com as puladas');
    assert.ok(g.every((x) => x.codigo === 'turbob1-20'));

    // o MESMO .zip como cliques (mesmo Código do arquivo): outro tipo, não é "já importado"
    const k = await ok200(s, 'amazon', ZIP_LP(), '&tipo=cliques&codigo=turbob1-20');
    assert.deepEqual([k.tipo, k.lidas, k.novas, k.ja_importado], ['cliques', 5, 3, false], 'cliques por dia (4, 5 e 13/11)');
    assert.equal(k.cliques_total, 10 + 20 + 245 + 5 + 7, 'a linha Other conta: são os cliques sem produto');
    assert.deepEqual(k.periodo, { de: '2026-11-04', ate: '2026-11-13' });

    // dashboard: tudo atribuído ao B1 pelo código turbob1-20
    const porBloco = await ganhos(s, 'bloco');
    const b1 = linhaDe(porBloco, 'bloco_id', 1);
    assert.deepEqual([b1.comissao, b1.vendas, b1.receita, b1.cliques], [1150, 3, 23000, 287]);
    quase(b1.epc, 1150 / 287, 'EPC do B1');
    quase(b1.conversao, 3 / 287, 'conversão do B1');
    const t = porBloco.total;
    assert.deepEqual([t.comissao, t.comissao_confirmada, t.vendas, t.receita, t.cliques], [1150, 0, 3, 23000, 287]);
    assert.equal(t.atribuida, 1, 'nada ficou sem grupo');
    // por dia (a devolvida de 05/11 não soma comissão nem venda, mas os 7 cliques dela contam)
    const porDia = await ganhos(s, 'dia');
    assert.deepEqual([diaDe(porDia, '2026-11-04').comissao, diaDe(porDia, '2026-11-04').vendas, diaDe(porDia, '2026-11-04').cliques, diaDe(porDia, '2026-11-04').receita], [900, 2, 255, 18000]);
    assert.deepEqual([diaDe(porDia, '2026-11-05').comissao, diaDe(porDia, '2026-11-05').vendas, diaDe(porDia, '2026-11-05').cliques], [0, 0, 7]);
    assert.deepEqual([diaDe(porDia, '2026-11-13').comissao, diaDe(porDia, '2026-11-13').vendas, diaDe(porDia, '2026-11-13').cliques], [250, 1, 25]);
    assert.deepEqual([diaDe(porDia, '2026-11-12').comissao, diaDe(porDia, '2026-11-12').cliques], [0, 0], 'o dia 12 (que seria o 13 lido como dia-mês) fica vazio');
    // por oferta: só as duas com produto, com URL sem afiliado; a "Other" e a cancelada não viram oferta
    const porOferta = await ganhos(s, 'oferta');
    assert.deepEqual(porOferta.linhas.map((l) => [l.oferta, l.titulo, l.comissao, l.vendas, l.url]), [
      ['B0TESTE001', 'Panela inventada', 900, 2, 'https://www.amazon.com.br/dp/B0TESTE001'],
      ['B0TESTE002', 'Fone, sem fio inventado', 250, 1, 'https://www.amazon.com.br/dp/B0TESTE002'],
    ]);
    assert.ok(porOferta.linhas.every((l) => !/tag=|meli\.la|s\.shopee/.test(l.url)), 'a URL da oferta nunca é de afiliado');
    // o grupo em si não ganha nada sozinho (o código é do bloco)
    const porGrupo = await ganhos(s, 'grupo');
    for (const jid of [G1, G2]) assert.equal(linhaDe(porGrupo, 'jid', jid).comissao, 0);
    assert.deepEqual([porGrupo.nao_atribuida.linhas, porGrupo.nao_atribuida.comissao, porGrupo.nao_atribuida.cliques], [0, 0, 0]);
  } finally { await s.fechar(); }
});

test('P5: reimportar o MESMO .zip (comissões e cliques) não dobra nada no dashboard', async () => {
  const s = await subir();
  try {
    await ok200(s, 'amazon', ZIP_LP(), '&codigo=turbob1-20');
    await ok200(s, 'amazon', ZIP_LP(), '&tipo=cliques&codigo=turbob1-20');
    const antes = await ganhos(s, 'bloco');
    const c = await ok200(s, 'amazon', ZIP_LP(), '&codigo=turbob1-20');
    assert.deepEqual([c.novas, c.atualizadas, c.repetidas, c.ja_importado, c.outro_codigo, c.recebem_codigo], [0, 0, 3, true, 0, 0], 'as 2 só de cliques não viram "repetidas"');
    assert.equal(c.so_cliques, 2);
    assert.ok(c.avisos.includes('Este arquivo já foi importado antes. As linhas repetidas não mudam nada.'));
    const k = await ok200(s, 'amazon', ZIP_LP(), '&tipo=cliques&codigo=turbob1-20');
    assert.deepEqual([k.novas, k.atualizadas, k.repetidas, k.ja_importado], [0, 0, 3, true]);
    assert.deepEqual(await ganhos(s, 'bloco'), antes);
    assert.equal(contar(s.db, 'comissoes'), 3);
  } finally { await s.fechar(); }
});

test('P5: datas da Amazon: hífen é mês-dia-ano (13-11-2026 vira linha pulada), barra segue dia/mês; na Shopee o hífen segue dia-mês', async () => {
  const s = await subir();
  try {
    const amazon = await ok200(s, 'amazon', csv('Date,ASIN,Items Shipped,Total Earnings',
      '11-13-2026,B0TESTE001,1,"2.00"', '13/11/2026,B0TESTE002,1,"3.00"', '13-11-2026,B0TESTE003,1,"4.00"'), '&codigo=turbob1-20');
    assert.deepEqual([amazon.lidas, amazon.novas, amazon.ignoradas], [3, 2, 1], '13-11-2026 na Amazon é mês 13: não existe');
    assert.deepEqual(amazon.periodo, { de: '2026-11-13', ate: '2026-11-13' });
    const shopee = await ok200(s, 'shopee', csv('Hora do pedido,ID do item,ID da loja,Comissão total do item(R$),Sub_id1',
      '13-11-2026 10:00,2,1,"2,00",casa', '11-13-2026 10:00,2,1,"5,00",casa'), '');
    assert.deepEqual([shopee.lidas, shopee.novas, shopee.ignoradas], [2, 1, 1], 'na Shopee o hífen é dia-mês: 11-13-2026 é mês 13');
    assert.deepEqual(shopee.periodo, { de: '2026-11-13', ate: '2026-11-13' });
  } finally { await s.fechar(); }
});

// ================================================================================================
// 2. Amazon "ID de rastreamento": sem data, pede `dia`
// ================================================================================================

test('P5: "ID de rastreamento" da Amazon sem `dia` dá 400 com a frase (comissões e cliques) e não grava nada; `dia` inválido ou repetido também', async () => {
  const s = await subir();
  try {
    for (const extra of ['', '&tipo=cliques', '&codigo=turbob1-20']) {
      const r = await importarPor(s, 'amazon', TID(), extra);
      assert.equal(r.status, 400, extra);
      assert.equal(r.json.erro, 'Este relatório não tem data por linha: informe a data do relatório.', extra);
    }
    for (const dia of ['2026-02-30', '2026-13-01', '04-11-2026', '2026-11-4', 'hoje', '2026-11-04&dia=2026-11-05']) {
      const r = await importarPor(s, 'amazon', TID(), `&dia=${dia}`);
      assert.equal(r.status, 400, dia);
      assert.equal(r.json.erro, 'A data do relatório veio inválida ou repetida. Escolha uma data válida (AAAA-MM-DD).', dia);
    }
    assert.equal(contar(s.db, 'comissoes'), 0);
    assert.equal(contar(s.db, 'cliques_loja'), 0);
    assert.equal(contar(s.db, 'importacoes'), 0);
  } finally { await s.fechar(); }
});

test('P5: "ID de rastreamento" com `dia`: ganhos e cliques de cada ID caem no dia informado, no bloco/grupo do código', async () => {
  const s = await subir();
  try {
    const c = await ok200(s, 'amazon', TID(), '&dia=2026-11-10');
    assert.deepEqual([c.lidas, c.novas, c.ignoradas, c.so_cliques], [3, 1, 0, 2], 'g3-20 e desejodemen01-20 só têm cliques (R2): não entram em comissões');
    assert.deepEqual(c.periodo, { de: '2026-11-10', ate: '2026-11-10' });
    assert.equal(c.comissao_centavos, 1200, 'só o turbob1-20 tem ganho; "-" vale 0');
    assert.ok(c.avisos.includes('O relatório não tem data por linha: todas as linhas usam a data do relatório informada.'));
    assert.deepEqual(c.codigos_desconhecidos, [], 'o ID sem grupo (desejodemen01-20) só tem cliques: o aviso de código desconhecido é só das linhas gravadas em comissões');
    const k = await ok200(s, 'amazon', TID(), '&tipo=cliques&dia=2026-11-10');
    assert.deepEqual([k.novas, k.cliques_total], [3, 157 + 40 + 30], '"157.0" vira 157');

    const porBloco = await ganhos(s, 'bloco');
    const b1 = linhaDe(porBloco, 'bloco_id', 1);
    assert.deepEqual([b1.comissao, b1.vendas, b1.receita, b1.cliques], [1200, 3, 15000, 157]);
    const porGrupo = await ganhos(s, 'grupo');
    const g3 = linhaDe(porGrupo, 'jid', G3);
    assert.deepEqual([g3.comissao, g3.cliques], [0, 40], 'o g3-20 não vendeu, mas teve 40 cliques');
    assert.deepEqual([porGrupo.nao_atribuida.cliques, porGrupo.nao_atribuida.comissao], [30, 0], 'desejodemen01-20 não é de grupo nenhum');
    assert.deepEqual([porGrupo.total.comissao, porGrupo.total.cliques], [1200, 227]);
    const porDia = await ganhos(s, 'dia');
    assert.deepEqual([diaDe(porDia, '2026-11-10').comissao, diaDe(porDia, '2026-11-10').cliques, diaDe(porDia, '2026-11-10').vendas], [1200, 227, 3]);
    assert.equal(porDia.linhas.filter((l) => l.comissao || l.cliques).length, 1, 'nada caiu em outro dia');
    // repetir o mesmo relatório no mesmo `dia` não dobra (comissão repetida; cliques substituídos)
    const r1 = await ok200(s, 'amazon', TID(), '&dia=2026-11-10');
    assert.deepEqual([r1.novas, r1.repetidas, r1.so_cliques], [0, 1, 2]);
    await ok200(s, 'amazon', TID(), '&tipo=cliques&dia=2026-11-10');
    assert.equal((await ganhos(s, 'grupo')).total.cliques, 227);
    assert.equal((await ganhos(s, 'grupo')).total.comissao, 1200);
  } finally { await s.fechar(); }
});

test('P5: "ID de rastreamento" do Excel/Windows (windows-1252, com "Número" e "bônus") dentro do .zip lê igual ao UTF-8', async () => {
  const s = await subir();
  try {
    const texto = [CAB_TID, 'turbob1-20,157.0,4.0,200.0,3.0,0.0,150.0,0.0,12.0,0.0,12.0,0.0'].join('\r\n') + '\r\n';
    const latin = Buffer.from(texto, 'latin1');
    const arquivo = zip('1-Tracking-Id-x-CSV.csv', latin);
    assert.ok(latin.includes(0xfa), 'o "ú" de Número está em um byte só (windows-1252)');
    const r = await ok200(s, 'amazon', arquivo, '&dia=2026-11-10');
    assert.deepEqual([r.lidas, r.novas, r.comissao_centavos], [1, 1, 1200]);
    assert.ok(r.colunas_usadas.some((x) => x.campo === 'codigo' && x.coluna === 'Número de rastreamento'), JSON.stringify(r.colunas_usadas));
    assert.equal(linhaDe(await ganhos(s, 'bloco'), 'bloco_id', 1).comissao, 1200);
  } finally { await s.fechar(); }
});

test('P5: baixar de novo o "Produto relacionado" do mesmo dia com valor maior ATUALIZA a linha (a Amazon agrega por dia e ASIN) e não avisa de código nem soma duas vezes', async () => {
  const s = await subir();
  try {
    await ok200(s, 'amazon', ZIP_LP(), '&codigo=turbob1-20');
    const maior = zip(NOME_ZIP, [CAB_LP, ...LP_LINHAS.map((l) => (l.includes('B0TESTE001') ? lp('11-04-2026', 'Cozinha', 'Panela inventada', 'B0TESTE001', '10.0', '3.0', '0.0', '270.0', '13.5', '13.5') : l))].join('\n') + '\n');
    const r = await ok200(s, 'amazon', maior, '&codigo=turbob1-20');
    assert.deepEqual([r.novas, r.atualizadas, r.repetidas, r.ja_importado, r.outro_codigo, r.recebem_codigo], [0, 1, 2, false, 0, 0]);
    assert.equal(r.so_cliques, 2, 'as "Other" seguem de fora e não viram repetidas');
    assert.equal(contar(s.db, 'comissoes'), 3);
    const b1 = linhaDe(await ganhos(s, 'bloco'), 'bloco_id', 1);
    assert.deepEqual([b1.comissao, b1.vendas, b1.receita], [1350 + 250, 4, 27000 + 5000], 'a venda do dia 4 passou de 2 itens/9,00 para 3 itens/13,50');
  } finally { await s.fechar(); }
});

test('P5: `dia` informado num arquivo que já traz data por linha não vale: o aviso diz isso e as datas do arquivo mandam', async () => {
  const s = await subir();
  try {
    const c = await ok200(s, 'amazon', ZIP_LP(), '&codigo=turbob1-20&dia=2026-11-30&previa=1');
    assert.ok(c.avisos.includes('O arquivo tem data em cada linha: a data do relatório informada não vale para ele.'));
    assert.deepEqual(c.periodo, { de: '2026-11-04', ate: '2026-11-13' });
  } finally { await s.fechar(); }
});

// ================================================================================================
// 2b. Rodada 2: R1 (coluna de data) e S1 (código de rastreamento só na Amazon), ponta a ponta pela rota
// ================================================================================================

const FRASE_DATA_DESCONHECIDA = 'Não reconheci a coluna de data deste relatório. O portal pode ter mudado o formato. Mande o arquivo de exemplo para a equipe ajustar.';
const CAB_SHOPEE = (data) => `${data},ID do item,ID da loja,Comissão total do item(R$),Sub_id1`;
const nadaGravado = (s) => { for (const t of ['comissoes', 'cliques_loja', 'importacoes']) assert.equal(contar(s.db, t), 0, t); };

test('R1: "Horário do pedido" é a coluna de data: a data da linha vale, o dashboard cai no dia certo e um `dia` informado é ignorado com aviso', async () => {
  const s = await subir();
  try {
    const arquivo = () => csv(CAB_SHOPEE('Horário do pedido'), '2026-11-12 10:00:00,2,1,"3,00",casa', '12/11/2026 23:30:00,3,1,"2,00",casa');
    const c = await ok200(s, 'shopee', arquivo());
    assert.deepEqual([c.lidas, c.novas, c.ignoradas], [2, 2, 0]);
    assert.deepEqual(c.periodo, { de: '2026-11-12', ate: '2026-11-12' });
    assert.ok(c.colunas_usadas.some((x) => x.campo === 'data' && x.coluna === 'Horário do pedido'), JSON.stringify(c.colunas_usadas));
    assert.ok(!c.avisos.includes('O relatório não tem data por linha: todas as linhas usam a data do relatório informada.'));
    const dia = diaDe(await ganhos(s, 'dia', '&loja=shopee'), '2026-11-12');
    assert.deepEqual([dia.comissao, dia.vendas], [500, 2]);
    assert.equal(linhaDe(await ganhos(s, 'bloco', '&loja=shopee'), 'bloco_id', 1).comissao, 500, 'o Sub_id casa é do B1');
    // com `dia` por cima: a data do arquivo manda e o aviso diz isso
    const com = await ok200(s, 'shopee', arquivo(), '&dia=2026-11-30&previa=1');
    assert.deepEqual(com.periodo, { de: '2026-11-12', ate: '2026-11-12' });
    assert.ok(com.avisos.includes('O arquivo tem data em cada linha: a data do relatório informada não vale para ele.'));
  } finally { await s.fechar(); }
});

test('R1: coluna com cara de data que o painel não conhece dá 400 com a frase de "não reconheci", com ou sem `dia`, em comissões e cliques; não grava nada', async () => {
  const s = await subir();
  try {
    const casos = [
      ['shopee', '', csv(CAB_SHOPEE('Data da transação'), '2026-11-12 10:00:00,2,1,"3,00",casa')],
      ['shopee', '&dia=2026-11-30', csv(CAB_SHOPEE('Data da transação'), '2026-11-12 10:00:00,2,1,"3,00",casa')],
      ['shopee', '&dia=2026-11-30&tipo=cliques', csv('Data de aprovação,Cliques,Sub_id', '2026-11-12,10,casa')],
      ['amazon', '&dia=2026-11-30', csv('Número de rastreamento,Data do relatório,cliques,ganhos totais', 'turbob1-20,2026-11-12,10,3.0')],
      ['mercadolivre', '&dia=2026-11-30', csv('Purchase Date Time,Ad Fees,Etiqueta', '2026-11-12,"3,00",casa')],
    ];
    for (const [loja, extra, buf] of casos) {
      const r = await importarPor(s, loja, buf, extra);
      assert.equal(r.status, 400, `${loja}${extra}: ${r.txt}`);
      assert.equal(r.json.erro, FRASE_DATA_DESCONHECIDA, `${loja}${extra}: não pode ser a frase de "informe a data do relatório"`);
    }
    nadaGravado(s);
    // sem coluna nenhuma com cara de data, a mesma recusa pede a data do relatório (e `dia` resolve): o contraste do R1
    const sem = await importarPor(s, 'amazon', TID());
    assert.equal(sem.json.erro, 'Este relatório não tem data por linha: informe a data do relatório.');
    assert.equal((await importarPor(s, 'amazon', TID(), '&dia=2026-11-10&previa=1')).status, 200);
  } finally { await s.fechar(); }
});

test('R1: "Data da compra" é sinônimo conhecido de data (lê normalmente); o nome desconhecido com "data" no meio é o que dá 400', async () => {
  const s = await subir();
  try {
    const c = await ok200(s, 'shopee', csv(CAB_SHOPEE('Data da compra'), '2026-11-12 10:00:00,2,1,"3,00",casa'), '&dia=2026-11-30');
    assert.deepEqual([c.novas, c.periodo], [1, { de: '2026-11-12', ate: '2026-11-12' }]);
    assert.ok(c.colunas_usadas.some((x) => x.campo === 'data' && x.coluna === 'Data da compra'));
  } finally { await s.fechar(); }
});

const CORREIOS = 'BR123456789XX'; // o código de rastreio dos Correios de um comprador: dado pessoal, nunca lido (valor inventado)

test('S1: Shopee e Mercado Livre com coluna "Número de rastreamento": o código fica vazio, a coluna sai em colunas_ignoradas e o valor não vaza', async () => {
  const s = await subir();
  try {
    for (const loja of ['shopee', 'mercadolivre']) {
      for (const nome of ['Número de rastreamento', 'Tracking ID', 'ID de rastreamento']) {
        const cab = loja === 'shopee'
          ? `Hora do pedido,ID do item,ID da loja,Comissão total do item(R$),${nome}`
          : `Purchase Time,MLB,Ad Fees,${nome}`;
        const linha = loja === 'shopee' ? `2026-11-12 10:00:00,2,1,"3,00",${CORREIOS}` : `2026-11-12 10:00:00,MLB123456789,"3,00",${CORREIOS}`;
        const previa = await ok200(s, loja, csv(cab, linha), '&previa=1');
        const c = await ok200(s, loja, csv(cab, linha));
        for (const r of [previa, c]) {
          assert.ok(!r.colunas_usadas.some((x) => x.campo === 'codigo'), `${loja}/${nome}: nenhum código lido: ${JSON.stringify(r.colunas_usadas)}`);
          assert.ok(r.colunas_ignoradas.includes(nome), `${loja}/${nome}: ${JSON.stringify(r.colunas_ignoradas)}`);
          assert.ok(!JSON.stringify(r).includes(CORREIOS), `${loja}/${nome}: o código dos Correios vazou na resposta`);
          assert.deepEqual(r.codigos_desconhecidos, [], 'sem código, não há código desconhecido para avisar');
        }
        assert.deepEqual(linhas(s.db, 'SELECT codigo FROM comissoes WHERE loja = ?', loja).map((x) => x.codigo), [null], `${loja}/${nome}: a linha ficou sem código`);
        s.db.prepare('DELETE FROM comissoes WHERE loja = ?').run(loja);
      }
    }
    // o valor não está em lugar nenhum do banco (nem em chave, nem em histórico)
    const banco = JSON.stringify([linhas(s.db, 'SELECT * FROM comissoes'), linhas(s.db, 'SELECT * FROM importacoes')]);
    assert.ok(!banco.includes(CORREIOS));
  } finally { await s.fechar(); }
});

test('S1: com "Sub_id1" e "Número de rastreamento" juntos, só o Sub_id1 é o código (Shopee); na Amazon a coluna de rastreamento continua valendo', async () => {
  const s = await subir();
  try {
    const c = await ok200(s, 'shopee', csv('Hora do pedido,ID do item,ID da loja,Comissão total do item(R$),Número de rastreamento,Sub_id1', `2026-11-12 10:00:00,2,1,"3,00",${CORREIOS},casa`));
    assert.ok(c.colunas_usadas.some((x) => x.campo === 'codigo' && x.coluna === 'Sub_id1'));
    assert.ok(c.colunas_ignoradas.includes('Número de rastreamento'));
    assert.deepEqual(linhas(s.db, "SELECT codigo FROM comissoes WHERE loja = 'shopee'"), [{ codigo: 'casa' }]);
    // nos cliques da Shopee também: a coluna de rastreamento não vira o código
    const k = await ok200(s, 'shopee', csv('ID dos Cliques,Período dos Cliques,Região dos Cliques,Número de rastreamento', `c1,2026-11-12 10:00:00,MG,${CORREIOS}`), '&tipo=cliques');
    assert.ok(k.colunas_ignoradas.includes('Número de rastreamento'));
    assert.deepEqual(linhas(s.db, "SELECT codigo, cliques FROM cliques_loja WHERE loja = 'shopee'"), [{ codigo: '', cliques: 1 }]);
    // Amazon: o ID de rastreamento é o código do grupo
    const a = await ok200(s, 'amazon', TID(), '&dia=2026-11-10');
    assert.ok(a.colunas_usadas.some((x) => x.campo === 'codigo' && x.coluna === 'Número de rastreamento'));
    assert.equal(linhaDe(await ganhos(s, 'bloco', '&loja=amazon'), 'bloco_id', 1).comissao, 1200);
  } finally { await s.fechar(); }
});

// ================================================================================================
// 3. Shopee: relatório de cliques, uma linha por clique
// ================================================================================================

test('P5: relatório de cliques da Shopee (uma linha por clique): soma por dia e Sub_id, data com hora, sem ID do clique não conta', async () => {
  const s = await subir();
  try {
    const k = await ok200(s, 'shopee', CLIQUES_SHOPEE(), '&tipo=cliques');
    assert.deepEqual([k.lidas, k.ignoradas, k.cliques_total], [7, 1, 6], 'cada linha com ID é 1 clique; a sem ID é pulada');
    assert.equal(k.novas, 4, 'pares dia × Sub_id: (4/11, casa) (4/11, Casa) (5/11, casa) (5/11, vazio)');
    assert.deepEqual(k.periodo, { de: '2026-11-04', ate: '2026-11-05' });
    assert.deepEqual(linhas(s.db, "SELECT dia, codigo, cliques FROM cliques_loja WHERE loja = 'shopee' ORDER BY dia, codigo"), [
      { dia: '2026-11-04', codigo: 'Casa', cliques: 1 }, { dia: '2026-11-04', codigo: 'casa', cliques: 3 },
      { dia: '2026-11-05', codigo: '', cliques: 1 }, { dia: '2026-11-05', codigo: 'casa', cliques: 1 },
    ]);
    // o "23:59:59" fica no dia 4 (a data é a do texto, sem fuso) e "00:00:01" no dia 5
    const porDia = await ganhos(s, 'dia', '&loja=shopee');
    assert.deepEqual([diaDe(porDia, '2026-11-04').cliques, diaDe(porDia, '2026-11-05').cliques], [4, 2]);
    // só o Sub_id `casa` (exato) é do B1; `Casa` e o vazio ficam sem grupo
    const doBloco = await ganhos(s, 'dia', '&loja=shopee&bloco=1');
    assert.deepEqual([diaDe(doBloco, '2026-11-04').cliques, diaDe(doBloco, '2026-11-05').cliques], [3, 1]);
    const porGrupo = await ganhos(s, 'grupo', '&loja=shopee');
    assert.equal(porGrupo.nao_atribuida.cliques, 2);
    assert.equal(porGrupo.total.cliques, 6);
    assert.equal(linhaDe(await ganhos(s, 'bloco', '&loja=shopee'), 'bloco_id', 1).cliques, 4);
    // a mesma coluna "Referenciador" (URL) e o ID do clique não vazam em resposta nenhuma
    assert.ok(!JSON.stringify([k, porDia, porGrupo]).includes('exemplo.invalid'));
    assert.ok(!JSON.stringify(k).includes('c001'));
  } finally { await s.fechar(); }
});

test('P5: reimportar o relatório de cliques da Shopee substitui e não soma; um arquivo menor do mesmo dia vale (a última importação manda)', async () => {
  const s = await subir();
  try {
    await ok200(s, 'shopee', CLIQUES_SHOPEE(), '&tipo=cliques');
    const de_novo = await ok200(s, 'shopee', CLIQUES_SHOPEE(), '&tipo=cliques');
    assert.deepEqual([de_novo.novas, de_novo.atualizadas, de_novo.repetidas, de_novo.ja_importado], [0, 0, 4, true]);
    assert.equal((await ganhos(s, 'grupo', '&loja=shopee')).total.cliques, 6);
    await ok200(s, 'shopee', csv(CAB_CLIQUES_SHOPEE, 'c001,2026-11-04 10:15:32,MG,casa,'), '&tipo=cliques');
    const dia = await ganhos(s, 'dia', '&loja=shopee&bloco=1');
    assert.equal(diaDe(dia, '2026-11-04').cliques, 1, 'o 4/11 casa passou de 3 para 1: a última importação vale');
    assert.equal(diaDe(dia, '2026-11-05').cliques, 1, 'o outro dia não mexeu');
  } finally { await s.fechar(); }
});

test('P5: relatório de cliques da Shopee com data dia/mês/ano e hora, sem ID dos Cliques nenhum → arquivo sem cliques conta 0 linhas e dá 400 de formato', async () => {
  const s = await subir();
  try {
    const br = await ok200(s, 'shopee', csv(CAB_CLIQUES_SHOPEE, 'c1,04/11/2026 10:00:00,MG,casa,', 'c2,04/11/2026 11:00:00,MG,casa,'), '&tipo=cliques');
    assert.deepEqual([br.cliques_total, br.periodo], [2, { de: '2026-11-04', ate: '2026-11-04' }]);
    const vazio = await importarPor(s, 'shopee', csv(CAB_CLIQUES_SHOPEE), '&tipo=cliques');
    assert.equal(vazio.status, 400);
    const ruim = await importarPor(s, 'shopee', csv(CAB_CLIQUES_SHOPEE, 'c1,ontem,MG,casa,'), '&tipo=cliques');
    assert.equal(ruim.status, 200);
    assert.deepEqual([ruim.json.novas, ruim.json.ignoradas, ruim.json.cliques_total], [0, 1, 0], 'data inválida pula a linha (não inventa data)');
  } finally { await s.fechar(); }
});

// ================================================================================================
// 4. Avisos da prévia: outro_codigo / recebem_codigo em reimportações reais
// ================================================================================================

const FRASE_OUTRO_PREVIA = '3 linhas têm a mesma data e produto de vendas já importadas com outro código (ou sem código). Se for o mesmo relatório importado de novo, não importe: as vendas contariam em dobro.';
const FRASE_OUTRO_GRAVADO = '3 linhas têm a mesma data e produto de vendas já importadas com outro código (ou sem código). Se era o mesmo relatório, apague esta importação em Importações recentes.';
const FRASE_RECEBEM_PREVIA = '3 linhas importadas antes sem código vão receber o código deste arquivo. Se eram de outro grupo, não importe: apague a importação antiga e importe os dois arquivos de novo, cada um com o seu código.';
const FRASE_RECEBEM_GRAVADO = '3 linhas importadas antes sem código receberam o código deste arquivo. Se eram de outro grupo, apague a importação antiga e importe os dois arquivos de novo, cada um com o seu código.';

test('CA1 (plano C): o relatório real reimportado SEM o código depois de importado COM ele avisa na prévia e na gravação (3 vendas com produto) e não bloqueia', async () => {
  const s = await subir();
  try {
    await ok200(s, 'amazon', ZIP_LP(), '&codigo=turbob1-20');
    const antes = await ganhos(s, 'grupo');
    assert.equal(antes.total.comissao, 1150);
    const previa = await ok200(s, 'amazon', ZIP_LP(), '&previa=1');
    assert.deepEqual([previa.novas, previa.atualizadas, previa.outro_codigo, previa.recebem_codigo, previa.so_cliques], [3, 0, 3, 0, 2],
      'as 2 linhas "Other" são só cliques (R2): ficam de fora e não contam; só as 3 vendas com ASIN');
    assert.ok(previa.avisos.includes(FRASE_OUTRO_PREVIA), previa.avisos.join(' | '));
    assert.equal(contar(s.db, 'comissoes'), 3, 'a prévia não grava');
    assert.equal(contar(s.db, 'importacoes'), 1);
    const gravado = await ok200(s, 'amazon', ZIP_LP());
    assert.deepEqual([gravado.novas, gravado.outro_codigo, gravado.recebem_codigo], [3, 3, 0], 'a gravação conta o mesmo que a prévia');
    assert.ok(gravado.avisos.includes(FRASE_OUTRO_GRAVADO), gravado.avisos.join(' | '));
    assert.ok(!gravado.avisos.includes(FRASE_OUTRO_PREVIA), 'o tempo do verbo muda: a frase da gravação é outra');
    // o que é gravado não muda por causa do aviso: as 3 vendas entram (a venda conta em dobro, como o aviso diz)
    assert.equal(contar(s.db, 'comissoes'), 6);
    const depois = await ganhos(s, 'grupo');
    assert.equal(depois.total.comissao, 2300);
    assert.equal(depois.nao_atribuida.comissao, 1150, 'a cópia sem código ficou sem grupo');
    // o aviso não ecoa o código do arquivo, o título nem o ASIN
    const texto = [...previa.avisos, ...gravado.avisos].join(' ');
    assert.ok(!/turbob1|B0TESTE|Panela|Fone/i.test(texto), texto);
    // apagar a importação duplicada desfaz (o que o aviso manda fazer)
    const del = await pedir(s, `/api/ganhos/importacoes/${gravado.importacao_id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.equal((await ganhos(s, 'grupo')).total.comissao, 1150);
  } finally { await s.fechar(); }
});

test('CA2 (plano C, R4): importar sem código e depois com o código do grupo avisa "recebem o código" e NÃO duplica; o dashboard passa a atribuir', async () => {
  const s = await subir();
  try {
    await ok200(s, 'amazon', ZIP_LP());
    assert.equal((await ganhos(s, 'grupo')).total.comissao, 1150);
    assert.equal((await ganhos(s, 'grupo')).nao_atribuida.comissao, 1150, 'sem código nada é de grupo');
    const previa = await ok200(s, 'amazon', ZIP_LP(), '&codigo=turbob1-20&previa=1');
    assert.deepEqual([previa.novas, previa.atualizadas, previa.recebem_codigo, previa.outro_codigo], [0, 3, 3, 0]);
    assert.ok(previa.avisos.includes(FRASE_RECEBEM_PREVIA), previa.avisos.join(' | '));
    assert.equal(linhas(s.db, 'SELECT COUNT(*) AS n FROM comissoes WHERE codigo IS NULL')[0].n, 3, 'a prévia não grava');
    const gravado = await ok200(s, 'amazon', ZIP_LP(), '&codigo=turbob1-20');
    assert.deepEqual([gravado.atualizadas, gravado.recebem_codigo, gravado.outro_codigo], [3, 3, 0]);
    assert.ok(gravado.avisos.includes(FRASE_RECEBEM_GRAVADO), gravado.avisos.join(' | '));
    assert.equal(contar(s.db, 'comissoes'), 3, 'as mesmas 3 vendas ganharam o código: nada duplicou');
    const g = await ganhos(s, 'grupo');
    assert.equal(g.total.comissao, 1150);
    assert.equal(g.nao_atribuida.comissao, 0);
    assert.equal(linhaDe(await ganhos(s, 'bloco'), 'bloco_id', 1).comissao, 1150);
  } finally { await s.fechar(); }
});

test('R11 (plano C): dois grupos com o mesmo produto no mesmo dia, cada um com o seu código, avisam (alarme que o plano aceita) mas gravam e atribuem cada um ao seu', async () => {
  const s = await subir();
  try {
    await ok200(s, 'amazon', ZIP_LP(), '&codigo=turbob1-20');
    const previa = await ok200(s, 'amazon', ZIP_LP(), '&codigo=g3-20&previa=1');
    assert.deepEqual([previa.novas, previa.outro_codigo, previa.recebem_codigo], [3, 3, 0], 'ambíguo: pode ser o mesmo relatório baixado de novo');
    assert.ok(previa.avisos.includes(FRASE_OUTRO_PREVIA));
    await ok200(s, 'amazon', ZIP_LP(), '&codigo=g3-20');
    const g = await ganhos(s, 'grupo');
    assert.equal(linhaDe(g, 'jid', G3).comissao, 1150, 'o g3-20 recebe a cópia dele');
    assert.equal(linhaDe(await ganhos(s, 'bloco'), 'bloco_id', 1).comissao, 1150, 'o B1 segue com a dele');
    assert.equal(g.total.comissao, 2300);
    assert.equal(g.total.atribuida, 1);
  } finally { await s.fechar(); }
});

test('R14 (plano C): Amazon não distingue maiúsculas no ID de rastreamento: o mesmo arquivo com TURBOB1-20 não avisa nem duplica', async () => {
  const s = await subir();
  try {
    await ok200(s, 'amazon', ZIP_LP(), '&codigo=turbob1-20');
    const r = await ok200(s, 'amazon', ZIP_LP(), '&codigo=TURBOB1-20&previa=1');
    assert.deepEqual([r.outro_codigo, r.recebem_codigo, r.novas], [0, 0, 0]);
    assert.deepEqual(r.avisos.filter((a) => /outro código|receber o código/.test(a)), []);
    const g = await ok200(s, 'amazon', ZIP_LP(), '&codigo=TURBOB1-20');
    assert.equal(contar(s.db, 'comissoes'), 3);
    assert.equal(g.novas, 0);
    assert.equal((await ganhos(s, 'grupo')).total.comissao, 1150, 'a atribuição ao B1 segue valendo com a caixa trocada');
  } finally { await s.fechar(); }
});

test('CA1 (plano C): "ID de rastreamento" reimportado em outro dia não avisa (o aviso é só de venda com produto) e SOMA o ganho nos dois dias — risco registrado', async () => {
  const s = await subir();
  try {
    await ok200(s, 'amazon', TID(), '&dia=2026-11-10');
    const previa = await ok200(s, 'amazon', TID(), '&dia=2026-11-11&previa=1');
    assert.deepEqual([previa.novas, previa.outro_codigo, previa.recebem_codigo, previa.so_cliques], [1, 0, 0, 2], 'sem produto nem título não há "mesmo produto" para comparar');
    await ok200(s, 'amazon', TID(), '&dia=2026-11-11');
    assert.equal((await ganhos(s, 'grupo')).total.comissao, 2400, 'o mesmo total do período contado em dois dias');
  } finally { await s.fechar(); }
});

test('CA1/CA2 (plano C): cliques nunca têm aviso de código (outro_codigo e recebem_codigo são null); venda com pedido também não', async () => {
  const s = await subir();
  try {
    const k = await ok200(s, 'amazon', ZIP_LP(), '&tipo=cliques&codigo=turbob1-20');
    assert.deepEqual([k.outro_codigo, k.recebem_codigo], [null, null]);
    const k2 = await ok200(s, 'amazon', ZIP_LP(), '&tipo=cliques&previa=1');
    assert.deepEqual([k2.outro_codigo, k2.recebem_codigo], [null, null]);
    const cab = 'ID do pedido,Hora do pedido,ID da loja,ID do item,Comissão total do item(R$),Sub_id1';
    await ok200(s, 'shopee', csv(cab, 'P1,2026-11-05 10:00:00,1,2,"3,00",casa'));
    const outroCodigo = await ok200(s, 'shopee', csv(cab, 'P1,2026-11-05 10:00:00,1,2,"3,00",outro'), '&previa=1');
    assert.deepEqual([outroCodigo.outro_codigo, outroCodigo.recebem_codigo], [0, 0], 'com pedido, o pedido já separa as vendas');
  } finally { await s.fechar(); }
});

// ================================================================================================
// 5. M16 (período anterior) e filtro de grupo no servidor
// ================================================================================================

test('M16 ponta a ponta: com o relatório real em dois períodos, `comparar=1` devolve o anterior e as variações certas; sem `comparar`, `anterior` é null e o resto não muda', async () => {
  const s = await subir();
  try {
    await ok200(s, 'amazon', ZIP_LP(), '&codigo=turbob1-20');
    await ok200(s, 'amazon', ZIP_LP(), '&tipo=cliques&codigo=turbob1-20');
    // período atual 08–14/11 (o dia 13: 250 de comissão, 1 venda, 25 cliques); anterior 01–07/11 (900, 2 vendas, 262 cliques)
    const periodo = 'periodo=custom&de=2026-11-08&ate=2026-11-14';
    const r = await ganhos(s, 'grupo', '&comparar=1', periodo);
    assert.deepEqual([r.anterior.dia_de, r.anterior.dia_ate], ['2026-11-01', '2026-11-07']);
    assert.deepEqual([r.total.comissao, r.anterior.total.comissao, r.total.vendas, r.anterior.total.vendas, r.total.cliques, r.anterior.total.cliques], [250, 900, 1, 2, 25, 262]);
    quase(r.anterior.variacao.comissao, (250 - 900) / 900, 'comissão');
    quase(r.anterior.variacao.vendas, -0.5, 'vendas');
    quase(r.anterior.variacao.cliques, (25 - 262) / 262, 'cliques');
    quase(r.anterior.variacao.receita, (5000 - 18000) / 18000, 'receita');
    quase(r.anterior.variacao.epc, (250 / 25 - 900 / 262) / (900 / 262), 'EPC');
    assert.equal(r.anterior.variacao.envios, -1, 'os envios de 01/11 (6) ficaram no período anterior');
    assert.equal(r.anterior.variacao.entradas, null, 'sem entradas nos dois lados: sem base');
    // sem comparar: o corpo é o mesmo, só sem o campo novo (CA8)
    const sem = await ganhos(s, 'grupo', '', periodo);
    assert.equal(sem.anterior, null);
    const { anterior, ...igual } = r;
    const { anterior: nulo, ...igualSem } = sem;
    assert.deepEqual(igual, igualSem);
    // o período anterior respeita o mesmo filtro de loja (nenhum Shopee na janela) e o de bloco
    const amazon = await ganhos(s, 'grupo', '&comparar=1&loja=amazon', periodo);
    assert.equal(amazon.anterior.total.comissao, 900);
    const shopee = await ganhos(s, 'grupo', '&comparar=1&loja=shopee', periodo);
    assert.equal(shopee.anterior.total.comissao, 0);
    assert.equal(shopee.anterior.variacao.comissao, null, 'anterior 0: sem base, não é Infinity');
    const bloco = await ganhos(s, 'bloco', '&comparar=1&bloco=1', periodo);
    assert.equal(bloco.anterior.total.comissao, 900);
    // parâmetro ruim: 400 com a frase fixa
    for (const q of ['&comparar=2', '&comparar=0', '&comparar=true', '&comparar=1&comparar=1', '&comparar=%3Cb%3E']) {
      const x = await pedir(s, `/api/ganhos?${periodo}&por=grupo${q}`);
      assert.equal(x.status, 400, q);
      assert.equal(x.json.erro, 'O parâmetro de comparação veio repetido ou inválido. Mande comparar=1 uma vez só.', q);
    }
  } finally { await s.fechar(); }
});

test('CA4 (plano C): `por=oferta&grupo=` traz só as vendas atribuídas àquele grupo e bate com a linha do grupo em `por=grupo`; as do bloco não entram', async () => {
  const s = await subir();
  try {
    await ok200(s, 'amazon', ZIP_LP(), '&codigo=g3-20'); // tudo para o G3
    await ok200(s, 'amazon', csv('Date,ASIN,Product Title,Items Shipped,Total Earnings', '11-06-2026,B0TESTE009,Do bloco,1,4.0'), '&codigo=turbob1-20');
    const todas = await ganhos(s, 'oferta');
    assert.equal(todas.linhas.length, 3);
    const doG3 = await ganhos(s, 'oferta', `&grupo=${encodeURIComponent(G3)}`);
    assert.equal(doG3.grupo, G3);
    assert.equal(doG3.nao_atribuida, null);
    assert.deepEqual(doG3.linhas.map((l) => [l.oferta, l.comissao]), [['B0TESTE001', 900], ['B0TESTE002', 250]]);
    assert.equal(doG3.linhas.reduce((n, l) => n + l.comissao, 0), linhaDe(await ganhos(s, 'grupo'), 'jid', G3).comissao, 'invariante: a soma das ofertas do grupo é a linha do grupo');
    assert.deepEqual(doG3.linhas.map((l) => l.envios), [0, 1], 'os envios do grupo vêm só dos envios dele (oferta_chave ASIN:B0TESTE002)');
    // G1 só tem o código do bloco: nenhuma venda "dele"
    assert.deepEqual((await ganhos(s, 'oferta', `&grupo=${encodeURIComponent(G1)}`)).linhas, []);
    assert.equal((await ganhos(s, 'oferta', `&grupo=${encodeURIComponent(G1)}`)).total.comissao, 0);
    // o filtro de loja combina
    assert.equal((await ganhos(s, 'oferta', `&grupo=${encodeURIComponent(G3)}&loja=shopee`)).linhas.length, 0);
    // combinações recusadas, com frase fixa e sem eco do jid
    const g = encodeURIComponent(G3);
    const por = await pedir(s, `/api/ganhos?${PERIODO_NOV}&por=grupo&grupo=${g}`);
    assert.deepEqual([por.status, por.json.erro], [400, 'O filtro de grupo vale só para a tabela Por oferta.']);
    const bloco = await pedir(s, `/api/ganhos?${PERIODO_NOV}&por=oferta&grupo=${g}&bloco=1`);
    assert.deepEqual([bloco.status, bloco.json.erro], [400, 'Filtre por grupo ou por bloco, não pelos dois.']);
    for (const ruim of [encodeURIComponent('999@g.us'), 'x'.repeat(201), `${g}&grupo=${g}`, encodeURIComponent('<img src=x>')]) {
      const x = await pedir(s, `/api/ganhos?${PERIODO_NOV}&por=oferta&grupo=${ruim}`);
      assert.equal(x.status, 404, ruim.slice(0, 30));
      assert.equal(x.json.erro, 'Este grupo não existe mais.');
      assert.ok(!x.txt.includes('img') && !x.txt.includes('999@'), 'sem eco do valor');
    }
  } finally { await s.fechar(); }
});

test('Item 5 (diagnóstico do dev): a venda só vai para o grupo se o código SAIU num envio antes do dia da venda; só "associar" o código não atribui — é desenho (D6), não bug', async () => {
  // venda de 05/11 com código casa-20 de G3; três situações do mesmo código
  const venda = (s) => ok200(s, 'amazon', csv('Date,ASIN,Product Title,Items Shipped,Total Earnings', '11-05-2026,B0TESTE001,Panela,1,5.0'), '&codigo=casa-20');
  const comAssociacao = (s) => rastreio.salvar(s.db, { loja: 'amazon', alvo_tipo: 'grupo', alvo: G3, codigo: 'casa-20' });
  const grupoDe = async (s) => {
    const g = await ganhos(s, 'grupo');
    return [g.nao_atribuida.comissao, g.linhas.find((l) => l.jid === G3)?.comissao ?? 0]; // grupo sem nada no período nem tem linha
  };
  const envio = (s, ts) => rastreio.registrar(s.db, { ts, jid: G3, loja: 'amazon', origem: 'manual', link: 'https://exemplo.invalid/a', codigo: 'casa-20', nivel: 'grupo', esperado: 1, oferta_chave: 'ASIN:B0TESTE001' });
  // (a) associado, mas nunca enviado: sem grupo identificado
  let s = await subir({ envios: false });
  try { comAssociacao(s); await venda(s); assert.deepEqual(await grupoDe(s), [500, 0]); } finally { await s.fechar(); }
  // (b) enviado DEPOIS do dia da venda (a simulação do dev, com ts de "agora"): continua sem grupo
  s = await subir({ envios: false });
  try { comAssociacao(s); envio(s, NOV(6, 0)); await venda(s); assert.deepEqual(await grupoDe(s), [500, 0]); } finally { await s.fechar(); }
  // (c) enviado antes: o grupo recebe. No mesmo dia, mesmo horas depois da venda, também (a atribuição é por dia de negócio)
  s = await subir({ envios: false });
  try { comAssociacao(s); envio(s, NOV(4)); await venda(s); assert.deepEqual(await grupoDe(s), [0, 500]); } finally { await s.fechar(); }
  s = await subir({ envios: false });
  try { comAssociacao(s); envio(s, NOV(5, 23)); await venda(s); assert.deepEqual(await grupoDe(s), [0, 500]); } finally { await s.fechar(); }
  // a função pura diz o mesmo
  s = await subir({ envios: false });
  try {
    envio(s, NOV(5, 12));
    assert.deepEqual(atribuir(s.db, { loja: 'amazon', codigo: 'CASA-20', data: '2026-11-05' }), { alvo_tipo: 'grupo', jid: G3, bloco_id: null });
    assert.equal(atribuir(s.db, { loja: 'amazon', codigo: 'casa-20', data: '2026-11-04' }), null);
    assert.equal(atribuir(s.db, { loja: 'shopee', codigo: 'CASA-20', data: '2026-11-05' }), null, 'na Shopee o Sub_id é exato e a loja conta');
  } finally { await s.fechar(); }
});

test('CA5 (plano C) ponta a ponta: URL da oferta por loja sai só de produto que fecha com o formato da loja, sem afiliado; o resto vem sem URL', async () => {
  const s = await subir();
  try {
    await ok200(s, 'amazon', csv('Date,ASIN,Items Shipped,Total Earnings', '2026-11-05,b0teste001,1,1.00', '2026-11-05,ASIN:B0TESTE002,1,2.00'), '&codigo=turbob1-20');
    await ok200(s, 'mercadolivre', csv('Data,ID do produto,Comissão',
      '2026-11-05,MLB-3456789012,"3,00"', '2026-11-05,mlb-5,"4,00"', '2026-11-05,javascript:alert,"5,00"', '2026-11-05,MLB123456789012345678901,"6,00"', '2026-11-05,MLB1234567890,"7,00"'));
    await ok200(s, 'shopee', csv('Hora do pedido,ID do item,ID da loja,Comissão total do item(R$)', '2026-11-05 10:00,2,1,"8,00"', '2026-11-05 10:00,abc,def,"9,00"'));
    // produto de uma loja com cara de produto de outra (sem "ID da loja" na Shopee o item entra puro): nunca vira link da outra loja
    await ok200(s, 'shopee', csv('Hora do pedido,ID do item,Comissão total do item(R$)', '2026-11-06 10:00,ASIN:B0TESTE005,"1,00"', '2026-11-06 10:00,MLB77,"1,00"'));
    await ok200(s, 'mercadolivre', csv('Data,ID do produto,Comissão', '2026-11-06,B0TESTE005,"1,00"'));
    const r = await ganhos(s, 'oferta');
    const urlDe = (loja, oferta) => linhaDe({ por: 'oferta', linhas: r.linhas.filter((l) => l.loja === loja) }, 'oferta', oferta).url;
    assert.equal(urlDe('amazon', 'b0teste001'), 'https://www.amazon.com.br/dp/B0TESTE001', 'ASIN em minúsculas vira maiúsculas na URL');
    assert.equal(urlDe('amazon', 'ASIN:B0TESTE002'), 'https://www.amazon.com.br/dp/B0TESTE002');
    assert.equal(urlDe('mercadolivre', 'MLB-3456789012'), 'https://produto.mercadolivre.com.br/MLB-3456789012');
    assert.equal(urlDe('mercadolivre', 'mlb-5'), 'https://produto.mercadolivre.com.br/MLB-5');
    assert.equal(urlDe('mercadolivre', 'MLB1234567890'), 'https://produto.mercadolivre.com.br/MLB-1234567890');
    assert.equal(urlDe('mercadolivre', 'javascript:alert'), null);
    assert.equal(urlDe('mercadolivre', 'MLB123456789012345678901'), null, '21 dígitos: fora do formato');
    assert.equal(urlDe('shopee', 'SHOPEE:1.2'), 'https://shopee.com.br/product/1/2');
    assert.equal(urlDe('shopee', 'SHOPEE:def.abc'), null, 'ids que não são números');
    assert.equal(urlDe('shopee', 'ASIN:B0TESTE005'), null, 'item da Shopee com cara de ASIN não vira link da Amazon');
    assert.equal(urlDe('shopee', 'MLB77'), null, 'item da Shopee com cara de MLB não vira link do Mercado Livre');
    assert.equal(urlDe('mercadolivre', 'B0TESTE005'), null, 'produto do ML com cara de ASIN não vira link da Amazon');
    // nenhuma URL é de afiliado nem de encurtador
    assert.ok(r.linhas.filter((l) => l.url).every((l) => /^https:\/\/(www\.amazon\.com\.br\/dp\/[A-Z0-9]{10}|produto\.mercadolivre\.com\.br\/MLB-\d{1,20}|shopee\.com\.br\/product\/\d+\/\d+)$/.test(l.url)), JSON.stringify(r.linhas.map((l) => l.url)));
  } finally { await s.fechar(); }
});

test('M16 + D4 (plano C): `comparar=1` com o filtro de grupo compara só as vendas atribuídas ao próprio grupo nos dois períodos', async () => {
  const s = await subir();
  try {
    const cab = 'Date,ASIN,Items Shipped,Total Earnings';
    await ok200(s, 'amazon', csv(cab, '2026-11-03,B0TESTE001,1,6.00', '2026-11-10,B0TESTE001,1,3.00'), '&codigo=g3-20'); // G3: 6,00 antes e 3,00 agora
    await ok200(s, 'amazon', csv(cab, '2026-11-03,B0TESTE001,1,50.00', '2026-11-10,B0TESTE001,1,80.00'), '&codigo=turbob1-20'); // bloco: fora do recorte do grupo
    const r = await ganhos(s, 'oferta', `&grupo=${encodeURIComponent(G3)}&comparar=1`, 'periodo=custom&de=2026-11-08&ate=2026-11-14');
    assert.deepEqual([r.total.comissao, r.anterior.total.comissao], [300, 600]);
    quase(r.anterior.variacao.comissao, -0.5, 'comissão do grupo');
    assert.deepEqual([r.anterior.dia_de, r.anterior.dia_ate], ['2026-11-01', '2026-11-07']);
    assert.equal(r.anterior.total.envios, 1, 'só o envio do próprio G3 (1/11) entra no período anterior');
  } finally { await s.fechar(); }
});

test('M16 (plano C) com virada do dia: o período anterior usa os mesmos limites de dia de negócio (envio à 01:30 com virada 02:00 é do dia anterior)', async () => {
  const s = await subir({ envios: false });
  try {
    rastreio.registrar(s.db, { ts: new Date(2026, 10, 8, 1, 30).getTime(), jid: G3, loja: 'amazon', origem: 'manual', link: 'https://exemplo.invalid/x', codigo: 'g3-20', nivel: 'grupo', esperado: 1, oferta_chave: 'ASIN:B0TESTE001' });
    const consultar = (virada) => metricas(s.db, lerConsulta({ periodo: 'custom', de: '2026-11-08', ate: '2026-11-14', por: 'grupo', comparar: '1' }, virada));
    const v0 = consultar(0); const v2 = consultar(120);
    assert.deepEqual([v0.total.envios, v0.anterior.total.envios], [1, 0], 'virada meia-noite: 01:30 do dia 8 é do período atual');
    assert.deepEqual([v2.total.envios, v2.anterior.total.envios], [0, 1], 'virada 02:00: 01:30 do dia 8 ainda é o dia 7, do período anterior');
    assert.equal(v2.anterior.variacao.envios, -1);
    assert.equal(v0.anterior.variacao.envios, null, 'anterior 0: sem base');
    // a atribuição segue a mesma virada: o envio de 01:30 do dia 6 atribui a venda do dia 5 (de negócio) só com virada 02:00
    rastreio.registrar(s.db, { ts: new Date(2026, 10, 6, 1, 30).getTime(), jid: G1, loja: 'amazon', origem: 'manual', link: 'https://exemplo.invalid/y', codigo: 'virada-20', nivel: 'grupo', esperado: 1 });
    assert.equal(atribuir(s.db, { loja: 'amazon', codigo: 'virada-20', data: '2026-11-05' }, 0), null);
    assert.deepEqual(atribuir(s.db, { loja: 'amazon', codigo: 'virada-20', data: '2026-11-05' }, 120), { alvo_tipo: 'grupo', jid: G1, bloco_id: null });
  } finally { await s.fechar(); }
});

// ================================================================================================
// 6. P4: envio com Sub_id de bloco, sem a API, pede à extensão com `subId`; extensão antiga → link base + motivo
// ================================================================================================

const ID_AF = '98765432101';
const SHOP = '52377417'; const ITEM = '6309028319';
const URL_PRODUTO_SHOPEE = `https://shopee.com.br/Fone-Bom-Sem-Fio-i.${SHOP}.${ITEM}`;
const LINK_BASE = 'https://s.shopee.com.br/BaseLink111';
const LINK_SUB = 'https://s.shopee.com.br/SubCasa222';
const LONGO_DONO = `https://shopee.com.br/product/${SHOP}/${ITEM}?utm_source=an_${ID_AF}&utm_medium=affiliates`;

/** Servidor com a Shopee SEM API (nenhum app_id/chave), só o ID de afiliado; a extensão é o teste (poll/submit). */
async function subirShopeeSemApi({ limiteShopeeHora } = {}) {
  const { dir, db } = montarDb({ envios: false });
  db.prepare("INSERT INTO conexoes (plataforma, config, segredos, updated_at) VALUES ('shopee', ?, '{}', ?)").run(JSON.stringify({ id_afiliado: ID_AF }), Date.now());
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'extension', ...(limiteShopeeHora ? { limiteShopeeHora } : {}) });
  const shopee = createShopee({ db, fetch: async () => { throw new Error('rede proibida no teste'); } });
  const scheduler = createScheduler({ db, wa, links, fast: true });
  scheduler.envios = createEnvios({ db, wa, links, ml: {}, fast: true, dir, shopee });
  const app = buildApp({ db, wa, links, scheduler, publicHost: '', panelPassword: '', dataDir: dir, ml: {} });
  const server = await new Promise((ok) => { const x = app.listen(0, '127.0.0.1', () => ok(x)); });
  const s = { db, dir, port: server.address().port, wa, links };
  s.fechar = () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => { db.close(); r(); }); });
  /** Faz o papel da extensão: responde cada pedido que chegar com `resposta(job)` e guarda os pedidos. */
  s.extensao = (resposta) => {
    const jobs = []; let parar = false;
    const laco = (async () => {
      while (!parar) {
        const job = await links.poll(300);
        if (!job) continue;
        jobs.push(job);
        links.submit(job.id, resposta(job));
      }
    })();
    return { jobs, parar: async () => { parar = true; await laco; } };
  };
  return s;
}
const esperarEnvio = async (db, id) => {
  const t0 = Date.now();
  while (['pendente', 'enviando'].includes(db.prepare('SELECT status FROM envios WHERE id = ?').get(id)?.status)) {
    if (Date.now() - t0 > 5000) throw new Error(`o envio ${id} não terminou`);
    await dorme(5);
  }
  return db.prepare('SELECT status FROM envios WHERE id = ?').get(id).status;
};
const ajustes = { title: 'Fone à mão', price: '50' };

test('P4: sem a API, o envio com Sub_id de bloco pede à extensão com `subId` e o grupo recebe o link com Sub_id; o grupo fora do bloco recebe o base', async () => {
  const s = await subirShopeeSemApi();
  const ext = s.extensao((job) => ({ ok: true, link: job.subId ? LINK_SUB : LINK_BASE, longo: LONGO_DONO, sub_id_aplicado: !!job.subId }));
  try {
    const r = await pedir(s, '/api/envios', { method: 'POST', corpo: { tipo: 'oferta', url: URL_PRODUTO_SHOPEE, template_id: 1, group_jids: [G1, G3], ajustes } });
    assert.equal(r.status, 200, r.txt);
    assert.equal(await esperarEnvio(s.db, r.json.id), 'concluido');
    assert.deepEqual(ext.jobs.map((j) => [j.type, j.url, j.subId ?? null]), [
      ['link_shopee', URL_PRODUTO_SHOPEE, null], ['link_shopee', URL_PRODUTO_SHOPEE, 'casa'],
    ], 'primeiro o link base (sem Sub_id), depois um pedido com o Sub_id do bloco');
    const linkDoTexto = (m) => /Compre aqui: (\S+)$/.exec(m.text)?.[1];
    assert.deepEqual(s.wa.simulated.map((m) => [m.jid, linkDoTexto(m)]), [[G1, LINK_SUB], [G3, LINK_BASE]]);
    assert.deepEqual(linhas(s.db, 'SELECT jid, link, codigo, nivel, bloco_id, esperado, motivo FROM rastreio_envios ORDER BY id'), [
      { jid: G1, link: LINK_SUB, codigo: 'casa', nivel: 'bloco', bloco_id: 1, esperado: 1, motivo: null },
      { jid: G3, link: LINK_BASE, codigo: null, nivel: 'padrao', bloco_id: null, esperado: 0, motivo: null },
    ]);
    const cob = await pedir(s, '/api/rastreio/cobertura?periodo=30d');
    assert.equal(cob.status, 200);
    assert.deepEqual([cob.json.total.esperados, cob.json.total.rastreados], [1, 1], 'o link que levou o Sub_id conta como rastreado');
  } finally { await ext.parar(); await s.fechar(); }
});

test('P4: extensão ANTIGA (responde sem sub_id_aplicado) → o grupo recebe o link base de afiliado e a falta entra na cobertura com subid_nao_aplicado', async () => {
  const s = await subirShopeeSemApi();
  const ext = s.extensao(() => ({ ok: true, link: LINK_BASE, longo: LONGO_DONO })); // sem o campo: a extensão de antes
  try {
    const r = await pedir(s, '/api/envios', { method: 'POST', corpo: { tipo: 'oferta', url: URL_PRODUTO_SHOPEE, template_id: 1, group_jids: [G1, G2], ajustes } });
    assert.equal(r.status, 200, r.txt);
    assert.equal(await esperarEnvio(s.db, r.json.id), 'concluido', 'o envio não falha: sai com o link de afiliado base');
    assert.ok(ext.jobs.some((j) => j.subId === 'casa'), 'o pedido com Sub_id foi feito');
    assert.ok(s.wa.simulated.every((m) => /Compre aqui: https:\/\/s\.shopee\.com\.br\/BaseLink111$/.test(m.text)), 'o link que sai é de afiliado (nunca link comum)');
    assert.deepEqual(linhas(s.db, 'SELECT jid, link, codigo, nivel, esperado, motivo FROM rastreio_envios ORDER BY jid'), [
      { jid: G1, link: LINK_BASE, codigo: null, nivel: 'nenhum', esperado: 1, motivo: 'subid_nao_aplicado' },
      { jid: G2, link: LINK_BASE, codigo: null, nivel: 'nenhum', esperado: 1, motivo: 'subid_nao_aplicado' },
    ]);
    const cob = await pedir(s, '/api/rastreio/cobertura?periodo=30d');
    assert.equal(cob.status, 200);
    assert.deepEqual([cob.json.total.esperados, cob.json.total.rastreados, cob.json.total.cobertura], [2, 0, 0], 'esperava código e nenhum saiu com ele');
    assert.deepEqual(cob.json.por_loja.map((l) => [l.loja, l.esperados, l.rastreados, l.cobertura]), [['shopee', 2, 0, 0]], 'a falta conta na cobertura da Shopee (0%)');
    // a venda desses cliques não é atribuída: sem envio com código, o Sub_id `casa` não é de ninguém
    assert.equal(atribuir(s.db, { loja: 'shopee', codigo: 'casa', data: '2099-01-01' }), null);
  } finally { await ext.parar(); await s.fechar(); }
});

// ---- R3 = S2 (rodada 2): o Sub_id não gasta o teto de links por hora que o link base precisa; extensão antiga pede 1 Sub_id por envio

/** O Sub_id da Shopee é do bloco: o B2 (com o G3) leva `casa2`, e um envio ao G1, G2 e G3 tem 2 Sub_ids distintos. */
function segundoBlocoShopee(db) {
  db.prepare("INSERT INTO blocks (id, name, created_at) VALUES (2, 'B2', 1)").run();
  db.prepare('INSERT INTO block_groups (block_id, jid) VALUES (2, ?)').run(G3);
  rastreio.salvar(db, { loja: 'shopee', alvo_tipo: 'bloco', alvo: '2', codigo: 'casa2' });
}
const urlShopee = (n) => `https://shopee.com.br/Produto-${n}-i.${SHOP}.${6309028000 + n}`;
const enviarShopee = async (s, n, jids) => {
  const r = await pedir(s, '/api/envios', { method: 'POST', corpo: { tipo: 'oferta', url: urlShopee(n), template_id: 1, group_jids: jids, ajustes } });
  assert.equal(r.status, 200, r.txt);
  return { id: r.json.id, status: await esperarEnvio(s.db, r.json.id) };
};
const linkDoTexto = (m) => /Compre aqui: (\S+)$/.exec(m.text)?.[1];

test('R3 com teto baixo (13 por hora): o 1º envio gasta base + 1 Sub_id e para; os envios seguintes saem só com o link base, sem pedir Sub_id', async () => {
  const s = await subirShopeeSemApi({ limiteShopeeHora: 13 });
  segundoBlocoShopee(s.db); // 2º Sub_id distinto no mesmo envio
  const ext = s.extensao((job) => ({ ok: true, link: job.subId ? `https://s.shopee.com.br/Sub${job.subId}x${job.url.length}` : LINK_BASE, longo: LONGO_DONO, sub_id_aplicado: !!job.subId }));
  try {
    assert.equal(s.links.vagasShopee(), 13);
    const e1 = await enviarShopee(s, 1, [G1, G2, G3]);
    assert.equal(e1.status, 'concluido');
    const subs1 = ext.jobs.filter((j) => j.subId).map((j) => j.subId);
    assert.equal(subs1.length, 1, `o 1º envio pede um só Sub_id: restam ${s.links.vagasShopee()} vagas e a reserva do base é 11 — ${JSON.stringify(ext.jobs.map((j) => j.subId ?? null))}`);
    assert.equal(s.links.vagasShopee(), 11, 'o envio gastou o base e 1 Sub_id; sobram as 11 da reserva');
    const motivos = linhas(s.db, 'SELECT motivo FROM rastreio_envios WHERE envio_id = ? ORDER BY jid', e1.id).map((x) => x.motivo);
    assert.deepEqual(motivos.filter(Boolean), ['limite_shopee'], 'o grupo sem Sub_id fica com o base e o motivo limite_shopee (um só grupo ficou de fora)');
    // 2º e 3º envios: a oferta sai para todos com o link base; nenhum Sub_id é pedido
    for (const n of [2, 3]) {
      ext.jobs.length = 0; s.wa.simulated.length = 0;
      const e = await enviarShopee(s, n, [G1, G2, G3]);
      assert.equal(e.status, 'concluido', `oferta ${n}: a oferta seguinte sai`);
      assert.equal(s.wa.simulated.length, 3, `oferta ${n}: os 3 grupos receberam`);
      assert.ok(s.wa.simulated.every((m) => linkDoTexto(m) === LINK_BASE), `oferta ${n}: link base de afiliado`);
      assert.deepEqual(ext.jobs.map((j) => j.subId ?? null), [null], `oferta ${n}: só o pedido do link base`);
      assert.ok(linhas(s.db, 'SELECT motivo, esperado FROM rastreio_envios WHERE envio_id = ?', e.id).every((x) => x.motivo === 'limite_shopee' && x.esperado === 1));
    }
    assert.equal(s.links.vagasShopee(), 9, 'cada oferta seguinte gasta uma vaga só (o base)');
  } finally { await ext.parar(); await s.fechar(); }
});

test('R3: extensão ANTIGA (sem sub_id_aplicado) recebe 1 pedido de Sub_id por envio (não um por Sub_id distinto); todos os grupos saem com o base e subid_nao_aplicado', async () => {
  const s = await subirShopeeSemApi();
  segundoBlocoShopee(s.db);
  const ext = s.extensao(() => ({ ok: true, link: LINK_BASE, longo: LONGO_DONO })); // a extensão de antes
  try {
    for (const n of [1, 2]) {
      ext.jobs.length = 0; s.wa.simulated.length = 0;
      const e = await enviarShopee(s, n, [G1, G2, G3]);
      assert.equal(e.status, 'concluido', `oferta ${n}`);
      assert.equal(ext.jobs.filter((j) => j.subId).length, 1, `oferta ${n}: com 2 Sub_ids distintos, só o 1º é pedido: ${JSON.stringify(ext.jobs.map((j) => j.subId ?? null))}`);
      assert.equal(ext.jobs.length, 2, `oferta ${n}: o base e um Sub_id`);
      assert.ok(s.wa.simulated.every((m) => linkDoTexto(m) === LINK_BASE), `oferta ${n}: o link que sai é o de afiliado base`);
      assert.deepEqual(linhas(s.db, 'SELECT jid, codigo, nivel, esperado, motivo FROM rastreio_envios WHERE envio_id = ? ORDER BY jid', e.id).map((x) => [x.codigo, x.nivel, x.esperado, x.motivo]),
        [null, null, null].map(() => [null, 'nenhum', 1, 'subid_nao_aplicado']), `oferta ${n}: todos sem código, com o motivo`);
    }
  } finally { await ext.parar(); await s.fechar(); }
});

// ================================================================================================
// Parte 2: o painel num Chrome headless de verdade (M16, filtro de grupo, link da oferta, endereço, "Ver ganhos", Operador, .zip)
// ================================================================================================

function acharChrome() {
  const candidatos = [process.env.CHROME_BIN, 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].filter(Boolean);
  for (const c of candidatos) {
    if (path.isAbsolute(c)) { if (fs.existsSync(c)) return c; continue; }
    for (const dir of (process.env.PATH || '').split(path.delimiter)) { const f = path.join(dir, c); if (fs.existsSync(f)) return f; }
  }
  return null;
}
const CHROME = acharChrome();
const NAV = { skip: CHROME ? false : 'sem Chrome/Chromium (defina CHROME_BIN): a parte do painel de QA da Entrega C foi pulada', timeout: 120000 };
const livre = () => new Promise((ok, falha) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); s.on('error', falha); });

/** Painel de verdade, simulado e sem login. `semear(db)` roda antes de subir (o banco é descartável). */
async function subirPainel(semear) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-qaganhosc-')); pastas.push(dir);
  if (semear) { const db = openDb(dir); semear(db); db.close(); }
  const porta = await livre();
  const env = { ...process.env, PORT: String(porta), DATA_DIR: dir, DRY_RUN: '1', FAST: '1', PANEL_PASSWORD: '', PUBLIC_HOST: '', TMPDIR: dir };
  const filho = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(RAIZ, 'src', 'server.js')], { cwd: RAIZ, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  filhos.push(filho);
  let saida = '';
  await new Promise((ok, falha) => {
    const timer = setTimeout(() => falha(new Error(`servidor não subiu em 20 s:\n${saida}`)), 20000);
    const ler = (c) => { saida += c; if (/rodando em http/.test(saida)) { clearTimeout(timer); ok(); } };
    filho.stdout.on('data', ler); filho.stderr.on('data', ler);
    filho.once('exit', (c) => { clearTimeout(timer); falha(new Error(`servidor saiu (${c}):\n${saida}`)); });
  });
  return { base: `http://127.0.0.1:${porta}`, filho, dir };
}

async function subirChrome() {
  const curto = fs.mkdtempSync(path.join(fs.existsSync('/dev/shm') ? '/dev/shm' : '/tmp', 'qaganhos-')); pastas.push(curto);
  const perfil = path.join(curto, 'p'); fs.mkdirSync(perfil);
  const args = ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-extensions', '--remote-debugging-port=0',
    `--user-data-dir=${perfil}`, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost', 'about:blank'];
  const filho = spawn(CHROME, args, { stdio: 'ignore', detached: true, env: { ...process.env, TMPDIR: curto } });
  filhos.push(filho);
  const arq = path.join(perfil, 'DevToolsActivePort'); const t0 = Date.now();
  while (!fs.existsSync(arq) || !fs.readFileSync(arq, 'utf8').includes('\n')) {
    if (Date.now() - t0 > 20000) throw new Error('Chrome não abriu a porta de depuração em 20 s');
    await dorme(50);
  }
  return { porta: Number(fs.readFileSync(arq, 'utf8').split('\n')[0]), filho };
}

/** Aba com o driver CDP mínimo (WebSocket global do Node 22). */
async function abrirAba(chrome, url) {
  const alvo = await (await fetchLocal(`http://127.0.0.1:${chrome.porta}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise((ok, falha) => { ws.addEventListener('open', ok); ws.addEventListener('error', () => falha(new Error('WebSocket do Chrome'))); });
  let n = 0; const esperando = new Map(); const eventos = [];
  ws.addEventListener('message', (m) => {
    const d = JSON.parse(m.data);
    if (d.id && esperando.has(d.id)) { esperando.get(d.id)(d); esperando.delete(d.id); } else if (d.method) eventos.push(d);
  });
  const cmd = (method, params = {}) => new Promise((ok, err) => { const id = ++n; esperando.set(id, (d) => (d.error ? err(new Error(JSON.stringify(d.error))) : ok(d.result))); ws.send(JSON.stringify({ id, method, params })); });
  await cmd('Runtime.enable'); await cmd('Page.enable'); await cmd('Log.enable'); await cmd('Page.bringToFront');
  const js = async (expr) => {
    const r = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'erro de JavaScript na página');
    return r.result.value;
  };
  const esperar = async (expr, ms = 8000, rotulo = expr) => {
    const t0 = Date.now(); let ultimo;
    while (Date.now() - t0 < ms) { try { ultimo = await js(expr); if (ultimo) return ultimo; } catch (e) { ultimo = e.message; } await dorme(30); }
    throw new Error(`timeout esperando: ${rotulo} (último: ${JSON.stringify(ultimo)})`);
  };
  const clicar = async (sel) => {
    const pos = await js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    if (!pos) throw new Error('sem elemento para clicar: ' + sel);
    const [x, y] = pos;
    await cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const erros = () => eventos
    .filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
    .map((e) => JSON.stringify(e.params).slice(0, 300))
    .filter((x) => !/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(x)); // sem rede, as fontes do Google falham de propósito
  const tela = (largura, altura = 900) => cmd('Emulation.setDeviceMetricsOverride', { width: largura, height: altura, deviceScaleFactor: 1, mobile: false });
  return { id: alvo.id, cmd, js, esperar, clicar, erros, tela, fechar: async () => { try { ws.close(); await fetchLocal(`http://127.0.0.1:${chrome.porta}/json/close/${alvo.id}`); } catch { /* já fechou */ } } };
}

let chrome;
before(async () => { if (CHROME) chrome = await subirChrome(); }, { timeout: 60000 });
const VISAO_PRONTA = "!!document.querySelector('#pagina .grade-vg')";
async function abaNoPainel(t, painel, hash) {
  const p = await abrirAba(chrome, painel.base + '/#visao');
  t.after(() => p.fechar());
  await p.tela(1280); // em tela estreita o menu fica atrás do botão "Menu"
  await p.esperar(VISAO_PRONTA, 15000, 'painel carregado');
  if (hash) await p.js(`location.hash = ${JSON.stringify(hash)}`);
  return p;
}
const norm = (x) => String(x ?? '').replace(/\s+/g, ' ').trim();
const texto = (p, sel) => p.js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e ? e.textContent.replace(/\\s+/g, ' ').trim() : null; })()`);
/** Pedidos de /api/ganhos feitos pela página desde o último carregamento (nome com a consulta). */
const pedidosGanhos = async (p) => JSON.parse(await p.js("JSON.stringify(performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('/api/ganhos?')).map((n) => n.slice(n.indexOf('/api/'))))"));
const consulta = (url) => new URLSearchParams(url.slice(url.indexOf('?') + 1));
const iso = (n) => { const d = new Date(Date.now() - n * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const A = '111@g.us'; const B = '222@g.us';

/** Dono com dois grupos, um bloco e códigos da Amazon por grupo e por bloco; os envios saíram 20 dias atrás (antes de qualquer venda). */
function semearAmazon(db, { envioDepoisDaVenda = false } = {}) {
  const agora = Date.now();
  for (const [jid, nome] of [[A, 'Achados'], [B, 'Casa']]) db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, nome, 10, agora);
  db.prepare("INSERT INTO blocks (id, name, created_at) VALUES (1, 'Casa e cozinha', 1)").run();
  for (const jid of [A, B]) db.prepare('INSERT INTO block_groups (block_id, jid) VALUES (1, ?)').run(jid);
  rastreio.salvar(db, { loja: 'amazon', alvo_tipo: 'grupo', alvo: A, codigo: 'achados-20' });
  rastreio.salvar(db, { loja: 'amazon', alvo_tipo: 'grupo', alvo: B, codigo: 'casa-20' });
  rastreio.salvar(db, { loja: 'amazon', alvo_tipo: 'bloco', alvo: '1', codigo: 'turbob1-20' });
  const ts = envioDepoisDaVenda ? agora : agora - 20 * 86400000;
  const envio = (jid, codigo, nivel, oferta, extra = {}) => rastreio.registrar(db, { ts, jid, loja: 'amazon', origem: 'manual', link: `https://exemplo.invalid/${codigo}`, codigo, nivel, esperado: 1, oferta_chave: oferta, ...extra });
  envio(A, 'achados-20', 'grupo', 'ASIN:B0TESTE001');
  envio(B, 'casa-20', 'grupo', 'ASIN:B0TESTE002'); envio(B, 'casa-20', 'grupo', 'ASIN:B0TESTE001');
  for (const jid of [A, B]) envio(jid, 'turbob1-20', 'bloco', 'ASIN:B0TESTE003', { bloco_id: 1 });
  const cab = 'Date,Tracking ID,ASIN,Product Title,Items Shipped,Items Shipped Revenue,Total Earnings';
  const vendas = [
    [2, 'achados-20', 'B0TESTE001', 'Panela inventada', '100.00', '10.00'], [3, 'casa-20', 'B0TESTE002', 'Fone inventado', '50.00', '5.00'],
    [4, 'casa-20', 'B0TESTE001', 'Panela inventada', '30.00', '3.00'], [5, 'turbob1-20', 'B0TESTE003', 'Livro inventado', '40.00', '4.00'],
    [6, 'solto-20', 'B0TESTE004', 'Capa inventada', '10.00', '1.00'],
    [40, 'achados-20', 'B0TESTE001', 'Panela inventada', '50.00', '5.00'], // período anterior
  ].map(([n, c, asin, tit, rec, ganho]) => `${iso(n)},${c},${asin},${tit},1,${rec},${ganho}`);
  importar(db, csv(cab, ...vendas), { loja: 'amazon', tipo: 'comissoes' });
  importar(db, csv('Date,Tracking ID,Clicks', `${iso(2)},achados-20,50.0`, `${iso(40)},achados-20,25.0`), { loja: 'amazon', tipo: 'cliques' });
}

test('CA3/CA4/CA5 (plano C) no Chrome: período anterior nos cartões, clique no grupo filtra "Por oferta", link da oferta sem afiliado, voltar a todas', NAV, async (t) => {
  const painel = await subirPainel((db) => semearAmazon(db));
  const p = await abaNoPainel(t, painel, '#ganhos');
  await p.esperar("document.querySelector('#pagina [data-m=comissao] .valor')?.textContent.includes('23,00')", 15000, 'cartão Comissão com R$ 23,00');

  // M16: o texto de cada cartão (valor anterior e variação com sinal e palavra)
  const nota = (m) => texto(p, `#pagina [data-m="${m}"]`);
  assert.match(await nota('comissao'), /Período anterior: R\$ 5,00 \(\+360%, mais\)/);
  assert.match(await nota('vendas'), /Período anterior: 1 \(\+400%, mais\)/);
  assert.match(await nota('cliques'), /Período anterior: 25 \(\+100%, mais\)/);
  assert.match(await nota('epc'), /Período anterior: R\$ 0,20 \(\+130%, mais\)/);
  assert.match(await nota('conversao'), /Período anterior: 4% \(\+150%, mais\)/);
  assert.match(await nota('envios'), /Período anterior: 0(?! \()/, 'sem base (anterior 0): só o valor, sem %');
  assert.doesNotMatch(await nota('envios'), /Infinity|NaN|%/);
  for (const m of ['gasto', 'retorno', 'custo', 'atribuida']) assert.doesNotMatch(await nota(m), /Período anterior/, `${m} não leva comparação (P-C3)`);
  assert.match(norm(await p.js("document.querySelector('#pagina .topo .sub').textContent")), /Comparado com o período anterior, de \d{2}\/\d{2}\/\d{4} a \d{2}\/\d{2}\/\d{4}\./);

  // as 5 cargas: só a de por=grupo leva comparar=1 (e nenhuma leva `grupo`)
  const carga = await pedidosGanhos(p);
  assert.deepEqual(carga.map((u) => consulta(u).get('por')).sort(), ['bloco', 'dia', 'grupo', 'loja', 'oferta']);
  assert.deepEqual(carga.filter((u) => consulta(u).get('comparar') === '1').map((u) => consulta(u).get('por')), ['grupo']);
  assert.ok(carga.every((u) => !consulta(u).has('grupo')));

  // por grupo: o nome é um botão; "Sem grupo identificado" não é (a venda de solto-20 não tem envio)
  assert.equal(await p.js("document.querySelectorAll('#g-sec-grupo tbody button.g-grupo').length"), 2);
  assert.equal(await texto(p, '#g-sec-grupo tbody tr.sem-grupo td'), 'Sem grupo identificado');
  assert.equal(await p.js("document.querySelectorAll('#g-sec-grupo tbody tr.sem-grupo button').length"), 0);
  assert.equal(await p.js("[...document.querySelectorAll('#g-sec-oferta tbody tr')].length"), 4, 'sem filtro: as 4 ofertas');

  // grupo A: só a venda atribuída ao próprio A (achados-20); a venda do bloco e a do casa-20 não entram
  await p.clicar(`#g-sec-grupo button[data-grupo="${A}"]`);
  await p.esperar("document.querySelector('#g-sec-oferta h2')?.textContent.includes('Por oferta: grupo Achados')", 8000, 'título filtrado');
  assert.equal(await p.js(`document.querySelector('#g-sec-grupo button[data-grupo="${A}"]').getAttribute('aria-pressed')`), 'true');
  assert.equal(await p.js(`document.querySelector('#g-sec-grupo button[data-grupo="${B}"]').getAttribute('aria-pressed')`), 'false');
  assert.deepEqual(JSON.parse(await p.js("JSON.stringify([...document.querySelectorAll('#g-sec-oferta tbody tr')].map((r) => [...r.cells].map((c) => c.textContent.replace(/\\s+/g, ' ').trim())))")), [
    ['Panela inventada', 'Amazon', '1', 'R$ 10,00', '1'],
  ]);
  assert.ok((await texto(p, '#g-sec-oferta')).includes('Ver todas as ofertas'));
  const depoisDeA = await pedidosGanhos(p);
  assert.equal(depoisDeA.length, carga.length + 1, 'um GET só');
  const q1 = consulta(depoisDeA.at(-1));
  assert.deepEqual([q1.get('por'), q1.get('grupo'), q1.has('bloco'), q1.has('comparar')], ['oferta', A, false, false]);
  // o link da oferta: página do produto, sem afiliado, outra aba, sem Referer
  const link = JSON.parse(await p.js("JSON.stringify((() => { const a = document.querySelector('#g-sec-oferta tbody a'); return a && { href: a.href, target: a.target, rel: a.rel, aria: a.getAttribute('aria-label'), texto: a.textContent }; })())"));
  assert.deepEqual([link.href, link.target], ['https://www.amazon.com.br/dp/B0TESTE001', '_blank']);
  assert.ok(link.rel.split(' ').includes('noopener') && link.rel.split(' ').includes('noreferrer'), link.rel);
  assert.match(link.aria, /Panela inventada.*sem seu link de afiliado.*abre em outra aba/);
  assert.ok(!/tag=/.test(link.href));

  // grupo B: duas ofertas, a maior comissão primeiro (5,00 e 3,00)
  await p.clicar(`#g-sec-grupo button[data-grupo="${B}"]`);
  await p.esperar("document.querySelector('#g-sec-oferta h2')?.textContent.includes('Por oferta: grupo Casa')", 8000, 'título do B');
  assert.deepEqual(JSON.parse(await p.js("JSON.stringify([...document.querySelectorAll('#g-sec-oferta tbody tr')].map((r) => [r.cells[0].textContent.trim(), r.cells[3].textContent.replace(/\\s+/g, ' ').trim()]))")), [['Fone inventado', 'R$ 5,00'], ['Panela inventada', 'R$ 3,00']]);

  // clicar de novo no mesmo grupo volta a todas, sem pedido novo
  const antesDeVoltar = (await pedidosGanhos(p)).length;
  await p.clicar(`#g-sec-grupo button[data-grupo="${B}"]`);
  await p.esperar("document.querySelector('#g-sec-oferta h2')?.textContent.trim().startsWith('Por oferta') && !document.querySelector('#g-sec-oferta h2').textContent.includes('grupo')", 8000, 'voltou a todas');
  assert.equal(await p.js("document.querySelectorAll('#g-sec-oferta tbody tr').length"), 4);
  assert.equal((await pedidosGanhos(p)).length, antesDeVoltar, 'voltar não pede nada');
  // "Ver todas as ofertas" também volta
  await p.clicar(`#g-sec-grupo button[data-grupo="${A}"]`);
  await p.esperar("!!document.querySelector('#g-oferta-todas')", 8000, 'botão Ver todas as ofertas');
  await p.clicar('#g-oferta-todas');
  await p.esperar("!document.querySelector('#g-oferta-todas') && document.querySelectorAll('#g-sec-oferta tbody tr').length === 4", 8000, 'voltou pelo botão');
  // trocar um filtro apaga o filtro de grupo (P-C4) e o endereço não o leva
  await p.clicar(`#g-sec-grupo button[data-grupo="${A}"]`);
  await p.esperar("!!document.querySelector('#g-oferta-todas')");
  await p.clicar('#g-loja [data-loja="amazon"]');
  await p.esperar("!document.querySelector('#g-oferta-todas') && document.querySelector('#g-loja [data-loja=amazon]').getAttribute('aria-pressed') === 'true'", 8000, 'filtro de loja trocou');
  assert.ok(!(await p.js('location.hash')).includes('grupo'), 'o grupo clicado não vai para o endereço');
  assert.doesNotMatch(norm(await p.js("document.querySelector('#pagina').textContent")), /NaN|undefined|\bnull\b|Infinity/);
  assert.deepEqual(p.erros(), []);
});

test('Item 5: no navegador, com os envios ANTES das vendas o filtro por grupo mostra as vendas do grupo; com os envios DEPOIS tudo fica em "Sem grupo identificado" (desenho, não bug)', NAV, async (t) => {
  const painel = await subirPainel((db) => semearAmazon(db, { envioDepoisDaVenda: true }));
  const p = await abaNoPainel(t, painel, '#ganhos');
  await p.esperar("document.querySelector('#pagina [data-m=comissao] .valor')?.textContent.includes('23,00')", 15000, 'cartão Comissão');
  // o código está associado ao grupo, mas os envios com ele são de hoje e as vendas são de dias atrás: ninguém é dono delas
  assert.equal(await texto(p, '#g-sec-grupo tbody tr.sem-grupo td[data-rot="Comissão"]'), 'R$ 23,00', 'tudo sem grupo identificado');
  assert.deepEqual(JSON.parse(await p.js("JSON.stringify([...document.querySelectorAll('#g-sec-grupo tbody tr:not(.sem-grupo)')].map((r) => r.cells[2].textContent.replace(/\\s+/g, ' ').trim()))")), ['R$ 0,00', 'R$ 0,00']);
  await p.clicar(`#g-sec-grupo button[data-grupo="${A}"]`);
  await p.esperar("document.querySelector('#g-sec-oferta h2')?.textContent.includes('Por oferta: grupo Achados')", 8000, 'título filtrado');
  assert.equal(await p.js("document.querySelectorAll('#g-sec-oferta tbody tr').length"), 0);
  assert.match(await texto(p, '#g-sec-oferta'), /Nenhuma venda com produto atribuída a este grupo/, 'a tela explica a lista vazia');
});

const XSS_NOME = 'Casa"><img src=x onerror="window.__xss=1">';

test('CA4/CA5/CA10 (plano C) no Chrome: nome de grupo e título de oferta com HTML e aspas viram texto no botão, no título "Por oferta: grupo …", no link e no aria-label', NAV, async (t) => {
  const painel = await subirPainel((db) => {
    semearAmazon(db);
    db.prepare('UPDATE groups SET name = ? WHERE jid = ?').run(XSS_NOME, B);
    db.prepare('UPDATE comissoes SET titulo = ? WHERE produto = ?').run('Fone"><script>window.__xss=2</script> & <b>negrito</b>', 'B0TESTE002');
  });
  const p = await abaNoPainel(t, painel, '#ganhos');
  await p.js('window.__xss = 0');
  await p.esperar("document.querySelector('#pagina [data-m=comissao] .valor')?.textContent.includes('23,00')", 15000, 'Ganhos');
  await p.clicar(`#g-sec-grupo button[data-grupo="${B}"]`);
  await p.esperar("document.querySelector('#g-sec-oferta h2')?.textContent.includes('Por oferta: grupo Casa')", 8000, 'filtrado pelo grupo B');
  assert.equal(await p.js('window.__xss'), 0);
  assert.equal(await p.js("document.querySelectorAll('#pagina img, #pagina script').length"), 0, 'nada virou marcação');
  assert.equal(await p.js("[...document.querySelectorAll('#pagina b')].filter((b) => b.textContent.includes('negrito')).length"), 0, 'o <b> do título também é texto');
  assert.ok((await texto(p, '#g-sec-oferta h2')).includes(`Por oferta: grupo ${XSS_NOME}`), 'o nome cru aparece como texto no título');
  assert.equal(await texto(p, `#g-sec-grupo button[data-grupo="${B}"]`), XSS_NOME);
  const aria = await p.js("document.querySelector('#g-sec-oferta tbody a').getAttribute('aria-label')");
  assert.ok(aria.startsWith('Fone"><script>window.__xss=2</script> & <b>negrito</b> na loja, sem seu link de afiliado'), aria);
  assert.equal(await p.js("document.querySelector('#g-sec-oferta tbody a').href"), 'https://www.amazon.com.br/dp/B0TESTE002');
  assert.deepEqual(p.erros(), []);
});

test('CA4 (plano C) no Chrome: clicar em outro grupo enquanto a resposta do primeiro ainda não chegou — a tela fica com o último clique (resposta velha descartada)', NAV, async (t) => {
  const painel = await subirPainel((db) => semearAmazon(db));
  const p = await abaNoPainel(t, painel, '#ganhos');
  await p.esperar("document.querySelector('#pagina [data-m=comissao] .valor')?.textContent.includes('23,00')", 15000, 'Ganhos');
  // atrasa só a resposta do grupo A em 900 ms (o painel já está carregado: o fetch embrulhado vale daqui em diante)
  await p.js(`(() => { const f = window.fetch; window.fetch = (u, ...r) => (String(u).includes('grupo=111') ? new Promise((ok) => setTimeout(ok, 900)).then(() => f(u, ...r)) : f(u, ...r)); })()`);
  await p.clicar(`#g-sec-grupo button[data-grupo="${A}"]`);
  await p.clicar(`#g-sec-grupo button[data-grupo="${B}"]`);
  await p.esperar("document.querySelector('#g-sec-oferta h2')?.textContent.includes('Por oferta: grupo Casa')", 8000, 'B apareceu');
  await dorme(1500); // a resposta atrasada do A chega e não pode sobrescrever
  assert.match(await texto(p, '#g-sec-oferta h2'), /Por oferta: grupo Casa/);
  assert.equal(await p.js(`document.querySelector('#g-sec-grupo button[data-grupo="${B}"]').getAttribute('aria-pressed')`), 'true');
  assert.equal(await p.js(`document.querySelector('#g-sec-grupo button[data-grupo="${A}"]').getAttribute('aria-pressed')`), 'false');
  // trocar de filtro (nova carga) com uma resposta de grupo ainda a caminho: a resposta velha não reabre o filtro de grupo
  await p.clicar(`#g-sec-grupo button[data-grupo="${A}"]`);
  await p.clicar('#g-loja [data-loja="amazon"]');
  await dorme(1500);
  await p.esperar("document.querySelector('#g-loja [data-loja=amazon]')?.getAttribute('aria-pressed') === 'true'", 8000, 'carga com loja');
  assert.equal(await p.js("!!document.querySelector('#g-oferta-todas')"), false, 'a resposta velha do grupo não ressuscitou o filtro');
  assert.deepEqual(p.erros(), []);
});

// ---------------------------------------------------------------------------------------------- endereço #ganhos?…

/** Filtros aceitos que a página mostra (botões marcados) e o endereço que ficou. */
const filtrosNaTela = async (p) => JSON.parse(await p.js(`JSON.stringify({
  periodo: document.querySelector('#g-per [aria-pressed=true]')?.dataset.p ?? null,
  bloco: document.querySelector('#g-blc [aria-pressed=true]')?.dataset.b ?? null,
  loja: document.querySelector('#g-loja [aria-pressed=true]')?.dataset.loja ?? null,
  de: document.querySelector('#g-de')?.value ?? null, ate: document.querySelector('#g-ate')?.value ?? null,
  hash: location.hash })`));
const GANHOS_PRONTO = "!!document.querySelector('#pagina #g-per') && !!document.querySelector('#pagina [data-m=comissao] .valor') && !/Carregando/.test(document.querySelector('#pagina .sub')?.textContent || '')";

test('CA6 (plano C) no Chrome: #ganhos?periodo=7d&bloco=1&loja=amazon aberto a frio já vem filtrado, pede o servidor com esses filtros e o endereço acompanha as trocas', NAV, async (t) => {
  const painel = await subirPainel((db) => semearAmazon(db));
  const p = await abrirAba(chrome, `${painel.base}/#ganhos?bloco=1&loja=amazon&periodo=7d`); // a frio: o estado do painel ainda nem chegou
  t.after(() => p.fechar());
  await p.tela(1280);
  await p.esperar(GANHOS_PRONTO, 15000, 'Ganhos filtrado pelo endereço');
  let f = await filtrosNaTela(p);
  assert.deepEqual([f.periodo, f.bloco, f.loja], ['7d', '1', 'amazon']);
  assert.deepEqual([...consulta(`?${f.hash.split('?')[1]}`)].sort(), [['bloco', '1'], ['loja', 'amazon'], ['periodo', '7d']], 'o endereço guarda só os filtros, na ordem canônica');
  assert.ok(f.hash.startsWith('#ganhos?'));
  const pedidos = await pedidosGanhos(p);
  assert.equal(pedidos.length, 5);
  for (const u of pedidos) { const q = consulta(u); assert.deepEqual([q.get('periodo'), q.get('bloco'), q.get('loja')], ['7d', '1', 'amazon'], u); }
  const cobertura = JSON.parse(await p.js("JSON.stringify(performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('/api/rastreio/cobertura')).map((n) => n.slice(n.indexOf('/api/'))))"));
  assert.ok(cobertura.length >= 1 && cobertura.every((u) => consulta(u).get('bloco') === '1' && consulta(u).get('loja') === 'amazon'), cobertura.join(' '));
  // o recorte do bloco 1 pela Amazon em 7 dias: as vendas dos grupos dele (10 + 5 + 3) e a do código do bloco (4); a solta (1) fica fora
  assert.equal(await texto(p, '#pagina [data-m=comissao] .valor'), 'R$ 22,00');

  // trocar um filtro reescreve o endereço (sem acrescentar entradas no histórico)
  const antesHistorico = await p.js('history.length');
  await p.clicar('#g-per [data-p="30d"]');
  await p.esperar("document.querySelector('#g-per [data-p=\"30d\"]')?.getAttribute('aria-pressed') === 'true' && document.querySelector('#pagina [data-m=comissao] .valor')?.textContent.includes('22,00')", 8000, '30 dias');
  f = await filtrosNaTela(p);
  assert.equal(f.hash, '#ganhos?periodo=30d&bloco=1&loja=amazon');
  assert.equal(await p.js('history.length'), antesHistorico, 'replaceState: o histórico do navegador não cresce');
  await p.clicar('#g-blc [data-b=""]'); await p.esperar("document.querySelector('#g-blc [data-b=\"\"]')?.getAttribute('aria-pressed') === 'true'", 8000, 'todos os grupos');
  assert.equal((await filtrosNaTela(p)).hash, '#ganhos?periodo=30d&loja=amazon');
  await p.clicar('#g-loja [data-loja=""]'); await p.esperar("document.querySelector('#g-loja [data-loja=\"\"]')?.getAttribute('aria-pressed') === 'true'", 8000, 'todas as lojas');
  assert.equal((await filtrosNaTela(p)).hash, '#ganhos', 'tudo no padrão: endereço limpo');

  // mudar o endereço na barra (hashchange) com Ganhos aberto aplica os filtros novos
  await p.js("location.hash = '#ganhos?loja=shopee&periodo=mes'");
  await p.esperar("document.querySelector('#g-loja [data-loja=shopee]')?.getAttribute('aria-pressed') === 'true' && document.querySelector('#g-per [data-p=mes]')?.getAttribute('aria-pressed') === 'true'", 10000, 'hashchange aplicou');
  // endereço sem consulta mantém o filtro atual (navegação pelo menu não perde filtro)
  await p.js("location.hash = '#visao'");
  await p.esperar(VISAO_PRONTA, 10000);
  await p.clicar('#rail nav a[href="#ganhos"]');
  await p.esperar(GANHOS_PRONTO, 10000, 'Ganhos pelo menu').catch(async (e) => { throw new Error(`${e.message} | hash=${await p.js('location.hash')} | tela=${(await texto(p, '#pagina'))?.slice(0, 300)}`); });
  f = await filtrosNaTela(p);
  assert.deepEqual([f.periodo, f.loja, f.hash], ['mes', 'shopee', '#ganhos?periodo=mes&loja=shopee'], 'o menu volta ao filtro que estava');
  assert.deepEqual(p.erros(), []);
});

test('CA6/CA10 (plano C) no Chrome: valor inválido, repetido ou com HTML no endereço é ignorado (nunca vai ao HTML nem ao seletor); bloco que não existe volta ao padrão sem erro', NAV, async (t) => {
  const painel = await subirPainel((db) => semearAmazon(db));
  const p = await abaNoPainel(t, painel);
  await p.js('window.__xss = 0');
  const abrir = async (hash) => {
    await p.js(`location.hash = ${JSON.stringify(hash)}`);
    await p.esperar(GANHOS_PRONTO, 10000, hash);
  };
  await abrir('#ganhos?bloco=01&loja=x&periodo=zz');
  assert.deepEqual(await filtrosNaTela(p), { periodo: '30d', bloco: '', loja: '', de: null, ate: null, hash: '#ganhos' }, 'tudo inválido: padrão, endereço limpo');
  await abrir('#ganhos?loja=amazon&loja=shopee&bloco=1&bloco=2');
  assert.deepEqual(await filtrosNaTela(p), { periodo: '30d', bloco: '', loja: '', de: null, ate: null, hash: '#ganhos' }, 'repetido é ignorado');
  await abrir('#ganhos?bloco=1e0&periodo=7d');
  assert.deepEqual(await filtrosNaTela(p), { periodo: '7d', bloco: '', loja: '', de: null, ate: null, hash: '#ganhos?periodo=7d' }, 'só o válido entra');
  await abrir(`#ganhos?bloco=${encodeURIComponent('1"><img src=x onerror="window.__xss=1">')}&loja=${encodeURIComponent('amazon"],[x="')}&periodo=${encodeURIComponent('<script>window.__xss=2</script>')}`);
  assert.equal(await p.js('window.__xss'), 0);
  assert.equal(await p.js("document.querySelectorAll('#pagina img, #pagina script').length"), 0);
  assert.equal((await filtrosNaTela(p)).hash, '#ganhos');
  await abrir('#ganhos?periodo=custom&de=2026-10-01&ate=2026-10-31');
  assert.deepEqual(await filtrosNaTela(p), { periodo: 'custom', bloco: '', loja: '', de: '2026-10-01', ate: '2026-10-31', hash: '#ganhos?periodo=custom&de=2026-10-01&ate=2026-10-31' });
  assert.ok((await pedidosGanhos(p)).slice(-5).every((u) => consulta(u).get('de') === '2026-10-01' && consulta(u).get('ate') === '2026-10-31'));
  await abrir('#ganhos?de=2026-10-01&ate=2026-10-31');
  assert.equal((await filtrosNaTela(p)).hash, '#ganhos', 'de e ate sem periodo=custom não valem');
  // bloco no formato certo mas que não existe: o servidor responde 404 e a página volta a "todos os grupos" sem tela de erro
  await abrir('#ganhos?bloco=999');
  const f = await filtrosNaTela(p);
  assert.deepEqual([f.bloco, f.hash], ['', '#ganhos']);
  assert.equal(await p.js("!!document.querySelector('#g-tentar, #g-erro-din')"), false, 'sem cartão de erro');
  assert.deepEqual(p.erros().filter((e) => !/404/.test(e)), []);
});

test('CA6 (plano C) no Chrome: data impossível no endereço (2026-13-45) não deixa o dono preso numa tela de erro', NAV, async (t) => {
  const painel = await subirPainel((db) => semearAmazon(db));
  const p = await abaNoPainel(t, painel);
  await p.js("location.hash = '#ganhos?periodo=custom&de=2026-13-45&ate=2026-13-46'");
  await p.esperar("!!document.querySelector('#g-per') || !!document.querySelector('#g-tentar')", 10000, 'Ganhos respondeu');
  // esperado: a página abre com filtros utilizáveis (data inválida ignorada) ou, no mínimo, os filtros continuam na tela para corrigir
  assert.equal(await p.js("!!document.querySelector('#g-per')"), true, `ficou só a tela de erro: ${await texto(p, '#pagina')}`);
});

// ---------------------------------------------------------------------------------------------- "Ver ganhos" e Operador

/** Painel novo com login, semeado: a aba abre como Dono (ativa o login e cria o convite), depois a mesma aba vira o Operador. */
async function comOperador(t, semear) {
  const painel = await subirPainel(semear);
  const p = await abrirAba(chrome, painel.base + '/#visao');
  t.after(() => p.fechar());
  await p.tela(1280);
  await p.esperar(VISAO_PRONTA, 15000, 'painel carregado');
  const api = (rota, metodo, corpo) => p.js(`fetch('/api${rota}', { method: '${metodo}', headers: { 'content-type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(corpo))} }).then(async (r) => JSON.stringify({ s: r.status, j: await r.json().catch(() => null) }))`).then(JSON.parse);
  assert.equal((await api('/equipe/ativar', 'POST', { nome: 'Ana Dona', email: 'ana@exemplo.com', senha: 'senha-forte-123' })).s, 200);
  const convite = await api('/equipe/convites', 'POST', { email: 'bia@exemplo.com', papel: 'operador' });
  assert.equal(convite.s, 201);
  // depois de recarregar, o #pessoa aparece antes de a Visão Geral terminar: esperar a Visão Geral pronta antes de navegar
  const recarregar = async (hash, quem) => {
    await p.js(`location.hash = ${JSON.stringify(hash)}`); await p.js('location.reload()');
    await p.esperar(`document.querySelector('#pessoa')?.textContent.includes(${JSON.stringify(quem)})`, 12000, `${quem} no painel`);
    if (hash === '#visao') await p.esperar(VISAO_PRONTA, 15000, 'Visão Geral carregada');
  };
  const comoDono = async () => { await recarregar('#visao', 'Ana Dona'); };
  const virarOperador = async () => {
    assert.equal((await api('/convite/aceitar', 'POST', { token: convite.j.link.split('#')[1], nome: 'Bia Operadora', senha: 'senha-da-bia-12345' })).s, 200);
    await recarregar('#visao', 'Bia Operadora');
  };
  return { p, api, comoDono, virarOperador, recarregar };
}

test('CA6 (plano C) no Chrome: "Ver ganhos" no cartão do bloco abre Ganhos já filtrado pelo bloco; o Operador não tem o link e o endereço #ganhos?bloco=1 o desvia para a Visão Geral sem chamar /api/ganhos', NAV, async (t) => {
  const { p, comoDono, virarOperador, recarregar } = await comOperador(t, (db) => semearAmazon(db));
  await comoDono();
  await p.js("location.hash = '#blocos'");
  await p.esperar("!!document.querySelector('#pagina article[data-id=\"1\"]')", 10000, 'cartão do bloco');
  const ver = JSON.parse(await p.js("JSON.stringify((() => { const a = document.querySelector('#pagina article[data-id=\"1\"] a[href^=\"#ganhos\"]'); return a && { href: a.getAttribute('href'), texto: a.textContent, aria: a.getAttribute('aria-label') }; })())"));
  assert.deepEqual(ver, { href: '#ganhos?bloco=1', texto: 'Ver ganhos', aria: 'Ver ganhos do bloco Casa e cozinha' });
  await p.clicar('#pagina article[data-id="1"] a[href^="#ganhos"]');
  await p.esperar(GANHOS_PRONTO, 12000, 'Ganhos pelo atalho');
  const f = await filtrosNaTela(p);
  assert.deepEqual([f.periodo, f.bloco, f.loja, f.hash], ['30d', '1', '', '#ganhos?periodo=30d&bloco=1']);
  assert.ok((await pedidosGanhos(p)).every((u) => consulta(u).get('bloco') === '1'));
  // com o bloco filtrado: o B1 vê as vendas dos grupos dele e do próprio código (10+5+3+4 = 22,00); a solta (1,00) fica fora
  assert.equal(await texto(p, '#pagina [data-m=comissao] .valor'), 'R$ 22,00');

  // Operador: sem o link no cartão e desviado do endereço de Ganhos, sem nenhum pedido de ganhos nem de rastreio
  await virarOperador();
  await p.js("location.hash = '#blocos'");
  await p.esperar("!!document.querySelector('#pagina article[data-id=\"1\"]')", 10000, 'cartão do bloco do Operador');
  assert.equal(await p.js("!!document.querySelector('#pagina article a[href^=\"#ganhos\"]')"), false, 'o Operador não vê "Ver ganhos"');
  assert.equal(await p.js("!!document.querySelector('#rail nav a[href=\"#ganhos\"]')"), false);
  await p.js("location.hash = '#ganhos?bloco=1'");
  await p.esperar("location.hash === '#visao'", 8000, 'Operador desviado pelo hashchange');
  // a frio, já com o endereço de Ganhos: recarregar com ele
  await recarregar('#ganhos?bloco=1', 'Bia Operadora');
  await p.esperar(VISAO_PRONTA, 15000, 'Visão Geral do Operador');
  assert.equal(await p.js('location.hash'), '#visao');
  const chamadas = JSON.parse(await p.js("JSON.stringify(performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /\\/api\\/(ganhos|rastreio)/.test(n)))"));
  assert.deepEqual(chamadas, [], 'o Operador nunca chama /api/ganhos nem /api/rastreio');
  // e o servidor também fecha as portas dos parâmetros novos (grupo e comparar) para ele
  for (const q of ['por=oferta&grupo=111%40g.us', 'por=grupo&comparar=1', 'por=oferta']) {
    assert.equal(await p.js(`fetch('/api/ganhos?${q}').then((r) => r.status)`), 403, q);
  }
  assert.deepEqual(p.erros().filter((e) => !/403/.test(e)), []);
});

// ---------------------------------------------------------------------------------------------- importar pelo diálogo (.zip, "ID de rastreamento")

/** Escolhe o arquivo (binário) no `input type=file` do diálogo como o navegador faz, disparando `change`. */
const escolherBinario = (p, nome, buf, tipo) => p.js(`(() => { const bytes = Uint8Array.from(atob(${JSON.stringify(buf.toString('base64'))}), (c) => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([bytes], ${JSON.stringify(nome)}, { type: ${JSON.stringify(tipo)} })); const i = document.querySelector('#imp-arq'); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); return i.files[0].size; })()`);
const mdy = (n) => { const [y, m, d] = iso(n).split('-'); return `${m}-${d}-${y}`; };

test('CA5 + P5 no Chrome: o dono importa o .zip da Amazon (comissões e cliques) e o "ID de rastreamento" (a tela pede a data) pelo diálogo; os valores aparecem no dashboard e o aviso de código aparece na prévia', NAV, async (t) => {
  const painel = await subirPainel((db) => {
    semearAmazon(db);
    db.prepare('DELETE FROM comissoes').run(); db.prepare('DELETE FROM cliques_loja').run(); db.prepare('DELETE FROM importacoes').run(); // só a base (grupos, códigos, envios)
  });
  const p = await abaNoPainel(t, painel, '#ganhos');
  await p.esperar("!!document.querySelector('#g-importar')", 15000, 'página Ganhos');
  await p.js('window.confirm = () => true');
  const lpZip = zip(NOME_ZIP, [CAB_LP,
    lp(mdy(2), 'Cozinha', 'Panela inventada', 'B0TESTE001', '10.0', '2.0', '0.0', '180.0', '9.0', '9.0'),
    lp(mdy(3), 'Casa', 'Fone inventado', 'B0TESTE002', '20.0', '1.0', '0.0', '50.0', '2.5', '2.5'),
    lp(mdy(2), '-', '-', 'Other', '245.0', '0.0', '0.0', '0.0', '0.0', '0'),
  ].join('\n') + '\n');

  const importarArquivo = async ({ nome, buf, tipo, loja, tipoRelatorio, codigo = '', dia = null }) => {
    await p.clicar('#g-importar');
    await p.esperar("!!document.querySelector('#dlg #imp-arq')", 8000, 'diálogo de importar');
    await p.clicar(`#dlg #imp-loja [data-loja="${loja}"]`);
    if (tipoRelatorio === 'cliques') await p.clicar('#dlg #imp-tipo [data-tipo="cliques"]');
    await escolherBinario(p, nome, buf, tipo);
    await p.js(`(() => { const e = document.querySelector('#imp-codigo'); e.value = ${JSON.stringify(codigo)}; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await p.esperar("!document.querySelector('#dlg #imp-ok').disabled", 5000, 'botão habilitado');
    await p.clicar('#dlg #imp-ok');
    if (dia) {
      await p.esperar("!document.querySelector('#dlg #imp-dia-campo').hidden", 8000, 'campo da data do relatório');
      assert.match(norm(await p.js("document.querySelector('#dlg').textContent")), /Este relatório não tem data por linha: informe a data do relatório\./);
      assert.equal(await p.js("document.activeElement?.id"), 'imp-dia', 'o foco vai para o campo da data');
      await p.js(`(() => { const e = document.querySelector('#imp-dia'); e.value = ${JSON.stringify(dia)}; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await p.clicar('#dlg #imp-ok');
    }
    await p.esperar("!!document.querySelector('#dlg #imp-gravar') || !!document.querySelector('#dlg .aviso-impl.neutro')", 8000, 'prévia');
  };
  const gravar = async () => {
    await p.clicar('#dlg #imp-gravar');
    await p.esperar("/Importado: Amazon/.test(document.querySelector('#dlg').textContent)", 8000, 'resumo de sucesso');
    return norm(await p.js("document.querySelector('#dlg').textContent"));
  };
  const fecharVer = async () => { await p.clicar('#dlg #imp-ver'); await p.esperar("!document.querySelector('#dlg').open", 8000, 'diálogo fechado'); };

  // 1) o .zip como comissões, com o código do bloco
  await importarArquivo({ nome: 'relatorio-produto-relacionado.zip', buf: lpZip, tipo: 'application/zip', loja: 'amazon', tipoRelatorio: 'comissoes', codigo: 'turbob1-20' });
  let dlg = norm(await p.js("document.querySelector('#dlg').textContent"));
  assert.match(dlg, /3 linhas lidas/); assert.match(dlg, /2 novas/);
  assert.match(dlg, /1 linha só tem cliques \(sem venda nem comissão\) e ficou de fora/, 'a "Other" só tem cliques: o aviso diz que ela fica de fora');
  assert.match(dlg, /Comissão no arquivo: R\$ 11,50/);
  assert.match(dlg, /Colunas lidas:.*Comissão \(Total Earnings\)/);
  assert.equal((await p.js("fetch('/api/ganhos/importacoes').then((r) => r.json())")).importacoes.length, 0, 'a prévia não gravou');
  await gravar(); await p.clicar('#dlg #imp-outro');
  // 2) o mesmo .zip como cliques
  await p.esperar("!!document.querySelector('#dlg #imp-tipo')", 5000);
  await importarArquivo({ nome: 'relatorio-produto-relacionado.zip', buf: lpZip, tipo: 'application/zip', loja: 'amazon', tipoRelatorio: 'cliques', codigo: 'turbob1-20' });
  assert.match(norm(await p.js("document.querySelector('#dlg').textContent")), /Cliques no arquivo: 275/);
  await gravar(); await fecharVer();
  await p.esperar("document.querySelector('#pagina [data-m=comissao] .valor')?.textContent.includes('11,50')", 10000, 'dashboard com a comissão importada');
  const kpi = (m) => texto(p, `#pagina [data-m="${m}"] .valor`);
  assert.deepEqual([await kpi('comissao'), await kpi('vendas'), await kpi('cliques')], ['R$ 11,50', '3', '275']);
  assert.equal(await texto(p, '#g-sec-bloco tbody tr[data-k="1"] td[data-rot="Comissão"]'), 'R$ 11,50', 'atribuído ao bloco do código');
  assert.deepEqual(JSON.parse(await p.js("JSON.stringify([...document.querySelectorAll('#g-sec-oferta tbody a')].map((a) => a.getAttribute('href')))")),
    ['https://www.amazon.com.br/dp/B0TESTE001', 'https://www.amazon.com.br/dp/B0TESTE002']);

  // 3) o mesmo .zip de novo, SEM código: a prévia mostra o aviso de contagem em dobro (CA1) e o dono não grava
  await importarArquivo({ nome: 'relatorio-produto-relacionado.zip', buf: lpZip, tipo: 'application/zip', loja: 'amazon', tipoRelatorio: 'comissoes' });
  dlg = norm(await p.js("document.querySelector('#dlg').textContent"));
  assert.match(dlg, /2 podem ser repetidas de outro código/);
  assert.match(dlg, /Se for o mesmo relatório importado de novo, não importe: as vendas contariam em dobro\./);
  assert.ok(!/turbob1/.test(dlg.replace(/Código informado.*/, '')), 'o aviso não repete o código');
  await p.clicar('#dlg #imp-voltar'); await p.clicar('#dlg #imp-cancelar');
  await p.esperar("!document.querySelector('#dlg').open", 5000);
  assert.equal((await p.js("fetch('/api/ganhos/importacoes').then((r) => r.json())")).importacoes.length, 2, 'nada foi gravado depois da prévia');

  // 4) "ID de rastreamento": sem data por linha; a tela pede a data do relatório e a manda como `dia`
  const tid = csv(CAB_TID, 'achados-20,40.0,2.0,100.0,2.0,0.0,90.0,0.0,12.0,0.0,12.0,0.0', 'solto-20,10.0,-,-,-,-,-,-,-,0.0,-,-');
  await p.clicar('#g-importar');
  await importarArquivo({ nome: 'tracking-id.csv', buf: tid, tipo: 'text/csv', loja: 'amazon', tipoRelatorio: 'comissoes', dia: iso(4) });
  dlg = norm(await p.js("document.querySelector('#dlg').textContent"));
  assert.match(dlg, /Comissão no arquivo: R\$ 12,00/);
  assert.match(dlg, /todas as linhas usam a data do relatório informada/);
  await gravar(); await fecharVer();
  await p.esperar("document.querySelector('#pagina [data-m=comissao] .valor')?.textContent.includes('23,50')", 10000, 'dashboard com o ID de rastreamento');
  // o grupo A (achados-20) recebe os 12,00 do dia informado
  assert.equal(await texto(p, `#g-sec-grupo tbody tr[data-k="${A}"] td[data-rot="Comissão"]`), 'R$ 12,00');
  // o único erro de console é o 400 esperado do relatório sem data (a recusa que faz o campo da data aparecer)
  assert.deepEqual(p.erros().filter((e) => !/status of 400.*importar\?loja=amazon&tipo=comissoes&previa=1/.test(e)), []);
  assert.equal(p.erros().length, 1);
});
