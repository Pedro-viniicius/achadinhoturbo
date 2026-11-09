// Painel da fonte Catálogo (etapa 7 do plano fonte-catalogo-etiqueta): fonte "Catálogo" no formulário da regra, resumo e
// chips do cartão, prévia ("Esperaria revisão"), Histórico > Catálogo e o dialog "Revisar oferta" (public/app.js e
// public/espelhamento.js). Os dois arquivos rodam juntos num `vm` com um DOM mínimo e um fetch falso por rota: nenhuma
// rede, nenhum servidor. Foco em CA9 (texto cru do catálogo sempre escapado), CA6 (etiqueta opcional), CA7 (preço
// suspeito trava o "Enviar") e em que o "Completar" do espelhamento não mudou de comportamento.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { precoSuspeito } from '../src/catalogo-itens.js';
import { precisaEtiqueta, limparFonteCatalogo } from '../src/catalogo.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fonte = (arq) => fs.readFileSync(path.join(RAIZ, 'public', arq), 'utf8');

// Texto hostil vindo do catálogo (título, categoria, cupom, nome de regra)
const XSS = '<img src=x onerror=alert(1)>"\'&';
const XSS_ESC = '&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;';
const semMarcacao = (html, onde) => assert.ok(!/<img|<script|onerror=alert\(1\)>/i.test(html.replaceAll(XSS_ESC, '')), `${onde}: texto cru virou marcação\n${html}`);

/**
 * Carrega espelhamento.js e app.js (na ordem do index.html) com DOM falso. Os utilitários de disparos.js e ajuda.js
 * que as telas usam (dadosOferta, dispApi, dispSegHtml, dispLigarSeg, dispBrl, q) são falsos.
 * `rotas`: 'METODO /api/caminho' → (pedido) → [status, json] (o caminho sem a consulta).
 */
function tela() {
  const reg = new Map(); const pedidos = []; const foco = []; const rotas = {};
  const novo = (sel) => {
    const e = {
      sel, textContent: '', value: '', hidden: false, disabled: false, checked: false, open: false, className: '', dataset: {}, style: {}, attrs: {},
      classes: new Set(),
      classList: { add(c) { e.classes.add(c); }, remove(c) { e.classes.delete(c); }, toggle(c, f) { if (f ?? !e.classes.has(c)) e.classes.add(c); else e.classes.delete(c); }, contains: (c) => e.classes.has(c) },
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] ?? null; }, removeAttribute(k) { delete this.attrs[k]; },
      hasAttribute(k) { return k in this.attrs; },
      querySelector: (s) => el(s), querySelectorAll: () => [], addEventListener() {}, appendChild() {}, insertAdjacentHTML() {}, remove() {},
      focus() { foco.push(sel); }, scrollIntoView() {}, closest: () => null, showModal() { this.open = true; }, close() { this.open = false; },
      _html: '',
    };
    // trocar o HTML do dialog recria os elementos de dentro dele (como o navegador)
    Object.defineProperty(e, 'innerHTML', {
      get() { return this._html; },
      set(v) { this._html = String(v); if (sel === '#dlg') for (const k of [...reg.keys()]) if (k !== '#dlg' && k !== '#pagina' && k !== '#toast') reg.delete(k); },
    });
    return e;
  };
  const el = (s) => { if (!reg.has(s)) reg.set(s, novo(s)); return reg.get(s); };
  const ctx = {
    console, URLSearchParams,
    document: { querySelector: el, querySelectorAll: () => [], addEventListener() {}, createElement: () => novo('criado'), activeElement: null, body: {} },
    location: { hash: '#historico', replace() {} },
    history: { replaceState(_a, _b, h) { ctx.location.hash = h; } },
    addEventListener() {}, setInterval: () => 0, setTimeout: () => 0, clearTimeout() {},
    confirm: () => true,
    q: () => '',
    dispSegHtml: () => '', dispLigarSeg() {},
    dispBrl: (n) => `R$ ${Number(n).toFixed(2).replace('.', ',')}`,
    // a carga inicial do app.js (carregar: /state, /tags…) fica sem resposta: nem tela inicial nem toast de erro no meio do teste
    __fetch: () => new Promise(() => {}),
  };
  ctx.fetch = (url, opts) => ctx.__fetch(url, opts);
  ctx.window = ctx;
  // dadosOferta falso: os valores são os que o teste põe em `dados.v` (como o formulário os interpretaria: um percentual
  // informado de 100% ou mais é descartado e vale a conta dos dois preços, como no dadosOferta de verdade)
  ctx.dadosOferta = (valores = {}, aoMudar = () => {}, opcoes) => {
    const pct = Number(valores.discountPct); const p = valores.price ?? null; const a = valores.oldPrice ?? null;
    const conta = p && a && a > p ? Math.round((1 - p / a) * 100) : 0;
    const d = {
      v: { title: valores.title ?? '', price: p, oldPrice: a, discountPct: pct > 0 && pct < 100 ? pct : conta, coupon: valores.coupon ?? '', freeShipping: !!valores.freeShipping },
      inicial: valores, aoMudar, opcoes, el: { elements: { namedItem: (n) => el(`campo:${n}`) } },
    };
    // como o formulário de verdade: "Preço antigo" com o exemplo e a dica ligada
    reg.delete('campo:oldPrice'); el('campo:oldPrice').setAttribute('placeholder', '149,90'); el('campo:oldPrice').setAttribute('aria-describedby', 'do1-antigo');
    ctx.__dados = d;
    return {
      el: d.el, valores: () => ({ ...d.v }), erros: () => [], editado: () => false, definir() {},
      ajustes: () => ({ title: d.v.title, price: d.v.price, oldPrice: d.v.oldPrice, coupon: d.v.coupon, freeShipping: d.v.freeShipping }),
    };
  };
  ctx.dispApi = async (caminho, { method = 'GET', body } = {}) => {
    const r = await ctx.__fetch('/api' + caminho, { method, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json();
    if (!r.ok) { const e = new Error(j.erro || 'Erro ' + r.status); e.status = r.status; throw e; }
    return j;
  };
  vm.createContext(ctx);
  vm.runInContext(fonte('espelhamento.js'), ctx, { filename: 'public/espelhamento.js' });
  vm.runInContext(fonte('app.js'), ctx, { filename: 'public/app.js' });
  // daqui em diante o fetch responde pelas rotas do teste
  ctx.__fetch = async (url, opts = {}) => {
    const metodo = opts.method || 'GET'; const [caminho, consulta = ''] = String(url).split('?');
    const corpo = opts.body ? JSON.parse(opts.body) : null;
    pedidos.push({ metodo, caminho, consulta, corpo });
    const fn = rotas[`${metodo} ${caminho}`];
    const [status, json] = fn ? await fn({ corpo, consulta }) : [404, { erro: 'rota não prevista no teste' }];
    return { status, ok: status < 400, json: async () => json };
  };
  const rodar = (c) => vm.runInContext(c, ctx);
  return { ctx, el, reg, pedidos, foco, rotas, rodar, dados: () => ctx.__dados };
}
const ate = async (cond, n = 50) => { for (let i = 0; i < n && !cond(); i++) await new Promise((r) => setImmediate(r)); return cond(); };
const json = (x) => JSON.parse(JSON.stringify(x));
const estado = (extra = {}) => ({
  usuario: { id: 1, papel: 'dono', nome: 'Pedro', email: 'p@x' }, auth: true, whatsapp: { status: 'open' }, extensao: { online: true }, ajustes: { link_mode: 'extension' },
  catalogo: { estado: 'conectada', para_revisar: 0, teto_revisao: 50, regras: [], falha_desde: null, tag_amazon: true }, ...extra,
});
/** Põe S.st, S.rules e S.templates. */
function preparar(t, { st = estado(), rules = [], templates = [{ id: 1, name: 'Padrão', body: '{TITULO} {LINK}' }], tags = [{ id: 7, name: 'achadosmenicas' }] } = {}) {
  t.ctx.__st = st; t.ctx.__rules = rules; t.ctx.__tpls = templates; t.ctx.__tags = tags;
  t.rodar('S.st = __st; S.rules = __rules; S.templates = __tpls; S.tags = __tags; S.groups = [];');
}

// ---------- itens como GET /api/catalogo/itens os devolve (src/catalogo-itens.js listar) ----------
const oferta = (extra = {}) => ({ title: 'Fone JBL', price: 99.9, oldPrice: 149.9, discountPct: 33, sold: 10, freeShipping: true, coupon: null, image: null, categoria: 'Eletrônicos', link: null, ...extra });
const item = (extra = {}) => ({
  id: 11, rule_id: 3, regra: 'Ofertas Tech', loja: 'shopee', status: 'revisao', motivos: ['shopee'],
  oferta: oferta({ link: 'https://s.shopee.com.br/AbC123' }), grupos: [{ nome: 'Grupo A', ok: null, erro: null }, { nome: 'Grupo B', ok: null, erro: null }],
  envio_id: null, envio_status: null, criado_em: 1000, decidido_em: null, ...extra,
});
const regraCat = (extra = {}) => ({ id: 3, name: 'Ofertas Tech', template_id: 1, tag_id: null, group_jids: ['a@g.us', 'b@g.us'], per_run: 3, interval_min: 60, window_start: '08:00', window_end: '22:00', enabled: true,
  sources: [{ type: 'catalogo', tag_id: null, config: { categorias: ['Eletrônicos'], lojas: ['shopee'], q: '', desconto_min: null, ordem: 'atualizacao' } }], ...extra });

// =========================================================================================== Histórico > Catálogo

test('CA9: a linha do Histórico escapa título, categoria e nome da regra (texto, title e aria-label do "Revisar")', () => {
  const t = tela();
  const it = item({ regra: `Regra ${XSS}`, oferta: oferta({ title: `Título ${XSS}`, categoria: `Cat ${XSS}`, coupon: `CUPOM${XSS}`, link: 'https://s.shopee.com.br/AbC123' }) });
  t.ctx.__it = it;
  const html = t.rodar('hcatLinhaHtml(__it, true)');
  semMarcacao(html, 'linha');
  assert.ok(html.includes(`Título ${XSS_ESC}`) && html.includes(`Cat ${XSS_ESC}`) && html.includes(`Regra ${XSS_ESC}`), html);
  assert.match(html, new RegExp(`aria-label="Revisar oferta Título ${XSS_ESC.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, da Shopee"`));
  assert.match(html, /data-revisar="11"/);
  assert.ok(!html.includes('CUPOM'), 'a linha não precisa do cupom');
});

test('P6: o Operador vê a linha "Para revisar" sem o botão "Revisar" (no lugar, "Só o Dono revisa.")', () => {
  const t = tela(); t.ctx.__it = item();
  const op = t.rodar('hcatLinhaHtml(__it, false)');
  assert.doesNotMatch(op, /data-revisar/); assert.match(op, /Só o Dono revisa\./);
  t.ctx.__it = item({ status: 'enviado', envio_id: 4, grupos: [{ nome: 'A', ok: true, erro: null }] });
  assert.doesNotMatch(t.rodar('hcatLinhaHtml(__it, true)'), /data-revisar|Só o Dono/);
});

test('resultado de cada item: para revisar (motivos do servidor), enviada sozinha, pela revisão, saindo, erro por grupo e descartada', () => {
  const t = tela(); const r = (x) => { t.ctx.__it = x; return json(t.rodar('hcatResultado(__it)')); };
  assert.deepEqual(r(item({ motivos: ['shopee', 'desconto_100'] })), { cls: 'nivel-aviso', texto: 'Para revisar: Shopee: confirme o link e Desconto de 100%: confira o preço', detalhe: '', extra: [] });
  assert.equal(r(item({ motivos: ['preco_antigo', 'inventado<b>'] })).texto, 'Para revisar: Preço antigo muito alto: confira o preço', 'motivo desconhecido não aparece');
  assert.equal(r(item({ motivos: ['falha_link'], loja: 'ml' })).texto, 'Para revisar: Não consegui gerar o link: confira a oferta');
  const sozinhaAmz = r(item({ status: 'enviado', loja: 'amazon', motivos: [], grupos: [] }));
  assert.deepEqual([sozinhaAmz.cls, sozinhaAmz.texto, sozinhaAmz.detalhe], ['nivel-ok', 'Enviada', 'link da Amazon com a sua tag']);
  assert.equal(r(item({ status: 'enviado', loja: 'ml', motivos: [], grupos: [] })).detalhe, 'link do Mercado Livre gerado com a sua etiqueta');
  assert.equal(r(item({ status: 'enviado', envio_id: 9, grupos: [{ nome: 'A', ok: true }, { nome: 'B', ok: null }] })).detalhe, 'revisada e enviada · enviando…');
  assert.equal(r(item({ status: 'enviado', envio_id: 9, grupos: [{ nome: 'A', ok: true }] })).detalhe, 'revisada e enviada');
  assert.deepEqual(r(item({ status: 'enviado', envio_id: 9, grupos: [{ nome: 'A', ok: true }, { nome: 'B', ok: false, erro: 'o WhatsApp recusou' }] })),
    { cls: 'nivel-erro', texto: 'Erro ao enviar para 1 grupo', detalhe: '', extra: ['B: o WhatsApp recusou'] });
  assert.deepEqual([r(item({ status: 'descartado' })).cls, r(item({ status: 'descartado' })).texto], ['nivel-aviso', 'Descartada: na revisão']);
  // descartada pelo verificador (R2): o motivo da loja; nao_conferido, valor desconhecido ou de outro status não valem
  assert.equal(r(item({ status: 'descartado', descartado_por: 'esgotado' })).texto, 'Descartada: esgotado na loja');
  assert.equal(r(item({ status: 'descartado', descartado_por: 'preco_subiu' })).texto, 'Descartada: preço subiu');
  for (const x of ['nao_conferido', 'constructor', 7, null]) assert.equal(r(item({ status: 'descartado', descartado_por: x })).texto, 'Descartada: na revisão', String(x));
  assert.equal(r(item({ status: 'enviado', descartado_por: 'esgotado', grupos: [] })).texto, 'Enviada');
});

test('o link da revisão só é aceito no formato exato da loja (https, host esperado, sem truques)', () => {
  const t = tela(); const ok = (loja, link) => { t.ctx.__a = [loja, link]; return t.rodar('hcatLinkSeguro(...__a)'); };
  assert.equal(ok('shopee', 'https://s.shopee.com.br/AbC123'), 'https://s.shopee.com.br/AbC123');
  assert.equal(ok('amazon', 'https://www.amazon.com.br/dp/B0FG2MD49G'), 'https://www.amazon.com.br/dp/B0FG2MD49G');
  assert.equal(ok('ml', 'https://produto.mercadolivre.com.br/MLB-123456789'), 'https://produto.mercadolivre.com.br/MLB-123456789');
  for (const [loja, link] of [
    ['shopee', 'javascript:alert(1)'], ['shopee', 'http://s.shopee.com.br/AbC123'], ['shopee', 'https://s.shopee.com.br@evil.com/AbC123'],
    ['shopee', 'https://s.shopee.com.br.evil.com/AbC123'], ['shopee', 'https://evil.com/?https://s.shopee.com.br/AbC123'], ['shopee', 'https://s.shopee.com.br/AbC123"onmouseover="x'],
    ['shopee', 'https://shopee.com.br/product/1/2'], ['amazon', 'https://www.amazon.com.br/dp/B0FG2MD49G?tag=terceiro-20'], ['amazon', 'https://amzn.to/abc'],
    ['ml', 'https://meli.la/abc'], ['ml', 'https://s.shopee.com.br/AbC123'], ['outra', 'https://s.shopee.com.br/AbC123'], ['shopee', null], ['shopee', 42],
  ]) assert.equal(ok(loja, link), null, `${loja} ${link}`);
});

test('CA7: a trava do "Enviar" usa a mesma conta do servidor (precoSuspeito): desconto 100% ou preço antigo ≥ 10×', () => {
  const t = tela();
  const casos = [
    { price: 10, oldPrice: 100, discountPct: 90 }, { price: 10, oldPrice: 99.99, discountPct: 90 }, { price: 10, oldPrice: null, discountPct: 100 },
    { price: 10, oldPrice: null, discountPct: 0 }, { price: 10, oldPrice: 15, discountPct: 33 }, { price: null, oldPrice: 500, discountPct: 0 },
    { price: 0.5, oldPrice: 5, discountPct: 90 }, { price: 10, oldPrice: 1000, discountPct: 99 }, { price: 10, oldPrice: null, discountPct: 101 },
  ];
  for (const c of casos) { t.ctx.__v = c; assert.equal(t.rodar('hcatPrecoSuspeito(__v)'), precoSuspeito(c), JSON.stringify(c)); }
});

test('visão Catálogo: pede /api/catalogo/itens com o filtro do endereço; KPIs e aviso de fila cheia escapados', async () => {
  const t = tela(); preparar(t, { rules: [regraCat({ name: `Regra ${XSS}` })] });
  t.rotas['GET /api/catalogo/itens'] = () => [200, { itens: [item({ regra: `Regra ${XSS}` })], contadores_24h: { enviadas: 4, descartadas: 1, para_revisar: 50 }, regras: [{ rule_id: 3, regra: `Regra ${XSS}`, para_revisar: 50, cheia: true }], para_revisar: 50, teto_revisao: 50 }];
  t.ctx.location.hash = '#historico?tipo=catalogo&regra=3&status=revisao';
  await t.rodar("paginaHistorico('', new URLSearchParams('tipo=catalogo&regra=3&status=revisao'))");
  const ped = t.pedidos.find((p) => p.caminho === '/api/catalogo/itens');
  assert.ok(ped, 'não pediu a lista do catálogo');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(ped.consulta)), { limite: '200', status: 'revisao', regra: '3' });
  const pagina = t.el('#pagina').innerHTML; const corpo = t.el('#hc-corpo').innerHTML;
  semMarcacao(pagina, 'filtros'); semMarcacao(corpo, 'corpo');
  assert.ok(pagina.includes(`Regra ${XSS_ESC}`), 'o filtro de regra lista as regras com Catálogo');
  assert.match(corpo, /kpi atencao/); assert.match(corpo, />50</);
  assert.ok(corpo.includes(`A regra “Regra ${XSS_ESC}” tem 50 ofertas esperando revisão.`), corpo);
  // sem filtro, status=todos e sem regra
  await t.rodar("paginaHistorico('', new URLSearchParams('tipo=catalogo'))");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(t.pedidos.filter((p) => p.caminho === '/api/catalogo/itens').at(-1).consulta)), { limite: '200', status: 'todos' });
});

// =========================================================================================== dialog "Revisar oferta"

/** Abre a visão Catálogo com `itens` e o dialog do item `id`. */
async function abrirRevisar(t, itens, id, { rules = [regraCat()] } = {}) {
  preparar(t, { rules });
  t.ctx.__itens = itens;
  t.rotas['GET /api/catalogo/itens'] = () => [200, { itens: t.ctx.__itens, contadores_24h: {}, regras: [], para_revisar: 0, teto_revisao: 50 }];
  t.rotas['POST /api/templates/preview'] = ({ corpo }) => [200, { texto: `*${corpo.amostra.title}* cupom ${corpo.amostra.coupon} ${corpo.amostra.link}` }];
  t.ctx.location.hash = '#historico?tipo=catalogo';
  await t.rodar("paginaHistorico('', new URLSearchParams('tipo=catalogo'))");
  t.rodar(`revisarCatalogo(${id})`);
  return t.el('#dlg');
}

test('CA9 e CA4: dialog da Shopee escapa título, cupom e regra; o link só sai em <a> seguro (nova aba, sem referrer); prévia escapada', async () => {
  const t = tela();
  const it = item({ regra: `Regra ${XSS}`, oferta: oferta({ title: `Título ${XSS}`, coupon: `CUP${XSS}`, categoria: `Cat ${XSS}`, link: 'https://s.shopee.com.br/AbC123' }) });
  const dlg = await abrirRevisar(t, [it], 11);
  assert.equal(dlg.open, true);
  const html = dlg.innerHTML; semMarcacao(html, 'dialog');
  assert.match(html, /<h1>Revisar oferta<\/h1>/);
  assert.ok(html.includes(`Veio do catálogo, pela regra “Regra ${XSS_ESC}”. Motivo: Shopee: confirme o link.`), html);
  assert.match(html, /O link da Shopee não prova de quem é a conta\./);
  assert.match(html, /<a href="https:\/\/s\.shopee\.com\.br\/AbC123" target="_blank" rel="noopener noreferrer"[^>]*>Abrir o link da oferta \(abre em outra aba\)<\/a>/);
  assert.doesNotMatch(html, /<input[^>]*AbC123|contenteditable/, 'o link não é editável');
  assert.match(html, /Enviar para 2 grupos/);
  assert.doesNotMatch(html, /id="cm-proxima"/, 'com uma só para revisar, não há "Enviar e ir para a próxima"');
  // os dados vão ao formulário como valores (dadosOferta põe em .value, nunca em HTML)
  assert.equal(t.dados().inicial.title, `Título ${XSS}`);
  // a prévia passa pelo zap(): o título e o cupom do catálogo não viram marcação
  assert.ok(await ate(() => t.el('#cm-pv').innerHTML !== ''));
  const pv = t.el('#cm-pv').innerHTML; semMarcacao(pv, 'prévia');
  assert.ok(pv.includes(`CUP${XSS_ESC}`) && pv.includes('https://s.shopee.com.br/AbC123'), pv);
  assert.equal(t.el('#cm-enviar').disabled, false);
});

test('CA7: "Enviar" travado enquanto o preço seguir suspeito, com o texto de apoio ligado ao botão; corrigido, envia os ajustes', async () => {
  const t = tela();
  const it = item({ loja: 'amazon', motivos: ['preco_antigo'], oferta: oferta({ price: 10, oldPrice: 500, discountPct: 98, link: 'https://www.amazon.com.br/dp/B0FG2MD49G' }) });
  const dlg = await abrirRevisar(t, [it], 11);
  assert.match(dlg.innerHTML, /preço antigo 50× maior que o preço \(R\$ 500,00 → R\$ 10,00\)/);
  const btn = t.el('#cm-enviar'); const trava = t.el('#cm-trava');
  assert.equal(btn.disabled, true); assert.equal(btn.getAttribute('aria-describedby'), 'cm-trava');
  assert.equal(trava.hidden, false); assert.equal(trava.textContent, 'Corrija o preço ou apague o preço antigo para enviar.');
  await btn.onclick(); assert.equal(t.pedidos.filter((p) => p.metodo === 'POST' && p.caminho.endsWith('/enviar')).length, 0, 'travado não envia');
  // o dono apaga o preço antigo: destrava
  const d = t.dados(); d.v = { ...d.v, oldPrice: null, discountPct: 0 }; d.aoMudar(d.v);
  assert.equal(btn.disabled, false); assert.equal(btn.getAttribute('aria-describedby'), null); assert.equal(trava.hidden, true);
  // 100% de novo (ex.: o dono digitou preço antigo 10× maior): trava de novo
  d.v = { ...d.v, oldPrice: 100 }; d.aoMudar(d.v); assert.equal(btn.disabled, true);
  d.v = { ...d.v, oldPrice: 20 }; d.aoMudar(d.v); assert.equal(btn.disabled, false);
  t.rotas['POST /api/catalogo/itens/11/enviar'] = () => [200, { envio_id: 5 }];
  t.ctx.__itens = [{ ...it, status: 'enviado', envio_id: 5 }];
  await btn.onclick();
  const env = t.pedidos.find((p) => p.metodo === 'POST' && p.caminho === '/api/catalogo/itens/11/enviar');
  assert.deepEqual(env.corpo, { ajustes: { title: 'Fone JBL', price: 10, oldPrice: 20, coupon: '', freeShipping: true } });
  assert.equal(dlg.open, false); assert.equal(t.el('#toast').textContent, 'Oferta enviada para 2 grupos');
  assert.ok(t.foco.includes('#hc-tab'), 'o foco volta à tabela');
});

test('CA7: o 400 do servidor ("Corrija o preço…") aparece no dialog e o botão volta; o 409 avisa, fecha e atualiza', async () => {
  const t = tela();
  const dlg = await abrirRevisar(t, [item()], 11);
  t.rotas['POST /api/catalogo/itens/11/enviar'] = () => [400, { erro: 'Corrija o preço ou apague o preço antigo para enviar.' }];
  await t.el('#cm-enviar').onclick();
  assert.match(t.el('.erros').innerHTML, /Corrija o preço ou apague o preço antigo para enviar\./);
  assert.equal(t.el('#cm-enviar').disabled, false); assert.equal(t.el('#cm-enviar').textContent, 'Enviar para 2 grupos');
  assert.equal(dlg.open, true);
  const antes = t.pedidos.filter((p) => p.caminho === '/api/catalogo/itens').length;
  t.rotas['POST /api/catalogo/itens/11/enviar'] = () => [409, { erro: 'Esta oferta já foi tratada.' }];
  await t.el('#cm-enviar').onclick();
  assert.equal(dlg.open, false); assert.equal(t.el('#toast').textContent, 'Esta oferta já foi tratada.');
  assert.equal(t.pedidos.filter((p) => p.caminho === '/api/catalogo/itens').length, antes + 1, 'a lista é atualizada');
  // descartar com 409 também
  await abrirRevisar(t, [item()], 11);
  t.rotas['POST /api/catalogo/itens/11/descartar'] = () => [409, { erro: 'Esta oferta já foi tratada.' }];
  await t.el('#cm-descartar').onclick();
  assert.equal(t.el('#dlg').open, false); assert.equal(t.el('#toast').textContent, 'Esta oferta já foi tratada.');
});

test('link fora do esperado: sem <a>, "Enviar" travado com o motivo, nada é enviado', async () => {
  const t = tela();
  const dlg = await abrirRevisar(t, [item({ oferta: oferta({ link: 'javascript:alert(1)' }) })], 11);
  assert.doesNotMatch(dlg.innerHTML, /<a href/); assert.match(dlg.innerHTML, /Link fora do esperado: não enviar\./);
  assert.equal(t.el('#cm-enviar').disabled, true); assert.equal(t.el('#cm-trava').textContent, 'Link fora do esperado: não enviar.');
  const d = t.dados(); d.aoMudar(d.v); assert.equal(t.el('#cm-enviar').disabled, true, 'mexer nos dados não destrava');
  await t.el('#cm-enviar').onclick();
  assert.equal(t.pedidos.filter((p) => p.metodo === 'POST' && p.caminho.endsWith('/enviar')).length, 0);
});

test('"Enviar e ir para a próxima" só com outra para revisar na mesma regra; envia e abre a mais antiga', async () => {
  const t = tela();
  const a = item({ id: 11, criado_em: 3000 }); const b = item({ id: 12, criado_em: 1000, oferta: oferta({ title: 'Mais antiga', link: 'https://s.shopee.com.br/Zzz999' }) });
  const c = item({ id: 13, criado_em: 2000, oferta: oferta({ title: 'Do meio', link: 'https://s.shopee.com.br/Yyy888' }) });
  const outraRegra = item({ id: 14, rule_id: 4, criado_em: 10 });
  let dlg = await abrirRevisar(t, [a, b, c, outraRegra], 11);
  assert.match(dlg.innerHTML, /<button type="button" id="cm-proxima">Enviar e ir para a próxima<\/button>/);
  t.rotas['POST /api/catalogo/itens/11/enviar'] = () => [200, { envio_id: 5 }];
  t.ctx.__itens = [{ ...a, status: 'enviado' }, b, c, outraRegra];
  await t.el('#cm-proxima').onclick();
  assert.ok(t.pedidos.some((p) => p.metodo === 'POST' && p.caminho === '/api/catalogo/itens/11/enviar'));
  dlg = t.el('#dlg');
  assert.equal(dlg.open, true, 'abriu a próxima');
  assert.equal(t.dados().inicial.title, 'Mais antiga');
  assert.match(dlg.innerHTML, /Zzz999/);
  // só uma na regra: sem o botão
  await abrirRevisar(t, [item({ id: 20 }), item({ id: 21, rule_id: 9 })], 20);
  assert.doesNotMatch(t.el('#dlg').innerHTML, /cm-proxima/);
});

test('Revisar só abre item em revisão (item já tratado na lista não abre dialog)', async () => {
  const t = tela();
  await abrirRevisar(t, [item({ status: 'enviado' })], 11);
  assert.equal(t.el('#dlg').open, false);
});

// =========================================================================================== "Completar" do espelhamento

test('"Completar" do espelhamento segue igual: mesma rota, sem trava de preço, sem "próxima", sem faixa', async () => {
  const t = tela(); preparar(t);
  t.ctx.__it = { id: 7, espelho_id: 2, espelho_nome: 'Tech', origem_nome: 'Grupo X', asin: 'B06BR9EEZ1', status: 'na_fila', oferta: { title: 'Fone', price: 10, oldPrice: 500 } };
  t.ctx.__esp = [{ id: 2, nome: 'Tech', template_id: 1, destino_jids: ['a', 'b'], destinos_nomes: ['A', 'B'] }];
  t.rodar('ESP_H.itens = [__it]; ESP.lista = __esp;');
  t.rotas['POST /api/templates/preview'] = () => [200, { texto: 'ok' }];
  t.rotas['GET /api/espelhos'] = () => [200, { espelhos: t.ctx.__esp }];
  t.rotas['GET /api/espelhos/itens'] = () => [200, []];
  t.rodar('completarEspelhamento(7)');
  const dlg = t.el('#dlg'); const html = dlg.innerHTML;
  assert.match(html, /^<div class="corpo" id="cm"><h1>Completar oferta<\/h1><p class="dica" style="margin:0">Veio de Grupo X, pelo espelhamento “Tech”\. Confira os dados e envie, ou descarte\.<\/p>\n    <div id="cm-dados"><\/div>/);
  assert.doesNotMatch(html, /cm-trava|cm-proxima|aviso-impl|target="_blank"/);
  assert.match(html, /<button type="button" class="pri" id="cm-enviar" >Enviar para 2 grupos<\/button><\/div><\/div>$/);
  assert.equal(t.el('#cm-enviar').disabled, false, 'preço antigo 50× não trava o Completar');
  assert.ok(await ate(() => t.pedidos.some((p) => p.caminho === '/api/templates/preview')));
  assert.match(t.pedidos.find((p) => p.caminho === '/api/templates/preview').corpo.amostra.link, /^https:\/\/www\.amazon\.com\.br\/dp\/B06BR9EEZ1\?tag=•••$/);
  t.rotas['POST /api/espelhos/itens/7/enviar'] = () => [200, { envio_id: 1 }];
  await t.el('#cm-enviar').onclick();
  const env = t.pedidos.find((p) => p.caminho === '/api/espelhos/itens/7/enviar');
  assert.deepEqual(env.corpo, { ajustes: { title: 'Fone', price: 10, oldPrice: 500, coupon: '', freeShipping: false } });
  assert.equal(dlg.open, false); assert.equal(t.el('#toast').textContent, 'Oferta enviada para 2 grupos');
  assert.ok(t.pedidos.some((p) => p.caminho === '/api/espelhos/itens'), 'atualiza a visão Espelhamento');
});

// =========================================================================================== formulário da regra

test('CA9: resumo da fonte no cartão escapa categoria e busca; 2–3 categorias = "primeira + N", mais de 3 = "N categorias"', () => {
  const t = tela(); preparar(t);
  const r = (c) => { t.ctx.__c = c; return t.rodar('fonteCatalogo(__c)'); };
  const um = r({ categorias: [`Cat ${XSS}`, 'B', 'C'], lojas: ['shopee', 'amazon'], q: `air ${XSS}`, desconto_min: 30, ordem: 'atualizacao' });
  semMarcacao(um, 'resumo');
  assert.equal(um, `Catálogo do Etiqueta (Cat ${XSS_ESC} + 2 categorias, Amazon + Shopee, “air ${XSS_ESC}”, desconto a partir de 30%, novidades)`);
  assert.equal(r({ categorias: ['A', 'B', 'C', 'D'], lojas: [], q: '', desconto_min: null, ordem: 'desconto' }), 'Catálogo do Etiqueta (4 categorias, maior desconto)');
  assert.equal(r({ categorias: ['A', 'B'], lojas: ['ml'], ordem: 'relevancia' }), 'Catálogo do Etiqueta (A + 1 categoria, Mercado Livre, mais vendidos)');
  assert.equal(r({}), 'Catálogo do Etiqueta (novidades)');
  // etiqueta da fonte só aparece se a fonte usa o ML
  t.ctx.__f = { type: 'catalogo', tag_id: 7, config: { lojas: ['amazon'] } };
  assert.doesNotMatch(t.rodar('resumoFonte(__f)'), /etiqueta/);
  t.ctx.__f = { type: 'catalogo', tag_id: 7, config: { lojas: ['ml'] } };
  assert.match(t.rodar('resumoFonte(__f)'), /· etiqueta achadosmenicas$/);
});

test('CA9 e CA2: caixas das categorias escapam o nome (texto, value e title); totais pelas lojas; 0 ofertas desabilita; sumida e limite de 20', () => {
  const t = tela();
  const lista = [{ nome: `Cat ${XSS}`, total: 1853, lojas: { amazon: 1500, ml: 353, shopee: 0 } }, { nome: 'Perfumes', total: 30, lojas: { amazon: 0, ml: 0, shopee: 30 } }];
  const h = (marcadas, lojas, l = lista) => { t.ctx.__a = [l, marcadas, lojas]; return t.rodar('fcatCatsHtml(...__a)'); };
  const todos = h([`Cat ${XSS}`, 'Sumiu'], []);
  semMarcacao(todos, 'categorias');
  assert.ok(todos.includes(`title="Cat ${XSS_ESC}"`) && todos.includes(`value="Cat ${XSS_ESC}"`) && todos.includes(`>Cat ${XSS_ESC}</span>`), todos);
  assert.match(todos, /\(1\.853\)/); assert.match(todos, /\(30\)/);
  assert.match(todos, /value="Sumiu" checked[^>]*>.*\(não está mais no catálogo\)/);
  const soShopee = h([], ['shopee']);
  assert.match(soShopee, new RegExp(`value="Cat ${XSS_ESC.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"  data-zero disabled>.*\\(0 ofertas\\)`));
  assert.match(soShopee, /value="Perfumes"[^>]*>.*\(30\)/);
  assert.doesNotMatch(soShopee.match(/<label[^>]*><input type="checkbox" value="Perfumes"[^>]*>/)[0], /disabled/);
  assert.match(h([], [], null), /Carregando as categorias…/);
  const vazia = h(['Guardada'], [], []);
  assert.match(vazia, /As categorias aparecem depois que o catálogo for conectado e testado em Conexões\./);
  assert.match(vazia, /value="Guardada" checked/); assert.doesNotMatch(vazia, /não está mais/);
  const vinte = Array.from({ length: 21 }, (_, i) => ({ nome: `C${i}`, total: 1, lojas: { amazon: 1, ml: 0, shopee: 0 } }));
  const cheio = h(vinte.slice(0, 20).map((c) => c.nome), [], vinte);
  assert.match(cheio, /value="C20"\s+disabled/); assert.doesNotMatch(cheio, /value="C0" checked\s+disabled/);
});

test('CA6: etiqueta padrão só obrigatória se alguma fonte precisar (mesma regra do servidor, precisaEtiqueta)', () => {
  const t = tela();
  const casos = [
    [], [{ type: 'afiliados', config: {} }], [{ type: 'catalogo', config: { lojas: [] } }], [{ type: 'catalogo', config: { lojas: ['amazon', 'shopee'] } }],
    [{ type: 'catalogo', config: { lojas: ['ml'] } }], [{ type: 'catalogo', config: { lojas: ['shopee'] } }, { type: 'list', config: {} }],
    [{ type: 'catalogo', config: { lojas: ['amazon'] } }, { type: 'catalogo', config: { lojas: ['shopee'] } }], [{ type: 'catalogo', config: {} }],
    [{ type: 'afiliados', config: { lojas: ['amazon'] } }], // só a fonte catálogo olha as lojas
  ];
  for (const c of casos) { t.ctx.__f = c; assert.equal(t.rodar('fcatPrecisaEtiqueta(__f)'), precisaEtiqueta(c), JSON.stringify(c)); }
});

test('validação no cliente recusa o mesmo que o servidor (limparFonteCatalogo), com o mesmo campo', () => {
  const t = tela();
  const casos = [
    { q: 'air fryer, fritadeira' }, { q: 'a,,b' }, { q: ',a' }, { q: 'a,' }, { q: 'x'.repeat(200) }, { q: 'x'.repeat(201) },
    { q: Array.from({ length: 10 }, (_, i) => `t${i}`).join(',') }, { q: Array.from({ length: 11 }, (_, i) => `t${i}`).join(',') },
    { desconto_min: null }, { desconto_min: 0 }, { desconto_min: 99 }, { desconto_min: 100 }, { desconto_min: '5.5' }, { desconto_min: '-1' },
    { categorias: Array.from({ length: 20 }, (_, i) => `c${i}`) }, { categorias: Array.from({ length: 21 }, (_, i) => `c${i}`) },
  ];
  for (const c of casos) {
    const cfg = { categorias: [], lojas: [], q: '', desconto_min: null, ordem: 'atualizacao', ...c };
    t.ctx.__c = cfg; const cli = json(t.rodar('fcatErros(__c)'));
    let srv = null; try { limparFonteCatalogo(cfg); } catch (e) { srv = e.campo; }
    assert.equal(cli[0]?.campo ?? null, srv, JSON.stringify(c));
    if (srv) assert.equal(cli[0].msg, (() => { try { limparFonteCatalogo(cfg); } catch (e) { return e.message; } })(), 'mesma frase');
  }
});

test('avisos A1 a A5 e o de conexão (A0), conforme as lojas marcadas e o estado do catálogo', () => {
  const t = tela();
  const av = (lojas, tag) => { t.ctx.__a = [lojas, tag]; return t.rodar('fcatAvisosHtml(...__a)'); };
  const todas = av([], true);
  assert.doesNotMatch(todas, /não precisa de etiqueta/); assert.match(todas, /Toda oferta da Shopee espera a sua revisão/);
  assert.match(todas, /gerados de novo, com a etiqueta escolhida acima/); assert.match(todas, /Amazon: o link é montado com a sua tag de Conexões\./);
  assert.match(todas, /Ofertas com 100% de desconto/);
  const amz = av(['amazon'], false);
  assert.match(amz, /Esta fonte não precisa de etiqueta do Mercado Livre/); assert.doesNotMatch(amz, /Shopee espera|gerados de novo/);
  assert.match(amz, /Falta a tag da Amazon\..*href="#conexoes"/);
  const ml = av(['ml'], false); assert.doesNotMatch(ml, /não precisa de etiqueta|Amazon|Shopee espera/);
  const con = (e) => { t.ctx.__e = e; return t.rodar('fcatConexaoHtml(__e)'); };
  assert.equal(con({ estado: 'conectada' }), '');
  assert.match(con({ estado: 'falta_configurar' }), /ainda não está conectado.*href="#conexoes"/);
  assert.match(con({}), /ainda não está conectado/);
  assert.match(con({ estado: 'indisponivel' }), /indisponível agora \(Indisponível\)\. Você pode salvar esta fonte/);
  assert.match(con({ estado: 'token_recusado' }), /\(Token recusado\)/);
});

test('cartão da regra: "N para revisar" só para o Dono e com link filtrado; "Revisão cheia (50)"; "Catálogo indisponível" global', () => {
  const t = tela();
  const st = estado({ catalogo: { estado: 'indisponivel', para_revisar: 50, teto_revisao: 50, regras: [{ rule_id: 3, para_revisar: 50, cheia: true }], falha_desde: new Date().setHours(14, 32, 0, 0), tag_amazon: true } });
  preparar(t, { st, rules: [regraCat()] });
  t.ctx.__r = { ...regraCat(), em_andamento: false, next_run_at: null };
  const html = t.rodar('cartaoRegra(__r)');
  assert.match(html, /<a class="chip chip-link chip-toque" href="#historico\?tipo=catalogo&amp;regra=3&amp;status=revisao"[^>]*>50 para revisar<\/a>/);
  assert.match(html, /Revisão cheia \(50\)/); assert.match(html, /50 ofertas esperam revisão\. As novas esperam até você revisar ou descartar\./);
  assert.match(html, /! Catálogo indisponível/); assert.match(html, /Catálogo indisponível desde 14:32\. As outras fontes seguem\./);
  // Operador: sem o chip de revisar (ele não revisa); os avisos ficam
  t.rodar("S.st.usuario = { id: 2, papel: 'operador' }");
  const op = t.rodar('cartaoRegra(__r)');
  assert.doesNotMatch(op, /para revisar/); assert.match(op, /Revisão cheia/);
  // regra sem Catálogo: nada disso
  t.ctx.__r = { ...regraCat({ id: 5, sources: [{ type: 'afiliados', config: {} }] }), em_andamento: false };
  assert.doesNotMatch(t.rodar('cartaoRegra(__r)'), /para revisar|Revisão cheia|Catálogo indisponível/);
});

test('"Ver ofertas": a que iria à revisão mostra "Esperaria revisão" e o motivo; o texto da prévia sai escapado', async () => {
  const t = tela(); preparar(t, { rules: [regraCat()] });
  t.rotas['GET /api/rules/3/offers'] = () => [200, [
    { text: `*Título ${XSS}* cupom ${XSS}`, fonte: 1, etiqueta: null, revisao: true, motivos: ['shopee'] },
    { text: 'Normal', fonte: 1, etiqueta: 'achadosmenicas', revisao: false, motivos: [] },
  ]];
  t.ctx.__r = regraCat();
  await t.rodar('verOfertas(__r)');
  const html = t.el('#dlg').innerHTML; semMarcacao(html, 'prévia');
  assert.match(html, /<span class="venc-aviso">Esperaria revisão<\/span> Shopee: confirme o link/);
  assert.equal(html.match(/Esperaria revisão/g).length, 1);
});

test('menu: "Histórico (N)" com aria-label só para o Dono; Operador e zero mostram só "Histórico"', () => {
  const t = tela();
  const hist = t.el('#rail nav a[href="#historico"]'); hist.textContent = 'Histórico';
  preparar(t, { st: estado({ catalogo: { para_revisar: 3, regras: [] } }) });
  t.rodar('pintarConta()');
  assert.equal(hist.textContent, 'Histórico (3)'); assert.equal(hist.getAttribute('aria-label'), 'Histórico, 3 ofertas para revisar');
  t.rodar("S.st.usuario = { id: 2, papel: 'operador' }; pintarConta()");
  assert.equal(hist.textContent, 'Histórico'); assert.equal(hist.getAttribute('aria-label'), null);
  t.rodar("S.st.usuario = { id: 1, papel: 'dono' }; S.st.catalogo = { para_revisar: 0 }; pintarConta()");
  assert.equal(hist.textContent, 'Histórico');
  t.rodar('S.st.catalogo = undefined; pintarConta()'); // servidor sem o catálogo: não quebra
  assert.equal(hist.textContent, 'Histórico');
});

// =========================================================================================== rodada 1 de correções
// D1 a D9 (designer) e R3, R4, R5, R8, R12 (revisor), do lado do painel.

test('D1: Shopee com 100% informado e sem preço antigo: faixa diz que o número não vai na mensagem, "Enviar" liberado, sem exemplo no "Preço antigo"', async () => {
  const t = tela();
  const it = item({ motivos: ['shopee', 'desconto_100'], oferta: oferta({ price: 49.9, oldPrice: null, discountPct: 100, link: 'https://s.shopee.com.br/AbC123' }) });
  const dlg = await abrirRevisar(t, [it], 11);
  const html = dlg.innerHTML;
  assert.match(html, /O Etiqueta informou 100% de desconto; esse número não vai na mensagem\. Sem um preço antigo maior que o preço, ela sai sem “de\/por” e sem desconto\./);
  assert.doesNotMatch(html, /apague o preço antigo/, 'não manda apagar um preço antigo que não existe');
  assert.equal(t.el('#cm-enviar').disabled, false, 'o servidor nunca manda o "100%": envio liberado depois da revisão');
  assert.equal(t.el('#cm-trava').hidden, true);
  const antigo = t.el('campo:oldPrice');
  assert.equal(antigo.getAttribute('placeholder'), null, 'sem o exemplo "149,90" na revisão');
  assert.equal(antigo.getAttribute('aria-invalid'), null); assert.equal(antigo.classes.has('campo-suspeito'), false);
  // com preço antigo 10× maior, a trava continua
  const d = t.dados(); d.v = { ...d.v, oldPrice: 499 }; d.aoMudar(d.v);
  assert.equal(t.el('#cm-enviar').disabled, true);
  // 100% informado, mas com preço antigo menor que 10×: o desconto sai da conta dos dois preços
  const t2 = tela();
  await abrirRevisar(t2, [item({ motivos: ['desconto_100'], loja: 'amazon', oferta: oferta({ price: 50, oldPrice: 100, discountPct: 100, link: 'https://www.amazon.com.br/dp/B0FG2MD49G' }) })], 11);
  assert.match(t2.el('#dlg').innerHTML, /O Etiqueta informou 100% de desconto; esse número não vai na mensagem\. O desconto sai calculado dos dois preços \(R\$ 100,00 → R\$ 50,00\)\./);
  assert.equal(t2.el('#cm-enviar').disabled, false);
  // preço antigo ≥ 10×: a faixa de sempre (com o X×) e a trava
  const t3 = tela();
  await abrirRevisar(t3, [item({ motivos: ['desconto_100', 'preco_antigo'], oferta: oferta({ price: 10, oldPrice: 2000, discountPct: 100, link: 'https://s.shopee.com.br/AbC123' }) })], 11);
  assert.match(t3.el('#dlg').innerHTML, /preço antigo 200× maior que o preço/);
  assert.doesNotMatch(t3.el('#dlg').innerHTML, /esse número não vai na mensagem/);
  assert.equal(t3.el('#cm-enviar').disabled, true);
});

test('D2: preço suspeito marca o "Preço antigo" (aria-invalid, destaque de aviso, descrição pela trava) e o texto da trava fica no rodapé', async () => {
  const t = tela();
  const it = item({ loja: 'amazon', motivos: ['preco_antigo'], oferta: oferta({ price: 10, oldPrice: 500, discountPct: 98, link: 'https://www.amazon.com.br/dp/B0FG2MD49G' }) });
  const dlg = await abrirRevisar(t, [it], 11);
  assert.match(dlg.innerHTML, /<div class="rodape"><p class="dica nivel-aviso trava-envio" id="cm-trava" role="status" hidden><\/p><button type="button" id="cm-fechar">/);
  assert.doesNotMatch(dlg.innerHTML, /flex-wrap/, 'a quebra de linha do rodapé é do style.css');
  const antigo = t.el('campo:oldPrice');
  assert.equal(antigo.getAttribute('aria-invalid'), 'true'); assert.equal(antigo.classes.has('campo-suspeito'), true);
  assert.equal(antigo.getAttribute('aria-describedby'), 'do1-antigo cm-trava', 'mantém a dica e acrescenta a trava');
  assert.equal(t.el('#cm-enviar').getAttribute('aria-describedby'), 'cm-trava');
  // corrigido: tudo volta
  const d = t.dados(); d.v = { ...d.v, oldPrice: 20, discountPct: 50 }; d.aoMudar(d.v);
  assert.equal(antigo.getAttribute('aria-invalid'), null); assert.equal(antigo.classes.has('campo-suspeito'), false);
  assert.equal(antigo.getAttribute('aria-describedby'), 'do1-antigo');
  // link fora do esperado com preço bom: trava pelo link, mas o "Preço antigo" não fica marcado
  const t2 = tela();
  await abrirRevisar(t2, [item({ oferta: oferta({ link: 'https://evil.example/x' }) })], 11);
  assert.equal(t2.el('#cm-enviar').disabled, true);
  assert.equal(t2.el('campo:oldPrice').getAttribute('aria-invalid'), null);
});

test('D9: no "Revisar oferta", o card de erros diz "Antes de enviar, falta:", "Não foi possível enviar:" e "Não foi possível descartar:"', async () => {
  const t = tela();
  await abrirRevisar(t, [item({ oferta: oferta({ price: null, link: 'https://s.shopee.com.br/AbC123' }) })], 11);
  await t.el('#cm-enviar').onclick();
  assert.match(t.el('.erros').innerHTML, /^<b>Antes de enviar, falta:<\/b><ul><li>/);
  const t2 = tela();
  await abrirRevisar(t2, [item()], 11);
  t2.rotas['POST /api/catalogo/itens/11/enviar'] = () => [400, { erro: 'O WhatsApp está desconectado. Conecte o número antes de enviar.' }];
  await t2.el('#cm-enviar').onclick();
  assert.match(t2.el('.erros').innerHTML, /^<b>Não foi possível enviar:<\/b><ul><li>O WhatsApp está desconectado\./);
  t2.rotas['POST /api/catalogo/itens/11/descartar'] = () => [500, { erro: 'Erro interno.' }];
  await t2.el('#cm-descartar').onclick();
  assert.match(t2.el('.erros').innerHTML, /^<b>Não foi possível descartar:<\/b>/);
  // o padrão de mostrarErros não mudou (formulários e "Completar")
  const caixa = t2.el('#teste-erros'); t2.ctx.__c = caixa;
  t2.rodar("mostrarErros(__c, [{ msg: 'x' }])");
  assert.match(t2.el('.erros').innerHTML, /^<b>Antes de salvar, falta:<\/b>/);
  // o título é escapado
  t2.rodar("mostrarErros(__c, [{ msg: 'x' }], '<i>t</i>')");
  assert.match(t2.el('.erros').innerHTML, /^<b>&lt;i&gt;t&lt;\/i&gt;<\/b>/);
});

test('R5: a revisão pede cupom de até 100 ao dadosOferta; o "Completar" segue sem opções (30)', async () => {
  const t = tela();
  await abrirRevisar(t, [item()], 11);
  assert.deepEqual(json(t.dados().opcoes), { cupomMax: 100 });
  preparar(t);
  t.ctx.__it = { id: 7, espelho_id: 2, espelho_nome: 'Tech', origem_nome: 'Grupo X', asin: 'B06BR9EEZ1', status: 'na_fila', oferta: { title: 'Fone', price: 10, oldPrice: 500 } };
  t.ctx.__esp = [{ id: 2, nome: 'Tech', template_id: 1, destino_jids: ['a'], destinos_nomes: ['A'] }];
  t.rodar('ESP_H.itens = [__it]; ESP.lista = __esp;');
  t.rotas['POST /api/templates/preview'] = () => [200, { texto: 'ok' }];
  t.rodar('completarEspelhamento(7)');
  assert.equal(t.dados().opcoes, undefined);
  assert.equal(t.el('campo:oldPrice').getAttribute('placeholder'), '149,90', 'o "Completar" mantém o exemplo');
  assert.equal(t.el('campo:oldPrice').getAttribute('aria-invalid'), null, 'nem marca o preço antigo 50×');
});

test('R3: faixa de falha de link aponta para a linha no Histórico; "Enviar de novo" só para item enviado com pode_reenviar, só para o Dono, no mesmo dialog', async () => {
  const t = tela();
  const falha = item({ loja: 'ml', motivos: ['falha_link'], oferta: oferta({ link: 'https://produto.mercadolivre.com.br/MLB-123456789' }) });
  let dlg = await abrirRevisar(t, [falha], 11);
  assert.match(dlg.innerHTML, /Ao enviar, o painel tenta de novo na hora; se falhar, o motivo aparece na linha desta oferta no Histórico\./);
  assert.doesNotMatch(dlg.innerHTML, /o motivo aparece aqui/);
  // linha: botão só com pode_reenviar, só para o Dono; nome escapado
  const enviada = item({ id: 15, status: 'enviado', envio_id: 9, pode_reenviar: true, oferta: oferta({ title: `T ${XSS}`, link: 'https://s.shopee.com.br/AbC123' }),
    grupos: [{ nome: 'A', ok: false, erro: 'o WhatsApp recusou' }] });
  t.ctx.__it = enviada;
  const linha = t.rodar('hcatLinhaHtml(__it, true)'); semMarcacao(linha, 'linha com Enviar de novo');
  assert.match(linha, /<button type="button" class="" data-revisar="15" aria-label="Enviar de novo a oferta T &lt;img[^"]*, da Shopee">Enviar de novo<\/button>/);
  assert.match(linha, /Erro ao enviar para 1 grupo/);
  assert.doesNotMatch(t.rodar('hcatLinhaHtml(__it, false)'), /data-revisar|Enviar de novo|Só o Dono/);
  t.ctx.__it = { ...enviada, pode_reenviar: false }; assert.doesNotMatch(t.rodar('hcatLinhaHtml(__it, true)'), /data-revisar/);
  t.ctx.__it = { ...enviada, status: 'descartado' }; assert.doesNotMatch(t.rodar('hcatLinhaHtml(__it, true)'), /data-revisar/);
  // dialog: o mesmo, com o subtítulo do reenvio e sem "Enviar e ir para a próxima"; envia pela mesma rota
  const outra = item({ id: 16 });
  dlg = await abrirRevisar(t, [enviada, outra], 15);
  assert.equal(dlg.open, true);
  assert.match(dlg.innerHTML, /<h1>Revisar oferta<\/h1>/);
  assert.match(dlg.innerHTML, /O envio anterior não chegou a nenhum grupo \(o motivo está na linha desta oferta\)\. Confira os dados e envie de novo\./);
  assert.doesNotMatch(dlg.innerHTML, /cm-proxima/);
  t.rotas['POST /api/catalogo/itens/15/enviar'] = () => [200, { envio_id: 10 }];
  await t.el('#cm-enviar').onclick();
  assert.ok(t.pedidos.some((p) => p.metodo === 'POST' && p.caminho === '/api/catalogo/itens/15/enviar'));
  // enviado sem pode_reenviar não abre
  await abrirRevisar(t, [{ ...enviada, pode_reenviar: false }], 15);
  assert.equal(t.el('#dlg').open, false);
});

test('R8: "Ver ofertas" com fonte na primeira leitura avisa que a prévia ainda não tem ofertas (lista ou { ofertas, fontes })', async () => {
  const t = tela();
  const regra = regraCat(); regra.sources[0].primeira_leitura = true;
  preparar(t, { rules: [regra] }); t.ctx.__r = regra;
  t.rotas['GET /api/rules/3/offers'] = () => [200, []];
  await t.rodar('verOfertas(__r)');
  let html = t.el('#dlg').innerHTML;
  assert.match(html, /Primeira leitura: o disparo marca o ponto de partida na primeira execução; a prévia ainda não tem ofertas\./);
  assert.doesNotMatch(html, /Nenhuma oferta nova/);
  // resposta em objeto, com a marca na fonte
  t.ctx.__r = regraCat();
  t.rotas['GET /api/rules/3/offers'] = () => [200, { ofertas: [{ text: 'Outra fonte', fonte: 2, etiqueta: 'x', revisao: false, motivos: [] }], fontes: [{ fonte: 1, primeira_leitura: true }] }];
  await t.rodar('verOfertas(__r)');
  html = t.el('#dlg').innerHTML;
  assert.match(html, /Primeira leitura do catálogo: .*por isso a prévia ainda não traz ofertas do catálogo\./); assert.match(html, /Outra fonte/);
  // sem a marca: o vazio de sempre
  t.rotas['GET /api/rules/3/offers'] = () => [200, []];
  await t.rodar('verOfertas(__r)');
  html = t.el('#dlg').innerHTML;
  assert.match(html, /Nenhuma oferta nova dentro dos filtros/); assert.doesNotMatch(html, /Primeira leitura/);
});

test('R12: com 200 itens (o máximo da rota), a visão Catálogo avisa quantas faltam e como chegar nelas', async () => {
  const t = tela(); preparar(t, { rules: [regraCat()] });
  const muitos = Array.from({ length: 200 }, (_, i) => item({ id: 1000 + i, criado_em: 5000 - i }));
  t.rotas['GET /api/catalogo/itens'] = () => [200, { itens: muitos, contadores_24h: { enviadas: 0, descartadas: 0, para_revisar: 260 }, regras: [], para_revisar: 260, teto_revisao: 50 }];
  t.ctx.location.hash = '#historico?tipo=catalogo&status=revisao';
  await t.rodar("paginaHistorico('', new URLSearchParams('tipo=catalogo&status=revisao'))");
  assert.match(t.el('#hc-corpo').innerHTML, /Mostrando as 200 mais recentes de 260 para revisar\. Escolha um disparo no filtro acima para ver as outras \(cada disparo guarda até 50\)\./);
  await t.rodar("paginaHistorico('', new URLSearchParams('tipo=catalogo'))");
  assert.match(t.el('#hc-corpo').innerHTML, /Mostrando as 200 mais recentes\. Para achar uma mais antiga/);
  t.rotas['GET /api/catalogo/itens'] = () => [200, { itens: muitos.slice(0, 199), contadores_24h: { para_revisar: 199 }, regras: [], para_revisar: 199, teto_revisao: 50 }];
  await t.rodar("paginaHistorico('', new URLSearchParams('tipo=catalogo&status=revisao'))");
  assert.doesNotMatch(t.el('#hc-corpo').innerHTML, /Mostrando as/);
});

test('D4, D7 e R4: rótulo do desconto da fonte, dica do filtro geral e a ordem Novidades com o texto verdadeiro', () => {
  const t = tela(); preparar(t);
  t.ctx.__f = { type: 'catalogo', tag_id: null, config: { ordem: 'atualizacao' } };
  const html = t.rodar('fonteHtml(__f, 0, 1)');
  assert.match(html, /<span>Desconto mínimo no catálogo \(%\)<\/span>/);
  assert.match(html, /o “Desconto mínimo \(%\)” em Filtros é o filtro geral do disparo e vale para todas as fontes/);
  assert.match(html, /<option value="atualizacao" selected>Novidades \(após salvar\)<\/option>/);
  const T = json(t.rodar('TEXTOS_REGRA_CATALOGO'));
  assert.equal(T.ordemNovidades, 'Começa a contar quando você salva: envia o que chegar ou for atualizado no catálogo depois disso (uma nova coleta do Etiqueta conta); a mesma oferta nunca sai duas vezes neste disparo. Para mandar o que já existe, use outra ordem ou “Reler do começo”.');
  assert.doesNotMatch(JSON.stringify(T), /só o que chegar/);
});

test('D3, D5 e D6 (style.css): campo da grade no topo, rodapé que quebra linha e alvos de 44 px na revisão', () => {
  const css = fonte('style.css');
  assert.match(css, /\.grade > label\.campo, \.grade > div\.campo \{ align-content:start; \}/);
  assert.match(css, /\.rodape \{ display:flex; flex-wrap:wrap;/);
  assert.match(css, /@media \(max-width:600px\) \{ td \[data-revisar\], #cm \.rodape button \{ min-height:44px; \} \}/);
  assert.match(css, /\.campo-suspeito:not\(\.invalido\)[^{]*\{ border-color:var\(--warn\);/);
});

// dadosOferta de verdade (public/disparos.js), num vm mínimo: a opção do cupom e o 100% informado
function dadosOfertaReal() {
  const campos = []; let html = '';
  const campo = () => ({ value: '', checked: false, oninput: null, onchange: null, onclick: null, focus() {}, setAttribute() {}, getAttribute: () => null });
  const falso = () => ({ hidden: false, textContent: '', className: '', src: '', ...campo() });
  const ctx = {
    console, setTimeout, clearTimeout,
    document: { createElement: () => { const m = new Map(); return { dataset: {}, set innerHTML(v) { html = v; }, elements: { namedItem: (n) => { if (!m.has(n)) { m.set(n, campo()); campos.push(m.get(n)); } return m.get(n); } } }; }, getElementById: () => null, activeElement: null, body: falso() },
    $: () => falso(), $$: () => [], esc: (x) => String(x), zap: (x) => String(x), REQ: '*', S: { templates: [], tags: [], groups: [], st: {} },
    seletorGrupos: () => ({ html: '', ligar() {}, marcados: () => [] }), aviso() {}, mostrarErros() {}, opcoes: () => '', q: () => '',
    location: { hash: '' }, confirm: () => true, FileReader: class {}, fetch: async () => { throw new Error('rede proibida no teste'); },
  };
  vm.createContext(ctx);
  vm.runInContext(`${fonte('disparos.js')}\n;globalThis.__x = { dadosOferta };`, ctx);
  return { dadosOferta: ctx.__x.dadosOferta, html: () => html };
}

test('R5 e D1 com o dadosOferta de verdade: cupomMax 100 só quando pedido; 100% informado sem preço antigo não trava (mesma conta do servidor)', () => {
  const real = dadosOfertaReal(); const cupom = 'C'.repeat(120);
  const padrao = real.dadosOferta({ title: 'x', price: 10, coupon: cupom });
  assert.match(real.html(), /<input name="coupon" maxlength="30"/); assert.equal(padrao.valores().coupon.length, 30);
  const cat = real.dadosOferta({ title: 'x', price: 10, coupon: cupom }, () => {}, { cupomMax: 100 });
  assert.match(real.html(), /<input name="coupon" maxlength="100"/); assert.equal(cat.valores().coupon.length, 100);
  for (const ruim of [0, -1, 1.5, '100', null]) {
    real.dadosOferta({ coupon: cupom }, () => {}, { cupomMax: ruim });
    assert.match(real.html(), /<input name="coupon" maxlength="30"/, String(ruim));
  }
  // o que o painel trava é o que o servidor recusaria, com os valores que o dadosOferta de verdade entrega
  const t = tela();
  for (const o of [{ price: 49.9, oldPrice: null, discountPct: 100 }, { price: 50, oldPrice: 100, discountPct: 100 }, { price: 10, oldPrice: 100, discountPct: 100 }, { price: 10, oldPrice: 99, discountPct: 90 }]) {
    const v = real.dadosOferta({ title: 'x', ...o }).valores();
    t.ctx.__v = JSON.parse(JSON.stringify(v));
    assert.equal(t.rodar('hcatPrecoSuspeito(__v)'), precoSuspeito({ price: v.price, oldPrice: v.oldPrice, discountPct: v.discountPct }), JSON.stringify(o));
  }
  t.ctx.__v = JSON.parse(JSON.stringify(real.dadosOferta({ title: 'x', price: 49.9, oldPrice: null, discountPct: 100 }).valores()));
  assert.equal(t.rodar('hcatPrecoSuspeito(__v)'), false, '100% informado sem preço antigo: liberado');
});
