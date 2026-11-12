// QA da entrega 3 de "Rodar sozinho" (Vigia). Peças reais ligadas pelo agendador (agendador, vigia, avisos, ritmo,
// catálogo, banco numa pasta temporária); só o WhatsApp (simulado), a extensão/Central (dublê do serviço de links), o
// Etiqueta e o verificador são de mentira. Nenhuma rede (o fetch global lança), nenhum relógio de verdade (só o Date é
// falso, desde antes do agendador), nenhum aleatório.
//
// Blocos:
//  1. "um dia" ponta a ponta (CA3.1, CA3.2, CA3.3, CA3.8, CA3.9, CA3.10): conta as mensagens e os destinatários;
//  2. casos de borda do "Foco de revisão" do plano e desvios declarados pelos devs;
//  3. as afirmações de comportamento dos Docs (cap-grupos, ajuda, README) provadas contra o código.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openDb, setSetting, getSetting } from '../src/db.js';
import { createScheduler } from '../src/scheduler.js';
import { createLinkService, ErroLinkML } from '../src/links.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createCatalogoItens } from '../src/catalogo-itens.js';
import { createAmazon } from '../src/amazon.js';
import { paraCandidato } from '../src/catalogo.js';
import { buildApp } from '../src/server.js';
import { CHAVE_ESTADO } from '../src/vigia.js';

// ------------------------------------------------------------------------------------------- sem rede nenhuma
const fetchOriginal = globalThis.fetch;
let chamadasDeRede = 0;
test.before(() => { globalThis.fetch = async () => { chamadasDeRede++; throw new Error('rede proibida no teste'); }; });
test.after(() => {
  globalThis.fetch = fetchOriginal;
  assert.equal(chamadasDeRede, 0, 'nenhum pedido de rede');
});

const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-qa-vigia-')); pastas.push(p); return p; };

const MIN = 60000;
const HORA = 60 * MIN;
const dia = (d, h, m = 0, s = 0) => new Date(2026, 10, d, h, m, s).getTime(); // novembro/2026, horário local
const hhmm = (ts) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const G1 = '111@g.us';
const PEDRO = '5511900000001@s.whatsapp.net';
const MARIA = '5511900000002@s.whatsapp.net';
const JOANA = '5511900000003@s.whatsapp.net';
const OUTRO = '5511900000004@s.whatsapp.net';
// o padrão de dado pessoal que NUNCA pode estar numa mensagem do vigia: JID, telefone (8+ dígitos), e-mail
const VAZAMENTO = /@s\.whatsapp\.net|@g\.us|\d{8,}|[\w.+-]+@[\w-]+\.[\w.]+/;

/** Títulos que não se parecem entre si (a trava de parecidos barraria os parecidos): três sílabas distintas por título. */
const SIL = ['ba', 'ce', 'di', 'fo', 'gu', 'ha', 'je', 'ki', 'lo', 'mu'];
const palavra = (i, k) => `${SIL[(i + k) % 10]}${SIL[(Math.floor(i / 10) + 3 * k) % 10]}${SIL[(i * (k + 2) + 7 * k) % 10]}nex${k}`;
const titulo = (i) => `Produto ${palavra(i, 1)} ${palavra(i, 2)} ${palavra(i, 3)}`;

/** Oferta no formato do Etiqueta. `precoEm` (ms) vira `preco_em` "AAAA-MM-DDTHH:MM:SS" (hora local). */
function oferta(i, loja, { precoEm = null } = {}) {
  const o = { id: i, loja, titulo: titulo(i), preco: 100, preco_antigo: 150, desconto_pct: 33, categoria: 'Casa' };
  if (loja === 'amazon') Object.assign(o, { item_id: `B0${String(i).padStart(8, '0')}`, link: 'https://www.amazon.com.br/dp/X?tag=terceiro-20' });
  if (loja === 'ml') Object.assign(o, { item_id: `MLB${4000000000 + i}`, link: 'https://meli.la/TerCeiro1' });
  if (loja === 'shopee') Object.assign(o, { item_id: `123.${i}`, link: `https://s.shopee.com.br/Ab${i}cd`, preco_antigo: null, desconto_pct: 0 });
  if (precoEm != null) {
    const d = new Date(precoEm); const p = (n) => String(n).padStart(2, '0');
    o.preco_em = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  return o;
}

/** Verificador falso: `semConferencia` (Set de precoEm que não têm como ser conferidos agora) é mutável. */
function verificadorFalso({ decisoes = {}, semConferencia = new Set() } = {}) {
  const v = {
    decisoes, semConferencia, pausa: null,
    ativo: () => true,
    async conferir(o) { return v.decisoes[o.title] ?? { acao: 'enviar', oferta: o, sufixo: null }; },
    semConfirmacaoAgora: ({ loja, precoEm }) => loja === 'amazon' && v.semConferencia.has(precoEm),
    pausaDaLeituraMl: () => v.pausa,
  };
  return v;
}

/**
 * Dublê do serviço de links no modo da extensão: `d.online`, `d.central` ({ estado, emEsperaDesde }). O `lastPollAt`
 * é o último instante em que a extensão estava on-line (0 se nunca). A lista da Central de Afiliados é sempre recusada.
 */
function linksDuble({ online = true, central = 'respondendo', desde = null, modo = 'extension' } = {}) {
  const base = createLinkService({ getMode: () => 'fake' });
  const pedir = base.requestLink;
  const d = { online, central: { estado: central, emEsperaDesde: desde }, link: null, modo, ultimoPoll: online ? Date.now() : 0 };
  Object.assign(base, {
    modo: () => d.modo,
    status: () => ({ online: d.online, lastPollAt: d.online ? Date.now() : d.ultimoPoll, central: { ...d.central } }),
    central: () => ({ ...d.central, testeLiberado: false }),
    requestLink: (p) => (d.link ? d.link(p) : pedir(p)),
    async requestOffers() { throw new ErroLinkML('nenhum pedido saiu', { classe: 'espera', causa: 'central_sem_resposta' }); },
  });
  d.cair = () => { d.ultimoPoll = Date.now(); d.online = false; };
  return { links: base, d };
}

/**
 * Agendador real com o catálogo falso, o registro real do Catálogo, o WhatsApp simulado e os números de aviso: Pedro
 * (recebe "Erro de disparo": é ele quem recebe o vigia), Maria (só o resumo diário), Joana (erro, mas desligada) e
 * "Outro" (só "Grupo lotando"). Relógio falso (Date) desde antes do agendador. `agendador(links)`: reinício no mesmo banco.
 */
function montar(t, { agora = dia(12, 8), links = null, verificador = null, ofertas = [] } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: agora });
  const dir = tmp(); const db = openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  if (!links) links = linksDuble().links;
  const amazon = createAmazon({ db, fetch: async () => { throw new Error('rede proibida (Amazon)'); }, esperar: async () => {}, lerConexao: () => ({ tag: 'achadinho-20' }) });
  const estado = { ofertas };
  const fonte = {
    async candidatos(cfg, ctx) { return estado.ofertas.filter((o) => (cfg.lojas?.length ? cfg.lojas.includes(o.loja) : true)).map(paraCandidato).filter((c) => c && !ctx.tratada(c, cfg.ordem)); },
    avancar() {},
  };
  const catalogoItens = createCatalogoItens({ db, wa, links, amazon });
  // relógio monotônico = o Date falso menos o tempo suspenso (s.dormiu): fora do teste da suspensão, o PC fica acordado
  const relogio = { dormiu: 0 };
  const agendador = (l = links) => createScheduler({ db, wa, links: l, fast: true, amazon, verificador, catalogo: fonte, catalogoItens, monotonico: () => Date.now() - relogio.dormiu });
  const scheduler = agendador();
  db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(G1, 'Achadinhos', 10, Date.now());
  db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etiquetaA', Date.now());
  const destino = db.prepare('INSERT INTO aviso_destinos (nome, jid, resumo_blocos, avisos, ativo, created_at) VALUES (?,?,?,?,?,?)');
  destino.run('Pedro', PEDRO, null, JSON.stringify(['erro']), 1, 1);
  destino.run('Maria', MARIA, '[]', '[]', 1, 1);
  destino.run('Joana', JOANA, null, JSON.stringify(['erro']), 0, 1);
  destino.run('Outro', OUTRO, null, JSON.stringify(['lotacao']), 1, 1);
  const s = { db, dir, wa, links, estado, scheduler, agendador, verificador, relogio };
  s.paraJid = (jid) => wa.simulated.filter((m) => m.jid === jid).map((m) => m.text);
  s.paraGrupo = () => wa.simulated.filter((m) => m.jid === G1).length;
  s.execucoes = () => db.prepare('SELECT * FROM execucoes ORDER BY id').all()
    .map((x) => ({ ...x, lojas_pedidas: JSON.parse(x.lojas_pedidas), por_loja: JSON.parse(x.por_loja) }));
  s.linhasVigia = () => db.prepare("SELECT level, message FROM log WHERE rule_name = 'Vigia' ORDER BY id").all().map((l) => ({ ...l }));
  s.estadoGravado = () => JSON.parse(getSetting(db, CHAVE_ESTADO));
  s.avancar = (ms) => t.mock.timers.setTime(Date.now() + ms);
  s.ir = (quando) => t.mock.timers.setTime(quando);
  s.silencio = (de, ate) => { setSetting(db, 'wa_silencio_ativo', '1'); setSetting(db, 'wa_silencio_de', de); setSetting(db, 'wa_silencio_ate', ate); };
  return s;
}

const COLUNAS = 'name, enabled, tag_id, template_id, group_jids, source_type, source_config, sources, per_run, interval_min, window_start, window_end, dedupe_days, send_image, created_at';
/** Regra com a fonte catálogo das `lojas` (padrão: a cada 60 min, das 08:00 às 22:00). → id */
function regraCatalogo(db, { nome = 'Catálogo', lojas = ['ml'], per = 1, janela = ['08:00', '22:00'], grupos = [G1], intervalo = 60 } = {}) {
  const fontes = [{ type: 'catalogo', tag_id: null, config: { ordem: 'relevancia', lojas } }];
  return Number(db.prepare(`INSERT INTO rules (${COLUNAS}) VALUES (?, 1, 1, 1, ?, 'list', '{}', ?, ?, ?, ?, ?, 7, 0, ?)`)
    .run(nome, JSON.stringify(grupos), JSON.stringify(fontes), per, intervalo, janela[0], janela[1], Date.now()).lastInsertRowid);
}
/** Regra de fonte antiga (sem catálogo): "Lista de links" com linhas de preço digitado ou a Central de Afiliados. → id */
function regraAntiga(db, tipo, { ids = [], nome = 'Antiga' } = {}) {
  const config = tipo === 'list' ? { items: ids.map((i) => `https://produto.mercadolivre.com.br/MLB-${4000000000 + i}-x | ${titulo(i)} | 50`).join('\n') } : {};
  return Number(db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id, group_jids, source_type, source_config, per_run, interval_min,
    window_start, window_end, dedupe_days, send_image, created_at) VALUES (?, 1, 1, 1, ?, ?, ?, 1, 60, '00:00', '23:59', 7, 0, ?)`)
    .run(nome, JSON.stringify([G1]), tipo, JSON.stringify(config), Date.now()).lastInsertRowid);
}
let seqItem = 0; // chave única por item (sem aleatório)
const itemRevisao = (db, ruleId, n, { desde = Date.now() } = {}) => {
  const ins = db.prepare(`INSERT INTO catalogo_itens (rule_id, chave, loja, status, motivos, oferta, criado_em) VALUES (?, ?, 'shopee', 'revisao', '["falha_link"]', '{}', ?)`);
  for (let i = 0; i < n; i++) ins.run(ruleId, `SHOPEE:777.${++seqItem}`, desde + i);
};

/**
 * "Enviar agora": a passada do vigia que o tick faria antes (inicia o cursor), a execução manual e a passada seguinte (o
 * runRule sozinho não chama o vigia, e rodar o tick inteiro rodaria também as regras vencidas).
 */
async function manual(s, id) {
  await s.scheduler.vigia.tick();
  await s.scheduler.runRule(id, { manual: true });
  await s.scheduler.vigia.aposExecucao();
}
/** Só a passada do vigia (sem rodar regra). */
const passada = (s) => s.scheduler.vigia.tick();

function capturarConsole(t) {
  const saida = [];
  t.mock.method(console, 'error', (...a) => { saida.push(a.map(String).join(' ')); });
  return saida;
}

function req(port, caminho) {
  return new Promise((ok, err) => {
    const r = http.request({ host: '127.0.0.1', port, path: caminho, method: 'GET', headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let txt = ''; res.setEncoding('utf8'); res.on('data', (c) => (txt += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(txt); } catch { /* html */ } ok({ status: res.statusCode, json }); });
    });
    r.on('error', err); r.end();
  });
}
function subirPainel(t, s, scheduler = s.scheduler) {
  const app = buildApp({ db: s.db, wa: s.wa, links: s.links, scheduler, publicHost: '', panelPassword: '', dataDir: s.dir });
  return new Promise((ok) => {
    const server = app.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }));
      ok({ port: server.address().port });
    });
  });
}

// ================================================================================================== 1. um dia inteiro

test('um dia ponta a ponta: Central cai e volta, Amazon para sem conferência, revisão 10 → 5, silêncio no meio, reinício', async (t) => {
  const VELHO = dia(11, 6); // preço da Amazon lido há mais de 24 h: o verificador não tem como conferir
  const v = verificadorFalso();
  const { links, d } = linksDuble();
  const mlOfs = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => oferta(i, 'ml'));
  const amzBoas = [10, 11, 12, 13].map((i) => oferta(i, 'amazon'));
  const amzVelhas = [14, 15, 16, 17, 18, 19, 20, 21, 22, 23].map((i) => oferta(i, 'amazon', { precoEm: VELHO }));
  const shopee = Array.from({ length: 12 }, (_, i) => oferta(30 + i, 'shopee'));
  const s = montar(t, { links, verificador: v, ofertas: [...mlOfs, ...amzBoas, ...shopee.slice(0, 5)] }); // a Shopee chega aos poucos (5, +5, +2)
  s.silencio('13:15', '13:45');
  const r1 = regraCatalogo(s.db, { nome: 'Achados ML', lojas: ['ml'] });
  const r2 = regraCatalogo(s.db, { nome: 'Achados Amazon', lojas: ['amazon'] });
  const r3 = regraCatalogo(s.db, { nome: 'Achados Shopee', lojas: ['shopee'], per: 5 });
  s.db.prepare('UPDATE rules SET next_run_at = ? WHERE id = ?').run(dia(12, 10), r3);

  const linhaDoTempo = []; // [hora, quantas mensagens Pedro tinha depois do tick]
  let n = 0;
  const passo = async (h, m, antes = null) => {
    s.ir(dia(12, h, m));
    if (antes) antes();
    await s.scheduler.tick();
    const total = s.paraJid(PEDRO).length;
    if (total !== n) { linhaDoTempo.push([`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`, total - n]); n = total; }
  };
  const ate = async (h, m, ant = {}) => {
    for (let t0 = (Math.floor(Date.now() / (10 * MIN)) + 1) * 10 * MIN; t0 <= dia(12, h, m); t0 += 10 * MIN) {
      const x = new Date(t0);
      await passo(x.getHours(), x.getMinutes(), ant[`${x.getHours()}:${x.getMinutes()}`]);
    }
  };

  // 08:00 a 08:50: ML e Amazon enviam sem problema
  await passo(8, 0);
  await ate(8, 50);
  assert.equal(s.paraGrupo(), 2, 'uma oferta do ML e uma da Amazon');
  assert.deepEqual(s.paraJid(PEDRO), []);

  // 09:00: a Central cai (em espera desde 09:00). 09:00 a 09:50: o ML espera, a Amazon envia
  d.central = { estado: 'em_espera', emEsperaDesde: dia(12, 9) };
  await ate(9, 50);
  assert.deepEqual(s.paraJid(PEDRO), [], 'menos de 30 min de falta na execução das 09:00');

  // 10:00: a execução vê 60 min de falta: UM aviso, "Mercado Livre em espera desde 09:00"
  await ate(10, 50);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM catalogo_itens WHERE status='revisao'").get().n, 5, 'a revisão enche aos poucos');
  assert.equal(s.paraJid(PEDRO).length, 1);
  assert.match(s.paraJid(PEDRO)[0], /^⚠️ \*Mercado Livre em espera desde 09:00\*\nA Central de Afiliados não está respondendo \(\d+ ofertas esperando\)\./);

  s.estado.ofertas.push(...shopee.slice(5, 10)); // a Shopee manda mais 5 às 11:00
  // 11:00: a 3ª execução do ML sem envio (loja parada) fica calada pela Central; a revisão chega a 10 (Shopee, 5 + 5)
  await ate(11, 20);
  assert.equal(s.execucoes().filter((x) => x.rule_id === r3).length, 2);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM catalogo_itens WHERE status='revisao'").get().n, 10);
  assert.equal(s.paraJid(PEDRO).length, 2);
  assert.match(s.paraJid(PEDRO)[1], /^⚠️ \*10 ofertas esperando a sua revisão\*\nElas não saem até você decidir\. A mais antiga espera há /);
  assert.ok(s.linhasVigia().some((l) => l.level === 'info' && /^Vigia: Mercado Livre parado \(3 execuções sem envio\), mas o Mercado Livre está em espera: sem aviso separado\.$/.test(l.message)),
    'loja ML calada pela Central (CA3.8)');
  assert.ok(s.linhasVigia().some((l) => l.level === 'info' && /^Vigia: a regra “Achados ML” saiu vazia, mas o Mercado Livre está em espera: sem aviso separado\.$/.test(l.message)),
    'regra só de ML calada pela Central (CA3.8)');

  // 12:00: a Amazon passa a só ter ofertas sem como conferir (filtradas); a Shopee manda mais 2 para a revisão (12)
  s.estado.ofertas.push(...shopee.slice(10), ...amzVelhas); s.estado.ofertas = s.estado.ofertas.filter((o) => !amzBoas.includes(o));
  v.semConferencia.add(VELHO);
  await ate(12, 50);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM catalogo_itens WHERE status='revisao'").get().n, 12);

  // 13:00: 2ª execução da Amazon sem envio: a regra sai vazia (um aviso, antes do silêncio das 13:15)
  await ate(13, 10);
  assert.equal(s.paraJid(PEDRO).length, 3);
  assert.match(s.paraJid(PEDRO)[2], /^⚠️ \*A regra “Achados Amazon” saiu vazia 2 vezes seguidas\*\nÀs 12:00 e às 13:00 nenhuma oferta saiu \(20 ficaram de fora: o preço não pôde ser conferido\)\./);

  // 13:15 a 13:45, silêncio: a Central volta (13:20) e a revisão cai a 5 (13:25): nada sai, uma linha "adiado" por episódio
  const quantasLinhasSegurado = () => s.linhasVigia().filter((l) => /adiado: horário de silêncio/.test(l.message)).length;
  await ate(13, 10); // (13:10 já feito)
  d.central = { estado: 'respondendo', emEsperaDesde: null };
  await passo(13, 20);
  s.db.prepare("UPDATE catalogo_itens SET status = 'descartado', decidido_em = ? WHERE id IN (SELECT id FROM catalogo_itens WHERE status = 'revisao' ORDER BY id LIMIT 7)").run(Date.now());
  await passo(13, 30);
  await passo(13, 40);
  assert.equal(s.paraJid(PEDRO).length, 3, 'nada sai no silêncio');
  assert.equal(quantasLinhasSegurado(), 1, 'uma linha por episódio de silêncio, não uma por tick');
  assert.equal(s.estadoGravado().segurado.motivo, 'silencio');

  // 13:50: o silêncio acabou (até 13:45): UMA mensagem com os dois "voltou"
  await passo(13, 50);
  assert.equal(s.paraJid(PEDRO).length, 4);
  // CA3.5: a mensagem passou pelo wa embrulhado do ritmo e contou no teto (às 13:50 nada mais saiu para grupo)
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM wa_saidas WHERE ts >= ?').get(dia(12, 13, 50)).n, 1);
  const dois = s.paraJid(PEDRO)[3];
  assert.match(dois, /^✅ \*2 problemas voltaram ao normal\*\n1\. \*Mercado Livre voltou a enviar\* \(a Central de Afiliados respondeu de novo; esteve fora por 4 h 20 min\)\.\n2\. \*Revisão voltou ao normal\* \(restam 5 ofertas esperando\)\.\nNada a fazer\.$/);
  await passo(13, 59);
  assert.equal(s.paraJid(PEDRO).length, 4, 'o "voltou" sai uma vez só');

  // 14:00: o ML envia de novo; a Amazon completa 3 execuções sem envio: "Amazon parada" (a regra dela já tinha avisado)
  await ate(14, 50);
  assert.equal(s.paraJid(PEDRO).length, 5);
  assert.match(s.paraJid(PEDRO)[4], /^⚠️ \*Amazon parada desde 12:00\*\nNas últimas 3 execuções nenhuma oferta da Amazon saiu \(30 ficaram de fora: o preço não pôde ser conferido\)\./);
  assert.ok(s.paraGrupo() >= 3, 'o ML voltou a enviar às 14:00');

  // 15:00: a conferência volta: a Amazon envia; "Amazon voltou" e "regra voltou" na MESMA mensagem
  v.semConferencia.clear();
  await ate(15, 50);
  assert.equal(s.paraJid(PEDRO).length, 6);
  assert.match(s.paraJid(PEDRO)[5], /^✅ \*2 problemas voltaram ao normal\*\n1\. \*Amazon voltou a enviar\* \(esteve parada por 3 h\)\.\n2\. \*A regra “Achados Amazon” voltou a enviar\* \(saiu uma oferta às 15:00\)\.\nNada a fazer\.$/);

  // 16:40: o serviço reinicia (agendador, vigia e links novos, mesmo banco). Nada muda para o dono
  const execAntes = s.execucoes().length; const estadoAntes = getSetting(s.db, CHAVE_ESTADO);
  const { links: links2, d: d2 } = linksDuble();
  await ate(16, 30);
  s.ir(dia(12, 16, 40));
  const s2 = s.agendador(links2);
  await s2.tick();
  assert.equal(s.paraJid(PEDRO).length, 6, 'o reinício não gera aviso novo');
  assert.deepEqual(s2.vigia.estado().causas, []);
  assert.ok(s.execucoes().length >= execAntes, 'as execuções sobreviveram');
  assert.ok(estadoAntes, 'o estado do vigia estava em settings');

  // 16:50: a extensão cai; o vigia só enxerga a falta desde o instante em que ela caiu (não desde antes do reinício)
  s.ir(dia(12, 16, 50)); d2.cair();
  for (let t0 = dia(12, 16, 50); t0 <= dia(12, 20, 50); t0 += 10 * MIN) { s.ir(t0); await s2.tick(); }
  const avisosExt = s.paraJid(PEDRO).slice(6);
  assert.equal(avisosExt.length, 1, avisosExt.join('\n---\n'));
  assert.match(avisosExt[0], /^⚠️ \*Extensão do Chrome desconectada desde 16:50\*\nO Mercado Livre não envia sem ela \(\d+ ofertas? esperando\)\./);

  // 20:55: segundo reinício, agora com a extensão fora e a causa já avisada: nada se repete e o "desde" continua o de antes
  const { links: links3, d: d3 } = linksDuble({ online: false });
  d3.ultimoPoll = dia(12, 16, 50);
  s.ir(dia(12, 20, 55));
  const s3 = s.agendador(links3);
  await s3.tick();
  assert.equal(s.paraJid(PEDRO).length, 7, 'o reinício com a causa aberta não repete o aviso');
  assert.deepEqual(s3.vigia.estado().causas.map((c) => [c.tipo, c.desdeEm]), [['extensao', dia(12, 16, 50)]]);

  // 21:00: o resumo diário vai para a Maria (com a saúde do dia); a Pedro, nunca; Joana (desligada) e "Outro", nunca
  s.ir(dia(12, 21, 5));
  const dist = s.execucoes(); const doGrupo = s.paraGrupo(); // o resumo sai antes das regras do tick: vale o que já aconteceu
  await s3.tick();
  const resumos = s.paraJid(MARIA);
  assert.equal(resumos.length, 1, 'um resumo só');
  assert.match(resumos[0], /🩺 \*Saúde dos envios\* \(todas as regras\)/);
  assert.match(resumos[0], /Em aberto agora: extensão desconectada desde 16:50\./);
  // CA3.3: os números do dia batem com a soma das execuções e com o que de fato saiu para o grupo
  const soma = (loja, campo) => dist.reduce((a, x) => a + x.por_loja[loja][campo], 0);
  const enviadas = soma('ml', 'saiu') + soma('amazon', 'saiu') + soma('shopee', 'saiu');
  assert.equal(enviadas, doGrupo, 'as execuções contam exatamente as mensagens que saíram para o grupo');
  assert.ok(soma('amazon', 'saiu') >= 5 && soma('ml', 'saiu') >= 3);
  const puladas = ['ml', 'amazon', 'shopee'].reduce((a, l) => a + soma(l, 'pulada') + soma(l, 'esperou'), 0);
  assert.match(resumos[0], new RegExp(`Amazon: ${soma('amazon', 'saiu')} enviadas · Mercado Livre: ${soma('ml', 'saiu')} enviadas`));
  assert.match(resumos[0], new RegExp(`Puladas: ${puladas} · Descartadas: 0 · Falhas: 0\\nEsperando revisão: 5\\n`));
  assert.deepEqual(s.paraJid(JOANA), [], 'número desligado não recebe');
  assert.deepEqual(s.paraJid(OUTRO), [], 'quem só quer "Grupo lotando" não recebe o vigia');
  for (const x of s.paraJid(PEDRO)) assert.doesNotMatch(x, /🩺/, 'o resumo não vai a quem só recebe erro');

  // a contagem final: 7 mensagens, todas para o Pedro, nenhuma com dado pessoal
  const doPedro = s.paraJid(PEDRO);
  assert.equal(doPedro.length, 7, doPedro.map((x) => x.split('\n')[0]).join('\n'));
  for (const x of [...doPedro, ...resumos]) assert.doesNotMatch(x.replace(/\d{1,2}\/\d{1,2}/g, ''), /@s\.whatsapp\.net|@g\.us|[\w.+-]+@[\w-]+\.[\w.]+/, 'sem JID nem e-mail');
  for (const x of doPedro) assert.doesNotMatch(x, VAZAMENTO);
  // o Histórico: só aviso e info nas linhas do vigia; nenhum aviso de erro foi disparado por elas
  const linhas = s.linhasVigia();
  assert.ok(linhas.length > 10);
  assert.ok(linhas.every((l) => l.level === 'aviso' || l.level === 'info'), 'CA3.7');
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM log WHERE rule_name = 'Vigia' AND level = 'erro'").get().n, 0);
  // as execuções ficam registradas na ordem e sem dado pessoal
  const todas = JSON.stringify(s.execucoes());
  assert.doesNotMatch(todas, /5511|Achados|@/);
  // a linha do tempo das mensagens (hora do tick, quantas saíram): uma por passada, nenhuma no silêncio
  assert.deepEqual(linhaDoTempo, [['10:00', 1], ['11:00', 1], ['13:00', 1], ['13:50', 1], ['14:00', 1], ['15:00', 1]]);
  void r1; void r2;
});


// ============================================================================================ 2. casos de borda

const VELHO = dia(11, 6);
/** Amazon com 2 ofertas que o verificador não consegue conferir: a regra sai vazia (e depois a Amazon pára). */
function amazonSemConferencia(t, { nome = 'Amazon', ...mais } = {}) {
  const v = verificadorFalso({ semConferencia: new Set([VELHO]) });
  const s = montar(t, { verificador: v, ofertas: [oferta(0, 'amazon', { precoEm: VELHO }), oferta(1, 'amazon', { precoEm: VELHO }), oferta(2, 'ml'), oferta(3, 'ml'), oferta(4, 'ml'), oferta(5, 'ml'), oferta(6, 'ml'), oferta(7, 'ml')], ...mais });
  const id = regraCatalogo(s.db, { nome, lojas: ['amazon'] });
  return { s, v, id };
}

test('CA3.8 + fonte antiga (Lista de links de ML) com a Central em espera: só "Mercado Livre em espera"; a regra vazia dela é calada', async (t) => {
  const { links, d } = linksDuble();
  const s = montar(t, { links });
  d.central = { estado: 'em_espera', emEsperaDesde: dia(12, 8) };
  regraAntiga(s.db, 'list', { ids: [0, 1, 2, 3, 4], nome: 'Minha lista' });
  for (let k = 0; k < 3; k++) { await s.scheduler.tick(); s.avancar(HORA); }
  const msgs = s.paraJid(PEDRO);
  assert.equal(msgs.length, 1, msgs.join('\n---\n'));
  assert.match(msgs[0], /^⚠️ \*Mercado Livre em espera desde 08:00\*/, 'um problema, um aviso');
  assert.ok(s.linhasVigia().some((l) => l.level === 'info' && /a regra “Minha lista” saiu vazia, mas o Mercado Livre está em espera/.test(l.message)));
});

test('fonte "Central de Afiliados" em espera: a vaga que faltou conta como ML esperando e abre "Mercado Livre em espera" (sem linha de erro)', async (t) => {
  const { links, d } = linksDuble();
  const s = montar(t, { links });
  d.central = { estado: 'em_espera', emEsperaDesde: dia(12, 8) };
  regraAntiga(s.db, 'afiliados', { nome: 'Lista da Central' });
  for (let k = 0; k < 2; k++) { await s.scheduler.tick(); s.avancar(HORA); }
  const x = s.execucoes();
  assert.deepEqual(x.map((e) => [e.conta, e.saidas, e.erros, e.por_loja.ml.esperou, e.por_loja.ml.motivos]), [[1, 0, 0, 1, { ml_espera: 1 }], [1, 0, 0, 1, { ml_espera: 1 }]]);
  assert.match(s.paraJid(PEDRO).join('\n'), /Mercado Livre em espera desde 08:00/);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM log WHERE level = 'erro'").get().n, 0, 'a espera não vira linha erro (nada dispara o aviso de erro)');
});

test('fonte antiga com a extensão desconectada: o link falha com "extensao_off" (pulada, não espera) e o aviso de extensão desconectada abre (Q1)', async (t) => {
  const { links, d } = linksDuble();
  const s = montar(t, { links });
  d.cair(); d.link = async () => { throw new ErroLinkML('A extensão do Chrome não está conectada.', { classe: 'desconectada', causa: 'extensao_off' }); };
  regraAntiga(s.db, 'list', { ids: [0, 1, 2, 3, 4], nome: 'Minha lista' });
  for (let k = 0; k < 3; k++) { await s.scheduler.tick(); s.avancar(HORA); }
  assert.deepEqual(s.execucoes().map((e) => [e.por_loja.ml.pulada, e.por_loja.ml.esperou, e.por_loja.ml.motivos]), [[4, 0, { extensao_off: 4 }], [4, 0, { extensao_off: 4 }], [4, 0, { extensao_off: 4 }]],
    'documenta o desvio declarado: vira pulada/extensao_off');
  // o aviso de erro de disparo ("4 disparos falharam") é outro, de antes: a fonte antiga grava o link não gerado como erro
  const msgs = s.paraJid(PEDRO).filter((m) => !/^⚠️ \*\d+ disparos? falh/.test(m));
  assert.equal(msgs.length, 1, msgs.join('\n---\n'));
  assert.match(msgs[0], /^⚠️ \*Extensão do Chrome desconectada desde 08:00\*\nO Mercado Livre não envia sem ela\.\n/, 'o dono é avisado de que a extensão está desconectada (um problema, um aviso)');
  assert.ok(s.linhasVigia().some((l) => l.level === 'info' && /a regra “Minha lista” saiu vazia, mas a extensão do Chrome está desconectada: sem aviso separado/.test(l.message)),
    'a regra vazia da fonte antiga é calada pela extensão (CA3.8)');
});

test('suspensão do computador: a extensão ainda não reconectou no 1º tick depois de acordar e o vigia não pode avisar "fora desde" a noite inteira', async (t) => {
  const { links, d } = linksDuble();
  const s = montar(t, { links, agora: dia(11, 21), ofertas: [oferta(0, 'ml'), oferta(1, 'ml'), oferta(2, 'ml')] });
  regraCatalogo(s.db);
  await s.scheduler.tick(); // 21:00: a extensão está on-line (último contato 21:00) e o ML envia
  assert.equal(s.paraGrupo(), 1);
  // o computador suspende às 21:00 e acorda às 08:00: o relógio anda 11 h (o monotônico, não), a extensão tem o último
  // contato velho e reconecta em segundos
  d.cair();
  s.relogio.dormiu += dia(12, 8, 0, 2) - Date.now();
  s.ir(dia(12, 8, 0, 2));
  await s.scheduler.tick(); // 1º tick depois de acordar: a regra vencida roda e o ML espera a extensão
  s.ir(dia(12, 8, 0, 20)); d.online = true; d.ultimoPoll = Date.now();
  await s.scheduler.tick();
  assert.deepEqual(s.paraJid(PEDRO), [], 'a extensão voltou 18 s depois de acordar: nenhum aviso, nem "voltou"');
});

test('D10 e "Enviar agora": o manual conta como execução; duas seguidas sem envio abrem "regra vazia"', async (t) => {
  const { s, id } = amazonSemConferencia(t);
  await manual(s, id);
  assert.deepEqual(s.paraJid(PEDRO), []);
  s.avancar(2 * MIN);
  await manual(s, id);
  assert.deepEqual(s.execucoes().map((x) => [x.conta, x.saidas]), [[1, 0], [1, 0]]);
  assert.match(s.paraJid(PEDRO)[0], /^⚠️ \*A regra “Amazon” saiu vazia 2 vezes seguidas\*\nÀs 08:00 e às 08:02 nenhuma oferta saiu/);
});

test('"sem execução, sem aviso": 8 h de extensão fora com a regra fora do horário não avisam; a 1ª execução no horário avisa na hora', async (t) => {
  const { links, d } = linksDuble();
  const s = montar(t, { links, agora: dia(12, 0), ofertas: [oferta(0, 'ml')] });
  regraCatalogo(s.db, { janela: ['09:00', '10:00'] });
  await s.scheduler.tick();
  s.avancar(30 * MIN); d.cair();
  for (let h = 1; h <= 8; h++) { s.ir(dia(12, h, 30)); await s.scheduler.tick(); }
  assert.deepEqual(s.paraJid(PEDRO), []);
  assert.deepEqual(s.scheduler.vigia.estado().causas, []);
  assert.deepEqual(s.execucoes(), []);
  s.ir(dia(12, 9, 0, 5)); await s.scheduler.tick();
  assert.equal(s.paraJid(PEDRO).length, 1);
  assert.match(s.paraJid(PEDRO)[0], /^⚠️ \*Extensão do Chrome desconectada desde 00:30\*\nO Mercado Livre não envia sem ela \(1 oferta esperando\)\./);
});

test('"com ofertas do ML esperando": a Central em espera 3 h sem nenhuma oferta nova do ML não avisa (a execução não conta)', async (t) => {
  const { links, d } = linksDuble();
  const s = montar(t, { links, ofertas: [] });
  d.central = { estado: 'em_espera', emEsperaDesde: dia(12, 8) };
  regraCatalogo(s.db);
  for (let k = 0; k < 4; k++) { await s.scheduler.tick(); s.avancar(HORA); }
  assert.deepEqual(s.execucoes().map((x) => x.conta), [0, 0, 0, 0]);
  assert.deepEqual(s.paraJid(PEDRO), []);
});

test('Foco 3, revisão: abre com 10, parada em 7 nunca lembra (48 h), fecha com 5; 9 não abre; reabrir dentro do freio espera 3 h', async (t) => {
  const { s, id } = amazonSemConferencia(t, { agora: dia(12, 10) });
  s.db.prepare('DELETE FROM rules').run();
  const rML = regraCatalogo(s.db, { nome: 'ML', lojas: ['ml'], per: 1 });
  const rev = (n) => s.db.prepare("SELECT COUNT(*) AS n FROM catalogo_itens WHERE status = 'revisao'").get().n;
  const descartar = (k) => s.db.prepare("UPDATE catalogo_itens SET status = 'descartado', decidido_em = ? WHERE id IN (SELECT id FROM catalogo_itens WHERE status = 'revisao' ORDER BY id LIMIT ?)").run(Date.now(), k);
  itemRevisao(s.db, rML, 9);
  await manual(s, rML); // execução que conta, com 9 esperando
  assert.deepEqual(s.paraJid(PEDRO), [], '9 não abre');
  itemRevisao(s.db, rML, 1);
  s.avancar(2 * MIN); await manual(s, rML);
  assert.equal(s.paraJid(PEDRO).length, 1, '10 abre');
  assert.match(s.paraJid(PEDRO)[0], /^⚠️ \*10 ofertas esperando a sua revisão\*/);
  descartar(3); assert.equal(rev(), 7);
  for (let h = 1; h <= 48; h++) { s.avancar(HORA); await passada(s); }
  s.avancar(MIN); await manual(s, rML);
  assert.equal(s.paraJid(PEDRO).length, 1, '48 h com 7 esperando: sem lembrete (D3), a causa segue aberta');
  assert.equal(s.scheduler.vigia.estado().causas.length, 1);
  descartar(2); assert.equal(rev(), 5);
  const quandoFechou = Date.now() + HORA;
  s.avancar(HORA); await passada(s);
  assert.equal(s.paraJid(PEDRO).length, 2);
  assert.equal(s.paraJid(PEDRO)[1], '✅ *Revisão voltou ao normal*\nRestam 5 ofertas esperando. Nada a fazer.', '5 ou menos fecha');
  // reabre 1 h depois do "voltou": o freio (3 h do último aviso, o "voltou" inclusive) segura
  itemRevisao(s.db, rML, 5);
  s.ir(quandoFechou + HORA); await manual(s, rML);
  assert.equal(s.paraJid(PEDRO).length, 2);
  assert.ok(s.linhasVigia().some((l) => l.message === 'Aviso do vigia sobre revisão acumulada não enviado: freio de 3 h para essa causa.'));
  s.ir(quandoFechou + 3 * HORA - MIN); await passada(s);
  assert.equal(s.paraJid(PEDRO).length, 2);
  s.ir(quandoFechou + 3 * HORA); await passada(s);
  assert.equal(s.paraJid(PEDRO).length, 3, 'passadas as 3 h, a causa ainda aberta sai');
  assert.match(s.paraJid(PEDRO)[2], /^⚠️ \*10 ofertas esperando a sua revisão\*/);
  void id;
});

test('CA3.12 ponta a ponta: regra desligada, regra apagada, loja fora das regras e modo direto fecham sem "voltou" e com uma linha info', async (t) => {
  await t.test('regra desligada e depois apagada', async (tt) => {
    const { s, id } = amazonSemConferencia(tt);
    await manual(s, id); s.avancar(MIN); await manual(s, id);
    assert.equal(s.paraJid(PEDRO).length, 1);
    s.db.prepare('UPDATE rules SET enabled = 0 WHERE id = ?').run(id);
    await passada(s);
    assert.deepEqual(s.scheduler.vigia.estado().causas, []);
    assert.equal(s.paraJid(PEDRO).length, 1, 'nenhum "voltou"');
    assert.deepEqual(s.linhasVigia().at(-1), { level: 'info', message: 'Vigia: o aviso de regra vazia foi encerrado sem aviso de volta: a regra foi desligada ou apagada.' });
    s.db.prepare('UPDATE rules SET enabled = 1 WHERE id = ?').run(id);
    s.avancar(5 * MIN); await passada(s); s.avancar(5 * MIN); await passada(s);
    assert.equal(s.paraJid(PEDRO).length, 1, 'religar não manda "voltou" nem repete o aviso: a sequência recomeça do zero');
    s.db.prepare('DELETE FROM rules WHERE id = ?').run(id);
    await passada(s);
    assert.equal(s.paraJid(PEDRO).length, 1);
  });
  await t.test('a loja sai das regras ativas (a regra passa a pedir só o ML)', async (tt) => {
    const { s, id } = amazonSemConferencia(tt);
    for (let k = 0; k < 3; k++) { await manual(s, id); s.avancar(MIN); }
    assert.ok(s.paraJid(PEDRO).some((x) => /Amazon parada desde/.test(x)));
    const antes = s.paraJid(PEDRO).length;
    s.db.prepare('UPDATE rules SET sources = ? WHERE id = ?').run(JSON.stringify([{ type: 'catalogo', tag_id: null, config: { ordem: 'relevancia', lojas: ['ml'] } }]), id);
    await passada(s);
    assert.equal(s.paraJid(PEDRO).length, antes, 'nada novo');
    assert.ok(s.linhasVigia().some((l) => l.level === 'info' && l.message === 'Vigia: o aviso de Amazon parada foi encerrado sem aviso de volta: nenhuma regra ativa pede a Amazon.'));
    assert.deepEqual(s.scheduler.vigia.estado().causas.map((c) => c.tipo), ['regra'], 'a loja saiu; a regra vazia (que continua ativa) segue em aberto');
  });
  await t.test('o modo de link vira direto com a extensão fora aberta', async (tt) => {
    const { links, d } = linksDuble();
    const s = montar(tt, { links, ofertas: [oferta(0, 'ml')] });
    regraCatalogo(s.db);
    d.cair();
    await s.scheduler.tick(); s.avancar(HORA); await s.scheduler.tick();
    assert.equal(s.paraJid(PEDRO).length, 1);
    d.modo = 'direct';
    s.avancar(MIN); await passada(s);
    assert.equal(s.paraJid(PEDRO).length, 1, 'nenhum "voltou"');
    assert.ok(s.linhasVigia().some((l) => l.level === 'info' && /os links não usam mais a extensão do Chrome/.test(l.message)));
    assert.deepEqual(s.scheduler.vigia.estado().causas, []);
  });
});

test('CA3.9 WhatsApp fora: o "voltou" espera e sai uma vez quando ele volta; o "voltou" não passa pelo freio', async (t) => {
  const { links, d } = linksDuble();
  const s = montar(t, { links, ofertas: [oferta(0, 'ml')] });
  regraCatalogo(s.db);
  d.central = { estado: 'em_espera', emEsperaDesde: dia(12, 8) };
  await s.scheduler.tick(); s.avancar(HORA); await s.scheduler.tick(); // 09:00: aviso
  assert.equal(s.paraJid(PEDRO).length, 1);
  s.wa.isReady = () => false;
  s.avancar(5 * MIN); d.central = { estado: 'respondendo', emEsperaDesde: null };
  await s.scheduler.tick(); s.avancar(10 * MIN); await s.scheduler.tick();
  assert.equal(s.paraJid(PEDRO).length, 1, 'WhatsApp fora: nada sai');
  assert.equal(s.linhasVigia().filter((l) => /adiado: WhatsApp desconectado/.test(l.message)).length, 1);
  s.wa.isReady = () => true;
  s.avancar(MIN); await s.scheduler.tick();
  assert.equal(s.paraJid(PEDRO).length, 2, 'a mensagem de volta sai assim que o WhatsApp volta, menos de 3 h depois do aviso');
  assert.match(s.paraJid(PEDRO)[1], /^✅ \*Mercado Livre voltou a enviar\*\nA Central de Afiliados respondeu de novo \(esteve fora por 1 h 5 min\)/);
  s.avancar(MIN); await s.scheduler.tick();
  assert.equal(s.paraJid(PEDRO).length, 2);
});

test('CA3.9 causa que abre com o WhatsApp caindo e fecha antes dele voltar: nenhuma mensagem e nenhum "voltou" (só linhas no Histórico)', async (t) => {
  const { links, d } = linksDuble();
  const s = montar(t, { links, ofertas: [oferta(0, 'ml'), oferta(1, 'ml')] });
  const id = regraCatalogo(s.db);
  d.central = { estado: 'em_espera', emEsperaDesde: dia(12, 7) };
  await s.scheduler.vigia.tick();
  await s.scheduler.runRule(id, { manual: true }); // 08:00: o ML espera há 60 min: a causa abre
  s.wa.isReady = () => false; // o WhatsApp cai logo depois da execução
  await s.scheduler.vigia.aposExecucao();
  assert.deepEqual(s.paraJid(PEDRO), []);
  assert.deepEqual(s.scheduler.vigia.estado().causas.map((c) => c.tipo), ['central']);
  assert.ok(s.linhasVigia().some((l) => l.message === 'Aviso do vigia adiado: WhatsApp desconectado.'));
  s.avancar(5 * MIN); d.central = { estado: 'respondendo', emEsperaDesde: null };
  await passada(s); // a Central volta com o WhatsApp ainda fora: a causa fecha sem ter sido avisada
  assert.deepEqual(s.scheduler.vigia.estado().causas, []);
  s.wa.isReady = () => true;
  s.avancar(5 * MIN); await passada(s); s.avancar(3 * HORA); await passada(s);
  assert.deepEqual(s.paraJid(PEDRO), [], 'nem o aviso nem o "voltou" saem depois');
  assert.ok(s.linhasVigia().some((l) => l.level === 'info' && /^Vigia: Mercado Livre voltou a enviar/.test(l.message)), 'o Histórico leva a volta');
});

test('CA3.5: nome de regra com telefone, e-mail, JID, asterisco, quebra de linha e 300 caracteres: mensagem e Histórico sem dado pessoal e com no máximo 40 caracteres', async (t) => {
  const nomes = [
    'Achados 11 98765-4321 da Ana', '(35) 99999-1234 zap', '+55 35 99999 1234', '35999991234', '5535999991234@s.whatsapp.net',
    'joao.silva+x@exemplo.com.br', '*NEGRITO* _ital_ ~riscado~', 'linha 1\nlinha 2\r\nlinha 3', 'x'.repeat(300), '12345678', '😀'.repeat(30),
  ];
  for (const nome of nomes) await t.test(`nome ${JSON.stringify(nome).slice(0, 30)}`, async (tt) => {
    const { s } = amazonSemConferencia(tt, { nome });
    const id = s.db.prepare('SELECT id FROM rules ORDER BY id DESC LIMIT 1').get().id;
    await manual(s, id); s.avancar(MIN); await manual(s, id);
    const msg = s.paraJid(PEDRO).join('\n');
    const linhas = s.linhasVigia().map((l) => l.message).join('\n');
    assert.match(msg, /saiu vazia 2 vezes seguidas/, `nome ${JSON.stringify(nome).slice(0, 40)}`);
    const nomeNaMsg = /“([^”]*)”/.exec(msg)?.[1];
    assert.ok(nomeNaMsg && nomeNaMsg.length <= 40, `nome na mensagem: ${nomeNaMsg}`);
    for (const texto of [msg, linhas]) {
      assert.doesNotMatch(texto.replace(/\d\d:\d\d/g, ''), /\d{8,}|\d{4,5}-\d{4}|@/, `nome ${JSON.stringify(nome).slice(0, 40)} vazou em: ${texto.slice(0, 200)}`);
    }
    assert.doesNotMatch(nomeNaMsg, /[*\n\r]/);
    assert.doesNotMatch(getSetting(s.db, CHAVE_ESTADO), /Achados|joao|NEGRITO|xxxx/, 'o estado em settings não guarda nome');
  });
});

test('CA3.7 e "marca antes da entrega": entrega que falha vira aviso (nunca erro), não é tentada de novo e não dispara o aviso de erro', async (t) => {
  const { links, d } = linksDuble();
  const s = montar(t, { links, ofertas: [oferta(0, 'ml')] });
  regraCatalogo(s.db);
  d.cair();
  const enviar = s.wa.sendText;
  let tentativas = 0;
  s.wa.sendText = async (...a) => { if (a[0] === PEDRO) { tentativas++; throw new Error(`falha para ${PEDRO}`); } return enviar(...a); };
  await s.scheduler.tick(); s.avancar(HORA); await s.scheduler.tick();
  assert.equal(tentativas, 1);
  const falhas = s.db.prepare("SELECT level, message FROM log WHERE rule_name = 'Avisos' ORDER BY id").all();
  assert.deepEqual(falhas.map((l) => l.level), ['aviso']);
  assert.match(falhas[0].message, /^Não consegui enviar o aviso do vigia para “Pedro”: /);
  assert.doesNotMatch(falhas[0].message, /5511900000001/, 'o Histórico leva o nome do destino, nunca o número');
  for (let k = 0; k < 6; k++) { s.avancar(30 * MIN); await s.scheduler.tick(); }
  assert.equal(tentativas, 1, 'sem nova tentativa');
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM log WHERE level = 'erro'").get().n, 0);
  assert.equal(s.scheduler.vigia.estado().causas.length, 1, 'a causa continua em aberto para o painel');
});

test('CA3.7 vigia sem leitura não dispara o aviso de erro nem manda mensagem nenhuma (o dono só vê a faixa)', async (t) => {
  const s = montar(t, { ofertas: [oferta(0, 'ml'), oferta(1, 'ml'), oferta(2, 'ml')] });
  regraCatalogo(s.db);
  const saida = capturarConsole(t);
  s.db.exec('DROP TABLE execucoes');
  for (let k = 0; k < 4; k++) { await s.scheduler.tick(); s.avancar(HORA); }
  assert.equal(s.paraGrupo(), 3, 'os disparos seguem');
  assert.deepEqual(s.paraJid(PEDRO), [], 'nenhum aviso (nem de erro) para o dono');
  assert.deepEqual(s.linhasVigia().map((l) => l.level), ['aviso']);
  assert.ok(saida.every((l) => /^\[(vigia|agendador)\] [^:]+: [A-Z_]+$/.test(l)), `o console leva só o código: ${saida.join(' | ')}`);
  assert.ok(saida.every((l) => !/no such table|SELECT|INSERT/i.test(l)));
});

test('sem destinatário: uma linha info, sem mensagem; quem for cadastrado depois não recebe o aviso antigo', async (t) => {
  const { links, d } = linksDuble();
  const s = montar(t, { links, ofertas: [oferta(0, 'ml')] });
  s.db.prepare('UPDATE aviso_destinos SET avisos = ? WHERE jid = ?').run('[]', PEDRO);
  regraCatalogo(s.db);
  d.cair();
  await s.scheduler.tick(); s.avancar(HORA); await s.scheduler.tick();
  assert.deepEqual(s.paraJid(PEDRO), []);
  assert.ok(s.linhasVigia().some((l) => l.level === 'info' && /não chegou a nenhum número: confira em Relatórios e avisos quem recebe “Erro de disparo”/.test(l.message)));
  s.db.prepare('UPDATE aviso_destinos SET avisos = ? WHERE jid = ?').run(JSON.stringify(['erro']), PEDRO);
  for (let k = 0; k < 3; k++) { s.avancar(HORA); await s.scheduler.tick(); }
  assert.deepEqual(s.paraJid(PEDRO), [], 'a causa já foi marcada como avisada: sem reenvio escondido');
});

test('CA3.4: /api/state traz só as causas abertas (a calada não), com desdeEm e na ordem loja, extensão, revisão, regra', async (t) => {
  const { links, d } = linksDuble();
  const s = montar(t, { links, ofertas: [oferta(0, 'ml'), ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => oferta(30 + i, 'shopee'))] });
  d.central = { estado: 'em_espera', emEsperaDesde: dia(12, 8) };
  regraCatalogo(s.db, { nome: 'ML', lojas: ['ml'] });
  regraCatalogo(s.db, { nome: 'Shopee', lojas: ['shopee'], per: 10 });
  for (let k = 0; k < 3; k++) { await s.scheduler.tick(); s.avancar(HORA); }
  const p = await subirPainel(t, s);
  const st = (await req(p.port, '/api/state')).json.vigia;
  assert.equal(st.ok, true);
  assert.deepEqual(st.causas.map((c) => [c.tipo, c.chave, c.calada]), [['central', 'ml_fora', false], ['revisao', 'revisao', false]], 'a loja ML parada e a regra vazia (caladas) não aparecem');
  for (const c of st.causas) assert.ok(Number.isFinite(c.desdeEm) && c.desdeEm <= Date.now());
  assert.equal(st.causas[0].desdeEm, dia(12, 8));
  assert.ok(!JSON.stringify(st).includes(PEDRO), 'sem número no state');
  // o state público não leva texto de erro da Central
  assert.doesNotMatch(JSON.stringify(st), /ultimoErro|Último erro/);
});

test('"voltou" não espera horário de envio: com a regra fora da janela, a extensão que volta às 12:00 avisa às 12:00 (os Docs dizem "nada avisa" fora do horário)', async (t) => {
  const { links, d } = linksDuble();
  const s = montar(t, { links, agora: dia(12, 9), ofertas: [oferta(0, 'ml')] });
  regraCatalogo(s.db, { janela: ['09:00', '10:30'] });
  d.cair();
  await s.scheduler.tick(); s.ir(dia(12, 10)); await s.scheduler.tick();
  assert.equal(s.paraJid(PEDRO).length, 1);
  d.online = true; d.ultimoPoll = dia(12, 12);
  s.ir(dia(12, 12)); await s.scheduler.tick(); // fora da janela (09:00 a 10:30): nenhuma execução
  assert.equal(s.paraJid(PEDRO).length, 2);
  assert.match(s.paraJid(PEDRO)[1], /^✅ \*Mercado Livre voltou a enviar\*/);
});

test('o estado do vigia só é gravado quando muda (a passada de 15 s não escreve em settings à toa)', async (t) => {
  const { links, d } = linksDuble();
  const s = montar(t, { links, ofertas: [oferta(0, 'ml')] });
  regraCatalogo(s.db);
  d.cair();
  await s.scheduler.tick(); s.avancar(HORA); await s.scheduler.tick(); // abre a causa e avisa
  assert.equal(s.paraJid(PEDRO).length, 1);
  const escritas = [];
  const prepare = s.db.prepare.bind(s.db);
  s.db.prepare = (sql) => { if (/settings/i.test(sql) && /^\s*(INSERT|UPDATE|REPLACE)/i.test(sql)) escritas.push(sql); return prepare(sql); };
  for (let k = 0; k < 5; k++) { s.avancar(15000); await passada(s); }
  assert.deepEqual(escritas, [], 'nada mudou: nenhuma gravação');
  d.online = true; d.ultimoPoll = Date.now(); s.avancar(15000); await passada(s);
  assert.equal(escritas.length >= 1, true, 'a causa fechou: grava');
});

test('Docs: "se o problema abriu e fechou sem aviso (freio), não há voltou" — a 2ª queda da Central dentro das 3 h do "voltou" abre e fecha em silêncio', async (t) => {
  const { links, d } = linksDuble();
  const s = montar(t, { links, ofertas: [oferta(0, 'ml'), oferta(1, 'ml')] });
  regraCatalogo(s.db);
  d.central = { estado: 'em_espera', emEsperaDesde: dia(12, 7) };
  await s.scheduler.tick(); // 08:00: aviso
  assert.equal(s.paraJid(PEDRO).length, 1);
  s.ir(dia(12, 8, 20)); d.central = { estado: 'respondendo', emEsperaDesde: null }; await s.scheduler.tick();
  assert.equal(s.paraJid(PEDRO).length, 2, 'o "voltou" sai na hora');
  s.ir(dia(12, 8, 30)); d.central = { estado: 'em_espera', emEsperaDesde: dia(12, 8, 30) }; await s.scheduler.tick();
  s.ir(dia(12, 9, 0, 5)); await s.scheduler.tick(); // a execução vê 30 min de falta: abre, mas o freio (do "voltou" das 08:20) segura
  assert.equal(s.scheduler.vigia.estado().causas.length, 1);
  assert.equal(s.paraJid(PEDRO).length, 2);
  assert.ok(s.linhasVigia().some((l) => l.message === 'Aviso do vigia sobre Mercado Livre em espera não enviado: freio de 3 h para essa causa.'));
  s.ir(dia(12, 9, 10)); d.central = { estado: 'respondendo', emEsperaDesde: null }; await s.scheduler.tick();
  assert.deepEqual(s.scheduler.vigia.estado().causas, []);
  s.ir(dia(12, 14, 0)); await s.scheduler.tick();
  assert.equal(s.paraJid(PEDRO).length, 2, 'nem aviso do problema segurado nem "voltou" de um problema que nunca foi avisado');
});
