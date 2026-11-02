// Testes de Conexões (plano disparos-comunicacao-conta, etapa 10; CA6 e CA10): campos do registro, segredo que
// nunca volta ao navegador, vazio mantém o salvo, campo estranho descartado, validação, 404 e "Testar".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { openDb, setSetting } from '../src/db.js';
import { buildApp } from '../src/server.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createLinkService } from '../src/links.js';
import { createScheduler } from '../src/scheduler.js';
import { PLATAFORMAS } from '../src/lojas.js';

const SENHA = 'senha-de-teste-123';
const CHAVE = 'Chave-Shopee-SECRETA-9f8e7d6c';       // segredo salvo
const CHAVE_NOVA = 'Outra-Chave-SECRETA-1a2b3c4d';   // troca do segredo
const ORDEM = ['mercadolivre', 'amazon', 'shopee', 'magalu', 'facebook'];

function subir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-cx-'));
  const db = openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const scheduler = createScheduler({ db, wa, links, fast: true });
  const app = buildApp({ db, wa, links, scheduler, panelPassword: SENHA, dataDir: dir });
  return new Promise((ok) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      ok({
        db, dir, port, links,
        fechar: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); r(); }); }),
      });
    });
  });
}

function req(port, caminho, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((ok, err) => {
    const data = body == null ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const h = { host: `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers };
    const r = http.request({ host: '127.0.0.1', port, path: caminho, method, headers: h }, (res) => {
      let txt = ''; res.setEncoding('utf8'); res.on('data', (c) => (txt += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(txt); } catch { /* não é JSON */ } ok({ status: res.statusCode, headers: res.headers, json, txt }); });
    });
    r.on('error', err); if (data) r.write(data); r.end();
  });
}

/** Sobe o servidor, entra e devolve um cliente da API já com cookie e Origin da casa. */
async function comSessao(fn) {
  const s = await subir();
  try {
    const login = await req(s.port, '/api/login', { method: 'POST', body: { senha: SENHA } });
    const sid = String(login.headers['set-cookie']?.[0] || '').split(';')[0];
    assert.match(sid, /^sid=/, 'login abriu sessão');
    const api = (caminho, opts = {}) => req(s.port, '/api' + caminho, { ...opts, headers: { cookie: sid, origin: `http://127.0.0.1:${s.port}`, ...(opts.headers || {}) } });
    await fn({ ...s, api });
  } finally { await s.fechar(); }
}

/** Lê a linha crua da tabela por fora do servidor (outra conexão, como o dono abriria o arquivo). */
function linhaCrua(dir, id) {
  const db = new DatabaseSync(path.join(dir, 'disparador.db'));
  try {
    const l = db.prepare('SELECT config, segredos, updated_at FROM conexoes WHERE plataforma = ?').get(id);
    return l ? { config: JSON.parse(l.config), segredos: JSON.parse(l.segredos), updated_at: l.updated_at } : null;
  } finally { db.close(); }
}

test('GET /api/conexoes lista as 5 plataformas na ordem do registro, com campos e sem valores de segredo', async () => {
  await comSessao(async ({ api }) => {
    const r = await api('/conexoes');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json));
    assert.deepEqual(r.json.map((p) => p.id), ORDEM);
    assert.deepEqual(Object.keys(PLATAFORMAS), ORDEM, 'a ordem é a do registro');
    for (const p of r.json) {
      for (const k of ['id', 'nome', 'implementada', 'descricao', 'campos', 'config', 'segredos_salvos', 'estado', 'updated_at']) assert.ok(k in p, `${p.id}.${k}`);
      assert.ok(Array.isArray(p.campos), `${p.id}.campos`);
      for (const c of p.campos) {
        assert.deepEqual(Object.keys(c).sort(), ['ajuda', 'max', 'nome', 'padrao', 'rotulo', 'tipo'], `${p.id}.${c.nome}: só a descrição do campo, sem valor`);
      }
      assert.deepEqual(p.segredos_salvos, []);
      assert.equal(p.updated_at, null);
    }
    const porId = Object.fromEntries(r.json.map((p) => [p.id, p]));
    assert.deepEqual(porId.shopee.campos.map((c) => [c.nome, c.tipo]), [['app_id', 'texto'], ['chave', 'segredo']]);
    assert.deepEqual(porId.amazon.campos.map((c) => c.nome), ['tag']);
    assert.deepEqual(porId.magalu.campos.map((c) => c.nome), ['loja']);
    assert.deepEqual(porId.facebook.campos, [], 'Facebook não tem campos');
    assert.deepEqual(porId.mercadolivre.campos, [], 'ML: a configuração são as etiquetas, não um campo daqui');
    assert.deepEqual(porId.mercadolivre.config, { etiquetas: [] });
    assert.equal(porId.mercadolivre.estado, 'falta_configurar', 'sem etiqueta e sem extensão');
    for (const id of ['amazon', 'shopee', 'magalu', 'facebook']) {
      assert.equal(porId[id].implementada, false); assert.equal(porId[id].estado, 'nao_implementada', id);
      assert.deepEqual(porId[id].config, {});
    }
  });
});

test('PUT Shopee guarda AppID e chave; a chave nunca aparece no texto cru de nenhuma resposta, nem no log', async () => {
  const saidas = [];
  const originais = {};
  for (const m of ['log', 'info', 'warn', 'error']) { originais[m] = console[m]; console[m] = (...a) => { saidas.push(a.map(String).join(' ')); originais[m](...a); }; }
  try {
    await comSessao(async ({ api, db, dir }) => {
      const respostas = [];
      const put = await api('/conexoes/shopee', { method: 'PUT', body: { campos: { app_id: '123456', chave: CHAVE } } });
      respostas.push(put);
      assert.equal(put.status, 200, put.txt);
      assert.equal(put.json.id, 'shopee');
      assert.deepEqual(put.json.config, { app_id: '123456' }, 'config só com campos de texto');
      assert.deepEqual(put.json.segredos_salvos, ['chave']);
      assert.equal(typeof put.json.updated_at, 'number');
      assert.deepEqual(linhaCrua(dir, 'shopee').segredos, { chave: CHAVE }, 'guardou a chave no banco');

      const get = await api('/conexoes'); respostas.push(get);
      const shopee = get.json.find((p) => p.id === 'shopee');
      assert.deepEqual(shopee.segredos_salvos, ['chave']);
      assert.deepEqual(shopee.config, { app_id: '123456' });
      assert.equal(shopee.estado, 'nao_implementada');

      respostas.push(await api('/conexoes/shopee/testar', { method: 'POST', body: {} }));
      respostas.push(await api('/conexoes/mercadolivre/testar', { method: 'POST', body: {} }));
      // 400 de validação com a chave salva no corpo (AppID inválido): nada é gravado e nada ecoa
      const invalido = await api('/conexoes/shopee', { method: 'PUT', body: { campos: { app_id: 'abc', chave: CHAVE_NOVA } } });
      respostas.push(invalido);
      assert.equal(invalido.status, 400);
      assert.deepEqual(linhaCrua(dir, 'shopee').segredos, { chave: CHAVE }, 'com erro, a chave nova não foi gravada');
      // 400 com a própria chave inválida (tem espaço): o valor recusado também não ecoa
      const chaveRuim = `${CHAVE_NOVA} com espaço`;
      const recusada = await api('/conexoes/shopee', { method: 'PUT', body: { campos: { chave: chaveRuim } } });
      respostas.push(recusada);
      assert.equal(recusada.status, 400);
      assert.match(recusada.json.erro, /^Chave secreta: formato inválido/);
      assert.deepEqual(recusada.json.erros, [{ campo: 'chave', msg: recusada.json.erro }]);
      // JSON malformado com a chave dentro
      const malformado = await api('/conexoes/shopee', { method: 'PUT', body: `{"campos":{"chave":${CHAVE}}}` });
      respostas.push(malformado);
      assert.equal(malformado.status, 400);
      // troca de verdade: a resposta continua sem a chave nova
      const troca = await api('/conexoes/shopee', { method: 'PUT', body: { campos: { chave: CHAVE_NOVA } } });
      respostas.push(troca);
      assert.equal(troca.status, 200);
      assert.deepEqual(linhaCrua(dir, 'shopee').segredos, { chave: CHAVE_NOVA }, 'segredo com valor substitui');
      respostas.push(await api('/conexoes'));

      for (const r of respostas) {
        for (const s of [CHAVE, CHAVE_NOVA]) assert.ok(!r.txt.includes(s), `resposta ${r.status} não contém o segredo: ${r.txt.slice(0, 120)}`);
      }
      const log = JSON.stringify(db.prepare('SELECT * FROM log').all());
      for (const s of [CHAVE, CHAVE_NOVA]) assert.ok(!log.includes(s), 'segredo fora da tabela log');
    });
  } finally { Object.assign(console, originais); }
  for (const s of [CHAVE, CHAVE_NOVA]) assert.ok(!saidas.some((l) => l.includes(s)), 'segredo fora do console');
});

test('PUT com segredo vazio ou ausente mantém o salvo; texto vazio apaga o campo', async () => {
  await comSessao(async ({ api, dir }) => {
    assert.equal((await api('/conexoes/shopee', { method: 'PUT', body: { campos: { app_id: '111', chave: CHAVE } } })).status, 200);
    const antes = linhaCrua(dir, 'shopee');

    const vazio = await api('/conexoes/shopee', { method: 'PUT', body: { campos: { app_id: '222', chave: '' } } });
    assert.equal(vazio.status, 200, vazio.txt);
    assert.deepEqual(vazio.json.segredos_salvos, ['chave'], 'continua salva');
    let cru = linhaCrua(dir, 'shopee');
    assert.deepEqual(cru.segredos, { chave: CHAVE }, 'vazio não apaga');
    assert.deepEqual(cru.config, { app_id: '222' });
    assert.ok(cru.updated_at >= antes.updated_at);

    const espacos = await api('/conexoes/shopee', { method: 'PUT', body: { campos: { chave: '   ', app_id: '333' } } });
    assert.equal(espacos.status, 200);
    assert.deepEqual(linhaCrua(dir, 'shopee').segredos, { chave: CHAVE }, 'só espaços conta como vazio');

    const ausente = await api('/conexoes/shopee', { method: 'PUT', body: { campos: { app_id: '444' } } });
    assert.equal(ausente.status, 200);
    assert.deepEqual(linhaCrua(dir, 'shopee').segredos, { chave: CHAVE }, 'ausente não apaga');

    const nulo = await api('/conexoes/shopee', { method: 'PUT', body: { campos: { chave: null } } });
    assert.equal(nulo.status, 200);
    assert.deepEqual(linhaCrua(dir, 'shopee').segredos, { chave: CHAVE }, 'null não apaga');

    const apaga = await api('/conexoes/shopee', { method: 'PUT', body: { campos: { app_id: '' } } });
    assert.equal(apaga.status, 200);
    assert.deepEqual(apaga.json.config, {}, 'texto vazio apaga o campo');
    cru = linhaCrua(dir, 'shopee');
    assert.deepEqual(cru.config, {}); assert.deepEqual(cru.segredos, { chave: CHAVE });
  });
});

test('PUT descarta campo fora do registro (inclusive segredo de outra loja e chaves de protótipo)', async () => {
  await comSessao(async ({ api, dir }) => {
    const corpo = `{"campos":{"tag":"meunome-20","extra":"x","chave":"${CHAVE}","__proto__":{"admin":true},"constructor":"y"},"outro":1}`;
    const r = await api('/conexoes/amazon', { method: 'PUT', body: corpo });
    assert.equal(r.status, 200, r.txt);
    assert.deepEqual(r.json.config, { tag: 'meunome-20' });
    assert.deepEqual(r.json.segredos_salvos, [], 'Amazon não tem segredo: a "chave" foi descartada');
    assert.ok(!r.txt.includes(CHAVE));
    const cru = linhaCrua(dir, 'amazon');
    assert.deepEqual(cru.config, { tag: 'meunome-20' });
    assert.deepEqual(cru.segredos, {});
    assert.equal(({}).admin, undefined, 'nenhuma poluição de protótipo');

    const soEstranhos = await api('/conexoes/magalu', { method: 'PUT', body: { campos: { qualquer: 'coisa' } } });
    assert.equal(soEstranhos.status, 200, 'nada reconhecido: nada a gravar');
    assert.equal(linhaCrua(dir, 'magalu'), null, 'não criou linha');
  });
});

test('PUT valida padrão, tamanho e tipo (400, nada gravado) e recusa corpo sem campos', async () => {
  await comSessao(async ({ api, dir }) => {
    const casos = [
      [{ tag: 'com espaço' }, /^Tag de associado: formato inválido\. Ex\.: seunome-20$/],
      [{ tag: 'a'.repeat(65) }, /^Tag de associado: até 64 caracteres\.$/],
      [{ tag: { $ne: 1 } }, /^Tag de associado: valor inválido\.$/],
      [{ tag: ['x'] }, /^Tag de associado: valor inválido\.$/],
    ];
    for (const [campos, erro] of casos) {
      const r = await api('/conexoes/amazon', { method: 'PUT', body: { campos } });
      assert.equal(r.status, 400, JSON.stringify(campos));
      assert.match(r.json.erro, erro);
      assert.equal(r.json.erros[0].campo, 'tag');
    }
    assert.equal(linhaCrua(dir, 'amazon'), null, 'nada gravado');

    const doisErros = await api('/conexoes/shopee', { method: 'PUT', body: { campos: { app_id: '12a', chave: 'curta' } } });
    assert.equal(doisErros.status, 400);
    assert.deepEqual(doisErros.json.erros.map((e) => e.campo), ['app_id', 'chave'], 'todos os erros de uma vez');
    assert.equal(linhaCrua(dir, 'shopee'), null, 'tudo ou nada');

    const numero = await api('/conexoes/shopee', { method: 'PUT', body: { campos: { app_id: 98765 } } });
    assert.equal(numero.status, 200, 'AppID numérico aceito como texto');
    assert.deepEqual(numero.json.config, { app_id: '98765' });

    for (const corpo of [{}, { campos: 'tag=x' }, { campos: ['x'] }, { campos: null }]) {
      const r = await api('/conexoes/amazon', { method: 'PUT', body: corpo });
      assert.equal(r.status, 400, JSON.stringify(corpo)); assert.equal(r.json.erro, 'Envie os campos da conexão.');
    }
    const ml = await api('/conexoes/mercadolivre', { method: 'PUT', body: { campos: { etiqueta: 'minhaetq' } } });
    assert.equal(ml.status, 400); assert.match(ml.json.erro, /Etiquetas de afiliado/);
    const fb = await api('/conexoes/facebook', { method: 'PUT', body: { campos: { qualquer: 'x' } } });
    assert.equal(fb.status, 400); assert.match(fb.json.erro, /Facebook ainda não tem dados para guardar/);
  });
});

test('id desconhecido (inclusive constructor e __proto__) responde 404 no PUT e no testar', async () => {
  await comSessao(async ({ api, dir }) => {
    for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'nao-existe', 'MercadoLivre']) {
      const put = await api(`/conexoes/${encodeURIComponent(id)}`, { method: 'PUT', body: { campos: { tag: 'abc' } } });
      assert.equal(put.status, 404, `PUT ${id}`); assert.deepEqual(put.json, { erro: 'Conexão desconhecida.' });
      const t = await api(`/conexoes/${encodeURIComponent(id)}/testar`, { method: 'POST', body: {} });
      assert.equal(t.status, 404, `testar ${id}`);
    }
    const db = new DatabaseSync(path.join(dir, 'disparador.db'));
    try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM conexoes').get().n, 0); } finally { db.close(); }
  });
});

test('testar: lojas não implementadas dizem isso (nunca sucesso falso)', async () => {
  await comSessao(async ({ api }) => {
    await api('/conexoes/amazon', { method: 'PUT', body: { campos: { tag: 'meunome-20' } } });
    const amazon = await api('/conexoes/amazon/testar', { method: 'POST', body: {} });
    assert.equal(amazon.status, 200);
    assert.deepEqual(amazon.json, { ok: false, mensagem: 'Amazon ainda não está implementada. Os dados ficam salvos para quando a integração existir.' });
    for (const id of ['shopee', 'magalu', 'facebook']) {
      const r = await api(`/conexoes/${id}/testar`, { method: 'POST', body: {} });
      assert.equal(r.json.ok, false, id); assert.match(r.json.mensagem, /não está implementada/, id);
    }
  });
});

test('testar Mercado Livre (links em modo fake): ok coerente com etiqueta, extensão e modo de link', async () => {
  await comSessao(async ({ api, links, db }) => {
    const testar = async () => (await api('/conexoes/mercadolivre/testar', { method: 'POST', body: {} })).json;
    const estado = async () => (await api('/conexoes')).json.find((p) => p.id === 'mercadolivre');

    let t = await testar();
    assert.equal(t.ok, false);
    assert.match(t.mensagem, /Nenhuma etiqueta/); assert.match(t.mensagem, /Extensão do Chrome desconectada/);
    assert.equal((await estado()).estado, 'falta_configurar');

    assert.equal((await api('/tags', { method: 'POST', body: { name: 'minhaetq' } })).status, 200);
    t = await testar();
    assert.equal(t.ok, false, 'etiqueta sem extensão ainda não está conectada');
    assert.doesNotMatch(t.mensagem, /Nenhuma etiqueta/); assert.match(t.mensagem, /Extensão do Chrome desconectada/);
    assert.deepEqual((await estado()).config, { etiquetas: ['minhaetq'] });

    await links.poll(1); // a extensão acabou de buscar pedidos: fica online
    assert.equal((await api('/state')).json.extensao.online, true);
    t = await testar();
    assert.deepEqual(t, { ok: true, mensagem: 'Tudo certo: 1 etiqueta cadastrada e a extensão do Chrome conectada.' });
    assert.equal((await estado()).estado, 'conectado');

    setSetting(db, 'link_mode', 'direct');
    t = await testar();
    assert.equal(t.ok, false, 'modo direto não gera comissão: não é sucesso');
    assert.match(t.mensagem, /Modo direto/);
    assert.equal((await estado()).estado, 'falta_configurar');

    // o "ok" do testar e o estado do GET sempre andam juntos
    setSetting(db, 'link_mode', 'extension');
    assert.equal((await testar()).ok, (await estado()).estado === 'conectado');
  });
});
