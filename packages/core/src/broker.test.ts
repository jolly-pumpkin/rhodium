import { describe, it, expect } from 'bun:test';
import { createBroker } from './broker.js';
import {
  DuplicatePluginError,
  CircularDependencyError,
  CapabilityNotFoundError,
} from './errors.js';
import type {
  Broker,
  BrokerConfig,
  Plugin,
  PluginManifest,
  PluginContext,
  ContextContribution,
  RemainingBudget,
} from './types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makePlugin(key: string, overrides: Partial<Plugin> = {}): Plugin {
  const manifest: PluginManifest = {
    provides: overrides.manifest?.provides ?? [],
    needs: overrides.manifest?.needs ?? [],
    tools: overrides.manifest?.tools ?? [],
    ...(overrides.manifest?.tags !== undefined ? { tags: overrides.manifest.tags } : {}),
    ...(overrides.manifest?.description !== undefined ? { description: overrides.manifest.description } : {}),
  };
  const plugin: Plugin = {
    key,
    version: '1.0.0',
    manifest,
    ...(overrides.activate ? { activate: overrides.activate } : {}),
    ...(overrides.deactivate ? { deactivate: overrides.deactivate } : {}),
    ...(overrides.contributeContext ? { contributeContext: overrides.contributeContext } : {}),
    ...(overrides.onDependencyRemoved ? { onDependencyRemoved: overrides.onDependencyRemoved } : {}),
  };
  return plugin;
}

function makeBroker(config?: BrokerConfig): Broker {
  return createBroker(config);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Config defaults
// ─────────────────────────────────────────────────────────────────────────────

describe('createBroker — config defaults', () => {
  it('uses chars3 as the default token counter', () => {
    const broker = makeBroker();
    const ctx = broker.assembleContext({ tokenBudget: { maxTokens: 1000 } });
    expect(ctx.meta.tokenCounter).toBe('chars3');
  });

  it('accepts a custom token counter function', () => {
    const broker = makeBroker({ tokenCounter: () => 777 });
    const p = makePlugin('p', {
      contributeContext: () => ({
        pluginKey: 'p',
        priority: 50,
        systemPromptFragment: 'hello world',
      }),
    });
    broker.register(p);
    // activate so contributeContext runs
    return broker.activate().then(() => {
      const ctx = broker.assembleContext({ tokenBudget: { maxTokens: 100000 } });
      expect(ctx.totalTokens).toBe(777);
    });
  });

  it('returns an object that implements the full Broker interface', () => {
    const broker = makeBroker();
    expect(typeof broker.register).toBe('function');
    expect(typeof broker.unregister).toBe('function');
    expect(typeof broker.activate).toBe('function');
    expect(typeof broker.deactivate).toBe('function');
    expect(typeof broker.activatePlugin).toBe('function');
    expect(typeof broker.resolve).toBe('function');
    expect(typeof broker.resolveAll).toBe('function');
    expect(typeof broker.resolveOptional).toBe('function');
    expect(typeof broker.searchTools).toBe('function');
    expect(typeof broker.assembleContext).toBe('function');
    expect(typeof broker.on).toBe('function');
    expect(typeof broker.getLog).toBe('function');
    expect(typeof broker.getPluginStates).toBe('function');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. register()
// ─────────────────────────────────────────────────────────────────────────────

describe('createBroker — register()', () => {
  it('adds the plugin to registry, graph, and search index', () => {
    const broker = makeBroker();
    const p = makePlugin('alpha', {
      manifest: {
        provides: [],
        needs: [],
        tools: [{ name: 'search', description: 'search for things' }],
      },
    });
    broker.register(p);

    expect(broker.getPluginStates().get('alpha')).toBe('registered');

    const results = broker.searchTools('search');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.pluginKey).toBe('alpha');
    expect(results[0]!.isPluginActivated).toBe(false);
  });

  it('throws DuplicatePluginError when the same key is registered twice', () => {
    const broker = makeBroker();
    broker.register(makePlugin('dup'));
    expect(() => broker.register(makePlugin('dup'))).toThrow(DuplicatePluginError);
  });

  it('rolls back the registry when graph detects a cycle', () => {
    const broker = makeBroker();
    const a = makePlugin('a', {
      manifest: {
        provides: [{ capability: 'cap-a' }],
        needs: [{ capability: 'cap-b' }],
        tools: [{ name: 'tool-a', description: 'alpha tool' }],
      },
    });
    // `b` has a tool so the search-index rollback assertion actually has
    // something to miss — otherwise searchTools('unique-beta-tool') would
    // return an empty list regardless of whether rollback occurred.
    const b = makePlugin('b', {
      manifest: {
        provides: [{ capability: 'cap-b' }],
        needs: [{ capability: 'cap-a' }],
        tools: [{ name: 'unique-beta-tool', description: 'only in b' }],
      },
    });
    broker.register(a);

    let caught: unknown;
    try {
      broker.register(b);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CircularDependencyError);
    // The rewrap path should preserve the cycle plugin list on the error.
    expect((caught as CircularDependencyError).cycle).toContain('a');
    expect((caught as CircularDependencyError).cycle).toContain('b');

    // b must be fully cleaned up after the rollback
    expect(broker.getPluginStates().has('b')).toBe(false);
    // Search index rollback — `b`'s unique tool name must NOT appear in any
    // result. This only bites because `b` had a tool with a unique name;
    // without the rollback the search index would still contain it.
    for (const r of broker.searchTools('unique-beta-tool')) {
      expect(r.toolName).not.toBe('unique-beta-tool');
      expect(r.pluginKey).not.toBe('b');
    }
    // Generic search for 'b' also shouldn't return any b-owned results.
    for (const r of broker.searchTools({ query: 'b' })) {
      expect(r.pluginKey).not.toBe('b');
    }

    // `a` should still be registered and in the search index.
    expect(broker.getPluginStates().get('a')).toBe('registered');
    const aSearch = broker.searchTools('tool-a');
    expect(aSearch.some((r) => r.pluginKey === 'a')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. activate() / deactivate()
// ─────────────────────────────────────────────────────────────────────────────

describe('createBroker — activate() and deactivate()', () => {
  it('activates all registered plugins and returns an ActivationResult', async () => {
    const broker = makeBroker();
    const log: string[] = [];
    broker.register(makePlugin('p1', { activate: () => { log.push('p1'); } }));
    broker.register(makePlugin('p2', { activate: () => { log.push('p2'); } }));

    const result = await broker.activate();

    expect(result.activated.sort()).toEqual(['p1', 'p2']);
    expect(result.failed).toEqual([]);
    expect(broker.getPluginStates().get('p1')).toBe('active');
    expect(broker.getPluginStates().get('p2')).toBe('active');
    expect(log.length).toBe(2);
  });

  it('deactivates plugins and removes their capability implementations', async () => {
    const broker = makeBroker();
    const provider = makePlugin('provider', {
      manifest: {
        provides: [{ capability: 'greet' }],
        needs: [],
        tools: [],
      },
      activate(ctx: PluginContext) {
        ctx.provide('greet', { hello: () => 'hi' });
      },
    });
    broker.register(provider);
    await broker.activate();

    expect(broker.resolve<{ hello: () => string }>('greet').hello()).toBe('hi');

    await broker.deactivate();
    expect(() => broker.resolve('greet')).toThrow();
  });

  it('emits broker:activated through broker.on()', async () => {
    const broker = makeBroker();
    broker.register(makePlugin('x'));

    let fired = 0;
    let payload: { pluginCount: number; durationMs: number } | undefined;
    broker.on('broker:activated', (p) => {
      fired++;
      payload = p;
    });
    await broker.activate();
    expect(fired).toBe(1);
    expect(payload?.pluginCount).toBe(1);
  });

  it('activatePlugin() hot-registers a plugin after broker.activate()', async () => {
    const broker = makeBroker();
    // Initial broker.activate() with one registered plugin.
    let aCalls = 0;
    broker.register(
      makePlugin('a', { activate: () => { aCalls++; } }),
    );
    await broker.activate();
    expect(aCalls).toBe(1);
    expect(broker.getPluginStates().get('a')).toBe('active');

    // Hot-register a second plugin that depends on nothing and activate it.
    let bCalls = 0;
    broker.register(
      makePlugin('b', {
        manifest: {
          provides: [{ capability: 'late-cap' }],
          needs: [],
          tools: [],
        },
        activate(ctx: PluginContext) {
          bCalls++;
          ctx.provide('late-cap', { hello: () => 'late' });
        },
      }),
    );
    // Before hot activation, b is still `registered`.
    expect(broker.getPluginStates().get('b')).toBe('registered');

    await broker.activatePlugin('b');
    expect(bCalls).toBe(1);
    expect(broker.getPluginStates().get('b')).toBe('active');
    // Broker-level resolve now sees the hot-registered capability.
    expect(
      broker.resolve<{ hello: () => string }>('late-cap').hello(),
    ).toBe('late');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. resolve* delegation
// ─────────────────────────────────────────────────────────────────────────────

describe('createBroker — resolve / resolveAll / resolveOptional', () => {
  it('resolve() returns the provider implementation after activation', async () => {
    const broker = makeBroker();
    const provider = makePlugin('p', {
      manifest: { provides: [{ capability: 'cap' }], needs: [], tools: [] },
      activate(ctx: PluginContext) {
        ctx.provide('cap', { value: 42 });
      },
    });
    broker.register(provider);
    await broker.activate();
    expect(broker.resolve<{ value: number }>('cap').value).toBe(42);
  });

  it('resolveAll() returns providers sorted by priority descending', async () => {
    const broker = makeBroker();
    broker.register(makePlugin('low', {
      manifest: { provides: [{ capability: 'multi', priority: 5 }], needs: [], tools: [] },
      activate(ctx: PluginContext) { ctx.provide('multi', { tag: 'low' }); },
    }));
    broker.register(makePlugin('high', {
      manifest: { provides: [{ capability: 'multi', priority: 50 }], needs: [], tools: [] },
      activate(ctx: PluginContext) { ctx.provide('multi', { tag: 'high' }); },
    }));
    await broker.activate();
    const all = broker.resolveAll<{ tag: string }>('multi');
    expect(all.map((x) => x.tag)).toEqual(['high', 'low']);
  });

  it('resolveOptional() returns undefined for a missing capability', () => {
    const broker = makeBroker();
    expect(broker.resolveOptional('nothing')).toBeUndefined();
  });

  it('resolve() throws CapabilityNotFoundError when no provider exists', () => {
    const broker = makeBroker();
    expect(() => broker.resolve('missing')).toThrow(CapabilityNotFoundError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. searchTools()
// ─────────────────────────────────────────────────────────────────────────────

describe('createBroker — searchTools()', () => {
  it('returns tools from registered-but-inactive plugins (manifest-first)', () => {
    const broker = makeBroker();
    broker.register(makePlugin('searcher', {
      manifest: {
        provides: [],
        needs: [],
        tools: [{ name: 'find-files', description: 'find files by pattern', tags: ['io'] }],
      },
    }));
    const results = broker.searchTools('find');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.toolName).toBe('find-files');
    expect(results[0]!.isPluginActivated).toBe(false);
  });

  it('flips isPluginActivated to true after activate() and back on deactivate()', async () => {
    const broker = makeBroker();
    broker.register(makePlugin('t', {
      manifest: {
        provides: [],
        needs: [],
        tools: [{ name: 'alpha', description: 'alpha tool' }],
      },
    }));

    await broker.activate();
    let results = broker.searchTools('alpha');
    expect(results[0]?.isPluginActivated).toBe(true);

    await broker.deactivate();
    results = broker.searchTools('alpha');
    expect(results[0]?.isPluginActivated).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. assembleContext()
// ─────────────────────────────────────────────────────────────────────────────

describe('createBroker — assembleContext()', () => {
  it('returns an AssembledContext including active plugin contributions', async () => {
    const broker = makeBroker();
    broker.register(makePlugin('p', {
      contributeContext: (): ContextContribution => ({
        pluginKey: 'p',
        priority: 75,
        systemPromptFragment: 'You are a helpful agent.',
      }),
    }));
    await broker.activate();

    const ctx = broker.assembleContext({ tokenBudget: { maxTokens: 1000 } });
    expect(ctx.systemPrompt).toContain('helpful agent');
    expect(ctx.meta.contributingPlugins).toBe(1);
  });

  it('emits context:assembled via broker.on()', async () => {
    const broker = makeBroker();
    broker.register(makePlugin('p'));
    await broker.activate();

    let fired = 0;
    broker.on('context:assembled', () => { fired++; });
    broker.assembleContext({ tokenBudget: { maxTokens: 1000 } });
    expect(fired).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. getLog() and debug mode
// ─────────────────────────────────────────────────────────────────────────────

describe('createBroker — getLog() and structured logging', () => {
  it('collects entries for every emitted event by default', async () => {
    const broker = makeBroker();
    broker.register(makePlugin('foo'));
    await broker.activate();

    const log = broker.getLog();
    const events = log.entries.map((e) => e.event);
    expect(events).toContain('plugin:registered');
    expect(events).toContain('plugin:activating');
    expect(events).toContain('plugin:activated');
    expect(events).toContain('broker:activated');
  });

  it('filters by pluginKey', async () => {
    const broker = makeBroker();
    broker.register(makePlugin('foo'));
    broker.register(makePlugin('bar'));
    await broker.activate();

    const fooLog = broker.getLog({ pluginKey: 'foo' });
    for (const entry of fooLog.entries) {
      expect(entry.pluginKey).toBe('foo');
    }
    expect(fooLog.entries.length).toBeGreaterThan(0);
  });

  it('filters by event type', async () => {
    const broker = makeBroker();
    broker.register(makePlugin('foo'));
    await broker.activate();

    const log = broker.getLog({ event: 'plugin:activated' });
    expect(log.entries.every((e) => e.event === 'plugin:activated')).toBe(true);
    expect(log.entries.length).toBe(1);
  });

  it('filters by since (timestamp)', async () => {
    const broker = makeBroker();
    // Phase 1 — pre-cutoff events (registration). We then record a cutoff
    // AFTER waiting long enough that Date.now() will have advanced on any
    // platform, so the cutoff cleanly separates the two phases.
    broker.register(makePlugin('before'));
    await new Promise((r) => setTimeout(r, 5));
    const cutoff = Date.now();
    await new Promise((r) => setTimeout(r, 5));

    // Phase 2 — post-cutoff events.
    broker.register(makePlugin('after'));
    await broker.activate();

    const log = broker.getLog({ since: cutoff });
    // The filter must return a non-empty list — otherwise a bug that returns
    // nothing would make the per-entry assertion pass trivially.
    expect(log.entries.length).toBeGreaterThan(0);
    for (const entry of log.entries) {
      expect(entry.timestamp).toBeGreaterThanOrEqual(cutoff);
    }

    // The post-cutoff registration must appear; the pre-cutoff one must not.
    const keysAfter = new Set(
      log.entries
        .filter((e) => e.event === 'plugin:registered')
        .map((e) => e.pluginKey),
    );
    expect(keysAfter.has('after')).toBe(true);
    expect(keysAfter.has('before')).toBe(false);
  });

  it('returns a defensive copy of entries (mutation-safe)', () => {
    const broker = makeBroker();
    broker.register(makePlugin('foo'));
    const first = broker.getLog();
    expect(first.entries.length).toBeGreaterThan(0);

    // Mutating the returned array must not affect subsequent reads.
    first.entries.length = 0;
    first.entries.push({
      timestamp: 0,
      event: 'plugin:registered',
      pluginKey: 'forged',
    });

    const second = broker.getLog();
    expect(second.entries.length).toBeGreaterThan(0);
    expect(second.entries.some((e) => e.pluginKey === 'forged')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. lazyActivation
// ─────────────────────────────────────────────────────────────────────────────

describe('createBroker — lazyActivation', () => {
  it('defers activation until assembleContext() is called (sync activate)', async () => {
    const broker = makeBroker({ lazyActivation: true });
    let activateCalls = 0;
    let contributeCalls = 0;
    const p = makePlugin('lazy', {
      activate: () => { activateCalls++; },
      contributeContext: (_req: unknown, _budget: RemainingBudget) => {
        contributeCalls++;
        return {
          pluginKey: 'lazy',
          priority: 50,
          systemPromptFragment: 'lazy says hi',
        };
      },
    });
    broker.register(p);

    const result = await broker.activate();
    expect(result.activated).toEqual([]);
    expect(activateCalls).toBe(0);
    expect(broker.getPluginStates().get('lazy')).toBe('registered');

    const ctx = broker.assembleContext({ tokenBudget: { maxTokens: 1000 } });
    expect(activateCalls).toBe(1);
    expect(contributeCalls).toBe(1);
    expect(ctx.systemPrompt).toContain('lazy says hi');
    expect(broker.getPluginStates().get('lazy')).toBe('active');
  });

  it('throws a descriptive error if a lazy plugin has an async activate()', () => {
    const broker = makeBroker({ lazyActivation: true });
    broker.register(makePlugin('async-lazy', {
      activate: async () => { /* nothing */ },
    }));
    expect(() => broker.assembleContext({ tokenBudget: { maxTokens: 1000 } })).toThrow(
      /lazyActivation/i,
    );
  });

  it('respects topological order when consumer is registered before provider', () => {
    // Regression test: `ensureLazilyActivated()` must walk plugins in
    // dep-before-dependent order. If it iterated in registration order, the
    // consumer's `ctx.resolve('shared')` inside activate() would fail because
    // the provider hadn't run `ctx.provide('shared', ...)` yet.
    const broker = makeBroker({ lazyActivation: true });
    const callOrder: string[] = [];

    // Register CONSUMER first, PROVIDER second — reversed from dep order.
    broker.register(
      makePlugin('consumer', {
        manifest: {
          provides: [],
          needs: [{ capability: 'shared' }],
          tools: [],
        },
        activate(ctx: PluginContext) {
          callOrder.push('consumer');
          const impl = ctx.resolve<{ value: number }>('shared');
          expect(impl.value).toBe(42);
        },
      }),
    );
    broker.register(
      makePlugin('provider', {
        manifest: {
          provides: [{ capability: 'shared' }],
          needs: [],
          tools: [],
        },
        activate(ctx: PluginContext) {
          callOrder.push('provider');
          ctx.provide('shared', { value: 42 });
        },
      }),
    );

    // Triggers lazy activation — provider must run before consumer even
    // though consumer was registered first.
    broker.assembleContext({ tokenBudget: { maxTokens: 1000 } });
    expect(callOrder).toEqual(['provider', 'consumer']);
    expect(broker.getPluginStates().get('provider')).toBe('active');
    expect(broker.getPluginStates().get('consumer')).toBe('active');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Two-broker isolation (ADR-009)
// ─────────────────────────────────────────────────────────────────────────────

describe('createBroker — two brokers in the same process are independent', () => {
  it('does not share registry, graph, or search index state across brokers', () => {
    const brokerA = makeBroker();
    const brokerB = makeBroker();
    brokerA.register(makePlugin('only-in-a', {
      manifest: {
        provides: [],
        needs: [],
        tools: [{ name: 'only-tool', description: 'only in a' }],
      },
    }));

    expect(brokerA.getPluginStates().size).toBe(1);
    expect(brokerB.getPluginStates().size).toBe(0);

    const aResults = brokerA.searchTools('only');
    const bResults = brokerB.searchTools('only');
    expect(aResults.length).toBeGreaterThan(0);
    expect(bResults.length).toBe(0);
  });

  it('delivers events only to subscribers of the broker that emitted them', async () => {
    const brokerA = makeBroker();
    const brokerB = makeBroker();
    let aFired = 0;
    let bFired = 0;
    brokerA.on('broker:activated', () => { aFired++; });
    brokerB.on('broker:activated', () => { bFired++; });
    await brokerA.activate();
    expect(aFired).toBe(1);
    expect(bFired).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. End-to-end: provider + consumer wired via a capability
// ─────────────────────────────────────────────────────────────────────────────

describe('createBroker — end-to-end provider/consumer', () => {
  it('activates provider then consumer and resolves capabilities across both', async () => {
    const broker = makeBroker();

    const calls: string[] = [];

    const provider = makePlugin('provider', {
      manifest: {
        provides: [{ capability: 'greeter' }],
        needs: [],
        tools: [],
      },
      activate(ctx: PluginContext) {
        calls.push('provider.activate');
        ctx.provide('greeter', { greet: (name: string) => `hello, ${name}` });
      },
      contributeContext: (): ContextContribution => ({
        pluginKey: 'provider',
        priority: 80,
        systemPromptFragment: 'Provider says: I am online.',
      }),
    });

    const consumer = makePlugin('consumer', {
      manifest: {
        provides: [],
        needs: [{ capability: 'greeter' }],
        tools: [],
      },
      activate(ctx: PluginContext) {
        calls.push('consumer.activate');
        const greeter = ctx.resolve<{ greet: (n: string) => string }>('greeter');
        calls.push(greeter.greet('world'));
      },
      contributeContext: (): ContextContribution => ({
        pluginKey: 'consumer',
        priority: 40,
        systemPromptFragment: 'Consumer says: I read context.',
      }),
    });

    broker.register(provider);
    broker.register(consumer);
    const result = await broker.activate();

    expect(result.activated).toEqual(['provider', 'consumer']);
    expect(calls).toEqual([
      'provider.activate',
      'consumer.activate',
      'hello, world',
    ]);

    // broker-level resolve should reach the same implementation
    const greeter = broker.resolve<{ greet: (n: string) => string }>('greeter');
    expect(greeter.greet('broker')).toBe('hello, broker');

    // assembled context should include both contributions in priority order
    const ctx = broker.assembleContext({ tokenBudget: { maxTokens: 10_000 } });
    expect(ctx.systemPrompt).toContain('I am online');
    expect(ctx.systemPrompt).toContain('I read context');
    expect(ctx.systemPrompt.indexOf('I am online')).toBeLessThan(
      ctx.systemPrompt.indexOf('I read context'),
    );
    expect(ctx.meta.contributingPlugins).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. unregister() wiring
// ─────────────────────────────────────────────────────────────────────────────

describe('createBroker — unregister()', () => {
  it('removes the plugin from registry, graph, resolver, and search index', async () => {
    const broker = makeBroker();
    broker.register(makePlugin('temp', {
      manifest: {
        provides: [{ capability: 'gone' }],
        needs: [],
        tools: [{ name: 'temp-tool', description: 'temporary tool' }],
      },
      activate(ctx: PluginContext) {
        ctx.provide('gone', { x: 1 });
      },
    }));
    await broker.activate();
    expect(broker.resolveOptional<{ x: number }>('gone')?.x).toBe(1);

    await broker.unregister('temp');

    expect(broker.getPluginStates().has('temp')).toBe(false);
    expect(broker.resolveOptional('gone')).toBeUndefined();
    const results = broker.searchTools('temp-tool');
    expect(results.find((r) => r.pluginKey === 'temp')).toBeUndefined();
  });

  it('calls onDependencyRemoved on dependents before teardown', async () => {
    const broker = makeBroker();
    const removedCapabilities: string[] = [];

    broker.register(makePlugin('provider', {
      manifest: { provides: [{ capability: 'dep' }], needs: [], tools: [] },
      activate(ctx: PluginContext) { ctx.provide('dep', {}); },
    }));
    broker.register(makePlugin('dependent', {
      manifest: { provides: [], needs: [{ capability: 'dep' }], tools: [] },
      onDependencyRemoved(cap: string) { removedCapabilities.push(cap); },
    }));
    await broker.activate();

    await broker.unregister('provider');
    expect(removedCapabilities).toEqual(['dep']);
  });
});
