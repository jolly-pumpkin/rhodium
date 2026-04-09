# rhodium

TypeScript framework for composing capability-driven systems from plugins. The broker resolves typed `provides`/`needs` contracts at runtime. When plugins participate in LLM inference, Rhodium adds first-class token budget management and manifest-first tool discovery.

## What This Is

A ~5KB TypeScript library. A broker that wires plugins together via typed capability contracts.

**Not:** An LLM wrapper, an agent framework, a deployment platform, or any PoC application built on top of it. Model calls happen in plugins — never in core.

## Install

```bash
bun add rhodium
```

## Quick Start

```typescript
import { createBroker, defineCapability } from 'rhodium';

const broker = createBroker();

const myPlugin = {
  key: 'my-plugin',
  version: '1.0.0',
  manifest: {
    provides: [{ capability: 'greeter' }],
    needs: [],
    tools: [],
  },
  activate(ctx) {
    ctx.provide('greeter', {
      greet: (name: string) => `Hello, ${name}!`,
    });
  },
};

broker.register(myPlugin);
await broker.activate();

const greeter = broker.resolve<{ greet(name: string): string }>('greeter');
console.log(greeter.greet('world')); // Hello, world!
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

Plain object — no base class, no decorators.

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
    const logger = ctx.resolveOptional('logger');
    ctx.provide('storage', new FileStorage(logger));
    ctx.registerToolHandler('read-file', (params) => ({ content: '...' }));
  },
  contributeContext(request, budget) {
    // synchronous, <5ms, no I/O
    return { pluginKey: this.key, priority: 50, systemPromptFragment: '...' };
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

## Compatibility

- Bun 1.0+ / Node.js 18+ / modern browsers (ES2022+)
- TypeScript 5.0+ required
- ESM only
- Zero runtime dependencies in core
