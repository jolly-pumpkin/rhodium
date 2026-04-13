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
  BrokerEventPayload,
} from './types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makePlugin(key: string, overrides: Partial<Plugin> = {}): Plugin {
  const manifest: PluginManifest = {
    name: overrides.manifest?.name ?? `${key} plugin`,
    description: overrides.manifest?.description ?? `Description for ${key}`,
    provides: overrides.manifest?.provides ?? [],
    needs: overrides.manifest?.needs ?? [],
    ...(overrides.manifest?.tags !== undefined ? { tags: overrides.manifest.tags } : {}),
  };
  const plugin: Plugin = {
    key,
    version: '1.0.0',
    manifest,
    ...(overrides.activate ? { activate: overrides.activate } : {}),
    ...(overrides.deactivate ? { deactivate: overrides.deactivate } : {}),
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
    expect(typeof broker.getManifests).toBe('function');
    expect(typeof broker.getManifest).toBe('function');
    expect(typeof broker.on).toBe('function');
    expect(typeof broker.getLog).toBe('function');
    expect(typeof broker.getPluginStates).toBe('function');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. register()
// ─────────────────────────────────────────────────────────────────────────────

describe('createBroker — register()', () => {
  it('adds the plugin to registry and graph', () => {
    const broker = makeBroker();
    const p = makePlugin('alpha');
    broker.register(p);

    const states = broker.getPluginStates();
    expect(states.has('alpha')).toBe(true);
    expect(states.get('alpha')!.status).toBe('registered');
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
        name: 'A',
        description: 'A plugin',
        provides: [{ capability: 'cap-a' }],
        needs: [{ capability: 'cap-b' }],
      },
    });
    const b = makePlugin('b', {
      manifest: {
        name: 'B',
        description: 'B plugin',
        provides: [{ capability: 'cap-b' }],
        needs: [{ capability: 'cap-a' }],
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
    const err = caught as CircularDependencyError;
    expect(err.message).toContain('Circular dependency');
    expect(err.cycle.length).toBeGreaterThan(0);

    // b must be fully cleaned up after the rollback
    expect(broker.getPluginStates().has('b')).toBe(false);

    // `a` should still be registered.
    expect(broker.getPluginStates().get('a')!.status).toBe('registered');
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
    expect(broker.getPluginStates().get('p1')!.status).toBe('active');
    expect(broker.getPluginStates().get('p2')!.status).toBe('active');
    expect(log.length).toBe(2);
  });

  it('deactivates plugins and removes their capability implementations', async () => {
    const broker = makeBroker();
    const provider = makePlugin('provider', {
      manifest: {
        name: 'Provider',
        description: 'Provider plugin',
        provides: [{ capability: 'greet' }],
        needs: [],
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
    let payload: BrokerEventPayload | undefined;
    broker.on('broker:activated', (p) => {
      fired++;
      payload = p;
    });
    await broker.activate();
    expect(fired).toBe(1);
    expect(payload).toBeDefined();
  });

  it('activatePlugin() hot-registers a plugin after broker.activate()', async () => {
    const broker = makeBroker();
    let aCalls = 0;
    broker.register(
      makePlugin('a', { activate: () => { aCalls++; } }),
    );
    await broker.activate();
    expect(aCalls).toBe(1);
    expect(broker.getPluginStates().get('a')!.status).toBe('active');

    let bCalls = 0;
    broker.register(
      makePlugin('b', {
        manifest: {
          name: 'B',
          description: 'B plugin',
          provides: [{ capability: 'late-cap' }],
          needs: [],
        },
        activate(ctx: PluginContext) {
          bCalls++;
          ctx.provide('late-cap', { hello: () => 'late' });
        },
      }),
    );
    expect(broker.getPluginStates().get('b')!.status).toBe('registered');

    const result = await broker.activatePlugin('b');
    expect(bCalls).toBe(1);
    expect(result.activated).toContain('b');
    expect(broker.getPluginStates().get('b')!.status).toBe('active');
    expect(
      broker.resolve<{ hello: () => string }>('late-cap').hello(),
    ).toBe('late');
  });

  it('activatePlugin() returns ActivationResult with durationMs', async () => {
    const broker = makeBroker();
    broker.register(makePlugin('x'));
    const result = await broker.activatePlugin('x');
    expect(result.activated).toContain('x');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.failed).toEqual([]);
    expect(result.pending).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. resolve* delegation
// ─────────────────────────────────────────────────────────────────────────────

describe('createBroker — resolve / resolveAll / resolveOptional', () => {
  it('resolve() returns the provider implementation after activation', async () => {
    const broker = makeBroker();
    const provider = makePlugin('p', {
      manifest: { name: 'P', description: 'P plugin', provides: [{ capability: 'cap' }], needs: [] },
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
      manifest: { name: 'Low', description: 'Low priority', provides: [{ capability: 'multi', priority: 5 }], needs: [] },
      activate(ctx: PluginContext) { ctx.provide('multi', { tag: 'low' }); },
    }));
    broker.register(makePlugin('high', {
      manifest: { name: 'High', description: 'High priority', provides: [{ capability: 'multi', priority: 50 }], needs: [] },
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
// 5. getManifests() and getManifest()
// ─────────────────────────────────────────────────────────────────────────────

describe('createBroker — getManifests() and getManifest()', () => {
  it('getManifests() returns all registered plugin manifests', () => {
    const broker = makeBroker();
    broker.register(makePlugin('alpha', {
      manifest: { name: 'Alpha', description: 'Alpha plugin', provides: [], needs: [], tags: ['core'] },
    }));
    broker.register(makePlugin('beta', {
      manifest: { name: 'Beta', description: 'Beta plugin', provides: [], needs: [] },
    }));

    const manifests = broker.getManifests();
    expect(manifests.size).toBe(2);
    expect(manifests.get('alpha')!.name).toBe('Alpha');
    expect(manifests.get('alpha')!.description).toBe('Alpha plugin');
    expect(manifests.get('alpha')!.tags).toEqual(['core']);
    expect(manifests.get('beta')!.name).toBe('Beta');
  });

  it('getManifest() returns the manifest for a specific plugin', () => {
    const broker = makeBroker();
    broker.register(makePlugin('alpha', {
      manifest: { name: 'Alpha', description: 'Alpha plugin', provides: [{ capability: 'cap-a' }], needs: [] },
    }));

    const manifest = broker.getManifest('alpha');
    expect(manifest).toBeDefined();
    expect(manifest!.name).toBe('Alpha');
    expect(manifest!.provides[0]!.capability).toBe('cap-a');
  });

  it('getManifest() returns undefined for an unregistered plugin', () => {
    const broker = makeBroker();
    expect(broker.getManifest('nonexistent')).toBeUndefined();
  });

  it('getManifests() returns empty map when no plugins registered', () => {
    const broker = makeBroker();
    expect(broker.getManifests().size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. getLog() and debug mode
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

  it('log entries have message field', async () => {
    const broker = makeBroker();
    broker.register(makePlugin('foo'));
    await broker.activate();

    const log = broker.getLog();
    for (const entry of log.entries) {
      expect(typeof entry.message).toBe('string');
      expect(entry.message.length).toBeGreaterThan(0);
    }
  });

  it('filter() returns entries for a specific event type', async () => {
    const broker = makeBroker();
    broker.register(makePlugin('foo'));
    await broker.activate();

    const log = broker.getLog();
    const activated = log.filter('plugin:activated');
    expect(activated.every((e) => e.event === 'plugin:activated')).toBe(true);
    expect(activated.length).toBe(1);
  });

  it('forPlugin() returns entries for a specific plugin', async () => {
    const broker = makeBroker();
    broker.register(makePlugin('foo'));
    broker.register(makePlugin('bar'));
    await broker.activate();

    const log = broker.getLog();
    const fooLog = log.forPlugin('foo');
    for (const entry of fooLog) {
      expect(entry.pluginKey).toBe('foo');
    }
    expect(fooLog.length).toBeGreaterThan(0);
  });

  it('pendingDependencies lists unresolved deps', () => {
    const broker = makeBroker();
    broker.register(makePlugin('waiting', {
      manifest: {
        name: 'Waiting',
        description: 'Waiting plugin',
        provides: [],
        needs: [{ capability: 'missing-cap' }],
      },
    }));

    const log = broker.getLog();
    expect(log.pendingDependencies.some((d) => d.capability === 'missing-cap')).toBe(true);
  });

  it('returns a defensive copy of entries (mutation-safe)', () => {
    const broker = makeBroker();
    broker.register(makePlugin('foo'));
    const first = broker.getLog();
    expect(first.entries.length).toBeGreaterThan(0);

    // Mutating the returned array must not affect subsequent reads.
    first.entries.length = 0;

    const second = broker.getLog();
    expect(second.entries.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. dependency:resolved and dependency:unresolved events
// ─────────────────────────────────────────────────────────────────────────────

describe('createBroker — dependency:resolved and dependency:unresolved events', () => {
  it('emits dependency:resolved when a consumer activates with a satisfied dependency', async () => {
    const broker = makeBroker();
    const events: BrokerEventPayload[] = [];
    broker.on('dependency:resolved', (p) => events.push(p));

    broker.register(makePlugin('provider', {
      manifest: { name: 'P', description: 'P', provides: [{ capability: 'svc' }], needs: [] },
      activate(ctx) { ctx.provide('svc', {}); },
    }));
    broker.register(makePlugin('consumer', {
      manifest: { name: 'C', description: 'C', provides: [], needs: [{ capability: 'svc' }] },
    }));
    await broker.activate();

    expect(events.length).toBe(1);
    expect(events[0].pluginKey).toBe('consumer');
    expect(events[0].capability).toBe('svc');
  });

  it('does not emit dependency:resolved for plugins with no dependencies', async () => {
    const broker = makeBroker();
    const events: BrokerEventPayload[] = [];
    broker.on('dependency:resolved', (p) => events.push(p));

    broker.register(makePlugin('standalone'));
    await broker.activate();

    expect(events.length).toBe(0);
  });

  it('emits dependency:unresolved when a provider is unregistered', async () => {
    const broker = makeBroker();
    const events: BrokerEventPayload[] = [];
    broker.on('dependency:unresolved', (p) => events.push(p));

    broker.register(makePlugin('provider', {
      manifest: { name: 'P', description: 'P', provides: [{ capability: 'svc' }], needs: [] },
      activate(ctx) { ctx.provide('svc', {}); },
    }));
    broker.register(makePlugin('consumer', {
      manifest: { name: 'C', description: 'C', provides: [], needs: [{ capability: 'svc' }] },
    }));
    await broker.activate();

    await broker.unregister('provider');
    expect(events.length).toBe(1);
    expect(events[0].pluginKey).toBe('consumer');
    expect(events[0].capability).toBe('svc');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Two-broker isolation (ADR-009)
// ─────────────────────────────────────────────────────────────────────────────

describe('createBroker — two brokers in the same process are independent', () => {
  it('does not share registry or graph state across brokers', () => {
    const brokerA = makeBroker();
    const brokerB = makeBroker();
    brokerA.register(makePlugin('only-in-a'));

    expect(brokerA.getPluginStates().size).toBe(1);
    expect(brokerB.getPluginStates().size).toBe(0);
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
// 8. End-to-end: provider + consumer wired via a capability
// ─────────────────────────────────────────────────────────────────────────────

describe('createBroker — end-to-end provider/consumer', () => {
  it('activates provider then consumer and resolves capabilities across both', async () => {
    const broker = makeBroker();

    const calls: string[] = [];

    const provider = makePlugin('provider', {
      manifest: {
        name: 'Provider',
        description: 'Provider plugin',
        provides: [{ capability: 'greeter' }],
        needs: [],
      },
      activate(ctx: PluginContext) {
        calls.push('provider.activate');
        ctx.provide('greeter', { greet: (name: string) => `hello, ${name}` });
      },
    });

    const consumer = makePlugin('consumer', {
      manifest: {
        name: 'Consumer',
        description: 'Consumer plugin',
        provides: [],
        needs: [{ capability: 'greeter' }],
      },
      activate(ctx: PluginContext) {
        calls.push('consumer.activate');
        const greeter = ctx.resolve<{ greet: (n: string) => string }>('greeter');
        calls.push(greeter.greet('world'));
      },
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
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. unregister() wiring
// ─────────────────────────────────────────────────────────────────────────────

describe('createBroker — unregister()', () => {
  it('removes the plugin from registry, graph, and resolver', async () => {
    const broker = makeBroker();
    broker.register(makePlugin('temp', {
      manifest: {
        name: 'Temp',
        description: 'Temporary plugin',
        provides: [{ capability: 'gone' }],
        needs: [],
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
  });

  it('calls onDependencyRemoved on dependents before teardown', async () => {
    const broker = makeBroker();
    const removedCapabilities: Array<{ cap: string; provider: string }> = [];

    broker.register(makePlugin('provider', {
      manifest: { name: 'Provider', description: 'Provider plugin', provides: [{ capability: 'dep' }], needs: [] },
      activate(ctx: PluginContext) { ctx.provide('dep', {}); },
    }));
    broker.register(makePlugin('dependent', {
      manifest: { name: 'Dependent', description: 'Dependent plugin', provides: [], needs: [{ capability: 'dep' }] },
      onDependencyRemoved(cap: string, providerKey: string) {
        removedCapabilities.push({ cap, provider: providerKey });
      },
    }));
    await broker.activate();

    await broker.unregister('provider');
    expect(removedCapabilities.length).toBe(1);
    expect(removedCapabilities[0]!.cap).toBe('dep');
    expect(removedCapabilities[0]!.provider).toBe('provider');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Event bus — v2 event names
// ─────────────────────────────────────────────────────────────────────────────

describe('createBroker — v2 event names', () => {
  it('emits capability:provided when a plugin provides a capability', async () => {
    const broker = makeBroker();
    const events: BrokerEventPayload[] = [];
    broker.on('capability:provided', (p) => events.push(p));

    broker.register(makePlugin('p', {
      manifest: { name: 'P', description: 'P plugin', provides: [{ capability: 'svc' }], needs: [] },
      activate(ctx: PluginContext) { ctx.provide('svc', {}); },
    }));
    await broker.activate();

    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.event).toBe('capability:provided');
    expect(events[0]!.pluginKey).toBe('p');
    expect(events[0]!.capability).toBe('svc');
  });

  it('emits capability:removed on deactivation', async () => {
    const broker = makeBroker();
    const events: BrokerEventPayload[] = [];
    broker.on('capability:removed', (p) => events.push(p));

    broker.register(makePlugin('p', {
      manifest: { name: 'P', description: 'P plugin', provides: [{ capability: 'svc' }], needs: [] },
      activate(ctx: PluginContext) { ctx.provide('svc', {}); },
    }));
    await broker.activate();
    await broker.deactivate();

    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.capability).toBe('svc');
  });

  it('BrokerEventPayload has flat structure with timestamp, event, pluginKey, capability, detail', async () => {
    const broker = makeBroker();
    let payload: BrokerEventPayload | undefined;
    broker.on('plugin:activated', (p) => { payload = p; });

    broker.register(makePlugin('x'));
    await broker.activate();

    expect(payload).toBeDefined();
    expect(typeof payload!.timestamp).toBe('number');
    expect(payload!.event).toBe('plugin:activated');
    expect(payload!.pluginKey).toBe('x');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. getPluginStates() returns rich PluginState
// ─────────────────────────────────────────────────────────────────────────────

describe('createBroker — getPluginStates() returns rich PluginState', () => {
  it('returns PluginState objects with key, version, status, activeCapabilities, dependencies', async () => {
    const broker = makeBroker();
    broker.register(makePlugin('p', {
      manifest: { name: 'P', description: 'P plugin', provides: [{ capability: 'cap' }], needs: [] },
      activate(ctx: PluginContext) { ctx.provide('cap', { v: 1 }); },
    }));
    await broker.activate();

    const states = broker.getPluginStates();
    const state = states.get('p');
    expect(state).toBeDefined();
    expect(state!.key).toBe('p');
    expect(state!.version).toBe('1.0.0');
    expect(state!.status).toBe('active');
    expect(state!.activeCapabilities).toContain('cap');
    expect(typeof state!.lastTransition).toBe('number');
    expect(Array.isArray(state!.registeredCommands)).toBe(true);
    expect(Array.isArray(state!.dependencies)).toBe(true);
  });
});
