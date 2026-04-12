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
