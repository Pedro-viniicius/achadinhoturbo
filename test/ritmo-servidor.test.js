// Proteção do número no servidor (plano anti-banimento, etapa 6; CA1, CA5 e CA6): `protecao` no GET /api/state, o
// PUT /api/protecao (só o Dono: o Operador recebe 403; tudo validado antes de gravar; cada mudança vira uma linha
// `aviso` com "(por <nome>)"), as pausas fora do PUT /api/ajustes, a semente dos padrões no bloco principal e o
// "Enviar teste" saindo pelo wa embrulhado (conta no teto). Servidor em porta aleatória e WhatsApp simulado: nada
// acessa a rede.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { openDb, getSetting, setSetting } from '../src/db.js';
import { buildApp, criarServicos, ERRO_PAUSAS_EM_PROTECAO } from '../src/server.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createLinkService } from '../src/links.js';
import { createRitmo, semearProtecao, LIMITE_HORA_PADRAO, LIMITE_HORA_MIN, LIMITE_HORA_MAX, SILENCIO_PADRAO, PAUSA_MIN_GRUPO_S, PAUSA_MAX_GRUPO_S,
  PAUSA_MIN_OFERTA_S, PAUSA_MAX_OFERTA_S, ERRO_LIMITE_HORA, ERRO_SILENCIO_IGUAIS, ERRO_SILENCIO_HORA, ERRO_SILENCIO_ATIVO } from '../src/ritmo.js';
import { VARIACAO_PAUSA } from '../src/util.js';

let acessosRede = 0;
globalThis.fetch = async () => { acessosRede++; throw new Error('rede proibida no teste'); };
const redeProibida = async () => { acessosRede++; throw new Error('rede proibida no teste'); };

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-ritmo-srv-')); pastas.push(p); return p; };

const SENHA = 'senha-de-teste-123';
const SO_DONO = { erro: 'Só o Dono pode fazer isso.' };
const JID_DESTINO = '5511987654321@s.whatsapp.net';
const CHAVES = ['wa_limite_hora', 'wa_silencio_ativo', 'wa_silencio_de', 'wa_silencio_ate', 'delay_group_s', 'delay_offer_s'];
const LIMITES = { limite_hora_min: 1, limite_hora_max: 200, delay_group_min: 2, delay_group_max: 60, delay_offer_min: 5, delay_offer_max: 600 };

/**
 * Sobe o servidor. `agendador`: 'real' (criarServicos, como o main), um objeto (agendador de mentira, para o contrato
 * scheduler.ritmo/scheduler.wa) ou null (servidor sem agendador). `antes(db)` prepara o banco antes do buildApp.
 */
function subir({ panelPassword = '', agendador = 'real', antes } = {}) {
  const dir = tmp(); const db = openDb(dir);
  antes?.(db);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const s = agendador === 'real' ? criarServicos({ db, wa, links, fast: true, dir, fetch: redeProibida }) : { scheduler: agendador };
  const app = buildApp({ db, wa, links, scheduler: s.scheduler, amazon: s.amazon ?? null, shopee: s.shopee ?? null, catalogo: s.catalogo ?? null,
    catalogoItens: s.catalogoItens ?? null, publicHost: null, panelPassword, dataDir: dir });
  return new Promise((ok) => {
    const server = app.listen(0, '127.0.0.1', () => ok({
      db, dir, wa, scheduler: s.scheduler, port: server.address().port,
      fechar: () => new Promise((r) => { s.scheduler?.stop?.(); server.closeAllConnections?.(); server.close(() => { db.close(); r(); }); }),
    }));
  });
}
function req(port, caminho, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((ok, err) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers };
    const r = http.request({ host: '127.0.0.1', port, path: caminho, method, headers: h }, (res) => {
      let txt = ''; res.setEncoding('utf8'); res.on('data', (c) => (txt += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(txt); } catch { /* html */ } ok({ status: res.statusCode, json, txt, headers: res.headers }); });
    });
    r.on('error', err); if (data) r.write(data); r.end();
  });
}
const protecao = async (s, headers) => { const r = await req(s.port, '/api/state', { headers }); assert.equal(r.status, 200, r.txt); return r.json.protecao; };
const putProtecao = (s, body, headers) => req(s.port, '/api/protecao', { method: 'PUT', body, headers });
const gravados = (s) => Object.fromEntries(CHAVES.map((k) => [k, getSetting(s.db, k) ?? null]));
const logs = (s) => s.db.prepare('SELECT rule_id, rule_name, level, message FROM log ORDER BY id').all().map((r) => ({ ...r }));
const saidas = (db) => db.prepare('SELECT COUNT(*) AS n FROM wa_saidas').get().n;
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
/** Entra com a senha (o Dono, de nome "Dono") e devolve o cookie. */
async function entrar(s) {
  const r = await req(s.port, '/api/login', { method: 'POST', body: { senha: SENHA } });
  assert.equal(r.status, 200, r.txt);
  return { cookie: String(r.headers['set-cookie'][0]).split(';')[0] };
}

// ---------------------------------------------------------------------------------------- GET /api/state (CA1, CA5, CA6)
test('CA1/CA5/CA6: /state traz protecao; sem configuração o teto e o silêncio ficam desligados (testes não dependem da hora)', async (t) => {
  const s = await subir();
  t.after(s.fechar);
  assert.deepEqual(await protecao(s), {
    limite_hora: null, usados: 0, libera_em: null, variacao_pausa: VARIACAO_PAUSA,
    silencio: { ativo: false, de: SILENCIO_PADRAO.de, ate: SILENCIO_PADRAO.ate, agora: false, ate_ts: null },
    limites: LIMITES,
  });
  assert.equal(VARIACAO_PAUSA, 0.3, 'CA5: ±30%');
  assert.deepEqual(LIMITES, { limite_hora_min: LIMITE_HORA_MIN, limite_hora_max: LIMITE_HORA_MAX, delay_group_min: PAUSA_MIN_GRUPO_S,
    delay_group_max: PAUSA_MAX_GRUPO_S, delay_offer_min: PAUSA_MIN_OFERTA_S, delay_offer_max: PAUSA_MAX_OFERTA_S });
  // as pausas continuam em ajustes
  const st = (await req(s.port, '/api/state')).json;
  assert.deepEqual([st.ajustes.delay_group_s, st.ajustes.delay_offer_s], [6, 30]);
});

test('CA1/CA6: com a semente, /state mostra 40 por hora e o silêncio ligado das 23:00 às 07:00; o uso conta a janela de 60 min', async (t) => {
  const s = await subir();
  t.after(s.fechar);
  semearProtecao(s.db);
  let p = await protecao(s);
  assert.equal(p.limite_hora, LIMITE_HORA_PADRAO);
  assert.equal(LIMITE_HORA_PADRAO, 40);
  assert.deepEqual([p.silencio.ativo, p.silencio.de, p.silencio.ate], [true, '23:00', '07:00']);
  // 40 saídas na última hora (a mais antiga há 50 min) e uma de 2 h atrás, fora da janela: teto cheio
  const agora = Date.now();
  const ins = s.db.prepare('INSERT INTO wa_saidas (ts) VALUES (?)');
  ins.run(agora - 2 * 3600000 + 60000);
  for (let i = 0; i < 40; i++) ins.run(agora - 50 * 60000 + i * 1000);
  p = await protecao(s);
  assert.equal(p.usados, 40);
  assert.equal(p.libera_em, agora - 50 * 60000 + 3600000, 'volta a ter vaga quando a mais antiga sai da janela');
});

test('CA6: dentro do silêncio, /state diz agora=true e quando acaba (ate_ts); fora dele, agora=false', async (t) => {
  const s = await subir();
  t.after(s.fechar);
  const agora = Date.now();
  setSetting(s.db, 'wa_silencio_ativo', '1');
  setSetting(s.db, 'wa_silencio_de', hhmm(agora - 60 * 60000));
  setSetting(s.db, 'wa_silencio_ate', hhmm(agora + 60 * 60000));
  let p = await protecao(s);
  assert.equal(p.silencio.agora, true);
  assert.ok(p.silencio.ate_ts > agora && p.silencio.ate_ts <= agora + 61 * 60000, `ate_ts ${new Date(p.silencio.ate_ts)}`);
  assert.equal(hhmm(p.silencio.ate_ts), hhmm(agora + 60 * 60000));
  setSetting(s.db, 'wa_silencio_de', hhmm(agora + 60 * 60000));
  setSetting(s.db, 'wa_silencio_ate', hhmm(agora + 120 * 60000));
  p = await protecao(s);
  assert.deepEqual([p.silencio.ativo, p.silencio.agora, p.silencio.ate_ts], [true, false, null]);
});

test('/state não cai se a proteção falhar: protecao vem null e o resto do estado segue', async (t) => {
  const quebrado = { ritmo: { uso() { throw new Error('banco travado'); }, silencio() { throw new Error('banco travado'); }, embrulhar: (w) => w } };
  const erros = [];
  t.mock.method(console, 'error', (...a) => erros.push(a.join(' ')));
  const s = await subir({ agendador: quebrado });
  t.after(s.fechar);
  const r = await req(s.port, '/api/state');
  assert.equal(r.status, 200);
  assert.equal(r.json.protecao, null);
  assert.ok(r.json.ajustes);
  assert.ok(erros.some((l) => l.includes('[proteção] estado')), 'vai ao console, sem a mensagem da biblioteca');
  assert.ok(!erros.some((l) => l.includes('banco travado')));
});

// ---------------------------------------------------------------------------------------- PUT /api/protecao (CA1, CA5, CA6)
test('CA1/CA5/CA6: o Dono salva o cartão inteiro; cada mudança vira uma linha aviso com "(por Dono)" e o /state reflete', async (t) => {
  const s = await subir({ panelPassword: SENHA });
  t.after(s.fechar);
  semearProtecao(s.db);
  const { cookie } = await entrar(s);
  const r = await putProtecao(s, { limite_hora: 30, silencio_ativo: true, silencio_de: '22:00', silencio_ate: '06:30', delay_group_s: 8, delay_offer_s: '45' }, { cookie });
  assert.equal(r.status, 200, r.txt);
  assert.deepEqual(r.json, { ok: true });
  assert.deepEqual(gravados(s), { wa_limite_hora: '30', wa_silencio_ativo: '1', wa_silencio_de: '22:00', wa_silencio_ate: '06:30', delay_group_s: '8', delay_offer_s: '45' });
  const origem = { rule_id: null, rule_name: 'Proteção do número', level: 'aviso' };
  assert.deepEqual(logs(s), [
    { ...origem, message: 'Máximo de mensagens por hora: 40 → 30 (por Dono)' },
    { ...origem, message: 'Horário de silêncio: das 23:00 às 07:00 → das 22:00 às 06:30 (por Dono)' },
    { ...origem, message: 'Pausa entre um grupo e outro: 6 s → 8 s (por Dono)' },
    { ...origem, message: 'Pausa entre uma oferta e a próxima: 30 s → 45 s (por Dono)' },
  ]);
  const st = (await req(s.port, '/api/state', { headers: { cookie } })).json;
  assert.equal(st.protecao.limite_hora, 30);
  assert.deepEqual([st.protecao.silencio.de, st.protecao.silencio.ate], ['22:00', '06:30']);
  assert.deepEqual([st.ajustes.delay_group_s, st.ajustes.delay_offer_s], [8, 45], 'as pausas seguem em ajustes');

  // salvar de novo os mesmos valores não escreve outra linha
  assert.equal((await putProtecao(s, { limite_hora: 30, silencio_ativo: true, silencio_de: '22:00', silencio_ate: '06:30', delay_group_s: 8, delay_offer_s: 45 }, { cookie })).status, 200);
  assert.equal(logs(s).length, 4);
});

test('CA1 (P2): o Operador recebe 403 e nada é gravado nem vai ao Histórico; sem login, 401; de outra origem, 403; o Operador vê os valores', async (t) => {
  const s = await subir({ panelPassword: SENHA });
  t.after(s.fechar);
  semearProtecao(s.db);
  const antes = gravados(s);
  assert.equal((await putProtecao(s, { limite_hora: 10 })).status, 401, 'sem login');
  const { cookie } = await entrar(s);
  s.db.prepare("UPDATE users SET papel = 'operador'").run(); // o papel é relido a cada pedido
  for (const corpo of [{ limite_hora: 10 }, { silencio_ativo: false }, { silencio_de: '20:00' }, { delay_group_s: 3 }, { delay_offer_s: 6 }, {}]) {
    const r = await putProtecao(s, corpo, { cookie });
    assert.equal(r.status, 403, JSON.stringify(corpo));
    assert.deepEqual(r.json, SO_DONO);
  }
  assert.deepEqual(gravados(s), antes);
  assert.deepEqual(logs(s), []);
  // o Operador vê a proteção no /state
  const p = await protecao(s, { cookie });
  assert.deepEqual([p.limite_hora, p.silencio.ativo], [40, true]);
  // nem desvia pelo PUT /api/ajustes (que não exige o Dono): as pausas foram tiradas de lá
  const aj = await req(s.port, '/api/ajustes', { method: 'PUT', body: { delay_group_s: 3, delay_offer_s: 6 }, headers: { cookie } });
  assert.equal(aj.status, 400);
  assert.equal(aj.json.erro, ERRO_PAUSAS_EM_PROTECAO);
  assert.deepEqual(gravados(s), antes);
  // de volta a Dono, mas com Origin de outro site: 403 do Host/Origin
  s.db.prepare("UPDATE users SET papel = 'dono'").run();
  const fora = await putProtecao(s, { limite_hora: 10 }, { cookie, origin: 'https://site-malicioso.com' });
  assert.equal(fora.status, 403);
  assert.deepEqual(gravados(s), antes);
  assert.equal((await putProtecao(s, { limite_hora: 10 }, { cookie })).status, 200, 'Dono da casa passa');
  assert.equal(getSetting(s.db, 'wa_limite_hora'), '10');
});

test('CA1/CA5/CA6: validação com a frase da spec; um campo ruim recusa o corpo inteiro e nada é gravado', async (t) => {
  const s = await subir();
  t.after(s.fechar);
  semearProtecao(s.db);
  const antes = gravados(s);
  const casos = [
    [{ limite_hora: 0 }, ERRO_LIMITE_HORA], [{ limite_hora: 201 }, ERRO_LIMITE_HORA], [{ limite_hora: 40.5 }, ERRO_LIMITE_HORA],
    [{ limite_hora: 'x' }, ERRO_LIMITE_HORA], [{ limite_hora: true }, ERRO_LIMITE_HORA], [{ limite_hora: [40] }, ERRO_LIMITE_HORA],
    [{ silencio_ativo: '1' }, ERRO_SILENCIO_ATIVO], [{ silencio_ativo: 0 }, ERRO_SILENCIO_ATIVO],
    [{ silencio_de: '24:00' }, ERRO_SILENCIO_HORA], [{ silencio_ate: '7:00' }, ERRO_SILENCIO_HORA], [{ silencio_de: 2300 }, ERRO_SILENCIO_HORA],
    [{ silencio_de: '08:00', silencio_ate: '08:00' }, ERRO_SILENCIO_IGUAIS],
    [{ silencio_de: '07:00' }, ERRO_SILENCIO_IGUAIS], // igual ao "Até" gravado
    [{ delay_group_s: 1 }, 'Use um número inteiro de 2 a 60.'], [{ delay_group_s: 61 }, 'Use um número inteiro de 2 a 60.'],
    [{ delay_group_s: 2.5 }, 'Use um número inteiro de 2 a 60.'],
    [{ delay_offer_s: 4 }, 'Use um número inteiro de 5 a 600.'], [{ delay_offer_s: 601 }, 'Use um número inteiro de 5 a 600.'],
    [{ delay_offer_s: '' }, 'Use um número inteiro de 5 a 600.'],
    // tudo certo menos o último campo: nada é gravado
    [{ limite_hora: 30, silencio_ativo: false, silencio_de: '21:00', silencio_ate: '05:00', delay_group_s: 10, delay_offer_s: 1 }, 'Use um número inteiro de 5 a 600.'],
  ];
  for (const [corpo, erro] of casos) {
    const r = await putProtecao(s, corpo);
    assert.equal(r.status, 400, JSON.stringify(corpo));
    assert.deepEqual(r.json, { erro }, JSON.stringify(corpo));
  }
  assert.deepEqual(gravados(s), antes);
  assert.deepEqual(logs(s), []);
  // os limites das faixas passam
  for (const corpo of [{ limite_hora: 1 }, { limite_hora: 200 }, { delay_group_s: 2, delay_offer_s: 5 }, { delay_group_s: 60, delay_offer_s: 600 }]) {
    assert.equal((await putProtecao(s, corpo)).status, 200, JSON.stringify(corpo));
  }
  // corpo vazio, null e sem JSON não mexem em nada
  const depois = gravados(s); const nLogs = logs(s).length;
  assert.equal((await putProtecao(s, {})).status, 200);
  assert.equal((await putProtecao(s, { limite_hora: null, silencio_de: null, delay_group_s: null })).status, 200);
  assert.equal((await req(s.port, '/api/protecao', { method: 'PUT' })).status, 200);
  assert.deepEqual(gravados(s), depois);
  assert.equal(logs(s).length, nLogs);
});

test('CA6: ligar, desligar e mudar o silêncio; só um horário no corpo grava os dois; desligar grava "0" (a semente não volta)', async (t) => {
  const s = await subir();
  t.after(s.fechar);
  const msgs = () => logs(s).map((l) => l.message);
  // sem configuração (testes): ligar grava os dois horários padrão junto, e o silêncio passa a valer
  assert.equal((await putProtecao(s, { silencio_ativo: true })).status, 200);
  assert.deepEqual([getSetting(s.db, 'wa_silencio_ativo'), getSetting(s.db, 'wa_silencio_de'), getSetting(s.db, 'wa_silencio_ate')], ['1', '23:00', '07:00']);
  assert.equal((await protecao(s)).silencio.ativo, true);
  // só o "Das": o "Até" gravado fica
  assert.equal((await putProtecao(s, { silencio_de: '22:30' })).status, 200);
  assert.deepEqual([getSetting(s.db, 'wa_silencio_de'), getSetting(s.db, 'wa_silencio_ate')], ['22:30', '07:00']);
  assert.equal((await putProtecao(s, { silencio_ativo: false })).status, 200);
  assert.equal(getSetting(s.db, 'wa_silencio_ativo'), '0');
  semearProtecao(s.db); // o reinício do serviço não religa
  assert.equal((await protecao(s)).silencio.ativo, false);
  // mudar o horário com o silêncio desligado também fica no Histórico; religar mostra a faixa
  assert.equal((await putProtecao(s, { silencio_ate: '06:00' })).status, 200);
  assert.equal((await putProtecao(s, { silencio_ativo: true })).status, 200);
  assert.deepEqual(msgs(), [
    'Horário de silêncio ligado: das 23:00 às 07:00',
    'Horário de silêncio: das 23:00 às 07:00 → das 22:30 às 07:00',
    'Horário de silêncio desligado',
    'Horário de silêncio: das 22:30 às 07:00 → das 22:30 às 06:00',
    'Horário de silêncio ligado: das 22:30 às 06:00',
  ]);
  // um "Até" gravado ilegível vale o padrão (07:00): com "Das" 07:00 gravado, só ligar gravaria Das = Até; recusado
  // antes de gravar qualquer campo (nem o limite que veio junto)
  setSetting(s.db, 'wa_silencio_de', '07:00'); setSetting(s.db, 'wa_silencio_ate', 'lixo');
  for (const corpo of [{ silencio_ativo: true, limite_hora: 50 }, { silencio_ativo: true, silencio_de: '07:00', limite_hora: 50 }]) {
    const antes = gravados(s);
    const r = await putProtecao(s, corpo);
    assert.equal(r.status, 400, JSON.stringify(corpo));
    assert.equal(r.json.erro, ERRO_SILENCIO_IGUAIS);
    assert.deepEqual(gravados(s), antes, 'nem o limite foi gravado');
  }
  // corrigir o "Até" no mesmo pedido passa e grava o par legível
  assert.equal((await putProtecao(s, { silencio_ativo: true, silencio_ate: '06:00' })).status, 200);
  assert.deepEqual([getSetting(s.db, 'wa_silencio_de'), getSetting(s.db, 'wa_silencio_ate')], ['07:00', '06:00']);
});

test('CA1: o teto sem configuração aparece como "sem limite" no Histórico; o nome de quem salvou é cortado em 60 caracteres', async (t) => {
  const s = await subir({ panelPassword: SENHA });
  t.after(s.fechar);
  const { cookie } = await entrar(s);
  const nome = 'Ana '.repeat(30).trim();
  s.db.prepare('UPDATE users SET nome = ?').run(nome);
  assert.equal((await putProtecao(s, { limite_hora: '25' }, { cookie })).status, 200);
  assert.deepEqual(logs(s).map((l) => l.message), [`Máximo de mensagens por hora: sem limite → 25 (por ${nome.slice(0, 60)})`]);
  assert.equal((await protecao(s, { cookie })).limite_hora, 25);
});

// ---------------------------------------------------------------------------------------- PUT /api/ajustes sem as pausas
test('CA5: PUT /api/ajustes recusa as pausas antes de gravar qualquer campo; sem elas, segue como antes', async (t) => {
  const s = await subir();
  t.after(s.fechar);
  for (const corpo of [{ delay_group_s: 8 }, { delay_offer_s: 40 }, { delay_group_s: 8, titulo_max: 80, link_mode: 'direct' }, { delay_group_s: '' }]) {
    const r = await req(s.port, '/api/ajustes', { method: 'PUT', body: corpo });
    assert.equal(r.status, 400, JSON.stringify(corpo));
    assert.deepEqual(r.json, { erro: 'As pausas ficam em Proteção do número.' });
  }
  assert.deepEqual([getSetting(s.db, 'delay_group_s'), getSetting(s.db, 'delay_offer_s'), getSetting(s.db, 'titulo_max'), getSetting(s.db, 'link_mode')], [null, null, null, null]);
  // null nas pausas é "não mexer", como nos outros campos
  assert.equal((await req(s.port, '/api/ajustes', { method: 'PUT', body: { titulo_max: 80, delay_group_s: null, delay_offer_s: null } })).status, 200);
  assert.equal(getSetting(s.db, 'titulo_max'), '80');
});

// ---------------------------------------------------------------------------------------- semente no bloco principal
test('CA1/CA6: o bloco principal de src/server.js grava os padrões (semearProtecao) logo depois do openDb', () => {
  const src = fs.readFileSync(path.join(RAIZ, 'src', 'server.js'), 'utf8');
  const main = src.slice(src.indexOf('// ---------- inicialização ----------'));
  assert.match(main, /const db = openDb\(DATA_DIR\);\n(?:\s*\/\/[^\n]*\n)*\s*semearProtecao\(db\);/, 'semearProtecao(db) logo depois do openDb');
  assert.doesNotMatch(src.slice(0, src.indexOf('// ---------- inicialização ----------')), /semearProtecao\(/, 'buildApp e criarServicos não semeiam (os testes ficam sem teto nem silêncio)');
});

// ---------------------------------------------------------------------------------------- saídas pelo porteiro (CA4/CA5)
/** Destino de aviso que recebe o aviso de erro (o "Enviar teste" só manda a ele). */
const destino = (db) => Number(db.prepare('INSERT INTO aviso_destinos (nome, jid, resumo_blocos, avisos, ativo, created_at) VALUES (?,?,?,?,?,?)')
  .run('Pedro', JID_DESTINO, null, JSON.stringify(['erro']), 1, 1).lastInsertRowid);

test('contrato com o agendador: /state e o "Enviar teste" usam scheduler.ritmo e scheduler.wa quando ele os expõe', async (t) => {
  // porteiro de mentira num banco à parte, com teto 7: se o /state mostra 7, leu dele
  const dbPorteiro = openDb(tmp()); t.after(() => dbPorteiro.close());
  setSetting(dbPorteiro, 'wa_limite_hora', '7');
  const ritmo = createRitmo({ db: dbPorteiro, fast: true });
  const enviados = [];
  const agendador = { ritmo, wa: null };
  const s = await subir({ agendador });
  t.after(s.fechar);
  // o wa "embrulhado" de mentira: herda do wa simulado do servidor e anota quem passou por ele
  agendador.wa = Object.create(s.wa, { sendText: { value: async (jid, texto) => { enviados.push(jid); return s.wa.sendText(jid, texto); } } });
  // buildApp lê scheduler.wa na montagem: monta outro servidor no mesmo banco, agora com o wa de mentira
  const app = buildApp({ db: s.db, wa: s.wa, links: createLinkService({ getMode: () => 'fake' }), scheduler: agendador, publicHost: null, panelPassword: '', dataDir: s.dir });
  const server = await new Promise((ok) => { const sv = app.listen(0, '127.0.0.1', () => ok(sv)); });
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  const port = server.address().port;
  assert.equal((await req(port, '/api/state')).json.protecao.limite_hora, 7, 'o /state lê o porteiro do agendador');
  const r = await req(port, `/api/avisos/destinos/${destino(s.db)}/teste`, { method: 'POST', body: {} });
  assert.equal(r.status, 200, r.txt);
  assert.deepEqual(enviados, [JID_DESTINO], 'o "Enviar teste" saiu pelo scheduler.wa');
  assert.equal(s.wa.simulated.length, 1);
  assert.equal(saidas(s.db), 0, 'o porteiro do servidor não contou por conta própria (a contagem é do agendador)');
});

test('sem agendador, o servidor monta um porteiro próprio: o "Enviar teste" conta no teto (wa_saidas, só a hora)', async (t) => {
  const s = await subir({ agendador: null });
  t.after(s.fechar);
  const id = destino(s.db);
  assert.equal(saidas(s.db), 0);
  const r = await req(s.port, `/api/avisos/destinos/${id}/teste`, { method: 'POST', body: {} });
  assert.equal(r.status, 200, r.txt);
  assert.equal(s.wa.simulated.length, 1, 'a mensagem saiu');
  assert.equal(saidas(s.db), 1, 'e entrou na contagem do teto');
  assert.deepEqual(Object.keys(s.db.prepare('SELECT * FROM wa_saidas').get()), ['ts'], 'sem jid nem número');
  assert.equal((await protecao(s)).usados, 1);
  assert.equal(acessosRede, 0);
});

test('como o main (criarServicos): o servidor usa o porteiro do agendador e o "Enviar teste" conta no teto uma vez só', async (t) => {
  const s = await subir();
  t.after(s.fechar);
  assert.ok(s.scheduler.ritmo && s.scheduler.wa, 'o agendador expõe ritmo e wa (etapa 4)');
  const r = await req(s.port, `/api/avisos/destinos/${destino(s.db)}/teste`, { method: 'POST', body: {} });
  assert.equal(r.status, 200, r.txt);
  assert.equal(s.wa.simulated.length, 1);
  assert.equal(saidas(s.db), 1, 'contou uma vez (sem embrulho em dobro)');
  assert.equal((await protecao(s)).usados, 1);
});
