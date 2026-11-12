// Oferta "mais barata" na fila de envios (plano nao-repetir-produto-parecido, etapa 4; CA4 e CA5): o "Enviar" do
// Catálogo grava `mais_barata: { preco_anterior }` (centavos) no payload; a fila (src/envios.js, preparar('oferta'))
// confere o preço de novo depois do verificador e só então manda a mensagem com a FRASE_MAIS_BARATA na primeira linha.
// Preço conferido que não está pelo menos 5% abaixo do anterior (adendo do plano, D11) → descartada (preco_subiu),
// sem link e sem envio. Marca inválida → descartada
// (nao_conferido). A marca só vale na origem 'catalogo'. Envio gravado direto no banco, como o catálogo grava; o
// verificador é o de verdade (src/verificador.js) com leitor do ML falso; WhatsApp simulado; fetch global bloqueado.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createLinkService } from '../src/links.js';
import { createEnvios } from '../src/envios.js';
import { createCatalogoItens } from '../src/catalogo-itens.js';
import { LINHA_ULTIMO_ENVIO } from '../src/template.js';
import { createVerificador } from '../src/verificador.js';
import { FRASE_MAIS_BARATA, textoPassou } from '../src/parecido.js';

let acessosRede = 0;
globalThis.fetch = async () => { acessosRede++; throw new Error('rede proibida no teste'); };

const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-parecido-env-')); pastas.push(p); return p; };

const MIN = 60 * 1000;
const URL_ML_PRODUTO = 'https://produto.mercadolivre.com.br/MLB-1234567890';
const IMG = 'https://http2.mlstatic.com/D_NQ_NP_123-O.jpg';
const G1 = '111@g.us';
const G2 = '222@g.us';
const CORPO = '{TITULO_PRODUTO}\nPor {PRECO_PRODUTO}\n{LINK}';
const CORPO_CURTO = 'Olha esta: {LINK}';
const TEXTO_DA_ETAPA = (preco) => `Perfume Bom\nPor ${preco}`;
const FRASE_DESCARTE = (conferido, anterior) => `Descartada: preço subiu para ${conferido} e não está mais pelo menos 5% abaixo do da mesma oferta enviada antes (${anterior})`;

/** Leitor do ML falso: o que a loja diz na conferência (preço e estoque). */
function mlFalso() {
  const estado = { leitura: { price: 90, disponivel: true } };
  const conferencias = [];
  return {
    estado, conferencias,
    async resolveOffer() { throw new Error('não deveria ler o produto'); },
    async conferirProduto(url) { conferencias.push(url); return { ...estado.leitura }; },
  };
}

/** Banco, WhatsApp simulado, links falsos com espião, dois grupos, a etiqueta e dois templates; `verificar: false` = sem verificador. */
function montar({ verificar = true } = {}) {
  const dir = tmp();
  const db = openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const pedidosDeLink = [];
  const requestLink = links.requestLink;
  links.requestLink = async (o) => { pedidosDeLink.push(o.url); return requestLink(o); };
  const ml = mlFalso();
  const verificador = verificar ? createVerificador({ db, ml, amazon: null, shopee: null }) : null;
  const envios = createEnvios({ db, wa, links, ml, fast: true, dir, acordar: () => {}, verificador });
  for (const [jid, nome] of [[G1, 'Achadinhos'], [G2, 'Tech']]) {
    db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, nome, 10, Date.now());
  }
  db.prepare('INSERT INTO tags (name, created_at) VALUES (?, 1)').run('etiquetaA');
  const novoTpl = (nome, corpo) => {
    const criado = Date.now();
    return { id: Number(db.prepare('INSERT INTO templates (name, body, created_at) VALUES (?,?,?)').run(nome, corpo, criado).lastInsertRowid), criado };
  };
  return { dir, db, wa, links, ml, envios, pedidosDeLink, tpl: novoTpl('Com preço', CORPO), tplCurto: novoTpl('Curto', CORPO_CURTO) };
}

/** Payload do "Enviar" do Catálogo (src/catalogo-itens.js), com a marca em `extra`. Preço gravado = o aprovado. */
function payloadCatalogo(s, { preco = 90, foto = false, tpl = s.tpl, ...extra } = {}) {
  return {
    url: URL_ML_PRODUTO, loja: 'mercadolivre', tag_id: 1, etiqueta: 'etiquetaA', template_id: tpl.id, template_criado_em: tpl.criado,
    fonte_dados: 'manual', enviar_foto: foto,
    origem: { tipo: 'catalogo', rule_id: 4, nome: 'Perfumes' },
    offer: { key: 'MLB1234567890', title: 'Perfume Bom', price: preco, oldPrice: null, discountPct: null, sold: null, freeShipping: false, coupon: null, image: foto ? IMG : null },
    ...extra,
  };
}

/** Envio gravado direto, como o catálogo grava. → id */
function gravar(s, payload, { jids = [G1, G2], criadoHa = 2 * MIN } = {}) {
  const agora = Date.now();
  return Number(s.db.prepare(`INSERT INTO envios (tipo, payload, group_jids, quando, status, next_run_at, created_at)
    VALUES ('oferta', ?, ?, 'agora', 'pendente', ?, ?)`).run(JSON.stringify(payload), JSON.stringify(jids), agora, agora - criadoHa).lastInsertRowid);
}

const envio = (s, id) => ({ ...s.db.prepare('SELECT * FROM envios WHERE id = ?').get(id) });
const resultadoDe = (s, id) => JSON.parse(envio(s, id).resultado);
const resultadosDe = (s, id) => s.db.prepare('SELECT jid, group_name, ok, erro FROM envio_resultados WHERE envio_id = ? ORDER BY id').all(id).map((r) => ({ ...r }));
const logs = (s) => s.db.prepare('SELECT rule_name, level, group_name, offer_title, message FROM log ORDER BY id').all().map((r) => ({ ...r }));
const semFrase = (t) => !String(t).includes(FRASE_MAIS_BARATA) && !String(t).includes('oportunidade ainda melhor');

test('CA5: com a marca e o preço da loja ainda menor, sai com a frase na primeira linha e uma linha em branco, em cada grupo, com texto puro', async () => {
  const s = montar();
  const id = gravar(s, payloadCatalogo(s, { preco: 90, mais_barata: { preco_anterior: 10000 } }));
  await s.envios.runEnvio(id);

  assert.equal(envio(s, id).status, 'concluido');
  assert.deepEqual(s.ml.conferencias, [URL_ML_PRODUTO], 'a conferência de preço continua sendo feita, uma vez');
  assert.equal(s.wa.simulated.length, 2);
  for (const m of s.wa.simulated) {
    assert.equal(m.tipo, 'text');
    assert.ok(m.text.startsWith(`${FRASE_MAIS_BARATA}\n\n${TEXTO_DA_ETAPA('R$ 90,00')}\n`), 'frase, linha em branco e só então a mensagem da regra');
    assert.match(m.text, /\nhttps:\/\/meli\.la\/fake-etiquetaA-\d+$/);
    assert.equal(m.text.split(FRASE_MAIS_BARATA).length, 2, 'a frase aparece uma vez só');
  }
  assert.deepEqual(logs(s).map((l) => [l.level, l.group_name, l.message]),
    [['ok', 'Achadinhos', 'Enviado com a etiqueta etiquetaA'], ['ok', 'Tech', 'Enviado com a etiqueta etiquetaA']]);
  assert.ok(!logs(s).some((l) => l.message.includes('oportunidade')), 'a frase vai na mensagem, não no Histórico');
});

test('CA5: a frase vai com qualquer template (sem preço, curto) e também com foto: na legenda', async () => {
  const s = montar();
  const curto = gravar(s, payloadCatalogo(s, { preco: 90, tpl: s.tplCurto, mais_barata: { preco_anterior: 10000 } }), { jids: [G1] });
  await s.envios.runEnvio(curto);
  assert.match(s.wa.simulated.at(-1).text, new RegExp(`^${FRASE_MAIS_BARATA}\\n\\nOlha esta: https://meli\\.la/fake-etiquetaA-\\d+$`, 'u'));

  const comFoto = gravar(s, payloadCatalogo(s, { preco: 90, foto: true, mais_barata: { preco_anterior: 10000 } }), { jids: [G1, G2] });
  await s.envios.runEnvio(comFoto);
  const fotos = s.wa.simulated.slice(-2);
  assert.deepEqual(fotos.map((m) => [m.tipo, m.image]), [['image', IMG], ['image', IMG]]);
  for (const m of fotos) assert.ok(m.text.startsWith(`${FRASE_MAIS_BARATA}\n\n${TEXTO_DA_ETAPA('R$ 90,00')}\n`), 'legenda com a frase na primeira linha');
  assert.equal(envio(s, comFoto).status, 'concluido');
});

test('CA5: foto que não carrega cai para o texto, e o texto também leva a frase', async () => {
  const s = montar();
  s.wa.sendImage = async () => { throw new Error('foto não carregou'); };
  const id = gravar(s, payloadCatalogo(s, { preco: 90, foto: true, mais_barata: { preco_anterior: 10000 } }), { jids: [G1] });
  await s.envios.runEnvio(id);
  assert.deepEqual(s.wa.simulated.map((m) => m.tipo), ['text']);
  assert.ok(s.wa.simulated[0].text.startsWith(`${FRASE_MAIS_BARATA}\n\nPerfume Bom\n`));
  assert.deepEqual(logs(s).map((l) => [l.level, l.message]), [['ok', 'Enviado com a etiqueta etiquetaA (sem a foto: ela não carregou)']]);
});

test('CA5: sem a marca a mensagem é a de sempre (sem frase); o texto com a marca é o mesmo com a frase na frente', async () => {
  const s = montar();
  const sem = gravar(s, payloadCatalogo(s, { preco: 90 }), { jids: [G1] });
  await s.envios.runEnvio(sem);
  const com = gravar(s, payloadCatalogo(s, { preco: 90, mais_barata: { preco_anterior: 10000 } }), { jids: [G1] });
  await s.envios.runEnvio(com);

  const [textoSem, textoCom] = s.wa.simulated.map((m) => m.text);
  assert.ok(semFrase(textoSem));
  assert.ok(textoSem.startsWith('Perfume Bom\nPor R$ 90,00\nhttps://meli.la/fake-etiquetaA-'), 'texto de hoje, sem linha a mais');
  assert.equal(textoCom.slice(FRASE_MAIS_BARATA.length + 2).replace(/fake-etiquetaA-\d+/, 'X'), textoSem.replace(/fake-etiquetaA-\d+/, 'X'));
  assert.equal(envio(s, sem).status, 'concluido');
});

test('CA4: o verificador sobe o preço (dentro do limite) acima do anterior: descartada, sem link, sem mensagem, com a frase no Histórico e em cada grupo', async () => {
  const s = montar();
  s.ml.estado.leitura = { price: 100.5, disponivel: true }; // gravada em R$ 98,00: +2,6% (dentro dos 5% do verificador), mas passa dos R$ 95,00 (5% abaixo dos R$ 100,00 de antes)
  const id = gravar(s, payloadCatalogo(s, { preco: 98, mais_barata: { preco_anterior: 10000 } }));
  await s.envios.runEnvio(id);

  const texto = FRASE_DESCARTE('R$ 100,50', 'R$ 100,00');
  assert.equal(envio(s, id).status, 'erro', 'o descartado termina em erro (como o do verificador)');
  assert.deepEqual(resultadoDe(s, id), { ok: 0, erro: 2, motivo: texto, descartado: 'preco_subiu' });
  assert.deepEqual(resultadosDe(s, id), [
    { jid: G1, group_name: 'Achadinhos', ok: 0, erro: texto },
    { jid: G2, group_name: 'Tech', ok: 0, erro: texto },
  ]);
  assert.deepEqual(logs(s), [{ rule_name: 'Catálogo: Perfumes', level: 'aviso', group_name: null, offer_title: 'Perfume Bom', message: texto }],
    'uma linha aviso com a frase de preço; nenhuma erro');
  assert.equal(s.wa.simulated.length, 0, 'nenhum grupo recebe');
  assert.deepEqual(s.pedidosDeLink, [], 'a descartada não pede link');
});

test('CA4 (D11): limite exato dos 5% depois da conferência: contra R$ 100,00, R$ 95,00 sai com o preço atualizado e a frase; 95,01, 99,99 e 100,00 barram', async () => {
  const s = montar();
  // gravado perto do que a loja diz: subida acima de 5% seria descartada antes pelo verificador
  for (const [gravado, loja] of [[98, 100], [98, 99.99], [93, 95.01]]) {
    s.ml.estado.leitura = { price: loja, disponivel: true };
    const id = gravar(s, payloadCatalogo(s, { preco: gravado, mais_barata: { preco_anterior: 10000 } }), { jids: [G1] });
    await s.envios.runEnvio(id);
    const conferido = `R$ ${loja.toFixed(2).replace('.', ',')}`;
    assert.deepEqual(resultadoDe(s, id), { ok: 0, erro: 1, motivo: FRASE_DESCARTE(conferido, 'R$ 100,00'), descartado: 'preco_subiu' }, conferido);
  }
  assert.equal(s.wa.simulated.length, 0);
  assert.deepEqual(s.pedidosDeLink, [], 'as descartadas não pedem link');

  s.ml.estado.leitura = { price: 95, disponivel: true };
  const limite = gravar(s, payloadCatalogo(s, { preco: 93, mais_barata: { preco_anterior: 10000 } }), { jids: [G1] });
  await s.envios.runEnvio(limite);
  assert.equal(envio(s, limite).status, 'concluido');
  assert.ok(s.wa.simulated[0].text.startsWith(`${FRASE_MAIS_BARATA}\n\nPerfume Bom\nPor R$ 95,00\n`), 'o preço que vai é o conferido');
  assert.match(logs(s).at(-1).message, /preço atualizado de R\$ 93,00 para R\$ 95,00$/);
});

test('CA4: com o preço da loja que caiu, continua saindo com a frase (e o preço novo)', async () => {
  const s = montar();
  s.ml.estado.leitura = { price: 86, disponivel: true };
  const id = gravar(s, payloadCatalogo(s, { preco: 90, mais_barata: { preco_anterior: 10000 } }), { jids: [G1] });
  await s.envios.runEnvio(id);
  assert.equal(envio(s, id).status, 'concluido');
  assert.ok(s.wa.simulated[0].text.startsWith(`${FRASE_MAIS_BARATA}\n\nPerfume Bom\nPor R$ 86,00\n`));
});

test('CA4: sem verificador, vale o preço gravado: 5% abaixo sai com a frase; menos que isso (ou igual) é descartada', async () => {
  const s = montar({ verificar: false });
  const ok = gravar(s, payloadCatalogo(s, { preco: 95, mais_barata: { preco_anterior: 10000 } }), { jids: [G1] });
  await s.envios.runEnvio(ok);
  assert.equal(envio(s, ok).status, 'concluido');
  assert.ok(s.wa.simulated[0].text.startsWith(`${FRASE_MAIS_BARATA}\n\nPerfume Bom\nPor R$ 95,00\n`));

  for (const [preco, texto] of [[95.01, 'R$ 95,01'], [99.99, 'R$ 99,99'], [100, 'R$ 100,00']]) {
    const id = gravar(s, payloadCatalogo(s, { preco, mais_barata: { preco_anterior: 10000 } }), { jids: [G1] });
    await s.envios.runEnvio(id);
    assert.deepEqual(resultadoDe(s, id), { ok: 0, erro: 1, motivo: FRASE_DESCARTE(texto, 'R$ 100,00'), descartado: 'preco_subiu' }, texto);
  }
  assert.equal(s.wa.simulated.length, 1, 'a descartada não manda nada');
});

test('CA4: preço de centavos quebrados compara em centavos inteiros (0,1 + 0,2 não vira 30,000000000000004)', async () => {
  const s = montar({ verificar: false });
  // 0.1 + 0.2 = 0.30000000000000004 → 30 centavos: igual a 30, não menor → descartada
  const igual = gravar(s, payloadCatalogo(s, { preco: 0.1 + 0.2, mais_barata: { preco_anterior: 30 } }), { jids: [G1] });
  await s.envios.runEnvio(igual);
  assert.equal(resultadoDe(s, igual).descartado, 'preco_subiu');
  // 5,7 × 100 = 570,0000000000001 em ponto flutuante; em centavos, 570 × 100 = 600 × 95: exatamente 5% abaixo, sai
  const limite = gravar(s, payloadCatalogo(s, { preco: 5.7, mais_barata: { preco_anterior: 600 } }), { jids: [G1] });
  await s.envios.runEnvio(limite);
  assert.equal(envio(s, limite).status, 'concluido');
  const acima = gravar(s, payloadCatalogo(s, { preco: 5.71, mais_barata: { preco_anterior: 600 } }), { jids: [G1] });
  await s.envios.runEnvio(acima);
  assert.equal(resultadoDe(s, acima).descartado, 'preco_subiu');
});

test('CA4: marca inválida falha fechada (nao_conferido), sem conferir a loja, sem link e sem mensagem', async () => {
  const s = montar();
  const invalidas = [
    ['zero', { preco_anterior: 0 }], ['negativo', { preco_anterior: -5 }], ['fracionário', { preco_anterior: 99.9 }],
    ['texto', { preco_anterior: '9990' }], ['nulo', { preco_anterior: null }], ['ausente', {}],
    ['infinito', { preco_anterior: Infinity }], ['marca nula', null], ['marca booleana', true], ['marca texto', '10000'],
  ];
  for (const [nome, marca] of invalidas) {
    const id = gravar(s, payloadCatalogo(s, { preco: 90, mais_barata: marca }), { jids: [G1] });
    await s.envios.runEnvio(id);
    assert.equal(envio(s, id).status, 'erro', nome);
    assert.deepEqual(resultadoDe(s, id), { ok: 0, erro: 1, motivo: 'Descartada: não deu para conferir o preço', descartado: 'nao_conferido' }, nome);
  }
  assert.equal(s.wa.simulated.length, 0);
  assert.deepEqual(s.ml.conferencias, [], 'a marca inválida nem chega à conferência na loja');
  assert.deepEqual(s.pedidosDeLink, []);
  assert.ok(logs(s).every((l) => l.level === 'aviso' && l.message === 'Descartada: não deu para conferir o preço'));
});

test('CA4: preço conferido ilegível (sem preço na oferta) com a marca = não conferido, nunca sai com a frase', async () => {
  const s = montar({ verificar: false });
  for (const preco of [null, 0, 'abc']) {
    const id = gravar(s, payloadCatalogo(s, { preco, mais_barata: { preco_anterior: 10000 } }), { jids: [G1] });
    await s.envios.runEnvio(id);
    assert.deepEqual(resultadoDe(s, id), { ok: 0, erro: 1, motivo: 'Descartada: não deu para conferir o preço', descartado: 'nao_conferido' }, String(preco));
  }
  assert.equal(s.wa.simulated.length, 0);
});

test('CA5: a marca só vale na origem catálogo: manual, espelho, remetente e sem origem a ignoram (nem frase, nem descarte, nem validação)', async () => {
  const s = montar();
  s.ml.estado.leitura = { price: 150, disponivel: true }; // o catálogo seria descartado (150 > 100); as outras origens não olham a marca
  const origens = [
    ['manual', { tipo: 'manual' }], ['espelho', { tipo: 'espelho', espelho_id: 3, nome: 'Amazon' }],
    ['remetente', { tipo: 'remetente', remetente_id: 1, nome: 'Sócio' }], ['sem origem', undefined],
  ];
  for (const marca of [{ preco_anterior: 10000 }, { preco_anterior: 'lixo' }, null]) {
    for (const [nome, origem] of origens) {
      const antes = s.wa.simulated.length;
      const id = gravar(s, { ...payloadCatalogo(s, { preco: 148, mais_barata: marca }), origem }, { jids: [G1] });
      await s.envios.runEnvio(id);
      assert.equal(envio(s, id).status, 'concluido', `${nome} ${JSON.stringify(marca)}`);
      assert.equal(s.wa.simulated.length, antes + 1);
      assert.ok(semFrase(s.wa.simulated.at(-1).text), `${nome}: sem a frase`);
      assert.match(s.wa.simulated.at(-1).text, /Por R\$ 150,00/, `${nome}: o preço conferido vai como sempre`);
    }
  }
});

test('CA5: nenhuma outra mensagem leva a frase: oferta sem marca de qualquer origem, mensagem e enquete', async () => {
  const s = montar();
  const sem = gravar(s, payloadCatalogo(s, { preco: 90 }), { jids: [G1] });
  await s.envios.runEnvio(sem);
  const manual = await s.envios.criar({ tipo: 'mensagem', texto: 'Oi, tudo bem?', group_jids: [G1], quando: 'agora' });
  await s.envios.runEnvio(manual.id);
  const enquete = await s.envios.criar({ tipo: 'enquete', pergunta: 'Qual?', opcoes: ['A', 'B'], group_jids: [G1], quando: 'agora' });
  await s.envios.runEnvio(enquete.id);
  assert.equal(s.wa.simulated.length, 3);
  assert.ok(s.wa.simulated.every((m) => semFrase(m.text)));
});

test('nada do que a etapa faz usa a rede nem leva número ou JID ao Histórico', async () => {
  const s = montar();
  s.ml.estado.leitura = { price: 120, disponivel: true };
  await s.envios.runEnvio(gravar(s, payloadCatalogo(s, { preco: 118, mais_barata: { preco_anterior: 10000 } })));
  const todo = JSON.stringify(logs(s)) + JSON.stringify(s.db.prepare('SELECT erro FROM envio_resultados').all().map((r) => ({ ...r })));
  assert.ok(!/@g\.us|\d{8,}/.test(todo), 'sem JID nem número no texto');
  assert.equal(acessosRede, 0, 'o fetch global nunca foi chamado');
});

// ------------------------------------------------------------------- "Saiu como oportunidade melhor" (achados R5/Q3)
// O "Enviar" do Catálogo grava também `parecida_anterior: { titulo, enviada_em }`, só para o texto do Histórico; a
// linha sai da fila, depois de a oferta chegar a algum grupo, com o preço conferido. Descartada ou falha total: nada.
const ANTERIOR = { titulo: 'Perfume Bom Floral 100ml', enviada_em: new Date(2026, 10, 10, 9, 2).getTime() };
const passouDe = (precoNovo, preco = 10000) => textoPassou({ title: ANTERIOR.titulo, preco, sent_at: ANTERIOR.enviada_em }, precoNovo, Date.now());
const saiuComo = (s) => logs(s).filter((l) => l.message.startsWith('Saiu como oportunidade melhor'));

test('R5/Q3: com parecida_anterior, a linha "Saiu como oportunidade melhor" vem uma vez, depois dos grupos, com o preço conferido', async () => {
  const s = montar();
  s.ml.estado.leitura = { price: 86, disponivel: true };
  const id = gravar(s, payloadCatalogo(s, { preco: 90, mais_barata: { preco_anterior: 10000 }, parecida_anterior: ANTERIOR }));
  await s.envios.runEnvio(id);
  assert.equal(envio(s, id).status, 'concluido');
  assert.deepEqual(logs(s).map((l) => l.level), ['ok', 'ok', 'info'], 'a linha vem depois das linhas de envio');
  assert.deepEqual(logs(s).at(-1), { rule_name: 'Catálogo: Perfumes', level: 'info', group_name: null, offer_title: 'Perfume Bom', message: passouDe(86) });
  assert.match(passouDe(86), /^Saiu como oportunidade melhor: o mesmo produto saiu às 09:02( de 10\/11)? por R\$ 100,00 \("Perfume Bom Floral 100ml"\); agora por R\$ 86,00\.$/);
});

test('R5/Q3: descartada na fila (preço subiu) ou sem nenhum grupo ok: a linha "Saiu como…" não aparece', async () => {
  const s = montar();
  s.ml.estado.leitura = { price: 100, disponivel: true };
  const subiu = gravar(s, payloadCatalogo(s, { preco: 98, mais_barata: { preco_anterior: 10000 }, parecida_anterior: ANTERIOR }), { jids: [G1] });
  await s.envios.runEnvio(subiu);
  assert.equal(resultadoDe(s, subiu).descartado, 'preco_subiu');
  assert.deepEqual(saiuComo(s), []);

  s.ml.estado.leitura = { price: 90, disponivel: true };
  s.wa.sendText = async () => { throw new Error('socket caiu'); };
  const falhou = gravar(s, payloadCatalogo(s, { preco: 90, mais_barata: { preco_anterior: 10000 }, parecida_anterior: ANTERIOR }));
  await s.envios.runEnvio(falhou);
  assert.equal(resultadoDe(s, falhou).ok, 0);
  assert.deepEqual(saiuComo(s), [], 'falha em todos os grupos: não saiu');
});

test('R5/Q3: retomada na mesma ocorrência com um grupo já ok não repete a linha', async () => {
  const s = montar();
  const id = gravar(s, payloadCatalogo(s, { preco: 90, mais_barata: { preco_anterior: 10000 }, parecida_anterior: ANTERIOR }));
  const { next_run_at: ocorrencia } = envio(s, id);
  // o G1 já recebeu nesta ocorrência (a linha "Saiu como…" saiu naquela vez); agora falta só o G2
  s.db.prepare('INSERT INTO envio_resultados (envio_id, ocorrencia, ts, jid, group_name, ok, erro) VALUES (?,?,?,?,?,1,NULL)').run(id, ocorrencia, Date.now(), G1, 'Achadinhos');
  await s.envios.runEnvio(id);
  assert.equal(s.wa.simulated.length, 1, 'só o G2');
  assert.ok(s.wa.simulated[0].text.startsWith(FRASE_MAIS_BARATA));
  assert.deepEqual(saiuComo(s), []);
});

test('R5/Q3: parecida_anterior ausente ou inválida não muda o envio (sai com a frase) e só tira a linha; sem a marca, é ignorada', async () => {
  const s = montar();
  const ruins = [undefined, null, 'texto', { titulo: '', enviada_em: ANTERIOR.enviada_em }, { titulo: 7, enviada_em: ANTERIOR.enviada_em },
    { titulo: ANTERIOR.titulo }, { titulo: ANTERIOR.titulo, enviada_em: 'ontem' }, { titulo: ANTERIOR.titulo, enviada_em: NaN }];
  for (const pa of ruins) {
    const antes = s.wa.simulated.length;
    const id = gravar(s, payloadCatalogo(s, { preco: 90, mais_barata: { preco_anterior: 10000 }, ...(pa === undefined ? {} : { parecida_anterior: pa }) }), { jids: [G1] });
    await s.envios.runEnvio(id);
    assert.equal(envio(s, id).status, 'concluido', JSON.stringify(pa));
    assert.equal(s.wa.simulated.length, antes + 1);
    assert.ok(s.wa.simulated.at(-1).text.startsWith(FRASE_MAIS_BARATA), 'a marca válida manda a frase');
  }
  // sem a marca (ou em outra origem), o campo sozinho não faz nada
  const semMarca = gravar(s, payloadCatalogo(s, { preco: 90, parecida_anterior: ANTERIOR }), { jids: [G1] });
  await s.envios.runEnvio(semMarca);
  assert.ok(semFrase(s.wa.simulated.at(-1).text));
  const manual = gravar(s, { ...payloadCatalogo(s, { preco: 90, mais_barata: { preco_anterior: 10000 }, parecida_anterior: ANTERIOR }), origem: { tipo: 'manual' } }, { jids: [G1] });
  await s.envios.runEnvio(manual);
  assert.ok(semFrase(s.wa.simulated.at(-1).text));
  assert.deepEqual(saiuComo(s), []);
});

// ------------------------------------------------- "Baixou de … para …" (plano baixou-de-para, etapa 6: CA1, CA2, CA6)
// O "Enviar" do Catálogo grava `preco_ultimo_envio` (centavos) no payload, lido de `sent_offers` antes da reserva; a
// fila (preparar) mostra o {PRECO_ULTIMO_ENVIO} só se o preço conferido continua pelo menos 5% abaixo dele, e só na
// origem 'catalogo'. É enfeite: valor ruim ou preço que subiu deixa a linha de fora, sem descartar nem travar o envio.

const DIAS = 24 * 60 * MIN;
const NOME_FLORAL = 'Perfume Bom Floral 100ml';
const LINHA = (de, para) => `📉 Baixou de ~R$ ${de}~ para *R$ ${para}*`;
const CORPO_BAIXOU = `{TITULO_PRODUTO}\nPor {PRECO_PRODUTO}\n${LINHA_ULTIMO_ENVIO}\n{LINK}`;
const REGEX_SEM_LINHA = /Baixou|📉|\[|\]|~/;

/** Montagem com o Catálogo real (createCatalogoItens) ligado à fila de envios real, e um template com a linha. */
function montarCatalogo() {
  const s = montar();
  const criado = Date.now();
  s.tplBaixou = { id: Number(s.db.prepare('INSERT INTO templates (name, body, created_at) VALUES (?,?,?)').run('Com baixou', CORPO_BAIXOU, criado).lastInsertRowid), criado };
  s.itens = createCatalogoItens({ db: s.db, wa: s.wa, links: s.links, amazon: null, envios: s.envios, acordar: () => {} });
  s.regra = (extra = {}) => {
    const r = { name: 'Perfumes', dedupe_days: 7, ...extra };
    const id = Number(s.db.prepare('INSERT INTO rules (name, tag_id, template_id, group_jids, dedupe_days, send_image, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(r.name, 1, s.tplBaixou.id, JSON.stringify([G1]), r.dedupe_days, 0, Date.now()).lastInsertRowid);
    return { id, name: r.name, dedupe_days: r.dedupe_days };
  };
  s.candidata = (n = 1234567890, extra = {}) => ({ key: `MLB${n}`, title: NOME_FLORAL, price: 252, oldPrice: null, discountPct: null, sold: null, freeShipping: false, coupon: null, image: null, categoria: 'Perfumes', tag_id: null, source_index: 0, ...extra });
  s.revisao = (regra, c) => {
    assert.equal(s.itens.registrar(regra, c, 'revisao', ['falha_link']), true);
    return s.db.prepare('SELECT id FROM catalogo_itens WHERE rule_id = ? AND chave = ?').get(regra.id, c.key).id;
  };
  s.jaSaiu = (regra, { key, title = NOME_FLORAL, preco, ha }) => s.db.prepare('INSERT INTO sent_offers (rule_id, offer_key, sent_at, title, price_cents) VALUES (?,?,?,?,?)')
    .run(regra.id, key, Date.now() - ha, title, preco);
  s.payloadDo = (envioId) => JSON.parse(envio(s, envioId).payload);
  return s;
}

test('baixou (Catálogo): "Enviar" com o mesmo produto enviado antes por R$ 299,00 grava o preço no payload e a mensagem sai com a linha', async () => {
  const s = montarCatalogo();
  s.ml.estado.leitura = { price: 252, disponivel: true };
  const regra = s.regra();
  s.jaSaiu(regra, { key: 'MLB1234567890', preco: 29900, ha: 8 * DIAS }); // a mesma chave já passou dos 7 dias da regra
  const { envio_id: id } = await s.itens.enviar(s.revisao(regra, s.candidata()), {});
  assert.equal(s.payloadDo(id).preco_ultimo_envio, 29900, 'centavos, lido antes da reserva');
  await s.envios.runEnvio(id);
  assert.equal(envio(s, id).status, 'concluido');
  assert.equal(s.wa.simulated.length, 1);
  assert.match(s.wa.simulated[0].text, new RegExp(`^${NOME_FLORAL}\\nPor R\\$ 252,00\\n${LINHA('299,00', '252,00').replace(/[$*]/g, '\\$&')}\\nhttps://meli\\.la/\\S+$`, 'u'));
  assert.ok(semFrase(s.wa.simulated[0].text), 'a mesma chave não leva a frase 🔎');
  assert.deepEqual(resultadosDe(s, id).map((r) => r.ok), [1]);
});

test('baixou (Catálogo): o mesmo título com outra chave conta; parecido, outra regra e mais de 30 dias não; sem envio anterior, o payload fica sem o campo', async () => {
  const casos = [
    ['mesmo título, outra chave', { key: 'MLB999', title: NOME_FLORAL, preco: 29900, ha: 8 * DIAS }, 29900],
    ['29 dias atrás', { key: 'MLB1234567890', preco: 29900, ha: 29 * DIAS }, 29900],
    ['31 dias atrás', { key: 'MLB1234567890', preco: 29900, ha: 31 * DIAS }, undefined],
    ['parecido (outro volume) não conta', { key: 'MLB998', title: 'Perfume Bom Floral 50ml Gold', preco: 29900, ha: 8 * DIAS }, undefined],
    ['sem preço guardado', { key: 'MLB1234567890', preco: null, ha: 8 * DIAS }, undefined],
    ['outra regra', { key: 'MLB1234567890', preco: 29900, ha: 8 * DIAS, outra: true }, undefined],
    ['sem envio anterior', null, undefined],
  ];
  for (const [nome, anterior, esperado] of casos) {
    const s = montarCatalogo();
    s.ml.estado.leitura = { price: 252, disponivel: true };
    const regra = s.regra(); const outra = s.regra({ name: 'Outra' });
    if (anterior) s.jaSaiu(anterior.outra ? outra : regra, anterior);
    const { envio_id: id } = await s.itens.enviar(s.revisao(regra, s.candidata()), {});
    const p = s.payloadDo(id);
    assert.equal(p.preco_ultimo_envio, esperado, nome);
    assert.equal(Object.hasOwn(p, 'preco_ultimo_envio'), esperado !== undefined, `${nome}: campo só quando há referência`);
    await s.envios.runEnvio(id);
    const texto = s.wa.simulated[0].text;
    if (esperado) assert.ok(texto.includes(LINHA('299,00', '252,00')), `${nome}: ${texto}`);
    else assert.doesNotMatch(texto, REGEX_SEM_LINHA, nome);
  }
});

test('baixou (Catálogo): a própria reserva do "Enviar" não conta, nem no "Enviar de novo" de um envio que falhou', async () => {
  const s = montarCatalogo();
  s.ml.estado.leitura = { price: 300, disponivel: true };
  const regra = s.regra();
  const item = s.revisao(regra, s.candidata(1234567890, { price: 300 }));
  const falhar = (sim) => { s.wa.sendText = sim ? async () => { throw new Error('socket caiu'); } : s.reais.sendText; };
  s.reais = { sendText: s.wa.sendText };
  falhar(true);
  const r1 = await s.itens.enviar(item, {});
  assert.equal(Object.hasOwn(s.payloadDo(r1.envio_id), 'preco_ultimo_envio'), false, 'sem envio anterior');
  await s.envios.processarPendentes();
  assert.equal(s.wa.simulated.length, 0);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM sent_offers WHERE offer_key = ?').get('MLB1234567890').n, 1, 'a reserva do 1º envio continua lá (R$ 300,00)');

  // reenvio, agora a R$ 250,00: se a reserva de R$ 300,00 contasse, sairia "Baixou de R$ 300,00 para R$ 250,00"
  falhar(false);
  s.ml.estado.leitura = { price: 250, disponivel: true };
  const r2 = await s.itens.enviar(item, { ajustes: { price: '250' } });
  assert.equal(Object.hasOwn(s.payloadDo(r2.envio_id), 'preco_ultimo_envio'), false, 'a reserva do envio que falhou saiu antes da busca');
  await s.envios.runEnvio(r2.envio_id);
  assert.equal(s.wa.simulated.length, 1);
  assert.doesNotMatch(s.wa.simulated[0].text, REGEX_SEM_LINHA);
  assert.match(s.wa.simulated[0].text, /Por R\$ 250,00/);
});

test('baixou (Catálogo, S1): a reserva passa a guardar o preço CONFERIDO que o grupo viu; o "Baixou de" seguinte compara com ele, não com o aprovado', async () => {
  const s = montarCatalogo();
  const regra = s.regra();
  const reserva = () => s.db.prepare('SELECT price_cents, sent_at FROM sent_offers WHERE rule_id = ? AND offer_key = ?').get(regra.id, 'MLB1234567890');
  // aprovado a R$ 299,00, a loja confere R$ 249,00 (a queda não derruba a oferta) e é isso que o grupo recebe
  s.ml.estado.leitura = { price: 249, disponivel: true };
  const { envio_id: id } = await s.itens.enviar(s.revisao(regra, s.candidata(1234567890, { price: 299 })), {});
  assert.equal(reserva().price_cents, 29900, 'antes do envio sair a reserva traz o preço aprovado');
  await s.envios.runEnvio(id);
  assert.match(s.wa.simulated[0].text, /Por R\$ 249,00/);
  assert.equal(reserva().price_cents, 24900, 'o grupo viu R$ 249,00');

  // passada a janela de "Não repetir", o mesmo produto volta a R$ 279,00: 12% acima do que o grupo viu, 6,7% abaixo do aprovado
  s.db.prepare('UPDATE sent_offers SET sent_at = sent_at - ? WHERE rule_id = ?').run(8 * DIAS, regra.id);
  s.ml.estado.leitura = { price: 279, disponivel: true };
  const { envio_id: id2 } = await s.itens.enviar(s.revisao(regra, s.candidata(1234567890, { price: 279 })), {});
  assert.equal(s.payloadDo(id2).preco_ultimo_envio, 24900, 'a referência é o preço visto, não o aprovado (R$ 299,00)');
  await s.envios.runEnvio(id2);
  assert.match(s.wa.simulated[1].text, /Por R\$ 279,00/);
  assert.doesNotMatch(s.wa.simulated[1].text, REGEX_SEM_LINHA, 'sem a linha: a R$ 279,00 não "baixou" de R$ 249,00');
});

test('baixou (Catálogo, S1): envio que não chega a nenhum grupo deixa a reserva como está (preço aprovado)', async () => {
  const s = montarCatalogo();
  const regra = s.regra();
  s.ml.estado.leitura = { price: 249, disponivel: true };
  s.wa.sendText = async () => { throw new Error('socket caiu'); };
  const { envio_id: id } = await s.itens.enviar(s.revisao(regra, s.candidata(1234567890, { price: 299 })), {});
  await s.envios.runEnvio(id);
  assert.equal(s.wa.simulated.length, 0);
  assert.equal(s.db.prepare('SELECT price_cents FROM sent_offers WHERE rule_id = ?').get(regra.id).price_cents, 29900);
});

test('baixou (Catálogo): o preço conferido sobe para menos de 5% abaixo → sai sem a linha (não é descartada); continua abaixo → linha com o preço conferido', async () => {
  const s = montarCatalogo();
  const regra = s.regra();
  s.jaSaiu(regra, { key: 'MLB1234567890', preco: 27000, ha: 8 * DIAS }); // R$ 252,00 está 6,7% abaixo: o payload leva o campo
  s.ml.estado.leitura = { price: 258, disponivel: true }; // +2,4% na loja (cabe no limite do verificador) e só 4,4% abaixo de R$ 270,00
  const { envio_id: id } = await s.itens.enviar(s.revisao(regra, s.candidata()), {});
  assert.equal(s.payloadDo(id).preco_ultimo_envio, 27000);
  await s.envios.runEnvio(id);
  assert.equal(envio(s, id).status, 'concluido', 'a linha é enfeite: o envio não é descartado');
  assert.match(s.wa.simulated[0].text, /^Perfume Bom Floral 100ml\nPor R\$ 258,00\nhttps:\/\/meli\.la\/\S+$/);

  // a loja confirma um preço ainda 5% abaixo (e o preço conferido, não o do "Enviar", vai na linha)
  const s2 = montarCatalogo();
  const regra2 = s2.regra();
  s2.jaSaiu(regra2, { key: 'MLB1234567890', preco: 27000, ha: 8 * DIAS });
  s2.ml.estado.leitura = { price: 250, disponivel: true };
  const { envio_id: id2 } = await s2.itens.enviar(s2.revisao(regra2, s2.candidata()), {});
  await s2.envios.runEnvio(id2);
  assert.ok(s2.wa.simulated[0].text.includes(LINHA('270,00', '250,00')), s2.wa.simulated[0].text);
});

test('baixou (fila): valor inválido no payload é ignorado (sai sem a linha e sem descartar); o válido mostra; origem que não é catálogo ignora', async () => {
  const s = montar();
  const criado = Date.now();
  const tpl = { id: Number(s.db.prepare('INSERT INTO templates (name, body, created_at) VALUES (?,?,?)').run('Com baixou', CORPO_BAIXOU, criado).lastInsertRowid), criado };
  s.ml.estado.leitura = { price: 252, disponivel: true };
  const enviarCom = async (extra, ...troca) => { // troca = [origem] (undefined = sem origem); sem argumento, a do catálogo
    const antes = s.wa.simulated.length;
    const base = payloadCatalogo(s, { preco: 252, tpl, ...extra });
    const id = gravar(s, troca.length ? { ...base, origem: troca[0] } : base, { jids: [G1] });
    await s.envios.runEnvio(id);
    assert.equal(envio(s, id).status, 'concluido', JSON.stringify(extra));
    assert.equal(s.wa.simulated.length, antes + 1);
    return s.wa.simulated.at(-1).text;
  };
  assert.ok((await enviarCom({ preco_ultimo_envio: 29900 })).includes(LINHA('299,00', '252,00')), 'controle: o valor bom aparece');
  // JSON não leva NaN/Infinity (viram null): 1e21 e as strings cobrem "fora da faixa" e "tipo errado"
  for (const ruim of [0, -29900, 299.5, '29900', null, true, [29900], { v: 29900 }, 1e21, 25200, 25199]) {
    assert.doesNotMatch(await enviarCom({ preco_ultimo_envio: ruim }), REGEX_SEM_LINHA, `valor ${JSON.stringify(ruim)}`);
  }
  for (const [nome, origem] of [['manual', { tipo: 'manual' }], ['espelho', { tipo: 'espelho', espelho_id: 3, nome: 'Amazon' }],
    ['remetente', { tipo: 'remetente', remetente_id: 1, nome: 'Sócio' }], ['sem origem', undefined]]) {
    assert.doesNotMatch(await enviarCom({ preco_ultimo_envio: 29900 }, origem), REGEX_SEM_LINHA, `origem ${nome}`);
  }
  assert.equal(acessosRede, 0);
});

test('baixou (fila): oferta com "mais barata" e a linha: frase 🔎 na frente e a linha 📉 no corpo', async () => {
  const s = montar();
  const criado = Date.now();
  const tpl = { id: Number(s.db.prepare('INSERT INTO templates (name, body, created_at) VALUES (?,?,?)').run('Com baixou', CORPO_BAIXOU, criado).lastInsertRowid), criado };
  s.ml.estado.leitura = { price: 90, disponivel: true };
  const id = gravar(s, payloadCatalogo(s, { preco: 90, tpl, mais_barata: { preco_anterior: 10000 }, preco_ultimo_envio: 10000 }), { jids: [G1] });
  await s.envios.runEnvio(id);
  assert.ok(s.wa.simulated[0].text.startsWith(`${FRASE_MAIS_BARATA}\n\nPerfume Bom\nPor R$ 90,00\n${LINHA('100,00', '90,00')}\n`), s.wa.simulated[0].text);
});

// Junção da entrega 2 (guarda preco_suspeito do conferirOferta, CA2.12) com o "Baixou de … para …": a guarda roda antes
// do baixouDe, então a queda de QUEDA_REVISAO_PCT% ou mais sobre o preço aprovado descarta, sem a linha nem mensagem
test('baixou × preço suspeito (rodar-sozinho E2): "Enviar" aprovado a R$ 252,00 e conferido a R$ 120,00 é descartado, sem "Baixou de"', async () => {
  const s = montarCatalogo();
  const regra = s.regra();
  s.jaSaiu(regra, { key: 'MLB1234567890', preco: 29900, ha: 8 * DIAS });
  s.ml.estado.leitura = { price: 120, disponivel: true }; // 52% abaixo do aprovado
  const { envio_id: id } = await s.itens.enviar(s.revisao(regra, s.candidata()), {});
  assert.equal(s.payloadDo(id).preco_ultimo_envio, 29900, 'o payload leva a referência');
  await s.envios.runEnvio(id);
  assert.equal(s.wa.simulated.length, 0, 'nenhuma mensagem');
  assert.equal(resultadoDe(s, id).descartado, 'preco_suspeito');
});

