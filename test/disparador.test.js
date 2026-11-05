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

// ---------- rastreio por grupo nas regras (plano dashboard-ganhos, etapa 8; CA1, CA3, CA4, CA9) ----------
import { salvar as salvarRastreio } from '../src/rastreio.js';
import { createCatalogoItens } from '../src/catalogo-itens.js';
import { createAmazon } from '../src/amazon.js';
import { paraCandidato } from '../src/catalogo.js';
import * as mlPadrao from '../src/ml.js';

/** Linhas de rastreio_envios, sem id nem hora (objetos comuns: o node:sqlite devolve sem protótipo). */
const linhasRastreio = (db) => db.prepare(`SELECT jid, loja, origem, rule_id, envio_id, oferta_chave, link, codigo, nivel, bloco_id, esperado, motivo
  FROM rastreio_envios ORDER BY id`).all().map((l) => ({ ...l }));
const logsDaRegra = (db, id) => db.prepare('SELECT level, group_name, offer_title, message FROM log WHERE rule_id = ? ORDER BY id').all(id).map((l) => ({ ...l }));
const enviadasDaRegra = (db, id) => db.prepare('SELECT offer_key FROM sent_offers WHERE rule_id = ? ORDER BY id').all(id).map((l) => l.offer_key);
const linkDoTexto = (texto) => texto.match(/https:\/\/\S+/g).at(-1);
/** Conta os pedidos de link (a etiqueta de cada um) e faz falhar as etiquetas de `falhar`. */
function espiarLinks(links, falhar = new Set()) {
  const pedidos = []; const original = links.requestLink;
  links.requestLink = async (p) => {
    pedidos.push(p.tag);
    if (falhar.has(p.tag)) throw new Error(`a etiqueta ${p.tag} foi recusada`);
    return original(p);
  };
  return pedidos;
}
const bloco = (db, nome, jids) => {
  const id = Number(db.prepare('INSERT INTO blocks (name, created_at) VALUES (?, ?)').run(nome, Date.now()).lastInsertRowid);
  for (const jid of jids) db.prepare('INSERT INTO block_groups (block_id, jid) VALUES (?, ?)').run(id, jid);
  return id;
};
const ITEM1 = 'https://produto.mercadolivre.com.br/MLB-1000001-a | Fone A | 50 | 100';
const ITEM2 = 'https://produto.mercadolivre.com.br/MLB-1000002-b | Mouse B | 30 | 40';
const TODOS = ['111@g.us', '222@g.us', '333@g.us'];

test('rastreio, CA9: regra sem associação pede 1 link por oferta, mantém ordem, log e sent_offers, e grava 1 linha por grupo (padrão)', async () => {
  const { db, wa, links, scheduler } = setup();
  const pedidos = espiarLinks(links);
  const id = addRule(db, { name: 'Sem rastreio', tag: 2, groups: TODOS, items: `${ITEM1}\n${ITEM2}`, per: 2 });
  const r = await scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages, r.errors], [2, 6, 0]);
  assert.deepEqual(pedidos, ['etiquetaB', 'etiquetaB'], 'um pedido por oferta, como hoje');
  assert.deepEqual(wa.simulated.map((m) => m.jid), [...TODOS, ...TODOS], 'mesma ordem de grupos');
  // as 3 mensagens de uma oferta têm o mesmo texto (um link só)
  assert.equal(new Set(wa.simulated.slice(0, 3).map((m) => m.text)).size, 1);
  assert.equal(new Set(wa.simulated.slice(3).map((m) => m.text)).size, 1);
  assert.deepEqual(logsDaRegra(db, id), [
    ...['Achadinhos', 'Tech', 'Casa'].map((g) => ({ level: 'ok', group_name: g, offer_title: 'Fone A', message: 'Enviado com a etiqueta etiquetaB' })),
    ...['Achadinhos', 'Tech', 'Casa'].map((g) => ({ level: 'ok', group_name: g, offer_title: 'Mouse B', message: 'Enviado com a etiqueta etiquetaB' })),
  ]);
  assert.equal(enviadasDaRegra(db, id).length, 2);
  const linhas = linhasRastreio(db);
  assert.deepEqual(linhas.map((l) => l.jid), [...TODOS, ...TODOS]);
  assert.deepEqual(linhas[0], {
    jid: '111@g.us', loja: 'mercadolivre', origem: 'regra', rule_id: Number(id), envio_id: null, oferta_chave: enviadasDaRegra(db, id)[0],
    link: linkDoTexto(wa.simulated[0].text), codigo: 'etiquetaB', nivel: 'padrao', bloco_id: null, esperado: 0, motivo: null,
  });
  assert.ok(linhas.every((l, i) => l.link === linkDoTexto(wa.simulated[i].text) && l.nivel === 'padrao' && l.esperado === 0 && l.codigo === 'etiquetaB'));
});

test('rastreio, CA4/P1: etiqueta do grupo vence a da regra e da fonte; mesmo código reaproveita o link; ordem dos grupos não muda', async () => {
  const { db, wa, links, scheduler } = setup();
  db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etiquetaC', Date.now());
  salvarRastreio(db, { loja: 'mercadolivre', alvo_tipo: 'grupo', alvo: '222@g.us', codigo: 'etiquetaB' });
  const b = bloco(db, 'Casa e tech', ['333@g.us']);
  salvarRastreio(db, { loja: 'mercadolivre', alvo_tipo: 'bloco', alvo: String(b), codigo: 'etiquetaC' });
  const pedidos = espiarLinks(links);
  // a fonte tem etiqueta própria (etiquetaA); a regra, etiquetaB
  const sources = [{ type: 'list', tag_id: 1, config: { items: ITEM1 } }];
  const id = Number(db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id, group_jids, source_type, source_config, sources, per_run, interval_min, window_start, window_end, dedupe_days, send_image, created_at)
    VALUES ('Rastreada', 1, 2, 1, ?, 'list', '{}', ?, 1, 60, '00:00', '23:59', 7, 1, ?)`).run(JSON.stringify(TODOS), JSON.stringify(sources), Date.now()).lastInsertRowid);
  const r = await scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages, r.errors], [1, 3, 0]);
  assert.deepEqual(pedidos, ['etiquetaA', 'etiquetaB', 'etiquetaC'], 'um pedido por código distinto, na ordem do 1º grupo');
  assert.deepEqual(wa.simulated.map((m) => m.jid), TODOS);
  assert.deepEqual(wa.simulated.map((m) => m.text.match(/fake-(\w+)-/)[1]), ['etiquetaA', 'etiquetaB', 'etiquetaC']);
  assert.deepEqual(logsDaRegra(db, id).map((l) => [l.group_name, l.message]), [
    ['Achadinhos', 'Enviado com a etiqueta etiquetaA'], ['Tech', 'Enviado com a etiqueta etiquetaB'], ['Casa', 'Enviado com a etiqueta etiquetaC'],
  ]);
  assert.deepEqual(linhasRastreio(db).map((l) => [l.jid, l.codigo, l.nivel, l.bloco_id, l.esperado, l.motivo]), [
    ['111@g.us', 'etiquetaA', 'padrao', null, 0, null],
    ['222@g.us', 'etiquetaB', 'grupo', null, 1, null],
    ['333@g.us', 'etiquetaC', 'bloco', b, 1, null],
  ]);
  assert.ok(linhasRastreio(db).every((l, i) => l.link === linkDoTexto(wa.simulated[i].text)));

  // associação com a mesma etiqueta do padrão: um pedido só, o mesmo link para todos
  const s2 = setup();
  salvarRastreio(s2.db, { loja: 'mercadolivre', alvo_tipo: 'grupo', alvo: '222@g.us', codigo: 'etiquetaA' });
  const pedidos2 = espiarLinks(s2.links);
  const id2 = addRule(s2.db, { name: 'Igual', tag: 1, groups: TODOS, items: ITEM1, per: 1 });
  await s2.scheduler.runRule(id2);
  assert.deepEqual(pedidos2, ['etiquetaA']);
  assert.equal(new Set(s2.wa.simulated.map((m) => m.text)).size, 1);
  assert.deepEqual(linhasRastreio(s2.db).map((l) => [l.jid, l.nivel, l.esperado]), [['111@g.us', 'padrao', 0], ['222@g.us', 'grupo', 1], ['333@g.us', 'padrao', 0]]);
});

test('rastreio, CA9: etiqueta associada que falha cai no link padrão da regra (nunca link comum), com motivo falha_link', async () => {
  const { db, wa, links, scheduler } = setup();
  salvarRastreio(db, { loja: 'mercadolivre', alvo_tipo: 'grupo', alvo: '222@g.us', codigo: 'etiquetaB' });
  const pedidos = espiarLinks(links, new Set(['etiquetaB']));
  const id = addRule(db, { name: 'Falha associada', tag: 1, groups: TODOS, items: ITEM1, per: 1 });
  const r = await scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages, r.errors], [1, 3, 0]);
  assert.deepEqual(pedidos, ['etiquetaA', 'etiquetaB']);
  assert.deepEqual(wa.simulated.map((m) => m.jid), TODOS);
  assert.ok(wa.simulated.every((m) => /https:\/\/meli\.la\/fake-etiquetaA-/.test(m.text)), 'todos com o link de afiliado da regra');
  assert.deepEqual(linhasRastreio(db).map((l) => [l.jid, l.codigo, l.nivel, l.esperado, l.motivo]), [
    ['111@g.us', 'etiquetaA', 'padrao', 0, null],
    ['222@g.us', 'etiquetaA', 'padrao', 1, 'falha_link'],
    ['333@g.us', 'etiquetaA', 'padrao', 0, null],
  ]);
  const logs = logsDaRegra(db, id);
  assert.ok(logs.some((l) => l.level === 'aviso' && l.offer_title === 'Fone A' && /etiquetaB/.test(l.message) && /a etiqueta etiquetaB foi recusada/.test(l.message)), 'aviso da etiqueta que falhou');
  assert.deepEqual(logs.filter((l) => l.level === 'ok').map((l) => l.message), Array(3).fill('Enviado com a etiqueta etiquetaA'));
  assert.equal(enviadasDaRegra(db, id).length, 1);
});

test('rastreio: falha do link padrão com associação ok — só os grupos do padrão falham; sem associação, nada sai (como hoje)', async () => {
  const { db, wa, links, scheduler } = setup();
  salvarRastreio(db, { loja: 'mercadolivre', alvo_tipo: 'grupo', alvo: '222@g.us', codigo: 'etiquetaB' });
  const pedidos = espiarLinks(links, new Set(['etiquetaA']));
  const id = addRule(db, { name: 'Padrão falha', tag: 1, groups: TODOS, items: ITEM1, per: 1 });
  const r = await scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages, r.errors], [1, 1, 2]);
  assert.deepEqual(pedidos, ['etiquetaA', 'etiquetaB'], 'o padrão não é pedido duas vezes');
  assert.deepEqual(wa.simulated.map((m) => m.jid), ['222@g.us']);
  assert.match(wa.simulated[0].text, /https:\/\/meli\.la\/fake-etiquetaB-/);
  assert.deepEqual(logsDaRegra(db, id).map((l) => [l.level, l.group_name, l.message]), [
    ['erro', 'Achadinhos', 'Link de afiliado não gerado: a etiqueta etiquetaA foi recusada'],
    ['ok', 'Tech', 'Enviado com a etiqueta etiquetaB'],
    ['erro', 'Casa', 'Link de afiliado não gerado: a etiqueta etiquetaA foi recusada'],
  ]);
  assert.deepEqual(linhasRastreio(db).map((l) => [l.jid, l.codigo, l.nivel, l.esperado]), [['222@g.us', 'etiquetaB', 'grupo', 1]]);
  assert.equal(enviadasDaRegra(db, id).length, 1, 'saiu para um grupo: conta como enviada (como uma falha de envio hoje)');

  // sem associação e o link falha: a mensagem de hoje, nada enviado nem gravado
  const s2 = setup();
  espiarLinks(s2.links, new Set(['etiquetaA']));
  const id2 = addRule(s2.db, { name: 'Sem link', tag: 1, groups: TODOS, items: ITEM1, per: 1 });
  const r2 = await s2.scheduler.runRule(id2);
  assert.deepEqual([r2.offers, r2.messages, r2.errors], [0, 0, 1]);
  assert.deepEqual(logsDaRegra(s2.db, id2), [{ level: 'erro', group_name: null, offer_title: 'Fone A', message: 'Link de afiliado não gerado: a etiqueta etiquetaA foi recusada' }]);
  assert.deepEqual([s2.wa.simulated.length, linhasRastreio(s2.db).length, enviadasDaRegra(s2.db, id2).length], [0, 0, 0]);
});

test('rastreio: etiqueta associada que foi apagada usa a da regra, com esperado=1 e motivo etiqueta_apagada', async () => {
  const { db, wa, links, scheduler } = setup();
  db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etiquetaC', Date.now());
  salvarRastreio(db, { loja: 'mercadolivre', alvo_tipo: 'grupo', alvo: '222@g.us', codigo: 'etiquetaC' });
  db.prepare("DELETE FROM tags WHERE name = 'etiquetaC'").run();
  const pedidos = espiarLinks(links);
  const id = addRule(db, { name: 'Apagada', tag: 1, groups: TODOS, items: ITEM1, per: 1 });
  await scheduler.runRule(id);
  assert.deepEqual(pedidos, ['etiquetaA'], 'a etiqueta apagada nem é pedida');
  assert.equal(new Set(wa.simulated.map((m) => m.text)).size, 1);
  assert.deepEqual(linhasRastreio(db).map((l) => [l.jid, l.codigo, l.nivel, l.esperado, l.motivo]), [
    ['111@g.us', 'etiquetaA', 'padrao', 0, null], ['222@g.us', 'etiquetaA', 'padrao', 1, 'etiqueta_apagada'], ['333@g.us', 'etiquetaA', 'padrao', 0, null],
  ]);
});

test('rastreio, CA1: grupo que falhou no envio não ganha linha; os outros ganham', async () => {
  const { db, wa, scheduler } = setup();
  const sendText = wa.sendText;
  wa.sendText = async (jid, texto) => { if (jid === '222@g.us') throw new Error('grupo fora do ar'); return sendText(jid, texto); };
  const id = addRule(db, { name: 'Um falha', tag: 1, groups: TODOS, items: ITEM1, per: 1 });
  const r = await scheduler.runRule(id);
  assert.deepEqual([r.messages, r.errors], [2, 1]);
  assert.deepEqual(linhasRastreio(db).map((l) => l.jid), ['111@g.us', '333@g.us']);
});

/** Regra com a fonte catálogo e um Etiqueta falso em memória (o ml.candidates real chama catalogo.candidatos). */
function setupCatalogo(ofertas, { tagAmazon = 'achadinho-20' } = {}) {
  const s = setup();
  const conexaoAmazon = { tag: tagAmazon };
  const amazon = createAmazon({ db: s.db, fetch: async () => { throw new Error('rede proibida (Amazon)'); }, esperar: async () => {}, lerConexao: () => conexaoAmazon });
  const catalogo = { candidatos: async () => ofertas.map(paraCandidato) };
  const catalogoItens = createCatalogoItens({ db: s.db, wa: s.wa, links: s.links, amazon });
  const scheduler = createScheduler({ db: s.db, wa: s.wa, links: s.links, ml: mlPadrao, fast: true, amazon, catalogo, catalogoItens });
  const regraCat = (lojas, tag = 1) => Number(s.db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id, group_jids, source_type, source_config, sources, per_run, interval_min, window_start, window_end, dedupe_days, send_image, created_at)
    VALUES ('Catálogo', 1, ?, 1, ?, 'list', '{}', ?, 3, 60, '00:00', '23:59', 7, 0, ?)`)
    .run(tag, JSON.stringify(TODOS), JSON.stringify([{ type: 'catalogo', tag_id: null, config: { ordem: 'relevancia', lojas } }]), Date.now()).lastInsertRowid);
  return { ...s, scheduler, amazon, conexaoAmazon, regraCat };
}
const ofertaCat = (i, loja) => ({
  id: i, loja, titulo: `Produto ${i}`, preco: 100, preco_antigo: 150, desconto_pct: 33, categoria: 'Casa',
  ...(loja === 'amazon' ? { item_id: `B0${String(i).padStart(8, '0')}`, link: 'https://www.amazon.com.br/dp/X?tag=terceiro-20' } : { item_id: `MLB${4000000000 + i}`, link: 'https://meli.la/TerCeiro1' }),
});

test('rastreio, CA3: Amazon do catálogo usa o ID de rastreamento do bloco; sem associação, a tag de Conexões; nunca sem tag', async () => {
  const s = setupCatalogo([ofertaCat(1, 'amazon')]);
  const b = bloco(s.db, 'Bloco 1', ['222@g.us', '333@g.us']);
  salvarRastreio(s.db, { loja: 'amazon', alvo_tipo: 'bloco', alvo: String(b), codigo: 'turbob1-20' });
  salvarRastreio(s.db, { loja: 'amazon', alvo_tipo: 'grupo', alvo: '333@g.us', codigo: 'casa333-20' });
  const id = s.regraCat(['amazon'], null);
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages, r.errors], [1, 3, 0]);
  assert.deepEqual(s.wa.simulated.map((m) => m.jid), TODOS);
  assert.deepEqual(s.wa.simulated.map((m) => linkDoTexto(m.text)), [
    'https://www.amazon.com.br/dp/B000000001?tag=achadinho-20',
    'https://www.amazon.com.br/dp/B000000001?tag=turbob1-20',
    'https://www.amazon.com.br/dp/B000000001?tag=casa333-20',
  ]);
  assert.deepEqual(linhasRastreio(s.db).map((l) => [l.jid, l.loja, l.origem, l.oferta_chave, l.codigo, l.nivel, l.bloco_id, l.esperado, l.motivo]), [
    ['111@g.us', 'amazon', 'regra', 'ASIN:B000000001', 'achadinho-20', 'padrao', null, 0, null],
    ['222@g.us', 'amazon', 'regra', 'ASIN:B000000001', 'turbob1-20', 'bloco', b, 1, null],
    ['333@g.us', 'amazon', 'regra', 'ASIN:B000000001', 'casa333-20', 'grupo', null, 1, null],
  ]);
  assert.ok(linhasRastreio(s.db).every((l, i) => l.link === linkDoTexto(s.wa.simulated[i].text)));
  // a tag não aparece no histórico
  assert.ok(logsDaRegra(s.db, id).filter((l) => l.level === 'ok').every((l) => !/achadinho-20|turbob1-20|casa333-20/.test(l.message)));
  assert.deepEqual(logsDaRegra(s.db, id).filter((l) => l.level === 'ok').map((l) => l.message), [
    'Enviado pela Amazon, com a sua tag', 'Enviado pela Amazon, com o ID de rastreamento do bloco', 'Enviado pela Amazon, com o ID de rastreamento do grupo',
  ]);
});

test('rastreio, CA3/CA9: ID da Amazon inválido no banco cai na tag de Conexões (falha_link); sem associação, a mensagem de hoje', async () => {
  const s = setupCatalogo([ofertaCat(2, 'amazon')]);
  // gravado por fora do salvar (que recusaria): o envio nunca sai sem tag
  s.db.prepare("INSERT INTO rastreio_codigos (loja, alvo_tipo, alvo, codigo) VALUES ('amazon', 'grupo', '222@g.us', 'tag com espaço')").run();
  const id = s.regraCat(['amazon'], null);
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages, r.errors], [1, 3, 0]);
  assert.ok(s.wa.simulated.every((m) => linkDoTexto(m.text) === 'https://www.amazon.com.br/dp/B000000002?tag=achadinho-20'));
  assert.deepEqual(linhasRastreio(s.db).map((l) => [l.jid, l.codigo, l.nivel, l.esperado, l.motivo]), [
    ['111@g.us', 'achadinho-20', 'padrao', 0, null],
    ['222@g.us', 'achadinho-20', 'padrao', 1, 'falha_link'],
    ['333@g.us', 'achadinho-20', 'padrao', 0, null],
  ]);
  assert.ok(logsDaRegra(s.db, id).every((l) => !/tag com espaço/.test(l.message || '')), 'o código recusado não vai ao histórico');
});

test('rastreio, CA4: ML do catálogo gera um link por etiqueta distinta e registra cada grupo', async () => {
  const s = setupCatalogo([ofertaCat(3, 'ml')]);
  salvarRastreio(s.db, { loja: 'mercadolivre', alvo_tipo: 'grupo', alvo: '333@g.us', codigo: 'etiquetaB' });
  const pedidos = espiarLinks(s.links);
  const id = s.regraCat(['ml'], 1);
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages, r.errors, r.revisao], [1, 3, 0, 0]);
  assert.deepEqual(pedidos, ['etiquetaA', 'etiquetaB']);
  assert.deepEqual(s.wa.simulated.map((m) => m.text.match(/fake-(\w+)-/)[1]), ['etiquetaA', 'etiquetaA', 'etiquetaB']);
  assert.ok(s.wa.simulated.every((m) => !m.text.includes('TerCeiro1')), 'nunca o link do Etiqueta');
  assert.deepEqual(linhasRastreio(s.db).map((l) => [l.jid, l.loja, l.oferta_chave, l.codigo, l.nivel, l.esperado]), [
    ['111@g.us', 'mercadolivre', 'MLB4000000003', 'etiquetaA', 'padrao', 0],
    ['222@g.us', 'mercadolivre', 'MLB4000000003', 'etiquetaA', 'padrao', 0],
    ['333@g.us', 'mercadolivre', 'MLB4000000003', 'etiquetaB', 'grupo', 1],
  ]);
});
