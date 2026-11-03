// Painel do espelhamento (public/espelhamento.js, etapa 12 do plano espelhamento-amazon): o texto que o Histórico mostra
// para cada resultado (CA1, CA3, CA4, CA5), o resumo do cartão, o filtro "Disparo automático" e o que a linha da tabela
// nunca mostra. O arquivo roda num `vm` com os utilitários de app.js falsos; nenhuma rede, nenhum servidor, nenhum DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fonte = fs.readFileSync(path.join(RAIZ, 'public', 'espelhamento.js'), 'utf8');

function carregar() {
  const ctx = {
    esc: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    hora: () => '03/11, 10:00:00', S: { st: {}, templates: [], groups: [] },
  };
  vm.createContext(ctx);
  vm.runInContext(`${fonte}\nglobalThis.__x = { espResultado, espLinhaHtml, resumoEspelhamento, espNumeros, cartaoEspelhamento, histEhAutomatico, espEndereco, espDestinosAtivos, TEXTOS_ESPELHAMENTO };`, ctx);
  return ctx.__x;
}
const P = carregar();
const dest = (nome, ok = true, erro = null) => ({ nome, ok, erro });
const item = (extra) => ({ id: 1, espelho_id: 3, espelho_nome: 'Eletrônicos', origem_nome: 'Grupo X', ts: 1, asin: 'B06BR9EEZ1', status: 'enviado', motivo: null, fonte_dados: 'api', oferta: { title: 'Fone' }, destinos: [dest('Meu grupo')], decidido_em: 2, ...extra });

test('CA1: enviado com dados da API aparece como "Espelhada" com o detalhe "com dados da Amazon"', () => {
  const r = P.espResultado(item({}));
  assert.equal(r.cls, 'nivel-ok');
  assert.equal(r.texto, 'Espelhada');
  assert.equal(r.detalhe, 'com dados da Amazon');
});

test('CA3: sem API o detalhe é "com o texto da origem"; sem preço sai "no formato curto"; completado à mão diz isso', () => {
  assert.equal(P.espResultado(item({ fonte_dados: 'texto' })).detalhe, 'com o texto da origem');
  assert.equal(P.espResultado(item({ fonte_dados: 'curto' })).detalhe, 'no formato curto');
  assert.equal(P.espResultado(item({ fonte_dados: 'manual' })).detalhe, 'completada à mão');
});

test('CA3: item na fila mostra o motivo e ganha o botão "Completar" (só ele)', () => {
  const na = item({ status: 'na_fila', motivo: 'falta completar (sem preço)', destinos: [] });
  assert.equal(P.espResultado(na).texto, 'Na fila: falta completar (sem preço)');
  assert.match(P.espLinhaHtml(na), /data-completar="1"/);
  assert.doesNotMatch(P.espLinhaHtml(item({})), /data-completar/);
  assert.doesNotMatch(P.espLinhaHtml(item({ status: 'duplicado', motivo: 'repetida (enviada há 3 h)' })), /data-completar/);
});

test('CA4 e CA5: repetida e palavra bloqueada viram "Descartada: motivo", com o motivo do servidor', () => {
  assert.equal(P.espResultado(item({ status: 'duplicado', motivo: 'repetida (enviada há 3 h)' })).texto, 'Descartada: repetida (enviada há 3 h)');
  assert.equal(P.espResultado(item({ status: 'descartado', motivo: 'palavra bloqueada (usado)' })).texto, 'Descartada: palavra bloqueada (usado)');
  assert.equal(P.espResultado(item({ status: 'expirado', motivo: 'expirou sem ser completada' })).texto, 'Descartada: expirou sem ser completada');
  assert.equal(P.espResultado(item({ status: 'descartado', motivo: 'palavra bloqueada (usado)' })).cls, 'nivel-aviso');
});

test('link não resolvido é descarte (aviso); falha de verdade é erro; falha de envio a um grupo lista o grupo e o motivo', () => {
  const nr = P.espResultado(item({ status: 'erro', motivo: 'link não resolvido' }));
  assert.deepEqual([nr.cls, nr.texto], ['nivel-aviso', 'Descartada: link não resolvido']);
  const e = P.espResultado(item({ status: 'erro', motivo: 'falha inesperada ao processar' }));
  assert.deepEqual([e.cls, e.texto], ['nivel-erro', 'Não espelhada: falha inesperada ao processar']);
  const f = P.espResultado(item({ destinos: [dest('A'), dest('B', false, 'o WhatsApp recusou')] }));
  assert.equal(f.cls, 'nivel-erro');
  assert.equal(f.texto, 'Erro ao enviar para 1 grupo');
  assert.deepEqual([...f.extra], ['B: o WhatsApp recusou']);
});

test('título da linha: título, senão "Produto <ASIN>", senão "Link da Amazon"; tudo escapado', () => {
  assert.match(P.espLinhaHtml(item({ oferta: { title: 'Fone <b>x</b>' } })), /Fone &lt;b&gt;x&lt;\/b&gt;/);
  assert.match(P.espLinhaHtml(item({ oferta: null })), /Produto B06BR9EEZ1/);
  assert.match(P.espLinhaHtml(item({ oferta: null, asin: null })), /Link da Amazon/);
});

test('a linha nunca leva texto da origem, URL bruta nem participante (o servidor também não os manda)', () => {
  const html = P.espLinhaHtml(item({ texto_origem: 'SEGREDO 5511999998888', url: 'https://amzn.to/SEGREDO', participante: 'Fulano' }));
  assert.doesNotMatch(html, /SEGREDO|5511999998888|Fulano|amzn\.to/);
});

test('resumo do cartão: grupos, template, repetição, limite e horário', () => {
  const e = { id: 3, nome: 'Tech', enabled: true, origem_jids: ['a', 'b'], destino_jids: ['c'], origens_nomes: ['A', 'B'], destinos_nomes: ['Meu grupo'], template_nome: 'Amazon',
    dedupe_horas: 168, max_por_hora: 10, janela_inicio: null, janela_fim: null, sem_preco: 'fila', contadores_24h: { espelhadas: 12, descartadas: 1, na_fila: 2 } };
  const r = P.resumoEspelhamento(e);
  assert.match(r, /De 2 grupos para .*Meu grupo.*\./);
  assert.match(r, /Template: Amazon\./);
  assert.match(r, /Repetida: não reenvia em 168 h\./);
  assert.match(r, /Até 10 por hora\./);
  assert.match(P.resumoEspelhamento({ ...e, dedupe_horas: 0, max_por_hora: 0, janela_inicio: '08:00', janela_fim: '22:00' }), /pode reenviar\. Sem limite por hora\. Das 08:00 às 22:00\./);
  assert.equal(P.espNumeros(e), 'Últimas 24 h: 12 espelhadas, 1 descartada, 2 na fila.');
  const cartao = P.cartaoEspelhamento(e);
  assert.match(cartao, /2 na fila/);
  assert.match(cartao, /href="#historico\?tipo=espelhamento&regra=3&status=na_fila"/);
  assert.doesNotMatch(P.cartaoEspelhamento({ ...e, contadores_24h: { espelhadas: 0, descartadas: 0, na_fila: 0 } }), /na fila<\/a>/);
});

test('"Disparo automático" no Histórico (defesa do cliente): só linha com rule_id; o nome da origem não decide nada', () => {
  assert.equal(P.histEhAutomatico({ rule_id: 7, rule_name: 'Tecnologia' }), true);
  assert.equal(P.histEhAutomatico({ rule_id: 0, rule_name: 'Tecnologia' }), true);
  assert.equal(P.histEhAutomatico({ rule_id: null, rule_name: 'Espelho: Tech' }), false);
  assert.equal(P.histEhAutomatico({ rule_id: null, rule_name: 'Avisos' }), false);
  assert.equal(P.histEhAutomatico({ rule_name: 'Equipe' }), false);
  // uma regra do dono chamada "Mensagem" continua sendo regra (antes sumia pelo nome)
  assert.equal(P.histEhAutomatico({ rule_id: 2, rule_name: 'Mensagem' }), true);
  assert.equal(P.espEndereco(3, false), '#historico?tipo=espelhamento&regra=3');
});

test('R5: "Enviar para N grupos" conta os destinos que existem (sem "(grupo removido)")', () => {
  const regra = { destino_jids: ['a', 'b', 'c'], destinos_nomes: ['A', '(grupo removido)', 'C'] };
  assert.equal(P.espDestinosAtivos(regra), 2);
  assert.equal(P.espDestinosAtivos({ destino_jids: ['a', 'b'], destinos_nomes: ['A', 'B'] }), 2);
  assert.equal(P.espDestinosAtivos({ destino_jids: ['a', 'b'], destinos_nomes: ['(grupo removido)', '(grupo removido)'] }), 0);
  assert.equal(P.espDestinosAtivos({ destino_jids: ['a', 'b'] }), 2); // servidor sem os nomes: cai nos jids
  assert.equal(P.espDestinosAtivos(undefined), 0);
});

// ---------- formulário: espelhamento novo pode ser salvo desligado ----------
function elemento(extra = {}) { return { value: '', checked: false, disabled: false, textContent: '', innerHTML: '', hidden: false, focus() {}, ...extra }; }

/** Roda formEspelhamento num vm com mini-DOM. `conexoes` é o que GET /conexoes devolve; devolve o que foi enviado e mostrado. */
async function abrirForm({ e, conexoes }) {
  const els = new Map(); const get = (sel) => { if (!els.has(sel)) els.set(sel, elemento()); return els.get(sel); };
  const campos = {
    nome: elemento({ value: 'Tech' }), incluir_minhas: elemento(), template_id: elemento({ value: '1' }), palavras: elemento(), sem_preco: elemento({ value: 'fila' }),
    dedupe_horas: elemento({ value: '168' }), max_por_hora: elemento({ value: '10' }), janela_inicio: elemento(), janela_fim: elemento(), enviar_foto: elemento({ value: '1' }),
    ligar: elemento({ checked: true }),
  };
  const dlg = { innerHTML: '', open: false, showModal() {}, close() { this.fechado = true; } };
  const enviados = []; const avisos = [];
  const form = { elements: { namedItem: (n) => (n === 'ligar' && !/name="ligar"/.test(dlg.innerHTML) ? null : campos[n] ?? null) } };
  els.set('#f-esp', form);
  const ctx = {
    esc: (x) => String(x ?? ''), hora: () => '', REQ: '', q: () => '', zap: (x) => x, opcoes: () => '',
    S: { st: { placeholders: [] }, templates: [{ id: 1, name: 'Amazon', body: 'Oferta {LINK}' }], groups: [{ jid: 'a@g.us', name: 'A' }, { jid: 'b@g.us', name: 'B' }] },
    $: (sel, raiz) => (sel === '#dlg' ? dlg : get(sel)),
    tentar: (fn) => fn,
    seletorGrupos: ({ prefixo }) => ({ html: '', ligar() {}, marcados: () => (prefixo === 'o-' ? ['a@g.us'] : ['b@g.us']) }),
    dispSegHtml: () => '', dispLigarSeg() {}, mostrarErros: () => false,
    aviso: (m) => avisos.push(m), recarregarRegras: async () => {},
    api: async (rota, metodo, corpo) => {
      if (rota === '/conexoes') { if (conexoes === 'erro') throw new Error('x'); return conexoes; }
      if (rota === '/templates/preview') return { texto: '' };
      enviados.push({ rota, metodo, corpo }); return { ok: true };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(`${fonte}\nglobalThis.__f = { formEspelhamento };`, ctx);
  ctx.__f.formEspelhamento(e);
  await new Promise((r) => setImmediate(r)); // deixa o GET /conexoes responder
  const enviar = async () => { await form.onsubmit({ preventDefault() {} }); };
  return { ligar: campos.ligar, dica: get('#ef-ligar-dica'), aviso: get('#ef-aviso'), dlg, enviados, avisos, enviar, html: dlg.innerHTML };
}

test('formulário novo sem tag da Amazon: a chave de ligar fica desligada e desabilitada, explicada, e o espelhamento é salvo desligado', async () => {
  const f = await abrirForm({ conexoes: [{ id: 'amazon', estado: 'falta_configurar' }] });
  assert.match(f.html, /name="ligar"/);
  assert.equal(f.ligar.checked, false);
  assert.equal(f.ligar.disabled, true);
  assert.match(f.dica.textContent, /só pode ser salvo desligado/);
  assert.match(f.aviso.innerHTML, /pode salvar desligado/);
  await f.enviar();
  assert.equal(f.enviados.length, 1);
  assert.equal(f.enviados[0].rota, '/espelhos'); assert.equal(f.enviados[0].metodo, 'POST');
  assert.equal(f.enviados[0].corpo.enabled, false);
  assert.deepEqual(f.avisos, ['Espelhamento criado, desligado']);
  assert.equal(f.dlg.fechado, true);
});

test('formulário novo com tag: a chave começa ligada e o espelhamento é criado ligado; desmarcar cria desligado', async () => {
  for (const estado of ['so_tag', 'pronta', 'conectada']) {
    const f = await abrirForm({ conexoes: [{ id: 'amazon', estado }] });
    assert.equal(f.ligar.checked, true); assert.equal(f.ligar.disabled, false);
    await f.enviar();
    assert.equal(f.enviados[0].corpo.enabled, true, estado);
    assert.deepEqual(f.avisos, ['Espelhamento criado']);
  }
  const g = await abrirForm({ conexoes: [{ id: 'amazon', estado: 'pronta' }] });
  g.ligar.checked = false; await g.enviar();
  assert.equal(g.enviados[0].corpo.enabled, false);
  assert.deepEqual(g.avisos, ['Espelhamento criado, desligado']);
});

test('formulário novo, GET /conexoes falhou: segue como antes (ligado) e o servidor decide', async () => {
  const f = await abrirForm({ conexoes: 'erro' });
  assert.equal(f.ligar.checked, true);
  await f.enviar();
  assert.equal(f.enviados[0].corpo.enabled, true);
});

test('editar: não mostra a chave de ligar nem manda "enabled" (o liga/desliga é do cartão)', async () => {
  const e = { id: 9, nome: 'Tech', enabled: true, origem_jids: ['a@g.us'], destino_jids: ['b@g.us'], template_id: 1, incluir_minhas: false, dedupe_horas: 168,
    palavras_bloqueadas: [], sem_preco: 'fila', max_por_hora: 10, janela_inicio: null, janela_fim: null, enviar_foto: true };
  const f = await abrirForm({ e, conexoes: [{ id: 'amazon', estado: 'falta_configurar' }] });
  assert.doesNotMatch(f.html, /name="ligar"/);
  await f.enviar();
  assert.equal(f.enviados[0].rota, '/espelhos/9'); assert.equal(f.enviados[0].metodo, 'PUT');
  assert.equal('enabled' in f.enviados[0].corpo, false);
  assert.deepEqual(f.avisos, ['Espelhamento salvo']);
});

// ---------- Histórico: tipo "Disparo automático" pede ao servidor o filtro (app.js) ----------
const appFonte = fs.readFileSync(path.join(RAIZ, 'public', 'app.js'), 'utf8');
const trecho = appFonte.slice(appFonte.indexOf('async function paginaHistorico('), appFonte.indexOf('// ---------- ajustes ----------'));

function abrirHistorico({ log, rota = 'historico' }) {
  const pedidos = []; const pagina = { innerHTML: '' }; const nv = { value: '' };
  const cenas = { rota, esperaLog: null };
  const ctx = {
    esc: (x) => String(x ?? ''), hora: () => '', q: () => '', setTimeout: () => 1, clearTimeout() {},
    $: (sel) => (sel === '#pagina' ? pagina : sel === '#nv' ? nv : { open: false }),
    rotaAtual: () => cenas.rota, histTipoHtml: () => '', histLigarTipo() {},
    ESP_H: { ger: 0 }, histEhAutomatico: (l) => l.rule_id != null,
    paginaHistoricoEspelhamento: async () => { ctx.ESP_H.ger++; pagina.innerHTML = 'ESPELHAMENTO'; }, // como a real: invalida as respostas em voo
    api: (rota) => { pedidos.push(rota); return cenas.esperaLog ? cenas.esperaLog.then(() => log) : Promise.resolve(log); },
  };
  vm.createContext(ctx);
  vm.runInContext(`${trecho}\nglobalThis.__h = { paginaHistorico };`, ctx);
  return { ...ctx.__h, pedidos, pagina, cenas };
}
const par = (o) => new URLSearchParams(o);

test('R1: Histórico "Disparo automático" chama /log?tipo=automatico (com o nível, se houver) e "Tudo" chama /log', async () => {
  const log = [{ id: 2, rule_id: 5, rule_name: 'Tecnologia', level: 'ok', message: 'enviado' }];
  const h = abrirHistorico({ log });
  await h.paginaHistorico('', par({ tipo: 'automatico' }));
  await h.paginaHistorico('erro', par({ tipo: 'automatico' }));
  await h.paginaHistorico('', par({}));
  await h.paginaHistorico('aviso', null);
  assert.deepEqual(h.pedidos, ['/log?tipo=automatico', '/log?nivel=erro&tipo=automatico', '/log', '/log?nivel=aviso']);
  assert.match(h.pagina.innerHTML, /Tecnologia/);
});

test('R1: mesmo que o servidor ignore o filtro, o cliente só mostra linhas com rule_id', async () => {
  const log = [{ id: 3, rule_id: null, rule_name: 'Avisos', level: 'ok', message: 'resumo' }, { id: 2, rule_id: 5, rule_name: 'Tecnologia', level: 'ok', message: 'enviado' }];
  const h = abrirHistorico({ log });
  await h.paginaHistorico('', par({ tipo: 'automatico' }));
  assert.match(h.pagina.innerHTML, /Tecnologia/); assert.doesNotMatch(h.pagina.innerHTML, /Avisos/);
  await h.paginaHistorico('', par({}));
  assert.match(h.pagina.innerHTML, /Avisos/); // "Tudo" mostra tudo
});

test('R4: resposta atrasada do log não sobrescreve a visão Espelhamento nem uma tela mais nova', async () => {
  const log = [{ id: 2, rule_id: 5, rule_name: 'Tecnologia', level: 'ok', message: 'enviado' }];
  const h = abrirHistorico({ log });
  let solta; h.cenas.esperaLog = new Promise((r) => { solta = r; });
  const atrasada = h.paginaHistorico('', par({}));           // atualização automática do log, ainda esperando o servidor
  h.cenas.esperaLog = null;
  await h.paginaHistorico('', par({ tipo: 'espelhamento' })); // o dono troca o Tipo
  assert.equal(h.pagina.innerHTML, 'ESPELHAMENTO');
  solta(); await atrasada;
  assert.equal(h.pagina.innerHTML, 'ESPELHAMENTO', 'a resposta atrasada do log sobrescreveu a visão Espelhamento');
});
