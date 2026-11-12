> **Obsoleta (2026-11-11).** O dono aprovou o plano `docs/produto/planos/baixou-de-para.md`: campo `{PRECO_ULTIMO_ENVIO}`, linha `[📉 Baixou de ~{PRECO_ULTIMO_ENVIO}~ para *{PRECO_PRODUTO}*]` igual nos 6 modelos (viu a prévia com os dois 📉 e a posição no Preço_Baixo e aprovou). Não revisar contra esta spec.

# Especificação de UI/UX: linha "Baixou de … para …" na mensagem

## Objetivo e usuário
O dono quer que quem lê o grupo veja que o preço caiu desde o último envio do mesmo produto, ex.: "📉 Baixou de R$ 299,00 para R$ 252,00". Leitor: gente no celular, lendo rápido no WhatsApp. Editor: o dono, no painel (Templates).

Placeholder novo (nome provisório do arquiteto): `{PRECO_ANTERIOR}`. Vazio quando não houve envio anterior mais caro. Como a linha tem placeholder fora de colchetes, **a linha inteira some sozinha quando ele está vazio**: não precisa de `[ ]` nem de código novo no motor.

## Fluxo
1. Dono abre Templates, clica no chip `{PRECO_ANTERIOR}` (ou digita) e salva.
2. A prévia mostra a linha com a oferta de exemplo.
3. No envio, a linha aparece só se o produto já saiu antes por um preço maior.

## Texto da linha
Forma única: `Baixou de {PRECO_ANTERIOR} para {PRECO_PRODUTO}`, sempre em linha própria, sem riscado (o ~riscado~ fica só para o "De" da loja; dois riscados na mesma mensagem confundem qual é o preço de referência).

Regras:
- Emoji 📉 onde ele ainda não é usado. Nos modelos 4, 5 e 6, 📉 já marca a linha de desconto, então a nova usa 🔻 (evita duas linhas com o mesmo ícone querendo dizer coisas diferentes).
- Negrito na linha inteira só nos modelos em que o "Por" já é negrito (1, 3, 7). Nos demais, texto simples, no estilo do modelo.
- Posição: logo abaixo do "Por" quando o desconto está dentro dele (1, 3, 7); depois da linha de desconto nos modelos 4, 5 e 6 (mantém Por e Desconto juntos).

### Quando as duas aparecem (De/Por da loja + Baixou de/para)
Não há como cortar uma delas sem perder informação: "De" é o preço de tabela da loja e gera a porcentagem de desconto; "Baixou" é a história do produto no grupo. Para não parecer repetido:
- "Baixou" nunca repete o "De" nem usa riscado; só mostra o preço do último envio e o atual.
- Ela vem abaixo do "Por", nunca entre "De" e "Por".
- Sem decisão extra no código: se o dono achar demais, apaga a linha do modelo. O motor já omite sozinho em ofertas sem queda.
- Se não houver "De" (sem desconto da loja), a linha "Baixou" fica sozinha e continua fazendo sentido.

## Os 6 modelos do dono (só a linha nova marcada com `+`)

**1 Padrão**
```
😱 De ~{PRECO_ANTIGO}~
🔥 Por *{PRECO_PRODUTO}* ({DESCONTO_PRODUTO} OFF)
+ 📉 *Baixou de {PRECO_ANTERIOR} para {PRECO_PRODUTO}*
⭐ {NUMERO_VENDAS}
```
**3 Melhores_Desconto**
```
❌ De ~{PRECO_ANTIGO}~
💰 *Por apenas {PRECO_PRODUTO}*
+ 📉 *Baixou de {PRECO_ANTERIOR} para {PRECO_PRODUTO}*
(linha em branco, depois Cupom…)
```
**4 Mais_Vendidos**
```
❌ De: ~{PRECO_ANTIGO}~
✅ *Por: {PRECO_PRODUTO}*
📉 Desconto: {DESCONTO_PRODUTO}
+ 🔻 Baixou de {PRECO_ANTERIOR} para {PRECO_PRODUTO}
```
**5 Preço_Baixo**
```
✅ Por: {PRECO_PRODUTO}
❌ De: ~{PRECO_ANTIGO}~
📉 Desconto: {DESCONTO_PRODUTO}
+ 🔻 Baixou de {PRECO_ANTERIOR} para {PRECO_PRODUTO}
```
**6 Black_Friday**
```
💸 De ~{PRECO_ANTIGO}~
🔥 Por {PRECO_PRODUTO}
📉 {DESCONTO_PRODUTO} OFF
+ 🔻 Baixou de {PRECO_ANTERIOR} para {PRECO_PRODUTO}
⭐ {NUMERO_VENDAS}
```
**7 Oferta_Relampago** (o dono listou 6, mas o banco tem 7 modelos: id 1, 3, 4, 5, 6, 7)
```
❌ De ~{PRECO_ANTIGO}~
🔥 *Por {PRECO_PRODUTO}*[ ({DESCONTO_PRODUTO} OFF)]
+ 📉 *Baixou de {PRECO_ANTERIOR} para {PRECO_PRODUTO}*
⭐ {NUMERO_VENDAS}
```
Exemplo renderizado (modelo 1, amostra): `📉 *Baixou de R$ 109,90 para R$ 89,90*`.

Template padrão de fábrica (`src/template.js` linha ~125 e `src/db.js` linha ~231): **não mudar sem decisão do dono**; novos usuários não precisam da linha. Ver pergunta 2.

## Editor de template (Templates, `public/app.js` `paginaTemplates`)

| Componente | Existente ou novo | Onde fica |
|---|---|---|
| Chips de campos | Existente; o chip `{PRECO_ANTERIOR}` nasce sozinho de `PLACEHOLDERS` (`S.st.placeholders`) | `public/app.js` |
| Dica do campo | Novo texto, uma `<small class="dica">` abaixo dos chips, no padrão de `TEXTOS_VERIFICADOR.horaPreco` | `public/app.js` / `public/ajuda.js` |
| Dica em `DICAS_PLACEHOLDERS` | Nova entrada | `public/ajuda.js` |
| Prévia | Existente, com a amostra ganhando o preço anterior | `src/template.js` `SAMPLE_OFFER` (dev) |

- **Ordem dos chips**: logo depois de `PRECO_PRODUTO` na lista `PLACEHOLDERS`, para ficar perto dos outros preços. Rótulo do chip igual ao nome, como os demais.
- **Texto de ajuda** (`DICAS_PLACEHOLDERS.PRECO_ANTERIOR`, também usada na lista do Espelhamento): "Preço do último envio deste produto, quando era mais alto que o de hoje. Vazio no primeiro envio ou se o preço não baixou; a linha some sozinha."
- **Linha de dica no editor** (abaixo da de `{HORA_PRECO}`): "Para mostrar a queda de preço, use uma linha só com {PRECO_ANTERIOR}, como “📉 Baixou de {PRECO_ANTERIOR} para {PRECO_PRODUTO}”. Ela só aparece quando o produto já saiu antes por um preço maior."
- **Prévia**: a oferta de exemplo ganha preço anterior de R$ 109,90 (acima do atual R$ 89,90 e abaixo do "De" de R$ 149,90, para parecer real). Assim o dono vê a linha ao inserir o chip. A prévia não mostra o caso "sem queda"; a dica acima explica que a linha some.
- Nenhum erro de validação novo: o campo é opcional.

## Estados
- **Com queda**: linha aparece. **Primeiro envio / sem queda / preço igual**: linha some, sem linha em branco sobrando (o motor já colapsa).
- **Dono põe `{PRECO_ANTERIOR}` no meio de outra linha** (ex.: junto do `{LINK}`): a linha inteira some quando vazio e levaria o link junto. Mesmo risco do `{HORA_PRECO}`; pedir ao dev que reuse a checagem `horaPrecoDerrubaOLink` (ou equivalente) para avisar ao salvar, e a dica pede linha própria.
- **Valor longo**: preços são curtos; sem estado especial.

## Acessibilidade
- Chips já são `<button>` com texto; nada novo. Dica em `<small>` de texto, contraste do `.dica` existente.
- No WhatsApp o significado não depende só do emoji: o texto "Baixou de … para …" diz tudo.

## O que o dev precisa implementar
1. `PRECO_ANTERIOR` em `PLACEHOLDERS` (depois de `PRECO_PRODUTO`) e em `offerValues` (vazio se não houver preço anterior maior que o atual).
2. `precoAnterior` em `SAMPLE_OFFER` (109,90); conferir testes que fixam a prévia.
3. Entradas em `public/ajuda.js` (`DICAS_PLACEHOLDERS`) e a linha de dica no editor.
4. Linha da tabela em `public/docs/cap-disparos.js` (campos), `README.md` se listar campos; número novo (109,90) em `FATOS` de `test/docs.test.js` se aparecer nos Docs.
5. Os 6 corpos acima: o `dev` atualiza os templates do dono por script ou o dono cola; não regravar `data/` sem avisar.

## Arquivos de apresentação afetados
`public/app.js`, `public/ajuda.js`, `public/docs/cap-disparos.js`, `README.md`. Fora da apresentação (dev): `src/template.js`, `src/db.js`.

## Perguntas em aberto
1. "Último envio" vale para qualquer grupo ou só o mesmo grupo? Muda o que o texto "neste produto" promete (arquiteto/dono).
2. Incluir a linha no template padrão de fábrica para quem cria conta nova, ou só nos modelos do dono?
3. Os modelos 4, 5 e 6 podem usar 🔻 em vez de 📉, como proposto, ou o dono prefere 📉 em todos?
4. O dono falou em 6 modelos, mas existem 7 (id 1, 3, 4, 5, 6, 7); incluir a Oferta_Relâmpago?
