import {
  ActivationError,
  ActivationTimeoutError,
  CapabilityNotFoundError,
  CapabilityViolationError,
  UndeclaredCapabilityError,
  UndeclaredToolError,
} from './errors.js';
import { createCapabilityValidator } from '../../../packages/capabilities/src/index.js';
import type {
  ActivationResult,
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
  ToolHandler,
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
  const toolHandlers = new Map<string, ToolHandler>();
  const toolHandlersByPlugin = new Map<string, Set<string>>();
  const commandHandlers = new Map<string, CommandHandler>();
  const commandHandlersByPlugin = new Map<string, Set<string>>();
  let registrationIndex = 0;
  let lastActivationOrder: string[] = [];

  // ── Shared resolve helpers ──────────────────────────────────────────────
  // Extracted from createPluginContext so both the plugin-facing context and
  // the broker-facing facade can share the same lookup path.

  /**
   * Collect the set of capability names currently backed by an implementation.
   * Drives the "Available capabilities in this broker" section of
   * `CapabilityNotFoundError` when a lookup misses.
   */
  function listAvailableCapabilities(): string[] {
    const set = new Set<string>();
    for (const key of implementations.keys()) {
      // keys are `${pluginKey}:${capability}` — split on the first ':'.
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
    // Pass `optional: true` so the resolver returns undefined instead of
    // throwing its own CapabilityNotFoundError. We then throw the local class
    // directly — this keeps the error observable as an instance of the local
    // `CapabilityNotFoundError`, regardless of whether the resolver came from
    // a bundled dist copy or source.
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
        // Find priority and variant from manifest.provides
        const decl = plugin.manifest.provides.find((p) => p.capability === capability);

        // Criterion 2: throw if not declared in manifest
        if (!decl) {
          throw new UndeclaredCapabilityError(pluginKey, capability);
        }

        // Criterion 3: validate against contract schema if declared
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
      },

      registerToolHandler(toolName: string, handler: ToolHandler): void {
        // Criterion 4: throw if tool not declared in manifest
        if (!plugin.manifest.tools.some((t) => t.name === toolName)) {
          throw new UndeclaredToolError(pluginKey, toolName);
        }
        toolHandlers.set(toolName, handler);
        let owned = toolHandlersByPlugin.get(pluginKey);
        if (!owned) {
          owned = new Set();
          toolHandlersByPlugin.set(pluginKey, owned);
        }
        owned.add(toolName);
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
        eventBus.emit('plugin:error', { pluginKey, error, severity: severity ?? 'error' });
      },

      emit(event, payload) {
        eventBus.emit(event, payload);
      },
    };
  }

  function createPluginLogger(pluginKey: string): PluginLogger {
    const prefix = `[${pluginKey}]`;
    return {
      debug: (message, data) => console.debug(prefix, message, data ?? ''),
      info: (message, data) => console.info(prefix, message, data ?? ''),
      warn: (message, data) => console.warn(prefix, message, data ?? ''),
      error: (message, data) => console.error(prefix, message, data ?? ''),
    };
  }

  function computeWaves(order: string[]): string[][] {
    const waveOf = new Map<string, number>();

    for (const pluginKey of order) {
      const checks = graph.checkDependencies(pluginKey);
      let myWave = 0;

      for (const check of checks) {
        if (check.availableProviders.length === 0) {
          // No providers for this capability yet
          continue;
        }
        const providerWaves = check.availableProviders
          .filter((p) => waveOf.has(p))
          .map((p) => waveOf.get(p)!);
        if (providerWaves.length > 0) {
          myWave = Math.max(myWave, Math.min(...providerWaves) + 1);
        }
      }

      waveOf.set(pluginKey, myWave);
    }

    // Group by wave number
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
        return true; // required dependency has no providers
      }

      if (check.availableProviders.every((p) => failedSet.has(p))) {
        return true; // all providers of a required dep failed
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
    failed: Array<{ pluginKey: string; error: Error }>,
    failedSet: Set<string>
  ): Promise<void> {
    const plugin = registry.getPlugin(pluginKey);
    if (!plugin) return;

    registry.setState(pluginKey, 'resolving');
    eventBus.emit('plugin:activating', { pluginKey });

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
      eventBus.emit('plugin:activated', { pluginKey, durationMs });
      activated.push(pluginKey);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const wrappedError =
        error instanceof ActivationTimeoutError ||
        error instanceof ActivationError ||
        error instanceof CapabilityNotFoundError ||
        error instanceof UndeclaredCapabilityError ||
        error instanceof UndeclaredToolError ||
        error instanceof CapabilityViolationError
          ? error
          : new ActivationError(pluginKey, error);

      registry.setState(pluginKey, 'failed');
      failedSet.add(pluginKey);
      failed.push({ pluginKey, error: wrappedError });
      eventBus.emit('plugin:failed', { pluginKey, error: wrappedError });
      onUnhandledError?.(wrappedError);

      throw wrappedError;
    }
  }

  return {
    async activate(): Promise<ActivationResult> {
      const start = Date.now();
      const activated: string[] = [];
      const failed: Array<{ pluginKey: string; error: Error }> = [];
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
            // Error already recorded in activateSingle
            failedSet.add(toActivate[i]);
          }
        }
      }

      const durationMs = Date.now() - start;
      eventBus.emit('broker:activated', { pluginCount: activated.length, durationMs });

      return { activated, failed, pending, durationMs };
    },

    async deactivate(): Promise<void> {
      const reverseOrder = [...lastActivationOrder].reverse();
      const activeKeys = reverseOrder.filter((k) => registry.getState(k) === 'active');

      let count = 0;
      for (const pluginKey of activeKeys) {
        const plugin = registry.getPlugin(pluginKey);
        eventBus.emit('plugin:deactivating', { pluginKey });

        try {
          await plugin?.deactivate?.();
        } catch (err) {
          onUnhandledError?.(err instanceof Error ? err : new Error(String(err)));
        }

        registry.setState(pluginKey, 'inactive');
        resolver.unregisterPlugin(pluginKey);

        // Remove implementations for this plugin
        for (const [key] of implementations) {
          if (key.startsWith(`${pluginKey}:`)) {
            implementations.delete(key);
          }
        }

        eventBus.emit('plugin:deactivated', { pluginKey });
        count++;
      }

      eventBus.emit('broker:deactivated', { pluginCount: count });
    },

    async activatePlugin(pluginKey: string): Promise<void> {
      const plugin = registry.getPlugin(pluginKey);
      if (!plugin) {
        throw new Error(`Plugin '${pluginKey}' not registered`);
      }

      const state = registry.getState(pluginKey);
      if (state === 'active') {
        return; // idempotent
      }

      // Register plugin in graph for consistent ordering (hot registration)
      const provides = plugin.manifest.provides.map((p) => p.capability);
      const needs = plugin.manifest.needs.map((d) => d.capability);
      graph.addPlugin(pluginKey, provides, needs);

      // Check that all required deps are satisfied
      for (const dep of plugin.manifest.needs) {
        if (dep.optional) continue;
        resolver.resolve(dep as DependencyDeclaration, pluginKey, plugin.version); // throws CapabilityNotFoundError if missing
      }

      const activated: string[] = [];
      const failed: Array<{ pluginKey: string; error: Error }> = [];
      const failedSet = new Set<string>();

      // activateSingle will throw if plugin activation fails. If successful, activated array
      // will be populated. The failed array is provided for consistency with the main activate()
      // flow but is not used in hot registration since any error will re-throw.
      await activateSingle(pluginKey, activated, failed, failedSet);

      // Add to lastActivationOrder for deactivate()
      if (!lastActivationOrder.includes(pluginKey)) {
        lastActivationOrder.push(pluginKey);
      }
    },

    /**
     * Synchronously activate a single plugin. Used by the broker's
     * `lazyActivation` path, where `assembleContext()` is synchronous by
     * contract and therefore cannot await a plugin's `activate()` return
     * value. If the plugin's `activate()` returns a Promise, this throws.
     */
    activatePluginSync(pluginKey: string): void {
      const plugin = registry.getPlugin(pluginKey);
      if (!plugin) {
        throw new Error(`Plugin '${pluginKey}' not registered`);
      }
      if (registry.getState(pluginKey) === 'active') return; // idempotent

      registry.setState(pluginKey, 'resolving');
      eventBus.emit('plugin:activating', { pluginKey });

      const start = Date.now();
      const ctx = createPluginContext(pluginKey, plugin);
      try {
        const result = plugin.activate ? plugin.activate(ctx) : undefined;
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          throw new Error(
            `lazyActivation requires plugin.activate() to be synchronous; '${pluginKey}' returned a Promise`
          );
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        const wrappedError =
          error instanceof ActivationError ||
          error instanceof CapabilityNotFoundError ||
          error instanceof UndeclaredCapabilityError ||
          error instanceof UndeclaredToolError ||
          error instanceof CapabilityViolationError
            ? error
            : new ActivationError(pluginKey, error);

        registry.setState(pluginKey, 'failed');
        eventBus.emit('plugin:failed', { pluginKey, error: wrappedError });
        onUnhandledError?.(wrappedError);
        throw wrappedError;
      }

      registry.setState(pluginKey, 'active');
      const durationMs = Date.now() - start;
      eventBus.emit('plugin:activated', { pluginKey, durationMs });

      if (!lastActivationOrder.includes(pluginKey)) {
        lastActivationOrder.push(pluginKey);
      }
    },

    /**
     * Drain all lifecycle-owned state for a plugin: implementations,
     * tool handlers, command handlers. Used by the broker's `unregister()`.
     * This is a targeted cleanup — the caller is responsible for updating
     * registry/graph/resolver/search-index state.
     */
    purgePlugin(pluginKey: string): void {
      for (const key of Array.from(implementations.keys())) {
        if (key.startsWith(`${pluginKey}:`)) {
          implementations.delete(key);
        }
      }
      const ownedTools = toolHandlersByPlugin.get(pluginKey);
      if (ownedTools) {
        for (const toolName of ownedTools) toolHandlers.delete(toolName);
        toolHandlersByPlugin.delete(pluginKey);
      }
      const ownedCommands = commandHandlersByPlugin.get(pluginKey);
      if (ownedCommands) {
        for (const cmd of ownedCommands) commandHandlers.delete(cmd);
        commandHandlersByPlugin.delete(pluginKey);
      }
    },

    /** Broker-level capability resolution. Reuses the plugin-context path. */
    resolve: resolveImpl,
    resolveAll: resolveAllImpl,
    resolveOptional: resolveOptionalImpl,
  };
}
