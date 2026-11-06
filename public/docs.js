// Docs do sistema (#docs, #docs/<capítulo>, #docs/<capítulo>/<seção>): o motor do livro.
// Plano: docs/produto/planos/docs-do-sistema.md (ADR-005). Spec: docs/produto/specs/docs-do-sistema.md.
// Carrega depois de ajuda.js e antes dos capítulos (public/docs/cap-*.js), que só chamam docsCapitulo({...}).
// Escopo global único com os outros scripts do painel: aqui só nomes com prefixo docs/DOCS_ (e paginaDocs), e nada
// toca o DOM ao carregar (os testes rodam todos os <script> do index.html num vm sem DOM de verdade).
// Segurança: todo texto de capítulo vira HTML só por docsInline (escape primeiro; depois, só o conjunto fechado de
// marcações) ou por docsEsc. Link só interno (#...), nada de atributo on*, eventos por delegação em #pagina.
// CSP script-src 'self': nada inline.

const DOCS_TEXTOS = {
  titulo: 'Docs do sistema',
  sub: 'Aprenda o Achadinho Turbo passo a passo. Procurando algo específico? Use a busca.',
  buscaRotulo: 'Buscar nos Docs', buscaPh: 'Ex.: tag da Amazon, backup', buscar: 'Buscar',
  buscaDica: 'Digite pelo menos 2 letras', limparBusca: 'Limpar busca', resultadosRotulo: 'Resultados da busca',
  nadaAchado: (t) => `Nada encontrado para “${t}”.`,
  nadaAchadoDica: 'Tente uma palavra mais curta ou sem acento. Ou veja as [Perguntas reais](#docs/perguntas) e a [Referência](#docs/referencia).',
  achados: (n, t) => (n === 1 ? `1 resultado para “${t}”` : `${n} resultados para “${t}”`),
  maisAchados: (max, n) => `Mostrando ${max} de ${n}. Refine a busca.`,
  sumario: 'Sumário', sumarioRotulo: 'Sumário do livro', inicio: 'Início',
  sumarioCap: (n, total, t) => `Sumário · cap. ${n} de ${total} · ${t}`, sumarioApendice: (t) => `Sumário · ${t}`,
  pular: 'Pular para o conteúdo do capítulo',
  capitulo: (n) => `Capítulo ${n}`, apendice: 'Apêndice', leitura: (n) => `Leitura: ${n} min`, consulta: 'Consulta',
  aprenda: 'O que você vai aprender', antes: 'Antes de começar', nestaPagina: 'Nesta página',
  soDono: 'Só o Dono', onde: 'Onde:', ancora: 'Link para esta seção',
  leia: (cap, sec) => `Ler o capítulo ${cap}: ${sec}`,
  abrir: (tela) => `Abrir ${tela} no painel`,
  navRotulo: 'Capítulo anterior e próximo', anterior: 'Anterior', proximo: 'Próximo', continueCom: 'Continue com',
  voltarInicio: 'Voltar ao início do livro',
  copiar: 'Copiar', copiado: 'Copiado', comandoCopiado: 'Comando copiado', comando: 'Comando', exemplo: 'Exemplo',
  copiarFalhou: 'Não deu para copiar. Selecione e copie (Ctrl+C).',
  tabela: (cols) => `Tabela: ${cols}`,
  naoAchadoTitulo: 'Não achamos este capítulo', naoAchadoTexto: 'O endereço pode estar errado ou o capítulo mudou de nome.',
  naoAchadoAba: 'Capítulo não encontrado', irInicio: 'Ir para o início do livro', verSumario: 'Ver o sumário',
  anuncioCap: (n, total, t) => `Capítulo ${n} de ${total}: ${t}`, anuncioApendice: (t) => `Apêndice: ${t}`,
  anuncioInicio: 'Docs do sistema: início',
  // Início do livro (texto com a mesma mini-marcação dos capítulos)
  inicioTitulo: 'Início',
  inicioApresenta: [
    'O Achadinho Turbo envia ofertas com o seu link de afiliado para os seus grupos de WhatsApp.',
    'Ele roda no seu computador: o painel, os dados e as chaves ficam aqui.',
    'Também mostra quem entra, sai e lê nos grupos, e reparte um link de convite entre vários grupos.',
  ],
  inicioMapaTitulo: 'Quem faz o quê',
  inicioMapa: [
    ['Painel', 'Onde você configura e acompanha tudo. Abre no navegador, em `http://localhost:3737`.'],
    ['WhatsApp', 'O seu número entra como aparelho conectado e envia as mensagens aos grupos.'],
    ['Extensão do Chrome', 'Usa a sua sessão na Central de Afiliados do Mercado Livre para gerar os links `meli.la` e ler a lista de ofertas. Também gera os links da Shopee.'],
    ['Lojas', 'Mercado Livre, Amazon, Shopee e Magalu, configuradas em [[Conexões]]. O Catálogo traz as ofertas do seu app Etiqueta.'],
  ],
  inicioComoTitulo: 'Como usar este livro',
  inicioComo: [
    'Leia os capítulos em ordem, ou abra um pelo **Sumário**.',
    'Use a **busca**, no topo, para achar um assunto.',
    'Os ícones `?` do painel explicam cada campo no lugar.',
    'Para uma dúvida rápida, veja as [Perguntas reais](#docs/perguntas) e a [Referência](#docs/referencia).',
  ],
  comecar: 'Começar pelo capítulo 1',
  // progresso de leitura (fica só neste navegador)
  progressoRotulo: 'Progresso da trilha', lidos: (n, total) => `${n} de ${total} lidos`,
  terminou: (total) => `${total} de ${total} lidos. Você terminou a trilha.`,
  lido: '(lido)', marcarLido: 'Marcar como lido', continuar: (n) => `Continuar do capítulo ${n}`,
  limparProgresso: 'Limpar progresso', progressoLimpo: 'Progresso apagado.', salvoAqui: 'Fica salvo só neste navegador.',
  anuncioLido: (n) => `Capítulo ${n} marcado como lido`, anuncioNaoLido: (n) => `Capítulo ${n} desmarcado`,
};

// Ordem do sumário e da trilha. numero null = apêndice (sem número e sem Anterior/Próximo).
// Capítulo novo: um arquivo em public/docs/, uma linha aqui e um <script> no index.html.
const DOCS_TRILHA = [
  { id: 'primeiros-passos', parte: 'trilha', numero: 1 },
  { id: 'conexoes', parte: 'trilha', numero: 2 },
  { id: 'templates', parte: 'trilha', numero: 3 },
  { id: 'disparo-manual', parte: 'trilha', numero: 4 },
  { id: 'disparo-automatico', parte: 'trilha', numero: 5 },
  { id: 'espelhamento', parte: 'trilha', numero: 6 },
  { id: 'revisao', parte: 'trilha', numero: 7 },
  { id: 'mensagens', parte: 'trilha', numero: 8 },
  { id: 'grupos', parte: 'trilha', numero: 9 },
  { id: 'resultados', parte: 'trilha', numero: 10 },
  { id: 'equipe', parte: 'trilha', numero: 11 },
  { id: 'privacidade', parte: 'trilha', numero: 12 },
  { id: 'manutencao', parte: 'trilha', numero: 13 },
  { id: 'perguntas', parte: 'apendice', numero: null },
  { id: 'referencia', parte: 'apendice', numero: null },
];
const DOCS_CAPS = Object.create(null); // id → capítulo registrado por docsCapitulo
const DOCS_ID = /^[a-z0-9-]+$/;
const DOCS_ALVO = /^#[a-z0-9-]+(\/[a-z0-9-]+){0,2}$/; // único formato de href que o conteúdo pode gerar
const DOCS_ROTA = /^#[a-z0-9-]+$/; // "Abrir <tela> no painel"
const DOCS_NOTAS = { aviso: { icone: '!', rotulo: 'Aviso' }, dica: { icone: 'i', rotulo: 'Dica' }, erro: { icone: '×', rotulo: 'Erro comum' } };
const DOCS_MAX_RESULTADOS = 20;
const DOCS_LARGURA_SUMARIO = '(min-width: 1100px)'; // abaixo disso o sumário fica num <details> fechado
const DOCS_CHAVE_LIDOS = 'docs.lidos'; // localStorage: lista JSON dos ids dos capítulos lidos (nada pessoal)
const DOCS_ESTADO = { buscaTimer: null, statusTimer: null, tituloOriginal: null, ouvindo: false, copiar: new WeakMap(), pagina: null, avisoLido: null };

/** Registra um capítulo (chamado pelos arquivos public/docs/cap-*.js). Lança erro com id inválido ou repetido. */
function docsCapitulo(cap) {
  if (!cap || typeof cap.id !== 'string' || !DOCS_ID.test(cap.id)) throw new Error('docsCapitulo: id de capítulo inválido');
  if (Object.hasOwn(DOCS_CAPS, cap.id)) throw new Error(`docsCapitulo: capítulo repetido (${cap.id})`);
  for (const s of Array.isArray(cap.secoes) ? cap.secoes : []) {
    if (!s || typeof s.id !== 'string' || !DOCS_ID.test(s.id)) throw new Error(`docsCapitulo: id de seção inválido em ${cap.id}`);
  }
  DOCS_CAPS[cap.id] = cap;
}

// ---------- texto: escape e mini-marcação ----------
function docsEsc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function docsCaminho(interno) {
  const partes = interno.split('→').map((p) => p.trim()).filter(Boolean);
  return `<span class="caminho">${partes.map((p) => `<b>${p}</b>`).join('<span class="sr-only"> depois </span><span aria-hidden="true">→</span>')}</span>`;
}
/**
 * Texto do capítulo → HTML seguro. Escapa tudo primeiro; depois só estas marcações viram tag:
 * **negrito**, `código`, {{tecla}}, [[Tela → Seção]] (caminho no painel) e [texto](#rota/interna).
 * Alvo que não é #interno (URL externa, javascript:, aspas) não vira link: o texto fica e o alvo vai em <code>.
 */
function docsInline(texto) {
  return String(texto ?? '').split(/(`[^`\n]+`)/).map((parte, i) => {
    if (i % 2) return `<code>${docsEsc(parte.slice(1, -1))}</code>`;
    return docsEsc(parte)
      .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\{\{([^{}\n]+)\}\}/g, '<kbd>$1</kbd>')
      .replace(/\[\[([^[\]\n]+)\]\]/g, (_, c) => docsCaminho(c))
      .replace(/\[([^[\]\n]+)\]\(([^()\s]*)\)/g, (_, t, alvo) => (DOCS_ALVO.test(alvo) ? `<a href="${alvo}">${t}</a>` : `${t} (<code>${alvo}</code>)`));
  }).join('');
}
/** Texto sem a mini-marcação (busca, contagem de palavras, rótulos e títulos dentro de links). */
function docsPlano(texto) {
  return String(texto ?? '').replace(/`([^`\n]+)`/g, '$1').replace(/\*\*([^*\n]+?)\*\*/g, '$1').replace(/\{\{([^{}\n]+)\}\}/g, '$1')
    .replace(/\[\[([^[\]\n]+)\]\]/g, '$1').replace(/\[([^[\]\n]+)\]\(([^()\s]*)\)/g, '$1');
}
const docsTxt = (s) => docsEsc(docsPlano(s));

// ---------- consulta ao registro ----------
function docsCap(id) {
  return typeof id === 'string' && Object.hasOwn(DOCS_CAPS, id) && DOCS_TRILHA.some((t) => t.id === id) ? DOCS_CAPS[id] : null;
}
const docsSecoes = (cap) => (Array.isArray(cap?.secoes) ? cap.secoes.filter((s) => s && typeof s === 'object') : []);
const docsNumerados = () => DOCS_TRILHA.filter((t) => t.numero != null && docsCap(t.id));
const docsNumero = (id) => DOCS_TRILHA.find((t) => t.id === id)?.numero ?? null;
const docsLista = (v) => (Array.isArray(v) ? v : []);
/** Endereço interno de um capítulo ou seção (ids já validados por DOCS_ID). */
const docsHref = (cap, secao) => '#docs' + (cap ? '/' + cap : '') + (cap && secao ? '/' + secao : '');
/** pedido = o hash sem '#' (ex.: 'docs/conexoes/amazon'); outro prefixo (o alias 'ajuda') abre o Início. */
function docsPedido(pedido) {
  const partes = String(pedido ?? '').split('?')[0].split('/');
  return partes[0] === 'docs' ? { cap: partes[1] || '', secao: partes[2] || '' } : { cap: '', secao: '' };
}

// ---------- progresso de leitura (localStorage 'docs.lidos'; por navegador, não por pessoa) ----------
/** O localStorage, ou null se não existe ou o navegador o bloqueia (até ler a propriedade pode lançar erro). */
function docsStorage() {
  try { return typeof localStorage !== 'undefined' && localStorage && typeof localStorage.getItem === 'function' ? localStorage : null; } catch { return null; }
}
const docsProgressoDisponivel = () => docsStorage() !== null;
const docsTotalTrilha = () => DOCS_TRILHA.filter((t) => t.numero != null).length;
/** Ids dos capítulos lidos, na ordem da trilha. Valor ausente, JSON inválido ou formato errado = nenhum; id desconhecido é ignorado. */
function docsLidos() {
  try {
    const raw = docsStorage()?.getItem(DOCS_CHAVE_LIDOS); if (typeof raw !== 'string') return [];
    const v = JSON.parse(raw); if (!Array.isArray(v)) return [];
    return DOCS_TRILHA.filter((t) => t.numero != null && v.includes(t.id)).map((t) => t.id);
  } catch { return []; }
}
function docsGravarLidos(ids) {
  try { const st = docsStorage(); if (!st) return false; st.setItem(DOCS_CHAVE_LIDOS, JSON.stringify(ids)); return true; } catch { return false; }
}
/** Marca (ou desmarca) um capítulo da trilha. Devolve true se gravou; apêndice, id desconhecido ou falha de gravação = false. */
function docsMarcarLido(id, lido = true) {
  if (!DOCS_TRILHA.some((t) => t.id === id && t.numero != null)) return false;
  const atuais = docsLidos(); const tem = atuais.includes(id);
  if (tem === !!lido) return true;
  const novos = lido ? [...atuais, id] : atuais.filter((x) => x !== id);
  return docsGravarLidos(DOCS_TRILHA.filter((t) => novos.includes(t.id)).map((t) => t.id)); // sempre na ordem da trilha
}
function docsLimparProgresso() {
  try { const st = docsStorage(); if (!st) return false; st.removeItem(DOCS_CHAVE_LIDOS); return true; } catch { return false; }
}
/** Primeiro capítulo da trilha que ainda não foi lido (null = todos lidos). */
function docsProximoNaoLido() {
  const lidos = docsLidos();
  return docsNumerados().find((t) => !lidos.includes(t.id)) || null;
}

function docsTextosBloco(b) {
  if (!b || typeof b !== 'object') return [];
  if (Object.hasOwn(b, 'p')) return [b.p];
  if (Object.hasOwn(b, 'passos')) return docsLista(b.passos);
  if (Object.hasOwn(b, 'nota')) return [b.texto];
  if (Object.hasOwn(b, 'comando')) return [b.comando];
  if (Object.hasOwn(b, 'exemplo')) return [b.exemplo];
  if (Object.hasOwn(b, 'tabela')) return [...docsLista(b.tabela?.colunas), ...docsLista(b.tabela?.linhas).flatMap(docsLista)];
  if (Object.hasOwn(b, 'termos')) return [b.titulo, ...docsLista(b.termos).flatMap(docsLista)];
  return [];
}
function docsMinutos(cap) {
  const textos = [cap.titulo, ...docsLista(cap.aprenda), ...docsLista(cap.antes)];
  for (const s of docsSecoes(cap)) textos.push(s.titulo, s.onde, ...docsLista(s.blocos).flatMap(docsTextosBloco));
  const palavras = textos.filter((x) => x != null).map(docsPlano).join(' ').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(palavras / 200));
}

// ---------- HTML (funções puras: testáveis sem DOM) ----------
function docsHtmlBloco(b) {
  if (!b || typeof b !== 'object') return '';
  if (Object.hasOwn(b, 'p')) return `<p>${docsInline(b.p)}</p>`;
  if (Object.hasOwn(b, 'passos')) return `<ol class="docs-passos">${docsLista(b.passos).map((x) => `<li>${docsInline(x)}</li>`).join('')}</ol>`;
  if (Object.hasOwn(b, 'nota')) {
    const tipo = typeof b.nota === 'string' && Object.hasOwn(DOCS_NOTAS, b.nota) ? b.nota : 'dica'; const n = DOCS_NOTAS[tipo];
    return `<div class="docs-nota docs-nota--${tipo}" role="note"><p class="docs-nota-t"><span aria-hidden="true">${n.icone}</span> ${n.rotulo}</p><p>${docsInline(b.texto)}</p></div>`;
  }
  if (Object.hasOwn(b, 'comando')) {
    return `<div class="docs-cmd"><pre class="docs-cmd-pre" tabindex="0" aria-label="${DOCS_TEXTOS.comando}"><code>${docsEsc(b.comando)}</code></pre>`
      + `<button type="button" class="leve" data-docs-copiar>${DOCS_TEXTOS.copiar}</button><p class="docs-cmd-erro" hidden></p></div>`;
  }
  if (Object.hasOwn(b, 'exemplo')) return `<pre class="docs-exemplo" tabindex="0" aria-label="${DOCS_TEXTOS.exemplo}"><code>${docsEsc(b.exemplo)}</code></pre>`;
  if (Object.hasOwn(b, 'tabela')) {
    const colunas = docsLista(b.tabela?.colunas); const linhas = docsLista(b.tabela?.linhas);
    return `<div class="tabela" tabindex="0" role="region" aria-label="${docsEsc(DOCS_TEXTOS.tabela(colunas.map(docsPlano).join(', ')))}"><table>`
      + `<thead><tr>${colunas.map((c) => `<th scope="col">${docsInline(c)}</th>`).join('')}</tr></thead>`
      + `<tbody>${linhas.map((l) => `<tr>${docsLista(l).map((c, i) => (i ? `<td>${docsInline(c)}</td>` : `<th scope="row">${docsInline(c)}</th>`)).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  if (Object.hasOwn(b, 'termos')) {
    return `${b.titulo ? `<h4>${docsInline(b.titulo)}</h4>` : ''}<dl class="glossario">${docsLista(b.termos).map((par) => { const [t, d] = docsLista(par); return `<dt>${docsInline(t)}</dt><dd>${docsInline(d)}</dd>`; }).join('')}</dl>`;
  }
  return '';
}

/** "Ler o capítulo" de uma seção (leia: 'cap/secao'); some se o destino não existir. */
function docsHtmlLeia(leia) {
  if (typeof leia !== 'string') return '';
  const [capId, secId] = leia.split('/'); const cap = docsCap(capId); const sec = docsSecoes(cap).find((s) => s.id === secId);
  if (!cap || !sec || !DOCS_ID.test(secId)) return '';
  const n = docsNumero(capId); const nomeCap = (n ? n + '. ' : '') + docsPlano(cap.titulo);
  return `<p class="docs-leia"><a href="${docsHref(capId, secId)}">${docsEsc(DOCS_TEXTOS.leia(nomeCap, docsPlano(sec.titulo)))}</a></p>`;
}

function docsHtmlSecao(cap, s) {
  const selo = s.soDono ? ` <span class="chip so-dono">${DOCS_TEXTOS.soDono}</span>` : '';
  const ancora = 'docs-s-' + docsEsc(s.id); // id já validado por docsCapitulo; o escape é só defesa
  return `<section class="docs-secao" aria-labelledby="${ancora}"><div class="docs-secao-t">`
    + `<h3 id="${ancora}" tabindex="-1">${docsInline(s.titulo)}${selo}</h3>`
    + `<a class="docs-ancora" href="${docsHref(cap.id, s.id)}" aria-label="${DOCS_TEXTOS.ancora}">#</a></div>`
    + docsLista(s.blocos).map(docsHtmlBloco).join('')
    + (s.onde ? `<p class="docs-onde"><b>${DOCS_TEXTOS.onde}</b> ${docsInline(s.onde)}</p>` : '')
    + docsHtmlLeia(s.leia) + '</section>';
}

/** O capítulo inteiro (sem o Anterior/Próximo). Capítulo que não existe vira o estado "Não achamos". */
function docsHtmlCapitulo(id) {
  const cap = docsCap(id); if (!cap) return docsHtmlNaoAchado();
  const n = docsNumero(id); const secoes = docsSecoes(cap);
  const lista = (titulo, itens, cls) => (itens.length ? `<div class="${cls}"><p class="${cls}-t">${titulo}</p><ul>${itens.map((x) => `<li>${docsInline(x)}</li>`).join('')}</ul></div>` : '');
  const indice = n == null && secoes.length ? `<div class="docs-indice"><p class="docs-indice-t">${DOCS_TEXTOS.nestaPagina}</p><ul>${secoes.map((s) => `<li><a href="${docsHref(id, s.id)}">${docsTxt(s.titulo)}</a></li>`).join('')}</ul></div>` : '';
  const abrir = docsLista(cap.abrir).filter((a) => a && typeof a.rota === 'string' && DOCS_ROTA.test(a.rota))
    .map((a) => `<a class="btn" href="${a.rota}">${docsEsc(DOCS_TEXTOS.abrir(docsPlano(a.tela)))}</a>`).join(' ');
  // Apêndice (Perguntas reais, Referência) é consulta, não lição: sem "O que você vai aprender" e sem tempo de leitura.
  return `<article class="card docs-capitulo" aria-labelledby="docs-titulo"><header class="docs-cap">`
    + `<p class="docs-cap-n">${n == null ? DOCS_TEXTOS.apendice : DOCS_TEXTOS.capitulo(n)}</p>`
    + `<h2 id="docs-titulo" tabindex="-1">${docsInline(cap.titulo)}</h2><p class="docs-leitura">${n == null ? DOCS_TEXTOS.consulta : DOCS_TEXTOS.leitura(docsMinutos(cap))}</p></header>`
    + (n == null ? '' : lista(DOCS_TEXTOS.aprenda, docsLista(cap.aprenda), 'docs-aprenda')) + lista(DOCS_TEXTOS.antes, docsLista(cap.antes), 'docs-antes')
    + indice + secoes.map((s) => docsHtmlSecao(cap, s)).join('')
    + (abrir ? `<p class="docs-abrir">${abrir}</p>` : '') + '</article>';
}

/** Anterior/Próximo da trilha; os apêndices só têm "Voltar ao início do livro". */
function docsHtmlNav(id) {
  const trilha = docsNumerados(); const i = trilha.findIndex((t) => t.id === id);
  const cartao = (cls, rotulo, href, texto) => `<a class="${cls}" href="${href}"><span class="docs-nav-r">${rotulo}</span> <span class="docs-nav-t">${docsEsc(texto)}</span></a>`;
  const nome = (t) => `${t.numero}. ${docsPlano(docsCap(t.id).titulo)}`;
  let html;
  if (i < 0) html = `<a class="docs-nav-inicio" href="#docs">${DOCS_TEXTOS.voltarInicio}</a>`;
  else {
    const ant = i === 0 ? cartao('docs-nav-ant', DOCS_TEXTOS.anterior, '#docs', DOCS_TEXTOS.inicio) : cartao('docs-nav-ant', DOCS_TEXTOS.anterior, docsHref(trilha[i - 1].id), nome(trilha[i - 1]));
    const apendice = DOCS_TRILHA.find((t) => t.numero == null && docsCap(t.id));
    const prox = i < trilha.length - 1 ? cartao('docs-nav-prox', DOCS_TEXTOS.proximo, docsHref(trilha[i + 1].id), nome(trilha[i + 1]))
      : apendice ? cartao('docs-nav-prox', DOCS_TEXTOS.continueCom, docsHref(apendice.id), docsPlano(docsCap(apendice.id).titulo)) : '';
    html = ant + prox;
  }
  return `<nav class="docs-nav" aria-label="${DOCS_TEXTOS.navRotulo}">${html}</nav>`;
}

function docsHtmlInicio() {
  const T = DOCS_TEXTOS;
  return `<article class="card docs-inicio" aria-labelledby="docs-titulo"><h2 id="docs-titulo" tabindex="-1">${T.inicioTitulo}</h2>`
    + T.inicioApresenta.map((p) => `<p>${docsInline(p)}</p>`).join('')
    + `<h3>${T.inicioMapaTitulo}</h3><dl class="glossario">${T.inicioMapa.map(([t, d]) => `<dt>${docsInline(t)}</dt><dd>${docsInline(d)}</dd>`).join('')}</dl>`
    + `<h3>${T.inicioComoTitulo}</h3><ul>${T.inicioComo.map((x) => `<li>${docsInline(x)}</li>`).join('')}</ul>`
    + `<div id="docs-inicio-cta">${docsHtmlInicioCta()}</div></article>`;
}
/** Progresso e botão do Início: "Começar pelo capítulo 1" ou "Continuar do capítulo N" (o primeiro não lido). */
function docsHtmlInicioCta() {
  const T = DOCS_TEXTOS; const trilha = docsNumerados(); const primeiro = trilha[0]; if (!primeiro) return '';
  const disponivel = docsProgressoDisponivel(); const lidos = disponivel ? docsLidos().length : 0; const total = docsTotalTrilha();
  const proximo = disponivel && lidos ? docsProximoNaoLido() : null;
  const alvo = proximo || primeiro; const texto = proximo ? T.continuar(proximo.numero) : T.comecar;
  const resumo = !disponivel ? '' : lidos >= total && total > 0 ? T.terminou(total) : T.lidos(lidos, total) + '.';
  return (resumo ? `<p class="docs-inicio-progresso">${docsEsc(resumo)} ${T.salvoAqui}</p>` : '')
    + `<p class="docs-abrir"><a class="btn" href="${docsHref(alvo.id)}">${docsEsc(texto)}</a></p>`;
}
/** "Marcar como lido" no fim de um capítulo da trilha (sem progresso disponível, ou em apêndice, não aparece). */
function docsHtmlMarcar(id) {
  if (!docsProgressoDisponivel() || docsNumero(id) == null) return '';
  return `<p class="docs-marcar"><label><input type="checkbox" id="docs-lido" data-docs-lido="${docsEsc(id)}"${docsLidos().includes(id) ? ' checked' : ''}> ${DOCS_TEXTOS.marcarLido}</label></p>`;
}

function docsHtmlNaoAchado() {
  const T = DOCS_TEXTOS;
  return `<article class="card docs-vazio" aria-labelledby="docs-titulo"><h2 id="docs-titulo" tabindex="-1">${T.naoAchadoTitulo}</h2><p>${T.naoAchadoTexto}</p>`
    + `<p class="docs-abrir"><a class="btn" href="#docs">${T.irInicio}</a> <button type="button" class="leve" data-docs-sumario>${T.verSumario}</button></p></article>`;
}

/** "N de 13 lidos" + barra (só com o progresso disponível), a lista do sumário e o "Limpar progresso" (só com algo lido). */
function docsHtmlSumario(atual, secaoAtual) {
  const T = DOCS_TEXTOS; const disponivel = docsProgressoDisponivel(); const lidos = disponivel ? docsLidos() : [];
  const item = (t) => {
    const cap = docsCap(t.id); const aberto = t.id === atual;
    const secoes = aberto ? `<ol class="docs-toc-secoes">${docsSecoes(cap).map((s) => `<li><a href="${docsHref(t.id, s.id)}"${s.id === secaoAtual ? ' aria-current="location"' : ''}>${docsTxt(s.titulo)}</a></li>`).join('')}</ol>` : '';
    const ok = lidos.includes(t.id);
    const marca = ok ? '<span class="docs-toc-lido" aria-hidden="true">✓</span> ' : '';
    const n = t.numero != null ? `<span class="docs-toc-n">${t.numero}.</span> ` : '';
    const sr = ok ? ` <span class="sr-only">${T.lido}</span>` : '';
    return `<li><a href="${docsHref(t.id)}"${aberto ? ' aria-current="page"' : ''}>${marca}${n}${docsTxt(cap.titulo)}${sr}</a>${secoes}</li>`;
  };
  const apendices = DOCS_TRILHA.filter((t) => t.numero == null && docsCap(t.id));
  const total = docsTotalTrilha();
  const progresso = disponivel ? `<div class="docs-progresso"><p class="docs-progresso-t" id="docs-progresso-t" tabindex="-1">${T.lidos(lidos.length, total)}</p>`
    + `<progress class="docs-barra" max="${total}" value="${lidos.length}" aria-label="${T.progressoRotulo}" aria-hidden="true"></progress></div>` : '';
  const limpar = lidos.length ? `<p class="docs-toc-limpar"><button type="button" class="leve" data-docs-limpar-progresso>${T.limparProgresso}</button></p>` : '';
  return progresso + `<nav class="docs-toc-nav" aria-label="${T.sumarioRotulo}"><ul class="docs-toc-inicio"><li><a href="#docs"${atual === '' ? ' aria-current="page"' : ''}>${T.inicio}</a></li></ul>`
    + `<ol class="docs-toc-trilha">${docsNumerados().map(item).join('')}</ol>`
    + (apendices.length ? `<ul class="docs-toc-apendices">${apendices.map(item).join('')}</ul>` : '') + '</nav>' + limpar;
}
function docsResumoSumario(atual) {
  const cap = docsCap(atual); if (!cap) return DOCS_TEXTOS.sumario;
  const n = docsNumero(atual);
  return n == null ? DOCS_TEXTOS.sumarioApendice(docsPlano(cap.titulo)) : DOCS_TEXTOS.sumarioCap(n, docsNumerados().length, docsPlano(cap.titulo));
}

// ---------- busca (em memória; nada vai para o endereço) ----------
const docsNorm = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
/** Texto normalizado e, para cada caractere dele, a posição no texto original (para marcar o trecho sem acento). */
function docsMapa(s) {
  let norm = ''; const idx = []; let pos = 0;
  for (const ch of s) { const n = docsNorm(ch); for (let k = 0; k < n.length; k++) idx.push(pos); norm += n; pos += ch.length; }
  idx.push(s.length);
  return { norm, idx };
}
function docsTrecho(corpo, termos) {
  const { norm, idx } = docsMapa(corpo);
  const achou = termos.map((t) => norm.indexOf(t)).filter((p) => p >= 0);
  const centro = achou.length ? idx[Math.min(...achou)] : 0;
  let ini = Math.max(0, centro - 60); let fim = Math.min(corpo.length, ini + 180);
  // corta em espaço, para não partir palavra
  if (ini > 0) { const esp = corpo.indexOf(' ', ini); if (esp >= 0 && esp < centro) ini = esp + 1; }
  if (fim < corpo.length) { const esp = corpo.lastIndexOf(' ', fim); if (esp > centro) fim = esp; }
  return (ini > 0 ? '…' : '') + corpo.slice(ini, fim).trim() + (fim < corpo.length ? '…' : '');
}
/** Trecho → HTML com cada termo em <mark>; cada pedaço passa por docsEsc. */
function docsMarcar(trecho, termos) {
  const { norm, idx } = docsMapa(trecho); const faixas = [];
  for (const t of termos) for (let p = norm.indexOf(t); p >= 0; p = norm.indexOf(t, p + t.length)) faixas.push([idx[p], idx[p + t.length]]);
  faixas.sort((a, b) => a[0] - b[0]);
  let html = ''; let ate = 0;
  for (const [a, b] of faixas) {
    if (b <= ate) continue;
    const ini = Math.max(a, ate);
    html += docsEsc(trecho.slice(ate, ini)) + `<mark>${docsEsc(trecho.slice(ini, b))}</mark>`; ate = b;
  }
  return html + docsEsc(trecho.slice(ate));
}
/**
 * Busca em todos os capítulos: ignora maiúsculas e acentos, exige 2 letras ou mais e todos os termos na mesma
 * seção (ou no topo do capítulo). Devolve todos os achados: primeiro os que têm algum termo no título da seção, depois
 * no título do capítulo, depois só no texto; dentro de cada grupo, a ordem do sumário.
 * No apêndice o "O que você vai aprender" não aparece na tela, então não entra na busca.
 */
function docsBuscar(termo) {
  const norm = docsNorm(String(termo ?? '').trim()); if (norm.length < 2) return [];
  const termos = norm.split(/\s+/).filter(Boolean); const achados = [];
  for (const t of DOCS_TRILHA) {
    const cap = docsCap(t.id); if (!cap) continue;
    const tituloCap = docsNorm(docsPlano(cap.titulo));
    const unidades = [{ secao: '', titulo: cap.titulo, corpo: [...(t.numero == null ? [] : docsLista(cap.aprenda)), ...docsLista(cap.antes)] },
      ...docsSecoes(cap).map((s) => ({ secao: s.id, titulo: s.titulo, corpo: [...docsLista(s.blocos).flatMap(docsTextosBloco), s.onde] }))];
    for (const u of unidades) {
      const titulo = docsPlano(u.titulo);
      const corpo = u.corpo.filter((x) => x != null).map(docsPlano).join(' ').replace(/\s+/g, ' ').trim();
      const tudo = docsNorm(titulo + ' ' + corpo);
      if (!termos.every((x) => tudo.includes(x))) continue;
      const nosTitulos = (alvo) => termos.some((x) => alvo.includes(x));
      const grupo = u.secao && nosTitulos(docsNorm(titulo)) ? 0 : nosTitulos(tituloCap) ? 1 : 2;
      achados.push({ cap: t.id, secao: u.secao, titulo, trecho: docsTrecho(corpo, termos), grupo, ordem: achados.length });
    }
  }
  return achados.sort((a, b) => a.grupo - b.grupo || a.ordem - b.ordem).map(({ grupo, ordem, ...r }) => r);
}
/** Resultado da busca: resumo (texto puro, para o role=status) e o HTML da lista. */
function docsHtmlBusca(termo) {
  const T = DOCS_TEXTOS; const t = String(termo ?? '').trim(); const achados = docsBuscar(t);
  const termos = docsNorm(t).split(/\s+/).filter(Boolean);
  const limpar = `<p class="docs-abrir"><button type="button" class="leve" data-docs-limpar>${T.limparBusca}</button></p>`;
  if (!achados.length) {
    const resumo = T.nadaAchado(t);
    return { resumo, html: `<p class="docs-res-resumo">${docsEsc(resumo)}</p><p>${docsInline(T.nadaAchadoDica)}</p>${limpar}` };
  }
  const resumo = T.achados(achados.length, t);
  const itens = achados.slice(0, DOCS_MAX_RESULTADOS).map((r) => {
    const cap = docsCap(r.cap); const n = docsNumero(r.cap);
    const onde = (n ? n + '. ' : '') + docsPlano(cap.titulo) + (r.secao ? ' · ' + r.titulo : '');
    return `<li><a href="${docsHref(r.cap, r.secao)}"><span class="docs-res-onde">${docsMarcar(onde, termos)}</span> <span class="docs-res-trecho">${docsMarcar(r.trecho, termos)}</span></a></li>`;
  }).join('');
  const mais = achados.length > DOCS_MAX_RESULTADOS ? `<p>${T.maisAchados(DOCS_MAX_RESULTADOS, achados.length)}</p>` : '';
  return { resumo, html: `<p class="docs-res-resumo">${docsEsc(resumo)}</p><ol class="docs-resultados-lista">${itens}</ol>${mais}${limpar}` };
}

// ---------- página (DOM) ----------
const docsEl = (id) => document.getElementById(id);
function docsLargo() {
  try { return typeof matchMedia === 'function' && matchMedia(DOCS_LARGURA_SUMARIO).matches; } catch { return false; }
}
/** Anuncia no role=status da página (esvazia e preenche depois, para o leitor de tela perceber a troca). */
function docsAnunciar(msg) {
  const st = docsEl('docs-status'); if (!st) return;
  st.textContent = ''; clearTimeout(DOCS_ESTADO.statusTimer);
  DOCS_ESTADO.statusTimer = setTimeout(() => { st.textContent = msg; }, 100);
}
function docsMostrarBusca(valor) {
  const conteudo = docsEl('docs-conteudo'); const res = docsEl('docs-resultados'); if (!conteudo || !res) return;
  const termo = String(valor ?? '').trim();
  if (docsNorm(termo).length < 2) { // 1 letra: nada de lista (a dica do campo explica); os resultados de antes saem e o campo fica como está
    if (!termo) { docsLimparBusca(false); return; }
    res.hidden = true; res.innerHTML = ''; conteudo.hidden = false; return;
  }
  const { resumo, html } = docsHtmlBusca(termo);
  res.innerHTML = html; res.hidden = false; conteudo.hidden = true;
  docsAnunciar(resumo);
}
function docsLimparBusca(focar) {
  clearTimeout(DOCS_ESTADO.buscaTimer);
  const campo = docsEl('docs-q'); const res = docsEl('docs-resultados'); const conteudo = docsEl('docs-conteudo');
  if (campo) campo.value = '';
  if (res) { res.hidden = true; res.innerHTML = ''; }
  if (conteudo) conteudo.hidden = false;
  if (focar) campo?.focus?.();
}
function docsSelecionar(el) {
  try { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } catch { /* sem seleção: a mensagem já orienta */ }
}
/** Copiar do bloco de comando: "Copiado" por 2 s e anúncio; se falhar, seleciona o código e explica. */
async function docsCopiar(botao) {
  const bloco = botao.closest?.('.docs-cmd'); const code = bloco?.querySelector('code'); const erro = bloco?.querySelector('.docs-cmd-erro');
  let ok = false;
  try {
    const cb = typeof navigator !== 'undefined' ? navigator.clipboard : null;
    if (cb?.writeText) { await cb.writeText(code?.textContent ?? ''); ok = true; }
  } catch { ok = false; }
  if (!ok) {
    if (code) docsSelecionar(code);
    if (erro) { erro.textContent = DOCS_TEXTOS.copiarFalhou; erro.hidden = false; }
    return false;
  }
  if (erro) erro.hidden = true;
  botao.textContent = DOCS_TEXTOS.copiado; docsAnunciar(DOCS_TEXTOS.comandoCopiado);
  clearTimeout(DOCS_ESTADO.copiar.get(botao));
  DOCS_ESTADO.copiar.set(botao, setTimeout(() => { botao.textContent = DOCS_TEXTOS.copiar; }, 2000));
  return true;
}
/** Redesenha o que mostra o progresso (sumário, botão do Início, caixa "Marcar como lido") depois de uma mudança. */
function docsAtualizarProgresso() {
  const p = DOCS_ESTADO.pagina; if (!p) return;
  const toc = docsEl('docs-toc'); if (toc) toc.innerHTML = `<summary>${docsEsc(docsResumoSumario(p.atual))}</summary>${docsHtmlSumario(p.achou ? p.atual : null, p.secao)}`;
  const cta = docsEl('docs-inicio-cta'); if (cta) cta.innerHTML = docsHtmlInicioCta();
  const caixa = docsEl('docs-lido'); if (caixa) caixa.checked = docsLidos().includes(p.atual);
}
/** Caixa "Marcar como lido" do capítulo aberto. Se não conseguir gravar, a caixa volta ao que está guardado. */
function docsAoMarcar(caixa) {
  const p = DOCS_ESTADO.pagina; if (!p?.atual) return;
  const quer = !!caixa.checked; const ok = docsMarcarLido(p.atual, quer);
  docsAtualizarProgresso();
  if (ok) docsAnunciar((quer ? DOCS_TEXTOS.anuncioLido : DOCS_TEXTOS.anuncioNaoLido)(docsNumero(p.atual)));
}
/**
 * "Próximo" marca o capítulo como lido e avisa. A página seguinte refaz o role=status, então o aviso também fica
 * guardado por alguns segundos para o anúncio dela dizer as duas coisas.
 */
function docsAoAvancar(id) {
  const jaLido = docsLidos().includes(id);
  if (!docsMarcarLido(id) || jaLido) return;
  const msg = DOCS_TEXTOS.anuncioLido(docsNumero(id));
  DOCS_ESTADO.avisoLido = { msg, ate: Date.now() + 3000 };
  docsAnunciar(msg);
}
function docsAoLimparProgresso() {
  const ok = docsLimparProgresso(); docsAtualizarProgresso();
  if (ok) { docsEl('docs-progresso-t')?.focus?.(); docsAnunciar(DOCS_TEXTOS.progressoLimpo); } // o botão sumiu: o foco vai para o resumo
}
/** Cliques da página, por delegação (posto em #pagina.onclick; o ir() de app.js zera ao trocar de página). */
function docsAoClicar(e) {
  const alvo = e?.target;
  const copiar = alvo?.closest?.('[data-docs-copiar]'); if (copiar) { docsCopiar(copiar); return; }
  const lido = alvo?.closest?.('[data-docs-lido]'); if (lido) { docsAoMarcar(lido); return; }
  if (alvo?.closest?.('[data-docs-limpar-progresso]')) { docsAoLimparProgresso(); return; }
  if (alvo?.closest?.('.docs-nav-prox') && DOCS_ESTADO.pagina?.atual) docsAoAvancar(DOCS_ESTADO.pagina.atual); // "Próximo" conta como lido; o link segue
  if (alvo?.closest?.('[data-docs-pular]')) { e.preventDefault(); docsEl('docs-titulo')?.focus?.(); return; }
  if (alvo?.closest?.('[data-docs-sumario]')) {
    const toc = docsEl('docs-toc'); if (toc) { toc.open = true; (toc.querySelector?.('nav a') || toc)?.focus?.(); }
    return;
  }
  if (alvo?.closest?.('[data-docs-limpar]')) { docsLimparBusca(true); return; }
  const resultado = alvo?.closest?.('.docs-resultados-lista a');
  if (resultado) {
    // Resultado que aponta para o endereço atual não dispara hashchange: refaz a página para fechar a busca e levar ao foco da seção.
    const href = resultado.getAttribute?.('href');
    if (typeof href === 'string' && href === location.hash) { e.preventDefault(); paginaDocs(href.slice(1)); } else docsLimparBusca(false);
  }
}
/** Ao sair dos Docs, a aba volta ao título do painel. */
function docsAoMudarEndereco() {
  if (DOCS_ESTADO.tituloOriginal != null && !/^#(docs|ajuda)([/?]|$)/.test(location.hash || '')) document.title = DOCS_ESTADO.tituloOriginal;
}
function docsOuvir() {
  if (DOCS_ESTADO.ouvindo) return; DOCS_ESTADO.ouvindo = true;
  if (typeof addEventListener === 'function') addEventListener('hashchange', docsAoMudarEndereco);
  try {
    if (typeof matchMedia === 'function') matchMedia(DOCS_LARGURA_SUMARIO).addEventListener?.('change', (ev) => { const toc = docsEl('docs-toc'); if (toc) toc.open = ev.matches; });
  } catch { /* sem matchMedia: o sumário fica como foi montado */ }
}

/** Monta a página dos Docs. pedido = o hash sem '#' ('docs', 'docs/<cap>', 'docs/<cap>/<secao>' ou o alias 'ajuda'). */
function paginaDocs(pedido) {
  const pg = docsEl('pagina'); if (!pg) return;
  const T = DOCS_TEXTOS; const { cap, secao } = docsPedido(pedido);
  const capObj = docsCap(cap); const achou = cap === '' || !!capObj;
  const atual = capObj ? cap : ''; const n = docsNumero(atual);
  const secaoOk = capObj && docsSecoes(capObj).some((s) => s.id === secao) ? secao : ''; // seção que não existe abre o capítulo no topo
  const conteudo = !achou ? docsHtmlNaoAchado() : capObj ? docsHtmlCapitulo(cap) + docsHtmlMarcar(cap) + docsHtmlNav(cap) : docsHtmlInicio();
  pg.innerHTML = `<div class="topo docs-topo"><div><h1>${T.titulo}</h1><p class="sub">${T.sub}</p></div>`
    + `<form class="docs-busca" id="docs-busca" role="search"><label for="docs-q">${T.buscaRotulo}</label>`
    + `<div class="docs-busca-linha"><input type="search" id="docs-q" placeholder="${T.buscaPh}" autocomplete="off" aria-describedby="docs-q-dica"><button type="submit">${T.buscar}</button></div>`
    + `<small id="docs-q-dica" class="docs-busca-dica">${T.buscaDica}</small></form></div>`
    + `<div class="docs"><a class="docs-pular" href="${docsHref(atual, secaoOk)}" data-docs-pular>${T.pular}</a>`
    + `<details class="docs-toc" id="docs-toc"${docsLargo() ? ' open' : ''}><summary>${docsEsc(docsResumoSumario(atual))}</summary>${docsHtmlSumario(achou ? atual : null, secaoOk)}</details>`
    + `<div class="docs-principal"><div id="docs-conteudo">${conteudo}</div>`
    + `<section class="card docs-resultados" id="docs-resultados" aria-label="${T.resultadosRotulo}" hidden></section></div></div>`
    + '<p class="sr-only" role="status" id="docs-status"></p>';

  DOCS_ESTADO.pagina = { atual, secao: secaoOk, achou };
  pg.onclick = docsAoClicar;
  const campo = docsEl('docs-q'); const form = docsEl('docs-busca');
  if (campo) {
    campo.oninput = () => { clearTimeout(DOCS_ESTADO.buscaTimer); DOCS_ESTADO.buscaTimer = setTimeout(() => docsMostrarBusca(campo.value), 200); };
    campo.onkeydown = (e) => { if (e.key === 'Escape' && (campo.value || docsEl('docs-resultados')?.hidden === false)) { e.preventDefault(); docsLimparBusca(true); } };
  }
  const res = docsEl('docs-resultados'); // Esc com o foco nos resultados ou em "Limpar busca" também volta ao capítulo (o onkeydown do #pagina vazaria para a próxima tela)
  if (res) res.onkeydown = (e) => { if (e.key === 'Escape' && res.hidden === false) { e.preventDefault(); docsLimparBusca(true); } };
  if (form) form.onsubmit = (e) => { e.preventDefault(); clearTimeout(DOCS_ESTADO.buscaTimer); docsMostrarBusca(campo?.value); };

  docsOuvir();
  if (DOCS_ESTADO.tituloOriginal == null) DOCS_ESTADO.tituloOriginal = document.title;
  const nome = capObj ? docsPlano(capObj.titulo) : '';
  document.title = !achou ? `${T.naoAchadoAba} · ${T.titulo}` : capObj ? `${nome} · ${T.titulo}` : T.titulo;
  // foco no h2 (ou no h3 da seção pedida), rolagem e anúncio da posição na trilha
  const alvo = (secaoOk && docsEl('docs-s-' + secaoOk)) || docsEl('docs-titulo');
  if (secaoOk) alvo?.scrollIntoView?.(); else if (typeof scrollTo === 'function') scrollTo(0, 0);
  alvo?.focus?.({ preventScroll: true });
  const posicao = !achou ? T.naoAchadoAba : !capObj ? T.anuncioInicio : n == null ? T.anuncioApendice(nome) : T.anuncioCap(n, docsNumerados().length, nome);
  const lido = DOCS_ESTADO.avisoLido; DOCS_ESTADO.avisoLido = null; // vale só para a página aberta logo depois do "Próximo"
  docsAnunciar(lido && Date.now() <= lido.ate ? `${lido.msg}. ${posicao}` : posicao);
}
