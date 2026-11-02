# Brief: disparo manual, disparar mensagem, relatórios e avisos, conexões, equipe e nova navegação

Escrito pelo lead a partir do pedido do dono (02/11/2026) e de capturas de tela de um painel de referência (Analytics Lead). As capturas estão em `/tmp/claude-1000/-home-ufla-Documentos-disparoAuto/6623ed91-a061-4e7f-90b5-0c2d2877be50/images/` (33.png disparo manual, 34.png disparar mensagem, 35.png relatórios e avisos, 36.png e 38.png conexões, 39.png equipe, 40.png navegação e planos). A referência é inspiração de fluxo e organização, não de marca: o achadinhoturbo mantém a identidade própria (`public/style.css`). Só copiamos o que o dono pediu; "Espelhamento", "Aquecedor de chip", "Planos e cobrança" e "Campanhas" NÃO fazem parte deste brief.

## Quem usa

O dono, Pedro, afiliado do Mercado Livre, no computador, usando o painel local (`localhost:3737`). Em breve, uma ou duas pessoas da equipe dele operando o mesmo painel. O produto hoje tem uma senha única; não há conceito de usuário.

## O que existe hoje (para reaproveitar)

- Regras de disparo automático (`src/scheduler.js`, página "Regras"), templates com placeholders (`src/template.js`), etiquetas de afiliado, grupos sincronizados do WhatsApp (`src/whatsapp.js`, Baileys), fila da extensão do Chrome que gera links `meli.la` e busca ofertas na Central (`src/links.js`, `extension/`), `resolveOffer` em `src/ml.js` que lê título/preço/imagem de um link do Mercado Livre, blocos de análise e visão geral (`src/analytics.js`), rotacionador de links (`src/rotador.js`), ajustes, histórico (`log`).
- Navegação atual em `public/index.html`: Visão Geral, Regras, Blocos de análise, Rotacionador de Links, Etiquetas, Templates, WhatsApp e grupos, Histórico, Ajustes, Ajuda.

## Features pedidas

### F1. Disparo manual (33.png)
Colar um link de produto, escolher os grupos e o template, e disparar. O painel identifica a loja, gera o link de afiliado e envia com a imagem do produto, usando o template (mesmos placeholders das regras). Lista de grupos com busca e contagem de membros. Prévia do template preenchido. Opção "Agendar horário": desligado dispara na hora; ligado, dispara no horário de hoje escolhido. Lado direito: histórico com contadores (enviados, pendentes, com erro) e tabela (quando, produto, loja, grupo, status).
- Hoje só o Mercado Livre funciona de ponta a ponta (link `meli.la` pela extensão). Link de outra loja: identificar a loja e dizer claramente que ela ainda não está conectada (ver F4).

### F2. Disparar mensagem (34.png)
Mensagem comum (texto com formatação do WhatsApp) ou enquete, para os grupos escolhidos. Imagem: sem imagem, foto com legenda (upload) ou prévia do link. Quando enviar: agora, agendar para um dia e horário, ou repetir em dias da semana e horários. Lado direito: "Agendadas e repetidas" (com cancelar/pausar) e histórico (enviados, na fila, com erro).

### F3. Relatórios e avisos (35.png)
Números de WhatsApp (pessoas) que recebem avisos e o resumo diário dos blocos de análise, escolhendo de quais blocos. Botões "Enviar resumo agora" e "Adicionar número". Configurações gerais: horário do resumo diário, virada do dia (entradas até esse horário contam para o dia anterior), limite padrão por grupo (máximo do WhatsApp 1024). Avisos: pelo menos grupo lotando (já existe `verificarLotacao` em `src/rotador.js`) e erro de disparo.

### F4. Conexões (36.png, 38.png)
Página "Conexões" com cartões por plataforma. Mercado Livre: etiqueta(s) e extensão, estado "Conectado" (já funciona). Amazon (tag de associado, sem API), Shopee (AppID + chave secreta), Magalu (nome da loja), Facebook: cartões prontos em estrutura (campos, salvar, testar), mas com aviso visível de "ainda não implementado" até existir a integração. Toda loja configurada deve ter um ponto único no código para o F1 identificar a loja pelo link e trocar pelo link de afiliado quando a integração existir. Segredos (chave da Shopee) guardados sem voltar ao navegador (campo "salva, preencha só para trocar").

### F5. Equipe (39.png)
Nome da conta; convidar pessoa por e-mail com papel (Operador usa todas as telas; Dono também convida, remove e muda papéis); lista de pessoas (nome, e-mail, papel, entrou em); convites pendentes com link copiável, vencimento em 7 dias e cancelar. Sem servidor de e-mail: o convite é um link que o dono copia e manda. Isso muda o login de senha única para usuários individuais; o dono atual vira o primeiro Dono.

### F6. Nova navegação (40.png)
Separar o menu em grupos: PRINCIPAL (Visão Geral, Rotacionador de Links, Grupos, Blocos de análise), DISPAROS (Disparo manual, Disparo automático = as Regras de hoje, Disparar mensagem, Templates), COMUNICAÇÃO (Relatórios e avisos), CONTA (Conexões, Números de WhatsApp = a página WhatsApp de hoje, Equipe). Etiquetas, Histórico, Ajustes e Ajuda continuam acessíveis (o arquiteto e o designer decidem onde; Etiquetas pode viver dentro de Conexões → Mercado Livre).

## Critérios de aceite

- CA1. Em Disparo manual, colar um link do Mercado Livre, marcar ao menos um grupo e um template e clicar "Disparar" envia a mensagem com imagem e link `meli.la` da etiqueta escolhida; a linha aparece no histórico como enviada.
- CA2. Link de loja não conectada é identificado pelo nome da loja e recusado com mensagem clara, sem enviar nada.
- CA3. Disparo manual agendado para um horário de hoje fica como pendente e é enviado no horário, inclusive se o serviço reiniciar antes.
- CA4. Em Disparar mensagem, enviar texto (com e sem imagem) e enquete para grupos marcados funciona agora, agendado e repetido; agendadas e repetidas aparecem na lista e podem ser canceladas; o histórico mostra enviados, na fila e com erro.
- CA5. Em Relatórios e avisos, um número cadastrado recebe "Enviar resumo agora" com o resumo dos blocos marcados; o resumo diário sai no horário configurado; a virada do dia e o limite padrão por grupo são respeitados onde já existem (analytics e rotacionador).
- CA6. Conexões mostra Mercado Livre como conectado com a etiqueta e a extensão; Amazon, Shopee, Magalu e Facebook aparecem com aviso "ainda não implementado", campos salváveis e segredo que não volta ao navegador.
- CA7. Equipe: o dono atual entra com usuário e senha; cria convite com papel; o link do convite abre uma tela de cadastro (nome + senha) e a pessoa passa a entrar; Operador não vê nem alcança ações de Equipe; Dono remove pessoas e muda papel; convite vence em 7 dias e pode ser cancelado.
- CA8. Navegação reorganizada nos grupos acima, com os textos de ajuda (`public/ajuda.js`) e o README atualizados; todas as páginas antigas continuam alcançáveis.
- CA9. `npm test` continua passando e há testes para F1, F2, F3 e F5 no servidor.
- CA10. Nada de dado pessoal novo em log; números de destino dos avisos e e-mails da equipe ficam só em `data/`; o `seguranca` revisa F5, F3 e F4 (sensíveis).
