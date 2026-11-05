# Especificação de UI/UX: grade de horários e "Grupo vivo"

Plano em paralelo: `docs/produto/planos/grade-de-disparos.md` (arquiteto; ainda não existia quando esta spec foi escrita). Padrões herdados de `docs/produto/specs/envio-pelo-socio.md`. Só apresentação: campos, rotas, limites e regras ficam com o arquiteto; o que depende dele vem como **[ARQ]** e o que o dono decide vem como **[DONO]**. Tokens novos: nenhum (só classes novas compostas com os tokens existentes).

## Objetivo e usuário

Pedro (dono), no computador, com pressa, sem jargão. Pedido: (1) escolher **a que horas** o Disparo automático publica, **quantas ofertas** em cada horário e **qual template** em cada um; (2) ter um lugar para mandar **mensagens e enquetes que mostrem que o grupo é vivo**; (3) **sem derrubar o atual**.

Regra do dono ("sem avisos técnicos"): nada de card ou aviso sobre configuração que ele já conhece. Aparece só o que **bloqueia** ou **falhou de verdade**. Resumos neutros ("14 horários, 42 ofertas por dia") não são aviso.

## Estado atual (visto no painel, 1280 px)

- **Disparo automático** (`formRegra`, `app.js:405`): fieldset "Ritmo de envio" com Ofertas por envio, Intervalo (min), Funciona das/até, Não repetir (dias) e Foto. Um template só por regra. Cartão: "3 ofertas a cada 60 min, das 08:00 às 22:00".
- **Disparar mensagem** (`paginaDispararMensagem`, `disparos.js:939`): mensagem ou enquete, escolha de grupos, Agora/Agendar/Repetir (dias + até 6 horários), lista "Agendadas e repetidas" ao lado. Funciona, mas cada repetição é um item solto, sem nome, sem chave liga/desliga e sem variação de texto.
- **Templates:** um editor, escolha por botão. **Ajustes:** só pausas (a janela é da regra, não de Ajustes).

## Decisão 1: onde fica a grade

**Dentro da regra do Disparo automático, como segunda forma de definir o ritmo**, não como tela nova. Por quê: a grade só troca "quando e quanto"; fonte, filtros, grupos, não repetir e foto continuam iguais, e o cartão, o histórico e o "Enviar agora" já existem. O intervalo de hoje **continua sendo o padrão**; regras existentes abrem como "A cada X minutos", sem nenhuma mudança.

## Decisão 2: onde ficam as mensagens de "grupo vivo"

**Recomendação: seção própria "Grupo vivo", no menu Disparos logo depois de "Disparar mensagem"**, reaproveitando os campos de mensagem e enquete.

Por quê:
- "Disparar mensagem" é ferramenta de **ação pontual** (escrevo, mando agora). Grupo vivo é **programação editorial recorrente** ("bom dia às 8h, enquete na sexta"): precisa de nome, chave liga/desliga, grupos fixos, vários textos em rodízio e um olhar da semana. Encaixar isso no formulário atual o deixaria enorme e esconderia as rotinas na lista lateral "Agendadas".
- A biblioteca de **modelos prontos** pede uma galeria; um formulário de envio não comporta.
- "Disparar mensagem" fica **exatamente como está** (pedido do dono). Contrapartida: um item a mais no menu e dois lugares onde se pode agendar mensagem. Mitigação: o `.sub` de "Disparar mensagem" ganha "Para rotinas que se repetem (bom dia, enquete da semana), use Grupo vivo." com link, e o texto de "Repetir" continua funcionando.
- Alternativa descartada: evoluir "Disparar mensagem" com uma aba "Rotinas". Mais barata, mas mistura o pontual com o recorrente e dá duas listas na mesma tela. **[DONO]** se preferir menos um item no menu, a aba é a segunda opção; o desenho dos cartões e do formulário abaixo não muda.

## Fluxo

1. Dono abre uma regra (nova ou existente) > Ritmo de envio > escolhe **Em horários marcados**.
2. A grade já vem com o equivalente ao ritmo de hoje (editável) ou ele toca num modelo rápido ("A cada 30 min, das 8h às 22h").
3. Ajusta horários, quantidade e template de cada linha; marca os dias; vê o total do dia; salva.
4. Em **Grupo vivo**, abre a galeria de modelos, escolhe "Bom dia", edita o texto, marca os grupos, escolhe dias e horários e liga.
5. Acompanha em **Histórico** (as mensagens de Grupo vivo aparecem com o nome da rotina **[ARQ]**).

## Layout: grade na regra (`formRegra`)

Dentro do fieldset "Ritmo de envio", primeiro item: `.seg` **"Como enviar"** com dois botões: **A cada X minutos** (padrão) | **Em horários marcados**. Troca sem perder o que foi digitado: os campos de intervalo ficam guardados na tela; só ficam escondidos. `Foto` e `Não repetir` ficam visíveis nos dois modos.

**Modo "A cada X minutos":** idêntico ao de hoje (Ofertas por envio, Intervalo, Funciona das/até).

**Modo "Em horários marcados":** esconde Ofertas por envio, Intervalo e Funciona das/até (os horários já dizem tudo; **[ARQ]** confirmar que a janela não vale na grade) e mostra, nesta ordem:

1. **Dias** (`.dias`, reaproveita `DISP_DIAS` e o padrão do Repetir): "Em quais dias". Padrão: todos marcados. Dica: "Os mesmos horários valem nos dias marcados." (**[ARQ]** se dias não entrarem, o bloco some.)
2. **Modelos rápidos** (linha de `button.chip` como os placeholders de Templates): "A cada 30 min, 8h às 22h", "A cada hora, 8h às 22h", "Manhã, tarde e noite" (09:00, 15:00, 20:00), "Horários de pico" (12:00, 18:00, 21:00). Mais um botão **"Montar…"** que abre o gerador:
   - mini-formulário em linha (`.grade`): **De** (time), **Até** (time), **A cada** (select 15, 30, 45, 60, 90, 120 min), **Ofertas em cada** (número 1 a 20), **Template** (select: "Padrão do disparo" ou um template).
   - Botões "Substituir horários" e "Acrescentar". Se a grade já tem linhas, "Substituir" pede `confirm("Isso troca os horários atuais por 29 novos. Continuar?")`.
   - Os quatro modelos rápidos são atalhos que preenchem o gerador e já aplicam (sempre "Substituir", com a mesma confirmação).
3. **Lista de horários** (`<ol class="gh-lista">`, uma `<li role="group" aria-label="Horário 3">` por linha, em ordem de hora):
   - **Horário** (`input type="time"`), **Ofertas** (número 1 a 20), **Template** (select: "Padrão do disparo ({nome})" + templates), ações **Copiar** e **Remover** (botões de texto; no celular com 44 px).
   - **Copiar** cria uma linha com os mesmos valores, 30 minutos depois do horário copiado (ou o próximo livre), com o foco no horário novo para o dono ajustar.
   - **Ordenação:** ao sair do campo de horário (`change`), a linha vai para o lugar certo e o foco volta ao mesmo campo; um `role="status"` diz "Horário movido para a posição 4." Nunca reordena enquanto digita.
   - Cabeçalho de colunas (Horário, Ofertas, Template) só em ≥ 601 px; em ≤ 600 px cada campo mostra o rótulo em cima (a `label` existe nos dois casos; no desktop o texto do rótulo da linha fica visualmente oculto, com o cabeçalho único à vista).
   - Rodapé da lista: **"+ Adicionar horário"** (nova linha 1 h depois da última, copiando ofertas e template dela), **"Limpar tudo"** (leve, com confirm) e contador "(N de {máx} horários)" **[ARQ]** máx.
4. **Resumo vivo** (`.dica`, `role="status"`, `aria-live="polite"`): "14 horários por dia, das 08:00 às 21:30. 42 ofertas por dia em 2 grupos (84 mensagens)." Neutro, sempre visível, não é aviso.
5. **Variação (opcional)**: select "Horário exato | Variar até 2 min | Variar até 5 min | Variar até 10 min", dica "Sai alguns minutos antes ou depois, de forma aleatória. Parece mais natural." Padrão: exato. **[ARQ]** se não entrar, some.
6. Frase fixa (`.dica`): "As pausas entre mensagens são as de Ajustes." com link `#ajustes`.

Uma regra tem **uma** grade; "A cada X minutos" e a grade não rodam juntas na mesma regra. Quem quer os dois cria duas regras (já possível hoje).

### Cartão da regra (`cartaoRegra`)

- Chip **"Grade"** (texto sempre visível) ao lado do nome quando a regra usa horários marcados.
- Resumo: "14 horários por dia (08:00 a 21:30), de 2 a 4 ofertas cada, seg a sex, para 2 grupos. Fonte: … Templates: 3 diferentes." (1 template: "Template: {nome}".)
- Linha `.prox`: "Próximo envio hoje às 10:30: 3 ofertas com o template Cupom." Fora dos dias: "Próximo envio quarta, 08:00 · 3 ofertas." Pausado: "Pausado" (como hoje).
- "Enviar agora" funciona como hoje e **não consome** o próximo horário da grade **[ARQ/DONO]** (recomendado: manda a quantidade do próximo horário e a grade segue).
- Regras sem grade: cartão **idêntico** ao de hoje.

## Layout: Grupo vivo (`#grupo-vivo`)

Mesmo padrão de Disparo automático: `.topo` + lista de `.card.regra`.

- `.topo`: título "Grupo vivo" com `q('grupovivo')`, `.sub`: "Mensagens e enquetes que mostram que o grupo tem gente por trás. Escolha um modelo, ajuste o texto e marque os horários." Botões: **"Nova mensagem"** (`pri`), "Nova enquete" e "Modelos" (neutros, quebram de linha em ≤ 600 px).
- **Cartão por rotina:** chave Ativo (`aria-label="Rotina ativa: {nome}"`), nome, chip "Mensagem" ou "Enquete"; resumo "Seg a sex às 08:00 e 18:00. Para 3 grupos. 3 textos em rodízio."; `.prox` "Próximo envio hoje às 18:00" ou "Pausado"; contagem "Últimas 24 h: 2 enviadas." (**[ARQ]**); ações `pri` "Enviar agora", "Editar", "Copiar", `perigo leve` "Excluir". "Enviar agora" pede confirmação: `confirm("Enviar agora para 3 grupos?")` (manda mensagem a gente de verdade; "Disparar mensagem" já faz o mesmo).
- **Programação de hoje** (card no topo da lista, só se houver rotina **ou** regra com grade ligada; **fase 2, opcional**): `<ol>` cronológica com hora, tipo (texto: "Ofertas", "Mensagem", "Enquete") e nome. Serve para o dono enxergar o dia inteiro e os horários que se encontram. Dados de regras e rotinas **[ARQ]**.

### Formulário "Nova mensagem" / "Nova enquete" / "Editar rotina" (`<dialog>`, uma coluna)

Ordem: o quê, para onde, quando.
1. **Nome** (obrigatório, até 60, "Só você vê. Ex.: Bom dia de segunda a sexta.").
2. **Tipo** (`.seg` Mensagem | Enquete, só ao criar; ao abrir pela galeria já vem escolhido).
3. **Conteúdo, com rodízio:** lista de **textos** (mensagem) ou **enquetes** (pergunta + 2 a 12 opções + "Permitir mais de uma resposta"), com "+ Adicionar outro texto" (até 5 **[ARQ]**), remover cada um e prévia `.chat > .balao` do texto selecionado. Com 2 ou mais, aparece `.seg` **"Ordem": Um depois do outro | Sorteio** (padrão: um depois do outro) e dica "Cada envio usa um texto. Assim o grupo não vê sempre a mesma mensagem." Mensagem leva foto opcional como "Disparar mensagem" (mesmos controles; **[ARQ]** se a foto entra na 1ª versão).
4. **Grupos** (`fieldset` com `seletorGrupos({ blocos: true, prefixo: 'gv-' })`, obrigatório, contador). O bloco copia os grupos na hora, como no Disparo automático.
5. **Quando:** Dias (`.dias`) e Horários (`.horarios`, "+ Adicionar horário", 1 a {máx}; **[ARQ]** o limite de 6 de hoje vale ou sobe). Mesmo select de **Variação** da grade.
6. Rodapé: "Cancelar" e `pri` "Criar rotina" / "Salvar"; na criação, "Ligar agora" (padrão marcado).

### Galeria "Modelos" (`<dialog>`)

Lista de cartões compactos: título, chip do tipo, 2 linhas do texto, botão **"Usar este modelo"** (abre o formulário já preenchido; nada é salvo até "Criar rotina"). Abre sozinha, no lugar do estado vazio, quando não há rotina. Os modelos moram em `MODELOS_GRUPO_VIVO` no topo do arquivo novo; texto editável sempre. Os modelos **sem emoji**; o dono pode acrescentar.

**Modelos sugeridos** (tom de grupo de achadinhos):

| Modelo | Tipo | Texto | Sugestão de horário |
|---|---|---|---|
| Bom dia (3 textos, rodízio) | Mensagem | "Bom dia, pessoal! Hoje tem achadinho novo saindo ao longo do dia. Fiquem de olho aqui no grupo." / "Bom dia! Café na mão e olho nas ofertas. Daqui a pouco começam os achadinhos de hoje." / "Bom dia, gente! Quem já separou o que quer garantir hoje? As ofertas começam a sair por aqui." | seg a dom, 08:00 |
| Regras do grupo | Mensagem | "Regras do grupo, para todo mundo aproveitar: 1) Aqui só ofertas e dúvidas sobre elas. 2) Sem spam e sem links de outros sites. 3) Preço e estoque mudam rápido: confira na página da loja antes de comprar. 4) Dúvida? Pergunte aqui que a gente ajuda." | uma vez por semana, ex.: domingo 10:00 |
| Aviso de segurança | Mensagem | "Dica de segurança: compre só pelos links que chegam aqui, que levam direto para a página da loja. Ninguém do grupo vai pedir senha, código ou dados por mensagem privada. Se alguém pedir, desconfie." | quarta, 12:00 |
| Prova social (convite) | Mensagem | "Já comprou alguma oferta daqui e gostou? Conta pra gente! Seu relato ajuda o pessoal a escolher melhor." | sábado, 11:00 |
| Preço muda | Mensagem | "Lembrete: o preço e o estoque podem mudar a qualquer momento. O valor que vale é o que aparece na página da loja na hora da compra." | seg a sex, 14:00 |
| Boa noite | Mensagem | "Por hoje é só, pessoal! Amanhã tem mais achadinhos. Boa noite e boas compras." | seg a dom, 21:30 |
| Enquete: o que ver mais | Enquete | "O que você quer ver mais por aqui?" Casa e cozinha / Eletrônicos / Moda / Beleza / Ferramentas (várias respostas) | sexta, 12:00 |
| Enquete: já comprou | Enquete | "Você já comprou alguma oferta do grupo?" Sim, e gostei / Ainda não / Comprei mais de uma vez | segunda, 19:00 |
| Enquete: melhor horário | Enquete | "Em que horário você mais olha o grupo?" Manhã / Tarde / Noite | quinta, 12:00 |
| Enquete: sextou | Enquete | "Sextou! O que vai pro carrinho neste fim de semana?" Algo para casa / Eletrônico / Presente / Só olhando | sexta, 18:00 |

**[DONO]** Prova social **sem número inventado** (não há "mais de 1.000 membros" nos modelos): o modelo convida a participar em vez de afirmar algo que pode não ser verdade. Se quiser números reais, o plano precisa de um campo automático, por exemplo `{MEMBROS}` **[ARQ]**.

## Componentes

| Componente | Existente ou novo | Onde fica |
|---|---|---|
| `.card.regra`, `.chip`, `.chave`, `.seg`, `.dias`, `.horarios`, `.chat/.balao`, `.grade`, `.opcoes-enquete`, `.dica`, `nivel-*`, `<dialog>` | Existentes | `style.css` |
| `seletorGrupos`, `dispSegHtml`, `dispLigarSeg`, `DISP_DIAS`, `mostrarErros`, `q`, `REQ`, `opcoes` | Existentes | `app.js`, `disparos.js` (sem editar `disparos.js` salvo o `.sub` de "Disparar mensagem") |
| `gradeHtml(grade)`, `gradeLer()`, `gradeModelos()`, `gradeResumo()` | Novos | `public/grade.js` (novo, depois de `app.js`'s helpers, antes da rota) |
| `paginaGrupoVivo()`, `formRotinaViva(r)`, `galeriaModelos()`, `MODELOS_GRUPO_VIVO`, `TEXTOS_GRADE`, `TEXTOS_GRUPO_VIVO` | Novos | `public/grupovivo.js` (novo) |
| Classes `.gh-lista`, `.gh-linha`, `.gh-cab`, `.gh-resumo` | Novas (só layout, com tokens existentes) | fim de `style.css` |
| Item de menu "Grupo vivo" e rota `grupo-vivo` | Novos | `index.html`, `ROTAS` em `app.js` |

## Estados

**Grade**
- **Vazio** (todas as linhas removidas, ou "Limpar tudo"): no lugar da lista, `.vazio`: "Nenhum horário ainda. Comece por um modelo ou adicione um horário." com os modelos rápidos à vista. Salvar assim: erro "Adicione ao menos um horário."
- **Primeira vez em "Em horários marcados":** vem preenchida com o equivalente ao ritmo de hoje (ex.: 60 min, 08:00 a 22:00, 3 ofertas = 15 linhas), editável. Voltar para "A cada X minutos" não apaga nada.
- **Horários repetidos na mesma regra** (bloqueia): na linha, `aria-invalid`, borda de erro e texto "Já existe um horário às 10:00. Mude um deles ou some as ofertas em uma linha só." Salvar mostra o erro em `.erros` e leva o foco ao campo. Dois horários **diferentes** no mesmo minuto não existem: o minuto é a unidade.
- **Horário que se encontra com outra regra ou rotina** (não bloqueia, sem aviso): vão para a fila única, uma atrás da outra, com as pausas de Ajustes. Só na linha, `.dica` discreta quando o servidor souber: "10:00 também tem {nome}. Saem um depois do outro." **[ARQ]**
- **Não dá tempo antes do próximo horário** (`nivel-aviso`, "!" textual, não bloqueia): "O envio das 10:00 leva uns 18 min (3 ofertas, 4 grupos, pausas de Ajustes) e o próximo é às 10:15. O próximo sai assim que o anterior acabar." Cálculo com as pausas de `S.st.ajustes`; aparece só quando estoura.
- **Passou do limite anti-ban** **[ARQ/DONO]** (definir os números): dois níveis.
  - *Acima do recomendado* (`nivel-aviso`, abaixo do resumo; salva): "Somando os outros disparos e rotinas ligados, este número enviaria cerca de 380 mensagens por dia. (Sem outros ligados: "Este número enviaria…".) Acima de {N} aumenta o risco de bloqueio do WhatsApp. Para baixar: menos ofertas por horário, menos horários ou menos grupos." O cálculo soma as outras regras e as rotinas de Grupo vivo ligadas, se o servidor mandar; senão, só a regra aberta (e o texto diz "esta regra").
  - *Acima do máximo* (só se o dono quiser um teto duro; `nivel-erro` ao salvar, em `.erros`): "Passa do máximo de {M} mensagens por dia para este número. Reduza a grade para salvar."
  - Abaixo do recomendado: nada além do resumo neutro.
- **Dias:** nenhum marcado, erro "Marque ao menos um dia."
- **Modo grade e regra pausada:** cartão mostra "Pausado", como hoje.
- **Carregando** ("Salvando…" no botão, travado), **sucesso** (toast e cartão atualizado), **erro do servidor** (`mostrarErros`).
- **Conteúdo inesperado:** nome do template longo com reticências e `title`; 29 linhas rolam dentro do diálogo (`max-height` do `dialog` já existe), nunca a página.

**Grupo vivo**
- **Vazio** (nenhuma rotina): a galeria de modelos aparece aberta no lugar da lista, com "Criar do zero". Sem card de aviso.
- **Sem grupos carregados** (WhatsApp desconectado): só dentro do formulário, o `.dica` já usado do seletor, com "Criar" desabilitado e a razão ao lado (como em Remetente).
- **Desligada:** chave desligada, "Pausado" no resumo.
- **Erro de envio** (o número saiu do grupo etc.): linha `nivel-erro` no cartão "Não foi para o grupo {nome}. Veja o Histórico." **[ARQ]**
- **Erros de campo:** "Dê um nome à rotina." / "Escreva o texto da mensagem." / "A enquete precisa de uma pergunta." / "A enquete precisa de ao menos 2 opções." / "As opções da enquete não podem se repetir." / "Marque ao menos um grupo." / "Marque ao menos um dia." / "Adicione ao menos um horário." / "Já existe um horário às 18:00." (os três da enquete reaproveitam `TEXTOS_DISPAROS`).
- **Conflito de horários entre rotinas** (dois itens às 08:00): permitido, sem aviso; saem um depois do outro. Na "Programação de hoje" aparecem juntos.
- **Excluir:** `confirm("Excluir a rotina “{nome}”? O que já foi enviado continua no Histórico.")`.

**Operador**
- Hoje o Operador **edita regras e mensagens** como o Dono; só ações marcadas com `exigeDono` (desconectar, limpar, remetentes) são bloqueadas. **Recomendação: a grade e o Grupo vivo seguem a mesma regra do Disparo automático** (Operador pode tudo), por consistência. **[ARQ/DONO]**
- Se o arquiteto ou o dono restringirem: o Operador **vê** os cartões e a grade; no lugar dos botões Novo/Editar/Excluir/Enviar agora e da chave, aparece `<small class="dica">Só o Dono pode alterar a grade.</small>` (padrão `SO_DONO_DICA`, `podeEquipe()`); a chave fica `disabled` com o texto do estado ("Ativo" ou "Pausado") visível. O servidor responde 403, e a tela mostra a mensagem em `mostrarErros`, nunca erro técnico.

## Textos da interface

Em `TEXTOS_GRADE` e `TEXTOS_GRUPO_VIVO` (no topo dos arquivos novos), nunca soltos no componente; ajuda em `ajuda.js`.
- **Botões:** Em horários marcados, A cada X minutos, Montar…, Substituir horários, Acrescentar, + Adicionar horário, Copiar, Remover, Limpar tudo, Nova mensagem, Nova enquete, Modelos, Usar este modelo, Criar do zero, Criar rotina, Enviar agora, Copiar, Excluir.
- **Rótulos:** Como enviar; Em quais dias; Horário; Ofertas; Template; Padrão do disparo ({nome}); Variação do horário; Ordem (Um depois do outro, Sorteio); Rotina ativa.
- **Toasts:** "Grade salva" (a regra segue "Salvar" normal), "Rotina criada", "Rotina salva", "Rotina ligada", "Rotina pausada", "Rotina excluída", "Enviado para {N} grupos".
- **Avisos e erros:** como nas seções acima, em linguagem de resultado. Frase de "Enviar agora": "Enviando para {N} grupos." Nenhum texto técnico (sem "cron", "slot", "fila única").
- **Verbetes para `TIPS`:** `regras.modo_grade`, `regras.grade_horarios`, `regras.grade_modelos`, `regras.grade_variacao`, `grupovivo`, `grupovivo.rodizio`, `grupovivo.variacao`. **Template excluído em uso** (texto de `confirm` em Templates): "Este template é usado em {N} horários de grades. Eles passam a usar o template padrão da regra." **[ARQ]** confirmar o comportamento.

## Acessibilidade (WCAG 2.2 AA)

- **Teclado:** ordem do DOM igual à visual; `.seg` "Como enviar" com `aria-pressed` (padrão de `dispSegHtml`); foco inicial do diálogo em "Nome"; `Esc` fecha e devolve o foco ao botão de origem; **Copiar** e **Adicionar** levam o foco ao horário da linha nova; **Remover** leva o foco ao horário da linha anterior (ou ao botão "+ Adicionar" se não sobrar).
- **Rótulos:** cada campo de linha tem `label` (visível ≤ 600 px, só leitor de tela acima disso) com o número da linha; botões repetidos levam o objeto no `aria-label` ("Copiar horário 10:00", "Remover horário 10:00"). Dias com `aria-label` do nome inteiro (padrão atual).
- **Anúncios:** resumo vivo e "movido para a posição N" em `role="status"`; erros em `.erros` (`role="alert"`) com foco no primeiro inválido; contador de horários em `aria-live="polite"` sem repetir a cada tecla (atualiza ao `change`).
- **Cor nunca sozinha:** "Pausado", "Grade", "Mensagem", "Enquete" são texto; avisos com "!" textual e erro com texto, não só borda vermelha.
- **Contraste:** avisos com `--text` sobre `color-mix(--warn 18%, surface)` com borda `--warn` (não usar `--warn` como cor de texto pequeno); erros com o token de erro já conferido nos dois temas; links sublinhados dentro de avisos.
- **Alvos:** 44 px no celular em botões, chaves, dias, modelos rápidos e ações de linha; 24 px no mínimo no desktop.
- **Responsivo:** 320 a 1280 px sem rolagem horizontal da página. ≤ 600 px cada linha da grade vira 2 colunas (Horário | Ofertas), Template em largura total, ações embaixo lado a lado; o `.seg` "Como enviar" quebra de linha; os modelos rápidos quebram de linha. Linhas de texto de dica com no máximo ~75 caracteres.
- **Movimento:** nada animado; reordenar linhas é imediato.
- **Entrada:** `type="time"` nativo (teclado e seletor do sistema); `inputmode="numeric"` nos números; sem máscara própria.

## O que o dev precisa implementar

1. `public/grade.js` (novo): editor da grade (linhas, Copiar, Remover, ordenar ao sair do campo, gerador, modelos rápidos, resumo vivo, validações de linha, cálculo de duração e de total do dia) e leitura do formulário para o corpo da regra.
2. `public/app.js`: no `formRegra`, o `.seg` "Como enviar" e o bloco da grade (esconder/mostrar os campos de intervalo e janela sem perder valores); no `cartaoRegra`, chip "Grade", resumo e `.prox` novos; incluir `grade` no corpo enviado e nas validações (campos do plano **[ARQ]**); rota `grupo-vivo` em `ROTAS`; `SO_DONO_DICA` se o Operador for restringido; confirmação de excluir template em uso.
3. `public/grupovivo.js` (novo): página, cartões, formulário (mensagem e enquete com rodízio), galeria e `MODELOS_GRUPO_VIVO`. Reaproveita `seletorGrupos`, `dispSegHtml`, `DISP_DIAS` e os controles de enquete de `disparos.js`; se for preciso extrair um pedaço para reuso, **combinar com o lead** (o dev não pode editar `disparos.js` em paralelo com o designer).
4. `public/index.html`: item "Grupo vivo" no menu Disparos (depois de "Disparar mensagem", com ícone do mesmo conjunto) e `<script>` dos dois arquivos novos na ordem certa.
5. `public/style.css`: `.gh-*` e o ajuste do `.dias`/`.horarios` se precisar, só com tokens existentes. Conferir Disparo automático, Disparar mensagem e Templates em 375 e 1280 px.
6. `public/ajuda.js` (`TIPS`, `LEIA_MAIS`), README e capítulos dos Docs: `public/docs/cap-*.js` do Disparo automático e do Disparar mensagem, e `cap-referencia.js` se houver selo ou motivo novo. Número novo que apareça nos dois (máx. de horários, teto de mensagens) entra em `FATOS` de `test/docs.test.js`.
7. Conferir em 375, 320 e 1280 px: regra com grade (vazia, preenchida, com conflito, com aviso de limite), cartão com e sem grade, Grupo vivo vazio com galeria, formulário de mensagem com 3 textos, de enquete, e Operador.

## Arquivos de apresentação afetados

`public/app.js`, `public/grade.js` (novo), `public/grupovivo.js` (novo), `public/index.html`, `public/style.css`, `public/ajuda.js`, `public/docs/cap-*.js`, `README.md`, `test/docs.test.js` (só `FATOS`). **Não editar** `public/disparos.js` (só o `.sub` de "Disparar mensagem", e só se o lead autorizar).

## Perguntas em aberto

1. **[DONO]** "Grupo vivo" como seção própria (recomendado) ou aba dentro de "Disparar mensagem"?
2. **[DONO]** Nome da seção: "Grupo vivo", "Mensagens do grupo" ou "Engajamento"? (Recomendo "Grupo vivo": curto e sem jargão.)
3. **[DONO/ARQ]** Teto de mensagens por dia por número: qual o recomendado (aviso) e se existe um máximo que bloqueia. Hoje o código não tem nenhum.
4. **[DONO]** Os modelos da tabela estão no tom certo? Algum a tirar ou trocar?
5. **[DONO]** "Enviar agora" numa regra com grade: manda a quantidade do próximo horário sem pular nada (recomendado)?
6. **[ARQ]** A grade vale o mesmo para todos os dias marcados, ou o plano aceita grade por dia? A tela prevê um só conjunto de horários.
7. **[ARQ]** Máximo de horários por grade (a tela prevê até 48) e de textos em rodízio (5); o limite atual de 6 horários no Repetir vale para Grupo vivo?
8. **[ARQ]** Template por horário: o que acontece quando o template é excluído? E a janela "Funciona das/até" deixa de valer na grade?
9. **[ARQ]** Variação aleatória de horário e rodízio de textos entram na primeira versão? Se não, os campos somem sem mexer no resto.
10. **[ARQ]** O servidor expõe para a tela: próximo envio da grade, horários que dividem o minuto com outra regra ou rotina, total diário somado do número, e envios de Grupo vivo no Histórico com o nome da rotina?
11. **[ARQ/DONO]** Operador: mesmos direitos de hoje (recomendado) ou só ver?
12. **[ARQ]** Foto nas mensagens de Grupo vivo na primeira versão?
