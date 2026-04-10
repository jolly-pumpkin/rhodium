import { describe, it, expect } from 'bun:test';
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
});
