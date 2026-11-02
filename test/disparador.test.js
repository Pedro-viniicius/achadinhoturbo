import test from 'node:test';
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

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'disp-'));
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
  assert.equal(extractItemId('https://x/MLB-987654321-a'), 'MLB987654321');
  assert.equal(offerKey('https://www.mercadolivre.com.br/p/MLB555555?a=b'), 'MLB555555');
});

test('leitura do produto pelo JSON-LD da página', () => {
  const html = `<html><script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Cafeteira X","image":["https://img/1.jpg"],"offers":{"@type":"Offer","price":199.9,"priceCurrency":"BRL"}}</script>"original_price":299.9</html>`;
  const p = parseProductHtml(html);
  assert.deepEqual([p.title, p.price, p.oldPrice, p.image], ['Cafeteira X', 199.9, 299.9, 'https://img/1.jpg']);
});

test('resolveOffer: usa API, cai para HTML e explica a falha', async () => {
  const api = await resolveOffer({ key: 'MLB1', url: 'https://x/MLB-1234567-a' }, {
    fetchJson: async () => ({ id: 'MLB1234567', title: 'Item', price: 50, original_price: 100, permalink: 'https://x/p', sold_quantity: 1500, shipping: { free_shipping: true }, pictures: [{ secure_url: 'https://i/1.jpg' }] }),
  });
  assert.deepEqual([api.price, api.discountPct, api.sold, api.freeShipping], [50, 50, 1500, true]);
  const html = await resolveOffer({ key: 'k', url: 'https://www.mercadolivre.com.br/p/MLB777' }, {
    fetchText: async () => '<script type="application/ld+json">{"@type":"Product","name":"Cat","offers":{"price":10}}</script>',
  });
  assert.equal(html.title, 'Cat');
  await assert.rejects(resolveOffer({ key: 'k', url: 'https://x/MLB-1234567-a' }, {
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
  'https://x/MLB-1000001-a | Fone A | 50 | 100',
  'https://x/MLB-1000002-b | Mouse B | 30 | 40',
  'https://x/MLB-1000003-c | Teclado C | 200 | 400',
  'https://x/MLB-1000004-d | Cabo D | 10',
  'https://x/MLB-1000005-e | Monitor E | 900 | 1000',
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
    assert.deepEqual([job.url, job.tag], ['https://x/MLB-1-a', 'minhaTag']);
    links.submit(job.id, { ok: true, link: 'https://meli.la/ABC' });
  })();
  await new Promise((r) => setTimeout(r, 20));
  const link = await links.requestLink({ url: 'https://x/MLB-1-a', tag: 'minhaTag' });
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
