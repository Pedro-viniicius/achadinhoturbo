// QA do importador e do Dashboard de ganhos (plano dashboard-ganhos, Entrega B, etapas 11 a 16; CA5, CA6, CA7, CA11):
// o que os testes do dev (csv, importador, ganhos, seguranca) não cobrem. Foco em PONTA A PONTA: o CSV entra pela rota
// POST /api/ganhos/importar do servidor de verdade (buildApp) e sai por GET /api/ganhos com os valores certos, passando
// pelos formatos que src/ganhos.js espera do importador (data AAAA-MM-DD, dia AAAA-MM-DD, ASIN com ou sem "ASIN:").
// Também: borda do importador e dos ganhos, LGPD (nada de comprador na resposta nem no log) e Host/Origin no upload.
// Nenhum teste acessa a rede (fetch global trocado por um que falha), o WhatsApp é simulado e os links são falsos.
// Um teste que falha aqui é bug do produto (ver o relatório do QA): não relaxe a asserção.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { openDb } from '../src/db.js';
import { buildApp } from '../src/server.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createLinkService } from '../src/links.js';
import { createScheduler } from '../src/scheduler.js';
import * as rastreio from '../src/rastreio.js';
import { importar } from '../src/importador.js';
import { MENSAGENS_CSV } from '../src/csv.js';
import { MENSAGENS_IMPORTADOR } from '../src/importador.js';

globalThis.fetch = async () => { throw new Error('rede proibida no teste'); };

const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-ganhos-')); pastas.push(p); return p; };
const linhas = (db, sql, ...a) => db.prepare(sql).all(...a).map((r) => ({ ...r }));
const contar = (db, tabela) => db.prepare(`SELECT COUNT(*) AS n FROM ${tabela}`).get().n;
const csv = (...l) => Buffer.from(l.join('\r\n') + '\r\n', 'utf8');
const quase = (a, b, msg) => assert.ok(typeof a === 'number' && Math.abs(a - b) < 1e-9, `${msg}: ${a} ≈ ${b}`);

const G1 = '111@g.us'; const G2 = '222@g.us'; const G3 = '333@g.us';
const OUT = (dia, h = 12) => new Date(2026, 9, dia, h).getTime();
const OUTUBRO = 'periodo=custom&de=2026-10-01&ate=2026-10-31';

/** Banco com G1 e G2 no bloco 1 (B1), G3 solto, a etiqueta `geral` e as associações: Shopee B1→casa, Amazon B1→turbob1-20 e G3→g3-20. */
function montarDb() {
  const dir = tmp(); const db = openDb(dir);
  for (const [jid, nome] of [[G1, 'Achadinhos'], [G2, 'Tech'], [G3, 'Casa']]) db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, nome, 10, Date.now());
  db.prepare("INSERT INTO blocks (id, name, created_at) VALUES (1, 'B1', 1)").run();
  for (const jid of [G1, G2]) db.prepare('INSERT INTO block_groups (block_id, jid) VALUES (1, ?)').run(jid);
  db.prepare("INSERT INTO tags (name, created_at) VALUES ('geral', 1)").run();
  rastreio.salvar(db, { loja: 'shopee', alvo_tipo: 'bloco', alvo: '1', codigo: 'casa' });
  rastreio.salvar(db, { loja: 'amazon', alvo_tipo: 'bloco', alvo: '1', codigo: 'turbob1-20' });
  rastreio.salvar(db, { loja: 'amazon', alvo_tipo: 'grupo', alvo: G3, codigo: 'g3-20' });
  return { dir, db };
}
const envio = (db, ts, jid, loja, codigo, nivel, esperado, extra = {}) => rastreio.registrar(db, {
  ts, jid, loja, origem: 'regra', link: `https://exemplo.invalid/${loja}/${codigo ?? 'base'}`, codigo, nivel, esperado, ...extra,
});
/** Os envios do dono em outubro: 8 links, 7 com código esperado (todos saíram com ele). */
function semearEnvios(db) {
  for (const jid of [G1, G2]) for (let i = 0; i < 2; i++) envio(db, OUT(2 + i), jid, 'shopee', 'casa', 'bloco', 1, { bloco_id: 1, oferta_chave: 'SHOPEE:1.2' });
  for (const jid of [G1, G2]) envio(db, OUT(3), jid, 'amazon', 'turbob1-20', 'bloco', 1, { bloco_id: 1, oferta_chave: 'ASIN:B0TESTE001' });
  envio(db, OUT(4), G3, 'amazon', 'g3-20', 'grupo', 1, { oferta_chave: 'ASIN:B0TESTE002' });
  envio(db, OUT(4), G3, 'mercadolivre', 'geral', 'padrao', 0, { oferta_chave: 'MLB1' });
}

// ------------------------------------------------------------------------------------------------ servidor HTTP

/** buildApp de verdade (Host/Origin, JSON global, rotas), sem login: o Dono é quem usa o computador. */
async function subir(montar = () => {}) {
  const { dir, db } = montarDb(); montar(db);
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
    for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k];
    if (data) { h['content-type'] = tipo ?? (Buffer.isBuffer(corpo) || typeof corpo === 'string' ? 'text/csv' : 'application/json'); h['content-length'] = data.length; }
    const r = http.request({ host: '127.0.0.1', port: s.port, path: caminho, method, headers: h }, (res) => {
      let txt = ''; res.setEncoding('utf8'); res.on('data', (c) => (txt += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(txt); } catch { /* não é JSON */ } ok({ status: res.statusCode, json, txt }); });
    });
    r.on('error', err); if (data) r.write(data); r.end();
  });
}
const importarPor = (s, loja, buf, extra = '') => pedir(s, `/api/ganhos/importar?loja=${loja}${extra}`, { method: 'POST', corpo: buf });
const ganhos = async (s, por, extra = '') => {
  const r = await pedir(s, `/api/ganhos?${OUTUBRO}&por=${por}${extra}`);
  assert.equal(r.status, 200, r.txt);
  return r.json;
};
const linhaDe = (r, campo, valor) => {
  const l = r.linhas.find((x) => x[campo] === valor);
  assert.ok(l, `linha ${campo}=${valor} em por=${r.por}: ${JSON.stringify(r.linhas.map((x) => x[campo]))}`);
  return l;
};

// Relatórios inventados (cabeçalhos prováveis, valores fictícios). Colunas de comprador nunca podem aparecer em resposta nenhuma.
const CAB_SHOPEE = 'ID do pedido,Status do pedido,Hora do pedido,ID da loja,ID do item,Nome do item,Qtd,Valor de compra(R$),Comissão total do item(R$),Sub_id1,Nome do comprador,Telefone do comprador,Endereço de entrega';
const shopee = (statusP2 = 'Pendente') => csv(CAB_SHOPEE,
  '2610QAP1,Concluído,2026-10-05 10:00:00,1,2,Garrafa inventada,1,"50,00","3,00",casa,Fulana de Teste,(31) 90000-0001,Rua Inventada 1',
  `2610QAP2,${statusP2},2026-10-06 11:00:00,1,2,Garrafa inventada,1,"40,00","2,00",casa,Beltrano de Teste,(31) 90000-0002,Rua Inventada 2`,
  '2610QAP3,Concluído,2026-10-07 12:00:00,1,3,Copo inventado,1,"20,00","1,00",outro,Ciclano de Teste,(31) 90000-0003,Rua Inventada 3',
  '2610QAP4,Cancelado,2026-10-08 13:00:00,4,5,Prato inventado,1,"90,00","9,99",casa,Dona Cancelada,(31) 90000-0004,Rua Inventada 4',
  '2610QAP5,Concluído,2026-09-30 14:00:00,1,2,Garrafa inventada,1,"70,00","7,00",casa,Fora do Mes,(31) 90000-0005,Rua Inventada 5');
const PESSOAIS = ['Fulana', 'Beltrano', 'Ciclano', 'Cancelada', 'Fora do Mes', '90000', 'Rua Inventada', '2610QAP'];
// Amazon: título antes do cabeçalho, sem status, ASIN com e sem o prefixo "ASIN:" (a mesma oferta duas vezes)
const AMAZON = csv('Relatório de ganhos de Associados (inventado)',
  'Category,Name,ASIN,Seller,Tracking ID,Date Shipped,Price,Items Shipped,Returns,Revenue,Ad Fees,Device Type Group',
  'Eletrônicos,Fone inventado,B0TESTE001,Loja X,turbob1-20,2026-10-09,"50,00",2,0,"100,00","4,00",DESKTOP',
  'Casa,Panela inventada,B0TESTE002,Loja Y,g3-20,10/10/2026,"80,00",1,0,"80,00","5,00",PHONE',
  'Livros,Livro inventado,B0TESTE003,Loja Z,desejodemen01-20,2026-10-11 08:15,"30,00",1,0,"30,00","1,50",TABLET',
  'Eletrônicos,Fone inventado,ASIN:B0TESTE001,Loja X,turbob1-20,2026-10-12,"50,00",1,0,"50,00","2,00",DESKTOP');
const CLIQUES_SHOPEE = csv('Data,Sub_id1,Cliques', '2026-10-05,casa,100', '2026-10-05,casa,20', '2026-10-07,outro,30', '2026-09-30,casa,999');
const CLIQUES_AMAZON = csv('Date,Tracking ID,Clicks', '2026-10-09,turbob1-20,50', '2026-10-10,g3-20,10');

test('CA5+CA6 ponta a ponta: três CSVs entram pela rota e GET /api/ganhos devolve M1–M15 certos por bloco, grupo, loja, oferta e dia', async () => {
  const s = await subir(semearEnvios);
  try {
    let r = await importarPor(s, 'shopee', shopee());
    assert.equal(r.status, 200, r.txt);
    assert.deepEqual([r.json.lidas, r.json.novas, r.json.atualizadas, r.json.repetidas, r.json.ignoradas], [5, 5, 0, 0, 0]);
    r = await importarPor(s, 'amazon', AMAZON);
    assert.equal(r.status, 200, r.txt);
    assert.deepEqual([r.json.lidas, r.json.novas, r.json.ignoradas], [4, 4, 0]);
    r = await importarPor(s, 'shopee', CLIQUES_SHOPEE, '&tipo=cliques');
    assert.equal(r.status, 200, r.txt);
    assert.deepEqual([r.json.tipo, r.json.novas, r.json.cliques_total], ['cliques', 3, 120 + 30 + 999]);
    r = await importarPor(s, 'amazon', CLIQUES_AMAZON, '&tipo=cliques');
    assert.equal(r.status, 200, r.txt);

    // por bloco: B1 junta Shopee `casa` (300+200) e Amazon `turbob1-20` (400+200), a ASIN com e sem prefixo
    const porBloco = await ganhos(s, 'bloco');
    const b1 = linhaDe(porBloco, 'bloco_id', 1);
    assert.deepEqual([b1.comissao, b1.vendas, b1.receita, b1.cliques], [1100, 5, 5000 + 4000 + 10000 + 5000, 170]);
    quase(b1.epc, 1100 / 170, 'EPC do bloco');
    quase(b1.conversao, 5 / 170, 'conversão do bloco');
    assert.deepEqual([b1.envios, b1.esperados, b1.rastreados, b1.cobertura], [6, 6, 6, 1]);

    // por grupo: o código de G3 é do próprio grupo; G1 e G2 não ganham nada sozinhos (o código é do bloco)
    const porGrupo = await ganhos(s, 'grupo');
    const g3 = linhaDe(porGrupo, 'jid', G3);
    assert.deepEqual([g3.nome, g3.comissao, g3.vendas, g3.cliques], ['Casa', 500, 1, 10]);
    quase(g3.epc, 50, 'EPC do G3');
    for (const jid of [G1, G2]) assert.equal(linhaDe(porGrupo, 'jid', jid).comissao, 0, `${jid} não recebe o que é do bloco`);

    // total: 600 (Shopee, sem a cancelada e sem setembro) + 1250 (Amazon); só 400 confirmados (Amazon sem status é pendente)
    const t = porGrupo.total;
    assert.deepEqual([t.comissao, t.comissao_confirmada, t.vendas, t.cliques], [1850, 400, 8, 210]);
    quase(t.epc, 1850 / 210, 'EPC total');
    quase(t.conversao, 8 / 210, 'conversão total');
    assert.deepEqual([t.envios, t.esperados, t.rastreados], [8, 7, 7]);
    quase(t.atribuida, (1100 + 500) / 1850, 'M11');
    // o que ficou sem grupo: Shopee `outro` (100) e a tag padrão da Amazon (150) — entram no total, não em grupo
    assert.deepEqual([porGrupo.nao_atribuida.linhas, porGrupo.nao_atribuida.comissao, porGrupo.nao_atribuida.cliques], [2, 250, 30]);

    const porLoja = await ganhos(s, 'loja');
    assert.deepEqual(['shopee', 'amazon', 'mercadolivre'].map((l) => linhaDe(porLoja, 'loja', l).comissao), [600, 1250, 0]);

    // por oferta: a Amazon com e sem "ASIN:" é UMA oferta e casa com o envio (oferta_chave "ASIN:B0…")
    const porOferta = await ganhos(s, 'oferta');
    const o1 = porOferta.linhas.filter((l) => l.loja === 'amazon' && /B0TESTE001/.test(l.oferta));
    assert.equal(o1.length, 1, 'ASIN e ASIN:ASIN são a mesma oferta');
    assert.deepEqual([o1[0].comissao, o1[0].vendas, o1[0].envios, o1[0].grupos], [600, 3, 2, 2]);
    const shopeeOferta = linhaDe(porOferta, 'oferta', 'SHOPEE:1.2');
    assert.deepEqual([shopeeOferta.comissao, shopeeOferta.envios, shopeeOferta.grupos], [500, 4, 2]);
    assert.equal(shopeeOferta.titulo, 'Garrafa inventada');
    assert.ok(!porOferta.linhas.some((l) => l.oferta === 'SHOPEE:4.5'), 'a cancelada não vira oferta');

    // por dia: cada venda cai no dia da data do arquivo (com hora, sem hora e DD/MM/AAAA)
    const porDia = await ganhos(s, 'dia');
    assert.deepEqual(['2026-10-05', '2026-10-06', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12'].map((d) => linhaDe(porDia, 'dia', d).comissao), [300, 200, 400, 500, 150, 200]);
    assert.equal(porDia.linhas.length, 31, 'um dia por linha, outubro inteiro');

    // dados de comprador nunca aparecem em nenhuma resposta nem em nenhuma tabela
    const tudo = JSON.stringify([porBloco, porGrupo, porLoja, porOferta, porDia, (await pedir(s, '/api/ganhos/importacoes')).json]);
    for (const p of PESSOAIS) assert.ok(!tudo.includes(p), `vazou "${p}"`);
    for (const tabela of ['comissoes', 'importacoes', 'cliques_loja']) {
      const dump = JSON.stringify(linhas(s.db, `SELECT * FROM ${tabela}`));
      for (const p of PESSOAIS) assert.ok(!dump.includes(p), `${tabela} guardou "${p}"`);
    }
  } finally { await s.fechar(); }
});

test('CA5 ponta a ponta: reimportar os mesmos arquivos não muda nenhum número; pendente → confirmada atualiza sem duplicar; apagar a importação tira só as linhas dela', async () => {
  const s = await subir(semearEnvios);
  try {
    const rs = (await importarPor(s, 'shopee', shopee())).json;
    await importarPor(s, 'amazon', AMAZON);
    await importarPor(s, 'shopee', CLIQUES_SHOPEE, '&tipo=cliques');
    const antes = await ganhos(s, 'grupo');

    let r = await importarPor(s, 'shopee', shopee());
    assert.deepEqual([r.json.novas, r.json.atualizadas, r.json.repetidas, r.json.ja_importado], [0, 0, 5, true]);
    r = await importarPor(s, 'amazon', AMAZON);
    assert.deepEqual([r.json.novas, r.json.atualizadas, r.json.repetidas], [0, 0, 4]);
    r = await importarPor(s, 'shopee', CLIQUES_SHOPEE, '&tipo=cliques');
    assert.deepEqual([r.json.novas, r.json.atualizadas], [0, 0], 'cliques iguais não somam de novo');
    const depois = await ganhos(s, 'grupo');
    assert.deepEqual(depois.total, antes.total, 'nada mudou depois de reimportar tudo');
    assert.equal(contar(s.db, 'comissoes'), 5 + 4);

    // a venda pendente foi confirmada no portal: a mesma linha muda de status e a comissão confirmada sobe de 400 para 600
    r = await importarPor(s, 'shopee', shopee('Concluído'));
    assert.deepEqual([r.json.novas, r.json.atualizadas, r.json.repetidas], [0, 1, 4]);
    assert.equal(contar(s.db, 'comissoes'), 9, 'atualizou sem duplicar');
    const confirmada = await ganhos(s, 'grupo');
    assert.deepEqual([confirmada.total.comissao, confirmada.total.comissao_confirmada], [1850, 600]);

    // apagar a importação da Shopee tira as 5 linhas dela (a Amazon e os cliques ficam)
    const lista = (await pedir(s, '/api/ganhos/importacoes')).json.importacoes;
    assert.equal(lista.filter((i) => i.loja === 'shopee' && i.tipo === 'comissoes').length, 3, 'cada reimportação também fica no histórico');
    assert.equal(lista.find((i) => i.id === rs.importacao_id).linhas, 5, 'a primeira importação é dona das 5 linhas, mesmo a que foi atualizada depois');
    r = await pedir(s, `/api/ganhos/importacoes/${rs.importacao_id}`, { method: 'DELETE' });
    assert.deepEqual([r.status, r.json.comissoes], [200, 5]);
    const sem = await ganhos(s, 'grupo');
    assert.deepEqual([sem.total.comissao, sem.total.cliques], [1250, 150], 'só a Amazon de comissões; os cliques da Shopee não são da importação apagada');
    assert.equal(linhaDe(await ganhos(s, 'loja'), 'loja', 'shopee').comissao, 0);
  } finally { await s.fechar(); }
});

test('CA5/CA6: o filtro de loja e o de bloco valem sobre o que foi importado (loja só Shopee: sem retorno; bloco B1: sem o que não é dele)', async () => {
  const s = await subir(semearEnvios);
  try {
    await importarPor(s, 'shopee', shopee());
    await importarPor(s, 'amazon', AMAZON);
    await importarPor(s, 'shopee', CLIQUES_SHOPEE, '&tipo=cliques');
    await importarPor(s, 'amazon', CLIQUES_AMAZON, '&tipo=cliques');
    s.db.prepare("INSERT INTO gastos_anuncio (alvo_tipo, alvo, inicio, fim, valor_centavos, criado_em) VALUES ('bloco', '1', '2026-10-01', '2026-10-31', 3100, 1)").run();
    const soShopee = await ganhos(s, 'grupo', '&loja=shopee');
    assert.deepEqual([soShopee.total.comissao, soShopee.total.cliques, soShopee.total.vendas], [600, 150, 3]);
    quase(soShopee.total.epc, 600 / 150, 'EPC da Shopee');
    assert.equal(soShopee.total.retorno, null, 'com filtro de loja o retorno não existe (o gasto não é por loja)');
    const doBloco = await ganhos(s, 'grupo', '&bloco=1');
    assert.deepEqual([doBloco.total.comissao, doBloco.total.cliques], [1100, 170]);
    assert.equal(doBloco.nao_atribuida, null, 'dentro de um bloco não há "sem grupo"');
    assert.equal(doBloco.total.gasto, 3100);
    assert.equal(doBloco.total.retorno, 1100 - 3100);
    assert.deepEqual(doBloco.linhas.map((l) => l.jid).sort(), [G1, G2], 'só os grupos do bloco');
  } finally { await s.fechar(); }
});

test('ponta a ponta: venda de dia sem envio anterior do código não é atribuída (D6); depois do envio, passa a ser (sem reimportar)', async () => {
  const s = await subir();
  try {
    // a Shopee `casa` só foi enviada em 08/10; a venda de 05/10 não tem de quem ser
    envio(s.db, OUT(8), G1, 'shopee', 'casa', 'bloco', 1, { bloco_id: 1 });
    await importarPor(s, 'shopee', shopee());
    let t = (await ganhos(s, 'bloco')).total;
    assert.deepEqual([t.comissao, t.comissao_atribuida], [600, 0]);
    // venda de 06/10 e 05/10 continuam sem dono mesmo com o envio de 08/10; só a que vem depois dele é do bloco
    await importarPor(s, 'shopee', csv(CAB_SHOPEE, '2610QAP9,Concluído,2026-10-09 10:00:00,1,2,Garrafa inventada,1,"50,00","3,00",casa,Fulano,(31) 90000-0009,Rua 9'));
    t = (await ganhos(s, 'bloco')).total;
    assert.deepEqual([t.comissao, t.comissao_atribuida], [900, 300]);
    assert.equal(linhaDe(await ganhos(s, 'bloco'), 'bloco_id', 1).comissao, 300);
  } finally { await s.fechar(); }
});

// ------------------------------------------------------------------------------------------------ bugs do QA (devem passar quando o dev corrigir)

test('Q1/CA5: relatório da Amazon (sem pedido) baixado de novo com devolução e tarifa revisadas atualiza a linha — não soma outra', () => {
  const { db } = montarDb();
  const amz = (devolucoes, tarifa) => csv('Name,ASIN,Tracking ID,Date Shipped,Items Shipped,Returns,Revenue,Ad Fees',
    `Fone inventado,B0TESTE001,turbob1-20,2026-10-09,2,${devolucoes},"100,00","${tarifa}"`);
  importar(db, amz(0, '4,00'), { loja: 'amazon' });
  const r = importar(db, amz(1, '2,00'), { loja: 'amazon' });
  assert.equal(contar(db, 'comissoes'), 1, `a mesma venda (mesma ASIN, dia e ID de rastreamento) virou ${contar(db, 'comissoes')} linhas: ${JSON.stringify([r.novas, r.atualizadas])}`);
  const l = linhas(db, 'SELECT quantidade, comissao_centavos FROM comissoes')[0];
  assert.deepEqual([l.quantidade, l.comissao_centavos], [1, 200], 'vale o relatório mais novo');
});

test('Q2/CA5: duas linhas do mesmo arquivo com o mesmo pedido e item mas valores diferentes (variações) não somem uma na outra', () => {
  const { db } = montarDb();
  const r = importar(db, csv('ID do pedido,Hora do pedido,ID da loja,ID do item,Qtd,Comissão total do item(R$),Sub_id1,Status do pedido',
    '2610QAPV,2026-10-05 10:00:00,1,2,1,"3,00",casa,Concluído',
    '2610QAPV,2026-10-05 10:00:00,1,2,1,"2,00",casa,Concluído'), { loja: 'shopee' });
  assert.equal(linhas(db, 'SELECT SUM(comissao_centavos) AS s FROM comissoes')[0].s, 500, `as duas comissões são do dono: ${JSON.stringify([r.lidas, r.novas, r.atualizadas])}`);
});

test('Q3/CA6: apagar um bloco não deixa o gasto dele para o próximo bloco que reaproveitar o mesmo id', async () => {
  const s = await subir();
  try {
    let r = await pedir(s, '/api/blocks', { method: 'POST', corpo: { name: 'Temporário', group_jids: [G3] } });
    assert.equal(r.status, 200, r.txt);
    const id = r.json.id;
    r = await pedir(s, '/api/ganhos/gastos', { method: 'POST', corpo: { alvo_tipo: 'bloco', alvo: id, inicio: '2026-10-01', fim: '2026-10-31', valor_centavos: 10000 } });
    assert.equal(r.status, 200, r.txt);
    assert.equal((await pedir(s, `/api/blocks/${id}`, { method: 'DELETE' })).status, 200);
    r = await pedir(s, '/api/blocks', { method: 'POST', corpo: { name: 'Outro bloco, outro nicho', group_jids: [G3] } });
    const novo = r.json.id;
    const m = await ganhos(s, 'bloco');
    const gasto = m.linhas.find((l) => l.bloco_id === novo)?.gasto ?? null;
    assert.equal(gasto, null, `o bloco novo (id ${novo}, antigo id ${id}) herdou o gasto do apagado: ${gasto}`);
    const lista = (await pedir(s, '/api/ganhos/gastos')).json.gastos;
    assert.ok(!lista.some((g) => g.alvo_tipo === 'bloco' && g.alvo === String(novo)), 'a lista de gastos também não mostra o gasto antigo no bloco novo');
  } finally { await s.fechar(); }
});

test('Q4/CA5: o código do relatório da Amazon com outra caixa ("Casa-20") não é dado como desconhecido quando o dashboard o atribui ao grupo', () => {
  const { db } = montarDb();
  envio(db, OUT(2), G3, 'amazon', 'g3-20', 'grupo', 1);
  const r = importar(db, csv('Name,ASIN,Tracking ID,Date Shipped,Items Shipped,Revenue,Ad Fees', 'Fone,B0TESTE001,G3-20,2026-10-09,1,"10,00","1,00"'), { loja: 'amazon' });
  assert.deepEqual([r.sem_grupo, r.codigos_desconhecidos], [0, []], 'o resumo manda o dono associar um código que já está associado');
});

// ------------------------------------------------------------------------------------------------ bordas do importador e dos ganhos

test('borda: arquivo do Excel BR (BOM, ponto e vírgula, R$ e milhar com ponto, CRLF, linhas em branco, coluna vazia no fim) importa certo', () => {
  const { db } = montarDb();
  const buf = Buffer.from('﻿Data da venda;ID do produto;Título;Valor da venda;Comissão;Status;\r\n\r\n'
    + '05/10/2026;MLB1000000001;Air fryer inventada;R$ 1.350,00;R$ 67,50;Pago;\r\n'
    + '06/10/2026;MLB1000000002;"Liquidificador; inventado";R$ 120,00;R$ 6,00;Pendente;\r\n', 'utf8');
  const r = importar(db, buf, { loja: 'mercadolivre' });
  assert.deepEqual([r.lidas, r.novas, r.ignoradas], [2, 2, 0]);
  assert.deepEqual(linhas(db, 'SELECT data, produto, titulo, venda_centavos, comissao_centavos, status FROM comissoes ORDER BY data'), [
    { data: '2026-10-05', produto: 'MLB1000000001', titulo: 'Air fryer inventada', venda_centavos: 135000, comissao_centavos: 6750, status: 'confirmada' },
    { data: '2026-10-06', produto: 'MLB1000000002', titulo: 'Liquidificador; inventado', venda_centavos: 12000, comissao_centavos: 600, status: 'pendente' },
  ]);
});

test('borda: comissão negativa (estorno) e zero entram; uma linha de total/rodapé sem data é pulada e contada, não vira comissão', () => {
  const { db } = montarDb();
  const r = importar(db, csv('Data,Comissão,Status', '2026-10-05,"-3,00",Concluído', '2026-10-06,"0,00",Pendente', 'Total,"-3,00",'), { loja: 'mercadolivre' });
  assert.deepEqual([r.lidas, r.novas, r.ignoradas, r.linhas_ignoradas], [3, 2, 1, [4]]);
  assert.deepEqual(linhas(db, 'SELECT comissao_centavos FROM comissoes ORDER BY data').map((l) => l.comissao_centavos), [-300, 0]);
});

test('borda: devolução parcial reduz a quantidade; devolução de tudo cancela (sai da comissão válida)', async () => {
  const s = await subir();
  try {
    const r = await importarPor(s, 'amazon', csv('Name,ASIN,Tracking ID,Date Shipped,Items Shipped,Returns,Revenue,Ad Fees',
      'A,B0TESTE001,turbob1-20,2026-10-09,3,1,"150,00","6,00"', 'B,B0TESTE002,g3-20,2026-10-10,2,2,"80,00","4,00"'));
    assert.equal(r.status, 200, r.txt);
    assert.deepEqual(linhas(s.db, 'SELECT produto, quantidade, status FROM comissoes ORDER BY produto'), [
      { produto: 'B0TESTE001', quantidade: 2, status: 'pendente' }, { produto: 'B0TESTE002', quantidade: 2, status: 'cancelada' },
    ]);
    envio(s.db, OUT(2), G3, 'amazon', 'g3-20', 'grupo', 1);
    const t = (await ganhos(s, 'grupo')).total;
    assert.deepEqual([t.comissao, t.vendas], [600, 2], 'a devolvida inteira não entra');
  } finally { await s.fechar(); }
});

test('borda: arquivo só com cabeçalho, sem a coluna de comissão ou de data, e coluna de data em branco → 400 com frase fixa e nada gravado', async () => {
  const s = await subir();
  try {
    const casos = [
      [csv('Data,Comissão'), MENSAGENS_CSV.vazio],
      [csv('Nome,Valor', 'x,1'), MENSAGENS_IMPORTADOR.semComissao],
      [csv('Comissão,Status', '"3,00",Pago'), MENSAGENS_IMPORTADOR.semData],
    ];
    for (const [buf, frase] of casos) {
      const r = await importarPor(s, 'shopee', buf);
      assert.deepEqual([r.status, r.json], [400, { erro: frase }]);
    }
    const r = await importarPor(s, 'shopee', csv('Data,Comissão', ',"3,00"', 'ontem,"3,00"', '2026-13-40,"3,00"'));
    assert.equal(r.status, 200, r.txt);
    assert.deepEqual([r.json.lidas, r.json.novas, r.json.ignoradas], [3, 0, 3], 'datas ausentes, em texto ou impossíveis: puladas e contadas');
    assert.equal(contar(s.db, 'comissoes'), 0);
  } finally { await s.fechar(); }
});

test('borda: arquivo é só leitura de coluna da lista branca — célula com HTML/fórmula/UTF-8 estranho vira texto, nunca erro 500, e o título é cortado em 200', async () => {
  const s = await subir();
  try {
    const titulo = `=HYPERLINK("http://x.invalid","a")<img src=x onerror=alert(1)>${'ü'.repeat(300)}`;
    const r = await importarPor(s, 'mercadolivre', csv('Data;Título;Comissão', `2026-10-05;"${titulo.replaceAll('"', '""')}";"3,00"`));
    assert.equal(r.status, 200, r.txt);
    const t = linhas(s.db, 'SELECT titulo FROM comissoes')[0].titulo;
    assert.equal(t.length, 200);
    assert.ok(t.startsWith('=HYPERLINK('), 'o texto fica como veio (a tela escapa), só o tamanho é limitado');
    assert.ok(!r.txt.includes('onerror'), 'a resposta da importação não repete o conteúdo do arquivo');
  } finally { await s.fechar(); }
});

test('segurança: POST text/plain de outro site (CSRF sem preflight) e Host trocado (rebinding) → 403 e nada gravado; sem Origin (curl local) passa', async () => {
  const s = await subir();
  try {
    let r = await pedir(s, '/api/ganhos/importar?loja=shopee', { method: 'POST', corpo: shopee(), tipo: 'text/plain', headers: { origin: 'https://site-malicioso.invalid' } });
    assert.deepEqual([r.status, r.json?.erro], [403, 'Origem não permitida']);
    r = await pedir(s, '/api/ganhos/importar?loja=shopee', { method: 'POST', corpo: shopee(), tipo: 'text/plain', headers: { host: 'atacante.invalid' } });
    assert.deepEqual([r.status, r.json?.erro], [403, 'Host não permitido']);
    for (const [metodo, caminho] of [['GET', '/api/ganhos'], ['GET', '/api/ganhos/importacoes'], ['DELETE', '/api/ganhos/importacoes/1'], ['GET', '/api/ganhos/gastos']]) {
      r = await pedir(s, caminho, { method: metodo, headers: { origin: 'https://site-malicioso.invalid' } });
      assert.equal(r.status, 403, `${metodo} ${caminho}`);
    }
    r = await pedir(s, '/api/ganhos/gastos', { method: 'POST', corpo: { alvo_tipo: 'grupo', alvo: G1, inicio: '2026-10-01', fim: '2026-10-02', valor_centavos: 100 }, headers: { origin: 'https://site-malicioso.invalid' } });
    assert.equal(r.status, 403);
    assert.equal(contar(s.db, 'importacoes') + contar(s.db, 'comissoes') + contar(s.db, 'gastos_anuncio'), 0);
    r = await pedir(s, '/api/ganhos/importar?loja=shopee', { method: 'POST', corpo: shopee(), headers: { origin: undefined } });
    assert.equal(r.status, 200, r.txt);
  } finally { await s.fechar(); }
});

test('segurança: corpo gzip (bomba de descompressão), JSON grande e envio em pedaços acima de 5 MB não derrubam nem gravam', async () => {
  const s = await subir();
  try {
    let r = await pedir(s, '/api/ganhos/importar?loja=shopee', { method: 'POST', corpo: Buffer.from('1f8b0800000000000003', 'hex'), tipo: 'text/csv', headers: { 'content-encoding': 'gzip' } });
    assert.ok([400, 415].includes(r.status), `gzip: ${r.status} ${r.txt}`);
    r = await pedir(s, '/api/ganhos/importar?loja=shopee', { method: 'POST', corpo: Buffer.alloc(300 * 1024, 'a'), tipo: 'application/json' });
    assert.deepEqual([r.status, r.json], [415, { erro: MENSAGENS_CSV.tipo }]);
    // 6 MB em pedaços, sem Content-Length
    r = await new Promise((ok, err) => {
      const rq = http.request({ host: '127.0.0.1', port: s.port, path: '/api/ganhos/importar?loja=shopee', method: 'POST', headers: { 'content-type': 'text/csv', 'transfer-encoding': 'chunked', origin: `http://127.0.0.1:${s.port}` } }, (res) => {
        let txt = ''; res.on('data', (c) => (txt += c)); res.on('end', () => ok({ status: res.statusCode, txt }));
      });
      rq.on('error', (e) => (e.code === 'EPIPE' || e.code === 'ECONNRESET' ? ok({ status: 413, txt: 'conexão cortada' }) : err(e)));
      const pedaco = Buffer.alloc(512 * 1024, 'a');
      for (let i = 0; i < 12; i++) rq.write(pedaco);
      rq.end();
    });
    assert.equal(r.status, 413, r.txt);
    assert.equal(contar(s.db, 'importacoes') + contar(s.db, 'comissoes'), 0);
    assert.equal((await pedir(s, '/api/ganhos/importacoes')).status, 200, 'o servidor continua de pé');
  } finally { await s.fechar(); }
});

test('segurança/LGPD: erro de importação nunca repete conteúdo do arquivo (resposta e log), nem com cabeçalho esquisito', async (t) => {
  const s = await subir();
  const logs = [];
  const original = console.error;
  console.error = (...a) => logs.push(a.map(String).join(' '));
  t.after(() => { console.error = original; });
  try {
    const segredo = 'Fulana-Secreta-90000-0001';
    for (const buf of [csv(`${segredo},x`, 'y,z'), csv('Data,Comissão', `${segredo},"3,00"`), Buffer.from(`${segredo}\u0000x`), Buffer.from([0xff, 0xfe, 0x41])]) {
      const r = await importarPor(s, 'shopee', buf);
      assert.ok(!r.txt.includes(segredo), r.txt);
      assert.ok(r.status >= 200 && r.status < 500, `${r.status} ${r.txt}`);
    }
    const r = await importarPor(s, `shopee&codigo=${encodeURIComponent(segredo.repeat(10))}`, csv('Data,Comissão', '2026-10-05,"3,00"'));
    assert.ok(!r.txt.includes(segredo));
    assert.ok(!logs.join('\n').includes(segredo), 'o log não repete o arquivo');
  } finally { await s.fechar(); }
});

test('GET /api/ganhos: parâmetros hostis → frase fixa sem eco, nunca 500; período personalizado: de > ate e intervalo gigante têm limite', async () => {
  const s = await subir();
  try {
    const eco = '<script>alert(1)</script>';
    for (const q of [`por=${encodeURIComponent(eco)}`, `loja=${encodeURIComponent(eco)}`, `periodo=${encodeURIComponent(eco)}`, `bloco=${encodeURIComponent(eco)}`,
      'de=2026-02-30', 'de=x&periodo=custom', 'bloco=1e0', 'bloco=01', 'por=grupo&por=loja', 'loja=amazon&loja=shopee', 'bloco=999']) {
      const r = await pedir(s, `/api/ganhos?${q}`);
      assert.ok([400, 404].includes(r.status), `${q}: ${r.status} ${r.txt}`);
      assert.ok(!r.txt.includes('script') && !r.txt.includes('2026-02-30'), `${q}: eco do valor`);
    }
    // sem nenhum parâmetro: mês atual, por grupo (o padrão do plano)
    let r = await pedir(s, '/api/ganhos');
    assert.equal(r.status, 200, r.txt);
    assert.equal(r.json.por, 'grupo');
    // de > ate (como na Visão Geral, periodRange): vale o dia `ate`; responde, não dá 500 nem recorte vazio por engano
    r = await pedir(s, '/api/ganhos?periodo=custom&de=2026-10-31&ate=2026-10-01&por=dia');
    assert.equal(r.status, 200, r.txt);
    assert.deepEqual(r.json.linhas.map((l) => l.dia), ['2026-10-01']);
    // intervalo de um século: o servidor limita a um ano (366 dias), não monta 36 mil linhas
    r = await pedir(s, '/api/ganhos?periodo=custom&de=2000-01-01&ate=2100-12-31&por=dia');
    assert.equal(r.status, 200, r.txt);
    assert.ok(r.json.linhas.length <= 367, `${r.json.linhas.length} dias`);
  } finally { await s.fechar(); }
});

test('M12/M14 ponta a ponta: gasto lançado pela rota, rateado por dia no período personalizado, e o custo por membro bate (B1: 1600 de 16 a 31/10, 25 entradas)', async () => {
  const s = await subir();
  try {
    let r = await pedir(s, '/api/ganhos/gastos', { method: 'POST', corpo: { alvo_tipo: 'bloco', alvo: 1, inicio: '2026-10-01', fim: '2026-10-31', valor_centavos: 3100, nota: 'Meta Ads' } });
    assert.equal(r.status, 200, r.txt);
    assert.equal(r.json.aviso, null);
    for (const [jid, n, dia] of [[G1, 10, 20], [G2, 15, 21]]) {
      for (let i = 0; i < n; i++) s.db.prepare('INSERT INTO group_events (ts, jid, participant, action) VALUES (?, ?, ?, ?)').run(OUT(dia) + i, jid, `p-${jid}-${i}`, 'add');
    }
    let m = await (async () => (await pedir(s, `/api/ganhos?${OUTUBRO}&por=bloco`)).json)();
    let b1 = linhaDe(m, 'bloco_id', 1);
    assert.deepEqual([b1.gasto, b1.entradas, b1.custo_membro, b1.retorno], [3100, 25, 124, -3100]);
    m = (await pedir(s, '/api/ganhos?periodo=custom&de=2026-10-16&ate=2026-10-31&por=bloco')).json;
    b1 = linhaDe(m, 'bloco_id', 1);
    assert.equal(b1.gasto, 1600, '16 dos 31 dias');
    // segundo gasto no mesmo alvo e período avisa, mas grava (não bloqueia)
    r = await pedir(s, '/api/ganhos/gastos', { method: 'POST', corpo: { alvo_tipo: 'bloco', alvo: '1', inicio: '2026-10-10', fim: '2026-10-12', valor_centavos: 300 } });
    assert.equal(r.status, 200, r.txt);
    assert.match(r.json.aviso, /Já existe gasto/);
    assert.equal(r.json.gastos.length, 2);
  } finally { await s.fechar(); }
});

// ------------------------------------------------------------------------------------------------ rodada 2 (R3, R4, R9, S1, S2)

test('R3/CA6 ponta a ponta: gasto lançado para um grupo aparece no grupo e no total, mas não no bloco dele (e vice-versa); custo por membro só de quem tem gasto próprio', async () => {
  const s = await subir();
  try {
    for (const [jid, n, dia] of [[G1, 10, 20], [G2, 15, 21]]) {
      for (let i = 0; i < n; i++) s.db.prepare('INSERT INTO group_events (ts, jid, participant, action) VALUES (?, ?, ?, ?)').run(OUT(dia) + i, jid, `p-${jid}-${i}`, 'add');
    }
    const gastar = (alvo_tipo, alvo, valor_centavos) => pedir(s, '/api/ganhos/gastos', { method: 'POST', corpo: { alvo_tipo, alvo, inicio: '2026-10-01', fim: '2026-10-31', valor_centavos } });
    assert.equal((await gastar('grupo', G1, 1000)).status, 200);
    let bloco = linhaDe(await ganhos(s, 'bloco'), 'bloco_id', 1);
    assert.deepEqual([bloco.gasto, bloco.custo_membro, bloco.retorno], [null, null, null], 'o gasto do G1 não é do bloco B1');
    assert.equal(bloco.entradas, 25, 'as entradas do bloco continuam sendo as dos grupos dele');
    const grupo = linhaDe(await ganhos(s, 'grupo'), 'jid', G1);
    assert.deepEqual([grupo.gasto, grupo.entradas, grupo.custo_membro], [1000, 10, 100]);
    assert.equal(linhaDe(await ganhos(s, 'grupo'), 'jid', G2).gasto, null, 'o colega de bloco não herda');
    assert.equal((await ganhos(s, 'bloco')).total.gasto, 1000, 'o total do painel soma o que foi lançado');
    // agora o gasto do bloco: aparece no bloco e NÃO no G1/G2
    assert.equal((await gastar('bloco', 1, 2500)).status, 200);
    bloco = linhaDe(await ganhos(s, 'bloco'), 'bloco_id', 1);
    assert.deepEqual([bloco.gasto, bloco.entradas, bloco.custo_membro], [2500, 25, 100]);
    assert.equal(linhaDe(await ganhos(s, 'grupo'), 'jid', G1).gasto, 1000, 'o gasto do bloco não vai para o grupo');
    assert.equal((await ganhos(s, 'bloco')).total.gasto, 3500, 'total = grupo + bloco, sem contar nada duas vezes');
  } finally { await s.fechar(); }
});

test('R9: previa repetida (?previa=1&previa=1) → 400 e nada gravado; previa=1 uma vez não grava; sem previa grava', async () => {
  const s = await subir();
  try {
    const arq = csv('Name,ASIN,Tracking ID,Date Shipped,Items Shipped,Revenue,Ad Fees', 'Fone,B0TESTE001,turbob1-20,2026-10-09,1,"10,00","1,00"');
    let r = await importarPor(s, 'amazon', arq, '&previa=1&previa=1');
    assert.equal(r.status, 400, r.txt);
    assert.equal(contar(s.db, 'comissoes') + contar(s.db, 'importacoes'), 0, 'o 400 não grava nada');
    assert.ok(!/B0TESTE001|turbob1/.test(r.txt), 'a frase fixa não ecoa o conteúdo do arquivo');
    r = await importarPor(s, 'amazon', arq, '&previa=1&previa=0');
    assert.equal(r.status, 400, r.txt);
    r = await importarPor(s, 'amazon', arq, '&previa=1');
    assert.equal(r.status, 200, r.txt);
    assert.equal(r.json.previa, true);
    assert.equal(contar(s.db, 'comissoes') + contar(s.db, 'importacoes'), 0, 'prévia não grava');
    r = await importarPor(s, 'amazon', arq);
    assert.equal(r.status, 200, r.txt);
    assert.equal(r.json.previa, false);
    assert.equal(contar(s.db, 'comissoes'), 1);
  } finally { await s.fechar(); }
});

test('R1/R4 ponta a ponta: pedido+item repetido no arquivo (variações) fica estável ao reimportar; revisar só uma das duas atualiza só ela; o código do arquivo não cria linha nova', async () => {
  const s = await subir();
  try {
    const cab = 'ID do pedido,Hora do pedido,ID da loja,ID do item,Qtd,Comissão total do item(R$),Sub_id1,Status do pedido';
    const arq = (a, b) => csv(cab, `2610QAR1,2026-10-05 10:00:00,1,2,1,"${a}",casa,Pendente`, `2610QAR1,2026-10-05 10:00:00,1,2,1,"${b}",casa,Pendente`, '2610QAR2,2026-10-06 10:00:00,1,2,1,"1,00",casa,Pendente');
    const soma = () => linhas(s.db, 'SELECT SUM(comissao_centavos) AS s, COUNT(*) AS n FROM comissoes')[0];
    let r = await importarPor(s, 'shopee', arq('3,00', '2,00'));
    assert.equal(r.status, 200, r.txt);
    assert.deepEqual({ ...soma() }, { s: 600, n: 3 });
    r = await importarPor(s, 'shopee', arq('3,00', '2,00'));
    assert.deepEqual([r.json.novas, r.json.atualizadas, r.json.repetidas], [0, 0, 3], JSON.stringify(r.json));
    assert.deepEqual({ ...soma() }, { s: 600, n: 3 });
    r = await importarPor(s, 'shopee', arq('3,00', '2,50'));
    assert.deepEqual([r.json.novas, r.json.atualizadas], [0, 1], 'só a segunda variação mudou');
    assert.deepEqual({ ...soma() }, { s: 650, n: 3 });
    // o "Código do arquivo" (parâmetro) só vale onde a coluna está vazia e não muda a identidade da linha
    const semCol = csv('ID do pedido,Hora do pedido,ID da loja,ID do item,Qtd,Comissão total do item(R$),Status do pedido', '2610QAR9,2026-10-07 10:00:00,1,7,1,"4,00",Pendente');
    await importarPor(s, 'shopee', semCol);
    r = await importarPor(s, 'shopee', semCol, '&codigo=casa');
    assert.deepEqual([r.json.novas, r.json.atualizadas], [0, 1], 'preencheu o código da mesma linha');
    assert.equal(contar(s.db, 'comissoes'), 4);
    assert.equal(linhas(s.db, "SELECT codigo FROM comissoes WHERE comissao_centavos = 400")[0].codigo, 'casa');
  } finally { await s.fechar(); }
});

test('Q1 sem pedido: duas linhas iguais (mesma ASIN, dia e código, valores diferentes) somam as duas e reimportar não muda; linha idêntica reenviada não vira terceira', () => {
  const { db } = montarDb();
  const arq = csv('Name,ASIN,Tracking ID,Date Shipped,Items Shipped,Revenue,Ad Fees',
    'Fone,B0TESTE001,turbob1-20,2026-10-09,1,"10,00","1,00"', 'Fone,B0TESTE001,turbob1-20,2026-10-09,1,"20,00","2,00"');
  importar(db, arq, { loja: 'amazon' });
  const r = importar(db, arq, { loja: 'amazon' });
  assert.deepEqual([r.novas, r.atualizadas], [0, 0]);
  assert.deepEqual({ ...linhas(db, 'SELECT SUM(comissao_centavos) AS s, COUNT(*) AS n FROM comissoes')[0] }, { s: 300, n: 2 });
});

test('S2/LGPD: o número do pedido não aparece em nenhuma coluna de texto do banco, e a chave não é um hash que dê para refazer sem a pseudo_key', () => {
  const { db } = montarDb();
  const PEDIDO = '2610SEGREDOQA77';
  importar(db, csv('ID do pedido,Hora do pedido,ID da loja,ID do item,Qtd,Comissão total do item(R$),Sub_id1,Status do pedido',
    `${PEDIDO},2026-10-05 10:00:00,1,2,1,"3,00",casa,Concluído`), { loja: 'shopee' });
  const { chave } = linhas(db, 'SELECT chave FROM comissoes')[0];
  assert.match(chave, /^[0-9a-f]{32}$/);
  for (const partes of [['pedido', 'shopee', PEDIDO, 'SHOPEE:1.2', ''], ['shopee', PEDIDO], [PEDIDO]]) {
    for (const cod of [JSON.stringify(partes), partes.join('|'), partes.join('')]) {
      assert.notEqual(chave, crypto.createHash('sha256').update(cod).digest('hex').slice(0, 32), 'chave refazível sem segredo');
      assert.notEqual(chave, crypto.createHash('md5').update(cod).digest('hex'), 'chave refazível sem segredo (md5)');
    }
  }
  for (const { name } of linhas(db, "SELECT name FROM sqlite_master WHERE type = 'table'")) {
    const dump = JSON.stringify(linhas(db, `SELECT * FROM ${name}`));
    assert.ok(!dump.includes(PEDIDO), `o pedido vazou na tabela ${name}`);
  }
});

test('S1/Q3 histórico: bloco apagado e outro criado depois não herda a comissão atribuída ao id antigo (rastreio_envios.bloco_id)', async () => {
  const s = await subir();
  try {
    let r = await pedir(s, '/api/blocks', { method: 'POST', corpo: { name: 'Antigo', group_jids: [G3] } });
    const antigo = r.json.id;
    rastreio.salvar(s.db, { loja: 'shopee', alvo_tipo: 'bloco', alvo: String(antigo), codigo: 'antigo' });
    envio(s.db, OUT(5), G3, 'shopee', 'antigo', 'bloco', 1, { bloco_id: antigo });
    s.db.prepare("INSERT INTO importacoes (id, loja, tipo, arquivo_sha256, criado_em) VALUES (1, 'shopee', 'comissoes', 'x', 1)").run();
    s.db.prepare("INSERT INTO comissoes (loja, chave, data, codigo, produto, quantidade, venda_centavos, comissao_centavos, status, importacao_id, atualizado_em) VALUES ('shopee', 'k', '2026-10-09', 'antigo', 'SHOPEE:1.2', 1, 5000, 700, 'confirmada', 1, 1)").run();
    assert.equal((await pedir(s, `/api/blocks/${antigo}`, { method: 'DELETE' })).status, 200);
    r = await pedir(s, '/api/blocks', { method: 'POST', corpo: { name: 'Novo', group_jids: [G2] } });
    const novo = r.json.id;
    assert.ok(novo > antigo, 'o id do bloco apagado não volta nem com histórico de envios');
    const l = linhaDe(await ganhos(s, 'bloco'), 'bloco_id', novo);
    assert.deepEqual([l.comissao, l.vendas, l.envios], [0, 0, 0], 'o bloco novo não recebe a comissão do bloco apagado');
  } finally { await s.fechar(); }
});

// ------------------------------------------------------------------------------------------------ R11: relatório sem pedido e sem coluna de código

/** G1 e G2 com etiquetas próprias do Mercado Livre (grupoa-20 e grupob-20) e um envio de cada em 02/10, antes das vendas. */
function semearGruposML(db) {
  for (const [jid, cod] of [[G1, 'grupoa-20'], [G2, 'grupob-20']]) {
    db.prepare('INSERT INTO tags (name, created_at) VALUES (?, 1)').run(cod);
    rastreio.salvar(db, { loja: 'mercadolivre', alvo_tipo: 'grupo', alvo: jid, codigo: cod });
    envio(db, OUT(2), jid, 'mercadolivre', cod, 'grupo', 1, { oferta_chave: 'MLB1' });
  }
}
/** Relatório provisório do Mercado Livre: sem pedido e sem coluna de código; o código vem do parâmetro. */
const CAB_ML = 'Data,MLB,Título,Quantidade,Valor da compra,Comissão,Status';
const mlArq = (comissao = '7,00') => csv(CAB_ML, `2026-10-10,MLB123,Fone inventado,1,"100,00","${comissao}",Concluído`);
const cod = (c) => `&codigo=${c}`;
const porJid = async (s) => Object.fromEntries((await ganhos(s, 'grupo')).linhas.filter((l) => l.jid !== G3).map((l) => [l.jid, l.comissao]));
const estado = (db) => linhas(db, 'SELECT codigo, comissao_centavos AS c FROM comissoes ORDER BY comissao_centavos, codigo');

test('R11/CA5 ponta a ponta: o mesmo relatório de dois grupos (mesma data e produto, sem pedido) importado com grupoa-20 e depois grupob-20 mantém as duas comissões, cada uma no seu grupo', async () => {
  const s = await subir(semearGruposML);
  try {
    let r = await importarPor(s, 'mercadolivre', mlArq('7,00'), cod('grupoa-20'));
    assert.equal(r.status, 200, r.txt);
    assert.deepEqual([r.json.novas, r.json.atualizadas], [1, 0]);
    r = await importarPor(s, 'mercadolivre', mlArq('3,00'), cod('grupob-20'));
    assert.equal(r.status, 200, r.txt);
    assert.deepEqual([r.json.novas, r.json.atualizadas, r.json.repetidas], [1, 0, 0], `o 2º grupo é linha nova: ${JSON.stringify(r.json)}`);
    assert.deepEqual(estado(s.db), [{ codigo: 'grupob-20', c: 300 }, { codigo: 'grupoa-20', c: 700 }]);
    const g = await ganhos(s, 'grupo');
    assert.equal(g.total.comissao, 1000, 'a comissão do primeiro grupo não sumiu');
    assert.deepEqual([linhaDe(g, 'jid', G1).comissao, linhaDe(g, 'jid', G2).comissao], [700, 300]);
    assert.deepEqual([linhaDe(g, 'jid', G1).vendas, linhaDe(g, 'jid', G2).vendas], [1, 1]);
    assert.equal(g.nao_atribuida.comissao, 0);
    // reimportar qualquer um dos dois não muda nada (nem troca de grupo)
    r = await importarPor(s, 'mercadolivre', mlArq('7,00'), cod('grupoa-20'));
    assert.deepEqual([r.json.novas, r.json.atualizadas, r.json.repetidas], [0, 0, 1]);
    assert.deepEqual(await porJid(s), { [G1]: 700, [G2]: 300 });
    // o código da célula vence o do parâmetro: arquivo com coluna de código preenchida não é afetado pelo parâmetro
    const comColuna = csv(`${CAB_ML},Sub id1`, '2026-10-10,MLB123,Fone inventado,1,"100,00","7,00",Concluído,grupoa-20');
    r = await importarPor(s, 'mercadolivre', comColuna, cod('grupob-20'));
    assert.deepEqual([r.json.novas, r.json.atualizadas, r.json.repetidas], [0, 0, 1], 'a linha com código na célula é a do grupoa-20');
    assert.equal(contar(s.db, 'comissoes'), 2);
  } finally { await s.fechar(); }
});

test('R11/R4 ponta a ponta: importar sem código e depois o mesmo arquivo com código atualiza a linha (não duplica) e a venda passa a ser atribuída ao grupo', async () => {
  const s = await subir(semearGruposML);
  try {
    let r = await importarPor(s, 'mercadolivre', mlArq());
    assert.deepEqual([r.json.novas, r.json.sem_grupo], [1, 1]);
    let g = await ganhos(s, 'grupo');
    assert.deepEqual([g.total.comissao, g.total.comissao_atribuida, g.nao_atribuida.comissao], [700, 0, 700], 'sem código a venda não é de ninguém');
    assert.deepEqual(estado(s.db), [{ codigo: null, c: 700 }]);

    r = await importarPor(s, 'mercadolivre', mlArq(), cod('grupoa-20'));
    assert.deepEqual([r.json.novas, r.json.atualizadas, r.json.repetidas], [0, 1, 0], JSON.stringify(r.json));
    assert.equal(contar(s.db, 'comissoes'), 1, 'não duplicou');
    assert.deepEqual(estado(s.db), [{ codigo: 'grupoa-20', c: 700 }]);
    g = await ganhos(s, 'grupo');
    assert.deepEqual([g.total.comissao, g.total.comissao_atribuida, g.nao_atribuida.comissao], [700, 700, 0]);
    assert.equal(linhaDe(g, 'jid', G1).comissao, 700);
    assert.equal(linhaDe(g, 'jid', G2).comissao, 0);

    // a linha agora tem código: o mesmo arquivo com outro código é linha nova, não rouba a do grupo A
    r = await importarPor(s, 'mercadolivre', mlArq('3,00'), cod('grupob-20'));
    assert.deepEqual([r.json.novas, r.json.atualizadas], [1, 0]);
    assert.deepEqual(await porJid(s), { [G1]: 700, [G2]: 300 });
    // e reimportar o arquivo com o mesmo código continua sem mudar
    r = await importarPor(s, 'mercadolivre', mlArq(), cod('grupoa-20'));
    assert.deepEqual([r.json.novas, r.json.atualizadas, r.json.repetidas], [0, 0, 1]);
  } finally { await s.fechar(); }
});

test('R11 ponta a ponta: arquivo com duas linhas iguais (mesma data e produto) sem código e depois com código atualiza as duas, na ordem, sem duplicar', async () => {
  const s = await subir(semearGruposML);
  try {
    const arq = (a, b) => csv(CAB_ML, `2026-10-10,MLB123,Fone inventado,1,"100,00","${a}",Concluído`, `2026-10-10,MLB123,Fone inventado,1,"100,00","${b}",Concluído`);
    await importarPor(s, 'mercadolivre', arq('7,00', '2,00'));
    assert.equal(contar(s.db, 'comissoes'), 2);
    const r = await importarPor(s, 'mercadolivre', arq('7,00', '2,00'), cod('grupoa-20'));
    assert.deepEqual([r.json.novas, r.json.atualizadas], [0, 2], JSON.stringify(r.json));
    assert.deepEqual(estado(s.db), [{ codigo: 'grupoa-20', c: 200 }, { codigo: 'grupoa-20', c: 700 }]);
    assert.equal((await porJid(s))[G1], 900);
    // com a linha antiga revisada na mesma passagem: continua uma por uma
    const r2 = await importarPor(s, 'mercadolivre', arq('7,50', '2,00'), cod('grupoa-20'));
    assert.deepEqual([r2.json.novas, r2.json.atualizadas, r2.json.repetidas], [0, 1, 1]);
    assert.equal((await porJid(s))[G1], 950);
  } finally { await s.fechar(); }
});

test('R11/CA5: a prévia bate com o que a importação grava, nos três casos (outro grupo, sem código → com código, repetido), e não grava nada', async () => {
  const s = await subir(semearGruposML);
  try {
    const campos = (j) => ({ novas: j.novas, atualizadas: j.atualizadas, repetidas: j.repetidas, lidas: j.lidas, comissao_centavos: j.comissao_centavos, sem_grupo: j.sem_grupo, codigo_arquivo: j.codigo_arquivo, codigos_desconhecidos: j.codigos_desconhecidos });
    const dump = () => JSON.stringify([linhas(s.db, 'SELECT * FROM comissoes ORDER BY id'), contar(s.db, 'importacoes')]);
    const passo = async (arq, c, esperado) => {
      const antes = dump();
      const p = await importarPor(s, 'mercadolivre', arq, `${c}&previa=1`);
      assert.equal(p.status, 200, p.txt);
      assert.equal(p.json.previa, true);
      assert.equal(dump(), antes, 'a prévia não grava');
      const g = await importarPor(s, 'mercadolivre', arq, c);
      assert.deepEqual(campos(g.json), campos(p.json), 'a prévia mostra o que foi gravado');
      assert.deepEqual([g.json.novas, g.json.atualizadas, g.json.repetidas], esperado, JSON.stringify(g.json));
      assert.equal(p.json.importacao_id, null);
      assert.ok(Number.isInteger(g.json.importacao_id));
    };
    await passo(mlArq('7,00'), '', [1, 0, 0]); // sem código
    await passo(mlArq('7,00'), cod('grupoa-20'), [0, 1, 0]); // ganha o código
    await passo(mlArq('3,00'), cod('grupob-20'), [1, 0, 0]); // outro grupo
    await passo(mlArq('3,00'), cod('grupob-20'), [0, 0, 1]); // repetido
    assert.equal(contar(s.db, 'comissoes'), 2);
    assert.deepEqual(await porJid(s), { [G1]: 700, [G2]: 300 });
  } finally { await s.fechar(); }
});

test('R11 risco documentado: com código e depois sem código conta em dobro, e a prévia avisa como "Novas" (não some em silêncio)', async () => {
  const s = await subir(semearGruposML);
  try {
    await importarPor(s, 'mercadolivre', mlArq(), cod('grupoa-20'));
    const p = await importarPor(s, 'mercadolivre', mlArq(), '&previa=1');
    assert.deepEqual([p.json.novas, p.json.atualizadas, p.json.repetidas], [1, 0, 0], 'a prévia mostra a linha como nova antes de gravar');
    assert.equal(contar(s.db, 'comissoes'), 1, 'a prévia não gravou');
    const r = await importarPor(s, 'mercadolivre', mlArq());
    assert.deepEqual([r.json.novas, r.json.atualizadas], [1, 0]);
    assert.deepEqual(estado(s.db), [{ codigo: null, c: 700 }, { codigo: 'grupoa-20', c: 700 }]);
    // o que fica atribuído é só a do grupo; a duplicada fica sem dono (visível em "sem grupo"), não vai para outro grupo
    const g = await ganhos(s, 'grupo');
    assert.deepEqual([g.total.comissao, linhaDe(g, 'jid', G1).comissao, g.nao_atribuida.comissao], [1400, 700, 700]);
  } finally { await s.fechar(); }
});

test('R11/Q1 Amazon sem pedido: relatório com coluna de código (Tracking ID) continua atualizando a mesma linha; sem coluna, o parâmetro separa os grupos', async () => {
  const s = await subir();
  try {
    const comCol = (tarifa) => csv('Name,ASIN,Tracking ID,Date Shipped,Items Shipped,Revenue,Ad Fees', `Fone,B0TESTE001,turbob1-20,2026-10-09,1,"50,00","${tarifa}"`);
    await importarPor(s, 'amazon', comCol('4,00'));
    let r = await importarPor(s, 'amazon', comCol('2,00'), cod('g3-20')); // a célula manda: o parâmetro não cria linha
    assert.deepEqual([r.json.novas, r.json.atualizadas], [0, 1]);
    assert.deepEqual(estado(s.db), [{ codigo: 'turbob1-20', c: 200 }]);
    const semCol = (v) => csv('Name,ASIN,Date Shipped,Items Shipped,Revenue,Ad Fees', `Fone,B0TESTE009,2026-10-09,1,"50,00","${v}"`);
    await importarPor(s, 'amazon', semCol('5,00'), cod('turbob1-20'));
    r = await importarPor(s, 'amazon', semCol('6,00'), cod('g3-20'));
    assert.deepEqual([r.json.novas, r.json.atualizadas], [1, 0], 'outro código, outra linha');
    assert.equal(linhas(s.db, 'SELECT SUM(comissao_centavos) AS s FROM comissoes')[0].s, 200 + 500 + 600);
  } finally { await s.fechar(); }
});
