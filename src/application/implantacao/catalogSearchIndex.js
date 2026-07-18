function replaceAccents(value) {
  if (value === null || value === undefined) return null;
  let next = value;
  const withAccent = 'ÀÁÂÃÄÅàáâãäåÒÓÔÕÕÖØòóôõöøÈÉÊËèéêëðÇçÐÌÍÎÏìíîïÙÚÛÜùúûüÑñŠšŸÿýŽž';
  const withoutAccent = 'AAAAAAaaaaaaOOOOOOOooooooEEEEeeeeeCcDIIIIiiiiUUUUuuuuNnSsYyyZz';
  for (let i = 0; i < withAccent.length; i += 1) {
    next = next.replaceAll(withAccent[i], withoutAccent[i]);
  }
  return next;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function generateForSingleWord(value) {
  if (!value || value.length <= 2) {
    if (value && /\d/.test(value)) return [value.toLowerCase()];
    return [];
  }
  if (value.length <= 4) return [value.toLowerCase()];
  if (/^\d+$/.test(value)) return [value.toLowerCase()];

  const minCharacters = 4;
  const rest = value.length - minCharacters;
  const out = [];
  for (let i = 0; i <= rest; i += 1) {
    out.push(value.substring(0, minCharacters + i).toLowerCase());
  }
  return out;
}

function generateForSentence(value, separator = ' ', excludedCharacters = []) {
  const withoutAccent = replaceAccents(value) || '';
  let replaced = withoutAccent;
  for (const exclude of excludedCharacters) {
    replaced = replaced.replace(new RegExp(escapeRegExp(exclude), 'g'), '');
  }
  return replaced.split(separator).flatMap((word) => generateForSingleWord(word));
}

function generateSearchIndex(value, minLength = 2) {
  if (!value) return [];
  const normalized = replaceAccents(value) || '';
  const sentences = normalized.replace(/,/g, ' ').split(' ');
  const indexes = [];
  for (const sentence of sentences) {
    if (!sentence.trim()) continue;
    for (let start = 0; start < sentence.length - 1; start += 1) {
      for (let end = start + 1; end <= sentence.length; end += 1) {
        indexes.push(sentence.substring(start, end).toLowerCase());
      }
    }
  }
  return [...new Set(indexes.filter((item) => item.length >= minLength))];
}

export function buildSearchIndex(nome, descricao) {
  const textoCompleto = `${nome} ${descricao}`.toLowerCase();
  const textoNormalizado = replaceAccents(textoCompleto) || '';
  const palavrasBasicas = textoNormalizado
    .split(/\s+/)
    .filter((palavra) => palavra.length > 2)
    .map((palavra) => palavra.toUpperCase());
  const indiceAprimorado = generateSearchIndex(textoCompleto, 2);
  const indiceFrases = generateForSentence(textoCompleto, ' ', [',', '.', '!', '?', ';']);
  const todos = new Set([...palavrasBasicas, ...indiceAprimorado, ...indiceFrases]);
  return [...todos].map((item) => String(item).toLowerCase());
}

export function buildWordKeys(nome) {
  const palavras = String(nome || '').toLowerCase().split(/\s+/);
  const keys = [];
  palavras.forEach((palavra) => {
    for (let i = 1; i <= palavra.length; i += 1) keys.push(palavra.substring(0, i));
  });
  return [...new Set(keys)];
}
