// Verificador, entrega 2, etapa 5 (docs/produto/planos/verificador-ml-extensao.md; CA1 a CA5 e CA8): ponta a ponta
// do Mercado Livre pela extensão, sem rede. O servidor sobe como o main (criarServicos com `verificar: true`, links em
// modo `extension`, WhatsApp simulado, buildApp em 127.0.0.1) e uma extensão simulada conversa com ele por HTTP, como a
// de verdade: GET /api/ext/poll (x-token e x-recursos) e POST /api/ext/result. Ela responde ao `produto_ml` com o
// `data` produzido pelas funções puras do extension/background.js (extraídas pelos marcadores e rodadas num `vm`) sobre
// páginas HTML de fixture, e ao `link` com um meli.la. Nada do ML nem do WhatsApp é real: o `fetch` global lança e é
// contado; do `ml` injetado, só o resolveOffer (o Disparo manual ao criar) é trocado, e a leitura do verificador
// (conferirProduto) acusa qualquer uso pelo servidor.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { openDb, getSetting } from '../src/db.js';
import { buildApp, criarServicos } from '../src/server.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createLinkService } from '../src/links.js';
import { amostraHub } from '../src/afiliados.js';
import { paraCandidato } from '../src/catalogo.js';
import { CAUSAS } from '../src/verificador.js';
import * as mlReal from '../src/ml.js';

// ------------------------------------------------------------------------------------------- sem rede nenhuma
const fetchOriginal = globalThis.fetch;
let acessosRede = 0;
const redeProibida = async () => { acessosRede++; throw new Error('rede proibida no teste'); };
globalThis.fetch = redeProibida;
after(() => { globalThis.fetch = fetchOriginal; });

const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-verif-mlext-')); pastas.push(p); return p; };

// ---------------------------------------------------- as funções puras da extensão (mesmo trecho dos outros testes)
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FONTE = fs.readFileSync(path.join(RAIZ, 'extension', 'background.js'), 'utf8');
const INI = FONTE.indexOf('// ---- Mercado Livre produto: funções puras (início) ----');
const FIM = FONTE.indexOf('// ---- Mercado Livre produto: funções puras (fim) ----');
assert.ok(INI > 0 && FIM > INI, 'não achei os marcadores do trecho do produto do ML em extension/background.js');
const X = (() => {
  const ctx = vm.createContext({ URL, TextDecoder });
  vm.runInContext(`${FONTE.slice(INI, FIM)};globalThis.__x = { urlProdutoML, estadoDaResposta, corpoDaPaginaML, ofertasDoHtml };`, ctx);
  return ctx.__x;
})();

// ----------------------------------------------------------------------------------------------- fixtures
const ML = 'https://www.mercadolivre.com.br';
const EM_ESTOQUE = 'https://schema.org/InStock';
const ESGOTADO = 'https://schema.org/OutOfStock';
const SEGREDO_PAGINA = 'SEGREDO-DA-PAGINA-LOGADA'; // só existe no HTML: nunca pode chegar ao servidor
// Evidência real (Chrome logado do dono, 09/11/2026): o anúncio cai na página de catálogo, com um único JSON-LD
// ProductGroup e as ofertas em hasVariant (o item do anúncio é o do pdp_filters).
const ITEM_154 = 'MLB5257531512';
const ITEM_159 = 'MLB5257443218';
const URL_154 = `https://produto.mercadolivre.com.br/MLB-${ITEM_154.slice(3)}`;
const URL_159 = `${ML}/fritadeira-boa/p/MLB15142194?pdp_filters=item_id:${ITEM_159}`;
const URL_ESGOTADO = 'https://produto.mercadolivre.com.br/MLB-2000000002';
const URL_SEM_LD = 'https://produto.mercadolivre.com.br/MLB-2000000003';
const URL_VERIFICACAO = 'https://produto.mercadolivre.com.br/MLB-2000000004';
const URL_CARO = 'https://produto.mercadolivre.com.br/MLB-2000000005';

const variante = (sku, price) => ({ '@type': 'Product', sku, name: `Fritadeira ${sku}`, offers: { '@type': 'Offer', price, priceCurrency: 'BRL', availability: EM_ESTOQUE } });
const ld = (obj) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;
const pagina = (...blocos) => `<html><head><title>${SEGREDO_PAGINA}</title>
<script id="__NORDIC_RENDERING_CTX__">{"offers":{"type":"Offer","price":999.99,"availability":"${EM_ESTOQUE}"}}</script>
${blocos.join('\n')}</head><body><a href="/minha-conta">${SEGREDO_PAGINA}</a></body></html>`;
const produtoLd = (price, availability = EM_ESTOQUE) => ld({ '@context': 'https://schema.org', '@type': 'Product', name: 'Fone Bom', offers: { '@type': 'Offer', price, availability } });
const PAGINA_CATALOGO = pagina(ld({ '@context': 'https://schema.org', '@type': 'ProductGroup', name: 'Fritadeira Boa', hasVariant: [variante(ITEM_154, 154.99), variante(ITEM_159, 159)] }));

/** O que o fetch do service worker devolveria para cada endereço: { status, url final, html }. Fora da lista: 404. */
function paginaDe(url) {
  const id = /MLB-?(\d+)/.exec(url)?.[1];
  if (url === URL_154) return { status: 200, url: `${ML}/fritadeira-boa/p/MLB15142194?pdp_filters=item_id:${ITEM_154}`, html: PAGINA_CATALOGO };
  if (url === URL_159) return { status: 200, url, html: PAGINA_CATALOGO };
  if (url === URL_ESGOTADO) return { status: 200, url, html: pagina(produtoLd(100, ESGOTADO)) };
  if (url === URL_SEM_LD) return { status: 200, url, html: pagina('<script type="application/json">{"price":100}</script>') };
  if (url === URL_VERIFICACAO) return { status: 200, url: `${ML}/gz/account-verification?go=${encodeURIComponent(url)}`, html: pagina() };
  if (url === URL_CARO) return { status: 200, url, html: pagina(produtoLd(120)) };
  if (id === '9000001') return { status: 200, url, html: pagina(produtoLd(69.9)) }; // Central de exemplo (amostraHub)
  if (id === '9000002') return { status: 200, url, html: pagina(produtoLd(29.9)) };
  // Central com o catálogo de duas versões (R1): /p/MLB9000011 e /p/MLB9000012, com ou sem o anúncio no pdp_filters
  if (id === '9000011' || id === '9000012') return { status: 200, url, html: PAGINA_CATALOGO };
  return { status: 404, url, html: '' };
}
/** Preço que o Disparo manual lê ao criar (resolveOffer) e que o verificador usa como referência. */
const PRECO_AO_CRIAR = new Map([[URL_154, 154.99], [URL_159, 159]]);
const precoAoCriar = (url) => PRECO_AO_CRIAR.get(url) ?? ({ 9000001: 69.9, 9000002: 29.9, 9000011: 154.99, 9000012: 159 })[/MLB-?(\d+)/.exec(url)?.[1]] ?? 100;

// ------------------------------------------------------------------------------------------------- HTTP cru
/** Requisição por `http` (o fetch global está bloqueado de propósito). */
function req(port, caminho, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((ok, err) => {
    const data = body != null ? JSON.stringify(body) : null;
    const h = { host: `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers };
    const r = http.request({ host: '127.0.0.1', port, path: caminho, method, headers: h }, (res) => {
      let txt = ''; res.setEncoding('utf8'); res.on('data', (c) => (txt += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(txt); } catch { /* html */ } ok({ status: res.statusCode, json, txt }); });
    });
    r.on('error', err); if (data) r.write(data); r.end();
  });
}

// ------------------------------------------------------------------------------------------------- servidor
const G1 = '111@g.us';
const G2 = '222@g.us';
const CORPO = '{TITULO_PRODUTO}\nPor {PRECO_PRODUTO}[ (de {PRECO_ANTIGO})][ {DESCONTO_PRODUTO} OFF]\n[🕒 Preço visto às {HORA_PRECO}]\n{LINK}';

/** Sobe como o main: criarServicos (verificador ligado, links em `extension`) + buildApp, sem login e sem Host fixo. */
function subir() {
  const dir = tmp();
  const db = openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'extension' });
  const leituras = []; // qualquer leitura do ML feita PELO SERVIDOR na conferência (D5): tem de ficar vazia
  const ml = {
    ...mlReal, // o agendador usa candidates, rejectReason… de verdade; só estas duas leituras são trocadas
    async resolveOffer(c) {
      return { key: c.key, url: c.url, title: 'Fone Bom', price: precoAoCriar(c.url), oldPrice: 300, discountPct: 50, sold: 10, freeShipping: false, image: null };
    },
    async conferirProduto(url) { leituras.push(url); throw new Error('o servidor não pode ler o ML no modo extensão'); },
  };
  const servicos = criarServicos({ db, wa, links, fast: true, dir, ml, fetch: redeProibida, verificar: true });
  const app = buildApp({ db, wa, links, scheduler: servicos.scheduler, ml, publicHost: '', panelPassword: '' });
  for (const [jid, nome] of [[G1, 'Achadinhos'], [G2, 'Tech']]) {
    db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, nome, 10, Date.now());
  }
  const tag = Number(db.prepare('INSERT INTO tags (name, created_at) VALUES (?, 1)').run('etiquetaA').lastInsertRowid);
  const tpl = Number(db.prepare('INSERT INTO templates (name, body, created_at) VALUES (?,?,?)').run('Com hora', CORPO, Date.now()).lastInsertRowid);
  const token = getSetting(db, 'ext_token');
  return new Promise((ok) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      ok({
        db, dir, port, wa, links, ml, leituras, servicos, scheduler: servicos.scheduler, verificador: servicos.verificador, token, tag, tpl,
        origin: `http://127.0.0.1:${port}`,
        fechar: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => { db.close(); r(); }); }),
      });
    });
  });
}

/**
 * A extensão simulada: o mesmo laço do background.js (poll, executa um pedido, devolve) por HTTP. `recursos` é o que o
 * poll anuncia em x-recursos (null = a 1.4.2, sem o cabeçalho). `vistos` guarda os pedidos recebidos; `devolvidos`, as
 * respostas, que são exatamente o que a extensão manda ao servidor.
 */
function extensao(s, { recursos = 'produto_ml', laco: comLaco = true } = {}) {
  const cab = { 'x-token': s.token, ...(recursos ? { 'x-recursos': recursos } : {}) };
  const vistos = []; const devolvidos = [];
  let parar = false;

  async function pollUma() { return (await req(s.port, '/api/ext/poll', { headers: cab })).json?.job ?? null; }

  /** O que a extensão responde a um pedido: link → meli.la; produto_ml → o `data` das funções puras sobre a página. */
  async function resposta(job) {
    if (job.type === 'link') return { ok: true, link: `https://meli.la/E2e${job.id}` };
    if (job.type !== 'produto_ml') return { ok: false, error: 'pedido desconhecido' };
    const url = X.urlProdutoML(job.url);
    if (!url) return { ok: false, error: 'endereço de produto do Mercado Livre recusado pela extensão' };
    const pg = paginaDe(url);
    const r = new Response(pg.html, { status: pg.status });
    Object.defineProperty(r, 'url', { value: pg.url });
    const v = X.estadoDaResposta(r.status, r.url);
    if (v.erro) return { ok: false, error: v.erro };
    if (!v.ler) return { ok: true, data: { estado: 'verificacao' } };
    return { ok: true, data: { estado: 'lido', ofertas: X.ofertasDoHtml(await X.corpoDaPaginaML(r)) } };
  }

  async function responder(job) {
    const r = await resposta(job);
    devolvidos.push(plano({ tipo: job.type, ...r }));
    const ret = await req(s.port, '/api/ext/result', { method: 'POST', headers: { 'x-token': s.token }, body: { id: job.id, ...r } });
    assert.deepEqual([ret.status, ret.json], [200, { ok: true }]);
  }

  // `laco: false`: quem conduz o poll e as respostas é o teste (pollUma e responder)
  const laco = !comLaco ? null : (async () => {
    while (!parar) {
      const job = await pollUma();
      if (!job) continue;
      vistos.push(job);
      await responder(job);
    }
  })().catch(() => {});

  return {
    vistos, devolvidos, pollUma, responder,
    tipos: () => vistos.map((j) => j.type),
    async parar() {
      parar = true;
      if (!laco) return;
      // o poll em andamento só termina com um pedido (ou em 20 s): um link de brinde o resolve, e o laço sai. Se o laço
      // já saiu sozinho (estava entre dois polls), não há poll para resolver e o brinde só vence o prazo de 1 s, sem prender o teste
      s.links.requestLink({ url: URL_154, tag: 'x', timeoutMs: 1000 }).catch(() => {});
      await laco;
    },
  };
}

/** Espera o servidor registrar o poll da extensão (ela fica on-line e o recurso anunciado vale). */
async function ligada(s, ext) {
  const t0 = Date.now();
  while (s.links.status().lastPollAt < t0 - 5 || !s.links.status().online) {
    assert.ok(Date.now() - t0 < 3000, 'a extensão simulada não fez poll');
    await new Promise((ok) => setTimeout(ok, 5));
  }
  return ext;
}

const plano = (v) => JSON.parse(JSON.stringify(v)); // objetos do vm têm outro protótipo
const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));
const envio = (s, id) => ({ ...s.db.prepare('SELECT * FROM envios WHERE id = ?').get(id) });
const resultadoDe = (s, id) => JSON.parse(envio(s, id).resultado);
const logs = (s) => s.db.prepare('SELECT rule_name, level, group_name, offer_title, message FROM log ORDER BY id').all().map((l) => ({ ...l }));
const niveis = (s) => logs(s).map((l) => l.level);
const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}h${String(d.getMinutes()).padStart(2, '0')}`;

/** Disparo manual "agora" pelo POST /api/envios (como o painel) e espera o envio terminar. → { id, ... , status } */
async function disparar(s, url, { grupos = [G1] } = {}) {
  const r = await req(s.port, '/api/envios', { method: 'POST', headers: { origin: s.origin },
    body: { tipo: 'oferta', url, tag_id: s.tag, template_id: s.tpl, group_jids: grupos, quando: 'agora' } });
  assert.equal(r.status, 200, r.txt);
  const t0 = Date.now();
  while (['pendente', 'enviando'].includes(envio(s, r.json.id).status)) {
    assert.ok(Date.now() - t0 < 5000, 'o envio não terminou');
    await esperar(5);
  }
  return { id: r.json.id, ...envio(s, r.json.id) };
}

/** Roda `corpo` com o servidor e a extensão no ar e desliga os dois no fim (a extensão antes do servidor). */
async function comExtensao(opcoes, corpo) {
  const s = await subir();
  const ext = extensao(s, opcoes);
  try {
    await ligada(s, ext);
    await corpo(s, ext);
  } finally {
    await ext.parar();
    await s.fechar();
  }
}

// --------------------------------------------------------------------------------- Disparo manual "agora"

test('CA1/CA2/CA5: Disparo manual "agora" do ML é conferido pela extensão e sai com {HORA_PRECO}; o link vem depois da conferência; o servidor não lê o ML', async () => {
  await comExtensao({}, async (s, ext) => {
    const antes = new Date();
    const r = await disparar(s, URL_154, { grupos: [G1, G2] });
    const depois = new Date();
    assert.equal(r.status, 'concluido', r.resultado);

    assert.deepEqual(ext.tipos(), ['produto_ml', 'link'], 'uma conferência por envio (não por grupo) e só então o link');
    assert.equal(ext.vistos[0].url, URL_154, 'a extensão recebe só o endereço do produto');
    assert.deepEqual(Object.keys(ext.vistos[0]).sort(), ['id', 'type', 'url']);
    assert.deepEqual(s.leituras, [], 'no modo extensão o servidor nunca lê a página nem a API do ML (D5)');

    assert.equal(s.wa.simulated.length, 2);
    const horas = new Set([hhmm(antes), hhmm(depois)]);
    for (const m of s.wa.simulated) {
      const hora = /Preço visto às (\d{2}h\d{2})\n/.exec(m.text)?.[1];
      assert.ok(horas.has(hora), `{HORA_PRECO} com a hora da conferência: ${hora}`);
      assert.match(m.text, /Por R\$ 154,99 /, 'a variante do anúncio (MLB5257531512), não a outra');
      assert.match(m.text, /\nhttps:\/\/meli\.la\/E2e\d+$/, 'o link de afiliado gerado pela extensão depois da conferência');
    }
    assert.deepEqual(logs(s).map((l) => [l.level, l.group_name, l.message]),
      [['ok', 'Achadinhos', 'Enviado com a etiqueta etiquetaA'], ['ok', 'Tech', 'Enviado com a etiqueta etiquetaA']], 'conferido sem mudança de preço: sem sufixo');
  });
});

test('CA2: o servidor escolhe a variante pelo item do anúncio: o mesmo catálogo com outro item_id confere o preço da outra variante', async () => {
  await comExtensao({}, async (s, ext) => {
    // o preço ao criar (159) é o da variante MLB5257443218; se o servidor lesse a primeira (154,99), o texto sairia com "preço atualizado"
    const r = await disparar(s, URL_159);
    assert.equal(r.status, 'concluido', r.resultado);
    assert.deepEqual(ext.tipos(), ['produto_ml', 'link']);
    assert.match(s.wa.simulated[0].text, /Por R\$ 159,00 /);
    assert.deepEqual(logs(s).map((l) => l.message), ['Enviado com a etiqueta etiquetaA']);
    // a extensão devolveu as duas variantes e o servidor escolheu; nada de HTML nem de URL na resposta
    const dados = ext.devolvidos.find((d) => d.tipo === 'produto_ml').data;
    assert.equal(dados.estado, 'lido');
    assert.deepEqual(dados.ofertas.map((o) => o.variantes.map((v) => v.sku)), [[ITEM_154, ITEM_159]]);
  });
});

test('CA2: esgotado (OutOfStock no JSON-LD) é descartado com aviso, nunca erro: sem link, sem mensagem nos grupos', async () => {
  await comExtensao({}, async (s, ext) => {
    const r = await disparar(s, URL_ESGOTADO, { grupos: [G1, G2] });
    assert.equal(r.status, 'erro', 'o descartado termina em erro na fila, mas o Histórico o trata como aviso');
    assert.deepEqual(resultadoDe(s, r.id), { ok: 0, erro: 2, motivo: 'Descartada: esgotado na loja', descartado: 'esgotado' });
    assert.deepEqual(ext.tipos(), ['produto_ml'], 'a descartada não pede link');
    assert.equal(s.wa.simulated.length, 0);
    assert.deepEqual(logs(s).map((l) => [l.level, l.offer_title, l.message]), [['aviso', 'Fone Bom', 'Descartada: esgotado na loja']]);
    assert.ok(!niveis(s).includes('erro'));
  });
});

test('CA2: preço acima do limite é descartado com os dois preços e sem link', async () => {
  await comExtensao({}, async (s, ext) => {
    const r = await disparar(s, URL_CARO); // criou a R$ 100,00; a página diz R$ 120,00
    assert.deepEqual(resultadoDe(s, r.id), {
      ok: 0, erro: 1, motivo: 'Descartada: preço subiu de R$ 100,00 para R$ 120,00 (+20%, o limite é 5%)', descartado: 'preco_subiu',
    });
    assert.deepEqual(ext.tipos(), ['produto_ml']);
    assert.equal(s.wa.simulated.length, 0);
    assert.deepEqual(logs(s).map((l) => l.level), ['aviso']);
  });
});

test('CA2: página sem JSON-LD é sem conferência (sem_preco): o "agora" sai com o aviso na linha ok, sem {HORA_PRECO}, e depois pede o link', async () => {
  await comExtensao({}, async (s, ext) => {
    const r = await disparar(s, URL_SEM_LD);
    assert.equal(r.status, 'concluido', r.resultado);
    assert.deepEqual(ext.tipos(), ['produto_ml', 'link']);
    assert.deepEqual(ext.devolvidos[0].data, { estado: 'lido', ofertas: [] });
    assert.doesNotMatch(s.wa.simulated[0].text, /Preço visto/, 'sem conferência, {HORA_PRECO} vazio e o trecho entre [ ] some');
    assert.deepEqual(logs(s).map((l) => [l.level, l.message]), [['ok', 'Enviado com a etiqueta etiquetaA · preço não conferido (a página não trouxe o preço)']]);
  });
});

// ------------------------------------------------------------------------------------------------ CA3, CA4

test('CA3: o ML pediu verificação no navegador: o envio sai com essa causa, a extensão não é mais incomodada por 30 min e nada vai como erro', async () => {
  await comExtensao({}, async (s, ext) => {
    const um = await disparar(s, URL_VERIFICACAO);
    assert.equal(um.status, 'concluido', um.resultado);
    assert.deepEqual(ext.devolvidos[0].data, { estado: 'verificacao' }, 'a extensão só diz que houve verificação (sem a página, sem o endereço)');
    assert.deepEqual(logs(s).map((l) => [l.level, l.message]), [['ok', `Enviado com a etiqueta etiquetaA · preço não conferido (${CAUSAS.ml_verificacao})`]]);
    assert.equal(CAUSAS.ml_verificacao, 'o Mercado Livre pediu verificação no navegador');
    assert.deepEqual(ext.tipos(), ['produto_ml', 'link']);

    // pausa: o próximo produto (mesmo um que estaria bom) nem chega à extensão; só o link
    const dois = await disparar(s, URL_154);
    assert.equal(dois.status, 'concluido', dois.resultado);
    assert.deepEqual(ext.tipos(), ['produto_ml', 'link', 'link'], 'em pausa, nenhum produto_ml vai à extensão');
    assert.equal(logs(s).at(-1).message, `Enviado com a etiqueta etiquetaA · preço não conferido (${CAUSAS.ml_verificacao})`);
    assert.ok(!niveis(s).includes('erro'));
    assert.deepEqual(s.leituras, []);
  });
});

test('CA3/CA4: sem conferência, o envio com dados de mais de 30 min não sai (nao_conferido) e o de 29 min sai, com a causa da verificação', async () => {
  await comExtensao({}, async (s) => {
    const modelo = await disparar(s, URL_154); // um envio de verdade, só para copiar o payload
    await disparar(s, URL_VERIFICACAO); // o ML pede verificação: liga a pausa
    const MIN = 60 * 1000;
    const gravar = (idadeMs) => {
      const agora = Date.now();
      return Number(s.db.prepare(`INSERT INTO envios (tipo, payload, group_jids, quando, status, next_run_at, created_at)
        VALUES ('oferta', ?, ?, 'agora', 'pendente', ?, ?)`).run(modelo.payload, modelo.group_jids, agora, agora - idadeMs).lastInsertRowid);
    };
    const recente = gravar(29 * MIN);
    const velho = gravar(31 * MIN);
    const enviadas = s.wa.simulated.length;
    await s.scheduler.envios.processarPendentes();
    assert.equal(envio(s, recente).status, 'concluido');
    assert.equal(s.wa.simulated.length, enviadas + 1, 'só o de 29 min saiu');
    assert.match(logs(s).filter((l) => l.level === 'ok').at(-1).message, new RegExp(`preço não conferido \\(${CAUSAS.ml_verificacao}\\)$`), 'o de 29 min sai com a causa no Histórico');
    assert.deepEqual(resultadoDe(s, velho), {
      ok: 0, erro: 1, motivo: `Descartada: não deu para conferir o preço (${CAUSAS.ml_verificacao})`, descartado: 'nao_conferido',
    });
    assert.ok(!niveis(s).includes('erro'));
  });
});

test('CA4: extensão desconectada: sem pedido na fila, a causa é "não está conectada" e vale a regra dos 30 min; o console não leva a URL', async (t) => {
  const espiao = t.mock.method(console, 'error', () => {});
  const s = await subir(); // nenhuma extensão fez poll
  try {
    const oferta = { loja: 'mercadolivre', url: URL_154, price: 154.99, title: 'Fone Bom' };
    const fresco = await s.verificador.conferir(oferta, { lidoEm: Date.now() });
    assert.equal(fresco.acao, 'enviar');
    assert.equal(fresco.conferido, false);
    assert.equal(fresco.sufixo, ` · preço não conferido (${CAUSAS.extensao_off})`);
    assert.equal(CAUSAS.extensao_off, 'a extensão do Chrome não está conectada');

    const MIN = 60 * 1000;
    assert.equal((await s.verificador.conferir(oferta, { lidoEm: Date.now() - 29 * MIN })).acao, 'enviar');
    const velho = await s.verificador.conferir(oferta, { lidoEm: Date.now() - 31 * MIN });
    assert.deepEqual([velho.acao, velho.motivo, velho.texto], ['descartar', 'nao_conferido', `Descartada: não deu para conferir o preço (${CAUSAS.extensao_off})`]);
    assert.equal(s.links.status().pending, 0, 'nada ficou na fila da extensão');
    assert.deepEqual(s.leituras, []);
    const consoleTexto = espiao.mock.calls.map((c) => c.arguments.map(String).join(' ')).join('\n');
    assert.ok(!consoleTexto.includes('mercadolivre.com.br'));
  } finally { await s.fechar(); }
});

// ----------------------------------------------------------------------------------------- regras (Central)

/** Regra da Central de Afiliados; a lista vem da amostra (o pedido de `ofertas` à extensão não é o assunto aqui). */
function regraCentral(s, { per = 2 } = {}) {
  s.links.requestOffers = async () => amostraHub();
  return Number(s.db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id, group_jids, source_type, source_config, per_run,
    interval_min, window_start, window_end, dedupe_days, send_image, created_at)
    VALUES ('Central', 1, ?, ?, ?, 'afiliados', ?, ?, 60, '00:00', '23:59', 7, 0, ?)`)
    .run(s.tag, s.tpl, JSON.stringify([G1]), JSON.stringify({ categoria: 'MLB1574', paginas: 1 }), per, Date.now()).lastInsertRowid);
}
const logsDaRegra = (s, id) => s.db.prepare('SELECT level, offer_title, message FROM log WHERE rule_id = ? ORDER BY id').all(id).map((l) => ({ ...l }));

test('CA1/CA2: a regra da Central confere cada oferta antes do link, pela extensão, e sai com {HORA_PRECO}', async () => {
  await comExtensao({}, async (s, ext) => {
    const id = regraCentral(s);
    const r = await s.scheduler.runRule(id);
    assert.deepEqual([r.offers, r.messages, r.errors, r.descartadas], [2, 2, 0, 0]);
    assert.deepEqual(ext.tipos(), ['produto_ml', 'link', 'produto_ml', 'link'], 'a conferência vem antes do link, oferta a oferta');
    assert.deepEqual(s.leituras, []);
    for (const m of s.wa.simulated) assert.match(m.text, /Preço visto às \d{2}h\d{2}/);
    assert.deepEqual(logsDaRegra(s, id).map((l) => l.level), ['ok', 'ok']);
    assert.deepEqual(logsDaRegra(s, id).map((l) => l.message), ['Enviado com a etiqueta etiquetaA', 'Enviado com a etiqueta etiquetaA']);
  });
});

test('R1: regra da Central com /p/MLB… sem pdp_filters e catálogo de 2 versões: com o anúncio no metadata.id confere a versão dele; sem ele, sai sem conferir ("várias versões")', async () => {
  await comExtensao({}, async (s, ext) => {
    const id = regraCentral(s);
    // a Central de verdade: metadata.id é o anúncio e o endereço é o do catálogo (product_id); a amostra usa o mesmo número
    const pg = amostraHub();
    const [a, b] = pg[0].polycard_client_model.polycards;
    a.metadata = { ...a.metadata, id: ITEM_159, product_id: 'MLB9000012', url: 'www.mercadolivre.com.br/produto-exemplo/p/MLB9000012' };
    b.metadata = { ...b.metadata, id: 'MLB9000011', product_id: 'MLB9000011', url: 'www.mercadolivre.com.br/produto-exemplo/p/MLB9000011' };
    s.links.requestOffers = async () => pg;
    const r = await s.scheduler.runRule(id);
    assert.deepEqual([r.offers, r.messages, r.errors, r.descartadas], [2, 2, 0, 0]);
    assert.deepEqual(ext.vistos.filter((j) => j.type === 'produto_ml').map((j) => j.url), [
      `${ML}/produto-exemplo/p/MLB9000012?pdp_filters=item_id:${ITEM_159}`, `${ML}/produto-exemplo/p/MLB9000011`,
    ]);
    // a 1ª: a variante do anúncio (R$ 159, não a de R$ 154,99), conferida; a 2ª: as duas à venda, a mais barata dentro do
    // limite, mas o link não diz qual é a do anúncio → sem conferência, nunca "conferido" pelo preço de outra versão
    assert.match(s.wa.simulated[0].text, /Por R\$ 159,00 [\s\S]*Preço visto às \d{2}h\d{2}/);
    assert.doesNotMatch(s.wa.simulated[1].text, /Preço visto/);
    assert.match(s.wa.simulated[1].text, /Por R\$ 154,99 /, 'o preço da oferta fica o da Central, sem "atualizar" para o de uma versão');
    assert.deepEqual(logsDaRegra(s, id).map((l) => [l.level, l.message]), [
      ['ok', 'Enviado com a etiqueta etiquetaA'],
      ['ok', `Enviado com a etiqueta etiquetaA · preço não conferido (${CAUSAS.varias_versoes})`],
    ]);
    assert.equal(CAUSAS.varias_versoes, 'o produto tem várias versões e o link não diz qual');
    assert.deepEqual(s.leituras, []);
  });
});

test('CA4/CA7: extensão antiga (poll sem x-recursos): nenhum produto_ml é entregue a ela; a Central sai com "precisa ser recarregada" e os links seguem', async () => {
  await comExtensao({ recursos: null }, async (s, ext) => {
    const id = regraCentral(s);
    const r = await s.scheduler.runRule(id);
    assert.deepEqual([r.offers, r.messages, r.errors, r.descartadas], [2, 2, 0, 0]);
    assert.deepEqual(ext.tipos(), ['link', 'link'], 'a 1.4.2 nunca recebe o pedido novo (trataria como link sem etiqueta)');
    assert.equal(CAUSAS.extensao_antiga, 'a extensão do Chrome precisa ser recarregada');
    assert.deepEqual(logsDaRegra(s, id).map((l) => l.message), Array(2).fill(`Enviado com a etiqueta etiquetaA · preço não conferido (${CAUSAS.extensao_antiga})`));
    for (const m of s.wa.simulated) assert.doesNotMatch(m.text, /Preço visto/);
    assert.deepEqual(s.leituras, []);
    assert.ok(!niveis(s).includes('erro'));
  });
});

// --------------------------------------------------------------------------------------- regra do Catálogo

const regraCatalogo = (s) => Number(s.db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id, group_jids, source_type, source_config,
  sources, per_run, interval_min, window_start, window_end, dedupe_days, send_image, created_at)
  VALUES ('Catálogo', 1, ?, ?, ?, 'list', '{}', ?, 5, 60, '00:00', '23:59', 7, 0, ?)`)
  .run(s.tag, s.tpl, JSON.stringify([G1]), JSON.stringify([{ type: 'catalogo', tag_id: null, config: { ordem: 'relevancia' } }]), Date.now()).lastInsertRowid);

test('CA1/CA2: regra do Catálogo com itens do ML: o conferido sai sozinho (não vai à revisão), o esgotado é descartado e o sem preço vai à revisão; o link só depois da conferência', async () => {
  await comExtensao({}, async (s, ext) => {
    const of = (n, preco) => ({ id: n, loja: 'ml', titulo: `Produto ${n}`, preco, preco_antigo: 300, desconto_pct: 50, categoria: 'Casa', item_id: `MLB${n}`, link: 'https://meli.la/TerCeiro1' });
    const lista = [of(5257531512, 154.99), of(2000000002, 100), of(2000000003, 100)];
    // só a lista de ofertas do Etiqueta é trocada; o resto do catálogo, do agendador e do verificador é o de verdade
    s.servicos.catalogo.candidatos = async (cfg, { tratada }) => lista.map(paraCandidato).filter((c) => c && !tratada(c, cfg.ordem));
    const id = regraCatalogo(s);

    const r = await s.scheduler.runRule(id);
    assert.deepEqual([r.offers, r.messages, r.errors, r.revisao, r.descartadas], [1, 1, 0, 1, 1]);
    const itens = s.db.prepare('SELECT chave, status, motivos FROM catalogo_itens WHERE rule_id = ? ORDER BY id').all(id).map((l) => [l.chave, l.status, JSON.parse(l.motivos)]);
    assert.deepEqual(itens, [['MLB5257531512', 'enviado', []], ['MLB2000000002', 'descartado', []], ['MLB2000000003', 'revisao', ['nao_conferido']]]);
    assert.deepEqual(ext.tipos(), ['produto_ml', 'link', 'produto_ml', 'produto_ml'], 'só o item conferido pede link');
    assert.equal(s.wa.simulated.length, 1);
    assert.match(s.wa.simulated[0].text, /Preço visto às \d{2}h\d{2}/);
    assert.match(s.wa.simulated[0].text, /\nhttps:\/\/meli\.la\/E2e\d+$/, 'o link de afiliado é o da extensão, não o do terceiro');
    assert.deepEqual(logsDaRegra(s, id).map((l) => [l.level, l.offer_title, l.message]), [
      ['ok', 'Produto 5257531512', 'Enviado com a etiqueta etiquetaA'],
      ['aviso', 'Produto 2000000002', 'Descartada: esgotado na loja'],
      ['aviso', 'Produto 2000000003', 'Separada para revisão: não deu para conferir o preço (a página não trouxe o preço).'],
    ]);
    assert.ok(!niveis(s).includes('erro'));
    assert.deepEqual(s.leituras, []);
  });
});

// ------------------------------------------------------------------------------------------ CA5: ordem na fila

test('CA5: link e produto juntos na fila: o link pedido depois sai antes do produto que espera; o produto parado não o atrasa', async () => {
  const s = await subir();
  const ext = extensao(s, { laco: false }); // este teste conduz o poll e as respostas à mão
  try {
    const primeiro = ext.pollUma(); // um poll em andamento marca a extensão on-line e anuncia produto_ml
    await ligada(s, ext);
    const oferta = (url) => ({ loja: 'mercadolivre', url, price: 100, title: 'Fone Bom' });

    // a extensão fica ocupada com o produto A (entregue ao poll que esperava)
    const a = s.verificador.conferir(oferta(URL_CARO), { lidoEm: Date.now() });
    const jobA = await primeiro;
    assert.deepEqual([jobA.type, jobA.url], ['produto_ml', URL_CARO]);

    // enquanto isso: o produto B entra na fila, e depois um link
    const b = s.verificador.conferir({ ...oferta(URL_154), price: 154.99 }, { lidoEm: Date.now() });
    await esperar(20);
    assert.equal(s.links.status().pending, 1, 'o produto B espera na fila');
    const l = s.links.requestLink({ url: URL_154, tag: 'etiquetaA', timeoutMs: 5000 });
    assert.equal(s.links.status().pending, 2);

    await ext.responder(jobA); // a extensão termina A e volta a pedir trabalho
    const j2 = await ext.pollUma();
    assert.equal(j2.type, 'link', 'o link passa na frente do produto B, que entrou antes');
    await ext.responder(j2);
    const j3 = await ext.pollUma();
    assert.deepEqual([j3.type, j3.url], ['produto_ml', URL_154]);
    await ext.responder(j3);

    assert.match(await l, /^https:\/\/meli\.la\/E2e\d+$/);
    const [ra, rb] = await Promise.all([a, b]);
    assert.deepEqual([ra.acao, rb.acao], ['descartar', 'enviar'], 'A: a página diz R$ 120 contra R$ 100 (acima do limite); B: R$ 154,99 conferido');
  } finally {
    await s.fechar();
  }
});

test('CA7: o produto que espera na fila nunca vai a uma extensão que não anunciou produto_ml (a 1.4.2 que assume o poll); o link vai', async () => {
  const s = await subir();
  const nova = extensao(s, { laco: false });
  const antiga = extensao(s, { recursos: null, laco: false });
  try {
    const primeiro = nova.pollUma();
    await ligada(s, nova);
    const oferta = (url, price) => ({ loja: 'mercadolivre', url, price, title: 'Fone Bom' });
    const a = s.verificador.conferir(oferta(URL_CARO, 100), { lidoEm: Date.now() });
    const jobA = await primeiro; // a nova está ocupada com o produto A
    const b = s.verificador.conferir(oferta(URL_154, 154.99), { lidoEm: Date.now() });
    await esperar(20);
    assert.equal(s.links.status().pending, 1, 'o produto B espera na fila');

    const pollAntigo = antiga.pollUma(); // a 1.4.2 pede trabalho: o B não é dela
    assert.equal(await Promise.race([pollAntigo, esperar(150).then(() => 'nada')]), 'nada', 'a extensão antiga não recebe o produto_ml da fila');
    assert.equal(s.links.status().pending, 1);
    const l = s.links.requestLink({ url: URL_154, tag: 'etiquetaA', timeoutMs: 5000 });
    const jobL = await pollAntigo;
    assert.equal(jobL.type, 'link', 'o link, esse a antiga atende');
    await antiga.responder(jobL);
    assert.match(await l, /^https:\/\/meli\.la\/E2e\d+$/);

    await nova.responder(jobA); // a nova volta e é ela quem recebe o B
    const jobB = await nova.pollUma();
    assert.deepEqual([jobB.type, jobB.url], ['produto_ml', URL_154]);
    await nova.responder(jobB);
    const [ra, rb] = await Promise.all([a, b]);
    assert.deepEqual([ra.acao, rb.acao], ['descartar', 'enviar']);
  } finally {
    await s.fechar();
  }
});

// ------------------------------------------------------------------------------------------------ CA7 e CA8

test('CA7: da extensão ao servidor só viaja o resumo estruturado: nada do HTML da página logada, nem do endereço final', async () => {
  await comExtensao({}, async (s, ext) => {
    await disparar(s, URL_154);
    const texto = JSON.stringify(ext.devolvidos);
    assert.doesNotMatch(texto, new RegExp(SEGREDO_PAGINA), 'o conteúdo da página fica no navegador');
    assert.doesNotMatch(texto, /account-verification|pdp_filters|mercadolivre\.com\.br/, 'nem o endereço final');
    const prod = ext.devolvidos.find((d) => d.tipo === 'produto_ml');
    assert.deepEqual(Object.keys(prod.data).sort(), ['estado', 'ofertas']);
    // o servidor tampouco guardou a página: o banco e o Histórico não têm o segredo
    const tudo = JSON.stringify([
      s.db.prepare('SELECT * FROM log').all().map((l) => ({ ...l })),
      s.db.prepare('SELECT * FROM envios').all().map((l) => ({ ...l })),
    ]);
    assert.doesNotMatch(tudo, new RegExp(SEGREDO_PAGINA));
  });
});

test('CA8: nenhum teste deste arquivo acessou a rede (fetch global bloqueado e contado)', () => {
  assert.equal(acessosRede, 0, 'nenhum pedido ao fetch global');
});
