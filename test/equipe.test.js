// Testes da Equipe (plano disparos-comunicacao-conta, etapas 7 e 12; contrato em docs/produto/planos/entrega2-contrato.md):
// migração da senha única para o Dono, modo legado e login por e-mail, ativar o login, convites (criar, info, aceitar,
// girar, cancelar, vencer, freio), papéis (Operador recebe 403), si mesmo e último Dono protegidos, remover pessoa,
// `npm run senha` e nenhum e-mail no log nem em erro (CA7, CA9, CA10).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { openDb, getSetting, setSetting } from '../src/db.js';
import { buildApp } from '../src/server.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createLinkService } from '../src/links.js';
import { createScheduler } from '../src/scheduler.js';
import { createAuth, hashPassword, setPassword, verifyPassword } from '../src/auth.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = 'painel.exemplo.com';
const SENHA = 'senha-de-teste-123';
const D = 24 * 60 * 60 * 1000;
const INVALIDO = { erro: 'Este convite não vale mais.' };
const SO_DONO = { erro: 'Só o Dono pode fazer isso.' };
const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-eq-')); pastas.push(p); return p; };
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** `antes(db)` prepara o banco antes do buildApp (ex.: o estado de antes da migração). */
function subir({ publicHost = HOST, panelPassword = SENHA, dir = tmp(), antes } = {}) {
  const db = openDb(dir);
  antes?.(db);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const scheduler = createScheduler({ db, wa, links, fast: true });
  const app = buildApp({ db, wa, links, scheduler, publicHost, panelPassword, dataDir: dir });
  return new Promise((ok) => {
    const server = app.listen(0, '127.0.0.1', () => ok({
      db, dir, port: server.address().port, auth: app.locals.auth,
      fechar: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => { db.close(); r(); }); }),
    }));
  });
}
function req(port, caminho, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((ok, err) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, path: caminho, method, headers: { ...(data != null ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let txt = ''; res.setEncoding('utf8'); res.on('data', (c) => (txt += c));
      res.on('end', () => {
        let json = null; try { json = JSON.parse(txt); } catch { /* html */ }
        // CA10: nenhuma mensagem de erro traz e-mail
        if (json?.erro) assert.ok(!String(json.erro).includes('@'), `erro com e-mail: ${json.erro}`);
        ok({ status: res.statusCode, headers: res.headers, json, txt });
      });
    });
    r.on('error', err); if (data != null) r.write(data); r.end();
  });
}
const sidDe = (r) => String(r.headers['set-cookie']?.[0] || '').split(';')[0];
/** Chamada do painel: origem da casa e, se houver, o cookie de sessão. */
const chamar = (s, cookie, method, caminho, body) => req(s.port, caminho, { method, body, headers: { origin: `http://127.0.0.1:${s.port}`, ...(cookie ? { cookie } : {}) } });
const entrar = (s, corpo, ip) => req(s.port, '/api/login', { method: 'POST', body: corpo, headers: ip ? { 'x-forwarded-for': ip } : {} });
const estado = (s, cookie) => req(s.port, '/api/state', { headers: cookie ? { cookie } : {} });
const modo = async (s) => (await req(s.port, '/api/login/modo')).json;
const tokenDe = (link) => link.split('#')[1];
const info = (s, token, ip) => req(s.port, '/api/convite/info', { method: 'POST', body: { token }, headers: ip ? { 'x-forwarded-for': ip } : {} });
const aceitar = (s, corpo, ip) => req(s.port, '/api/convite/aceitar', { method: 'POST', body: corpo, headers: ip ? { 'x-forwarded-for': ip } : {} });
/** Dono convida; a pessoa aceita. → { cookie, id, token } */
async function convidarEAceitar(s, dono, email, papel, nome, senha = `senha-de-${nome.toLowerCase()}-1`) {
  const c = await chamar(s, dono, 'POST', '/api/equipe/convites', { email, papel });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  const token = tokenDe(c.json.link);
  const a = await aceitar(s, { token, nome, senha });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  return { cookie: sidDe(a), id: s.db.prepare('SELECT id FROM users WHERE email = ?').get(email).id, token, senha };
}

test('migração: a senha única vira o Dono sem e-mail, a sessão aberta continua valendo e passa a ser dele; idempotente', async () => {
  const hash = hashPassword(SENHA);
  const sid = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  // banco de antes da Equipe: hash da senha única, sessão sem user_id e nenhuma pessoa
  const s = await subir({ panelPassword: '', antes: (db) => {
    setSetting(db, 'panel_password_hash', hash);
    db.prepare('INSERT INTO sessions (id, created_at, expires_at, ip, last_seen) VALUES (?,?,?,?,?)').run(sha256(sid), now, now + D, '', now);
  } });
  try {
    const pessoas = s.db.prepare('SELECT id, nome, email, papel, senha_hash FROM users').all().map((p) => ({ ...p }));
    assert.deepEqual(pessoas, [{ id: pessoas[0].id, nome: 'Dono', email: null, papel: 'dono', senha_hash: hash }]);
    assert.equal(getSetting(s.db, 'panel_password_hash'), hash, 'o hash antigo fica no banco (rollback)');
    assert.equal(s.db.prepare('SELECT user_id FROM sessions WHERE id = ?').get(sha256(sid)).user_id, pessoas[0].id);
    const st = await estado(s, 'sid=' + sid);
    assert.equal(st.status, 200, 'a sessão aberta antes da migração continua valendo');
    assert.deepEqual(st.json.usuario, { id: pessoas[0].id, nome: 'Dono', email: null, papel: 'dono', precisa_completar: true });
    assert.deepEqual(await modo(s), { modo: 'legado' });
    // segundo start (com PANEL_PASSWORD diferente): nada muda
    createAuth({ db: s.db, password: 'outra-senha-qualquer' });
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
    assert.equal(getSetting(s.db, 'panel_password_hash'), hash);
    // depois da migração, sessão sem pessoa não vale e é apagada
    const orfa = crypto.randomBytes(32).toString('hex');
    s.db.prepare('INSERT INTO sessions (id, created_at, expires_at, ip, last_seen) VALUES (?,?,?,?,?)').run(sha256(orfa), now, now + D, '', now);
    assert.equal((await estado(s, 'sid=' + orfa)).status, 401);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id = ?').get(sha256(orfa)).n, 0);
    // o Dono migrado entra só com a senha, como antes
    assert.equal((await entrar(s, { senha: SENHA })).status, 200);
  } finally { await s.fechar(); }
});

test('legado: entra só com a senha; PUT /api/me completa o cadastro e o login passa a pedir e-mail; troca de senha derruba só as outras sessões', async () => {
  const s = await subir();
  try {
    // rotas e páginas públicas
    assert.deepEqual(await modo(s), { modo: 'legado' });
    const pagina = await req(s.port, '/convite.html');
    assert.ok(![302, 401].includes(pagina.status), `convite.html é pública (veio ${pagina.status})`);
    const errada = await entrar(s, { senha: 'errada-123' });
    assert.equal(errada.status, 401); assert.deepEqual(errada.json, { erro: 'E-mail ou senha incorretos.' });
    const cookie = sidDe(await entrar(s, { senha: SENHA }));
    const outra = sidDe(await entrar(s, { senha: SENHA })); // outro navegador do mesmo Dono
    assert.ok(s.db.prepare('SELECT last_login_at FROM users').get().last_login_at > 0);
    // validação
    for (const [corpo, msg] of [
      [{ nome: ' ', email: 'ana@exemplo.com' }, 'Informe o nome.'],
      [{ nome: 'A'.repeat(81), email: 'ana@exemplo.com' }, 'O nome pode ter até 80 caracteres.'],
      [{ nome: 'Ana', email: 'sem-arroba' }, 'Escolha um e-mail válido.'],
      [{ nome: 'Ana', email: `${'a'.repeat(110)}@exemplo.com` }, 'Escolha um e-mail válido.'],
      [{ nome: 'Ana', email: 'ana@exemplo.com', senha: 'curta' }, 'A senha precisa de ao menos 8 caracteres.'],
    ]) {
      const r = await chamar(s, cookie, 'PUT', '/api/me', corpo);
      assert.equal(r.status, 400, JSON.stringify(corpo)); assert.deepEqual(r.json, { erro: msg });
    }
    assert.deepEqual(await modo(s), { modo: 'legado' }, 'nada gravado');
    const me = await chamar(s, cookie, 'PUT', '/api/me', { nome: ' Ana ', email: '  Ana@Exemplo.COM ' });
    assert.equal(me.status, 200); assert.deepEqual(me.json, { ok: true });
    assert.deepEqual(await modo(s), { modo: 'email' }, 'com o e-mail gravado, o modo legado acaba');
    assert.deepEqual((await estado(s, cookie)).json.usuario, { id: 1, nome: 'Ana', email: 'ana@exemplo.com', papel: 'dono', precisa_completar: false });
    assert.equal((await estado(s, outra)).status, 200, 'sem troca de senha, as outras sessões ficam');
    assert.equal((await entrar(s, { senha: SENHA })).status, 401, 'sem e-mail não entra mais');
    assert.equal((await entrar(s, { email: 'ANA@exemplo.com', senha: SENHA })).status, 200, 'e-mail sem distinção de caixa');
    // nova senha: esta sessão fica, as outras da pessoa caem, a senha antiga para de valer
    const nova = 'nova-senha-da-ana';
    assert.equal((await chamar(s, cookie, 'PUT', '/api/me', { nome: 'Ana', email: 'ana@exemplo.com', senha: nova })).status, 200);
    assert.equal((await estado(s, cookie)).status, 200);
    assert.equal((await estado(s, outra)).status, 401);
    assert.equal((await entrar(s, { email: 'ana@exemplo.com', senha: SENHA })).status, 401);
    assert.equal((await entrar(s, { email: 'ana@exemplo.com', senha: nova })).status, 200);
    assert.ok(await verifyPassword(nova, getSetting(s.db, 'panel_password_hash')), 'a senha única acompanha a do Dono (rollback)');
    // e-mail de outra pessoa: 409
    const bia = await convidarEAceitar(s, cookie, 'bia@exemplo.com', 'operador', 'Bia');
    const r = await chamar(s, bia.cookie, 'PUT', '/api/me', { nome: 'Bia', email: 'ANA@exemplo.com' });
    assert.equal(r.status, 409); assert.deepEqual(r.json, { erro: 'Este e-mail já está em uso.' });
  } finally { await s.fechar(); }
});

test('login por e-mail: e-mail desconhecido e senha errada dão a mesma resposta e gastam o mesmo scrypt', async () => {
  const s = await subir({ publicHost: '', panelPassword: '' });
  try {
    assert.equal((await chamar(s, null, 'POST', '/api/equipe/ativar', { nome: 'Ana', email: 'ana@exemplo.com', senha: SENHA })).status, 200);
    const tempo = async (corpo, ip) => { const t0 = performance.now(); const r = await entrar(s, corpo, ip); return { r, ms: performance.now() - t0 }; };
    const conhecido = []; const desconhecido = [];
    for (let i = 0; i < 5; i++) { // um IP por tentativa: o freio por IP (5) não entra na conta
      const a = await tempo({ email: 'ana@exemplo.com', senha: 'errada-123' }, `203.0.113.${i}`);
      const b = await tempo({ email: `ninguem${i}@exemplo.com`, senha: 'errada-123' }, `203.0.113.${100 + i}`);
      assert.equal(a.r.status, 401); assert.equal(b.r.status, 401);
      assert.deepEqual(b.r.json, a.r.json); assert.deepEqual(a.r.json, { erro: 'E-mail ou senha incorretos.' });
      conhecido.push(a.ms); desconhecido.push(b.ms);
    }
    const mediana = (v) => [...v].sort((x, y) => x - y)[2];
    // sem o scrypt fictício, o e-mail desconhecido voltaria em ~1 ms, contra dezenas de ms da senha errada
    assert.ok(mediana(desconhecido) > mediana(conhecido) * 0.4, `desconhecido ${mediana(desconhecido).toFixed(1)} ms, conhecido ${mediana(conhecido).toFixed(1)} ms`);
    assert.equal((await entrar(s, { senha: SENHA })).status, 401, 'sem conta sem e-mail, só a senha não entra');
  } finally { await s.fechar(); }
});

test('legado com equipe (Q1): quem entrou por convite volta com o e-mail e o Dono sem e-mail só com a senha; falha com a mesma resposta e o mesmo freio por IP nos dois caminhos', async () => {
  const s = await subir(); // PANEL_PASSWORD: o Dono migrado, sem e-mail
  try {
    const dono = sidDe(await entrar(s, { senha: SENHA }, '198.51.100.1'));
    const bia = await convidarEAceitar(s, dono, 'bia@exemplo.com', 'operador', 'Bia');
    assert.deepEqual(await modo(s), { modo: 'legado' }, 'o Dono ainda não completou o cadastro');
    // com e-mail: a conta desse e-mail (sem distinção de caixa nem espaços)
    const rb = await entrar(s, { email: ' BIA@exemplo.com ', senha: bia.senha }, '198.51.100.2');
    assert.equal(rb.status, 200);
    assert.equal((await estado(s, sidDe(rb))).json.usuario.email, 'bia@exemplo.com');
    // e-mail em branco: a conta sem e-mail
    const rd = await entrar(s, { email: '  ', senha: SENHA }, '198.51.100.3');
    assert.equal(rd.status, 200);
    const ud = (await estado(s, sidDe(rd))).json.usuario;
    assert.equal(ud.email, null); assert.equal(ud.papel, 'dono');
    // a senha de uma conta não abre a outra; e-mail conhecido, desconhecido ou ausente: a mesma resposta
    let n = 10;
    for (const corpo of [{ senha: bia.senha }, { email: 'bia@exemplo.com', senha: SENHA }, { email: 'ninguem@exemplo.com', senha: SENHA }, { email: '', senha: 'errada-123' }]) {
      const r = await entrar(s, corpo, `198.51.100.${n++}`);
      assert.equal(r.status, 401, JSON.stringify(corpo)); assert.deepEqual(r.json, { erro: 'E-mail ou senha incorretos.' });
    }
    // o freio por IP (5) soma as falhas dos dois caminhos e trava os dois
    const ip = '198.51.100.50';
    for (const corpo of [{ senha: 'errada-123' }, { email: 'bia@exemplo.com', senha: 'errada-123' }, { email: 'ninguem@exemplo.com', senha: 'errada-123' }, { email: '', senha: 'errada-456' }, { email: 'bia@exemplo.com', senha: 'errada-456' }]) {
      assert.equal((await entrar(s, corpo, ip)).status, 401, JSON.stringify(corpo));
    }
    for (const corpo of [{ email: 'bia@exemplo.com', senha: bia.senha }, { senha: SENHA }]) {
      const r = await entrar(s, corpo, ip);
      assert.equal(r.status, 429, JSON.stringify(Object.keys(corpo))); assert.match(r.json.erro, /^Muitas tentativas\./);
    }
  } finally { await s.fechar(); }
});

test('ativar: só com o login desligado; cria o Dono com e-mail e deixa este navegador entrado; depois, 409', async () => {
  const s = await subir({ publicHost: '', panelPassword: '' });
  try {
    let st = await estado(s);
    assert.equal(st.json.auth, false); assert.equal(st.json.usuario, null);
    assert.deepEqual(await modo(s), { modo: 'email' });
    // sem login: Equipe vazia; convite e /api/me recusados (um convite aceito sem Dono trancaria o painel)
    const eq = await chamar(s, null, 'GET', '/api/equipe');
    assert.equal(eq.status, 200); assert.deepEqual([eq.json.pessoas, eq.json.convites], [[], []]);
    assert.deepEqual((await chamar(s, null, 'POST', '/api/equipe/convites', { email: 'x@exemplo.com', papel: 'operador' })).json, { erro: 'Ative o login antes de convidar alguém.' });
    assert.equal((await chamar(s, null, 'PUT', '/api/me', { nome: 'X', email: 'x@exemplo.com' })).status, 409);
    for (const corpo of [{ nome: 'Ana', email: 'ana@exemplo.com', senha: 'curta' }, { nome: '', email: 'ana@exemplo.com', senha: SENHA }, { nome: 'Ana', email: 'ana', senha: SENHA }]) {
      assert.equal((await chamar(s, null, 'POST', '/api/equipe/ativar', corpo)).status, 400, JSON.stringify(corpo));
    }
    assert.equal(s.auth.enabled(), false, 'nada gravado');
    const r = await chamar(s, null, 'POST', '/api/equipe/ativar', { nome: 'Ana', email: 'Ana@Exemplo.com', senha: SENHA });
    assert.equal(r.status, 200); assert.deepEqual(r.json, { ok: true });
    const cookie = sidDe(r); assert.match(cookie, /^sid=[a-f0-9]{64}$/);
    assert.equal((await estado(s)).status, 401, 'agora o painel pede login');
    st = await estado(s, cookie);
    assert.equal(st.json.auth, true);
    assert.deepEqual(st.json.usuario, { id: 1, nome: 'Ana', email: 'ana@exemplo.com', papel: 'dono', precisa_completar: false });
    const dono = s.db.prepare('SELECT senha_hash FROM users').get();
    assert.equal(getSetting(s.db, 'panel_password_hash'), dono.senha_hash, 'a senha única recebe o mesmo hash');
    const de_novo = await chamar(s, cookie, 'POST', '/api/equipe/ativar', { nome: 'Outro', email: 'outro@exemplo.com', senha: SENHA });
    assert.equal(de_novo.status, 409); assert.deepEqual(de_novo.json, { erro: 'O painel já tem login.' });
    assert.deepEqual(await modo(s), { modo: 'email' });
    assert.equal((await entrar(s, { email: 'ana@exemplo.com', senha: SENHA })).status, 200);
    // sem domínio público, o link do convite usa o Host da requisição
    const c = await chamar(s, cookie, 'POST', '/api/equipe/convites', { email: 'bia@exemplo.com', papel: 'operador' });
    assert.equal(c.status, 201); assert.match(c.json.link, new RegExp(`^http://127\\.0\\.0\\.1:${s.port}/convite\\.html#[a-f0-9]{64}$`));
    // PANEL_PASSWORD num start seguinte não passa por cima de quem já existe
    createAuth({ db: s.db, password: 'outra-senha-123' });
    assert.equal(getSetting(s.db, 'panel_password_hash'), dono.senha_hash);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  } finally { await s.fechar(); }
});

test('convite: link só na resposta e token só como sha256; info; aceitar com o e-mail e o papel do convite; usado = 410', async () => {
  const s = await subir();
  try {
    const dono = sidDe(await entrar(s, { senha: SENHA }));
    assert.equal((await chamar(s, dono, 'PUT', '/api/equipe/conta', { conta_nome: ' Achadinhos da Ana ' })).status, 200);
    assert.equal(getSetting(s.db, 'conta_nome'), 'Achadinhos da Ana');
    assert.equal((await chamar(s, dono, 'PUT', '/api/equipe/conta', { conta_nome: 'x'.repeat(61) })).status, 400);
    assert.equal((await chamar(s, dono, 'POST', '/api/equipe/convites', { email: 'sem-arroba', papel: 'operador' })).status, 400);
    assert.deepEqual((await chamar(s, dono, 'POST', '/api/equipe/convites', { email: 'bia@exemplo.com', papel: 'admin' })).json, { erro: 'Escolha o papel: Dono ou Operador.' });
    const antes = Date.now();
    const c = await chamar(s, dono, 'POST', '/api/equipe/convites', { email: 'Bia@Exemplo.com', papel: 'operador' });
    assert.equal(c.status, 201); assert.deepEqual(Object.keys(c.json).sort(), ['id', 'link']);
    const m = c.json.link.match(/^https:\/\/painel\.exemplo\.com\/convite\.html#([a-f0-9]{64})$/);
    assert.ok(m, c.json.link); const token = m[1];
    const linha = { ...s.db.prepare('SELECT * FROM invites WHERE id = ?').get(c.json.id) };
    assert.equal(linha.token_hash, sha256(token)); assert.ok(!JSON.stringify(linha).includes(token), 'o token não fica no banco');
    assert.equal(linha.email, 'bia@exemplo.com');
    assert.ok(linha.expires_at >= antes + 7 * D && linha.expires_at <= Date.now() + 7 * D, 'vence em 7 dias');
    // a listagem nunca traz token nem link
    const eq = await chamar(s, dono, 'GET', '/api/equipe');
    assert.equal(eq.status, 200); assert.ok(!eq.txt.includes(token) && !eq.txt.includes('convite.html'));
    assert.equal(eq.json.conta_nome, 'Achadinhos da Ana');
    const { expires_at, created_at, ...conv } = eq.json.convites[0];
    assert.deepEqual(conv, { id: c.json.id, email: 'bia@exemplo.com', papel: 'operador', convidado_por: 'Dono', vencido: false });
    assert.equal(expires_at, linha.expires_at); assert.ok(created_at > 0);
    const { created_at: criada, last_login_at: entrou, ...eu } = eq.json.pessoas[0];
    assert.deepEqual(eu, { id: 1, nome: 'Dono', email: null, papel: 'dono', voce: true, ultimo_dono: true });
    assert.ok(criada > 0 && entrou > 0);
    const dup = await chamar(s, dono, 'POST', '/api/equipe/convites', { email: 'BIA@exemplo.com', papel: 'dono' });
    assert.equal(dup.status, 409); assert.deepEqual(dup.json, { erro: 'Já existe um convite para este e-mail. Cancele-o para criar outro.' });
    // info
    const i = await info(s, token);
    assert.equal(i.status, 200); assert.deepEqual(i.json, { conta_nome: 'Achadinhos da Ana', email: 'bia@exemplo.com', papel: 'operador' });
    // aceitar: validação sem gastar o convite
    assert.deepEqual((await aceitar(s, { token, nome: '  ', senha: 'senha-da-bia-1' })).json, { erro: 'Informe o nome.' });
    assert.deepEqual((await aceitar(s, { token, nome: 'Bia', senha: 'curta' })).json, { erro: 'A senha precisa de ao menos 8 caracteres.' });
    assert.equal((await info(s, token)).status, 200, 'convite ainda vale');
    // o e-mail e o papel vêm do convite, nunca do corpo
    const ac = await aceitar(s, { token, nome: ' Bia ', senha: 'senha-da-bia-1', papel: 'dono', email: 'outra@exemplo.com' });
    assert.equal(ac.status, 200); assert.deepEqual(ac.json, { ok: true });
    const bia = sidDe(ac); assert.match(bia, /^sid=[a-f0-9]{64}$/);
    const st = await estado(s, bia);
    assert.deepEqual(st.json.usuario, { id: 2, nome: 'Bia', email: 'bia@exemplo.com', papel: 'operador', precisa_completar: false });
    assert.ok(s.db.prepare('SELECT used_at FROM invites WHERE id = ?').get(c.json.id).used_at > 0);
    // usado: a mesma mensagem de inválido, nos dois
    for (const r of [await aceitar(s, { token, nome: 'Bia', senha: 'senha-da-bia-1' }), await info(s, token)]) {
      assert.equal(r.status, 410); assert.deepEqual(r.json, INVALIDO);
    }
    // token mal formado ou inexistente: igual
    for (const tk of ['', 'abc', 'G'.repeat(64), crypto.randomBytes(32).toString('hex'), 123, null]) {
      const r = await info(s, tk); assert.equal(r.status, 410, String(tk)); assert.deepEqual(r.json, INVALIDO);
    }
    // ela passa a entrar com e-mail e senha (mesmo com o Dono ainda sem e-mail, no modo legado)
    assert.deepEqual(await modo(s), { modo: 'legado' });
    assert.equal((await entrar(s, { email: 'bia@exemplo.com', senha: 'senha-da-bia-1' })).status, 200);
    assert.equal((await entrar(s, { senha: 'senha-da-bia-1' })).status, 401, 'sem e-mail, só a conta sem e-mail');
    const ja = await chamar(s, dono, 'POST', '/api/equipe/convites', { email: 'bia@exemplo.com', papel: 'operador' });
    assert.equal(ja.status, 409); assert.deepEqual(ja.json, { erro: 'Esta pessoa já está na equipe.' });
    assert.deepEqual((await chamar(s, dono, 'GET', '/api/equipe')).json.convites, [], 'convite usado sai da lista');
    // CA10: o Histórico registra pelo nome, sem e-mail
    const log = JSON.stringify(s.db.prepare('SELECT * FROM log').all());
    assert.match(log, /Bia entrou na equipe pelo convite, como Operador\./);
    assert.ok(!log.includes('@'), log);
  } finally { await s.fechar(); }
});

test('convite: girar o link mata o anterior e renova o prazo; cancelar; vencido = 410 e listado como vencido; limpeza de 30 dias', async () => {
  const s = await subir();
  try {
    const dono = sidDe(await entrar(s, { senha: SENHA }));
    const criar = async (email, papel) => { const r = await chamar(s, dono, 'POST', '/api/equipe/convites', { email, papel }); assert.equal(r.status, 201); return r.json; };
    const c = await criar('cid@exemplo.com', 'dono');
    s.db.prepare('UPDATE invites SET expires_at = ? WHERE id = ?').run(Date.now() + D, c.id);
    const g = await chamar(s, dono, 'POST', `/api/equipe/convites/${c.id}/link`);
    assert.equal(g.status, 200); assert.deepEqual(Object.keys(g.json), ['link']);
    const t1 = tokenDe(c.link); const t2 = tokenDe(g.json.link);
    assert.match(t2, /^[a-f0-9]{64}$/); assert.notEqual(t1, t2);
    assert.deepEqual((await info(s, t1)).json, INVALIDO, 'o link antigo morreu');
    assert.equal((await info(s, t2)).json.papel, 'dono');
    assert.ok(s.db.prepare('SELECT expires_at FROM invites WHERE id = ?').get(c.id).expires_at > Date.now() + 7 * D - 60000, 'prazo renovado');
    // cancelar
    const del = await chamar(s, dono, 'DELETE', `/api/equipe/convites/${c.id}`);
    assert.equal(del.status, 200); assert.deepEqual(del.json, { ok: true });
    assert.deepEqual((await info(s, t2)).json, INVALIDO);
    assert.equal((await chamar(s, dono, 'DELETE', `/api/equipe/convites/${c.id}`)).status, 404);
    assert.equal((await chamar(s, dono, 'POST', `/api/equipe/convites/${c.id}/link`)).status, 404, 'cancelado não gira');
    assert.equal((await chamar(s, dono, 'POST', '/api/equipe/convites/abc/link')).status, 404);
    // vencido: 410 no info e no aceite, listado com vencido:true, não impede convite novo e pode ganhar link novo
    const v = await criar('dan@exemplo.com', 'operador');
    s.db.prepare('UPDATE invites SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, v.id);
    assert.deepEqual((await info(s, tokenDe(v.link))).json, INVALIDO);
    assert.deepEqual((await aceitar(s, { token: tokenDe(v.link), nome: 'Dan', senha: 'senha-do-dan-1' })).json, INVALIDO);
    let lista = (await chamar(s, dono, 'GET', '/api/equipe')).json.convites;
    assert.deepEqual(lista.map((x) => [x.id, x.vencido]), [[v.id, true]], 'cancelado sai da lista; vencido fica, marcado');
    const v2 = await criar('dan@exemplo.com', 'operador');
    assert.deepEqual((await chamar(s, dono, 'GET', '/api/equipe')).json.convites.map((x) => [x.id, x.vencido]), [[v2.id, false], [v.id, true]]);
    const revive = await chamar(s, dono, 'POST', `/api/equipe/convites/${v.id}/link`);
    assert.equal(revive.status, 200); assert.equal((await info(s, tokenDe(revive.json.link))).status, 200);
    // limpeza preguiçosa: usado/cancelado/vencido há mais de 30 dias some do banco; há 29 dias fica
    const ins = s.db.prepare('INSERT INTO invites (token_hash, email, papel, expires_at, created_at, used_at, canceled_at) VALUES (?,?,?,?,?,?,?)');
    const now = Date.now();
    ins.run('h1', 'velho1@exemplo.com', 'operador', now, now - 40 * D, null, now - 31 * D);
    ins.run('h2', 'velho2@exemplo.com', 'operador', now, now - 40 * D, now - 31 * D, null);
    ins.run('h3', 'velho3@exemplo.com', 'operador', now - 31 * D, now - 40 * D, null, null);
    ins.run('h4', 'recente@exemplo.com', 'operador', now, now - 40 * D, null, now - 29 * D);
    lista = (await chamar(s, dono, 'GET', '/api/equipe')).json.convites;
    const restam = s.db.prepare("SELECT token_hash FROM invites WHERE token_hash LIKE 'h_'").all().map((r) => r.token_hash);
    assert.deepEqual(restam, ['h4']);
    assert.ok(!lista.some((x) => x.email === 'recente@exemplo.com'), 'cancelado recente fica no banco, fora da lista');
  } finally { await s.fechar(); }
});

test('papéis: Operador recebe 403 nas ações de Dono e não vê segredos; papel muda na hora; si mesmo e último Dono protegidos; remover derruba as sessões', async (t) => {
  const saida = [];
  for (const m of ['log', 'error', 'warn']) t.mock.method(console, m, (...a) => saida.push(a.join(' ')));
  const s = await subir();
  try {
    const dono = sidDe(await entrar(s, { senha: SENHA }));
    const bia = await convidarEAceitar(s, dono, 'bia@exemplo.com', 'operador', 'Bia');
    const token = getSetting(s.db, 'ext_token');
    for (const [method, caminho, body] of [
      ['GET', '/api/equipe'], ['PUT', '/api/equipe/conta', { conta_nome: 'X' }], ['POST', '/api/equipe/convites', { email: 'z@exemplo.com', papel: 'dono' }],
      ['POST', '/api/equipe/convites/1/link', {}], ['DELETE', '/api/equipe/convites/1'], ['PUT', '/api/equipe/pessoas/1', { papel: 'operador' }],
      ['DELETE', '/api/equipe/pessoas/1'], ['POST', '/api/ajustes/token', {}], ['POST', '/api/wa/logout', {}], ['POST', '/api/privacidade/limpar', {}],
      ['PUT', '/api/conexoes/mercadolivre', { campos: {} }], ['PUT', '/api/conexoes/amazon', { campos: { tag: 'x' } }], ['POST', '/api/conexoes/amazon/testar', {}],
    ]) {
      const r = await chamar(s, bia.cookie, method, caminho, body);
      assert.equal(r.status, 403, `${method} ${caminho}`); assert.deepEqual(r.json, SO_DONO, `${method} ${caminho}`);
    }
    assert.equal(getSetting(s.db, 'ext_token'), token, 'token da extensão intacto');
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM invites').get().n, 1, 'nenhum convite novo');
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM conexoes').get().n, 0, 'nenhuma conexão gravada');
    // Conexões: Operador lista sem segredos_salvos; o Dono, com
    const cxOp = await chamar(s, bia.cookie, 'GET', '/api/conexoes');
    assert.equal(cxOp.status, 200); assert.ok(cxOp.json.length > 0 && cxOp.json.every((c) => !('segredos_salvos' in c)));
    assert.ok((await chamar(s, dono, 'GET', '/api/conexoes')).json.every((c) => Array.isArray(c.segredos_salvos)));
    // o resto continua aberto ao Operador
    assert.equal((await estado(s, bia.cookie)).json.usuario.papel, 'operador');
    assert.equal((await chamar(s, bia.cookie, 'GET', '/api/rules')).status, 200);
    assert.equal((await chamar(s, bia.cookie, 'PUT', '/api/me', { nome: 'Bia Souza', email: 'bia@exemplo.com' })).status, 200);
    // papel muda na hora, na mesma sessão
    assert.deepEqual((await chamar(s, dono, 'PUT', `/api/equipe/pessoas/${bia.id}`, { papel: 'dono' })).json, { ok: true });
    const eq = await chamar(s, bia.cookie, 'GET', '/api/equipe');
    assert.equal(eq.status, 200, 'virou Dono: Equipe abre');
    assert.deepEqual(eq.json.pessoas.map((p) => [p.nome, p.papel, p.voce, p.ultimo_dono]), [['Dono', 'dono', false, false], ['Bia Souza', 'dono', true, false]]);
    // como Dono, Bia convida alguém; depois de removida, o convite fica com convidado_por vazio
    const eva = await chamar(s, bia.cookie, 'POST', '/api/equipe/convites', { email: 'eva@exemplo.com', papel: 'operador' });
    assert.equal(eva.status, 201);
    // si mesmo
    const proprio = await chamar(s, bia.cookie, 'PUT', `/api/equipe/pessoas/${bia.id}`, { papel: 'operador' });
    assert.equal(proprio.status, 409); assert.deepEqual(proprio.json, { erro: 'Você não pode mudar o próprio papel.' });
    const sair = await chamar(s, bia.cookie, 'DELETE', `/api/equipe/pessoas/${bia.id}`);
    assert.equal(sair.status, 409); assert.deepEqual(sair.json, { erro: 'Você não pode remover a si mesmo.' });
    // volta a Operador: 403 na hora
    assert.equal((await chamar(s, dono, 'PUT', `/api/equipe/pessoas/${bia.id}`, { papel: 'operador' })).status, 200);
    assert.equal((await chamar(s, bia.cookie, 'GET', '/api/equipe')).status, 403);
    assert.equal((await chamar(s, dono, 'PUT', `/api/equipe/pessoas/${bia.id}`, { papel: 'admin' })).status, 400);
    assert.equal((await chamar(s, dono, 'PUT', '/api/equipe/pessoas/999', { papel: 'dono' })).status, 404);
    assert.equal((await chamar(s, dono, 'DELETE', '/api/equipe/pessoas/999')).status, 404);
    // último Dono: o painel mostra; a regra vale mesmo sem a pessoa da sessão
    assert.equal((await chamar(s, dono, 'GET', '/api/equipe')).json.pessoas.find((p) => p.id === 1).ultimo_dono, true);
    const ultimo = { status: 409, message: 'A equipe precisa de ao menos um Dono.' };
    assert.throws(() => s.auth.mudarPapel(null, 1, 'operador'), ultimo);
    assert.throws(() => s.auth.removerPessoa(null, 1), ultimo);
    // remover: a pessoa sai na hora, com todas as sessões
    const outraSessao = sidDe(await entrar(s, { email: 'bia@exemplo.com', senha: bia.senha }));
    assert.equal((await estado(s, outraSessao)).status, 200);
    assert.deepEqual((await chamar(s, dono, 'DELETE', `/api/equipe/pessoas/${bia.id}`)).json, { ok: true });
    assert.equal((await estado(s, bia.cookie)).status, 401);
    assert.equal((await estado(s, outraSessao)).status, 401);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(bia.id).n, 0);
    assert.equal((await entrar(s, { email: 'bia@exemplo.com', senha: bia.senha })).status, 401);
    const conv = (await chamar(s, dono, 'GET', '/api/equipe')).json.convites.find((c) => c.id === eva.json.id);
    assert.equal(conv.convidado_por, '');
    // CA10: nada de e-mail no Histórico nem no console
    const log = s.db.prepare('SELECT message FROM log ORDER BY id').all().map((r) => r.message);
    assert.ok(log.some((m) => /Bia Souza agora é Dono \(por Dono\)\./.test(m)), log.join(' | '));
    assert.ok(log.some((m) => /Bia Souza saiu da equipe \(por Dono\)\./.test(m)), log.join(' | '));
    assert.ok(!log.join(' ').includes('@'), log.join(' | '));
    assert.ok(!saida.join(' ').includes('@'), saida.join(' | '));
  } finally { await s.fechar(); }
});

test('convite: dois aceites ao mesmo tempo do mesmo link criam uma pessoa só', async () => {
  const s = await subir();
  try {
    const dono = sidDe(await entrar(s, { senha: SENHA }));
    const c = await chamar(s, dono, 'POST', '/api/equipe/convites', { email: 'gil@exemplo.com', papel: 'operador' });
    const corpo = { token: tokenDe(c.json.link), nome: 'Gil', senha: 'senha-do-gil-1' };
    const rs = await Promise.all([1, 2].map(() => aceitar(s, corpo)));
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 410]);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM users WHERE email = ?').get('gil@exemplo.com').n, 1);
  } finally { await s.fechar(); }
});

test('convite: freio de 10 falhas por IP e 100 no total (sucesso não conta); 429 também no aceite', async () => {
  const s = await subir();
  try {
    const dono = sidDe(await entrar(s, { senha: SENHA }));
    const token = tokenDe((await chamar(s, dono, 'POST', '/api/equipe/convites', { email: 'hal@exemplo.com', papel: 'operador' })).json.link);
    const ruim = '0'.repeat(64);
    for (let i = 0; i < 12; i++) assert.equal((await info(s, token, '198.51.100.20')).status, 200, 'sucesso não conta');
    for (let i = 0; i < 10; i++) assert.equal((await info(s, ruim, '203.0.113.7')).status, 410);
    const bloq = await info(s, token, '203.0.113.7');
    assert.equal(bloq.status, 429); assert.match(bloq.json.erro, /^Muitas tentativas\. Tente de novo em (1 minuto|\d+ minutos)\.$/);
    assert.equal((await aceitar(s, { token, nome: 'Hal', senha: 'senha-do-hal-1' }, '203.0.113.7')).status, 429);
    assert.equal((await info(s, token, '198.51.100.21')).status, 200, 'outro IP segue');
    // limite global: 100 falhas de IPs diferentes trancam todo mundo
    for (let i = 0; i < 90; i++) await info(s, ruim, `192.0.2.${i}`);
    assert.equal((await info(s, token, '198.51.100.22')).status, 429);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1, 'ninguém entrou');
  } finally { await s.fechar(); }
});

test('npm run senha: troca a senha do Dono (cria o Dono sem e-mail se não há ninguém), acompanha a senha única e encerra todas as sessões', async () => {
  const dir = tmp();
  const db = openDb(dir);
  setPassword(db, 'primeira-senha-1');
  assert.deepEqual(db.prepare('SELECT nome, email, papel FROM users').all().map((p) => ({ ...p })), [{ nome: 'Dono', email: null, papel: 'dono' }]);
  assert.ok(await verifyPassword('primeira-senha-1', getSetting(db, 'panel_password_hash')));
  assert.throws(() => setPassword(db, 'curta'), /8 caracteres/);
  db.close();
  const s = await subir({ dir, panelPassword: '' });
  try {
    assert.deepEqual(await modo(s), { modo: 'legado' });
    const dono = sidDe(await entrar(s, { senha: 'primeira-senha-1' }));
    assert.equal((await chamar(s, dono, 'PUT', '/api/me', { nome: 'Ana', email: 'ana@exemplo.com' })).status, 200);
    const ivo = await convidarEAceitar(s, dono, 'ivo@exemplo.com', 'dono', 'Ivo');
    // o script de verdade, no mesmo banco
    const { stdout } = await promisify(execFile)(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/senha.js', 'senha-nova-do-dono'], { cwd: ROOT, env: { ...process.env, DATA_DIR: dir } });
    assert.match(stdout, /^Senha do Dono trocada\. Todas as sessões foram encerradas\./);
    assert.ok(!stdout.includes('@'));
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
    assert.equal((await estado(s, dono)).status, 401); assert.equal((await estado(s, ivo.cookie)).status, 401);
    assert.equal((await entrar(s, { email: 'ana@exemplo.com', senha: 'primeira-senha-1' })).status, 401);
    assert.equal((await entrar(s, { email: 'ana@exemplo.com', senha: 'senha-nova-do-dono' })).status, 200, 'o Dono mais antigo');
    assert.equal((await entrar(s, { email: 'ivo@exemplo.com', senha: ivo.senha })).status, 200, 'o outro Dono mantém a senha');
    assert.ok(await verifyPassword('senha-nova-do-dono', getSetting(s.db, 'panel_password_hash')));
  } finally { await s.fechar(); }
});

test('npm run senha sem terminal (stdin fechado): avisa, sai com código 1, sem o aviso do Node, e não mexe na senha', () => {
  const dir = tmp();
  const db = openDb(dir);
  setPassword(db, 'primeira-senha-1');
  const antes = getSetting(db, 'panel_password_hash');
  db.close();
  // input: '' fecha o stdin do filho; sem isso o pipe fica aberto e o readline espera para sempre
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/senha.js'], { cwd: ROOT, env: { ...process.env, DATA_DIR: dir }, input: '', encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Nenhuma senha informada/);
  assert.ok(!(r.stderr + r.stdout).includes('unsettled'), 'a promessa da pergunta precisa terminar quando a entrada acaba');
  const db2 = openDb(dir);
  assert.equal(getSetting(db2, 'panel_password_hash'), antes, 'a senha não muda');
  db2.close();
});
