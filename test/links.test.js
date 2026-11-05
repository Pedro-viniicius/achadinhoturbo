// Serviço de links da extensão (src/links.js): o pedido de link da Shopee (`link_shopee`), a validação
// do que a extensão devolve por tipo de pedido e o modo de simulação. Sem rede e sem extensão de verdade:
// a "extensão" aqui é o próprio teste chamando poll/submit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLinkService, LINK_MELI, LIMITE_SHOPEE_ATINGIDO } from '../src/links.js';

const URL_SHOPEE = 'https://shopee.com.br/Apple-Iphone-11-128GB-Local-Set-i.52377417.6309028319';
const CURTO = 'https://s.shopee.com.br/9fMB7wrS3r';
const LONGO = 'https://shopee.com.br/Apple-Iphone-11-128GB-Local-Set-i.52377417.6309028319?utm_medium=affiliates&utm_source=an_98765432101&utm_term=abc';

/** Promessa que nunca rejeita sem tratamento: devolve { valor } ou { erro }. */
const resultado = (p) => p.then((valor) => ({ valor }), (erro) => ({ erro }));

/**
 * Faz o papel da extensão: espera o próximo pedido, entrega a `resposta` e devolve o pedido visto e o
 * resultado de quem pediu. `pedir` só é chamado depois do poll (a extensão fica "on-line").
 */
async function comExtensao(links, pedir, resposta) {
  const proximo = links.poll(2000);
  const r = resultado(pedir());
  const job = await proximo;
  assert.ok(job, 'a extensão recebeu um pedido');
  assert.equal(links.submit(job.id, resposta), true);
  return { job, ...(await r) };
}

test('links Shopee: o pedido vai à extensão como link_shopee, só com a URL, e volta { link, longo, subIdAplicado }', async () => {
  const links = createLinkService({ getMode: () => 'extension' });
  const { job, valor, erro } = await comExtensao(links, () => links.requestLinkShopee({ url: URL_SHOPEE }),
    { ok: true, link: `  ${CURTO}  `, longo: LONGO });
  assert.equal(erro, undefined);
  assert.deepEqual(job, { id: job.id, type: 'link_shopee', url: URL_SHOPEE }, 'sem tag nem outro campo');
  assert.deepEqual(valor, { link: CURTO, longo: LONGO, subIdAplicado: false });
  const st = links.status();
  assert.equal(st.shopeeLastError, ''); assert.ok(st.shopeeLastOkAt > 0); assert.equal(st.pending, 0);
  assert.deepEqual([st.lastOkAt, st.lastError], [0, ''], 'R4: o link da Shopee não conta como link do ML');
});

test('links Shopee: link meli.la (ou qualquer coisa fora de s.shopee.com.br) é recusado', async () => {
  const ruins = [
    'https://meli.la/2AbCdEf',
    'http://s.shopee.com.br/9fMB7wrS3r',
    'https://s.shopee.com.br.evil.com/9fMB7wrS3r',
    'https://s.shopee.com.br:8443/9fMB7wrS3r',
    'https://user@s.shopee.com.br/9fMB7wrS3r',
    'https://s.shopee.com.br/9fMB7wrS3r?x=1',
    'https://s.shopee.com.br/9fMB7wrS3r#x',
    'https://s.shopee.com.br/a/b',
    'https://s.shopee.com.br/ab',
    `https://s.shopee.com.br/${'a'.repeat(41)}`,
    'https://shopee.com.br/produto-i.1.2',
    'https://shp.ee/abc123',
    'javascript:alert(1)',
  ];
  const links = createLinkService({ getMode: () => 'extension' });
  for (const link of ruins) {
    const { erro } = await comExtensao(links, () => links.requestLinkShopee({ url: URL_SHOPEE }), { ok: true, link, longo: LONGO });
    assert.ok(erro, `recusou ${link}`);
    assert.match(erro.message, /não é s\.shopee\.com\.br; recusado/);
    assert.match(links.status().shopeeLastError, /recusado/);
    assert.equal(links.status().lastError, '', 'R4: a falha da Shopee não vai para o estado do ML');
  }
  // resposta ok sem link, e o erro da extensão quando ok=false (cortado em 300)
  const semLink = await comExtensao(links, () => links.requestLinkShopee({ url: URL_SHOPEE }), { ok: true });
  assert.match(semLink.erro.message, /resposta sem link/);
  const falhou = await comExtensao(links, () => links.requestLinkShopee({ url: URL_SHOPEE }),
    { ok: false, error: 'não há sessão de afiliado da Shopee neste Chrome' + 'x'.repeat(400) });
  assert.match(falhou.erro.message, /^não há sessão de afiliado da Shopee/);
  assert.equal(falhou.erro.message.length, 300);
});

test('links Shopee: longo fora de um host da Shopee é descartado (o link curto continua valendo)', async () => {
  const descartados = [
    'https://evil.com/?u=shopee.com.br&utm_source=an_1',
    'https://shopee.com.br.evil.com/x?utm_source=an_1',
    'https://evilshopee.com.br/x',
    'http://shopee.com.br/x?utm_source=an_1',
    'https://shopee.com.br:8443/x',
    'https://user:senha@shopee.com.br/x',
    'https://shp.ee/abc',
    'javascript:alert(1)',
    'não é url',
    `https://shopee.com.br/${'a'.repeat(2048)}`,
    '',
    123,
    { href: LONGO },
    ['https://shopee.com.br/x'],
    null,
    undefined,
  ];
  const links = createLinkService({ getMode: () => 'extension' });
  for (const longo of descartados) {
    const { valor, erro } = await comExtensao(links, () => links.requestLinkShopee({ url: URL_SHOPEE }), { ok: true, link: CURTO, longo });
    assert.equal(erro, undefined, `aceitou o link curto com longo ${String(longo).slice(0, 40)}`);
    assert.deepEqual(valor, { link: CURTO, longo: null, subIdAplicado: false }, `descartou ${String(longo).slice(0, 40)}`);
  }
  // hosts da Shopee (inclusive subdomínio e maiúsculas) passam, normalizados
  for (const [longo, esperado] of [
    [LONGO, LONGO],
    ['https://s.shopee.com.br/an_redir?origin_link=x&affiliate_id=1', 'https://s.shopee.com.br/an_redir?origin_link=x&affiliate_id=1'],
    ['HTTPS://SHOPEE.COM.BR/x?utm_source=an_7', 'https://shopee.com.br/x?utm_source=an_7'],
  ]) {
    const { valor } = await comExtensao(links, () => links.requestLinkShopee({ url: URL_SHOPEE }), { ok: true, link: CURTO, longo });
    assert.deepEqual(valor, { link: CURTO, longo: esperado, subIdAplicado: false });
  }
});

test('links Shopee: modo fake gera link s.shopee.com.br sem extensão; modo direct não dispensa a extensão', async () => {
  const fake = createLinkService({ getMode: () => 'fake' });
  const a = await fake.requestLinkShopee({ url: URL_SHOPEE });
  const b = await fake.requestLinkShopee({ url: URL_SHOPEE });
  assert.match(a.link, /^https:\/\/s\.shopee\.com\.br\/fake\d+$/);
  assert.equal(a.longo, null);
  assert.notEqual(a.link, b.link, 'um link por pedido');
  assert.equal(fake.status().online, false, 'nunca falou com a extensão');
  assert.equal(fake.status().pending, 0);
  // direct (Ajustes, só do ML): a Shopee nunca sai sem afiliado, então continua pedindo à extensão
  const direto = createLinkService({ getMode: () => 'direct' });
  await assert.rejects(direto.requestLinkShopee({ url: URL_SHOPEE }), /não está conectada/);
  const { job, valor } = await comExtensao(direto, () => direto.requestLinkShopee({ url: URL_SHOPEE }), { ok: true, link: CURTO });
  assert.equal(job.type, 'link_shopee');
  assert.deepEqual(valor, { link: CURTO, longo: null, subIdAplicado: false });
});

test('links Shopee: só pede link de endereço de produto https://shopee.com.br/ sem parâmetros (nem no fake)', async () => {
  const ruins = [
    'https://shopee.com.br.evil.com/x', 'http://shopee.com.br/x', 'https://s.shopee.com.br/abc', 'https://evil.com/shopee.com.br/',
    'https://shopee.com.br/x?utm_source=an_1', 'https://shopee.com.br/x#y', 'https://shopee.com.br/x y', 'https://shopee.com.br/x\n',
    'https://shopee.com.br', `https://shopee.com.br/${'a'.repeat(2048)}`, '', null, undefined, 42, { url: URL_SHOPEE },
  ];
  for (const modo of ['extension', 'fake']) {
    const links = createLinkService({ getMode: () => modo });
    const espera = links.poll(50); // on-line, para a recusa não ser por falta de extensão
    for (const url of ruins) {
      // timeout curto: se a guarda falhar, o pedido expira logo em vez de esperar 90 s pela extensão
      await assert.rejects(links.requestLinkShopee({ url, timeoutMs: 50 }), /endereço de produto da Shopee inválido/, `${modo}: ${String(url).slice(0, 40)}`);
    }
    assert.equal(links.status().pending, 0, 'nada foi para a fila');
    assert.equal(await espera, null);
  }
  await assert.rejects(createLinkService({ getMode: () => 'fake' }).requestLinkShopee({}), /inválido/);
  // o formato do extrairIds (/product/<shop>/<item>) passa
  const ok = await createLinkService({ getMode: () => 'fake' }).requestLinkShopee({ url: 'https://shopee.com.br/product/52377417/6309028319' });
  assert.match(ok.link, /^https:\/\/s\.shopee\.com\.br\/fake\d+$/);
});

// ---------------- Sub_id (plano dashboard-ganhos, etapa 5) ----------------

test('links Sub_id (CA2): o subId vai no job link_shopee e sub_id_aplicado: true da extensão vira subIdAplicado: true', async () => {
  const links = createLinkService({ getMode: () => 'extension' });
  const { job, valor, erro } = await comExtensao(links, () => links.requestLinkShopee({ url: URL_SHOPEE, subId: 'bloco7' }),
    { ok: true, link: CURTO, longo: LONGO, sub_id_aplicado: true });
  assert.equal(erro, undefined);
  assert.deepEqual(job, { id: job.id, type: 'link_shopee', url: URL_SHOPEE, subId: 'bloco7' });
  assert.deepEqual(valor, { link: CURTO, longo: LONGO, subIdAplicado: true });
});

test('links Sub_id (CA9): extensão antiga (sem sub_id_aplicado) ou qualquer valor que não seja true → subIdAplicado: false', async () => {
  for (const extra of [{}, { sub_id_aplicado: false }, { sub_id_aplicado: 'true' }, { sub_id_aplicado: 1 }, { sub_id_aplicado: null }, { subIdAplicado: true }]) {
    const links = createLinkService({ getMode: () => 'extension' });
    const { valor } = await comExtensao(links, () => links.requestLinkShopee({ url: URL_SHOPEE, subId: 'g1' }), { ok: true, link: CURTO, longo: LONGO, ...extra });
    assert.deepEqual(valor, { link: CURTO, longo: LONGO, subIdAplicado: false }, JSON.stringify(extra));
  }
});

test('links Sub_id: sem subId o job é o de hoje e a extensão não pode dizer que aplicou', async () => {
  for (const subId of [undefined, null, '']) {
    const links = createLinkService({ getMode: () => 'extension' });
    const { job, valor } = await comExtensao(links, () => links.requestLinkShopee({ url: URL_SHOPEE, subId }),
      { ok: true, link: CURTO, longo: LONGO, sub_id_aplicado: true });
    assert.deepEqual(job, { id: job.id, type: 'link_shopee', url: URL_SHOPEE }, String(subId));
    assert.deepEqual(valor, { link: CURTO, longo: LONGO, subIdAplicado: false });
  }
});

test('links Sub_id: subId que não é alfanumérico (1 a 30) é recusado antes da fila, em qualquer modo, sem contar no teto', async () => {
  for (const modo of ['extension', 'direct', 'fake']) {
    const links = createLinkService({ getMode: () => modo, limiteShopeeHora: 1 });
    await links.poll(0); // on-line (sem deixar waiter aberto): se a guarda falhar, o pedido entraria na fila
    for (const subId of ['g-1', 'g_1', 'g 1', 'ção', 'a'.repeat(31), 'g1\n', 7, true, {}, ['g1']]) {
      await assert.rejects(links.requestLinkShopee({ url: URL_SHOPEE, subId, timeoutMs: 50 }), (e) => e.message === 'Sub_id da Shopee inválido', `${modo}: ${String(subId)}`);
    }
    assert.equal(links.status().pending, 0, modo);
  }
  // nenhum dos recusados consumiu a vaga da hora (limite 1): o próximo pedido válido ainda vai
  const links = createLinkService({ getMode: () => 'extension', limiteShopeeHora: 1 });
  await links.poll(0);
  await assert.rejects(links.requestLinkShopee({ url: URL_SHOPEE, subId: 'g-1', timeoutMs: 50 }), /Sub_id da Shopee inválido/);
  const { valor } = await comExtensao(links, () => links.requestLinkShopee({ url: URL_SHOPEE, subId: 'g1' }), { ok: true, link: CURTO, sub_id_aplicado: true });
  assert.equal(valor.subIdAplicado, true);
});

test('links Sub_id: o modo fake simula a extensão que aplica o Sub_id', async () => {
  const fake = createLinkService({ getMode: () => 'fake' });
  const com = await fake.requestLinkShopee({ url: URL_SHOPEE, subId: 'g1' });
  assert.match(com.link, /^https:\/\/s\.shopee\.com\.br\/fake\d+$/);
  assert.deepEqual({ longo: com.longo, subIdAplicado: com.subIdAplicado }, { longo: null, subIdAplicado: true });
  const sem = await fake.requestLinkShopee({ url: URL_SHOPEE });
  assert.equal(sem.subIdAplicado, false);
});

test('links Sub_id: link fora de s.shopee.com.br continua recusado mesmo com sub_id_aplicado: true', async () => {
  const links = createLinkService({ getMode: () => 'extension' });
  const { erro } = await comExtensao(links, () => links.requestLinkShopee({ url: URL_SHOPEE, subId: 'g1' }),
    { ok: true, link: 'https://meli.la/2AbCdEf', sub_id_aplicado: true });
  assert.match(erro.message, /não é s\.shopee\.com\.br/);
});

test('links Shopee: sem resposta da extensão, o pedido expira e sai da fila', async () => {
  const links = createLinkService({ getMode: () => 'extension' });
  await links.poll(1); // fica on-line e o long-poll termina vazio
  await assert.rejects(links.requestLinkShopee({ url: URL_SHOPEE, timeoutMs: 20 }), /não respondeu a tempo/);
  assert.equal(links.status().pending, 0);
});

test('links ML: comportamento de hoje (meli.la no modo extensão; s.shopee recusado; direct e fake iguais)', async () => {
  assert.ok(LINK_MELI.test('https://meli.la/2AbCdEf'));
  const links = createLinkService({ getMode: () => 'extension' });
  const certo = await comExtensao(links, () => links.requestLink({ url: 'https://produto.mercadolivre.com.br/MLB-1', tag: 'minha' }),
    { ok: true, link: 'https://meli.la/2AbCdEf', longo: LONGO });
  assert.deepEqual(certo.job, { id: certo.job.id, type: 'link', url: 'https://produto.mercadolivre.com.br/MLB-1', tag: 'minha' });
  assert.equal(certo.valor, 'https://meli.la/2AbCdEf', 'o ML continua devolvendo só a string do link');
  for (const link of [CURTO, 'https://shopee.com.br/x', 'https://golpe.example/x']) {
    const r = await comExtensao(links, () => links.requestLink({ url: 'u', tag: 't' }), { ok: true, link });
    assert.match(r.erro.message, /não é meli\.la/, `ML recusou ${link}`);
  }
  // direct: a URL como está; fake: meli.la/fake-<tag>-<n>; nada vai para a extensão
  assert.equal(await createLinkService({ getMode: () => 'direct' }).requestLink({ url: 'https://x.example/p', tag: 't' }), 'https://x.example/p');
  const fake = createLinkService({ getMode: () => 'fake' });
  assert.match(await fake.requestLink({ url: 'u', tag: 'minha etiqueta' }), /^https:\/\/meli\.la\/fake-minha%20etiqueta-\d+$/);
  assert.equal(fake.status().pending, 0);
  // id desconhecido continua devolvendo false
  assert.equal(links.submit(999999, { ok: true, link: CURTO }), false);
});

test('R4: o resultado do link da Shopee fica em shopeeLastOkAt/shopeeLastError; o do ML continua em lastOkAt/lastError', async () => {
  const links = createLinkService({ getMode: () => 'extension' });
  // ML dá certo; a Shopee falha (ok:false e link fora do formato): o ML continua "ok" no cartão
  await comExtensao(links, () => links.requestLink({ url: 'https://produto.mercadolivre.com.br/MLB-1', tag: 't' }), { ok: true, link: 'https://meli.la/2AbCdEf' });
  const okMl = links.status().lastOkAt;
  assert.ok(okMl > 0);
  const sessao = await comExtensao(links, () => links.requestLinkShopee({ url: URL_SHOPEE }), { ok: false, error: 'não há sessão de afiliado da Shopee neste Chrome' });
  assert.match(sessao.erro.message, /não há sessão/);
  let st = links.status();
  assert.deepEqual([st.lastOkAt, st.lastError], [okMl, ''], 'falha da Shopee não muda o estado do ML');
  assert.match(st.shopeeLastError, /não há sessão de afiliado da Shopee/);
  assert.equal(st.shopeeLastOkAt, 0);
  await comExtensao(links, () => links.requestLinkShopee({ url: URL_SHOPEE }), { ok: true, link: 'https://meli.la/2AbCdEf' });
  assert.match(links.status().shopeeLastError, /não é s\.shopee\.com\.br; recusado/);
  assert.equal(links.status().lastError, '');

  // a Shopee dá certo: limpa só o erro dela
  await comExtensao(links, () => links.requestLinkShopee({ url: URL_SHOPEE }), { ok: true, link: CURTO });
  st = links.status();
  assert.equal(st.shopeeLastError, ''); assert.ok(st.shopeeLastOkAt > 0);
  assert.equal(st.lastOkAt, okMl, 'o "último link gerado" do ML não é o da Shopee');

  // o ML falha: o estado da Shopee não muda
  const okShopee = st.shopeeLastOkAt;
  await comExtensao(links, () => links.requestLink({ url: 'u', tag: 't' }), { ok: false, error: 'sem login no ML' });
  st = links.status();
  assert.equal(st.lastError, 'sem login no ML');
  assert.deepEqual([st.shopeeLastOkAt, st.shopeeLastError], [okShopee, '']);
  // o erro da Shopee também fica com até 300 letras
  await comExtensao(links, () => links.requestLinkShopee({ url: URL_SHOPEE }), { ok: false, error: 'x'.repeat(5000) });
  assert.equal(links.status().shopeeLastError.length, 300);
});

/** Liga a extensão (poll curto que termina vazio) e faz `n` pedidos que expiram logo, sem ninguém responder. */
async function pedidosQueExpiram(links, n) {
  await links.poll(1);
  const r = [];
  for (let i = 0; i < n; i++) r.push(resultado(links.requestLinkShopee({ url: URL_SHOPEE, timeoutMs: 1 })));
  return Promise.all(r);
}

test('S2: no máximo 60 pedidos link_shopee por hora à extensão; o 61º é recusado com a frase fixa, sem ir à fila', async () => {
  const rel = { t: 1_700_000_000_000 };
  const links = createLinkService({ getMode: () => 'extension', agora: () => rel.t });
  const feitos = await pedidosQueExpiram(links, 60);
  assert.ok(feitos.every((x) => /não respondeu a tempo/.test(x.erro?.message)), 'os 60 foram à fila (e expiraram)');
  await links.poll(1);
  await assert.rejects(links.requestLinkShopee({ url: URL_SHOPEE, timeoutMs: 1 }), (e) => e.message === 'Limite de links da Shopee por hora atingido; tente mais tarde.');
  assert.equal(LIMITE_SHOPEE_ATINGIDO, 'Limite de links da Shopee por hora atingido; tente mais tarde.');
  assert.equal(links.status().pending, 0, 'o pedido recusado não foi para a fila');
  // o ML não tem esse teto
  const ml = await comExtensao(links, () => links.requestLink({ url: 'u', tag: 't' }), { ok: true, link: 'https://meli.la/2AbCdEf' });
  assert.equal(ml.valor, 'https://meli.la/2AbCdEf');
  // a janela é de 1 h: 59 min depois ainda recusa; passada a hora, volta a pedir
  rel.t += 59 * 60000;
  await assert.rejects(links.requestLinkShopee({ url: URL_SHOPEE, timeoutMs: 1 }), /Limite de links da Shopee por hora/);
  rel.t += 60001;
  const volta = await comExtensao(links, () => links.requestLinkShopee({ url: URL_SHOPEE }), { ok: true, link: CURTO });
  assert.deepEqual(volta.valor, { link: CURTO, longo: null, subIdAplicado: false });
});

test('S2: o teto conta só pedidos que foram à extensão (off-line e simulação não contam) e aceita outro limite', async () => {
  const rel = { t: 1_700_000_000_000 };
  const links = createLinkService({ getMode: () => 'extension', limiteShopeeHora: 2, agora: () => rel.t });
  // off-line: recusa por falta de extensão, sem gastar a cota
  for (let i = 0; i < 5; i++) await assert.rejects(links.requestLinkShopee({ url: URL_SHOPEE }), /não está conectada/);
  // URL inválida também não conta
  await assert.rejects(links.requestLinkShopee({ url: 'https://evil.com/x' }), /inválido/);
  const dois = await pedidosQueExpiram(links, 2);
  assert.ok(dois.every((x) => /não respondeu a tempo/.test(x.erro?.message)));
  await assert.rejects(links.requestLinkShopee({ url: URL_SHOPEE, timeoutMs: 1 }), /Limite de links da Shopee por hora atingido/);
  // pedidos com resposta contam igual (o portal gerou um link)
  rel.t += 3600001;
  await comExtensao(links, () => links.requestLinkShopee({ url: URL_SHOPEE }), { ok: true, link: CURTO });
  await comExtensao(links, () => links.requestLinkShopee({ url: URL_SHOPEE }), { ok: false, error: 'x' });
  await links.poll(1);
  await assert.rejects(links.requestLinkShopee({ url: URL_SHOPEE, timeoutMs: 1 }), /Limite de links da Shopee por hora atingido/);

  // simulação: sem extensão e sem teto
  const fake = createLinkService({ getMode: () => 'fake', limiteShopeeHora: 1 });
  for (let i = 0; i < 5; i++) assert.match((await fake.requestLinkShopee({ url: URL_SHOPEE })).link, /^https:\/\/s\.shopee\.com\.br\/fake\d+$/);
  // limite inválido vale o padrão (60), nunca "sem limite" nem "zero"
  for (const limiteShopeeHora of [0, -1, 1.5, Infinity, '10', null]) {
    const l = createLinkService({ getMode: () => 'extension', limiteShopeeHora });
    const r = await pedidosQueExpiram(l, 60);
    assert.ok(r.every((x) => /não respondeu a tempo/.test(x.erro?.message)), String(limiteShopeeHora));
    await assert.rejects(l.requestLinkShopee({ url: URL_SHOPEE, timeoutMs: 1 }), /Limite de links da Shopee/, String(limiteShopeeHora));
  }
});

test('R3/S2: vagasShopee() diz quantos pedidos link_shopee ainda cabem na janela de 1 h (off-line, URL inválida e simulação não gastam)', async () => {
  const rel = { t: 1_700_000_000_000 };
  const links = createLinkService({ getMode: () => 'extension', limiteShopeeHora: 3, agora: () => rel.t });
  assert.equal(links.vagasShopee(), 3);
  await assert.rejects(links.requestLinkShopee({ url: URL_SHOPEE }), /não está conectada/);
  await assert.rejects(links.requestLinkShopee({ url: 'https://evil.com/x' }), /inválido/);
  assert.equal(links.vagasShopee(), 3, 'off-line e URL inválida não gastam vaga');
  await pedidosQueExpiram(links, 1);
  rel.t += 30 * 60000;
  await comExtensao(links, () => links.requestLinkShopee({ url: URL_SHOPEE, subId: 'b1' }), { ok: true, link: CURTO, sub_id_aplicado: true });
  assert.equal(links.vagasShopee(), 1, 'com ou sem Sub_id, com ou sem resposta, cada pedido entregue gasta uma vaga');
  await pedidosQueExpiram(links, 1);
  assert.equal(links.vagasShopee(), 0);
  await assert.rejects(links.requestLinkShopee({ url: URL_SHOPEE, timeoutMs: 1 }), /Limite de links da Shopee por hora atingido/);
  assert.equal(links.vagasShopee(), 0, 'nunca fica negativo');
  // a janela anda: o 1º pedido sai dela depois de 1 h; os outros dois, 30 min depois
  rel.t += 30 * 60000 + 1;
  assert.equal(links.vagasShopee(), 1);
  rel.t += 30 * 60000;
  assert.equal(links.vagasShopee(), 3);
  // simulação: o teto não vale, as vagas não mudam
  const fake = createLinkService({ getMode: () => 'fake', limiteShopeeHora: 2 });
  for (let i = 0; i < 3; i++) await fake.requestLinkShopee({ url: URL_SHOPEE, subId: 'b1' });
  assert.equal(fake.vagasShopee(), 2);
  // limite inválido vale o padrão (60)
  assert.equal(createLinkService({ getMode: () => 'extension', limiteShopeeHora: 0 }).vagasShopee(), 60);
});
