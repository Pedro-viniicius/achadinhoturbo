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

export function abreviarTitulo(titulo, max = TITULO_MAX_PADRAO) {
  let t = String(titulo || '').replace(/[*_~]/g, '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (!(max > 0)) return t; // 0 = não abreviar

  // 1) segmento principal: antes de " - ", " | ", " / " (quando o que fica ainda descreve o produto)
  const seg = t.split(/\s+[-–|/]\s+/)[0];
  if (seg.split(' ').length >= 3) t = seg;

  // 2) corta a partir da lista de compatibilidade
  const m = CORTAR_A_PARTIR.exec(t);
  if (m && m.index > 12) t = t.slice(0, m.index);

  // 3) remove enfeites (dos mais longos para os mais curtos, só palavra inteira)
  for (const e of [...ENFEITES].sort((a, b) => b.length - a.length)) {
    t = t.replace(new RegExp(`(^|\\s)${e.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?=\\s|$)`, 'gi'), '$1');
  }
  t = t.replace(/\s+/g, ' ').replace(/\s+([,.;:])/g, '$1').trim();

  // 4) limite de tamanho, sem partir palavra; prefere cortar antes de um conector
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

  // 5) não termina em conector nem em pontuação solta
  let ps = t.split(' ');
  while (ps.length > 1 && CONECTORES.has(ps.at(-1).toLowerCase())) ps.pop();
  t = ps.join(' ').replace(/[,.;:\-–]+$/, '').trim();

  // 6) palavras GRITADAS longas viram Capitalizadas (siglas curtas como USB, LED, TWS ficam)
  t = t.replace(/\b([A-ZÀ-Ü][A-ZÀ-Ü-]{5,})\b/g, (w) => w[0] + w.slice(1).toLowerCase());
  return t;
}
