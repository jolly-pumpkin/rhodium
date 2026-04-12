import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import type { Plugin, AssembledContext } from './index.js';
import {
  createBroker,
  assertNoCriticalDrops,
  assertContextIncludes,
  allocateBudget,
  createTokenCounter,
} from './index.js';

// ── Plugin factory ────────────────────────────────────────────────────────────
//
// Produces generic cleanup-rule plugins with:
//   - priority: 20 + n (well below the critical threshold of > 80)
//   - ~50 tokens of content at chars/4 (200 chars / 4 = 50 tokens)

function makeCleanupPlugin(n: number, size = 200): Plugin {
  return {
    key: `cleanup-rule-${n}`,
    version: '1.0.0',
    manifest: { provides: [], needs: [], tools: [] },
    contributeContext() {
      return {
        pluginKey: `cleanup-rule-${n}`,
        priority: 20 + n,
        systemPromptFragment: 'x'.repeat(size),
      };
    },
  };
}

// ── Safety assessor (explicit) ────────────────────────────────────────────────
//
// Priority 90 (critical — above the > 80 threshold).
// ~300 tokens of content plus one tool.

const ASSESSOR_TOOL = {
  name: 'assess_safety',
  description: 'Assess whether a proposed change is safe to apply',
  parameters: { type: 'object' as const, properties: {}, required: [] },
};

const safetyAssessor: Plugin = {
  key: 'llm-safety-assessor',
  version: '1.0.0',
  manifest: { provides: [], needs: [], tools: [ASSESSOR_TOOL] },
  contributeContext() {
    return {
      pluginKey: 'llm-safety-assessor',
      priority: 90,
      systemPromptFragment: 'x'.repeat(1200), // ~300 tokens
      tools: [ASSESSOR_TOOL],
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Priority strategy under pressure
// ─────────────────────────────────────────────────────────────────────────────
//
// Budget: 800 tokens. Safety assessor (priority 90) goes first and takes ~335 tokens
// (1200-char prompt + tool JSON serialization). Remaining ~465 tokens fit 9 cleanup
// plugins fully; one is truncated; the lowest-priority 5 are dropped.

describe('priority strategy under pressure', () => {
  let context: AssembledContext;
  let broker: ReturnType<typeof createBroker>;

  beforeAll(async () => {
    broker = createBroker();
    for (let i = 1; i <= 15; i++) broker.register(makeCleanupPlugin(i));
    broker.register(safetyAssessor);
    await broker.activate();
    context = broker.assembleContext({
      tokenBudget: { maxTokens: 800, allocationStrategy: 'priority' },
    });
  });

  afterAll(async () => {
    await broker.deactivate();
  });

  it('safety assessor tool survives', () => {
    assertContextIncludes(context, { tools: ['assess_safety'] });
  });

  it('no critical drops', () => {
    expect(() => assertNoCriticalDrops(context)).not.toThrow();
  });

  it('at least one low-priority cleanup plugin is dropped', () => {
    const cleanupDrops = context.dropped.filter(d =>
      d.pluginKey.startsWith('cleanup-rule-'),
    );
    expect(cleanupDrops.length).toBeGreaterThan(0);
  });

  it('all dropped plugins are non-critical (priority ≤ 80)', () => {
    expect(context.dropped.length).toBeGreaterThan(0); // guard: ensures assertions below actually run
    for (const d of context.dropped) {
      expect(d.priority).toBeLessThanOrEqual(80);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Proportional strategy under pressure
// ─────────────────────────────────────────────────────────────────────────────
//
// Budget: 800 tokens. Total priority = 510 (90 + sum of 21..35).
// Assessor share = floor(90/510 × 800) = 141 tokens — less than its ~335 token
// content, so it is truncated (not dropped). assertNoCriticalDrops passes because
// truncation ≠ drop. The tool still appears in assembled context.

describe('proportional strategy under pressure', () => {
  let context: AssembledContext;
  let broker: ReturnType<typeof createBroker>;

  beforeAll(async () => {
    broker = createBroker();
    for (let i = 1; i <= 15; i++) broker.register(makeCleanupPlugin(i));
    broker.register(safetyAssessor);
    await broker.activate();
    context = broker.assembleContext({
      tokenBudget: { maxTokens: 800, allocationStrategy: 'proportional' },
    });
  });

  afterAll(async () => {
    await broker.deactivate();
  });

  it('safety assessor tool survives (proportional allocation)', () => {
    assertContextIncludes(context, { tools: ['assess_safety'] });
  });

  it('no critical drops', () => {
    expect(() => assertNoCriticalDrops(context)).not.toThrow();
  });

  it('assessor is not in dropped (truncated, not dropped)', () => {
    const assessorDrop = context.dropped.find(
      d => d.pluginKey === 'llm-safety-assessor',
    );
    expect(assessorDrop).toBeUndefined();
  });

  it('proportional strategy never drops plugins — all 16 contribute', () => {
    expect(context.dropped.length).toBe(0);
    expect(context.meta.contributingPlugins).toBe(16);
  });

  it('total tokens stay within budget ceiling', () => {
    // totalTokens reflects the actual serialized output size. The proportional
    // allocator allocates token shares for accounting but does not physically
    // truncate systemPromptFragment text — all 16 plugins contribute their full
    // content. The realistic ceiling is the sum of raw plugin inputs: 15 cleanup
    // plugins × 200 chars / 4 ≈ 750 tokens plus the assessor's 1200 chars / 4 ≈
    // 300 tokens plus tool JSON and separators ≈ 1200 tokens total.
    expect(context.totalTokens).toBeLessThanOrEqual(1200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Equal strategy under pressure
// ─────────────────────────────────────────────────────────────────────────────
//
// Budget: 800 tokens. 16 plugins → floor(800/16) = 50 tokens each (accounting share).
// The assessor gets only 50-token accounting share despite needing ~335 tokens.
// No plugin is dropped — equal strategy truncates accounting only, never evicts.
// This documents that equal strategy does NOT protect high-priority critical context:
// use priority or proportional if critical plugins must retain their full allocation.

describe('equal strategy under pressure', () => {
  let context: AssembledContext;
  let broker: ReturnType<typeof createBroker>;

  beforeAll(async () => {
    broker = createBroker();
    for (let i = 1; i <= 15; i++) broker.register(makeCleanupPlugin(i));
    broker.register(safetyAssessor);
    await broker.activate();
    context = broker.assembleContext({
      tokenBudget: { maxTokens: 800, allocationStrategy: 'equal' },
    });
  });

  afterAll(async () => {
    await broker.deactivate();
  });

  it('safety assessor tool survives (equal allocation)', () => {
    assertContextIncludes(context, { tools: ['assess_safety'] });
  });

  it('no critical drops (truncation is not a drop)', () => {
    expect(() => assertNoCriticalDrops(context)).not.toThrow();
  });

  it('equal strategy never drops plugins — all 16 contribute', () => {
    expect(context.dropped.length).toBe(0);
    expect(context.meta.contributingPlugins).toBe(16);
  });

  it('assessor is not in dropped (accounting-truncated, not evicted)', () => {
    const assessorDrop = context.dropped.find(
      d => d.pluginKey === 'llm-safety-assessor',
    );
    expect(assessorDrop).toBeUndefined();
  });

  it('totalTokens exceeds the accounting budget — full text is never physically truncated', () => {
    // All 16 plugins contribute full text because the pipeline never physically
    // shortens surviving plugins' systemPromptFragments. The 800-token "budget"
    // is accounting-only. Actual output is the full concatenation of all fragments.
    expect(context.totalTokens).toBeGreaterThan(800);
    expect(context.totalTokens).toBeLessThanOrEqual(1200); // sanity bound
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// atomic edge case
// ─────────────────────────────────────────────────────────────────────────────
//
// Safety assessor with atomic: true and ~600-token content (plus ~35 tool-JSON tokens).
// Budget: 400 tokens. With priority strategy, assessor goes first (priority 90)
// but needs ~635 tokens total — more than the entire 400-token budget.
// atomic: true converts the silent truncation into an explicit drop (atomic-no-fit).
// A truncated safety policy is worse than no policy: it appears complete but is missing
// critical rules. The drop shows up in context.dropped, causing assertNoCriticalDrops to throw.

describe('atomic edge case', () => {
  let context: AssembledContext;
  let broker: ReturnType<typeof createBroker>;

  const atomicAssessor: Plugin = {
    key: 'llm-safety-assessor',
    version: '1.0.0',
    manifest: { provides: [], needs: [], tools: [ASSESSOR_TOOL] },
    contributeContext() {
      return {
        pluginKey: 'llm-safety-assessor',
        priority: 90,
        systemPromptFragment: 'x'.repeat(2400), // ~600 tokens — must fit entirely or not at all
        atomic: true,
        tools: [ASSESSOR_TOOL],
      };
    },
  };

  beforeAll(async () => {
    broker = createBroker();
    for (let i = 1; i <= 15; i++) broker.register(makeCleanupPlugin(i));
    broker.register(atomicAssessor);
    await broker.activate();
    // Budget 400: assessor needs ~635 tokens → atomic drop.
    // Cleanup plugins (50 tokens each) then consume remaining 400 tokens.
    context = broker.assembleContext({
      tokenBudget: { maxTokens: 400, allocationStrategy: 'priority' },
    });
  });

  afterAll(async () => {
    await broker.deactivate();
  });

  it('atomic assessor is dropped with reason atomic-no-fit', () => {
    const drop = context.dropped.find(
      d => d.pluginKey === 'llm-safety-assessor',
    );
    expect(drop).toBeDefined();
    expect(drop?.reason).toBe('atomic-no-fit');
  });

  it('dropped assessor has severity critical (priority 90 > 80)', () => {
    const drop = context.dropped.find(
      d => d.pluginKey === 'llm-safety-assessor',
    );
    expect(drop?.severity).toBe('critical');
  });

  it('assertNoCriticalDrops throws because priority-90 plugin was dropped', () => {
    expect(() => assertNoCriticalDrops(context)).toThrow();
  });

  it('assess_safety tool is absent from assembled context (dropped contributor has no tools)', () => {
    const toolNames = context.tools.map(t => t.name);
    expect(toolNames).not.toContain('assess_safety');
  });

  it('budget freed by atomic drop is consumed by surviving cleanup plugins', () => {
    expect(context.meta.contributingPlugins).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// minTokens edge cases (allocator-direct)
// ─────────────────────────────────────────────────────────────────────────────
//
// minTokens declares "I am only useful if I get at least N tokens."
// The allocator drops the contribution (rather than truncating it to something
// meaningless) when remaining budget < minTokens. These tests drive allocateBudget()
// directly — no broker ceremony needed for isolated allocator behavior.

describe('minTokens edge cases (allocator-direct)', () => {
  const counter = createTokenCounter('chars4');

  it('drops contribution when available budget is below minTokens', () => {
    // Assessor needs at least 500 tokens to be useful, but only 300 available.
    const result = allocateBudget(
      [
        {
          pluginKey: 'llm-safety-assessor',
          priority: 90,
          systemPromptFragment: 'x'.repeat(400), // ~100 tokens content
          minTokens: 500,
        },
      ],
      { maxTokens: 300, allocationStrategy: 'priority' },
      { tokenCounter: counter },
    );
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]?.pluginKey).toBe('llm-safety-assessor');
    expect(result.dropped[0]?.reason).toBe('below-min-tokens');
  });

  it('allocates when available budget meets minTokens exactly', () => {
    // Content = ~100 tokens (400 chars), minTokens = 100, budget = 100 → exact fit.
    const result = allocateBudget(
      [
        {
          pluginKey: 'llm-safety-assessor',
          priority: 90,
          systemPromptFragment: 'x'.repeat(400), // ceil(400/4) = 100 tokens
          minTokens: 100,
        },
      ],
      { maxTokens: 100, allocationStrategy: 'priority' },
      { tokenCounter: counter },
    );
    expect(result.allocated).toHaveLength(1);
    expect(result.dropped).toHaveLength(0);
  });

  it('drops when atomic-no-fit takes priority over below-min-tokens (both conditions fire)', () => {
    // estimated=100 tokens, remaining=50, minTokens=80
    // Both atomic-no-fit AND below-min-tokens would fire — atomic wins as the reason.
    const result = allocateBudget(
      [
        {
          pluginKey: 'llm-safety-assessor',
          priority: 90,
          systemPromptFragment: 'x'.repeat(400), // ~100 tokens
          atomic: true,
          minTokens: 80,
        },
      ],
      { maxTokens: 50, allocationStrategy: 'priority' },
      { tokenCounter: counter },
    );
    expect(result.dropped[0]?.reason).toBe('atomic-no-fit');
  });

  it('minTokens drop under proportional pressure: assessor share < minTokens', () => {
    // 16 contributions (assessor + 15 cleanup). proportional strategy.
    // Total priority = 510. Assessor share = floor(90/510 * 800) = 141 tokens.
    // minTokens: 200 → 141 < 200 → drop with below-min-tokens.
    const contributions = [
      {
        pluginKey: 'llm-safety-assessor',
        priority: 90,
        systemPromptFragment: 'x'.repeat(1200), // ~300 tokens content
        minTokens: 200,
      },
      ...Array.from({ length: 15 }, (_, i) => ({
        pluginKey: `cleanup-rule-${i + 1}`,
        priority: 21 + i,
        systemPromptFragment: 'x'.repeat(200), // ~50 tokens each
      })),
    ];
    const result = allocateBudget(
      contributions,
      { maxTokens: 800, allocationStrategy: 'proportional' },
      { tokenCounter: counter },
    );
    const assessorDrop = result.dropped.find(
      d => d.pluginKey === 'llm-safety-assessor',
    );
    expect(assessorDrop).toBeDefined();
    expect(assessorDrop?.reason).toBe('below-min-tokens');
  });
});
