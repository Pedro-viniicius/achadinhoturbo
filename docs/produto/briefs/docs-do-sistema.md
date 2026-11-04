# Brief: "Docs do sistema" — a Ajuda vira um livro digital com trilha de aprendizado

- Data: 2026-11-04
- Origem: pedido do dono, transcrito pelo lead.

## Pedido
"Coloca todas essas questões em ajuda ou muda o nome até para docs do sistema e deixa como um livro digital, para a pessoa aprender sobre o sistema, deixa pragmático. Os insights são das pessoas mesmo. Deixe semelhante a docs de linguagens, que têm toda uma trilha para aprender."

## Objetivo
Transformar a página **Ajuda** do painel (`public/ajuda.js`, rota `#ajuda`) em **Docs do sistema**: um livro digital navegável, no estilo das documentações de linguagens (ex.: um "tour"/"book" com capítulos em sequência, sumário lateral, anterior/próximo), pragmático (o que fazer, onde clicar, o que esperar), para alguém que nunca usou o Achadinho Turbo aprender do zero e para quem já usa tirar uma dúvida rápida.

## Princípios
- **Trilha de aprendizado:** capítulos em ordem (do primeiro acesso ao uso avançado), cada um curto, com "o que você vai aprender", passos, e "próximo capítulo".
- **Pragmático:** frases curtas, passo a passo com o caminho exato no painel (*Conexões → Amazon*), exemplos reais, avisos de erro comum. Sem teoria além do necessário.
- **Os insights são das pessoas:** um capítulo/seção de **Perguntas reais** com as dúvidas que o dono teve de fato, respondidas de forma direta (lista abaixo). A estrutura deve facilitar acrescentar novas perguntas depois.
- **Referência à parte:** glossário, estados dos cartões, motivos de revisão, limites (por hora, teto da revisão, retenção) — consultáveis sem ler o livro inteiro.
- Os `?` (TIPS) espalhados pelo painel continuam e, quando fizer sentido, levam ao trecho do livro ("Ler mais").
- O nome no menu passa de "Ajuda" para **"Docs"** (ou "Docs do sistema"); o endereço antigo `#ajuda` continua funcionando.
- O conteúdo tem de bater com o comportamento real (README é a outra fonte; os dois devem dizer a mesma coisa).

## Perguntas reais do dono (03–04/11/2026) — devem virar conteúdo
1. Cadastrei a tag da Amazon e o painel diz que falta: onde ela vai? (cartão Amazon em Conexões, não nas etiquetas do ML).
2. O link `meli.la` não lê o produto: por quê? (página de afiliado social; o painel agora lê e gera o link pelo produto).
3. Preciso da API da Shopee e da Amazon? O Mercado Livre já funciona? (o que funciona sem API em cada loja; o que a API acrescenta; requisitos: 10 vendas na Amazon, pedido de acesso na Shopee).
4. Meu ID de afiliado da Shopee vai no AppID? (não; ID de afiliado × AppID × Senha da API).
5. Onde conecto o catálogo do Etiqueta? (Conexões → Catálogo do Etiqueta; na regra, marcar "Catálogo (app Etiqueta)").
6. "Etiqueta desta fonte" é o app Etiqueta? (não: é a etiqueta de afiliado do Mercado Livre — "Etiqueta ML").
7. Dá para usar só o catálogo, sem misturar com a Central de Afiliados? (sim: fonte única Catálogo; a Etiqueta ML só gera o link do ML; opcional se só Amazon/Shopee).
8. Os links do catálogo já são meus; por que o Turbo gera de novo / pede revisão? (segurança: meli.la e s.shopee não provam a conta; a comissão é sua do mesmo jeito; o que muda na prática).
9. Como limpar o log antigo com as chaves do WhatsApp? (comando com sudo num terminal comum; reconectar o WhatsApp com QR novo).
10. Como rodar/ver o painel localmente? (serviço do systemd, `http://localhost:3737`, recarregar com Ctrl+Shift+R).

## Critérios de aceite
- CA1 — O menu mostra "Docs" e a página abre num livro com sumário (trilha em capítulos), navegação anterior/próximo e endereço por capítulo (link direto para um capítulo funciona e pode ser compartilhado dentro do painel).
- CA2 — A trilha cobre, em ordem: primeiros passos (login, WhatsApp, extensão), conexões (ML, Amazon, Shopee, Catálogo do Etiqueta), Disparo manual, Disparo automático (fontes, Catálogo), espelhamento da Amazon, revisão (Histórico → Catálogo), grupos/rotacionador/blocos, relatórios e avisos, equipe e papéis, privacidade e segurança, manutenção (backup, logs, reconectar).
- CA3 — Capítulo "Perguntas reais" com as 10 perguntas acima, cada uma com resposta curta e o caminho no painel; fácil de acrescentar novas.
- CA4 — Referência: glossário (etiqueta ML × app Etiqueta × Catálogo × tag da Amazon × ID de afiliado da Shopee), estados dos cartões de Conexões, motivos de revisão, limites e números.
- CA5 — Busca simples no livro (filtra capítulos/seções por texto) — se o plano achar que cabe.
- CA6 — `#ajuda` continua abrindo (redireciona para Docs); os `?` continuam funcionando.
- CA7 — Acessível (WCAG 2.2 AA), 375 e 1280 px, temas claro e escuro, sem dependência nova (painel sem framework).
- CA8 — Conteúdo coerente com o código e o README; `npm test` verde (o `test/qa.test.js` exige verbete para todo `q()`).
