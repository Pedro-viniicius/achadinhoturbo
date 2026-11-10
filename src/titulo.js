// Abrevia o título do produto para a mensagem: o Mercado Livre enche o título de palavras-chave
// ("Compatível Com iPhone 15 16 17 Android Samsung… Premium Alta Qualidade"). Aqui fica só o que
// identifica o produto, em até N caracteres, sem partir palavra nem terminar em "com", "de", "para".

export const TITULO_MAX_PADRAO = 60;

// Expressões que não dizem o que o produto é. Removidas onde aparecerem.
const ENFEITES = [
  'alta qualidade', 'altíssima qualidade', 'alta performance', 'alta durabilidade', 'qualidade premium', '100% original', 'original',
  'premium', 'top de linha', 'top', 'promoção', 'promocao', 'oferta', 'oferta relâmpago', 'barato', 'envio imediato', 'envio rápido', 'envio rapido',
  'pronta entrega', 'frete grátis', 'frete gratis', 'nota fiscal', 'com nota fiscal', 'com garantia', 'garantia', 'lançamento', 'lancamento',
  'novo', 'nova', 'novidade', 'plug & play', 'plug and play', 'plug e play', 'resistente', 'eficiente', 'multifuncional', 'versátil', 'versatil',
  'melhor preço', 'melhor preco', 'super oferta', 'imperdível', 'imperdivel', 'full', 'luxo', 'de luxo', 'exclusivo', 'exclusiva',
];
// A partir daqui começa a lista de compatibilidade/uso, que não precisa ir na mensagem.
const CORTAR_A_PARTIR = /\b(compat[ií]ve[li]s?\s+(com|c\/)|compat[ií]vel|p\/\s*(iphone|samsung|xiaomi|motorola|android|celular)|para\s+(iphone|samsung|xiaomi|motorola|android)|ideal\s+para|serve\s+(em|para)|indicado\s+para|modelo[s]?:?\s)/i;
const CONECTORES = new Set(['com', 'c/', 'de', 'da', 'do', 'das', 'dos', 'e', 'para', 'p/', 'em', 'ou', 'sem', 'por', 'no', 'na', '+', '&', '-', '–', ',']);

// Corta a lista de compatibilidade e remove os enfeites. No título inteiro (ou no 1º trecho) o corte só vale depois da 12ª
// letra; num trecho que vem depois de um separador (`cortarNoInicio`), "Compatível com…" logo no começo apaga o trecho todo.
function sanear(t, { cortarNoInicio = false } = {}) {
  const m = CORTAR_A_PARTIR.exec(t);
  if (m && (cortarNoInicio ? true : m.index > 12)) t = t.slice(0, m.index);
  for (const e of [...ENFEITES].sort((a, b) => b.length - a.length)) {
    t = t.replace(new RegExp(`(^|\\s)${e.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?=\\s|$)`, 'gi'), '$1');
  }
  return t.replace(/\s+/g, ' ').replace(/\s+([,.;:])/g, '$1').trim();
}

// Limite de tamanho, sem partir palavra; prefere cortar antes de um conector; não termina em conector nem em pontuação solta.
function limitar(t, max) {
  if (t.length > max) {
    const palavras = t.split(' ');
    const cortes = []; let acc = 0;
    for (let i = 0; i < palavras.length; i++) { acc += palavras[i].length + (i ? 1 : 0); if (acc <= max) cortes.push(i + 1); }
    let n = cortes.at(-1) || 1;
    // se a palavra seguinte é um conector, perfeito; senão, volta até achar um conector próximo (até 3 palavras)
    let achou = false;
    for (let k = n; k > Math.max(1, n - 3); k--) {
      if (CONECTORES.has(palavras[k]?.toLowerCase())) { n = k; achou = true; break; }
    }
    // sem conector por perto, não deixa uma palavrinha solta no fim ("… Integrado Som")
    if (!achou && n > 1 && palavras[n - 1].length <= 3 && !/\d/.test(palavras[n - 1]) && !/\d/.test(palavras[n - 2])) n--; // "500 ml" fica
    t = palavras.slice(0, n).join(' ');
  }
  const ps = t.split(' ');
  while (ps.length > 1 && CONECTORES.has(ps.at(-1).toLowerCase())) ps.pop();
  return ps.join(' ').replace(/[,.;:\-–]+$/, '').trim();
}

export function abreviarTitulo(titulo, max = TITULO_MAX_PADRAO) {
  let t = String(titulo || '').replace(/[*_~]/g, '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (!(max > 0)) return t; // 0 = não abreviar

  // 1) separadores " - ", " – ", " | ", " / ". O 1º trecho com 5+ palavras já descreve o produto: fica só ele. Com 1 ou 2
  //    palavras o título fica inteiro ("Fone A | Mouse B"). Com 3 ou 4 (a marca ou a linha: "Lola From Rio", "Pipicat 12 kg")
  //    entram também os trechos seguintes que descrevem o produto (3+ palavras depois de limpos), porque o tipo do produto
  //    vem neles: "Lola From Rio - Morte Subita - Condicionador hidratante…". Trecho curto (cor, voltagem, selo) e trecho só
  //    de enfeite ou de compatibilidade saem; o separador de cada trecho é o original.
  const partes = t.split(/\s+([-–|/])\s+/); // [trecho, separador, trecho, separador, …]
  const nPrincipal = partes[0].split(' ').length;
  if (nPrincipal >= 5) {
    t = limitar(sanear(partes[0]), max);
  } else if (nPrincipal >= 3 && partes.length > 1) {
    const inicio = limitar(sanear(partes[0]), Infinity); // limpa o fim de cada trecho (vírgula, conector) antes de emendar
    const descricoes = []; // trechos depois do 1º que descrevem o produto
    for (let i = 2; i < partes.length; i += 2) {
      const texto = limitar(sanear(partes[i], { cortarNoInicio: true }), Infinity);
      if (texto.split(' ').length >= 3) descricoes.push({ sep: partes[i - 1], texto });
    }
    const junto = descricoes.reduce((acc, d) => (acc ? `${acc} ${d.sep} ${d.texto}` : d.texto), inicio);
    t = limitar(junto, max);
    // Um trecho emendado que sobra com menos de 2 palavras depois do limite não ajuda: sai junto com o separador.
    // ("|" e "/" não são conectores: o corte pode deixar o separador pendurado no fim.)
    let cortado = t.replace(/\s+[-–|/]$/, '').split(/\s+([-–|/])\s+/);
    while (cortado.length > 1 && cortado.at(-1).split(' ').length < 2) cortado = cortado.slice(0, -2);
    t = cortado.join(' ');
    // Marca + tipo não cabem no máximo: o tipo do produto vale mais do que a marca.
    if (descricoes.length && t.length <= inicio.length) t = limitar(descricoes[0].texto, max);
  } else {
    t = limitar(sanear(t), max);
  }

  // 2) palavras GRITADAS longas viram Capitalizadas (siglas curtas como USB, LED, TWS ficam)
  t = t.replace(/\b([A-ZÀ-Ü][A-ZÀ-Ü-]{5,})\b/g, (w) => w[0] + w.slice(1).toLowerCase());
  return t;
}

/**
 * Título de uma linha só (espaços e quebras viram um espaço), até `max` caracteres, cortado antes de uma palavra
 * (sem palavra partida; sem espaço no trecho, corta no limite). Não é texto ou fica vazio → null.
 * Usado pelos clientes de API das lojas (o painel e src/envios.js têm teto de 200 para o título).
 */
export function tituloDeUmaLinha(v, max = 200) {
  if (typeof v !== 'string' || !(Number.isInteger(max) && max > 0)) return null;
  const t = v.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (t.length <= max) return t;
  const corte = t.slice(0, max + 1).lastIndexOf(' '); // o espaço pode ser o (max+1)º caractere: então o corte é exato
  return (corte > 0 ? t.slice(0, corte) : t.slice(0, max)).trim();
}
