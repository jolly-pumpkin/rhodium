import type { CapabilityContract } from '../../../packages/capabilities/src/define.js';
import type { RhodiumError } from './errors.js';

// ============================================================
// Broker configuration
// ============================================================

export interface BrokerConfig {
  /** Maximum time (ms) to wait for all required dependencies during activate(). Default: 30_000. */
  activationTimeoutMs?: number;
  /** Handler for errors that escape plugin error boundaries. */
  onUnhandledError?: (error: Error) => void;
  /** Enable structured logging of broker activity. Default: false. */
  debug?: boolean;
}

// ============================================================
// Event bus
// ============================================================

export type BrokerEvent =
  | 'plugin:registered'
  | 'plugin:unregistered'
  | 'plugin:activating'
  | 'plugin:activated'
  | 'plugin:deactivating'
  | 'plugin:deactivated'
  | 'plugin:error'
  | 'capability:provided'
  | 'capability:removed'
  | 'dependency:resolved'
  | 'dependency:unresolved'
  | 'broker:activated'
  | 'broker:deactivated';

export interface BrokerEventPayload {
  timestamp: number;
  event: BrokerEvent;
  pluginKey?: string;
  capability?: string;
  detail?: unknown;
}

export type BrokerEventHandler = (payload: BrokerEventPayload) => void;

// ============================================================
// Plugin manifest types
// ============================================================

export interface CapabilityDeclaration {
  /** The capability token name (e.g. 'llm-provider') */
  capability: string;
  /** Priority when multiple providers exist; higher wins. Default: 0. */
  priority?: number;
  /** Optional variant label for filtered resolution */
  variant?: string;
  /** Optional contract schema for runtime validation of implementations */
  contract?: CapabilityContract<unknown>;
}

export interface DependencyDeclaration {
  /** The capability token name being depended on */
  capability: string;
  /** Whether the dependency is optional. Default: false (required). */
  optional?: boolean;
  /** Whether to resolve all providers (not just highest-priority) */
  multiple?: boolean;
  /** Only resolve providers with this variant */
  variant?: string;
}

export interface PluginManifest {
  /** Human-readable name for display/logging */
  name: string;
  /** Brief description of what this plugin does */
  description: string;
  provides: CapabilityDeclaration[];
  needs: DependencyDeclaration[];
  tags?: string[];
}

// ============================================================
// Plugin status & state
// ============================================================

export type PluginStatus =
  | 'registered'
  | 'resolving'
  | 'active'
  | 'inactive'
  | 'failed'
  | 'unregistered';

export type ErrorSeverity = 'warning' | 'error' | 'fatal';

export interface PluginState {
  key: string;
  version: string;
  status: PluginStatus;
  /** Capabilities this plugin is currently providing */
  activeCapabilities: string[];
  /** Commands this plugin has registered */
  registeredCommands: string[];
  /** Dependencies and their resolution status */
  dependencies: Array<{
    capability: string;
    optional: boolean;
    resolved: boolean;
    providerKey?: string;
  }>;
  /** Timestamp of last state transition */
  lastTransition: number;
  /** Error that caused 'failed' state, if applicable */
  error?: RhodiumError;
}

// ============================================================
// Plugin logger
// ============================================================

export interface PluginLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, error?: Error, data?: Record<string, unknown>): void;
}

// ============================================================
// Command handler
// ============================================================

export type CommandHandler = (...args: unknown[]) => Promise<unknown>;

// ============================================================
// PluginContext (passed to activate())
// ============================================================

export interface PluginContext {
  readonly pluginKey: string;
  readonly log: PluginLogger;

  /** Resolve a required single-provider capability. Throws if not available. */
  resolve<T>(capability: string): T;
  /** Resolve all providers of a capability. Returns []. */
  resolveAll<T>(capability: string): T[];
  /** Resolve a capability that was declared optional. Returns undefined if not available. */
  resolveOptional<T>(capability: string): T | undefined;

  /** Register the implementation for a capability declared in manifest.provides. */
  provide<T>(capability: string, implementation: T): void;
  /** Register a command that application code can invoke directly. */
  registerCommand(commandName: string, handler: CommandHandler): void;

  /** Report a recoverable error without deactivating the plugin. */
  reportError(error: Error, severity?: ErrorSeverity): void;
  /** Emit a custom event through the broker's event bus. */
  emit(event: string, payload?: unknown): void;
}

// ============================================================
// Plugin interface
// ============================================================

export interface Plugin {
  readonly key: string;
  readonly version: string;
  readonly manifest: PluginManifest;

  activate?(ctx: PluginContext): Promise<void> | void;
  deactivate?(): Promise<void> | void;
  onDependencyRemoved?(capability: string, providerKey: string): void;
}

// ============================================================
// Activation result
// ============================================================

export interface ActivationResult {
  /** Plugins that activated successfully */
  activated: string[];
  /** Plugins that failed to activate, with reasons */
  failed: Array<{ pluginKey: string; error: RhodiumError }>;
  /** Plugins that are registered but waiting on unmet required dependencies */
  pending: Array<{ pluginKey: string; unmetDependencies: string[] }>;
  /** Total activation time in milliseconds */
  durationMs: number;
}

// ============================================================
// Logging
// ============================================================

export interface BrokerLogEntry {
  timestamp: number;
  event: BrokerEvent | string;
  pluginKey?: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface BrokerLog {
  entries: BrokerLogEntry[];
  /** Filter entries by event type */
  filter(event: BrokerEvent | string): BrokerLogEntry[];
  /** Filter entries by plugin key */
  forPlugin(pluginKey: string): BrokerLogEntry[];
  /** All unresolved dependency declarations */
  pendingDependencies: Array<{
    pluginKey: string;
    capability: string;
    optional: boolean;
  }>;
}

// ============================================================
// Broker interface
// ============================================================

export interface Broker {
  // --- Registration ---
  register(plugin: Plugin): void;
  unregister(pluginKey: string): Promise<void>;

  // --- Lifecycle ---
  activate(): Promise<ActivationResult>;
  deactivate(): Promise<void>;
  activatePlugin(pluginKey: string): Promise<ActivationResult>;

  // --- Resolution ---
  resolve<T>(capability: string): T;
  resolveAll<T>(capability: string): T[];
  resolveOptional<T>(capability: string): T | undefined;

  // --- Introspection ---
  getManifests(): Map<string, PluginManifest>;
  getManifest(pluginKey: string): PluginManifest | undefined;
  getPluginStates(): Map<string, PluginState>;

  // --- Observation ---
  on(event: BrokerEvent, handler: BrokerEventHandler): () => void;
  getLog(): BrokerLog;
}

// ============================================================
// Dependency graph & capability resolution (from packages/graph)
// ============================================================

export interface DependencyCheck {
  pluginKey: string;
  capability: string;
  satisfied: boolean;
  availableProviders: string[];
}

export interface DependencyGraph {
  addPlugin(pluginKey: string, provides: string[], needs: string[]): void;
  removePlugin(pluginKey: string): void;
  /** Returns plugin keys in topological activation order */
  getActivationOrder(): string[];
  /** Returns true if all required dependencies for this plugin are satisfied */
  canActivate(pluginKey: string): boolean;
  /** Returns all plugins that (transitively) depend on this plugin */
  getDependents(pluginKey: string): string[];
  /** Returns unsatisfied dependency checks for a plugin */
  checkDependencies(pluginKey: string): DependencyCheck[];
}

export interface ProviderEntry {
  pluginKey: string;
  capability: string;
  priority: number;
  variant: string | undefined;
  registrationIndex: number;
}

export interface CapabilityResolver {
  registerProvider(pluginKey: string, declaration: CapabilityDeclaration, registrationIndex: number): void;
  unregisterPlugin(pluginKey: string): void;
  resolve(dep: DependencyDeclaration, neededBy: string, neededByVersion: string): ProviderEntry | undefined;
  resolveMany(dep: DependencyDeclaration, neededBy: string, neededByVersion: string): ProviderEntry[];
}
