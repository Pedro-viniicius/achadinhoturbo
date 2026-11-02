// Visão Geral (analytics), eventos de grupo, blocos e rotacionador de links.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openDb } from '../src/db.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createLinkService } from '../src/links.js';
import { createScheduler } from '../src/scheduler.js';
import { buildApp } from '../src/server.js';
import { overview, resumo, periodRange, evasaoDoDia, dayOf, startOfDay } from '../src/analytics.js';
import { pickGroup, slugify, statusDosGrupos, parseLink } from '../src/rotador.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'disp-an-'));
const H = 3600000; const D = 86400000;
const ev = (db, ts, jid, who, action, byLink = 0, actor = null) => db.prepare('INSERT INTO group_events (ts, jid, participant, action, by_link, actor) VALUES (?,?,?,?,?,?)').run(ts, jid, who, action, byLink, actor);

function base() {
  const db = openDb(tmp());
  db.prepare('INSERT INTO groups (jid, name, size, updated_at, invite_code) VALUES (?,?,?,?,?)').run('g1@g.us', 'Casa', 100, Date.now(), 'AAAAAAAAAAAA');
  db.prepare('INSERT INTO groups (jid, name, size, updated_at, invite_code) VALUES (?,?,?,?,?)').run('g2@g.us', 'Beleza', 50, Date.now(), 'BBBBBBBBBBBB');
  db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run('g3@g.us', 'Sem convite', 10, Date.now());
  return db;
}

test('períodos: hoje, ontem, 7 dias, mês e personalizado', () => {
  const now = new Date(2026, 10, 2, 15, 30).getTime(); // 02/11/2026 15:30
  const sod = startOfDay(now);
  assert.deepEqual(periodRange('hoje', now), { de: sod, ate: sod + D - 1 });
  assert.deepEqual(periodRange('ontem', now), { de: sod - D, ate: sod - 1 });
  assert.equal(periodRange('7d', now).de, sod - 6 * D);
  assert.equal(dayOf(periodRange('mes', now).de), '2026-11-01');
  const mp = periodRange('mes_passado', now); assert.equal(dayOf(mp.de), '2026-10-01'); assert.equal(dayOf(mp.ate), '2026-10-31');
  const c = periodRange('custom', now, { de: '2026-10-10', ate: '2026-10-12' }); assert.equal(dayOf(c.de), '2026-10-10'); assert.equal(dayOf(c.ate), '2026-10-12');
});

test('visão geral: entradas, saídas, mesmo dia, tempo médio, evasão, série por hora e por grupo', () => {
  const db = base();
  const now = new Date(2026, 10, 2, 18, 0).getTime(); const d0 = startOfDay(now);
  // ontem: 2 entraram (link), 1 saiu no mesmo dia
  ev(db, d0 - D + 9 * H, 'g1@g.us', 'a@s', 'add', 1); ev(db, d0 - D + 10 * H, 'g1@g.us', 'b@s', 'add', 1); ev(db, d0 - D + 12 * H, 'g1@g.us', 'a@s', 'remove');
  // hoje: 3 entradas em g1 (2 link, 1 adicionado às 9h), 1 em g2; c saiu às 11h (mesmo dia, 2h depois); b (ontem) saiu hoje às 14h; d removido por admin
  ev(db, d0 + 9 * H, 'g1@g.us', 'c@s', 'add', 1); ev(db, d0 + 9 * H + 60000, 'g1@g.us', 'd@s', 'add', 0, 'adm@s'); ev(db, d0 + 10 * H, 'g1@g.us', 'e@s', 'add', 1);
  ev(db, d0 + 10 * H, 'g2@g.us', 'f@s', 'add', 1);
  ev(db, d0 + 11 * H, 'g1@g.us', 'c@s', 'remove'); ev(db, d0 + 14 * H, 'g1@g.us', 'b@s', 'remove'); ev(db, d0 + 15 * H, 'g1@g.us', 'd@s', 'remove', 0, 'adm@s');
  db.prepare('INSERT INTO group_reads (jid, participant, day, ts) VALUES (?,?,?,?)').run('g1@g.us', 'e@s', dayOf(now), d0 + 11 * H);
  db.prepare('INSERT INTO group_reads (jid, participant, day, ts) VALUES (?,?,?,?)').run('g1@g.us', 'x@s', dayOf(now), d0 + 11 * H);
  db.prepare('INSERT INTO links (name, slug, group_jids, created_at) VALUES (?,?,?,?)').run('L', 'l', '["g1@g.us"]', now);
  for (let i = 0; i < 5; i++) db.prepare('INSERT INTO link_clicks (ts, link_id, jid, ip_hash) VALUES (?,?,?,?)').run(d0 + 8 * H + i, 1, 'g1@g.us', 'h');

  const o = overview(db, { ...periodRange('hoje', now), now });
  assert.deepEqual([o.cliques, o.entradas, o.entradas_link, o.entradas_add, o.saidas, o.saldo], [5, 4, 3, 1, 3, 1]);
  assert.equal(o.saidas_mesmo_dia, 2, 'c e d entraram e saíram hoje; b entrou ontem');
  // tempos: c 2h, b 28h, d ~6h -> média 12h
  assert.equal(o.tempo_medio_min, 720); assert.equal(o.saidas_com_entrada, 3);
  assert.equal(o.ativos, 2, 'e e f ainda estão'); assert.ok(o.permanencia_atual_min >= 8 * 60 - 1);
  assert.deepEqual([o.abriram, o.membros], [2, 160]);
  assert.deepEqual([o.evasao.entrou_dia.n, o.evasao.entrou_dia.de, o.evasao.entrou_dia.pct, o.evasao.entrou_dia.fechado], [2, 4, 50, false]);
  assert.deepEqual([o.evasao.em_7d.n, o.evasao.em_7d.fechado], [2, false]);
  assert.equal(o.evasao.total_dia.pct, Math.round((3 / 163) * 1000) / 10);
  assert.equal(o.periodo.por_hora, true); assert.equal(o.serie.length, 24);
  const h9 = o.serie.find((s) => s.k === 9); assert.deepEqual([h9.entradas, h9.saidas], [2, 0]);
  const h11 = o.serie.find((s) => s.k === 11); assert.deepEqual([h11.saidas, h11.saidas_mesmo_dia], [1, 1]);
  const g1 = o.por_grupo.find((g) => g.jid === 'g1@g.us');
  assert.deepEqual([g1.entradas, g1.pelo_link, g1.adicionados, g1.saidas, g1.mesmo_dia, g1.abriram], [3, 2, 1, 3, 2, 2]);
  assert.equal(o.eventos.length, 7);
  assert.equal(o.eventos.find((e) => e.participant === 'd@s' && e.action === 'remove').actor, 'adm@s', 'removido por admin');

  const ontem = evasaoDoDia(db, now - D); assert.deepEqual([ontem.n, ontem.de, ontem.pct], [1, 2, 50]);
  const r = resumo(db, periodRange('ontem', now)); assert.deepEqual([r.entradas, r.saidas, r.cliques], [2, 1, 0]);
  // filtro por bloco (só g2) e série por dia em 7 dias
  const so2 = overview(db, { ...periodRange('hoje', now), jids: ['g2@g.us'], now });
  assert.deepEqual([so2.entradas, so2.saidas, so2.membros, so2.cliques], [1, 0, 50, 0]);
  const sem = overview(db, { ...periodRange('7d', now), now });
  assert.equal(sem.periodo.por_hora, false); assert.equal(sem.serie.length, 7); assert.equal(sem.entradas, 6);
  assert.deepEqual(overview(db, { ...periodRange('hoje', now), jids: [], now }).entradas, 0, 'bloco vazio');
});

test('eventos do WhatsApp viram registros: entrou pelo link, adicionado, saiu, removido, leitura', () => {
  const dir = tmp(); const db = openDb(dir);
  db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run('g@g.us', 'G', 10, Date.now());
  const wa = createWhatsApp({ db, dir, dryRun: true });
  wa._onParticipants({ id: 'g@g.us', author: '5511999999999:3@s.whatsapp.net', participants: [{ id: '5511999999999@s.whatsapp.net' }], action: 'add' });
  wa._onParticipants({ id: 'g@g.us', author: '5511888888888@s.whatsapp.net', participants: [{ id: '123@lid', phoneNumber: '5511777777777@s.whatsapp.net' }], action: 'add' });
  wa._onParticipants({ id: 'g@g.us', author: '5511999999999@s.whatsapp.net', participants: [{ id: '5511999999999@s.whatsapp.net' }], action: 'remove' });
  wa._onParticipants({ id: 'g@g.us', author: '5511888888888@s.whatsapp.net', participants: [{ id: '5511777777777@s.whatsapp.net' }], action: 'remove' });
  wa._onParticipants({ id: 'g@g.us', author: 'x', participants: [{ id: 'y@s' }], action: 'promote' });
  const rows = db.prepare('SELECT participant, action, by_link, actor FROM group_events ORDER BY id').all();
  assert.deepEqual(rows.map((r) => [r.participant, r.action, r.by_link, r.actor]), [
    ['5511999999999@s.whatsapp.net', 'add', 1, null],
    ['5511777777777@s.whatsapp.net', 'add', 0, '5511888888888@s.whatsapp.net'],
    ['5511999999999@s.whatsapp.net', 'remove', 0, null],
    ['5511777777777@s.whatsapp.net', 'remove', 0, '5511888888888@s.whatsapp.net'],
  ]);
  assert.equal(db.prepare("SELECT size FROM groups WHERE jid = 'g@g.us'").get().size, 10, '+2 -2');
  wa._onReceipts([
    { key: { remoteJid: 'g@g.us', fromMe: true, id: 'm1' }, receipt: { userJid: '5511777777777@s.whatsapp.net', readTimestamp: 1793600000 } },
    { key: { remoteJid: 'g@g.us', fromMe: true, id: 'm2' }, receipt: { userJid: '5511777777777@s.whatsapp.net', readTimestamp: 1793600100 } },
    { key: { remoteJid: 'g@g.us', fromMe: true, id: 'm3' }, receipt: { userJid: '5511666666666@s.whatsapp.net', receiptTimestamp: 1793600000 } },
    { key: { remoteJid: '5511@s.whatsapp.net', fromMe: true, id: 'm4' }, receipt: { userJid: '5511@s.whatsapp.net', readTimestamp: 1793600000 } },
  ]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM group_reads').get().n, 1, 'uma pessoa por dia; só leitura; só grupos');
});

test('rotacionador: encher um por vez, alternar, reabrir; convite obrigatório; slug', () => {
  const grupos = { a: { jid: 'a', size: 1000, invite_code: 'A' }, b: { jid: 'b', size: 10, invite_code: 'B' }, c: { jid: 'c', size: 5, invite_code: 'C' }, d: { jid: 'd', size: 0 } };
  const link = (mode, extra = {}) => ({ mode, limit_members: 1000, reopen_below: 900, group_jids: ['d', 'a', 'b', 'c'], state: {}, ...extra });
  assert.equal(pickGroup(link('fill'), grupos).group.jid, 'b', 'd sem convite, a lotado');
  const alt = link('alternate'); let st = {}; const seq = [];
  for (let i = 0; i < 4; i++) { const r = pickGroup({ ...alt, state: st }, grupos); seq.push(r.group.jid); st = r.state; }
  assert.deepEqual(seq, ['b', 'c', 'b', 'c']);
  // reabrir: a lotou (fecha); mesmo caindo para 950 continua fechado; abaixo de 900 reabre
  let r = pickGroup(link('reopen'), grupos); assert.equal(r.group.jid, 'b'); assert.ok(r.state.closed.a);
  r = pickGroup({ ...link('reopen'), state: r.state }, { ...grupos, a: { ...grupos.a, size: 950 } }); assert.equal(r.group.jid, 'b'); assert.ok(r.state.closed.a);
  r = pickGroup({ ...link('reopen'), state: r.state }, { ...grupos, a: { ...grupos.a, size: 880 } }); assert.equal(r.group.jid, 'a'); assert.ok(!r.state.closed.a);
  // em 'fill' o grupo cheio que esvaziou volta naturalmente
  assert.equal(pickGroup(link('fill'), { ...grupos, a: { ...grupos.a, size: 999 } }).group.jid, 'a');
  assert.equal(pickGroup(link('fill'), { a: { jid: 'a', size: 1000, invite_code: 'A' } }).group, null);
  assert.deepEqual(statusDosGrupos(parseLink({ group_jids: '["a","d","x"]', limit_members: 1000, state: '{}' }), grupos).map((g) => g.situacao), ['lotado', 'sem convite', 'removido']);
  assert.equal(slugify('Achadinhos de Casa #2!'), 'achadinhos-de-casa-2');
});

// ---------- API: blocos, convite, links e redirecionamento público ----------
function subir() {
  const dir = tmp(); const db = openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const scheduler = createScheduler({ db, wa, links, fast: true });
  const app = buildApp({ db, wa, links, scheduler, publicHost: 'painel.exemplo.com', panelPassword: 'senha-de-teste-123' });
  db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run('g1@g.us', 'Casa', 5, Date.now());
  db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run('g2@g.us', 'Beleza', 1000, Date.now());
  db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etq', Date.now());
  return new Promise((ok) => { const server = app.listen(0, '127.0.0.1', () => ok({ db, port: server.address().port, fechar: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => { db.close(); r(); }); }) })); });
}
function req(port, caminho, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((ok, err) => {
    const data = body != null ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, path: caminho, method, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let txt = ''; res.setEncoding('utf8'); res.on('data', (c) => (txt += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(txt); } catch { /* html */ } ok({ status: res.statusCode, headers: res.headers, json, txt }); });
    });
    r.on('error', err); if (data) r.write(data); r.end();
  });
}

test('API: convite (colar e buscar), blocos com métricas, links e /g/<slug> público com contagem de cliques', async () => {
  const s = await subir();
  try {
    const sid = (await req(s.port, '/api/login', { method: 'POST', body: { senha: 'senha-de-teste-123' } })).headers['set-cookie'][0].split(';')[0];
    const auth = { cookie: sid, origin: 'http://127.0.0.1:' + s.port };
    // convite colado e buscado (simulado)
    assert.equal((await req(s.port, '/api/groups/g1%40g.us/invite', { method: 'PUT', headers: auth, body: { url: 'https://chat.whatsapp.com/ABCDEFGHIJKL' } })).json.invite_code, 'ABCDEFGHIJKL');
    assert.equal((await req(s.port, '/api/groups/g1%40g.us/invite', { method: 'PUT', headers: auth, body: { url: 'lixo' } })).status, 400);
    assert.match((await req(s.port, '/api/groups/g2%40g.us/invite', { method: 'POST', headers: auth })).json.invite_code, /^SIMULADO/);
    const grupos = (await req(s.port, '/api/groups', { headers: auth })).json;
    assert.equal(grupos.find((g) => g.jid === 'g1@g.us').invite_code, 'ABCDEFGHIJKL');
    // bloco
    const b = await req(s.port, '/api/blocks', { method: 'POST', headers: auth, body: { name: 'Casa', tag_id: 1, group_jids: ['g1@g.us', 'g1@g.us'] } });
    assert.equal(b.status, 200);
    const blocos = (await req(s.port, '/api/blocks', { headers: auth })).json;
    assert.deepEqual([blocos[0].name, blocos[0].group_jids, blocos[0].membros, blocos[0].hoje.entradas], ['Casa', ['g1@g.us'], 5, 0]);
    assert.equal((await req(s.port, '/api/groups', { headers: auth })).json.find((g) => g.jid === 'g1@g.us').blocks[0], b.json.id);
    assert.equal((await req(s.port, '/api/tags/1', { method: 'DELETE', headers: auth })).status, 400, 'etiqueta usada pelo bloco');
    // link: g2 lotado (1000), g1 com vaga
    const l = await req(s.port, '/api/links', { method: 'POST', headers: auth, body: { name: 'Achadinhos de Casa', mode: 'fill', limit_members: 1000, group_jids: ['g2@g.us', 'g1@g.us'], fallback_url: 'https://exemplo.com/cheio' } });
    assert.equal(l.status, 200, JSON.stringify(l.json));
    const lista = (await req(s.port, '/api/links', { headers: auth })).json;
    assert.equal(lista[0].slug, 'achadinhos-de-casa'); assert.equal(lista[0].url, 'https://painel.exemplo.com/g/achadinhos-de-casa');
    assert.deepEqual(lista[0].grupos.map((g) => g.situacao), ['lotado', 'aberto']);
    assert.equal((await req(s.port, '/api/links', { method: 'POST', headers: auth, body: { name: 'Achadinhos de Casa', group_jids: ['g1@g.us'] } })).status, 400, 'slug repetido');
    // público: sem login, sem Host checado
    const r = await req(s.port, '/g/achadinhos-de-casa', { headers: { host: 'painel.exemplo.com' } });
    assert.equal(r.status, 302); assert.equal(r.headers.location, 'https://chat.whatsapp.com/ABCDEFGHIJKL');
    assert.equal((await req(s.port, '/g/nao-existe')).status, 404);
    assert.equal((await req(s.port, '/api/links', { headers: auth })).json[0].cliques_hoje, 1);
    const o = (await req(s.port, `/api/overview?periodo=hoje&bloco=${b.json.id}`, { headers: auth })).json;
    assert.equal(o.cliques, 1); assert.equal(o.membros, 5);
    // todos lotados -> URL reserva; pausado -> 404
    s.db.prepare("UPDATE groups SET size = 1000 WHERE jid = 'g1@g.us'").run();
    assert.equal((await req(s.port, '/g/achadinhos-de-casa')).headers.location, 'https://exemplo.com/cheio');
    await req(s.port, `/api/links/${l.json.id}/enabled`, { method: 'POST', headers: auth, body: { enabled: false } });
    assert.equal((await req(s.port, '/g/achadinhos-de-casa')).status, 404);
  } finally { await s.fechar(); }
});
