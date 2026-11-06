// Conexões (#conexoes; os endereços antigos #etiquetas e a extensão de Ajustes vieram para cá).
// Mercado Livre: etiquetas de afiliado + extensão do Chrome. Amazon: tag, credencial da API e teste (4 estados do selo).
// Shopee (plano integracao-shopee, etapa 9): ID de afiliado, AppID e Senha da API em dois fieldset, linha da extensão,
// aviso "Antes de usar", 6 selos e teste por `resultado`. As funções `cx*` são puras (testadas em test/shopee-painel.test.js).
// Magalu (plano integracao-magalu, etapa 4; spec docs/produto/specs/integracao-magalu.md, seção 1): um campo só (o nome da loja
// de parceiro), sem "Testar": no lugar, o link "Conferir minha loja", montado só do nome SALVO que casa a regra. As funções
// `cxMagalu*` são puras (testadas em test/magalu-painel.test.js).
// Catálogo do Etiqueta (plano fonte-catalogo-etiqueta, etapa 6): cartão próprio no fim do arquivo (`cxCat*`, testadas
// em test/catalogo-conexoes-painel.test.js); cartaoConexao, aplicarConexao e ligarConexao desviam para ele.
// Carrega antes de app.js: só define funções. Os utilitários de app.js e paineis.js ($, $$, esc, api,
// aviso, tentar, mostrarErros, REQ, S, atualizarEstado, podeEquipe, dataHora) só são usados quando as funções rodam.

const TEXTOS_CONEXOES = {
  sub: 'Plataformas ligadas ao painel.',
  mlDesc: 'Gera os links meli.la com as suas etiquetas, pela extensão do Chrome.',
  conectado: 'Conectado',
  falta: 'Falta configurar',
  impl: 'Ainda não implementado',
  pronta: 'Configurada',
  avisoImpl: '<b>Ainda não implementado.</b> Você já pode guardar os dados. O painel só vai usar quando a integração existir.',
  avisoImplSemCampos: '<b>Ainda não implementado.</b> Em breve neste painel.',
  segredoSalvo: '•••••••• salva; digite para trocar',
  segredoSoDono: 'Só o Dono vê e troca esta chave.',
  tokenSoDono: 'Só o Dono pode gerar um novo token.',
  nadaSalvo: 'Nada salvo ainda. Salve os dados para poder testar.',
  salvoEm: (ms) => `Dados salvos em ${dataHora(ms)}.`,
  carregando: 'Carregando as outras lojas…',
  erroCarregar: 'Não consegui carregar as outras lojas.',
  formatoSegredo: 'formato inválido. Confira se copiou o valor inteiro, sem espaços.',
  // Amazon (a API oficial é a Creators API; sem ela o espelhamento usa o texto da mensagem de origem)
  soTag: 'Só com a tag',
  amazonConectada: 'Conectada',
  credencialSalva: 'Credencial salva',
  amazonDesc: 'Programa de Associados da Amazon. Com a API oficial, o painel busca título, preço e foto do produto e gera o link com a sua tag.',
  // EM BREVE (etapa 14): ' Sem esse acesso o espelhamento continua funcionando, só que usa o título e os preços escritos na mensagem de origem.'
  amazonPreRequisito: '<b>Antes de usar a API:</b> a API oficial da Amazon (Creators API) exige uma conta de Associados aprovada na Amazon Brasil e vendas qualificadas recentes (hoje, ao menos 10 nos últimos 30 dias).',
  amazonComoConseguir: 'Como conseguir as credenciais (abre em outra aba)',
  amazonDocs: 'https://affiliate-program.amazon.com/creatorsapi/docs',
  espelhosEmUso: (n) => (n === 1 ? 'Há 1 espelhamento usando o texto da origem.' : `Há ${n} espelhamentos usando o texto da origem.`),
  verEspelhamentos: 'Ver espelhamentos',
  // resultado do teste da Amazon, por `resultado` (a frase vem daqui; nunca repete o ID nem o segredo)
  testeAmazon: {
    ok: 'Credencial aceita pela Amazon.',
    recusada: 'A Amazon não aceitou a credencial. Confira o ID e o segredo e se a credencial está ativa.',
    sem_acesso: 'A credencial é válida, mas a conta ainda não tem acesso à API. Confira se há vendas qualificadas nos últimos 30 dias.',
    tag_invalida: 'A tag não pertence a esta credencial/loja.',
    indisponivel: 'A Amazon não respondeu agora. Tente de novo em alguns minutos.',
  },
  // Shopee: o link sai pela extensão do Chrome ou pela API; os dados do produto, só pela API (plano integracao-shopee)
  shopee: {
    conectada: 'Conectada', soId: 'Só com o ID', semAcessoSelo: 'Sem acesso à API', credenciaisSalvas: 'Credenciais salvas', recusada: 'Credencial recusada',
    extOn: '✓ Extensão do Chrome conectada. Os links da Shopee saem por ela, com o Chrome logado no portal de afiliados.',
    extOff: '! Extensão do Chrome desconectada. Abra o Chrome com a extensão e entre no portal de afiliados da Shopee, ou ligue a API abaixo.',
    antesTitulo: 'Antes de usar: deixe o Chrome pronto e, se quiser a busca automática, peça a API.',
    antesTituloSemAcesso: 'A Shopee ainda não liberou a API para a sua conta.',
    passo1: '<b>Para os links:</b> deixe o Chrome logado no portal de afiliados da Shopee e recarregue a extensão em <code>chrome://extensions</code> (é preciso a versão 1.3.0 ou mais nova; ela ganhou uma permissão nova).',
    passo2: '<b>Para buscar título, preço e foto sozinha:</b> peça acesso à <a href="https://affiliate.shopee.com.br/open_api" target="_blank" rel="noopener">Open API de Afiliados (abre em outra aba)</a> ou, se o botão “Aplicar” estiver desabilitado, ao <a href="https://help.shopee.com.br/portal/webform/bbce78695c364ba18c9cbceb74ec9091" target="_blank" rel="noopener">formulário de atendimento da Shopee (abre em outra aba)</a>.',
    passo3: 'A Shopee responde em até 3 dias úteis. Quando liberarem, a mesma página mostra o AppID e a Senha da API. Copie os dois para os campos abaixo.',
    fecho: 'Sem a API você já dispara: só precisa preencher título e preço à mão.',
    comoConfigurar: 'Como configurar',
    legendConta: 'Sua conta de afiliado', legendApi: 'Acesso à API',
    ctxApi: 'Estes dois só existem depois que a Shopee liberar a API. Pode deixar em branco: os links já saem pela extensão.',
    semAppIdSenha: 'Para testar, salve o AppID e a Senha da API. Eles aparecem depois que a Shopee liberar a API.',
    nadaSalvo: 'Nada salvo ainda.',
    faltaId: 'Falta o ID de afiliado. Sem ele os links não saem.',
    idTagAmazon: 'O ID de afiliado da Shopee tem só números. O que você digitou parece uma tag da Amazon: ela vai em Conexões > Amazon.',
    idFormato: 'ID de afiliado: use só números, como 98765432101.',
    appIdFormato: 'AppID: use só números.',
    appIdIgual: 'O AppID e o ID de afiliado são números diferentes. Confira os dois no portal da Shopee.',
    // resultado do teste, por `resultado` (a frase vem daqui; nunca repete ID, AppID nem Senha)
    teste: {
      ok: 'Credenciais aceitas pela Shopee.',
      recusada: 'A Shopee não aceitou o AppID ou a Senha da API. Confira se copiou os dois por inteiro, sem espaços, se o aplicativo está ativo no painel de afiliados e se a data e a hora do computador estão certas.',
      sem_acesso: 'A Shopee ainda não liberou a API para a sua conta. Peça o acesso pelo link acima e tente de novo quando eles responderem. Enquanto isso os links continuam saindo pela extensão.',
      conta_restrita: 'A Shopee recusou o acesso desta conta (acesso negado, ID de afiliado inválido, conta com restrição ou credenciais de outra conta). Fale com o suporte de afiliados da Shopee.',
      nao_configurada: 'Salve o AppID e a Senha da API para testar.',
      cota: 'A Shopee limitou as consultas por agora. Tente de novo em alguns minutos.',
      indisponivel: 'A Shopee não respondeu agora. Tente de novo em alguns minutos.',
      sem_id: 'Credenciais aceitas, mas falta o ID de afiliado.',
    },
  },
  // Magalu: o link de afiliado leva o nome da loja de parceiro (sem API, senha nem leitura do produto). Nenhuma frase repete o valor digitado.
  magalu: {
    conferir: 'Conferir minha loja (abre em outra aba)',
    nadaSalvo: 'Nada salvo ainda.',
    salveParaConferir: 'Salve o nome da loja para poder conferir.',
    naoConfirma: 'O painel não consegue confirmar que o nome existe: use “Conferir minha loja”.',
    enderecoColado: 'Escreva só o nome da loja, sem o endereço. Se o endereço é magazinevoce.com.br/minhaloja, escreva minhaloja.',
    espacoAcento: 'O nome da loja não leva espaços nem acentos. Copie do endereço da sua loja, depois de magazinevoce.com.br/.',
    tamanho: 'O nome da loja tem de 2 a 60 caracteres.',
    caractere: 'Use só letras, números, hífen ou _ no nome da loja.',
    recusadaServidor: 'Escreva só o nome da loja', // começo da frase fixa do servidor (src/lojas.js, `erro` do campo): leva o foco ao campo
  },
  // Catálogo do Etiqueta (plano fonte-catalogo-etiqueta, etapa 6; spec, seção 1). Não é loja: é fonte de ofertas.
  catalogo: {
    sub: 'Fonte de ofertas',
    desc: 'O Etiqueta é o seu outro programa de ofertas, que roda neste computador. O painel lê as ofertas dele, que já vêm com o seu link de afiliado, e usa como fonte nos disparos automáticos. Não tem relação com as etiquetas do Mercado Livre.',
    legend: 'Como falar com o Etiqueta',
    rotuloEndereco: 'Endereço do Etiqueta', rotuloCaminho: 'Arquivo do token',
    dicaEndereco: 'Onde o servidor do Etiqueta está rodando (python3 servidor.py). Só vale endereço deste computador: localhost ou 127.0.0.1. Já vem preenchido com o padrão.',
    dicaCaminho: 'Caminho do arquivo api_token.txt que está na pasta do Etiqueta. Cole o <b>caminho</b>, nunca o conteúdo: o painel lê o arquivo e o token não passa por esta tela.', // HTML fixo
    placeholderCaminho: '/home/ufla/Documentos/mensagensParaEnviar/api_token.txt',
    enderecoPadrao: 'http://127.0.0.1:8765', // só se o servidor não mandar endereco_padrao
    soDono: 'Só o Dono muda esta conexão.',
    salvos: 'Catálogo: dados salvos',
    semSalvar: 'Salve o endereço e o caminho do arquivo do token para testar.',
    mudou: 'Você mudou os campos. Salve antes de testar.',
    verificadoEm: (ms) => `Verificado em ${dataHora(ms)}.`,
    // selos (spec, tabela "Selo e estados"): [classe de .estado-pill, texto]
    selos: {
      falta_configurar: ['falta', 'Falta configurar'], salva: ['', 'Salvo, ainda não testado'], conectada: ['conectado', 'Conectada'],
      token_recusado: ['erro', 'Token recusado'], indisponivel: ['pendente', 'Indisponível'], sem_arquivo: ['erro', 'Arquivo do token não encontrado'],
    },
    // resultado do "Testar" e da última verificação, por `resultado`. Nunca repete o token nem o conteúdo do arquivo;
    // o endereço e o caminho são os salvos (do dono). Saem sempre como texto (textContent ou esc()).
    teste: {
      ok: (n) => `Conectado. ${cxCatPlural(n.total, 'oferta', 'ofertas')} em ${cxCatPlural(n.categorias, 'categoria', 'categorias')}.`,
      token_recusado: () => 'O Etiqueta recusou o token. Se você trocou o arquivo do token, reinicie o servidor.py do Etiqueta (ele lê o arquivo só ao ligar) e teste de novo.',
      desligada: () => 'O Etiqueta está no ar, mas a API dele está desligada. Falta o arquivo api_token.txt (ou ele é inválido) na pasta do Etiqueta. O terminal do servidor.py diz o motivo. Depois de corrigir, reinicie-o e teste de novo.',
      fora_do_ar: (_n, cfg) => `Não consegui falar com o Etiqueta${cfg.endereco ? ` em ${cfg.endereco}` : ''}. Confira se ele está ligado (python3 servidor.py) e se o endereço e a porta estão certos.`,
      sem_arquivo: (_n, cfg) => `Não encontrei o arquivo do token${cfg.caminho_token ? ` em ${cfg.caminho_token}` : ''}. Confira o caminho, e se este programa tem permissão para ler o arquivo.`,
      arquivo_invalido: () => 'O arquivo do token está vazio ou fora do formato (32 ou mais letras, números, _ e -). Gere o token de novo no Etiqueta.',
      resposta_inesperada: () => 'O Etiqueta respondeu algo que não esperávamos. Tente de novo; se continuar, veja o terminal do servidor.py.',
      nao_configurada: () => 'Salve o endereço e o caminho do token para testar.',
    },
    // validação no cliente (o servidor confere de novo); nenhuma frase repete o valor digitado
    enderecoVazio: 'Informe o endereço do Etiqueta. O padrão é http://127.0.0.1:8765.',
    enderecoFormato: 'Use só o endereço deste computador, como http://127.0.0.1:8765 (sem o que vem depois da porta).',
    caminhoVazio: 'Informe o caminho do arquivo do token.',
    pareceToken: 'Isto parece o token, não o caminho do arquivo. Cole o caminho (por exemplo, …/api_token.txt). Se você colou o token em algum lugar, gere outro no Etiqueta.',
    caminhoInvalido: 'Caminho inválido.',
    caminhoFormato: 'Caminho inválido. Use o caminho completo do arquivo, começando por / ou ~/.',
    // categorias da última verificação (só em `conectada`)
    resumo: (total, nCats, l) => `${cxCatPlural(total, 'oferta', 'ofertas')} em ${cxCatPlural(nCats, 'categoria', 'categorias')}. Mercado Livre: ${cxCatNum(l.ml)} · Amazon: ${cxCatNum(l.amazon)} · Shopee: ${cxCatNum(l.shopee)}.`,
    tituloCats: (n) => `Categorias do Etiqueta (${cxCatNum(n)})`,
    caption: 'Categorias do Etiqueta e total de ofertas por loja',
    regiao: 'Tabela de categorias do Etiqueta',
    colunas: ['Categoria', 'Total', 'Mercado Livre', 'Amazon', 'Shopee'],
    semOfertas: 'O Etiqueta está conectado, mas ainda não tem ofertas. Colete ofertas nele e teste de novo.',
    nota: 'Esta lista é a da última verificação. Se o Etiqueta ganhar categorias novas, clique em “Testar” para atualizar.',
  },
};

function paginaConexoes({ rolarPara } = {}) {
  const url = S.st.endereco_publico || `http://127.0.0.1:${S.st.porta}`;
  $('#pagina').innerHTML = `<div class="topo"><div><h1>Conexões ${q('conexoes')}</h1><p class="sub">${TEXTOS_CONEXOES.sub}</p></div></div>
    <div class="conexoes">
      <article class="card conexao conexao-ml" aria-labelledby="cx-ml">
        <header><h2 id="cx-ml">Mercado Livre</h2><span class="estado-pill" id="ml-selo"></span></header>
        <p class="desc">${TEXTOS_CONEXOES.mlDesc}</p>
        <section class="secao" id="ml-etiquetas" aria-labelledby="ml-etq-h"></section>
        <section class="secao" aria-labelledby="ml-ext-h">
          <h3 id="ml-ext-h">Extensão do Chrome ${q('ajustes.extensao')}</h3>
          <ol class="passos"><li>Instale a extensão no Chrome (pasta <code>extension</code> do programa).</li>
            <li>Abra a Central de Afiliados nesse Chrome, logado na sua conta do Mercado Livre.</li>
            <li>Clique no ícone da extensão e cole o endereço e o token abaixo.</li></ol>
          <label class="campo">Endereço<div class="copia"><input readonly value="${esc(url)}" id="c1"><button type="button" data-c="c1" aria-label="Copiar endereço">Copiar</button></div></label>
          <label class="campo">Token<div class="copia"><input readonly value="${esc(S.st.ext_token)}" id="c2"><button type="button" data-c="c2" aria-label="Copiar token">Copiar</button></div></label>
          <p class="estado-linha" id="ml-estado" role="status"></p>
          <div class="linha">${podeEquipe() ? '<button type="button" id="novo-token" class="leve perigo">Gerar novo token</button><small class="dica">Use se achar que o token vazou. A extensão para de funcionar até você colar o novo.</small>'
    : `<small class="dica">${TEXTOS_CONEXOES.tokenSoDono}</small>`}</div>
        </section>
      </article>
    </div>
    <div class="conexoes" id="outras-lojas"></div>`;
  paginaEtiquetas($('#ml-etiquetas'));
  pintarEstadoML();
  $$('[data-c]', $('#pagina')).forEach((b) => (b.onclick = async () => { await navigator.clipboard.writeText($('#' + b.dataset.c).value); aviso('Copiado'); }));
  // Operador: o botão não existe (podeEquipe, de app.js); o servidor também recusa com 403.
  if ($('#novo-token')) $('#novo-token').onclick = tentar(async () => {
    if (!confirm('Gerar um novo token? A extensão do Chrome vai parar até você colar o token novo nela.')) return;
    await api('/ajustes/token', 'POST'); await atualizarEstado(); aviso('Token novo gerado'); paginaConexoes();
  });
  if (rolarPara) $('#' + rolarPara)?.scrollIntoView({ block: 'start' });
  outrasLojas();
}

/** Selo do cartão e linha de estado da extensão. Também chamada por atualizarEstado (app.js) a cada 3 s nesta página. */
function pintarEstadoML() {
  const cx = $('#cx-shopee'); // a linha da extensão e o selo da Shopee acompanham a extensão, como o cartão do Mercado Livre
  const ult = cx && cxUltimo.get(cx);
  if (ult && S.st?.extensao && ult.extensao_online !== S.st.extensao.online) pintarSeloConexao(cx, { ...ult, extensao_online: S.st.extensao.online });
  const selo = $('#ml-selo'); const linha = $('#ml-estado'); if (!selo || !linha) return;
  const e = S.st.extensao; const direto = S.st.ajustes.link_mode === 'direct';
  const ok = S.tags.length > 0 && e.online && !direto;
  selo.className = 'estado-pill ' + (ok ? 'conectado' : 'falta');
  selo.textContent = ok ? TEXTOS_CONEXOES.conectado : TEXTOS_CONEXOES.falta;
  const erro = e.lastError ? ` Último erro: ${e.lastError}.` : '';
  const texto = direto ? 'Modo direto ligado em Ajustes: os links saem sem etiqueta e não geram comissão.'
    : e.online ? `Extensão conectada. ${e.lastOkAt ? `Último link gerado em ${dataHora(e.lastOkAt)}.` : 'Nenhum link gerado ainda.'}${erro}`
      : `Extensão desconectada.${erro || ' Abra o Chrome com a extensão instalada e logado na Central de Afiliados.'}`;
  linha.classList.toggle('aviso', direto || !e.online);
  if (linha.textContent !== texto) linha.textContent = texto;
}

// ---------- etiquetas de afiliado (era a página #etiquetas; agora é uma seção do cartão Mercado Livre) ----------
function paginaEtiquetas(el = $('#ml-etiquetas')) {
  if (!el) return;
  el.innerHTML = `<h3 id="ml-etq-h">Etiquetas de afiliado ${q('etiquetas')}</h3>
    <p class="desc">Os nomes das suas etiquetas do programa de afiliados do Mercado Livre, escritos exatamente como aparecem lá. Depois escolha qual usar em cada disparo automático.</p>
    <form id="nt" novalidate><div class="linha"><label class="campo" style="flex:1;min-width:200px"><span>Nome da etiqueta ${REQ}</span><input name="name" placeholder="Ex.: achadosdesejo" style="width:100%"></label>
      <label class="campo" style="flex:1;min-width:200px"><span>Anotação (opcional)</span><input name="note" placeholder="Ex.: grupo de casa"></label><button class="pri" style="align-self:end">Adicionar etiqueta</button></div></form>
    ${S.tags.length ? `<div class="tabela"><table><thead><tr><th scope="col">Etiqueta</th><th scope="col">Anotação</th><th scope="col">Usada em</th><th scope="col"></th></tr></thead><tbody>
      ${S.tags.map((t) => { const uso = S.rules.filter((r) => r.tag_id === t.id).length; return `<tr><td><span class="chip etq">${esc(t.name)}</span></td><td>${esc(t.note)}</td><td>${uso} ${uso === 1 ? 'disparo automático' : 'disparos automáticos'}</td><td style="text-align:right"><button type="button" class="perigo leve" data-del="${t.id}" aria-label="Excluir a etiqueta ${esc(t.name)}">Excluir</button></td></tr>`; }).join('')}
      </tbody></table></div>` : '<div class="vazio">Nenhuma etiqueta cadastrada.</div>'}`;
  const recarregar = async () => { S.tags = await api('/tags'); paginaEtiquetas(el); pintarEstadoML(); };
  $('#nt', el).onsubmit = tentar(async (ev) => {
    ev.preventDefault(); const f = new FormData(ev.target); const nome = String(f.get('name') || '').trim();
    const erros = [];
    if (!nome) erros.push({ msg: 'Digite o nome da etiqueta, igual ao cadastrado na Central de Afiliados.', el: $('[name=name]', ev.target) });
    else if (!/^[\w.-]{2,60}$/.test(nome)) erros.push({ msg: 'A etiqueta deve ter 2 a 60 caracteres: letras, números, ponto, hífen ou _ (sem espaços).', el: $('[name=name]', ev.target) });
    if (mostrarErros(ev.target, erros)) return;
    try { await api('/tags', 'POST', { name: nome, note: f.get('note') }); } catch (e) { mostrarErros(ev.target, [{ msg: e.message }]); return; }
    aviso('Etiqueta adicionada'); await recarregar();
  });
  $$('[data-del]', el).forEach((b) => (b.onclick = tentar(async () => { await api('/tags/' + b.dataset.del, 'DELETE'); await recarregar(); })));
}

// ---------- outras lojas (Amazon, Shopee, Magalu, Facebook) ----------
// Os campos vêm do registro do servidor (GET /api/conexoes → campos). O valor de um segredo nunca vem nem é
// posto no HTML: o servidor só diz quais estão salvos (segredos_salvos); campo de segredo vazio ao salvar
// mantém o que está guardado. Sem segredos_salvos na resposta (Operador), o campo de segredo fica travado.
async function outrasLojas() {
  const el = $('#outras-lojas'); if (!el) return;
  el.innerHTML = `<p class="dica" role="status">${TEXTOS_CONEXOES.carregando}</p>`;
  let lista;
  try { lista = await api('/conexoes'); } catch (e) {
    if (el.isConnected) el.innerHTML = `<div class="vazio" role="status">${esc(`${TEXTOS_CONEXOES.erroCarregar} ${e.message}`)}</div>`;
    return;
  }
  if (!el.isConnected || !Array.isArray(lista)) return; // saiu da página enquanto carregava
  const outras = lista.filter((p) => p && p.id !== 'mercadolivre');
  el.innerHTML = outras.map(cartaoConexao).join('');
  outras.forEach((p) => { const art = $(`#cx-${CSS.escape(p.id)}`, el); if (art) { aplicarConexao(art, p); ligarConexao(art, p); } });
}

/**
 * Classe e texto do selo para o `estado` que o servidor manda. Texto sempre visível (nunca só cor).
 * A Amazon tem 4 estados: falta_configurar, so_tag (aviso), pronta ("Credencial salva", neutro) e conectada.
 * A Shopee tem 6 (`p` é o cartão: `so_id` fica verde se a extensão está on-line, senão em aviso).
 */
function pillConexao(estado, id, p = {}) {
  if (id === 'amazon') {
    const a = {
      falta_configurar: ['falta', TEXTOS_CONEXOES.falta], so_tag: ['pendente', TEXTOS_CONEXOES.soTag],
      pronta: ['', TEXTOS_CONEXOES.credencialSalva], conectada: ['conectado', TEXTOS_CONEXOES.amazonConectada],
    }[estado];
    if (a) return a;
  }
  if (id === 'shopee') {
    const Sh = TEXTOS_CONEXOES.shopee;
    const tabela = {
      falta_configurar: ['falta', TEXTOS_CONEXOES.falta], so_id: [p.extensao_online === true ? 'pronta' : 'pendente', Sh.soId],
      sem_acesso: ['pendente', Sh.semAcessoSelo], pronta: ['', Sh.credenciaisSalvas],
      conectada: ['conectado', Sh.conectada], erro_credencial: ['erro', Sh.recusada],
    };
    if (Object.hasOwn(tabela, estado)) return tabela[estado];
  }
  if (id === 'catalogo') { // 6 estados (spec, seção 1); estado desconhecido cai no genérico abaixo
    const tabela = TEXTOS_CONEXOES.catalogo.selos;
    if (Object.hasOwn(tabela, estado)) return tabela[estado];
  }
  return {
    conectado: ['conectado', TEXTOS_CONEXOES.conectado], conectada: ['conectado', TEXTOS_CONEXOES.conectado],
    pronta: ['pronta', TEXTOS_CONEXOES.pronta], falta_configurar: ['falta', TEXTOS_CONEXOES.falta],
  }[estado] || ['impl', TEXTOS_CONEXOES.impl];
}

// ---------- Shopee: peças puras do cartão ----------
/** Linha da extensão (spec, item 3): texto com "✓" ou "!" e se está desconectada (`off`). */
function cxExtLinha(p) {
  const on = p?.extensao_online === true;
  return { texto: on ? TEXTOS_CONEXOES.shopee.extOn : TEXTOS_CONEXOES.shopee.extOff, off: !on };
}

/**
 * Aviso "Antes de usar" (`.aviso-impl` com `.aviso-corpo` e `.passos`). Visível até a Shopee estar `conectada`;
 * depois fica recolhido em <details> "Como configurar". Em `sem_acesso` o título diz que a Shopee ainda não liberou.
 */
function cxAvisoShopee(p) {
  const T = TEXTOS_CONEXOES.shopee;
  const titulo = p?.estado === 'sem_acesso' ? T.antesTituloSemAcesso : T.antesTitulo;
  const corpo = `<p><b>${esc(titulo)}</b></p>
    <ol class="passos"><li>${T.passo1}</li><li>${T.passo2}</li><li>${T.passo3}</li></ol>
    <p>${T.fecho}</p>`;
  const miolo = p?.estado === 'conectada' ? `<details><summary>${T.comoConfigurar}</summary>${corpo}</details>` : corpo;
  return `<div class="aviso-impl${p?.estado === 'conectada' ? ' neutro' : ''}"><div class="aviso-corpo">${miolo}</div></div>`;
}

/** "Testar" só com AppID e Senha da API salvos (Shopee); nas outras lojas, depois de salvar algo. Operador não vê os segredos salvos: o servidor decide. */
function cxTestarBloqueado(p) {
  if (p?.id !== 'shopee') return !p?.updated_at;
  const salvos = Array.isArray(p.segredos_salvos) ? p.segredos_salvos : null;
  return !(p.config?.app_id && (salvos === null || salvos.includes('chave')));
}

/** Falha da última verificação (frase fixa do servidor) em Amazon e Shopee; '' se não houve falha. */
function cxFalhaVerificacao(p) {
  if (!['amazon', 'shopee'].includes(p?.id) || !p.situacao) return '';
  return ['ok', 'desconhecido', 'nao_configurada'].includes(p.situacao.acesso) ? '' : p.situacao.motivo || '';
}

/** Linha de estado do cartão: { texto, aviso }. A falha da verificação fica visível ao recarregar, em texto e não só no selo. */
function cxLinhaEstado(p) {
  const T = TEXTOS_CONEXOES; const shopee = p?.id === 'shopee';
  if (p?.id === 'magalu') { // sem verificação no servidor: só diz o que está salvo e, sem nome, como conferir depois
    const salvo = p.updated_at ? T.salvoEm(p.updated_at) : T.magalu.nadaSalvo;
    return { texto: [salvo, cxMagaluHref(p) ? '' : T.magalu.salveParaConferir].filter(Boolean).join(' '), aviso: false };
  }
  const base = p.updated_at ? T.salvoEm(p.updated_at) : shopee ? T.shopee.nadaSalvo : T.nadaSalvo;
  const falha = cxFalhaVerificacao(p);
  const faltaId = shopee && ['pronta', 'sem_acesso', 'erro_credencial'].includes(p.estado) && !p.config?.id_afiliado ? T.shopee.faltaId : '';
  const dica = shopee && cxTestarBloqueado(p) ? T.shopee.semAppIdSenha : '';
  return { texto: [falha, faltaId, base, dica].filter(Boolean).join(' '), aviso: !!(falha || faltaId) };
}

/** Frase do resultado do "Testar": { frase, ok, aviso }. Shopee: sempre a da tela por `resultado`; nunca repete ID, AppID nem Senha. */
function cxFraseTeste(p, r) {
  const T = TEXTOS_CONEXOES; r = r || {};
  if (p?.id === 'shopee') {
    const frase = Object.hasOwn(T.shopee.teste, r.resultado) ? T.shopee.teste[r.resultado] : r.mensagem || '';
    return { frase, ok: !!r.ok, aviso: !r.ok };
  }
  // Na Amazon a frase vem de `resultado` (texto fixo da tela). No sucesso vale a do servidor (frase fixa), que pode
  // trazer a dica de cadastrar a tag; sem `resultado` conhecido, também a mensagem do servidor.
  const fraseTela = p?.id === 'amazon' && !r.ok ? T.testeAmazon[r.resultado] : null;
  return { frase: fraseTela || r.mensagem || T.testeAmazon[r.resultado] || '', ok: !!r.ok, aviso: !r.ok };
}

const cxSemZeros = (v) => String(v ?? '').replace(/^0+/, '');
/** Erro de um campo da Shopee antes de enviar (nunca repete o valor). Segredo e limites: erroCampoConexao. */
function cxErroCampoShopee(c, v) {
  const T = TEXTOS_CONEXOES.shopee;
  let re = null; try { re = c.padrao ? new RegExp(c.padrao) : null; } catch { /* o servidor confere */ }
  if (c.nome === 'id_afiliado') {
    if (re ? re.test(v) : /^[0-9]{5,20}$/.test(v)) return '';
    return /[A-Za-z-]/.test(v) ? T.idTagAmazon : T.idFormato; // letras ou traço: o engano mais provável é a tag da Amazon
  }
  if (c.nome === 'app_id' && /[^0-9]/.test(v)) return T.appIdFormato;
  return erroCampoConexao(c, v);
}
/** AppID e ID de afiliado são números diferentes (o servidor também recusa, com 400). */
function cxCruzaShopee(campos) {
  const id = cxSemZeros(campos?.id_afiliado); const app = cxSemZeros(campos?.app_id);
  return id && app && id === app ? TEXTOS_CONEXOES.shopee.appIdIgual : '';
}
/** Elemento que leva o foco quando o servidor recusa o AppID igual ao ID (a mensagem é fixa). */
const cxElDoErro = (form, msg) => {
  const m = String(msg || '');
  if (m.includes('O AppID e o ID de afiliado')) return form.elements.namedItem('app_id');
  return m.startsWith(TEXTOS_CONEXOES.magalu.recusadaServidor) ? form.elements.namedItem('loja') : undefined;
};

// ---------- Magalu: peças puras do cartão ----------
/** Mesma regra do campo `loja` de src/lojas.js (RE_LOJA_MAGALU); o teste confere que não divergiram. */
const CX_MAGALU_RE_LOJA = /^[A-Za-z0-9_-]{2,60}$/;
/**
 * Endereço de "Conferir minha loja": só do nome SALVO (nunca o digitado) e só se casa a regra; senão ''. O nome vai
 * por encodeURIComponent (a regra já exclui qualquer caractere que precise dele, mas o href nunca depende só dela).
 */
function cxMagaluHref(p) {
  const loja = p?.config?.loja;
  return typeof loja === 'string' && CX_MAGALU_RE_LOJA.test(loja) ? `https://www.magazinevoce.com.br/${encodeURIComponent(loja)}/` : '';
}
/** HTML do link-botão (string vazia sem loja salva: o link não existe). `href` vem de cxMagaluHref. */
function cxMagaluLinkHtml(href) {
  return href ? `<a class="btn" data-conferir href="${esc(href)}" target="_blank" rel="noopener" style="text-decoration:none;overflow-wrap:anywhere">${TEXTOS_CONEXOES.magalu.conferir}</a>` : '';
}
/**
 * Erro do nome da loja antes de enviar (só chamada com valor não vazio: vazio apaga). A regra vem do registro
 * (`c.padrao`); a frase depende do engano mais provável, na ordem da spec: endereço colado, espaço ou acento, tamanho, outro caractere.
 */
function cxErroCampoMagalu(c, v) {
  const T = TEXTOS_CONEXOES.magalu;
  let re = null; try { re = c?.padrao ? new RegExp(c.padrao) : null; } catch { /* o servidor confere */ }
  if ((re || CX_MAGALU_RE_LOJA).test(v)) return '';
  if (/[/.]|http/i.test(v)) return T.enderecoColado;
  if (/\s|[^\x00-\x7f]/.test(v)) return T.espacoAcento;
  if (v.length < 2 || v.length > 60) return T.tamanho;
  return T.caractere;
}

/** Os dois fieldset da Shopee: o que identifica a conta × o que é credencial da API. Cada campo leva a sua ajuda (`?`). */
function cxFormShopee(p, campos) {
  const T = TEXTOS_CONEXOES.shopee; const id = esc(p.id);
  const um = (nome, opcoes) => { const c = campos.find((x) => x.nome === nome); return c ? campoConexao(p, c, opcoes) : ''; };
  return `<fieldset><legend>${T.legendConta}</legend>${um('id_afiliado', { numerico: true, tip: 'conexoes.shopee.id' })}</fieldset>
      <fieldset><legend>${T.legendApi}</legend><p class="dica" id="cx-${id}-ctx" data-ctx-api>${T.ctxApi}</p>
        ${um('app_id', { numerico: true, tip: 'conexoes.shopee.appid' })}${um('chave', { tip: 'conexoes.shopee.senha' })}</fieldset>`;
}

function cartaoConexao(p) {
  if (p?.id === 'catalogo' && p.implementada) return cartaoCatalogo(p);
  const id = esc(p.id); const campos = Array.isArray(p.campos) ? p.campos : [];
  const amazon = p.id === 'amazon' && p.implementada;
  const shopee = p.id === 'shopee' && p.implementada;
  const magalu = p.id === 'magalu' && p.implementada;
  const ext = cxExtLinha(p);
  const aviso = shopee
    ? `<p class="ext-linha${ext.off ? ' off' : ''}" role="status" data-ext><span data-ext-txt>${ext.texto}</span> ${q('conexoes.shopee.extensao')}</p>
      <div data-antes>${cxAvisoShopee(p)}</div>`
    : amazon
      ? `<div class="aviso-impl"><p>${TEXTOS_CONEXOES.amazonPreRequisito} <a href="${TEXTOS_CONEXOES.amazonDocs}" target="_blank" rel="noopener">${TEXTOS_CONEXOES.amazonComoConseguir}</a></p></div>
      <p class="dica" data-espelhos role="status" hidden></p>`
      : p.implementada ? '' : `<div class="aviso-impl"><p>${campos.length ? TEXTOS_CONEXOES.avisoImpl : TEXTOS_CONEXOES.avisoImplSemCampos}</p></div>`;
  const desc = amazon ? TEXTOS_CONEXOES.amazonDesc : p.descricao;
  const form = !campos.length ? '' : `<form novalidate>
      ${shopee ? cxFormShopee(p, campos) : magalu ? campos.map((c) => campoConexao(p, c, { tip: 'conexoes.magalu.loja', minusculas: true })).join('') : campos.map((c) => campoConexao(p, c)).join('')}
      <div class="acoes"><button type="submit" class="pri">Salvar</button>${magalu
        ? '<span data-conferir-box style="display:contents"></span>'
        : `<button type="button" data-testar aria-describedby="cx-${id}-estado">Testar</button>`}</div>
      <p class="estado-linha" id="cx-${id}-estado" role="status"></p>${magalu ? '\n      <p class="dica" data-magalu-nota hidden></p>' : ''}
    </form>`;
  return `<article class="card conexao" id="cx-${id}" aria-labelledby="cx-${id}-h">
    <header class="cab"><h2 id="cx-${id}-h">${esc(p.nome || p.id)}${amazon ? ' ' + q('conexoes.amazon') : shopee ? ' ' + q('conexoes.shopee') : magalu ? ' ' + q('conexoes.magalu') : ''}</h2><span class="estado-pill"></span></header>
    ${desc ? `<p class="desc">${esc(desc)}</p>` : ''}
    ${aviso}${form}
  </article>`;
}

/**
 * Um campo do registro. Sem `value` no segredo (nunca vem do servidor) e sem maxlength (cortaria a chave colada sem avisar).
 * `opcoes`: numerico (inputmode=numeric), minusculas (autocapitalize=none: nome que o teclado do celular não deve capitalizar)
 * e tip (chave do `?` de ajuda; o segredo usa 'conexoes.segredo' por padrão).
 */
function campoConexao(p, c, opcoes = {}) {
  const id = `cx-${esc(p.id)}-${esc(c.nome)}`;
  const dica = c.ajuda ? `<small class="dica" id="${id}-dica">${esc(c.ajuda)}</small>` : '';
  const desc = c.ajuda ? ` aria-describedby="${id}-dica"` : '';
  const modo = (opcoes.numerico ? ' inputmode="numeric"' : '') + (opcoes.minusculas ? ' autocapitalize="none"' : '');
  if (c.tipo === 'segredo') {
    // new-password: o Chrome não preenche aqui a senha do painel que ele guardou
    return `<label class="campo"><span>${esc(c.rotulo)} ${q(opcoes.tip || 'conexoes.segredo')}</span>
      <input type="password" name="${esc(c.nome)}" id="${id}" autocomplete="new-password" spellcheck="false"${desc}>${dica}</label>`;
  }
  return `<label class="campo"><span>${esc(c.rotulo)}${opcoes.tip ? ' ' + q(opcoes.tip) : ''}</span>
    <input type="text" name="${esc(c.nome)}" id="${id}"${modo} autocomplete="off" spellcheck="false"${desc}>${dica}</label>`;
}

/** Selo do cartão e, na Amazon, a nota dos espelhamentos que dependem só do texto da origem; na Shopee, a linha da extensão e o aviso. */
const cxUltimo = new WeakMap(); // último `p` pintado em cada cartão (pintarEstadoML repinta com a extensão atual)
function pintarSeloConexao(art, p) {
  cxUltimo.set(art, p);
  const [cls, txt] = pillConexao(p.estado, p.id, p);
  const selo = $('.cab .estado-pill', art); selo.className = 'estado-pill ' + cls; selo.textContent = txt;
  if (p.id === 'shopee') pintarTopoShopee(art, p);
  const nota = $('[data-espelhos]', art); if (!nota) return;
  const n = Number(p.espelhos_ativos) || 0;
  const mostrar = p.estado === 'so_tag' && n > 0;
  nota.hidden = !mostrar;
  nota.innerHTML = mostrar ? `${esc(TEXTOS_CONEXOES.espelhosEmUso(n))} <a href="#disparo-automatico">${TEXTOS_CONEXOES.verEspelhamentos}</a>` : '';
}

/** Repinta a linha da extensão (só o texto: a região role=status continua a mesma) e o aviso "Antes de usar" (muda com o estado). */
function pintarTopoShopee(art, p) {
  const linha = $('[data-ext]', art); const txt = $('[data-ext-txt]', art); const antes = $('[data-antes]', art);
  const e = cxExtLinha(p);
  if (txt && txt.textContent !== e.texto) txt.textContent = e.texto;
  if (linha) linha.classList.toggle('off', e.off);
  if (antes) { const html = cxAvisoShopee(p); if (antes.dataset?.html !== html) { antes.innerHTML = html; if (antes.dataset) antes.dataset.html = html; } }
}

/** Põe no cartão o que o servidor respondeu: selo, valores de texto, placeholder do segredo e linha de estado. */
function aplicarConexao(art, p) {
  if (p?.id === 'catalogo' && p.implementada) return aplicarCatalogo(art, p);
  pintarSeloConexao(art, p);
  const form = $('form', art); if (!form) return;
  const salvos = Array.isArray(p.segredos_salvos) ? p.segredos_salvos : null;
  for (const c of p.campos) {
    const el = form.elements.namedItem(c.nome); if (!el) continue;
    if (c.tipo === 'segredo') {
      el.value = ''; el.disabled = !salvos;
      el.placeholder = !salvos ? TEXTOS_CONEXOES.segredoSoDono : salvos.includes(c.nome) ? TEXTOS_CONEXOES.segredoSalvo : '';
    } else el.value = p.config?.[c.nome] ?? '';
  }
  const testar = $('[data-testar]', form); // a Magalu não tem "Testar": no lugar, "Conferir minha loja"
  if (testar) testar.disabled = cxTestarBloqueado(p); // "Testar" só depois de salvar; a linha abaixo diz por quê
  if (p.id === 'magalu') pintarConferirMagalu(form, p);
  if (p.id === 'shopee') { // a linha de contexto do fieldset da API só vale enquanto não há credenciais salvas
    const ctx = $('[data-ctx-api]', form);
    if (ctx) ctx.hidden = !!(p.config?.app_id && salvos?.includes('chave'));
  }
  const linha = $('.estado-linha', form); linha.classList.remove('aviso');
  const { texto, aviso } = cxLinhaEstado(p);
  linha.textContent = texto;
  if (aviso) linha.classList.add('aviso');
}

/** "Conferir minha loja" (só com nome salvo válido) e a nota de que o painel não confirma que o nome existe (só em `pronta`). */
function pintarConferirMagalu(form, p) {
  const href = cxMagaluHref(p);
  const box = $('[data-conferir-box]', form); if (box) box.innerHTML = cxMagaluLinkHtml(href);
  const nota = $('[data-magalu-nota]', form);
  if (nota) { const ver = p.estado === 'pronta' && !!href; nota.hidden = !ver; nota.textContent = ver ? TEXTOS_CONEXOES.magalu.naoConfirma : ''; }
}

/** Erro de um campo, igual ao que o servidor confere (max e padrao do registro). Nunca repete o valor. */
function erroCampoConexao(c, v) {
  if (v.length > c.max) return `${c.rotulo}: até ${c.max} caracteres.`;
  let re = null; try { re = c.padrao ? new RegExp(c.padrao) : null; } catch { /* o servidor confere */ }
  if (!re || re.test(v)) return '';
  return c.tipo === 'segredo' ? `${c.rotulo}: ${TEXTOS_CONEXOES.formatoSegredo}` : `${c.rotulo}: formato inválido.${c.ajuda ? ' ' + c.ajuda : ''}`;
}

/** { campos, erros } do formulário. Segredo vazio não vai (mantém o salvo); texto vazio vai e apaga. */
function lerFormConexao(form, p) {
  const campos = {}; const erros = [];
  for (const c of p.campos) {
    const el = form.elements.namedItem(c.nome); if (!el || el.disabled) continue;
    const v = String(el.value || '').trim();
    if (c.tipo === 'segredo' && !v) continue;
    const msg = v ? (p.id === 'shopee' ? cxErroCampoShopee(c, v) : p.id === 'magalu' ? cxErroCampoMagalu(c, v) : erroCampoConexao(c, v)) : '';
    if (msg) erros.push({ msg, el }); else campos[c.nome] = v;
  }
  if (p.id === 'shopee' && !erros.length) {
    const msg = cxCruzaShopee(campos);
    if (msg) erros.push({ msg, el: form.elements.namedItem('app_id') });
  }
  return { campos, erros };
}

function ligarConexao(art, p) {
  if (p?.id === 'catalogo' && p.implementada) return ligarCatalogo(art, p);
  const form = $('form', art); if (!form) return;
  let atual = p;
  const linha = $('.estado-linha', form); const salvar = $('[type=submit]', form); const testar = $('[data-testar]', form);
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const { campos, erros } = lerFormConexao(form, atual);
    if (mostrarErros(form, erros)) return;
    salvar.disabled = true; salvar.textContent = 'Salvando…'; linha.classList.remove('aviso'); linha.textContent = 'Salvando…';
    try {
      atual = await api('/conexoes/' + encodeURIComponent(atual.id), 'PUT', { campos });
      aplicarConexao(art, atual); // limpa o campo de segredo e troca o placeholder para "salva"
      aviso(`${atual.nome}: dados salvos`);
    } catch (e) {
      linha.textContent = '';
      mostrarErros(form, [{ msg: e.message, el: cxElDoErro(form, e.message) }]);
    } finally { salvar.disabled = false; salvar.textContent = 'Salvar'; }
  };
  if (testar) testar.onclick = async () => {
    testar.disabled = true; testar.textContent = 'Testando…';
    try {
      const r = await api('/conexoes/' + encodeURIComponent(atual.id) + '/testar', 'POST', {});
      const { frase, ok, aviso: emAviso } = cxFraseTeste(atual, r);
      linha.classList.toggle('aviso', emAviso);
      if (ok) linha.innerHTML = `<span class="nivel-ok">✓ ${esc(frase)}</span>`; else linha.textContent = frase;
      if (r.resultado) { // o teste muda o estado (Conectada ou não): relê o cartão sem apagar a frase do teste
        const lista = await api('/conexoes').catch(() => null);
        const nova = Array.isArray(lista) ? lista.find((x) => x?.id === atual.id) : null;
        if (nova) { atual = nova; pintarSeloConexao(art, atual); }
      }
    } catch (e) {
      linha.textContent = e.message; linha.classList.add('aviso');
    } finally { testar.disabled = cxTestarBloqueado(atual); testar.textContent = 'Testar'; }
  };
}

// ---------- Catálogo do Etiqueta (plano fonte-catalogo-etiqueta, etapa 6; spec, seção 1) ----------
// Endereço e caminho do arquivo do token são texto comum (o token nunca passa por esta tela). O servidor manda
// `estado` (6 selos), `situacao` (resultado da última chamada, já invalidada por um "Salvar" mais novo),
// `verificacao` (categorias do último "Testar"), `config` (só o que passa na regra do PUT) e `endereco_padrao`.
// Todo texto que veio do Etiqueta (nome de categoria) passa por esc(); o resto vai por textContent.
// O Operador (sem `segredos_salvos` na resposta, como nas outras lojas) vê selo e categorias, com os campos travados.
// As funções `cxCat*` são puras (testadas em test/catalogo-conexoes-painel.test.js).

/** Mesmas regras de src/lojas.js (RE_ENDERECO_CATALOGO, RE_CAMINHO_TOKEN); o teste confere que não divergiram. */
const CX_CAT_RE_ENDERECO = /^http:\/\/(localhost|127\.0\.0\.1):([1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$/;
const CX_CAT_RE_CAMINHO = /^(~\/|\/)[^\u0000-\u001f\u007f]{1,500}$/;
/** "Caminho" que é o próprio token (32+ de A-Za-z0-9_-, com / ou ~/ na frente ou não), como o PUT de src/conexoes.js. */
const CX_CAT_PARECE_TOKEN = /^(~\/|\/)?[A-Za-z0-9_-]{32,}$/;
const CX_CAT_LOJAS = ['ml', 'amazon', 'shopee']; // ordem das colunas: Mercado Livre, Amazon, Shopee

/** Inteiro ≥ 0 vindo do servidor, ou 0. */
function cxCatInt(v) { return Number.isSafeInteger(v) && v >= 0 ? v : 0; }
/** Número com separador de milhar (3.853). */
function cxCatNum(v) { return cxCatInt(v).toLocaleString('pt-BR'); }
function cxCatPlural(v, um, varios) { const n = cxCatInt(v); return `${cxCatNum(n)} ${n === 1 ? um : varios}`; }

/** Operador: o servidor não manda `segredos_salvos` para quem não é Dono (PUT e Testar são só do Dono). */
function cxCatSoLeitura(p) { return !Array.isArray(p?.segredos_salvos); }

/** "Testar" só com endereço e caminho salvos, e só para o Dono. Usa o que está salvo, não o que está digitado. */
function cxCatTestarBloqueado(p) { return cxCatSoLeitura(p) || !(p?.config?.endereco && p?.config?.caminho_token); }

/** Os campos na tela diferem do que está salvo (com os dois salvos: senão a linha já pede para salvar). */
function cxCatMudou(p, valores) {
  const salvo = p?.config || {};
  if (!valores || !salvo.endereco || !salvo.caminho_token) return false;
  return String(valores.endereco ?? '').trim() !== salvo.endereco || String(valores.caminho_token ?? '').trim() !== salvo.caminho_token;
}

/**
 * Erros do formulário antes de enviar: [{ campo, msg, limpar }]. `limpar` = o caminho parece o token: o campo é
 * esvaziado e a frase não ecoa o valor (nenhuma frase ecoa). A checagem do token vem antes de tamanho e formato.
 */
function cxCatErros(valores) {
  const T = TEXTOS_CONEXOES.catalogo; const erros = [];
  const endereco = String(valores?.endereco ?? '').trim(); const caminho = String(valores?.caminho_token ?? '').trim();
  if (!endereco) erros.push({ campo: 'endereco', msg: T.enderecoVazio });
  else if (!CX_CAT_RE_ENDERECO.test(endereco)) erros.push({ campo: 'endereco', msg: T.enderecoFormato });
  if (!caminho) erros.push({ campo: 'caminho_token', msg: T.caminhoVazio });
  else if (CX_CAT_PARECE_TOKEN.test(caminho)) erros.push({ campo: 'caminho_token', msg: T.pareceToken, limpar: true });
  else if (caminho.length > 500 || /[\u0000-\u001f\u007f]/.test(caminho)) erros.push({ campo: 'caminho_token', msg: T.caminhoInvalido });
  else if (!CX_CAT_RE_CAMINHO.test(caminho)) erros.push({ campo: 'caminho_token', msg: T.caminhoFormato });
  return erros;
}

/** Campo de um 400 do servidor (a frase é fixa e pode juntar os dois campos; o primeiro citado leva o foco). */
function cxCatCampoDoErro(msg) {
  const m = String(msg || '');
  if (/^Endereço/.test(m)) return 'endereco';
  if (/Isto parece o token|Caminho|Arquivo do token/.test(m)) return 'caminho_token';
  return '';
}
/** O 400 do servidor diz que o caminho é o token: o campo é limpo também. */
function cxCatErroDeToken(msg) { return String(msg || '').includes('Isto parece o token'); }

/**
 * Frase de um `resultado` (Testar ou última verificação): a da tela; desconhecido → a frase fixa do servidor, ou
 * "respondeu algo que não esperávamos". `n` = { total, categorias }, `cfg` = config salva (endereço e caminho).
 */
function cxCatFrase(resultado, cfg = {}, n = {}, mensagem = '') {
  const T = TEXTOS_CONEXOES.catalogo.teste;
  if (typeof resultado === 'string' && Object.hasOwn(T, resultado)) return T[resultado](n, cfg || {});
  return typeof mensagem === 'string' && mensagem ? mensagem : T.resposta_inesperada();
}

/** Resultado do "Testar": { frase, ok, aviso }. Sucesso só com `ok` e `resultado: 'ok'` juntos. */
function cxCatFraseTeste(p, r) {
  r = r || {};
  const ok = r.ok === true && r.resultado === 'ok';
  const n = { total: r.total, categorias: Array.isArray(r.categorias) ? r.categorias.length : 0 };
  const resultado = r.resultado === 'ok' && !ok ? 'resposta_inesperada' : r.resultado;
  return { frase: cxCatFrase(resultado, p?.config, n, r.mensagem), ok, aviso: !ok };
}

/**
 * Linha de estado do cartão: { frase, verificado, ok, aviso }. Com campos mudados e não salvos, avisa para salvar;
 * sem os dois salvos, diz por que o "Testar" está travado; com uma verificação, a frase do resultado e a hora.
 */
function cxCatLinha(p, valores) {
  const T = TEXTOS_CONEXOES.catalogo; const vazia = { frase: '', verificado: '', ok: false, aviso: false };
  if (cxCatMudou(p, valores) && !cxCatSoLeitura(p)) return { ...vazia, frase: T.mudou, aviso: true };
  const salvo = !!(p?.config?.endereco && p?.config?.caminho_token);
  if (!salvo) return { ...vazia, frase: cxCatSoLeitura(p) ? TEXTOS_CONEXOES.shopee.nadaSalvo : T.semSalvar };
  const s = p.situacao || {};
  if (typeof s.resultado === 'string' && s.resultado) {
    const cats = Array.isArray(p.verificacao?.categorias) ? p.verificacao.categorias : [];
    const frase = cxCatFrase(s.resultado, p.config, { total: p.verificacao?.total, categorias: cats.length }, s.mensagem);
    const ok = s.resultado === 'ok';
    return { frase, verificado: Number.isFinite(s.verificado_em) && s.verificado_em > 0 ? T.verificadoEm(s.verificado_em) : '', ok, aviso: !ok };
  }
  return { ...vazia, frase: p.updated_at ? TEXTOS_CONEXOES.salvoEm(p.updated_at) : '' };
}

/** HTML da linha: sucesso com "✓" em .nivel-ok, falha com "!" (a classe .aviso fica com quem pinta). Tudo escapado. */
function cxCatLinhaHtml(l) {
  const extra = l.verificado ? ` ${esc(l.verificado)}` : '';
  if (l.ok) return `<span class="nivel-ok">✓ ${esc(l.frase)}</span>${extra}`;
  return `${l.aviso ? '! ' : ''}${esc(l.frase)}${extra}`;
}

/**
 * Categorias da última verificação (só em `conectada`): linha-resumo com a soma por loja e a tabela com rolagem
 * interna (região com foco). O nome da categoria é texto cru do Etiqueta: sempre esc(), na célula e no `title`.
 */
function cxCatCategorias(p) {
  if (p?.estado !== 'conectada') return '';
  const T = TEXTOS_CONEXOES.catalogo; const v = p.verificacao || {};
  const cats = (Array.isArray(v.categorias) ? v.categorias : []).filter((c) => c && typeof c.nome === 'string' && c.nome);
  if (!cats.length) return `<p class="dica">${esc(T.semOfertas)}</p>`;
  const soma = { ml: 0, amazon: 0, shopee: 0 };
  for (const c of cats) for (const l of CX_CAT_LOJAS) soma[l] += cxCatInt(c.lojas?.[l]);
  const total = Number.isSafeInteger(v.total) && v.total >= 0 ? v.total : cats.reduce((s, c) => s + cxCatInt(c.total), 0);
  const [cCat, ...cNums] = T.colunas;
  const linhas = cats.map((c) => `<tr><th scope="row"><span class="cat-nome" title="${esc(c.nome)}">${esc(c.nome)}</span></th>`
    + `<td class="num">${cxCatNum(c.total)}</td>${CX_CAT_LOJAS.map((l) => `<td class="num">${cxCatNum(c.lojas?.[l])}</td>`).join('')}</tr>`).join('');
  return `<p class="cat-resumo">${esc(T.resumo(total, cats.length, soma))}</p>
    <details open><summary>${esc(T.tituloCats(cats.length))}</summary>
      <div class="tabela cat-tabela" tabindex="0" role="region" aria-label="${esc(T.regiao)}">
        <table><caption class="sr-only">${esc(T.caption)}</caption>
          <thead><tr><th scope="col">${esc(cCat)}</th>${cNums.map((n) => `<th scope="col" class="num">${esc(n)}</th>`).join('')}</tr></thead>
          <tbody>${linhas}</tbody></table>
      </div>
    </details>
    <p class="dica">${esc(T.nota)}</p>`;
}

/** Cartão do Catálogo (string pura). Sem `value=` no HTML: os valores salvos entram por aplicarCatalogo. */
function cartaoCatalogo(p) {
  const T = TEXTOS_CONEXOES.catalogo; const so = cxCatSoLeitura(p);
  const soId = so ? ' cx-catalogo-sodono' : '';
  return `<article class="card conexao conexao-catalogo" id="cx-catalogo" aria-labelledby="cx-catalogo-h">
    <header class="cab"><div><h2 id="cx-catalogo-h">${esc(p.nome || 'Catálogo do Etiqueta')} ${q('conexoes.catalogo')}</h2><p class="sub">${T.sub}</p></div><span class="estado-pill"></span></header>
    <p class="desc">${T.desc}</p>
    <form novalidate>
      <fieldset><legend>${T.legend}</legend>
        ${so ? `<p class="dica" id="cx-catalogo-sodono">${T.soDono}</p>` : ''}
        <label class="campo"><span>${T.rotuloEndereco} ${q('conexoes.catalogo.endereco')}</span>
          <input type="text" name="endereco" id="cx-catalogo-endereco" inputmode="url" autocomplete="off" spellcheck="false" aria-describedby="cx-catalogo-endereco-dica${soId}">
          <small class="dica" id="cx-catalogo-endereco-dica">${T.dicaEndereco}</small></label>
        <label class="campo"><span>${T.rotuloCaminho} ${q('conexoes.catalogo.token')}</span>
          <input type="text" class="mono" name="caminho_token" id="cx-catalogo-caminho_token" autocomplete="off" spellcheck="false" placeholder="${esc(T.placeholderCaminho)}" aria-describedby="cx-catalogo-caminho_token-dica${soId}">
          <small class="dica" id="cx-catalogo-caminho_token-dica">${T.dicaCaminho}</small></label>
      </fieldset>
      <div class="acoes"><button type="submit" class="pri">Salvar</button><button type="button" data-testar aria-describedby="cx-catalogo-estado${soId}">Testar</button></div>
      <p class="estado-linha" id="cx-catalogo-estado" role="status"></p>
    </form>
    <div data-cats></div>
  </article>`;
}

/** Valores digitados no formulário (aparados). */
function cxCatValores(form) {
  const v = (n) => String(form.elements.namedItem(n)?.value ?? '').trim();
  return { endereco: v('endereco'), caminho_token: v('caminho_token') };
}

/** Escreve a linha de estado só quando muda (é role=status: não anuncia de novo a cada tecla). */
function pintarLinhaCatalogo(linha, l) {
  if (!linha) return;
  const html = cxCatLinhaHtml(l);
  if (linha.dataset.linha === html) return;
  linha.innerHTML = html; linha.dataset.linha = html;
  linha.classList.toggle('aviso', !!l.aviso);
}

/** Repinta as categorias só quando mudam (o <details> não fecha nem rola sozinho). */
function pintarCategoriasCatalogo(art, p) {
  const el = $('[data-cats]', art); if (!el) return;
  const html = cxCatCategorias(p);
  if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
}

/** Põe no cartão o que o servidor respondeu: selo, valores salvos (endereço padrão se não há), travas, linha e categorias. */
function aplicarCatalogo(art, p) {
  pintarSeloConexao(art, p);
  pintarCategoriasCatalogo(art, p);
  const form = $('form', art); if (!form) return;
  const so = cxCatSoLeitura(p);
  const end = form.elements.namedItem('endereco'); const cam = form.elements.namedItem('caminho_token');
  if (end) { end.value = p.config?.endereco || p.endereco_padrao || TEXTOS_CONEXOES.catalogo.enderecoPadrao; end.disabled = so; }
  if (cam) { cam.value = p.config?.caminho_token || ''; cam.disabled = so; }
  const salvar = $('[type=submit]', form); if (salvar) salvar.disabled = so;
  const testar = $('[data-testar]', form); if (testar) testar.disabled = cxCatTestarBloqueado(p);
  pintarLinhaCatalogo($('.estado-linha', form), cxCatLinha(p, cxCatValores(form)));
}

function ligarCatalogo(art, p) {
  const form = $('form', art); if (!form) return;
  const T = TEXTOS_CONEXOES.catalogo; let atual = p;
  const linha = $('.estado-linha', form); const salvar = $('[type=submit]', form); const testar = $('[data-testar]', form);
  const campo = (n) => form.elements.namedItem(n);
  const limparCaminho = () => { const c = campo('caminho_token'); if (c) c.value = ''; };
  // Campos diferentes do salvo: a linha avisa que o "Testar" usa o que está salvo (handler no próprio form).
  form.oninput = () => pintarLinhaCatalogo(linha, cxCatLinha(atual, cxCatValores(form)));
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    if (cxCatSoLeitura(atual)) return; // Operador: campos travados; o servidor também recusa com 403
    const valores = cxCatValores(form);
    const erros = cxCatErros(valores);
    if (erros.some((e) => e.limpar)) limparCaminho(); // o token não fica num campo de texto visível
    if (mostrarErros(form, erros.map((e) => ({ msg: e.msg, el: campo(e.campo) })))) return;
    salvar.disabled = true; salvar.textContent = 'Salvando…';
    pintarLinhaCatalogo(linha, { frase: 'Salvando…', verificado: '', ok: false, aviso: false });
    try {
      atual = await api('/conexoes/catalogo', 'PUT', { campos: valores });
      aplicarCatalogo(art, atual);
      aviso(T.salvos);
    } catch (e) {
      if (cxCatErroDeToken(e.message)) limparCaminho();
      pintarLinhaCatalogo(linha, { frase: '', verificado: '', ok: false, aviso: false });
      const nome = cxCatCampoDoErro(e.message);
      mostrarErros(form, [{ msg: e.message, el: nome ? campo(nome) : undefined }]);
    } finally { salvar.disabled = cxCatSoLeitura(atual); salvar.textContent = 'Salvar'; }
  };
  testar.onclick = async () => {
    if (cxCatTestarBloqueado(atual)) return;
    testar.disabled = true; testar.textContent = 'Testando…';
    pintarLinhaCatalogo(linha, { frase: 'Testando…', verificado: '', ok: false, aviso: false });
    try {
      const r = await api('/conexoes/catalogo/testar', 'POST', {});
      // o teste muda o selo e as categorias: relê o cartão sem apagar a frase do teste
      const lista = await api('/conexoes').catch(() => null);
      const nova = Array.isArray(lista) ? lista.find((x) => x?.id === 'catalogo') : null;
      if (nova) { atual = nova; pintarSeloConexao(art, atual); pintarCategoriasCatalogo(art, atual); }
      const { frase, ok, aviso: emAviso } = cxCatFraseTeste(atual, r);
      pintarLinhaCatalogo(linha, { frase, verificado: '', ok, aviso: emAviso });
    } catch (e) {
      pintarLinhaCatalogo(linha, { frase: e.message, verificado: '', ok: false, aviso: true });
    } finally { testar.disabled = cxCatTestarBloqueado(atual); testar.textContent = 'Testar'; }
  };
}
