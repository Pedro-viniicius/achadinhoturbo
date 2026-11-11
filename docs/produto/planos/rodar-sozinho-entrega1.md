# Plano técnico: Rodar sozinho · Entrega 1 (Amazon conferida na hora, vaga reposta, fim do `nao_conferido` na revisão)
- Brief: docs/produto/briefs/rodar-sozinho.md (seção "Entrega 1", "Escolhas minhas", "O que seria fracasso", "Restrições")
- Spec: docs/produto/specs/rodar-sozinho-entrega1.md (textos; alinhamento no fim)
- Data: 2026-11-11

## Objetivo e critérios de aceite
Antes de enviar uma oferta da Amazon do catálogo, o Turbo pede ao Etiqueta para reler a página daquele produto. Se a releitura falha, vale o preço confirmado há até 6 h. A vaga perdida é reposta, e falha técnica deixa de mandar oferta para a revisão. CA1.1 a CA1.13 valem como estão no brief (não copio o texto para não divergir). Também são requisito as seções "Escolhas minhas", "Fracasso" e "Restrições".

## Contexto atual
- Escolha com tamanho fixo: `pickOffers` para em `want` (`src/scheduler.js:425-426`), grava `lidoEm: null` no catálogo (`:443`) e anota na trava da rodada (`:444`). O laço de envio percorre `picked` (`:603`) e não repõe nada.
- Catálogo: `nao_conferido` vai para a revisão (`:649-651`, `:664-669`). Descarte vira `registrar(...'descartado')` (`:654`), e no catálogo isso bloqueia a oferta para sempre naquela regra (`src/catalogo-itens.js:233`).
- "Saíram X de Y" só sai em regra com grade (`src/scheduler.js:751-756`). A frase está fixada em `test/docs.test.js:1483,1491`.
- Verificador: `lerLoja` da Amazon sem API devolve `amazon_sem_api` (`src/verificador.js:272-273`). `decidir` aplica o frescor (`:149-152`). `vistoEm` só existe quando a oferta foi conferida (`:305-308`), e é o que alimenta o `{HORA_PRECO}` (`src/template.js:59`).
- Cliente do Etiqueta (`src/catalogo.js`): só GET (`:449-483`), um pedido por vez (`naFila`, `:430`), token lido a cada chamada (`lerToken`, `:339`). `paraCandidato` ignora `preco_em` (`:265-308`) e os `parametros` não mandam `preco_max_horas` (`:550-559`).
- Ajustes: só o desligar vai ao Histórico (`src/server.js:366-369`). O verificador da regra nasce em `criarServicos` (`:87`), depois do `catalogo` (`:72`).
- Trava de parecidos sem remoção: `criarTrava` tem `avaliar` e `acrescentar` (`src/parecido.js:103-162`).
- Etiqueta: a v1 só aceita GET. `bloquear_v1` responde 405 (`servidor.py:788-791`), a conexão é `query_only` (`:881`) e o 405 está fixado em `testes/test_api_ofertas_servidor.py:405-414`. `buscar_produto_amazon(url)` tem timeout fixo de 30 s (`:597-604`). A trava de rodada por loja usa `flock` sem espera (`travar_rodada`, `:104`). O `atualizar_precos.py` classifica captcha, 429/503 e ASIN diferente (`:435-452`) e, na releitura, grava só os campos de preço (`_gravar_relendo`, `:287-308`).
- `GET /api/v1/ofertas` sem `preco_max_horas` usa `config.preco_validade_horas`, que é 48 h no banco do dono (`api_ofertas.py:265-266`).

## Abordagens consideradas
| Abordagem | Prós | Contras | Risco |
|---|---|---|---|
| A. Rota nova no Etiqueta que relê e grava (brief) + reserva de 6 h no Turbo | O Etiqueta já raspa a Amazon (ADR-002 intacto); cada releitura também atualiza o catálogo | Primeira rota da v1 que grava | Excesso de leituras: resolvido com freio nos dois lados |
| B. O Turbo chama `/api/fetch` do Etiqueta e não grava | Nada muda no Etiqueta | `/api/fetch` não tem token (só Host/Origin); o preço lido se perde e a Amazon continua velha no catálogo | Abre rota sem autenticação para outro programa |
| C. Só a reserva de idade (sem releitura) | Mínimo | Com as rodadas manuais, a Amazon fica parada quase o tempo todo (fato do brief) | Não cumpre o objetivo 1 |

Vale a A, que o dono já escolheu. Para a reposição de vaga, a **escolha preguiçosa** (uma candidata por vez, a mesma lista lida uma vez) vence a de "escolher 4× as vagas de uma vez". Escolher tudo de uma vez poria na trava da rodada candidatas que nunca saem: as parecidas delas seriam barradas e apareceriam no Histórico como "Pulada" sem motivo real.

## Decisão
1. **Etiqueta:** `POST /api/v1/amazon/<ASIN>/confirmar-preco`. Relê `https://www.amazon.com.br/dp/<ASIN>` (sem tag) com prazo de 10 s. Grava só `preco`, `preco_antigo` e `desconto` sobre a linha relida, mais `preco_em` e `atualizado_em`. Nunca insere e nunca mexe em `url`. Freio próprio. A lógica fica em `servidor.py`, ao lado de `buscar_produto_amazon` e de `sanear_precos`; o `api_ofertas.py` continua só de leitura.
2. **Turbo, catálogo:** `paraCandidato` passa a levar `precoEm` (ms). O cliente ganha `confirmarPreco(asin)`.
3. **Turbo, verificador:** a releitura só acontece com a opção `releitura`, que só a regra do catálogo passa, e só para a Amazon sem API. Preço lido: vale `decidir` como hoje. `sem_preco`: descarta como `indisponivel`. `outro_produto`: descarta como `outro_produto`. Qualquer outra falha cai na reserva: `precoEm` entre −5 min e 6 h envia com `vistoEm = precoEm`; fora disso, `descartar nao_conferido` com `causa`. Depois de uma falha, a releitura fica pausada por 10 min no Turbo.
4. **Turbo, regra:**
   - Laço de reposição: preenche até `want` ofertas com no máximo `want × 4` escolhidas (as vagas mais 3× as vagas de reposição).
   - `nao_conferido` do catálogo vira **pulada**: sem `catalogo_itens`, sem `sent_offers` e com uma linha no Histórico. Pausa de 6 h só para `sem_preco`/`varias_versoes` (escolha do brief); as demais podem voltar na execução seguinte.
   - "Saíram X de Y" passa a valer para toda regra.
5. **Idade do preço na lista (pedido do lead).** Com o verificador ligado, a fonte do catálogo cujas `lojas` sejam só `ml` e/ou `amazon` (lista não vazia) pede `preco_max_horas=72`. Fora disso, nada muda: verificador desligado, Shopee na lista ou lista vazia ficam com a validade do Etiqueta (48 h). Efeito por loja:
   - **Amazon:** a releitura confere tudo e grava no Etiqueta, então o catálogo se corrige sozinho; com a releitura falhando, a reserva de 6 h impede que preço velho saia.
   - **Mercado Livre:** sempre conferido pela extensão. Custo: mais descartes `preco_subiu`, cada um gastando uma leitura da extensão (teto 120/h) e uma tentativa. O custo tem limite: o descarte do catálogo fica registrado e não volta naquela regra.
   - **Shopee:** não é reconferida, então fica fora.
   - **Descartes em série:** a releitura pausada tira da escolha as Amazon com `precoEm` > 6 h sem gastar tentativa (`semConfirmacaoAgora`), e o teto de 4× segura o resto.
   - **Verificador desligado no meio da execução:** a execução marca que pediu idade larga, e as ofertas do catálogo que restam são puladas (não saem sem conferência). Fica como premissa P1.
6. **Migração:** apaga uma vez as linhas `status='revisao'` cujo `motivos` é exatamente `["nao_conferido"]` e grava uma linha `info` no Histórico com a contagem. Antes, backup obrigatório.
7. Contadores por loja (para a entrega 3) ficam só no retorno do `runRule` (`summary.porLoja`), sem tabela nova (P4).

## Esquema e contratos
**Etiqueta: `POST /api/v1/amazon/<ASIN>/confirmar-preco`** (`<ASIN>` = `[A-Z0-9]{10}`, fullmatch no caminho cru; outro formato dá 404 da v1)
- Guardas na ordem: Host 403 → navegador (Origin/Sec-Fetch-Site) 403 → API desligada 503 → token 401 → método diferente de POST 405 `Allow: POST` → corpo não vazio 400 `esta rota não aceita corpo` → item `loja='amazon' AND item_id=<ASIN>` inexistente 404 `oferta da Amazon não encontrada` → freio 429 → leitura. O POST em outra rota da v1 continua 405 `Allow: GET`.
- 200, sempre com `"versao":1`:
  - `{"resultado":"confirmado","preco":89.9,"preco_antigo":119.9|null,"desconto_pct":25|null,"preco_em":"AAAA-MM-DDTHH:MM:SS"}`: título presente, ASIN igual ao pedido, `ler_preco` legível. Grava antes de responder.
  - `{"resultado":"sem_preco"}`: ASIN igual e título presente, mas preço ilegível; ou HTTP 404/410 da Amazon.
  - `{"resultado":"outro_produto"}`: ASIN da `url_final` não vazio e diferente; ou redirect para fora (`URLRecusada`).
  - `{"resultado":"bloqueado"}`: captcha; HTTP 429/503; página sem título ou sem ASIN (página não reconhecida nunca vira descarte).
  - `{"resultado":"falha_rede"}`: `URLError`, timeout, `OSError` e outro HTTP.
- 429 `{"versao":1,"resultado":"freio","motivo":"ocupado|intervalo|teto|pausa|rodada","tentar_em_s":N}` com `Retry-After: N`. Motivos:
  - uma leitura por vez (`ocupado`);
  - 3 s entre o início de duas leituras (`intervalo`);
  - 60 leituras por hora, em janela deslizante (`teto`);
  - 15 min sem ler depois de um `bloqueado` (`pausa`);
  - `travar_rodada('amazon')` ocupada (`rodada`). O teste pega a trava e a solta na hora, sem segurá-la durante a leitura.
- Gravação: a leitura de rede acontece fora de transação. Depois vem `BEGIN IMMEDIATE`, que relê os `CAMPOS`, aplica `sanear_precos` sobre `{**linha, preco, preco_antigo, desconto}`, faz o `UPDATE` só desses três mais `preco_em=agora()` e `atualizado_em=agora()`, e o commit. Linha apagada entre a leitura e a gravação: 404. Falha não grava nada.
- Log: rota sem o ASIN (`POST /api/v1/amazon/(asin)/confirmar-preco`) e nunca o token. Resposta nunca traz HTML nem `str(e)`.
- `buscar_produto_amazon(url, timeout=30)`: o parâmetro novo tem padrão igual ao de hoje.

**Turbo (assinaturas novas; o resto não muda)**
- `src/catalogo.js`:
  - `export const IDADE_CATALOGO_CONFERIDO_H = 72`.
  - `export function lerPrecoEm(texto) → ms|null`: só `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$`, hora local, data que existe (ida e volta pelo `Date`).
  - `paraCandidato(o)` passa a incluir `precoEm`.
  - `candidatos(cfg, ctx)` lê `ctx.conferenciaNaHora` (bool) e acrescenta `['preco_max_horas', 72]` quando a condição da Decisão 5 vale. O `filtroDe` não muda.
  - `confirmarPreco(asin) → Promise<{resultado:'confirmado', preco, precoAntigo|null, descontoPct|null, precoEm} | {resultado:'sem_preco'|'outro_produto'} | {resultado:'falha', causa:'bloqueado'|'falha_rede'|'freio'|'nao_encontrado'|'fora_do_ar'|'token_recusado'|'desligada'|'resposta_inesperada'|'nao_configurada'}>`. Nunca lança. Usa `naFila`, POST sem corpo, só `Authorization`, `redirect:'error'`, timeout de 15 s e `lerCorpoLimitado`. Não muda `situacao()`.
- `src/ml.js` `candidatesFor`: repassa `deps.conferenciaNaHora` ao `ctx`.
- `src/verificador.js`:
  - Constantes: `RESERVA_AMAZON_H = 6` e `PAUSA_RELEITURA_MIN = 10`.
  - `MOTIVOS_VERIFICADOR` ganha `indisponivel` e `outro_produto`, com as frases da spec, §1.
  - `CAUSAS` ganha `etiqueta_fora` ("o Etiqueta não respondeu"), `etiqueta_bloqueio` ("a Amazon bloqueou a leitura") e `etiqueta_sem_oferta` ("a oferta saiu do Etiqueta").
  - Mapa das falhas: `falha_rede` → `loja_fora`, `freio` → `limite_hora`, timeout → `demorou`, `fora_do_ar|token_recusado|desligada|resposta_inesperada|nao_configurada` → `etiqueta_fora`, `nao_encontrado` → `etiqueta_sem_oferta` (sem reserva e sem pausar a releitura).
  - `createVerificador({ …, catalogo = null })`.
  - `conferir(oferta, { lidoEm, referencia, releitura: { precoEm } | null })`.
  - `descartar nao_conferido` passa a trazer `causa` (chave de `CAUSAS`); o campo é aditivo e o `envios.js` o ignora.
  - Envio pela reserva: `{acao:'enviar', conferido:false, oferta:{…, vistoEm: precoEm}, sufixo:' · preço visto às HH:MM, não conferido agora (<causa>)'}`.
  - Releitura confirmada: `vistoEm = precoEm` da resposta.
  - Novos: `semConfirmacaoAgora({ loja, precoEm }) → bool` (Amazon, verificador ligado, sem API, releitura pausada e reserva inválida) e `export function reservaValida(precoEm, agora) → bool`.
- `src/parecido.js` `criarTrava`: ganha `retirar(key)`, que tira a oferta das `escolhidas` da rodada.
- `src/catalogo-itens.js`: `DESCARTE_VERIFICADOR` ganha `indisponivel` e `outro_produto`. `MOTIVOS` mantém `nao_conferido` para ler linhas antigas.
- `src/db.js`: marca `settings.migracao_e1_nao_conferido = '1'`. Sem coluna e sem tabela nova.
- `src/scheduler.js`:
  - `export const TETO_REPOSICAO = 3`.
  - `criarEscolha(rule, want, exec, { previa, saindo }) → { proxima(): Promise<oferta|null>, devolver(key) }`. `devolver` tira a oferta da trava (`retirar`) e de `saindo`. `pickOffers` vira o laço de `proxima()` `want` vezes; a prévia não muda.
  - `exec` ganha `filtradas: { filtros, pausa, parecidas, semConferencia }`, `conferenciaNaHora` e `porLoja`.
  - `summary` ganha `puladas` e `porLoja: { ml|amazon|shopee: { saiu, pulada, descartada, revisao, esperou } }`.

## Etapas
Ordem TDD: o teste nasce vermelho e o código o põe verde. Antes de mexer no Etiqueta, o `dev` roda `python3 verificar.py` lá; essa linha de base ainda não foi medida. Os dois repositórios ficam em worktrees.

| # | Etapa | Arquivos | Verificação | Responsável | Grupo | Sensível | CAs |
|---|---|---|---|---|---|---|---|
| A1 | `confirmar_preco_amazon(con, asin, buscar=buscar_produto_amazon, agora=agora)`: classifica os 5 resultados e grava só os campos de preço; `timeout` em `buscar_produto_amazon` | etiqueta: `servidor.py`, `testes/test_confirmar_preco.py` (novo) | `python3 testes/test_confirmar_preco.py -v` (proxies em 127.0.0.1:9) | dev | 1 | sim | 1.1, 1.2 |
| A2 | Classe `FreioReleitura` + rota HTTP: `bloquear_v1` aceita POST só na rota; despacho no `do_POST`; 429 + `Retry-After`; log sem ASIN e sem token | etiqueta: `servidor.py`, `testes/test_confirmar_preco_servidor.py` (novo) | `python3 testes/test_confirmar_preco_servidor.py -v` e `python3 verificar.py` | dev | 2 | sim | 1.1, 1.2 |
| A3 | Contrato e docs: seção nova em `api-ofertas.md` (rota, respostas, freio, "a v1 passa a ter uma rota que grava"), README e CLAUDE.md (antes, `rg -n "CLAUDE\|README" testes/`) | etiqueta: `docs/produto/referencias/api-ofertas.md`, `README.md`, `CLAUDE.md` | `python3 verificar.py` | dev | 3 | não | 1.13 |
| B1 | `lerPrecoEm`, `precoEm` no candidato, `confirmarPreco`, `preco_max_horas` condicional; `ml.js` repassa a flag | `src/catalogo.js`, `src/ml.js`, `test/catalogo.test.js` | `node --disable-warning=ExperimentalWarning --test test/catalogo.test.js` | dev | 1 | sim | 1.3, 1.5, 1.11 |
| B2 | Releitura, reserva, pausa de 10 min, motivos e causas novos, `causa` no descarte, `semConfirmacaoAgora`; atualizar `TEXTO_PERMITIDO` (`test/verificador.test.js:39`) | `src/verificador.js`, `test/verificador.test.js` | idem com `test/verificador.test.js` | dev | 1 | não | 1.3–1.6, 1.11 |
| B3 | `retirar(key)` na trava | `src/parecido.js`, `test/parecido.test.js` | idem com `test/parecido.test.js` | dev | 1 | não | 1.12 |
| B4 | Migração do `nao_conferido` (uma vez, com linha no Histórico) e descartes novos no `registrar` | `src/db.js`, `src/catalogo-itens.js`, `test/catalogo-itens.test.js` | idem com `test/catalogo-itens.test.js` | dev | 1 | sim (migração) | 1.10, 1.4 |
| B5 | Escolha preguiçosa + laço de reposição + teto + `devolver` + filtro `semConfirmacaoAgora` + `conferenciaNaHora` + "Saíram X de Y" para toda regra + contagem das filtradas + `porLoja`; ajustar frases em `test/docs.test.js:1483,1491`, `test/disparador.test.js`, `test/ritmo-agendador.test.js`, `test/qa-grade-e2e.test.js` | `src/scheduler.js`, `test/reposicao.test.js` (novo) e os 4 testes citados | `npm test` | dev | 2 | sim (concorrência com o "Enviar" do Catálogo) | 1.7, 1.8, 1.12 |
| B6 | `conferirDaRegra` com `releitura`; `nao_conferido` do catálogo vira pulada (sem revisão, sem `sent_offers`, pausa só com `sem_preco`/`varias_versoes`); descartes novos registrados; verificador desligado no meio com idade larga leva à pulada; linhas da spec | `src/scheduler.js`, `test/verificador-regras.test.js` | `npm test` | dev | 3 | sim | 1.3–1.6, 1.11 |
| B7 | Linha "Verificador ligado em Ajustes (por …)" e `catalogo` passado ao `createVerificador` | `src/server.js`, `test/verificador-servidor.test.js` | idem com `test/verificador-servidor.test.js` | dev | 1 | não | 1.9 |
| B8 | Textos de tela e Docs conforme a spec, §4 e §5 (inclui `descartadaPor` com `indisponivel`/`outro_produto` e `TEXTOS_VERIFICADOR`) | `public/app.js`, `public/ajuda.js`, `public/espelhamento.js`, `public/docs/cap-conta.js`, `public/docs/cap-referencia.js`, `public/docs/cap-amazon-revisao.js`, `public/docs/cap-disparos.js`, `README.md` | `npm test` | designer | 4 | não | 1.13 |
| B9 | `FATOS`: reserva do preço 6 (`RESERVA_AMAZON_H`), pausa do descarte 6, idade da lista 72 e releitura pausada 10 (só se os Docs citarem); motivos e causas novos citados; tirar as asserções de `TEXTO_MOTIVO.nao_conferido` | `test/docs.test.js` | idem com `test/docs.test.js` e depois `npm test` | dev | 4 | não | 1.13 |

O grupo 1 roda em paralelo (A1, B1, B2, B3, B4 e B7 não compartilham arquivo). Os grupos 2, 3 e 4 entram em sequência. A2 depende de A1, B5 depende de B1 a B3, e B6 depende de B5. B8 e B9 rodam juntas e não compartilham arquivo.

**Testes por CA** (nome → arquivo):
- **CA1.1:**
  - `test_ca1_1_confirmado_grava_e_carimba_preco_em`, `test_ca1_1_sem_preco`, `test_ca1_1_outro_asin_e_redirect_fora_dao_outro_produto`, `test_ca1_1_captcha_429_503_sem_titulo_dao_bloqueado`, `test_ca1_1_erro_de_rede_da_falha_rede`, `test_ca1_1_le_dp_sem_tag` → `test_confirmar_preco.py`.
  - `test_ca1_1_sem_token_401_navegador_403_get_405_outra_rota_post_405`, `test_ca1_1_item_inexistente_ou_de_outra_loja_404`, `test_ca1_1_corpo_400`, `test_ca1_1_freio_429_com_retry_after`, `test_freio_pausa_15_min_depois_de_bloqueado`, `test_freio_rodada_amazon_em_andamento`, `test_ca1_1_falha_de_rede_pelo_http` → `_servidor.py`.
- **CA1.2:** `test_ca1_2_falha_nao_altera_preco_url_nem_preco_em` (cada resultado de falha) e `test_ca1_2_confirmado_nao_troca_url_titulo_cupom` → `test_confirmar_preco.py`; `test_log_sem_token_nem_asin` → `_servidor.py`.
- **CA1.3:** 'Amazon sem API com releitura confirmada envia o preço lido' → `test/verificador.test.js`; 'catálogo Amazon confirmada na hora sai sem passar pela revisão' → `verificador-regras`.
- **CA1.4:** 'releitura acima do limite descarta preco_subiu; sem_preco descarta indisponivel; outro_produto' → `verificador`; 'descartes da releitura vão ao Histórico e a catalogo_itens com descartado_por' → `verificador-regras` e `catalogo-itens`.
- **CA1.5:** 'reserva: 5h59 envia; 6h01, null, inválido e +6 min no futuro não' → `verificador`; 'reserva vencida pula: sem revisão e sem sent_offers' → `verificador-regras`.
- **CA1.6:** 'vistoEm = preco_em na releitura e na reserva, nunca agora()' → `verificador`; '{HORA_PRECO} da mensagem é a hora do preço' → `verificador-regras`.
- **CA1.7:** 'escolhida que cai fora é reposta pela próxima candidata' e 'para em 4× as vagas' → `reposicao`.
- **CA1.8:** 'saíram X de Y com os motivos, também na regra por intervalo' → `reposicao`.
- **CA1.9:** 'ligar grava linha com quem fez; desligar continua' → `verificador-servidor`.
- **CA1.10:** 'migração tira só os itens só com nao_conferido, roda uma vez e grava a contagem' → `catalogo-itens`.
- **CA1.11:**
  - 'sem releitura nas opções, Amazon sem API segue como hoje', 'com API ligada a releitura não é chamada' e 'desligado não chama o Etiqueta' → `verificador`;
  - 'preco_max_horas só com verificador ligado e lojas ⊆ {ml, amazon}' → `catalogo`;
  - 'ML com falha passageira pula e nunca sai sem conferência' e 'fonte afiliados mantém a regra do frescor' → `verificador-regras`.
- **CA1.12:** 'reposição para no teto por hora e no silêncio' e 'reposta passa pela trava; a que caiu não barra a parecida' → `reposicao`; 'retirar libera a parecida da rodada' → `parecido`.
- **CA1.13:** `FATOS` e frases → `docs.test.js`; `verificar.py` no Etiqueta.

**Ordem de entrada no serviço (fora dos horários das regras, com o ok do dono):**
1. **Etiqueta:**
   - merge da worktree e `python3 verificar.py` verde;
   - o dono roda `python3 backup_banco.py --motivo entrega1` e reinicia o `servidor.py`;
   - `python3 verificar.py --servidor` deve dar 0;
   - o dono testa uma oferta: `curl -s -X POST -H "Authorization: Bearer $(cat api_token.txt)" http://127.0.0.1:8765/api/v1/amazon/<ASIN>/confirmar-preco`.
2. **Turbo:**
   - `npm test` verde na worktree;
   - o dono roda `npm run backup` (a migração apaga linhas);
   - merge de `src/` de uma vez só; o `--watch-path` reinicia o serviço;
   - conferir no Histórico a linha da migração;
   - o dono religa o verificador em Ajustes.

Se o Turbo entrar antes do Etiqueta, nada quebra: a rota responde 405, o Turbo trata como `resposta_inesperada` e usa a reserva de 6 h.

## Pontos para o seguranca
- A rota nova abre uma leitura de rede **comandada por outro programa**. Pontos a conferir:
  - URL montada no servidor a partir do ASIN validado por fullmatch; nenhuma URL vem do cliente;
  - redirect conferido por `OPENER_AMAZON`;
  - freio (vazão, concorrência, pausa depois de captcha, rodada da Amazon);
  - timeout de 10 s.
- A v1 passa a gravar. Pontos a conferir:
  - só `preco`, `preco_antigo`, `desconto`, `preco_em` e `atualizado_em`;
  - `BEGIN IMMEDIATE` só depois da rede;
  - nunca insere nem troca `url` (regra do dono: link de afiliado);
  - a conexão de escrita fica restrita a essa rota, e as outras continuam `query_only`.
- Autenticação: o token continua só no cabeçalho, comparado em tempo constante. A rota nunca recebe pedido de navegador (403), e 401 e 405 vêm antes de qualquer leitura.
- Turbo:
  - o token só existe dentro de `confirmarPreco`;
  - POST sem corpo, corpo da resposta limitado, números e `preco_em` validados;
  - a releitura nunca entra no Disparo manual nem no "Enviar" da revisão (CA1.11);
  - a reposição respeita `ritmo.js` (teto e silêncio) e nunca muda o link de afiliado.
- Concorrência (B5/B6): a reposta precisa entrar em `emEnvio` no momento da escolha, e a que caiu sai dele (`devolver`). O "Enviar" do Catálogo não pode passar uma parecida de uma reposta.
- Migração (B4): `DELETE` restrito por `status` e `motivos` exatos, uma vez só, sem dado pessoal; backup antes.

## Foco de revisão (o que o brief não cita e mais pode morder)
1. **Etiqueta fora do ar ou travado no meio da execução:** a primeira falha pausa a releitura e as Amazon restantes vão direto à reserva, sem nova espera de 15 s. Teste 'Etiqueta cai no meio da execução: as Amazon restantes vão à reserva sem nova chamada' (B6), apoiado no teste da pausa de 10 min (B2).
2. **Candidata que sempre falha numa ordem fixa** (desconto ou menor preço, sem cursor: as mesmas no topo a cada execução): ela gasta 1 tentativa e as seguintes saem; a Amazon velha não gasta tentativa com a releitura pausada. Testes 'candidata que sempre falha não impede a seguinte' e 'Amazon velha não ocupa tentativa com a releitura em pausa' (B5).
3. **Execução que estoura o horário:** no máximo `want × 4` conferências por execução, cada uma com até 20 s. Teste 'a execução faz no máximo 4× as vagas em conferências' (B5).
4. **Captcha em série:** depois de um `bloqueado`, o Etiqueta recusa por 15 min e o Turbo não pergunta por 10 min. Testes `test_freio_pausa_15_min_depois_de_bloqueado` (A2) e 'falha pausa a releitura por 10 min' (B2).
5. **Verificador desligado com a lista em idade larga:** oferta de 70 h não sai sem conferência. Teste 'desligar no meio da execução pula o catálogo pedido com 72 h' (B6).

## Riscos e como reverter
- **Etiqueta:** a releitura gasta a cota informal da Amazon. O freio limita (60/h) e a rodada da Amazon tem prioridade. Reverter: `git revert` e reiniciar; o Turbo cai na reserva de 6 h sozinho.
- **Idade larga de 72 h gera muitos descartes no ML:** voltar `IDADE_CATALOGO_CONFERIDO_H` para `null` (sem o parâmetro), num commit de uma linha.
- **Migração:** as linhas apagadas são cópias de ofertas do Etiqueta e voltam se o catálogo as trouxer. Volta total pelo backup (`scripts/backup.js` restaurar), só se o dono quiser. Reverter o código não exige restaurar dados.
- **Reposição alonga execuções e muda frases do Histórico:** `git revert` dos commits de B5/B6. Nada fica gravado em esquema.
- **Leitor externo** (`relatorio-achadinhos`): nenhuma coluna que ele lê muda.

## Perguntas em aberto e premissas adotadas
- **P1 (dono)** Idade larga: 72 h, só com verificador ligado e lojas ⊆ {ml, amazon}. Alternativas: 168 h (mais Amazon, mais descartes) ou não ampliar (Amazon some 48 h depois de cada rodada). Premissa: 72.
- **P2 (dono)** "ML nunca sai sem conferência" vale para o catálogo. As fontes antigas (Central, busca, lista) mantêm o frescor de 30 min (CA1.11, "nada muda"). Nenhuma regra atual usa essas fontes.
- **P3 (dono)** Indisponível e outro produto **descartam** (CA1.4). No catálogo, o descarte já fica registrado e não volta naquela regra (`catalogo-itens.js:233`), não só por 6 h. Premissa: mantenho o comportamento de hoje e corrijo a spec (abaixo).
- **P4 (lead)** Os contadores para a entrega 3 ficam só em `summary.porLoja`; a gravação por execução fica para o plano da entrega 3.
- **P5 (dono)** Números do freio (1 por vez, 3 s, 60/h, 15 min) e da pausa no Turbo (10 min). A releitura usa `/dp/ASIN` sem tag, para não parecer clique de afiliado.
- **P6 (lead)** A migração apaga as linhas em vez de criar um status novo: um status `liberado` mexeria em `CHECK`, na listagem e no `tratada()` por um efeito que o `DELETE` dá sem isso.

**Alinhamento com a spec** (`docs/produto/specs/rodar-sozinho-entrega1.md`):
- §1 Descartadas: no Catálogo a descartada não volta naquela regra (P3). O texto dos Docs deve dizer isso, não "volta depois de 6 h".
- §1 Pulada por falha passageira: sem pausa, então "Tenta de novo no próximo envio" vale. `sem_preco` e `varias_versoes` ficam com a frase da pausa de 6 h (Q3 da spec).
- §1 Contagem das filtradas (Q2 da spec): só sai quando a regra sai com menos que o pedido. Não conto as "já enviadas", porque o catálogo as tira antes de chegarem ao agendador; as categorias contadas são fora dos filtros, em pausa, parecidas e Amazon sem conferência possível agora.
- §2: adotadas as frases "o Etiqueta não respondeu" e "a Amazon bloqueou a leitura". O freio do Etiqueta usa a causa já existente "o limite de conferências por hora foi atingido". Nova: "a oferta saiu do Etiqueta" (404). `amazon_sem_api` fica, porque o Disparo manual ainda a usa (Q1 da spec: fora desta entrega).
- §5: os testes de `test/docs.test.js` que fixam `TEXTO_MOTIVO.nao_conferido` saem em B9. Os que fixam a frase "Saíram" são ajustados em B5.

Corte possível, se o dono quiser entregar antes: B5 (reposição) é independente da releitura. A1–A3 + B1, B2, B4, B6 e B7 já deixam o verificador ligado sem travar a Amazon; B5 pode entrar num segundo commit.

## ADR
**ADR-014: Preço da Amazon conferido pelo Etiqueta na hora, com reserva de idade.** Contexto: não há API da Amazon e o Turbo não raspa HTML (ADR-002). Decisão: rota autenticada `POST /api/v1/amazon/<ASIN>/confirmar-preco` no Etiqueta, que relê e grava só os campos de preço e tem freio próprio; no Turbo, reserva de 6 h sobre `preco_em` quando a releitura falha; falha técnica nunca vai à revisão (vira "pulada") e a vaga é reposta com teto de 4× as vagas. Consequências: a v1 do Etiqueta deixa de ser só leitura numa rota; cada envio da Amazon pode refrescar o catálogo; o Turbo passa a depender do Etiqueta no ar para Amazon com preço de mais de 6 h. Alternativas rejeitadas: `/api/fetch` sem token; só idade do preço.
