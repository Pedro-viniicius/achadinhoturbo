import express from 'express';
import path from 'node:path';
import { DATA_DIR, PORT, DRY_RUN, FAST, ROOT, PUBLIC_HOST, PANEL_PASSWORD } from './config.js';
import { openDb, getSetting, setSetting, parseRule, nz, MAX_SOURCES } from './db.js';
import { createAuth, createLimiter, parseCookies, safeEqual, soDono, SESSION_MS } from './auth.js';
import * as privacidade from './privacidade.js';
import { pseudonimo, migrarPseudonimos, limparAntigos, chaveIp, RETENCAO_PADRAO_DIAS } from './privacidade.js';
import { createWhatsApp } from './whatsapp.js';
import { createLinkService } from './links.js';
import { createScheduler } from './scheduler.js';
import * as mlPadrao from './ml.js';
import { montarRotas as rotasEnvios } from './envios.js';
import { montarRotas as rotasAvisos, lerConfig as configAvisos, viradaMin, limitePadrao, mascararNumero } from './avisos.js';
import { montarRotas as rotasConexoes, segredosDe } from './conexoes.js';
import { createAmazon } from './amazon.js';
import { createShopee } from './shopee.js';
import { montarRotas as rotasEspelho } from './espelho.js';
import { montarRotas as rotasRemetentes } from './remetentes.js';
import { montarRotas as rotasRotinas, MAX_CONTEUDOS, MAX_HORARIOS_ROTINA } from './rotinas.js';
import { montarRotas as rotasEquipe, montarRotasPublicas as rotasEquipePublicas } from './equipe.js';
import { createCatalogo, limparFonteCatalogo } from './catalogo.js';
import { createCatalogoItens, montarRotas as rotasCatalogoItens } from './catalogo-itens.js';
import { renderTemplate, SAMPLE_OFFER, SAMPLE_OFFER_AMAZON, PLACEHOLDERS } from './template.js';
import { CATEGORIAS, ORDENS, POR_PAGINA } from './afiliados.js';
import { overview, resumo, evasaoDoDia, periodRange, startOfDay, dayOf } from './analytics.js';
import { MODOS, LIMITE_MAX, LOTACAO_PCT, slugify, parseLink, pickGroup, statusDosGrupos, verificarLotacao, encaixarGrupoNovo } from './rotador.js';
import { addLog } from './db.js';
import { validarGrade, horarioDe, horaDaLinha, proximoEnvio, qtdDaLinha, templateDaLinha, MAX_HORARIOS_GRADE, INTERVALO_MIN_GRADE, TOLERANCIA_MIN, MAX_QTD_GRADE } from './grade.js';
import crypto from 'node:crypto';

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
// Páginas e rotas que funcionam sem login (as rotas /api daqui são montadas antes do middleware de sessão).
const PUBLIC_PATHS = new Set(['/login.html', '/login.js', '/convite.html', '/convite.js', '/style.css', '/logo.svg', '/icon-192.png', '/healthz', '/favicon.ico',
  '/api/login', '/api/login/modo', '/api/convite/info', '/api/convite/aceitar']);
// Política de conteúdo: só scripts do próprio painel; estilos inline e Google Fonts liberados; nada de frames.
// Imagens: as do painel e as fotos de produto dos CDNs das lojas: Mercado Livre (IMAGEM_PERMITIDA, src/ml.js),
// Amazon (IMAGEM_AMAZON, src/amazon.js) e Shopee (IMAGEM_SHOPEE, src/shopee.js), a mesma regra de
// lojas.imagemPermitida. Host de foto novo muda a regex da loja, a do painel (public/disparos.js) e esta linha juntas.
// Nenhum connect-src de fora.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://*.mlstatic.com https://*.media-amazon.com https://*.ssl-images-amazon.com https://*.images-amazon.com https://*.susercontent.com https://cf.shopee.com.br; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

/**
 * Serviços com estado que o servidor compartilha: UM cliente da Amazon (um token, uma fila de 1 chamada/s, uma
 * "situação" da API) usado pela fila de envios do agendador, pelo espelho e pelas rotas (Conexões, Identificar do
 * Disparo manual), e UM cliente da Shopee (situação da Open API e cache de itens e de links curtos) usado pela fila
 * de envios e por Conexões. Os dois leem a credencial a cada chamada (segredosDe), nunca guardada. Aqui também o
 * ouvinte de mensagens do WhatsApp é ligado ao espelho: cada mensagem nova de grupo vai a espelho.receber()
 * (síncrono, sem rede, nunca lança), que grava os itens e acorda o agendador. Do mesmo jeito, cada mensagem privada
 * vai a remetentes.receber() (plano envio-pelo-socio): só a de um remetente cadastrado e ligado gera algo.
 * Catálogo do Etiqueta (plano fonte-catalogo-etiqueta): UM cliente (`catalogo`: fila única de pedidos ao Etiqueta,
 * situação e cursores) para o agendador e para Conexões, e UMA fila de revisão (`catalogoItens`). O cliente lê o
 * endereço e o caminho do token a cada chamada (segredosDe; o cartão não tem segredo) e o token do arquivo, nunca
 * guardado. A revisão manda o envio aprovado pela fila de envios do agendador, criado depois dela: `envios` e
 * `acordar` a alcançam na hora da chamada.
 * O main abaixo e os testes sobem por aqui. `fetch` só nos testes (padrão: o fetch global).
 */
export function criarServicos({ db, wa, links, fast = FAST, dir = DATA_DIR, ml = mlPadrao, fetch } = {}) {
  const amazon = createAmazon({ db, fetch, lerConexao: () => segredosDe(db, 'amazon') });
  const shopee = createShopee({ db, fetch, lerConexao: () => segredosDe(db, 'shopee') });
  const catalogo = createCatalogo({ db, fetch, lerConexao: () => segredosDe(db, 'catalogo') });
  let scheduler = null;
  const envios = {
    lerFoto: (id) => scheduler.envios.lerFoto(id),
    processarPendentes: () => scheduler.envios.processarPendentes(),
  };
  // o envio aprovado sai no tick do agendador (como o "agora" e o espelho); sem acordar() exposto, pede um tick
  const acordar = () => {
    if (typeof scheduler?.acordar === 'function') return scheduler.acordar();
    scheduler?.tick().catch((e) => console.error('[agendador]', e?.name || 'erro'));
  };
  const catalogoItens = createCatalogoItens({ db, wa, links, amazon, envios, acordar });
  scheduler = createScheduler({ db, wa, links, fast, dir, ml, amazon, shopee, catalogo, catalogoItens });
  wa.onMensagem((m) => scheduler.espelho.receber(m));
  // Para desligar o envio pelo sócio na hora: desligue os remetentes no painel (ou apague esta linha e reinicie)
  wa.onPrivada((m) => scheduler.remetentes.receber(m));
  return { amazon, shopee, catalogo, catalogoItens, scheduler };
}

const ASIN_SONDA = 'B000000000'; // montarLink com um ASIN de sonda diz se há tag da Amazon salva, sem rede

// amazon, shopee, catalogo e catalogoItens: os mesmos do agendador (criarServicos); sem eles, as rotas tratam a loja
// (ou o catálogo) como indisponível.
export function buildApp({ db, wa, links, scheduler, publicHost = PUBLIC_HOST, panelPassword = PANEL_PASSWORD, dataDir = DATA_DIR, ml = mlPadrao,
  amazon = scheduler?.amazon ?? null, shopee = scheduler?.shopee ?? null, catalogo = scheduler?.catalogo ?? null, catalogoItens = scheduler?.catalogoItens ?? null }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Nginx na frente: req.ip e req.secure vêm do X-Forwarded-*
  const jsonPequeno = express.json({ limit: '100kb' });
  const jsonGrande = express.json({ limit: '5mb' }); // só a lista da Central, que vem pela extensão, e só depois do token conferido
  app.use((req, res, next) => (req.path === '/api/ext/result' ? next() : jsonPequeno(req, res, next)));

  const auth = createAuth({ db, password: panelPassword });
  const exigeDono = soDono(auth); // Operador recebe 403; sem login no painel, passa
  const loginLimiter = createLimiter({ max: 5, windowMs: 15 * 60 * 1000 });       // por IP (/64 no IPv6)
  const loginGlobal = createLimiter({ max: 50, windowMs: 15 * 60 * 1000 });        // todas as origens juntas
  const extLimiter = createLimiter({ max: 20, windowMs: 15 * 60 * 1000 });
  const gLimiter = createLimiter({ max: 120, windowMs: 60 * 1000 });                // /g/<slug>: 120 por minuto por IP (CGNAT junta muita gente num IP)
  const sucessoRecente = new Map();                                                  // ip -> ts do último login certo: esse IP não sofre o limite global
  let loginsEmAndamento = 0;                                                         // no máximo 2 scrypt ao mesmo tempo
  const cliquesRecentes = new Map();                                                // (link|ip|hora) -> ts: 1 clique por hora por IP
  const enderecoPublico = publicHost ? `https://${publicHost}` : `http://127.0.0.1:${PORT}`;
  app.locals.auth = auth;

  // ---------- cabeçalhos de segurança ----------
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', CSP);
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    next();
  });

  // ---------- Host e Origin ----------
  // O painel só atende o próprio computador ou o domínio público, e só quem veio da própria página.
  // (Evita que um site qualquer aberto no seu navegador mande comandos para cá.)
  app.use('/api', (req, res, next) => {
    if (req.path.startsWith('/ext/')) return next(); // a extensão usa token
    const host = String(req.headers.host || '').toLowerCase();
    const local = LOCAL_HOST.test(host);
    if (!local && !(publicHost && host === publicHost)) return res.status(403).json({ erro: 'Host não permitido' });
    const origin = req.headers.origin;
    if (origin) {
      const ok = new Set();
      if (local) ok.add(`http://${host}`);
      if (publicHost) ok.add(`https://${publicHost}`);
      if (!ok.has(origin)) return res.status(403).json({ erro: 'Origem não permitida' });
    }
    next();
  });

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // ---------- extensão do Chrome (autenticada por token; fora do login) ----------
  const extAuth = (req, res, next) => {
    const ip = chaveIp(req.ip);
    if (extLimiter.blocked(ip)) return res.status(429).json({ erro: 'Muitas tentativas com token inválido' });
    if (!safeEqual(req.headers['x-token'], getSetting(db, 'ext_token'))) { extLimiter.fail(ip); return res.status(401).json({ erro: 'Token inválido' }); }
    extLimiter.reset(ip);
    next();
  };
  // Long-poll: manda os cabeçalhos na hora (a extensão já sabe que está conectada)
  // e só depois o corpo, quando chegar um pedido ou der 20 s.
  app.get('/api/ext/poll', extAuth, async (req, res) => {
    res.status(200).type('application/json').flushHeaders();
    res.end(JSON.stringify({ job: await links.poll(20000) }));
  });
  // `longo` (só no pedido link_shopee): o longLink, que serve só para conferir o ID de afiliado; links.submit o valida
  app.post('/api/ext/result', extAuth, jsonGrande, (req, res) => {
    const ok = links.submit(Number(req.body.id), { ok: !!req.body.ok, link: req.body.link, longo: req.body.longo, data: req.body.data, error: req.body.error });
    res.json({ ok });
  });

  // ---------- rotacionador: link público /g/<slug> (sem login; é o que as pessoas clicam) ----------
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const groupsByJid = () => Object.fromEntries(all('SELECT jid, name, size, invite_code FROM groups').map((g) => [g.jid, g]));
  app.get('/g/:slug', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const ip = chaveIp(req.ip);
    if (gLimiter.blocked(ip)) return res.status(429).type('text/plain').send('Muitas tentativas. Aguarde um minuto.');
    gLimiter.fail(ip);
    const link = parseLink(one('SELECT * FROM links WHERE slug = ?', String(req.params.slug).toLowerCase()));
    if (!link || !link.enabled) return res.status(404).type('text/plain').send('Link não encontrado.');
    const { group, state } = pickGroup(link, groupsByJid());
    db.prepare('UPDATE links SET state = ? WHERE id = ?').run(JSON.stringify(state), link.id);
    if (!group) {
      if (link.fallback_url) return res.redirect(302, link.fallback_url);
      return res.status(503).type('text/html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Grupos lotados</title><p style="font:16px system-ui;padding:32px;text-align:center">Todos os grupos estão lotados no momento. Tente de novo mais tarde.</p>');
    }
    // conta no máximo um clique por link, por IP, por hora; o IP fica só em memória, não no banco
    const agora = Date.now(); const chave = `${link.id}|${ip}|${Math.floor(agora / 3600000)}`;
    if (!cliquesRecentes.has(chave)) {
      cliquesRecentes.set(chave, agora);
      if (cliquesRecentes.size > 20000) for (const [k, t] of cliquesRecentes) if (agora - t > 3600000) cliquesRecentes.delete(k);
      db.prepare('INSERT INTO link_clicks (ts, link_id, jid, ip_hash) VALUES (?,?,?,NULL)').run(agora, link.id, group.jid);
    }
    res.redirect(302, `https://chat.whatsapp.com/${group.invite_code}`);
  });

  // ---------- login ----------
  const cookieOpts = (req) => ({ httpOnly: true, sameSite: 'strict', secure: req.secure || !!publicHost, path: '/' });
  const cookieName = (req) => (req.secure ? '__Host-sid' : 'sid'); // __Host-: só com HTTPS, sem Domain, Path=/
  const sidDe = (req) => { const c = parseCookies(req.headers.cookie); return c['__Host-sid'] || c.sid; };
  const gravarCookie = (req, res, sid) => res.cookie(cookieName(req), sid, { ...cookieOpts(req), maxAge: SESSION_MS });
  // legado: existe a conta sem e-mail (o Dono migrado da senha única); o e-mail fica opcional e, em branco, entra essa conta
  app.get('/api/login/modo', (req, res) => res.json({ modo: auth.enabled() ? auth.modo() : 'email' }));
  app.post('/api/login', async (req, res) => {
    if (!auth.enabled()) return res.json({ ok: true });
    const ip = chaveIp(req.ip);
    // quem já entrou deste IP nas últimas 24 h não sofre o limite global (senão 50 erros de terceiros trancariam o dono)
    const confiavel = Date.now() - (sucessoRecente.get(ip) || 0) < 24 * 3600000;
    if (loginLimiter.blocked(ip) || (!confiavel && loginGlobal.blocked('todos'))) {
      const s = Math.max(loginLimiter.retryAfterS(ip), confiavel ? 0 : loginGlobal.retryAfterS('todos'));
      return res.status(429).json({ erro: `Muitas tentativas. Tente de novo em ${Math.ceil(s / 60)} min.` });
    }
    if (loginsEmAndamento >= 2) return res.status(429).json({ erro: 'Aguarde um instante e tente de novo.' });
    // a tentativa é contada ANTES de calcular o hash: uma rajada simultânea não passa pelo freio
    loginLimiter.fail(ip); loginGlobal.fail('todos'); loginsEmAndamento++;
    let sid;
    try { sid = await auth.login(String(req.body?.email ?? '').slice(0, 200), String(req.body?.senha ?? '').slice(0, 200), ip); } finally { loginsEmAndamento--; }
    if (!sid) return res.status(401).json({ erro: 'E-mail ou senha incorretos.' }); // a mesma para e-mail desconhecido e senha errada
    loginLimiter.reset(ip); sucessoRecente.set(ip, Date.now());
    if (sucessoRecente.size > 1000) for (const [k, t] of sucessoRecente) if (Date.now() - t > 24 * 3600000) sucessoRecente.delete(k);
    gravarCookie(req, res, sid);
    res.json({ ok: true });
  });
  app.post('/api/logout', (req, res) => {
    auth.logout(sidDe(req));
    res.clearCookie(cookieName(req), cookieOpts(req));
    res.json({ ok: true });
  });

  // ---------- convite: info e aceite (públicos, com freio próprio) ----------
  rotasEquipePublicas(app, { db, auth, gravarCookie });

  // ---------- exige sessão em tudo o que vem abaixo (painel e API); req.user = a pessoa da sessão ----------
  app.use((req, res, next) => {
    req.user = null; // sem login no painel: ninguém (e soDono deixa passar)
    if (!auth.enabled() || PUBLIC_PATHS.has(req.path) || req.path.startsWith('/g/')) return next();
    const sessao = auth.sessionFrom(sidDe(req));
    if (sessao) { req.user = sessao.user; return next(); }
    if (req.path.startsWith('/api/')) return res.status(401).json({ erro: 'Faça login para continuar' });
    res.redirect(302, '/login.html');
  });
  app.use(express.static(path.join(ROOT, 'public')));

  // erro com `campo` (frase fixa da validação da fonte catálogo) leva o campo e a fonte junto, para o painel marcar
  const wrap = (fn) => async (req, res) => {
    try { res.json(await fn(req, res) ?? { ok: true }); } catch (e) {
      res.status(400).json(typeof e?.campo === 'string' ? { erro: e.message, campo: e.campo, fonte: e.fonte ?? null } : { erro: e.message });
    }
  };
  /**
   * Catálogo do Etiqueta no /api/state (sem rede): estado do cartão e situação do cliente (falha_desde alimenta o
   * chip "Catálogo indisponível"), pendentes de revisão (total e por regra) e se há tag da Amazon salva (aviso A5).
   * Uma falha aqui nunca derruba o /api/state.
   */
  const estadoCatalogo = () => {
    let sit = null; let cont = null; let tag = false;
    try { sit = catalogo?.situacao() ?? null; } catch (e) { console.error('[catalogo] situação:', e?.code || e?.name || 'erro'); }
    try { cont = catalogoItens?.contar() ?? null; } catch (e) { console.error('[catalogo] contagem:', e?.code || e?.name || 'erro'); }
    try { tag = !!amazon?.montarLink?.(ASIN_SONDA); } catch { tag = false; }
    return {
      estado: sit?.estado ?? null,
      situacao: sit ? { estado: sit.estado ?? null, resultado: sit.resultado ?? null, verificado_em: sit.verificado_em ?? null, falha_desde: sit.falha_desde ?? null } : null,
      falha_desde: sit?.falha_desde ?? null,
      para_revisar: Number(cont?.para_revisar) || 0,
      teto_revisao: cont?.teto_revisao ?? null,
      regras: Array.isArray(cont?.regras) ? cont.regras.map((r) => ({ rule_id: r.rule_id, para_revisar: r.para_revisar, cheia: !!r.cheia })) : [],
      tag_amazon: tag,
    };
  };
  // ---------- estado geral ----------
  app.get('/api/state', wrap((req) => ({
    whatsapp: wa.state(), extensao: links.status(), simulacao: DRY_RUN,
    ajustes: {
      delay_group_s: Number(getSetting(db, 'delay_group_s', 6)),
      delay_offer_s: Number(getSetting(db, 'delay_offer_s', 30)),
      link_mode: getSetting(db, 'link_mode', 'extension'),
      titulo_max: Number(getSetting(db, 'titulo_max', 60)),
      retencao_dias: Number(getSetting(db, 'retencao_dias', RETENCAO_PADRAO_DIAS)),
      limite_padrao: limitePadrao(db), virada_dia: configAvisos(db).virada_dia, // de Relatórios e avisos
    },
    ext_token: getSetting(db, 'ext_token'), porta: PORT,
    endereco_publico: enderecoPublico, auth: auth.enabled(),
    usuario: req.user ? { ...req.user, precisa_completar: !req.user.email } : null, // null: painel sem login
    conta_nome: getSetting(db, 'conta_nome', ''),
    placeholders: PLACEHOLDERS,
    afiliados: { categorias: CATEGORIAS, ordens: ORDENS, por_pagina: POR_PAGINA }, max_fontes: MAX_SOURCES,
    modos_link: MODOS, limite_max: LIMITE_MAX, lotacao_pct: LOTACAO_PCT,
    propostas_pendentes: one("SELECT COUNT(*) AS n FROM group_proposals WHERE status = 'pending'").n,
    espelhos_na_fila: one("SELECT COUNT(*) AS n FROM espelho_itens WHERE status = 'na_fila'").n, // ofertas espelhadas esperando o dono completar
    amostras: { amazon: SAMPLE_OFFER_AMAZON }, // oferta de exemplo para a prévia do template (sem tag no link)
    catalogo: estadoCatalogo(),
    // limites da grade de horários do Disparo automático (src/grade.js) e das rotinas do Grupo vivo (src/rotinas.js),
    // para os editores e o contador do painel
    grade: { max_horarios: MAX_HORARIOS_GRADE, intervalo_min: INTERVALO_MIN_GRADE, tolerancia_min: TOLERANCIA_MIN, max_qtd: MAX_QTD_GRADE,
      max_conteudos: MAX_CONTEUDOS, max_horarios_rotina: MAX_HORARIOS_ROTINA },
  })));

  app.put('/api/ajustes', wrap((req) => {
    const { delay_group_s, delay_offer_s, link_mode, titulo_max, retencao_dias } = req.body;
    if (retencao_dias != null) { const n = Number(retencao_dias); if (!(n >= 0 && n <= 3650)) throw new Error('Retenção: de 0 (para sempre) a 3650 dias.'); setSetting(db, 'retencao_dias', Math.round(n)); }
    if (titulo_max != null) { const n = Number(titulo_max); if (!(n >= 0 && n <= 200)) throw new Error('Tamanho do título: de 0 (inteiro) a 200.'); setSetting(db, 'titulo_max', Math.round(n)); }
    if (delay_group_s != null) setSetting(db, 'delay_group_s', Math.max(2, Number(delay_group_s) || 6));
    if (delay_offer_s != null) setSetting(db, 'delay_offer_s', Math.max(5, Number(delay_offer_s) || 30));
    if (link_mode != null) {
      if (!['extension', 'direct'].includes(link_mode)) throw new Error('Modo de link inválido');
      setSetting(db, 'link_mode', link_mode);
    }
  }));

  // ---------- WhatsApp ----------
  app.post('/api/wa/connect', wrap(async () => { await wa.connect(); }));
  app.post('/api/wa/logout', exigeDono, wrap(async (req) => { await wa.logout({ apagarEventos: !!req.body?.apagar_eventos }); }));
  // ---------- privacidade: rotação do token da extensão, limpeza e exclusão por titular ----------
  app.post('/api/ajustes/token', exigeDono, wrap(() => { setSetting(db, 'ext_token', crypto.randomBytes(24).toString('hex')); })); // fora de /api/ext/: passa pelo Host/Origin e pelo login
  // "Apagar o que já passou do prazo": a mesma retenção do início do serviço, inclusive os itens do espelhamento
  // (que guardam o texto mascarado das mensagens dos grupos de origem) e os dos remetentes (campos lidos do texto)
  app.post('/api/privacidade/limpar', exigeDono, wrap(() => {
    const dias = Number(getSetting(db, 'retencao_dias', RETENCAO_PADRAO_DIAS));
    const r = limparAntigos(db, dias);
    if (scheduler?.espelho) r.espelhamento = scheduler.espelho.limpar(dias).itens;
    if (scheduler?.remetentes) r.remetentes = scheduler.remetentes.limpar(dias).itens;
    return r;
  }));
  app.post('/api/privacidade/apagar-participante', wrap((req) => {
    const id = String(req.body?.id || '').trim().slice(0, 80); if (!id) throw new Error('Informe o número (com DDI) ou o pseudônimo.');
    return privacidade.apagarParticipante(db, id);
  }));
  app.post('/api/wa/sync-groups', wrap(async () => { await wa.syncGroups(); }));
  app.get('/api/groups', wrap(() => all(`SELECT g.*, (SELECT json_group_array(block_id) FROM block_groups b WHERE b.jid = g.jid) AS blocks
    FROM groups g ORDER BY name COLLATE NOCASE`).map((g) => ({ ...g, is_admin: g.is_admin == null ? null : !!g.is_admin, blocks: JSON.parse(g.blocks || '[]') }))));
  app.post('/api/groups/:jid/invite', wrap(async (req) => ({ invite_code: await wa.fetchInvite(req.params.jid) })));
  app.put('/api/groups/:jid/invite', wrap((req) => {
    const m = String(req.body.url || '').trim().slice(0, 300).match(/(?:chat\.whatsapp\.com\/(?:invite\/)?)?([A-Za-z0-9_-]{10,})$/);
    if (!m) throw new Error('Cole o link completo, como https://chat.whatsapp.com/XXXXXXXX');
    if (!one('SELECT 1 FROM groups WHERE jid = ?', req.params.jid)) throw new Error('Grupo não encontrado.');
    db.prepare('UPDATE groups SET invite_code = ? WHERE jid = ?').run(m[1], req.params.jid);
    return { invite_code: m[1] };
  }));

  // ---------- blocos de análise ----------
  const blockFromBody = (b) => {
    const name = String(b.name || '').trim(); if (!name) throw new Error('Dê um nome ao bloco.');
    return { name, tag_id: nz(b.tag_id), note: String(b.note || ''), jids: Array.isArray(b.group_jids) ? [...new Set(b.group_jids)] : [] };
  };
  const saveBlockGroups = (id, jids) => {
    db.prepare('DELETE FROM block_groups WHERE block_id = ?').run(id);
    const ins = db.prepare('INSERT OR IGNORE INTO block_groups (block_id, jid) VALUES (?,?)');
    for (const j of jids) ins.run(id, j);
  };
  app.get('/api/blocks', wrap(() => {
    const hoje = periodRange('hoje', Date.now(), {}, viradaMin(db));
    return all('SELECT * FROM blocks ORDER BY name COLLATE NOCASE').map((b) => {
      const jids = all('SELECT jid FROM block_groups WHERE block_id = ?', b.id).map((r) => r.jid);
      const grupos = jids.length ? all(`SELECT jid, name, size FROM groups WHERE jid IN (${jids.map(() => '?').join(',')})`, ...jids) : [];
      return { ...b, group_jids: jids, grupos, membros: grupos.reduce((s, g) => s + (g.size || 0), 0), hoje: resumo(db, { ...hoje, jids }) };
    });
  }));
  app.post('/api/blocks', wrap((req) => {
    const b = blockFromBody(req.body);
    const id = db.prepare('INSERT INTO blocks (name, tag_id, note, created_at) VALUES (?,?,?,?)').run(b.name, b.tag_id, b.note, Date.now()).lastInsertRowid;
    saveBlockGroups(id, b.jids); return { id };
  }));
  app.put('/api/blocks/:id', wrap((req) => {
    const b = blockFromBody(req.body);
    db.prepare('UPDATE blocks SET name = ?, tag_id = ?, note = ? WHERE id = ?').run(b.name, b.tag_id, b.note, req.params.id);
    saveBlockGroups(Number(req.params.id), b.jids);
  }));
  app.delete('/api/blocks/:id', wrap((req) => {
    db.prepare('DELETE FROM blocks WHERE id = ?').run(req.params.id);
    db.prepare('DELETE FROM block_groups WHERE block_id = ?').run(req.params.id);
  }));

  // ---------- visão geral ----------
  app.get('/api/overview', wrap((req) => {
    const q = req.query; const now = Date.now(); const v = viradaMin(db); // dias de negócio: começam na virada do dia
    const range = periodRange(String(q.periodo || 'hoje'), now, { de: q.de, ate: q.ate }, v);
    const jids = q.bloco ? all('SELECT jid FROM block_groups WHERE block_id = ?', q.bloco).map((r) => r.jid) : null;
    const o = overview(db, { ...range, jids, now, viradaMin: v });
    o.anterior = { ...o.anterior, ...resumo(db, { ...o.anterior, jids }) };
    o.evasao.ontem = evasaoDoDia(db, startOfDay(now, v) - 1, jids, v); // 1 ms antes do início de hoje = ontem
    return o;
  }));

  // ---------- rotacionador: cadastro ----------
  const linkFromBody = (b, id = null) => {
    const name = String(b.name || '').trim(); if (!name) throw new Error('Dê um nome ao link.');
    const slug = slugify(b.slug || name); if (!slug) throw new Error('Endereço inválido: use letras e números.');
    if (one('SELECT id FROM links WHERE slug = ? AND id IS NOT ?', slug, id)) throw new Error('Já existe um link com esse endereço.');
    const mode = MODOS.some((m) => m.id === b.mode) ? b.mode : 'fill';
    const limit = Math.min(Math.max(Number(b.limit_members) || limitePadrao(db), 2), LIMITE_MAX);
    const reopen = Math.min(Math.max(Number(b.reopen_below) || Math.floor(limit * 0.9), 1), limit - 1);
    const fallback = String(b.fallback_url || '').trim();
    if (fallback && !/^https?:\/\//i.test(fallback)) throw new Error('A URL reserva precisa começar com http:// ou https://');
    const jids = Array.isArray(b.group_jids) ? [...new Set(b.group_jids)] : [];
    if (!jids.length) throw new Error('Escolha ao menos um grupo.');
    return [name, slug, mode, fallback || null, limit, reopen, JSON.stringify(jids), b.auto_next ? 1 : 0];
  };
  const linkView = (row) => {
    const l = parseLink(row); const hoje = periodRange('hoje', Date.now(), {}, viradaMin(db));
    return {
      ...l, auto_next: !!l.auto_next, url: `${enderecoPublico}/g/${l.slug}`, grupos: statusDosGrupos(l, groupsByJid()),
      cliques_total: one('SELECT COUNT(*) AS n FROM link_clicks WHERE link_id = ?', l.id).n,
      cliques_hoje: one('SELECT COUNT(*) AS n FROM link_clicks WHERE link_id = ? AND ts BETWEEN ? AND ?', l.id, hoje.de, hoje.ate).n,
    };
  };
  app.get('/api/links', wrap(() => all('SELECT * FROM links ORDER BY id').map(linkView)));
  app.post('/api/links', wrap((req) => {
    const v = linkFromBody(req.body);
    return { id: db.prepare('INSERT INTO links (name, slug, mode, fallback_url, limit_members, reopen_below, group_jids, auto_next, created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(...v, Date.now()).lastInsertRowid };
  }));
  app.put('/api/links/:id', wrap((req) => {
    const v = linkFromBody(req.body, Number(req.params.id));
    db.prepare("UPDATE links SET name = ?, slug = ?, mode = ?, fallback_url = ?, limit_members = ?, reopen_below = ?, group_jids = ?, auto_next = ?, state = '{}' WHERE id = ?").run(...v, req.params.id);
  }));
  app.post('/api/links/:id/enabled', wrap((req) => { db.prepare('UPDATE links SET enabled = ? WHERE id = ?').run(req.body.enabled ? 1 : 0, req.params.id); }));
  app.delete('/api/links/:id', wrap((req) => {
    db.prepare('DELETE FROM links WHERE id = ?').run(req.params.id);
    db.prepare('DELETE FROM link_clicks WHERE link_id = ?').run(req.params.id);
    db.prepare("DELETE FROM group_proposals WHERE link_id = ? AND status = 'pending'").run(req.params.id);
  }));

  // ---------- próximo grupo (proposta -> você confirma -> cria) ----------
  app.get('/api/proposals', wrap(() => {
    verificarLotacao(db);
    return all(`SELECT p.*, g.name AS source_name, g.size AS source_size, l.name AS link_name, l.limit_members
      FROM group_proposals p LEFT JOIN groups g ON g.jid = p.source_jid LEFT JOIN links l ON l.id = p.link_id
      WHERE p.status = 'pending' OR p.decided_at > ? ORDER BY p.status = 'pending' DESC, p.created_at DESC LIMIT 30`, Date.now() - 7 * 86400000)
      .map((p) => ({ ...p, detail: p.detail ? JSON.parse(p.detail) : null }));
  }));
  app.post('/api/proposals/:id/dismiss', wrap((req) => {
    db.prepare("UPDATE group_proposals SET status = 'dismissed', decided_at = ? WHERE id = ? AND status = 'pending'").run(Date.now(), req.params.id);
  }));
  app.post('/api/proposals/:id/create', wrap(async (req) => {
    const p = one("SELECT * FROM group_proposals WHERE id = ? AND status = 'pending'", req.params.id);
    if (!p) throw new Error('Proposta não encontrada ou já decidida.');
    const nome = String(req.body?.name || p.name).trim(); if (!nome) throw new Error('Dê um nome ao grupo.');
    let r;
    try { r = await wa.createNextGroup(p.source_jid, nome); } catch (e) {
      db.prepare("UPDATE group_proposals SET status = 'failed', detail = ?, decided_at = ? WHERE id = ?").run(JSON.stringify({ erro: e.message }), Date.now(), p.id);
      addLog(db, { level: 'erro', group_name: nome, message: 'Não consegui criar o próximo grupo: ' + e.message });
      throw e;
    }
    encaixarGrupoNovo(db, { linkId: p.link_id, sourceJid: p.source_jid, newJid: r.jid });
    const detalhe = { jid: r.jid, invite_code: r.invite_code, admins_adicionados: r.admins_adicionados.length, admins_nao_adicionados: r.admins_nao_adicionados.length, avisos: r.avisos || [] }; // sem telefones
    db.prepare("UPDATE group_proposals SET status = 'created', created_jid = ?, name = ?, detail = ?, decided_at = ? WHERE id = ?").run(r.jid, nome, JSON.stringify(detalhe), Date.now(), p.id);
    addLog(db, { level: 'ok', group_name: nome, message: `Grupo criado a partir de "${one('SELECT name FROM groups WHERE jid = ?', p.source_jid)?.name || p.source_jid}" e encaixado no link, nos blocos e nas regras.` });
    return r;
  }));

  // ---------- etiquetas ----------
  app.get('/api/tags', wrap(() => all('SELECT * FROM tags ORDER BY name COLLATE NOCASE')));
  app.post('/api/tags', wrap((req) => {
    const name = String(req.body.name || '').trim();
    if (!/^[\w.-]{2,60}$/.test(name)) throw new Error('A etiqueta deve ter 2 a 60 caracteres: letras, números, ponto, hífen ou _ (sem espaços).');
    if (one('SELECT 1 FROM tags WHERE name = ?', name)) throw new Error('Essa etiqueta já está cadastrada.');
    db.prepare('INSERT INTO tags (name, note, created_at) VALUES (?,?,?)').run(name, String(req.body.note || ''), Date.now());
  }));
  app.delete('/api/tags/:id', wrap((req) => {
    const used = one('SELECT name FROM rules WHERE tag_id = ? LIMIT 1', req.params.id);
    if (used) throw new Error(`A regra "${used.name}" usa esta etiqueta. Troque a etiqueta dela antes.`);
    const naFonte = all('SELECT name, sources FROM rules').find((r) => { try { return (JSON.parse(r.sources || '[]') || []).some((s) => String(s.tag_id) === String(req.params.id)); } catch { return false; } });
    if (naFonte) throw new Error(`Uma fonte da regra "${naFonte.name}" usa esta etiqueta. Troque lá antes.`);
    const bloco = one('SELECT name FROM blocks WHERE tag_id = ? LIMIT 1', req.params.id);
    if (bloco) throw new Error(`O bloco "${bloco.name}" usa esta etiqueta. Troque a etiqueta dele antes.`);
    db.prepare('DELETE FROM tags WHERE id = ?').run(req.params.id);
  }));

  // ---------- templates ----------
  const checkTemplate = (b) => {
    if (!String(b.name || '').trim()) throw new Error('Dê um nome ao template.');
    if (!String(b.body || '').includes('{LINK}')) throw new Error('O template precisa ter {LINK}, senão a mensagem sai sem o link de afiliado.');
  };
  app.get('/api/templates', wrap(() => all('SELECT * FROM templates ORDER BY id')));
  app.post('/api/templates', wrap((req) => {
    checkTemplate(req.body);
    return { id: db.prepare('INSERT INTO templates (name, body, created_at) VALUES (?,?,?)').run(req.body.name.trim(), req.body.body, Date.now()).lastInsertRowid };
  }));
  app.put('/api/templates/:id', wrap((req) => {
    checkTemplate(req.body);
    db.prepare('UPDATE templates SET name = ?, body = ? WHERE id = ?').run(req.body.name.trim(), req.body.body, req.params.id);
  }));
  /** Primeiro horário de grade (em ordem de regra e de hora) que usa o template; grade ilegível no banco é ignorada. */
  const usoNaGrade = (templateId) => {
    for (const r of all('SELECT name, grade FROM rules WHERE grade IS NOT NULL ORDER BY id')) {
      let g = null;
      try { g = JSON.parse(r.grade); } catch { continue; }
      const linha = Array.isArray(g?.horarios) ? g.horarios.find((l) => l && Number(l.template_id) === templateId) : null;
      if (linha) return { regra: r.name, hora: String(linha.hora ?? '') };
    }
    return null;
  };
  app.delete('/api/templates/:id', wrap((req) => {
    const used = one('SELECT name FROM rules WHERE template_id = ? LIMIT 1', req.params.id);
    if (used) throw new Error(`A regra "${used.name}" usa este template.`);
    const naGrade = usoNaGrade(Number(req.params.id));
    if (naGrade) throw new Error(`A regra "${naGrade.regra}" usa este template no horário ${naGrade.hora}.`);
    if (one('SELECT COUNT(*) AS n FROM templates').n <= 1) throw new Error('Mantenha ao menos um template.');
    db.prepare('DELETE FROM templates WHERE id = ?').run(req.params.id);
  }));
  app.post('/api/templates/preview', wrap((req) => ({ texto: renderTemplate(String(req.body.body || ''), { ...SAMPLE_OFFER, ...(req.body.amostra || {}) }, { tituloMax: Number(getSetting(db, 'titulo_max', 60)) }) })));

  // ---------- regras ----------
  const ruleFromBody = (b) => {
    const n = (v, d) => (v === '' || v == null ? d : Number(v));
    const hhmm = (v, d) => (/^\d{1,2}:\d{2}$/.test(v || '') ? v : d);
    if (!String(b.name || '').trim()) throw new Error('Dê um nome à regra.');
    const interval = n(b.interval_min, 60); const perRun = n(b.per_run, 3);
    if (!(interval >= 1)) throw new Error('O intervalo mínimo é 1 minuto.');
    if (!(perRun >= 1 && perRun <= 20)) throw new Error('Ofertas por envio: de 1 a 20.');
    // fontes: lista nova (até 5) ou, nas regras antigas, source_type + source_config
    const tipo = (t) => (['afiliados', 'search', 'catalogo'].includes(t) ? t : 'list');
    const str = (v, max) => String(v ?? '').slice(0, max);
    const limpaConfig = (t, c) => {
      c = c && typeof c === 'object' ? c : {};
      if (t === 'afiliados') {
        const ids = new Set(CATEGORIAS.map((x) => x.id));
        return { busca: str(c.busca, 80).trim(), categorias: (Array.isArray(c.categorias) ? c.categorias : (c.categoria ? [c.categoria] : [])).map(String).filter((x) => ids.has(x)).slice(0, 23),
          ordem: ORDENS.some((o) => o.id === c.ordem) ? c.ordem : 'relevance', paginas: Math.min(Math.max(parseInt(c.paginas, 10) || 3, 1), 10), mais_vendidos: !!c.mais_vendidos, ganhos_extras: !!c.ganhos_extras };
      }
      if (t === 'search') return { query: str(c.query, 80).trim(), sort: ['relevance', 'price_asc', 'price_desc'].includes(c.sort) ? c.sort : 'relevance' };
      if (t === 'catalogo') return limparFonteCatalogo(c); // limites do contrato do Etiqueta; inválido: frase fixa (ERROS_FONTE) com `campo`
      return { items: str(c.items, 20000) };
    };
    const daFonte = (i, fn) => { try { return fn(); } catch (e) { if (typeof e?.campo === 'string') e.fonte = i + 1; throw e; } };
    let sources = Array.isArray(b.sources) && b.sources.length
      ? b.sources.map((s, i) => { const t = tipo(s?.type); return { type: t, config: daFonte(i, () => limpaConfig(t, s?.config)), tag_id: nz(s?.tag_id) == null ? null : Number(s.tag_id) }; })
      : [{ type: tipo(b.source_type), config: daFonte(0, () => limpaConfig(tipo(b.source_type), b.source_config)) }];
    if (sources.length > MAX_SOURCES) throw new Error(`Uma regra aceita no máximo ${MAX_SOURCES} fontes.`);
    for (const [i, s] of sources.entries()) {
      if (s.type === 'search' && !String(s.config.query || '').trim()) throw new Error(`Fonte ${i + 1}: a busca está sem a palavra-chave.`);
      if (s.type === 'list' && !String(s.config.items || '').split('\n').some((l) => /^https?:/i.test(l.trim()))) throw new Error(`Fonte ${i + 1}: a lista de links está vazia.`);
    }
    // grade de horários (opcional): sem o campo ou null = "A cada X minutos", como antes. Intervalo e janela
    // continuam gravados e validados acima, para quem voltar ao intervalo (D1). Inválida: frase de tela (400).
    const grade = validarGrade(b.grade, { templateExiste: (id) => !!one('SELECT 1 AS ok FROM templates WHERE id = ?', id) });
    return [
      b.name.trim(), b.enabled === false ? 0 : 1, nz(b.tag_id), nz(b.template_id),
      JSON.stringify(Array.isArray(b.group_jids) ? b.group_jids : []),
      sources[0].type, JSON.stringify(sources[0].config), JSON.stringify(sources),
      nz(n(b.min_price, null)), nz(n(b.max_price, null)), nz(n(b.min_discount, null)),
      perRun, interval, hhmm(b.window_start, '08:00'), hhmm(b.window_end, '22:00'),
      n(b.dedupe_days, 7), b.send_image === false ? 0 : 1,
      grade ? JSON.stringify(grade) : null,
    ];
  };
  const COLS = 'name, enabled, tag_id, template_id, group_jids, source_type, source_config, sources, min_price, max_price, min_discount, per_run, interval_min, window_start, window_end, dedupe_days, send_image, grade';
  /**
   * Próximo envio de uma regra com grade, para o cartão: { ts, hora, qtd, template_id } (template_id null = o da
   * regra), ou null sem grade. O horário, a quantidade e o template saem das mesmas funções que o agendador usa
   * (src/grade.js: proximoEnvio, qtdDaLinha, templateDaLinha), para o cartão anunciar o que de fato sai, inclusive
   * com a grade editada à mão no banco. Template da linha que não existe mais: sai o da regra (null). Grade quebrada
   * no banco dá null, sem derrubar a lista.
   */
  const proximoDaGrade = (regra, now = Date.now()) => {
    if (!regra?.grade) return null;
    try {
      const ts = proximoEnvio(regra.grade, regra.next_run_at, now);
      const linha = ts == null ? null : horarioDe(regra.grade, ts);
      if (!linha) return null;
      const tpl = templateDaLinha(linha);
      const existe = tpl != null && !!one('SELECT 1 AS ok FROM templates WHERE id = ?', tpl);
      return { ts, hora: horaDaLinha(linha.hora), qtd: qtdDaLinha(linha, regra.per_run), template_id: existe ? tpl : null };
    } catch { return null; }
  };
  /**
   * Fonte "Novidades" do catálogo que ainda não terminou a primeira leitura (contrato com o painel, S3): a
   * pré-visualização dela vem vazia até a regra rodar. Só nas fontes catálogo com ordem Novidades; sem rede. Não é
   * gravado (ruleFromBody refaz cada fonte só com type, config e tag_id).
   */
  const comPrimeiraLeitura = (regra) => {
    if (!catalogo || !Array.isArray(regra?.sources)) return regra;
    const sources = regra.sources.map((f) => {
      if (f?.type !== 'catalogo' || (f.config?.ordem ?? 'atualizacao') !== 'atualizacao') return f;
      let primeira = false;
      try { primeira = catalogo.primeiraLeitura(regra.id, f.config); } catch (e) { console.error('[catalogo] primeira leitura:', e?.code || e?.name || 'erro'); }
      return { ...f, primeira_leitura: !!primeira };
    });
    return { ...regra, sources };
  };
  app.get('/api/rules', wrap(() => all('SELECT * FROM rules ORDER BY id').map((r) => {
    const regra = parseRule(r);
    return { ...comPrimeiraLeitura(regra), em_andamento: scheduler.isRunning(r.id), proximo_horario: proximoDaGrade(regra) };
  })));
  app.post('/api/rules', wrap((req) => {
    const v = ruleFromBody(req.body);
    return { id: db.prepare(`INSERT INTO rules (${COLS}, created_at) VALUES (${v.map(() => '?').join(',')}, ?)`).run(...v, Date.now()).lastInsertRowid };
  }));
  app.put('/api/rules/:id', wrap((req) => {
    const v = ruleFromBody(req.body);
    db.prepare(`UPDATE rules SET ${COLS.split(', ').map((c) => c + ' = ?').join(', ')}, next_run_at = NULL WHERE id = ?`).run(...v, req.params.id);
  }));
  app.post('/api/rules/:id/enabled', wrap((req) => {
    db.prepare('UPDATE rules SET enabled = ?, next_run_at = NULL WHERE id = ?').run(req.body.enabled ? 1 : 0, req.params.id);
  }));
  // Apagar a regra leva junto o que é dela no catálogo (itens tratados, revisão e cursores): o id de `rules` pode ser
  // reaproveitado por uma regra nova, que não pode herdar nada.
  app.delete('/api/rules/:id', wrap((req) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM rules WHERE id = ?').run(req.params.id);
      db.prepare('DELETE FROM sent_offers WHERE rule_id = ?').run(req.params.id);
      db.prepare('DELETE FROM catalogo_itens WHERE rule_id = ?').run(req.params.id);
      if (catalogo) catalogo.esquecerRegra(req.params.id);
      else db.prepare('DELETE FROM catalogo_cursores WHERE rule_id = ?').run(req.params.id);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }));
  app.post('/api/rules/:id/run', wrap((req) => { scheduler.runRule(Number(req.params.id), { manual: true }).catch(() => {}); return { iniciado: true }; }));
  app.get('/api/rules/:id/offers', wrap((req) => scheduler.previewOffers(Number(req.params.id))));
  // "Limpar já enviadas": também as ofertas do catálogo que saíram (as em revisão e as descartadas ficam)
  app.post('/api/rules/:id/reset-sent', wrap((req) => {
    db.prepare('DELETE FROM sent_offers WHERE rule_id = ?').run(req.params.id);
    db.prepare("DELETE FROM catalogo_itens WHERE rule_id = ? AND status = 'enviado'").run(req.params.id);
  }));

  // ---------- catálogo do Etiqueta (o painel nunca fala com o Etiqueta: só com estas rotas) ----------
  const falhaCatalogo = (res, onde, e) => {
    console.error(`[catalogo] ${onde}:`, e?.code || e?.name || 'erro'); // sem e.message: pode trazer valores da query
    res.status(500).json({ erro: 'Não consegui concluir. Tente de novo.' });
  };
  const inteiroNaoNegativo = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
  // Categorias da última verificação (gravadas pelo "Testar" de Conexões); sem rede. Dono e Operador.
  app.get('/api/catalogo/categorias', (req, res) => {
    try {
      const v = catalogo?.ultimaVerificacao() ?? null;
      const categorias = (Array.isArray(v?.categorias) ? v.categorias : [])
        .filter((c) => c && typeof c.nome === 'string' && c.nome)
        .map((c) => ({ nome: c.nome, total: inteiroNaoNegativo(c.total), lojas: { amazon: inteiroNaoNegativo(c.lojas?.amazon), ml: inteiroNaoNegativo(c.lojas?.ml), shopee: inteiroNaoNegativo(c.lojas?.shopee) } }));
      let estado = null;
      try { estado = catalogo?.situacao().estado ?? null; } catch { estado = null; }
      res.json({ categorias, total: inteiroNaoNegativo(v?.total), verificado_em: Number.isFinite(v?.verificado_em) ? v.verificado_em : null, estado });
    } catch (e) { falhaCatalogo(res, 'categorias', e); }
  });
  // "Reler do começo": só o Dono (P6). Nunca com a regra rodando: o cursor é escrito só pelo runRule.
  app.post('/api/rules/:id/catalogo/recomecar', exigeDono, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0 || !one('SELECT 1 FROM rules WHERE id = ?', id)) return res.status(404).json({ erro: 'Regra não encontrada.' });
    if (!catalogo) return res.status(503).json({ erro: 'O catálogo não está disponível neste servidor.' });
    if (scheduler?.isRunning?.(id)) return res.status(409).json({ erro: 'Esta regra está rodando agora. Espere terminar e tente de novo.' });
    try { res.json({ ok: true, fontes: catalogo.recomecar(id) }); } catch (e) { falhaCatalogo(res, 'reler do começo', e); }
  });

  // ---------- histórico ----------
  // ?nivel=<level> e ?tipo=automatico (só as linhas das regras do Disparo automático: só o runRule grava rule_id;
  // Avisos, Equipe, envios avulsos e espelhamento gravam null). Os dois filtros se combinam.
  app.get('/api/log', wrap((req) => {
    const only = req.query.nivel;
    const tipo = req.query.tipo;
    if (tipo != null && tipo !== '' && tipo !== 'todos' && tipo !== 'automatico') throw new Error('Filtro inválido: use automatico ou todos.');
    const lim = Math.min(Number(req.query.limite) || 200, 1000);
    const filtros = []; const args = [];
    if (only) { filtros.push('level = ?'); args.push(only); }
    if (tipo === 'automatico') filtros.push('rule_id IS NOT NULL');
    return all(`SELECT * FROM log ${filtros.length ? `WHERE ${filtros.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`, ...args, lim);
  }));
  // o que o modo simulado "enviou": grupo aparece; número de pessoa (destino de aviso) vai mascarado para a tela
  app.get('/api/simulados', wrap(() => wa.simulated.slice(-50).map((m) => (String(m.jid).endsWith('@g.us') ? m : { ...m, jid: mascararNumero(m.jid) }))));

  // ---------- features novas: cada módulo monta as próprias rotas, todas depois do Host/Origin e do login ----------
  const ctx = { db, wa, links, scheduler, auth, wrap, soDono: exigeDono, dataDir, ml, amazon, shopee, catalogo, catalogoItens, enderecoPublico, publicHost, gravarCookie, sidDe };
  // rotasRotinas (Grupo vivo): o serviço é scheduler.rotinas, lido na hora; Operador pode tudo, sem soDono (P15)
  for (const montar of [rotasEnvios, rotasAvisos, rotasConexoes, rotasEspelho, rotasRemetentes, rotasEquipe, rotasCatalogoItens, rotasRotinas]) montar(app, ctx);

  // Erros de parsing (JSON inválido, corpo grande demais) e inesperados: resposta curta, sem stack nem caminhos.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err?.status || err?.statusCode || 500;
    if (status >= 500) console.error('[erro]', err?.message || err);
    res.status(status).json({ erro: status === 413 ? 'Corpo grande demais' : status < 500 ? 'Requisição inválida' : 'Erro interno' });
  });

  return app;
}

// ---------- inicialização ----------
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('server.js')) {
  const db = openDb(DATA_DIR);
  const migrados = migrarPseudonimos(db);
  if (migrados) console.log(`Privacidade: ${migrados} registros de participantes convertidos em pseudônimos.`);
  // leitura conta 1× por pessoa por dia de negócio (a virada do dia de Relatórios e avisos), como os relatórios
  const wa = createWhatsApp({ db, dir: DATA_DIR, dryRun: DRY_RUN, pseudo: (id) => pseudonimo(db, id), diaDe: (ts) => dayOf(ts, viradaMin(db)) });
  const links = createLinkService({ getMode: () => (DRY_RUN ? 'fake' : getSetting(db, 'link_mode', 'extension')) });
  const { amazon, shopee, catalogo, catalogoItens, scheduler } = criarServicos({ db, wa, links, fast: FAST, dir: DATA_DIR, ml: mlPadrao });
  let app;
  try { app = buildApp({ db, wa, links, scheduler, amazon, shopee, catalogo, catalogoItens }); } catch (e) { console.error('ERRO:', e.message); process.exit(1); }
  const retencao = () => {
    try { const r = limparAntigos(db, Number(getSetting(db, 'retencao_dias', RETENCAO_PADRAO_DIAS))); if (r.eventos || r.leituras || r.cliques) console.log(`Retenção: apagados ${r.eventos} eventos, ${r.leituras} leituras, ${r.cliques} cliques antigos.`); } catch (e) { console.error('[retenção]', e.message); }
    // envios avulsos encerrados e fotos sem uso (src/envios.js); uma falha só vai para o log
    Promise.resolve().then(() => scheduler.envios.limpar(Number(getSetting(db, 'retencao_dias', RETENCAO_PADRAO_DIAS))))
      .then((r) => { const n = Object.entries(r || {}).filter(([, v]) => v > 0); if (n.length) console.log(`Retenção (envios avulsos): apagados ${n.map(([k, v]) => `${v} ${k}`).join(', ')}.`); })
      .catch((e) => console.error('[retenção]', e.message));
    // itens do espelhamento já decididos (guarda os 'enviado' que ainda contam para "Horas sem repetir")
    try { const r = scheduler.espelho.limpar(Number(getSetting(db, 'retencao_dias', RETENCAO_PADRAO_DIAS))); if (r.itens) console.log(`Retenção (espelhamento): apagados ${r.itens} itens antigos.`); } catch (e) { console.error('[retenção] espelhamento:', e?.code || e?.name || 'erro'); }
    // itens dos remetentes já decididos (mesma regra: guarda os 'enviado' que ainda contam para "Horas sem repetir")
    try { const r = scheduler.remetentes.limpar(Number(getSetting(db, 'retencao_dias', RETENCAO_PADRAO_DIAS))); if (r.itens) console.log(`Retenção (remetentes): apagados ${r.itens} itens antigos.`); } catch (e) { console.error('[retenção] remetentes:', e?.code || e?.name || 'erro'); }
  };
  retencao(); setInterval(retencao, 6 * 60 * 60 * 1000);

  if (!app.locals.auth.enabled()) {
    if (PUBLIC_HOST) {
      console.error('ERRO: PUBLIC_HOST está definido mas o painel não tem senha. Defina PANEL_PASSWORD (ou rode npm run senha) antes de expor o painel.');
      process.exit(1);
    }
    console.warn('AVISO: painel sem login (só localhost). Para proteger, use "Ativar login" em Conta → Equipe, defina PANEL_PASSWORD ou rode: npm run senha');
  }

  if (DRY_RUN) wa.connect();
  const server = app.listen(PORT, '127.0.0.1', () => {
    console.log(`\nachadinhoturbo rodando em http://localhost:${PORT}${PUBLIC_HOST ? ` (público: https://${PUBLIC_HOST})` : ''}${DRY_RUN ? '  (MODO SIMULAÇÃO: nada é enviado de verdade)' : ''}\n`);
    wa.autoStart();
    scheduler.start();
    setInterval(() => { try { verificarLotacao(db); } catch (e) { console.error('[lotação]', e.message); } }, 60000);
  });

  // Encerramento limpo (systemd manda SIGTERM): para o agendador, fecha o servidor e o banco.
  let encerrando = false;
  const encerrar = (sinal) => {
    if (encerrando) return; encerrando = true;
    console.log(`\nRecebi ${sinal}: encerrando…`);
    scheduler.stop();
    server.close(() => { try { db.close(); } catch { /* já fechado */ } process.exit(0); });
    server.closeAllConnections?.(); // derruba long-polls abertos
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => encerrar('SIGTERM'));
  process.on('SIGINT', () => encerrar('SIGINT'));
}
