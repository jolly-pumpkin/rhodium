# Rhodium Graph

Dependency resolution via directed acyclic graph (DAG). Detects circular dependencies and produces deterministic resolution order.

## Key Modules

- `dag.ts` — DAG construction from plugin dependency graph
- `resolver.ts` — Topological sort, determine activation order
- `cycle-detect.ts` — Detect cycles, report error with path

## Patterns

**DAG invariants:** No cycles allowed. Cycle detection happens at `broker.activate()` time, fails fast with `CircularDependencyError` including the cycle path.

**Resolution order:** Topological sort is deterministic (tie-break by plugin key alphabetically). Same plugins always activate in same order.

**Error reporting:** Cycle error includes the full cycle path, e.g., "plugin-a → plugin-b → plugin-c → plugin-a".

## Tests

- Unit: DAG construction from simple and complex graphs
- Unit: Topological sort is deterministic
- Cycle detection: known cycle patterns caught immediately
- Edge cases: self-dependency, multi-path cycles, large graphs (100+ plugins)

## Interdependencies

- Depends on: core (plugin registry)
- Depended on by: core (broker uses resolver during activation)
