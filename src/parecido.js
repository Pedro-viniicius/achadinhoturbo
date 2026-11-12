// Produto igual ou parecido no disparo automático (plano nao-repetir-produto-parecido, etapa 2). Módulo puro: não
// abre banco por conta própria (`lerEnviados` recebe o `db`), não conhece o agendador nem a fila de envios. Decide
// se uma candidata deve ser barrada por já ter saído (ou estar saindo) um título igual ou parecido, ou liberada
// porque é o mesmo produto pelo menos `DESCONTO_MINIMO_MAIS_BARATA`% mais barato (adendo de 10/11, D10/D11), e monta
// as frases fixas do Histórico e da mensagem.
//
// Unidades: os preços que vêm da trava (`anterior.preco`, `precoAnterior`) são CENTAVOS inteiros (a coluna
// `price_cents` de `sent_offers`); os preços que vêm de uma oferta (`price`, `precoNovo`, `precoConferido`) são
// REAIS, como em `offer.price` e `{PRECO_PRODUTO}`.
import { brl } from './template.js';

// Constantes de ajuste (D7: sem campo nem tela). Para afrouxar ou apertar a regra, é aqui.
export const LIMIAR_PARECIDO = 0.75;
export const HORAS_ENTRE_PARECIDOS = 24;
export const PALAVRAS_PARECIDO = 8;
export const MIN_PALAVRAS = 3;
/** Em %: o mesmo produto com outro código só sai antes do prazo se estiver pelo menos isto mais barato (D11). */
export const DESCONTO_MINIMO_MAIS_BARATA = 5;
/** Quantos dias para trás vale o "último envio" do `{PRECO_ULTIMO_ENVIO}` (plano baixou-de-para, CA1). */
export const DIAS_ULTIMO_ENVIO = 30;
/** Ofertas seguidas (plano variedade-ofertas-seguidas): a mesma linha de um envio da regra nos últimos N min não sai. */
export const MINUTOS_SEGUIDAS = 45;
/** "Mesma marca e linha": quantas palavras distintivas em comum (entre as `PALAVRAS_PARECIDO` primeiras) bastam. */
export const COMUNS_MESMA_LINHA = 2;
export const FRASE_MAIS_BARATA = '🔎 Nossa busca achou esta oportunidade ainda melhor, caso você ainda não tenha aproveitado a primeira.';

const TITULO_GUARDADO_MAX = 200;
const TITULO_FRASE_MAX = 60;
const HORA_MS = 3600000;
const MINUTO_MS = 60000;
const DIA_MS = 24 * HORA_MS;

const VAZIAS = new Set([
  'de', 'da', 'do', 'das', 'dos', 'e', 'com', 'para', 'em', 'ou', 'sem', 'por', 'no', 'na', 'original', 'oferta',
  'promocao', 'novo', 'nova', 'frete', 'gratis', 'envio', 'imediato', 'premium', 'top', 'lancamento',
]);

/** Palavras significativas: minúsculas, sem acento, só [a-z0-9]; saem as de 1 caractere e as de `VAZIAS`. */
export function palavras(titulo) {
  if (typeof titulo !== 'string') return [];
  return titulo.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').split(' ')
    .filter((p) => p.length > 1 && !VAZIAS.has(p));
}

function compararPalavras(pa, pb, limiar) {
  if (pa.length < MIN_PALAVRAS || pb.length < MIN_PALAVRAS) return null;
  if (pa.length === pb.length && pa.every((p, i) => p === pb[i])) return 'mesmo';
  const a = new Set(pa.slice(0, PALAVRAS_PARECIDO));
  const b = new Set(pb.slice(0, PALAVRAS_PARECIDO));
  if (a.size < MIN_PALAVRAS || b.size < MIN_PALAVRAS) return null;
  let comuns = 0;
  for (const p of a) if (b.has(p)) comuns++;
  return comuns / Math.min(a.size, b.size) >= limiar - 1e-9 ? 'parecido' : null;
}

/** 'mesmo' (sequência completa igual), 'parecido' (≥ limiar nas primeiras palavras) ou null. Menos de 3 palavras: null. */
export function comparar(a, b, { limiar = LIMIAR_PARECIDO } = {}) {
  return compararPalavras(palavras(a), palavras(b), limiar);
}

/** Cabeças que só dizem "quantidade": a palavra de tipo do título vem depois delas ("Kit 10 Cuecas Boxer" → `cuecas`). */
export const CABECAS_GENERICAS = new Set(['kit', 'jogo', 'conjunto', 'combo', 'par', 'pack']);
/** Unidades de contagem ("Kit 3 Pares de Meias", "Kit 10 Unidades Canetas"): também não são o tipo (achado Q1). */
export const UNIDADES_CONTAGEM = new Set(['pares', 'par', 'unidades', 'unidade', 'un', 'pecas', 'peca', 'itens', 'item']);
/**
 * Palavras que não dizem marca nem linha (público, cor, tamanho, recursos genéricos): não contam como "em comum" em
 * `mesmaLinha`. Acento já saiu (`palavras`). As cabeças genéricas também ficam de fora. Para apertar ou afrouxar o
 * critério, é aqui.
 */
export const GENERICAS_LINHA = new Set([
  ...CABECAS_GENERICAS,
  // público
  'masculino', 'masculina', 'masculinos', 'masculinas', 'feminino', 'feminina', 'femininos', 'femininas', 'unissex',
  'infantil', 'infantis', 'adulto', 'adulta', 'adultos', 'adultas', 'bebe', 'bebes', 'crianca', 'criancas', 'kids',
  'homem', 'homens', 'mulher', 'mulheres', 'menino', 'meninos', 'menina', 'meninas',
  'cao', 'caes', 'cachorro', 'cachorros', 'gato', 'gatos', 'pet', 'pets', 'filhote', 'filhotes',
  // cor
  'preto', 'preta', 'pretos', 'pretas', 'branco', 'branca', 'brancos', 'brancas', 'azul', 'azuis', 'vermelho', 'vermelha',
  'verde', 'verdes', 'rosa', 'cinza', 'prata', 'dourado', 'dourada', 'amarelo', 'amarela', 'roxo', 'roxa', 'laranja',
  'marrom', 'bege', 'colorido', 'colorida', 'transparente',
  // tamanho
  'pequeno', 'pequena', 'pequenos', 'pequenas', 'medio', 'media', 'grande', 'grandes', 'mini', 'maxi', 'tamanho', 'tamanhos',
  // recursos genéricos
  'bluetooth', 'wireless', 'gamer', 'gamers', 'portatil', 'portateis', 'led', 'usb', 'digital', 'eletrico', 'eletrica',
  'automatico', 'automatica', 'recarregavel', 'profissional', 'resistente', 'potente', 'leve', 'compacto', 'compacta',
]);

/** Número ou medida ("27", "500ml", "240hz", "4kg"): a palavra começa por dígito e não é tipo nem marca. */
const ehNumero = (p) => /^\d/.test(p);

/** A palavra de tipo do título: a 1ª que não é número, cabeça genérica nem unidade de contagem; null se não sobra nenhuma. */
function palavraDeTipo(pw) {
  return pw.find((p) => !ehNumero(p) && !CABECAS_GENERICAS.has(p) && !UNIDADES_CONTAGEM.has(p)) ?? null;
}

function mesmaLinhaPalavras(pa, pb) {
  if (pa.length < MIN_PALAVRAS || pb.length < MIN_PALAVRAS) return null;
  const tipo = palavraDeTipo(pa);
  if (tipo !== null && tipo === palavraDeTipo(pb)) return 'tipo';
  const distintivas = (pw) => new Set(pw.slice(0, PALAVRAS_PARECIDO).filter((p) => !ehNumero(p) && !GENERICAS_LINHA.has(p)));
  const b = distintivas(pb);
  let comuns = 0;
  for (const p of distintivas(pa)) if (b.has(p)) comuns++;
  return comuns >= COMUNS_MESMA_LINHA ? 'linha' : null;
}

/**
 * As duas ofertas são da mesma linha (ofertas seguidas)? 'tipo' (a 1ª palavra significativa do título é igual, sem
 * contar números, cabeças genéricas nem unidades de contagem), 'linha' (pelo menos `COMUNS_MESMA_LINHA` palavras distintivas em comum nas
 * `PALAVRAS_PARECIDO` primeiras) ou null. Título com menos de `MIN_PALAVRAS` palavras: null.
 */
export function mesmaLinha(a, b) {
  return mesmaLinhaPalavras(palavras(a), palavras(b));
}

/** Reais → centavos inteiros; null se não for número finito maior que zero (ou se arredondar para 0). */
export function centavos(v) {
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const c = Math.round(n * 100);
  return c >= 1 ? c : null;
}

/**
 * O preço novo é pelo menos `DESCONTO_MINIMO_MAIS_BARATA`% menor que o anterior? Os dois em CENTAVOS inteiros
 * maiores que zero; a conta é só com inteiros (R$ 100,00 → R$ 95,00 passa, R$ 95,01 não). Qualquer lado
 * desconhecido ou inválido: false (barra).
 */
export function maisBarataOBastante(novo, anterior) {
  // isSafeInteger: Infinity e inteiros fora da faixa exata (acima de 2^53) também barram
  if (!Number.isSafeInteger(novo) || novo <= 0 || !Number.isSafeInteger(anterior) || anterior <= 0) return false;
  return novo * 100 <= anterior * (100 - DESCONTO_MINIMO_MAIS_BARATA);
}

/** Título como vai para `sent_offers.title`: espaços colapsados, até 200 caracteres; null se vazio ou não for texto. */
export function tituloParaGuardar(t) {
  if (typeof t !== 'string') return null;
  let s = t.replace(/\s+/g, ' ').trim().slice(0, TITULO_GUARDADO_MAX);
  if (/[\ud800-\udbff]$/.test(s)) s = s.slice(0, -1); // não deixa meio emoji no fim
  s = s.trim();
  return s || null;
}

/** Envios da regra com título guardado depois de `desde` (ms), do mais antigo ao mais novo. */
export function lerEnviados(db, ruleId, desde) {
  return db.prepare(
    'SELECT offer_key, title, price_cents, sent_at FROM sent_offers WHERE rule_id = ? AND sent_at > ? AND title IS NOT NULL ORDER BY sent_at, id',
  ).all(ruleId, desde).map((l) => ({ ...l }));
}

/**
 * Preço, em CENTAVOS, do envio mais recente do MESMO produto pela regra nos últimos `DIAS_ULTIMO_ENVIO` dias: a mesma
 * chave, ou o título igual (`comparar === 'mesmo'`) com outra chave. Parecido não conta. Devolve null quando não há
 * esse envio ou quando o mais recente não tem preço guardado (não cai para um mais antigo). `agora` em ms. Nunca
 * lança: erro de banco vira null, e o console só recebe o `code`, nunca a mensagem (que pode trazer parâmetros).
 */
export function precoDoUltimoEnvio(db, ruleId, { key, title } = {}, agora = Date.now()) {
  try {
    const desde = agora - DIAS_ULTIMO_ENVIO * DIA_MS;
    const linhas = db.prepare(
      'SELECT offer_key, title, price_cents FROM sent_offers WHERE rule_id = ? AND sent_at > ? ORDER BY sent_at DESC, id DESC',
    ).all(ruleId, desde);
    const chave = key == null ? null : String(key);
    const igual = linhas.find((l) => (chave !== null && l.offer_key === chave) || comparar(title, l.title) === 'mesmo');
    const c = igual?.price_cents;
    return Number.isSafeInteger(c) && c > 0 ? c : null;
  } catch (e) {
    console.error(`[parecido] último envio: ${e?.code ?? 'erro'}`);
    return null;
  }
}

/**
 * O preço da mensagem (`precoReais`) está pelo menos `DESCONTO_MINIMO_MAIS_BARATA`% abaixo do último envio
 * (`anteriorCentavos`)? Devolve o preço anterior em REAIS, para o `{PRECO_ULTIMO_ENVIO}`, ou null (sem linha).
 */
export function baixouDe(anteriorCentavos, precoReais) {
  return maisBarataOBastante(centavos(precoReais), anteriorCentavos) ? anteriorCentavos / 100 : null;
}

/**
 * Trava de uma execução da regra. `enviados` = linhas de `lerEnviados`; `agora` em ms; `dedupeDias` é o da regra
 * (0 desliga só a parte entre rodadas). `avaliar` devolve:
 *   null                                                   — pode sair, nada a dizer;
 *   { acao: 'barrar', tipo: 'mesmo'|'parecido'|'rodada', anterior: { title, preco, sent_at } }
 *   { acao: 'liberar', anterior }                          — o mesmo produto (outra chave) pelo menos
 *                                                            DESCONTO_MINIMO_MAIS_BARATA% mais barato, só entre
 *                                                            rodadas e só se nenhum conflito for 'parecido' (D10).
 * `anterior.preco` em centavos (null se desconhecido); na 'rodada', `preco` e `sent_at` são null.
 * `seguidas` (plano variedade-ofertas-seguidas; null = desligada, e a trava é a de sempre): `{ recentes }`, as linhas de
 * `lerEnviados` da regra. Com ela, `avaliar` também barra com `{ acao: 'barrar', tipo: 'seguida', anterior: { title,
 * preco: null, sent_at } }` a oferta da MESMA LINHA (`mesmaLinha`) de uma escolhida deste envio (`sent_at` null) ou de um
 * dos `recentes` enviados há menos de `MINUTOS_SEGUIDAS` min (`sent_at` preenchido). Só vale depois da lógica acima: se
 * ela barra, vale o que ela disse; se ela libera (os 5%), a seguida ainda barra. Vale com qualquer `dedupeDias`, e a
 * mesma chave não é comparada consigo mesma. `avaliar(oferta, { semRecentes: true })` ignora os `recentes` e continua
 * barrando pela mesma linha de uma escolhida (a guarda "não zera o envio" do agendador).
 * `acrescentar` registra a oferta escolhida nesta execução (a "mesma rodada"); `retirar(key)` desfaz isso quando a
 * escolhida caiu fora (descartada, pulada) e não vai sair.
 */
export function criarTrava({ enviados = [], agora, dedupeDias, limiar = LIMIAR_PARECIDO, horas = HORAS_ENTRE_PARECIDOS, seguidas = null } = {}) {
  const dias = Number(dedupeDias);
  const entreRodadas = Number.isFinite(dias) && dias > 0;
  const janelaMesmo = entreRodadas ? dias * DIA_MS : 0;
  const janelaParecido = entreRodadas ? Math.min(horas * HORA_MS, janelaMesmo) : 0;
  const maiorJanela = Math.max(janelaMesmo, janelaParecido);

  const historico = (entreRodadas ? enviados : [])
    .filter((e) => e && typeof e.title === 'string' && agora - e.sent_at < maiorJanela)
    .map((e) => ({ ...e, palavras: palavras(e.title) }))
    .filter((e) => e.palavras.length >= MIN_PALAVRAS);
  const escolhidas = [];
  // os `recentes` dentro da janela de seguidas (e só os de título legível); fora dela, nada a comparar
  const recentes = (seguidas && Array.isArray(seguidas.recentes) ? seguidas.recentes : [])
    .filter((e) => e && typeof e.title === 'string' && Number.isFinite(e.sent_at) && agora - e.sent_at < MINUTOS_SEGUIDAS * MINUTO_MS)
    .map((e) => ({ ...e, palavras: palavras(e.title) }))
    .filter((e) => e.palavras.length >= MIN_PALAVRAS);

  /** A lógica de 24 h e da mesma rodada (a trava de antes das seguidas). */
  function avaliarParecidos({ key, title, price }, pw) {
    for (const e of escolhidas) {
      if (e.key === String(key)) continue;
      if (compararPalavras(pw, e.palavras, limiar)) {
        return { acao: 'barrar', tipo: 'rodada', anterior: { title: e.title, preco: null, sent_at: null } };
      }
    }

    const conflitos = [];
    for (const e of historico) {
      if (e.offer_key === String(key)) continue;
      const r = compararPalavras(pw, e.palavras, limiar);
      if (!r) continue;
      const idade = agora - e.sent_at;
      if ((r === 'mesmo' && idade < janelaMesmo) || idade < janelaParecido) {
        conflitos.push({ tipo: r, title: e.title, preco: Number.isInteger(e.price_cents) && e.price_cents > 0 ? e.price_cents : null, sent_at: e.sent_at });
      }
    }
    if (!conflitos.length) return null;

    const maisRecente = (lista) => lista.reduce((m, c) => (c.sent_at >= m.sent_at ? c : m));
    const comPreco = conflitos.filter((c) => c.preco !== null);
    const semPreco = conflitos.filter((c) => c.preco === null);
    const menor = comPreco.length ? Math.min(...comPreco.map((c) => c.preco)) : null;
    const doMinimo = menor === null ? null : maisRecente(comPreco.filter((c) => c.preco === menor));
    const centavosNovo = centavos(price);

    const conflito = (c) => ({ acao: 'barrar', tipo: c.tipo, anterior: { title: c.title, preco: c.preco, sent_at: c.sent_at } });
    // parecida (outro tamanho, cor, versão) não tem exceção de preço (D10): espera as 24 h, com a frase dela
    const parecidos = conflitos.filter((c) => c.tipo === 'parecido');
    if (parecidos.length) return conflito(maisRecente(parecidos));
    if (semPreco.length) return conflito(maisRecente(semPreco)); // anterior sem preço: nada a comparar
    if (centavosNovo === null) return conflito(doMinimo); // candidata sem preço: idem
    if (maisBarataOBastante(centavosNovo, menor)) {
      return { acao: 'liberar', anterior: { title: doMinimo.title, preco: doMinimo.preco, sent_at: doMinimo.sent_at } };
    }
    return conflito(doMinimo);
  }

  return {
    avaliar({ key, title, price } = {}, { semRecentes = false } = {}) {
      const pw = palavras(title);
      if (pw.length < MIN_PALAVRAS) return null;
      const r = avaliarParecidos({ key, title, price }, pw);
      if (!seguidas || r?.acao === 'barrar') return r;

      const k = String(key);
      for (const e of escolhidas) {
        if (e.key !== k && mesmaLinhaPalavras(pw, e.palavras)) {
          return { acao: 'barrar', tipo: 'seguida', anterior: { title: e.title, preco: null, sent_at: null } };
        }
      }
      if (!semRecentes) {
        let achada = null;
        for (const e of recentes) {
          if (e.offer_key === k || !mesmaLinhaPalavras(pw, e.palavras)) continue;
          if (!achada || e.sent_at >= achada.sent_at) achada = e;
        }
        if (achada) return { acao: 'barrar', tipo: 'seguida', anterior: { title: achada.title, preco: null, sent_at: achada.sent_at } };
      }
      return r;
    },
    acrescentar({ key, title } = {}) {
      const pw = palavras(title);
      if (pw.length >= MIN_PALAVRAS) escolhidas.push({ key: String(key), title: String(title), palavras: pw });
    },
    /** Tira a oferta das escolhidas da rodada (ela caiu fora e não vai sair): as parecidas dela deixam de ser barradas. → true se havia. */
    retirar(key) {
      if (key === undefined || key === null) return false;
      const k = String(key);
      let tirou = false;
      for (let i = escolhidas.length - 1; i >= 0; i--) {
        if (escolhidas[i].key === k) { escolhidas.splice(i, 1); tirou = true; }
      }
      return tirou;
    },
  };
}

/** A frase fixa na primeira linha, seguida de uma linha em branco, sobre o texto já renderizado. */
export function comFraseMaisBarata(texto) {
  return `${FRASE_MAIS_BARATA}\n\n${texto == null ? '' : String(texto)}`;
}

// ---------------------------------------------------------------------------------------------- textos do Histórico
const pad2 = (n) => String(n).padStart(2, '0');
const horaDe = (ts) => { const d = new Date(ts); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const mesmoDia = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
/** "10:00" se for no dia de `agora`; senão "10:00 de 03/11" (cópia local de `quandoDe` do agendador). */
const quandoDe = (ts, agora) => {
  if (mesmoDia(ts, agora)) return horaDe(ts);
  const d = new Date(ts);
  return `${horaDe(ts)} de ${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`;
};
const cortar = (t) => {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim();
  return s.length > TITULO_FRASE_MAX ? `${s.slice(0, TITULO_FRASE_MAX - 1).trimEnd()}…` : s;
};
const reais = (centavosAnterior) => brl(centavosAnterior / 100);
const PELO_MENOS = `pelo menos ${DESCONTO_MINIMO_MAIS_BARATA}%`;

/**
 * Frase de uma oferta barrada (`r` = resultado de `avaliar` com acao 'barrar'). `prefixo`: 'Pulada' ou 'Não enviada'.
 * `r.tipo` 'saindo': a anterior está numa execução da regra em andamento (só no "Enviar" do Catálogo).
 */
export function textoConflito(r, agora, { prefixo = 'Pulada' } = {}) {
  const a = r.anterior;
  const titulo = cortar(a.title);
  if (r.tipo === 'rodada') return `${prefixo}: parecida com "${titulo}", que foi escolhida neste mesmo envio.`;
  // escolhida por uma execução da regra que ainda não terminou (o "Enviar" do Catálogo no meio dela): sem preço a comparar
  if (r.tipo === 'saindo') return `${prefixo}: parecida com "${titulo}", que está saindo agora por este disparo. Tente de novo em alguns minutos.`;
  const quando = quandoDe(a.sent_at, agora);
  const valor = a.preco == null ? 'sem preço guardado para comparar' : `por ${reais(a.preco)}`;
  if (r.tipo === 'mesmo') {
    return `${prefixo}: o mesmo produto saiu por este disparo às ${quando} ${valor}, com outro código ("${titulo}"). Só sai de novo se estiver ${PELO_MENOS} mais barato.`;
  }
  return `${prefixo}: parecida com "${titulo}", que saiu por este disparo às ${quando} ${valor}. Ofertas parecidas esperam ${HORAS_ENTRE_PARECIDOS} h.`;
}

/** Linha do Histórico do mesmo produto que saiu por estar mais barato o bastante. `precoNovo` em reais. */
export function textoPassou(anterior, precoNovo, agora) {
  return `Saiu como oportunidade melhor: o mesmo produto saiu às ${quandoDe(anterior.sent_at, agora)} por ${reais(anterior.preco)} ("${cortar(anterior.title)}"); agora por ${brl(precoNovo)}.`;
}

/** Oferta liberada que, depois da conferência na loja, deixou de ser mais barata o bastante. `precoConferido` em reais. */
export function textoConferencia(anterior, precoConferido, agora) {
  return `Pulada: na conferência o preço ficou em ${brl(precoConferido)}, que não é ${PELO_MENOS} menor que o de "${cortar(anterior.title)}" (${reais(anterior.preco)}, às ${quandoDe(anterior.sent_at, agora)}).`;
}

/** Descarte da fila do Catálogo. `precoConferido` em reais; `precoAnterior` em centavos. */
export function textoNaoMaisBarata(precoConferido, precoAnterior) {
  return `Descartada: preço subiu para ${brl(precoConferido)} e não está mais ${PELO_MENOS} abaixo do da mesma oferta enviada antes (${reais(precoAnterior)})`;
}
