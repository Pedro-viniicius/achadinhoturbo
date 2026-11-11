# Especificação de UI/UX: Rodar sozinho, entrega 2 (Mercado Livre que se recupera)

Brief: `docs/produto/briefs/rodar-sozinho.md`, seção "Entrega 2". Plano técnico em paralelo (`docs/produto/planos/rodar-sozinho-entrega2.md`): esta spec não depende dele; onde o nome de um campo ou de um motivo é do plano, está dito. Código lido na cópia `achadinho_turbo-wt-e1` (HEAD `def9a19`). Nenhuma tela nova e nenhum componente novo: reaproveita faixa de pílulas, `estado-pill`, linha de estado, `aviso-impl` e o Histórico. A mudança visual é a separação "extensão" × "Central" e um aviso de versão.

## Objetivo e usuário

Pedro (dono) usa sozinho, no computador. Em 10/11 o painel dizia "Extensão do Chrome conectada" enquanto a Central de Afiliados não respondia, e o Mercado Livre foi de 14 para 0 envios sem aviso. Depois desta entrega, em uma olhada ele sabe **qual das duas partes** está com problema, **desde quando**, e **se precisa fazer algo** (quase nunca: o Turbo espera e volta sozinho). No Histórico, entende por que uma oferta do ML não saiu.

Vocabulário da entrega 1 mantido: **Enviada**, **Pulada** (volta sozinha, sem revisão), **Descartada** (não serve; sem revisão), **Separada para revisão** (só com botão para o dono). Palavras novas, usadas sempre do mesmo jeito:

| Palavra | Sentido | Evitar |
|---|---|---|
| **Extensão** | O complemento do Chrome. | "plugin", "app" |
| **Central de Afiliados** (na linha de estado, "Central") | O site do Mercado Livre que gera os links, aberto pela extensão. | "API", "servidor do ML" |
| **Em espera** | O Mercado Livre inteiro parado de propósito, com novo teste marcado (o disjuntor). | "disjuntor", "circuit breaker", "bloqueado" (só nos Docs, uma vez, entre aspas, para quem procurar) |
| **Pausa da verificação** | A pausa de 30 min, 2 h ou 6 h depois que o ML pede verificação no navegador (já existe). É **outra coisa** que "em espera". | misturar os dois nos textos |

## Fluxo (o que o dono vê)

1. Tudo bem: faixa com "Extensão do Chrome conectada" e "Central de Afiliados respondendo". Nada mais.
2. A Central falha uma ou duas vezes: a oferta é pulada, outra ocupa a vaga, o Histórico explica. Selo continua "Conectado"; a linha da Central em Conexões ganha "!" e diz a falha.
3. Terceira falha seguida: o Mercado Livre entra **em espera**. Faixa e Conexões mostram "Central sem resposta" com há quanto tempo. O Histórico ganha uma linha. As ofertas do ML nem são tentadas (uma linha por execução diz quantas esperaram).
4. A cada 5 min o Turbo testa. Funcionou: linha "Mercado Livre voltou", faixa volta ao normal, as ofertas saem na execução seguinte. O dono não faz nada.
5. A mesma oferta falha em 3 execuções diferentes: vai à revisão, com o motivo. Recusa definitiva do ML (anúncio pausado): descartada.
6. Extensão antiga (depois da atualização do código): aviso na faixa e em Conexões, com o passo de recarregar.

## Layout (mobile e desktop)

### Faixa do topo (`#faixa`, `public/app.js` `faixa()`)

Hoje há uma pílula "Extensão do Chrome conectada/desconectada". Passa a ter **duas** pílulas lado a lado, na ordem extensão, Central (a faixa já é `flex-wrap`; a 375 px a segunda vai para a linha de baixo, sem rolagem horizontal). Pílula com problema vira `<a href="#conexoes">` (como a de "propostas") e usa o mesmo molde `pilula espera` (ponto âmbar mais texto). Ponto verde só com `ok`. O texto carrega o estado: a cor nunca é o único sinal.

| Situação | Pílula da extensão | Pílula da Central |
|---|---|---|
| Tudo bem | `Extensão do Chrome conectada` (ok) | `Central de Afiliados respondendo` (ok) |
| Extensão fora | `Extensão do Chrome desconectada` (vermelho, como hoje) | `Central de Afiliados sem informação` (neutra, sem ponto colorido: `pilula` simples) |
| Central falhando (1 ou 2 seguidas) | conectada (ok) | `Central de Afiliados respondendo` (ok). Só Conexões mostra a falha: ainda não parou nada. |
| Em espera | conectada (ok) | `Mercado Livre em espera: Central sem resposta há 25 min` (espera, link) |
| Extensão antiga | `Extensão do Chrome desatualizada` (espera, link) | segue o estado da Central |
| Modo direto (links sem etiqueta) | some as duas e fica `Links sem etiqueta (modo direto)` (como hoje) | |

Tempo na faixa: só no estado em espera, em degraus de 5 min ("há pouco" até 5 min; depois "há 5 min", "há 10 min"… "há 1 h", "há 2 h"; passou de 24 h, "desde 10/11"). Motivo: a faixa é `aria-live="polite"` e cada mudança de texto é lida; degraus de 5 min limitam a leitura a no máximo 12 por hora, só enquanto há problema.

Anúncio a leitor de tela: `faixa()` hoje reescreve o `innerHTML` a cada 3 s. **Só repintar quando o HTML novo for diferente do anterior** (comparar string); senão o leitor pode reler a faixa inteira o tempo todo. (O `dev` aplica; é marcação de `app.js`, que o designer só toca com a delegação.)

### Conexões, cartão Mercado Livre (`public/conexoes.js`, `pintarEstadoML`)

Cabeçalho: título "Mercado Livre" mais **um** selo (`#ml-selo`, classes que já existem). Abaixo da lista de etiquetas e dos passos, no lugar da linha única `#ml-estado`, **uma lista de duas linhas** (`<ul class="ext-estados">`, uma linha por parte), no padrão da linha da extensão da Shopee (`ext-linha`: glifo `✓` ou `!` no começo, mais texto). Cada linha tem **duas partes**: a frase do estado (dentro de `role="status"`) e o "há quanto tempo" (fora da região viva, em `<span class="quando">`), para o relógio não ser lido a cada atualização de 3 s.

A 375 px: o selo cabe ao lado do título (o mais longo, "Extensão desconectada", tem 21 caracteres em 11 px e `white-space:nowrap`; conferir se o cabeçalho quebra a linha sem estourar; se não quebrar, o `dev` põe `flex-wrap:wrap` no `header` do cartão). As duas linhas empilham, texto quebra (`overflow-wrap:anywhere`, por causa do erro real do Chrome, que pode ser longo). O "Último erro" vai em `<small>` na linha de baixo, cortado em 160 caracteres com reticências no servidor (o plano decide onde).

#### Selo do cartão (um só, por prioridade, de cima para baixo)

| Prioridade | Condição | Selo | Classe |
|---|---|---|---|
| 1 | Sem etiqueta salva, ou modo direto | `Falta configurar` (já existe) | `falta` |
| 2 | Extensão fora | `Extensão desconectada` (**novo**) | `pendente` |
| 3 | Mercado Livre em espera | `Central sem resposta` (**novo**) | `pendente` |
| 4 | Extensão mais antiga que a esperada | `Extensão desatualizada` (**novo**) | `pendente` |
| 5 | Tudo certo | `Conectado` (já existe) | `conectado` |

Hoje "extensão fora" aparece como "Falta configurar" (cinza, itálico), o que engana: o dono já configurou. Os três selos novos entram em `public/docs/cap-referencia.js` (`estados`, tabela "Estados dos cartões de Conexões", com a coluna "O que fazer"). O selo "Conectado" passa a significar também "Central respondendo" (ajustar o texto da linha 111 da referência).

#### Linha 1, Extensão do Chrome

| Estado | Texto | Glifo |
|---|---|---|
| Conectada | `Extensão do Chrome conectada.` + quando: `Falou com o painel há 5 s.` (segundos só aqui, e a parte "quando" é a que não é viva) | `✓` |
| Desconectada | `Extensão do Chrome desconectada.` + quando: `Última conversa há 12 min.` (sem registro: `Nunca conectou neste painel.`) | `!` |
| Antiga | `Extensão do Chrome conectada, mas desatualizada: é a {instalada} e o painel espera a {esperada} ou mais nova.` (sem versão informada: `é mais antiga que a {esperada}`) | `!` |

Quando a extensão está **desconectada**, abaixo da linha entra a dica: `Abra o Chrome com a extensão instalada e entre na Central de Afiliados com a sua conta.` (a que já existe).

Quando **antiga**, abaixo da linha vai um `aviso-impl` (classe existente, `!` âmbar, `role="status"`), com os passos:

> **Atualize a extensão.** 1. Abra `chrome://extensions`. 2. Na extensão achadinhoturbo, clique em recarregar (a seta circular). 3. Volte aqui: este aviso some sozinho. Enquanto isso o Mercado Livre continua funcionando, só sem as correções novas.

(Se o plano disser que a extensão antiga não funciona de jeito nenhum, trocar a última frase por: "Enquanto não recarregar, o Mercado Livre pode não funcionar.") Se a pasta `extension` ainda não foi atualizada no computador, o passo 0 é do Docs: "Atualize a pasta `extension` do programa (os arquivos novos), depois recarregue".

#### Linha 2, Central de Afiliados

| Estado | Texto | Glifo | O que o dono faz |
|---|---|---|---|
| Respondendo | `Central de Afiliados respondendo.` + quando: `Último link gerado há 2 min.` (nunca gerou: `Nenhum link gerado ainda.`; o dado persiste entre reinícios, CA2.6) | `✓` | Nada. |
| Falhando, 1 ou 2 seguidas | `A Central não respondeu ao último pedido.` + quando: `Há 3 min. Último link gerado há 1 h.` + `Último erro: …` | `!` | Nada: o programa pula a oferta e tenta outra. |
| Em espera | `Central sem resposta. O Mercado Livre está esperando.` + quando: `Sem resposta desde as 09:12 (há 25 min). Novo teste em 4 min. Último link gerado há 3 h.` + `Último erro: …` | `!` | Em geral, nada: volta sozinho. Se passar de 1 hora, abra a Central de Afiliados no Chrome e veja se a página carrega e se a sua conta está logada. |
| Sem informação (extensão fora) | `Sem informação: a extensão está desconectada.` + quando: `Último link gerado há 3 h.` | `–` | Resolver a linha da extensão. |
| Sem teste ainda | `Central ainda não testada.` + `Ela é testada no primeiro link que o programa pedir.` | `–` | Nada. |

"Novo teste em N min": arredonda para cima ("em menos de 1 min", "em 4 min"). Passou do horário do teste: "teste em andamento…". "Há quanto tempo" fora da faixa: `agora há pouco` (menos de 1 min), `há N min` (até 59), `há N h` (até 24 h), depois `em 09/11 às 14:32` (usar o formato de `dataHora` que a tela já usa). Uma função só (`haQuanto(ts)`) em `public/app.js`, ao lado de `dataHora`, usada pela faixa (com degrau de 5 min), por Conexões e pelo popup (que tem cópia própria, é outra página).

O texto de erro real que chega do Chrome ou do ML vem **entre aspas e sem tradução** em `Último erro:` (ex.: `Último erro: “Could not establish connection”`). É dado de diagnóstico, não frase nossa.

### Popup da extensão (`extension/popup.html`, `popup.js`)

Muda pouco, e só se o `background.js` guardar o estado da Central em `chrome.storage.local` (`st`, como hoje guarda `ok`, `erro`, `ultimoErro`; é do `dev`). A caixa `#estado` vira duas linhas na mesma caixa (mesmo `.estado`, ponto verde ou laranja, mais texto):

- Linha da extensão (como hoje): `Conectado ao achadinhoturbo` / `Desconectado` / o erro de conexão.
- **Linha nova**, só com a extensão conectada: `Central de Afiliados: respondendo` (ponto verde) ou `Central de Afiliados: sem resposta` (ponto laranja), e em `#erro`: `Último erro ao gerar link: …` (já existe, passa a trazer o erro real).
- **Rodapé** em `<small>`: `Versão 1.6.0` (número do manifesto; ver Perguntas).

O popup tem 320 px de largura fixa: as duas linhas quebram sem cortar. Marcar `#estado` com `role="status"`. Contraste: os tokens do popup (texto `#17142B` sobre `#F1EEFE`, `small` `#5E5A72` sobre branco) já passam em 4,5:1; manter.

## Componentes

| Componente | Existente ou novo | Onde fica |
|---|---|---|
| Pílula da faixa (`pilula`, `ok`, `espera`, link) | Existente; uma pílula a mais | `public/app.js` `faixa()` |
| Selo do cartão (`estado-pill` `pendente`/`conectado`/`falta`) | Existente; **3 textos novos** | `public/conexoes.js` `pintarEstadoML`, `TEXTOS_CONEXOES` |
| Linha de estado com glifo (como `ext-linha` da Shopee) | Existente, repetida em duas linhas | `public/conexoes.js`, `public/style.css` (só `ul.ext-estados` sem marcador e espaçamento da escala existente) |
| Aviso `aviso-impl` com passos | Existente | idem |
| `haQuanto(ts)` | **Função nova** (texto, sem estilo) | `public/app.js` |
| Linhas do Histórico, motivo de revisão | Existentes; textos novos | `src/scheduler.js` (dev); `public/espelhamento.js` `TEXTOS_REVISAO_CATALOGO` |

## Estados

Sem cor nem ícone novo. Cada estado tem **palavra** (selo, texto) e **glifo** (`✓`, `!`, `–`) além do ponto de cor. Estados a conferir em 375 e 1280 px: tudo certo; extensão fora; Central falhando; em espera (com e sem "último link"); extensão antiga com e sem versão informada; sem teste ainda; modo direto; erro real muito longo (quebra, sem rolagem horizontal); dados ausentes (servidor sem `central` no `/api/state`: cair no estado antigo `Extensão conectada.` sem quebrar, útil enquanto o painel carrega).

## 1. Textos do Histórico

Nível `aviso` (ponto amarelo mais palavra), salvo onde indicado. Nenhuma frase usa "disjuntor", "token", "timeout", "tab"; "Central" e "Mercado Livre" são os nomes que o dono usa. As causas entre parênteses seguem `CAUSAS`; novas, no mesmo molde (minúscula, sem ponto):

| Situação | Causa nova |
|---|---|
| Central sem resposta no prazo | `a Central de Afiliados não respondeu` |
| Central lenta | `a Central de Afiliados demorou demais` |
| Aba da Central não pôde ser aberta ou recuperada | `não deu para abrir a Central de Afiliados no Chrome` |
| Sessão vencida | `a Central de Afiliados pediu login` (a mais comum depois de dias; ação: entrar de novo) |

"A extensão do Chrome não está conectada" e "precisa ser recarregada" já existem.

### Pulada: falha passageira (CA2.1)

Molde da entrega 1, com o complemento "a vaga foi para outra oferta" só na contagem (não repetir):

- Link: `Pulada: não deu para gerar o link de afiliado (a Central de Afiliados não respondeu). Tenta de novo no próximo envio.`
- Conferência (já existe, só ganha causas): `Pulada: não deu para conferir o preço (a Central de Afiliados demorou demais). O Mercado Livre não sai sem conferir; tenta de novo no próximo envio.`
- Na **2ª** falha da mesma oferta, acrescentar: ` É a 2ª vez que falha; na 3ª ela vai para a revisão.` Na 1ª, nada (não assustar).

Prefixo `Pulada:` e nunca "revisão" nas duas primeiras, pela regra do vocabulário. Na 2ª, a palavra "revisão" aparece como aviso do que virá, sem tratar a oferta como já separada.

### Descartada: recusa definitiva do ML (CA2.2)

`Descartada: o Mercado Livre recusou gerar o link (o anúncio está pausado ou inativo).`

Para as recusas que o código souber classificar, uma causa curta por tipo (plano lista): `o anúncio está pausado ou inativo`, `o anúncio não existe mais`, `o Mercado Livre não gera link para este anúncio`. Recusa sem tradução: `Descartada: o Mercado Livre recusou gerar o link (resposta dele: “The article must be active, status: paused”).` Sem ação do dono; vira `descartada` na contagem como `recusada pelo Mercado Livre`.

### 3ª falha: separada para revisão (CA2.3)

`Separada para revisão: o link falhou em 3 envios seguidos (a Central de Afiliados não respondeu). Abra a oferta em Histórico > Catálogo, confira e envie à mão.`

Se a 3ª falha foi de conferência: `Separada para revisão: a conferência do preço falhou em 3 envios seguidos (a extensão do Chrome não está conectada). Abra a oferta em Histórico > Catálogo, confira o preço na loja e envie à mão.` Só o dono vê o botão, então a frase fala com ele. Nome do motivo no banco é do plano (sugestão: reaproveitar `falha_link` para os dois e mudar o texto, ou `falhas_repetidas`, mais exato). Texto na tela de revisão (`TEXTOS_REVISAO_CATALOGO.motivos`, no lugar de "Não consegui gerar o link: confira a oferta"): `Falhou 3 vezes seguidas: confira a oferta e envie`. O vazio da revisão (`vazio`) passa a: `Nada para revisar. As ofertas da Shopee, as com 100% de desconto, as com queda grande de preço e as que falharam 3 vezes aparecem aqui.`

### Mercado Livre em espera e de volta (CA2.4)

Linhas sem oferta, uma por mudança, não por execução. A de abrir é `aviso`; a de fechar é `info`. **Nenhuma é `erro`**: `erro` dispara aviso no WhatsApp, e o aviso de parada é da entrega 3.

- Abre: `Mercado Livre em espera: a Central de Afiliados falhou 3 vezes seguidas (a Central de Afiliados não respondeu). As ofertas do Mercado Livre esperam e o programa testa de novo em 5 min.`
- Teste ainda falhando: **sem linha nova** (evita encher o Histórico a cada 5 min). O quando e o último erro ficam em Conexões.
- Fecha: `Mercado Livre voltou: a Central de Afiliados respondeu ao teste (esteve em espera por 1 h 20 min). As ofertas do Mercado Livre saem no próximo envio.`

### Ofertas que esperam (CA2.4)

Entra em `TEXTO_ESPERA`, no mesmo molde (a linha leva o número antes: "3 ofertas …", "1 oferta …"), uma por execução:

`do Mercado Livre esperando: a Central de Afiliados não está respondendo. O programa testa de novo a cada 5 min e elas saem sozinhas quando ela voltar.`

Na frase "Saíram X de Y": motivo de pulada `Mercado Livre em espera`; a oferta que espera conta como pulada, como `falta conexão com a loja` hoje.

### Motivos curtos novos para "Saíram X de Y" (`PULADA_POR`, `DESCARTADA_POR`)

| Chave | Texto | Frase de exemplo |
|---|---|---|
| `link_central` (pulada) | `Central sem resposta` | `Saíram 1 de 2 ofertas; 1 pulada (Central sem resposta).` |
| `ml_espera` (pulada) | `Mercado Livre em espera` | `Saíram 0 de 3 ofertas; 3 puladas (Mercado Livre em espera).` |
| `recusada_ml` (descartada) | `recusada pelo Mercado Livre` | `Saíram 1 de 2 ofertas; 1 descartada (recusada pelo Mercado Livre).` |
| `falhas_repetidas` (revisão) | sem texto de motivo: segue `N separada(s) para revisão` | `…; 1 separada para revisão.` |

`link não gerado` (`PULADA_POR.link`) deixa de existir para o ML: vira `Central sem resposta`. Se ainda servir para outra loja, fica.

### Migração dos `falha_link` (uma linha, `info`)

Mesmo molde de `textoMigracaoE1`: `Revisão do Catálogo: 28 ofertas que esperavam revisão só porque o link não foi gerado saíram da fila. Elas voltam se o catálogo as trouxer de novo.` Singular: `1 oferta que esperava revisão só porque o link não foi gerado saiu da fila. Ela volta se o catálogo a trouxer de novo.` Zero: `Revisão do Catálogo: nenhuma oferta esperava revisão só porque o link não foi gerado.`

## 2. Itens deixados pela entrega 1

### (a) Queda grande de preço vai para a revisão

Motivo novo na revisão do Catálogo (nome do plano; sugestão `queda_preco`). Texto em três lugares, com marcadores que o `dev` troca pelos números (`{QUEDA}` = percentual real; `{LIMITE}` = o que o dono escolheu na aprovação):

- Tela de revisão (`TEXTOS_REVISAO_CATALOGO.motivos.queda_preco`): `Preço {QUEDA}% abaixo da lista: confira o preço`
- Histórico (`TEXTO_MOTIVO.queda_preco`): `Separada para revisão: o preço está {QUEDA}% abaixo do preço da lista (o limite é {LIMITE}%), confira o preço.` (o prefixo vem do código; manter vírgula antes de "confira", como `desconto_100`.)
- Faixa dentro do diálogo "Revisar oferta" (molde de `faixa100SemAntigo`): `O Etiqueta trouxe este preço {QUEDA}% abaixo do preço da lista, mais que o limite de {LIMITE}%. Pode ser promoção de verdade ou preço errado. Confira na loja antes de enviar.`
- Vazio da revisão: ver seção 1 (já inclui).

Onde o limite aparece para o dono ajustá-lo (campo da regra ou Ajustes) é decisão do plano; se existir campo, rótulo `Mandar para revisão se o preço cair mais que` com sufixo `% abaixo da lista` e ajuda: `Protege contra preço errado na lista. Ofertas com queda maior esperam a sua revisão em vez de sair.` Estados do campo (padrão, erro "Digite de 1 a 99") seguem os campos numéricos da regra. O `hcatPrecoSuspeito` do formulário de revisão (`espelhamento.js:627`) deve reconhecer o caso ao editar, como faz com 100%: dev.

### (b) Ofertas do ML com a leitura pausada

Saem da escolha sem uma linha "Pulada" por oferta. Aparecem na linha `info` "Antes da escolha…" como uma categoria nova (`fraseFiltradas`), no lugar do `semConferencia`, que hoje só diz "da Amazon":

`Antes da escolha, 9 ofertas ficaram de fora: 4 fora dos filtros da regra, 5 do Mercado Livre com a leitura em pausa (o Mercado Livre pediu verificação no navegador).`

Singular: `1 do Mercado Livre com a leitura em pausa (…)`. Quando a causa for outra pausa de leitura, a parte entre parênteses muda; a sigla e o número do tempo (30 min, 2 h ou 6 h) não entram: o dono não pode mudar isso. **Ação do dono**, só nos Docs e em `TIPS`: abrir um produto no Chrome e passar pela verificação. Quando o ML estiver **em espera** (disjuntor), as ofertas do ML **não** entram aqui: contam como `esperou` com a linha de espera da seção 1, para os dois motivos nunca se misturarem. Se as duas causas existirem na mesma execução, vale a espera (a Central é a causa mais grave e mais provável).

## 3. Texto de "Enviar" manual que falha em todos os grupos (CA2.8)

O item **continua na revisão**. No diálogo (`espelhamento.js`, `errosServidor`): `Não foi possível enviar: a oferta não chegou a nenhum grupo ({detalhe do primeiro erro}). Ela continua na revisão: tente de novo.` O botão volta ao rótulo `Enviar para N grupos` (sai de `Enviando…`). O texto atual `subReenviar` ("O envio anterior não chegou a nenhum grupo…") passa a valer só para o que já estiver `enviado` por versões antigas. Foco volta ao botão Enviar; o erro vai na região `role="alert"` que o diálogo já usa.

## 4. Docs, `TIPS`, README (CA2.10)

Procurar a grafia antiga: `grep -rn "Extensão conectada\|não consegui gerar o link\|falha_link\|Falta configurar\|recarreg" public/docs public/ajuda.js public/conexoes.js README.md`.

| Arquivo | Entrada | Mudança |
|---|---|---|
| `public/docs/cap-referencia.js` `estados` (linhas ~108-114) | Estados do cartão Mercado Livre | Três linhas novas: `Extensão desconectada`, `Central sem resposta`, `Extensão desatualizada`, cada uma com "O que fazer"; `Conectado` passa a incluir "e a Central respondendo"; `Falta configurar` deixa de cobrir extensão fora. |
| idem `motivos` (~177) | `Não consegui gerar o link: confira a oferta` | Troca pelo novo texto (`Falhou 3 vezes seguidas…`); nova linha da queda de preço; `Pulada` e `Descartada` que não vêm para a revisão ficam no parágrafo do vocabulário. |
| idem (~204-214) | Resultados da conferência | Linhas: `Pulada: não deu para gerar o link…`, `Descartada: o Mercado Livre recusou gerar o link…`, `Separada para revisão: o link falhou em 3 envios seguidos…`, `Mercado Livre em espera…`, `Mercado Livre voltou…`, `… do Mercado Livre esperando: a Central…`, `Revisão do Catálogo: … só porque o link não foi gerado…`, a nova categoria da linha "Antes da escolha"; causas novas na lista de causas. |
| idem glossário | "Extensão", "Verificador" | Verbetes novos: `Central de Afiliados`, `Em espera` (diz que também se chama "disjuntor" em conversas técnicas, uma vez) e `Pausa da verificação` (diferença de "em espera"). |
| idem limites (~257) | Linha do ML pela extensão | Acrescentar: depois de 3 falhas seguidas o Mercado Livre fica em espera; novo teste a cada 5 min; a mesma oferta vai para a revisão na 3ª falha. Entram em `FATOS`. |
| `public/docs/cap-conta.js` (~383-420, `verificador`; ~170, ajuda de `Ctrl+Shift+R`) | Parágrafo do ML pela extensão | Frase nova: a **espera** (Central) e a **pausa da verificação** são diferentes; atualizar "versão 1.5.0" para a nova; passo a passo de recarregar a extensão (`chrome://extensions`, seta circular na extensão). |
| `public/docs/cap-comecar.js:90` (erros comuns) | Nota "Não há sessão…" | Trocar "1.5.0" pela nova; acrescentar "Central sem resposta" e o que esperar. |
| `public/docs/cap-grupos.js:295` | "a Central de Afiliados do Mercado Livre não respondeu a tempo…" | Reescrever: a extensão recupera a aba sozinha e reaproveita a aba aberta; depois de 3 falhas seguidas o programa espera; ação só se passar de 1 hora. |
| `public/docs/cap-amazon-revisao.js` (~140-154) | Tabela de motivos | Troca de `falha_link` e linha da queda de preço. |
| `public/docs/cap-disparos.js` (~252) | Lista do que espera revisão | Atualizar com a queda de preço e a 3ª falha; frase sobre o ML em espera. |
| `public/ajuda.js` `TIPS` | `fonte.catalogo` e `fonte.catalogo.revisao` | Atualizar a lista de motivos; `ajustes.extensao` (se existir) e `conexoes.ml`: explicar os dois estados (extensão, Central) e "em espera volta sozinho". `LEIA_MAIS`: apontar para o capítulo `verificador` e para a referência de estados. |
| `public/conexoes.js` `TEXTOS_CONEXOES` | Textos do cartão | As frases das tabelas acima, em um objeto novo `TEXTOS_CONEXOES.ml` (nada de texto solto no componente). `TEXTOS_CONEXOES.shopee.passo1` ("versão 1.3.0") só muda se o plano exigir a versão nova; a Shopee não depende da Central do ML. |
| `README.md` (~314-320, ~781) | Causas, "Chrome precisa ficar aberto" | Mesmas mudanças dos Docs; incluir o passo de recarregar a extensão. |
| `test/docs.test.js` | `FATOS` | 3 falhas, 5 min, 3ª falha da oferta, 160 caracteres só se algum Doc citar. **O `dev` troca os testes que esperam as frases antigas** (`falha_link`, "Não consegui gerar o link"); `test/docs.test.js` é compartilhado. O teste exige as frases e causas do código nos Docs: toda causa e frase novas acima precisam estar em `cap-referencia.js`. |

Passo de recarregar a extensão (texto único, para colar em todos): `Atualize a pasta extension do programa, abra chrome://extensions e clique em recarregar (a seta circular) na extensão achadinhoturbo. Até lá, o painel mostra "Extensão desatualizada".`

## Acessibilidade (WCAG 2.2 AA)

- **Cor nunca sozinha:** cada estado tem palavra no selo e na pílula, e glifo (`✓`, `!`, `–`) na linha. Os selos novos usam as classes `pendente` e `conectado`, que já têm borda e ponto além da cor; o texto fica em `var(--text)`, o mesmo par de cores que passa em 4,5:1 nos selos de hoje. Conferir o selo `pendente` sobre fundo escuro se o tema permitir.
- **Anúncio ao leitor de tela:** a frase do estado, não o relógio, fica na região `role="status"` (Conexões) ou `aria-live="polite"` (faixa, já existente). O texto "há quanto tempo" não é vivo. `faixa()` só repinta com HTML diferente. Degraus de 5 min na faixa.
- **Foco:** as pílulas-link usam o `:focus-visible` global; alvo de toque: pílula de 5 px de padding mais 13 px de fonte dá ~30 px de altura, acima dos 24 do AA; no celular, as duas pílulas-link passam de `padding:5px 12px` para `padding:11px 14px` (44 px) em `@media (max-width:600px)`, como o projeto faz em outros alvos.
- **Teclado:** nada novo é interativo exceto o link da pílula e os passos do aviso. Ordem: faixa, depois o conteúdo.
- **`prefers-reduced-motion`:** nenhuma animação nova; não pôr pulso no ponto da Central.
- **Sem jargão:** nada de "disjuntor", "poll", "token" na tela; "Etiqueta" e "Central" são nomes que o dono conhece. O erro real do Chrome pode estar em inglês: vem entre aspas depois de "Último erro".
- **Popup:** `role="status"` no `#estado`; contraste já passa.

## O que o dev precisa implementar

1. Estado da Central em `/api/state` (`extensao.central` ou campo irmão: `respondendo`, `falhasSeguidas`, `emEspera`, `proximoTesteEm`, `ultimoOkEm`, `ultimoErroEm`, `ultimoErro`, `desdeEm`), persistido (CA2.6), e `extensao.versao` e `versaoEsperada`. Nomes do plano.
2. Frases das seções 1 a 3 (constantes em `src/`; o designer não edita `src/`), incluindo o `{QUEDA}` e o `{LIMITE}`, a linha de abrir e fechar a espera (só na mudança) e a da migração.
3. `faixa()`, `pintarEstadoML` e `TEXTOS_CONEXOES.ml` em `public/` (o designer pode fazer, se delegado, e **nunca ao mesmo tempo** que o `dev` mexe em `app.js`, `conexoes.js`, `espelhamento.js` ou `test/docs.test.js`).
4. `extension/popup.html`/`popup.js` e `manifest.json` (versão nova).
5. Docs e `FATOS` da seção 4.

## Arquivos de apresentação afetados

`public/app.js` (`faixa()`, `haQuanto`), `public/conexoes.js`, `public/espelhamento.js` (motivos, vazio, `errosServidor`, `hcatPrecoSuspeito`), `public/style.css` (só `ul.ext-estados` e o alvo de toque da pílula), `public/ajuda.js`, `public/docs/cap-referencia.js`, `cap-conta.js`, `cap-comecar.js`, `cap-grupos.js`, `cap-amazon-revisao.js`, `cap-disparos.js`, `README.md`, `extension/popup.html`, `extension/popup.js`.

## Perguntas em aberto

1. **Botão "Testar agora"** em Conexões para o dono não esperar os 5 min? É útil depois de ele ter entrado de novo na conta, mas exige rota nova. Sugestão: fora desta entrega.
2. **As 3 falhas que abrem a espera contam para a 3ª falha de cada oferta?** Se contarem, a oferta que estava na vez vai à revisão por culpa da Central. Sugestão: não contar o que abriu a espera (só falhas com a Central respondendo e a oferta recusada). Os textos servem aos dois.
3. **Versão nova:** 1.6.0 em todos os lugares? O texto usa `{esperada}`; os Docs citam o número (entra em `FATOS`).
4. **Extensão antiga ainda funciona?** O aviso muda de tom (seção 1, "Antiga").
5. **Percentual da queda de preço:** valor padrão e onde o dono o altera (o dono escolhe na aprovação). Sem ele, os textos ficam com marcador.
6. **Texto das causas de recusa do ML:** o plano diz quais mensagens do ML são definitivas; cada uma ganha a sua causa curta. As não mapeadas mostram a resposta original, como na seção 1.
7. **Faixa:** pílula única "Mercado Livre em espera" que substitui as duas, em vez de duas pílulas? Seria mais curta em 375 px, mas esconde que a extensão está bem. Mantive duas.
