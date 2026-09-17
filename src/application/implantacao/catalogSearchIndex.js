const WITH_ACCENT = 'ÀÁÂÃÄÅàáâãäåÒÓÔÕÖØòóôõöøÈÉÊËèéêëðÇçÐÌÍÎÏìíîïÙÚÛÜùúûüÑñŠšŸÿýŽž';
const WITHOUT_ACCENT = 'AAAAAAaaaaaaOOOOOOooooooEEEEeeeeeCcDIIIIiiiiUUUUuuuuNnSsYyyZz';
const MIN_PREFIX_LENGTH = 3;

export function replaceAccents(value) {
  if (value === null || value === undefined) return null;
  let next = '';
  for (const char of String(value)) {
    const index = WITH_ACCENT.indexOf(char);
    next += index >= 0 ? WITHOUT_ACCENT[index] : char;
  }
  return next;
}

export function searchWords(text) {
  return replaceAccents(String(text ?? ''))
    .toUpperCase()
    .replace(/['\u2019]/g, '')
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

function keysForWord(word) {
  if (word.length <= 2) return /\d/.test(word) ? [word] : [];
  const keys = [];
  for (let end = MIN_PREFIX_LENGTH; end <= word.length; end += 1) {
    keys.push(word.substring(0, end));
  }
  return keys;
}

export function searchKeysForName(name) {
  return [...new Set(searchWords(name).flatMap(keysForWord))];
}

export function productSearchKeys({ name, barCode } = {}) {
  const code = typeof barCode === 'string' ? barCode.trim() : '';
  const keys = searchKeysForName(name);
  return code ? [code, ...keys.filter((key) => key !== code)] : keys;
}

