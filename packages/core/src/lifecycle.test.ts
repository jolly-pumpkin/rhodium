import { describe, it, expect, beforeEach } from 'bun:test';
import { createLifecycleManager } from './lifecycle.js';
import { PluginRegistry } from './registry.js';
import { createDependencyGraph } from '../../../packages/graph/src/dag.js';
import { createCapabilityResolver } from '../../../packages/graph/src/resolver.js';
import { createEventBus } from './events.js';
import { ActivationTimeoutError, ActivationError } from './errors.js';
import type { Plugin, PluginManifest } from './types.js';
import type { LifecycleManagerOpts } from './lifecycle.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makePlugin(key: string, opts: Partial<Plugin> = {}): Plugin {
  const manifest: PluginManifest = {
    provides: opts.manifest?.provides ?? [],
    needs: opts.manifest?.needs ?? [],
    tools: opts.manifest?.tools ?? [],
  };
  return {
    key,
    version: '1.0.0',
    manifest,
    activate: opts.activate,
    deactivate: opts.deactivate,
  };
}

function makeLifecycleManager(
  opts: Partial<LifecycleManagerOpts> = {}
): { manager: ReturnType<typeof createLifecycleManager>; graph: any; registry: any; eventBus: any } {
  const graph = opts.graph ?? createDependencyGraph();
  const resolver = opts.resolver ?? createCapabilityResolver();
  const eventBus = opts.eventBus ?? createEventBus();
  const registry =
    opts.registry ??
    new PluginRegistry((event, payload) => {
      eventBus.emit(event, payload);
    });

  const manager = createLifecycleManager({
    graph,
    resolver,
    eventBus,
    registry,
    timeoutMs: opts.timeoutMs ?? 1000,
    onUnhandledError: opts.onUnhandledError,
  });

  return { manager, graph, registry, eventBus };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('lifecycle: wave computation', () => {
  it('3 independent plugins → 1 wave', async () => {
    const { manager, graph, registry } = makeLifecycleManager();
    const plugins = ['a', 'b', 'c'].map((k) => makePlugin(k));
    plugins.forEach((p) => {
      registry.register(p);
      graph.addPlugin(p.key, [], []);
    });

    const result = await manager.activate();
    expect(result.activated.length).toBe(3);
    expect(result.failed.length).toBe(0);
    expect(result.pending.length).toBe(0);
  });

  it('A→B chain → 2 waves, A before B', async () => {
    const { manager, graph, registry } = makeLifecycleManager();

    const a = makePlugin('a', { manifest: { provides: [{ capability: 'cap-a' }] } });
    const b = makePlugin('b', { manifest: { needs: [{ capability: 'cap-a' }] } });

    [a, b].forEach((p) => registry.register(p));
    graph.addPlugin('a', ['cap-a'], []);
    graph.addPlugin('b', [], ['cap-a']);

    const result = await manager.activate();
    expect(result.activated.length).toBe(2);
    expect(result.activated[0]).toBe('a'); // a before b
    expect(result.activated[1]).toBe('b');
  });

  it('diamond A→{B,C}→D → 3 waves', async () => {
    const { manager, graph, registry } = makeLifecycleManager();

    const a = makePlugin('a', { manifest: { provides: [{ capability: 'cap-a' }] } });
    const b = makePlugin('b', {
      manifest: { provides: [{ capability: 'cap-b' }], needs: [{ capability: 'cap-a' }] },
    });
    const c = makePlugin('c', {
      manifest: { provides: [{ capability: 'cap-c' }], needs: [{ capability: 'cap-a' }] },
    });
    const d = makePlugin('d', {
      manifest: { needs: [{ capability: 'cap-b' }, { capability: 'cap-c' }] },
    });

    [a, b, c, d].forEach((p) => registry.register(p));
    graph.addPlugin('a', ['cap-a'], []);
    graph.addPlugin('b', ['cap-b'], ['cap-a']);
    graph.addPlugin('c', ['cap-c'], ['cap-a']);
    graph.addPlugin('d', [], ['cap-b', 'cap-c']);

    const result = await manager.activate();
    expect(result.activated.length).toBe(4);
  });
});

describe('lifecycle: activate() happy path', () => {
  it('no-op plugin (no activate hook) → activated', async () => {
    const { manager, graph, registry } = makeLifecycleManager();
    const plugin = makePlugin('test');
    registry.register(plugin);
    graph.addPlugin('test', [], []);

    const result = await manager.activate();
    expect(result.activated).toContain('test');
    expect(result.failed.length).toBe(0);
  });

  it('activated[] contains the plugin key', async () => {
    const { manager, graph, registry } = makeLifecycleManager();
    const plugin = makePlugin('my-plugin');
    registry.register(plugin);
    graph.addPlugin('my-plugin', [], []);

    const result = await manager.activate();
    expect(result.activated).toContain('my-plugin');
  });

  it('durationMs is a non-negative number', async () => {
    const { manager, graph, registry } = makeLifecycleManager();
    const plugin = makePlugin('test');
    registry.register(plugin);
    graph.addPlugin('test', [], []);

    const result = await manager.activate();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('events emitted: plugin:activating, plugin:activated, broker:activated', async () => {
    const { manager, graph, registry, eventBus } = makeLifecycleManager();
    const plugin = makePlugin('test');
    registry.register(plugin);
    graph.addPlugin('test', [], []);

    const events: string[] = [];
    eventBus.on('plugin:activating', () => events.push('activating'));
    eventBus.on('plugin:activated', () => events.push('activated'));
    eventBus.on('broker:activated', () => events.push('broker'));

    await manager.activate();
    expect(events).toContain('activating');
    expect(events).toContain('activated');
    expect(events).toContain('broker');
  });
});

describe('lifecycle: timeout enforcement', () => {
  it('plugin that never resolves → ActivationTimeoutError', async () => {
    const { manager, graph, registry } = makeLifecycleManager({ timeoutMs: 50 });
    const plugin = makePlugin('slow', {
      activate: () => new Promise(() => {}), // never resolves
    });
    registry.register(plugin);
    graph.addPlugin('slow', [], []);

    const result = await manager.activate();
    expect(result.failed.length).toBe(1);
    expect(result.failed[0].pluginKey).toBe('slow');
    expect(result.failed[0].error instanceof ActivationTimeoutError).toBe(true);
  });

  it('plugin that resolves before timeout → success', async () => {
    const { manager, graph, registry } = makeLifecycleManager({ timeoutMs: 5000 });
    const plugin = makePlugin('fast', {
      activate: () => Promise.resolve(),
    });
    registry.register(plugin);
    graph.addPlugin('fast', [], []);

    const result = await manager.activate();
    expect(result.activated).toContain('fast');
    expect(result.failed.length).toBe(0);
  });
});

describe('lifecycle: error boundary', () => {
  it('plugin A throws → failed contains A, others still activate', async () => {
    const { manager, graph, registry } = makeLifecycleManager();

    const a = makePlugin('a', {
      activate: () => {
        throw new Error('boom');
      },
    });
    const b = makePlugin('b');

    [a, b].forEach((p) => registry.register(p));
    graph.addPlugin('a', [], []);
    graph.addPlugin('b', [], []);

    const result = await manager.activate();
    expect(result.failed.length).toBe(1);
    expect(result.failed[0].pluginKey).toBe('a');
    expect(result.activated).toContain('b');
  });
});

describe('lifecycle: dependency failure handling', () => {
  it('B requires A; A fails → B in pending', async () => {
    const { manager, graph, registry } = makeLifecycleManager();

    const a = makePlugin('a', {
      manifest: { provides: [{ capability: 'cap-a' }] },
      activate: () => {
        throw new Error('a failed');
      },
    });
    const b = makePlugin('b', {
      manifest: { needs: [{ capability: 'cap-a' }] },
    });

    [a, b].forEach((p) => registry.register(p));
    graph.addPlugin('a', ['cap-a'], []);
    graph.addPlugin('b', [], ['cap-a']);

    const result = await manager.activate();
    expect(result.failed[0].pluginKey).toBe('a');
    expect(result.pending).toContain('b');
  });

  it('B requires A; no provider exists for A → B in pending', async () => {
    const { manager, graph, registry } = makeLifecycleManager();

    const b = makePlugin('b', {
      manifest: { needs: [{ capability: 'missing-cap' }] },
    });

    registry.register(b);
    graph.addPlugin('b', [], ['missing-cap']);

    const result = await manager.activate();
    expect(result.pending).toContain('b');
    expect(result.activated.length).toBe(0);
  });

  it('B optionally needs A; A fails → B activates', async () => {
    const { manager, graph, registry } = makeLifecycleManager();

    const a = makePlugin('a', {
      manifest: { provides: [{ capability: 'cap-a' }] },
      activate: () => {
        throw new Error('a failed');
      },
    });
    const b = makePlugin('b', {
      manifest: { needs: [{ capability: 'cap-a', optional: true }] },
    });

    [a, b].forEach((p) => registry.register(p));
    graph.addPlugin('a', ['cap-a'], []);
    graph.addPlugin('b', [], ['cap-a']);

    const result = await manager.activate();
    expect(result.failed[0].pluginKey).toBe('a');
    expect(result.activated).toContain('b');
  });

  it('B needs [A, A2]; A fails but A2 succeeds → B activates', async () => {
    const { manager, graph, registry } = makeLifecycleManager();

    const a = makePlugin('a', {
      manifest: { provides: [{ capability: 'cap-x' }] },
      activate: () => {
        throw new Error('a failed');
      },
    });
    const a2 = makePlugin('a2', {
      manifest: { provides: [{ capability: 'cap-x' }] },
    });
    const b = makePlugin('b', {
      manifest: { needs: [{ capability: 'cap-x' }] },
    });

    [a, a2, b].forEach((p) => registry.register(p));
    graph.addPlugin('a', ['cap-x'], []);
    graph.addPlugin('a2', ['cap-x'], []);
    graph.addPlugin('b', [], ['cap-x']);

    const result = await manager.activate();
    expect(result.activated).toContain('a2');
    expect(result.activated).toContain('b');
    expect(result.failed[0].pluginKey).toBe('a');
  });
});

describe('lifecycle: provide/resolve bridge', () => {
  it('provider calls ctx.provide(), consumer calls ctx.resolve() → same object', async () => {
    const { manager, graph, registry } = makeLifecycleManager();

    let consumerImpl: unknown;
    const provider = makePlugin('provider', {
      manifest: { provides: [{ capability: 'service' }] },
      activate: (ctx) => {
        ctx.provide('service', { method: 'hello' });
      },
    });
    const consumer = makePlugin('consumer', {
      manifest: { needs: [{ capability: 'service' }] },
      activate: (ctx) => {
        consumerImpl = ctx.resolve('service');
      },
    });

    [provider, consumer].forEach((p) => registry.register(p));
    graph.addPlugin('provider', ['service'], []);
    graph.addPlugin('consumer', [], ['service']);

    await manager.activate();
    expect(consumerImpl).toEqual({ method: 'hello' });
  });
});

describe('lifecycle: resolveAll', () => {
  it('returns all implementations sorted by priority', async () => {
    const { manager, graph, registry } = makeLifecycleManager();

    const p1 = makePlugin('p1', {
      manifest: { provides: [{ capability: 'svc', priority: 1 }] },
      activate: (ctx) => ctx.provide('svc', { name: 'low' }),
    });
    const p2 = makePlugin('p2', {
      manifest: { provides: [{ capability: 'svc', priority: 10 }] },
      activate: (ctx) => ctx.provide('svc', { name: 'high' }),
    });
    const consumer = makePlugin('consumer', {
      manifest: { needs: [{ capability: 'svc', multiple: true }] },
      activate: (ctx) => {
        const all = ctx.resolveAll('svc');
        expect(all.length).toBe(2);
        expect(all[0]).toEqual({ name: 'high' });
        expect(all[1]).toEqual({ name: 'low' });
      },
    });

    [p1, p2, consumer].forEach((p) => registry.register(p));
    graph.addPlugin('p1', ['svc'], []);
    graph.addPlugin('p2', ['svc'], []);
    graph.addPlugin('consumer', [], ['svc']);

    const result = await manager.activate();
    expect(result.activated.length).toBe(3);
  });
});

describe('lifecycle: deactivate()', () => {
  it('deactivate() calls plugin.deactivate()', async () => {
    const { manager, graph, registry } = makeLifecycleManager();
    let deactivateCalled = false;

    const plugin = makePlugin('test', {
      deactivate: () => {
        deactivateCalled = true;
      },
    });

    registry.register(plugin);
    graph.addPlugin('test', [], []);

    await manager.activate();
    await manager.deactivate();

    expect(deactivateCalled).toBe(true);
  });

  it('deactivation order is reverse of activation', async () => {
    const { manager, graph, registry } = makeLifecycleManager();
    const order: string[] = [];

    const a = makePlugin('a', {
      manifest: { provides: [{ capability: 'cap-a' }] },
      deactivate: () => order.push('deactivate-a'),
    });
    const b = makePlugin('b', {
      manifest: { needs: [{ capability: 'cap-a' }] },
      activate: (ctx) => ctx.provide('cap-a', {}),
      deactivate: () => order.push('deactivate-b'),
    });

    [a, b].forEach((p) => registry.register(p));
    graph.addPlugin('a', ['cap-a'], []);
    graph.addPlugin('b', [], ['cap-a']);

    await manager.activate();
    await manager.deactivate();

    // b should deactivate before a (reverse order)
    expect(order).toEqual(['deactivate-b', 'deactivate-a']);
  });

  it('plugin.deactivate() error does not prevent others from deactivating', async () => {
    const { manager, graph, registry } = makeLifecycleManager();
    const deactivated: string[] = [];

    const a = makePlugin('a', {
      deactivate: () => {
        throw new Error('error in a');
      },
    });
    const b = makePlugin('b', {
      deactivate: () => {
        deactivated.push('b');
      },
    });

    [a, b].forEach((p) => registry.register(p));
    graph.addPlugin('a', [], []);
    graph.addPlugin('b', [], []);

    await manager.activate();
    await manager.deactivate();

    expect(deactivated).toContain('b');
  });

  it('state transitions to inactive', async () => {
    const { manager, graph, registry } = makeLifecycleManager();

    const plugin = makePlugin('test');
    registry.register(plugin);
    graph.addPlugin('test', [], []);

    await manager.activate();
    expect(registry.getState('test')).toBe('active');

    await manager.deactivate();
    expect(registry.getState('test')).toBe('inactive');
  });
});

describe('lifecycle: activatePlugin() hot path', () => {
  it('activatePlugin() on already-active plugin is idempotent', async () => {
    const { manager, graph, registry } = makeLifecycleManager();
    let activateCount = 0;

    const plugin = makePlugin('test', {
      activate: () => {
        activateCount++;
      },
    });

    registry.register(plugin);
    graph.addPlugin('test', [], []);

    await manager.activate();
    expect(activateCount).toBe(1);

    await manager.activatePlugin('test');
    expect(activateCount).toBe(1); // no change
  });

  it('activatePlugin() with unsatisfied required dep → throws', async () => {
    const { manager, graph, registry } = makeLifecycleManager();

    const plugin = makePlugin('test', {
      manifest: { needs: [{ capability: 'missing' }] },
    });

    registry.register(plugin);
    graph.addPlugin('test', [], ['missing']);

    try {
      await manager.activatePlugin('test');
      expect.unreachable();
    } catch (err) {
      expect(err instanceof Error).toBe(true);
    }
  });

  it('activatePlugin() registers plugin in graph for consistent deactivation ordering', async () => {
    const { manager, graph, registry } = makeLifecycleManager();

    const provider = makePlugin('provider', {
      manifest: { provides: [{ capability: 'svc' }] },
      activate: (ctx) => ctx.provide('svc', {}),
    });

    registry.register(provider);
    graph.addPlugin('provider', ['svc'], []);

    // Initial activation
    await manager.activate();

    // Hot register a consumer after initial activation
    const consumer = makePlugin('consumer', {
      manifest: { needs: [{ capability: 'svc' }] },
    });

    registry.register(consumer);

    // activatePlugin should add to graph
    await manager.activatePlugin('consumer');

    // Verify plugin is in graph (indirectly via activation success)
    expect(registry.getState('consumer')).toBe('active');

    // Deactivate should complete without errors (correct ordering)
    await manager.deactivate();

    expect(registry.getState('consumer')).toBe('inactive');
    expect(registry.getState('provider')).toBe('inactive');
  });
});

describe('lifecycle: performance', () => {
  it('20 plugins with no-op hooks → durationMs < 100', async () => {
    const { manager, graph, registry } = makeLifecycleManager();

    for (let i = 0; i < 20; i++) {
      const plugin = makePlugin(`plugin-${i}`);
      registry.register(plugin);
      graph.addPlugin(`plugin-${i}`, [], []);
    }

    const start = Date.now();
    const result = await manager.activate();
    const elapsed = Date.now() - start;

    expect(result.activated.length).toBe(20);
    expect(elapsed).toBeLessThan(100);
  });
});
