# Especificação de UI/UX: Rastreio por grupo e página Ganhos

Brief: `docs/produto/briefs/dashboard-ganhos.md` (CA1 a CA11). Plano em paralelo: `docs/produto/planos/dashboard-ganhos.md` (não existia ao escrever). Tudo marcado **[A alinhar com o plano]** depende dele: nomes finais de métricas, rotas e campos.

## Objetivo e usuário

Pedro (dono), no computador, com pressa, sem jargão. Pergunta que a tela responde: "qual grupo, nicho ou oferta me dá dinheiro, e quanto custa cada membro novo?". O Operador só consulta.

Decisões de desenho:
- **Código de rastreio por grupo é configuração rara, feita uma vez**; o ganho é consulta frequente. Então a configuração fica perto de onde o dono já pensa em grupos e blocos, e o Ganhos ganha página própria.
- **Padrão primeiro, exceção depois**: o código se define no **bloco** (um clique a menos por grupo); o **grupo** só tem campo próprio quando precisa fugir do bloco. Precedência, de maior para menor: grupo, bloco, padrão da loja (hoje).
- **Sem configurar nada, nada muda** (CA9). A tela deixa isso explícito.
- **Honestidade com os números**: todo valor mostra de onde vem (importado de que arquivo, até que dia) e quanto do envio foi rastreado. Número sem cobertura suficiente leva aviso, não é escondido.

## Vocabulário (resolve os "cinco nomes parecidos")

No painel, o termo genérico é **Código de rastreio**. Cada loja mantém o nome que o portal dela usa, sempre com o nome da loja junto. Nunca usar "tag" sozinho nem "etiqueta" sozinha nos textos novos.

| Loja | Rótulo no painel | O que é | Não confundir com |
|---|---|---|---|
| Mercado Livre | **Etiqueta do Mercado Livre** (já existe) | nome criado em "Administrar etiquetas" na Central de Afiliados | app Etiqueta, Catálogo |
| Amazon | **ID de rastreamento da Amazon** | criado em Associados > Gerenciar IDs de rastreamento (termina em `-20`) | tag padrão da conta (Conexões > Amazon) |
| Shopee | **Sub_id da Shopee** | texto livre, letras e números, para a Shopee separar as vendas | ID de afiliado (só números, Conexões > Shopee) e AppID |

Regra de texto: o campo da Amazon diz "ID de rastreamento da Amazon (opcional)" e a dica diz "Sem ele, vale a tag padrão da sua conta". O ID de afiliado da Shopee nunca aparece nesses formulários.

## Fluxo

1. **Configurar** (uma vez): Blocos de análise > Editar bloco > bloco "Códigos de rastreio" > preenche os que quiser > Salvar. Para exceção: Grupos > coluna Rastreio > "Definir" no grupo.
2. **Importar** (a cada semana ou mês): Ganhos > "Importar comissões" > escolhe a loja > envia o arquivo > confere o resumo.
3. **Informar gasto** (opcional): Ganhos > "Gasto com anúncios" > período, grupo ou bloco, valor.
4. **Consultar**: Ganhos > filtros > cartões > tabelas. O indicador de cobertura diz se dá para confiar.
5. Estado inicial: o dono nunca importou nada. A página explica os 3 passos e leva a cada um (ver "Estado vazio").

## Layout

### 1. Associar código de rastreio

**Onde (decisão)**: dois pontos, o mesmo componente nos dois.

**a) Blocos de análise** (`formBloco` em `paineis.js`). Hoje o diálogo tem "Nome", "Etiqueta do Mercado Livre (opcional)" e Grupos. A etiqueta já está lá; só se agrupa e se estende:

```
Nome do bloco [____________]
Grupos do bloco [seletor]
-- Códigos de rastreio (opcional)  ?
   Para separar o ganho deste nicho. Sem preencher, nada muda: os links saem como hoje.
   Etiqueta do Mercado Livre   [Nenhuma v]            (campo atual, movido para cá)
   ID de rastreamento da Amazon [__________]  Ex.: casa-20
   Sub_id da Shopee            [__________]  Ex.: casa
```
- O bloco de campos é um `fieldset` com `legend` "Códigos de rastreio (opcional)", fechado por padrão num `details` quando os três estão vazios, aberto quando algum tem valor.
- Cartão do bloco (lista): troca a linha "Etiqueta do Mercado Livre: …" por uma linha curta "Rastreio: ML `etq` · Amazon `casa-20` · Shopee `casa`" (só o que existir; sem nenhum: "Rastreio: padrão de cada loja"). Selos com texto, não só cor.

**b) Grupos** (`tabelaGrupos` em `app.js`). Nova coluna **Rastreio** (última, antes de ações se houver). Célula:
- Sem exceção: texto cinza "Do bloco" (se o grupo está em bloco com algum código) ou "Padrão", mais botão `leve` "Definir" com `aria-label="Definir código de rastreio do grupo <nome>"`.
- Com exceção: selos "Amazon `x-20`", "Shopee `y`", "ML `etq`" e botão "Editar".
- "Definir/Editar" abre `dlg` com o mesmo `fieldset` de 3 campos, título "Rastreio do grupo <nome>", texto "Vale só para este grupo e vence o código do bloco. Deixe vazio para voltar ao do bloco." e botões "Cancelar" / "Salvar rastreio". Grupo em dois blocos com códigos diferentes: mostrar aviso no diálogo ("Este grupo está nos blocos A e B com códigos diferentes. O do bloco A (o mais antigo) é usado. Defina aqui para decidir.") **[A alinhar com o plano: regra de desempate]**.
- Em 375 px a tabela de Grupos já rola dentro de `.tabela`; a coluna nova vira linha secundária sob o nome (padrão do `.duas-col`), para não exigir rolagem horizontal da página.

**Por que não em Conexões**: lá ficam credenciais da loja (uma por conta). Código por grupo é por destino; colocar lá obrigaria a escolher grupo numa tela sem lista de grupos.

**Resumo de cobertura de configuração**: no fim do `fieldset` do bloco e do diálogo do grupo, uma linha de "Como vai sair o link" (prévia em texto): "Amazon: usa `casa-20`. Shopee: usa o Sub_id `casa`. Mercado Livre: etiqueta da regra (você não escolheu uma)." Evita erro de configuração sem testar envio.

### 2. Ganhos (nova página `#ganhos`)

**Recomendação: página própria "Ganhos", no grupo "Principal" do menu, logo depois de "Visão Geral"** (antes de Rotacionador).
Motivos: (1) a Visão Geral já tem 7 seções e atualiza sozinha a cada 30 s; misturar dinheiro importado (dado de dias atrás) com eventos ao vivo confunde o que é tempo real; (2) a Ganhos precisa de filtros próprios (loja, período maior, "mês passado") e de ações (importar, gasto) que a Visão Geral não tem; (3) o Operador e o Dono pensam nela como "relatório de dinheiro". A Visão Geral ganha só um cartão-atalho opcional (sugestão, não obrigatório): "Ganhos do mês: R$ X · ver detalhes" quando houver dados.

Hash `#ganhos`; alias de filtro `#ganhos?bloco=3&loja=shopee&periodo=30d`. Entrada no menu: `<a href="#ganhos">Ganhos</a>`. Docs: item "Ganhos" nos capítulos.

Estrutura (desktop 1280, `main` até 1040 px):
```
H1 Ganhos ?                       [Importar comissões] [Gasto com anúncios]
sub: "Quanto cada grupo rendeu. Dados importados até 02/11 (Shopee), 28/10 (Amazon)."
Filtros: Período [seg: 7 dias | 30 dias | Mês atual | Mês passado | Personalizado]
         Bloco [chips, como Visão Geral]   Loja [seg: Todas | Mercado Livre | Amazon | Shopee]
Faixa de cobertura (card, destaque conforme nível)
Cartões (.kpis): Comissão | Cliques | Ganho por clique | Conversão | Gasto | Custo por membro novo
Tabela "Por grupo"
Tabela "Por oferta"
Detalhes: "Linhas sem grupo" (n) e "Como ler estes números" (details)
```
Botões do topo: **uma** ação principal. "Importar comissões" é `pri`; "Gasto com anúncios" é botão comum. Quando não há importação nenhuma, o estado vazio assume a ação principal e o botão do topo vira comum.

Mobile 375: título; botões empilham em largura total (alvo 44 px); filtros: período em `.seg` com quebra (já existe), bloco em chips rolando em linha própria quebrando linha, loja em `.seg`; cartões 2 por coluna (`minmax(150px,1fr)`); tabelas viram lista de cartões compactos por linha (nome + comissão em destaque, demais valores em `dl` abaixo), sem rolagem horizontal da página.

#### Cartões (nomes alinhados ao brief **[A alinhar com o plano: nomes finais do catálogo MDD]**)

| Cartão | Fórmula (texto mostrado em `?`) | Observação de tela |
|---|---|---|
| Comissão | soma das comissões importadas no período | valor em R$; abaixo: "período anterior: R$ X (+12%)" com sinal e texto, não só cor |
| Cliques | cliques no Rotacionador do período | "só links do Rotacionador; links diretos de loja não entram" |
| Ganho por clique | comissão ÷ cliques | "—" quando cliques = 0, nota "sem cliques no período" |
| Conversão | vendas ÷ cliques | vendas = linhas de comissão (pedidos) importadas; nota se a loja filtrada não tem cliques medidos |
| Gasto | soma do gasto informado | "—" com "informar" (botão `leve`) quando nenhum |
| Custo por membro novo | gasto ÷ entradas no período | "—" se gasto ou entradas = 0; nota "entradas de todos os grupos do filtro" |
| Lucro (opcional, só com gasto) | comissão − gasto | texto "prejuízo" ou "lucro" além do sinal; cor ok/err sempre acompanhada da palavra |

Cada cartão usa `.kpi`; o rótulo leva `?` (TIPS). Valores em `toLocaleString('pt-BR', {style:'currency', currency:'BRL'})`. Cartão sem dado mostra "—", nunca "R$ 0,00" falso quando o motivo é não haver importação.

#### Indicador de cobertura do rastreio

Card acima dos cartões, sempre visível quando há envios no período.
- Texto principal: "**82% dos envios saíram com código de rastreio** (164 de 200 links)". Barra (`.barra`) com o percentual escrito ao lado; `role="img"` com `aria-label` do mesmo texto, ou `<progress>` com rótulo.
- Detalhe por loja, uma linha cada: "Shopee 95% · Amazon 100% · Mercado Livre 40%". Se alguma loja ficou abaixo de 80%: selo "Atenção" (texto + ícone/símbolo `!`) e frase "Parte dos links do Mercado Livre saiu sem etiqueta do bloco. Configure em Blocos de análise." com link `#blocos`.
- Limiares **[A alinhar com o plano: meta da métrica]**: >= 90% "Boa" (ok), 60 a 89% "Parcial" (warn), < 60% "Baixa" (err). Sempre com a palavra.
- Quando a cobertura é baixa, os valores por grupo levam nota: "números parciais: só os envios rastreados".
- Link "Ver envios sem código" leva a `#historico?...` filtrado **[A alinhar com o plano: se o histórico terá esse filtro; senão omitir]**.
- Aviso de atribuição incerta: vendas da Shopee/Amazon só são atribuídas ao grupo se o relatório trouxer o código. Linha: "Vendas sem código no relatório: N (R$ X). Estão no total, mas sem grupo."

#### Tabela "Por grupo"

Colunas: Grupo · Bloco · Comissão · Vendas · Cliques · Ganho por clique · Entradas · Gasto · Custo por membro novo. Ordenada por comissão decrescente por padrão; cabeçalho clicável em botão (`aria-sort`) para ordenar. Linha final "Sem grupo identificado" com a soma das linhas importadas sem código ou com código desconhecido (não some do total). Linha de totais em `tfoot`.
- Dono pode clicar no nome do grupo para filtrar a tabela "Por oferta" por aquele grupo (botão, não só link).
- Mais de 25 grupos: "Mostrar mais" (não paginação numerada).

#### Tabela "Por oferta"

Colunas: Oferta (título curto, `title` com o completo, truncado com `overflow-wrap:anywhere`) · Loja (selo com texto) · Vendas · Comissão · Grupos que enviaram. Top 10 por comissão, "Ver todas". Oferta sem título conhecido: "Oferta <código curto>". Link da oferta abre em outra aba (`rel="noopener"`, `aria-label` diz "abre em outra aba").

#### Estado vazio (nunca importou, nunca informou nada)

No lugar de cartões e tabelas, um `.card` com título "Ainda não há ganhos para mostrar" e 3 passos numerados, cada um com botão:
1. **Rastreie os links por grupo** (opcional, mas é o que separa o ganho por grupo): "Em Blocos de análise, informe um código por bloco." [Abrir Blocos de análise]
2. **Baixe o relatório de comissões** no portal de cada loja (Shopee, Amazon, Mercado Livre) e importe aqui. [Importar comissões]
3. **Informe o gasto com anúncios**, se quiser saber o custo por membro novo. [Gasto com anúncios]
Rodapé: "Os links continuam saindo como hoje enquanto você não configurar nada." e link "Como baixar o relatório de cada loja" para o capítulo do livro.
Se já existem envios rastreados mas nenhuma importação: o indicador de cobertura aparece normalmente e os cartões de dinheiro mostram "—" com "Importe o relatório para ver".
Importado mas o filtro não casa nada: "Nenhuma comissão neste período e filtro." + botão "Limpar filtros".

### 3. Importar comissões (diálogo `dlg` aberto por "Importar comissões")

Diálogo, não página: é tarefa curta e volta à Ganhos já atualizada.

```
H1 Importar comissões
Loja  (radiogroup .seg): Shopee | Amazon | Mercado Livre
Dica da loja (texto curto: onde baixar e formato aceito, ex.: "No portal Shopee Afiliados, em Relatórios > Conversão, exporte em CSV.")
Arquivo [escolher arquivo]  (.csv; até 5 MB **[A alinhar com o plano: limite e tipos]**)
[Cancelar] [Importar arquivo]
```
`Importar arquivo` desabilitado até haver loja e arquivo. Arrastar e soltar é opcional; o `input type=file` nativo é sempre o caminho principal. Se o dono abre o diálogo já com loja filtrada em Ganhos, a loja vem marcada.

**Estados**

| Estado | O que a tela mostra |
|---|---|
| Vazio | campos acima; botão principal desabilitado; dica da loja visível |
| Arquivo escolhido | nome e tamanho ("comissoes-outubro.csv, 84 KB"), botão "Trocar arquivo", botão habilitado |
| Enviando | botão "Importando…" desabilitado com `aria-busy`, texto "Lendo o arquivo. Isso leva alguns segundos." `role="status"`; Cancelar continua ativo |
| Sucesso | substitui o formulário pelo resumo (abaixo), foco no título do resumo, botão "Ver em Ganhos" (`pri`) e "Importar outro arquivo" |
| Sucesso com repetidas | no resumo: "N linhas já estavam importadas e foram ignoradas" (não é erro) |
| Sucesso com linhas sem grupo | "N linhas não trazem código de rastreio ou o código não é de nenhum grupo seu. Entram no total, mas não aparecem em nenhum grupo." com link "Ver quais códigos" (lista dos códigos desconhecidos, para o dono associar) |
| Nada novo | "Todas as N linhas já estavam importadas. Nada mudou." |
| Erro de formato | mensagem abaixo; arquivo continua escolhido; dono pode trocar |
| Erro de tamanho/tipo | idem, antes de enviar quando o navegador já sabe |
| Erro de rede/servidor | "Não consegui importar agora. Nada foi salvo. Tente de novo; se repetir, veja o histórico do programa." Botão "Tentar de novo" |
| Permissão | para Operador o botão nem existe (ver Papéis); se a API recusar: "Só o Dono pode importar comissões." |

Resumo de sucesso (exemplo):
```
Importado: Shopee
312 linhas lidas
  287 novas   |   20 repetidas ignoradas   |   5 sem grupo
Período do arquivo: 01/10 a 31/10 · Comissão importada: R$ 1.284,50
Colunas que o painel não usa foram ignoradas. Dados de comprador não são guardados.
```
Números em `dl`/lista, com rótulos em texto; nada só por cor. A última importação de cada loja fica numa lista "Importações recentes" no rodapé do diálogo e na página (data, loja, nome do arquivo, novas, repetidas), para o dono saber até quando os dados vão.

### 4. Gasto com anúncios (diálogo)

Aberto por "Gasto com anúncios" em Ganhos. Duas partes:
- **Formulário**: Período (data inicial e final, `input type=date`, obrigatórias), "Vale para" (select: "Todos os grupos", cada bloco, cada grupo; uma opção por vez), Valor em reais (`inputmode="decimal"`, aceita `1.234,50`), Observação (opcional, ex.: "Meta Ads, campanha de outubro"). Botão "Salvar gasto".
- **Lista abaixo**: gastos já informados (período, vale para, valor, observação) com "Editar" e "Excluir" (confirmação). Vazio: "Nenhum gasto informado. Sem ele não dá para calcular o custo por membro novo."
- Validação, mensagens: "Escolha o período do gasto.", "A data final não pode ser antes da inicial.", "Digite o valor em reais, por exemplo 150,00.", "O valor precisa ser maior que zero.". Aviso (não bloqueia): "Já existe gasto para este período e destino. Se for o mesmo anúncio, edite o existente em vez de somar." Texto de ajuda: "Informe quanto pagou de anúncio. O painel divide pelo número de entradas no mesmo período." e como o gasto de um período longo é repartido por dia **[A alinhar com o plano: rateio por dia]**.
- Sucesso: toast "Gasto salvo" e Ganhos redesenha.

## Componentes

| Componente | Existente ou novo | Onde fica |
|---|---|---|
| `.kpi`, `.kpis`, `.seg`, `.chips`, `.card`, `.vazio`, `.barra`, `.estado-pill`, `.tabela` | Existente | `public/style.css` |
| `PERIODOS`, `V`, `fmtPct`, `dataBR` | Existente (reaproveitar; "Personalizado" é novo) | `public/paineis.js` |
| Fieldset "Códigos de rastreio" (3 campos + prévia) | Novo, uma função usada pelo bloco e pelo grupo | `public/paineis.js` (ou arquivo novo `public/ganhos.js`) |
| Coluna "Rastreio" em Grupos | Novo | `tabelaGrupos` em `public/app.js` |
| Página Ganhos, diálogos Importar e Gasto | Novo | `public/ganhos.js` (novo; carregado em `index.html` antes de `app.js`, como `relatorios.js`) |
| Indicador de cobertura | Novo (usa `.barra` e `.estado-pill`) | `public/ganhos.js` + poucas regras em `style.css` |
| Selo de loja (texto) | Novo ou reaproveitar `.chip` | `style.css` |
| Entrada de menu "Ganhos" | Novo | `public/index.html`, rota em `app.js` |

Nenhuma biblioteca de gráfico: não há gráfico no escopo. Se o plano pedir série por dia, reaproveitar o SVG `graficoBarras` com a mesma versão "Ver em tabela".

## Estados (resumo por elemento)

| Elemento | Padrão | Carregando | Vazio | Erro | Longo/inesperado |
|---|---|---|---|---|---|
| Página Ganhos | cartões e tabelas | "Carregando…" no `sub` (como a Visão Geral) | passos 1, 2 e 3 | faixa `.card` com "Não consegui carregar os ganhos. [Tentar de novo]" | nome de grupo e oferta com `overflow-wrap:anywhere` |
| Cartão | valor | "—" com `aria-busy` | "—" + motivo | "—" + motivo | valores grandes: `font-size` reduz em 375 px; R$ em milhões cabem em 2 linhas |
| Cobertura | barra + texto | esqueleto texto | "Sem envios no período." | oculto, com nota | 20 lojas improvável; hoje 3 |
| Botões | hover, foco, ativo (padrão) | "Importando…" | desabilitado até arquivo | mensagem no diálogo | — |
| Campo de código | normal | — | vazio válido (opcional) | erro inline abaixo do campo, `aria-invalid`, `aria-describedby` | máximo de caracteres informado no erro |

Validação dos campos de código (mensagens): Amazon: "O ID de rastreamento da Amazon costuma terminar em -20, como casa-20. Confira em Gerenciar IDs de rastreamento." e, se parecer só número: "Isso parece um ID de afiliado. O ID de rastreamento da Amazon tem letras e termina em -20." Shopee: "O Sub_id aceita só letras e números, sem espaços (até N caracteres)." **[A alinhar com o plano: limite]**. Etiqueta ML: selecionada de lista, sem digitação. Se o campo Amazon coincide com a tag padrão da conta: aviso suave "É a mesma tag padrão. Funciona, mas não separa este grupo dos outros."

## Textos da interface

Tudo em pt-BR, sem inglês exceto Sub_id (nome do portal).

- Menu: "Ganhos".
- Título: "Ganhos". Sub: "Quanto cada grupo rendeu, com base nas comissões que você importa dos portais."
- Botões: "Importar comissões", "Gasto com anúncios", "Importar arquivo", "Importar outro arquivo", "Ver em Ganhos", "Salvar gasto", "Salvar rastreio", "Definir", "Editar", "Limpar filtros", "Mostrar mais", "Tentar de novo".
- Erros de arquivo (cada um diz o que houve e como resolver):
  - tipo: "Este arquivo não é um CSV. Baixe o relatório do portal em CSV e tente de novo."
  - tamanho: "O arquivo tem mais de 5 MB. Baixe o relatório de um período menor (um mês por vez)."
  - vazio: "O arquivo está vazio. Confira se o período do relatório tem vendas."
  - loja errada: "Este arquivo parece ser da <loja detectada>, mas você escolheu <loja escolhida>. Troque a loja ou o arquivo." **[A alinhar com o plano: detecção]**
  - colunas: "Não encontrei a coluna de comissão (esperada: <nome>). O portal pode ter mudado o formato. Mande o arquivo de exemplo para a equipe ajustar." Sem apontar linhas com dado de comprador.
  - linhas inválidas: "N linhas foram puladas por valor ou data inválidos. As outras foram importadas." com lista de até 5 números de linha (sem conteúdo da linha).
- Estado vazio: "Ainda não há ganhos para mostrar", "Os links continuam saindo como hoje enquanto você não configurar nada."
- Cobertura: "{p}% dos envios saíram com código de rastreio ({a} de {b} links)." / "Parte dos links da {loja} saiu sem código. Configure em Blocos de análise."
- Papéis: "Só o Dono importa comissões e muda o rastreio." (dica para Operador, em `dica`).

`TIPS` novos em `public/ajuda.js` (chaves e texto; `LEIA_MAIS` aponta para o capítulo novo):
- `ganhos`: "Mostra quanto cada grupo, bloco, loja e oferta rendeu, a partir das comissões que você importa dos portais. Os números só são tão completos quanto o rastreio e as importações."
- `ganhos.cobertura`: "De todos os links enviados no período, quantos levaram um código de rastreio do grupo. Quanto maior, mais confiável o ganho por grupo. Sem código, a venda entra no total, mas não sabemos de qual grupo veio."
- `ganhos.comissao`: "Soma das comissões importadas no período e filtro."
- `ganhos.gpc`: "Comissão dividida pelos cliques do Rotacionador de Links."
- `ganhos.conversao`: "Vendas importadas divididas pelos cliques. Só faz sentido para o que passa pelo Rotacionador."
- `ganhos.custo`: "Gasto com anúncios informado por você, dividido pelas entradas nos grupos do mesmo período."
- `ganhos.importar`: "Baixe o relatório de comissões no portal da loja e envie aqui. Linhas já importadas são ignoradas. O painel não guarda nome, endereço nem telefone de comprador."
- `ganhos.gasto`: "Quanto você pagou de anúncio num período, para todos os grupos, um bloco ou um grupo."
- `rastreio`: "Código que identifica de qual grupo veio a venda. Mercado Livre: etiqueta. Amazon: ID de rastreamento. Shopee: Sub_id. O do grupo vence o do bloco; sem nenhum, o link sai como hoje."
- `rastreio.amazon`: "Crie em Associados > Gerenciar IDs de rastreamento. É diferente da tag padrão da conta, que fica em Conexões > Amazon."
- `rastreio.shopee`: "Letras e números que a Shopee devolve no relatório. Não é o ID de afiliado (só números) nem o AppID."
- `rastreio.grupo`: "Use só quando este grupo precisar de um código diferente do bloco."

Capítulo do livro: novo `public/docs/cap-ganhos.js` ("Ganhos e rastreio") **ou** seção em `cap-grupos.js`; o plano decide. Texto precisa de "Como baixar o relatório de cada loja" por loja, com caminho exato nos portais (conferir com os arquivos de exemplo do dono). README atualizado.

## Papéis

- **Dono**: tudo. Botões "Importar comissões", "Gasto com anúncios", campos de rastreio nos blocos e "Definir/Editar" nos grupos.
- **Operador**: vê a página Ganhos (cartões, tabelas, cobertura, importações recentes e gastos em leitura). **Os botões de importar e gasto não existem no DOM** (mesmo padrão de "Equipe": ausente, não desabilitado). No formulário do bloco, os três campos de rastreio ficam como texto somente leitura (`dl`: "Amazon: casa-20"); o campo de etiqueta ML do bloco segue a permissão atual (não alterar). Na coluna Rastreio de Grupos mostra os selos sem botão. Estado vazio do Operador: "Ainda não há ganhos para mostrar. Peça ao Dono para importar as comissões." sem os 3 botões, e sem link para telas que ele não pode usar. Dúvida: se o Operador deve ver valores de dinheiro; o brief (CA11) só restringe escrita, então a spec mostra. **[Pergunta em aberto 1]**
- Mudança de papel com a página aberta: seguir o padrão atual (`atualizarEstado` redesenha a página quando o papel muda).

## Acessibilidade

- WCAG 2.2 AA: textos 4,5:1, selos e barras 3:1. Usar tokens `--ok`, `--warn`, `--err`, `--primary-text`; nunca fixar hex. Verificar `--warn` (#B7791F) sobre `--surface` claro (contraste de texto pequeno limítrofe): para texto usar `--text` ao lado de um marcador `--warn`, ou conferir 4,5:1.
- Cor nunca é o único sinal: cobertura tem palavra ("Boa", "Parcial", "Baixa"), variação tem sinal "+/−" e palavra "mais/menos", lucro/prejuízo tem palavra.
- Foco: ao abrir diálogo, foco no título (`h1`, `tabindex=-1`); ao fechar, volta ao botão de origem. Ao importar com sucesso, foco no título do resumo. Ao trocar de filtro, `aria-live="polite"` anuncia "Ganhos atualizados: 30 dias, bloco Casa."
- Teclado: `.seg` de loja como `radiogroup` (setas), período e chips como botões com `aria-pressed`. Tabelas com `<caption class="sr-only">`, `scope="col"`, botão de ordenar com `aria-sort` e rótulo "Ordenar por comissão". Em mobile as tabelas viram listas mantendo a semântica (`role` correto, não `display:block` sem papel); usar o padrão de `.duas-col` já presente em `style.css`.
- Alvos: 44×44 px em 375 px (botões `.seg`, chips, "Definir", "Editar", ordenar); mínimo 24×24 px no desktop.
- Campos: `label` visível em todos; erros com `aria-invalid` e `aria-describedby` apontando para a mensagem; resumo de erros no topo do diálogo (`role="alert"`) como nos formulários atuais (`tentar`, lista `erros`).
- Campo de arquivo: `input type=file` nativo rotulado "Arquivo CSV do relatório da <loja>"; nome do arquivo escolhido em texto.
- Valores monetários e percentuais lidos por leitor de tela: `<data value="…">` opcional; não usar só ícones.
- `prefers-reduced-motion`: sem transições novas além das existentes; barra de cobertura sem animação de preenchimento.
- Tema claro e escuro: apenas tokens existentes; conferir o card de cobertura e os selos de estado nos dois temas (capturas).
- Responsivo 320 a 1280: sem rolagem horizontal da página; tabelas largas só rolam dentro de `.tabela` se a lista não couber; linhas de texto até 62ch (`.sub`).

## O que o dev precisa implementar

1. Rota e item de menu "Ganhos" (`#ganhos`, com filtros no hash), visível a Dono e Operador.
2. `public/ganhos.js`: página, cartões, cobertura, tabelas por grupo e por oferta, estado vazio (3 passos), loading, erro, ordenação, "Mostrar mais".
3. Diálogo "Importar comissões" com todos os estados da tabela (lê o resumo devolvido pela API; envio de arquivo como multipart ou corpo bruto conforme o plano). Resumo com novas, repetidas, sem grupo, período, comissão total.
4. Diálogo "Gasto com anúncios" (formulário, validação, lista, editar, excluir).
5. Fieldset "Códigos de rastreio" no `formBloco` e no diálogo de grupo; coluna "Rastreio" em Grupos; atualização do cartão de bloco; prévia "Como vai sair o link".
6. Ocultar ações de escrita para Operador (não renderizar), mostrar leitura.
7. CSS novo mínimo em `style.css` com tokens (cobertura, selo de loja, lista de cartões em 375 px); sem hex solto.
8. `TIPS`/`LEIA_MAIS` de `ajuda.js` (lista acima), capítulo do livro (`public/docs/`), README, e `FATOS` de `test/docs.test.js` para números que aparecerem (ex.: limite de arquivo, limiares de cobertura). Se o item "Ganhos" entrar no menu, procurar listas de rótulos de telas em `public/docs/` e em `cap-referencia.js`.
9. Teste de interface: o `qa` usa o Chrome headless de `test/qa-docs.test.js`; no mínimo, fumaça de `#ganhos` sem dados e com dados simulados (modo `DRY_RUN` com dados de exemplo precisa de importações e envios falsos; **[pendência para o dev/arquiteto]**).

## Arquivos de apresentação afetados

`public/index.html` (menu, script), `public/app.js` (rota, tabelaGrupos, papel), `public/paineis.js` (formBloco, cartão de bloco), `public/ganhos.js` (novo), `public/style.css`, `public/ajuda.js`, `public/docs/cap-*.js`, `README.md`. Os arquivos de `src/` (rotas de rastreio, importação, gasto, métricas) são do `dev`; o designer não toca neles.

Impacto compartilhado: `formBloco` e `tabelaGrupos` são usados por Blocos, Grupos e pelo seletor do Disparo automático (o seletor de grupos não muda). Mexer em `style.css` só por classes novas; não alterar `.kpi`, `.seg` nem `.tabela` globais.

## Perguntas em aberto

1. O Operador pode ver valores de comissão e gasto? A spec assume que sim (só escrita é restrita pelo CA11). Se o dono preferir esconder dinheiro do Operador, a página inteira fica só para o Dono.
2. Ganhos como página própria (recomendado) ou cartão dentro da Visão Geral? A spec recomenda página, com atalho opcional na Visão Geral.
3. **[Plano]** Regra de desempate para grupo em dois blocos com códigos diferentes; limite de caracteres do Sub_id; formato real das colunas dos CSV (depende dos exemplos do dono); tamanho máximo do arquivo; meta da cobertura; se "Ver envios sem código" cabe no Histórico; rateio por dia do gasto de período longo.
4. O dono quer ver "Lucro" (comissão menos gasto) ou só o custo por membro novo? Spec inclui lucro como cartão opcional.
5. Histórico de importações: basta lista das últimas (como na spec) ou o dono quer poder desfazer uma importação? Desfazer não está no brief; fora desta spec.
