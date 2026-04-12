import { describe, it, expect } from 'bun:test';
import { scoreDocument, rankResults } from './ranking.js';
import type { IndexedTool, CorpusStats } from './index-builder.js';

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

function makeCorpusStats(overrides: Partial<CorpusStats> = {}): CorpusStats {
  return {
    termDocFreq: new Map(),
    totalDocs: 1,
    ...overrides,
  };
}

describe('scoreDocument()', () => {
  it('returns 0 for empty query tokens', () => {
    const doc = makeDoc({ nameTokens: ['read', 'read', 'read'] });
    const stats = makeCorpusStats({ termDocFreq: new Map([['read', 1]]) });
    expect(scoreDocument([], doc, stats)).toBe(0);
  });

  it('returns 0 when no query token appears in any field', () => {
    const doc = makeDoc({ nameTokens: ['write', 'write', 'write'] });
    const stats = makeCorpusStats({ termDocFreq: new Map([['read', 1]]) });
    expect(scoreDocument(['read'], doc, stats)).toBe(0);
  });

  it('counts occurrences in nameTokens (pre-repeated 3×) with IDF weighting', () => {
    const doc = makeDoc({ nameTokens: ['read', 'read', 'read'] });
    // With 1 doc total and 'read' in 1 doc: IDF = log((1+1)/(1+1)) + 1 = log(1) + 1 = 1
    const stats = makeCorpusStats({ termDocFreq: new Map([['read', 1]]), totalDocs: 1 });
    expect(scoreDocument(['read'], doc, stats)).toBe(3); // 3 TF × 1 IDF = 3
  });

  it('counts occurrences in descriptionTokens (pre-repeated 2×) with IDF weighting', () => {
    const doc = makeDoc({ descriptionTokens: ['read', 'read'] });
    const stats = makeCorpusStats({ termDocFreq: new Map([['read', 1]]), totalDocs: 1 });
    expect(scoreDocument(['read'], doc, stats)).toBe(2); // 2 TF × 1 IDF = 2
  });

  it('sums across all token fields (with IDF for each term)', () => {
    // name 3× + description 2× = 5 (with single-doc corpus, IDF = 1 for all)
    const doc = makeDoc({
      nameTokens: ['read', 'read', 'read'],
      descriptionTokens: ['read', 'read'],
    });
    const stats = makeCorpusStats({ termDocFreq: new Map([['read', 1]]), totalDocs: 1 });
    expect(scoreDocument(['read'], doc, stats)).toBe(5);
  });

  it('sums across multiple query tokens (with IDF weighting)', () => {
    const doc = makeDoc({
      nameTokens: ['read', 'read', 'read'],
      descriptionTokens: ['file', 'file'],
    });
    const stats = makeCorpusStats({
      termDocFreq: new Map([['read', 1], ['file', 1]]),
      totalDocs: 1,
    });
    expect(scoreDocument(['read', 'file'], doc, stats)).toBe(5);
  });

  it('rare tokens score higher than common tokens (IDF effect)', () => {
    const nameMatch = makeDoc({ nameTokens: ['rare', 'rare', 'rare'] });
    const commonMatch = makeDoc({ nameTokens: ['read', 'read', 'read'] });
    // 'rare' appears in 1 doc out of 100, 'read' appears in 50 docs out of 100
    // IDF(rare) = log((100+1)/(1+1)) + 1 ≈ log(50.5) + 1 ≈ 4.93
    // IDF(read) = log((100+1)/(50+1)) + 1 ≈ log(1.98) + 1 ≈ 1.69
    const stats = makeCorpusStats({
      termDocFreq: new Map([['rare', 1], ['read', 50]]),
      totalDocs: 100,
    });
    const rareScore = scoreDocument(['rare'], nameMatch, stats);
    const commonScore = scoreDocument(['read'], commonMatch, stats);
    expect(rareScore).toBeGreaterThan(commonScore);
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
