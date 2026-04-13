import { describe, it, expect } from 'bun:test';
import type { Plugin, PluginManifest } from '../../core/src/types.js';
import { createTestBroker } from './test-broker.js';

// -- helpers ------------------------------------------------------------------

function makePlugin(key: string, overrides: Partial<Plugin> = {}): Plugin {
  const manifest: PluginManifest = {
    name: overrides.manifest?.name ?? key,
    description: overrides.manifest?.description ?? `${key} plugin`,
    provides: overrides.manifest?.provides ?? [],
    needs: overrides.manifest?.needs ?? [],
  };
  return {
    key,
    version: '1.0.0',
    manifest,
    ...(overrides.activate ? { activate: overrides.activate } : {}),
    ...(overrides.deactivate ? { deactivate: overrides.deactivate } : {}),
  };
}

// -----------------------------------------------------------------------------

describe('createTestBroker — shape', () => {
  it('returns { broker, mockContext } with the full Broker interface', () => {
    const { broker, mockContext } = createTestBroker();

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

    expect(mockContext.pluginKey).toBe('test-plugin');
    expect(Array.isArray(mockContext.emittedEvents)).toBe(true);
    expect(Array.isArray(mockContext.reportedErrors)).toBe(true);
    expect(mockContext.registeredCommands instanceof Map).toBe(true);
    expect(mockContext.providedCapabilities instanceof Map).toBe(true);
  });

  it('forwards mockContext options to createMockContext', () => {
    const { mockContext } = createTestBroker({
      mockContext: { pluginKey: 'custom' },
    });
    expect(mockContext.pluginKey).toBe('custom');
  });
});

describe('createTestBroker — end-to-end integration', () => {
  it('registers, activates, and resolves capabilities across plugins', async () => {
    const { broker } = createTestBroker();

    const providerImpl = { greet: (name: string) => `Hello, ${name}!` };

    const provider = makePlugin('provider', {
      manifest: {
        name: 'Provider',
        description: 'Provides greeter capability',
        provides: [{ capability: 'greeter' }],
        needs: [],
      },
      activate(ctx) {
        ctx.provide('greeter', providerImpl);
      },
    });

    let consumerSawImpl: unknown;
    const consumer = makePlugin('consumer', {
      manifest: {
        name: 'Consumer',
        description: 'Consumes greeter capability',
        provides: [],
        needs: [{ capability: 'greeter' }],
      },
      activate(ctx) {
        consumerSawImpl = ctx.resolve('greeter');
      },
    });

    broker.register(provider);
    broker.register(consumer);

    const result = await broker.activate();

    expect(result.activated).toEqual(['provider', 'consumer']);
    expect(result.failed).toEqual([]);
    expect(consumerSawImpl).toBe(providerImpl);
    expect(broker.resolve<typeof providerImpl>('greeter')).toBe(providerImpl);
  });

  it('mirrors broker events into mockContext.emittedEvents', async () => {
    const { broker, mockContext } = createTestBroker();

    const plugin = makePlugin('alpha', {
      activate() {
        // no-op
      },
    });

    broker.register(plugin);
    await broker.activate();

    const eventNames = mockContext.emittedEvents.map((e) => e.event);
    expect(eventNames).toContain('plugin:registered');
    expect(eventNames).toContain('plugin:activating');
    expect(eventNames).toContain('plugin:activated');
    expect(eventNames).toContain('broker:activated');
  });
});

describe('createTestBroker — config overrides', () => {
  it('defaults activationTimeoutMs to 1000 (fail-fast)', async () => {
    const { broker } = createTestBroker();

    const slowPlugin = makePlugin('slow', {
      activate() {
        return new Promise<void>((resolve) => setTimeout(resolve, 10_000));
      },
    });

    broker.register(slowPlugin);
    const start = Date.now();
    const result = await broker.activate();
    const elapsed = Date.now() - start;

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.pluginKey).toBe('slow');
    // Generous ceiling — the real timeout is 1s, but we allow overhead.
    expect(elapsed).toBeLessThan(3_000);
  });

  it('respects an explicit activationTimeoutMs override', async () => {
    const { broker } = createTestBroker({ activationTimeoutMs: 50 });

    const slowPlugin = makePlugin('slow', {
      activate() {
        return new Promise<void>((resolve) => setTimeout(resolve, 5_000));
      },
    });

    broker.register(slowPlugin);
    const start = Date.now();
    const result = await broker.activate();
    const elapsed = Date.now() - start;

    expect(result.failed).toHaveLength(1);
    expect(elapsed).toBeLessThan(1_000);
  });
});

describe('createTestBroker — isolation', () => {
  it('two brokers produced by separate calls are fully independent', async () => {
    const a = createTestBroker();
    const b = createTestBroker();

    const pluginA = makePlugin('only-in-a');
    const pluginB = makePlugin('only-in-b');

    a.broker.register(pluginA);
    b.broker.register(pluginB);

    await a.broker.activate();
    await b.broker.activate();

    expect(a.broker.getPluginStates().has('only-in-a')).toBe(true);
    expect(a.broker.getPluginStates().has('only-in-b')).toBe(false);
    expect(b.broker.getPluginStates().has('only-in-b')).toBe(true);
    expect(b.broker.getPluginStates().has('only-in-a')).toBe(false);

    // The mockContext on A should only see A's events, not B's.
    const aKeys = new Set(
      a.mockContext.emittedEvents
        .map((e) => (e.payload as { pluginKey?: string } | undefined)?.pluginKey)
        .filter((k): k is string => typeof k === 'string')
    );
    expect(aKeys.has('only-in-a')).toBe(true);
    expect(aKeys.has('only-in-b')).toBe(false);
  });
});
