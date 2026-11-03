// Testes de Conexões (plano disparos-comunicacao-conta, etapa 10; CA6 e CA10): campos do registro, segredo que
// nunca volta ao navegador, vazio mantém o salvo, campo estranho descartado, validação, 404 e "Testar".
// Amazon (plano espelhamento-amazon, etapa 7; CA2 e CA7): 4 estados, situação da API, "Testar" real com um fetch
// falso injetado no cliente único do servidor (criarServicos; nada sai para a rede) e o ID, o segredo e o token
// nunca no texto cru das respostas.
// Shopee (plano integracao-shopee, etapa 6; CA5 e CA6): 6 estados e extensao_online, AppID igual ao ID de afiliado
// recusado sem gravar, "Testar" real por código (createShopee com fetch falso) e a Senha da API e a assinatura
// nunca no texto cru das respostas, no log nem no console.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { openDb, setSetting } from '../src/db.js';
import express from 'express';
import { createConexoes, segredosDe, montarRotas } from '../src/conexoes.js';
import { ErroAmazon, MENSAGENS_AMAZON, URL_GET_ITEMS, ASIN_TESTE } from '../src/amazon.js';
import { createShopee, ErroShopee, MENSAGENS_SHOPEE, FRASES_TESTE_SHOPEE, URL_API as URL_API_SHOPEE } from '../src/shopee.js';
import { buildApp, criarServicos } from '../src/server.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createLinkService } from '../src/links.js';
import { PLATAFORMAS } from '../src/lojas.js';

const SENHA = 'senha-de-teste-123';
const CHAVE = 'Chave-Shopee-SECRETA-9f8e7d6c';       // segredo salvo
const CHAVE_NOVA = 'Outra-Chave-SECRETA-1a2b3c4d';   // troca do segredo
const ORDEM = ['mercadolivre', 'amazon', 'shopee', 'magalu', 'facebook'];

/** fetch padrão do cliente da Amazon nos testes: nenhuma chamada sai para a rede. */
const redeProibida = async () => { throw new Error('rede proibida no teste'); };

/** Sobe pelo mesmo caminho do servidor de verdade (criarServicos + buildApp); `fetch` é o da Amazon. */
function subir({ fetch = redeProibida } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-cx-'));
  const db = openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const { amazon, scheduler } = criarServicos({ db, wa, links, fast: true, dir, fetch });
  const app = buildApp({ db, wa, links, scheduler, amazon, panelPassword: SENHA, dataDir: dir });
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
async function comSessao(fn, opts = {}) {
  const s = await subir(opts);
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
    assert.deepEqual(porId.shopee.campos.map((c) => [c.nome, c.tipo]), [['id_afiliado', 'texto'], ['app_id', 'texto'], ['chave', 'segredo']]);
    assert.equal(porId.shopee.implementada, true);
    assert.equal(porId.shopee.estado, 'falta_configurar', 'Shopee sem ID de afiliado');
    assert.equal(porId.shopee.situacao.acesso, 'nao_configurada');
    assert.equal(porId.shopee.extensao_online, false);
    assert.deepEqual(porId.shopee.config, {});
    assert.deepEqual(porId.amazon.campos.map((c) => [c.nome, c.tipo]),
      [['tag', 'texto'], ['credencial_id', 'segredo'], ['credencial_secret', 'segredo'], ['credencial_versao', 'texto']]);
    assert.equal(porId.amazon.implementada, true);
    assert.equal(porId.amazon.estado, 'falta_configurar', 'Amazon sem tag');
    assert.deepEqual(porId.amazon.config, {});
    assert.deepEqual(porId.amazon.situacao, { acesso: 'nao_configurada', verificado_em: null, motivo: MENSAGENS_AMAZON.sem_credenciais });
    assert.equal(porId.amazon.espelhos_ativos, 0);
    assert.deepEqual(porId.magalu.campos.map((c) => c.nome), ['loja']);
    assert.deepEqual(porId.facebook.campos, [], 'Facebook não tem campos');
    assert.deepEqual(porId.mercadolivre.campos, [], 'ML: a configuração são as etiquetas, não um campo daqui');
    assert.deepEqual(porId.mercadolivre.config, { etiquetas: [] });
    assert.equal(porId.mercadolivre.estado, 'falta_configurar', 'sem etiqueta e sem extensão');
    for (const id of ['magalu', 'facebook']) {
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
      assert.equal(shopee.estado, 'pronta', 'AppID e Senha sem ID de afiliado: credenciais salvas (a linha avisa do ID)');

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
      assert.match(recusada.json.erro, /^Senha da API: formato inválido/);
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
      [{ tag: 'com espaço' }, /^Tag de associado: formato inválido\. Ex\.: seunome-20\. Todo link enviado leva esta tag\.$/],
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
    assert.equal((await api('/conexoes/magalu', { method: 'PUT', body: { campos: { loja: 'minhaloja' } } })).status, 200);
    const magalu = await api('/conexoes/magalu/testar', { method: 'POST', body: {} });
    assert.equal(magalu.status, 200);
    assert.deepEqual(magalu.json, { ok: false, mensagem: 'Magalu ainda não está implementada. Os dados ficam salvos para quando a integração existir.' });
    for (const id of ['magalu', 'facebook']) {
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

// ------------------------------------------------------------------ Amazon (plano espelhamento-amazon, etapa 7)

const ID_AMZ = 'amzn1.application-oa2-client.IDSECRETO0123456789';
const SEGREDO_AMZ = 'SEGREDO-Super-Secreto-xyz789!';
const SEGREDO_AMZ_NOVO = 'OUTRO-Segredo-Trocado-456#';
const TOKEN_AMZ = 'Atza|TOKEN-ULTRA-SECRETO-abc123';
const VALORES_SECRETOS = [ID_AMZ, SEGREDO_AMZ, SEGREDO_AMZ_NOVO, TOKEN_AMZ, 'IDSECRETO', 'Super-Secreto', 'Segredo-Trocado', 'ULTRA-SECRETO'];
const URL_TOKEN_NA = 'https://api.amazon.com/auth/o2/token';
const IMG_AMZ = 'https://m.media-amazon.com/images/I/71abcDEF12L._AC_SL1500_.jpg';

const jsonResp = (status, corpo, headers = {}) => new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json', ...headers } });

/**
 * API da Amazon falsa, injetada no cliente único do servidor (subir({ fetch })). `modo.token` e `modo.items`
 * escolhem a resposta. As respostas de erro ecoam o ID, o segredo e o token de propósito: nada disso pode chegar
 * ao painel.
 */
function apiAmazonFalsa() {
  const modo = { token: 200, items: 200 };
  const chamadas = [];
  const fetch = async (url, init = {}) => {
    const u = String(url);
    chamadas.push({ url: u, corpo: String(init.body ?? '') });
    if (u === URL_TOKEN_NA) {
      if (modo.token === 200) return jsonResp(200, { access_token: TOKEN_AMZ, token_type: 'bearer', expires_in: 3600 });
      if (modo.token === 429) return jsonResp(429, { error: 'too_many_requests' }, { 'retry-after': '30' });
      return jsonResp(modo.token, { error: 'invalid_client', error_description: `client ${ID_AMZ} / ${SEGREDO_AMZ} recusado` });
    }
    if (u === URL_GET_ITEMS) {
      if (modo.items === 200) {
        return jsonResp(200, { itemsResult: { items: [{ asin: ASIN_TESTE, itemInfo: { title: { displayValue: 'Roteador' } },
          images: { primary: { large: { url: IMG_AMZ } } },
          offersV2: { listings: [{ isBuyBoxWinner: true, price: { money: { amount: 100 }, savingBasis: { money: { amount: 150 } }, savings: { percentage: 33 } } }] } }] } });
      }
      if (modo.items === 403) return jsonResp(403, { __type: 'AccessDeniedException', reason: 'AssociateNotEligible', message: `Bearer ${TOKEN_AMZ} sem acesso` });
      if (modo.items === 400) return jsonResp(400, { errors: [{ code: 'InvalidPartnerTag', message: `tag recusada para ${ID_AMZ} ${TOKEN_AMZ}` }] });
      return jsonResp(modo.items, { message: `falha ${TOKEN_AMZ}` });
    }
    throw new Error('rede inesperada no teste');
  };
  return { modo, chamadas, fetch };
}

test('Amazon em Conexões: 4 estados, "Testar" real (fetch falso) e ID, segredo e token nunca no texto cru das respostas, no log nem no console', async (t) => {
  const api_ = apiAmazonFalsa();
  // o "Testar" passa pelo cliente único do servidor, com o fetch injetado: o global nunca é chamado
  const global_ = t.mock.method(globalThis, 'fetch', async () => { throw new Error('fetch global no teste'); });
  const saidas = [];
  const originais = {};
  for (const m of ['log', 'info', 'warn', 'error']) { originais[m] = console[m]; console[m] = (...a) => { saidas.push(a.map(String).join(' ')); originais[m](...a); }; }
  try {
    await comSessao(async ({ api, db, dir }) => {
      const respostas = [];
      const chamar = async (caminho, opts) => { const r = await api(caminho, opts); respostas.push(r); return r; };
      const amazon = async () => (await chamar('/conexoes')).json.find((p) => p.id === 'amazon');
      const testar = async () => { const r = await chamar('/conexoes/amazon/testar', { method: 'POST', body: {} }); assert.equal(r.status, 200, r.txt); return r.json; };

      assert.equal((await amazon()).estado, 'falta_configurar');
      // sem credencial o teste nem chama a Amazon
      assert.deepEqual(await testar(), { ok: false, resultado: 'nao_configurada', mensagem: 'Preencha o ID e o segredo da credencial e salve antes de testar.', campos: [] });
      assert.equal(api_.chamadas.length, 0);

      let r = await chamar('/conexoes/amazon', { method: 'PUT', body: { campos: { tag: 'dono-20' } } });
      assert.equal(r.status, 200, r.txt);
      assert.equal(r.json.estado, 'so_tag', 'tag sem credencial: dados do texto da origem');
      assert.deepEqual(r.json.config, { tag: 'dono-20' });

      r = await chamar('/conexoes/amazon', { method: 'PUT', body: { campos: { credencial_id: ID_AMZ, credencial_secret: SEGREDO_AMZ, credencial_versao: '3.1' } } });
      assert.equal(r.status, 200, r.txt);
      assert.equal(r.json.estado, 'pronta', 'tag e credencial, API ainda não confirmada');
      assert.deepEqual(r.json.config, { tag: 'dono-20', credencial_versao: '3.1' }, 'a tag e a versão são texto');
      assert.deepEqual(r.json.segredos_salvos, ['credencial_id', 'credencial_secret']);
      assert.deepEqual(r.json.situacao, { acesso: 'desconhecido', verificado_em: null, motivo: null });
      assert.deepEqual(linhaCrua(dir, 'amazon').segredos, { credencial_id: ID_AMZ, credencial_secret: SEGREDO_AMZ }, 'só o ID e o segredo são segredo');

      // teste de verdade: token (com o ID e o segredo salvos) e GetItems do ASIN de teste com a tag
      let res = await testar();
      assert.deepEqual(res, { ok: true, resultado: 'ok', mensagem: 'Credencial aceita pela Amazon.', campos: ['title', 'price', 'oldPrice', 'discountPct', 'image'] });
      assert.deepEqual(api_.chamadas.map((c) => c.url), [URL_TOKEN_NA, URL_GET_ITEMS]);
      assert.equal(JSON.parse(api_.chamadas[0].corpo).client_secret, SEGREDO_AMZ, 'o segredo salvo foi usado no token');
      assert.equal(JSON.parse(api_.chamadas[1].corpo).partnerTag, 'dono-20');
      const conectada = await amazon();
      assert.equal(conectada.estado, 'conectada');
      assert.equal(conectada.situacao.acesso, 'ok');
      assert.equal(typeof conectada.situacao.verificado_em, 'number');

      // trocar o segredo esquece o token e a verificação: volta a "pronta"
      r = await chamar('/conexoes/amazon', { method: 'PUT', body: { campos: { credencial_secret: SEGREDO_AMZ_NOVO } } });
      assert.equal(r.status, 200);
      assert.equal(r.json.estado, 'pronta');
      assert.deepEqual(linhaCrua(dir, 'amazon').segredos, { credencial_id: ID_AMZ, credencial_secret: SEGREDO_AMZ_NOVO });

      api_.modo.token = 401;
      res = await testar();
      assert.deepEqual(res, { ok: false, resultado: 'recusada', mensagem: 'A Amazon não aceitou a credencial. Confira o ID e o segredo e se a credencial está ativa.', campos: [] });
      assert.equal((await amazon()).situacao.acesso, 'credenciais_invalidas');

      api_.modo.token = 200; api_.modo.items = 403;
      res = await testar();
      assert.deepEqual(res, { ok: false, resultado: 'sem_acesso', mensagem: 'A credencial é válida, mas a conta ainda não tem acesso à API. Confira se há vendas qualificadas nos últimos 30 dias.', campos: [] });
      const semAcesso = await amazon();
      assert.equal(semAcesso.estado, 'pronta');
      assert.deepEqual({ acesso: semAcesso.situacao.acesso, motivo: semAcesso.situacao.motivo }, { acesso: 'sem_acesso', motivo: MENSAGENS_AMAZON.sem_acesso });

      api_.modo.items = 400;
      res = await testar();
      assert.deepEqual(res, { ok: false, resultado: 'tag_invalida', mensagem: 'A tag não pertence a esta credencial/loja.', campos: [] });

      api_.modo.token = 429;
      res = await testar();
      assert.deepEqual(res, { ok: false, resultado: 'indisponivel', mensagem: 'A Amazon não respondeu agora. Tente de novo em alguns minutos.', campos: [] });

      // validação: o valor recusado não ecoa e nada é gravado
      const casos = [
        [{ credencial_id: `${ID_AMZ} com espaço` }, 'credencial_id', /^ID da credencial: formato inválido\. Confira se copiou o valor inteiro, sem espaços\.$/],
        [{ credencial_secret: `${SEGREDO_AMZ} com espaço` }, 'credencial_secret', /^Segredo da credencial: formato inválido\. Confira se copiou o valor inteiro, sem espaços\.$/],
        [{ credencial_secret: `${SEGREDO_AMZ}${'x'.repeat(300)}` }, 'credencial_secret', /^Segredo da credencial: até 256 caracteres\.$/],
        [{ credencial_versao: '3.9' }, 'credencial_versao', /^Versão da credencial: formato inválido\. Versão que veio com a credencial; Brasil: 3\.1$/],
      ];
      for (const [campos, campo, erro] of casos) {
        const inv = await chamar('/conexoes/amazon', { method: 'PUT', body: { campos } });
        assert.equal(inv.status, 400, campo); assert.match(inv.json.erro, erro); assert.equal(inv.json.erros[0].campo, campo);
      }
      respostas.push(await api('/conexoes/amazon', { method: 'PUT', body: `{"campos":{"credencial_secret":${SEGREDO_AMZ}}}` }));
      assert.deepEqual(linhaCrua(dir, 'amazon').segredos, { credencial_id: ID_AMZ, credencial_secret: SEGREDO_AMZ_NOVO }, 'nada gravado com erro');
      respostas.push(await api('/state'));
      await amazon();

      assert.ok(respostas.length >= 15);
      for (const resp of respostas) {
        for (const s of VALORES_SECRETOS) assert.ok(!resp.txt.includes(s), `resposta ${resp.status} sem "${s}": ${resp.txt.slice(0, 160)}`);
      }
      const log = JSON.stringify(db.prepare('SELECT * FROM log').all());
      for (const s of VALORES_SECRETOS) assert.ok(!log.includes(s), `"${s}" fora da tabela log`);
    }, { fetch: api_.fetch });
  } finally { Object.assign(console, originais); }
  for (const s of VALORES_SECRETOS) assert.ok(!saidas.some((l) => l.includes(s)), `"${s}" fora do console`);
  assert.ok(api_.chamadas.every((c) => c.url === URL_TOKEN_NA || c.url === URL_GET_ITEMS), 'só os hosts fixos da API');
  assert.equal(global_.mock.callCount(), 0, 'nada passou pelo fetch global');
});

/** Banco temporário + createConexoes com um amazon falso. */
function montarUnidade(t, amazon) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-cx-u-'));
  const db = openDb(dir);
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { db, conexoes: createConexoes({ db, links: undefined, amazon }) };
}

function amazonStub({ testar = async () => ({ ok: true, resultado: 'ok', mensagem: 'x', campos: [] }), situacao } = {}) {
  const s = { invalidacoes: 0, testes: 0 };
  s.testar = async () => { s.testes++; return testar(); };
  s.situacao = situacao ?? (() => ({ acesso: 'desconhecido', verificado_em: null, motivo: null }));
  s.invalidarToken = () => { s.invalidacoes++; };
  return s;
}

const salvarAmazon = (conexoes, campos) => conexoes.salvar('amazon', { campos }, true);
const CRED = { tag: 'dono-20', credencial_id: ID_AMZ, credencial_secret: SEGREDO_AMZ };

test('Amazon testar traduz cada ErroAmazon numa frase fixa (nunca a mensagem do erro)', async (t) => {
  const esperado = {
    sem_credenciais: ['nao_configurada', 'Preencha o ID e o segredo da credencial e salve antes de testar.'],
    sem_tag: ['nao_configurada', 'Falta a tag de associado da Amazon em Conexões.'],
    credenciais_invalidas: ['recusada', 'A Amazon não aceitou a credencial. Confira o ID e o segredo e se a credencial está ativa.'],
    sem_acesso: ['sem_acesso', 'A credencial é válida, mas a conta ainda não tem acesso à API. Confira se há vendas qualificadas nos últimos 30 dias.'],
    tag_invalida: ['tag_invalida', 'A tag não pertence a esta credencial/loja.'],
    cota: ['indisponivel', 'A Amazon não respondeu agora. Tente de novo em alguns minutos.'],
    nao_encontrado: ['indisponivel', 'A Amazon não respondeu agora. Tente de novo em alguns minutos.'],
    indisponivel: ['indisponivel', 'A Amazon não respondeu agora. Tente de novo em alguns minutos.'],
  };
  assert.deepEqual(Object.keys(esperado).sort(), Object.keys(MENSAGENS_AMAZON).sort(), 'todo tipo de ErroAmazon tem tradução');
  let erro;
  const stub = amazonStub({ testar: async () => { throw erro; } });
  const { conexoes } = montarUnidade(t, stub);
  for (const [tipo, [resultado, mensagem]] of Object.entries(esperado)) {
    erro = new ErroAmazon(tipo, { status: 400 });
    erro.message = `${erro.message} ${SEGREDO_AMZ} ${TOKEN_AMZ}`; // mesmo com segredo na mensagem, a resposta é a frase fixa
    assert.deepEqual(await conexoes.testar('amazon'), { ok: false, resultado, mensagem, campos: [] }, tipo);
  }
  // erro que não é da Amazon: indisponível, e o console só leva o nome do erro
  const saidas = [];
  t.mock.method(console, 'error', (...a) => saidas.push(a.map(String).join(' ')));
  erro = new TypeError(`quebrou com ${ID_AMZ} e ${SEGREDO_AMZ}`);
  assert.deepEqual(await conexoes.testar('amazon'), { ok: false, resultado: 'indisponivel', mensagem: esperado.indisponivel[1], campos: [] });
  assert.deepEqual(saidas, ['[conexões] teste da Amazon falhou: TypeError']);
  assert.equal(stub.testes, 9);
});

test('Amazon testar só repassa resultado conhecido, frases fixas e nomes de campo da lista', async (t) => {
  let volta;
  const { conexoes } = montarUnidade(t, amazonStub({ testar: async () => volta }));
  const casos = [
    [{ ok: true, resultado: 'ok', mensagem: `vazou ${SEGREDO_AMZ}`, campos: ['title', 'token', SEGREDO_AMZ, 'image'], token: TOKEN_AMZ },
      { ok: true, resultado: 'ok', mensagem: 'Credencial aceita pela Amazon. Cadastre a tag de associado para conferir o acesso à API.', campos: ['title', 'image'] }],
    [{ ok: true, resultado: 'sem_acesso' }, { ok: false, resultado: 'sem_acesso', mensagem: MENSAGENS_AMAZON.sem_acesso, campos: [] }],
    [{ ok: false, resultado: 'ok' }, { ok: false, resultado: 'indisponivel', mensagem: MENSAGENS_AMAZON.indisponivel, campos: [] }],
    [{ ok: true, resultado: 'conectadissima' }, { ok: false, resultado: 'indisponivel', mensagem: MENSAGENS_AMAZON.indisponivel, campos: [] }],
    [{ ok: true, resultado: '__proto__' }, { ok: false, resultado: 'indisponivel', mensagem: MENSAGENS_AMAZON.indisponivel, campos: [] }],
    [null, { ok: false, resultado: 'indisponivel', mensagem: MENSAGENS_AMAZON.indisponivel, campos: [] }],
    [{ ok: 'true', resultado: 'ok', campos: 'title' }, { ok: false, resultado: 'indisponivel', mensagem: MENSAGENS_AMAZON.indisponivel, campos: [] }],
  ];
  for (const [vindo, saida] of casos) { volta = vindo; assert.deepEqual(await conexoes.testar('amazon'), saida, JSON.stringify(vindo)); }
  // com a tag salva, o sucesso não pede a tag
  salvarAmazon(conexoes, { tag: 'dono-20' });
  volta = { ok: true, resultado: 'ok', campos: [] };
  assert.deepEqual(await conexoes.testar('amazon'), { ok: true, resultado: 'ok', mensagem: 'Credencial aceita pela Amazon.', campos: [] });
});

test('Amazon sem o serviço injetado: testar diz que não está disponível e o cartão não quebra', async (t) => {
  const { conexoes } = montarUnidade(t, undefined);
  assert.deepEqual(await conexoes.testar('amazon'), { ok: false, resultado: 'indisponivel', mensagem: 'O teste da Amazon não está disponível agora.', campos: [] });
  salvarAmazon(conexoes, CRED);
  const cartao = conexoes.listar(true).find((p) => p.id === 'amazon');
  assert.equal(cartao.estado, 'pronta');
  assert.deepEqual(cartao.situacao, { acesso: 'desconhecido', verificado_em: null, motivo: null });
});

test('Amazon: estado pela tag, pela credencial e pela situação; situação só com campos conhecidos; salvar invalida o token', async (t) => {
  let sit = { acesso: 'desconhecido', verificado_em: null, motivo: null };
  const stub = amazonStub({ situacao: () => sit });
  const { conexoes } = montarUnidade(t, stub);
  const cartao = (verSegredos = true) => conexoes.listar(verSegredos).find((p) => p.id === 'amazon');

  assert.equal(cartao().estado, 'falta_configurar');
  // credencial sem tag continua "falta configurar": sem tag o espelhamento não liga (CA2)
  salvarAmazon(conexoes, { credencial_id: ID_AMZ, credencial_secret: SEGREDO_AMZ });
  assert.equal(stub.invalidacoes, 1);
  sit = { acesso: 'ok', verificado_em: 5, motivo: null };
  assert.equal(cartao().estado, 'falta_configurar');
  salvarAmazon(conexoes, { tag: 'dono-20' });
  assert.equal(cartao().estado, 'conectada');
  sit = { acesso: 'sem_acesso', verificado_em: 6, motivo: MENSAGENS_AMAZON.sem_acesso };
  assert.equal(cartao().estado, 'pronta');
  conexoes.salvar('amazon', { campos: { credencial_id: '' } }, true); // ID vazio mantém o salvo
  assert.deepEqual(cartao().segredos_salvos, ['credencial_id', 'credencial_secret']);

  // situação vinda do serviço: só acesso conhecido, número e frase fixa
  sit = { acesso: 'ok', verificado_em: 123, motivo: `vazou ${TOKEN_AMZ}`, impressao: 'abc', token: TOKEN_AMZ };
  assert.deepEqual(cartao().situacao, { acesso: 'ok', verificado_em: 123, motivo: null });
  sit = { acesso: 'hackeado', verificado_em: '123', motivo: MENSAGENS_AMAZON.cota };
  assert.deepEqual(cartao().situacao, { acesso: 'desconhecido', verificado_em: null, motivo: MENSAGENS_AMAZON.cota });
  assert.equal(cartao().estado, 'pronta');
  // Operador também vê o estado e a situação, mas não os nomes dos segredos
  const op = cartao(false);
  assert.ok(!('segredos_salvos' in op)); assert.equal(op.estado, 'pronta'); assert.ok(op.situacao);
  assert.ok(!JSON.stringify(conexoes.listar(true)).includes(SEGREDO_AMZ));

  // invalidação: só quando algo da Amazon foi gravado
  const antes = stub.invalidacoes;
  conexoes.salvar('shopee', { campos: { app_id: '123' } }, true);
  conexoes.salvar('amazon', { campos: { qualquer: 'x' } }, true);
  assert.throws(() => conexoes.salvar('amazon', { campos: { credencial_versao: '9.9' } }, true), /formato inválido/);
  assert.equal(stub.invalidacoes, antes, 'nada gravado na Amazon: o token continua');
  conexoes.salvar('amazon', { campos: { credencial_versao: '3.1' } }, true);
  assert.equal(stub.invalidacoes, antes + 1);
});

test('Amazon: sem credencial completa é "só com a tag" e o cartão conta os espelhamentos ligados', async (t) => {
  const { db, conexoes } = montarUnidade(t, amazonStub());
  const cartao = () => conexoes.listar(true).find((p) => p.id === 'amazon');
  salvarAmazon(conexoes, { tag: 'dono-20', credencial_id: ID_AMZ });
  assert.equal(cartao().estado, 'so_tag', 'ID sem o segredo não é credencial');
  assert.equal(cartao().espelhos_ativos, 0);
  const inserir = db.prepare('INSERT INTO espelhos (nome, enabled) VALUES (?, ?)');
  inserir.run('Ofertas A', 1); inserir.run('Ofertas B', 0); inserir.run('Ofertas C', 1);
  assert.equal(cartao().espelhos_ativos, 2);
  assert.ok(!('espelhos_ativos' in conexoes.listar(true).find((p) => p.id === 'shopee')), 'só o cartão da Amazon');
});

test('segredosDe: só os campos do registro, só texto não vazio; linha corrompida não quebra; id desconhecido recusado', async (t) => {
  const { db, conexoes } = montarUnidade(t, amazonStub());
  assert.deepEqual(segredosDe(db, 'amazon'), {}, 'sem linha');
  salvarAmazon(conexoes, { ...CRED, credencial_versao: '3.2' });
  assert.deepEqual(segredosDe(db, 'amazon'), { ...CRED, credencial_versao: '3.2' });
  db.prepare("UPDATE conexoes SET segredos = json_set(segredos, '$.outro', 'x', '$.credencial_id', 7) WHERE plataforma = 'amazon'").run();
  assert.deepEqual(segredosDe(db, 'amazon'), { tag: 'dono-20', credencial_secret: SEGREDO_AMZ, credencial_versao: '3.2' }, 'fora do registro e não-texto ficam de fora');
  db.prepare("UPDATE conexoes SET segredos = 'não é json' WHERE plataforma = 'amazon'").run();
  assert.deepEqual(segredosDe(db, 'amazon'), { tag: 'dono-20', credencial_versao: '3.2' });
  for (const id of ['constructor', '__proto__', 'x']) assert.throws(() => segredosDe(db, id), /Conexão desconhecida/);
});

// ------------------------------------------------------------------ Shopee (plano integracao-shopee, etapa 6)

const ID_SHP = '98765432101';
const APP_SHP = '123456789';
const SENHA_SHP = 'Senha-API-Shopee-SECRETA-7x9y';
const SENHA_SHP_NOVA = 'Nova-Senha-API-SECRETA-3k4m';
const SECRETOS_SHP = [SENHA_SHP, SENHA_SHP_NOVA, 'SECRETA'];

/**
 * Open API da Shopee falsa. `modo`: { rede } derruba a conexão, { http } responde esse status, { codigo } responde
 * um erro GraphQL com esse código (HTTP 200); sem nada, um nó de produto. Os erros ecoam a Senha e a assinatura de
 * propósito: nada disso pode chegar ao painel. `assinaturas` guarda as que chegaram (para varrer as respostas).
 */
function apiShopeeFalsa() {
  const modo = { rede: false, http: 200, codigo: null };
  const chamadas = []; const assinaturas = [];
  const fetch = async (url, init = {}) => {
    const u = String(url);
    chamadas.push(u);
    if (u !== URL_API_SHOPEE) throw new Error('rede inesperada no teste');
    const assinatura = /Signature=([0-9a-f]+)/.exec(init.headers?.Authorization ?? '')?.[1] ?? '';
    assinaturas.push(assinatura);
    const eco = `${SENHA_SHP} ${SENHA_SHP_NOVA} ${assinatura}`;
    if (modo.rede) throw new Error(`conexão recusada ${eco}`);
    if (modo.http !== 200) return jsonResp(modo.http, { message: eco });
    if (modo.codigo != null) return jsonResp(200, { errors: [{ message: `erro ${eco}`, extensions: { code: modo.codigo, message: eco } }], data: null });
    return jsonResp(200, { data: { productOfferV2: { nodes: [{ itemId: 22, productName: 'Celular', priceMin: '999.90', imageUrl: '', shopName: 'Loja' }] } } });
  };
  return { modo, chamadas, assinaturas, fetch };
}

/** Banco temporário + createShopee de verdade (fetch falso, credenciais pelo segredosDe, como o servidor) + createConexoes. */
function montarShopee(t, { links } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-cx-s-'));
  const db = openDb(dir);
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const api = apiShopeeFalsa();
  const shopee = createShopee({ db, fetch: api.fetch, lerConexao: () => segredosDe(db, 'shopee') });
  return { db, dir, api, shopee, conexoes: createConexoes({ db, links, amazon: undefined, shopee }) };
}

const salvarShopee = (conexoes, campos, verSegredos = true) => conexoes.salvar('shopee', { campos }, verSegredos);

test('Shopee em Conexões: os 6 estados, extensao_online e a situação da última chamada à API (CA5)', async (t) => {
  let online = false;
  const { conexoes, api } = montarShopee(t, { links: { status: () => ({ online }) } });
  const cartao = (verSegredos = true) => conexoes.listar(verSegredos).find((p) => p.id === 'shopee');
  const testar = () => conexoes.testar('shopee');

  let c = cartao();
  assert.equal(c.estado, 'falta_configurar');
  assert.equal(c.extensao_online, false);
  assert.deepEqual(c.situacao, { acesso: 'nao_configurada', verificado_em: null, motivo: MENSAGENS_SHOPEE.sem_credenciais });
  assert.ok(!('espelhos_ativos' in c), 'a Shopee não espelha nesta entrega');

  assert.equal(salvarShopee(conexoes, { id_afiliado: ID_SHP }).estado, 'so_id', 'ID sem credencial: links pela extensão');
  online = true;
  assert.equal(cartao().extensao_online, true, 'extensão on-line vem de links.status()');
  assert.equal(cartao().estado, 'so_id', 'so_id com ou sem extensão (a tela só muda a cor)');
  online = false;
  assert.equal(cartao().extensao_online, false);
  assert.equal(salvarShopee(conexoes, { app_id: APP_SHP }).estado, 'so_id', 'AppID sem a Senha ainda não é credencial');

  c = salvarShopee(conexoes, { chave: SENHA_SHP });
  assert.equal(c.estado, 'pronta', 'ID e credenciais, ainda sem verificação');
  assert.deepEqual(c.config, { id_afiliado: ID_SHP, app_id: APP_SHP });
  assert.deepEqual(c.segredos_salvos, ['chave']);
  assert.deepEqual(c.situacao, { acesso: 'desconhecido', verificado_em: null, motivo: null });
  assert.equal(api.chamadas.length, 0, 'listar e salvar não chamam a API');

  assert.equal((await testar()).resultado, 'ok');
  c = cartao();
  assert.equal(c.estado, 'conectada');
  assert.equal(c.situacao.acesso, 'ok');
  assert.equal(typeof c.situacao.verificado_em, 'number');

  // salvar só o ID (AppID e Senha iguais) também esquece a verificação: shopee.invalidar foi chamado
  assert.equal(salvarShopee(conexoes, { id_afiliado: '18328801340' }).estado, 'pronta');

  const porCodigo = [
    [10035, 'sem_acesso', 'sem_acesso'],
    [10020, 'erro_credencial', 'credencial_recusada'],
    [11002, 'erro_credencial', 'conta_restrita'],
    [10031, 'erro_credencial', 'conta_restrita'],
    [10030, 'pronta', 'cota'], // cota não diz nada da credencial
    [11000, 'pronta', 'indisponivel'],
  ];
  for (const [codigo, estado, acesso] of porCodigo) {
    api.modo.codigo = codigo;
    await testar();
    c = cartao();
    assert.equal(c.estado, estado, String(codigo));
    assert.equal(c.situacao.acesso, acesso, String(codigo));
    assert.equal(c.situacao.motivo, MENSAGENS_SHOPEE[acesso], `${codigo}: motivo é a frase fixa`);
  }

  // credenciais sem ID de afiliado: "Credenciais salvas" (spec), mesmo com a API aceitando
  api.modo.codigo = null;
  assert.equal(salvarShopee(conexoes, { id_afiliado: '' }).estado, 'pronta');
  assert.equal((await testar()).resultado, 'sem_id');
  assert.equal(cartao().situacao.acesso, 'ok');
  assert.equal(cartao().estado, 'pronta', 'sem ID não está conectada: os links não saem');

  // Operador vê estado, situação e extensão, mas não os nomes dos segredos
  const op = cartao(false);
  assert.ok(!('segredos_salvos' in op));
  assert.equal(op.estado, 'pronta'); assert.ok(op.situacao); assert.equal(op.extensao_online, false);
  for (const s of SECRETOS_SHP) assert.ok(!JSON.stringify(conexoes.listar(true)).includes(s));
});

test('R2: credenciais sem ID de afiliado: a recusa da API aparece no estado (sem_acesso, erro_credencial); aceita continua pronta', async (t) => {
  const { conexoes, api } = montarShopee(t);
  const cartao = () => conexoes.listar(true).find((p) => p.id === 'shopee');
  salvarShopee(conexoes, { app_id: APP_SHP, chave: SENHA_SHP });
  assert.equal(cartao().estado, 'pronta', 'sem verificação');
  const casos = [
    [10035, 'sem_acesso', 'sem_acesso'],
    [10020, 'erro_credencial', 'credencial_recusada'],
    [11002, 'erro_credencial', 'conta_restrita'],
    [10030, 'pronta', 'cota'],
    [11000, 'pronta', 'indisponivel'],
    [null, 'pronta', 'ok'], // aceita, mas sem ID os links não saem: não está conectada
  ];
  for (const [codigo, estado, acesso] of casos) {
    api.modo.codigo = codigo;
    await conexoes.testar('shopee');
    const c = cartao();
    assert.deepEqual([c.estado, c.situacao.acesso], [estado, acesso], String(codigo));
    assert.deepEqual(c.config, { app_id: APP_SHP }, 'continua sem ID');
  }
  // com o ID salvo, os mesmos estados de antes
  api.modo.codigo = 10035;
  salvarShopee(conexoes, { id_afiliado: ID_SHP });
  await conexoes.testar('shopee');
  assert.equal(cartao().estado, 'sem_acesso');
  api.modo.codigo = null;
  await conexoes.testar('shopee');
  assert.equal(cartao().estado, 'conectada');
  // sem credencial, a situação antiga não vale (só o ID): so_id
  salvarShopee(conexoes, { app_id: '' });
  assert.equal(cartao().estado, 'so_id');
});

test('Shopee: sem links nem cliente injetados o cartão não quebra e o teste diz que não está disponível', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-cx-s-'));
  const db = openDb(dir);
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const conexoes = createConexoes({ db });
  let c = conexoes.listar(true).find((p) => p.id === 'shopee');
  assert.equal(c.extensao_online, false);
  assert.deepEqual(c.situacao, { acesso: 'nao_configurada', verificado_em: null, motivo: null });
  salvarShopee(conexoes, { id_afiliado: ID_SHP, app_id: APP_SHP, chave: SENHA_SHP });
  c = conexoes.listar(true).find((p) => p.id === 'shopee');
  assert.equal(c.estado, 'pronta');
  assert.deepEqual(c.situacao, { acesso: 'desconhecido', verificado_em: null, motivo: null });
  assert.deepEqual(await conexoes.testar('shopee'), { ok: false, resultado: 'indisponivel', mensagem: 'O teste da Shopee não está disponível agora.', campos: [] });
});

test('Shopee: AppID igual ao ID de afiliado é recusado com 400 e nada é gravado (CA5)', async (t) => {
  const { conexoes, dir, shopee } = montarShopee(t);
  const invalidar = t.mock.method(shopee, 'invalidar');
  const FRASE = 'O AppID e o ID de afiliado são números diferentes. Confira os dois no portal da Shopee.';
  const recusa = (campos) => {
    assert.throws(() => salvarShopee(conexoes, campos), (e) => {
      assert.equal(e.status, 400, JSON.stringify(campos));
      assert.equal(e.message, FRASE);
      assert.deepEqual(e.extra, { erros: [{ campo: 'app_id', msg: FRASE }] }, 'erro de campo no AppID');
      for (const s of SECRETOS_SHP) assert.ok(!JSON.stringify({ m: e.message, x: e.extra }).includes(s));
      return true;
    });
  };

  recusa({ id_afiliado: ID_SHP, app_id: ID_SHP, chave: SENHA_SHP }); // os dois no mesmo corpo
  assert.equal(linhaCrua(dir, 'shopee'), null, 'nada gravado, nem a Senha');

  salvarShopee(conexoes, { id_afiliado: ID_SHP });
  assert.equal(invalidar.mock.callCount(), 1, 'salvar chama shopee.invalidar');
  recusa({ app_id: ID_SHP, chave: SENHA_SHP }); // AppID igual ao ID já salvo
  recusa({ app_id: `00${ID_SHP}` }); // o mesmo número com zeros à esquerda
  assert.deepEqual(linhaCrua(dir, 'shopee').config, { id_afiliado: ID_SHP });
  assert.deepEqual(linhaCrua(dir, 'shopee').segredos, {}, 'a Senha do corpo recusado não foi gravada');

  salvarShopee(conexoes, { app_id: APP_SHP, chave: SENHA_SHP });
  recusa({ id_afiliado: APP_SHP.padStart(9, '0') }); // ID novo igual ao AppID já salvo
  assert.deepEqual(linhaCrua(dir, 'shopee').config, { id_afiliado: ID_SHP, app_id: APP_SHP });
  assert.equal(invalidar.mock.callCount(), 2, 'recusa não invalida nada');

  // erro de formato vem sozinho (a comparação só roda com os campos válidos)
  assert.throws(() => salvarShopee(conexoes, { app_id: 'abc', id_afiliado: 'abc' }), (e) => {
    assert.deepEqual(e.extra.erros.map((x) => x.campo), ['id_afiliado', 'app_id']);
    assert.ok(!e.message.includes(FRASE));
    return true;
  });

  // trocar os dois de lugar no mesmo corpo, ou apagar o ID e usar o número antigo como AppID, é permitido
  assert.equal(salvarShopee(conexoes, { id_afiliado: APP_SHP.padEnd(11, '7'), app_id: ID_SHP }).estado, 'pronta');
  assert.deepEqual(salvarShopee(conexoes, { id_afiliado: '', app_id: '55555' }).config, { app_id: '55555' });
  assert.equal(invalidar.mock.callCount(), 4);
  // corpo sem nada a gravar não invalida
  salvarShopee(conexoes, { outro: 'x' });
  assert.equal(invalidar.mock.callCount(), 4);
});

test('Shopee testar: chamada real (fetch falso) com resultado por código e frase fixa (CA5, CA6)', async (t) => {
  const { conexoes, api } = montarShopee(t);
  const testar = () => conexoes.testar('shopee');
  const falha = (resultado) => ({ ok: false, resultado, mensagem: FRASES_TESTE_SHOPEE[resultado], campos: [] });

  // sem AppID e Senha não chama a Shopee
  assert.deepEqual(await testar(), { ok: false, resultado: 'nao_configurada', mensagem: 'Salve o AppID e a Senha da API para testar.', campos: [] });
  salvarShopee(conexoes, { app_id: APP_SHP, chave: SENHA_SHP });
  assert.equal(api.chamadas.length, 0);

  // credencial aceita sem ID de afiliado: sucesso parcial, em aviso
  const campos = ['itemId', 'productName', 'priceMin', 'shopName'];
  assert.deepEqual(await testar(), { ok: false, resultado: 'sem_id', mensagem: 'Credenciais aceitas, mas falta o ID de afiliado.', campos });
  salvarShopee(conexoes, { id_afiliado: ID_SHP });
  assert.deepEqual(await testar(), { ok: true, resultado: 'ok', mensagem: 'Credenciais aceitas pela Shopee.', campos });

  const casos = [
    [{ codigo: 10020 }, 'recusada'],
    [{ codigo: 10031 }, 'conta_restrita'], [{ codigo: 10032 }, 'conta_restrita'], [{ codigo: 10033 }, 'conta_restrita'],
    [{ codigo: 10034 }, 'conta_restrita'], [{ codigo: 11002 }, 'conta_restrita'],
    [{ codigo: 10035 }, 'sem_acesso'],
    [{ codigo: 10030 }, 'cota'], [{ http: 429 }, 'cota'],
    [{ codigo: 11000 }, 'indisponivel'], [{ codigo: 11001 }, 'indisponivel'], [{ codigo: 99999 }, 'indisponivel'],
    [{ http: 500 }, 'indisponivel'], [{ rede: true }, 'indisponivel'],
  ];
  for (const [modo, resultado] of casos) {
    Object.assign(api.modo, { rede: false, http: 200, codigo: null }, modo);
    const r = await testar();
    assert.deepEqual(r, falha(resultado), JSON.stringify(modo));
    for (const s of [...SECRETOS_SHP, ...api.assinaturas]) assert.ok(!JSON.stringify(r).includes(s), `${JSON.stringify(modo)} sem segredo`);
  }
  assert.equal(FRASES_TESTE_SHOPEE.sem_acesso, 'A Shopee ainda não liberou a API para a sua conta. Peça o acesso pelo link acima e tente de novo quando eles responderem. Enquanto isso os links continuam saindo pela extensão.');
  assert.equal(api.chamadas.length, casos.length + 2);
  assert.ok(api.chamadas.every((u) => u === URL_API_SHOPEE), 'só o host fixo da API');
});

test('Shopee testar: só repassa resultado conhecido, frases fixas e nomes de campo da lista; erros viram frase fixa', async (t) => {
  let volta; let erro = null; let sit = null;
  const stub = {
    testar: async () => { if (erro) throw erro; return volta; },
    situacao: () => { if (sit instanceof Error) throw sit; return sit; },
    invalidar() {},
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-cx-s-'));
  const db = openDb(dir);
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const conexoes = createConexoes({ db, shopee: stub });
  salvarShopee(conexoes, { id_afiliado: ID_SHP, app_id: APP_SHP, chave: SENHA_SHP });
  const falha = (resultado) => ({ ok: false, resultado, mensagem: FRASES_TESTE_SHOPEE[resultado], campos: [] });

  const casos = [
    [{ ok: true, resultado: 'ok', mensagem: `vazou ${SENHA_SHP}`, campos: ['productName', SENHA_SHP, 'token', 'imageUrl'], assinatura: 'abc' },
      { ok: true, resultado: 'ok', mensagem: FRASES_TESTE_SHOPEE.ok, campos: ['productName', 'imageUrl'] }],
    [{ ok: true, resultado: 'sem_acesso' }, falha('sem_acesso')],
    [{ ok: false, resultado: 'ok' }, falha('indisponivel')],
    [{ ok: 'true', resultado: 'ok', campos: 'productName' }, falha('indisponivel')],
    [{ ok: true, resultado: 'sem_id' }, falha('indisponivel')], // sem_id só este módulo decide
    [{ ok: true, resultado: '__proto__' }, falha('indisponivel')],
    [{ ok: true, resultado: 'conectadissima' }, falha('indisponivel')],
    [null, falha('indisponivel')],
  ];
  for (const [vindo, saida] of casos) { volta = vindo; assert.deepEqual(await conexoes.testar('shopee'), saida, JSON.stringify(vindo)); }

  const porTipo = {
    sem_credenciais: 'nao_configurada', credencial_recusada: 'recusada', conta_restrita: 'conta_restrita', sem_acesso: 'sem_acesso',
    cota: 'cota', nao_encontrado: 'indisponivel', indisponivel: 'indisponivel', sem_id: 'indisponivel', outra_conta: 'indisponivel',
    link_falhou: 'indisponivel',
  };
  assert.deepEqual(Object.keys(porTipo).sort(), Object.keys(MENSAGENS_SHOPEE).sort(), 'todo tipo de ErroShopee tem tradução');
  for (const [tipo, resultado] of Object.entries(porTipo)) {
    erro = new ErroShopee(tipo, { codigoApi: 10020 });
    erro.message = `${erro.message} ${SENHA_SHP}`; // mesmo com segredo na mensagem, a resposta é a frase fixa
    assert.deepEqual(await conexoes.testar('shopee'), falha(resultado), tipo);
  }
  const saidas = [];
  t.mock.method(console, 'error', (...a) => saidas.push(a.map(String).join(' ')));
  erro = new TypeError(`quebrou com ${SENHA_SHP}`);
  assert.deepEqual(await conexoes.testar('shopee'), falha('indisponivel'));
  assert.deepEqual(saidas, ['[conexões] teste da Shopee falhou: TypeError']);

  // situação vinda do serviço: só acesso conhecido, número e frase fixa; se ela quebrar, o cartão não quebra
  const cartao = () => conexoes.listar(true).find((p) => p.id === 'shopee');
  sit = { acesso: 'ok', verificado_em: 5, motivo: `vazou ${SENHA_SHP}`, impressao: 'abc' };
  assert.deepEqual(cartao().situacao, { acesso: 'ok', verificado_em: 5, motivo: null });
  assert.equal(cartao().estado, 'conectada');
  sit = { acesso: 'hackeado', verificado_em: '5', motivo: MENSAGENS_SHOPEE.cota };
  assert.deepEqual(cartao().situacao, { acesso: 'desconhecido', verificado_em: null, motivo: MENSAGENS_SHOPEE.cota });
  assert.equal(cartao().estado, 'pronta');
  sit = new RangeError(`situação quebrou ${SENHA_SHP}`);
  assert.deepEqual(cartao().situacao, { acesso: 'desconhecido', verificado_em: null, motivo: null });
  assert.equal(saidas.at(-1), '[conexões] situação da Shopee falhou: RangeError');
  assert.ok(!saidas.some((l) => l.includes(SENHA_SHP)));
});

/** Rotas de Conexões num Express mínimo (o servidor só liga a Shopee na etapa 8): ctx.shopee = cliente de verdade. */
function subirRotasShopee(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-cx-s-'));
  const db = openDb(dir);
  const api = apiShopeeFalsa();
  const shopee = createShopee({ db, fetch: api.fetch, lerConexao: () => segredosDe(db, 'shopee') });
  const app = express();
  app.use(express.json());
  montarRotas(app, { db, links: { status: () => ({ online: true }) }, soDono: (_req, _res, next) => next(), shopee });
  return new Promise((ok) => {
    const server = app.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); r(); }); }));
      const port = server.address().port;
      ok({ db, dir, api, chamar: (caminho, opts) => req(port, '/api' + caminho, opts) });
    });
  });
}

test('Shopee por HTTP: a Senha da API e a assinatura nunca aparecem no texto cru das respostas, no log nem no console (CA6)', async (t) => {
  const global_ = t.mock.method(globalThis, 'fetch', async () => { throw new Error('fetch global no teste'); });
  const saidas = [];
  const originais = {};
  for (const m of ['log', 'info', 'warn', 'error']) { originais[m] = console[m]; console[m] = (...a) => { saidas.push(a.map(String).join(' ')); originais[m](...a); }; }
  let api;
  try {
    const s = await subirRotasShopee(t);
    api = s.api;
    const respostas = [];
    const chamar = async (caminho, opts) => { const r = await s.chamar(caminho, opts); respostas.push(r); return r; };

    let r = await chamar('/conexoes/shopee', { method: 'PUT', body: { campos: { id_afiliado: ID_SHP, app_id: APP_SHP, chave: SENHA_SHP } } });
    assert.equal(r.status, 200, r.txt);
    assert.equal(r.json.estado, 'pronta');
    assert.equal(r.json.extensao_online, true);
    assert.deepEqual(linhaCrua(s.dir, 'shopee').segredos, { chave: SENHA_SHP });

    r = await chamar('/conexoes/shopee/testar', { method: 'POST', body: {} });
    assert.equal(r.status, 200);
    assert.equal(r.json.resultado, 'ok');
    assert.equal((await chamar('/conexoes')).json.find((p) => p.id === 'shopee').estado, 'conectada');

    // AppID igual ao ID, com a Senha nova no corpo: 400, nada gravado, nada ecoa
    r = await chamar('/conexoes/shopee', { method: 'PUT', body: { campos: { app_id: ID_SHP, chave: SENHA_SHP_NOVA } } });
    assert.equal(r.status, 400);
    assert.deepEqual(r.json, { erro: 'O AppID e o ID de afiliado são números diferentes. Confira os dois no portal da Shopee.',
      erros: [{ campo: 'app_id', msg: 'O AppID e o ID de afiliado são números diferentes. Confira os dois no portal da Shopee.' }] });
    // Senha em formato inválido: o valor recusado não ecoa
    r = await chamar('/conexoes/shopee', { method: 'PUT', body: { campos: { chave: `${SENHA_SHP_NOVA} com espaço` } } });
    assert.equal(r.status, 400);
    assert.match(r.json.erro, /^Senha da API: formato inválido/);
    assert.deepEqual(linhaCrua(s.dir, 'shopee').segredos, { chave: SENHA_SHP }, 'nada gravado com erro');

    for (const modo of [{ codigo: 10020 }, { codigo: 10035 }, { codigo: 11002 }, { codigo: 10030 }, { http: 429 }, { http: 500 }, { rede: true }]) {
      Object.assign(api.modo, { rede: false, http: 200, codigo: null }, modo);
      r = await chamar('/conexoes/shopee/testar', { method: 'POST', body: {} });
      assert.equal(r.status, 200, JSON.stringify(modo));
      assert.equal(r.json.ok, false);
      await chamar('/conexoes');
    }
    api.modo.rede = false;
    r = await chamar('/conexoes/shopee', { method: 'PUT', body: { campos: { chave: SENHA_SHP_NOVA } } });
    assert.equal(r.status, 200);
    assert.deepEqual(linhaCrua(s.dir, 'shopee').segredos, { chave: SENHA_SHP_NOVA });
    await chamar('/conexoes/shopee/testar', { method: 'POST', body: {} });
    await chamar('/conexoes');

    assert.ok(api.assinaturas.length >= 9 && api.assinaturas.every((a) => /^[0-9a-f]{64}$/.test(a)), 'as chamadas foram assinadas');
    for (const resp of respostas) {
      for (const seg of [...SECRETOS_SHP, ...api.assinaturas]) assert.ok(!resp.txt.includes(seg), `resposta ${resp.status} sem segredo: ${resp.txt.slice(0, 160)}`);
    }
    const log = JSON.stringify(s.db.prepare('SELECT * FROM log').all());
    for (const seg of [...SECRETOS_SHP, ...api.assinaturas]) assert.ok(!log.includes(seg), 'segredo fora da tabela log');
  } finally { Object.assign(console, originais); }
  for (const seg of [...SECRETOS_SHP, ...api.assinaturas]) assert.ok(!saidas.some((l) => l.includes(seg)), 'segredo fora do console');
  assert.ok(api.chamadas.every((u) => u === URL_API_SHOPEE), 'só o host fixo da API');
  assert.equal(global_.mock.callCount(), 0, 'nada passou pelo fetch global');
});

// ================================================================================ painel (public/conexoes.js) em DOM falso
/** Carrega public/conexoes.js num vm. `respostas` = { 'METODO /caminho': valor | função }. Nada de rede. */
function carregarConexoes(respostas) {
  const el = () => ({ value: '', disabled: false, hidden: false, textContent: '', innerHTML: '', className: '', placeholder: '', onclick: null, onsubmit: null,
    classes: new Set(), classList: { add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, on) { if (on) this._s.add(c); else this._s.delete(c); }, contains(c) { return this._s.has(c); } } });
  const mk = () => { const e = el(); e.classList._s = e.classes; return e; };
  const linha = mk(); const testar = mk(); const salvar = mk(); const selo = mk(); const nota = mk();
  const campos = new Map();
  const form = { elements: { namedItem: (n) => { if (!campos.has(n)) campos.set(n, mk()); return campos.get(n); } } };
  const achar = (sel) => ({ '.estado-linha': linha, '[data-testar]': testar, '[type=submit]': salvar, 'form': form, '.cab .estado-pill': selo, '[data-espelhos]': nota }[sel] ?? null);
  const pedidos = [];
  const ctx = {
    console, Number, String, Array, Object, Math, Date, JSON, RegExp, Promise, Error,
    $: (sel) => achar(sel), $$: () => [], esc: (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    q: () => '', REQ: '*', S: {}, aviso() {}, mostrarErros: () => false, dataHora: () => '01/11/2026 10:00',
    api: async (url, metodo = 'GET') => { pedidos.push(`${metodo} ${url}`); const r = respostas[`${metodo} ${url}`]; return typeof r === 'function' ? r() : r; },
  };
  vm.createContext(ctx);
  vm.runInContext(`${fs.readFileSync(new URL('../public/conexoes.js', import.meta.url), 'utf8')}\n;globalThis.__x = { aplicarConexao, ligarConexao };`, ctx);
  return { ...ctx.__x, linha, testar, selo, pedidos, art: {}, form };
}
const CARTAO_AMAZON = (extra = {}) => ({
  id: 'amazon', nome: 'Amazon', implementada: true, estado: 'pronta', updated_at: 1_700_000_000_000, espelhos_ativos: 0, segredos_salvos: [],
  campos: [{ nome: 'tag', rotulo: 'Tag', tipo: 'texto', max: 40 }], config: { tag: 'dono-20' },
  situacao: { acesso: 'desconhecido', verificado_em: null, motivo: null }, ...extra,
});

test('R3 (painel): teste da Amazon aceito sem tag mostra a frase do servidor com a dica da tag; com tag, a frase normal', async () => {
  const frase = 'Credencial aceita pela Amazon.';
  const dica = ' Cadastre a tag de associado para conferir o acesso à API.';
  let resposta = { ok: true, resultado: 'ok', mensagem: frase + dica, campos: [] };
  const t = carregarConexoes({ 'POST /conexoes/amazon/testar': () => resposta, 'GET /conexoes': [] });
  const cartao = CARTAO_AMAZON({ config: {} });
  t.ligarConexao(t.art, cartao);
  await t.testar.onclick();
  assert.ok(t.linha.innerHTML.includes(frase + dica), t.linha.innerHTML);
  assert.ok(!t.linha.classes.has('aviso'));
  resposta = { ok: true, resultado: 'ok', mensagem: frase, campos: [] };
  await t.testar.onclick();
  assert.ok(t.linha.innerHTML.includes(frase) && !t.linha.innerHTML.includes('Cadastre'), t.linha.innerHTML);
  // falha: continua a frase da tela por resultado, em texto puro e com o destaque de aviso
  resposta = { ok: false, resultado: 'recusada', mensagem: 'qualquer coisa do servidor', campos: [] };
  await t.testar.onclick();
  assert.match(t.linha.textContent, /^A Amazon não aceitou a credencial\./);
  assert.ok(t.linha.classes.has('aviso'));
  // resultado que a tela não conhece (nao_configurada): vale a mensagem do servidor
  resposta = { ok: false, resultado: 'nao_configurada', mensagem: 'Preencha o ID e o segredo da credencial e salve antes de testar.', campos: [] };
  await t.testar.onclick();
  assert.equal(t.linha.textContent, resposta.mensagem);
});

test('R4 (painel): a falha da última verificação da Amazon aparece em texto na linha de estado ao carregar o cartão', () => {
  const t = carregarConexoes({});
  const motivo = MENSAGENS_AMAZON.sem_acesso;
  for (const acesso of ['sem_acesso', 'credenciais_invalidas', 'tag_invalida', 'cota', 'indisponivel']) {
    t.aplicarConexao(t.art, CARTAO_AMAZON({ situacao: { acesso, verificado_em: 1, motivo } }));
    assert.ok(t.linha.textContent.startsWith(`${motivo} Dados salvos em`), `${acesso}: ${t.linha.textContent}`);
    assert.ok(t.linha.classes.has('aviso'), acesso);
  }
  for (const situacao of [{ acesso: 'ok', verificado_em: 1, motivo: null }, { acesso: 'desconhecido', verificado_em: null, motivo: null },
    { acesso: 'nao_configurada', verificado_em: null, motivo: null }, { acesso: 'sem_acesso', verificado_em: 1, motivo: null }, undefined]) {
    t.aplicarConexao(t.art, CARTAO_AMAZON({ situacao }));
    assert.match(t.linha.textContent, /^Dados salvos em /, JSON.stringify(situacao));
    assert.ok(!t.linha.classes.has('aviso'));
  }
  // outra loja nunca mostra motivo da Amazon (a Shopee passou a mostrar o seu: test/shopee-painel.test.js)
  t.aplicarConexao(t.art, CARTAO_AMAZON({ id: 'magalu', situacao: { acesso: 'sem_acesso', verificado_em: 1, motivo } }));
  assert.match(t.linha.textContent, /^Dados salvos em /);
});
