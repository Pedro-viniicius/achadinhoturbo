# Especificação de UI/UX: fonte "catalogo" (API do Etiqueta)

Brief: `docs/produto/briefs/fonte-catalogo-etiqueta.md` (CA1 a CA9). Plano aprovado (03/11/2026, com as decisões do dono): `docs/produto/planos/fonte-catalogo-etiqueta.md`; onde esta spec e o plano divergirem, vale o plano. Contrato da API: `~/Documentos/mensagensParaEnviar/docs/produto/referencias/api-ofertas.md` (só leitura). Padrão visual, de estados e de tom herdado de `docs/produto/specs/integracao-shopee.md` e `docs/produto/specs/espelhamento-amazon.md`. Só apresentação: rotas, campos e regras de negócio estão no plano; o que a tela assume dele está em "Alinhamento com o plano (respondido)". Tokens e classes: nenhum novo (`.card.conexao`, `.estado-pill`, `.aviso-impl`, `.passos`, `fieldset`, `.sub-campo`, `.grupos.cats`, `.chip`, `.seg`, `.kpi`, `.tabela`, `.nivel-*`, `dadosOferta`).

## Objetivo e usuário

Pedro (dono), no computador, com pressa, sem jargão. Já tem outro app dele, o Etiqueta, cheio de ofertas já com link de afiliado. Quer:
1. conectar o Turbo ao Etiqueta uma vez e saber se está funcionando;
2. criar um disparo automático que puxa dessas ofertas, escolhendo categoria, loja e filtros;
3. confiar que nada suspeito sai sozinho (Shopee, "100% OFF") e revisar essas ofertas rápido.

**Nome:** no Turbo, "etiqueta" já é a etiqueta de afiliado do Mercado Livre. A fonte se chama **"Catálogo"** em toda a interface. A palavra "Etiqueta" aparece só no cartão de Conexões (é o nome do app, em "Catálogo do Etiqueta") e no glossário, sempre com a distinção explícita. Nunca escrever "etiqueta do catálogo".

Princípios: falha nunca silenciosa; o token nunca aparece (só o **caminho** do arquivo); o painel nunca chama o Etiqueta (tudo passa pelo servidor); fonte fora do ar não é erro do dono nem derruba nada.

## Fluxo

1. **Conexões > Catálogo do Etiqueta:** confere o endereço, informa o caminho do arquivo do token, "Salvar", "Testar". Vê "Conectada" e as categorias com totais por loja.
2. **Disparo automático > Novo/Editar:** em "De onde vêm as ofertas", escolhe "Catálogo (app Etiqueta)"; marca categorias, lojas e filtros; lê os avisos; salva.
3. **Acompanhar:** o cartão da regra mostra "N para revisar" quando houver. O Histórico lista tudo.
4. **Revisar (só o Dono):** Histórico > Catálogo > "Revisar" (toda Shopee, desconto de 100%, preço antigo 10 vezes maior, falha de link): confere, corrige os preços à mão se preciso e envia, ou descarta.

## Layout (mobile e desktop)

### 1. Conexões > cartão "Catálogo do Etiqueta" (`public/conexoes.js`)

Mesmo `.card.conexao` na grade, **depois** das lojas, com um subtítulo `.sub` "Fonte de ofertas" no lugar do chip de loja (não é loja: não tem tag nem etiqueta). 1 coluna em 375 px; em 1280 px o cartão ocupa a largura da grade, e a tabela de categorias (abaixo) pede a linha inteira (`grid-column: 1 / -1` só neste cartão, 1 regra mínima em `style.css`, ou fica na coluna com rolagem interna se o dev preferir não mexer no CSS).

Ordem de cima para baixo:

1. **Cabeçalho:** `<h2>Catálogo do Etiqueta</h2>` + ajuda `?` (`conexoes.catalogo`) + selo `.estado-pill`.
2. **Descrição** (`.desc`): "O Etiqueta é o seu outro programa de ofertas, que roda neste computador. O painel lê as ofertas dele, que já vêm com o seu link de afiliado, e usa como fonte nos disparos automáticos. Não tem relação com as etiquetas do Mercado Livre."
3. **Formulário** (`<form novalidate>`, um `fieldset` "Como falar com o Etiqueta", sem segredo digitado):
   - **"Endereço do Etiqueta"** (texto, `inputmode="url"`, `autocomplete="off"`, `spellcheck="false"`). Valor inicial `http://localhost:8765` quando ainda não há nada salvo (é valor, não só placeholder: a dica diz "Já vem preenchido com o padrão"). Dica: "Onde o servidor do Etiqueta está rodando (python3 servidor.py). Só vale endereço deste computador: localhost ou 127.0.0.1."
   - **"Arquivo do token"** (texto, `.mono`, `autocomplete="off"`, `spellcheck="false"`, **não** `type=password`: é um caminho, não um segredo). Placeholder `/home/ufla/Documentos/mensagensParaEnviar/api_token.txt`. Dica: "Caminho do arquivo api_token.txt que está na pasta do Etiqueta. Cole o **caminho**, nunca o conteúdo: o painel lê o arquivo e o token não passa por esta tela."
   - Nenhum campo recebe, mostra ou devolve o token. O caminho mostrado é o salvo.
4. **Ações:** `pri` "Salvar" e "Testar". "Testar" **habilitado só com endereço e caminho salvos**; senão desabilitado, com a linha de estado explicando (`aria-describedby`): "Salve o endereço e o caminho do arquivo do token para testar." "Testar" usa o que está salvo, não o que está digitado e não salvo (a linha de estado diz isso se houver diferença: "Você mudou os campos. Salve antes de testar.").
5. **Linha de estado** (`.estado-linha`, `role="status"`): resultado do teste ou da última verificação (persiste ao recarregar, com "Verificado em dd/mm hh:mm").
6. **Categorias** (só no estado `conectada`, logo abaixo da linha de estado):
   - Linha-resumo: "3.853 ofertas em 12 categorias. Mercado Livre: 1.800 · Amazon: 1.500 · Shopee: 553." (soma por loja; números com separador de milhar; cada loja com o nome por extenso, nunca só cor.)
   - `<details open>` "Categorias do Etiqueta (12)" com tabela `.tabela` (`<table>`, `<caption class="sr-only">Categorias do Etiqueta e total de ofertas por loja</caption>`, `th scope`): colunas **Categoria | Total | Mercado Livre | Amazon | Shopee**, números alinhados à direita. Em 375 px a tabela rola **dentro do cartão** (`overflow-x:auto`, foco no contêiner com `tabindex="0"` e `role="region"` `aria-label`); a página não rola de lado. Ordem alfabética, como a API entrega. Nome da categoria sempre via `esc()`, com reticências e `title` se longo (até 200 caracteres).
   - Lista vazia (conectada, 0 categorias): "O Etiqueta está conectado, mas ainda não tem ofertas. Colete ofertas nele e teste de novo."
   - Nota: "Esta lista é a da última verificação. Se o Etiqueta ganhar categorias novas, clique em “Testar” para atualizar."

**Selo e estados** (texto sempre visível; classes existentes de `.estado-pill`). O servidor manda `estado`; o painel mapeia como em `pillConexao`:

| `estado` | Selo | Classe | Quando |
|---|---|---|---|
| `falta_configurar` | Falta configurar | `falta` | sem caminho do token salvo |
| `salva` | Salvo, ainda não testado | neutro | salvo, sem teste |
| `conectada` | Conectada | `conectado` | último teste aceito (200) |
| `token_recusado` | Token recusado | `erro` | último teste 401 |
| `indisponivel` | Indisponível | `pendente` | 503 (`desligada`), rede, tempo esgotado ou 5xx (`fora_do_ar`), resposta fora do contrato (`resposta_inesperada`) |
| `sem_arquivo` | Arquivo do token não encontrado | `erro` | o servidor não achou/leu o arquivo (`sem_arquivo`) ou o formato é inválido (`arquivo_invalido`) |

**Resultados do "Testar"** (`role="status"`; sucesso com "✓" e `nivel-ok`, falha em `.aviso` com "!"; nenhuma frase repete o token nem o conteúdo do arquivo; o caminho e o endereço podem aparecer, são do dono):
- `ok`: "✓ Conectado. {N} ofertas em {M} categorias." (detalhes na seção Categorias.)
- `token_recusado` (401): "O Etiqueta recusou o token. Se você trocou o arquivo do token, reinicie o servidor.py do Etiqueta (ele lê o arquivo só ao ligar) e teste de novo."
- `desligada` (503, selo Indisponível): "O Etiqueta está no ar, mas a API dele está desligada. Falta o arquivo api_token.txt (ou ele é inválido) na pasta do Etiqueta. O terminal do servidor.py diz o motivo. Depois de corrigir, reinicie-o e teste de novo."
- `fora_do_ar` (rede, tempo esgotado ou 5xx; selo Indisponível): "Não consegui falar com o Etiqueta em {endereço}. Confira se ele está ligado (python3 servidor.py) e se o endereço e a porta estão certos."
- `sem_arquivo`: "Não encontrei o arquivo do token em {caminho}. Confira o caminho, e se este programa tem permissão para ler o arquivo."
- `arquivo_invalido`: "O arquivo do token está vazio ou fora do formato (32 ou mais letras, números, _ e -). Gere o token de novo no Etiqueta."
- Endereço recusado pelo servidor no "Salvar" (400; é erro de campo em `mostrarErros`, não resultado de teste): "Endereço não aceito. Use um endereço deste computador, como http://localhost:8765."
- `resposta_inesperada` (400/403/404 do Etiqueta, JSON fora do contrato ou versão diferente da 1; selo Indisponível): "O Etiqueta respondeu algo que não esperávamos. Tente de novo; se continuar, veja o terminal do servidor.py."
- `nao_configurada`: não chega a rodar (botão desabilitado); se chegar, "Salve o endereço e o caminho do token para testar."

**Validação no cliente** (antes de enviar; `mostrarErros`, foco no primeiro inválido, nunca ecoa o valor digitado):
- Endereço vazio: "Informe o endereço do Etiqueta. O padrão é http://localhost:8765."
- Endereço sem `http://`/`https://`, com usuário/senha, caminho ou host fora de localhost/127.0.0.1: "Use só o endereço deste computador, como http://localhost:8765 (sem o que vem depois da porta)." (o servidor valida de novo.)
- Caminho vazio: "Informe o caminho do arquivo do token."
- **Caminho que parece o próprio token** (32 ou mais caracteres de `A-Za-z0-9_-`, sem `/`, `\` nem `.`): "Isto parece o token, não o caminho do arquivo. Cole o caminho (por exemplo, …/api_token.txt). Se você colou o token em algum lugar, gere outro no Etiqueta." Esta checagem existe para o dono não digitar o token em campo de texto visível; não ecoa o valor e o campo é **limpo** depois do erro.
- Caminho com mais de 500 caracteres ou com caracteres de controle: "Caminho inválido."

**Operador:** a conexão (endereço e caminho) é edição do Dono: campos travados com "Só o Dono muda esta conexão." (`TEXTOS_CONEXOES.segredoSoDono` adaptado). O Operador vê o selo e as categorias.

### 2. Disparo automático: fonte "Catálogo" (`public/app.js`, `fonteHtml`, `resumoFonte`, `paginaRegras`)

Entra uma quarta opção no grupo de rádio `fonte.tipos`: **"Catálogo (app Etiqueta)"** (`value="catalogo"`), ao lado de Central de Afiliados, Lista de links e Busca. Ao escolhê-la aparece o bloco `.f-catalogo` (como os outros blocos `.f-…`), uma coluna, `.grade` só onde há campos curtos. Ordem (pergunta mental: o quê → de onde → com que filtro → como ordenar):

0. **Aviso de conexão** (`.aviso-impl`, informativo, `role="status"`, só quando o catálogo não está `conectada`): "O catálogo ainda não está conectado. Conecte em Conexões e use “Testar” para ver as categorias." (link `#conexoes`). Variante para `indisponivel`/`token_recusado`: "O catálogo está indisponível agora ({selo}). Você pode salvar esta fonte; ela volta a enviar quando o Etiqueta responder." O dono nunca fica bloqueado de salvar por causa do catálogo.
1. **Categorias** (`fieldset.sub-campo` com `legend` "Categorias do Etiqueta" + `q('fonte.catalogo.categoria')` + contador "(N marcadas)"): lista `.grupos.cats` de `<label><input type="checkbox">` com "Nome (total)" via `esc()`. Máximo 20 (contrato); ao passar, desabilita o resto com "Você pode marcar até 20 categorias." Nenhuma marcada = todas. Dica: "Nenhuma marcada = todas as categorias. Com várias, vale qualquer uma delas." A lista é a da última vez que você clicou em “Testar” em Conexões; abrir esta tela não atualiza. Os totais refletem as lojas marcadas abaixo, atualizando ao marcar (ex.: só Shopee mostra o total da Shopee; categoria com 0 ofertas nas lojas marcadas fica `disabled` e mostra o texto "0 ofertas", visível, não só esmaecida). Sem lista (não conectado/sem teste): no lugar da lista, texto "As categorias aparecem depois que o catálogo for conectado e testado em Conexões." Categoria já salva que sumiu da lista: continua marcada e mostra "(não está mais no catálogo)".
2. **Lojas** (`fieldset.sub-campo`, legend "Lojas" + `q('fonte.catalogo.loja')`): três checkboxes "Mercado Livre", "Amazon", "Shopee", cada uma com o total da seleção de categorias entre parênteses. Nenhuma marcada = todas as lojas. Dica: "Nenhuma marcada = as três lojas."
3. **Filtros** (`.grade`):
   - **"Buscar por (opcional)"** (`q`, até 200 caracteres): dica "Palavras separadas por vírgula (até 10). Basta uma aparecer no título; não diferencia maiúscula nem acento. Ex.: air fryer, fritadeira."
   - **"Desconto mínimo (%)"** (`desconto_min`, `number`, `min 0`, `max 99`, `inputmode="numeric"`): dica "De 0 a 99. Vazio = sem mínimo. Ofertas com 100% de desconto sempre esperam a sua revisão (veja abaixo)."
   - **"Ordem"** (`select`, padrão "Novidades do catálogo"): "Novidades do catálogo (só o que chegar depois de salvar)" `atualizacao`; "Mais vendidos" `relevancia`; "Maior desconto" `desconto`; "Menor preço" `menor_preco`; "Maior preço" `maior_preco`; "Com cupom primeiro" `cupom`; "Coletadas há menos tempo" `recentes`. "Aleatória" **não** aparece (a API não pagina). Dica ligada à ordem escolhida (`aria-describedby` dinâmico, `aria-live="polite"`): para novidades, "Começa a contar quando você salva: o que já está no catálogo hoje não é enviado. Cada envio pega o que chegar depois e nunca repete. Para mandar o que já existe, use outra ordem ou “Reler do começo”."; para as demais, "Cada envio pega as melhores que ainda não foram enviadas dentro do prazo de repetição."
   - Sem "Páginas lidas por envio" (não se aplica).
4. **Etiqueta desta fonte** (o `select` `src_tag` existente), rótulo muda para **"Etiqueta do Mercado Livre desta fonte"**. Aplica só às ofertas do Mercado Livre (o link é gerado de novo com ela). Quando as lojas marcadas são só Amazon e/ou Shopee: `select` desabilitado e texto "Não se aplica: os links da Amazon e da Shopee já vêm prontos do catálogo."
5. **Botão "Reler do começo"** (`leve`; só ao **editar** uma regra que tenha fonte Catálogo). Vale por **regra**: todas as fontes Catálogo dela ("Reler o catálogo desde o começo no próximo envio"). Pede `confirm()`: "Na próxima vez, o painel confere o catálogo inteiro de novo, em todas as fontes Catálogo deste disparo. Ofertas já tratadas não são repetidas. Continuar?" Depois, texto fixo "Releitura marcada para o próximo envio." (`POST /api/rules/:id/catalogo/recomecar`). Dica: "Use para mandar o que já estava no catálogo antes de você salvar a regra, ou depois de reorganizar as categorias no Etiqueta." Falha: "Não consegui marcar a releitura. Tente de novo."

**Avisos dinâmicos** (`.aviso-impl` informativos, abaixo dos filtros, `aria-live="polite"`, texto sempre visível; só os que se aplicam; começam com "!" textual quando exigem atenção):
- **A1, sem ML** (lojas marcadas = só Amazon e/ou Shopee): "Esta fonte não precisa de etiqueta do Mercado Livre. Se todas as fontes do disparo forem assim, a etiqueta padrão fica opcional."
- **A2, com Shopee** (Shopee marcada, ou nenhuma loja marcada): "! Toda oferta da Shopee espera a sua revisão antes de sair: o link curto da Shopee não prova de quem é a conta. Elas aparecem em Histórico > Catálogo, com o botão “Revisar”."
- **A3, com ML** (ML marcado ou nenhuma loja): "Os links do Mercado Livre são gerados de novo, com a etiqueta escolhida acima, pela extensão do Chrome. Com a extensão desligada, essas ofertas esperam e saem sozinhas quando ela voltar; não vão para a revisão."
- **A4, sempre** (`.dica`): "Ofertas com 100% de desconto, com preço antigo 10 vezes maior que o preço ou cujo link falhe ao ser gerado também esperam a sua revisão. Nada disso sai sozinho."
- **A5, Amazon** (Amazon marcada ou nenhuma loja): `.dica` "Amazon: o link é montado com a sua tag de Conexões." Se a tag da Amazon não estiver salva, vira aviso: "! Falta a tag da Amazon. Salve em Conexões > Amazon; sem ela, as ofertas da Amazon esperam." (link `#conexoes`; o painel precisa saber se há tag salva: ver "Alinhamento com o plano".)

**Etiqueta padrão da regra** (campo existente `tag_id`, hoje `REQ`): o asterisco e a validação (linha da `Escolha a etiqueta padrão…`) só valem se **alguma fonte do disparo exigir etiqueta** (qualquer fonte que não seja catálogo só-Amazon/Shopee). Quando todas dispensam, o rótulo vira "Etiqueta padrão (opcional)" e a mensagem de erro não dispara. Texto de apoio: "Não precisa: as fontes deste disparo só trazem Amazon e Shopee."

**Validação no cliente do bloco** (`mostrarErros`, foco no primeiro inválido, sem ecoar o valor):
- `q` com mais de 200 caracteres, com mais de 10 termos ou com termo vazio (`a,,b`, vírgula no começo/fim): "Buscar por: até 200 caracteres e 10 palavras, separadas por vírgula, sem palavra vazia."
- `desconto_min` fora de 0–99 ou não inteiro: "Desconto mínimo: número inteiro de 0 a 99."
- Mais de 20 categorias: "Escolha no máximo 20 categorias."
- Fonte duplicada igual a outra do mesmo disparo: sem validação (permitido).

**Cartão da regra (lista):** `resumoFonte` ganha o ramo catálogo, todo via `esc()`: "Catálogo do Etiqueta (Perfumes e Perfumaria + 2 categorias, Amazon + Shopee, “air fryer”, desconto a partir de 30%, novidades)"; mais de 3 categorias viram "N categorias". Chips: `.chip` "N para revisar" (só se > 0, só para o Dono, link para Histórico > Catálogo filtrado por esta regra); `.chip` "Revisão cheia (50)" quando a regra tem 50 pendentes, com `.prox` "50 ofertas esperam revisão. As novas esperam até você revisar ou descartar."; e, **global** (de `/api/state.catalogo.falha_desde`, não por regra), `.chip` de aviso "Catálogo indisponível" (texto, `--warn` com "!") em toda regra com fonte Catálogo, com `.prox` "Catálogo indisponível desde 14:32. As outras fontes seguem." "Ver ofertas" (pré-visualização, sem gravar nada) funciona como nas outras fontes; as que iriam à revisão aparecem com o chip "Esperaria revisão" e o motivo.

### 3. Revisão das ofertas do catálogo (`public/espelhamento.js`, `public/app.js` Histórico)

**Decisão (plano, D1 e D5): fila própria `catalogo_itens` (rotas `/api/catalogo/itens*`), mostrada no Histórico como tipo "Catálogo". O dialog "Revisar oferta" reaproveita o miolo do "Completar"** (dados editáveis em `dadosOferta`, prévia com o template, enviar/descartar, tratamento de 409 e atualização de 6 s sem repintar com `<dialog>` aberto). A tabela do espelhamento não é usada: o painel só troca a fonte de dados e o que é específico da revisão. Extrair o miolo comum, não copiar.

**O que vai à revisão** (motivos que o servidor manda, em lista): `shopee` (toda oferta da Shopee), `desconto_100` (desconto de 100%), `preco_antigo` (preço antigo ≥ 10× o preço), `falha_link` (o link daquele item não pôde ser gerado). **Não** vai à revisão: ML com a extensão desligada (espera e sai sozinha quando ela volta), loja indisponível no momento, Amazon sem tag salva (espera). Teto de 50 pendentes por regra: acima disso, as novas esperam sem entrar na fila.

**Onde:** Histórico (`#historico`), seletor `.seg` "Tipo" ganha **"Catálogo"** (Tudo | Disparo automático | Espelhamento | Catálogo). Visão Catálogo: 3 `.kpi` (Enviadas, Descartadas, **Para revisar**; últimas 24 h, de `contadores_24h`; "Para revisar" em `--warn` quando > 0, com o texto) e a tabela `.card.tabela` com colunas **Quando | Regra | Loja | Oferta | Resultado**. A tabela lista tudo o que passou pelo catálogo: enviadas sozinhas, enviadas pela revisão, para revisar e descartadas. Resultado, em texto e classe:
- `nivel-ok` "Enviada" (+ `.dica`: "link da Amazon com a sua tag" / "link do Mercado Livre gerado com a etiqueta {nome}" para as enviadas sozinhas; "revisada e enviada" para as que passaram pela revisão, a da Shopee com o link do catálogo);
- `nivel-aviso` "Para revisar: {motivo}" + botão **"Revisar"** (`.pri`, `aria-label="Revisar oferta {título}, da Shopee"`), **só para o Dono**; o Operador vê o texto "Só o Dono revisa." no lugar do botão;
- `nivel-aviso` "Descartada: {motivo}" (repetida, sem foto aceita, descartada por você);
- `nivel-erro` "Erro ao enviar para este grupo" + motivo curto (`envio_status`).
- Motivos (constante `TEXTOS_CATALOGO.motivos`): `shopee` "Shopee: confirme o link"; `desconto_100` "Desconto de 100%: confira o preço"; `preco_antigo` "Preço antigo muito alto: confira o preço"; `falha_link` "Não consegui gerar o link: confira a oferta". Mais de um motivo = os dois, separados por " e ".
- **Oferta:** título (via `esc()`, 2 linhas, `title`), chip da loja e, se houver, categoria em `.dica`.
- **Fila cheia:** quando uma regra tem 50 pendentes, `.aviso-impl` acima da tabela: "! A regra “{regra}” tem 50 ofertas esperando revisão. As novas esperam até você revisar ou descartar algumas."

**Dialog "Revisar oferta"** (mesmo `#dlg`, título "Revisar oferta", subtítulo: "Veio do catálogo, pela regra “{regra}”. Motivo: {motivos}. Confira os dados e envie, ou descarte."). Diferenças em relação ao "Completar":
1. **Faixa de motivo** no topo (`.aviso-impl`, `role="status"`, "!" textual), por motivo: Shopee: "O link da Shopee não prova de quem é a conta. Abra o link abaixo para conferir o produto antes de enviar."; 100% ou preço antigo: "Esta oferta aparece com 100% de desconto ou com preço antigo {X}× maior que o preço ({preço antigo} → {preço}). Costuma ser erro no catálogo. Corrija os preços à mão, ou apague o preço antigo: a mensagem sai sem “de/por” e sem desconto."; `falha_link`: "Não consegui gerar o link do Mercado Livre desta oferta. Ao enviar, o painel tenta de novo na hora; se falhar, o motivo aparece aqui."
2. **Link da oferta** em `<a>` "Abrir o link da oferta (abre em outra aba)", `target="_blank" rel="noopener noreferrer"`, **só** se for `https` em `produto.mercadolivre.com.br` (página do produto; o meli.la só nasce no envio), `www.amazon.com.br` (`/dp/<ASIN>` sem tag) ou `s.shopee.com.br`; senão aparece só "Link fora do esperado: não enviar" e "Enviar" fica desabilitado. O link nunca é editável aqui.
3. Dados (`dadosOferta`) pré-preenchidos e editáveis como no "Completar"; foto só dos CDNs permitidos (ML, Amazon, Shopee); preço antigo suspeito com destaque em `--warn` mais o texto de apoio (cor não é o único sinal).
4. **Botões:** `pri` "Enviar para N grupos", "Descartar" (`perigo leve`, `confirm()`: "Descartar esta oferta? Ela não será enviada.") e "Fechar". **Não existe "Enviar mesmo com 100%"** (decisão do dono): "Enviar" fica desabilitado enquanto, com os valores do formulário, o desconto for 100% ou o preço antigo for ≥ 10× o preço (mesma conta do servidor), com o texto de apoio ligado por `aria-describedby`: "Corrija o preço ou apague o preço antigo para enviar." Depois de enviar: foco volta à tabela e a linha vira "Enviada · revisada por você".
5. **"Enviar e ir para a próxima"** (secundário, só quando há mais de uma "Para revisar" na mesma regra): envia e abre a próxima (mais antiga primeiro). Foco vai para o título do dialog.
6. 409 (já tratada): "Esta oferta já foi tratada." e atualiza (padrão do "Completar").

**Avisos de que há o que revisar:** chip "N para revisar" no cartão da regra (seção 2), KPI no Histórico e contador no item de menu "Histórico" (texto, ex. "Histórico (3)", `aria-label="Histórico, 3 ofertas para revisar"`), de `/api/state.catalogo.para_revisar`; só para o Dono.

**Alternativa descartada:** tela própria "Revisão". Duplicaria tabela, dialog e atualização.

### 4. Ajuda e glossário (`public/ajuda.js`)

Ver "Textos da interface". O glossário ganha o verbete que separa os três "etiqueta".

## Componentes

| Componente | Existente ou novo | Onde fica |
|---|---|---|
| `.card.conexao`, `.estado-pill`, `.estado-linha`, `.aviso-impl`, `fieldset`, `.dica`, `.tabela` | Existentes | `style.css` |
| Cartão "Catálogo do Etiqueta" (2 campos, Testar, lista de categorias) | Novo arranjo de existentes | `conexoes.js` |
| Tabela de categorias com rolagem interna acessível | Novo arranjo de `.tabela` | `conexoes.js` |
| Bloco `.f-catalogo` e opção "Catálogo (app Etiqueta)" em `fonteHtml`, ramo em `resumoFonte` e em `lerFontes` | Novo (usa `.grupos.cats`, `.grade`, `.sub-campo`) | `app.js` |
| Validação "etiqueta padrão opcional" (some o `REQ` se nenhuma fonte exige) | Ajuste de lógica existente | `app.js` |
| Visão "Catálogo" no Histórico (KPIs, tabela, `.seg` Tipo) | Variante da visão Espelhamento | `app.js` (Histórico), `espelhamento.js` |
| Dialog "Revisar oferta" | Variante do `completarEspelhamento` (extrair parte comum; **não** copiar) | `espelhamento.js` |
| `dadosOferta` | Existente, sem mudança (usa `descontoInformado` já previsto na spec da Shopee) | `disparos.js` |
| `TEXTOS_CATALOGO` (conexão, regra, revisão), `TEXTOS_CONEXOES` | Novas constantes | `conexoes.js`, `app.js`, `espelhamento.js` |
| `TIPS`, `AJUDA`, `GLOSSARIO` | Existentes, verbetes novos | `ajuda.js` |

## Estados

**Cartão de Conexões:** carregando ("Carregando as outras lojas…"), salvando, testando ("Testando…", botão travado, `role="status"`), os seis selos, os resultados de teste acima, erro por campo, Operador (campos travados), conectada sem categorias, conectada com categorias (tabela), conteúdo longo (caminho com ~200 caracteres: `.mono`, `overflow-wrap:anywhere`; categoria com 200 caracteres: reticências e `title`).

**Regra:** conectada / não conectada / indisponível; sem categorias na lista; categoria salva que sumiu; categoria com 0 ofertas na loja marcada; 20 categorias marcadas; `q` e `desconto_min` inválidos; lojas só Amazon/Shopee (etiqueta desabilitada e padrão opcional); com ML (etiqueta obrigatória); ordem "Novidades" (com "Reler do começo") e as demais; cartão com "N para revisar", "Revisão cheia (50)" e "Catálogo indisponível"; Novidades recém-salva (primeira leitura só marca o ponto de partida, nada é enviado).

**Revisão:** lista vazia ("Nada para revisar. As ofertas da Shopee e as com 100% de desconto aparecem aqui."), carregando, com N itens, dialog aberto (atualização suspensa, como hoje), enviando ("Enviando…"), 409, link fora do esperado, preço antigo suspeito ("Enviar" travado até corrigir), sem foto, enviada, descartada, erro, fila cheia (50), Operador (sem "Revisar").

## Textos da interface

Em constantes, não soltos no componente. Os textos finais estão nas seções 1 a 3. Rótulos e botões:
- **Conexões:** "Catálogo do Etiqueta", "Fonte de ofertas", "Endereço do Etiqueta", "Arquivo do token", "Salvar", "Testar", "Testando…", "Categorias do Etiqueta ({N})", colunas "Categoria | Total | Mercado Livre | Amazon | Shopee"; selos: Falta configurar, Salvo ainda não testado, Conectada, Token recusado, Indisponível, Arquivo do token não encontrado. Toast: "Catálogo: dados salvos".
- **Regra:** "Catálogo (app Etiqueta)", "Categorias do Etiqueta", "Lojas", "Buscar por (opcional)", "Desconto mínimo (%)", "Ordem", "Etiqueta do Mercado Livre desta fonte", "Reler do começo", ordens (sete).
- **Revisão:** "Catálogo" (tipo), "Para revisar", "Revisar", "Revisar oferta", "Enviar para N grupos", "Enviar e ir para a próxima", "Descartar", "Fechar", "Abrir o link da oferta (abre em outra aba)", motivos de revisão.

**`TIPS` novos:**
- `conexoes.catalogo`: 'O Etiqueta é o seu outro programa de ofertas, no mesmo computador. Aqui você diz onde ele está e onde fica o arquivo do token; o painel lê as ofertas e as categorias dele. Não é a etiqueta de afiliado do Mercado Livre.'
- `conexoes.catalogo.endereco`: 'Endereço do servidor do Etiqueta. O padrão é http://localhost:8765. Só vale endereço deste computador.'
- `conexoes.catalogo.token`: 'Caminho do arquivo api_token.txt do Etiqueta. O painel lê o arquivo; o token nunca aparece aqui. Se trocar o token, reinicie o servidor.py do Etiqueta e teste de novo.'
- `fonte.catalogo`: 'Ofertas do Etiqueta, que já vêm com link de afiliado da própria loja. Escolha categorias, lojas e filtros. Toda oferta da Shopee, as com 100% de desconto ou preço antigo exagerado e as que falham ao gerar o link esperam a sua revisão (só o Dono revisa).'
- `fonte.catalogo.categoria`: 'Abas do Etiqueta (aparecem depois de testar a conexão). Nenhuma marcada = todas. Vale qualquer uma das marcadas.'
- `fonte.catalogo.loja`: 'Nenhuma marcada = as três lojas. Só Amazon e/ou Shopee não precisa de etiqueta do Mercado Livre.'
- `fonte.catalogo.ordem`: '“Novidades” começa a contar quando você salva: envia só o que chegar ao catálogo depois disso (para mandar o que já existe, use “Reler do começo”). As outras ordens pegam as melhores que ainda não foram enviadas dentro do prazo de repetição.'
- `fonte.catalogo.revisao`: 'Shopee (o link não prova de quem é a conta) e ofertas com 100% de desconto ou preço antigo exagerado esperam a sua revisão em Histórico > Catálogo; o mesmo vale se o link falhar ao ser gerado. Só o Dono revisa e envia; corrija os preços à mão antes de enviar. Nada disso sai sozinho.'

**Edições em verbetes existentes:** `fonte.tipos` acrescenta "Catálogo: ofertas do seu app Etiqueta, com filtros de categoria e loja."; `regras.fontes` e o cartão `AJUDA` "Disparo automático" citam a fonte nova; cartão `AJUDA` "Conexões": passo "Catálogo do Etiqueta: informe o endereço (padrão http://localhost:8765) e o caminho do arquivo do token, salve e clique em “Testar”. Se aparecer “Token recusado”, reinicie o servidor.py do Etiqueta."; cartão `AJUDA` "Histórico": "Em Catálogo, as ofertas marcadas “Para revisar” esperam você: clique em “Revisar” (só o Dono), confira, corrija os preços se preciso e envie ou descarte." Ajuste em "Etiqueta" do glossário existente: "Etiqueta de afiliado do Mercado Livre (ex.: achadosmenicas). Não confundir com o Etiqueta, o seu outro programa, nem com o Catálogo."

**Glossário (novos):**
- "Catálogo" — 'Fonte de ofertas do Achadinho Turbo que lê as ofertas do seu app Etiqueta. Cada oferta já vem com o link de afiliado da loja. Configura-se em Conexões > Catálogo do Etiqueta e escolhe-se em um disparo automático.'
- "Etiqueta (o app)" — 'Seu outro programa, que coleta e organiza ofertas e roda neste computador (servidor.py). Quando este painel diz “etiqueta” sozinho, é a etiqueta de afiliado do Mercado Livre; quando diz “Catálogo”, são as ofertas do app Etiqueta.'
- "Para revisar" — 'Oferta do catálogo que não sai sozinha: Shopee (o link não prova de quem é a conta) com 100% de desconto ou preço antigo 10 vezes maior (provável erro de preço), ou que falhou ao gerar o link. Você confere em Histórico > Catálogo e envia ou descarta.'
- "Token do catálogo" — 'Chave de acesso ao Etiqueta, guardada num arquivo no seu computador. O painel lê o arquivo; o token não aparece em tela nem em log. Equivale a uma senha.'

## Acessibilidade

- **Teclado e foco:** ordem do DOM = ordem visual. Foco visível herdado. Tabela de categorias em contêiner rolável com `tabindex="0"`, `role="region"` e `aria-label`. No dialog "Revisar oferta", foco inicial no título (campo "Título", como no "Completar"); ao fechar, volta ao botão que abriu (ou à linha seguinte após "Enviar e ir para a próxima").
- **Rótulos:** todo campo com `label` visível; `fieldset/legend` nomeiam Categorias, Lojas e "Como falar com o Etiqueta"; dicas por `aria-describedby`; "Testar" desabilitado ligado à frase que explica o motivo.
- **Anúncios:** resultado do teste, estado, avisos dinâmicos (A1 a A4) e dica da ordem em `role="status"`/`aria-live="polite"`; erros de campo em `.erros` (`role="alert"`).
- **Cor nunca sozinha:** selos e resultados com palavra e "✓"/"!"; "Para revisar" em texto; preço antigo suspeito com texto, não só cor; lojas por nome.
- **Contraste:** reusar classes existentes (`--text` sobre fundo tingido, `--warn` com borda). Não usar `--warn` puro para texto.
- **Alvos:** botões, "Testar", "Revisar" e checkboxes com 44 px em ≤ 600 px (24 px mínimo em desktop); `label` clicável em toda a linha das categorias.
- **Texto cru:** `titulo`, `busca`, `categoria` e `cupom` do Etiqueta passam por `esc()` (que escapa `& < > " '`) em **todo** lugar: células da tabela, `title`, `alt`, `value` e `aria-label`. Nunca `innerHTML` com texto cru. `href` só para `https` nos hosts permitidos; `src` de imagem só dos CDNs permitidos (regex como `DISP_IMG_SHOPEE`); o resto é texto/sem imagem.
- **Responsivo:** 320 px sem rolagem horizontal da página; tabelas rolam por dentro; lista de 12+ categorias em `.grupos.cats` com rolagem interna e altura máxima, como a das categorias da Central; linhas de texto dos avisos até ~65 caracteres.
- **Movimento:** nada novo animado.
- **Privacidade na tela:** o token em lugar nenhum (HTML, atributo, `title`, toast, erro, console); só o caminho e o endereço. O servidor nunca devolve o conteúdo do arquivo; o painel nunca chama o Etiqueta. Nenhuma frase de erro repete o que o dono digitou no campo de caminho quando ele parece o token.

## O que o dev precisa implementar

1. `conexoes.js`: cartão "Catálogo do Etiqueta" (2 campos, Salvar, Testar, selo de 6 estados, resultados de teste, validação "parece o token", tabela de categorias, Operador travado).
2. `app.js`: opção "Catálogo" em `fonteHtml`, `lerFontes`, `resumoFonte`; avisos A1 a A4; etiqueta padrão opcional quando nenhuma fonte exige; "Reler do começo"; chips "N para revisar" e "Catálogo indisponível" no cartão da regra; seletor "Tipo" > Catálogo e visão no Histórico.
3. `espelhamento.js`: dialog "Revisar oferta" reaproveitando o "Completar" (extrair o miolo comum), faixa de motivo, link seguro, trava do "Enviar" enquanto o preço seguir suspeito (sem "Enviar mesmo com 100%"), "Enviar e ir para a próxima", Operador sem "Revisar".
4. `ajuda.js`: `TIPS`, `AJUDA` e `GLOSSARIO` acima.
5. `style.css`: só se for escolhido o cartão em largura total e/ou a altura máxima da lista de categorias. Se mexer, conferir Conexões, Disparo automático e Histórico em 375 e 1280 px.
6. Verificação visual obrigatória (375 e 1280 px, dois temas) com servidor falso do Etiqueta: cartão em `conectada`, `token_recusado`, `indisponivel`, `sem_arquivo` e `falta_configurar`; regra com categorias, só Amazon (etiqueta desabilitada), com Shopee e com ML; Histórico > Catálogo com itens "Para revisar"; dialog de revisão com Shopee e com 100% OFF; texto cru malicioso (`<img onerror>`, aspas) em título, categoria e cupom.

## Arquivos de apresentação afetados

`public/conexoes.js`, `public/app.js`, `public/espelhamento.js`, `public/ajuda.js`, `public/style.css` (se necessário). `public/disparos.js` só se `dadosOferta` precisar de ajuste (não previsto). Fora da apresentação (pendência para o dev): tudo em `src/` e as rotas do plano; a CSP já libera os CDNs das três lojas (plano, `src/server.js:35`). O que a tela assume do servidor está em "Alinhamento com o plano (respondido)".

## Alinhamento com o plano (respondido)

Plano aprovado em 03/11/2026, com as decisões do dono (P1 a P8). Onde esta spec divergia, o plano vale e o texto acima já foi ajustado.

| # | Pergunta da spec | Resposta do plano | O que a tela faz |
|---|---|---|---|
| 1 | Fila de revisão | Tabela própria `catalogo_itens`; rotas `GET /api/catalogo/itens?regra=&status=&limite=`, `POST …/:id/enviar` (`ajustes`: `title`, `price`, `oldPrice`, `coupon`, `freeShipping`, `sem_foto`, `upload`) e `…/descartar`; 409 "Esta oferta já foi tratada." | Histórico > tipo "Catálogo" lê dali (inclui enviadas sozinhas, sem `envio_id`) e o dialog "Revisar oferta" reaproveita o miolo do "Completar". |
| 2 | ML sem extensão | Não vai à revisão: espera e sai sozinha quando a extensão volta (P8). Não existe `ml_sem_extensao`; existe `falha_link`. | Aviso A3 diz isso; nenhum motivo de revisão para extensão desligada. |
| 3 | "Reler do começo" | Por regra (todas as fontes Catálogo dela): `POST /api/rules/:id/catalogo/recomecar`. "Novidades" começa do fim (P3). | Botão no formulário da regra; formulário avisa que Novidades só conta o que chegar depois de salvar. |
| 4 | Categorias e totais | Guardados no "Testar" (`settings.catalogo_verificacao`); `GET /api/catalogo/categorias` não chama o Etiqueta; abrir a regra não atualiza. | Mostra "da última verificação" e manda clicar "Testar" para atualizar. |
| 5 | Estados | Seis estados do selo como na spec. Resultados `ok`, `nao_configurada`, `sem_arquivo`, `arquivo_invalido`, `token_recusado`, `desligada` (503), `fora_do_ar`, `resposta_inesperada`. `endereco_invalido` é erro de campo do PUT (400). Servidor valida endereço (só `http`, localhost/127.0.0.1, porta obrigatória, sem caminho) e caminho (`/` ou `~/`, até 500, sem controle). | Mesma validação no cliente; frases por `resultado` na seção 1. |
| 6 | Contador no menu | `/api/state.catalogo.para_revisar` já existe (custo zero). | Entra: "Histórico (N)" só para o Dono, com `aria-label`. |
| 7 | Limites do contrato | Validados no servidor, 400 com frase fixa; nada do Etiqueta é repassado. | `mostrarErros` exibe a frase; validação prévia no cliente. |
| 8 | Disparo manual | Não muda. | Fora do escopo desta spec. |
| 9 | Quando é "suspeito" | Servidor decide: Shopee, `desconto_pct` ≥ 100, preço antigo ≥ 10× o preço, falha de link; motivos em lista. | Só mostra os motivos recebidos. |
| 10 | Link na revisão | ML: `produto.mercadolivre.com.br`; Amazon: `https://www.amazon.com.br/dp/<ASIN>` sem tag; Shopee: `s.shopee.com.br`. | Lista de hosts do `<a>` com esses três. |
| 11 | "Catálogo indisponível" | `/api/state.catalogo.falha_desde`, global, não por regra. | Chip em toda regra com fonte Catálogo. |
| P1 | Amazon | Link remontado com a tag de Conexões; exige a tag salva. | Aviso A5; dica "com a sua tag". |
| P4 | "Enviar mesmo com 100%" | Não existe: o dono corrige os preços à mão. | "Enviar" fica travado enquanto o preço seguir suspeito. |
| P5 | Teto | 50 pendentes por regra; acima, esperam sem entrar. | Chip "Revisão cheia (50)" e aviso no Histórico. |
| P6 | Quem revisa | Só o Dono revisa e envia. | Operador vê a lista, sem "Revisar". Pendência: o servidor responde 403 ao Operador nas rotas `enviar` e `descartar` (o plano lista as rotas para "Dono e Operador"; ajustar). |
| P7 | Nome do cartão | "Catálogo do Etiqueta". | Como na spec. |

**Que a tela assume do servidor (pendências para o dev, fora da apresentação):**
- Rotas `enviar`/`descartar` e o chip "N para revisar" só para o Dono (P6).
- O "Enviar" recusa (400, frase fixa "Corrija o preço ou apague o preço antigo para enviar.") quando, depois dos `ajustes`, o desconto ainda é 100% ou o preço antigo segue ≥ 10× o preço; a tela trava o botão com a mesma conta, mas o servidor decide.
- Saber, no painel, se a tag da Amazon está salva (campo em `/api/state.catalogo` ou no que `conexoes.js` já lê) para o aviso A5.
- Contagem de pendentes por regra (a tela usa `GET /api/catalogo/itens?regra=&status=revisao`) e sinal de "fila cheia".
- Ofertas do ML com links em modo comum (`direct`) não saem (plano, D4): a tela não tem aviso próprio; o dev decide se o `.prox` da regra explica.

## Perguntas em aberto

Nenhuma. O dono delegou as perguntas da spec e as premissas P1 a P8 do plano valem.
