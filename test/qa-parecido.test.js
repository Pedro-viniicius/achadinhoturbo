// QA do "não repetir produto igual nem parecido, salvo se estiver mais barato" (plano nao-repetir-produto-parecido; CA1 a
// CA9), rodada 1. Complementa test/parecido*.test.js sem repetir: aqui ficam as provas entre as peças (regra × "Enviar" do
// Catálogo × fila de envios), o texto que o código produz contra o que está nos docs, o caso real da Lola, o ruído do
// Histórico, a concorrência e os títulos e preços esquisitos. Tudo com a fiação real (createScheduler, createCatalogoItens,
// fila de envios, verificador), WhatsApp simulado, links falsos, relógio falso (só o Date) e rede proibida.
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
import { createVerificador } from '../src/verificador.js';
import { createCatalogoItens } from '../src/catalogo-itens.js';
import { createCatalogo } from '../src/catalogo.js';
import { createAmazon } from '../src/amazon.js';
import {
  FRASE_MAIS_BARATA, palavras, comparar, centavos, tituloParaGuardar, criarTrava, lerEnviados,
  textoConflito, textoPassou, textoConferencia, textoNaoMaisBarata,
} from '../src/parecido.js';

const fetchOriginal = globalThis.fetch;
let chamadasDeRede = 0;
test.before(() => { globalThis.fetch = async () => { chamadasDeRede++; throw new Error('rede proibida no teste'); }; });
test.after(() => {
  globalThis.fetch = fetchOriginal;
  assert.equal(chamadasDeRede, 0, 'nenhum pedido de rede');
});

const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'qapar-')); pastas.push(p); return p; };

const HORA = 3600000;
const DIA = 24 * HORA;
const dia = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime(); // 10/11/2026, horário local
const AGORA = dia(10, 14);
const idDe = (url) => /MLB-?(\d+)/.exec(String(url))?.[1] ?? null;
const IMG_ML = 'https://http2.mlstatic.com/D_NQ_NP_123-O.jpg';

const A = 'Fone de Ouvido Bluetooth JBL Tune 510BT Preto';
const B = 'Fone de Ouvido Bluetooth JBL Tune 510BT Branco';
const C = 'Tênis Corrida Masculino Nike Revolution 7';
const D = 'Liquidificador Philco 900W 3 Velocidades';
const AZUL = 'Fone de Ouvido Bluetooth JBL Tune 510BT Azul';
const ROSA = 'Fone de Ouvido Bluetooth JBL Tune 510BT Rosa';
const VERDE = 'Fone de Ouvido Bluetooth JBL Tune 510BT Verde';
/** Título sem nenhuma palavra em comum com os outros (nada de "parecido" por acaso). */
const unico = (i) => `Marca${i}alfa Modelo${i}beta Linha${i}gama Tipo${i}delta`;

const linha = (n, titulo, preco) => `https://produto.mercadolivre.com.br/MLB-${1000000 + n}-x | ${titulo} | ${String(preco).replace('.', ',')}`;
const CORPO = '*{TITULO_PRODUTO}*\n{PRECO_PRODUTO}\n{LINK}';

/** Catálogo como o agendador entrega (candidato do ML), para `registrar`/`enviar`. */
const ML = (n, titulo, preco) => ({ key: `MLB${n}`, title: titulo, price: preco, oldPrice: null, discountPct: null, sold: 10, freeShipping: true, coupon: null, image: IMG_ML, categoria: 'Casa', tag_id: null, source_index: 0 });

/**
 * Fiação do servidor (criarServicos), sem o `acordar` (a fila roda quando o teste manda): agendador, "Enviar" do Catálogo e
 * fila de envios no mesmo banco. `loja`: id do MLB → leitura da loja (só com `verificar`).
 */
function montar(t, { agora = AGORA, loja = {}, verificar = false, verificadorFalso = null, limite = null } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: agora });
  const dir = tmp(); const db = openDb(dir);
  if (limite != null) db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('wa_limite_hora', String(limite)); // teto de mensagens por hora
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const eventos = [];
  const pedirLink = links.requestLink;
  links.requestLink = async (p) => { eventos.push(`link ${idDe(p.url)}`); return pedirLink(p); };
  const amazon = createAmazon({ db, fetch: async () => { throw new Error('rede proibida (Amazon)'); }, esperar: async () => {}, lerConexao: () => ({ tag: 'achadinho-20' }) });
  const mlLoja = { async conferirProduto(url) { const id = idDe(url); eventos.push(`conferir ${id}`); const r = loja[id]; if (!r) throw new Error('loja fora do ar (falsa)'); return r; } };
  const verificador = verificadorFalso ?? (verificar ? createVerificador({ db, ml: mlLoja, amazon }) : null);
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
  const tplId = Number(db.prepare('INSERT INTO templates (name, body, created_at) VALUES (?,?,?)').run(`T${Math.random()}`, CORPO, Date.now()).lastInsertRowid);
  const s = {
    db, wa, links, scheduler, catalogoItens, eventos, tplId,
    /** Regra da "Lista de links" com as linhas dadas. → id */
    regra(itens, { per = 3, dedupe = 7, imagem = 0 } = {}) {
      return Number(db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id, group_jids, source_type, source_config, per_run, interval_min,
        window_start, window_end, dedupe_days, send_image, created_at) VALUES ('Lista', 1, 1, ?, ?, 'list', ?, ?, 60, '00:00', '23:59', ?, ?, ?)`)
        .run(tplId, JSON.stringify(['111@g.us']), JSON.stringify({ items: itens.join('\n') }), per, dedupe, imagem, Date.now()).lastInsertRowid);
    },
    trocarLista(id, itens) { db.prepare('UPDATE rules SET source_config = ? WHERE id = ?').run(JSON.stringify({ items: itens.join('\n') }), id); },
    /** Item na revisão do Catálogo da regra. → id do item */
    revisao(ruleId, c) {
      const regra = { id: ruleId, name: 'Lista', dedupe_days: 7 };
      assert.equal(catalogoItens.registrar(regra, c, 'revisao', ['falha_link']), true);
      return db.prepare('SELECT id FROM catalogo_itens WHERE rule_id = ? AND chave = ?').get(ruleId, c.key).id;
    },
    avancar(ms) { t.mock.timers.setTime(Date.now() + ms); },
    logs: (id) => db.prepare('SELECT level, group_name, offer_title, message FROM log WHERE rule_id = ? OR rule_id IS NULL ORDER BY id').all(id).map((l) => ({ ...l })),
    reservas: (id) => db.prepare('SELECT offer_key, title, price_cents FROM sent_offers WHERE rule_id = ? ORDER BY id').all(id).map((l) => ({ ...l })),
    textos: () => wa.simulated.map((m) => m.text),
  };
  return s;
}
const reaisDoWa = new WeakMap();
const quebrarWhatsApp = (s) => {
  reaisDoWa.set(s, { sendText: s.wa.sendText, sendImage: s.wa.sendImage });
  s.wa.sendText = async () => { throw new Error('socket caiu'); };
  s.wa.sendImage = async () => { throw new Error('socket caiu'); };
};
const consertarWhatsApp = (s) => Object.assign(s.wa, reaisDoWa.get(s));

// ============================================================================================ 1. frases: código × docs
const README = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const CAP_REF = fs.readFileSync(new URL('../public/docs/cap-referencia.js', import.meta.url), 'utf8');
const CAP_DISP = fs.readFileSync(new URL('../public/docs/cap-disparos.js', import.meta.url), 'utf8');
const AJUDA = fs.readFileSync(new URL('../public/ajuda.js', import.meta.url), 'utf8');
const T = '…'; // o título entre aspas nos docs
// o exemplo dos docs: o anterior saiu às 09:02 de 08/11 (outro dia) ou às 09:02 de hoje, "agora" é 10/11 às 14:00
const AGORA_DOC = dia(10, 14);
const FRASES_DOC = [
  textoConflito({ tipo: 'mesmo', anterior: { title: T, preco: 4990, sent_at: dia(8, 9, 2) } }, AGORA_DOC),
  textoConflito({ tipo: 'parecido', anterior: { title: T, preco: 4990, sent_at: dia(10, 9, 2) } }, AGORA_DOC),
  textoConflito({ tipo: 'rodada', anterior: { title: T, preco: null, sent_at: null } }, AGORA_DOC),
  textoPassou({ title: T, preco: 5990, sent_at: dia(10, 9, 2) }, 49.9, AGORA_DOC),
  textoConferencia({ title: T, preco: 4990, sent_at: dia(10, 9, 2) }, 52, AGORA_DOC),
];
const DESCARTE_DOC = textoNaoMaisBarata(52, 4990);

test('docs (ponto 1): as 5 frases do Histórico do README são, letra por letra, as que o código monta', () => {
  const secao = README.slice(README.indexOf('## Ofertas repetidas e parecidas'), README.indexOf('## Horários marcados e Grupo vivo'));
  const doREADME = [...secao.matchAll(/^- `([^`]+)`$/gm)].map((m) => m[1]);
  assert.deepEqual(doREADME, FRASES_DOC.map((f) => f.replaceAll('"…"', '"…"')));
  assert.ok(secao.includes('`sem preço guardado para comparar`'), 'a variante sem preço está no README');
  assert.equal(textoConflito({ tipo: 'parecido', anterior: { title: T, preco: null, sent_at: dia(10, 9, 2) } }, AGORA_DOC).includes('sem preço guardado para comparar'), true);
  assert.ok(secao.includes(DESCARTE_DOC), 'a frase do descarte da fila está no README');
  assert.ok(secao.includes(FRASE_MAIS_BARATA), 'a frase da mensagem está no README');
  assert.ok(secao.includes('começando por `Não enviada:`'), 'o prefixo do 409 está no README');
});

test('docs (ponto 1): as frases do capítulo Referência (com aspas tipográficas) são as do código; o 409 e o descarte também', () => {
  const frasesCap = [...CAP_REF.matchAll(/'((?:Pulada|Saiu como|Descartada: preço subiu para)[^']*)'/g)].map((m) => m[1].replaceAll('“', '"').replaceAll('”', '"'));
  assert.deepEqual(frasesCap, [...FRASES_DOC, DESCARTE_DOC], 'mesma lista, mesma ordem');
  assert.match(CAP_REF, /'Não enviada: … \(as mesmas frases de “Pulada”\)'/);
  // a frase da mensagem: README, capítulo do Disparo automático (aspas tipográficas ao redor) e o TIP não a repetem diferente
  assert.ok(CAP_DISP.includes(`“${FRASE_MAIS_BARATA}”`), 'cap-disparos traz a frase idêntica');
  assert.equal(FRASE_MAIS_BARATA, '🔎 Nossa busca achou esta oportunidade ainda melhor, caso você ainda não tenha aproveitado a primeira.');
  assert.ok(AJUDA.includes("'regras.dedupe': 'Por quantos dias a mesma oferta não se repete neste disparo."));
});

/** Regex a partir de uma frase dos docs: o título (…), as horas, as datas e os valores viram padrões. */
const molde = (frase) => new RegExp(`^${frase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  .replaceAll('…', '.+').replace(/\d\d:\d\d( de \d\d\/\d\d)?/g, '\\d\\d:\\d\\d( de \\d\\d\\/\\d\\d)?').replace(/R\\\$ \d+,\d\d/g, 'R\\$ \\d+,\\d\\d')}$`);

test('docs (ponto 1) ponta a ponta: o Histórico e o 409 que o sistema produz casam com as frases dos docs', async (t) => {
  const s = montar(t);
  // 1) a regra envia A; 2) uma parecida de mesmo preço na mesma rodada, uma mais cara 3 h depois, o mesmo título com outra
  //    chave e o mesmo título pelo menos 5% mais barato (adendo D10/D11: só o mesmo título tem a exceção do preço)
  const id = s.regra([linha(1, A, 59.9), linha(2, B, 59.9)], { per: 2 });
  await s.scheduler.runRule(id);
  const rodada = s.logs(id).filter((l) => l.level === 'info' && /^(Pulada|Saiu)/.test(l.message));
  assert.equal(rodada.length, 1);
  assert.match(rodada[0].message, molde(FRASES_DOC[2]), 'rodada');

  s.avancar(3 * HORA);
  s.trocarLista(id, [linha(3, B, 59.9), linha(4, A, 59.9), linha(5, A, 40)]);
  await s.scheduler.runRule(id);
  const novas = s.logs(id).filter((l) => /^(Pulada|Saiu)/.test(l.message)).slice(1);
  assert.deepEqual(novas.map((l) => l.level), ['info', 'info', 'info']);
  assert.match(novas[0].message, molde(FRASES_DOC[1]), 'parecida (3 h)');
  assert.match(novas[1].message, molde(FRASES_DOC[0]), 'mesmo título, outra chave');
  assert.match(novas[2].message, molde(FRASES_DOC[3]), 'saiu como oportunidade melhor');

  // 3) o "Enviar" do Catálogo: 409 com "Não enviada:" e a mesma frase de "Pulada"
  const item = s.revisao(id, ML(2000001, AZUL, 59.9));
  await assert.rejects(s.catalogoItens.enviar(item, {}), (e) => {
    assert.equal(e.status, 409);
    assert.match(e.message, new RegExp(`^${molde(FRASES_DOC[1]).source.slice(1, -1).replace('Pulada:', 'Não enviada:')}$`));
    return true;
  });
});

// ====================================================================================== 2. regra × Catálogo, nos dois sentidos
test('ponta a ponta (ponto 2): a regra envia A; o "Enviar" do Catálogo de uma mais barata sai com a frase; a regra e o Catálogo enxergam um ao outro', async (t) => {
  const s = montar(t);
  const id = s.regra([linha(1, A, 59.9)], { per: 1 });

  // 1) a regra envia A (R$ 59,90): sem frase, e a reserva guarda título e preço em centavos
  await s.scheduler.runRule(id);
  assert.equal(s.textos().length, 1);
  assert.equal(s.textos()[0].includes(FRASE_MAIS_BARATA), false);
  assert.deepEqual(s.reservas(id), [{ offer_key: 'MLB1000001', title: A, price_cents: 5990 }]);

  // 2) 2 h depois, o dono envia pelo Catálogo o mesmo título (outra chave) a R$ 49,90: o Catálogo enxerga o que a regra enviou
  s.avancar(2 * HORA);
  const b = s.revisao(id, ML(2000001, A, 49.9));
  const r = await s.catalogoItens.enviar(b, {});
  assert.deepEqual(JSON.parse(s.db.prepare('SELECT payload FROM envios WHERE id = ?').get(r.envio_id).payload).mais_barata, { preco_anterior: 5990 });
  await s.scheduler.envios.processarPendentes();
  assert.equal(s.textos().length, 2);
  assert.ok(s.textos()[1].startsWith(`${FRASE_MAIS_BARATA}\n\n*${A}*`), s.textos()[1]);
  const passou = s.logs(id).filter((l) => l.message.startsWith('Saiu como oportunidade melhor'));
  assert.equal(passou.length, 1);
  assert.match(passou[0].message, /o mesmo produto saiu às \d\d:\d\d por R\$ 59,90 \("Fone de Ouvido Bluetooth JBL Tune 510BT Preto"\); agora por R\$ 49,90\.$/);

  // 3) uma parecida no Catálogo, de preço igual ao do Catálogo: o Catálogo enxerga o próprio envio (o mais recente, a R$ 49,90)
  const b2 = s.revisao(id, ML(2000002, AZUL, 49.9));
  await assert.rejects(s.catalogoItens.enviar(b2, {}), (e) => {
    assert.equal(e.status, 409);
    assert.match(e.message, /^Não enviada: parecida com ".+", que saiu por este disparo às \d\d:\d\d por R\$ 49,90\. Ofertas parecidas esperam 24 h/);
    return true;
  });

  // 4) 1 h depois, a regra enxerga o envio do Catálogo: o mesmo título a R$ 47,41 é pulado citando R$ 49,90 (e não os
  //    R$ 59,90 da regra, contra os quais passaria); o de R$ 47,40 (5% abaixo) sai com a frase, com o mínimo vindo do Catálogo
  s.avancar(HORA);
  s.trocarLista(id, [linha(10, A, 47.41), linha(11, A, 47.4)]);
  const antes = s.textos().length;
  await s.scheduler.runRule(id);
  const pulada = s.logs(id).filter((l) => l.message.startsWith('Pulada: o mesmo produto'));
  assert.equal(pulada.length, 1);
  assert.match(pulada[0].message, /por R\$ 49,90, com outro código/);
  assert.equal(s.textos().length, antes + 1);
  assert.ok(s.textos().at(-1).startsWith(`${FRASE_MAIS_BARATA}\n\n`));
  assert.ok(s.textos().at(-1).includes('R$ 47,40'));
  assert.deepEqual(s.reservas(id).map((x) => [x.offer_key, x.price_cents]), [['MLB1000001', 5990], ['MLB2000001', 4990], ['MLB1000011', 4740]]);
  // nada de dado pessoal nem de grupo nas linhas novas
  for (const l of s.logs(id).filter((x) => /^(Pulada|Saiu como)/.test(x.message))) {
    assert.equal(l.group_name, null);
    assert.doesNotMatch(l.message, /@|Achadinhos|\d{9,}/);
  }
});

// ============================================================================================ 3. envio que falha em tudo
test('falha total (ponto 3): sem nenhum grupo ok a reserva some (liberarFalhos) e deixa de barrar parecidas; antes disso ela barra', async (t) => {
  const s = montar(t);
  const id = s.regra([linha(1, A, 59.9)], { per: 1 });
  await s.scheduler.runRule(id);

  s.avancar(2 * HORA);
  quebrarWhatsApp(s);
  const b = s.revisao(id, ML(2000001, A, 49.9)); // o mesmo título, outra chave
  const r = await s.catalogoItens.enviar(b, {});
  await s.scheduler.envios.processarPendentes();
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM envio_resultados WHERE envio_id = ? AND ok = 1').get(r.envio_id).n, 0, 'nenhum grupo ok');
  assert.equal(s.reservas(id).length, 2, 'a reserva do envio que falhou ainda está lá');

  // enquanto a reserva existe, outro item do mesmo título a R$ 49,90 é barrado por ela
  const b2 = s.revisao(id, ML(2000002, A, 49.9));
  await assert.rejects(s.catalogoItens.enviar(b2, {}), (e) => e.status === 409 && /por R\$ 49,90, com outro código/.test(e.message));

  assert.equal(s.catalogoItens.liberarFalhos(), 1);
  assert.deepEqual(s.reservas(id).map((x) => x.offer_key), ['MLB1000001'], 'só a da regra, que saiu de verdade');

  // sem a reserva, a de R$ 49,90 compara só com os R$ 59,90 que saíram de fato: sai com a frase
  const ok = await s.catalogoItens.enviar(b2, {});
  assert.deepEqual(JSON.parse(s.db.prepare('SELECT payload FROM envios WHERE id = ?').get(ok.envio_id).payload).mais_barata, { preco_anterior: 5990 });
});

test('falha total (ponto 3): a regra libera a reserva sozinha ao começar a rodada, e a parecida volta a valer', async (t) => {
  const s = montar(t);
  const id = s.regra([linha(1, A, 59.9)], { per: 1 });
  await s.scheduler.runRule(id);
  s.avancar(2 * HORA);
  quebrarWhatsApp(s);
  const b = s.revisao(id, ML(2000001, A, 49.9)); // o mesmo título, outra chave
  await s.catalogoItens.enviar(b, {});
  await s.scheduler.envios.processarPendentes();
  assert.equal(s.reservas(id).length, 2);

  // a regra traz o mesmo título a R$ 49,95: barrado se a reserva de R$ 49,90 ainda existisse; sai com a frase porque o mínimo real é R$ 59,90
  s.trocarLista(id, [linha(10, A, 49.95)]);
  consertarWhatsApp(s);
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.errors], [1, 0]);
  assert.ok(s.logs(id).some((l) => /^Saiu como oportunidade melhor: .*por R\$ 59,90 \(".+"\); agora por R\$ 49,95\.$/.test(l.message)));
  assert.equal(s.logs(id).some((l) => l.message.startsWith('Pulada')), false);
});

test('falha total (ponto 3): descartada pela fila (preço subiu na conferência) também deixa de barrar depois do liberarFalhos', async (t) => {
  // A saiu a R$ 50,00; o mesmo título a R$ 47,00 passa na aprovação (até R$ 47,50), mas a loja diz R$ 49,00 na conferência
  // (+4%, dentro do que o verificador aceita): descartada
  const s = montar(t, { verificar: true, loja: { 2000001: { price: 49, disponivel: true } } });
  const id = s.regra([linha(1, A, 50)], { per: 1 });
  s.db.prepare('INSERT INTO sent_offers (rule_id, offer_key, sent_at, title, price_cents) VALUES (?,?,?,?,?)').run(id, 'MLB999', Date.now() - 2 * HORA, A, 5000);
  const b = s.revisao(id, ML(2000001, A, 47));
  const r = await s.catalogoItens.enviar(b, {});
  await s.scheduler.envios.processarPendentes();
  assert.equal(s.textos().length, 0, 'não saiu nada');
  assert.ok(s.logs(id).some((l) => l.message.startsWith('Descartada: preço subiu para R$ 49,00 e não está mais pelo menos 5% abaixo')), s.logs(id).map((l) => l.message).join('\n'));
  assert.equal(s.reservas(id).length, 2);
  assert.equal(s.catalogoItens.liberarFalhos(), 1, 'a descartada não vale como enviada');
  assert.deepEqual(s.reservas(id).map((x) => x.offer_key), ['MLB999']);
  assert.ok(r.envio_id > 0);
});

// ============================================================================================ 4. o caso da Lola
const SHAMPOO_LOLA = 'Lola Cosmetics - Morte Subita - Shampoo hidratante para cabelos secos e danificados que foi quimicamente tratado vegano, livre de crueldade, sem parabenos, sem sulfatos, 250 ml';
const CONDICIONADOR_LOLA = 'Lola From Rio - Morte Subita - Condicionador hidratante para todos os tipos de cabelos secos e danificados, vegano, sem crueldade, sem parabenos, sem sulfatos, 250 g';

test('caso Lola (ponto 4): shampoo × condicionador, com os títulos completos e abreviados, dá 50% e não é parecido; a variante do mesmo shampoo é', () => {
  const pS = palavras(SHAMPOO_LOLA).slice(0, 8); const pC = palavras(CONDICIONADOR_LOLA).slice(0, 8);
  assert.deepEqual(pS, ['lola', 'cosmetics', 'morte', 'subita', 'shampoo', 'hidratante', 'cabelos', 'secos']);
  assert.deepEqual(pC, ['lola', 'from', 'rio', 'morte', 'subita', 'condicionador', 'hidratante', 'todos']);
  assert.equal(pS.filter((p) => pC.includes(p)).length, 4, '4 de 8 em comum = 50%');
  assert.equal(comparar(SHAMPOO_LOLA, CONDICIONADOR_LOLA), null);
  assert.equal(comparar(CONDICIONADOR_LOLA, SHAMPOO_LOLA), null, 'simétrico');
  assert.equal(comparar('Lola Cosmetics - Shampoo hidratante', 'Lola From Rio - Condicionador hidratante'), null, 'abreviados');
  assert.equal(comparar(SHAMPOO_LOLA, SHAMPOO_LOLA.replace('250 ml', '500 ml')), 'parecido', 'só o volume muda depois da 8ª palavra: é o mesmo produto');
});

test('caso Lola (ponto 4) pela regra: shampoo e condicionador saem juntos na mesma rodada e na rodada seguinte, sem linha de pulada', async (t) => {
  const s = montar(t);
  const id = s.regra([linha(1, SHAMPOO_LOLA, 39.9), linha(2, CONDICIONADOR_LOLA, 41.9)], { per: 2 });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages], [2, 2]);
  assert.equal(s.textos().some((x) => x.includes(FRASE_MAIS_BARATA)), false);
  assert.equal(s.logs(id).some((l) => /^Pulada/.test(l.message)), false);
  // com o shampoo mais barato no dia seguinte (outro código), o condicionador não atrapalha e o shampoo leva a frase
  s.avancar(3 * HORA);
  s.trocarLista(id, [linha(3, SHAMPOO_LOLA, 35.9)]);
  await s.scheduler.runRule(id);
  assert.ok(s.textos().at(-1).startsWith(FRASE_MAIS_BARATA));
  assert.match(s.logs(id).filter((l) => l.message.startsWith('Saiu como'))[0].message, /R\$ 39,90 \("Lola Cosmetics.+"\); agora por R\$ 35,90/, 'o anterior é o shampoo (R$ 39,90), não o condicionador');
});

// ============================================================================================ 5. ruído do Histórico
test('ruído (ponto 5, R4): a mesma parecida barrada vira 1 linha em 24 rodadas de 60 min (eram 23)', async (t) => {
  const s = montar(t);
  // ordem fixa (lista): a candidata B fica no topo e é parecida com A, que saiu na 1ª rodada; sai uma diferente por rodada
  const id = s.regra([linha(1, A, 50), linha(2, B, 55), ...Array.from({ length: 30 }, (_, i) => linha(10 + i, unico(i), 20 + i))], { per: 1, dedupe: 7 });
  let puladasDeB = 0; let linhasTotais = 0;
  for (let rodada = 0; rodada < 24; rodada++) {
    const antes = s.logs(id).length;
    await s.scheduler.runRule(id);
    const novas = s.logs(id).slice(antes);
    puladasDeB += novas.filter((l) => l.message.startsWith('Pulada: parecida')).length;
    linhasTotais += novas.length;
    s.avancar(HORA);
  }
  assert.equal(puladasDeB, 1, 'uma linha "Pulada" por conflito, não por rodada');
  console.log(`[qa] medição: ${puladasDeB} linha "Pulada" em 24 rodadas; ${linhasTotais} linhas de Histórico no total (${(linhasTotais / 24).toFixed(1)} por rodada)`);
});

test('ruído (ponto 5, R4): o mesmo título com outra chave fica barrado pelos "dias sem repetir" inteiros com 1 linha por candidata, não por rodada', async (t) => {
  const s = montar(t);
  const id = s.regra([linha(1, A, 50), linha(2, A, 55), ...Array.from({ length: 30 }, (_, i) => linha(10 + i, unico(i), 20 + i))], { per: 1, dedupe: 7 });
  for (let rodada = 0; rodada < 24 * 3; rodada++) { await s.scheduler.runRule(id); s.avancar(HORA); }
  const mesmo = s.logs(id).filter((l) => l.message.startsWith('Pulada: o mesmo produto')).length;
  assert.equal(mesmo, 1, 'em 3 dias, 1 linha (eram 71)');
});

// ============================================================================================ 6. títulos e preços esquisitos
test('títulos esquisitos (ponto 6): vazio, null, número, objeto, emoji, só vazias e 1 caractere nunca são comparados nem derrubam nada', () => {
  const esquisitos = [undefined, null, '', '   ', 0, 42, NaN, {}, [], true, '😀😀😀 🔥🔥 ❤️', 'de da do e com para', 'original oferta promocao novo nova frete gratis envio imediato premium top lancamento', 'A B C D E F', '日本語のタイトルです', '\u0000\u0001\u0002'];
  for (const t of esquisitos) {
    assert.deepEqual(palavras(t), palavras(t), 'não lança');
    assert.equal(comparar(t, A), null, String(t));
    assert.equal(comparar(A, t), null, String(t));
    const trava = criarTrava({ enviados: [{ offer_key: 'X', title: A, price_cents: 5000, sent_at: AGORA - HORA }], agora: AGORA, dedupeDias: 7 });
    assert.equal(trava.avaliar({ key: 'K', title: t, price: 10 }), null, `${String(t)} nunca é barrado`);
    trava.acrescentar({ key: 'K', title: t });
  }
  assert.equal(tituloParaGuardar(42), null);
  assert.equal(tituloParaGuardar(null), null);
  assert.equal(tituloParaGuardar('  \n\t '), null);
});

test('títulos esquisitos (ponto 6): 300 caracteres, palavras repetidas e acentos', () => {
  const longo = 'Fone '.repeat(60); // 300 caracteres, 60 palavras iguais
  assert.equal(tituloParaGuardar(longo).length <= 200, true);
  assert.equal(comparar(longo, longo), 'mesmo');
  assert.equal(comparar('Fone Fone Fone', 'Fone Fone Fone Fone'), null, 'as palavras repetidas contam 1 só: menos de 3 distintas nas 8 primeiras, e a sequência difere');
  // 199 'a' + emoji: o corte em 200 não deixa meio emoji
  const corte = tituloParaGuardar(`${'a'.repeat(199)}😀 resto`);
  assert.doesNotMatch(corte, /[\ud800-\udbff]$/);
  assert.equal(comparar('Tênis Corrida Masculino', 'TENIS  corrida,  masculino!'), 'mesmo');
  assert.equal(comparar('Pão de Açúcar Integral', 'Pao Acucar Integral'), 'mesmo');
  assert.equal(comparar('Café Torrado Moído 500g', 'Cafe Torrado Moido 500g'), 'mesmo');
});

test('preços esquisitos (ponto 6): texto, NaN, negativo, zero, centavo quebrado e preço ilegível dos dois lados barram (só 5% mais barato libera)', () => {
  const trava = (preco) => criarTrava({ enviados: [{ offer_key: 'X', title: A, price_cents: preco, sent_at: AGORA - 3 * HORA }], agora: AGORA, dedupeDias: 7 });
  // o mesmo título com outra chave (a parecida não tem exceção de preço: adendo D10); 5% abaixo de R$ 50,00 = R$ 47,50
  const ava = (preco, anterior = 5000) => trava(anterior).avaliar({ key: 'K', title: A, price: preco })?.acao;
  assert.equal(ava('49,90'), 'barrar', 'texto com vírgula não vira número: sem preço = barra');
  assert.equal(ava('R$ 49,90'), 'barrar');
  assert.equal(ava(NaN), 'barrar');
  assert.equal(ava(-1), 'barrar');
  assert.equal(ava(0), 'barrar');
  assert.equal(ava(0.004), 'barrar');
  assert.equal(ava(null), 'barrar');
  assert.equal(ava(undefined), 'barrar');
  assert.equal(ava(Infinity), 'barrar');
  assert.equal(ava('47.50'), 'liberar', 'texto numérico com ponto vale (a oferta guarda número, é só defesa)');
  assert.equal(ava(47.5), 'liberar');
  assert.equal(ava(49.99), 'barrar', 'mais barato, mas não 5%');
  assert.equal(ava(50), 'barrar', 'igual');
  assert.equal(ava(49.995), 'barrar', 'arredonda para 5000 centavos: igual');
  assert.equal(ava(47.505), 'barrar', 'arredonda para 4751: um centavo acima do limite');
  assert.equal(ava(47.504), 'liberar', 'arredonda para 4750');
  assert.equal(ava(10, null), 'barrar', 'anterior sem preço');
  assert.equal(ava(10, 0), 'barrar', 'anterior com preço 0 conta como sem preço');
  assert.equal(ava(10, -5), 'barrar');
  assert.equal(ava(10, 12.5), 'barrar', 'anterior não inteiro (coluna suja) conta como sem preço');
  assert.equal(ava(10, '5000'), 'barrar', 'texto na coluna conta como sem preço');
  assert.equal(centavos(0.1 + 0.2), 30);
  assert.equal(centavos(1.005), 100);
});

test('dados velhos e sujos em sent_offers (ponto 6): título NULL, número ou vazio não entram; preço texto vira "sem preço"', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: AGORA });
  const db = openDb(tmp());
  const ins = db.prepare('INSERT INTO sent_offers (rule_id, offer_key, sent_at, title, price_cents) VALUES (1,?,?,?,?)');
  ins.run('N', AGORA - HORA, null, 5000);          // ML antigo: sem título
  ins.run('V', AGORA - HORA, '', 5000);            // título vazio
  ins.run('X', AGORA - HORA, 12345, 5000);         // número na coluna de texto (vira '12345')
  ins.run('P', AGORA - HORA, A, 'abc');            // preço texto
  const lidos = lerEnviados(db, 1, AGORA - DIA);
  assert.deepEqual(lidos.map((l) => l.offer_key).sort(), ['P', 'V', 'X'], 'só o NULL fica de fora');
  const trava = criarTrava({ enviados: lidos, agora: AGORA, dedupeDias: 7 });
  // o mesmo título (a parecida não tem exceção de preço desde a D10, então só ele exercita a leitura do preço sujo)
  const r = trava.avaliar({ key: 'K', title: A, price: 10 });
  assert.equal(r.acao, 'barrar', 'o preço "abc" vale como sem preço: barra, mesmo com a candidata a R$ 10');
  assert.equal(r.tipo, 'mesmo');
  assert.equal(r.anterior.preco, null);
});

// ============================================================================================ 7. concorrência
test('concorrência: dois "Enviar" de parecidas ao mesmo tempo (nada antes, mesmo preço) deixam sair só um; o outro recebe 409', async (t) => {
  const s = montar(t);
  const id = s.regra([linha(1, D, 10)]);
  const i1 = s.revisao(id, ML(2000001, A, 49.9));
  const i2 = s.revisao(id, ML(2000002, B, 49.9));
  const r = await Promise.allSettled([s.catalogoItens.enviar(i1, {}), s.catalogoItens.enviar(i2, {})]);
  assert.deepEqual(r.map((x) => x.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(r.find((x) => x.status === 'rejected').reason.status, 409);
  assert.match(r.find((x) => x.status === 'rejected').reason.message, /^Não enviada: parecida com/);
  assert.equal(s.reservas(id).length, 1);
});

test('concorrência: "Enviar" do Catálogo no meio de uma rodada da regra não fura a trava (a regra só reserva depois de enviar)',
  async (t) => {
    const s = montar(t);
    const id = s.regra([linha(1, A, 50)], { per: 1 });
    const item = s.revisao(id, ML(2000001, B, 50));
    const reais = s.wa.sendText;
    let durante = null;
    s.wa.sendText = async (...a) => { // o dono clica em "Enviar" enquanto a regra manda a oferta A aos grupos
      durante = await s.catalogoItens.enviar(item, {}).then(() => 'enviou', (e) => `recusou ${e.status}`);
      return reais(...a);
    };
    await s.scheduler.runRule(id);
    assert.equal(durante, 'recusou 409', 'parecida de mesmo preço, no meio da rodada da regra: deveria ser barrada');
  });

// ============================================================================================ 8. conferência na loja da regra
test('regra 8: se a oferta volta da conferência sem preço legível, ela não sai com a frase', async (t) => {
  // verificador falso que devolve a oferta sem preço (a real nunca faz isso: devolve conferido:false com o preço da escolha)
  let conferencias = 0;
  const verificadorFalso = { async conferir(oferta) { conferencias++; const { price: _p, ...semPreco } = oferta; return { acao: 'enviar', oferta: semPreco, sufixo: null }; } };
  const s = montar(t, { verificadorFalso });
  const id = s.regra([linha(1, A, 49.9)], { per: 1 }); // o mesmo título 5% mais barato: liberado na escolha
  s.db.prepare('INSERT INTO sent_offers (rule_id, offer_key, sent_at, title, price_cents) VALUES (?,?,?,?,?)').run(id, 'MLB999', Date.now() - 3 * HORA, A, 5990);
  await s.scheduler.runRule(id);
  assert.equal(conferencias, 1, 'a oferta foi escolhida (liberada pela trava) e chegou à conferência: o teste não passa por não ter exercitado nada');
  assert.equal(s.textos().some((x) => x.includes(FRASE_MAIS_BARATA)), false, 'preço ilegível nunca vai com a frase');
  assert.equal(s.textos().length, 0, 'e é pulada: nada sai');
  assert.equal(s.logs(id).some((l) => /undefined|NaN|R\$ ?,/.test(l.message)), false, 'nenhuma linha com preço vazio');
});

// ============================================================================================ 9. mais regressões (CA3, CA7, CA8)
test('CA8: chave exata continua barrada pelo wasSent, com e sem dedupe, sem linha da trava e sem mexer no título guardado', async (t) => {
  const s = montar(t);
  const id = s.regra([linha(1, C, 199.9)], { per: 1, dedupe: 7 });
  await s.scheduler.runRule(id);
  s.avancar(30 * 60 * 1000);
  const antes = s.textos().length;
  await s.scheduler.runRule(id);
  assert.equal(s.textos().length, antes, 'a mesma chave não sai de novo');
  assert.equal(s.logs(id).some((l) => /^Pulada/.test(l.message)), false, 'quem barrou foi o wasSent, em silêncio');
});

test('CA3: mesma marca, produtos diferentes na mesma rodada saem juntos; a trava não atrapalha o per_run', async (t) => {
  const s = montar(t);
  const id = s.regra([
    linha(1, 'Philco Liquidificador Turbo 900W Preto Jarra Vidro', 199), linha(2, 'Philco Ventilador Mesa 40cm Silencioso Turbo Branco', 210),
    linha(3, 'Philco Air Fryer Digital 4L Preta Painel Touch', 350),
  ], { per: 3 });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages], [3, 3]);
  assert.equal(s.logs(id).some((l) => /^Pulada/.test(l.message)), false);
});

// ============================================================================================ 10. limite da legenda
test('legenda: o texto padrão com o título longo (200 caracteres) e a frase cabe em 1024 caracteres de legenda do WhatsApp', async (t) => {
  const s = montar(t);
  const padrao = s.db.prepare("SELECT body FROM templates WHERE name = 'Padrão'").get().body;
  s.db.prepare('UPDATE templates SET body = ? WHERE id = ?').run(padrao, s.tplId);
  const tituloLongo = `Fone de Ouvido Bluetooth ${'Premium Resistente Agua Alta Fidelidade '.repeat(6)}`.slice(0, 200);
  const id = s.regra([linha(1, tituloLongo, 49.9)], { per: 1, imagem: 1 });
  s.db.prepare('INSERT INTO sent_offers (rule_id, offer_key, sent_at, title, price_cents) VALUES (?,?,?,?,?)').run(id, 'MLB999', Date.now() - 3 * HORA, tituloLongo, 5990);
  await s.scheduler.runRule(id);
  const msg = s.wa.simulated.at(-1);
  assert.ok(msg.text.startsWith(FRASE_MAIS_BARATA));
  assert.ok(msg.text.length < 1024, `legenda com ${msg.text.length} caracteres`);
});

// ============================================================================================ 11. Histórico honesto
test('Histórico: "Saiu como oportunidade melhor" não pode ficar no Histórico de uma oferta que a fila descartou ou que falhou em todos os grupos',
  async (t) => {
    // o mesmo título a R$ 47,00 (até R$ 47,50 passa); a loja diz R$ 49,00 (+4%, dentro do que o verificador aceita)
    const s = montar(t, { verificar: true, loja: { 2000001: { price: 49, disponivel: true } } });
    const id = s.regra([linha(1, A, 50)], { per: 1 });
    s.db.prepare('INSERT INTO sent_offers (rule_id, offer_key, sent_at, title, price_cents) VALUES (?,?,?,?,?)').run(id, 'MLB999', Date.now() - 2 * HORA, A, 5000);
    const b = s.revisao(id, ML(2000001, A, 47));
    await s.catalogoItens.enviar(b, {});
    await s.scheduler.envios.processarPendentes();
    const msgs = s.logs(id).map((l) => l.message);
    assert.ok(msgs.some((m) => m.startsWith('Descartada: preço subiu para R$ 49,00')), 'a fila descartou');
    assert.equal(s.textos().length, 0, 'e nada saiu');
    assert.equal(msgs.some((m) => m.startsWith('Saiu como oportunidade melhor')), false, 'então o Histórico não pode dizer que saiu');
  });

// ============================================================================================ 12. Novidades (a ordem padrão)
const asin = (i) => `B0${String(i).padStart(8, '0')}`;
/** Oferta do Etiqueta falso. `loja` 'shopee' sempre vai à revisão do Catálogo. */
const ofertaCat = (i, titulo, preco, loja = 'amazon') => {
  const base = {
    id: i, loja, categoria: 'Casa', busca: '', titulo, preco, preco_antigo: preco * 2, desconto_pct: 50, vendas: 10, avaliacao: 4.5, num_avaliacoes: 3,
    frete_gratis: true, cupom: '', criado_em: '2026-11-03T12:00:00', atualizado_em: '2026-11-03T12:00:00', genero: 'sem',
  };
  if (loja === 'amazon') Object.assign(base, { item_id: asin(i), link: 'https://www.amazon.com.br/dp/X?tag=terceiro-20', imagem: `https://m.media-amazon.com/images/I/${i}.jpg` });
  if (loja === 'ml') Object.assign(base, { item_id: `MLB${4000000000 + i}`, link: 'https://meli.la/TerCeiro1', imagem: `https://http2.mlstatic.com/D_${i}.jpg` });
  if (loja === 'shopee') Object.assign(base, { item_id: `123.${i}`, link: `https://s.shopee.com.br/Ab${i}cd`, imagem: `https://down-br.img.susercontent.com/file/${i}`, preco_antigo: null, desconto_pct: 0 });
  base.chave = `${loja}:${base.item_id}`;
  return base;
};

/** Regra de catálogo em Novidades (ordem padrão) com o Etiqueta falso; `limite` liga o teto de mensagens por hora. Uma por teste. */
function montarNovidades(t, { lojas = ['amazon'], limite = null, per = 3, ordem = null, loja = {} } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: AGORA });
  const dir = tmp(); const db = openDb(dir);
  if (limite != null) db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('wa_limite_hora', String(limite));
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const amazon = createAmazon({ db, fetch: async () => { throw new Error('rede proibida'); }, esperar: async () => {}, lerConexao: () => ({ tag: 'achadinho-20' }) });
  const estado = { ofertas: [ofertaCat(1, D, 10)] };
  const caminho = path.join(tmp(), 'api_token.txt');
  fs.writeFileSync(caminho, `tkFALSO_${randomBytes(30).toString('base64url')}\n`, { mode: 0o600 });
  const fetchFalso = async (url) => {
    const u = new URL(String(url)); const limiteP = Number(u.searchParams.get('limite') ?? 50);
    const ord = u.searchParams.get('ordem') ?? 'atualizacao';
    const cursor = u.searchParams.get('cursor'); const m = cursor == null ? [null, '0'] : (ord === 'atualizacao' ? /^c(\d+)$/ : /^(\d+)$/).exec(cursor);
    const inicio = Number(m[1]); const pagina = estado.ofertas.slice(inicio, inicio + limiteP); const fim = inicio + pagina.length;
    const proximo = ord === 'atualizacao' ? (pagina.length ? `c${fim}` : null) : (fim < estado.ofertas.length ? String(fim) : null);
    return new Response(JSON.stringify({ versao: 1, ofertas: pagina, proximo, total: estado.ofertas.length }), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
  };
  const catalogo = createCatalogo({ db, fetch: fetchFalso, lerConexao: () => ({ endereco: 'http://127.0.0.1:9', caminho_token: caminho }), timeoutMs: 3000 });
  const catalogoItens = createCatalogoItens({ db, wa, links, amazon });
  const verificador = Object.keys(loja).length ? createVerificador({ db, amazon, ml: { async conferirProduto(url) { const r = loja[idDe(url)]; if (!r) throw new Error('fora'); return r; } } }) : null;
  const scheduler = createScheduler({ db, wa, links, fast: true, amazon, catalogo, catalogoItens, verificador });
  db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run('111@g.us', 'Achadinhos', 10, Date.now());
  db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etiquetaA', Date.now());
  const tpl = Number(db.prepare('INSERT INTO templates (name, body, created_at) VALUES (?,?,?)').run('T', CORPO, Date.now()).lastInsertRowid);
  const id = Number(db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id, group_jids, source_type, source_config, sources, per_run, interval_min, window_start,
    window_end, dedupe_days, send_image, created_at) VALUES ('Cat', 1, 1, ?, ?, 'list', '{}', ?, ?, 60, '00:00', '23:59', 7, 0, ?)`)
    .run(tpl, JSON.stringify(['111@g.us']), JSON.stringify([{ type: 'catalogo', tag_id: null, config: ordem ? { lojas, ordem } : { lojas } }]), per, Date.now()).lastInsertRowid);
  return {
    db, wa, scheduler, estado, id, catalogoItens,
    cursor: () => db.prepare('SELECT cursor FROM catalogo_cursores WHERE rule_id = ?').get(id)?.cursor,
    puladas: () => db.prepare("SELECT message FROM log WHERE message LIKE 'Pulada:%' ORDER BY id").all().map((l) => l.message),
    avancar: (ms) => t.mock.timers.setTime(Date.now() + ms),
    rodar: () => scheduler.runRule(id),
    textos: () => wa.simulated.map((m) => m.text),
    /** A 1ª leitura só marca o ponto de partida; depois chegam as ofertas dadas. */
    async comecar(...novas) { await scheduler.runRule(id); estado.ofertas.push(...novas); },
  };
}

test('Novidades (ordem padrão): a parecida barrada por ENVIO ANTERIOR conta como tratada e não volta 25 h depois (cap-referencia: "só volta se o Etiqueta atualizar")', async (t) => {
  const s = montarNovidades(t);
  await s.comecar(ofertaCat(2, B, 59.9));
  // o que a regra enviou 3 h antes (reserva em sent_offers), de outra chave: a B chega depois e é barrada por ela
  s.db.prepare('INSERT INTO sent_offers (rule_id, offer_key, sent_at, title, price_cents) VALUES (?,?,?,?,?)').run(s.id, 'amazon:OUTRA', Date.now() - 3 * HORA, A, 5990);
  const r = await s.rodar();
  assert.equal(r.offers, 0);
  assert.equal(s.puladas().length, 1);
  assert.match(s.puladas()[0], /^Pulada: parecida com ".+", que saiu por este disparo às \d\d:\d\d por R\$ 59,90\. Ofertas parecidas esperam 24 h/);
  assert.equal(s.cursor(), 'c2', 'o cursor passou da B: ela é "recusada"');
  s.avancar(25 * HORA);
  const r2 = await s.rodar();
  assert.equal(r2.offers, 0, 'sem atualização no catálogo, a B não volta');
  assert.equal(s.wa.simulated.length, 0);
  assert.equal(s.puladas().length, 1, 'e nenhuma linha nova');
});

test('Novidades (R1): a parecida barrada por RODADA volta na execução seguinte; 25 h depois ela sai (a escolhida saiu há mais de 24 h), sem a frase', async (t) => {
  const s = montarNovidades(t);
  await s.comecar(ofertaCat(2, A, 59.9), ofertaCat(3, B, 59.9));
  const r = await s.rodar();
  assert.equal(r.offers, 1, 'só a A sai; a B é parecida com a escolhida');
  assert.equal(s.puladas().length, 1);
  assert.match(s.puladas()[0], /^Pulada: parecida com ".+", que foi escolhida neste mesmo envio\.$/);
  assert.equal(s.cursor(), 'c1', 'a pulada por rodada segura o cursor na página');
  s.avancar(25 * HORA);
  const r2 = await s.rodar();
  assert.equal(r2.offers, 1, 'a B volta: a A saiu há 25 h e a janela das parecidas já passou');
  assert.equal(s.wa.simulated.length, 2);
  assert.ok(s.textos()[1].startsWith(`*${B}*`), 'sem a frase: não era mais barata nem precisava');
  assert.equal(s.cursor(), 'c3');
});

// escolha preguiçosa (plano rodar-sozinho-entrega1, B5): a que vai à revisão é devolvida antes da próxima escolha e a
// vaga é reposta na mesma execução (CA1.7, CA1.12)
test('Novidades (R1): a escolhida vai à REVISÃO (Shopee) e a parecida sai na mesma execução, em vez de ficar perdida', async (t) => {
  const s = montarNovidades(t, { lojas: ['amazon', 'shopee'] });
  await s.comecar(ofertaCat(2, A, 59.9, 'shopee'), ofertaCat(3, B, 59.9, 'amazon'));
  const r = await s.rodar();
  assert.deepEqual([r.offers, r.revisao], [1, 1], 'a Shopee espera revisão e a B ocupa a vaga');
  assert.equal(s.wa.simulated.length, 1);
  assert.ok(s.textos()[0].startsWith(`*${B}*`));
  assert.equal(s.puladas().length, 0, 'a A não saiu: não barra a B');
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM sent_offers WHERE rule_id = ?").get(s.id).n, 1, 'a Shopee em revisão não ocupa reserva');
  s.avancar(HORA);
  assert.equal((await s.rodar()).offers, 0, 'nada volta: a A espera na revisão e a B já saiu');
});

test('Novidades (R1): a escolhida fica sem vaga no TETO por hora; a parecida pulada não sai junto e a execução seguinte envia a escolhida uma vez só', async (t) => {
  const s = montarNovidades(t, { limite: 1, per: 3 });
  await s.comecar(ofertaCat(2, unico(1), 20), ofertaCat(3, A, 59.9), ofertaCat(4, B, 59.9));
  const r = await s.rodar();
  assert.equal(s.wa.simulated.length, 1, 'a 1ª ocupa a única vaga da hora');
  assert.equal(r.parou, 'limite');
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM sent_offers WHERE rule_id = ? AND title = ?").get(s.id, A).n, 0, 'a A não saiu');
  s.avancar(61 * 60000);
  const r2 = await s.rodar();
  assert.equal(r2.offers, 1);
  assert.equal(s.wa.simulated.length, 2);
  assert.ok(s.textos()[1].startsWith(`*${A}*`));
  s.avancar(61 * 60000);
  await s.rodar();
  assert.equal(s.wa.simulated.length, 2, 'a B é parecida com a A que saiu: não sai (e ninguém sai duas vezes)');
  assert.equal(s.textos().filter((x) => x.includes(`*${A}*`)).length, 1);
  assert.equal(s.textos().some((x) => x.includes(`*${B}*`)), false);
});

// ============================================================================================ 13. rodada 2: R4 (uma linha por conflito)
// escolha preguiçosa (plano rodar-sozinho-entrega1, B5): só uma escolhida que saiu barra a da mesma rodada; com
// "dias sem repetir" = 0 ela sai a cada execução e o mesmo conflito se repete
test('R4: a pulada da mesma rodada volta a ser dita depois que a janela de 24 h vence (dias = 0: a escolhida sai a cada execução)', async (t) => {
  const s = montar(t);
  const id = s.regra([linha(1, A, 59.9), linha(2, B, 49.9), ...Array.from({ length: 3 }, (_, i) => linha(10 + i, unico(i), 20 + i))], { per: 2, dedupe: 0 });
  const doConflito = () => s.logs(id).filter((l) => l.message.endsWith('que foi escolhida neste mesmo envio.')).length;
  for (let i = 0; i < 5; i++) { await s.scheduler.runRule(id); s.avancar(HORA); }
  assert.equal(doConflito(), 1, 'dentro das 24 h, uma linha');
  s.avancar(24 * HORA);
  for (let i = 0; i < 3; i++) { await s.scheduler.runRule(id); s.avancar(HORA); }
  assert.equal(doConflito(), 2, 'a janela venceu: o conflito, se ainda existe, ganha uma linha nova (e uma só)');
});

test('R4: a linha do conflito de uma candidata não suprime a de outra candidata com a mesma anterior', async (t) => {
  const s = montar(t);
  const id = s.regra([linha(2, B, 55), linha(3, AZUL, 56), linha(4, unico(1), 20)], { per: 1 });
  s.db.prepare('INSERT INTO sent_offers (rule_id, offer_key, sent_at, title, price_cents) VALUES (?,?,?,?,?)').run(id, 'MLB999', Date.now() - HORA, A, 5000);
  for (let i = 0; i < 4; i++) { await s.scheduler.runRule(id); s.avancar(HORA); }
  const puladas = s.logs(id).filter((l) => l.message.startsWith('Pulada: parecida'));
  assert.deepEqual(puladas.map((l) => l.offer_title).sort(), [AZUL, B].sort(), 'uma linha por candidata');
});

test('R4: "Saiu como oportunidade melhor" nunca é suprimida: cada oferta que sai por ser mais barata deixa a sua linha, em rodadas seguidas', async (t) => {
  const s = montar(t);
  const id = s.regra([linha(1, A, 59.9)], { per: 1 });
  await s.scheduler.runRule(id);
  // o mesmo título, cada vez com outra chave e pelo menos 5% mais barato (a parecida não tem a exceção: adendo D10)
  s.avancar(2 * HORA); s.trocarLista(id, [linha(2, A, 49.9)]); await s.scheduler.runRule(id);
  s.avancar(2 * HORA); s.trocarLista(id, [linha(3, A, 39.9)]); await s.scheduler.runRule(id);
  s.avancar(2 * HORA); s.trocarLista(id, [linha(4, A, 29.9)]); await s.scheduler.runRule(id);
  const saiu = s.logs(id).filter((l) => l.message.startsWith('Saiu como oportunidade melhor'));
  assert.equal(saiu.length, 3);
  assert.match(saiu[0].message, /R\$ 59,90 \(".+"\); agora por R\$ 49,90\.$/);
  assert.match(saiu[1].message, /R\$ 49,90 \(".+"\); agora por R\$ 39,90\.$/);
  assert.match(saiu[2].message, /R\$ 39,90 \(".+"\); agora por R\$ 29,90\.$/);
});

// ============================================================================================ 14. rodada 2: R5 / Q3 de ponta a ponta
const saiuComo = (s, id) => s.logs(id).filter((l) => l.message.startsWith('Saiu como oportunidade melhor'));
/** A regra "já enviou" A a R$ 59,90 há 2 h; devolve o item do mesmo título A (outra chave, R$ 49,90) em revisão. */
function comAnterior(s, { grupos = 1 } = {}) {
  const id = s.regra([linha(1, D, 10)], { per: 1 });
  if (grupos === 2) s.db.prepare('UPDATE rules SET group_jids = ? WHERE id = ?').run(JSON.stringify(['111@g.us', '222@g.us']), id);
  s.db.prepare('INSERT INTO sent_offers (rule_id, offer_key, sent_at, title, price_cents) VALUES (?,?,?,?,?)').run(id, 'MLB999', Date.now() - 2 * HORA, A, 5990);
  return { id, item: s.revisao(id, ML(2000001, A, 49.9)) };
}

test('R5/Q3: o clique em "Enviar" não escreve "Saiu como…"; a fila escreve depois do envio, uma vez, com o título e o preço da parecida', async (t) => {
  const s = montar(t);
  const { id, item } = comAnterior(s);
  const antes = s.logs(id).length;
  await s.catalogoItens.enviar(item, {});
  assert.deepEqual(s.logs(id).slice(antes), [], 'o clique não escreve nada no Histórico');
  await s.scheduler.envios.processarPendentes();
  const l = saiuComo(s, id);
  assert.equal(l.length, 1);
  assert.match(l[0].message, /^Saiu como oportunidade melhor: o mesmo produto saiu às \d\d:\d\d por R\$ 59,90 \("Fone de Ouvido Bluetooth JBL Tune 510BT Preto"\); agora por R\$ 49,90\.$/);
  assert.equal(l[0].group_name, null);
  assert.ok(s.textos()[0].startsWith(FRASE_MAIS_BARATA));
});

test('R5/Q3: retomada do envio (teto por hora enche entre dois grupos): a linha sai uma vez só e os dois grupos recebem a frase', async (t) => {
  const s = montar(t, { limite: 1 });
  const { id, item } = comAnterior(s, { grupos: 2 });
  await s.catalogoItens.enviar(item, {});
  await s.scheduler.envios.processarPendentes();
  assert.equal(s.wa.simulated.length, 1, 'o teto deixou só o 1º grupo');
  assert.equal(saiuComo(s, id).length, 1, 'saiu em um grupo: a linha já vale');
  s.avancar(61 * 60000);
  await s.scheduler.envios.processarPendentes();
  assert.equal(s.wa.simulated.length, 2, 'a retomada manda ao grupo que faltava');
  assert.ok(s.textos().every((x) => x.startsWith(`${FRASE_MAIS_BARATA}\n\n*${A}*`)));
  assert.equal(saiuComo(s, id).length, 1, 'a retomada não repete a linha');
});

test('R5/Q3: falha em todos os grupos não deixa a linha; o "Reenviar" depois de consertar escreve uma só', async (t) => {
  const s = montar(t);
  const { id, item } = comAnterior(s);
  quebrarWhatsApp(s);
  await s.catalogoItens.enviar(item, {});
  await s.scheduler.envios.processarPendentes();
  assert.equal(s.textos().length, 0);
  assert.equal(saiuComo(s, id).length, 0, 'não saiu: nada de "Saiu como…"');
  consertarWhatsApp(s);
  s.avancar(HORA);
  await s.catalogoItens.enviar(item, {}); // reenvio do item cujo envio falhou em todos os grupos
  await s.scheduler.envios.processarPendentes();
  assert.equal(s.textos().length, 1);
  assert.ok(s.textos()[0].startsWith(FRASE_MAIS_BARATA));
  assert.equal(saiuComo(s, id).length, 1);
});

test('R5/Q3: envio já na fila antes da correção (payload com mais_barata e sem parecida_anterior) sai com a frase e sem a linha, sem erro', async (t) => {
  const s = montar(t);
  const { id, item } = comAnterior(s);
  const r = await s.catalogoItens.enviar(item, {});
  const payload = JSON.parse(s.db.prepare('SELECT payload FROM envios WHERE id = ?').get(r.envio_id).payload);
  assert.deepEqual(payload.mais_barata, { preco_anterior: 5990 }, 'mais_barata continua exatamente { preco_anterior }');
  assert.deepEqual(payload.parecida_anterior.titulo, A);
  delete payload.parecida_anterior;
  s.db.prepare('UPDATE envios SET payload = ? WHERE id = ?').run(JSON.stringify(payload), r.envio_id);
  await s.scheduler.envios.processarPendentes();
  assert.equal(s.db.prepare('SELECT status FROM envios WHERE id = ?').get(r.envio_id).status, 'concluido');
  assert.equal(s.textos().length, 1);
  assert.ok(s.textos()[0].startsWith(`${FRASE_MAIS_BARATA}\n\n*${A}*`));
  assert.equal(saiuComo(s, id).length, 0);
  assert.equal(s.logs(id).some((l) => l.level === 'erro'), false);
});

// ============================================================================================ 15. rodada 2: "Pulada: na conferência" repetida
/** Regra da Central de Afiliados (amostraHub, modo simulado): MLB9000001 = "Kit 10 Potes Herméticos de Vidro", R$ 69,90. */
const regraCentral = (s, { per = 1 } = {}) => Number(s.db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id, group_jids, source_type, source_config,
  per_run, interval_min, window_start, window_end, dedupe_days, send_image, created_at) VALUES ('Central', 1, 1, ?, ?, 'afiliados', ?, ?, 60, '00:00', '23:59', 7, 0, ?)`)
  .run(s.tplId, JSON.stringify(['111@g.us']), JSON.stringify({ categoria: 'MLB1574', paginas: 1 }), per, Date.now()).lastInsertRowid);
const POTES = 'Kit 10 Potes Herméticos de Vidro';

test('conferência (pendência do dev): a oferta que volta mais barata na escolha e sobe na conferência é dita uma vez só por rodadas de 60 min',
  async (t) => {
  // a lista (hub) diz R$ 69,90 (5% abaixo dos R$ 74,00 do mesmo título enviado antes, até R$ 70,30); a loja diz R$ 72,50
  // (+3,7%, dentro do que o verificador aceita)
  const s = montar(t, { verificar: true, loja: { 9000001: { price: 72.5, disponivel: true } } });
  const id = regraCentral(s, { per: 1 });
  s.db.prepare('INSERT INTO sent_offers (rule_id, offer_key, sent_at, title, price_cents) VALUES (?,?,?,?,?)').run(id, 'MLB9999', Date.now() - HORA, POTES, 7400);
  for (let i = 0; i < 6; i++) { await s.scheduler.runRule(id); s.avancar(HORA); }
  const linhas = s.logs(id).filter((l) => l.message.startsWith('Pulada: na conferência'));
  console.log(`[qa] medição: ${linhas.length} linhas "Pulada: na conferência" em 6 rodadas; ${s.textos().length} mensagens; conferências de 9000001: ${s.eventos.filter((e) => e === 'conferir 9000001').length}`);
  assert.equal(linhas.length, 1);
});

test('conferência (medição): com per_run = 1, a oferta que sobe na conferência não segura a vaga da rodada por 24 h (nada mais sai)',
  async (t) => {
  const s = montar(t, { verificar: true, loja: { 9000001: { price: 72.5, disponivel: true } } });
  const id = regraCentral(s, { per: 1 });
  s.db.prepare('INSERT INTO sent_offers (rule_id, offer_key, sent_at, title, price_cents) VALUES (?,?,?,?,?)').run(id, 'MLB9999', Date.now() - HORA, POTES, 7400);
  let primeira = null;
  for (let i = 0; i < 26; i++) {
    await s.scheduler.runRule(id);
    if (primeira === null && s.textos().length) primeira = i;
    s.avancar(HORA);
  }
  console.log(`[qa] medição: 1ª mensagem na rodada ${primeira}; ${s.logs(id).filter((l) => l.message.startsWith('Pulada: na conferência')).length} linhas; ${s.textos().length} mensagens em 26 rodadas`);
  assert.ok(primeira !== null && primeira < 3, `a regra ficou ${primeira} rodadas sem enviar nada`);
});

test('conferência no Catálogo (ordem Relevância, a das regras reais, per_run 3): a oferta que sobe na conferência é dita uma vez; as outras saem',
  async (t) => {
  // MLB4000000002 (o mesmo título 5% mais barato na escolha: 69,90 contra 74,00) sobe para 72,50 na loja; as outras duas saem
  const s = montarNovidades(t, { lojas: ['ml'], ordem: 'relevancia', per: 3, loja: { 4000000002: { price: 72.5, disponivel: true }, 4000000003: { price: 20, disponivel: true }, 4000000004: { price: 21, disponivel: true } } });
  s.estado.ofertas = [ofertaCat(2, A, 69.9, 'ml'), ofertaCat(3, unico(1), 20, 'ml'), ofertaCat(4, unico(2), 21, 'ml')];
  s.db.prepare('INSERT INTO sent_offers (rule_id, offer_key, sent_at, title, price_cents) VALUES (?,?,?,?,?)').run(s.id, 'ml:MLB9999', Date.now() - HORA, A, 7400);
  for (let i = 0; i < 6; i++) { await s.rodar(); s.avancar(HORA); }
  const conf = s.db.prepare("SELECT message FROM log WHERE message LIKE 'Pulada: na conferência%'").all().length;
  console.log(`[qa] medição (catálogo): ${conf} linhas "Pulada: na conferência" em 6 rodadas; ${s.textos().length} mensagens`);
  assert.equal(conf, 1);
});

// ============================================================================================ 16. rodada 1 das mudanças D10/D11 e Q1/Q5
// Fiação inteira (regra, "Enviar" do Catálogo, fila, verificador), com os números do adendo de 10/11/2026 às 17h20.
/** Grava um envio antigo da regra, `atras` ms antes de "agora". */
const semear = (s, id, chave, titulo, centavosPreco, atras) => s.db.prepare('INSERT INTO sent_offers (rule_id, offer_key, sent_at, title, price_cents) VALUES (?,?,?,?,?)')
  .run(id, chave, Date.now() - atras, titulo, centavosPreco);
const puladas = (s, id) => s.logs(id).filter((l) => l.message.startsWith('Pulada')).map((l) => l.message);
const CREME_400 = 'Creme Hidratante Corporal Nivea Milk 400ml Pele Seca';
const CREME_200 = 'Creme Hidratante Corporal Nivea Milk 200ml Pele Seca'; // outro tamanho: parecido, não igual
const payloadDe = (s, envioId) => JSON.parse(s.db.prepare('SELECT payload FROM envios WHERE id = ?').get(envioId).payload);

test('D10 (CA2/CA5) na regra: o caso do creme (tamanho menor, título parecido, pela metade do preço) barra em 3 h e sai em 25 h SEM a frase', async (t) => {
  assert.equal(comparar(CREME_400, CREME_200), 'parecido', 'a fixture é parecida e não igual');
  const s = montar(t);
  const id = s.regra([linha(2, CREME_200, 20)], { per: 1 });
  semear(s, id, 'MLB999', CREME_400, 4000, 3 * HORA);
  const r = await s.scheduler.runRule(id);
  assert.equal(r.offers, 0);
  assert.equal(s.textos().length, 0, 'meio preço não libera a parecida');
  assert.equal(puladas(s, id).length, 1);
  assert.match(puladas(s, id)[0], /^Pulada: parecida com ".+", que saiu por este disparo às \d\d:\d\d por R\$ 40,00\. Ofertas parecidas esperam 24 h\.$/);
  s.avancar(22 * HORA); // 25 h depois do envio anterior
  const r2 = await s.scheduler.runRule(id);
  assert.equal(r2.offers, 1, 'passadas as 24 h ela sai');
  assert.equal(s.textos().length, 1);
  assert.equal(s.textos()[0].includes(FRASE_MAIS_BARATA), false, 'a parecida nunca leva a frase, mesmo a metade do preço');
  assert.ok(s.textos()[0].startsWith(`*${CREME_200}*`));
  assert.equal(s.logs(id).some((l) => l.message.startsWith('Saiu como')), false);
});

test('D10 (CA2/CA5) no Catálogo: a parecida pela metade do preço recebe 409 em 3 h; em 25 h sai sem a frase e sem a marca no payload', async (t) => {
  const s = montar(t);
  const id = s.regra([linha(1, D, 10)], { per: 1 });
  semear(s, id, 'MLB999', CREME_400, 4000, 3 * HORA);
  const item = s.revisao(id, ML(2000001, CREME_200, 20));
  await assert.rejects(s.catalogoItens.enviar(item, {}), (e) => e.status === 409
    && /^Não enviada: parecida com ".+", que saiu por este disparo às \d\d:\d\d por R\$ 40,00\. Ofertas parecidas esperam 24 h\.$/.test(e.message));
  assert.equal(s.db.prepare('SELECT status FROM catalogo_itens WHERE id = ?').get(item).status, 'revisao', 'o item continua esperando');
  assert.equal(s.reservas(id).length, 1, 'nada foi gravado');
  s.avancar(22 * HORA);
  const r = await s.catalogoItens.enviar(item, {});
  assert.equal(Object.hasOwn(payloadDe(s, r.envio_id), 'mais_barata'), false);
  await s.scheduler.envios.processarPendentes();
  assert.equal(s.textos().length, 1);
  assert.equal(s.textos()[0].includes(FRASE_MAIS_BARATA), false);
  assert.equal(s.logs(id).some((l) => l.message.startsWith('Saiu como')), false);
});

test('D10 (CA2): com "dias sem repetir" de 1 dia ou mais a espera da parecida é de 24 h; a de 2 dias não a estica', async (t) => {
  const s = montar(t);
  const id = s.regra([linha(2, CREME_200, 30)], { per: 1, dedupe: 2 });
  semear(s, id, 'MLB999', CREME_400, 4000, 23 * HORA);
  await s.scheduler.runRule(id);
  assert.equal(s.textos().length, 0, 'com 23 h barra');
  s.avancar(2 * HORA);
  await s.scheduler.runRule(id);
  assert.equal(s.textos().length, 1, 'com 25 h sai, apesar de faltar 1 dia dos 2 da regra');
});

for (const [preco, sai] of [[95, true], [95.01, false], [94.99, true], [100, false], [120, false]]) {
  test(`D11 (CA4) na escolha da regra: contra R$ 100,00, R$ ${String(preco).replace('.', ',')} ${sai ? 'sai com a frase' : 'é pulada'}`, async (t) => {
    const s = montar(t);
    const id = s.regra([linha(2, A, preco)], { per: 1 });
    semear(s, id, 'MLB999', A, 10000, 3 * HORA);
    await s.scheduler.runRule(id);
    if (sai) {
      assert.equal(s.textos().length, 1);
      assert.ok(s.textos()[0].startsWith(`${FRASE_MAIS_BARATA}\n\n*${A}*`), s.textos()[0]);
      assert.equal(saiuComo(s, id).length, 1);
      assert.match(saiuComo(s, id)[0].message, /por R\$ 100,00 \(".+"\); agora por R\$ \d+,\d\d\.$/);
    } else {
      assert.equal(s.textos().length, 0);
      assert.match(puladas(s, id)[0], /^Pulada: o mesmo produto saiu por este disparo às \d\d:\d\d por R\$ 100,00, com outro código \(".+"\)\. Só sai de novo se estiver pelo menos 5% mais barato\.$/);
    }
  });
}

test('D10 (CA4) na regra: o mesmo título 5% mais barato barra se uma parecida saiu nas últimas 24 h, citando a parecida; 20 h depois sai com a frase', async (t) => {
  const s = montar(t);
  const id = s.regra([linha(9, A, 50)], { per: 1 });
  semear(s, id, 'MLB900', A, 10000, 30 * HORA);   // o mesmo título, 30 h atrás (dentro dos 7 dias)
  semear(s, id, 'MLB901', AZUL, 9000, 5 * HORA);  // uma parecida, 5 h atrás
  await s.scheduler.runRule(id);
  assert.equal(s.textos().length, 0, 'mesmo pela metade do preço, a parecida de 5 h segura');
  assert.match(puladas(s, id)[0], /^Pulada: parecida com ".+", que saiu por este disparo às \d\d:\d\d por R\$ 90,00\. Ofertas parecidas esperam 24 h\.$/);
  assert.equal(saiuComo(s, id).length, 0);
  s.avancar(20 * HORA); // a parecida tem 25 h: só o mesmo título conta
  await s.scheduler.runRule(id);
  assert.equal(s.textos().length, 1);
  assert.ok(s.textos()[0].startsWith(FRASE_MAIS_BARATA));
  assert.match(saiuComo(s, id)[0].message, /por R\$ 100,00 \(".+"\); agora por R\$ 50,00\.$/, 'o mínimo é o do mesmo título, não o da parecida');
});

test('D10 (CA4) no Catálogo: o mesmo título mais barato barra com uma parecida das últimas 24 h; passadas as 24 h sai com a marca', async (t) => {
  const s = montar(t);
  const id = s.regra([linha(1, D, 10)], { per: 1 });
  semear(s, id, 'MLB900', A, 10000, 30 * HORA);
  semear(s, id, 'MLB901', AZUL, 9000, 5 * HORA);
  const item = s.revisao(id, ML(2000001, A, 50));
  await assert.rejects(s.catalogoItens.enviar(item, {}), (e) => e.status === 409 && /^Não enviada: parecida com ".+", que saiu por este disparo às \d\d:\d\d por R\$ 90,00\./.test(e.message));
  s.avancar(20 * HORA);
  const r = await s.catalogoItens.enviar(item, {});
  assert.deepEqual(payloadDe(s, r.envio_id).mais_barata, { preco_anterior: 10000 });
});

for (const [preco, sai] of [[47.5, true], [47.51, false]]) {
  test(`D11 (CA4) no "Enviar" do Catálogo: contra R$ 50,00, R$ ${String(preco).replace('.', ',')} ${sai ? 'sai com a marca' : 'recebe 409 e nada é gravado'}`, async (t) => {
    const s = montar(t);
    const id = s.regra([linha(1, D, 10)], { per: 1 });
    semear(s, id, 'MLB999', A, 5000, 2 * HORA);
    const item = s.revisao(id, ML(2000001, A, preco));
    if (sai) {
      const r = await s.catalogoItens.enviar(item, {});
      assert.deepEqual(payloadDe(s, r.envio_id).mais_barata, { preco_anterior: 5000 });
    } else {
      await assert.rejects(s.catalogoItens.enviar(item, {}), (e) => e.status === 409
        && /^Não enviada: o mesmo produto saiu por este disparo às \d\d:\d\d por R\$ 50,00, com outro código \(".+"\)\. Só sai de novo se estiver pelo menos 5% mais barato\.$/.test(e.message));
      assert.equal(s.reservas(id).length, 1);
    }
  });
}

// o preço da Central é R$ 69,90 (amostraHub); o mesmo título saiu antes por R$ 76,00: o limite dos 5% é R$ 72,20
for (const [loja, sai] of [[72.2, true], [72.21, false]]) {
  test(`D11 (CA4) na conferência da REGRA: a loja diz R$ ${String(loja).replace('.', ',')} contra R$ 76,00 → ${sai ? 'sai com a frase e o preço da loja' : 'é pulada, sem frase e sem link'}`, async (t) => {
    const s = montar(t, { verificar: true, loja: { 9000001: { price: loja, disponivel: true } } });
    const id = regraCentral(s, { per: 1 });
    semear(s, id, 'MLB9999', POTES, 7600, HORA);
    await s.scheduler.runRule(id);
    if (sai) {
      assert.equal(s.textos().length, 1);
      assert.ok(s.textos()[0].startsWith(FRASE_MAIS_BARATA));
      assert.ok(s.textos()[0].includes('R$ 72,20'), s.textos()[0]);
      assert.match(saiuComo(s, id)[0].message, /por R\$ 76,00 \(".+"\); agora por R\$ 72,20\.$/);
    } else {
      assert.equal(s.textos().some((x) => x.includes(POTES)), false, 'os potes não saem (a vaga vai à próxima, rodar-sozinho CA1.7)');
      assert.equal(s.eventos.includes('link 9000001'), false, 'nenhum link gasto');
      assert.match(puladas(s, id)[0], /^Pulada: na conferência o preço ficou em R\$ 72,21, que não é pelo menos 5% menor que o de ".+" \(R\$ 76,00, às \d\d:\d\d\)\.$/);
      assert.equal(saiuComo(s, id).length, 0);
    }
  });
}

// o item custa R$ 46,00 na revisão (até R$ 47,50 passa na aprovação); a loja devolve o preço da conferência
for (const [loja, sai] of [[47.5, true], [47.51, false]]) {
  test(`D11 (CA4) na conferência da FILA do Catálogo: a loja diz R$ ${String(loja).replace('.', ',')} contra R$ 50,00 → ${sai ? 'sai com a frase e o preço da loja' : 'descartada'}`, async (t) => {
    const s = montar(t, { verificar: true, loja: { 2000001: { price: loja, disponivel: true } } });
    const id = s.regra([linha(1, D, 10)], { per: 1 });
    semear(s, id, 'MLB999', A, 5000, 2 * HORA);
    const item = s.revisao(id, ML(2000001, A, 46));
    await s.catalogoItens.enviar(item, {});
    await s.scheduler.envios.processarPendentes();
    if (sai) {
      assert.equal(s.textos().length, 1);
      assert.ok(s.textos()[0].startsWith(FRASE_MAIS_BARATA));
      assert.ok(s.textos()[0].includes('R$ 47,50'), s.textos()[0]);
      assert.equal(saiuComo(s, id).length, 1);
    } else {
      assert.equal(s.textos().length, 0);
      assert.ok(s.logs(id).some((l) => l.message === 'Descartada: preço subiu para R$ 47,51 e não está mais pelo menos 5% abaixo do da mesma oferta enviada antes (R$ 50,00)'), s.logs(id).map((l) => l.message).join('\n'));
      assert.equal(saiuComo(s, id).length, 0);
    }
  });
}

test('CA5: só a mensagem liberada pela exceção leva a frase: na mesma rodada, as outras ofertas e a mesma chave saem sem ela', async (t) => {
  const s = montar(t);
  const id = s.regra([linha(2, A, 40), linha(3, unico(1), 20), linha(4, unico(2), 21)], { per: 3 });
  semear(s, id, 'MLB999', A, 10000, 3 * HORA);
  await s.scheduler.runRule(id);
  assert.equal(s.textos().length, 3);
  assert.deepEqual(s.textos().map((x) => x.startsWith(FRASE_MAIS_BARATA)), [true, false, false]);
  assert.equal(s.textos().filter((x) => x.includes(FRASE_MAIS_BARATA)).length, 1, 'a frase aparece uma vez só, no começo');
});

// ---------------------------------------------------------------------------------------------- Q1: "saindo agora"
for (const dedupe of [7, 0]) {
  // escolha preguiçosa (plano rodar-sozinho-entrega1, B5): a A só é escolhida depois que a 1ª sai; a que ainda não foi
  // escolhida não barra (se o "Enviar" passar antes, a regra pula a dela: R1 em test/parecido-regras.test.js)
  test(`Q1: o "Enviar" no meio de uma rodada recebe 409 "saindo agora" para a que está saindo, mesmo mais barata (dias = ${dedupe}); depois da rodada vale a regra normal`, async (t) => {
    const s = montar(t);
    const id = s.regra([linha(1, unico(1), 20), linha(2, A, 50)], { per: 2, dedupe });
    const igual = s.revisao(id, ML(2000001, A, 25));      // o mesmo título da que espera a vez, pela metade do preço
    const parecida = s.revisao(id, ML(2000002, AZUL, 25)); // parecida com ela
    const frase = `Não enviada: parecida com "${A}", que está saindo agora por este disparo. Tente de novo em alguns minutos.`;
    const respostas = [];
    const tentar = async (rotulo, item) => { respostas.push([rotulo, await s.catalogoItens.enviar(item, {}).then(() => 'enviou', (e) => `${e.status} ${e.message}`)]); };
    const reais = s.wa.sendText; let chamada = 0;
    s.wa.sendText = async (...a) => {
      chamada++;
      if (chamada === 2) { await tentar('saindo-igual', igual); await tentar('saindo-parecida', parecida); } // a A está saindo
      return reais(...a);
    };
    await s.scheduler.runRule(id);
    assert.equal(chamada, 2);
    assert.deepEqual(respostas, [['saindo-igual', `409 ${frase}`], ['saindo-parecida', `409 ${frase}`]]);
    assert.equal(s.reservas(id).length, 2, 'só as da regra foram gravadas');
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM envios').get().n, 0, 'e nenhum envio do Catálogo');
    // a rodada terminou: a A está em sent_offers. A parecida (outro título) espera as 24 h; o mesmo título, pela metade do preço, sai
    if (dedupe > 0) {
      await assert.rejects(s.catalogoItens.enviar(parecida, {}), (e) => e.status === 409 && /^Não enviada: parecida com ".+", que saiu por este disparo às \d\d:\d\d por R\$ 50,00\. Ofertas parecidas esperam 24 h\.$/.test(e.message));
      const r = await s.catalogoItens.enviar(igual, {});
      assert.deepEqual(payloadDe(s, r.envio_id).mais_barata, { preco_anterior: 5000 });
    } else {
      const r = await s.catalogoItens.enviar(parecida, {});
      assert.equal(Object.hasOwn(payloadDe(s, r.envio_id), 'mais_barata'), false, 'com 0 dias não há comparação entre rodadas');
    }
  });
}

test('Q1: a oferta pulada (que NÃO vai sair) e a de outro título não são "saindo agora"; só as escolhidas contam', async (t) => {
  const s = montar(t);
  // A e B são parecidas: a rodada escolhe A e pula B (nunca vai sair); o "Enviar" de uma parecida com B (mas não com A) passa
  const id = s.regra([linha(1, A, 50), linha(2, B, 50)], { per: 2 });
  const outro = s.revisao(id, ML(2000001, C, 300)); // outro título: nada a ver
  let durante = null; const reais = s.wa.sendText;
  s.wa.sendText = async (...a) => { durante = await s.catalogoItens.enviar(outro, {}).then(() => 'enviou', (e) => `${e.status}`); return reais(...a); };
  await s.scheduler.runRule(id);
  assert.equal(durante, 'enviou');
});

test('Q1: a rodada que termina em ERRO não deixa o Catálogo travado (o finally limpa as ofertas saindo)', async (t) => {
  const s = montar(t);
  const id = s.regra([linha(1, A, 50)], { per: 1 });
  const item = s.revisao(id, ML(2000001, AZUL, 25));
  const prepare = s.db.prepare.bind(s.db);
  let estourou = false;
  s.db.prepare = (sql) => { // a gravação da reserva falha depois do envio: a execução termina em erro no meio
    if (String(sql).startsWith('INSERT INTO sent_offers')) { estourou = true; throw new Error('disco cheio (falso)'); }
    return prepare(sql);
  };
  await s.scheduler.runRule(id).catch(() => {});
  delete s.db.prepare;
  assert.equal(estourou, true, 'o erro foi provocado');
  assert.equal(s.reservas(id).length, 0, 'a reserva não chegou a ser gravada');
  const r = await s.catalogoItens.enviar(item, {}); // não pode ser "saindo agora": a rodada acabou
  assert.ok(r.envio_id > 0);
});

// ---------------------------------------------------------------------------------------------- Q5: pausa de 6 h
test('Q5 (regra): a oferta que sobe na conferência fica 6 h fora da escolha, é conferida de novo depois e, se continua mais cara, é pulada de novo SEM linha nova', async (t) => {
  const s = montar(t, { verificar: true, loja: { 9000001: { price: 72.5, disponivel: true } } });
  const id = regraCentral(s, { per: 1 });
  semear(s, id, 'MLB9999', POTES, 7400, HORA);
  const conferencias = () => s.eventos.filter((e) => e === 'conferir 9000001').length;
  const linhasConf = () => puladas(s, id).filter((m) => m.startsWith('Pulada: na conferência')).length;
  await s.scheduler.runRule(id);
  assert.deepEqual([conferencias(), linhasConf(), s.textos().length], [1, 1, 1], 'rodada 0: conferida, pulada, com 1 linha; a vaga foi para a próxima (rodar-sozinho CA1.7)');
  assert.equal(s.textos().some((x) => x.includes(POTES)), false);
  s.avancar(HORA);
  await s.scheduler.runRule(id);
  assert.ok(s.textos().length >= 1, 'a vaga foi para a próxima candidata');
  for (let i = 0; i < 4; i++) { s.avancar(HORA); await s.scheduler.runRule(id); } // 5 h depois da primeira conferência
  assert.equal(conferencias(), 1, 'dentro das 6 h ela nem é escolhida de novo');
  s.avancar(HORA + 60000);
  await s.scheduler.runRule(id);
  assert.equal(conferencias(), 2, 'passadas as 6 h, conferida de novo');
  assert.equal(linhasConf(), 1, 'continua mais cara: pulada de novo, sem linha nova');
  s.avancar(7 * HORA);
  await s.scheduler.runRule(id);
  assert.equal(conferencias(), 3, 'e a pausa recomeça, 6 h de novo');
  assert.equal(linhasConf(), 1);
});

test('Q5 (regra): se na nova conferência a loja voltou a ficar 5% abaixo, a oferta sai com a frase e a linha "Saiu como…"', async (t) => {
  const loja = { 9000001: { price: 72.5, disponivel: true } };
  const s = montar(t, { verificar: true, loja });
  const id = regraCentral(s, { per: 1 });
  semear(s, id, 'MLB9999', POTES, 7400, HORA);
  await s.scheduler.runRule(id);
  assert.equal(s.textos().some((x) => x.includes(POTES)), false, 'pulada (a vaga foi para a próxima, rodar-sozinho CA1.7)');
  loja[9000001] = { price: 70.3, disponivel: true };
  s.avancar(7 * HORA);
  // por ordem da lista, a Central pode ter outra candidata na frente: roda até a POTES sair
  for (let i = 0; i < 6 && !saiuComo(s, id).length; i++) { await s.scheduler.runRule(id); s.avancar(HORA); }
  assert.equal(saiuComo(s, id).length, 1);
  assert.match(saiuComo(s, id)[0].message, /por R\$ 74,00 \(".+"\); agora por R\$ 70,30\.$/);
  assert.ok(s.textos().some((x) => x.startsWith(FRASE_MAIS_BARATA) && x.includes('R$ 70,30')));
});

test('Q5 (Catálogo, Relevância): a pulada na conferência é conferida de novo só depois de 6 h e a linha não se repete', async (t) => {
  let leituras = 0;
  const loja = { get 4000000002() { leituras++; return { price: 72.5, disponivel: true }; }, 4000000003: { price: 20, disponivel: true }, 4000000004: { price: 21, disponivel: true } };
  const s = montarNovidades(t, { lojas: ['ml'], ordem: 'relevancia', per: 3, loja });
  s.estado.ofertas = [ofertaCat(2, A, 69.9, 'ml'), ofertaCat(3, unico(1), 20, 'ml'), ofertaCat(4, unico(2), 21, 'ml')];
  s.db.prepare('INSERT INTO sent_offers (rule_id, offer_key, sent_at, title, price_cents) VALUES (?,?,?,?,?)').run(s.id, 'ml:MLB9999', Date.now() - HORA, A, 7400);
  const linhas = () => s.db.prepare("SELECT COUNT(*) AS n FROM log WHERE message LIKE 'Pulada: na conferência%'").get().n;
  await s.rodar();
  assert.deepEqual([leituras, linhas(), s.textos().length], [1, 1, 2], 'as outras duas saem na mesma rodada');
  for (let i = 0; i < 5; i++) { s.avancar(HORA); await s.rodar(); }
  assert.equal(leituras, 1, 'nas 5 h seguintes não é conferida de novo');
  s.avancar(HORA + 60000);
  await s.rodar();
  assert.equal(leituras, 2, 'depois das 6 h, sim');
  assert.equal(linhas(), 1, 'e a linha não se repete');
});

// ---------------------------------------------------------------------------------------------- docs × código (a frase "saindo agora")
test('docs (ponto 5): a frase do 409 "saindo agora" é, letra por letra, a do código no README e no capítulo Referência; nenhum doc guarda a regra antiga', () => {
  const saindo = textoConflito({ tipo: 'saindo', anterior: { title: T, preco: null, sent_at: null } }, AGORA_DOC, { prefixo: 'Não enviada' });
  assert.equal(saindo, 'Não enviada: parecida com "…", que está saindo agora por este disparo. Tente de novo em alguns minutos.');
  assert.ok(README.includes(`\`${saindo}\``), 'README');
  assert.ok(CAP_REF.includes(saindo.replace('"…"', '“…”')), 'cap-referencia');
  for (const [nome, texto] of [['README', README], ['cap-referencia', CAP_REF], ['cap-disparos', CAP_DISP], ['ajuda', AJUDA]]) {
    assert.doesNotMatch(texto, /salvo se estiverem mais baratas|qualquer centavo|parecida[^.]{0,40}mais barata,? sai com/i, `${nome}: restou a regra antiga`);
  }
  assert.ok(CAP_DISP.includes('pelo menos 5% mais barato') && AJUDA.includes('pelo menos 5% mais barato'));
});
