# Rhodium Core

Central broker runtime. Implements plugin lifecycle, dependency resolution, capability matching, and context assembly orchestration.

## Key Modules

- `broker.ts` — Broker class, plugin registration, activation
- `registry.ts` — Capability registry, provider lookup
- `lifecycle.ts` — State machine (registered → resolving → active → inactive → unregistered)
- `events.ts` — Event bus (decouples plugins)

## Performance Targets

- `broker.register()`: <1ms per plugin
- `broker.activate()`: <100ms (20 plugins)
- State transitions: atomic, no tearing

## Patterns

**Plugin lifecycle:** Always verify state transitions are atomic. Use `_state` internal field, never allow partial activation.

**Error boundaries:** A plugin failure never propagates unless declared as a dependency. Use try-catch in activate, emit error event, fail locally.

**Capability resolution:** Highest priority wins for single resolution; all sorted by priority for `multiple: true`. Implement deterministically — same resolution result every time.

## Tests

- Unit tests for each state transition
- Integration tests for 3+ plugins with dependencies
- Performance tests ensure <1ms/register, <100ms/activate targets

## Interdependencies

- Depends on: `graph` (resolver), `events` (event bus)
- Depended on by: all other packages
