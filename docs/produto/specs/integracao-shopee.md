# Especificação de UI/UX: integração da Shopee

Pedido do dono em 03/11/2026. **Rodada 1, revisada em 03/11 com o plano do arquiteto** (`docs/produto/planos/integracao-shopee.md`, seção "Alinhamento com a spec"): o link de afiliado sai pela extensão do Chrome (Link personalizado do portal, sessão do dono) e, quando a API for liberada, também pela Open API (API primeiro, extensão de reserva). Espelhamento e regras automáticas da Shopee ficam fora (entrega 2). Padrão visual, de estados e de tom herdado de `docs/produto/specs/espelhamento-amazon.md` (já implementada). Referência da API: `docs/produto/referencias/shopee-api-afiliados.md`. Só apresentação: nomes de campo, rotas e causas ficam "a alinhar com o plano" (`docs/produto/planos/integracao-shopee.md`, seção "A alinhar com o plano" abaixo). Tokens e classes: nenhum novo (`.card.conexao`, `.estado-pill`, `.aviso-impl`, `.passos`, `fieldset`, `.card-prod`, `.chat/.balao`, `nivel-*`, `dadosOferta`).

## Objetivo e usuário

Pedro (dono), no computador, com pressa, sem jargão. Quer que a Shopee funcione como o Mercado Livre e a Amazon: guardar os dados, ver se está conectada, colar um link no Disparo manual e enviar com o link dele.

Duas realidades que a tela precisa tratar bem:
1. **Hoje ele não tem acesso à API** (erro 10035; pedido enviado em 03/11, resposta em até 3 dias úteis). Não tem AppID nem senha da API. É o primeiro estado que verá: precisa entender que não é erro dele, que **já dá para disparar** (o link sai pela extensão do Chrome logada no portal de afiliados; os dados do produto é que ficam em branco para preencher à mão), o que falta para a busca automática e que o botão Testar ainda não serve.
2. **Ele já confundiu campos** (a tag da Amazon foi parar nas etiquetas do Mercado Livre). Cada identificador precisa de nome distinto, exemplo, dica de "o que não é" e validação que reconheça o engano mais provável.

Princípios: falha nunca silenciosa; nada é prometido além do que a API entrega; uma ação principal por tela; o painel nunca deixa sair um link sem comissão: se não há caminho para o link de afiliado (nem extensão on-line, nem API), Disparar fica desabilitado e diz por quê.

## Fluxo

1. **Agora (sem acesso à API):** Conexões > Shopee: guarda o ID de afiliado; deixa o Chrome logado no portal de afiliados da Shopee com a extensão recarregada; lê o aviso "Antes de usar a API" e, se quiser a busca automática de dados, pede o acesso pelo link; espera.
2. **Já funcionando:** Disparo manual > cola um link da Shopee > "Identificar" > preenche título e preço à mão (a API ainda não busca) > Disparar ou Agendar. O link sai pela extensão.
3. **Quando a Shopee liberar a API:** copia AppID e Senha da API do portal, cola nos campos, "Salvar", "Testar" e vê "Conectada". O Identificar passa a preencher os dados sozinho e o link sai pela API, com a extensão de reserva.

## Layout (mobile e desktop)

### 1. Conexões > cartão Shopee (`public/conexoes.js`)

Mesmo `.card.conexao` na grade das outras lojas (`.conexoes`, mínimo 300 px por coluna: 1 coluna em 375 px). Ordem dentro do cartão, de cima para baixo:

1. **Cabeçalho:** `<h2>Shopee</h2>` + ajuda `?` (`conexoes.shopee`) + selo `.estado-pill` (estados abaixo).
2. **Descrição** (`.desc`): "Programa de Afiliados da Shopee. O link curto de afiliado sai pela extensão do Chrome ou pela API; com a API, o painel também busca título, preço e foto do produto." (`implementada: true` vindo do servidor; o aviso "Ainda não implementado" sai.)
3. **Linha da extensão** (`.estado-linha`-like, `role="status"`, logo abaixo da descrição; vem de `extensao_online`): com texto e "✓"/"!" textuais, nunca só cor.
   - on-line: "✓ Extensão do Chrome conectada. Os links da Shopee saem por ela, com o Chrome logado no portal de afiliados."
   - off-line: "! Extensão do Chrome desconectada. Abra o Chrome com a extensão e entre no portal de afiliados da Shopee, ou ligue a API abaixo."
4. **Bloco "Antes de usar"** (`.aviso-impl`, informativo; sempre visível até `conectada`; depois recolhido em `<details>` "Como configurar"). Texto:
   - Título em negrito: "Antes de usar: deixe o Chrome pronto e, se quiser a busca automática, peça a API."
   - `<ol class="passos">`:
     1. "**Para os links:** deixe o Chrome logado no portal de afiliados da Shopee e recarregue a extensão em `chrome://extensions` (ela ganhou uma permissão nova)."
     2. "**Para buscar título, preço e foto sozinha:** peça acesso à **Open API de Afiliados** (abre em outra aba)." (link `https://affiliate.shopee.com.br/open_api`, `target="_blank" rel="noopener"`, sublinhado; segundo link, se o dono quiser: formulário de atendimento, pergunta 4 do dono.)
     3. "A Shopee responde em até 3 dias úteis. Quando liberarem, a mesma página mostra o AppID e a Senha da API. Copie os dois para os campos abaixo."
   - Frase de fechamento: "Sem a API você já dispara: só precisa preencher título e preço à mão."
   - Variante em `sem_acesso`: o título passa a "A Shopee ainda não liberou a API para a sua conta."; o passo 1 continua e a frase de fechamento continua valendo.
4. **Formulário** (`<form novalidate>`), em **dois `fieldset`** com `legend`, para separar de vez o que é identificador do que é credencial:
   - **`fieldset` "Sua conta de afiliado"**
     - Campo **"ID de afiliado"** (texto, `inputmode="numeric"`, `autocomplete="off"`, `spellcheck="false"`). Dica sempre visível (`.dica`, `aria-describedby`): "Só números. Ex.: 18328801339. É o número da sua conta de afiliado da Shopee. Vai nos seus links e define de quem é a comissão. Não é o AppID e não é a tag da Amazon." Obrigatório para o disparo (não para salvar o resto).
   - **`fieldset` "Acesso à API (AppID e Senha da API)"**
     - Linha de contexto (`.dica`) no topo do fieldset, só enquanto não houver credenciais salvas: "Estes dois só existem depois que a Shopee liberar a API. Pode deixar em branco: os links já saem pela extensão."
     - **"AppID"** (texto, numérico, `autocomplete=off`; **não é segredo**). Dica: "Número do aplicativo, mostrado na página da API de Afiliados da Shopee. Diferente do ID de afiliado."
     - **"Senha da API"** (`type=password`, `autocomplete=new-password`, com `q('conexoes.segredo')`; **o único segredo do cartão**). Placeholder com valor salvo: "•••••••• salva; digite para trocar". Dica: "A senha fica guardada no seu computador e não volta para esta tela. Deixe em branco para manter a salva."
   - Nome do campo na tela é "Senha da API" (é como o portal da Shopee chama); no registro continua `chave`. Nenhum campo é preenchido por valor secreto vindo do servidor (`segredos_salvos` decide o placeholder). Operador: senha travada com "Só o Dono vê e troca esta chave." (`TEXTOS_CONEXOES.segredoSoDono`).
   - Em 375 px os dois `fieldset` empilham em 1 coluna. Em 1280 px o cartão continua na grade, sem mudar de largura.
5. **Ações:** `pri` "Salvar" e "Testar". **"Testar" fica desabilitado enquanto não houver AppID e Senha da API salvos** (não só "nada salvo"), com a linha de estado explicando: "Para testar, salve o AppID e a Senha da API. Eles aparecem depois que a Shopee liberar a API." (`aria-describedby` do botão aponta para esta linha, como hoje.) "Testar" testa só a API; a extensão tem a sua linha própria (item 3).
6. **Linha de estado** (`.estado-linha`, `role="status"`).

**Validação no cliente** (antes de enviar; erros por `mostrarErros`, foco no primeiro inválido, nunca repete o valor digitado):
- ID de afiliado com letras ou traço (ex.: `seunome-20`): "O ID de afiliado da Shopee tem só números. O que você digitou parece uma tag da Amazon: ela vai em Conexões > Amazon." (sem ecoar o valor).
- ID de afiliado fora do formato (só números, 5 a 20 dígitos): "ID de afiliado: use só números, como 18328801339."
- AppID com letras: "AppID: use só números."
- **AppID igual ao ID de afiliado é recusado** (erro de campo, foco no AppID; o servidor também devolve 400 e a mesma frase vale como `mostrarErros` do servidor): "O AppID e o ID de afiliado são números diferentes. Confira os dois no portal da Shopee."
- Senha da API: formato inválido: "Senha da API: formato inválido. Confira se copiou o valor inteiro, sem espaços." (`TEXTOS_CONEXOES.formatoSegredo`).
- Limites (`max`, `padrao`) vêm do registro do servidor (`GET /conexoes → campos`): `id_afiliado` `^[0-9]{5,20}$`, `app_id` `^[0-9]{1,20}$`, `chave` segredo.

**Selo e estados do cartão** (texto sempre visível, classes de `.estado-pill` existentes). O servidor manda `estado` (seis valores), `situacao` e `extensao_online`; o painel mapeia como em `pillConexao`:

| `estado` | Selo | Classe | Quando |
|---|---|---|---|
| `falta_configurar` | Falta configurar | `falta` | nenhum ID de afiliado salvo |
| `so_id` | Só com o ID | `pronta` se `extensao_online`, senão `pendente` | ID salvo, sem AppID ou sem senha. **É o que o dono vê hoje.** Os links saem pela extensão |
| `sem_acesso` | Sem acesso à API | `pendente` | credenciais salvas, último teste voltou 10035 |
| `pronta` | Credenciais salvas | (neutro) | ID e credenciais salvos, ainda não testados |
| `conectada` | Conectada | `conectado` | último teste aceito |
| `erro_credencial` | Credencial recusada | `erro` | último teste voltou 10020 (ou 10031–10034/11002, ver abaixo) |

Observações:
- `so_id` não é erro nem espera: com a extensão on-line já dá para disparar. A linha da extensão (item 3) e o aviso "Antes de usar" explicam o que falta para a busca automática.
- `sem_acesso` e `erro_credencial` também não bloqueiam o disparo se há extensão on-line (o painel cai para a extensão).
- Credenciais salvas sem ID de afiliado: selo `pronta`, mas com a linha de estado em aviso: "Falta o ID de afiliado. Sem ele os links não saem." (Disparo manual segue a mesma regra, seção 2.)
- A falha da última verificação continua visível ao recarregar, em texto na `.estado-linha` (como na Amazon, `p.situacao.motivo`), não só no selo.
- Nota "Há N regras usando…" da Amazon **não se aplica** (a Shopee não espelha nesta entrega).

**Resultado do "Testar"** (`role="status"`, texto fixo da tela por `resultado`; nenhuma frase repete ID, AppID ou chave; sucesso com "✓" e `nivel-ok`, falha em `.aviso`):
- `ok`: "Credenciais aceitas pela Shopee."
- `recusada` (10020): "A Shopee não aceitou o AppID ou a Senha da API. Confira se copiou os dois por inteiro, sem espaços, se o aplicativo está ativo no painel de afiliados e se a data e a hora do computador estão certas."
- `sem_acesso` (10035): "A Shopee ainda não liberou a API para a sua conta. Peça o acesso pelo link acima e tente de novo quando eles responderem. Enquanto isso os links continuam saindo pela extensão."
- `conta_restrita` (10031 a 10034 e 11002): "A Shopee recusou o acesso desta conta (acesso negado, ID de afiliado inválido, conta com restrição ou credenciais de outra conta). Fale com o suporte de afiliados da Shopee." Selo: `erro` "Credencial recusada" (mesmo `erro_credencial`).
- `nao_configurada`: não chega a rodar (o botão está desabilitado); se chegar, "Salve o AppID e a Senha da API para testar."
- `cota` (10030): "A Shopee limitou as consultas por agora. Tente de novo em alguns minutos."
- `indisponivel` (rede, 5xx, relógio fora de 10 min se não for 10020): "A Shopee não respondeu agora. Tente de novo em alguns minutos."
- `sem_id` (credenciais ok, ID de afiliado vazio): sucesso parcial, em aviso: "Credenciais aceitas, mas falta o ID de afiliado."

### 2. Disparo manual (`public/disparos.js`)

Mesma página e mesmos componentes do fluxo da Amazon; muda o que acontece depois de **Identificar** com link da Shopee (formatos: `shopee.com.br/...-i.<loja>.<produto>`, `shopee.com.br/product/<loja>/<produto>`, links curtos `s.shopee.com.br`, `shp.ee`, `shope.ee`). Hoje o resultado é "Shopee identificada, mas não conectada" (`LojaNaoConectada`); passa a ser o fluxo abaixo.

1. **Resolvendo:** botão "Identificando…", `card-prod` com "Resolvendo o link…" (link curto exige redirecionamento antes da busca). Campos travados.
2. **Resultado** (`.card-prod`, `aria-live="polite"`): imagem 72×72 (`alt` = título), título, preço, chip "Shopee". Linha secundária em `.dica`: "Loja: {shopName} · {sales} vendidos · nota {ratingStar} de 5" (cada pedaço só se vier; nota sempre em texto, nunca só estrelas). Abaixo, a seção **"Dados da oferta"** (`dadosOferta`, reaproveitada, já pré-preenchida e editável), com estas diferenças para a Shopee:
   - **Preço atual:** `priceMin`. Se `priceMin` ≠ `priceMax`: nota `.dica` "Este produto tem variações de R$ {min} a R$ {max}. Usei o menor preço; ajuste se precisar." (a mensagem enviada leva um só valor.)
   - **Preço antigo:** a API **não devolve** o preço antigo, só `priceDiscountRate`; o servidor manda `oldPrice:null` e `desconto` inteiro, e não deriva preço antigo (confirmado pelo plano). O campo fica vazio e **não se inventa preço antigo** a partir do percentual (seria um número aproximado impresso para o público). `dadosOferta` ganha o parâmetro opcional `descontoInformado` (inteiro): com o preço antigo vazio, o campo Desconto (somente leitura) mostra "15%" com a dica "Informado pela Shopee." e a prévia usa esse valor. Se o dono muda o preço, o desconto informado é descartado e o campo passa a ser calculado dos dois preços (dica "Calculado dos dois preços."). Sem API (dados em branco) não há desconto informado.
   - Cupom, frete grátis, foto (trocar/remover): iguais à Amazon. Vendas (`sales`) alimenta `NUMERO_VENDAS` do template, só leitura.
3. **Prévia** (`.balao`): mostra os campos; o link da prévia é ilustrativo (`https://s.shopee.com.br/(gerado ao disparar)`); o link de verdade é gerado ao disparar ou agendar, a partir do endereço do produto sem parâmetros.
4. **Etiqueta:** o `select` de etiquetas some e entra texto fixo (`#dm-etq-shopee`): "O link curto de afiliado da Shopee é gerado na hora de disparar ou agendar, pela API ou pela extensão do Chrome, com o ID …{últimos 4 dígitos} (de Conexões > Shopee)." com link para `#conexoes`. Se a resposta traz `link_via`, uma segunda frase em `.dica`: "Vai sair pela extensão do Chrome." / "Vai sair pela API da Shopee." Máscara só por brevidade na tela; o ID não é segredo.
5. **Grupos, agendar, Disparar/Agendar:** sem mudança no layout. O link é gerado **ao clicar** (também no agendado, que guarda o link pronto): durante a geração, botão "Gerando o seu link…" travado; se falhar, nada é gravado e a mensagem do servidor aparece em `.erros` acima do botão (ver "Falhas ao disparar").

**Estados do Identificar (Shopee).** A resposta traz `causa` (dados), `causa_link` (`null`, `sem_id`, `sem_link`), `link_via` (`api`, `extensao`, `null`) e `pode_disparar`. Regra de ouro: **Disparar só fica desabilitado quando `pode_disparar` é falso**, e o `motivo` curto aparece ao lado do botão (padrão de `motivoInvalido`, `motivoSemTag` da Amazon). Falha dos dados (sem API) nunca bloqueia: vira aviso + campos em branco para preencher à mão, como na Amazon.

| Estado (`causa` / `causa_link`) | Mensagem | Seção de dados | Disparar |
|---|---|---|---|
| **Completo** (API devolveu o produto) | "Shopee · pronto para disparar" | preenchida | habilitado |
| **Parcial** (sem foto, sem vendas…) | "A Shopee não trouxe {lista}. Preencha abaixo; o que ficar vazio some da mensagem." | preenchida | habilitado |
| **Sem preço antigo** (normal da Shopee) | sem aviso: esperado; só a nota de desconto da seção 2 | preenchida | habilitado |
| `invalido` | "Não reconheci este link da Shopee. Cole o endereço do produto (shopee.com.br/…) ou um link curto, como s.shopee.com.br ou shp.ee." | não aparece | **desabilitado**: "Cole um link de produto da Shopee." |
| `nao_produto` (loja, busca, campanha) | "Este link não leva a um produto específico. Cole o link da página do produto." | não aparece | **desabilitado**: "Cole o link da página do produto." |
| `nao_encontrado` (link válido, a API não devolve o produto) | "A Shopee não encontrou este produto na API de afiliados. Ele pode não participar do programa; sem isso não há comissão. Confira o link ou escolha outro produto." | não aparece | **desabilitado**: "Produto fora do programa de afiliados." |
| `causa_link: sem_id` | "Shopee identificada, mas falta o ID de afiliado. Cadastre em Conexões." (link) | conforme os dados | **desabilitado**: "Cadastre o ID de afiliado em Conexões." |
| `causa_link: sem_link` (extensão off-line **e** API sem uso) | "Não tenho como gerar o seu link de afiliado agora. Abra o Chrome com a extensão e entre no portal de afiliados da Shopee, ou ligue a API em Conexões." + "Ir para Conexões" | conforme os dados | **desabilitado**: "Falta um caminho para o link: Chrome com a extensão ou API." |
| `sem_credenciais` (API não configurada) | "A busca automática de dados da Shopee não está ligada (faltam o AppID e a Senha da API). Preencha o título e o preço abaixo; o link já sai com o seu ID de afiliado, pelo Chrome." | **vazia**, para preencher | habilitado se título e preço válidos |
| `sem_acesso` (10035) | "A Shopee ainda não liberou a API para a sua conta. Preencha o título e o preço abaixo; o link sai pelo Chrome." | vazia | habilitado se título e preço válidos |
| `credencial_recusada` (10020) | "A Shopee não aceitou o AppID ou a Senha da API salvos. Confira em Conexões e use “Testar”. Preencha os dados abaixo; o link sai pelo Chrome." | vazia | habilitado se título e preço válidos |
| `conta_restrita` (10031–10034, 11002) | "A Shopee recusou o acesso da API a esta conta. Fale com o suporte de afiliados da Shopee. Preencha os dados abaixo; o link sai pelo Chrome." | vazia | habilitado se título e preço válidos |
| `cota` (10030) | "A Shopee limitou as consultas por agora. Preencha à mão ou tente de novo em alguns minutos." | vazia | habilitado se título e preço válidos |
| `indisponivel` (rede, 5xx) | "Não consegui buscar os dados na Shopee agora. Preencha o título e o preço abaixo; o link já sai com o seu ID de afiliado." | vazia | habilitado se título e preço válidos |

Nos cinco avisos de API, o trecho "o link sai pelo Chrome" vira "o link sai pela API" se `link_via` for `api` (a API serve ao link mas não ao dado, caso raro) e some se `link_via` for `null` (aí vale `sem_link`, que bloqueia). O texto final é montado pelo painel a partir de `causa` + `link_via`, em constantes. Aviso em `--warn` com "!" textual, `aria-live="polite"`.

**Falhas ao disparar** (o link é gerado no criar; erro do servidor, 400, nada gravado; exibido por `mostrarErros`, texto que o servidor manda, sem repetir ID nem credencial):
- Chrome em outra conta de afiliado: "O Chrome está logado em outra conta de afiliado da Shopee. Entre na conta do ID …{últimos 4 dígitos} e tente de novo."
- Sem sessão no portal: "Não há sessão de afiliado da Shopee neste Chrome. Entre no portal de afiliados e tente de novo."
- A Shopee recusou o link ou não respondeu: "A Shopee não gerou o seu link agora. Tente de novo em alguns minutos."
Os textos exatos são do servidor (mensagens fixas do plano); a tela só garante o lugar e o foco. Ao falhar, os dados editados ficam intactos.

Editar o link depois de identificar limpa resultado e dados; com dados editados à mão, pergunta "Descartar os dados editados?" (mesma regra e função da Amazon).

### 3. Ajuda e glossário (`public/ajuda.js`)

Ver "Textos da interface". Atualizar as quatro menções "Shopee, Magalu e Facebook ainda não" (`manual.link`, `conexoes`, dica do cartão "Disparo manual", passo do cartão "Conexões") para "Mercado Livre, Amazon e Shopee funcionam; Magalu e Facebook ainda não".

## Componentes

| Componente | Existente ou novo | Onde fica |
|---|---|---|
| `.card.conexao`, `.estado-pill` (`falta`, `pendente`, `pronta`, `conectado`, `erro`), `.aviso-impl`, `.passos`, `fieldset/legend`, `.dica`, `.estado-linha` | Existentes | `style.css` |
| Cartão com **dois `fieldset`** (conta de afiliado / acesso à API) | Novo arranjo de existentes (`fieldset` já estilizado); sem CSS novo | `conexoes.js` (`cartaoConexao`) |
| Bloco "Antes de usar" com `.passos` dentro de `.aviso-impl` e linha da extensão (`extensao_online`) | Novo arranjo; se o `ol` ficar sem recuo/legível dentro do aviso, 1 regra mínima em `style.css` | `conexoes.js` |
| `pillConexao`, `aplicarConexao`, `ligarConexao`, `TEXTOS_CONEXOES` | Existentes; generalizar o ramo `id === 'amazon'` para uma tabela por loja (`amazon`, `shopee`) | `conexoes.js` |
| `dadosOferta` | Existente; **extensão**: parâmetro opcional `descontoInformado` e nota de faixa de preço | `disparos.js` |
| `TEXTOS_DISPAROS.shopee` (espelha `amazon`) | Novo, em constante | `disparos.js` |
| Regex de foto `DISP_IMG_SHOPEE` + CSP `img-src` | Novo (a confirmar host da imagem com a resposta real da API) | `disparos.js`; **CSP está no servidor: pendência** |
| `TIPS`, `AJUDA`, glossário | Existentes, novos verbetes | `ajuda.js` |

## Estados

**Conexões > Shopee:** carregando ("Carregando as outras lojas…", existente), salvo ("Dados salvos em …"), "Salvando…", "Testando…" (botão travado, `role=status`), os seis selos (com `so_id` em duas cores conforme a extensão), a linha da extensão on-line/off-line, os resultados de teste acima, erro de validação por campo (incluindo AppID igual ao ID), Operador sem permissão (senha travada). Segredo vazio ao salvar mantém o salvo; ID de afiliado vazio ao salvar apaga (como texto das outras lojas).

**Disparo manual:** resolvendo, completo, parcial, faixa de preço, as 14 linhas da tabela da seção 2, "Gerando o seu link…" e as três falhas ao disparar; depois, enviado, agendado e erro de envio como hoje. Conteúdo longo: título com até 200 caracteres (mesmo limite da Amazon), `shopName` com reticências e `title`.

## Textos da interface

Em constantes (`TEXTOS_CONEXOES`, `TEXTOS_DISPAROS.shopee`), não soltas no componente. Os textos finais estão nas seções 1 e 2; lista dos rótulos e do resto:

- **Rótulos:** "ID de afiliado", "AppID", "Senha da API"; legends "Sua conta de afiliado" e "Acesso à API (AppID e Senha da API)".
- **Selos:** Falta configurar, Só com o ID, Sem acesso à API, Credenciais salvas, Conectada, Credencial recusada. Linha da extensão: "Extensão do Chrome conectada…" / "Extensão do Chrome desconectada…".
- **Botões:** Salvar, Testar, Salvando…, Testando…, Identificar, Gerando o seu link…, Ir para Conexões, Trocar foto, Remover foto.
- **Link externo:** "Open API de Afiliados (abre em outra aba)" → `https://affiliate.shopee.com.br/open_api`.
- **Sucesso:** toast "Shopee: dados salvos" (padrão de `aviso(`${nome}: dados salvos`)`).

**Verbetes novos de `TIPS`:**
- `conexoes.shopee`: 'O link curto de afiliado da Shopee sai pela extensão do Chrome logada no portal de afiliados e, quando houver acesso, pela API. A API (pedida na Shopee, resposta em até 3 dias úteis) busca também título, preço e foto. Sem a API você preenche título e preço à mão.'
- `conexoes.shopee.id`: 'O número da sua conta de afiliado da Shopee (só números). Vai nos seus links e define de quem é a comissão. Não é o AppID nem a tag da Amazon.'
- `conexoes.shopee.appid`: 'Número do aplicativo da API, que a Shopee mostra depois de liberar o acesso. Não é segredo, mas é diferente do ID de afiliado: o painel recusa os dois iguais.'
- `conexoes.shopee.senha`: 'Senha da API de afiliados da Shopee. Equivale a uma senha: fica guardada no seu computador e não volta para esta tela.'
- `conexoes.shopee.extensao`: 'Os links da Shopee saem pela extensão do Chrome. O Chrome precisa estar aberto e logado no portal de afiliados da Shopee (affiliate.shopee.com.br), e a extensão recarregada em chrome://extensions depois de atualizar.'
- `manual.shopee`: 'Cole um link da Shopee (da página do produto ou curto, como s.shopee.com.br ou shp.ee). O painel gera o seu link de afiliado ao disparar (pela extensão do Chrome ou pela API). Com a API, busca também os dados; sem ela, preencha título e preço à mão. A Shopee não informa o preço antigo, só o desconto.'

**Edições em verbetes existentes:**
- `manual.link`: "…Mercado Livre, Amazon e Shopee geram link de afiliado; Magalu e Facebook ainda não."
- `conexoes` e dica do cartão "Disparo manual" (`AJUDA`): mesma troca. `manual.etiqueta`: acrescentar "Na Shopee, vale o ID de afiliado de Conexões."
- Cartão `AJUDA` "Conexões", passo da Shopee: "Shopee: cadastre o seu ID de afiliado (só números), deixe o Chrome logado no portal de afiliados da Shopee e recarregue a extensão: os links já saem por ela. Para o painel buscar título, preço e foto, peça acesso em affiliate.shopee.com.br/open_api; quando a Shopee liberar, cole o AppID e a Senha da API e clique em “Testar”." Trocar "Shopee, Magalu e Facebook estão como 'ainda não implementado'" por "Magalu e Facebook estão como…". Dica: acrescentar "Cada campo tem um nome diferente: ID de afiliado da Shopee, tag da Amazon e etiquetas do Mercado Livre não são intercambiáveis."
- Cartão `AJUDA` "Disparo manual": passo "Para a Shopee, cole o link do produto: o painel gera o seu link de afiliado ao disparar. Se a busca de dados não estiver ligada, preencha título e preço à mão."
- **Glossário** (novos): "ID de afiliado" ('Número da sua conta de afiliado da Shopee (ex.: 18328801339). Vai no link e define de quem é a comissão. Fica em Conexões > Shopee.'), "AppID e Senha da API" ('Dados do aplicativo da API de afiliados da Shopee. Só existem depois que a Shopee libera o acesso. A senha equivale a uma senha de banco: fica no seu computador.'), "Open API de Afiliados" ('Acesso técnico da Shopee que permite ao painel buscar dados do produto e gerar links pela API. É preciso pedir; a conta não vem com ele. Sem ele, os links saem pela extensão do Chrome.'). Atualizar "Loja conectada": "Hoje Mercado Livre, Amazon e Shopee funcionam de fato."

## Acessibilidade

- **Teclado e foco:** ordem do DOM = ordem visual (descrição, linha da extensão, aviso, fieldset da conta, fieldset da API, ações). Foco visível herdado; links do aviso focáveis e sublinhados. Enter no campo de link aciona "Identificar" (como hoje). Ao disparar com falha, foco no primeiro erro de `.erros`.
- **Rótulos:** todo campo com `label` visível; `fieldset/legend` nomeiam os dois grupos; dicas ligadas por `aria-describedby`; "Testar" desabilitado ligado à frase que explica por quê (`aria-describedby`). Imagem do produto com `alt` = título; "Ir para Conexões" é link, com texto próprio.
- **Anúncios:** resultado do teste, linha de estado, resultado do Identificar e estados de resolução em `role="status"`/`aria-live="polite"`; erros de campo em `.erros` (`role="alert"`, foco no primeiro inválido).
- **Cor nunca sozinha:** cada estado do selo e cada falha tem palavra; aviso com "!" textual; nota da loja em texto ("nota 4,8 de 5", não só estrelas).
- **Contraste:** reusar as classes existentes (`--text` sobre fundo tingido, `--warn` com borda; já conferidas nos dois temas). Não usar `--warn` puro para texto.
- **Alvos:** botões, "Testar" e links de ação com 44 px em ≤ 600 px; o link do passo 1 com altura de linha suficiente (24 px mínimo).
- **Link externo:** "(abre em outra aba)" no texto visível, `rel="noopener"`.
- **Responsivo:** 320 px sem rolagem horizontal; o ID de 11 dígitos e o AppID não quebram o layout (`min-width:0` na grade já existe); linhas de texto dos avisos até ~65 caracteres.
- **Movimento:** nada novo animado.
- **Privacidade na tela:** a Senha da API nunca em HTML, atributo, `title`, toast nem mensagem de erro (só ela é segredo; o AppID e o ID de afiliado são texto). O ID de afiliado só aparece mascarado (últimos 4) fora do cartão de Conexões. Nenhuma tela mostra cookies, assinatura ou o `longLink` do portal.

## O que o dev precisa implementar

1. `conexoes.js`: `implementada: true` da Shopee tira o aviso genérico; tabela de apresentação por loja (Amazon e Shopee) substituindo os `id === 'amazon'`; linha da extensão (`extensao_online`), bloco "Antes de usar" com `.passos` e `<details>`; dois `fieldset`; selo de seis estados (`so_id` por `extensao_online`) e mensagens de teste por `resultado`; "Testar" desabilitado sem AppID e Senha da API salvos; validação no cliente do ID, do AppID e de AppID = ID.
2. `disparos.js`: fluxo Shopee do Identificar guiado por `causa`, `causa_link`, `link_via` e `pode_disparar` (tabela da seção 2), "Gerando o seu link…" e erros do criar em `.erros`, `TEXTOS_DISPAROS.shopee`, texto fixo da etiqueta, `descontoInformado` em `dadosOferta`, regex de foto da Shopee.
3. `ajuda.js`: verbetes, cartões e glossário listados acima.
4. `style.css`: só se o `ol` no `.aviso-impl` ficar ruim. Se mexer, conferir Conexões, Disparo manual e Disparo automático em 375 e 1280 px.
5. Verificação visual obrigatória dos estados que o dono verá: `so_id` (com extensão on-line e off-line), `sem_acesso` e `conectada`, e do Identificar com `sem_credenciais` (campos em branco) e `sem_link` (Disparar desabilitado), em 375 e 1280 px, nos dois temas.

## Arquivos de apresentação afetados

`public/conexoes.js`, `public/disparos.js`, `public/ajuda.js`, `public/style.css` (se necessário). Hoje há mudanças não commitadas nesses arquivos (espelhamento da Amazon): implementação só depois de commitadas, ou com um único dono dos arquivos por vez. Fora da apresentação (pendência para o dev): CSP `img-src` para o CDN de imagens da Shopee; registro da Shopee em `src/lojas.js` (campo do ID, `implementada`, `estado`, `situacao`).

## Alinhamento com o plano (respondido)

Respostas da seção "Alinhamento com a spec" de `docs/produto/planos/integracao-shopee.md`, já aplicadas acima:

| Ponto | Resposta e efeito na spec |
|---|---|
| 1. Link só pela API? | Não: pela extensão (Link personalizado) ou pela API (API primeiro, extensão de reserva); nunca montado à mão. `sem_credenciais`, `sem_acesso`, `credencial_recusada` e `conta_restrita` viram "aviso + preencha à mão". Só bloqueiam `invalido`, `nao_produto`, `nao_encontrado`, `sem_id` e `sem_link`. Textos "sem API não há link" removidos. |
| 2. Preço antigo e desconto | `oldPrice:null` e `desconto` inteiro; o desconto informado cai se o dono muda o preço. Aplicado na seção 2. |
| 3. Causas | Nomes mantidos; `sem_id` e `sem_link` vêm em `causa_link`; no lugar de `link_gerado` vêm `link_via` e `pode_disparar`. |
| 4. Estados e teste | Seis estados mais `extensao_online`; teste: `ok`, `nao_configurada`, `recusada`, `sem_acesso`, `conta_restrita` (inclui 11002), `cota`, `indisponivel`, `sem_id`. AppID igual ao ID de afiliado: 400 no servidor. |
| 5. Campos | `id_afiliado` (`^[0-9]{5,20}$`), `app_id` (`^[0-9]{1,20}$`), `chave` (segredo, exibida como "Senha da API"). |
| 6. Produto fora do programa | `nao_encontrado` bloqueia. O formulário de atendimento entra como segundo link no passo 2 do aviso (só se o dono quiser, ver pergunta 4 abaixo). |
| 7. Dados ao navegador | `produto` e `extra:{loja_nome, nota, preco_max}`; foto só de `*.susercontent.com`/`cf.shopee.com.br` (a confirmar na primeira resposta real). |
| 8 e 9. Sub IDs; limite de 8000/h | Fora desta entrega; sem contador. |

Ainda para o dev (fora da apresentação): extensão recarregada pelo dono depois da etapa da extensão (permissão nova `affiliate.shopee.com.br`); CSP `img-src` com os hosts da foto.


## Perguntas em aberto (dono)

1. Onde ele acha o ID de afiliado na Shopee? A dica diz só "número da sua conta de afiliado"; se ele mostrar o caminho exato (menu/página), entra no texto.
2. Quer um lembrete "Pedido enviado em 03/11" no cartão? Precisaria de um campo salvo (fora desta spec); o texto "responde em até 3 dias úteis" já cobre a espera.
3. Quer uma defesa do outro lado do mesmo erro (impedir ID numérico de 11 dígitos nas etiquetas do Mercado Livre, e tag da Amazon nas etiquetas)? É validação do painel do Mercado Livre, fora do pedido; posso especificar à parte.

4. Quer linkar também o formulário de atendimento da Shopee (`help.shopee.com.br/portal/webform/…`) no passo 2 do aviso, já que a página `open_api` está com "Aplicar" desabilitado nesta conta? (O plano sugere linkar.)
5. (do plano) O link deve ir pela API sempre que ela funcionar, com a extensão de reserva, ou sempre pela extensão? A tela mostra "Vai sair pela extensão/pela API" conforme `link_via`; a decisão só muda esse texto.
6. (do plano) Produto que a API diz "não encontrado": bloquear Disparar (assumido) ou deixar sair pela extensão mesmo assim? Mudando, a linha `nao_encontrado` da tabela vira "aviso + preencha à mão".
