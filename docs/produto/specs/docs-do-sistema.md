# Especificação de UI/UX: Docs do sistema (a Ajuda vira um livro com trilha)

Brief: `docs/produto/briefs/docs-do-sistema.md` (CA1 a CA8). Plano em paralelo: `docs/produto/planos/docs-do-sistema.md` (ainda não existia ao escrever; tudo marcado **[A alinhar com o plano]** depende dele).

## Objetivo e usuário

Pedro (dono), no computador, com pressa e sem jargão. Duas situações: (a) alguém novo aprende do zero seguindo uma trilha; (b) quem já usa tira uma dúvida em 30 segundos (busca, Perguntas reais, Referência, "Ler mais" dos `?`). Quem lê vem de dentro do painel, quase sempre no meio de uma tarefa.

Decisões de desenho:
- **Livro com trilha**: capítulos numerados, cada um curto (2 a 5 min), sempre com "o que você vai aprender", passos com o caminho exato e "Anterior / Próximo".
- **Dois apêndices sem número**: *Perguntas reais* e *Referência*. Não entram no progresso da trilha.
- **O conteúdo não contradiz o README.** Onde a spec cita um número, ele foi conferido no README ou em `public/ajuda.js`.
- **Nome**: item do menu "Docs"; título da página "Docs do sistema". `#ajuda` continua abrindo (alias).

## Fluxo

1. Menu → **Docs** → abre o **Início** (apresentação, mapa do sistema, "Comece pelo capítulo 1").
2. Lê o capítulo → **Próximo capítulo** (marca o atual como lido) → novo capítulo, foco no título.
3. Dúvida solta: busca no topo, ou **Perguntas reais**, ou **Referência**.
4. Dentro do painel, o `?` de um campo → clica → **Ler mais** → cai na seção certa do livro. O botão Voltar do navegador devolve à tela de origem.
5. Link direto: `#docs/<capitulo>` e `#docs/<capitulo>/<secao>`; funciona colado em outra aba (já logada).

Endereços **[A alinhar com o plano]**: hoje `ir()` em `public/app.js` corta o hash no `?` e reescreve para `#<rota>`. Para `#docs/...` o dev precisa de `rotaAtual()` e `ir()` lerem só o trecho antes de `/` como rota e manterem o resto no endereço (como já é feito com a consulta do Histórico). Alternativa aceita: `#docs?c=<capitulo>&s=<secao>`, reaproveitando o mecanismo do Histórico. Prefiro `#docs/...` por ser mais legível e compartilhável.

## 1. Arquitetura de informação

Slug = último trecho do endereço. Seção = `#docs/<capitulo>/<secao>`.

### Início (`#docs`)
Sem número. Mostra: o que é o Achadinho Turbo em 3 frases; o **mapa** (painel, WhatsApp, extensão do Chrome, lojas: quem faz o quê); como usar o livro (sumário, busca, `?`); botão "Começar pelo capítulo 1" (ou "Continuar do capítulo N" quando há progresso).

### Trilha

| Nº | Capítulo (slug) | Seções (slug) e o que cada uma ensina |
|---|---|---|
| 1 | **Primeiros passos** (`primeiros-passos`) | *Abrir o painel e entrar* (`entrar`): endereço `http://localhost:3737`, login e "Ativar login". *Conectar o WhatsApp* (`whatsapp`): ler o QR em Aparelhos conectados e achar os grupos. *Instalar a extensão do Chrome* (`extensao`): carregar a pasta `extension`, colar endereço e token, ficar logado na Central. *Seu primeiro disparo de teste* (`teste`): `npm run simular` e um disparo manual. |
| 2 | **Conexões: suas lojas** (`conexoes`) | *Mercado Livre e etiquetas* (`mercado-livre`): cadastrar a etiqueta com o nome exato. *Amazon: tag e API* (`amazon`): onde vai a tag, o que a API acrescenta, os requisitos. *Shopee: ID, AppID e Senha* (`shopee`): três dados diferentes e o caminho pela extensão. *Catálogo do Etiqueta* (`catalogo`): endereço, arquivo do token, Testar. *O que funciona sem API* (`sem-api`): quadro por loja. |
| 3 | **Templates: o texto da mensagem** (`templates`) | *Campos e prévia* (`campos`). *Linha que some sozinha* (`linha-some`). *Trecho opcional entre colchetes* (`opcional`). *Título curto ou completo* (`titulo`). |
| 4 | **Disparo manual** (`disparo-manual`) | *Mercado Livre e links meli.la* (`mercado-livre`): identificar e disparar. *Amazon* (`amazon`): a tag obrigatória e os dados editáveis. *Shopee* (`shopee`): link gerado ao disparar, produto fora do programa. *Agendar para hoje* (`agendar`). |
| 5 | **Disparo automático** (`disparo-automatico`) | *Anatomia de um disparo* (`anatomia`): etiqueta + template + fontes + grupos + ritmo. *Fontes de ofertas* (`fontes`): Central, lista de links, busca, até 5 intercaladas. *Usar o Catálogo como fonte* (`catalogo`): lojas, categorias, ordem *Novidades* e *Reler do começo*. *Ritmo e horário* (`ritmo`): quantas por envio, intervalo, janela. *Testar antes de ligar* (`testar`): *Ver ofertas* e *Enviar agora*. |
| 6 | **Espelhar ofertas da Amazon** (`espelhamento`) | *Antes de começar* (`antes`): tag, WhatsApp, grupos. *Criar um espelhamento* (`criar`). *Como escrever a mensagem de origem* (`formato`): o formato que o painel lê. *Repetidas e palavras bloqueadas* (`filtros`). *Fila: completar ou descartar* (`fila`). |
| 7 | **Revisão de ofertas** (`revisao`) | *O que espera a sua revisão* (`motivos`). *Revisar e enviar* (`revisar`): Histórico → Catálogo. *Corrigir o preço* (`preco`): por que não existe "enviar mesmo assim". *Quando o envio falha* (`reenviar`). |
| 8 | **Disparar mensagem e enquete** (`mensagens`) | *Mensagem com foto* (`mensagem`). *Enquete* (`enquete`). *Agora, agendada ou repetida* (`quando`). *Pausar e cancelar* (`pausar`). |
| 9 | **Grupos, blocos e rotacionador** (`grupos`) | *Grupos e convites* (`convites`). *Blocos de análise* (`blocos`). *Rotacionador de links* (`rotacionador`). *Próximo grupo com confirmação* (`proximo-grupo`). |
| 10 | **Resultados e avisos** (`resultados`) | *Visão Geral* (`visao`): funil, abriram, evasão. *Histórico* (`historico`): erros e avisos mais comuns. *Relatórios e avisos* (`avisos`): resumo diário, virada do dia, aviso de lotação e de erro. |
| 11 | **Equipe e papéis** (`equipe`) | *Dono e Operador* (`papeis`). *Convidar alguém* (`convidar`): o link vai pelo WhatsApp, não por e-mail. *Remover e mudar papel* (`gerir`). |
| 12 | **Privacidade e segurança** (`privacidade`) | *O que fica no seu computador* (`dados`). *Segredos nunca voltam à tela* (`segredos`). *Prazo de guarda e apagar* (`retencao`). *Avisar os membros* (`membros`). |
| 13 | **Manutenção** (`manutencao`) | *Ver o painel e atualizar* (`painel`). *Backup e restaurar* (`backup`). *Reconectar o WhatsApp* (`reconectar`). *Limpar o log antigo* (`log`). *Ajustes: pausas e limites* (`ajustes`). |

Todo capítulo segue o mesmo molde: título → "O que você vai aprender" (2 a 4 itens) → seções (h3) → *Anterior / Próximo*. Capítulos com pré-requisito ganham "Antes de começar" (lista curta com link para o capítulo exigido). Cada capítulo mostra "Leitura: N min" (palavras ÷ 200, arredondado para cima).

### Apêndice A: Perguntas reais (`perguntas`)

Índice no topo (links para cada pergunta, `#docs/perguntas/<id>`) e, abaixo, cada pergunta como h3 + resposta + linha "Onde:" com o caminho + "Ler o capítulo".

**P1. `tag-amazon`: Cadastrei a tag da Amazon e o painel diz que falta. Onde ela vai?**
No cartão da Amazon, não nas etiquetas do Mercado Livre. Onde: *Conexões → Amazon*, campo "Tag de associado" (ex.: `seunome-20`), depois **Salvar**. As etiquetas de *Conexões → Mercado Livre* são só do Mercado Livre. Sem a tag, o espelhamento não liga e o Disparo manual da Amazon fica bloqueado. Se você também usar a API, a tag precisa ser da mesma loja (Amazon.com.br) da credencial. Capítulo: 2.2.

**P2. `meli-la`: O link `meli.la` não lê o produto. Por quê?**
O `meli.la` que vem de um afiliado leva a uma página de afiliado, não à página do produto. O painel agora lê essa página e gera o seu link a partir do produto. Onde: *Disparos → Disparo manual*, cole o link e clique em **Identificar**. Se ainda assim não ler, cole o link da página do produto. Capítulo: 4.1. *(Confirmar com o dev a última frase: o README só diz que o painel lê a página do afiliado.)*

**P3. `precisa-api`: Preciso da API da Shopee e da Amazon? O Mercado Livre já funciona?**
Não precisa de API para começar. O Mercado Livre não usa API: usa a extensão do Chrome, logada na Central de Afiliados, e já funciona. A API só poupa digitação.
- **Mercado Livre**: extensão + etiqueta. Sem API.
- **Amazon**: com a tag, funciona. Sem API, os dados vêm do texto da mensagem de origem (ou você preenche). Com API: título, preço, preço antigo e foto vêm da Amazon. A API exige conta de Associados aprovada e **10 vendas qualificadas nos últimos 30 dias** na Amazon.com.br.
- **Shopee**: com o ID de afiliado e o Chrome logado no portal de afiliados, o link sai pela extensão e você preenche título e preço. Com API, o painel busca os dados. Para pedir o acesso: `affiliate.shopee.com.br/open_api` (resposta em até 3 dias úteis).
Onde: *Conexões*. Capítulo: 2.5.

**P4. `id-shopee`: Meu ID de afiliado da Shopee vai no AppID?**
Não. São três dados diferentes, cada um no seu campo de *Conexões → Shopee*:
- **ID de afiliado**: o número da sua conta (só números). Vai nos links e define de quem é a comissão. É o único obrigatório.
- **AppID**: o número do aplicativo da API. Só existe depois que a Shopee libera a API. Opcional. O painel recusa se for igual ao ID de afiliado.
- **Senha da API**: equivale a uma senha. Fica guardada no seu computador e não volta para a tela.
Capítulo: 2.3.

**P5. `catalogo`: Onde conecto o catálogo do Etiqueta?**
Em *Conexões → Catálogo do Etiqueta*: confira o endereço (padrão `http://127.0.0.1:8765`), informe o **caminho** do arquivo `api_token.txt` (nunca o conteúdo dele), clique em **Salvar** e depois em **Testar**. Para usar: *Disparo automático → Novo disparo → De onde vêm as ofertas*, escolha "Catálogo (app Etiqueta)". Só o Dono salva e testa. Capítulos: 2.4 e 5.3.

**P6. `etiqueta-desta-fonte`: "Etiqueta desta fonte" é o app Etiqueta?**
Não. É a **etiqueta de afiliado do Mercado Livre** (a criada na Central de Afiliados), por isso o painel escreve "Etiqueta ML". Ela diz de quem é a comissão dos links `meli.la` daquela fonte. O app Etiqueta aparece no painel só como "Catálogo". Onde cadastrar: *Conexões → Mercado Livre*. Veja o quadro "Cinco nomes parecidos" na Referência.

**P7. `so-catalogo`: Dá para usar só o catálogo, sem misturar com a Central de Afiliados?**
Dá. No disparo, deixe só a fonte "Catálogo (app Etiqueta)". A etiqueta do Mercado Livre só serve para gerar links do Mercado Livre. Se o Catálogo for só de Amazon e/ou Shopee (marque as lojas), a "Etiqueta ML padrão" fica opcional. Se o Catálogo puder trazer Mercado Livre (inclusive com nenhuma loja marcada, que vale por todas), a etiqueta continua obrigatória. Capítulo: 5.3.

**P8. `catalogo-links`: Os links do catálogo já são meus. Por que o Turbo gera de novo ou pede revisão?**
Porque o link curto não prova de quem é a conta. A sua comissão continua sua: o link novo leva a sua etiqueta ou tag.
- **Mercado Livre**: o painel refaz o `meli.la` pela extensão, com a etiqueta do disparo. Sai sozinho.
- **Amazon**: o link é remontado com a tag de *Conexões → Amazon*. Sai sozinho.
- **Shopee**: `s.shopee` não mostra de quem é a conta. Toda oferta da Shopee espera a sua revisão em *Histórico → Catálogo*. Aprovada, sai com o link do próprio catálogo.
Também esperam: desconto de 100%, preço antigo 10 vezes maior que o preço, e oferta cujo link não pôde ser gerado. Só o Dono revisa. Capítulo: 7.1.

**P9. `limpar-log`: Como limpo o log antigo que tem as chaves do WhatsApp?**
Num terminal comum (não precisa estar na pasta do projeto), rode o comando abaixo e digite a senha do computador. *[Comando e causa a confirmar com o dono e o dev: qual log guardava as chaves e se é o journal do sistema. Redação provisória, não publicar sem conferir.]*
```
sudo journalctl --rotate && sudo journalctl --vacuum-time=1s
```
Depois, reconecte o WhatsApp com um QR novo: no celular, *Aparelhos conectados*, desconecte o aparelho antigo; no painel, *Números de WhatsApp → Desconectar* (só o Dono) e **Conectar WhatsApp**. Quem tinha as chaves antigas perde o acesso. Capítulo: 13.3 e 13.4.

**P10. `painel-local`: Como rodo ou vejo o painel no meu computador?**
O painel roda como um serviço do computador. Abra `http://localhost:3737`. Se não abrir: `systemctl --user status achadinhoturbo` mostra se está ligado e `systemctl --user restart achadinhoturbo` reinicia. Depois de uma atualização da tela, recarregue com <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd>. Sem o serviço (Windows ou instalação simples): `npm start` ou `iniciar.bat`. Para só olhar, sem enviar nada: `npm run simular`. Capítulo: 13.1.

(Comandos de P9 e P10 usam o componente "bloco de comando".)

**Como crescer a lista:** cada pergunta é um item de `PERGUNTAS` (`id`, `pergunta`, `resposta`, `onde`, `leia`). Acrescentar uma nova não exige mexer em layout, sumário nem busca.

### Apêndice B: Referência (`referencia`)

Seções, todas consultáveis sem ler o livro:
1. **Glossário** (`glossario`): reaproveita `GLOSSARIO` de `public/ajuda.js` (hoje 34 verbetes), agrupado por tema (Lojas e afiliado; Disparos; Espelhamento e revisão; Grupos e análise; Conta e equipe). Abre com o quadro **"Cinco nomes parecidos"**: *etiqueta ML* (nome criado na Central de Afiliados; *Conexões → Mercado Livre*) × *Etiqueta, o app* (seu outro programa) × *Catálogo* (a fonte do painel que lê o app) × *tag de associado da Amazon* (`seunome-20`; *Conexões → Amazon*) × *ID de afiliado da Shopee* (só números; *Conexões → Shopee*).
2. **Estados dos cartões de Conexões** (`estados`): uma tabela por cartão (Amazon, Shopee, Catálogo; o do Mercado Livre diz o que falta), colunas "Selo", "O que significa", "O que fazer". Amazon: *Falta configurar*, *Só com a tag*, *Credencial salva*, *Conectada*. Shopee: *Falta configurar*, *Só com o ID*, *Credenciais salvas*, *Conectada*, *Sem acesso à API*, *Credencial recusada* (as duas últimas não impedem o disparo se a extensão estiver conectada). Catálogo: *Falta configurar*, *Salvo, ainda não testado*, *Conectada*, *Token recusado* (reinicie o `servidor.py` do Etiqueta), *Indisponível*, *Arquivo do token não encontrado*.
3. **Motivos de revisão e de descarte** (`motivos`): Para revisar (Shopee; desconto de 100%; preço antigo 10 vezes maior; link que falhou) e os resultados do Histórico do espelhamento (Espelhada, Descartada: palavra bloqueada, Descartada: repetida, Descartada: link não resolvido, Na fila: falta completar, Descartada: expirou sem ser completada).
4. **Limites e números** (`limites`): tabela "O quê / Valor / Onde muda":

| O quê | Valor |
|---|---|
| Fontes por disparo | até 5 (intercaladas) |
| Ritmo sugerido (grupos) | 30 a 60 min entre ciclos; pausas de 6 s entre grupos e 30 s entre ofertas |
| Mensagem / enquete / foto | 4096 caracteres; 2 a 12 opções; JPG ou PNG até 5 MB |
| Repetição e agendamento | até 6 horários por dia; agendado que perde o horário por mais de 2 h não sai |
| Não repetir (espelhamento) | 168 h (0 a 8760; 0 = pode repetir) |
| Espelhamento | 10 por hora por espelhamento; 60 links por hora por grupo de origem; até 5 links por mensagem; 50 palavras bloqueadas; fila expira em 24 h |
| Revisão | até 50 ofertas esperando por disparo; Histórico mostra as 200 mais recentes |
| Catálogo | páginas de 200 ofertas; até 20 categorias; até 10 palavras de busca; desconto mínimo de 0 a 99 |
| Amazon (API) | 10 vendas qualificadas em 30 dias; acesso volta em até 2 dias após novas vendas |
| Shopee | 60 links por hora pela extensão; link reaproveitado por 7 dias; API liberada em até 3 dias úteis |
| Rotacionador | limite máximo de 1.024 por grupo; aviso aos 95%; alternar entre até 3 grupos |
| Avisos | erro de disparo: no máximo 1 a cada 30 min; cadastro de número: 10 a cada 10 min |
| Convite | vale 7 dias e 1 uso |
| Login | sessão de 30 dias (cai com 7 dias sem uso); 5 erros bloqueiam o IP por 15 min |
| Guarda de dados | 90 dias (0 = para sempre); fotos enviadas: 7 dias sem uso; backups: os 7 mais recentes |

## 2. Layout

Tudo dentro do `main` do painel (o rail de 264 px não muda). Fonte de leitura 16 px, linha com no máximo `72ch`.

### 1280 px
- Cabeçalho: `h1` "Docs do sistema", subtítulo curto e o campo de busca à direita.
- Abaixo, grade de 2 colunas a partir de **1100 px de viewport**: sumário `260px` (fixo: `position:sticky; top:24px; max-height:calc(100vh - 48px); overflow:auto`) + conteúdo `minmax(0, 72ch)`, espaço de 32 px.
- Sumário: progresso ("3 de 13 lidos" + barra fina, ver Componentes), **Início**, lista numerada 1 a 13, depois **Perguntas reais** e **Referência** sob um separador. O capítulo aberto mostra as suas seções recuadas.
- Conteúdo dentro de `.card` (o mesmo cartão do painel), sem cartões aninhados: seções separadas por `h3` e espaço, não por caixas.

### 375 px (de 320 a 1099 px)
- Uma coluna. Busca em largura total. O sumário vira `<details>` fechado acima do conteúdo; o `summary` mostra "Sumário · cap. 5 de 13 · Disparo automático" (altura mínima 44 px). Ao escolher um capítulo, a página recarrega fechada.
- *Anterior* e *Próximo* ficam empilhados, cada um com 44 px ou mais; "Próximo" primeiro.
- Tabelas rolam na horizontal **dentro** de `.tabela` (já existe `overflow-x:auto`), nunca a página. Caminho, comando e URL quebram com `overflow-wrap:anywhere`.

### Temas
Só tokens de `public/style.css` (os temas claro e escuro já trocam sozinhos por `prefers-color-scheme`). Nada de cor fixa.

| Uso | Token |
|---|---|
| Fundo do conteúdo / sumário | `--surface` / `--surface-2` |
| Bordas | `--border` |
| Texto / texto de apoio | `--text` / `--text-2` |
| Link, item atual, número do passo | `--primary-text` (4,5:1 nos dois temas) e `--primary-tint` |
| Aviso | `color-mix(in oklab, var(--warn) 16%, var(--surface))` + borda `--warn` (mesmo padrão de `.aviso-impl`) |
| Erro comum | idem com `--err` |
| Dica | `--primary-tint` com borda `--primary-text` |
| Lido | `--ok` (✓) |
| Código e comando | `--inset`, fonte `--mono`, raio `--raio` |

O **rótulo** dos avisos ("Aviso", "Erro comum") usa `--text` em negrito, nunca `--warn` ou `--err` como cor de texto (contraste insuficiente no tema claro). A cor da borda só reforça.

## 3. Componentes

Todos novos, em `public/style.css` (seção "docs") e montados em `public/docs.js` **[A alinhar com o plano]**. Nenhuma biblioteca.

| Componente | Existente ou novo | Onde fica |
|---|---|---|
| Sumário (`nav`, lista numerada, `details` no mobile) | novo | `style.css` `.docs-toc` |
| Progresso ("N de 13 lidos", barra) | novo | `.docs-progresso` |
| Cabeçalho do capítulo (número, título, leitura) | novo | `.docs-cap` |
| "O que você vai aprender" | novo | `.docs-aprenda` |
| Passo numerado | novo | `ol.docs-passos` |
| Caminho no painel | novo | `.caminho` |
| Aviso, Dica, Erro comum | novo (variantes do mesmo bloco) | `.docs-nota` + `.docs-nota--aviso/--dica/--erro` |
| Selo "Só o Dono" | novo (reaproveita `.chip`) | `.chip.so-dono` |
| Bloco de comando com Copiar | novo | `.docs-cmd` |
| Tabela de referência | existente | `.tabela` |
| `kbd` | novo, mínimo | `kbd` |
| Anterior / Próximo | novo | `.docs-nav` |
| Busca e resultados | novo | `.docs-busca`, `.docs-resultados` |
| "Ler mais" no `?` | novo (estende `q()` e a caixa `#tip`) | `ajuda.js` |
| Link para a seção (âncora no `h3`) | novo | `.docs-ancora` |

### Detalhes

**Passo numerado.** `<ol class="docs-passos">`: número num círculo de 28 px (`--primary-tint`, texto `--primary-text`, contador CSS), texto ao lado. Um passo = uma ação. No máximo 7 passos por lista; se passar, divida em seções. Imagem não é necessária; se um passo exigir captura, ela vem com `alt` descrevendo a tela e fica fora do escopo desta entrega.

**Caminho no painel.** Marcação: `<span class="caminho"><b>Conexões</b><span class="sr-only"> depois </span><span aria-hidden="true">→</span><b>Amazon</b></span>`. Visual: negrito, `--inset`, borda `--border`, raio 8 px, padding 1×8 px, não quebra no meio de um nome (`white-space:nowrap` por segmento). Leitores de tela leem "Conexões depois Amazon". Os nomes são os do menu real, com a mesma grafia.

**Aviso / Dica / Erro comum.** `<div class="docs-nota docs-nota--aviso" role="note">` com um título em `<p class="docs-nota-t"><span aria-hidden="true">!</span> Aviso</p>` e o texto. Ícone em círculo de 20 px como em `.aviso-impl`: `!` (aviso), `i` (dica), `×` (erro comum), sempre junto da palavra. Dica = informação opcional que ajuda. Aviso = algo que pode dar errado ou ter custo (risco ao número do WhatsApp, dado pessoal). Erro comum = o sintoma que a pessoa vê, em itálico entre aspas, e depois a solução. Máximo de uma nota de cada tipo por seção, para não virar ruído.

**Bloco de comando.** `<div class="docs-cmd"><pre><code>…</code></pre><button type="button" class="leve">Copiar</button></div>`. O botão vem à direita (em 375 px, abaixo do código), 44 px de altura no celular. Ao clicar: o texto vira "Copiado" por 2 s e um `role="status"` oculto anuncia "Comando copiado". Se `navigator.clipboard` falhar: seleciona o código e mostra "Não deu para copiar. Selecione e copie (Ctrl+C)". O bloco rola na horizontal (`overflow-x:auto`) com `tabindex="0"` e `aria-label="Comando"` para dar para rolar pelo teclado. Um comando por bloco; comandos com `sudo` ganham antes uma nota "Aviso: precisa da senha do computador".

**Progresso.** Guardado no `localStorage` do navegador (chave `docs.lidos`, lista de slugs; nenhum dado pessoal). "Próximo capítulo" marca o atual como lido; há também a caixa "Marcar como lido" no fim do capítulo (checkbox nativo com rótulo). No sumário, lido = "✓" antes do número **e** texto `sr-only` "(lido)". "Limpar progresso" (botão de texto) no rodapé do sumário. O progresso é por navegador, não por pessoa da equipe; o texto "Fica salvo só neste navegador" aparece uma vez no Início.

**Anterior / Próximo.** Dois cartões-link lado a lado (empilhados no mobile): rótulo pequeno "Anterior" / "Próximo" e abaixo o número e o título do capítulo ("5. Disparo automático"). No primeiro capítulo, "Anterior" leva ao Início; no último da trilha, "Próximo" leva a *Perguntas reais* com rótulo "Continue com". Perguntas e Referência não têm Anterior/Próximo, só "Voltar ao início do livro".

**Ler mais a partir dos `?`.** Hoje o `?` mostra a dica ao passar o mouse ou focar, e some ao sair, então um link dentro dela não seria alcançável. Novo comportamento só para chaves presentes em `LEIA_MAIS` (objeto novo em `ajuda.js`, `chave → "capitulo/secao"`; `TIPS` não muda):
- hover e foco: igual a hoje (prévia sem link);
- **clique, toque ou Enter/Espaço**: a dica **fixa** e ganha, embaixo, o link "Ler mais: <título da seção> →"; o foco vai para o link; **Esc** fecha e devolve o foco ao `?`; clicar fora também fecha;
- o `#tip` fixado não some ao rolar nem ao tirar o mouse (resolve também WCAG 1.4.13: conteúdo que aparece ao passar o mouse é dispensável, "pairável" e persistente).
Mapa inicial (o dev confere que cada alvo existe; sugiro um teste em `test/qa.test.js`):

| Chave do `?` | Destino |
|---|---|
| `conexoes.amazon`, `espelhamento.formato`, `espelhamento.fila`, `espelhamento` | `conexoes/amazon`, `espelhamento/formato`, `espelhamento/fila`, `espelhamento/criar` |
| `conexoes.shopee`, `.id`, `.appid`, `.senha` | `conexoes/shopee`; os três últimos vão a `perguntas/id-shopee` |
| `conexoes.shopee.extensao`, `ajustes.extensao` | `primeiros-passos/extensao` |
| `conexoes.catalogo`, `.endereco`, `.token` | `conexoes/catalogo` |
| `regras.etiqueta`, `fonte.etiqueta` | `perguntas/etiqueta-desta-fonte` |
| `fonte.catalogo`, `fonte.catalogo.ordem` | `disparo-automatico/catalogo` |
| `fonte.catalogo.revisao` | `revisao/motivos` |
| `regras.fontes`, `fonte.tipos` | `disparo-automatico/fontes` |
| `manual.link`, `manual.amazon`, `manual.shopee` | `disparo-manual/mercado-livre`, `…/amazon`, `…/shopee` |
| `regras.template`, `templates` | `templates/linha-some` |
| `whatsapp` | `primeiros-passos/whatsapp` |
| `equipe`, `equipe.convite` | `equipe/papeis`, `equipe/convidar` |
| `ajustes.privacidade` | `privacidade/retencao` |
| `links`, `links.modo`, `links.proximo` | `grupos/rotacionador`, `…/rotacionador`, `grupos/proximo-grupo` |
| `relatorios`, `relatorios.virada` | `resultados/avisos` |

A página Ajuda atual tinha, no cabeçalho de cada cartão, um botão "Abrir <tela>". No livro, cada capítulo mostra no fim "Abrir <tela> no painel" (link para a rota correspondente: `#conexoes`, `#disparo-manual`...), para quem leu e quer agir.

## 4. Estados

| Situação | Comportamento |
|---|---|
| Capítulo inexistente (`#docs/xyz`) | Mantém o sumário. No conteúdo: `h2` "Não achamos este capítulo", texto "O endereço pode estar errado ou o capítulo mudou de nome." e dois botões: "Ir para o início do livro" (principal) e "Ver o sumário". O foco vai para o `h2`. Título da aba: "Capítulo não encontrado · Docs do sistema". |
| Seção inexistente em capítulo que existe | Abre o capítulo no topo, sem erro. |
| Busca sem resultado | `role="status"`: "Nada encontrado para “xyz”." + "Tente uma palavra mais curta ou sem acento. Ou veja as Perguntas reais." com os links para *Perguntas reais* e *Referência*. |
| Busca com resultado | Painel no lugar do conteúdo: "3 resultados para “catálogo”". Cada resultado é um link com "Capítulo · Seção" e o trecho com o termo em `<mark>` (cor de `--warn` a 30% sobre `--surface`, texto `--text`). Botão "Limpar busca" e <kbd>Esc</kbd> voltam ao capítulo. A busca ignora maiúsculas e acentos, começa com 2 caracteres e filtra enquanto digita (espera 200 ms). Mostra no máximo 20 resultados, com "Mostrando 20 de N. Refine a busca" se houver mais. |
| Busca com 1 caractere | Nada acontece; a dica do campo diz "Digite pelo menos 2 letras". |
| Primeira visita | "0 de 13 lidos"; botão do Início "Começar pelo capítulo 1". |
| Já leu alguns | "Continuar do capítulo N" (primeiro não lido). |
| Tudo lido | "13 de 13 lidos. Você terminou a trilha." (texto, sem confete). |
| Copiar comando | Padrão, hover, foco, "Copiado", falha (acima). |
| Conteúdo longo ou inesperado | Títulos longos quebram linha no sumário; URLs e caminhos quebram com `overflow-wrap:anywhere`; tabela rola dentro do próprio bloco. |
| JavaScript do livro falha | Mensagem padrão do painel de erro de página; o restante do painel não é afetado. |
| Carregando | Conteúdo é estático (já no `.js`), sem estado de carregamento. |
| Operador | Vê todo o livro, inclusive "Equipe e papéis" (antes o cartão sumia). Passos que só o Dono pode fazer levam o selo "Só o Dono". |

## 5. Textos da interface

Em `public/docs.js` junto do conteúdo **[A alinhar com o plano]**; o painel hoje deixa os textos no próprio arquivo de cada tela, e `ajuda.js` já guarda o texto de ajuda.

- Menu: "Docs". Título da página: "Docs do sistema". Subtítulo: "Aprenda o Achadinho Turbo passo a passo. Procurando algo específico? Use a busca."
- Busca: rótulo "Buscar nos Docs", placeholder "Ex.: tag da Amazon, revisão, backup", botão "Buscar", "Limpar busca".
- Sumário: "Sumário", "Início", "Perguntas reais", "Referência", "{n} de 13 lidos", "Limpar progresso", `summary`: "Sumário · cap. {n} de 13 · {título}".
- Capítulo: "Capítulo {n}", "O que você vai aprender", "Antes de começar", "Leitura: {n} min", "Marcar como lido", "Anterior", "Próximo", "Continue com", "Voltar ao início do livro", "Abrir {tela} no painel".
- Notas: "Aviso", "Dica", "Erro comum", "Só o Dono".
- Comando: "Copiar", "Copiado", "Comando copiado", "Não deu para copiar. Selecione e copie (Ctrl+C)."
- `?`: "Ler mais: {seção} →".
- Erro e vazio: textos da seção 4.
- Rótulos de acessibilidade: "Sumário do livro", "Capítulo anterior e próximo", "Link para esta seção", "Pular para o conteúdo do capítulo".

**Tom.** Português do Brasil, segunda pessoa ("você"), frases de até 20 palavras, verbo no início do passo ("Abra", "Cole", "Clique"). Botões e campos entre aspas com a grafia exata da tela. Sem teoria: o "porquê" cabe em uma frase. Termo técnico só quando você vai ver na tela (ASIN, token, API) e, na primeira vez, com uma explicação curta entre parênteses.
- Sim: "Abra *Conexões → Amazon*, escreva a tag (ex.: `seunome-20`) e clique em **Salvar**."
- Não: "Proceda à parametrização da credencial de associado na camada de conexões."

## 6. Acessibilidade (WCAG 2.2 AA)

- **Landmarks.** O livro fica no `<main>` do painel. Dentro: `<form role="search">` (busca), `<nav aria-label="Sumário do livro">`, `<article aria-labelledby="docs-titulo">` e `<nav aria-label="Capítulo anterior e próximo">`. Não use `<aside>` para as notas (viraria landmark); use `div role="note"`.
- **Títulos.** `h1` "Docs do sistema" (um por página), `h2` título do capítulo, `h3` seções. Sem pular nível.
- **Sumário.** Lista `<ol>` de links. O capítulo aberto tem `aria-current="page"`; a seção atual, ao abrir pelo endereço, `aria-current="location"`. Não use só cor: o item atual também fica em negrito com barra de 3 px à esquerda. Lido: "✓" + texto "(lido)" para leitores de tela.
- **Foco ao trocar de capítulo.** A troca é por mudança de hash (o painel refaz a página). Depois de montar, o foco vai para o `h2` do capítulo (`tabindex="-1"`, sem contorno só quando foco programático; com teclado o contorno aparece), a rolagem vai ao topo e `document.title` muda para "{Capítulo} · Docs do sistema". Em link com seção, o foco vai para o `h3` da seção (`scroll-margin-top` de 16 px). `role="status"` oculto anuncia "Capítulo 5 de 13: Disparo automático". Não anunciar duas vezes.
- **Pular o sumário.** Um link "Pular para o conteúdo do capítulo" (visível ao focar) antes do sumário, porque o sumário vem antes do conteúdo na ordem do DOM.
- **Teclado.** Tudo alcançável por Tab em ordem lógica (busca → sumário → conteúdo → Anterior/Próximo). `details` do sumário abre com Enter e Espaço. `?` com Ler mais: Enter/Espaço fixa, Esc fecha, foco volta. Blocos de comando e tabelas rolantes têm `tabindex="0"`.
- **Contraste.** Texto 4,5:1 e componentes 3:1 nos dois temas, usando só os tokens da tabela da seção 2. `<mark>` mantém `--text` sobre fundo claro misturado. O foco usa o existente `:focus-visible` (`--primary-text`, 2 px, offset 2 px).
- **Alvos.** Links do sumário com no mínimo 36 px de altura no desktop e 44 px abaixo de 900 px; botões Copiar, Anterior, Próximo e `summary` com 44 px no celular. Nada abaixo de 24 px.
- **Cor não é o único sinal.** Notas têm ícone **e** palavra; lido tem ✓ e texto; item atual tem barra e negrito; erro de copiar tem texto.
- **Movimento.** Sem animação nem rolagem suave; a mudança de `details` e o texto "Copiado" não têm transição. Respeita `prefers-reduced-motion` (já há regra global em `style.css`).
- **Zoom e reflow.** Sem rolagem horizontal em 320 px e com zoom de 200%. Linha de 45 a 75 caracteres (`max-width:72ch`; nos blocos de texto corrido).
- **Semântica.** `kbd`, `code`, `pre`, `ol`, `table` com `<th scope>`; `dl` só para o glossário. `lang="pt-BR"` já está no documento. Links com texto que faz sentido sozinho ("Ler o capítulo Conexões", não "clique aqui").
- **Âncora de seção.** `<a class="docs-ancora" href="#docs/…" aria-label="Link para esta seção">#</a>` ao lado do `h3`: sempre presente no DOM e visível ao passar o mouse **ou focar** (no toque fica visível, em `--text-2`).

## 7. O que o dev precisa implementar

Pela spec; a divisão de arquivos e o formato do conteúdo ficam com o plano **[A alinhar com o plano]**.

1. **Rota e alias.** `ROTAS.docs`; `ALIASES.ajuda = 'docs'`; menu do rodapé "Docs" (`index.html`, `href="#docs"`); `#docs/<capitulo>[/<secao>]` preservado em `ir()` e `rotaAtual()` (item "Endereços" acima); `#menu-atual` mostra "· Docs".
2. **Conteúdo como dados.** Um arquivo novo `public/docs.js` com `CAPITULOS` (id, titulo, aprenda[], antes[], secoes[{id, titulo, blocos[]}]), `PERGUNTAS` (`id`, `pergunta`, `resposta`, `onde`, `leia`) e `REFERENCIA`. Blocos tipados (`p`, `passos`, `nota`, `comando`, `tabela`, `caminho` inline) renderizados por uma função que escapa o texto (`esc`) e aceita só um conjunto fechado de marcação em linha (negrito, `code`, `kbd`, caminho). Nada de HTML cru vindo de dados.
3. **Páginas.** Início, capítulo, Perguntas reais, Referência, busca e capítulo inexistente (seção 4).
4. **Componentes e CSS** da seção 3, só com tokens; tema claro e escuro; 320 a 1280 px.
5. **Progresso** em `localStorage` (`docs.lidos`), tolerante a valor inválido (JSON quebrado, `localStorage` bloqueado: segue sem progresso e sem erro).
6. **`?` com "Ler mais"** (`LEIA_MAIS` em `ajuda.js`, dica fixada, foco e Esc). Os `?` atuais continuam; `q()` e `TIPS` mantêm a assinatura.
7. **Migração de conteúdo.** Cada cartão de `AJUDA` e cada verbete de `GLOSSARIO` é reaproveitado e atualizado onde a spec muda (por exemplo, espelhamento e catálogo agora têm capítulo próprio). `AJUDA` e `paginaAjuda` saem; `GLOSSARIO` fica em `ajuda.js` ou vai para `docs.js` (plano decide).
8. **Testes.** Atualizar `test/qa.test.js` (CA8 lê `AJUDA`, `rota` e o rodapé `['#historico','#ajustes','#ajuda']`; troca para `#docs` e para os capítulos). Novos: todo `LEIA_MAIS` aponta para capítulo e seção que existem; todo capítulo tem "o que você vai aprender"; `PERGUNTAS` com id único; o alias `#ajuda` abre o livro; todo `q()` ainda tem verbete.
9. **Docs que acompanham a mudança** (CLAUDE.md): atualizar `README.md` (menu: "Ajuda" vira "Docs"; endereços antigos: `#ajuda` abre os Docs) e a referência a `public/ajuda.js` (`TIPS` e `AJUDA`) no próprio `CLAUDE.md`, a cargo do lead.

## Arquivos de apresentação afetados

`public/index.html` (item de menu e `<script src="docs.js">` antes de `app.js`), `public/app.js` (rota, alias, preservar `/` no hash), `public/ajuda.js` (`LEIA_MAIS`, dica fixada, remoção de `AJUDA` e `paginaAjuda`), `public/docs.js` (novo), `public/style.css` (seção "docs"), `test/qa.test.js` e testes novos (a cargo do dev e do qa). Nada em `src/`, `scripts/` nem `extension/`.

## Pendências para confirmar antes de publicar o conteúdo

1. **Comando de P9** (limpar o log com as chaves do WhatsApp): o repositório não traz o comando nem diz qual log guardava as chaves. A redação acima é provisória, com `journalctl`. O dono ou o dev confirmam o comando e o motivo antes de ir ao livro.
2. **P2, última frase** ("cole o link da página do produto"): confirmar que é um caminho que de fato funciona.
3. **P10**: confirmar o texto do serviço (`achadinhoturbo`, porta 3737) para quem usa Windows (`iniciar.bat`).
4. **Capítulo "Manutenção"**: não há trecho no README sobre restaurar backup além de `npm run backup -- restaurar …`; a seção *Backup e restaurar* usa só isso.

## Perguntas em aberto

1. Progresso por navegador está bom, ou o dono quer por pessoa (exigiria banco e API, fora desta spec)?
2. O capítulo "Equipe e papéis" fica visível ao Operador (proposto) ou continua escondido como o cartão antigo?
3. O nome no menu é "Docs" (proposto) ou "Docs do sistema"? Cabe no rail de 264 px, só fica mais longo.
4. Haverá capturas de tela nos passos? Proposta: não nesta entrega (a tela muda sem aviso e envelhece o livro); caminhos escritos bastam.
5. Onde vive o conteúdo (um arquivo grande ou um por capítulo)? **A alinhar com o plano.**
