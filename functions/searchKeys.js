const WITH_ACCENT = 'ÀÁÂÃÄÅàáâãäåÒÓÔÕÖØòóôõöøÈÉÊËèéêëðÇçÐÌÍÎÏìíîïÙÚÛÜùúûüÑñŠšŸÿýŽž';
const WITHOUT_ACCENT = 'AAAAAAaaaaaaOOOOOOooooooEEEEeeeeeCcDIIIIiiiiUUUUuuuuNnSsYyyZz';

function normalizeWord(word) {
  let next = '';
  for (const char of String(word)) {
    const index = WITH_ACCENT.indexOf(char);
    next += index >= 0 ? WITHOUT_ACCENT[index] : char;
  }
  return next.toUpperCase();
}

function searchableWords(name) {
  return normalizeWord(String(name ?? ''))
    .replace(/['\u2019]/g, '')
    .split(/[^A-Z0-9]+/)
    .filter((word) => word.length > 2 || /\d/.test(word));
}

function hasBrokenSearch({ name, wordKeys, searchIndex } = {}) {
  const words = searchableWords(name);
  if (words.length === 0) return false;
  const stored = new Set([
    ...(Array.isArray(wordKeys) ? wordKeys : []),
    ...(Array.isArray(searchIndex) ? searchIndex : []),
  ].map((key) => String(key ?? '')));
  return words.some((word) => !stored.has(word));
}

module.exports = { hasBrokenSearch, searchableWords };
