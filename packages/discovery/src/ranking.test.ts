import { describe, it, expect } from 'bun:test';
import { scoreDocument, rankResults } from './ranking.js';
import type { IndexedTool } from './index-builder.js';

function makeDoc(overrides: Partial<IndexedTool> = {}): IndexedTool {
  return {
    pluginKey: 'test-plugin',
    toolName: 'test-tool',
    description: 'A test tool',
    tags: [],
    nameTokens: [],
    descriptionTokens: [],
    toolTagTokens: [],
    pluginTagTokens: [],
    pluginDescriptionTokens: [],
    ...overrides,
  };
}

describe('scoreDocument()', () => {
  it('returns 0 for empty query tokens', () => {
    const doc = makeDoc({ nameTokens: ['read', 'read', 'read'] });
    expect(scoreDocument([], doc)).toBe(0);
  });

  it('returns 0 when no query token appears in any field', () => {
    const doc = makeDoc({ nameTokens: ['write', 'write', 'write'] });
    expect(scoreDocument(['read'], doc)).toBe(0);
  });

  it('counts occurrences in nameTokens (pre-repeated 3×)', () => {
    const doc = makeDoc({ nameTokens: ['read', 'read', 'read'] });
    expect(scoreDocument(['read'], doc)).toBe(3);
  });

  it('counts occurrences in descriptionTokens (pre-repeated 2×)', () => {
    const doc = makeDoc({ descriptionTokens: ['read', 'read'] });
    expect(scoreDocument(['read'], doc)).toBe(2);
  });

  it('sums across all token fields', () => {
    // name 3× + description 2× = 5
    const doc = makeDoc({
      nameTokens: ['read', 'read', 'read'],
      descriptionTokens: ['read', 'read'],
    });
    expect(scoreDocument(['read'], doc)).toBe(5);
  });

  it('sums across multiple query tokens', () => {
    const doc = makeDoc({
      nameTokens: ['read', 'read', 'read'],
      descriptionTokens: ['file', 'file'],
    });
    expect(scoreDocument(['read', 'file'], doc)).toBe(5);
  });

  it('a name-field match scores higher than a description-only match', () => {
    const nameMatch = makeDoc({ nameTokens: ['read', 'read', 'read'] });
    const descMatch = makeDoc({ descriptionTokens: ['read', 'read'] });
    expect(scoreDocument(['read'], nameMatch)).toBeGreaterThan(
      scoreDocument(['read'], descMatch),
    );
  });
});

describe('rankResults()', () => {
  it('returns empty array when candidates is empty', () => {
    expect(rankResults([], 0.1, 10)).toEqual([]);
  });

  it('returns empty array when all rawScores are 0', () => {
    const candidates = [
      { doc: makeDoc({ toolName: 'a' }), rawScore: 0 },
      { doc: makeDoc({ toolName: 'b' }), rawScore: 0 },
    ];
    expect(rankResults(candidates, 0.1, 10)).toEqual([]);
  });

  it('normalizes the top result to relevanceScore of 1.0', () => {
    const candidates = [
      { doc: makeDoc({ toolName: 'a' }), rawScore: 10 },
      { doc: makeDoc({ toolName: 'b' }), rawScore: 5 },
    ];
    const results = rankResults(candidates, 0, 10);
    expect(results[0]!.relevanceScore).toBe(1.0);
  });

  it('scales other results proportionally to the top score', () => {
    const candidates = [
      { doc: makeDoc({ toolName: 'a' }), rawScore: 10 },
      { doc: makeDoc({ toolName: 'b' }), rawScore: 5 },
    ];
    const results = rankResults(candidates, 0, 10);
    expect(results[1]!.relevanceScore).toBe(0.5);
  });

  it('filters out results strictly below minRelevance', () => {
    const candidates = [
      { doc: makeDoc({ toolName: 'a' }), rawScore: 10 },
      { doc: makeDoc({ toolName: 'b' }), rawScore: 0.5 }, // 0.5/10 = 0.05 < 0.1
    ];
    const results = rankResults(candidates, 0.1, 10);
    expect(results).toHaveLength(1);
    expect(results[0]!.doc.toolName).toBe('a');
  });

  it('keeps results whose relevanceScore equals minRelevance exactly', () => {
    const candidates = [
      { doc: makeDoc({ toolName: 'a' }), rawScore: 10 },
      { doc: makeDoc({ toolName: 'b' }), rawScore: 1 }, // 1/10 = 0.1 == minRelevance
    ];
    expect(rankResults(candidates, 0.1, 10)).toHaveLength(2);
  });

  it('sorts descending by relevanceScore', () => {
    const candidates = [
      { doc: makeDoc({ toolName: 'low' }), rawScore: 2 },
      { doc: makeDoc({ toolName: 'high' }), rawScore: 10 },
      { doc: makeDoc({ toolName: 'mid' }), rawScore: 5 },
    ];
    const results = rankResults(candidates, 0, 10);
    expect(results.map(r => r.doc.toolName)).toEqual(['high', 'mid', 'low']);
  });

  it('respects limit', () => {
    const candidates = Array.from({ length: 20 }, (_, i) => ({
      doc: makeDoc({ toolName: `tool-${i}` }),
      rawScore: 20 - i,
    }));
    expect(rankResults(candidates, 0, 5)).toHaveLength(5);
  });
});
