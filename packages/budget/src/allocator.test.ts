import { describe, it, expect } from 'bun:test';
import { allocateBudget } from './allocator.js';
import { ContributionTooLargeError } from '../../core/src/errors.js';
import { createTokenCounter } from './counter.js';

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

describe('priority strategy — basic allocation', () => {
  const counter = createTokenCounter('chars4');

  it('allocates contributions in priority order, high-priority first', () => {
    // 'x'.repeat(40) = 40 chars → ceil(40/4) = 10 tokens each
    // Budget: 12 tokens. high gets 10 (fits), leaving 2. low needs 10 but only 2 remain
    // → low is truncated (non-atomic) to 2 tokens
    const result = allocateBudget(
      [
        { pluginKey: 'low', priority: 10, systemPromptFragment: 'x'.repeat(40) },
        { pluginKey: 'high', priority: 90, systemPromptFragment: 'x'.repeat(40) },
      ],
      { maxTokens: 12, allocationStrategy: 'priority' },
      { tokenCounter: counter }
    );
    expect(result.allocated).toHaveLength(2);
    expect(result.allocated[0]?.pluginKey).toBe('high');
    expect(result.allocated[0]?.truncated).toBe(false);
    expect(result.allocated[1]?.pluginKey).toBe('low');
    expect(result.allocated[1]?.tokens).toBe(2);
    expect(result.allocated[1]?.truncated).toBe(true);
  });

  it('drops contributions when remaining is 0', () => {
    // Budget exactly fits high (10 tokens), low gets remaining=0 → dropped
    const result = allocateBudget(
      [
        { pluginKey: 'low', priority: 10, systemPromptFragment: 'x'.repeat(40) },
        { pluginKey: 'high', priority: 90, systemPromptFragment: 'x'.repeat(40) },
      ],
      { maxTokens: 10, allocationStrategy: 'priority' },
      { tokenCounter: counter }
    );
    expect(result.allocated).toHaveLength(1);
    expect(result.allocated[0]?.pluginKey).toBe('high');
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]?.pluginKey).toBe('low');
    expect(result.dropped[0]?.reason).toBe('budget');
  });

  it('allocates all contributions when budget is sufficient', () => {
    const result = allocateBudget(
      [
        { pluginKey: 'a', priority: 80, systemPromptFragment: 'hi' },
        { pluginKey: 'b', priority: 40, systemPromptFragment: 'hi' },
      ],
      { maxTokens: 100, allocationStrategy: 'priority' },
      { tokenCounter: counter }
    );
    expect(result.allocated).toHaveLength(2);
    expect(result.dropped).toHaveLength(0);
  });

  it('tracks totalAllocated as sum of allocated tokens', () => {
    const result = allocateBudget(
      [
        { pluginKey: 'a', priority: 80, systemPromptFragment: 'x'.repeat(40) },
        { pluginKey: 'b', priority: 40, systemPromptFragment: 'x'.repeat(40) },
      ],
      { maxTokens: 100, allocationStrategy: 'priority' },
      { tokenCounter: counter }
    );
    const sum = result.allocated.reduce((s, a) => s + a.tokens, 0);
    expect(result.totalAllocated).toBe(sum);
  });

  it('emits budget:overflow with reason overflow when remaining=0 and contribution dropped', () => {
    const emitted: Array<{ event: string; payload: unknown }> = [];
    allocateBudget(
      [
        { pluginKey: 'high', priority: 90, systemPromptFragment: 'x'.repeat(40) },
        { pluginKey: 'low', priority: 10, systemPromptFragment: 'x'.repeat(40) },
      ],
      { maxTokens: 10, allocationStrategy: 'priority' },
      {
        tokenCounter: counter,
        emit: (e, p) => { emitted.push({ event: e, payload: p }); },
      }
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.event).toBe('budget:overflow');
    expect((emitted[0]?.payload as Record<string, unknown>).reason).toBe('overflow');
    expect((emitted[0]?.payload as Record<string, unknown>).pluginKey).toBe('low');
  });
});
