import { describe, it, expect, beforeEach } from 'bun:test';
import { CapabilityNotFoundError } from 'rhodium-core';
import type { CapabilityDeclaration, DependencyDeclaration } from 'rhodium-core';
import type { CapabilityResolver } from './types.js';
import { createCapabilityResolver } from './resolver.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeDecl(capability: string, opts: Partial<CapabilityDeclaration> = {}): CapabilityDeclaration {
  return { capability, ...opts };
}

function makeDep(capability: string, opts: Partial<DependencyDeclaration> = {}): DependencyDeclaration {
  return { capability, ...opts };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('createCapabilityResolver', () => {
  let resolver: CapabilityResolver;
  let idx: number;

  beforeEach(() => {
    resolver = createCapabilityResolver();
    idx = 0;
  });

  function reg(pluginKey: string, decl: CapabilityDeclaration) {
    resolver.registerProvider(pluginKey, decl, idx++);
  }

  // Rule 1: Single provider → return it
  describe('Rule 1: single provider', () => {
    it('returns the only registered provider', () => {
      reg('plugin-a', makeDecl('llm'));
      const result = resolver.resolve(makeDep('llm'), 'consumer', '1.0.0');
      expect(result?.pluginKey).toBe('plugin-a');
    });
  });

  // Rule 2: Multiple providers, single expected → highest priority wins
  describe('Rule 2: priority tiebreaking', () => {
    it('returns the highest-priority provider', () => {
      reg('low', makeDecl('llm', { priority: 1 }));
      reg('high', makeDecl('llm', { priority: 10 }));
      reg('mid', makeDecl('llm', { priority: 5 }));
      const result = resolver.resolve(makeDep('llm'), 'consumer', '1.0.0');
      expect(result?.pluginKey).toBe('high');
    });

    it('breaks priority ties by recency (most recently registered wins)', () => {
      reg('first', makeDecl('llm', { priority: 5 }));
      reg('second', makeDecl('llm', { priority: 5 }));
      const result = resolver.resolve(makeDep('llm'), 'consumer', '1.0.0');
      expect(result?.pluginKey).toBe('second');
    });
  });

  // Rule 3: multiple: true → return all sorted by priority desc
  describe('Rule 3: multiple providers', () => {
    it('returns all providers sorted by priority descending', () => {
      reg('c', makeDecl('llm', { priority: 1 }));
      reg('a', makeDecl('llm', { priority: 10 }));
      reg('b', makeDecl('llm', { priority: 5 }));
      const results = resolver.resolveMany(makeDep('llm', { multiple: true }), 'consumer', '1.0.0');
      expect(results.map(r => r.pluginKey)).toEqual(['a', 'b', 'c']);
    });

    it('breaks ties in resolveMany by recency (most recent first)', () => {
      reg('first', makeDecl('llm', { priority: 5 }));
      reg('second', makeDecl('llm', { priority: 5 }));
      reg('third', makeDecl('llm', { priority: 5 }));
      const results = resolver.resolveMany(makeDep('llm', { multiple: true }), 'consumer', '1.0.0');
      expect(results.map(r => r.pluginKey)).toEqual(['third', 'second', 'first']);
    });
  });

  // Rule 4: Missing required → throw CapabilityNotFoundError
  describe('Rule 4: missing required dependency', () => {
    it('throws CapabilityNotFoundError when no providers and dependency is required', () => {
      expect(() => resolver.resolve(makeDep('missing-cap'), 'consumer', '1.0.0'))
        .toThrow(CapabilityNotFoundError);
    });

    it('lists available capabilities in the error message', () => {
      reg('plugin-a', makeDecl('other-cap'));
      // error message should name what IS available so the developer can debug
      expect(() => resolver.resolve(makeDep('missing-cap'), 'consumer', '1.0.0'))
        .toThrow(/other-cap/);
    });

    it('error lists (none) in message when no providers exist', () => {
      let err: CapabilityNotFoundError | undefined;
      try {
        resolver.resolve(makeDep('missing-cap'), 'consumer', '1.0.0');
      } catch (e) {
        err = e as CapabilityNotFoundError;
      }
      expect(err).toBeInstanceOf(CapabilityNotFoundError);
      expect(err?.message).toContain('(none)');
    });
  });

  // Rule 4 continued: resolveMany required+missing also throws
  describe('Rule 4 (resolveMany): required+multiple+missing throws', () => {
    it('throws CapabilityNotFoundError for required+multiple with no providers', () => {
      expect(() => resolver.resolveMany(makeDep('llm', { multiple: true }), 'consumer', '1.0.0'))
        .toThrow(CapabilityNotFoundError);
    });
  });

  // Rule 5: Missing optional → return undefined
  describe('Rule 5: missing optional dependency', () => {
    it('returns undefined when no providers and dependency is optional', () => {
      const result = resolver.resolve(makeDep('llm', { optional: true }), 'consumer', '1.0.0');
      expect(result).toBeUndefined();
    });

    it('resolveMany returns empty array for optional+missing+multiple', () => {
      const results = resolver.resolveMany(makeDep('llm', { optional: true, multiple: true }), 'consumer', '1.0.0');
      expect(results).toEqual([]);
    });
  });

  // Rule 6: Variant filtering
  describe('Rule 6: variant filtering', () => {
    it('only considers providers matching the requested variant', () => {
      reg('fast', makeDecl('llm', { variant: 'fast', priority: 1 }));
      reg('slow', makeDecl('llm', { variant: 'slow', priority: 100 }));
      const result = resolver.resolve(makeDep('llm', { variant: 'fast' }), 'consumer', '1.0.0');
      expect(result?.pluginKey).toBe('fast');
    });

    it('throws CapabilityNotFoundError when no providers match the variant', () => {
      reg('slow', makeDecl('llm', { variant: 'slow' }));
      expect(() => resolver.resolve(makeDep('llm', { variant: 'fast' }), 'consumer', '1.0.0'))
        .toThrow(CapabilityNotFoundError);
    });

    it('returns undefined for optional dependency when variant has no match', () => {
      reg('slow', makeDecl('llm', { variant: 'slow' }));
      const result = resolver.resolve(makeDep('llm', { variant: 'fast', optional: true }), 'consumer', '1.0.0');
      expect(result).toBeUndefined();
    });

    it('applies variant filter before resolveMany sorting', () => {
      reg('fast-1', makeDecl('llm', { variant: 'fast', priority: 1 }));
      reg('slow-10', makeDecl('llm', { variant: 'slow', priority: 10 }));
      reg('fast-5', makeDecl('llm', { variant: 'fast', priority: 5 }));
      const results = resolver.resolveMany(makeDep('llm', { variant: 'fast', multiple: true }), 'consumer', '1.0.0');
      expect(results.map(r => r.pluginKey)).toEqual(['fast-5', 'fast-1']);
    });
  });

  // Unregister / late arrival
  describe('unregisterPlugin and late arrival', () => {
    it('removes all capabilities for a plugin on unregister', () => {
      reg('plugin-a', makeDecl('llm'));
      resolver.unregisterPlugin('plugin-a');
      expect(() => resolver.resolve(makeDep('llm'), 'consumer', '1.0.0'))
        .toThrow(CapabilityNotFoundError);
    });

    it('late arrival: a newly registered plugin wins at its registration index', () => {
      reg('early', makeDecl('llm', { priority: 5 }));
      // late arrival with same priority — wins via recency
      reg('late', makeDecl('llm', { priority: 5 }));
      const result = resolver.resolve(makeDep('llm'), 'consumer', '1.0.0');
      expect(result?.pluginKey).toBe('late');
    });

    it('late arrival: lower priority does not win over existing higher priority', () => {
      reg('established', makeDecl('llm', { priority: 10 }));
      reg('newcomer', makeDecl('llm', { priority: 1 }));
      const result = resolver.resolve(makeDep('llm'), 'consumer', '1.0.0');
      expect(result?.pluginKey).toBe('established');
    });

    it('unregister then re-register resets recency', () => {
      reg('plugin-a', makeDecl('llm', { priority: 5 }));
      reg('plugin-b', makeDecl('llm', { priority: 5 }));
      resolver.unregisterPlugin('plugin-b');
      reg('plugin-b', makeDecl('llm', { priority: 5 })); // re-register, gets new index
      const result = resolver.resolve(makeDep('llm'), 'consumer', '1.0.0');
      expect(result?.pluginKey).toBe('plugin-b');
    });
  });

  // Default priority
  describe('default priority', () => {
    it('treats missing priority as 0', () => {
      reg('default', makeDecl('llm'));          // priority = 0 (default)
      reg('explicit', makeDecl('llm', { priority: 0 }));
      // both priority 0 → recency wins → explicit (registered last)
      const result = resolver.resolve(makeDep('llm'), 'consumer', '1.0.0');
      expect(result?.pluginKey).toBe('explicit');
    });
  });
});
