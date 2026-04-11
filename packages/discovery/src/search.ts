import type { SearchIndex, IndexedTool } from './index-builder.js';
import type { ToolSearchFilter, ToolSearchResult } from './types.js';
import { tokenize } from './tokenizer.js';
import { scoreDocument, rankResults } from './ranking.js';

export interface ToolSearchContext {
  /** Set of plugin keys currently in 'active' state */
  activatedPlugins?: ReadonlySet<string>;
  /**
   * Predicate for capability pre-filtering. When `ToolSearchFilter.capability` is set,
   * only tools from plugins where this function returns true are included.
   * If omitted, the capability field is ignored.
   * The broker supplies this predicate by consulting its capability resolver.
   */
  capabilityFilter?: (pluginKey: string) => boolean;
}

/**
 * Search the tool index using a natural language query or structured filter.
 *
 * Execution order:
 *   1. Tag pre-filter (AND semantics, uses the index's inverted tag index)
 *   2. Capability pre-filter (capabilityFilter predicate from ctx)
 *   3. TF-IDF-style scoring (ranking module)
 *   4. Normalize → filter minRelevance → sort descending → limit
 *
 * relevanceScore is relative-to-best: the top result in a set is always 1.0.
 */
export function searchTools(
  index: SearchIndex,
  query: string | ToolSearchFilter,
  ctx: ToolSearchContext = {},
): ToolSearchResult[] {
  const filter: ToolSearchFilter = typeof query === 'string' ? { query } : query;
  const limit = filter.limit ?? 10;
  const minRelevance = filter.minRelevance ?? 0.1;
  const { activatedPlugins = new Set(), capabilityFilter } = ctx;

  // Step 1: Tag pre-filter
  let candidates: IndexedTool[];
  if (filter.tags?.length) {
    const tagKeys = new Set(index.filterByTags(filter.tags));
    candidates = index.getDocuments().filter(
      doc => tagKeys.has(`${doc.pluginKey}:${doc.toolName}`),
    );
  } else {
    candidates = Array.from(index.getDocuments());
  }

  // Step 2: Capability pre-filter
  if (filter.capability && capabilityFilter) {
    candidates = candidates.filter(doc => capabilityFilter(doc.pluginKey));
  }

  // Step 3: Score and rank
  if (!filter.query) {
    return candidates
      .slice(0, limit)
      .map(doc => toResult(doc, 1.0, activatedPlugins));
  }

  const queryTokens = tokenize(filter.query);
  if (queryTokens.length === 0) {
    // query string reduced to nothing (e.g. stop words only) — no match
    return [];
  }

  const scored = candidates.map(doc => ({
    doc,
    rawScore: scoreDocument(queryTokens, doc),
  }));

  return rankResults(scored, minRelevance, limit).map(r =>
    toResult(r.doc, r.relevanceScore, activatedPlugins),
  );
}

function toResult(
  doc: IndexedTool,
  relevanceScore: number,
  activatedPlugins: ReadonlySet<string>,
): ToolSearchResult {
  return {
    pluginKey: doc.pluginKey,
    toolName: doc.toolName,
    description: doc.description,
    ...(doc.tags.length > 0 ? { tags: [...doc.tags] } : {}),
    relevanceScore,
    isPluginActivated: activatedPlugins.has(doc.pluginKey),
  };
}
