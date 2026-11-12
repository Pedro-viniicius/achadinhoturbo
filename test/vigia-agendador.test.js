// Rodar sozinho, entrega 3, etapa 5 (docs/produto/planos/rodar-sozinho-entrega3.md, Decisão 1, 2, 6 e 8; Foco de
// revisão 5 e 6; D10): o vigia ligado ao agendador. O runRule grava uma linha em `execucoes` no fim de cada execução
// (`conta`, `por_loja` com os motivos e as filtradas que são falta de loja), o tick chama o vigia logo depois dos avisos e
// depois de cada regra, o resumo diário ganha a linha de saúde e o /api/state traz `vigia`. Peças reais (agendador,
// vigia, avisos, catálogo, ritmo, banco numa pasta temporária); só a extensão (serviço de links), o WhatsApp (simulado),
// o Etiqueta e o verificador são de mentira. Nenhum teste chama loja, Etiqueta nem WhatsApp reais.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openDb, setSetting } from '../src/db.js';
import { createScheduler, RETENCAO_EXECUCOES_DIAS } from '../src/scheduler.js';
import { createLinkService, ErroLinkML } from '../src/links.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createCatalogoItens } from '../src/catalogo-itens.js';
import { createAmazon } from '../src/amazon.js';
import { paraCandidato } from '../src/catalogo.js';
import { buildApp } from '../src/server.js';
import { MOTIVO_VIGIA, TEXTO_SEM_LEITURA } from '../src/vigia.js';

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
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-vigia-agendador-')); pastas.push(p); return p; };

const MIN = 60000;
const HORA = 60 * MIN;
const DIA = 24 * HORA;
const dia = (d, h, m = 0, s = 0) => new Date(2026, 10, d, h, m, s).getTime(); // novembro/2026, horário local
const G1 = '111@g.us';
const DESTINO = '5511900000001@s.whatsapp.net';
// títulos que não se parecem entre si (a trava de parecidos barraria os parecidos sem linha de erro)
const TITULOS = ['Panela Pressão Elétrica Mondial', 'Cadeira Gamer Reclinável Azul', 'Mochila Notebook Executiva Couro', 'Aspirador Robô Inteligente Wifi',
  'Smartwatch Esportivo Prova Água', 'Luminária Mesa Articulada Led', 'Toalha Banho Algodão Egípcio', 'Kit Ferramentas Maleta Completa',
  'Ventilador Coluna Silencioso Turbo', 'Garrafa Térmica Inox Café', 'Cafeteira Expresso Cápsulas Prata', 'Tapete Sala Felpudo Cinza'];
const titulo = (i) => TITULOS[i];

/** Oferta no formato do Etiqueta. `precoEm` (ms) vira `preco_em` "AAAA-MM-DDTHH:MM:SS" (hora local). */
function oferta(i, loja, { precoEm = null } = {}) {
  const o = { id: i, loja, titulo: titulo(i), preco: 100, preco_antigo: 150, desconto_pct: 33, categoria: 'Casa' };
  if (loja === 'amazon') Object.assign(o, { item_id: `B0${String(i).padStart(8, '0')}`, link: 'https://www.amazon.com.br/dp/X?tag=terceiro-20' });
  if (loja === 'ml') Object.assign(o, { item_id: `MLB${4000000000 + i}`, link: 'https://meli.la/TerCeiro1' });
  if (loja === 'shopee') Object.assign(o, { item_id: `123.${i}`, link: `https://s.shopee.com.br/Ab${i}cd`, preco_antigo: null, desconto_pct: 0 });
  if (precoEm != null) {
    const d = new Date(precoEm); const p = (n) => String(n).padStart(2, '0');
    o.preco_em = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  return o;
}

const ESGOTADO = { acao: 'descartar', motivo: 'esgotado', texto: 'Descartada: esgotado na loja' };
const naoConferido = (causa) => ({ acao: 'descartar', motivo: 'nao_conferido', causa, texto: 'x' });

/**
 * Verificador falso: `decisoes` = título da oferta → resposta do conferir (o resto sai como veio); `semConferencia`:
 * os `precoEm` da Amazon que hoje não teriam como ser conferidos; `pausa`: a leitura do ML em pausa; `antes(o)`: roda
 * antes de cada conferência (para mexer no relógio no meio da execução).
 */
function verificadorFalso({ decisoes = {}, semConferencia = new Set(), pausa = null, antes = null } = {}) {
  const v = {
    pausa, antes,
    ativo: () => true,
    async conferir(o) {
      await v.antes?.(o);
      return decisoes[o.title] ?? { acao: 'enviar', oferta: o, sufixo: null };
    },
    semConfirmacaoAgora: ({ loja, precoEm }) => loja === 'amazon' && semConferencia.has(precoEm),
    pausaDaLeituraMl: () => v.pausa,
  };
  return v;
}

/**
 * Dublê do serviço de links no modo da extensão: `d.online` (extensão), `d.central` (estado e emEsperaDesde da
 * Central), `d.link(p)` (decide o pedido de link; null = o link falso do modo simulado). A lista da Central de Afiliados
 * (fonte "afiliados") é sempre recusada pela espera.
 */
function linksDuble({ online = true, central = 'respondendo', desde = null } = {}) {
  const base = createLinkService({ getMode: () => 'fake' });
  const pedir = base.requestLink;
  const d = { online, central: { estado: central, emEsperaDesde: desde, testeLiberado: false }, link: null };
  Object.assign(base, {
    modo: () => 'extension',
    status: () => ({ online: d.online, lastPollAt: d.online ? Date.now() : 0, central: { estado: d.central.estado, emEsperaDesde: d.central.emEsperaDesde } }),
    central: () => ({ ...d.central }),
    requestLink: (p) => (d.link ? d.link(p) : pedir(p)),
    async requestOffers() { throw new ErroLinkML('nenhum pedido saiu', { classe: 'espera', causa: 'central_sem_resposta' }); },
  });
  return { links: base, d };
}

/**
 * Agendador real com o catálogo falso (devolve `estado.ofertas` no formato do Etiqueta), o registro real do Catálogo, o
 * WhatsApp simulado e um número de aviso ("Pedro") que recebe "Erro de disparo" (é ele quem recebe o vigia). O relógio
 * (só o Date) é falso desde antes do agendador: o ritmo e o vigia guardam o Date.now da criação. `agendador(links)`: um
 * agendador novo no mesmo banco (reinício do serviço).
 */
function montar(t, { agora = dia(12, 10), modo = 'fake', links = null, verificador = null, ofertas = [] } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: agora });
  const dir = tmp(); const db = openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  links ??= createLinkService({ getMode: () => modo });
  const amazon = createAmazon({ db, fetch: async () => { throw new Error('rede proibida (Amazon)'); }, esperar: async () => {}, lerConexao: () => ({ tag: 'achadinho-20' }) });
  const estado = { ofertas };
  const fonte = {
    async candidatos(cfg, ctx) { return estado.ofertas.map(paraCandidato).filter((c) => c && !ctx.tratada(c, cfg.ordem)); },
    avancar() {},
  };
  const catalogoItens = createCatalogoItens({ db, wa, links, amazon });
  const agendador = (l = links) => createScheduler({ db, wa, links: l, fast: true, amazon, verificador, catalogo: fonte, catalogoItens });
  const scheduler = agendador();
  db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(G1, 'Achadinhos', 10, Date.now());
  db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etiquetaA', Date.now());
  db.prepare('INSERT INTO aviso_destinos (nome, jid, avisos, ativo, created_at) VALUES (?,?,?,?,?)').run('Pedro', DESTINO, JSON.stringify(['erro']), 1, 1);
  const s = { db, dir, wa, links, estado, scheduler, agendador };
  s.avisosDoVigia = () => wa.simulated.filter((m) => m.jid === DESTINO).map((m) => m.text);
  s.paraGrupo = () => wa.simulated.filter((m) => m.jid === G1).length;
  s.execucoes = () => db.prepare('SELECT * FROM execucoes ORDER BY id').all()
    .map((x) => ({ ...x, lojas_pedidas: JSON.parse(x.lojas_pedidas), por_loja: JSON.parse(x.por_loja) }));
  s.linhasVigia = () => db.prepare("SELECT level, message FROM log WHERE rule_name = 'Vigia' ORDER BY id").all().map((l) => ({ ...l }));
  s.avancar = (ms) => t.mock.timers.setTime(Date.now() + ms);
  return s;
}

const COLUNAS = 'name, enabled, tag_id, template_id, group_jids, source_type, source_config, sources, per_run, interval_min, window_start, window_end, dedupe_days, send_image, created_at';
/** Regra com a fonte catálogo das `lojas` (padrão: intervalo de 60 min, o dia todo). → id */
function regraCatalogo(db, { nome = 'Catálogo', lojas = ['ml'], per = 1, janela = ['00:00', '23:59'], grupos = [G1] } = {}) {
  const fontes = [{ type: 'catalogo', tag_id: null, config: { ordem: 'relevancia', lojas } }];
  return Number(db.prepare(`INSERT INTO rules (${COLUNAS}) VALUES (?, 1, 1, 1, ?, 'list', '{}', ?, ?, 60, ?, ?, 7, 0, ?)`)
    .run(nome, JSON.stringify(grupos), JSON.stringify(fontes), per, janela[0], janela[1], Date.now()).lastInsertRowid);
}
/** Regra de fonte antiga: "Lista de links" (linhas com preço digitado, MLB-400000000i) ou a Central de Afiliados. → id */
function regraAntiga(db, tipo, { ids = [], per = 1 } = {}) {
  const config = tipo === 'list' ? { items: ids.map((i) => `https://produto.mercadolivre.com.br/MLB-${4000000000 + i}-x | ${titulo(i)} | 50`).join('\n') } : {};
  return Number(db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id, group_jids, source_type, source_config, per_run, interval_min,
    window_start, window_end, dedupe_days, send_image, created_at) VALUES ('Antiga', 1, 1, 1, ?, ?, ?, ?, 60, '00:00', '23:59', 7, 0, ?)`)
    .run(JSON.stringify([G1]), tipo, JSON.stringify(config), per, Date.now()).lastInsertRowid);
}

const zerada = (c = {}) => ({ saiu: 0, pulada: 0, descartada: 0, revisao: 0, esperou: 0, motivos: {}, ...c });
/** Toda chave gravada em `motivos` é uma de MOTIVO_VIGIA (src/vigia.js): a mensagem acha o motivo e a ação. */
function chavesDoVigia(x) {
  for (const [loja, c] of Object.entries(x.por_loja)) {
    for (const k of Object.keys(c.motivos)) assert.ok(Object.hasOwn(MOTIVO_VIGIA, k), `chave ${k} (${loja}) fora de MOTIVO_VIGIA`);
  }
}

/** Console de erro capturado (o vigia e o agendador escrevem só o código do erro). */
function capturarConsole(t) {
  const saida = [];
  t.mock.method(console, 'error', (...a) => { saida.push(a.map(String).join(' ')); });
  return saida;
}

// --------------------------------------------------------------------------------------------- HTTP cru
/** Requisição por `http` (o fetch global está bloqueado de propósito). */
function req(port, caminho) {
  return new Promise((ok, err) => {
    const r = http.request({ host: '127.0.0.1', port, path: caminho, method: 'GET', headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let txt = ''; res.setEncoding('utf8'); res.on('data', (c) => (txt += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(txt); } catch { /* html */ } ok({ status: res.statusCode, json }); });
    });
    r.on('error', err); r.end();
  });
}
/** O painel (buildApp) sobre o agendador `scheduler` de `s`, sem login. → { port, fechar } */
function subirPainel(t, s, scheduler = s.scheduler) {
  const app = buildApp({ db: s.db, wa: s.wa, links: s.links, scheduler, publicHost: '', panelPassword: '', dataDir: s.dir });
  return new Promise((ok) => {
    const server = app.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }));
      ok({ port: server.address().port });
    });
  });
}

// ============================================================================================ por_loja e motivos

test('por_loja: saiu, descartada, pulada com a causa, revisão e a Amazon filtrada sem conferência ("Enviar agora" conta, D10)', async (t) => {
  const VELHO = dia(10, 8);
  const v = verificadorFalso({ decisoes: { [titulo(1)]: ESGOTADO, [titulo(2)]: naoConferido('etiqueta_fora') }, semConferencia: new Set([VELHO]) });
  const s = montar(t, { verificador: v, ofertas: [oferta(0, 'ml'), oferta(1, 'amazon'), oferta(2, 'amazon'), oferta(3, 'shopee'), oferta(4, 'amazon', { precoEm: VELHO })] });
  const id = regraCatalogo(s.db, { lojas: ['ml', 'amazon', 'shopee'], per: 5 });
  const r = await s.scheduler.runRule(id, { manual: true });
  assert.equal(r.offers, 1);
  const [x, ...resto] = s.execucoes();
  assert.equal(resto.length, 0, 'uma linha por execução');
  assert.deepEqual({ ts: x.ts, rule_id: x.rule_id, conta: x.conta, want: x.want, saidas: x.saidas, erros: x.erros, lojas_pedidas: x.lojas_pedidas },
    { ts: Date.now(), rule_id: id, conta: 1, want: 5, saidas: 1, erros: 0, lojas_pedidas: ['ml', 'amazon', 'shopee'] });
  assert.deepEqual(x.por_loja, {
    ml: zerada({ saiu: 1 }),
    // a filtrada antes da escolha (sem conferência) entra em `esperou`, com a chave do vigia; a pulada leva a causa
    amazon: zerada({ pulada: 1, descartada: 1, esperou: 1, motivos: { esgotado: 1, etiqueta_fora: 1, semConferencia: 1 } }),
    shopee: zerada({ revisao: 1 }), // a revisão é decisão do dono: sem motivo
  });
  chavesDoVigia(x);
  assert.equal(r.porLoja.amazon.esperou, 0, 'o summary.porLoja não muda: as filtradas só entram na linha de execucoes');
  assert.equal(r.porLoja.motivos, undefined);
});

test('por_loja do Mercado Livre: a espera e a falta (extensão, Central, leitura em pausa) e a causa da falha do link', async (t) => {
  await t.test('extensão do Chrome fora (catálogo): esperou, com ml_extensao', async (tt) => {
    const s = montar(tt, { modo: 'extension', ofertas: [oferta(0, 'ml'), oferta(1, 'ml')] });
    const id = regraCatalogo(s.db, { per: 1 });
    await s.scheduler.runRule(id);
    const [x] = s.execucoes();
    assert.deepEqual([x.conta, x.saidas], [1, 0]);
    assert.deepEqual(x.por_loja.ml, zerada({ esperou: 2, motivos: { ml_extensao: 2 } }));
    assert.deepEqual(x.lojas_pedidas, ['ml']);
    chavesDoVigia(x);
  });
  await t.test('Central em espera (catálogo): esperou, com ml_espera', async (tt) => {
    const { links } = linksDuble({ central: 'em_espera', desde: dia(12, 9) });
    const s = montar(tt, { links, ofertas: [oferta(0, 'ml')] });
    await s.scheduler.runRule(regraCatalogo(s.db));
    assert.deepEqual(s.execucoes()[0].por_loja.ml, zerada({ esperou: 1, motivos: { ml_espera: 1 } }));
  });
  await t.test('Central em espera (Lista de links, fonte antiga): cada escolhida esperou, com ml_espera; lojas pedidas = []', async (tt) => {
    const { links } = linksDuble({ central: 'em_espera', desde: dia(12, 9) });
    const s = montar(tt, { links });
    await s.scheduler.runRule(regraAntiga(s.db, 'list', { ids: [1, 2] }));
    const [x] = s.execucoes();
    assert.deepEqual([x.conta, x.saidas, x.erros], [1, 0, 0]);
    assert.deepEqual(x.por_loja.ml, zerada({ esperou: 2, motivos: { ml_espera: 2 } }));
    assert.deepEqual(x.lojas_pedidas, [], 'fonte antiga: lista vazia (o vigia lê como Amazon e Mercado Livre)');
  });
  await t.test('Central em espera (fonte Central de Afiliados): a fonte inteira esperou, as vagas da execução contam, sem erro', async (tt) => {
    const { links } = linksDuble({ central: 'em_espera', desde: dia(12, 9) });
    const s = montar(tt, { links });
    const r = await s.scheduler.runRule(regraAntiga(s.db, 'afiliados', { per: 3 }));
    const [x] = s.execucoes();
    assert.deepEqual([x.conta, x.want, x.saidas, x.erros, r.errors], [1, 3, 0, 0, 0]);
    assert.deepEqual(x.por_loja.ml, zerada({ esperou: 3, motivos: { ml_espera: 3 } }));
  });
  await t.test('leitura do ML em pausa: esperou, com mlPausa', async (tt) => {
    const v = verificadorFalso({ pausa: 'ml_verificacao' });
    const s = montar(tt, { verificador: v, ofertas: [oferta(0, 'ml')] });
    await s.scheduler.runRule(regraCatalogo(s.db));
    const [x] = s.execucoes();
    assert.deepEqual([x.conta, x.saidas], [1, 0]);
    assert.deepEqual(x.por_loja.ml, zerada({ esperou: 1, motivos: { mlPausa: 1 } }));
    chavesDoVigia(x);
  });
  await t.test('falha passageira do link: pulada, com a causa da Central (não "link_central")', async (tt) => {
    const { links, d } = linksDuble();
    d.link = () => { throw new ErroLinkML('a extensão não respondeu a tempo', { classe: 'passageira', causa: 'central_aba', detalhe: 'x' }); };
    const s = montar(tt, { links, ofertas: [oferta(0, 'ml')] });
    await s.scheduler.runRule(regraCatalogo(s.db));
    const [x] = s.execucoes();
    assert.deepEqual(x.por_loja.ml, zerada({ pulada: 1, motivos: { central_aba: 1 } }));
    chavesDoVigia(x);
  });
  await t.test('causa fora de MOTIVO_VIGIA (até "__proto__") vira "outro"', async (tt) => {
    const { links, d } = linksDuble();
    d.link = () => { throw new ErroLinkML('x', { classe: 'passageira', causa: '__proto__', detalhe: 'x' }); };
    const s = montar(tt, { links, ofertas: [oferta(0, 'ml')] });
    await s.scheduler.runRule(regraCatalogo(s.db));
    assert.deepEqual(s.execucoes()[0].por_loja.ml, zerada({ pulada: 1, motivos: { outro: 1 } }));
  });
  await t.test('conferência do ML que demorou (catálogo): pulada, com a causa', async (tt) => {
    const v = verificadorFalso({ decisoes: { [titulo(0)]: naoConferido('demorou') } });
    const s = montar(tt, { verificador: v, ofertas: [oferta(0, 'ml')] });
    await s.scheduler.runRule(regraCatalogo(s.db));
    assert.deepEqual(s.execucoes()[0].por_loja.ml, zerada({ pulada: 1, motivos: { demorou: 1 } }));
  });
  await t.test('a extensão caiu entre a escolha e o link (catálogo): esperou, com ml_extensao (não "espera")', async (tt) => {
    const { links, d } = linksDuble();
    d.link = () => { throw new ErroLinkML('A extensão do Chrome não está conectada.', { classe: 'desconectada', causa: 'extensao_off' }); };
    const s = montar(tt, { links, ofertas: [oferta(0, 'ml')] });
    await s.scheduler.runRule(regraCatalogo(s.db));
    assert.deepEqual(s.execucoes()[0].por_loja.ml, zerada({ esperou: 1, motivos: { ml_extensao: 1 } }));
  });
  await t.test('Lista de links: descartada sem conferência e link não gerado com a extensão fora levam a causa', async (tt) => {
    const v = verificadorFalso({ decisoes: { [titulo(1)]: naoConferido('loja_fora') } });
    const { links, d } = linksDuble();
    d.link = () => { throw new ErroLinkML('A extensão do Chrome não está conectada.', { classe: 'desconectada', causa: 'extensao_off' }); };
    const s = montar(tt, { links, verificador: v });
    await s.scheduler.runRule(regraAntiga(s.db, 'list', { ids: [1, 2] }));
    const [x] = s.execucoes();
    assert.deepEqual([x.conta, x.erros], [1, 1]);
    assert.deepEqual(x.por_loja.ml, zerada({ pulada: 1, descartada: 1, motivos: { loja_fora: 1, extensao_off: 1 } }));
    chavesDoVigia(x);
  });
});

// ================================================================================================ o que não conta

test('conta = 0: sem ofertas novas, regra incompleta e WhatsApp desconectado (não somam nem zeram sequência)', async (t) => {
  await t.test('sem ofertas novas', async (tt) => {
    const s = montar(tt, { ofertas: [] });
    await s.scheduler.runRule(regraCatalogo(s.db));
    const [x] = s.execucoes();
    assert.deepEqual([x.conta, x.want, x.saidas, x.erros], [0, 1, 0, 0]);
    assert.deepEqual(x.por_loja, { ml: zerada(), amazon: zerada(), shopee: zerada() });
  });
  await t.test('regra incompleta (sem grupo)', async (tt) => {
    const s = montar(tt, { ofertas: [oferta(0, 'ml')] });
    await s.scheduler.runRule(regraCatalogo(s.db, { grupos: [] }));
    assert.deepEqual([s.execucoes()[0].conta, s.execucoes()[0].erros], [0, 1]);
  });
  await t.test('WhatsApp desconectado', async (tt) => {
    const s = montar(tt, { ofertas: [oferta(0, 'ml')] });
    s.wa.isReady = () => false;
    await s.scheduler.runRule(regraCatalogo(s.db));
    assert.deepEqual([s.execucoes()[0].conta, s.execucoes()[0].erros], [0, 1]);
  });
});

test('silêncio que começa no meio: parada antes de qualquer saída não conta; depois de uma saída, conta', async (t) => {
  for (const [nome, decisao, esperado] of [
    ['a 1ª foi descartada e o silêncio parou a 2ª: nada saiu', ESGOTADO, { conta: 0, saidas: 0, ml: zerada({ descartada: 1, motivos: { esgotado: 1 } }) }],
    ['a 1ª saiu e o silêncio parou a 2ª', null, { conta: 1, saidas: 1, ml: zerada({ saiu: 1 }) }],
  ]) {
    await t.test(nome, async (tt) => {
      const v = verificadorFalso({ decisoes: decisao ? { [titulo(0)]: decisao } : {} });
      const s = montar(tt, { agora: dia(12, 22, 59, 30), verificador: v, ofertas: [oferta(0, 'ml'), oferta(1, 'ml')] });
      setSetting(s.db, 'wa_silencio_ativo', '1'); setSetting(s.db, 'wa_silencio_de', '23:00'); setSetting(s.db, 'wa_silencio_ate', '07:00');
      // a 1ª conferência leva o relógio para as 23:00: a 2ª oferta já é barrada pelo silêncio
      v.antes = () => { v.antes = null; tt.mock.timers.setTime(dia(12, 23, 0, 5)); };
      const r = await s.scheduler.runRule(regraCatalogo(s.db, { per: 2 }));
      assert.equal(r.parou, 'silencio');
      const [x] = s.execucoes();
      assert.deepEqual([x.conta, x.saidas], [esperado.conta, esperado.saidas]);
      assert.deepEqual(x.por_loja.ml, esperado.ml);
    });
  }
});

// =================================================================================================== CA3.10

test('CA3.10: retenção de 35 dias a cada gravação; falha da gravação vai ao console só com o código e não derruba a regra', async (t) => {
  assert.equal(RETENCAO_EXECUCOES_DIAS, 35);
  await t.test('retenção', async (tt) => {
    const s = montar(tt, { ofertas: [oferta(0, 'ml')] });
    const velha = (dias) => s.db.prepare("INSERT INTO execucoes (ts, rule_id, conta) VALUES (?, 99, 0)").run(Date.now() - dias * DIA);
    velha(35.01); velha(34.99);
    const id = regraCatalogo(s.db);
    await s.scheduler.runRule(id);
    assert.deepEqual(s.execucoes().map((x) => [x.rule_id, x.ts]), [[99, Date.now() - 34.99 * DIA], [id, Date.now()]], 'a de 35 dias e pouco saiu; a de 34 e pouco ficou');
  });
  await t.test('gravação que falha', async (tt) => {
    const s = montar(tt, { ofertas: [oferta(0, 'ml')] });
    const saida = capturarConsole(tt);
    s.db.exec("CREATE TRIGGER recusa BEFORE INSERT ON execucoes BEGIN SELECT RAISE(ABORT, 'fulano 11987654321'); END");
    const id = regraCatalogo(s.db);
    const r = await s.scheduler.runRule(id);
    assert.deepEqual([r.offers, r.errors, s.paraGrupo()], [1, 0, 1], 'a regra seguiu e a oferta saiu');
    assert.equal(s.scheduler.isRunning(id), false);
    assert.ok(s.db.prepare('SELECT next_run_at FROM rules WHERE id = ?').get(id).next_run_at > Date.now(), 'o próximo horário foi gravado');
    assert.deepEqual(s.execucoes(), []);
    assert.ok(saida.some((l) => /^\[agendador\] execuções: ERR_SQLITE_ERROR$/.test(l)), saida.join('\n'));
    assert.ok(!saida.join('\n').includes('fulano') && !saida.join('\n').includes('11987654321'), 'o texto do erro do banco não vai ao console');
  });
});

// ==================================================================================== CA3.1, CA3.3, CA3.4, CA3.10

test('CA3.1: extensão fora — o aviso sai pelo tick na execução 30 min depois do início; CA3.4 /api/state; CA3.3 prévia com a saúde; CA3.10 reinício sem repetir', async (t) => {
  const s = montar(t, { modo: 'extension', ofertas: [oferta(0, 'ml')] });
  regraCatalogo(s.db, { nome: 'Achados ML' });
  await s.scheduler.tick(); // 10:00: 1ª execução; a falta começou agora (início do serviço)
  assert.equal(s.execucoes().length, 1);
  assert.deepEqual(s.avisosDoVigia(), [], 'menos de 30 min de falta');
  s.avancar(HORA);
  await s.scheduler.tick(); // 11:00: 2ª execução, falta de 60 min
  assert.equal(s.execucoes().length, 2);
  const avisos = s.avisosDoVigia();
  assert.equal(avisos.length, 1, avisos.join('\n---\n'));
  assert.match(avisos[0], /^⚠️ \*Extensão do Chrome fora desde 10:00\*\nO Mercado Livre não envia sem ela \(1 oferta esperando\)\./);
  assert.ok(s.linhasVigia().some((l) => l.level === 'aviso' && l.message === 'Vigia: extensão do Chrome fora desde 10:00 (o Mercado Livre não envia sem ela).'));
  assert.ok(s.linhasVigia().some((l) => l.level === 'info' && /^Vigia: a regra “Achados ML” saiu vazia, mas a extensão do Chrome está fora: sem aviso separado\.$/.test(l.message)),
    'a regra só de ML é calada pela extensão (CA3.8)');
  assert.ok(s.linhasVigia().every((l) => l.level !== 'erro'));

  // CA3.4: o painel lê a causa em aberto e há quanto tempo
  const p = await subirPainel(t, s);
  const st = await req(p.port, '/api/state');
  assert.equal(st.status, 200);
  assert.deepEqual(st.json.vigia, { ok: true, avaliadoEm: Date.now(), causas: [{ tipo: 'extensao', chave: 'ml_fora', desdeEm: dia(12, 10), n: 1, calada: false }] });
  // CA3.3 (ligação): a prévia do resumo diário traz a saúde e a causa em aberto
  const previa = await req(p.port, '/api/avisos/previa');
  assert.match(previa.json.texto, /🩺 \*Saúde dos envios\* \(todas as regras\)\nMercado Livre: 0 enviadas\nPuladas: 2 · Descartadas: 0 · Falhas: 0\nEsperando revisão: nenhuma\nEm aberto agora: /);
  assert.match(previa.json.texto, /Em aberto agora: extensão fora desde 10:00\./);

  // CA3.10: reinício (agendador, vigia e serviço de links novos no mesmo banco): sem aviso novo, a causa continua
  const s2 = s.agendador(createLinkService({ getMode: () => 'extension' }));
  s.avancar(HORA);
  await s2.tick(); // 12:00: 3ª execução, com a extensão ainda fora
  assert.equal(s.execucoes().length, 3);
  assert.equal(s.avisosDoVigia().length, 1, 'nada repetido nem aberto de novo');
  assert.deepEqual(s2.vigia.estado().causas.map((c) => [c.tipo, c.desdeEm]), [['extensao', dia(12, 10)]]);
  assert.ok(s.linhasVigia().some((l) => /^Vigia: Mercado Livre parado \(3 execuções sem envio\), mas a extensão do Chrome está fora: sem aviso separado\.$/.test(l.message)));
});

test('CA3.1: Central em espera — "Mercado Livre em espera" sai na execução 30 min depois do início da espera', async (t) => {
  const { links } = linksDuble({ central: 'em_espera', desde: dia(12, 10) });
  const s = montar(t, { links, ofertas: [oferta(0, 'ml')] });
  regraCatalogo(s.db);
  await s.scheduler.tick();
  s.avancar(20 * MIN); await s.scheduler.tick(); // a regra não roda (intervalo de 60 min): nada abre
  assert.deepEqual(s.avisosDoVigia(), []);
  s.avancar(40 * MIN); await s.scheduler.tick();
  const avisos = s.avisosDoVigia();
  assert.equal(avisos.length, 1, avisos.join('\n---\n'));
  assert.match(avisos[0], /^⚠️ \*Mercado Livre em espera desde 10:00\*\nA Central de Afiliados não está respondendo \(1 oferta esperando\)\./);
});

test('CA3.1 (regra com horários marcados): o vigia passa logo depois do horário executado; want = qtd do horário', async (t) => {
  const { links } = linksDuble({ central: 'em_espera', desde: dia(12, 10) });
  const s = montar(t, { links, ofertas: [oferta(0, 'ml')] });
  const id = regraCatalogo(s.db);
  s.db.prepare('UPDATE rules SET grade = ?, next_run_at = ? WHERE id = ?').run(JSON.stringify({
    dias: [0, 1, 2, 3, 4, 5, 6], horarios: [{ hora: '10:00', qtd: 2, template_id: null }, { hora: '11:00', qtd: 2, template_id: null }],
  }), dia(12, 10), id);
  await s.scheduler.tick();
  s.avancar(HORA); await s.scheduler.tick();
  assert.deepEqual(s.execucoes().map((x) => [x.want, x.conta]), [[2, 1], [2, 1]]);
  assert.equal(s.avisosDoVigia().length, 1, 'o aviso saiu no mesmo tick do horário das 11:00');
  assert.match(s.avisosDoVigia()[0], /^⚠️ \*Mercado Livre em espera desde 10:00\*/);
});

test('CA3.1: Amazon só filtrada (sem conferência) — a regra vazia sai na 2ª execução e a Amazon parada na 3ª', async (t) => {
  const VELHO = dia(11, 8);
  const v = verificadorFalso({ semConferencia: new Set([VELHO]) });
  const s = montar(t, { verificador: v, ofertas: [oferta(0, 'amazon', { precoEm: VELHO }), oferta(1, 'amazon', { precoEm: VELHO })] });
  regraCatalogo(s.db, { nome: 'Amazon', lojas: ['amazon'], per: 2 });
  await s.scheduler.tick();
  assert.deepEqual(s.avisosDoVigia(), []);
  s.avancar(HORA); await s.scheduler.tick();
  assert.equal(s.avisosDoVigia().length, 1);
  assert.match(s.avisosDoVigia()[0], /^⚠️ \*A regra “Amazon” saiu vazia 2 vezes seguidas\*\nÀs 10:00 e às 11:00 nenhuma oferta saiu/);
  s.avancar(HORA); await s.scheduler.tick();
  const avisos = s.avisosDoVigia();
  assert.equal(avisos.length, 2, avisos.join('\n---\n'));
  assert.match(avisos[1], /^⚠️ \*Amazon parada desde 10:00\*\nNas últimas 3 execuções nenhuma oferta da Amazon saiu \(6 ficaram de fora: o preço não pôde ser conferido\)\./);
});

test('CA3.1: revisão acumulada — 10 ofertas separadas para revisão abrem o aviso na mesma execução', async (t) => {
  const s = montar(t, { ofertas: Array.from({ length: 10 }, (_, i) => oferta(i, 'shopee')) });
  regraCatalogo(s.db, { nome: 'Shopee', lojas: ['shopee'], per: 10 });
  await s.scheduler.tick();
  const [x] = s.execucoes();
  assert.deepEqual([x.conta, x.por_loja.shopee.revisao], [1, 10], 'só revisão conta como execução (a revisão abre numa execução que conta)');
  const avisos = s.avisosDoVigia();
  assert.equal(avisos.length, 1, avisos.join('\n---\n'));
  assert.match(avisos[0], /^⚠️ \*10 ofertas esperando a sua revisão\*/);
});

test('CA3.1: fora dos horários de envio nada abre, mesmo com a extensão fora há horas', async (t) => {
  const s = montar(t, { modo: 'extension', ofertas: [oferta(0, 'ml')] });
  regraCatalogo(s.db, { janela: ['08:00', '09:00'] });
  for (let h = 0; h < 8; h++) { await s.scheduler.tick(); s.avancar(HORA); }
  assert.deepEqual(s.execucoes(), []);
  assert.deepEqual(s.avisosDoVigia(), []);
  assert.deepEqual(s.scheduler.vigia.estado().causas, []);
});

// =================================================================================================== CA3.11

test('CA3.11: vigia que lança — o tick roda os envios, os avisos e as regras; o console leva só o código', async (t) => {
  const s = montar(t, { ofertas: [oferta(0, 'ml'), oferta(1, 'ml')] });
  regraCatalogo(s.db);
  const saida = capturarConsole(t);
  let chamadas = 0;
  s.scheduler.vigia.tick = s.scheduler.vigia.aposExecucao = () => { chamadas++; throw new Error('fulano 11987654321'); };
  const passos = { envios: 0, avisos: 0 };
  const { processarPendentes } = s.scheduler.envios; const tickAvisos = s.scheduler.avisos.tick;
  s.scheduler.envios.processarPendentes = (...a) => { passos.envios++; return processarPendentes(...a); };
  s.scheduler.avisos.tick = (...a) => { passos.avisos++; return tickAvisos(...a); };
  await s.scheduler.tick();
  assert.equal(chamadas, 2, 'logo depois dos avisos e depois da regra');
  assert.equal(s.paraGrupo(), 1, 'a regra mandou a oferta');
  assert.deepEqual(passos, { envios: 2, avisos: 1 }, 'envios antes e depois da regra; avisos uma vez');
  assert.equal(s.execucoes().length, 1);
  assert.deepEqual(saida.filter((l) => l.startsWith('[agendador] vigia:')), ['[agendador] vigia: Error', '[agendador] vigia: Error']);
  assert.ok(!saida.join('\n').includes('fulano'), 'a mensagem do erro não vai ao console');
});

test('CA3.11: vigia sem leitura — ok=false no /api/state, uma linha aviso por sequência de falhas, as regras seguem', async (t) => {
  const s = montar(t, { ofertas: [0, 1, 2, 3, 4, 5, 6].map((i) => oferta(i, 'ml')) });
  regraCatalogo(s.db);
  const saida = capturarConsole(t);
  await s.scheduler.tick();
  assert.equal(s.scheduler.vigia.estado().ok, true);
  s.db.exec('DROP TABLE execucoes'); // o vigia não consegue ler; a gravação da execução também falha (só console)
  for (let i = 0; i < 3; i++) { s.avancar(HORA); await s.scheduler.tick(); }
  assert.equal(s.paraGrupo(), 4, 'as regras seguiram: uma oferta por execução');
  const p = await subirPainel(t, s);
  const st = await req(p.port, '/api/state');
  assert.equal(st.json.vigia.ok, false);
  assert.deepEqual(st.json.vigia.causas, []);
  assert.deepEqual(s.linhasVigia(), [{ level: 'aviso', message: TEXTO_SEM_LEITURA }], 'uma linha por sequência, nunca erro');
  assert.ok(saida.some((l) => l === '[vigia] sem leitura agora: ERR_SQLITE_ERROR'));
  // a tabela volta: a leitura volta sem linha nova; uma nova sequência de falhas ganha a sua linha
  openDb(s.dir).close();
  s.avancar(HORA); await s.scheduler.tick();
  assert.equal(s.scheduler.vigia.estado().ok, true);
  assert.equal(s.execucoes().length, 1);
  s.db.exec('DROP TABLE execucoes');
  s.avancar(HORA); await s.scheduler.tick();
  assert.deepEqual(s.linhasVigia().map((l) => l.message), [TEXTO_SEM_LEITURA, TEXTO_SEM_LEITURA]);
  assert.equal(s.paraGrupo(), 6);
});
