const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Imita a formatação do WhatsApp na prévia: *negrito*, ~riscado~, _itálico_
const zap = (t) => esc(t).replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>').replace(/~([^~\n]+)~/g, '<s>$1</s>').replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?]|$)/g, '$1<em>$2</em>');
const S = { st: null, tags: [], templates: [], groups: [], rules: [], blocks: [] };
let ultimoQr = null; let editando = null;

// Ações que só o Dono faz (o servidor responde 403 com este texto ao Operador). No lugar do botão escondido, uma dica.
const SO_DONO = 'Só o Dono pode fazer isso.';
const SO_DONO_DICA = { desconectar: 'Só o Dono pode desconectar o WhatsApp.', limpar: 'Só o Dono pode apagar agora o que passou do prazo.' };
// Conferência de preço e estoque antes do envio (spec docs/produto/specs/verificador-preco-estoque.md; plano
// verificador-preco-estoque, etapa 8): cartão de Ajustes e dica de {HORA_PRECO} em Templates. Os textos do Disparo
// manual ficam em TEXTOS_DISPAROS (disparos.js): o mesmo nome de const em dois scripts derrubaria o painel.
const TEXTOS_VERIFICADOR = {
  titulo: 'Conferir preço e estoque antes de enviar',
  chave: 'Conferir antes de cada envio',
  sub: 'Logo antes de enviar, o programa lê o preço e o estoque na loja. Esgotado ou mais caro que o limite: a oferta não sai e o Histórico diz o motivo. Na Amazon do Catálogo, o Etiqueta relê a página do produto na hora. Se essa leitura falhar, vale o último preço visto, desde que tenha até 6 horas; mais velho, a oferta é pulada e outra ocupa a vaga. Nas outras lojas, se a loja não responder, só sai dado de até 30 min.',
  desligado: 'Desligado: as ofertas saem sem conferir preço nem estoque.',
  limite: 'Aceitar alta de preço até (%)',
  limiteDica: '0 = qualquer alta descarta a oferta. Preço que caiu sempre pode sair.',
  salvar: 'Salvar conferência', salvando: 'Salvando…', salvo: 'Conferência salva',
  erroLimite: 'Informe um número inteiro de 0 a 50.',
  horaPreco: '{HORA_PRECO}: a hora em que o preço foi visto na loja, como 14h32 (na hora do envio ou, se a leitura falhou, a do último preço visto). Use dentro de [ ] para a frase sumir quando não houver hora, e não na linha do {LINK}. Ex.: [🕒 Preço visto às {HORA_PRECO}]',
};
// Proteção do número (spec docs/produto/specs/anti-banimento.md; plano docs/produto/planos/anti-banimento.md, etapa 7).
// O cartão de Ajustes, a linha de uso em Números e as frases de erro do cliente, iguais às do servidor (src/ritmo.js).
const TEXTOS_PROTECAO = {
  titulo: 'Proteção do número',
  sub: 'Limites para o WhatsApp não estranhar o seu número. Os valores já vêm num padrão seguro.',
  soDono: 'Só o Dono muda a proteção do número.',
  semLeitura: 'Não consegui ler a proteção do número agora. Recarregue a página em instantes.',
  legendaLimite: 'Quantas mensagens por hora',
  limite: 'Máximo de mensagens por hora',
  limiteDica: 'Cada oferta enviada a um grupo conta como 1 mensagem. Passou do teto, o resto espera e sai assim que houver vaga.',
  usoAria: 'Mensagens enviadas na última hora',
  usoSemLeitura: 'Na última hora: sem leitura ainda.',
  legendaSilencio: 'Horário de silêncio',
  chave: 'Não enviar de madrugada',
  das: 'Das', ate: 'Até',
  silencioDica: 'Neste horário nada é enviado aos grupos. O disparo por intervalo e o envio “agora” esperam o fim do silêncio; o que tem hora marcada dentro dele é pulado e avisado no Histórico.',
  desligado: 'Desligado: o programa envia a qualquer hora, dentro do horário de cada disparo.',
  legendaPausas: 'Pausas entre mensagens',
  pausaGrupo: 'Entre um grupo e outro (segundos)',
  pausaOferta: 'Entre uma oferta e a próxima (segundos)',
  salvar: 'Salvar proteção do número', salvando: 'Salvando…', salvo: 'Proteção do número salva',
  numerosSub: 'Este número envia as ofertas. Para protegê-lo, use os <a href="#ajustes">limites e as pausas</a> de Ajustes e prefira um número de que você não dependa.',
  chipReserva: 'Tenha um segundo chip de reserva, com WhatsApp Business instalado, e deixe esse número também dentro dos seus grupos. Se este número for restringido, você o conecta aqui em Números e continua enviando.',
  funcionaDas: 'Vale só para este disparo. O horário de silêncio de <a href="#ajustes" target="_blank" rel="noopener">Ajustes (abre em nova aba)</a> vale para todos.',
  faixa: (min, max) => `Na prática: de ${min} a ${max} segundos, escolhido ao acaso a cada vez.`,
  usoNormal: (u, l) => `Na última hora: ${u} de ${l}`,
  usoPerto: (u, l) => `Na última hora: ${u} de ${l}. Perto do limite.`,
  usoSemTeto: (u) => `Na última hora: ${u} ${u === 1 ? 'mensagem' : 'mensagens'}. Sem limite por hora.`,
  usoNumeros: (u, l) => `Na última hora: ${u} de ${l} mensagens.`,
  usoNumerosPerto: (u, l) => `Na última hora: ${u} de ${l} mensagens. Perto do limite.`,
  usoNumerosSemTeto: (u) => `Na última hora: ${u} ${u === 1 ? 'mensagem' : 'mensagens'}. Sem limite por hora.`,
  mudar: 'Mudar em Ajustes',
  tetoTitulo: (u, l) => `Limite atingido (${u} de ${l} na última hora).`,
  tetoCorpo: (hh) => `As próximas mensagens ficam na fila e saem a partir das ${hh}. Nada sai duas vezes.`,
  tetoCorpoSemHora: 'As próximas mensagens ficam na fila e saem assim que houver vaga. Nada sai duas vezes.',
  silencioAgora: (hh) => `Horário de silêncio: nada é enviado até as ${hh}.`,
  erroInteiro: (min, max) => `Use um número inteiro de ${min} a ${max}.`,
  erroIguais: 'Escolha dois horários diferentes.',
  erroHora: 'Use um horário no formato HH:MM, de 00:00 a 23:59.',
};
async function api(path, method = 'GET', body) {
  const r = await fetch('/api' + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { location.replace('/login.html'); throw new Error('Sessão expirada. Entre de novo.'); }
  if (r.status === 403 && (!j.erro || j.erro === SO_DONO)) {
    // Perdeu a permissão (o Dono mudou o papel desta pessoa): avisa e redesenha o menu e a tela com o papel atual.
    aviso(SO_DONO, true);
    if (path !== '/state') atualizarEstado().catch(() => {});
    throw new Error(SO_DONO);
  }
  // campo/fonte: o 400 da fonte Catálogo diz qual campo de qual fonte recusou (o formulário marca o campo)
  if (!r.ok) throw Object.assign(new Error(j.erro || 'Erro ' + r.status), { status: r.status, campo: typeof j.campo === 'string' ? j.campo : null, fonte: Number.isInteger(j.fonte) ? j.fonte : null });
  return j;
}
function aviso(msg, erro = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'mostra' + (erro ? ' erro' : '');
  clearTimeout(aviso.t); aviso.t = setTimeout(() => (t.className = ''), erro ? 6000 : 2500);
}
const tentar = (fn) => async (...a) => { try { await fn(...a); } catch (e) { aviso(e.message, true); } };
// Campo obrigatório: asterisco vermelho ao lado do rótulo.
const REQ = '<b class="req" title="Obrigatório">*</b>';
/**
 * Mostra, antes do rodapé do formulário (ou no fim do contêiner), um card com o que falta e marca os campos.
 * erros = [{ msg, el? }]; `titulo` é a frase em negrito do card (padrão "Antes de salvar, falta:").
 * Devolve true se havia erros (então não salve).
 */
function mostrarErros(container, erros, titulo = 'Antes de salvar, falta:') {
  $$('.invalido', container).forEach((e) => e.classList.remove('invalido'));
  let box = $('.erros', container);
  if (!erros.length) { box?.remove(); return false; }
  if (!box) { box = document.createElement('div'); box.className = 'erros'; box.setAttribute('role', 'alert'); const rod = $('.rodape', container); rod ? rod.parentNode.insertBefore(box, rod) : container.appendChild(box); }
  box.innerHTML = `<b>${esc(titulo)}</b><ul>${erros.map((e) => `<li>${esc(e.msg)}</li>`).join('')}</ul>`;
  erros.forEach((e) => e.el?.classList.add('invalido'));
  (erros.find((e) => e.el)?.el || box).scrollIntoView({ block: 'center', behavior: 'smooth' });
  erros.find((e) => e.el)?.el?.focus?.();
  return true;
}
const hora = (ms) => new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

async function carregar() {
  [S.st, S.tags, S.templates, S.groups, S.rules, S.blocks] = await Promise.all([
    api('/state'), api('/tags'), api('/templates'), api('/groups'), api('/rules'), api('/blocks')]);
}

// ---------- faixa de status ----------
function faixa() {
  const w = S.st.whatsapp; const e = S.st.extensao;
  const wTxt = { open: 'WhatsApp conectado', qr: 'WhatsApp aguardando leitura do QR', connecting: 'WhatsApp conectando…', idle: 'WhatsApp desconectado' }[w.status];
  const wCls = w.status === 'open' ? 'ok' : w.status === 'idle' ? '' : 'espera';
  const modo = S.st.ajustes.link_mode;
  $('#faixa').innerHTML =
    (S.st.simulacao ? '<span class="pilula sim">Modo simulação: nada é enviado de verdade</span>' : '') +
    `<span class="pilula ${wCls}"><i></i>${wTxt}</span>` +
    (modo === 'direct' ? '<span class="pilula espera"><i></i>Links sem etiqueta (modo direto)</span>'
      : `<span class="pilula ${e.online ? 'ok' : ''}"><i></i>${e.online ? 'Extensão do Chrome conectada' : 'Extensão do Chrome desconectada'}</span>`) +
    (S.st.propostas_pendentes ? `<a href="#links" class="pilula espera" style="text-decoration:none"><i></i>${S.st.propostas_pendentes} ${S.st.propostas_pendentes === 1 ? 'proposta de grupo novo' : 'propostas de grupo novo'}</a>` : '');
}

// ---------- regras ----------
function proximo(r) {
  if (r.em_andamento) return 'Enviando agora…';
  if (!r.enabled) return 'Pausado';
  if (!r.next_run_at) return 'Começa no próximo ciclo (até 15 s)';
  const d = r.next_run_at - Date.now();
  if (d <= 0) return 'Enviando em instantes';
  if (d < 120 * 60000) return `Próximo envio em ${Math.max(1, Math.round(d / 60000))} min`;
  return 'Próximo envio ' + new Date(r.next_run_at).toLocaleString('pt-BR', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}
function cartaoRegra(r) {
  const tag = S.tags.find((t) => t.id === r.tag_id); const tpl = S.templates.find((t) => t.id === r.template_id);
  const lista = r.sources?.length ? r.sources : [{ type: r.source_type, config: r.source_config }]; const fontes = lista.map(resumoFonte);
  const fonte = fontes.length === 1 ? fontes[0] : `${fontes.length} fontes intercaladas (${fontes.join('; ')})`;
  const cat = lista.some((f) => f?.type === 'catalogo') ? fcatCartao(r) : { chips: '', prox: '' }; // revisão e "Catálogo indisponível"
  const g = r.grade ? gradeCartao(r) : null; // horários marcados (grade.js); sem grade, o cartão de sempre
  return `<article class="card regra" data-id="${r.id}">
    <h2><label class="chave" title="Ligar ou pausar"><input type="checkbox" data-act="ligar" ${r.enabled ? 'checked' : ''} aria-label="Disparo automático ativo"><span></span></label>
      ${esc(r.name)} ${tag ? `<span class="chip etq">${esc(tag.name)}</span>` : '<span class="chip">sem etiqueta</span>'}${g ? g.chip : ''}${cat.chips}</h2>
    <p class="res">${g ? g.res : `${r.per_run} ${r.per_run === 1 ? 'oferta' : 'ofertas'} a cada ${r.interval_min} min, das ${esc(r.window_start)} às ${esc(r.window_end)}, para ${r.group_jids.length} ${r.group_jids.length === 1 ? 'grupo' : 'grupos'}.`}
      Fonte: ${fonte}. ${g ? g.tpls : `Template: ${esc(tpl?.name || '—')}.`}</p>
    <div class="prox">${g ? g.prox : proximo(r)}</div>${cat.prox}
    <div class="acoes">
      <button class="pri" data-act="rodar" ${r.em_andamento ? 'disabled' : ''}>Enviar agora</button>
      <button data-act="ver">Ver ofertas</button><button data-act="editar">Editar</button>
      <button data-act="zerar" class="leve" title="Permite que as ofertas já enviadas saiam de novo">Limpar “já enviadas”</button>
      <button data-act="excluir" class="perigo leve">Excluir</button></div></article>`;
}
const resumoFonte = (f) => (f.type === 'afiliados' ? fonteAfiliados(f.config) : f.type === 'catalogo' ? fonteCatalogo(f.config)
  : f.type === 'search' ? `busca por “${esc(f.config?.query || '')}”` : `${String(f.config?.items || '').split('\n').filter((l) => /^https?:/i.test(l.trim())).length} links na lista`)
  + (f.tag_id && fcatPrecisaEtiqueta([f]) && S.tags.find((t) => t.id === f.tag_id) ? ` · etiqueta ${esc(S.tags.find((t) => t.id === f.tag_id).name)}` : '');
const categoriasDe = (c = {}) => Array.isArray(c.categorias) ? c.categorias : c.categoria ? [c.categoria] : [];
function fonteAfiliados(c = {}) {
  const nomes = categoriasDe(c).map((id) => S.st.afiliados?.categorias.find((x) => x.id === id)?.name).filter(Boolean);
  const cats = nomes.length > 3 ? `${nomes.length} categorias` : nomes.map(esc).join(' + ');
  const partes = [c.busca ? `“${esc(c.busca)}”` : '', cats, c.mais_vendidos ? 'mais vendidos' : '', c.ganhos_extras ? 'ganhos extras' : ''].filter(Boolean);
  return `Central de Afiliados${partes.length ? ' (' + partes.join(', ') + ')' : ''}`;
}
// ---------- fonte "Catálogo" (app Etiqueta) no Disparo automático ----------
// Spec: docs/produto/specs/fonte-catalogo-etiqueta.md, seção 2. As categorias vêm de GET /api/catalogo/categorias (as da
// última verificação em Conexões: abrir o formulário não chama o Etiqueta). Nome de categoria e busca são texto de
// fora: sempre por esc(). Os textos com <a> abaixo são fixos (nenhum dado de fora entra neles).
const TEXTOS_REGRA_CATALOGO = {
  opcao: 'Catálogo (app Etiqueta)', resumo: 'Catálogo do Etiqueta',
  categorias: 'Categorias do Etiqueta', marcadas: (n) => (n ? `(${n} ${n === 1 ? 'marcada' : 'marcadas'})` : '(todas)'),
  catDica: 'Nenhuma marcada = todas as categorias. Com várias, vale qualquer uma delas. A lista é a da última vez que você clicou em “Testar” em Conexões; abrir esta tela não atualiza.',
  catVazia: 'As categorias aparecem depois que o catálogo for conectado e testado em Conexões.', catCarregando: 'Carregando as categorias…',
  catSumiu: '(não está mais no catálogo)', catZero: '(0 ofertas)', catMax: 'Você pode marcar até 20 categorias.',
  lojas: 'Lojas', lojasDica: 'Nenhuma marcada = as três lojas.', nomesLoja: { ml: 'Mercado Livre', amazon: 'Amazon', shopee: 'Shopee' },
  busca: 'Buscar por (opcional)', buscaDica: 'Palavras separadas por vírgula (até 10). Basta uma aparecer no título; não diferencia maiúscula nem acento. Ex.: air fryer, fritadeira.',
  desconto: 'Desconto mínimo no catálogo (%)',
  descontoDica: 'De 0 a 99. Vazio = sem mínimo. Vale só para esta fonte; o “Desconto mínimo (%)” em Filtros é o filtro geral do disparo e vale para todas as fontes. Ofertas com 100% de desconto sempre esperam a sua revisão (veja abaixo).',
  ordem: 'Ordem',
  // [valor, opção do select, como aparece no resumo do cartão]
  ordens: [
    ['atualizacao', 'Novidades (após salvar)', 'novidades'], ['relevancia', 'Mais vendidos', 'mais vendidos'],
    ['desconto', 'Maior desconto', 'maior desconto'], ['menor_preco', 'Menor preço', 'menor preço'], ['maior_preco', 'Maior preço', 'maior preço'],
    ['cupom', 'Com cupom primeiro', 'com cupom primeiro'], ['recentes', 'Coletadas há menos tempo', 'coletadas há menos tempo'],
  ],
  ordemNovidades: 'Começa a contar quando você salva: envia o que chegar ou for atualizado no catálogo depois disso (uma nova coleta do Etiqueta conta); a mesma oferta nunca sai duas vezes neste disparo. Para mandar o que já existe, use outra ordem ou “Reler do começo”.',
  ordemOutras: 'Cada envio pega as melhores que ainda não foram enviadas dentro do prazo de repetição.',
  etiquetaComum: 'Etiqueta ML desta fonte', etiquetaFonte: 'Etiqueta ML desta fonte',
  etiquetaNaoSeAplica: 'Não se aplica: os links da Amazon e da Shopee já vêm prontos do catálogo.',
  conexao: 'O catálogo ainda não está conectado. Conecte em <a href="#conexoes" target="_blank" rel="noopener" style="text-decoration:underline">Conexões</a> e use “Testar” para ver as categorias.',
  conexaoIndisp: (selo) => `O catálogo está indisponível agora (${selo}). Você pode salvar esta fonte; ela volta a enviar quando o Etiqueta responder.`,
  selos: { indisponivel: 'Indisponível', token_recusado: 'Token recusado' },
  semML: 'Esta fonte não precisa de etiqueta do Mercado Livre. Se todas as fontes do disparo forem assim, a etiqueta ML padrão fica opcional.',
  comShopee: 'Toda oferta da Shopee espera a sua revisão antes de sair: o link curto da Shopee não prova de quem é a conta. Elas aparecem em Histórico &gt; Catálogo, com o botão “Revisar”.',
  comML: 'Os links do Mercado Livre são gerados de novo, com a etiqueta escolhida acima, pela extensão do Chrome. Com a extensão desligada, essas ofertas esperam e saem sozinhas quando ela voltar; não vão para a revisão.',
  revisao: 'Ofertas com 100% de desconto, com preço antigo 10 vezes maior que o preço ou cujo link falhe ao ser gerado também esperam a sua revisão. Nada disso sai sozinho.',
  amazonTag: 'Amazon: o link é montado com a sua tag de Conexões.',
  amazonSemTag: 'Falta a tag da Amazon. Salve em <a href="#conexoes" target="_blank" rel="noopener" style="text-decoration:underline">Conexões &gt; Amazon</a>; sem ela, as ofertas da Amazon esperam.',
  padraoObrigatoria: 'Etiqueta ML padrão', padraoOpcional: 'Etiqueta ML padrão', padraoNaoPrecisa: 'Não precisa: as fontes deste disparo só trazem Amazon e Shopee.',
  reler: 'Reler do começo', relerTitulo: 'Reler o catálogo desde o começo no próximo envio',
  relerDica: 'Use para mandar o que já estava no catálogo antes de você salvar a regra, ou depois de reorganizar as categorias no Etiqueta.',
  relerConfirma: 'Na próxima vez, o painel confere o catálogo inteiro de novo, em todas as fontes Catálogo deste disparo. Ofertas já tratadas não são repetidas. Continuar?',
  relerOk: 'Releitura marcada para o próximo envio.', relerFalhou: 'Não consegui marcar a releitura. Tente de novo.',
  erroQ: 'Buscar por: até 200 caracteres e 10 palavras, separadas por vírgula, sem palavra vazia.',
  erroDesconto: 'Desconto mínimo: número inteiro de 0 a 99.', erroCats: 'Escolha no máximo 20 categorias.',
  chipRevisar: (n) => `${n} para revisar`, chipRevisarTitulo: 'Ver no Histórico as ofertas do catálogo que esperam a sua revisão',
  chipCheia: (n) => `Revisão cheia (${n})`, cheiaProx: (n) => `${n} ofertas esperam revisão. As novas esperam até você revisar ou descartar.`,
  chipIndisp: '! Catálogo indisponível', indispProx: (h) => `Catálogo indisponível desde ${h}. As outras fontes seguem.`,
  esperariaRevisao: 'Esperaria revisão',
  // prévia ("Ver ofertas") de fonte Novidades que ainda não marcou o ponto de partida (`primeira_leitura` do servidor)
  primeiraLeitura: 'Primeira leitura: o disparo marca o ponto de partida na primeira execução; a prévia ainda não tem ofertas.',
  primeiraLeituraOutras: 'Primeira leitura do catálogo: o disparo marca o ponto de partida na primeira execução; por isso a prévia ainda não traz ofertas do catálogo.',
};
const FCAT_LOJAS = ['ml', 'amazon', 'shopee'];
const FCAT_MAX_CATS = 20;
// Seletor do campo que o servidor recusou (400 com `campo`, src/catalogo.js ERROS_FONTE), dentro da fonte.
const FCAT_CAMPOS = { categorias: '.fc-cats', categoria: '.fc-cats', lojas: '.fc-lojas', q: '[name=cat_q]', desconto_min: '[name=cat_desc]', ordem: '[name=cat_ordem]' };
// Categorias da última verificação, lidas ao abrir o formulário (null = ainda carregando).
const FCAT = { lista: null };

/** A regra precisa da etiqueta do Mercado Livre? A mesma regra do servidor (precisaEtiqueta, src/catalogo.js, D8). */
function fcatPrecisaEtiqueta(fontes) {
  if (!Array.isArray(fontes) || !fontes.length) return true;
  return fontes.some((s) => {
    if (s?.type !== 'catalogo') return true;
    const lojas = s.config?.lojas;
    return !Array.isArray(lojas) || !lojas.length || lojas.includes('ml');
  });
}
const fcatNum = (n) => Number(n || 0).toLocaleString('pt-BR');
/** Ofertas da categoria nas lojas marcadas (nenhuma = todas). */
const fcatTotal = (c, lojas) => (lojas.length ? lojas.reduce((s, l) => s + (Number(c?.lojas?.[l]) || 0), 0) : Number(c?.total) || 0);
/** Total por loja nas categorias marcadas (nenhuma = todas). */
function fcatTotaisLojas(lista, marcadas) {
  const cats = (lista || []).filter((c) => !marcadas.length || marcadas.includes(c.nome));
  return Object.fromEntries(FCAT_LOJAS.map((l) => [l, cats.reduce((s, c) => s + (Number(c.lojas?.[l]) || 0), 0)]));
}
/** "às 14:32" de hoje, ou "03/11 14:32". */
function fcatHora(ms) {
  const d = new Date(ms); const hm = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? hm : `${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} ${hm}`;
}
/** Resumo da fonte no cartão da regra: "Catálogo do Etiqueta (Perfumes + 2 categorias, Amazon + Shopee, “air fryer”, …)". */
function fonteCatalogo(c = {}) {
  const T = TEXTOS_REGRA_CATALOGO; const cats = Array.isArray(c.categorias) ? c.categorias : []; const resto = cats.length - 1;
  const catsTxt = !cats.length ? '' : cats.length > 3 ? `${cats.length} categorias` : `${esc(cats[0])}${resto ? ` + ${resto} ${resto === 1 ? 'categoria' : 'categorias'}` : ''}`;
  const lojas = FCAT_LOJAS.filter((l) => Array.isArray(c.lojas) && c.lojas.includes(l)).map((l) => T.nomesLoja[l]).join(' + ');
  const desc = c.desconto_min != null && c.desconto_min !== '' && Number.isFinite(Number(c.desconto_min)) ? `desconto a partir de ${Number(c.desconto_min)}%` : '';
  const ordem = T.ordens.find(([id]) => id === (c.ordem || 'atualizacao'))?.[2] || '';
  const partes = [catsTxt, lojas, c.q ? `“${esc(c.q)}”` : '', desc, ordem].filter(Boolean);
  return `${T.resumo}${partes.length ? ' (' + partes.join(', ') + ')' : ''}`;
}
/**
 * Caixas das categorias. `lista` = categorias do servidor (null = carregando); `marcadas` = nomes marcados; `lojas` = ids
 * marcados (os totais são os dessas lojas; categoria com 0 fica desabilitada). Marcada que não está mais na lista
 * continua marcada, com o aviso; com 20 marcadas, as outras ficam desabilitadas.
 */
function fcatCatsHtml(lista, marcadas, lojas) {
  const T = TEXTOS_REGRA_CATALOGO; const sel = new Set(marcadas); const nomes = new Set((lista || []).map((c) => c.nome));
  const cheio = sel.size >= FCAT_MAX_CATS;
  const caixa = (nome, extra, zero) => `<label title="${esc(nome)}"><input type="checkbox" value="${esc(nome)}" ${sel.has(nome) ? 'checked' : ''} ${zero ? 'data-zero' : ''} ${!sel.has(nome) && (zero || cheio) ? 'disabled' : ''}><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(nome)}</span><small>${extra}</small></label>`;
  const daLista = (lista || []).map((c) => { const n = fcatTotal(c, lojas); return caixa(c.nome, n ? `(${fcatNum(n)})` : T.catZero, n === 0); });
  const sumidas = [...sel].filter((n) => !nomes.has(n)).map((n) => caixa(n, lista?.length ? T.catSumiu : '', false));
  const aviso = lista == null ? T.catCarregando : !lista.length ? T.catVazia : '';
  return (aviso ? `<p class="dica" style="margin:0;padding:7px 12px">${aviso}</p>` : '') + daLista.join('') + sumidas.join('');
}
/** Aviso de conexão do catálogo (A0): só quando não está "conectada". */
function fcatConexaoHtml(cat = {}) {
  const T = TEXTOS_REGRA_CATALOGO;
  if (cat.estado === 'conectada') return '';
  const selo = Object.hasOwn(T.selos, cat.estado || '') ? T.selos[cat.estado] : '';
  return `<div class="aviso-impl" role="status"><p>${selo ? esc(T.conexaoIndisp(selo)) : T.conexao}</p></div>`;
}
/** Avisos A1 a A5 para as lojas marcadas (nenhuma = as três). `tagAmazon`: há tag da Amazon salva em Conexões. */
function fcatAvisosHtml(lojas, tagAmazon) {
  const T = TEXTOS_REGRA_CATALOGO; const tem = (l) => !lojas.length || lojas.includes(l);
  return [
    lojas.length && !lojas.includes('ml') ? `<div class="aviso-impl neutro"><p>${T.semML}</p></div>` : '',
    tem('shopee') ? `<div class="aviso-impl"><p>${T.comShopee}</p></div>` : '',
    tem('ml') ? `<div class="aviso-impl neutro"><p>${T.comML}</p></div>` : '',
    tem('amazon') ? (tagAmazon ? `<small class="dica">${T.amazonTag}</small>` : `<div class="aviso-impl"><p>${T.amazonSemTag}</p></div>`) : '',
    `<small class="dica">${T.revisao} ${q('fonte.catalogo.revisao')}</small>`,
  ].filter(Boolean).join('');
}
/** O que o servidor recusaria na config da fonte (as mesmas regras de limparFonteCatalogo). → [{ msg, campo }] */
function fcatErros(c = {}) {
  const T = TEXTOS_REGRA_CATALOGO; const erros = [];
  if ((c.categorias || []).length > FCAT_MAX_CATS) erros.push({ msg: T.erroCats, campo: 'categorias' });
  const q = String(c.q ?? '');
  if (q.trim()) { const termos = q.trim().split(','); if ([...q.trim()].length > 200 || termos.length > 10 || termos.some((t) => !t.trim())) erros.push({ msg: T.erroQ, campo: 'q' }); }
  const d = c.desconto_min;
  if (d != null && !(Number.isInteger(d) && d >= 0 && d <= 99)) erros.push({ msg: T.erroDesconto, campo: 'desconto_min' });
  return erros;
}
/** Config da fonte catálogo lida do bloco `.f-catalogo` de uma fonte. Desconto que não é inteiro fica como veio (fcatErros recusa). */
function fcatLerConfig(el) {
  const v = (n) => $(`[name=${n}]`, el)?.value ?? ''; const d = String(v('cat_desc')).trim();
  return {
    categorias: $$('.fc-cats input:checked', el).map((c) => c.value), lojas: $$('.fc-lojas input:checked', el).map((c) => c.value),
    q: String(v('cat_q')).trim(), desconto_min: d === '' ? null : /^\d{1,2}$/.test(d) ? Number(d) : d, ordem: v('cat_ordem') || 'atualizacao',
  };
}
/** Refaz as caixas das categorias (com os totais das lojas marcadas), mantendo as marcadas. */
function fcatPintarCats(el) {
  const box = $('.fc-cats', el); if (!box) return;
  box.innerHTML = fcatCatsHtml(FCAT.lista, $$('input:checked', box).map((c) => c.value), $$('.fc-lojas input:checked', el).map((c) => c.value));
}
/** Atualiza no lugar o que depende das escolhas: contagem, limite de 20, totais por loja, etiqueta da fonte, avisos e dica da ordem. */
function fcatAtualizar(el) {
  const T = TEXTOS_REGRA_CATALOGO; if (!$('.f-catalogo', el)) return;
  const ehCat = $(`input[name=st${el.dataset.i}]:checked`, el)?.value === 'catalogo';
  const lojas = $$('.fc-lojas input:checked', el).map((c) => c.value);
  const caixas = $$('.fc-cats input', el); const marcadas = caixas.filter((c) => c.checked).map((c) => c.value);
  const cheio = marcadas.length >= FCAT_MAX_CATS;
  caixas.forEach((c) => { c.disabled = !c.checked && (cheio || c.hasAttribute('data-zero')); });
  $('.fc-cont', el).textContent = T.marcadas(marcadas.length);
  const max = $('.fc-max', el); max.textContent = cheio ? T.catMax : ''; max.hidden = !cheio;
  const tot = fcatTotaisLojas(FCAT.lista, marcadas);
  $$('[data-total]', el).forEach((s) => { s.textContent = FCAT.lista?.length ? `(${fcatNum(tot[s.dataset.total])})` : ''; });
  const ordem = $('[name=cat_ordem]', el)?.value; const dica = $('.fc-ordem-dica', el);
  if (dica) dica.textContent = ordem === 'atualizacao' ? T.ordemNovidades : T.ordemOutras;
  const naoSeAplica = ehCat && lojas.length > 0 && !lojas.includes('ml');
  $('.src-tag-rot', el).textContent = ehCat ? T.etiquetaFonte : T.etiquetaComum;
  $('[name=src_tag]', el).disabled = naoSeAplica; $('.src-tag-na', el).hidden = !naoSeAplica;
  const cat = S.st?.catalogo || {};
  $('.fc-conexao', el).innerHTML = fcatConexaoHtml(cat);
  $('.fc-avisos', el).innerHTML = fcatAvisosHtml(lojas, !!cat.tag_amazon);
}
/** Chips e linhas `.prox` do cartão da regra com fonte Catálogo, de /api/state.catalogo. */
function fcatCartao(r) {
  const T = TEXTOS_REGRA_CATALOGO; const c = S.st?.catalogo || {};
  const info = (Array.isArray(c.regras) ? c.regras : []).find((x) => x.rule_id === r.id) || {};
  const n = Number(info.para_revisar) || 0; const teto = Number(c.teto_revisao) || 50;
  const chips = [
    n > 0 && podeEquipe() ? `<a class="chip chip-link chip-toque" href="#historico?tipo=catalogo&amp;regra=${Number(r.id)}&amp;status=revisao" title="${T.chipRevisarTitulo}">${T.chipRevisar(n)}</a>` : '',
    info.cheia ? `<span class="venc-aviso">${T.chipCheia(teto)}</span>` : '',
    c.falha_desde ? `<span class="venc-aviso">${T.chipIndisp}</span>` : '',
  ].filter(Boolean);
  const prox = [info.cheia ? T.cheiaProx(teto) : '', c.falha_desde ? T.indispProx(fcatHora(c.falha_desde)) : ''].filter(Boolean);
  return { chips: chips.length ? ' ' + chips.join(' ') : '', prox: prox.map((p) => `<div class="prox">${esc(p)}</div>`).join('') };
}
function paginaRegras() {
  $('#pagina').innerHTML = `<div class="topo"><div><h1>Disparo automático ${q('regras')}</h1>
    <p class="sub">Antes chamado de Regras. Cada disparo automático escolhe uma etiqueta, os grupos, o template e o ritmo. Pode ter quantos quiser. ${TEXTOS_REMETENTE.subRegras}</p></div>
    <div class="linha"><button class="pri" id="nova">Novo disparo automático</button><button id="novo-esp">${TEXTOS_ESPELHAMENTO.novo}</button>${q('espelhamento')}${podeEquipe() ? `<button id="novo-rem">${TEXTOS_REMETENTE.novo}</button>${q('remetente')}` : ''}</div></div><div id="lista"></div>`;
  $('#nova').onclick = () => formRegra();
  $('#novo-esp').onclick = () => formEspelhamento();
  if (podeEquipe()) $('#novo-rem').onclick = () => formRemetente(); // remetente: só o Dono cria (o servidor também recusa)
  listaRegras();
  carregarEspelhos().then(listaRegras); // os espelhamentos chegam depois; se a rota falhar, a lista mostra o aviso e as regras seguem
  carregarRemetentes().then(listaRegras); // idem para os remetentes (remetentes.js)
  $('#lista').onclick = tentar(async (ev) => {
    const b = ev.target.closest('[data-act]'); if (!b) return;
    if (b.dataset.act.startsWith('esp-')) return espelhamentoAcao(b);
    if (b.dataset.act.startsWith('rem-')) return remetenteAcao(b);
    const id = Number(b.closest('[data-id]').dataset.id); const r = S.rules.find((x) => x.id === id); const act = b.dataset.act;
    if (act === 'ligar') { await api(`/rules/${id}/enabled`, 'POST', { enabled: b.checked }); aviso(b.checked ? 'Disparo automático ligado' : 'Disparo automático pausado'); await recarregarRegras(); }
    if (act === 'rodar') { await api(`/rules/${id}/run`, 'POST'); aviso('Envio iniciado. Acompanhe no Histórico.'); setTimeout(recarregarRegras, 800); }
    if (act === 'editar') formRegra(r);
    if (act === 'ver') verOfertas(r);
    if (act === 'zerar' && confirm('Limpar a lista de ofertas já enviadas deste disparo automático?')) { await api(`/rules/${id}/reset-sent`, 'POST'); aviso('Lista limpa'); }
    if (act === 'excluir' && confirm(`Excluir o disparo automático “${r.name}”?`)) { await api(`/rules/${id}`, 'DELETE'); await recarregarRegras(); }
  });
}
function listaRegras() {
  const el = $('#lista'); if (!el) return;
  // lista mista: os disparos automáticos e, depois, os espelhamentos (espelhamento.js) e os remetentes (remetentes.js)
  const vazio = !S.rules.length && !ESP.lista.length && !REM.lista.length;
  el.innerHTML = S.rules.map(cartaoRegra).join('') + cartoesEspelhamento() + cartoesRemetentes()
    + (vazio ? '<div class="vazio">Nenhum disparo automático ainda. Cadastre uma etiqueta em <a href="#conexoes">Conexões</a>, conecte o WhatsApp em <a href="#numeros">Números de WhatsApp</a> e crie o primeiro.</div>' : '');
}
async function recarregarRegras() { S.rules = await api('/rules'); await Promise.all([carregarEspelhos(), carregarRemetentes()]); listaRegras(); }

function opcoes(lista, sel, vazio) {
  return (vazio ? `<option value="">${vazio}</option>` : '') + lista.map((o) => `<option value="${o.id}" ${o.id === sel ? 'selected' : ''}>${esc(o.name)}</option>`).join('');
}
/** Lista de grupos (#gr) com busca (#busca) e o botão "Só marcados" (#so-marcados); com `prefixo`, #<prefixo>gr etc. Devolve a função que reaplica o filtro. */
function filtroGrupos(dlg, conta, prefixo = '') {
  const busca = $(`#${prefixo}busca`, dlg); const so = $(`#${prefixo}so-marcados`, dlg);
  const aplica = () => {
    const q = (busca?.value || '').toLowerCase(); const soMarcados = so?.getAttribute('aria-pressed') === 'true';
    let n = 0;
    $$(`#${prefixo}gr label`, dlg).forEach((l) => { const marcado = $('input', l).checked; if (marcado) n++; l.hidden = !l.dataset.n.includes(q) || (soMarcados && !marcado); });
    if (so) { so.textContent = `Só marcados (${n})`; so.classList.toggle('on', soMarcados); }
    conta();
  };
  if (busca) busca.oninput = aplica;
  if (so) so.onclick = () => { so.setAttribute('aria-pressed', so.getAttribute('aria-pressed') === 'true' ? 'false' : 'true'); aplica(); };
  $(`#${prefixo}gr`, dlg).onchange = aplica; aplica();
  return aplica;
}
/**
 * Seletor de grupos reutilizável (Disparo automático, Blocos, Disparo manual, Disparar mensagem): busca,
 * "Só marcados", "Marcar visíveis", "Limpar" e, se pedido, o atalho "Marcar um bloco…".
 * opts = { selecionados: [jid], blocos: bool, marcarVisiveis: bool (padrão true), prefixo: string (padrão ''),
 *   rotuloBusca: string (padrão 'Buscar grupo') }.
 * `prefixo` põe um prefixo nos ids (`${prefixo}gr`, `${prefixo}busca`, `${prefixo}so-marcados`, `${prefixo}todos`,
 * `${prefixo}nenhum`, `${prefixo}bloco-atalho`) para dois seletores caberem no mesmo diálogo; vazio = ids de sempre.
 * Devolve { html, ligar(raiz, { contador, aoMudar, aoBloco }) → reaplica o filtro, marcados(raiz) → [jid] }.
 * Use um seletor por tela ou diálogo: as consultas valem dentro de `raiz`.
 */
function seletorGrupos(opts = {}) {
  const sel = new Set(opts.selecionados || []);
  const P = opts.prefixo || ''; const rotuloBusca = opts.rotuloBusca || 'Buscar grupo';
  const html = !S.groups.length
    ? '<div class="dica">Nenhum grupo carregado. Conecte o WhatsApp em <a href="#numeros" target="_blank" rel="noopener">Números de WhatsApp</a>.</div>'
    : `<div class="linha">${opts.blocos && S.blocks?.length ? `<select id="${P}bloco-atalho" style="width:auto" aria-label="Marcar os grupos de um bloco"><option value="">Marcar um bloco…</option>${S.blocks.map((b) => `<option value="${b.id}">${esc(b.name)} (${b.group_jids.length})</option>`).join('')}</select>` : ''}<input id="${P}busca" placeholder="Buscar grupo…" aria-label="${esc(rotuloBusca)}" style="flex:1 1 180px;min-width:160px"><button type="button" id="${P}so-marcados" class="alt" aria-pressed="false" title="Mostrar só os grupos marcados, para conferir e desmarcar">Só marcados</button>${opts.marcarVisiveis === false ? '' : `<button type="button" id="${P}todos">Marcar visíveis</button>`}<button type="button" id="${P}nenhum">Limpar</button></div>
      <div class="grupos" id="${P}gr">${S.groups.map((g) => `<label data-n="${esc(g.name.toLowerCase())}"><input type="checkbox" value="${esc(g.jid)}" ${sel.has(g.jid) ? 'checked' : ''}>${esc(g.name)}<small>${g.size ?? ''}</small></label>`).join('')}</div>`;
  const marcados = (raiz) => $$(`#${P}gr input:checked`, raiz).map((i) => i.value);
  const ligar = (raiz, { contador, aoMudar, aoBloco } = {}) => {
    if (!$(`#${P}gr`, raiz)) return () => {};
    const aplica = filtroGrupos(raiz, () => { const n = marcados(raiz).length; if (contador) contador.textContent = `(${n} ${n === 1 ? 'selecionado' : 'selecionados'})`; aoMudar?.(n); }, P);
    const todos = $(`#${P}todos`, raiz);
    if (todos) todos.onclick = () => { $$(`#${P}gr label:not([hidden]) input`, raiz).forEach((i) => (i.checked = true)); aplica(); };
    $(`#${P}nenhum`, raiz).onclick = () => { $$(`#${P}gr input`, raiz).forEach((i) => (i.checked = false)); aplica(); };
    const atalho = $(`#${P}bloco-atalho`, raiz);
    if (atalho) atalho.onchange = () => {
      const b = S.blocks.find((x) => String(x.id) === atalho.value); if (!b) return;
      $$(`#${P}gr input`, raiz).forEach((i) => { if (b.group_jids.includes(i.value)) i.checked = true; });
      aoBloco?.(b); aplica(); atalho.value = '';
    };
    return aplica;
  };
  return { html, ligar, marcados };
}
function fonteHtml(f, i, total) {
  const sc = f.config || {}; const catsSel = new Set(categoriasDe(sc)); const TC = TEXTOS_REGRA_CATALOGO;
  const cc = f.type === 'catalogo' ? sc : {}; const ccLojas = Array.isArray(cc.lojas) ? cc.lojas : []; const ccOrdem = cc.ordem || 'atualizacao';
  return `<div class="fonte sub-campo" data-i="${i}" style="margin-bottom:10px"><legend>Fonte ${i + 1}${total > 1 ? '' : ''} ${total > 1 ? `<button type="button" data-rm-fonte class="leve perigo" style="float:right;padding:2px 8px">Remover</button>` : ''}</legend>
    <div class="grade" style="margin-bottom:8px"><label class="campo"><span><span class="src-tag-rot">${TC.etiquetaComum}</span> ${q('fonte.etiqueta')}</span><select name="src_tag" aria-describedby="fc${i}-na"><option value="">A etiqueta ML padrão</option>${S.tags.map((t) => `<option value="${t.id}" ${t.id === f.tag_id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select><small class="src-tag-na" id="fc${i}-na" hidden>${TC.etiquetaNaoSeAplica}</small></label></div>
    <div class="linha">${q('fonte.tipos')}<label><input type="radio" name="st${i}" value="afiliados" ${f.type === 'afiliados' ? 'checked' : ''} style="width:auto"> Central de Afiliados</label>
      <label><input type="radio" name="st${i}" value="list" ${f.type === 'list' ? 'checked' : ''} style="width:auto"> Lista de links</label>
      <label><input type="radio" name="st${i}" value="search" ${f.type === 'search' ? 'checked' : ''} style="width:auto"> Busca por palavra-chave (experimental)</label>
      <label><input type="radio" name="st${i}" value="catalogo" ${f.type === 'catalogo' ? 'checked' : ''} style="width:auto"> ${TC.opcao}</label>${q('fonte.catalogo')}</div>
    <div class="f-catalogo" style="display:grid;gap:10px">
      <div class="fc-conexao"></div>
      <fieldset class="sub-campo"><legend>${TC.categorias} ${q('fonte.catalogo.categoria')} <span class="dica fc-cont"></span></legend>
        <div class="grupos cats fc-cats" role="group" aria-label="${TC.categorias}" aria-describedby="fc${i}-cats">${fcatCatsHtml(FCAT.lista, Array.isArray(cc.categorias) ? cc.categorias : [], ccLojas)}</div>
        <small id="fc${i}-cats">${TC.catDica}</small> <small class="fc-max nivel-aviso" role="status" hidden></small></fieldset>
      <fieldset class="sub-campo"><legend>${TC.lojas} ${q('fonte.catalogo.loja')}</legend>
        <div class="linha fc-lojas">${FCAT_LOJAS.map((l) => `<label><input type="checkbox" value="${l}" ${ccLojas.includes(l) ? 'checked' : ''} style="width:auto"> ${TC.nomesLoja[l]} <span class="dica" data-total="${l}"></span></label>`).join('')}</div>
        <small>${TC.lojasDica}</small></fieldset>
      <div class="grade" style="align-items:start">
        <label class="campo"><span>${TC.busca}</span><input name="cat_q" value="${esc(cc.q || '')}" maxlength="200" autocomplete="off" spellcheck="false" aria-describedby="fc${i}-q" placeholder="Ex.: air fryer, fritadeira"><small id="fc${i}-q">${TC.buscaDica}</small></label>
        <label class="campo"><span>${TC.desconto}</span><input name="cat_desc" type="number" min="0" max="99" step="1" inputmode="numeric" value="${esc(cc.desconto_min ?? '')}" placeholder="Sem mínimo" aria-describedby="fc${i}-d"><small id="fc${i}-d">${TC.descontoDica}</small></label>
        <label class="campo"><span>${TC.ordem} ${q('fonte.catalogo.ordem')}</span><select name="cat_ordem" aria-describedby="fc${i}-o">${TC.ordens.map(([v, nome]) => `<option value="${v}" ${v === ccOrdem ? 'selected' : ''}>${nome}</option>`).join('')}</select><small id="fc${i}-o" class="fc-ordem-dica" aria-live="polite"></small></label></div>
      <div class="fc-avisos" aria-live="polite" style="display:grid;gap:8px"></div></div>
    <div class="f-afiliados"><div class="grade">
      <label class="campo"><span>Buscar por (opcional) ${q('fonte.busca')}</span><input name="af_busca" value="${esc(sc.busca || '')}" placeholder="Ex.: organizador, air fryer"></label>
      <label class="campo">Ordem<select name="af_ordem">${(S.st.afiliados?.ordens || []).map((o) => `<option value="${o.id}" ${o.id === sc.ordem ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select></label>
      <label class="campo"><span>Páginas lidas por envio ${q('fonte.paginas')}</span><input name="af_paginas" type="number" min="1" max="10" value="${esc(sc.paginas ?? 3)}"><small>Cada página traz ${S.st.afiliados?.por_pagina || 18} produtos.</small></label></div>
      <fieldset class="sub-campo"><legend>Categorias ${q('fonte.categorias')} <span class="dica af-cont"></span></legend>
        <div class="grupos cats af-cats">${(S.st.afiliados?.categorias || []).map((c) => `<label><input type="checkbox" value="${c.id}" ${catsSel.has(c.id) ? 'checked' : ''}>${esc(c.name)}</label>`).join('')}</div>
        <small>Nenhuma marcada = todas. Com várias, as ofertas saem intercaladas (uma de cada categoria por vez).</small></fieldset>
      <div class="linha"><label><input type="checkbox" name="af_mais_vendidos" ${sc.mais_vendidos ? 'checked' : ''} style="width:auto"> Só mais vendidos</label>${q('fonte.maisvendidos')}
        <label><input type="checkbox" name="af_ganhos_extras" ${sc.ganhos_extras ? 'checked' : ''} style="width:auto"> Só com ganhos extras</label>${q('fonte.ganhos')}</div>
      <small class="dica">É a lista “Produtos selecionados para você” da sua Central de Afiliados. A extensão do Chrome busca a lista e gera cada link meli.la com a etiqueta ML desta fonte (ou a etiqueta ML padrão).</small></div>
    <div class="f-list"><label class="campo"><span>Um produto por linha ${REQ} ${q('fonte.lista')}</span><textarea name="items" class="mono" rows="5" placeholder="https://produto.mercadolivre.com.br/MLB-123...&#10;https://produto.mercadolivre.com.br/MLB-456... | Fone Bluetooth | 89,90 | 149,90 | CUPOM10">${esc(sc.items || '')}</textarea>
      <small>Formato opcional: link | título | preço | preço antigo | cupom. Se o título e o preço não forem lidos sozinhos, escreva-os aqui.</small></label></div>
    <div class="f-search grade"><label class="campo"><span>Palavra-chave ${REQ}</span><input name="query" value="${esc(sc.query || '')}" placeholder="Ex.: air fryer"></label>
      <label class="campo">Ordem<select name="sort"><option value="relevance">Relevância</option><option value="price_asc" ${sc.sort === 'price_asc' ? 'selected' : ''}>Menor preço</option><option value="price_desc" ${sc.sort === 'price_desc' ? 'selected' : ''}>Maior preço</option></select></label></div></div>`;
}
function formRegra(r) {
  const nova = !r;
  r = r || { name: '', enabled: true, tag_id: S.tags[0]?.id, template_id: S.templates[0]?.id, group_jids: [], sources: [{ type: 'afiliados', config: { paginas: 3 } }],
    per_run: 3, interval_min: 60, window_start: '08:00', window_end: '22:00', dedupe_days: 7, send_image: true };
  const grupos = seletorGrupos({ selecionados: r.group_jids, blocos: true }); const dlg = $('#dlg');
  const fontes = (r.sources?.length ? r.sources : [{ type: r.source_type || 'afiliados', config: r.source_config || {} }]).map((f) => ({ type: f.type, tag_id: f.tag_id ?? null, config: { ...(f.config || {}) } }));
  const MAXF = S.st.max_fontes || 5;
  // "Reler do começo" vale para a regra salva (todas as fontes Catálogo dela) e é só do Dono
  const podeReler = !nova && podeEquipe() && fontes.some((f) => f.type === 'catalogo');
  FCAT.lista = null; // categorias da última verificação: chegam depois (sem rede até o Etiqueta)
  dlg.innerHTML = `<form method="dialog" id="f" novalidate><h1>${nova ? 'Novo disparo automático' : 'Editar disparo automático'}</h1>
    <div class="grade">
      <label class="campo"><span>Nome ${REQ}</span><input name="name" value="${esc(r.name)}" placeholder="Ex.: Tecnologia" required></label>
      <label class="campo"><span><span id="tag-obr">${TEXTOS_REGRA_CATALOGO.padraoObrigatoria} ${REQ}</span><span id="tag-opc" hidden>${TEXTOS_REGRA_CATALOGO.padraoOpcional}</span> ${q('regras.etiqueta')}</span><select name="tag_id" aria-describedby="tag-opc-dica">${opcoes(S.tags, r.tag_id, 'Escolha…')}</select>
        ${S.tags.length ? '' : '<small>Cadastre uma etiqueta em <a href="#conexoes" target="_blank" rel="noopener">Conexões</a> (Mercado Livre).</small>'}<small id="tag-opc-dica" hidden>${TEXTOS_REGRA_CATALOGO.padraoNaoPrecisa}</small></label>
      <label class="campo"><span>Template ${REQ} ${q('regras.template')}</span><select name="template_id">${opcoes(S.templates, r.template_id)}</select></label></div>
    <fieldset><legend>De onde vêm as ofertas ${REQ} ${q('regras.fontes')} <span class="dica" id="f-cont"></span></legend>
      <div id="fontes"></div>
      <div class="linha"><button type="button" id="add-fonte">+ Adicionar fonte</button><small class="dica">Até ${MAXF} fontes por disparo automático. Com mais de uma, as ofertas saem intercaladas (uma de cada fonte por vez). Um grupo também pode estar em vários disparos automáticos.</small></div>
      ${podeReler ? `<div class="linha" style="margin-top:8px"><button type="button" class="leve" id="fc-reler" title="${TEXTOS_REGRA_CATALOGO.relerTitulo}" aria-describedby="fc-reler-dica fc-reler-estado">${TEXTOS_REGRA_CATALOGO.reler}</button><small class="dica" id="fc-reler-dica">${TEXTOS_REGRA_CATALOGO.relerDica}</small><small id="fc-reler-estado" role="status"></small></div>` : ''}</fieldset>
    <fieldset><legend>Filtros ${q('regras.filtros')}</legend><div class="grade">
      <label class="campo">Preço mínimo (R$)<input name="min_price" type="number" step="0.01" min="0" value="${r.min_price ?? ''}" placeholder="Sem mínimo"></label>
      <label class="campo">Preço máximo (R$)<input name="max_price" type="number" step="0.01" min="0" value="${r.max_price ?? ''}" placeholder="Sem máximo"></label>
      <label class="campo">Desconto mínimo (%)<input name="min_discount" type="number" min="0" max="99" value="${r.min_discount ?? ''}" placeholder="Qualquer"></label></div></fieldset>
    <fieldset><legend>Grupos que vão receber ${REQ} ${q('regras.grupos')} <span id="cont" class="dica"></span></legend>
      ${grupos.html}</fieldset>
    <fieldset><legend>Ritmo de envio</legend>${gradeModoHtml(r.grade ? 'grade' : 'intervalo')}${gradeHtml(r)}<div class="grade">
      <label class="campo r-intervalo"><span>Ofertas por envio ${REQ} ${q('regras.por_envio')}</span><input name="per_run" type="number" min="1" max="20" value="${r.per_run}"><small>Cada oferta vai para todos os grupos, uma atrás da outra.</small></label>
      <label class="campo r-intervalo"><span>Intervalo entre envios (minutos) ${REQ} ${q('regras.intervalo')}</span><input name="interval_min" type="number" min="1" value="${r.interval_min}"></label>
      <label class="campo r-intervalo"><span>Funciona das ${q('regras.janela')}</span><input name="window_start" type="time" value="${esc(r.window_start)}"><small>${TEXTOS_PROTECAO.funcionaDas}</small></label>
      <label class="campo r-intervalo">Até<input name="window_end" type="time" value="${esc(r.window_end)}"></label>
      <label class="campo"><span>Não repetir a mesma oferta por (dias) ${q('regras.dedupe')}</span><input name="dedupe_days" type="number" min="0" value="${r.dedupe_days}"><small>0 = pode repetir.</small></label>
      <label class="campo"><span>Foto do produto ${q('regras.foto')}</span><select name="send_image"><option value="1">Enviar com foto, quando houver</option><option value="0" ${r.send_image ? '' : 'selected'}>Só texto</option></select></label></div></fieldset>
    <div class="rodape"><button type="button" id="cancelar">Cancelar</button><button class="pri" id="salvar">${nova ? 'Criar disparo automático' : 'Salvar'}</button></div></form>`;
  const pintaFontes = () => {
    $('#fontes').innerHTML = fontes.map((f, i) => fonteHtml(f, i, fontes.length)).join('');
    $('#f-cont').textContent = fontes.length > 1 ? `(${fontes.length} fontes)` : '';
    $('#add-fonte').hidden = fontes.length >= MAXF;
    $$('.fonte', dlg).forEach((el) => {
      const i = Number(el.dataset.i);
      const ajusta = () => { const t = $(`input[name=st${i}]:checked`, el).value; $('.f-afiliados', el).hidden = t !== 'afiliados'; $('.f-list', el).hidden = t !== 'list'; $('.f-search', el).hidden = t !== 'search'; $('.f-catalogo', el).hidden = t !== 'catalogo'; fcatAtualizar(el); };
      $$(`input[name=st${i}]`, el).forEach((r) => (r.onchange = () => { ajusta(); atualizaPadrao(); })); ajusta();
      const conta = () => { const n = $$('.af-cats input:checked', el).length; $('.af-cont', el).textContent = n ? `(${n} marcadas)` : '(todas)'; };
      $('.af-cats', el).onchange = conta; conta();
      $('.fc-cats', el).onchange = () => fcatAtualizar(el);
      $('.fc-lojas', el).onchange = () => { fcatPintarCats(el); fcatAtualizar(el); atualizaPadrao(); };
      $('[name=cat_ordem]', el).onchange = () => fcatAtualizar(el);
      const rm = $('[data-rm-fonte]', el); if (rm) rm.onclick = () => { lerFontes(); fontes.splice(i, 1); pintaFontes(); };
    });
    atualizaPadrao();
  };
  const lerFontes = () => {
    $$('.fonte', dlg).forEach((el) => {
      const i = Number(el.dataset.i); const v = (n) => $(`[name=${n}]`, el)?.value ?? ''; const t = $(`input[name=st${i}]:checked`, el).value;
      fontes[i] = { type: t, tag_id: Number(v('src_tag')) || null, config: t === 'afiliados'
        ? { busca: v('af_busca'), categorias: $$('.af-cats input:checked', el).map((c) => c.value), ordem: v('af_ordem'), paginas: Number(v('af_paginas')) || 3, mais_vendidos: !!$('[name=af_mais_vendidos]', el).checked, ganhos_extras: !!$('[name=af_ganhos_extras]', el).checked }
        : t === 'catalogo' ? fcatLerConfig(el)
        : t === 'list' ? { items: v('items') } : { query: v('query'), sort: v('sort') } };
    });
  };
  // Etiqueta padrão obrigatória só se alguma fonte precisar dela (catálogo só Amazon/Shopee não precisa).
  const atualizaPadrao = () => {
    lerFontes(); const precisa = fcatPrecisaEtiqueta(fontes);
    $('#tag-obr', dlg).hidden = !precisa; $('#tag-opc', dlg).hidden = precisa; $('#tag-opc-dica', dlg).hidden = precisa;
  };
  pintaFontes();
  const form = $('#f', dlg);
  api('/catalogo/categorias').then((x) => (Array.isArray(x?.categorias) ? x.categorias : [])).catch(() => []).then((lista) => {
    FCAT.lista = lista;
    if (!dlg.open || $('#f', dlg) !== form) return; // o dono já fechou ou abriu outro formulário
    comInicial(() => $$('.fonte', dlg).forEach((el) => { fcatPintarCats(el); fcatAtualizar(el); }));
  });
  const reler = $('#fc-reler', dlg);
  if (reler) reler.onclick = async () => {
    if (!confirm(TEXTOS_REGRA_CATALOGO.relerConfirma)) return;
    const est = $('#fc-reler-estado', dlg); reler.disabled = true;
    try { await dispApi(`/rules/${r.id}/catalogo/recomecar`, { method: 'POST' }); est.textContent = TEXTOS_REGRA_CATALOGO.relerOk; est.className = 'nivel-ok'; } catch (e) {
      est.textContent = e.status === 409 ? e.message : TEXTOS_REGRA_CATALOGO.relerFalhou; est.className = 'nivel-erro'; // 409: a regra está rodando agora
    } finally { reler.disabled = false; }
  };
  $('#add-fonte').onclick = () => { lerFontes(); if (fontes.length < MAXF) fontes.push({ type: 'afiliados', config: { paginas: 3 } }); pintaFontes(); };
  // "Como enviar": a cada X minutos (padrão) ou em horários marcados (grade.js); os campos do intervalo só ficam escondidos
  const ritmo = gradeLigar(dlg, { regra: r, nGrupos: () => grupos.marcados(dlg).length,
    lerIntervalo: () => Object.fromEntries(['per_run', 'interval_min', 'window_start', 'window_end'].map((n) => [n, $(`[name=${n}]`, dlg).value])) });
  grupos.ligar(dlg, { contador: $('#cont', dlg), aoMudar: () => ritmo.atualizar(), aoBloco: (b) => { if (b.tag_id) $('select[name=tag_id]', dlg).value = b.tag_id; } });
  // U4: Cancelar e Esc com alterações não salvas perguntam antes de descartar; sem alteração, fecham direto. O estado
  // inicial é o do formulário já montado (campos com nome, grupos, fontes e o bloco de horários com o modo).
  // os horários entram por hora, não pela ordem da tela: a lista só se reordena ao sair dela, e voltar a hora ao valor original
  // com a linha ainda fora do lugar não é alteração
  const horariosPorHora = () => { const c = ritmo.corpo(); return c && { ...c, horarios: [...c.horarios].sort((x, y) => (x.hora < y.hora ? -1 : x.hora > y.hora ? 1 : 0)) }; };
  const assinatura = () => JSON.stringify([
    $$('input[name], select[name], textarea[name]', form).map((el) => [el.name, el.type === 'radio' || el.type === 'checkbox' ? el.checked : el.value]),
    grupos.marcados(dlg), (lerFontes(), fontes), ritmo.modo(), horariosPorHora()]);
  let inicial = assinatura();
  /** As categorias do catálogo chegam depois e repintam campos: se o dono ainda não mexeu em nada, o novo estado vira o inicial. */
  const comInicial = (repintar) => { const limpo = assinatura() === inicial; repintar(); if (limpo) inicial = assinatura(); };
  const podeDescartar = () => assinatura() === inicial || confirm('Descartar as alterações?');
  $('#cancelar').onclick = () => { if (podeDescartar()) dlg.close(); };
  // Dica "?" fixa aberta (ajuda.js a move para dentro do diálogo): o Esc é dela, fecha só a dica e não pergunta nem fecha o formulário.
  const dicaFixa = () => !!$('#tip.tip-fixo', dlg);
  const aoCancelar = (ev) => { // Esc: o evento `cancel` do <dialog>
    if ($('#f', dlg) !== form) return;
    if (dicaFixa() || !podeDescartar()) ev.preventDefault();
  };
  // O Chrome só deixa cancelar o `cancel` uma vez por ação do usuário: o 2º Esc seguido fecharia sem perguntar. Com
  // alteração, o Esc é tratado aqui (keydown) e o <dialog> só fecha se o dono aceitar.
  const aoTecla = (ev) => {
    if (ev.key !== 'Escape' || ev.isComposing || $('#f', dlg) !== form || dicaFixa() || assinatura() === inicial) return;
    ev.preventDefault(); if (podeDescartar()) dlg.close();
  };
  const aoFechar = () => { for (const [t, f] of [['cancel', aoCancelar], ['keydown', aoTecla], ['close', aoFechar]]) dlg.removeEventListener(t, f); };
  dlg.addEventListener('cancel', aoCancelar); dlg.addEventListener('keydown', aoTecla); dlg.addEventListener('close', aoFechar);
  $('#f').onsubmit = tentar(async (ev) => {
    ev.preventDefault(); const f = new FormData($('#f'));
    const g = (k) => f.get(k);
    const corpo = {
      name: g('name'), tag_id: g('tag_id') || null, template_id: g('template_id') || null,
      group_jids: grupos.marcados(dlg), sources: (lerFontes(), fontes),
      min_price: g('min_price'), max_price: g('max_price'), min_discount: g('min_discount'),
      per_run: g('per_run'), interval_min: g('interval_min'), window_start: g('window_start'), window_end: g('window_end'),
      dedupe_days: g('dedupe_days'), send_image: g('send_image') === '1', enabled: nova ? true : r.enabled,
      grade: ritmo.corpo(), // sempre explícito: null = "A cada X minutos" (o PUT sem grade também grava NULL)
    };
    if (ritmo.modo() === 'grade') {
      // D1: em "Em horários marcados" estes dois campos ficam escondidos e não podem virar erro: vai o digitado, se
      // válido; senão o salvo na regra, se válido; senão o padrão (3 ofertas, 60 min). As checagens abaixo ficam iguais.
      const valido = (v, ok, salvo, padrao) => (ok(v) ? v : ok(salvo) ? String(salvo) : padrao);
      corpo.per_run = valido(corpo.per_run, (v) => Number(v) >= 1 && Number(v) <= 20, r.per_run, '3');
      corpo.interval_min = valido(corpo.interval_min, (v) => Number(v) >= 1, r.interval_min, '60');
    }
    const erros = [];
    if (!String(corpo.name || '').trim()) erros.push({ msg: 'Dê um nome ao disparo automático.', el: $('[name=name]', dlg) });
    if (!corpo.tag_id && fcatPrecisaEtiqueta(fontes)) erros.push({ msg: 'Escolha a etiqueta ML padrão (cadastre em Conexões > Mercado Livre se ainda não tiver).', el: $('[name=tag_id]', dlg) });
    if (!corpo.template_id) erros.push({ msg: 'Escolha um template.', el: $('[name=template_id]', dlg) });
    fontes.forEach((f, i) => {
      const el = $(`.fonte[data-i="${i}"]`, dlg);
      if (f.type === 'list' && !String(f.config.items || '').split('\n').some((l) => /^https?:/i.test(l.trim()))) erros.push({ msg: `Fonte ${i + 1}: cole ao menos um link de produto.`, el: $('textarea[name=items]', el) });
      if (f.type === 'search' && !String(f.config.query || '').trim()) erros.push({ msg: `Fonte ${i + 1}: digite a palavra-chave da busca.`, el: $('input[name=query]', el) });
      if (f.type === 'catalogo') fcatErros(f.config).forEach((e) => erros.push({ msg: `Fonte ${i + 1}: ${e.msg}`, el: $(FCAT_CAMPOS[e.campo], el) }));
    });
    if (!corpo.group_jids.length) erros.push({ msg: 'Marque ao menos um grupo que vai receber as ofertas.', el: $('#gr', dlg) });
    if (!(Number(corpo.per_run) >= 1 && Number(corpo.per_run) <= 20)) erros.push({ msg: 'Ofertas por envio: de 1 a 20.', el: $('[name=per_run]', dlg) });
    if (!(Number(corpo.interval_min) >= 1)) erros.push({ msg: 'Intervalo entre envios: ao menos 1 minuto.', el: $('[name=interval_min]', dlg) });
    erros.push(...ritmo.erros()); // grade: as mesmas frases do servidor (src/grade.js)
    if (mostrarErros(dlg, erros)) return;
    try { await api(nova ? '/rules' : `/rules/${r.id}`, nova ? 'POST' : 'PUT', corpo); } catch (e) {
      // 400 da fonte Catálogo: frase fixa do servidor, com o campo e a fonte (1, 2…) para marcar
      const el = e.fonte && Object.hasOwn(FCAT_CAMPOS, e.campo || '') ? $(`.fonte[data-i="${e.fonte - 1}"] ${FCAT_CAMPOS[e.campo]}`, dlg) : null;
      mostrarErros(dlg, [{ msg: e.fonte ? `Fonte ${e.fonte}: ${e.message}` : e.message, el }]); return;
    }
    dlg.close(); aviso(nova ? 'Disparo automático criado' : 'Disparo automático salvo'); await recarregarRegras();
  });
  dlg.showModal();
}
/**
 * Alguma fonte Catálogo da prévia ainda está na primeira leitura (Novidades sem ponto de partida)? O servidor marca a
 * fonte com `primeira_leitura: true`: na lista `fontes` da resposta de /offers ou, sem ela, nas `sources` da regra.
 */
function fcatPrimeiraLeitura(resposta, r) {
  const fontes = Array.isArray(resposta?.fontes) ? resposta.fontes : Array.isArray(r?.sources) ? r.sources : [];
  return fontes.some((f) => f?.primeira_leitura === true);
}
async function verOfertas(r) {
  const dlg = $('#dlg'); dlg.innerHTML = '<div class="corpo"><h1>Próximas ofertas</h1><p class="dica">Buscando…</p></div>'; dlg.showModal();
  try {
    const resp = await api(`/rules/${r.id}/offers`);
    // a resposta é a lista de ofertas ou { ofertas, fontes } (fontes com `primeira_leitura`)
    const of = Array.isArray(resp) ? resp : Array.isArray(resp?.ofertas) ? resp.ofertas : [];
    const primeira = fcatPrimeiraLeitura(resp, r);
    const avisoPrimeira = primeira ? `<div class="aviso-impl neutro" role="status"><p>${of.length ? TEXTOS_REGRA_CATALOGO.primeiraLeituraOutras : TEXTOS_REGRA_CATALOGO.primeiraLeitura}</p></div>` : '';
    dlg.innerHTML = `<div class="corpo"><h1>Próximas ofertas de “${esc(r.name)}”</h1>
      <p class="dica">É o que sairia no próximo envio, nesta ordem. O link meli.la só é gerado na hora de enviar.</p>${avisoPrimeira}
      ${of.length ? `<div class="chat">${of.map((o) => `<div class="balao">${o.revisao ? `<small class="dica" style="display:block;margin-bottom:6px"><span class="venc-aviso">${TEXTOS_REGRA_CATALOGO.esperariaRevisao}</span> ${esc(hcatMotivos(o.motivos))}</small>` : ''}${o.etiqueta ? `<small class="dica" style="display:block;margin-bottom:6px">Fonte ${o.fonte} · etiqueta <b>${esc(o.etiqueta)}</b></small>` : ''}${zap(o.text)}${o.comissao ? `<small class="dica" style="display:block;margin-top:6px">${esc(o.comissao)}${o.destaque ? ' · ' + esc(o.destaque) : ''}</small>` : ''}</div>`).join('')}</div>` : primeira ? '' : '<div class="vazio">Nenhuma oferta nova dentro dos filtros. Veja o Histórico para o motivo.</div>'}
      <div class="rodape"><button id="fechar" class="pri">Fechar</button></div></div>`;
  } catch (e) {
    dlg.innerHTML = `<div class="corpo"><h1>Não consegui buscar</h1><p>${esc(e.message)}</p><div class="rodape"><button id="fechar" class="pri">Fechar</button></div></div>`;
  }
  $('#fechar').onclick = () => dlg.close();
}

// ---------- templates ----------
function paginaTemplates(id) {
  const t = S.templates.find((x) => x.id === id) || S.templates[0]; editando = t?.id ?? null;
  $('#pagina').innerHTML = `<div class="topo"><div><h1>Templates ${q('templates')}</h1><p class="sub">O texto da mensagem. Linha com campo vazio (por exemplo, sem cupom) some sozinha. O {LINK} é obrigatório.</p></div>
    <button id="novoT" class="pri">Novo template</button></div>
    <div class="modelos">${S.templates.map((x) => `<button data-id="${x.id}" class="${x.id === t.id ? 'on' : ''}">${esc(x.name)}</button>`).join('')}</div>
    <div class="editor"><div class="card" style="display:grid;gap:12px">
      <label class="campo"><span>Nome ${REQ}</span><input id="tn" value="${esc(t.name)}"></label>
      <label class="campo"><span>Mensagem ${REQ} <small class="dica">(precisa ter {LINK})</small></span><textarea id="tb" class="mono" rows="12">${esc(t.body)}</textarea></label>
      <div class="linha" id="chips">${S.st.placeholders.map((p) => `<button type="button" class="chip mono" data-p="${p}">{${p}}</button>`).join('')}</div>
      <small class="dica">${esc(TEXTOS_VERIFICADOR.horaPreco)}</small>
      <small class="dica">Dica do WhatsApp: *negrito*, _itálico_, ~riscado~.</small>
      <div class="linha"><button class="pri" id="sv">Salvar template</button><button class="perigo leve" id="dl">Excluir</button></div></div>
      <div><h2>Como vai aparecer</h2><div class="chat"><div class="balao" id="pv"></div></div></div></div>`;
  const tb = $('#tb'); let tm;
  const prever = async () => { try { $('#pv').innerHTML = zap((await api('/templates/preview', 'POST', { body: tb.value })).texto); } catch { /* ignora */ } };
  tb.oninput = () => { clearTimeout(tm); tm = setTimeout(prever, 200); }; prever();
  $('#chips').onclick = (e) => { const p = e.target.dataset.p; if (!p) return; const a = tb.selectionStart; tb.setRangeText(`{${p}}`, a, tb.selectionEnd, 'end'); tb.focus(); prever(); };
  $$('.modelos button').forEach((b) => (b.onclick = () => paginaTemplates(Number(b.dataset.id))));
  $('#novoT').onclick = tentar(async () => { const r = await api('/templates', 'POST', { name: 'Novo template', body: S.templates[0].body }); S.templates = await api('/templates'); paginaTemplates(r.id); });
  $('#sv').onclick = tentar(async () => {
    const card = $('#sv').closest('.card'); const erros = [];
    if (!$('#tn').value.trim()) erros.push({ msg: 'Dê um nome ao template.', el: $('#tn') });
    if (!tb.value.includes('{LINK}')) erros.push({ msg: 'A mensagem precisa ter {LINK}, senão sai sem o link de afiliado.', el: tb });
    if (mostrarErros(card, erros)) return;
    try { await api('/templates/' + t.id, 'PUT', { name: $('#tn').value, body: tb.value }); } catch (e) { mostrarErros(card, [{ msg: e.message }]); return; }
    S.templates = await api('/templates'); aviso('Template salvo'); paginaTemplates(t.id);
  });
  $('#dl').onclick = tentar(async () => { if (!confirm('Excluir este template?')) return; await api('/templates/' + t.id, 'DELETE'); S.templates = await api('/templates'); paginaTemplates(); });
}

// ---------- Números de WhatsApp (conexão por QR, estado e desconectar) ----------
function paginaNumeros() {
  const w = S.st.whatsapp; let corpo;
  if (w.status === 'open') {
    corpo = `<div class="card"><h2>Conectado</h2><p class="sub">Número: ${esc(String(w.me || '').split(':')[0].split('@')[0])}. ${S.groups.length} ${S.groups.length === 1 ? 'grupo encontrado' : 'grupos encontrados'}, listados em <a href="#grupos">Grupos</a>.</p>
      <div id="nm-protecao" class="pr-uso"></div>
      <p class="dica" style="margin:8px 0 0">${TEXTOS_PROTECAO.chipReserva}</p>
      <div class="acoes" style="border:0;padding:0">${podeEquipe() ? '<button id="desconectar" class="perigo">Desconectar</button>' : `<p class="dica" style="margin:0">${SO_DONO_DICA.desconectar}</p>`}</div></div>`;
  } else if (w.status === 'qr') {
    corpo = `<div class="card qr"><h2>Leia o QR no celular</h2><img src="${w.qr}" alt="QR Code para conectar o WhatsApp">
      <ol class="passos"><li>Abra o WhatsApp Business no celular.</li><li>Toque nos três pontos e em “Aparelhos conectados”.</li><li>Toque em “Conectar um aparelho” e aponte para este QR.</li></ol>
      <p class="dica">O código se renova sozinho a cada poucos segundos.</p></div>`;
  } else if (w.status === 'connecting') {
    corpo = '<div class="card"><h2>Conectando…</h2><p class="sub">Aguarde alguns segundos.</p></div>';
  } else {
    corpo = `<div class="card"><h2>Nenhum número conectado</h2><p class="sub">Você vai conectar o seu WhatsApp Business como “aparelho conectado”, igual ao WhatsApp Web. O celular continua funcionando normalmente.</p>
      ${w.error ? `<p style="color:var(--err)">${esc(w.error)}</p>` : ''}<button class="pri" id="conectar">Conectar WhatsApp</button></div>`;
  }
  $('#pagina').innerHTML = `<div class="topo"><div><h1>Números de WhatsApp ${q('whatsapp')}</h1><p class="sub">${TEXTOS_PROTECAO.numerosSub}</p></div></div>${corpo}`;
  pintarProtecaoUso();
  if ($('#conectar')) $('#conectar').onclick = tentar(async () => { await api('/wa/connect', 'POST'); await atualizarEstado(true); });
  // id "desconectar", não "sair": #sair é o botão de sair do painel, no menu.
  if ($('#desconectar')) $('#desconectar').onclick = tentar(async () => {
    if (!confirm('Desconectar o WhatsApp deste programa?')) return;
    const apagar = confirm('Apagar também o histórico de entradas, saídas, leituras e cliques dos grupos? (recomendado se não for usar mais este número aqui)');
    await api('/wa/logout', 'POST', { apagar_eventos: apagar }); S.groups = []; await atualizarEstado(true);
  });
}

// ---------- Grupos (lista, convites e sincronização) ----------
function paginaGrupos() {
  const aberto = S.st.whatsapp.status === 'open';
  $('#pagina').innerHTML = `<div class="topo"><div><h1>Grupos ${q('grupos')}</h1><p class="sub">Os grupos do número conectado, com membros, blocos e o link de convite que o Rotacionador de Links usa.</p></div>
    ${aberto ? '<button id="sync">Atualizar lista de grupos</button>' : ''}</div>
    ${aberto ? '' : '<div class="card"><h2>WhatsApp desconectado</h2><p class="sub">Conecte o número em <a href="#numeros">Números de WhatsApp</a> para atualizar a lista e buscar convites.</p></div>'}
    ${aberto || S.groups.length ? tabelaGrupos(S.groups) : ''}`;
  if ($('#sync')) $('#sync').onclick = tentar(async () => { await api('/wa/sync-groups', 'POST'); S.groups = await api('/groups'); aviso('Grupos atualizados'); paginaGrupos(); });
  if (podeEquipe()) { // coluna Rastreio (ganhos.js): só o Dono; os códigos chegam depois e a tabela se redesenha se mudaram
    $('#pagina').onclick = tentar(async (ev) => { const b = ev.target.closest('[data-rastreio]'); if (b) rastreioFormGrupo(b.dataset.rastreio); });
    rastreioCarregar().then((mudou) => { if (mudou && rotaAtual() === 'grupos' && !$('#dlg').open) paginaGrupos(); }).catch(() => {});
  }
}

// ---------- histórico ----------
// Filtros no endereço: #historico?tipo=espelhamento&regra=3&status=na_fila (tipo: automatico | espelhamento | catalogo |
// remetente; vazio = tudo). As visões Espelhamento ("Completar") e Catálogo ("Revisar oferta") estão em espelhamento.js;
// a visão Remetente, em remetentes.js.
async function paginaHistorico(nivel = '', params = null) {
  const tipo = ['automatico', 'espelhamento', 'catalogo', 'remetente'].includes(params?.get('tipo')) ? params.get('tipo') : '';
  if (tipo === 'espelhamento') return paginaHistoricoEspelhamento(params);
  if (tipo === 'catalogo') return paginaHistoricoCatalogo(params);
  if (tipo === 'remetente') return paginaHistoricoRemetente(params);
  const g = ++ESP_H.ger; clearTimeout(paginaHistorico.t); // para a atualização automática da visão Espelhamento, se estava aberta
  // "Disparo automático": o servidor devolve só as linhas de regra (rule_id), no mesmo limite de "Tudo"
  const filtros = [nivel ? `nivel=${nivel}` : '', tipo === 'automatico' ? 'tipo=automatico' : ''].filter(Boolean).join('&');
  const bruto = await api('/log' + (filtros ? `?${filtros}` : ''));
  // o dono saiu da página, ou trocou o Tipo, enquanto carregava: a resposta atrasada não sobrescreve a tela
  if (g !== ESP_H.ger || rotaAtual() !== 'historico') return;
  const log = tipo === 'automatico' ? bruto.filter(histEhAutomatico) : bruto; // defesa: rule_id != null
  $('#pagina').innerHTML = `<div class="topo"><div><h1>Histórico ${q('historico')}</h1><p class="sub">Tudo que foi enviado e tudo que deu errado, com o motivo.</p></div>
    <div class="linha">${histTipoHtml(tipo)}<select id="nv" style="width:auto" aria-label="Filtrar"><option value="">Tudo</option><option value="ok" ${nivel === 'ok' ? 'selected' : ''}>Só enviados</option><option value="erro" ${nivel === 'erro' ? 'selected' : ''}>Só erros</option><option value="aviso" ${nivel === 'aviso' ? 'selected' : ''}>Só avisos</option></select></div></div>
    ${log.length ? `<div class="card tabela"><table><thead><tr><th>Quando</th><th>Origem</th><th>Grupo</th><th>Oferta</th><th>Resultado</th></tr></thead><tbody>
    ${log.map((l) => `<tr><td>${hora(l.ts)}</td><td>${esc(l.rule_name || '')}</td><td>${esc(l.group_name || '')}</td><td>${esc(l.offer_title || '')}</td><td><span class="nivel-${l.level}">${esc(l.message)}</span></td></tr>`).join('')}</tbody></table></div>`
      : '<div class="vazio">Nada por aqui ainda.</div>'}`;
  histLigarTipo($('#nv').value);
  $('#nv').onchange = (e) => paginaHistorico(e.target.value, params);
  clearTimeout(paginaHistorico.t); paginaHistorico.t = setTimeout(() => { if (rotaAtual() === 'historico' && !$('#dlg').open) paginaHistorico($('#nv')?.value || '', params); }, 6000);
}

// ---------- ajustes ----------
function paginaAjustes() {
  const a = S.st.ajustes;
  $('#pagina').innerHTML = `<div class="topo"><div><h1>Ajustes</h1></div></div>
    ${cartaoProtecao(a, S.st.protecao, podeEquipe())}
    <div class="card" style="display:grid;gap:14px"><div><h2>Título do produto na mensagem ${q('ajustes.titulo')}</h2><p class="sub">Os títulos do Mercado Livre vêm cheios de palavras-chave. {TITULO_PRODUTO} sai abreviado: só o que identifica o produto, sem “Compatível com…”, “Premium”, “Alta Qualidade”. Para o nome inteiro, use {TITULO_COMPLETO} no template.</p></div>
      <div class="grade"><label class="campo">Tamanho máximo (caracteres)<input id="tm" type="number" min="0" max="200" value="${a.titulo_max ?? 60}"><small>0 = não abreviar. Sugestão: 50 a 70.</small></label></div>
      <div class="linha"><button class="pri" id="st">Salvar</button><small class="dica" id="tm-ex"></small></div></div>
    ${cartaoVerificador(a)}
    <div class="card" style="display:grid;gap:14px"><div><h2>Como gerar o link de afiliado ${q('ajustes.modo_link')}</h2></div>
      <label class="campo"><select id="lm"><option value="extension">Pela extensão do Chrome (com a etiqueta, gera comissão)</option>
        <option value="direct" ${a.link_mode === 'direct' ? 'selected' : ''}>Link direto, sem etiqueta (só para testar, não gera comissão)</option></select></label>
      <div><button id="sl">Salvar modo</button></div></div>
    <div class="card" style="display:grid;gap:12px"><div><h2>Extensão do Chrome ${q('ajustes.extensao')}</h2><p class="sub">O endereço, o token e o estado da extensão ficam em Conexões, no cartão do Mercado Livre.</p></div>
      <div><a class="btn" href="#conexoes" style="text-decoration:none;display:inline-block">Ver em Conexões</a></div></div>
    <div class="card" style="display:grid;gap:14px"><div><h2>Privacidade dos grupos ${q('ajustes.privacidade')}</h2><p class="sub">Entradas, saídas e leituras são guardadas com um pseudônimo por pessoa (não o número) e apagadas depois do prazo abaixo. Cliques do rotacionador também.</p></div>
      <div class="grade"><label class="campo">Guardar por (dias)<input id="ret" type="number" min="0" max="3650" value="${a.retencao_dias ?? 90}"><small>0 = guardar para sempre (não recomendado).</small></label></div>
      <div class="linha"><button class="pri" id="sr">Salvar</button>${podeEquipe() ? '<button id="limpar-agora">Apagar o que já passou do prazo</button>' : `<small class="dica">${SO_DONO_DICA.limpar}</small>`}</div></div>`;
  $('#sr').onclick = tentar(async () => { await api('/ajustes', 'PUT', { retencao_dias: $('#ret').value }); await atualizarEstado(); aviso('Salvo'); });
  if ($('#limpar-agora')) $('#limpar-agora').onclick = tentar(async () => { const r = await api('/privacidade/limpar', 'POST'); aviso(`Apagados: ${r.eventos ?? 0} eventos, ${r.leituras ?? 0} leituras, ${r.cliques ?? 0} cliques, ${r.espelhamento ?? 0} itens do espelhamento, ${r.remetentes ?? 0} itens dos remetentes`); });
  const exemploTitulo = tentar(async () => { const r = await api('/templates/preview', 'POST', { body: '{TITULO_PRODUTO}', amostra: { title: 'Fones De Ouvido Usb-c Tipo C Com Microfone Integrado Som Estéreo Alta Qualidade Controle Chamadas Compatível Com iPhone 15 16 17 Android Samsung Premium' } }); $('#tm-ex').textContent = 'Exemplo: “' + r.texto + '”'; });
  exemploTitulo();
  $('#st').onclick = tentar(async () => { await api('/ajustes', 'PUT', { titulo_max: $('#tm').value }); await atualizarEstado(); aviso('Salvo'); exemploTitulo(); });
  $('#sl').onclick = tentar(async () => { await api('/ajustes', 'PUT', { link_mode: $('#lm').value }); await atualizarEstado(); aviso('Modo salvo'); });
  ligarCartaoVerificador();
  ligarCartaoProtecao(); pintarProtecaoUso();
}

/**
 * Cartão "Conferir preço e estoque antes de enviar" (a = S.st.ajustes): chave (ausente = ligada) e limite de alta, de
 * 0 a 50 (ausente = 5). Desligada, o limite fica desabilitado (não escondido) e a dica diz o que muda. Quem salva os
 * outros Ajustes salva este (o servidor não exige o Dono, plano D10).
 */
function cartaoVerificador(a = {}) {
  const V = TEXTOS_VERIFICADOR; const ligado = a.verificador_ativo !== false;
  const limite = Number.isInteger(a.verificador_limite_pct) ? a.verificador_limite_pct : 5;
  return `<div class="card" style="display:grid;gap:14px" id="vf-card"><div><h2>${V.titulo} ${q('ajustes.verificador')}</h2><p class="sub">${V.sub}</p></div>
      <div style="display:grid;gap:6px"><div class="linha"><label class="chave"><input type="checkbox" id="vf-ativo" aria-describedby="vf-desligado"${ligado ? ' checked' : ''}><span></span></label>
        <label for="vf-ativo" style="font-weight:600;font-size:14px">${V.chave}</label></div>
        <small class="dica" id="vf-desligado"${ligado ? ' hidden' : ''}>${V.desligado}</small></div>
      <div class="grade"><label class="campo"><span>${V.limite} ${q('ajustes.verificador.limite')}</span><input id="vf-limite" type="number" inputmode="numeric" min="0" max="50" step="1" value="${limite}" aria-describedby="vf-limite-dica vf-limite-erro"${ligado ? '' : ' disabled'}>
        <small id="vf-limite-dica">${V.limiteDica}</small><small class="nivel-erro" id="vf-limite-erro" role="alert" hidden></small></label></div>
      <div class="linha"><button class="pri" id="vf-salvar">${V.salvar}</button></div></div>`;
}
/** Comportamento do cartão do verificador: a chave liga e desliga o limite; Salvar valida (inteiro de 0 a 50) e grava. */
function ligarCartaoVerificador() {
  const V = TEXTOS_VERIFICADOR;
  const chk = $('#vf-ativo'); const inp = $('#vf-limite'); const erroEl = $('#vf-limite-erro'); const btn = $('#vf-salvar');
  if (!chk || !inp || !btn) return;
  const limparErro = () => { erroEl.hidden = true; erroEl.textContent = ''; inp.removeAttribute('aria-invalid'); inp.classList.remove('invalido'); };
  chk.onchange = () => { inp.disabled = !chk.checked; $('#vf-desligado').hidden = chk.checked; if (!chk.checked) limparErro(); };
  inp.oninput = limparErro;
  btn.onclick = async () => {
    const ligado = chk.checked; const txt = String(inp.value ?? '').trim();
    const corpo = { verificador_ativo: ligado };
    if (ligado) {
      // o input number devolve '' para texto que não é número; decimal e negativo chegam como texto e não passam
      if (!/^\d{1,2}$/.test(txt) || Number(txt) > 50) {
        erroEl.textContent = V.erroLimite; erroEl.hidden = false; inp.setAttribute('aria-invalid', 'true'); inp.classList.add('invalido'); inp.focus();
        return;
      }
      corpo.verificador_limite_pct = Number(txt);
    }
    btn.disabled = true; btn.textContent = V.salvando;
    try { await api('/ajustes', 'PUT', corpo); await atualizarEstado(); aviso(V.salvo); } catch (e) { aviso(e.message, true); } finally { btn.disabled = false; btn.textContent = V.salvar; btn.focus(); }
  };
}

// ---------- Proteção do número (cartão de Ajustes, uso em Números) ----------
const PROTECAO_LIMITES = { limite_hora_min: 1, limite_hora_max: 200, delay_group_min: 2, delay_group_max: 60, delay_offer_min: 5, delay_offer_max: 600 };
const protecaoLimites = (p) => ({ ...PROTECAO_LIMITES, ...(p?.limites || {}) });
/** "HH:MM" local de um instante (ms); texto vazio se não for um instante. */
function protecaoHora(ts) {
  if (ts == null || ts === '') return ''; // Number(null) seria 0 (a meia-noite de 1970)
  const d = new Date(Number(ts));
  return Number.isFinite(d.getTime()) ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '';
}
/**
 * Faixa real de uma pausa: o valor do campo ±`variacao` (a do servidor, `protecao.variacao_pausa`), nunca abaixo do
 * mínimo entre duas mensagens. Valor que não é inteiro positivo: null (a dica some, a validação fala).
 */
function protecaoFaixa(valor, variacao, minimo = 0) {
  const txt = String(valor ?? '').trim();
  if (!/^\d{1,9}$/.test(txt)) return null;
  const v = Number(txt); const f = Number.isFinite(Number(variacao)) ? Number(variacao) : 0.3;
  const min = Math.round(v * (1 - f)); // o valor salvo já respeita o mínimo; a faixa é exatamente ±variação dele
  return { min, max: Math.max(min, Math.round(v * (1 + f))) };
}
/**
 * Uso do teto por hora e aviso de teto cheio, em HTML: { html, perto }. `onde`: 'cartao' (Ajustes) ou 'numeros'
 * (com o link "Mudar em Ajustes"). Sem leitura (protecao nula ou sem `usados`), uma linha e nada de barra. O texto
 * diz o estado por extenso ("Perto do limite", "Limite atingido"): a cor e a barra só reforçam.
 */
function protecaoUso(p, onde = 'cartao') {
  const T = TEXTOS_PROTECAO; const numeros = onde === 'numeros';
  const usados = Number.isInteger(p?.usados) && p.usados >= 0 ? p.usados : null;
  const limite = Number.isInteger(p?.limite_hora) && p.limite_hora > 0 ? p.limite_hora : null;
  const silencio = p?.silencio?.agora && protecaoHora(p.silencio.ate_ts) ? `<small class="dica">${esc(T.silencioAgora(protecaoHora(p.silencio.ate_ts)))}</small>` : '';
  const mudar = numeros ? ` <a href="#ajustes">${T.mudar}</a>` : '';
  const fim = numeros ? silencio : ''; // no cartão o silêncio tem o seu lugar (#pr-silencio-agora), no alto
  if (usados == null) return { perto: false, silencio, html: `<span>${T.usoSemLeitura}</span>${fim}` };
  if (limite == null) return { perto: false, silencio, html: `<span>${esc(T.usoSemTeto(usados))}${mudar}</span>${fim}` };
  const cheio = usados >= limite; const perto = !cheio && usados * 100 >= limite * 80;
  const texto = (numeros ? (perto ? T.usoNumerosPerto : T.usoNumeros) : (perto ? T.usoPerto : T.usoNormal))(usados, limite);
  const barra = `<progress value="${Math.min(usados, limite)}" max="${limite}" aria-label="${T.usoAria}"></progress>`;
  const hh = cheio && p.libera_em != null ? protecaoHora(p.libera_em) : '';
  const aviso = cheio ? `<div class="aviso-impl" role="status"><p><b>${esc(T.tetoTitulo(usados, limite))}</b> ${hh ? esc(T.tetoCorpo(hh)) : T.tetoCorpoSemHora}</p></div>` : '';
  return { perto, silencio, aviso, html: `<span>${esc(texto)}${mudar}</span>${barra}${aviso}${fim}` };
}
/** Repinta o uso nos lugares abertos (cartão de Ajustes e Números) só quando o texto muda: o aviso de teto é anunciado uma vez. */
function pintarProtecaoUso() {
  const p = S.st?.protecao;
  const cartao = protecaoUso(p, 'cartao');
  const num = protecaoUso(p, 'numeros');
  const alvos = [['#pr-uso', cartao.html, cartao.perto, cartao.aviso], ['#pr-silencio-agora', cartao.silencio, false, ''], ['#nm-protecao', num.html, num.perto, num.aviso]];
  for (const [sel, html, perto, aviso] of alvos) {
    const el = $(sel); if (!el) continue;
    const chave = (perto ? '1' : '0') + html;
    if (el.dataset.k === chave) continue;
    // Mesmo aviso de teto: troca só o resto e mantém o nó do aviso, para o leitor de tela não reler o role=status.
    const velho = aviso && el.dataset.av === aviso && el.querySelector ? el.querySelector('.aviso-impl') : null;
    if (velho) {
      const t = document.createElement('template'); t.innerHTML = html;
      t.content.querySelector('.aviso-impl')?.replaceWith(velho); el.replaceChildren(...t.content.childNodes);
    } else el.innerHTML = html;
    el.dataset.k = chave; el.dataset.av = aviso || ''; el.classList.toggle('pr-perto', !!perto);
  }
}
/**
 * Cartão "Proteção do número" (a = ajustes, p = protecao do /state, dono = quem pode mudar): teto por hora, horário de
 * silêncio e as duas pausas, num salvar só (PUT /api/protecao). O Operador vê os valores com os campos desabilitados
 * e a dica, sem o botão. Sem `p` (o servidor não leu), só o aviso.
 */
function cartaoProtecao(a = {}, p = null, dono = true) {
  const T = TEXTOS_PROTECAO;
  const cab = `<div><h2>${T.titulo} ${q('ajustes.protecao')}</h2><p class="sub">${T.sub}</p></div>`;
  if (!p) return `<div class="card" style="display:grid;gap:14px" id="pr-card">${cab}<p class="dica" role="status">${T.semLeitura}</p></div>`;
  const L = protecaoLimites(p); const dis = dono ? '' : ' disabled'; const ativo = p.silencio?.ativo === true;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : '');
  const faixa = (v, min) => { const f = protecaoFaixa(v, p.variacao_pausa, min); return f ? T.faixa(f.min, f.max) : ''; };
  const campoNum = (id, rotulo, valor, min, max, extra = '') => `<label class="campo"><span>${rotulo}</span><input id="pr-${id}" type="number" inputmode="numeric" min="${min}" max="${max}" step="1" value="${esc(valor)}" aria-describedby="pr-${id}-dica pr-${id}-erro"${dis}>${extra}<small class="nivel-erro" id="pr-${id}-erro" role="alert" hidden></small></label>`;
  return `<div class="card" style="display:grid;gap:14px" id="pr-card">${cab}
      <div id="pr-silencio-agora"></div>
      <fieldset><legend>${T.legendaLimite} ${q('ajustes.limite_hora')}</legend><div class="grade" style="align-items:start">
        ${campoNum('limite', T.limite, num(p.limite_hora), L.limite_hora_min, L.limite_hora_max, `<small id="pr-limite-dica">${T.limiteDica}</small>`)}
        <div id="pr-uso" class="pr-uso"></div></div></fieldset>
      <fieldset><legend>${T.legendaSilencio} ${q('ajustes.silencio')}</legend>
        <div class="linha"><label class="chave"><input type="checkbox" id="pr-ativo" aria-describedby="pr-desligado"${ativo ? ' checked' : ''}${dis}><span></span></label>
          <label for="pr-ativo" style="font-weight:600;font-size:14px">${T.chave}</label></div>
        <div class="grade" style="align-items:start">
          <label class="campo"><span>${T.das}</span><input id="pr-de" type="time" value="${esc(p.silencio?.de ?? '')}" aria-describedby="pr-de-erro"${ativo ? dis : ' disabled'}><small class="nivel-erro" id="pr-de-erro" role="alert" hidden></small></label>
          <label class="campo"><span>${T.ate}</span><input id="pr-ate" type="time" value="${esc(p.silencio?.ate ?? '')}" aria-describedby="pr-ate-erro"${ativo ? dis : ' disabled'}><small class="nivel-erro" id="pr-ate-erro" role="alert" hidden></small></label></div>
        <small class="dica" id="pr-desligado"${ativo ? ' hidden' : ''}>${T.desligado}</small><small class="dica">${T.silencioDica}</small></fieldset>
      <fieldset><legend>${T.legendaPausas} ${q('ajustes.pausas')}</legend><div class="grade" style="align-items:start">
        ${campoNum('dg', T.pausaGrupo, num(a.delay_group_s), L.delay_group_min, L.delay_group_max, `<small id="pr-dg-dica">${faixa(a.delay_group_s, L.delay_group_min)}</small>`)}
        ${campoNum('do', T.pausaOferta, num(a.delay_offer_s), L.delay_offer_min, L.delay_offer_max, `<small id="pr-do-dica">${faixa(a.delay_offer_s, L.delay_offer_min)}</small>`)}</div></fieldset>
      ${dono ? `<div class="linha"><button class="pri" id="pr-salvar">${T.salvar}</button></div>` : `<small class="dica">${T.soDono}</small>`}</div>`;
}
const PROTECAO_CAMPOS = ['limite', 'de', 'ate', 'dg', 'do']; // ordem visual: o foco vai ao primeiro com erro
/**
 * Confere os campos do cartão com as mesmas faixas e frases do servidor. `v`: { limite, ativo, de, ate, dg, do }
 * (texto dos campos). Devolve { erros: { campo: frase }, corpo } com o corpo do PUT /api/protecao quando não há erro.
 */
function protecaoValidar(v, L) {
  const T = TEXTOS_PROTECAO; const erros = {}; const corpo = {};
  const inteiro = (x) => { const t = String(x ?? '').trim(); return /^\d{1,9}$/.test(t) ? Number(t) : null; };
  const faixaInt = (campo, chave, min, max) => { const n = inteiro(v[campo]); if (n == null || n < min || n > max) erros[campo] = T.erroInteiro(min, max); else corpo[chave] = n; };
  faixaInt('limite', 'limite_hora', L.limite_hora_min, L.limite_hora_max);
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
  for (const [campo, chave] of [['de', 'silencio_de'], ['ate', 'silencio_ate']]) { if (!hhmm.test(String(v[campo] ?? ''))) erros[campo] = T.erroHora; else corpo[chave] = v[campo]; }
  if (!erros.de && !erros.ate && v.de === v.ate) erros.ate = T.erroIguais;
  faixaInt('dg', 'delay_group_s', L.delay_group_min, L.delay_group_max);
  faixaInt('do', 'delay_offer_s', L.delay_offer_min, L.delay_offer_max);
  corpo.silencio_ativo = !!v.ativo;
  return { erros, corpo };
}
/** Comportamento do cartão: a chave liga e desliga os horários, a faixa das pausas acompanha o que se digita, Salvar valida e grava. */
function ligarCartaoProtecao() {
  const T = TEXTOS_PROTECAO; const btn = $('#pr-salvar'); const chk = $('#pr-ativo');
  if (!btn || !chk) return; // Operador ou sem leitura do servidor: nada a ligar
  const p = S.st?.protecao; const L = protecaoLimites(p);
  const campo = (c) => $(`#pr-${c}`); const erroEl = (c) => $(`#pr-${c}-erro`);
  const limpar = (c) => { const e = erroEl(c); e.hidden = true; e.textContent = ''; campo(c).removeAttribute('aria-invalid'); campo(c).classList.remove('invalido'); };
  const mostrar = (c, msg) => { const e = erroEl(c); e.textContent = msg; e.hidden = false; campo(c).setAttribute('aria-invalid', 'true'); campo(c).classList.add('invalido'); };
  for (const c of PROTECAO_CAMPOS) campo(c).oninput = () => limpar(c);
  const faixa = (c, min) => { const f = protecaoFaixa(campo(c).value, p?.variacao_pausa, min); $(`#pr-${c}-dica`).textContent = f ? T.faixa(f.min, f.max) : ''; };
  campo('dg').addEventListener('input', () => faixa('dg', L.delay_group_min));
  campo('do').addEventListener('input', () => faixa('do', L.delay_offer_min));
  chk.onchange = () => { campo('de').disabled = !chk.checked; campo('ate').disabled = !chk.checked; $('#pr-desligado').hidden = chk.checked; if (!chk.checked) { limpar('de'); limpar('ate'); } };
  btn.onclick = async () => {
    for (const c of PROTECAO_CAMPOS) limpar(c);
    const { erros, corpo } = protecaoValidar({ limite: campo('limite').value, ativo: chk.checked, de: campo('de').value, ate: campo('ate').value, dg: campo('dg').value, do: campo('do').value }, L);
    const primeiro = PROTECAO_CAMPOS.find((c) => erros[c]);
    if (primeiro) { for (const c of PROTECAO_CAMPOS) if (erros[c]) mostrar(c, erros[c]); campo(primeiro).focus(); return; }
    btn.disabled = true; btn.textContent = T.salvando;
    try { await api('/protecao', 'PUT', corpo); await atualizarEstado(); aviso(T.salvo); } catch (e) { aviso(e.message, true); } finally { btn.disabled = false; btn.textContent = T.salvar; btn.focus(); }
  };
}

// ---------- navegação e atualização ----------
// Uma rota por hash. As páginas novas ficam nos próprios arquivos (disparos.js, relatorios.js, conexoes.js,
// equipe.js, grupovivo.js, carregados antes deste); aqui a função só é procurada na hora de abrir a página.
const ROTAS = {
  visao: () => paginaVisao(), ganhos: (_, params) => paginaGanhos({ endereco: params }), links: () => paginaLinks(), grupos: () => paginaGrupos(), blocos: () => paginaBlocos(),
  'disparo-manual': () => paginaDisparoManual(), 'disparo-automatico': () => paginaRegras(),
  'disparar-mensagem': () => paginaDispararMensagem(), 'grupo-vivo': () => paginaGrupoVivo(), templates: () => paginaTemplates(),
  relatorios: () => paginaRelatorios(),
  conexoes: (pedido) => paginaConexoes({ rolarPara: pedido === 'etiquetas' ? 'ml-etiquetas' : '' }),
  numeros: () => paginaNumeros(), equipe: () => paginaEquipe(),
  historico: (_, params) => paginaHistorico('', params), ajustes: () => paginaAjustes(),
  docs: (pedido) => paginaDocs(pedido), // docs.js decide o capítulo e a seção pelo pedido ('docs' + o sufixo já validado por ir())
};
// Endereços antigos continuam abrindo a página nova (favoritos, links da ajuda). #etiquetas rola até a seção em Conexões.
const ALIASES = { regras: 'disparo-automatico', whatsapp: 'numeros', etiquetas: 'conexoes', ajuda: 'docs' };
// Telas de duas colunas (formulário à esquerda, acompanhamento à direita) usam main.larga.
const ROTAS_LARGAS = new Set(['disparo-manual', 'disparar-mensagem']);
// Equipe e Ganhos são só do Dono. Sem login (auth desligada) usuario é null e o painel se comporta como Dono.
// O mesmo critério esconde do Operador: Desconectar (Números), Apagar agora (Ajustes), Gerar novo token (Conexões) e,
// em Relatórios e avisos, Enviar teste, Adicionar número, Remover e a troca do número.
// Sem o estado carregado (S.st ainda vazio) não se sabe o papel: devolve false, para o painel nunca chamar rota do Dono
// (o Operador levaria 403). `#equipe` e `#ganhos` abertos de cara são retomados por `ir()` quando o estado chega.
const ROTAS_DO_DONO = new Set(['equipe', 'ganhos']);
const podeEquipe = () => !!S.st && (!S.st.usuario || S.st.usuario.papel === 'dono');
/** Rota que está aberta: resolve os nomes antigos e manda rota desconhecida (ou Equipe para o Operador) para a Visão Geral. */
function rotaAtual() {
  const pedido = (location.hash || '#visao').slice(1).split('?')[0].split('/')[0]; const r = Object.hasOwn(ALIASES, pedido) ? ALIASES[pedido] : pedido; // #docs/<cap>/<secao> é a rota docs
  return Object.hasOwn(ROTAS, r) && (!ROTAS_DO_DONO.has(r) || podeEquipe()) ? r : 'visao';
}
function ir() {
  const [pedido, consulta = ''] = (location.hash || '#visao').slice(1).split('?');
  // Página só do Dono pedida antes de o estado chegar: não se sabe o papel, então não abre nem reescreve o endereço; o carregar() inicial chama ir().
  if (!S.st && ROTAS_DO_DONO.has(pedido.split('/')[0])) return;
  const r = rotaAtual();
  // só o Histórico e Ganhos levam filtros no endereço (Ganhos os confere em ganhosLerEndereco e reescreve o endereço com os
  // valores aceitos); só os Docs levam capítulo e seção (#docs/<cap>[/<secao>]), mesmo que o capítulo não exista
  const comFiltros = r === 'historico' || r === 'ganhos';
  const sufixo = r === 'docs' && /^docs(\/[a-z0-9-]+){1,2}$/.test(pedido) ? pedido.slice(4) : '';
  const endereco = '#' + r + (comFiltros && consulta ? '?' + consulta : '') + sufixo;
  if (location.hash !== endereco) history.replaceState(null, '', endereco); // o endereço passa a mostrar a página aberta
  $$('#rail nav a').forEach((a) => { if (a.getAttribute('href') === '#' + r) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  $('#menu-atual').textContent = '· ' + ($(`#rail nav a[href="#${r}"]`)?.textContent || '');
  $('main').classList.toggle('larga', ROTAS_LARGAS.has(r));
  fecharMenu();
  const pg = $('#pagina'); pg.onclick = null; pg.innerHTML = ''; // tratadores da tela anterior não podem vazar para a próxima
  if ($('#dlg').open) $('#dlg').close();
  ROTAS[r](r === 'docs' ? 'docs' + sufixo : pedido, comFiltros ? new URLSearchParams(consulta) : null); // só o Histórico e Ganhos leem filtros do endereço
}

// ---------- menu em telas estreitas (≤ 900 px): o botão "Menu" abre os grupos sobre o conteúdo ----------
const menuAberto = () => $('#rail').classList.contains('aberto');
function abrirMenu() { $('#rail').classList.add('aberto'); $('#menu-btn').setAttribute('aria-expanded', 'true'); }
function fecharMenu() {
  if (!menuAberto()) return;
  const rail = $('#rail'); const btn = $('#menu-btn'); const foco = document.activeElement;
  rail.classList.remove('aberto'); btn.setAttribute('aria-expanded', 'false');
  // O foco estava num item que agora some: volta ao botão. Não rouba o foco de um campo tocado fora do menu.
  if (!foco || foco === document.body || (rail.contains(foco) && foco !== btn)) btn.focus();
}
$('#menu-btn').onclick = () => (menuAberto() ? fecharMenu() : abrirMenu());
$('#rail').addEventListener('click', (e) => { if (e.target.closest('a')) fecharMenu(); }); // inclusive o item da página já aberta
document.addEventListener('click', (e) => { if (menuAberto() && !$('#rail').contains(e.target)) fecharMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menuAberto()) fecharMenu(); });

// ---------- conta no menu: pessoa, "Sair" e o item Equipe (só para o Dono) ----------
function pintarConta() {
  const u = S.st.usuario; const p = $('#pessoa');
  const html = u ? `<b>${esc(u.nome || '')}</b>${esc(u.email || '')}` : '';
  if (p.innerHTML !== html) p.innerHTML = html;
  p.hidden = !u; $('#sair').hidden = !S.st.auth;
  // Para o Operador o item não fica escondido: sai do DOM.
  const item = $('#rail nav a[href="#equipe"]');
  if (podeEquipe() && !item) $('#ng-conta').parentElement.insertAdjacentHTML('beforeend', '<a href="#equipe">Equipe</a>');
  if (!podeEquipe() && item) item.remove();
  if (!podeEquipe() && location.hash === '#equipe') ir();
  // "Ganhos" logo depois de Visão Geral (começo do grupo Principal), só para o Dono: para o Operador o item não existe no DOM
  const ganhos = $('#rail nav a[href="#ganhos"]');
  if (podeEquipe() && !ganhos) $('#ng-principal').insertAdjacentHTML('afterend', '<a href="#ganhos">Ganhos</a>');
  if (!podeEquipe() && ganhos) ganhos.remove();
  if (!podeEquipe() && location.hash.split('?')[0] === '#ganhos') ir(); // #ganhos?bloco=… também (pela rota, antes do "?")
  // ofertas do catálogo que esperam revisão, no item Histórico (só o Dono revisa)
  const hist = $('#rail nav a[href="#historico"]');
  if (hist) {
    const n = podeEquipe() ? Number(S.st.catalogo?.para_revisar) || 0 : 0; const txt = n > 0 ? `Histórico (${n})` : 'Histórico';
    if (hist.textContent !== txt) {
      hist.textContent = txt;
      if (n > 0) hist.setAttribute('aria-label', `Histórico, ${n} ${n === 1 ? 'oferta' : 'ofertas'} para revisar`); else hist.removeAttribute('aria-label');
      if (hist.getAttribute('aria-current') === 'page') $('#menu-atual').textContent = '· ' + txt;
    }
  }
}
async function atualizarEstado(forcar) {
  const antes = S.st?.whatsapp || {}; const papelAntes = S.st?.usuario?.papel; const hashAntes = location.hash;
  S.st = await api('/state'); faixa(); pintarConta();
  // O Dono trocou o papel desta pessoa: redesenha a página aberta (botões só do Dono aparecem ou somem).
  // Se era a Equipe, pintarConta já levou para a Visão Geral (o endereço mudou).
  const papel = S.st.usuario?.papel;
  if (papelAntes && papel && papel !== papelAntes) { if (location.hash === hashAntes) ir(); return; }
  const w = S.st.whatsapp; const r = rotaAtual();
  const mudou = antes.status !== w.status;
  if ((r === 'numeros' && (forcar || mudou || antes.qr !== w.qr)) || (r === 'grupos' && (forcar || mudou))) {
    if (w.status === 'open') [S.groups, S.blocks] = await Promise.all([api('/groups'), api('/blocks')]);
    if (r === 'numeros') paginaNumeros(); else paginaGrupos();
  }
  if (r === 'conexoes') pintarEstadoML();
  if (r === 'ajustes' || r === 'numeros') pintarProtecaoUso();
}
window.addEventListener('hashchange', ir);
carregar().then(() => {
  faixa(); pintarConta(); ir();
  $('#sair').onclick = tentar(async () => { await api('/logout', 'POST'); location.replace('/login.html'); });
  if (S.st.usuario?.precisa_completar) completarCadastro();
}).catch((e) => aviso(e.message, true));
setInterval(() => atualizarEstado().catch(() => {}), 3000);
setInterval(() => { if (rotaAtual() === 'disparo-automatico' && !$('#dlg').open) recarregarRegras().catch(() => {}); }, 10000);
// Grupo vivo: o próximo horário e a contagem de 24 h chegam sem recarregar (gvAtualizar não repinta à toa nem rouba o foco)
setInterval(() => { if (rotaAtual() === 'grupo-vivo' && !$('#dlg').open) gvAtualizar().catch(() => {}); }, 10000);
