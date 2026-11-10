// Anti-banimento, etapa 8 (plano docs/produto/planos/anti-banimento.md; spec docs/produto/specs/anti-banimento.md, bloco de
// decisões do dono): avisos do horário de silêncio e do teto por hora no Disparo manual e no Disparar mensagem
// (public/disparos.js). Só o envio "agora" tem "Enviar mesmo assim" (manda ignorar_silencio: true) e nunca para o teto;
// agendado e repetido dentro do silêncio só mostram o aviso de que serão pulados. A tela roda num `vm` com um DOM falso
// mínimo e um fetch falso: nenhuma rede, nenhum servidor. O relógio da tela é fixo (10/11/2026, 10:00, hora local).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fonte = fs.readFileSync(path.join(RAIZ, 'public', 'disparos.js'), 'utf8');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const AGORA_FIXO = new Date(2026, 10, 10, 10, 0).getTime();
const hhmm = (ms) => new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

/** Elemento falso: valor, HTML, atributos e tratadores que a tela pendura; `focado` conta os focus(). */
function el(extra = {}) {
  const classes = new Set(); const attrs = new Map();
  return {
    value: '', checked: false, disabled: false, hidden: false, _t: '', _html: '', className: '', placeholder: '', src: '', tabIndex: 0,
    dataset: {}, style: {}, isConnected: true, parentNode: null, focado: 0, filhos: [],
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle(c, on) { if (on ?? !classes.has(c)) classes.add(c); else classes.delete(c); } },
    setAttribute: (k, v) => attrs.set(k, String(v)), getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null), removeAttribute: (k) => attrs.delete(k),
    focus() { this.focado++; }, click() {}, scrollIntoView() {}, closest: () => null, insertBefore() {}, remove() {}, contains: () => false,
    appendChild(f) { this.filhos.push(f); return f; }, insertAdjacentHTML(_o, h) { this._html += h; },
    get textContent() { return this._t; }, set textContent(v) { this._t = String(v); this._html = ''; },
    get innerHTML() { return this._html; }, set innerHTML(v) { this._html = String(v); },
    ...extra,
  };
}

/** Data com o relógio fixo: `new Date()` e `Date.now()` devolvem 10/11/2026 10:00; com argumentos, é a Date de verdade. */
class DataFixa extends Date {
  constructor(...a) { if (a.length) super(...a); else super(AGORA_FIXO); }
  static now() { return AGORA_FIXO; }
}

/** public/disparos.js num vm com `S` (estado do painel) e as rotas falsas `{ 'METODO /api/x': (corpo) => json }`. */
function carregar({ st = {}, rotas = {}, grupos = ['111@g.us'] } = {}) {
  const mapa = new Map(); const $ = (sel) => { if (!mapa.has(sel)) mapa.set(sel, el()); return mapa.get(sel); };
  const pedidos = []; const erros = []; const avisos = [];
  const S = {
    templates: [{ id: 1, name: 'Padrão', body: '{LINK}' }], tags: [{ id: 1, name: 'etq' }], groups: [],
    st: { whatsapp: { status: 'open' }, extensao: { online: true }, ajustes: {}, simulacao: false, ...st },
  };
  const todas = {
    'POST /api/templates/preview': () => ({ texto: 'prévia' }),
    'GET /api/envios?tipo=oferta': () => ({ linhas: [], agendadas: [], contadores: {} }),
    'GET /api/envios?tipo=mensagem': () => ({ linhas: [], agendadas: [], contadores: {} }),
    'POST /api/envios': () => ({ id: 1, status: 'pendente' }),
    'POST /api/disparo/identificar': () => ({ loja: { id: 'mercadolivre', nome: 'Mercado Livre', implementada: true }, produto: { title: 'Fone', price: 10 }, texto: 'x', template_id: 1 }),
    ...rotas,
  };
  const fetch = async (url, opts = {}) => {
    const metodo = opts.method || 'GET'; const corpo = typeof opts.body === 'string' ? JSON.parse(opts.body) : null;
    pedidos.push({ metodo, url, corpo });
    const f = todas[`${metodo} ${url}`];
    if (!f) return { status: 404, ok: false, json: async () => ({ erro: `sem rota ${metodo} ${url}` }) };
    const json = await f(corpo);
    return { status: 200, ok: true, json: async () => json };
  };
  const ctx = {
    console, setTimeout: (f, ms) => { const t = setTimeout(f, ms); t.unref?.(); return t; }, clearTimeout, Number, String, Math, JSON, Array, Object, RegExp, URL, Intl, Promise, Symbol, Error, Set, Map,
    Date: DataFixa,
    document: { createElement: () => el(), getElementById: () => null, activeElement: null, body: el() },
    $, $$: () => [], esc, zap: (x) => String(x), REQ: '*', q: () => '', opcoes: () => '', aviso: (msg, erro) => avisos.push({ msg, erro: !!erro }),
    mostrarErros: (_f, lista) => { erros.push(...lista.map((e) => e.msg)); return lista.length > 0; },
    S, seletorGrupos: () => ({ html: '', ligar() {}, marcados: () => [...grupos] }),
    location: { hash: '#teste', replace() {} }, confirm: () => true, FileReader: class {},
    fetch,
  };
  vm.createContext(ctx);
  vm.runInContext(`${fonte}\n;globalThis.__x = { paginaDisparoManual, paginaDispararMensagem, dispSilencio, dispHoraNoSilencio, dispAgoraNoSilencio, dispTetoCheio, dispAvisosProtecao, TEXTOS_DISPAROS };`, ctx);
  return { ...ctx.__x, $, S, pedidos, erros, avisos };
}

/** Estado `protecao` do /api/state (só o que a tela lê). */
const SILENCIO = (extra = {}) => ({ ativo: true, de: '23:00', ate: '07:00', agora: false, ate_ts: null, ...extra });
const PROTECAO = ({ silencio = {}, ...resto } = {}) => ({ limite_hora: 40, usados: 5, libera_em: null, silencio: SILENCIO(silencio), ...resto });
/** Um botão falso para os tratadores por delegação (segmentados, dias da semana, botões dos avisos). */
const botao = (dados) => ({ target: { closest: () => ({ dataset: dados, disabled: false, focus() {}, getAttribute: () => 'false', setAttribute() {} }) } });
const POSTS = (t) => t.pedidos.filter((p) => p.metodo === 'POST' && p.url === '/api/envios');

// ------------------------------------------------------------------ funções puras
test('CA7: dispHoraNoSilencio segue a regra do servidor: de ≤ hora < até, virando a meia-noite quando de > até', () => {
  const t = carregar();
  const noite = { de: '23:00', ate: '07:00' };
  for (const [h, dentro] of [['22:59', false], ['23:00', true], ['23:59', true], ['00:00', true], ['03:30', true], ['06:59', true], ['07:00', false], ['12:00', false]]) {
    assert.equal(t.dispHoraNoSilencio(h, noite), dentro, `23:00–07:00 às ${h}`);
  }
  const dia = { de: '13:00', ate: '15:00' };
  for (const [h, dentro] of [['12:59', false], ['13:00', true], ['14:59', true], ['15:00', false], ['23:30', false]]) {
    assert.equal(t.dispHoraNoSilencio(h, dia), dentro, `13:00–15:00 às ${h}`);
  }
  for (const ruim of ['', '7:00', '24:00', '12:60', 'abc', null, undefined, 1200]) assert.equal(t.dispHoraNoSilencio(ruim, noite), false, String(ruim));
  assert.equal(t.dispHoraNoSilencio('23:30', null), false, 'sem silêncio');
});

test('CA7: sem `protecao`, desligado, ilegível ou com Das = Até: nenhum aviso (a tela nunca inventa silêncio)', () => {
  const casos = [undefined, null, {}, { silencio: null }, PROTECAO({ silencio: { ativo: false, agora: true } }), PROTECAO({ silencio: { de: '08:00', ate: '08:00', agora: true } }),
    PROTECAO({ silencio: { de: 'x', agora: true } }), PROTECAO({ silencio: { ativo: 'sim', agora: true } })];
  for (const protecao of casos) {
    const t = carregar({ st: { protecao } });
    assert.equal(t.dispSilencio(), null, JSON.stringify(protecao));
    assert.equal(t.dispAgoraNoSilencio(), false);
    assert.equal(t.dispAvisosProtecao({ quando: 'agora', confirma: true }), '');
    assert.equal(t.dispAvisosProtecao({ quando: 'agendado', hora: '23:30' }), '');
    assert.equal(t.dispAvisosProtecao({ quando: 'repetir', horarios: ['23:30'] }), '');
  }
});

test('CA7: o aviso do "agora" no silêncio tem "Enviar mesmo assim" e "Cancelar"; só aparece quando o botão principal o pede', () => {
  const t = carregar({ st: { protecao: PROTECAO({ silencio: { agora: true, ate_ts: AGORA_FIXO + 3600e3 } }) } });
  assert.equal(t.dispAvisosProtecao({ quando: 'agora' }), '', 'sem a confirmação pedida, nada além do que já havia');
  const html = t.dispAvisosProtecao({ quando: 'agora', confirma: true });
  assert.match(html, /role="alert"/);
  assert.match(html, /<b>Horário de silêncio até 07:00\.<\/b> Se você enviar agora, as mensagens saem fora do horário que você protegeu\./);
  assert.match(html, /<button type="button" data-silencio="mesmo-assim">Enviar mesmo assim<\/button>/);
  assert.match(html, /<button type="button" data-silencio="cancelar">Cancelar<\/button>/);
  // o silêncio acabou entre o clique e a leitura: a confirmação some sozinha
  t.S.st.protecao.silencio.agora = false;
  assert.equal(t.dispAvisosProtecao({ quando: 'agora', confirma: true }), '');
});

test('CA7: agendado dentro do silêncio: só o aviso de que será pulado, sem botão; fora dele, nada', () => {
  const t = carregar({ st: { protecao: PROTECAO() } });
  const dentro = t.dispAvisosProtecao({ quando: 'agendado', hora: '23:30' });
  assert.match(dentro, /<b>Horário de silêncio das 23:00 às 07:00\.<\/b> O envio marcado para 23:30 cai nele e será pulado\./);
  assert.doesNotMatch(dentro, /button|mesmo assim|Agendar para/i);
  assert.match(t.dispAvisosProtecao({ quando: 'agendado', hora: '02:00:15' }), /marcado para 02:00 cai nele/, 'hora com segundos');
  for (const fora of ['07:00', '12:00', '22:59', '', 'xx']) assert.equal(t.dispAvisosProtecao({ quando: 'agendado', hora: fora }), '', `"${fora}"`);
  // a confirmação é só do "agora": agendado ignora `confirma`
  assert.doesNotMatch(t.dispAvisosProtecao({ quando: 'agendado', hora: '23:30', confirma: true }), /button/);
});

test('CA7: repetido: lista os horários que caem no silêncio (singular e plural) e avisa que os outros saem normalmente', () => {
  const t = carregar({ st: { protecao: PROTECAO() } });
  const um = t.dispAvisosProtecao({ quando: 'repetir', horarios: ['09:00', '23:30'] });
  assert.match(um, /O horário 23:30 cai nele e será pulado\. Os outros horários saem normalmente\./);
  const varios = t.dispAvisosProtecao({ quando: 'repetir', horarios: ['23:30', '09:00', '02:00', '03:00'] });
  assert.match(varios, /Os horários 02:00, 03:00 e 23:30 caem nele e serão pulados\. Os outros horários saem normalmente\./);
  const todos = t.dispAvisosProtecao({ quando: 'repetir', horarios: ['23:30', '02:00'] });
  assert.match(todos, /Os horários 02:00 e 23:30 caem nele e serão pulados\.<\/p>/, 'todos dentro: sem "os outros"');
  assert.equal(t.dispAvisosProtecao({ quando: 'repetir', horarios: ['09:00', '18:00'] }), '');
  assert.equal(t.dispAvisosProtecao({ quando: 'repetir', horarios: [] }), '');
  assert.doesNotMatch(`${um}${varios}${todos}`, /button|mesmo assim/i);
});

test('CA7: teto por hora cheio no "agora": a oferta entra na fila (a partir das hh:mm), sem "Enviar mesmo assim"; abaixo do teto ou fora do "agora", nada', () => {
  const libera = new Date(2026, 10, 10, 10, 25).getTime();
  const t = carregar({ st: { protecao: PROTECAO({ limite_hora: 40, usados: 40, libera_em: libera }) } });
  const html = t.dispAvisosProtecao({ quando: 'agora', tipo: 'oferta' });
  assert.match(html, /<b>Limite desta hora atingido\.<\/b> A oferta entra na fila e sai a partir das 10:25\. Nada sai duas vezes\./);
  assert.equal(hhmm(libera), '10:25');
  assert.doesNotMatch(html, /button|mesmo assim/i);
  assert.match(t.dispAvisosProtecao({ quando: 'agora', tipo: 'mensagem' }), /A mensagem entra na fila/);
  assert.match(t.dispAvisosProtecao({ quando: 'agora', tipo: 'enquete' }), /A enquete entra na fila/);
  // "confirma" não leva o botão ao teto: com silêncio e teto juntos, o único botão é o do silêncio
  t.S.st.protecao.silencio.agora = true;
  const junto = t.dispAvisosProtecao({ quando: 'agora', confirma: true });
  assert.equal((junto.match(/<button/g) || []).length, 2, 'só Enviar mesmo assim e Cancelar');
  assert.match(junto, /Horário de silêncio até 07:00/); assert.match(junto, /Limite desta hora atingido/);
  assert.doesNotMatch(junto.slice(junto.indexOf('Limite desta hora')), /button/, 'o aviso do teto não tem botão');
  // sem libera_em: frase sem hora
  t.S.st.protecao.libera_em = null;
  assert.match(t.dispAvisosProtecao({ quando: 'agora' }), /sai quando houver vaga/);
  // 39 de 40, teto desligado (null), sem leitura: nada
  for (const p of [{ usados: 39 }, { limite_hora: null, usados: 99 }, { usados: undefined }, { limite_hora: 0, usados: 0 }]) {
    t.S.st.protecao = PROTECAO({ limite_hora: 40, usados: 5, libera_em: libera, ...p });
    assert.equal(t.dispAvisosProtecao({ quando: 'agora' }), '', JSON.stringify(p));
  }
  t.S.st.protecao = PROTECAO({ usados: 40, libera_em: libera });
  assert.equal(t.dispAvisosProtecao({ quando: 'agendado', hora: '12:00' }), '', 'agendado não fala do teto');
  assert.equal(t.dispAvisosProtecao({ quando: 'repetir', horarios: ['12:00'] }), '');
});

// ------------------------------------------------------------------ Disparo manual
/** Abre o Disparo manual com um produto já identificado e um grupo marcado; `S.st.protecao` vem de `protecao`. */
async function abrirManual(protecao, opcoes = {}) {
  const t = carregar({ ...opcoes, st: { protecao, ...(opcoes.st || {}) } });
  t.paginaDisparoManual();
  t.$('#dm-tpl').value = '1';
  t.$('#dm-url').value = 'https://produto.mercadolivre.com.br/MLB-1-fone';
  await t.$('#dm-identificar').onclick();
  assert.equal(t.$('#dm-disparar').disabled, false, `Disparar travado: ${t.$('#dm-motivo').textContent}`);
  return t;
}

test('CA7 Disparo manual: sem `protecao` no estado, dispara direto e sem ignorar_silencio (nada muda para quem não tem a proteção)', async () => {
  const t = await abrirManual(null);
  assert.equal(t.$('#dm-silencio').hidden, true);
  await t.$('#dm-disparar').onclick();
  const posts = POSTS(t);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].corpo.quando, 'agora');
  assert.equal('ignorar_silencio' in posts[0].corpo, false);
});

test('CA7 Disparo manual: "agora" no silêncio pára no aviso (nada é enviado), com "Enviar mesmo assim" e "Cancelar"; o foco vai ao Cancelar', async () => {
  const t = await abrirManual(PROTECAO({ silencio: { agora: true } }));
  assert.equal(t.$('#dm-silencio').hidden, true, 'antes do clique não há aviso');
  await t.$('#dm-disparar').onclick();
  assert.equal(POSTS(t).length, 0, 'o primeiro clique não envia');
  const caixa = t.$('#dm-silencio');
  assert.equal(caixa.hidden, false);
  assert.match(caixa.innerHTML, /Horário de silêncio até 07:00\./);
  assert.match(caixa.innerHTML, /data-silencio="mesmo-assim"/); assert.match(caixa.innerHTML, /data-silencio="cancelar"/);
  assert.equal(t.$('[data-silencio="cancelar"]').focado, 1, 'foco no botão seguro');
  assert.deepEqual(t.erros, []);
});

test('CA7 Disparo manual: "Enviar mesmo assim" manda ignorar_silencio: true (e só ele), esconde o aviso e confirma o envio', async () => {
  const t = await abrirManual(PROTECAO({ silencio: { agora: true } }));
  await t.$('#dm-disparar').onclick();
  await t.$('#dm-silencio').onclick(botao({ silencio: 'mesmo-assim' }));
  const posts = POSTS(t);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].corpo.quando, 'agora');
  assert.equal(posts[0].corpo.ignorar_silencio, true);
  assert.deepEqual(posts[0].corpo.group_jids, ['111@g.us']);
  assert.equal(t.$('#dm-silencio').hidden, true, 'o aviso some depois do envio');
  assert.deepEqual(t.avisos, [{ msg: 'Enviando para 1 grupo. Acompanhe no histórico.', erro: false }]);
  // o aviso não fica para o envio seguinte: um novo clique pede de novo a confirmação
  t.$('#dm-url').value = 'https://produto.mercadolivre.com.br/MLB-2-mouse';
  await t.$('#dm-identificar').onclick();
  await t.$('#dm-disparar').onclick();
  assert.equal(POSTS(t).length, 1, 'o 2º envio no silêncio espera a confirmação');
  assert.equal(t.$('#dm-silencio').hidden, false);
});

test('CA7 Disparo manual: "Cancelar" fecha o aviso, devolve o foco ao Disparar e não envia nada', async () => {
  const t = await abrirManual(PROTECAO({ silencio: { agora: true } }));
  await t.$('#dm-disparar').onclick();
  const focoAntes = t.$('#dm-disparar').focado;
  t.$('#dm-silencio').onclick(botao({ silencio: 'cancelar' }));
  assert.equal(t.$('#dm-silencio').hidden, true);
  assert.equal(t.$('#dm-disparar').focado, focoAntes + 1);
  assert.equal(POSTS(t).length, 0);
});

test('CA7 Disparo manual: a confirmação cai sozinha se o silêncio acaba ou se o dono passa para Agendar', async () => {
  const t = await abrirManual(PROTECAO({ silencio: { agora: true } }));
  await t.$('#dm-disparar').onclick();
  assert.equal(t.$('#dm-silencio').hidden, false);
  t.S.st.protecao.silencio.agora = false; // o estado chega do servidor (a cada 3 s) e a tela se repinta (a cada 6 s)
  t.$('#dm-hora').oninput(); // qualquer repintura
  assert.equal(t.$('#dm-silencio').hidden, true, 'silêncio acabou: sem confirmação');
  assert.equal(POSTS(t).length, 0);
  t.S.st.protecao.silencio.agora = true; t.$('#dm-hora').oninput(); // o silêncio volta: a confirmação antiga não ressuscita
  assert.equal(t.$('#dm-silencio').hidden, true, 'a confirmação só reabre com um novo clique em Disparar');
  // silêncio de novo, confirmação aberta, e o dono marca "Agendar": o aviso do "agora" dá lugar ao do agendado
  t.S.st.protecao.silencio.agora = true;
  await t.$('#dm-disparar').onclick();
  assert.match(t.$('#dm-silencio').innerHTML, /mesmo-assim/);
  t.$('#dm-agendar').checked = true; t.$('#dm-agendar').onchange();
  assert.doesNotMatch(t.$('#dm-silencio').innerHTML, /mesmo-assim|button/);
  assert.equal(t.$('#dm-silencio').hidden, t.$('#dm-silencio').innerHTML === '');
  t.$('#dm-agendar').checked = false; t.$('#dm-agendar').onchange(); // volta ao "agora": a confirmação não reaparece sozinha
  assert.equal(t.$('#dm-silencio').hidden, true);
  // um clique atrasado em "Enviar mesmo assim" (o aviso já tinha sumido) com Agendar marcado não manda ignorar_silencio: o servidor recusaria
  t.$('#dm-agendar').checked = true; t.$('#dm-agendar').onchange(); t.$('#dm-hora').value = '12:00'; t.$('#dm-hora').onchange();
  await t.$('#dm-silencio').onclick(botao({ silencio: 'mesmo-assim' }));
  assert.equal(POSTS(t).length, 1);
  assert.deepEqual([POSTS(t)[0].corpo.quando, 'ignorar_silencio' in POSTS(t)[0].corpo], ['agendado', false]);
});

test('CA7 Disparo manual: agendado dentro do silêncio avisa que será pulado, mas deixa agendar, sem ignorar_silencio e sem "mesmo assim"', async () => {
  const t = await abrirManual(PROTECAO()); // 10:00, fora do silêncio
  t.$('#dm-agendar').checked = true; t.$('#dm-agendar').onchange();
  t.$('#dm-hora').value = '23:30'; t.$('#dm-hora').onchange();
  const caixa = t.$('#dm-silencio');
  assert.equal(caixa.hidden, false);
  assert.match(caixa.innerHTML, /Horário de silêncio das 23:00 às 07:00\./);
  assert.match(caixa.innerHTML, /O envio marcado para 23:30 cai nele e será pulado\./);
  assert.doesNotMatch(caixa.innerHTML, /button|mesmo assim/i);
  assert.equal(t.$('#dm-disparar').disabled, false, 'o aviso não bloqueia');
  await t.$('#dm-disparar').onclick();
  const posts = POSTS(t);
  assert.equal(posts.length, 1, 'agendou de primeira, sem confirmação');
  assert.equal(posts[0].corpo.quando, 'agendado');
  assert.equal(posts[0].corpo.agendar_hhmm, '23:30');
  assert.equal('ignorar_silencio' in posts[0].corpo, false);
  // hora fora do silêncio: sem aviso
  t.$('#dm-hora').value = '12:00'; t.$('#dm-hora').onchange();
  assert.equal(t.$('#dm-silencio').hidden, true);
});

test('CA7 Disparo manual: agendado ignora o silêncio de agora: mesmo com o servidor dizendo `agora: true`, o agendamento envia direto', async () => {
  const t = await abrirManual(PROTECAO({ silencio: { agora: true } }));
  t.$('#dm-agendar').checked = true; t.$('#dm-agendar').onchange();
  t.$('#dm-hora').value = '12:00'; t.$('#dm-hora').onchange();
  await t.$('#dm-disparar').onclick();
  const posts = POSTS(t);
  assert.equal(posts.length, 1);
  assert.deepEqual([posts[0].corpo.quando, 'ignorar_silencio' in posts[0].corpo], ['agendado', false]);
});

test('CA7 Disparo manual: teto da hora cheio avisa que a oferta entra na fila, sem "mesmo assim"; o "agora" sai direto (o servidor segura)', async () => {
  const libera = new Date(2026, 10, 10, 10, 25).getTime();
  const t = await abrirManual(PROTECAO({ limite_hora: 40, usados: 40, libera_em: libera }));
  const caixa = t.$('#dm-silencio');
  assert.equal(caixa.hidden, false);
  assert.match(caixa.innerHTML, /Limite desta hora atingido\./);
  assert.match(caixa.innerHTML, /A oferta entra na fila e sai a partir das 10:25\./);
  assert.doesNotMatch(caixa.innerHTML, /button|mesmo assim/i);
  await t.$('#dm-disparar').onclick();
  const posts = POSTS(t);
  assert.equal(posts.length, 1, 'sem etapa de confirmação para o teto');
  assert.equal('ignorar_silencio' in posts[0].corpo, false, 'o teto nunca é ignorado');
});

test('CA7 Disparo manual: erro do servidor no "mesmo assim" aparece como erro de envio, sem prender o botão', async () => {
  const t = await abrirManual(PROTECAO({ silencio: { agora: true } }), { rotas: { 'POST /api/envios': () => { throw new Error('x'); } } });
  await t.$('#dm-disparar').onclick();
  await t.$('#dm-silencio').onclick(botao({ silencio: 'mesmo-assim' }));
  assert.equal(POSTS(t).length, 1);
  assert.equal(t.$('#dm-disparar').disabled, false, 'o botão volta');
  assert.equal(t.erros.length, 1, 'a falha foi mostrada ao dono');
});

// ------------------------------------------------------------------ Disparar mensagem
/** Abre o Disparar mensagem com um texto escrito e um grupo marcado. */
function abrirMensagem(protecao, opcoes = {}) {
  const t = carregar({ ...opcoes, st: { protecao, ...(opcoes.st || {}) } });
  t.paginaDispararMensagem();
  t.$('#mg-texto').value = 'Bom dia, grupo!';
  return t;
}

test('CA7 Disparar mensagem: sem `protecao`, envia direto e sem ignorar_silencio', async () => {
  const t = abrirMensagem(undefined);
  assert.equal(t.$('#mg-silencio').hidden, true);
  await t.$('#mg-enviar').onclick();
  const posts = POSTS(t);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].corpo.quando, 'agora');
  assert.equal('ignorar_silencio' in posts[0].corpo, false);
});

test('CA7 Disparar mensagem: "agora" no silêncio pára no aviso; "Enviar mesmo assim" manda ignorar_silencio: true; "Cancelar" não manda nada', async () => {
  const t = abrirMensagem(PROTECAO({ silencio: { agora: true } }));
  await t.$('#mg-enviar').onclick();
  assert.equal(POSTS(t).length, 0, 'o primeiro clique não envia');
  const caixa = t.$('#mg-silencio');
  assert.equal(caixa.hidden, false);
  assert.match(caixa.innerHTML, /Horário de silêncio até 07:00\./);
  assert.match(caixa.innerHTML, /data-silencio="mesmo-assim"/);
  assert.equal(t.$('[data-silencio="cancelar"]').focado, 1);
  // cancelar
  t.$('#mg-silencio').onclick(botao({ silencio: 'cancelar' }));
  assert.equal(t.$('#mg-silencio').hidden, true);
  assert.equal(POSTS(t).length, 0);
  assert.equal(t.$('#mg-texto').value, 'Bom dia, grupo!', 'o texto escrito fica');
  // de novo, agora confirmando
  await t.$('#mg-enviar').onclick();
  await t.$('#mg-silencio').onclick(botao({ silencio: 'mesmo-assim' }));
  const posts = POSTS(t);
  assert.equal(posts.length, 1);
  assert.deepEqual([posts[0].corpo.quando, posts[0].corpo.tipo, posts[0].corpo.texto, posts[0].corpo.ignorar_silencio], ['agora', 'mensagem', 'Bom dia, grupo!', true]);
  assert.equal(t.$('#mg-silencio').hidden, true);
  assert.equal(t.avisos.at(-1).msg, 'Enviando para 1 grupo. Acompanhe no histórico.');
});

test('CA7 Disparar mensagem: a enquete "agora" no silêncio também pede confirmação e leva ignorar_silencio', async () => {
  const t = abrirMensagem(PROTECAO({ silencio: { agora: true } }));
  t.$('#mg-tipo').onclick(botao({ v: 'enquete' }));
  t.$('#mg-pergunta').value = 'Qual o melhor achado?';
  t.$('#mg-opcoes').oninput({ target: { dataset: { i: '0' }, value: 'Fone' } });
  t.$('#mg-opcoes').oninput({ target: { dataset: { i: '1' }, value: 'Mouse' } });
  await t.$('#mg-enviar').onclick();
  assert.equal(POSTS(t).length, 0);
  assert.match(t.$('#mg-silencio').innerHTML, /mesmo-assim/);
  await t.$('#mg-silencio').onclick(botao({ silencio: 'mesmo-assim' }));
  const corpo = POSTS(t)[0].corpo;
  assert.deepEqual([corpo.tipo, corpo.quando, corpo.pergunta, corpo.ignorar_silencio], ['enquete', 'agora', 'Qual o melhor achado?', true]);
});

test('CA7 Disparar mensagem: trocar para Agendar ou Repetir fecha a confirmação do "agora"', async () => {
  const t = abrirMensagem(PROTECAO({ silencio: { agora: true } }));
  await t.$('#mg-enviar').onclick();
  assert.match(t.$('#mg-silencio').innerHTML, /mesmo-assim/);
  t.$('#mg-quando').onclick(botao({ v: 'agendado' }));
  assert.doesNotMatch(t.$('#mg-silencio').innerHTML, /mesmo-assim|button/);
  t.$('#mg-quando').onclick(botao({ v: 'agora' }));
  assert.equal(t.$('#mg-silencio').hidden, true, 'voltar ao "agora" não reabre a confirmação sozinha');
  assert.equal(POSTS(t).length, 0);
  // um clique atrasado em "Enviar mesmo assim" com Agendar marcado não manda ignorar_silencio: o servidor recusaria
  t.$('#mg-quando').onclick(botao({ v: 'agendado' })); t.$('#mg-data').value = '2026-11-11'; t.$('#mg-hora').value = '12:00';
  await t.$('#mg-silencio').onclick(botao({ silencio: 'mesmo-assim' }));
  assert.equal(POSTS(t).length, 1);
  assert.deepEqual([POSTS(t)[0].corpo.quando, 'ignorar_silencio' in POSTS(t)[0].corpo], ['agendado', false]);
});

test('CA7 Disparar mensagem: agendado dentro do silêncio avisa que será pulado, sem "mesmo assim", e agenda sem ignorar_silencio', async () => {
  const t = abrirMensagem(PROTECAO({ silencio: { agora: true } }));
  t.$('#mg-quando').onclick(botao({ v: 'agendado' }));
  t.$('#mg-data').value = '2026-11-11'; t.$('#mg-hora').value = '02:00'; t.$('#mg-hora').onchange();
  const caixa = t.$('#mg-silencio');
  assert.equal(caixa.hidden, false);
  assert.match(caixa.innerHTML, /O envio marcado para 02:00 cai nele e será pulado\./);
  assert.doesNotMatch(caixa.innerHTML, /button|mesmo assim/i);
  await t.$('#mg-enviar').onclick();
  const posts = POSTS(t);
  assert.equal(posts.length, 1, 'agenda de primeira');
  assert.deepEqual([posts[0].corpo.quando, posts[0].corpo.agendar_hhmm, 'ignorar_silencio' in posts[0].corpo], ['agendado', '02:00', false]);
  // fora do silêncio: sem aviso
  t.$('#mg-hora').value = '12:00'; t.$('#mg-hora').onchange();
  assert.equal(t.$('#mg-silencio').hidden, true);
});

test('CA7 Disparar mensagem: repetido com horários no silêncio lista quais serão pulados; salva sem ignorar_silencio e sem "mesmo assim"', async () => {
  const t = abrirMensagem(PROTECAO());
  t.$('#mg-quando').onclick(botao({ v: 'repetir' }));
  t.$('#mg-dias').onclick(botao({ d: '1' }));
  for (const h of ['09:00', '23:30']) { t.$('#mg-hor-novo').value = h; t.$('#mg-hor-add').onclick(); }
  const caixa = t.$('#mg-silencio');
  assert.equal(caixa.hidden, false);
  assert.match(caixa.innerHTML, /O horário 23:30 cai nele e será pulado\. Os outros horários saem normalmente\./);
  assert.doesNotMatch(caixa.innerHTML, /button|mesmo assim/i);
  await t.$('#mg-enviar').onclick();
  const posts = POSTS(t);
  assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(posts[0].corpo.repetir)), { dias: [1], horarios: ['09:00', '23:30'] });
  assert.equal('ignorar_silencio' in posts[0].corpo, false);
});

test('CA7 Disparar mensagem: teto da hora cheio avisa que a mensagem entra na fila, sem "mesmo assim", e o envio segue sem ignorar_silencio', async () => {
  const libera = new Date(2026, 10, 10, 10, 25).getTime();
  const t = abrirMensagem(PROTECAO({ limite_hora: 40, usados: 40, libera_em: libera }));
  const caixa = t.$('#mg-silencio');
  assert.equal(caixa.hidden, false);
  assert.match(caixa.innerHTML, /A mensagem entra na fila e sai a partir das 10:25\./);
  assert.doesNotMatch(caixa.innerHTML, /button|mesmo assim/i);
  await t.$('#mg-enviar').onclick();
  const posts = POSTS(t);
  assert.equal(posts.length, 1);
  assert.equal('ignorar_silencio' in posts[0].corpo, false);
  // o teto só vale para o "agora": em Agendar o aviso some
  t.$('#mg-quando').onclick(botao({ v: 'agendado' }));
  assert.equal(t.$('#mg-silencio').hidden, true);
});

test('D6: dispRepintar devolve o foco também aos botões data-silencio', () => {
  const src = fs.readFileSync(new URL('../public/disparos.js', import.meta.url), 'utf8');
  assert.match(src, /f\.dataset\.silencio \? `\[data-silencio="\$\{f\.dataset\.silencio\}"\]`/);
});
