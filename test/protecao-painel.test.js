// Painel da proteção do número (plano anti-banimento, etapa 7; CA8 e CA9; spec docs/produto/specs/anti-banimento.md):
// o cartão "Proteção do número" de Ajustes (teto por hora, uso, horário de silêncio e pausas, num salvar só), a linha de
// uso e a dica do chip em Números, o <small> de "Funciona das", o selo "Falta 2º admin" e o aviso em Grupos e os
// verbetes novos de TIPS. As funções saem do public/app.js e do public/paineis.js por marcadores e rodam num `vm` com um
// DOM mínimo; o último teste liga o painel ao servidor de verdade (GET /api/state, PUT /api/protecao, GET /api/groups).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { buildApp, criarServicos } from '../src/server.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createLinkService } from '../src/links.js';
import { semearProtecao } from '../src/ritmo.js';

let acessosRede = 0;
globalThis.fetch = async () => { acessosRede++; throw new Error('rede proibida no teste'); };
const redeProibida = async () => { acessosRede++; throw new Error('rede proibida no teste'); };

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lerPublic = (arq) => fs.readFileSync(path.join(RAIZ, 'public', arq), 'utf8');
const J = (x) => JSON.parse(JSON.stringify(x)); // objetos do vm têm outro protótipo
const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-prot-painel-')); pastas.push(p); return p; };

/** Trecho de um arquivo de public/ entre dois marcadores (o arquivo inteiro precisa do DOM e do carregar()). */
function trecho(arq, inicio, fim) {
  const src = lerPublic(arq); const i = src.indexOf(inicio); const f = src.indexOf(fim, i + 1);
  assert.ok(i >= 0 && f > i, `marcadores de ${arq}: ${inicio} … ${fim}`);
  return src.slice(i, f);
}
const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Elemento falso: o que o painel toca (valor, atributos, classes, dataset, eventos e foco). */
function el() {
  const classes = new Set(); const attrs = new Map(); const ouvintes = {}; let html = ''; const gravacoes = [];
  const e = {
    value: '', checked: false, disabled: false, hidden: false, textContent: '', dataset: {}, style: {}, focado: 0, classes, gravacoes,
    get innerHTML() { return html; }, set innerHTML(v) { html = String(v); gravacoes.push(html); },
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); } },
    setAttribute: (k, v) => attrs.set(k, String(v)), getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null), removeAttribute: (k) => attrs.delete(k),
    addEventListener: (t, f) => { (ouvintes[t] ||= []).push(f); },
    focus() { this.focado++; }, closest: () => null, contains: () => false,
    /** Digita: troca o valor e dispara `oninput` e os ouvintes, como o navegador. */
    digitar(v) { this.value = v; this.oninput?.(); for (const f of ouvintes.input || []) f(); },
  };
  return e;
}
/** `$` falso: um elemento por seletor; `ausentes` são os que não existem na página (devolvem null). */
function fabricaDollar(ausentes = []) {
  const mapa = new Map();
  return { mapa, $: (sel) => { if (ausentes.includes(sel)) return null; if (!mapa.has(sel)) mapa.set(sel, el()); return mapa.get(sel); } };
}

const PROTECAO = (extra = {}) => ({
  limite_hora: 40, usados: 12, libera_em: null, variacao_pausa: 0.3,
  silencio: { ativo: true, de: '23:00', ate: '07:00', agora: false, ate_ts: null },
  limites: { limite_hora_min: 1, limite_hora_max: 200, delay_group_min: 2, delay_group_max: 60, delay_offer_min: 5, delay_offer_max: 600 },
  ...extra,
});
const AJUSTES = { delay_group_s: 6, delay_offer_s: 30 };

/** O bloco da proteção do app.js (textos e funções do cartão) num vm. */
function painel({ st = {}, dono = true, ausentes = [], resposta } = {}) {
  const { $, mapa } = fabricaDollar(ausentes);
  const pedidos = []; const avisos = []; let falha = null; let estados = 0;
  const S = { st: { whatsapp: { status: 'open' }, ajustes: { ...AJUSTES }, protecao: PROTECAO(), usuario: null, ...st }, groups: [], blocks: [] };
  const ctx = {
    $, esc, q: (k) => `[?${k}]`, S, console, Number, String, RegExp, Object, Date, Math, JSON, Array, Promise,
    podeEquipe: () => dono,
    api: async (caminho, metodo, corpo) => { pedidos.push({ caminho, metodo, corpo: J(corpo) }); if (falha) throw falha; return resposta ?? { ok: true }; },
    atualizarEstado: async () => { estados++; },
    aviso: (m, erro = false) => avisos.push({ m, erro }),
  };
  vm.createContext(ctx);
  const fonte = trecho('app.js', 'const TEXTOS_PROTECAO = {', 'async function api(') + trecho('app.js', '// ---------- Proteção do número (cartão de Ajustes', '// ---------- navegação e atualização');
  vm.runInContext(`${fonte}\n;globalThis.__x = { TEXTOS_PROTECAO, protecaoFaixa, protecaoHora, protecaoUso, pintarProtecaoUso, cartaoProtecao, protecaoValidar, ligarCartaoProtecao, protecaoLimites };`, ctx);
  return { ...ctx.__x, S, $, mapa, pedidos, avisos, falhar: (e) => { falha = e; }, estados: () => estados };
}
const hhmm = (ts) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

test('CA9: a faixa das pausas é o valor do campo ± a variação do servidor, nunca abaixo do mínimo entre mensagens', () => {
  const P = painel();
  assert.deepEqual(J(P.protecaoFaixa(6, 0.3, 2)), { min: 4, max: 8 }, 'o exemplo da spec: 6 s dá 4 a 8');
  assert.deepEqual(J(P.protecaoFaixa('30', 0.3, 5)), { min: 21, max: 39 }, 'o exemplo da spec: 30 s dá 21 a 39');
  assert.deepEqual(J(P.protecaoFaixa(2, 0.3, 2)), { min: 1, max: 3 }, 'a faixa é exatamente ±variação do valor salvo (o servidor garante o mínimo na pausa)');
  assert.deepEqual(J(P.protecaoFaixa(5, 0.3, 5)), { min: 4, max: 7 });
  assert.deepEqual(J(P.protecaoFaixa(10, 0.5, 2)), { min: 5, max: 15 }, 'a variação é a que o servidor manda, não um 30% fixo');
  assert.deepEqual(J(P.protecaoFaixa(10, 0, 2)), { min: 10, max: 10 });
  assert.deepEqual(J(P.protecaoFaixa(10, undefined, 2)), { min: 7, max: 13 }, 'sem variação no estado, vale o 30% do servidor');
  for (const ruim of ['', ' ', 'abc', '-3', '1.5', '1e3', null, undefined]) assert.equal(P.protecaoFaixa(ruim, 0.3, 2), null, JSON.stringify(ruim));
});

test('CA9: uso do teto por hora: normal, perto (80%), cheio com a hora de liberação, sem teto e sem leitura', () => {
  const P = painel(); const T = P.TEXTOS_PROTECAO;
  const normal = P.protecaoUso(PROTECAO({ usados: 12 }));
  assert.equal(normal.perto, false);
  assert.match(normal.html, /<span>Na última hora: 12 de 40<\/span>/);
  assert.match(normal.html, /<progress value="12" max="40" aria-label="Mensagens enviadas na última hora"><\/progress>/);
  assert.doesNotMatch(normal.html, /aviso-impl|Perto/);

  assert.equal(P.protecaoUso(PROTECAO({ usados: 31 })).perto, false, '31 de 40 ainda é menos de 80%');
  const perto = P.protecaoUso(PROTECAO({ usados: 32 }));
  assert.equal(perto.perto, true);
  assert.match(perto.html, /Na última hora: 32 de 40\. Perto do limite\./, 'o estado vai por extenso, não só na cor');

  const libera = Date.now() + 25 * 60000;
  const cheio = P.protecaoUso(PROTECAO({ usados: 40, libera_em: libera }));
  assert.equal(cheio.perto, false, 'cheio tem o aviso, não o "perto"');
  assert.match(cheio.html, /<div class="aviso-impl" role="status"><p><b>Limite atingido \(40 de 40 na última hora\)\.<\/b> As próximas mensagens ficam na fila e saem a partir das /);
  assert.ok(cheio.html.includes(`a partir das ${hhmm(libera)}. Nada sai duas vezes.`), 'a hora é a do libera_em, no relógio local');
  assert.match(cheio.html, /<progress value="40" max="40"/);

  const reduzido = P.protecaoUso(PROTECAO({ limite_hora: 10, usados: 25, libera_em: libera }));
  assert.match(reduzido.html, /<progress value="10" max="10"/, 'teto reduzido abaixo do uso: a barra não passa do fim');
  assert.match(reduzido.html, /Limite atingido \(25 de 10 na última hora\)/);

  const semHora = P.protecaoUso(PROTECAO({ usados: 40, libera_em: null }));
  assert.match(semHora.html, /saem assim que houver vaga\. Nada sai duas vezes\./);

  const semTeto = P.protecaoUso(PROTECAO({ limite_hora: null, usados: 1 }));
  assert.match(semTeto.html, /<span>Na última hora: 1 mensagem\. Sem limite por hora\.<\/span>/);
  assert.doesNotMatch(semTeto.html, /progress/);
  assert.match(P.protecaoUso(PROTECAO({ limite_hora: null, usados: 3 })).html, /3 mensagens\. Sem limite/);

  for (const sem of [null, undefined, {}, PROTECAO({ usados: undefined }), PROTECAO({ usados: null }), PROTECAO({ usados: -1 }), PROTECAO({ usados: '12' })]) {
    const r = P.protecaoUso(sem);
    assert.equal(r.html, `<span>${T.usoSemLeitura}</span>`, JSON.stringify(sem));
    assert.equal(T.usoSemLeitura, 'Na última hora: sem leitura ainda.');
  }
});

test('CA9: em Números o uso traz o link "Mudar em Ajustes"; o silêncio de agora aparece lá e, no cartão, em lugar próprio', () => {
  const P = painel();
  const num = P.protecaoUso(PROTECAO({ usados: 12 }), 'numeros');
  assert.match(num.html, /<span>Na última hora: 12 de 40 mensagens\. <a href="#ajustes">Mudar em Ajustes<\/a><\/span>/);
  assert.match(P.protecaoUso(PROTECAO({ usados: 33 }), 'numeros').html, /33 de 40 mensagens\. Perto do limite\. <a href="#ajustes">/);
  assert.doesNotMatch(P.protecaoUso(PROTECAO({ usados: 12 }), 'cartao').html, /Mudar em Ajustes/, 'no cartão o link não faz sentido');

  const ate = Date.now() + 3 * 3600000;
  const dentro = PROTECAO({ silencio: { ativo: true, de: '23:00', ate: '07:00', agora: true, ate_ts: ate } });
  const frase = `Horário de silêncio: nada é enviado até as ${hhmm(ate)}.`;
  assert.ok(P.protecaoUso(dentro, 'numeros').html.includes(`<small class="dica">${frase}</small>`), 'em Números, junto do uso');
  const cartao = P.protecaoUso(dentro, 'cartao');
  assert.ok(!cartao.html.includes('silêncio'), 'no cartão fica fora do bloco do uso…');
  assert.equal(cartao.silencio, `<small class="dica">${frase}</small>`, '…e vai para o lugar dele, no alto');
  assert.equal(P.protecaoUso(PROTECAO(), 'numeros').silencio, '', 'fora do silêncio não há linha');
  assert.equal(P.protecaoUso(PROTECAO({ silencio: { ativo: true, agora: true, ate_ts: null } }), 'numeros').silencio, '', 'sem a hora do fim não inventa uma');
  assert.match(P.protecaoUso(null, 'numeros').html, /sem leitura ainda/);
});

test('CA9: pintarProtecaoUso repinta cartão e Números só quando o texto muda (o aviso de teto não é relido a cada 3 s)', () => {
  const P = painel(); const { $ } = P;
  const uso = $('#pr-uso'); const sil = $('#pr-silencio-agora'); const num = $('#nm-protecao');
  P.pintarProtecaoUso();
  assert.match(uso.innerHTML, /Na última hora: 12 de 40/);
  assert.match(num.innerHTML, /12 de 40 mensagens/);
  assert.equal(sil.innerHTML, '');
  assert.deepEqual([uso.gravacoes.length, num.gravacoes.length], [1, 1]);
  P.pintarProtecaoUso(); P.pintarProtecaoUso();
  assert.deepEqual([uso.gravacoes.length, num.gravacoes.length, sil.gravacoes.length], [1, 1, 1], 'texto igual: nenhuma gravação nova');

  P.S.st.protecao = PROTECAO({ usados: 40, libera_em: Date.now() + 60000 });
  P.pintarProtecaoUso();
  assert.equal(uso.gravacoes.length, 2); assert.match(uso.innerHTML, /role="status"/);
  P.pintarProtecaoUso(); P.pintarProtecaoUso();
  assert.equal(uso.gravacoes.length, 2, 'o aviso de teto é inserido uma vez');

  P.S.st.protecao = PROTECAO({ usados: 33 });
  P.pintarProtecaoUso();
  assert.equal(uso.classes.has('pr-perto'), true); assert.equal(num.classes.has('pr-perto'), true);
  P.S.st.protecao = PROTECAO({ usados: 3 });
  P.pintarProtecaoUso();
  assert.equal(uso.classes.has('pr-perto'), false);

  P.S.st.protecao = PROTECAO({ silencio: { ativo: true, de: '23:00', ate: '07:00', agora: true, ate_ts: Date.now() + 60000 } });
  P.pintarProtecaoUso();
  assert.match(sil.innerHTML, /Horário de silêncio: nada é enviado até as \d\d:\d\d\./);

  P.S.st.protecao = null; // o servidor não leu: não quebra, mostra "sem leitura"
  P.pintarProtecaoUso();
  assert.match(uso.innerHTML, /sem leitura ainda/);
  assert.equal(sil.innerHTML, '');
});

test('CA9: pintarProtecaoUso numa página sem os blocos (outra tela) não faz nada nem quebra', () => {
  const P = painel({ ausentes: ['#pr-uso', '#pr-silencio-agora', '#nm-protecao'] });
  assert.doesNotThrow(() => P.pintarProtecaoUso());
});

test('CA9: cartão do Dono: campos com os valores do servidor, chave, faixas das pausas, ajudas e um botão Salvar', () => {
  const P = painel(); const T = P.TEXTOS_PROTECAO;
  const h = P.cartaoProtecao(AJUSTES, PROTECAO(), true);
  assert.match(h, /<h2>Proteção do número \[\?ajustes\.protecao\]<\/h2>/);
  assert.match(h, new RegExp(`<p class="sub">${T.sub}</p>`));
  assert.equal(T.sub, 'Limites para o WhatsApp não estranhar o seu número. Os valores já vêm num padrão seguro.');
  for (const chave of ['ajustes.limite_hora', 'ajustes.silencio', 'ajustes.pausas']) assert.ok(h.includes(`[?${chave}]`), chave);
  assert.deepEqual([...h.matchAll(/<legend>([^<]*?) \[\?/g)].map((m) => m[1]), ['Quantas mensagens por hora', 'Horário de silêncio', 'Pausas entre mensagens']);
  assert.match(h, /<input id="pr-limite" type="number" inputmode="numeric" min="1" max="200" step="1" value="40" aria-describedby="pr-limite-dica pr-limite-erro">/);
  assert.match(h, /<label class="chave"><input type="checkbox" id="pr-ativo" aria-describedby="pr-desligado" checked><span><\/span><\/label>\s*<label for="pr-ativo"[^>]*>Não enviar de madrugada<\/label>/, 'a chave tem texto visível');
  assert.match(h, /<input id="pr-de" type="time" value="23:00" aria-describedby="pr-de-erro">/);
  assert.match(h, /<input id="pr-ate" type="time" value="07:00" aria-describedby="pr-ate-erro">/);
  assert.match(h, /<small class="dica" id="pr-desligado" hidden>Desligado: o programa envia a qualquer hora, dentro do horário de cada disparo\.<\/small>/);
  assert.match(h, /<input id="pr-dg" type="number" inputmode="numeric" min="2" max="60" step="1" value="6"[^>]*>/);
  assert.match(h, /<input id="pr-do" type="number" inputmode="numeric" min="5" max="600" step="1" value="30"[^>]*>/);
  assert.match(h, /<small id="pr-dg-dica">Na prática: de 4 a 8 segundos, escolhido ao acaso a cada vez\.<\/small>/);
  assert.match(h, /<small id="pr-do-dica">Na prática: de 21 a 39 segundos, escolhido ao acaso a cada vez\.<\/small>/);
  assert.match(h, /<div id="pr-uso" class="pr-uso"><\/div>/);
  assert.match(h, /<div id="pr-silencio-agora"><\/div>/);
  for (const c of ['limite', 'de', 'ate', 'dg', 'do']) assert.match(h, new RegExp(`<small class="nivel-erro" id="pr-${c}-erro" role="alert" hidden></small>`), `erro de ${c} anunciado`);
  assert.equal([...h.matchAll(/<button/g)].length, 1, 'um botão só');
  assert.match(h, /<button class="pri" id="pr-salvar">Salvar proteção do número<\/button>/);
  assert.doesNotMatch(h, / disabled/, 'o Dono mexe em tudo');
  assert.doesNotMatch(h, /Só o Dono muda/);
  assert.doesNotMatch(h, /Máximo de ofertas por dia/, 'o teto por dia por grupo saiu desta entrega (decisão do dono)');
  assert.doesNotMatch(h, /Salvar pausas/);
});

test('CA9: com o silêncio desligado os horários ficam desabilitados (não escondidos) e a dica aparece', () => {
  const P = painel();
  const h = P.cartaoProtecao(AJUSTES, PROTECAO({ silencio: { ativo: false, de: '22:30', ate: '06:15', agora: false, ate_ts: null } }), true);
  assert.match(h, /<input type="checkbox" id="pr-ativo" aria-describedby="pr-desligado"><span>/, 'sem o checked');
  assert.match(h, /<input id="pr-de" type="time" value="22:30" aria-describedby="pr-de-erro" disabled>/);
  assert.match(h, /<input id="pr-ate" type="time" value="06:15" aria-describedby="pr-ate-erro" disabled>/);
  assert.match(h, /<small class="dica" id="pr-desligado">Desligado/, 'sem o hidden');
});

test('CA9: o Operador vê os valores com todos os campos desabilitados, a dica "Só o Dono…" e nenhum botão', () => {
  const P = painel({ ausentes: ['#pr-salvar', '#pr-ativo'] }); // no HTML do Operador esses dois não existem
  const h = P.cartaoProtecao(AJUSTES, PROTECAO(), false);
  const campos = [...h.matchAll(/<input [^>]*>/g)].map((m) => m[0]);
  assert.equal(campos.length, 6, 'a chave e os cinco campos');
  for (const c of campos) assert.match(c, / disabled>$/, c);
  assert.doesNotMatch(h, /<button/);
  assert.match(h, /<small class="dica">Só o Dono muda a proteção do número\.<\/small>/);
  assert.match(h, /value="40"/); assert.match(h, /value="23:00"/); assert.match(h, /value="6"/); assert.match(h, /value="30"/);
  // chave ligada e travada: ligar o cartão do Operador não pode instalar um salvar
  assert.doesNotThrow(() => P.ligarCartaoProtecao(), 'sem botão nem chave a função não liga nada e não quebra');
});

test('CA9: sem leitura do servidor o cartão só avisa (nada de campos), e valores estranhos são escapados', () => {
  const P = painel();
  const h = P.cartaoProtecao(AJUSTES, null, true);
  assert.match(h, /id="pr-card"/);
  assert.match(h, /Não consegui ler a proteção do número agora\. Recarregue a página em instantes\./);
  assert.doesNotMatch(h, /<input|<button/);
  const sujo = P.cartaoProtecao({ delay_group_s: '"><img src=x onerror=alert(1)>', delay_offer_s: undefined }, PROTECAO({ limite_hora: 'x"y', silencio: { ativo: true, de: '"><script>', ate: "'><b>", agora: false } }), true);
  assert.doesNotMatch(sujo, /<img|<script|<b>/);
  assert.match(sujo, /<input id="pr-limite"[^>]* value=""/, 'teto ilegível vira campo vazio');
  assert.match(sujo, /value="&quot;&gt;&lt;script&gt;"/);
  assert.match(sujo, /<input id="pr-do"[^>]* value=""/);
  assert.match(sujo, /<small id="pr-do-dica"><\/small>/, 'sem valor não há faixa');
});

test('CA9: validação do cliente, com as faixas e as frases do servidor', () => {
  const P = painel(); const L = P.protecaoLimites(PROTECAO());
  const base = { limite: '40', ativo: true, de: '23:00', ate: '07:00', dg: '6', do: '30' };
  const certo = P.protecaoValidar(base, L);
  assert.deepEqual(J(certo), { erros: {}, corpo: { limite_hora: 40, silencio_de: '23:00', silencio_ate: '07:00', delay_group_s: 6, delay_offer_s: 30, silencio_ativo: true } });
  assert.equal(J(P.protecaoValidar({ ...base, ativo: false }, L)).corpo.silencio_ativo, false);
  assert.equal(J(P.protecaoValidar({ ...base, ativo: false }, L)).corpo.silencio_de, '23:00', 'desligado ainda manda os horários que estão na tela');
  assert.equal(J(P.protecaoValidar({ ...base, limite: ' 7 ' }, L)).corpo.limite_hora, 7);

  const erros = (v) => J(P.protecaoValidar({ ...base, ...v }, L).erros);
  for (const ruim of ['0', '201', '', ' ', '-1', '1.5', '1e2', 'abc', '99999999999']) assert.deepEqual(erros({ limite: ruim }), { limite: 'Use um número inteiro de 1 a 200.' }, JSON.stringify(ruim));
  for (const bom of ['1', '200']) assert.deepEqual(erros({ limite: bom }), {}, bom);
  for (const ruim of ['1', '61', '', '2.5']) assert.deepEqual(erros({ dg: ruim }), { dg: 'Use um número inteiro de 2 a 60.' }, JSON.stringify(ruim));
  for (const ruim of ['4', '601', 'x']) assert.deepEqual(erros({ do: ruim }), { do: 'Use um número inteiro de 5 a 600.' }, JSON.stringify(ruim));
  for (const bom of [['2', '5'], ['60', '600']]) assert.deepEqual(erros({ dg: bom[0], do: bom[1] }), {});
  assert.deepEqual(erros({ de: '07:00' }), { ate: 'Escolha dois horários diferentes.' });
  assert.deepEqual(erros({ de: '', ate: '' }), { de: 'Use um horário no formato HH:MM, de 00:00 a 23:59.', ate: 'Use um horário no formato HH:MM, de 00:00 a 23:59.' });
  assert.deepEqual(erros({ de: '24:00' }), { de: 'Use um horário no formato HH:MM, de 00:00 a 23:59.' });
  assert.deepEqual(erros({ ate: '7:00' }), { ate: 'Use um horário no formato HH:MM, de 00:00 a 23:59.' });
  assert.deepEqual(Object.keys(erros({ limite: '0', de: '', dg: '1', do: '1' })), ['limite', 'de', 'dg', 'do'], 'na ordem em que aparecem na tela');
  assert.equal(P.protecaoValidar({ ...base, limite: '0' }, L).corpo.limite_hora, undefined);

  // as faixas vêm do servidor: outro limite máximo vale
  const outro = P.protecaoLimites(PROTECAO({ limites: { limite_hora_max: 100, delay_group_min: 3 } }));
  assert.deepEqual(J(P.protecaoValidar({ ...base, limite: '150', dg: '2' }, outro).erros), { limite: 'Use um número inteiro de 1 a 100.', dg: 'Use um número inteiro de 3 a 60.' });
  assert.deepEqual(J(P.protecaoLimites(null)), { limite_hora_min: 1, limite_hora_max: 200, delay_group_min: 2, delay_group_max: 60, delay_offer_min: 5, delay_offer_max: 600 }, 'sem limites no estado, os de agora');
});

test('CA9: Salvar com campo inválido mostra o erro ligado ao campo, foca o primeiro e não envia nada; digitar limpa', async () => {
  const P = painel(); const { $ } = P;
  $('#pr-limite').value = '0'; $('#pr-ativo').checked = true; $('#pr-de').value = '23:00'; $('#pr-ate').value = '23:00'; $('#pr-dg').value = '1'; $('#pr-do').value = '30';
  P.ligarCartaoProtecao();
  await $('#pr-salvar').onclick();
  assert.deepEqual(P.pedidos, [], 'nada vai ao servidor');
  for (const [c, frase] of [['limite', 'Use um número inteiro de 1 a 200.'], ['ate', 'Escolha dois horários diferentes.'], ['dg', 'Use um número inteiro de 2 a 60.']]) {
    const erro = $(`#pr-${c}-erro`); const campo = $(`#pr-${c}`);
    assert.equal(erro.hidden, false, c); assert.equal(erro.textContent, frase, c);
    assert.equal(campo.getAttribute('aria-invalid'), 'true', c); assert.ok(campo.classes.has('invalido'), c);
  }
  for (const c of ['de', 'do']) assert.equal($(`#pr-${c}-erro`).hidden, true, `${c} está certo`);
  assert.deepEqual(['limite', 'de', 'ate', 'dg', 'do'].map((c) => $(`#pr-${c}`).focado), [1, 0, 0, 0, 0], 'foco no primeiro com erro');
  assert.deepEqual(P.avisos, [], 'o erro de campo não vira toast');

  $('#pr-limite').digitar('50');
  assert.equal($('#pr-limite-erro').hidden, true); assert.equal($('#pr-limite').getAttribute('aria-invalid'), null); assert.ok(!$('#pr-limite').classes.has('invalido'));
  assert.equal($('#pr-dg-erro').hidden, false, 'só o campo digitado é limpo');

  // outro clique: os erros que sobraram continuam e o foco vai ao primeiro (agora o "Até")
  await $('#pr-salvar').onclick();
  assert.equal($('#pr-ate').focado, 1); assert.equal($('#pr-limite').focado, 1, 'o do primeiro clique, nada a mais');
});

test('CA9: Salvar válido manda o corpo certo ao PUT /api/protecao, avisa, atualiza o estado e devolve o botão com o foco', async () => {
  const P = painel(); const { $ } = P;
  $('#pr-limite').value = ' 55 '; $('#pr-ativo').checked = true; $('#pr-de').value = '22:00'; $('#pr-ate').value = '06:30'; $('#pr-dg').value = '8'; $('#pr-do').value = '45';
  P.ligarCartaoProtecao();
  const btn = $('#pr-salvar');
  const p = btn.onclick();
  assert.deepEqual([btn.disabled, btn.textContent], [true, 'Salvando…'], 'enquanto grava');
  await p;
  assert.deepEqual(P.pedidos, [{ caminho: '/protecao', metodo: 'PUT', corpo: { limite_hora: 55, silencio_de: '22:00', silencio_ate: '06:30', delay_group_s: 8, delay_offer_s: 45, silencio_ativo: true } }]);
  assert.deepEqual(P.avisos, [{ m: 'Proteção do número salva', erro: false }]);
  assert.equal(P.estados(), 1);
  assert.deepEqual([btn.disabled, btn.textContent, btn.focado], [false, 'Salvar proteção do número', 1]);
  assert.ok(!P.pedidos.some((x) => x.caminho === '/ajustes'), 'as pausas não vão mais ao PUT /api/ajustes');
});

test('CA9: erro do servidor vira toast de erro com a frase dele e o botão volta', async () => {
  const P = painel(); const { $ } = P;
  $('#pr-limite').value = '40'; $('#pr-de').value = '23:00'; $('#pr-ate').value = '07:00'; $('#pr-dg').value = '6'; $('#pr-do').value = '30';
  P.ligarCartaoProtecao();
  P.falhar(new Error('Só o Dono pode fazer isso.'));
  await $('#pr-salvar').onclick();
  assert.deepEqual(P.avisos, [{ m: 'Só o Dono pode fazer isso.', erro: true }]);
  assert.deepEqual([$('#pr-salvar').disabled, $('#pr-salvar').textContent], [false, 'Salvar proteção do número']);
  assert.equal(P.estados(), 0);
});

test('CA9: a chave liga e desliga os horários e a faixa das pausas acompanha o que se digita', () => {
  const P = painel(); const { $ } = P;
  $('#pr-dg').value = '6'; $('#pr-do').value = '30';
  P.ligarCartaoProtecao();
  const chk = $('#pr-ativo');
  chk.checked = false; chk.onchange();
  assert.deepEqual([$('#pr-de').disabled, $('#pr-ate').disabled, $('#pr-desligado').hidden], [true, true, false]);
  chk.checked = true; chk.onchange();
  assert.deepEqual([$('#pr-de').disabled, $('#pr-ate').disabled, $('#pr-desligado').hidden], [false, false, true]);
  // erro dos horários some ao desligar
  $('#pr-de-erro').hidden = false; $('#pr-de-erro').textContent = 'x'; $('#pr-de').setAttribute('aria-invalid', 'true');
  chk.checked = false; chk.onchange();
  assert.deepEqual([$('#pr-de-erro').hidden, $('#pr-de-erro').textContent, $('#pr-de').getAttribute('aria-invalid')], [true, '', null]);

  $('#pr-dg').digitar('10');
  assert.equal($('#pr-dg-dica').textContent, 'Na prática: de 7 a 13 segundos, escolhido ao acaso a cada vez.');
  $('#pr-do').digitar('100');
  assert.equal($('#pr-do-dica').textContent, 'Na prática: de 70 a 130 segundos, escolhido ao acaso a cada vez.');
  $('#pr-dg').digitar('1');
  assert.equal($('#pr-dg-dica').textContent, 'Na prática: de 1 a 1 segundos, escolhido ao acaso a cada vez.', 'a faixa é só ±variação do que está digitado (a validação reclama no Salvar)');
  $('#pr-dg').digitar('abc');
  assert.equal($('#pr-dg-dica').textContent, '', 'lixo: sem faixa');
});

test('CA9: o servidor manda a variação e o painel usa a dele, não um 30% fixo', () => {
  const P = painel({ st: { protecao: PROTECAO({ variacao_pausa: 0.5 }) } }); const { $ } = P;
  assert.match(P.cartaoProtecao(AJUSTES, P.S.st.protecao, true), /<small id="pr-dg-dica">Na prática: de 3 a 9 segundos/);
  $('#pr-dg').value = '6'; $('#pr-do').value = '30';
  P.ligarCartaoProtecao();
  $('#pr-do').digitar('30');
  assert.equal($('#pr-do-dica').textContent, 'Na prática: de 15 a 45 segundos, escolhido ao acaso a cada vez.');
});

// ---------------------------------------------------------------------------------------------------------------
// As páginas: Ajustes (cartão no lugar do das pausas), Números (uso e chip) e a dica de "Funciona das".
// ---------------------------------------------------------------------------------------------------------------

/** paginaAjustes e paginaNumeros do app.js num vm, com o cartão e o uso reais e o resto de mentira. */
function paginas({ st = {}, dono = true, groups = [], ausentes = [] } = {}) {
  const { $, mapa } = fabricaDollar(ausentes);
  const pedidos = [];
  const S = { st: { whatsapp: { status: 'open', me: '5511999990000:12@s.whatsapp.net' }, ajustes: { ...AJUSTES }, protecao: PROTECAO(), usuario: null, ...st }, groups, blocks: [] };
  const ctx = {
    $, esc, q: (k) => `[?${k}]`, S, console, Number, String, RegExp, Object, Date, Math, JSON, Array, Promise,
    podeEquipe: () => dono, tentar: (f) => f,
    api: async (caminho, metodo, corpo) => { pedidos.push({ caminho, metodo, corpo: J(corpo) }); return { texto: 'Exemplo' }; },
    atualizarEstado: async () => {}, aviso() {}, confirm: () => false,
    SO_DONO_DICA: { desconectar: 'Só o Dono pode desconectar o WhatsApp.', limpar: 'Só o Dono pode apagar agora o que passou do prazo.' },
    cartaoVerificador: () => '<!--vf-->', ligarCartaoVerificador() {},
  };
  vm.createContext(ctx);
  const fonte = trecho('app.js', 'const TEXTOS_PROTECAO = {', 'async function api(') + trecho('app.js', '// ---------- Proteção do número (cartão de Ajustes', '// ---------- navegação e atualização')
    + trecho('app.js', 'function paginaNumeros() {', '// ---------- Grupos (lista') + trecho('app.js', 'function paginaAjustes() {', 'function cartaoVerificador(');
  vm.runInContext(`${fonte}\n;globalThis.__x = { paginaNumeros, paginaAjustes };`, ctx);
  return { ...ctx.__x, $, mapa, pedidos, S };
}

test('CA9: Ajustes abre com o cartão "Proteção do número" primeiro e sem o cartão e o botão antigos das pausas', () => {
  const P = paginas();
  P.paginaAjustes();
  const h = P.$('#pagina').innerHTML;
  assert.ok(h.indexOf('id="pr-card"') > 0 && h.indexOf('id="pr-card"') < h.indexOf('ajustes.titulo'), 'o cartão vem antes do Título do produto');
  assert.ok(h.indexOf('ajustes.titulo') < h.indexOf('<!--vf-->') && h.indexOf('<!--vf-->') < h.indexOf('ajustes.modo_link'), 'a ordem do resto não mudou');
  assert.doesNotMatch(h, /Salvar pausas|id="sa"|id="dg"|id="do"/);
  assert.equal([...h.matchAll(/Pausas entre mensagens/g)].length, 1, 'as pausas existem uma vez só, dentro do cartão novo');
  assert.ok(h.indexOf('Pausas entre mensagens') > h.indexOf('id="pr-card"') && h.indexOf('Pausas entre mensagens') < h.indexOf('ajustes.titulo'));
  // o uso é pintado ao abrir e o salvar está ligado
  assert.match(P.$('#pr-uso').innerHTML, /Na última hora: 12 de 40/);
  assert.equal(typeof P.$('#pr-salvar').onclick, 'function');
  assert.deepEqual(P.pedidos.map((x) => x.caminho), ['/templates/preview'], 'abrir a tela não grava nada');
  assert.doesNotMatch(trecho('app.js', 'function paginaAjustes() {', 'function cartaoVerificador('), /delay_group_s|delay_offer_s/, 'o PUT /api/ajustes não leva mais as pausas');
});

test('CA9: Ajustes para o Operador: cartão travado, sem botão, e a tela abre mesmo com protecao nula', () => {
  const P = paginas({ dono: false, ausentes: ['#pr-salvar', '#pr-ativo'] });
  P.paginaAjustes();
  const h = P.$('#pagina').innerHTML;
  const card = h.slice(h.indexOf('id="pr-card"'), h.indexOf('ajustes.titulo'));
  assert.match(card, /Só o Dono muda a proteção do número\./);
  assert.doesNotMatch(card, /<button/);
  assert.equal(P.$('#pr-uso').onclick, undefined);

  const P2 = paginas({ st: { protecao: null } });
  assert.doesNotThrow(() => P2.paginaAjustes());
  assert.match(P2.$('#pagina').innerHTML, /Não consegui ler a proteção do número agora/);
});

test('CA9: Números: subtítulo novo com link, linha de uso, dica do chip reserva (só conectado) e aviso de teto', () => {
  const P = paginas();
  P.paginaNumeros();
  const h = P.$('#pagina').innerHTML;
  assert.match(h, /<p class="sub">Este número envia as ofertas\. Para protegê-lo, use os <a href="#ajustes">limites e as pausas<\/a> de Ajustes e prefira um número de que você não dependa\.<\/p>/);
  assert.doesNotMatch(h, /que você não precise muito/);
  assert.match(h, /<div id="nm-protecao" class="pr-uso"><\/div>/);
  assert.match(P.$('#nm-protecao').innerHTML, /Na última hora: 12 de 40 mensagens\. <a href="#ajustes">Mudar em Ajustes<\/a>/);
  assert.match(h, /<p class="dica"[^>]*>Tenha um segundo chip de reserva, com WhatsApp Business instalado, e deixe esse número também dentro dos seus grupos\. Se este número for restringido, você o conecta aqui em Números e continua enviando\.<\/p>/);
  assert.ok(h.indexOf('nm-protecao') < h.indexOf('Tenha um segundo chip') && h.indexOf('Tenha um segundo chip') < h.indexOf('id="desconectar"'));

  const cheio = paginas({ st: { protecao: PROTECAO({ usados: 40, libera_em: Date.now() + 600000 }) } });
  cheio.paginaNumeros();
  assert.match(cheio.$('#nm-protecao').innerHTML, /<div class="aviso-impl" role="status">.*Limite atingido \(40 de 40 na última hora\)/);

  for (const status of ['qr', 'connecting', 'close']) {
    const fora = paginas({ st: { whatsapp: { status, qr: 'data:x', error: null } } });
    fora.paginaNumeros();
    const o = fora.$('#pagina').innerHTML;
    assert.doesNotMatch(o, /nm-protecao|segundo chip/, `sem a linha de uso nem a dica com o WhatsApp em "${status}"`);
    assert.match(o, /use os <a href="#ajustes">limites e as pausas<\/a>/, 'o subtítulo vale sempre');
  }
  const operador = paginas({ dono: false }); operador.paginaNumeros();
  assert.match(operador.$('#nm-protecao').innerHTML, /12 de 40/, 'o Operador também vê o uso');
});

test('CA9: "Funciona das" ganha a dica fixa com o link para Ajustes (abre noutra aba, para não largar o formulário)', () => {
  const src = lerPublic('app.js');
  const P = painel();
  assert.equal(P.TEXTOS_PROTECAO.funcionaDas, 'Vale só para este disparo. O horário de silêncio de <a href="#ajustes" target="_blank" rel="noopener">Ajustes (abre em nova aba)</a> vale para todos.');
  assert.match(src, /<span>Funciona das \$\{q\('regras\.janela'\)\}<\/span><input name="window_start" type="time" value="\$\{esc\(r\.window_start\)\}"><small>\$\{TEXTOS_PROTECAO\.funcionaDas\}<\/small><\/label>/);
});

test('CA9: a rotina de 3 s (atualizarEstado) repinta o uso em Ajustes e em Números, e só nelas', async () => {
  const { $ } = fabricaDollar();
  let rota = 'ajustes'; let estado = { whatsapp: { status: 'open' }, ajustes: { ...AJUSTES }, protecao: PROTECAO({ usados: 5 }), usuario: null };
  const S = { st: null, groups: [], blocks: [] };
  const ctx = {
    $, esc, q: (k) => k, S, console, Number, String, RegExp, Object, Date, Math, JSON, Array, Promise, location: { hash: '#x' },
    podeEquipe: () => true, api: async () => J(estado), faixa() {}, pintarConta() {}, ir() {}, rotaAtual: () => rota, pintarEstadoML() {},
    paginaNumeros() {}, paginaGrupos() {}, aviso() {},
  };
  vm.createContext(ctx);
  const fonte = trecho('app.js', 'const TEXTOS_PROTECAO = {', 'async function api(') + trecho('app.js', '// ---------- Proteção do número (cartão de Ajustes', '// ---------- navegação e atualização')
    + trecho('app.js', 'async function atualizarEstado(', "window.addEventListener('hashchange', ir);");
  vm.runInContext(`${fonte}\n;globalThis.__x = { atualizarEstado };`, ctx);
  await ctx.__x.atualizarEstado();
  assert.match($('#pr-uso').innerHTML, /Na última hora: 5 de 40/);
  assert.match($('#nm-protecao').innerHTML, /5 de 40 mensagens/);

  estado = { ...estado, protecao: PROTECAO({ usados: 40, libera_em: Date.now() + 120000 }) };
  await ctx.__x.atualizarEstado();
  assert.match($('#pr-uso').innerHTML, /Limite atingido \(40 de 40/, 'o estado novo chega sem recarregar a página');

  rota = 'numeros';
  estado = { ...estado, protecao: PROTECAO({ usados: 7 }) };
  await ctx.__x.atualizarEstado();
  assert.match($('#nm-protecao').innerHTML, /7 de 40 mensagens/);

  rota = 'grupos'; const antes = $('#pr-uso').gravacoes.length;
  estado = { ...estado, protecao: PROTECAO({ usados: 9 }) };
  await ctx.__x.atualizarEstado();
  assert.equal($('#pr-uso').gravacoes.length, antes, 'em outras telas não mexe');
});

// ---------------------------------------------------------------------------------------------------------------
// Grupos: o selo "Falta 2º admin" e o aviso do topo (CA8).
// ---------------------------------------------------------------------------------------------------------------

function grupos({ status = 'open', dono = true } = {}) {
  const S = { st: { whatsapp: { status } }, blocks: [] };
  const ctx = {
    S, esc, q: (k) => `[?${k}]`, podeEquipe: () => dono, console, Array, String, Number, Object,
    rastreioBlocosDoGrupo: () => [], rastreioCelulaGrupo: () => '',
  };
  vm.createContext(ctx);
  const src = lerPublic('paineis.js'); const i = src.indexOf('const TEXTOS_ADMIN = {'); const f = src.indexOf("document.addEventListener('click', (ev0)", i);
  assert.ok(i >= 0 && f > i, 'marcadores de paineis.js');
  vm.runInContext(`${src.slice(i, f)}\n;globalThis.__x = { tabelaGrupos, grupoSemSegundoAdmin, TEXTOS_ADMIN };`, ctx);
  return { ...ctx.__x, S };
}
const G = (jid, name, admins, extra = {}) => ({ jid, name, size: 10, admins, is_admin: 0, invite_code: null, ...extra });

test('CA8: grupo com exatamente 1 admin ganha o selo "Falta 2º admin" ligado ao aviso do topo; 0, 2 ou desconhecido, não', () => {
  const P = grupos();
  const h = P.tabelaGrupos([G('1@g.us', 'Um só', 1), G('2@g.us', 'Dois', 2), G('3@g.us', 'Sem leitura', null), G('4@g.us', 'Zero', 0), G('5@g.us', 'Texto', '1'), G('6@g.us', 'Faltando', undefined)]);
  const linhas = h.split('<tr data-jid=').slice(1);
  assert.equal(linhas.length, 6);
  const comSelo = linhas.filter((l) => l.includes('Falta 2º admin')).map((l) => l.match(/>([^<]+)(?:<span|<div)/)?.[1]);
  assert.deepEqual(comSelo, ['Um só']);
  assert.equal([...h.matchAll(/class="estado-pill pendente"/g)].length, 1);
  assert.match(h, /<div class="selo-admin"><span class="estado-pill pendente" aria-describedby="aviso-admin">Falta 2º admin<\/span><\/div>/, 'texto real, ligado ao aviso');
  assert.match(h, /^<div class="aviso-impl" id="aviso-admin"><p><b>1 grupo com só 1 administrador\.<\/b> \[\?grupos\.admin\] Se esse administrador sair ou for banido, ninguém mais gerencia o grupo e ele pode ficar sem dono\. Como resolver: abra o grupo no WhatsApp, toque em Dados do grupo, escolha um membro de confiança e toque em “Tornar admin”\. Depois use “Atualizar lista de grupos” aqui\.<\/p><\/div><div class="card tabela tab-grupos">/);
  assert.equal([...h.matchAll(/id="aviso-admin"/g)].length, 1, 'o aviso é um só, e não uma frase por linha');
});

test('CA8: o aviso conta os grupos, no singular e no plural, e só existe com selo; sem grupo marcado nada aparece', () => {
  const P = grupos();
  const dois = P.tabelaGrupos([G('1@g.us', 'A', 1), G('2@g.us', 'B', 1), G('3@g.us', 'C', 2)]);
  assert.match(dois, /<b>2 grupos com só 1 administrador\.<\/b>/);
  assert.equal([...dois.matchAll(/Falta 2º admin/g)].length, 2);
  const nenhum = P.tabelaGrupos([G('1@g.us', 'A', 2), G('2@g.us', 'B', null)]);
  assert.doesNotMatch(nenhum, /aviso-admin|Falta 2º admin|selo-admin/);
  assert.match(nenhum, /^<div class="card tabela tab-grupos">/);
  assert.doesNotMatch(P.tabelaGrupos([]), /aviso-admin/);
  assert.match(P.tabelaGrupos([]), /Nenhum grupo\. Toque em “Atualizar lista de grupos”\./, 'a tabela vazia continua igual');
});

test('CA8: com o WhatsApp desconectado (dado possivelmente velho) não há selo nem aviso', () => {
  for (const status of ['close', 'connecting', 'qr']) {
    const P = grupos({ status });
    const h = P.tabelaGrupos([G('1@g.us', 'Um só', 1)]);
    assert.doesNotMatch(h, /Falta 2º admin|aviso-admin/, status);
    assert.match(h, /Um só/, 'a linha continua na tabela');
  }
  assert.doesNotThrow(() => grupos().tabelaGrupos([G('1@g.us', 'x', 1)]), 'ok');
  const P = grupos(); P.S.st = undefined;
  assert.doesNotThrow(() => P.tabelaGrupos([G('1@g.us', 'x', 1)]), 'sem estado carregado ainda');
});

test('CA8: o selo convive com o "admin" do número, o nome sai escapado e a coluna Rastreio segue só para o Dono', () => {
  const P = grupos();
  const h = P.tabelaGrupos([G('1@g.us', '<img src=x onerror=1> & cia', 1, { is_admin: 1 })]);
  assert.doesNotMatch(h, /<img/);
  assert.match(h, /&lt;img src=x onerror=1&gt; &amp; cia<span class="badge-adm">admin<\/span><div class="selo-admin">/);
  assert.match(h, /<th>Rastreio/);
  assert.doesNotMatch(grupos({ dono: false }).tabelaGrupos([G('1@g.us', 'x', 1)]), /<th>Rastreio/);
});

// ---------------------------------------------------------------------------------------------------------------
// Ajuda (TIPS), CSS e o contrato com o servidor de verdade.
// ---------------------------------------------------------------------------------------------------------------

function tips() {
  const ctx = { console, document: { addEventListener() {}, querySelector: () => null, getElementById: () => null }, addEventListener() {}, innerWidth: 1024, innerHeight: 768 };
  vm.createContext(ctx);
  vm.runInContext(`${lerPublic('ajuda.js')}\n;globalThis.__x = { TIPS, q };`, ctx);
  return ctx.__x;
}

test('CA9: os verbetes novos de TIPS existem e todo "?" do cartão e do aviso de admin tem o seu', () => {
  const { TIPS } = tips();
  for (const k of ['ajustes.protecao', 'ajustes.limite_hora', 'ajustes.silencio', 'ajustes.pausas', 'grupos.admin']) assert.ok(typeof TIPS[k] === 'string' && TIPS[k].length > 40, k);
  assert.doesNotMatch(Object.keys(TIPS).join(' '), /limite_dia/, 'o teto por dia por grupo saiu desta entrega');
  assert.match(TIPS['ajustes.pausas'], /valor do meio/, 'o número do campo é o central da faixa');
  assert.match(TIPS['ajustes.silencio'], /“Funciona das”/, 'explica a diferença para o horário de cada disparo');
  assert.match(TIPS['ajustes.silencio'], /pulado/, 'o que tem hora marcada é pulado (decisão do dono), não adiado');
  assert.match(TIPS['grupos.admin'], /segundo admin/);
  const P = painel(); const G2 = grupos();
  const html = P.cartaoProtecao(AJUSTES, PROTECAO(), true) + G2.tabelaGrupos([G('1@g.us', 'A', 1)]);
  const usadas = new Set([...html.matchAll(/\[\?([a-z._]+)\]/g)].map((m) => m[1]));
  for (const k of ['ajustes.limite_hora', 'ajustes.pausas', 'ajustes.protecao', 'ajustes.silencio', 'grupos.admin']) assert.ok(usadas.has(k), `${k} aparece na tela`);
  for (const k of usadas) assert.ok(Object.hasOwn(TIPS, k), `${k} sem verbete`);
});

test('CA9: a barra de uso só usa tokens do tema, não anima e a faixa de admin tem espaço', () => {
  const css = lerPublic('style.css');
  const bloco = css.slice(css.indexOf('/* ---------- Proteção do número'), css.indexOf('#aviso-admin'));
  assert.match(bloco, /\.pr-uso progress \{[^}]*height:8px;[^}]*accent-color:var\(--primary\)/);
  assert.match(bloco, /\.pr-uso\.pr-perto progress \{[^}]*accent-color:var\(--warn\)/);
  assert.doesNotMatch(bloco, /transition|#[0-9a-fA-F]{3,6}\b|rgb/, 'sem animação e sem cor solta');
  assert.match(css, /#aviso-admin \{ margin-bottom:14px; \}/);
});

test('CA8 e CA9: o painel lê o contrato do servidor de verdade e grava pelo PUT /api/protecao', async () => {
  const dir = tmp(); const db = openDb(dir); semearProtecao(db);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const s = criarServicos({ db, wa, links, fast: true, dir, fetch: redeProibida });
  const app = buildApp({ db, wa, links, scheduler: s.scheduler, amazon: s.amazon, shopee: s.shopee, catalogo: s.catalogo, catalogoItens: s.catalogoItens, publicHost: null, panelPassword: '', dataDir: dir });
  const ins = db.prepare('INSERT INTO groups (jid, name, size, admins, updated_at) VALUES (?,?,?,?,?)');
  ins.run('1@g.us', 'Um só', 10, 1, Date.now()); ins.run('2@g.us', 'Dois', 10, 2, Date.now()); ins.run('3@g.us', 'Não sei', 10, null, Date.now());
  const server = await new Promise((ok) => { const sv = app.listen(0, '127.0.0.1', () => ok(sv)); });
  const port = server.address().port;
  const req = (caminho, method = 'GET', body) => new Promise((ok, err) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, path: caminho, method, headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let t = ''; res.setEncoding('utf8'); res.on('data', (c) => (t += c)); res.on('end', () => ok({ status: res.statusCode, json: JSON.parse(t || 'null') }));
    });
    r.on('error', err); if (data) r.write(data); r.end();
  });
  try {
    const estado = (await req('/api/state')).json;
    const P = painel({ st: { protecao: estado.protecao, ajustes: estado.ajustes } });
    const h = P.cartaoProtecao(estado.ajustes, estado.protecao, true);
    assert.match(h, /id="pr-limite"[^>]* min="1" max="200"[^>]* value="40"/, 'padrão da semente');
    assert.match(h, /id="pr-de" type="time" value="23:00"/); assert.match(h, /id="pr-ate" type="time" value="07:00"/);
    assert.match(h, /<input type="checkbox" id="pr-ativo"[^>]* checked>/);
    assert.match(h, /id="pr-dg"[^>]* min="2" max="60"[^>]* value="6"/); assert.match(h, /id="pr-do"[^>]* min="5" max="600"[^>]* value="30"/);
    assert.match(h, /pr-dg-dica">Na prática: de 4 a 8 segundos/);
    assert.match(P.protecaoUso(estado.protecao).html, /Na última hora: 0 de 40/);

    // o Salvar do painel, com o que o formulário devolve, é aceito pelo servidor e volta no estado
    const { corpo, erros } = P.protecaoValidar({ limite: '60', ativo: false, de: '22:00', ate: '06:00', dg: '10', do: '40' }, P.protecaoLimites(estado.protecao));
    assert.deepEqual(J(erros), {});
    const put = await req('/api/protecao', 'PUT', corpo);
    assert.equal(put.status, 200, JSON.stringify(put.json));
    const depois = (await req('/api/state')).json;
    assert.equal(depois.protecao.limite_hora, 60); assert.equal(depois.protecao.silencio.ativo, false);
    assert.deepEqual([depois.protecao.silencio.de, depois.protecao.silencio.ate], ['22:00', '06:00']);
    assert.deepEqual([depois.ajustes.delay_group_s, depois.ajustes.delay_offer_s], [10, 40]);

    // um corpo que o servidor recusa é um corpo que o cliente também recusa (mesmas faixas e frases)
    for (const [campo, v] of [['limite', '201'], ['dg', '1'], ['do', '601'], ['ate', '22:00']]) {
      const c = P.protecaoValidar({ limite: '60', ativo: true, de: '22:00', ate: '06:00', dg: '10', do: '40', [campo]: v }, P.protecaoLimites(estado.protecao));
      assert.ok(c.erros[campo], campo);
      const corpoRuim = { limite_hora: Number(campo === 'limite' ? v : 60), silencio_ativo: true, silencio_de: '22:00', silencio_ate: campo === 'ate' ? v : '06:00',
        delay_group_s: Number(campo === 'dg' ? v : 10), delay_offer_s: Number(campo === 'do' ? v : 40) };
      const r = await req('/api/protecao', 'PUT', corpoRuim);
      assert.equal(r.status, 400, campo);
      assert.equal(r.json.erro, c.erros[campo], `${campo}: a frase do cliente é a do servidor`);
    }

    // /api/groups: o painel só marca o grupo com admins === 1
    const lista = (await req('/api/groups')).json;
    const G2 = grupos();
    const tabela = G2.tabelaGrupos(lista);
    assert.equal([...tabela.matchAll(/Falta 2º admin/g)].length, 1);
    assert.match(tabela, /Um só<div class="selo-admin">/);
    assert.match(tabela, /<b>1 grupo com só 1 administrador\.<\/b>/);
  } finally {
    s.scheduler?.stop?.(); server.closeAllConnections?.(); await new Promise((r) => server.close(r)); db.close();
  }
  assert.equal(acessosRede, 0, 'nenhum acesso à rede');
});

test('D3/D5/D8: chave do silêncio com 44px, aviso de teto comparado à parte e respiro do uso em Números', () => {
  const css = lerPublic('style.css'); const src = lerPublic('app.js');
  assert.match(css, /\.linha:has\(> \.chave\) \{[^}]*min-height:44px/);
  assert.match(css, /\.pr-uso \{[^}]*margin-top:8px/);
  assert.match(src, /el\.dataset\.av === aviso/);
});
