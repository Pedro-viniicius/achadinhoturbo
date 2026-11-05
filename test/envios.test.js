// Envios avulsos (plano disparos-comunicacao-conta, etapa 8): disparo manual de oferta (F1), mensagem e enquete (F2),
// agora, agendados e repetidos, pelo servidor HTTP em porta aleatória. WhatsApp simulado, links meli.la/fake-… e um
// `ml` falso: nenhum teste acessa a rede (o fetch global é trocado por um que falha e conta).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import vm from 'node:vm';
import { openDb, setSetting } from '../src/db.js';
import { buildApp } from '../src/server.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createLinkService } from '../src/links.js';
import { createScheduler } from '../src/scheduler.js';
import { createEnvios, proximaOcorrencia, limparErro, semMetadados } from '../src/envios.js';
import { createAmazon, LinkNaoResolvido } from '../src/amazon.js';
import { createShopee, URL_API as URL_API_SHOPEE, LinkShopeeNaoResolvido } from '../src/shopee.js';
import { createEspelho } from '../src/espelho.js';
import * as lojasPadrao from '../src/lojas.js';

let acessosRede = 0;
globalThis.fetch = async () => { acessosRede++; throw new Error('rede proibida no teste'); };

const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-env-')); pastas.push(p); return p; };

const SENHA = 'senha-de-teste-123';
const DIA = 86400000;
const IMG = 'https://http2.mlstatic.com/D_NQ_NP_123-O.jpg';
const URL_ML = 'https://produto.mercadolivre.com.br/MLB-1234567890-fone-bom-_JM';
const URL_AMAZON = 'https://www.amazon.com.br/dp/B0ABC12345';
const URL_MAGALU = 'https://www.magazineluiza.com.br/fone-bom/p/abc123/';
const MSG_MAGALU = 'Magalu identificada, mas ainda não está conectada. Configure em Conexões.';
// PNG 1×1 como o sharp grava (o upload regrava a foto: este volta igual, byte a byte) e um JPEG 1×1 de verdade
// (o upload decodifica a foto: um começo de JPEG não passa mais)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsSAAALEgHS3X78AAAADUlEQVQImWNgYPhfDwACggF/NGwuCgAAAABJRU5ErkJggg==', 'base64');
const JPG = Buffer.from('/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgo'
  + 'KCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAA'
  + 'AAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCXAUUYf//Z', 'base64');
const TODOS = [0, 1, 2, 3, 4, 5, 6];

const pad = (n) => String(n).padStart(2, '0');
const dataDe = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const hhmmDe = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const amanha = (h, m = 0) => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, h, m).getTime(); };
const statusDe = (db, id) => db.prepare('SELECT status FROM envios WHERE id = ?').get(id)?.status;
const linhas = (db, sql, ...a) => db.prepare(sql).all(...a).map((r) => ({ ...r }));
const contar = (db, sql, ...a) => db.prepare(sql).get(...a).n;

/** Stub do módulo ml: devolve uma oferta pronta, sem rede, e guarda as URLs lidas. */
function mlFalso() {
  const chamadas = [];
  return {
    chamadas,
    async resolveOffer(c) {
      chamadas.push(c.url);
      return { key: c.key, url: c.url, title: 'Fone Bom', price: 89.9, oldPrice: 149.9, discountPct: 40, sold: 1200, freeShipping: true, image: IMG };
    },
  };
}

/** Banco, WhatsApp simulado, links falsos e agendador; dois grupos e duas etiquetas na primeira vez. `fast: false` liga as pausas. */
function montar({ dir = tmp(), fast = true } = {}) {
  const db = openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const ml = mlFalso();
  const scheduler = createScheduler({ db, wa, links, fast, dir, ml });
  if (!db.prepare('SELECT 1 FROM groups LIMIT 1').get()) {
    for (const [jid, nome] of [['111@g.us', 'Achadinhos'], ['222@g.us', 'Tech']]) {
      db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, nome, 10, Date.now());
    }
    for (const nome of ['etiquetaA', 'etiquetaB']) db.prepare('INSERT INTO tags (name, created_at) VALUES (?, 1)').run(nome);
  }
  return { dir, db, wa, links, ml, scheduler, envios: scheduler.envios };
}

/** Requisição crua; `raw` manda um Buffer com o Content-Type dos headers. */
function req(port, caminho, { method = 'GET', headers = {}, body, raw } = {}) {
  return new Promise((ok, err) => {
    const data = raw ?? (body != null ? Buffer.from(JSON.stringify(body)) : null);
    const h = { ...(body != null && raw == null ? { 'content-type': 'application/json' } : {}), ...(data ? { 'content-length': data.length } : {}), ...headers };
    const r = http.request({ host: '127.0.0.1', port, path: caminho, method, headers: h }, (res) => {
      const partes = []; res.on('data', (c) => partes.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(partes); const txt = buf.toString('utf8');
        let json = null; try { json = JSON.parse(txt); } catch { /* binário ou html */ }
        ok({ status: res.statusCode, headers: res.headers, json, txt, buf });
      });
    });
    r.on('error', err); if (data) r.write(data); r.end();
  });
}

/** Servidor com login, em porta aleatória, já com a sessão aberta. `dataDir` só para provar que as fotos não usam ele. */
async function subir({ dataDir, ...opcoes } = {}) {
  const m = montar(opcoes);
  const app = buildApp({ db: m.db, wa: m.wa, links: m.links, scheduler: m.scheduler, publicHost: '', panelPassword: SENHA, dataDir: dataDir ?? m.dir, ml: m.ml });
  const server = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  const { port } = server.address();
  const entrou = await req(port, '/api/login', { method: 'POST', body: { senha: SENHA } });
  const h = { cookie: String(entrou.headers['set-cookie']?.[0] || '').split(';')[0], origin: `http://127.0.0.1:${port}` };
  return {
    ...m, port,
    req: (c, o = {}) => req(port, c, { ...o, headers: { ...h, ...(o.headers || {}) } }),
    get: (c) => req(port, c, { headers: h }),
    post: (c, body = {}) => req(port, c, { method: 'POST', body, headers: h }),
    upload: (raw, tipo) => req(port, '/api/uploads', { method: 'POST', raw, headers: { ...h, 'content-type': tipo } }),
    fechar: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => { m.db.close(); r(); }); }),
  };
}

/** Espera o "agora" (fire-and-forget) terminar. */
async function terminar(db, id, ms = 3000) {
  const t0 = Date.now();
  while (['pendente', 'enviando'].includes(statusDe(db, id))) {
    if (Date.now() - t0 > ms) throw new Error(`o envio ${id} não terminou`);
    await new Promise((r) => setTimeout(r, 5));
  }
  return statusDe(db, id);
}

test('CA1: disparo manual com link do ML, agora: foto + legenda com o meli.la da etiqueta escolhida, "enviado" no painel e no log', async () => {
  const s = await subir();
  try {
    s.links.poll(0); // extensão conectada (o modo de link padrão é a extensão)
    const r = await s.post('/api/envios', {
      tipo: 'oferta', url: URL_ML, tag_id: 2, template_id: 1, group_jids: ['111@g.us'], quando: 'agora',
      offer: { title: 'Produto falso do navegador', price: 1, image: 'https://evil.example/x.jpg' }, // ignorado: o servidor lê o produto
    });
    assert.equal(r.status, 200, r.txt);
    // S14: o "agora" não envia por conta própria; fica pendente (vencido) e o agendador, acordado na hora, o manda
    assert.deepEqual([r.json.status, r.json.next_run_at <= Date.now()], ['pendente', true]);
    assert.equal(await terminar(s.db, r.json.id), 'concluido');
    assert.deepEqual(s.ml.chamadas, [URL_ML], 'o produto foi lido no servidor');
    assert.equal(s.wa.simulated.length, 1);
    const [msg] = s.wa.simulated;
    assert.deepEqual([msg.tipo, msg.jid, msg.image], ['image', '111@g.us', IMG]);
    assert.match(msg.text, /https:\/\/meli\.la\/fake-etiquetaB-\d+/);
    assert.match(msg.text, /Fone Bom/); assert.match(msg.text, /R\$ 89,90/);
    assert.doesNotMatch(msg.text, /falso/i);

    const p = await s.get('/api/envios?tipo=oferta');
    assert.equal(p.status, 200);
    assert.deepEqual(p.json.contadores, { enviados: 1, na_fila: 0, com_erro: 0 });
    assert.deepEqual(p.json.agendadas, []);
    assert.equal(p.json.linhas.length, 1);
    const { quando, ...linha } = p.json.linhas[0];
    assert.deepEqual(linha, { envio_id: r.json.id, tipo: 'oferta', titulo: 'Fone Bom', loja: 'Mercado Livre', grupo: 'Achadinhos', grupos: 1, status: 'enviado', erro: null });
    assert.ok(Math.abs(quando - Date.now()) < 10000);
    assert.deepEqual(linhas(s.db, "SELECT rule_id, rule_name, level, group_name, offer_title, message FROM log WHERE rule_name = 'Disparo manual'"),
      [{ rule_id: null, rule_name: 'Disparo manual', level: 'ok', group_name: 'Achadinhos', offer_title: 'Fone Bom', message: 'Enviado com a etiqueta etiquetaB' }]);
    const payload = JSON.parse(s.db.prepare('SELECT payload FROM envios WHERE id = ?').get(r.json.id).payload);
    assert.deepEqual([payload.loja, payload.tag_id, payload.template_id, payload.offer.title, payload.offer.image], ['mercadolivre', 2, 1, 'Fone Bom', IMG]);
  } finally { await s.fechar(); }
});

test('F1: "agora" é recusado com o WhatsApp desconectado e com a extensão offline, sem gravar nada', async () => {
  const s = await subir();
  try {
    const corpo = { tipo: 'oferta', url: URL_ML, group_jids: ['111@g.us'], template_id: 1, quando: 'agora' };
    // R8: quem diz se a extensão é necessária é o serviço de links (links.modo()), o mesmo que vai gerar o link.
    // Aqui ele está em 'fake' (como na simulação: não precisa da extensão); em 'extension' e offline, recusa.
    const modo = s.links.modo; s.links.modo = () => 'extension';
    const r = await s.post('/api/envios', corpo);
    assert.equal(r.status, 400); assert.match(r.json.erro, /extensão do Chrome não está conectada/);
    s.links.modo = modo;
    s.links.poll(0);
    const pronto = s.wa.isReady; s.wa.isReady = () => false;
    for (const c of [corpo, { tipo: 'mensagem', texto: 'oi', group_jids: ['111@g.us'] }, { tipo: 'enquete', pergunta: 'P?', opcoes: ['A', 'B'], group_jids: ['111@g.us'] }]) {
      const r = await s.post('/api/envios', c);
      assert.equal(r.status, 400, c.tipo); assert.match(r.json.erro, /WhatsApp está desconectado/);
    }
    s.wa.isReady = pronto;
    assert.equal(contar(s.db, 'SELECT COUNT(*) AS n FROM envios'), 0);
    assert.deepEqual(s.ml.chamadas, [], 'recusado antes de ler o produto');
    assert.equal(s.wa.simulated.length, 0);
  } finally { await s.fechar(); }
});

test('CA2: link de loja não conectada (Magalu, Facebook) é recusado pelo nome, sem enviar nem gravar nada; identificar mostra o aviso', async () => {
  const s = await subir();
  try {
    s.links.poll(0);
    const r = await s.post('/api/envios', { tipo: 'oferta', url: URL_MAGALU, group_jids: ['111@g.us'], template_id: 1, quando: 'agora' });
    assert.equal(r.status, 400);
    assert.equal(r.json.erro, MSG_MAGALU);
    const ag = await s.post('/api/envios', { tipo: 'oferta', url: 'https://magalu.com/xYz', group_jids: ['111@g.us'], quando: 'agendado', agendar_hhmm: '23:59' });
    assert.equal(ag.status, 400); assert.match(ag.json.erro, /^Magalu identificada/);
    const fb = await s.post('/api/envios', { tipo: 'oferta', url: 'https://fb.me/abc', group_jids: ['111@g.us'] });
    assert.equal(fb.status, 400); assert.match(fb.json.erro, /^Facebook identificada/);

    assert.equal(s.wa.simulated.length, 0, 'nada enviado');
    assert.equal(contar(s.db, 'SELECT COUNT(*) AS n FROM envios'), 0, 'nada gravado');
    assert.equal(contar(s.db, 'SELECT COUNT(*) AS n FROM envio_resultados'), 0);
    assert.equal(contar(s.db, 'SELECT COUNT(*) AS n FROM log'), 0);
    assert.deepEqual(s.ml.chamadas, []);
    const p = (await s.get('/api/envios?tipo=oferta')).json;
    assert.deepEqual(p, { agendadas: [], contadores: { enviados: 0, na_fila: 0, com_erro: 0 }, linhas: [] });

    const id = await s.post('/api/disparo/identificar', { url: URL_MAGALU, template_id: 1 });
    assert.equal(id.status, 200, 'a tela mostra o aviso da loja');
    assert.deepEqual(id.json, { loja: { id: 'magalu', nome: 'Magalu', implementada: false }, motivo: MSG_MAGALU, produto: null, texto: null, template_id: null, etiqueta: null });
  } finally { await s.fechar(); }
});

test('identificar: loja, produto lido no servidor e texto do template; link desconhecido dá 400', async () => {
  const s = await subir();
  try {
    const r = await s.post('/api/disparo/identificar', { url: `  ${URL_ML}  `, template_id: 1, tag_id: 2 });
    assert.equal(r.status, 200, r.txt);
    assert.deepEqual(r.json.loja, { id: 'mercadolivre', nome: 'Mercado Livre', implementada: true });
    assert.equal(r.json.motivo, null);
    assert.deepEqual(r.json.produto, { key: 'MLB1234567890', title: 'Fone Bom', price: 89.9, oldPrice: 149.9, discountPct: 40, sold: 1200, freeShipping: true, coupon: null, image: IMG });
    assert.match(r.json.texto, /^\*Fone Bom\*/); assert.match(r.json.texto, /https:\/\/meli\.la\/\(gerado no envio\)/);
    assert.deepEqual([r.json.template_id, r.json.etiqueta], [1, { id: 2, name: 'etiquetaB' }]);
    const padrao = await s.post('/api/disparo/identificar', { url: URL_ML });
    assert.deepEqual([padrao.json.template_id, padrao.json.etiqueta], [1, { id: 1, name: 'etiquetaA' }], 'sem escolha: o primeiro template e a primeira etiqueta');
    for (const [corpo, erro] of [
      [{ url: 'https://exemplo.com/produto' }, /Não reconheci este link/],
      [{ url: 'javascript:alert(1)' }, /Não reconheci este link/],
      [{ url: 'https://mercadolivre.com.br.evil.com/x' }, /Não reconheci este link/],
      [{}, /Cole o link do produto/],
      [{ url: URL_ML, template_id: 999 }, /Template não encontrado/],
      [{ url: URL_ML, tag_id: 'x' }, /Etiqueta não encontrada/],
    ]) {
      const e = await s.post('/api/disparo/identificar', corpo);
      assert.equal(e.status, 400, JSON.stringify(corpo)); assert.match(e.json.erro, erro);
    }
  } finally { await s.fechar(); }
});

test('CA3: disparo manual agendado para hoje fica pendente e sai no horário depois de um reinício, uma vez só', async (t) => {
  const alvo = Date.now() + 3 * 60000;
  if (new Date(alvo).toDateString() !== new Date().toDateString()) { t.skip('perto da meia-noite: o disparo manual só agenda para hoje'); return; }
  const T = new Date(alvo).setSeconds(0, 0);
  const s = await subir();
  let id;
  try {
    // agendado não exige a extensão conectada agora: ela só gera o link na hora do envio
    const r = await s.post('/api/envios', { tipo: 'oferta', url: URL_ML, group_jids: ['111@g.us', '222@g.us'], template_id: 1, quando: 'agendado', agendar_hhmm: hhmmDe(alvo) });
    assert.equal(r.status, 200, r.txt);
    ({ id } = r.json);
    assert.deepEqual(r.json, { id, status: 'pendente', next_run_at: T });
    await s.scheduler.tick(); // o tick de agora não envia o que é para daqui a pouco
    assert.equal(s.wa.simulated.length, 0);
    const p = (await s.get('/api/envios?tipo=oferta')).json;
    assert.equal(p.contadores.na_fila, 2);
    assert.deepEqual(p.agendadas.map((a) => [a.id, a.quando, a.status, a.next_run_at, a.titulo, a.loja, a.grupos]), [[id, 'agendado', 'pendente', T, 'Fone Bom', 'Mercado Livre', 2]]);
    assert.deepEqual([p.linhas[0].status, p.linhas[0].quando, p.linhas[0].grupo], ['pendente', T, '2 grupos']);
  } finally { await s.fechar(); }

  const r = montar({ dir: s.dir }); // reinício: banco reaberto, WhatsApp e agendador novos
  try {
    assert.equal(await r.envios.recuperar(), 0);
    assert.equal(await r.envios.processarPendentes(T - 1000), 0, 'um segundo antes: nada');
    assert.equal(await r.envios.processarPendentes(T + 1000), 1);
    assert.equal(r.wa.simulated.length, 2);
    assert.ok(r.wa.simulated.every((x) => x.tipo === 'image' && /meli\.la\/fake-etiquetaA-/.test(x.text)), 'foto com o link da primeira etiqueta');
    assert.equal(await r.envios.processarPendentes(T + 60000), 0);
    assert.equal(r.wa.simulated.length, 2, 'não sai de novo');
    assert.equal(statusDe(r.db, id), 'concluido');
    const p = await r.envios.painel('oferta');
    assert.deepEqual(p.linhas.map((l) => [l.status, l.grupo]).sort(), [['enviado', 'Achadinhos'], ['enviado', 'Tech']]);
    assert.deepEqual(p.contadores, { enviados: 2, na_fila: 0, com_erro: 0 });
  } finally { r.db.close(); }
});

test('CA3: envio que ficou "enviando" com um grupo ok é retomado depois do reinício sem repetir esse grupo', async () => {
  const m = montar();
  const T = amanha(10);
  const { id } = await m.envios.criar({ tipo: 'mensagem', texto: 'Retomada', group_jids: ['111@g.us', '222@g.us'], quando: 'agendado', agendar_data: dataDe(T), agendar_hhmm: '10:00' });
  // o serviço caiu no meio: 111 já recebeu nesta ocorrência; 222 só numa ocorrência anterior (não conta)
  m.db.prepare("UPDATE envios SET status = 'enviando' WHERE id = ?").run(id);
  const ins = m.db.prepare('INSERT INTO envio_resultados (envio_id, ocorrencia, ts, jid, group_name, ok) VALUES (?,?,?,?,?,1)');
  ins.run(id, T, T, '111@g.us', 'Achadinhos');
  ins.run(id, T - DIA, T - DIA, '222@g.us', 'Tech');
  m.db.close();

  const r = montar({ dir: m.dir });
  try {
    assert.equal(await r.envios.recuperar(), 1);
    assert.equal(statusDe(r.db, id), 'pendente');
    assert.equal((await r.envios.painel('mensagem')).contadores.na_fila, 1, 'na fila só o que falta');
    assert.equal(await r.envios.processarPendentes(T + 1000), 1);
    assert.deepEqual(r.wa.simulated.map((x) => [x.jid, x.text]), [['222@g.us', 'Retomada']]);
    assert.equal(statusDe(r.db, id), 'concluido');
    assert.deepEqual(JSON.parse(r.db.prepare('SELECT resultado FROM envios WHERE id = ?').get(id).resultado), { ok: 2, erro: 0 });
    assert.equal(contar(r.db, 'SELECT COUNT(*) AS n FROM envio_resultados WHERE envio_id = ? AND ocorrencia = ? AND ok = 1', id, T), 2);
    assert.equal(await r.envios.processarPendentes(T + 2000), 0);
    assert.equal(r.wa.simulated.length, 1);
  } finally { r.db.close(); }
});

test('trava: dois processarPendentes ao mesmo tempo, dois runEnvio ao mesmo tempo e o "agora" com o tick enviam uma vez só', async () => {
  const m = montar();
  try {
    const agendado = (texto, T) => ({ tipo: 'mensagem', texto, group_jids: ['111@g.us', '222@g.us'], quando: 'agendado', agendar_data: dataDe(T), agendar_hhmm: hhmmDe(T) });
    const TA = amanha(9);
    const a = await m.envios.criar(agendado('A', TA));
    const rodaram = await Promise.all([m.envios.processarPendentes(TA + 1000), m.envios.processarPendentes(TA + 1000)]);
    assert.deepEqual(rodaram.sort(), [0, 1]);
    assert.deepEqual(m.wa.simulated.map((x) => x.jid), ['111@g.us', '222@g.us']);
    assert.equal(statusDe(m.db, a.id), 'concluido');
    assert.equal(contar(m.db, 'SELECT COUNT(*) AS n FROM envio_resultados WHERE envio_id = ?', a.id), 2);

    const b = await m.envios.criar(agendado('B', amanha(9, 30)));
    const r = await Promise.all([m.envios.runEnvio(b.id), m.envios.runEnvio(b.id)]);
    assert.deepEqual(r.map((x) => !!x.pulado).sort(), [false, true], 'só um pega a trava');
    assert.equal(m.wa.simulated.filter((x) => x.text === 'B').length, 2);

    const c = await m.envios.criar({ tipo: 'mensagem', texto: 'C', group_jids: ['111@g.us', '222@g.us'], quando: 'agora' });
    await m.envios.processarPendentes();
    assert.equal(await terminar(m.db, c.id), 'concluido');
    assert.equal(m.wa.simulated.filter((x) => x.text === 'C').length, 2);
  } finally { m.db.close(); }
});

test('cancelar no meio da rodada: os grupos que faltam não recebem', async () => {
  const m = montar();
  try {
    const T = amanha(8);
    const e = await m.envios.criar({ tipo: 'mensagem', texto: 'X', group_jids: ['111@g.us', '222@g.us'], quando: 'agendado', agendar_data: dataDe(T), agendar_hhmm: '08:00' });
    const rodada = m.envios.runEnvio(e.id); // pega a trava na hora; o primeiro grupo só sai depois de um await
    assert.equal(statusDe(m.db, e.id), 'enviando');
    assert.deepEqual(await m.envios.cancelar(e.id), { ok: true, status: 'cancelado' });
    await rodada;
    assert.equal(m.wa.simulated.length, 0);
    assert.equal(statusDe(m.db, e.id), 'cancelado', 'o fim da rodada não desfaz o cancelamento');
  } finally { m.db.close(); }
});

test('CA4: mensagem agora (texto, foto enviada, prévia do link) e enquete agora', async () => {
  const s = await subir();
  try {
    const t1 = await s.post('/api/envios', { tipo: 'mensagem', texto: '  Bom dia, *grupo*!\r\n', imagem: 'nenhuma', group_jids: ['111@g.us', '222@g.us'], quando: 'agora' });
    assert.equal(t1.status, 200, t1.txt);
    assert.equal(await terminar(s.db, t1.json.id), 'concluido');
    assert.deepEqual(s.wa.simulated.map((x) => ({ ...x })), [
      { tipo: 'text', jid: '111@g.us', text: 'Bom dia, *grupo*!' }, { tipo: 'text', jid: '222@g.us', text: 'Bom dia, *grupo*!' }]);

    const up = await s.upload(PNG, 'image/png');
    assert.equal(up.status, 200, up.txt);
    const t2 = await s.post('/api/envios', { tipo: 'mensagem', texto: 'Olha a foto', imagem: 'upload', upload: up.json.id, group_jids: ['111@g.us'] });
    assert.equal(t2.status, 200, t2.txt);
    assert.equal(await terminar(s.db, t2.json.id), 'concluido');
    assert.deepEqual({ ...s.wa.simulated.at(-1) }, { tipo: 'image', jid: '111@g.us', text: 'Olha a foto', image: { bytes: PNG.length }, mimetype: 'image/png' });
    const t3 = await s.post('/api/envios', { tipo: 'mensagem', texto: '', imagem: 'upload', upload: up.json.id, group_jids: ['222@g.us'] });
    assert.equal(t3.status, 200, 'foto sem legenda vale');
    await terminar(s.db, t3.json.id);
    assert.deepEqual([s.wa.simulated.at(-1).tipo, s.wa.simulated.at(-1).text], ['image', '']);

    const t4 = await s.post('/api/envios', { tipo: 'mensagem', texto: 'Corre que acaba!', imagem: 'previa', previa_url: URL_ML, group_jids: ['222@g.us'] });
    assert.equal(t4.status, 200, t4.txt);
    await terminar(s.db, t4.json.id);
    assert.deepEqual({ ...s.wa.simulated.at(-1) }, {
      tipo: 'text', jid: '222@g.us', text: `Corre que acaba!\n\n${URL_ML}`,
      previa: { url: URL_ML, title: 'Fone Bom', description: 'R$ 89,90', image: IMG },
    }, 'o link da prévia vai no fim do texto');

    const e1 = await s.post('/api/envios', { tipo: 'enquete', pergunta: ' Qual o melhor achado? ', opcoes: ['Fone', 'Mouse', 'Teclado'], multipla: true, group_jids: ['111@g.us', '222@g.us'] });
    assert.equal(e1.status, 200, e1.txt);
    await terminar(s.db, e1.json.id);
    const polls = s.wa.simulated.filter((x) => x.tipo === 'poll');
    assert.deepEqual(polls.map((x) => x.jid), ['111@g.us', '222@g.us']);
    assert.deepEqual(polls[0].poll, { name: 'Qual o melhor achado?', values: ['Fone', 'Mouse', 'Teclado'], selectableCount: 0 });
    const e2 = await s.post('/api/envios', { tipo: 'enquete', pergunta: 'Uma só?', opcoes: ['Sim', 'Não'], group_jids: ['111@g.us'] });
    await terminar(s.db, e2.json.id);
    assert.equal(s.wa.simulated.at(-1).poll.selectableCount, 1, 'sem multipla: uma escolha');

    assert.deepEqual(linhas(s.db, "SELECT rule_name, level, COUNT(*) AS n FROM log GROUP BY rule_name, level ORDER BY rule_name"),
      [{ rule_name: 'Enquete', level: 'ok', n: 3 }, { rule_name: 'Mensagem', level: 'ok', n: 5 }]);
    const titulos = [...new Set(linhas(s.db, "SELECT offer_title FROM log WHERE rule_name = 'Mensagem' ORDER BY id").map((l) => l.offer_title))];
    assert.deepEqual(titulos.slice(0, 3), ['Bom dia, *grupo*!', 'Olha a foto', '(foto sem legenda)']);
    assert.ok(titulos[3].startsWith('Corre que acaba! https://produto.mercadolivre'), titulos[3]);
    assert.equal(contar(s.db, "SELECT COUNT(*) AS n FROM log WHERE group_name LIKE '%@%' OR message LIKE '%@%'"), 0, 'log sem JID');

    const p = (await s.get('/api/envios?tipo=mensagem')).json;
    assert.deepEqual(p.contadores, { enviados: 8, na_fila: 0, com_erro: 0 });
    assert.ok(p.linhas.every((l) => l.status === 'enviado' && l.loja === null));
    assert.deepEqual([...new Set(p.linhas.map((l) => l.tipo))].sort(), ['enquete', 'mensagem']);
    assert.deepEqual((await s.get('/api/envios?tipo=oferta')).json.contadores, { enviados: 0, na_fila: 0, com_erro: 0 }, 'oferta conta só oferta');
  } finally { await s.fechar(); }
});

test('CA4: agendado entra na lista e na fila e pode ser cancelado; o que perdeu o horário vira erro; contadores', async () => {
  const s = await subir();
  try {
    const TA = amanha(10); const TB = amanha(11);
    const a = await s.post('/api/envios', { tipo: 'mensagem', texto: 'Promoção amanhã às 10h', group_jids: ['111@g.us', '222@g.us'], quando: 'agendado', agendar_data: dataDe(TA), agendar_hhmm: '10:00' });
    assert.equal(a.status, 200, a.txt);
    assert.deepEqual([a.json.status, a.json.next_run_at], ['pendente', TA]);
    const b = await s.post('/api/envios', { tipo: 'enquete', pergunta: 'Vem amanhã?', opcoes: ['Sim', 'Não'], group_jids: ['111@g.us'], quando: 'agendado', agendar_data: dataDe(TB), agendar_hhmm: '11:00' });
    assert.equal(b.status, 200, b.txt);
    // falha num grupo: a linha mostra o erro sem o número que a biblioteca citou
    const enviarTexto = s.wa.sendText;
    s.wa.sendText = async (jid, ...resto) => {
      if (jid === '222@g.us') throw new Error('not-authorized para 5511999998888@s.whatsapp.net');
      return enviarTexto(jid, ...resto);
    };
    const c = await s.post('/api/envios', { tipo: 'mensagem', texto: 'Agora', group_jids: ['111@g.us', '222@g.us'] });
    assert.equal(await terminar(s.db, c.json.id), 'erro', 'envio parcial termina como erro');
    s.wa.sendText = enviarTexto;

    let p = (await s.get('/api/envios?tipo=mensagem')).json;
    assert.deepEqual(p.contadores, { enviados: 1, na_fila: 3, com_erro: 1 });
    assert.deepEqual(p.agendadas.map((x) => [x.id, x.tipo, x.quando, x.status, x.next_run_at, x.grupos, x.titulo]),
      [[a.json.id, 'mensagem', 'agendado', 'pendente', TA, 2, 'Promoção amanhã às 10h'], [b.json.id, 'enquete', 'agendado', 'pendente', TB, 1, 'Vem amanhã?']]);
    assert.deepEqual([p.agendadas[0].grupos_nomes, p.agendadas[0].imagem, p.agendadas[0].repetir, p.agendadas[1].imagem], [['Achadinhos', 'Tech'], 'nenhuma', null, null]);
    assert.deepEqual(p.linhas.slice(0, 2).map((l) => [l.envio_id, l.status, l.quando, l.grupo]), [[b.json.id, 'pendente', TB, 'Achadinhos'], [a.json.id, 'pendente', TA, '2 grupos']]);
    const falha = p.linhas.find((l) => l.status === 'erro');
    assert.equal(falha.grupo, 'Tech');
    assert.match(falha.erro, /not-authorized/); assert.doesNotMatch(falha.erro, /5511999998888|whatsapp\.net/);
    assert.equal(contar(s.db, "SELECT COUNT(*) AS n FROM log WHERE message LIKE '%5511999998888%' OR message LIKE '%@%'"), 0);

    const pa = await s.post(`/api/envios/${a.json.id}/pausar`);
    assert.equal(pa.status, 400); assert.match(pa.json.erro, /Só envios repetidos podem ser pausados/);
    const ca = await s.post(`/api/envios/${a.json.id}/cancelar`);
    assert.equal(ca.status, 200); assert.deepEqual(ca.json, { ok: true, status: 'cancelado' });
    assert.equal((await s.post(`/api/envios/${a.json.id}/cancelar`)).status, 400, 'cancelar de novo');
    for (const id of ['999', 'abc']) assert.match((await s.post(`/api/envios/${id}/cancelar`)).json.erro, /Envio não encontrado/);
    p = (await s.get('/api/envios?tipo=mensagem')).json;
    assert.deepEqual(p.agendadas.map((x) => x.id), [b.json.id]);
    assert.equal(p.contadores.na_fila, 1);
    const antes = s.wa.simulated.length;
    assert.equal(await s.envios.processarPendentes(TA + 1000), 0);
    assert.equal(s.wa.simulated.length, antes, 'o cancelado não sai');

    // B passou mais de 2 h do horário (WhatsApp fora): vira erro sem enviar
    await s.envios.processarPendentes(TB + 2 * 3600000 + 1000);
    assert.equal(s.wa.simulated.length, antes);
    assert.equal(statusDe(s.db, b.json.id), 'erro');
    p = (await s.get('/api/envios?tipo=mensagem')).json;
    assert.deepEqual(p.contadores, { enviados: 1, na_fila: 0, com_erro: 2 });
    assert.deepEqual(p.agendadas, []);
    const perdida = p.linhas.find((l) => l.envio_id === b.json.id);
    assert.deepEqual([perdida.status, perdida.quando, perdida.titulo, perdida.grupo], ['erro', TB, 'Vem amanhã?', 'Achadinhos']);
    assert.match(perdida.erro, /perdeu o horário/);
    assert.match(s.db.prepare("SELECT message FROM log WHERE rule_name = 'Enquete' AND level = 'erro'").get().message, /perdeu o horário/);

    assert.deepEqual((await s.get('/api/envios?tipo=oferta')).json.contadores, { enviados: 0, na_fila: 0, com_erro: 0 });
    assert.equal((await s.get('/api/envios?tipo=outro')).status, 400);
  } finally { await s.fechar(); }
});

test('CA4: repetido gera a próxima ocorrência, aparece em agendadas, pausa, retoma, pula horário perdido e cancela', async () => {
  const s = await subir();
  try {
    const rep = { dias: TODOS, horarios: ['18:30', '9:00'] };
    const antes = Date.now();
    const r = await s.post('/api/envios', { tipo: 'enquete', pergunta: 'Achado do dia?', opcoes: ['A', 'B'], group_jids: ['111@g.us'], quando: 'repetir', repetir: rep });
    assert.equal(r.status, 200, r.txt);
    const { id } = r.json; const T1 = r.json.next_run_at;
    assert.equal(T1, proximaOcorrencia(rep, antes));
    let p = (await s.get('/api/envios?tipo=mensagem')).json;
    assert.deepEqual(p.agendadas.map((x) => [x.id, x.quando, x.status, x.next_run_at, x.repetir]), [[id, 'repetir', 'pendente', T1, { dias: TODOS, horarios: ['09:00', '18:30'] }]]);

    assert.equal(await s.envios.processarPendentes(T1 + 1000), 1);
    assert.equal(s.wa.simulated.length, 1);
    const T2 = s.db.prepare('SELECT next_run_at FROM envios WHERE id = ?').get(id).next_run_at;
    assert.equal(T2, proximaOcorrencia(rep, T1), 'próxima ocorrência depois da que saiu');
    assert.equal(statusDe(s.db, id), 'pendente');
    assert.deepEqual(JSON.parse(s.db.prepare('SELECT resultado FROM envios WHERE id = ?').get(id).resultado), { ok: 1, erro: 0 });
    assert.equal(await s.envios.processarPendentes(T2 + 1000), 1);
    assert.equal(s.wa.simulated.length, 2, 'a ocorrência seguinte manda de novo para o mesmo grupo');
    const T3 = s.db.prepare('SELECT next_run_at FROM envios WHERE id = ?').get(id).next_run_at;
    p = (await s.get('/api/envios?tipo=mensagem')).json;
    assert.deepEqual(p.agendadas.map((x) => [x.id, x.next_run_at]), [[id, T3]], 'continua na lista');
    assert.equal(p.contadores.enviados, 2);

    const pa = await s.post(`/api/envios/${id}/pausar`);
    assert.deepEqual([pa.status, pa.json], [200, { ok: true, status: 'pausado' }]);
    assert.equal((await s.post(`/api/envios/${id}/pausar`)).status, 400, 'já pausado');
    p = (await s.get('/api/envios?tipo=mensagem')).json;
    assert.deepEqual(p.agendadas.map((x) => [x.status, x.next_run_at]), [['pausado', null]]);
    assert.equal(p.contadores.na_fila, 0, 'pausado não está na fila');
    assert.equal(await s.envios.processarPendentes(T3 + 1000), 0);
    assert.equal(s.wa.simulated.length, 2, 'pausado não sai');

    const antesRet = Date.now();
    const re = await s.post(`/api/envios/${id}/retomar`);
    assert.equal(re.status, 200, re.txt);
    assert.deepEqual(re.json, { ok: true, status: 'pendente', next_run_at: proximaOcorrencia(rep, antesRet) });
    assert.equal((await s.post(`/api/envios/${id}/retomar`)).status, 400, 'só retoma pausado');

    // a ocorrência passou mais de 2 h sem WhatsApp: pula para a próxima, sem enviar
    const N = re.json.next_run_at;
    assert.equal(await s.envios.processarPendentes(N + 3 * 3600000), 0);
    assert.equal(s.wa.simulated.length, 2);
    assert.deepEqual([statusDe(s.db, id), s.db.prepare('SELECT next_run_at FROM envios WHERE id = ?').get(id).next_run_at], ['pendente', proximaOcorrencia(rep, N + 3 * 3600000)]);
    assert.match(s.db.prepare("SELECT message FROM log WHERE level = 'aviso'").get().message, /pulado: perdeu o horário/);

    const ca = await s.post(`/api/envios/${id}/cancelar`);
    assert.deepEqual([ca.status, ca.json.status], [200, 'cancelado']);
    assert.deepEqual((await s.get('/api/envios?tipo=mensagem')).json.agendadas, []);
    assert.equal(await s.envios.processarPendentes(N + 30 * DIA), 0);
    assert.equal(s.wa.simulated.length, 2);
    assert.equal((await s.post(`/api/envios/${id}/retomar`)).status, 400);
  } finally { await s.fechar(); }
});

test('CA4: upload só JPG/PNG (pelos bytes), até 5 MB, id aleatório validado; servido com tipo fixo e nosniff', async () => {
  const s = await subir();
  try {
    const pasta = path.join(s.dir, 'uploads');
    assert.equal(fs.existsSync(pasta), false, 'montar as rotas não cria a pasta');
    const png = await s.upload(PNG, 'image/png');
    assert.equal(png.status, 200, png.txt);
    assert.match(png.json.id, /^[a-f0-9]{32}\.png$/);
    assert.deepEqual(fs.readFileSync(path.join(pasta, png.json.id)), PNG);
    const jpg = await s.upload(JPG, 'image/jpeg');
    assert.equal(jpg.status, 200, jpg.txt);
    assert.match(jpg.json.id, /^[a-f0-9]{32}\.jpg$/);

    const g = await s.get(`/api/uploads/${png.json.id}`);
    assert.equal(g.status, 200);
    assert.equal(g.headers['content-type'], 'image/png');
    assert.equal(g.headers['x-content-type-options'], 'nosniff');
    assert.deepEqual(g.buf, PNG);
    assert.equal((await s.get(`/api/uploads/${jpg.json.id}`)).headers['content-type'], 'image/jpeg');

    for (const [corpo, tipo, nome] of [
      [Buffer.from('isto não é um jpeg de verdade'), 'image/jpeg', 'jpeg falso'],
      [JPG, 'image/png', 'bytes de jpeg dizendo png'],
      [PNG, 'image/jpeg', 'bytes de png dizendo jpeg'],
      [Buffer.from(`GIF89a${'x'.repeat(20)}`), 'image/gif', 'gif'],
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml', 'svg'],
      [PNG.subarray(0, 4), 'image/png', 'png cortado'],
    ]) {
      const r = await s.upload(corpo, tipo);
      assert.equal(r.status, 415, nome); assert.match(r.json.erro, /JPG ou PNG/, nome);
    }
    assert.equal((await s.post('/api/uploads', { foto: 'iVBORw0KGgo' })).status, 415, 'JSON não é foto');
    const grande = Buffer.alloc(5 * 1024 * 1024 + 1); JPG.copy(grande);
    const g413 = await s.upload(grande, 'image/jpeg');
    assert.equal(g413.status, 413); assert.match(g413.json.erro, /5 MB/);
    assert.equal(fs.readdirSync(pasta).length, 2, 'só as duas fotos válidas foram gravadas');

    for (const c of ['/api/uploads/../x', '/api/uploads/..%2F..%2Fdisparador.db', '/api/uploads/%2e%2e', `/api/uploads/${'a'.repeat(32)}.gif`,
      `/api/uploads/${'A'.repeat(32)}.png`, `/api/uploads/${'a'.repeat(32)}.png`, `/api/uploads/${png.json.id}.png`]) {
      const r = await s.get(c);
      assert.ok([400, 404].includes(r.status), `${c}: ${r.status}`);
      assert.doesNotMatch(r.headers['content-type'] || '', /image|octet/, c);
    }
  } finally { await s.fechar(); }
});

test('criar: validação por tipo e por quando; nada é gravado nem lido', async () => {
  const m = montar();
  try {
    const g = ['111@g.us'];
    const casos = [
      [{}, /Tipo de envio inválido/],
      [{ tipo: 'mensagem', texto: 'oi', group_jids: g, quando: 'depois' }, /Quando enviar/],
      [{ tipo: 'mensagem', texto: '   ', group_jids: g }, /Escreva a mensagem/],
      [{ tipo: 'mensagem', texto: 'x'.repeat(4097), group_jids: g }, /4096/],
      [{ tipo: 'mensagem', texto: 'oi', imagem: 'gif', group_jids: g }, /Imagem/],
      [{ tipo: 'mensagem', texto: 'oi', imagem: 'upload', upload: '../../disparador.db', group_jids: g }, /Escolha a foto de novo/],
      [{ tipo: 'mensagem', texto: 'oi', imagem: 'upload', upload: `${'a'.repeat(32)}.png`, group_jids: g }, /não foi encontrada/],
      [{ tipo: 'mensagem', texto: 'oi', imagem: 'previa', previa_url: '', group_jids: g }, /link da prévia/],
      [{ tipo: 'mensagem', texto: 'oi', imagem: 'previa', previa_url: URL_MAGALU, group_jids: g }, /Magalu identificada, mas ainda não está conectada/],
      [{ tipo: 'mensagem', texto: 'oi', imagem: 'previa', previa_url: 'https://s.shopee.com.br/abc', group_jids: g }, /só funciona com links do Mercado Livre/],
      [{ tipo: 'mensagem', texto: 'oi', imagem: 'previa', previa_url: URL_AMAZON, group_jids: g }, /só funciona com links do Mercado Livre/],
      [{ tipo: 'mensagem', texto: 'oi', imagem: 'previa', previa_url: 'https://exemplo.com/x', group_jids: g }, /só funciona com links do Mercado Livre/],
      [{ tipo: 'mensagem', texto: 'oi', group_jids: [] }, /ao menos um grupo/],
      [{ tipo: 'mensagem', texto: 'oi', group_jids: 'x' }, /ao menos um grupo/],
      [{ tipo: 'mensagem', texto: 'oi', group_jids: [1] }, /grupos inválida/],
      [{ tipo: 'mensagem', texto: 'oi', group_jids: ['999@g.us'] }, /não existe mais/],
      [{ tipo: 'enquete', pergunta: 'P?', opcoes: ['só uma'], group_jids: g }, /2 a 12/],
      [{ tipo: 'enquete', pergunta: 'P?', opcoes: ['A', ' a '], group_jids: g }, /repetidas/],
      [{ tipo: 'enquete', pergunta: 'P?', opcoes: Array.from({ length: 13 }, (_, i) => `o${i}`), group_jids: g }, /2 a 12/],
      [{ tipo: 'enquete', pergunta: 'p'.repeat(256), opcoes: ['A', 'B'], group_jids: g }, /255/],
      [{ tipo: 'enquete', pergunta: 'P?', opcoes: ['A', 'b'.repeat(101)], group_jids: g }, /100 caracteres/],
      [{ tipo: 'enquete', pergunta: '  ', opcoes: ['A', 'B'], group_jids: g }, /pergunta/],
      [{ tipo: 'enquete', pergunta: 'P?', opcoes: ['A', { x: 1 }], group_jids: g }, /2 a 12/],
      [{ tipo: 'oferta', url: URL_ML, group_jids: g, quando: 'repetir', repetir: { dias: TODOS, horarios: ['09:00'] } }, /agora ou agendado para hoje/],
      [{ tipo: 'oferta', url: URL_ML, group_jids: g, quando: 'agendado', agendar_data: dataDe(amanha(10)), agendar_hhmm: '10:00' }, /só pode ser agendado para hoje/],
      [{ tipo: 'oferta', url: 'https://exemplo.com/p', group_jids: g }, /Não reconheci este link/],
      [{ tipo: 'oferta', group_jids: g }, /Cole o link do produto/],
      [{ tipo: 'oferta', url: URL_ML, tag_id: 99, group_jids: g }, /Etiqueta não encontrada/],
      [{ tipo: 'oferta', url: URL_ML, template_id: 99, group_jids: g }, /Template não encontrado/],
      [{ tipo: 'mensagem', texto: 'oi', group_jids: g, quando: 'agendado', agendar_data: '2020-01-01', agendar_hhmm: '10:00' }, /já passou/],
      [{ tipo: 'mensagem', texto: 'oi', group_jids: g, quando: 'agendado', agendar_data: '2030-02-31', agendar_hhmm: '10:00' }, /Data inválida/],
      [{ tipo: 'mensagem', texto: 'oi', group_jids: g, quando: 'agendado', agendar_data: '02/11/2030', agendar_hhmm: '10:00' }, /Data inválida/],
      [{ tipo: 'mensagem', texto: 'oi', group_jids: g, quando: 'agendado', agendar_hhmm: '25:00' }, /horário/],
      [{ tipo: 'mensagem', texto: 'oi', group_jids: g, quando: 'repetir' }, /dias e os horários/],
      [{ tipo: 'mensagem', texto: 'oi', group_jids: g, quando: 'repetir', repetir: { dias: [], horarios: ['09:00'] } }, /dia da semana/],
      [{ tipo: 'mensagem', texto: 'oi', group_jids: g, quando: 'repetir', repetir: { dias: [7], horarios: ['09:00'] } }, /dia da semana/],
      [{ tipo: 'mensagem', texto: 'oi', group_jids: g, quando: 'repetir', repetir: { dias: [1], horarios: [] } }, /1 a 6/],
      [{ tipo: 'mensagem', texto: 'oi', group_jids: g, quando: 'repetir', repetir: { dias: [1], horarios: ['01:00', '02:00', '03:00', '04:00', '05:00', '06:00', '07:00'] } }, /1 a 6/],
      [{ tipo: 'mensagem', texto: 'oi', group_jids: g, quando: 'repetir', repetir: { dias: [1], horarios: ['9h'] } }, /HH:MM/],
    ];
    for (const [corpo, erro] of casos) await assert.rejects(m.envios.criar(corpo), erro, JSON.stringify(corpo).slice(0, 100));
    assert.equal(contar(m.db, 'SELECT COUNT(*) AS n FROM envios'), 0);
    assert.equal(m.wa.simulated.length, 0);
    assert.deepEqual(m.ml.chamadas, [], 'nenhum produto lido para corpo inválido');
  } finally { m.db.close(); }
});

test('limpar: envios encerrados antigos e seus resultados; fotos sem envio ativo depois de 7 dias sem uso', async () => {
  const m = montar();
  try {
    const agora = Date.now();
    const pasta = path.join(m.dir, 'uploads'); fs.mkdirSync(pasta);
    const envelhecer = (f, dias) => { const t = (agora - dias * DIA) / 1000; fs.utimesSync(f, t, t); };
    const foto = (letra, ext, dias) => { const nome = `${letra.repeat(32)}.${ext}`; fs.writeFileSync(path.join(pasta, nome), PNG); envelhecer(path.join(pasta, nome), dias); return nome; };
    foto('a', 'png', 8);                     // ninguém usa há 8 dias: apaga
    const nova = foto('b', 'jpg', 1);        // ninguém usa, 1 dia: fica
    const ativa = foto('c', 'png', 30);      // usada por envio pendente: fica
    const recente = foto('d', 'png', 30);    // o envio que a usou rodou há 2 dias: fica
    const velha = foto('e', 'png', 30);      // o envio que a usou rodou há 10 dias: apaga
    fs.writeFileSync(path.join(pasta, 'leia-me.txt'), 'x'); envelhecer(path.join(pasta, 'leia-me.txt'), 30); // não é nosso: fica

    const ins = m.db.prepare('INSERT INTO envios (tipo, payload, group_jids, quando, status, next_run_at, last_run_at, created_at) VALUES (?,?,?,?,?,?,?,?)');
    const comFoto = (up) => JSON.stringify({ texto: '', imagem: 'upload', upload: up });
    const novo = (...v) => Number(ins.run(...v).lastInsertRowid);
    const e1 = novo('oferta', '{}', '[]', 'agora', 'concluido', null, agora - 40 * DIA, agora - 40 * DIA);  // apaga
    novo('mensagem', '{}', '[]', 'agendado', 'cancelado', agora - 39 * DIA, null, agora - 40 * DIA);        // apaga (nunca rodou)
    const e3 = novo('enquete', '{}', '[]', 'agora', 'erro', null, agora - DIA, agora - 40 * DIA);          // recente: fica
    novo('mensagem', comFoto(ativa), '[]', 'repetir', 'pendente', agora + DIA, agora - 40 * DIA, agora - 40 * DIA); // ativo: fica
    novo('mensagem', comFoto(recente), '[]', 'agora', 'concluido', null, agora - 2 * DIA, agora - 30 * DIA);
    novo('mensagem', comFoto(velha), '[]', 'agora', 'concluido', null, agora - 10 * DIA, agora - 30 * DIA);
    const res = m.db.prepare('INSERT INTO envio_resultados (envio_id, ocorrencia, ts, jid, group_name, ok) VALUES (?,?,?,?,?,1)');
    res.run(e1, 1, 1, '111@g.us', 'Achadinhos'); res.run(e3, 1, 1, '111@g.us', 'Achadinhos');

    assert.deepEqual(await m.envios.limpar(30, agora), { envios: 2, fotos: 2 });
    assert.equal(contar(m.db, 'SELECT COUNT(*) AS n FROM envios'), 4);
    assert.deepEqual(linhas(m.db, 'SELECT envio_id FROM envio_resultados'), [{ envio_id: e3 }], 'resultados do envio apagado somem junto');
    assert.deepEqual(fs.readdirSync(pasta).sort(), [ativa, recente, nova, 'leia-me.txt'].sort());

    assert.deepEqual(await m.envios.limpar(0, agora), { envios: 0, fotos: 0 }, '0 dias: não apaga envio');
    foto('f', 'png', 9);
    assert.deepEqual(await m.envios.limpar(0, agora), { envios: 0, fotos: 1 }, 'as fotos seguem a regra dos 7 dias mesmo com retenção 0');
    const semPasta = createEnvios({ db: m.db, wa: m.wa, links: m.links, ml: m.ml, fast: true });
    assert.deepEqual(await semPasta.limpar(30, agora), { envios: 0, fotos: 0 });
  } finally { m.db.close(); }
});

// ---------- rodada 1 de correções (servidor): S13, S14, S15, R8, R9, Q6 (template) e a regressão do upload ----------
test('S14: três "agora" seguidos saem um de cada vez pelo agendador, com a pausa entre uma mensagem e outra', async () => {
  const s = await subir({ fast: false });
  try {
    setSetting(s.db, 'delay_group_s', 0.5); // jitter: de 0,35 s a 0,65 s
    const ids = [];
    for (const texto of ['um', 'dois', 'três']) {
      const r = await s.post('/api/envios', { tipo: 'mensagem', texto, group_jids: ['111@g.us'] });
      assert.equal(r.status, 200, r.txt);
      assert.equal(r.json.status, 'pendente', 'a resposta sai antes do envio: quem manda é o agendador');
      ids.push(r.json.id);
    }
    for (const id of ids) assert.equal(await terminar(s.db, id, 5000), 'concluido');
    assert.deepEqual(s.wa.simulated.map((x) => x.text), ['um', 'dois', 'três'], 'na ordem, uma vez cada');
    const ts = linhas(s.db, 'SELECT ts FROM envio_resultados ORDER BY ts, id').map((l) => l.ts);
    assert.equal(ts.length, 3);
    // 340 e não 350: o timer do Node pode disparar 1 ms antes do Date.now(); em paralelo, o intervalo seria ~0
    for (let i = 1; i < ts.length; i++) assert.ok(ts[i] - ts[i - 1] >= 340, `intervalo entre mensagens: ${ts[i] - ts[i - 1]} ms`);
  } finally { await s.fechar(); }
});

test('S14: "agora" criado com o tick em andamento sai no mesmo tick, sem esperar o próximo', async () => {
  const m = montar();
  try {
    const processar = m.envios.processarPendentes;
    let chamadas = 0; let criado = null;
    // o primeiro passo do tick já leu a fila quando o "agora" chega
    m.envios.processarPendentes = async (...a) => {
      chamadas++;
      const r = await processar(...a);
      if (chamadas === 1) criado = await m.envios.criar({ tipo: 'mensagem', texto: 'no meio do tick', group_jids: ['111@g.us'] });
      return r;
    };
    await m.scheduler.tick();
    assert.equal(statusDe(m.db, criado.id), 'concluido', 'saiu antes de o tick terminar');
    assert.deepEqual(m.wa.simulated.map((x) => x.text), ['no meio do tick']);
  } finally { m.db.close(); }
});

test('S13: limparErro corta antes das regex (texto enorme em menos de 50 ms) e o corte não solta pedaço de número', () => {
  for (const n of [1e5, 1e6]) {
    const t0 = performance.now(); const r = limparErro('a'.repeat(n)); const ms = performance.now() - t0;
    assert.ok(ms < 50, `limparErro(${n} letras): ${ms.toFixed(1)} ms`); assert.ok(r.length <= 200);
  }
  // 16 JIDs (480 letras) e uma palavra com número que o corte em 500 partiria em 6 dígitos (a regex só pega 8+)
  const texto = `${'5511999998888@s.whatsapp.net '.repeat(16)}${'n'.repeat(14)}5511987654321 fim`;
  const limpo = limparErro(texto);
  assert.doesNotMatch(limpo, /551198|whatsapp/, limpo);
});

test('S13: o erro que a extensão devolve fica com até 300 letras (no pedido rejeitado e no estado)', async () => {
  const links = createLinkService({ getMode: () => 'extension' });
  const pegar = async () => { const job = links.poll(1000); const pedido = links.requestLink({ url: URL_ML, tag: 'x', timeoutMs: 2000 }); return { job: await job, pedido }; };
  let { job, pedido } = await pegar();
  links.submit(job.id, { ok: false, error: 'e'.repeat(1024 * 1024) });
  await assert.rejects(pedido, (e) => e.message.length <= 300);
  assert.ok(links.status().lastError.length <= 300);
  ({ job, pedido } = await pegar());
  links.submit(job.id, { ok: true, link: 'https://evil.example/x', error: 'z'.repeat(1024 * 1024) });
  await assert.rejects(pedido, (e) => e.message.length <= 300);
  assert.ok(links.status().lastError.length <= 300);
  assert.equal(links.modo(), 'extension', 'R8: o serviço diz o modo em que vai gerar o link');
});

/** Segmento JPEG: FF, marcador, tamanho (2 bytes, conta ele mesmo) e o corpo. */
const segJpeg = (marcador, corpo) => { const c = Buffer.from(corpo, 'latin1'); return Buffer.concat([Buffer.from([0xff, marcador, (c.length + 2) >> 8, (c.length + 2) & 0xff]), c]); };
/** Bloco PNG com o CRC certo. */
const blocoPng = (tipo, dados) => {
  const td = Buffer.concat([Buffer.from(tipo, 'latin1'), Buffer.from(dados, 'latin1')]);
  const tam = Buffer.alloc(4); tam.writeUInt32BE(td.length - 4); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
  return Buffer.concat([tam, td, crc]);
};

test('S15: a foto é gravada sem metadados (JPEG sem APP1–APP15 nem o que vem depois do fim; PNG sem eXIf/tEXt/zTXt/iTXt)', async (t) => {
  const s = await subir();
  try {
    const gravado = async (buf, tipo) => {
      const r = await s.upload(buf, tipo); assert.equal(r.status, 200, r.txt);
      const g = await s.get(`/api/uploads/${r.json.id}`); assert.equal(g.status, 200);
      assert.deepEqual(fs.readFileSync(path.join(s.dir, 'uploads', r.json.id)), g.buf, 'servido = gravado');
      return g.buf;
    };
    // JPEG progressivo de mentira, mas com a estrutura de verdade: dois scans, bytes 0xFF00 e RSTn nos dados.
    // R16: o upload regrava a foto pelo sharp, que não decodifica dados de mentira; este vai direto ao percurso manual
    // (o de quando o sharp não carrega)
    const app0 = segJpeg(0xe0, 'JFIF\0\x01\x01\0\0\x01\0\x01\0\0');
    const dqt = segJpeg(0xdb, `\0${'\x01'.repeat(64)}`);
    const sof = segJpeg(0xc2, '\x08\0\x01\0\x01\x01\x01\x11\0');
    const dht = segJpeg(0xc4, `\0${'\0'.repeat(15)}\x01\x05`);
    const sos = segJpeg(0xda, '\x01\x01\0\0\x3f\0');
    const dados1 = Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78, 0x9a]);
    const dados2 = Buffer.from([0xab, 0xff, 0x00, 0xcd, 0xff, 0xd7, 0xef]);
    const eoi = Buffer.from([0xff, 0xd9]); const soi = Buffer.from([0xff, 0xd8]);
    const exif = segJpeg(0xe1, 'Exif\0\0GPS -22.9068 -43.1729 iPhone de Pedro');
    const xmp = segJpeg(0xe1, 'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>Pedro</x:xmpmeta>');
    const icc = segJpeg(0xe2, 'ICC_PROFILE\0\x01\x01perfil');
    const app15 = segJpeg(0xef, 'fabricante: segredo');
    const entreScans = segJpeg(0xe1, 'Exif\0\0entre scans');
    const segundaImagem = Buffer.concat([soi, segJpeg(0xe1, 'Exif\0\0GPS da imagem anexa'), eoi]); // MPF/trailer depois do EOI
    const original = Buffer.concat([soi, app0, exif, xmp, icc, app15, dqt, sof, dht, sos, dados1, entreScans, dht, sos, dados2, eoi, segundaImagem]);
    const jpg = semMetadados(original, 'jpg');
    assert.deepEqual(jpg, Buffer.concat([soi, app0, dqt, sof, dht, sos, dados1, dht, sos, dados2, eoi]), 'só os metadados saíram, o resto byte a byte');
    for (const marca of ['Exif', 'GPS', 'Pedro', 'ICC_PROFILE', 'segredo']) assert.ok(!jpg.includes(marca), marca);

    // PNG 1×1 com os quatro blocos de metadados logo depois do IHDR
    const meta = [blocoPng('tEXt', 'Comment\0Pedro'), blocoPng('zTXt', 'Author\0\0x'), blocoPng('iTXt', 'GPS\0\0\0\0\0-22.9'), blocoPng('eXIf', 'MM\0*segredo')];
    const comMeta = Buffer.concat([PNG.subarray(0, 33), ...meta, PNG.subarray(33)]);
    assert.deepEqual(await gravado(comMeta, 'image/png'), PNG, 'o PNG volta a ser o original');

    // fotos de verdade (sharp, dependência do projeto): o Exif some e a imagem continua a mesma
    let sharp;
    try { sharp = (await import('sharp')).default; } catch { t.diagnostic('sharp ausente: pulei as fotos de verdade'); return; }
    const base = () => sharp({ create: { width: 8, height: 6, channels: 3, background: '#3366cc' } });
    for (const [buf, tipo] of [[await base().jpeg().withExif({ IFD0: { Copyright: 'Pedro', ImageDescription: 'GPS -22.9' } }).toBuffer(), 'image/jpeg'],
      [await base().png().withExif({ IFD0: { Copyright: 'Pedro' } }).toBuffer(), 'image/png']]) {
      assert.ok(buf.includes('Pedro') && (await sharp(buf).metadata()).exif, `${tipo}: a foto de teste tem Exif`);
      const limpo = await gravado(buf, tipo);
      assert.ok(!limpo.includes('Pedro'), tipo);
      const info = await sharp(limpo).metadata();
      assert.deepEqual([info.exif, info.width, info.height], [undefined, 8, 6], tipo);
      assert.deepEqual(await sharp(limpo).raw().toBuffer(), await sharp(buf).raw().toBuffer(), `${tipo}: mesmos pixels`);
    }
  } finally { await s.fechar(); }
});

// ---------- rodada 3 (R16/Q9): o upload regrava a foto pelo sharp (gira pelo Exif, sai sem metadados); ilegível → 415 ----------
async function sharpOuPula(t) {
  try { return (await import('sharp')).default; } catch { t.skip('sharp ausente: o upload usa o percurso manual'); return null; }
}
/** APP1 Exif (TIFF big-endian) com Orientation e ImageDescription no IFD0, como o da câmera de um celular. */
function app1Exif(orientacao, descricao) {
  const texto = Buffer.from(`${descricao}\0`, 'latin1');
  const tiff = Buffer.alloc(8 + 2 + 2 * 12 + 4);
  tiff.write('MM', 0, 'latin1'); tiff.writeUInt16BE(42, 2); tiff.writeUInt32BE(8, 4); tiff.writeUInt16BE(2, 8);
  tiff.writeUInt16BE(0x010e, 10); tiff.writeUInt16BE(2, 12); tiff.writeUInt32BE(texto.length, 14); tiff.writeUInt32BE(tiff.length, 18);
  tiff.writeUInt16BE(0x0112, 22); tiff.writeUInt16BE(3, 24); tiff.writeUInt32BE(1, 26); tiff.writeUInt16BE(orientacao, 30);
  return segJpeg(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff, texto]).toString('latin1'));
}

test('R16/Q9: foto de celular com orientação 6 é gravada já girada (em pé) e sem Exif; PNG com tEXt perde o bloco', async (t) => {
  const sharp = await sharpOuPula(t); if (!sharp) return;
  const s = await subir();
  try {
    const gravada = async (buf, tipo) => {
      const r = await s.upload(buf, tipo); assert.equal(r.status, 200, r.txt);
      return fs.readFileSync(path.join(s.dir, 'uploads', r.json.id));
    };
    // 16×12 "deitada" (metade esquerda vermelha, direita azul) com orientação 6: quem respeita o Exif gira 90° no horário
    const raw = Buffer.alloc(16 * 12 * 3);
    for (let y = 0; y < 12; y++) for (let x = 0; x < 16; x++) raw[(y * 16 + x) * 3 + (x < 8 ? 0 : 2)] = 255;
    const foto = await sharp(raw, { raw: { width: 16, height: 12, channels: 3 } }).jpeg()
      .withMetadata({ orientation: 6, exif: { IFD0: { Copyright: 'Pedro' } } }).toBuffer();
    const antes = await sharp(foto).metadata();
    assert.deepEqual([antes.width, antes.height, antes.orientation, foto.includes('Pedro')], [16, 12, 6, true], 'a foto de teste');
    const jpg = await gravada(foto, 'image/jpeg');
    assert.ok(!jpg.includes('Pedro') && !jpg.includes('Exif'), 'o Exif saiu');
    const info = await sharp(jpg).metadata();
    assert.deepEqual([info.format, info.width, info.height, info.orientation, info.exif, info.icc, info.xmp],
      ['jpeg', 12, 16, undefined, undefined, undefined, undefined], 'pixels girados: 12×16, sem orientação nem metadados');
    // girar 90° no horário leva a coluna da esquerda para o alto: em pé, vermelho em cima e azul embaixo
    const { data, info: d } = await sharp(jpg).raw().toBuffer({ resolveWithObject: true });
    const cor = (x, y) => [...data.subarray((y * d.width + x) * 3, (y * d.width + x) * 3 + 3)].map((v) => (v > 128 ? 1 : 0));
    assert.deepEqual([cor(6, 3), cor(6, 12)], [[1, 0, 0], [0, 0, 1]], 'girou para o lado certo');

    const png = await sharp({ create: { width: 5, height: 4, channels: 4, background: '#ff8800cc' } }).png().toBuffer();
    const comTexto = Buffer.concat([png.subarray(0, 33), blocoPng('tEXt', 'Author\0Pedro da Silva'), png.subarray(33)]);
    const limpo = await gravada(comTexto, 'image/png');
    assert.ok(!limpo.includes('tEXt') && !limpo.includes('Pedro'), 'o tEXt saiu');
    assert.deepEqual(await sharp(limpo).raw().toBuffer(), await sharp(png).raw().toBuffer(), 'mesmos pixels');
  } finally { await s.fechar(); }
});

test('R16: foto que não dá para ler (JPEG com lixo antes do APP1 e sem EOI, começo de JPEG, PNG cortado) → 415 e nada gravado', async () => {
  const s = await subir();
  try {
    // começa com FF D8 FF (passa na conferência dos bytes iniciais), mas o que vem depois não é JPEG
    const lixo = Buffer.concat([JPG.subarray(0, 3), Buffer.from('lixo lixo'), app1Exif(6, 'iPhone de Pedro'), JPG.subarray(2, -2)]);
    for (const [corpo, tipo, nome] of [
      [lixo, 'image/jpeg', 'lixo antes do APP1, sem EOI'],
      [JPG.subarray(0, -2), 'image/jpeg', 'JPEG sem EOI'],
      [Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]), 'image/jpeg', 'começo de JPEG'],
      [PNG.subarray(0, 70), 'image/png', 'PNG cortado no IDAT'],
    ]) {
      const r = await s.upload(corpo, tipo);
      assert.deepEqual([r.status, r.json?.erro], [415, 'Não consegui ler esta foto.'], nome);
    }
    assert.equal(fs.existsSync(path.join(s.dir, 'uploads')), false, 'nada foi gravado (nem a pasta)');
  } finally { await s.fechar(); }
});

test('R16: PNG de 7000×7000 (49 megapixels em 6 KB) passa do limite de pixels → 415 sem decodificar', async (t) => {
  if (!(await sharpOuPula(t))) return; // sem o sharp nada é decodificado: não há bomba
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(7000, 0); ihdr.writeUInt32BE(7000, 4); ihdr[8] = 1; // cinza de 1 bit
  const pixels = zlib.deflateSync(Buffer.alloc(7000 * (1 + 875)), { level: 9 }); // por linha: filtro + 7000 bits, tudo zero
  const bomba = Buffer.concat([PNG.subarray(0, 8), blocoPng('IHDR', ihdr.toString('latin1')), blocoPng('IDAT', pixels.toString('latin1')), blocoPng('IEND', '')]);
  assert.ok(bomba.length < 10000, `${bomba.length} bytes`);
  const s = await subir();
  try {
    const t0 = Date.now();
    const r = await s.upload(bomba, 'image/png');
    assert.deepEqual([r.status, r.json?.erro], [415, 'Não consegui ler esta foto.']);
    assert.ok(Date.now() - t0 < 1000, 'recusou pelo cabeçalho');
    assert.equal(fs.existsSync(path.join(s.dir, 'uploads')), false);
  } finally { await s.fechar(); }
});

test('R16 (sem o sharp): o percurso manual recusa arquivo fora do formato, tira COM e o que vem depois do fim e mantém só a orientação', async () => {
  // JPEG com Exif (orientação 6 + texto), comentário e lixo depois do EOI: sai com um APP1 mínimo só com a orientação
  const comMeta = Buffer.concat([JPG.subarray(0, 2), app1Exif(6, 'iPhone de Pedro GPS -22.9'), segJpeg(0xfe, 'Pedro'), JPG.subarray(2), Buffer.from('Pedro')]);
  const minimo = Buffer.from('ffe10022457869660000' + '4d4d002a00000008' + '0001' + '011200030000000100060000' + '00000000', 'hex');
  assert.deepEqual(semMetadados(comMeta, 'jpg'), Buffer.concat([JPG.subarray(0, 2), minimo, JPG.subarray(2)]));
  assert.deepEqual(semMetadados(Buffer.concat([JPG.subarray(0, 2), app1Exif(1, 'Pedro'), JPG.subarray(2)]), 'jpg'), JPG, 'orientação 1: sem APP1');
  // falha fechada: lixo no lugar de um marcador, sem EOI, tamanho impossível, PNG sem IEND
  for (const [buf, ext, nome] of [
    [Buffer.concat([JPG.subarray(0, 2), Buffer.from('lixo'), JPG.subarray(2)]), 'jpg', 'lixo antes do primeiro segmento'],
    [JPG.subarray(0, -2), 'jpg', 'sem EOI'],
    [Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x01, 0, 0]), 'jpg', 'segmento maior que o arquivo'],
    [PNG.subarray(0, -12), 'png', 'PNG sem IEND'],
    [PNG.subarray(0, 70), 'png', 'PNG cortado no IDAT'],
  ]) assert.throws(() => semMetadados(buf, ext), /fora do formato/, nome);
  assert.deepEqual(semMetadados(Buffer.concat([PNG, Buffer.from('Pedro')]), 'png'), PNG, 'lixo depois do IEND sai');
});

test('R9: as fotos ficam na pasta da fila de envios (a que o envio lê), não no dataDir que o servidor recebeu', async () => {
  const outro = tmp();
  const s = await subir({ dataDir: outro });
  try {
    const up = await s.upload(PNG, 'image/png');
    assert.equal(up.status, 200, up.txt);
    assert.ok(fs.existsSync(path.join(s.dir, 'uploads', up.json.id)));
    assert.equal(fs.existsSync(path.join(outro, 'uploads')), false);
    assert.deepEqual((await s.get(`/api/uploads/${up.json.id}`)).buf, PNG);
    const e = await s.post('/api/envios', { tipo: 'mensagem', texto: 'Foto', imagem: 'upload', upload: up.json.id, group_jids: ['111@g.us'] });
    assert.equal(e.status, 200, e.txt);
    assert.equal(await terminar(s.db, e.json.id), 'concluido');
    assert.deepEqual(s.wa.simulated.at(-1).image, { bytes: PNG.length });
  } finally { await s.fechar(); }
});

test('upload sem sessão: corpo de mais de 5 MB dá 401 (o parser da foto só roda depois do login) e nada é gravado', async () => {
  const s = await subir();
  try {
    const grande = Buffer.alloc(6 * 1024 * 1024); JPG.copy(grande);
    const r = await req(s.port, '/api/uploads', { method: 'POST', raw: grande, headers: { 'content-type': 'image/jpeg', origin: `http://127.0.0.1:${s.port}` } });
    assert.equal(r.status, 401); assert.match(r.json.erro, /login/);
    assert.equal(fs.existsSync(path.join(s.dir, 'uploads')), false);
  } finally { await s.fechar(); }
});

test('Q6 (template): apagado e recriado com o mesmo id não sai com o template novo; editado e renomeado continua valendo', async (t) => {
  const s = await subir();
  try {
    const seg = (h, m = 0) => new Date(2026, 10, 2, h, m).getTime();
    const novo = async (name, body) => { const r = await s.post('/api/templates', { name, body }); assert.equal(r.status, 200, r.txt); return r.json.id; };
    const agendar = async (templateId) => {
      t.mock.timers.enable({ apis: ['Date'], now: seg(10, 0) });
      try { return await s.envios.criar({ tipo: 'oferta', url: URL_ML, tag_id: 1, template_id: templateId, group_jids: ['111@g.us'], quando: 'agendado', agendar_hhmm: '10:30' }); } finally { t.mock.timers.reset(); }
    };
    const velho = await novo('Velho', 'VELHO {TITULO_PRODUTO} {LINK}');
    const a = await agendar(velho);
    assert.equal((await s.req(`/api/templates/${velho}`, { method: 'DELETE' })).status, 200);
    assert.equal(await novo('Novo', 'NOVO {TITULO_PRODUTO} {LINK}'), velho, 'o SQLite reaproveitou o id');
    const editado = await novo('Antes', 'ANTES {TITULO_PRODUTO} {LINK}');
    const b = await agendar(editado);
    assert.equal((await s.req(`/api/templates/${editado}`, { method: 'PUT', body: { name: 'Depois', body: 'DEPOIS {TITULO_PRODUTO} {LINK}' } })).status, 200);

    await s.envios.processarPendentes(seg(10, 30) + 1000);
    assert.equal(statusDe(s.db, a.id), 'erro');
    assert.equal(s.db.prepare('SELECT erro FROM envio_resultados WHERE envio_id = ?').get(a.id).erro, 'o template foi apagado');
    assert.equal(statusDe(s.db, b.id), 'concluido');
    assert.equal(s.wa.simulated.length, 1);
    assert.match(s.wa.simulated[0].text, /^DEPOIS Fone Bom/, 'o envio usa o template como ele está agora');
    assert.ok(s.wa.simulated.every((x) => !/NOVO/.test(x.text)));
  } finally { await s.fechar(); }
});

// ---------------------------------------------------------------------------------------------
// Amazon no Disparo manual (plano espelhamento-amazon, etapa 8; CA2, CA6, CA7). A Amazon é o createAmazon de verdade com
// um fetch falso injetado (encurtador, token e GetItems); src/lojas.js é o real (etapa 7). A fila de envios do
// servidor é trocada por uma com o `amazon` (o server.js só passa a criar o cliente na etapa 13).
const ASIN = 'B0FG2MD49G';
const TAG = 'pedro-20';
const CRED_ID = 'credencial-id-0001';
const SEGREDO = 'segredo-super-secreto-123';
const TOKEN = 'token-oauth-secreto-xyz';
const IMG_AMAZON = 'https://m.media-amazon.com/images/I/71abcDEF.jpg';
const URL_CURTO = 'https://amzn.to/3AbCdEf';
const URL_LONGO = `https://www.amazon.com.br/Fone-Bluetooth-XYZ/dp/${ASIN}?tag=terceiro-20&crid=XYZ123&linkId=abc&ascsubtag=q`;
const URL_BUSCA = 'https://amzn.to/busca1';
// link.amazon → amzlinks.in → produto (cadeia real do bug do link.amazon/B0boeV5q0)
const URL_LINK_AMAZON = 'https://link.amazon/B0boeV5q0';
const URL_AMZLINKS = 'https://amzlinks.in/B0boeV5q0';
const ASIN_AMZLINKS = 'B0HJB1C68N';
const URL_LONGO_AMZLINKS = `https://www.amazon.com.br/Apple-iPhone-Pro-Max-256/dp/${ASIN_AMZLINKS}?__mk_pt_BR=%C3%85M&tag=desejodemen01-20&linkId=abc&ascsubtag=xyz&btn_ref=r1`;
const LINK_LIMPO = `https://www.amazon.com.br/dp/${ASIN}?tag=${TAG}`;
const SEGREDOS = [CRED_ID, SEGREDO, TOKEN];

const respJson = (status, corpo, headers = {}) => new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json', ...headers } });
const itemApi = (asin) => ({
  asin, detailPageURL: `https://www.amazon.com.br/dp/${asin}?tag=${TAG}&linkCode=ogi`,
  itemInfo: { title: { displayValue: 'Fone Bluetooth XYZ' } },
  images: { primary: { large: { url: IMG_AMAZON, height: 500, width: 500 } } },
  offersV2: { listings: [{ isBuyBoxWinner: true, availability: { type: 'IN_STOCK' }, price: { money: { amount: 99.9 }, savingBasis: { money: { amount: 199.9 } }, savings: { percentage: 50 } } }] },
});

/** fetch falso da Amazon: encurtador (301), token e GetItems. api: 'ok' | '403'. Guarda URL e método de cada chamada. */
function fetchAmazon(estado) {
  const chamadas = [];
  const f = async (url, init = {}) => {
    const u = String(url);
    chamadas.push({ url: u, metodo: init.method || 'GET' });
    if (u === URL_CURTO) return new Response(null, { status: 301, headers: { location: URL_LONGO } });
    if (u === URL_BUSCA) return new Response(null, { status: 302, headers: { location: 'https://www.amazon.com.br/s?k=fone' } });
    if (u === URL_LINK_AMAZON) return new Response(null, { status: 302, headers: { location: URL_AMZLINKS } });
    if (u === URL_AMZLINKS) return new Response(null, { status: 302, headers: { location: URL_LONGO_AMZLINKS } });
    if (u === 'https://www.amazon.com.br/s?k=fone') return new Response('<html>busca</html>', { status: 200 });
    if (u === 'https://api.amazon.com/auth/o2/token') return respJson(200, { access_token: TOKEN, token_type: 'bearer', expires_in: 3600 });
    if (u === 'https://creatorsapi.amazon/catalog/v1/getItems') {
      if (estado.api === '403') return respJson(403, { type: 'AccessDeniedException', reason: 'AssociateNotEligible', message: 'not eligible' });
      return respJson(200, { itemsResult: { items: JSON.parse(init.body).itemIds.map(estado.item || itemApi) } });
    }
    throw new Error('rede não prevista no teste');
  };
  f.chamadas = chamadas;
  return f;
}

/** Servidor com a Amazon: tag, credencial e API como pedido (o objeto `conexao` pode mudar no meio do teste). */
async function subirAmazon({ tag = TAG, credenciais = true, api = 'ok', ...opcoes } = {}) {
  const s = await subir(opcoes);
  const estado = { api };
  const fetchF = fetchAmazon(estado);
  const conexao = { tag, credencial_versao: '3.1', ...(credenciais ? { credencial_id: CRED_ID, credencial_secret: SEGREDO } : {}) };
  const amazon = createAmazon({ db: s.db, fetch: fetchF, esperar: async () => {}, lerConexao: () => conexao });
  s.scheduler.envios = createEnvios({ db: s.db, wa: s.wa, links: s.links, ml: s.ml, fast: true, dir: s.dir, amazon });
  return { ...s, envios: s.scheduler.envios, amazon, fetchF, estado, conexao };
}

/** Nenhum texto (resposta, log, console) traz a credencial, o segredo ou o token. */
function semSegredo(texto, onde) {
  for (const x of SEGREDOS) assert.ok(!String(texto).includes(x), `${onde}: vazou credencial/segredo/token`);
}

const OFERTA_API = { key: `ASIN:${ASIN}`, title: 'Fone Bluetooth XYZ', price: 99.9, oldPrice: 199.9, discountPct: 50, sold: null, freeShipping: false, coupon: null, image: IMG_AMAZON };
const OFERTA_VAZIA = { key: `ASIN:${ASIN}`, title: null, price: null, oldPrice: null, discountPct: null, sold: null, freeShipping: null, coupon: null, image: null };

test('CA6: identificar Amazon com link curto (amzn.to pelo fetch falso, só GET): produto da API, texto com link limpo e tag mascarada', async (t) => {
  const erros = t.mock.method(console, 'error', () => {});
  const s = await subirAmazon();
  try {
    const r = await s.post('/api/disparo/identificar', { url: `  ${URL_CURTO} `, template_id: 1, tag_id: 1 });
    assert.equal(r.status, 200, r.txt);
    const { texto, ...resto } = r.json;
    assert.deepEqual(resto, {
      loja: { id: 'amazon', nome: 'Amazon', implementada: true }, motivo: null, editavel: true, produto: OFERTA_API, causa: null,
      template_id: 1, etiqueta: null, tag_salva: true,
    });
    assert.match(texto, /^\*Fone Bluetooth XYZ\*/);
    assert.match(texto, /De ~R\$ 199,90~/); assert.match(texto, /Por \*R\$ 99,90\* \(50% OFF\)/);
    assert.ok(texto.endsWith(`Compre aqui: https://www.amazon.com.br/dp/${ASIN}?tag=•••`), texto);
    assert.ok(!texto.includes(TAG), 'CA7: a tag sai mascarada na prévia do painel');
    assert.doesNotMatch(texto, /terceiro|crid|linkId|ascsubtag|linkCode/);
    // o encurtador foi resolvido só com GET; depois token e GetItems, nos hosts fixos
    assert.deepEqual(s.fetchF.chamadas.map((c) => `${c.metodo} ${c.url}`), [
      `GET ${URL_CURTO}`, 'POST https://api.amazon.com/auth/o2/token', 'POST https://creatorsapi.amazon/catalog/v1/getItems',
    ]);
    semSegredo(r.txt, 'identificar');
    assert.equal(erros.mock.callCount(), 0);
  } finally { await s.fechar(); }
});

test('CA6: identificar Amazon com link.amazon que passa por amzlinks.in: reconhece o produto, sem causa "invalido", só GET e link limpo', async (t) => {
  const erros = t.mock.method(console, 'error', () => {});
  const s = await subirAmazon();
  try {
    const r = await s.post('/api/disparo/identificar', { url: URL_LINK_AMAZON, template_id: 1 });
    assert.equal(r.status, 200, r.txt);
    assert.equal(r.json.causa, null, `causa: ${r.json.causa}`);
    assert.equal(r.json.loja.id, 'amazon');
    assert.equal(r.json.produto.key, `ASIN:${ASIN_AMZLINKS}`);
    assert.equal(r.json.produto.title, 'Fone Bluetooth XYZ');
    assert.ok(r.json.texto.endsWith(`Compre aqui: https://www.amazon.com.br/dp/${ASIN_AMZLINKS}?tag=•••`), r.json.texto);
    assert.doesNotMatch(r.json.texto, /desejodemen|linkId|ascsubtag|btn_ref|__mk_pt_BR|amzlinks/);
    assert.deepEqual(s.fetchF.chamadas.map((c) => `${c.metodo} ${c.url}`), [
      `GET ${URL_LINK_AMAZON}`, `GET ${URL_AMZLINKS}`, 'POST https://api.amazon.com/auth/o2/token', 'POST https://creatorsapi.amazon/catalog/v1/getItems',
    ]);
    semSegredo(r.txt, 'identificar amzlinks');
    assert.equal(erros.mock.callCount(), 0);
  } finally { await s.fechar(); }
});

test('CA6: amzlinks.in colado no Disparo manual não é reconhecido como Amazon e não vai à rede', async () => {
  const s = await subirAmazon();
  try {
    const r = await s.post('/api/disparo/identificar', { url: URL_AMZLINKS, template_id: 1 });
    assert.equal(r.status, 400, r.txt);
    assert.equal(s.fetchF.chamadas.length, 0);
  } finally { await s.fechar(); }
});

test('CA6: identificar Amazon sem dados: API em 403 → campos nulos e causa sem_acesso; sem credencial; sem tag (sem rede); não é produto', async () => {
  const s = await subirAmazon({ api: '403' });
  try {
    const r = await s.post('/api/disparo/identificar', { url: URL_CURTO, template_id: 1 });
    assert.equal(r.status, 200, r.txt);
    assert.deepEqual([r.json.causa, r.json.editavel, r.json.tag_salva, r.json.produto], ['sem_acesso', true, true, OFERTA_VAZIA]);
    assert.ok(r.json.texto.includes(`https://www.amazon.com.br/dp/${ASIN}?tag=•••`), 'o link já foi resolvido e leva a tag');
    assert.doesNotMatch(r.json.texto, /De ~|Por \*/, 'sem preço, as linhas de preço somem: nada é inventado');
    semSegredo(r.txt, 'identificar 403');
    assert.equal(s.amazon.situacao().acesso, 'sem_acesso');

    // sem credencial: a API nem é chamada (só o encurtador já resolvido no cache)
    delete s.conexao.credencial_id; delete s.conexao.credencial_secret;
    const antes = s.fetchF.chamadas.length;
    const semCred = await s.post('/api/disparo/identificar', { url: `https://www.amazon.com.br/dp/${ASIN}`, template_id: 1 });
    assert.deepEqual([semCred.json.causa, semCred.json.produto], ['sem_credenciais', OFERTA_VAZIA]);
    assert.equal(s.fetchF.chamadas.length, antes, 'sem credencial: nenhuma chamada de rede');

    // sem tag: causa sem_tag sem resolver o link nem consultar a API
    s.conexao.tag = '';
    const semTag = await s.post('/api/disparo/identificar', { url: 'https://amzn.to/outroLink', template_id: 1 });
    assert.equal(semTag.status, 200);
    assert.deepEqual(semTag.json, {
      loja: { id: 'amazon', nome: 'Amazon', implementada: true }, motivo: null, editavel: true, produto: null, causa: 'sem_tag',
      texto: null, template_id: 1, etiqueta: null, tag_salva: false,
    });
    assert.equal(s.fetchF.chamadas.length, antes, 'sem tag: nenhuma chamada de rede');

    // link que chega a uma busca (não é produto) e link de host da Amazon que não leva a lugar nenhum
    s.conexao.tag = TAG; s.estado.api = 'ok';
    const busca = await s.post('/api/disparo/identificar', { url: URL_BUSCA, template_id: 1 });
    assert.deepEqual([busca.status, busca.json.causa, busca.json.produto, busca.json.texto], [200, 'nao_produto', null, null]);
    const invalido = await s.post('/api/disparo/identificar', { url: 'https://amzn.to/naoexiste', template_id: 1 });
    assert.deepEqual([invalido.status, invalido.json.causa, invalido.json.produto], [200, 'invalido', null]);
    for (const [corpo, erro] of [
      [{ url: 'https://amazon.com.br.evil.com/dp/B0FG2MD49G' }, /Não reconheci este link/],
      [{ url: URL_CURTO, template_id: 999 }, /Template não encontrado/],
    ]) {
      const e = await s.post('/api/disparo/identificar', corpo);
      assert.equal(e.status, 400, JSON.stringify(corpo)); assert.match(e.json.erro, erro);
    }
  } finally { await s.fechar(); }
});

test('CA6/CA2: oferta da Amazon "agora" com ajustes: imagem da API com legenda ajustada e link .../dp/<ASIN>?tag= em cada grupo', async (t) => {
  const erros = t.mock.method(console, 'error', () => {});
  const s = await subirAmazon();
  try {
    s.links.modo = () => 'extension'; // a Amazon não usa a extensão do Chrome: offline não impede
    const r = await s.post('/api/envios', {
      tipo: 'oferta', url: URL_CURTO, template_id: 1, tag_id: 99, group_jids: ['111@g.us', '222@g.us'], quando: 'agora',
      ajustes: {
        title: '  Fone   Ajustado\nPro ', price: '79,90', oldPrice: '159,80', coupon: 'DESC10', freeShipping: true,
        image: 'https://evil.example/x.jpg', link: 'https://evil.example/link', url: 'https://evil.example', // ignorados
      },
      offer: { title: 'Do navegador', image: 'https://evil.example/y.jpg' }, // ignorado
    });
    assert.equal(r.status, 200, r.txt);
    assert.equal(await terminar(s.db, r.json.id), 'concluido');
    assert.equal(s.wa.simulated.length, 2);
    for (const [i, jid] of ['111@g.us', '222@g.us'].entries()) {
      const msg = s.wa.simulated[i];
      assert.deepEqual([msg.tipo, msg.jid, msg.image], ['image', jid, IMG_AMAZON], 'foto pela URL que a API devolveu');
      assert.match(msg.text, /^\*Fone Ajustado Pro\*/);
      assert.match(msg.text, /De ~R\$ 159,80~/); assert.match(msg.text, /Por \*R\$ 79,90\* \(50% OFF\)/);
      assert.match(msg.text, /Frete grátis/); assert.match(msg.text, /Cupom: \*DESC10\*/);
      assert.ok(msg.text.endsWith(`Compre aqui: ${LINK_LIMPO}`), msg.text);
      assert.doesNotMatch(msg.text, /evil|terceiro|crid|linkId|ascsubtag|linkCode|navegador/);
    }
    const payload = JSON.parse(s.db.prepare('SELECT payload FROM envios WHERE id = ?').get(r.json.id).payload);
    assert.deepEqual(payload, {
      url: URL_CURTO, loja: 'amazon', tag_id: null, etiqueta: null, template_id: 1, template_criado_em: payload.template_criado_em,
      origem: { tipo: 'manual' }, asin: ASIN, fonte_dados: 'manual',
      offer: { key: `ASIN:${ASIN}`, title: 'Fone Ajustado Pro', price: 79.9, oldPrice: 159.8, discountPct: 50, sold: null, freeShipping: true, coupon: 'DESC10', image: IMG_AMAZON },
    });
    assert.deepEqual(linhas(s.db, "SELECT rule_name, level, group_name, offer_title, message FROM log ORDER BY id"), [
      { rule_name: 'Disparo manual', level: 'ok', group_name: 'Achadinhos', offer_title: 'Fone Ajustado Pro', message: 'Enviado com a tag de associado da Amazon' },
      { rule_name: 'Disparo manual', level: 'ok', group_name: 'Tech', offer_title: 'Fone Ajustado Pro', message: 'Enviado com a tag de associado da Amazon' },
    ]);
    const p = await s.get('/api/envios?tipo=oferta');
    assert.deepEqual(p.json.linhas.map((l) => [l.titulo, l.loja, l.status]), [['Fone Ajustado Pro', 'Amazon', 'enviado'], ['Fone Ajustado Pro', 'Amazon', 'enviado']]);
    for (const [onde, txt] of [['POST', r.txt], ['GET', p.txt], ['log', JSON.stringify(linhas(s.db, 'SELECT * FROM log'))], ['envios', JSON.stringify(linhas(s.db, 'SELECT * FROM envios'))]]) semSegredo(txt, onde);
    assert.equal(erros.mock.callCount(), 0);

    // sem ajustes: sai como a API mandou (fonte 'api'); preço antigo menor que o atual não vira linha "De"
    s.wa.simulated.length = 0;
    const api = await s.post('/api/envios', { tipo: 'oferta', url: `https://www.amazon.com.br/dp/${ASIN}`, template_id: 1, group_jids: ['111@g.us'] });
    assert.equal(await terminar(s.db, api.json.id), 'concluido');
    assert.match(s.wa.simulated[0].text, /^\*Fone Bluetooth XYZ\*/); assert.match(s.wa.simulated[0].text, /Por \*R\$ 99,90\* \(50% OFF\)/);
    assert.equal(JSON.parse(s.db.prepare('SELECT payload FROM envios WHERE id = ?').get(api.json.id).payload).fonte_dados, 'api');
    s.wa.simulated.length = 0;
    const menor = await s.post('/api/envios', { tipo: 'oferta', url: URL_CURTO, template_id: 1, group_jids: ['111@g.us'], ajustes: { price: 120, oldPrice: '99,00' } });
    assert.equal(await terminar(s.db, menor.json.id), 'concluido');
    assert.doesNotMatch(s.wa.simulated[0].text, /De ~|OFF/, 'preço antigo menor ou igual ao atual some');
    assert.match(s.wa.simulated[0].text, /Por \*R\$ 120,00\*/);
    const { offer } = JSON.parse(s.db.prepare('SELECT payload FROM envios WHERE id = ?').get(menor.json.id).payload);
    assert.deepEqual([offer.price, offer.oldPrice, offer.discountPct], [120, null, 0], 'o payload não guarda preço antigo inválido');
  } finally { await s.fechar(); }
});

// R5: a API pode trazer só savings.percentage (sem savingBasis). O desconto da API vale enquanto os preços são os da API;
// mexeu num preço, recalcula. O painel (dadosOferta em public/disparos.js) faz a mesma conta, e o teste abaixo confere.
test('R5: Amazon só com percentual da API (sem preço antigo): o desconto da API fica enquanto os preços não mudam e recalcula quando mudam', async () => {
  const s = await subirAmazon();
  s.estado.item = (asin) => ({
    asin, itemInfo: { title: { displayValue: 'Fone Bluetooth XYZ' } }, images: { primary: { large: { url: IMG_AMAZON } } },
    offersV2: { listings: [{ isBuyBoxWinner: true, price: { money: { amount: 80 }, savings: { percentage: 20 } } }] },
  });
  try {
    const mandar = async (ajustes) => {
      s.wa.simulated.length = 0;
      const r = await s.post('/api/envios', { tipo: 'oferta', url: URL_CURTO, template_id: 1, group_jids: ['111@g.us'], ...(ajustes ? { ajustes } : {}) });
      assert.equal(r.status, 200, r.txt);
      assert.equal(await terminar(s.db, r.json.id), 'concluido');
      const { offer, fonte_dados } = JSON.parse(s.db.prepare('SELECT payload FROM envios WHERE id = ?').get(r.json.id).payload);
      return { offer, fonte_dados, texto: s.wa.simulated[0].text };
    };
    const sem = await mandar(null);
    assert.deepEqual([sem.offer.price, sem.offer.oldPrice, sem.offer.discountPct, sem.fonte_dados], [80, null, 20, 'api']);
    assert.match(sem.texto, /\(20% OFF\)/);
    // o painel manda os mesmos preços (e o título que já estava): nada mudou, o desconto da API continua
    const igual = await mandar({ title: 'Fone Bluetooth XYZ', price: 80, oldPrice: null, coupon: null, freeShipping: false });
    assert.equal(igual.offer.discountPct, 20); assert.match(igual.texto, /\(20% OFF\)/); assert.equal(igual.fonte_dados, 'api');
    // só o cupom mudou: preços intactos, desconto da API
    const cupom = await mandar({ coupon: 'DESC10' });
    assert.equal(cupom.offer.discountPct, 20); assert.equal(cupom.fonte_dados, 'manual');
    // preço mexido: recalcula (sem preço antigo, não há desconto)
    const preco = await mandar({ price: '70,00' });
    assert.equal(preco.offer.discountPct, 0); assert.doesNotMatch(preco.texto, /OFF/);
    // com os dois preços, o desconto sai da conta
    const dois = await mandar({ price: 80, oldPrice: 100 });
    assert.equal(dois.offer.discountPct, 20);
  } finally { await s.fechar(); }
});

/** Carrega public/disparos.js num vm com o mínimo de DOM e devolve `dadosOferta` (o painel). Nada de rede. */
function carregarDadosOferta() {
  const campo = () => ({ value: '', checked: false, oninput: null, onchange: null, onclick: null, focus() {}, setAttribute() {}, getAttribute: () => null });
  const falso = () => ({ hidden: false, textContent: '', className: '', src: '', ...campo(), getAttribute: () => null });
  const ctx = {
    console, setTimeout, clearTimeout, Number, String, Math, Date, JSON, Array, Object, RegExp, URL, Intl, Promise, Symbol, Error, Set, Map,
    document: { createElement: () => { const campos = new Map(); return { dataset: {}, set innerHTML(v) {}, elements: { namedItem: (n) => { if (!campos.has(n)) campos.set(n, campo()); return campos.get(n); } } }; }, getElementById: () => null, activeElement: null, body: falso() },
    $: () => falso(), $$: () => [], esc: (x) => String(x), zap: (x) => String(x), REQ: '*', S: { templates: [], tags: [], groups: [], st: {} },
    seletorGrupos: () => ({ html: '', ligar() {}, marcados: () => [] }), aviso() {}, mostrarErros() {}, opcoes: () => '', q: () => '',
    location: { hash: '' }, confirm: () => true, FileReader: class {}, fetch: async () => { throw new Error('rede proibida no teste'); },
  };
  vm.createContext(ctx);
  vm.runInContext(`${fs.readFileSync(new URL('../public/disparos.js', import.meta.url), 'utf8')}\n;globalThis.__x = { dadosOferta };`, ctx);
  return ctx.__x.dadosOferta;
}

test('R5 (painel): o desconto da API fica enquanto os preços são os da API e recalcula quando o dono mexe num preço', () => {
  const dadosOferta = carregarDadosOferta();
  const dados = dadosOferta({ title: 'Fone', price: 80, oldPrice: null, discountPct: 20 });
  const campo = (n) => dados.el.elements.namedItem(n);
  const digitar = (n, v) => { campo(n).value = v; campo(n).oninput(); };
  assert.equal(dados.valores().discountPct, 20, 'como a prévia do servidor');
  assert.equal(campo('desconto').value, '20%');
  digitar('title', 'Fone melhor'); assert.equal(dados.valores().discountPct, 20, 'título não muda o desconto');
  digitar('price', '70,00'); assert.equal(dados.valores().discountPct, 0, 'preço mexido: recalcula (sem preço antigo)');
  assert.equal(campo('desconto').value, '—');
  digitar('price', '80,00'); assert.equal(dados.valores().discountPct, 20, 'voltou ao preço da API');
  digitar('oldPrice', '100,00'); assert.equal(dados.valores().discountPct, 20, 'preço antigo novo: conta 80/100');
  digitar('oldPrice', '160'); assert.equal(dados.valores().discountPct, 50);
  dados.definir({ price: 50, oldPrice: 100, discountPct: 49 }); // o percentual da API pode diferir do arredondamento
  assert.equal(dados.valores().discountPct, 49);
  dados.definir({ price: 50, oldPrice: 100 }); assert.equal(dados.valores().discountPct, 50, 'sem percentual da API: a conta');
  dados.definir({ price: 50, oldPrice: 100, discountPct: 150 }); assert.equal(dados.valores().discountPct, 50, 'percentual absurdo: a conta');
  dados.definir({}); assert.equal(dados.valores().discountPct, 0);
});

test('CA6: Amazon com a API em 403: o dono preenche e a oferta sai só com texto; sem título, é recusada', async () => {
  const s = await subirAmazon({ api: '403' });
  try {
    const semTitulo = await s.post('/api/envios', { tipo: 'oferta', url: URL_CURTO, template_id: 1, group_jids: ['111@g.us'], ajustes: { price: '50' } });
    assert.equal(semTitulo.status, 400); assert.equal(semTitulo.json.erro, 'Não consegui buscar os dados na Amazon: preencha o título do produto.');
    assert.equal(contar(s.db, 'SELECT COUNT(*) AS n FROM envios'), 0);
    const r = await s.post('/api/envios', { tipo: 'oferta', url: URL_CURTO, template_id: 1, group_jids: ['111@g.us'], ajustes: { title: 'Fone à mão', price: '1.299,90' } });
    assert.equal(r.status, 200, r.txt);
    assert.equal(await terminar(s.db, r.json.id), 'concluido');
    const [msg] = s.wa.simulated;
    assert.equal(msg.tipo, 'text', 'sem foto da API, só texto');
    assert.match(msg.text, /^\*Fone à mão\*/); assert.match(msg.text, /Por \*R\$ 1\.299,90\*$/m);
    assert.ok(msg.text.endsWith(`Compre aqui: ${LINK_LIMPO}`));
    assert.equal(JSON.parse(s.db.prepare('SELECT payload FROM envios WHERE id = ?').get(r.json.id).payload).fonte_dados, 'manual');
  } finally { await s.fechar(); }
});

test('CA6: Amazon com foto trocada (upload) manda o Buffer com o tipo; "sem foto" manda só texto; a foto da oferta ativa não é apagada', async () => {
  const s = await subirAmazon();
  try {
    const up = await s.upload(PNG, 'image/png');
    assert.equal(up.status, 200, up.txt);
    const r = await s.post('/api/envios', { tipo: 'oferta', url: URL_CURTO, template_id: 1, group_jids: ['111@g.us'], ajustes: { upload: up.json.id } });
    assert.equal(r.status, 200, r.txt);
    assert.equal(await terminar(s.db, r.json.id), 'concluido');
    assert.deepEqual(s.wa.simulated[0], { tipo: 'image', jid: '111@g.us', text: s.wa.simulated[0].text, image: { bytes: PNG.length }, mimetype: 'image/png' });
    assert.ok(s.wa.simulated[0].text.endsWith(`Compre aqui: ${LINK_LIMPO}`));
    const payload = JSON.parse(s.db.prepare('SELECT payload FROM envios WHERE id = ?').get(r.json.id).payload);
    assert.deepEqual([payload.upload, payload.fonte_dados, payload.offer.image], [up.json.id, 'manual', IMG_AMAZON]);

    const sem = await s.post('/api/envios', { tipo: 'oferta', url: URL_CURTO, template_id: 1, group_jids: ['111@g.us'], ajustes: { sem_foto: true } });
    assert.equal(await terminar(s.db, sem.json.id), 'concluido');
    assert.equal(s.wa.simulated[1].tipo, 'text');
    assert.equal(JSON.parse(s.db.prepare('SELECT payload FROM envios WHERE id = ?').get(sem.json.id).payload).offer.image, null);

    // limpeza: foto de oferta da Amazon ainda pendente fica, mesmo velha; sem envio ativo, sai
    const velha = Date.now() - 8 * DIA;
    fs.utimesSync(path.join(s.dir, 'uploads', up.json.id), velha / 1000, velha / 1000);
    s.db.prepare("UPDATE envios SET status = 'pendente', next_run_at = ? WHERE id = ?").run(Date.now() + 3600000, r.json.id);
    s.db.prepare('UPDATE envios SET last_run_at = ? WHERE id = ?').run(velha, r.json.id);
    assert.equal((await s.envios.limpar(0)).fotos, 0, 'em uso por uma oferta pendente');
    s.db.prepare("UPDATE envios SET status = 'concluido' WHERE id = ?").run(r.json.id);
    assert.equal((await s.envios.limpar(0)).fotos, 1);
  } finally { await s.fechar(); }
});

test('CA6: oferta da Amazon agendada para hoje fica pendente e sai no horário com a tag que está em Conexões na hora', async (t) => {
  const alvo = Date.now() + 3 * 60000;
  if (new Date(alvo).toDateString() !== new Date().toDateString()) { t.skip('perto da meia-noite: o disparo manual só agenda para hoje'); return; }
  const T = new Date(alvo).setSeconds(0, 0);
  const s = await subirAmazon();
  try {
    const r = await s.post('/api/envios', { tipo: 'oferta', url: URL_CURTO, template_id: 1, group_jids: ['111@g.us'], quando: 'agendado', agendar_hhmm: hhmmDe(alvo), ajustes: { coupon: 'HOJE5' } });
    assert.equal(r.status, 200, r.txt);
    assert.deepEqual([r.json.status, r.json.next_run_at], ['pendente', T]);
    assert.equal(await s.envios.processarPendentes(T - 1000), 0, 'antes do horário não sai');
    assert.equal(s.wa.simulated.length, 0);
    const p = (await s.get('/api/envios?tipo=oferta')).json;
    assert.deepEqual(p.agendadas.map((a) => [a.id, a.titulo, a.loja, a.status]), [[r.json.id, 'Fone Bluetooth XYZ', 'Amazon', 'pendente']]);

    s.conexao.tag = 'nova-tag-20'; // o link é montado na hora do envio
    assert.equal(await s.envios.processarPendentes(T + 1000), 1);
    assert.equal(statusDe(s.db, r.json.id), 'concluido');
    assert.match(s.wa.simulated[0].text, /Cupom: \*HOJE5\*/);
    assert.ok(s.wa.simulated[0].text.endsWith(`Compre aqui: https://www.amazon.com.br/dp/${ASIN}?tag=nova-tag-20`));

    // tag apagada depois de agendar: não sai sem tag (CA2), erro no grupo e no log
    const r2 = await s.post('/api/envios', { tipo: 'oferta', url: URL_CURTO, template_id: 1, group_jids: ['111@g.us'], quando: 'agendado', agendar_hhmm: hhmmDe(alvo) });
    s.conexao.tag = '';
    await s.envios.processarPendentes(T + 1000);
    assert.equal(statusDe(s.db, r2.json.id), 'erro');
    assert.equal(s.wa.simulated.length, 1);
    assert.match(s.db.prepare('SELECT erro FROM envio_resultados WHERE envio_id = ?').get(r2.json.id).erro, /^link de afiliado não gerado: Falta a tag de associado/);
  } finally { await s.fechar(); }
});

test('Amazon: ajustes validados antes de qualquer rede (nunca image/link do navegador); sem tag e link sem produto são recusados', async () => {
  const s = await subirAmazon();
  try {
    const g = ['111@g.us'];
    const oferta = (ajustes, extra = {}) => ({ tipo: 'oferta', url: URL_CURTO, template_id: 1, group_jids: g, ajustes, ...extra });
    const casos = [
      [oferta('x'), /Dados da oferta inválidos/],
      [oferta([1]), /Dados da oferta inválidos/],
      [oferta({ title: 'a'.repeat(201) }), /título passa de 200 caracteres/],
      [oferta({ title: 12 }), /título precisa ser texto/],
      [oferta({ price: 'abc' }), /Preço atual inválido/],
      [oferta({ price: -1 }), /Preço atual inválido/],
      [oferta({ price: 0 }), /Preço atual inválido/],
      [oferta({ price: '89,999' }), /Preço atual inválido/],
      [oferta({ price: 1e9 }), /Preço atual inválido/],
      [oferta({ oldPrice: '1,2,3' }), /Preço antigo inválido/],
      [oferta({ oldPrice: true }), /Preço antigo inválido/],
      [oferta({ coupon: 'C'.repeat(31) }), /cupom passa de 30 caracteres/],
      [oferta({ freeShipping: 'sim' }), /Frete grátis/],
      [oferta({ sem_foto: 'sim' }), /Foto: envie com ou sem foto/],
      [oferta({ upload: '../../disparador.db' }), /Escolha a foto de novo/],
      [oferta({ upload: `${'a'.repeat(32)}.png` }), /A foto não foi encontrada/],
      [oferta({}, { group_jids: [] }), /ao menos um grupo/],
      [oferta({}, { quando: 'repetir', repetir: { dias: TODOS, horarios: ['09:00'] } }), /agora ou agendado para hoje/],
    ];
    for (const [corpo, erro] of casos) {
      const r = await s.post('/api/envios', corpo);
      assert.equal(r.status, 400, JSON.stringify(corpo).slice(0, 120)); assert.match(r.json.erro, erro, JSON.stringify(corpo).slice(0, 120));
    }
    assert.equal(s.fetchF.chamadas.length, 0, 'nada foi à rede com o corpo inválido');

    const up = (await s.upload(PNG, 'image/png')).json.id;
    const ambos = await s.post('/api/envios', oferta({ upload: up, sem_foto: true }));
    assert.match(ambos.json.erro, /Escolha entre trocar a foto e enviar sem foto/);

    const busca = await s.post('/api/envios', oferta({}, { url: URL_BUSCA }));
    assert.deepEqual([busca.status, busca.json.erro], [400, 'Este link da Amazon não leva a um produto.']);
    const fora = await s.post('/api/envios', oferta({}, { url: 'https://amzn.to/naoexiste' }));
    assert.deepEqual([fora.status, fora.json.erro], [400, 'Não consegui abrir este link da Amazon.']);

    s.conexao.tag = '';
    const antes = s.fetchF.chamadas.length;
    const semTag = await s.post('/api/envios', oferta({ title: 'X' }));
    assert.deepEqual([semTag.status, semTag.json.erro], [400, 'Falta a tag de associado da Amazon. Cadastre em Conexões → Amazon antes de disparar.']);
    assert.equal(s.fetchF.chamadas.length, antes, 'sem tag: nem resolve o link');

    assert.equal(contar(s.db, 'SELECT COUNT(*) AS n FROM envios'), 0, 'nada gravado');
    assert.equal(s.wa.simulated.length, 0);
  } finally { await s.fechar(); }
});

test('Amazon sem o cliente da Amazon na fila (servidor antes da ligação): oferta e identificar recusam sem gravar', async () => {
  const s = await subir();
  try {
    const r = await s.post('/api/envios', { tipo: 'oferta', url: URL_AMAZON, template_id: 1, group_jids: ['111@g.us'] });
    assert.deepEqual([r.status, r.json.erro], [400, 'A integração com a Amazon não está disponível neste servidor.']);
    const id = await s.post('/api/disparo/identificar', { url: URL_AMAZON });
    assert.deepEqual([id.status, id.json.erro], [400, 'A integração com a Amazon não está disponível neste servidor.']);
    assert.equal(contar(s.db, 'SELECT COUNT(*) AS n FROM envios'), 0);
  } finally { await s.fechar(); }
});

test('ML continua igual: exige etiqueta (nenhuma cadastrada → recusa), ignora `ajustes` e o identificar diz editavel:false', async () => {
  const s = await subirAmazon();
  try {
    s.links.poll(0);
    const ok = await s.post('/api/envios', { tipo: 'oferta', url: URL_ML, tag_id: 1, template_id: 1, group_jids: ['111@g.us'], ajustes: { title: 'Do navegador', price: 1, upload: 'x' } });
    assert.equal(ok.status, 200, ok.txt);
    assert.equal(await terminar(s.db, ok.json.id), 'concluido');
    assert.match(s.wa.simulated[0].text, /^\*Fone Bom\*/); assert.match(s.wa.simulated[0].text, /meli\.la\/fake-etiquetaA-/);
    assert.equal(s.wa.simulated[0].image, IMG);
    const payload = JSON.parse(s.db.prepare('SELECT payload FROM envios WHERE id = ?').get(ok.json.id).payload);
    assert.deepEqual([payload.loja, payload.tag_id, payload.etiqueta, payload.offer.title, payload.asin, payload.fonte_dados], ['mercadolivre', 1, 'etiquetaA', 'Fone Bom', undefined, undefined]);
    const ident = await s.post('/api/disparo/identificar', { url: URL_ML });
    assert.deepEqual([ident.json.editavel, ident.json.causa, ident.json.etiqueta], [false, null, { id: 1, name: 'etiquetaA' }]);

    s.db.exec('DELETE FROM tags');
    const sem = await s.post('/api/envios', { tipo: 'oferta', url: URL_ML, template_id: 1, group_jids: ['111@g.us'] });
    assert.deepEqual([sem.status, sem.json.erro], [400, 'Cadastre uma etiqueta antes de disparar (Conexões → Mercado Livre).']);
    assert.equal(s.fetchF.chamadas.length, 0, 'o Mercado Livre não fala com a Amazon');
  } finally { await s.fechar(); }
});

test('log: envio que veio de um espelho aparece como "Espelho: <nome>", com o nome do grupo e o título', async () => {
  const s = await subirAmazon();
  try {
    const tpl = s.db.prepare('SELECT created_at FROM templates WHERE id = 1').get().created_at;
    const payload = {
      url: URL_CURTO, loja: 'amazon', asin: ASIN, tag_id: null, etiqueta: null, template_id: 1, template_criado_em: tpl, fonte_dados: 'texto',
      origem: { tipo: 'espelho', espelho_id: 3, nome: 'Eletrônicos  do grupo X' }, offer: { ...OFERTA_API, image: 'https://evil.example/z.jpg' },
    };
    const id = Number(s.db.prepare(`INSERT INTO envios (tipo, payload, group_jids, quando, status, next_run_at, created_at)
      VALUES ('oferta', ?, ?, 'agora', 'pendente', ?, ?)`).run(JSON.stringify(payload), JSON.stringify(['222@g.us']), Date.now(), Date.now()).lastInsertRowid);
    await s.envios.runEnvio(id);
    assert.equal(statusDe(s.db, id), 'concluido');
    assert.equal(s.wa.simulated[0].tipo, 'text', 'foto fora do CDN da Amazon não é baixada');
    assert.ok(s.wa.simulated[0].text.endsWith(`Compre aqui: ${LINK_LIMPO}`));
    assert.deepEqual(linhas(s.db, 'SELECT rule_id, rule_name, group_name, offer_title, message FROM log'),
      [{ rule_id: null, rule_name: 'Espelho: Eletrônicos do grupo X', group_name: 'Tech', offer_title: 'Fone Bluetooth XYZ', message: 'Enviado com a tag de associado da Amazon' }]);

    // payload sem ASIN válido: não resolve link na hora do envio (sem rede), vira erro
    const semAsin = Number(s.db.prepare(`INSERT INTO envios (tipo, payload, group_jids, quando, status, next_run_at, created_at)
      VALUES ('oferta', ?, ?, 'agora', 'pendente', ?, ?)`).run(JSON.stringify({ ...payload, asin: 'undefined' }), JSON.stringify(['222@g.us']), Date.now(), Date.now()).lastInsertRowid);
    await s.envios.runEnvio(semAsin);
    assert.equal(statusDe(s.db, semAsin), 'erro');
    assert.equal(s.db.prepare('SELECT erro FROM envio_resultados WHERE envio_id = ?').get(semAsin).erro, 'link de afiliado não gerado: o produto da Amazon está sem ASIN');
    assert.equal(s.fetchF.chamadas.length, 0, 'nenhuma rede no envio');
  } finally { await s.fechar(); }
});

test('catálogo (fonte-catalogo-etiqueta, etapa 2): log como "Catálogo: <regra>"; ML do catálogo nunca sai em modo direto, o Disparo manual sai', async () => {
  const m = montar();
  const estado = { modo: 'fake' };
  const envios = createEnvios({ db: m.db, wa: m.wa, links: createLinkService({ getMode: () => estado.modo }), ml: m.ml, fast: true, dir: m.dir });
  const tpl = m.db.prepare('SELECT created_at FROM templates WHERE id = 1').get().created_at;
  const base = {
    url: 'https://produto.mercadolivre.com.br/MLB-1234567890', loja: 'mercadolivre', tag_id: 1, etiqueta: 'etiquetaA', template_id: 1, template_criado_em: tpl,
    fonte_dados: 'manual', offer: { key: 'MLB1234567890', title: 'Fone Bom', price: 89.9, oldPrice: null, discountPct: null, sold: null, freeShipping: true, coupon: null, image: null },
  };
  const gravar = (payload) => Number(m.db.prepare(`INSERT INTO envios (tipo, payload, group_jids, quando, status, next_run_at, created_at)
    VALUES ('oferta', ?, ?, 'agora', 'pendente', ?, ?)`).run(JSON.stringify(payload), JSON.stringify(['222@g.us']), Date.now(), Date.now()).lastInsertRowid);
  const doCatalogo = { ...base, origem: { tipo: 'catalogo', rule_id: 4, nome: ' Perfumes \n do catálogo ' } };
  try {
    const ok = gravar(doCatalogo);
    await envios.runEnvio(ok);
    assert.equal(statusDe(m.db, ok), 'concluido');
    assert.match(m.wa.simulated[0].text, /Compre aqui: https:\/\/meli\.la\/fake-etiquetaA-\d+$/);
    assert.deepEqual(linhas(m.db, 'SELECT rule_id, rule_name, group_name, offer_title, message FROM log'),
      [{ rule_id: null, rule_name: 'Catálogo: Perfumes do catálogo', group_name: 'Tech', offer_title: 'Fone Bom', message: 'Enviado com a etiqueta etiquetaA' }]);

    // modo direto (link comum, sem comissão): o do catálogo vira erro sem enviar; o do Disparo manual segue como sempre
    estado.modo = 'direct';
    const recusado = gravar(doCatalogo);
    await envios.runEnvio(recusado);
    assert.equal(statusDe(m.db, recusado), 'erro');
    assert.equal(m.db.prepare('SELECT erro FROM envio_resultados WHERE envio_id = ?').get(recusado).erro,
      'link de afiliado não gerado: os links do Mercado Livre estão no modo direto (sem comissão)');
    assert.equal(m.wa.simulated.length, 1, 'nada saiu');
    const manual = gravar({ ...base, origem: { tipo: 'manual' } });
    await envios.runEnvio(manual);
    assert.equal(statusDe(m.db, manual), 'concluido');
    assert.ok(m.wa.simulated[1].text.endsWith('Compre aqui: https://produto.mercadolivre.com.br/MLB-1234567890'));
    assert.equal(m.db.prepare('SELECT rule_name FROM log ORDER BY id DESC').get().rule_name, 'Disparo manual');
  } finally { m.db.close(); }
});

// ---------------------------------------------------------------------------------------------
// Shopee no Disparo manual (plano integracao-shopee, etapa 7; CA2, CA3, CA4, CA9). A Shopee é o createShopee de verdade
// com um fetch falso injetado (encurtador e Open API) e lê a conexão do banco (linha 'shopee' de `conexoes`, a mesma que
// a fila de envios lê para o ID de afiliado). O serviço de links é um próprio, em 'extension' (o teste faz o papel da
// extensão com poll/submit) ou 'fake'. A fila de envios do servidor é trocada por uma com o `shopee` (a ligação no
// server.js é a etapa 8).
const ID_AF = '98765432101';
const APP_ID_SHOPEE = '123456789';
const CHAVE_SHOPEE = 'Senha-Api-SECRETA-q1w2e3';
const SHOP = '52377417';
const ITEM = '6309028319';
const URL_PRODUTO_SHOPEE = `https://shopee.com.br/Fone-Bom-Sem-Fio-i.${SHOP}.${ITEM}`;
const URL_CURTO_SHOPEE = 'https://s.shopee.com.br/9fMB7wrS3r';
const URL_BUSCA_SHOPEE = 'https://shp.ee/busca1';
const IMG_SHOPEE = 'https://down-br.img.susercontent.com/file/br-11134207-7r98o-abc123';
const LINK_API = 'https://s.shopee.com.br/ApiLink123';
const LINK_EXT = 'https://s.shopee.com.br/ExtLink456';
const LONGO_DONO = `https://shopee.com.br/product/${SHOP}/${ITEM}?utm_source=an_${ID_AF}&utm_medium=affiliates&utm_term=xyz`;
const LINK_EXEMPLO_SHOPEE = 'https://s.shopee.com.br/(gerado ao disparar)';
const CONEXAO_SHOPEE = { id_afiliado: ID_AF, app_id: APP_ID_SHOPEE, chave: CHAVE_SHOPEE };

const noShopee = (extra = {}) => ({
  itemId: Number(ITEM), productName: 'Fone Bom Sem Fio', priceMin: '89.90', priceMax: '99.90', priceDiscountRate: 15,
  sales: 1234, ratingStar: '4.83', imageUrl: IMG_SHOPEE, shopName: 'Loja Oficial', ...extra,
});
const OFERTA_SHOPEE = { key: `SHOPEE:${SHOP}.${ITEM}`, title: 'Fone Bom Sem Fio', price: 89.9, oldPrice: null, discountPct: 15, sold: 1234, freeShipping: false, coupon: null, image: IMG_SHOPEE };
const VAZIA_SHOPEE = { key: `SHOPEE:${SHOP}.${ITEM}`, title: null, price: null, oldPrice: null, discountPct: null, sold: null, freeShipping: null, coupon: null, image: null };
const EXTRA_SHOPEE = { loja_nome: 'Loja Oficial', nota: 4.8, preco_max: 99.9 };

/**
 * fetch falso da Shopee: encurtadores (302) e a Open API. estado.api: 'ok' ou o código de erro da API ('10035'…);
 * estado.nos: os nós de productOfferV2 (padrão: o produto); estado.link: o shortLink de generateShortLink.
 * Guarda método, URL e a consulta GraphQL de cada chamada.
 */
function fetchShopee(estado) {
  const chamadas = [];
  const f = async (url, init = {}) => {
    const u = String(url);
    const consulta = init.body ? JSON.parse(init.body).query : null;
    chamadas.push({ url: u, metodo: init.method || 'GET', consulta });
    if (u === URL_CURTO_SHOPEE) return new Response(null, { status: 302, headers: { location: `${URL_PRODUTO_SHOPEE}?sp_atk=abc&utm_source=an_999&xptdk=q` } });
    if (u === URL_BUSCA_SHOPEE) return new Response(null, { status: 302, headers: { location: 'https://shopee.com.br/search?keyword=fone' } });
    if (u === 'https://shopee.com.br/search?keyword=fone') return new Response('<html>busca</html>', { status: 200 });
    if (u === URL_API_SHOPEE) {
      if (estado.api !== 'ok') return respJson(200, { errors: [{ message: 'erro', extensions: { code: Number(estado.api) } }], data: null });
      if (consulta.startsWith('mutation')) return respJson(200, { data: { generateShortLink: { shortLink: estado.link } } });
      return respJson(200, { data: { productOfferV2: { nodes: estado.nos ?? [noShopee()] } } });
    }
    throw new Error('rede não prevista no teste');
  };
  f.chamadas = chamadas;
  return f;
}

/**
 * Servidor com a Shopee: conexão salva no banco (salvarShopee troca), API como pedido e um serviço de links próprio
 * (`linksShopee`, modo em estado.modo; começa com a extensão off-line).
 */
async function subirShopee({ conexao = CONEXAO_SHOPEE, api = 'ok', modo = 'extension', ...opcoes } = {}) {
  const s = await subir(opcoes);
  const estado = { api, nos: null, link: LINK_API, modo };
  const fetchF = fetchShopee(estado);
  const shopee = createShopee({ db: s.db, fetch: fetchF });
  const linksShopee = createLinkService({ getMode: () => estado.modo });
  const salvarShopee = (c) => {
    const config = {}; for (const k of ['id_afiliado', 'app_id']) if (c[k]) config[k] = c[k];
    s.db.prepare(`INSERT INTO conexoes (plataforma, config, segredos, updated_at) VALUES ('shopee', ?, ?, ?)
      ON CONFLICT(plataforma) DO UPDATE SET config = excluded.config, segredos = excluded.segredos, updated_at = excluded.updated_at`)
      .run(JSON.stringify(config), JSON.stringify(c.chave ? { chave: c.chave } : {}), Date.now());
    shopee.invalidar(); // como o salvar de Conexões
  };
  salvarShopee(conexao);
  s.scheduler.envios = createEnvios({ db: s.db, wa: s.wa, links: linksShopee, ml: s.ml, fast: true, dir: s.dir, shopee });
  /** Faz o papel da extensão: espera o próximo pedido e responde com `resposta` (ou a função dela sobre o pedido). */
  const extensao = (resposta) => linksShopee.poll(3000).then((job) => {
    assert.ok(job, 'a extensão não recebeu pedido');
    linksShopee.submit(job.id, typeof resposta === 'function' ? resposta(job) : resposta);
    return job;
  });
  return { ...s, envios: s.scheduler.envios, shopee, fetchF, estado, linksShopee, salvarShopee, extensao };
}

const payloadDe = (db, id) => JSON.parse(db.prepare('SELECT payload FROM envios WHERE id = ?').get(id).payload);
/** Nenhum texto (resposta, log, banco de envios) traz a Senha da API. */
const semChave = (texto, onde) => assert.ok(!String(texto).includes(CHAVE_SHOPEE), `${onde}: vazou a Senha da API`);

test('CA2: identificar Shopee com a API: link curto resolvido (só GET), dados da API editáveis, link pela API e texto de exemplo', async (t) => {
  const erros = t.mock.method(console, 'error', () => {});
  const s = await subirShopee();
  try {
    const r = await s.post('/api/disparo/identificar', { url: `  ${URL_CURTO_SHOPEE} `, template_id: 1, tag_id: 1 });
    assert.equal(r.status, 200, r.txt);
    const { texto, ...resto } = r.json;
    assert.deepEqual(resto, {
      loja: { id: 'shopee', nome: 'Shopee', implementada: true }, motivo: null, editavel: true, produto: OFERTA_SHOPEE, causa: null,
      extra: EXTRA_SHOPEE, link_via: 'api', causa_link: null, pode_disparar: true, template_id: 1, etiqueta: null,
    });
    assert.match(texto, /^\*Fone Bom Sem Fio\*/);
    assert.match(texto, /Por \*R\$ 89,90\* \(15% OFF\)/); assert.doesNotMatch(texto, /De ~/, 'sem preço antigo inventado');
    assert.ok(texto.endsWith(`Compre aqui: ${LINK_EXEMPLO_SHOPEE}`), texto);
    // o encurtador foi resolvido só com GET; depois uma consulta à API (nenhum link gerado no Identificar)
    assert.deepEqual(s.fetchF.chamadas.map((c) => `${c.metodo} ${c.url}`), [`GET ${URL_CURTO_SHOPEE}`, `POST ${URL_API_SHOPEE}`]);
    assert.match(s.fetchF.chamadas[1].consulta, /^query\{productOfferV2\(itemId:6309028319,shopId:52377417,limit:1\)/);
    assert.equal(s.linksShopee.status().pending, 0, 'o Identificar não pede link à extensão');
    semChave(r.txt, 'identificar');
    assert.equal(erros.mock.callCount(), 0);
  } finally { await s.fechar(); }
});

test('CA3: identificar Shopee sem dados da API: 10035 → campos nulos e sem_acesso; o link sai pela extensão; sem caminho → sem_link; sem ID → sem_id', async () => {
  const s = await subirShopee({ api: '10035' });
  try {
    const ident = async (url = URL_PRODUTO_SHOPEE) => {
      const r = await s.post('/api/disparo/identificar', { url, template_id: 1 });
      assert.equal(r.status, 200, r.txt);
      semChave(r.txt, 'identificar');
      return r.json;
    };
    // 10035 e extensão off-line: os dados não vêm e não há por onde gerar o link
    let r = await ident();
    assert.deepEqual([r.causa, r.produto, r.extra, r.editavel, r.link_via, r.causa_link, r.pode_disparar], ['sem_acesso', VAZIA_SHOPEE, null, true, null, 'sem_link', false]);
    assert.ok(r.texto.endsWith(`Compre aqui: ${LINK_EXEMPLO_SHOPEE}`));
    assert.doesNotMatch(r.texto, /Por \*/, 'sem preço, a linha de preço some: nada é inventado');
    assert.equal(s.shopee.situacao().acesso, 'sem_acesso');

    // extensão on-line: os campos seguem em branco para preencher, e o Disparar fica liberado
    await s.linksShopee.poll(0);
    r = await ident();
    assert.deepEqual([r.causa, r.produto, r.link_via, r.causa_link, r.pode_disparar], ['sem_acesso', VAZIA_SHOPEE, 'extensao', null, true]);

    // sem credencial: a API nem é chamada; o link continua pela extensão
    s.salvarShopee({ id_afiliado: ID_AF });
    const antes = s.fetchF.chamadas.length;
    r = await ident();
    assert.deepEqual([r.causa, r.produto, r.link_via, r.causa_link, r.pode_disparar], ['sem_credenciais', VAZIA_SHOPEE, 'extensao', null, true]);
    assert.equal(s.fetchF.chamadas.length, antes, 'sem credencial: nenhuma chamada de rede');

    // sem ID de afiliado (mesmo com a API e a extensão): os dados vêm, o Disparar não
    s.salvarShopee({ app_id: APP_ID_SHOPEE, chave: CHAVE_SHOPEE }); s.estado.api = 'ok';
    r = await ident();
    assert.deepEqual([r.causa, r.produto, r.link_via, r.causa_link, r.pode_disparar], [null, OFERTA_SHOPEE, 'api', 'sem_id', false]);

    // links simulados (npm run simular): não precisam da extensão
    s.salvarShopee({ id_afiliado: ID_AF }); s.estado.modo = 'fake';
    r = await ident();
    assert.deepEqual([r.causa, r.link_via, r.causa_link, r.pode_disparar], ['sem_credenciais', 'extensao', null, true]);
    s.estado.modo = 'extension';

    // a API não devolve o produto (fora do programa): não bloqueia (decisão do dono, 04/11); o painel avisa da comissão
    s.salvarShopee(CONEXAO_SHOPEE); s.estado.nos = [];
    r = await ident();
    assert.deepEqual([r.causa, r.produto, r.link_via, r.causa_link, r.pode_disparar], ['nao_encontrado', VAZIA_SHOPEE, 'api', null, true]);

    // link que chega a uma busca (não é produto) e link de host da Shopee que não leva a lugar nenhum
    s.estado.nos = null;
    for (const [url, causa] of [[URL_BUSCA_SHOPEE, 'nao_produto'], ['https://shp.ee/naoexiste', 'invalido'], ['https://shopee.com.br/loja-oficial', 'invalido']]) {
      r = await ident(url);
      assert.deepEqual([r.causa, r.produto, r.texto, r.pode_disparar, r.loja.id], [causa, null, null, false, 'shopee'], url);
    }
    for (const [corpo, erro] of [
      [{ url: 'https://shopee.com.br.evil.com/x-i.1.2' }, /Não reconheci este link/],
      [{ url: URL_PRODUTO_SHOPEE, template_id: 999 }, /Template não encontrado/],
    ]) {
      const e = await s.post('/api/disparo/identificar', corpo);
      assert.equal(e.status, 400, JSON.stringify(corpo)); assert.match(e.json.erro, erro);
    }
  } finally { await s.fechar(); }
});

test('CA2/CA4: oferta da Shopee "agora" pela API: imagem com legenda e o s.shopee.com.br gerado ao criar, guardado no payload', async (t) => {
  const erros = t.mock.method(console, 'error', () => {});
  const s = await subirShopee();
  try {
    const r = await s.post('/api/envios', {
      tipo: 'oferta', url: URL_CURTO_SHOPEE, template_id: 1, tag_id: 99, group_jids: ['111@g.us', '222@g.us'], quando: 'agora',
      ajustes: { coupon: 'SHOPEE10', link: 'https://evil.example/link', image: 'https://evil.example/x.jpg', link_afiliado: 'https://s.shopee.com.br/deTerceiro' }, // só o cupom vale
      link_afiliado: 'https://s.shopee.com.br/deTerceiro', offer: { title: 'Do navegador' }, // ignorados
    });
    assert.equal(r.status, 200, r.txt);
    assert.equal(await terminar(s.db, r.json.id), 'concluido');
    assert.equal(s.wa.simulated.length, 2);
    for (const [i, jid] of ['111@g.us', '222@g.us'].entries()) {
      const msg = s.wa.simulated[i];
      assert.deepEqual([msg.tipo, msg.jid, msg.image], ['image', jid, IMG_SHOPEE], 'foto pela URL que a API devolveu');
      assert.match(msg.text, /^\*Fone Bom Sem Fio\*/);
      assert.match(msg.text, /Por \*R\$ 89,90\* \(15% OFF\)/); assert.match(msg.text, /Cupom: \*SHOPEE10\*/);
      assert.ok(msg.text.endsWith(`Compre aqui: ${LINK_API}`), msg.text);
      assert.doesNotMatch(msg.text, /evil|deTerceiro|navegador|utm_|an_/);
    }
    // o link foi pedido à API com o endereço do produto sem parâmetros (nunca o link colado)
    const mutacao = s.fetchF.chamadas.filter((c) => c.consulta?.startsWith('mutation'));
    assert.deepEqual(mutacao.map((c) => c.consulta), [`mutation{generateShortLink(input:{originUrl:${JSON.stringify(URL_PRODUTO_SHOPEE)}}){shortLink}}`]);
    assert.equal(s.linksShopee.status().pending, 0, 'com a API, a extensão não é chamada');
    const payload = payloadDe(s.db, r.json.id);
    assert.deepEqual(payload, {
      url: URL_PRODUTO_SHOPEE, loja: 'shopee', tag_id: null, etiqueta: null, template_id: 1, template_criado_em: payload.template_criado_em,
      origem: { tipo: 'manual' }, shop_id: SHOP, item_id: ITEM, link_afiliado: LINK_API, fonte_dados: 'manual',
      offer: { ...OFERTA_SHOPEE, coupon: 'SHOPEE10' },
    });
    assert.deepEqual(linhas(s.db, 'SELECT rule_name, level, group_name, offer_title, message FROM log ORDER BY id'), [
      { rule_name: 'Disparo manual', level: 'ok', group_name: 'Achadinhos', offer_title: 'Fone Bom Sem Fio', message: 'Enviado com o link de afiliado da Shopee' },
      { rule_name: 'Disparo manual', level: 'ok', group_name: 'Tech', offer_title: 'Fone Bom Sem Fio', message: 'Enviado com o link de afiliado da Shopee' },
    ]);
    const p = await s.get('/api/envios?tipo=oferta');
    assert.deepEqual(p.json.linhas.map((l) => [l.titulo, l.loja, l.status]), [['Fone Bom Sem Fio', 'Shopee', 'enviado'], ['Fone Bom Sem Fio', 'Shopee', 'enviado']]);
    for (const [onde, txt] of [['POST', r.txt], ['GET', p.txt], ['log', JSON.stringify(linhas(s.db, 'SELECT * FROM log'))], ['envios', JSON.stringify(linhas(s.db, 'SELECT * FROM envios'))]]) semChave(txt, onde);

    // sem ajustes: sai como a API mandou (fonte 'api'), com o desconto informado pela Shopee
    s.wa.simulated.length = 0;
    const api = await s.post('/api/envios', { tipo: 'oferta', url: URL_PRODUTO_SHOPEE, template_id: 1, group_jids: ['111@g.us'] });
    assert.equal(await terminar(s.db, api.json.id), 'concluido');
    const pApi = payloadDe(s.db, api.json.id);
    assert.deepEqual([pApi.fonte_dados, pApi.offer.oldPrice, pApi.offer.discountPct], ['api', null, 15]);
    assert.match(s.wa.simulated[0].text, /\(15% OFF\)/);

    // o dono mudou o preço: o desconto informado é descartado (sem preço antigo, não há desconto); com os dois preços, é a conta
    s.wa.simulated.length = 0;
    const preco = await s.post('/api/envios', { tipo: 'oferta', url: URL_PRODUTO_SHOPEE, template_id: 1, group_jids: ['111@g.us'], ajustes: { price: '79,90' } });
    assert.equal(await terminar(s.db, preco.json.id), 'concluido');
    assert.deepEqual([payloadDe(s.db, preco.json.id).offer.price, payloadDe(s.db, preco.json.id).offer.discountPct], [79.9, 0]);
    assert.doesNotMatch(s.wa.simulated[0].text, /OFF|De ~/);
    const dois = await s.post('/api/envios', { tipo: 'oferta', url: URL_PRODUTO_SHOPEE, template_id: 1, group_jids: ['111@g.us'], ajustes: { price: 80, oldPrice: 100 } });
    assert.equal(await terminar(s.db, dois.json.id), 'concluido');
    assert.deepEqual([payloadDe(s.db, dois.json.id).offer.oldPrice, payloadDe(s.db, dois.json.id).offer.discountPct], [100, 20]);
    assert.equal(erros.mock.callCount(), 0);
  } finally { await s.fechar(); }
});

test('CA3/CA4: Shopee sem API (10035): o dono preenche, o link vem da extensão com o endereço limpo e o ID do longLink confere', async () => {
  const s = await subirShopee({ api: '10035' });
  try {
    const corpo = { tipo: 'oferta', url: URL_CURTO_SHOPEE, template_id: 1, group_jids: ['111@g.us'], ajustes: { title: 'Fone à mão', price: '1.299,90' } };
    // sem título: recusa antes de pedir o link (nenhum pedido à extensão). O poll(0) é esperado até o fim: um poll
    // ainda aberto pegaria o pedido seguinte no lugar da extensão do teste.
    await s.linksShopee.poll(0);
    const semTitulo = await s.post('/api/envios', { ...corpo, ajustes: { price: '50' } });
    assert.deepEqual([semTitulo.status, semTitulo.json.erro], [400, 'Não consegui buscar os dados na Shopee: preencha o título do produto.']);
    assert.equal(s.linksShopee.status().pending, 0);

    const ext = s.extensao({ ok: true, link: LINK_EXT, longo: LONGO_DONO });
    const r = await s.post('/api/envios', corpo);
    const job = await ext;
    assert.deepEqual([job.type, job.url], ['link_shopee', URL_PRODUTO_SHOPEE], 'a extensão recebe só o endereço do produto, sem parâmetros');
    assert.equal(r.status, 200, r.txt);
    assert.equal(await terminar(s.db, r.json.id), 'concluido');
    const [msg] = s.wa.simulated;
    assert.equal(msg.tipo, 'text', 'sem foto da API, só texto');
    assert.match(msg.text, /^\*Fone à mão\*/); assert.match(msg.text, /Por \*R\$ 1\.299,90\*$/m);
    assert.ok(msg.text.endsWith(`Compre aqui: ${LINK_EXT}`), msg.text);
    assert.doesNotMatch(msg.text, /utm_|an_/, 'o longLink só serve para conferir o ID');
    const payload = payloadDe(s.db, r.json.id);
    assert.deepEqual([payload.url, payload.link_afiliado, payload.fonte_dados, payload.shop_id, payload.item_id], [URL_PRODUTO_SHOPEE, LINK_EXT, 'manual', SHOP, ITEM]);
    assert.ok(!JSON.stringify(payload).includes('utm_source'), 'o longLink não é guardado');
    assert.equal(s.fetchF.chamadas.filter((c) => c.consulta?.startsWith('mutation')).length, 0, 'sem acesso à API, nem tenta gerar o link por ela');
  } finally { await s.fechar(); }
});

test('CA4: ID divergente no longLink, link fora do formato e falha da extensão → 400 e nada gravado; sem ID e sem caminho também', async () => {
  const s = await subirShopee({ api: '10035' });
  try {
    const corpo = { tipo: 'oferta', url: URL_PRODUTO_SHOPEE, template_id: 1, group_jids: ['111@g.us'], ajustes: { title: 'Fone', price: '50' } };
    const tentar = async (resposta) => {
      const ext = s.extensao(resposta);
      const r = await s.post('/api/envios', corpo);
      await ext;
      return r;
    };
    const outra = await tentar({ ok: true, link: LINK_EXT, longo: `https://shopee.com.br/x?utm_source=an_99999999999&utm_medium=affiliates` });
    assert.deepEqual([outra.status, outra.json.erro], [400, 'O Chrome está logado em outra conta de afiliado da Shopee. Entre na conta do ID …2101 e tente de novo.']);
    assert.ok(!outra.txt.includes('99999999999'), 'o ID da outra conta não aparece');
    const meli = await tentar({ ok: true, link: 'https://meli.la/abc123', longo: LONGO_DONO });
    assert.equal(meli.status, 400); assert.match(meli.json.erro, /^Não consegui gerar o seu link de afiliado da Shopee: .*não é s\.shopee\.com\.br/);
    const sessao = await tentar({ ok: false, error: `não há sessão de afiliado da Shopee neste Chrome (conta ${ID_AF})` });
    assert.equal(sessao.status, 400); assert.match(sessao.json.erro, /^Não consegui gerar o seu link de afiliado da Shopee: não há sessão de afiliado/);
    assert.ok(!sessao.txt.includes(ID_AF), 'número longo da extensão sai limpo');

    s.estado.api = 'ok';
    // a API devolve um link fora do formato e a reserva (a extensão) está off-line: nada sai
    const linksOff = createLinkService({ getMode: () => 'extension' }); // nunca consultado pela extensão: off-line
    s.scheduler.envios = createEnvios({ db: s.db, wa: s.wa, links: linksOff, ml: s.ml, fast: true, dir: s.dir, shopee: s.shopee });
    s.estado.nos = null; s.estado.link = 'https://evil.example/s'; s.shopee.invalidar();
    const ruim = await s.post('/api/envios', corpo);
    assert.equal(ruim.status, 400);
    assert.equal(ruim.json.erro, 'Não consegui gerar o seu link de afiliado da Shopee: a extensão do Chrome não está conectada (abra o Chrome com a extensão instalada)');
    assert.equal(s.fetchF.chamadas.filter((c) => c.consulta?.startsWith('mutation')).length, 1, 'tentou a API primeiro');

    // sem ID de afiliado e sem caminho para o link: recusa antes de qualquer rede
    const antes = s.fetchF.chamadas.length;
    s.salvarShopee({ app_id: APP_ID_SHOPEE, chave: CHAVE_SHOPEE });
    const semId = await s.post('/api/envios', corpo);
    assert.deepEqual([semId.status, semId.json.erro], [400, 'Falta o ID de afiliado da Shopee. Cadastre em Conexões → Shopee antes de disparar.']);
    s.salvarShopee({ id_afiliado: ID_AF }); // sem a API e com a extensão off-line
    const semCaminho = await s.post('/api/envios', { ...corpo, quando: 'agendado', agendar_hhmm: '23:59' });
    assert.deepEqual([semCaminho.status, semCaminho.json.erro], [400, 'Não tenho como gerar o seu link de afiliado da Shopee agora. Abra o Chrome com a extensão e entre no portal de afiliados da Shopee, ou ligue a API em Conexões.']);
    const busca = await s.post('/api/envios', { ...corpo, url: URL_BUSCA_SHOPEE });
    assert.equal(busca.status, 400, 'link que não leva a produto');
    assert.equal(s.fetchF.chamadas.length, antes, 'nenhuma rede sem ID ou sem caminho');

    assert.equal(contar(s.db, 'SELECT COUNT(*) AS n FROM envios'), 0, 'nada gravado');
    assert.equal(contar(s.db, 'SELECT COUNT(*) AS n FROM log'), 0);
    assert.equal(s.wa.simulated.length, 0);
    for (const r of [outra, meli, sessao, ruim, semId, semCaminho]) semChave(r.txt, 'erro');
  } finally { await s.fechar(); }
});

test('Decisão do dono (04/11): produto fora do programa (nao_encontrado) com título à mão cria o envio com o link gerado; sem título recusa; link que falha segue o erro de sempre', async () => {
  const s = await subirShopee();
  try {
    s.estado.nos = []; s.shopee.invalidar(); // a API responde, mas sem o produto
    const corpo = { tipo: 'oferta', url: URL_PRODUTO_SHOPEE, template_id: 1, group_jids: ['111@g.us'], ajustes: { title: 'Fone à mão', price: '50' } };
    const mutacoes = () => s.fetchF.chamadas.filter((c) => c.consulta?.startsWith('mutation')).length;

    const semTitulo = await s.post('/api/envios', { ...corpo, ajustes: { price: '50' } });
    assert.deepEqual([semTitulo.status, semTitulo.json.erro], [400, 'Não consegui buscar os dados na Shopee: preencha o título do produto.']);
    assert.equal(mutacoes(), 0, 'sem título, nenhum link é gerado');
    assert.equal(contar(s.db, 'SELECT COUNT(*) AS n FROM envios'), 0);

    const r = await s.post('/api/envios', corpo);
    assert.equal(r.status, 200, r.txt);
    assert.equal(mutacoes(), 1, 'o link saiu pela API, como nos outros casos');
    const payload = payloadDe(s.db, r.json.id);
    assert.deepEqual([payload.link_afiliado, payload.fonte_dados, payload.offer.title], [LINK_API, 'manual', 'Fone à mão']);
    semChave(r.txt, 'envio');

    // a geração do link falha para este produto: vale o erro que já existia (nada novo)
    const linksOff = createLinkService({ getMode: () => 'extension' }); // extensão off-line
    s.scheduler.envios = createEnvios({ db: s.db, wa: s.wa, links: linksOff, ml: s.ml, fast: true, dir: s.dir, shopee: s.shopee });
    s.estado.link = 'https://evil.example/s'; s.shopee.invalidar();
    const ruim = await s.post('/api/envios', corpo);
    assert.equal(ruim.status, 400);
    assert.equal(ruim.json.erro, 'Não consegui gerar o seu link de afiliado da Shopee: a extensão do Chrome não está conectada (abra o Chrome com a extensão instalada)');
    assert.equal(contar(s.db, 'SELECT COUNT(*) AS n FROM envios'), 1, 'só o envio que deu certo');
  } finally { await s.fechar(); }
});

test('CA4: oferta da Shopee agendada para hoje guarda o link ao criar e sai no horário sem rede nem extensão', async (t) => {
  const alvo = Date.now() + 3 * 60000;
  if (new Date(alvo).toDateString() !== new Date().toDateString()) { t.skip('perto da meia-noite: o disparo manual só agenda para hoje'); return; }
  const T = new Date(alvo).setSeconds(0, 0);
  const s = await subirShopee();
  try {
    const r = await s.post('/api/envios', { tipo: 'oferta', url: URL_CURTO_SHOPEE, template_id: 1, group_jids: ['111@g.us'], quando: 'agendado', agendar_hhmm: hhmmDe(alvo), ajustes: { coupon: 'HOJE5' } });
    assert.equal(r.status, 200, r.txt);
    assert.deepEqual([r.json.status, r.json.next_run_at], ['pendente', T]);
    assert.equal(payloadDe(s.db, r.json.id).link_afiliado, LINK_API, 'o link já foi gerado ao criar');
    assert.equal(await s.envios.processarPendentes(T - 1000), 0, 'antes do horário não sai');
    const p = (await s.get('/api/envios?tipo=oferta')).json;
    assert.deepEqual(p.agendadas.map((a) => [a.id, a.titulo, a.loja, a.status]), [[r.json.id, 'Fone Bom Sem Fio', 'Shopee', 'pendente']]);

    // na hora do envio a API não responde e a extensão está off-line: o link guardado basta
    const antes = s.fetchF.chamadas.length;
    s.estado.api = '10035';
    assert.equal(await s.envios.processarPendentes(T + 1000), 1);
    assert.equal(statusDe(s.db, r.json.id), 'concluido');
    assert.equal(s.wa.simulated[0].tipo, 'image');
    assert.match(s.wa.simulated[0].text, /Cupom: \*HOJE5\*/);
    assert.ok(s.wa.simulated[0].text.endsWith(`Compre aqui: ${LINK_API}`));
    assert.equal(s.fetchF.chamadas.length, antes, 'nenhuma rede no envio');
  } finally { await s.fechar(); }
});

test('CA4/CA7: no envio, a Shopee só usa o link guardado se for s.shopee.com.br e só baixa foto do CDN da Shopee', async () => {
  const s = await subirShopee();
  try {
    const tpl = s.db.prepare('SELECT created_at FROM templates WHERE id = 1').get().created_at;
    const base = {
      url: URL_PRODUTO_SHOPEE, loja: 'shopee', shop_id: SHOP, item_id: ITEM, tag_id: null, etiqueta: null, template_id: 1, template_criado_em: tpl,
      fonte_dados: 'api', origem: { tipo: 'manual' }, link_afiliado: LINK_API, offer: { ...OFERTA_SHOPEE, image: 'https://evil.example/z.jpg' },
    };
    const inserir = (p) => Number(s.db.prepare(`INSERT INTO envios (tipo, payload, group_jids, quando, status, next_run_at, created_at)
      VALUES ('oferta', ?, ?, 'agora', 'pendente', ?, ?)`).run(JSON.stringify(p), JSON.stringify(['222@g.us']), Date.now(), Date.now()).lastInsertRowid);
    const ok = inserir(base);
    await s.envios.runEnvio(ok);
    assert.equal(statusDe(s.db, ok), 'concluido');
    assert.equal(s.wa.simulated[0].tipo, 'text', 'foto fora do CDN da Shopee não é baixada');
    assert.ok(s.wa.simulated[0].text.endsWith(`Compre aqui: ${LINK_API}`));

    for (const link of ['https://evil.example/x', 'https://s.shopee.com.br.evil.com/abc', 'http://s.shopee.com.br/abc', 'https://meli.la/abc123', [LINK_API], null]) {
      const id = inserir({ ...base, link_afiliado: link });
      await s.envios.runEnvio(id);
      assert.equal(statusDe(s.db, id), 'erro', JSON.stringify(link));
      assert.equal(s.db.prepare('SELECT erro FROM envio_resultados WHERE envio_id = ?').get(id).erro, 'link de afiliado não gerado: o link da Shopee guardado no envio não é válido');
    }
    assert.equal(s.wa.simulated.length, 1);
    assert.equal(s.fetchF.chamadas.length, 0, 'nenhuma rede no envio');
  } finally { await s.fechar(); }
});

test('Shopee sem o cliente da Shopee na fila (servidor antes da ligação): oferta e identificar recusam sem gravar', async () => {
  const s = await subir();
  try {
    s.db.prepare("INSERT INTO conexoes (plataforma, config, segredos) VALUES ('shopee', ?, '{}')").run(JSON.stringify({ id_afiliado: ID_AF }));
    const r = await s.post('/api/envios', { tipo: 'oferta', url: URL_PRODUTO_SHOPEE, template_id: 1, group_jids: ['111@g.us'] });
    assert.deepEqual([r.status, r.json.erro], [400, 'A integração com a Shopee não está disponível neste servidor.']);
    const id = await s.post('/api/disparo/identificar', { url: URL_PRODUTO_SHOPEE });
    assert.deepEqual([id.status, id.json.erro], [400, 'A integração com a Shopee não está disponível neste servidor.']);
    assert.equal(contar(s.db, 'SELECT COUNT(*) AS n FROM envios'), 0);
  } finally { await s.fechar(); }
});

test('CA9: o espelhamento continua ignorando links da Shopee (só a Amazon entra)', async () => {
  const s = await subirAmazon();
  try {
    const espelho = createEspelho({ db: s.db, wa: s.wa, amazon: s.amazon, envios: s.envios, acordar: () => {} });
    espelho.criar({ nome: 'Origem → Tech', origem_jids: ['111@g.us'], destino_jids: ['222@g.us'], template_id: 1 });
    const receber = (texto, msgId) => espelho.receber({ jid: '111@g.us', fromMe: false, texto, msgId, ts: Date.now() });
    assert.equal(receber(`Fone por R$ 89,90 ${URL_CURTO_SHOPEE} e ${URL_PRODUTO_SHOPEE}`, 'M1'), 0);
    assert.equal(receber(`Fone por R$ 89,90 https://shp.ee/xYz`, 'M2'), 0);
    assert.equal(receber(`Fone por R$ 99,90 https://www.amazon.com.br/dp/${ASIN}`, 'M3'), 1, 'a Amazon segue entrando');
    assert.deepEqual(linhas(s.db, 'SELECT url FROM espelho_itens').map((i) => i.url), [`https://www.amazon.com.br/dp/${ASIN}`]);
  } finally { await s.fechar(); }
});

test('S2: o mesmo produto da Shopee não gera outro link a cada disparo (API e extensão); salvar a conexão gera de novo', async () => {
  const s = await subirShopee();
  try {
    const corpo = { tipo: 'oferta', url: URL_CURTO_SHOPEE, template_id: 1, group_jids: ['111@g.us'] };
    const mutacoes = () => s.fetchF.chamadas.filter((c) => c.consulta?.startsWith('mutation')).length;
    const disparar = async (c = corpo) => {
      const r = await s.post('/api/envios', c);
      assert.equal(r.status, 200, r.txt);
      assert.equal(await terminar(s.db, r.json.id), 'concluido');
      return payloadDe(s.db, r.json.id).link_afiliado;
    };
    assert.equal(await disparar(), LINK_API);
    s.estado.link = 'https://s.shopee.com.br/Outro999';
    assert.equal(await disparar(), LINK_API, 'segundo disparo: o link guardado');
    assert.equal(await disparar({ ...corpo, url: URL_PRODUTO_SHOPEE }), LINK_API, 'o mesmo produto pelo endereço longo');
    assert.equal(mutacoes(), 1, 'a API gerou um link só');
    // salvar a conexão (como Conexões) esquece o link guardado
    s.salvarShopee(CONEXAO_SHOPEE);
    assert.equal(await disparar(), 'https://s.shopee.com.br/Outro999');
    assert.equal(mutacoes(), 2);

    // pela extensão (API sem acesso): um pedido só para dois disparos
    s.estado.api = '10035'; s.salvarShopee(CONEXAO_SHOPEE);
    const pedidos = [];
    const original = s.linksShopee.requestLinkShopee;
    s.linksShopee.requestLinkShopee = (arg) => {
      pedidos.push(arg.url);
      if (pedidos.length > 1) return Promise.reject(new Error('pediu o link à extensão de novo'));
      return original(arg);
    };
    const ext = s.extensao({ ok: true, link: LINK_EXT, longo: LONGO_DONO });
    const corpoManual = { ...corpo, ajustes: { title: 'Fone à mão' } };
    assert.equal(await disparar(corpoManual), LINK_EXT);
    await ext;
    assert.equal(await disparar(corpoManual), LINK_EXT);
    assert.deepEqual(pedidos, [URL_PRODUTO_SHOPEE]);
  } finally { await s.fechar(); }
});

test('S2: só o Disparo manual pede o link da Shopee: o espelho, as regras e o envio da fila nunca pedem', async () => {
  // 1. no código: quem chama requestLinkShopee, gerarLink e linkAfiliado('shopee'), e de onde
  const pasta = new URL('../src/', import.meta.url);
  const fontes = Object.fromEntries(fs.readdirSync(pasta).filter((f) => f.endsWith('.js')).map((f) => [f, fs.readFileSync(new URL(f, pasta), 'utf8')]));
  /** Nome da função declarada mais próxima antes de cada chamada (as do envios.js não têm função declarada no meio). */
  const chamadas = (re) => Object.entries(fontes).flatMap(([arq, txt]) => [...txt.matchAll(re)].map((m) => {
    const antes = [...txt.slice(0, m.index).matchAll(/function\s+(\w+)\s*\(/g)];
    return `${arq}:${antes.at(-1)?.[1]}`;
  }));
  assert.deepEqual(chamadas(/\.requestLinkShopee\(/g), ['lojas.js:linkAfiliadoShopee']);
  assert.deepEqual(chamadas(/\.gerarLink\(/g), ['lojas.js:linkAfiliadoShopee']);
  assert.deepEqual(chamadas(/['"]link_shopee['"]/g).filter((c) => !c.startsWith('links.js:')), [], 'só links.js monta o pedido link_shopee');
  assert.deepEqual(chamadas(/linkAfiliado\(\s*['"]shopee['"]/g), ['envios.js:linkShopee']);
  assert.deepEqual(chamadas(/(?<!function )\blinkShopee\(/g), ['envios.js:ofertaShopee']);
  // a montagem da oferta (plano envio-pelo-socio, etapa 4) saiu do criar para payloadDaOferta, que só o criar (Disparo
  // manual) e o montarOferta chamam; o montarOferta é só do remetente (src/remetentes.js, plano envio-pelo-socio, D4)
  assert.deepEqual(chamadas(/(?<!function )\bofertaShopee\(/g), ['envios.js:payloadDaOferta']);
  assert.deepEqual(chamadas(/(?<!function )\bpayloadDaOferta\(/g).sort(), ['envios.js:criar', 'envios.js:montarOferta']);
  assert.deepEqual(chamadas(/\.montarOferta\(/g).filter((c) => !c.startsWith('remetentes.js:')), [], 'só o remetente usa o montarOferta');
  assert.match(fontes['envios.js'].slice(fontes['envios.js'].indexOf('async function criar(')), /origem: \{ tipo: 'manual' \}/, 'criar é o Disparo manual');
  for (const arq of ['espelho.js', 'scheduler.js', 'avisos.js']) {
    assert.doesNotMatch(fontes[arq], /requestLinkShopee|gerarLink|linkAfiliado\(\s*['"]shopee/, arq);
  }

  // 2. na prática: espelho com links da Shopee e o envio agendado da fila não pedem link
  const s = await subirAmazon();
  try {
    const pedidos = [];
    const links = createLinkService({ getMode: () => 'extension' });
    links.requestLinkShopee = async (a) => { pedidos.push(['extensão', a]); throw new Error('não era para pedir'); };
    const shopee = createShopee({ db: s.db, fetch: async () => { throw new Error('rede proibida'); } });
    shopee.gerarLink = async (u) => { pedidos.push(['api', u]); throw new Error('não era para pedir'); };
    s.db.prepare("INSERT INTO conexoes (plataforma, config, segredos) VALUES ('shopee', ?, '{}')").run(JSON.stringify({ id_afiliado: ID_AF }));
    const envios = createEnvios({ db: s.db, wa: s.wa, links, ml: s.ml, fast: true, dir: s.dir, amazon: s.amazon, shopee });
    const espelho = createEspelho({ db: s.db, wa: s.wa, amazon: s.amazon, envios, acordar: () => {} });
    espelho.criar({ nome: 'Origem → Tech', origem_jids: ['111@g.us'], destino_jids: ['222@g.us'], template_id: 1 });
    assert.equal(espelho.receber({ jid: '111@g.us', fromMe: false, texto: `Fone R$ 89,90 ${URL_CURTO_SHOPEE} ${URL_PRODUTO_SHOPEE}`, msgId: 'S1', ts: Date.now() }), 0);
    await espelho.processarPendentes();
    // envio da Shopee já gravado (agendado vencido): sai com o link guardado, sem pedir outro
    const tpl = s.db.prepare('SELECT created_at FROM templates WHERE id = 1').get().created_at;
    const payload = { url: URL_PRODUTO_SHOPEE, loja: 'shopee', shop_id: SHOP, item_id: ITEM, tag_id: null, etiqueta: null, template_id: 1,
      template_criado_em: tpl, fonte_dados: 'manual', origem: { tipo: 'manual' }, link_afiliado: LINK_API, offer: { ...OFERTA_SHOPEE, image: null } };
    s.db.prepare(`INSERT INTO envios (tipo, payload, group_jids, quando, status, next_run_at, created_at)
      VALUES ('oferta', ?, ?, 'agendado', 'pendente', ?, ?)`).run(JSON.stringify(payload), JSON.stringify(['222@g.us']), Date.now() - 1000, Date.now());
    assert.equal(await envios.processarPendentes(), 1);
    assert.ok(s.wa.simulated.at(-1).text.endsWith(`Compre aqui: ${LINK_API}`));
    assert.deepEqual(pedidos, []);
  } finally { await s.fechar(); }
});

test('R6: erro que não é da Shopee ao ler um link de produto reconhecido vira "indisponível" com os ids (o dono preenche); só o nome vai ao log', async (t) => {
  const erros = t.mock.method(console, 'error', () => {});
  const s = await subirShopee();
  try {
    const lojas = { ...lojasPadrao, lerProduto: async () => { throw new TypeError(`falhou em ${URL_PRODUTO_SHOPEE} com ${CHAVE_SHOPEE}`); } };
    s.scheduler.envios = createEnvios({ db: s.db, wa: s.wa, links: s.linksShopee, ml: s.ml, fast: true, dir: s.dir, shopee: s.shopee, lojas });
    const r = await s.post('/api/disparo/identificar', { url: `${URL_PRODUTO_SHOPEE}?sp_atk=x`, template_id: 1 });
    assert.equal(r.status, 200, r.txt);
    assert.deepEqual([r.json.causa, r.json.produto, r.json.link_via, r.json.pode_disparar], ['indisponivel', VAZIA_SHOPEE, 'api', true]);
    // o encurtador não diz qual é o produto: continua "não reconheci"
    const curto = await s.post('/api/disparo/identificar', { url: URL_CURTO_SHOPEE, template_id: 1 });
    assert.deepEqual([curto.json.causa, curto.json.produto], ['invalido', null]);
    // o disparo com o título preenchido à mão sai, com o endereço sem parâmetros
    const c = await s.post('/api/envios', { tipo: 'oferta', url: `${URL_PRODUTO_SHOPEE}?sp_atk=x`, template_id: 1, group_jids: ['111@g.us'], ajustes: { title: 'Fone à mão' } });
    assert.equal(c.status, 200, c.txt);
    const p = payloadDe(s.db, c.json.id);
    assert.deepEqual([p.url, p.shop_id, p.item_id, p.link_afiliado, p.fonte_dados, p.offer.title], [URL_PRODUTO_SHOPEE, SHOP, ITEM, LINK_API, 'manual', 'Fone à mão']);
    await terminar(s.db, c.json.id);
    // log: só o nome do erro
    assert.ok(erros.mock.calls.length >= 3);
    for (const { arguments: a } of erros.mock.calls) {
      assert.deepEqual(a, ['[envios] dados da Shopee:', 'TypeError']);
    }
    for (const x of [r.txt, curto.txt, c.txt]) semChave(x, 'resposta');
  } finally { await s.fechar(); }
});

test('S3: o teto de acessos barrando o link curto vira 400 com a frase de cota da Shopee, sem gravar nada', async () => {
  const s = await subirShopee();
  try {
    const shopee = createShopee({ db: s.db, fetch: s.fetchF, limiteHora: 1 });
    s.scheduler.envios = createEnvios({ db: s.db, wa: s.wa, links: s.linksShopee, ml: s.ml, fast: true, dir: s.dir, shopee });
    await shopee.lerItem(SHOP, ITEM); // gasta o único acesso da hora
    const antes = s.fetchF.chamadas.length;
    const r = await s.post('/api/envios', { tipo: 'oferta', url: URL_CURTO_SHOPEE, template_id: 1, group_jids: ['111@g.us'], ajustes: { title: 'Fone' } });
    assert.deepEqual([r.status, r.json.erro], [400, 'A Shopee limitou as consultas por agora. Tente de novo em alguns minutos.']);
    assert.equal(s.fetchF.chamadas.length, antes, 'nenhum acesso passado o teto');
    assert.equal(contar(s.db, 'SELECT COUNT(*) AS n FROM envios'), 0);
    // link de produto: os dados vêm do cache e o link... a API está no teto e a extensão off-line: recusa, nada gravado
    const p = await s.post('/api/envios', { tipo: 'oferta', url: URL_PRODUTO_SHOPEE, template_id: 1, group_jids: ['111@g.us'] });
    assert.equal(p.status, 400);
    assert.match(p.json.erro, /^Não consegui gerar o seu link de afiliado da Shopee: a extensão do Chrome não está conectada/);
    assert.equal(contar(s.db, 'SELECT COUNT(*) AS n FROM envios'), 0);
  } finally { await s.fechar(); }
});

// ---------------------------------------------------------------------------------------------
// montarOferta e situacaoLink (plano envio-pelo-socio, etapa 4; CA4, CA5, CA6). A oferta do remetente sai pela mesma
// montagem do Disparo manual (criar = montarOferta + INSERT): os dados da loja primeiro, o texto da mensagem completa
// campo a campo, e só sai link do dono. Fila montada direto (sem servidor), com as 3 lojas e fetch falso.
const ORIGEM_REM = { tipo: 'remetente', remetente_id: 7, nome: ' Sócio \n Pedro ' };
const URL_MELI = 'https://meli.la/1AbCdEf';
const URL_ML_ACHADO = 'https://produto.mercadolivre.com.br/MLB-9876543210-fone-achado-_JM';

/** Erro que a promessa lança (falha o teste se ela não lançar). */
async function erroDe(promessa) {
  try { await promessa; } catch (e) { return e; }
  assert.fail('era para lançar');
}

/** ML falso com a página do produto como pedido: `url` achada (ou o link colado) e os campos de `campos`. */
function mlPagina({ url = null, ...campos } = {}) {
  const chamadas = [];
  return {
    chamadas,
    async resolveOffer(c) {
      chamadas.push(c.url);
      return { key: 'MLB9876543210', url: url ?? c.url, title: 'Fone Bom', price: 89.9, oldPrice: null, discountPct: null, sold: 1200, freeShipping: false, image: IMG, ...campos };
    },
  };
}

/**
 * Fila de envios com as 3 lojas: ML pelo `ml` (ou o mlFalso), Amazon e Shopee de verdade com fetch falso. O modo dos
 * links fica em `estado.modo`; a API da Amazon em `estado.api`, a da Shopee em `estadoS.api`. `pedidosShopee` guarda
 * cada endereço pedido à extensão da Shopee.
 */
function montarLojas({ amazonApi = 'ok', shopeeApi = 'ok', modo = 'fake', ml = null, conexaoShopee = CONEXAO_SHOPEE, comAmazon = true, comShopee = true } = {}) {
  const m = montar();
  const estado = { modo, api: amazonApi };
  const fetchA = fetchAmazon(estado);
  const conexao = { tag: TAG, credencial_versao: '3.1', credencial_id: CRED_ID, credencial_secret: SEGREDO };
  const amazon = comAmazon ? createAmazon({ db: m.db, fetch: fetchA, esperar: async () => {}, lerConexao: () => conexao }) : null;
  const estadoS = { api: shopeeApi, nos: null, link: LINK_API };
  const fetchS = fetchShopee(estadoS);
  const config = {}; for (const k of ['id_afiliado', 'app_id']) if (conexaoShopee[k]) config[k] = conexaoShopee[k];
  m.db.prepare("INSERT INTO conexoes (plataforma, config, segredos, updated_at) VALUES ('shopee', ?, ?, ?)")
    .run(JSON.stringify(config), JSON.stringify(conexaoShopee.chave ? { chave: conexaoShopee.chave } : {}), Date.now());
  const shopee = comShopee ? createShopee({ db: m.db, fetch: fetchS }) : null;
  const links = createLinkService({ getMode: () => estado.modo });
  const pedidosShopee = [];
  const pedirShopee = links.requestLinkShopee;
  links.requestLinkShopee = (a) => { pedidosShopee.push(a.url); return pedirShopee(a); };
  const envios = createEnvios({ db: m.db, wa: m.wa, links, ml: ml ?? m.ml, fast: true, dir: m.dir, amazon, shopee });
  return { ...m, envios, links, estado, estadoS, conexao, fetchA, fetchS, shopee, pedidosShopee };
}

test('etapa 4 (CA5): montarOferta do ML com complemento: a loja primeiro e o texto completa; o meli.la achado vira o produto; nada é gravado', async () => {
  const s = montarLojas({ ml: mlPagina({ url: URL_ML_ACHADO }) });
  try {
    const tpl = s.db.prepare('SELECT created_at FROM templates WHERE id = 1').get().created_at;
    const complemento = { title: 'Título do texto', price: 10, oldPrice: 149.9, coupon: 'FONE10', freeShipping: true, sold: 5 };
    const p = await s.envios.montarOferta({ url: URL_MELI, template_id: 1, tag_id: 2 }, { origem: ORIGEM_REM, complemento, exigirPreco: true });
    assert.deepEqual(p, {
      url: URL_ML_ACHADO, loja: 'mercadolivre', tag_id: 2, etiqueta: 'etiquetaB', template_id: 1, template_criado_em: tpl, origem: ORIGEM_REM,
      fonte_dados: 'api+texto',
      offer: { key: 'MLB9876543210', title: 'Fone Bom', price: 89.9, oldPrice: 149.9, discountPct: 40, sold: 1200, freeShipping: true, coupon: 'FONE10', image: IMG },
    });
    assert.deepEqual(s.ml.chamadas, [], 'o ML lido é o injetado');
    assert.equal(contar(s.db, 'SELECT COUNT(*) AS n FROM envios'), 0, 'montarOferta não grava');
    // sem complemento e sem etiqueta escolhida: a primeira etiqueta, os dados só da loja e o payload sem fonte_dados (como o criar)
    const so = await s.envios.montarOferta({ url: URL_MELI, template_id: 1 }, { origem: { tipo: 'manual' } });
    assert.deepEqual([so.tag_id, so.etiqueta, so.fonte_dados, so.offer.coupon, so.offer.oldPrice], [1, 'etiquetaA', undefined, null, null]);
  } finally { s.db.close(); }
});

test('etapa 4: criar = montarOferta + INSERT (o payload gravado é o mesmo, nas 3 lojas)', async () => {
  const s = montarLojas();
  try {
    const casos = [
      [{ url: URL_ML, template_id: 1, tag_id: 2 }, {}],
      [{ url: URL_CURTO, template_id: 1, ajustes: { coupon: 'AMZ5' } }, {}],
      [{ url: URL_PRODUTO_SHOPEE, template_id: 1, ajustes: { title: 'Fone à mão' } }, { omitir: ['link_afiliado'] }],
    ];
    for (const [dados, { omitir = [] }] of casos) {
      const r = await s.envios.criar({ tipo: 'oferta', group_jids: ['111@g.us'], ...dados });
      await terminar(s.db, r.id);
      const gravado = payloadDe(s.db, r.id);
      const montado = await s.envios.montarOferta(dados, { origem: { tipo: 'manual' } });
      for (const k of omitir) { assert.ok(gravado[k] && montado[k]); delete gravado[k]; delete montado[k]; } // o link fake muda a cada pedido
      assert.deepEqual(montado, gravado, dados.url);
    }
  } finally { s.db.close(); }
});

test('etapa 4 (CA4/CA5): ML do remetente que continua no meli.la é recusado com link_invalido (o Disparo manual segue igual); sem preço → sem_dados', async () => {
  const s = montarLojas({ ml: mlPagina() }); // a página não informa o produto: o link continua o meli.la colado
  try {
    const e = await erroDe(s.envios.montarOferta({ url: URL_MELI, template_id: 1 }, { origem: ORIGEM_REM, exigirPreco: true }));
    assert.deepEqual([e.codigo, e.message], ['link_invalido', 'Não achei o produto deste link do Mercado Livre.'], 'S1 (rodada 2): não é falta de dados, é link que não leva a um produto');
    const manual = await s.envios.montarOferta({ url: URL_MELI, template_id: 1 }, { origem: { tipo: 'manual' } });
    assert.equal(manual.url, URL_MELI, 'o Disparo manual continua mandando o link colado à Central');

    // página sem preço: exigirPreco recusa; o preço do texto completa
    const semPreco = montarLojas({ ml: mlPagina({ url: URL_ML_ACHADO, price: null }) });
    try {
      const e2 = await erroDe(semPreco.envios.montarOferta({ url: URL_MELI, template_id: 1 }, { origem: ORIGEM_REM, exigirPreco: true }));
      assert.equal(e2.codigo, 'sem_dados');
      const p = await semPreco.envios.montarOferta({ url: URL_MELI, template_id: 1 }, { origem: ORIGEM_REM, complemento: { price: 79.9 }, exigirPreco: true });
      assert.deepEqual([p.offer.title, p.offer.price, p.fonte_dados], ['Fone Bom', 79.9, 'api+texto']);
      // sem exigirPreco, a falta do preço não barra (o Disparo manual do ML nunca exigiu)
      assert.equal((await semPreco.envios.montarOferta({ url: URL_MELI, template_id: 1 }, { origem: { tipo: 'manual' } })).offer.price, null);
      // sem título nem no texto
      const semTitulo = montarLojas({ ml: mlPagina({ url: URL_ML_ACHADO, title: null }) });
      try {
        const e3 = await erroDe(semTitulo.envios.montarOferta({ url: URL_MELI, template_id: 1 }, { origem: ORIGEM_REM, complemento: { price: 5 }, exigirPreco: true }));
        assert.equal(e3.codigo, 'sem_dados');
      } finally { semTitulo.db.close(); }
    } finally { semPreco.db.close(); }
  } finally { s.db.close(); }
});

// S1 (envio-pelo-socio, rodada 2): no ML de quem só sai com afiliação (remetente; catálogo pelo SO_COM_AFILIACAO), só o
// endereço de um produto vai à Central, e sem parâmetros: a vitrine /social/ e o rastreio (matt_tool, matt_word) de outro
// afiliado nunca passam. O Disparo manual continua como era.
test('S1: ML do remetente só sai com o endereço de um produto, sem query nem fragmento; vitrine /social/, meli.la e o resto → link_invalido', async () => {
  const CATALOGO = 'https://www.mercadolivre.com.br/fone-x/p/MLB79725856';
  const RASTREIO = '?matt_tool=88888&matt_word=OUTRO&forceInApp=true#topo';
  const SOCIAL = 'https://www.mercadolivre.com.br/social/outroafiliado?matt_tool=99999&forceInApp=true';
  const aceitos = [
    [`${URL_ML_ACHADO}${RASTREIO}`, URL_ML_ACHADO],
    [`${CATALOGO}${RASTREIO}`, CATALOGO],
    [CATALOGO, CATALOGO],
    [URL_ML_ACHADO, URL_ML_ACHADO],
  ];
  for (const [achada, esperada] of aceitos) {
    for (const origem of [ORIGEM_REM, { tipo: 'catalogo', rule_id: 3, nome: 'Regra' }]) {
      const s = montarLojas({ ml: mlPagina({ url: achada }) });
      try {
        const p = await s.envios.montarOferta({ url: URL_MELI, template_id: 1 }, { origem, exigirPreco: true });
        assert.equal(p.url, esperada, `${origem.tipo}: ${achada}`);
        // o link colado direto (a página devolve o próprio endereço) também perde a query
        const direto = montarLojas({ ml: mlPagina() });
        try {
          assert.equal((await direto.envios.montarOferta({ url: achada, template_id: 1 }, { origem, exigirPreco: true })).url, esperada, `colado: ${achada}`);
        } finally { direto.db.close(); }
      } finally { s.db.close(); }
    }
  }
  const recusados = [
    SOCIAL,
    'https://www.mercadolivre.com.br/social/MLB-9876543210-fone', // vitrine com cara de produto
    'https://meli.la/2ZyXwVu',
    'http://produto.mercadolivre.com.br/MLB-9876543210-fone-achado-_JM',
    'https://usuario:senha@produto.mercadolivre.com.br/MLB-9876543210-fone-achado-_JM',
    'https://www.mercadolivre.com.br/ofertas',
    'https://www.mercadolivre.com.br/ofertas?item_id=MLB9876543210', // o produto só na query
    'https://lista.mercadolivre.com.br/fone',
  ];
  for (const achada of recusados) {
    const s = montarLojas({ ml: mlPagina({ url: achada }) });
    try {
      // nem com o nome e o preço no texto do remetente: o link não leva a um produto
      const e = await erroDe(s.envios.montarOferta({ url: URL_MELI, template_id: 1 }, { origem: ORIGEM_REM, complemento: { title: 'Fone', price: 50 }, exigirPreco: true }));
      assert.deepEqual([e.codigo, e.message], ['link_invalido', 'Não achei o produto deste link do Mercado Livre.'], achada);
      assert.equal(contar(s.db, 'SELECT COUNT(*) AS n FROM envios'), 0);
    } finally { s.db.close(); }
  }
  // a vitrine colada direto (a página não achou o produto em destaque) é recusada; o Disparo manual segue igual
  const s = montarLojas({ ml: mlPagina() });
  try {
    assert.equal((await erroDe(s.envios.montarOferta({ url: SOCIAL, template_id: 1 }, { origem: ORIGEM_REM, exigirPreco: true }))).codigo, 'link_invalido');
    assert.equal((await s.envios.montarOferta({ url: SOCIAL, template_id: 1 }, { origem: { tipo: 'manual' } })).url, SOCIAL, 'manual: como era');
    const comRastreio = `${URL_ML_ACHADO}${RASTREIO}`;
    assert.equal((await s.envios.montarOferta({ url: comRastreio, template_id: 1 }, { origem: { tipo: 'manual' } })).url, comRastreio, 'manual: como era');
  } finally { s.db.close(); }
});

// Q4 e resíduo do S1 (envio-pelo-socio, rodada 2): porta fora da padrão, /social/ escrito com %xx, o MLB… solto no meio
// do caminho (perfil de loja) e o host da busca (lista.) não passam; os formatos de produto de sempre continuam passando.
test('Q4/S1: ML do remetente com porta, %73ocial, MLB… fora do começo do caminho ou da busca (lista.) → link_invalido; os formatos de produto seguem aceitos', async () => {
  const CATALOGO = 'https://www.mercadolivre.com.br/fone-x/p/MLB79725856';
  const aceitos = [
    [URL_ML_ACHADO, URL_ML_ACHADO],
    ['https://produto.mercadolivre.com.br:443/MLB-9876543210-fone-achado-_JM', URL_ML_ACHADO], // a porta padrão some no URL
    ['https://produto.mercadolivre.com.br/mlb-9876543210-outro-nome-_JM?utm_source=x', 'https://produto.mercadolivre.com.br/mlb-9876543210-outro-nome-_JM'],
    ['https://produto.mercadolivre.com.br/MLB9876543210', 'https://produto.mercadolivre.com.br/MLB9876543210'],
    ['https://www.mercadolivre.com.br/MLB-9876543210-fone-_JM', 'https://www.mercadolivre.com.br/MLB-9876543210-fone-_JM'],
    [CATALOGO, CATALOGO],
    ['https://www.mercadolivre.com.br/p/MLB79725856', 'https://www.mercadolivre.com.br/p/MLB79725856'],
    [`${CATALOGO}/s?quantity=1`, `${CATALOGO}/s`], // "outras opções de compra" do catálogo
    ['https://www.mercadolivre.com.br/fone-%C3%A9/p/MLB79725856', 'https://www.mercadolivre.com.br/fone-%C3%A9/p/MLB79725856'], // slug com acento
  ];
  for (const [achada, esperada] of aceitos) {
    const s = montarLojas({ ml: mlPagina({ url: achada }) });
    try {
      assert.equal((await s.envios.montarOferta({ url: URL_MELI, template_id: 1 }, { origem: ORIGEM_REM, exigirPreco: true })).url, esperada, achada);
    } finally { s.db.close(); }
  }
  const recusados = [
    'https://produto.mercadolivre.com.br:8443/MLB-3000000112-x-_JM', // Q4: a porta ia junto no origin
    'https://www.mercadolivre.com.br/%73ocial/outro-MLB-123456789?matt_tool=1', // /social/ com %xx
    'https://www.mercadolivre.com.br/%53OCIAL/MLB-123456789',
    'https://www.mercadolivre.com.br/MLB-9876543210/%73ocial/outroafiliado', // o produto na frente, a vitrine depois
    'https://www.mercadolivre.com.br/fone-x/p/MLB79725856%2Fsocial', // o %2F vira barra para quem decodifica
    'https://www.mercadolivre.com.br/fone-x/p/MLB79725856%E0%A4%A', // %xx que não decodifica
    'https://www.mercadolivre.com.br/perfil/LOJA_X/MLB123456789', // MLB… solto no fim do caminho
    'https://www.mercadolivre.com.br/loja/MLB-123456789',
    'https://www.mercadolivre.com.br/fone/%4DLB-123456789',
    'https://www.mercadolivre.com.br/a/b/p/MLB79725856', // catálogo só depois de um slug
    'https://lista.mercadolivre.com.br/MLB-9876543210-fone', // a busca, mesmo com cara de anúncio
    'https://lista.mercadolivre.com.br/p/MLB79725856',
    'https://api.mercadolibre.com/items/MLB9876543210',
  ];
  for (const achada of recusados) {
    const s = montarLojas({ ml: mlPagina({ url: achada }) });
    try {
      // nem com o nome e o preço no texto do remetente
      const e = await erroDe(s.envios.montarOferta({ url: URL_MELI, template_id: 1 }, { origem: ORIGEM_REM, complemento: { title: 'Fone', price: 50 }, exigirPreco: true }));
      assert.deepEqual([e.codigo, e.message], ['link_invalido', 'Não achei o produto deste link do Mercado Livre.'], achada);
      assert.equal(contar(s.db, 'SELECT COUNT(*) AS n FROM envios'), 0);
    } finally { s.db.close(); }
  }
  // colado direto (a página devolve o próprio endereço): a mesma recusa
  for (const colado of ['https://www.mercadolivre.com.br/perfil/LOJA_X/MLB123456789', 'https://www.mercadolivre.com.br/%73ocial/outro-MLB-123456789?matt_tool=1']) {
    const s = montarLojas({ ml: mlPagina() });
    try {
      assert.equal((await erroDe(s.envios.montarOferta({ url: colado, template_id: 1 }, { origem: ORIGEM_REM, exigirPreco: true }))).codigo, 'link_invalido', colado);
      assert.equal((await s.envios.montarOferta({ url: colado, template_id: 1 }, { origem: { tipo: 'manual' } })).url, colado, 'manual: como era');
    } finally { s.db.close(); }
  }
});

test('etapa 4 (CA5): montarOferta da Amazon com a API e complemento: a API primeiro, o texto só completa o que ela não trouxe', async () => {
  const s = montarLojas();
  try {
    const complemento = { title: 'Do texto', price: 10, oldPrice: 500, coupon: 'AMZ10', freeShipping: true, sold: 300 };
    const p = await s.envios.montarOferta({ url: URL_CURTO, template_id: 1 }, { origem: ORIGEM_REM, complemento, exigirPreco: true });
    assert.deepEqual(p.offer, { ...OFERTA_API, coupon: 'AMZ10', freeShipping: true, sold: 300 });
    assert.deepEqual([p.loja, p.asin, p.url, p.fonte_dados, p.tag_id, p.etiqueta, p.origem], ['amazon', ASIN, URL_CURTO, 'api+texto', null, null, ORIGEM_REM]);
    assert.equal(contar(s.db, 'SELECT COUNT(*) AS n FROM envios'), 0);
  } finally { s.db.close(); }
});

test('etapa 4 (CA5): Amazon sem API sai com os dados do texto; sem título ou sem preço → sem_dados (mensagem de hoje); link sem produto → link_invalido', async () => {
  const s = montarLojas({ amazonApi: '403' });
  try {
    const p = await s.envios.montarOferta({ url: URL_CURTO, template_id: 1 },
      { origem: ORIGEM_REM, complemento: { title: 'Fone do texto', price: 79.9, oldPrice: 99.9, discountPct: 20 }, exigirPreco: true });
    assert.deepEqual(p.offer, { key: `ASIN:${ASIN}`, title: 'Fone do texto', price: 79.9, oldPrice: 99.9, discountPct: 20, sold: null, freeShipping: false, coupon: null, image: null });
    assert.deepEqual([p.asin, p.fonte_dados], [ASIN, 'texto']);

    const semTitulo = await erroDe(s.envios.montarOferta({ url: URL_CURTO, template_id: 1 }, { origem: ORIGEM_REM, complemento: { price: 79.9 }, exigirPreco: true }));
    assert.deepEqual([semTitulo.codigo, semTitulo.message], ['sem_dados', 'Não consegui buscar os dados na Amazon: preencha o título do produto.']);
    const semPreco = await erroDe(s.envios.montarOferta({ url: URL_CURTO, template_id: 1 }, { origem: ORIGEM_REM, complemento: { title: 'Fone do texto' }, exigirPreco: true }));
    assert.equal(semPreco.codigo, 'sem_dados');
    // sem exigirPreco (Disparo manual), o preço continua opcional
    assert.equal((await s.envios.montarOferta({ url: URL_CURTO, template_id: 1 }, { origem: ORIGEM_REM, complemento: { title: 'Fone do texto' } })).offer.price, null);
    // o criar também marca o erro de título (a mensagem é a mesma de sempre)
    const doCriar = await erroDe(s.envios.criar({ tipo: 'oferta', url: URL_CURTO, template_id: 1, group_jids: ['111@g.us'] }));
    assert.deepEqual([doCriar.codigo, doCriar.message], ['sem_dados', 'Não consegui buscar os dados na Amazon: preencha o título do produto.']);

    const link = await erroDe(s.envios.montarOferta({ url: URL_BUSCA, template_id: 1 }, { origem: ORIGEM_REM, complemento: { title: 'X', price: 1 } }));
    assert.ok(link instanceof LinkNaoResolvido);
    assert.equal(link.codigo, 'link_invalido');
    assert.equal(link.message, new LinkNaoResolvido(link.causa).message, 'a mensagem de hoje');
    assert.equal(contar(s.db, 'SELECT COUNT(*) AS n FROM envios'), 0);
  } finally { s.db.close(); }
});

test('etapa 4 (CA4/CA5): Shopee sem API sai com o texto e o link da conta do dono; sem preço → sem_dados antes de pedir o link; link sem produto → link_invalido', async () => {
  const s = montarLojas({ shopeeApi: '10035' });
  try {
    const p = await s.envios.montarOferta({ url: URL_CURTO_SHOPEE, template_id: 1 },
      { origem: ORIGEM_REM, complemento: { title: 'Fone do texto', price: 59.9, coupon: 'SHOPEE5' }, exigirPreco: true });
    assert.deepEqual(p.offer, { key: `SHOPEE:${SHOP}.${ITEM}`, title: 'Fone do texto', price: 59.9, oldPrice: null, discountPct: null, sold: null, freeShipping: false, coupon: 'SHOPEE5', image: null });
    assert.deepEqual([p.loja, p.url, p.shop_id, p.item_id, p.fonte_dados, p.origem], ['shopee', URL_PRODUTO_SHOPEE, SHOP, ITEM, 'texto', ORIGEM_REM]);
    assert.match(p.link_afiliado, /^https:\/\/s\.shopee\.com\.br\/fake\d+$/, 'o link gerado pela conta do dono (simulação), nunca o colado');
    assert.deepEqual(s.pedidosShopee, [URL_PRODUTO_SHOPEE]);

    const semPreco = await erroDe(s.envios.montarOferta({ url: URL_PRODUTO_SHOPEE, template_id: 1 }, { origem: ORIGEM_REM, complemento: { title: 'Fone do texto' }, exigirPreco: true }));
    assert.equal(semPreco.codigo, 'sem_dados');
    const semTitulo = await erroDe(s.envios.montarOferta({ url: URL_PRODUTO_SHOPEE, template_id: 1 }, { origem: ORIGEM_REM, complemento: { price: 5 }, exigirPreco: true }));
    assert.deepEqual([semTitulo.codigo, semTitulo.message], ['sem_dados', 'Não consegui buscar os dados na Shopee: preencha o título do produto.']);
    assert.equal(s.pedidosShopee.length, 1, 'sem dados, o link não é pedido');

    const link = await erroDe(s.envios.montarOferta({ url: URL_BUSCA_SHOPEE, template_id: 1 }, { origem: ORIGEM_REM, complemento: { title: 'X', price: 1 } }));
    assert.ok(link instanceof LinkShopeeNaoResolvido);
    assert.equal(link.codigo, 'link_invalido');
    assert.equal(link.message, new LinkShopeeNaoResolvido(link.causa).message, 'a mensagem de hoje');
    assert.equal(s.fetchS.chamadas.filter((c) => c.consulta?.startsWith('mutation')).length, 0, 'sem acesso à API, nem tenta gerar o link por ela');
  } finally { s.db.close(); }
});

test('etapa 4 (CA4): situacaoLink diz, sem rede, por que o link do dono não sairia (ou null)', async () => {
  const s = montarLojas();
  try {
    const sit = (loja, tagId = null) => s.envios.situacaoLink(loja, { tag_id: tagId });
    // Mercado Livre: etiqueta, modo e extensão
    assert.equal(sit('mercadolivre'), null);
    assert.equal(sit('mercadolivre', 2), null);
    assert.equal(sit('mercadolivre', 999), 'sem_etiqueta');
    assert.equal(sit('mercadolivre', 'x'), 'sem_etiqueta');
    s.estado.modo = 'direct';
    assert.equal(sit('mercadolivre'), 'modo_direto');
    s.estado.modo = 'extension';
    assert.equal(sit('mercadolivre'), 'sem_extensao');
    // Amazon e Shopee na mesma fila, enquanto a extensão está fora: a API da Shopee ainda é útil
    assert.equal(sit('amazon'), null);
    assert.equal(sit('shopee'), null);
    await s.links.poll(0); // a extensão aparece
    assert.equal(sit('mercadolivre'), null);
    s.conexao.tag = '';
    assert.equal(sit('amazon'), 'sem_tag_amazon');
    s.db.prepare("UPDATE conexoes SET config = '{}' WHERE plataforma = 'shopee'").run();
    assert.equal(sit('shopee'), 'sem_id_shopee');
    s.db.prepare('DELETE FROM tags').run();
    assert.equal(sit('mercadolivre'), 'sem_etiqueta');
    assert.notEqual(sit('magalu'), null, 'loja sem integração nunca libera');
    assert.notEqual(sit(undefined), null);
    assert.deepEqual([s.fetchA.chamadas.length, s.fetchS.chamadas.length], [0, 0], 'nenhuma rede');
  } finally { s.db.close(); }

  // Shopee sem API e com a extensão fora (ML em extensão): sem caminho para o link
  const semCaminho = montarLojas({ modo: 'extension', conexaoShopee: { id_afiliado: ID_AF } });
  try { assert.equal(semCaminho.envios.situacaoLink('shopee', {}), 'sem_link_shopee'); } finally { semCaminho.db.close(); }
  // sem os clientes das lojas (servidor antes da ligação)
  const semClientes = montarLojas({ comAmazon: false, comShopee: false });
  try {
    assert.equal(semClientes.envios.situacaoLink('amazon', {}), 'sem_tag_amazon');
    assert.equal(semClientes.envios.situacaoLink('shopee', {}), 'sem_link_shopee');
  } finally { semClientes.db.close(); }
});

test('etapa 4 (CA4/CA6): ML do remetente nunca sai no modo direto (o preparar barra); sai com a etiqueta e o log "Remetente: <nome>"', async () => {
  const s = montarLojas();
  try {
    const tpl = s.db.prepare('SELECT created_at FROM templates WHERE id = 1').get().created_at;
    const payload = {
      url: URL_MELI, loja: 'mercadolivre', tag_id: 1, etiqueta: 'etiquetaA', template_id: 1, template_criado_em: tpl, origem: ORIGEM_REM,
      fonte_dados: 'api', offer: { key: 'MLB9876543210', title: 'Fone Bom', price: 89.9, oldPrice: null, discountPct: null, sold: null, freeShipping: false, coupon: null, image: null },
    };
    const gravar = () => Number(s.db.prepare(`INSERT INTO envios (tipo, payload, group_jids, quando, status, next_run_at, created_at)
      VALUES ('oferta', ?, ?, 'agora', 'pendente', ?, ?)`).run(JSON.stringify(payload), JSON.stringify(['222@g.us']), Date.now(), Date.now()).lastInsertRowid);
    s.estado.modo = 'direct';
    const recusado = gravar();
    await s.envios.runEnvio(recusado);
    assert.equal(statusDe(s.db, recusado), 'erro');
    assert.equal(s.db.prepare('SELECT erro FROM envio_resultados WHERE envio_id = ?').get(recusado).erro,
      'link de afiliado não gerado: os links do Mercado Livre estão no modo direto (sem comissão)');
    assert.equal(s.wa.simulated.length, 0, 'o meli.la recebido nunca sai');

    s.estado.modo = 'fake';
    const ok = gravar();
    await s.envios.runEnvio(ok);
    assert.equal(statusDe(s.db, ok), 'concluido');
    assert.match(s.wa.simulated[0].text, /Compre aqui: https:\/\/meli\.la\/fake-etiquetaA-\d+$/);
    assert.doesNotMatch(s.wa.simulated[0].text, /1AbCdEf/);
    assert.deepEqual(linhas(s.db, 'SELECT rule_id, rule_name, group_name, offer_title, message FROM log WHERE level = ?', 'ok'),
      [{ rule_id: null, rule_name: 'Remetente: Sócio Pedro', group_name: 'Tech', offer_title: 'Fone Bom', message: 'Enviado com a etiqueta etiquetaA' }]);
    assert.equal(s.db.prepare("SELECT rule_name FROM log WHERE message LIKE '%modo direto%'").get()?.rule_name, 'Remetente: Sócio Pedro');
  } finally { s.db.close(); }
});

test('nenhum teste deste arquivo acessou a rede', () => {
  assert.equal(acessosRede, 0);
});
