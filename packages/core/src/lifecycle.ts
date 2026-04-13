import {
  ActivationError,
  ActivationTimeoutError,
  CapabilityNotFoundError,
  CapabilityViolationError,
  UndeclaredCapabilityError,
  type RhodiumError,
} from './errors.js';
import { createCapabilityValidator } from '../../../packages/capabilities/src/index.js';
import type {
  ActivationResult,
  BrokerEventPayload,
  CapabilityDeclaration,
  CapabilityResolver,
  CommandHandler,
  DependencyDeclaration,
  DependencyGraph,
  ErrorSeverity,
  Plugin,
  PluginContext,
  PluginLogger,
  PluginState,
  PluginStatus,
} from './types.js';
import type { EventBus } from './events.js';
import type { PluginRegistry } from './registry.js';

export interface LifecycleManagerOpts {
  registry: PluginRegistry;
  graph: DependencyGraph;
  resolver: CapabilityResolver;
  eventBus: EventBus;
  timeoutMs?: number;
  onUnhandledError?: (error: Error) => void;
}

export function createLifecycleManager(opts: LifecycleManagerOpts) {
  const { registry, graph, resolver, eventBus, onUnhandledError } = opts;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  // Shared state across all activations
  const implementations = new Map<string, unknown>();
  const commandHandlers = new Map<string, CommandHandler>();
  const commandHandlersByPlugin = new Map<string, Set<string>>();
  const activeCapabilitiesByPlugin = new Map<string, Set<string>>();
  let registrationIndex = 0;
  let lastActivationOrder: string[] = [];

  // ── Emit helper ──────────────────────────────────────────────────────────

  function emitEvent(event: BrokerEventPayload['event'], pluginKey?: string, extra?: { capability?: string; detail?: unknown }): void {
    eventBus.emit(event, {
      timestamp: Date.now(),
      event,
      pluginKey,
      capability: extra?.capability,
      detail: extra?.detail,
    });
  }

  // ── Shared resolve helpers ──────────────────────────────────────────────

  function listAvailableCapabilities(): string[] {
    const set = new Set<string>();
    for (const key of implementations.keys()) {
      const idx = key.indexOf(':');
      if (idx >= 0) set.add(key.slice(idx + 1));
    }
    return [...set].sort();
  }

  function resolveImpl<T>(
    capability: string,
    neededBy: string,
    neededByVersion: string,
  ): T {
    const entry = resolver.resolve(
      { capability, optional: true },
      neededBy,
      neededByVersion,
    );
    if (!entry) {
      throw new CapabilityNotFoundError(
        capability,
        neededBy,
        neededByVersion,
        listAvailableCapabilities(),
      );
    }
    const impl = implementations.get(`${entry.pluginKey}:${capability}`);
    if (impl === undefined) {
      throw new Error(
        `No implementation found for capability '${capability}' from provider '${entry.pluginKey}'`
      );
    }
    return impl as T;
  }

  function resolveAllImpl<T>(
    capability: string,
    neededBy: string,
    neededByVersion: string,
  ): T[] {
    const entries = resolver.resolveMany(
      { capability, multiple: true, optional: true },
      neededBy,
      neededByVersion,
    );
    return entries
      .map((e) => implementations.get(`${e.pluginKey}:${capability}`) as T | undefined)
      .filter((v): v is T => v !== undefined);
  }

  function resolveOptionalImpl<T>(
    capability: string,
    neededBy: string,
    neededByVersion: string,
  ): T | undefined {
    const entry = resolver.resolve({ capability, optional: true }, neededBy, neededByVersion);
    if (!entry) return undefined;
    return (implementations.get(`${entry.pluginKey}:${capability}`) ?? undefined) as T | undefined;
  }

  function createPluginContext(pluginKey: string, plugin: Plugin): PluginContext {
    return {
      pluginKey,
      log: createPluginLogger(pluginKey),

      resolve<T>(capability: string): T {
        return resolveImpl<T>(capability, pluginKey, plugin.version);
      },

      resolveAll<T>(capability: string): T[] {
        return resolveAllImpl<T>(capability, pluginKey, plugin.version);
      },

      resolveOptional<T>(capability: string): T | undefined {
        return resolveOptionalImpl<T>(capability, pluginKey, plugin.version);
      },

      provide<T>(capability: string, implementation: T): void {
        const decl = plugin.manifest.provides.find((p) => p.capability === capability);

        if (!decl) {
          throw new UndeclaredCapabilityError(pluginKey, capability);
        }

        // Validate against contract schema if declared
        if (decl.contract) {
          const violations = createCapabilityValidator().validate(decl.contract, implementation);
          if (violations.length > 0) {
            throw new CapabilityViolationError(pluginKey, capability, violations);
          }
        }

        const priority = decl.priority ?? 0;
        const variant = decl.variant ?? undefined;

        const providerDecl: CapabilityDeclaration = { capability, priority, variant };
        resolver.registerProvider(pluginKey, providerDecl, registrationIndex++);
        implementations.set(`${pluginKey}:${capability}`, implementation);

        // Track active capabilities per plugin
        let caps = activeCapabilitiesByPlugin.get(pluginKey);
        if (!caps) {
          caps = new Set();
          activeCapabilitiesByPlugin.set(pluginKey, caps);
        }
        caps.add(capability);

        emitEvent('capability:provided', pluginKey, { capability });
      },

      registerCommand(commandName: string, handler: CommandHandler): void {
        commandHandlers.set(commandName, handler);
        let owned = commandHandlersByPlugin.get(pluginKey);
        if (!owned) {
          owned = new Set();
          commandHandlersByPlugin.set(pluginKey, owned);
        }
        owned.add(commandName);
      },

      reportError(error: Error, severity?: ErrorSeverity): void {
        emitEvent('plugin:error', pluginKey, { detail: { error, severity: severity ?? 'error' } });
      },

      emit(event: string, payload?: unknown): void {
        eventBus.emit(event, {
          timestamp: Date.now(),
          event,
          detail: payload,
        });
      },
    };
  }

  function createPluginLogger(pluginKey: string): PluginLogger {
    const prefix = `[${pluginKey}]`;
    return {
      debug: (message, data) => console.debug(prefix, message, data ?? ''),
      info: (message, data) => console.info(prefix, message, data ?? ''),
      warn: (message, data) => console.warn(prefix, message, data ?? ''),
      error: (message, _error, data) => console.error(prefix, message, data ?? ''),
    };
  }

  function computeWaves(order: string[]): string[][] {
    const waveOf = new Map<string, number>();

    for (const pluginKey of order) {
      const checks = graph.checkDependencies(pluginKey);
      let myWave = 0;

      for (const check of checks) {
        if (check.availableProviders.length === 0) continue;
        const providerWaves = check.availableProviders
          .filter((p) => waveOf.has(p))
          .map((p) => waveOf.get(p)!);
        if (providerWaves.length > 0) {
          myWave = Math.max(myWave, Math.min(...providerWaves) + 1);
        }
      }

      waveOf.set(pluginKey, myWave);
    }

    const waves: string[][] = [];
    for (const pluginKey of order) {
      const w = waveOf.get(pluginKey)!;
      if (!waves[w]) {
        waves[w] = [];
      }
      waves[w].push(pluginKey);
    }

    return waves;
  }

  function shouldSkip(pluginKey: string, failedSet: Set<string>): boolean {
    const plugin = registry.getPlugin(pluginKey);
    if (!plugin) return true;

    for (const dep of plugin.manifest.needs) {
      if (dep.optional) continue;

      const checks = graph.checkDependencies(pluginKey);
      const check = checks.find((c) => c.capability === dep.capability);

      if (!check || check.availableProviders.length === 0) {
        return true;
      }

      if (check.availableProviders.every((p) => failedSet.has(p))) {
        return true;
      }
    }

    return false;
  }

  function getUnmetDependencies(pluginKey: string, failedSet: Set<string>): string[] {
    const plugin = registry.getPlugin(pluginKey);
    if (!plugin) return [];

    const unmet: string[] = [];
    for (const dep of plugin.manifest.needs) {
      if (dep.optional) continue;

      const checks = graph.checkDependencies(pluginKey);
      const check = checks.find((c) => c.capability === dep.capability);

      if (!check || check.availableProviders.length === 0) {
        unmet.push(dep.capability);
      } else if (check.availableProviders.every((p) => failedSet.has(p))) {
        unmet.push(dep.capability);
      }
    }

    return unmet;
  }

  async function activateSingle(
    pluginKey: string,
    activated: string[],
    failed: Array<{ pluginKey: string; error: RhodiumError }>,
    failedSet: Set<string>
  ): Promise<void> {
    const plugin = registry.getPlugin(pluginKey);
    if (!plugin) return;

    registry.setState(pluginKey, 'resolving');
    emitEvent('plugin:activating', pluginKey);

    const start = Date.now();
    const ctx = createPluginContext(pluginKey, plugin);

    try {
      if (plugin.activate) {
        let timerId: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          Promise.resolve().then(() => plugin.activate!(ctx)),
          new Promise<never>((_, reject) => {
            timerId = setTimeout(
              () => reject(new ActivationTimeoutError(pluginKey, timeoutMs)),
              timeoutMs
            );
          }),
        ]);
        if (timerId) clearTimeout(timerId);
      }

      registry.setState(pluginKey, 'active');
      const durationMs = Date.now() - start;
      emitEvent('plugin:activated', pluginKey, { detail: { durationMs } });
      activated.push(pluginKey);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const wrappedError =
        error instanceof ActivationTimeoutError ||
        error instanceof ActivationError ||
        error instanceof CapabilityNotFoundError ||
        error instanceof UndeclaredCapabilityError ||
        error instanceof CapabilityViolationError
          ? (error as RhodiumError)
          : new ActivationError(pluginKey, error);

      registry.setState(pluginKey, 'failed');
      failedSet.add(pluginKey);
      failed.push({ pluginKey, error: wrappedError });
      emitEvent('plugin:error', pluginKey, { detail: { error: wrappedError } });
      onUnhandledError?.(wrappedError);

      throw wrappedError;
    }
  }

  /** Build a rich PluginState for a given plugin. */
  function buildPluginState(pluginKey: string): PluginState | undefined {
    const plugin = registry.getPlugin(pluginKey);
    const status = registry.getState(pluginKey);
    if (!plugin || !status) return undefined;

    const caps = activeCapabilitiesByPlugin.get(pluginKey);
    const cmds = commandHandlersByPlugin.get(pluginKey);

    const deps: PluginState['dependencies'] = plugin.manifest.needs.map((dep) => {
      const entry = resolver.resolve(
        { capability: dep.capability, optional: true, variant: dep.variant },
        pluginKey,
        plugin.version,
      );
      return {
        capability: dep.capability,
        optional: dep.optional ?? false,
        resolved: entry !== undefined,
        providerKey: entry?.pluginKey,
      };
    });

    return {
      key: pluginKey,
      version: plugin.version,
      status,
      activeCapabilities: caps ? [...caps] : [],
      registeredCommands: cmds ? [...cmds] : [],
      dependencies: deps,
      lastTransition: Date.now(),
      error: undefined, // TODO: track per-plugin error
    };
  }

  return {
    async activate(): Promise<ActivationResult> {
      const start = Date.now();
      const activated: string[] = [];
      const failed: Array<{ pluginKey: string; error: RhodiumError }> = [];
      const pending: Array<{ pluginKey: string; unmetDependencies: string[] }> = [];
      const failedSet = new Set<string>();

      const order = graph.getActivationOrder();
      lastActivationOrder = order;
      const waves = computeWaves(order);

      for (const wave of waves) {
        const toActivate = wave.filter((key) => !shouldSkip(key, failedSet));
        const skipped = wave.filter((key) => shouldSkip(key, failedSet));
        for (const pluginKey of skipped) {
          pending.push({
            pluginKey,
            unmetDependencies: getUnmetDependencies(pluginKey, failedSet),
          });
        }

        const results = await Promise.allSettled(
          toActivate.map((key) => activateSingle(key, activated, failed, failedSet))
        );

        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          if (result && result.status === 'rejected') {
            failedSet.add(toActivate[i]);
          }
        }
      }

      const durationMs = Date.now() - start;
      emitEvent('broker:activated', undefined, { detail: { pluginCount: activated.length, durationMs } });

      return { activated, failed, pending, durationMs };
    },

    async deactivate(): Promise<void> {
      const reverseOrder = [...lastActivationOrder].reverse();
      const activeKeys = reverseOrder.filter((k) => registry.getState(k) === 'active');

      let count = 0;
      for (const pluginKey of activeKeys) {
        const plugin = registry.getPlugin(pluginKey);
        emitEvent('plugin:deactivating', pluginKey);

        try {
          await plugin?.deactivate?.();
        } catch (err) {
          onUnhandledError?.(err instanceof Error ? err : new Error(String(err)));
        }

        registry.setState(pluginKey, 'inactive');
        resolver.unregisterPlugin(pluginKey);

        // Remove implementations and emit capability:removed for each
        const caps = activeCapabilitiesByPlugin.get(pluginKey);
        if (caps) {
          for (const capability of caps) {
            implementations.delete(`${pluginKey}:${capability}`);
            emitEvent('capability:removed', pluginKey, { capability });
          }
          activeCapabilitiesByPlugin.delete(pluginKey);
        }

        // Remove command handlers
        const ownedCommands = commandHandlersByPlugin.get(pluginKey);
        if (ownedCommands) {
          for (const cmd of ownedCommands) commandHandlers.delete(cmd);
          commandHandlersByPlugin.delete(pluginKey);
        }

        emitEvent('plugin:deactivated', pluginKey);
        count++;
      }

      emitEvent('broker:deactivated', undefined, { detail: { pluginCount: count } });
    },

    async activatePlugin(pluginKey: string): Promise<ActivationResult> {
      const start = Date.now();
      const plugin = registry.getPlugin(pluginKey);
      if (!plugin) {
        throw new Error(`Plugin '${pluginKey}' not registered`);
      }

      const state = registry.getState(pluginKey);
      if (state === 'active') {
        return { activated: [pluginKey], failed: [], pending: [], durationMs: 0 };
      }

      // Register plugin in graph for consistent ordering (hot registration)
      const provides = plugin.manifest.provides.map((p) => p.capability);
      const needs = plugin.manifest.needs.map((d) => d.capability);
      graph.addPlugin(pluginKey, provides, needs);

      // Check that all required deps are satisfied
      for (const dep of plugin.manifest.needs) {
        if (dep.optional) continue;
        resolver.resolve(dep as DependencyDeclaration, pluginKey, plugin.version);
      }

      const activated: string[] = [];
      const failed: Array<{ pluginKey: string; error: RhodiumError }> = [];
      const failedSet = new Set<string>();

      await activateSingle(pluginKey, activated, failed, failedSet);

      if (!lastActivationOrder.includes(pluginKey)) {
        lastActivationOrder.push(pluginKey);
      }

      const durationMs = Date.now() - start;
      return { activated, failed, pending: [], durationMs };
    },

    /**
     * Drain all lifecycle-owned state for a plugin: implementations,
     * command handlers. Used by the broker's `unregister()`.
     */
    purgePlugin(pluginKey: string): void {
      const caps = activeCapabilitiesByPlugin.get(pluginKey);
      if (caps) {
        for (const capability of caps) {
          implementations.delete(`${pluginKey}:${capability}`);
          emitEvent('capability:removed', pluginKey, { capability });
        }
        activeCapabilitiesByPlugin.delete(pluginKey);
      }

      // Also clean up any remaining implementations
      for (const key of Array.from(implementations.keys())) {
        if (key.startsWith(`${pluginKey}:`)) {
          implementations.delete(key);
        }
      }

      const ownedCommands = commandHandlersByPlugin.get(pluginKey);
      if (ownedCommands) {
        for (const cmd of ownedCommands) commandHandlers.delete(cmd);
        commandHandlersByPlugin.delete(pluginKey);
      }
    },

    /** Build rich PluginState objects for all plugins. */
    getPluginStates(): Map<string, PluginState> {
      const result = new Map<string, PluginState>();
      for (const plugin of registry.getAllPlugins()) {
        const state = buildPluginState(plugin.key);
        if (state) result.set(plugin.key, state);
      }
      return result;
    },

    /** Broker-level capability resolution. */
    resolve: resolveImpl,
    resolveAll: resolveAllImpl,
    resolveOptional: resolveOptionalImpl,
  };
}
