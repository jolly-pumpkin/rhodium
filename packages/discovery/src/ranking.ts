import type { IndexedTool, CorpusStats } from './index-builder.js';

/**
 * Compute a raw relevance score for a document against query tokens using TF-IDF.
 *
 * Builds a term frequency (TF) map from the document's pre-weighted token arrays
 * (name 3×, description 2×, toolTags 2×, pluginTags 1×, pluginDescription 1×)
 * and weights each query token using inverse document frequency (IDF):
 *   IDF = log((totalDocs + 1) / (docFreq + 1)) + 1
 *
 * Returns 0 if queryTokens is empty.
 */
export function scoreDocument(
  queryTokens: string[],
  doc: IndexedTool,
  corpusStats: CorpusStats,
): number {
  if (queryTokens.length === 0) return 0;

  const freq = new Map<string, number>();
  const allTokens = [
    ...doc.nameTokens,
    ...doc.descriptionTokens,
    ...doc.toolTagTokens,
    ...doc.pluginTagTokens,
    ...doc.pluginDescriptionTokens,
  ];
  for (const t of allTokens) {
    freq.set(t, (freq.get(t) ?? 0) + 1);
  }

  const { totalDocs } = corpusStats;
  let score = 0;
  for (const token of queryTokens) {
    const tf = freq.get(token) ?? 0;
    if (tf === 0) continue;

    const df = corpusStats.termDocFreq.get(token) ?? 0;
    const idf = Math.log((totalDocs + 1) / (df + 1)) + 1;
    score += tf * idf;
  }
  return score;
}

interface ScoredResult {
  doc: IndexedTool;
  /** Normalized relevance score in [0, 1]. Top result in a set is always 1.0. */
  relevanceScore: number;
}

/**
 * Normalize raw scores to [0, 1] (relative to the highest score in this set),
 * filter by minRelevance, sort descending, and slice to limit.
 *
 * Note: relevanceScore is relative-to-best, not absolute — a score of 1.0 means
 * "best match in this result set", not "perfect global match".
 */
export function rankResults(
  candidates: Array<{ doc: IndexedTool; rawScore: number }>,
  minRelevance: number,
  limit: number,
): ScoredResult[] {
  if (candidates.length === 0) return [];

  const maxScore = candidates.reduce((m, c) => Math.max(m, c.rawScore), 0);
  if (maxScore === 0) return [];

  return candidates
    .map(c => ({ doc: c.doc, relevanceScore: c.rawScore / maxScore }))
    .filter(c => c.relevanceScore >= minRelevance)
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, limit);
}
