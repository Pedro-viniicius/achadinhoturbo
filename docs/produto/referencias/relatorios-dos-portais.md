# Relatórios dos portais (P4 e P5): o que foi visto de verdade

Capturado pelo lead em 05/11/2026, na sessão do dono no navegador e com a autorização dele. Nenhum arquivo foi salvo em disco; foram lidas só as linhas de cabeçalho e uma linha de exemplo. Os valores abaixo vêm das contas do dono e não identificam comprador.

## Shopee Afiliados (affiliate.shopee.com.br)

**P4, Sub_id no "Link personalizado"** (Oferta → Link personalizado). Corpo de `POST /api/v3/gql?q=batchCustomLink` com Sub_id 1 = `turboteste1`:

```json
{"operationName":"batchGetCustomLink","query":"query batchGetCustomLink($linkParams: [CustomLinkParam!], $sourceCaller: SourceCaller){ batchCustomLink(linkParams: $linkParams, sourceCaller: $sourceCaller){ shortLink longLink failCode } }","variables":{"linkParams":[{"originalLink":"https://shopee.com.br/...","advancedLinkParams":{"subId1":"turboteste1"}}],"sourceCaller":"CUSTOM_LINK_CALLER"}}
```

- A resposta trouxe um `shortLink` válido (`https://s.shopee.com.br/…`).
- Sem Sub_id, a página omite `advancedLinkParams`.
- A página diz "Somente valor alfanumérico (a-z, A-Z, 0-9)" e "até 5 Sub_ids". O campo não tem `maxlength`, então o limite de tamanho continua não verificado.

**Relatório de cliques** (Relatório → Relatório de cliques):
- Tem **uma linha por clique**, sem coluna com o total.
- Colunas na tela: `ID dos Cliques`, `Período dos Cliques`, `Região dos Cliques`, `Sub_id`, `Referenciador`.
- Tem o botão "Exportar", desligado sem dados.
- O cabeçalho do arquivo exportado **não foi visto**, porque a conta não tem cliques no período.

**Relatório de vendas** (Relatório → Relatório de vendas):
- Sem vendas de 01/09 a 03/11/2026. "Exportar" desligado.
- A tela agrupa as colunas assim: `Detalhes de pedido`, `Informação da loja`, `Informação do item`, `Informações da Oferta`, `Valor da compra`, `Comissão do item`…
- Filtros: horário do pedido, status do pedido, ID do pedido, loja, produto.
- O cabeçalho do arquivo exportado **não foi visto**.

## Amazon Associados (associados.amazon.com.br)

Relatórios → Fazer download de relatórios: escolhe-se o período, o ID de rastreamento (`Tudo` ou um ID) e o formato (XLSX, CSV ou XML).

- **O CSV vem dentro de um ZIP** (`PK\x03\x04`), com um único arquivo `<n>-<Tipo>-<uuid>-CSV.csv`.
- Nos últimos 30 dias: 245 cliques, 0 pedidos, R$ 0.

**"Produto relacionado"** (`Linked-Product`):
- Cabeçalho **em inglês**:
  `Date,Category,Product Title,ASIN,Clicks,Indirect Items Ordered,Direct Items Ordered,Items Ordered,Direct Conversion Rate,Order Quantity,Product Conversion Rate,Order Conversion Rate,Commission Rate,Ordered Revenue,Items Shipped,Items Returned,Items Shipped Revenue,Items Shipped Earnings,Items Returned Revenue,Items Returned Earnings,Total Earnings`
- Exemplo: `11-04-2026,-,-,Other,245.0,0.0,0.0,0.0,0,0.0,0,0,-,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0`.
  - **Data em MM-DD-AAAA** (11-04-2026 = 4 de novembro).
  - Números com ponto decimal (`245.0`).
  - `-` para vazio.
  - Uma linha "Other" junta os cliques sem produto.
- Não há coluna de ID de rastreamento por linha. Para separar por grupo, gera-se o relatório filtrado por ID e usa-se o "Código do arquivo".

**"ID de rastreamento"** (`Tracking-Id`):
- Cabeçalho **em português**:
  `Número de rastreamento,cliques,produtos pedidos,receita solicitada,produtos enviados,produtos devolvidos,receita de produtos enviados,receita de produtos devolvidos,ganhos totais,bônus,ganhos de produtos enviados,ganhos de produtos devolvidos`
- Exemplo: `desejodemen01-20,157.0,-,-,-,-,-,-,-,0.0,-,-`.
- **Sem coluna de data**: é um total do período por ID.

## Mercado Livre (Central de afiliados e criadores → Métricas)

- **Não foi achado botão de exportar.** A página só mostra os números e a tabela na tela.
- Abas da tabela: `Vendas`, `Produtos vendidos`, `Categorias`, `Etiquetas de rastreamento`, `Data`, `Audiências`.
- Venda na aba "Vendas":
  - data (`01/nov`), número do pedido (`#2000…`), produto e categoria, loja;
  - valor da venda e unidades, ganho por venda (`Venda direta: 5%`);
  - estado (`EM REVISÃO`).
- **A venda não diz de qual etiqueta veio.** A separação por etiqueta fica só na aba "Etiquetas de rastreamento".
- Número visto entre 28/10 e 3/11: 68 cliques, 1 pedido, R$ 98,78 em vendas e R$ 4,05 de ganho estimado.
