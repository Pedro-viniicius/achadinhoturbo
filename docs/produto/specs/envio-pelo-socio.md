# Especificação de UI/UX: links enviados pelo sócio pelo WhatsApp

Brief: `docs/produto/briefs/envio-pelo-socio.md`. Plano em paralelo: `docs/produto/planos/envio-pelo-socio.md` (arquiteto). Formato e padrões herdados de `docs/produto/specs/espelhamento-amazon.md`. Só apresentação: nomes de campo, rotas e regras ficam com o arquiteto; o que depende dele ou do dono vem marcado **[ARQ]** ou **[DONO]**. Tokens novos: nenhum.

## Objetivo e usuário

Pedro (dono), no computador, com pressa, sem jargão. Ele quer:
1. cadastrar uma vez quem pode mandar links (o sócio) e para onde eles vão;
2. confiar que o link sai com a afiliação **dele**, sem repetir e sem abrir a porta para qualquer número;
3. ver, sem abrir arquivo, o que o sócio mandou e o que aconteceu.

O sócio não usa o painel: a "interface" dele é a conversa privada do WhatsApp, então as respostas automáticas (seção 4) fazem parte do desenho.

Regra do dono (memória "sem avisos técnicos"): **nenhum card ou aviso sobre estado de configuração que ele já conhece** (API da Amazon sem credencial, loja em "só com a tag"). Só aparece o que bloqueia ou falhou de verdade, em linguagem de resultado, e o detalhe técnico fica em Conexões.

## Fluxo

1. Dono abre **Disparo automático > Novo remetente**, informa nome e número do sócio, marca os grupos de destino (ou usa um bloco como atalho), escolhe template e foto e salva ligado.
2. Sócio manda um link (ML, Amazon ou Shopee) no privado do número conectado.
3. O programa gera o link de afiliado do dono e enfileira o envio na fila única, respeitando as pausas de Ajustes. Sem aprovação.
4. Se "Responder ao remetente" estiver ligado, o sócio recebe uma frase curta.
5. O dono acompanha no cartão (contagem das últimas 24 h) e no **Histórico > Remetente** (cada link, com resultado e motivo).

## Layout (mobile e desktop)

Mesmo padrão: `.topo` + `.card`, formulário em `<dialog id="dlg">` (uma coluna, `.grade` só para campos curtos), uso principal em tela larga, utilizável de 320 px sem rolagem horizontal da página.

### Onde fica a tela (decisão e justificativa)

**Recomendação: terceiro tipo de regra em Disparo automático**, ao lado de "Disparo automático" e "Espelhamento", sem item novo no menu.

Por quê:
- É o mesmo modelo mental do espelhamento: algo que "reage sozinho" a uma entrada e envia para grupos fixos. Cartão, chave liga/desliga, contadores de 24 h, grupos de destino, template, foto e Histórico por tipo já existem e se reaproveitam.
- "Números de WhatsApp" é a conexão do aparelho (QR, estado): pôr remetentes ali mistura "qual número envia" com "quem pode me mandar links".
- "Relatórios e avisos" guarda quem **recebe** avisos do sistema; aqui o número **envia** para o sistema. Mesma palavra, sentido oposto: confunde, e a privacidade é o único ponto em comum (o texto "Os números ficam só no seu computador." se repete).
- Item novo em Disparos engorda o menu por uma tela que terá 1 ou 2 cartões.

Contrapartida: o `.topo` da página fica com três botões. Mitigação: só "Novo disparo automático" é `pri`; "Novo espelhamento" e "Novo remetente" são neutros e quebram de linha em ≤ 600 px (`.linha` com `flex-wrap`, já usado). O `.sub` ganha: "Também pode espelhar ofertas da Amazon e receber links de outros números."

**Nome da feature na tela: "Remetente"** (não "sócio"): o número cadastrado pode ser qualquer pessoa de confiança. Botão "Novo remetente"; chip "Remetente". **[DONO]** confirmar o nome (alternativa: "Links por WhatsApp").

**Unidade do cadastro: um cartão por remetente**, cada um com os próprios grupos de destino. Mais simples de entender e de editar que uma lista de números dentro de um formulário. Contrapartida: dois números com o mesmo destino repetem a escolha de grupos. **[DONO]** Se prefere "um cartão com vários números e um destino só", o formulário troca o campo Número por uma lista com "Adicionar número"; o resto não muda.

### Lista (`#disparo-automatico`)

O cartão (`.card.regra`, mesma família de `cartoesEspelhamento`) mostra:
- **Cabeçalho:** chave Ativo (`aria-label="Remetente ativo: {nome}"`), nome, chip "Remetente" (`.chip`, texto sempre visível).
- **Resumo (`.res`):** "Número (35) 9••••-1234. Para 2 grupos. Template: um para cada loja. Até 10 links por hora." Nome do grupo só se for 1 (reticências e `title`); senão a contagem. O número aparece **sempre mascarado**.
- **Linha de números (`.prox`):** "Últimas 24 h: 5 links recebidos, 4 enviados, 1 repetido." Sem atividade: "Ainda não recebeu links." Com último link: "Último link: hoje, 14:32." (dados do servidor **[ARQ]**).
- **Linha de problema real (só quando existe, `nivel-aviso` com "!" textual):** só estados que impedem o envio e que o dono pode resolver, por exemplo "Os links do Mercado Livre não saem: falta a etiqueta. Cadastre em Conexões." (link). Nenhuma linha para estado normal ("API não configurada" não aparece). **[ARQ]** definir quando o servidor sabe disso (ex.: o último link de uma loja falhou por falta de afiliação).
- **Ações:** `pri` "Ver registro" (leva a `#historico?tipo=remetente&regra=<id>`), "Editar", `perigo leve` "Excluir". Sem "Enviar agora".

### Formulário "Novo remetente" / "Editar remetente"

`<form method="dialog" novalidate>`. Ordem: quem → para onde → como fica → limites.

1. **Privacidade** (`p.dica`, uma linha, como `formDestinoAviso`): "O número fica só no seu computador."
2. **Nome** (`.campo`, obrigatório, até 60): dica "Ex.: Sócio João. Só você vê este nome."
3. **Número do remetente** (`input type="tel" inputmode="tel" autocomplete="off"`, obrigatório ao criar):
   - **Máscara ao digitar:** `(35) 99999-1234`; aceita colar com `+55`, espaços, hífen e parênteses; o prefixo `55` é aceito e removido na exibição. Fixo (8 dígitos) também formata: `(35) 3333-1234`.
   - **Validação BR:** depois de tirar não dígitos e o `55` inicial, 10 ou 11 dígitos; DDD de 11 a 99; com 11 dígitos o terceiro dígito é 9. A mesma validação vale no servidor (**[ARQ]**: a do cliente é só conforto). Fica mais estrita que a de Relatórios e avisos (10 a 15 dígitos) porque aqui o número tem de **casar** com o remetente.
   - Dica: "Com DDD. Exemplo: (35) 99999-1234. É o número do WhatsApp de quem vai mandar os links."
   - **Edição:** o número salvo não volta para a tela. Placeholder com o mascarado e dica "Hoje: (35) 9••••-1234. Deixe em branco para manter; digite outro para trocar." (mesmo padrão de `numeroManter`).
   - **Duplicado:** "Este número já está cadastrado como {nome}." (checagem no servidor). Número igual ao conectado: "Este é o número conectado ao painel. Cadastre o número de quem vai mandar os links." **[ARQ]** confirmar se o servidor sabe comparar.
4. **Grupos de destino** (`fieldset`, obrigatório): `seletorGrupos({ blocos: true, prefixo: 's-', rotuloBusca: 'Buscar grupo de destino' })`, contador "(N selecionados)". Legenda: "Para onde vão os links que este número mandar." O atalho "Marcar um bloco…" **copia** os grupos do bloco no momento (como no Disparo automático): dica abaixo do seletor "O bloco só ajuda a marcar. Se você mudar o bloco depois, esta lista não muda." **[ARQ]** se o plano preferir destino por bloco vivo, a dica e o atalho mudam.
5. **Etiqueta do Mercado Livre** (`select`, mesmo `src_tag` do formulário de regra: "A etiqueta ML padrão" + `S.tags`), dica "Vale só para links do Mercado Livre. Amazon e Shopee usam a configuração de Conexões." Sem etiqueta cadastrada: o select mostra só "A etiqueta ML padrão", sem aviso.
6. **Template** (`select`): primeira opção "Um para cada loja (padrão)", depois os templates existentes; link "Gerenciar templates". **[ARQ]** confirmar se existe template padrão por loja; se for um só, a opção some. Prévia em `.chat > .balao` com `/templates/preview` e `dispSegHtml` "Mercado Livre | Amazon | Shopee" para trocar a oferta de exemplo; legenda "Exemplo. Linha sem valor some sozinha." Sem `details` de placeholders (já existe em Espelhamento; link "Campos do template" para os Docs basta).
7. **Foto do produto** (`select`: "Enviar com foto, quando houver" | "Só texto").
8. **Ritmo e proteção** (`fieldset`, `.grade`):
   - "No máximo (links por hora)" (`number`, `min 1`, padrão 10 **[ARQ]**), dica "Passou disso, os links esperam ou são descartados (veja a dica abaixo). Protege os seus grupos se o número do sócio for usado por outra pessoa." **[ARQ/DONO]** esperar ou descartar; recomendo descartar com resposta ao remetente, porque fila crescendo escondida é pior.
   - "Não repetir o mesmo produto por (horas)" (`number`, `min 0`, padrão 24), dica "0 = pode repetir. Vale mesmo se o link for diferente."
   - Frase fixa (`.dica`): "As pausas entre mensagens são as de Ajustes." com link `#ajustes`.
9. **Responder ao remetente no WhatsApp** (checkbox, padrão ligado) + dica "Manda uma frase curta ao número cadastrado dizendo se o link saiu. Desligado, ele não recebe nada."
10. **Rodapé:** "Cancelar" e `pri` "Criar remetente" / "Salvar". Na criação, checkbox "Ligar agora" (padrão marcado), como no espelhamento.

### Histórico (`#historico`, tipo "Remetente")

- Seletor "Tipo" (`.seg`) ganha o quarto botão "Remetente": Tudo | Disparo automático | Espelhamento | Catálogo | Remetente. Em 320 px os botões quebram de linha (`.seg` já faz); conferir.
- **Visão Remetente:** três `.kpi` (Enviados, Descartados, Com erro; últimas 24 h) e `.card.tabela` com colunas Quando, Remetente (só o **nome** cadastrado), Grupo, Oferta, Resultado. Filtro por regra pelo endereço (`regra=<id>`), 50 mais recentes e "Mostrar mais", como a visão Espelhamento. Atualização a cada 6 s sem repintar com `<dialog>` aberto e cancelada ao sair da rota (padrão de `paginaHistoricoEspelhamento`).
- **Oferta:** título se houver; senão "Produto da Amazon", "Produto do Mercado Livre", "Produto da Shopee"; nunca o texto da mensagem do sócio.
- **Resultado** (texto + classe, nunca só cor):
  - `nivel-ok` "Enviada" + `.dica` "com o título da loja" / "com o texto do remetente" (se a origem dos dados importa **[ARQ]**);
  - `nivel-aviso` "Descartada: repetida (enviada há 3 h)"; "Descartada: link não reconhecido"; "Descartada: passou do limite por hora"; "Descartada: sem dados para montar a oferta" (se o plano descartar nesse caso **[ARQ]**);
  - `nivel-aviso` "Não saiu: falta a etiqueta do Mercado Livre" / "Não saiu: falta a tag da Amazon" / "Não saiu: falta o ID da Shopee" (um por loja, com link para Conexões);
  - `nivel-erro` "Erro ao enviar para este grupo" + motivo curto.
- Mensagem com vários links: **uma linha por link e por grupo**, como as outras visões; o cartão conta por link.
- **Nunca** número do remetente (nem mascarado), texto bruto da mensagem ou nome de participante: só o nome cadastrado. Confirmar com o dev que a API não manda esses campos.
- Vazio: "Nenhum link recebido ainda. Cadastre um remetente em Disparo automático." (link). Vazio por filtro: "Nada com este filtro nas últimas 24 h."

### Resposta ao remetente (conversa privada no WhatsApp)

O sócio é um usuário: as frases são curtas, sem jargão, sem detalhe técnico e sem link de afiliado. **[ARQ]** confirmar que a resposta sai pela mesma fila e pausas (resposta também é mensagem do número conectado).

| Situação | Frase enviada |
|---|---|
| Saiu para todos os grupos | "Enviado para 3 grupos." (singular: "Enviado para 1 grupo.") |
| Saiu para parte | "Enviado para 2 de 3 grupos." |
| Repetido | "Esse produto já foi enviado há 3 h. Não repeti." |
| Link sem afiliação possível (falta etiqueta, tag ou ID) | "Não consegui montar esse link agora. Avisei o dono." |
| Sem dados do produto (se o plano descartar) | "Não consegui ler os dados desse produto. Tente mandar o link de novo ou me chame." **[ARQ]** |
| Mensagem sem link de loja aceita | "Não encontrei um link do Mercado Livre, Amazon ou Shopee nessa mensagem." |
| Vários links | "Recebi 3 links: 2 enviados, 1 repetido." |
| Passou do limite por hora | "Muitos links em pouco tempo. Tente de novo daqui a pouco." (só na 1ª vez da hora; depois silêncio, para não gerar laço de mensagens) |

- Remetente **não cadastrado** ou regra **desligada**: **silêncio total**, sem resposta. Resposta a desconhecido confirmaria que o número existe e abriria uma via de abuso.
- Pausa de Ajustes ou fora de horário: "Recebi. Sai assim que for liberado." só se o plano segurar o link na fila (**[ARQ]**); se enviar sempre na hora, a frase não existe.
- Nunca ecoar o link recebido, o número ou o nome do grupo. Aviso ao dono sobre falha: aparece no Histórico; nada técnico vai ao sócio.

## Componentes

| Componente | Existente ou novo | Onde fica |
|---|---|---|
| `.card.regra`, `.chip`, `.chave`, `.kpi`, `.tabela`, `.seg`, `.chat/.balao`, `.grade`, `nivel-*`, `<dialog>` | Existentes | `style.css` |
| `seletorGrupos` com `prefixo` e `blocos: true` | Existente | `app.js` (sem mudança) |
| `dispSegHtml`, `dispLigarSeg`, `mostrarErros`, `q`, `REQ`, `opcoes` | Existentes | `disparos.js`, `app.js` |
| Seletor "Tipo" do Histórico (`histTipoHtml`, `histIr`) | Existente, ganha 1 valor | `espelhamento.js` |
| `cartoesRemetentes()`, `formRemetente(r)`, `paginaHistoricoRemetente(params)`, constante `TEXTOS_REMETENTE` | Novos | `public/remetentes.js` (novo; carrega depois de `espelhamento.js`, antes de `app.js`) |
| Máscara de telefone BR (`mascaraTelefoneBR`, `digitosBR`) | Nova, função pura reutilizável (Relatórios e avisos pode adotar depois) | `remetentes.js` |

## Estados

**Lista**
- **Vazio** (nenhum remetente): no fim da lista, junto dos outros tipos, sem card próprio. Se não há regra nenhuma, vale a mensagem atual do Disparo automático. Com regras mas sem remetente, nada aparece: o botão "Novo remetente" e o `.sub` bastam.
- **WhatsApp desconectado:** sem aviso no cartão (o painel já mostra o estado do número no topo e em Números de WhatsApp; é estado que o dono conhece). Só dentro do formulário, no seletor de grupos, vale o `.dica` existente "Nenhum grupo carregado. Conecte o WhatsApp em Números de WhatsApp." com "Criar" desabilitado e a razão ao lado: "Conecte o WhatsApp em Números de WhatsApp para escolher os grupos."
- **Loja sem tag, etiqueta ou ID:** sem aviso preventivo no formulário nem na lista. Vira informação só depois de um link falhar por isso: linha `nivel-aviso` no cartão, linha de resultado no Histórico e frase ao sócio (acima). Motivo: é configuração que o dono conhece; o que ele precisa saber é que **um link específico não saiu**.
- **Desligado:** chave desligada e texto "Pausado" no resumo; links recebidos com a regra desligada são ignorados (**[ARQ]**), sem resposta.
- **Erro de configuração** (grupo de destino que o número saiu): linha `nivel-erro` "O número saiu do grupo {nome}. Edite o remetente." (dado do servidor **[ARQ]**).
- **Carregando** ("Carregando…" no corpo do dialog; "Salvando…" no botão, travado), **sucesso** (toast + cartão aparece/atualiza; nunca só toast), **erro do servidor** (`mostrarErros(dlg, [{msg: e.message}])`).

**Formulário: erros de campo** (`mostrarErros`, foco no primeiro inválido)
- "Dê um nome ao remetente."
- "Informe o número com DDD. Exemplo: (35) 99999-1234."
- "Este número já está cadastrado como {nome}."
- "Marque ao menos um grupo de destino."
- "Escolha um template." / "O template precisa do campo {LINK}." (só se escolher um específico)
- "Links por hora: use um número de 1 a 60." (limites **[ARQ]**)
- "Horas sem repetir: use 0 ou mais."

**Excluir:** `confirm("Excluir o remetente “{nome}”? Ele deixa de poder mandar links. O que já foi enviado continua no Histórico.")`. O número é apagado do banco **[ARQ]**.

**Histórico:** carregando, vazio, vazio por filtro, erro ao carregar ("Não consegui carregar o histórico. Tente de novo." + "Tentar de novo"), "simulado" em modo simulação, conteúdo longo (título em 2 linhas com `title`).

## Textos da interface

Em `TEXTOS_REMETENTE` no topo de `remetentes.js`, nunca soltos no componente. Textos de ajuda em `ajuda.js` (vão para o plano do arquiteto, como combinado). pt-BR.

- **Botões:** Novo remetente, Criar remetente, Salvar, Cancelar, Ver registro, Editar, Excluir, Mostrar mais, Tentar de novo, Gerenciar templates.
- **Títulos:** "Novo remetente" / "Editar remetente"; "Grupos de destino"; "Ritmo e proteção"; seletor "Tipo": "Remetente".
- **Rótulos e dicas:** conforme as seções acima (texto final), incluindo "Responder ao remetente no WhatsApp", "Ligar agora" (dica: "Desligado, o remetente fica cadastrado, mas os links dele são ignorados.").
- **Toasts:** "Remetente criado", "Remetente salvo", "Remetente ligado", "Remetente pausado", "Remetente excluído".
- **Resultados do Histórico e respostas ao sócio:** tabelas acima.
- **Verbetes sugeridos para `TIPS`** (o arquiteto fecha o texto quando decidir as regras): `remetente`, `remetente.numero`, `remetente.destino`, `remetente.responder`, `remetente.limite`; glossário: "Remetente".

## Acessibilidade

- **Teclado:** ordem do DOM = ordem visual; dialog com foco inicial em "Nome"; `Esc` fecha e devolve o foco ao botão de origem; foco visível em todos os controles.
- **Rótulos:** todo campo com `label` visível; botões repetidos levam o objeto no `aria-label` ("Editar remetente Sócio João", "Excluir remetente Sócio João"); chave "Remetente ativo: {nome}".
- **Máscara de telefone:** não pode mover o cursor de forma surpreendente nem impedir colar; formatar no `input` preservando a posição. Dica do formato ligada por `aria-describedby`. Erros em `.erros` (`role="alert"`) com foco no primeiro inválido.
- **Anúncios:** contador de grupos, KPIs e resultados do Histórico em `aria-live="polite"`/`role="status"`; erros em `role="alert"`.
- **Cor nunca sozinha:** "Enviada", "Descartada", "Não saiu", "Erro", "Pausado" são texto; aviso com "!" textual.
- **Contraste:** texto de aviso em `--text` sobre `color-mix(--warn 18%, surface)` com borda `--warn`; reuso dos tokens já conferidos nos dois temas. Links dentro de avisos sublinhados.
- **Alvos:** 44 px no celular em botões, chave e linhas do seletor de grupos; 24 px no mínimo no desktop.
- **Privacidade na tela:** número só mascarado (ex.: `(35) 9••••-1234`; o ponto de máscara é texto, com `aria-label` "número terminado em 1234" para o leitor de tela não ler pontos). Nunca no `title`, no log do navegador ou na URL do Histórico.
- **Movimento:** nada novo animado.

## O que o dev precisa implementar

1. `public/remetentes.js` (novo): `TEXTOS_REMETENTE`, `cartoesRemetentes()`, `formRemetente(r)`, máscara e validação de telefone BR, visão `paginaHistoricoRemetente`, ligação das ações do cartão (ligar, registro, editar, excluir).
2. `public/app.js`: botão "Novo remetente" no `.topo` do Disparo automático (neutro) e o `.sub` novo; inserir `cartoesRemetentes()` na lista (`recarregarRegras`); aceitar `tipo=remetente` em `paginaHistorico`.
3. `public/espelhamento.js`: `histTipoHtml` com o quarto botão; `histIr` repassando `regra`.
4. `public/index.html`: `<script>` de `remetentes.js` na ordem certa.
5. `public/ajuda.js`: verbetes e glossário (texto vem do plano).
6. `style.css`: só se faltar algo. Se mudar, conferir Disparo automático, Histórico e Conexões em 375 e 1280 px.
7. Conferir em 375 e 1280 px: lista com os 3 botões no topo, formulário completo, Histórico (visão Remetente) e o `.seg` de quatro botões em 320 px.

## Arquivos de apresentação afetados

`public/remetentes.js` (novo), `public/app.js`, `public/espelhamento.js`, `public/index.html`, `public/ajuda.js`, `public/docs/cap-*.js` (capítulo do Disparo automático e a referência de estados, via plano do arquiteto), `public/style.css` (só se necessário). **A árvore tem mudanças sem commit em `public/disparos.js`, `public/docs/cap-disparos.js` e `public/docs/cap-referencia.js`**: esta feature só usa funções de `disparos.js`, sem editá-lo; se o dev precisar mexer em `cap-referencia.js`, esperar o commit dessas tarefas.

## Perguntas em aberto

1. **[DONO]** Nome "Remetente" está bom, ou prefere "Links por WhatsApp"?
2. **[DONO]** Um cartão por remetente (recomendado) ou um cartão com vários números e destino único?
3. **[ARQ]** Template único por remetente ou padrão por loja? A tela já prevê as duas opções.
4. **[ARQ/DONO]** Passou do limite por hora: descartar com resposta (recomendado) ou segurar na fila?
5. **[ARQ]** Sem título ou preço (ML sem extensão, Amazon sem API, Shopee): enviar no formato curto, descartar ou deixar para o dono completar? Isso decide se existem os resultados "sem dados" e "na fila" no Histórico; a spec cobre "descartada".
6. **[ARQ]** As respostas ao sócio passam pela fila única e pelas pausas? Quando o link fica na fila por pausa ou horário, a frase "Recebi. Sai assim que for liberado." entra.
7. **[ARQ]** Como o servidor casa o remetente `@lid` com o número cadastrado e o que mostrar se não casar (o brief pede o plano). Do ponto de vista da tela, só importa que o cadastro continue sendo pelo número.
8. **[ARQ]** O que o servidor expõe para o cartão: contagens de 24 h, último link, e quando existe "problema real" (falta de afiliação) para a linha de alerta.
