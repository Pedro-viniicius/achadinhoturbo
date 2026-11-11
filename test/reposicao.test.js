// Vaga reposta no Disparo automático (plano rodar-sozinho-entrega1, etapa B5; CA1.7, CA1.8, CA1.11 e CA1.12): a regra
// escolhe uma oferta por vez (criarEscolha) e, quando a escolhida cai fora (pulada, descartada ou separada para revisão),
// a vaga vai à próxima candidata, com no máximo vagas × (1 + TETO_REPOSICAO) escolhidas por execução. Agendador real,
// WhatsApp simulado, links em modo simulado, verificador falso (decide por chave) e catálogo falso (devolve as ofertas
// no formato do Etiqueta e guarda o contexto de cada leitura). Nenhuma loja nem o WhatsApp reais são chamados.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, setSetting } from '../src/db.js';
import { createScheduler, TETO_REPOSICAO } from '../src/scheduler.js';
import { createLinkService } from '../src/links.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createCatalogoItens } from '../src/catalogo-itens.js';
import { createAmazon } from '../src/amazon.js';
import { paraCandidato } from '../src/catalogo.js';
import { createVerificador } from '../src/verificador.js';
import * as mlReal from '../src/ml.js';

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
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'reposicao-')); pastas.push(p); return p; };

const HORA = 3600000;
const dia = (d, h, m = 0, s = 0) => new Date(2026, 10, d, h, m, s).getTime(); // 02/11/2026 (segunda), horário local
const idDe = (url) => /MLB-?(\d+)/.exec(String(url))?.[1] ?? null;

// Títulos: A e B são parecidos (6 de 7 palavras); D e D_PARECIDO também; C e os "único N" não se parecem com nada
const A = 'Fone de Ouvido Bluetooth JBL Tune 510BT Preto';
const B = 'Fone de Ouvido Bluetooth JBL Tune 510BT Branco';
const AZUL = 'Fone de Ouvido Bluetooth JBL Tune 510BT Azul';
const C = 'Tênis Corrida Masculino Nike Revolution 7';
const D = 'Liquidificador Philco 900W 3 Velocidades';
const D_PARECIDO = 'Liquidificador Philco 900W Velocidades Preto';
const UNICOS = ['Panela Pressão Elétrica Mondial', 'Cadeira Gamer Reclinável Azul', 'Mochila Notebook Executiva Couro', 'Aspirador Robô Inteligente Wifi',
  'Smartwatch Esportivo Prova Água', 'Luminária Mesa Articulada Led', 'Toalha Banho Algodão Egípcio', 'Kit Ferramentas Maleta Completa',
  'Ventilador Coluna Silencioso Turbo', 'Garrafa Térmica Inox Café', 'Cafeteira Expresso Cápsulas Prata', 'Tapete Sala Felpudo Cinza'];
const unico = (i) => UNICOS[i];
/** Linha da "Lista de links" com preço digitado (MLB-100000n). */
const linha = (n, titulo, preco = 50) => `https://produto.mercadolivre.com.br/MLB-${1000000 + n}-x | ${titulo} | ${String(preco).replace('.', ',')}`;

/**
 * Verificador falso: `decisoes` = chave da oferta → 'esgotado' | 'preco_subiu' (descarta com esse motivo); o resto sai
 * como veio. `semConferencia`: chaves que hoje não teriam como ser conferidas (semConfirmacaoAgora). `ligado`: ativo().
 */
function verificadorFalso({ decisoes = {}, semConferencia = new Set(), ligado = true } = {}) {
  const v = {
    conferidas: [],
    ativo: () => ligado,
    async conferir(o) {
      v.conferidas.push(o.key);
      const m = decisoes[o.key];
      if (m === 'esgotado') return { acao: 'descartar', motivo: 'esgotado', texto: 'Descartada: esgotado na loja' };
      if (m === 'preco_subiu') return { acao: 'descartar', motivo: 'preco_subiu', texto: 'Descartada: preço subiu de R$ 50,00 para R$ 60,00 (+20%, o limite é 5%)' };
      return { acao: 'enviar', oferta: o, sufixo: null };
    },
    semConfirmacaoAgora: ({ loja, precoEm }) => loja === 'amazon' && semConferencia.has(precoEm),
  };
  return v;
}

/** Oferta no formato do Etiqueta. `precoEm` (ms) vira `preco_em` "AAAA-MM-DDTHH:MM:SS" (hora local). */
function oferta(i, loja, { titulo = unico(i), preco = 100, precoEm = null } = {}) {
  const o = { id: i, loja, titulo, preco, preco_antigo: 150, desconto_pct: 33, categoria: 'Casa' };
  if (loja === 'amazon') Object.assign(o, { item_id: `B0${String(i).padStart(8, '0')}`, link: 'https://www.amazon.com.br/dp/X?tag=terceiro-20' });
  if (loja === 'ml') Object.assign(o, { item_id: `MLB${4000000000 + i}`, link: 'https://meli.la/TerCeiro1' });
  if (loja === 'shopee') Object.assign(o, { item_id: `123.${i}`, link: `https://s.shopee.com.br/Ab${i}cd`, preco_antigo: null, desconto_pct: 0 });
  if (precoEm != null) {
    const d = new Date(precoEm); const p = (n) => String(n).padStart(2, '0');
    o.preco_em = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  return o;
}

/**
 * Agendador com o catálogo falso (`catalogo`: ofertas do Etiqueta; cada leitura guarda o ctx em `leituras`) e o
 * registro real do Catálogo. `verificador`: o objeto a injetar (null = sem verificador). `ml`: troca o módulo do ML.
 * `eventos`: cada pedido de link, em ordem. `falhaLink`: ids (dígitos do MLB) cujo link falha.
 */
function montar(t, { agora = dia(2, 14), catalogo = [], verificador = null, ml = null, protecao = {}, falhaLink = new Set() } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: agora }); // antes do agendador: o ritmo guarda o Date.now
  const dir = tmp(); const db = openDb(dir);
  const set = (k, v) => db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, String(v));
  if (protecao.limite != null) set('wa_limite_hora', protecao.limite);
  if (protecao.silencio) { set('wa_silencio_ativo', '1'); set('wa_silencio_de', protecao.silencio[0]); set('wa_silencio_ate', protecao.silencio[1]); }
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const eventos = [];
  const pedirLink = links.requestLink;
  links.requestLink = async (p) => {
    const id = idDe(p.url) ?? p.url; eventos.push(`link ${id}`);
    if (falhaLink.has(id)) throw new Error('falha de teste');
    return pedirLink(p);
  };
  const amazon = createAmazon({ db, fetch: async () => { throw new Error('rede proibida (Amazon)'); }, esperar: async () => {}, lerConexao: () => ({ tag: 'achadinho-20' }) });
  const estado = { ofertas: catalogo, leituras: [] };
  const fonte = {
    async candidatos(cfg, ctx) {
      const lista = estado.ofertas.map(paraCandidato).filter((c) => c && !ctx.tratada(c, cfg.ordem));
      // utilizaveis: o que o predicado do agendador diz de cada uma (só as utilizáveis contam para o alvo da leitura)
      estado.leituras.push({ conferenciaNaHora: ctx.conferenciaNaHora, previa: ctx.previa, utilizaveis: lista.map((c) => ctx.utilizavel?.(c)) });
      return lista;
    },
  };
  const catalogoItens = createCatalogoItens({ db, wa, links, amazon });
  const scheduler = createScheduler({ db, wa, links, fast: true, amazon, verificador, catalogo: fonte, catalogoItens, ...(ml ? { ml } : {}) });
  db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run('111@g.us', 'Achadinhos', 10, Date.now());
  db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etiquetaA', Date.now());
  const logs = (id) => db.prepare('SELECT level, offer_title, message FROM log WHERE rule_id = ? ORDER BY id').all(id).map((l) => ({ ...l }));
  const saiu = () => wa.simulated.map((m) => m.text.split('\n')[0].replace(/^\*|\*$/g, ''));
  return { db, wa, links, scheduler, eventos, estado, catalogoItens, logs, saiu };
}

const inserirRegra = (db, { nome = 'R', source = 'list', config = {}, sources = null, per = 1, dedupe = 7, extra = {} } = {}) => Number(db.prepare(`INSERT INTO rules (name, enabled, tag_id,
  template_id, group_jids, source_type, source_config, sources, per_run, interval_min, window_start, window_end, dedupe_days, send_image, max_price, created_at)
  VALUES (?, 1, 1, 1, ?, ?, ?, ?, ?, 60, '00:00', '23:59', ?, 0, ?, ?)`)
  .run(nome, JSON.stringify(['111@g.us']), source, JSON.stringify(config), sources ? JSON.stringify(sources) : null, per, dedupe, extra.max_price ?? null, Date.now()).lastInsertRowid);
const regraLista = (db, itens, opcoes = {}) => inserirRegra(db, { ...opcoes, config: { items: itens.join('\n') } });
const regraCatalogo = (db, opcoes = {}) => inserirRegra(db, { ...opcoes, sources: [{ type: 'catalogo', tag_id: null, config: { ordem: 'relevancia' } }] });
const saindoAgora = (titulo) => `409 Não enviada: parecida com "${titulo}", que está saindo agora por este disparo. Tente de novo em alguns minutos.`;
const tentar = (s, item) => s.catalogoItens.enviar(item, {}).then(() => 'enviou', (e) => `${e.status} ${e.message}`);
/** Item do Mercado Livre esperando revisão na regra `id`. → id do item */
function naRevisao(s, id, n, titulo) {
  const c = { key: `MLB${n}`, title: titulo, price: 40, oldPrice: null, discountPct: null, sold: 10, freeShipping: true, coupon: null, image: 'https://http2.mlstatic.com/D_NQ_NP_123-O.jpg', categoria: 'Casa', tag_id: null, source_index: 0 };
  assert.equal(s.catalogoItens.registrar({ id, name: 'R', dedupe_days: 7 }, c, 'revisao', ['falha_link']), true);
  return s.db.prepare('SELECT id FROM catalogo_itens WHERE rule_id = ? AND chave = ?').get(id, c.key).id;
}
const sairam = (s, id) => s.logs(id).filter((l) => /^(Horário \d\d:\d\d: s|S)aíram /.test(l.message)).map((l) => l.message);

// ---------------------------------------------------------------------------------------------------- CA1.7

test('CA1.7: escolhida que cai fora é reposta pela próxima candidata', async (t) => {
  const v = verificadorFalso({ decisoes: { MLB1000001: 'esgotado', MLB1000003: 'preco_subiu' } });
  const s = montar(t, { verificador: v, falhaLink: new Set(['1000002']) });
  const id = regraLista(s.db, [linha(1, unico(0)), linha(2, unico(1)), linha(3, unico(2)), linha(4, unico(3)), linha(5, unico(4)), linha(6, unico(5))], { per: 2 });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages, r.descartadas, r.puladas], [2, 2, 2, 1]);
  assert.deepEqual(s.saiu(), [unico(3), unico(4)], 'esgotada, link falho e mais cara dão a vaga às seguintes');
  assert.deepEqual(v.conferidas, ['MLB1000001', 'MLB1000002', 'MLB1000003', 'MLB1000004', 'MLB1000005'], 'a 6ª nem é escolhida: as vagas encheram');
  assert.deepEqual(sairam(s, id), [], 'saiu o pedido: sem a frase "saíram"');
  assert.deepEqual(s.db.prepare('SELECT offer_key FROM sent_offers WHERE rule_id = ? ORDER BY id').all(id).map((l) => l.offer_key), ['MLB1000004', 'MLB1000005']);
});

test('CA1.7: para em 4× as vagas', async (t) => {
  assert.equal(TETO_REPOSICAO, 3, 'as vagas mais 3× as vagas de reposição');
  const decisoes = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`MLB${1000001 + i}`, 'esgotado']));
  for (const per of [1, 2]) {
    await t.test(`${per} por envio`, async (st) => {
      const v = verificadorFalso({ decisoes });
      const s = montar(st, { verificador: v });
      const id = regraLista(s.db, Array.from({ length: 12 }, (_, i) => linha(i + 1, unico(i))), { per });
      const r = await s.scheduler.runRule(id);
      assert.equal(v.conferidas.length, per * 4, `${per * 4} escolhidas, e só`);
      assert.deepEqual([r.offers, r.descartadas], [0, per * 4]);
      // o teto, e não a falta de candidatas: a frase não diz "não havia mais ofertas novas"
      assert.deepEqual(sairam(s, id), [`Saíram 0 de ${per} ${per === 1 ? 'oferta' : 'ofertas'}; ${per * 4} descartadas (esgotada na loja).`]);
    });
  }
});

test('CA1.7: a escolhida que não chega a nenhum grupo (falha no envio) dá a vaga à próxima', async (t) => {
  const s = montar(t);
  const id = regraLista(s.db, [linha(1, unico(0)), linha(2, unico(1)), linha(3, unico(2))], { per: 1 });
  const original = s.wa.sendText.bind(s.wa); let primeira = true;
  s.wa.sendText = async (jid, text) => { if (primeira) { primeira = false; throw new Error('WhatsApp recusou (falso)'); } return original(jid, text); };
  const r = await s.scheduler.runRule(id);
  assert.deepEqual(s.saiu(), [unico(1)]);
  assert.deepEqual([r.messages, r.errors, r.puladas], [1, 1, 1]);
  assert.deepEqual(s.db.prepare('SELECT offer_key FROM sent_offers WHERE rule_id = ?').all(id).map((l) => l.offer_key), ['MLB1000002'], 'a que falhou não entra em sent_offers');
});

test('candidata que sempre falha não impede a seguinte (ordem fixa: ela gasta 1 tentativa por execução)', async (t) => {
  const s = montar(t, { falhaLink: new Set(['1000001']) });
  const id = regraLista(s.db, [linha(1, unico(0)), linha(2, unico(1)), linha(3, unico(2)), linha(4, unico(3))], { per: 1 });
  for (let i = 0; i < 3; i++) { await s.scheduler.runRule(id); t.mock.timers.setTime(Date.now() + HORA); }
  assert.deepEqual(s.saiu(), [unico(1), unico(2), unico(3)], 'uma por execução, sempre a seguinte');
  assert.deepEqual(s.eventos, ['link 1000001', 'link 1000002', 'link 1000001', 'link 1000003', 'link 1000001', 'link 1000004']);
});

test('a execução faz no máximo 4× as vagas em conferências (também com candidatas de sobra)', async (t) => {
  const decisoes = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`ASIN:B0${String(i + 1).padStart(8, '0')}`, 'esgotado']));
  const v = verificadorFalso({ decisoes });
  const s = montar(t, { verificador: v, catalogo: Array.from({ length: 12 }, (_, i) => oferta(i + 1, 'amazon')) });
  const id = regraCatalogo(s.db, { per: 2 });
  const r = await s.scheduler.runRule(id);
  assert.equal(v.conferidas.length, 8);
  assert.equal(r.descartadas, 8);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM catalogo_itens WHERE rule_id = ? AND status = 'descartado'").get(id).n, 8, 'as 4 do fim ficam para depois');
});

test('Amazon velha não ocupa tentativa com a releitura em pausa (semConfirmacaoAgora): fica fora da escolha e do cursor', async (t) => {
  const velho = dia(1, 2); const novo = dia(2, 13);
  const v = verificadorFalso({ semConferencia: new Set([velho]) });
  const catalogo = [1, 2, 3, 4, 5, 6].map((i) => oferta(i, 'amazon', { precoEm: velho })).concat([oferta(7, 'amazon', { precoEm: novo })]);
  const s = montar(t, { verificador: v, catalogo });
  const id = regraCatalogo(s.db, { per: 1 });
  const r = await s.scheduler.runRule(id);
  assert.equal(r.offers, 1, 'as 6 velhas não gastam as 4 tentativas: a 7ª sai');
  assert.deepEqual(v.conferidas, ['ASIN:B000000007'], 'nenhuma velha foi conferida');
  assert.deepEqual(s.saiu(), [unico(7)]);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM catalogo_itens WHERE rule_id = ?').get(id).n, 1, 'as velhas não viram item: voltam quando a releitura voltar');
  assert.deepEqual(s.estado.leituras[0].utilizaveis, [false, false, false, false, false, false, true], 'as velhas não contam para o alvo da leitura do catálogo');
  // a prévia não muda (CA1.11): mostra a 1ª velha
  const previa = await s.scheduler.previewOffers(id);
  assert.equal(previa[0]?.title, unico(1));
  assert.deepEqual(s.estado.leituras[1].utilizaveis, [true, true, true, true, true, true], 'na prévia as velhas contam (a 7ª já saiu)');
});

// ---------------------------------------------------------------------------------------------------- CA1.8

test('CA1.8: saíram X de Y com os motivos, também na regra por intervalo', async (t) => {
  const v = verificadorFalso({ decisoes: { MLB1000001: 'esgotado', MLB1000003: 'preco_subiu', MLB1000004: 'esgotado' } });
  const s = montar(t, { verificador: v, falhaLink: new Set(['1000005']) });
  const id = regraLista(s.db, [linha(1, unico(0)), linha(2, unico(1)), linha(3, unico(2)), linha(4, unico(3)), linha(5, unico(4))], { per: 3 });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.descartadas, r.puladas], [1, 3, 1]);
  assert.deepEqual(sairam(s, id), ['Saíram 1 de 3 ofertas; 1 pulada (link não gerado), 3 descartadas (2 esgotada na loja, 1 preço subiu); não havia mais ofertas novas dentro dos filtros.']);
  assert.equal(s.logs(id).find((l) => l.message.startsWith('Saíram')).level, 'aviso');
});

test('CA1.8: na grade, a frase leva o horário; com a vaga reposta e o pedido cheio, não há frase', async (t) => {
  const v = verificadorFalso({ decisoes: { MLB1000001: 'esgotado' } });
  const s = montar(t, { agora: dia(2, 10), verificador: v });
  const id = regraLista(s.db, [linha(1, unico(0)), linha(2, unico(1)), linha(3, unico(2)), linha(4, unico(3))], { per: 1 });
  s.db.prepare('UPDATE rules SET grade = ?, next_run_at = ? WHERE id = ?').run(JSON.stringify({
    dias: [0, 1, 2, 3, 4, 5, 6], horarios: [{ hora: '10:00', qtd: 2, template_id: null }, { hora: '11:00', qtd: 3, template_id: null }],
  }), dia(2, 10), id);
  await s.scheduler.tick();
  assert.deepEqual(s.saiu(), [unico(1), unico(2)], 'a esgotada foi reposta');
  assert.deepEqual(sairam(s, id), []);
  t.mock.timers.setTime(dia(2, 11));
  await s.scheduler.tick();
  assert.deepEqual(sairam(s, id), ['Horário 11:00: saíram 1 de 3 ofertas; não havia mais ofertas novas dentro dos filtros.']);
});

test('CA1.8: a separada para revisão entra na frase e a vaga é reposta', async (t) => {
  const v = verificadorFalso();
  const s = montar(t, { verificador: v, catalogo: [oferta(1, 'shopee'), oferta(2, 'ml'), oferta(3, 'shopee')] });
  const id = regraCatalogo(s.db, { per: 2 });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.revisao], [1, 2]);
  assert.deepEqual(sairam(s, id), ['Saíram 1 de 2 ofertas; 2 separadas para revisão; não havia mais ofertas novas dentro dos filtros.']);
});

test('contagem das filtradas: só quando sai menos que o pedido; sem nenhuma candidata, ela substitui "Sem ofertas novas…"', async (t) => {
  const velho = dia(1, 2);
  const v = verificadorFalso({ semConferencia: new Set([velho]) });
  const catalogo = [
    oferta(1, 'ml', { preco: 500 }), // acima do preço máximo da regra
    oferta(2, 'ml', { titulo: B }), // parecida com a A que a regra enviou
    oferta(3, 'amazon', { precoEm: velho }),
  ];
  const s = montar(t, { verificador: v, catalogo });
  const id = regraCatalogo(s.db, { per: 1, extra: { max_price: 200 } });
  s.db.prepare('INSERT INTO sent_offers (rule_id, offer_key, sent_at, title, price_cents) VALUES (?,?,?,?,?)').run(id, 'MLB999', Date.now() - HORA, A, 5000);
  await s.scheduler.runRule(id);
  const infos = () => s.logs(id).filter((l) => l.level === 'info' && !l.message.startsWith('Pulada')).map((l) => l.message);
  assert.deepEqual(infos(), ['Antes da escolha, 3 ofertas ficaram de fora: 1 fora dos filtros da regra, 1 já enviada ou parecida, 1 da Amazon que não dá para conferir agora. Nenhuma sobrou.']);
  assert.deepEqual(sairam(s, id), [], 'sem escolhida, sem "saíram 0 de 1"');

  // uma sai e o pedido é 2: a frase "saíram" e a contagem; com o pedido cheio, nenhuma das duas
  s.estado.ofertas.push(oferta(4, 'ml'));
  s.db.prepare('UPDATE rules SET per_run = 2 WHERE id = ?').run(id);
  await s.scheduler.runRule(id);
  assert.deepEqual(sairam(s, id), ['Saíram 1 de 2 ofertas; não havia mais ofertas novas dentro dos filtros.']);
  assert.equal(infos().at(-1), 'Antes da escolha, 3 ofertas ficaram de fora: 1 fora dos filtros da regra, 1 já enviada ou parecida, 1 da Amazon que não dá para conferir agora.');
  assert.equal(infos().length, 2, 'sem "Nenhuma sobrou." quando alguma saiu');
});

test('contagem das filtradas: em pausa por descarte (fontes antigas) e com o pedido cheio não há linha', async (t) => {
  const v = verificadorFalso({ decisoes: { MLB1000001: 'esgotado' } });
  const s = montar(t, { verificador: v });
  const id = regraLista(s.db, [linha(1, unico(0)), linha(2, unico(1))], { per: 1 });
  await s.scheduler.runRule(id);
  const contagens = () => s.logs(id).filter((l) => l.message.startsWith('Antes da escolha')).map((l) => l.message);
  assert.deepEqual(contagens(), [], 'a 2 ocupou a vaga da esgotada: pedido cheio');
  t.mock.timers.setTime(Date.now() + HORA);
  await s.scheduler.runRule(id);
  assert.deepEqual(contagens(), ['Antes da escolha, 1 oferta ficou de fora: 1 em pausa de 6 h. Nenhuma sobrou.']);
});

// ---------------------------------------------------------------------------------------------------- CA1.12

test('CA1.12: reposição para no teto por hora e no silêncio', async (t) => {
  await t.test('teto por hora', async (st) => {
    const v = verificadorFalso({ decisoes: { MLB1000001: 'esgotado' } });
    const s = montar(st, { verificador: v, protecao: { limite: 1 } });
    const id = regraLista(s.db, [linha(1, unico(0)), linha(2, unico(1)), linha(3, unico(2))], { per: 2 });
    const r = await s.scheduler.runRule(id);
    assert.equal(r.parou, 'limite');
    assert.deepEqual(s.saiu(), [unico(1)], 'a reposta usou a única vaga da hora; a seguinte parou no teto');
    assert.deepEqual(v.conferidas, ['MLB1000001', 'MLB1000002'], 'a 3ª nem foi conferida: o teto vem antes da conferência');
    assert.deepEqual(sairam(s, id), ['Saíram 1 de 2 ofertas; 1 descartada (esgotada na loja); o limite de 1 mensagens por hora encheu.']);
  });
  await t.test('silêncio no meio (regra por intervalo)', async (st) => {
    const v = verificadorFalso({ decisoes: { MLB1000001: 'esgotado' } });
    const s = montar(st, { agora: dia(2, 22, 59, 50), verificador: v, protecao: { silencio: ['23:00', '07:00'] } });
    const id = regraLista(s.db, [linha(1, unico(0)), linha(2, unico(1)), linha(3, unico(2)), linha(4, unico(3))], { per: 3 });
    const original = s.wa.sendText.bind(s.wa);
    s.wa.sendText = async (jid, text) => { const r = await original(jid, text); st.mock.timers.setTime(dia(2, 23, 0, 5)); return r; };
    const r = await s.scheduler.runRule(id);
    assert.equal(r.parou, 'silencio');
    assert.deepEqual(s.saiu(), [unico(1)]);
    assert.deepEqual(v.conferidas, ['MLB1000001', 'MLB1000002']);
    // a linha do adiamento diz o silêncio: a frase "saíram" não o repete (spec, §1)
    assert.deepEqual(s.logs(id).filter((l) => l.level === 'aviso').map((l) => l.message), [
      'Descartada: esgotado na loja',
      'Saíram 1 de 3 ofertas; 1 descartada (esgotada na loja).',
      'Horário de silêncio (23:00 às 07:00): disparo adiado para as 07:00.',
    ]);
  });
});

test('CA1.12: reposta passa pela trava; a que caiu não barra a parecida', async (t) => {
  // a A (escolhida) esgota: a B, parecida com ela, ocupa a vaga; a C passa pela trava contra a B que saiu
  const v = verificadorFalso({ decisoes: { MLB1000001: 'esgotado' } });
  const s = montar(t, { verificador: v });
  const id = regraLista(s.db, [linha(1, A), linha(2, B), linha(3, AZUL), linha(4, C)], { per: 2 });
  await s.scheduler.runRule(id);
  assert.deepEqual(s.saiu(), [B, C], 'a B sai no lugar da A; a azul (parecida com as duas) é barrada pela B, que saiu');
  const puladas = s.logs(id).filter((l) => l.message.startsWith('Pulada')).map((l) => [l.offer_title, l.message]);
  assert.deepEqual(puladas, [[AZUL, `Pulada: parecida com "${B}", que foi escolhida neste mesmo envio.`]], 'nenhuma linha contra a A, que não saiu');
});

test('CA1.12 (concorrência): a reposta entra em "saindo agora" na escolha; a que caiu sai dele (o "Enviar" do Catálogo)', async (t) => {
  const s = montar(t, { falhaLink: new Set(['1000001']) });
  const id = regraLista(s.db, [linha(1, D), linha(2, A), linha(3, C)], { per: 2 });
  const parecidaDaQueCai = naRevisao(s, id, 2000001, D_PARECIDO);
  const parecidaDaReposta = naRevisao(s, id, 2000002, B);
  const durante = [];
  const pedir = s.links.requestLink;
  s.links.requestLink = async (p) => {
    if (idDe(p.url) === '1000001') durante.push(['a D saindo', await tentar(s, parecidaDaQueCai)]);
    if (idDe(p.url) === '1000002') {
      durante.push(['a D caiu', await tentar(s, parecidaDaQueCai)]);
      durante.push(['a A (reposta) saindo', await tentar(s, parecidaDaReposta)]);
    }
    return pedir(p);
  };
  const r = await s.scheduler.runRule(id);
  assert.deepEqual(durante, [['a D saindo', saindoAgora(D)], ['a D caiu', 'enviou'], ['a A (reposta) saindo', saindoAgora(A)]]);
  assert.deepEqual([r.offers, r.puladas], [2, 1]);
  assert.deepEqual(s.saiu(), [A, C]);
});

test('CA1.12 (concorrência): o "Enviar" que passa antes de a parecida ser escolhida faz a reposta ser pulada', async (t) => {
  let s = null; let alvo = null; const durante = [];
  const ml = { ...mlReal, resolveOffer: async (c, d) => { if (alvo && String(c.url).includes('MLB-1000002')) durante.push(await tentar(s, alvo)); return mlReal.resolveOffer(c, d); } };
  s = montar(t, { ml, falhaLink: new Set(['1000001']) });
  const id = regraLista(s.db, [linha(1, D), linha(2, A), linha(3, C)], { per: 1 });
  alvo = naRevisao(s, id, 2000001, B);
  const r = await s.scheduler.runRule(id);
  assert.deepEqual(durante, ['enviou'], 'a A ainda não estava escolhida');
  assert.deepEqual(s.saiu(), [C], 'a A seria a reposta, mas a parecida dela saiu pelo Catálogo: a vaga vai à C');
  assert.deepEqual([r.offers, r.puladas], [1, 2]);
  assert.ok(s.logs(id).some((l) => l.offer_title === A && /^Pulada: parecida com ".+", que saiu por este disparo/.test(l.message)));
});

// ---------------------------------------------------------------------------------------- summary.porLoja

test('summary.porLoja e summary.puladas: o que aconteceu com as escolhidas de cada loja', async (t) => {
  const v = verificadorFalso({ decisoes: { 'ASIN:B000000002': 'esgotado' } });
  const s = montar(t, { verificador: v, catalogo: [oferta(1, 'shopee'), oferta(2, 'amazon'), oferta(3, 'ml'), oferta(4, 'amazon')] });
  const id = regraCatalogo(s.db, { per: 3 });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual(JSON.parse(JSON.stringify(r.porLoja)), {
    ml: { saiu: 1, pulada: 0, descartada: 0, revisao: 0, esperou: 0 },
    amazon: { saiu: 1, pulada: 0, descartada: 1, revisao: 0, esperou: 0 },
    shopee: { saiu: 0, pulada: 0, descartada: 0, revisao: 1, esperou: 0 },
  });
  assert.equal(r.puladas, 0);
  assert.deepEqual(sairam(s, id), ['Saíram 2 de 3 ofertas; 1 descartada (esgotada na loja), 1 separada para revisão; não havia mais ofertas novas dentro dos filtros.']);
});

test('summary.porLoja: o Mercado Livre que espera a extensão conta em "esperou"', async (t) => {
  const s = montar(t, { catalogo: [oferta(1, 'ml'), oferta(2, 'amazon')] });
  s.links.modo = () => 'extension'; // extensão nunca conectada: o ML espera, sem revisão
  const id = regraCatalogo(s.db, { per: 1 });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.porLoja.ml.esperou, r.porLoja.amazon.saiu], [1, 1]);
});

// ---------------------------------------------------------------------------------------------------- CA1.11

test('CA1.11: conferenciaNaHora vai ao catálogo só com o verificador ligado, e nunca na prévia', async (t) => {
  for (const [nome, verificador, esperado] of [
    ['sem verificador', () => null, false],
    ['verificador real ligado', (db) => createVerificador({ db, ml: { async conferirProduto() { throw new Error('fora'); } } }), true],
    ['verificador real desligado em Ajustes', (db) => { setSetting(db, 'verificador_ativo', '0'); return createVerificador({ db }); }, false],
  ]) {
    await t.test(nome, async (st) => {
      st.mock.timers.enable({ apis: ['Date'], now: dia(2, 14) });
      const dir = tmp(); const db = openDb(dir);
      const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
      const links = createLinkService({ getMode: () => 'fake' });
      const leituras = [];
      const catalogo = { async candidatos(cfg, ctx) { leituras.push([ctx.previa, ctx.conferenciaNaHora]); return []; } };
      const catalogoItens = createCatalogoItens({ db, wa, links });
      const scheduler = createScheduler({ db, wa, links, fast: true, verificador: verificador(db), catalogo, catalogoItens });
      db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run('111@g.us', 'Achadinhos', 10, Date.now());
      db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etiquetaA', Date.now());
      const id = regraCatalogo(db);
      await scheduler.runRule(id);
      await scheduler.previewOffers(id);
      assert.deepEqual(leituras, [[false, esperado], [true, false]]);
    });
  }
});
