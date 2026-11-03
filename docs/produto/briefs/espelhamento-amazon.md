# Brief: espelhamento de ofertas da Amazon com mensagem completa

Pedido do dono em 02/11/2026, transcrito pelo lead. Nada aqui foi decidido pela equipe ainda.

## Problema

O dono usa o Analytics Lead para espelhar ofertas de um grupo de origem de WhatsApp para o grupo "⚡ Achadinhos Tech | Eletrônicos". Na Amazon, essa ferramenta só busca os dados na loja para Mercado Livre e Shopee; para Amazon ela usa só o texto da mensagem. Como os grupos de origem postam só o link (ex.: `https://link.amazon/B06BR9eEZ`), a oferta chega no grupo do dono só com "🛒 Compre aqui: <link>", sem título, preço nem desconto.

## O que o dono quer

Que o achadinhoturbo:

1. Monitore um ou mais grupos de origem que o dono escolhe no painel.
2. Detecte links da Amazon em qualquer formato: `link.amazon`, `amzn.to`, `amzn.com`, `amazon.com.br/dp/...`, `amazon.com.br/<slug>/dp/...`, com ou sem parâmetros.
3. Resolva o link curto e extraia o ASIN.
4. Busque título, preço atual, preço antigo, desconto e imagem principal pela API OFICIAL de afiliados da Amazon (Product Advertising API ou a que a substituiu; o arquiteto deve conferir na documentação oficial qual é a vigente hoje e quais são os requisitos de acesso).
5. Gere o link com a etiqueta de afiliado do dono (configurável no painel, em Conexões, junto das outras lojas).
6. Monte a mensagem com um template configurável, no mesmo estilo dos envios que o sistema já faz:

   ```
   *{TITULO_PRODUTO}*

   😱 De ~{PRECO_ANTIGO}~
   🔥 Por *{PRECO_PRODUTO}* ({DESCONTO_PRODUTO} OFF)
   🚚 {FRETE}
   🎟️ Cupom: *{CUPOM}*

   🛒 Compre aqui: {LINK}
   ```

   Linha sem valor some sozinha; se faltar só parte (ex.: o desconto), só esse pedaço sai.
7. Envie como imagem com legenda para os grupos de destino escolhidos, respeitando o ritmo de envio e a deduplicação (não repetir a mesma oferta em X horas, configurável).
8. Tenha uma lista de palavras para NÃO espelhar (ex.: "usado", "recondicionado"), sem diferenciar maiúscula, minúscula ou acento.

## Regras e limites

- Nada de raspar o HTML da Amazon (vai contra as regras do programa de Associados e quebra fácil). Só a API oficial.
- Se a API não estiver disponível (conta sem acesso, cota estourada, erro), usar os dados escritos na própria mensagem de origem (título e preços em texto, se houver). Se não houver nada, enviar no formato curto e registrar o motivo no log da regra, ou deixar a oferta "na fila" para o dono completar o preço à mão no painel, à escolha do arquiteto.
- Modo manual no painel: o dono cola um link da Amazon e o sistema preenche o que conseguir pela API, o dono ajusta e envia ou agenda.
- Mensagens enviadas pelo próprio número conectado também devem poder ser espelhadas (opção na regra), porque às vezes o grupo de origem é do dono.
- As credenciais da API e a etiqueta são segredos: ficam na coluna `segredos` de `conexoes`, nunca em log nem em mensagem de erro.
- Participantes do grupo de origem continuam como pseudônimos (LGPD); o log usa nome do grupo, nunca número.
- Testes sem chamar a Amazon nem o WhatsApp reais: API da Amazon simulada, WhatsApp em dry-run, links falsos.

## Critérios de aceite (o arquiteto pode refinar)

- CA1: um link `link.amazon` postado no grupo de origem chega no destino com título, preço, desconto e imagem quando a API responde.
- CA2: o link enviado sempre leva a etiqueta do dono.
- CA3: sem acesso à API, a oferta usa o texto da mensagem ou cai no comportamento de fallback definido, com o motivo registrado.
- CA4: a mesma oferta não é reenviada dentro da janela de deduplicação.
- CA5: ofertas com palavra bloqueada são descartadas e aparecem no registro como descartadas.
- CA6: o modo manual preenche os dados pelo link e permite editar antes de enviar.
- CA7: nenhum segredo aparece em log, erro ou resposta do painel.

## Pergunta do dono antes de planejar

Se a conta de Associados precisa de algum requisito para usar a API (ex.: número mínimo de vendas) e o que ele precisa pegar na Central de Associados (chaves, etiqueta, região).

## Aprendizados de 02/11/2026

O dono testou o espelhamento da Amazon no Analytics Lead e registrou o resultado em `../referencias/espelhamento-amazon.md`. Em resumo: mensagens do próprio número não são espelhadas (a opção `fromMe` nasce desligada); o `link.amazon` só resolve com `GET` seguindo redirecionamentos (o `HEAD` dá 404) e o código dele não é o ASIN; o link reenviado deve ser limpo (`amazon.com.br/dp/<ASIN>?tag=<etiqueta>`), sem rastreio de terceiros; o parser do texto da origem é o caminho principal sem API, com o formato de mensagem que funcionou como fixture; URL nunca vira cupom; e sem preço antigo não se inventa "De".

## O que o lead já apurou (02/11/2026, a confirmar pelo arquiteto)

- A Product Advertising API 5.0 foi aposentada pela Amazon no primeiro semestre de 2026 (a documentação cita 30/04 ou 15/05/2026). A substituta é a **Creators API** (`affiliate-program.amazon.com/creatorsapi/docs`), com as operações `GetItems`, `SearchItems`, `GetVariations` e `GetBrowseNodes`.
- A página oficial da Creators API diz que o acesso exige conta de Associados aprovada no marketplace de destino e **pelo menos 10 vendas qualificadas nos últimos 30 dias**. As credenciais são criadas na Central de Associados (aplicativo → credencial; até duas credenciais por aplicativo).
- No código, a loja `amazon` já existe em `src/lojas.js` com `implementada: false` e o campo `tag`; o `whatsapp.js` não tem ouvinte de mensagens recebidas (`messages.upsert`), só de participantes, leituras e grupos.
