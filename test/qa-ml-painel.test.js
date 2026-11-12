// QA da entrega 2 de "Rodar sozinho" (CA2.5, CA2.16 e a parte de painel do CA2.8/CA2.11): as funções PURAS do painel que a
// entrega só tinha provado com olho (designer): `haQuanto`, as pílulas da faixa (`faixaPilulasML`, `faixa`),
// `cxMlEstado` (selo por prioridade e as duas linhas de Conexões) e `pintarEstadoML` (só mexe no que mudou, nada de HTML
// de fora), mais os textos do Catálogo que mudaram em public/espelhamento.js (`hcatMotivos`, `hcatResultado`).
// public/app.js, conexoes.js e espelhamento.js rodam num `vm` com um DOM mínimo, como test/protecao-painel.test.js.
// Nenhuma rede. O fuso do computador não importa: as datas esperadas saem dos getters locais.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lerPublic = (arq) => fs.readFileSync(path.join(RAIZ, 'public', arq), 'utf8');
const J = (x) => JSON.parse(JSON.stringify(x)); // objetos do vm têm outro protótipo
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Trecho de um arquivo de public/ entre dois marcadores. */
function trecho(arq, inicio, fim) {
  const src = lerPublic(arq); const i = src.indexOf(inicio); const f = src.indexOf(fim, i + 1);
  assert.ok(i >= 0 && f > i, `marcadores de ${arq}: ${inicio} … ${fim}`);
  return src.slice(i, f);
}

const MIN = 60000; const HORA = 3600000;
const p2 = (n) => String(n).padStart(2, '0');
const dm = (t) => { const d = new Date(t); return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}`; };
const hm = (t) => { const d = new Date(t); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; };
// meio-dia local de 11/11/2026: nenhuma conta de "há quanto tempo" atravessa a meia-noite
const AGORA = new Date(2026, 10, 11, 12, 0, 0).getTime();

// ---------------------------------------------------------------------------------------------------- app.js (faixa)
/** Elemento falso que conta quantas vezes o innerHTML foi gravado. */
function elFaixa() {
  const e = { html: '', gravacoes: 0 };
  Object.defineProperty(e, 'innerHTML', { get() { return e.html; }, set(v) { e.html = String(v); e.gravacoes++; } });
  return e;
}
const fonteFaixa = trecho('app.js', '// ---------- há quanto tempo ----------', '// ---------- regras ----------');

function carregarFaixa(st = {}) {
  const faixaEl = elFaixa();
  const ctx = {
    console, Number, String, Array, Object, Math, Date, JSON, RegExp, Promise, Error,
    esc, $: (sel) => (sel === '#faixa' ? faixaEl : null),
    S: { st: { whatsapp: { status: 'open' }, ajustes: { link_mode: 'extension' }, simulacao: false, propostas_pendentes: 0, ...st } },
  };
  vm.createContext(ctx);
  vm.runInContext(`${fonteFaixa}\n;globalThis.__x = { haQuanto, faixaPilulasML, faixa, TEXTOS_FAIXA };`, ctx);
  return { ...ctx.__x, faixaEl, ctx };
}
const F = carregarFaixa();
const haQuanto = (ts, o = {}) => F.haQuanto(ts, { agora: AGORA, ...o });

test('CA2.5 haQuanto: instante inválido, zero ou no futuro além de 1 min dá texto vazio (nunca "há NaN min")', () => {
  for (const ts of [undefined, null, 0, -5, NaN, 'abc', {}, [], Infinity]) {
    assert.equal(haQuanto(ts), '', `ts=${String(ts)}`);
    assert.equal(haQuanto(ts, { faixa: true }), '', `faixa, ts=${String(ts)}`);
  }
  assert.equal(haQuanto(AGORA + 2 * MIN), '', 'relógio do navegador atrás do servidor: nada de "há -2 min"');
  assert.equal(haQuanto(AGORA + 30000), 'agora há pouco', 'até 1 min no futuro conta como agora');
});

test('CA2.5 haQuanto: degraus do texto comum (agora há pouco, há N min, há N h, data e hora) nos limites', () => {
  const casos = [
    [0, 'agora há pouco'], [59999, 'agora há pouco'], [60000, 'há 1 min'], [59 * MIN + 59999, 'há 59 min'],
    [60 * MIN, 'há 1 h'], [23 * HORA + 59 * MIN, 'há 23 h'],
  ];
  for (const [atras, esperado] of casos) assert.equal(haQuanto(AGORA - atras), esperado, `${atras} ms atrás`);
  const ontem = AGORA - 24 * HORA;
  assert.equal(haQuanto(ontem), `em ${dm(ontem)} às ${hm(ontem)}`, '24 h ou mais: data e hora locais');
  assert.equal(haQuanto(String(AGORA - 5 * MIN)), 'há 5 min', 'o instante pode vir como texto numérico');
});

test('CA2.5 haQuanto na faixa: degraus de 5 min (no máximo 12 textos diferentes na 1ª hora, para o leitor de tela), depois horas e "desde DD/MM"', () => {
  const casos = [
    [0, 'há pouco'], [4 * MIN + 59999, 'há pouco'], [5 * MIN, 'há 5 min'], [9 * MIN + 59999, 'há 5 min'], [10 * MIN, 'há 10 min'],
    [59 * MIN, 'há 55 min'], [60 * MIN, 'há 1 h'], [2 * HORA + 30 * MIN, 'há 2 h'], [23 * HORA + 59 * MIN, 'há 23 h'],
  ];
  for (const [atras, esperado] of casos) assert.equal(haQuanto(AGORA - atras, { faixa: true }), esperado, `${atras} ms atrás`);
  const antigo = AGORA - 24 * HORA;
  assert.equal(haQuanto(antigo, { faixa: true }), `desde ${dm(antigo)}`);
  const textos = new Set();
  for (let m = 0; m < 60; m++) textos.add(haQuanto(AGORA - m * MIN, { faixa: true }));
  assert.equal(textos.size, 12, `1 + 11 degraus; veio ${[...textos].join(' | ')}`);
});

// ---------------------------------------------------------------------------------------------------- pílulas
const EXT_OK = { online: true, desatualizada: false, central: { estado: 'respondendo', falhasSeguidas: 0, emEsperaDesde: null } };
const pilulas = (e) => F.faixaPilulasML(J(e), AGORA);
/** Pílulas do html: [{ cls, link, ponto, texto }]. */
function lerPilulas(html) {
  return [...html.matchAll(/<(a|span) (?:href="([^"]*)" )?class="pilula([^"]*)">(<i><\/i>)?([^<]*)<\/\1>/g)]
    .map((m) => ({ cls: m[3].trim(), link: m[2] ?? null, ponto: !!m[4], texto: m[5] }));
}

test('CA2.5 faixa: tudo bem mostra as duas pílulas, extensão e Central, ambas ok e sem link', () => {
  assert.deepEqual(lerPilulas(pilulas(EXT_OK)), [
    { cls: 'ok', link: null, ponto: true, texto: 'Extensão do Chrome conectada' },
    { cls: 'ok', link: null, ponto: true, texto: 'Central de Afiliados respondendo' },
  ]);
});

test('CA2.5 faixa: extensão fora → pílula vermelha com link e a Central "sem informação", neutra e sem ponto (mesmo com a Central em espera gravada)', () => {
  const e = { ...EXT_OK, online: false, central: { ...EXT_OK.central, estado: 'em_espera', emEsperaDesde: AGORA - 30 * MIN } };
  assert.deepEqual(lerPilulas(pilulas(e)), [
    { cls: '', link: '#conexoes', ponto: true, texto: 'Extensão do Chrome desconectada' },
    { cls: '', link: null, ponto: false, texto: 'Central de Afiliados sem informação' },
  ]);
});

test('CA2.5 faixa: Central falhando (1 ou 2 seguidas) ainda aparece "respondendo": só Conexões mostra a falha', () => {
  const [, central] = lerPilulas(pilulas({ ...EXT_OK, central: { estado: 'falhando', falhasSeguidas: 2, emEsperaDesde: null } }));
  assert.deepEqual(central, { cls: 'ok', link: null, ponto: true, texto: 'Central de Afiliados respondendo' });
});

test('CA2.5 faixa: em espera → pílula âmbar com link e o tempo em degraus ("há pouco", "há 25 min"), a da extensão segue conectada', () => {
  for (const [atras, quando] of [[2 * MIN, 'há pouco'], [27 * MIN, 'há 25 min'], [3 * HORA, 'há 3 h']]) {
    const e = { ...EXT_OK, central: { estado: 'em_espera', falhasSeguidas: 3, emEsperaDesde: AGORA - atras } };
    assert.deepEqual(lerPilulas(pilulas(e)), [
      { cls: 'ok', link: null, ponto: true, texto: 'Extensão do Chrome conectada' },
      { cls: 'espera', link: '#conexoes', ponto: true, texto: `Mercado Livre em espera: Central sem resposta ${quando}` },
    ], quando);
  }
  // espera sem horário legível: sem "há NaN", sem espaço sobrando
  const semHora = lerPilulas(pilulas({ ...EXT_OK, central: { estado: 'em_espera', emEsperaDesde: null } }))[1];
  assert.equal(semHora.texto, 'Mercado Livre em espera: Central sem resposta');
});

test('CA2.5/CA2.16 faixa: extensão desatualizada → pílula âmbar com link; a Central segue o estado dela; só com a extensão on-line', () => {
  const [ext, cen] = lerPilulas(pilulas({ ...EXT_OK, desatualizada: true }));
  assert.deepEqual(ext, { cls: 'espera', link: '#conexoes', ponto: true, texto: 'Extensão do Chrome desatualizada' });
  assert.equal(cen.texto, 'Central de Afiliados respondendo');
  // off-line vence "desatualizada" (o servidor já manda false, mas o painel não depende disso)
  assert.equal(lerPilulas(pilulas({ ...EXT_OK, online: false, desatualizada: true }))[0].texto, 'Extensão do Chrome desconectada');
});

test('CA2.5 faixa: Central ainda não testada é neutra e sem ponto; servidor antigo (sem central) mostra só a pílula da extensão', () => {
  const [, central] = lerPilulas(pilulas({ ...EXT_OK, central: { estado: 'sem_teste' } }));
  assert.deepEqual(central, { cls: '', link: null, ponto: false, texto: 'Central de Afiliados ainda não testada' });
  assert.deepEqual(lerPilulas(pilulas({ online: true })).map((p) => p.texto), ['Extensão do Chrome conectada']);
  assert.deepEqual(lerPilulas(pilulas({ online: false })).map((p) => p.texto), ['Extensão do Chrome desconectada']);
});

test('CA2.5 faixa: o erro real da Central (texto de fora) nunca entra no HTML da faixa', () => {
  const sujo = '<img src=x onerror="alert(1)">';
  const html = pilulas({ ...EXT_OK, central: { estado: 'em_espera', emEsperaDesde: AGORA - HORA, ultimoErro: sujo } });
  assert.ok(!html.includes('onerror') && !html.includes('<img'), html);
});

test('CA2.5 faixa(): modo direto troca as duas pílulas por "Links sem etiqueta"; o resto (WhatsApp, simulação, propostas) segue', () => {
  const c = carregarFaixa({ ajustes: { link_mode: 'direct' }, extensao: EXT_OK, simulacao: true, propostas_pendentes: 2 });
  c.faixa();
  const textos = lerPilulas(c.faixaEl.html).map((p) => p.texto);
  assert.ok(textos.includes('Links sem etiqueta (modo direto)'), textos.join(' | '));
  assert.ok(!textos.some((t) => /Extensão do Chrome|Central de Afiliados/.test(t)), textos.join(' | '));
  assert.ok(textos.includes('WhatsApp conectado'));
  assert.ok(c.faixaEl.html.includes('2 propostas de grupo novo'), 'a pílula de propostas (link para #links) segue');
  assert.ok(c.faixaEl.html.includes('Modo simulação'));
});

test('CA2.5 faixa(): só repinta quando o HTML muda (a faixa é aria-live; reescrever o mesmo texto a cada 3 s faz o leitor relê-lo)', () => {
  const c = carregarFaixa({ extensao: J(EXT_OK) });
  c.faixa(); c.faixa(); c.faixa();
  assert.equal(c.faixaEl.gravacoes, 1, 'três chamadas iguais, uma gravação');
  c.ctx.S.st.extensao = { ...EXT_OK, central: { estado: 'em_espera', emEsperaDesde: Date.now() - 20 * MIN } };
  c.faixa();
  assert.equal(c.faixaEl.gravacoes, 2, 'o estado mudou: repinta');
  c.faixa();
  assert.equal(c.faixaEl.gravacoes, 2);
  assert.match(c.faixaEl.html, /Mercado Livre em espera: Central sem resposta há 20 min/);
});

// ---------------------------------------------------------------------------------------------------- conexoes.js
const fonteConexoes = lerPublic('conexoes.js');

/** Elemento falso do cartão Mercado Livre: textContent, classes, hidden, dataset, filhos e innerHTML (contados). */
function elCx() {
  const classes = new Set();
  const e = {
    _t: '', _html: '', hidden: false, className: '', dataset: {}, classes, filhos: [], escritas: 0, htmlEscritas: 0,
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle(c, on) { if (on ?? !classes.has(c)) classes.add(c); else classes.delete(c); } },
    replaceChildren(...f) { e.filhos = f; },
    get firstChild() { return e._html ? {} : null; },
    get innerHTML() { return e._html; }, set innerHTML(v) { e._html = String(v); e.htmlEscritas++; },
  };
  Object.defineProperty(e, 'textContent', { get() { return e._t; }, set(v) { e._t = String(v); e.escritas++; } });
  return e;
}

function carregarConexoes() {
  const mapa = new Map();
  const el = (k) => { if (!mapa.has(k)) mapa.set(k, elCx()); return mapa.get(k); };
  const dentro = (li, sel) => { const k = `${li === el('#ml-l-ext') ? 'ext' : 'central'}:${sel}`; return el(k); };
  const ctx = {
    console, Number, String, Array, Object, Math, Date, JSON, RegExp, Promise, Error, WeakMap,
    esc, S: { st: null, tags: [{ id: 1 }] },
    $: (sel, raiz) => (raiz && /^\./.test(sel) ? dentro(raiz, sel) : el(sel)),
    $$: () => [], dataHora: () => '', podeEquipe: () => true,
    document: { createElement: () => { const n = elCx(); return n; } },
  };
  vm.createContext(ctx);
  // a única função de app.js de que cxMlEstado depende
  vm.runInContext(`${fonteFaixa.slice(0, fonteFaixa.indexOf('// ---------- faixa de status ----------'))}\n${fonteConexoes}\n;globalThis.__x = { cxMlEstado, pintarEstadoML, TEXTOS_CONEXOES };`, ctx);
  return { ...ctx.__x, ctx, el, mapa };
}
const C = carregarConexoes();
const M = C.TEXTOS_CONEXOES.ml;

/** /api/state mínimo: extensão (com a Central) e o modo de links. */
const estado = (extensao = {}, { direto = false } = {}) => ({
  ajustes: { link_mode: direto ? 'direct' : 'extension' },
  extensao: { online: true, lastPollAt: AGORA - 5000, lastOkAt: 0, versao: '1.6.0', versaoEsperada: '1.6.0', desatualizada: false,
    central: { estado: 'respondendo', falhasSeguidas: 0, ultimoOkEm: AGORA - 2 * MIN, ultimoErroEm: 0, ultimoErro: '', emEsperaDesde: null, proximoTesteEm: null }, ...extensao },
});
const cx = (st, etiqueta = true) => J(C.cxMlEstado(J(st), etiqueta, AGORA));
const central = (c) => ({ ...estado().extensao.central, ...c });

test('CA2.5 selo do cartão: um só selo, na prioridade Falta configurar > Extensão desconectada > Central sem resposta > Extensão desatualizada > Conectado', () => {
  const espera = central({ estado: 'em_espera', falhasSeguidas: 3, emEsperaDesde: AGORA - 20 * MIN, proximoTesteEm: AGORA + 3 * MIN });
  const casos = [
    ['tudo certo', estado(), true, ['conectado', 'Conectado']],
    ['sem etiqueta, tudo mais certo', estado(), false, ['falta', 'Falta configurar']],
    ['sem etiqueta vence extensão fora, espera e antiga', estado({ online: false, desatualizada: true, central: espera }), false, ['falta', 'Falta configurar']],
    ['modo direto vence tudo', estado({ online: false }, { direto: true }), true, ['falta', 'Falta configurar']],
    ['extensão fora vence a espera', estado({ online: false, central: espera }), true, ['pendente', 'Extensão desconectada']],
    ['extensão fora vence a antiga', estado({ online: false, desatualizada: true }), true, ['pendente', 'Extensão desconectada']],
    ['espera vence a antiga', estado({ desatualizada: true, central: espera }), true, ['pendente', 'Central sem resposta']],
    ['só em espera', estado({ central: espera }), true, ['pendente', 'Central sem resposta']],
    ['só antiga', estado({ desatualizada: true, versao: '1.5.0' }), true, ['pendente', 'Extensão desatualizada']],
    ['Central falhando (1 ou 2 seguidas) ainda é Conectado', estado({ central: central({ estado: 'falhando', falhasSeguidas: 2, ultimoErroEm: AGORA - MIN, ultimoErro: 'x' }) }), true, ['conectado', 'Conectado']],
    ['Central ainda não testada é Conectado', estado({ central: central({ estado: 'sem_teste', ultimoOkEm: 0 }) }), true, ['conectado', 'Conectado']],
  ];
  for (const [nome, st, etiqueta, selo] of casos) assert.deepEqual(cx(st, etiqueta).selo, selo, nome);
});

test('CA2.5 linha da extensão: conectada (segundos até 59 s, depois "há N min"), desconectada (última conversa ou "Nunca conectou") e antiga com e sem versão', () => {
  assert.deepEqual(cx(estado({ lastPollAt: AGORA - 5000 })).linhas[0], { glifo: '✓', alerta: false, frase: 'Extensão do Chrome conectada.', quando: 'Falou com o painel há 5 s.', extra: '' });
  assert.equal(cx(estado({ lastPollAt: AGORA - 59000 })).linhas[0].quando, 'Falou com o painel há 59 s.');
  assert.equal(cx(estado({ lastPollAt: AGORA - 3 * MIN })).linhas[0].quando, 'Falou com o painel há 3 min.');
  const fora = cx(estado({ online: false, lastPollAt: AGORA - 12 * MIN })).linhas[0];
  assert.deepEqual(fora, { glifo: '!', alerta: true, frase: 'Extensão do Chrome desconectada.', quando: 'Última conversa há 12 min.', extra: M.dicaExtOff });
  assert.equal(cx(estado({ online: false, lastPollAt: 0 })).linhas[0].quando, 'Nunca conectou neste painel.');
  const antiga = cx(estado({ desatualizada: true, versao: '1.5.0' }));
  assert.equal(antiga.linhas[0].frase, 'Extensão do Chrome conectada, mas desatualizada: é a 1.5.0 e o painel espera a 1.6.0 ou mais nova.');
  assert.equal(antiga.aviso, true, 'o aviso com os passos aparece só aqui');
  const semVersao = cx(estado({ desatualizada: true, versao: null }));
  assert.equal(semVersao.linhas[0].frase, 'Extensão do Chrome conectada, mas desatualizada: é mais antiga que a 1.6.0.');
  assert.equal(cx(estado()).aviso, false);
  assert.equal(cx(estado({ online: false, desatualizada: true })).aviso, false, 'extensão fora: o aviso de atualizar não faz sentido');
});

test('CA2.5 linha da Central: respondendo, falhando, em espera, sem informação e sem teste, com há quanto tempo e o erro real entre aspas', () => {
  const [, ok] = cx(estado()).linhas;
  assert.deepEqual(ok, { glifo: '✓', alerta: false, frase: 'Central de Afiliados respondendo.', quando: 'Último link gerado há 2 min.', extra: '' });
  assert.equal(cx(estado({ central: central({ ultimoOkEm: 0 }) })).linhas[1].quando, 'Nenhum link gerado ainda.', 'persistido ou não, sem sucesso gravado');

  const falhando = cx(estado({ central: central({ estado: 'falhando', falhasSeguidas: 2, ultimoErroEm: AGORA - 3 * MIN, ultimoOkEm: AGORA - HORA, ultimoErro: 'Could not establish connection' }) })).linhas[1];
  assert.deepEqual(falhando, { glifo: '!', alerta: true, frase: 'A Central não respondeu ao último pedido.', quando: 'Há 3 min. Último link gerado há 1 h.', extra: 'Último erro: “Could not establish connection”' });

  const desde = AGORA - 25 * MIN;
  const espera = cx(estado({ central: central({ estado: 'em_espera', falhasSeguidas: 3, emEsperaDesde: desde, proximoTesteEm: AGORA + 4 * MIN - 5000, ultimoOkEm: AGORA - 3 * HORA, ultimoErro: 'a Central de Afiliados não respondeu' }) })).linhas[1];
  assert.equal(espera.frase, 'Central sem resposta. O Mercado Livre está esperando.');
  assert.equal(espera.quando, `Sem resposta desde as ${hm(desde)} (há 25 min). Novo teste em 4 min. Último link gerado há 3 h.`);
  assert.equal(espera.extra, 'Último erro: “a Central de Afiliados não respondeu”', 'menos de 1 h: sem a dica de abrir a Central');

  const semInfo = cx(estado({ online: false, central: central({ estado: 'em_espera', emEsperaDesde: desde, ultimoOkEm: AGORA - 3 * HORA }) })).linhas[1];
  assert.deepEqual(semInfo, { glifo: '–', alerta: false, frase: 'Sem informação: a extensão está desconectada.', quando: 'Último link gerado há 3 h.', extra: '' });
  const semTeste = cx(estado({ central: central({ estado: 'sem_teste', ultimoOkEm: 0 }) })).linhas[1];
  assert.deepEqual(semTeste, { glifo: '–', alerta: false, frase: 'Central ainda não testada.', quando: 'Ela é testada no primeiro link que o programa pedir.', extra: '' });
});

test('CA2.5 linha da Central em espera: "Novo teste em N min" arredonda para cima; passou do horário é "Teste em andamento…"; mais de 1 h acrescenta a dica; outro dia traz a data', () => {
  const com = (proximoTesteEm, extra = {}) => cx(estado({ central: central({ estado: 'em_espera', emEsperaDesde: AGORA - 10 * MIN, proximoTesteEm, ultimoOkEm: 0, ...extra }) })).linhas[1];
  assert.match(com(AGORA + 30000).quando, /Novo teste em menos de 1 min\./);
  assert.match(com(AGORA + 60000).quando, /Novo teste em 1 min\./);
  assert.match(com(AGORA + 60001).quando, /Novo teste em 2 min\./, 'arredonda para cima');
  assert.match(com(AGORA + 5 * MIN).quando, /Novo teste em 5 min\./);
  assert.match(com(AGORA).quando, /Teste em andamento…/);
  assert.match(com(AGORA - MIN).quando, /Teste em andamento…/);
  assert.doesNotMatch(com(null).quando, /teste/i, 'sem horário de teste, a frase some (nada de "em NaN min")');
  assert.match(com(AGORA + MIN).quando, /Nenhum link gerado ainda\.$/);
  const longa = com(AGORA + MIN, { emEsperaDesde: AGORA - 90 * MIN, ultimoErro: 'x' });
  assert.equal(longa.extra, `Último erro: “x”\n${M.dicaEspera}`);
  const ontem = AGORA - 25 * HORA;
  const outroDia = com(AGORA + MIN, { emEsperaDesde: ontem }).quando;
  assert.ok(outroDia.startsWith(`Sem resposta desde ${dm(ontem)} às ${hm(ontem)} (em ${dm(ontem)} às ${hm(ontem)}).`), outroDia);
});

test('CA2.5 servidor antigo: sem `extensao.central` o painel mostra só a linha da extensão e o selo continua certo (não quebra)', () => {
  const antigo = estado(); delete antigo.extensao.central; delete antigo.extensao.versaoEsperada; delete antigo.extensao.desatualizada;
  const m = cx(antigo);
  assert.equal(m.linhas.length, 1);
  assert.deepEqual(m.selo, ['conectado', 'Conectado']);
  assert.doesNotThrow(() => C.cxMlEstado({ ajustes: {}, extensao: undefined }, true, AGORA), 'state sem extensao');
});

test('CA2.5 último link gerado: vale o maior entre o da Central gravada (persiste entre reinícios) e o lastOkAt em memória', () => {
  const m = cx(estado({ lastOkAt: AGORA - 10 * MIN, central: central({ ultimoOkEm: 0 }) }));
  assert.equal(m.linhas[1].quando, 'Último link gerado há 10 min.');
  const n = cx(estado({ lastOkAt: AGORA - 10 * MIN, central: central({ ultimoOkEm: AGORA - 4 * MIN }) }));
  assert.equal(n.linhas[1].quando, 'Último link gerado há 4 min.');
});

test('CA2.5 pintarEstadoML: o erro real entra só como texto (nunca como HTML) e a frase viva não é regravada quando nada mudou', () => {
  const c = carregarConexoes();
  const sujo = '<img src=x onerror="alert(1)">&"\'';
  c.ctx.S.st = J(estado({ central: central({ estado: 'falhando', falhasSeguidas: 1, ultimoErroEm: Date.now() - MIN, ultimoErro: sujo }) }));
  c.ctx.S.st.extensao.lastPollAt = Date.now() - 1000;
  c.pintarEstadoML();
  const extra = c.mapa.get('central:.extra');
  assert.equal(extra.filhos.length, 1);
  assert.equal(extra.filhos[0].textContent, `Último erro: “${sujo}”`, 'o texto cru, via textContent');
  assert.equal(extra.htmlEscritas, 0, 'nenhum innerHTML com dado de fora');
  assert.equal(c.mapa.get('#ml-aviso').htmlEscritas, 0, 'extensão atualizada: nenhum aviso');
  const frase = c.mapa.get('central:.frase'); const antes = frase.escritas;
  c.pintarEstadoML(); c.pintarEstadoML();
  assert.equal(frase.escritas, antes, 'a frase (região viva) não é regravada a cada 3 s');
  assert.equal(extra.filhos.length, 1);
});

test('CA2.5/CA2.16 pintarEstadoML: extensão antiga mostra o aviso fixo com os passos e o recarregar; atualizada o esconde', () => {
  const c = carregarConexoes();
  c.ctx.S.st = J(estado({ desatualizada: true, versao: '1.5.0' }));
  c.pintarEstadoML();
  const aviso = c.mapa.get('#ml-aviso');
  assert.equal(aviso.hidden, false);
  assert.match(aviso.innerHTML, /chrome:\/\/extensions/);
  assert.match(aviso.innerHTML, /recarregar/);
  assert.equal(c.mapa.get('#ml-selo').textContent, 'Extensão desatualizada');
  c.ctx.S.st = J(estado());
  c.pintarEstadoML();
  assert.equal(aviso.hidden, true);
  assert.equal(c.mapa.get('#ml-selo').textContent, 'Conectado');
  assert.equal(c.mapa.get('#ml-selo').className, 'estado-pill conectado');
});

test('CA2.5 pintarEstadoML: sem a linha da Central (servidor antigo) esconde a 2ª linha em vez de deixar texto velho', () => {
  const c = carregarConexoes();
  c.ctx.S.st = J(estado());
  c.pintarEstadoML();
  assert.equal(c.mapa.get('#ml-l-central').hidden, false);
  const antigo = estado(); delete antigo.extensao.central;
  c.ctx.S.st = J(antigo);
  c.pintarEstadoML();
  assert.equal(c.mapa.get('#ml-l-central').hidden, true);
});

// ---------------------------------------------------------------------------------------------------- espelhamento.js
const fonteHcat = trecho('espelhamento.js', 'const HCAT_QUEDA_LIMITE', 'const hcatNomeLoja');

test('CA2.11 revisão do Catálogo: o motivo da queda diz a % real (1 a 99) e, sem ela (ou com 100/0/lixo), cai no texto genérico', () => {
  const src = lerPublic('espelhamento.js');
  const iTextos = src.indexOf('const TEXTOS_REVISAO_CATALOGO = {');
  const fTextos = src.indexOf('\n};', iTextos) + 3;
  const ctx = { console, Number, String, Array, Object, Math, Date, JSON, RegExp, esc, espN: (n, a, b) => `${n} ${n === 1 ? a : b}` };
  vm.createContext(ctx);
  vm.runInContext(`${src.slice(iTextos, fTextos)}\n${fonteHcat}\n;globalThis.__x = { hcatMotivos, hcatQuedaPct, TEXTOS_REVISAO_CATALOGO };`, ctx);
  const { hcatMotivos, hcatQuedaPct } = ctx.__x;
  assert.equal(hcatMotivos(['queda_preco'], { queda_pct: 62 }), 'Preço 62% abaixo da lista: confira o preço');
  assert.equal(hcatMotivos(['queda_preco'], { queda_pct: 99 }), 'Preço 99% abaixo da lista: confira o preço');
  for (const ruim of [100, 0, -3, 49.5, '62', null, undefined, NaN]) {
    assert.equal(hcatQuedaPct({ queda_pct: ruim }), null, `queda_pct=${String(ruim)}`);
    assert.equal(hcatMotivos(['queda_preco'], { queda_pct: ruim }), 'Preço muito abaixo da lista: confira o preço', String(ruim));
  }
  assert.equal(hcatMotivos(['queda_preco', 'desconto_100'], { queda_pct: 60 }), 'preço 60% abaixo da lista e desconto de 100%. Confira o preço.');
  assert.equal(hcatMotivos(['falhas_repetidas']), 'Falhou 3 vezes seguidas: confira a oferta e envie');
  assert.equal(hcatMotivos(['motivo_que_nao_existe', 'queda_preco'], { queda_pct: 70 }), 'Preço 70% abaixo da lista: confira o preço', 'motivo desconhecido não aparece');
  assert.equal(hcatMotivos(['__proto__', 'constructor', 'toString']), '', 'chave herdada do Object não vira texto');
});
