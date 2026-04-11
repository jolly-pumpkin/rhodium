import { describe, it, expect } from 'bun:test';
import { allocateBudget } from './allocator.js';
import { ContributionTooLargeError } from '../../core/src/errors.js';

describe('maxContributionBytes enforcement', () => {
  it('throws ContributionTooLargeError when systemPromptFragment exceeds limit', () => {
    const bigText = 'x'.repeat(300_000); // > 256KB
    expect(() =>
      allocateBudget(
        [{ pluginKey: 'a', priority: 50, systemPromptFragment: bigText }],
        { maxTokens: 1_000_000 }
      )
    ).toThrow(ContributionTooLargeError);
  });

  it('throws when tools JSON alone exceeds the limit', () => {
    // Contribution with no systemPromptFragment but large tools
    const bigTools = Array.from({ length: 5000 }, (_, i) => ({
      name: `tool_${i}`,
      description: 'x'.repeat(50),
    }));
    expect(() =>
      allocateBudget(
        [{ pluginKey: 'a', priority: 50, tools: bigTools as never }],
        { maxTokens: 1_000_000 }
      )
    ).toThrow(ContributionTooLargeError);
  });

  it('throws with correct pluginKey', () => {
    try {
      allocateBudget(
        [{ pluginKey: 'big-plugin', priority: 50, systemPromptFragment: 'x'.repeat(300_000) }],
        { maxTokens: 1_000_000 }
      );
      expect(true).toBe(false); // must not reach
    } catch (e) {
      expect(e).toBeInstanceOf(ContributionTooLargeError);
      expect((e as ContributionTooLargeError).pluginKey).toBe('big-plugin');
    }
  });

  it('respects custom maxContributionBytes', () => {
    expect(() =>
      allocateBudget(
        [{ pluginKey: 'a', priority: 50, systemPromptFragment: 'x'.repeat(100) }],
        { maxTokens: 1_000_000 },
        { maxContributionBytes: 50 }
      )
    ).toThrow(ContributionTooLargeError);
  });

  it('passes when contribution is within byte limit', () => {
    expect(() =>
      allocateBudget(
        [{ pluginKey: 'a', priority: 50, systemPromptFragment: 'hello' }],
        { maxTokens: 100 }
      )
    ).not.toThrow();
  });
});
