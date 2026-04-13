import type { Plugin, PluginStatus, BrokerEventPayload } from './types.js';
import { DuplicatePluginError } from './errors.js';

type EmitFn = (payload: BrokerEventPayload) => void;

export class PluginRegistry {
  readonly #plugins = new Map<string, Plugin>();
  readonly #states  = new Map<string, PluginStatus>();
  readonly #emit: EmitFn;

  constructor(emit: EmitFn) {
    this.#emit = emit;
  }

  register(plugin: Plugin): void {
    if (this.#plugins.has(plugin.key)) {
      throw new DuplicatePluginError(plugin.key);
    }

    this.#plugins.set(plugin.key, plugin);
    this.#states.set(plugin.key, 'registered');

    this.#emit({
      timestamp: Date.now(),
      event: 'plugin:registered',
      pluginKey: plugin.key,
    });
  }

  getPlugin(pluginKey: string): Plugin | undefined {
    return this.#plugins.get(pluginKey);
  }

  getState(pluginKey: string): PluginStatus | undefined {
    return this.#states.get(pluginKey);
  }

  setState(pluginKey: string, state: PluginStatus): void {
    if (!this.#plugins.has(pluginKey)) return;
    this.#states.set(pluginKey, state);
  }

  getPluginStates(): Map<string, PluginStatus> {
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
      try {
        await plugin.deactivate?.();
      } catch {
        // deactivate() errors do not prevent registry cleanup
      }
    }

    this.#plugins.delete(pluginKey);
    this.#states.delete(pluginKey);

    this.#emit({
      timestamp: Date.now(),
      event: 'plugin:unregistered',
      pluginKey,
    });
  }
}
