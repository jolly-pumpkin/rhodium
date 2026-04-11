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

describe('priority strategy — constraints', () => {
  const counter = createTokenCounter('chars4');

  it('drops atomic contribution when it will not fit', () => {
    const result = allocateBudget(
      [{ pluginKey: 'a', priority: 60, systemPromptFragment: 'x'.repeat(40), atomic: true }],
      { maxTokens: 5, allocationStrategy: 'priority' },
      { tokenCounter: counter }
    );
    expect(result.allocated).toHaveLength(0);
    expect(result.dropped[0]?.reason).toBe('atomic');
  });

  it('never marks atomic contribution as truncated (allocates fully if budget allows)', () => {
    const result = allocateBudget(
      [{ pluginKey: 'a', priority: 60, systemPromptFragment: 'hi', atomic: true }],
      { maxTokens: 100, allocationStrategy: 'priority' },
      { tokenCounter: counter }
    );
    expect(result.allocated[0]?.truncated).toBe(false);
  });

  it('drops contribution when remaining < minTokens', () => {
    const result = allocateBudget(
      [{ pluginKey: 'a', priority: 60, systemPromptFragment: 'hi', minTokens: 50 }],
      { maxTokens: 5, allocationStrategy: 'priority' },
      { tokenCounter: counter }
    );
    expect(result.dropped[0]?.reason).toBe('minTokens');
  });

  it('allocates contribution when remaining >= minTokens', () => {
    const result = allocateBudget(
      [{ pluginKey: 'a', priority: 60, systemPromptFragment: 'hi', minTokens: 1 }],
      { maxTokens: 100, allocationStrategy: 'priority' },
      { tokenCounter: counter }
    );
    expect(result.allocated).toHaveLength(1);
  });

  it('uses atomic as drop reason when both atomic and minTokens would fire', () => {
    // estimated=10, remaining=5, minTokens=8 — both atomic and minTokens would reject
    // atomic must win as the drop reason
    const result = allocateBudget(
      [{ pluginKey: 'a', priority: 60, systemPromptFragment: 'x'.repeat(40), atomic: true, minTokens: 8 }],
      { maxTokens: 5, allocationStrategy: 'priority' },
      { tokenCounter: counter }
    );
    expect(result.dropped[0]?.reason).toBe('atomic');
  });
});

describe('severity computation', () => {
  const counter = createTokenCounter('chars4');

  it('severity is critical when priority > 80', () => {
    const result = allocateBudget(
      [{ pluginKey: 'a', priority: 81, systemPromptFragment: 'x'.repeat(40), atomic: true }],
      { maxTokens: 1, allocationStrategy: 'priority' },
      { tokenCounter: counter }
    );
    expect(result.dropped[0]?.severity).toBe('critical');
  });

  it('severity is warning when priority is 51-80', () => {
    const result = allocateBudget(
      [{ pluginKey: 'a', priority: 51, systemPromptFragment: 'x'.repeat(40), atomic: true }],
      { maxTokens: 1, allocationStrategy: 'priority' },
      { tokenCounter: counter }
    );
    expect(result.dropped[0]?.severity).toBe('warning');
  });

  it('severity is info when priority <= 50', () => {
    const result = allocateBudget(
      [{ pluginKey: 'a', priority: 50, systemPromptFragment: 'x'.repeat(40), atomic: true }],
      { maxTokens: 1, allocationStrategy: 'priority' },
      { tokenCounter: counter }
    );
    expect(result.dropped[0]?.severity).toBe('info');
  });
});

describe('reserved token deduction', () => {
  const counter = createTokenCounter('chars4');

  it('deducts reservedSystemTokens before allocation', () => {
    // maxTokens=100, reserved=90 → 10 available. 'x'.repeat(80)=20 tokens → truncated to 10
    const result = allocateBudget(
      [{ pluginKey: 'a', priority: 50, systemPromptFragment: 'x'.repeat(80) }],
      { maxTokens: 100, reservedSystemTokens: 90, allocationStrategy: 'priority' },
      { tokenCounter: counter }
    );
    expect(result.allocated[0]?.tokens).toBe(10);
    expect(result.allocated[0]?.truncated).toBe(true);
  });

  it('deducts reservedToolTokens before allocation', () => {
    const result = allocateBudget(
      [{ pluginKey: 'a', priority: 50, systemPromptFragment: 'x'.repeat(80) }],
      { maxTokens: 100, reservedToolTokens: 90, allocationStrategy: 'priority' },
      { tokenCounter: counter }
    );
    expect(result.allocated[0]?.tokens).toBe(10);
  });

  it('deducts both reserved amounts', () => {
    const result = allocateBudget(
      [{ pluginKey: 'a', priority: 50, systemPromptFragment: 'x'.repeat(80) }],
      { maxTokens: 100, reservedSystemTokens: 50, reservedToolTokens: 40, allocationStrategy: 'priority' },
      { tokenCounter: counter }
    );
    expect(result.allocated[0]?.tokens).toBe(10);
  });

  it('uses all available when reserved amounts are 0', () => {
    const result = allocateBudget(
      [{ pluginKey: 'a', priority: 50, systemPromptFragment: 'hi' }],
      { maxTokens: 100 },
      { tokenCounter: counter }
    );
    expect(result.allocated[0]?.tokens).toBeGreaterThan(0);
  });
});

describe('proportional strategy', () => {
  const counter = createTokenCounter('chars4');

  it('gives higher priority plugins proportionally more tokens', () => {
    // priorities 75 and 25, total=100. Budget=100. Shares: 75 and 25.
    // content=400 chars = 100 tokens each (more than share) → both truncated
    const result = allocateBudget(
      [
        { pluginKey: 'high', priority: 75, systemPromptFragment: 'x'.repeat(400) },
        { pluginKey: 'low', priority: 25, systemPromptFragment: 'x'.repeat(400) },
      ],
      { maxTokens: 100, allocationStrategy: 'proportional' },
      { tokenCounter: counter }
    );
    const high = result.allocated.find(a => a.pluginKey === 'high');
    const low = result.allocated.find(a => a.pluginKey === 'low');
    expect(high?.tokens).toBe(75);
    expect(low?.tokens).toBe(25);
    expect(high?.truncated).toBe(true);
    expect(low?.truncated).toBe(true);
  });

  it('allocates full amount when contribution fits within share', () => {
    const result = allocateBudget(
      [{ pluginKey: 'a', priority: 50, systemPromptFragment: 'hi' }],
      { maxTokens: 100, allocationStrategy: 'proportional' },
      { tokenCounter: counter }
    );
    expect(result.allocated[0]?.truncated).toBe(false);
  });

  it('drops atomic contribution when share is insufficient', () => {
    // 10% share of 100 = 10 tokens. Content = 100 tokens. atomic → drop.
    const result = allocateBudget(
      [
        { pluginKey: 'small', priority: 10, systemPromptFragment: 'x'.repeat(400), atomic: true },
        { pluginKey: 'large', priority: 90, systemPromptFragment: 'hi' },
      ],
      { maxTokens: 100, allocationStrategy: 'proportional' },
      { tokenCounter: counter }
    );
    expect(result.dropped.find(d => d.pluginKey === 'small')?.reason).toBe('atomic');
  });

  it('drops contribution when share < minTokens', () => {
    const result = allocateBudget(
      [
        { pluginKey: 'a', priority: 10, systemPromptFragment: 'hi', minTokens: 50 },
        { pluginKey: 'b', priority: 90, systemPromptFragment: 'hi' },
      ],
      { maxTokens: 100, allocationStrategy: 'proportional' },
      { tokenCounter: counter }
    );
    expect(result.dropped.find(d => d.pluginKey === 'a')?.reason).toBe('minTokens');
  });

  it('totalAllocated equals sum of allocated tokens', () => {
    const result = allocateBudget(
      [
        { pluginKey: 'a', priority: 60, systemPromptFragment: 'x'.repeat(400) },
        { pluginKey: 'b', priority: 40, systemPromptFragment: 'x'.repeat(400) },
      ],
      { maxTokens: 100, allocationStrategy: 'proportional' },
      { tokenCounter: counter }
    );
    const sum = result.allocated.reduce((s, a) => s + a.tokens, 0);
    expect(result.totalAllocated).toBe(sum);
  });

  it('handles zero-priority contribution (gets zero share)', () => {
    // Zero-priority contribution gets 0% of budget in proportional strategy
    const result = allocateBudget(
      [
        { pluginKey: 'zero', priority: 0, systemPromptFragment: 'hi' },
        { pluginKey: 'normal', priority: 100, systemPromptFragment: 'hi' },
      ],
      { maxTokens: 100, allocationStrategy: 'proportional' },
      { tokenCounter: counter }
    );
    // zero gets share=0, content>0, truncated=true (allocated 0 tokens)
    const zero = result.allocated.find(a => a.pluginKey === 'zero');
    expect(zero?.tokens).toBe(0);
    expect(zero?.truncated).toBe(true);
  });
});

describe('equal strategy', () => {
  const counter = createTokenCounter('chars4');

  it('gives each contribution the same budget share regardless of priority', () => {
    const result = allocateBudget(
      [
        { pluginKey: 'a', priority: 90, systemPromptFragment: 'x'.repeat(400) },
        { pluginKey: 'b', priority: 10, systemPromptFragment: 'x'.repeat(400) },
      ],
      { maxTokens: 100, allocationStrategy: 'equal' },
      { tokenCounter: counter }
    );
    const a = result.allocated.find(x => x.pluginKey === 'a');
    const b = result.allocated.find(x => x.pluginKey === 'b');
    expect(a?.tokens).toBe(50);
    expect(b?.tokens).toBe(50);
  });

  it('drops atomic contribution when share is insufficient', () => {
    const result = allocateBudget(
      [
        { pluginKey: 'a', priority: 50, systemPromptFragment: 'x'.repeat(400), atomic: true },
        { pluginKey: 'b', priority: 50, systemPromptFragment: 'hi' },
      ],
      { maxTokens: 100, allocationStrategy: 'equal' },
      { tokenCounter: counter }
    );
    expect(result.dropped.find(d => d.pluginKey === 'a')?.reason).toBe('atomic');
  });

  it('drops contribution when share < minTokens', () => {
    const result = allocateBudget(
      [
        { pluginKey: 'a', priority: 50, systemPromptFragment: 'hi', minTokens: 60 },
        { pluginKey: 'b', priority: 50, systemPromptFragment: 'hi' },
      ],
      { maxTokens: 100, allocationStrategy: 'equal' },
      { tokenCounter: counter }
    );
    expect(result.dropped.find(d => d.pluginKey === 'a')?.reason).toBe('minTokens');
  });

  it('totalAllocated equals sum of allocated tokens', () => {
    const result = allocateBudget(
      [
        { pluginKey: 'a', priority: 90, systemPromptFragment: 'x'.repeat(400) },
        { pluginKey: 'b', priority: 10, systemPromptFragment: 'x'.repeat(400) },
      ],
      { maxTokens: 100, allocationStrategy: 'equal' },
      { tokenCounter: counter }
    );
    const sum = result.allocated.reduce((s, a) => s + a.tokens, 0);
    expect(result.totalAllocated).toBe(sum);
  });

  it('handles empty contributions array', () => {
    const result = allocateBudget(
      [],
      { maxTokens: 100, allocationStrategy: 'equal' }
    );
    expect(result.allocated).toHaveLength(0);
    expect(result.dropped).toHaveLength(0);
    expect(result.totalAllocated).toBe(0);
  });
});
