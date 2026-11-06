// Testes de src/magalu.js (plano integracao-magalu, etapa 1; CA3, CA6 e CA9).
// Tudo com fetch injetado (fetchFalso): o fetch global fica bloqueado no arquivo inteiro e o último teste
// prova que ele nunca foi chamado.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  HOSTS_MAGALU, RE_LOJA_MAGALU, LINK_MAGALU, MENSAGENS_MAGALU, ErroMagalu, LinkMagaluNaoResolvido,
  extrairProdutoMagalu, montarLinkMagalu, createMagalu,
} from '../src/magalu.js';

// ------------------------------------------------------------------------------------------- rede bloqueada
const fetchOriginal = globalThis.fetch;
let chamadasGlobais = 0;
test.before(() => { globalThis.fetch = async () => { chamadasGlobais++; throw new Error('rede proibida no teste'); }; });
test.after(() => { globalThis.fetch = fetchOriginal; });

// ------------------------------------------------------------------------------------------------ dados
const LOJA = 'magazineminhaloja';
const OUTRA = 'magazineoutroparceiro';
const SLUG = 'smartphone-samsung-galaxy-a15-128gb-azul-escuro-4g';
const COD = '237962600';
const CANON = `https://www.magazineluiza.com.br/${SLUG}/p/${COD}/te/ga15/`;
const LINK = `https://www.magazinevoce.com.br/${LOJA}/${SLUG}/p/${COD}/te/ga15/`;

const redirecionar = (status, location) => new Response(null, { status, headers: location ? { location } : {} });

/** fetch falso: guarda { url, init } de cada chamada e responde pelo handler. */
function fetchFalso(handler) {
  const chamadas = [];
  const f = async (url, init = {}) => { chamadas.push({ url: String(url), init }); return handler(String(url), init, chamadas.length); };
  f.chamadas = chamadas;
  return f;
}
const nunca = fetchFalso(() => { throw new Error('não devia acessar a rede'); });

/** Erro do tipo e da causa pedidos, com mensagem fixa (sem URL, loja nem link). */
function falhaMagalu(causa, ...proibidos) {
  return (e) => {
    assert.ok(e instanceof LinkMagaluNaoResolvido, `esperava LinkMagaluNaoResolvido, veio ${e?.name}`);
    assert.equal(e.causa, causa);
    assert.equal(e.codigo, causa);
    assert.equal(e.name, 'LinkMagaluNaoResolvido');
    assert.doesNotMatch(e.message, /https?:|magazinevoce\.|magazineluiza\.|maga\.lu|onelink/);
    for (const p of proibidos) assert.ok(!e.message.includes(p), p);
    return true;
  };
}

// ------------------------------------------------------------------------------------------ constantes
test('magalu: hosts, regra da loja e forma do link são as do plano', () => {
  assert.deepEqual([...HOSTS_MAGALU], ['magazineluiza.com.br', 'magazinevoce.com.br', 'magalu.com', 'maga.lu', 'magazineluiza.onelink.me']);
  assert.ok(Object.isFrozen(HOSTS_MAGALU));
  assert.equal(RE_LOJA_MAGALU.source, '^[A-Za-z0-9_-]{2,60}$');
  for (const ok of ['ab', 'Magazine_Fulano-1', 'x'.repeat(60)]) assert.ok(RE_LOJA_MAGALU.test(ok), ok);
  for (const ruim of ['', 'a', 'x'.repeat(61), 'minha loja', 'lojá', 'loja/x', 'loja.x', 'loja?x', ' loja']) assert.ok(!RE_LOJA_MAGALU.test(ruim), ruim);
  assert.ok(LINK_MAGALU.test(LINK));
  assert.ok(LINK_MAGALU.test(`https://www.magazinevoce.com.br/${LOJA}/p/${COD}/`));
  assert.ok(LINK_MAGALU.test(`https://www.magazinevoce.com.br/${LOJA}/p/${COD}/?seller_id=magazineluiza`));
  for (const ruim of [`${LINK}?utm_source=x`, `${LINK}#x`, `http://www.magazinevoce.com.br/${LOJA}/p/${COD}/`,
    `https://magazinevoce.com.br/${LOJA}/p/${COD}/`, `https://www.magazinevoce.com.br/${LOJA}/p/${COD}`,
    `https://www.magazinevoce.com.br/${LOJA}/p/${COD}/a/b/c/`]) assert.ok(!LINK_MAGALU.test(ruim), ruim);
  assert.equal(MENSAGENS_MAGALU.sem_loja, 'Falta o nome da sua loja de parceiro da Magalu. Cadastre em Conexões → Magalu.');
});

// ------------------------------------------------------------------------------------------- extração
test('magalu: extrai o produto de magazineluiza com e sem slug e com 0, 1 ou 2 categorias (CA3)', () => {
  const casos = [
    [`https://www.magazineluiza.com.br/${SLUG}/p/${COD}/te/ga15/`, `${SLUG}/p/${COD}/te/ga15/`],
    [`https://www.magazineluiza.com.br/${SLUG}/p/${COD}/te/`, `${SLUG}/p/${COD}/te/`],
    [`https://www.magazineluiza.com.br/${SLUG}/p/${COD}/`, `${SLUG}/p/${COD}/`],
    [`https://www.magazineluiza.com.br/p/${COD}/`, `p/${COD}/`],
    [`https://www.magazineluiza.com.br/p/${COD}/te/ga15/`, `p/${COD}/te/ga15/`],
    [`https://www.magazineluiza.com.br/${SLUG}/p/${COD}/te/ga15`, `${SLUG}/p/${COD}/te/ga15/`], // sem a barra final
    [`https://magazineluiza.com.br/${SLUG}/p/${COD}/te/ga15/`, `${SLUG}/p/${COD}/te/ga15/`],
    [`https://m.magazineluiza.com.br/${SLUG}/p/${COD}/te/ga15/`, `${SLUG}/p/${COD}/te/ga15/`],
    [`http://www.magazineluiza.com.br/${SLUG}/p/${COD}/te/ga15/`, `${SLUG}/p/${COD}/te/ga15/`],
    [`  www.magazineluiza.com.br/${SLUG}/p/${COD}/te/ga15/  `, `${SLUG}/p/${COD}/te/ga15/`],
    ['https://www.magazineluiza.com.br/fone-bluetooth/p/hcf6k3b2fj/ea/fobt/', 'fone-bluetooth/p/hcf6k3b2fj/ea/fobt/'],
  ];
  for (const [url, caminho] of casos) {
    assert.deepEqual(extrairProdutoMagalu(url), {
      codigo: /(?:^|\/)p\/([a-z0-9]+)\//.exec(caminho)[1],
      urlProduto: `https://www.magazineluiza.com.br/${caminho}`, sellerId: null, lojaDoLink: null,
    }, url);
  }
  assert.equal(extrairProdutoMagalu(`https://www.magazineluiza.com.br/p/${COD}/`).codigo, COD);
});

test('magalu: magazinevoce de qualquer loja dá o produto e a loja do link; query e fragmento caem (CA3)', () => {
  const p = extrairProdutoMagalu(`https://www.magazinevoce.com.br/${OUTRA}/${SLUG}/p/${COD}/te/ga15/?utm_source=zap&utm_medium=x#topo`);
  assert.deepEqual(p, { codigo: COD, urlProduto: CANON, sellerId: null, lojaDoLink: OUTRA });
  assert.deepEqual(extrairProdutoMagalu(`https://magazinevoce.com.br/Loja_Ab-1/p/${COD}/`),
    { codigo: COD, urlProduto: `https://www.magazineluiza.com.br/p/${COD}/`, sellerId: null, lojaDoLink: 'Loja_Ab-1' });
  // a loja do link nunca entra no endereço canônico
  assert.ok(!p.urlProduto.includes(OUTRA));
});

test('magalu: seller_id válido segue; inválido, vazio ou outro parâmetro cai (D5)', () => {
  const base = `https://www.magazineluiza.com.br/${SLUG}/p/${COD}/te/ga15/`;
  const comSeller = extrairProdutoMagalu(`${base}?utm_source=x&seller_id=magazineluiza&tag=y`);
  assert.equal(comSeller.sellerId, 'magazineluiza');
  assert.equal(comSeller.urlProduto, `${base}?seller_id=magazineluiza`);
  for (const ruim of ['', 'a b', 'x'.repeat(61), '<script>', 'loja%2Fx', 'a&b=c', 'ççç']) {
    const r = extrairProdutoMagalu(`${base}?seller_id=${encodeURIComponent(ruim)}`);
    assert.equal(r.sellerId, null, ruim);
    assert.equal(r.urlProduto, base, ruim);
  }
  assert.equal(extrairProdutoMagalu(`${base}?Seller_Id=x`).sellerId, null, 'só o nome exato');
});

test('magalu: maiúsculas no caminho do produto viram minúsculas; a loja do link fica como veio', () => {
  const r = extrairProdutoMagalu(`https://www.MAGAZINEVOCE.com.br/MinhaLoja/Smartphone-X/P/HCF6K3B2FJ/TE/GA15/`);
  assert.deepEqual(r, {
    codigo: 'hcf6k3b2fj', urlProduto: 'https://www.magazineluiza.com.br/smartphone-x/p/hcf6k3b2fj/te/ga15/', sellerId: null, lojaDoLink: 'MinhaLoja',
  });
});

test('magalu: recusa o que não é página de produto ou tenta escapar da lista branca', () => {
  const recusados = [
    // não é produto
    'https://www.magazineluiza.com.br/', 'https://www.magazineluiza.com.br/busca/fone/', 'https://www.magazineluiza.com.br/celulares/l/te/',
    `https://www.magazinevoce.com.br/${LOJA}/`, `https://www.magazinevoce.com.br/${LOJA}/busca/fone/`, 'https://www.magazinevoce.com.br/az-request-verify',
    `https://www.magazineluiza.com.br/${SLUG}/x/${COD}/`, `https://www.magazineluiza.com.br/a/b/p/${COD}/`,
    // código curto, longo ou com caractere fora da lista
    'https://www.magazineluiza.com.br/x/p/12345/', `https://www.magazineluiza.com.br/x/p/${'1'.repeat(21)}/`,
    'https://www.magazineluiza.com.br/x/p/1234_567/', 'https://www.magazineluiza.com.br/x/p/1234-567/',
    // categorias demais ou fora da lista; slug fora da lista
    `https://www.magazineluiza.com.br/x/p/${COD}/a/b/c/`, `https://www.magazineluiza.com.br/x/p/${COD}/a_b/`,
    `https://www.magazineluiza.com.br/fone_bom/p/${COD}/`, `https://www.magazineluiza.com.br/${'a'.repeat(201)}/p/${COD}/`,
    `https://www.magazineluiza.com.br/x/p/${COD}/${'a'.repeat(61)}/`,
    // .., %, barra invertida, barra dupla
    `https://www.magazineluiza.com.br/a/../p/${COD}/`, `https://www.magazineluiza.com.br/x/%2e%2e/p/${COD}/`,
    `https://www.magazineluiza.com.br/x%2fy/p/${COD}/`, `https://www.magazineluiza.com.br/x/p/${COD}%2f/`,
    `https://www.magazineluiza.com.br/x/p/${COD}/te%2F/`, `https://www.magazineluiza.com.br\\x\\p\\${COD}\\`,
    `https://www.magazineluiza.com.br//x/p/${COD}/`, `https://www.magazineluiza.com.br/x//p/${COD}/`,
    `https://www.magazinevoce.com.br/${OUTRA}/../${LOJA}/p/${COD}/`, `https://www.magazinevoce.com.br/${LOJA}/x/p/${COD}/te/..`,
    // loja de parceiro inválida
    `https://www.magazinevoce.com.br/a/p/${COD}/`, `https://www.magazinevoce.com.br/p/${COD}/`,
    `https://www.magazinevoce.com.br/${'x'.repeat(61)}/p/${COD}/`, `https://www.magazinevoce.com.br/loja.x/p/${COD}/`,
    // host parecido, porta, credenciais, esquema, IP, punycode
    `https://www.magazineluiza.com.br.evil.com/x/p/${COD}/`, `https://xmagazineluiza.com.br/x/p/${COD}/`,
    `https://magazinevoce.com.br.evil.com/${LOJA}/p/${COD}/`, `https://evil.com/www.magazineluiza.com.br/x/p/${COD}/`,
    `https://evil.com/?u=https://www.magazineluiza.com.br/x/p/${COD}/`, `https://www.magazineluiza.com.br:8443/x/p/${COD}/`,
    `https://www.magazineluiza.com.br:443x/x/p/${COD}/`, `https://user:senha@www.magazineluiza.com.br/x/p/${COD}/`,
    `https://www.magazineluiza.com.br@evil.com/x/p/${COD}/`, `javascript://www.magazineluiza.com.br/x/p/${COD}/%0aalert(1)`,
    `javascript:alert(1)`, `ftp://www.magazineluiza.com.br/x/p/${COD}/`, `data:text/html,www.magazineluiza.com.br/x/p/${COD}/`,
    `https://127.0.0.1/x/p/${COD}/`, `https://[::1]/x/p/${COD}/`, `https://xn--magazinelui-xyz.com.br/x/p/${COD}/`,
    // links curtos não são produto sem resolver
    'https://maga.lu/abc123', 'https://magazineluiza.onelink.me/abc/def', 'https://divulgador.magalu.com/abc', 'https://magalu.com/p/237962600/',
    // tamanho e tipo
    `https://www.magazineluiza.com.br/x/p/${COD}/?q=${'a'.repeat(2048)}`, '', '   ', null, undefined, 42, {}, [CANON],
  ];
  for (const u of recusados) assert.equal(extrairProdutoMagalu(u), null, String(u).slice(0, 90));
});

test('magalu: porta padrão some no parser e o link segue aceito (u.port vazio)', () => {
  assert.equal(extrairProdutoMagalu(`https://www.magazineluiza.com.br:443/x/p/${COD}/`)?.codigo, COD);
});

// ------------------------------------------------------------------------------------------- link montado
test('magalu: montarLinkMagalu põe sempre a loja dada, do magazineluiza ou do magazinevoce de outro parceiro (CA3)', () => {
  assert.equal(montarLinkMagalu(CANON, LOJA), LINK);
  assert.equal(montarLinkMagalu(`https://www.magazinevoce.com.br/${OUTRA}/${SLUG}/p/${COD}/te/ga15/?utm_source=x#y`, LOJA), LINK);
  assert.equal(montarLinkMagalu(`https://www.magazineluiza.com.br/p/${COD}/`, LOJA), `https://www.magazinevoce.com.br/${LOJA}/p/${COD}/`);
  assert.equal(montarLinkMagalu(`https://www.magazineluiza.com.br/x/p/${COD}/te/`, LOJA), `https://www.magazinevoce.com.br/${LOJA}/x/p/${COD}/te/`);
  assert.equal(montarLinkMagalu(`${CANON}?utm_campaign=x&seller_id=lojaboa&gclid=abc`, LOJA), `${LINK}?seller_id=lojaboa`);
  assert.equal(montarLinkMagalu(`${CANON}?seller_id=a%20b`, LOJA), LINK);
  assert.equal(montarLinkMagalu(CANON, `  ${LOJA} `), LINK, 'espaço em volta do nome salvo');
  // o resultado sempre casa LINK_MAGALU e nunca leva a loja do link colado, utm ou fragmento
  for (const entrada of [CANON, `https://www.magazinevoce.com.br/${OUTRA}/p/${COD}/?utm_source=${OUTRA}#${OUTRA}`]) {
    const l = montarLinkMagalu(entrada, LOJA);
    assert.match(l, LINK_MAGALU);
    assert.ok(!l.includes(OUTRA) && !l.includes('utm') && !l.includes('#'), l);
  }
});

test('magalu: montarLinkMagalu sem loja válida é ErroMagalu sem_loja; endereço que não é produto é invalido', () => {
  for (const loja of [undefined, null, '', '  ', 'a', 'minha loja', 'loja/../x', 'loja?x=1', 'loja#x', 'x'.repeat(61), 42, {}]) {
    assert.throws(() => montarLinkMagalu(CANON, loja), (e) => {
      assert.ok(e instanceof ErroMagalu, String(loja));
      assert.equal(e.tipo, 'sem_loja'); assert.equal(e.codigo, 'sem_loja'); assert.equal(e.name, 'ErroMagalu');
      assert.equal(e.message, MENSAGENS_MAGALU.sem_loja);
      return true;
    });
  }
  for (const url of ['https://maga.lu/abc123', 'https://www.magazineluiza.com.br/', `https://evil.com/x/p/${COD}/`, '', null, `https://www.magazineluiza.com.br/a/../p/${COD}/`]) {
    assert.throws(() => montarLinkMagalu(url, LOJA), falhaMagalu('invalido', LOJA));
  }
  // a loja é conferida antes do endereço
  assert.throws(() => montarLinkMagalu('https://maga.lu/abc', ''), ErroMagalu);
});

test('magalu: erros com causa ou tipo desconhecidos caem no padrão e nunca levam o que foi passado', () => {
  const e = new LinkMagaluNaoResolvido('https://maga.lu/x');
  assert.equal(e.causa, 'invalido');
  assert.ok(!e.message.includes('maga.lu'));
  assert.equal(new LinkMagaluNaoResolvido('nao_produto').message, 'Este link da Magalu não leva a um produto.');
  assert.equal(new LinkMagaluNaoResolvido('invalido').message, 'Não consegui abrir este link da Magalu. Cole o endereço da página do produto.');
  assert.equal(new ErroMagalu('constructor').tipo, 'sem_loja');
  assert.equal(new ErroMagalu(LOJA).message, MENSAGENS_MAGALU.sem_loja);
});

// ------------------------------------------------------------------------------------------- resolvedor
test('magalu: link de produto (completo) volta sem rede, também do magazinevoce de outro parceiro (CA6)', async () => {
  const magalu = createMagalu({ fetch: nunca });
  assert.deepEqual(await magalu.resolver(`${CANON}?utm_source=x`), { codigo: COD, urlProduto: CANON, sellerId: null, lojaDoLink: null });
  assert.deepEqual(await magalu.resolver(`https://www.magazinevoce.com.br/${OUTRA}/${SLUG}/p/${COD}/te/ga15/`),
    { codigo: COD, urlProduto: CANON, sellerId: null, lojaDoLink: OUTRA });
  assert.equal(nunca.chamadas.length, 0);
});

test('magalu: página de magazineluiza ou magazinevoce sem produto é nao_produto sem rede (a página nunca é pedida)', async () => {
  const f = fetchFalso(() => { throw new Error('não devia acessar a rede'); });
  const magalu = createMagalu({ fetch: f });
  for (const url of ['https://www.magazineluiza.com.br/', 'https://www.magazineluiza.com.br/busca/fone/', `https://www.magazinevoce.com.br/${LOJA}/`,
    'https://m.magazineluiza.com.br/celulares/l/te/']) {
    await assert.rejects(magalu.resolver(url), falhaMagalu('nao_produto', LOJA));
  }
  for (const url of [`https://www.magazineluiza.com.br:8443/x/p/${COD}/`, `https://www.magazineluiza.com.br/a/../p/${COD}/`,
    `https://www.magazineluiza.com.br/x%2fy/p/${COD}/`, `javascript:alert(1)`, 'https://evil.com/x', 'https://magalu.com.evil.com/x',
    'https://xmagalu.com/x', `https://maga.lu/${'a'.repeat(2050)}`, '', null, 42]) {
    await assert.rejects(magalu.resolver(url), falhaMagalu('invalido'), String(url).slice(0, 60));
  }
  assert.equal(f.chamadas.length, 0);
});

test('magalu: link curto com 302 para o magazinevoce dá o produto pelo Location, sem pedir o destino (CA6)', async () => {
  for (const curto of ['https://magazineluiza.onelink.me/AbCd/xyz123', 'https://maga.lu/Ab12Cd', 'https://divulgador.magalu.com/q8Rk', 'maga.lu/Ab12Cd']) {
    const f = fetchFalso(() => redirecionar(302, `https://www.magazinevoce.com.br/${OUTRA}/${SLUG}/p/${COD}/te/ga15/?seller_id=magazineluiza&utm_source=app`));
    const r = await createMagalu({ fetch: f }).resolver(curto);
    assert.deepEqual(r, { codigo: COD, urlProduto: `${CANON}?seller_id=magazineluiza`, sellerId: 'magazineluiza', lojaDoLink: OUTRA }, curto);
    assert.equal(f.chamadas.length, 1, 'só o link curto; a página do produto nunca é pedida');
    const { url, init } = f.chamadas[0];
    assert.ok(!/magazinevoce|magazineluiza\.com\.br/.test(url), url);
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.ok(init.signal, 'com timeout');
    assert.equal(montarLinkMagalu(r.urlProduto, LOJA), `${LINK}?seller_id=magazineluiza`);
  }
});

test('magalu: cadeia de saltos entre hosts da Magalu chega ao produto; http no Location vira https', async () => {
  const cadeia = ['https://magazineluiza.onelink.me/AbCd/xyz', 'https://maga.lu/x1', 'http://divulgador.magalu.com/x2'];
  const f = fetchFalso((url, _i, n) => redirecionar(301, n < cadeia.length ? cadeia[n] : `https://www.magazineluiza.com.br/p/${COD}/`));
  assert.deepEqual(await createMagalu({ fetch: f }).resolver(cadeia[0]),
    { codigo: COD, urlProduto: `https://www.magazineluiza.com.br/p/${COD}/`, sellerId: null, lojaDoLink: null });
  assert.deepEqual(f.chamadas.map((c) => c.url), ['https://magazineluiza.onelink.me/AbCd/xyz', 'https://maga.lu/x1', 'https://divulgador.magalu.com/x2']);
});

test('magalu: 302 para host de fora, porta ou credenciais é invalido sem seguir (CA6)', async () => {
  for (const destino of ['https://evil.com/x/p/237962600/', 'https://app.appsflyer.com/x', `https://www.magazineluiza.com.br.evil.com/x/p/${COD}/`,
    `https://www.magazinevoce.com.br:8080/${LOJA}/p/${COD}/`, `https://u:s@www.magazinevoce.com.br/${LOJA}/p/${COD}/`, 'ftp://maga.lu/x', 'javascript:alert(1)']) {
    const f = fetchFalso(() => redirecionar(302, destino));
    await assert.rejects(createMagalu({ fetch: f }).resolver('https://maga.lu/abc'), falhaMagalu('invalido'), destino);
    assert.equal(f.chamadas.length, 1, destino);
  }
});

test('magalu: 200 sem produto em host da Magalu é nao_produto; no encurtador, 4xx, 5xx, 3xx sem Location e erro de rede são invalido', async () => {
  // o encurtador manda para a vitrine do parceiro, que responde 200 (sem produto)
  let f = fetchFalso((_u, _i, n) => (n === 1 ? redirecionar(302, `https://www.magazinevoce.com.br/${LOJA}/`) : new Response('ok', { status: 200 })));
  await assert.rejects(createMagalu({ fetch: f }).resolver('https://maga.lu/abc'), falhaMagalu('nao_produto', LOJA));
  // 200 no próprio encurtador (ex.: página com JavaScript, sem 3xx): invalido, com a orientação de colar o endereço da página
  f = fetchFalso(() => new Response('<html>', { status: 200 }));
  await assert.rejects(createMagalu({ fetch: f }).resolver('https://magazineluiza.onelink.me/AbCd/xyz'), (e) => falhaMagalu('invalido')(e) && /Cole o endereço da página do produto/.test(e.message));
  for (const resp of [() => new Response('', { status: 404 }), () => new Response('', { status: 503 }), () => redirecionar(302, null),
    () => { throw new TypeError('fetch failed'); }]) {
    f = fetchFalso(resp);
    await assert.rejects(createMagalu({ fetch: f }).resolver('https://maga.lu/abc'), falhaMagalu('invalido'));
  }
});

test('magalu: no máximo 5 saltos', async () => {
  const f = fetchFalso((_u, _i, n) => redirecionar(302, `https://maga.lu/s${n}`));
  await assert.rejects(createMagalu({ fetch: f }).resolver('https://maga.lu/s0'), falhaMagalu('invalido'));
  assert.equal(f.chamadas.length, 5);
});

test('magalu: cada cliente tem o seu cache; o mesmo link curto não pede a rede de novo', async () => {
  const f = fetchFalso(() => redirecionar(302, `https://www.magazineluiza.com.br/p/${COD}/`));
  const magalu = createMagalu({ fetch: f });
  const a = await magalu.resolver('https://maga.lu/abc');
  const b = await magalu.resolver('https://maga.lu/abc');
  assert.deepEqual(a, b);
  assert.notEqual(a, b, 'cópia por chamador');
  assert.equal(f.chamadas.length, 1);
  await createMagalu({ fetch: f }).resolver('https://maga.lu/abc');
  assert.equal(f.chamadas.length, 2, 'outro cliente, outro cache');
});

// ------------------------------------------------------------------------------------------------ CA9
test('magalu: o módulo não escreve no console e nenhuma mensagem leva link, loja ou URL (CA9)', async () => {
  const fonte = readFileSync(new URL('../src/magalu.js', import.meta.url), 'utf8');
  assert.doesNotMatch(fonte, /\bconsole\.(log|info|warn|error|debug|trace)\b/);
  const espiao = []; const originais = {};
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) { originais[m] = console[m]; console[m] = (...a) => espiao.push(a); }
  const mensagens = [];
  try {
    const f = fetchFalso((_u, _i, n) => (n === 1 ? redirecionar(302, `https://evil.com/${LOJA}`) : new Response('', { status: 200 })));
    for (const url of [`https://maga.lu/${LOJA}`, `https://www.magazinevoce.com.br/${LOJA}/`, `https://magazineluiza.onelink.me/${LOJA}`]) {
      await createMagalu({ fetch: f }).resolver(url).catch((e) => mensagens.push(e.message));
    }
    try { montarLinkMagalu(CANON, `${LOJA} x`); } catch (e) { mensagens.push(e.message); }
    try { montarLinkMagalu(`https://maga.lu/${LOJA}`, LOJA); } catch (e) { mensagens.push(e.message); }
  } finally { Object.assign(console, originais); }
  assert.equal(espiao.length, 0);
  assert.equal(mensagens.length, 5);
  for (const m of mensagens) {
    assert.ok(!m.includes(LOJA) && !/https?:|\.com|maga\.lu/.test(m), m);
    assert.ok([...Object.values(MENSAGENS_MAGALU), new LinkMagaluNaoResolvido('invalido').message, new LinkMagaluNaoResolvido('nao_produto').message].includes(m), m);
  }
});

test('magalu: o fetch global nunca foi chamado', () => {
  assert.equal(chamadasGlobais, 0);
});
