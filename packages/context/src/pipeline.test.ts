import { describe, it, expect } from 'bun:test';
import { createPipeline } from './pipeline.js';
import type { Plugin, TokenBudgetConfig } from '../../core/src/types.js';
import type { MiddlewarePlugin } from './types.js';
import { createSearchIndex } from '../../discovery/src/index-builder.js';

// ─── helpers ────────────────────────────────────────────────────────────────

function makePlugin(overrides: Partial<Plugin> & { key: string }): Plugin {
  return {
    version: '1.0.0',
    manifest: { provides: [], needs: [], tools: [] },
    ...overrides,
  };
}

function makeEventBus() {
  const emitted: Array<{ event: string; payload: unknown }> = [];
  return {
    emit: (event: string, payload: unknown) => { emitted.push({ event, payload }); },
    emitted,
  };
}

// With chars4 default (ADR-004): 'high priority content that takes tokens'=38chars=ceil(38/4)=10tok
// maxTokens:10 → high fills exactly, remaining=0, low='low priority content'=20chars=5tok dropped
const TIGHT_BUDGET: TokenBudgetConfig = { maxTokens: 10 };
const GENEROUS_BUDGET: TokenBudgetConfig = { maxTokens: 100_000 };

// ─── tests ──────────────────────────────────────────────────────────────────

describe('createPipeline — empty plugin list', () => {
  it('returns a valid AssembledContext with no plugins', () => {
    const { assembleContext } = createPipeline({
      getActivePlugins: () => [],
      eventBus: makeEventBus(),
      getMiddlewares: () => [],
    });

    const result = assembleContext();

    expect(result.systemPrompt).toBe('');
    expect(result.tools).toEqual([]);
    expect(result.totalTokens).toBe(0); // empty prompt + no tools → 0
    expect(result.dropped).toEqual([]);
    expect(result.meta.totalPlugins).toBe(0);
    expect(result.meta.contributingPlugins).toBe(0);
    expect(result.meta.droppedPlugins).toBe(0);
  });
});

describe('createPipeline — collect stage', () => {
  it('collects contributions from active plugins', () => {
    const plugin = makePlugin({
      key: 'a',
      contributeContext: () => ({
        pluginKey: 'a',
        priority: 50,
        systemPromptFragment: 'hello from a',
      }),
    });

    const { assembleContext } = createPipeline({
      getActivePlugins: () => [plugin],
      eventBus: makeEventBus(),
      getMiddlewares: () => [],
      defaultTokenBudget: GENEROUS_BUDGET,
    });

    const result = assembleContext();
    expect(result.systemPrompt).toContain('hello from a');
    expect(result.meta.contributingPlugins).toBe(1);
  });

  it('skips plugins with no contributeContext hook', () => {
    const plugin = makePlugin({ key: 'a' }); // no contributeContext

    const { assembleContext } = createPipeline({
      getActivePlugins: () => [plugin],
      eventBus: makeEventBus(),
      getMiddlewares: () => [],
      defaultTokenBudget: GENEROUS_BUDGET,
    });

    const result = assembleContext();
    expect(result.systemPrompt).toBe('');
    expect(result.meta.contributingPlugins).toBe(0);
    expect(result.dropped).toEqual([]);
  });

  it('treats null return from contributeContext as opt-out (not a drop)', () => {
    const plugin = makePlugin({
      key: 'a',
      contributeContext: () => null,
    });

    const { assembleContext } = createPipeline({
      getActivePlugins: () => [plugin],
      eventBus: makeEventBus(),
      getMiddlewares: () => [],
      defaultTokenBudget: GENEROUS_BUDGET,
    });

    const result = assembleContext();
    expect(result.dropped).toEqual([]);
    expect(result.meta.contributingPlugins).toBe(0);
  });

  it('error boundary: contributeContext throw skips plugin, others unaffected', () => {
    const bad = makePlugin({
      key: 'bad',
      contributeContext: () => { throw new Error('boom'); },
    });
    const good = makePlugin({
      key: 'good',
      contributeContext: () => ({
        pluginKey: 'good',
        priority: 50,
        systemPromptFragment: 'from good',
      }),
    });

    const bus = makeEventBus();
    const { assembleContext } = createPipeline({
      getActivePlugins: () => [bad, good],
      eventBus: bus,
      getMiddlewares: () => [],
      defaultTokenBudget: GENEROUS_BUDGET,
    });

    const result = assembleContext();
    expect(result.systemPrompt).toContain('from good');
    expect(result.dropped.some(d => d.pluginKey === 'bad' && d.reason === 'error')).toBe(true);
    expect(bus.emitted.some(e => e.event === 'plugin:error')).toBe(true);
  });

  it('filters plugins by includePlugins', () => {
    const a = makePlugin({ key: 'a', contributeContext: () => ({ pluginKey: 'a', priority: 50, systemPromptFragment: 'A' }) });
    const b = makePlugin({ key: 'b', contributeContext: () => ({ pluginKey: 'b', priority: 50, systemPromptFragment: 'B' }) });

    const { assembleContext } = createPipeline({
      getActivePlugins: () => [a, b],
      eventBus: makeEventBus(),
      getMiddlewares: () => [],
      defaultTokenBudget: GENEROUS_BUDGET,
    });

    const result = assembleContext({ includePlugins: ['a'] });
    expect(result.systemPrompt).toContain('A');
    expect(result.systemPrompt).not.toContain('B');
  });

  it('filters plugins by excludePlugins', () => {
    const a = makePlugin({ key: 'a', contributeContext: () => ({ pluginKey: 'a', priority: 50, systemPromptFragment: 'A' }) });
    const b = makePlugin({ key: 'b', contributeContext: () => ({ pluginKey: 'b', priority: 50, systemPromptFragment: 'B' }) });

    const { assembleContext } = createPipeline({
      getActivePlugins: () => [a, b],
      eventBus: makeEventBus(),
      getMiddlewares: () => [],
      defaultTokenBudget: GENEROUS_BUDGET,
    });

    const result = assembleContext({ excludePlugins: ['b'] });
    expect(result.systemPrompt).toContain('A');
    expect(result.systemPrompt).not.toContain('B');
  });
});

describe('createPipeline — tool merge (Stage 1)', () => {
  it('uses manifest tools as baseline', () => {
    const plugin = makePlugin({
      key: 'a',
      manifest: { provides: [], needs: [], tools: [{ name: 'search', description: 'manifest search' }] },
      contributeContext: () => ({ pluginKey: 'a', priority: 50 }),
    });

    const { assembleContext } = createPipeline({
      getActivePlugins: () => [plugin],
      eventBus: makeEventBus(),
      getMiddlewares: () => [],
      defaultTokenBudget: GENEROUS_BUDGET,
    });

    const result = assembleContext();
    expect(result.tools.find(t => t.name === 'search')?.description).toBe('manifest search');
  });

  it('runtime tool overrides manifest tool with same name', () => {
    const plugin = makePlugin({
      key: 'a',
      manifest: { provides: [], needs: [], tools: [{ name: 'search', description: 'old desc' }] },
      contributeContext: () => ({
        pluginKey: 'a',
        priority: 50,
        tools: [{ name: 'search', description: 'new desc' }],
      }),
    });

    const { assembleContext } = createPipeline({
      getActivePlugins: () => [plugin],
      eventBus: makeEventBus(),
      getMiddlewares: () => [],
      defaultTokenBudget: GENEROUS_BUDGET,
    });

    const result = assembleContext();
    const tool = result.tools.find(t => t.name === 'search');
    expect(tool?.description).toBe('new desc');
    expect(result.tools.filter(t => t.name === 'search')).toHaveLength(1);
  });

  it('new runtime tool name is appended', () => {
    const plugin = makePlugin({
      key: 'a',
      manifest: { provides: [], needs: [], tools: [{ name: 'search', description: 'search' }] },
      contributeContext: () => ({
        pluginKey: 'a',
        priority: 50,
        tools: [{ name: 'create', description: 'create' }],
      }),
    });

    const { assembleContext } = createPipeline({
      getActivePlugins: () => [plugin],
      eventBus: makeEventBus(),
      getMiddlewares: () => [],
      defaultTokenBudget: GENEROUS_BUDGET,
    });

    const result = assembleContext();
    expect(result.tools.map(t => t.name)).toContain('search');
    expect(result.tools.map(t => t.name)).toContain('create');
  });

  it('example dedup by scenario: runtime example wins over manifest', () => {
    const plugin = makePlugin({
      key: 'a',
      manifest: {
        provides: [], needs: [],
        tools: [{
          name: 'search',
          description: 'search',
          examples: [{ scenario: 'basic', input: {}, output: 'manifest-output' }],
        }],
      },
      contributeContext: () => ({
        pluginKey: 'a',
        priority: 50,
        tools: [{
          name: 'search',
          description: 'search',
          examples: [{ scenario: 'basic', input: {}, output: 'runtime-output' }],
        }],
      }),
    });

    const { assembleContext } = createPipeline({
      getActivePlugins: () => [plugin],
      eventBus: makeEventBus(),
      getMiddlewares: () => [],
      defaultTokenBudget: GENEROUS_BUDGET,
    });

    const result = assembleContext();
    const tool = result.tools.find(t => t.name === 'search');
    const basicExamples = tool?.examples?.filter(e => e.scenario === 'basic') ?? [];
    expect(basicExamples).toHaveLength(1);
    expect(basicExamples[0].output).toBe('runtime-output');
  });
});

describe('createPipeline — budget stage (Stage 3)', () => {
  it('drops low-priority plugin when budget is tight', () => {
    const high = makePlugin({
      key: 'high',
      contributeContext: () => ({
        pluginKey: 'high',
        priority: 90,
        systemPromptFragment: 'high priority content that takes tokens',
      }),
    });
    const low = makePlugin({
      key: 'low',
      contributeContext: () => ({
        pluginKey: 'low',
        priority: 10,
        systemPromptFragment: 'low priority content',
      }),
    });

    const { assembleContext } = createPipeline({
      getActivePlugins: () => [high, low],
      eventBus: makeEventBus(),
      getMiddlewares: () => [],
      defaultTokenBudget: TIGHT_BUDGET,
    });

    const result = assembleContext();
    expect(result.dropped.some(d => d.pluginKey === 'low')).toBe(true);
    expect(result.meta.droppedPlugins).toBeGreaterThan(0);
  });

  it('atomic plugin is dropped entirely if it does not fit', () => {
    const plugin = makePlugin({
      key: 'atomic',
      contributeContext: () => ({
        pluginKey: 'atomic',
        priority: 50,
        atomic: true,
        systemPromptFragment: 'this is a very long atomic contribution that definitely exceeds a tight budget',
      }),
    });

    const { assembleContext } = createPipeline({
      getActivePlugins: () => [plugin],
      eventBus: makeEventBus(),
      getMiddlewares: () => [],
      defaultTokenBudget: { maxTokens: 5 },
    });

    const result = assembleContext();
    // Allocator uses 'atomic-no-fit' as the reason string for atomic drops
    expect(result.dropped.some(d => d.pluginKey === 'atomic' && d.reason === 'atomic-no-fit')).toBe(true);
  });

  it('request tokenBudget overrides defaultTokenBudget', () => {
    const plugin = makePlugin({
      key: 'a',
      contributeContext: () => ({
        pluginKey: 'a',
        priority: 50,
        systemPromptFragment: 'some content',
      }),
    });

    const { assembleContext } = createPipeline({
      getActivePlugins: () => [plugin],
      eventBus: makeEventBus(),
      getMiddlewares: () => [],
      defaultTokenBudget: { maxTokens: 1 }, // would drop if used
    });

    // Override with generous budget in request
    const result = assembleContext({ tokenBudget: GENEROUS_BUDGET });
    expect(result.dropped).toEqual([]);
    expect(result.systemPrompt).toContain('some content');
  });
});

describe('createPipeline — discover stage (Stage 4)', () => {
  it('includes all surviving tools when no query', () => {
    const plugin = makePlugin({
      key: 'a',
      manifest: { provides: [], needs: [], tools: [{ name: 'search', description: 'search the web', tags: ['web'] }] },
      contributeContext: () => ({ pluginKey: 'a', priority: 50 }),
    });

    const index = createSearchIndex();
    index.addPlugin('a', plugin.manifest);

    const { assembleContext } = createPipeline({
      getActivePlugins: () => [plugin],
      eventBus: makeEventBus(),
      getMiddlewares: () => [],
      searchIndex: index,
      defaultTokenBudget: GENEROUS_BUDGET,
    });

    const result = assembleContext(); // no query
    expect(result.tools.map(t => t.name)).toContain('search');
  });

  it('filters tools to search results when query is present', () => {
    const pluginA = makePlugin({
      key: 'a',
      manifest: { provides: [], needs: [], tools: [{ name: 'web-search', description: 'search the web for information' }] },
      contributeContext: () => ({ pluginKey: 'a', priority: 50 }),
    });
    const pluginB = makePlugin({
      key: 'b',
      manifest: { provides: [], needs: [], tools: [{ name: 'file-read', description: 'read files from disk' }] },
      contributeContext: () => ({ pluginKey: 'b', priority: 50 }),
    });

    const index = createSearchIndex();
    index.addPlugin('a', pluginA.manifest);
    index.addPlugin('b', pluginB.manifest);

    const { assembleContext } = createPipeline({
      getActivePlugins: () => [pluginA, pluginB],
      eventBus: makeEventBus(),
      getMiddlewares: () => [],
      searchIndex: index,
      defaultTokenBudget: GENEROUS_BUDGET,
    });

    const result = assembleContext({ query: 'web search' });
    const toolNames = result.tools.map(t => t.name);
    expect(toolNames).toContain('web-search');
    expect(toolNames).not.toContain('file-read');
  });
});

describe('createPipeline — middleware stage (Stage 5)', () => {
  it('postAssembly middleware runs and can mutate context', () => {
    const plugin = makePlugin({
      key: 'a',
      contributeContext: () => ({ pluginKey: 'a', priority: 50, systemPromptFragment: 'original' }),
    });

    const middleware: MiddlewarePlugin = {
      postAssembly: (ctx) => ({ ...ctx, systemPrompt: ctx.systemPrompt + '\nappended by middleware' }),
    };

    const { assembleContext } = createPipeline({
      getActivePlugins: () => [plugin],
      eventBus: makeEventBus(),
      getMiddlewares: () => [middleware],
      defaultTokenBudget: GENEROUS_BUDGET,
    });

    const result = assembleContext();
    expect(result.systemPrompt).toContain('appended by middleware');
  });

  it('multiple middleware run in order (second sees first output)', () => {
    const plugin = makePlugin({
      key: 'a',
      contributeContext: () => ({ pluginKey: 'a', priority: 50, systemPromptFragment: 'base' }),
    });

    const order: string[] = [];
    const mw1: MiddlewarePlugin = {
      postAssembly: (ctx) => { order.push('mw1'); return { ...ctx, systemPrompt: ctx.systemPrompt + ':mw1' }; },
    };
    const mw2: MiddlewarePlugin = {
      postAssembly: (ctx) => { order.push('mw2'); return { ...ctx, systemPrompt: ctx.systemPrompt + ':mw2' }; },
    };

    const { assembleContext } = createPipeline({
      getActivePlugins: () => [plugin],
      eventBus: makeEventBus(),
      getMiddlewares: () => [mw1, mw2],
      defaultTokenBudget: GENEROUS_BUDGET,
    });

    const result = assembleContext();
    expect(order).toEqual(['mw1', 'mw2']);
    expect(result.systemPrompt).toContain(':mw1:mw2');
  });

  it('all 6 stages run: middleware sees tools after budget filtering', () => {
    const plugin = makePlugin({
      key: 'a',
      contributeContext: () => ({
        pluginKey: 'a',
        priority: 50,
        systemPromptFragment: 'content',
        tools: [{ name: 'my-tool', description: 'a tool' }],
      }),
    });

    let middlewareSawTools: string[] = [];
    const middleware: MiddlewarePlugin = {
      postAssembly: (ctx) => { middlewareSawTools = ctx.tools.map(t => t.name); return ctx; },
    };

    const { assembleContext } = createPipeline({
      getActivePlugins: () => [plugin],
      eventBus: makeEventBus(),
      getMiddlewares: () => [middleware],
      defaultTokenBudget: GENEROUS_BUDGET,
    });

    assembleContext();
    expect(middlewareSawTools).toContain('my-tool');
  });
});

describe('createPipeline — serialize stage (Stage 6)', () => {
  it('emits context:assembled event with correct payload shape', () => {
    const bus = makeEventBus();
    const plugin = makePlugin({
      key: 'a',
      contributeContext: () => ({ pluginKey: 'a', priority: 50, systemPromptFragment: 'hello' }),
    });

    const { assembleContext } = createPipeline({
      getActivePlugins: () => [plugin],
      eventBus: bus,
      getMiddlewares: () => [],
      defaultTokenBudget: GENEROUS_BUDGET,
    });

    assembleContext();

    const ev = bus.emitted.find(e => e.event === 'context:assembled');
    expect(ev).toBeDefined();
    const payload = ev!.payload as { totalTokens: number; droppedCount: number; durationMs: number };
    expect(typeof payload.totalTokens).toBe('number');
    expect(typeof payload.droppedCount).toBe('number');
    expect(typeof payload.durationMs).toBe('number');
  });

  it('meta.totalPlugins counts plugins before includePlugins filter', () => {
    const a = makePlugin({ key: 'a', contributeContext: () => ({ pluginKey: 'a', priority: 50, systemPromptFragment: 'A' }) });
    const b = makePlugin({ key: 'b', contributeContext: () => ({ pluginKey: 'b', priority: 50, systemPromptFragment: 'B' }) });

    const { assembleContext } = createPipeline({
      getActivePlugins: () => [a, b],
      eventBus: makeEventBus(),
      getMiddlewares: () => [],
      defaultTokenBudget: GENEROUS_BUDGET,
    });

    const result = assembleContext({ includePlugins: ['a'] });
    expect(result.meta.totalPlugins).toBe(2); // both, before filter
    expect(result.meta.contributingPlugins).toBe(1); // only 'a'
  });
});

describe('createPipeline — oversized contribution handling', () => {
  it('drops plugin gracefully when contribution exceeds maxContributionBytes, others continue', () => {
    const oversized = makePlugin({
      key: 'big',
      contributeContext: () => ({
        pluginKey: 'big',
        priority: 50,
        systemPromptFragment: 'x'.repeat(300), // 300 bytes > 200 byte limit
      }),
    });
    const normal = makePlugin({
      key: 'normal',
      contributeContext: () => ({
        pluginKey: 'normal',
        priority: 50,
        systemPromptFragment: 'from normal',
      }),
    });

    const { assembleContext } = createPipeline({
      getActivePlugins: () => [oversized, normal],
      eventBus: makeEventBus(),
      getMiddlewares: () => [],
      defaultTokenBudget: GENEROUS_BUDGET,
      maxContributionBytes: 200, // smaller limit to trigger rejection
    });

    const result = assembleContext();
    expect(result.systemPrompt).toContain('from normal');
    expect(result.systemPrompt).not.toContain('x'.repeat(10));
    expect(result.dropped.some(d => d.pluginKey === 'big' && d.reason === 'budget-exceeded')).toBe(true);
  });
});

describe('createPipeline — performance', () => {
  it('assembleContext completes in < 5ms for 20 plugins', () => {
    const plugins: Plugin[] = Array.from({ length: 20 }, (_, i) => makePlugin({
      key: `plugin-${i}`,
      manifest: {
        provides: [], needs: [],
        tools: [{ name: `tool-${i}`, description: `tool number ${i} does something useful` }],
      },
      contributeContext: () => ({
        pluginKey: `plugin-${i}`,
        priority: i,
        systemPromptFragment: `Context fragment from plugin ${i} with some content to make it realistic.`,
      }),
    }));

    const { assembleContext } = createPipeline({
      getActivePlugins: () => plugins,
      eventBus: makeEventBus(),
      getMiddlewares: () => [],
      defaultTokenBudget: { maxTokens: 100_000 },
    });

    const start = performance.now();
    assembleContext();
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(5);
  });
});

