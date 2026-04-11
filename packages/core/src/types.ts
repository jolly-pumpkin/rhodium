import type { CapabilityContract } from '../../../packages/capabilities/src/define.js';

// ============================================================
// Token budget configuration
// ============================================================

export interface TokenBudgetConfig {
  /** Total token budget for the assembled context */
  maxTokens: number;
  /** Tokens reserved for the system prompt (deducted before allocation) */
  reservedSystemTokens?: number;
  /** Tokens reserved for tool definitions (deducted before allocation) */
  reservedToolTokens?: number;
  /** How to divide the remaining budget across contributions */
  allocationStrategy?: 'priority' | 'proportional' | 'equal';
}

// ============================================================
// Broker configuration
// ============================================================

export interface BrokerConfig {
  defaultTokenBudget?: TokenBudgetConfig;
  tokenCounter?: 'chars3' | 'chars4' | 'tiktoken' | ((text: string) => number);
  activationTimeoutMs?: number;
  onUnhandledError?: (error: Error) => void;
  debug?: boolean;
  maxContributionBytes?: number;
  lazyActivation?: boolean;
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
  | 'plugin:failed'
  | 'broker:activated'
  | 'broker:deactivated'
  | 'context:assembled'
  | 'budget:overflow'
  | 'capability:resolved'
  | 'tool:executed'
  | 'tool:error';

export interface BudgetOverflowPayload {
  pluginKey: string;
  priority: number;
  severity: 'info' | 'warning' | 'critical';
  droppedTokens: number;
  reason: 'atomic' | 'minTokens' | 'overflow';
}

export type BrokerEventPayload = {
  'plugin:registered': { pluginKey: string };
  'plugin:unregistered': { pluginKey: string };
  'plugin:activating': { pluginKey: string };
  'plugin:activated': { pluginKey: string; durationMs: number };
  'plugin:deactivating': { pluginKey: string };
  'plugin:deactivated': { pluginKey: string };
  'plugin:error': { pluginKey: string; error: Error; severity: ErrorSeverity };
  'plugin:failed': { pluginKey: string; error: Error };
  'broker:activated': { pluginCount: number; durationMs: number };
  'broker:deactivated': { pluginCount: number };
  'context:assembled': { totalTokens: number; droppedCount: number; durationMs: number };
  'budget:overflow': BudgetOverflowPayload;
  'capability:resolved': { capability: string; providerKey: string };
  'tool:executed': { pluginKey: string; toolName: string; durationMs: number };
  'tool:error': { pluginKey: string; toolName: string; error: Error };
};

export type BrokerEventHandler<E extends BrokerEvent> = (
  payload: BrokerEventPayload[E]
) => void;

// ============================================================
// Plugin manifest types
// ============================================================

export interface ToolExample {
  scenario: string;
  input: Record<string, unknown>;
  output: unknown;
}

export interface ToolDeclaration {
  name: string;
  description: string;
  /** JSON Schema object for parameters */
  parameters?: Record<string, unknown>;
  examples?: ToolExample[];
  tags?: string[];
}

export interface CapabilityDeclaration {
  /** The capability token name (e.g. 'llm-provider') */
  capability: string;
  /** Priority when multiple providers exist; higher wins */
  priority?: number;
  /** Optional variant label for filtered resolution */
  variant?: string;
  /** Optional contract schema for runtime validation of implementations */
  contract?: CapabilityContract<unknown>;
}

export interface DependencyDeclaration {
  /** The capability token name being depended on */
  capability: string;
  /** Whether the dependency is optional */
  optional?: boolean;
  /** Whether to resolve all providers (not just highest-priority) */
  multiple?: boolean;
  /** Only resolve providers with this variant */
  variant?: string;
}

export interface PluginManifest {
  provides: CapabilityDeclaration[];
  needs: DependencyDeclaration[];
  tools: ToolDeclaration[];
  tags?: string[];
  description?: string;
}

// ============================================================
// Plugin state & error severity
// ============================================================

export type PluginState =
  | 'registered'
  | 'resolving'
  | 'active'
  | 'inactive'
  | 'failed'
  | 'unregistered';

export type ErrorSeverity = 'info' | 'warning' | 'error' | 'critical';

// ============================================================
// Plugin logger
// ============================================================

export interface PluginLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

// ============================================================
// Tool and command handlers
// ============================================================

export type ToolResult = {
  content: string | Record<string, unknown>;
  isError?: boolean;
};

export type ToolHandler = (
  params: Record<string, unknown>,
  ctx: PluginContext
) => Promise<ToolResult> | ToolResult;

export type CommandHandler = (
  args: string[],
  ctx: PluginContext
) => Promise<void> | void;

// ============================================================
// Context assembly types
// ============================================================

export interface ContextRequest<TState = unknown> {
  query?: string;
  state?: TState;
  tokenBudget?: TokenBudgetConfig;
  includePlugins?: string[];
  excludePlugins?: string[];
}

export interface RemainingBudget {
  totalTokens: number;
  usedTokens: number;
  remainingTokens: number;
  allocationStrategy: 'priority' | 'proportional' | 'equal';
}

export interface ContextContribution {
  pluginKey: string;
  priority: number;
  systemPromptFragment?: string;
  tools?: ToolDeclaration[];
  /** Minimum tokens this contribution needs to be useful. Drop entirely if budget < minTokens */
  minTokens?: number;
  /** If true, never truncate — either include fully or drop entirely */
  atomic?: boolean;
}

export interface AssembledTool extends ToolDeclaration {
  pluginKey: string;
  relevanceScore?: number;
}

export interface DroppedContribution {
  pluginKey: string;
  priority: number;
  reason: 'budget' | 'atomic' | 'minTokens' | 'error' | 'filtered';
  estimatedTokens: number;
  severity: 'info' | 'warning' | 'critical';
}

export interface AssemblyMeta {
  totalPlugins: number;
  contributingPlugins: number;
  droppedPlugins: number;
  allocationStrategy: 'priority' | 'proportional' | 'equal';
  durationMs: number;
  tokenCounter: string;
}

export interface AssembledContext {
  systemPrompt: string;
  tools: AssembledTool[];
  totalTokens: number;
  dropped: DroppedContribution[];
  meta: AssemblyMeta;
}

// ============================================================
// PluginContext (passed to activate())
// ============================================================

export interface PluginContext {
  readonly pluginKey: string;
  readonly log: PluginLogger;

  resolve<T>(capability: string): T;
  resolveAll<T>(capability: string): T[];
  resolveOptional<T>(capability: string): T | undefined;

  provide<T>(capability: string, implementation: T): void;

  registerToolHandler(toolName: string, handler: ToolHandler): void;
  registerCommand(commandName: string, handler: CommandHandler): void;

  reportError(error: Error, severity?: ErrorSeverity): void;
  emit<E extends BrokerEvent>(event: E, payload: BrokerEventPayload[E]): void;
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

  contributeContext?(
    request: ContextRequest,
    budget: RemainingBudget
  ): ContextContribution | null | undefined;

  onDependencyRemoved?(capability: string): void;
}

// ============================================================
// Activation result
// ============================================================

export interface ActivationResult {
  activated: string[];
  failed: Array<{ pluginKey: string; error: Error }>;
  pending: string[];
  durationMs: number;
}

// ============================================================
// Logging
// ============================================================

export interface BrokerLogEntry {
  timestamp: number;
  event: BrokerEvent | string;
  pluginKey?: string;
  data?: Record<string, unknown>;
}

export interface BrokerLog {
  entries: BrokerLogEntry[];
}

export interface BrokerLogFilter {
  event?: BrokerEvent | string;
  pluginKey?: string;
  since?: number;
}

// ============================================================
// Tool search types (defined here until packages/discovery is populated)
// These will be moved to rhodium-discovery in Task 7
// ============================================================

export interface ToolSearchFilter {
  query?: string;
  capability?: string;
  tags?: string[];
  limit?: number;
  minRelevance?: number;
}

export interface ToolSearchResult {
  pluginKey: string;
  toolName: string;
  description: string;
  tags?: string[];
  relevanceScore: number;
  isPluginActivated: boolean;
}

export interface Broker {
  register(plugin: Plugin): void;
  unregister(pluginKey: string): Promise<void>;

  activate(): Promise<ActivationResult>;
  deactivate(): Promise<void>;
  activatePlugin(pluginKey: string): Promise<void>;

  resolve<T>(capability: string): T;
  resolveAll<T>(capability: string): T[];
  resolveOptional<T>(capability: string): T | undefined;

  searchTools(query: string | ToolSearchFilter): ToolSearchResult[];
  assembleContext<TState = unknown>(request?: ContextRequest<TState>): AssembledContext;

  on<E extends BrokerEvent>(event: E, handler: BrokerEventHandler<E>): () => void;

  getLog(filter?: BrokerLogFilter): BrokerLog;
  getPluginStates(): Map<string, PluginState>;
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
  priority: number; // defaults to 0 if not set in CapabilityDeclaration
  variant: string | undefined;
  registrationIndex: number; // monotonically increasing; higher = more recently registered
}

export interface CapabilityResolver {
  /**
   * Register a plugin as a provider of a capability.
   * registrationIndex must be monotonically increasing (broker increments a counter).
   */
  registerProvider(pluginKey: string, declaration: CapabilityDeclaration, registrationIndex: number): void;
  /** Remove all provider entries for a plugin. */
  unregisterPlugin(pluginKey: string): void;
  /**
   * Resolve a single required or optional dependency.
   * - Returns the winning ProviderEntry, or undefined for optional+missing.
   * - Throws CapabilityNotFoundError for required+missing.
   */
  resolve(dep: DependencyDeclaration, neededBy: string, neededByVersion: string): ProviderEntry | undefined;
  /**
   * Resolve multiple providers (dep.multiple === true).
   * Always returns an array (empty if none found and dep.optional).
   */
  resolveMany(dep: DependencyDeclaration, neededBy: string, neededByVersion: string): ProviderEntry[];
}
