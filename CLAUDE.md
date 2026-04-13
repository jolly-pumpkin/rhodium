# Rhodium

TypeScript framework for composing capability-driven systems from plugins. The broker resolves typed `provides`/`needs` contracts at runtime — a pure composition runtime, not a resource manager.

## What This Is (and Is Not)

**Is:** A ~3KB TypeScript library. A broker that wires plugins together via typed capability contracts.

**Is not:** An LLM wrapper, an agent framework, a token budget manager, a tool discovery engine, or any of the PoC applications built on top of it. Model calls, token budgets, and context assembly happen in application-layer code — never in core.

## Plans

Implementation plans go in `scratch/plans/`. Format: `YYYY-MM-DD-<feature-name>.md`.

## Repository Layout

Monorepo with 5 packages.

```
packages/
  core/          # broker.ts, registry.ts, lifecycle.ts, events.ts
  capabilities/  # define.ts, validate.ts
  graph/         # dag.ts, resolver.ts, cycle-detect.ts
  testing/       # test-broker.ts, mock-context.ts
  rhodium/       # barrel re-exports
```

Main package is `rhodium` (re-exports all sub-packages). Sub-packages are importable directly for tree-shaking: `rhodium/core`, `rhodium/capabilities`, `rhodium/graph`, `rhodium/testing`.

## Core Primitives

### Broker
Central runtime. One per process. Created with `createBroker(config?)`, then `broker.register(plugin)` each plugin, then `broker.activate()`. Key methods: `resolve<T>()`, `resolveAll<T>()`, `resolveOptional<T>()`, `getManifests()`, `getManifest()`, `getPluginStates()`.

### Plugin
Plain object conforming to `Plugin` interface — no base class, no decorators. Has a `key` (kebab-case, globally unique), `version` (semver), `manifest`, and optional `activate(ctx)`, `deactivate()`, `onDependencyRemoved(capability, providerKey)` hooks.

### Manifest
Static, serializable. The broker indexes manifests at registration without executing plugin code. Contains required `name`, `description`, and arrays `provides[]`, `needs[]`, optional `tags[]`.

### PluginContext
Passed to `activate()`. Provides `resolve()`, `resolveAll()`, `resolveOptional()`, `provide()`, `registerCommand()`, `reportError()`, `emit()`.

## Design Decisions

**Plain objects over classes (ADR-002).** No inheritance. Plugin shape is the contract.

**No LLM calls in core (ADR-005).** The broker wires plugins. What plugins do with capabilities is the application's problem.

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

## Error System

All errors extend `RhodiumError` with `.code` and `.pluginKey`. Typed errors: `CapabilityNotFoundError`, `CircularDependencyError`, `ActivationTimeoutError`, `ActivationError`, `CapabilityViolationError`, `DuplicatePluginError`, `UndeclaredCapabilityError`.

Error boundaries per plugin. A plugin failure never propagates unless there is a declared dependency relationship.

## Plugin Lifecycle States

`PluginStatus`: `registered` → `resolving` → `active` → `inactive` → `unregistered`
Any state can transition to `failed` on error.

`PluginState` is a rich object with `status`, `activeCapabilities`, `registeredCommands`, `dependencies`, `lastTransition`.

Hot registration is supported after `broker.activate()`: register a new plugin and call `broker.activatePlugin(key)`.

## Events

`BrokerEvent` types: `plugin:registered`, `plugin:unregistered`, `plugin:activating`, `plugin:activated`, `plugin:deactivating`, `plugin:deactivated`, `plugin:error`, `capability:provided`, `capability:removed`, `dependency:resolved`, `dependency:unresolved`, `broker:activated`, `broker:deactivated`.

## Testing

```typescript
import { createTestBroker } from 'rhodium/testing';
const { broker, mockContext } = createTestBroker();
```

Plugins are plain objects — test them with a mock `PluginContext` in isolation.

## Performance Targets

| Operation | Target |
|-----------|--------|
| Core bundle | <3KB min+gz |
| `broker.register()` | <1ms per plugin |
| `broker.activate()` | <100ms (20 plugins) |
| Memory per plugin | <10KB baseline |

## Out of Scope for Core

Token budgets, tool discovery, context assembly, LLM API integration, prompt engineering, agent orchestration logic, specific tool implementations, UI/CLI, deployment, PoC applications, state management bindings, micro-frontend orchestration, middleware pipelines.

## Compatibility

- Bun 1.0+, modern browsers (ES2022+)
- TypeScript 5.0+ (required for type-level capability contracts)
- ESM primary
- Zero runtime dependencies in core; optional peer dep for Zod
