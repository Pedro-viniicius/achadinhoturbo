# Especificação de UI/UX: espelhamento de ofertas da Amazon

Brief: `docs/produto/briefs/espelhamento-amazon.md` (CA1 a CA7). Formato e padrões herdados de `docs/produto/specs/disparos-comunicacao-conta.md`. Só a camada de apresentação: onde o contrato com o servidor ainda não existe, o texto diz "a alinhar com o plano" (nomes de campo, rotas, regras de negócio ficam com o arquiteto). Tokens: nenhum novo.

## Objetivo e usuário

Pedro (dono) no computador, com pressa, sem jargão técnico. Hoje a oferta espelhada chega ao grupo dele só com "Compre aqui: link". Ele precisa:
1. configurar uma vez de onde espelhar, para onde mandar e o que bloquear;
2. confiar que o link leva a tag dele e que nada sai repetido;
3. ver, sem abrir arquivo de log, o que saiu, o que foi barrado e por quê;
4. completar à mão o que a Amazon não devolveu.

Princípios: uma ação principal por tela; falha nunca silenciosa (todo descarte tem motivo em texto); nada é prometido além do que a API entrega (sem acesso, a tela diz que o sistema usa o texto da origem).

## Fluxo

1. **Conexões > Amazon:** o dono guarda a tag e (se tiver acesso) as credenciais da API. Sem credenciais o espelhamento já funciona em modo "texto da origem".
2. **Disparo automático > Novo espelhamento:** escolhe grupos de origem e destino, template, palavras bloqueadas, janela de repetição e ritmo; salva ligado ou desligado.
3. **Acompanhar:** cartão da regra mostra contadores das últimas 24 h; o Histórico (filtro Espelhamento) lista cada oferta com resultado e motivo.
4. **Fila:** oferta sem dados suficientes aguarda no Histórico; o dono clica "Completar", ajusta e envia ou descarta.
5. **Manual:** Disparo manual > colar link da Amazon > editar > enviar agora ou agendar.

## Layout (mobile e desktop)

Mesmo padrão do painel: `.topo` + `.card`, `main` de 1040 px nas páginas de lista. O formulário do espelhamento é `<dialog id="dlg">` como o do Disparo automático (rolável, largura total em ≤ 600 px). Uso principal em tela larga; tudo utilizável de 320 px sem rolagem horizontal da página (tabelas rolam dentro do card).

### 1. Regras de espelhamento (`#disparo-automatico`, em `public/app.js`)

Decisão: espelhamento é **outro tipo de regra, na mesma página**, não item novo do menu (o brief pede "dentro do fluxo de regras"). Motivo: o dono já procura ali "o que roda sozinho", e o cartão, o liga/desliga e o ritmo são os mesmos.

**`.topo`:** o botão `pri` continua "Novo disparo automático"; ao lado entra "Novo espelhamento" (neutro). O `.sub` ganha uma frase: "Também pode espelhar ofertas da Amazon de outros grupos."

**Lista:** os dois tipos na mesma lista, ordenada como hoje. O cartão de espelhamento (`.card.regra`) reusa o de `cartaoRegra` com:
- cabeçalho: chave Ativo (`aria-label="Espelhamento ativo"`), nome, chip "Espelhamento" (`.chip`, texto sempre visível), chip da fila "2 na fila" (`.chip`, só quando > 0, vira link para o Histórico filtrado);
- resumo (`.res`): "De 2 grupos para 1 grupo. Template: Padrão. Repetida: não reenvia em 24 h. Pausa de 30 s entre mensagens." Nomes de grupo só se for 1 (com reticências e `title`); senão a contagem;
- linha de números (`.prox`): "Últimas 24 h: 12 espelhadas, 3 descartadas, 1 na fila." (texto; os números vêm do servidor, a alinhar com o plano);
- ações: `pri` "Ver registro" (leva a `#historico` com o filtro desta regra), "Editar", `perigo leve` "Excluir". Sem "Enviar agora" nem "Ver ofertas" (não há busca ativa: espelhamento reage ao que chega).

**Formulário "Novo espelhamento" / "Editar espelhamento"** (`<form method="dialog" novalidate>`, uma coluna; `.grade` só onde há campos curtos lado a lado). Ordem, seguindo a pergunta mental do dono (de onde → para onde → como fica → o que barrar → quando):

1. **Nome** (`.campo`, obrigatório). Dica: "Ex.: Eletrônicos do grupo X".
2. **Aviso de conexão** (`.aviso-impl`, só se a Amazon não estiver pronta; ver Estados): ao vivo, sem bloquear.
3. **Grupos de origem** (`fieldset`, obrigatório): `seletorGrupos` com contador "(N selecionados)". Legenda auxiliar: "Só aparecem grupos em que o número conectado está."
4. **Opção "Espelhar também mensagens enviadas pelo meu número"** (checkbox, logo abaixo da origem, porque só faz sentido para ela). Dica: "Use se um dos grupos de origem é seu. Desligado, só o que os outros participantes postam é espelhado."
5. **Grupos de destino** (`fieldset`, obrigatório): segundo `seletorGrupos`, mesma aparência, contador próprio.
6. **Template** (`select` + prévia): `select` dos templates existentes, link "Gerenciar templates" (`#templates`) e prévia em `.chat > .balao` (via `zap()` + `/templates/preview`, a alinhar com o plano o corpo da requisição) com uma oferta de exemplo da Amazon. `.seg` acima da prévia: "Completa" | "Sem preço antigo e sem cupom", para o dono ver na hora que linha ou pedaço sem valor some. Legenda: "Exemplo. Linha sem valor some sozinha; se faltar só o desconto, só ele some." Abaixo, `<details><summary>Campos que você pode usar no template</summary>` com a lista de `PLACEHOLDERS` em `<code>` (TITULO_PRODUTO, TITULO_COMPLETO, PRECO_ANTIGO, PRECO_PRODUTO, DESCONTO_PRODUTO, NUMERO_VENDAS, FRETE, CUPOM, LINK), cada um com uma dica curta; vindos de uma constante, não digitados à mão em três lugares. O template também precisa de `{LINK}` (aviso se faltar: ver Estados).
7. **Palavras bloqueadas** (`textarea` 4 linhas, `.mono`): "Uma por linha ou separadas por vírgula." Contador "3 palavras" (`aria-live="polite"`). Dica: "Não diferencia maiúscula, minúscula nem acento: “usado” também barra “Usádo”. Se o título ou a mensagem tiver uma delas, a oferta não é enviada e aparece como descartada no Histórico." (onde o sistema procura, título e/ou texto, a alinhar com o plano; o texto da dica se ajusta). Placeholder: "usado&#10;recondicionado&#10;vitrine".
8. **Ritmo de envio** (`fieldset`, `.grade`):
   - "Não repetir a mesma oferta por (horas)" (`number`, `min 0`, padrão 24, dica "0 = pode repetir. A mesma oferta é a mesma Amazon, mesmo com link diferente."; a chave de deduplicação é decisão do plano);
   - "Pausa entre mensagens (segundos)" (`number`, dica "Entre uma oferta e a seguinte, para não parecer robô."; unidade e mínimo a alinhar com o plano e com as "Pausas entre mensagens" de Ajustes, para não haver duas fontes de ritmo conflitantes);
   - "Funciona das / Até" (`time`, opcional, dica "Fora desse horário as ofertas esperam na fila e saem quando abrir." ou "descartam"? ver pergunta 3);
   - "Foto do produto" (`select`: "Enviar com foto, quando houver" | "Só texto"), igual ao Disparo automático.
9. **Rodapé:** "Cancelar" e `pri` "Criar espelhamento" / "Salvar". Ativo/desativado fica no cartão (chave), e no formulário de criação vale "ligado"; mesmo comportamento do Disparo automático.

### 2. Conexões > Amazon (`public/conexoes.js`)

Cartão `.card.conexao` já existente, na grade das outras lojas. Mudanças:
- **Selo:** sai "Ainda não implementado" (o servidor passa `implementada: true`). Estados do selo (texto sempre visível):
  - "Falta configurar" (nenhuma tag salva);
  - "Só com a tag" (`--warn`; tag salva, sem API: o link leva a tag, os dados vêm do texto da origem);
  - "Conectada" (tag e credencial salvas e o último teste deu certo);
  - "Credencial salva" (salva, ainda não testada, neutro).
  Quais estados o servidor manda é a alinhar com o plano; se vier só `estado`, o painel mapeia como em `pillConexao`.
- **Descrição:** "Programa de Associados da Amazon. Com a API oficial, o painel busca título, preço e foto do produto e gera o link com a sua tag."
- **Aviso de pré-requisito** (`.aviso-impl` visual, mas é informativo, então começa com "Antes de usar a API:"): "A API oficial da Amazon (Creators API) exige uma conta de Associados aprovada na Amazon Brasil e vendas qualificadas recentes (hoje, ao menos 10 nos últimos 30 dias). Sem esse acesso o espelhamento continua funcionando, só que usa o título e os preços escritos na mensagem de origem." + link "Como conseguir as credenciais" (`https://affiliate-program.amazon.com/creatorsapi/docs`, `target="_blank" rel="noopener"`, rótulo com "(abre em outra aba)"). O "10 vendas" só entra se o arquiteto confirmar (pergunta 1).
- **Campos** (todos `.campo`, rótulo visível):
  1. "Tag de associado" (texto; dica "Ex.: seunome-20. Todo link enviado leva esta tag."), obrigatória para o espelhamento.
  2. "ID da credencial" (texto, `autocomplete=off`, `spellcheck=false`), dica "Da Central de Associados, em Creators API."
  3. "Segredo da credencial" (`type=password`, `autocomplete=new-password`): igual ao Shopee: nunca preenchido; com valor salvo, placeholder "•••••••• salva; digite para trocar" e dica "O segredo fica guardado no seu computador e não volta para esta tela." (`TEXTOS_CONEXOES.segredoSalvo`, `q('conexoes.segredo')`).
  4. `<details>` "Segunda credencial (opcional)": mesmos dois campos (ID + segredo). Dica: "A Amazon permite até duas credenciais por aplicativo. Use a segunda como reserva se trocar a primeira." (uso real da segunda pelo sistema: a alinhar com o plano; se o sistema não usar, cortar este bloco).
  Nomes de campo e padrões de validação (`padrao`, `max`) vêm do registro do servidor (`GET /conexoes → campos`), como as outras lojas: a alinhar com o plano.
- **Ações:** "Salvar" e "Testar" (o botão volta a fazer teste de verdade; habilitado só depois de salvar, com a linha de estado explicando, como hoje). Resultado do teste inline (`role="status"`):
  - sucesso: "Credencial aceita pela Amazon." (`--ok`, com texto, não só cor);
  - recusada: "A Amazon não aceitou a credencial. Confira o ID e o segredo e se a credencial está ativa.";
  - sem acesso: "A credencial é válida, mas a conta ainda não tem acesso à API. Confira se há vendas qualificadas nos últimos 30 dias.";
  - cota/instabilidade: "A Amazon não respondeu agora. Tente de novo em alguns minutos.";
  - sem tag: o teste pede só credencial; a tag falta só vira erro no espelhamento.
  Nenhuma mensagem repete o ID nem o segredo.
- Aviso quando a Amazon **sem credencial** e já existe espelhamento ativo: o cartão mostra "Há 1 espelhamento usando o texto da origem." com link para `#disparo-automatico` (dado do servidor, a alinhar).

### 3. Modo manual (`#disparo-manual`, `public/disparos.js`)

Reaproveita a página inteira. Só muda o que acontece depois de **Identificar** com um link da Amazon (qualquer formato do brief). Hoje o resultado Amazon é "identificada, mas não conectada"; passa a ser o fluxo abaixo quando a tag existe (sem tag, ver Estados).

1. **Link do produto + "Identificar"** (como hoje). O botão vira "Identificando…" e o `card-prod` mostra "Resolvendo o link…" (link curto precisa de redirecionamento antes da busca).
2. **Resultado** (`.card-prod`, `aria-live="polite"`): imagem 72×72 (`alt` = título), título, preço, chip "Amazon". Abaixo dele, **seção "Dados da oferta"** (aparece só para Amazon; `fieldset`, `.grade`), pré-preenchida e editável:
   - Título (`input`, obrigatório, até 200);
   - Preço atual, Preço antigo (`input type=text inputmode=decimal`, aceitam "89,90"), dica no preço antigo "Se for menor ou igual ao atual, a linha de preço antigo some.";
   - Desconto (somente leitura, calculado como em `discountPct`; dica "Calculado dos dois preços.");
   - Cupom (opcional); "Frete grátis" (checkbox);
   - Imagem: miniatura + botões "Trocar foto" (JPG/PNG até 5 MB, igual ao Disparar mensagem) e "Remover foto". Sem imagem: a mensagem sai só com texto.
3. **Prévia** (`.balao`) atualiza ao digitar (debounce curto), com o template escolhido; aqui a regra "linha sem valor some" fica visível de verdade.
4. **Etiqueta:** o `select` de etiquetas some para Amazon e entra texto fixo: "O link sai com a tag seunome-20 (de Conexões > Amazon)." (a tag da Amazon é uma só).
5. **Grupos, agendar, "Disparar" / "Agendar envio":** sem mudança. Resumo ao lado do botão idem.

Estados do Identificar para Amazon:
- **Resolvendo:** como acima; botão e campos de dados travados.
- **Dados completos:** card-prod + dados preenchidos; "Amazon · pronto para disparar".
- **Dados parciais** (ex.: sem preço antigo): igual, com nota "A Amazon não trouxe o preço antigo. A linha vai sumir da mensagem. Preencha se quiser." Disparar fica habilitado.
- **API indisponível ou sem acesso:** o link foi resolvido e já leva a tag, mas nada de dados. Mostra o aviso (`--warn`, com "!" textual) e a seção "Dados da oferta" **vazia** para preencher: "Não consegui buscar os dados na Amazon agora. Preencha o título e os preços abaixo; o link já está com a sua tag." Variantes de causa (sem expor detalhe técnico): "A API da Amazon não está configurada. Configure em Conexões ou preencha à mão." / "A Amazon limitou as consultas por agora. Preencha à mão ou tente de novo em alguns minutos."
- **Link inválido:** "Não reconheci este link da Amazon. Cole o endereço do produto (…/dp/…) ou um link curto, como link.amazon ou amzn.to." Sem seção de dados; Disparar desabilitado com a frase ao lado.
- **Link que resolve, mas não é produto** (busca, lista, loja): "Este link não leva a um produto específico. Cole o link da página do produto."
- **Tag não cadastrada:** "Amazon identificada, mas falta a tag de associado. Cadastre em Conexões." (link). Disparar desabilitado (CA2: o link sempre leva a tag).
- Editar o link depois de identificar limpa resultado e dados (a edição manual do título não deve ser perdida por acidente: confirmar "Descartar os dados editados?" só se o dono já alterou algum campo).

### 4. Registro: Histórico (`#historico`, `paginaHistorico` em `public/app.js`)

O Histórico atual (Quando, Origem, Grupo, Oferta, Resultado + filtro Tudo/Enviados/Erros/Avisos) já é o lugar. Acrescenta-se:

- **Seletor "Tipo"** (`.seg`, `role="radiogroup"`): "Tudo" | "Disparo automático" | "Espelhamento". Mantém o `select` de nível para os dois primeiros. Chega pré-selecionado (e filtrado por regra) quando o dono vem de "Ver registro" ou do chip da fila.
- **Visão Espelhamento:** três `.kpi` no alto (Espelhadas, Descartadas, Na fila; últimas 24 h; "Na fila" com texto e, se > 0, em `--warn`) e uma tabela `.card.tabela` com colunas: Quando, Regra, Grupo de origem, Grupo de destino, Oferta, Resultado.
  - **Oferta:** título se houver; senão "Produto B06BR9eEZ" (ASIN) ou "Link da Amazon"; texto do link só como `<a>` curto; título em 2 linhas com `title`.
  - **Resultado** (texto + classe, nunca só cor):
    - `nivel-ok` "Espelhada" + detalhe em `.dica`: "com dados da Amazon" / "com o texto da origem" / "no formato curto";
    - `nivel-aviso` "Descartada: palavra bloqueada (usado)"; "Descartada: repetida (enviada há 3 h)"; "Descartada: link não resolvido"; "Descartada: sem dados para montar a oferta";
    - `nivel-aviso` "Na fila: falta completar" + botão **"Completar"**;
    - `nivel-erro` "Erro ao enviar para este grupo" + motivo curto.
  - **Nunca** número, nome de participante nem o texto da mensagem de origem: só o nome do grupo de origem. A coluna "Grupo de origem" mostra o nome (emoji ou JID bruto como estão).
- **Completar** (dialog, mesma seção "Dados da oferta" do modo manual, preenchida com o que houver): título, preços, cupom, frete, prévia com o template da regra, botões `pri` "Enviar para N grupos", "Descartar" (`perigo leve`, com `confirm()`: "Descartar esta oferta? Ela não será enviada.") e "Fechar". Depois de enviar, a linha vira "Espelhada · completada à mão". Se o item já saiu da fila (outra pessoa da equipe completou): "Esta oferta já foi tratada." e a lista atualiza.
- Atualização a cada 6 s como hoje, **sem** repintar com `<dialog>` aberto (já é a regra de `paginaHistorico`).
- Vazio (sem espelhamento rodando): "Nenhuma oferta espelhada ainda. Crie um espelhamento em Disparo automático." com link. Vazio por filtro: "Nada com este filtro nas últimas 24 h." Mostra os 50 mais recentes, "Mostrar mais" (paginação a alinhar com o plano).

## Componentes

| Componente | Existente ou novo | Onde fica |
|---|---|---|
| `.card.regra`, `.chip`, `.chave`, `.kpi`, `.tabela`, `.seg`, `.aviso-impl`, `.card-prod`, `.chat/.balao`, `.estado-pill`, `.grade`, `.erros`, `.invalido`, `nivel-*`, `<dialog>` | Existentes | `style.css` |
| `seletorGrupos` | Existente; **ajuste necessário**: hoje usa `#gr`, `#busca`, `#so-marcados`, `#todos`, `#nenhum` fixos e a doc diz "um por diálogo". O espelhamento tem dois no mesmo diálogo (origem e destino). Parametrizar com `opts.prefixo` (ids únicos, `label for` e `aria-label` distintos: "Buscar grupo de origem", "Buscar grupo de destino") sem mudar o comportamento atual | `app.js` |
| `cartaoRegra` variante espelhamento, `formEspelhamento(r)`, `resumoEspelhamento(r)` | Novos | `app.js` (ou `espelhamento.js` novo, carregado antes de `app.js` final, para não inflar o arquivo) |
| Seção "Dados da oferta" (título, preços, cupom, frete, foto) como função `dadosOferta(valores, aoMudar)` reutilizada no modo manual e em "Completar" | Nova | `disparos.js` (exporta global; o Histórico usa) |
| Campo de segredo (placeholder "salva; digite para trocar") | Existente | `conexoes.js` |
| Seletor "Tipo" do Histórico, KPIs do Espelhamento, tabela de espelhamento | Novos (compostos de existentes) | `app.js` (`paginaHistorico`) |
| Lista de placeholders com dicas | Nova constante, a partir de `PLACEHOLDERS` de `src/template.js` (a lista chega pelo servidor para não duplicar; a alinhar com o plano) | `app.js`/`ajuda.js` |
| Estilo: `details` do template e da segunda credencial; `textarea.mono` | Existente (`.mono`); `details` sem CSS novo além de foco visível se faltar | `style.css` |

## Estados

Padrão, hover, foco, ativo e desabilitado herdam dos componentes. Específicos:

**Formulário de espelhamento**
- **Carregando** (editar): "Carregando…" no corpo do dialog; "Salvando…" no botão, travado.
- **Número desconectado ou sem grupos:** nos dois seletores, `.dica` existente "Nenhum grupo carregado. Conecte o WhatsApp em Números de WhatsApp." e "Criar" fica desabilitado com a razão ao lado.
- **Amazon não pronta** (aviso `.aviso-impl` no topo do formulário; não bloqueia): 
  - sem tag: "Falta a tag de associado da Amazon. Sem ela o espelhamento não liga. Cadastre em Conexões." (**bloqueia ligar**: erro ao salvar ligado);
  - tag mas sem credencial: "A API da Amazon não está configurada. As ofertas vão sair com o título e os preços que estiverem escritos na mensagem de origem." (informativo, link para Conexões).
- **Erros de campo** (`mostrarErros`, foco no primeiro inválido): "Dê um nome ao espelhamento." / "Marque ao menos um grupo de origem." / "Marque ao menos um grupo de destino." / "Um grupo não pode ser origem e destino ao mesmo tempo: {nome}." (evita laço; listar até 3 nomes) / "Escolha um template." / "O template precisa do campo {LINK}." / "Horas sem repetir: use 0 ou mais." / "A pausa precisa ser de ao menos {mín} segundos." / "Uma palavra bloqueada tem mais de 60 caracteres." (limites a alinhar). Erro do servidor: `mostrarErros(dlg, [{msg: e.message}])`.
- **Palavras:** vazio é válido (nada bloqueado), contador "Nenhuma palavra bloqueada".
- **Conteúdo longo:** nomes de grupo com reticências e `title`; lista de palavras rola dentro do `textarea`.
- **Cartão:** `Ativo`, `Desligado` (texto "Pausado" no resumo), com fila ("N na fila" em `--warn` + texto), e `Erro de configuração` se a regra ligada perdeu um grupo (grupo saiu do WhatsApp): linha em `nivel-erro` "O número saiu do grupo {nome}. Edite o espelhamento." (dado do servidor, a alinhar).
- **Sucesso:** toast ("Espelhamento criado", "Espelhamento salvo", "Espelhamento ligado/pausado") e o cartão aparece/atualiza. Nunca só toast.
- **Excluir:** `confirm("Excluir o espelhamento “{nome}”? O que já foi enviado continua no Histórico.")`.

**Conexões > Amazon:** carregando, salvo ("Dados salvos em …"), "Salvando…", "Testando…" (botão travado, `role=status`), e os quatro resultados do teste acima. Segredo vazio ao salvar mantém o salvo. Operador sem permissão: campo de segredo travado com "Só o Dono vê e troca esta chave." (como hoje).

**Modo manual:** ver seção 3 (resolvendo, completo, parcial, API indisponível, link inválido, não é produto, sem tag, enviado, agendado, erro de envio como hoje).

**Histórico:** carregando ("Carregando…"), vazio, vazio por filtro, erro ao carregar ("Não consegui carregar o histórico. Tente de novo." com botão "Tentar de novo"), item da fila já tratado, "simulado" no modo simulação.

## Textos da interface

Em constantes no topo dos arquivos JS (como `TEXTOS_CONEXOES`, `TEXTOS_DISPAROS`), não soltos no componente; ajuda em `ajuda.js`. Todos em pt-BR, sem número de participante.

- **Botões:** Novo espelhamento, Criar espelhamento, Salvar, Cancelar, Ver registro, Completar, Enviar para N grupos, Descartar, Fechar, Identificar, Trocar foto, Remover foto, Salvar, Testar, Mostrar mais, Tentar de novo.
- **Títulos/subtítulos:** "Novo espelhamento" / "Editar espelhamento"; "Completar oferta"; "Dados da oferta"; "Grupos de origem"; "Grupos de destino"; "Ritmo de envio"; "Palavras bloqueadas".
- **Rótulos e dicas:** conforme as seções 1 a 3 acima (são o texto final).
- **Mensagens de resultado do Histórico:** "Espelhada", "Descartada: palavra bloqueada (usado)", "Descartada: repetida (enviada há 3 h)", "Descartada: link não resolvido", "Descartada: sem dados para montar a oferta", "Na fila: falta completar", "Erro ao enviar para este grupo", detalhes "com dados da Amazon" / "com o texto da origem" / "no formato curto" / "completada à mão".
- **Sucesso:** "Espelhamento criado", "Espelhamento salvo", "Espelhamento ligado", "Espelhamento pausado", "Espelhamento excluído", "Oferta enviada para 2 grupos", "Oferta descartada", "Dados da Amazon salvos".

**Verbetes novos para `TIPS`:**
- `espelhamento`: 'Pega ofertas da Amazon postadas em outros grupos, busca título, preço e foto, põe a sua tag e envia ao seu grupo com a mensagem completa.'
- `espelhamento.origem`: 'Grupos onde o número conectado está e que você quer vigiar. O painel só lê links da Amazon; o resto da conversa é ignorado.'
- `espelhamento.proprias`: 'Ligue se um grupo de origem é seu e você posta ofertas lá. Desligado, as mensagens enviadas pelo seu número não são espelhadas.'
- `espelhamento.bloqueadas`: 'Se o título ou o texto da oferta tiver uma destas palavras, ela não é enviada. Não diferencia maiúscula, minúscula nem acento.'
- `espelhamento.repetir`: 'Por quantas horas a mesma oferta não é reenviada. 0 = pode repetir.'
- `espelhamento.fila`: 'Ofertas sem dados suficientes esperam no Histórico até você completar o preço ou descartar.'
- `conexoes.amazon`: 'A API oficial da Amazon (Creators API) busca título, preço e foto. Exige conta de Associados aprovada e vendas qualificadas recentes. Sem ela, o painel usa o texto escrito na mensagem de origem.'
- `manual.amazon`: 'Cole um link da Amazon (link.amazon, amzn.to ou da página do produto). O painel busca os dados; você confere, ajusta e envia. Se a busca falhar, preencha à mão.'
- Atualizar `regras` ("Um disparo automático escolhe… Também há o tipo Espelhamento.") e o cartão "Conexões" da `AJUDA` (Amazon deixa de ser "ainda não implementado").
- **`AJUDA` (cartões):** "Espelhar ofertas da Amazon" (1. Cadastre a tag em Conexões; 2. Crie o espelhamento escolhendo origem, destino e template; 3. Acompanhe no Histórico e complete o que ficar na fila; dica: sem acesso à API, a mensagem sai com o texto da origem). Glossário: "Espelhamento", "Grupo de origem", "Grupo de destino", "Na fila", "Palavra bloqueada", "Tag de associado".

## Acessibilidade

- **Teclado:** ordem do DOM = ordem visual; dialog com foco inicial no "Nome" (nova) ou no título (editar), `Esc` fecha e devolve o foco ao botão que abriu; Enter no campo de link aciona "Identificar" e não "Disparar". Os dois seletores de grupo têm `aria-label` distintos e `fieldset/legend`.
- **Rótulos:** todo campo com `label` visível; botões repetidos ("Completar", "Editar", "Excluir") levam o objeto no `aria-label` ("Completar oferta Fone Bluetooth, do grupo X"). Imagem do produto: `alt` = título; miniatura da foto enviada: `alt="Prévia da foto"`.
- **Anúncios:** resultado do Identificar, contador de palavras, KPIs do Histórico, resultado do "Testar" e estado de envio em `aria-live="polite"`/`role="status"`; erros em `.erros` (`role="alert"`, foco no primeiro inválido).
- **Cor nunca sozinha:** toda situação (Espelhada, Descartada, Na fila, Erro, Conectada, Só com a tag, Pausado) tem palavra; aviso com "!" textual. Os motivos de descarte vêm no texto da célula, não só em ícone.
- **Contraste:** reusar a regra da spec anterior: texto de aviso em `--text` sobre `color-mix(--warn 18%, surface)` com borda `--warn` (o `--warn` puro sobre branco dá ~3,6:1 e não serve para texto); `--ok`, `--err` e `--muted` já foram conferidos nos dois temas. Links dentro dos avisos sublinhados.
- **Alvos:** botões e chaves com 44 px no celular; "Completar" dentro da tabela com altura mínima de 44 px em ≤ 600 px. `details` com `summary` focável e foco visível.
- **Link externo:** "(abre em outra aba)" no rótulo, `rel="noopener"`.
- **Movimento:** nada novo animado; transições existentes já respeitam `prefers-reduced-motion`.
- **Tabelas:** `<th scope="col">`, rolagem dentro do card em ≤ 600 px.
- **Privacidade na tela:** o Histórico nunca mostra autor da mensagem nem texto bruto da origem; confirmar com o dev que a API não manda esses campos ao navegador (CA7 e LGPD).

## O que o dev precisa implementar

1. `app.js`: `seletorGrupos` com `opts.prefixo`; `formEspelhamento`; variante do cartão; botão "Novo espelhamento" no `.topo` da página; filtro por tipo e visão Espelhamento em `paginaHistorico`, com o dialog "Completar"; `ir()` aceita parâmetro de filtro no hash (formato a definir, p. ex. `#historico?tipo=espelhamento&regra=3`).
2. `conexoes.js`: campos da Amazon vindos do registro; selo e mensagens de teste; remover o aviso "Ainda não implementado" para a Amazon (dirigido por `implementada`); nota do espelhamento em uso.
3. `disparos.js`: fluxo Amazon do Identificar (resolver, dados, parcial, indisponível, inválido, sem tag), função `dadosOferta` reutilizável, prévia ao vivo, uploads como já existe no Disparar mensagem.
4. `ajuda.js`: `TIPS`, `AJUDA` e glossário novos.
5. `style.css`: só se faltar algo; a tabela e o `details` devem sair dos componentes existentes. Mudou `style.css`? Conferir Disparo automático, Conexões, Disparo manual e Histórico em 375 e 1280 px.
6. Polling do Histórico a cada 6 s com a aba aberta, sem repintar com `<dialog>` aberto, cancelado ao trocar de rota.

## Arquivos de apresentação afetados

`public/app.js` (regras, seletor de grupos, Histórico), `public/conexoes.js`, `public/disparos.js`, `public/ajuda.js`, `public/style.css` (se necessário), `public/index.html` apenas se o dev criar `espelhamento.js` separado. Hoje há mudanças não commitadas da entrega 2 nesses mesmos arquivos: a implementação só começa depois que forem commitadas, para não haver conflito. `seletorGrupos` é compartilhado por Disparo automático, Blocos, Disparo manual e Disparar mensagem: conferir as quatro telas depois do ajuste.

## Pendências para o dev e o arquiteto (contrato, fora da apresentação)

Tudo "a alinhar com o plano": rotas e campos da regra de espelhamento (origem, destino, template, janela, palavras, "incluir minhas mensagens", ritmo, ativo); contadores de 24 h por regra; lista de registro com filtro por tipo e por regra, resultado, motivo e origem (só nome do grupo); item "na fila" com completar e descartar; endpoint de identificação da Amazon (resolver, ASIN, dados, causa da falha: inválido, não é produto, sem acesso, cota, indisponível); campos e teste da conexão Amazon (`implementada`, `estado`, `segredos_salvos`); lista de `PLACEHOLDERS` para a tela; chave de deduplicação; onde as palavras bloqueadas são buscadas; validação de limites. Segredos nunca na resposta nem em mensagem de erro (CA7).

## Perguntas em aberto

1. **Requisito da API:** confirmar com o arquiteto o "mínimo de 10 vendas qualificadas em 30 dias" e se há exigência de região/marketplace, antes de publicar o texto do aviso. Se mudar, só o texto muda.
2. **Segunda credencial:** o sistema vai usá-la (reserva)? Se não, cortamos o bloco.
3. **Fora da janela de horário:** a oferta espera na fila de envio ou é descartada? Recomendo esperar (nenhuma oferta se perde), mas é regra de negócio do plano.
4. **Fallback sem dados** (brief deixa ao arquiteto): enviar no formato curto ou deixar "na fila". A interface cobre os dois (resultado "no formato curto" e item "na fila"); a escolha define qual aparece com mais frequência. Pode ser uma opção da regra ("Quando faltar o preço: enviar mesmo assim | esperar eu completar"): recomendo, por ser a dúvida natural do dono.
5. **Local do espelhamento:** deixamos no Disparo automático (recomendado) ou o dono prefere um item próprio "Espelhamento" no menu, em DISPAROS?
6. **Mensagens enviadas pelo meu número:** a opção é por regra (como no brief) ou global? Spec assume por regra.
