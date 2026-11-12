// QA do campo {PRECO_ULTIMO_ENVIO} ("📉 Baixou de ~R$ X~ para *R$ Y*"; plano baixou-de-para, CA1 a CA6), rodada 1.
// Complementa test/template, parecido, base, servidor, parecido-regras e parecido-envios sem repetir: aqui ficam as provas
// entre as peças (regra × "Enviar" do Catálogo × fila × migração × validação), as propriedades numéricas (centavos e
// o limite de 5% com ponto flutuante), a migração contra uma falha no meio, o texto exato de várias rodadas seguidas e
// o que o Disparo manual NÃO pode mostrar. Fiação real (createScheduler, createCatalogoItens, fila, verificador),
// WhatsApp simulado, links falsos, relógio falso (só o Date) e rede proibida.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openDb, DEFAULT_TEMPLATE } from '../src/db.js';
import { createScheduler } from '../src/scheduler.js';
import { createLinkService } from '../src/links.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createVerificador } from '../src/verificador.js';
import { createCatalogoItens } from '../src/catalogo-itens.js';
import { createAmazon } from '../src/amazon.js';
import { buildApp, criarServicos, ERRO_TEMPLATE_ULTIMO_ENVIO, ERRO_TEMPLATE_HORA_PRECO } from '../src/server.js';
import {
  renderTemplate, SAMPLE_OFFER, TEMPLATE_AMAZON, LINHA_ULTIMO_ENVIO, comLinhaUltimoEnvio, campoDerrubaOLink,
} from '../src/template.js';
import { baixouDe, precoDoUltimoEnvio, DIAS_ULTIMO_ENVIO } from '../src/parecido.js';

const fetchOriginal = globalThis.fetch;
let chamadasDeRede = 0;
test.before(() => { globalThis.fetch = async () => { chamadasDeRede++; throw new Error('rede proibida no teste'); }; });
test.after(() => {
  globalThis.fetch = fetchOriginal;
  assert.equal(chamadasDeRede, 0, 'nenhum pedido de rede');
});

const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'qabaixou-')); pastas.push(p); return p; };

const HORA = 3600000;
const DIA = 24 * HORA;
const dia = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime(); // 10/11/2026, horário local
const AGORA = dia(10, 14);
const idDe = (url) => /MLB-?(\d+)/.exec(String(url))?.[1] ?? null;
const IMG_ML = 'https://http2.mlstatic.com/D_NQ_NP_123-O.jpg';

const A = 'Fone de Ouvido Bluetooth JBL Tune 510BT Preto';
const B = 'Fone de Ouvido Bluetooth JBL Tune 510BT Branco'; // parecido com A (nunca igual)
const C = 'Tênis Corrida Masculino Nike Revolution 7';
const unico = (i) => `Marca${i}alfa Modelo${i}beta Linha${i}gama Tipo${i}delta`;
const linha = (n, titulo, preco) => `https://produto.mercadolivre.com.br/MLB-${1000000 + n}-x | ${titulo} | ${String(preco).replace('.', ',')}`;
const ML = (n, titulo, preco) => ({ key: `MLB${n}`, title: titulo, price: preco, oldPrice: null, discountPct: null, sold: 10, freeShipping: true, coupon: null, image: IMG_ML, categoria: 'Casa', tag_id: null, source_index: 0 });

/** O que o dono teria num template migrado: o "Por", a linha nova, o link. */
const CORPO = `*{TITULO_PRODUTO}*\nPor *{PRECO_PRODUTO}*\n${LINHA_ULTIMO_ENVIO}\n{LINK}`;
const SEM_LINK = (texto) => texto.split('\n').filter((l) => !l.startsWith('https://'));
const baixou = (de, para) => `📉 Baixou de ~${de}~ para *${para}*`;

/** Fiação do servidor (criarServicos) sem o `acordar`: agendador, "Enviar" do Catálogo e fila no mesmo banco. */
function montar(t, { agora = AGORA, loja = {}, verificar = false, corpo = CORPO } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: agora });
  const dir = tmp(); const db = openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const amazon = createAmazon({ db, fetch: async () => { throw new Error('rede proibida (Amazon)'); }, esperar: async () => {}, lerConexao: () => ({ tag: 'achadinho-20' }) });
  const mlLoja = { async conferirProduto(url) { const r = loja[idDe(url)]; if (!r) throw new Error('loja fora do ar (falsa)'); return r; } };
  const verificador = verificar ? createVerificador({ db, ml: mlLoja, amazon }) : null;
  let scheduler = null;
  const enviosTardios = {
    lerFoto: (id) => scheduler.envios.lerFoto(id),
    processarPendentes: () => scheduler.envios.processarPendentes(),
    linksRastreioShopee: (a) => scheduler.envios.linksRastreioShopee(a),
  };
  const catalogoItens = createCatalogoItens({ db, wa, links, amazon, envios: enviosTardios, acordar: () => {} });
  scheduler = createScheduler({ db, wa, links, fast: true, amazon, verificador, catalogoItens });
  db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run('111@g.us', 'Achadinhos', 10, Date.now());
  db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run('222@g.us', 'Tech', 10, Date.now());
  db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etiquetaA', Date.now());
  const novoTemplate = (c) => Number(db.prepare('INSERT INTO templates (name, body, created_at) VALUES (?,?,?)').run(`T${Math.random()}`, c, Date.now()).lastInsertRowid);
  const tplId = novoTemplate(corpo);
  const s = {
    db, wa, scheduler, catalogoItens, tplId, novoTemplate,
    regra(itens, { per = 3, dedupe = 7, tpl = tplId } = {}) {
      return Number(db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id, group_jids, source_type, source_config, per_run, interval_min,
        window_start, window_end, dedupe_days, send_image, created_at) VALUES ('Lista', 1, 1, ?, ?, 'list', ?, ?, 60, '00:00', '23:59', ?, 0, ?)`)
        .run(tpl, JSON.stringify(['111@g.us']), JSON.stringify({ items: itens.join('\n') }), per, dedupe, Date.now()).lastInsertRowid);
    },
    trocarLista(id, itens) { db.prepare('UPDATE rules SET source_config = ? WHERE id = ?').run(JSON.stringify({ items: itens.join('\n') }), id); },
    revisao(ruleId, c) {
      const regra = { id: ruleId, name: 'Lista', dedupe_days: 7 };
      assert.equal(catalogoItens.registrar(regra, c, 'revisao', ['falha_link']), true);
      return db.prepare('SELECT id FROM catalogo_itens WHERE rule_id = ? AND chave = ?').get(ruleId, c.key).id;
    },
    semear(id, chave, titulo, centavos, atras) {
      db.prepare('INSERT INTO sent_offers (rule_id, offer_key, sent_at, title, price_cents) VALUES (?,?,?,?,?)').run(id, chave, Date.now() - atras, titulo, centavos);
    },
    avancar(ms) { t.mock.timers.setTime(Date.now() + ms); },
    textos: () => wa.simulated.map((m) => m.text),
    payloadDe: (envioId) => JSON.parse(db.prepare('SELECT payload FROM envios WHERE id = ?').get(envioId).payload),
  };
  return s;
}
/** Nenhum texto que saiu pode carregar um campo cru nem um "undefined"/"NaN". */
function semCampoCru(textos) {
  for (const x of textos) assert.doesNotMatch(x, /\{[A-Z_]+\}|undefined|NaN|\[📉|null/, x);
}

// ====================================================================================== 1. números (propriedades)
/** Gerador determinístico (LCG), para o fuzz não depender de Math.random. */
function lcg(semente) { let x = semente >>> 0; return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 2 ** 32; }; }
const brlDeCentavos = (c) => `R$ ${String(Math.floor(c / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${String(c % 100).padStart(2, '0')}`;

test('números: o preço anterior sai com os centavos exatos para milhares de valores (sem erro de ponto flutuante no c/100)', () => {
  const r = lcg(42);
  const casos = [1, 5, 99, 100, 101, 105, 110, 115, 1005, 100005, 99999, 29990, 29901, 123456789];
  for (let i = 0; i < 4000; i++) casos.push(1 + Math.floor(r() * 20_000_000));
  for (let c = 1; c <= 3000; c++) casos.push(c);
  for (const c of casos) {
    const texto = renderTemplate('{PRECO_ULTIMO_ENVIO}', { price: 0.001, precoUltimoEnvio: c / 100 });
    assert.equal(texto, brlDeCentavos(c), `${c} centavos`);
  }
});

test('números: o limite de 5% é exato em centavos, mesmo com o preço em reais de ponto flutuante (R$ 284,05 vs R$ 299,00)', () => {
  assert.equal(baixouDe(29900, 284.05), 299, '5% exato (R$ 284,05) mostra');
  assert.equal(baixouDe(29900, 284.06), null, 'um centavo acima do limite não mostra');
  const r = lcg(7);
  const anteriores = [100, 101, 119, 120, 2000, 29900, 99999, 100000];
  for (let i = 0; i < 3000; i++) anteriores.push(100 + Math.floor(r() * 5_000_000));
  for (const ant of anteriores) {
    const limite = Math.floor((ant * 95) / 100); // o maior preço (em centavos) que ainda é 5% mais barato
    assert.equal(baixouDe(ant, limite / 100), ant / 100, `${ant}: ${limite} mostra`);
    assert.equal(baixouDe(ant, (limite + 1) / 100), null, `${ant}: ${limite + 1} não mostra`);
  }
});

test('números: o preço conferido como texto, com vírgula ou lixo, nunca vira queda nem "NaN" na mensagem', () => {
  assert.equal(baixouDe(29900, '252.00'), 299);
  for (const ruim of ['252,00', '', ' ', 'abc', NaN, Infinity, -1, 0, null, undefined, {}, [], true]) {
    assert.equal(baixouDe(29900, ruim), null, String(ruim));
  }
  for (const ruim of [0, -5, 1.5, NaN, Infinity, null, undefined, '29900', 2 ** 60]) {
    assert.equal(baixouDe(ruim, 10), null, String(ruim));
  }
  for (const anterior of ['abc', {}, [], true, -3, NaN, Infinity]) {
    assert.equal(renderTemplate(CORPO, { title: A, price: 10, link: 'x', precoUltimoEnvio: anterior }).includes('Baixou'), false, String(anterior));
  }
});

// ====================================================================================== 2. busca do último envio
const bancoComEnvios = (linhas) => {
  const db = openDb(tmp());
  for (const [rule, key, atras, title, cents] of linhas) {
    db.prepare('INSERT INTO sent_offers (rule_id, offer_key, sent_at, title, price_cents) VALUES (?,?,?,?,?)').run(rule, key, AGORA - atras, title, cents);
  }
  return db;
};

test('busca: o produto parecido, mesmo mais recente, não atrapalha: vale o último envio do MESMO produto', () => {
  const db = bancoComEnvios([[1, 'K1', 10 * DIA, A, 29900], [1, 'K2', 1 * DIA, B, 28000]]);
  assert.equal(precoDoUltimoEnvio(db, 1, { key: 'K1', title: A }, AGORA), 29900);
  assert.equal(precoDoUltimoEnvio(db, 1, { key: 'K9', title: A }, AGORA), 29900, 'o mesmo título com outra chave também');
  assert.equal(precoDoUltimoEnvio(db, 1, { key: 'K9', title: B }, AGORA), 28000);
});

test('busca: título ausente, curto ou nulo na linha ou na oferta não casa por engano; só a chave igual casa', () => {
  const db = bancoComEnvios([[1, 'K1', DIA, null, 5000], [1, 'K2', DIA, 'Fone Bom', 6000], [1, 'K3', DIA, '', 7000]]);
  for (const title of [undefined, null, '', 'Fone Bom', 'x', 42, {}]) {
    assert.equal(precoDoUltimoEnvio(db, 1, { key: 'KZ', title }, AGORA), null, `título ${JSON.stringify(title)} com chave nova`);
  }
  assert.equal(precoDoUltimoEnvio(db, 1, { key: 'K1', title: undefined }, AGORA), 5000, 'a chave igual casa mesmo sem título');
  assert.equal(precoDoUltimoEnvio(db, 1, { key: 'K2', title: null }, AGORA), 6000);
  assert.equal(precoDoUltimoEnvio(db, 1, { key: 7, title: 'a b c' }, AGORA), null, 'chave numérica sem linha');
  assert.equal(precoDoUltimoEnvio(db, 1, undefined, AGORA), null, 'sem argumentos');
  assert.equal(precoDoUltimoEnvio(db, 1, {}, AGORA), null);
});

test('busca: a chave numérica casa com a guardada como texto, e a janela é a constante exportada (30 dias)', () => {
  assert.equal(DIAS_ULTIMO_ENVIO, 30);
  const db = bancoComEnvios([[1, '123', 30 * DIA - 1, A, 1000], [1, '456', 30 * DIA, A, 2000]]);
  assert.equal(precoDoUltimoEnvio(db, 1, { key: 123, title: 'outro nome qualquer aqui' }, AGORA), 1000, 'a 1 ms de completar 30 dias ainda vale');
  assert.equal(precoDoUltimoEnvio(db, 1, { key: 456, title: 'outro nome qualquer aqui' }, AGORA), null, 'no instante exato dos 30 dias, não');
});

// ====================================================================================== 3. migração
const OFERTAS = [
  { title: A, price: 89.9, oldPrice: 149.9, sold: 2300, freeShipping: true, coupon: 'ACHA10', link: 'https://meli.la/x' },
  { title: C, price: 10, oldPrice: null, sold: null, freeShipping: false, coupon: null, link: 'https://meli.la/y' },
  { title: 'Kit 10 Potes de Vidro', price: 1234.56, oldPrice: 1500, sold: 15, freeShipping: false, coupon: null, link: 'https://meli.la/z', vistoEm: AGORA },
];
const MODELOS = {
  padrao: DEFAULT_TEMPLATE.split('\n').filter((l) => l !== LINHA_ULTIMO_ENVIO).join('\n'),
  semPreco: '*{TITULO_PRODUTO}*\n{LINK}',
  precoELinkJuntos: '{TITULO_PRODUTO}\nPor {PRECO_PRODUTO} {LINK}',
  precoDepoisDoLink: '{LINK}\n💰 {PRECO_PRODUTO}\nFim',
  precoOpcional: '{TITULO_PRODUTO}\n[💰 Por {PRECO_PRODUTO}[ ({DESCONTO_PRODUTO} OFF)]]\n[🎟️ {CUPOM}]\n{LINK}',
  crlf: '*{TITULO_PRODUTO}*\r\n\r\n🔥 Por *{PRECO_PRODUTO}*\r\n🚚 {FRETE}\r\n{LINK}',
  precoNaUltimaLinha: '{LINK}\nPreço: {PRECO_PRODUTO}',
  precoNaUltimaLinhaComQuebra: '{LINK}\nPreço: {PRECO_PRODUTO}\n',
  doisPrecos: '{TITULO_PRODUTO}\nDe ~{PRECO_ANTIGO}~ por {PRECO_PRODUTO}\nHoje: {PRECO_PRODUTO}\n{LINK}',
  amazon: TEMPLATE_AMAZON.split('\n').filter((l) => l !== LINHA_ULTIMO_ENVIO).join('\n'),
};

test('migração (propriedade): sem queda, o template migrado renderiza byte a byte igual ao de antes, para qualquer oferta', () => {
  for (const [nome, antigo] of Object.entries(MODELOS)) {
    const novo = comLinhaUltimoEnvio(antigo);
    if (novo === null) { assert.ok(!/\{PRECO_PRODUTO\}/.test(antigo.split('\n').filter((l) => !l.includes('{LINK}')).join('\n')), `${nome}: sem linha elegível`); continue; }
    for (const o of OFERTAS) {
      assert.equal(renderTemplate(novo, o), renderTemplate(antigo, o), `${nome} × ${o.title}`);
      for (const semQueda of [{ precoUltimoEnvio: null }, { precoUltimoEnvio: o.price }, { precoUltimoEnvio: o.price - 1 }, { precoUltimoEnvio: '' }]) {
        assert.equal(renderTemplate(novo, { ...o, ...semQueda }), renderTemplate(antigo, o), `${nome} × ${o.title} × ${JSON.stringify(semQueda)}`);
      }
    }
  }
});

test('migração (propriedade): com queda, a única diferença é UMA linha "Baixou de", logo abaixo da linha do preço', () => {
  for (const [nome, antigo] of Object.entries(MODELOS)) {
    const novo = comLinhaUltimoEnvio(antigo);
    if (novo === null) continue;
    const o = { ...OFERTAS[0], precoUltimoEnvio: 299 };
    const sem = renderTemplate(antigo, OFERTAS[0]).split('\n');
    const com = renderTemplate(novo, o).split('\n');
    assert.equal(com.length, sem.length + 1, nome);
    const i = com.findIndex((l) => l.includes('📉'));
    assert.ok(i > 0, `${nome}: a linha existe`);
    assert.equal(com[i].replace(/\r$/, ''), baixou('R$ 299,00', 'R$ 89,90'), nome);
    assert.deepEqual([...com.slice(0, i), ...com.slice(i + 1)], sem, `${nome}: o resto não mudou`);
    assert.match(sem[i - 1], /89,90/, `${nome}: logo abaixo do preço`);
  }
});

const SEGREDO = 'SEGREDO-DO-CORPO-xyz';
/** Banco "antigo": abre, volta os templates ao texto de antes e tira a marca da migração. */
function bancoAntigo(dir) {
  const db = openDb(dir);
  db.prepare('DELETE FROM settings WHERE key = ?').run('tpl_ultimo_envio_migrado');
  const volta = (b) => b.split('\n').filter((l) => l !== LINHA_ULTIMO_ENVIO).join('\n');
  for (const { id, body } of db.prepare('SELECT id, body FROM templates').all()) db.prepare('UPDATE templates SET body = ? WHERE id = ?').run(volta(body), id);
  return db;
}
const corpos = (db) => Object.fromEntries(db.prepare('SELECT id, body FROM templates ORDER BY id').all().map((x) => [x.id, x.body]));

test('migração: uma falha no meio desfaz tudo (nenhum template muda, sem marca), não vaza o corpo no console e a próxima abertura conclui', (t) => {
  const dir = tmp();
  let db = bancoAntigo(dir);
  const ids = [1, 2, 3].map((n) => Number(db.prepare('INSERT INTO templates (name, body, created_at) VALUES (?,?,?)').run(`M${n}`, `${SEGREDO} ${n}\nPor {PRECO_PRODUTO}\n{LINK}`, 1).lastInsertRowid));
  const antes = corpos(db);
  db.exec(`CREATE TRIGGER barra BEFORE UPDATE ON templates WHEN NEW.id = ${ids[2]} BEGIN SELECT RAISE(ABORT, '${SEGREDO} no erro'); END`);
  db.close();

  const erros = []; const logs = [];
  t.mock.method(console, 'error', (...a) => erros.push(a.map(String).join(' ')));
  t.mock.method(console, 'log', (...a) => logs.push(a.map(String).join(' ')));
  db = openDb(dir); // não lança
  assert.deepEqual(corpos(db), antes, 'ROLLBACK: nem os templates anteriores ao que falhou foram alterados');
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'tpl_ultimo_envio_migrado'").get(), undefined, 'sem marca: tenta de novo depois');
  assert.equal(erros.length, 1);
  assert.doesNotMatch(erros.join('\n') + logs.join('\n'), new RegExp(SEGREDO), 'nem o corpo nem a mensagem do banco vão ao console');
  assert.equal(db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get('barra') !== undefined, true);
  assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  db.exec('DROP TRIGGER barra');
  db.close();

  t.mock.restoreAll();
  db = openDb(dir); // agora conclui
  const depois = corpos(db);
  for (const id of ids) assert.equal(depois[id], `${SEGREDO} ${ids.indexOf(id) + 1}\nPor {PRECO_PRODUTO}\n${LINHA_ULTIMO_ENVIO}\n{LINK}`, `template ${id}`);
  const marcados = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'tpl_ultimo_envio_migrado'").get().value);
  assert.deepEqual(marcados.sort((a, b) => a - b), Object.keys(antes).map(Number).filter((id) => comLinhaUltimoEnvio(antes[id]) !== null), 'a marca lista exatamente os que mudaram');
  assert.ok(ids.every((id) => marcados.includes(id)));
  db.close();
});

test('migração: edição do dono no meio da migração não é pisada (o UPDATE confere o corpo lido) e o template editado fica fora da marca', () => {
  const dir = tmp();
  let db = bancoAntigo(dir);
  const [a, b] = [1, 2].map((n) => Number(db.prepare('INSERT INTO templates (name, body, created_at) VALUES (?,?,?)').run(`C${n}`, `Texto ${n}\nPor {PRECO_PRODUTO}\n{LINK}`, 1).lastInsertRowid));
  // quando o 1º for atualizado, "o dono" salva uma edição no 2º (o corpo que a migração leu já ficou velho)
  db.exec(`CREATE TRIGGER dono AFTER UPDATE ON templates WHEN NEW.id = ${a} BEGIN UPDATE templates SET body = body || ' (edição do dono)' WHERE id = ${b}; END`);
  db.close();
  db = openDb(dir);
  const c = corpos(db);
  assert.equal(c[a], `Texto 1\nPor {PRECO_PRODUTO}\n${LINHA_ULTIMO_ENVIO}\n{LINK}`);
  assert.equal(c[b], 'Texto 2\nPor {PRECO_PRODUTO}\n{LINK} (edição do dono)', 'a edição do dono continua lá, sem a linha');
  const ids = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'tpl_ultimo_envio_migrado'").get().value);
  assert.equal(ids.includes(a), true);
  assert.equal(ids.includes(b), false);
  db.close();
});

test('migração: só toca em templates.body e na marca (nome, data, regras e as outras settings ficam iguais)', () => {
  const dir = tmp();
  let db = bancoAntigo(dir);
  const meu = Number(db.prepare('INSERT INTO templates (name, body, created_at) VALUES (?,?,?)').run('Meu', 'Oi {TITULO_PRODUTO}\nR$ {PRECO_PRODUTO}\n{LINK}', 777).lastInsertRowid);
  db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('et', 1);
  db.prepare('INSERT INTO rules (name, enabled, tag_id, template_id, group_jids, source_type, source_config, per_run, interval_min, window_start, window_end, dedupe_days, send_image, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('R', 1, 1, meu, '[]', 'list', '{}', 1, 60, '00:00', '23:59', 7, 0, 1);
  const tabelas = ['rules', 'tags', 'groups', 'sent_offers', 'log'];
  const foto = () => ({
    outras: db.prepare("SELECT key, value FROM settings WHERE key <> 'tpl_ultimo_envio_migrado' ORDER BY key").all().map((r) => ({ ...r })),
    tabelas: tabelas.map((n) => db.prepare(`SELECT * FROM ${n}`).all().map((r) => ({ ...r }))),
    meta: db.prepare('SELECT id, name, created_at FROM templates ORDER BY id').all().map((r) => ({ ...r })),
  });
  const antes = foto();
  db.close();
  db = openDb(dir);
  assert.deepEqual(foto(), antes);
  assert.equal(corpos(db)[meu], `Oi {TITULO_PRODUTO}\nR$ {PRECO_PRODUTO}\n${LINHA_ULTIMO_ENVIO}\n{LINK}`);
  db.close();
});

test('migração: o template criado DEPOIS dela não é tocado nas aberturas seguintes (a marca vale para sempre)', () => {
  const dir = tmp();
  let db = openDb(dir);
  const novo = Number(db.prepare('INSERT INTO templates (name, body, created_at) VALUES (?,?,?)').run('Depois', 'Por {PRECO_PRODUTO}\n{LINK}', 5).lastInsertRowid);
  db.close();
  for (let i = 0; i < 3; i++) { db = openDb(dir); assert.equal(corpos(db)[novo], 'Por {PRECO_PRODUTO}\n{LINK}', `abertura ${i + 1}`); db.close(); }
});

test('migração: banco antigo sem a semente da Amazon ganha a Amazon já com a linha e fora da lista de ids migrados', () => {
  const dir = tmp();
  let db = bancoAntigo(dir);
  db.prepare("DELETE FROM settings WHERE key = 'tpl_amazon_seed'").run();
  db.prepare("DELETE FROM templates WHERE name LIKE '%mazon%'").run();
  db.close();
  db = openDb(dir);
  const amazon = db.prepare("SELECT id, body FROM templates WHERE name LIKE '%mazon%'").all();
  assert.equal(amazon.length, 1);
  assert.equal(amazon[0].body.split('{PRECO_ULTIMO_ENVIO}').length - 1, 1, 'a linha aparece uma vez só');
  const migrados = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'tpl_ultimo_envio_migrado'").get().value);
  assert.equal(migrados.includes(Number(amazon[0].id)), false);
  const padrao = db.prepare("SELECT body FROM templates WHERE name = 'Padrão'").get().body;
  assert.equal(padrao.split('{PRECO_ULTIMO_ENVIO}').length - 1, 1, 'o Padrão também tem a linha uma vez só');
  db.close();
});

// ====================================================================================== 4. validação pelo painel
const HOST = 'disparador.exemplo.com.br';
const SENHA = 'senha-de-teste-123';
function req(port, caminho, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((ok, err) => {
    const data = body != null ? JSON.stringify(body) : null;
    const h = { host: `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers };
    const r = http.request({ host: '127.0.0.1', port, path: caminho, method, headers: h }, (res) => {
      let txt = ''; res.setEncoding('utf8'); res.on('data', (c) => (txt += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(txt); } catch { /* html */ } ok({ status: res.statusCode, headers: res.headers, json, txt }); });
    });
    r.on('error', err); if (data) r.write(data); r.end();
  });
}
async function painel() {
  const dir = tmp(); const db = openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const { amazon, shopee, catalogo, catalogoItens, scheduler } = criarServicos({ db, wa, links, fast: true, dir, fetch: async () => { throw new Error('rede proibida'); } });
  const app = buildApp({ db, wa, links, scheduler, amazon, shopee, catalogo, catalogoItens, publicHost: HOST, panelPassword: SENHA });
  const server = await new Promise((ok) => { const sv = app.listen(0, '127.0.0.1', () => ok(sv)); });
  const port = server.address().port;
  const l = await req(port, '/api/login', { method: 'POST', body: { senha: SENHA } });
  const cookie = String(l.headers['set-cookie']?.[0] || '').split(';')[0];
  const h = { cookie, origin: `http://127.0.0.1:${port}` };
  return {
    db, port, api: (c, method = 'GET', body) => req(port, c, { method, headers: h, body }),
    fechar: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => { db.close(); r(); }); }),
  };
}

test('validação: matriz de templates com o campo (aceita ou recusa) e a mensagem certa para cada campo', async () => {
  const p = await painel();
  try {
    const U = '{PRECO_ULTIMO_ENVIO}'; const H = '{HORA_PRECO}';
    const matriz = [
      [`a\n${LINHA_ULTIMO_ENVIO}\n{LINK}`, null],
      [`a\n[📉 era ${U}]\n{LINK}`, null],
      [`a\n[📉 era ${U}] {LINK}`, null],
      [`a\n{LINK} [📉 era ${U}]`, null],
      [`a\n[📉 era ${U}][ por {PRECO_PRODUTO}] {LINK}`, null],
      [`a\n[ ${U}]\n[{LINK}]`, null],
      [`a\nera ${U}\n{LINK}`, null],
      [`a\nera ${U} {LINK}`, 'U'],
      [`a\n{LINK} era ${U}`, 'U'],
      [`a\n[📉 era ${U} {LINK}]`, 'U'],
      [`a\n[x] ${U} [y] {LINK}`, 'U'],
      [`a\n[📉 ${U}] ${U} {LINK}`, 'U'],
      [`a\r\nera ${U} {LINK}\r\n`, 'U'],
      [`a\n[🕒 ${H}] ${U} {LINK}`, 'U'],
      [`a\n${H} {LINK}`, 'H'],
      [`a\n${H} ${U} {LINK}`, 'H'],
    ];
    for (const [body, erro] of matriz) {
      const r = await p.api('/api/templates', 'POST', { name: `T${Math.random()}`, body });
      if (!erro) { assert.equal(r.status, 200, `${JSON.stringify(body)}: ${r.txt}`); await p.api(`/api/templates/${r.json.id}`, 'DELETE'); continue; }
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.json.erro, erro === 'U' ? ERRO_TEMPLATE_ULTIMO_ENVIO : ERRO_TEMPLATE_HORA_PRECO, JSON.stringify(body));
    }
    // tudo o que o código fabrica sozinho passa na validação do próprio painel (ninguém fica sem conseguir salvar depois de editar)
    for (const [nome, corpo] of [['Padrão', DEFAULT_TEMPLATE], ['Amazon', TEMPLATE_AMAZON], ...Object.entries(MODELOS).map(([n, c]) => [n, comLinhaUltimoEnvio(c)]).filter(([, c]) => c)]) {
      const r = await p.api('/api/templates', 'POST', { name: `Cópia ${nome}`, body: corpo });
      assert.equal(r.status, 200, `${nome}: ${r.txt}`);
    }
  } finally { await p.fechar(); }
});

test('validação: template salvo por fora com o campo junto do {LINK} não passa no PUT com o mesmo corpo, e passa com o corpo corrigido', async () => {
  const p = await painel();
  try {
    // um template antigo salvo por fora (banco), com o campo junto do link: o PUT que manda o mesmo corpo é recusado
    // (mesma regra do {HORA_PRECO}), e o que manda o corpo corrigido passa
    const id = Number(p.db.prepare('INSERT INTO templates (name, body, created_at) VALUES (?,?,?)').run('Velho', 'Por {PRECO_PRODUTO} {PRECO_ULTIMO_ENVIO} {LINK}', 1).lastInsertRowid);
    const ruim = await p.api(`/api/templates/${id}`, 'PUT', { name: 'Velho 2', body: 'Por {PRECO_PRODUTO} {PRECO_ULTIMO_ENVIO} {LINK}' });
    assert.equal(ruim.status, 400);
    const bom = await p.api(`/api/templates/${id}`, 'PUT', { name: 'Velho 2', body: `Por {PRECO_PRODUTO}\n${LINHA_ULTIMO_ENVIO}\n{LINK}` });
    assert.equal(bom.status, 200, bom.txt);
  } finally { await p.fechar(); }
});

test('prévia: o texto da prévia do editor traz o preço de exemplo e o que a oferta de exemplo custa; sem sessão não responde', async () => {
  const p = await painel();
  try {
    const r = await p.api('/api/templates/preview', 'POST', { body: DEFAULT_TEMPLATE.replace('{LINK}', 'https://meli.la/x'), ultimo_envio: true }); // o sinal que só o editor de Templates manda
    assert.equal(r.status, 200);
    const l = r.json.texto.split('\n').find((x) => x.includes('📉'));
    assert.equal(l, baixou('R$ 99,90', 'R$ 89,90'));
    assert.equal(SAMPLE_OFFER.price, 89.9, 'a amostra continua custando 89,90 (a linha da prévia depende disso)');
    const anonimo = await req(p.port, '/api/templates/preview', { method: 'POST', headers: { origin: `http://127.0.0.1:${p.port}` }, body: { body: 'x' } });
    assert.equal(anonimo.status, 401);
    // a amostra só afeta a prévia de quem está logado; a mensagem real nunca lê esse campo (teste "campos forjados" do Disparo manual)
    const forjada = await p.api('/api/templates/preview', 'POST', { body: DEFAULT_TEMPLATE, amostra: { title: 'X', price: 10, precoUltimoEnvio: 20 } });
    assert.equal(forjada.status, 200);
    // sem o sinal do editor de Templates (Disparo manual, remetente, espelho), nem com amostra nem sem, a linha aparece
    for (const corpo of [{ body: DEFAULT_TEMPLATE }, { body: DEFAULT_TEMPLATE, amostra: { title: 'Fone', price: 50, link: 'https://meli.la/x' } }, { body: DEFAULT_TEMPLATE, amostra: {} }]) {
      const rr = await p.api('/api/templates/preview', 'POST', corpo);
      assert.equal(rr.status, 200);
      assert.doesNotMatch(rr.json.texto, /Baixou|PRECO_ULTIMO|📉|\[|\]/, `sem o sinal: ${JSON.stringify(corpo.amostra)}`);
    }
    // o sinal só vale se for o booleano true (texto "true" ou 1 não liga), e nenhum deles liga a linha
    for (const falso of ['true', 1, null]) {
      const rr = await p.api('/api/templates/preview', 'POST', { body: DEFAULT_TEMPLATE, ultimo_envio: falso });
      assert.doesNotMatch(rr.json.texto, /Baixou/, `ultimo_envio ${JSON.stringify(falso)}`);
    }
  } finally { await p.fechar(); }
});

// ====================================================================================== 5. regra de ponta a ponta
test('regra: quatro rodadas seguidas, o texto exato e a referência é sempre o ENVIO MAIS RECENTE (não o mais barato)', async (t) => {
  const s = montar(t);
  const id = s.regra([linha(1, C, 299)], { per: 1 });
  const rodar = async (preco) => {
    s.trocarLista(id, [linha(1, C, preco)]);
    const antes = s.textos().length;
    const r = await s.scheduler.runRule(id);
    assert.deepEqual([r.offers, r.errors], [1, 0], `R$ ${preco}`);
    assert.equal(s.textos().length, antes + 1);
    return SEM_LINK(s.textos().at(-1));
  };
  assert.deepEqual(await rodar(299), [`*${C}*`, 'Por *R$ 299,00*'], '1ª vez: sem histórico, sem a linha');
  s.avancar(8 * DIA);
  assert.deepEqual(await rodar(252), [`*${C}*`, 'Por *R$ 252,00*', baixou('R$ 299,00', 'R$ 252,00')], 'caiu 15,7%');
  s.avancar(8 * DIA);
  assert.deepEqual(await rodar(270), [`*${C}*`, 'Por *R$ 270,00*'], 'subiu em relação ao último: sem a linha');
  s.avancar(8 * DIA);
  // 245 é 4,8% mais barato que o menor preço de antes (252, que daria 239,40), mas 9,3% mais barato que o último (270)
  assert.deepEqual(await rodar(245), [`*${C}*`, 'Por *R$ 245,00*', baixou('R$ 270,00', 'R$ 245,00')], 'a referência é o último envio');
  s.avancar(8 * DIA);
  assert.deepEqual(await rodar(235), [`*${C}*`, 'Por *R$ 235,00*'], '4,1% abaixo de 245: sem a linha');
  semCampoCru(s.textos().map((x) => x.replace(/\[📉/g, '')));
});

test('regra: com várias ofertas na rodada, cada uma tem a própria referência (nada vaza de uma para a próxima)', async (t) => {
  for (const comHistoricoEm of [1, 2, 3]) {
    const s = montar(t, { agora: AGORA + comHistoricoEm * 1000 });
    const id = s.regra([1, 2, 3].map((n) => linha(n, unico(n), 250)), { per: 3, dedupe: 7 });
    s.semear(id, `MLB${1000000 + comHistoricoEm}`, unico(comHistoricoEm), 29900, 10 * DIA); // só uma delas já saiu, por R$ 299
    const r = await s.scheduler.runRule(id);
    assert.deepEqual([r.offers, r.errors], [3, 0]);
    const textos = s.textos();
    assert.equal(textos.length, 3);
    for (const x of textos) {
      const n = Number(/Marca(\d)alfa/.exec(x)[1]);
      assert.equal(x.includes(baixou('R$ 299,00', 'R$ 250,00')), n === comHistoricoEm, `oferta ${n} (histórico na ${comHistoricoEm})`);
    }
    assert.equal(textos.filter((x) => x.includes('📉')).length, 1);
    t.mock.timers.reset();
  }
});

test('regra: o histórico é POR REGRA (o mesmo produto enviado por outra regra a R$ 299,00 não mostra a linha na minha)', async (t) => {
  const s = montar(t);
  const outra = s.regra([linha(1, C, 299)], { per: 1 });
  const minha = s.regra([linha(1, C, 252)], { per: 1 });
  s.semear(outra, 'MLB1000001', C, 29900, 10 * DIA);
  await s.scheduler.runRule(minha);
  assert.equal(s.textos().length, 1);
  assert.deepEqual(SEM_LINK(s.textos()[0]), [`*${C}*`, 'Por *R$ 252,00*']);
  // e o contrário: o envio da minha regra (R$ 252,00) vira a referência da minha, não a da outra
  s.avancar(8 * DIA);
  s.trocarLista(minha, [linha(1, C, 230)]);
  await s.scheduler.runRule(minha);
  assert.deepEqual(SEM_LINK(s.textos().at(-1)), [`*${C}*`, 'Por *R$ 230,00*', baixou('R$ 252,00', 'R$ 230,00')]);
});

test('regra (docs): com "não repetir por" 29 dias a mesma chave volta aos 29,5 dias COM a linha; com 30 dias só volta depois deles e SEM a linha', async (t) => {
  const com29 = montar(t, { agora: AGORA });
  const id29 = com29.regra([linha(1, C, 252)], { per: 1, dedupe: 29 });
  com29.semear(id29, 'MLB1000001', C, 29900, 0);
  com29.avancar(29.5 * DIA);
  assert.equal((await com29.scheduler.runRule(id29)).offers, 1);
  assert.deepEqual(SEM_LINK(com29.textos()[0]), [`*${C}*`, 'Por *R$ 252,00*', baixou('R$ 299,00', 'R$ 252,00')], 'dedupe 29: volta dentro dos 30 dias e mostra a queda');
  t.mock.timers.reset();

  const com30 = montar(t, { agora: AGORA });
  const id30 = com30.regra([linha(1, C, 252)], { per: 1, dedupe: 30 });
  com30.semear(id30, 'MLB1000001', C, 29900, 0);
  com30.avancar(29.5 * DIA);
  assert.equal((await com30.scheduler.runRule(id30)).offers, 0, 'dedupe 30: aos 29,5 dias a mesma chave ainda não pode voltar');
  com30.avancar(0.6 * DIA); // 30,1 dias depois do envio semeado
  assert.equal((await com30.scheduler.runRule(id30)).offers, 1);
  assert.deepEqual(SEM_LINK(com30.textos()[0]), [`*${C}*`, 'Por *R$ 252,00*'], 'dedupe 30: passou da janela, sai sem a linha');
});

test('regra: o template antigo (sem o campo) sai exatamente como antes mesmo com queda de preço, e sem "{" cru', async (t) => {
  const s = montar(t, { corpo: '*{TITULO_PRODUTO}*\nPor *{PRECO_PRODUTO}*\n{LINK}' });
  const id = s.regra([linha(1, C, 252)], { per: 1 });
  s.semear(id, 'MLB1000001', C, 29900, 10 * DIA);
  await s.scheduler.runRule(id);
  assert.deepEqual(SEM_LINK(s.textos()[0]), [`*${C}*`, 'Por *R$ 252,00*']);
  semCampoCru(s.textos());
});

test('regra: o log do envio não ganha nem perde nada (a linha "Baixou" é só da mensagem, sem preço nem grupo no Histórico)', async (t) => {
  const s = montar(t);
  const id = s.regra([linha(1, C, 252)], { per: 1 });
  s.semear(id, 'MLB1000001', C, 29900, 10 * DIA);
  await s.scheduler.runRule(id);
  const logs = s.db.prepare('SELECT level, message, offer_title FROM log WHERE rule_id = ?').all(id).map((l) => ({ ...l }));
  assert.equal(s.textos()[0].includes('📉'), true);
  assert.equal(logs.some((l) => /Baixou|299,00|PRECO_ULTIMO/.test(`${l.message} ${l.offer_title}`)), false, JSON.stringify(logs));
  assert.equal(logs.filter((l) => l.level === 'erro').length, 0);
});

// ====================================================================================== 6. "Enviar" do Catálogo + fila
test('Catálogo: "Enviar" → falha em todos os grupos → "Enviar de novo": a segunda mensagem leva a linha com o último envio de verdade', async (t) => {
  const s = montar(t, { verificar: true, loja: { 2000001: { price: 250, disponivel: true } } });
  const id = s.regra([linha(1, A, 299)], { per: 1 });
  s.semear(id, 'MLB999', A, 29900, 10 * DIA); // o mesmo título, outra chave, há 10 dias
  const item = s.revisao(id, ML(2000001, A, 252));
  const quebrar = { sendText: s.wa.sendText, sendImage: s.wa.sendImage };
  s.wa.sendText = async () => { throw new Error('socket caiu'); };
  s.wa.sendImage = async () => { throw new Error('socket caiu'); };
  const r1 = await s.catalogoItens.enviar(item, {});
  assert.equal(s.payloadDe(r1.envio_id).preco_ultimo_envio, 29900);
  await s.scheduler.envios.processarPendentes();
  assert.equal(s.textos().length, 0, 'nada saiu');

  Object.assign(s.wa, quebrar);
  s.avancar(HORA);
  const r2 = await s.catalogoItens.enviar(item, {}); // "Enviar de novo"
  assert.equal(s.payloadDe(r2.envio_id).preco_ultimo_envio, 29900, 'a reserva do envio que falhou não vira "último envio"');
  await s.scheduler.envios.processarPendentes();
  assert.equal(s.textos().length, 1);
  // o preço da mensagem é o conferido na loja (R$ 250,00), e a referência é o envio de 10 dias atrás
  assert.deepEqual(SEM_LINK(s.textos()[0]), [`*${A}*`, 'Por *R$ 250,00*', baixou('R$ 299,00', 'R$ 250,00')]);
  semCampoCru(SEM_LINK(s.textos()[0]).map((x) => x.replace('📉', '')));
});

test('Catálogo: a mesma chave que voltou depois do prazo mostra a queda; sem preço guardado no envio anterior, sai sem a linha e sem erro', async (t) => {
  const s = montar(t);
  const id = s.regra([linha(1, A, 299)], { per: 1 });
  s.semear(id, 'MLB2000001', A, 29900, 10 * DIA);
  s.semear(id, 'MLB2000002', C, null, 10 * DIA); // anterior sem preço
  const a = s.revisao(id, ML(2000001, A, 252));
  const c = s.revisao(id, ML(2000002, C, 100));
  const ra = await s.catalogoItens.enviar(a, {});
  const rc = await s.catalogoItens.enviar(c, {});
  assert.equal(s.payloadDe(ra.envio_id).preco_ultimo_envio, 29900);
  assert.equal(Object.hasOwn(s.payloadDe(rc.envio_id), 'preco_ultimo_envio'), false);
  await s.scheduler.envios.processarPendentes();
  const [ta, tc] = s.textos();
  assert.equal(ta.includes(baixou('R$ 299,00', 'R$ 252,00')), true);
  assert.equal(tc.includes('📉'), false);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM envios WHERE status <> 'concluido'").get().n, 0);
});

test('Catálogo: a queda é decidida com o preço CONFERIDO na fila, não com o que o dono aprovou (cruzando os 5% nos dois sentidos)', async (t) => {
  // o produto saiu a R$ 299,00 (limite da queda: R$ 284,05). A loja diz R$ 291,00 para o 1º (aprovado a R$ 280,00: +3,9%, passa
  // no verificador) e R$ 280,00 para o 2º (aprovado a R$ 290,00: -3,4%)
  const s = montar(t, { verificar: true, loja: { 2000001: { price: 291, disponivel: true }, 2000002: { price: 280, disponivel: true } } });
  const id = s.regra([linha(1, A, 299)], { per: 1 });
  s.semear(id, 'MLB999', A, 29900, 10 * DIA);
  s.semear(id, 'MLB998', C, 29900, 10 * DIA);
  const subiu = s.revisao(id, ML(2000001, A, 280));
  const desceu = s.revisao(id, ML(2000002, C, 290));
  const r1 = await s.catalogoItens.enviar(subiu, {});
  const r2 = await s.catalogoItens.enviar(desceu, {});
  assert.equal(s.payloadDe(r1.envio_id).preco_ultimo_envio, 29900, 'o payload guarda a referência sem julgar o preço');
  assert.equal(s.payloadDe(r2.envio_id).preco_ultimo_envio, 29900);
  await s.scheduler.envios.processarPendentes();
  const [t1, t2] = s.textos();
  assert.deepEqual(SEM_LINK(t1), [`*${A}*`, 'Por *R$ 291,00*'], 'conferido 4,0% abaixo: sem a linha');
  assert.deepEqual(SEM_LINK(t2), [`*${C}*`, 'Por *R$ 280,00*', baixou('R$ 299,00', 'R$ 280,00')], 'conferido 6,4% abaixo: com a linha');
});

const reservaDe = (s, id, chave) => s.db.prepare('SELECT price_cents FROM sent_offers WHERE rule_id = ? AND offer_key = ? ORDER BY sent_at DESC').all(id, chave).map((r) => r.price_cents);

test('Catálogo (S1): depois de sair, a reserva guarda o preço CONFERIDO; o "Baixou de" seguinte e a trava de parecidos partem dele', async (t) => {
  // aprovado a R$ 280,00; a loja confere R$ 291,00 na fila: o grupo viu 291, então 291 é o "último envio"
  const s = montar(t, { verificar: true, loja: { 2000001: { price: 291, disponivel: true } } });
  const id = s.regra([linha(1, A, 299)], { per: 1 });
  const item = s.revisao(id, ML(2000001, A, 280));
  const r = await s.catalogoItens.enviar(item, {});
  assert.deepEqual(reservaDe(s, id, 'MLB2000001'), [28000], 'enquanto na fila: o preço aprovado');
  await s.scheduler.envios.processarPendentes();
  assert.equal(s.textos().length, 1);
  assert.deepEqual(reservaDe(s, id, 'MLB2000001'), [29100], 'saiu: a reserva guarda o que o grupo viu');
  assert.ok(r.envio_id);
});

test('Catálogo (S1): só a reserva deste envio muda; o envio antigo da MESMA chave na mesma regra continua com o preço que tinha', async (t) => {
  const s = montar(t, { verificar: true, loja: { 2000001: { price: 250, disponivel: true } } });
  const id = s.regra([linha(1, A, 299)], { per: 1 });
  s.semear(id, 'MLB2000001', A, 29900, 10 * DIA); // o mesmo produto, há 10 dias, a R$ 299,00
  const item = s.revisao(id, ML(2000001, A, 252));
  await s.catalogoItens.enviar(item, {});
  await s.scheduler.envios.processarPendentes();
  assert.equal(s.textos().length, 1);
  assert.deepEqual(reservaDe(s, id, 'MLB2000001'), [25000, 29900], 'a nova com o conferido (R$ 250,00); a antiga intacta (R$ 299,00)');
});

test('Catálogo (S1): envio que falhou em todos os grupos deixa a reserva com o preço aprovado; uma reserva de outra regra ou de outro produto não é tocada', async (t) => {
  const s = montar(t, { verificar: true, loja: { 2000001: { price: 291, disponivel: true }, 2000002: { price: 150, disponivel: true } } });
  const id = s.regra([linha(1, A, 299), linha(2, C, 299)], { per: 1 });
  const outra = s.regra([linha(1, A, 299)], { per: 1 });
  s.semear(outra, 'MLB2000001', A, 11100, 2 * DIA); // mesma chave em outra regra
  const item = s.revisao(id, ML(2000001, A, 280));
  const vizinho = s.revisao(id, ML(2000002, C, 140));
  s.wa.sendText = async () => { throw new Error('socket caiu'); };
  s.wa.sendImage = async () => { throw new Error('socket caiu'); };
  await s.catalogoItens.enviar(item, {});
  await s.scheduler.envios.processarPendentes();
  assert.equal(s.textos().length, 0);
  assert.deepEqual(reservaDe(s, id, 'MLB2000001'), [28000], 'falhou: continua o aprovado');
  assert.deepEqual(reservaDe(s, outra, 'MLB2000001'), [11100], 'outra regra intacta');
  assert.deepEqual(reservaDe(s, id, 'MLB2000002'), [], 'o vizinho ainda nem foi enviado');
  assert.ok(vizinho);
});

test('Catálogo: erro ao ler o histórico no "Enviar" não impede o envio, e o console só recebe o código do erro', async (t) => {
  const s = montar(t);
  const id = s.regra([linha(1, A, 299)], { per: 1 });
  s.semear(id, 'MLB2000001', A, 29900, 10 * DIA);
  const item = s.revisao(id, ML(2000001, A, 252));
  const erros = [];
  t.mock.method(console, 'error', (...a) => erros.push(a.map(String).join(' ')));
  const prepare = s.db.prepare.bind(s.db);
  s.db.prepare = (sql) => {
    if (/FROM sent_offers WHERE rule_id = \? AND sent_at > \? ORDER BY sent_at DESC/.test(sql)) throw Object.assign(new Error(`falha com ${A} e 29900`), { code: 'ERR_SQLITE_ERROR' });
    return prepare(sql);
  };
  const r = await s.catalogoItens.enviar(item, {});
  delete s.db.prepare;
  assert.ok(r.envio_id > 0);
  assert.equal(Object.hasOwn(s.payloadDe(r.envio_id), 'preco_ultimo_envio'), false);
  await s.scheduler.envios.processarPendentes();
  assert.equal(s.textos().length, 1);
  assert.equal(s.textos()[0].includes('📉'), false);
  assert.ok(erros.some((e) => e.includes('ERR_SQLITE_ERROR')));
  assert.doesNotMatch(erros.join('\n'), /Fone|29900|socket/, 'nem título nem preço no console');
});

// ====================================================================================== 7. o que NÃO pode mostrar a linha
test('Disparo manual: campos forjados no corpo do POST (origem catálogo e preço do último envio) não chegam ao payload nem à mensagem', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: AGORA }); // 14h: fora do horário de silêncio, em qualquer máquina
  const dir = tmp(); const db = openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const ml = { async resolveOffer(c) { return { key: c.key, url: c.url, title: 'Fone Bom Para Teste', price: 50, oldPrice: null, discountPct: null, sold: 1, freeShipping: false, image: IMG_ML }; } };
  const scheduler = createScheduler({ db, wa, links, fast: true, dir, ml });
  db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run('111@g.us', 'Achadinhos', 10, Date.now());
  db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etiquetaA', Date.now());
  const tpl = Number(db.prepare('INSERT INTO templates (name, body, created_at) VALUES (?,?,?)').run('T', CORPO, Date.now()).lastInsertRowid);
  const { id } = await scheduler.envios.criar({
    tipo: 'oferta', url: 'https://produto.mercadolivre.com.br/MLB-1234567890', tag_id: 1, template_id: tpl, group_jids: ['111@g.us'], quando: 'agora',
    origem: { tipo: 'catalogo', rule_id: 1, nome: 'x' }, preco_ultimo_envio: 100000, precoUltimoEnvio: 100,
  });
  const payload = JSON.parse(db.prepare('SELECT payload FROM envios WHERE id = ?').get(id).payload);
  assert.equal(payload.origem.tipo, 'manual');
  assert.equal(Object.hasOwn(payload, 'preco_ultimo_envio'), false);
  // o "agora" sai pelo próprio agendador (acordar): espera a fila terminar em vez de chamá-la de novo
  for (let i = 0; i < 200 && db.prepare('SELECT status FROM envios WHERE id = ?').get(id).status !== 'concluido'; i++) await new Promise((ok) => setTimeout(ok, 10));
  assert.equal(db.prepare('SELECT status FROM envios WHERE id = ?').get(id).status, 'concluido');
  assert.equal(wa.simulated.length, 1);
  assert.deepEqual(SEM_LINK(wa.simulated[0].text), ['*Fone Bom Para Teste*', 'Por *R$ 50,00*']);
  semCampoCru(wa.simulated.map((m) => m.text));
  db.close();
});

test('Remetente, espelho e Grupo vivo: payload na fila com o preço do último envio e origem que não é catálogo sai sem a linha', async (t) => {
  const s = montar(t);
  const id = s.regra([linha(1, A, 299)], { per: 1 });
  s.semear(id, 'MLB2000001', A, 29900, 10 * DIA);
  for (const tipo of ['remetente', 'espelho', 'manual', undefined, 'Catalogo', 'CATALOGO']) {
    const antes = s.textos().length;
    const payload = {
      url: 'https://produto.mercadolivre.com.br/MLB-2000001', loja: 'mercadolivre', tag_id: 1, etiqueta: 'etiquetaA', template_id: s.tplId,
      template_criado_em: s.db.prepare('SELECT created_at FROM templates WHERE id = ?').get(s.tplId).created_at, fonte_dados: 'manual', enviar_foto: false,
      origem: tipo === undefined ? undefined : { tipo, rule_id: id, nome: 'x' },
      offer: { key: 'MLB2000001', title: A, price: 100, oldPrice: null, discountPct: null, sold: null, freeShipping: false, coupon: null, image: null },
      preco_ultimo_envio: 29900,
    };
    s.db.prepare("INSERT INTO envios (tipo, payload, group_jids, quando, repetir, status, next_run_at, created_at) VALUES ('oferta', ?, ?, 'agora', NULL, 'pendente', ?, ?)")
      .run(JSON.stringify(payload), JSON.stringify(['111@g.us']), Date.now(), Date.now());
    await s.scheduler.envios.processarPendentes();
    s.avancar(HORA);
    assert.equal(s.textos().length, antes + 1, `origem ${tipo}: a oferta saiu`);
    assert.equal(s.textos().at(-1).includes('📉'), false, `origem ${tipo}`);
    semCampoCru(s.textos().slice(antes));
  }
});

// ====================================================================================== 8. navegador real (CA4)
// A prévia do Disparo manual ANTES de identificar o link ("Exemplo. Identifique um link…") é montada pelo painel
// (public/disparos.js, `prever`): sem produto, o painel não manda `amostra`, e o servidor entende "prévia do editor de
// Templates" e acrescenta o preço de exemplo do "Baixou de". O CA4 manda a prévia do Disparo manual NÃO mostrar a linha.
// Chrome headless real (--dump-dom) sobre o painel de verdade (DRY_RUN, pasta descartável, sem rede externa).
// Sem Chrome/Chromium (CHROME_BIN ou google-chrome/chromium no PATH) os testes de navegador são pulados com o motivo.
function acharChrome() {
  const candidatos = [process.env.CHROME_BIN, 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].filter(Boolean);
  for (const c of candidatos) {
    if (path.isAbsolute(c)) { if (fs.existsSync(c)) return c; continue; }
    for (const d of (process.env.PATH || '').split(path.delimiter)) { const f = path.join(d, c); if (fs.existsSync(f)) return f; }
  }
  return null;
}
const CHROME = acharChrome();
const NAV = { skip: CHROME ? false : 'sem Chrome/Chromium (defina CHROME_BIN): os testes de navegador do "Baixou de" foram pulados', timeout: 120000 };
const RAIZ = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

async function comPainelNoChrome(fn) {
  const { spawn } = await import('node:child_process');
  const net = await import('node:net');
  const porta = await new Promise((ok, falha) => { const sv = net.createServer(); sv.listen(0, '127.0.0.1', () => { const { port } = sv.address(); sv.close(() => ok(port)); }); sv.on('error', falha); });
  const dir = tmp();
  const curto = fs.mkdtempSync(path.join(fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir(), 'qabx-')); pastas.push(curto);
  const env = { ...process.env, PORT: String(porta), DATA_DIR: dir, DRY_RUN: '1', FAST: '1', PANEL_PASSWORD: '', PUBLIC_HOST: '', TMPDIR: dir };
  const filho = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(RAIZ, 'src', 'server.js')], { cwd: RAIZ, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const matar = () => { try { process.kill(-filho.pid, 'SIGKILL'); } catch { try { filho.kill('SIGKILL'); } catch { /* já saiu */ } } };
  try {
    let saida = '';
    await new Promise((ok, falha) => {
      const timer = setTimeout(() => falha(new Error(`servidor não subiu em 20 s:\n${saida}`)), 20000);
      const ler = (c) => { saida += c; if (/rodando em http/.test(saida)) { clearTimeout(timer); ok(); } };
      filho.stdout.on('data', ler); filho.stderr.on('data', ler);
      filho.once('exit', (c) => { clearTimeout(timer); falha(new Error(`servidor saiu (${c}):\n${saida}`)); });
    });
    const dom = (rota) => new Promise((ok, falha) => {
      const perfil = fs.mkdtempSync(path.join(curto, 'p-'));
      const c = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-extensions', `--user-data-dir=${perfil}`,
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost', '--virtual-time-budget=8000', '--dump-dom', `http://127.0.0.1:${porta}/${rota}`],
        { stdio: ['ignore', 'pipe', 'ignore'], detached: true, env: { ...process.env, TMPDIR: curto } });
      let html = '';
      const limite = setTimeout(() => { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* já saiu */ } falha(new Error('Chrome não terminou em 60 s')); }, 60000);
      c.stdout.on('data', (d) => (html += d));
      c.once('exit', () => { clearTimeout(limite); ok(html); });
    });
    await fn({ dom, base: `http://127.0.0.1:${porta}` });
  } finally { matar(); }
}
const textoDoBalao = (html, id) => {
  const m = new RegExp(`id="${id}"[^>]*>([\\s\\S]*?)</div>`).exec(html);
  assert.ok(m, `o elemento #${id} não está na página`);
  return m[1].replace(/<[^>]+>/g, '');
};

test('navegador (CA4): a prévia de exemplo do Disparo manual (antes de identificar o link) NÃO mostra "Baixou de"; a do editor de Templates mostra', NAV, async () => {
  await comPainelNoChrome(async ({ dom }) => {
    const templates = textoDoBalao(await dom('#templates'), 'pv');
    assert.match(templates, /📉 Baixou de R\$ 99,90 para R\$ 89,90/, 'Templates: o exemplo do plano');
    const html = await dom('#disparo-manual');
    assert.match(html, /Exemplo\. Identifique um link/, 'o painel está na prévia de exemplo');
    const manual = textoDoBalao(html, 'dm-pv');
    assert.match(manual, /Por R\$ 89,90/, 'a prévia carregou o template com a oferta de exemplo');
    assert.doesNotMatch(manual, /Baixou de/, `CA4: a prévia do Disparo manual não mostra a linha, e mostrou:\n${manual}`);
  });
});
