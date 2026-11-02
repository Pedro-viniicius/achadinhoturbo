# Especificação de UI/UX: disparos, comunicação, conta e nova navegação

Brief: `docs/produto/briefs/disparos-comunicacao-conta.md` (CA1 a CA10). Referências de fluxo (só inspiração): capturas 33, 34, 35, 36, 39, 40. Identidade, tokens e componentes são os do achadinhoturbo (`public/style.css`). Fora de escopo: Espelhamento, Aquecedor de chip, Planos e cobrança, Campanhas, "Em breve".

## Objetivo e usuário

Pedro (dono, afiliado do Mercado Livre) no computador, e em breve uma ou duas pessoas da equipe. Querem disparar uma oferta ou um aviso na hora, sem criar regra, saber o que saiu e o que falhou, e dar acesso à equipe sem passar a senha. Ficam com pressa, conhecem WhatsApp e Mercado Livre, não conhecem jargão técnico. Uso principal em tela larga; o painel precisa continuar usável de 320 px (conferir o estado do envio pelo celular).

Princípio: uma ação principal por tela, rótulo em toda ação, resultado sempre visível (toast + linha no histórico), e nada de prometer o que ainda não funciona (selo "Ainda não implementado" em vez de botão que não faz nada).

## Fluxo

1. **Disparo manual:** colar link, "Identificar" (loja + produto), marcar grupos, escolher template (prévia preenchida), etiqueta, opcional agendar hora de hoje, "Disparar". Linha nova no histórico à direita.
2. **Disparar mensagem:** Mensagem ou Enquete, grupos, texto/enquete, imagem, quando enviar, "Disparar"/"Agendar"/"Salvar repetição". Agendadas e repetidas aparecem à direita (pausar só nas repetidas; agendadas só cancelam).
3. **Relatórios e avisos:** cadastrar números, marcar blocos e avisos de cada um, "Enviar resumo agora", ajustar horário/virada/limite.
4. **Conexões:** ver o que está ligado; Mercado Livre pronto; outras lojas com campos salváveis e selo de não implementado.
5. **Equipe:** convidar (e-mail + papel) → copiar link → mandar à pessoa → ela abre `/convite/<token>`, define nome e senha → entra. Dono remove, muda papel, cancela convite.
6. **Entrar:** e-mail + senha.

## Layout (mobile e desktop)

### Navegação (F6)

Barra lateral atual (`.rail`, 220 px, `nav` em `index.html`), agora com grupos. Rótulo de grupo: texto de 11 px caixa alta, `--muted`, mesmo estilo de `.kpi .rotulo` (classe nova `.nav-grupo`), é `<p>`/`role="presentation"`, não é link. Cada grupo é `<div role="group" aria-labelledby>` dentro do `<nav aria-label="Principal">`.

| Grupo | Itens (rótulo final) | Hash |
|---|---|---|
| (sem título, topo) | Visão Geral | `#visao` |
| PRINCIPAL | Rotacionador de Links | `#links` |
| | Grupos | `#grupos` (nova, ver pergunta 1) |
| | Blocos de análise | `#blocos` |
| DISPAROS | Disparo manual | `#disparo-manual` |
| | Disparo automático | `#disparo-automatico` (antes "Regras") |
| | Disparar mensagem | `#disparar-mensagem` |
| | Templates | `#templates` |
| COMUNICAÇÃO | Relatórios e avisos | `#relatorios` |
| CONTA | Conexões | `#conexoes` |
| | Números de WhatsApp | `#numeros` (antes "WhatsApp e grupos") |
| | Equipe (só Dono) | `#equipe` |
| Rodapé (separado por linha) | Histórico, Ajustes, Ajuda, nome/e-mail da pessoa e "Sair" | `#historico` `#ajustes` `#ajuda` |

Decisões:
- **Visão Geral** fica solta no topo (como a captura 40), pois é a página de entrada; PRINCIPAL começa no Rotacionador. Se o dono preferir Visão Geral dentro de PRINCIPAL, é só mover o item.
- **Etiquetas** deixa o menu: vira a seção "Etiquetas de afiliado" dentro do cartão Mercado Livre em Conexões (a tela `paginaEtiquetas` é reaproveitada lá, sem mudança de comportamento).
- **Histórico, Ajustes, Ajuda** ficam no rodapé da barra, sem título de grupo: são de apoio, e três itens a mais dentro de CONTA diluiriam o que é "Conta".
- **Transição dos nomes:** os hashes antigos continuam funcionando como alias (CA8): `#regras` → `#disparo-automatico`, `#whatsapp` → `#numeros`, `#etiquetas` → `#conexoes` (rola até "Etiquetas de afiliado"). O título `h1` da página usa o nome novo. Em "Disparo automático" o subtítulo diz "Antes chamado de Regras. Cada disparo automático escolhe…" durante uma versão; depois pode sair. Textos internos que dizem "regra" (formulário, ajuda, vazios) passam a "disparo automático" onde falam da página; "regra" em frases como "Nova regra" vira "Novo disparo automático".
- **Estado ativo:** o mesmo de hoje (`nav a.on`: fundo `--primary-tint`, texto `--primary-text`, barra de 3 px à esquerda) mais `aria-current="page"`. O grupo não "ativa", só o item.
- **Papel Operador:** o item Equipe não existe no DOM (não é só escondido) e `#equipe` cai na Visão Geral.
- **Largura estreita (≤ 900 px):** hoje o menu vira faixa horizontal rolável; com 14 itens isso não serve. Passa a ser barra superior fixa com logo + botão "Menu" (`aria-expanded`, `aria-controls`). Aberto, mostra os grupos em lista vertical sobre o conteúdo (largura total, rolável, alvos de 44 px). Fecha ao escolher um item, com Esc, ou ao tocar fora; o foco volta ao botão. O item ativo aparece no botão ("Menu · Disparo manual") para o usuário saber onde está.

### Padrão das telas novas

Todas usam `.topo` (h1 + `.sub` + ação principal opcional) e `.card`. Duas colunas = nova `.duas-col` (`minmax(0,1.4fr) minmax(300px,1fr)`, `gap:16px`, `align-items:start`) que vira uma coluna em ≤ 900 px, com a coluna do histórico **abaixo** do formulário. `main` hoje tem `max-width:1040px`; as telas de duas colunas precisam de 1180 px (nova classe `main.larga`, aplicada em `ir()` pelas rotas de disparo). Em todas, o formulário ocupa a esquerda e o acompanhamento a direita, como na referência.

### Disparo manual (F1), `#disparo-manual`

Esquerda, um `.card` com `<form>`:
1. **Link do produto** (`.campo` + `.linha`): input + botão "Identificar" (largura total no celular).
2. **Resultado da identificação** (`.card-prod`, novo, `aria-live="polite"`), logo abaixo: imagem 72×72 (`object-fit:cover`, `alt` = título; vem do `mlstatic` do Mercado Livre, com a CSP `img-src` liberada para esse domínio), título (2 linhas, reticências), preço (e preço antigo riscado, se houver), e uma chip com a loja ("Mercado Livre"). Loja não conectada: mesmo bloco com borda e fundo de aviso (`--warn`, ícone de texto "!" , não só cor): "Amazon identificada, mas ainda não está conectada. Configure em Conexões." com link para `#conexoes`. Nesse caso "Disparar" fica desabilitado e a explicação aparece como texto ao lado do botão (não só `title`).
3. **Grupos que vão receber** (`fieldset`): reaproveita `filtroGrupos` inteiro (`#busca`, `#so-marcados`, `#gr`, "Marcar visíveis", "Limpar"); contador "(N selecionados)" na legenda; cada linha mostra a quantidade de membros à direita (já é `<small>`). Altura 210 px.
4. **Template** (`select`) com link "Gerenciar templates" (`#templates`), e abaixo a **prévia**: `.chat > .balao`, preenchida com o produto identificado (mesma `zap()` + `/templates/preview` de hoje). Antes de identificar: prévia com dados de exemplo e legenda "Exemplo. Identifique um link para ver com o seu produto."
5. **Etiqueta** (`select`, padrão = primeira etiqueta), com a dica "O link meli.la sai com esta etiqueta."
6. **Agendar horário** (`.chave` toggle + rótulo + dica "Desligado, dispara na hora. Ligado, dispara no horário de hoje que você escolher."). Ligado mostra `input type=time` (padrão = próxima hora cheia). Hora no passado = erro inline.
7. **Rodapé do card:** botão `pri` "Disparar" (vira "Agendar envio" com o toggle ligado) + texto de resumo "3 grupos · Template Padrão · agora".

Direita, `.card` "Histórico": três `.kpi` pequenos (Enviados, Pendentes, Com erro; o de erro em `--err` com texto "Com erro" visível) e `.tabela` com Quando, Produto (título + loja em `.dica`), Grupo, Status (texto + cor: `nivel-ok` Enviado, `nivel-aviso` Pendente com a hora, `nivel-erro` Erro com o motivo curto). Atualiza a cada 6 s enquanto a página está aberta (mesmo padrão de `paginaHistorico`). Mostra os 20 mais recentes; "Ver tudo no Histórico" leva a `#historico`.

### Disparar mensagem (F2), `#disparar-mensagem`

Esquerda, um `.card`:
1. **Grupos** (igual ao Disparo manual).
2. **Tipo**: `.seg` com dois botões "Mensagem" e "Enquete" (`role="radiogroup"` + `aria-checked`, setas alternam).
3. **Mensagem:** `textarea` (8 linhas, 4096 caracteres, contador "n/4096") com rótulo "Mensagem" e dica fixa "Use *negrito*, _itálico_ e ~riscado~ como no WhatsApp." Prévia ao lado/abaixo em `.chat > .balao` (via `zap()`).
4. **Enquete:** "Pergunta" (input, 255) e lista "Opções" (inputs numerados; "+ Adicionar opção" até 12; cada opção de 3 em diante tem "Remover"; mín. 2); checkbox "Permitir mais de uma resposta" ("múltipla escolha"). Contador "3 de 12 opções".
5. **Imagem** (só no tipo Mensagem), `fieldset` com `.seg`: "Sem imagem" | "Foto com legenda" | "Prévia do link". Foto: botão "Escolher foto" (input file, JPG ou PNG, até 5 MB) com miniatura e "Trocar"/"Remover"; o texto da mensagem vira a legenda (dica: "O texto acima vai como legenda."). Prévia do link: campo "Link" + dica "O WhatsApp mostra o título e a imagem do site embaixo do texto." Enquete não tem imagem (o fieldset some, sem deixar buraco).
6. **Quando enviar**, `fieldset` com `.seg`: "Agora" | "Agendar" | "Repetir".
   - Agendar: `input type=date` + `input type=time` (data mínima = hoje).
   - Repetir: sete botões de dia (D S T Q Q S S, rótulo acessível "Segunda-feira", `aria-pressed`, alvo 44 px, `.chips`), campo "Horários" com chips de hora e "+ Adicionar horário" (`input type=time`; até 6); dica "Ex.: segunda e quinta, às 09:00 e 18:00." Opcional "Termina em" fica fora (pendência).
7. Botão principal muda com o modo: "Disparar agora" | "Agendar envio" | "Salvar repetição".

Direita, dois cards:
- **Agendadas e repetidas** (lista; vazio: "Nada agendado. Escolha Agendar ou Repetir em Quando enviar."). Cada item: trecho do texto (2 linhas) ou "Enquete: pergunta", grupos ("3 grupos"), quando ("Hoje 18:00" / "Seg e qui, 09:00 e 18:00"), próximo envio, chip "Pausada" quando for o caso; ações "Pausar"/"Retomar" (só repetidas; agendadas só têm "Cancelar") e "Cancelar" (`perigo leve`, com `confirm()` como o resto do painel).
- **Histórico**: três `.kpi` (Enviados, Na fila, Com erro) + `.tabela` (Quando, Mensagem/Enquete, Grupo, Status).

### Relatórios e avisos (F3), `#relatorios`

`.topo` com os botões "Enviar resumo agora" (neutro) e "Adicionar número" (`pri`). Largura normal (uma coluna).
- **Números que recebem** (`.card.tabela`): colunas Nome, Número (mascarado: `+55 35 9****-1234`, completo só no formulário de edição), Resumo dos blocos (chips; "Todos" ou nomes), Avisos (chips: "Grupo lotando", "Erro de disparo"), Ativo (`.chave`), Ações (Editar, Remover). Vazio: "Nenhum número cadastrado. Adicione quem deve receber os avisos e o resumo diário."
- **Formulário** (`<dialog>`, igual aos formulários atuais): Nome, Número (`type=tel`, dica "Com DDD. Exemplo: 35 99999-1234"), `fieldset` "Resumo diário: quais blocos" (checkboxes dos blocos + "Todos os grupos"; "Nenhum" desliga o resumo desse número), `fieldset` "Avisos" (checkbox "Grupo lotando" e "Erro de disparo", com a dica de cada um), "Ativo".
- **Prévia do resumo** (`.card`): `.chat > .balao` com o texto que sairá no próximo resumo, montado com os dados de hoje; seletor "Ver como:" (números cadastrados) se os blocos diferem. Legenda: "Exemplo com os dados de agora."
- **Configurações gerais** (`.card`, `.grade` de 3): "Horário do resumo diário" (`time`), "Virada do dia" (`time`, dica "Entradas até esse horário contam para o dia anterior."), "Limite padrão por grupo" (`number` 2 a 1024, dica "O máximo do WhatsApp é 1024."), botão "Salvar configurações".

### Conexões (F4), `#conexoes`

`.topo` (h1 + `.sub` "Plataformas ligadas ao painel."). Ordem: Mercado Livre primeiro (único funcionando), depois grade `auto-fit minmax(300px,1fr)` com Amazon, Shopee, Magalu, Facebook.
- **Cartão (`.card.conexao`)**: cabeçalho com nome + selo de estado à direita; descrição de 1 a 2 linhas; campos; ações.
- **Selos** (`.estado-pill`, texto sempre visível, nunca só cor): "Conectado" (`--ok`), "Ainda não implementado" (`--warn`, fundo cheio, 12 px, **no cabeçalho de cada cartão** e repetido num `.aviso-impl` dentro do cartão: "Você já pode guardar os dados. O painel só vai usar quando a integração existir."), "Falta configurar" (neutro).
- **Mercado Livre**: selo Conectado; seção "Etiquetas de afiliado" (a página de Etiquetas de hoje: formulário nome+anotação, tabela com "Usada em", Excluir); seção "Extensão do Chrome" com passos numerados (`.passos`) e checks de estado: 1 Instale a extensão no Chrome; 2 Abra a Central de Afiliados logado; 3 Cole o endereço e o token (campos com "Copiar", hoje em Ajustes > extensão, que passa a viver aqui; Ajustes mantém só um link "Ver em Conexões"). Linha de estado: "Extensão conectada. Último link gerado em 02/11 10:32." ou "Extensão desconectada" com a causa.
- **Amazon**: "Tag de associado" (`input`, dica "Ex.: seunome-20"). Ações "Salvar" e "Testar".
- **Shopee**: "AppID" + "Chave secreta" (`type=password`, `autocomplete=off`). Com chave salva: placeholder "•••••••• (salva, preencha só para trocar)" e dica "A chave não volta para o navegador." O valor nunca é preenchido no HTML. Ações "Salvar", "Testar".
- **Magalu**: "Nome da sua loja" (dica "Como aparece no endereço da sua loja de parceiro."). "Salvar".
- **Facebook**: só descrição "Acompanhar campanhas e gasto no painel." + selo; sem campos (o brief não define dados).
- **Botão "Testar" enquanto não implementado:** habilitado só depois de salvar; ao clicar mostra, inline no cartão, "Teste ainda não disponível: a integração da Amazon não foi implementada. Seus dados estão salvos." (`role="status"`, tom de aviso). Nada de "sucesso" falso. Alternativa se o dev preferir: `disabled` + `aria-describedby` apontando para o aviso. Recomendo a primeira, pois o desabilitado esconde o porquê.

### Equipe (F5), `#equipe` (só Dono)

- Linha 1, `.grade` 2 colunas: card "Nome da conta" (input + "Salvar"; dica "Aparece no convite.") e card "Convidar pessoa" (E-mail, Papel `select` Operador/Dono, dica "Operador usa todas as telas. Dono também convida, remove pessoas e muda papéis. O convite vale por 7 dias.", botão `pri` "Criar convite"). Depois de criar, **não há e-mail**: aparece no próprio card um bloco de sucesso com o link em `.copia` + "Copiar link" e o texto "Mande este link para a pessoa. Ele só aparece completo aqui e na lista abaixo."
- **Pessoas (N)** (`.tabela`): Pessoa (nome + e-mail em `.dica`, chip "você" na linha da própria pessoa), Papel (badge: "Dono" `--primary-tint`, "Operador" neutro; texto sempre presente), Entrou em, Ações. Ações do Dono: `select` de papel por linha (ou "Tornar Dono"/"Tornar Operador") e "Remover" (`perigo leve`, `confirm`). A própria linha e o último Dono não têm "Remover" nem troca de papel (mostram texto "Último Dono").
- **Convites pendentes (N)** (`.tabela`): E-mail (+ "convidado por …"), Papel, Vence em (data; em `--warn` com texto "vence amanhã" no último dia; vencido: chip "Vencido", só "Cancelar"), Link (input `readonly` mono + botão "Copiar", `aria-label="Copiar link do convite de <email>"`), Cancelar. Vazio: "Nenhum convite pendente."

### Tela de aceite `/convite/<token>` (pública, página nova `public/convite.html`)

Mesmo layout de `login.html` (`.login-caixa`, logo, `.card`). Título "Você foi convidado". Texto "<Nome da conta> convidou você como <Papel>." e o e-mail em leitura (`readonly`, não editável). Campos: Nome, Senha (mín. 8, mostrar/ocultar), Confirmar senha. Botão `pri` "Criar minha conta". Erros inline abaixo do campo (ver Estados). Convite inválido, vencido, usado ou cancelado: sem formulário, card com "Este convite não vale mais" + "Peça um novo link a quem convidou você." (mensagem única para os quatro casos, sem revelar qual).

### Entrar (`login.html` alterado)

Campos E-mail (`type=email`, `autocomplete=username`, autofocus) e Senha (`autocomplete=current-password`), botão "Entrar". Texto `.sub`: "Seus achadinhos chegam primeiro." (sai "Use a senha definida na instalação"). Erro único para qualquer falha: "E-mail ou senha incorretos." (não diz qual está errado). Bloqueio por excesso de tentativas, se existir: "Muitas tentativas. Tente de novo em N minutos."

### O que o Operador não vê

Item Equipe do menu e a rota; botões de gerenciar pessoas; "Gerar novo token" da extensão e "Remover número" em Relatórios e avisos? Decisão do brief: Operador usa todas as telas, então só Equipe some. Itens sensíveis além de Equipe ficam como pergunta 4.

## Componentes

| Componente | Existente ou novo | Onde fica |
|---|---|---|
| `.card`, `.topo`, `.sub`, `.campo`, `.grade`, `.linha`, `.chip`, `.seg`, `.chips`, `.chave`, `.kpi`, `.tabela`, `.vazio`, `.erros`, `.invalido`, `.chat/.balao`, `.copia`, `.passos`, `.estado-pill`, `<dialog id="dlg">`, toast | Existentes | `style.css` |
| `filtroGrupos`, `opcoes`, `mostrarErros`, `REQ`, `q()`, `zap()`, `tentar`, `aviso` | Existentes | `app.js`, `ajuda.js` |
| Seletor de grupos (marcação HTML do `fieldset` com busca, "Só marcados", "Limpar") | Existente, extrair em função `seletorGrupos()` para as 3 telas | `app.js` |
| Navegação com grupos, botão Menu e rodapé | Novo | `index.html`, `style.css`, `app.js` (`ir`, `ROTAS`) |
| `.duas-col`, `main.larga` | Novo | `style.css` |
| `.card-prod` (resultado do produto) | Novo | `style.css` |
| Botão de dia da semana (`.chips` com `aria-pressed`) | Variante do existente | `style.css` |
| Lista de opções da enquete | Novo (padrão da lista `.ordem`) | `style.css` |
| `.aviso-impl`, `.card.conexao` | Novo | `style.css` |
| Campo de segredo ("salva, preencha só para trocar") | Novo | `app.js` |
| Badge de papel (`.estado-pill` + variante `.dono`) | Variante do existente | `style.css` |
| Páginas `paginaDisparoManual`, `paginaDispararMensagem`, `paginaRelatorios`, `paginaConexoes`, `paginaEquipe` | Novas | `public/disparos.js` (novo, carregar depois de `paineis.js`), `public/conta.js` (Conexões e Equipe) |
| `convite.html` + `convite.js` | Novos | `public/` |

Tokens: nenhum novo. Cores só por token (`--ok`, `--warn`, `--err`, `--primary*`, `--muted`). Os novos arquivos JS evitam inflar `app.js`/`paineis.js`.

## Estados

Vale para todas as telas novas, além dos padrões de hover/foco/ativo/desabilitado dos componentes existentes.

- **Carregando:** `.sub` "Carregando…" (como `paginaVisao`); botões que chamam o servidor mostram o gerúndio e ficam `disabled` ("Identificando…", "Enviando…", "Salvando…").
- **Vazio:** `.vazio` (borda tracejada) com texto que diz o que fazer e para onde ir. Sem grupos: "Nenhum grupo carregado. Conecte o WhatsApp em Números de WhatsApp." com link.
- **Sucesso:** toast (`aviso()`) + mudança visível na tela (linha nova, chip). Nunca só toast.
- **Erro de campo:** `mostrarErros(container, [{msg, el}])` como hoje (caixa `.erros` com "Antes de enviar, falta:" e campo marcado `.invalido`). Para a tela de convite e login, erro inline curto sob o campo (`<p class="login-erro" id=…>` ligado por `aria-describedby`, `role="alert"` na região).
- **Erro de servidor:** `mostrarErros(…, [{msg: e.message}])` dentro do formulário, ou `aviso(msg, true)` fora dele.
- **Botão Disparar (F1):** `Ocioso` (habilitado só com loja ML identificada + 1 grupo + template; senão `disabled` e frase do que falta ao lado) → `Enviando…` (desabilitado, rótulo no botão e `aria-busy` no card; os campos ficam travados) → `Enviado` por 3 s ("Enviado para 3 grupos" com texto, check, `--ok`) → volta a Ocioso e limpa o link e o resultado, mantendo grupos e template (para disparar outro produto nos mesmos grupos) → `Erro`: botão volta a Ocioso, a `.erros` explica ("Não consegui enviar para 2 de 3 grupos. Veja o motivo no histórico.") e o histórico mostra a linha com erro. Envio parcial: sucesso e erro convivem, com contagem nos dois.
- **Identificar:** ocioso → "Identificando…" → ok (card-prod) | loja não conectada (aviso) | link inválido ("Não reconheci este link. Cole o endereço completo da página do produto.") | produto sem título/preço lido ("Achei o produto, mas não consegui ler o preço. O template vai omitir essa linha.") — Disparar continua habilitado nesse caso. Editar o link depois de identificar limpa o resultado.
- **Agendado (F1/F2):** linha no histórico com status "Pendente · 18:00" e, no F2, entrada em "Agendadas e repetidas".
- **Conteúdo longo:** títulos e nomes de grupo em 2 linhas com reticências e `title`; nomes de grupo com emoji ou só JID são mostrados como estão. Textos longos de mensagem na lista de agendadas: 2 linhas.
- **Conexões:** cada cartão tem seu próprio estado de "Salvando…"/"Salvo" (texto `role="status"`); segredo vazio ao salvar mantém o antigo (dica "Deixe em branco para manter a chave atual").
- **Equipe:** "Criar convite" desabilita enquanto cria; e-mail já na equipe ou com convite pendente: "Esta pessoa já está na equipe." / "Já existe um convite para este e-mail. Cancele-o para criar outro."; remover a si mesmo ou o último Dono é barrado com o texto na linha.
- **Perda de permissão:** se o servidor responder 403 a um Operador, `aviso("Só o Dono pode fazer isso.", true)`.
- **Modo simulação:** pílula da faixa já avisa; os botões Disparar não mudam, mas o histórico marca "simulado" no status.

## Textos da interface

Todos em pt-BR, tom direto. Ficam em constantes no topo dos novos arquivos JS (o projeto não tem arquivo de traduções) e os de ajuda em `ajuda.js`.

**Títulos e subtítulos**
- Disparo manual: "Cole o link de um produto, escolha os grupos e o template e dispare. O painel identifica a loja, gera o seu link de afiliado e envia com a foto do produto."
- Disparo automático: "Cada disparo automático escolhe uma etiqueta, os grupos, o template e o ritmo. Pode ter quantos quiser."
- Disparar mensagem: "Uma mensagem comum (com foto, se quiser) ou uma enquete para os grupos que você escolher. Envie agora, agende ou repita nos dias da semana."
- Relatórios e avisos: "Quem recebe os avisos e o resumo diário no WhatsApp, e de quais blocos."
- Conexões: "Plataformas ligadas ao painel."
- Equipe: "Pessoas que usam esta conta. Todas veem e mexem nos mesmos números, links e grupos."
- Rótulos de grupo do menu: PRINCIPAL, DISPAROS, COMUNICAÇÃO, CONTA.

**Botões:** Identificar, Disparar, Agendar envio, Disparar agora, Salvar repetição, Escolher foto, Trocar foto, Remover foto, + Adicionar opção, + Adicionar horário, Pausar, Retomar, Cancelar envio, Enviar resumo agora, Adicionar número, Salvar número, Remover número, Salvar configurações, Salvar, Testar, Salvar etiqueta, Copiar, Copiar link, Criar convite, Cancelar convite, Remover da equipe, Criar minha conta, Entrar, Menu.

**Dicas e mensagens**
- Link: placeholder "Cole aqui o link do produto". Identificado: "Mercado Livre · pronto para disparar". Não conectada: "{Loja} identificada, mas ainda não está conectada. Configure em Conexões."; ao lado do botão: "Conecte a loja para disparar."
- Falta algo (lista da `mostrarErros`): "Identifique o link do produto." / "Marque ao menos um grupo." / "Escolha um template." / "Escolha a hora do envio." / "A hora precisa ser depois de agora." / "Escreva a mensagem." / "A enquete precisa de uma pergunta." / "A enquete precisa de ao menos 2 opções." / "Escolha ao menos um dia da semana." / "Adicione ao menos um horário." / "Número inválido. Use DDD e número, ex.: 35 99999-1234." / "Dê um nome ao número." / "Escolha um e-mail válido." / "As senhas não são iguais." / "A senha precisa de ao menos 8 caracteres."
- Sucesso: "Enviado para 3 grupos", "Envio agendado para hoje às 18:00", "Repetição salva", "Mensagem cancelada", "Resumo enviado para 2 números", "Número salvo", "Configurações salvas", "Link do convite copiado", "Convite cancelado", "Pessoa removida", "Papel alterado".
- Resumo agora sem número ativo: "Cadastre um número ativo para enviar o resumo."
- Confirmações: "Cancelar esta mensagem? Ela não será enviada." / "Remover {nome} da equipe? Essa pessoa perde o acesso agora." / "Remover este número? Ele deixa de receber avisos e resumos." / "Cancelar o convite para {e-mail}? O link deixa de funcionar."
- Dica de privacidade em Relatórios: "Os números ficam só no seu computador."
- Equipe, Operador: "Operador usa todas as telas, menos Equipe."
- Aviso de loja: "Ainda não implementado" + "Você já pode guardar os dados. O painel só vai usar quando a integração existir."

**Verbetes novos para `TIPS` (chave: texto)**
- `manual`: 'Dispare uma oferta agora ou em um horário de hoje, sem criar disparo automático. Cole o link, escolha grupos e template.'
- `manual.link`: 'Cole o link do produto. “Identificar” descobre a loja e lê título, preço e foto. Hoje só o Mercado Livre gera link de afiliado.'
- `manual.agendar`: 'Desligado, envia na hora. Ligado, envia no horário de hoje que você escolher. Se o programa reiniciar antes, o envio continua agendado.'
- `manual.etiqueta`: 'Etiqueta usada no link meli.la desta mensagem. É o que atribui a comissão a você.'
- `mensagem`: 'Texto livre ou enquete para os grupos escolhidos. Serve para avisos, sorteios e chamadas que não são oferta.'
- `mensagem.formato`: 'No WhatsApp: *negrito*, _itálico_, ~riscado~.'
- `mensagem.enquete`: 'A enquete tem uma pergunta e de 2 a 12 opções. Marque “mais de uma resposta” se a pessoa puder votar em várias.'
- `mensagem.imagem`: 'Foto com legenda: a foto vai com o texto embaixo. Prévia do link: o WhatsApp mostra título e imagem do site do link (só Mercado Livre).'
- `mensagem.quando`: 'Agora, em um dia e horário, ou repetido nos dias da semana e horários que você escolher. Repetidas e agendadas podem ser pausadas ou canceladas na lista ao lado.'
- `relatorios`: 'Números de WhatsApp que recebem avisos e o resumo diário dos blocos escolhidos. É por onde você fica sabendo de um grupo lotando ou de um envio que falhou.'
- `relatorios.virada`: 'Hora em que um “dia” termina nos relatórios. Entradas antes dela contam para o dia anterior. Útil se seus picos passam da meia-noite.'
- `relatorios.limite`: 'Quantidade de membros em que um grupo é considerado cheio, quando o link do rotacionador não define outro. O máximo do WhatsApp é 1.024.'
- `relatorios.avisos`: '“Grupo lotando”: um grupo chegou perto do limite. “Erro de disparo”: uma mensagem não saiu.'
- `conexoes`: 'Onde ficam as lojas e a extensão que geram os seus links de afiliado. Só o Mercado Livre funciona hoje; as outras guardam os dados para quando forem implementadas.'
- `conexoes.segredo`: 'A chave fica guardada no seu computador e não volta para esta tela. Preencha só se quiser trocar.'
- `equipe`: 'Quem pode entrar no painel. Operador usa todas as telas; Dono também convida, remove pessoas e muda papéis.'
- `equipe.convite`: 'Não enviamos e-mail: copie o link e mande pelo WhatsApp. Vale 7 dias e só pode ser usado uma vez.'
- Ajustar `regras` → "Um disparo automático escolhe…"; `etiquetas` → acrescentar "Fica em Conexões > Mercado Livre."; `whatsapp` → "Números de WhatsApp".

**`AJUDA` (cartões da página Ajuda):** acrescentar um cartão por tela nova (título, 3 passos, uma dica) com os textos acima: "Disparo manual" (colar, identificar, marcar grupos, disparar); "Disparar mensagem"; "Relatórios e avisos"; "Conexões"; "Convidar alguém para a equipe" (criar convite, copiar link, mandar, pessoa cria a senha). No glossário: "Operador", "Dono", "Virada do dia", "Enquete". Cartões e glossário de "Regras" renomeados para "Disparo automático".

## Acessibilidade

- **Teclado:** ordem do DOM = ordem visual; formulários inteiros operáveis sem mouse; Enter no campo de link aciona "Identificar" (não "Disparar"); o menu mobile fecha com Esc e devolve o foco ao botão. Segmentados (`.seg`) e dias da semana: `role="radiogroup"`/botões com `aria-pressed`, foco visível (`:focus-visible` já existe) e alvos de 44 px no celular.
- **Rótulos:** todo campo com `<label class="campo">` ou `aria-label`; botões de ícone/curtos (Copiar, Remover) levam o objeto no `aria-label` ("Copiar link do convite de ana@…"). Imagem do produto com `alt` = título; miniatura da foto enviada com `alt="Prévia da foto"`.
- **Anúncios:** resultado de Identificar, contadores de histórico e estado de envio em `aria-live="polite"`; `.erros` já é `role="alert"`; foco vai ao primeiro campo inválido (comportamento de `mostrarErros`).
- **Cor nunca sozinha:** status sempre com palavra (Enviado, Pendente, Erro, Conectado, Ainda não implementado, Pausada); papel com palavra; "!" textual no aviso de loja.
- **Contraste:** `--warn` (#B7791F no claro) sobre `--surface` (branco) dá cerca de 3,6:1, abaixo de 4,5:1 para texto pequeno. No selo "Ainda não implementado" e no aviso de loja, usar fundo `color-mix(--warn 18%, surface)` com texto `--text` (grafite/lavanda), borda `--warn`: contraste do texto passa de 12:1. Textos `--muted` em `.dica` já atendem nos dois temas (conferir `#5E5A72` sobre `#FFFFFF`, 6,3:1, e `#B3AEC9` sobre `#1E1A36`, 7,5:1). Selo "Conectado" e `nivel-ok`: `--ok` #1B8A4B sobre branco passa (4,6:1) — manter em 600.
- **Movimento:** transições só nas existentes (`.chave`, `#toast`), já desligadas por `prefers-reduced-motion`; nada novo animado.
- **Tabelas:** `<th scope="col">`; em ≤ 600 px as `.tabela` rolam dentro do card (`overflow-x:auto`), sem rolagem horizontal da página.
- **Senhas:** `autocomplete` correto (`username`, `current-password`, `new-password`), botão "Mostrar senha" com `aria-pressed`, sem placeholder como rótulo.
- **Foco ao trocar de estado:** depois de "Identificar" o foco continua no botão; depois de criar convite o foco vai ao botão "Copiar link".

## O que o dev precisa implementar

1. `index.html`: nav em grupos com `aria-label`/`aria-current`, botão Menu, rodapé (Histórico, Ajustes, Ajuda, pessoa, Sair), carregar `disparos.js` e `conta.js`; `app.js`: `ROTAS` com os novos hashes e os aliases `#regras`, `#whatsapp`, `#etiquetas`; `ir()` marca o item ativo, fecha o menu e esconde Equipe para Operador; `main.larga` nas telas de duas colunas.
2. `style.css`: `.nav-grupo`, barra/drawer em ≤ 900 px (substitui o `nav` horizontal rolável), `.duas-col`, `.card-prod`, `.aviso-impl`, `.conexao`, `.estado-pill.dono`, lista de opções da enquete, botões de dia.
3. Extrair o seletor de grupos (`filtroGrupos` + marcação) para uma função que as três telas reutilizam, sem mudar o comportamento atual.
4. Páginas F1, F2, F3, F4, F5 conforme "Layout" e "Estados"; as Regras viram "Disparo automático" (só nomes); Etiquetas e a extensão do Ajustes movem para Conexões.
5. `login.html`/`login.js`: e-mail + senha; `convite.html`/`convite.js`: aceite.
6. `ajuda.js`: `TIPS` e `AJUDA` novos e renomeados; README atualizado (CA8).
7. Polling de 6 s do histórico apenas com a página aberta e sem `<dialog>` aberto (padrão de `paginaHistorico`), cancelado ao trocar de rota.

## Arquivos de apresentação afetados

`public/index.html`, `public/style.css`, `public/app.js` (nav, rotas, página Regras renomeada, Etiquetas e Ajustes movidos), `public/paineis.js` (links de ajuda que citam "WhatsApp e grupos"), `public/ajuda.js`, `public/login.html`, `public/login.js`; novos: `public/disparos.js`, `public/conta.js`, `public/convite.html`, `public/convite.js`. `README.md` (por regra do projeto). Mudanças em `style.css` (`nav`, `.app`, `.rail`) afetam todas as páginas: conferir Visão Geral, Rotacionador, Blocos, Templates, Histórico e Ajustes em 375 e 1280 px.

## Pendências para o dev (dependem de regra de negócio ou servidor)

- Endpoint de identificação de link (loja, título, preço, imagem, `conectada: bool`), ponto único de "loja → integração" (brief F4); mensagem de loja não conectada vem do servidor, com o nome da loja.
- Disparo manual: criar, listar (contadores e tabela) e persistir pendentes após reinício (CA3); envio parcial por grupo.
- Disparo de mensagem: texto, imagem (upload: tipos, tamanho máximo, onde guardar), prévia de link, enquete (2 a 12, múltipla), agendar, repetir (dias, horários, fuso do servidor), pausar, cancelar, histórico (enviados, fila, erro).
- Relatórios: CRUD de números (validação de formato, armazenamento só em `data/`), resumo agora, horário do resumo, virada do dia, limite padrão (2 a 1024), prévia do texto do resumo montada no servidor, avisos "grupo lotando" e "erro de disparo".
- Conexões: guardar e ler configurações por loja; segredo da Shopee gravado e nunca devolvido (só `tem_segredo: true`); "Testar" retorna estado "não implementado"; mascarar número nas listas.
- Equipe e login: usuários, papéis, convites (token, vence em 7 dias, cancelar, uso único, mensagem única de inválido), troca de papel, remoção, último Dono protegido, sessão com papel; migração do dono atual (ele não tem e-mail hoje: ver pergunta 2); permissões no servidor para tudo que a interface esconde do Operador; limite de tentativas no login.
- Nada de dado pessoal em log (e-mails, números de destino); mascarar números em respostas de listagem.

## Perguntas em aberto

1. **"Grupos" em PRINCIPAL:** hoje a tabela de grupos (convites) está dentro de "WhatsApp e grupos". Proponho separar: Grupos = lista e convites; Números de WhatsApp = conexão, QR e desconectar. Confirma, ou prefere "Grupos" ser só um atalho?
2. **Dono atual sem e-mail:** no primeiro acesso depois da atualização, peço e-mail e nome (e opcionalmente nova senha) numa tela "Complete seu cadastro" antes de entrar? Recomendo que sim.
3. **Visão Geral solta no topo** (como na referência) ou dentro de PRINCIPAL?
4. **O que o Operador não deve alcançar além de Equipe:** hoje assumo nada. Sugiro esconder também "Gerar novo token", "Desconectar WhatsApp" e "Apagar o que passou do prazo". Pode ser?
5. **Foto no Disparar mensagem:** decidido: JPG ou PNG, até 5 MB (WEBP fora).
6. **Repetição com data de fim ("Termina em")?** Fora desta spec; só se o dono quiser.
7. **"Testar" das lojas não implementadas:** aviso inline ao clicar (recomendado) ou botão desabilitado?
8. **Histórico do F1 e do F2** vão para o Histórico geral também (com origem "Manual"/"Mensagem") ou ficam só nos painéis laterais?
