# Especificação de UI/UX: integração da Magalu

Pedido do dono (06/11/2026): "implementar a integração com a Magalu". Não há brief. **Rodada 1, alinhada com o plano do arquiteto** (`docs/produto/planos/integracao-magalu.md`, seção "Alinhamento com a spec"). Modelo: `docs/produto/specs/integracao-shopee.md`. Tokens e classes: nenhum novo (`.card.conexao`, `.estado-pill`, `.aviso-impl`, `.dica`, `.estado-linha`, `.card-prod`, `.balao`, `dadosOferta`).

Decisões do plano que moldam a tela: o link de afiliado é montado com o nome da loja de parceiro (sem API, senha nem extensão); **o painel não lê título, preço nem foto da Magalu** (a página é bloqueada para o servidor), então o dono sempre preenche; sem verificação da loja no servidor; sem rastreio por grupo; entram Disparo manual e Remetente (Catálogo e regras automáticas ficam fora).

## Objetivo e usuário

Pedro (dono), no computador, com pressa, sem jargão. Hoje salva o nome da loja de parceiro (Magazine Você) e nada acontece. Quer colar um link da Magalu no Disparo manual (ou receber de um sócio pelo Remetente) e enviar com o link dele.

Duas realidades que a tela precisa explicar sem jargão:
1. **Só existe um dado: o nome da loja.** Sem API nem senha. Erro de digitação gera link válido na forma, mas de outra loja (a comissão não vem para ele). A tela ajuda a conferir o nome.
2. **O painel não lê o produto.** Não é falha passageira: é o estado normal. Título e preço são sempre preenchidos à mão; foto só por upload. O texto precisa dizer isso com naturalidade, sem soar como erro.

Princípios: falha nunca silenciosa; o painel nunca deixa sair link sem a loja do dono (sem nome salvo, Disparar fica desabilitado e diz por quê); uma ação principal por tela.

## Fluxo

1. Conexões → Magalu: escreve o nome da loja, "Salvar", "Conferir minha loja" (abre a loja em outra aba) e vê o selo "Configurada".
2. Disparo manual: cola o link da Magalu, "Identificar", preenche título e preço (foto é opcional, por upload), escolhe grupos e template, "Disparar" ou "Agendar".
3. Remetente: o link que o sócio manda sai com a loja do dono. Sem loja salva, o cartão do remetente avisa.
4. Histórico: "Enviado pela Magalu, com a sua loja de parceiro".

## Layout (mobile e desktop)

### 1. Conexões → cartão Magalu (`public/conexoes.js`)

Mesmo `.card.conexao` na grade das outras lojas (1 coluna em 375 px). Ordem:

1. **Cabeçalho:** `<h2>Magalu</h2>` + ajuda `?` (`conexoes.magalu`) + selo `.estado-pill`.
2. **Descrição** (`.desc`, vem de `src/lojas.js`): "Parceiro Magalu (Magazine Você): o link de afiliado sai com o nome da sua loja de parceiro. A Magalu não deixa o painel ler o produto: título, preço e foto você preenche no Disparo manual." (igual ao plano, etapa 2). O aviso "Ainda não implementado" sai. Sem bloco "Antes de usar": há um campo só.
3. **Formulário** (`<form novalidate>`), um campo:
   - **"Nome da sua loja"** (texto, `autocomplete="off"`, `spellcheck="false"`, `autocapitalize="none"`) + `?` (`conexoes.magalu.loja`). Dica sempre visível (`.dica`, `aria-describedby`): "É o trecho que vem depois de magazinevoce.com.br/ no endereço da sua loja. Se o endereço é magazinevoce.com.br/minhaloja, escreva minhaloja. Só letras, números, hífen e _."
4. **Ações:** `pri` "Salvar" e, no lugar de "Testar", o link **"Conferir minha loja (abre em outra aba)"** (`<a target="_blank" rel="noopener">` para `https://www.magazinevoce.com.br/<loja salva>/`; só com o nome **salvo**, nunca o digitado; href montado só se o nome casa a regex, com `encodeURIComponent`). Sem loja salva o link não existe e a linha de estado diz "Salve o nome da loja para poder conferir." Não há botão "Testar" nem verificação no servidor: o painel não tem como saber se a loja existe; quem confere é o dono, olhando a página dele.
5. **Linha de estado** (`.estado-linha`, `role="status"`): "Dados salvos em …" / "Nada salvo ainda." (existentes). Em `pronta`, acrescenta em `.dica`: "O painel não consegue confirmar que o nome existe: use “Conferir minha loja”."

**Validação no cliente** (antes de enviar; `mostrarErros`, foco no primeiro inválido, nunca repete o valor). O servidor aplica `^[A-Za-z0-9_-]{2,60}$`:
- Vazio ao salvar: apaga; o selo volta a "Falta configurar".
- Endereço colado (contém `/`, `.` ou `http`): "Escreva só o nome da loja, sem o endereço. Se o endereço é magazinevoce.com.br/minhaloja, escreva minhaloja."
- Espaço ou acento: "O nome da loja não leva espaços nem acentos. Copie do endereço da sua loja, depois de magazinevoce.com.br/."
- Tamanho: "O nome da loja tem de 2 a 60 caracteres."
- Outro caractere: "Use só letras, números, hífen ou _ no nome da loja."
- Recusa do servidor (`erro` do registro): "Escreva só o nome da loja (o trecho depois de magazinevoce.com.br/), com letras, números, hífen ou _." (mostrada por `mostrarErros`, sem eco).

**Selo** (texto sempre visível; `estado` do servidor):

| `estado` | Selo | Classe | Quando |
|---|---|---|---|
| `falta_configurar` | Falta configurar | `falta` | nenhum nome salvo |
| `pronta` | Configurada | `pronta` | nome válido salvo |

Sem "Conectada": o painel só afirma o que sabe (o nome está salvo e é válido na forma). "Configurada" já é a grafia do selo genérico `pronta` (`test/catalogo-conexoes-painel.test.js` linha 119): **nada novo em `pillConexao`**.

### 2. Disparo manual (`public/disparos.js`)

Mesma página e componentes do fluxo da Amazon sem API ("dados à mão"). Reconhece `magazineluiza.com.br`, `magazinevoce.com.br`, `magalu.com`, e os curtos `divulgador.magalu.com`, `maga.lu` e `magazineluiza.onelink.me`. Hoje o resultado é "Magalu identificada, mas ainda não está conectada." (`lojaNaoConectada`); passa a ser o fluxo abaixo (o `lojaNaoConectada` continua só para o Facebook).

1. **Identificando / Resolvendo:** botão "Identificando…"; para link curto, `card-prod` "Resolvendo o link…" (pode demorar); campos travados.
2. **Sem leitura (estado normal):** não há `card-prod` com foto, título e preço lidos. Aparece uma linha informativa em `.dica`, `aria-live="polite"`, sem "!" e sem `--warn` (não é falha): **"A Magalu não deixa o painel ler o produto. Preencha o título e o preço abaixo; o link já sai com o nome da sua loja."** Abaixo, "Dados da oferta" (`dadosOferta`) **em branco e editável**: título (obrigatório), preço, preço antigo, cupom, frete grátis e **foto por upload** (Trocar/Remover foto como na Amazon). O campo Desconto é calculado dos dois preços; sem preço antigo, some da mensagem.
   - **Dica do campo Preço** (`.dica`): "Use o preço que aparece na página da Magalu."
3. **Link de outra loja de parceiro** (`outra_loja: true`), informativo, sem bloquear, em `.dica` junto da linha do item 2: "O link que você colou é de outra loja de parceiro. O envio sai com a sua loja, não com essa." Não ecoa o nome da outra loja.
4. **Prévia** (`.balao`): o `texto` do servidor (template com o link real: `https://www.magazinevoce.com.br/{loja}/…`, nome público, sem máscara). Legenda: "Mostra os dados acima. O link de afiliado leva o nome da sua loja."
5. **Etiqueta:** o `select` some e entra texto fixo (`#dm-etq-magalu`, nos moldes de `#dm-etq-shopee`): "O link da Magalu leva o nome da sua loja de parceiro, {loja} (de [Conexões](#conexoes) → Magalu). A Magalu não separa os ganhos por grupo." (a segunda frase é a única menção ao rastreio; `loja_parceiro` vem do servidor e passa por `esc`.)
6. **Grupos, agendar, Disparar/Agendar:** sem mudança. O link é montado sem rede, na hora do envio, com a loja salva então: sem "Gerando o seu link…". Se a loja foi apagada entre agendar e enviar, o Histórico mostra erro (texto do servidor) e nada sai.

**Contrato do Identificar para a Magalu:** `{ editavel:true, produto|null, causa: null|'invalido'|'nao_produto', causa_link: null|'sem_loja', loja_parceiro, outra_loja, pode_disparar, texto }`, com `pode_disparar = !!produto && !causa_link`. **Disparar só fica desabilitado quando `pode_disparar` é falso**; além disso, os campos do próprio formulário (título obrigatório, preço válido) travam o botão com o motivo existente de `dadosOferta`/`motivoInvalido`. Nenhum estado de leitura: `produto` presente = link de produto reconhecido, dados em branco.

| Estado | Mensagem | Seção de dados | Disparar |
|---|---|---|---|
| **Sem leitura** (`produto`, sem `causa`/`causa_link`) | linha do item 2 | em branco, editável | habilitado com título (e preço, se preenchido) válidos |
| `invalido` (inclui link curto que não resolveu) | "Não reconheci este link da Magalu. Cole o endereço da página do produto (magazinevoce.com.br/… ou magazineluiza.com.br/…). Se era um link curto, abra-o no navegador e copie o endereço da página." | não aparece | **desabilitado**: "Cole um link de produto da Magalu." |
| `nao_produto` (home, vitrine, busca, categoria) | "Este link não leva a um produto específico. Cole o link da página do produto." | não aparece | **desabilitado**: "Cole o link da página do produto." |
| `causa_link: sem_loja` | "Magalu identificada, mas falta o nome da sua loja de parceiro. Cadastre em Conexões." + link "Ir para Conexões" (`#conexoes`); a linha do item 2 continua abaixo e os campos seguem editáveis | em branco, editável | **desabilitado**: "Cadastre o nome da loja da Magalu em Conexões." |

`outra_loja` soma a linha do item 3 a qualquer linha de produto. Texto final montado pelo painel em `TEXTOS_DISPAROS.magalu` (constantes), com função pura `dispMagaluVeredito` espelhando `dispShopeeVeredito`.

**Remetente** (`public/remetentes.js`, `REM_AFILIACAO`): sem nome da loja salvo, o cartão mostra a frase do plano, no mesmo lugar e estilo das de Amazon e Shopee: **"Os links da Magalu não saem: falta o nome da sua loja de parceiro. Cadastre em Conexões."** (código `sem_loja_magalu`; "Cadastre em Conexões" já com link `#conexoes` como as outras). Motivo curto do item recusado no remetente: "falta o nome da loja de parceiro da Magalu". A frase "Mercado Livre, Amazon ou Shopee" de `sem_link_de_loja` passa a "Mercado Livre, Amazon, Shopee ou Magalu". Lugares dos textos nos Docs: ver abaixo.

### 3. Histórico (`src/scheduler.js`/`src/envios.js`, texto do designer, código do dev)

- Resultado do envio (`okDe`, nível `ok`): **"Enviado pela Magalu, com a sua loja de parceiro"** (par de "Enviado pela Amazon, com a sua tag").
- **Sem `TEXTO_ESPERA.magalu`:** a Magalu não entra em fila automática nem Catálogo; não criar a chave.
- Falha de envio: sem texto novo. Erro de loja apagada e "o produto da Magalu está sem código" são frases fixas do servidor ("Falha no envio: …").

## Componentes

| Componente | Existente ou novo | Onde fica |
|---|---|---|
| `.card.conexao`, `.estado-pill`, `.dica`, `.estado-linha` | Existentes | `style.css` |
| Link "Conferir minha loja" no lugar de "Testar" | Novo arranjo de `.acoes` com `<a>`; reusar a classe de link-botão existente se houver (conferir antes de criar regra) | `conexoes.js` |
| Ramo `magalu` em `cartaoConexao`/`aplicarConexao`/validação | Novo, nos moldes de Amazon e Shopee | `conexoes.js` |
| `TEXTOS_CONEXOES.magalu`, `TEXTOS_DISPAROS.magalu`, `dispMagaluVeredito`, `#dm-etq-magalu` | Novos | `conexoes.js`, `disparos.js` |
| `dadosOferta` em branco com foto por upload | Existente (fluxo Amazon sem dados) | `disparos.js` |
| `REM_AFILIACAO.sem_loja_magalu` | Entrada nova na tabela existente | `remetentes.js` |
| `TIPS`, `AJUDA`, glossário | Existentes, novos verbetes | `ajuda.js` |

Não entram: `DISP_IMG_MAGALU` e a CSP `img-src` (foto só por upload).

## Estados

**Conexões → Magalu:** carregando ("Carregando as outras lojas…", existente), nada salvo, "Salvando…", "Dados salvos em …", selos `falta_configurar` e `pronta`, os cinco erros de validação, "Conferir minha loja" ausente e presente, nome de 60 caracteres (o link quebra com `overflow-wrap:anywhere`, sem rolagem horizontal), apagar o nome (volta a `falta_configurar`). Operador: o campo não é segredo, vale a permissão existente de Conexões.

**Disparo manual:** identificando, resolvendo (curto), sem leitura, `invalido`, `nao_produto`, `sem_loja`, `outra_loja` somado, depois enviado, agendado e erro de envio (inclui loja apagada). Conteúdo longo: título até 200 caracteres como nas outras lojas.

**Remetente:** com loja salva (nada a mostrar), sem loja salva (frase de `sem_loja_magalu`).

## Textos da interface

Em constantes, não soltos no componente. Os textos finais estão nas seções 1 a 3.

**Verbetes novos de `TIPS`** (sem promessa de leitura):
- `conexoes.magalu`: 'Programa Parceiro Magalu (Magazine Você). O link de afiliado sai com o nome da sua loja de parceiro: não há senha nem API. A Magalu não deixa o painel ler o produto: título, preço e foto você preenche no Disparo manual. O painel não consegue confirmar que o nome existe: use “Conferir minha loja”.'
- `conexoes.magalu.loja`: 'O trecho depois de magazinevoce.com.br/ no endereço da sua loja de parceiro. Se o endereço é magazinevoce.com.br/minhaloja, escreva minhaloja. Nome errado gera link de outra loja e a comissão não vem para você.'
- `manual.magalu`: 'Cole um link da Magalu (página do produto, no Magazine Você ou no site da Magalu, ou um link curto). O painel monta o seu link de afiliado com o nome da sua loja de parceiro. Ele não lê a página: preencha título e preço (foto é opcional, por upload). Se o link for de outra loja de parceiro, sai com a sua. A Magalu não separa os ganhos por grupo.'

**Edições em verbetes existentes** (`public/ajuda.js`):
- `manual.link` (linha 107): "…Mercado Livre, Amazon, Shopee e Magalu geram link de afiliado; Facebook ainda não."
- `conexoes` (linha 127): "…Mercado Livre, Amazon, Shopee e Magalu funcionam hoje; o Facebook guarda os dados para quando for implementado. O Catálogo do Etiqueta é uma fonte de ofertas, não uma loja."
- `manual.etiqueta`: acrescentar "Na Magalu, vale o nome da loja de parceiro de Conexões."
- `remetente` (linha 16): "três lojas" vira "quatro" e a lista inclui a Magalu. **Não mudar** `fonte.catalogo.loja` (linha 33, Catálogo).
- Cartões `AJUDA` "Conexões" e "Disparo manual": "Magalu e Facebook estão como 'ainda não implementado'" → "O Facebook está como 'ainda não implementado'". Passo novo em "Conexões": "Magalu: escreva o nome da sua loja de parceiro (o trecho depois de magazinevoce.com.br/) e clique em “Conferir minha loja”. Não precisa de senha." Em "Disparo manual": "Para a Magalu, cole o link do produto: o link sai com o nome da sua loja. Preencha título e preço à mão: o painel não lê a página da Magalu."
- Glossário: "Loja conectada" → "Hoje Mercado Livre, Amazon, Shopee e Magalu funcionam de fato." Verbete novo "Loja de parceiro (Magalu)": 'O nome da sua loja no Parceiro Magalu (Magazine Você). Vai no endereço do link e define de quem é a comissão. Fica em Conexões → Magalu.'
- `LEIA_MAIS`: `conexoes.magalu` → `conexoes/magalu` (formato `cap/secao` de `LEIA_MAIS_DESTINO`); `conexoes` e `manual.link` seguem como estão.

**Docs** (`public/docs/`):
- `cap-comecar.js`: quadro "Por onde começar" (linhas 133-137) ganha "Magalu | Funciona só com o nome da sua loja de parceiro. O link sai com ele; você preenche título e preço e confere a loja pelo link do cartão. | Nada a mais: não existe API." Linha 227: "Hoje Mercado Livre, Amazon, Shopee e Magalu enviam; link do Facebook é reconhecido, mas o painel avisa que a loja não está conectada." Seção nova `magalu` ("Magalu: o nome da sua loja", `onde: [[Conexões → Magalu]]`; passos: abrir o cartão, escrever o nome, salvar, conferir pelo link) com nota `erro` "Link de outra loja de parceiro: o envio sai com a sua loja" e nota `dica` "O painel não lê o produto na Magalu: título e preço são seus".
- `cap-disparos.js`: linha 115 → "Link do Facebook é reconhecido, mas o painel avisa que a loja ainda não está conectada e não envia nada. Mercado Livre, Amazon, Shopee e Magalu geram link de afiliado." Nova dica: "Na Magalu o painel não lê o produto: preencha título e preço (a foto é opcional, por upload) e envie." Linhas 346, 363 e 378 ("as três lojas", **remetente**): vira "quatro", com a Magalu. **Linha 239 não muda** (Catálogo).
- `cap-referencia.js`: linha 37 (glossário "Loja conectada") como acima; o bloco "Magalu e Facebook" (linha ~145) divide em **"Facebook"** (selo "Ainda não implementado", como hoje) e **"Magalu"** (tabela: "Falta configurar" = o nome da loja não está salvo, salve em Conexões → Magalu; "Configurada" = o nome está salvo, o painel não confirma que existe, use "Conferir minha loja"). Motivo `sem_loja_magalu` entra na tabela de motivos do remetente se ela estiver neste arquivo.
- `public/docs.js:48` e a grafia antiga a procurar em `public/docs/`: "Magalu e Facebook", "três lojas", "Mercado Livre, Amazon e Shopee", "Amazon ou Shopee".

**README** (`README.md`):
- Linha ~165: "**Hoje o Mercado Livre, a Amazon, a Shopee e a Magalu enviam.** Se o link for do Facebook, o programa reconhece e avisa que a loja **não está conectada** (ainda não implementada), sem enviar nada."
- Linha ~595: separar. "- **Magalu**: só precisa do nome da sua loja de parceiro (Magazine Você), sem senha nem API. O link sai com ele. A Magalu não deixa o programa ler o produto: você preenche título e preço no Disparo manual (foto é opcional, por upload). O programa não confirma se o nome existe: use “Conferir minha loja” no cartão." e "- **Facebook**: mostra **"ainda não implementado"**. Você já pode preencher e salvar os dados, mas nenhum envio usa essa loja ainda."
- Linhas ~21 e 523-568 (remetente): "três lojas" vira "quatro", com a Magalu. **Linhas 456 e 479 não mudam** (Catálogo e foto por CDN). Seção nova "Disparo manual com um link da Magalu" (título e preço à mão, link com a sua loja, outra loja de parceiro é substituída).
- `FATOS` de `test/docs.test.js`: nenhum número novo.

## O que não muda

- Mercado Livre, Amazon, Shopee: textos, selos e fluxos intocados. `pillConexao` não muda; `cxFraseTeste` e a validação ganham só o ramo da Magalu.
- **Catálogo e regras automáticas:** a Magalu não entra; `TEXTO_ESPERA` fica como está; README 456, docs `cap-disparos` 239 e `ajuda.js` 33 ("as três lojas" do Catálogo) não mudam.
- **Rastreio por grupo, ganhos e Dashboard:** nenhuma linha da Magalu e nenhuma frase nova no Dashboard.
- **Disparar mensagem** com prévia de link da Magalu: a recusa de sempre ("só funciona com links do Mercado Livre").
- Facebook continua "ainda não implementado", com o aviso genérico. Seletor de etiquetas do ML, templates, grupos, agendamento e a estrutura do Histórico.
- `style.css`: sem mudança, salvo ajuste mínimo de `.acoes` para o link-botão (conferir Conexões e Disparo manual em 375 e 1280 px). Nenhum token nem cor nova. Nada de `DISP_IMG_MAGALU` nem de CSP.
- Fora da apresentação (do dev): contrato do servidor, geração do link, `src/lojas.js`, `src/magalu.js`, `src/envios.js`, `src/remetentes.js`.

## Acessibilidade

- **Teclado e foco:** ordem do DOM = ordem visual (descrição, campo, ações, linha de estado). Foco visível herdado; Enter no campo salva; erro de validação leva o foco ao campo; Enter no campo de link do Disparo manual aciona "Identificar".
- **Rótulos:** `label` visível; dica por `aria-describedby`; "Conferir minha loja" é `<a>` com texto próprio e "(abre em outra aba)" visível, `rel="noopener"`; "Ir para Conexões" é link.
- **Anúncios:** linha de estado e resultado do Identificar em `role="status"`/`aria-live="polite"`; erros de campo em `.erros` (`role="alert"`).
- **Cor nunca sozinha:** selos com palavra; a linha "sem leitura" é só texto informativo (sem cor de alerta, pois não é falha); o erro de bloqueio usa o padrão existente com "!" textual.
- **Contraste:** só tokens existentes (`--text` sobre fundo tingido, `--warn` com borda, nunca `--warn` puro como texto). Link sublinhado.
- **Alvos:** botões e link-botão com 44 px em ≤ 600 px, mínimo 24 px no desktop.
- **Responsivo:** 320 px sem rolagem horizontal; endereço e nome longos quebram.
- **Movimento:** nada animado novo.
- **Privacidade:** o nome da loja é público e vai inteiro no link, sem máscara. O nome de **outra** loja de parceiro nunca aparece (só o aviso). Nada vai a log nem a console (CA9 do plano).

## O que o dev precisa implementar

1. `public/conexoes.js`: ramo da Magalu no cartão (sem aviso genérico, "Conferir minha loja" com href validado no lugar de "Testar", linha de estado, 5 frases de validação, `TEXTOS_CONEXOES.magalu`). Selos já cobertos pelo `pillConexao` genérico.
2. `public/disparos.js`: `dispMagaluVeredito` (tabela da seção 2) e `TEXTOS_DISPAROS.magalu`; `dadosOferta` em branco com foto por upload e a dica do Preço; `#dm-etq-magalu`; prévia com o `texto`; linha `outra_loja`; "Resolvendo o link…" para os hosts curtos (`maga.lu`, `magazineluiza.onelink.me`, `divulgador.magalu.com`).
3. `public/remetentes.js`: `REM_AFILIACAO.sem_loja_magalu` com a frase do plano.
4. `public/ajuda.js`, `public/docs.js`, `public/docs/cap-comecar.js`, `cap-disparos.js`, `cap-referencia.js` e `README.md`: trechos acima, no mesmo commit.
5. Textos do Histórico (`okDe`): dev do servidor, com o texto desta spec.
6. Verificação visual obrigatória (375 e 1280 px, tema claro e escuro): cartão em `falta_configurar` e `pronta`, erro de validação, Identificar "sem leitura" (campos em branco, Disparar habilitado após preencher), `sem_loja` (Disparar desabilitado), `outra_loja`, e o cartão do Remetente com `sem_loja_magalu`.

## Arquivos de apresentação afetados

`public/conexoes.js`, `public/disparos.js`, `public/remetentes.js`, `public/ajuda.js`, `public/docs.js`, `public/docs/cap-comecar.js`, `public/docs/cap-disparos.js`, `public/docs/cap-referencia.js`, `README.md`; `public/style.css` só se necessário. Testes de painel que o plano já lista (`magalu-painel.test.js`, `shopee-painel.test.js`, `remetentes-painel.test.js`, `docs.test.js`, `qa-docs.test.js`) são do dev. Conflito de arquivos entre etapas (`ajuda.js`, `test/conexoes.test.js`) já está resolvido pela ordem do plano (grupos C e D).

## Perguntas em aberto

1. **(dono, P6 do plano)** O nome da loja é mesmo o trecho depois de `magazinevoce.com.br/`? O plano nota que lojas antigas costumam ter o prefixo `magazine` (ex.: `magazinefulano`). A dica do campo e as frases de validação assumem que sim; ajusto o exemplo se o dono disser o contrário.
2. **(dono, P1 do plano)** O link longo da loja atribui a venda? Se não, a tela muda na entrega 2 (leitura e link curto pela extensão). Até lá, a dica do campo e o "Conferir minha loja" são a única defesa.
3. **(dono, P2 do plano)** Se os links curtos reais não redirecionarem com 3xx, o painel cai em `invalido` com a orientação de colar o endereço da página, já prevista no texto da tabela.
