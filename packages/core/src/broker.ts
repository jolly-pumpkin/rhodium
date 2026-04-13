import type {
  Broker,
  BrokerConfig,
  BrokerEvent,
  BrokerEventHandler,
  BrokerEventPayload,
  BrokerLog,
  BrokerLogEntry,
  Plugin,
  PluginManifest,
  PluginState,
  ActivationResult,
} from './types.js';
import { CircularDependencyError } from './errors.js';
import { PluginRegistry } from './registry.js';
import { createEventBus } from './events.js';
import { createLifecycleManager } from './lifecycle.js';
import {
  createDependencyGraph,
  createCapabilityResolver,
} from '../../../packages/graph/src/index.js';

/**
 * All broker events the log subscribes to.
 */
const BROKER_EVENTS: readonly BrokerEvent[] = [
  'plugin:registered',
  'plugin:unregistered',
  'plugin:activating',
  'plugin:activated',
  'plugin:deactivating',
  'plugin:deactivated',
  'plugin:error',
  'capability:provided',
  'capability:removed',
  'dependency:resolved',
  'dependency:unresolved',
  'broker:activated',
  'broker:deactivated',
];

const BROKER_NEEDED_BY = '<broker>';
const BROKER_VERSION = '0.0.0';

/**
 * Compose every subsystem into a single `Broker` instance. All mutable state
 * lives inside this closure — no module-level singletons, so multiple brokers
 * in the same process are fully independent (ADR-008).
 */
export function createBroker(config: BrokerConfig = {}): Broker {
  const activationTimeoutMs = config.activationTimeoutMs ?? 30_000;
  const debug = config.debug ?? false;

  // ── Subsystems ───────────────────────────────────────────────────────
  const eventBus = createEventBus();
  const registry = new PluginRegistry((payload) =>
    eventBus.emit(payload.event, payload),
  );
  const graph = createDependencyGraph();
  const resolver = createCapabilityResolver();
  const lifecycle = createLifecycleManager({
    registry,
    graph,
    resolver,
    eventBus,
    timeoutMs: activationTimeoutMs,
    ...(config.onUnhandledError !== undefined
      ? { onUnhandledError: config.onUnhandledError }
      : {}),
  });

  // ── Structured log buffer ──────────────────────────────────────────
  const logEntries: BrokerLogEntry[] = [];
  for (const ev of BROKER_EVENTS) {
    eventBus.on(ev, (payload: unknown) => {
      const p = payload as BrokerEventPayload | undefined;
      const entry: BrokerLogEntry = {
        timestamp: p?.timestamp ?? Date.now(),
        event: ev,
        pluginKey: p?.pluginKey,
        message: `${ev}${p?.pluginKey ? ` [${p.pluginKey}]` : ''}`,
        data: p ? { ...p } : undefined,
      };
      logEntries.push(entry);
      if (debug) {
        console.debug('[broker]', ev, payload);
      }
    });
  }

  // ── Broker facade ────────────────────────────────────────────────────
  return {
    register(plugin: Plugin): void {
      registry.register(plugin);
      const provides = plugin.manifest.provides.map((p) => p.capability);
      const needs = plugin.manifest.needs.map((d) => d.capability);
      try {
        graph.addPlugin(plugin.key, provides, needs);
      } catch (err) {
        void registry.unregister(plugin.key);
        if (
          err &&
          typeof err === 'object' &&
          (err as { code?: string }).code === 'CIRCULAR_DEPENDENCY'
        ) {
          const foreign = err as { cycle?: readonly string[] };
          const cycle =
            Array.isArray(foreign.cycle) && foreign.cycle.length > 0
              ? [...foreign.cycle]
              : [plugin.key];
          throw new CircularDependencyError(cycle);
        }
        throw err;
      }
    },

    async unregister(pluginKey: string): Promise<void> {
      if (registry.getState(pluginKey) === undefined) return;
      const plugin = registry.getPlugin(pluginKey);
      if (plugin) {
        const dependents = graph.getDependents(pluginKey);
        const providedCaps = plugin.manifest.provides.map((p) => p.capability);
        for (const depKey of dependents) {
          const dep = registry.getPlugin(depKey);
          if (!dep?.onDependencyRemoved) continue;
          for (const cap of providedCaps) {
            try {
              dep.onDependencyRemoved(cap, pluginKey);
            } catch (err) {
              config.onUnhandledError?.(
                err instanceof Error ? err : new Error(String(err)),
              );
            }
          }
        }
      }
      await registry.unregister(pluginKey);
      graph.removePlugin(pluginKey);
      resolver.unregisterPlugin(pluginKey);
      lifecycle.purgePlugin(pluginKey);
    },

    async activate(): Promise<ActivationResult> {
      return lifecycle.activate();
    },

    deactivate(): Promise<void> {
      return lifecycle.deactivate();
    },

    activatePlugin(pluginKey: string): Promise<ActivationResult> {
      return lifecycle.activatePlugin(pluginKey);
    },

    resolve<T>(capability: string): T {
      return lifecycle.resolve<T>(capability, BROKER_NEEDED_BY, BROKER_VERSION);
    },

    resolveAll<T>(capability: string): T[] {
      return lifecycle.resolveAll<T>(capability, BROKER_NEEDED_BY, BROKER_VERSION);
    },

    resolveOptional<T>(capability: string): T | undefined {
      return lifecycle.resolveOptional<T>(
        capability,
        BROKER_NEEDED_BY,
        BROKER_VERSION,
      );
    },

    getManifests(): Map<string, PluginManifest> {
      const result = new Map<string, PluginManifest>();
      for (const plugin of registry.getAllPlugins()) {
        result.set(plugin.key, plugin.manifest);
      }
      return result;
    },

    getManifest(pluginKey: string): PluginManifest | undefined {
      return registry.getPlugin(pluginKey)?.manifest;
    },

    getPluginStates(): Map<string, PluginState> {
      return lifecycle.getPluginStates();
    },

    on(event: BrokerEvent, handler: BrokerEventHandler): () => void {
      return eventBus.on(event, handler as (payload: unknown) => void);
    },

    getLog(): BrokerLog {
      const entries = [...logEntries];
      return {
        entries,
        filter(event: BrokerEvent | string): BrokerLogEntry[] {
          return entries.filter((e) => e.event === event);
        },
        forPlugin(pluginKey: string): BrokerLogEntry[] {
          return entries.filter((e) => e.pluginKey === pluginKey);
        },
        pendingDependencies: (() => {
          const pending: Array<{ pluginKey: string; capability: string; optional: boolean }> = [];
          for (const plugin of registry.getAllPlugins()) {
            const state = registry.getState(plugin.key);
            if (state === 'active') continue;
            for (const dep of plugin.manifest.needs) {
              const entry = resolver.resolve(
                { capability: dep.capability, optional: true, variant: dep.variant },
                plugin.key,
                plugin.version,
              );
              if (!entry) {
                pending.push({
                  pluginKey: plugin.key,
                  capability: dep.capability,
                  optional: dep.optional ?? false,
                });
              }
            }
          }
          return pending;
        })(),
      };
    },
  };
}
