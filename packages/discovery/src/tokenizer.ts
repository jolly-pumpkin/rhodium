export const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'in', 'of', 'to', 'for', 'with',
  'is', 'are', 'was', 'be', 'as', 'at', 'by', 'it', 'on', 'do',
]);

/** Tokenize text for indexing or query matching. */
export function tokenize(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s\-_]/g, ' ')
    .split(/\s+/)
    .flatMap(t => t.split(/[-_]+/))
    .filter(t => t.length >= 2 && !STOP_WORDS.has(t));
}
