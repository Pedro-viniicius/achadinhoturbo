// QA da entrega 1 de "Rodar sozinho", Parte B (Achadinho Turbo): a Amazon do Catálogo conferida na hora pelo Etiqueta
// (com reserva de 6 h), falha passageira que pula em vez de ir à revisão e vaga reposta. Aqui estão os cenários
// adversários que os testes do dev não fixam: oferta "veneno" que sempre bloqueia a releitura, Etiqueta fora por horas,
// Shopee em massa, verificador ligado/desligado no meio, "Enviar" do Catálogo durante a execução, migração e `preco_em`
// em formatos estranhos. Agendador real, verificador real, catálogo e Etiqueta falsos; nenhuma rede (o fetch lança).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, setSetting, getSetting } from '../src/db.js';
import { createScheduler } from '../src/scheduler.js';
import { createLinkService } from '../src/links.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createCatalogoItens } from '../src/catalogo-itens.js';
import { createAmazon } from '../src/amazon.js';
import { paraCandidato, lerPrecoEm, createCatalogo } from '../src/catalogo.js';
import http from 'node:http';
import { createVerificador, reservaValida, RESERVA_AMAZON_H, PAUSA_RELEITURA_MIN } from '../src/verificador.js';
import { buildApp, criarServicos, AVISO_VERIFICADOR_LIGADO, AVISO_VERIFICADOR_DESLIGADO } from '../src/server.js';

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
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-rodar-')); pastas.push(p); return p; };

const MIN = 60000;
const HORA = 3600000;
const dia = (d, h, m = 0, s = 0) => new Date(2026, 10, d, h, m, s).getTime(); // novembro/2026, horário local
const p2 = (n) => String(n).padStart(2, '0');
const precoEmTexto = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; };
const asinDe = (i) => `B0${String(i).padStart(8, '0')}`;
const TITULOS = ['Panela Pressão Elétrica Mondial', 'Cadeira Gamer Reclinável Azul', 'Mochila Notebook Executiva Couro', 'Aspirador Robô Inteligente Wifi',
  'Smartwatch Esportivo Prova Água', 'Luminária Mesa Articulada Led', 'Toalha Banho Algodão Egípcio', 'Kit Ferramentas Maleta Completa',
  'Ventilador Coluna Silencioso Turbo', 'Garrafa Térmica Inox Café', 'Cafeteira Expresso Cápsulas Prata', 'Tapete Sala Felpudo Cinza',
  'Fritadeira Elétrica Digital Forno', 'Câmera Segurança Externa Full', 'Teclado Mecânico Retroiluminado Switch', 'Monitor Curvo Ultrawide Gamer'];
const unico = (i) => TITULOS[i - 1];

/** Oferta no formato do Etiqueta. `precoEm`: ms (vira o texto do contrato), texto cru, ou undefined (ausente). */
const doEtiqueta = (i, loja, { preco = 100, precoEm, titulo = unico(i) } = {}) => ({
  id: i, loja, titulo, preco, preco_antigo: 150, desconto_pct: 33, categoria: 'Casa',
  ...(loja === 'amazon' ? { item_id: asinDe(i), link: 'https://www.amazon.com.br/dp/X?tag=terceiro-20' } : {}),
  ...(loja === 'ml' ? { item_id: `MLB${4000000000 + i}`, link: 'https://meli.la/TerCeiro1' } : {}),
  ...(loja === 'shopee' ? { item_id: `123.${i}`, link: `https://s.shopee.com.br/Ab${i}cd`, preco_antigo: null, desconto_pct: 0 } : {}),
  ...(precoEm === undefined ? {} : { preco_em: typeof precoEm === 'number' ? precoEmTexto(precoEm) : precoEm }),
});
const confirmado = (preco, precoEm) => ({ resultado: 'confirmado', preco, precoAntigo: 150, descontoPct: null, precoEm });
const falhou = (causa) => ({ resultado: 'falha', causa });

/**
 * Agendador real + verificador real, com o Etiqueta falso. `releitura`: ASIN → resposta (ou função (asin, n) → resposta;
 * n = quantas vezes o ASIN já foi pedido). `comFreio`: imita o Etiqueta real, que recusa tudo por 15 min depois de um
 * `bloqueado` (resposta `falha`/`freio`) e por 3 s entre leituras. `eventos` guarda 'reler ASIN' e 'link ID' em ordem.
 * O relógio é só o `Date` (t.mock.timers) e é ligado ANTES de criar o agendador (o ritmo guarda o Date.now).
 */
function montar(t, { agora = dia(2, 14), catalogo = [], releitura = {}, comFreio = false, loja = {}, ordem = 'relevancia', semEtiqueta = false } = {}) {
  t.mock.timers.reset(); // vários cenários por teste: o relógio recomeça em `agora`
  t.mock.timers.enable({ apis: ['Date'], now: agora });
  const dir = tmp(); const db = openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const eventos = [];
  const pedirLink = links.requestLink;
  links.requestLink = async (p) => { eventos.push(`link ${/MLB-?(\d+)/.exec(String(p.url))?.[1] ?? p.url}`); return pedirLink(p); };
  const amazon = createAmazon({ db, fetch: async () => { throw new Error('rede proibida (Amazon)'); }, esperar: async () => {}, lerConexao: () => ({ tag: 'achadinho-20' }) });
  const pedidos = new Map();
  let bloqueadoAte = 0; let ultimaLeitura = -Infinity;
  const etiqueta = semEtiqueta ? null : {
    async confirmarPreco(asin) {
      eventos.push(`reler ${asin}`);
      const n = (pedidos.get(asin) ?? 0) + 1; pedidos.set(asin, n);
      const agoraMs = Date.now();
      if (comFreio && (agoraMs < bloqueadoAte || agoraMs - ultimaLeitura < 3000)) return falhou('freio');
      const r = typeof releitura === 'function' ? releitura(asin, n) : releitura[asin] ?? falhou('nao_encontrado');
      if (comFreio) { ultimaLeitura = agoraMs; if (r.resultado === 'falha' && r.causa === 'bloqueado') bloqueadoAte = agoraMs + 15 * MIN; }
      return r;
    },
  };
  const mlLoja = {
    async conferirProduto(url) {
      const id = /MLB-?(\d+)/.exec(String(url))?.[1]; eventos.push(`conferir ${id}`);
      const r = loja[id];
      if (!r || r === 'falha') throw new Error('loja fora do ar (falsa)');
      return r;
    },
  };
  const verificador = createVerificador({ db, ml: mlLoja, amazon, catalogo: etiqueta });
  const estado = { ofertas: catalogo, ctxs: [] };
  const fonte = {
    async candidatos(cfg, ctx) {
      estado.ctxs.push(ctx);
      return estado.ofertas.map(paraCandidato).filter((c) => c && !ctx.tratada(c, cfg.ordem));
    },
    avancar() {}, // o cursor real não é o foco; o que importa é a lista que a regra recebe
  };
  const catalogoItens = createCatalogoItens({ db, wa, links, amazon, ml: mlLoja });
  const scheduler = createScheduler({ db, wa, links, fast: true, amazon, verificador, catalogo: fonte, catalogoItens });
  db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run('111@g.us', 'Achadinhos', 10, Date.now());
  db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etiquetaA', Date.now());
  const logs = (id) => db.prepare('SELECT level, offer_title, message FROM log WHERE rule_id = ? ORDER BY id').all(id).map((l) => ({ ...l }));
  const saiu = () => wa.simulated.map((m) => m.text.split('\n')[0].replace(/^\*|\*$/g, ''));
  const avancar = (ms) => t.mock.timers.setTime(Date.now() + ms);
  return { db, wa, links, scheduler, verificador, eventos, pedidos, estado, catalogoItens, logs, saiu, avancar, amazon, mlLoja, ordem };
}

const regraCatalogo = (db, { per = 2, ordem = 'relevancia', extra = {} } = {}) => Number(db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id,
  group_jids, source_type, source_config, sources, per_run, interval_min, window_start, window_end, dedupe_days, send_image, max_price, created_at)
  VALUES ('Catálogo', 1, 1, 1, ?, 'list', '{}', ?, ?, 60, '00:00', '23:59', 7, 0, ?, ?)`)
  .run(JSON.stringify(['111@g.us']), JSON.stringify([{ type: 'catalogo', tag_id: null, config: { ordem } }]), per, extra.max_price ?? null, Date.now()).lastInsertRowid);
const itens = (db, id) => db.prepare("SELECT chave, status, motivos FROM catalogo_itens WHERE rule_id = ? ORDER BY id").all(id).map((l) => ({ ...l }));
const enviadas = (db, id) => db.prepare('SELECT offer_key FROM sent_offers WHERE rule_id = ? ORDER BY id').all(id).map((l) => l.offer_key);
const sairam = (s, id) => s.logs(id).filter((l) => /^(Horário \d\d:\d\d: s|S)aíram /.test(l.message)).map((l) => l.message);
const puladas = (s, id) => s.logs(id).filter((l) => l.message.startsWith('Pulada')).map((l) => l.message);

// =============================================================================================== FOCO 1: oferta "veneno"

/** Uma Amazon (a 1ª) que SEMPRE bloqueia a releitura e quatro outras que confirmariam, todas com preço visto há 10 h. */
function cenarioVeneno(t, opcoes = {}) {
  const velho = dia(2, 4); // 10 h antes das 14h: fora da reserva
  const s = montar(t, {
    catalogo: [1, 2, 3, 4, 5].map((i) => doEtiqueta(i, 'amazon', { precoEm: velho })),
    releitura: (asin) => (asin === asinDe(1) ? falhou('bloqueado') : confirmado(100, Date.now())),
    ...opcoes,
  });
  return s;
}

test('foco 1 (veneno): uma Amazon que SEMPRE bloqueia a releitura não prende as outras para sempre (execuções espaçadas além da pausa)', async (t) => {
  const s = cenarioVeneno(t);
  const id = regraCatalogo(s.db, { per: 2 });
  for (let i = 0; i < 6; i++) {
    await s.scheduler.runRule(id);
    s.avancar(3 * HORA); // muito além da pausa de 10 min do Turbo (e dos 15 min do Etiqueta)
  }
  const aSairam = enviadas(s.db, id);
  assert.ok(aSairam.length > 0, `nenhuma das outras 4 Amazon saiu em 6 execuções (reler: ${s.eventos.join(', ')}); ficaram presas atrás da veneno`);
});

for (const causa of ['bloqueado', 'falha_rede']) {
  test(`foco 1 (veneno): com o freio de 15 min do Etiqueta real e a causa "${causa}", as outras não ficam presas`, async (t) => {
    const s = montar(t, {
      catalogo: [1, 2, 3, 4, 5].map((i) => doEtiqueta(i, 'amazon', { precoEm: dia(2, 4) })),
      releitura: (asin) => (asin === asinDe(1) ? falhou(causa) : confirmado(100, Date.now())),
      comFreio: true,
    });
    const id = regraCatalogo(s.db, { per: 2 });
    for (let i = 0; i < 5; i++) { await s.scheduler.runRule(id); s.avancar(2 * HORA); }
    assert.ok(enviadas(s.db, id).length > 0, `${causa}: nenhuma outra Amazon saiu em 5 execuções`);
  });
}

test('foco 1 (veneno): a veneno com preço visto há menos de 6 h sai pela reserva uma vez e não volta (não prende ninguém)', async (t) => {
  const s = montar(t, {
    catalogo: [doEtiqueta(1, 'amazon', { precoEm: dia(2, 12) }), ...[2, 3].map((i) => doEtiqueta(i, 'amazon', { precoEm: dia(2, 12) }))],
    releitura: (asin) => (asin === asinDe(1) ? falhou('bloqueado') : confirmado(100, Date.now())),
  });
  const id = regraCatalogo(s.db, { per: 1 });
  await s.scheduler.runRule(id);
  assert.deepEqual(enviadas(s.db, id), ['ASIN:' + asinDe(1)], 'a veneno sai pela reserva (preço visto há 2 h)');
  s.avancar(HORA);
  await s.scheduler.runRule(id);
  assert.equal(enviadas(s.db, id).length, 2, 'a seguinte sai pela reserva, ainda dentro das 6 h');
});

test('foco 1 (veneno): o que a veneno custa por execução — uma releitura só; as velhas seguintes não gastam tentativa nem chamam o Etiqueta', async (t) => {
  const s = cenarioVeneno(t);
  const id = regraCatalogo(s.db, { per: 2 });
  await s.scheduler.runRule(id);
  assert.deepEqual(s.eventos, [`reler ${asinDe(1)}`], 'a pausa de 10 min poupa o Etiqueta');
  assert.deepEqual(puladas(s, id).length, 1);
});

// =============================================================================== FOCO 2: Etiqueta fora do ar por horas

test('foco 2: Etiqueta fora por horas — uma linha "Pulada" por oferta escolhida, no máximo 4× as vagas por execução, e nenhuma ida à revisão', async (t) => {
  const catalogo = Array.from({ length: 16 }, (_, i) => doEtiqueta(i + 1, 'amazon', { precoEm: dia(1, 20) })); // 18 h antes: sem reserva
  const s = montar(t, { catalogo, releitura: () => falhou('fora_do_ar') });
  const id = regraCatalogo(s.db, { per: 2 });
  const porExecucao = [];
  for (let i = 0; i < 8; i++) { // 8 execuções, a cada 30 min, durante 4 h
    const antes = s.logs(id).length;
    await s.scheduler.runRule(id);
    porExecucao.push(s.logs(id).slice(antes).filter((l) => l.message.startsWith('Pulada')).length);
    s.avancar(30 * MIN);
  }
  assert.ok(porExecucao.every((n) => n <= 8), `no máximo 4× as vagas (8) de linhas "Pulada" por execução: ${porExecucao}`);
  assert.ok(s.eventos.filter((e) => e.startsWith('reler')).length <= 8 * 2, 'a releitura pausada poupa o Etiqueta: no máximo 1 chamada por janela de 10 min');
  assert.deepEqual(itens(s.db, id), [], 'nada na revisão, nada registrado');
  assert.deepEqual(enviadas(s.db, id), []);
  assert.equal(s.logs(id).filter((l) => /revisão/i.test(l.message)).length, 0);
  assert.equal(s.logs(id).filter((l) => l.level === 'erro').length, 0, 'falha passageira não é alerta de erro');
});

test('foco 2: Etiqueta fora por horas — o histórico não explode (linhas por execução limitadas) e, quando volta, a regra envia sozinha', async (t) => {
  let noAr = false;
  const catalogo = Array.from({ length: 10 }, (_, i) => doEtiqueta(i + 1, 'amazon', { precoEm: dia(1, 20) }));
  const s = montar(t, { catalogo, releitura: () => (noAr ? confirmado(100, Date.now()) : falhou('fora_do_ar')) });
  const id = regraCatalogo(s.db, { per: 2 });
  for (let i = 0; i < 6; i++) { await s.scheduler.runRule(id); s.avancar(HORA); }
  const linhasForaDoAr = s.logs(id).length;
  assert.ok(linhasForaDoAr <= 6 * 10, `linhas do Histórico em 6 execuções com o Etiqueta fora: ${linhasForaDoAr}`);
  assert.deepEqual(enviadas(s.db, id), []);
  noAr = true;
  await s.scheduler.runRule(id);
  assert.equal(enviadas(s.db, id).length, 2, 'voltou: envia sem ação do dono');
  assert.equal(s.wa.simulated.length, 2);
});

test('foco 2: Etiqueta fora, mas a reserva vale — a Amazon com preço de menos de 6 h sai e o Histórico diz que não foi conferida agora', async (t) => {
  const s = montar(t, {
    catalogo: [1, 2].map((i) => doEtiqueta(i, 'amazon', { precoEm: dia(2, 11, 30) })),
    releitura: () => falhou('fora_do_ar'),
  });
  const id = regraCatalogo(s.db, { per: 2 });
  await s.scheduler.runRule(id);
  assert.equal(s.wa.simulated.length, 2);
  const oks = s.logs(id).filter((l) => l.level === 'ok').map((l) => l.message);
  assert.ok(oks.every((m) => m.includes('preço visto às 11:30, não conferido agora (o Etiqueta não respondeu)')), oks.join(' | '));
  assert.deepEqual(s.eventos, [`reler ${asinDe(1)}`], 'só a 1ª chamou o Etiqueta; a pausa poupou a 2ª');
});

// ============================================================================= FOCO 3: revisão cheia de Shopee

test('foco 3: regra com muitas Shopee — no máximo 4× as vagas escolhidas por execução e o teto de 50 da revisão é respeitado', async (t) => {
  const s = montar(t, { catalogo: Array.from({ length: 30 }, (_, i) => doEtiqueta(i + 1, 'shopee')) });
  const id = regraCatalogo(s.db, { per: 3 });
  const r = await s.scheduler.runRule(id);
  assert.equal(r.revisao, 12, 'per_run 3 → 12 escolhidas (3 × 4), todas para a revisão');
  assert.equal(r.offers, 0);
  assert.equal(itens(s.db, id).length, 12);
  for (let i = 0; i < 6; i++) { s.avancar(HORA); await s.scheduler.runRule(id); }
  const n = itens(s.db, id).length;
  assert.ok(n <= 30, `o catálogo só tinha 30: ${n}`);
  // com 80 Shopee, a revisão trava em 50 e a regra para de encher
  const s2 = montar(t, { catalogo: Array.from({ length: 80 }, (_, i) => doEtiqueta(i + 1, 'shopee', { titulo: `Item Shopee ${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))} exclusivo ${i * 7919}` })) });
  const id2 = regraCatalogo(s2.db, { per: 5 });
  for (let i = 0; i < 6; i++) { await s2.scheduler.runRule(id2); s2.avancar(HORA); }
  assert.ok(itens(s2.db, id2).filter((x) => x.status === 'revisao').length <= 50, 'teto de 50 pendentes por regra');
});

test('foco 3: Shopee na revisão libera a vaga para a próxima loja (a Amazon confirmada sai na mesma execução)', async (t) => {
  const s = montar(t, {
    catalogo: [doEtiqueta(1, 'shopee'), doEtiqueta(2, 'shopee'), doEtiqueta(3, 'amazon', { precoEm: dia(2, 13) })],
    releitura: { [asinDe(3)]: confirmado(100, dia(2, 14)) },
  });
  const id = regraCatalogo(s.db, { per: 1 });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.revisao], [1, 2]);
  assert.deepEqual(s.saiu(), [unico(3)]);
});

test('foco 3: revisão cheia (50) — a Shopee espera sem gastar vaga e a execução ainda envia as outras lojas', async (t) => {
  const s = montar(t, {
    catalogo: [doEtiqueta(60, 'shopee'), doEtiqueta(1, 'amazon', { precoEm: dia(2, 13) })],
    releitura: { [asinDe(1)]: confirmado(100, dia(2, 14)) },
  });
  const id = regraCatalogo(s.db, { per: 1 });
  const base = Date.now();
  for (let i = 0; i < 50; i++) {
    const c = { key: `SHOPEE:123.${i + 100}`, title: `Preenchimento ${i} unico${i * 31}`, price: 10, oldPrice: null, discountPct: null, image: null, categoria: 'Casa', tag_id: null, source_index: 0, loja: 'shopee', url: `https://s.shopee.com.br/Zz${i}` };
    s.catalogoItens.registrar({ id, name: 'R', dedupe_days: 7 }, c, 'revisao', ['shopee']);
  }
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM catalogo_itens WHERE rule_id = ? AND status = 'revisao'").get(id).n, 50);
  const r = await s.scheduler.runRule(id);
  assert.equal(r.offers, 1, 'a Amazon sai');
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM catalogo_itens WHERE rule_id = ? AND status = 'revisao'").get(id).n, 50, 'a revisão não passou de 50');
  assert.ok(Date.now() >= base);
});

// ===================================================== FOCO 4: verificador desligado / ligado no meio da execução

test('foco 4: desligar o verificador no meio da execução pula o catálogo que resta (nunca sai sem conferência) e a frase diz por quê', async (t) => {
  const s = montar(t, {
    catalogo: [1, 2, 3].map((i) => doEtiqueta(i, 'amazon', { precoEm: dia(2, 13) })),
    releitura: (asin) => { if (asin === asinDe(1)) setSetting(s.db, 'verificador_ativo', '0'); return confirmado(100, Date.now()); },
  });
  const id = regraCatalogo(s.db, { per: 3 });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual(s.saiu(), [unico(1)], 'só a que já estava sendo conferida sai');
  assert.equal(r.puladas, 2);
  assert.deepEqual(enviadas(s.db, id), ['ASIN:' + asinDe(1)]);
  assert.deepEqual(itens(s.db, id).map((x) => x.status), ['enviado'], 'as puladas não viram item nem revisão');
  assert.ok(puladas(s, id).every((m) => /verificador foi desligado/.test(m)), puladas(s, id).join(' | '));
});

test('foco 4: desligado no começo, a 1ª sai como hoje (sem releitura, sem sufixo); ligado no meio, a que resta é conferida (nunca sai sem conferência com o verificador ligado)', async (t) => {
  const s = montar(t, {
    catalogo: [1, 2].map((i) => doEtiqueta(i, 'amazon', { precoEm: dia(1, 1) })), // preço de 37 h atrás: fora da reserva
    releitura: { [asinDe(2)]: confirmado(100, dia(2, 14)) },
  });
  setSetting(s.db, 'verificador_ativo', '0');
  const id = regraCatalogo(s.db, { per: 2 });
  const gancho = s.wa.sendText.bind(s.wa); let ligou = false;
  s.wa.sendText = async (jid, texto) => { if (!ligou) { ligou = true; setSetting(s.db, 'verificador_ativo', '1'); } return gancho(jid, texto); };
  const r = await s.scheduler.runRule(id);
  assert.equal(r.offers, 2);
  assert.deepEqual(s.eventos, [`reler ${asinDe(2)}`], 'a 1ª saiu sem conferência (verificador desligado); a 2ª, já com ele ligado, foi relida');
  assert.ok(!/não conferido|preço visto/.test(s.logs(id).filter((l) => l.level === 'ok')[0].message));
});

test('foco 4: ligado no meio e com a releitura falhando, a Amazon velha que resta é pulada (sem revisão) em vez de sair sem conferência', async (t) => {
  const s = montar(t, { catalogo: [1, 2].map((i) => doEtiqueta(i, 'amazon', { precoEm: dia(1, 1) })), releitura: () => falhou('fora_do_ar') });
  setSetting(s.db, 'verificador_ativo', '0');
  const id = regraCatalogo(s.db, { per: 2 });
  const gancho = s.wa.sendText.bind(s.wa); let ligou = false;
  s.wa.sendText = async (jid, texto) => { if (!ligou) { ligou = true; setSetting(s.db, 'verificador_ativo', '1'); } return gancho(jid, texto); };
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.puladas, r.revisao], [1, 1, 0]);
  assert.deepEqual(itens(s.db, id).map((x) => x.status), ['enviado']);
});

test('foco 4: desligar no meio não derruba nem ressuscita a pausa — a execução seguinte (desligada) manda sem conferir e sem erro', async (t) => {
  const s = montar(t, { catalogo: [1, 2, 3].map((i) => doEtiqueta(i, 'amazon', { precoEm: dia(1, 1) })), releitura: () => falhou('fora_do_ar') });
  const id = regraCatalogo(s.db, { per: 1 });
  await s.scheduler.runRule(id);
  setSetting(s.db, 'verificador_ativo', '0');
  s.avancar(5 * MIN);
  const r = await s.scheduler.runRule(id);
  assert.equal(r.offers, 1);
  assert.equal(s.logs(id).filter((l) => l.level === 'erro').length, 0);
});

// ========================================= FOCO 5: concorrência com o "Enviar" do Catálogo durante a execução da regra

/** Item do Mercado Livre na revisão da regra `id` (falha de link), pronto para "Enviar" (links simulados). → id do item */
function naRevisaoShopee(s, id, n, titulo, preco = 50) {
  const c = { key: `MLB${n}`, title: titulo, price: preco, oldPrice: null, discountPct: null, sold: 10, freeShipping: true, coupon: null, image: 'https://http2.mlstatic.com/D_NQ_NP_123-O.jpg', categoria: 'Casa', tag_id: null, source_index: 0 };
  assert.equal(s.catalogoItens.registrar({ id, name: 'R', dedupe_days: 7 }, c, 'revisao', ['falha_link']), true);
  return s.db.prepare('SELECT id FROM catalogo_itens WHERE rule_id = ? AND chave = ?').get(id, c.key).id;
}
const tentar = (s, item) => s.catalogoItens.enviar(item, {}).then(() => 'enviou', (e) => `${e.status} ${e.message}`);

const FONE_A = 'Fone de Ouvido Bluetooth JBL Tune 510BT Preto';
const FONE_B = 'Fone de Ouvido Bluetooth JBL Tune 510BT Branco';
const FONE_AZUL = 'Fone de Ouvido Bluetooth JBL Tune 510BT Azul';

test('foco 5: "Enviar" do Catálogo de uma parecida da oferta que a regra está conferindo recebe 409 (a escolhida já está "saindo agora")', async (t) => {
  const s = montar(t, {
    catalogo: [doEtiqueta(1, 'amazon', { precoEm: dia(2, 13), titulo: FONE_A }), doEtiqueta(2, 'amazon', { precoEm: dia(2, 13), titulo: FONE_B })],
    releitura: () => confirmado(100, Date.now()),
  });
  const id = regraCatalogo(s.db, { per: 2 });
  const azul = naRevisaoShopee(s, id, 900, FONE_AZUL);
  let resultado = null;
  const orig = s.verificador.conferir.bind(s.verificador);
  s.verificador.conferir = async (...a) => { if (resultado === null) resultado = await tentar(s, azul); return orig(...a); };
  const r = await s.scheduler.runRule(id);
  assert.match(resultado, /^409 Não enviada: parecida com ".+", que está saindo agora/, String(resultado));
  assert.deepEqual(s.saiu(), [FONE_A], 'a Branca é parecida da Preta: só um fone sai');
  assert.deepEqual([r.offers, r.puladas], [1, 0], 'a Branca foi barrada pela trava na escolha (não chegou a ser escolhida)');
});

test('foco 5: "Enviar" do Catálogo de uma parecida de oferta AINDA NÃO escolhida passa; a regra pula a parecida dela quando chega a vez (sem par repetido)', async (t) => {
  // durante a conferência da 1ª (outro produto), o dono envia a Azul, parecida da Branca, que a regra só escolheria depois
  const s = montar(t, {
    catalogo: [doEtiqueta(1, 'amazon', { precoEm: dia(2, 13) }), doEtiqueta(2, 'amazon', { precoEm: dia(2, 13), titulo: FONE_B }), doEtiqueta(3, 'amazon', { precoEm: dia(2, 13) })],
    releitura: () => confirmado(100, Date.now()),
  });
  const id = regraCatalogo(s.db, { per: 2 });
  const azul = naRevisaoShopee(s, id, 901, FONE_AZUL);
  let resultado = null;
  const orig = s.verificador.conferir.bind(s.verificador);
  s.verificador.conferir = async (...a) => { if (resultado === null) resultado = await tentar(s, azul); return orig(...a); };
  const r = await s.scheduler.runRule(id);
  assert.equal(resultado, 'enviou', 'a Branca ainda não estava escolhida');
  assert.deepEqual(s.saiu(), [unico(1), unico(3)], 'a Branca é pulada (parecida da Azul que o dono enviou) e a vaga vai à 3ª');
  assert.deepEqual([r.offers, r.puladas], [2, 1]);
  assert.ok(s.logs(id).some((l) => l.offer_title === FONE_B && /^Pulada: parecida com ".+", que saiu por este disparo/.test(l.message)), s.logs(id).map((l) => l.message).join(' | '));
  const reservas = s.db.prepare('SELECT title FROM sent_offers WHERE rule_id = ? ORDER BY id').all(id).map((x) => x.title);
  assert.equal(reservas.filter((x) => x.startsWith('Fone')).length, 1, 'uma só reserva de fone');
});

test('foco 5: "Enviar" do Catálogo da MESMA oferta que a regra está conferindo recebe 409 e a regra a envia uma vez só', async (t) => {
  const s = montar(t, {
    catalogo: [doEtiqueta(1, 'amazon', { precoEm: dia(2, 13) })],
    releitura: () => confirmado(100, Date.now()),
  });
  const id = regraCatalogo(s.db, { per: 1 });
  // o mesmo título da Amazon na revisão (outra chave, Shopee): o par igual
  const igual = naRevisaoShopee(s, id, 901, unico(1));
  let res = null;
  const orig = s.verificador.conferir.bind(s.verificador);
  s.verificador.conferir = async (...a) => { res = await tentar(s, igual); return orig(...a); };
  await s.scheduler.runRule(id);
  assert.match(res, /^409 /, String(res));
  assert.equal(s.saiu().filter((x) => x === unico(1)).length, 1);
});

test('foco 5: a oferta que a regra descartou (devolvida) deixa de bloquear o "Enviar" do Catálogo já durante a execução', async (t) => {
  const s = montar(t, {
    catalogo: [doEtiqueta(1, 'amazon', { precoEm: dia(2, 13) }), doEtiqueta(2, 'amazon', { precoEm: dia(2, 13) })],
    releitura: (asin) => (asin === asinDe(1) ? { resultado: 'sem_preco' } : confirmado(100, Date.now())),
  });
  const id = regraCatalogo(s.db, { per: 1 });
  const igual = naRevisaoShopee(s, id, 902, unico(1));
  const durante = [];
  const orig = s.verificador.conferir.bind(s.verificador);
  // 1ª conferência (a oferta 1): ela está "saindo agora" e o Enviar do mesmo título é barrado; 2ª (a oferta 2): a 1ª já caiu fora
  s.verificador.conferir = async (...a) => { durante.push(await tentar(s, igual)); return orig(...a); };
  await s.scheduler.runRule(id);
  assert.match(durante[0], /^409 Não enviada: parecida com ".+", que está saindo agora/);
  assert.equal(durante[1], 'enviou', 'a Amazon caiu fora (indisponível) e foi devolvida: o dono pode enviar a mesma oferta pelo Catálogo');
});

test('foco 5: a 1ª cai fora (outro produto) e o dono envia, nesse meio tempo, a parecida da reposta: a reposta é pulada e a vaga vai à seguinte', async (t) => {
  const s = montar(t, {
    catalogo: [doEtiqueta(1, 'amazon', { precoEm: dia(2, 13) }), doEtiqueta(2, 'amazon', { precoEm: dia(2, 13), titulo: FONE_B }), doEtiqueta(3, 'amazon', { precoEm: dia(2, 13) })],
    releitura: (asin) => (asin === asinDe(1) ? { resultado: 'outro_produto' } : confirmado(100, Date.now())),
  });
  const id = regraCatalogo(s.db, { per: 1 });
  const dono = naRevisaoShopee(s, id, 903, FONE_A);
  let res = null;
  const orig = s.verificador.conferir.bind(s.verificador);
  s.verificador.conferir = async (...a) => { if (res === null) res = await tentar(s, dono); return orig(...a); };
  const r = await s.scheduler.runRule(id);
  assert.equal(res, 'enviou');
  assert.deepEqual(s.saiu(), [unico(3)], 'a reposta B (parecida da que o dono enviou) é pulada: sai a 3ª');
  assert.deepEqual([r.offers, r.descartadas, r.puladas], [1, 1, 1]);
});

// =============================================================================== FOCO 6: migração (CA1.10)

test('foco 6 (CA1.10): a migração roda duas vezes sem apagar de novo nem duplicar a linha; itens com outros motivos ficam', async () => {
  const dir = tmp();
  let db = openDb(dir);
  db.prepare("DELETE FROM settings WHERE key = 'migracao_e1_nao_conferido'").run();
  db.prepare("INSERT INTO rules (name, enabled, group_jids, source_type, source_config, per_run, interval_min, created_at) VALUES ('R', 1, '[]', 'list', '{}', 1, 60, ?)").run(Date.now());
  const ins = (chave, status, motivos) => db.prepare("INSERT INTO catalogo_itens (rule_id, chave, loja, status, motivos, oferta, criado_em) VALUES (1, ?, 'amazon', ?, ?, '{}', ?)")
    .run(chave, status, JSON.stringify(motivos), Date.now());
  const colunas = db.prepare('PRAGMA table_info(catalogo_itens)').all().map((c) => c.name);
  assert.ok(colunas.includes('motivos'));
  try {
    ins('ASIN:B000000001', 'revisao', ['nao_conferido']);
    ins('ASIN:B000000002', 'revisao', ['nao_conferido', 'preco_suspeito']);
    ins('ASIN:B000000003', 'revisao', ['preco_suspeito']);
    ins('ASIN:B000000004', 'descartado', ['nao_conferido']);
    ins('ASIN:B000000005', 'enviado', ['nao_conferido']);
  } catch (e) { assert.fail('semear: ' + e.message); }
  db.close();
  db = openDb(dir);
  const chaves = () => db.prepare('SELECT chave FROM catalogo_itens ORDER BY id').all().map((x) => x.chave);
  assert.deepEqual(chaves(), ['ASIN:B000000002', 'ASIN:B000000003', 'ASIN:B000000004', 'ASIN:B000000005'], 'só o exatamente ["nao_conferido"] em revisão sai');
  const linhas = () => db.prepare("SELECT message FROM log WHERE message LIKE '%nao_conferido%' OR message LIKE '%conferi%' ORDER BY id").all().length;
  const antes = linhas();
  db.close();
  db = openDb(dir);
  assert.deepEqual(chaves(), ['ASIN:B000000002', 'ASIN:B000000003', 'ASIN:B000000004', 'ASIN:B000000005']);
  assert.equal(linhas(), antes, 'a segunda abertura não grava outra linha');
  assert.equal(getSetting(db, 'migracao_e1_nao_conferido'), '1');
  // um item novo só com nao_conferido depois da migração NÃO é apagado na próxima abertura (a marca vale)
  db.prepare("INSERT INTO catalogo_itens (rule_id, chave, loja, status, motivos, oferta, criado_em) VALUES (1, 'ASIN:B000000009', 'amazon', 'revisao', ?, '{}', ?)").run(JSON.stringify(['nao_conferido']), Date.now());
  db.close();
  db = openDb(dir);
  assert.ok(chaves().includes('ASIN:B000000009'));
  db.close();
});

test('foco 6 (CA1.10): banco sem a tabela catalogo_itens (instalação sem Catálogo) abre sem erro e marca a migração', () => {
  const dir = tmp();
  let db = openDb(dir);
  db.exec('DROP TABLE IF EXISTS catalogo_itens');
  db.prepare("DELETE FROM settings WHERE key = 'migracao_e1_nao_conferido'").run();
  db.close();
  assert.doesNotThrow(() => { db = openDb(dir); });
  assert.equal(getSetting(db, 'migracao_e1_nao_conferido'), '1');
  db.close();
});

// =============================================================================== FOCO 7: preco_em em formatos estranhos

test('foco 7: lerPrecoEm só aceita AAAA-MM-DDTHH:MM:SS local; fuso, só data, vazio, espaço e datas impossíveis viram null', () => {
  for (const ruim of ['2026-11-02T10:00:00Z', '2026-11-02T10:00:00-03:00', '2026-11-02T10:00:00+0000', '2026-11-02', '', '   ', '2026-11-02 10:00:00',
    '2026-11-02T10:00', '2026-02-30T10:00:00', '2026-13-01T10:00:00', '2026-11-02T25:00:00', '2026-11-02T10:60:00', '2026-11-02T10:00:60', 'ontem', null, undefined, 0, 1793624400000, {}, [], ' 2026-11-02T10:00:00', '2026-11-02T10:00:00.123', '2026-11-02T10:00:00\n']) {
    assert.equal(lerPrecoEm(ruim), null, `deveria recusar ${JSON.stringify(ruim)}`);
  }
  assert.equal(lerPrecoEm('2026-11-02T10:00:00'), dia(2, 10));
  assert.equal(lerPrecoEm('2024-02-29T23:59:59'), new Date(2024, 1, 29, 23, 59, 59).getTime(), '29/02 de ano bissexto existe');
  assert.equal(lerPrecoEm('2026-02-29T10:00:00'), null, '29/02 de ano comum não existe');
});

test('foco 7: reserva em formatos estranhos — nunca envia sem saber quando o preço foi visto (regra → Histórico, sem sent_offers)', async (t) => {
  const agora = dia(2, 14);
  const estranhos = [
    ['com fuso Z', '2026-11-02T13:00:00Z'], ['com offset', '2026-11-02T13:00:00-03:00'], ['só data', '2026-11-02'], ['vazio', ''],
    ['espaço no lugar do T', '2026-11-02 13:00:00'], ['sem segundos', '2026-11-02T13:00'], ['lixo', 'agora mesmo'], ['data impossível', '2026-02-30T13:00:00'],
    ['futuro (+6 min)', agora + 6 * MIN], ['futuro distante', agora + 40 * HORA], ['6 h e 1 s atrás', agora - 6 * HORA - 1000],
  ];
  for (const [nome, precoEm] of estranhos) {
    const s = montar(t, { agora, catalogo: [doEtiqueta(1, 'amazon', { precoEm })], releitura: () => falhou('fora_do_ar') });
    const id = regraCatalogo(s.db, { per: 1 });
    const r = await s.scheduler.runRule(id);
    assert.deepEqual([r.offers, r.messages, r.puladas], [0, 0, 1], nome);
    assert.deepEqual(enviadas(s.db, id), [], nome);
    assert.deepEqual(itens(s.db, id), [], nome);
    assert.equal(s.wa.simulated.length, 0, nome);
  }
});

test('foco 7: reserva nos limites — 6 h exatas e 5 min no futuro enviam; 6 h + 1 s e 5 min + 1 s não; com a hora do preço, nunca a do envio', async (t) => {
  const agora = dia(2, 14);
  const casos = [['6 h exatas', agora - 6 * HORA, true], ['6 h + 1 s', agora - 6 * HORA - 1000, false], ['+5 min', agora + 5 * MIN, true], ['+5 min 1 s', agora + 5 * MIN + 1000, false]];
  for (const [nome, precoEm, envia] of casos) {
    const s = montar(t, { agora, catalogo: [doEtiqueta(1, 'amazon', { precoEm })], releitura: () => falhou('bloqueado') });
    const id = regraCatalogo(s.db, { per: 1 });
    await s.scheduler.runRule(id);
    assert.equal(s.wa.simulated.length, envia ? 1 : 0, nome);
    if (envia) assert.match(s.logs(id).find((l) => l.level === 'ok').message, new RegExp(`preço visto às ${p2(new Date(precoEm).getHours())}:${p2(new Date(precoEm).getMinutes())}`), nome);
  }
});

test('foco 7: virada do dia — o preço visto às 23:50 de ontem, às 02:00 de hoje, sai com "às 23:50 de DD/MM" e a data do dia anterior', async (t) => {
  const agora = dia(3, 2, 0);
  const s = montar(t, { agora, catalogo: [doEtiqueta(1, 'amazon', { precoEm: dia(2, 23, 50) })], releitura: () => falhou('fora_do_ar') });
  const id = regraCatalogo(s.db, { per: 1 });
  await s.scheduler.runRule(id);
  assert.equal(s.wa.simulated.length, 1, '2 h 10 min atrás: dentro das 6 h');
  assert.match(s.logs(id).find((l) => l.level === 'ok').message, /preço visto às 23:50 de 02\/11, não conferido agora/);
});

test('foco 7: {HORA_PRECO} na reserva é a hora do preço, mesmo atravessando a meia-noite; nunca a do envio', async (t) => {
  const agora = dia(3, 1, 5);
  const s = montar(t, { agora, catalogo: [doEtiqueta(1, 'amazon', { precoEm: dia(2, 22, 15) })], releitura: () => falhou('fora_do_ar') });
  const id = regraCatalogo(s.db, { per: 1 });
  s.db.prepare('INSERT INTO templates (name, body, created_at) VALUES (?,?,?)').run('H', '*{TITULO_PRODUTO}*\nPreço das {HORA_PRECO}\n{LINK}', Date.now());
  s.db.prepare('UPDATE rules SET template_id = (SELECT MAX(id) FROM templates) WHERE id = ?').run(id);
  await s.scheduler.runRule(id);
  assert.match(s.wa.simulated[0].text, /Preço das 22h15/);
  assert.ok(!s.wa.simulated[0].text.includes('01h05'));
});

test('foco 7: horário de verão (fuso com mudança de hora) — a idade da reserva é pela diferença em ms, não pelo relógio de parede', async (t) => {
  // America/Sao_Paulo não tem mais horário de verão; Europe/Lisbon sim (domingo 25/10/2026 02:00 → 01:00 locais)
  const tzAntes = process.env.TZ;
  process.env.TZ = 'Europe/Lisbon';
  t.after(() => { if (tzAntes === undefined) delete process.env.TZ; else process.env.TZ = tzAntes; });
  const dl = (d, h, m = 0) => new Date(2026, 9, d, h, m).getTime();
  // 25/10/2026 às 01:30 (2ª vez, já em horário de inverno) o preço foi visto às 01:30 (1ª vez, horário de verão): 1 h de diferença
  const precoEm = new Date('2026-10-25T00:30:00Z').getTime(); // 01:30 WEST
  const agora = new Date('2026-10-25T01:30:00Z').getTime(); // 01:30 WET
  assert.equal(agora - precoEm, HORA);
  assert.equal(reservaValida(precoEm, agora), true);
  assert.equal(reservaValida(agora - 6 * HORA - 1000, agora), false);
  // o texto do contrato "AAAA-MM-DDTHH:MM:SS" da hora ambígua lê o primeiro instante (nunca um valor inventado)
  const lido = lerPrecoEm('2026-10-25T01:30:00');
  assert.ok(lido === precoEm || lido === agora, 'hora ambígua resolve para um dos dois instantes reais');
  assert.ok(Number.isFinite(dl(25, 3)));
});

test('foco 7: oferta sem preco_em e releitura ok (confirmada) sai — o preco_em do candidato só importa quando a releitura falha', async (t) => {
  const s = montar(t, { catalogo: [doEtiqueta(1, 'amazon')], releitura: { [asinDe(1)]: confirmado(100, dia(2, 14)) } });
  const id = regraCatalogo(s.db, { per: 1 });
  const r = await s.scheduler.runRule(id);
  assert.equal(r.offers, 1);
});

test('constantes: a reserva é de 6 h e a pausa da releitura de 10 min', () => {
  assert.equal(RESERVA_AMAZON_H, 6);
  assert.equal(PAUSA_RELEITURA_MIN, 10);
});

// ======================================================= INTEGRAÇÃO: cliente real do Etiqueta sobre um Etiqueta falso (fetch)

const TOKEN_FALSO = 'tkFALSO_qa_rodar_sozinho_0123456789abcdef';

/**
 * Etiqueta falso que fala o contrato v1 por fetch: GET /api/v1/ofertas (filtra por `loja` e por `preco_max_horas`, 48 h se
 * ausente) e POST /api/v1/amazon/<ASIN>/confirmar-preco (grava o preço e o `preco_em` na própria lista, como o real).
 * `estado.itens`: ASIN → { preco, precoEm (ms), titulo, resposta?: função () → { status, corpo } para forçar a rota }.
 * `estado.pedidos` guarda 'GET ...' e 'POST ASIN'. Depois de um `bloqueado`, recusa por 15 min (429 freio).
 */
function etiquetaViva(estado) {
  estado.pedidos = []; let bloqueadoAte = 0;
  const json = (status, corpo) => new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
  const f = async (url, init = {}) => {
    estado.espiao?.(url, init);
    const u = new URL(String(url));
    const h = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    if (h.authorization !== `Bearer ${TOKEN_FALSO}`) return json(401, { error: 'token ausente ou inválido' });
    if (estado.fora) throw new TypeError('fetch failed');
    if ((init.method ?? 'GET') === 'GET' && u.pathname === '/api/v1/ofertas') {
      estado.pedidos.push(`GET ${u.search}`);
      const maxH = Number(u.searchParams.get('preco_max_horas') ?? 48);
      const ofertas = Object.entries(estado.itens)
        .filter(([, i]) => Date.now() - i.precoEm <= maxH * HORA)
        .map(([asin, i], n) => ({ id: n + 1, loja: 'amazon', item_id: asin, titulo: i.titulo, preco: i.preco, preco_antigo: i.preco + 50, desconto_pct: 33,
          preco_em: precoEmTexto(i.precoEm), categoria: 'Casa', link: `https://www.amazon.com.br/dp/${asin}?tag=terceiro-20`, imagem: '', criado_em: '2026-11-01T10:00:00', atualizado_em: '2026-11-01T10:00:00' }));
      return json(200, { versao: 1, ofertas, proximo: null, total: ofertas.length });
    }
    const m = /^\/api\/v1\/amazon\/([A-Z0-9]{10})\/confirmar-preco$/.exec(u.pathname);
    if (init.method === 'POST' && m) {
      estado.pedidos.push(`POST ${m[1]}`);
      const i = estado.itens[m[1]];
      if (!i) return json(404, { error: 'oferta da Amazon não encontrada' });
      if (i.resposta) { const r = i.resposta(); return json(r.status, r.corpo); }
      if (Date.now() < bloqueadoAte) return json(429, { versao: 1, resultado: 'freio', motivo: 'pausa', tentar_em_s: 600 });
      if (i.bloqueia) { bloqueadoAte = Date.now() + 15 * MIN; return json(200, { versao: 1, resultado: 'bloqueado' }); }
      i.precoEm = Date.now();
      return json(200, { versao: 1, resultado: 'confirmado', preco: i.preco, preco_antigo: i.preco + 50, desconto_pct: 33, preco_em: precoEmTexto(i.precoEm) });
    }
    return json(404, { error: 'rota não encontrada' });
  };
  return f;
}

/** Agendador com o cliente REAL do Etiqueta (createCatalogo) sobre o fetch do Etiqueta falso. */
function montarIntegrado(t, { agora = dia(2, 14), itens, extra = {} } = {}) {
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ['Date'], now: agora });
  const dir = tmp(); const db = openDb(dir);
  const tokenPath = path.join(dir, 'api_token.txt');
  fs.writeFileSync(tokenPath, `${TOKEN_FALSO}\n`, { mode: 0o600 });
  const estado = { itens, ...extra };
  const fetchFalso = etiquetaViva(estado);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const amazon = createAmazon({ db, fetch: async () => { throw new Error('rede proibida (Amazon)'); }, esperar: async () => {}, lerConexao: () => ({ tag: 'achadinho-20' }) });
  const catalogo = createCatalogo({ db, fetch: fetchFalso, lerConexao: () => ({ endereco: 'http://127.0.0.1:8765', caminho_token: tokenPath }) });
  const catalogoItens = createCatalogoItens({ db, wa, links, amazon });
  const verificador = createVerificador({ db, amazon, catalogo });
  const scheduler = createScheduler({ db, wa, links, fast: true, amazon, verificador, catalogo, catalogoItens });
  db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run('111@g.us', 'Achadinhos', 10, Date.now());
  db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etiquetaA', Date.now());
  const logs = (id) => db.prepare('SELECT level, offer_title, message FROM log WHERE rule_id = ? ORDER BY id').all(id).map((l) => ({ ...l }));
  const avancar = (ms) => t.mock.timers.setTime(Date.now() + ms);
  return { db, wa, scheduler, estado, logs, avancar, verificador, catalogo, dir, tokenPath };
}
const regraAmazon = (db, { per = 2, ordem = 'relevancia' } = {}) => Number(db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id,
  group_jids, source_type, source_config, sources, per_run, interval_min, window_start, window_end, dedupe_days, send_image, created_at)
  VALUES ('Amazon', 1, 1, 1, ?, 'list', '{}', ?, ?, 60, '00:00', '23:59', 7, 0, ?)`)
  .run(JSON.stringify(['111@g.us']), JSON.stringify([{ type: 'catalogo', tag_id: null, config: { ordem, lojas: ['amazon'] } }]), per, Date.now()).lastInsertRowid);

test('integração CA1.3/CA1.6: lista com preço de 30 h → o Turbo pede 72 h, relê, envia com o preço lido e o Etiqueta fica atualizado', async (t) => {
  const itens = { [asinDe(1)]: { titulo: unico(1), preco: 100, precoEm: dia(1, 8) } }; // 30 h antes das 14h
  const s = montarIntegrado(t, { itens });
  const id = regraAmazon(s.db, { per: 1 });
  await s.scheduler.runRule(id);
  assert.equal(s.wa.simulated.length, 1, 'sai sem passar pela revisão');
  assert.match(s.wa.simulated[0].text, /amazon\.com\.br\/dp\/B000000001\?tag=achadinho-20/);
  assert.match(s.estado.pedidos[0], /preco_max_horas=72/, 'o Turbo pediu a idade larga porque o verificador está ligado e a loja é só a Amazon');
  assert.ok(s.estado.pedidos.includes(`POST ${asinDe(1)}`));
  assert.equal(s.estado.itens[asinDe(1)].precoEm, dia(2, 14), 'o Etiqueta carimbou a hora da releitura');
  assert.deepEqual(s.db.prepare("SELECT status FROM catalogo_itens WHERE rule_id = ?").all(id).map((x) => x.status), ['enviado']);
});

test('integração CA1.11: com o verificador desligado a lista usa a validade do Etiqueta (sem preco_max_horas) e nunca há POST', async (t) => {
  const itens = { [asinDe(1)]: { titulo: unico(1), preco: 100, precoEm: dia(2, 10) } };
  const s = montarIntegrado(t, { itens });
  setSetting(s.db, 'verificador_ativo', '0');
  const id = regraAmazon(s.db, { per: 1 });
  await s.scheduler.runRule(id);
  assert.equal(s.estado.pedidos.filter((p) => p.startsWith('POST')).length, 0);
  assert.ok(!/preco_max_horas/.test(s.estado.pedidos[0]), s.estado.pedidos[0]);
  assert.equal(s.wa.simulated.length, 1);
});

test('integração: preço de 30 h que o Etiqueta relê mais caro (acima do limite) é descartado com o motivo', async (t) => {
  const itens = { [asinDe(1)]: { titulo: unico(1), preco: 100, precoEm: dia(1, 8) } };
  const s = montarIntegrado(t, { itens });
  const gancho = s.estado.itens[asinDe(1)];
  gancho.resposta = () => ({ status: 200, corpo: { versao: 1, resultado: 'confirmado', preco: 120, preco_antigo: 170, desconto_pct: 29, preco_em: precoEmTexto(Date.now()) } });
  const id = regraAmazon(s.db, { per: 1 });
  await s.scheduler.runRule(id);
  assert.equal(s.wa.simulated.length, 0);
  assert.ok(s.logs(id).some((l) => /Descartada: preço subiu de R\$ 100,00 para R\$ 120,00/.test(l.message)), s.logs(id).map((l) => l.message).join(' | '));
});

test('integração CA1.5: Etiqueta antigo (405 na rota nova) ou desligado (503) ou token recusado (401): vale a reserva de 6 h, sem revisão, sem erro', async (t) => {
  for (const status of [405, 503, 401, 500, 400]) {
    const itens = {
      [asinDe(1)]: { titulo: unico(1), preco: 100, precoEm: dia(2, 12), resposta: () => ({ status, corpo: { error: 'x' } }) },
      [asinDe(2)]: { titulo: unico(2), preco: 100, precoEm: dia(1, 8), resposta: () => ({ status, corpo: { error: 'x' } }) },
    };
    const s = montarIntegrado(t, { itens });
    const id = regraAmazon(s.db, { per: 2 });
    const r = await s.scheduler.runRule(id);
    assert.equal(r.offers, 1, `HTTP ${status}: a de 2 h sai pela reserva`);
    assert.equal(r.puladas, 0, `HTTP ${status}: a de 30 h nem é escolhida (a releitura ficou em pausa): não gasta tentativa`);
    assert.ok(s.logs(id).some((l) => /1 da Amazon que não dá para conferir agora/.test(l.message)), `HTTP ${status}: ${s.logs(id).map((l) => l.message).join(' | ')}`);
    assert.equal(r.revisao, 0);
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM catalogo_itens WHERE rule_id = ? AND status = 'revisao'").get(id).n, 0);
    assert.equal(s.logs(id).filter((l) => l.level === 'erro').length, 0, `HTTP ${status}`);
    assert.match(s.logs(id).find((l) => l.level === 'ok').message, /preço visto às 12:00, não conferido agora/);
  }
});

test('integração: Etiqueta fora do ar (fetch lança) — pulada sem revisão; quando volta, a mesma oferta sai sozinha na execução seguinte', async (t) => {
  const itens = { [asinDe(1)]: { titulo: unico(1), preco: 100, precoEm: dia(1, 8) } };
  const s = montarIntegrado(t, { itens, extra: { fora: false } });
  // o GET da lista funciona (o Etiqueta estava no ar na leitura) e o POST falha: a lista chega, a releitura não
  const orig = s.estado.itens[asinDe(1)];
  orig.resposta = () => { throw new TypeError('fetch failed'); };
  const id = regraAmazon(s.db, { per: 1 });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.puladas, r.revisao], [0, 1, 0]);
  assert.ok(s.logs(id).some((l) => /Pulada: o preço visto às .* tem mais de 6 h e não deu para conferir agora \(o Etiqueta não respondeu\)/.test(l.message)), s.logs(id).map((l) => l.message).join(' | '));
  delete orig.resposta;
  s.avancar(HORA);
  const r2 = await s.scheduler.runRule(id);
  assert.equal(r2.offers, 1, 'voltou: sai sem ação do dono');
});

test('integração foco 1: o bloqueio de uma oferta vira 429 nas outras por 15 min no Etiqueta; mesmo depois disso, a veneno é a 1ª de toda execução', async (t) => {
  const velho = dia(1, 20); // 18 h antes
  const itens = Object.fromEntries([1, 2, 3, 4].map((i) => [asinDe(i), { titulo: unico(i), preco: 100, precoEm: velho, bloqueia: i === 1 }]));
  const s = montarIntegrado(t, { itens });
  const id = regraAmazon(s.db, { per: 2 });
  for (let i = 0; i < 5; i++) { await s.scheduler.runRule(id); s.avancar(2 * HORA); }
  assert.ok(s.wa.simulated.length > 0, `nada saiu em 5 execuções; pedidos: ${s.estado.pedidos.filter((p) => p.startsWith('POST')).join(', ')}`);
});

test('integração: a releitura do Turbo é só POST sem corpo e só com Authorization, e o token não aparece no Histórico nem no banco', async (t) => {
  const itens = { [asinDe(1)]: { titulo: unico(1), preco: 100, precoEm: dia(1, 8) } };
  const s = montarIntegrado(t, { itens });
  const chamadas = [];
  s.estado.espiao = (url, init) => chamadas.push({ url: String(url), init });
  const id = regraAmazon(s.db, { per: 1 });
  await s.scheduler.runRule(id);
  const posts = chamadas.filter((c) => c.init?.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].init.body, undefined);
  assert.deepEqual(Object.keys(posts[0].init.headers), ['Authorization']);
  assert.ok(!posts[0].url.includes(TOKEN_FALSO));
  const dump = JSON.stringify(s.logs(id)) + JSON.stringify(s.db.prepare('SELECT oferta FROM catalogo_itens').all()) + JSON.stringify(s.db.prepare('SELECT * FROM settings').all().filter((x) => x.key !== 'ext_token' && x.key !== 'pseudo_key'));
  assert.ok(!dump.includes(TOKEN_FALSO), 'o token nunca vai ao Histórico nem ao banco');
});

// ============================================================================ CA1.7, CA1.8, CA1.11, CA1.12 pela Amazon real

test('CA1.7/CA1.8: três causas diferentes de queda (indisponível, outro produto, preço subiu) e a vaga é reposta; a frase conta cada motivo', async (t) => {
  const s = montar(t, {
    catalogo: [1, 2, 3, 4, 5, 6].map((i) => doEtiqueta(i, 'amazon', { precoEm: dia(2, 13) })),
    releitura: (asin) => ({ [asinDe(1)]: { resultado: 'sem_preco' }, [asinDe(2)]: { resultado: 'outro_produto' }, [asinDe(3)]: confirmado(130, Date.now()) })[asin] ?? confirmado(100, Date.now()),
  });
  const id = regraCatalogo(s.db, { per: 2 });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages, r.descartadas], [2, 2, 3]);
  assert.deepEqual(s.saiu(), [unico(4), unico(5)], 'a 6ª nem é escolhida: as vagas encheram');
  assert.deepEqual(sairam(s, id), [], 'saiu o pedido todo: sem a frase');
  assert.deepEqual(s.pedidos.get(asinDe(6)), undefined, 'a 6ª não foi relida');
  assert.equal(r.porLoja.amazon.saiu, 2);
  assert.equal(r.porLoja.amazon.descartada, 3);
});

test('CA1.7: candidatas acabam antes das vagas — termina sem passar do que há e a frase diz "não havia mais ofertas novas"', async (t) => {
  const s = montar(t, {
    catalogo: [1, 2, 3].map((i) => doEtiqueta(i, 'amazon', { precoEm: dia(2, 13) })),
    releitura: (asin) => (asin === asinDe(1) ? { resultado: 'sem_preco' } : confirmado(100, Date.now())),
  });
  const id = regraCatalogo(s.db, { per: 5 });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.descartadas], [2, 1]);
  assert.deepEqual(sairam(s, id), ['Saíram 2 de 5 ofertas; 1 descartada (indisponível na loja); não havia mais ofertas novas dentro dos filtros.']);
});

test('CA1.12: a reposta passa pela trava de produto parecido — a que caiu NÃO barra a parecida; a que saiu barra a seguinte', async (t) => {
  const s = montar(t, {
    catalogo: [1, 2, 3, 4].map((i, n) => doEtiqueta(i, 'amazon', { precoEm: dia(2, 13), titulo: [FONE_A, FONE_B, FONE_AZUL, unico(9)][n] })),
    releitura: (asin) => (asin === asinDe(1) ? { resultado: 'outro_produto' } : confirmado(100, Date.now())),
  });
  const id = regraCatalogo(s.db, { per: 2 });
  const r = await s.scheduler.runRule(id);
  // A (Preto) cai fora → B (Branco, parecida de A) sai, porque A não saiu; C (Azul) é parecida de B (que saiu): barrada; D sai
  assert.deepEqual(s.saiu(), [FONE_B, unico(9)]);
  assert.deepEqual([r.offers, r.descartadas], [2, 1]);
  assert.ok(!s.saiu().includes(FONE_AZUL));
});

test('CA1.12: reposição respeita o teto por hora — 2 por hora, pedido de 3, a 1ª cai fora: saem 2, a execução para com a frase do teto, e na hora seguinte continua', async (t) => {
  const s = montar(t, {
    catalogo: [1, 2, 3, 4, 5, 6].map((i) => doEtiqueta(i, 'amazon', { precoEm: dia(2, 13) })),
    releitura: (asin) => (asin === asinDe(1) ? { resultado: 'sem_preco' } : confirmado(100, Date.now())),
  });
  setSetting(s.db, 'wa_limite_hora', '2');
  const id = regraCatalogo(s.db, { per: 3 });
  const r = await s.scheduler.runRule(id);
  assert.equal(r.parou, 'limite');
  assert.equal(s.wa.simulated.length, 2, 'nunca passa do teto de 2 por hora');
  const antes = s.pedidos.size;
  assert.ok(antes <= 4, 'a execução não chega a reler as que não poderia enviar: ' + antes);
  s.avancar(61 * MIN);
  const r2 = await s.scheduler.runRule(id);
  assert.ok(r2.offers >= 1 && s.wa.simulated.length <= 4, 'na hora seguinte o teto abre de novo e a regra continua');
});

test('CA1.12: reposição respeita o horário de silêncio — a oferta que sairia depois de começar o silêncio fica para depois', async (t) => {
  const s = montar(t, {
    agora: dia(2, 21, 59, 50),
    catalogo: [1, 2, 3].map((i) => doEtiqueta(i, 'amazon', { precoEm: dia(2, 21, 50) })),
    releitura: (asin) => (asin === asinDe(1) ? { resultado: 'sem_preco' } : confirmado(100, Date.now())),
  });
  setSetting(s.db, 'wa_silencio_ativo', '1'); setSetting(s.db, 'wa_silencio_de', '22:00'); setSetting(s.db, 'wa_silencio_ate', '07:00');
  const id = regraCatalogo(s.db, { per: 2 });
  // a conferência da 1ª passa da meia-noite do silêncio (22:00): a reposta não pode sair
  const orig = s.verificador.conferir.bind(s.verificador);
  s.verificador.conferir = async (...a) => { const r = await orig(...a); if (a[0].asin === asinDe(1)) s.avancar(30 * 1000); return r; };
  const r = await s.scheduler.runRule(id);
  assert.equal(s.wa.simulated.length, 0, 'em silêncio nada sai');
  assert.equal(r.parou, 'silencio');
});

test('CA1.11: Mercado Livre do catálogo com a extensão fora nunca sai sem conferência: pulada (sem revisão, sem sent_offers), e volta na seguinte', async (t) => {
  const s = montar(t, { catalogo: [doEtiqueta(1, 'ml')], loja: {} }); // a leitura do ML lança
  const id = regraCatalogo(s.db, { per: 1 });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.puladas, r.revisao], [0, 1, 0]);
  assert.deepEqual(enviadas(s.db, id), []);
  assert.deepEqual(itens(s.db, id), []);
  assert.ok(s.logs(id).some((l) => /^Pulada: não deu para conferir o preço .* O Mercado Livre não sai sem conferir/.test(l.message)));
  s.mlLoja.conferirProduto = async () => ({ price: 100, disponivel: true });
  s.avancar(HORA);
  const r2 = await s.scheduler.runRule(id);
  assert.equal(r2.offers, 1);
});

test('CA1.11: com a API da Amazon ligada a releitura nunca é chamada e o Etiqueta nem é perguntado', async (t) => {
  const s = montar(t, { catalogo: [doEtiqueta(1, 'amazon', { precoEm: dia(1, 1) })] });
  const comApi = { ...s.amazon, configurado: () => true, lerItem: async () => ({ price: 100, disponivel: true, discountPct: 33, oldPrice: 150 }), montarLink: s.amazon.montarLink };
  const etiquetaQueNaoDeviaSerChamada = { confirmarPreco: async () => { throw new Error('não podia chamar'); } };
  const verif = createVerificador({ db: s.db, amazon: comApi, catalogo: etiquetaQueNaoDeviaSerChamada });
  const r = await verif.conferir({ key: 'ASIN:' + asinDe(1), loja: 'amazon', asin: asinDe(1), price: 100, title: 'x' }, { lidoEm: null, releitura: { precoEm: dia(1, 1) } });
  assert.equal(r.acao, 'enviar');
  assert.equal(r.conferido, true);
});

test('CA1.10 (via regra): o item que a migração tirou da revisão volta como candidato e é conferido de novo, não fica "queimado"', async (t) => {
  const s = montar(t, { catalogo: [doEtiqueta(1, 'amazon', { precoEm: dia(2, 13) })], releitura: { [asinDe(1)]: confirmado(100, Date.now()) } });
  const id = regraCatalogo(s.db, { per: 1 });
  s.db.prepare("INSERT INTO catalogo_itens (rule_id, chave, loja, status, motivos, oferta, criado_em) VALUES (?, ?, 'amazon', 'revisao', ?, '{}', ?)").run(id, 'ASIN:' + asinDe(1), JSON.stringify(['nao_conferido']), Date.now());
  // simula a migração: apaga o que a migração apagaria
  s.db.prepare("DELETE FROM catalogo_itens WHERE status = 'revisao' AND motivos = '[\"nao_conferido\"]'").run();
  const r = await s.scheduler.runRule(id);
  assert.equal(r.offers, 1);
});

// ====================================================================================== CA1.9 pelo servidor (HTTP de verdade)

function subirServidor() {
  const dir = tmp(); const db = openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const s = criarServicos({ db, wa, links, fast: true, dir, fetch: async () => { throw new Error('rede proibida'); }, verificar: true });
  const app = buildApp({ db, wa, links, scheduler: s.scheduler, amazon: s.amazon, shopee: s.shopee, catalogo: s.catalogo, catalogoItens: s.catalogoItens, publicHost: null, panelPassword: '' });
  return new Promise((ok) => {
    const server = app.listen(0, '127.0.0.1', () => ok({ db, port: server.address().port, fechar: () => new Promise((r) => { s.scheduler.stop?.(); server.closeAllConnections?.(); server.close(() => { db.close(); r(); }); }) }));
  });
}
function pedir(port, caminho, { method = 'GET', body } = {}) {
  return new Promise((ok, err) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, path: caminho, method, headers: { host: `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let txt = ''; res.setEncoding('utf8'); res.on('data', (c) => (txt += c)); res.on('end', () => ok({ status: res.statusCode, txt }));
    });
    r.on('error', err); if (data) r.write(data); r.end();
  });
}
const avisosDoVerificador = (db) => db.prepare("SELECT message FROM log WHERE message LIKE 'Verificador %' ORDER BY id").all().map((l) => l.message);

test('CA1.9: valor que não é booleano (texto, número, lista) é recusado com 400 e não liga, não desliga nem grava linha', async (t) => {
  const s = await subirServidor(); t.after(s.fechar);
  for (const v of ['false', 'true', 0, 1, [], {}, 'desligado']) {
    const r = await pedir(s.port, '/api/ajustes', { method: 'PUT', body: { verificador_ativo: v } });
    assert.equal(r.status, 400, JSON.stringify(v));
  }
  assert.deepEqual(avisosDoVerificador(s.db), []);
  assert.equal(getSetting(s.db, 'verificador_ativo'), null, 'o padrão (ligado) segue sem nada gravado');
});

test('CA1.9: ligar e desligar em sequência rápida gravam uma linha cada, na ordem; o estado final é o último pedido', async (t) => {
  const s = await subirServidor(); t.after(s.fechar);
  const bool = [false, true, false, true, true, false];
  for (const v of bool) assert.equal((await pedir(s.port, '/api/ajustes', { method: 'PUT', body: { verificador_ativo: v } })).status, 200);
  assert.deepEqual(avisosDoVerificador(s.db), [AVISO_VERIFICADOR_DESLIGADO, AVISO_VERIFICADOR_LIGADO, AVISO_VERIFICADOR_DESLIGADO, AVISO_VERIFICADOR_LIGADO, AVISO_VERIFICADOR_DESLIGADO]);
  assert.equal(getSetting(s.db, 'verificador_ativo'), '0');
});

test('CA1.9: um pedido que falha por OUTRO campo (retenção fora da faixa) não deixa o verificador ligado/desligado e a linha no Histórico', async (t) => {
  const s = await subirServidor(); t.after(s.fechar);
  const r = await pedir(s.port, '/api/ajustes', { method: 'PUT', body: { verificador_ativo: false, retencao_dias: 99999 } });
  assert.equal(r.status, 400);
  assert.equal(getSetting(s.db, 'verificador_ativo'), null, 'pedido recusado não muda o estado');
  assert.deepEqual(avisosDoVerificador(s.db), [], 'pedido recusado não grava linha de "desligado"');
});

test('foco 7: lerPrecoEm no buraco do horário de verão (a hora que não existe no relógio local) não inventa um instante', (t) => {
  const tzAntes = process.env.TZ;
  process.env.TZ = 'America/New_York';
  t.after(() => { if (tzAntes === undefined) delete process.env.TZ; else process.env.TZ = tzAntes; });
  assert.equal(lerPrecoEm('2026-03-08T02:30:00'), null, 'às 02:30 de 08/03 não existiu em Nova York');
  assert.equal(typeof lerPrecoEm('2026-03-08T03:30:00'), 'number');
  assert.equal(typeof lerPrecoEm('2026-11-01T01:30:00'), 'number', 'a hora repetida do fim do horário de verão tem um instante');
});

// =============================================================================== RODADA 2: freio da releitura (R1), Q1, S1, S2, R4, Q2
//
// Etiqueta falso que imita o `FreioReleitura` de servidor.py (etiqueta-wt-e1): uma leitura por vez, 3 s entre o início de duas,
// 60 por hora, 15 min de pausa depois de `bloqueado` e recusa enquanto uma rodada da Amazon corre. Fala o contrato v1 por fetch
// (cliente REAL createCatalogo) e usa o `Date` simulado como relógio; a espera do cliente (`esperar`) avança esse relógio, então
// nenhum teste dorme de verdade.

/**
 * `estado.itens`: ASIN → { titulo, preco, precoEm (ms), categoria?, leitura? }. `leitura`: 'ok' (padrão), 'preco_subiu', 'sem_preco',
 * 'outro_produto', 'bloqueado', 'falha_rede' ou função (asin) → corpo JSON do 200. `estado.forcar(asin, n)` → null ou um 429 à força
 * { motivo, segundos?, corpo?, cabecalhos? } (corpo: texto cru, ou null para vazio). `estado.captcha`: toda leitura dá `bloqueado`.
 * `estado.rodadaLivre = false`: uma rodada da Amazon segura a trava. Registros: leituras (as que passaram), recusas (motivos), posts
 * (todo POST recebido), esperas (ms que o cliente esperou), maxEmCurso.
 */
function etiquetaComFreio(estado) {
  const freio = { ocupado: false, inicios: [], pausaAte: null };
  Object.assign(estado, { leituras: [], recusas: [], posts: 0, esperas: [], emCurso: 0, maxEmCurso: 0, porAsin: new Map() });
  const seg = (ms) => Math.max(1, Math.ceil(ms / 1000));
  const json = (status, corpo, cab = {}) => new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...cab } });
  const reservar = () => {
    const agora = Date.now();
    if (freio.ocupado) return ['ocupado', 3];
    if (freio.pausaAte != null && agora < freio.pausaAte) return ['pausa', seg(freio.pausaAte - agora)];
    while (freio.inicios.length && freio.inicios[0] <= agora - HORA) freio.inicios.shift();
    const ultimo = freio.inicios.at(-1);
    if (ultimo != null && agora - ultimo < 3000) return ['intervalo', seg(ultimo + 3000 - agora)];
    if (freio.inicios.length >= 60) return ['teto', seg(freio.inicios[0] + HORA - agora)];
    if (estado.rodadaLivre === false) return ['rodada', 60];
    freio.ocupado = true; freio.inicios.push(agora);
    return null;
  };
  const recusa = (motivo, segundos) => {
    estado.recusas.push(motivo);
    return json(429, { versao: 1, resultado: 'freio', motivo, tentar_em_s: segundos }, { 'Retry-After': String(segundos) });
  };
  estado.preencherFreio = (n, antesMs = 1800000) => { for (let i = 0; i < n; i++) freio.inicios.push(Date.now() - antesMs + i); };
  return async (url, init = {}) => {
    const u = new URL(String(url));
    const h = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    if (h.authorization !== `Bearer ${TOKEN_FALSO}`) return json(401, { error: 'token ausente ou inválido' });
    if ((init.method ?? 'GET') === 'GET' && u.pathname === '/api/v1/ofertas') {
      const maxH = Number(u.searchParams.get('preco_max_horas') ?? 48);
      const cats = u.searchParams.getAll('cat');
      const ofertas = Object.entries(estado.itens)
        .filter(([, i]) => Date.now() - i.precoEm <= maxH * HORA && (!cats.length || cats.includes(i.categoria ?? 'Casa')))
        .map(([asin, i], n) => ({ id: n + 1, loja: 'amazon', item_id: asin, titulo: i.titulo, preco: i.preco, preco_antigo: i.preco + 50, desconto_pct: 33,
          preco_em: precoEmTexto(i.precoEm), categoria: i.categoria ?? 'Casa', link: `https://www.amazon.com.br/dp/${asin}?tag=terceiro-20`, imagem: '', criado_em: '2026-11-01T10:00:00', atualizado_em: '2026-11-01T10:00:00' }));
      return json(200, { versao: 1, ofertas, proximo: null, total: ofertas.length });
    }
    const m = /^\/api\/v1\/amazon\/([A-Z0-9]{10})\/confirmar-preco$/.exec(u.pathname);
    if (init.method !== 'POST' || !m) return json(404, { error: 'rota não encontrada' });
    const asin = m[1];
    estado.posts++;
    const n = (estado.porAsin.get(asin) ?? 0) + 1; estado.porAsin.set(asin, n);
    const item = estado.itens[asin];
    if (!item) return json(404, { error: 'oferta da Amazon não encontrada' });
    const forcado = estado.forcar?.(asin, n);
    if (forcado) {
      estado.recusas.push(forcado.motivo);
      if (forcado.corpo === undefined) return recusa(forcado.motivo, forcado.segundos ?? 3);
      return new Response(forcado.corpo, { status: 429, headers: forcado.cabecalhos ?? {} });
    }
    const negado = reservar();
    if (negado) return recusa(...negado);
    estado.emCurso++; estado.maxEmCurso = Math.max(estado.maxEmCurso, estado.emCurso);
    await new Promise((ok) => { setImmediate(ok); }); // a leitura "demora": quem não está na fila esbarraria em `ocupado`
    let resultado = 'confirmado';
    try {
      const modo = estado.captcha ? 'bloqueado' : (item.leitura ?? 'ok');
      estado.leituras.push(asin);
      if (typeof modo === 'function') { const corpo = modo(asin); resultado = corpo.resultado; return json(200, corpo); }
      if (['sem_preco', 'outro_produto', 'bloqueado', 'falha_rede'].includes(modo)) { resultado = modo; return json(200, { versao: 1, resultado: modo }); }
      const preco = modo === 'preco_subiu' ? Math.round(item.preco * 1.3 * 100) / 100 : item.preco;
      item.precoEm = Date.now();
      return json(200, { versao: 1, resultado: 'confirmado', preco, preco_antigo: preco + 50, desconto_pct: 33, preco_em: precoEmTexto(item.precoEm) });
    } finally {
      estado.emCurso--;
      freio.ocupado = false;
      if (resultado === 'bloqueado') freio.pausaAte = Date.now() + 15 * MIN;
    }
  };
}

/** Como montarIntegrado, com o Etiqueta que tem freio e a espera do cliente ligada ao relógio simulado. */
function montarFreio(t, { agora = dia(2, 14), itens, extra = {} } = {}) {
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ['Date'], now: agora });
  const dir = tmp(); const db = openDb(dir);
  const tokenPath = path.join(dir, 'api_token.txt');
  fs.writeFileSync(tokenPath, `${TOKEN_FALSO}\n`, { mode: 0o600 });
  const estado = { itens, ...extra };
  const fetchFalso = etiquetaComFreio(estado);
  const esperar = async (ms) => { estado.esperas.push(ms); if (estado.esperaAvanca !== false) t.mock.timers.setTime(Date.now() + ms); };
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const amazon = createAmazon({ db, fetch: async () => { throw new Error('rede proibida (Amazon)'); }, esperar: async () => {}, lerConexao: () => ({ tag: 'achadinho-20' }) });
  const catalogo = createCatalogo({ db, fetch: fetchFalso, lerConexao: () => ({ endereco: 'http://127.0.0.1:8765', caminho_token: tokenPath }), esperar });
  const catalogoItens = createCatalogoItens({ db, wa, links, amazon });
  const verificador = createVerificador({ db, amazon, catalogo });
  const scheduler = createScheduler({ db, wa, links, fast: true, amazon, verificador, catalogo, catalogoItens });
  db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run('111@g.us', 'Achadinhos', 10, Date.now());
  db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etiquetaA', Date.now());
  const logs = (id) => db.prepare('SELECT level, offer_title, message FROM log WHERE rule_id = ? ORDER BY id').all(id).map((l) => ({ ...l }));
  const avancar = (ms) => t.mock.timers.setTime(Date.now() + ms);
  return { db, wa, scheduler, estado, logs, avancar, verificador, catalogo, dir };
}
const regraAmazonCat = (db, { per = 2, categorias = [], nome = 'Amazon', intervalo = 60 } = {}) => Number(db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id,
  group_jids, source_type, source_config, sources, per_run, interval_min, window_start, window_end, dedupe_days, send_image, created_at)
  VALUES (?, 1, 1, 1, ?, 'list', '{}', ?, ?, ?, '00:00', '23:59', 7, 0, ?)`)
  .run(nome, JSON.stringify(['111@g.us']), JSON.stringify([{ type: 'catalogo', tag_id: null, config: { ordem: 'relevancia', lojas: ['amazon'], ...(categorias.length ? { categorias } : {}) } }]), per, intervalo, Date.now()).lastInsertRowid);
const itensVelhos = (indices, { precoEm = dia(1, 20), leitura = {}, categoria = 'Casa', preco = 100 } = {}) =>
  Object.fromEntries(indices.map((i) => [asinDe(i), { titulo: unico(i), preco, precoEm, categoria, leitura: leitura[i] ?? 'ok' }]));
const textosEnviados = (s) => s.wa.simulated.map((m) => m.text.split('\n')[0].replace(/^\*|\*$/g, ''));
const mensagens = (s, id) => s.logs(id).map((l) => l.message);

// ------------------------------------------------------------------------------------------------------------ R1

test('R1: várias Amazon de preço velho, três caem (preço subiu, indisponível) — as outras relidas, uma depois da outra, preenchem as vagas', async (t) => {
  const lista = itensVelhos([1, 2, 3, 4, 5, 6], { leitura: { 1: 'preco_subiu', 2: 'preco_subiu', 3: 'sem_preco' } });
  const s = montarFreio(t, { itens: lista });
  const id = regraAmazonCat(s.db, { per: 3 });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.descartadas, r.puladas, r.revisao], [3, 3, 0, 0], mensagens(s, id).join(' | '));
  assert.deepEqual(textosEnviados(s).sort(), [unico(4), unico(5), unico(6)].sort());
  assert.deepEqual(s.estado.leituras, [1, 2, 3, 4, 5, 6].map(asinDe), 'seis leituras de verdade, na ordem');
  assert.ok(s.estado.recusas.length >= 5 && s.estado.recusas.every((m) => m === 'intervalo'), `o freio de 3 s recusou e o cliente esperou: ${s.estado.recusas}`);
  assert.ok(s.estado.esperas.every((ms) => ms >= 1000 && ms <= 3000), `esperas: ${s.estado.esperas}`);
  assert.equal(s.estado.maxEmCurso, 1, 'nunca duas leituras ao mesmo tempo');
  assert.deepEqual(enviadas(s.db, id).sort(), [4, 5, 6].map((i) => 'ASIN:' + asinDe(i)).sort());
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM catalogo_itens WHERE status = 'revisao'").get().n, 0);
  assert.ok(mensagens(s, id).some((m) => /Descartada: preço subiu/.test(m)) && mensagens(s, id).some((m) => /Descartada: indisponível/i.test(m)), mensagens(s, id).join(' | '));
});

test('R1: sem esperar o freio (esperar não avança o relógio) as leituras seguintes seriam recusadas — o teste só passa porque o cliente espera de verdade', async (t) => {
  const lista = itensVelhos([1, 2, 3]);
  const s = montarFreio(t, { itens: lista, extra: { esperaAvanca: false } });
  const id = regraAmazonCat(s.db, { per: 3 });
  const r = await s.scheduler.runRule(id);
  // controle do harness: a 1ª lê; a 2ª e a 3ª esbarram no `intervalo` (3 s) mesmo depois de duas esperas que não passaram o tempo
  assert.equal(s.estado.leituras.length, 1);
  assert.equal(r.offers, 1);
  assert.ok(s.estado.esperas.length >= 2);
});

test('R1: duas regras no mesmo tick (laço real do agendador) — as duas preenchem as vagas pela mesma fila, sem `ocupado`', async (t) => {
  const lista = { ...itensVelhos([1, 2, 3], { categoria: 'A', leitura: { 1: 'sem_preco' } }), ...itensVelhos([4, 5, 6], { categoria: 'B', leitura: { 4: 'preco_subiu' } }) };
  const s = montarFreio(t, { itens: lista });
  const a = regraAmazonCat(s.db, { per: 2, categorias: ['A'], nome: 'A' });
  const b = regraAmazonCat(s.db, { per: 2, categorias: ['B'], nome: 'B' });
  await s.scheduler.tick();
  assert.deepEqual(enviadas(s.db, a).sort(), [2, 3].map((i) => 'ASIN:' + asinDe(i)), mensagens(s, a).join(' | '));
  assert.deepEqual(enviadas(s.db, b).sort(), [5, 6].map((i) => 'ASIN:' + asinDe(i)), mensagens(s, b).join(' | '));
  assert.ok(!s.estado.recusas.includes('ocupado'), `recusas: ${s.estado.recusas}`);
  assert.equal(s.estado.maxEmCurso, 1);
});

test('R1: duas regras ao mesmo tempo (runRule em paralelo) — a fila única serializa as leituras e as duas saem completas', async (t) => {
  const lista = { ...itensVelhos([1, 2, 3], { categoria: 'A', leitura: { 1: 'sem_preco' } }), ...itensVelhos([4, 5, 6], { categoria: 'B', leitura: { 4: 'preco_subiu' } }) };
  const s = montarFreio(t, { itens: lista });
  const a = regraAmazonCat(s.db, { per: 2, categorias: ['A'], nome: 'A' });
  const b = regraAmazonCat(s.db, { per: 2, categorias: ['B'], nome: 'B' });
  const [ra, rb] = await Promise.all([s.scheduler.runRule(a), s.scheduler.runRule(b)]);
  assert.deepEqual([ra.offers, rb.offers], [2, 2]);
  assert.ok(!s.estado.recusas.includes('ocupado'), `recusas: ${s.estado.recusas}`);
  assert.equal(s.estado.maxEmCurso, 1);
});

test('R1: 429 `intervalo` com espera curta e depois 200 — uma espera de `tentar_em_s` e a oferta sai (sem pausar a releitura)', async (t) => {
  const s = montarFreio(t, { itens: itensVelhos([1, 2]), extra: { forcar: (asin, n) => (n === 1 ? { motivo: 'intervalo', segundos: 2 } : null) } });
  const id = regraAmazonCat(s.db, { per: 2 });
  const r = await s.scheduler.runRule(id);
  assert.equal(r.offers, 2);
  assert.ok(s.estado.esperas.includes(2000), `esperas: ${s.estado.esperas}`);
});

// 429 que PAUSA a releitura: `corpo` (texto cru, ou undefined → o padrão do Etiqueta com `segundos`), cabecalhos, e quanto a pausa deve durar.
const MIN10 = 10 * MIN;
const casosDePausa = [
  ['teto com tentar_em_s 120', { motivo: 'teto', segundos: 120 }, 120000],
  ['pausa com tentar_em_s 900', { motivo: 'pausa', segundos: 900 }, 900000],
  ['rodada com tentar_em_s 60', { motivo: 'rodada', segundos: 60 }, 60000],
  ['teto com tentar_em_s enorme (1e9) → no máximo 1 h', { motivo: 'teto', segundos: 1e9 }, HORA],
  ['teto com tentar_em_s 1e20 (não é inteiro seguro) → 10 min', { motivo: 'teto', corpo: '{"versao":1,"resultado":"freio","motivo":"teto","tentar_em_s":1e20}' }, MIN10],
  ['teto com tentar_em_s 0 → 10 min', { motivo: 'teto', segundos: 0 }, MIN10],
  ['teto com tentar_em_s negativo → 10 min', { motivo: 'teto', segundos: -30 }, MIN10],
  ['teto com tentar_em_s fracionário → 10 min', { motivo: 'teto', corpo: '{"versao":1,"resultado":"freio","motivo":"teto","tentar_em_s":2.5}' }, MIN10],
  ['teto com tentar_em_s em texto → 10 min', { motivo: 'teto', corpo: '{"versao":1,"resultado":"freio","motivo":"teto","tentar_em_s":"120"}' }, MIN10],
  ['teto com tentar_em_s ausente → 10 min', { motivo: 'teto', corpo: '{"versao":1,"resultado":"freio","motivo":"teto"}' }, MIN10],
  ['teto sem o corpo, só Retry-After 90', { motivo: 'teto', corpo: null, cabecalhos: { 'Retry-After': '90' } }, 90000],
  ['teto com tentar_em_s inválido e Retry-After 45 → usa o cabeçalho', { motivo: 'teto', corpo: '{"versao":1,"resultado":"freio","motivo":"teto","tentar_em_s":-1}', cabecalhos: { 'Retry-After': '45' } }, 45000],
  ['429 sem corpo e sem cabeçalho → 10 min', { motivo: 'desconhecido', corpo: null }, MIN10],
  ['429 com HTML → 10 min', { motivo: 'desconhecido', corpo: '<html><body>Too Many Requests</body></html>' }, MIN10],
  ['429 com JSON de outra versão → 10 min', { motivo: 'desconhecido', corpo: '{"versao":2,"resultado":"freio","motivo":"teto","tentar_em_s":30}' }, MIN10],
  ['429 com lista no corpo → 10 min', { motivo: 'desconhecido', corpo: '[1,2,3]' }, MIN10],
  ['429 com null no corpo → 10 min', { motivo: 'desconhecido', corpo: 'null' }, MIN10],
  ['429 com motivo desconhecido e tentar_em_s 30 → pausa pelo tentar_em_s', { motivo: 'desconhecido', corpo: '{"versao":1,"resultado":"freio","motivo":"inventado","tentar_em_s":30}' }, 30000],
  ['429 com corpo de 10 KiB → 10 min', { motivo: 'desconhecido', corpo: `{"versao":1,"resultado":"freio","motivo":"teto","tentar_em_s":30,"x":"${'a'.repeat(10240)}"}` }, MIN10],
  ['intervalo com tentar_em_s 100 (não é espera curta) → 10 min? não: intervalo não pausa', null, 0],
];
for (const [nome, freioForcado, pausaMs] of casosDePausa) {
  if (!freioForcado) continue;
  test(`R1: ${nome} — pula sem revisão e a releitura só volta depois da pausa`, async (t) => {
    const s = montarFreio(t, { itens: itensVelhos([1]), extra: { forcar: (asin, n) => (n === 1 ? freioForcado : null) } });
    const id = regraAmazonCat(s.db, { per: 1 });
    const r = await s.scheduler.runRule(id);
    assert.deepEqual([r.offers, r.puladas, r.revisao], [0, 1, 0], mensagens(s, id).join(' | '));
    assert.deepEqual(enviadas(s.db, id), []);
    assert.deepEqual(itens(s.db, id), []);
    assert.deepEqual(s.estado.esperas, [], 'motivo que pausa não espera dentro da fila');
    assert.equal(s.estado.posts, 1);
    s.avancar(pausaMs - 1000);
    await s.scheduler.runRule(id);
    assert.equal(s.estado.posts, 1, `1 s antes do fim da pausa (${pausaMs / 1000} s) o Etiqueta ainda não é perguntado`);
    s.avancar(2000);
    const r3 = await s.scheduler.runRule(id);
    assert.equal(s.estado.posts, 2, '1 s depois do fim da pausa a releitura volta');
    assert.equal(r3.offers, 1, 'e a oferta sai (o Etiqueta já deixa ler)');
  });
}

test('R1: 429 `intervalo` ou `ocupado` com espera longa (tentar_em_s 100) ou sem o campo — não espera, não pausa a releitura; a oferta é pulada sem 6 h de pausa', async (t) => {
  for (const corpo of [{ motivo: 'intervalo', segundos: 100 }, { motivo: 'intervalo', corpo: '{"versao":1,"resultado":"freio","motivo":"intervalo"}' }, { motivo: 'ocupado', segundos: 0 }]) {
    const s = montarFreio(t, { itens: itensVelhos([1, 2]), extra: { forcar: (asin, n) => (asin === asinDe(1) && n === 1 ? corpo : null) } });
    const id = regraAmazonCat(s.db, { per: 1 });
    const r = await s.scheduler.runRule(id);
    assert.deepEqual(s.estado.esperas, [], JSON.stringify(corpo));
    assert.equal(r.offers, 1, `${JSON.stringify(corpo)}: a vaga vai à 2ª, que é lida na mesma execução (sem pausa da releitura)`);
    assert.deepEqual(enviadas(s.db, id), ['ASIN:' + asinDe(2)]);
    // a 1ª não ficou 6 h fora: na execução seguinte ela volta a ser escolhida
    s.avancar(HORA);
    await s.scheduler.runRule(id);
    assert.ok(s.estado.porAsin.get(asinDe(1)) >= 2, `${JSON.stringify(corpo)}: a oferta que esbarrou no freio curto volta na execução seguinte`);
  }
});

test('R1: `ocupado` que não acaba — cada oferta escolhida custa 2 esperas de 3 s e vira "Pulada"; a execução é limitada pelo teto de escolhidas e nada vai à revisão', async (t) => {
  const s = montarFreio(t, { itens: itensVelhos([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), extra: { forcar: () => ({ motivo: 'ocupado', segundos: 3 }) } });
  const id = regraAmazonCat(s.db, { per: 2 });
  const antes = s.logs(id).length;
  const r = await s.scheduler.runRule(id);
  const tentadas = r.puladas;
  assert.equal(r.offers, 0);
  assert.equal(tentadas, 8, 'no máximo 4× as vagas (2 × (1 + 3))');
  assert.equal(s.estado.posts, tentadas * 3, 'três pedidos por oferta (1 + 2 novas tentativas)');
  assert.equal(s.estado.esperas.length, tentadas * 2);
  assert.ok(s.estado.esperas.every((ms) => ms === 3000));
  const esperaTotalS = s.estado.esperas.reduce((a, b) => a + b, 0) / 1000;
  assert.equal(esperaTotalS, 48, 'pior caso desta regra: 48 s presos esperando, sem contar a leitura');
  assert.deepEqual(enviadas(s.db, id), []);
  assert.deepEqual(itens(s.db, id), []);
  const linhas = s.logs(id).slice(antes);
  assert.ok(linhas.length <= 10, `linhas gravadas: ${linhas.length}`);
  assert.ok(linhas.filter((l) => l.message.startsWith('Pulada')).length === 8);
  assert.ok(linhas.every((l) => /Etiqueta estava ocupado/.test(l.message) || !l.message.startsWith('Pulada')), linhas.map((l) => l.message).join(' | '));
  // não pausou a releitura: a execução seguinte tenta de novo (e de novo gasta o mesmo)
  s.avancar(HORA);
  const postsAntes = s.estado.posts;
  await s.scheduler.runRule(id);
  assert.ok(s.estado.posts > postsAntes);
});

test('R1: teto por hora do Etiqueta (60 leituras) — a Amazon de preço velho espera pelo `tentar_em_s`, a de preço visto há 2 h sai pela reserva, e a releitura volta quando o Etiqueta deixa', async (t) => {
  const lista = { ...itensVelhos([1]), ...itensVelhos([2], { precoEm: dia(2, 12) }) }; // 1: 18 h; 2: 2 h
  const s = montarFreio(t, { itens: lista });
  s.estado.preencherFreio(60, 1800000); // 60 leituras iniciadas entre 30 min atrás: a próxima só em 30 min
  const id = regraAmazonCat(s.db, { per: 1 });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual(s.estado.recusas, ['teto']);
  assert.equal(r.offers, 1, mensagens(s, id).join(' | '));
  assert.deepEqual(enviadas(s.db, id), ['ASIN:' + asinDe(2)], 'a da reserva');
  assert.match(s.wa.simulated[0].text, /Cadeira Gamer/);
  s.avancar(29 * MIN);
  await s.scheduler.runRule(id);
  assert.equal(s.estado.posts, 1, 'dentro dos 30 min do tentar_em_s: sem novo pedido');
  s.avancar(2 * MIN);
  const r2 = await s.scheduler.runRule(id);
  assert.equal(r2.offers, 1, 'passados os 30 min a velha é relida e sai');
  assert.deepEqual(s.estado.leituras, [asinDe(1)]);
});

test('R1: rodada da Amazon no ar (429 `rodada`, 60 s) — pausa curta; a releitura volta sozinha 1 min depois', async (t) => {
  const s = montarFreio(t, { itens: itensVelhos([1, 2]), extra: { rodadaLivre: false } });
  const id = regraAmazonCat(s.db, { per: 1 });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual(s.estado.recusas, ['rodada']);
  assert.equal(r.offers, 0);
  assert.deepEqual(enviadas(s.db, id), []);
  s.estado.rodadaLivre = true;
  s.avancar(61 * 1000);
  const r2 = await s.scheduler.runRule(id);
  assert.equal(r2.offers, 1);
});

// --------------------------------------------------------------------------------------- Q1/R2: bloqueio de verdade (captcha geral)

test('Q1/R2: captcha geral da Amazon por 8 execuções espaçadas — uma oferta por execução vai à pausa de 6 h, nada vai à revisão nem sai, e a regra volta a enviar quando o bloqueio acaba', async (t) => {
  const lista = itensVelhos(Array.from({ length: 16 }, (_, i) => i + 1));
  const s = montarFreio(t, { itens: lista, extra: { captcha: true } });
  const id = regraAmazonCat(s.db, { per: 2 });
  const foraPorExecucao = []; const leiturasPorExecucao = [];
  for (let i = 0; i < 8; i++) {
    const antes = s.logs(id).length; const lidasAntes = s.estado.leituras.length;
    const r = await s.scheduler.runRule(id);
    assert.equal(r.offers, 0);
    foraPorExecucao.push(s.logs(id).slice(antes).filter((l) => /Fica 6 h fora da escolha desta regra\.$/.test(l.message)).length);
    leiturasPorExecucao.push(s.estado.leituras.length - lidasAntes);
    s.avancar(HORA);
  }
  assert.deepEqual(foraPorExecucao, Array(8).fill(1), 'exatamente 1 oferta por execução vai à pausa de 6 h (a que a Amazon bloqueou agora)');
  assert.deepEqual(leiturasPorExecucao, Array(8).fill(1), 'e o Etiqueta é perguntado uma vez só por execução (não martela a Amazon)');
  assert.deepEqual(enviadas(s.db, id), []);
  assert.deepEqual(itens(s.db, id).length ? itens(s.db, id) : [], [], 'nada na revisão nem em catalogo_itens');
  assert.equal(s.logs(id).filter((l) => l.level === 'erro').length, 0);
  // o bloqueio acaba: a próxima execução já envia (as 1 a 2 estão em pausa, as demais não)
  s.estado.captcha = false;
  const r = await s.scheduler.runRule(id);
  assert.equal(r.offers, 2, mensagens(s, id).slice(-4).join(' | '));
  assert.equal(enviadas(s.db, id).length, 2);
});

test('Q1/R2: captcha geral com execuções a cada 12 min — o freio de 15 min do Etiqueta recusa (429 pausa) sem virar pausa de 6 h; a pausa de 6 h só vem da leitura que a Amazon bloqueou de fato', async (t) => {
  const lista = itensVelhos([1, 2, 3, 4]);
  const s = montarFreio(t, { itens: lista, extra: { captcha: true } });
  const id = regraAmazonCat(s.db, { per: 2 });
  const postsPorExecucao = [];
  for (let i = 0; i < 4; i++) { const antes = s.estado.posts; await s.scheduler.runRule(id); postsPorExecucao.push(s.estado.posts - antes); s.avancar(12 * MIN); }
  assert.ok(postsPorExecucao.every((n) => n <= 1), `no máximo 1 pedido ao Etiqueta por execução: ${postsPorExecucao}`);
  assert.deepEqual(s.estado.leituras, [1, 2].map(asinDe), 'leituras de verdade: às 0 min e às 24 min (a de 12 min bateu na pausa do Etiqueta)');
  assert.ok(s.estado.recusas.includes('pausa'));
  assert.deepEqual(enviadas(s.db, id), []);
  assert.equal(s.logs(id).filter((l) => /Fica 6 h fora/.test(l.message)).length, 2, 'só as duas leituras bloqueadas de verdade foram para a pausa de 6 h');
  s.avancar(7 * HORA); // as pausas de 6 h acabaram e o captcha também
  s.estado.captcha = false;
  const r = await s.scheduler.runRule(id);
  assert.equal(r.offers, 2);
});

test('Q1/R2: a veneno com a reserva válida (preço visto há 2 h) sai pela reserva e NÃO vai à pausa de 6 h — `releu` só vale quando a oferta não sai', async (t) => {
  const lista = { ...itensVelhos([1], { precoEm: dia(2, 12), leitura: { 1: 'bloqueado' } }), ...itensVelhos([2, 3]) };
  const s = montarFreio(t, { itens: lista });
  const id = regraAmazonCat(s.db, { per: 1 });
  const r = await s.scheduler.runRule(id);
  assert.equal(r.offers, 1);
  assert.deepEqual(enviadas(s.db, id), ['ASIN:' + asinDe(1)]);
  assert.ok(!mensagens(s, id).some((m) => /Fica 6 h fora/.test(m)), mensagens(s, id).join(' | '));
});

test('Q1/R2: `falha_rede` da página (Etiqueta não alcançou a Amazon) também tira a oferta da escolha por 6 h; `fora_do_ar` do Etiqueta não', async (t) => {
  const s = montarFreio(t, { itens: itensVelhos([1, 2], { leitura: { 1: 'falha_rede' } }) });
  const id = regraAmazonCat(s.db, { per: 1 });
  await s.scheduler.runRule(id);
  assert.ok(mensagens(s, id).some((m) => /Fica 6 h fora da escolha desta regra\.$/.test(m)), mensagens(s, id).join(' | '));
  const s2 = montarFreio(t, { itens: itensVelhos([1, 2]) });
  s2.estado.itens[asinDe(1)].leitura = () => { throw new TypeError('fetch'); };
  s2.estado.captcha = false;
  const id2 = regraAmazonCat(s2.db, { per: 1 });
  const ant = s2.estado.itens;
  void ant;
  await s2.scheduler.runRule(id2); // a leitura em função lança dentro do fetch falso → o cliente vê fora_do_ar
  assert.ok(!mensagens(s2, id2).some((m) => /Fica 6 h fora/.test(m)), mensagens(s2, id2).join(' | '));
});

// ------------------------------------------------------------------------------------------------------------ S2: preco_em

const confirmadoComPrecoEm = (ms, preco = 90) => (asin) => ({ versao: 1, resultado: 'confirmado', preco, preco_antigo: preco + 50, desconto_pct: 35, preco_em: precoEmTexto(ms) });
const PRAZO = 20000;
const casosPrecoEm = [
  ['agora', () => Date.now(), true],
  ['no limite de baixo (prazo + 1 min)', () => Date.now() - (PRAZO + 60000), true],
  ['1 s além do limite de baixo', () => Date.now() - (PRAZO + 61000), false],
  ['3 dias atrás', () => Date.now() - 72 * HORA, false],
  ['no limite de cima (+5 min)', () => Date.now() + 5 * MIN, true],
  ['1 s além do limite de cima', () => Date.now() + 5 * MIN + 1000, false],
  ['1 hora no futuro', () => Date.now() + HORA, false],
];
for (const [nome, quando, vale] of casosPrecoEm) {
  test(`S2: confirmado com preco_em ${nome} — ${vale ? 'vale e sai com o preço lido' : 'é resposta inesperada: pula (sem revisão) quando o preço da lista é velho'}`, async (t) => {
    const lista = itensVelhos([1], { leitura: { 1: (asin) => confirmadoComPrecoEm(quando())(asin) } });
    const s = montarFreio(t, { itens: lista });
    const id = regraAmazonCat(s.db, { per: 1 });
    const r = await s.scheduler.runRule(id);
    if (vale) {
      assert.equal(r.offers, 1, mensagens(s, id).join(' | '));
      assert.match(s.wa.simulated[0].text, /90,00/, 'sai com o preço lido, não com o da lista (100)');
    } else {
      assert.deepEqual([r.offers, r.puladas, r.revisao], [0, 1, 0], mensagens(s, id).join(' | '));
      assert.deepEqual(enviadas(s.db, id), []);
      assert.deepEqual(itens(s.db, id), []);
    }
  });
}

test('S2: confirmado com preco_em fora da janela + preço da lista visto há 2 h — sai pela reserva com a hora da LISTA, nunca a do carimbo inventado', async (t) => {
  const lista = itensVelhos([1], { precoEm: dia(2, 12), leitura: { 1: confirmadoComPrecoEm(dia(2, 14) + HORA) } });
  const s = montarFreio(t, { itens: lista });
  const id = regraAmazonCat(s.db, { per: 1 });
  const r = await s.scheduler.runRule(id);
  assert.equal(r.offers, 1);
  assert.match(mensagens(s, id).find((m) => /não conferido agora/.test(m)) ?? '', /preço visto às 12:00, não conferido agora/);
  assert.match(s.wa.simulated[0].text, /100,00/, 'sai com o preço da lista, não com o da resposta fora do contrato');
});

// ------------------------------------------------------------------------------------------------------------------- S1

test('S1: Amazon relida com R$ 1,99 "de R$ 199" (parcela no lugar do preço) vai à revisão com preco_antigo e NÃO chega ao WhatsApp nem a sent_offers', async (t) => {
  const s = montar(t, {
    catalogo: [doEtiqueta(1, 'amazon', { precoEm: dia(1, 20) })],
    releitura: { [asinDe(1)]: { resultado: 'confirmado', preco: 1.99, precoAntigo: 199, descontoPct: null, precoEm: dia(2, 14) } },
  });
  const id = regraCatalogo(s.db, { per: 1 });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.revisao], [0, 1]);
  assert.equal(s.wa.simulated.length, 0);
  assert.deepEqual(enviadas(s.db, id), []);
  const [item] = itens(s.db, id);
  assert.deepEqual([item.status, JSON.parse(item.motivos)], ['revisao', ['preco_antigo']]);
  const oferta = JSON.parse(s.db.prepare('SELECT oferta FROM catalogo_itens WHERE rule_id = ?').get(id).oferta);
  assert.equal(oferta.price, 1.99, 'a revisão mostra o preço lido, que é o que o dono precisa ver');
  assert.ok(s.logs(id).some((l) => /Separada para revisão/.test(l.message)));
});

test('S1: Amazon relida a R$ 0,001 (desconto de 100%) vai à revisão com desconto_100 e NÃO sai', async (t) => {
  const s = montarFreio(t, { itens: itensVelhos([1]), extra: {} });
  s.estado.itens[asinDe(1)].leitura = () => ({ versao: 1, resultado: 'confirmado', preco: 0.001, preco_antigo: 150, desconto_pct: null, preco_em: precoEmTexto(Date.now()) });
  const id = regraAmazonCat(s.db, { per: 1 });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.revisao], [0, 1], mensagens(s, id).join(' | '));
  assert.equal(s.wa.simulated.length, 0);
  assert.deepEqual(enviadas(s.db, id), []);
  assert.ok(JSON.parse(itens(s.db, id)[0].motivos).includes('desconto_100'));
});

test('S1: a suspeita não derruba a vaga — a oferta suspeita vai à revisão e a vaga é reposta pela próxima candidata, que sai', async (t) => {
  const s = montarFreio(t, { itens: itensVelhos([1, 2]), extra: {} });
  s.estado.itens[asinDe(1)].leitura = () => ({ versao: 1, resultado: 'confirmado', preco: 1.99, preco_antigo: 199, desconto_pct: 99, preco_em: precoEmTexto(Date.now()) });
  const id = regraAmazonCat(s.db, { per: 1 });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.revisao], [1, 1]);
  assert.deepEqual(enviadas(s.db, id), ['ASIN:' + asinDe(2)]);
});

test('S1: Mercado Livre conferido pela extensão com preço R$ 1,99 (a oferta tinha "de R$ 150") vai à revisão e não sai', async (t) => {
  const s = montar(t, { catalogo: [doEtiqueta(1, 'ml')], loja: { 4000000001: { price: 1.99, disponivel: true } } });
  const id = regraCatalogo(s.db, { per: 1 });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.revisao], [0, 1], s.logs(id).map((l) => l.message).join(' | '));
  assert.equal(s.wa.simulated.length, 0);
  assert.deepEqual(enviadas(s.db, id), []);
  assert.ok(JSON.parse(itens(s.db, id)[0].motivos).includes('preco_antigo'));
});

test('S1: Amazon com a API ligada (catálogo) que lê R$ 1,99 "de R$ 199" também vai à revisão — é o mesmo caminho do catálogo', async (t) => {
  const s = montar(t, { catalogo: [doEtiqueta(1, 'amazon', { precoEm: dia(2, 13) })] });
  const comApi = { ...s.amazon, configurado: () => true, lerItem: async () => ({ price: 1.99, disponivel: true, discountPct: 99, oldPrice: 199 }), montarLink: s.amazon.montarLink };
  const verif = createVerificador({ db: s.db, amazon: comApi, catalogo: { confirmarPreco: async () => { throw new Error('não podia chamar'); } } });
  const catalogoItens = createCatalogoItens({ db: s.db, wa: s.wa, links: s.links, amazon: comApi });
  const fonte = { async candidatos(cfg, ctx) { return [doEtiqueta(1, 'amazon', { precoEm: dia(2, 13) })].map(paraCandidato).filter((c) => c && !ctx.tratada(c, cfg.ordem)); }, avancar() {} };
  const sch = createScheduler({ db: s.db, wa: s.wa, links: s.links, fast: true, amazon: comApi, verificador: verif, catalogo: fonte, catalogoItens });
  const id = regraCatalogo(s.db, { per: 1 });
  const r = await sch.runRule(id);
  assert.deepEqual([r.offers, r.revisao], [0, 1]);
  assert.equal(s.wa.simulated.length, 0);
  assert.deepEqual(enviadas(s.db, id), []);
});

test('S1: preço acima de 10 milhões na resposta do Etiqueta é resposta inesperada (pula) e 10 milhões exatos passam pelo cliente', async (t) => {
  const s = montarFreio(t, { itens: itensVelhos([1]), extra: {} });
  s.estado.itens[asinDe(1)].leitura = () => ({ versao: 1, resultado: 'confirmado', preco: 10_000_000.01, preco_antigo: null, desconto_pct: null, preco_em: precoEmTexto(Date.now()) });
  const r1 = await s.catalogo.confirmarPreco(asinDe(1));
  assert.deepEqual(r1, { resultado: 'falha', causa: 'resposta_inesperada' });
  s.estado.itens[asinDe(1)].leitura = () => ({ versao: 1, resultado: 'confirmado', preco: 10_000_000, preco_antigo: null, desconto_pct: null, preco_em: precoEmTexto(Date.now()) });
  s.avancar(10 * 1000);
  const r2 = await s.catalogo.confirmarPreco(asinDe(1));
  assert.equal(r2.resultado, 'confirmado');
  assert.equal(r2.preco, 10_000_000);
});

// ------------------------------------------------------------------------------------------------------------------- R4

test('R4: a frase da idade do preço ("tem mais de 6 h") só aparece com a releitura em uso; com a API da Amazon ligada só diz a causa', async (t) => {
  // sem API (releitura em uso): idade na frase
  const s = montarFreio(t, { itens: itensVelhos([1]), extra: { forcar: () => ({ motivo: 'pausa', segundos: 900 }) } });
  const id = regraAmazonCat(s.db, { per: 1 });
  await s.scheduler.runRule(id);
  assert.ok(mensagens(s, id).some((m) => /^Pulada: o preço visto às \d\d:\d\d de \d\d\/\d\d tem mais de 6 h e não deu para conferir agora/.test(m)), mensagens(s, id).join(' | '));
  // com a API ligada e a loja fora do ar
  const s2 = montar(t, { catalogo: [doEtiqueta(1, 'amazon', { precoEm: dia(1, 20) })] });
  const comApi = { ...s2.amazon, configurado: () => true, lerItem: async () => { throw new Error('API fora'); }, montarLink: s2.amazon.montarLink };
  const verif = createVerificador({ db: s2.db, amazon: comApi, catalogo: { confirmarPreco: async () => { throw new Error('não podia chamar'); } } });
  const fonte = { async candidatos(cfg, ctx) { return [doEtiqueta(1, 'amazon', { precoEm: dia(1, 20) })].map(paraCandidato).filter((c) => c && !ctx.tratada(c, cfg.ordem)); }, avancar() {} };
  const sch = createScheduler({ db: s2.db, wa: s2.wa, links: s2.links, fast: true, amazon: comApi, verificador: verif, catalogo: fonte, catalogoItens: s2.catalogoItens });
  const id2 = regraCatalogo(s2.db, { per: 1 });
  await sch.runRule(id2);
  const linhas = s2.logs(id2).map((l) => l.message).filter((m) => m.startsWith('Pulada'));
  assert.equal(linhas.length, 1, s2.logs(id2).map((l) => l.message).join(' | '));
  assert.ok(!/mais de 6 h|preço visto/.test(linhas[0]), linhas[0]);
});

// ------------------------------------------------------------------------------------------------------------------- Q2

test('Q2: campo inválido (titulo_max, link_mode, limite) recusa com 400 e NÃO grava nenhum dos outros nem a linha do verificador', async (t) => {
  const s = await subirServidor(); t.after(s.fechar);
  const antes = () => ({ v: getSetting(s.db, 'verificador_ativo'), l: getSetting(s.db, 'verificador_limite_pct'), r: getSetting(s.db, 'retencao_dias'), t: getSetting(s.db, 'titulo_max'), m: getSetting(s.db, 'link_mode') });
  const base = antes();
  const invalidos = [{ titulo_max: 999 }, { titulo_max: -1 }, { titulo_max: 'abc' }, { link_mode: 'xx' }, { retencao_dias: -5 }, { retencao_dias: 'abc' }, { verificador_limite_pct: 'abc' }];
  for (const ruim of invalidos) {
    const r = await pedir(s.port, '/api/ajustes', { method: 'PUT', body: { verificador_ativo: false, verificador_limite_pct: ruim.verificador_limite_pct === undefined ? 12 : undefined, retencao_dias: ruim.retencao_dias === undefined ? 30 : undefined, titulo_max: ruim.titulo_max === undefined ? 50 : undefined, link_mode: ruim.link_mode === undefined ? 'direct' : undefined, ...ruim } });
    assert.equal(r.status, 400, JSON.stringify(ruim));
    assert.deepEqual(antes(), base, `estado intacto depois de ${JSON.stringify(ruim)}`);
    assert.deepEqual(avisosDoVerificador(s.db), [], `sem linha no Histórico depois de ${JSON.stringify(ruim)}`);
  }
});

test('Q2: pedido todo válido grava todos os campos e a linha do verificador (quem fez)', async (t) => {
  const s = await subirServidor(); t.after(s.fechar);
  const r = await pedir(s.port, '/api/ajustes', { method: 'PUT', body: { verificador_ativo: false, verificador_limite_pct: 12, retencao_dias: 30, titulo_max: 50, link_mode: 'direct' } });
  assert.equal(r.status, 200, r.txt);
  assert.equal(getSetting(s.db, 'verificador_ativo'), '0');
  assert.equal(getSetting(s.db, 'retencao_dias'), '30');
  assert.equal(getSetting(s.db, 'titulo_max'), '50');
  assert.equal(getSetting(s.db, 'link_mode'), 'direct');
  assert.deepEqual(avisosDoVerificador(s.db).length, 1);
});
