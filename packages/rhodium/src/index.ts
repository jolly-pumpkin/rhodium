// ============================================================
// rhodium — main barrel
//
// `rhodium-core` is treated as the canonical source of shared types and
// errors. Other sub-packages re-export a handful of core types as a
// convenience. To avoid TypeScript `TS2308` ambiguous-re-export errors
// we `export *` from core, then import only the symbols each sibling
// package adds on top.
// ============================================================

export * from 'rhodium-core';

// ── Capabilities (defineCapability, runtime validator, unique types) ──────
export { defineCapability, createCapabilityValidator } from 'rhodium-capabilities';
export type {
  CapabilityContract,
  CapabilitySchema,
  CapabilityValidator,
} from 'rhodium-capabilities';

// ── Graph (dependency DAG, capability resolver) ──────────────────────────
// All graph types (DependencyGraph, DependencyCheck, CapabilityResolver,
// ProviderEntry) live in rhodium-core and arrive via `export *` above.
export { createDependencyGraph, createCapabilityResolver } from 'rhodium-graph';

// ── Testing utilities (mock context, test broker) ────────────────────────
export * from 'rhodium-testing';
