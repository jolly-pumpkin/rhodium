/**
 * Type-level verification that the barrel re-exports every public type.
 *
 * This file is checked by `tsc --noEmit` (not by bun test). If any type name
 * is removed from the barrel, this file will produce a compile error. bun test
 * strips `import type`, so runtime tests cannot catch missing type exports.
 *
 * Run: cd packages/rhodium && bun run typecheck
 */

import type {
  Plugin,
  PluginManifest,
  PluginContext,
  PluginState,
  PluginLogger,
  Broker,
  BrokerConfig,
  BrokerEvent,
  BrokerEventPayload,
  BrokerEventHandler,
  BrokerLog,
  BrokerLogEntry,
  CapabilityDeclaration,
  DependencyDeclaration,
  ToolDeclaration,
  ToolExample,
  ToolSearchFilter,
  ToolSearchResult,
  ToolHandler,
  ToolResult,
  CommandHandler,
  TokenBudgetConfig,
  ContextRequest,
  ContextContribution,
  AssembledContext,
  AssembledTool,
  AssemblyMeta,
  DroppedContribution,
  RemainingBudget,
  ActivationResult,
  ErrorSeverity,
  DependencyGraph,
  DependencyCheck,
  CapabilityResolver,
  ProviderEntry,
  MiddlewarePlugin,
  ToolCall,
  CapabilityContract,
  CapabilityValidator,
  CapabilityViolation,
  CapabilitySchema,
} from './index.js';

// Each variable below forces the type import to be resolved by tsc.
// If a name is removed from the barrel, tsc will error on the import above.
const _plugin: Plugin = undefined as unknown as Plugin;
const _manifest: PluginManifest = undefined as unknown as PluginManifest;
const _ctx: PluginContext = undefined as unknown as PluginContext;
const _state: PluginState = 'active';
const _logger: PluginLogger = undefined as unknown as PluginLogger;
const _broker: Broker = undefined as unknown as Broker;
const _cfg: BrokerConfig = {};
const _event: BrokerEvent = 'plugin:registered';
const _payload: BrokerEventPayload = undefined as unknown as BrokerEventPayload;
const _handler: BrokerEventHandler<'plugin:registered'> =
  undefined as unknown as BrokerEventHandler<'plugin:registered'>;
const _brokerLog: BrokerLog = { entries: [] };
const _logEntry: BrokerLogEntry = undefined as unknown as BrokerLogEntry;
const _capDecl: CapabilityDeclaration = { capability: 'x' };
const _depDecl: DependencyDeclaration = { capability: 'x' };
const _tool: ToolDeclaration = { name: 'x', description: 'x' };
const _toolEx: ToolExample = { scenario: 's', input: {}, output: null };
const _toolFilter: ToolSearchFilter = {};
const _toolResultSearch: ToolSearchResult = undefined as unknown as ToolSearchResult;
const _toolHandler: ToolHandler = undefined as unknown as ToolHandler;
const _toolResult: ToolResult = { content: '' };
const _commandHandler: CommandHandler = undefined as unknown as CommandHandler;
const _budget: TokenBudgetConfig = { maxTokens: 1 };
const _req: ContextRequest = {};
const _contribution: ContextContribution = undefined as unknown as ContextContribution;
const _assembled: AssembledContext = undefined as unknown as AssembledContext;
const _assembledTool: AssembledTool = undefined as unknown as AssembledTool;
const _meta: AssemblyMeta = undefined as unknown as AssemblyMeta;
const _dropped: DroppedContribution = undefined as unknown as DroppedContribution;
const _remaining: RemainingBudget = undefined as unknown as RemainingBudget;
const _activation: ActivationResult = undefined as unknown as ActivationResult;
const _severity: ErrorSeverity = 'info';
const _graph: DependencyGraph = undefined as unknown as DependencyGraph;
const _depCheck: DependencyCheck = undefined as unknown as DependencyCheck;
const _resolver: CapabilityResolver = undefined as unknown as CapabilityResolver;
const _entry: ProviderEntry = undefined as unknown as ProviderEntry;
const _middleware: MiddlewarePlugin = undefined as unknown as MiddlewarePlugin;
const _call: ToolCall = undefined as unknown as ToolCall;
const _contract: CapabilityContract = undefined as unknown as CapabilityContract;
const _validator: CapabilityValidator = undefined as unknown as CapabilityValidator;
const _violation: CapabilityViolation = undefined as unknown as CapabilityViolation;
const _schema: CapabilitySchema = undefined as unknown as CapabilitySchema;

// Prevent tree-shaking (relevant if this file is ever bundled).
void [
  _plugin, _manifest, _ctx, _state, _logger, _broker, _cfg, _event, _payload,
  _handler, _brokerLog, _logEntry, _capDecl, _depDecl, _tool, _toolEx,
  _toolFilter, _toolResultSearch, _toolHandler, _toolResult, _commandHandler,
  _budget, _req, _contribution, _assembled, _assembledTool, _meta, _dropped,
  _remaining, _activation, _severity, _graph, _depCheck, _resolver, _entry,
  _middleware, _call, _contract, _validator, _violation, _schema,
];
