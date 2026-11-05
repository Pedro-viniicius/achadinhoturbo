// Ganhos e rastreio (plano docs/produto/planos/dashboard-ganhos.md, etapas 9 e 17; spec docs/produto/specs/dashboard-ganhos.md).
// Entrega A: o Dono associa códigos de rastreio a blocos e grupos (fieldset no formulário do Bloco e diálogo de exceção em
// Grupos) e vê a cobertura do rastreio (M9) e o alcance das associações (M10) na página #ganhos.
// Entrega B: a mesma página ganha o Dashboard (cartões M1–M15 e tabelas por grupo, bloco, loja, oferta e dia, de GET /api/ganhos),
// o diálogo "Importar comissões" (relatório CSV da loja, com prévia antes de gravar) e o diálogo "Gasto com anúncios".
// Tudo aqui é só do Dono (decisão P2): o Operador não tem o item de menu, a página, a coluna Rastreio nem o fieldset, e o
// painel nunca chama /api/rastreio nem /api/ganhos como Operador (daria 403).
// Todo texto que veio de um arquivo CSV (título, código, nome de coluna) passa por esc(): o servidor não higieniza HTML.
// Usa os utilitários globais de app.js ($, $$, esc, api, aviso, tentar, mostrarErros, podeEquipe, rotaAtual, S) e de
// paineis.js (fmtPct, nomeGrupo); eles só são chamados depois que todos os scripts carregaram.

const GANHOS_LOJAS = [['mercadolivre', 'Mercado Livre'], ['amazon', 'Amazon'], ['shopee', 'Shopee']];
const GANHOS_NOME_LOJA = Object.fromEntries(GANHOS_LOJAS);
const GANHOS_PERIODOS = [['7d', '7 dias'], ['30d', '30 dias'], ['mes', 'Mês atual'], ['mes_passado', 'Mês passado'], ['custom', 'Personalizado']];
const GANHOS_MAX_GRUPOS = 25; // "Mostrar mais" a partir daqui
const GANHOS_LIMIAR_LOJA = 80; // loja abaixo disto leva o selo "Atenção" (spec)
const GANHOS_TOP_OFERTAS = 10; // "Ver todas" a partir daqui
const GANHOS_MAX_IMPORTACOES = 10; // importações recentes à vista
// Limites do servidor (src/csv.js MAX_BYTES_ARQUIVO; src/ganhos.js MAX_DIAS_GASTO e MAX_NOTA): o painel recusa antes de enviar; test/ganhos-painel.test.js confere.
const GANHOS_MAX_BYTES = 5 * 1024 * 1024;
const GANHOS_MAX_DIAS_GASTO = 366;
const GANHOS_MAX_NOTA = 200;
const GANHOS_MAX_CENTAVOS = 10_000_000_000; // R$ 100 milhões, como o servidor
const GANHOS_ORDEM_IMPORTADO = ['shopee', 'amazon', 'mercadolivre'];
// Mesmas regras do servidor (src/rastreio.js validarCodigo): o painel confere o formato antes de enviar para marcar o campo.
const RASTREIO_RE_SUB_ID = /^[A-Za-z0-9]{1,30}$/;
const RASTREIO_RE_TAG_AMAZON = /^[A-Za-z0-9_-]{2,64}$/;

// `foco`: seletor do controle que deve receber o foco quando a página terminar de ser redesenhada por um filtro ('' = não mexer).
// `ordem`: coluna e sentido da tabela "Por grupo"; `dados`: o que a última carga trouxe ({ blocos, cob, din }), para ordenar e
// "Mostrar mais" sem pedir tudo de novo.
const GANHOS = { periodo: '30d', bloco: '', loja: '', de: '', ate: '', todos: false, todosGrupo: false, todasOfertas: false, ordem: { col: 'comissao', dir: 'desc' }, dados: null, ger: 0, foco: '' };
/** Associações já carregadas (GET /api/rastreio/codigos). `carregado` falso = não sei: a tela não oferece edição às cegas. */
const RASTREIO = { codigos: [], carregado: false, fresco: 0 };

const TEXTOS_GANHOS = {
  sub: 'Quanto cada grupo rendeu, com base nas comissões que você importa dos portais.',
  semImportacao: 'Importe o relatório para ver.',
  semEnvios: 'Sem envios no período.',
  semEnviosDica: 'Os links continuam saindo como hoje enquanto você não configurar nada.',
  nadaEsperado: 'Nenhum envio do período esperava código de rastreio, porque nenhum grupo ou bloco tem código associado. Os links saem como hoje.',
  erroCarregar: 'Não consegui carregar os ganhos.',
  niveis: { boa: ['Boa', 'conectado'], parcial: ['Parcial', 'pendente'], baixa: ['Baixa', 'erro'] }, // [palavra, classe .estado-pill]
  bloco: {
    titulo: 'Códigos de rastreio (opcional)',
    intro: 'Para separar o ganho deste nicho. Sem preencher, nada muda: os links saem como hoje.',
    amazonDica: 'Sem ele, vale a tag padrão da sua conta.',
    shopeeDica: 'Só no bloco: cada Sub_id pede um link a mais à Shopee. Hoje o Sub_id só sai pela API de afiliados da Shopee; sem ela, o link sai sem Sub_id, como hoje.',
    mlDica: 'Sem escolher, vale a etiqueta do disparo.',
    atalho: 'Usar a mesma etiqueta do bloco',
    naoCarregou: 'Não consegui carregar os códigos de rastreio agora. Recarregue a página para editá-los.',
    cartaoPadrao: 'Rastreio: padrão de cada loja',
  },
  grupo: {
    titulo: (nome) => `Rastreio do grupo ${nome}`,
    intro: 'Vale só para este grupo e vence o código do bloco. Deixe vazio para voltar ao do bloco.',
    shopee: 'Na Shopee o código vale por bloco, não por grupo.',
    mlDica: 'Sem escolher, vale a do bloco; sem bloco, a etiqueta do disparo.',
    salvar: 'Salvar rastreio',
  },
  erros: {
    amazonNumero: 'Isso parece um ID de afiliado. O ID de rastreamento da Amazon tem letras e termina em -20.',
    amazon: 'O ID de rastreamento da Amazon costuma terminar em -20, como casa-20. Confira em Gerenciar IDs de rastreamento.',
    shopee: 'O Sub_id aceita só letras e números, sem espaços (até 30 caracteres).',
  },
  shopeeSemApi: 'Hoje o Sub_id só sai pela API de afiliados da Shopee; sem ela, o link sai sem Sub_id.',
  erroDinheiro: 'Não consegui carregar os valores em reais.',
  semMovimento: 'Nenhuma comissão neste período e filtro.',
  vazio: {
    titulo: 'Ainda não há ganhos para mostrar',
    passo1: ['1. Rastreie os links por grupo', ' (opcional, mas é o que separa o ganho por grupo): em Blocos de análise, informe um código por bloco.'],
    passo2: ['2. Baixe o relatório de comissões', ' no portal de cada loja (Shopee, Amazon, Mercado Livre) e importe aqui.'],
    passo3: ['3. Informe o gasto com anúncios', ', se quiser saber o custo por membro novo.'],
    rodape: 'Os links continuam saindo como hoje enquanto você não configurar nada.',
  },
  comoLer: [
    'Comissão é a soma das comissões importadas no período, sem as canceladas, pela data da venda. “Confirmada” é só a que o portal já confirmou.',
    'Cliques vêm do relatório de cliques da loja que você importa, não do Rotacionador de Links. Sem esse relatório, ganho por clique e conversão ficam em “—”, e só contam as lojas que têm cliques importados no período.',
    '“Sem grupo identificado” é a venda cujo código não é de nenhum grupo ou bloco seu, ou que saiu com o código padrão da loja. Ela entra no total, mas em nenhum grupo.',
    'Cobertura que não chega ao total quer dizer que algum link saiu sem o código: Sub_id recusado, limite da Shopee ou etiqueta que falhou.',
    'O gasto é repartido igualmente pelos dias do período informado. Custo por membro novo é o gasto dividido pelas entradas no mesmo período; só existe para quem tem gasto próprio (um grupo ou um bloco). As entradas valem só dentro do prazo de guarda de Ajustes.',
  ],
  importar: {
    titulo: 'Importar comissões ou cliques',
    intro: 'Baixe o relatório no portal da loja e envie o arquivo CSV. Até 5 MB. Dados de comprador não são lidos nem guardados.',
    semLoja: 'Escolha a loja do arquivo: Shopee, Amazon ou Mercado Livre.',
    semArquivo: 'Escolha o arquivo CSV do relatório.',
    tipoErrado: 'Este arquivo não é um CSV. Baixe o relatório do portal em CSV e tente de novo.',
    grande: 'O arquivo tem mais de 5 MB. Baixe o relatório de um período menor (um mês por vez).',
    semConexao: 'Não consegui importar agora. Nada foi salvo. Tente de novo; se repetir, veja o histórico do programa.',
    soDono: 'Só o Dono pode importar comissões.',
    dicas: {
      '': 'Escolha a loja para ver onde baixar o relatório.',
      shopee: 'No portal Shopee Afiliados, baixe o relatório de conversões (vendas) em CSV.',
      amazon: 'Na Central de Associados da Amazon, baixe o relatório de ganhos (pedidos) em CSV.',
      mercadolivre: 'Na Central de Afiliados do Mercado Livre, baixe o relatório de comissões em CSV.',
      cliques: 'Relatório de cliques por dia da loja, em CSV. É dele que vem o ganho por clique.',
    },
    campos: { data: 'Data', pedido: 'Pedido', loja_id: 'Loja', produto: 'Produto', titulo: 'Título', codigo: 'Código de rastreio', venda: 'Valor da venda', comissao: 'Comissão', status: 'Status', quantidade: 'Quantidade', devolucoes: 'Devoluções', cliques: 'Cliques' },
  },
  gasto: {
    titulo: 'Gasto com anúncios',
    intro: 'Informe quanto pagou de anúncio. O painel divide pelo número de entradas no mesmo período. Um gasto de vários dias é repartido igualmente por dia.',
    vazio: 'Nenhum gasto informado. Sem ele não dá para calcular o custo por membro novo.',
    periodo: 'Escolha o período do gasto.',
    ordem: 'A data final não pode ser antes da inicial.',
    longo: `O período do gasto vai até ${GANHOS_MAX_DIAS_GASTO} dias. Divida em partes menores.`,
    alvo: 'Escolha para qual grupo ou bloco vale o gasto.',
    valorFormato: 'Digite o valor em reais, por exemplo 150,00.',
    valorZero: 'O valor precisa ser maior que zero.',
    nota: `A observação vai até ${GANHOS_MAX_NOTA} caracteres.`,
  },
};

// ---------- associações de código de rastreio (blocos e grupos) ----------

/** Códigos de um alvo por loja: `{ mercadolivre, amazon, shopee }` ('' = sem associação). */
function rastreioDe(tipo, alvo) {
  const v = { mercadolivre: '', amazon: '', shopee: '' };
  for (const c of RASTREIO.codigos) if (c.alvo_tipo === tipo && String(c.alvo) === String(alvo) && Object.hasOwn(v, c.loja)) v[c.loja] = String(c.codigo ?? '');
  return v;
}

/** Lê as associações do servidor. Operador não chama. Devolve true se algo mudou desde a leitura anterior. */
async function rastreioCarregar() {
  if (!podeEquipe()) return false;
  if (Date.now() - RASTREIO.fresco < 5000) { RASTREIO.fresco = 0; return false; } // acabou de gravar: a resposta do PUT já trouxe a lista inteira
  const r = await api('/rastreio/codigos');
  const novos = Array.isArray(r.codigos) ? r.codigos : [];
  const mudou = !RASTREIO.carregado || JSON.stringify(novos) !== JSON.stringify(RASTREIO.codigos);
  RASTREIO.codigos = novos; RASTREIO.carregado = true;
  return mudou;
}

/** "ML x · Amazon y · Shopee z" (só o que existe) dos códigos de um alvo, ou '' se nenhum. Os valores vão por esc(). */
function rastreioSelosHtml(v, lojas = ['mercadolivre', 'amazon', 'shopee']) {
  const nome = { mercadolivre: 'ML', amazon: 'Amazon', shopee: 'Shopee' };
  return lojas.filter((l) => v[l]).map((l) => `<span class="chip rastreio-selo">${nome[l]} <b>${esc(v[l])}</b></span>`).join(' ');
}

/** Linha do cartão do bloco: "Rastreio: …" (só Dono, com os códigos carregados); senão ''. */
function rastreioLinhaBloco(id) {
  if (!podeEquipe() || !RASTREIO.carregado) return '';
  const selos = rastreioSelosHtml(rastreioDe('bloco', id));
  return `<p class="dica" style="margin:0">${selos ? `Rastreio: ${selos}` : TEXTOS_GANHOS.bloco.cartaoPadrao}</p>`;
}

/**
 * Campos de código de rastreio, um por loja (`name="rastreio_<loja>"`), dentro de um `details` fechado quando estão todos
 * vazios. tipo 'bloco': ML (nome da etiqueta), Amazon e Shopee; tipo 'grupo': só ML e Amazon (P6: Sub_id só por bloco).
 */
function rastreioCamposHtml({ tipo, valores, aberto }) {
  const T = TEXTOS_GANHOS; const bloco = tipo === 'bloco'; const ml = valores.mercadolivre || '';
  const aberta = aberto ?? Object.values(valores).some(Boolean);
  const conhecida = !ml || S.tags.some((t) => t.name === ml);
  const opcoes = '<option value="">Nenhuma</option>'
    + (conhecida ? '' : `<option value="${esc(ml)}" selected>${esc(ml)} (não cadastrada)</option>`)
    + S.tags.map((t) => `<option value="${esc(t.name)}"${t.name === ml ? ' selected' : ''}>${esc(t.name)}</option>`).join('');
  const abre = bloco ? `<details class="rastreio"${aberta ? ' open' : ''}><summary>${T.bloco.titulo}</summary>
    <fieldset class="rastreio-campos"><legend class="sr-only">${T.bloco.titulo}</legend>`
    : `<fieldset class="rastreio rastreio-campos"><legend>${T.bloco.titulo}</legend>`;
  return `${abre}
      ${bloco ? `<p class="dica" style="margin:0">${T.bloco.intro} ${q('rastreio')}</p>` : ''}
      <label class="campo"><span>Etiqueta do Mercado Livre ${q('rastreio.etiqueta')}</span><select name="rastreio_mercadolivre">${opcoes}</select>
        <small>${bloco ? T.bloco.mlDica : T.grupo.mlDica}</small>
        ${bloco ? `<button type="button" class="leve" data-usar-etiqueta hidden>${T.bloco.atalho}</button>` : ''}</label>
      <label class="campo"><span>ID de rastreamento da Amazon ${q('rastreio.amazon')}</span><input name="rastreio_amazon" value="${esc(valores.amazon || '')}" placeholder="Ex.: casa-20" maxlength="64" autocomplete="off" spellcheck="false">
        <small>${T.bloco.amazonDica}</small></label>
      ${bloco ? `<label class="campo"><span>Sub_id da Shopee ${q('rastreio.shopee')}</span><input name="rastreio_shopee" value="${esc(valores.shopee || '')}" placeholder="Ex.: casa" maxlength="30" autocomplete="off" spellcheck="false">
        <small>${T.bloco.shopeeDica}</small></label>` : `<small class="dica">${T.grupo.shopee}</small>`}
      <p class="dica rastreio-previa" data-previa style="margin:0"></p>
    </fieldset>${bloco ? '</details>' : ''}`;
}

/** Lojas que o formulário de cada tipo tem. */
const rastreioLojasDe = (tipo) => (tipo === 'bloco' ? ['mercadolivre', 'amazon', 'shopee'] : ['mercadolivre', 'amazon']);

/** Valores digitados (sem espaços nas pontas), por loja. */
function rastreioLer(raiz, lojas) {
  const v = {};
  for (const l of lojas) v[l] = String($(`[name=rastreio_${l}]`, raiz)?.value ?? '').trim();
  return v;
}

/** O que o servidor recusaria pelo formato (mesmas frases). → [{ msg, el }] */
function rastreioErros(novos, raiz) {
  const T = TEXTOS_GANHOS.erros; const erros = [];
  const a = novos.amazon;
  if (a) {
    if (/^\d+$/.test(a)) erros.push({ msg: T.amazonNumero, el: $('[name=rastreio_amazon]', raiz) });
    else if (!RASTREIO_RE_TAG_AMAZON.test(a)) erros.push({ msg: T.amazon, el: $('[name=rastreio_amazon]', raiz) });
  }
  if (novos.shopee && !RASTREIO_RE_SUB_ID.test(novos.shopee)) erros.push({ msg: T.shopee, el: $('[name=rastreio_shopee]', raiz) });
  return erros;
}

/** Só o que mudou em relação ao que já estava gravado ('' apaga). Nada mudou, nada vai ao servidor (CA9). */
function rastreioMudancas(tipo, alvo, novos, antigos) {
  return Object.keys(novos).filter((l) => novos[l] !== (antigos[l] || '')).map((loja) => ({ loja, alvo_tipo: tipo, alvo: String(alvo), codigo: novos[loja] }));
}

/** PUT das mudanças (tudo ou nada, no servidor). Devolve quantas associações foram enviadas. Erro: a frase do servidor. */
async function rastreioGravar(tipo, alvo, novos, antigos) {
  const lista = rastreioMudancas(tipo, alvo, novos, antigos);
  if (!lista.length) return 0;
  const r = await api('/rastreio/codigos', 'PUT', { associacoes: lista });
  if (Array.isArray(r.codigos)) { RASTREIO.codigos = r.codigos; RASTREIO.carregado = true; RASTREIO.fresco = Date.now(); }
  return lista.length;
}

/** "Como vai sair o link" em texto, conforme os campos (a prévia da spec). */
function rastreioPrevia(raiz, tipo) {
  const T = TEXTOS_GANHOS; const alvo = $('[data-previa]', raiz); if (!alvo) return;
  const v = rastreioLer(raiz, rastreioLojasDe(tipo)); const bloco = tipo === 'bloco';
  const sem = bloco ? null : 'o do bloco, se houver; senão o padrão';
  const partes = [
    `Amazon: ${v.amazon ? `usa ${v.amazon}` : (sem || 'tag padrão da sua conta')}.`,
    bloco ? `Shopee: ${v.shopee ? `usa o Sub_id ${v.shopee}. ${T.shopeeSemApi}` : 'link sem Sub_id.'}` : '',
    `Mercado Livre: ${v.mercadolivre ? `etiqueta ${v.mercadolivre}` : (sem || 'etiqueta do disparo (você não escolheu uma)')}.`,
  ];
  alvo.textContent = `Como vai sair o link — ${partes.filter(Boolean).join(' ')}`;
}

/** Mostra o atalho "usar a mesma etiqueta do bloco" só quando a associação do ML está vazia e o bloco tem tag_id. */
function rastreioAtalho(raiz) {
  const btn = $('[data-usar-etiqueta]', raiz); if (!btn) return;
  const tag = String($('[name=tag_id]', raiz)?.value ?? ''); const ml = String($('[name=rastreio_mercadolivre]', raiz)?.value ?? '');
  btn.hidden = !(tag && !ml);
}

/** Atalho: copia a etiqueta do bloco (select tag_id, por id) para o campo do ML (por nome). */
function rastreioUsarEtiquetaDoBloco(raiz) {
  const id = String($('[name=tag_id]', raiz)?.value ?? '');
  const tag = id ? S.tags.find((t) => String(t.id) === id) : null;
  const campo = $('[name=rastreio_mercadolivre]', raiz);
  if (!tag || !campo) return;
  campo.value = tag.name;
  rastreioPrevia(raiz, 'bloco'); rastreioAtalho(raiz);
}

/** Liga a prévia e o atalho depois que o HTML dos campos entrou no diálogo. */
function rastreioLigar(raiz, tipo) {
  const campos = $('.rastreio-campos', raiz); if (!campos) return;
  const atualizar = () => { rastreioPrevia(raiz, tipo); rastreioAtalho(raiz); };
  campos.oninput = atualizar; campos.onchange = atualizar;
  const tag = $('[name=tag_id]', raiz); if (tag && tipo === 'bloco') tag.onchange = atualizar;
  const atalho = $('[data-usar-etiqueta]', raiz); if (atalho) atalho.onclick = () => rastreioUsarEtiquetaDoBloco(raiz);
  atualizar();
}

/**
 * Ids dos blocos de um grupo, pela lista de blocos (S.blocks[].group_jids), que é recarregada ao salvar um bloco.
 * `g.blocks` de S.groups só é relido ao atualizar a lista de grupos e fica velho depois de editar um bloco. Sem a lista
 * de blocos carregada, cai no que o grupo traz.
 */
function rastreioBlocosDoGrupo(g) {
  if (!Array.isArray(S.blocks)) return g.blocks || [];
  return S.blocks.filter((b) => (b.group_jids || []).includes(g.jid)).map((b) => b.id);
}

/** Célula "Rastreio" da tabela de Grupos (só Dono): "Do bloco"/"Padrão" + Definir, ou os selos da exceção + Editar. */
function rastreioCelulaGrupo(g) {
  if (!RASTREIO.carregado) return '<span class="dica" title="Carregando os códigos de rastreio">—</span>';
  const botao = (acao) => `<button type="button" class="leve" data-rastreio="${esc(g.jid)}" aria-label="${acao} código de rastreio do grupo ${esc(g.name)}">${acao}</button>`;
  const selos = rastreioSelosHtml(rastreioDe('grupo', g.jid), ['mercadolivre', 'amazon']);
  if (selos) return `<div class="rastreio-celula">${selos} ${botao('Editar')}</div>`;
  const doBloco = rastreioBlocosDoGrupo(g).some((id) => RASTREIO.codigos.some((c) => c.alvo_tipo === 'bloco' && String(c.alvo) === String(id)));
  return `<div class="rastreio-celula"><span class="dica">${doBloco ? 'Do bloco' : 'Padrão'}</span> ${botao('Definir')}</div>`;
}

/** "A, B e C". */
const rastreioLista = (nomes) => (nomes.length < 2 ? nomes.join('') : `${nomes.slice(0, -1).join(', ')} e ${nomes.at(-1)}`);

/**
 * Aviso do grupo que está em dois ou mais blocos com códigos diferentes para a mesma loja (ML ou Amazon, as que o
 * diálogo do grupo decide). O servidor usa o bloco de menor id (src/rastreio.js resolver): o "mais antigo".
 */
function rastreioAvisoBlocos(g) {
  const ids = [...rastreioBlocosDoGrupo(g)].sort((a, b) => a - b); const emConflito = new Set();
  for (const loja of ['mercadolivre', 'amazon']) {
    const com = ids.map((id) => ({ id, codigo: rastreioDe('bloco', id)[loja] })).filter((x) => x.codigo);
    if (new Set(com.map((x) => x.codigo)).size > 1) com.forEach((x) => emConflito.add(x.id));
  }
  if (emConflito.size < 2) return '';
  const nome = (id) => S.blocks.find((b) => b.id === id)?.name || `bloco ${id}`;
  const lista = [...emConflito].sort((a, b) => a - b);
  return `<div class="aviso-impl" role="status"><p>Este grupo está nos blocos ${esc(rastreioLista(lista.map(nome)))} com códigos diferentes. O do bloco ${esc(nome(lista[0]))} (o mais antigo) é usado. Defina aqui para decidir.</p></div>`;
}

/** Diálogo "Rastreio do grupo <nome>": exceção só deste grupo (ML e Amazon). Só o Dono; sem os códigos carregados, não abre. */
function rastreioFormGrupo(jid) {
  const g = S.groups.find((x) => x.jid === jid);
  if (!podeEquipe() || !RASTREIO.carregado || !g) return;
  const T = TEXTOS_GANHOS; const dlg = $('#dlg'); const antigos = rastreioDe('grupo', jid);
  dlg.innerHTML = `<form method="dialog" id="f" novalidate><h1 tabindex="-1">${esc(T.grupo.titulo(g.name))}</h1>
    <p class="sub" style="margin:-8px 0 12px">${T.grupo.intro} ${q('rastreio.grupo')}</p>
    ${rastreioAvisoBlocos(g)}
    ${rastreioCamposHtml({ tipo: 'grupo', valores: antigos, aberto: true })}
    <div class="rodape"><button type="button" id="cancelar">Cancelar</button><button class="pri">${T.grupo.salvar}</button></div></form>`;
  rastreioLigar(dlg, 'grupo');
  $('#cancelar').onclick = () => dlg.close();
  $('#f').onsubmit = tentar(async (ev) => {
    ev.preventDefault();
    const novos = rastreioLer(dlg, rastreioLojasDe('grupo'));
    if (mostrarErros(dlg, rastreioErros(novos, dlg))) return;
    let enviadas = 0;
    try { enviadas = await rastreioGravar('grupo', jid, novos, antigos); } catch (e) { mostrarErros(dlg, [{ msg: e.message }]); return; }
    dlg.close();
    if (!enviadas) return; // nada mudou: nada foi gravado
    aviso('Rastreio salvo');
    if (rotaAtual() === 'grupos') {
      paginaGrupos();
      $$('[data-rastreio]').find((b) => b.dataset.rastreio === jid)?.focus(); // o botão que abriu o diálogo foi redesenhado
    }
  });
  dlg.showModal();
  $('h1', dlg)?.focus();
}

// ---------- página Ganhos (só o Dono) ----------

/** Cobertura (razão 0 a 1 ou null) em pontos percentuais com uma casa, como a tela mostra. */
const ganhosPorcento = (r) => (r == null ? null : Math.round(r * 1000) / 10);

/** Nível da cobertura pela spec (>= 90 Boa, 60 a 89 Parcial, < 60 Baixa), sobre o valor arredondado; null sem nível. */
function ganhosNivel(r) {
  const p = ganhosPorcento(r); if (p == null) return null;
  const chave = p >= 90 ? 'boa' : p >= 60 ? 'parcial' : 'baixa';
  return { chave, rotulo: TEXTOS_GANHOS.niveis[chave][0], classe: TEXTOS_GANHOS.niveis[chave][1] };
}
const ganhosPilula = (r) => { const n = ganhosNivel(r); return n ? `<span class="estado-pill ${n.classe}">${n.rotulo}</span>` : ''; };
const ganhosNomeLoja = (l) => esc(GANHOS_NOME_LOJA[l] || l);

// ---------- formatação do Dashboard ("—" para tudo que o servidor devolve null: divisão por zero ou sem dado) ----------

/** Centavos → "R$ 1.234,50". `casas`: até quantas decimais mostrar (o ganho por clique vale centavos; mínimo sempre 2). */
const ganhosBrl = (centavos, casas = 2) => (typeof centavos !== 'number' || !Number.isFinite(centavos) ? '—'
  : (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: casas }));
const ganhosNum = (n) => (typeof n !== 'number' || !Number.isFinite(n) ? '—' : n.toLocaleString('pt-BR'));
/** Razão 0–1 → "47,6%" (`casas` decimais no máximo). */
const ganhosRazao = (r, casas = 1) => (typeof r !== 'number' || !Number.isFinite(r) ? '—' : `${(r * 100).toLocaleString('pt-BR', { maximumFractionDigits: casas })}%`);
/** 'AAAA-MM-DD' → 'DD/MM/AAAA'; qualquer outra coisa volta escapada (o servidor garante o formato, mas a tela não confia). */
const ganhosDataCompleta = (ymd) => (/^\d{4}-\d{2}-\d{2}$/.test(String(ymd)) ? String(ymd).split('-').reverse().join('/') : esc(ymd));
const ganhosDiaMes = (ymd) => (/^\d{4}-\d{2}-\d{2}$/.test(String(ymd)) ? dataBR(ymd) : esc(ymd));
const ganhosTamanho = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`);
const ganhosSingPlural = (n, um, varios) => (n === 1 ? um : varios);

/**
 * Texto em reais ("1.234,50", "150", "R$ 10,00", "1234.5") → centavos inteiros, ou null se não for dinheiro. Conta em inteiros
 * (nada de ponto flutuante). Ponto com 3 dígitos depois e sem vírgula é milhar (1.234 = 1234 reais), como no Brasil. Aceita 0 e
 * negativo (quem chama decide); mais de 2 casas decimais ou acima do teto do servidor é recusado.
 */
function ganhosLerReais(texto) {
  let t = String(texto ?? '').replace(/\s/g, '').replace(/^r\$/i, '');
  let negativo = false;
  if (t[0] === '-') { negativo = true; t = t.slice(1); }
  if (!/^\d[\d.,]*$/.test(t)) return null;
  let inteiro; let frac = '';
  const v = t.indexOf(',');
  if (v >= 0) {
    if (t.indexOf(',', v + 1) >= 0) return null;
    inteiro = t.slice(0, v); frac = t.slice(v + 1);
    if (!frac || !/^(\d{1,3}(\.\d{3})+|\d+)$/.test(inteiro)) return null;
    inteiro = inteiro.replace(/\./g, '');
  } else if (t.includes('.')) {
    if (/^\d{1,3}(\.\d{3})+$/.test(t)) inteiro = t.replace(/\./g, '');
    else if (/^\d+\.\d{1,2}$/.test(t)) [inteiro, frac] = t.split('.');
    else return null;
  } else inteiro = t;
  if (!/^\d{1,11}$/.test(inteiro) || !/^\d{0,2}$/.test(frac)) return null;
  const centavos = Number(inteiro) * 100 + Number((frac + '0').slice(0, 2));
  if (centavos > GANHOS_MAX_CENTAVOS) return null;
  return negativo ? -centavos : centavos;
}

/** Consulta de GET /api/rastreio/cobertura e de GET /api/ganhos (com `por`) pelos filtros da tela. */
function ganhosConsulta(por) {
  const p = new URLSearchParams({ periodo: GANHOS.periodo });
  if (GANHOS.periodo === 'custom') { if (GANHOS.de) p.set('de', GANHOS.de); if (GANHOS.ate) p.set('ate', GANHOS.ate); }
  if (GANHOS.bloco) p.set('bloco', GANHOS.bloco);
  if (GANHOS.loja) p.set('loja', GANHOS.loja);
  if (por) p.set('por', por);
  return '?' + p.toString();
}

function ganhosCoberturaHtml(cob) {
  const T = TEXTOS_GANHOS; const t = cob.total || {};
  const titulo = `<h2>Cobertura do rastreio ${q('ganhos.cobertura')}</h2>`;
  if (!t.envios) return `<div class="card cob-card">${titulo}<p class="cob-texto">${T.semEnvios}</p><p class="dica" style="margin:0">${T.semEnviosDica}</p></div>`;
  const p = ganhosPorcento(t.cobertura); const nivel = ganhosNivel(t.cobertura);
  const principal = nivel
    ? `<p class="cob-texto"><b>${fmtPct(p)}</b> dos links com rastreio configurado saíram com o código (${t.rastreados} de ${t.esperados} links). ${ganhosPilula(t.cobertura)}</p>
       <div class="cob-barra ${nivel.chave}" role="img" aria-label="Cobertura do rastreio: ${fmtPct(p)} (${nivel.rotulo})"><i style="width:${Math.min(100, Math.max(0, p))}%"></i></div>
       <p class="dica" style="margin:0">Rastreio configurado em <b>${fmtPct(ganhosPorcento(t.alcance))}</b> dos envios (${t.esperados} de ${t.envios} links). Os outros saíram com o código padrão de cada loja, como hoje.</p>`
    : `<p class="cob-texto"><b>—</b> ${T.nadaEsperado}</p>`;
  const lojas = (cob.por_loja || []).map((l) => {
    const n = ganhosNivel(l.cobertura);
    return n
      ? `<li><b>${ganhosNomeLoja(l.loja)}</b> ${fmtPct(ganhosPorcento(l.cobertura))} ${ganhosPilula(l.cobertura)} <span class="dica">${l.rastreados} de ${l.esperados} links com código</span></li>`
      : `<li><b>${ganhosNomeLoja(l.loja)}</b> <span class="dica">${l.envios} ${l.envios === 1 ? 'envio' : 'envios'}, nenhum com código configurado</span></li>`;
  }).join('');
  const avisos = (cob.por_loja || []).filter((l) => ganhosPorcento(l.cobertura) != null && ganhosPorcento(l.cobertura) < GANHOS_LIMIAR_LOJA)
    .map((l) => `<div class="aviso-impl" role="status"><p><b>Atenção.</b> Parte dos links de ${ganhosNomeLoja(l.loja)} saiu sem código de rastreio. ${l.loja === 'shopee'
      ? `A Shopee só aceita o código de rastreio quando você conecta sua conta de afiliado. Conecte em <a href="#conexoes">Conexões</a>.`
      : 'Configure em <a href="#blocos">Blocos de análise</a>.'}</p></div>`).join('');
  return `<div class="card cob-card">${titulo}${principal}${lojas ? `<ul class="cob-lojas">${lojas}</ul>` : ''}${avisos}</div>`;
}

function ganhosTabelaGrupos(cob) {
  const linhas = [...(cob.por_grupo || [])].sort((a, b) => (a.cobertura ?? 2) - (b.cobertura ?? 2) || b.envios - a.envios);
  if (!linhas.length) return '';
  const vistas = GANHOS.todos ? linhas : linhas.slice(0, GANHOS_MAX_GRUPOS);
  const cobCel = (g) => (g.cobertura == null ? '<span class="dica" title="Sem código configurado neste período">—<span class="sr-only"> sem código configurado</span></span>' : `${fmtPct(ganhosPorcento(g.cobertura))} ${ganhosPilula(g.cobertura)}`);
  const corpo = vistas.map((g) => `<tr><td>${esc(nomeGrupo(g.jid))}</td><td class="c-cob" data-rot="Cobertura">${cobCel(g)}</td><td class="c-num" data-rot="Envios">${g.envios}</td><td class="c-num" data-rot="Com código configurado">${g.esperados}</td><td class="c-num" data-rot="Com o código">${g.rastreados}</td></tr>`).join('');
  return `<h2 id="g-tabela-titulo" tabindex="-1" style="margin:20px 0 10px">Cobertura por grupo ${q('ganhos.cobertura')}</h2>
    <div class="card tabela tab-cob"><table><caption class="sr-only">Cobertura do rastreio por grupo, dos menos cobertos para os mais cobertos</caption>
      <thead><tr><th scope="col">Grupo</th><th scope="col">Cobertura</th><th scope="col">Envios</th><th scope="col">Com código configurado</th><th scope="col">Com o código</th></tr></thead><tbody>${corpo}</tbody></table></div>
    ${linhas.length > vistas.length ? `<button type="button" id="g-mais">Mostrar mais (${linhas.length - vistas.length})</button>` : ''}`;
}

// ---------- Dashboard: cartões M1–M15 ----------

/** Um cartão. `m` é a chave do cartão (data-m) e, com `dica`, a do TIPS ("ganhos.<dica>"). `nota` já vem pronta (html). */
const ganhosCartao = (m, rotulo, valor, nota = '', dica = m) => `<div class="kpi" data-m="${m}"><div class="rotulo">${rotulo} ${q('ganhos.' + dica)}</div><div class="valor">${valor}</div><div class="nota">${nota}</div></div>`;

/** Os 12 cartões do total do recorte. `semImp`: nenhuma importação — o que depende dela mostra "—" e diz o que fazer. */
function ganhosCartoesHtml(din, semImp) {
  const T = TEXTOS_GANHOS; const t = din.grupo.total; const lojaFiltrada = !!GANHOS.loja;
  const imp = (valor) => (semImp ? '—' : valor);
  const semImpNota = (nota) => (semImp ? T.semImportacao : nota);
  const semCliques = !t.cliques;
  const temGasto = typeof t.gasto === 'number';
  const retorno = typeof t.retorno === 'number' ? t.retorno : null;
  const cartoes = [
    ganhosCartao('comissao', 'Comissão', imp(ganhosBrl(t.comissao)), semImpNota(`Confirmada: ${ganhosBrl(t.comissao_confirmada)}`)),
    ganhosCartao('gasto', 'Gasto', ganhosBrl(t.gasto), temGasto ? 'Informado por você.' : '<button type="button" class="leve" id="g-informar">Informar</button>'),
    ganhosCartao('retorno', 'Retorno', imp(ganhosBrl(retorno)),
      semImp ? T.semImportacao : retorno != null ? (retorno > 0 ? 'Deu lucro: comissão menos gasto.' : retorno < 0 ? 'Deu prejuízo: comissão menos gasto.' : 'Sem lucro nem prejuízo.')
        : lojaFiltrada ? 'Não é calculado com filtro de loja.' : 'Informe o gasto para calcular.'),
    ganhosCartao('custo', 'Custo por membro novo', ganhosBrl(t.custo_membro), !temGasto ? 'Informe o gasto para calcular.' : !t.entradas ? 'Sem entradas no período.' : 'Gasto ÷ entradas do período.'),
    ganhosCartao('receita', 'Valor vendido', imp(ganhosBrl(t.receita)), semImpNota('Soma do valor das compras.'), 'receita'),
    ganhosCartao('vendas', 'Vendas (itens)', imp(ganhosNum(t.vendas)), semImpNota('Itens vendidos nas linhas importadas.')),
    ganhosCartao('cliques', 'Cliques', imp(semCliques ? '—' : ganhosNum(t.cliques)),
      semImp ? T.semImportacao : semCliques ? 'Sem cliques importados no período. Importe o relatório de cliques da loja.' : 'Vêm do relatório da loja que você importou.'),
    ganhosCartao('epc', 'Ganho por clique', imp(ganhosBrl(t.epc, 4)), semImp ? T.semImportacao : t.epc == null ? 'Sem cliques no período.' : 'Comissão ÷ cliques das lojas com cliques importados.', 'gpc'),
    ganhosCartao('conversao', 'Conversão', imp(ganhosRazao(t.conversao, 2)), semImp ? T.semImportacao : t.conversao == null ? 'Sem cliques no período.' : 'Vendas ÷ cliques das lojas com cliques importados.'),
    ganhosCartao('envios', 'Envios', ganhosNum(t.envios), 'Links enviados pelo Turbo no período.'),
    ganhosCartao('atribuida', 'Comissão com grupo', imp(ganhosRazao(t.atribuida)), semImp ? T.semImportacao : t.atribuida == null ? 'Sem comissão no período.' : `${ganhosBrl(t.comissao_atribuida)} de ${ganhosBrl(t.comissao)} têm grupo ou bloco identificado.`),
    ganhosCartao('entradas', 'Entradas', ganhosNum(t.entradas), 'Entradas de todos os grupos do filtro.'),
  ];
  return `<div class="kpis ganhos-kpis">${cartoes.join('')}</div>`;
}

// ---------- Dashboard: tabelas ----------

/**
 * Tabela do Dashboard dentro de uma `section`: título, `caption` só para leitor de tela, cabeçalho (com botão de ordenar nas
 * colunas que têm `chave`), corpo (`linhas`: html de `tr` já escapado) e rodapé opcional. Em tela estreita, vira lista de cartões
 * (.tab-din). `mais`: botão "Mostrar mais" abaixo.
 */
function ganhosSecao({ id, titulo, legenda, cols, linhas, rodape = '', mais = '', ordem = null, detalhes = false }) {
  const cab = cols.map((c) => {
    const aria = ordem && c.chave === ordem.col ? ` aria-sort="${ordem.dir === 'asc' ? 'ascending' : 'descending'}"` : '';
    return `<th scope="col" role="columnheader"${aria}>${c.chave ? `<button type="button" class="leve ord" data-ordem="${c.chave}" aria-label="Ordenar por ${c.rot.toLowerCase()}">${c.rot}</button>` : c.rot}</th>`;
  }).join('');
  const tabela = `<div class="card tabela tab-din"><table role="table"><caption class="sr-only">${legenda}</caption><thead role="rowgroup"><tr role="row">${cab}</tr></thead><tbody role="rowgroup">${linhas.join('')}</tbody>${rodape ? `<tfoot role="rowgroup">${rodape}</tfoot>` : ''}</table></div>${mais}`;
  return detalhes
    ? `<section id="${id}" class="g-sec"><details><summary id="${id}-titulo">${titulo}</summary>${tabela}</details></section>`
    : `<section id="${id}" class="g-sec"><h2 id="${id}-titulo" tabindex="-1">${titulo}</h2>${tabela}</section>`;
}

/** Célula: `rot` aparece como rótulo em tela estreita; `num` alinha e usa algarismos de largura fixa. */
const ganhosTd = (rot, html, num = true) => `<td role="cell"${num ? ' class="c-num"' : ''} data-rot="${rot}">${html}</td>`;
const ganhosTr = (k, tds, classe = '') => `<tr role="row" data-k="${esc(k)}"${classe ? ` class="${classe}"` : ''}>${tds.join('')}</tr>`;
const ganhosTotal = (rot, html) => (rot === 'Total' || !rot ? `<td role="cell">${html}</td>` : `<td role="cell" class="c-num" data-rot="${rot}">${html}</td>`);

/** Ordena as linhas por `col`; vazio (null) sempre por último, em qualquer sentido. 'nome' ordena por texto. */
function ganhosOrdenar(linhas, { col, dir }) {
  const valor = (l) => (col === 'nome' ? String(l.nome || l.jid || '') : l[col]);
  return [...linhas].sort((a, b) => {
    const x = valor(a); const y = valor(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    const c = typeof x === 'string' ? x.localeCompare(y, 'pt-BR') : x - y;
    return dir === 'asc' ? c : -c;
  });
}
const GANHOS_COLUNAS_ORDEM = ['nome', 'comissao', 'vendas', 'cliques', 'epc', 'entradas', 'gasto', 'custo_membro'];

function ganhosSecaoGrupo(g) {
  const ordenadas = ganhosOrdenar(g.linhas, GANHOS.ordem);
  const vistas = GANHOS.todosGrupo ? ordenadas : ordenadas.slice(0, GANHOS_MAX_GRUPOS);
  const linhas = vistas.map((l) => ganhosTr(l.jid, [
    ganhosTd('Grupo', esc(l.nome || nomeGrupo(l.jid)), false),
    ganhosTd('Bloco', (l.blocos || []).map((b) => esc(b.nome ?? `bloco ${b.id}`)).join(', ') || '—', false),
    ganhosTd('Comissão', ganhosBrl(l.comissao)), ganhosTd('Vendas', ganhosNum(l.vendas)), ganhosTd('Cliques', ganhosNum(l.cliques)),
    ganhosTd('Ganho por clique', ganhosBrl(l.epc, 4)), ganhosTd('Entradas', ganhosNum(l.entradas)),
    ganhosTd('Gasto', ganhosBrl(l.gasto)), ganhosTd('Custo por membro novo', ganhosBrl(l.custo_membro)),
  ]));
  const sem = g.nao_atribuida;
  if (sem) {
    linhas.push(ganhosTr('sem-grupo', [
      ganhosTd('Grupo', 'Sem grupo identificado', false), ganhosTd('Bloco', '—', false),
      ganhosTd('Comissão', ganhosBrl(sem.comissao)), ganhosTd('Vendas', ganhosNum(sem.vendas)), ganhosTd('Cliques', ganhosNum(sem.cliques)),
      ganhosTd('Ganho por clique', '—'), ganhosTd('Entradas', '—'), ganhosTd('Gasto', '—'), ganhosTd('Custo por membro novo', '—'),
    ], 'sem-grupo'));
  }
  const t = g.total;
  const rodape = `<tr role="row">${[ganhosTotal('Total', 'Total'), ganhosTotal('', ''), ganhosTotal('Comissão', ganhosBrl(t.comissao)), ganhosTotal('Vendas', ganhosNum(t.vendas)), ganhosTotal('Cliques', ganhosNum(t.cliques)),
    ganhosTotal('Ganho por clique', ganhosBrl(t.epc, 4)), ganhosTotal('Entradas', ganhosNum(t.entradas)), ganhosTotal('Gasto', ganhosBrl(t.gasto)), ganhosTotal('Custo por membro novo', ganhosBrl(t.custo_membro))].join('')}</tr>`;
  const resto = ordenadas.length - vistas.length;
  const col = (rot, chave) => ({ rot, chave });
  return ganhosSecao({
    id: 'g-sec-grupo', titulo: 'Por grupo', legenda: 'Comissão, cliques, entradas e gasto por grupo; a coluna marcada com aria-sort é a ordem atual',
    cols: [col('Grupo', 'nome'), { rot: 'Bloco' }, col('Comissão', 'comissao'), col('Vendas', 'vendas'), col('Cliques', 'cliques'), col('Ganho por clique', 'epc'), col('Entradas', 'entradas'), col('Gasto', 'gasto'), col('Custo por membro novo', 'custo_membro')],
    linhas, rodape, ordem: GANHOS.ordem,
    mais: resto > 0 ? `<button type="button" id="g-mais-grupo">Mostrar mais (${resto})</button>` : '',
  });
}

function ganhosSecaoBloco(b) {
  const linhas = b.linhas.map((l) => ganhosTr(String(l.bloco_id), [
    ganhosTd('Bloco', esc(l.nome ?? `bloco ${l.bloco_id}`), false), ganhosTd('Grupos', ganhosNum(l.grupos)),
    ganhosTd('Comissão', ganhosBrl(l.comissao)), ganhosTd('Vendas', ganhosNum(l.vendas)), ganhosTd('Cliques', ganhosNum(l.cliques)),
    ganhosTd('Ganho por clique', ganhosBrl(l.epc, 4)), ganhosTd('Entradas', ganhosNum(l.entradas)),
    ganhosTd('Gasto', ganhosBrl(l.gasto)), ganhosTd('Custo por membro novo', ganhosBrl(l.custo_membro)), ganhosTd('Retorno', ganhosBrl(l.retorno)),
  ]));
  return ganhosSecao({
    id: 'g-sec-bloco', titulo: 'Por bloco', legenda: 'Comissão, cliques, entradas, gasto e retorno por bloco',
    cols: ['Bloco', 'Grupos', 'Comissão', 'Vendas', 'Cliques', 'Ganho por clique', 'Entradas', 'Gasto', 'Custo por membro novo', 'Retorno'].map((rot) => ({ rot })), linhas,
  });
}

function ganhosSecaoLoja(b) {
  const linhas = b.linhas.map((l) => {
    const n = ganhosNivel(l.cobertura);
    const cob = n ? `${fmtPct(ganhosPorcento(l.cobertura))} ${ganhosPilula(l.cobertura)}` : '<span title="Nenhum envio desta loja esperava código de rastreio">—</span>';
    return ganhosTr(l.loja, [
      ganhosTd('Loja', ganhosNomeLoja(l.loja), false), ganhosTd('Comissão', ganhosBrl(l.comissao)), ganhosTd('Vendas', ganhosNum(l.vendas)), ganhosTd('Cliques', ganhosNum(l.cliques)),
      ganhosTd('Ganho por clique', ganhosBrl(l.epc, 4)), ganhosTd('Conversão', ganhosRazao(l.conversao, 2)), ganhosTd('Com grupo', ganhosRazao(l.atribuida)), ganhosTd('Cobertura', cob),
    ]);
  });
  return ganhosSecao({
    id: 'g-sec-loja', titulo: 'Por loja', legenda: 'Comissão, cliques, conversão e cobertura do rastreio por loja',
    cols: ['Loja', 'Comissão', 'Vendas', 'Cliques', 'Ganho por clique', 'Conversão', 'Com grupo', 'Cobertura'].map((rot) => ({ rot })), linhas,
  });
}

function ganhosSecaoOferta(o) {
  const ordenadas = o.linhas; const vistas = GANHOS.todasOfertas ? ordenadas : ordenadas.slice(0, GANHOS_TOP_OFERTAS);
  const linhas = vistas.map((l) => {
    const curto = String(l.oferta ?? '').length > 24 ? `${String(l.oferta).slice(0, 24)}…` : String(l.oferta ?? '');
    const nome = l.titulo ? String(l.titulo) : `Oferta ${curto}`;
    return ganhosTr(`${l.loja}|${l.oferta}`, [
      ganhosTd('Oferta', `<span class="oferta-nome" title="${esc(l.titulo || l.oferta)}">${esc(nome)}</span>`, false), ganhosTd('Loja', ganhosNomeLoja(l.loja), false),
      ganhosTd('Vendas', ganhosNum(l.vendas)), ganhosTd('Comissão', ganhosBrl(l.comissao)), ganhosTd('Grupos que enviaram', ganhosNum(l.grupos)),
    ]);
  });
  const resto = ordenadas.length - vistas.length;
  return ganhosSecao({
    id: 'g-sec-oferta', titulo: 'Por oferta', legenda: 'Ofertas que mais renderam, da maior comissão para a menor',
    cols: ['Oferta', 'Loja', 'Vendas', 'Comissão', 'Grupos que enviaram'].map((rot) => ({ rot })), linhas,
    mais: resto > 0 ? `<button type="button" id="g-mais-oferta">Ver todas (${ordenadas.length})</button>` : '',
  });
}

function ganhosSecaoDia(d) {
  const linhas = d.linhas.map((l) => ganhosTr(l.dia, [
    ganhosTd('Dia', ganhosDiaMes(l.dia), false), ganhosTd('Comissão', ganhosBrl(l.comissao)), ganhosTd('Vendas', ganhosNum(l.vendas)),
    ganhosTd('Cliques', ganhosNum(l.cliques)), ganhosTd('Envios', ganhosNum(l.envios)),
  ]));
  return ganhosSecao({
    id: 'g-sec-dia', titulo: 'Por dia', legenda: 'Comissão, cliques e envios por dia do período', detalhes: true,
    cols: ['Dia', 'Comissão', 'Vendas', 'Cliques', 'Envios'].map((rot) => ({ rot })), linhas,
  });
}

function ganhosSecaoImportacoes(lista) {
  if (!lista.length) return '';
  const vistas = lista.slice(0, GANHOS_MAX_IMPORTACOES);
  const linhas = vistas.map((i) => {
    const quando = new Date(i.criado_em).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const id = /^\d{1,15}$/.test(String(i.id)) ? String(i.id) : '';
    return ganhosTr(String(i.id), [
      ganhosTd('Data', esc(quando), false), ganhosTd('Loja', ganhosNomeLoja(i.loja), false), ganhosTd('Tipo', i.tipo === 'cliques' ? 'Cliques' : 'Comissões', false),
      ganhosTd('Lidas', ganhosNum(i.lidas)), ganhosTd('Novas', ganhosNum(i.novas)), ganhosTd('Repetidas', ganhosNum(i.repetidas)), ganhosTd('Puladas', ganhosNum(i.ignoradas)),
      ganhosTd('Código do arquivo', i.codigo_arquivo ? esc(i.codigo_arquivo) : '—', false),
      id ? `<td role="cell" class="c-acao"><button type="button" class="leve perigo" data-apagar-imp="${id}" aria-label="Apagar a importação de ${esc(quando)}">Apagar</button></td>` : '<td role="cell"></td>',
    ]);
  });
  return ganhosSecao({
    id: 'g-sec-imp', titulo: 'Importações recentes', legenda: 'Arquivos importados, da mais recente para a mais antiga',
    cols: [...['Data', 'Loja', 'Tipo', 'Lidas', 'Novas', 'Repetidas', 'Puladas', 'Código do arquivo'].map((rot) => ({ rot })), { rot: '<span class="sr-only">Ações</span>' }], linhas,
    mais: lista.length > vistas.length ? `<p class="dica">Mostrando as ${vistas.length} mais recentes.</p>` : '',
  });
}

/** Tudo o que depende de GET /api/ganhos: cartões e tabelas, o aviso de "nada neste filtro", o estado vazio ou o erro. */
function ganhosDinheiroHtml(cob) {
  const T = TEXTOS_GANHOS; const din = GANHOS.dados.din;
  if (din.erro) return `<div class="card" id="g-erro-din"><h2>${T.erroDinheiro}</h2><p class="sub">${esc(din.erro.message)}</p><button type="button" class="pri" id="g-tentar-din">Tentar de novo</button></div>`;
  const g = din.grupo; const t = g.total;
  const semImp = !din.importacoes.length;
  const vazio = semImp && !g.gastos_informados;
  if (vazio && !(cob.total?.envios > 0)) {
    const V = T.vazio;
    return `<div class="card g-vazio" id="g-vazio"><h2>${V.titulo}</h2>
      <div class="passo"><p><b>${V.passo1[0]}</b>${V.passo1[1]}</p><a class="btn" href="#blocos">Abrir Blocos de análise</a></div>
      <div class="passo"><p><b>${V.passo2[0]}</b>${V.passo2[1]}</p><button type="button" class="pri" id="g-vz-importar">Importar comissões</button></div>
      <div class="passo"><p><b>${V.passo3[0]}</b>${V.passo3[1]}</p><button type="button" id="g-vz-gasto">Gasto com anúncios</button></div>
      <p class="dica" style="margin:0">${V.rodape} <a href="#docs/grupos/importar">Como baixar o relatório de cada loja</a></p></div>`;
  }
  const cartoes = ganhosCartoesHtml(din, semImp);
  if (semImp) return cartoes; // há envios, mas nenhum relatório importado: só os cartões (com "—" e o motivo)
  const semMovimento = t.comissao === 0 && t.vendas === 0 && t.cliques === 0 && t.gasto == null && !din.oferta.linhas.length;
  if (semMovimento) {
    return `${cartoes}<div class="aviso-impl neutro" role="status"><p>${T.semMovimento} <button type="button" class="leve" id="g-limpar">Limpar filtros</button></p></div>`;
  }
  return `${cartoes}${ganhosSecaoGrupo(g)}${ganhosSecaoBloco(din.bloco)}${ganhosSecaoLoja(din.loja)}${ganhosSecaoOferta(din.oferta)}${ganhosSecaoDia(din.dia)}`;
}

function ganhosComoLerHtml() {
  return `<details class="g-como"><summary>Como ler estes números</summary><ul>${TEXTOS_GANHOS.comoLer.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></details>`;
}

function ganhosFiltrosHtml(blocos) {
  const custom = GANHOS.periodo === 'custom';
  return `<div class="filtros"><span class="filtro-rot" id="g-per-rot">Período</span><div class="seg" id="g-per" role="group" aria-labelledby="g-per-rot">${GANHOS_PERIODOS.map(([k, n]) => `<button type="button" data-p="${k}" aria-pressed="${k === GANHOS.periodo}" class="${k === GANHOS.periodo ? 'on' : ''}">${n}</button>`).join('')}</div>
      ${custom ? `<div class="ganhos-datas"><label>De <input type="date" id="g-de" value="${esc(GANHOS.de)}"></label><label>Até <input type="date" id="g-ate" value="${esc(GANHOS.ate)}"></label></div>` : ''}</div>
    <div class="filtros chips" id="g-blc" role="group" aria-labelledby="g-blc-rot"><span class="filtro-rot" id="g-blc-rot">Bloco ${q('visao.bloco')}</span><button type="button" data-b="" aria-pressed="${!GANHOS.bloco}" class="${GANHOS.bloco ? '' : 'on'}">Todos os grupos</button>
      ${blocos.map((b) => `<button type="button" data-b="${b.id}" aria-pressed="${String(b.id) === String(GANHOS.bloco)}" class="${String(b.id) === String(GANHOS.bloco) ? 'on' : ''}">${esc(b.name)} <small>${b.group_jids.length}</small></button>`).join('')}</div>
    <div class="filtros"><span class="filtro-rot" id="g-loja-rot">Loja</span><div class="seg" id="g-loja" role="group" aria-labelledby="g-loja-rot">${[['', 'Todas'], ...GANHOS_LOJAS].map(([k, n]) => `<button type="button" data-loja="${k}" aria-pressed="${k === GANHOS.loja}" class="${k === GANHOS.loja ? 'on' : ''}">${n}</button>`).join('')}</div></div>`;
}

/** Região aria-live estável (fora de #pagina, que é redesenhada a cada filtro): cria na primeira vez, depois só troca o texto. */
function ganhosVivo() {
  let v = $('#g-vivo');
  if (!v) {
    v = document.createElement('div'); v.id = 'g-vivo'; v.className = 'sr-only';
    v.setAttribute('aria-live', 'polite'); v.setAttribute('aria-atomic', 'true');
    ($('main') || document.body).appendChild(v);
  }
  return v;
}

/** Devolve o foco ao controle que o redesenho da página levou embora. O seletor vem do código (valores dos filtros conferidos). */
function ganhosFoco(seletor) {
  if (!seletor) return;
  ($(seletor) || $('#g-tentar'))?.focus();
}

/** Tudo de dinheiro numa carga só, com falha própria: se o servidor de ganhos cair, a cobertura continua na tela. Nunca rejeita. */
async function ganhosCarregarDinheiro() {
  try {
    const [grupo, loja, oferta, dia, bloco, imps] = await Promise.all([...['grupo', 'loja', 'oferta', 'dia', 'bloco'].map((por) => api('/ganhos' + ganhosConsulta(por))), api('/ganhos/importacoes')]);
    return { grupo, loja, oferta, dia, bloco, importacoes: Array.isArray(imps.importacoes) ? imps.importacoes : [] };
  } catch (e) { return { erro: e }; }
}

/**
 * Abre a página. `opcoes.quieto`: recarrega por trás de um diálogo (depois de importar ou lançar um gasto) sem "Carregando…"
 * nem mexer no foco; `opcoes.foco`: seletor que recebe o foco quando terminar.
 */
async function paginaGanhos(opcoes = {}) {
  if (!podeEquipe()) return; // o roteador já manda o Operador para a Visão Geral; nunca chama /api/rastreio nem /api/ganhos como Operador
  const T = TEXTOS_GANHOS; const ger = ++GANHOS.ger; const pg = $('#pagina');
  const quieto = !!opcoes.quieto; const foco = opcoes.foco || (quieto ? '' : GANHOS.foco); GANHOS.foco = '';
  // Primeira vez na página: "Carregando…". Ao trocar um filtro, a tela antiga fica até a nova chegar (o foco não cai no corpo da página).
  if (!foco && !quieto) pg.innerHTML = `<div class="topo"><div><h1>Ganhos ${q('ganhos')}</h1><p class="sub">Carregando…</p></div></div>`;
  const dinheiro = ganhosCarregarDinheiro();
  let blocos; let cob;
  try {
    [blocos, cob] = await Promise.all([api('/blocks'), api('/rastreio/cobertura' + ganhosConsulta())]);
  } catch (e) {
    if (ger !== GANHOS.ger || rotaAtual() !== 'ganhos') return;
    if (e.status === 404 && GANHOS.bloco) { GANHOS.bloco = ''; GANHOS.foco = foco ? '#g-blc [data-b=""]' : ''; return paginaGanhos(); } // o bloco filtrado foi apagado
    pg.innerHTML = `<div class="topo"><div><h1>Ganhos ${q('ganhos')}</h1></div></div>
      <div class="card"><h2>${T.erroCarregar}</h2><p class="sub">${esc(e.message)}</p><button type="button" class="pri" id="g-tentar">Tentar de novo</button></div>`;
    $('#g-tentar').onclick = () => paginaGanhos();
    if (foco) $('#g-tentar').focus();
    return;
  }
  const din = await dinheiro;
  if (ger !== GANHOS.ger || rotaAtual() !== 'ganhos') return; // saiu da página, ou trocou o filtro, enquanto carregava
  S.blocks = blocos;
  GANHOS.dados = { blocos, cob, din };
  ganhosDesenhar(foco, true);
}

/** Desenha a página a partir de GANHOS.dados (sem pedir nada) e liga os controles. `anunciar`: avisa os leitores de tela. */
function ganhosDesenhar(foco, anunciar) {
  const T = TEXTOS_GANHOS; const pg = $('#pagina'); const { blocos, cob, din } = GANHOS.dados;
  const dia = (ms) => new Date(ms).toLocaleDateString('pt-BR');
  const rotuloPeriodo = GANHOS_PERIODOS.find((p) => p[0] === GANHOS.periodo)?.[1] || '';
  const rotuloBloco = GANHOS.bloco ? blocos.find((b) => String(b.id) === String(GANHOS.bloco))?.name : '';
  const nGrupos = (cob.por_grupo || []).length;
  const ate = din.erro ? {} : din.grupo.importado_ate || {};
  const importado = GANHOS_ORDEM_IMPORTADO.filter((l) => ate[l]).map((l) => `${ganhosDiaMes(ate[l])} (${GANHOS_NOME_LOJA[l]})`);
  const vazio = !din.erro && !din.importacoes.length && !din.grupo.gastos_informados && !(cob.total?.envios > 0);
  pg.innerHTML = `<div class="topo"><div><h1>Ganhos ${q('ganhos')}</h1><p class="sub">${T.sub}${importado.length ? ` Dados importados até ${importado.join(', ')}.` : ''} Período: ${esc(rotuloPeriodo.toLowerCase())}, de ${dia(cob.de)} a ${dia(cob.ate)}.</p></div>
      <div class="topo-acoes"><button type="button" id="g-importar"${vazio ? '' : ' class="pri"'}>Importar comissões</button><button type="button" id="g-gasto">Gasto com anúncios</button></div></div>
    ${ganhosFiltrosHtml(blocos)}
    ${ganhosCoberturaHtml(cob)}
    ${ganhosDinheiroHtml(cob)}
    ${ganhosTabelaGrupos(cob)}
    ${din.erro ? '' : ganhosSecaoImportacoes(din.importacoes)}
    ${ganhosComoLerHtml()}`;
  const vistos = GANHOS.todos ? nGrupos : Math.min(nGrupos, GANHOS_MAX_GRUPOS);
  if (anunciar) ganhosVivo().textContent = `Ganhos atualizados: ${rotuloPeriodo}${rotuloBloco ? `, bloco ${rotuloBloco}` : ''}${GANHOS.loja ? `, loja ${GANHOS_NOME_LOJA[GANHOS.loja] || ''}` : ''}${nGrupos ? `, ${vistos} de ${nGrupos} grupos` : ''}.`;
  ganhosLigar();
  ganhosFoco(foco);
}

/** Recarrega a página pedindo tudo de novo; `seletor` volta o foco ao controle clicado. */
function ganhosRecarregar(seletor) { GANHOS.foco = seletor; paginaGanhos(); }
/** Filtro novo: as listas "Mostrar mais" voltam ao tamanho de início. */
function ganhosReiniciarListas() { GANHOS.todos = false; GANHOS.todosGrupo = false; GANHOS.todasOfertas = false; }

function ganhosLigar() {
  const onclick = (sel, fn) => { const e = $(sel); if (e) e.onclick = fn; };
  // Valores vêm do dataset do botão clicado: só entram no seletor se casarem com o formato esperado (letras, números, _ e -).
  const seguro = (v) => (/^[\w-]*$/.test(String(v)) ? String(v) : null);
  onclick('#g-per', (e) => { const b = e.target.closest('[data-p]'); const v = b && seguro(b.dataset.p); if (v) { GANHOS.periodo = v; ganhosReiniciarListas(); ganhosRecarregar(`#g-per [data-p="${v}"]`); } });
  onclick('#g-blc', (e) => { const b = e.target.closest('[data-b]'); const v = b && seguro(b.dataset.b); if (v != null) { GANHOS.bloco = v; ganhosReiniciarListas(); ganhosRecarregar(`#g-blc [data-b="${v}"]`); } });
  onclick('#g-loja', (e) => { const b = e.target.closest('[data-loja]'); const v = b && seguro(b.dataset.loja); if (v != null) { GANHOS.loja = v; ganhosReiniciarListas(); ganhosRecarregar(`#g-loja [data-loja="${v}"]`); } });
  const dataOk = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : '');
  if ($('#g-de')) $('#g-de').onchange = (e) => { GANHOS.de = dataOk(e.target.value); ganhosRecarregar('#g-de'); };
  if ($('#g-ate')) $('#g-ate').onchange = (e) => { GANHOS.ate = dataOk(e.target.value); ganhosRecarregar('#g-ate'); };
  onclick('#g-mais', () => { GANHOS.todos = true; ganhosRecarregar('#g-tabela-titulo'); }); // o botão some: o foco vai para o título da tabela
  // ordenar e "mostrar mais" do Dashboard não pedem nada ao servidor
  onclick('#g-sec-grupo', (e) => {
    const b = e.target.closest('[data-ordem]'); const col = b && b.dataset.ordem;
    if (!col || !GANHOS_COLUNAS_ORDEM.includes(col)) return;
    GANHOS.ordem = GANHOS.ordem.col === col ? { col, dir: GANHOS.ordem.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: col === 'nome' ? 'asc' : 'desc' };
    ganhosDesenhar(`#g-sec-grupo [data-ordem="${col}"]`, false);
  });
  onclick('#g-mais-grupo', () => { GANHOS.todosGrupo = true; ganhosDesenhar('#g-sec-grupo-titulo', false); });
  onclick('#g-mais-oferta', () => { GANHOS.todasOfertas = true; ganhosDesenhar('#g-sec-oferta-titulo', false); });
  onclick('#g-limpar', () => { Object.assign(GANHOS, { periodo: '30d', bloco: '', loja: '', de: '', ate: '' }); ganhosReiniciarListas(); ganhosRecarregar('#g-per [data-p="30d"]'); });
  onclick('#g-tentar-din', () => paginaGanhos({ quieto: true }));
  onclick('#g-importar', () => ganhosAbrirImportar());
  onclick('#g-vz-importar', () => ganhosAbrirImportar());
  onclick('#g-gasto', () => ganhosAbrirGasto());
  onclick('#g-vz-gasto', () => ganhosAbrirGasto());
  onclick('#g-informar', () => ganhosAbrirGasto());
  onclick('#g-sec-imp', tentar(async (e) => { const b = e.target.closest('[data-apagar-imp]'); if (b) await ganhosApagarImportacao(b.dataset.apagarImp); }));
}

/** Apaga uma importação (só as linhas que ela trouxe) depois de confirmar; Ganhos recarrega. */
async function ganhosApagarImportacao(id) {
  if (!/^\d{1,15}$/.test(String(id))) return;
  const i = (GANHOS.dados?.din?.importacoes || []).find((x) => String(x.id) === String(id));
  const linhas = i ? i.linhas ?? 0 : 0;
  const efeito = linhas === 0
    ? 'Esta importação só atualizou linhas de uma importação anterior; apagá-la não desfaz essas mudanças.'
    : `${ganhosSingPlural(linhas, 'A linha que ela trouxe sai', `As ${linhas} linhas que ela trouxe saem`)} de Ganhos. Linhas que ela só atualizou continuam como estão.`;
  if (!confirm(`Apagar esta importação? ${efeito} O arquivo original não é guardado: para refazer, importe de novo.`)) return;
  await api(`/ganhos/importacoes/${id}`, 'DELETE');
  aviso('Importação apagada');
  await paginaGanhos({ quieto: true });
}

// ---------- diálogo "Importar comissões" ----------

/** Radiogroup `.seg` (setas movem a escolha). `atributo`: data-<atributo> de cada botão; `aoMudar(valor)` recebe a escolha. */
function ganhosRadios(raiz, atributo, atual, aoMudar) {
  if (!raiz) return;
  raiz.onclick = (e) => { const b = e.target.closest(`[data-${atributo}]`); const v = b && b.dataset[atributo]; if (v != null) aoMudar(v); };
  raiz.onkeydown = (e) => {
    const passo = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]; if (!passo) return;
    const lista = $$(`[data-${atributo}]`, raiz); if (!lista.length) return;
    e.preventDefault();
    const i = Math.max(0, lista.findIndex((b) => b.dataset[atributo] === atual()));
    const prox = lista[(i + passo + lista.length) % lista.length];
    aoMudar(prox.dataset[atributo]); prox.focus();
  };
}
/** Marca o botão escolhido do radiogroup (aria-checked, classe e tabindex "rolante"). */
function ganhosMarcarRadio(raiz, atributo, valor) {
  $$(`[data-${atributo}]`, raiz).forEach((b) => {
    const on = b.dataset[atributo] === valor;
    b.setAttribute('aria-checked', String(on)); b.classList.toggle('on', on); b.setAttribute('tabindex', on || !valor ? '0' : '-1');
  });
}
const ganhosRadioHtml = (atributo, lista, atual) => lista.map(([k, n]) => `<button type="button" data-${atributo}="${k}" role="radio" aria-checked="${k === atual}" tabindex="${k === atual || !atual ? 0 : -1}" class="${k === atual ? 'on' : ''}">${n}</button>`).join('');

/** O arquivo parece CSV? Pela extensão (o `type` do Windows para .csv vem como application/vnd.ms-excel); sem extensão, pelo type. */
function ganhosArquivoCsv(a) {
  const ext = (/\.([^.]+)$/.exec(String(a.name || '')) || [])[1]?.toLowerCase();
  if (ext) return ['csv', 'txt', 'tsv'].includes(ext);
  return !a.type || /^text\//.test(a.type);
}

/**
 * Manda o arquivo cru (sem ler como texto: a codificação é do servidor) com Content-Type text/csv explícito. `previa`: só mostra
 * o que seria importado, sem gravar. Erro: Error com a frase pronta e `status`; falha de rede → `rede: true` e a frase de "nada foi salvo".
 */
async function ganhosEnviarCsv(arquivo, { loja, tipo, codigo, previa }) {
  const p = new URLSearchParams({ loja, tipo });
  if (codigo) p.set('codigo', codigo);
  if (previa) p.set('previa', '1');
  let r;
  try { r = await fetch('/api/ganhos/importar?' + p.toString(), { method: 'POST', headers: { 'content-type': 'text/csv' }, body: arquivo }); }
  catch { throw Object.assign(new Error(TEXTOS_GANHOS.importar.semConexao), { rede: true }); }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { location.replace('/login.html'); throw new Error('Sessão expirada. Entre de novo.'); }
  if (!r.ok) {
    const I = TEXTOS_GANHOS.importar;
    const msg = r.status === 403 ? I.soDono : r.status === 413 ? I.grande : (typeof j.erro === 'string' && j.erro) || (r.status >= 500 ? I.semConexao : `Erro ${r.status}`);
    throw Object.assign(new Error(msg), { status: r.status });
  }
  return j;
}

/** Linhas do resumo (prévia e sucesso): contagens, período, comissão ou cliques, sem grupo, colunas. Todo texto do arquivo vai por esc(). */
function ganhosResumoImportacao(r, { previa }) {
  const I = TEXTOS_GANHOS.importar; const cliques = r.tipo === 'cliques';
  const itens = [`<li>${ganhosNum(r.lidas)} ${ganhosSingPlural(r.lidas, 'linha lida', 'linhas lidas')}</li>`, `<li>${ganhosNum(r.novas)} ${ganhosSingPlural(r.novas, 'nova', 'novas')}</li>`];
  if (r.atualizadas > 0) itens.push(`<li>${ganhosNum(r.atualizadas)} ${ganhosSingPlural(r.atualizadas, 'atualizada', 'atualizadas')} (estavam importadas e mudaram, por exemplo de pendente para confirmada)</li>`);
  itens.push(`<li>${ganhosNum(r.repetidas)} ${ganhosSingPlural(r.repetidas, 'já importada', 'já importadas')} ${previa ? '(serão ignoradas)' : 'e ignoradas'}</li>`);
  if (r.ignoradas > 0) {
    const nums = (r.linhas_ignoradas || []).filter((n) => Number.isInteger(n));
    const lista = nums.length ? `: ${ganhosSingPlural(nums.length, 'linha', 'linhas')} ${nums.length > 1 ? `${nums.slice(0, -1).join(', ')} e ${nums.at(-1)}` : nums[0]}${r.ignoradas > nums.length ? ' e outras' : ''}` : '';
    itens.push(`<li>${ganhosNum(r.ignoradas)} ${ganhosSingPlural(r.ignoradas, 'pulada', 'puladas')} (valor ou data inválidos)${lista}</li>`);
  }
  const partes = [`<ul class="g-resumo">${itens.join('')}</ul>`];
  const extras = [];
  if (r.periodo) extras.push(`Período do arquivo: ${ganhosDiaMes(r.periodo.de)} a ${ganhosDiaMes(r.periodo.ate)}`);
  if (cliques) extras.push(`Cliques no arquivo: ${ganhosNum(r.cliques_total)}`);
  else if (typeof r.comissao_centavos === 'number') extras.push(`Comissão no arquivo: ${ganhosBrl(r.comissao_centavos)} (sem as canceladas)`);
  if (r.codigo_arquivo) extras.push(`Código informado para o arquivo: ${esc(r.codigo_arquivo)}`);
  if (extras.length) partes.push(`<p class="g-extras">${extras.join('<br>')}</p>`);
  if (!cliques && r.sem_grupo > 0) {
    partes.push(`<div class="aviso-impl neutro" role="note"><p>${ganhosNum(r.sem_grupo)} ${ganhosSingPlural(r.sem_grupo, 'linha não traz código de rastreio ou o código não é de nenhum grupo seu', 'linhas não trazem código de rastreio ou o código não é de nenhum grupo seu')}. Entram no total, mas não aparecem em nenhum grupo.${(r.codigos_desconhecidos || []).length ? ` Códigos que não são de nenhum grupo seu: ${r.codigos_desconhecidos.map(esc).join(', ')}.` : ''}</p></div>`);
  }
  const usadas = (r.colunas_usadas || []).map((c) => `${I.campos[c.campo] || esc(c.campo)} (${esc(c.coluna)})`).join(', ');
  const ignoradas = (r.colunas_ignoradas || []).map(esc).join(', ');
  partes.push(`<p class="dica g-colunas">Colunas lidas: ${usadas || '—'}.<br>Colunas ignoradas (o painel não lê): ${ignoradas || 'nenhuma'}.<br>Dados de comprador não são guardados.</p>`);
  for (const a of r.avisos || []) partes.push(`<div class="aviso-impl" role="status"><p>${esc(a)}</p></div>`);
  return partes.join('');
}

/**
 * Diálogo "Importar comissões": escolher loja, tipo (comissões ou cliques) e arquivo → "Conferir arquivo" (prévia, não grava)
 * → "Importar agora" → resumo. Só o Dono. Ao fechar depois de gravar, Ganhos recarrega por trás.
 */
function ganhosAbrirImportar() {
  if (!podeEquipe()) return;
  const I = TEXTOS_GANHOS.importar; const dlg = $('#dlg');
  const est = { loja: GANHOS.loja || '', tipo: 'comissoes', arquivo: null, codigo: '', salvou: false, recarregou: false, ocupado: false };
  const concluir = () => {
    if (est.salvou && !est.recarregou) { est.recarregou = true; paginaGanhos({ quieto: true, foco: '#g-importar' }); } else $('#g-importar')?.focus();
  };
  const fechar = () => { dlg.close(); concluir(); };
  dlg.addEventListener('close', concluir, { once: true }); // Esc também

  const formulario = () => {
    dlg.innerHTML = `<form method="dialog" id="f" novalidate><h1 tabindex="-1">${I.titulo} ${q('ganhos.importar')}</h1>
      <p class="sub" style="margin:-8px 0 0">${I.intro}</p>
      <div class="campo"><span class="filtro-rot" id="imp-loja-rot">Loja ${REQ}</span><div class="seg" id="imp-loja" role="radiogroup" aria-labelledby="imp-loja-rot">${ganhosRadioHtml('loja', GANHOS_ORDEM_IMPORTADO.map((k) => [k, GANHOS_NOME_LOJA[k]]), est.loja)}</div></div>
      <div class="campo"><span class="filtro-rot" id="imp-tipo-rot">O arquivo traz</span><div class="seg" id="imp-tipo" role="radiogroup" aria-labelledby="imp-tipo-rot">${ganhosRadioHtml('tipo', [['comissoes', 'Comissões (vendas)'], ['cliques', 'Cliques']], est.tipo)}</div></div>
      <p class="dica" id="imp-dica" role="note" style="margin:0"></p>
      <label class="campo"><span id="imp-arq-rot">Arquivo CSV do relatório</span><input type="file" id="imp-arq" accept=".csv,.txt,text/csv,text/plain" aria-describedby="imp-info"></label>
      <p class="dica" id="imp-info" style="margin:0" role="status"></p>
      <label class="campo"><span>Código do arquivo (opcional)</span><input id="imp-codigo" value="${esc(est.codigo)}" maxlength="100" autocomplete="off" spellcheck="false">
        <small>Se o relatório já veio filtrado por um código (etiqueta, ID de rastreamento ou Sub_id), digite-o aqui: vale para as linhas que não têm coluna de código.</small></label>
      <div class="rodape"><button type="button" id="imp-cancelar">Cancelar</button><button class="pri" id="imp-ok">Conferir arquivo</button></div></form>`;
    ganhosRadios($('#imp-loja'), 'loja', () => est.loja, (v) => { est.loja = v; atualizar(); });
    ganhosRadios($('#imp-tipo'), 'tipo', () => est.tipo, (v) => { est.tipo = v; atualizar(); });
    $('#imp-arq').onchange = () => { est.arquivo = $('#imp-arq').files?.[0] || null; mostrarErros(dlg, []); atualizar(); };
    $('#imp-codigo').oninput = () => { est.codigo = $('#imp-codigo').value; };
    $('#imp-cancelar').onclick = fechar;
    $('#f').onsubmit = tentar(conferir);
    atualizar();
    $('h1', dlg)?.focus();
  };
  const atualizar = () => {
    ganhosMarcarRadio($('#imp-loja'), 'loja', est.loja); ganhosMarcarRadio($('#imp-tipo'), 'tipo', est.tipo);
    $('#imp-dica').textContent = est.tipo === 'cliques' ? I.dicas.cliques : I.dicas[est.loja] || I.dicas[''];
    $('#imp-arq-rot').textContent = `Arquivo CSV do relatório${est.loja ? ` da ${GANHOS_NOME_LOJA[est.loja]}` : ''}`;
    $('#imp-info').textContent = est.arquivo ? `${est.arquivo.name}, ${ganhosTamanho(Number(est.arquivo.size) || 0)}` : '';
    if (!(est.loja && est.arquivo)) $('#imp-info').textContent = est.arquivo ? `${$('#imp-info').textContent}. Escolha a loja para continuar.` : 'Escolha a loja e o arquivo para continuar.';
    $('#imp-ok').disabled = est.ocupado || !(est.loja && est.arquivo);
  };
  /** Erros que o navegador já sabe (loja, arquivo, tamanho, tipo): saem antes de enviar. */
  const errosLocais = () => {
    const erros = [];
    if (!est.loja) erros.push({ msg: I.semLoja, el: $('#imp-loja') });
    if (!est.arquivo) erros.push({ msg: I.semArquivo, el: $('#imp-arq') });
    else if (Number(est.arquivo.size) > GANHOS_MAX_BYTES) erros.push({ msg: I.grande, el: $('#imp-arq') });
    else if (!ganhosArquivoCsv(est.arquivo)) erros.push({ msg: I.tipoErrado, el: $('#imp-arq') });
    return erros;
  };
  const opcoes = (previa) => ({ loja: est.loja, tipo: est.tipo, codigo: String($('#imp-codigo')?.value ?? est.codigo).trim(), previa });
  async function conferir(ev) {
    ev?.preventDefault?.();
    if (est.ocupado) return;
    if (mostrarErros(dlg, errosLocais(), 'Não deu para importar:')) return;
    est.ocupado = true; est.codigo = opcoes(true).codigo;
    $('#imp-ok').disabled = true; $('#imp-ok').textContent = 'Conferindo…'; $('#imp-ok').setAttribute('aria-busy', 'true');
    let r;
    try { r = await ganhosEnviarCsv(est.arquivo, opcoes(true)); } catch (e) {
      est.ocupado = false; $('#imp-ok').removeAttribute('aria-busy');
      $('#imp-ok').textContent = e.rede || e.status >= 500 ? 'Tentar de novo' : 'Conferir arquivo'; atualizar();
      mostrarErros(dlg, [{ msg: e.message }], 'Não consegui importar:'); return;
    }
    est.ocupado = false;
    previa(r);
  }
  const previa = (r) => {
    const nada = r.novas === 0 && r.atualizadas === 0;
    const aviso1 = nada ? `<div class="aviso-impl neutro" role="status"><p>${r.repetidas === r.lidas ? `Todas as ${ganhosNum(r.lidas)} linhas já estavam importadas. Nada mudou.` : 'Nada novo neste arquivo: as linhas lidas já estavam importadas ou foram puladas.'}</p></div>` : '';
    dlg.innerHTML = `<form method="dialog" id="f" novalidate><h1 tabindex="-1">Confira antes de importar</h1>
      <p class="sub" style="margin:-8px 0 0">Nada foi gravado ainda. ${esc(GANHOS_NOME_LOJA[r.loja] || r.loja)}, ${r.tipo === 'cliques' ? 'relatório de cliques' : 'relatório de comissões'}.</p>
      ${aviso1}${ganhosResumoImportacao(r, { previa: true })}
      <div class="rodape"><button type="button" id="imp-voltar">Voltar</button>${nada ? '' : '<button class="pri" id="imp-gravar">Importar agora</button>'}</div></form>`;
    $('#imp-voltar').onclick = () => { formulario(); const a = est.arquivo; if (a) { $('#imp-info').textContent = `Arquivo escolhido: ${a.name}, ${ganhosTamanho(Number(a.size) || 0)}. Escolha outro para trocar.`; $('#imp-ok').disabled = !est.loja; } };
    $('#f').onsubmit = tentar(gravar);
    $('h1', dlg)?.focus();
  };
  async function gravar(ev) {
    ev?.preventDefault?.();
    if (est.ocupado) return;
    est.ocupado = true;
    const botao = $('#imp-gravar'); if (botao) { botao.disabled = true; botao.textContent = 'Importando…'; botao.setAttribute('aria-busy', 'true'); }
    let r;
    try { r = await ganhosEnviarCsv(est.arquivo, opcoes(false)); } catch (e) {
      est.ocupado = false;
      if (botao) { botao.disabled = false; botao.removeAttribute('aria-busy'); botao.textContent = e.rede || e.status >= 500 ? 'Tentar de novo' : 'Importar agora'; }
      mostrarErros(dlg, [{ msg: e.message }], 'Não consegui importar:'); return;
    }
    est.ocupado = false; est.salvou = true;
    sucesso(r);
  }
  const sucesso = (r) => {
    dlg.innerHTML = `<form method="dialog" id="f" novalidate><h1>${I.titulo}</h1>
      <h2 id="imp-titulo" tabindex="-1" style="margin:0">Importado: ${esc(GANHOS_NOME_LOJA[r.loja] || r.loja)}</h2>
      ${ganhosResumoImportacao(r, { previa: false })}
      <div class="rodape"><button type="button" id="imp-outro">Importar outro arquivo</button><button type="button" id="imp-ver" class="pri">Ver em Ganhos</button></div></form>`;
    $('#imp-ver').onclick = fechar;
    $('#imp-outro').onclick = () => { est.arquivo = null; est.codigo = ''; formulario(); };
    $('#f').onsubmit = (e) => e.preventDefault();
    $('#imp-titulo').focus();
  };
  formulario();
  dlg.showModal();
  $('h1', dlg)?.focus();
}

// ---------- diálogo "Gasto com anúncios" ----------

const ganhosGastoLinhaHtml = (g) => {
  const periodo = `${ganhosDataCompleta(g.inicio)} a ${ganhosDataCompleta(g.fim)}`;
  const id = /^\d{1,15}$/.test(String(g.id)) ? String(g.id) : '';
  return `<tr role="row" data-k="${esc(g.id)}"><td role="cell" data-rot="Período">${periodo}</td>
    <td role="cell" data-rot="Vale para">${g.nome_alvo ? esc(g.nome_alvo) : '<span class="dica">(apagado)</span>'} <small class="dica">${g.alvo_tipo === 'grupo' ? 'grupo' : 'bloco'}</small></td>
    <td role="cell" class="c-num" data-rot="Valor">${ganhosBrl(g.valor_centavos)}</td><td role="cell" data-rot="Observação">${g.nota ? esc(g.nota) : '—'}</td>
    <td role="cell" class="c-acao">${id ? `<button type="button" class="leve perigo" data-apagar-gasto="${id}" aria-label="Excluir o gasto de ${ganhosBrl(g.valor_centavos)} (${periodo})">Excluir</button>` : ''}</td></tr>`;
};
const ganhosGastosHtml = (gastos) => (gastos.length
  ? `<div class="tabela tab-din"><table role="table"><caption class="sr-only">Gastos com anúncios já informados</caption><thead role="rowgroup"><tr role="row">${['Período', 'Vale para', 'Valor', 'Observação'].map((c) => `<th scope="col" role="columnheader">${c}</th>`).join('')}<th scope="col" role="columnheader"><span class="sr-only">Ações</span></th></tr></thead><tbody role="rowgroup">${gastos.map(ganhosGastoLinhaHtml).join('')}</tbody></table></div>`
  : `<p class="dica">${TEXTOS_GANHOS.gasto.vazio}</p>`);

/** Dias entre duas datas 'AAAA-MM-DD' (inclusive os dois), ou null se alguma não for data. */
function ganhosDiasEntre(ini, fim) {
  const ok = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s); if (!ok(ini) || !ok(fim)) return null;
  const n = (s) => Date.UTC(...s.split('-').map((x, i) => (i === 1 ? Number(x) - 1 : Number(x)))) / 86400000;
  return n(fim) - n(ini) + 1;
}

/** O que o servidor recusaria pelos dados do formulário (mesmas frases). → { erros, gasto } */
function ganhosConferirGasto(v) {
  const G = TEXTOS_GANHOS.gasto; const erros = [];
  const dias = v.ini && v.fim ? ganhosDiasEntre(v.ini, v.fim) : null;
  if (!v.ini || !v.fim || dias === null) erros.push({ msg: G.periodo, el: $(v.ini ? '#gs-fim' : '#gs-ini') });
  else if (dias < 1) erros.push({ msg: G.ordem, el: $('#gs-fim') });
  else if (dias > GANHOS_MAX_DIAS_GASTO) erros.push({ msg: G.longo, el: $('#gs-ini') });
  const sep = v.alvo.indexOf(':'); const alvoTipo = sep > 0 ? v.alvo.slice(0, sep) : ''; const alvo = sep > 0 ? v.alvo.slice(sep + 1) : '';
  if ((alvoTipo !== 'grupo' && alvoTipo !== 'bloco') || !alvo) erros.push({ msg: G.alvo, el: $('#gs-alvo') });
  const centavos = ganhosLerReais(v.valor);
  if (centavos === null) erros.push({ msg: G.valorFormato, el: $('#gs-valor') });
  else if (centavos <= 0) erros.push({ msg: G.valorZero, el: $('#gs-valor') });
  const nota = v.nota.trim();
  if (nota.length > GANHOS_MAX_NOTA) erros.push({ msg: G.nota, el: $('#gs-nota') });
  return { erros, gasto: { alvo_tipo: alvoTipo, alvo, inicio: v.ini, fim: v.fim, valor_centavos: centavos, nota: nota || null } };
}

/** Diálogo "Gasto com anúncios": lança (período, grupo ou bloco, valor, observação), lista e exclui. Só o Dono. */
async function ganhosAbrirGasto() {
  if (!podeEquipe()) return;
  const G = TEXTOS_GANHOS.gasto; const dlg = $('#dlg');
  let gastos;
  try { gastos = (await api('/ganhos/gastos')).gastos; } catch (e) { aviso(e.message, true); return; }
  if (!Array.isArray(gastos)) gastos = [];
  let mexeu = false; let recarregou = false;
  const concluir = () => { if (mexeu && !recarregou) { recarregou = true; paginaGanhos({ quieto: true, foco: '#g-gasto' }); } else $('#g-gasto')?.focus(); };
  dlg.addEventListener('close', concluir, { once: true }); // Esc também
  const opcoes = `<optgroup label="Blocos">${(S.blocks || []).map((b) => `<option value="bloco:${esc(b.id)}">${esc(b.name)}</option>`).join('')}</optgroup>
    <optgroup label="Grupos">${(S.groups || []).map((g) => `<option value="grupo:${esc(g.jid)}">${esc(g.name || g.jid)}</option>`).join('')}</optgroup>`;
  dlg.innerHTML = `<form method="dialog" id="f" novalidate><h1 tabindex="-1">${G.titulo} ${q('ganhos.gasto')}</h1>
    <p class="sub" style="margin:-8px 0 0">${G.intro}</p>
    <div class="grade"><label class="campo"><span>De ${REQ}</span><input type="date" id="gs-ini"></label><label class="campo"><span>Até ${REQ}</span><input type="date" id="gs-fim"></label></div>
    <label class="campo"><span>Vale para ${REQ}</span><select id="gs-alvo"><option value="">Escolha um bloco ou grupo</option>${opcoes}</select></label>
    <label class="campo"><span>Valor em reais ${REQ}</span><input id="gs-valor" inputmode="decimal" placeholder="Ex.: 1.234,50" autocomplete="off"></label>
    <label class="campo"><span>Observação (opcional)</span><input id="gs-nota" maxlength="${GANHOS_MAX_NOTA}" placeholder="Ex.: Meta Ads, campanha de outubro" autocomplete="off"></label>
    <div class="aviso-impl" id="gs-aviso" role="status" hidden></div>
    <h2 style="margin:4px 0 0;font-size:16px">Gastos já informados</h2>
    <div id="gs-lista"></div>
    <div class="rodape"><button type="button" id="gs-fechar">Fechar</button><button class="pri" id="gs-salvar">Salvar gasto</button></div></form>`;
  const lista = () => { $('#gs-lista').innerHTML = ganhosGastosHtml(gastos); };
  lista();
  $('#gs-fechar').onclick = () => { dlg.close(); concluir(); };
  $('#gs-lista').onclick = tentar(async (e) => {
    const b = e.target.closest('[data-apagar-gasto]'); const id = b && b.dataset.apagarGasto;
    if (!id || !/^\d{1,15}$/.test(String(id))) return;
    const g = gastos.find((x) => String(x.id) === String(id));
    if (!confirm(`Excluir o gasto${g ? ` de ${ganhosBrl(g.valor_centavos)} (${ganhosDataCompleta(g.inicio)} a ${ganhosDataCompleta(g.fim)})` : ''}? Os custos por membro novo voltam ao que eram sem ele.`)) return;
    const r = await api(`/ganhos/gastos/${id}`, 'DELETE');
    gastos = Array.isArray(r.gastos) ? r.gastos : gastos.filter((x) => String(x.id) !== String(id));
    mexeu = true; lista(); aviso('Gasto excluído');
    recarregou = true; paginaGanhos({ quieto: true });
  });
  $('#f').onsubmit = tentar(async (ev) => {
    ev.preventDefault();
    const { erros, gasto } = ganhosConferirGasto({ ini: $('#gs-ini').value, fim: $('#gs-fim').value, alvo: $('#gs-alvo').value, valor: $('#gs-valor').value, nota: $('#gs-nota').value });
    if (mostrarErros(dlg, erros)) return;
    let r;
    try { r = await api('/ganhos/gastos', 'POST', gasto); } catch (e) { mostrarErros(dlg, [{ msg: e.message }], 'Não consegui salvar o gasto:'); return; }
    gastos = Array.isArray(r.gastos) ? r.gastos : gastos;
    mexeu = true; lista();
    const av = $('#gs-aviso'); av.textContent = r.aviso || ''; av.hidden = !r.aviso;
    $('#gs-valor').value = ''; $('#gs-nota').value = '';
    aviso('Gasto salvo');
    recarregou = true; paginaGanhos({ quieto: true });
  });
  dlg.showModal();
  $('h1', dlg)?.focus();
}
