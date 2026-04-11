import { describe, it, expect } from 'bun:test';
import type {
  AssembledContext,
  AssembledTool,
  DroppedContribution,
} from '../../core/src/types.js';
import {
  ContextAssertionError,
  assertContextIncludes,
  assertNoCriticalDrops,
  assertNoDropsAbovePriority,
} from './assertions.js';

// ── fixtures ────────────────────────────────────────────────────────────────

function makeContext(
  overrides: Partial<AssembledContext> = {},
): AssembledContext {
  const { meta: metaOverride, ...rest } = overrides;
  return {
    systemPrompt: '',
    tools: [],
    totalTokens: 0,
    dropped: [],
    meta: {
      totalPlugins: 0,
      contributingPlugins: 0,
      droppedPlugins: 0,
      allocationStrategy: 'priority',
      durationMs: 0,
      tokenCounter: 'test',
      ...metaOverride,
    },
    ...rest,
  };
}

function tool(name: string, pluginKey: string): AssembledTool {
  return { name, description: `${name} tool`, pluginKey };
}

function drop(
  pluginKey: string,
  priority: number,
  overrides: Partial<DroppedContribution> = {},
): DroppedContribution {
  return {
    pluginKey,
    priority,
    reason: 'budget-exceeded',
    estimatedTokens: 100,
    severity: priority > 80 ? 'critical' : priority > 50 ? 'warning' : 'info',
    ...overrides,
  };
}

function expectAssertionError(fn: () => void): ContextAssertionError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ContextAssertionError);
    const asErr = err as ContextAssertionError;
    expect(asErr.name).toBe('ContextAssertionError');
    return asErr;
  }
  throw new Error('expected function to throw ContextAssertionError');
}

// ─────────────────────────────────────────────────────────────────────────────
// assertContextIncludes
// ─────────────────────────────────────────────────────────────────────────────

describe('assertContextIncludes — plugins', () => {
  it('passes when all expected plugins contributed tools', () => {
    const ctx = makeContext({
      tools: [tool('login', 'auth'), tool('query', 'search')],
    });
    expect(() =>
      assertContextIncludes(ctx, { plugins: ['auth', 'search'] }),
    ).not.toThrow();
  });

  it('throws when an expected plugin did not contribute a tool', () => {
    const ctx = makeContext({ tools: [tool('login', 'auth')] });
    const err = expectAssertionError(() =>
      assertContextIncludes(ctx, { plugins: ['auth', 'search', 'memory'] }),
    );
    expect(err.message).toContain('Missing expected plugins');
    expect(err.message).toContain('expected:');
    expect(err.message).toContain('actual:');
    expect(err.message).toContain('missing:');
    expect(err.message).toContain('search');
    expect(err.message).toContain('memory');
  });

  it('ignores plugins that only contributed a systemPrompt (no tools)', () => {
    // Documents the deliberate limitation: AssembledContext does not attribute
    // systemPrompt fragments per plugin, so `plugins` can only see tool
    // contributors. Guard against accidentally "fixing" this without also
    // adding proper prompt attribution in AssembledContext.
    const ctx = makeContext({
      systemPrompt: 'some prompt from prompt-only-plugin',
      tools: [],
    });
    expect(() =>
      assertContextIncludes(ctx, { plugins: ['prompt-only-plugin'] }),
    ).toThrow(ContextAssertionError);
  });
});

describe('assertContextIncludes — tools', () => {
  it('passes when all expected tools are present', () => {
    const ctx = makeContext({
      tools: [tool('login', 'auth'), tool('query', 'search')],
    });
    expect(() =>
      assertContextIncludes(ctx, { tools: ['login', 'query'] }),
    ).not.toThrow();
  });

  it('throws when an expected tool is missing', () => {
    const ctx = makeContext({ tools: [tool('login', 'auth')] });
    const err = expectAssertionError(() =>
      assertContextIncludes(ctx, { tools: ['login', 'query'] }),
    );
    expect(err.message).toContain('Missing expected tools');
    expect(err.message).toContain('query');
  });
});

describe('assertContextIncludes — minTokenUtilization (ratio)', () => {
  it('passes when totalTokens meets the required ratio floor', () => {
    const ctx = makeContext({ totalTokens: 3300 });
    expect(() =>
      assertContextIncludes(ctx, {
        minTokenUtilization: { ratio: 0.8, maxTokens: 4096 },
      }),
    ).not.toThrow();
  });

  it('throws when totalTokens is below the ratio floor', () => {
    const ctx = makeContext({ totalTokens: 1200 });
    const err = expectAssertionError(() =>
      assertContextIncludes(ctx, {
        minTokenUtilization: { ratio: 0.8, maxTokens: 4096 },
      }),
    );
    expect(err.message).toContain('Token utilization below required floor');
    expect(err.message).toContain('required:');
    expect(err.message).toContain('actual:');
    expect(err.message).toContain('deficit:');
    expect(err.message).toContain('1200');
    expect(err.message).toContain('4096');
  });

  it('passes at the exact boundary (totalTokens === required)', () => {
    // ceil(0.8 * 4096) = 3277
    const ctx = makeContext({ totalTokens: 3277 });
    expect(() =>
      assertContextIncludes(ctx, {
        minTokenUtilization: { ratio: 0.8, maxTokens: 4096 },
      }),
    ).not.toThrow();
  });

  it.each([0, -0.1, 1.5, Number.NaN])(
    'throws on invalid ratio %p',
    (ratio) => {
      const ctx = makeContext();
      expect(() =>
        assertContextIncludes(ctx, {
          minTokenUtilization: { ratio, maxTokens: 4096 },
        }),
      ).toThrow(ContextAssertionError);
    },
  );

  it.each([0, -5])('throws on invalid maxTokens %p', (maxTokens) => {
    const ctx = makeContext();
    expect(() =>
      assertContextIncludes(ctx, {
        minTokenUtilization: { ratio: 0.5, maxTokens },
      }),
    ).toThrow(ContextAssertionError);
  });
});

describe('assertContextIncludes — minTokenUtilization (absolute)', () => {
  it('passes when totalTokens meets the absolute floor', () => {
    const ctx = makeContext({ totalTokens: 500 });
    expect(() =>
      assertContextIncludes(ctx, {
        minTokenUtilization: { minTokens: 500 },
      }),
    ).not.toThrow();
  });

  it('throws when totalTokens is below the absolute floor', () => {
    const ctx = makeContext({ totalTokens: 100 });
    const err = expectAssertionError(() =>
      assertContextIncludes(ctx, {
        minTokenUtilization: { minTokens: 500 },
      }),
    );
    expect(err.message).toContain('Token utilization below required floor');
    expect(err.message).toContain('500');
    expect(err.message).toContain('100');
  });

  it('throws on negative minTokens', () => {
    const ctx = makeContext();
    expect(() =>
      assertContextIncludes(ctx, {
        minTokenUtilization: { minTokens: -1 },
      }),
    ).toThrow(ContextAssertionError);
  });
});

describe('assertContextIncludes — combinations', () => {
  it('passes when plugins + tools + ratio utilization all satisfied', () => {
    const ctx = makeContext({
      tools: [tool('login', 'auth'), tool('query', 'search')],
      totalTokens: 3500,
    });
    expect(() =>
      assertContextIncludes(ctx, {
        plugins: ['auth', 'search'],
        tools: ['login', 'query'],
        minTokenUtilization: { ratio: 0.8, maxTokens: 4096 },
      }),
    ).not.toThrow();
  });

  it('aggregates plugins + tools + utilization failures into a single error', () => {
    const ctx = makeContext({
      tools: [tool('login', 'auth')],
      totalTokens: 1200,
    });
    const err = expectAssertionError(() =>
      assertContextIncludes(ctx, {
        plugins: ['auth', 'search', 'memory'],
        tools: ['login', 'query'],
        minTokenUtilization: { ratio: 0.8, maxTokens: 4096 },
      }),
    );
    expect(err.message).toContain('Missing expected plugins');
    expect(err.message).toContain('Missing expected tools');
    expect(err.message).toContain('Token utilization below required floor');
    expect(err.details).toHaveProperty('plugins');
    expect(err.details).toHaveProperty('tools');
    expect(err.details).toHaveProperty('utilization');
  });

  it('attaches structured details.plugins.missing on plugin failures', () => {
    const ctx = makeContext({ tools: [tool('login', 'auth')] });
    const err = expectAssertionError(() =>
      assertContextIncludes(ctx, { plugins: ['auth', 'search'] }),
    );
    const details = err.details as {
      plugins: { expected: string[]; actual: string[]; missing: string[] };
    };
    expect(details.plugins.missing).toEqual(['search']);
    expect(details.plugins.expected).toEqual(['auth', 'search']);
    expect(details.plugins.actual).toContain('auth');
  });

  it('attaches structured details.utilization on utilization failures', () => {
    const ctx = makeContext({ totalTokens: 1000 });
    const err = expectAssertionError(() =>
      assertContextIncludes(ctx, {
        minTokenUtilization: { ratio: 0.5, maxTokens: 4000 },
      }),
    );
    const details = err.details as {
      utilization: { required: number; actual: number; deficit: number };
    };
    expect(details.utilization.required).toBe(2000);
    expect(details.utilization.actual).toBe(1000);
    expect(details.utilization.deficit).toBe(1000);
  });
});

describe('assertContextIncludes — empty options guard', () => {
  it('throws when called with no expectations', () => {
    const ctx = makeContext();
    const err = expectAssertionError(() => assertContextIncludes(ctx, {}));
    expect(err.message).toContain('no expectations');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// assertNoCriticalDrops
// ─────────────────────────────────────────────────────────────────────────────

describe('assertNoCriticalDrops', () => {
  it('passes when dropped is empty', () => {
    const ctx = makeContext();
    expect(() => assertNoCriticalDrops(ctx)).not.toThrow();
  });

  it('passes when the max dropped priority is exactly 80 (boundary)', () => {
    const ctx = makeContext({
      dropped: [drop('low', 50), drop('mid', 80)],
    });
    expect(() => assertNoCriticalDrops(ctx)).not.toThrow();
  });

  it('throws on a single drop at priority 81', () => {
    const ctx = makeContext({
      dropped: [
        drop('search', 81, { reason: 'atomic-no-fit', severity: 'warning' }),
      ],
    });
    const err = expectAssertionError(() => assertNoCriticalDrops(ctx));
    expect(err.message).toContain('assertNoCriticalDrops failed');
    expect(err.message).toContain('search');
    expect(err.message).toContain('priority=81');
    expect(err.message).toContain('reason=atomic-no-fit');
    expect(err.message).toContain('severity=warning');
  });

  it('reports all high-priority drops sorted by priority desc', () => {
    const ctx = makeContext({
      dropped: [
        drop('low-a', 20),
        drop('search', 81, { severity: 'warning' }),
        drop('low-b', 50),
        drop('memory', 95, { severity: 'critical', estimatedTokens: 1200 }),
        drop('top', 100, { severity: 'critical' }),
      ],
    });
    const err = expectAssertionError(() => assertNoCriticalDrops(ctx));
    expect(err.message).toContain('3 drop(s) above threshold');
    // priority desc ordering
    const topIdx = err.message.indexOf('top');
    const memoryIdx = err.message.indexOf('memory');
    const searchIdx = err.message.indexOf('search');
    expect(topIdx).toBeGreaterThan(-1);
    expect(memoryIdx).toBeGreaterThan(topIdx);
    expect(searchIdx).toBeGreaterThan(memoryIdx);
    // low-priority drops never appear in the offender list
    expect(err.message).not.toContain('low-a');
    expect(err.message).not.toContain('low-b');
  });

  it('attaches offenders to err.details', () => {
    const ctx = makeContext({
      dropped: [drop('search', 95)],
    });
    const err = expectAssertionError(() => assertNoCriticalDrops(ctx));
    const details = err.details as {
      minPriority: number;
      offenders: DroppedContribution[];
    };
    expect(details.minPriority).toBe(80);
    expect(details.offenders).toHaveLength(1);
    expect(details.offenders[0]?.pluginKey).toBe('search');
    expect(details.offenders[0]?.priority).toBe(95);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// assertNoDropsAbovePriority
// ─────────────────────────────────────────────────────────────────────────────

describe('assertNoDropsAbovePriority', () => {
  it('passes when threshold is 0 and dropped is empty', () => {
    const ctx = makeContext();
    expect(() => assertNoDropsAbovePriority(ctx, 0)).not.toThrow();
  });

  it.each([0, 50, 80, 100])(
    'passes at exact boundary: drop at priority %p with minPriority %p',
    (priority) => {
      const ctx = makeContext({ dropped: [drop('p', priority)] });
      expect(() => assertNoDropsAbovePriority(ctx, priority)).not.toThrow();
    },
  );

  it.each([0, 50, 80, 100])(
    'fails at minPriority + 1: drop at priority %p+1',
    (minPriority) => {
      const ctx = makeContext({
        dropped: [drop('p', minPriority + 1)],
      });
      expect(() => assertNoDropsAbovePriority(ctx, minPriority)).toThrow(
        ContextAssertionError,
      );
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'throws on non-finite minPriority %p',
    (minPriority) => {
      const ctx = makeContext();
      expect(() => assertNoDropsAbovePriority(ctx, minPriority)).toThrow(
        ContextAssertionError,
      );
    },
  );

  it('orders offenders deterministically when priorities tie', () => {
    const ctx = makeContext({
      dropped: [drop('b', 90), drop('a', 90)],
    });
    const err = expectAssertionError(() =>
      assertNoDropsAbovePriority(ctx, 80),
    );
    // Sorted by priority desc, then pluginKey asc — so 'a' before 'b'
    const aIdx = err.message.indexOf(' a ');
    const bIdx = err.message.indexOf(' b ');
    expect(aIdx).toBeGreaterThan(-1);
    expect(bIdx).toBeGreaterThan(aIdx);
  });

  it('error message names the caller correctly', () => {
    const ctx = makeContext({ dropped: [drop('x', 99)] });
    const err = expectAssertionError(() =>
      assertNoDropsAbovePriority(ctx, 50),
    );
    expect(err.message).toContain('assertNoDropsAbovePriority(50) failed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// index.ts re-exports
// ─────────────────────────────────────────────────────────────────────────────
//
// NOTE: Verifying barrel re-exports would require `import * as testingIndex
// from './index.js'`, but `./index.js` transitively pulls in `test-broker.ts`
// → `broker.ts` → graph packages, which currently fails to resolve under a
// fresh `bun install` until the `core` package is built (a pre-existing
// workspace build-order issue unrelated to RHOD-019). Re-exports are instead
// verified at compile time via `bun run typecheck` — a missing export in
// `index.ts` will fail the strict build. See `index.ts` for the export list.
