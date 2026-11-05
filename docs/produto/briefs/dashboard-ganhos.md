# Brief: rastreio por grupo e Dashboard de ganhos (comissões por grupo)

- Data: 2026-11-04
- Origem: pedido do dono, transcrito pelo lead. Cartões do Trello "Operação corretor Mundial": 🔴 08 "ID de rastreio por grupo e canal nos links" e 🟡 12 "Dashboard de ganhos: comissões por grupo". O 12 depende do 08, por isso os dois formam um bloco só.
- Pedido: "Começa fazer até finalizar esse bloco então, mas não sobe nada, deixa o sistema rodando… usa a equipe e faz orientado TDD Tradicional (Desenvolvedor / Unitário) e a MDD (Metric-Driven Development)."
- Referências: arquitetura "fisga" do dono (caixas P1 "Conversor de link: tag de afiliado + ID de rastreio por grupo", P2 "Dashboard Turbo: cliques, ganho por clique e membros por grupo", P2 "Importador: junta as comissões dos programas e os cliques") e pontos cegos "O dashboard precisa de rastreio" (P1) e "Medir além do clique" (P2).

## Restrições de execução (do dono)
- **Nada sobe** até o dono liberar (depois das 22h, com tudo verde em versão de teste). O serviço do dono roda da pasta `~/Documentos/achadinhoturbo` com `--watch-path=src`: **ninguém edita lá**. Todo o trabalho é na cópia `~/Documentos/achadinhoturbo-ganhos` (ramo `feature/dashboard-ganhos`).
- **TDD tradicional:** em cada etapa, o teste unitário que falha vem antes do código (vermelho → verde → refatorar).
- **MDD (Metric-Driven Development):** as métricas do dashboard são definidas **antes** do código, cada uma com nome, fórmula, fonte do dado, granularidade, meta/uso e um teste com dados conhecidos que prova o número. Métricas de saúde do próprio rastreio também (ex.: cobertura).

## Problema
Hoje dá para ver quanto vendeu em cada loja, mas não **em qual grupo**. O Turbo mede cliques no rotacionador e entradas/saídas, mas não liga envio → clique → venda → comissão. Sem isso o dono não sabe qual grupo, nicho ou oferta dá lucro, nem quanto custa trazer cada membro.

## O que o dono quer
1. **Rastreio por grupo nos links** (cartão 08):
   - **Shopee:** Sub_id identificando o grupo (ou bloco) no link de afiliado. O "Link personalizado" (extensão, `batchCustomLink`) aceita Sub_id 1..5 alfanuméricos (`advancedLinkParams`, formato exato ainda não capturado: ver `docs/produto/referencias/shopee-api-afiliados.md`); a Open API aceita `subIds` em `generateShortLink`.
   - **Amazon:** um ID de rastreamento (tag) por grupo ou nicho, criado pelo dono na Central de Associados (até 100 por conta), configurado no Turbo; sem configuração, usa a tag padrão `desejodemen01-20`.
   - **Mercado Livre:** etiqueta (`meli.la`) por grupo ou bloco, quando o dono quiser separar.
   - Guardar no banco qual link (com qual código) foi para qual grupo, em qual envio.
2. **Importar comissões** (cartão 12): relatórios de cada programa (Amazon Associados, Shopee Afiliados, Mercado Livre) entram no Turbo, de preferência por arquivo exportado do portal (CSV), sem depender de API. A API da Shopee está em pedido de acesso; a Creators API da Amazon exige 10 vendas/30 dias.
3. **Dashboard de ganhos:** receita/comissão por grupo, bloco, loja, oferta e período; ganho por clique; conversão; custo por membro (gasto com anúncios informado pelo dono); cobertura do rastreio.

## Critérios de aceite
- CA1 — Todo envio de oferta (disparo automático, manual, catálogo, espelhamento) registra, por grupo de destino, a loja, o link enviado, o código de rastreio usado (ou "sem código") e a hora.
- CA2 — Shopee: o link enviado a cada grupo leva o Sub_id daquele grupo (ou bloco) quando a geração aceitar; se não aceitar, o link sai como hoje (sempre de afiliado) e a falta conta na métrica de cobertura.
- CA3 — Amazon: o dono associa um ID de rastreamento a um grupo ou bloco; o link desse grupo usa esse ID; sem associação, a tag padrão. Nunca sai link sem tag.
- CA4 — Mercado Livre: o dono pode associar uma etiqueta a um grupo ou bloco; o link `meli.la` desse grupo é gerado com ela. Sem associação, vale a etiqueta da regra (como hoje).
- CA5 — Importar o relatório de comissões de cada loja pelo painel (arquivo exportado), tolerante a colunas extras e a ordem, sem duplicar a mesma linha ao importar de novo, guardando só o necessário (nada de nome, endereço ou telefone de comprador).
- CA6 — Dashboard com as métricas do catálogo MDD por grupo, bloco, loja, oferta e período, incluindo cobertura do rastreio e custo por membro (gasto de anúncio informado à mão por período e grupo/bloco).
- CA7 — MDD: catálogo de métricas no plano (nome, fórmula, fonte, granularidade, meta) e um teste por métrica com dados conhecidos.
- CA8 — TDD: cada etapa começa por teste que falha; `npm test` verde; nenhum teste chama loja, Etiqueta ou WhatsApp reais.
- CA9 — Nenhum link de afiliado é trocado por link comum; nenhuma mudança de comportamento para quem não configurar nada (sem associação, tudo sai como hoje).
- CA10 — Docs acompanham: README, `TIPS`/`LEIA_MAIS` de `public/ajuda.js`, capítulo do livro em `public/docs/`, tabela `FATOS` para números novos.
- CA11 — Segurança e LGPD: arquivo importado validado (tamanho, tipo, conteúdo), sem dado pessoal de comprador guardado, sem segredo em log; só Dono importa e mexe em associação.

## O que depende do dono (fora do código)
- Criar os IDs de rastreamento na Amazon (Central de Associados → Gerenciar IDs de rastreamento) e, se quiser, etiquetas extras no ML.
- Baixar um relatório de exemplo de cada portal (Amazon, Shopee, Mercado Livre) para fixar o formato real das colunas.
- Informar o gasto com anúncios, se quiser o custo por membro.
