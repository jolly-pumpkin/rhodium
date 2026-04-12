# Rhodium Implementation Tickets

## Legend

- **Priority:** P0 (must have first), P1 (core), P2 (important), P3 (nice to have)
- **Size:** S (< 2hrs), M (2-4hrs), L (4-8hrs), XL (8+ hrs)
- **Deps:** tickets that must be completed first

---

## 0. Project Scaffolding

### RHOD-001: Monorepo Setup  **DONE** 
**Priority:** P0 | **Size:** M | **Deps:** none 

Set up the monorepo workspace structure with Bun workspaces. Create `packages/core`, `packages/capabilities`, `packages/budget`, `packages/discovery`, `packages/graph`, `packages/context`, `packages/testing` with their `package.json` files. Configure TypeScript 5.0+ with shared `tsconfig.json`. ESM primary output. Add root `package.json` with workspace config.

**Acceptance:**
- [x] `bun install` succeeds from root
- [x] Each sub-package compiles independently
- [x] Imports like `rhodium/core`, `rhodium/capabilities` resolve correctly
- [x] ES2022 target, strict TypeScript

### RHOD-002: Shared Type Definitions **DONE** 
**Priority:** P0 | **Size:** M | **Deps:** RHOD-001

Define all shared TypeScript interfaces and types from the ARD in a `packages/core/src/types.ts` (or split across packages as appropriate):

- `BrokerConfig`, `Broker`, `BrokerEvent`, `BrokerEventPayload`, `BudgetOverflowPayload`, `BrokerEventHandler`
- `Plugin`, `PluginManifest`, `CapabilityDeclaration`, `DependencyDeclaration`
- `ToolDeclaration`, `ToolExample`, `ToolSearchFilter`, `ToolSearchResult`
- `PluginContext`, `ToolHandler`, `CommandHandler`, `ToolResult`, `ErrorSeverity`
- `PluginLogger`, `BrokerLog`, `BrokerLogEntry`, `PluginState`, `ActivationResult`
- `TokenBudgetConfig`, `ContextRequest`, `RemainingBudget`, `ContextContribution`
- `AssembledContext`, `AssembledTool`, `DroppedContribution`, `AssemblyMeta`
- `MiddlewarePlugin`, `ToolCall`
- `DependencyGraph`, `DependencyCheck`
- `CapabilityContract`, `CapabilityViolation`, `CapabilityValidator`

**Acceptance:**
- [x] All interfaces from ARD sections 4-13 are defined
- [x] Types compile cleanly with no `any` escape hatches
- [x] Re-exported from each package's `index.ts`

---

## 1. Error System (`packages/core`)

### RHOD-003: Typed Error Classes  **DONE** 
**Priority:** P0 | **Size:** S | **Deps:** RHOD-002

Implement the error hierarchy:

- `RhodiumError` base class with `.code`, `.pluginKey`, `.timestamp`
- `CapabilityNotFoundError` — must include what was needed, who needed it, and available capabilities (see ARD Section 12 formatting)
- `CircularDependencyError` — must include full cycle path as ASCII chain
- `ActivationTimeoutError`
- `ActivationError`
- `CapabilityViolationError` — must include specific shape mismatches (missing methods, wrong arity)
- `DuplicatePluginError`
- `DuplicateToolError` — must include both plugin keys and conflicting tool name
- `ToolExecutionError`
- `BudgetExceededError`
- `ContributionTooLargeError`

**Acceptance:**
- [x] Each error has a unique `.code` string constant
- [x] Error messages are actionable per ARD Section 12 formatting requirements
- [x] All errors extend `RhodiumError`
- [x] Unit tests for error message formatting

---

## 2. Event Bus (`packages/core`)

### RHOD-004: Event Emitter **DONE** 
**Priority:** P0 | **Size:** S | **Deps:** RHOD-002 

Implement a typed event bus supporting all `BrokerEvent` types. Must support:

- `on(event, handler)` returning an unsubscribe function
- `emit(event, payload)` with `BrokerEventPayload`
- Custom events via `ctx.emit()` (string event names)
- No external dependencies

**Acceptance:**
- [x] All 15 `BrokerEvent` types from ARD Section 4.1 are supported
- [x] Unsubscribe function works correctly
- [x] Custom string events supported for plugin-to-plugin communication
- [x] Unit tests for subscribe, emit, unsubscribe

---

## 3. Plugin Registry (`packages/core`)

### RHOD-005: Plugin Registry **DONE**
**Priority:** P0 | **Size:** M | **Deps:** RHOD-003, RHOD-004

Implement `registry.ts`:

- Store registered plugins by key
- Index manifests at registration time (no plugin code execution)
- Enforce unique plugin keys (throw `DuplicatePluginError`)
- Enforce unique tool names across plugins (throw `DuplicateToolError`)
- Track plugin state: `registered → resolving → active → inactive → failed → unregistered`
- Emit `plugin:registered`, `plugin:unregistered` events
- Support `unregister()` — call `deactivate()` if active, remove from registry
- `getPluginStates()` returns `Map<string, PluginState>`
- `< 1ms` per `register()` call

**Acceptance:**
- [ ] Register/unregister lifecycle works
- [ ] Duplicate plugin key throws with both keys in message
- [ ] Duplicate tool name throws with both plugin keys and tool name
- [ ] State machine transitions are correct
- [ ] Events emitted on registration/unregistration
- [ ] Performance: register < 1ms

---

## 4. Dependency Graph (`packages/graph`)

### RHOD-006: DAG Construction & Cycle Detection **DONE**
**Priority:** P0 | **Size:** M | **Deps:** RHOD-002, RHOD-003

Implement `dag.ts` and `cycle-detect.ts`:

- `DependencyGraph` interface: `addPlugin()`, `removePlugin()`, `getActivationOrder()`, `canActivate()`, `getDependents()`
- Build directed graph from `manifest.needs` → `manifest.provides` relationships
- Kahn's algorithm for topological sort and cycle detection
- `CircularDependencyError` with full cycle path on detection
- Detect cycles at registration time

**Acceptance:**
- [x] Topological ordering is correct for complex graphs
- [x] Cycle detection works and includes full cycle path
- [x] `canActivate()` correctly identifies unsatisfied dependencies
- [x] `getDependents()` returns transitive dependents
- [x] Unit tests for: linear chains, diamond dependencies, independent groups, cycles

### RHOD-007: Dependency Resolver **DONE**
**Priority:** P0 | **Size:** M | **Deps:** RHOD-006

Implement `resolver.ts`:

- Resolution rules from ARD Section 5:
  - Single provider → return it
  - Multiple providers, single expected → highest `priority` wins, recency breaks ties
  - Multiple providers, `multiple: true` → return all sorted by priority
  - Missing required → `CapabilityNotFoundError` at activation
  - Missing optional → `undefined`
  - Variant filtering → filter by `variant` field before applying rules
- Order-independent plugin registration (late arrival support)

**Acceptance:**
- [x] All 6 resolution rules pass
- [x] Priority + recency tiebreaking works
- [x] Variant filtering works
- [x] Late arrival scenario works
- [x] Error messages include available capabilities list

---

## 5. Capability System (`packages/capabilities`)

### RHOD-008: `defineCapability()` and Validation **DONE**
**Priority:** P1 | **Size:** M | **Deps:** RHOD-002, RHOD-003

Implement `define.ts` and `validate.ts`:

- `defineCapability<T>(name: string)` — returns a typed capability token
- `CapabilityValidator.validate(contract, implementation)` — structural shape checking:
  - Check method names exist
  - Check method arity
  - Check required properties exist
  - Return `CapabilityViolation[]`
- `CapabilityViolationError` with specific shape mismatches per ARD formatting

**Acceptance:**
- [x] `defineCapability()` produces a typed token usable for resolution
- [x] Validation catches: missing methods, missing properties, wrong arity
- [x] Validation passes for conforming implementations
- [x] Error messages match ARD Section 12 format
- [x] No runtime type system dependency (shape-checking only)

---

## 6. Lifecycle Manager (`packages/core`)

### RHOD-009: Plugin Activation & Deactivation **DONE**
**Priority:** P1 | **Size:** L | **Deps:** RHOD-005, RHOD-006, RHOD-007, RHOD-008

Implement `lifecycle.ts`:

- `broker.activate()`:
  - Activate plugins in topological order from dependency graph
  - Sequential within dependency chains, parallel across independent chains (`Promise.all`)
  - Create `PluginContext` per plugin per activation
  - Call `plugin.activate(ctx)` with resolved dependencies
  - Enforce `activationTimeoutMs` (default 30s)
  - Return `ActivationResult` with `activated`, `failed`, `pending`, `durationMs`
  - Transition states: `registered → resolving → active` or `→ failed`
- `broker.deactivate()`:
  - Deactivate in reverse dependency order
  - Call `plugin.deactivate()` on each
  - Log errors from deactivate but transition to `inactive` regardless
- `broker.activatePlugin(key)` for hot registration
- Error boundary per plugin: catch errors from `activate()`, emit `plugin:error`, transition to `failed`
- Emit lifecycle events: `plugin:activating`, `plugin:activated`, `plugin:deactivating`, `plugin:deactivated`, `broker:activated`, `broker:deactivated`

**Acceptance:**
- [x] Topological activation order respected
- [x] Parallel activation across independent chains
- [x] Timeout enforced
- [x] `ActivationResult` correctly populated
- [x] Error in one plugin doesn't crash others (unless dependency)
- [x] Hot registration works after initial `activate()`
- [x] All lifecycle events emitted
- [x] Performance: < 100ms for 20 plugins

### RHOD-010: PluginContext Implementation **DONE**
**Priority:** P1 | **Size:** M | **Deps:** RHOD-009

Implement the `PluginContext` interface:

- `resolve<T>()`, `resolveAll<T>()`, `resolveOptional<T>()` — delegating to resolver
- `provide<T>(capability, implementation)` — validate against manifest + capability contract
- `registerToolHandler(toolName, handler)` — verify tool declared in manifest
- `registerCommand(commandName, handler)`
- `reportError(error, severity)` — emit `plugin:error` event, don't deactivate
- `emit(event, payload)` — emit through broker event bus
- `pluginKey` readonly
- `log: PluginLogger` — scoped logger tagged with plugin key

**Acceptance:**
- [x] All `PluginContext` methods work correctly
- [x] `provide()` throws if capability not in manifest
- [x] `provide()` runs capability validation
- [x] `registerToolHandler()` throws if tool not in manifest
- [x] Logger entries tagged with plugin key
- [x] New context created per plugin per activation (no state leakage)

---

## 7. Token Budget (`packages/budget`)

### RHOD-011: Token Counter **DONE**
**Priority:** P1 | **Size:** S | **Deps:** RHOD-002

Implement `counter.ts`:

- `chars3` strategy: `Math.ceil(text.length / 3)` (default, conservative for code-heavy payloads per ADR-004)
- `chars4` strategy: `Math.ceil(text.length / 4)` (optional, for prose-dominant use cases)
- `tiktoken` strategy: optional peer dep integration
- Custom function strategy: `(text: string) => number`
- Factory: `createTokenCounter(config) => (text: string) => number`

**Acceptance:**
- [x] Default is `chars3` (conservative, code-heavy accuracy per ADR-004)
- [x] All 4 strategies work
- [x] Custom function passthrough works
- [x] Zero dependencies for chars strategies

### RHOD-012: Budget Allocator
**Priority:** P1 | **Size:** L | **Deps:** RHOD-011

Implement `allocator.ts`:

- Three allocation strategies: `priority`, `proportional`, `equal`
- **Priority strategy:**
  - Sort contributions by priority descending
  - Iterate high-to-low, allocate up to remaining tokens
  - `atomic: true` → drop entirely if won't fit (don't truncate)
  - `minTokens` → drop if remaining budget < minTokens
  - Emit `budget:overflow` with severity for each drop/truncation
- **Proportional strategy:**
  - Each contribution gets `(priority / totalPriority) * remainingBudget`
  - Respect `atomic` and `minTokens` constraints
- **Equal strategy:**
  - Each contribution gets `remainingBudget / numContributions`
  - Same constraint handling
- Deduct `reservedSystemTokens` and `reservedToolTokens` before allocation
- `maxContributionBytes` enforcement (default 256KB) before entering pipeline
- Compute severity: priority > 80 → critical, > 50 → warning, <= 50 → info

**Acceptance:**
- [ ] All three strategies produce correct allocations
- [ ] `atomic` contributions are never truncated
- [ ] `minTokens` respected
- [ ] Reserved tokens deducted correctly
- [ ] `maxContributionBytes` enforced with `ContributionTooLargeError`
- [ ] `budget:overflow` events emitted with correct severity
- [ ] `DroppedContribution` array populated correctly

---

## 8. Tool Discovery (`packages/discovery`)

### RHOD-013: Search Index Builder **DONE**
**Priority:** P1 | **Size:** M | **Deps:** RHOD-002

Implement `index-builder.ts`:

- Build in-memory search index from plugin manifests at registration time
- Index fields: tool `name` (3x weight), tool `description` (2x), tool `tags` (2x), plugin `tags` (1x), plugin `description` (1x)
- Support incremental updates: add/remove plugins without full rebuild
- No plugin code execution

**Acceptance:**
- [x] Index built from manifests only
- [x] Incremental add/remove works
- [x] Weighted fields stored correctly
- [x] Zero external dependencies

### RHOD-014: Tool Search & Ranking **DONE**
**Priority:** P1 | **Size:** M | **Deps:** RHOD-013

Implement `search.ts` and `ranking.ts`:

- `searchTools(query: string | ToolSearchFilter)` → `ToolSearchResult[]`
- TF-IDF-style scoring across weighted fields
- Structured filters: `capability`, `tags` as boolean pre-filters before scoring
- `limit` (default 10), `minRelevance` (default 0.1)
- Return `relevanceScore` (0-1) and `isPluginActivated` flag
- Performance: < 2ms for 100 tools

**Acceptance:**
- [x] Natural language queries return relevant tools
- [x] Structured filters narrow results correctly
- [x] Scoring weights match ARD spec
- [x] `limit` and `minRelevance` work
- [x] Performance target met
- [x] Unit tests with realistic tool sets

---

## 9. Context Assembly (`packages/context`)

### RHOD-015: Context Assembly Pipeline **DONE**
**Priority:** P1 | **Size:** XL | **Deps:** RHOD-010, RHOD-012, RHOD-014

Implement `pipeline.ts` — the 6-stage assembly pipeline:

1. **Collect** — call `contributeContext(request, budget)` on each active plugin. Enforce `maxContributionBytes`. Merge tools: runtime overrides manifest by name, new names added, examples concatenated + deduplicated by scenario.
2. **Prioritize** — sort contributions by priority descending.
3. **Budget** — allocate tokens per strategy via the budget allocator. Drop/truncate as needed.
4. **Discover** — run tool search if query present. Filter to budget-surviving tools.
5. **Middleware** — run `postAssembly` middleware hooks.
6. **Serialize** — produce `AssembledContext` with `systemPrompt`, `tools`, `totalTokens`, `dropped`, `meta`. Emit `context:assembled` event.

- Error boundary around each plugin's `contributeContext()`: catch errors, skip contribution, keep plugin active
- Entirely synchronous (no async, no I/O)
- Support `ContextRequest<TState>` generic passthrough

**Acceptance:**
- [x] All 6 stages execute in order
- [x] Tool merge strategy correct (override by name, add new, concat examples)
- [x] Budget allocation applied correctly
- [x] Tool search integrated when query present
- [x] Middleware hooks run
- [x] `AssembledContext` fully populated including `meta`
- [x] Error in one plugin's `contributeContext()` doesn't affect others
- [x] Performance: < 5ms for 20 plugins
- [x] `context:assembled` event emitted

### RHOD-016: Middleware System **DONE**
**Priority:** P2 | **Size:** M | **Deps:** RHOD-015

Implement `middleware.ts`:

- `MiddlewarePlugin` interface: `preToolCall`, `postToolCall`, `postAssembly`
- Middleware registered as plugins with a special `middleware` capability
- Multiple middleware plugins execute in priority order
- `preToolCall` can modify params, skip the call, or inject additional calls
- `postToolCall` can transform/summarize results
- `postAssembly` can deduplicate, merge, or transform assembled context

**Acceptance:**
- [x] Middleware hooks execute in priority order
- [x] `preToolCall` can modify, skip, or inject calls
- [x] `postToolCall` transforms results
- [x] `postAssembly` transforms assembled context
- [x] Middleware is registered via standard plugin mechanism

---

## 10. Broker Facade (`packages/core`)

### RHOD-017: `createBroker()` Public API **DONE**
**Priority:** P1 | **Size:** L | **Deps:** RHOD-009, RHOD-015

Implement `broker.ts` — the top-level `createBroker(config?)` function that composes all subsystems:

- Instantiate registry, graph, resolver, event bus, lifecycle, pipeline, search index
- Expose the `Broker` interface: `register()`, `unregister()`, `activate()`, `deactivate()`, `searchTools()`, `assembleContext()`, `resolve()`, `resolveAll()`, `resolveOptional()`, `on()`, `getLog()`, `getPluginStates()`
- Apply `BrokerConfig` defaults: `tokenCounter: 'chars3'`, `activationTimeoutMs: 30_000`, `maxContributionBytes: 262_144`, `debug: false`
- `lazyActivation` option for on-demand plugin activation during context assembly
- `onUnhandledError` handler
- `getLog()` returns structured `BrokerLog` with filtering
- Zero module-level mutable state (ADR-009)

**Acceptance:**
- [x] Full `Broker` interface implemented
- [x] All config defaults applied
- [x] Lazy activation works when enabled
- [x] Structured logging works in debug mode
- [x] `getLog()` filtering by event type and plugin key
- [x] Two brokers in same process are fully independent
- [x] End-to-end test: register plugins, activate, assemble context, resolve capabilities

---

## 11. Testing Utilities (`packages/testing`)

### RHOD-018: `createTestBroker()` and Mock Context **DONE**
**Priority:** P2 | **Size:** M | **Deps:** RHOD-017

Implement `test-broker.ts` and `mock-context.ts`:

- `createTestBroker()` → `{ broker, mockContext }` with sensible defaults
- `mockContext` records events, tool calls, commands for assertion
- Simplified registration flow for tests

**Acceptance:**
- [x] `createTestBroker()` returns usable broker
- [x] `mockContext` records all interactions
- [x] Can test plugins in isolation with mock context

### RHOD-019: Context Assertion Utilities **DONE**
**Priority:** P2 | **Size:** S | **Deps:** RHOD-018

Implement assertion functions:

- `assertContextIncludes(context, { plugins?, tools?, minTokenUtilization? })` — throws `AssertionError` with detailed diff
- `assertNoCriticalDrops(context)` — throws if any priority > 80 dropped
- `assertNoDropsAbovePriority(context, minPriority)` — parameterized version

**Acceptance:**
- [x] All three assertions work correctly
- [x] Error messages include detailed diff / drop info
- [x] Usable in standard test frameworks (no test runner dependency)

---

## 12. Main Package Re-exports

### RHOD-020: `rhodium` Package Barrel Exports **DONE**
**Priority:** P2 | **Size:** S | **Deps:** RHOD-017, RHOD-018

Configure the main `rhodium` package to re-export public API from all sub-packages:

- `rhodium` → full API
- `rhodium/core` → broker, registry, lifecycle, events
- `rhodium/capabilities` → defineCapability, validate
- `rhodium/budget` → allocator, counter
- `rhodium/discovery` → search, indexing
- `rhodium/context` → pipeline, middleware
- `rhodium/graph` → dag, resolver
- `rhodium/testing` → test broker, assertions

**Acceptance:**
- [x] `import { createBroker, defineCapability, Plugin } from 'rhodium'` works
- [x] `import { createBroker } from 'rhodium/core'` works
- [x] `import { createTestBroker } from 'rhodium/testing'` works
- [x] Tree-shaking works for sub-package imports

---

## 13. Integration & Validation

### RHOD-021: End-to-End Integration Test **DONE**
**Priority:** P2 | **Size:** L | **Deps:** RHOD-017

Implement the "Minimal Working Example" from ARD Appendix B as an integration test:

- Define capability, create provider plugin, create consumer plugin
- Register, activate, assemble context, resolve capabilities
- Verify system prompt, tools, examples all present
- Verify tool handler execution
- Verify command execution

**Acceptance:**
- [x] Full example from ARD Appendix B runs successfully
- [x] Context assembly produces expected output
- [x] Capability resolution works end-to-end
- [x] Tool handler invocation works

### RHOD-022: Budget Stress Test Suite
**Priority:** P2 | **Size:** M | **Deps:** RHOD-017, RHOD-019

Write stress tests per ARD Section 13:

- 15 cleanup rule plugins + safety assessor with tight budget (4096 tokens)
- Assert safety assessor (priority 90) survives
- Assert no critical drops
- Test all three allocation strategies under pressure
- Test `atomic` and `minTokens` edge cases

**Acceptance:**
- [x] High-priority plugins survive budget pressure
- [x] `assertNoCriticalDrops` passes
- [x] All allocation strategies tested under constraint
- [x] `atomic` and `minTokens` edge cases covered

### RHOD-023: Performance Benchmarks
**Priority:** P3 | **Size:** M | **Deps:** RHOD-017

Create benchmark suite validating NFR targets:

- `broker.register()` < 1ms per plugin
- `broker.activate()` < 100ms for 20 plugins
- `assembleContext()` < 5ms for 20 plugins
- `searchTools()` < 2ms for 100 tools
- Memory per plugin < 10KB baseline
- Core bundle < 5KB min+gz

**Acceptance:**
- [ ] All targets from ARD Section 15 validated
- [ ] Benchmarks runnable via `bun run bench`

---

## Suggested Build Order

```
Phase 1 — Foundation (do first, everything depends on these):
  RHOD-001 → RHOD-002 → RHOD-003 → RHOD-004

Phase 2 — Core Subsystems (can partially parallelize):
  RHOD-005 (registry)
  RHOD-006 → RHOD-007 (graph + resolver)
  RHOD-008 (capabilities)
  RHOD-011 (token counter)

Phase 3 — Orchestration (depends on Phase 2):
  RHOD-009 → RHOD-010 (lifecycle + plugin context)
  RHOD-012 (budget allocator)
  RHOD-013 → RHOD-014 (discovery)

Phase 4 — Assembly & Broker (depends on Phase 3):
  RHOD-015 → RHOD-016 (context pipeline + middleware)
  RHOD-017 (broker facade)

Phase 5 — Testing & Polish:
  RHOD-018 → RHOD-019 (test utilities)
  RHOD-020 (re-exports)
  RHOD-021, RHOD-022, RHOD-023 (integration, stress, benchmarks)
```
