# Plano técnico: Docs do sistema (a Ajuda vira um livro com trilha)
- Brief: docs/produto/briefs/docs-do-sistema.md
- Spec: docs/produto/specs/docs-do-sistema.md (lida antes de fechar este plano; ver "Alinhamento com a spec")
- Data: 2026-11-04
- Linha de base (04/11/2026): `npm test` → 854 testes, 853 passam, 0 falham, 1 todo.

## Objetivo e critérios de aceite
Trocar a página Ajuda (`#ajuda`) por "Docs do sistema": livro com sumário, capítulos em trilha, anterior/próximo, endereço por capítulo e seção, busca, Perguntas reais e Referência, sem dependência nova. CAs do brief, com os números dele:
CA1 — menu "Docs", sumário, anterior/próximo, link direto por capítulo.
CA2 — trilha na ordem do brief (primeiros passos → manutenção).
CA3 — "Perguntas reais" com as 10 perguntas, resposta curta e caminho; fácil de acrescentar.
CA4 — Referência: glossário, estados dos cartões de Conexões, motivos de revisão, limites e números.
CA5 — busca simples (cabe: filtro em memória, ~50 linhas).
CA6 — `#ajuda` abre os Docs; os `?` continuam funcionando.
CA7 — WCAG 2.2 AA, 375 e 1280 px, claro e escuro, sem dependência nova.
CA8 — conteúdo coerente com código e README; `npm test` verde (todo `q()` com verbete).

## Contexto atual
- `public/ajuda.js:4-111` `TIPS`; `:114-125` `DICAS_PLACEHOLDERS`/`DICA_OPCIONAL`; `:128-131` `q()` (texto em `data-tip` e `aria-label`); `:134-166` caixa `#tip` (popover manual; some no `mouseout`/`focusout`/rolagem); `:169-216` `AJUDA` (16 cartões); `:217-252` `GLOSSARIO` (34 verbetes); `:253-269` `paginaAjuda()` (injeta os textos crus em `innerHTML`; esconde o cartão Equipe do Operador).
- `public/app.js:666-674` `ROTAS` (`ajuda: () => paginaAjuda()`); `:676` `ALIASES`; `:683-686` `rotaAtual()` corta no `?` e não conhece `/`; `:687-698` `ir()` reescreve o hash para `#<rota>` (só o Histórico mantém `?consulta`) e chama `new URLSearchParams` só para o Histórico. `esc()` em `public/app.js:3`.
- `public/index.html:51` item `#ajuda` no rodapé; `:65-72` scripts na ordem ajuda → disparos → espelhamento → relatorios → conexoes → equipe → app → paineis.
- `public/style.css:190-205` estilos da Ajuda; `:423` ícone do menu por `nav a[href="#ajuda"]`; `:42` `main` com `max-width:1040px`; `:89` `.tabela`; não existe `.sr-only`.
- `src/server.js:37` CSP `script-src 'self'` (nada inline, nem `onclick=`); `:220` `express.static(public)` atrás do login, serve subpastas.
- Testes que dependem da Ajuda: `test/qa.test.js:643` (rodapé `#ajuda`), `:656` (rota `ajuda`), `:660-674` (lê `TIPS`, `AJUDA`, `GLOSSARIO` num `vm`; todo `q('…')` de `public/*.js` precisa de verbete, sem recursão em subpastas); `test/equipe-qa.test.js:775-786` (Operador sem `#ajuda-equipe`) e `:1013-1035` (texto do cartão Equipe e `dt` "Operador" do glossário). O harness `test/equipe-qa.test.js:374-399` roda todo `<script src>` do `index.html` num `vm` (sem `localStorage`, `URLSearchParams`, `scrollTo`; tem `getElementById`, `scrollIntoView`, `focus`, `setTimeout`).
- Fatos citáveis no código: `src/rotador.js:10` `LIMITE_MAX = 1024`, `:61` `LOTACAO_PCT = 95`; `src/privacidade.js:11` `RETENCAO_PADRAO_DIAS = 90`; `src/catalogo-itens.js:39` `TETO_REVISAO = 50`, `:40` `MOTIVOS`; `src/links.js:39` `LIMITE_SHOPEE_HORA = 60`; `src/envios.js:41` `MAX_HORARIOS = 6`, `:36` atraso máximo 2 h; `src/espelho.js:758` 168 h; `src/auth.js:12-13` sessão 30 dias / 7 dias sem uso; `src/afiliados.js:7` 18 por página. Rótulos dos motivos: `public/espelhamento.js:563-564`. Selos de Conexões: `public/conexoes.js:10-16`, `:96`, `:230-250`.
- A causa da P9 (chaves no journal) é real e já foi corrigida no código: `src/whatsapp.js:16`, teste `test/whatsapp.test.js:452`. O comando de limpeza não está no repositório (não verificado).

## Abordagens consideradas
| Abordagem | Prós | Contras | Risco |
|---|---|---|---|
| A. Conteúdo como dados JS: motor `public/docs.js` + capítulos em `public/docs/cap-*.js` chamando `docsCapitulo({...})`; texto com mini-marcação escapada | síncrono, sem fetch; estrutura validável em teste (campos, âncoras, links); carrega no harness `vm` sem mudança; arquivos separados permitem devs em paralelo | escrever texto dentro de JS (aspas, vírgulas); ~100 KB a mais por carga do painel (local, aceitável) | XSS baixo: um só ponto de saída HTML, escape primeiro, conjunto fechado de tags, só links internos |
| B. Markdown em `public/docs/*.md` + renderizador próprio + `fetch` | texto mais fácil de editar; abre bonito no GitHub | parser próprio maior (listas, tabelas, títulos) = mais superfície; Markdown aceita HTML cru, o parser tem de recusar; página assíncrona (estado de carregando, erro de rede); estrutura (aprenda, onde, leia) só por convenção; teste precisa de parser | XSS médio: parser caseiro é onde erros de escape aparecem |
| C. Um único `public/docs.js` com tudo (proposta da spec) | um arquivo só | 7 devs no mesmo arquivo = sem paralelismo; arquivo de 1.500+ linhas | igual ao A |

Decisão: **A**. B só compensaria se o README passasse a apontar para os mesmos `.md`, o que o brief não pede.

## Decisão
1. **Motor** `public/docs.js` (carrega depois de `ajuda.js`, antes dos capítulos): define só nomes com prefixo `docs`/`DOCS_` (nenhum nome global repetido; o `vm` daria `SyntaxError`), nada toca o DOM ao carregar. Tem `docsEsc` próprio (não depende de `app.js`, que carrega depois).
2. **Capítulos** em `public/docs/cap-*.js`, um arquivo por grupo de capítulos (divisão abaixo). Cada arquivo só chama `docsCapitulo({...})`: nenhuma declaração no topo (`const`, `let`, `function`, `class`), o que o teste confere.
3. **Ordem e partes** ficam só em `DOCS_TRILHA` no motor (13 capítulos numerados + apêndices `perguntas` e `referencia`), os slugs da spec, seção 1.
4. **Rotas**: `#docs`, `#docs/<cap>`, `#docs/<cap>/<secao>`. `rotaAtual()` usa o trecho antes do primeiro `/`; `ir()` mantém o sufixo quando casa `^docs(/[a-z0-9-]+){1,2}$`; `ALIASES.ajuda = 'docs'`; `ROTAS.docs = (pedido) => paginaDocs(pedido)`; `ROTAS.ajuda` sai. Capítulo inexistente: estado "Não achamos este capítulo" (spec, seção 4); seção inexistente: abre o capítulo no topo.
5. **Escape**: todo texto passa por `docsInline(s)`: `docsEsc` primeiro e, depois, só estes padrões viram tags: `**x**` → `<strong>`, `` `x` `` → `<code>`, `{{x}}` → `<kbd>`, `[[A → B]]` → `span.caminho` (com "depois" em `.sr-only`), `[texto](#alvo)` → `<a href>` só se o alvo casar `^#[a-z0-9-]+(/[a-z0-9-]+){0,2}$`. URL externa vira `code`, nunca link. Busca e trechos de resultado também escapados; nada de atributo `on*`; eventos por delegação em `#pagina`.
6. **Busca** em memória: normaliza (minúsculas, sem acento por `normalize('NFD')`), mínimo 2 letras, todos os termos têm de aparecer, máximo 20 resultados, espera de 200 ms. Nada no endereço.
7. **Perguntas reais e Referência** são capítulos como os outros (o motor não tem caso especial além de "apêndice sem número e sem anterior/próximo"). Pergunta = seção com `titulo` (a pergunta), `blocos` (a resposta), `onde` e `leia`. Acrescentar uma pergunta = acrescentar um objeto em `public/docs/cap-perguntas.js`.
8. **Ler mais**: `LEIA_MAIS` em `ajuda.js` (`chave do ?` → `cap/secao`), mapa da spec seção 3. `q()` passa a pôr `data-docs` quando há destino; o comportamento (dica fixa no clique/Enter com o link, Esc devolve o foco) é o da spec. `TIPS` não muda de forma.
9. **README × Docs**: o README continua sendo o guia de instalação e operação e ganha um parágrafo "Docs do painel"; não duplicamos à mão o livro inteiro no README nem o contrário. A coerência é garantida por: (a) cada dev de conteúdo lê as seções do README e do código listadas na etapa; (b) teste `FATOS` (etapa 14) com os números que aparecem nos dois lugares, conferidos contra a constante do código; (c) os selos e motivos da Referência conferidos contra `public/conexoes.js` e `src/catalogo-itens.js`.
10. **Equipe visível ao Operador** (spec, seção 4): seções com `soDono: true` mostram o selo "Só o Dono"; nada é escondido. Muda o comportamento testado em `test/equipe-qa.test.js:775-786` (pergunta P2).

## Esquema e contratos
Sem banco, sem rota de servidor. Contratos do lado do painel:
```
// public/docs.js
DOCS_TRILHA = [{ id, parte, numero|null }]       // ordem do sumário; numero null = apêndice
DOCS_CAPS   = Object.create(null)                // id → capítulo registrado
docsCapitulo(cap)                                // registra; lança Error se id repetido
docsInline(texto) → html seguro                  // regra da Decisão 5
docsHtmlCapitulo(id) / docsHtmlInicio() / docsHtmlNaoAchado() → string   // funções puras, testáveis sem DOM
docsBuscar(termo) → [{ cap, secao, titulo, trecho }]
paginaDocs(pedido)                               // DOM: monta, foco no h2/h3, document.title, role=status
// capítulo
{ id, titulo, aprenda: [2..4 textos], antes?: [textos], abrir?: [{ rota: '#conexoes', tela: 'Conexões' }],
  secoes: [{ id, titulo, soDono?, onde?, leia?: 'cap/secao', blocos: [Bloco, ...] }] }
// Bloco: exatamente uma destas chaves (+ titulo opcional em termos)
{ p } | { passos: [] } | { nota: 'aviso'|'dica'|'erro', texto } | { comando } | { exemplo } | { tabela: { colunas: [], linhas: [[]] } } | { termos: [[termo, definição]], titulo? }
```
`comando` = bloco com Copiar (spec); `exemplo` = `pre` sem Copiar (formato de mensagem de origem). Id de capítulo e seção: `^[a-z0-9-]+$`, único no escopo. Âncora no DOM: `id="docs-s-<secao>"` (só um capítulo na tela). Progresso: `localStorage['docs.lidos']`, tudo em `try/catch` e com `typeof localStorage` (o `vm` não tem).

Divisão do conteúdo (slugs de seção = spec, seção 1; a etapa 1 cria todos, as etapas de conteúdo podem acrescentar, nunca renomear nem tirar):
| Arquivo | Capítulos |
|---|---|
| `public/docs/cap-comecar.js` | 1 `primeiros-passos`, 2 `conexoes` |
| `public/docs/cap-disparos.js` | 3 `templates`, 4 `disparo-manual`, 5 `disparo-automatico`, 8 `mensagens` |
| `public/docs/cap-amazon-revisao.js` | 6 `espelhamento`, 7 `revisao` |
| `public/docs/cap-grupos.js` | 9 `grupos`, 10 `resultados` |
| `public/docs/cap-conta.js` | 11 `equipe`, 12 `privacidade`, 13 `manutencao` |
| `public/docs/cap-perguntas.js` | apêndice `perguntas` (10 seções: `tag-amazon`, `meli-la`, `precisa-api`, `id-shopee`, `catalogo`, `etiqueta-desta-fonte`, `so-catalogo`, `catalogo-links`, `limpar-log`, `painel-local`) |
| `public/docs/cap-referencia.js` | apêndice `referencia` (`glossario`, `estados`, `motivos`, `limites`) |

## Etapas
| # | Etapa | Arquivos | Verificação | Responsável | Grupo | Sensível | CAs |
|---|---|---|---|---|---|---|---|
| 1 | Motor do livro: registro, `DOCS_TRILHA`, `docsInline`, blocos, início, capítulo, apêndices, não achado, anterior/próximo, sumário (`<details>` abaixo de 1100 px), busca, Copiar do `comando`, foco/título/`role=status`, "Abrir <tela> no painel". Cria os 7 arquivos de capítulo com **todos** os slugs da spec, migrando para eles os 16 cartões de `AJUDA`, o "Comece por aqui" e o `GLOSSARIO` (seção sem texto ainda leva o bloco `{ p: 'Conteúdo em preparação.' }`). Inclui os `<script>` no `index.html` (docs.js e os 7 capítulos logo depois de `ajuda.js`). Teste novo: estrutura (campos permitidos, ids, `aprenda` 2–4, toda seção com bloco, trilha = registrados), nenhuma declaração no topo dos `cap-*.js`, `index.html` carrega todos os arquivos de `public/docs/` antes de `app.js`, todo `#docs/…` citado em `public/**/*.js` existe e todo `#rota` existe em `ROTAS`, escape (`<img onerror>`, `[x](javascript:…)`, `[x](#a" onclick="…)`, aspas, e um capítulo com `<script>` em cada campo não gera tag), busca sem acento e com 1 letra | `public/docs.js`, `public/docs/cap-*.js` (7, novos), `public/index.html`, `test/docs.test.js` (novo) | `node --check public/docs.js && node --disable-warning=ExperimentalWarning --test test/docs.test.js`; `npm test` continua 853/0 | dev | A | sim | CA1, CA5, CA6, CA7 |
| 2 | Rota e menu: `ROTAS.docs`, `ALIASES.ajuda`, `rotaAtual()`/`ir()` com `/`, item "Docs" no rodapé (`href="#docs"`); tira `AJUDA`, `GLOSSARIO` e `paginaAjuda` de `ajuda.js`. Atualiza os testes: rodapé `#docs`, `#ajuda` → `docs`, `#docs/conexoes/amazon` → `docs`, `#docs/xyz` mantém o endereço; no harness, Operador e Dono abrem `#ajuda` e caem em `#docs`, o Operador vê "Equipe e papéis" com o selo "Só o Dono", o texto do convite está em `#docs/equipe`, o `dt` "Operador" está em `#docs/referencia` | `public/app.js`, `public/index.html`, `public/ajuda.js`, `test/qa.test.js`, `test/equipe-qa.test.js` | `npm test` (854, 0 falhas) | dev | B | não | CA1, CA6 |
| 3 | Conteúdo: Primeiros passos e Conexões. Fontes: README "Instalar", "Login do painel", "Primeiros passos", "Conexões", "Extensão do Chrome", "Catálogo do Etiqueta → Configurar"; `src/lojas.js` (campos e textos), `public/conexoes.js` | `public/docs/cap-comecar.js` | `node --check` do arquivo + `node --disable-warning=ExperimentalWarning --test test/docs.test.js` | dev | C | não | CA2, CA8 |
| 4 | Conteúdo: Templates, Disparo manual, Disparo automático (fontes, Catálogo, ritmo, pausas de Ajustes), Mensagens. Fontes: README "Disparo manual" (+ Amazon, Shopee), "Primeiros passos" item 5, "Catálogo → Como a regra usa a fonte", "Disparar mensagem", "Template com trecho opcional"; `src/template.js`, `src/envios.js` | `public/docs/cap-disparos.js` | idem | dev | C | não | CA2, CA8 |
| 5 | Conteúdo: Espelhamento e Revisão (Histórico → Catálogo, motivos, preço, reenviar, fila do espelho). Fontes: README "Espelhamento da Amazon" inteiro e "Catálogo → O que vai para a revisão"; `src/espelho.js`, `src/catalogo-itens.js`, `public/espelhamento.js:563-564` | `public/docs/cap-amazon-revisao.js` | idem | dev | C | não | CA2, CA8 |
| 6 | Conteúdo: Grupos, blocos, rotacionador; Resultados (Visão Geral, Histórico, Relatórios e avisos). Fontes: README "Visão Geral, blocos e rotacionador", "Relatórios e avisos"; `src/rotador.js`, `src/avisos.js` | `public/docs/cap-grupos.js` | idem | dev | C | não | CA2, CA8 |
| 7 | Conteúdo: Equipe e papéis (`soDono` onde couber), Privacidade e segurança, Manutenção (painel/serviço, backup e restaurar, reconectar, log, Ajustes). Fontes: README "Equipe", "Backup", "Privacidade (LGPD)", "Cuidados"; `scripts/backup.js` (só leitura). Comandos em bloco `comando`; nenhum segredo, caminho de `wa_auth` só como pasta a proteger | `public/docs/cap-conta.js` | idem | dev | C | não | CA2, CA8 |
| 8 | Conteúdo: as 10 Perguntas reais (texto-base na spec, seção 1, apêndice A), cada uma com `onde` e `leia`. P9 só com o comando confirmado pelo lead (pergunta P1); sem confirmação, a resposta fica sem comando e diz "peça o comando ao responsável técnico" | `public/docs/cap-perguntas.js` | idem | dev | C | não | CA3, CA8 |
| 9 | Conteúdo: Referência: glossário agrupado por tema com o quadro "Cinco nomes parecidos", estados dos cartões (selos com a grafia de `public/conexoes.js`), motivos (os 4 de `MOTIVOS` + resultados do espelho), limites (tabela da spec, só valores conferidos no código ou no README) | `public/docs/cap-referencia.js` | idem | dev | C | não | CA4, CA8 |
| 10 | CSS da spec (seção "docs"): `.docs-*`, `.caminho`, `.sr-only`, `kbd`, `mark`, 320–1280 px, claro/escuro; remove `:190-205` sem uso e troca o seletor do ícone para `nav a[href="#docs"]` | `public/style.css` | painel em `PORT=3799 DATA_DIR=<tmp> DRY_RUN=1 …` em 375 e 1280 px, nos dois temas; `npm test` | designer | C | não | CA1, CA7 |
| 11 | Ler mais: `LEIA_MAIS` (mapa da spec), `q()` com `data-docs`, dica fixa no clique/toque/Enter/Espaço com o link "Ler mais: <seção> →" montado por `createElement`/`textContent`, foco no link, Esc devolve o foco, não some ao rolar quando fixa. Teste: toda chave de `LEIA_MAIS` existe em `TIPS` e todo destino existe nos capítulos | `public/ajuda.js`, `test/qa.test.js` | `node --disable-warning=ExperimentalWarning --test test/qa.test.js` | dev | C | não | CA6, CA7 |
| 12 | Progresso (spec, "Progresso"): `docs.lidos` no `localStorage`, "N de 13 lidos", ✓ + "(lido)", "Marcar como lido", "Continuar do capítulo N", "Limpar progresso"; JSON inválido ou `localStorage` ausente não quebra. Teste com `localStorage` falso e sem ele | `public/docs.js`, `test/docs.test.js` | `node --disable-warning=ExperimentalWarning --test test/docs.test.js` | dev | C | não | CA1 |
| 13 | README: menu "Docs" (`README.md:64`), `#ajuda` nos endereços antigos (`:66`), parágrafo "Docs do painel" (o livro, Perguntas reais, Referência; o README segue como guia de instalação) | `README.md` | leitura + `npm test` | dev | C | não | CA8 |
| 14 | Coerência final: no `test/docs.test.js`, tabela `FATOS` (texto, arquivo do código, regex da constante, valor): 1.024, 95%, 90 dias, 50 na revisão, 60 links por hora, 168 h, 6 horários, 30 dias de sessão, 7 dias sem uso, 18 por página; cada texto aparece nos Docs **e** no README e o valor bate com o código. Selos de `estados` existem literalmente em `public/conexoes.js`; `motivos` cobre os 4 de `MOTIVOS`; nenhum "Conteúdo em preparação." sobrou; as 10 perguntas existem com `onde` e `leia` válidos. Corrige o README ou o capítulo que divergir | `test/docs.test.js`, `README.md`, `public/docs/cap-*.js` (só onde divergir) | `npm test` | dev | D | não | CA3, CA4, CA8 |

Grupos: A → B → C (etapas 3 a 13 em paralelo; nenhuma compartilha arquivo: 3–9 um `cap-*.js` cada, 10 `style.css`, 11 `ajuda.js`+`qa.test.js`, 12 `docs.js`+`docs.test.js`, 13 `README.md`) → D. As etapas 3–9 só **rodam** `test/docs.test.js`; quem o edita no grupo C é só a 12. Se faltar gente, as etapas 3–9 podem ir em série sem mudar nada.

## Pontos para o seguranca
- Etapa 1 é o único ponto que gera HTML a partir do conteúdo: conferir `docsInline` (escape antes das trocas, conjunto fechado de tags, `href` só interno, nada de `on*`, sem `innerHTML` com texto da busca).
- Etapa 11: o link dentro do `#tip` sai de `LEIA_MAIS` (constante), montado com `createElement`/`textContent`; o `href` passa pela mesma regex interna.
- CSP (`src/server.js:37`) não muda: nada inline, nenhum CDN novo; Copiar usa `navigator.clipboard` só com o texto do bloco.
- Conteúdo das etapas 7 e 8 (manutenção, privacidade, P9): nenhum segredo, token, ID real do dono (usar `98765432101` e `seunome-20` como exemplos, como `public/ajuda.js` já faz), nenhum comando que imprima `data/wa_auth`, `.env` ou `settings`; o comando com `sudo` precisa estar correto e ter a nota "precisa da senha do computador".
- `localStorage` guarda só slugs de capítulos, nada pessoal.

## Riscos e como reverter
- Nome global repetido entre `docs.js`/capítulos e os scripts existentes quebra o painel inteiro (e o harness). Mitigação: prefixo `docs`, nenhuma declaração no topo dos `cap-*.js`, teste da etapa 1, `npm test` carrega tudo no `vm`. Reverter: `git revert` (sem banco, sem servidor).
- Texto do livro divergir do sistema depois: teste `FATOS`, selos e motivos conferidos; regra na seção "Docs que acompanham a mudança" do CLAUDE.md (texto abaixo).
- `ir()` mexer em todas as rotas: a mudança é só cortar no `/`; os testes de `rotaAtual()` (`test/qa.test.js:657-658`, que hoje exigem `ajuda` em `ROTAS` na linha 656) continuam e ganham casos novos.
- Etapa 2 sem a etapa 1 quebra a página: os grupos são sequenciais. Entre a etapa 2 e o grupo C, o livro mostra o conteúdo migrado da Ajuda (nada some para o usuário).
- Peso: ~100 KB a mais de JS por carga; local, sem efeito perceptível. Se incomodar, carregar os capítulos sob demanda é uma mudança só no motor.

## Perguntas em aberto e premissas adotadas
- P1 (lead/dono) — Comando exato da P9 e qual log guardava as chaves. Premissa: é o journal do serviço (`src/whatsapp.js:16`); a spec sugere `sudo journalctl --rotate && sudo journalctl --vacuum-time=1s` (não verificado; apaga o journal do sistema inteiro). Sem confirmação, a etapa 8 publica a resposta sem o comando.
- P2 (dono) — Operador vê o capítulo "Equipe e papéis" (spec, adotado) ou continua escondido como o cartão antigo? Adotado: vê, com selo "Só o Dono"; o servidor já barra as ações.
- P3 (dono) — Progresso por navegador (etapa 12) é desejado? É o item mais fácil de cortar: tirar a etapa 12 não afeta as outras.
- P4 (dono) — O README deve encolher e apontar para os Docs? Premissa: não nesta entrega; ganha só o parágrafo "Docs do painel".
- Premissas: menu "Docs", `h1` "Docs do sistema" (spec); sem capturas de tela; "Leitura: N min" calculado das palavras; P2 da spec (última frase da resposta sobre `meli.la`) só entra se o dev da etapa 8 confirmar em `src/ml.js`/`src/lojas.js`; senão sai.
- Para o lead, depois da aprovação, trocar no CLAUDE.md (seção "Docs que acompanham a mudança"): "`README.md`, os `TIPS` e `LEIA_MAIS` de `public/ajuda.js` e o capítulo do livro em `public/docs/cap-*.js` que trata da tela alterada; número novo ou alterado que apareça nos dois entra na tabela `FATOS` de `test/docs.test.js`." E na lista de `public/`: "`docs.js` (motor dos Docs) e `docs/cap-*.js` (capítulos)".

## Alinhamento com a spec
1. Endereços: `#docs/<cap>[/<secao>]`, como a spec prefere; nada de `?c=&s=`.
2. Slugs de capítulos e seções, ordem e numeração: os da spec, seção 1, sem mudança.
3. Conteúdo: a spec pede um `public/docs.js` com `CAPITULOS`, `PERGUNTAS` e `REFERENCIA`. O plano mantém o motor em `public/docs.js`, mas o conteúdo fica em 7 arquivos `public/docs/cap-*.js` para o trabalho em paralelo, e Perguntas e Referência viram capítulos-apêndice. Os campos de pergunta da spec (`pergunta`, `resposta`, `onde`, `leia`) viram `titulo`, `blocos`, `onde`, `leia` da seção: mesma informação, um só formato para o sumário, as âncoras e a busca.
4. Blocos: os da spec (`p`, `passos`, `nota`, `comando`, `tabela`, caminho em linha) mais `termos` (glossário em `dl`, exigido pelo teste do Operador) e `exemplo` (`pre` sem Copiar, para o formato de mensagem de origem). Marcação em linha: negrito, `code`, `kbd`, caminho e link interno.
5. `GLOSSARIO` sai de `ajuda.js` e vai para `cap-referencia.js` (seção `glossario`).
6. `LEIA_MAIS` com o nome e o mapa da spec; o teste fica em `test/qa.test.js`, como a spec sugere (etapa 11).
7. Equipe visível ao Operador com selo: adotado (P2 confirma).
8. Capítulo inexistente: estado da spec, endereço mantido; seção inexistente abre o capítulo no topo.
9. Sumário em `<details>` abaixo de 1100 px: o `main` tem `max-width:1040px` (`public/style.css:42`); 260 px + 32 px + `72ch` cabe sem `ROTAS_LARGAS`. Se não couber, a etapa 10 pede ao dev pôr `docs` em `ROTAS_LARGAS` (`public/app.js:678`).
10. `.sr-only` não existe hoje: entra na etapa 10.
11. Pendências da spec (P9, P2, P10, restaurar backup) estão nas perguntas acima e nas etapas 7 e 8.

## ADR-005: livro de Docs como dados JS em arquivos por capítulo
- Contexto: a Ajuda era uma página com textos crus em `innerHTML`. O livro precisa de trilha, âncoras, busca e conteúdo escrito por vários devs ao mesmo tempo, sem framework e com `script-src 'self'`.
- Decisão: motor `public/docs.js` e capítulos em `public/docs/cap-*.js` registrados por `docsCapitulo()`; texto com mini-marcação escapada antes de virar HTML; links só internos; rotas por hash com sub-caminho (`#docs/<cap>/<secao>`), o primeiro uso de `/` no hash do painel.
- Consequências: conteúdo validado por teste (estrutura, âncoras, fatos contra o código); novo capítulo = novo arquivo + uma linha em `DOCS_TRILHA` + um `<script>`; o README continua separado, amarrado pelo teste `FATOS`.

## Decisões do dono (04/11/2026)
- Plano e spec aprovados.
- P1: o comando de limpar o log é `sudo journalctl --rotate && sudo journalctl --vacuum-time=1s`, rodado num terminal comum (pede senha). Confirmado em uso real em 03/11/2026 (0 linhas com `privKey` depois). O texto avisa que apaga o histórico de logs do computador inteiro e recomenda reconectar o WhatsApp com QR novo. A causa (libsignal escrevendo a sessão no console) já está corrigida no código (`protegerConsole` em `src/whatsapp.js`).
- P2: "Equipe e papéis" visível também ao Operador, com o selo "Só o Dono" nas ações exclusivas.
- P3: progresso de leitura por navegador (`localStorage`), mantido.
- P4: README continua como referência técnica e ganha só um parágrafo apontando para os Docs.
- Menu "Docs"; sem capturas de tela nesta entrega.
- Windows: `iniciar.bat` (dois cliques), como no README.
