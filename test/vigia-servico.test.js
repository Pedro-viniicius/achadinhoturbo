// Rodar sozinho, entrega 3, etapa 3 (docs/produto/planos/rodar-sozinho-entrega3.md, Decisão 3, 4, 5, 6 e 8; Foco de
// revisão 1 a 5; spec docs/produto/specs/rodar-sozinho-entrega3.md, §1.7, §1.8 e "Linhas do Histórico"): o serviço do
// vigia (createVigia em src/vigia.js). Estado em settings.vigia_estado, leitura de `execucoes`, silêncio do ritmo e
// WhatsApp fora, no máximo uma mensagem de problema e uma de "voltou" por passada, linhas do Histórico (nunca `erro`),
// ok=false quando a leitura falha e estado() para o /api/state. Banco real numa pasta temporária; a extensão, o
// WhatsApp e o `entregar` (o entregarAosDeErro de src/avisos.js) são de mentira, salvo no teste do CA3.5, que usa o
// WhatsApp simulado embrulhado pelo ritmo.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, getSetting, setSetting } from '../src/db.js';
import { createVigia, lojasDaRegra, CHAVE_ESTADO, TEXTO_SEM_LEITURA, FREIO_VIGIA_H } from '../src/vigia.js';
import { createRitmo } from '../src/ritmo.js';
import { createWhatsApp } from '../src/whatsapp.js';

const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-vigia-')); pastas.push(p); return p; };

/** Instante local de 2026-11-`dia` às h:m (as horas das mensagens saem no fuso do processo, como no Histórico). */
const T = (h, m = 0, dia = 12) => new Date(2026, 10, dia, h, m).getTime();
const H = 3600000;

// texto livre da Central que NUNCA pode ir para a mensagem (o "Último erro" da entrega 2)
const ULTIMO_ERRO = 'falhou para 5511987654321@s.whatsapp.net (fulano@exemplo.com) 11987654321';
const VAZAMENTO = /@s\.whatsapp\.net|\d{8,}|[\w.+-]+@[\w-]+\.[\w.]+|fulano|falhou para/;

/**
 * Banco, relógio, extensão, WhatsApp e `entregar` de mentira, e o vigia. `r` controla tudo: r.agora (relógio),
 * r.dormiu (quanto tempo o PC passou suspenso: o relógio monotônico é r.agora − r.dormiu), r.pronto (WhatsApp de pé), r.online/r.lastPollAt/r.central/r.modo (links), r.devolve (o que o entregar devolve; uma
 * função lança). A primeira passada roda em `inicio`, com a tabela vazia: o cursor fica em 0.
 */
function montar({ inicio = T(8), dir = tmp(), wa = null, entregar = null } = {}) {
  const db = openDb(dir);
  const r = {
    agora: inicio, dormiu: 0, pronto: true, online: true, lastPollAt: inicio, modo: 'extension',
    central: { estado: 'respondendo', emEsperaDesde: null }, devolve: 1, entregas: [], statusLanca: false,
  };
  const links = {
    status: () => {
      if (r.statusLanca) throw new Error('links quebrado');
      return { online: r.online, lastPollAt: r.lastPollAt, central: { ...r.central, ultimoErro: ULTIMO_ERRO } };
    },
    central: () => ({ ...r.central, ultimoErro: ULTIMO_ERRO }),
    modo: () => r.modo,
  };
  const ritmo = createRitmo({ db, fast: true, agora: () => r.agora });
  const waFalso = wa ?? { isReady: () => r.pronto };
  const entregarFalso = entregar ?? (async (texto, oQue) => {
    r.entregas.push({ texto, oQue, em: r.agora });
    if (typeof r.devolve === 'function') return r.devolve();
    return r.devolve;
  });
  const novo = (mais = {}) => createVigia({ db, links, ritmo, wa: waFalso, entregar: entregarFalso, inicio, agora: () => r.agora,
    monotonico: () => r.agora - r.dormiu, ...mais });
  const m = { dir, db, r, links, ritmo, novo, vigia: novo() };
  /** Uma passada em `ts` (o relógio anda junto). Devolve o que o tick devolveu, já esperado. */
  m.tick = async (ts, v = m.vigia) => { r.agora = ts; return v.tick(ts); };
  /** Grava uma execução (como o agendador fará na etapa 5) e chama o vigia depois dela, em `depois` (padrão: na hora). */
  m.rodar = async (ts, dados = {}, { depois = ts, v = m.vigia } = {}) => { execucao(db, ts, dados); return m.tick(depois, v); };
  m.linhas = () => db.prepare("SELECT level, message FROM log WHERE rule_name = 'Vigia' ORDER BY id").all().map((l) => ({ ...l }));
  m.estadoGravado = () => JSON.parse(getSetting(db, CHAVE_ESTADO));
  m.tick(inicio);
  return m;
}

/** Regra ativa com fonte catálogo das `lojas` ([] = todas). → id */
function regra(db, nome, lojas = [], { ativa = true } = {}) {
  return Number(db.prepare('INSERT INTO rules (name, enabled, sources, created_at) VALUES (?, ?, ?, ?)')
    .run(nome, ativa ? 1 : 0, JSON.stringify([{ type: 'catalogo', config: { lojas } }]), 1).lastInsertRowid);
}

const loja = (c = {}) => ({ saiu: 0, pulada: 0, descartada: 0, revisao: 0, esperou: 0, motivos: {}, ...c });
/** Uma linha de `execucoes` com os contadores por loja (o formato da etapa 5). */
function execucao(db, ts, { regra: ruleId = 1, conta = 1, saidas, ml, amazon, lojas = [] } = {}) {
  const por = {};
  if (ml) por.ml = loja(ml);
  if (amazon) por.amazon = loja(amazon);
  const s = saidas ?? Object.values(por).reduce((a, x) => a + x.saiu, 0);
  db.prepare(`INSERT INTO execucoes (ts, rule_id, conta, want, saidas, erros, lojas_pedidas, por_loja)
    VALUES (?, ?, ?, 3, ?, 0, ?, ?)`).run(ts, ruleId, conta, s, JSON.stringify(lojas), JSON.stringify(por));
}

/**
 * `n` ofertas esperando revisão (catalogo_itens 'revisao'), a mais antiga em `desde`, mais 12 já decididas
 * ('enviado' e 'descartado'), que não contam.
 */
function revisao(db, n, desde) {
  db.prepare('DELETE FROM catalogo_itens').run();
  const item = db.prepare(`INSERT INTO catalogo_itens (rule_id, chave, loja, status, motivos, oferta, criado_em)
    VALUES (1, ?, 'ml', ?, '["queda_preco"]', '{}', ?)`);
  for (let i = 0; i < n; i++) item.run(`MLB10000000${i}`, 'revisao', desde + i * 60000);
  for (let i = 0; i < 12; i++) item.run(`MLB20000000${i}`, i % 2 ? 'enviado' : 'descartado', desde - H);
}

// execução da regra 1 (Amazon e ML): o ML sai, a Amazon cai fora pelo Etiqueta
const QUEDA = { ml: { saiu: 1 }, amazon: { pulada: 2, motivos: { etiqueta_fora: 2 } } };
const VOLTA = { ml: { saiu: 1 }, amazon: { saiu: 2 } };

/** Abre "Amazon parada" com 3 execuções da regra 1 em h, h+1 e h+2 (cada uma seguida de uma passada). */
async function amazonParada(m, h = 9) {
  for (const k of [0, 1, 2]) await m.rodar(T(h + k), QUEDA);
}

const adiado = (motivo) => ({ level: 'info', message: `Aviso do vigia adiado: ${motivo}.` });

// ---------- regras ativas ----------

test('lojasDaRegra: lojas da fonte catálogo; fonte antiga = Mercado Livre (somada na regra mista); catálogo com lista vazia = todas ([])', () => {
  const fonte = (...f) => ({ sources: JSON.stringify(f) });
  assert.deepEqual(lojasDaRegra(fonte({ type: 'catalogo', config: { lojas: ['amazon'] } })), ['amazon']);
  assert.deepEqual(lojasDaRegra(fonte({ type: 'catalogo', config: { lojas: ['amazon'] } }, { type: 'catalogo', config: { lojas: ['ml', 'amazon'] } })), ['amazon', 'ml']);
  assert.deepEqual(lojasDaRegra(fonte({ type: 'catalogo', config: { lojas: [] } })), []);
  // achado R1/Q1: o agendador conta a oferta da fonte antiga como ML; o vigia também (hierarquia do CA3.8)
  assert.deepEqual(lojasDaRegra(fonte({ type: 'catalogo', config: { lojas: ['amazon'] } }, { type: 'afiliados', config: {} })), ['amazon', 'ml'], 'catálogo da Amazon + Central de Afiliados');
  assert.deepEqual(lojasDaRegra(fonte({ type: 'list', config: {} }, { type: 'afiliados', config: {} })), ['ml'], 'só fontes antigas');
  assert.deepEqual(lojasDaRegra(fonte({ type: 'catalogo', config: { lojas: [] } }, { type: 'list', config: {} })), [], 'catálogo com lista vazia pede todas, com ou sem fonte antiga');
  assert.deepEqual(lojasDaRegra(fonte({ type: 'catalogo', config: { lojas: ['shopee'] } }, { type: 'list', config: {} })), ['shopee', 'ml']);
  assert.deepEqual(lojasDaRegra({ sources: null, source_type: 'list', source_config: '{}' }), ['ml'], 'regra de fonte única antiga (Lista de links)');
  assert.deepEqual(lojasDaRegra({ sources: null, source_type: 'afiliados', source_config: '{}' }), ['ml'], 'regra de fonte única antiga (Central de Afiliados)');
  assert.deepEqual(lojasDaRegra({ sources: null, source_type: 'catalogo', source_config: '{"lojas":["ml"]}' }), ['ml']);
  assert.deepEqual(lojasDaRegra({ sources: '{lixo', source_type: 'catalogo', source_config: '{lixo' }), [], 'JSON ruim não lança (catálogo sem lista = todas)');
  assert.deepEqual(lojasDaRegra(null), []);
  assert.deepEqual(lojasDaRegra('lixo'), []);
});

// ---------- estado em settings ----------

test('estado em settings: a 1ª passada (tabela vazia) grava o cursor 0; a causa e o aviso ficam gravados, sem nome nem número', async () => {
  const m = montar();
  assert.deepEqual(m.estadoGravado(), { cursor: 0, abertas: {}, caladas: {}, voltas: {}, ultimoAviso: {}, seq: { lojas: {}, regras: {} } });
  regra(m.db, 'Achados 11 98765-4321 da Ana');
  await amazonParada(m);
  const e = m.estadoGravado();
  assert.equal(e.cursor, 3);
  assert.deepEqual(Object.keys(e.abertas), ['loja:amazon']);
  assert.equal(e.abertas['loja:amazon'].avisadaEm, T(11), 'avisada na passada que mandou');
  assert.equal(e.ultimoAviso['loja:amazon'], T(11));
  const json = getSetting(m.db, CHAVE_ESTADO);
  assert.doesNotMatch(json, /Achados|Ana|98765|4321/, 'o estado guarda só chaves, instantes, contagens e ids');
  assert.equal(e.segurado, undefined, 'nada segurado');
});

test('estado gravado fora do formato: lido como vazio, sem reavaliar o passado e sem erro', async () => {
  const m = montar();
  regra(m.db, 'Achados');
  execucao(m.db, T(9), QUEDA); execucao(m.db, T(10), QUEDA); execucao(m.db, T(11), QUEDA);
  setSetting(m.db, CHAVE_ESTADO, '{lixo');
  await m.tick(T(11, 5));
  assert.equal(m.estadoGravado().cursor, 3, 'só marca o maior id');
  assert.deepEqual(m.r.entregas, []);
  assert.deepEqual(m.linhas(), []);
  assert.equal(m.vigia.estado().ok, true);
});

test('cursor à frente do maior id (tabela esvaziada e refeita): não reavalia o que já está lá', async () => {
  const m = montar();
  regra(m.db, 'Achados');
  setSetting(m.db, CHAVE_ESTADO, JSON.stringify({ cursor: 900 }));
  execucao(m.db, T(9), QUEDA); execucao(m.db, T(10), QUEDA); execucao(m.db, T(11), QUEDA);
  await m.tick(T(11, 5));
  assert.equal(m.estadoGravado().cursor, 3);
  await m.rodar(T(12), QUEDA);
  assert.equal(m.estadoGravado().cursor, 4, 'a execução nova é avaliada');
  assert.deepEqual(m.r.entregas, [], 'uma queda nova não abre sozinha');
});

// ---------- CA3.2: freio e "voltou" uma vez, com o serviço ----------

test('CA3.2 serviço: um aviso ao abrir, um "voltou" ao fechar e o freio de 3 h segura o reabrir', async () => {
  const m = montar();
  regra(m.db, 'Achados');
  await amazonParada(m);
  assert.equal(m.r.entregas.length, 1);
  assert.equal(m.r.entregas[0].oQue, 'o aviso do vigia');
  assert.match(m.r.entregas[0].texto, /^⚠️ \*Amazon parada desde 09:00\*\n/);
  for (const t of [T(11, 1), T(11, 30), T(11, 59)]) await m.tick(t);
  assert.equal(m.r.entregas.length, 1, 'sem lembrete enquanto a causa dura (D3)');

  await m.rodar(T(12), VOLTA);
  assert.equal(m.r.entregas.length, 2);
  assert.equal(m.r.entregas[1].oQue, 'o aviso de volta do vigia');
  assert.match(m.r.entregas[1].texto, /^✅ \*Amazon voltou a enviar\*\nSaíram 2 ofertas às 12:00/);
  for (const t of [T(12, 1), T(12, 30)]) await m.tick(t);
  assert.equal(m.r.entregas.length, 2, 'o "voltou" sai uma vez só');

  // reabre 1 h 30 min depois do "voltou": o freio (contado do último aviso, de problema ou de volta) segura
  for (const t of [T(12, 30), T(13), T(13, 30)]) await m.rodar(t, QUEDA);
  assert.equal(m.r.entregas.length, 2);
  assert.deepEqual(m.linhas().at(-1), { level: 'info', message: `Aviso do vigia sobre Amazon parada não enviado: freio de ${FREIO_VIGIA_H} h para essa causa.` });
  await m.tick(T(14, 59));
  assert.equal(m.r.entregas.length, 2);
  await m.tick(T(15));
  assert.equal(m.r.entregas.length, 3, 'passadas as 3 h desde o "voltou", o aviso sai');
  assert.match(m.r.entregas[2].texto, /^⚠️ \*Amazon parada desde 12:30\*/);
  await m.tick(T(15, 1));
  assert.equal(m.r.entregas.length, 3);
});

test('no máximo uma mensagem de problema e uma de "voltou" por passada, cada uma juntando as causas devidas', async () => {
  const m = montar();
  regra(m.db, 'Achados');
  await amazonParada(m);
  assert.equal(m.r.entregas.length, 1);
  // na mesma execução: a Amazon volta, o ML espera pela Central (em espera há 40 min) e a revisão passa de 10
  m.r.central = { estado: 'em_espera', emEsperaDesde: T(11, 20) };
  revisao(m.db, 12, T(8));
  await m.rodar(T(12), { ml: { esperou: 3, motivos: { ml_espera: 3 } }, amazon: { saiu: 1 } });
  const novas = m.r.entregas.slice(1);
  assert.equal(novas.length, 2, 'duas mensagens na passada: problemas e voltas');
  const [p, v] = novas;
  assert.equal(p.oQue, 'o aviso do vigia');
  assert.match(p.texto, /^⚠️ \*2 problemas: Mercado Livre em espera, revisão acumulada\*\n\n1\. \*Mercado Livre em espera desde 11:20\.\*/);
  assert.equal(v.oQue, 'o aviso de volta do vigia');
  assert.match(v.texto, /^✅ \*Amazon voltou a enviar\*/);
  for (const x of novas) assert.doesNotMatch(x.texto, VAZAMENTO, 'o "Último erro" da Central nunca vai para a mensagem');
  for (const l of m.linhas()) assert.doesNotMatch(l.message, VAZAMENTO);
});

// ---------- CA3.5: pelo wa embrulhado ----------

test('CA3.5 mensagem passa pelo wa embrulhado e conta em wa_saidas', async () => {
  const dir = tmp();
  const db0 = openDb(dir);
  const waBruto = createWhatsApp({ db: db0, dir, dryRun: true }); waBruto.connect();
  const ritmo = createRitmo({ db: db0, fast: true });
  const wa = ritmo.embrulhar(waBruto);
  const destinos = ['5511987654321@s.whatsapp.net', '5521912345678@s.whatsapp.net'];
  // o contrato do entregarAosDeErro (src/avisos.js): um sendText do wa embrulhado por destino; devolve quantos saíram
  const entregar = async (texto) => { let n = 0; for (const jid of destinos) { await wa.sendText(jid, texto); n++; } return n; };
  const m = montar({ dir, wa, entregar });
  regra(m.db, 'Achados');
  const contar = () => Number(m.db.prepare('SELECT COUNT(*) AS n FROM wa_saidas').get().n);
  assert.equal(contar(), 0);
  await amazonParada(m);
  assert.equal(contar(), 2, 'uma saída por destino, contada pelo ritmo');
  assert.deepEqual(waBruto.simulated.map((s) => s.jid), destinos);
  assert.match(waBruto.simulated[0].text, /^⚠️ \*Amazon parada desde 09:00\*/);
  for (const s of waBruto.simulated) assert.doesNotMatch(s.text, VAZAMENTO);
  await m.rodar(T(12), VOLTA);
  assert.equal(contar(), 4, 'o "voltou" também passa pelo porteiro');
  assert.equal(waBruto.simulated.length, 4, 'nada sai por fora do entregar');
});

// ---------- CA3.7: nunca `erro` ----------

test('CA3.7 nenhuma linha do vigia é erro, nem a falha do próprio vigia (uma linha aviso por sequência de falhas)', async () => {
  const saida = []; const original = console.error;
  console.error = (...a) => saida.push(a.join(' '));
  try {
    const m = montar();
    regra(m.db, 'Achados');
    const id2 = regra(m.db, 'Só ML 11987654321', ['ml']);
    m.r.pronto = false;
    await amazonParada(m);                                     // abre (aviso) e segura (WhatsApp fora)
    await m.rodar(T(11, 10), { regra: id2, ml: { pulada: 1, motivos: { filtros: 1 } } });
    await m.rodar(T(11, 20), { regra: id2, ml: { pulada: 1, motivos: { filtros: 1 } } }); // regra vazia (aviso)
    m.r.pronto = true; m.r.devolve = 0;
    await m.tick(T(11, 30));                                   // sai, ninguém recebe (info)
    m.r.devolve = () => { throw new Error('falhou para 5511987654321@s.whatsapp.net'); };
    await m.rodar(T(12), { regra: 1, ...VOLTA });              // fecha (info) e o entregar lança
    m.r.devolve = 1;

    // falha do vigia: três passadas seguidas sem leitura → uma linha só
    m.r.statusLanca = true;
    for (const t of [T(12, 1), T(12, 2), T(12, 3)]) assert.equal(await m.tick(t), undefined, 'o tick nunca lança nem rejeita');
    assert.equal(m.vigia.estado().ok, false);
    assert.deepEqual(m.vigia.estado().causas, []);
    m.r.statusLanca = false;
    await m.tick(T(12, 4));
    assert.equal(m.vigia.estado().ok, true);
    // outra sequência (o banco sem a tabela): outra linha
    m.db.exec('DROP TABLE execucoes');
    await m.tick(T(12, 5)); await m.tick(T(12, 6));

    const linhas = m.linhas();
    assert.deepEqual(linhas.filter((l) => l.message === TEXTO_SEM_LEITURA), [{ level: 'aviso', message: TEXTO_SEM_LEITURA }, { level: 'aviso', message: TEXTO_SEM_LEITURA }]);
    assert.equal(TEXTO_SEM_LEITURA, 'O vigia não conseguiu verificar agora. Tentando de novo daqui a pouco.');
    for (const tipo of ['aviso', 'info']) assert.ok(linhas.some((l) => l.level === tipo), `há linhas ${tipo}`);
    assert.ok(linhas.some((l) => l.message.startsWith('Aviso do vigia não chegou a nenhum número')), 'entrega vazia vira linha');
    assert.equal(Number(m.db.prepare("SELECT COUNT(*) AS n FROM log WHERE level = 'erro'").get().n), 0, 'nenhum erro no Histórico');
    for (const l of linhas) assert.doesNotMatch(l.message, VAZAMENTO);
    for (const s of saida) assert.doesNotMatch(s, VAZAMENTO, 'nem o console leva número');
  } finally { console.error = original; }
});

test('falha de entrega não gera erro nem nova tentativa na mesma passada (nem na seguinte)', async () => {
  const m = montar();
  regra(m.db, 'Achados');
  let chamadas = 0;
  m.r.devolve = () => { chamadas++; throw new Error('WhatsApp desconectado'); };
  await amazonParada(m);
  assert.equal(chamadas, 1, 'uma tentativa');
  for (const t of [T(11, 1), T(11, 2), T(13)]) await m.tick(t);
  assert.equal(chamadas, 1, 'nada de nova tentativa: o aviso conta como dado e o freio vale');
  await m.rodar(T(15), VOLTA);
  assert.equal(chamadas, 2, 'o "voltou" é outra mensagem, uma tentativa');
  await m.tick(T(15, 1));
  assert.equal(chamadas, 2);
  m.r.devolve = 0;
  await amazonParada(m, 19);
  assert.equal(chamadas, 2);
  assert.equal(m.r.entregas.length, 3, 'saiu, mas ninguém recebeu');
  const linhas = m.linhas();
  assert.equal(linhas.filter((l) => l.message.startsWith('Aviso do vigia não chegou a nenhum número')).length, 3);
  assert.ok(linhas.every((l) => l.level === 'aviso' || l.level === 'info'));
  assert.equal(Number(m.db.prepare("SELECT COUNT(*) AS n FROM log WHERE level = 'erro'").get().n), 0);
});

// ---------- CA3.9: silêncio e WhatsApp fora ----------

function silencio(db, ativo = true) {
  setSetting(db, 'wa_silencio_ativo', ativo ? '1' : '0');
  setSetting(db, 'wa_silencio_de', '23:00'); setSetting(db, 'wa_silencio_ate', '07:00');
}

test('CA3.9 causas abertas no silêncio saem numa só mensagem ao fim dele, só as que seguem abertas', async () => {
  const m = montar({ inicio: T(20) });
  silencio(m.db);
  regra(m.db, 'Achados');
  const soMl = regra(m.db, 'Só ML', ['ml']);
  const vazia = { regra: soMl, ml: { pulada: 2, motivos: { filtros: 2 } } };
  // as execuções da noite; a última, das 22:59, termina às 23:00 (a passada do vigia já cai no silêncio)
  await m.rodar(T(22, 20), QUEDA); await m.rodar(T(22, 30), vazia); await m.rodar(T(22, 40), QUEDA);
  revisao(m.db, 12, T(21));
  execucao(m.db, T(22, 50), vazia);
  await m.rodar(T(22, 59), QUEDA, { depois: T(23) });
  assert.deepEqual(m.vigia.estado().causas.map((c) => c.chave), ['loja:amazon', 'revisao', 'regra:2']);
  assert.deepEqual(m.r.entregas, [], 'nada sai no silêncio');
  assert.equal(m.estadoGravado().segurado.motivo, 'silencio');
  for (const t of [T(23, 30), T(1, 0, 13), T(3, 0, 13)]) await m.tick(t);
  revisao(m.db, 4, T(21));                                   // o dono revisou de madrugada
  await m.tick(T(4, 0, 13));
  await m.tick(T(6, 59, 13));
  assert.deepEqual(m.r.entregas, []);
  assert.deepEqual(m.linhas().filter((l) => l.message.startsWith('Aviso do vigia adiado')), [adiado('horário de silêncio')], 'uma linha por episódio');
  await m.tick(T(7, 0, 13));
  assert.equal(m.r.entregas.length, 1, 'uma mensagem só');
  assert.equal(m.r.entregas[0].texto.split('\n').slice(0, 2).join('\n'),
    '⚠️ *2 problemas: Amazon parada, regra “Só ML” vazia*\nO programa segurou estes avisos durante o horário de silêncio.');
  assert.doesNotMatch(m.r.entregas[0].texto, /revisão/, 'a revisão fechou na madrugada: fica fora');
  await m.tick(T(7, 1, 13));
  assert.equal(m.r.entregas.length, 1);
  assert.equal(m.estadoGravado().segurado, undefined);
  assert.equal(m.linhas().filter((l) => l.message.includes('revisão voltou ao normal')).length, 1, 'o fechamento fica no Histórico');
});

test('abre às 22:59 e silêncio às 23:00: sai às 07:00, reavaliado', async () => {
  // (a) a causa segue aberta: sai às 07:00, com o início original, e não antes
  const a = montar({ inicio: T(20) });
  silencio(a.db);
  regra(a.db, 'Achados');
  await a.rodar(T(22, 20), QUEDA); await a.rodar(T(22, 40), QUEDA);
  await a.rodar(T(22, 59), QUEDA, { depois: T(23) });
  assert.deepEqual(a.vigia.estado().causas.map((c) => c.chave), ['loja:amazon']);
  await a.tick(T(6, 59, 13));
  assert.deepEqual(a.r.entregas, []);
  await a.tick(T(7, 0, 13));
  assert.equal(a.r.entregas.length, 1);
  assert.match(a.r.entregas[0].texto, /^⚠️ \*Amazon parada desde 22:20 de 12\/11\*\n/, '1 causa: a mensagem normal, sem cabeçalho');

  // (b) a causa fecha na madrugada: às 07:00 nada sai (nem "voltou": o problema não foi avisado)
  const b = montar({ inicio: T(20) });
  silencio(b.db);
  regra(b.db, 'Achados');
  revisao(b.db, 11, T(21));
  await b.rodar(T(22, 59), { ml: { saiu: 1 } }, { depois: T(23) });
  assert.deepEqual(b.vigia.estado().causas.map((c) => c.chave), ['revisao']);
  revisao(b.db, 3, T(21));
  await b.tick(T(1, 0, 13));
  assert.deepEqual(b.vigia.estado().causas, []);
  await b.tick(T(7, 0, 13)); await b.tick(T(8, 0, 13));
  assert.deepEqual(b.r.entregas, []);
});

test('CA3.9 WhatsApp fora segura e manda ao voltar (o "voltou" também), com uma linha por episódio', async () => {
  const m = montar();
  regra(m.db, 'Achados');
  const soMl = regra(m.db, 'Só ML', ['ml']);
  m.r.pronto = false;
  await amazonParada(m);
  for (const t of [T(11, 10), T(11, 20)]) await m.rodar(t, { regra: soMl, ml: { pulada: 1, motivos: { filtros: 1 } } });
  for (const t of [T(11, 30), T(11, 40)]) await m.tick(t);
  // reinício no meio: o episódio continua (sem linha nova)
  m.vigia = m.novo();
  await m.tick(T(11, 50));
  assert.deepEqual(m.r.entregas, []);
  assert.deepEqual(m.linhas().filter((l) => l.message.startsWith('Aviso do vigia adiado')), [adiado('WhatsApp desconectado')]);
  m.r.pronto = true;
  await m.tick(T(12));
  assert.equal(m.r.entregas.length, 1);
  assert.equal(m.r.entregas[0].texto.split('\n').slice(0, 2).join('\n'),
    '⚠️ *2 problemas: Amazon parada, regra “Só ML” vazia*\nO WhatsApp ficou desconectado e agora voltou.');

  // o WhatsApp cai de novo; a Amazon volta: o "voltou" espera e sai quando ele voltar
  m.r.pronto = false;
  await m.rodar(T(13), VOLTA);
  await m.tick(T(13, 30));
  assert.equal(m.r.entregas.length, 1);
  assert.equal(m.linhas().filter((l) => l.message.startsWith('Aviso do vigia adiado')).length, 2, 'episódio novo, linha nova');
  m.r.pronto = true;
  await m.tick(T(14));
  assert.equal(m.r.entregas.length, 2);
  assert.match(m.r.entregas[1].texto, /^✅ \*Amazon voltou a enviar\*\nSaíram 2 ofertas às 13:00/);
});

test('CA3.9 causa que abre e fecha com o WhatsApp fora não vira mensagem nem "voltou"', async () => {
  const m = montar();
  regra(m.db, 'Achados');
  m.r.pronto = false;
  await amazonParada(m);
  await m.rodar(T(12), VOLTA);
  m.r.pronto = true;
  await m.tick(T(12, 30));
  assert.deepEqual(m.r.entregas, []);
  assert.equal(m.estadoGravado().segurado, undefined, 'nada mais devido: o episódio acaba');
});

test('CA3.9 sem silêncio ligado, nada segura', async () => {
  // silêncio desligado com o horário gravado
  const m = montar({ inicio: T(20) });
  silencio(m.db, false);
  regra(m.db, 'Achados');
  await m.rodar(T(23, 10), QUEDA); await m.rodar(T(23, 20), QUEDA); await m.rodar(T(23, 30), QUEDA);
  assert.equal(m.r.entregas.length, 1);
  // sem configuração nenhuma
  const n = montar({ inicio: T(20) });
  regra(n.db, 'Achados');
  await n.rodar(T(23, 10), QUEDA); await n.rodar(T(23, 20), QUEDA); await n.rodar(T(23, 30), QUEDA);
  assert.equal(n.r.entregas.length, 1);
  assert.deepEqual(n.linhas().filter((l) => l.message.startsWith('Aviso do vigia adiado')), []);
});

// ---------- CA3.10: reinício ----------

test('CA3.10 reinício: novo createVigia com o mesmo db não repete aviso nem abre causa', async () => {
  const m = montar();
  regra(m.db, 'Achados');
  await amazonParada(m);
  assert.equal(m.r.entregas.length, 1);
  const linhasAntes = m.linhas().length;
  const execAntes = m.db.prepare('SELECT COUNT(*) AS n FROM execucoes').get().n;
  m.db.close();
  // o processo novo: banco aberto de novo, extensão off-line (lastPollAt = 0), vigia novo
  const db = openDb(m.dir);
  const r = m.r; r.online = false; r.lastPollAt = 0; r.agora = T(11, 10);
  const entregas = [];
  const v = createVigia({ db, links: m.links, ritmo: createRitmo({ db, fast: true, agora: () => r.agora }), wa: { isReady: () => true },
    entregar: async (texto, oQue) => { entregas.push({ texto, oQue }); return 1; }, inicio: T(11, 10), agora: () => r.agora });
  for (const t of [T(11, 10), T(11, 20), T(11, 30)]) { r.agora = t; await v.tick(t); }
  assert.deepEqual(entregas, []);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM log WHERE rule_name = 'Vigia'").get().n, linhasAntes, 'nenhuma linha nova');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM execucoes').get().n, execAntes, 'as execuções sobrevivem');
  assert.deepEqual(v.estado().causas.map((c) => c.chave), ['loja:amazon'], 'o estado sobrevive');
  r.online = true; r.lastPollAt = T(11, 40);
  execucao(db, T(12), VOLTA); r.agora = T(12); await v.tick(T(12));
  assert.equal(entregas.length, 1, 'o "voltou" do problema avisado antes do reinício sai uma vez');
  assert.match(entregas[0].texto, /^✅ \*Amazon voltou a enviar\*/);
  db.close();
});

test('CA3.10 extensão off-line logo depois do reinício não abre (desde ≥ início)', async () => {
  const m = montar({ inicio: T(9) });
  m.r.online = false; m.r.lastPollAt = T(7);                 // o último contato foi antes de ligar
  const soMl = regra(m.db, 'Só ML', ['ml']);
  const esperou = { regra: soMl, ml: { esperou: 3, motivos: { ml_extensao: 3 } } };
  await m.rodar(T(9, 5), esperou); await m.rodar(T(9, 20), esperou);
  assert.deepEqual(m.vigia.estado().causas, [], 'a falta conta do início do serviço: 20 min');
  assert.deepEqual(m.r.entregas, []);
  await m.rodar(T(9, 31), esperou);
  assert.deepEqual(m.vigia.estado().causas.map((c) => c.chave), ['ml_fora']);
  assert.equal(m.r.entregas.length, 1);
  assert.match(m.r.entregas[0].texto, /^⚠️ \*Extensão do Chrome desconectada desde 09:00\*/);
  assert.ok(m.linhas().every((l) => !/regra “Só ML” saiu vazia 2 vezes/.test(l.message)), 'a regra só de ML fica calada pela extensão');
});

// ---------- Q2: volta da suspensão do computador ----------

test('Q2 suspensão: ao acordar, a extensão com o último contato da véspera não conta como fora a noite toda; a falta conta do despertar', async () => {
  const m = montar({ inicio: T(20, 0, 11) });
  const soMl = regra(m.db, 'Só ML', ['ml']);
  const esperou = { regra: soMl, ml: { esperou: 2, motivos: { ml_extensao: 2 } } };
  await m.rodar(T(21, 0, 11), { regra: soMl, ml: { saiu: 1 } });         // 21:00: tudo bem, a extensão acabou de falar
  m.r.lastPollAt = T(21, 0, 11);
  // o PC suspende às 21:00 e acorda às 08:00: o relógio de parede anda 11 h, o monotônico não
  m.r.dormiu += T(8, 0, 12) - T(21, 0, 11);
  m.r.online = false;
  await m.rodar(T(8, 0, 12), esperou);                                    // a regra vencida roda antes de a extensão reconectar
  assert.deepEqual(m.vigia.estado().causas, [], 'nada de "desconectada desde 21:00 de 11/11"');
  m.r.online = true; m.r.lastPollAt = T(8, 1, 12);
  await m.tick(T(8, 2, 12));
  assert.deepEqual(m.r.entregas, [], 'nenhum aviso, nem "voltou"');
  assert.ok(m.linhas().every((l) => !/extensão/.test(l.message)), JSON.stringify(m.linhas()));

  // a extensão que NÃO reconecta depois de acordar avisa 30 min depois do despertar, "desde" o despertar
  const n = montar({ inicio: T(20, 0, 11) });
  const r2 = regra(n.db, 'Só ML', ['ml']);
  const esp2 = { regra: r2, ml: { esperou: 2, motivos: { ml_extensao: 2 } } };
  n.r.lastPollAt = T(21, 0, 11); await n.tick(T(21, 0, 11));
  n.r.dormiu += T(8, 0, 12) - T(21, 0, 11); n.r.online = false;
  await n.rodar(T(8, 0, 12), esp2);
  await n.rodar(T(8, 20, 12), esp2);
  assert.deepEqual(n.r.entregas, []);
  await n.rodar(T(8, 31, 12), esp2);
  assert.equal(n.r.entregas.length, 1);
  assert.match(n.r.entregas[0].texto, /^⚠️ \*Extensão do Chrome desconectada desde 08:00\*/);
});

test('Q2 sem suspensão: uma execução demorada (40 min entre duas passadas, os dois relógios andando juntos) não recomeça a falta; a extensão fora há horas avisa', async () => {
  const m = montar({ inicio: T(9) });
  const soMl = regra(m.db, 'Só ML', ['ml']);
  const esperou = { regra: soMl, ml: { esperou: 2, motivos: { ml_extensao: 2 } } };
  m.r.online = false; m.r.lastPollAt = T(7);
  await m.rodar(T(9, 5), esperou);
  assert.deepEqual(m.r.entregas, []);
  await m.rodar(T(9, 45), esperou);                                       // a regra levou 40 min (pausas longas entre ofertas)
  assert.equal(m.r.entregas.length, 1, 'a falta conta do início do serviço (09:00), não da passada depois da execução longa');
  assert.match(m.r.entregas[0].texto, /^⚠️ \*Extensão do Chrome desconectada desde 09:00\*/);
  // horas depois, com execuções acontecendo e o PC acordado: a causa segue aberta, nada se repete
  for (const h of [11, 13, 15]) await m.rodar(T(h), esperou);
  assert.deepEqual(m.vigia.estado().causas.map((c) => [c.chave, c.desdeEm]), [['ml_fora', T(9)]]);
  assert.equal(m.r.entregas.length, 1);
});

test('Q2 suspensão curta (menos de 5 min além do monotônico) não muda nada; o relógio monotônico que falha não derruba a passada', async () => {
  const m = montar({ inicio: T(9) });
  const soMl = regra(m.db, 'Só ML', ['ml']);
  const esperou = { regra: soMl, ml: { esperou: 1, motivos: { ml_extensao: 1 } } };
  m.r.online = false; m.r.lastPollAt = T(7);
  await m.rodar(T(9, 10), esperou);
  m.r.dormiu += 4 * 60000;                                                // 4 min de suspensão: abaixo do salto
  await m.rodar(T(9, 40), esperou);
  assert.equal(m.r.entregas.length, 1, 'a falta segue contando do início (09:00)');
  const n = montar({ inicio: T(9) });
  const v = n.novo({ monotonico: () => { throw new Error('sem relógio'); } });
  n.r.online = false; n.r.lastPollAt = T(7);
  const r2 = regra(n.db, 'Só ML', ['ml']);
  await n.rodar(T(9, 40), { regra: r2, ml: { esperou: 1, motivos: { ml_extensao: 1 } } }, { v });
  assert.equal(v.estado().ok, true);
  assert.deepEqual(v.estado().causas.map((c) => c.chave), ['ml_fora']);
});

// ---------- estado() ----------

test('estado(): formato do /api/state.vigia; ok=false sem causas na falha; nunca lança', async () => {
  const m = montar();
  assert.deepEqual(m.vigia.estado(), { ok: true, causas: [], avaliadoEm: T(8) });
  const nova = m.novo();
  assert.deepEqual(nova.estado(), { ok: true, causas: [], avaliadoEm: null }, 'antes da 1ª passada');
  regra(m.db, 'Achados');
  const id = regra(m.db, 'Regra da Ana 11 98765-4321 com um nome comprido demais', ['ml']);
  await amazonParada(m);
  await m.rodar(T(11, 10), { regra: id, ml: { pulada: 1, motivos: { filtros: 1 } } });
  await m.rodar(T(11, 20), { regra: id, ml: { pulada: 1, motivos: { filtros: 1 } } });
  const st = m.vigia.estado();
  assert.equal(st.ok, true);
  assert.equal(st.avaliadoEm, T(11, 20));
  assert.deepEqual(st.causas.map((c) => [c.tipo, c.chave, c.desdeEm, c.calada]), [['loja', 'loja:amazon', T(9), false], ['regra', `regra:${id}`, T(11, 10), false]]);
  assert.equal(st.causas[0].loja, 'amazon'); assert.equal(st.causas[0].n, 3);
  assert.equal(st.causas[1].rule_id, id);
  assert.ok(st.causas[1].regra.length <= 40);
  assert.doesNotMatch(JSON.stringify(st), /98765|4321/);
  // regra desligada: a causa fecha sem "voltou" e some do estado
  m.db.prepare('UPDATE rules SET enabled = 0 WHERE id = ?').run(id);
  await m.tick(T(11, 30));
  assert.deepEqual(m.vigia.estado().causas.map((c) => c.chave), ['loja:amazon']);
  // falha da leitura: ok=false, sem causas, com a última leitura boa
  m.r.statusLanca = true; await m.tick(T(11, 40));
  assert.deepEqual(m.vigia.estado(), { ok: false, causas: [], avaliadoEm: T(11, 30) });
  // banco fechado: nem o estado() nem o tick lançam
  m.r.statusLanca = false;
  m.db.close();
  assert.deepEqual(nova.estado(), { ok: false, causas: [], avaliadoEm: null });
  assert.equal(await m.tick(T(12)), undefined);
  assert.equal(m.vigia.estado().ok, false);
});

test('tick sem nada a mandar é síncrono (não acrescenta voltas de microtask ao tick do agendador)', async () => {
  const m = montar();
  regra(m.db, 'Achados');
  execucao(m.db, T(9), QUEDA);
  assert.equal(m.vigia.tick(T(9)), undefined);
  assert.equal(m.vigia.aposExecucao(T(9, 1)), undefined);
  execucao(m.db, T(10), QUEDA); execucao(m.db, T(11), QUEDA);
  const r = m.vigia.aposExecucao(T(11));
  assert.ok(r instanceof Promise, 'com mensagem a entregar, devolve a promise');
  await r;
  assert.equal(m.r.entregas.length, 1);
});
