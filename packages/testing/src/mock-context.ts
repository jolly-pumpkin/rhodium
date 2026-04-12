// Cross-package imports use relative source paths to match the pattern in
// `packages/core/src/broker.ts` (which imports graph/discovery/budget/context
// via relative paths) and avoid requiring `rhodium-core` to be built to dist
// before the testing package can run its own tests.
import { CapabilityNotFoundError } from '../../core/src/errors.js';
import type {
  BrokerEvent,
  BrokerEventPayload,
  CommandHandler,
  ErrorSeverity,
  PluginLogger,
  ToolHandler,
} from '../../core/src/types.js';
import type { MockPluginContext } from './types.js';

/**
 * Options for {@link createMockContext}. All fields are optional — by default
 * the returned context uses a `'test-plugin'` key, a silent logger, and empty
 * resolution tables.
 */
export interface CreateMockContextOptions {
  /** Plugin key reported as `ctx.pluginKey`. Defaults to `'test-plugin'`. */
  pluginKey?: string;
  /**
   * Preset return values for `ctx.resolve(capability)`. If a capability is
   * requested that is not in this map (and was not subsequently `provide`d on
   * the context), `resolve()` throws `CapabilityNotFoundError`.
   */
  resolutions?: Record<string, unknown>;
  /**
   * Preset return values for `ctx.resolveAll(capability)`. Capabilities not
   * in this map resolve to an empty array.
   */
  multipleResolutions?: Record<string, unknown[]>;
  /**
   * If `true`, `ctx.log.*` calls are forwarded to `console`. Defaults to
   * `false` — tests are silent unless the caller opts in.
   */
  verbose?: boolean;
}

const TEST_PLUGIN_VERSION = '0.0.0-test';

/**
 * Create a standalone {@link MockPluginContext} for unit testing a plugin in
 * isolation. Every interaction the plugin performs on the context — `provide`,
 * `registerToolHandler`, `registerCommand`, `emit`, `reportError` — is
 * recorded for later assertion.
 *
 * @example
 * ```ts
 * const ctx = createMockContext({ resolutions: { 'llm-provider': fakeLlm } });
 * plugin.activate!(ctx);
 * expect(ctx.providedCapabilities.has('my-capability')).toBe(true);
 * expect(ctx.emittedEvents).toHaveLength(1);
 * ```
 */
export function createMockContext(
  options: CreateMockContextOptions = {}
): MockPluginContext {
  const pluginKey = options.pluginKey ?? 'test-plugin';
  const resolutions = options.resolutions ?? {};
  const multipleResolutions = options.multipleResolutions ?? {};
  const verbose = options.verbose ?? false;

  const emittedEvents: Array<{ event: string; payload: unknown }> = [];
  const reportedErrors: Array<{ error: Error; severity: string }> = [];
  const registeredTools = new Map<string, unknown>();
  const registeredCommands = new Map<string, unknown>();
  const providedCapabilities = new Map<string, unknown>();

  const log: PluginLogger = verbose
    ? {
        debug: (message, data) => console.debug(`[${pluginKey}]`, message, data ?? ''),
        info: (message, data) => console.info(`[${pluginKey}]`, message, data ?? ''),
        warn: (message, data) => console.warn(`[${pluginKey}]`, message, data ?? ''),
        error: (message, data) => console.error(`[${pluginKey}]`, message, data ?? ''),
      }
    : {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      };

  function availableCapabilities(): string[] {
    const names = new Set<string>([
      ...Object.keys(resolutions),
      ...providedCapabilities.keys(),
    ]);
    return [...names].sort();
  }

  return {
    pluginKey,
    log,
    emittedEvents,
    reportedErrors,
    registeredTools,
    registeredCommands,
    providedCapabilities,

    resolve<T>(capability: string): T {
      if (providedCapabilities.has(capability)) {
        return providedCapabilities.get(capability) as T;
      }
      if (Object.prototype.hasOwnProperty.call(resolutions, capability)) {
        return resolutions[capability] as T;
      }
      throw new CapabilityNotFoundError(
        capability,
        pluginKey,
        TEST_PLUGIN_VERSION,
        availableCapabilities()
      );
    },

    resolveAll<T>(capability: string): T[] {
      const preset = (multipleResolutions[capability] ?? []) as T[];
      if (providedCapabilities.has(capability)) {
        const provided = providedCapabilities.get(capability) as T;
        // Include provided value if not already in preset
        const hasProvided = preset.some(v => v === provided);
        return hasProvided ? preset : [provided, ...preset];
      }
      return preset;
    },

    resolveOptional<T>(capability: string): T | undefined {
      if (providedCapabilities.has(capability)) {
        return providedCapabilities.get(capability) as T;
      }
      if (Object.prototype.hasOwnProperty.call(resolutions, capability)) {
        return resolutions[capability] as T;
      }
      return undefined;
    },

    provide<T>(capability: string, implementation: T): void {
      providedCapabilities.set(capability, implementation);
    },

    registerToolHandler(toolName: string, handler: ToolHandler): void {
      registeredTools.set(toolName, handler);
    },

    registerCommand(commandName: string, handler: CommandHandler): void {
      registeredCommands.set(commandName, handler);
    },

    reportError(error: Error, severity?: ErrorSeverity): void {
      reportedErrors.push({ error, severity: severity ?? 'error' });
    },

    emit<E extends BrokerEvent>(event: E, payload: BrokerEventPayload[E]): void {
      emittedEvents.push({ event, payload });
    },
  };
}
