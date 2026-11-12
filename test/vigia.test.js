// Rodar sozinho, entrega 3, etapa 2 (docs/produto/planos/rodar-sozinho-entrega3.md, Decisão 2 a 5 e 7; spec
// docs/produto/specs/rodar-sozinho-entrega3.md, §1 e §2): a parte pura do vigia (src/vigia.js). `avaliar` com as quatro
// causas (loja parada, extensão ou Central fora, revisão acumulada, regra vazia), a hierarquia, o fechamento (com e sem
// "voltou"), o freio de 3 h e o que está devido; as mensagens do WhatsApp; a linha de saúde do resumo. Tudo com
// execuções simuladas: sem banco, sem rede, sem relógio (o `agora` vem do teste).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  avaliar, mensagemProblemas, mensagemVoltas, linhaDeSaude, causasAbertas, marcarAvisados, marcarVoltas, lerEstado,
  nomeSeguro, motivoDe, MOTIVO_VIGIA, EXECUCOES_LOJA_PARADA, EXECUCOES_REGRA_VAZIA, FORA_MIN, REVISAO_ABRE,
  REVISAO_FECHA, FREIO_VIGIA_H, MAX_NOME_VIGIA,
} from '../src/vigia.js';
import { CAUSAS, MOTIVOS_VERIFICADOR } from '../src/verificador.js';
import { CAUSAS_CENTRAL } from '../src/links.js';

/** Instante local de 2026-11-`dia` às h:m (as horas das mensagens saem no fuso do processo, como no Histórico). */
const T = (h, m = 0, dia = 11) => new Date(2026, 10, dia, h, m).getTime();

const REGRAS = [
  { id: 1, nome: 'Achados do dia', lojas: [] },          // lista vazia: Amazon e Mercado Livre
  { id: 2, nome: 'Só ML', lojas: ['ml'] },
  { id: 3, nome: 'Só Amazon', lojas: ['amazon'] },
];

const loja = (c = {}) => ({ saiu: 0, pulada: 0, descartada: 0, revisao: 0, esperou: 0, motivos: {}, ...c });
let proximoId = 1;
/** Uma linha de `execucoes` como o agendador grava (por_loja e lojas_pedidas em JSON). */
function ex(ts, { regra = 1, conta = 1, saidas, ml, amazon, shopee, erros = 0, lojas = [] } = {}) {
  const por = {};
  if (ml) por.ml = loja(ml);
  if (amazon) por.amazon = loja(amazon);
  if (shopee) por.shopee = loja(shopee);
  const s = saidas ?? Object.values(por).reduce((a, x) => a + x.saiu, 0);
  return {
    id: proximoId++, ts, rule_id: regra, conta, want: 3, saidas: s, erros,
    lojas_pedidas: JSON.stringify(lojas), por_loja: JSON.stringify(por),
  };
}

/** Vigia simulado: guarda o estado entre as passadas, como o createVigia (etapa 3) fará em `settings`. */
function vigia(fixo = {}) {
  let estado = { cursor: 0 };
  const base = {
    revisao: { n: 0, maisAntigaEm: null }, extensao: { online: true, desde: T(6) },
    central: { estado: 'respondendo', emEsperaDesde: null }, regrasAtivas: REGRAS, modoLink: 'extension', ...fixo,
  };
  const todas = [];
  return {
    get estado() { return estado; },
    linhas: todas,
    rodar(execucoes = [], mais = {}) {
      const agora = mais.agora ?? execucoes.at(-1)?.ts ?? T(9);
      const r = avaliar({ ...base, ...mais, execucoes, estado, agora });
      estado = r.estado; todas.push(...r.linhas);
      return r;
    },
    mudar(campos) { Object.assign(base, campos); },
    abertas(agora = T(23)) { return causasAbertas(estado, { regrasAtivas: base.regrasAtivas, agora }).map((c) => c.chave); },
    avisar(r, agora) { estado = marcarAvisados(estado, r.devidos.problemas, agora); },
    voltar(r, agora) { estado = marcarVoltas(estado, r.devidos.voltas, agora); },
  };
}
const chaves = (lista) => lista.map((c) => c.chave);
const textos = (r) => r.linhas.map((l) => l.message);

// ---------- constantes ----------

test('constantes do vigia: os números do plano (entram nos Docs e no FATOS)', () => {
  assert.equal(EXECUCOES_LOJA_PARADA, 3);
  assert.equal(EXECUCOES_REGRA_VAZIA, 2);
  assert.equal(FORA_MIN, 30);
  assert.equal(REVISAO_ABRE, 10);
  assert.equal(REVISAO_FECHA, 5);
  assert.equal(FREIO_VIGIA_H, 3);
  assert.equal(MAX_NOME_VIGIA, 40);
});

// ---------- CA3.1: as quatro causas ----------

test('CA3.1 loja parada: 3 execuções com queda e sem saída abrem; execução sem atividade não conta; revisão não conta', () => {
  const v = vigia();
  const queda = (h, amazon) => ex(T(h, h === 9 ? 10 : 0), { ml: { saiu: 1 }, amazon });
  let r = v.rodar([queda(9, { pulada: 1, motivos: { etiqueta_bloqueio: 1 } })]);
  assert.deepEqual(v.abertas(), []);
  r = v.rodar([ex(T(10), { ml: { saiu: 2 } })]);                              // sem atividade da Amazon: neutra
  r = v.rodar([ex(T(11), { ml: { saiu: 1 }, amazon: { revisao: 2 } })]);     // só revisão: neutra (D11)
  r = v.rodar([queda(12, { pulada: 1, motivos: { etiqueta_bloqueio: 1 } })]);
  assert.deepEqual(v.abertas(), [], 'duas quedas ainda não abrem (as neutras não contam como queda)');
  assert.deepEqual(r.linhas, []);
  r = v.rodar([queda(13, { descartada: 1, esperou: 2, motivos: { etiqueta_bloqueio: 2, esgotado: 1 } })]);
  assert.deepEqual(chaves(r.devidos.problemas), ['loja:amazon']);
  const c = r.devidos.problemas[0];
  assert.equal(c.tipo, 'loja'); assert.equal(c.loja, 'amazon');
  assert.equal(c.desdeEm, T(9, 10), 'desde a 1ª execução da sequência: as neutras não a reiniciam');
  assert.equal(c.n, 3); assert.equal(c.fora, 5); assert.equal(c.calada, false);
  assert.deepEqual(r.linhas, [{ level: 'aviso', message: 'Vigia: Amazon parada (3 execuções sem envio; motivo mais comum: a Amazon bloqueou a leitura).' }]);
  assert.equal(mensagemProblemas(r.devidos.problemas, { motivo: null, agora: T(13) }), [
    '⚠️ *Amazon parada desde 09:10*',
    'Nas últimas 3 execuções nenhuma oferta da Amazon saiu (5 ficaram de fora: a Amazon bloqueou a leitura).',
    'O que fazer: nada por agora: o programa tenta de novo no próximo envio. Se continuar, abra a Amazon no Chrome e veja se pede verificação.',
  ].join('\n'));
  assert.deepEqual(v.abertas(), ['loja:amazon'], 'o Mercado Livre, que saiu, nunca abre');
});

test('CA3.1 Amazon só filtrada (sem conferência) conta como parada', () => {
  const v = vigia();
  let r;
  for (const h of [9, 10, 11]) r = v.rodar([ex(T(h), { ml: { saiu: 1 }, amazon: { esperou: 3, motivos: { semConferencia: 3 } } })]);
  assert.deepEqual(chaves(r.devidos.problemas), ['loja:amazon']);
  const msg = mensagemProblemas(r.devidos.problemas, { agora: T(11) });
  assert.match(msg, /^⚠️ \*Amazon parada desde 09:00\*\n/);
  assert.ok(msg.includes('Nas últimas 3 execuções nenhuma oferta da Amazon saiu (9 ficaram de fora: o preço não pôde ser conferido).'), msg);
  assert.ok(msg.endsWith('O que fazer: veja o Histórico: ele diz a causa de cada oferta.'), msg);
});

test('CA3.1 regra vazia: 2 seguidas (conta=0 e execução só com revisão não contam; uma saída zera)', () => {
  const v = vigia();
  v.rodar([ex(T(9), { ml: { pulada: 2, motivos: { filtros: 2 } } })]);
  v.rodar([ex(T(10), { conta: 0 })]);                                           // "sem ofertas novas": não conta
  v.rodar([ex(T(10, 30), { regra: 2, ml: { saiu: 1 } })]);                     // outra regra: não mexe na regra 1
  let r = v.rodar([ex(T(11), { amazon: { revisao: 1 } })]);                     // só revisão: neutra
  assert.deepEqual(v.abertas(), []);
  r = v.rodar([ex(T(12), { ml: { pulada: 1, descartada: 1, motivos: { filtros: 1, preco_subiu: 1 } } })]);
  assert.deepEqual(chaves(r.devidos.problemas), ['regra:1']);
  const c = r.devidos.problemas[0];
  assert.equal(c.rule_id, 1); assert.equal(c.regra, 'Achados do dia'); assert.equal(c.n, 2); assert.equal(c.desdeEm, T(9));
  assert.deepEqual(r.linhas, [{ level: 'aviso', message: 'Vigia: a regra “Achados do dia” saiu vazia 2 vezes seguidas (motivo mais comum: fora dos filtros da regra).' }]);
  assert.equal(mensagemProblemas(r.devidos.problemas, { agora: T(12) }), [
    '⚠️ *A regra “Achados do dia” saiu vazia 2 vezes seguidas*',
    'Às 09:00 e às 12:00 nenhuma oferta saiu (4 ficaram de fora: fora dos filtros da regra).',
    'O que fazer: afrouxe os filtros da regra em Disparo automático ou espere novidades no catálogo.',
  ].join('\n'));

  // uma saída no meio zera a sequência
  const w = vigia();
  w.rodar([ex(T(9), { ml: { pulada: 1 } })]);
  w.rodar([ex(T(10), { ml: { saiu: 1 } })]);
  w.rodar([ex(T(11), { ml: { pulada: 1 } })]);
  assert.deepEqual(w.abertas(), []);
});

test('CA3.1 extensão e Central: só com execução e falta ≥ 30 min', () => {
  // extensão desconectada desde as 09:00
  const v = vigia({ extensao: { online: false, desde: T(9) } });
  const esperaExt = (h, m, n) => ex(T(h, m), { regra: 2, ml: { esperou: n, motivos: { ml_extensao: n } } });
  let r = v.rodar([esperaExt(9, 20, 2)]);
  assert.deepEqual(v.abertas(), [], '20 min de falta ainda não abrem');
  r = v.rodar([], { agora: T(10, 30) });
  assert.deepEqual(v.abertas(), [], 'sem execução não abre, mesmo passados os 30 min');
  r = v.rodar([esperaExt(10, 40, 3)]);
  assert.deepEqual(chaves(r.devidos.problemas), ['ml_fora']);
  assert.equal(r.devidos.problemas[0].tipo, 'extensao');
  assert.equal(r.devidos.problemas[0].desdeEm, T(9));
  assert.ok(r.linhas.some((l) => l.level === 'aviso' && l.message === 'Vigia: extensão do Chrome fora desde 09:00 (o Mercado Livre não envia sem ela).'));
  assert.equal(mensagemProblemas(r.devidos.problemas, { agora: T(10, 40) }), [
    '⚠️ *Extensão do Chrome fora desde 09:00*',
    'O Mercado Livre não envia sem ela (3 ofertas esperando).',
    'O que fazer: abra o Chrome com a extensão instalada e entre na Central de Afiliados com a sua conta.',
  ].join('\n'));
  // a extensão voltou, mas a Central ainda não respondeu (sem teste ou falhando): segue aberta
  for (const estado of ['sem_teste', 'falhando']) {
    v.mudar({ extensao: { online: true, desde: T(10, 50) }, central: { estado, emEsperaDesde: null } });
    r = v.rodar([], { agora: T(10, 55) });
    assert.deepEqual(v.abertas(), ['ml_fora'], estado);
  }
  v.mudar({ central: { estado: 'respondendo', emEsperaDesde: null } });
  r = v.rodar([], { agora: T(11) });
  assert.deepEqual(v.abertas(), []);
  assert.deepEqual(r.linhas, [{ level: 'info', message: 'Vigia: Mercado Livre voltou a enviar (a extensão do Chrome respondeu de novo; esteve fora por 2 h).' }]);
  assert.deepEqual(r.devidos.voltas, [], 'não foi avisada: sem "voltou"');

  // Central em espera desde as 09:00 (extensão conectada): 30 min exatos abrem
  const w = vigia({ central: { estado: 'em_espera', emEsperaDesde: T(9) } });
  const esperaCentral = (h, m) => ex(T(h, m), { regra: 2, ml: { esperou: 2, motivos: { ml_espera: 2 } } });
  w.rodar([esperaCentral(9, 20)]);
  assert.deepEqual(w.abertas(), []);
  r = w.rodar([esperaCentral(9, 30)]);
  assert.deepEqual(chaves(r.devidos.problemas), ['ml_fora']);
  assert.equal(r.devidos.problemas[0].tipo, 'central');
  assert.equal(mensagemProblemas(r.devidos.problemas, { agora: T(9, 30) }), [
    '⚠️ *Mercado Livre em espera desde 09:00*',
    'A Central de Afiliados não está respondendo (2 ofertas esperando). O programa testa de novo a cada 5 min.',
    'O que fazer: nada, a menos que passe de 1 hora. Aí abra a Central no Chrome e veja se a página carrega e se a sua conta está logada.',
  ].join('\n'));
  w.avisar(r, T(9, 30));
  w.mudar({ central: { estado: 'respondendo', emEsperaDesde: null } });
  r = w.rodar([], { agora: T(10, 10) });
  assert.deepEqual(w.abertas(), [], 'a Central respondeu: fecha no tick, sem esperar execução');
  assert.deepEqual(r.linhas, [{ level: 'info', message: 'Vigia: Mercado Livre voltou a enviar (a Central de Afiliados respondeu de novo; esteve fora por 1 h 10 min).' }]);
  assert.equal(mensagemVoltas(r.devidos.voltas, T(10, 10)), [
    '✅ *Mercado Livre voltou a enviar*',
    'A Central de Afiliados respondeu de novo (esteve fora por 1 h 10 min). As ofertas saem sozinhas, nada a fazer.',
  ].join('\n'));

  // o ML que esperou por outro motivo não abre a causa; nem no modo direto
  const x = vigia({ extensao: { online: false, desde: T(6) } });
  x.rodar([ex(T(10), { regra: 2, ml: { esperou: 2, motivos: { etiqueta: 2 } } })]);
  assert.deepEqual(x.abertas(), []);
  const d = vigia({ extensao: { online: false, desde: T(6) }, modoLink: 'direct' });
  d.rodar([ex(T(10), { regra: 2, ml: { esperou: 2, motivos: { ml_extensao: 2 } } })]);
  assert.deepEqual(d.abertas(), []);
});

test('CA3.1 revisão: abre com 10 (e só numa execução que conta)', () => {
  const v = vigia();
  v.rodar([], { revisao: { n: 15, maisAntigaEm: T(7) }, agora: T(9) });
  assert.deepEqual(v.abertas(), [], 'sem execução não abre');
  v.rodar([ex(T(9, 10), { ml: { saiu: 1 } })], { revisao: { n: 9, maisAntigaEm: T(7) } });
  assert.deepEqual(v.abertas(), []);
  const r = v.rodar([ex(T(9, 20), { ml: { saiu: 1 } })], { revisao: { n: 10, maisAntigaEm: T(7, 10) } });
  assert.deepEqual(chaves(r.devidos.problemas), ['revisao']);
  assert.deepEqual(r.linhas, [{ level: 'aviso', message: 'Vigia: 10 ofertas esperando revisão (o aviso abre com 10).' }]);
  assert.equal(mensagemProblemas(r.devidos.problemas, { agora: T(9, 20) }), [
    '⚠️ *10 ofertas esperando a sua revisão*',
    'Elas não saem até você decidir. A mais antiga espera há 2 h 10 min.',
    'O que fazer: abra Histórico > Catálogo, confira e envie ou descarte.',
  ].join('\n'));
});

test('CA3.1 sem execução (fora do horário) nada abre, mesmo com a extensão off-line há horas', () => {
  const v = vigia({
    extensao: { online: false, desde: T(6) }, central: { estado: 'em_espera', emEsperaDesde: T(6) },
    revisao: { n: 40, maisAntigaEm: T(1) },
  });
  let r = v.rodar([], { agora: T(12) });
  assert.deepEqual(r.linhas, []);
  assert.deepEqual(r.devidos, { problemas: [], voltas: [] });
  // execuções que não contam (WhatsApp desconectado, regra incompleta…) também não abrem nada
  r = v.rodar([ex(T(12, 10), { conta: 0, regra: 2, ml: { esperou: 5, motivos: { ml_extensao: 5 } } })]);
  assert.deepEqual(r.linhas, []);
  assert.deepEqual(v.abertas(), []);
  assert.equal(r.estado.cursor, proximoId - 1, 'o cursor anda mesmo sem avaliar a execução que não conta');
});

// ---------- CA3.2: freio e "voltou" ----------

/** Três quedas seguidas da Amazon (regra 1, com o ML saindo): a causa abre na terceira. */
function tresQuedas(v, horas) {
  let r;
  for (const [h, m] of horas) r = v.rodar([ex(T(h, m), { ml: { saiu: 1 }, amazon: { pulada: 1, motivos: { etiqueta_fora: 1 } } })]);
  return r;
}
const saiuAmazon = (h, m = 0) => ex(T(h, m), { ml: { saiu: 1 }, amazon: { saiu: 1 } });

test('CA3.2 freio de 3 h segura o reabrir (contado do último aviso, de problema ou de volta)', () => {
  const v = vigia();
  let r = tresQuedas(v, [[9, 0], [10, 0], [11, 0]]);
  assert.deepEqual(chaves(r.devidos.problemas), ['loja:amazon']);
  v.avisar(r, T(11));
  r = v.rodar([], { agora: T(11, 5) });
  assert.deepEqual(r.devidos.problemas, [], 'já avisada: não repete (sem lembrete, D3)');
  r = v.rodar([saiuAmazon(12)]);
  assert.deepEqual(chaves(r.devidos.voltas), ['loja:amazon']);
  v.voltar(r, T(12));
  r = tresQuedas(v, [[12, 30], [13, 0], [13, 30]]);
  assert.deepEqual(v.abertas(), ['loja:amazon'], 'reabriu');
  assert.deepEqual(r.devidos.problemas, [], 'mas o freio segura: o último aviso (o "voltou") foi às 12:00');
  assert.ok(r.linhas.some((l) => l.level === 'info' && l.message === 'Aviso do vigia sobre Amazon parada segurado (freio de 3 h).'), textos(r).join('\n'));
  r = v.rodar([], { agora: T(14, 59) });
  assert.deepEqual(r.devidos.problemas, []);
  assert.deepEqual(r.linhas, [], 'a linha do freio sai uma vez, não a cada passada');
  r = v.rodar([], { agora: T(15) });
  assert.deepEqual(chaves(r.devidos.problemas), ['loja:amazon'], 'passadas as 3 h, o aviso sai (a causa segue aberta)');
});

test('CA3.2 voltou sai uma vez, só se o problema foi avisado', () => {
  // sem aviso de problema (silêncio, WhatsApp fora…): fecha só com a linha do Histórico
  const a = vigia();
  tresQuedas(a, [[9, 0], [10, 0], [11, 0]]);
  let r = a.rodar([saiuAmazon(12)]);
  assert.deepEqual(r.devidos.voltas, []);
  assert.deepEqual(r.linhas, [{ level: 'info', message: 'Vigia: Amazon voltou a enviar (esteve parada por 3 h).' }]);

  // avisada: um "voltou", que fica devido até sair e some depois de marcado
  const b = vigia();
  r = tresQuedas(b, [[9, 0], [10, 0], [11, 0]]);
  b.avisar(r, T(11));
  r = b.rodar([saiuAmazon(12)]);
  assert.deepEqual(chaves(r.devidos.voltas), ['loja:amazon']);
  assert.equal(mensagemVoltas(r.devidos.voltas, T(12)), '✅ *Amazon voltou a enviar*\nSaiu uma oferta às 12:00 (a loja esteve parada por 3 h). Nada a fazer.');
  r = b.rodar([], { agora: T(12, 5) });
  assert.deepEqual(chaves(r.devidos.voltas), ['loja:amazon'], 'não saiu (silêncio): continua devido (D9)');
  b.voltar(r, T(12, 5));
  r = b.rodar([saiuAmazon(13)]);
  assert.deepEqual(r.devidos.voltas, [], 'uma vez só');
  assert.deepEqual(r.linhas, []);

  // D9: a causa reabriu antes de o "voltou" sair: ele não sai, e a reaberta não gera outro aviso de problema
  const c = vigia();
  r = tresQuedas(c, [[9, 0], [10, 0], [11, 0]]);
  c.avisar(r, T(11));
  c.rodar([saiuAmazon(12)]);
  r = tresQuedas(c, [[16, 0], [17, 0], [18, 0]]);
  assert.deepEqual(r.devidos.voltas, []);
  assert.deepEqual(r.devidos.problemas, [], 'para o dono o problema nunca acabou: já foi avisado');
  assert.equal(causasAbertas(c.estado, { regrasAtivas: REGRAS, agora: T(18) })[0].desdeEm, T(9), 'mantém o início original');
  r = c.rodar([saiuAmazon(19)]);
  assert.deepEqual(chaves(r.devidos.voltas), ['loja:amazon']);
  assert.match(mensagemVoltas(r.devidos.voltas, T(19)), /esteve parada por 10 h\)/);
});

test('CA3.2 revisão fecha com 5, não com 9', () => {
  const v = vigia();
  let r = v.rodar([ex(T(9), { ml: { saiu: 1 } })], { revisao: { n: 12, maisAntigaEm: T(8) } });
  v.avisar(r, T(9));
  for (const n of [9, 6]) {
    r = v.rodar([], { revisao: { n, maisAntigaEm: T(8) }, agora: T(10) });
    assert.deepEqual(v.abertas(), ['revisao'], `com ${n} continua aberta`);
    assert.deepEqual(r.devidos.voltas, []);
  }
  r = v.rodar([], { revisao: { n: 5, maisAntigaEm: T(8) }, agora: T(11) });
  assert.deepEqual(v.abertas(), []);
  assert.deepEqual(r.linhas, [{ level: 'info', message: 'Vigia: revisão em dia (restam 5 ofertas esperando).' }]);
  assert.equal(mensagemVoltas(r.devidos.voltas, T(11)), '✅ *Revisão em dia*\nRestam 5 ofertas esperando. Nada a fazer.');
  const so = (n) => mensagemVoltas([{ tipo: 'revisao', chave: 'revisao', n, desdeEm: T(9), fechadaEm: T(11) }], T(11));
  assert.equal(so(1), '✅ *Revisão em dia*\nResta 1 oferta esperando. Nada a fazer.');
  assert.equal(so(0), '✅ *Revisão em dia*\nNenhuma oferta esperando. Nada a fazer.');
});

// ---------- CA3.8: hierarquia ----------

test('CA3.8 Central em espera cala loja ML e regra só-ML; loja parada cala a regra vazia só dela; a raiz fecha e a derivada abre na execução seguinte', () => {
  const v = vigia({ central: { estado: 'em_espera', emEsperaDesde: T(8) } });
  const esperaMl = (h) => ex(T(h), { regra: 2, ml: { esperou: 2, motivos: { ml_espera: 2 } } });
  let r = v.rodar([esperaMl(9)]);
  assert.deepEqual(chaves(r.devidos.problemas), ['ml_fora']);
  r = v.rodar([esperaMl(10)]);
  assert.deepEqual(r.linhas, [{ level: 'info', message: 'Vigia: a regra “Só ML” saiu vazia, mas o Mercado Livre está em espera: sem aviso separado.' }]);
  r = v.rodar([esperaMl(11)]);
  assert.deepEqual(r.linhas, [{ level: 'info', message: 'Vigia: Mercado Livre parado (3 execuções sem envio), mas o Mercado Livre está em espera: sem aviso separado.' }],
    'a regra, já calada, não gera outra linha');
  assert.deepEqual(v.abertas(), ['ml_fora'], 'as caladas não abrem nem aparecem');
  assert.deepEqual(chaves(r.devidos.problemas), ['ml_fora']);
  // a Central voltou: a raiz fecha no tick; a loja do ML, que segue sem sair, abre na execução seguinte
  v.mudar({ central: { estado: 'respondendo', emEsperaDesde: null } });
  v.rodar([], { agora: T(11, 30) });
  assert.deepEqual(v.abertas(), []);
  r = v.rodar([ex(T(12), { regra: 2, ml: { pulada: 1, motivos: { link_central: 1 } } })]);
  assert.deepEqual(v.abertas(), ['loja:ml'], 'a regra só-ML continua calada, agora pela loja parada');
  assert.equal(mensagemProblemas(r.devidos.problemas, { agora: T(12) }).split('\n')[0], '⚠️ *Mercado Livre parado desde 09:00*');

  // a loja parada cala a regra vazia que só pede aquela loja
  const w = vigia();
  tresQuedas(w, [[9, 0], [10, 0], [11, 0]]);                                     // regra 1 (ML sai): abre a Amazon
  const soAmazon = (h) => ex(T(h), { regra: 3, amazon: { pulada: 1, motivos: { etiqueta_fora: 1 } } });
  w.rodar([soAmazon(12)]);
  r = w.rodar([soAmazon(13)]);
  assert.deepEqual(r.linhas, [{ level: 'info', message: 'Vigia: a regra “Só Amazon” saiu vazia, mas a Amazon está parada: sem aviso separado.' }]);
  assert.deepEqual(w.abertas(), ['loja:amazon']);
  w.rodar([saiuAmazon(14)]);                                                     // a raiz fecha
  assert.deepEqual(w.abertas(), []);
  r = w.rodar([soAmazon(15)]);                                                   // a derivada continua: abre
  assert.deepEqual(w.abertas(), ['regra:3']);
  assert.deepEqual(chaves(r.devidos.problemas), ['regra:3']);
  assert.match(mensagemProblemas(r.devidos.problemas, { agora: T(15) }), /^⚠️ \*A regra “Só Amazon” saiu vazia 3 vezes seguidas\*\nDe 12:00 a 15:00 nenhuma oferta saiu/);
});

// ---------- CA3.12: causa sem objeto ----------

test('CA3.12 regra apagada ou desligada fecha a regra vazia sem voltou; modo direto fecha extensão/Central', () => {
  // regra desligada ou apagada
  const v = vigia();
  v.rodar([ex(T(9), { ml: { pulada: 1, motivos: { filtros: 1 } } })]);
  let r = v.rodar([ex(T(10), { ml: { pulada: 1, motivos: { filtros: 1 } } })]);
  v.avisar(r, T(10));
  v.mudar({ regrasAtivas: REGRAS.filter((x) => x.id !== 1) });
  r = v.rodar([], { agora: T(10, 30) });
  assert.deepEqual(v.abertas(), []);
  assert.deepEqual(r.devidos.voltas, [], 'fecha sem "voltou", mesmo avisada');
  assert.deepEqual(r.linhas, [{ level: 'info', message: 'Vigia: o aviso de regra vazia foi encerrado sem aviso de volta: a regra foi desligada ou apagada.' }]);
  v.mudar({ regrasAtivas: REGRAS });
  v.rodar([ex(T(11), { amazon: { pulada: 1 } })]);
  assert.deepEqual(v.abertas(), [], 'religada, a sequência recomeça do zero');

  // o "voltou" devido de uma regra desligada antes de ele sair não sai mais (não há mais nome para dar)
  const z = vigia();
  z.rodar([ex(T(9), { amazon: { pulada: 1 } })]);
  r = z.rodar([ex(T(10), { amazon: { pulada: 1 } })]);
  z.avisar(r, T(10));
  r = z.rodar([ex(T(11), { ml: { saiu: 1 } })]);
  assert.deepEqual(chaves(r.devidos.voltas), ['regra:1']);
  z.mudar({ regrasAtivas: REGRAS.filter((x) => x.id !== 1) });
  r = z.rodar([], { agora: T(11, 30) });
  assert.deepEqual(r.devidos.voltas, []);

  // a loja saiu das regras ativas
  const w = vigia();
  r = tresQuedas(w, [[9, 0], [10, 0], [11, 0]]);
  w.avisar(r, T(11));
  w.mudar({ regrasAtivas: [REGRAS[1]] });                                         // só a regra "Só ML"
  r = w.rodar([], { agora: T(11, 30) });
  assert.deepEqual(w.abertas(), []);
  assert.deepEqual(r.devidos.voltas, []);
  assert.deepEqual(r.linhas, [{ level: 'info', message: 'Vigia: o aviso de Amazon parada foi encerrado sem aviso de volta: nenhuma regra ativa pede a Amazon.' }]);

  // o modo de link virou direto
  const x = vigia({ extensao: { online: false, desde: T(8) } });
  r = x.rodar([ex(T(9), { regra: 2, ml: { esperou: 1, motivos: { ml_extensao: 1 } } })]);
  x.avisar(r, T(9));
  x.mudar({ modoLink: 'direct' });
  r = x.rodar([], { agora: T(9, 30) });
  assert.deepEqual(x.abertas(), []);
  assert.deepEqual(r.devidos.voltas, []);
  assert.deepEqual(r.linhas, [{ level: 'info', message: 'Vigia: o aviso do Mercado Livre foi encerrado sem aviso de volta: os links não usam mais a extensão do Chrome.' }]);

  // nenhuma regra ativa pede o Mercado Livre
  const y = vigia({ extensao: { online: false, desde: T(8) } });
  r = y.rodar([ex(T(9), { regra: 2, ml: { esperou: 1, motivos: { ml_extensao: 1 } } })]);
  y.avisar(r, T(9));
  y.mudar({ regrasAtivas: [REGRAS[2]] });
  r = y.rodar([], { agora: T(9, 30) });
  assert.deepEqual(y.abertas(), []);
  assert.deepEqual(r.devidos.voltas, []);
  assert.deepEqual(r.linhas, [{ level: 'info', message: 'Vigia: o aviso do Mercado Livre foi encerrado sem aviso de volta: nenhuma regra ativa pede o Mercado Livre.' }]);
});

// ---------- CA3.5 e CA3.7: o que sai para fora e o nível das linhas ----------

const NOME_RUIM = 'Black *VIP* 35 99999-1234 fulano@exemplo.com 5535999991234@s.whatsapp.net\nsegunda linha comprida demais';
const ULTIMO_ERRO = 'falhou para 5535988887777@s.whatsapp.net (dono@exemplo.com) token=abc123segredo';

/** Um dia ruim com todas as causas, caladas, freio, voltas e objeto perdido: devolve tudo o que o vigia escreveu. */
function diaRuim() {
  const regras = [{ id: 7, nome: NOME_RUIM, lojas: ['ml'] }, { id: 8, nome: `${NOME_RUIM} 2`, lojas: ['amazon'] }, { id: 9, nome: '', lojas: [] }];
  const v = vigia({
    regrasAtivas: regras, revisao: { n: 11, maisAntigaEm: T(6) },
    extensao: { online: true, desde: T(6), ultimoErro: ULTIMO_ERRO },
    central: { estado: 'em_espera', emEsperaDesde: T(8), ultimoErro: ULTIMO_ERRO, falhasSeguidas: 3 },
  });
  const saidas = [];
  const amz = (h) => ex(T(h), { regra: 8, amazon: { pulada: 2, motivos: { etiqueta_bloqueio: 2 } } });
  const ml = (h) => ex(T(h), { regra: 7, ml: { esperou: 4, motivos: { ml_espera: 4 } } });
  let r = v.rodar([amz(9), ml(9)]);
  r = v.rodar([amz(10), ml(10), ex(T(10, 5), { regra: 9, shopee: { pulada: 1 } })]);
  r = v.rodar([amz(11), ml(11), ex(T(11, 5), { regra: 9, shopee: { pulada: 1 } })]);
  for (const motivo of [null, 'silencio', 'whatsapp']) saidas.push(mensagemProblemas(r.devidos.problemas, { motivo, agora: T(11, 5) }));
  for (const c of r.devidos.problemas) saidas.push(mensagemProblemas([c], { agora: T(11, 5) }));
  v.avisar(r, T(11, 5));
  v.mudar({ central: { estado: 'respondendo', emEsperaDesde: null, ultimoErro: ULTIMO_ERRO }, revisao: { n: 0 } });
  r = v.rodar([ex(T(12), { regra: 8, amazon: { saiu: 1 } }), ex(T(12, 5), { regra: 9, shopee: { saiu: 1 } })]);
  saidas.push(mensagemVoltas(r.devidos.voltas, T(12, 5)));
  for (const c of r.devidos.voltas) saidas.push(mensagemVoltas([c], T(12, 5)));
  v.voltar(r, T(12, 5));
  tresQuedasCom(v, 8, [13, 14, 15]);                                             // reabre dentro do freio
  v.mudar({ regrasAtivas: regras.filter((x) => x.id !== 8) });                     // a regra 8, aberta, some
  v.rodar([], { agora: T(15, 30) });
  const abertas = causasAbertas(v.estado, { regrasAtivas: regras, agora: T(16) });
  saidas.push(linhaDeSaude({ execucoes: [amz(9), ml(9)], revisao: 11, abertas, temRegraAtiva: true, agora: T(21) }));
  // várias causas de uma vez, inclusive acima do máximo de itens
  const muitas = Array.from({ length: 9 }, (_, i) => ({ tipo: 'regra', chave: `regra:${i + 1}`, rule_id: i + 1, regra: NOME_RUIM, n: 2, fora: 3, motivos: { filtros: 3 }, horas: [T(9), T(10)], desdeEm: T(9) }));
  saidas.push(mensagemProblemas(muitas, { motivo: 'whatsapp', agora: T(10) }));
  saidas.push(mensagemVoltas(muitas.map((c) => ({ ...c, fechadaEm: T(11), saiu: 2 })), T(11)));
  return { linhas: v.linhas, saidas: saidas.filter((s) => s != null) };
}
function tresQuedasCom(v, regra, horas) {
  for (const h of horas) v.rodar([ex(T(h), { regra, amazon: { pulada: 1, motivos: { etiqueta_fora: 1 } } })]);
}

test('CA3.5 nenhuma mensagem do vigia tem @s.whatsapp.net, sequência de 8 ou mais dígitos, e-mail nem o texto do último erro', () => {
  const { linhas, saidas } = diaRuim();
  assert.ok(saidas.length >= 10, `mensagens montadas: ${saidas.length}`);
  const tudo = [...saidas, ...linhas.map((l) => l.message)];
  for (const t of tudo) {
    assert.equal(typeof t, 'string');
    assert.ok(!t.includes('@s.whatsapp.net'), t);
    assert.ok(!/\d{8,}/.test(t), t);
    assert.ok(!/[^\s@]+@[^\s@]+\.[^\s@]+/.test(t), t);
    assert.ok(!t.includes('@'), t);
    for (const pedaco of ['99999', 'abc123segredo', 'token=', 'falhou para', 'dono@']) assert.ok(!t.includes(pedaco), `${pedaco} em: ${t}`);
    for (const [, nome] of t.matchAll(/“([^”]*)”/g)) {
      assert.ok(nome.length <= MAX_NOME_VIGIA, `nome com ${nome.length} caracteres: ${nome}`);
      assert.ok(!nome.includes('*') && !nome.includes('\n'), nome);
    }
  }
  assert.ok(saidas.some((s) => s.includes('“Black VIP')), 'o nome da regra aparece, limpo');
  assert.ok(saidas.some((s) => s.includes('“sem nome”')), 'nome vazio vira "sem nome"');
  // o nome, sozinho
  const n = nomeSeguro(NOME_RUIM);
  assert.ok(n.length <= MAX_NOME_VIGIA && !n.includes('*') && !n.includes('\n') && !/\d{5,}/.test(n) && !n.includes('@'), n);
  assert.equal(nomeSeguro('Achados do dia'), 'Achados do dia');
  assert.equal(nomeSeguro('a'.repeat(50)), `${'a'.repeat(MAX_NOME_VIGIA - 1)}…`);
  assert.equal(nomeSeguro(`${'a'.repeat(39)}😀b`).length <= MAX_NOME_VIGIA, true);
  assert.ok(!/[\uD800-\uDBFF]…$/.test(nomeSeguro(`${'a'.repeat(38)}😀😀`)), 'o corte não parte um emoji ao meio');
  for (const vazio of ['', null, undefined, '   ', '***']) assert.equal(nomeSeguro(vazio), 'sem nome');
});

test('CA3.7 avaliar só devolve linhas aviso ou info (nunca erro)', () => {
  const { linhas } = diaRuim();
  assert.ok(linhas.length >= 8, `linhas: ${linhas.length}`);
  for (const l of linhas) {
    assert.ok(l.level === 'aviso' || l.level === 'info', JSON.stringify(l));
    assert.ok(/^(Vigia: |Aviso do vigia )/.test(l.message), l.message);
  }
  assert.ok(linhas.some((l) => l.level === 'aviso') && linhas.some((l) => l.level === 'info'));
});

// ---------- estado, reinício e cursor ----------

test('reinício: o mesmo estado (lido do JSON) e as mesmas execuções não repetem aviso nem reabrem', () => {
  const v = vigia();
  const linhas = [ex(T(9), { ml: { saiu: 1 }, amazon: { pulada: 1 } }), ex(T(10), { ml: { saiu: 1 }, amazon: { pulada: 1 } }), ex(T(11), { ml: { saiu: 1 }, amazon: { pulada: 1 } })];
  let r = v.rodar(linhas);
  assert.deepEqual(chaves(r.devidos.problemas), ['loja:amazon']);
  v.avisar(r, T(11));
  const gravado = JSON.parse(JSON.stringify(v.estado));
  r = avaliar({
    execucoes: linhas, estado: gravado, revisao: { n: 0 }, extensao: { online: true, desde: T(11, 1) },
    central: { estado: 'respondendo' }, regrasAtivas: REGRAS, modoLink: 'extension', agora: T(11, 2),
  });
  assert.deepEqual(r.linhas, []);
  assert.deepEqual(r.devidos, { problemas: [], voltas: [] });
  assert.deepEqual(causasAbertas(r.estado, { regrasAtivas: REGRAS, agora: T(11, 2) }).map((c) => c.chave), ['loja:amazon']);
});

test('estado sem cursor (primeira vez, ou estado descartado): marca a última execução e não avalia o passado', () => {
  const antigas = [9, 10, 11, 12].map((h) => ex(T(h), { ml: { pulada: 1 }, amazon: { pulada: 1 } }));
  const base = { revisao: { n: 50 }, extensao: { online: false, desde: T(1) }, central: { estado: 'em_espera', emEsperaDesde: T(1) }, regrasAtivas: REGRAS, modoLink: 'extension' };
  let r = avaliar({ ...base, execucoes: antigas, estado: null, agora: T(13) });
  assert.deepEqual(r.linhas, []);
  assert.deepEqual(r.devidos, { problemas: [], voltas: [] });
  assert.equal(r.estado.cursor, antigas.at(-1).id);
  r = avaliar({ ...base, execucoes: [], estado: 'lixo', agora: T(13) });
  assert.equal(r.estado.cursor, null, 'sem execução para marcar, segue sem cursor');
  // só as novas contam: uma queda depois do cursor é a primeira da sequência
  const v = avaliar({ ...base, execucoes: [...antigas, ex(T(14), { ml: { saiu: 1 }, amazon: { pulada: 1 } })], estado: { cursor: antigas.at(-1).id }, extensao: { online: true, desde: T(1) }, central: { estado: 'respondendo' }, revisao: { n: 0 }, agora: T(14) });
  assert.deepEqual(causasAbertas(v.estado, { regrasAtivas: REGRAS, agora: T(14) }), []);
  assert.equal(v.estado.seq.lojas.amazon.n, 1);
});

test('lerEstado descarta o que está fora do formato e corta o instante no futuro para agora', () => {
  const agora = T(12);
  const futuro = T(12, 0, 20);
  const bruto = JSON.stringify({
    cursor: 7,
    abertas: {
      'loja:amazon': { tipo: 'loja', desdeEm: futuro, avisadaEm: futuro, n: 3, fora: 4, motivos: { etiqueta_fora: 2, __proto__x: 1, 'chave ruim': 3, ok_mas_negativo: -1 } },
      'loja:shopee': { desdeEm: T(9) }, 'regra:abc': { desdeEm: T(9) }, ml_fora: { tipo: 'central', desdeEm: 'ontem' },
      revisao: { desdeEm: T(9), n: 12, maisAntigaEm: futuro }, 'regra:4': { desdeEm: T(9), n: 2, horas: ['x', T(10)] },
    },
    ultimoAviso: { revisao: futuro, 'loja:amazon': T(11), toString: T(10) },
    voltas: { 'loja:ml': { desdeEm: T(8), fechadaEm: T(9), saiu: 2 }, 'regra:5': { desdeEm: T(8) } },
    caladas: { 'regra:4': true, lixo: true },
    seq: { lojas: { amazon: { n: 2, desde: T(9) }, shopee: { n: 9, desde: T(9) } }, regras: { 4: { n: 1, desde: T(9) }, abc: { n: 1, desde: T(9) } } },
  });
  const e = lerEstado(bruto, agora);
  assert.equal(e.cursor, 7);
  assert.deepEqual(Object.keys(e.abertas).sort(), ['loja:amazon', 'regra:4', 'revisao']);
  assert.equal(e.abertas['loja:amazon'].desdeEm, agora);
  assert.equal(e.abertas['loja:amazon'].avisadaEm, agora);
  assert.deepEqual(e.abertas['loja:amazon'].motivos, { etiqueta_fora: 2 });
  assert.equal(e.abertas.revisao.maisAntigaEm, agora);
  assert.deepEqual(e.abertas['regra:4'].horas, [T(9), T(10)]);
  assert.deepEqual({ ...e.ultimoAviso }, { revisao: agora, 'loja:amazon': T(11) });
  assert.deepEqual(Object.keys(e.voltas), ['loja:ml']);
  assert.deepEqual(Object.keys(e.caladas), ['regra:4']);
  assert.deepEqual(Object.keys(e.seq.lojas), ['amazon']);
  assert.deepEqual(Object.keys(e.seq.regras), ['4']);
  for (const lixo of [null, undefined, 'lixo', '[]', 42, [], '{"cursor":-1}', '{"cursor":1.5}']) {
    const x = lerEstado(lixo, agora);
    assert.equal(x.cursor, null, String(lixo));
    assert.deepEqual(x.abertas, {});
  }
  // nunca muda o objeto recebido
  const original = { cursor: 1, abertas: { revisao: { desdeEm: futuro, n: 10 } } };
  const copia = structuredClone(original);
  lerEstado(original, agora);
  assert.deepEqual(original, copia);
});

test('avaliar recusa entrada sem relógio ou sem a lista de regras ativas (o createVigia marca ok=false)', () => {
  assert.throws(() => avaliar({ regrasAtivas: [], agora: Number.NaN }), TypeError);
  assert.throws(() => avaliar({ regrasAtivas: null, agora: T(9) }), TypeError);
  assert.throws(() => avaliar(), TypeError);
});

// ---------- mensagens com várias causas (spec §1.8) e datas ----------

const AMAZON = { tipo: 'loja', chave: 'loja:amazon', loja: 'amazon', n: 3, fora: 5, motivos: { etiqueta_bloqueio: 5 }, desdeEm: T(22, 40, 10) };
const REVISAO = { tipo: 'revisao', chave: 'revisao', n: 12, desdeEm: T(22, 50, 10), maisAntigaEm: T(20, 0, 10) };
const EXTENSAO = { tipo: 'extensao', chave: 'ml_fora', n: 4, desdeEm: T(23, 0, 10) };
const REGRA = { tipo: 'regra', chave: 'regra:1', rule_id: 1, regra: 'Achados do dia', n: 2, fora: 3, motivos: { parecido: 3 }, horas: [T(21, 0, 10), T(22, 0, 10)], desdeEm: T(21, 0, 10) };

test('mensagens: 2 causas juntas depois do silêncio, no molde da spec', () => {
  assert.equal(mensagemProblemas([REVISAO, AMAZON], { motivo: 'silencio', agora: T(7) }), [
    '⚠️ *2 problemas: Amazon parada, revisão acumulada*',
    'O programa estava em silêncio e agora vai avisando.',
    '',
    '1. *Amazon parada desde 22:40 de 10/11.* Nenhuma oferta saiu nas últimas 3 execuções. Fazer: nada por agora: o programa tenta de novo no próximo envio. Se continuar, abra a Amazon no Chrome e veja se pede verificação.',
    '2. *12 ofertas esperando a sua revisão.* Fazer: abra Histórico > Catálogo.',
  ].join('\n'));
  // 1 causa: a mensagem normal, sem cabeçalho extra, com o início original
  assert.equal(mensagemProblemas([AMAZON], { motivo: 'silencio', agora: T(7) }), mensagemProblemas([AMAZON], { motivo: null, agora: T(7) }));
  assert.match(mensagemProblemas([AMAZON], { agora: T(7) }), /^⚠️ \*Amazon parada desde 22:40 de 10\/11\*\n/);
  assert.match(mensagemProblemas([AMAZON], { agora: T(23, 0, 10) }), /^⚠️ \*Amazon parada desde 22:40\*\n/);
  assert.equal(mensagemProblemas([], { agora: T(7) }), null);
  assert.equal(mensagemVoltas([], T(7)), null);
});

test('mensagens: 4 causas ficam curtas (título com 3 e "e mais 1"), WhatsApp de volta', () => {
  assert.equal(mensagemProblemas([REGRA, REVISAO, EXTENSAO, AMAZON], { motivo: 'whatsapp', agora: T(7) }), [
    '⚠️ *4 problemas: Amazon parada, extensão fora, revisão acumulada e mais 1*',
    'O WhatsApp ficou desconectado e agora voltou.',
    '',
    '1. *Amazon parada desde 22:40 de 10/11.* Fazer: nada por agora: o programa tenta de novo no próximo envio. Se continuar, abra a Amazon no Chrome e veja se pede verificação.',
    '2. *Extensão do Chrome fora desde 23:00 de 10/11.* Fazer: abra o Chrome com a extensão instalada e entre na Central de Afiliados com a sua conta.',
    '3. *12 ofertas esperando a sua revisão.* Fazer: abra Histórico > Catálogo.',
    '4. *A regra “Achados do dia” saiu vazia 2 vezes seguidas.* Fazer: o catálogo está repetindo ofertas recentes. Em geral nada a fazer.',
    'Detalhes no painel, no Histórico.',
  ].join('\n'));
  // 3 causas: com o detalhe de cada uma, sem a frase do fim
  const tres = mensagemProblemas([REGRA, { ...EXTENSAO, tipo: 'central' }, AMAZON], { motivo: null, agora: T(7) }).split('\n');
  assert.equal(tres[0], '⚠️ *3 problemas: Amazon parada, Mercado Livre em espera, regra “Achados do dia” vazia*');
  assert.equal(tres[1], '', 'sem motivo, sem a frase sob o título');
  assert.equal(tres[3], '2. *Mercado Livre em espera desde 23:00 de 10/11.* A Central de Afiliados não está respondendo. Fazer: nada, a menos que passe de 1 hora. Aí abra a Central no Chrome e veja se a página carrega e se a sua conta está logada.');
  assert.equal(tres[4], '3. *A regra “Achados do dia” saiu vazia 2 vezes seguidas.* Às 21:00 de 10/11 e às 22:00 de 10/11 nenhuma oferta saiu. Fazer: o catálogo está repetindo ofertas recentes. Em geral nada a fazer.');
  assert.equal(tres.length, 5);
  // acima de 6 itens, o resto vira uma linha
  const muitas = Array.from({ length: 8 }, (_, i) => ({ ...REGRA, chave: `regra:${i + 1}`, rule_id: i + 1, regra: `Regra ${String.fromCharCode(65 + i)}` }));
  const m = mensagemProblemas(muitas, { agora: T(7) }).split('\n');
  assert.equal(m[0], '⚠️ *8 problemas: regra “Regra A” vazia, regra “Regra B” vazia, regra “Regra C” vazia e mais 5*');
  assert.equal(m.at(-2), 'E mais 2 problemas.');
  assert.equal(m.at(-1), 'Detalhes no painel, no Histórico.');
});

test('mensagens: vários "voltou" numa mensagem só', () => {
  const voltas = [
    { ...REGRA, fechadaEm: T(9), saiu: 2 },
    { ...REVISAO, n: 3, fechadaEm: T(8, 30) },
    { ...EXTENSAO, tipo: 'central', desdeEm: T(6), fechadaEm: T(6, 40) },
    { ...AMAZON, fechadaEm: T(1, 10), saiu: 1 },
  ];
  assert.equal(mensagemVoltas(voltas, T(9)), [
    '✅ *4 problemas voltaram ao normal*',
    '1. *Amazon voltou a enviar* (esteve parada por 2 h 30 min).',
    '2. *Mercado Livre voltou a enviar* (a Central de Afiliados respondeu de novo; esteve fora por 40 min).',
    '3. *Revisão em dia* (restam 3 ofertas esperando).',
    '4. *A regra “Achados do dia” voltou a enviar* (saíram 2 ofertas às 09:00).',
    'Nada a fazer.',
  ].join('\n'));
  assert.equal(mensagemVoltas([voltas[0]], T(9)), '✅ *A regra “Achados do dia” voltou a enviar*\nSaíram 2 ofertas às 09:00. Nada a fazer.');
  assert.equal(mensagemVoltas([{ ...EXTENSAO, desdeEm: T(6), fechadaEm: T(6, 40) }], T(9)),
    '✅ *Mercado Livre voltou a enviar*\nA Extensão do Chrome respondeu de novo (esteve fora por 40 min). As ofertas saem sozinhas, nada a fazer.');
});

// ---------- motivo e ação (spec §1.6) ----------

test('MOTIVO_VIGIA: toda causa conhecida tem motivo da lista fechada; empate fica com o primeiro da tabela', () => {
  const LISTA = ['a Amazon bloqueou a leitura', 'o Etiqueta não respondeu', 'o preço não pôde ser conferido', 'preço subiu além do limite',
    'esgotada na loja', 'indisponível na loja', 'fora dos filtros da regra', 'já enviadas ou parecidas', 'outro motivo'];
  for (const k of [...Object.keys(CAUSAS), ...Object.keys(CAUSAS_CENTRAL), ...Object.keys(MOTIVOS_VERIFICADOR),
    'parecido', 'filtros', 'espera', 'revisao_cheia', 'link', 'envio', 'conferencia', 'sem_preco', 'desligado', 'link_central',
    'ml_espera', 'orcamento', 'recusada_ml', 'ml_direto', 'ml_extensao', 'etiqueta', 'amazon', 'semConferencia', 'mlPausa']) {
    assert.ok(Object.hasOwn(MOTIVO_VIGIA, k), `sem motivo: ${k}`);
    assert.ok(LISTA.includes(MOTIVO_VIGIA[k].motivo), `${k}: ${MOTIVO_VIGIA[k].motivo}`);
    assert.ok(MOTIVO_VIGIA[k].acao.length > 10 && /[.]$/.test(MOTIVO_VIGIA[k].acao), k);
  }
  assert.deepEqual([...new Set(Object.values(MOTIVO_VIGIA).map((m) => m.motivo))].sort(), [...LISTA].sort(), 'usa as 9 da spec');
  assert.equal(MOTIVO_VIGIA.orcamento.motivo, 'outro motivo', 'D8 da E2');
  // empate: o primeiro da tabela
  assert.equal(motivoDe({ esgotado: 2, etiqueta_fora: 2 }).motivo, 'o Etiqueta não respondeu');
  assert.equal(motivoDe({ esgotado: 3, etiqueta_fora: 2 }).motivo, 'esgotada na loja');
  // várias chaves da mesma linha somam
  assert.equal(motivoDe({ loja_fora: 1, demorou: 1, sem_preco: 1, esgotado: 2 }).motivo, 'o preço não pôde ser conferido');
  // filtros e parecidas só valem para a regra vazia
  assert.equal(motivoDe({ filtros: 5, esgotado: 1 }).motivo, 'esgotada na loja');
  assert.equal(motivoDe({ filtros: 5, esgotado: 1 }, { regra: true }).motivo, 'fora dos filtros da regra');
  assert.equal(motivoDe({ parecido: 2 }).motivo, 'outro motivo');
  // chave desconhecida, vazia ou estranha: outro motivo (nunca o texto da chave)
  assert.deepEqual(motivoDe({ 'texto livre 5535999991234': 3 }), { motivo: 'outro motivo', acao: 'Veja o Histórico no painel.' });
  assert.equal(motivoDe({}).motivo, 'outro motivo');
  assert.equal(motivoDe(null).motivo, 'outro motivo');
  assert.equal(motivoDe({ toString: 9, __proto__: 1 }).motivo, 'outro motivo');
});

// ---------- linha de saúde (spec §2) ----------

test('resumo: a linha de saúde com os números do dia (exemplo da spec)', () => {
  const dia = [
    ex(T(9), { ml: { saiu: 5, descartada: 1 }, amazon: { saiu: 10, pulada: 2 }, erros: 1 }),
    ex(T(12), { lojas: ['amazon', 'ml'], ml: { saiu: 4, descartada: 1 }, amazon: { saiu: 4, pulada: 1, esperou: 3 } }),
  ];
  assert.equal(linhaDeSaude({ execucoes: dia, revisao: 7, abertas: [{ ...AMAZON, desdeEm: T(9, 10) }], temRegraAtiva: true, agora: T(21) }), [
    '🩺 *Saúde dos envios* (todas as regras)',
    'Amazon: 14 enviadas · Mercado Livre: 9 enviadas',
    'Puladas: 6 · Descartadas: 2 · Falhas: 1',
    'Esperando revisão: 7',
    'Em aberto agora: Amazon parada desde 09:10.',
  ].join('\n'));
});

test('resumo: dia sem execução, dia sem nada a relatar e dia com tudo zero', () => {
  assert.equal(linhaDeSaude({ execucoes: [], revisao: 0, abertas: [], temRegraAtiva: false, agora: T(21) }),
    '🩺 *Saúde dos envios*\nNenhuma regra rodou hoje: não havia regra ativa com horário no dia.');
  assert.equal(linhaDeSaude({ execucoes: [ex(T(9), { ml: { saiu: 2 } })], revisao: 0, abertas: [], temRegraAtiva: true, agora: T(21) }), [
    '🩺 *Saúde dos envios* (todas as regras)',
    'Mercado Livre: 2 enviadas · Amazon: 0 enviadas',
    'Nenhuma pulada, descartada nem falha. Nada esperando revisão.',
  ].join('\n'));
  // há regra ativa e nenhuma rodou: mostra os zeros (o número fala) e o que está em aberto
  assert.equal(linhaDeSaude({ execucoes: [], revisao: { n: 0 }, abertas: [REVISAO, EXTENSAO], temRegraAtiva: true, agora: T(21, 0, 10) }), [
    '🩺 *Saúde dos envios* (todas as regras)',
    'Puladas: 0 · Descartadas: 0 · Falhas: 0',
    'Esperando revisão: nenhuma',
    'Em aberto agora: extensão fora desde 23:00; 12 ofertas esperando revisão desde 22:50.',
  ].join('\n'));
  // regras rodaram sem nada novo (conta=0): as lojas pedidas aparecem com 0
  assert.equal(linhaDeSaude({ execucoes: [ex(T(9), { conta: 0, lojas: ['magalu'] })], revisao: 0, abertas: [], temRegraAtiva: true, agora: T(21) }), [
    '🩺 *Saúde dos envios* (todas as regras)',
    'Magalu: 0 enviadas',
    'Puladas: 0 · Descartadas: 0 · Falhas: 0',
    'Esperando revisão: nenhuma',
  ].join('\n'));
});

test('resumo: singular, loja que enviou sem ser pedida, várias em aberto', () => {
  const dia = [ex(T(9), { lojas: ['amazon'], amazon: { saiu: 1, pulada: 1 }, shopee: { saiu: 3 } })];
  assert.equal(linhaDeSaude({ execucoes: dia, revisao: 1, abertas: [AMAZON, REGRA], temRegraAtiva: true, agora: T(21, 0, 10) }), [
    '🩺 *Saúde dos envios* (todas as regras)',
    'Shopee: 3 enviadas · Amazon: 1 enviada',
    'Puladas: 1 · Descartadas: 0 · Falhas: 0',
    'Esperando revisão: 1',
    'Em aberto agora: Amazon parada desde 22:40; regra “Achados do dia” vazia desde 21:00.',
  ].join('\n'));
  // sem `agora` (nenhum relógio próprio): a data vai sempre junto
  assert.match(linhaDeSaude({ execucoes: dia, revisao: 0, abertas: [AMAZON], temRegraAtiva: true }), /Amazon parada desde 22:40 de 10\/11\.$/);
});
