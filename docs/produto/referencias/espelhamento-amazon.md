# Referência: o que o dono aprendeu testando o espelhamento da Amazon no Analytics Lead

Registro do dono em 02/11/2026, transcrito pelo lead. Serve de referência para a feature de espelhamento Amazon do achadinhoturbo (brief em `../briefs/espelhamento-amazon.md`).

## O que foi testado e o resultado

1. **Mensagem do próprio número conectado não é espelhada.** O Analytics Lead ignora mensagens enviadas pelo número que captura. Só funcionou quando outro número postou no grupo de origem.
   → No achadinhoturbo: opção na regra "espelhar também as minhas mensagens" (`fromMe`), **desligada por padrão**, para evitar loop quando o grupo de destino também é monitorado.

2. **Link sozinho não gera mensagem completa.** Para Amazon o Analytics Lead não busca dados na loja (só faz isso para Mercado Livre e Shopee). Com "Origem dos valores: Da loja", uma mensagem só com `https://link.amazon/...` saiu apenas como "🛒 Compre aqui: <link>". O título e a foto que o WhatsApp mostra são a prévia do link, não estão no texto da mensagem.

3. Com "Origem dos valores: Da mensagem" e `link.amazon`, o link caiu no campo `{CUPOM}` e não foi convertido para a etiqueta do dono.

4. **O formato que funcionou** (título, preços, frete e link com etiqueta):

   ```
   Roteador Mesh TP-Link Deco BE22, Wi-Fi 7, Pack com 3 Unidades
   De R$ 1.999,00
   Por R$ 1.310,05
   34% OFF
   +200 compras no mês passado
   Frete Grátis
   Compre aqui: https://www.amazon.com.br/dp/B0FG2MD49G
   ```

   Regras que fizeram diferença:
   - link **longo** no formato `https://www.amazon.com.br/dp/<ASIN>`, não o `link.amazon`;
   - "Compre aqui:" antes do link;
   - uma informação por linha: título na 1ª, "De R$", "Por R$";
   - sem "De" quando a página não mostra preço antigo (não inventar preço de referência).

5. **Deduplicação:** a regra descarta a mesma oferta enviada nas últimas 168 h ("Repetidas"). Testes repetidos com o mesmo produto parecem falha, mas foram descartados. Teste sempre com produto novo.

6. **Destino errado:** numa das tentativas a oferta foi para o próprio grupo de origem. Conferir os destinos da regra.

## Detalhe técnico sobre `link.amazon`

- `HEAD` em `https://link.amazon/<código>` responde 404; `GET` com User-Agent de navegador e seguindo redirecionamentos chega em `https://www.amazon.com.br/<slug>/dp/<ASIN>?...&tag=<etiqueta>&...`.
- O ASIN sai do trecho `/dp/<ASIN>` (10 caracteres). O código do `link.amazon` **não** é o ASIN.
- O link final traz a etiqueta de quem gerou o link (no teste, uma etiqueta de terceiro) e vários parâmetros de rastreio (`crid`, `dib`, `sr`, `qid`, `linkId`, `ascsubtag`...). Ao reenviar, montar um link limpo `https://www.amazon.com.br/dp/<ASIN>?tag=<etiqueta do dono>`, sem os parâmetros de rastreio de terceiros.

## O que isso muda na feature

- O parser de "valores da mensagem" precisa reconhecer: título (1ª linha sem preço nem link), "De R$ x", "Por R$ y", "NN% OFF", linha de vendas, "Frete Grátis", cupom só quando houver a palavra "cupom" seguida de um código (nunca uma URL).
- Toda URL de loja na mensagem é tratada como link do produto, nunca como cupom.
- Sem a API oficial, esse parser é o caminho principal para a Amazon; com a API, os dados da API têm prioridade e a mensagem serve de fallback.
- Testes: incluir as mensagens de exemplo acima como fixtures (link curto, link longo, com e sem "De", com "Compre aqui:").
