import type { Plugin, PluginState, BrokerEvent, BrokerEventPayload } from './types.js';
import { DuplicatePluginError, DuplicateToolError } from './errors.js';

type EmitFn = <E extends BrokerEvent>(event: E, payload: BrokerEventPayload[E]) => void;

export class PluginRegistry {
  readonly #plugins   = new Map<string, Plugin>();
  readonly #states    = new Map<string, PluginState>();
  readonly #toolIndex = new Map<string, string>();
  readonly #emit: EmitFn;

  constructor(emit: EmitFn) {
    this.#emit = emit;
  }

  register(plugin: Plugin): void {
    if (this.#plugins.has(plugin.key)) {
      throw new DuplicatePluginError(plugin.key);
    }

    const newToolEntries: Array<[string, string]> = [];
    for (const tool of plugin.manifest.tools) {
      const existing = this.#toolIndex.get(tool.name);
      if (existing) throw new DuplicateToolError(tool.name, existing, plugin.key);
      newToolEntries.push([tool.name, plugin.key]);
    }

    this.#plugins.set(plugin.key, plugin);
    this.#states.set(plugin.key, 'registered');
    for (const [name, key] of newToolEntries) {
      this.#toolIndex.set(name, key);
    }

    this.#emit('plugin:registered', { pluginKey: plugin.key });
  }

  getPlugin(pluginKey: string): Plugin | undefined {
    return this.#plugins.get(pluginKey);
  }

  getState(pluginKey: string): PluginState | undefined {
    return this.#states.get(pluginKey);
  }

  setState(pluginKey: string, state: PluginState): void {
    if (!this.#plugins.has(pluginKey)) return;
    this.#states.set(pluginKey, state);
  }

  getPluginStates(): Map<string, PluginState> {
    return new Map(this.#states);
  }

  getAllPlugins(): Plugin[] {
    return Array.from(this.#plugins.values());
  }

  async unregister(pluginKey: string): Promise<void> {
    const plugin = this.#plugins.get(pluginKey);
    if (!plugin) return;

    const state = this.#states.get(pluginKey);
    if (state === 'active' || state === 'resolving') {
      await plugin.deactivate?.();
    }

    this.#states.set(pluginKey, 'unregistered');
    this.#plugins.delete(pluginKey);
    this.#states.delete(pluginKey);
    for (const tool of plugin.manifest.tools) {
      this.#toolIndex.delete(tool.name);
    }

    this.#emit('plugin:unregistered', { pluginKey });
  }
}
