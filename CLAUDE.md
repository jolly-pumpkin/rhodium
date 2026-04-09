# Rhodium

TypeScript framework for composing capability-driven systems from plugins. The broker resolves typed `provides`/`needs` contracts at runtime. When plugins participate in LLM inference, Rhodium adds first-class token budget management and manifest-first tool discovery.

## What This Is (and Is Not)

**Is:** A ~5KB TypeScript library. A broker that wires plugins together via typed capability contracts.

**Is not:** An LLM wrapper, an agent framework, a deployment platform, or any of the PoC applications built on top of it. Model calls happen in plugins — never in core.

## Plans

Implementation plans go in `scratch/plans/`. Format: `YYYY-MM-DD-<feature-name>.md`.

## Repository Layout

Monorepo. Nothing is implemented yet — this is in the design/RFC phase.

```
packages/
  core/          # broker.ts, registry.ts, lifecycle.ts, events.ts
  capabilities/  # define.ts, validate.ts
  budget/        # allocator.ts, counter.ts
  discovery/     # index-builder.ts, search.ts, ranking.ts
  graph/         # dag.ts, resolver.ts, cycle-detect.ts
  context/       # pipeline.ts, middleware.ts
  testing/       # test-broker.ts, mock-context.ts
```

Main package is `rhodium` (re-exports all sub-packages). Sub-packages are importable directly for tree-shaking: `rhodium/core`, `rhodium/capabilities`, `rhodium/testing`.

## Core Primitives

### Broker
Central runtime. One per process. Created with `createBroker(config?)`, then `broker.register(plugin)` each plugin, then `broker.activate()`. Key methods: `resolve<T>()`, `resolveAll<T>()`, `resolveOptional<T>()`, `searchTools()`, `assembleContext()`.

### Plugin
Plain object conforming to `Plugin` interface — no base class, no decorators. Has a `key` (kebab-case, globally unique), `version` (semver), `manifest`, and optional `activate(ctx)`, `deactivate()`, `contributeContext(budget)`, `onDependencyRemoved()` hooks.

### Manifest
Static, serializable. The broker indexes manifests at registration without executing plugin code. Contains `provides[]`, `needs[]`, `tools[]`, `tags[]`.

### PluginContext
Passed to `activate()`. Provides `resolve()`, `resolveAll()`, `resolveOptional()`, `provide()`, `registerToolHandler()`, `registerCommand()`, `reportError()`, `emit()`.

## Design Decisions

**Plain objects over classes (ADR-002).** No inheritance. Plugin shape is the contract.

**Synchronous context assembly (ADR-003).** `contributeContext()` must be synchronous and complete in <5ms for 20 plugins. Plugins fetch async data during `activate()` and cache it — no I/O inside `contributeContext()`.

**chars/4 token counting by default (ADR-004).** ~90% accurate, zero dependencies. Exact counting via `tokenCounter: 'tiktoken'` when needed.

**No LLM calls in core (ADR-005).** The broker assembles context. What happens with that context is the application's problem.

**In-process manifests (ADR-006).** Manifests are plain JS objects in the plugin module, not separate JSON files. No sync burden between manifest and code.

**Event bus over direct callbacks (ADR-007).** Plugins don't reference each other. Decoupling via `broker.on()` / `ctx.emit()`.

## Capability Contracts

```typescript
import { defineCapability } from 'rhodium';
// capability name → TypeScript interface
// broker validates provider shapes at activate() time
```

Resolution rules:
- Single provider → return it
- Multiple providers, single expected → highest `priority` wins, recency breaks ties
- Multiple providers, `multiple: true` → return all sorted by priority
- Missing required → `CapabilityNotFoundError` at activation
- Missing optional → `undefined`
- Variant filtering → `variant` field on `DependencyDeclaration`

## Token Budget

`TokenBudgetConfig`: `maxTokens`, `reservedSystemTokens`, `reservedToolTokens`, `allocationStrategy` (`'priority'` | `'proportional'` | `'equal'`, default `'priority'`).

`assembleContext()` runs a 6-stage pipeline: Collect → Prioritize → Budget → Discover → Middleware → Serialize.

Tool merge: manifest tools are the baseline; `contributeContext()` tools override by name, add new ones, and concatenate examples.

## Manifest-First Tool Discovery

Implements the "Tool Search Tool" pattern (85% token reduction). `broker.searchTools(query)` searches the index without activating plugins. TF-IDF ranking: tool name (3x), description (2x), tags (2x), plugin description (1x), plugin tags (1x).

Optional `lazyActivation: true` in `BrokerConfig` enables on-demand plugin activation when tools are selected for context.

## Error System

All errors extend `RhodiumError` with `.code` and `.pluginKey`. Typed errors: `CapabilityNotFoundError`, `CircularDependencyError`, `ActivationTimeoutError`, `ActivationError`, `CapabilityViolationError`, `DuplicatePluginError`, `ToolExecutionError`, `BudgetExceededError`.

Error boundaries per plugin. A plugin failure never propagates unless there is a declared dependency relationship.

## Plugin Lifecycle States

`registered` → `resolving` → `active` → `inactive` → `unregistered`
Any state can transition to `failed` on error.

Hot registration is supported after `broker.activate()`: register a new plugin and call `broker.activatePlugin(key)`.

## Testing

```typescript
import { createTestBroker } from 'rhodium/testing';
const { broker, mockContext } = createTestBroker();
```

Plugins are plain objects — test them with a mock `PluginContext` in isolation.

## Performance Targets

| Operation | Target |
|-----------|--------|
| Core bundle | <5KB min+gz |
| `assembleContext()` | <5ms (20 plugins) |
| `broker.register()` | <1ms per plugin |
| `broker.activate()` | <100ms (20 plugins) |
| `searchTools()` | <2ms (100 tools) |
| Memory per plugin | <10KB baseline |

## Out of Scope for Core

LLM API integration, prompt engineering, agent orchestration logic, specific tool implementations, UI/CLI, deployment, PoC applications (feature flag cleanup agent, SWE-bench pipeline, etc.), state management bindings, micro-frontend orchestration.

## Compatibility

- Bun 1.0+, modern browsers (ES2022+)
- TypeScript 5.0+ (required for type-level capability contracts)
- ESM primary
- Zero runtime dependencies in core; optional peer deps for tiktoken, Zod
