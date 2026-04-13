# Rhodium Testing

Test utilities for isolating plugins and broker behavior.

## Key Modules

- `test-broker.ts` — Lightweight broker for tests with event recording
- `mock-context.ts` — Mock PluginContext for unit testing plugins in isolation

## Patterns

**Unit test a plugin (in isolation):**
```typescript
import { createMockContext } from 'rhodium/testing';

const ctx = createMockContext();
// Call plugin.activate(ctx) directly
// Assert ctx.provide() calls, ctx.emit() events, etc.
```

**Integration test plugins together:**
```typescript
import { createTestBroker } from 'rhodium/testing';

const { broker, mockContext } = createTestBroker();
broker.register(pluginA);
broker.register(pluginB);
await broker.activate();
```

## What NOT to Mock

- **Broker internals** — Don't mock the resolver, registry, or lifecycle. Use a real broker.
- **Manifest** — Don't mock manifest shapes; use actual manifests. Tests catch manifest/code drift.
- **Capability validation** — Don't skip validators to make tests pass; fix the shape instead.

## What TO Mock

- **External I/O** — Database, HTTP, filesystems (plugins fetch async during activate)
- **Expensive operations** — Use test doubles for slow algorithm implementations

## Tests

- Plugin isolation: each plugin tested with mock context, verifies provide/emit/resolve calls
- Integration: 3+ plugins with dependencies, full activation
- Error paths: missing dependency, capability violation, timeout, circular dependency
