import { describe, it, expect, beforeEach } from 'bun:test';
import { createLifecycleManager } from './lifecycle.js';
import { PluginRegistry } from './registry.js';
import { createDependencyGraph } from '../../../packages/graph/src/index.js';
import { createCapabilityResolver } from '../../../packages/graph/src/index.js';
import { createEventBus } from './events.js';
import {
  ActivationTimeoutError,
  ActivationError,
  CapabilityViolationError,
  UndeclaredCapabilityError,
} from './errors.js';
import { defineCapability } from '../../../packages/capabilities/src/index.js';
import type { Plugin, PluginManifest } from './types.js';
import type { LifecycleManagerOpts } from './lifecycle.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makePlugin(key: string, opts: Partial<Plugin> = {}): Plugin {
  const manifest: PluginManifest = {
    name: opts.manifest?.name ?? `${key} plugin`,
    description: opts.manifest?.description ?? `Description for ${key}`,
    provides: opts.manifest?.provides ?? [],
    needs: opts.manifest?.needs ?? [],
  };
  return {
    key,
    version: '1.0.0',
    manifest,
    activate: opts.activate,
    deactivate: opts.deactivate,
    onDependencyRemoved: opts.onDependencyRemoved,
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
    new PluginRegistry((payload) => {
      eventBus.emit(payload.event, payload);
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

    const a = makePlugin('a', { manifest: { name: 'A', description: 'A plugin', provides: [{ capability: 'cap-a' }], needs: [] } });
    const b = makePlugin('b', { manifest: { name: 'B', description: 'B plugin', provides: [], needs: [{ capability: 'cap-a' }] } });

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

    const a = makePlugin('a', { manifest: { name: 'A', description: 'A plugin', provides: [{ capability: 'cap-a' }], needs: [] } });
    const b = makePlugin('b', {
      manifest: { name: 'B', description: 'B plugin', provides: [{ capability: 'cap-b' }], needs: [{ capability: 'cap-a' }] },
    });
    const c = makePlugin('c', {
      manifest: { name: 'C', description: 'C plugin', provides: [{ capability: 'cap-c' }], needs: [{ capability: 'cap-a' }] },
    });
    const d = makePlugin('d', {
      manifest: { name: 'D', description: 'D plugin', provides: [], needs: [{ capability: 'cap-b' }, { capability: 'cap-c' }] },
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

describe('lifecycle: timer cleanup on activation failure', () => {
  it('clears timeout timer when plugin.activate() rejects', async () => {
    const { manager, graph, registry } = makeLifecycleManager({ timeoutMs: 60_000 });
    const plugin = makePlugin('fail-fast', {
      activate: () => { throw new Error('immediate failure'); },
    });
    registry.register(plugin);
    graph.addPlugin('fail-fast', [], []);

    const result = await manager.activate();
    expect(result.failed.length).toBe(1);
    expect(result.failed[0].pluginKey).toBe('fail-fast');
    // If the timer leaked, this test process would hang for 60s or
    // produce an unhandled rejection. Completing promptly proves cleanup.
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
      manifest: { name: 'A', description: 'A plugin', provides: [{ capability: 'cap-a' }], needs: [] },
      activate: () => {
        throw new Error('a failed');
      },
    });
    const b = makePlugin('b', {
      manifest: { name: 'B', description: 'B plugin', provides: [], needs: [{ capability: 'cap-a' }] },
    });

    [a, b].forEach((p) => registry.register(p));
    graph.addPlugin('a', ['cap-a'], []);
    graph.addPlugin('b', [], ['cap-a']);

    const result = await manager.activate();
    expect(result.failed[0].pluginKey).toBe('a');
    expect(result.pending.some((p) => p.pluginKey === 'b')).toBe(true);
    expect(result.pending.find((p) => p.pluginKey === 'b')?.unmetDependencies).toEqual(['cap-a']);
  });

  it('B requires A; no provider exists for A → B in pending', async () => {
    const { manager, graph, registry } = makeLifecycleManager();

    const b = makePlugin('b', {
      manifest: { name: 'B', description: 'B plugin', provides: [], needs: [{ capability: 'missing-cap' }] },
    });

    registry.register(b);
    graph.addPlugin('b', [], ['missing-cap']);

    const result = await manager.activate();
    expect(result.pending.some((p) => p.pluginKey === 'b')).toBe(true);
    expect(result.pending.find((p) => p.pluginKey === 'b')?.unmetDependencies).toEqual(['missing-cap']);
    expect(result.activated.length).toBe(0);
  });

  it('B optionally needs A; A fails → B activates', async () => {
    const { manager, graph, registry } = makeLifecycleManager();

    const a = makePlugin('a', {
      manifest: { name: 'A', description: 'A plugin', provides: [{ capability: 'cap-a' }], needs: [] },
      activate: () => {
        throw new Error('a failed');
      },
    });
    const b = makePlugin('b', {
      manifest: { name: 'B', description: 'B plugin', provides: [], needs: [{ capability: 'cap-a', optional: true }] },
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
      manifest: { name: 'A', description: 'A plugin', provides: [{ capability: 'cap-x' }], needs: [] },
      activate: () => {
        throw new Error('a failed');
      },
    });
    const a2 = makePlugin('a2', {
      manifest: { name: 'A2', description: 'A2 plugin', provides: [{ capability: 'cap-x' }], needs: [] },
    });
    const b = makePlugin('b', {
      manifest: { name: 'B', description: 'B plugin', provides: [], needs: [{ capability: 'cap-x' }] },
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
      manifest: { name: 'Provider', description: 'Provider plugin', provides: [{ capability: 'service' }], needs: [] },
      activate: (ctx) => {
        ctx.provide('service', { method: 'hello' });
      },
    });
    const consumer = makePlugin('consumer', {
      manifest: { name: 'Consumer', description: 'Consumer plugin', provides: [], needs: [{ capability: 'service' }] },
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
      manifest: { name: 'P1', description: 'P1 plugin', provides: [{ capability: 'svc', priority: 1 }], needs: [] },
      activate: (ctx) => ctx.provide('svc', { name: 'low' }),
    });
    const p2 = makePlugin('p2', {
      manifest: { name: 'P2', description: 'P2 plugin', provides: [{ capability: 'svc', priority: 10 }], needs: [] },
      activate: (ctx) => ctx.provide('svc', { name: 'high' }),
    });
    const consumer = makePlugin('consumer', {
      manifest: { name: 'Consumer', description: 'Consumer plugin', provides: [], needs: [{ capability: 'svc', multiple: true }] },
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
      manifest: { name: 'A', description: 'A plugin', provides: [{ capability: 'cap-a' }], needs: [] },
      deactivate: () => order.push('deactivate-a'),
    });
    const b = makePlugin('b', {
      manifest: { name: 'B', description: 'B plugin', provides: [], needs: [{ capability: 'cap-a' }] },
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

  it('activatePlugin() with unsatisfied required dep → throws and transitions to failed', async () => {
    const { manager, graph, registry } = makeLifecycleManager();

    const plugin = makePlugin('test', {
      manifest: { name: 'Test', description: 'Test plugin', provides: [], needs: [{ capability: 'missing' }] },
    });

    registry.register(plugin);
    graph.addPlugin('test', [], ['missing']);

    try {
      await manager.activatePlugin('test');
      expect.unreachable();
    } catch (err) {
      expect(err instanceof Error).toBe(true);
    }

    // Plugin should be in 'failed' state, not stuck in 'registered'
    expect(registry.getState('test')).toBe('failed');
  });

  it('activatePlugin() registers plugin in graph for consistent deactivation ordering', async () => {
    const { manager, graph, registry } = makeLifecycleManager();

    const provider = makePlugin('provider', {
      manifest: { name: 'Provider', description: 'Provider plugin', provides: [{ capability: 'svc' }], needs: [] },
      activate: (ctx) => ctx.provide('svc', {}),
    });

    registry.register(provider);
    graph.addPlugin('provider', ['svc'], []);

    // Initial activation
    await manager.activate();

    // Hot register a consumer after initial activation
    const consumer = makePlugin('consumer', {
      manifest: { name: 'Consumer', description: 'Consumer plugin', provides: [], needs: [{ capability: 'svc' }] },
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

describe('lifecycle: PluginContext.provide() manifest enforcement', () => {
  it('provide() with capability not in manifest.provides → plugin fails with UndeclaredCapabilityError', async () => {
    const { manager, graph, registry } = makeLifecycleManager();

    const plugin = makePlugin('bad-provider', {
      manifest: { name: 'Bad Provider', description: 'Bad provider plugin', provides: [], needs: [] },
      activate: (ctx) => {
        ctx.provide('undeclared-cap', { value: 42 });
      },
    });

    registry.register(plugin);
    graph.addPlugin('bad-provider', [], []);

    const result = await manager.activate();

    expect(result.failed.length).toBe(1);
    expect(result.failed[0].pluginKey).toBe('bad-provider');
    expect(result.failed[0].error instanceof UndeclaredCapabilityError).toBe(true);
    expect(result.failed[0].error.message).toContain('undeclared-cap');
  });

  it('provide() with contract in manifest and invalid implementation → fails with CapabilityViolationError', async () => {
    const { manager, graph, registry } = makeLifecycleManager();

    const contract = defineCapability<{ greet: (name: string) => string }>('greeter', {
      methods: { greet: 1 },
    });

    const plugin = makePlugin('bad-impl', {
      manifest: {
        name: 'Bad Impl',
        description: 'Bad implementation plugin',
        provides: [{ capability: 'greeter', contract }],
        needs: [],
      },
      activate: (ctx) => {
        ctx.provide('greeter', { notGreet: 42 });
      },
    });

    registry.register(plugin);
    graph.addPlugin('bad-impl', ['greeter'], []);

    const result = await manager.activate();
    expect(result.failed.length).toBe(1);
    expect(result.failed[0].pluginKey).toBe('bad-impl');
    expect(result.failed[0].error instanceof CapabilityViolationError).toBe(true);
    expect(result.failed[0].error.message).toContain('greeter');
  });

  it('provide() with no contract in manifest declaration → passes without validation', async () => {
    const { manager, graph, registry } = makeLifecycleManager();

    const plugin = makePlugin('no-contract', {
      manifest: {
        name: 'No Contract',
        description: 'No contract plugin',
        provides: [{ capability: 'svc' }],
        needs: [],
      },
      activate: (ctx) => {
        ctx.provide('svc', 'anything at all');
      },
    });

    registry.register(plugin);
    graph.addPlugin('no-contract', ['svc'], []);

    const result = await manager.activate();
    expect(result.activated).toContain('no-contract');
    expect(result.failed.length).toBe(0);
  });

  it('provide() with contract and valid implementation → activates successfully', async () => {
    const { manager, graph, registry } = makeLifecycleManager();

    const contract = defineCapability<{ greet: (name: string) => string }>('greeter', {
      methods: { greet: 1 },
    });

    const plugin = makePlugin('good-impl', {
      manifest: {
        name: 'Good Impl',
        description: 'Good implementation plugin',
        provides: [{ capability: 'greeter', contract }],
        needs: [],
      },
      activate: (ctx) => {
        ctx.provide('greeter', { greet: (name: string) => `Hello, ${name}` });
      },
    });

    registry.register(plugin);
    graph.addPlugin('good-impl', ['greeter'], []);

    const result = await manager.activate();
    expect(result.activated).toContain('good-impl');
    expect(result.failed.length).toBe(0);
  });
});

describe('lifecycle: PluginContext.registerCommand()', () => {
  it('registerCommand() registers a command handler during activation', async () => {
    const { manager, graph, registry } = makeLifecycleManager();

    const plugin = makePlugin('cmd-plugin', {
      activate: (ctx) => {
        ctx.registerCommand('my-command', async (...args: unknown[]) => {
          return `executed with ${args.length} args`;
        });
      },
    });

    registry.register(plugin);
    graph.addPlugin('cmd-plugin', [], []);

    const result = await manager.activate();
    expect(result.activated).toContain('cmd-plugin');
    expect(result.failed.length).toBe(0);
  });
});

describe('lifecycle: PluginContext.emit()', () => {
  it('emit() sends custom events through the event bus', async () => {
    const { manager, graph, registry, eventBus } = makeLifecycleManager();

    let receivedPayload: unknown;
    eventBus.on('custom:event', (payload: unknown) => {
      receivedPayload = payload;
    });

    const plugin = makePlugin('emitter', {
      activate: (ctx) => {
        ctx.emit('custom:event', { data: 'hello' });
      },
    });

    registry.register(plugin);
    graph.addPlugin('emitter', [], []);

    await manager.activate();
    expect(receivedPayload).toBeDefined();
    expect((receivedPayload as any).detail).toEqual({ data: 'hello' });
  });
});

describe('lifecycle: getPluginStates() returns rich PluginState', () => {
  it('returns PluginState with status, activeCapabilities, dependencies', async () => {
    const { manager, graph, registry } = makeLifecycleManager();

    const provider = makePlugin('provider', {
      manifest: {
        name: 'Provider',
        description: 'Provider plugin',
        provides: [{ capability: 'svc' }],
        needs: [],
      },
      activate: (ctx) => ctx.provide('svc', { value: 42 }),
    });

    const consumer = makePlugin('consumer', {
      manifest: {
        name: 'Consumer',
        description: 'Consumer plugin',
        provides: [],
        needs: [{ capability: 'svc' }],
      },
    });

    [provider, consumer].forEach((p) => registry.register(p));
    graph.addPlugin('provider', ['svc'], []);
    graph.addPlugin('consumer', [], ['svc']);

    await manager.activate();

    const states = manager.getPluginStates();
    const providerState = states.get('provider');
    expect(providerState).toBeDefined();
    expect(providerState!.status).toBe('active');
    expect(providerState!.key).toBe('provider');
    expect(providerState!.version).toBe('1.0.0');
    expect(providerState!.activeCapabilities).toContain('svc');

    const consumerState = states.get('consumer');
    expect(consumerState).toBeDefined();
    expect(consumerState!.status).toBe('active');
    expect(consumerState!.dependencies.length).toBe(1);
    expect(consumerState!.dependencies[0].capability).toBe('svc');
    expect(consumerState!.dependencies[0].resolved).toBe(true);
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
