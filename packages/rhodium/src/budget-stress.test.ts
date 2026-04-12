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
