import type { PluginManifest } from 'rhodium-core';
import { tokenize } from './tokenizer.js';

// ============================================================
// Private helpers
// ============================================================

/** Repeat a token array n times to encode field weight at index-build time. */
function weighted(tokens: string[], n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(...tokens);
  return out;
}

// ============================================================
// Public types
// ============================================================

/**
 * A single tool entry stored in the search index. Contains pre-tokenized,
 * pre-weighted token arrays for each field. RHOD-014 builds a term-frequency
 * vector by concatenating all five arrays.
 *
 * Token arrays are pre-repeated by field weight at index-build time:
 *   nameTokens           3× (highest signal)
 *   descriptionTokens    2×
 *   toolTagTokens        2×
 *   pluginTagTokens      1×
 *   pluginDescriptionTokens 1×
 */
export interface IndexedTool {
  readonly pluginKey: string;
  readonly toolName: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly nameTokens: readonly string[];
  readonly descriptionTokens: readonly string[];
  readonly toolTagTokens: readonly string[];
  readonly pluginTagTokens: readonly string[];
  readonly pluginDescriptionTokens: readonly string[];
}

export interface SearchIndex {
  addPlugin(pluginKey: string, manifest: PluginManifest): void;
  removePlugin(pluginKey: string): void;
  getDocuments(): readonly IndexedTool[];
  /**
   * Returns doc keys ("pluginKey:toolName") for tools matching ALL provided tags.
   * Input tags are normalized (lowercased, trimmed) before lookup.
   * Empty tags array → returns all doc keys.
   * AND semantics: a tool must carry every tag in the list.
   */
  filterByTags(tags: string[]): string[];
  readonly size: number;
}

// ============================================================
// Factory
// ============================================================

export function createSearchIndex(): SearchIndex {
  /** Primary document store: docKey → IndexedTool */
  const documents = new Map<string, IndexedTool>();
  /** Reverse lookup: pluginKey → Set of doc keys owned by that plugin */
  const byPlugin = new Map<string, Set<string>>();
  /** Plugin-level tags kept separately for tag-index cleanup during removePlugin */
  const pluginMeta = new Map<string, { tags: string[] }>();
  /** Inverted tag index: normalizedTag → Set of doc keys carrying that tag */
  const byTag = new Map<string, Set<string>>();

  function docKey(pluginKey: string, toolName: string): string {
    return `${pluginKey}:${toolName}`;
  }

  function addToTagIndex(tag: string, key: string): void {
    const normalized = tag.toLowerCase().trim();
    if (!byTag.has(normalized)) byTag.set(normalized, new Set());
    byTag.get(normalized)!.add(key);
  }

  function removeFromTagIndex(tag: string, key: string): void {
    const normalized = tag.toLowerCase().trim();
    const set = byTag.get(normalized);
    if (!set) return;
    set.delete(key);
    if (set.size === 0) byTag.delete(normalized);
  }

  return {
    addPlugin(pluginKey: string, manifest: PluginManifest): void {
      if (byPlugin.has(pluginKey)) return; // idempotent

      const pluginDocKeys = new Set<string>();
      byPlugin.set(pluginKey, pluginDocKeys);
      pluginMeta.set(pluginKey, { tags: manifest.tags ?? [] });

      const pluginTagTokens = Object.freeze(
        weighted((manifest.tags ?? []).flatMap(t => tokenize(t)), 1)
      );
      const pluginDescriptionTokens = Object.freeze(
        weighted(tokenize(manifest.description), 1)
      );

      for (const tool of manifest.tools) {
        const key = docKey(pluginKey, tool.name);

        const doc: IndexedTool = {
          pluginKey,
          toolName: tool.name,
          description: tool.description,
          tags: Object.freeze(tool.tags ?? []),
          nameTokens: Object.freeze(weighted(tokenize(tool.name), 3)),
          descriptionTokens: Object.freeze(weighted(tokenize(tool.description), 2)),
          toolTagTokens: Object.freeze(weighted(
            (tool.tags ?? []).flatMap(t => tokenize(t)), 2
          )),
          pluginTagTokens,
          pluginDescriptionTokens,
        };

        documents.set(key, doc);
        pluginDocKeys.add(key);

        for (const tag of tool.tags ?? []) addToTagIndex(tag, key);
        for (const tag of manifest.tags ?? []) addToTagIndex(tag, key);
      }
    },

    removePlugin(pluginKey: string): void {
      const pluginDocKeys = byPlugin.get(pluginKey);
      if (!pluginDocKeys) return; // idempotent

      const meta = pluginMeta.get(pluginKey)!;

      for (const key of pluginDocKeys) {
        const doc = documents.get(key)!;
        for (const tag of doc.tags) removeFromTagIndex(tag, key);
        for (const tag of meta.tags) removeFromTagIndex(tag, key);
        documents.delete(key);
      }

      byPlugin.delete(pluginKey);
      pluginMeta.delete(pluginKey);
    },

    getDocuments(): readonly IndexedTool[] {
      return Array.from(documents.values());
    },

    filterByTags(tags: string[]): string[] {
      if (tags.length === 0) return Array.from(documents.keys());

      const normalized = tags.map(t => t.toLowerCase().trim());

      // Find smallest candidate set first for efficient intersection
      let smallest: Set<string> | undefined;
      for (const tag of normalized) {
        const set = byTag.get(tag);
        if (!set || set.size === 0) return [];
        if (!smallest || set.size < smallest.size) smallest = set;
      }

      if (!smallest) return [];

      // Intersect: keep only keys present in all tag sets
      const result: string[] = [];
      for (const key of smallest) {
        if (normalized.every(tag => byTag.get(tag)?.has(key))) {
          result.push(key);
        }
      }
      return result;
    },

    get size(): number {
      return documents.size;
    },
  };
}
