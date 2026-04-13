# rhodium

TypeScript framework for composing capability-driven systems from plugins. The broker resolves typed `provides`/`needs` contracts at runtime — a pure composition runtime, not a resource manager.

## What This Is

A ~3KB TypeScript library for composing software systems from independently deployable plugins with typed capability contracts. The broker wires them together at runtime.

**Is:** A broker that resolves typed `provides`/`needs` contracts. A plugin lifecycle manager. A capability composition runtime.

**Not:** An LLM wrapper, an agent framework, a token budget manager, a tool discovery engine, or any PoC application built on it. Model calls, token budgets, and context assembly happen in application-layer code — never in core.

## Design Philosophy

- **Composition over coupling** — Plugins declare what they provide and need. The broker resolves wiring. No plugin references another directly.
- **Interfaces over implementations** — Swap the model provider, tool set, or memory backend without touching anything that depends on them.
- **Declarative over imperative** — Declare the capability graph; let the broker reconcile it.
- **Isolation over propagation** — A failing plugin fails loudly and locally. It doesn't corrupt downstream behavior.
- **Manifest-first** — The broker knows what every plugin offers by reading its manifest. Code runs only when needed.

## Install

```bash
bun add rhodium
```

## Quick Start

```typescript
import { createBroker } from 'rhodium';

const broker = createBroker();

// Plugin 1: Provides a logger
const loggerPlugin = {
  key: 'logger',
  version: '1.0.0',
  manifest: {
    name: 'Logger',
    description: 'Provides structured logging',
    provides: [{ capability: 'logger', priority: 100 }],
    needs: [],
  },
  activate(ctx) {
    ctx.provide('logger', {
      info: (msg: string) => console.log(`[INFO] ${msg}`),
      error: (msg: string, err?: Error) => console.error(`[ERROR] ${msg}`, err),
    });
  },
};

// Plugin 2: Depends on logger, provides a greeter
const greeterPlugin = {
  key: 'greeter',
  version: '1.0.0',
  manifest: {
    name: 'Greeter',
    description: 'Greets users with logging',
    provides: [{ capability: 'greeter' }],
    needs: [{ capability: 'logger' }],
  },
  activate(ctx) {
    const logger = ctx.resolve('logger');
    logger.info('Greeter plugin activated');

    ctx.provide('greeter', {
      greet: (name: string) => {
        const msg = `Hello, ${name}!`;
        logger.info(msg);
        return msg;
      },
    });
  },
};

broker.register(loggerPlugin);
broker.register(greeterPlugin);

const result = await broker.activate(); // Resolves deps, activates in order
console.log(result.activated); // ['logger', 'greeter']

// Use the resolved capability
const greeter = broker.resolve('greeter');
greeter.greet('world'); // Logs and outputs "Hello, world!"
```

## Packages

| Package | Import | Description |
|---------|--------|-------------|
| `rhodium` | `from 'rhodium'` | Full API (all sub-packages) |
| `rhodium-core` | `from 'rhodium/core'` | Broker, registry, lifecycle, events |
| `rhodium-capabilities` | `from 'rhodium/capabilities'` | `defineCapability`, validation |
| `rhodium-graph` | `from 'rhodium/graph'` | Dependency graph, DAG |
| `rhodium-testing` | `from 'rhodium/testing'` | Test broker, mock context |

## Core Concepts

### Broker

Central runtime. One per process.

```typescript
const broker = createBroker({
  activationTimeoutMs: 30_000,
  debug: false,
});

broker.register(plugin);        // index manifest, no code runs
await broker.activate();        // resolve deps, call activate() in topo order
```

### Plugin

Plain object — no base class, no decorators. Lifecycle: `registered` → `resolving` → `active` → `inactive`.

```typescript
const plugin: Plugin = {
  key: 'my-plugin',             // kebab-case, globally unique
  version: '1.0.0',             // semver
  manifest: {
    name: 'My Plugin',
    description: 'Does useful things',
    provides: [{ capability: 'storage', priority: 10 }],
    needs: [{ capability: 'logger', optional: true }],
    tags: ['storage', 'io'],
  },
  async activate(ctx) {
    const logger = ctx.resolveOptional('logger');
    ctx.provide('storage', new FileStorage(logger));
    ctx.registerCommand('clear-cache', async () => { /* ... */ });
  },
  async deactivate() {
    // Optional: cleanup when plugin stops
  },
  onDependencyRemoved(capability, providerKey) {
    // Called when a provider you depend on is unregistered
  },
};
```

### Capability Contracts

```typescript
import { defineCapability } from 'rhodium/capabilities';

const Logger = defineCapability<{
  info(msg: string): void;
  error(msg: string, err?: Error): void;
}>('logger');

// Provider
ctx.provide(Logger.name, myLoggerImpl);

// Consumer
const logger = ctx.resolve<typeof Logger._type>(Logger.name);
```

### Manifest Introspection

Inspect registered plugins without activating them:

```typescript
const manifests = broker.getManifests(); // Map<string, PluginManifest>
const states = broker.getPluginStates(); // Map<string, PluginState>
```

### Error Handling

All errors extend `RhodiumError` with `.code` and `.pluginKey`. Typed errors:

```typescript
import {
  CapabilityNotFoundError,    // Required capability missing
  CircularDependencyError,     // Cycle in dependency graph
  CapabilityViolationError,    // Provider shape doesn't match interface
  ActivationTimeoutError,      // Plugin activation too slow
  ActivationError,             // Plugin activation threw
  DuplicatePluginError,        // Same key registered twice
  UndeclaredCapabilityError,   // provide() for undeclared capability
} from 'rhodium';
```

Error boundaries per plugin — a failure never propagates unless there's a declared dependency.

### Event Bus

Plugins emit and listen to events without direct references:

```typescript
// Plugin A emits
ctx.emit('user-logged-in', { userId: 123 });

// Plugin B listens (via broker)
broker.on('plugin:activated', (event) => {
  console.log(`Plugin ${event.pluginKey} activated`);
});
```

### Hot Registration

Register and activate plugins after broker startup:

```typescript
await broker.activate();

// Later: add a new plugin
broker.register(newPlugin);
await broker.activatePlugin('new-plugin');
```

### Testing

```typescript
import { createTestBroker } from 'rhodium/testing';

const { broker, mockContext } = createTestBroker();
broker.register(myPlugin);
await broker.activate();

// Test plugins in isolation — mockContext records all interactions
console.log(mockContext.providedCapabilities);
console.log(mockContext.emittedEvents);
```

## Performance Targets

| Operation | Target |
|-----------|--------|
| Core bundle | <3KB min+gz |
| `broker.register()` | <1ms per plugin |
| `broker.activate()` | <100ms (20 plugins) |
| Memory per plugin | <10KB baseline |

## Learn More

**Deep dives into each subsystem:**
- [`packages/core/CLAUDE.md`](./packages/core/CLAUDE.md) — Broker, lifecycle, error boundaries
- [`packages/capabilities/CLAUDE.md`](./packages/capabilities/CLAUDE.md) — Type-level capability contracts
- [`packages/graph/CLAUDE.md`](./packages/graph/CLAUDE.md) — DAG, cycle detection, resolver
- [`packages/testing/CLAUDE.md`](./packages/testing/CLAUDE.md) — Isolation patterns, what NOT to mock

**Architecture decisions:** See [CLAUDE.md](./CLAUDE.md) for design rationale (plain objects over classes, event bus over callbacks, etc.).

## Compatibility

- Bun 1.0+ / Node.js 18+ / modern browsers (ES2022+)
- TypeScript 5.0+ required
- ESM only
- Zero runtime dependencies in core
