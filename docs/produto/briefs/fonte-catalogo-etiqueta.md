# Brief: fonte "catalogo" (API do Etiqueta) no Achadinho Turbo

- Data: 2026-11-03
- Origem: pedido do dono, transcrito pelo lead.
- Contrato da API (ler inteiro antes de planejar): `~/Documentos/mensagensParaEnviar/docs/produto/referencias/api-ofertas.md` (repositório do Etiqueta: **somente leitura**, nada é alterado lá).

## Objetivo
O Achadinho Turbo passa a usar o Etiqueta (outro app do dono, em `~/Documentos/mensagensParaEnviar`, servidor `python3 servidor.py` em `http://localhost:8765`) como uma nova **fonte de ofertas**, além das lojas já usadas (Mercado Livre, Amazon e Shopee). No Turbo, "etiqueta" já significa a etiqueta de afiliado do ML: a fonte nova se chama **"catalogo"** para não confundir.

## A API do Etiqueta (pronta e ligada)
- Rotas, só GET: `/api/v1/categorias` (abas com total por loja) e `/api/v1/ofertas` (filtros `cat`, `loja`, `q`, `desconto_min`, `limite` máx. 200, `ordem`; paginação por cursor no campo `proximo`).
- Autenticação: cabeçalho `Authorization: Bearer <token>`. O token está em `~/Documentos/mensagensParaEnviar/api_token.txt`: o Turbo lê o arquivo (caminho configurável no cartão de Conexões). **Nunca** imprimir, logar, pôr em URL, no git nem pedir ao dono para colar no chat.
- A API barra navegador: pedido com cabeçalho `Origin` ou `Sec-Fetch-Site` dá 403. Só o servidor Node chama (o `fetch` do Node 22 serve); nunca o front.
- Sem token válido no Etiqueta → 503; token errado → 401. Os dois viram "fonte indisponível", sem derrubar o Turbo.

## O que o dono quer
1. Fonte nova "catalogo" que entra junto das lojas nas regras e nos candidatos (`candidatesFor` em `src/ml.js` é o ponto de encaixe sugerido pelo contrato).
2. Cartão "Etiqueta" em Conexões: endereço (padrão `http://localhost:8765`), caminho do arquivo do token, botão "Testar" (chama `/api/v1/categorias`) e as categorias do Etiqueta para escolher nas regras.
3. Sem repetição: dedupe pela "chave" da oferta em `sent_offers`, como as outras fontes. Para pegar só novidades, guardar o último `proximo` **não nulo**; resposta vazia com `proximo` null não apaga o cursor. Varrer do zero quando o contrato mandar (seção "Paginação" do contrato). `limite=200`, sem pedidos em paralelo (cada um custa ~0,5 s no Etiqueta).

## Ajustes obrigatórios no Turbo (do guia do contrato)
- `src/scheduler.js:99`: a regra exige etiqueta do ML. Regra de catálogo só com Amazon e/ou Shopee dispensa a etiqueta.
- `src/scheduler.js:113`: hoje todo link é gerado de novo pela extensão. Para a fonte catalogo:
  - Amazon: usar o `link` como veio (a tag `desejodemen01-20` já é conferida pelo Etiqueta).
  - Mercado Livre: gerar o link de novo com a etiqueta do dono (`achadosmenicas`) via `requestLink`, ou exigir revisão antes de enviar. O Etiqueta só confere o formato `meli.la`, não de quem é a etiqueta.
  - Shopee: usar o `link` como veio, mas com **revisão antes de enviar** (o `s.shopee.com.br` não prova de quem é a conta).
- `src/scheduler.js:121`: hoje só aceita foto do CDN do ML. Liberar também os CDNs da Amazon e da Shopee (`src/lojas.js` já tem `IMAGEM_AMAZON` e `IMAGEM_SHOPEE`).
- Suporte à loja "shopee" vinda do catálogo. (Nota do lead: desde o commit `f59aaca` de 03/11 a Shopee está `implementada: true` no Disparo manual e em Conexões; o pedido do dono foi escrito antes disso.)

## Regras de segurança e dados
- Todo link enviado tem que ser de afiliado. Nunca trocar um link de afiliado por um link comum.
- Os textos (`titulo`, `busca`, `categoria`, `cupom`) vêm crus: escapar antes de pôr em HTML.
- Testes não chamam o Etiqueta real nem leem o `api_token.txt` real: servidor falso com respostas no formato do contrato.
- Há 5 produtos da Amazon no Etiqueta com preço antigo mil vezes maior que o preço (aparecem com 100% de desconto). `desconto_pct` 100 é suspeito: não anunciar "100% OFF" sem revisão.

## Critérios de aceite
- CA1 — Regra com fonte "catalogo" (categoria do Etiqueta, loja opcional, filtros) gera candidatos pela API e envia ofertas aos grupos como as outras fontes; `sent_offers` evita repetição pela "chave".
- CA2 — Cartão "Etiqueta" em Conexões com endereço, caminho do token, "Testar" (`/api/v1/categorias`) e estado (conectada / indisponível 503 / token recusado 401 / sem arquivo); as categorias aparecem na regra.
- CA3 — Cursor: guarda o último `proximo` não nulo; vazio com `proximo` null mantém o cursor; varredura do zero conforme o contrato; `limite=200`; nunca em paralelo.
- CA4 — Link por loja: Amazon como veio; ML regenerado com a etiqueta da regra (`requestLink`) ou revisão; Shopee com revisão antes de enviar. Nenhum link comum (não afiliado) sai.
- CA5 — Fotos dos CDNs do ML, Amazon e Shopee aceitas; outras recusadas.
- CA6 — Regra de catálogo só com Amazon/Shopee dispensa a etiqueta do ML.
- CA7 — `desconto_pct` 100 (ou preço antigo ≥ 10× o preço) vai para revisão, nunca sai como "100% OFF" automaticamente.
- CA8 — Token nunca em log, resposta, URL, erro, console ou git; 401/503/rede = "fonte indisponível" sem derrubar o serviço; o front nunca chama o Etiqueta.
- CA9 — Textos crus escapados no painel; `npm test` sem rede e sem ler o token real.

## Verificação final pedida pelo dono
Rodar o Turbo localmente com o código novo, testar a conexão contra o Etiqueta de verdade (só leitura) e informar quantas ofertas do catálogo ficaram disponíveis por categoria e loja.
