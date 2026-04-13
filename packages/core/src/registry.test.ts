import { describe, it, expect, mock } from 'bun:test';
import { PluginRegistry } from './registry.js';
import type { Plugin, BrokerEventPayload } from './types.js';
import { DuplicatePluginError } from './errors.js';

// Minimal valid plugin — reuse across tests
function makePlugin(key: string): Plugin {
  return {
    key,
    version: '1.0.0',
    manifest: {
      name: `${key} plugin`,
      description: `Description for ${key}`,
      provides: [],
      needs: [],
    },
  };
}

// Capture emitted events for assertion
function makeEmit() {
  const calls: Array<BrokerEventPayload> = [];
  const emit = (payload: BrokerEventPayload) => {
    calls.push(payload);
  };
  return { emit, calls };
}

describe('PluginRegistry', () => {
  describe('register()', () => {
    it('stores the plugin and sets state to registered', () => {
      const { emit } = makeEmit();
      const registry = new PluginRegistry(emit);
      const plugin = makePlugin('my-plugin');

      registry.register(plugin);

      expect(registry.getPlugin('my-plugin')).toBe(plugin);
      expect(registry.getState('my-plugin')).toBe('registered');
    });

    it('emits plugin:registered after storing', () => {
      const { emit, calls } = makeEmit();
      const registry = new PluginRegistry(emit);

      registry.register(makePlugin('my-plugin'));

      expect(calls).toHaveLength(1);
      expect(calls[0].event).toBe('plugin:registered');
      expect(calls[0].pluginKey).toBe('my-plugin');
    });

    it('throws DuplicatePluginError when key already registered', () => {
      const { emit } = makeEmit();
      const registry = new PluginRegistry(emit);
      registry.register(makePlugin('my-plugin'));

      expect(() => registry.register(makePlugin('my-plugin')))
        .toThrow(DuplicatePluginError);
    });

    it('includes the plugin key in the error message', () => {
      const { emit } = makeEmit();
      const registry = new PluginRegistry(emit);
      registry.register(makePlugin('my-plugin'));

      expect(() => registry.register(makePlugin('my-plugin')))
        .toThrow(/my-plugin/);
    });
  });

  describe('unregister()', () => {
    it('removes the plugin from the registry', async () => {
      const { emit } = makeEmit();
      const registry = new PluginRegistry(emit);
      registry.register(makePlugin('my-plugin'));

      await registry.unregister('my-plugin');

      expect(registry.getPlugin('my-plugin')).toBeUndefined();
      expect(registry.getState('my-plugin')).toBeUndefined();
    });

    it('emits plugin:unregistered', async () => {
      const { emit, calls } = makeEmit();
      const registry = new PluginRegistry(emit);
      registry.register(makePlugin('my-plugin'));

      await registry.unregister('my-plugin');

      const last = calls[calls.length - 1];
      expect(last.event).toBe('plugin:unregistered');
      expect(last.pluginKey).toBe('my-plugin');
    });

    it('is idempotent — no-op for unknown key', async () => {
      const { emit, calls } = makeEmit();
      const registry = new PluginRegistry(emit);

      await expect(registry.unregister('nonexistent')).resolves.toBeUndefined();
      expect(calls).toHaveLength(0);
    });

    it('calls deactivate() when plugin state is active', async () => {
      const { emit } = makeEmit();
      const registry = new PluginRegistry(emit);
      const deactivate = mock(async () => {});
      const plugin: Plugin = { ...makePlugin('my-plugin'), deactivate };

      registry.register(plugin);
      registry.setState('my-plugin', 'active');

      await registry.unregister('my-plugin');

      expect(deactivate).toHaveBeenCalledTimes(1);
    });

    it('calls deactivate() when plugin state is resolving', async () => {
      const { emit } = makeEmit();
      const registry = new PluginRegistry(emit);
      const deactivate = mock(async () => {});
      const plugin: Plugin = { ...makePlugin('my-plugin'), deactivate };

      registry.register(plugin);
      registry.setState('my-plugin', 'resolving');

      await registry.unregister('my-plugin');

      expect(deactivate).toHaveBeenCalledTimes(1);
    });

    it('does not call deactivate() when plugin state is registered', async () => {
      const { emit } = makeEmit();
      const registry = new PluginRegistry(emit);
      const deactivate = mock(async () => {});
      const plugin: Plugin = { ...makePlugin('my-plugin'), deactivate };

      registry.register(plugin);

      await registry.unregister('my-plugin');

      expect(deactivate).not.toHaveBeenCalled();
    });

    it('does not call deactivate() when plugin state is inactive', async () => {
      const { emit } = makeEmit();
      const registry = new PluginRegistry(emit);
      const deactivate = mock(async () => {});
      const plugin: Plugin = { ...makePlugin('my-plugin'), deactivate };

      registry.register(plugin);
      registry.setState('my-plugin', 'inactive');

      await registry.unregister('my-plugin');

      expect(deactivate).not.toHaveBeenCalled();
    });

    it('does not call deactivate() when plugin state is failed', async () => {
      const { emit } = makeEmit();
      const registry = new PluginRegistry(emit);
      const deactivate = mock(async () => {});
      const plugin: Plugin = { ...makePlugin('my-plugin'), deactivate };

      registry.register(plugin);
      registry.setState('my-plugin', 'failed');

      await registry.unregister('my-plugin');

      expect(deactivate).not.toHaveBeenCalled();
    });

    it('does not throw when plugin has no deactivate hook', async () => {
      const { emit } = makeEmit();
      const registry = new PluginRegistry(emit);
      registry.register(makePlugin('my-plugin'));
      registry.setState('my-plugin', 'active');

      await expect(registry.unregister('my-plugin')).resolves.toBeUndefined();
    });

    it('completes cleanup even if deactivate() throws', async () => {
      const { emit, calls } = makeEmit();
      const registry = new PluginRegistry(emit);
      const deactivate = mock(async () => { throw new Error('deactivate failed'); });
      const plugin: Plugin = { ...makePlugin('my-plugin'), deactivate };

      registry.register(plugin);
      registry.setState('my-plugin', 'active');

      await registry.unregister('my-plugin');

      // Cleanup completed despite deactivate() throwing
      expect(registry.getPlugin('my-plugin')).toBeUndefined();
      expect(registry.getState('my-plugin')).toBeUndefined();
      // plugin:unregistered was still emitted
      const last = calls[calls.length - 1];
      expect(last.event).toBe('plugin:unregistered');
    });
  });

  describe('setState()', () => {
    it('updates the state for a registered plugin', () => {
      const { emit } = makeEmit();
      const registry = new PluginRegistry(emit);
      registry.register(makePlugin('my-plugin'));

      registry.setState('my-plugin', 'active');

      expect(registry.getState('my-plugin')).toBe('active');
    });

    it('is a no-op for unknown keys', () => {
      const { emit } = makeEmit();
      const registry = new PluginRegistry(emit);

      expect(() => registry.setState('nonexistent', 'active')).not.toThrow();
    });
  });

  describe('getPluginStates()', () => {
    it('returns a map of all plugin states', () => {
      const { emit } = makeEmit();
      const registry = new PluginRegistry(emit);
      registry.register(makePlugin('plugin-a'));
      registry.register(makePlugin('plugin-b'));

      const states = registry.getPluginStates();

      expect(states.size).toBe(2);
      expect(states.get('plugin-a')).toBe('registered');
      expect(states.get('plugin-b')).toBe('registered');
    });

    it('returns a copy — mutations do not affect the registry', () => {
      const { emit } = makeEmit();
      const registry = new PluginRegistry(emit);
      registry.register(makePlugin('my-plugin'));

      const states = registry.getPluginStates();
      states.set('my-plugin', 'failed');

      expect(registry.getState('my-plugin')).toBe('registered');
    });
  });

  describe('getAllPlugins()', () => {
    it('returns all registered plugins', () => {
      const { emit } = makeEmit();
      const registry = new PluginRegistry(emit);
      const a = makePlugin('plugin-a');
      const b = makePlugin('plugin-b');
      registry.register(a);
      registry.register(b);

      const plugins = registry.getAllPlugins();

      expect(plugins).toHaveLength(2);
      expect(plugins).toContain(a);
      expect(plugins).toContain(b);
    });

    it('returns empty array when no plugins registered', () => {
      const { emit } = makeEmit();
      const registry = new PluginRegistry(emit);

      expect(registry.getAllPlugins()).toEqual([]);
    });
  });

});
