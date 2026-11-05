# Referência: Open API de Afiliados da Shopee (lida em 03/11/2026)

Resumo da documentação do portal de afiliados (`affiliate.shopee.com.br/open_api`), para o plano da integração da Shopee. Não confundir com a Open API de **vendedor** (`open.shopee.com`), que exige CNPJ e é para lojas/ERPs.

## Situação da conta do dono (03/11/2026)
- ID de afiliado: 18328801339.
- Página "Abrir API" mostra AppID e Senha vazios e o aviso de que a conta **não tem acesso** à Open API de Afiliados; o botão "Aplicar" está desabilitado.
- Pedido de acesso: formulário de atendimento indicado no erro 10035 da documentação — `https://help.shopee.com.br/portal/webform/bbce78695c364ba18c9cbceb74ec9091` (retorno em até 3 dias úteis).

## Chamada
- Endpoint único GraphQL: `POST https://open-api.affiliate.shopee.com.br/graphql`, `Content-Type: application/json`, corpo `{"query": "..."}`.
- Explorador: `https://open-api.affiliate.shopee.com.br/explorer/v2`.
- Limite: 8000 chamadas/hora.

## Autenticação
- Cabeçalho: `Authorization: SHA256 Credential=<AppId>, Timestamp=<unix s>, Signature=<hex>`.
- `Signature = sha256(AppId + Timestamp + Payload + Secret)` em hexadecimal minúsculo; `Payload` é o corpo JSON exato enviado.
- O timestamp não pode divergir mais de 10 min do servidor.
- O segredo equivale a senha.

## Funções úteis ao painel
- `productOfferV2(itemId:, shopId:, keyword:, sortType:, page:, limit:, ...)` → `nodes { itemId productName priceMin priceMax priceDiscountRate sales ratingStar imageUrl shopName productLink offerLink commissionRate ... } pageInfo { page limit hasNextPage }`. Busca por `itemId` + `shopId` serve para ler um produto colado (o link `shopee.com.br/...-i.<shopId>.<itemId>` traz os dois). Campo `price` está "to be removed": usar `priceMin`/`priceMax`. `priceDiscountRate` é inteiro (10 = 10%).
- `generateShortLink(input: { originUrl: "...", subIds: ["s1".."s5"] }) { shortLink }` (mutation) → link curto de afiliado.
- `shopeeOfferV2`, `brandOffer`, `conversionReport`, `validatedReport`: listas de ofertas e relatórios (paginação com `scrollId` válido por 30 s nos relatórios; 3 meses de histórico).

## Erros relevantes
- 10020: assinatura/credencial/timestamp inválidos ou app desativado.
- 10030: limite excedido.
- 10031–10034: acesso negado, ID de afiliado inválido, conta congelada, ID na lista negra.
- 10035: conta sem acesso à Open API (pedir pelo formulário acima).
- 11000/11001/11002: erro de negócio, de parâmetro e de vínculo de conta.

## Sem a Open API: "Link personalizado" do portal (capturado em 03/11/2026)
Teste feito com o consentimento do dono, na sessão dele, convertendo 1 link público (`https://shopee.com.br/Apple-Iphone-11-128GB-Local-Set-i.52377417.6309028319`) → `https://s.shopee.com.br/9fMB7wrS3r` (HTTP 200). Nenhum cookie nem cabeçalho de sessão foi registrado.
- Página: `https://affiliate.shopee.com.br/offer/custom_link` (Oferta → Link personalizado). Converte até 5 links por vez; Sub_id 1..5 opcionais (só alfanumérico). Aceita página inicial, página de produto, de campanha, de loja e de categoria.
- Requisição: `POST https://affiliate.shopee.com.br/api/v3/gql?q=batchCustomLink`, JSON:
  ```json
  {
    "operationName": "batchGetCustomLink",
    "query": "query batchGetCustomLink($linkParams: [CustomLinkParam!], $sourceCaller: SourceCaller){ batchCustomLink(linkParams: $linkParams, sourceCaller: $sourceCaller){ shortLink longLink failCode } }",
    "variables": { "linkParams": [{ "originalLink": "<url da Shopee>", "advancedLinkParams": { "subId1": "<Sub_id>" } }], "sourceCaller": "CUSTOM_LINK_CALLER" }
  }
  ```
- Resposta: por link, `shortLink` (ex.: `https://s.shopee.com.br/…`), `longLink` e `failCode`.
- Autenticação: a sessão do navegador no `affiliate.shopee.com.br` (cookies). O cliente da página é um axios próprio que pode acrescentar cabeçalhos (ex.: token anti-CSRF lido de cookie) — **a confirmar** pela extensão antes de implementar. Sub_id: `advancedLinkParams` é `{ "subId1": "<Sub_id>" }` (Sub_id 1 do formulário; só alfanumérico) e, sem Sub_id, a página omite o campo — capturado em 05/11/2026, ver `docs/produto/referencias/relatorios-dos-portais.md` (Shopee, P4). Não é necessário para gerar o link.
- É endpoint interno (não documentado): pode mudar sem aviso, como a Central de Afiliados do ML. Mesmo modelo de risco da extensão atual.

### Cabeçalhos do "Link personalizado" (confirmado em 03/11/2026, só nomes — nenhum valor registrado)
Lido no código JavaScript da própria página (somente leitura) e com um `GET` inofensivo:
- Em todo `POST` à API do portal, o cliente da página acrescenta o cabeçalho **`CSRF-token`**. O valor vem do cabeçalho de resposta **`csrf-token`** das respostas da API do portal (a página guarda o último recebido) ou, na falta dele, da configuração `csrf_token`. Confirmado: `GET https://affiliate.shopee.com.br/api/v3/config/website` (com a sessão) responde 200 e traz o cabeçalho `csrf-token`. Existe também o cookie `csrftoken`.
- Toda requisição leva também o cabeçalho **`Affiliate-Program-Type`**, com um valor fixo do tipo de programa "normal" (o valor exato não foi extraído; descobrir no teste manual com o dono, ex.: inspecionando a requisição de "Obter link" no DevTools, ou testar se o pedido funciona sem ele).
- Sequência sugerida para a extensão: (1) `GET /api/v3/config/website` com `credentials: 'include'` → ler o cabeçalho `csrf-token`; (2) `POST /api/v3/gql?q=batchCustomLink` com `Content-Type: application/json`, `CSRF-token: <valor lido>` e `Affiliate-Program-Type: <valor>`; (3) se a resposta trouxer novo `csrf-token`, usar esse nas próximas. Nunca registrar os valores em log.
