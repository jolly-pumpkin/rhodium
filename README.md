# rhodium

TypeScript framework for composing capability-driven systems from plugins. The broker resolves typed `provides`/`needs` contracts at runtime. When plugins participate in LLM inference, Rhodium adds first-class token budget management and manifest-first tool discovery.

## What This Is

A ~5KB TypeScript library for composing software systems from independently deployable plugins with typed capability contracts. The broker wires them together at runtime, similar to how Kubernetes reconciles infrastructure state across pods and services.

**Is:** A broker that resolves typed `provides`/`needs` contracts. A token budget manager for LLM context. A manifest-first tool discovery system.

**Not:** An LLM wrapper, an agent framework, a deployment platform, or any PoC application built on it. Model calls happen in plugins — never in core.

## Design Philosophy

- **Composition over coupling** — Plugins declare what they provide and need. The broker resolves wiring. No plugin references another directly.
- **Interfaces over implementations** — Swap the model provider, tool set, or memory backend without touching anything that depends on them.
- **Declarative over imperative** — Declare the capability graph; let the broker reconcile it.
- **Isolation over propagation** — A failing plugin fails loudly and locally. It doesn't corrupt downstream behavior.
- **Context as a managed resource** — When plugins participate in LLM inference, token budget is finite and precious. The framework manages it like an OS manages memory.
- **Manifest-first** — The broker knows what every plugin offers by reading its manifest. Code runs only when needed.

## Install

```bash
bun add rhodium
```

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
    provides: [{ capability: 'logger', priority: 100 }],
    needs: [],
    tools: [],
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
    provides: [{ capability: 'greeter' }],
    needs: [{ capability: 'logger' }],
    tools: [],
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

try {
  await broker.activate(); // Resolves deps, activates in order
} catch (err) {
  console.error('Activation failed:', err);
  process.exit(1);
}

// Use the resolved capability
const greeter = broker.resolve('greeter');
greeter.greet('world'); // Logs both to logger and outputs "Hello, world!"
```

## Packages

| Package | Import | Description |
|---------|--------|-------------|
| `rhodium` | `from 'rhodium'` | Full API (all sub-packages) |
| `rhodium-core` | `from 'rhodium/core'` | Broker, registry, lifecycle, events |
| `rhodium-capabilities` | `from 'rhodium/capabilities'` | `defineCapability`, validation |
| `rhodium-budget` | `from 'rhodium/budget'` | Token budget allocation |
| `rhodium-discovery` | `from 'rhodium/discovery'` | Manifest-first tool search |
| `rhodium-graph` | `from 'rhodium/graph'` | Dependency graph, DAG |
| `rhodium-context` | `from 'rhodium/context'` | Context assembly pipeline, middleware |
| `rhodium-testing` | `from 'rhodium/testing'` | Test broker, mock context |

## Core Concepts

### Broker

Central runtime. One per process.

```typescript
const broker = createBroker({
  tokenCounter: 'chars3',       // 'chars3' | 'chars4' | 'tiktoken' | fn
  activationTimeoutMs: 30_000,
  debug: false,
});

broker.register(plugin);        // index manifest, no code runs
await broker.activate();        // resolve deps, call activate() in topo order
```

### Plugin

Plain object — no base class, no decorators. Has lifecycle: `registered` → `resolving` → `active` → `inactive`.

```typescript
const plugin: Plugin = {
  key: 'my-plugin',             // kebab-case, globally unique
  version: '1.0.0',             // semver
  manifest: {
    provides: [{ capability: 'storage', priority: 10 }],
    needs: [{ capability: 'logger', optional: true }],
    tools: [{ name: 'read-file', description: 'Read a file' }],
    tags: ['storage', 'io'],
  },
  async activate(ctx) {
    // Called during broker.activate() after dependencies resolved
    const logger = ctx.resolveOptional('logger');
    ctx.provide('storage', new FileStorage(logger));
    ctx.registerToolHandler('read-file', (params) => ({ content: '...' }));
  },
  contributeContext(request, budget) {
    // SYNC, <5ms, no I/O. Called during context assembly.
    // Plugins fetch data during activate(), cache for use here.
    return { pluginKey: this.key, priority: 50, systemPromptFragment: '...' };
  },
  async deactivate() {
    // Optional: cleanup when plugin stops
  },
};
```

**Key constraint:** `contributeContext()` is synchronous. Fetch data during `activate()` and cache it.

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

### Token Budget & Context Assembly

```typescript
const context = broker.assembleContext({
  query: 'fix this bug',
  tokenBudget: {
    maxTokens: 8192,
    reservedSystemTokens: 512,
    reservedToolTokens: 1024,
    allocationStrategy: 'priority', // 'priority' | 'proportional' | 'equal'
  },
});

// context.systemPrompt — assembled from all plugin contributions
// context.tools       — merged tool definitions with examples
// context.totalTokens — actual token count
// context.dropped     — contributions that didn't fit
```

### Manifest-First Tool Discovery

85% token reduction via the Tool Search Tool pattern. Search tool manifests without activating plugins:

```typescript
const results = broker.searchTools({
  query: 'read file from disk',
  tags: ['io'],
  limit: 5,
});
// TF-IDF ranking: name (3x), description (2x), tags (2x)
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
} from 'rhodium';
```

Error boundaries per plugin — a failure never propagates unless there's a declared dependency.

```typescript
try {
  await broker.activate();
} catch (err) {
  if (err instanceof CircularDependencyError) {
    console.error(`Cycle: ${err.message}`); // "plugin-a → plugin-b → plugin-a"
  }
}
```

### Event Bus

Plugins emit and listen to events without direct references:

```typescript
// Plugin A emits
ctx.emit('user-logged-in', { userId: 123 });

// Plugin B listens
broker.on('user-logged-in', (event) => {
  console.log(`User ${event.userId} logged in`);
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
| Core bundle | <5KB min+gz |
| `assembleContext()` | <5ms (20 plugins) |
| `broker.register()` | <1ms per plugin |
| `broker.activate()` | <100ms (20 plugins) |
| `searchTools()` | <2ms (100 tools) |
| Memory per plugin | <10KB baseline |

## Learn More

**Deep dives into each subsystem:**
- [`packages/core/CLAUDE.md`](./packages/core/CLAUDE.md) — Broker, lifecycle, error boundaries, <1ms/plugin targets
- [`packages/capabilities/CLAUDE.md`](./packages/capabilities/CLAUDE.md) — Type-level capability contracts
- [`packages/budget/CLAUDE.md`](./packages/budget/CLAUDE.md) — Token allocation strategies
- [`packages/discovery/CLAUDE.md`](./packages/discovery/CLAUDE.md) — TF-IDF search, 85% token reduction
- [`packages/graph/CLAUDE.md`](./packages/graph/CLAUDE.md) — DAG, cycle detection, resolver
- [`packages/context/CLAUDE.md`](./packages/context/CLAUDE.md) — 6-stage pipeline, middleware ordering
- [`packages/testing/CLAUDE.md`](./packages/testing/CLAUDE.md) — Isolation patterns, what NOT to mock

**Architecture decisions:** See [CLAUDE.md](./CLAUDE.md) for ADRs and design rationale (plain objects over classes, synchronous context assembly, etc.).

## Compatibility

- Bun 1.0+ / Node.js 18+ / modern browsers (ES2022+)
- TypeScript 5.0+ required
- ESM only
- Zero runtime dependencies in core
