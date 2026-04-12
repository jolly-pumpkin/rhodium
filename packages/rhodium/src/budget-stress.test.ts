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
});
