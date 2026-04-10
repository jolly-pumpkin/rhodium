# Rhodium: Technical Architecture & Design Document

**Version:** 0.1.0-draft  
**Status:** RFC  
**Author:** Collin Neill  
**Date:** 2026-04-08  

---

## Table of Contents

1. [Overview](#overview)
2. [Design Principles](#design-principles)
3. [System Architecture](#system-architecture)
4. [Core Primitives](#core-primitives)
   - 4.1 [Broker](#41-broker)
   - 4.2 [Plugin](#42-plugin)
   - 4.3 [Manifest](#43-manifest)
   - 4.4 [PluginContext](#44-plugincontext)
5. [Capability Contract System](#5-capability-contract-system)
6. [Token Budget Management](#6-token-budget-management)
7. [Manifest-First Tool Discovery](#7-manifest-first-tool-discovery)
8. [Plugin Lifecycle](#8-plugin-lifecycle)
9. [Dependency Resolution](#9-dependency-resolution)
10. [Context Assembly Pipeline](#10-context-assembly-pipeline)
11. [Middleware System](#11-middleware-system)
12. [Error Handling](#12-error-handling)
13. [Observability & Degradation Detection](#13-observability--degradation-detection)
14. [Architecture Decision Records](#14-architecture-decision-records)
15. [Non-Functional Requirements](#15-non-functional-requirements)
16. [Project Boundaries](#16-project-boundaries)

---

## 1. Overview

Rhodium is a TypeScript framework for composing software systems from independently deployable, swappable plugins with typed capability contracts. Plugins can be anything — deterministic tools, service clients, rule engines, formatters, LLM-powered agents, or infrastructure adapters. The broker wires them together by resolving typed `provides`/`needs` contracts at runtime, the same way Kubernetes reconciles desired state across pods, volumes, and services regardless of what's running inside them.

The core thesis: software engineers should build complex systems the same way they build microservices — as independently deployable components with typed interfaces. When those systems involve LLM reasoning, Rhodium provides first-class support for the concerns that matter: manifest-first tool discovery keeps context lean, token budget management bounds what enters each inference window, and tool examples travel with definitions to improve accuracy. These features activate when plugins contribute LLM context — they don't define the whole framework.

The additional claim that goes beyond Kubernetes: declaring the infrastructure doesn't just improve system architecture, it materially improves agent reasoning quality. Better composition produces better agents because each agent reasons over a cleaner, more relevant context window on every inference.

### What Rhodium Is

- A TypeScript library (~5KB core) for composing capability-driven systems from plugins
- A broker that resolves typed capability contracts between plugins at runtime
- A composition framework where plugins are anything: parsers, API clients, rule engines, LLM agents, formatters, service adapters
- A token budget manager that bounds and prioritizes what enters LLM context when plugins participate in inference
- A manifest-first tool discovery system that achieves dramatic context reduction for LLM-powered plugins

### What Rhodium Is Not

- Not an LLM wrapper or SDK (no model calls in core — that's a plugin)
- Not exclusively an agent framework — agents are one kind of plugin among many
- Not a deployment platform or orchestration runtime
- Not any of the PoC applications that will be built on top of it

### Lineage

Rhodium inherits architectural insights from production plugin composition systems. Key patterns carried forward: type-keyed plugin registration, subscriber-based resolution, order-independent plugin arrival, and dependency resolver mechanics. Key departures: Rhodium is purpose-built for capability composition across domains (not tied to any specific UI or state management layer), adds capability contracts as a first-class primitive, introduces token-aware context assembly for LLM-participating plugins, and replaces string-typed plugin types with a richer manifest system.

---

## 2. Design Principles

**Composition over coupling.** Plugins declare what they provide and what they need. The broker resolves wiring. No plugin references another directly.

**Interfaces over implementations.** Capability contracts define the boundary. Swap the model provider, the tool set, or the memory backend without touching anything that depends on them.

**Declarative over imperative.** Declare the capability graph; let the broker reconcile it. Don't hardcode orchestration logic into prompts.

**Isolation over propagation.** A failing plugin fails loudly and locally. It doesn't silently corrupt downstream behavior — whether that's agent reasoning, data processing, or service responses.

**Context is a managed resource.** When plugins participate in LLM inference, token budget is finite and precious. The framework manages context the way an OS manages memory — with allocation, priority, and eviction. Plugins that don't contribute LLM context are unaffected by this system.

**Manifest-first, activation-second.** The broker knows what every plugin offers by reading its manifest. Plugin code runs only when the capability is needed.

---

## 3. System Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Application Code                      │
│         (PoC agents, CLI tools, services, etc.)          │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │  Plugins     │  │  Plugins     │  │  Plugins       │  │
│  │  (code-      │  │  (llm,       │  │  (report-      │  │
│  │   parser,    │  │   safety-    │  │   generator,   │  │
│  │   flag-env)  │  │   assessor)  │  │   cleanup-rule)│  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬─────────┘  │
│         │                 │                  │            │
│  ┌──────▼─────────────────▼──────────────────▼─────────┐ │
│  │              Context Assembly Pipeline               │ │
│  │  ┌──────────┐ ┌──────────────┐ ┌──────────────────┐ │ │
│  │  │ Token    │ │ Tool         │ │ Middleware        │ │ │
│  │  │ Budget   │ │ Discovery    │ │ Chain             │ │ │
│  │  │ Manager  │ │ (Manifest)   │ │ (pre/post hooks) │ │ │
│  │  └──────────┘ └──────────────┘ └──────────────────┘ │ │
│  └─────────────────────┬───────────────────────────────┘ │
│                        │                                  │
│  ┌─────────────────────▼───────────────────────────────┐ │
│  │                    Broker Core                       │ │
│  │  ┌────────────┐ ┌────────────┐ ┌──────────────────┐ │ │
│  │  │ Plugin     │ │ Capability │ │ Dependency        │ │ │
│  │  │ Registry   │ │ Resolver   │ │ Graph             │ │ │
│  │  └────────────┘ └────────────┘ └──────────────────┘ │ │
│  │  ┌────────────┐ ┌────────────┐ ┌──────────────────┐ │ │
│  │  │ Lifecycle  │ │ Error      │ │ Event             │ │ │
│  │  │ Manager    │ │ Boundary   │ │ Bus               │ │ │
│  │  └────────────┘ └────────────┘ └──────────────────┘ │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                          │
│                        rhodium                           │
└─────────────────────────────────────────────────────────┘
```

---

## 4. Core Primitives

### 4.1 Broker

The broker is the central runtime. It owns the plugin registry, resolves capability contracts, manages the dependency graph, and coordinates the context assembly pipeline. A process has one broker. The broker is created, configured, and then activated.

#### Creation

```typescript
import { createBroker, BrokerConfig } from 'rhodium';

const broker = createBroker(config?: BrokerConfig);
```

#### `BrokerConfig`

```typescript
interface BrokerConfig {
  /**
   * Default token budget for context assembly.
   * Individual assembleContext() calls can override.
   */
  defaultTokenBudget?: TokenBudgetConfig;

  /**
   * Strategy for approximate token counting.
   * 'chars3' counts chars/3 (fast, conservative — slightly
   *   overestimates for prose, accurate for code/JSON).
   * 'chars4' counts chars/4 (fast, accurate for prose,
   *   underestimates for code/JSON/structured data).
   * 'tiktoken' uses the tiktoken library (slow, exact).
   * A function allows custom counting.
   * Default: 'chars3'
   */
  tokenCounter?: 'chars3' | 'chars4' | 'tiktoken' | ((text: string) => number);

  /**
   * Maximum time (ms) to wait for all required dependencies
   * during broker.activate(). Default: 30_000.
   */
  activationTimeoutMs?: number;

  /**
   * Handler for errors that escape plugin error boundaries.
   * Default: console.error + broker event emission.
   */
  onUnhandledError?: (error: BrokerError) => void;

  /**
   * Enable structured logging of broker activity.
   * Default: false.
   */
  debug?: boolean;

  /**
   * Hard ceiling on the raw byte size of a single plugin's
   * ContextContribution (measured as the UTF-8 byte length of
   * systemPromptFragment + tool descriptions + examples).
   *
   * Enforced before the contribution enters the budget pipeline.
   * Contributions exceeding this limit are rejected and a
   * plugin:error event is emitted. This protects the V8 event
   * loop from synchronous string operations on oversized payloads.
   *
   * Default: 256KB (262_144 bytes). Set to 0 to disable.
   */
  maxContributionBytes?: number;
}
```

#### Broker API

```typescript
interface Broker {
  // --- Registration ---

  /**
   * Register a plugin with the broker. The plugin's manifest is indexed
   * immediately. Plugin code is NOT activated until activate() or
   * lazy activation via dependency resolution.
   *
   * Throws if a plugin with the same key is already registered.
   */
  register(plugin: Plugin): void;

  /**
   * Unregister a plugin. Calls the plugin's deactivate() hook if it
   * was activated. Removes its capabilities from the resolver.
   * Plugins that depended on this plugin's capabilities receive
   * an onDependencyRemoved callback.
   */
  unregister(pluginKey: string): void;

  // --- Lifecycle ---

  /**
   * Activate all registered plugins in dependency order.
   * Resolves when all required dependencies are satisfied and all
   * activate() hooks have completed.
   *
   * Rejects if:
   * - A required dependency cannot be satisfied
   * - Activation timeout is exceeded
   * - A circular dependency is detected
   * - A plugin's activate() throws
   */
  activate(): Promise<ActivationResult>;

  /**
   * Deactivate all plugins in reverse dependency order.
   * Calls each plugin's deactivate() hook.
   */
  deactivate(): Promise<void>;

  // --- Runtime ---

  /**
   * Search plugin manifests for tools matching a natural language query
   * or structured filter. Does NOT activate plugins — reads manifests only.
   * Returns ranked results with relevance scores.
   */
  searchTools(query: string | ToolSearchFilter): ToolSearchResult[];

  /**
   * Assemble the LLM context from all active plugins' contributions,
   * respecting the token budget. The optional ContextRequest provides
   * the current query and session scope so plugins can self-select
   * relevance and adjust their contributions dynamically.
   *
   * Returns a structured context object ready to be serialized
   * into a model request.
   */
  assembleContext<TState = unknown>(
    request?: ContextRequest<TState>,
    budget?: TokenBudgetConfig
  ): AssembledContext;

  /**
   * Resolve a single capability by interface name. Throws if not
   * available or not yet activated.
   */
  resolve<T>(capability: string): T;

  /**
   * Resolve all providers of a capability. Returns empty array if none.
   */
  resolveAll<T>(capability: string): T[];

  /**
   * Resolve a capability, returning undefined if not available.
   */
  resolveOptional<T>(capability: string): T | undefined;

  // --- Observation ---

  /**
   * Subscribe to broker lifecycle events.
   * Returns an unsubscribe function.
   */
  on(event: BrokerEvent, handler: BrokerEventHandler): () => void;

  /**
   * Get a structured log of all broker activity: registrations,
   * activations, dependency resolutions, errors, context assemblies.
   */
  getLog(): BrokerLog;

  /**
   * Get current state of all registered plugins.
   */
  getPluginStates(): Map<string, PluginState>;
}
```

#### Broker Events

```typescript
type BrokerEvent =
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
  | 'context:assembled'
  | 'tool:discovered'
  | 'budget:overflow'     // a plugin's contribution was trimmed or dropped
  | 'broker:activated'
  | 'broker:deactivated';

interface BrokerEventPayload {
  timestamp: number;
  event: BrokerEvent;
  pluginKey?: string;
  capability?: string;
  detail?: unknown;
}

/**
 * Payload for 'budget:overflow' events. Emitted once per dropped
 * or truncated contribution during assembleContext().
 * The severity field is the primary signal for detecting silent
 * degradation — applications should alert on 'critical' drops.
 */
interface BudgetOverflowPayload extends BrokerEventPayload {
  event: 'budget:overflow';
  pluginKey: string;
  priority: number;
  requestedTokens: number;
  availableTokens: number;
  dropped: boolean;
  truncated: boolean;
  reason: DroppedContribution['reason'];
  /**
   * priority > 80  → 'critical' (load-bearing context was lost)
   * priority > 50  → 'warning'  (useful context was lost)
   * priority <= 50 → 'info'     (nice-to-have context was lost)
   */
  severity: 'info' | 'warning' | 'critical';
}

type BrokerEventHandler = (payload: BrokerEventPayload) => void;
```

---

### 4.2 Plugin

A plugin is the unit of composition. It declares what it provides, what it needs, how to activate, how to contribute context, and how to clean up. A plugin is a plain object conforming to the `Plugin` interface — no base class, no decorator, no registration ceremony beyond `broker.register(plugin)`.

```typescript
interface Plugin<TProvides = unknown> {
  /**
   * Unique identifier. Must be globally unique within a broker.
   * Convention: kebab-case, e.g. 'typescript-parser', 'anthropic-llm'.
   */
  key: string;

  /**
   * SemVer version string.
   */
  version: string;

  /**
   * The plugin's manifest — a static, serializable declaration of
   * what this plugin is, what it provides, what it needs, and what
   * tools it exposes. The broker reads manifests WITHOUT running
   * any plugin code.
   */
  manifest: PluginManifest;

  /**
   * Called when the broker activates this plugin. Receives a
   * PluginContext with resolved dependencies and broker services.
   * May be async. Must not throw for recoverable errors — use
   * ctx.reportError() instead.
   */
  activate?: (ctx: PluginContext) => void | Promise<void>;

  /**
   * Called when the broker deactivates this plugin (during
   * broker.deactivate() or broker.unregister()). Clean up
   * resources, subscriptions, intervals.
   */
  deactivate?: () => void | Promise<void>;

  /**
   * Contribute context for LLM assembly. Called during
   * broker.assembleContext(). Must be synchronous and fast —
   * this is on the hot path of every inference.
   *
   * Receives the current request context (query, thread, hints)
   * and the remaining token budget so the plugin can make
   * intelligent decisions about what to contribute — or return
   * null to opt out of this assembly entirely.
   */
  contributeContext?: (
    request: ContextRequest<unknown>,
    budget: RemainingBudget
  ) => ContextContribution | null;

  /**
   * Called when a dependency this plugin declared as required
   * is removed at runtime (via broker.unregister on the provider).
   * The plugin should degrade gracefully or throw to trigger
   * its own deactivation.
   */
  onDependencyRemoved?: (capability: string, providerKey: string) => void;
}
```

---

### 4.3 Manifest

The manifest is the static, serializable declaration of a plugin's identity, capabilities, dependencies, and tools. The broker indexes manifests at registration time without executing any plugin code. This is the foundation of manifest-first tool discovery.

```typescript
interface PluginManifest {
  /**
   * Human-readable name for display/logging.
   */
  name: string;

  /**
   * Brief description of what this plugin does.
   */
  description: string;

  /**
   * Capabilities this plugin provides.
   * Each entry declares a capability interface name and the
   * concrete implementation metadata.
   */
  provides: CapabilityDeclaration[];

  /**
   * Capabilities this plugin requires from other plugins.
   */
  needs: DependencyDeclaration[];

  /**
   * Tools this plugin exposes to LLM context.
   * These are indexed for manifest-first discovery — the broker
   * can search and rank them without activating the plugin.
   */
  tools: ToolDeclaration[];

  /**
   * Tags for search and filtering. Unstructured strings.
   * e.g. ['parsing', 'typescript', 'ast', 'static-analysis']
   */
  tags?: string[];
}
```

#### `CapabilityDeclaration`

```typescript
interface CapabilityDeclaration {
  /**
   * The capability interface name this plugin provides.
   * e.g. 'code-parser', 'llm', 'flag-environment'
   */
  capability: string;

  /**
   * Optional: the specific variant or implementation name.
   * e.g. 'typescript' for a code-parser, 'anthropic' for an llm.
   * Used for disambiguation when multiple providers exist.
   */
  variant?: string;

  /**
   * Optional: priority when multiple plugins provide the same capability.
   * Higher wins. Default: 0. Used for override/fallback patterns.
   */
  priority?: number;
}
```

#### `DependencyDeclaration`

```typescript
interface DependencyDeclaration {
  /**
   * The capability interface name this plugin requires.
   */
  capability: string;

  /**
   * If true, the broker will not fail activation when this
   * dependency is missing. The plugin receives undefined for
   * this capability in its PluginContext.
   * Default: false (required).
   */
  optional?: boolean;

  /**
   * If true, the plugin expects multiple providers of this
   * capability (resolveAll). e.g. 'cleanup-rule' with multiple: true
   * means "give me all cleanup rules".
   * Default: false (single provider expected).
   */
  multiple?: boolean;

  /**
   * Optional: request a specific variant. If set, only providers
   * that declare this variant will satisfy the dependency.
   */
  variant?: string;
}
```

#### `ToolDeclaration`

```typescript
interface ToolDeclaration {
  /**
   * Tool name as it would appear in LLM context.
   * e.g. 'analyze_flag', 'find_usages'
   */
  name: string;

  /**
   * Human-readable description for LLM tool selection.
   */
  description: string;

  /**
   * JSON Schema for tool parameters. Used for LLM tool calling
   * and for validation.
   */
  parameters: JSONSchema;

  /**
   * Priority for context inclusion. Higher-priority tools survive
   * budget pressure. Range: 0-100.
   * Default: 50.
   */
  priority?: number;

  /**
   * Estimated token cost of including this tool's definition
   * in context. Computed from the schema if not provided.
   */
  estimatedTokens?: number;

  /**
   * Usage examples that travel with the tool definition.
   * Anthropic research shows examples improve accuracy from
   * 72% to 90%.
   */
  examples?: ToolExample[];

  /**
   * Tags for search relevance. Combined with plugin-level tags.
   */
  tags?: string[];
}

interface ToolExample {
  /**
   * Natural language description of what this example demonstrates.
   */
  scenario: string;

  /**
   * The parameters for this example invocation.
   */
  input: Record<string, unknown>;

  /**
   * The expected output shape (for illustration).
   */
  output?: unknown;
}
```

---

### 4.4 PluginContext

The `PluginContext` is the broker's interface into each plugin during activation. It provides resolved dependencies, registration methods, error reporting, and access to broker services. A new `PluginContext` is created per plugin per activation.

```typescript
interface PluginContext {
  /**
   * Resolve a required single-provider capability.
   * Throws CapabilityNotFoundError if not available.
   */
  resolve<T>(capability: string): T;

  /**
   * Resolve all providers of a capability. Returns [].
   */
  resolveAll<T>(capability: string): T[];

  /**
   * Resolve a capability that was declared optional.
   * Returns undefined if not available.
   */
  resolveOptional<T>(capability: string): T | undefined;

  /**
   * Register a tool handler. When the LLM invokes a tool declared
   * in this plugin's manifest, this handler is called.
   *
   * Tool names must be unique across all active plugins. If another
   * plugin has already registered a handler for this tool name,
   * this call throws DuplicateToolError. Plugin authors should
   * use descriptive, domain-specific names (e.g., 'parse_typescript'
   * not 'parse') to avoid collisions.
   *
   * Tool names appear bare (not namespaced) in LLM context.
   * Internally, the broker routes tool calls using both the tool
   * name and the providerKey from AssembledTool.
   */
  registerToolHandler(
    toolName: string,
    handler: ToolHandler
  ): void;

  /**
   * Register a command that application code can invoke directly.
   * Commands are not LLM tools — they're programmatic entry points.
   */
  registerCommand(
    commandName: string,
    handler: CommandHandler
  ): void;

  /**
   * Register the implementation object for a capability this plugin
   * declared in manifest.provides. Consumers calling resolve() for
   * this capability will receive this object.
   *
   * Must be called during activate() for each capability the plugin
   * provides. Throws if the plugin's manifest does not declare this
   * capability, or if the implementation fails shape validation
   * against the capability contract.
   */
  provide<T>(capability: string, implementation: T): void;

  /**
   * Report a recoverable error. The broker logs it and emits a
   * plugin:error event but does not deactivate the plugin.
   */
  reportError(error: Error, severity?: ErrorSeverity): void;

  /**
   * Emit a custom event through the broker's event bus.
   * Other plugins can subscribe via broker.on().
   */
  emit(event: string, payload?: unknown): void;

  /**
   * The plugin's own key, for logging and identification.
   */
  readonly pluginKey: string;

  /**
   * Access to the broker's structured logger.
   */
  readonly log: PluginLogger;
}

type ToolHandler = (
  params: Record<string, unknown>
) => Promise<ToolResult>;

type CommandHandler = (
  ...args: unknown[]
) => Promise<unknown>;

interface ToolResult {
  content: unknown;
  /**
   * If true, the raw output is included in context.
   * If false, only a summary is included (see middleware).
   */
  includeInContext?: boolean;
  /**
   * Optional summary for context. If provided and includeInContext
   * is false, this summary replaces the full output in context.
   */
  contextSummary?: string;
}

type ErrorSeverity = 'warning' | 'error' | 'fatal';
```

### Supporting Types

#### `PluginLogger`

Scoped logger provided to each plugin via `PluginContext.log`. All entries are tagged with the plugin key and forwarded to the broker's internal log.

```typescript
interface PluginLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, error?: Error, data?: Record<string, unknown>): void;
}
```

#### `BrokerLog`

Structured activity log returned by `broker.getLog()`. Provides a complete timeline of broker operations for debugging.

```typescript
interface BrokerLog {
  entries: BrokerLogEntry[];

  /** Filter entries by event type */
  filter(event: BrokerEvent): BrokerLogEntry[];

  /** Filter entries by plugin key */
  forPlugin(pluginKey: string): BrokerLogEntry[];

  /** All unresolved dependency declarations */
  pendingDependencies: Array<{
    pluginKey: string;
    capability: string;
    optional: boolean;
  }>;
}

interface BrokerLogEntry {
  timestamp: number;
  event: BrokerEvent;
  pluginKey?: string;
  message: string;
  data?: Record<string, unknown>;
}
```

#### `PluginState`

The runtime state of a plugin as tracked by the broker, returned by `broker.getPluginStates()`.

```typescript
interface PluginState {
  key: string;
  version: string;
  status: 'registered' | 'resolving' | 'active' | 'inactive' | 'failed' | 'unregistered';
  /** Capabilities this plugin is currently providing */
  activeCapabilities: string[];
  /** Tools this plugin has registered handlers for */
  registeredTools: string[];
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
```

#### `ActivationResult`

Returned by `broker.activate()` and `broker.activatePlugin()`. Provides a summary of what happened during activation.

```typescript
interface ActivationResult {
  /** Plugins that activated successfully */
  activated: string[];
  /** Plugins that failed to activate, with reasons */
  failed: Array<{
    pluginKey: string;
    error: RhodiumError;
  }>;
  /** Plugins that are registered but waiting on unmet required dependencies */
  pending: Array<{
    pluginKey: string;
    unmetDependencies: string[];
  }>;
  /** Total activation time in milliseconds */
  durationMs: number;
}
```

---

## 5. Capability Contract System

Capability contracts are the typed interfaces between plugins. They replace untyped string-based type systems and the prose-based coordination found in frameworks like CrewAI and Claude Code agent teams.

### Design

A capability contract is a TypeScript interface registered with the broker. At runtime, the broker verifies that providers satisfy the contract's shape. Consumers resolve capabilities by interface name and receive typed implementations.

```typescript
import { defineCapability } from 'rhodium';

/**
 * Define a capability contract. The generic parameter is the
 * interface that providers must implement.
 */
const CodeParser = defineCapability<{
  supportedExtensions: string[];
  findFlagUsages(filePath: string, flagName: string): FlagUsage[];
  applyTransform(filePath: string, transform: ASTTransform): TransformResult;
}>('code-parser');
```

### Contract Registration

Capabilities are registered centrally (typically in a shared package) so that both providers and consumers reference the same contract.

```typescript
// @rhodium/capabilities (shared package)
export const CodeParser = defineCapability<CodeParserInterface>('code-parser');
export const FlagEnvironment = defineCapability<FlagEnvironmentInterface>('flag-environment');
export const CleanupRule = defineCapability<CleanupRuleInterface>('cleanup-rule');
export const SafetyAssessor = defineCapability<SafetyAssessorInterface>('safety-assessor');
export const ReportGenerator = defineCapability<ReportGeneratorInterface>('report-generator');
export const LLMProvider = defineCapability<LLMProviderInterface>('llm');
```

### Runtime Verification

At activation time, the broker performs structural validation of provided capabilities. This is not full runtime type-checking (that would require a runtime type system), but shape verification: the broker checks that the provided object has the expected methods and properties.

```typescript
interface CapabilityValidator {
  /**
   * Verify that an object satisfies a capability contract.
   * Checks method names and arity. Does NOT check return types
   * (that would require execution).
   *
   * Returns a list of violations, or empty array if valid.
   */
  validate(
    contract: CapabilityContract,
    implementation: unknown
  ): CapabilityViolation[];
}

interface CapabilityViolation {
  type: 'missing-method' | 'missing-property' | 'wrong-arity' | 'wrong-type';
  member: string;
  expected: string;
  actual: string;
}
```

### Resolution Rules

When a consumer resolves a capability:

1. **Single provider:** Return the provider's implementation directly.
2. **Multiple providers, consumer expects single:** Return the provider with the highest `priority` in its `CapabilityDeclaration`. `priority` defaults to `0` when omitted. If priorities are tied, the most recently registered provider wins (last-write-wins). This is deterministic per registration order but not stable across runs if registration order changes — plugin authors who care about precedence should set explicit priorities.
3. **Multiple providers, consumer expects multiple** (`multiple: true`): Return all providers, sorted by priority descending. Ties are broken by registration order (most recent first).
4. **No providers, required dependency:** Throw `CapabilityNotFoundError` at activation time.
5. **No providers, optional dependency:** Return `undefined`.
6. **Variant filtering:** If the consumer specifies a `variant`, only providers matching that variant are considered. Resolution rules 1-5 then apply to the filtered set.

---

## 6. Token Budget Management

Token budget management is one of Rhodium's two core differentiators. It treats LLM context as a managed resource with allocation, priority, and eviction — analogous to how an OS manages memory.

### `TokenBudgetConfig`

```typescript
interface TokenBudgetConfig {
  /**
   * Maximum total tokens for the assembled context.
   * This is the hard ceiling.
   */
  maxTokens: number;

  /**
   * Reserved tokens for the system prompt fragment that the
   * application (not plugins) contributes. Deducted before
   * plugin budget allocation.
   * Default: 0.
   */
  reservedSystemTokens?: number;

  /**
   * Reserved tokens for tool definitions. The tool discovery
   * system operates within this sub-budget.
   * Default: maxTokens * 0.3.
   */
  reservedToolTokens?: number;

  /**
   * Strategy for allocating remaining budget to plugin
   * context contributions.
   * 'priority' — highest priority contributions first.
   * 'proportional' — each plugin gets budget proportional to its priority.
   * 'equal' — each plugin gets an equal share.
   * Default: 'priority'.
   */
  allocationStrategy?: 'priority' | 'proportional' | 'equal';
}
```

### `ContextRequest<TState>`

Passed to `assembleContext()` and forwarded to each plugin's `contributeContext()`. Provides the current query, session scope, typed application state, and optional hints so plugins can self-select relevance, adjust priority, or opt out entirely.

The generic `TState` parameter allows applications to pass a typed state object that plugins can safely destructure. This keeps the broker ignorant of application-level concepts like conversation history, user profiles, or workspace configuration — the orchestrator defines the shape, and the plugins it wires up consume it.

```typescript
interface ContextRequest<TState = unknown> {
  /**
   * The current user input or task description.
   * Plugins can use this to determine if their domain is relevant
   * to this turn and adjust their contribution accordingly.
   */
  query?: string;

  /**
   * Conversation or session identifier. Plugins that maintain
   * per-session state use this to scope their contributions.
   */
  threadId?: string;

  /**
   * Hint from the orchestrator about which capabilities are
   * expected to be active for this turn. Plugins outside this
   * list may choose to lower their priority or return null.
   */
  activeCapabilities?: string[];

  /**
   * Typed application state. The orchestrator defines the shape;
   * plugins that understand the shape consume it. The broker
   * never inspects this value.
   *
   * Use this for domain-specific state like conversation history,
   * user context, or pipeline stage data. This avoids polluting
   * the broker's core types with application concepts (e.g.,
   * a `conversationHistory: Message[]` field would force the
   * broker to take a position on what a "message" is).
   *
   * Example:
   *   interface MyAppState {
   *     messages: ChatMessage[];
   *     user: { id: string; tier: 'free' | 'pro' };
   *   }
   *   broker.assembleContext<MyAppState>({ state: { messages, user } });
   */
  state?: TState;

  /**
   * Untyped escape hatch for ad-hoc key-value pairs that don't
   * warrant a formal state shape. Useful for one-off routing
   * hints, debug flags, or experimental features.
   * e.g. { environment: 'production', debugMode: true }
   */
  metadata?: Record<string, unknown>;
}
```

### `RemainingBudget`

Passed to each plugin's `contributeContext()` so it can make intelligent decisions.

```typescript
interface RemainingBudget {
  /**
   * Tokens remaining for this plugin's contribution.
   * If the plugin's contribution exceeds this, it will
   * be truncated or dropped.
   */
  availableTokens: number;

  /**
   * Total budget for all plugin contributions.
   */
  totalBudget: number;

  /**
   * How many plugins have already contributed.
   */
  contributionsProcessed: number;

  /**
   * How many plugins are still pending.
   */
  contributionsPending: number;

  /**
   * The current priority threshold. Contributions below
   * this priority are being dropped.
   */
  currentPriorityThreshold: number;
}
```

### `ContextContribution`

What a plugin returns from `contributeContext()`.

```typescript
interface ContextContribution {
  /**
   * Fragment to append to the system prompt.
   * Describes the plugin's role and capabilities in natural language.
   */
  systemPromptFragment?: string;

  /**
   * Tool definitions to include in context. These override or
   * supplement the static declarations in the manifest. Use this
   * for dynamic tools or tools whose descriptions depend on runtime state.
   */
  tools?: ToolDeclaration[];

  /**
   * Tool usage examples. Travel with the tool definitions.
   */
  toolExamples?: ToolExample[];

  /**
   * Priority of this contribution. Higher priority survives
   * budget pressure. Range: 0-100.
   * Default: 50.
   */
  priority?: number;

  /**
   * Estimated tokens for this contribution. If not provided,
   * the broker computes it using the configured tokenCounter.
   */
  estimatedTokens?: number;

  /**
   * Arbitrary key-value metadata for application-specific context.
   * e.g. { currentFlagName: 'FEATURE_XYZ', environment: 'production' }
   */
  metadata?: Record<string, unknown>;

  /**
   * If true, this contribution is all-or-nothing. The broker will
   * not partially truncate it to fit the budget — it either fits
   * in full or gets dropped entirely. Use this for context that
   * becomes meaningless if truncated (e.g., a safety assessor's
   * rules that must be complete to be correct).
   * Default: false.
   */
  atomic?: boolean;

  /**
   * Minimum tokens this contribution needs to be useful.
   * If the remaining budget is below this threshold when this
   * contribution is reached in the priority queue, the contribution
   * is dropped rather than truncated to something meaningless.
   * Ignored if atomic is true (atomic implies all-or-nothing).
   * Default: 0 (any truncation is acceptable).
   */
  minTokens?: number;
}
```

### Budget Allocation Algorithm

The `assembleContext()` call follows this sequence:

1. **Deduct reserved tokens** — system prompt and tool definition reserves are subtracted from `maxTokens`.
2. **Collect contributions** — call `contributeContext(request, remainingBudget)` on each active plugin. Plugins returning `null` are skipped.
3. **Sort by priority** — contributions are sorted descending by their declared `priority`.
4. **Allocate based on strategy:**
   - `priority`: iterate contributions high-to-low. For each contribution:
     - If `atomic: true` and `estimatedTokens > availableTokens`, **drop entirely** (do not truncate).
     - If `minTokens` is set and `availableTokens < minTokens`, **drop** (would be truncated below useful threshold).
     - Otherwise, allocate up to `availableTokens` remaining, truncating if necessary.
     - When budget is exhausted, remaining contributions are dropped.
     - The broker emits `budget:overflow` with severity for each dropped or truncated contribution.
   - `proportional`: each contribution gets `(priority / totalPriority) * remainingBudget` tokens. Contributions exceeding their allocation are truncated (respecting `atomic` and `minTokens` — drop instead of truncate when constraints are violated).
   - `equal`: each contribution gets `remainingBudget / numContributions` tokens. Same `atomic`/`minTokens` rules apply.
5. **Assemble** — accepted contributions are merged into the `AssembledContext`.

```typescript
interface AssembledContext {
  /**
   * The complete system prompt: application fragment + plugin fragments.
   */
  systemPrompt: string;

  /**
   * Tool definitions that survived budget allocation.
   */
  tools: AssembledTool[];

  /**
   * Total tokens consumed by this assembly.
   */
  totalTokens: number;

  /**
   * Contributions that were dropped due to budget.
   */
  dropped: DroppedContribution[];

  /**
   * Assembly metadata for debugging and observability.
   */
  meta: AssemblyMeta;
}

interface AssembledTool {
  name: string;
  description: string;
  parameters: JSONSchema;
  examples?: ToolExample[];
  providerKey: string;  // which plugin provides this tool
}

interface DroppedContribution {
  pluginKey: string;
  priority: number;
  estimatedTokens: number;
  reason:
    | 'budget-exceeded'            // not enough tokens left
    | 'priority-below-threshold'   // lower priority than cutoff
    | 'atomic-no-fit'              // atomic contribution too large for remaining budget
    | 'below-min-tokens'           // remaining budget below plugin's minTokens
    | 'plugin-opted-out';          // contributeContext() returned null
  /**
   * Severity computed from the contribution's priority:
   *   priority > 80  → 'critical' (load-bearing context was lost)
   *   priority > 50  → 'warning'  (useful context was lost)
   *   priority <= 50 → 'info'     (nice-to-have context was lost)
   *
   * Applications should alert on 'critical' drops — they indicate
   * the agent may silently degrade in reasoning quality.
   */
  severity: 'info' | 'warning' | 'critical';
}

interface AssemblyMeta {
  assembledAt: number;
  budgetConfig: TokenBudgetConfig;
  totalContributions: number;
  acceptedContributions: number;
  droppedContributions: number;
  tokenUtilization: number;  // 0-1, how much of the budget was used
}
```

---

## 7. Manifest-First Tool Discovery

Manifest-first discovery is Rhodium's implementation of the "Tool Search Tool" pattern identified in Anthropic's April 2025 research (85% token reduction). Instead of loading all tool definitions into every context window, the broker searches plugin manifests and activates only relevant tools.

### How It Works

1. **At registration:** The broker indexes each plugin's `manifest.tools[]` into an in-memory search index. No plugin code is executed.
2. **At query time:** `broker.searchTools(query)` searches the index using the query (natural language or structured filter). Results are ranked by relevance.
3. **At context assembly:** Only tools that match the current task enter the context. The token budget system further constrains which tools survive.

### Search API

```typescript
interface ToolSearchFilter {
  /**
   * Natural language query. Matched against tool name,
   * description, tags, and plugin-level tags.
   */
  query?: string;

  /**
   * Filter to tools from a specific capability.
   */
  capability?: string;

  /**
   * Filter by tags.
   */
  tags?: string[];

  /**
   * Maximum results to return.
   * Default: 10.
   */
  limit?: number;

  /**
   * Minimum relevance score (0-1) for inclusion.
   * Default: 0.1.
   */
  minRelevance?: number;
}

interface ToolSearchResult {
  tool: ToolDeclaration;
  pluginKey: string;
  relevanceScore: number;       // 0-1
  isPluginActivated: boolean;   // whether the plugin is already running
}
```

### Search Ranking

The search index uses TF-IDF-style scoring across:

- Tool `name` (weight: 3x)
- Tool `description` (weight: 2x)
- Tool `tags` (weight: 2x)
- Plugin `manifest.tags` (weight: 1x)
- Plugin `manifest.description` (weight: 1x)

For structured queries (`capability`, `tags`), exact matches are boolean filters applied before relevance scoring.

### Dynamic Tool Activation

When `assembleContext()` includes tools from an inactive plugin, the broker can optionally lazy-activate that plugin. This is controlled by a broker-level setting:

```typescript
interface BrokerConfig {
  // ... other fields ...

  /**
   * If true, plugins can be activated on-demand when their tools
   * are selected for context inclusion. The activation happens
   * synchronously with assembleContext() — the plugin's activate()
   * hook runs and the tool becomes available.
   * Default: false (only pre-activated plugins contribute tools).
   */
  lazyActivation?: boolean;
}
```

### Tool Name Collision Rules

Tool names appear bare (unnamespaced) in LLM context because namespaced names (e.g., `typescript-parser.find_usages`) hurt model accuracy — models perform better with short, descriptive tool names. This means tool names must be globally unique across all active plugins.

**At registration time:** The broker indexes all tool names from `manifest.tools[]`. If a newly registered plugin declares a tool name that already exists in the index, `broker.register()` throws `DuplicateToolError` with both plugin keys and the conflicting tool name.

**At activation time:** When `ctx.registerToolHandler(toolName, handler)` is called, the broker verifies the tool name matches one declared in the plugin's own manifest. If another active plugin already has a handler for that name (which shouldn't happen if registration caught it), it throws.

**Convention:** Plugin authors should use descriptive, domain-prefixed tool names: `parse_typescript`, `analyze_flag_state`, `assess_cleanup_safety` — not generic names like `parse`, `analyze`, `assess`.

```
DuplicateToolError: Tool name 'parse' is already registered

  Existing:  typescript-parser v1.0.0 declares 'parse'
  Conflict:  python-parser v1.0.0 also declares 'parse'

  Rename one of the tools to be more specific:
    e.g., 'parse_typescript' and 'parse_python'
```

---

## 8. Plugin Lifecycle

Plugins move through a defined state machine:

```
  register()          activate()          deactivate()
REGISTERED ──────► RESOLVING ──────► ACTIVE ──────► INACTIVE
     │                  │                               │
     │                  │ (dependency fails)             │
     │                  ▼                                │
     │              FAILED                               │
     │                                                   │
     └───────────────── unregister() ───────────────────►│
                                                    UNREGISTERED
```

```typescript
type PluginState =
  | 'registered'   // manifest indexed, code not yet run
  | 'resolving'    // activate() called, waiting on dependencies
  | 'active'       // activate() completed successfully
  | 'inactive'     // deactivate() completed
  | 'failed'       // activation or runtime error
  | 'unregistered'; // removed from broker
```

### Activation Order

The broker activates plugins in topological order based on the dependency graph derived from `manifest.needs` and `manifest.provides`. The activation follows two rules:

**Sequential within dependency chains.** If plugin B depends on a capability provided by plugin A, B's `activate()` is called only after A's `activate()` promise has fully resolved. This guarantees that when B calls `ctx.resolve()`, the capability is ready — not just registered, but fully initialized.

**Parallel across independent chains.** Plugins with no dependency relationship activate concurrently. If A and B have no shared dependencies, their `activate()` calls run in parallel via `Promise.all()`. This minimizes total activation time.

```
Example: Given plugins A, B, C, D where:
  - C needs A
  - D needs A and B

Activation timeline:
  [A, B] activate in parallel (no dependencies)
  A resolves → C activates
  A and B both resolve → D activates
  C and D may run in parallel (no relationship to each other)
```

Plugins with only optional unmet dependencies activate with `undefined` for those capabilities — they don't wait for a provider that may never arrive.

### Hot Registration

After `broker.activate()`, new plugins can be registered and activated at runtime:

```typescript
broker.register(newPlugin);
// If all dependencies are already satisfied, activate immediately
await broker.activatePlugin(newPlugin.key);
```

`activatePlugin()` returns the same `ActivationResult` as `broker.activate()`, scoped to the single plugin and any dependents that were waiting on it. If the new plugin satisfies a pending optional dependency for an already-active plugin, the broker emits a `dependency:resolved` event but does not re-activate the waiting plugin (it's already running with `undefined` for that capability).

This supports the "growing without rewriting" demo scenario — adding capabilities to a running system without restarting.

---

## 9. Dependency Resolution

Dependency resolution builds on established plugin dependency resolver patterns, extended with capability-aware semantics.

### Dependency Graph

The broker maintains a directed acyclic graph (DAG) of plugin dependencies:

```typescript
interface DependencyGraph {
  /**
   * Add a plugin's dependency edges.
   */
  addPlugin(pluginKey: string, needs: DependencyDeclaration[]): void;

  /**
   * Remove a plugin and its edges.
   */
  removePlugin(pluginKey: string): void;

  /**
   * Get topological activation order.
   * Throws CircularDependencyError if a cycle is detected.
   */
  getActivationOrder(): string[];

  /**
   * Check if all required dependencies for a plugin are satisfiable
   * by currently registered providers.
   */
  canActivate(pluginKey: string): DependencyCheck;

  /**
   * Get all plugins that depend on a given plugin.
   * Used for cascade deactivation.
   */
  getDependents(pluginKey: string): string[];
}

interface DependencyCheck {
  satisfiable: boolean;
  unsatisfied: Array<{
    capability: string;
    optional: boolean;
  }>;
}
```

### Circular Dependency Detection

The broker detects circular dependencies at registration time using Kahn's algorithm on the dependency graph. If a cycle is detected:

1. `broker.register()` throws `CircularDependencyError` with the cycle path.
2. The plugin is not registered.
3. The error includes the full cycle for debugging: `A -> B -> C -> A`.

### Late Arrival

Rhodium supports order-independent plugin registration. If plugin A needs capability X, and the provider of X is registered after A:

- During `broker.activate()`: the broker waits for all providers to register before beginning activation, up to `activationTimeoutMs`.
- During hot registration: the broker checks if the new plugin satisfies any pending dependencies and triggers activation for waiting plugins.

---

## 10. Context Assembly Pipeline

The context assembly pipeline is the hot path — it runs on every LLM inference call. It must be fast, deterministic, and observable.

### Pipeline Stages

```
┌──────────────────────────────────────────────────────────┐
│                  assembleContext(budget)                   │
├───────────────────────┬──────────────────────────────────┤
│ Stage 1: Collect      │ Call contributeContext() on each  │
│                       │ active plugin. Enforce            │
│                       │ maxContributionBytes ceiling —    │
│                       │ reject oversized contributions    │
│                       │ before they enter the pipeline.   │
│                       │ Merge tools: runtime overrides    │
│                       │ manifest declarations by name.    │
│                       │ Manifest tools are the baseline;  │
│                       │ ContextContribution.tools[] with  │
│                       │ matching names replace them.      │
│                       │ New names are added.              │
├───────────────────────┼──────────────────────────────────┤
│ Stage 2: Prioritize   │ Sort contributions by priority    │
├───────────────────────┼──────────────────────────────────┤
│ Stage 3: Budget       │ Allocate tokens per strategy     │
│                       │ Drop/truncate as needed          │
├───────────────────────┼──────────────────────────────────┤
│ Stage 4: Discover     │ Run tool search if query present │
│                       │ Filter to budget-surviving tools │
├───────────────────────┼──────────────────────────────────┤
│ Stage 5: Middleware    │ Run post-assembly middleware     │
│                       │ (dedup, merge, transform)        │
├───────────────────────┼──────────────────────────────────┤
│ Stage 6: Serialize    │ Produce AssembledContext          │
│                       │ Emit context:assembled event     │
└───────────────────────┴──────────────────────────────────┘
```

### Tool Merge Strategy

Each plugin has two sources of tool definitions: static declarations in `manifest.tools[]` and dynamic declarations returned from `contributeContext().tools[]`. These are merged per-plugin before entering the budget pipeline:

1. **Baseline:** All tools from `manifest.tools[]` for the plugin.
2. **Override:** For each tool in `contributeContext().tools[]`, if a tool with the same `name` exists in the baseline, the runtime version replaces it entirely. This allows plugins to adjust tool descriptions, parameters, or examples based on runtime state.
3. **Additions:** Tools in `contributeContext().tools[]` that don't match any manifest tool name are added.
4. **Examples:** `ToolExample` arrays from both sources are concatenated and deduplicated by `scenario` string. Runtime examples take precedence when duplicates are found.

### Performance Target

`assembleContext()` must complete in under 5ms for typical configurations (10-20 active plugins, 50 tools). This constrains implementation choices: no async operations in the pipeline, no network calls, no file I/O.

---

## 11. Middleware System

Middleware hooks allow plugins to intercept and transform tool calls and their results before they affect context.

```typescript
interface MiddlewarePlugin {
  /**
   * Runs before a tool call is executed.
   * Can modify parameters, skip the call, or inject additional calls.
   */
  preToolCall?: (call: ToolCall) => ToolCall | ToolCall[] | null;

  /**
   * Runs after a tool call completes.
   * Can transform, summarize, or filter the result before it
   * enters context. This is the implementation point for
   * Anthropic's "programmatic tool calling" pattern (37% token reduction).
   */
  postToolCall?: (call: ToolCall, result: ToolResult) => ToolResult;

  /**
   * Runs after context assembly, before serialization.
   * Can deduplicate, merge, or post-process the assembled context.
   */
  postAssembly?: (context: AssembledContext) => AssembledContext;
}

interface ToolCall {
  toolName: string;
  pluginKey: string;
  parameters: Record<string, unknown>;
  timestamp: number;
}
```

Middleware is registered as plugins with a special `middleware` capability. Multiple middleware plugins execute in priority order.

---

## 12. Error Handling

Rhodium treats errors as typed, bounded, and deterministic — the opposite of silent error propagation in monolithic agent systems.

### Error Types

```typescript
/**
 * Base error class for all Rhodium errors.
 */
class RhodiumError extends Error {
  readonly code: string;
  readonly pluginKey?: string;
  readonly timestamp: number;

  constructor(message: string, code: string, pluginKey?: string) {
    super(message);
    this.code = code;
    this.pluginKey = pluginKey;
    this.timestamp = Date.now();
  }
}

// Specific error types
class CapabilityNotFoundError extends RhodiumError { code = 'CAPABILITY_NOT_FOUND'; }
class CircularDependencyError extends RhodiumError { code = 'CIRCULAR_DEPENDENCY'; }
class ActivationTimeoutError extends RhodiumError { code = 'ACTIVATION_TIMEOUT'; }
class ActivationError extends RhodiumError { code = 'ACTIVATION_FAILED'; }
class CapabilityViolationError extends RhodiumError { code = 'CAPABILITY_VIOLATION'; }
class DuplicatePluginError extends RhodiumError { code = 'DUPLICATE_PLUGIN'; }
class ToolExecutionError extends RhodiumError { code = 'TOOL_EXECUTION_FAILED'; }
class BudgetExceededError extends RhodiumError { code = 'BUDGET_EXCEEDED'; }
class ContributionTooLargeError extends RhodiumError { code = 'CONTRIBUTION_TOO_LARGE'; }
```

### Error Formatting Requirements

Graph resolution errors are the most common DX pain point when wiring plugins. The default `message` on these errors must be immediately actionable — a developer reading the error should understand the problem and know what to fix without reaching for a debugger.

**`CircularDependencyError`** must include the full cycle path as an ASCII chain:

```
CircularDependencyError: Circular dependency detected

  orchestrator
    → needs 'safety-assessor'
  safety-assessor
    → needs 'memory-provider'
  memory-provider
    → needs 'orchestrator'    ← cycle closes here

Plugins in cycle: orchestrator, safety-assessor, memory-provider
```

**`CapabilityNotFoundError`** must include what was needed, who needed it, and what's available:

```
CapabilityNotFoundError: No provider for required capability 'memory-provider'

  Needed by: orchestrator (flag-cleanup-agent v0.1.0)
  Declared as: required (not optional)

  Available capabilities in this broker:
    • code-parser          ← typescript-parser v1.0.0
    • flag-environment     ← launchdarkly-plugin v2.1.0
    • cleanup-rule         ← if-block-rule v1.0.0, ternary-rule v1.0.0
    • llm                  ← anthropic-provider v1.0.0

  Did you forget to register a plugin that provides 'memory-provider'?
  If this dependency is not required, mark it as optional:
    needs: [{ capability: 'memory-provider', optional: true }]
```

**`CapabilityViolationError`** must include the specific shape mismatches:

```
CapabilityViolationError: Plugin 'custom-parser' does not satisfy 'code-parser' contract

  Missing methods:
    • applyTransform(filePath: string, transform: ASTTransform): TransformResult

  Wrong arity:
    • findFlagUsages: expected 2 parameters, got 1

  Provided by: custom-parser v0.3.0
  Contract: code-parser (defined in @rhodium/capabilities)
```

### Error Boundary

Each plugin runs within an error boundary. If a plugin's `activate()`, `contributeContext()`, or tool handler throws:

1. The error is caught by the boundary.
2. A `plugin:error` event is emitted with the error and plugin key.
3. **For `activate()`:** The plugin transitions to `failed` state. If the error is from a required dependency chain, dependent plugins also fail.
4. **For `contributeContext()`:** The plugin's contribution is skipped for this assembly. The plugin remains active. A `budget:overflow` event is emitted.
5. **For tool handlers:** A `ToolExecutionError` is returned as the tool result. The plugin remains active.
6. **For `deactivate()`:** The error is logged. The plugin transitions to `inactive` regardless.

### Error Propagation Rules

- Errors **never** propagate silently across plugin boundaries.
- A plugin error **never** causes another plugin to fail unless there is a declared dependency relationship.
- Tool execution errors produce typed error results, not unhandled exceptions.
- The broker itself (registration, resolution, assembly) produces typed errors with codes and context for debugging.

---

## 13. Observability & Degradation Detection

The most dangerous failure mode in a composed agent system is silent degradation: a plugin's context contribution gets evicted by budget pressure, and the agent produces worse output without any visible error. The system "works" — it just works badly. Rhodium addresses this through four defense layers.

### Layer 1: Assembly Diagnostics

Every `AssembledContext` includes full diagnostic data about what was included, what was dropped, and why. The `dropped` array with its `severity` field is the primary signal. Applications should inspect this after every assembly.

```typescript
const context = broker.assembleContext(request);

// Quick check: did we lose anything important?
const criticalDrops = context.dropped.filter(d => d.severity === 'critical');
if (criticalDrops.length > 0) {
  // The agent is about to reason without load-bearing context.
  // Options: refuse to proceed, switch to a larger model,
  // reduce the number of active plugins, or warn the user.
  log.warn('Critical context dropped', { drops: criticalDrops });
}
```

### Layer 2: Budget Overflow Events

The broker emits a `budget:overflow` event (with `BudgetOverflowPayload`) for each dropped or truncated contribution during assembly. This enables real-time monitoring without inspecting the `AssembledContext` directly.

```typescript
broker.on('budget:overflow', (payload: BudgetOverflowPayload) => {
  if (payload.severity === 'critical') {
    metrics.increment('rhodium.critical_context_drop', {
      plugin: payload.pluginKey,
      reason: payload.reason,
    });
    alerting.fire('agent-degradation', {
      message: `Critical plugin '${payload.pluginKey}' (priority ${payload.priority}) dropped: ${payload.reason}`,
    });
  }
});
```

### Layer 3: Atomic & Minimum Token Guarantees

Plugins that provide load-bearing context declare `atomic: true` or `minTokens` on their contributions. This converts a silent truncation into a visible drop — a truncated safety policy is worse than no safety policy, because it may appear complete while missing critical rules. The broker respects these constraints during allocation, and the drop shows up in diagnostics with a clear reason (`atomic-no-fit` or `below-min-tokens`).

### Layer 4: Test Assertions

The `rhodium/testing` package provides assertion utilities specifically designed to catch degradation scenarios in tests:

- `assertContextIncludes()` — verify that specific plugins and tools survive a given budget configuration.
- `assertNoCriticalDrops()` — quick-check that nothing with priority > 80 was evicted.
- `assertNoDropsAbovePriority()` — parameterized version for custom priority thresholds.

The recommended testing pattern is to write budget stress tests: register a realistic set of plugins, set a tight budget, assemble context, and assert that the critical capabilities survive. These tests catch regressions where a new plugin's context contribution pushes an existing critical plugin below the budget line.

```typescript
describe('budget stress', () => {
  it('safety assessor survives with 15 cleanup rules registered', async () => {
    const broker = createTestBroker();
    broker.register(safetyAssessorPlugin);     // priority: 90
    for (const rule of fifteenCleanupRules) {  // priority: 30-60
      broker.register(rule);
    }
    await broker.activate();

    const context = broker.assembleContext(
      { query: 'clean up FEATURE_X' },
      { maxTokens: 4096 }
    );

    assertNoCriticalDrops(context);
    assertContextIncludes(context, {
      plugins: ['llm-safety-assessor'],
      tools: ['assess_safety'],
    });
  });
});
```

### The Orchestrator's Responsibility

The four layers above provide the data. The orchestrator — the plugin or application code running the agent loop — decides what to do with it. The broker is deliberately not prescriptive here: some applications should refuse to proceed when critical context is lost, others should fall back to a larger context window, others should warn a human operator. The broker's job is to make degradation visible and measurable, not to decide the recovery strategy.

---

## 14. Architecture Decision Records

### ADR-001: Greenfield vs. Evolution

**Decision:** Greenfield implementation rather than evolving an existing plugin system.

**Context:** Prior plugin broker implementations were tightly coupled to specific application domains (UI frameworks, state management). Their plugin type systems were string-based and untyped. Adding capability contracts, token budgets, and manifest-first discovery as bolt-ons would require changing every interface while maintaining backward compatibility with an unrelated domain.

**Consequences:** Clean API design unconstrained by legacy. Proven composition patterns are inherited conceptually, not as code.

### ADR-002: Plain Objects Over Classes

**Decision:** Plugins are plain objects conforming to the `Plugin` interface. No base class, abstract class, or decorator pattern.

**Context:** Base classes create coupling to the framework's inheritance hierarchy. Decorators add build-time complexity. Plain objects are easy to test, easy to compose, and match the "typed capability contracts" philosophy — the shape of the object is the contract, not the class it extends.

**Consequences:** No `this` context in plugin methods (they receive `PluginContext` as a parameter instead). Slightly more boilerplate for plugins that need shared utility behavior (addressed by optional helper functions like `definePlugin()`).

### ADR-003: Synchronous Context Assembly

**Decision:** `contributeContext()` is synchronous. The entire assembly pipeline is synchronous.

**Context:** Context assembly is on the hot path of every inference. Async contributions would require awaiting I/O per plugin, adding latency proportional to the number of plugins. Context contributions should be derived from already-loaded state, not computed on demand.

**Consequences:** Plugins that need async data for context must fetch it during `activate()` or in response to events, and cache the result for synchronous contribution. Plugins cannot make API calls inside `contributeContext()`.

### ADR-004: chars/3 as Default Token Counter

**Decision:** Default token counting uses character count divided by 3.

**Context:** Exact token counting requires loading a tokenizer library (~2MB for tiktoken). The `chars/4` heuristic is ~90% accurate for English prose but systematically underestimates token counts for code, JSON, and structured data — payloads that are common in agent systems. Underestimation is worse than overestimation: it causes API rejections and context overflow, while overestimation only wastes some budget headroom. `chars/3` is a more conservative default that remains accurate for code-heavy payloads and slightly overestimates for prose. Applications that need precision can configure tiktoken or a custom function. A `chars/4` option is available for prose-dominant use cases.

**Consequences:** Token budgets are approximate by default, biased toward safety (slight overcount). Applications doing precise cost accounting should configure tiktoken. The budget system is designed to be robust to ±15% token estimation error.

### ADR-005: No Built-in LLM Calls in Core

**Decision:** The core `rhodium` package makes zero LLM API calls. All model interaction happens through plugins.

**Context:** Embedding model calls in the broker would couple it to specific providers, add dependencies, and conflate infrastructure with application logic. The broker's job is to compose the context — what happens with that context is the application's concern.

**Consequences:** The `llm` capability is just another plugin contract. The broker is testable without API keys. Different parts of a system can use different model providers by registering multiple `llm` plugins with variants.

### ADR-006: Manifest Serialization

**Decision:** Plugin manifests are plain JavaScript objects, not separate JSON/YAML files.

**Context:** Separate manifest files (like package.json) would allow static analysis without loading code. However, they add a synchronization burden between the manifest file and the code, create packaging complexity, and make tooling harder. Since Rhodium loads plugins in-process (not over a network), the manifest is available as soon as the module is imported.

**Consequences:** The broker can read manifests without calling `activate()`, but it must import the plugin module. If Rhodium later needs to support remote/distributed plugins, manifests may need to be extractable as standalone JSON. This is a future concern with a clear migration path.

### ADR-007: Singleton Broker, Request-Scoped Context

**Decision:** The broker is a singleton activated once at process startup. Context assembly is request-scoped via `ContextRequest`.

**Context:** In a server environment handling concurrent user sessions, two models are possible: instantiate a broker per request (simple isolation, expensive startup) or share a single broker and scope context per request. The broker's activation cost (dependency resolution, plugin activation, index building) makes per-request instantiation impractical for the <100ms startup target. The Express/Koa middleware model — singleton app, per-request state flowing through the handler chain — is the proven pattern.

**Consequences:** The broker is shared across concurrent calls. `assembleContext(request)` carries the `ContextRequest` with `threadId`, `query`, and `metadata` so plugins can scope their contributions per session. Plugins that maintain mutable state must ensure thread safety across concurrent `contributeContext()` calls — the broker does not provide isolation between concurrent assemblies. Stateless plugins (the common case) are unaffected. The `ContextRequest.threadId` field is the primary mechanism for plugins to partition cached state per conversation.

### ADR-008: Event Bus Over Direct Callbacks

**Decision:** Inter-plugin communication uses a broker-mediated event bus, not direct callbacks or references.

**Context:** Direct references between plugins would violate isolation. Callback registration requires knowing which plugin to register with. The event bus maintains decoupling: a plugin emits an event, any interested plugin subscribes through the broker.

**Consequences:** No compile-time safety on event names or payloads (mitigated by TypeScript generics on event definitions). Slight performance overhead vs. direct calls (negligible for expected event volumes). Clean separation of concerns.

### ADR-009: Zero Module-Level Mutable State

**Decision:** The `rhodium` core package contains zero module-level mutable variables. All state is scoped to the broker instance returned by `createBroker()`.

**Context:** In Node.js/Bun, module-level variables are singletons — they survive across concurrent requests sharing the same process. If the broker core used a global plugin registry, a global event bus, or a global cache, two broker instances in the same process could leak state into each other. This is a realistic scenario in multi-tenant backends where different tenants may have different plugin configurations, different budgets, or different capability sets. It's also trivially easy for plugin authors to accidentally rely on module-level globals for caching or state, creating hidden coupling between broker instances.

**Consequences:** Every piece of mutable state — the plugin registry, the dependency graph, the search index, the event bus, the log — lives on the object returned by `createBroker()`. Two brokers in the same process are fully independent. The `PluginContext` scopes all operations to its parent broker. Plugin authoring docs should explicitly warn against module-level mutable state in plugins and recommend that any caching be keyed to the `PluginContext` instance.

### ADR-010: Capability Contracts Are Immutable Once Published

**Decision:** Capability interface names are immutable once any plugin depends on them. Shape changes to a capability require a new name.

**Context:** If the `memory-provider` contract changes from returning `string[]` to returning `MemoryEntry[]`, every consumer that expected the old shape breaks. Semantic versioning on capability names (e.g., `memory-provider@^1.0.0`) would require building a version resolution engine inside the broker — effectively recreating npm's dependency tree complexity. That's not justified for v0.1 and probably not justified ever, because the broker resolves capabilities within a single process where all plugins are loaded simultaneously (unlike npm, where packages are resolved at install time across a network).

**Consequences:** Capabilities follow the Go module versioning convention: if the shape changes, the name changes. `memory-provider` → `memory-provider-v2`. Old and new versions can coexist in the same broker — plugins depending on `memory-provider` continue to resolve the v1 provider, while plugins depending on `memory-provider-v2` resolve the v2 provider. This is explicit, simple, and avoids the combinatorial explosion of semver range resolution. Plugin authoring docs must emphasize this convention. `defineCapability()` should accept an optional `version` field for documentation purposes, but it does not participate in resolution logic.

---

## 15. Non-Functional Requirements

### Performance

| Metric | Target | Rationale |
|--------|--------|-----------|
| Core bundle size | < 5KB minified + gzipped | Kubernetes lesson: low entry cost |
| `assembleContext()` latency | < 5ms (20 plugins) | Hot path, runs every inference |
| `broker.register()` latency | < 1ms per plugin | Startup cost, runs once per plugin |
| `broker.activate()` latency | < 100ms (20 plugins) | Startup cost, runs once |
| `searchTools()` latency | < 2ms (100 tools) | Discovery is latency-sensitive |
| Memory overhead per plugin | < 10KB baseline | Support 50+ plugin configurations |

### Reliability

- Plugin errors are contained by error boundaries. A single plugin failure never crashes the broker.
- The broker maintains a consistent state after any error: no half-registered plugins, no zombie dependencies.
- All state transitions are atomic from the broker's perspective.

### Observability

- Every broker operation emits a typed event.
- `broker.getLog()` provides a structured activity log.
- `AssembledContext.meta` provides token utilization and drop diagnostics per assembly.
- Debug mode enables verbose logging of dependency resolution, budget allocation, and tool search ranking.

### Testability

- Plugins are plain objects: testable in isolation with mock `PluginContext`.
- The broker is deterministic: same plugins + same config = same behavior.
- `createTestBroker()` helper provides a pre-configured broker with sensible defaults for unit testing.

```typescript
import { createTestBroker } from 'rhodium/testing';

const { broker, mockContext } = createTestBroker();
broker.register(myPlugin);
await broker.activate();
// mockContext provides recorded events, tool calls, etc.
```

- `assertContextIncludes()` verifies that critical capabilities survive budget pressure. This is the primary defense against silent reasoning degradation in tests.

```typescript
import { assertContextIncludes } from 'rhodium/testing';

const context = broker.assembleContext({ query: 'clean up FEATURE_X' });

// Verify critical plugins survived budget allocation
assertContextIncludes(context, {
  plugins: ['llm-safety-assessor', 'typescript-parser'],
  tools: ['assess_safety', 'find_usages'],
  minTokenUtilization: 0.5,  // at least 50% of budget used
});

// Verify nothing critical was dropped
assertNoCriticalDrops(context);
// Throws if any contribution with priority > 80 was dropped
```

```typescript
// Full assertion API
import {
  assertContextIncludes,
  assertNoCriticalDrops,
  assertNoDropsAbovePriority,
} from 'rhodium/testing';

/**
 * Assert that the assembled context includes contributions
 * from specific plugins and/or specific tools.
 * Throws AssertionError with a detailed diff on failure.
 */
function assertContextIncludes(
  context: AssembledContext,
  requirements: {
    /** Plugin keys that must have surviving contributions */
    plugins?: string[];
    /** Tool names that must be present */
    tools?: string[];
    /** Minimum fraction of budget that must be utilized (0-1) */
    minTokenUtilization?: number;
  }
): void;

/**
 * Assert that no contributions with priority > 80 were dropped.
 * This is the quick-check for "did we lose anything load-bearing?"
 */
function assertNoCriticalDrops(context: AssembledContext): void;

/**
 * Assert that no contributions above a given priority were dropped.
 * More flexible version of assertNoCriticalDrops.
 */
function assertNoDropsAbovePriority(
  context: AssembledContext,
  minPriority: number
): void;
```

### Compatibility

- **Runtime:** Bun 1.0+ (primary), Node.js 18+ (compatible), modern browsers (ES2022+).
- **TypeScript:** 5.0+ (required for type-level capability contracts).
- **Module format:** ESM primary, CJS compatibility build.
- **Dependencies:** Zero runtime dependencies in core. Optional peer dependencies for tiktoken, Zod (structured LLM output).

---

## 16. Project Boundaries

### In Scope (Rhodium Core)

- Broker creation and configuration
- Plugin registration, activation, deactivation, lifecycle management
- Capability contract definition, validation, and resolution
- Dependency graph construction, cycle detection, topological ordering
- Token budget allocation, prioritization, and eviction
- Manifest-first tool search and indexing
- Context assembly pipeline
- Middleware hooks (pre/post tool call, post assembly)
- Error boundary and typed error system
- Event bus for inter-plugin communication
- Structured logging and observability
- Test utilities (`createTestBroker`, mock context)

### Out of Scope (Not Part of the Framework)

- **LLM API integration** — provided by plugins (`anthropic-llm`, `openai-llm`, etc.)
- **Prompt engineering** — plugins own their system prompt fragments
- **Agent orchestration logic** — plugins compose their own workflows
- **Specific tool implementations** — plugins provide parsers, flag services, etc.
- **UI/CLI** — application concern, not framework concern
- **Deployment/distribution** — Rhodium is a library, not a platform
- **PoC applications** — the feature flag cleanup agent, the SWE-bench pipeline, and all other applications built on Rhodium are separate projects
- **UI state management integration** — Redux, Zustand, or other state library bindings are application-level concerns, not framework concerns
- **Micro-frontend orchestration** — Rhodium is capability-focused, not DOM-focused

### Future Considerations (Not v0.1, But Architected For)

- **Remote plugins:** plugins running in separate processes or machines, communicating via serialized manifests and RPC. The manifest-as-plain-object decision (ADR-006) has a clear migration path.
- **Plugin marketplace:** a registry for discovering and installing community plugins. The manifest structure supports this.
- **Distributed broker:** multiple broker instances coordinating across services. The event bus and capability resolution protocol are designed to be serializable.
- **Runtime type validation:** deeper contract validation using Zod or io-ts schemas at runtime. The current shape-checking validation is a subset of this.
- **Streaming tool handlers:** Allow `ToolHandler` to return an `AsyncGenerator<ToolChunk, ToolResult>` or accept a `stream` callback, enabling plugins to emit intermediate output (e.g., streaming test logs) to the application layer while accumulating a final `ToolResult` for context. The current `Promise<ToolResult>` contract is designed to be extendable via union type without breaking existing plugins.
- **Context hydration helpers:** A `createCachedContributor()` utility that wraps an async data source with a synchronous cache, managing the refresh lifecycle (polling, event-driven, TTL-based) so plugin authors don't have to build this pattern themselves. This addresses the tension in ADR-003 where plugins needing dynamic data (e.g., live database schemas for tool examples) must eagerly cache state during `activate()` or in response to events.
- **Telemetry integration:** OpenTelemetry spans for tool calls, context assembly, and activation. The event bus provides the hook points.

---

## Appendix A: Package Structure

```
rhodium/
├── packages/
│   ├── core/                    # The broker, registry, lifecycle
│   │   ├── src/
│   │   │   ├── broker.ts
│   │   │   ├── registry.ts
│   │   │   ├── lifecycle.ts
│   │   │   ├── events.ts
│   │   │   └── index.ts
│   │   └── package.json         # "rhodium" — the main package
│   ├── capabilities/            # Capability contract utilities
│   │   ├── src/
│   │   │   ├── define.ts
│   │   │   ├── validate.ts
│   │   │   └── index.ts
│   │   └── package.json         # "rhodium/capabilities"
│   ├── budget/                  # Token budget manager
│   │   ├── src/
│   │   │   ├── allocator.ts
│   │   │   ├── counter.ts
│   │   │   └── index.ts
│   │   └── package.json         # "rhodium/budget"
│   ├── discovery/               # Manifest indexing and tool search
│   │   ├── src/
│   │   │   ├── index-builder.ts
│   │   │   ├── search.ts
│   │   │   ├── ranking.ts
│   │   │   └── index.ts
│   │   └── package.json         # "rhodium/discovery"
│   ├── context/                 # Context assembly pipeline
│   │   ├── src/
│   │   │   ├── pipeline.ts
│   │   │   ├── middleware.ts
│   │   │   └── index.ts
│   │   └── package.json         # "rhodium/context"
│   ├── graph/                   # Dependency graph + resolution
│   │   ├── src/
│   │   │   ├── dag.ts
│   │   │   ├── resolver.ts
│   │   │   ├── cycle-detect.ts
│   │   │   └── index.ts
│   │   └── package.json         # "rhodium/graph"
│   └── testing/                 # Test utilities
│       ├── src/
│       │   ├── test-broker.ts
│       │   ├── mock-context.ts
│       │   └── index.ts
│       └── package.json         # "rhodium/testing"
└── package.json                 # Monorepo root (workspace config)
```

### Export Strategy

The main `rhodium` package re-exports the public API from all sub-packages. Consumers can import from `rhodium` for convenience or from specific sub-packages for tree-shaking:

```typescript
// Convenience (most consumers)
import { createBroker, defineCapability, Plugin } from 'rhodium';

// Tree-shakeable (advanced consumers)
import { createBroker } from 'rhodium/core';
import { defineCapability } from 'rhodium/capabilities';
import { createTestBroker } from 'rhodium/testing';
```

---

## Appendix B: Minimal Working Example

```typescript
import { createBroker, defineCapability, Plugin } from 'rhodium';

// 1. Define a capability contract
interface Greeter {
  greet(name: string): string;
}

const GreeterCapability = defineCapability<Greeter>('greeter');

// 2. Create a provider plugin
const englishGreeter: Plugin = {
  key: 'english-greeter',
  version: '1.0.0',
  manifest: {
    name: 'English Greeter',
    description: 'Greets people in English',
    provides: [{ capability: 'greeter', variant: 'english' }],
    needs: [],
    tools: [{
      name: 'greet',
      description: 'Greet a person by name',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      examples: [{ scenario: 'Basic greeting', input: { name: 'Alice' }, output: 'Hello, Alice!' }],
    }],
  },
  activate(ctx) {
    // Expose the capability implementation so consumers can resolve it
    ctx.provide<Greeter>('greeter', {
      greet: (name: string) => `Hello, ${name}!`,
    });

    // Also register the tool handler for LLM-driven invocation
    ctx.registerToolHandler('greet', async (params) => ({
      content: `Hello, ${params.name}!`,
    }));
  },
  contributeContext(budget) {
    return {
      systemPromptFragment: 'You can greet people in English.',
      priority: 50,
      estimatedTokens: 10,
    };
  },
};

// 3. Create a consumer plugin
const greetingOrchestrator: Plugin = {
  key: 'greeting-orchestrator',
  version: '1.0.0',
  manifest: {
    name: 'Greeting Orchestrator',
    description: 'Orchestrates greetings',
    provides: [],
    needs: [{ capability: 'greeter' }],
    tools: [],
  },
  activate(ctx) {
    const greeter = ctx.resolve<Greeter>('greeter');
    ctx.registerCommand('say-hello', async (name: string) => {
      return greeter.greet(name);
    });
  },
};

// 4. Wire it up
const broker = createBroker({ defaultTokenBudget: { maxTokens: 4096 } });
broker.register(englishGreeter);
broker.register(greetingOrchestrator);
await broker.activate();

// 5. Use it
const context = broker.assembleContext();
// context.systemPrompt includes "You can greet people in English."
// context.tools includes the 'greet' tool with its example.
```