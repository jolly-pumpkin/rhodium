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
  const commandHandlers = new Map<string, CommandHandler>();
  let registrationIndex = 0;
  let lastActivationOrder: string[] = [];

  function createPluginContext(pluginKey: string, plugin: Plugin): PluginContext {
    return {
      pluginKey,
      log: createPluginLogger(pluginKey),

      resolve<T>(capability: string): T {
        const entry = resolver.resolve({ capability }, pluginKey, plugin.version);
        if (!entry) {
          throw new Error(`Capability '${capability}' not found for plugin '${pluginKey}'`);
        }
        const impl = implementations.get(`${entry.pluginKey}:${capability}`);
        if (impl === undefined) {
          throw new Error(
            `No implementation found for capability '${capability}' from provider '${entry.pluginKey}'`
          );
        }
        return impl as T;
      },

      resolveAll<T>(capability: string): T[] {
        const entries = resolver.resolveMany({ capability, multiple: true }, pluginKey, plugin.version);
        return entries
          .map((e) => implementations.get(`${e.pluginKey}:${capability}`) as T | undefined)
          .filter((v): v is T => v !== undefined);
      },

      resolveOptional<T>(capability: string): T | undefined {
        const entry = resolver.resolve({ capability, optional: true }, pluginKey, plugin.version);
        if (!entry) return undefined;
        return (implementations.get(`${entry.pluginKey}:${capability}`) ?? undefined) as T | undefined;
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
      },

      registerCommand(commandName: string, handler: CommandHandler): void {
        commandHandlers.set(commandName, handler);
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
      const pending: string[] = [];
      const failedSet = new Set<string>();

      const order = graph.getActivationOrder();
      lastActivationOrder = order;
      const waves = computeWaves(order);

      for (const wave of waves) {
        const toActivate = wave.filter((key) => !shouldSkip(key, failedSet));
        const skipped = wave.filter((key) => shouldSkip(key, failedSet));
        pending.push(...skipped);

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

      await activateSingle(pluginKey, activated, failed, failedSet);

      if (failed.length > 0) {
        throw failed[0].error;
      }

      // Add to lastActivationOrder for deactivate()
      if (!lastActivationOrder.includes(pluginKey)) {
        lastActivationOrder.push(pluginKey);
      }
    },
  };
}
