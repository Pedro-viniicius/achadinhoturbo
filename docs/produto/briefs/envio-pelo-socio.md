# Brief: links enviados pelo sócio pelo WhatsApp

Data: 04/11/2026. Origem: pedido do dono no chat, com decisões tomadas por ele (perguntas de múltipla escolha).

## Problema

O dono tem um sócio que também acha ofertas e quer que ele possa "mandar link também". O painel roda só no computador do dono (localhost; VPS adiado), então dar acesso ao painel (Equipe → Operador) não resolve.

## O que o dono decidiu

1. **Canal:** o sócio manda o link numa **conversa privada** de WhatsApp para o número que está conectado ao painel. Hoje conversa privada é ignorada.
2. **Quem pode:** só números que o dono **cadastrar** no painel (ex.: o do sócio). Mensagem privada de qualquer outro número continua ignorada.
3. **Lojas:** Mercado Livre, Amazon e Shopee (as três).
4. **Destino:** vai **direto, sem aprovação**, para um conjunto **fixo** de grupos (ou um bloco) que o dono escolhe uma vez. Respeita as pausas de Ajustes e a fila única de envios, e aparece no Histórico.

## O que precisa ficar claro no plano/spec

- Onde o dono cadastra o número e escolhe os grupos e o template (tela nova ou seção em tela existente; lembrar que "Números de WhatsApp" hoje é a conexão do WhatsApp e "Relatórios e avisos" guarda os números que recebem avisos).
- Como o link vira oferta em cada loja: link de afiliado (ML: etiqueta via extensão; Amazon: tag; Shopee: ID via extensão/API), título/preço/foto (API quando houver; senão o texto da mensagem do sócio, como no Espelhamento; o que fazer quando falta título ou preço).
- Se o sócio recebe resposta no privado (ex.: "Enviado para N grupos" / "Não reconheci o link"), e com que frases.
- Não repetir a mesma oferta, limite por hora, mensagem com vários links.
- Identificação do remetente no Baileys 7: mensagens privadas podem chegar com JID `@lid` em vez do número; como casar com o número cadastrado.
- LGPD: o número do sócio é dado pessoal (mascarado na API, nunca no log, entra no backup), como `aviso_destinos`.
- Segurança: só números cadastrados; nada de comando além de link; limite de abuso se o número do sócio for comprometido.

## Fora do escopo

- Acesso remoto ao painel; mais de um "dono".
- Aprovação manual dos links do sócio (o dono escolheu envio direto).

## Preferência do dono a respeitar

Sem avisos técnicos de estado conhecido nas telas de uso (ver memória "sem avisos técnicos"): a tela mostra o que importa para usar, o detalhe técnico fica em Conexões.
