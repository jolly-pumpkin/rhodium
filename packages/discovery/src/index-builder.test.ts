import { describe, it, expect } from 'bun:test';
import { createSearchIndex } from './index-builder.js';
import type { PluginManifest } from 'rhodium-core';

function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    provides: [],
    needs: [],
    tools: [],
    ...overrides,
  };
}

function makeTool(name: string, description: string, tags?: string[]) {
  return { name, description, ...(tags ? { tags } : {}) };
}

// Helper to expose tokenize-like logic for weight assertions.
// We don't import the private tokenize() — instead we verify the invariant
// nameTokens.length === 3 * (descriptionTokens.length / 2) only where
// counts are predictable. Most tests just assert lengths via the weight ratio.

describe('createSearchIndex()', () => {
  it('returns an empty index with size 0 and no documents', () => {
    const index = createSearchIndex();
    expect(index.size).toBe(0);
    expect(index.getDocuments()).toEqual([]);
  });
});

describe('addPlugin()', () => {
  it('indexes a single tool and increments size', () => {
    const index = createSearchIndex();
    index.addPlugin('my-plugin', makeManifest({
      tools: [makeTool('read-file', 'Reads a file from disk')],
    }));
    expect(index.size).toBe(1);
  });

  it('stores the correct pluginKey and toolName on the entry', () => {
    const index = createSearchIndex();
    index.addPlugin('my-plugin', makeManifest({
      tools: [makeTool('read-file', 'Reads a file from disk')],
    }));
    const doc = index.getDocuments()[0]!;
    expect(doc.pluginKey).toBe('my-plugin');
    expect(doc.toolName).toBe('read-file');
  });

  it('stores the raw description and tags on the entry', () => {
    const index = createSearchIndex();
    index.addPlugin('my-plugin', makeManifest({
      tools: [makeTool('search', 'Search files', ['io', 'filesystem'])],
    }));
    const doc = index.getDocuments()[0]!;
    expect(doc.description).toBe('Search files');
    expect(doc.tags).toEqual(['io', 'filesystem']);
  });

  it('indexes multiple tools from one plugin — size equals tool count', () => {
    const index = createSearchIndex();
    index.addPlugin('my-plugin', makeManifest({
      tools: [
        makeTool('read-file', 'Reads a file'),
        makeTool('write-file', 'Writes a file'),
        makeTool('delete-file', 'Deletes a file'),
      ],
    }));
    expect(index.size).toBe(3);
  });

  it('propagates plugin-level tags to all tool entries', () => {
    const index = createSearchIndex();
    index.addPlugin('my-plugin', makeManifest({
      tags: ['filesystem', 'io'],
      tools: [
        makeTool('read-file', 'Reads a file'),
        makeTool('write-file', 'Writes a file'),
      ],
    }));
    const docs = index.getDocuments();
    expect(docs).toHaveLength(2);
    // Both tools should have the same plugin tag tokens
    expect(docs[0]!.pluginTagTokens).toEqual(docs[1]!.pluginTagTokens);
    expect(docs[0]!.pluginTagTokens.length).toBeGreaterThan(0);
  });

  it('propagates plugin description tokens to all tool entries', () => {
    const index = createSearchIndex();
    index.addPlugin('my-plugin', makeManifest({
      description: 'File system utilities',
      tools: [
        makeTool('read-file', 'Reads a file'),
        makeTool('write-file', 'Writes a file'),
      ],
    }));
    const docs = index.getDocuments();
    expect(docs[0]!.pluginDescriptionTokens).toEqual(docs[1]!.pluginDescriptionTokens);
    expect(docs[0]!.pluginDescriptionTokens.length).toBeGreaterThan(0);
  });

  it('is idempotent — adding the same plugin key twice does not duplicate entries', () => {
    const index = createSearchIndex();
    const manifest = makeManifest({ tools: [makeTool('read-file', 'Reads a file')] });
    index.addPlugin('my-plugin', manifest);
    index.addPlugin('my-plugin', manifest);
    expect(index.size).toBe(1);
  });

  it('ignores the second manifest when called twice with the same key — tools from second call are not indexed', () => {
    const index = createSearchIndex();
    index.addPlugin('my-plugin', makeManifest({ tools: [makeTool('read-file', 'Reads a file')] }));
    index.addPlugin('my-plugin', makeManifest({ tools: [makeTool('write-file', 'Writes a file')] }));
    // Only the first manifest's tools are indexed
    expect(index.size).toBe(1);
    expect(index.getDocuments()[0]!.toolName).toBe('read-file');
  });

  it('handles a plugin with no tools — size unchanged, no error', () => {
    const index = createSearchIndex();
    expect(() => index.addPlugin('empty-plugin', makeManifest())).not.toThrow();
    expect(index.size).toBe(0);
  });

  it('handles a plugin with no description or tags — no error, empty plugin-level token arrays', () => {
    const index = createSearchIndex();
    index.addPlugin('my-plugin', makeManifest({
      tools: [makeTool('read-file', 'Reads a file')],
    }));
    const doc = index.getDocuments()[0]!;
    expect(doc.pluginTagTokens).toEqual([]);
    expect(doc.pluginDescriptionTokens).toEqual([]);
  });
});

describe('token weighting', () => {
  it('nameTokens are pre-repeated 3× — length equals 3× the unique token count', () => {
    const index = createSearchIndex();
    // Tool name "read" tokenizes to exactly one token ['read']
    index.addPlugin('my-plugin', makeManifest({
      tools: [makeTool('read', 'A reader tool')],
    }));
    const doc = index.getDocuments()[0]!;
    // The raw name tokenizes to some set of tokens; nameTokens must be 3× that
    // We verify by checking the repeat pattern: every unique token appears exactly 3 times
    const unique = [...new Set(doc.nameTokens)];
    for (const token of unique) {
      const count = doc.nameTokens.filter(t => t === token).length;
      expect(count).toBe(3);
    }
  });

  it('descriptionTokens are pre-repeated 2×', () => {
    const index = createSearchIndex();
    index.addPlugin('my-plugin', makeManifest({
      tools: [makeTool('my-tool', 'Read data')],
    }));
    const doc = index.getDocuments()[0]!;
    const unique = [...new Set(doc.descriptionTokens)];
    for (const token of unique) {
      const count = doc.descriptionTokens.filter(t => t === token).length;
      expect(count).toBe(2);
    }
  });

  it('toolTagTokens are pre-repeated 2×', () => {
    const index = createSearchIndex();
    index.addPlugin('my-plugin', makeManifest({
      tools: [makeTool('my-tool', 'A tool', ['filesystem'])],
    }));
    const doc = index.getDocuments()[0]!;
    const unique = [...new Set(doc.toolTagTokens)];
    for (const token of unique) {
      const count = doc.toolTagTokens.filter(t => t === token).length;
      expect(count).toBe(2);
    }
  });

  it('pluginTagTokens are 1× (not repeated)', () => {
    const index = createSearchIndex();
    index.addPlugin('my-plugin', makeManifest({
      tags: ['filesystem'],
      tools: [makeTool('my-tool', 'A tool')],
    }));
    const doc = index.getDocuments()[0]!;
    // Each unique token appears exactly once
    const unique = [...new Set(doc.pluginTagTokens)];
    for (const token of unique) {
      const count = doc.pluginTagTokens.filter(t => t === token).length;
      expect(count).toBe(1);
    }
    expect(doc.pluginTagTokens.length).toBeGreaterThan(0);
  });

  it('pluginDescriptionTokens are 1× (not repeated)', () => {
    const index = createSearchIndex();
    index.addPlugin('my-plugin', makeManifest({
      description: 'File utilities',
      tools: [makeTool('my-tool', 'A tool')],
    }));
    const doc = index.getDocuments()[0]!;
    const unique = [...new Set(doc.pluginDescriptionTokens)];
    for (const token of unique) {
      const count = doc.pluginDescriptionTokens.filter(t => t === token).length;
      expect(count).toBe(1);
    }
    expect(doc.pluginDescriptionTokens.length).toBeGreaterThan(0);
  });
});

describe('removePlugin()', () => {
  it('removes all tool entries for a plugin and decrements size', () => {
    const index = createSearchIndex();
    index.addPlugin('my-plugin', makeManifest({
      tools: [makeTool('read-file', 'Reads a file'), makeTool('write-file', 'Writes a file')],
    }));
    index.removePlugin('my-plugin');
    expect(index.size).toBe(0);
    expect(index.getDocuments()).toEqual([]);
  });

  it('only removes the specified plugin — other plugins are unaffected', () => {
    const index = createSearchIndex();
    index.addPlugin('plugin-a', makeManifest({ tools: [makeTool('tool-a', 'Tool A')] }));
    index.addPlugin('plugin-b', makeManifest({ tools: [makeTool('tool-b', 'Tool B')] }));
    index.removePlugin('plugin-a');
    expect(index.size).toBe(1);
    const doc = index.getDocuments()[0]!;
    expect(doc.pluginKey).toBe('plugin-b');
  });

  it('is idempotent — removing an unknown key is a no-op', () => {
    const index = createSearchIndex();
    expect(() => index.removePlugin('nonexistent')).not.toThrow();
    expect(index.size).toBe(0);
  });

  it('allows re-adding a plugin after it was removed', () => {
    const index = createSearchIndex();
    index.addPlugin('my-plugin', makeManifest({ tools: [makeTool('read-file', 'Reads a file')] }));
    index.removePlugin('my-plugin');
    index.addPlugin('my-plugin', makeManifest({ tools: [makeTool('write-file', 'Writes a file')] }));
    expect(index.size).toBe(1);
    expect(index.getDocuments()[0]!.toolName).toBe('write-file');
  });

  it('cleans up the tag index — filterByTags no longer returns removed tools', () => {
    const index = createSearchIndex();
    index.addPlugin('my-plugin', makeManifest({
      tags: ['io'],
      tools: [makeTool('read-file', 'Reads a file', ['filesystem'])],
    }));
    index.removePlugin('my-plugin');
    expect(index.filterByTags(['filesystem'])).toEqual([]);
    expect(index.filterByTags(['io'])).toEqual([]);
  });

  it('handles removing a plugin with no tools — no error', () => {
    const index = createSearchIndex();
    index.addPlugin('empty-plugin', makeManifest());
    expect(() => index.removePlugin('empty-plugin')).not.toThrow();
  });

  it('cleans up plugin-level tags even when tools have no tool-level tags', () => {
    const index = createSearchIndex();
    index.addPlugin('my-plugin', makeManifest({
      tags: ['io'],
      tools: [makeTool('read-file', 'Reads a file')], // no tool-level tags
    }));
    index.removePlugin('my-plugin');
    expect(index.filterByTags(['io'])).toEqual([]);
  });
});

describe('filterByTags()', () => {
  it('returns all doc keys when tags array is empty', () => {
    const index = createSearchIndex();
    index.addPlugin('plugin-a', makeManifest({ tools: [makeTool('tool-a', 'Tool A')] }));
    index.addPlugin('plugin-b', makeManifest({ tools: [makeTool('tool-b', 'Tool B')] }));
    const keys = index.filterByTags([]);
    expect(keys).toHaveLength(2);
  });

  it('returns matching doc keys for a single tag', () => {
    const index = createSearchIndex();
    index.addPlugin('plugin-a', makeManifest({
      tools: [makeTool('read-file', 'Reads a file', ['filesystem'])],
    }));
    index.addPlugin('plugin-b', makeManifest({
      tools: [makeTool('send-request', 'Sends HTTP', ['network'])],
    }));
    const keys = index.filterByTags(['filesystem']);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe('plugin-a:read-file');
  });

  it('uses AND semantics — only returns tools with all specified tags', () => {
    const index = createSearchIndex();
    index.addPlugin('plugin-a', makeManifest({
      tools: [makeTool('read-file', 'Reads a file', ['filesystem', 'io'])],
    }));
    index.addPlugin('plugin-b', makeManifest({
      tools: [makeTool('send-request', 'Sends HTTP', ['network', 'io'])],
    }));
    // Only plugin-a has both tags
    const keys = index.filterByTags(['filesystem', 'io']);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe('plugin-a:read-file');
  });

  it('matches tools tagged at the plugin level', () => {
    const index = createSearchIndex();
    index.addPlugin('my-plugin', makeManifest({
      tags: ['io'],
      tools: [makeTool('read-file', 'Reads a file')],
    }));
    const keys = index.filterByTags(['io']);
    expect(keys).toHaveLength(1);
  });

  it('is case-insensitive — filterByTags([Search]) matches a tool tagged search', () => {
    const index = createSearchIndex();
    index.addPlugin('my-plugin', makeManifest({
      tools: [makeTool('find', 'Find things', ['search'])],
    }));
    expect(index.filterByTags(['Search'])).toHaveLength(1);
    expect(index.filterByTags(['SEARCH'])).toHaveLength(1);
    expect(index.filterByTags(['search'])).toHaveLength(1);
  });

  it('returns empty array when no tools match the tag', () => {
    const index = createSearchIndex();
    index.addPlugin('my-plugin', makeManifest({
      tools: [makeTool('read-file', 'Reads a file', ['filesystem'])],
    }));
    expect(index.filterByTags(['network'])).toEqual([]);
  });

  it('only returns the tagged tool when one tool in a plugin has the tag and another does not', () => {
    const index = createSearchIndex();
    index.addPlugin('my-plugin', makeManifest({
      tools: [
        makeTool('read-file', 'Reads a file', ['io']),
        makeTool('write-file', 'Writes a file'),
      ],
    }));
    const keys = index.filterByTags(['io']);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe('my-plugin:read-file');
  });
});

describe('multiple plugins', () => {
  it('two plugins with same-named tools get distinct doc keys', () => {
    const index = createSearchIndex();
    index.addPlugin('plugin-a', makeManifest({ tools: [makeTool('search', 'Search A')] }));
    index.addPlugin('plugin-b', makeManifest({ tools: [makeTool('search', 'Search B')] }));
    expect(index.size).toBe(2);
    const keys = index.filterByTags([]);
    expect(keys).toContain('plugin-a:search');
    expect(keys).toContain('plugin-b:search');
  });

  it('removing one plugin does not affect the other when they share tool names', () => {
    const index = createSearchIndex();
    index.addPlugin('plugin-a', makeManifest({ tools: [makeTool('search', 'Search A')] }));
    index.addPlugin('plugin-b', makeManifest({ tools: [makeTool('search', 'Search B')] }));
    index.removePlugin('plugin-a');
    expect(index.size).toBe(1);
    expect(index.getDocuments()[0]!.pluginKey).toBe('plugin-b');
  });
});
