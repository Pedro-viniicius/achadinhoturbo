// QA da entrega 3 de "Rodar sozinho" (Vigia), a parte de tela (CA3.4 e CA3.11), que a etapa 6 só conferiu por captura:
// `faixaPilulasVigia`, `vigiaDesde`, `vigiaNomeCurto` e `faixa()` de public/app.js, e `linhaVigia` de public/relatorios.js.
// Rodam num `vm` com um DOM mínimo, como test/qa-ml-painel.test.js. Nenhuma rede. O relógio do `faixa()` é falso (Date
// fixo em AGORA) e as datas esperadas saem dos getters locais: o fuso do computador não importa.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lerPublic = (arq) => fs.readFileSync(path.join(RAIZ, 'public', arq), 'utf8');
const J = (x) => JSON.parse(JSON.stringify(x));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function trecho(arq, inicio, fim) {
  const src = lerPublic(arq); const i = src.indexOf(inicio); const f = src.indexOf(fim, i + 1);
  assert.ok(i >= 0 && f > i, `marcadores de ${arq}: ${inicio} … ${fim}`);
  return src.slice(i, f);
}

const MIN = 60000; const HORA = 3600000;
const p2 = (n) => String(n).padStart(2, '0');
const hm = (t) => { const d = new Date(t); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; };
const dm = (t) => { const d = new Date(t); return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}`; };
const AGORA = new Date(2026, 10, 11, 12, 0, 0).getTime(); // meio-dia local: nada atravessa a meia-noite

// ------------------------------------------------------------------------------------------------ app.js (faixa)
function elFaixa() {
  const e = { html: '', gravacoes: 0 };
  Object.defineProperty(e, 'innerHTML', { get() { return e.html; }, set(v) { e.html = String(v); e.gravacoes++; } });
  return e;
}
const fonteFaixa = trecho('app.js', '// ---------- há quanto tempo ----------', '// ---------- regras ----------');
/** Date que, sem argumentos, vale AGORA (o faixa() chama faixaPilulasVigia sem relógio). */
class DataFixa extends Date {
  constructor(...a) { if (a.length) super(...a); else super(AGORA); }
  static now() { return AGORA; }
}

function carregar(st = {}) {
  const faixaEl = elFaixa();
  const ctx = {
    console, Number, String, Array, Object, Math, JSON, RegExp, Promise, Error, Date: DataFixa, Intl,
    esc, $: (sel) => (sel === '#faixa' ? faixaEl : null),
    S: { st: { whatsapp: { status: 'open' }, ajustes: { link_mode: 'extension' }, simulacao: false, propostas_pendentes: 0, ...st } },
  };
  vm.createContext(ctx);
  vm.runInContext(`${fonteFaixa}\n;globalThis.__x = { faixaPilulasVigia, vigiaDesde, vigiaNomeCurto, faixa, TEXTOS_VIGIA };`, ctx);
  return { ...ctx.__x, faixaEl, ctx };
}
const C = carregar();
const pilulasDe = (v) => C.faixaPilulasVigia(J(v), AGORA);
/** [{ cls, link, ponto, texto }] das pílulas do html. */
function ler(html) {
  return [...html.matchAll(/<(a|span) (?:href="([^"]*)" )?class="pilula([^"]*)">(<i><\/i>)?([^<]*)<\/\1>/g)]
    .map((m) => ({ cls: m[3].trim(), link: m[2] ?? null, ponto: !!m[4], texto: m[5] }));
}
const causa = (tipo, extra = {}) => ({ tipo, chave: tipo, desdeEm: AGORA - 2 * HORA, n: 0, calada: false, ...extra });
const LOJA_AMAZON = causa('loja', { loja: 'amazon', chave: 'loja:amazon', desdeEm: AGORA - 2 * HORA });
const LOJA_ML = causa('loja', { loja: 'ml', chave: 'loja:ml', desdeEm: AGORA - 3 * HORA });
const REGRA = causa('regra', { rule_id: 7, chave: 'regra:7', regra: 'Black_Operação', desdeEm: AGORA - 90 * MIN });
const REVISAO = causa('revisao', { n: 12, desdeEm: AGORA - 4 * HORA });
const EXTENSAO = causa('extensao', { chave: 'ml_fora', desdeEm: AGORA - 40 * MIN });
const CENTRAL = causa('central', { chave: 'ml_fora', desdeEm: AGORA - 40 * MIN });
const ok = (...causas) => ({ ok: true, causas, avaliadoEm: AGORA });

test('CA3.4 faixa: sem causa, sem vigia (null, ausente, tipo errado) ou ainda carregando não pinta nenhuma pílula do vigia', () => {
  assert.equal(pilulasDe(ok()), '', 'ok, sem causas: nada (não escrever "tudo certo")');
  for (const v of [null, undefined, 'texto', 42, true]) assert.equal(C.faixaPilulasVigia(v, AGORA), '', `vigia=${String(v)}`);
  assert.equal(C.faixaPilulasVigia([], AGORA), '', 'lista no lugar do objeto: não é o formato do vigia');
  assert.equal(pilulasDe({ ok: true }), '', 'sem o campo causas');
  assert.equal(pilulasDe({ ok: true, causas: 'x' }), '');
  assert.equal(pilulasDe({ ok: true, causas: [null, undefined, 3, 'a'] }), '', 'itens que não são objetos são ignorados');
});

test('CA3.11 faixa: vigia.ok === false mostra só "Vigia sem leitura agora", neutra, sem ponto, sem link e sem as causas', () => {
  const esperado = '<span class="pilula">Vigia sem leitura agora</span>';
  assert.equal(pilulasDe({ ok: false, causas: [] }), esperado);
  assert.equal(pilulasDe({ ok: false, causas: [LOJA_AMAZON, REGRA] }), esperado, 'na falha não mostra o que sobrou de causas');
  assert.equal(pilulasDe({ ok: false }), esperado);
  assert.equal(pilulasDe({ ok: 0, causas: [LOJA_AMAZON] }) === esperado, false, 'só false estrito é falha (0 não)');
  const [p] = ler(esperado);
  assert.deepEqual(p, { cls: '', link: null, ponto: false, texto: 'Vigia sem leitura agora' });
});

test('CA3.4 faixa: uma causa de cada tipo, com o texto, o início e o link da spec', () => {
  assert.deepEqual(ler(pilulasDe(ok(LOJA_AMAZON))), [
    { cls: 'espera vigia', link: '#historico', ponto: true, texto: `Amazon parada desde ${hm(AGORA - 2 * HORA)} (há 2 h)` }]);
  assert.deepEqual(ler(pilulasDe(ok(LOJA_ML))), [
    { cls: 'espera vigia', link: '#historico', ponto: true, texto: `Mercado Livre parado desde ${hm(AGORA - 3 * HORA)} (há 3 h)` }]);
  assert.deepEqual(ler(pilulasDe(ok(REGRA))), [
    { cls: 'espera vigia', link: '#disparo-automatico', ponto: true, texto: `Regra “Black_Operação” saiu vazia desde ${hm(AGORA - 90 * MIN)} (há 1 h)` }]);
  assert.deepEqual(ler(pilulasDe(ok(REVISAO))), [
    { cls: 'espera vigia', link: '#historico?tipo=catalogo&amp;status=revisao', ponto: true, texto: `12 ofertas esperando revisão desde ${hm(AGORA - 4 * HORA)} (há 4 h)` }]);
  assert.deepEqual(ler(pilulasDe(ok(causa('revisao', { n: 1 })))).map((p) => p.texto), [`1 oferta esperando revisão desde ${hm(AGORA - 2 * HORA)} (há 2 h)`]);
});

test('CA3.4 faixa: extensão ou Central sozinha não ganha pílula do vigia (ficam nas pílulas do Mercado Livre)', () => {
  assert.equal(pilulasDe(ok(EXTENSAO)), '');
  assert.equal(pilulasDe(ok(CENTRAL)), '');
  assert.deepEqual(ler(pilulasDe(ok(EXTENSAO, LOJA_AMAZON))).map((p) => p.texto.split(' desde')[0]), ['Amazon parada'], 'duas causas: só a da loja tem pílula');
});

test('CA3.4 faixa: com 2 causas próprias aparecem as duas, na ordem loja, regra, revisão (empate: a mais antiga primeiro), seja qual for a ordem de entrada', () => {
  const ordem = (v) => ler(pilulasDe(ok(...v))).map((p) => p.texto.split(' desde')[0].split(' ').slice(0, 2).join(' '));
  assert.deepEqual(ordem([REVISAO, REGRA]), ['Regra “Black_Operação”', '12 ofertas']);
  assert.deepEqual(ordem([REGRA, REVISAO]), ['Regra “Black_Operação”', '12 ofertas']);
  assert.deepEqual(ordem([REGRA, LOJA_AMAZON]), ['Amazon parada', 'Regra “Black_Operação”']);
  assert.deepEqual(ordem([REVISAO, LOJA_ML]), ['Mercado Livre', '12 ofertas']);
  // duas lojas: a mais antiga (ML, 3 h) antes da Amazon (2 h), mesmo vindo depois
  assert.deepEqual(ordem([LOJA_AMAZON, LOJA_ML]), ['Mercado Livre', 'Amazon parada']);
  assert.deepEqual(ordem([LOJA_ML, LOJA_AMAZON]), ['Mercado Livre', 'Amazon parada']);
});

test('CA3.4 faixa: 3 ou mais causas viram a mais prioritária e "+N problemas em aberto" (N = total − 1; extensão e Central contam)', () => {
  const [a, b] = ler(pilulasDe(ok(REVISAO, REGRA, LOJA_AMAZON)));
  assert.match(a.texto, /^Amazon parada desde /);
  assert.deepEqual({ cls: b.cls, link: b.link, ponto: b.ponto, texto: b.texto }, { cls: 'espera vigia', link: '#historico', ponto: true, texto: '+2 problemas em aberto' });
  assert.equal(ler(pilulasDe(ok(REVISAO, REGRA, LOJA_AMAZON))).length, 2, 'no máximo duas pílulas');
  // extensão (sem pílula própria) + regra + revisão: a regra é a primeira e o +2 conta a extensão
  assert.deepEqual(ler(pilulasDe(ok(EXTENSAO, REVISAO, REGRA))).map((p) => p.texto.replace(/ desde .*/, '')), ['Regra “Black_Operação” saiu vazia', '+2 problemas em aberto']);
  // 5 causas: +4
  assert.equal(ler(pilulasDe(ok(CENTRAL, LOJA_AMAZON, LOJA_ML, REGRA, REVISAO))).at(-1).texto, '+4 problemas em aberto');
  assert.equal(C.TEXTOS_VIGIA.mais(1), '+1 problema em aberto', 'singular');
});

test('CA3.4 faixa: causa calada não aparece nem entra na conta do "+N"', () => {
  assert.equal(pilulasDe(ok({ ...LOJA_ML, calada: true })), '');
  assert.deepEqual(ler(pilulasDe(ok({ ...LOJA_ML, calada: true }, REGRA))).map((p) => p.texto.replace(/ desde .*/, '')), ['Regra “Black_Operação” saiu vazia']);
  assert.deepEqual(ler(pilulasDe(ok({ ...LOJA_ML, calada: true }, REGRA, REVISAO))).map((p) => p.texto.replace(/ desde .*/, '')), ['Regra “Black_Operação” saiu vazia', '12 ofertas esperando revisão'], 'duas abertas: sem "+N"');
});

test('CA3.4 faixa: nome de regra com HTML é escapado (nada de tag, atributo ou aspas soltas na faixa)', () => {
  const nomes = ['<img src=x onerror=alert(1)>', '"><script>alert(1)</script>', "a'b\"c&d<e>", '&lt;b&gt;', '</a><a href="javascript:alert(1)">x'];
  for (const regra of nomes) {
    const html = pilulasDe(ok(causa('regra', { rule_id: 1, chave: 'regra:1', regra })));
    assert.doesNotMatch(html, /<(img|script|b)\b|<\/a><a|onerror=[^&]*>/, html);
    assert.equal((html.match(/<a /g) || []).length, 1, 'uma pílula só, a tag não fecha antes da hora');
    assert.ok(html.includes(esc(regra)), `o nome sai escapado: ${html}`);
  }
  // loja com chave estranha também não abre HTML
  assert.doesNotMatch(pilulasDe(ok(causa('loja', { loja: '<b>x</b>', chave: 'loja:<b>' }))), /<b>/);
});

test('CA3.4 faixa: dado fora do formato não quebra nem mostra NaN, undefined ou null', () => {
  const lixo = [
    causa('regra', { regra: undefined }), causa('regra', { regra: null, desdeEm: null }), causa('regra', { regra: '', desdeEm: 'abc' }),
    causa('revisao', { n: 'doze' }), causa('revisao', { n: -3 }), causa('revisao', { n: NaN, desdeEm: 0 }), causa('revisao', { n: null }),
    causa('loja', { loja: undefined, chave: undefined }), causa('xyz'), causa(undefined),
  ];
  for (const c of lixo) {
    const html = assert.doesNotThrow(() => pilulasDe(ok(c))) ?? pilulasDe(ok(c));
    assert.doesNotMatch(html, /NaN|undefined|null|Infinity|\[object/, `${JSON.stringify(c)} → ${html}`);
  }
  assert.deepEqual(ler(pilulasDe(ok(causa('regra', { regra: undefined })))).map((p) => p.texto.replace(/ desde .*/, '')), ['Uma regra saiu vazia'], 'regra sem nome: "Uma regra"');
  assert.deepEqual(ler(pilulasDe(ok(causa('revisao', { n: 'doze' })))).map((p) => p.texto.replace(/ desde .*/, '')), ['Ofertas esperando revisão']);
  assert.deepEqual(ler(pilulasDe(ok(causa('xyz')))), [], 'tipo desconhecido: sem pílula');
  // sem instante válido: sem "desde" (nunca "desde Invalid Date")
  assert.deepEqual(ler(pilulasDe(ok(causa('loja', { loja: 'amazon', desdeEm: null })))).map((p) => p.texto), ['Amazon parada ']);
  assert.deepEqual(ler(pilulasDe(ok(causa('loja', { loja: 'amazon', desdeEm: AGORA + 5 * HORA })))).map((p) => p.texto), ['Amazon parada '], 'início no futuro: sem "desde"');
});

test('CA3.4 vigiaDesde: hora fixa de início, "(há …)" em degraus; outro dia com a data; mais de 24 h só a data', () => {
  const d = (ts) => C.vigiaDesde(ts, AGORA);
  assert.equal(d(AGORA - 2 * MIN), `desde ${hm(AGORA - 2 * MIN)} (há pouco)`);
  assert.equal(d(AGORA - 7 * MIN), `desde ${hm(AGORA - 7 * MIN)} (há 5 min)`);
  assert.equal(d(AGORA - 59 * MIN), `desde ${hm(AGORA - 59 * MIN)} (há 55 min)`);
  assert.equal(d(AGORA - 2 * HORA - 30 * MIN), `desde ${hm(AGORA - 150 * MIN)} (há 2 h)`);
  // ontem (14 h atrás é 22:00 do dia 10): a data junto
  const ontem = AGORA - 14 * HORA;
  assert.equal(d(ontem), `desde ${hm(ontem)} de ${dm(ontem)} (há 14 h)`);
  const antigo = AGORA - 25 * HORA;
  assert.equal(d(antigo), `desde ${dm(antigo)}`, 'passou de 24 h: só a data');
  for (const ts of [undefined, null, 0, -1, NaN, 'abc', AGORA + 2 * MIN, AGORA + HORA]) assert.equal(d(ts), '', `ts=${String(ts)}`);
  // a hora de início não muda enquanto o relógio anda dentro do mesmo degrau
  assert.equal(C.vigiaDesde(AGORA - 7 * MIN, AGORA + 20000), C.vigiaDesde(AGORA - 7 * MIN, AGORA));
});

test('CA3.4/CA3.11 faixa(): ordem das pílulas (WhatsApp, Mercado Livre, vigia, propostas) e só repinta quando o HTML muda', () => {
  const extensao = { online: true, desatualizada: false, central: { estado: 'respondendo', falhasSeguidas: 0, emEsperaDesde: null } };
  const c = carregar({ extensao, vigia: ok(LOJA_AMAZON), propostas_pendentes: 1 });
  c.faixa();
  const html = c.faixaEl.html;
  const posicoes = ['WhatsApp conectado', 'Extensão do Chrome conectada', 'Central de Afiliados respondendo', 'Amazon parada desde', '1 proposta de grupo novo'].map((x) => html.indexOf(x));
  assert.ok(posicoes.every((x) => x >= 0), html);
  assert.deepEqual(posicoes, [...posicoes].sort((a, b) => a - b), `ordem das pílulas: ${html}`);
  c.faixa(); c.faixa();
  assert.equal(c.faixaEl.gravacoes, 1, 'três chamadas iguais, uma gravação (a faixa é aria-live)');
  // o relógio anda dentro do mesmo degrau de 5 min: o HTML é o mesmo e não repinta
  c.ctx.S.st.vigia = J(ok(LOJA_AMAZON));
  c.faixa();
  assert.equal(c.faixaEl.gravacoes, 1, 'mesmo conteúdo em outro objeto: não repinta');
  // uma causa nova repinta; a causa que fecha também
  c.ctx.S.st.vigia = ok(LOJA_AMAZON, REGRA);
  c.faixa();
  assert.equal(c.faixaEl.gravacoes, 2);
  assert.match(c.faixaEl.html, /Regra “Black_Operação” saiu vazia/);
  c.ctx.S.st.vigia = ok();
  c.faixa();
  assert.equal(c.faixaEl.gravacoes, 3);
  assert.doesNotMatch(c.faixaEl.html, /parada|vazia/);
  // "Vigia sem leitura agora" aparece, e sai quando a leitura volta
  c.ctx.S.st.vigia = { ok: false, causas: [], avaliadoEm: null };
  c.faixa();
  assert.match(c.faixaEl.html, /<span class="pilula">Vigia sem leitura agora<\/span>/);
  c.ctx.S.st.vigia = ok();
  c.faixa();
  assert.doesNotMatch(c.faixaEl.html, /Vigia sem leitura/);
  // servidor sem o vigia (null) e estado ainda sem a chave: nenhuma pílula do vigia e nenhum erro
  for (const v of [null, undefined]) {
    c.ctx.S.st.vigia = v;
    assert.doesNotThrow(() => c.faixa());
    assert.doesNotMatch(c.faixaEl.html, /Vigia|parada|vazia/);
  }
});

// ------------------------------------------------------------------------------------------------ relatorios.js (linhaVigia)
const fonteRelatorios = `${trecho('relatorios.js', 'const TEXTOS_RELATORIOS', 'async function paginaRelatorios')}\n${trecho('relatorios.js', '/** Linha informativa do vigia', 'function pintarRelatorios')}`;

function carregarRelatorios(vigia, { semS = false } = {}) {
  const ctx = {
    console, Number, String, Array, Object, Math, JSON, RegExp, Promise, Error, Date: DataFixa, Intl, esc,
    q: (chave) => `<q data-chave="${chave}"></q>`,
    ...(semS ? {} : { S: { st: { vigia } } }),
  };
  vm.createContext(ctx);
  vm.runInContext(`${fonteFaixa}\n${fonteRelatorios}\n;globalThis.__x = { linhaVigia, TEXTOS_RELATORIOS };`, ctx);
  return ctx.__x;
}
const COM_ERRO = [{ ativo: true, avisos: ['erro'] }];
const texto = (html) => html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

test('CA3.4 linhaVigia: sem causas, "Nenhum problema em aberto."; o ícone de ajuda e a frase do resumo estão na linha', () => {
  const { linhaVigia, TEXTOS_RELATORIOS: T } = carregarRelatorios(ok());
  const html = linhaVigia({ destinos: COM_ERRO });
  assert.match(html, /^<p class="dica" id="rel-vigia"/);
  assert.match(html, /<q data-chave="relatorios.vigia"><\/q>/);
  assert.equal(texto(html), `${T.vigia} Nenhum problema em aberto. ${T.resumoSaude}`);
  assert.doesNotMatch(texto(html), /Ninguém recebe/);
});

test('CA3.4 linhaVigia: lista as causas em aberto com os nomes curtos e ignora a calada', () => {
  const v = ok(LOJA_AMAZON, REGRA, REVISAO, EXTENSAO, { ...LOJA_ML, calada: true });
  const { linhaVigia } = carregarRelatorios(v);
  assert.match(texto(linhaVigia({ destinos: COM_ERRO })), /Em aberto agora: Amazon parada; Regra “Black_Operação” saiu vazia; 12 ofertas esperando revisão; Extensão do Chrome fora\. /);
  assert.doesNotMatch(texto(linhaVigia({ destinos: COM_ERRO })), /Mercado Livre parado/);
  const c = carregarRelatorios(ok(CENTRAL)).linhaVigia({ destinos: COM_ERRO });
  assert.match(texto(c), /Em aberto agora: Mercado Livre em espera\./);
});

test('CA3.11 linhaVigia: ok:false mostra "Sem leitura agora; tentando de novo no próximo ciclo." e não lista causas', () => {
  const html = carregarRelatorios({ ok: false, causas: [LOJA_AMAZON] }).linhaVigia({ destinos: COM_ERRO });
  assert.match(texto(html), /Sem leitura agora; tentando de novo no próximo ciclo\./);
  assert.doesNotMatch(texto(html), /Amazon parada|Nenhum problema/);
});

test('CA3.4/CA3.11 linhaVigia: vigia null, ausente, S inexistente ou de tipo errado não pinta a linha (e não lança)', () => {
  for (const v of [null, undefined, 'x', 7, true]) assert.equal(carregarRelatorios(v).linhaVigia({ destinos: COM_ERRO }), '', `vigia=${String(v)}`);
  assert.equal(carregarRelatorios(null, { semS: true }).linhaVigia({ destinos: COM_ERRO }), '');
  assert.doesNotThrow(() => carregarRelatorios({ ok: true, causas: 'não é lista' }).linhaVigia({ destinos: COM_ERRO }));
  assert.match(texto(carregarRelatorios({ ok: true, causas: 'não é lista' }).linhaVigia({ destinos: COM_ERRO })), /Nenhum problema em aberto\./);
});

test('CA3.5 linhaVigia: avisa quando ninguém recebe (nenhum número ativo com "Erro de disparo")', () => {
  const { linhaVigia, TEXTOS_RELATORIOS: T } = carregarRelatorios(ok(LOJA_AMAZON));
  for (const destinos of [[], [{ ativo: true, avisos: ['lotacao'] }], [{ ativo: false, avisos: ['erro'] }], [{ ativo: true, avisos: 'erro' }], [{ ativo: true }], [{ ativo: true, avisos: null }]]) {
    assert.ok(texto(linhaVigia({ destinos })).includes(T.vigiaSemDestino), JSON.stringify(destinos));
  }
  for (const destinos of [COM_ERRO, [{ ativo: false, avisos: ['erro'] }, { ativo: true, avisos: ['lotacao', 'erro'] }]]) {
    assert.ok(!texto(linhaVigia({ destinos })).includes(T.vigiaSemDestino), JSON.stringify(destinos));
  }
});

test('CA3.4 linhaVigia: nome de regra com HTML é escapado', () => {
  const html = carregarRelatorios(ok(causa('regra', { rule_id: 1, chave: 'regra:1', regra: '<img src=x onerror=alert(1)>' }))).linhaVigia({ destinos: COM_ERRO });
  assert.doesNotMatch(html, /<img/);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});
