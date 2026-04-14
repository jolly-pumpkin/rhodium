# Rhodium: Technical Architecture & Design Document

**Version:** 0.2.0-draft  
**Status:** RFC  
**Author:** Collin Neill  
**Date:** 2026-04-12  
**Supersedes:** v0.1.0-draft

---

## Table of Contents

1. [Overview](#1-overview)
2. [Design Principles](#2-design-principles)
3. [System Architecture](#3-system-architecture)
4. [Core Primitives](#4-core-primitives)
   - 4.1 [Broker](#41-broker)
   - 4.2 [Plugin](#42-plugin)
   - 4.3 [Manifest](#43-manifest)
   - 4.4 [PluginContext](#44-plugincontext)
5. [Capability Contract System](#5-capability-contract-system)
6. [Plugin Lifecycle](#6-plugin-lifecycle)
7. [Dependency Resolution](#7-dependency-resolution)
8. [Error Handling](#8-error-handling)
9. [Observability](#9-observability)
10. [Architecture Decision Records](#10-architecture-decision-records)
11. [Non-Functional Requirements](#11-non-functional-requirements)
12. [Project Boundaries](#12-project-boundaries)
13. [Appendix A: Package Structure](#appendix-a-package-structure)
14. [Appendix B: Minimal Working Example](#appendix-b-minimal-working-example)
15. [Appendix C: Building on Rhodium — LLM Context, A2A Gateway](#appendix-c-building-on-rhodium--llm-context-a2a-gateway)

---

## 1. Overview

Rhodium is a TypeScript library for composing software systems from independently deployable, swappable plugins with typed capability contracts. Plugins can be anything — deterministic tools, service clients, rule engines, formatters, LLM-powered agents, or infrastructure adapters. The broker wires them together by resolving typed `provides`/`needs` contracts at runtime, the same way Kubernetes reconciles desired state across pods, volumes, and services regardless of what's running inside them.

The core thesis: software engineers should build complex systems the same way they build microservices — as independently deployable components with typed interfaces. The broker handles wiring and lifecycle. It does not have opinions about what plugins do, how large their outputs are, or how the composed system communicates with the outside world.

### What Rhodium Is

- A TypeScript library (~3KB core) for composing capability-driven systems from plugins
- A broker that resolves typed capability contracts between plugins at runtime
- A composition framework where plugins are anything: parsers, API clients, rule engines, LLM agents, formatters, service adapters
- A lifecycle manager that activates plugins in dependency order and isolates failures

### What Rhodium Is Not

- Not an LLM wrapper or SDK — model calls, context assembly, token budgets, and prompt construction are application-layer concerns, not framework concerns
- Not exclusively an agent framework — agents are one kind of plugin among many
- Not a resource manager — the broker doesn't care how big a plugin's outputs are, the same way the original plugin broker doesn't care how many DOM nodes a micro-frontend renders
- Not a deployment platform or orchestration runtime
- Not any of the PoC applications that will be built on top of it

### Lineage

Rhodium inherits architectural insights from production plugin composition systems. Key patterns carried forward: type-keyed plugin registration, subscriber-based resolution, order-independent plugin arrival, and dependency resolver mechanics. Key departures: Rhodium is purpose-built for capability composition across domains (not tied to any specific UI or state management layer), adds capability contracts as a first-class primitive, and replaces string-typed plugin types with a richer manifest system.

### Relationship to LLM Systems

Rhodium is useful for building LLM-powered systems because good composition produces better agent reasoning — each agent reasons over cleaner, more relevant context when the system is well-structured. But LLM-specific concerns like token budgets, context assembly, prompt construction, and tool ranking are application-layer problems built *on top of* Rhodium, not embedded in its core. An LLM context assembler is a consumer of the broker's registry and capability resolution — it uses the broker to discover what's available, then assembles context however the application sees fit. Appendix C sketches how this works.

---

## 2. Design Principles

**Composition over coupling.** Plugins declare what they provide and what they need. The broker resolves wiring. No plugin references another directly.

**Interfaces over implementations.** Capability contracts define the boundary. Swap the model provider, the tool set, or the memory backend without touching anything that depends on them.

**Declarative over imperative.** Declare the capability graph; let the broker reconcile it. Don't hardcode orchestration logic.

**Isolation over propagation.** A failing plugin fails loudly and locally. It doesn't silently corrupt downstream behavior — whether that's agent reasoning, data processing, or service responses.

**The broker is a wiring system, not a resource manager.** The broker knows *that* plugins exist and *how* they relate to each other. It does not have opinions about what plugins produce, how large those outputs are, or how consumers use them. This is the same principle that makes the original plugin broker work for micro-frontends: the broker doesn't care if a micro-frontend renders one button or an entire dashboard.

**Manifest-first, activation-second.** The broker knows what every plugin offers by reading its manifest. Plugin code runs only when the capability is needed.

---

## 3. System Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Application Code                      │
│  (LLM context assemblers, CLI tools, services, agents)   │
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

Note what is absent from the broker core: there is no context assembly pipeline, no token budget manager, no tool system. Those are application-layer concerns that consume the broker's composition primitives.

---

## 4. Core Primitives

### 4.1 Broker

The broker is the central runtime. It owns the plugin registry, resolves capability contracts, manages the dependency graph, and coordinates plugin lifecycle. A process has one broker. The broker is created, configured, and then activated.

#### Creation

```typescript
import { createBroker, BrokerConfig } from 'rhodium';

const broker = createBroker(config?: BrokerConfig);
```

#### `BrokerConfig`

```typescript
interface BrokerConfig {
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
   * Activate a single plugin (for hot registration after initial
   * broker.activate()). Activates the plugin and any dependents
   * that were waiting on it.
   */
  activatePlugin(pluginKey: string): Promise<ActivationResult>;

  /**
   * Deactivate all plugins in reverse dependency order.
   * Calls each plugin's deactivate() hook.
   */
  deactivate(): Promise<void>;

  // --- Resolution ---

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

  // --- Introspection ---

  /**
   * Get the manifests of all registered plugins. Application code
   * can use this to discover what's available without activating
   * anything — the foundation for manifest-first patterns.
   */
  getManifests(): Map<string, PluginManifest>;

  /**
   * Get the manifest of a specific plugin by key.
   */
  getManifest(pluginKey: string): PluginManifest | undefined;

  /**
   * Get current state of all registered plugins.
   */
  getPluginStates(): Map<string, PluginState>;

  // --- Observation ---

  /**
   * Subscribe to broker lifecycle events.
   * Returns an unsubscribe function.
   */
  on(event: BrokerEvent, handler: BrokerEventHandler): () => void;

  /**
   * Get a structured log of all broker activity: registrations,
   * activations, dependency resolutions, errors.
   */
  getLog(): BrokerLog;
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
  | 'broker:activated'
  | 'broker:deactivated';

interface BrokerEventPayload {
  timestamp: number;
  event: BrokerEvent;
  pluginKey?: string;
  capability?: string;
  detail?: unknown;
}

type BrokerEventHandler = (payload: BrokerEventPayload) => void;
```

---

### 4.2 Plugin

A plugin is the unit of composition. It declares what it provides, what it needs, how to activate, and how to clean up. A plugin is a plain object conforming to the `Plugin` interface — no base class, no decorator, no registration ceremony beyond `broker.register(plugin)`.

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
   * what this plugin is, what it provides, and what it needs.
   * The broker reads manifests WITHOUT running any plugin code.
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
   * Called when a dependency this plugin declared as required
   * is removed at runtime (via broker.unregister on the provider).
   * The plugin should degrade gracefully or throw to trigger
   * its own deactivation.
   */
  onDependencyRemoved?: (capability: string, providerKey: string) => void;
}
```

Note what is absent from the Plugin interface: there is no `contributeContext` hook and no tool declarations. The broker doesn't ask plugins to produce LLM context or declare LLM-callable functions, because the broker doesn't know or care whether the system uses an LLM. A plugin's capability contract — its typed interface — *is* the declaration of what it can do. If an LLM context assembler or A2A gateway needs to present those capabilities in a specific format, that's a translation step those consumers perform.

---

### 4.3 Manifest

The manifest is the static, serializable declaration of a plugin's identity, capabilities, and dependencies. The broker indexes manifests at registration time without executing any plugin code.

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
   * Tags for search and filtering. Unstructured strings.
   * e.g. ['parsing', 'typescript', 'ast', 'static-analysis']
   */
  tags?: string[];
}
```

Note what is absent from the manifest: there are no tool declarations. The capability contracts *are* the declaration of what a plugin can do — their typed interfaces define the methods, parameters, and behaviors. If an LLM context assembler or an A2A gateway needs to present those capabilities in a particular format (JSON Schema descriptions, natural language summaries, Agent Card skills), that's a translation step those consumers perform using the capability contracts as the source of truth, not a separate metadata structure the manifest carries.

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
   * Register a command that application code can invoke directly.
   * Commands are programmatic entry points into plugin functionality.
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

type CommandHandler = (
  ...args: unknown[]
) => Promise<unknown>;

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
// @my-app/capabilities (shared package)
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

## 6. Plugin Lifecycle

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
type PluginStatus =
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

This supports the "growing without rewriting" pattern — adding capabilities to a running system without restarting.

---

## 7. Dependency Resolution

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

## 8. Error Handling

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
```

Note what is absent: there are no LLM-specific or application-specific error types (`BudgetExceededError`, `ContextAssemblyError`, etc.). Those are concerns for application-layer systems built on top of Rhodium, not for the broker itself.

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
  Contract: code-parser (defined in @my-app/capabilities)
```

### Error Boundary

Each plugin runs within an error boundary. If a plugin's `activate()` throws:

1. The error is caught by the boundary.
2. A `plugin:error` event is emitted with the error and plugin key.
3. **For `activate()`:** The plugin transitions to `failed` state. If the error is from a required dependency chain, dependent plugins also fail.
4. **For `deactivate()`:** The error is logged. The plugin transitions to `inactive` regardless.

### Error Propagation Rules

- Errors **never** propagate silently across plugin boundaries.
- A plugin error **never** causes another plugin to fail unless there is a declared dependency relationship.
- The broker itself (registration, resolution) produces typed errors with codes and context for debugging.

---

## 9. Observability

Every broker operation emits a typed event via the event bus. This provides the data needed for debugging, monitoring, and building higher-level systems on top.

- `broker.on(event, handler)` subscribes to lifecycle events.
- `broker.getLog()` provides a structured activity log.
- Debug mode enables verbose logging of dependency resolution.

The event bus is intentionally low-level. Higher-level observability — OpenTelemetry spans, degradation alerting, performance dashboards — is built on top using event subscriptions. The broker doesn't prescribe what you do with the events.

---

## 10. Architecture Decision Records

### ADR-001: Greenfield vs. Evolution

**Decision:** Greenfield implementation rather than evolving an existing plugin system.

**Context:** Prior plugin broker implementations were tightly coupled to specific application domains (UI frameworks, state management). Their plugin type systems were string-based and untyped. Adding capability contracts as bolt-ons would require changing every interface while maintaining backward compatibility with an unrelated domain.

**Consequences:** Clean API design unconstrained by legacy. Proven composition patterns are inherited conceptually, not as code.

### ADR-002: Plain Objects Over Classes

**Decision:** Plugins are plain objects conforming to the `Plugin` interface. No base class, abstract class, or decorator pattern.

**Context:** Base classes create coupling to the framework's inheritance hierarchy. Decorators add build-time complexity. Plain objects are easy to test, easy to compose, and match the "typed capability contracts" philosophy — the shape of the object is the contract, not the class it extends.

**Consequences:** No `this` context in plugin methods (they receive `PluginContext` as a parameter instead). Slightly more boilerplate for plugins that need shared utility behavior (addressed by optional helper functions like `definePlugin()`).

### ADR-003: Broker Is a Wiring System, Not a Resource Manager

**Decision:** The broker handles composition and lifecycle. It has no opinions about the size, shape, or resource consumption of plugin outputs.

**Context:** Early design iterations (v0.1) embedded token budget management and LLM context assembly directly in the broker core. This created a layer violation: the broker was simultaneously a composition framework and a resource allocator. The original plugin broker succeeded precisely because it did not care what micro-frontends rendered or how large they were — it only cared about wiring. LLM context assembly, token budgets, and prompt construction are concerns for the application layer or for specialized plugins that consume the broker's composition primitives.

**Consequences:** The broker's API surface is smaller and purely about composition. Application-layer systems (LLM context assemblers, A2A gateways, CLIs) are built on top using `broker.getManifests()`, `broker.resolve()`, and event subscriptions. The framework is genuinely general-purpose — usable for agent systems, micro-frontends, service composition, or anything else that benefits from capability-driven plugin composition.

### ADR-004: No Built-in LLM Calls in Core

**Decision:** The core `rhodium` package makes zero LLM API calls. All model interaction happens through plugins.

**Context:** Embedding model calls in the broker would couple it to specific providers, add dependencies, and conflate infrastructure with application logic. The broker's job is to compose — what happens with the composed system is the application's concern.

**Consequences:** The `llm` capability is just another plugin contract. The broker is testable without API keys. Different parts of a system can use different model providers by registering multiple `llm` plugins with variants.

### ADR-005: Manifest Serialization

**Decision:** Plugin manifests are plain JavaScript objects, not separate JSON/YAML files.

**Context:** Separate manifest files (like package.json) would allow static analysis without loading code. However, they add a synchronization burden between the manifest file and the code, create packaging complexity, and make tooling harder. Since Rhodium loads plugins in-process (not over a network), the manifest is available as soon as the module is imported.

**Consequences:** The broker can read manifests without calling `activate()`, but it must import the plugin module. If Rhodium later needs to support remote/distributed plugins, manifests may need to be extractable as standalone JSON. This is a future concern with a clear migration path.

### ADR-006: Singleton Broker, Request-Scoped State

**Decision:** The broker is a singleton activated once at process startup. Request-scoped state is the application's responsibility.

**Context:** In a server environment handling concurrent user sessions, instantiating a broker per request would be expensive. The broker's activation cost (dependency resolution, plugin activation) makes per-request instantiation impractical. The Express/Koa middleware model — singleton app, per-request state flowing through the handler chain — is the proven pattern.

**Consequences:** The broker is shared across concurrent calls. Application code that needs per-request scoping (like an LLM context assembler that builds different context per conversation) manages that scoping itself, not through the broker. Plugins that maintain mutable state must ensure thread safety.

### ADR-007: Event Bus Over Direct Callbacks

**Decision:** Inter-plugin communication uses a broker-mediated event bus, not direct callbacks or references.

**Context:** Direct references between plugins would violate isolation. Callback registration requires knowing which plugin to register with. The event bus maintains decoupling: a plugin emits an event, any interested plugin subscribes through the broker.

**Consequences:** No compile-time safety on event names or payloads (mitigated by TypeScript generics on event definitions). Slight performance overhead vs. direct calls (negligible for expected event volumes). Clean separation of concerns.

### ADR-008: Zero Module-Level Mutable State

**Decision:** The `rhodium` core package contains zero module-level mutable variables. All state is scoped to the broker instance returned by `createBroker()`.

**Context:** In Node.js/Bun, module-level variables are singletons — they survive across concurrent requests sharing the same process. If the broker core used a global plugin registry, two broker instances in the same process could leak state into each other.

**Consequences:** Every piece of mutable state — the plugin registry, the dependency graph, the event bus, the log — lives on the object returned by `createBroker()`. Two brokers in the same process are fully independent. Plugin authoring docs should explicitly warn against module-level mutable state in plugins.

### ADR-009: Capability Contracts Are Immutable Once Published

**Decision:** Capability interface names are immutable once any plugin depends on them. Shape changes to a capability require a new name.

**Context:** If the `memory-provider` contract changes shape, every consumer that expected the old shape breaks. Semantic versioning on capability names would require building a version resolution engine inside the broker — effectively recreating npm's dependency tree complexity. That's not justified for a broker that resolves capabilities within a single process where all plugins are loaded simultaneously.

**Consequences:** Capabilities follow the Go module versioning convention: if the shape changes, the name changes. `memory-provider` → `memory-provider-v2`. Old and new versions can coexist in the same broker. This is explicit, simple, and avoids the combinatorial explosion of semver range resolution.

---

## 11. Non-Functional Requirements

### Performance

| Metric | Target | Rationale |
|--------|--------|-----------|
| Core bundle size | < 3KB minified + gzipped | Low entry cost, minimal dependency |
| `broker.register()` latency | < 1ms per plugin | Startup cost, runs once per plugin |
| `broker.activate()` latency | < 100ms (20 plugins) | Startup cost, runs once |
| Memory overhead per plugin | < 10KB baseline | Support 50+ plugin configurations |

### Reliability

- Plugin errors are contained by error boundaries. A single plugin failure never crashes the broker.
- The broker maintains a consistent state after any error: no half-registered plugins, no zombie dependencies.
- All state transitions are atomic from the broker's perspective.

### Testability

- Plugins are plain objects: testable in isolation with mock `PluginContext`.
- The broker is deterministic: same plugins + same config = same behavior.
- `createTestBroker()` helper provides a pre-configured broker with sensible defaults for unit testing.

```typescript
import { createTestBroker } from 'rhodium/testing';

const { broker, mockContext } = createTestBroker();
broker.register(myPlugin);
await broker.activate();
// mockContext provides recorded events, commands, etc.
```

### Compatibility

- **Runtime:** Bun 1.0+ (primary), Node.js 18+ (compatible), modern browsers (ES2022+).
- **TypeScript:** 5.0+ (required for type-level capability contracts).
- **Module format:** ESM primary, CJS compatibility build.
- **Dependencies:** Zero runtime dependencies in core.

---

## 12. Project Boundaries

### In Scope (Rhodium Core)

- Broker creation and configuration
- Plugin registration, activation, deactivation, lifecycle management
- Capability contract definition, validation, and resolution
- Dependency graph construction, cycle detection, topological ordering
- Manifest indexing and introspection (`getManifests()`)
- Command registration
- Error boundary and typed error system
- Event bus for inter-plugin communication and observation
- Structured logging
- Test utilities (`createTestBroker`, mock context)

### Out of Scope (Not Part of the Framework)

- **Token budget management** — application-layer concern. The broker doesn't care how large plugin outputs are, the same way the original plugin broker doesn't care how many DOM nodes a micro-frontend renders.
- **LLM context assembly** — application-layer concern. A context assembler is a consumer of `broker.getManifests()` and `broker.resolve()`, not a broker feature.
- **Prompt engineering** — application concern.
- **Tool declarations and tool handling** — tools are an LLM/application concept. A plugin's capabilities (typed interfaces) are the declaration of what it can do. If an LLM context assembler or A2A gateway needs to present capabilities as "tools," that's a translation step the consumer performs.
- **LLM API integration** — provided by plugins (`anthropic-llm`, `openai-llm`, etc.)
- **Agent orchestration logic** — plugins compose their own workflows.
- **Specific service implementations** — plugins provide parsers, flag services, etc.
- **UI/CLI** — application concern.
- **Deployment/distribution** — Rhodium is a library, not a platform.
- **PoC applications** — the feature flag cleanup agent, the SWE-bench pipeline, and all other applications built on Rhodium are separate projects.

### Future Considerations (Not v0.1, But Architected For)

- **Remote plugins:** plugins running in separate processes or machines, communicating via serialized manifests and RPC. The manifest-as-plain-object decision (ADR-005) has a clear migration path.
- **Plugin marketplace:** a registry for discovering and installing community plugins. The manifest structure supports this.
- **Distributed broker:** multiple broker instances coordinating across services. The event bus and capability resolution protocol are designed to be serializable.
- **Runtime type validation:** deeper contract validation using Zod or io-ts schemas at runtime. The current shape-checking validation is a subset of this.

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

Note what is absent: there are no `budget/`, `discovery/`, or `context/` packages. Those would exist as separate application-layer libraries built on Rhodium, not as part of the framework itself.

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
  },
  activate(ctx) {
    ctx.provide<Greeter>('greeter', {
      greet: (name: string) => `Hello, ${name}!`,
    });
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
  },
  activate(ctx) {
    const greeter = ctx.resolve<Greeter>('greeter');
    ctx.registerCommand('say-hello', async (name: string) => {
      return greeter.greet(name);
    });
  },
};

// 4. Wire it up
const broker = createBroker();
broker.register(englishGreeter);
broker.register(greetingOrchestrator);
await broker.activate();

// 5. Use it — the broker wired the greeter into the orchestrator.
//    How the orchestrator uses that capability is its own business.
```

---

## Appendix C: Building on Rhodium — LLM Context, A2A Gateway

This appendix sketches how application-layer concerns live *on top of* Rhodium's composition primitives. These are not specifications; they're design directions showing that the core primitives are sufficient for real-world patterns.

### Pattern 1: LLM Context Assembler

An LLM context assembler is application-layer code (or a plugin) that:

1. Uses `broker.getManifests()` to discover what plugins are registered and what capabilities they provide
2. Uses `broker.resolve()` / `broker.resolveAll()` to access capability implementations
3. Translates capability contracts into tool descriptions the LLM can understand
4. Applies its own logic for what enters context — token budgets, priority, relevance ranking
5. Produces whatever context format the LLM API expects

```typescript
// This is APPLICATION code, not Rhodium core.
import { Broker } from 'rhodium';

function assembleContext(broker: Broker, query: string, maxTokens: number) {
  const manifests = broker.getManifests();

  // Translate capability contracts into LLM tool descriptions.
  // The capability contract IS the source of truth for what a
  // plugin can do. The assembler translates it into the format
  // the model needs — JSON Schema descriptions, natural language
  // summaries, examples, etc.
  const toolDescriptions = [];
  for (const [key, manifest] of manifests) {
    for (const cap of manifest.provides) {
      toolDescriptions.push(
        capabilityToToolDescription(cap, manifest)
      );
    }
  }

  // Apply whatever ranking/budget logic you want.
  // Rhodium doesn't care.
  return fitToBudget(toolDescriptions, maxTokens);
}
```

### Pattern 2: A2A Agent Gateway

An A2A gateway plugin exposes the composed system's capabilities to the outside world via the Agent2Agent Protocol, and wraps remote A2A agents as local Rhodium capabilities.

```typescript
// Outbound: expose Rhodium capabilities as an A2A Agent Card
const a2aServer: Plugin = {
  key: 'a2a-gateway',
  version: '1.0.0',
  manifest: {
    name: 'A2A Gateway',
    description: 'Exposes composed capabilities via A2A protocol',
    provides: [],
    needs: [{ capability: 'code-parser' }, { capability: 'safety-assessor' }],
  },
  activate(ctx) {
    const parser = ctx.resolve<CodeParser>('code-parser');
    const safety = ctx.resolve<SafetyAssessor>('safety-assessor');

    // Generate Agent Card skills from capability contracts.
    // The capability interfaces ARE the skills — the gateway
    // translates them into A2A's Agent Card format.
    const server = new A2AServer({
      name: 'Code Analysis Service',
      skills: [
        capabilityToA2ASkill('code-parser', parser),
        capabilityToA2ASkill('safety-assessor', safety),
      ],
    });

    // Route incoming A2A tasks to resolved capabilities.
    // The broker wired these during activation. The gateway
    // just translates between A2A's task model and Rhodium's
    // typed capability interfaces.
    server.onTask('code-analysis', async (task) => {
      const usages = parser.findFlagUsages(task.filePath, task.flagName);
      const assessment = safety.assess(usages);
      return { usages, assessment };
    });

    server.listen(3000);
  },
};

// Inbound: wrap a remote A2A agent as a local Rhodium capability
const remoteExpensePlugin: Plugin = {
  key: 'remote-expense-processor',
  version: '1.0.0',
  manifest: {
    name: 'Expense Processor (A2A Remote)',
    description: 'Delegates expense processing to a remote A2A agent',
    provides: [{ capability: 'expense-processor' }],
    needs: [],
  },
  activate(ctx) {
    const a2aClient = new A2AClient('https://expense-agent.example.com');

    // To the rest of the system, this is just another plugin
    // providing the expense-processor capability. Nobody knows
    // or cares that it's backed by a remote A2A agent.
    ctx.provide('expense-processor', {
      process: (report) => a2aClient.sendTask({
        skill: 'expense-processing',
        data: report,
      }),
    });
  },
};
```

### Why This Works

In both patterns, Rhodium provides the internal composition layer — typed capability contracts, dependency resolution, lifecycle management. Application-layer code (the context assembler, the A2A gateway) translates between Rhodium's typed internal world and whatever external format is needed.

The capability contracts are the single source of truth for what the system can do. An LLM context assembler translates them into tool descriptions. An A2A gateway translates them into Agent Card skills. A CLI could translate them into help text. The broker doesn't know about any of these translations, and that's exactly what makes the system composable.
