// QA das ofertas seguidas (plano variedade-ofertas-seguidas): casos de borda que test/variedade-seguidas.test.js (do dev) não
// cobre. Mesmo harness: agendador real com `variedade: true`, WhatsApp simulado, links falsos, Etiqueta falso em memória e
// relógio falso (só o Date). Nenhuma rede, nenhuma loja, nenhum WhatsApp reais.
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
import { mesmaLinha, FRASE_MAIS_BARATA } from '../src/parecido.js';

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

const CAIXA_SOM = 'Caixa de Som Portátil JBL Flip 6';
const PERFUME_ANTERIOR = 'Perfume Feminino Ana Paula Eau de Parfum 90ml';

// ---------------------------------------------------------------------------------------------- fiação (server.js)

test('fiação: criarServicos({ variedade: true }) liga a trava; sem a opção (padrão) e com false, o par AGON sai junto', async (t) => {
  relogio(t, AGORA);
  for (const [opcao, esperado] of [[{ variedade: true }, [AGON_34, LIQUIDIFICADOR]], [{ variedade: false }, [AGON_34, AGON_27]], [{}, [AGON_34, AGON_27]]]) {
    const dir = tmp(); const db = openDb(dir);
    const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
    const links = createLinkService({ getMode: () => 'fake' });
    const { scheduler } = criarServicos({ db, wa, links, fast: true, dir, ...opcao });
    db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run('111@g.us', 'Achadinhos', 10, Date.now());
    db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etiquetaA', Date.now());
    const id = regraLista(db, [linha(1, AGON_34), linha(2, AGON_27), linha(3, LIQUIDIFICADOR)], { per: 2 });
    await scheduler.runRule(id);
    const enviados = db.prepare('SELECT title FROM sent_offers WHERE rule_id = ? ORDER BY id').all(id).map((l) => l.title);
    assert.deepEqual(enviados, esperado, JSON.stringify(opcao));
  }
});

test('fiação: o `main` do servidor passa `variedade: true` a criarServicos (sem isso a trava nunca liga em produção)', () => {
  const fonte = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const main = fonte.slice(fonte.indexOf('if (import.meta.url === `file://'));
  const chamada = /criarServicos\(\{[^}]*\}\)/.exec(main)?.[0] ?? '';
  assert.match(chamada, /variedade:\s*true/, 'a chamada do main a criarServicos');
  // e a prévia/serviço de simulação (DRY_RUN) usa o mesmo main: não há segunda chamada sem a opção
  assert.equal((fonte.match(/criarServicos\(\{/g) ?? []).length, 1 + 1, 'a definição e a única chamada do main');
});

// ---------------------------------------------------------------------------------------------- fronteira dos 45 min

test('CA2: no agendador, 44 min 59 s barra e 45 min 00 s já não barra (fronteira exata, relógio falso)', async (t) => {
  for (const [ms, saiuOJbl] of [[45 * MIN - 1000, false], [45 * MIN, true], [45 * MIN + 1000, true]]) {
    const s = montar(t);
    const id = regraLista(s.db, [linha(1, PARTYBOX_130), linha(2, LIQUIDIFICADOR)], { per: 1 });
    semear(s.db, id, { titulo: PARTYBOX_330, em: AGORA - ms });
    await s.scheduler.runRule(id);
    assert.equal(saiu(s, id)[0] === PARTYBOX_130, saiuOJbl, `${ms} ms atrás`);
  }
});

// ---------------------------------------------------------------------------------------------- a guarda, mais fundo

test('CA11: a guarda solta a mais barata (exceção dos 5%) com a frase de "mais barata" e sem linha "Pulada"', async (t) => {
  const s = montar(t);
  const titulo = 'Perfume Feminino Carolina Herrera Good Girl 80ml';
  const id = regraLista(s.db, [linha(1, titulo, 90)], { per: 2 });
  semear(s.db, id, { key: 'MLB9999999', titulo, preco: 10000, em: AGORA - 30 * MIN }); // o mesmo título por R$ 100, 30 min atrás
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages], [1, 1], 'a guarda soltou a única candidata (a mesma linha, mas 10% mais barata)');
  assert.ok(textos(s.wa)[0].includes(FRASE_MAIS_BARATA), 'a mensagem leva a frase de "mais barata"');
  assert.deepEqual(puladas(s.db, id), []);
  semErro(s.db, id);
});

test('CA11: a guarda para na 1ª que sai: a reserva de linhas diferentes não manda uma de cada (sai só 1)', async (t) => {
  const s = montar(t);
  const id = regraLista(s.db, [linha(1, AGON_34), linha(2, PERFUMES[0]), linha(3, AGON_27)], { per: 3 });
  semear(s.db, id, { key: 'MLB9999999', titulo: 'Monitor Dell 24" Full Hd Ips', em: AGORA - 20 * MIN });
  semear(s.db, id, { key: 'ASIN:B000000009', titulo: PERFUME_ANTERIOR, em: AGORA - 20 * MIN });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages], [1, 1], 'tudo barrado pelo envio anterior: a guarda solta uma só');
  assert.deepEqual(saiu(s, id), [AGON_34], 'a 1ª da lista (a 1ª da reserva)');
});

test('CA11: com 3 da reserva e as 2 primeiras descartadas, sai a 3ª (a guarda continua até uma sair)', async (t) => {
  const descartar = new Set([PERFUMES[0], PERFUMES[1]]);
  const verificadorFalso = {
    async conferir(o) { return descartar.has(o.title) ? { acao: 'descartar', motivo: 'esgotado', texto: 'Descartada: esgotado na loja' } : { acao: 'enviar', oferta: o }; },
  };
  const s = montar(t, { verificadorFalso });
  const id = regraLista(s.db, PERFUMES.map((p, i) => linha(i + 1, p)), { per: 2 });
  semear(s.db, id, { titulo: PERFUME_ANTERIOR, em: AGORA - 30 * MIN });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages, r.descartadas], [1, 1, 2]);
  assert.deepEqual(saiu(s, id), [PERFUMES[2]]);
});

test('CA11/CA7: a guarda também age com "dias sem repetir" 0', async (t) => {
  const s = montar(t);
  const id = regraLista(s.db, PERFUMES.map((p, i) => linha(i + 1, p)), { per: 2, dedupe: 0 });
  semear(s.db, id, { titulo: PERFUME_ANTERIOR, em: AGORA - 30 * MIN });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages], [1, 1]);
  assert.deepEqual(saiu(s, id), [PERFUMES[0]]);
});

test('CA11: uma escolhida de outro tipo que sai impede a guarda (sem "forçar" a mesma linha do envio anterior)', async (t) => {
  const s = montar(t);
  const id = regraLista(s.db, [linha(1, PERFUMES[0]), linha(2, LIQUIDIFICADOR), linha(3, PERFUMES[1])], { per: 3 });
  semear(s.db, id, { titulo: PERFUME_ANTERIOR, em: AGORA - 30 * MIN });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages], [1, 1]);
  assert.deepEqual(saiu(s, id), [LIQUIDIFICADOR], 'saiu uma: os perfumes esperam');
  assert.deepEqual(antesDaEscolha(s.db, id), ['Antes da escolha, 2 ofertas ficaram de fora: 2 da mesma linha de uma oferta recente.']);
});

test('CA11: o mesmo perfume não sai duas vezes (a guarda respeita a chave já enviada com dedupe > 0)', async (t) => {
  const s = montar(t);
  const id = regraLista(s.db, [linha(1, PERFUMES[0])], { per: 2 });
  semear(s.db, id, { key: chaveDe(1), titulo: PERFUMES[0], preco: 4990, em: AGORA - 30 * MIN });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages], [0, 0], 'a mesma chave enviada há 30 min segue a regra de hoje (já enviada)');
});

test('CA4: "Antes da escolha" nunca cita título nem número de grupo, nem com a guarda agindo', async (t) => {
  const s = montar(t);
  const id = regraLista(s.db, PERFUMES.map((p, i) => linha(i + 1, p)), { per: 2 });
  semear(s.db, id, { titulo: PERFUME_ANTERIOR, em: AGORA - 30 * MIN });
  await s.scheduler.runRule(id);
  for (const l of logs(s.db, id).filter((x) => x.message.startsWith('Antes da escolha'))) {
    assert.doesNotMatch(l.message, /Perfume|Carolina|Lancome|Paco|111@g\.us/);
    assert.equal(l.offer_title, null, 'a linha da contagem não leva título de oferta');
  }
});

// ---------------------------------------------------------------------------------------------- catálogo

test('CA11/CA5: Novidades com a guarda: sai 1 por execução (a cada 30 min) e o cursor só passa quando a página toda foi tratada', async (t) => {
  const s = montarCatalogo(t, [oferta(1, LIQUIDIFICADOR)]);
  const cfg = { lojas: ['amazon'] };
  const id = regraCatalogo(s.db, { cfg, per: 2 });
  const cursor = () => s.db.prepare('SELECT cursor FROM catalogo_cursores WHERE rule_id = ? AND filtro = ?').get(id, filtroDe(cfg))?.cursor;
  assert.equal((await s.scheduler.runRule(id)).offers, 0, 'a primeira leitura só marca o ponto de partida');
  assert.equal(cursor(), 'c1');
  semear(s.db, id, { key: `ASIN:${asin(9)}`, titulo: PERFUME_ANTERIOR, em: Date.now() - 30 * MIN });
  s.estado.ofertas.push(oferta(2, PERFUMES[0]), oferta(3, PERFUMES[1]), oferta(4, PERFUMES[2]));
  assert.equal((await s.scheduler.runRule(id)).offers, 1, 'a guarda solta o 1º perfume');
  assert.ok(s.wa.simulated.at(-1).text.startsWith(`*${PERFUMES[0]}*`));
  assert.equal(cursor(), 'c1', 'a página (os 3 perfumes) ainda tem oferta sem tratar: o cursor espera');
  t.mock.timers.setTime(Date.now() + 30 * MIN);
  assert.equal((await s.scheduler.runRule(id)).offers, 1);
  assert.ok(s.wa.simulated.at(-1).text.startsWith(`*${PERFUMES[1]}*`));
  assert.equal(cursor(), 'c1');
  t.mock.timers.setTime(Date.now() + 30 * MIN);
  assert.equal((await s.scheduler.runRule(id)).offers, 1);
  assert.ok(s.wa.simulated.at(-1).text.startsWith(`*${PERFUMES[2]}*`));
  assert.equal(cursor(), 'c4', 'a página inteira foi tratada: o cursor passa por ela');
});

test('CA11: no catálogo, a que iria à revisão vai a catalogo_itens como revisão (a trava não a barra) e a guarda solta a próxima', async (t) => {
  const revisao = oferta(1, PERFUMES[0]); revisao.preco_antigo = revisao.preco * 10; // preço antigo 10× o atual: vai à revisão
  const s = montarCatalogo(t, [revisao, oferta(2, PERFUMES[1])]);
  const id = regraCatalogo(s.db, { cfg: { ordem: 'relevancia' }, per: 2 });
  semear(s.db, id, { key: `ASIN:${asin(9)}`, titulo: PERFUME_ANTERIOR, em: AGORA - 30 * MIN });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages], [1, 1]);
  assert.ok(s.wa.simulated[0].text.startsWith(`*${PERFUMES[1]}*`), 'a da revisão não é solta pela guarda');
  const itens = s.db.prepare('SELECT chave, status FROM catalogo_itens WHERE rule_id = ? ORDER BY chave').all(id).map((l) => ({ ...l }));
  // R1: a da revisão não manda nada a grupo, então a seguida não a barra: vai à revisão (sem entrar na reserva nem contar como saída)
  assert.deepEqual(itens, [{ chave: `ASIN:${asin(1)}`, status: 'revisao' }, { chave: `ASIN:${asin(2)}`, status: 'enviado' }]);
});

// ---------------------------------------------------------------------------------------------- mesmaLinha (unidade)

test('mesmaLinha: acento, caixa e pontuação não mudam o resultado', () => {
  assert.equal(mesmaLinha('MONITOR Gamer Curvo AOC', 'monitor gamer Ips LG'), 'tipo');
  assert.equal(mesmaLinha('Câmera Segurança Intelbras Wi-Fi', 'CAMERA seguranca  Intelbras!!'), 'tipo');
  assert.equal(mesmaLinha('Cafeteira Oster Inox', 'Liquidificador Philco Turbo'), null);
});

test('mesmaLinha: entradas ruins nunca lançam e dão null', () => {
  for (const [a, b] of [[null, 'Monitor Gamer AOC'], [undefined, undefined], [42, {}], ['', ''], ['Monitor', 'Monitor Gamer AOC Curvo']]) {
    assert.equal(mesmaLinha(a, b), null, JSON.stringify([a, b]));
  }
});

test('mesmaLinha: "Kit N Pares/Unidades/Peças de X" não é do mesmo tipo de "Kit N Pares/Unidades/Peças de Y" (Q1)', () => {
  // a palavra de tipo é a coisa vendida (meias, cuecas, canetas, panelas, toalhas), não a unidade de contagem
  assert.equal(mesmaLinha('Kit 3 Pares de Meias Nike Cano Alto', 'Kit 5 Pares de Cuecas Lupo Boxer'), null, 'pares');
  assert.equal(mesmaLinha('Kit 10 Unidades Canetas Bic Azul', 'Kit 5 Unidades Cuecas Lupo Boxer'), null, 'unidades');
  assert.equal(mesmaLinha('Conjunto 3 Peças Panelas Tramontina', 'Conjunto 5 Peças Toalhas Karsten'), null, 'peças');
});

// ------------------------------------------------------------------------- R7: a prévia mostra o mesmo que o envio (CA9)

for (const comRecente of [false, true]) {
  const rotulo = comRecente ? 'com um perfume enviado 30 min antes' : 'sem envio anterior';
  test(`R7/CA9: a Shopee da revisão vem antes de outro perfume (${rotulo}): a prévia mostra a Shopee (revisão) e a Lancome, como o envio`, async (t) => {
    const shopee = { ...oferta(1, PERFUMES[1]), loja: 'shopee', item_id: '123.1', link: 'https://s.shopee.com.br/Ab1cd', imagem: 'https://down-br.img.susercontent.com/file/1', preco_antigo: null, desconto_pct: 0, chave: 'shopee:123.1' };
    const s = montarCatalogo(t, [shopee, oferta(2, PERFUMES[2])]);
    const id = regraCatalogo(s.db, { cfg: { ordem: 'relevancia', lojas: ['amazon', 'shopee'] }, per: 2 });
    if (comRecente) semear(s.db, id, { key: `ASIN:${asin(9)}`, titulo: PERFUMES[0], em: AGORA - 30 * MIN });

    const previa = await s.scheduler.previewOffers(id);
    const r = await s.scheduler.runRule(id);
    // o que o envio fez: a Shopee foi para a revisão e a Lancome saiu
    assert.equal(r.revisao, 1, 'o envio: a Shopee foi à revisão');
    assert.equal(r.offers, 1, 'o envio: a Lancome saiu');
    assert.ok(textos(s.wa)[0].startsWith(`*${PERFUMES[2]}*`), 'o envio mandou a Lancome');
    // a prévia tem de mostrar as duas: a Shopee marcada como revisão e a Lancome
    assert.deepEqual(previa.map((o) => [o.title, o.revisao === true]), [[PERFUMES[1], true], [PERFUMES[2], false]], 'a prévia mostra o mesmo que o envio');
  });
}

// ------------------------------------------- R8: unidade de contagem não é palavra de linha ("pares" + marca não é a mesma linha)

test('R8: "Kit N Pares/Unidades/Peças" de coisas diferentes da mesma marca não são da mesma linha (a unidade não conta como palavra em comum)', () => {
  assert.equal(mesmaLinha('Kit 3 Pares Meia Lupo Algodão', 'Kit 2 Pares Chinelo Lupo'), null, 'pares + lupo');
  assert.equal(mesmaLinha('Kit 3 Unidades Meia Lupo Algodão', 'Kit 2 Unidades Chinelo Lupo'), null, 'unidades + lupo');
  assert.equal(mesmaLinha('Kit 3 Peças Meia Lupo Algodão', 'Kit 2 Peças Chinelo Lupo'), null, 'peças + lupo');
  assert.equal(mesmaLinha('Kit 3 Pares Meia Lupo Algodão', 'Kit 2 Pares Chinelo Lupo'), mesmaLinha('Kit 3 Meia Lupo Algodão', 'Kit 2 Chinelo Lupo'), 'a unidade não muda o resultado');
});

test('R8: duas ofertas da mesma marca e linha de verdade continuam barrando (o conserto não afrouxa demais)', () => {
  assert.equal(mesmaLinha('Tênis Nike Air Max 90 Masculino', 'Camiseta Nike Air Max Dri-FIT'), 'linha', 'duas palavras de linha em comum (nike, air)');
  assert.equal(mesmaLinha('Kit 3 Pares Meia Lupo Algodão Cano Alto', 'Kit 2 Pares Chinelo Lupo Algodão Macio'), 'linha', 'marca + material, mesmo com "pares" em ambos');
  assert.equal(mesmaLinha('Kit 3 Pares Meia Lupo Algodão', 'Kit 5 Pares Meia Nike Esportiva'), 'tipo', 'mesmo tipo (meia)');
});
