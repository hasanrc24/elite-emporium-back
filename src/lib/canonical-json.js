function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]));
}

export const canonicalJson = (value) => JSON.stringify(normalize(value));
