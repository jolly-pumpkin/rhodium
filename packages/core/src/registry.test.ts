import { describe, it, expect, mock } from 'bun:test';
import { PluginRegistry } from './registry.js';
import type { Plugin, BrokerEvent, BrokerEventPayload } from './types.js';
import { DuplicatePluginError, DuplicateToolError } from './errors.js';

// Minimal valid plugin — reuse across tests
function makePlugin(key: string, tools: string[] = []): Plugin {
  return {
    key,
    version: '1.0.0',
    manifest: {
      provides: [],
      needs: [],
      tools: tools.map(name => ({ name, description: `${name} tool` })),
    },
  };
}

// Capture emitted events for assertion
function makeEmit() {
  const calls: Array<{ event: BrokerEvent; payload: unknown }> = [];
  const emit = <E extends BrokerEvent>(event: E, payload: BrokerEventPayload[E]) => {
    calls.push({ event, payload });
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
      expect(calls[0]).toEqual({ event: 'plugin:registered', payload: { pluginKey: 'my-plugin' } });
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

    it('throws DuplicateToolError when tool name conflicts with another plugin', () => {
      const { emit } = makeEmit();
      const registry = new PluginRegistry(emit);
      registry.register(makePlugin('plugin-a', ['search']));

      expect(() => registry.register(makePlugin('plugin-b', ['search'])))
        .toThrow(DuplicateToolError);
    });

    it('error message includes both plugin keys and tool name', () => {
      const { emit } = makeEmit();
      const registry = new PluginRegistry(emit);
      registry.register(makePlugin('plugin-a', ['search']));

      expect(() => registry.register(makePlugin('plugin-b', ['search'])))
        .toThrow(/search/);
    });

    it('does not partially register a plugin when a later tool conflicts', () => {
      const { emit } = makeEmit();
      const registry = new PluginRegistry(emit);
      registry.register(makePlugin('plugin-a', ['search']));

      const pluginB: Plugin = {
        key: 'plugin-b',
        version: '1.0.0',
        manifest: {
          provides: [],
          needs: [],
          tools: [
            { name: 'fetch', description: 'fetch tool' },
            { name: 'search', description: 'search tool' },
          ],
        },
      };

      expect(() => registry.register(pluginB)).toThrow(DuplicateToolError);
      expect(registry.getPlugin('plugin-b')).toBeUndefined();
      expect(registry.getPluginStates().get('plugin-b')).toBeUndefined();
    });
  });

  describe('unregister()', () => {
    it('removes the plugin and its tools from the registry', async () => {
      const { emit } = makeEmit();
      const registry = new PluginRegistry(emit);
      registry.register(makePlugin('my-plugin', ['search']));

      await registry.unregister('my-plugin');

      expect(registry.getPlugin('my-plugin')).toBeUndefined();
      expect(registry.getState('my-plugin')).toBeUndefined();
    });

    it('emits plugin:unregistered', async () => {
      const { emit, calls } = makeEmit();
      const registry = new PluginRegistry(emit);
      registry.register(makePlugin('my-plugin'));

      await registry.unregister('my-plugin');

      expect(calls.at(-1)).toEqual({
        event: 'plugin:unregistered',
        payload: { pluginKey: 'my-plugin' },
      });
    });

    it('frees tool names for re-registration after unregister', async () => {
      const { emit } = makeEmit();
      const registry = new PluginRegistry(emit);
      registry.register(makePlugin('plugin-a', ['search']));
      await registry.unregister('plugin-a');

      expect(() => registry.register(makePlugin('plugin-b', ['search']))).not.toThrow();
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

    it('does not throw when plugin has no deactivate hook', async () => {
      const { emit } = makeEmit();
      const registry = new PluginRegistry(emit);
      registry.register(makePlugin('my-plugin'));
      registry.setState('my-plugin', 'active');

      await expect(registry.unregister('my-plugin')).resolves.toBeUndefined();
    });
  });
});
