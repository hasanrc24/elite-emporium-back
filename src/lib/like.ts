/**
 * Builds a `%term%` pattern for SQL LIKE from untrusted search input.
 * The input is trimmed and length-limited, and LIKE wildcards are escaped
 * so `%`, `_` and `\` match literally (MySQL's default LIKE escape is `\`).
 */
export function likeContains(value: unknown, maximum = 100): string {
  const term = String(value ?? "")
    .trim()
    .slice(0, maximum);
  return `%${term.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}
