# Disparador ML

Programa **pessoal** que roda no seu computador e envia ofertas da sua **Central de Afiliados** do Mercado Livre para os seus grupos de WhatsApp, com link `meli.la` e **várias etiquetas** (cada regra usa a sua).

Você configura: grupos, template, quantas ofertas por envio, intervalo, horário de funcionamento e quanto tempo sem repetir a mesma oferta.

## Como funciona

```
Painel (localhost:3737) ── regras, etiquetas, templates, grupos
        │
   Agendador ──► pede a lista de ofertas e o link meli.la ──► Extensão do Chrome (aba da Central de Afiliados, já logada)
        │
        └──────► WhatsApp Business (aparelho conectado, via QR) ──► grupos
```

Nenhum cookie do Mercado Livre sai do seu Chrome: a extensão devolve só a lista de produtos e o link pronto.

## Instalar

1. Instale o **Node.js 22.13 ou mais novo** (versão LTS em nodejs.org).
2. Windows: dê dois cliques em `iniciar.bat`. Outros sistemas: `npm install` e depois `npm start`.
3. Abra http://localhost:3737

Quer só olhar o painel sem conectar nada? Rode `npm run simular`. Nesse modo nada é enviado de verdade.

## Primeiros passos

1. **Etiquetas**: cadastre os nomes das suas etiquetas, escritos como no programa de afiliados.
2. **WhatsApp e grupos**: clique em *Conectar WhatsApp* e leia o QR no WhatsApp Business (Aparelhos conectados).
3. **Templates**: ajuste a mensagem. Linha com campo vazio some sozinha.
4. **Extensão** (abaixo). Sem ela, nem a lista de ofertas nem o link de afiliado são gerados.
5. **Regras**: crie uma regra escolhendo etiqueta, template, grupos e ritmo. A fonte padrão é a **Central de Afiliados**: a lista "Produtos selecionados para você", com busca, categoria, ordem, "só mais vendidos" e "só com ganhos extras". Use *Ver ofertas* para conferir antes e *Enviar agora* para testar.

## Extensão do Chrome

1. No Chrome, abra `chrome://extensions`, ligue o **Modo do desenvolvedor** e clique em **Carregar sem compactação**. Escolha a pasta `extension`.
2. Clique no ícone da extensão e cole o **endereço** e o **token** que aparecem em *Ajustes* no painel.
3. Entre na sua conta de afiliado do Mercado Livre nesse mesmo Chrome.

O Chrome precisa ficar aberto enquanto as regras rodam. A extensão abre sozinha uma aba fixada da Central de Afiliados quando precisa; se a sessão vencer, ela recarrega a aba e tenta de novo. Se ainda assim falhar, o *Histórico* mostra "não há sessão de afiliado neste Chrome": basta entrar de novo na conta.

## O que foi testado e o que não foi

Testado (`npm test`, 17 testes): template, horário de funcionamento (inclusive virando a noite), envio para vários grupos, etiquetas separadas por regra, não repetir ofertas, filtros de preço e desconto, leitura da lista da Central de Afiliados, fila de pedidos com a extensão, API do painel e proteções.

Conferido uma vez contra a Central de Afiliados real (02/11/2026): a lista de produtos e a geração do link `meli.la` com etiqueta. O Mercado Livre pode mudar esses endereços sem aviso; se isso acontecer, o *Histórico* mostra o motivo. **Não testado contra o WhatsApp real**, porque exige a sua conta.

- Na fonte *Lista de links*, se o título e o preço não forem lidos sozinhos, escreva-os na linha: `link | título | preço | preço antigo | cupom`.
- A *Busca por palavra-chave* é experimental: a API pública do Mercado Livre pode recusar o acesso sem login.

## Cuidados

- A conexão com o WhatsApp é **não oficial**. Há risco de o número ser restringido. Mantenha as pausas em *Ajustes* e evite volume alto.
- A pasta `data` guarda a sessão do seu WhatsApp. Não compartilhe nem envie para a nuvem.
- O programa só aceita conexões do próprio computador (`127.0.0.1`).
