// ============================================================
// rhodium — main barrel
//
// `rhodium-core` is treated as the canonical source of shared types and
// errors. Other sub-packages re-export a handful of core types as a
// convenience (e.g. `rhodium-budget` re-exports `TokenBudgetConfig`,
// `rhodium-graph` re-exports `DependencyGraph`). To avoid TypeScript
// `TS2308` ambiguous-re-export errors we `export *` from core, then import
// only the symbols each sibling package adds on top.
// ============================================================

export * from 'rhodium-core';

// ── Capabilities (defineCapability, runtime validator, unique types) ──────
// Note: CapabilityViolation comes from rhodium-core (via `export *` above),
// not rhodium-capabilities. Both define structurally-compatible copies;
// core is treated as canonical to avoid TS2308.
export { defineCapability, createCapabilityValidator } from 'rhodium-capabilities';
export type {
  CapabilityContract,
  CapabilitySchema,
  CapabilityValidator,
} from 'rhodium-capabilities';

// ── Budget (token counter, allocator, unique types) ──────────────────────
export { createTokenCounter, allocateBudget } from 'rhodium-budget';
export type {
  TokenCounter,
  TokenCounterStrategy,
  AllocationResult,
  AllocatorOptions,
} from 'rhodium-budget';

// ── Discovery (index builder, search, ranking, unique types) ──────────────
export {
  createSearchIndex,
  searchTools,
  rankResults,
  scoreDocument,
  tokenize,
} from 'rhodium-discovery';
export type {
  IndexedTool,
  SearchIndex,
  ToolSearchContext,
} from 'rhodium-discovery';

// ── Graph (dependency DAG, capability resolver) ──────────────────────────
// All graph types (DependencyGraph, DependencyCheck, CapabilityResolver,
// ProviderEntry) live in rhodium-core and arrive via `export *` above.
export { createDependencyGraph, createCapabilityResolver } from 'rhodium-graph';

// ── Context (pipeline, middleware, unique types) ─────────────────────────
export {
  createPipeline,
  executeToolCall,
  collectMiddleware,
  MIDDLEWARE_CAPABILITY,
} from 'rhodium-context';
export type { PipelineOptions } from 'rhodium-context';

// ── Testing utilities (mock context, test broker, assertions) ────────────
export * from 'rhodium-testing';
