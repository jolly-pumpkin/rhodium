import type {
  Broker,
  BrokerConfig,
  BrokerEvent,
  BrokerEventHandler,
  BrokerLogEntry,
  BrokerLogFilter,
  Plugin,
  PluginState,
  ActivationResult,
  AssembledContext,
  ContextRequest,
  ToolSearchFilter,
  ToolSearchResult,
} from './types.js';
import { CircularDependencyError } from './errors.js';
import { PluginRegistry } from './registry.js';
import { createEventBus } from './events.js';
import { createLifecycleManager } from './lifecycle.js';
// Cross-package imports use relative source paths to match the existing
// pattern in `lifecycle.ts` (and `types.ts`). Declaring `rhodium-graph` etc.
// as workspace dependencies would create a package-level dependency cycle
// (core ↔ graph/context/budget/discovery), whereas the relative imports work
// at bundle time without any runtime circularity.
import {
  createDependencyGraph,
  createCapabilityResolver,
} from '../../../packages/graph/src/index.js';
import {
  createSearchIndex,
  searchTools as runSearchTools,
} from '../../../packages/discovery/src/index.js';
import type { ToolSearchContext } from '../../../packages/discovery/src/search.js';
import { createPipeline } from '../../../packages/context/src/pipeline.js';
import { collectMiddleware } from '../../../packages/context/src/middleware.js';
import {
  createTokenCounter,
  type TokenCounter,
} from '../../../packages/budget/src/index.js';

/**
 * All broker events the log subscribes to. Keeping this list explicit (rather
 * than deriving it at runtime) preserves type safety for `eventBus.on` and
 * makes adding new events a compile-time concern.
 */
const BROKER_EVENTS: readonly BrokerEvent[] = [
  'plugin:registered',
  'plugin:unregistered',
  'plugin:activating',
  'plugin:activated',
  'plugin:deactivating',
  'plugin:deactivated',
  'plugin:error',
  'plugin:failed',
  'broker:activated',
  'broker:deactivated',
  'context:assembled',
  'budget:overflow',
  'capability:resolved',
  'tool:executed',
  'tool:error',
];

const BROKER_NEEDED_BY = '<broker>';
const BROKER_VERSION = '0.0.0';

/**
 * Compose every subsystem into a single `Broker` instance. All mutable state
 * lives inside this closure — no module-level singletons, so multiple brokers
 * in the same process are fully independent (ADR-009).
 */
export function createBroker(config: BrokerConfig = {}): Broker {
  // ── Defaults (ticket overrides the pipeline's chars4 default) ───────
  const activationTimeoutMs = config.activationTimeoutMs ?? 30_000;
  const maxContributionBytes = config.maxContributionBytes ?? 262_144;
  const debug = config.debug ?? false;
  const lazyActivation = config.lazyActivation ?? false;

  const tokenCounterOpt = config.tokenCounter ?? 'chars3';
  const tokenCounter: TokenCounter =
    typeof tokenCounterOpt === 'function'
      ? tokenCounterOpt
      : createTokenCounter(tokenCounterOpt);
  const tokenCounterName =
    typeof tokenCounterOpt === 'string' ? tokenCounterOpt : 'custom';

  // ── Subsystems ───────────────────────────────────────────────────────
  const eventBus = createEventBus();
  const registry = new PluginRegistry((event, payload) =>
    eventBus.emit(event, payload),
  );
  const graph = createDependencyGraph();
  const resolver = createCapabilityResolver();
  const searchIndex = createSearchIndex();
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

  // ── Structured log buffer (subscribed before anything else) ─────────
  const logEntries: BrokerLogEntry[] = [];
  for (const ev of BROKER_EVENTS) {
    eventBus.on(ev, (payload: unknown) => {
      const p = payload as { pluginKey?: string } | undefined;
      const entry: BrokerLogEntry = {
        timestamp: Date.now(),
        event: ev,
      };
      if (p?.pluginKey !== undefined) entry.pluginKey = p.pluginKey;
      if (payload !== undefined) {
        entry.data = payload as Record<string, unknown>;
      }
      logEntries.push(entry);
      if (debug) {
        // eslint-disable-next-line no-console
        console.debug('[broker]', ev, payload);
      }
    });
  }

  // ── Lazy activation helper ──────────────────────────────────────────
  function ensureLazilyActivated(): void {
    // Walk plugins in topological (dep-before-dependent) order so a consumer
    // registered before its provider still sees the provider activated first.
    // `graph.canActivate` only checks that providers exist in the graph —
    // NOT that they are already `active` — so iterating in registration order
    // would let us activate a consumer whose provider hadn't run `ctx.provide()`
    // yet, and `ctx.resolve()` would fail inside the consumer's activate().
    //
    // Errors from `activatePluginSync` propagate out — callers of
    // `assembleContext()` get a descriptive failure (e.g. async activate in
    // lazy mode). This matches the documented "sync-activate-or-throw"
    // constraint on lazy activation.
    const order = graph.getActivationOrder();
    for (const pluginKey of order) {
      if (registry.getState(pluginKey) !== 'registered') continue;
      if (!graph.canActivate(pluginKey)) continue;
      lifecycle.activatePluginSync(pluginKey);
    }
  }

  function getActivePluginsMaybeLazy(): Plugin[] {
    if (lazyActivation) ensureLazilyActivated();
    return registry
      .getAllPlugins()
      .filter((p) => registry.getState(p.key) === 'active');
  }

  // ── Pipeline (created once; reads active plugins on each assemble) ──
  const pipeline = createPipeline({
    getActivePlugins: getActivePluginsMaybeLazy,
    eventBus,
    searchIndex,
    getMiddlewares: () => collectMiddleware(getActivePluginsMaybeLazy()),
    tokenCounter,
    tokenCounterName,
    maxContributionBytes,
    ...(config.defaultTokenBudget !== undefined
      ? { defaultTokenBudget: config.defaultTokenBudget }
      : {}),
  });

  // ── Broker facade ────────────────────────────────────────────────────
  return {
    register(plugin: Plugin): void {
      registry.register(plugin); // throws Duplicate*Error
      const provides = plugin.manifest.provides.map((p) => p.capability);
      const needs = plugin.manifest.needs.map((d) => d.capability);
      try {
        graph.addPlugin(plugin.key, provides, needs);
      } catch (err) {
        // Plugin is still in 'registered' state — registry.unregister won't
        // await anything (no deactivate hook runs). The async return is safe
        // to void here because unregister only awaits plugin.deactivate()
        // for active/resolving plugins.
        void registry.unregister(plugin.key);
        // The graph package imports its error class from a bundled dist copy
        // of rhodium-core, so the `CircularDependencyError` thrown by graph
        // is a DIFFERENT constructor than the one exported from this package's
        // source. Re-throw as the local class (reading the `cycle` field
        // directly off the foreign error) so `instanceof` checks work for
        // callers importing from the source tree.
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
      searchIndex.addPlugin(plugin.key, plugin.manifest);
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
              dep.onDependencyRemoved(cap);
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
      searchIndex.removePlugin(pluginKey);
      lifecycle.purgePlugin(pluginKey);
    },

    async activate(): Promise<ActivationResult> {
      if (lazyActivation) {
        const pending = registry
          .getAllPlugins()
          .map((p) => ({ pluginKey: p.key, unmetDependencies: [] as string[] }));
        eventBus.emit('broker:activated', {
          pluginCount: 0,
          durationMs: 0,
        });
        return { activated: [], failed: [], pending, durationMs: 0 };
      }
      return lifecycle.activate();
    },

    deactivate(): Promise<void> {
      return lifecycle.deactivate();
    },

    activatePlugin(pluginKey: string): Promise<void> {
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

    searchTools(query: string | ToolSearchFilter): ToolSearchResult[] {
      const activatedPlugins = new Set<string>();
      for (const [key, state] of registry.getPluginStates()) {
        if (state === 'active') activatedPlugins.add(key);
      }
      const ctx: ToolSearchContext = { activatedPlugins };
      if (typeof query === 'object' && query.capability) {
        const providers = new Set(
          resolver
            .resolveMany(
              {
                capability: query.capability,
                multiple: true,
                optional: true,
              },
              BROKER_NEEDED_BY,
              BROKER_VERSION,
            )
            .map((e) => e.pluginKey),
        );
        ctx.capabilityFilter = (key: string) => providers.has(key);
      }
      return runSearchTools(searchIndex, query, ctx);
    },

    assembleContext<TState = unknown>(
      request?: ContextRequest<TState>,
    ): AssembledContext {
      return pipeline.assembleContext(request);
    },

    on<E extends BrokerEvent>(
      event: E,
      handler: BrokerEventHandler<E>,
    ): () => void {
      return eventBus.on(event, handler);
    },

    getLog(filter?: BrokerLogFilter) {
      const entries = logEntries.filter((e) => {
        if (filter?.event && e.event !== filter.event) return false;
        if (filter?.pluginKey && e.pluginKey !== filter.pluginKey) return false;
        if (filter?.since !== undefined && e.timestamp < filter.since) return false;
        return true;
      });
      return { entries: [...entries] };
    },

    getPluginStates(): Map<string, PluginState> {
      return registry.getPluginStates();
    },
  };
}
