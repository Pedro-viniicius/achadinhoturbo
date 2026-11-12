// Ofertas seguidas no Disparo automático, de ponta a ponta (plano variedade-ofertas-seguidas, etapa 2; CA1, CA2, CA4 a
// CA9 e CA11): agendador real (createScheduler com `variedade: true`), WhatsApp simulado, links em modo simulado e, para o
// catálogo, o cliente real do Etiqueta (createCatalogo) com um fetch falso em memória. O relógio é falso (só o Date):
// "30 min depois" e "50 min depois" são exatos. Nenhuma loja nem o WhatsApp reais são chamados.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db.js';
import { createScheduler } from '../src/scheduler.js';
import { createLinkService } from '../src/links.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createCatalogo, filtroDe } from '../src/catalogo.js';
import { createCatalogoItens } from '../src/catalogo-itens.js';
import { createAmazon } from '../src/amazon.js';
import { criarServicos } from '../src/server.js';

// ------------------------------------------------------------------------------------------- sem rede nenhuma
const fetchOriginal = globalThis.fetch;
let chamadasDeRede = 0;
test.before(() => { globalThis.fetch = async () => { chamadasDeRede++; throw new Error('rede proibida no teste'); }; });
test.after(() => {
  globalThis.fetch = fetchOriginal;
  assert.equal(chamadasDeRede, 0, 'nenhum pedido de rede');
});

const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = (nome = 'varseg') => { const p = fs.mkdtempSync(path.join(os.tmpdir(), `${nome}-`)); pastas.push(p); return p; };

const MIN = 60000;
const AGORA = new Date(2026, 10, 12, 14, 0).getTime(); // 12/11/2026, horário local
const idDe = (url) => /MLB-?(\d+)/.exec(String(url))?.[1] ?? null;

// Os pares do caso de 12/11 e um item de outro tipo
const AGON_34 = 'Monitor Gamer Curvo AOC AGON QUAD 34" Wqhd 165hz Va Preto';
const AGON_27 = 'Monitor Gamer AOC AGON QUAD 27" Qhd 180hz Ips Preto';
const PARTYBOX_330 = 'Caixa De Som Jbl Partybox 330 280w Rms';
const PARTYBOX_130 = 'Alto-falante Bluetooth Jbl Partybox 130';
const LIQUIDIFICADOR = 'Liquidificador Philco 900W 3 Velocidades';
const FRITADEIRA = 'Air Fryer Mondial 4L Preta Digital';
// a regra "feminino" do dono: só perfumes (o tipo é o mesmo, e eles não são parecidos entre si pela trava de 24 h)
const PERFUMES = [
  'Perfume Feminino Carolina Herrera Good Girl 80ml',
  'Perfume Feminino Dolce Gabbana Light Blue 100ml',
  'Perfume Feminino Lancome La Vie Est Belle 75ml',
  'Perfume Feminino Paco Rabanne Olympea 50ml',
];
const linha = (n, titulo, preco = 49.9) => `https://produto.mercadolivre.com.br/MLB-${1000000 + n}-x | ${titulo} | ${String(preco).replace('.', ',')}`;
const chaveDe = (n) => `MLB${1000000 + n}`;

/** O relógio falso (só o Date) de um teste: ligado uma vez por `t`, e as montagens seguintes só acertam a hora. */
const comRelogio = new WeakSet();
function relogio(t, agora) {
  if (comRelogio.has(t)) { t.mock.timers.setTime(agora); return; }
  comRelogio.add(t);
  t.mock.timers.enable({ apis: ['Date'], now: agora });
}

/** Agendador com `variedade` ligada (ou não, `variedade: false`). `verificadorFalso`: { conferir }. */
function montar(t, { agora = AGORA, variedade = true, verificadorFalso = null, catalogo = null } = {}) {
  relogio(t, agora); // antes do agendador: o ritmo guarda o Date.now
  const dir = tmp(); const db = openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const amazon = createAmazon({ db, fetch: async () => { throw new Error('rede proibida (Amazon)'); }, esperar: async () => {}, lerConexao: () => ({ tag: 'achadinho-20' }) });
  const extra = catalogo ? { catalogo, catalogoItens: createCatalogoItens({ db, wa, links, amazon }) } : {};
  const scheduler = createScheduler({ db, wa, links, fast: true, amazon, verificador: verificadorFalso, variedade, ...extra });
  db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run('111@g.us', 'Achadinhos', 10, Date.now());
  db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etiquetaA', Date.now());
  return { db, wa, links, scheduler, amazon };
}

const template = (db) => Number(db.prepare('INSERT INTO templates (name, body, created_at) VALUES (?,?,?)').run(`T${Math.random()}`, '*{TITULO_PRODUTO}*\n{PRECO_PRODUTO}\n{LINK}', Date.now()).lastInsertRowid);

/** Regra da "Lista de links" (cada linha com preço digitado). */
const regraLista = (db, itens, { per = 2, dedupe = 7 } = {}) => Number(db.prepare(`INSERT INTO rules (name, enabled,
  tag_id, template_id, group_jids, source_type, source_config, per_run, interval_min, window_start, window_end, dedupe_days, send_image, created_at)
  VALUES ('Lista', 1, 1, ?, ?, 'list', ?, ?, 30, '00:00', '23:59', ?, 0, ?)`)
  .run(template(db), JSON.stringify(['111@g.us']), JSON.stringify({ items: itens.join('\n') }), per, dedupe, Date.now()).lastInsertRowid);

/** Regra de catálogo (uma fonte, `config`). */
const regraCatalogo = (db, { cfg = { ordem: 'relevancia' }, per = 2, dedupe = 7 } = {}) => Number(db.prepare(`INSERT INTO rules (name,
  enabled, tag_id, template_id, group_jids, source_type, source_config, sources, per_run, interval_min, window_start, window_end, dedupe_days,
  send_image, created_at) VALUES ('Catálogo', 1, 1, ?, ?, 'list', '{}', ?, ?, 30, '00:00', '23:59', ?, 0, ?)`)
  .run(template(db), JSON.stringify(['111@g.us']), JSON.stringify([{ type: 'catalogo', tag_id: null, config: cfg }]), per, dedupe, Date.now()).lastInsertRowid);

/** Linha de `sent_offers` como se a regra tivesse enviado (o "Enviar" do Catálogo grava assim). */
const semear = (db, ruleId, { key = 'MLB9999999', titulo, preco = 4990, em }) => db.prepare('INSERT INTO sent_offers (rule_id, offer_key, sent_at, title, price_cents) VALUES (?,?,?,?,?)')
  .run(ruleId, key, em, titulo, preco);

const logs = (db, id) => db.prepare('SELECT level, group_name, offer_title, message FROM log WHERE rule_id = ? ORDER BY id').all(id).map((l) => ({ ...l }));
const puladas = (db, id) => logs(db, id).filter((l) => l.message.startsWith('Pulada'));
const antesDaEscolha = (db, id) => logs(db, id).filter((l) => l.message.startsWith('Antes da escolha, ')).map((l) => l.message);
/** Os títulos que a execução enviou (sem as linhas semeadas por `semear`: as duas chaves de teste), na ordem. */
const saiu = (s, id) => s.db.prepare("SELECT title FROM sent_offers WHERE rule_id = ? AND offer_key NOT IN ('MLB9999999', 'ASIN:B000000009') ORDER BY id").all(id).map((l) => l.title);
const textos = (wa) => wa.simulated.map((m) => m.text);
const semErro = (db, id) => assert.deepEqual(logs(db, id).filter((l) => l.level === 'erro'), [], 'nenhuma linha de erro');

// ------------------------------------------------------------------------------------------------ CA1: o mesmo envio

test('CA1/CA4 (a): no mesmo envio, a vaga da segunda do par AGON vai para a próxima candidata; sem linha "Pulada"', async (t) => {
  const s = montar(t);
  const id = regraLista(s.db, [linha(1, AGON_34), linha(2, AGON_27), linha(3, LIQUIDIFICADOR)], { per: 2 });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages, r.errors], [2, 2, 0]);
  assert.deepEqual(saiu(s, id), [AGON_34, LIQUIDIFICADOR], 'saem a 1ª e a 3ª');
  assert.deepEqual(puladas(s.db, id), [], 'a barrada pela linha não gera "Pulada"');
  assert.deepEqual(antesDaEscolha(s.db, id), [], 'saíram as 2 pedidas: nada a explicar');
  semErro(s.db, id);
});

test('CA4: sobrando só a mesma linha, sai menos do que o pedido; a linha "Antes da escolha" conta e não cita título', async (t) => {
  const s = montar(t);
  const id = regraLista(s.db, [linha(1, AGON_34), linha(2, AGON_27), linha(3, LIQUIDIFICADOR)], { per: 3 });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages], [2, 2]);
  assert.deepEqual(saiu(s, id), [AGON_34, LIQUIDIFICADOR]);
  assert.deepEqual(antesDaEscolha(s.db, id), ['Antes da escolha, 1 oferta ficou de fora: 1 da mesma linha de uma oferta recente.']);
  assert.deepEqual(puladas(s.db, id), []);
  const todas = logs(s.db, id);
  assert.ok(todas.some((l) => /^Saíram 2 de 3 ofertas/.test(l.message)), 'a frase "Saíram 2 de 3"');
  for (const l of todas.filter((x) => x.message.startsWith('Antes da escolha'))) assert.doesNotMatch(l.message, /AGON|Monitor/);
});

test('CA1: os 4 pares do caso de 12/11 (monitor × monitor, 2 pares JBL, monitor Samsung) não saem juntos', async (t) => {
  const pares = [
    [AGON_34, AGON_27],
    ['Jbl Partybox 520 Power and Party Caixa de Som Bluetooth Portátil', 'Caixa de Som Portátil - PartyBox Stage 320 - JBL Preta'],
    [PARTYBOX_330, PARTYBOX_130],
    ['Monitor Samsung Odyssey G40 25" Full Hd 240hz', 'Monitor Gamer 27 Curvo 240hz Samsung'],
  ];
  for (const [a, b] of pares) {
    const s = montar(t);
    const id = regraLista(s.db, [linha(1, a), linha(2, b)], { per: 2 });
    const r = await s.scheduler.runRule(id);
    assert.deepEqual([r.offers, r.messages], [1, 1], a);
    assert.deepEqual(saiu(s, id), [a], a);
  }
});

test('CA1: outros tipos e marcas diferentes saem juntos (o pet, a Nike e a Mondial não são da mesma linha)', async (t) => {
  const s = montar(t);
  const itens = ['Colete Tático Para Cães Grandes', 'Peitoral Tático Militar Para Cães K9', 'Tênis Nike Revolution 7 Masculino', 'Camiseta Nike Dri-FIT Masculina Preta'];
  const id = regraLista(s.db, itens.map((x, i) => linha(i + 1, x)), { per: 4 });
  const r = await s.scheduler.runRule(id);
  // colete × peitoral e tênis × camiseta: tipos diferentes e só uma palavra distintiva em comum (`tatico`, `nike`)
  assert.deepEqual([r.offers, r.messages], [4, 4]);
  assert.deepEqual(antesDaEscolha(s.db, id), []);
});

// ------------------------------------------------------------------------------------------------ CA2: envio anterior

test('CA2 (b): o envio de 30 min atrás barra a mesma linha; com 50 min ela sai', async (t) => {
  const s = montar(t);
  const id = regraLista(s.db, [linha(1, PARTYBOX_130), linha(2, LIQUIDIFICADOR)], { per: 1 });
  semear(s.db, id, { titulo: PARTYBOX_330, em: AGORA - 30 * MIN });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages], [1, 1]);
  assert.deepEqual(saiu(s, id), [LIQUIDIFICADOR], 'outro tipo sai; o Partybox espera');
  assert.deepEqual(puladas(s.db, id), []);

  const s2 = montar(t, { agora: AGORA });
  const id2 = regraLista(s2.db, [linha(1, PARTYBOX_130), linha(2, LIQUIDIFICADOR)], { per: 1 });
  semear(s2.db, id2, { titulo: PARTYBOX_330, em: AGORA - 50 * MIN });
  await s2.scheduler.runRule(id2);
  assert.deepEqual(saiu(s2, id2), [PARTYBOX_130], '50 min depois a trava não vale mais');
});

test('CA2: o limite é de 45 min (44 barra, 46 não) e vale o que o Catálogo gravou em sent_offers', async (t) => {
  for (const [min, saiuOJbl] of [[44, false], [46, true]]) {
    const s = montar(t);
    const id = regraLista(s.db, [linha(1, PARTYBOX_130), linha(2, LIQUIDIFICADOR)], { per: 1 });
    semear(s.db, id, { key: 'ASIN:B000000009', titulo: PARTYBOX_330, em: AGORA - min * MIN }); // a reserva do "Enviar" do Catálogo
    await s.scheduler.runRule(id);
    assert.equal(saiu(s, id)[0] === PARTYBOX_130, saiuOJbl, `${min} min`);
  }
});

test('CA2: o envio de OUTRA regra não conta (cruzar regras fica fora)', async (t) => {
  const s = montar(t);
  const id = regraLista(s.db, [linha(1, PARTYBOX_130)], { per: 1 });
  const outra = regraLista(s.db, [linha(9, LIQUIDIFICADOR)], { per: 1 });
  semear(s.db, outra, { titulo: PARTYBOX_330, em: AGORA - 10 * MIN });
  await s.scheduler.runRule(id);
  assert.deepEqual(saiu(s, id), [PARTYBOX_130]);
});

// ------------------------------------------------------------------------------------------------- CA11: a guarda

test('CA11 (c): regra de um tipo só, 2 por envio, sem envio anterior: sai 1 de 2 e a guarda não age', async (t) => {
  const s = montar(t);
  const id = regraLista(s.db, PERFUMES.map((p, i) => linha(i + 1, p)), { per: 2 });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages], [1, 1]);
  assert.deepEqual(saiu(s, id), [PERFUMES[0]]);
  assert.deepEqual(antesDaEscolha(s.db, id), ['Antes da escolha, 3 ofertas ficaram de fora: 3 da mesma linha de uma oferta recente.']);
});

test('CA11 (d): com um perfume de 30 min atrás, sai exatamente 1 (o 1º da lista), nem 0 nem 2', async (t) => {
  for (const per of [1, 2, 3]) {
    const s = montar(t);
    const id = regraLista(s.db, PERFUMES.map((p, i) => linha(i + 1, p)), { per });
    semear(s.db, id, { titulo: 'Perfume Feminino Ana Paula Eau de Parfum 90ml', em: AGORA - 30 * MIN });
    const r = await s.scheduler.runRule(id);
    assert.deepEqual([r.offers, r.messages], [1, 1], `per ${per}`);
    assert.deepEqual(saiu(s, id), [PERFUMES[0]], `per ${per}`);
    semErro(s.db, id);
  }
});

test('CA11: a guarda desconta a oferta liberada da linha "Antes da escolha"', async (t) => {
  const s = montar(t);
  const id = regraLista(s.db, PERFUMES.slice(0, 3).map((p, i) => linha(i + 1, p)), { per: 2 });
  semear(s.db, id, { titulo: 'Perfume Feminino Ana Paula Eau de Parfum 90ml', em: AGORA - 30 * MIN });
  await s.scheduler.runRule(id);
  // 3 barradas pelo envio anterior, 1 liberada pela guarda; sobraram 2, e não "3"
  assert.deepEqual(antesDaEscolha(s.db, id), ['Antes da escolha, 2 ofertas ficaram de fora: 2 da mesma linha de uma oferta recente.']);
});

test('CA11 (d): execuções seguidas a cada 30 min mandam 1 perfume por envio, em vez de 1, 0, 1, 0', async (t) => {
  const s = montar(t);
  const id = regraLista(s.db, PERFUMES.map((p, i) => linha(i + 1, p)), { per: 2 });
  for (let i = 0; i < PERFUMES.length; i++) {
    const r = await s.scheduler.runRule(id);
    assert.deepEqual([r.offers, r.messages], [1, 1], `envio ${i + 1}`);
    t.mock.timers.setTime(Date.now() + 30 * MIN);
  }
  assert.deepEqual(saiu(s, id), PERFUMES, 'um por vez, na ordem da lista');
  semErro(s.db, id);
});

test('CA11 (d): a 1ª da reserva descartada pelo verificador: sai a 2ª; nunca duas no mesmo envio', async (t) => {
  const conferidas = [];
  const verificadorFalso = {
    async conferir(o) {
      conferidas.push(o.title);
      if (o.title === PERFUMES[0]) return { acao: 'descartar', motivo: 'esgotado', texto: 'Descartada: esgotado na loja' };
      return { acao: 'enviar', oferta: o };
    },
  };
  const s = montar(t, { verificadorFalso });
  const id = regraLista(s.db, PERFUMES.map((p, i) => linha(i + 1, p)), { per: 2 });
  semear(s.db, id, { titulo: 'Perfume Feminino Ana Paula Eau de Parfum 90ml', em: AGORA - 30 * MIN });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages, r.descartadas], [1, 1, 1]);
  assert.deepEqual(saiu(s, id), [PERFUMES[1]]);
  assert.deepEqual(conferidas, [PERFUMES[0], PERFUMES[1]], 'a guarda parou na que saiu: as outras nem foram conferidas');
});

test('CA11: a reserva acaba e nada sai quando todas as da reserva caem fora (orçamento e teto valem)', async (t) => {
  const verificadorFalso = { async conferir() { return { acao: 'descartar', motivo: 'esgotado', texto: 'Descartada: esgotado na loja' }; } };
  const s = montar(t, { verificadorFalso });
  const id = regraLista(s.db, PERFUMES.map((p, i) => linha(i + 1, p)), { per: 1 });
  semear(s.db, id, { titulo: 'Perfume Feminino Ana Paula Eau de Parfum 90ml', em: AGORA - 30 * MIN });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages], [0, 0]);
  assert.ok(r.descartadas >= 1 && r.descartadas <= PERFUMES.length);
  assert.equal(textos(s.wa).length, 0);
});

test('CA11: a candidata barrada por parecida (24 h) com o envio anterior nunca sai pela guarda', async (t) => {
  const s = montar(t);
  const anterior = 'Perfume Feminino Carolina Herrera Good Girl 100ml';
  const id = regraLista(s.db, [linha(1, PERFUMES[0]), linha(2, PERFUMES[1])], { per: 2 });
  semear(s.db, id, { titulo: anterior, em: AGORA - 30 * MIN });
  await s.scheduler.runRule(id);
  assert.deepEqual(saiu(s, id), [PERFUMES[1]], 'a Good Girl 80ml é parecida com a 100ml (6/7): fica de fora; sai a outra pela guarda');
  // só a parecida na lista: nada sai
  const s2 = montar(t);
  const id2 = regraLista(s2.db, [linha(1, PERFUMES[0])], { per: 2 });
  semear(s2.db, id2, { titulo: anterior, em: AGORA - 30 * MIN });
  const r = await s2.scheduler.runRule(id2);
  assert.deepEqual([r.offers, r.messages], [0, 0]);
});

test('CA11: a guarda nunca abre exceção ao mesmo envio (nunca saem duas da mesma linha, mesmo com a guarda)', async (t) => {
  const s = montar(t);
  const id = regraLista(s.db, [linha(1, AGON_34), linha(2, AGON_27), linha(3, PERFUMES[0])], { per: 3 });
  semear(s.db, id, { titulo: 'Monitor Dell 24" Full Hd Ips', em: AGORA - 20 * MIN });
  await s.scheduler.runRule(id);
  // AGON_34 e AGON_27 são barrados pelo envio anterior (monitor); o perfume sai normalmente, então a guarda nem age
  assert.deepEqual(saiu(s, id), [PERFUMES[0]]);
  // só monitores: a guarda solta UM
  const s2 = montar(t);
  const id2 = regraLista(s2.db, [linha(1, AGON_34), linha(2, AGON_27)], { per: 2 });
  semear(s2.db, id2, { titulo: 'Monitor Dell 24" Full Hd Ips', em: AGORA - 20 * MIN });
  await s2.scheduler.runRule(id2);
  assert.deepEqual(saiu(s2, id2), [AGON_34]);
});

// ------------------------------------------------------------------------------------------------- CA6: a que cai fora

test('CA6 (f): a 1ª escolhida descartada pelo verificador deixa de barrar a mesma linha, na mesma execução', async (t) => {
  const verificadorFalso = {
    async conferir(o) {
      if (o.title === AGON_34) return { acao: 'descartar', motivo: 'esgotado', texto: 'Descartada: esgotado na loja' };
      return { acao: 'enviar', oferta: o };
    },
  };
  const s = montar(t, { verificadorFalso });
  const id = regraLista(s.db, [linha(1, AGON_34), linha(2, AGON_27), linha(3, LIQUIDIFICADOR)], { per: 2 });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages, r.descartadas], [2, 2, 1]);
  assert.deepEqual(saiu(s, id), [AGON_27, LIQUIDIFICADOR], 'a 2ª (mesma linha da descartada) saiu');
});

// ------------------------------------------------------------------------------------------------- CA7: dedupe 0

test('CA7 (e): com "dias sem repetir" 0 a trava continua valendo, no mesmo envio e no envio anterior', async (t) => {
  const s = montar(t);
  const id = regraLista(s.db, [linha(1, AGON_34), linha(2, AGON_27), linha(3, LIQUIDIFICADOR), linha(4, PARTYBOX_130)], { per: 4, dedupe: 0 });
  semear(s.db, id, { titulo: PARTYBOX_330, em: AGORA - 20 * MIN });
  await s.scheduler.runRule(id);
  assert.deepEqual(saiu(s, id), [AGON_34, LIQUIDIFICADOR], 'a 2ª do par AGON e o Partybox (envio anterior) ficam de fora');
});

test('CA7: com dedupe 0 a mesma oferta repetida segue a regra de hoje (a trava não a compara consigo mesma)', async (t) => {
  const s = montar(t);
  const id = regraLista(s.db, [linha(1, AGON_34)], { per: 1, dedupe: 0 });
  semear(s.db, id, { key: chaveDe(1), titulo: AGON_34, em: AGORA - 20 * MIN });
  const r = await s.scheduler.runRule(id);
  // wasSent com dedupe 0 não olha o passado: a mesma chave sai (como hoje) e a seguida não a barra
  assert.deepEqual([r.offers, r.messages], [1, 1]);
});

// ------------------------------------------------------------------------------------------------- CA8: sem a opção

test('CA8 (h): sem `variedade` o par AGON sai junto, como hoje; e o envio anterior não barra', async (t) => {
  const s = montar(t, { variedade: false });
  const id = regraLista(s.db, [linha(1, AGON_34), linha(2, AGON_27), linha(3, PARTYBOX_130)], { per: 3 });
  semear(s.db, id, { titulo: PARTYBOX_330, em: AGORA - 20 * MIN });
  const r = await s.scheduler.runRule(id);
  assert.equal(r.offers, 3);
  assert.deepEqual(saiu(s, id), [AGON_34, AGON_27, PARTYBOX_130]);
  assert.deepEqual(antesDaEscolha(s.db, id), []);
});

test('CA8: `createScheduler` sem a opção `variedade` desliga a trava por padrão', async (t) => {
  relogio(t, AGORA);
  const dir = tmp(); const db = openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const scheduler = createScheduler({ db, wa, links: createLinkService({ getMode: () => 'fake' }), fast: true });
  db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run('111@g.us', 'Achadinhos', 10, Date.now());
  db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etiquetaA', Date.now());
  const id = regraLista(db, [linha(1, AGON_34), linha(2, AGON_27)], { per: 2 });
  const r = await scheduler.runRule(id);
  assert.equal(r.offers, 2);
});

// ------------------------------------------------------------------------------------------------- CA9: a prévia

test('CA9: "Ver ofertas" mostra a mesma escolha do envio, com a variedade e a guarda, sem gravar nada', async (t) => {
  const s = montar(t);
  const id = regraLista(s.db, [linha(1, AGON_34), linha(2, AGON_27), linha(3, LIQUIDIFICADOR)], { per: 2 });
  const antes = JSON.stringify([s.db.prepare('SELECT * FROM log').all(), s.db.prepare('SELECT * FROM sent_offers').all()]);
  const previa = await s.scheduler.previewOffers(id);
  assert.deepEqual(previa.map((o) => o.title), [AGON_34, LIQUIDIFICADOR]);
  assert.equal(JSON.stringify([s.db.prepare('SELECT * FROM log').all(), s.db.prepare('SELECT * FROM sent_offers').all()]), antes, 'a prévia não grava');
  await s.scheduler.runRule(id);
  assert.deepEqual(saiu(s, id), previa.map((o) => o.title), 'o envio manda o que a prévia mostrou');
});

test('CA9/CA11: a prévia também aplica a guarda (perfume de 30 min atrás: mostra o 1º da lista)', async (t) => {
  const s = montar(t);
  const id = regraLista(s.db, PERFUMES.map((p, i) => linha(i + 1, p)), { per: 2 });
  semear(s.db, id, { titulo: 'Perfume Feminino Ana Paula Eau de Parfum 90ml', em: AGORA - 30 * MIN });
  const previa = await s.scheduler.previewOffers(id);
  assert.deepEqual(previa.map((o) => o.title), [PERFUMES[0]]);
  await s.scheduler.runRule(id);
  assert.deepEqual(saiu(s, id), [PERFUMES[0]]);
});

// ------------------------------------------------------------------------------------------------------- catálogo

const TOKEN = `tkFALSO_${randomBytes(30).toString('base64url')}`;
const asin = (i) => `B0${String(i).padStart(8, '0')}`;
function oferta(i, titulo, preco = 49.9) {
  return {
    id: i, loja: 'amazon', categoria: 'Casa', busca: '', titulo, preco, preco_antigo: preco * 2, desconto_pct: 50, vendas: 10, avaliacao: 4.5,
    num_avaliacoes: 3, frete_gratis: true, cupom: '', criado_em: '2026-11-03T12:00:00', atualizado_em: '2026-11-03T12:00:00', genero: 'sem',
    item_id: asin(i), link: 'https://www.amazon.com.br/dp/X?tag=terceiro-20', imagem: `https://m.media-amazon.com/images/I/${i}.jpg`, chave: `amazon:${asin(i)}`,
  };
}

/** Cliente real do Etiqueta com um fetch em memória (mesma regra de cursor de test/parecido-regras.test.js). */
function etiquetaFalsa(db, estado) {
  const caminho = path.join(tmp('varseg-token'), 'api_token.txt');
  fs.writeFileSync(caminho, `${TOKEN}\n`, { mode: 0o600 });
  const fetchFalso = async (url) => {
    const u = new URL(String(url));
    const limite = Number(u.searchParams.get('limite') ?? 50);
    const ordem = u.searchParams.get('ordem') ?? 'atualizacao';
    const cursor = u.searchParams.get('cursor');
    const m = cursor == null ? [null, '0'] : (ordem === 'atualizacao' ? /^c(\d+)$/ : /^(\d+)$/).exec(cursor);
    if (!m) return new Response('{}', { status: 400 });
    const inicio = Number(m[1]);
    const pagina = estado.ofertas.slice(inicio, inicio + limite);
    const fim = inicio + pagina.length;
    const proximo = ordem === 'atualizacao' ? (pagina.length ? `c${fim}` : null) : (fim < estado.ofertas.length ? String(fim) : null);
    return new Response(JSON.stringify({ versao: 1, ofertas: pagina, proximo, total: estado.ofertas.length }), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
  };
  return createCatalogo({ db, fetch: fetchFalso, lerConexao: () => ({ endereco: 'http://127.0.0.1:9', caminho_token: caminho }), timeoutMs: 3000 });
}

/** Agendador com o catálogo real; `estado.ofertas` troca as ofertas entre as execuções. */
function montarCatalogo(t, ofertas) {
  const estado = { ofertas };
  const dir = tmp('varseg-cat'); const db = openDb(dir);
  relogio(t, AGORA);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const amazon = createAmazon({ db, fetch: async () => { throw new Error('rede proibida (Amazon)'); }, esperar: async () => {}, lerConexao: () => ({ tag: 'achadinho-20' }) });
  const catalogo = etiquetaFalsa(db, estado);
  const catalogoItens = createCatalogoItens({ db, wa, links, amazon });
  const scheduler = createScheduler({ db, wa, links, fast: true, amazon, catalogo, catalogoItens, variedade: true });
  db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run('111@g.us', 'Achadinhos', 10, Date.now());
  db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etiquetaA', Date.now());
  return { db, wa, links, scheduler, estado };
}

test('CA5 (g): no catálogo em Novidades, a seguida não conta como tratada: o cursor não passa por ela e ela volta depois', async (t) => {
  const s = montarCatalogo(t, [oferta(1, LIQUIDIFICADOR), oferta(2, FRITADEIRA), oferta(3, 'Cafeteira Elétrica Oster 15 Xícaras')]);
  const cfg = { lojas: ['amazon'] }; // ordem padrão: atualizacao (Novidades)
  const id = regraCatalogo(s.db, { cfg, per: 5 });
  const cursor = () => s.db.prepare('SELECT cursor, pronto FROM catalogo_cursores WHERE rule_id = ? AND filtro = ?').get(id, filtroDe(cfg))?.cursor;

  assert.equal((await s.scheduler.runRule(id)).offers, 0, 'a primeira leitura só marca o ponto de partida');
  assert.equal(cursor(), 'c3');
  semear(s.db, id, { key: `ASIN:${asin(9)}`, titulo: PARTYBOX_330, em: Date.now() - 10 * MIN }); // o "Enviar" do Catálogo
  s.estado.ofertas.push(oferta(4, PARTYBOX_130), oferta(5, LIQUIDIFICADOR.replace('Philco', 'Britânia 1000W')), oferta(6, FRITADEIRA.replace('Mondial', 'Philips')));
  const r = await s.scheduler.runRule(id);
  assert.equal(r.offers, 2, 'a 4 (Partybox, da mesma linha do envio anterior) fica de fora; saem a 5 e a 6');
  assert.deepEqual(puladas(s.db, id), []);
  assert.equal(cursor(), 'c3', 'o cursor não passa pela seguida');

  t.mock.timers.setTime(Date.now() + 50 * MIN); // passou a janela de 45 min
  const r2 = await s.scheduler.runRule(id);
  assert.equal(r2.offers, 1, 'a 4 volta e sai');
  assert.ok(textos(s.wa).at(-1).startsWith(`*${PARTYBOX_130}*`));
  assert.equal(cursor(), 'c6', 'agora o cursor passa por ela');
});

test('CA11: a guarda vale para o catálogo (reserva da fonte nova): a 1ª barrada só pelo envio anterior sai', async (t) => {
  const s = montarCatalogo(t, [oferta(1, PERFUMES[0]), oferta(2, PERFUMES[1])]);
  const id = regraCatalogo(s.db, { cfg: { ordem: 'relevancia' }, per: 2 });
  semear(s.db, id, { key: `ASIN:${asin(9)}`, titulo: 'Perfume Feminino Ana Paula Eau de Parfum 90ml', em: AGORA - 30 * MIN });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages], [1, 1]);
  assert.ok(s.wa.simulated[0].text.startsWith(`*${PERFUMES[0]}*`));
});

test('CA2: o "Enviar" do Catálogo da regra também barra (a reserva fica em sent_offers) numa regra do catálogo', async (t) => {
  const s = montarCatalogo(t, [oferta(1, PARTYBOX_130), oferta(2, LIQUIDIFICADOR)]);
  const id = regraCatalogo(s.db, { cfg: { ordem: 'relevancia' }, per: 1 });
  semear(s.db, id, { key: `ASIN:${asin(9)}`, titulo: PARTYBOX_330, em: AGORA - 10 * MIN });
  await s.scheduler.runRule(id);
  assert.ok(s.wa.simulated[0].text.startsWith(`*${LIQUIDIFICADOR}*`), 'o Partybox espera; sai o outro tipo');
});

test('R1: a Shopee da mesma linha de um envio recente vai à revisão (não some) e não conta como saída nem como seguida barrada', async (t) => {
  const shopee = { ...oferta(1, PERFUMES[1]), loja: 'shopee', item_id: '123.1', link: 'https://s.shopee.com.br/Ab1cd', imagem: 'https://down-br.img.susercontent.com/file/1', preco_antigo: null, desconto_pct: 0, chave: 'shopee:123.1' };
  const s = montarCatalogo(t, [shopee, oferta(2, LIQUIDIFICADOR)]);
  const id = regraCatalogo(s.db, { cfg: { ordem: 'relevancia' }, per: 2 });
  semear(s.db, id, { key: `ASIN:${asin(9)}`, titulo: PERFUMES[0], em: AGORA - 30 * MIN }); // o perfume de 30 min atrás
  const itens = () => s.db.prepare('SELECT status, oferta FROM catalogo_itens WHERE rule_id = ? AND status = \'revisao\'').all(id).map((l) => ({ status: l.status, title: JSON.parse(l.oferta).title }));

  const [o] = await s.scheduler.previewOffers(id);
  assert.equal(o.revisao, true, 'a prévia também a mostra como revisão');
  const r = await s.scheduler.runRule(id);
  assert.equal(r.revisao, 1, 'foi à revisão');
  assert.equal(r.offers, 1, 'só o liquidificador é saída');
  assert.deepEqual(itens(), [{ status: 'revisao', title: PERFUMES[1] }]);
  assert.equal(textos(s.wa).length, 1);
  assert.ok(textos(s.wa)[0].startsWith(`*${LIQUIDIFICADOR}*`));
  for (const m of antesDaEscolha(s.db, id)) assert.doesNotMatch(m, /mesma linha/, 'não conta como seguida barrada');
  semErro(s.db, id);
});

test('R1: a Shopee da revisão não segura a vaga: o outro perfume (barrado pelo envio de 30 min) cede a vaga e o restante sai', async (t) => {
  const shopee = { ...oferta(1, PERFUMES[1]), loja: 'shopee', item_id: '123.1', link: 'https://s.shopee.com.br/Ab1cd', imagem: 'https://down-br.img.susercontent.com/file/1', preco_antigo: null, desconto_pct: 0, chave: 'shopee:123.1' };
  const s = montarCatalogo(t, [shopee, oferta(2, PERFUMES[2]), oferta(3, LIQUIDIFICADOR)]);
  const id = regraCatalogo(s.db, { cfg: { ordem: 'relevancia' }, per: 2 });
  semear(s.db, id, { key: `ASIN:${asin(9)}`, titulo: PERFUMES[0], em: AGORA - 30 * MIN });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.revisao, r.offers], [1, 1]);
  assert.ok(textos(s.wa)[0].startsWith(`*${LIQUIDIFICADOR}*`), 'o outro perfume (barrado pelo envio de 30 min) cede a vaga ao liquidificador');
  semErro(s.db, id);
});

// ------------------------------------------------------------------------------- a ligação (criarServicos)

/** Sobe pelo mesmo caminho do servidor (criarServicos), sem a rede: só muda o `variedade`. */
function subirServicos(t, opcoes = {}) {
  relogio(t, AGORA);
  const dir = tmp('varseg-srv'); const db = openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const { scheduler } = criarServicos({ db, wa, links, fast: true, dir, fetch: async () => { throw new Error('rede proibida no teste'); }, ...opcoes });
  db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run('111@g.us', 'Achadinhos', 10, Date.now());
  db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etiquetaA', Date.now());
  return { db, wa, links, scheduler };
}

test('R2: criarServicos({ variedade: true }) liga a trava: o par AGON 34" × 27" sai um só', async (t) => {
  const s = subirServicos(t, { variedade: true });
  const id = regraLista(s.db, [linha(1, AGON_34), linha(2, AGON_27), linha(3, LIQUIDIFICADOR)], { per: 2 });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.errors], [2, 0]);
  assert.deepEqual(saiu(s, id), [AGON_34, LIQUIDIFICADOR]);
});

test('R2: criarServicos sem `variedade` não liga a trava (o par sai junto, como antes)', async (t) => {
  const s = subirServicos(t);
  const id = regraLista(s.db, [linha(1, AGON_34), linha(2, AGON_27), linha(3, LIQUIDIFICADOR)], { per: 2 });
  await s.scheduler.runRule(id);
  assert.deepEqual(saiu(s, id), [AGON_34, AGON_27]);
});
