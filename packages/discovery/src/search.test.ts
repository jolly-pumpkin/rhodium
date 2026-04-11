import { describe, it, expect } from 'bun:test';
import { searchTools } from './search.js';
import { createSearchIndex } from './index-builder.js';
import type { PluginManifest } from 'rhodium-core';

function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return { provides: [], needs: [], tools: [], ...overrides };
}

function makeTool(name: string, description: string, tags?: string[]) {
  return { name, description, ...(tags ? { tags } : {}) };
}

function makeIndex() {
  const index = createSearchIndex();
  index.addPlugin('fs-plugin', makeManifest({
    description: 'File system utilities',
    tags: ['filesystem'],
    tools: [
      makeTool('read-file', 'Read the contents of a file from disk', ['io', 'filesystem']),
      makeTool('write-file', 'Write content to a file on disk', ['io', 'filesystem']),
      makeTool('delete-file', 'Delete a file from disk', ['io', 'filesystem']),
    ],
  }));
  index.addPlugin('http-plugin', makeManifest({
    description: 'HTTP client utilities',
    tags: ['network'],
    tools: [
      makeTool('get-request', 'Send an HTTP GET request', ['network', 'http']),
      makeTool('post-request', 'Send an HTTP POST request', ['network', 'http']),
    ],
  }));
  return index;
}

describe('searchTools() — natural language queries', () => {
  it('returns relevant tools for a query matching tool name', () => {
    const results = searchTools(makeIndex(), 'read file');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.toolName).toBe('read-file');
  });

  it('ranks tools by relevance — name match ranks above description-only match', () => {
    const results = searchTools(makeIndex(), 'read');
    expect(results[0]!.toolName).toBe('read-file');
  });

  it('returns tools matching description keywords', () => {
    const results = searchTools(makeIndex(), 'HTTP request');
    expect(results.some(r => r.pluginKey === 'http-plugin')).toBe(true);
  });

  it('returns empty array when nothing matches', () => {
    expect(searchTools(makeIndex(), 'quantum teleportation')).toEqual([]);
  });

  it('returns empty array when query reduces to only stop words', () => {
    expect(searchTools(makeIndex(), 'the a an')).toEqual([]);
  });

  it('top result has relevanceScore of 1.0', () => {
    const results = searchTools(makeIndex(), 'read file');
    expect(results[0]!.relevanceScore).toBe(1.0);
  });

  it('all results have relevanceScore in (0, 1]', () => {
    const results = searchTools(makeIndex(), 'file');
    for (const r of results) {
      expect(r.relevanceScore).toBeGreaterThan(0);
      expect(r.relevanceScore).toBeLessThanOrEqual(1);
    }
  });
});

describe('searchTools() — tag pre-filter', () => {
  it('filters to tools matching the tag', () => {
    const results = searchTools(makeIndex(), { tags: ['network'] });
    expect(results.every(r => r.pluginKey === 'http-plugin')).toBe(true);
    expect(results).toHaveLength(2);
  });

  it('combines tag filter with text query — scores within filtered set', () => {
    const results = searchTools(makeIndex(), { query: 'GET', tags: ['http'] });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.toolName).toBe('get-request');
  });

  it('returns empty when tags match nothing', () => {
    expect(searchTools(makeIndex(), { tags: ['nonexistent'] })).toEqual([]);
  });
});

describe('searchTools() — capability pre-filter', () => {
  it('filters to tools from plugins passing the predicate', () => {
    const ctx = {
      capabilityFilter: (key: string) => key === 'fs-plugin',
    };
    const results = searchTools(makeIndex(), { capability: 'file-access' }, ctx);
    expect(results.every(r => r.pluginKey === 'fs-plugin')).toBe(true);
  });

  it('returns empty when no plugin passes the predicate', () => {
    const ctx = { capabilityFilter: (_key: string) => false };
    const results = searchTools(makeIndex(), { capability: 'anything' }, ctx);
    expect(results).toEqual([]);
  });

  it('ignores capability field when no capabilityFilter provided — returns all candidates', () => {
    const results = searchTools(makeIndex(), { capability: 'file-access' });
    expect(results).toHaveLength(5);
  });
});

describe('searchTools() — no query', () => {
  it('no query + no filters returns all tools with relevanceScore 1.0', () => {
    const results = searchTools(makeIndex(), {});
    expect(results).toHaveLength(5);
    expect(results.every(r => r.relevanceScore === 1.0)).toBe(true);
  });

  it('string overload with empty string returns all tools', () => {
    const results = searchTools(makeIndex(), '');
    expect(results.every(r => r.relevanceScore === 1.0)).toBe(true);
  });
});

describe('searchTools() — limit and minRelevance', () => {
  it('limit defaults to 10', () => {
    const index = createSearchIndex();
    for (let i = 0; i < 15; i++) {
      index.addPlugin(`plugin-${i}`, makeManifest({
        tools: [makeTool(`search-tool-${i}`, `A search tool number ${i}`)],
      }));
    }
    const results = searchTools(index, 'search tool');
    expect(results.length).toBeLessThanOrEqual(10);
  });

  it('custom limit is respected', () => {
    const results = searchTools(makeIndex(), { query: 'file', limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('minRelevance=1.0 returns only the exact top result', () => {
    const results = searchTools(makeIndex(), { query: 'read file', minRelevance: 1.0 });
    expect(results).toHaveLength(1);
    expect(results[0]!.relevanceScore).toBe(1.0);
  });
});

describe('searchTools() — isPluginActivated', () => {
  it('defaults to false when no activatedPlugins provided', () => {
    const results = searchTools(makeIndex(), 'file');
    expect(results.every(r => r.isPluginActivated === false)).toBe(true);
  });

  it('is true for plugins in the activated set', () => {
    const ctx = { activatedPlugins: new Set(['fs-plugin']) };
    const results = searchTools(makeIndex(), 'file', ctx);
    expect(results.filter(r => r.pluginKey === 'fs-plugin')
      .every(r => r.isPluginActivated === true)).toBe(true);
  });

  it('is false for plugins not in the activated set', () => {
    const ctx = { activatedPlugins: new Set(['fs-plugin']) };
    const results = searchTools(makeIndex(), {}, ctx);
    expect(results.filter(r => r.pluginKey === 'http-plugin')
      .every(r => r.isPluginActivated === false)).toBe(true);
  });
});

describe('searchTools() — result shape', () => {
  it('every result has pluginKey, toolName, description, relevanceScore, isPluginActivated', () => {
    const results = searchTools(makeIndex(), 'file');
    for (const r of results) {
      expect(typeof r.pluginKey).toBe('string');
      expect(typeof r.toolName).toBe('string');
      expect(typeof r.description).toBe('string');
      expect(typeof r.relevanceScore).toBe('number');
      expect(typeof r.isPluginActivated).toBe('boolean');
    }
  });

  it('tags is undefined when the tool has no tags', () => {
    const index = createSearchIndex();
    index.addPlugin('p', makeManifest({ tools: [makeTool('notag-tool', 'No tags')] }));
    const results = searchTools(index, 'notag');
    expect(results[0]!.tags).toBeUndefined();
  });

  it('tags is present when the tool has tags', () => {
    const index = createSearchIndex();
    index.addPlugin('p', makeManifest({
      tools: [makeTool('tagged-tool', 'Has tags', ['io'])],
    }));
    const results = searchTools(index, 'tagged');
    expect(results[0]!.tags).toEqual(['io']);
  });
});

describe('searchTools() — performance', () => {
  it('completes a 100-tool search in under 2ms (averaged over 10 runs)', () => {
    const index = createSearchIndex();
    for (let i = 0; i < 20; i++) {
      index.addPlugin(`plugin-${i}`, makeManifest({
        description: `Plugin number ${i} for testing`,
        tags: ['test', `group-${i % 5}`],
        tools: Array.from({ length: 5 }, (_, j) => makeTool(
          `tool-${i}-${j}`,
          `Tool ${j} of plugin ${i} for file reading and network operations`,
          ['io', 'test'],
        )),
      }));
    }
    expect(index.size).toBe(100);

    const start = performance.now();
    for (let i = 0; i < 10; i++) {
      searchTools(index, 'file reading network operations');
    }
    const avgMs = (performance.now() - start) / 10;
    expect(avgMs).toBeLessThan(2);
  });
});
