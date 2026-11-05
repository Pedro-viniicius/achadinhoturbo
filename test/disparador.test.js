import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { renderTemplate, brl } from '../src/template.js';
import { inWindow, alignToWindow, createScheduler } from '../src/scheduler.js';
import { createLinkService } from '../src/links.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { parseListLines, parseProductHtml, extractItemId, offerKey, resolveOffer } from '../src/ml.js';

// pastas temporárias apagadas no fim do arquivo
const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-')); pastas.push(p); return p; };
const at = (h, m = 0) => new Date(2026, 10, 2, h, m).getTime(); // 02/11/2026, horário local

test('template: remove linhas de campos vazios e formata preço', () => {
  const t = '*{TITULO_PRODUTO}*\nDe ~{PRECO_ANTIGO}~\nPor *{PRECO_PRODUTO}* ({DESCONTO_PRODUTO} OFF)\nCupom: *{CUPOM}*\n{LINK}';
  const out = renderTemplate(t, { title: 'Fone *X*', price: 80, oldPrice: 100, link: 'https://meli.la/a' });
  assert.equal(out, '*Fone X*\nDe ~R$ 100,00~\nPor *R$ 80,00* (20% OFF)\nhttps://meli.la/a');
  const semAntigo = renderTemplate(t, { title: 'Y', price: 50, link: 'L' });
  assert.ok(!semAntigo.includes('De ~') && !semAntigo.includes('OFF') && !semAntigo.includes('Cupom'));
  assert.equal(brl(1234.5), 'R$ 1.234,50');
});

test('janela de horário: normal e virando a noite', () => {
  assert.ok(inWindow(at(9), '08:00', '22:00'));
  assert.ok(!inWindow(at(23), '08:00', '22:00'));
  assert.ok(inWindow(at(1), '20:00', '02:00') && inWindow(at(21), '20:00', '02:00') && !inWindow(at(12), '20:00', '02:00'));
  assert.equal(alignToWindow(at(23), '08:00', '22:00'), new Date(2026, 10, 3, 8, 0).getTime());
  assert.equal(alignToWindow(at(6), '08:00', '22:00'), at(8));
  assert.equal(alignToWindow(at(10), '08:00', '22:00'), at(10));
});

test('lista de links: formato com dados manuais, comentários e duplicados', () => {
  const l = parseListLines(`# comentário
https://produto.mercadolivre.com.br/MLB-1234567890-fone-_JM | Fone Bom | 89,90 | 149,90 | CUPOM10
https://produto.mercadolivre.com.br/MLB-1234567890-fone-_JM?x=1
https://www.mercadolivre.com.br/p/MLB555555
lixo sem url`);
  assert.equal(l.length, 2);
  assert.deepEqual([l[0].key, l[0].price, l[0].oldPrice, l[0].coupon], ['MLB1234567890', 89.9, 149.9, 'CUPOM10']);
  assert.equal(extractItemId('https://produto.mercadolivre.com.br/MLB-987654321-a'), 'MLB987654321');
  assert.equal(offerKey('https://www.mercadolivre.com.br/p/MLB555555?a=b'), 'MLB555555');
});

test('leitura do produto pelo JSON-LD da página', () => {
  const html = `<html><script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Cafeteira X","image":["https://http2.mlstatic.com/D_1-O.jpg"],"offers":{"@type":"Offer","price":199.9,"priceCurrency":"BRL"}}</script>"original_price":299.9</html>`;
  const p = parseProductHtml(html);
  assert.deepEqual([p.title, p.price, p.oldPrice, p.image], ['Cafeteira X', 199.9, 299.9, 'https://http2.mlstatic.com/D_1-O.jpg']);
});

test('resolveOffer: usa API, cai para HTML e explica a falha', async () => {
  const api = await resolveOffer({ key: 'MLB1', url: 'https://produto.mercadolivre.com.br/MLB-1234567-a' }, {
    fetchJson: async () => ({ id: 'MLB1234567', title: 'Item', price: 50, original_price: 100, permalink: 'https://produto.mercadolivre.com.br/p', sold_quantity: 1500, shipping: { free_shipping: true }, pictures: [{ secure_url: 'https://i/1.jpg' }] }),
  });
  assert.deepEqual([api.price, api.discountPct, api.sold, api.freeShipping], [50, 50, 1500, true]);
  const html = await resolveOffer({ key: 'k', url: 'https://www.mercadolivre.com.br/p/MLB777' }, {
    fetchText: async () => '<script type="application/ld+json">{"@type":"Product","name":"Cat","offers":{"price":10}}</script>',
  });
  assert.equal(html.title, 'Cat');
  await assert.rejects(resolveOffer({ key: 'k', url: 'https://produto.mercadolivre.com.br/MLB-1234567-a' }, {
    fetchJson: async () => { throw new Error('HTTP 403'); }, fetchText: async () => { throw new Error('HTTP 403'); },
  }), /não consegui ler o produto/);
});

// ---------- fluxo completo em modo simulação ----------
function setup() {
  const dir = tmp(); const db = openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const scheduler = createScheduler({ db, wa, links, fast: true });
  const now = Date.now();
  for (const [jid, nome] of [['111@g.us', 'Achadinhos'], ['222@g.us', 'Tech'], ['333@g.us', 'Casa']]) {
    db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, nome, 10, now);
  }
  db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etiquetaA', now);
  db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etiquetaB', now);
  return { db, wa, links, scheduler };
}
const addRule = (db, o) => db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id, group_jids, source_type, source_config,
  min_price, max_price, min_discount, per_run, interval_min, window_start, window_end, dedupe_days, send_image, created_at)
  VALUES (?,1,?,1,?,'list',?,?,?,?,?,?,?,?,?,1,?)`).run(o.name, o.tag, JSON.stringify(o.groups), JSON.stringify({ items: o.items }),
  o.min ?? null, o.max ?? null, o.desc ?? null, o.per ?? 3, o.interval ?? 60, '00:00', '23:59', o.dedupe ?? 7, Date.now()).lastInsertRowid;
const ITEMS = [
  'https://produto.mercadolivre.com.br/MLB-1000001-a | Fone A | 50 | 100',
  'https://produto.mercadolivre.com.br/MLB-1000002-b | Mouse B | 30 | 40',
  'https://produto.mercadolivre.com.br/MLB-1000003-c | Teclado C | 200 | 400',
  'https://produto.mercadolivre.com.br/MLB-1000004-d | Cabo D | 10',
  'https://produto.mercadolivre.com.br/MLB-1000005-e | Monitor E | 900 | 1000',
].join('\n');

test('envia N ofertas para cada grupo selecionado, com a etiqueta da regra', async () => {
  const { db, wa, scheduler } = setup();
  const id = addRule(db, { name: 'Tech', tag: 2, groups: ['111@g.us', '222@g.us'], items: ITEMS, per: 3 });
  const r = await scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages, r.errors], [3, 6, 0]);
  assert.equal(wa.simulated.length, 6);
  assert.ok(wa.simulated.every((m) => m.text.includes('https://meli.la/fake-etiquetaB-')), 'usa a etiqueta B');
  assert.deepEqual([...new Set(wa.simulated.map((m) => m.jid))].sort(), ['111@g.us', '222@g.us']);
  const rule = db.prepare('SELECT * FROM rules WHERE id = ?').get(id);
  assert.ok(rule.next_run_at > Date.now() + 59 * 60000, 'próximo envio em ~60 min');
});

test('duas regras com etiquetas diferentes não misturam', async () => {
  const { db, wa, scheduler } = setup();
  const a = addRule(db, { name: 'A', tag: 1, groups: ['111@g.us'], items: ITEMS, per: 1 });
  const b = addRule(db, { name: 'B', tag: 2, groups: ['333@g.us'], items: ITEMS, per: 1 });
  await scheduler.runRule(a); await scheduler.runRule(b);
  assert.ok(wa.simulated.find((m) => m.jid === '111@g.us').text.includes('fake-etiquetaA'));
  assert.ok(wa.simulated.find((m) => m.jid === '333@g.us').text.includes('fake-etiquetaB'));
});

test('não repete oferta e avança pela lista a cada envio', async () => {
  const { db, wa, scheduler } = setup();
  const id = addRule(db, { name: 'R', tag: 1, groups: ['111@g.us'], items: ITEMS, per: 3 });
  await scheduler.runRule(id);
  const first = wa.simulated.map((m) => m.text.split('\n')[0]);
  await scheduler.runRule(id);
  const second = wa.simulated.slice(3).map((m) => m.text.split('\n')[0]);
  assert.equal(new Set([...first, ...second]).size, 5, 'as 5 ofertas, sem repetir');
  assert.equal(second.length, 2, 'só sobraram 2');
  const r3 = await scheduler.runRule(id);
  assert.equal(r3.messages, 0);
  assert.match(db.prepare('SELECT message FROM log ORDER BY id DESC LIMIT 1').get().message, /Sem ofertas novas/);
});

test('com "não repetir" desligado (0 dias) a oferta pode sair de novo', async () => {
  const { db, wa, scheduler } = setup();
  const id = addRule(db, { name: 'R', tag: 1, groups: ['111@g.us'], items: ITEMS.split('\n')[0], per: 1, dedupe: 0 });
  await scheduler.runRule(id); await scheduler.runRule(id);
  assert.equal(wa.simulated.length, 2);
});

test('filtros de preço e de desconto mínimo', async () => {
  const { db, wa, scheduler } = setup();
  const id = addRule(db, { name: 'F', tag: 1, groups: ['111@g.us'], items: ITEMS, per: 10, min: 40, max: 500, desc: 30 });
  await scheduler.runRule(id);
  const titulos = wa.simulated.map((m) => m.text.split('\n')[0]).sort();
  assert.deepEqual(titulos, ['*Fone A*', '*Teclado C*']); // Fone A (50%), Teclado C (50%); Mouse 25%, Cabo sem desconto, Monitor 10%/caro
});

test('regra incompleta e WhatsApp desconectado viram erro no histórico, sem enviar', async () => {
  const { db, wa, scheduler } = setup();
  const id = addRule(db, { name: 'Sem grupo', tag: 1, groups: [], items: ITEMS });
  const r = await scheduler.runRule(id);
  assert.equal(r.errors, 1); assert.equal(wa.simulated.length, 0);
  assert.match(db.prepare('SELECT message FROM log ORDER BY id DESC LIMIT 1').get().message, /ao menos um grupo/);
});

test('tick respeita o horário de funcionamento e o intervalo', async () => {
  const { db, wa, scheduler } = setup();
  const id = addRule(db, { name: 'T', tag: 1, groups: ['111@g.us'], items: ITEMS, per: 1 });
  db.prepare("UPDATE rules SET window_start = '00:00', window_end = '23:59' WHERE id = ?").run(id);
  await scheduler.tick(); assert.equal(wa.simulated.length, 1);
  await scheduler.tick(); assert.equal(wa.simulated.length, 1, 'ainda não passou o intervalo');
  db.prepare('UPDATE rules SET next_run_at = ? WHERE id = ?').run(Date.now() - 1000, id);
  await scheduler.tick(); assert.equal(wa.simulated.length, 2, 'passou o intervalo');
});

test('serviço de links: extensão busca o trabalho, devolve o link; sem extensão dá erro claro', async () => {
  const links = createLinkService({ getMode: () => 'extension' });
  await assert.rejects(links.requestLink({ url: 'u', tag: 't' }), /extensão do Chrome não está conectada/);
  const extension = (async () => {
    const job = await links.poll(1000);
    assert.deepEqual([job.url, job.tag], ['https://produto.mercadolivre.com.br/MLB-1-a', 'minhaTag']);
    links.submit(job.id, { ok: true, link: 'https://meli.la/ABC' });
  })();
  await new Promise((r) => setTimeout(r, 20));
  const link = await links.requestLink({ url: 'https://produto.mercadolivre.com.br/MLB-1-a', tag: 'minhaTag' });
  await extension;
  assert.equal(link, 'https://meli.la/ABC');
  const p = links.requestLink({ url: 'u2', tag: 't' });
  const job2 = await links.poll(1000); links.submit(job2.id, { ok: false, error: 'sessão expirada' });
  await assert.rejects(p, /sessão expirada/);
});

// ---------- fonte: Central de Afiliados ----------
import { hubBodies, parseHubPages, parseVendidos, amostraHub, POR_PAGINA } from '../src/afiliados.js';

test('Central de Afiliados: monta os pedidos da lista com filtros e páginas', () => {
  const b = hubBodies({ busca: ' organizador ', categoria: 'MLB1574', ordem: 'lowest_price', paginas: 2, mais_vendidos: true, ganhos_extras: true });
  assert.equal(b.length, 2);
  assert.deepEqual(b[0], { search: 'organizador', sort: 'lowest_price', offset: 0, filters: [{ id: 'category', value: 'MLB1574' }, { id: 'best_seller', value: true }, { id: 'extra_commission', value: true }] });
  assert.equal(b[1].offset, POR_PAGINA);
  const padrao = hubBodies({});
  assert.deepEqual([padrao.length, padrao[0].sort, padrao[0].filters], [3, 'relevance', []]);
  assert.equal(hubBodies({ paginas: 99, ordem: 'invalida' }).length, 10);
  assert.equal(hubBodies({ paginas: 99 })[0].sort, 'relevance');
});

test('Central de Afiliados: lê os cards (título, preço, desconto, vendidos, foto, comissão)', () => {
  const ofertas = parseHubPages(amostraHub());
  assert.equal(ofertas.length, 5);
  const o = ofertas[0];
  assert.deepEqual([o.key, o.title, o.price, o.oldPrice, o.discountPct, o.sold], ['MLB9000001', 'Kit 10 Potes Herméticos de Vidro', 69.9, 159.9, 56, 50000]);
  assert.equal(o.url, 'https://www.mercadolivre.com.br/produto-exemplo/p/MLB9000001');
  assert.match(o.image, /^https:\/\/http2\.mlstatic\.com\/D_NQ_NP_2X_.*-F\.jpg$/);
  assert.equal(o.comissao, 'GANHOS 12%');
  assert.deepEqual([ofertas[1].comissao, ofertas[1].ganhosExtras], ['GANHOS EXTRAS 16%', true]);
  assert.equal(ofertas[3].oldPrice, null, 'sem preço antigo');
  assert.deepEqual([parseVendidos('| +10mil vendidos'), parseVendidos('+500 vendidos'), parseVendidos('4.9')], [10000, 500, 0]);
  // página repetida não duplica; card sem preço é ignorado
  const dup = parseHubPages([...amostraHub(), ...amostraHub(), { polycard_client_model: { polycards: [{ metadata: { id: 'X', url: 'a' }, components: [{ id: 'title', title: { text: 'Sem preço' } }] }] } }]);
  assert.equal(dup.length, 5);
});

test('Central de Afiliados: fluxo completo com filtros e sem repetir', async () => {
  const { db, wa, scheduler } = setup();
  const id = db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id, group_jids, source_type, source_config, min_discount, per_run, interval_min, window_start, window_end, dedupe_days, send_image, created_at)
    VALUES ('Casa', 1, 1, 1, ?, 'afiliados', ?, 40, 2, 60, '00:00', '23:59', 7, 1, ?)`).run(JSON.stringify(['111@g.us']), JSON.stringify({ categoria: 'MLB1574', paginas: 1 }), Date.now()).lastInsertRowid;
  const r = await scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages, r.errors], [2, 2, 0]);
  const titulos = wa.simulated.map((m) => m.text.split('\n')[0]);
  assert.deepEqual(titulos, ['*Kit 10 Potes Herméticos de Vidro*', '*Organizador de Gaveta Dobrável*']); // 56% e 40%; Air Fryer tem 40%, fica para a próxima
  assert.ok(wa.simulated[0].text.includes('+50 mil vendidos') && wa.simulated[0].image, 'vendidos e foto vieram da Central');
  await scheduler.runRule(id);
  assert.equal(wa.simulated.length, 3, 'só a Air Fryer sobrou com 40%+');
  assert.equal(wa.simulated[2].text.split('\n')[0], '*Air Fryer 4L Antiaderente*');
});

test('serviço de links: pedido de ofertas vai para a extensão e volta como lista', async () => {
  const links = createLinkService({ getMode: () => 'extension' });
  await assert.rejects(links.requestOffers({ paginas: [] }), /extensão do Chrome não está conectada/);
  const ext = (async () => {
    const job = await links.poll(1000);
    assert.equal(job.type, 'ofertas'); assert.equal(job.paginas.length, 1);
    links.submit(job.id, { ok: true, data: amostraHub() });
  })();
  await new Promise((r) => setTimeout(r, 20));
  const data = await links.requestOffers({ paginas: hubBodies({ paginas: 1 }) });
  await ext;
  assert.equal(parseHubPages(data).length, 5);
  assert.equal(links.status().lastOffersAt > 0, true);
});

// ---------- várias categorias numa regra ----------
import { hubCategorias } from '../src/afiliados.js';
import { fazerBackup, restaurar } from '../scripts/backup.js';

test('Central de Afiliados: várias categorias geram um pedido por categoria por página, intercalados no resultado', () => {
  assert.deepEqual(hubCategorias({ categoria: 'MLB1' }), ['MLB1'], 'regra antiga com categoria única');
  assert.deepEqual(hubCategorias({ categorias: ['MLB1', 'MLB2', 'MLB1', ''] }), ['MLB1', 'MLB2']);
  assert.deepEqual(hubCategorias({}), [null]);
  const b = hubBodies({ categorias: ['MLB1', 'MLB2'], paginas: 2, mais_vendidos: true });
  assert.equal(b.length, 4);
  assert.deepEqual(b.map((x) => [x.filters[0].value, x.offset]), [['MLB1', 0], ['MLB1', POR_PAGINA], ['MLB2', 0], ['MLB2', POR_PAGINA]]);
  assert.ok(b.every((x) => x.filters.some((f) => f.id === 'best_seller')));

  const pagina = (ids) => ({ polycard_client_model: { polycard_context: { url_prefix: 'https://' }, polycards: ids.map((id) => ({
    metadata: { id, url: `www.mercadolivre.com.br/x/p/${id}` }, pictures: { pictures: [] },
    components: [{ id: 'title', title: { text: 'Produto ' + id } }, { id: 'price', price: { current_price: { value: 10 } } }],
  })) } });
  // 2 categorias × 2 páginas, na ordem que hubBodies pede: A p0, A p1, B p0, B p1
  const paginas = [pagina(['A1', 'A2']), pagina(['A3']), pagina(['B1', 'B2', 'B3']), pagina([])];
  assert.deepEqual(parseHubPages(paginas, 2).map((o) => o.key), ['A1', 'B1', 'A2', 'B2', 'A3', 'B3'], 'intercalado');
  assert.deepEqual(parseHubPages(paginas, 1).map((o) => o.key), ['A1', 'A2', 'A3', 'B1', 'B2', 'B3'], 'uma categoria: ordem original');
  assert.deepEqual(parseHubPages([pagina(['X', 'Y']), pagina(['Y', 'Z'])], 2).map((o) => o.key), ['X', 'Y', 'Z'], 'repetido entre categorias sai uma vez');
});

test('backup: VACUUM INTO + wa_auth, rotação e restauração com integrity_check', () => {
  const dir = tmp(); const db = openDb(dir);
  db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etq', Date.now());
  fs.mkdirSync(path.join(dir, 'wa_auth')); fs.writeFileSync(path.join(dir, 'wa_auth', 'creds.json'), '{}');
  const dest = tmp();
  const arquivos = [];
  for (let i = 0; i < 9; i++) { fs.writeFileSync(path.join(dest, `disparador-2000-01-0${i}-00-00-00.tar.gz`), ''); }
  arquivos.push(fazerBackup(dir, dest));
  const restantes = fs.readdirSync(dest).filter((f) => f.endsWith('.tar.gz'));
  assert.equal(restantes.length, 7, 'mantém só os 7 mais recentes');
  assert.ok(restantes.includes(path.basename(arquivos[0])), 'o novo ficou');
  assert.equal(fs.statSync(arquivos[0]).mode & 0o777, 0o600);
  const r = restaurar(arquivos[0], tmp());
  assert.deepEqual([r.integridade, r.etiquetas, r.waAuth], ['ok', 1, true]);
  db.close();
});

// ---------- várias fontes numa regra ----------
import { candidates } from '../src/ml.js';
import { parseRule } from '../src/db.js';

test('regra com várias fontes: intercala, não repete, fonte que falha vira aviso; regra antiga continua com uma fonte', async () => {
  const links = createLinkService({ getMode: () => 'fake' });
  const avisos = [];
  const rule = { sources: [
    { type: 'list', config: { items: 'https://produto.mercadolivre.com.br/MLB-1-a | A1 | 10\nhttps://produto.mercadolivre.com.br/MLB-2-b | A2 | 10\nhttps://produto.mercadolivre.com.br/MLB-3-c | A3 | 10' } },
    { type: 'afiliados', config: { paginas: 1 } },
    { type: 'search', config: { query: '' } }, // falha: sem palavra-chave
    { type: 'list', config: { items: 'https://produto.mercadolivre.com.br/MLB-1-a | repetido | 10\nhttps://produto.mercadolivre.com.br/MLB-9-z | C1 | 10' } },
  ] };
  const c = await candidates(rule, { links, onWarn: (m) => avisos.push(m) });
  // rodada 0: A1, B1 (o 1º da fonte 4 repete A1 e sai); rodada 1: A2, B2, C1; rodada 2: A3…
  assert.deepEqual(c.slice(0, 6).map((o) => o.key), ['https://produto.mercadolivre.com.br/MLB-1-a', 'MLB9000001', 'https://produto.mercadolivre.com.br/MLB-2-b', 'MLB9000002', 'https://produto.mercadolivre.com.br/MLB-9-z', 'https://produto.mercadolivre.com.br/MLB-3-c']);
  assert.equal(c.length, 3 + 5 + 1);
  assert.equal(avisos.length, 1); assert.match(avisos[0], /fonte 3 \(busca\).*palavra-chave/);
  await assert.rejects(candidates({ sources: [{ type: 'search', config: {} }, { type: 'search', config: {} }] }, { links }), /fonte 1.*fonte 2/);
  // regra antiga (sem coluna sources preenchida) -> uma fonte
  const antiga = parseRule({ id: 1, group_jids: '[]', source_type: 'list', source_config: '{"items":"https://produto.mercadolivre.com.br/MLB-5-e | E | 5"}', sources: null });
  assert.deepEqual(antiga.sources, [{ type: 'list', config: { items: 'https://produto.mercadolivre.com.br/MLB-5-e | E | 5' }, tag_id: null }]);
  assert.equal((await candidates(antiga, { links })).length, 1);
  assert.equal(parseRule({ id: 1, group_jids: '[]', source_type: 'list', source_config: '{}', sources: 'lixo' }).sources.length, 1, 'JSON inválido não quebra');
});

test('envio com duas fontes alterna entre elas e grava sources no banco', async () => {
  const { db, wa, scheduler } = setup();
  const sources = [{ type: 'list', config: { items: 'https://produto.mercadolivre.com.br/MLB-1-a | Fone A | 50 | 100\nhttps://produto.mercadolivre.com.br/MLB-2-b | Mouse B | 30 | 40' } }, { type: 'afiliados', config: { paginas: 1 } }];
  const id = db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id, group_jids, source_type, source_config, sources, per_run, interval_min, window_start, window_end, dedupe_days, send_image, created_at)
    VALUES ('Mista', 1, 1, 1, ?, 'list', '{}', ?, 4, 60, '00:00', '23:59', 7, 1, ?)`).run(JSON.stringify(['111@g.us']), JSON.stringify(sources), Date.now()).lastInsertRowid;
  const r = await scheduler.runRule(id);
  assert.deepEqual([r.offers, r.errors], [4, 0]);
  assert.deepEqual(wa.simulated.map((m) => m.text.split('\n')[0]), ['*Fone A*', '*Kit 10 Potes Herméticos de Vidro*', '*Mouse B*', '*Organizador de Gaveta Dobrável*']);
});

// ---------- título abreviado ----------
import { abreviarTitulo } from '../src/titulo.js';

test('título abreviado: corta compatibilidade e enfeites, respeita o limite sem partir palavra, não termina em conector', () => {
  const longo = 'Fones De Ouvido Usb-c Tipo C Com Microfone Integrado Som Estéreo Alta Qualidade Controle Chamadas Compatível Com iPhone 15 16 17 18 Android Samsung Xiaomi Motorola PLUG & PLAY Premium Eletric Teck';
  const a = abreviarTitulo(longo);
  assert.ok(a.length <= 60, a); assert.ok(!/compat|premium|alta qualidade|plug/i.test(a), a); assert.ok(!/\s(com|de|e|para)$/i.test(a), a);
  assert.equal(a, 'Fones De Ouvido Usb-c Tipo C Com Microfone Integrado');
  assert.equal(abreviarTitulo('Creatina 300g Monohidratada Dark Lab Refil Sem Sabor'), 'Creatina 300g Monohidratada Dark Lab Refil Sem Sabor', 'curto fica igual');
  assert.equal(abreviarTitulo('Carregador de Bateria 12V 6A Bivolt Inteligente Carro Moto Caminhão Automotivo 4Ah a 100Ah Com Função Reparo Display Digital'), 'Carregador de Bateria 12V 6A Bivolt Inteligente Carro Moto');
  assert.equal(abreviarTitulo('Air Fryer 4L Mondial Original Promoção Envio Imediato'), 'Air Fryer 4L Mondial');
  assert.equal(abreviarTitulo('Smartwatch W59 Pro - Preto - Lançamento 2026 - Original'), 'Smartwatch W59 Pro', 'segmento antes do hífen');
  assert.equal(abreviarTitulo('Kit 3 Garrafas Térmicas 500 ml Inox PREMIUM', 30), 'Kit 3 Garrafas Térmicas 500 ml');
  assert.equal(abreviarTitulo('Mouse Gamer RGB 7200 DPI', 0), 'Mouse Gamer RGB 7200 DPI', '0 = não abrevia');
  assert.equal(abreviarTitulo('CAPINHA SILICONE ANTI-IMPACTO Para iPhone 15 Pro Max'), 'Capinha Silicone Anti-impacto', 'palavra gritada vira capitalizada; "Para iPhone" sai');
  assert.equal(abreviarTitulo('Fone A | Mouse B'), 'Fone A | Mouse B', 'letra de modelo no fim fica');
  const t = renderTemplate('*{TITULO_PRODUTO}*\n{TITULO_COMPLETO}\n{LINK}', { title: longo, price: 10, link: 'L' }, { tituloMax: 40 });
  assert.equal(t.split('\n')[0], '*Fones De Ouvido Usb-c Tipo C*'); assert.equal(t.split('\n')[1], longo);
});

test('etiqueta por fonte: cada oferta sai com a etiqueta da fonte de origem; sem etiqueta própria usa a da regra', async () => {
  const { db, wa, scheduler } = setup(); // etiquetas: 1 = etiquetaA, 2 = etiquetaB
  const sources = [
    { type: 'list', tag_id: 2, config: { items: 'https://produto.mercadolivre.com.br/MLB-1-a | Fone A | 50 | 100\nhttps://produto.mercadolivre.com.br/MLB-2-b | Mouse B | 30 | 40' } },
    { type: 'list', tag_id: null, config: { items: 'https://produto.mercadolivre.com.br/MLB-3-c | Teclado C | 200 | 400\nhttps://produto.mercadolivre.com.br/MLB-4-d | Cabo D | 10' } },
  ];
  const id = db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id, group_jids, source_type, source_config, sources, per_run, interval_min, window_start, window_end, dedupe_days, send_image, created_at)
    VALUES ('Duas etiquetas', 1, 1, 1, ?, 'list', '{}', ?, 4, 60, '00:00', '23:59', 7, 1, ?)`).run(JSON.stringify(['111@g.us']), JSON.stringify(sources), Date.now()).lastInsertRowid;
  const prev = await scheduler.previewOffers(id);
  assert.deepEqual(prev.map((o) => [o.fonte, o.etiqueta]), [[1, 'etiquetaB'], [2, 'etiquetaA'], [1, 'etiquetaB'], [2, 'etiquetaA']]);
  const r = await scheduler.runRule(id);
  assert.deepEqual([r.offers, r.errors], [4, 0]);
  const porTitulo = Object.fromEntries(wa.simulated.map((m) => [m.text.split('\n')[0], m.text.match(/fake-(\w+)-/)[1]]));
  assert.deepEqual(porTitulo, { '*Fone A*': 'etiquetaB', '*Mouse B*': 'etiquetaB', '*Teclado C*': 'etiquetaA', '*Cabo D*': 'etiquetaA' });
  assert.match(db.prepare("SELECT message FROM log WHERE level = 'ok' ORDER BY id LIMIT 1").get().message, /etiqueta etiquetaB \(fonte 1\)/);
});

// ---------- grade de horários (plano grade-de-disparos, etapa 3: D3 e D4) ----------
// Relógio fixo (t.mock.timers, só Date): 02/11/2026 é segunda-feira. Os horários vêm da hora local, como no agendador.
const dia = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime();
const relogio = (t, ts) => t.mock.timers.enable({ apis: ['Date'], now: ts });
const comGrade = (db, id, grade, next = null) => db.prepare('UPDATE rules SET grade = ?, next_run_at = ? WHERE id = ?').run(JSON.stringify(grade), next, id);
const linhaRegra = (db, id) => ({ ...db.prepare('SELECT next_run_at, last_run_at, grade FROM rules WHERE id = ?').get(id) });
const avisosDe = (db) => db.prepare("SELECT message FROM log WHERE level = 'aviso' ORDER BY id").all().map((l) => l.message);
const titulos = (wa) => wa.simulated.map((m) => m.text.split('\n')[0]);
const novoTemplate = (db, nome, prefixo) => Number(db.prepare('INSERT INTO templates (name, body, created_at) VALUES (?,?,?)')
  .run(nome, `${prefixo} {TITULO_PRODUTO}\n{LINK}`, Date.now()).lastInsertRowid);
const regraJanela = (db, janela, o = {}) => {
  const id = addRule(db, { name: 'Grade', tag: 1, groups: ['111@g.us'], items: ITEMS, per: 3, ...o });
  db.prepare('UPDATE rules SET window_start = ?, window_end = ? WHERE id = ?').run(janela[0], janela[1], id);
  return id;
};

test('regra sem grade: next_run_at igual ao de antes (intervalo, janela, virada da noite e retry de 60 s)', async (t) => {
  // [janela, agora, intervalo, próximo esperado = alignToWindow(agora + intervalo, janela)]
  const casos = [
    [['08:00', '22:00'], dia(2, 10, 0), 60, dia(2, 11, 0)],
    [['08:00', '22:00'], dia(2, 21, 30), 60, dia(3, 8, 0)],
    [['20:00', '02:00'], dia(2, 1, 30), 45, dia(2, 20, 0)],
    [['20:00', '02:00'], dia(2, 23, 50), 30, dia(3, 0, 20)],
    [['00:00', '00:00'], dia(2, 23, 50), 90, dia(3, 1, 20)],
  ];
  for (const [janela, agora, intervalo, esperado] of casos) {
    const { db, wa, scheduler } = setup();
    relogio(t, agora);
    const id = regraJanela(db, janela, { per: 1, interval: intervalo });
    await scheduler.runRule(id);
    assert.equal(wa.simulated.length, 1);
    assert.equal(esperado, alignToWindow(agora + intervalo * 60000, janela[0], janela[1]), 'o esperado é a fórmula de hoje');
    assert.deepEqual(linhaRegra(db, id), { next_run_at: esperado, last_run_at: agora, grade: null }, `${janela} ${new Date(agora)}`);
    t.mock.timers.reset();
  }
  // WhatsApp fora: tenta de novo em 60 s
  const { db, wa, scheduler } = setup();
  relogio(t, dia(2, 10, 0));
  const id = regraJanela(db, ['08:00', '22:00']);
  wa.isReady = () => false;
  await scheduler.runRule(id);
  assert.equal(linhaRegra(db, id).next_run_at, dia(2, 10, 0) + 60000);
  // pelo tick, fora da janela: só realinha, sem enviar; WhatsApp fora dentro da janela: não mexe
  wa.isReady = () => true;
  t.mock.timers.setTime(dia(2, 23, 0));
  db.prepare('UPDATE rules SET next_run_at = NULL WHERE id = ?').run(id);
  await scheduler.tick();
  assert.equal(wa.simulated.length, 0);
  assert.equal(linhaRegra(db, id).next_run_at, dia(3, 8, 0));
  t.mock.timers.setTime(dia(3, 8, 1));
  wa.isReady = () => false;
  await scheduler.tick();
  assert.equal(linhaRegra(db, id).next_run_at, dia(3, 8, 0), 'WhatsApp fora: o tick não mexe');
  wa.isReady = () => true;
  await scheduler.tick();
  assert.equal(wa.simulated.length, 3, 'per_run da regra');
  assert.equal(linhaRegra(db, id).next_run_at, dia(3, 9, 1));
  assert.deepEqual(avisosDe(db), [], 'regra sem grade não ganha aviso novo');
});

test('grade: next_run_at NULL não envia e grava o próximo horário; no futuro, espera', async (t) => {
  const { db, wa, scheduler } = setup();
  relogio(t, dia(2, 9, 5));
  const id = regraJanela(db, ['00:00', '23:59']);
  comGrade(db, id, { dias: [0, 1, 2, 3, 4, 5, 6], horarios: [{ hora: '09:00', qtd: 1, template_id: null }, { hora: '12:00', qtd: 2, template_id: null }] });
  await scheduler.tick();
  assert.equal(wa.simulated.length, 0, 'o 09:00 que passou não sai');
  assert.equal(linhaRegra(db, id).next_run_at, dia(2, 12, 0));
  t.mock.timers.setTime(dia(2, 11, 59));
  await scheduler.tick();
  assert.equal(wa.simulated.length, 0);
  assert.equal(linhaRegra(db, id).next_run_at, dia(2, 12, 0));
  assert.deepEqual(avisosDe(db), []);
  // só nos dias marcados: segunda (1) e quarta (3); 12:00 de segunda já passou → quarta 09:00
  comGrade(db, id, { dias: [1, 3], horarios: [{ hora: '09:00', qtd: 1, template_id: null }] });
  t.mock.timers.setTime(dia(2, 12, 30));
  await scheduler.tick();
  assert.equal(linhaRegra(db, id).next_run_at, dia(4, 9, 0));
  // grade sem horário que valha (só um banco editado à mão): nunca envia nem trava o tick
  comGrade(db, id, {});
  await scheduler.tick();
  assert.deepEqual([wa.simulated.length, linhaRegra(db, id).next_run_at], [0, null]);
});

test('grade: horário vencido sai com a quantidade e o template da linha, e o próximo é o horário seguinte', async (t) => {
  const { db, wa, scheduler } = setup();
  const rapido = novoTemplate(db, 'Rápido', 'RAPIDO');
  relogio(t, dia(2, 10, 0) + 5000);
  const id = regraJanela(db, ['00:00', '23:59'], { per: 5 });
  db.prepare("UPDATE rules SET group_jids = '[\"111@g.us\",\"222@g.us\"]' WHERE id = ?").run(id);
  comGrade(db, id, { dias: [0, 1, 2, 3, 4, 5, 6], horarios: [
    { hora: '09:00', qtd: 1, template_id: null }, { hora: '10:00', qtd: 2, template_id: rapido },
  ] }, dia(2, 10, 0));
  await scheduler.tick();
  assert.equal(wa.simulated.length, 4, '2 ofertas (não as 5 da regra) × 2 grupos');
  assert.ok(titulos(wa).every((l) => l.startsWith('RAPIDO ')), 'template da linha');
  assert.deepEqual(linhaRegra(db, id), { next_run_at: dia(3, 9, 0), last_run_at: dia(2, 10, 0) + 5000, grade: linhaRegra(db, id).grade });
  // o 09:00 do dia seguinte: 1 oferta com o template da regra
  t.mock.timers.setTime(dia(3, 9, 0) + 1000);
  await scheduler.tick();
  assert.equal(wa.simulated.length, 6);
  assert.ok(titulos(wa).slice(4).every((l) => /^\*.+\*$/.test(l)), 'template padrão da regra');
  assert.equal(linhaRegra(db, id).next_run_at, dia(3, 10, 0));
  assert.deepEqual(avisosDe(db), []);
});

test('grade: a janela "Funciona das/até" não vale, e o tick não realinha a regra', async (t) => {
  const { db, wa, scheduler } = setup();
  relogio(t, dia(2, 9, 0) + 1000);
  const id = regraJanela(db, ['22:00', '23:00']);
  comGrade(db, id, { dias: [0, 1, 2, 3, 4, 5, 6], horarios: [{ hora: '09:00', qtd: 1, template_id: null }, { hora: '15:30', qtd: 2, template_id: null }] }, dia(2, 9, 0));
  await scheduler.tick();
  assert.equal(wa.simulated.length, 1, 'fora da janela antiga, sai mesmo assim');
  assert.equal(linhaRegra(db, id).next_run_at, dia(2, 15, 30), 'sem alignToWindow (seria 22:00)');
  t.mock.timers.setTime(dia(2, 15, 30));
  await scheduler.tick();
  assert.equal(wa.simulated.length, 3);
  assert.equal(linhaRegra(db, id).next_run_at, dia(3, 9, 0));
});

test('grade: atraso de 29 min sai; de 31 min pula com aviso; vários vencidos saem só o último', async (t) => {
  const { db, wa, scheduler } = setup();
  const grade = { dias: [0, 1, 2, 3, 4, 5, 6], horarios: [
    { hora: '08:00', qtd: 1, template_id: null }, { hora: '08:30', qtd: 1, template_id: null },
    { hora: '09:00', qtd: 2, template_id: null }, { hora: '10:00', qtd: 1, template_id: null },
  ] };
  relogio(t, dia(2, 9, 29));
  const id = regraJanela(db, ['00:00', '23:59']);
  comGrade(db, id, grade, dia(2, 9, 0));
  await scheduler.tick();
  assert.equal(wa.simulated.length, 2, '29 min: o 09:00 sai');
  assert.equal(linhaRegra(db, id).next_run_at, dia(2, 10, 0));

  t.mock.timers.setTime(dia(2, 10, 31));
  await scheduler.tick();
  assert.equal(wa.simulated.length, 2, '31 min: o 10:00 não sai');
  assert.deepEqual(avisosDe(db), ['Horário 10:00 pulado: o programa estava desligado, o WhatsApp desconectado ou outro envio demorou. Próximo: 08:00 de 03/11.']);
  assert.equal(linhaRegra(db, id).next_run_at, dia(3, 8, 0));

  // programa desligado das 07:00 às 09:10: 08:00 e 08:30 pulados, o 09:00 (10 min) sai sozinho, com a qtd dele
  t.mock.timers.setTime(dia(3, 9, 10));
  await scheduler.tick();
  assert.equal(wa.simulated.length, 4, 'só o mais recente, sem rajada');
  assert.equal(avisosDe(db).at(-1), '2 horários pulados (08:00 a 08:30): o programa estava desligado, o WhatsApp desconectado ou outro envio demorou. O das 09:00 sai agora.');
  assert.equal(linhaRegra(db, id).next_run_at, dia(3, 10, 0));
  t.mock.timers.setTime(dia(3, 9, 30));
  await scheduler.tick();
  assert.equal(wa.simulated.length, 4, 'nada sai antes do próximo');
});

test('grade: com o WhatsApp fora o horário fica guardado; passados 30 min, é pulado com aviso', async (t) => {
  const { db, wa, scheduler } = setup();
  relogio(t, dia(2, 9, 5));
  const id = regraJanela(db, ['00:00', '23:59']);
  comGrade(db, id, { dias: [0, 1, 2, 3, 4, 5, 6], horarios: [{ hora: '09:00', qtd: 1, template_id: null }, { hora: '11:00', qtd: 1, template_id: null }] }, dia(2, 9, 0));
  wa.isReady = () => false;
  await scheduler.tick();
  assert.equal(linhaRegra(db, id).next_run_at, dia(2, 9, 0), 'mantém o horário');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM log').get().n, 0, 'sem linha de erro a cada tick');
  wa.isReady = () => true;
  t.mock.timers.setTime(dia(2, 9, 20));
  await scheduler.tick();
  assert.equal(wa.simulated.length, 1, 'voltou dentro dos 30 min: sai');
  assert.equal(linhaRegra(db, id).next_run_at, dia(2, 11, 0));

  wa.isReady = () => false;
  t.mock.timers.setTime(dia(2, 11, 31));
  await scheduler.tick();
  assert.equal(wa.simulated.length, 1);
  assert.match(avisosDe(db).at(-1), /^Horário 11:00 pulado: .* Próximo: 09:00 de 03\/11\.$/);
  assert.equal(linhaRegra(db, id).next_run_at, dia(3, 9, 0));

  // runRule com o WhatsApp fora (corrida com o tick): o horário vencido fica, como o retry de 60 s do intervalo
  t.mock.timers.setTime(dia(3, 9, 1));
  await scheduler.runRule(id, { horario: dia(3, 9, 0) });
  assert.equal(linhaRegra(db, id).next_run_at, dia(3, 9, 0));
  assert.match(db.prepare("SELECT message FROM log WHERE level = 'erro' ORDER BY id DESC").get().message, /WhatsApp desconectado/);
  // 09:00 pulado e o 11:00 vencido há 10 min com o WhatsApp fora: o aviso não promete que ele sai agora
  t.mock.timers.setTime(dia(3, 11, 10));
  await scheduler.tick();
  assert.equal(avisosDe(db).at(-1), `Horário 09:00 pulado: ${'o programa estava desligado, o WhatsApp desconectado ou outro envio demorou.'} Próximo: 11:00.`);
  assert.deepEqual([wa.simulated.length, linhaRegra(db, id).next_run_at], [1, dia(3, 11, 0)]);
});

test('grade: template da linha apagado sai com o template da regra e deixa aviso', async (t) => {
  const { db, wa, scheduler } = setup();
  const rapido = novoTemplate(db, 'Rápido', 'RAPIDO');
  relogio(t, dia(2, 10, 0));
  const id = regraJanela(db, ['00:00', '23:59']);
  comGrade(db, id, { dias: [0, 1, 2, 3, 4, 5, 6], horarios: [{ hora: '10:00', qtd: 2, template_id: rapido }] }, dia(2, 10, 0));
  db.prepare('DELETE FROM templates WHERE id = ?').run(rapido);
  await scheduler.tick();
  assert.equal(wa.simulated.length, 2);
  assert.ok(titulos(wa).every((l) => /^\*.+\*$/.test(l)), 'template da regra');
  assert.deepEqual(avisosDe(db), ['Horário 10:00: o template escolhido para este horário não existe mais. As ofertas saíram com o template da regra.']);
  assert.equal(linhaRegra(db, id).next_run_at, dia(3, 10, 0));
  // "Enviar agora" com a mesma linha: o mesmo aviso, sem dizer que o horário saiu
  t.mock.timers.setTime(dia(2, 10, 30));
  await scheduler.runRule(id, { manual: true });
  assert.equal(wa.simulated.length, 4);
  assert.equal(avisosDe(db).at(-1), 'Enviar agora (como no horário das 10:00): o template escolhido para este horário não existe mais. As ofertas saíram com o template da regra.');
});

test('grade editada à mão no banco com quantidade ou template fora de forma não trava o tick', async (t) => {
  const { db, wa, scheduler } = setup();
  relogio(t, dia(2, 10, 0));
  const id = regraJanela(db, ['00:00', '23:59'], { per: 2 });
  const outra = addRule(db, { name: 'Outra', tag: 1, groups: ['222@g.us'], items: ITEMS, per: 1 });
  comGrade(db, id, { horarios: [null, { hora: '10:00', qtd: 'muitas', template_id: { x: 1 } }], dias: [0, 1, 2, 3, 4, 5, 6] }, dia(2, 10, 0));
  await scheduler.tick();
  assert.equal(wa.simulated.filter((m) => m.jid === '111@g.us').length, 2, 'per_run e o template da regra');
  assert.equal(wa.simulated.filter((m) => m.jid === '222@g.us').length, 1, 'a regra seguinte também roda');
  assert.equal(linhaRegra(db, id).next_run_at, dia(3, 10, 0));
  assert.ok(linhaRegra(db, outra).next_run_at > dia(2, 10, 0));
});

test('grade: com menos ofertas que o pedido, sai o que houver com aviso "saíram N de M"; com 0, a mensagem de hoje', async (t) => {
  const { db, wa, scheduler } = setup();
  relogio(t, dia(2, 10, 0));
  const id = regraJanela(db, ['00:00', '23:59']);
  comGrade(db, id, { dias: [0, 1, 2, 3, 4, 5, 6], horarios: [{ hora: '10:00', qtd: 8, template_id: null }, { hora: '11:00', qtd: 2, template_id: null }] }, dia(2, 10, 0));
  await scheduler.tick();
  assert.equal(wa.simulated.length, 5);
  assert.deepEqual(avisosDe(db), ['Horário 10:00: saíram 5 de 8 ofertas; não havia mais ofertas novas dentro dos filtros.']);
  t.mock.timers.setTime(dia(2, 11, 0));
  await scheduler.tick();
  assert.equal(wa.simulated.length, 5);
  assert.equal(avisosDe(db).length, 1, 'sem "saíram 0 de 2"');
  assert.equal(db.prepare('SELECT message FROM log ORDER BY id DESC').get().message, 'Sem ofertas novas dentro dos filtros desta vez.');
  assert.equal(linhaRegra(db, id).next_run_at, dia(3, 10, 0), 'não acumula para o próximo');
});

test('grade: "Enviar agora" usa a linha do próximo horário e não mexe no próximo horário', async (t) => {
  const { db, wa, scheduler } = setup();
  const rapido = novoTemplate(db, 'Rápido', 'RAPIDO');
  relogio(t, dia(2, 9, 30));
  const id = regraJanela(db, ['00:00', '23:59'], { per: 4 });
  comGrade(db, id, { dias: [0, 1, 2, 3, 4, 5, 6], horarios: [{ hora: '09:00', qtd: 1, template_id: null }, { hora: '10:00', qtd: 2, template_id: rapido }] }, dia(2, 10, 0));
  const r = await scheduler.runRule(id, { manual: true });
  assert.deepEqual([r.offers, wa.simulated.length], [2, 2]);
  assert.ok(titulos(wa).every((l) => l.startsWith('RAPIDO ')));
  assert.deepEqual([linhaRegra(db, id).next_run_at, linhaRegra(db, id).last_run_at], [dia(2, 10, 0), dia(2, 9, 30)]);
  // o 10:00 sai no horário, mesmo depois do "Enviar agora"
  t.mock.timers.setTime(dia(2, 10, 0));
  await scheduler.tick();
  assert.equal(wa.simulated.length, 4);
  assert.equal(linhaRegra(db, id).next_run_at, dia(3, 9, 0));
  // sem próximo gravado (regra acabou de ser salva): o manual não grava nada; o tick calcula sem enviar
  db.prepare('UPDATE rules SET next_run_at = NULL WHERE id = ?').run(id);
  t.mock.timers.setTime(dia(2, 10, 30));
  await scheduler.runRule(id, { manual: true });
  assert.equal(wa.simulated.length, 5, 'linha do 09:00 de amanhã: 1 oferta');
  assert.equal(linhaRegra(db, id).next_run_at, null);
  await scheduler.tick();
  assert.deepEqual([wa.simulated.length, linhaRegra(db, id).next_run_at], [5, dia(3, 9, 0)]);
});

test('grade: com um horário vencido guardado (WhatsApp fora), "Enviar agora" e a prévia usam a linha dele, como o cartão', async (t) => {
  const { db, wa, scheduler } = setup();
  const rapido = novoTemplate(db, 'Rápido', 'RAPIDO');
  relogio(t, dia(2, 10, 5));
  const id = regraJanela(db, ['00:00', '23:59'], { per: 4 });
  comGrade(db, id, { dias: [0, 1, 2, 3, 4, 5, 6], horarios: [{ hora: '10:00', qtd: 2, template_id: rapido }, { hora: '11:00', qtd: 1, template_id: null }] }, dia(2, 10, 0));
  const prev = await scheduler.previewOffers(id);
  assert.equal(prev.length, 2);
  assert.ok(prev.every((o) => o.text.startsWith('RAPIDO ')), 'linha das 10:00');
  await scheduler.runRule(id, { manual: true });
  assert.equal(wa.simulated.length, 2);
  assert.equal(linhaRegra(db, id).next_run_at, dia(2, 10, 0), 'o 10:00 continua para o tick');
  // passada a tolerância, vale o primeiro horário depois de agora (11:00: 1 oferta, template da regra)
  t.mock.timers.setTime(dia(2, 10, 31));
  const depois = await scheduler.previewOffers(id);
  assert.equal(depois.length, 1);
  assert.ok(depois[0].text.startsWith('*'));
});

test('grade: regra salva no meio da execução não tem o próximo horário sobrescrito', async (t) => {
  const { db, links, scheduler } = setup();
  relogio(t, dia(2, 10, 0));
  const id = regraJanela(db, ['00:00', '23:59']);
  comGrade(db, id, { dias: [0, 1, 2, 3, 4, 5, 6], horarios: [{ hora: '10:00', qtd: 1, template_id: null }] }, dia(2, 10, 0));
  const pedir = links.requestLink;
  links.requestLink = async (o) => { db.prepare('UPDATE rules SET next_run_at = NULL WHERE id = ?').run(id); return pedir(o); }; // o PUT zera
  await scheduler.tick();
  assert.equal(linhaRegra(db, id).next_run_at, null, 'o tick seguinte calcula com a grade nova');
  assert.equal(linhaRegra(db, id).last_run_at, dia(2, 10, 0));
});

test('grade: a prévia ("Ver ofertas") usa a quantidade e o template do próximo horário', async (t) => {
  const { db, scheduler } = setup();
  const rapido = novoTemplate(db, 'Rápido', 'RAPIDO');
  relogio(t, dia(2, 9, 30));
  const id = regraJanela(db, ['00:00', '23:59'], { per: 4 });
  assert.equal((await scheduler.previewOffers(id)).length, 4, 'sem grade: per_run');
  comGrade(db, id, { dias: [0, 1, 2, 3, 4, 5, 6], horarios: [{ hora: '09:00', qtd: 1, template_id: null }, { hora: '10:00', qtd: 2, template_id: rapido }] }, dia(2, 10, 0));
  const prev = await scheduler.previewOffers(id);
  assert.equal(prev.length, 2);
  assert.ok(prev.every((o) => o.text.startsWith('RAPIDO ')));
  db.prepare('DELETE FROM templates WHERE id = ?').run(rapido);
  assert.ok((await scheduler.previewOffers(id)).every((o) => o.text.startsWith('*')), 'template apagado: o da regra');
  assert.deepEqual(avisosDe(db), [], 'a prévia não escreve no Histórico');
});
